'use strict';

// Confere um servidor de sinalização de verdade, pela rede: o do PC, o da
// Cloudflare publicado ou o "wrangler dev" local. Não abre o app.
// Uso: node test/server-smoke.js wss://telao.xmbc.workers.dev
//      node test/server-smoke.js ws://127.0.0.1:8787

const assert = require('node:assert/strict');
const WebSocket = require('ws');

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!/^wss?:\/\//.test(base)) {
  console.error('Uso: node test/server-smoke.js <ws://… ou wss://…>');
  process.exit(2);
}
const httpBase = base.replace(/^ws/, 'http');
const room = `teste-${Math.random().toString(36).slice(2, 9)}`;

/** Cliente de teste: guarda as mensagens e deixa esperar por uma delas. */
function client() {
  const ws = new WebSocket(base);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const text = data.toString();
    let msg;
    try { msg = JSON.parse(text); } catch { msg = { raw: text }; }
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  return {
    ws, opened, closed,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(match, label, ms = 8000) {
      const found = inbox.find(match);
      if (found) {
        inbox.splice(inbox.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`não chegou: ${label}`)), ms);
        waiters.push({ match, resolve: (msg) => { clearTimeout(timer); inbox.splice(inbox.indexOf(msg), 1); resolve(msg); } });
      });
    },
  };
}

const type = (t) => (m) => m.type === t;

async function join(name, state = {}) {
  const c = client();
  await c.opened;
  c.send({ type: 'join', room, name, state: { sharing: false, version: '1.3.0', ...state } });
  c.welcome = await c.next(type('welcome'), `welcome de ${name}`);
  return c;
}

async function main() {
  const steps = [];
  const step = async (label, fn) => {
    const t = Date.now();
    await fn();
    steps.push(label);
    console.log(`ok  ${label} (${Date.now() - t} ms)`);
  };

  await step('página do convite e saúde', async () => {
    const health = await fetch(`${httpBase}/`);
    assert.equal(health.status, 200);
    assert.match(await health.text(), /servidor de sinalização ativo/);
    const page = await fetch(`${httpBase}/${room}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes(`telao://entrar/?convite=${encodeURIComponent(`${httpBase}/${room}`)}`), 'deep link da sala');
  });

  let ana;
  let bia;
  await step('entrar na sala (welcome, peer-joined, versão, features)', async () => {
    ana = await join('Ana');
    assert.equal(ana.welcome.room, room);
    assert.deepEqual(ana.welcome.peers, []);
    assert.ok(Array.isArray(ana.welcome.iceServers) && ana.welcome.iceServers.length > 0);
    assert.ok(ana.welcome.features.includes('version'));
    bia = await join('Bia', { sharing: true, label: 'Jogo' });
    assert.equal(bia.welcome.peers.length, 1);
    assert.equal(bia.welcome.peers[0].name, 'Ana');
    assert.equal(bia.welcome.peers[0].state.version, '1.3.0');
    const joined = await ana.next(type('peer-joined'), 'peer-joined');
    assert.equal(joined.name, 'Bia');
    assert.equal(joined.state.sharing, true);
  });

  await step('sala com maiúsculas é a mesma sala', async () => {
    const c = client();
    await c.opened;
    c.send({ type: 'join', room: room.toUpperCase(), name: 'Caio' });
    const welcome = await c.next(type('welcome'), 'welcome de Caio');
    assert.equal(welcome.peers.length, 2);
    await ana.next(type('peer-joined'), 'peer-joined de Caio');
    await bia.next(type('peer-joined'), 'peer-joined de Caio (Bia)');
    c.ws.close();
    assert.equal((await ana.next(type('peer-left'), 'peer-left de Caio')).id, welcome.id);
    assert.equal((await bia.next(type('peer-left'), 'peer-left de Caio (Bia)')).id, welcome.id);
  });

  await step('repassar sinal e estado', async () => {
    ana.send({ type: 'signal', to: bia.welcome.id, data: { description: { type: 'offer', sdp: 'x' } } });
    const signal = await bia.next(type('signal'), 'signal');
    assert.equal(signal.from, ana.welcome.id);
    assert.equal(signal.data.description.type, 'offer');
    bia.send({ type: 'state', state: { sharing: false, paused: true, label: '<b>x</b>'.repeat(30), version: 'abc' } });
    const st = await ana.next(type('peer-state'), 'peer-state');
    assert.equal(st.id, bia.welcome.id);
    assert.equal(st.state.paused, true);
    assert.equal(st.state.label.length, 80, 'rótulo cortado');
    assert.equal(st.state.version, undefined, 'versão inválida descartada');
  });

  await step('ping → pong', async () => {
    ana.send('ping');
    const pong = await ana.next((m) => m.raw === 'pong', 'pong');
    assert.equal(pong.raw, 'pong');
  });

  await step('recusar sala vazia', async () => {
    const c = client();
    await c.opened;
    c.send({ type: 'join', room: '   ', name: 'X' });
    const err = await c.next(type('error'), 'erro bad-room');
    assert.equal(err.code, 'bad-room');
    assert.equal(await c.closed, 1008);
  });

  await step('sala cheia (10 pessoas)', async () => {
    const extra = [];
    for (let i = 0; i < 8; i += 1) extra.push(await join(`P${i}`));
    const c = client();
    await c.opened;
    c.send({ type: 'join', room, name: 'Sobrando' });
    const err = await c.next(type('error'), 'erro room-full');
    assert.equal(err.code, 'room-full');
    for (const e of extra) e.ws.close();
    await Promise.all(extra.map((e) => e.closed));
  });

  await step('sair avisa quem fica', async () => {
    // Descarta os avisos de quem saiu no passo anterior.
    const biaId = bia.welcome.id;
    bia.ws.close();
    for (;;) {
      const left = await ana.next(type('peer-left'), 'peer-left de Bia');
      if (left.id === biaId) break;
    }
    ana.ws.close();
  });

  console.log(`\nSERVIDOR OK: ${steps.length} passos em ${base} (sala ${room})`);
}

main().then(() => process.exit(0), (err) => {
  console.error(`\nFALHOU: ${err.message}`);
  process.exit(1);
});
