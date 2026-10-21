'use strict';

// Gera os ícones do app sem dependências, com o símbolo da interface: um monitor do
// multivisor com a faixa de rótulo e o tally, sobre um quadrado grafite. No ícone do
// app a faixa fica acesa no vermelho de "no ar"; na bandeja ela fica apagada e acende
// quando há transmissão. O selo da barra de tarefas é a lâmpada de "no ar".
// Saídas: build/icon.png (electron-builder) e src/renderer/assets/*.png.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SS = 4; // supersampling por eixo, para bordas suaves

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - hw + r;
  const qy = Math.abs(py - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const WHITE = [255, 255, 255];
const GRAPHITE = [22, 23, 26]; // --panel do tema escuro
const FRAME = [236, 238, 241]; // --text do tema escuro
const TALLY = [217, 43, 38]; // vermelho de "no ar" (cor de destaque padrão)
const OFF = [93, 97, 104]; // lâmpada apagada

// Desenhos no espaço 0..48. lit = faixa de rótulo e tally acesos; bold = traço mais
// grosso para os tamanhos pequenos da bandeja (16 e 32 px).
function logo(px, py, { lit = true, bold = false } = {}) {
  if (sdRoundRect(px, py, 24, 24, 24, 24, 9) > 0) return null;
  const stroke = bold ? 2.3 : 1.7;
  const frame = Math.abs(sdRoundRect(px, py, 24, 20.5, 14.5, 10, 1.5)) - stroke;
  if (frame <= 0) return FRAME;
  const strip = sdRoundRect(px, py, 24, 36, 14.5 + stroke, bold ? 3 : 2.4, 0.8);
  const tally = sdRoundRect(px, py, 15.5, 15, bold ? 2.6 : 2.2, bold ? 2.6 : 2.2, 0.4);
  if (strip <= 0 || tally <= 0) return lit ? TALLY : OFF;
  return GRAPHITE;
}

// O selo sobre o ícone da barra de tarefas: a lâmpada de "no ar", quadrada.
function badge(px, py) {
  if (sdRoundRect(px, py, 24, 24, 14, 14, 3) <= 0) return TALLY;
  if (sdRoundRect(px, py, 24, 24, 19, 19, 5) <= 0) return WHITE;
  return null;
}

function render(size, draw) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 48 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = draw((x + (sx + 0.5) / SS) * scale, (y + (sy + 0.5) / SS) * scale);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        rgba[i] = Math.round(r / a);
        rgba[i + 1] = Math.round(g / a);
        rgba[i + 2] = Math.round(b / a);
      }
      rgba[i + 3] = Math.round((a / (SS * SS)) * 255);
    }
  }
  return rgba;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Procedência gravada em cada PNG (bloco tEXt "impeccable:prompt"): de onde a imagem veio.
const PROVENANCE = Buffer.from('impeccable:prompt\0Origin: drawn in code by scripts/make-icon.js '
  + '(Telao mark: multiviewer monitor with label strip and tally on a graphite tile; no generated or sourced imagery)', 'latin1');

function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', PROVENANCE),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
const assets = path.join(root, 'src', 'renderer', 'assets');
const outputs = [
  [path.join(root, 'build', 'icon.png'), 256, (x, y) => logo(x, y)],
  [path.join(assets, 'icon.png'), 256, (x, y) => logo(x, y)],
  [path.join(assets, 'tray.png'), 16, (x, y) => logo(x, y, { lit: false, bold: true })],
  [path.join(assets, 'tray@2x.png'), 32, (x, y) => logo(x, y, { lit: false, bold: true })],
  [path.join(assets, 'tray-live.png'), 16, (x, y) => logo(x, y, { bold: true })],
  [path.join(assets, 'tray-live@2x.png'), 32, (x, y) => logo(x, y, { bold: true })],
  [path.join(assets, 'live-badge.png'), 16, badge],
  [path.join(assets, 'live-badge@2x.png'), 32, badge],
];
for (const [target, size, draw] of outputs) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(size, render(size, draw)));
  console.log(`Ícone gerado: ${path.relative(root, target)} (${size}px)`);
}
