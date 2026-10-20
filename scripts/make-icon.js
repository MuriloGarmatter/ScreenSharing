'use strict';

// Gera o ícone do app (PNG 256×256) sem dependências: um monitor branco com
// botão "play" sobre um quadrado arredondado em degradê azul→roxo.
// Saídas: build/icon.png (usado pelo electron-builder) e src/renderer/assets/icon.png.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 256;
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

function sample(x, y) {
  // Coordenadas no espaço 0..48 (mesmo desenho do logo SVG da interface).
  const s = 48 / SIZE;
  const px = x * s;
  const py = y * s;
  if (sdRoundRect(px, py, 24, 24, 24, 24, 12) > 0) return null;
  const t = (px + py) / 96;
  const bg = [59 + (139 - 59) * t, 130 + (92 - 130) * t, 246 + (246 - 246) * t];
  const screenRing = Math.abs(sdRoundRect(px, py, 24, 21, 14, 9.5, 3.5)) - 1.5;
  const neck = sdRoundRect(px, py, 24, 33.5, 1.5, 2.5, 0);
  const base = sdRoundRect(px, py, 24, 37, 7, 1.5, 1.5);
  const play = sdPlay(px, py, 24.3, 21, 4.2);
  const white = Math.min(screenRing, neck, base, play) <= 0;
  return white ? [255, 255, 255] : bg;
}

function render() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * SIZE + x) * 4;
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

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const png = encodePng(render());
const root = path.join(__dirname, '..');
for (const target of [path.join(root, 'build', 'icon.png'), path.join(root, 'src', 'renderer', 'assets', 'icon.png')]) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, png);
  console.log(`Ícone gerado: ${path.relative(root, target)}`);
}
