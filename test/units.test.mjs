// Testes de lógica pura (rodam só no Node, sem abrir o app).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  mungeRemoteSdp, pickCodec, startBitrateKbps, targetBitrate, videoConstraints,
} from '../src/renderer/media.js';

const require = createRequire(import.meta.url);
const { createFrameParser, normalizeExeName } = require('../src/main/app-audio.js');

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
