// Endereços de servidor e convites.
// O convite é um link normal, clicável no Discord e no WhatsApp, com o nome da
// sala no fim: https://xxxx.trycloudflare.com/sala-k3x9q2a (ou http://IP:porta/sala
// na rede local). Aberto no navegador, o servidor da sala mostra uma página com o
// botão "Abrir no Telão", que usa o link telao://entrar/?convite=<convite>.

export const DEFAULT_PORT = 47800;
export const DEEP_LINK_PREFIX = 'telao://entrar/?convite=';

/**
 * Aceita "192.168.0.10", "192.168.0.10:47800", "http(s)://…" ou "ws(s)://…",
 * com ou sem o nome da sala no fim. Devolve { url, room } (url de WebSocket,
 * sem a sala; room vazio se não veio) ou null se o endereço for inválido.
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

/**
 * Link de convite clicável a partir do endereço base (ws://, wss:// ou IP:porta)
 * e do nome da sala: wss vira https, ws (e IP:porta) vira http.
 */
export function inviteLink(base, room) {
  let value = String(base).trim().replace(/\/+$/, '');
  if (/^wss:\/\//i.test(value)) value = `https://${value.slice(6)}`;
  else if (/^ws:\/\//i.test(value)) value = `http://${value.slice(5)}`;
  else if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return `${value}/${encodeURIComponent(room)}`;
}

/** Link que abre o app já com o convite (telao://entrar/?convite=…). */
export function deepLinkFor(invite) {
  return `${DEEP_LINK_PREFIX}${encodeURIComponent(invite)}`;
}

/** Lê um link telao://; devolve { url, room, invite } ou null. */
export function parseDeepLink(link) {
  if (typeof link !== 'string' || !/^telao:\/\//i.test(link.trim())) return null;
  let invite;
  try {
    invite = new URL(link.trim()).searchParams.get('convite');
  } catch {
    return null;
  }
  const parsed = parseServerAddress(invite);
  return parsed?.room ? { ...parsed, invite } : null;
}

// Endereços que só aparecem em convites do Telão: o túnel da Cloudflare, IP (ou
// localhost) com porta na rede local, ou ws(s)://. O endereço de um servidor
// próprio continua funcionando colado no campo; só não vira a faixa automática.
function isInviteHost(url) {
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return true;
  const host = url.hostname.toLowerCase();
  if (/^[a-z0-9-]+\.trycloudflare\.com$/.test(host)) return true;
  return Boolean(url.port) && (host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host));
}

/**
 * Reconhece um convite num texto qualquer (ex.: o que está na área de
 * transferência, como "Entra aí: https://xxxx.trycloudflare.com/sala-abc").
 * Só aceita links com cara de convite do Telão (ver isInviteHost), com o nome
 * da sala no fim e nada depois. Devolve { url, room, invite } ou null.
 */
export function parseInviteText(text) {
  const value = String(text || '');
  if (value.length > 500) return null;
  for (const [raw] of value.matchAll(/(?:telao|https?|wss?):\/\/\S+|[\w.-]+:\d{2,5}\/\S+/gi)) {
    // Pontuação colada no fim ("…/sala-abc." ou "(…/sala-abc)") não faz parte do link.
    const token = raw.replace(/[.,;:!?)\]}>'"»…]+$/u, '');
    if (/^telao:\/\//i.test(token)) {
      const invite = parseDeepLink(token);
      if (invite) return invite;
      continue;
    }
    if (/[?#]/.test(token)) continue;
    let url;
    try {
      url = new URL(/^[a-z]+:\/\//i.test(token) ? token : `http://${token}`);
    } catch {
      continue;
    }
    if (url.username || url.password || !isInviteHost(url)) continue;
    if (url.pathname.split('/').filter(Boolean).length !== 1) continue;
    const parsed = parseServerAddress(token);
    if (parsed?.room) return { ...parsed, invite: token };
  }
  return null;
}
