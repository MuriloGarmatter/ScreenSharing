// Pequenos utilitários de interface: seletores, criação de elementos, ícones, avisos.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

const PATHS = {
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
  'volume-x': '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  swap: '<path d="m17 2 4 4-4 4"/><path d="M3 11V10a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  wifi: '<path d="M5 12.6a10 10 0 0 1 14 0M8.5 16.1a5 5 0 0 1 7 0M2 8.8a15 15 0 0 1 20 0"/><path d="M12 20h.01"/>',
};

const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true"><defs><linearGradient id="telao-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#8b5cf6"/></linearGradient></defs><rect width="48" height="48" rx="12" fill="url(#telao-logo)"/><rect x="10" y="11.5" width="28" height="19" rx="3.5" fill="none" stroke="#fff" stroke-width="3"/><path d="M24 31v5M17 37h14" stroke="#fff" stroke-width="3" stroke-linecap="round"/><path d="M21.5 16.8v8.4l7-4.2z" fill="#fff"/></svg>`;

export function icon(name) {
  if (name === 'logo') return LOGO;
  return `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] || ''}</svg>`;
}

export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    node.insertAdjacentHTML('afterbegin', icon(node.dataset.icon));
    node.removeAttribute('data-icon');
  }
}

export function toast(message, kind = 'info', timeout = 5000) {
  const box = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  box.append(node);
  setTimeout(() => node.remove(), timeout);
}

export function formatBitrate(bps) {
  if (bps === null || bps === undefined || Number.isNaN(bps)) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1).replace('.', ',')} Mb/s`;
  return `${Math.round(bps / 1000)} kb/s`;
}

export function formatFps(fps) {
  return fps ? `${Math.round(fps)} fps` : '— fps';
}

export function hueFor(text) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)) % 360;
  return String(h);
}
