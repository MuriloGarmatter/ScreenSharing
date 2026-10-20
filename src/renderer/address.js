// Endereços de servidor e convites. Um convite é o endereço com o nome da sala
// no fim (ex.: wss://xxxx.trycloudflare.com/sala-k3x9q2a): assim quem entra só
// precisa colar um texto, sem chance de errar o nome da sala.

export const DEFAULT_PORT = 47800;

/**
 * Aceita "192.168.0.10", "192.168.0.10:47800", "http(s)://…" ou "ws(s)://…",
 * com ou sem o nome da sala no fim. Devolve { url, room } (url sem a sala;
 * room vazio se não veio) ou null se o endereço for inválido.
 */
export function parseServerAddress(input) {
  let value = String(input || '').trim();
  if (!value) return null;
  if (/^https:\/\//i.test(value)) value = `wss://${value.slice(8)}`;
  else if (/^http:\/\//i.test(value)) value = `ws://${value.slice(7)}`;
  else if (!/^wss?:\/\//i.test(value)) {
    const host = value.split('/')[0].replace(/:\d+$/, '');
    const local = /^[\d.]+$/.test(host) || host === 'localhost' || !host.includes('.');
    value = `${local ? 'ws' : 'wss'}://${value}`;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (url.protocol === 'ws:' && !url.port) url.port = String(DEFAULT_PORT);
  let room = '';
  try {
    room = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')).trim();
  } catch {
    room = '';
  }
  return { url: `${url.protocol}//${url.host}`, room };
}

/** Endereço de convite: o endereço base com o nome da sala no fim. */
export function inviteAddress(base, room) {
  return `${String(base).replace(/\/+$/, '')}/${encodeURIComponent(room)}`;
}
