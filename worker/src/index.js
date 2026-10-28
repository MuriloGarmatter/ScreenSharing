// Servidor de sinalização do Telão na Cloudflare (Workers + Durable Objects).
// É o "link fixo": https://telao.xmbc.workers.dev/<sala> funciona sempre, sem
// ninguém precisar deixar o PC hospedando. Fala o mesmo protocolo do servidor do
// PC (server/signaling.js), então o app (inclusive versões antigas) não percebe
// a diferença. Vídeo e áudio continuam indo direto entre os computadores.
//
// Todas as salas ficam num único Durable Object ("lobby"): o app se conecta na
// raiz e só diz a sala na mensagem join, e um objeto aguenta com folga um grupo
// de amigos. O objeto hiberna entre mensagens (WebSocket Hibernation): quem está
// conectado fica na sala, e cada participante fica guardado no próprio WebSocket
// (serializeAttachment), não na memória.

import {
  MAX_PAYLOAD_BYTES, MAX_ROOM_SIZE, KEEPALIVE_PING, KEEPALIVE_PONG, FEATURES, ERRORS,
  joinFields, sanitizeState, describe, randomId, iceServersFromEnv,
} from '../../server/protocol.js';
import { httpResponse } from '../../server/invite-page.js';

const LOBBY_NAME = 'lobby';
const LOCATION_HINT = 'sam'; // América do Sul, perto de quem usa (só vale na criação)
const OPEN = 1; // WebSocket.readyState
// O app manda "ping" a cada 30 s (a Cloudflare responde sem acordar o objeto).
// Quem parou de mandar há mais de 90 s caiu sem avisar: sai da sala.
const SWEEP_MS = 60_000;
const STALE_MS = 90_000;

function send(ws, msg) {
  try {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(msg));
  } catch { /* conexão fechando */ }
}

function closeQuietly(ws, code, reason) {
  try { ws.close(code, reason); } catch { /* já fechada */ }
}

/** Compara a senha sem vazar pelo tempo quanto dela está certa. */
async function sameSecret(a, b) {
  const digest = async (value) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value))));
  const [ha, hb] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i += 1) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export class Lobby {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.password = env.SERVER_PASSWORD || '';
    // Avisos (TURN desligado pelo teto, falhas) só aparecem no "wrangler tail"; nada fica gravado.
    this.getIceServers = iceServersFromEnv(env, (message) => console.warn(message));
    this.joining = new WeakSet();
    if (typeof WebSocketRequestResponsePair === 'function') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(KEEPALIVE_PING, KEEPALIVE_PONG));
    }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Esperava uma conexão WebSocket.\n', { status: 426 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Quem está na sala (o participante fica guardado no próprio WebSocket). */
  members(room, except = null) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except
      && ws.readyState === OPEN && ws.deserializeAttachment()?.room === room);
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_PAYLOAD_BYTES) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const me = ws.deserializeAttachment();
    if (!me) {
      await this.join(ws, msg);
      return;
    }
    if (msg.type === 'signal') {
      if (!msg.data || typeof msg.data !== 'object') return;
      const target = this.members(me.room, ws).find((other) => other.deserializeAttachment().id === msg.to);
      if (target) send(target, { type: 'signal', from: me.id, data: msg.data });
    } else if (msg.type === 'state') {
      me.state = sanitizeState(msg.state);
      ws.serializeAttachment(me);
      for (const other of this.members(me.room, ws)) send(other, { type: 'peer-state', id: me.id, state: me.state });
    }
  }

  async join(ws, msg) {
    if (msg.type !== 'join' || this.joining.has(ws)) return;
    this.joining.add(ws);
    const reject = (code) => {
      send(ws, { type: 'error', code, message: ERRORS[code] });
      closeQuietly(ws, 1008, code);
    };
    const { room, name } = joinFields(msg);
    if (!room) return reject('bad-room');
    if (this.password && !(await sameSecret(msg.password || '', this.password))) return reject('bad-password');
    const iceServers = await this.getIceServers();
    if (ws.readyState !== OPEN) return;
    const members = this.members(room, ws);
    if (members.length >= MAX_ROOM_SIZE) return reject('room-full');
    const me = { id: randomId(), name, room, state: sanitizeState(msg.state) };
    ws.serializeAttachment(me);
    const peers = members.map((other) => describe(other.deserializeAttachment()));
    send(ws, { type: 'welcome', id: me.id, room, peers, iceServers, features: FEATURES });
    for (const other of members) send(other, { type: 'peer-joined', ...describe(me) });
    await this.scheduleSweep();
  }

  /** Tira o participante da sala e avisa os outros (uma vez só). */
  leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    try { ws.serializeAttachment(null); } catch { /* conexão já fechada */ }
    for (const other of this.members(me.room, ws)) send(other, { type: 'peer-left', id: me.id });
  }

  webSocketClose(ws) {
    this.leave(ws);
    closeQuietly(ws, 1000, 'tchau');
  }

  webSocketError(ws) {
    this.leave(ws);
  }

  async scheduleSweep() {
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  /** Faxina: quem caiu sem fechar a conexão (Wi-Fi caiu, PC hibernou) sai da sala. */
  async alarm() {
    const now = Date.now();
    let anyone = false;
    for (const ws of this.ctx.getWebSockets()) {
      if (!ws.deserializeAttachment()) continue;
      // Versões antigas do app não mandam "ping": para elas a data fica vazia.
      const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      if (lastPing && now - lastPing.getTime() > STALE_MS) {
        this.leave(ws);
        closeQuietly(ws, 4000, 'sem resposta');
      } else {
        anyone = true;
      }
    }
    if (anyone) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const lobby = env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME), { locationHint: LOCATION_HINT });
      return lobby.fetch(request);
    }
    const url = new URL(request.url);
    // O Telão no navegador (public/app/) é servido pela Cloudflare antes de chegar aqui.
    const { status, headers, body } = httpResponse({
      method: request.method,
      url: request.url,
      host: url.host,
      scheme: url.protocol === 'https:' ? 'https' : 'http',
      webApp: '/app/',
    });
    return new Response(body, { status, headers });
  },
};
