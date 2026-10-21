'use strict';

// Servidor de sinalização do Telão.
// Ele só apresenta os participantes de uma sala e repassa as mensagens de
// negociação WebRTC (SDP e candidatos ICE). Vídeo e áudio NÃO passam por aqui:
// trafegam direto entre os computadores (P2P).
// O protocolo em si (validação, mensagens de erro, ICE) fica em protocol.js,
// dividido com o servidor da Cloudflare (worker/).

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  DEFAULT_ICE_SERVERS, MAX_PAYLOAD_BYTES, MAX_ROOM_SIZE, KEEPALIVE_PING, KEEPALIVE_PONG, FEATURES, ERRORS,
  joinFields, sanitizeState, describe, randomId, turnServers, iceServersFromEnv,
} = require('./protocol');

const HEARTBEAT_MS = 25_000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Anexa o servidor de sinalização a um http.Server já criado.
 * Protocolo (JSON sobre WebSocket):
 *   cliente → servidor: join {room, name, password, state} | signal {to, data} | state {state} | "ping"
 *   servidor → cliente: welcome {id, peers, iceServers} | peer-joined | peer-left | peer-state | signal {from, data} | error | "pong"
 */
function attachSignaling(httpServer, options = {}) {
  const { password = '', getIceServers = async () => DEFAULT_ICE_SERVERS, log = () => {} } = options;
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_PAYLOAD_BYTES });
  const rooms = new Map(); // nome da sala -> Map(id -> cliente)

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const reject = (ws, code) => {
    send(ws, { type: 'error', code, message: ERRORS[code] });
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
      const text = data.toString();
      if (text === KEEPALIVE_PING) {
        if (ws.readyState === WebSocket.OPEN) ws.send(KEEPALIVE_PONG);
        return;
      }
      let msg;
      try { msg = JSON.parse(text); } catch { return; }
      if (!msg || typeof msg !== 'object') return;

      if (!me) {
        if (msg.type !== 'join' || joining) return;
        joining = true;
        const { room, name } = joinFields(msg);
        if (!room) return reject(ws, 'bad-room');
        if (password && !safeEqual(msg.password || '', password)) return reject(ws, 'bad-password');
        const iceServers = await getIceServers();
        if (ws.readyState !== WebSocket.OPEN) return;
        const members = rooms.get(room) || new Map();
        if (members.size >= MAX_ROOM_SIZE) return reject(ws, 'room-full');
        rooms.set(room, members);
        me = { id: randomId(), name, room, state: sanitizeState(msg.state), ws };
        send(ws, { type: 'welcome', id: me.id, room, peers: [...members.values()].map(describe), iceServers, features: FEATURES });
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
