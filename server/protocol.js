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
 * Tira os endereços na porta 53: os navegadores bloqueiam essa porta e a
 * tentativa só atrasa a conexão (a Cloudflare recomenda filtrar).
 */
function withoutPort53(iceServers) {
  return iceServers
    .map((server) => {
      const urls = (Array.isArray(server.urls) ? server.urls : [server.urls])
        .filter((u) => typeof u === 'string' && !/:53(?:[/?]|$)/.test(u));
      return urls.length ? { ...server, urls } : null;
    })
    .filter(Boolean);
}

const DEFAULT_TURN_LIMIT_GB = 900; // a Cloudflare dá 1.000 GB por mês: sobra folga
const USAGE_CACHE_MS = 10 * 60 * 1000;
const TURN_USAGE_QUERY = `query TelaoTurnUsage($account: string!, $start: Date!, $end: Date!) {
  viewer { accounts(filter: { accountTag: $account }) {
    callsTurnUsageAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) { sum { egressBytes } }
  } }
}`;

/** Interruptor manual: TURN=off (ou desligado, 0, false, não) desliga os retransmissores. */
function turnSwitchedOff(env) {
  return /^(off|0|false|desligado|nao|não)$/i.test(String(env.TURN ?? '').trim());
}

/** Bytes que o TURN da Cloudflare mandou neste mês (UTC): é o que a Cloudflare cobra. */
async function monthEgressBytes(account, token, now) {
  const iso = now.toISOString();
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: TURN_USAGE_QUERY, variables: { account, start: `${iso.slice(0, 7)}-01`, end: iso.slice(0, 10) } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message);
  const groups = body.data?.viewer?.accounts?.[0]?.callsTurnUsageAdaptiveGroups || [];
  return groups.reduce((total, group) => total + (Number(group.sum?.egressBytes) || 0), 0);
}

/**
 * Teto mensal do retransmissor: diz se o TURN já passou de TURN_LIMIT_GB no mês
 * (padrão 900 GB), consultando as estatísticas da conta (CLOUDFLARE_ACCOUNT_ID e
 * CLOUDFLARE_ANALYTICS_TOKEN, só leitura) no máximo a cada 10 minutos. Passou: o
 * servidor para de oferecer o TURN e tudo fica como sem ele; no mês seguinte volta.
 * Sem essas credenciais não há teto. Se a consulta falhar, vale a última resposta
 * do mês (ou "não passou"), para um erro passageiro não desligar o retransmissor.
 */
function turnUsageGuard(env, log) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_ANALYTICS_TOKEN;
  const limitGb = Number(env.TURN_LIMIT_GB) > 0 ? Number(env.TURN_LIMIT_GB) : DEFAULT_TURN_LIMIT_GB;
  if (!account || !token) return async () => false;
  let cache = null; // { month, over, until }
  return async (now = new Date()) => {
    const month = now.toISOString().slice(0, 7);
    if (cache && cache.month === month && cache.until > Date.now()) return cache.over;
    const known = cache?.month === month ? cache.over : false;
    try {
      const bytes = await monthEgressBytes(account, token, now);
      const over = bytes >= limitGb * 1e9;
      if (over && !known) log(`TURN desligado até o mês que vem: ${(bytes / 1e9).toFixed(1)} GB usados (teto de ${limitGb} GB).`);
      cache = { month, over, until: Date.now() + USAGE_CACHE_MS };
    } catch (err) {
      log(`Falha ao consultar o uso do TURN: ${err.message}`);
      cache = { month, over: known, until: Date.now() + 60_000 }; // tenta de novo em 1 minuto
    }
    return cache.over;
  };
}

/**
 * Monta a função que devolve os iceServers a partir de variáveis de ambiente:
 *  - TURN_URLS, TURN_USERNAME, TURN_CREDENTIAL: um servidor TURN fixo (ex.: coturn).
 *  - CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN: gera credenciais do
 *    Cloudflare TURN (1.000 GB/mês grátis) e renova a cada 12 h.
 *  - TURN=off: desliga o Cloudflare TURN na hora (interruptor manual).
 *  - CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ANALYTICS_TOKEN, TURN_LIMIT_GB: o teto
 *    mensal (ver turnUsageGuard).
 */
function iceServersFromEnv(env, log = () => {}) {
  // Interruptor desligado: nenhum retransmissor, nem o fixo nem o da Cloudflare.
  if (turnSwitchedOff(env)) return async () => DEFAULT_ICE_SERVERS;
  const fixed = [
    ...DEFAULT_ICE_SERVERS,
    ...turnServers({ urls: env.TURN_URLS, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }),
  ];
  const keyId = env.CLOUDFLARE_TURN_KEY_ID;
  const token = env.CLOUDFLARE_TURN_API_TOKEN;
  if (!keyId || !token) return async () => fixed;
  const overLimit = turnUsageGuard(env, log);

  let cache = null;
  return async () => {
    if (await overLimit()) return fixed;
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
      const value = [...fixed, ...withoutPort53(Array.isArray(body.iceServers) ? body.iceServers : [])];
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
