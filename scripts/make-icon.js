'use strict';

// Gera os ícones do app sem dependências: um monitor branco com botão "play"
// sobre um quadrado arredondado em degradê azul→roxo, mais as variações da
// bandeja (normal e "ao vivo", com bolinha vermelha) e o selo da barra de tarefas.
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

// Triângulo equilátero apontando para a direita (fórmula de Inigo Quilez).
function sdPlay(px, py, cx, cy, r) {
  const k = Math.sqrt(3);
  let x = Math.abs(py - cy) - r;
  let y = (px - cx) + r / k;
  if (x + k * y > 0) [x, y] = [(x - k * y) / 2, (-k * x - y) / 2];
  x -= Math.min(Math.max(x, -2 * r), 0);
  return -Math.hypot(x, y) * Math.sign(y);
}

const WHITE = [255, 255, 255];
const RED = [229, 57, 53];

// Desenhos no espaço 0..48 (o mesmo do logo SVG da interface).
function logo(px, py, { live = false } = {}) {
  if (live) {
    const d = Math.hypot(px - 38, py - 10);
    if (d <= 8) return RED;
    if (d <= 11) return WHITE;
  }
  if (sdRoundRect(px, py, 24, 24, 24, 24, 12) > 0) return null;
  const t = (px + py) / 96;
  const bg = [59 + (139 - 59) * t, 130 + (92 - 130) * t, 246];
  const screenRing = Math.abs(sdRoundRect(px, py, 24, 21, 14, 9.5, 3.5)) - 1.5;
  const neck = sdRoundRect(px, py, 24, 33.5, 1.5, 2.5, 0);
  const base = sdRoundRect(px, py, 24, 37, 7, 1.5, 1.5);
  const play = sdPlay(px, py, 24.3, 21, 4.2);
  return Math.min(screenRing, neck, base, play) <= 0 ? WHITE : bg;
}

function badge(px, py) {
  const d = Math.hypot(px - 24, py - 24);
  if (d <= 17) return RED;
  if (d <= 22) return WHITE;
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
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
const assets = path.join(root, 'src', 'renderer', 'assets');
const outputs = [
  [path.join(root, 'build', 'icon.png'), 256, (x, y) => logo(x, y)],
  [path.join(assets, 'icon.png'), 256, (x, y) => logo(x, y)],
  [path.join(assets, 'tray.png'), 16, (x, y) => logo(x, y)],
  [path.join(assets, 'tray@2x.png'), 32, (x, y) => logo(x, y)],
  [path.join(assets, 'tray-live.png'), 16, (x, y) => logo(x, y, { live: true })],
  [path.join(assets, 'tray-live@2x.png'), 32, (x, y) => logo(x, y, { live: true })],
  [path.join(assets, 'live-badge.png'), 16, badge],
  [path.join(assets, 'live-badge@2x.png'), 32, badge],
];
for (const [target, size, draw] of outputs) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, encodePng(size, render(size, draw)));
  console.log(`Ícone gerado: ${path.relative(root, target)} (${size}px)`);
}
