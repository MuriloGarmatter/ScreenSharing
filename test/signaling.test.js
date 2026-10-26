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

test('TURN da Cloudflare: credenciais geradas, sem a porta 53 e com cache', async () => {
  const { iceServersFromEnv, DEFAULT_ICE_SERVERS } = require('../server/protocol');
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
          {
            urls: [
              'turn:turn.cloudflare.com:3478?transport=udp',
              'turn:turn.cloudflare.com:53?transport=udp',
              'turns:turn.cloudflare.com:443?transport=tcp',
            ],
            username: 'u', credential: 'c',
          },
        ],
      }),
    };
  };
  try {
    const get = iceServersFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'chave', CLOUDFLARE_TURN_API_TOKEN: 'segredo' });
    const servers = await get();
    assert.match(calls[0].url, /\/turn\/keys\/chave\/credentials\/generate-ice-servers$/);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer segredo');
    assert.deepEqual(servers.slice(0, DEFAULT_ICE_SERVERS.length), DEFAULT_ICE_SERVERS);
    const turn = servers.find((s) => s.username === 'u');
    assert.deepEqual(turn.urls, ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp']);
    assert.equal(turn.credential, 'c');
    assert.ok(!JSON.stringify(servers).includes(':53'), 'nada na porta 53');
    await get();
    assert.equal(calls.length, 1, 'a segunda pessoa usa as credenciais guardadas');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('TURN da Cloudflare fora do ar: entra só com STUN', async () => {
  const { iceServersFromEnv, DEFAULT_ICE_SERVERS } = require('../server/protocol');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const logs = [];
    const servers = await iceServersFromEnv({ CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' }, (m) => logs.push(m))();
    assert.deepEqual(servers, DEFAULT_ICE_SERVERS);
    assert.match(logs[0], /HTTP 503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('TURN: interruptor manual e teto mensal pelas estatísticas da conta', async () => {
  const { iceServersFromEnv, DEFAULT_ICE_SERVERS } = require('../server/protocol');
  const realFetch = globalThis.fetch;
  let usedGb = 0;
  let analyticsFails = false;
  const calls = { turn: 0, graphql: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/graphql')) {
      calls.graphql.push(JSON.parse(init.body));
      if (analyticsFails) return { ok: false, status: 500 };
      return { ok: true, json: async () => ({ data: { viewer: { accounts: [{ callsTurnUsageAdaptiveGroups: [{ sum: { egressBytes: usedGb * 1e9 } }] }] } } }) };
    }
    calls.turn += 1;
    return { ok: true, json: async () => ({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' }] }) };
  };
  const base = { CLOUDFLARE_TURN_KEY_ID: 'k', CLOUDFLARE_TURN_API_TOKEN: 't' };
  const hasTurn = (servers) => servers.some((s) => s.username === 'u');
  try {
    // Interruptor: TURN=off (em qualquer grafia comum) = sem retransmissor, sem chamar a Cloudflare.
    for (const off of ['off', 'OFF', 'desligado', '0', 'false', 'não']) {
      assert.deepEqual(await iceServersFromEnv({ ...base, TURN: off })(), DEFAULT_ICE_SERVERS, `TURN=${off}`);
    }
    assert.equal(calls.turn, 0);
    assert.ok(hasTurn(await iceServersFromEnv({ ...base, TURN: 'on' })()));
    // O interruptor desliga também um retransmissor fixo (usuário e senha), como o ExpressTURN.
    const fixedTurn = { TURN_URLS: 'turn:free.expressturn.com:3478?transport=udp', TURN_USERNAME: 'x', TURN_CREDENTIAL: 'y' };
    assert.equal((await iceServersFromEnv(fixedTurn)()).length, DEFAULT_ICE_SERVERS.length + 1);
    assert.deepEqual(await iceServersFromEnv({ ...fixedTurn, TURN: 'off' })(), DEFAULT_ICE_SERVERS);

    // Teto: abaixo dele, com retransmissor; consulta o mês corrente.
    const logs = [];
    const capped = { ...base, CLOUDFLARE_ACCOUNT_ID: 'conta', CLOUDFLARE_ANALYTICS_TOKEN: 'leitura', TURN_LIMIT_GB: '100' };
    usedGb = 40;
    assert.ok(hasTurn(await iceServersFromEnv(capped, (m) => logs.push(m))()));
    const vars = calls.graphql[0].variables;
    assert.equal(vars.account, 'conta');
    assert.match(vars.start, /^\d{4}-\d{2}-01$/);
    assert.equal(vars.start.slice(0, 7), vars.end.slice(0, 7), 'só o mês corrente');

    // Passou do teto: fica como sem retransmissor, e avisa uma vez.
    usedGb = 100.5;
    assert.deepEqual(await iceServersFromEnv(capped, (m) => logs.push(m))(), DEFAULT_ICE_SERVERS);
    assert.match(logs.at(-1), /desligado até o mês que vem/);

    // A resposta fica guardada: a segunda pessoa não gera outra consulta.
    const get = iceServersFromEnv(capped);
    await get();
    const queries = calls.graphql.length;
    await get();
    assert.equal(calls.graphql.length, queries);

    // Sem o teto padrão definido, vale 900 GB.
    usedGb = 899;
    assert.ok(hasTurn(await iceServersFromEnv({ ...capped, TURN_LIMIT_GB: undefined })()));
    usedGb = 901;
    assert.deepEqual(await iceServersFromEnv({ ...capped, TURN_LIMIT_GB: undefined })(), DEFAULT_ICE_SERVERS);

    // Estatísticas fora do ar: um erro passageiro não desliga o retransmissor.
    analyticsFails = true;
    const failing = [];
    assert.ok(hasTurn(await iceServersFromEnv(capped, (m) => failing.push(m))()));
    assert.match(failing[0], /Falha ao consultar o uso do TURN: HTTP 500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
