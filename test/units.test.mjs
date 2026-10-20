// Testes de lógica pura (rodam só no Node, sem abrir o app).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mungeRemoteSdp, pickCodec, startBitrateKbps, targetBitrate, videoConstraints,
} from '../src/renderer/media.js';
import { inviteAddress, parseServerAddress } from '../src/renderer/address.js';

const require = createRequire(import.meta.url);
const { createFrameParser, normalizeExeName } = require('../src/main/app-audio.js');

// theme.js é um script clássico: ao ser carregado, publica globalThis.TelaoTheme.
await import('../src/renderer/theme.js');
const Theme = globalThis.TelaoTheme;
const CSS = (await import('node:fs')).readFileSync(new URL('../src/renderer/styles.css', import.meta.url), 'utf8');

// Ambiente mínimo de AudioWorklet para carregar o processador.
let Processor = null;
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { onmessage: null }; } };
globalThis.registerProcessor = (_name, cls) => { Processor = cls; };
await import('../src/renderer/pcm-worklet.js');

function frame(type, id, payload) {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeUInt32LE(id, 1);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

test('leitor de pacotes do telao-audio.exe aguenta pedaços quebrados', () => {
  const event = Buffer.from(JSON.stringify({ event: 'source', id: 7, name: 'Spotify.exe' }));
  const audio = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
  const stream = Buffer.concat([frame(2, 0, event), frame(1, 7, audio), frame(1, 7, Buffer.alloc(0))]);
  for (const size of [1, 3, 9, stream.length]) {
    const got = [];
    const parse = createFrameParser((type, id, payload) => got.push([type, id, Buffer.from(payload).toString('hex')]));
    for (let i = 0; i < stream.length; i += size) parse(stream.subarray(i, i + size));
    assert.deepEqual(got, [
      [2, 0, event.toString('hex')],
      [1, 7, audio.toString('hex')],
      [1, 7, ''],
    ], `pedaços de ${size} bytes`);
  }
});

test('nomes de programas para a lista de exclusão', () => {
  assert.equal(normalizeExeName('Discord'), 'Discord.exe');
  assert.equal(normalizeExeName('  Discord.exe '), 'Discord.exe');
  assert.equal(normalizeExeName('C:\\Apps\\TeamSpeak.exe'), 'TeamSpeak.exe');
  assert.equal(normalizeExeName('a,b'), null);
  assert.equal(normalizeExeName(''), null);
});

const SAMPLE_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:102 H264/90000',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
  '',
].join('\r\n');

test('SDP: Opus em estéreo com bitrate alto e bitrate inicial do vídeo', () => {
  const out = mungeRemoteSdp(SAMPLE_SDP, { startKbps: 3000 });
  const lines = out.split('\r\n');
  assert.ok(out.endsWith('\r\n'), 'mantém o fim de linha');
  assert.ok(lines.includes('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=160000'));
  assert.ok(lines.includes('a=fmtp:63 111/111'), 'RED não muda');
  // VP8 não tinha a=fmtp: a linha é criada logo depois do a=rtpmap.
  assert.equal(lines[lines.indexOf('a=rtpmap:96 VP8/90000') + 1], 'a=fmtp:96 x-google-start-bitrate=3000');
  assert.ok(lines.includes('a=fmtp:97 apt=96'), 'RTX não muda');
  assert.ok(lines.includes('a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f;x-google-start-bitrate=3000'));
  // Aplicar de novo não duplica nada.
  assert.equal(mungeRemoteSdp(out, { startKbps: 3000 }), out);
});

test('bitrate automático e manual', () => {
  const base = { resolution: '1080p', fps: 30, bitrate: 0, optimize: 'motion', codec: 'auto' };
  assert.equal(targetBitrate(base), 6_220_800);
  assert.equal(targetBitrate({ ...base, bitrate: 8 }), 8_000_000);
  assert.equal(targetBitrate({ ...base, resolution: 'native', fps: 60 }, { width: 3840, height: 2160 }), 30_000_000);
  assert.equal(targetBitrate({ ...base, resolution: '480p', fps: 5 }), 800_000);
  assert.equal(startBitrateKbps(null), 2500);
  assert.equal(startBitrateKbps(base), 4000);
  assert.equal(startBitrateKbps({ ...base, resolution: '720p' }), 2765);
});

