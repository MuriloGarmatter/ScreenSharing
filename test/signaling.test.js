'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { attachSignaling, MAX_ROOM_SIZE } = require('../server/signaling');

async function startServer(options) {
  const server = http.createServer();
  const signaling = attachSignaling(server, options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: async () => { await signaling.close(); await new Promise((r) => server.close(r)); },
  };
}

// Cliente de teste que guarda as mensagens recebidas e permite esperar por um tipo.
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    const waiters = [];
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      const i = waiters.findIndex((w) => w.type === msg.type);
      if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      else inbox.push(msg);
    });
    ws.once('open', () => resolve({
      ws,
      send: (msg) => ws.send(JSON.stringify(msg)),
      next: (type, timeout = 2000) => {
        const i = inbox.findIndex((m) => m.type === type);
        if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout esperando "${type}"`)), timeout);
          waiters.push({ type, resolve: (m) => { clearTimeout(timer); res(m); } });
        });
      },
      closed: new Promise((res) => ws.once('close', (code) => res(code))),
    }));
    ws.once('error', reject);
  });
}

test('entrar, ver os outros, repassar sinal e estado, sair', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.url);
    a.send({ type: 'join', room: 'sala', name: 'Alice' });
    const wa = await a.next('welcome');
    assert.equal(wa.peers.length, 0);
    assert.ok(Array.isArray(wa.iceServers) && wa.iceServers.length > 0);

    const b = await connect(srv.url);
    b.send({ type: 'join', room: 'sala', name: 'Bob', state: { sharing: true, label: 'Tela 1' } });
    const wb = await b.next('welcome');
    assert.deepEqual(wb.peers.map((p) => p.name), ['Alice']);

    const joined = await a.next('peer-joined');
    assert.equal(joined.id, wb.id);
    assert.equal(joined.name, 'Bob');
    assert.equal(joined.state.sharing, true);

    b.send({ type: 'signal', to: wa.id, data: { description: { type: 'offer', sdp: 'v=0' } } });
    const sig = await a.next('signal');
    assert.equal(sig.from, wb.id);
    assert.equal(sig.data.description.type, 'offer');

    a.send({ type: 'state', state: { sharing: true, audio: true, label: 'Tela 2', extra: 'ignorado' } });
    const st = await b.next('peer-state');
    assert.deepEqual(st.state, { sharing: true, paused: false, audio: true, label: 'Tela 2' });

    // A versão do Telão de cada um passa adiante (só no formato 1.2.3); o welcome avisa que dá.
    assert.ok(wb.features.includes('version'));
    a.send({ type: 'state', state: { sharing: false, version: '1.3.0' } });
    assert.equal((await b.next('peer-state')).state.version, '1.3.0');
    a.send({ type: 'state', state: { sharing: false, version: '<script>' } });
    assert.equal((await b.next('peer-state')).state.version, undefined);

    // Salas são isoladas: alguém em outra sala não vê nem recebe nada.
    const c = await connect(srv.url);
    c.send({ type: 'join', room: 'outra', name: 'Carol' });
    assert.equal((await c.next('welcome')).peers.length, 0);
    c.send({ type: 'signal', to: wa.id, data: { candidate: {} } });

    b.ws.close();
    const left = await a.next('peer-left');
    assert.equal(left.id, wb.id);
    await assert.rejects(a.next('signal', 300), /timeout/);

    a.ws.close();
    c.ws.close();
  } finally {
    await srv.close();
  }
});

test('nome da sala não diferencia maiúsculas de minúsculas', async () => {
  const srv = await startServer();
  try {
    const a = await connect(srv.url);
    a.send({ type: 'join', room: 'Filme-Sexta', name: 'Alice' });
    await a.next('welcome');
    const b = await connect(srv.url);
    b.send({ type: 'join', room: ' filme-sexta ', name: 'Bob' });
    assert.deepEqual((await b.next('welcome')).peers.map((p) => p.name), ['Alice']);
    a.ws.close();
    b.ws.close();
  } finally {
    await srv.close();
  }
});

test('senha errada é recusada e senha certa é aceita', async () => {
  const srv = await startServer({ password: 'segredo' });
  try {
    const bad = await connect(srv.url);
    bad.send({ type: 'join', room: 'sala', name: 'X', password: 'errada' });
    const err = await bad.next('error');
    assert.equal(err.code, 'bad-password');
    assert.equal(await bad.closed, 1008);

    const good = await connect(srv.url);
    good.send({ type: 'join', room: 'sala', name: 'Y', password: 'segredo' });
    await good.next('welcome');
    good.ws.close();
  } finally {
    await srv.close();
  }
});

test('sala cheia é recusada', async () => {
  const srv = await startServer();
  const clients = [];
  try {
    for (let i = 0; i < MAX_ROOM_SIZE; i++) {
      const c = await connect(srv.url);
      c.send({ type: 'join', room: 'lotada', name: `P${i}` });
      await c.next('welcome');
      clients.push(c);
    }
    const extra = await connect(srv.url);
    extra.send({ type: 'join', room: 'lotada', name: 'Extra' });
    assert.equal((await extra.next('error')).code, 'room-full');
  } finally {
    for (const c of clients) c.ws.close();
    await srv.close();
  }
});
