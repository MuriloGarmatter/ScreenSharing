'use strict';

// O protocolo de sinalização do Telão, dividido entre os dois servidores: o do
// PC (signaling.js, com o pacote ws) e o da Cloudflare (worker/). Nada aqui
// depende do Node: o mesmo arquivo roda nos dois lugares.

const DEFAULT_ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ROOM_SIZE = 10;

// O app manda "ping" de tempos em tempos e o servidor responde "pong": mantém a
// conexão viva em proxies e túneis e mostra ao servidor quem ainda está lá.
const KEEPALIVE_PING = 'ping';
const KEEPALIVE_PONG = 'pong';

// O que este servidor sabe fazer além do básico (versões antigas não mandam a lista).
const FEATURES = ['version'];

const ERRORS = {
  'bad-room': 'Nome de sala inválido.',
  'bad-password': 'Senha do servidor incorreta.',
  'room-full': `A sala está cheia (máximo de ${MAX_ROOM_SIZE} pessoas).`,
};

function cleanText(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Sala e nome de quem pediu para entrar; room vazio = sala inválida. */
function joinFields(msg) {
  return {
    // Maiúsculas/minúsculas não importam: "Filme-Sexta" e "filme-sexta" são a mesma sala.
    room: cleanText(msg.room, 64).toLowerCase(),
    name: cleanText(msg.name, 32) || 'Anônimo',
  };
}

function sanitizeState(state) {
  if (!state || typeof state !== 'object') return { sharing: false };
  return {
    sharing: state.sharing === true,
    paused: state.paused === true,
    audio: state.audio === true,
    label: cleanText(state.label, 80),
    // Versão do Telão de quem mandou (para avisar quem está desatualizado).
    version: /^\d+\.\d+\.\d+$/.test(String(state.version ?? '')) ? state.version : undefined,
  };
}

function describe(client) {
  return { id: client.id, name: client.name, state: client.state };
}

/** Id de participante: 16 caracteres hexadecimais aleatórios. */
function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
function iceServersFromEnv(env, log = () => {}) {
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

module.exports = {
  DEFAULT_ICE_SERVERS,
  MAX_PAYLOAD_BYTES,
  MAX_ROOM_SIZE,
  KEEPALIVE_PING,
  KEEPALIVE_PONG,
  FEATURES,
  ERRORS,
  cleanText,
  joinFields,
  sanitizeState,
  describe,
  randomId,
  turnServers,
  iceServersFromEnv,
};