test('restrições de captura', () => {
  assert.deepEqual(videoConstraints({ resolution: '720p', fps: 30 }), {
    frameRate: { ideal: 30, max: 30 }, width: { max: 1280 }, height: { max: 720 },
  });
  assert.deepEqual(videoConstraints({ resolution: 'native', fps: 60 }), { frameRate: { ideal: 60, max: 60 } });
});

test('escolha do codec H.264 compatível com GPU', () => {
  const codecs = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f' },
    { mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f' },
  ];
  assert.equal(pickCodec(codecs, 'H264'), codecs[3]);
  assert.equal(pickCodec(codecs, 'VP8'), codecs[0]);
  assert.equal(pickCodec(codecs, 'auto'), null);
  assert.equal(pickCodec(codecs, 'AV1'), null);
});

test('buffer de áudio: espera juntar 40 ms, toca na ordem e limita o atraso', () => {
  const p = new Processor();
  const out = () => {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    p.process([], [[left, right]]);
    return [left, right];
  };
  const samples = (frames, start) => {
    const s = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) { s[2 * i] = start + i; s[2 * i + 1] = -(start + i); }
    return s;
  };

  p.port.onmessage({ data: samples(1000, 1) });
  assert.ok(out()[0].every((x) => x === 0), 'silêncio antes de juntar 40 ms');

  p.port.onmessage({ data: samples(1000, 1001) }); // agora 2000 quadros (> 1920)
  const [left, right] = out();
  assert.equal(Math.round(left[0] * 32768), 1);
  assert.equal(Math.round(left[127] * 32768), 128);
  assert.equal(Math.round(right[5] * 32768), -6);

  p.port.onmessage({ data: samples(48000 * 0.3, 5000) }); // 300 ms de uma vez
  assert.ok(p.count <= 0.25 * 48000, 'não acumula mais de 250 ms');
});

// ---------- Endereços e convites (address.js) ----------

test('endereço do servidor: formatos aceitos, com e sem a sala no fim', () => {
  assert.deepEqual(parseServerAddress('192.168.0.10'), { url: 'ws://192.168.0.10:47800', room: '' });
  assert.deepEqual(parseServerAddress(' 192.168.0.10:47800/sala-k3x9q2a '), { url: 'ws://192.168.0.10:47800', room: 'sala-k3x9q2a' });
  assert.deepEqual(parseServerAddress('https://abc-def.trycloudflare.com/filme%20sexta/'), { url: 'wss://abc-def.trycloudflare.com', room: 'filme sexta' });
  assert.deepEqual(parseServerAddress('wss://abc-def.trycloudflare.com'), { url: 'wss://abc-def.trycloudflare.com', room: '' });
  assert.deepEqual(parseServerAddress('meu-servico.onrender.com/sala'), { url: 'wss://meu-servico.onrender.com', room: 'sala' });
  assert.deepEqual(parseServerAddress('localhost:5000'), { url: 'ws://localhost:5000', room: '' });
  assert.equal(parseServerAddress(''), null);
  assert.equal(parseServerAddress('wss://'), null);
});

test('convite = endereço + sala, e volta igual ao ser lido', () => {
  for (const [base, room] of [
    ['wss://abc-def.trycloudflare.com', 'sala-k3x9q2a'],
    ['192.168.0.10:47800', 'filme sexta'],
    ['wss://x.example.com/', 'Ação/Terror'],
  ]) {
    const invite = inviteAddress(base, room);
    assert.equal(parseServerAddress(invite).room, room, invite);
  }
  assert.equal(inviteAddress('wss://a.trycloudflare.com', 'sala-1'), 'wss://a.trycloudflare.com/sala-1');
});

// ---------- Aparência (theme.js) ----------

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

