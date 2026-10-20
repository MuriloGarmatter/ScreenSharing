'use strict';

// Servidor de sinalização do Telão.
// Ele só apresenta os participantes de uma sala e repassa as mensagens de
// negociação WebRTC (SDP e candidatos ICE). Vídeo e áudio NÃO passam por aqui:
// trafegam direto entre os computadores (P2P).

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ROOM_SIZE = 10;
const HEARTBEAT_MS = 25_000;

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function sanitizeState(state) {
  if (!state || typeof state !== 'object') return { sharing: false };
  return {
    sharing: state.sharing === true,
    audio: state.audio === true,
    label: cleanText(state.label, 80),
  };
}

function describe(client) {
  return { id: client.id, name: client.name, state: client.state };
}

/**
 * Converte uma lista de TURN em formato simples ({ urls, username, credential })
 * para o formato de iceServers do WebRTC, ignorando entradas vazias.
 */
function turnServers(turn) {
  if (!turn) return [];
  const list = Array.isArray(turn) ? turn : [turn];
  return list
    .map((t) => {
      const urls = (Array.isArray(t.urls) ? t.urls : String(t.urls || '').split(','))
        .map((u) => u.trim())
        .filter((u) => /^turns?:/i.test(u));
      if (!urls.length) return null;
      return { urls, username: t.username || undefined, credential: t.credential || undefined };
    })
    .filter(Boolean);
}

/**
 * Monta a função que devolve os iceServers a partir de variáveis de ambiente:
 *  - TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL: um servidor TURN fixo (ex.: coturn).
 *  - CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN: gera credenciais do
 *    Cloudflare TURN (1.000 GB/mês grátis) e renova a cada 12 h.
 */
function iceServersFromEnv(env = process.env, log = () => {}) {
  const fixed = [
    ...DEFAULT_ICE_SERVERS,
    ...turnServers({ urls: env.TURN_URLS, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }),
  ];
  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const token = env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return async () => fixed;

  let cache = null;
  return async () => {
    if (cache && cache.expires > Date.now()) return cache.value;
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl: 86_400 }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const value = [...fixed, ...(Array.isArray(body.iceServers) ? body.iceServers : [])];
      cache = { value, expires: Date.now() + 12 * 3600 * 1000 };
      return value;
    } catch (err) {
      log(`Falha ao gerar credenciais do Cloudflare TURN: ${err.message}`);
      return fixed;
    }
  };
}

/**
 * Anexa o servidor de sinalização a um http.Server já criado.
 * Protocolo (JSON sobre WebSocket):
 *   cliente → servidor: join {room, name, password, state} | signal {to, data} | state {state}
 *   servidor → cliente: welcome {id, peers, iceServers} | peer-joined | peer-left | peer-state | signal {from, data} | error
 */
function attachSignaling(httpServer, options = {}) {
  const { password = '', getIceServers = async () => DEFAULT_ICE_SERVERS, log = () => {} } = options;
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const rooms = new Map(); // nome da sala -> Map(id -> cliente)

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const reject = (ws, code, message) => {
    send(ws, { type: 'error', code, message });
    ws.close(1008, code);
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});

    let me = null;
    let joining = false;

    ws.on('message', async (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!me) {
        if (msg.type !== 'join' || joining) return;
        joining = true;
        // Maiúsculas/minúsculas não importam: "Filme-Sexta" e "filme-sexta" são a mesma sala.
        const room = cleanText(msg.room, 64).toLowerCase();
        const name = cleanText(msg.name, 32) || 'Anônimo';
        if (!room) return reject(ws, 'bad-room', 'Nome de sala inválido.');
        if (password && !safeEqual(msg.password || '', password)) {
          return reject(ws, 'bad-password', 'Senha do servidor incorreta.');
        }
        const iceServers = await getIceServers();
        if (ws.readyState !== WebSocket.OPEN) return;
        const members = rooms.get(room) || new Map();
        if (members.size >= MAX_ROOM_SIZE) {
          return reject(ws, 'room-full', `A sala está cheia (máximo de ${MAX_ROOM_SIZE} pessoas).`);
        }
        rooms.set(room, members);
        me = { id: crypto.randomBytes(8).toString('hex'), name, room, state: sanitizeState(msg.state), ws };
        send(ws, { type: 'welcome', id: me.id, room, peers: [...members.values()].map(describe), iceServers });
        for (const other of members.values()) send(other.ws, { type: 'peer-joined', ...describe(me) });
        members.set(me.id, me);
        log(`"${name}" entrou na sala "${room}" (${members.size} na sala)`);
        return;
      }

      const members = rooms.get(me.room);
      if (!members) return;
      if (msg.type === 'signal') {
        const target = members.get(msg.to);
        if (target && target !== me && msg.data && typeof msg.data === 'object') {
          send(target.ws, { type: 'signal', from: me.id, data: msg.data });
        }
      } else if (msg.type === 'state') {
        me.state = sanitizeState(msg.state);
        for (const other of members.values()) {
          if (other !== me) send(other.ws, { type: 'peer-state', id: me.id, state: me.state });
        }
      }
    });

    ws.on('close', () => {
      if (!me) return;
      const members = rooms.get(me.room);
      if (members) {
        members.delete(me.id);
        if (!members.size) rooms.delete(me.room);
        for (const other of members.values()) send(other.ws, { type: 'peer-left', id: me.id });
      }
      log(`"${me.name}" saiu da sala "${me.room}"`);
      me = null;
    });
  });

  // Derruba conexões mortas e mantém túneis/proxies acordados.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeat));

  return {
    wss,
    stats: () => ({ rooms: rooms.size, clients: wss.clients.size }),
    close: () => new Promise((resolve) => {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => resolve());
    }),
  };
}

module.exports = { attachSignaling, iceServersFromEnv, turnServers, DEFAULT_ICE_SERVERS, MAX_ROOM_SIZE };