test('cores: leitura de hexadecimal e contraste WCAG', () => {
  assert.deepEqual(Theme.parseHex('#abc'), { r: 170, g: 187, b: 204 });
  assert.deepEqual(Theme.parseHex('2563EB'), { r: 37, g: 99, b: 235 });
  assert.equal(Theme.parseHex('#12345'), null);
  assert.equal(Theme.parseHex('azul'), null);
  assert.equal(Theme.toHex({ r: 37, g: 99, b: 235 }), '#2563eb');
  assert.equal(Number(Theme.contrast(WHITE, BLACK).toFixed(2)), 21);
});

// Superfícies sobre as quais bordas e anéis de foco aparecem (painel, fundo, campos,
// grupo segmentado e fundo rebaixado da sala), em cada modo.
const RING_SURFACES = {
  dark: ['#151a21', '#0d1117', '#10151c', '#090c10'],
  light: ['#ffffff', '#f4f6f9', '#eef1f5', '#e9edf2'],
};
const minRingContrast = (ui, mode) => Math.min(...RING_SURFACES[mode].map((s) => Theme.contrast(ui, Theme.parseHex(s))));

test('cores prontas: texto legível (4,5:1) e bordas visíveis (3:1) nos dois temas', () => {
  for (const preset of Theme.PRESETS) {
    for (const mode of ['dark', 'light']) {
      const vars = Theme.accentVars(preset.color, mode);
      const accent = Theme.parseHex(vars['--accent']);
      const text = Theme.parseHex(vars['--accent-text']);
      const ui = Theme.parseHex(vars['--accent-ui']);
      assert.ok(Theme.contrast(text, accent) >= 4.5, `${preset.name}/${mode}: texto do botão`);
      assert.ok(minRingContrast(ui, mode) >= 3, `${preset.name}/${mode}: borda/foco`);
    }
    const expected = preset.name === 'Amarelo' ? '#000000' : '#ffffff';
    assert.equal(Theme.accentVars(preset.color, 'dark')['--accent-text'], expected, `${preset.name}: cor do texto`);
  }
});

test('qualquer cor escolhida mantém o contraste mínimo (500 cores aleatórias)', () => {
  let seed = 12345;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i++) {
    const color = Theme.toHex({ r: random() * 255, g: random() * 255, b: random() * 255 });
    for (const mode of ['dark', 'light']) {
      const vars = Theme.accentVars(color, mode);
      const accent = Theme.parseHex(vars['--accent']);
      const text = Theme.parseHex(vars['--accent-text']);
      const hover = Theme.parseHex(vars['--accent-hover']);
      const ui = Theme.parseHex(vars['--accent-ui']);
      assert.ok(Theme.contrast(text, accent) >= 4.5, `${color}/${mode}: texto`);
      assert.ok(Theme.contrast(text, hover) >= Theme.contrast(text, accent) - 0.01, `${color}/${mode}: hover não piora`);
      assert.ok(minRingContrast(ui, mode) >= 3, `${color}/${mode}: borda/foco`);
    }
  }
});

test('aparência inválida volta ao padrão', () => {
  assert.deepEqual(Theme.normalize(null), { theme: 'dark', accent: '#2563eb' });
  assert.deepEqual(Theme.normalize({ theme: 'azul', accent: 'xyz' }), { theme: 'dark', accent: '#2563eb' });
  assert.deepEqual(Theme.normalize({ theme: 'light', accent: '#ABCDEF' }), { theme: 'light', accent: '#abcdef' });
});

test('apply() marca o modo e grava as variáveis', () => {
  const props = {};
  const root = { dataset: {}, style: { setProperty: (k, v) => { props[k] = v; } } };
  const applied = Theme.apply({ theme: 'light', accent: '#eab308' }, root);
  assert.equal(applied.mode, 'light');
  assert.equal(root.dataset.mode, 'light');
  assert.equal(props['--accent'], '#eab308');
  assert.equal(props['--accent-text'], '#000000');
  // "Igual ao Windows" sem matchMedia disponível cai no escuro…
  assert.equal(Theme.apply({ theme: 'system' }, root).mode, 'dark');
  // …e usa o modo que o processo principal informar.
  assert.equal(Theme.apply({ theme: 'system' }, root, 'light').mode, 'light');
  assert.equal(root.dataset.mode, 'light');
});

test('"Igual ao Windows" segue o tema do sistema', () => {
  const original = globalThis.matchMedia;
  try {
    globalThis.matchMedia = () => ({ matches: true });
    assert.equal(Theme.effectiveMode('system'), 'light');
    globalThis.matchMedia = () => ({ matches: false });
    assert.equal(Theme.effectiveMode('system'), 'dark');
    assert.equal(Theme.effectiveMode('light'), 'light');
  } finally {
    globalThis.matchMedia = original;
  }
});

test('load() lê a aparência que o app.js grava (mesma chave)', () => {
  const original = globalThis.localStorage;
  const storage = (value) => ({ getItem: (key) => (key === Theme.PREFS_KEY ? value : null) });
  try {
    globalThis.localStorage = storage(JSON.stringify({ name: 'x', appearance: { theme: 'light', accent: '#DB2777' } }));
    assert.deepEqual(Theme.load(), { theme: 'light', accent: '#db2777' });
    globalThis.localStorage = storage(JSON.stringify({ appearance: null })); // depois de "Restaurar o padrão"
    assert.deepEqual(Theme.load(), Theme.DEFAULT_APPEARANCE);
    globalThis.localStorage = storage('{corrompido');
    assert.deepEqual(Theme.load(), Theme.DEFAULT_APPEARANCE);
  } finally {
    globalThis.localStorage = original;
  }
});

test('aparência do processo principal: validação e padrões iguais aos da interface', () => {
  const { DEFAULT_APPEARANCE, normalizeAppearance } = require('../src/main/appearance.js');
  assert.equal(DEFAULT_APPEARANCE.theme, Theme.DEFAULT_APPEARANCE.theme);
  assert.equal(DEFAULT_APPEARANCE.backgrounds.dark, Theme.SURFACES.dark.bg);
  assert.equal(DEFAULT_APPEARANCE.backgrounds.light, Theme.SURFACES.light.bg);
  assert.deepEqual(normalizeAppearance(null), { theme: 'dark', backgrounds: { dark: '#0d1117', light: '#f4f6f9' } });
  assert.deepEqual(normalizeAppearance({ theme: 'roxo', backgrounds: { dark: 'red', light: '#ABCDEF' } }),
    { theme: 'dark', backgrounds: { dark: '#0d1117', light: '#ABCDEF' } });
  const current = { theme: 'light', backgrounds: { dark: '#111111', light: '#eeeeee' } };
  assert.deepEqual(normalizeAppearance({ theme: 'system' }, current), { theme: 'system', backgrounds: current.backgrounds });
});

test('CSS e theme.js usam as mesmas cores padrão e superfícies', () => {
  const block = (selector) => CSS.slice(CSS.indexOf(`${selector} {`), CSS.indexOf('}', CSS.indexOf(`${selector} {`)));
  const value = (css, name) => (new RegExp(`${name}:[ \\t]*([^;]+);`).exec(css) || [])[1];
  const root = block(':root');
  const light = block(':root[data-mode="light"]');
  for (const [name, expected] of Object.entries(Theme.accentVars(Theme.DEFAULT_APPEARANCE.accent, 'dark'))) {
    assert.equal(value(root, name), expected, `padrão de ${name} no CSS`);
  }
  for (const [mode, css] of [['dark', root], ['light', light]]) {
    assert.equal(value(css, '--panel'), Theme.SURFACES[mode].panel, `--panel (${mode})`);
    assert.equal(value(css, '--bg'), Theme.SURFACES[mode].bg, `--bg (${mode})`);
    assert.equal(value(css, '--bg-sunken'), Theme.SURFACES[mode].sunken, `--bg-sunken (${mode})`);
    assert.equal(value(css, '--seg-bg'), RING_SURFACES[mode][2], `--seg-bg (${mode})`);
  }
});
