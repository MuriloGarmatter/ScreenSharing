// Testes de lógica pura (rodam só no Node, sem abrir o app).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  QUALITY_PRESETS, effectiveFps, matchPreset, mungeRemoteSdp, pickCodec, resolveCodec, scaleForHeight,
  sendEncoding, startBitrateKbps, suggestLowerSettings, targetBitrate, videoConstraints, wantedHeight,
  CAMERA_BITRATE, cameraEncoding, cameraErrorMessage,
} from '../src/renderer/media.js';
import { CAMERA_VERSION, supportsCamera } from '../src/renderer/mesh.js';
import {
  PUBLIC_SERVER, deepLinkFor, inviteLink, parseDeepLink, parseInviteText, parseServerAddress,
} from '../src/renderer/address.js';
import { levelFrom, limitReason, peerSignal } from '../src/renderer/stats.js';
import { bestColumns } from '../src/renderer/layout.js';
import { compareVersions, outdatedPeers } from '../src/renderer/version.js';
import { Lobby } from '../worker/src/index.js';

const require = createRequire(import.meta.url);
const { createFrameParser, helperArgs, normalizeExeName } = require('../src/main/app-audio.js');
const { findDeepLink } = require('../src/main/deeplink.js');
const { handleHttpRequest, httpResponse, inviteFor } = require('../server/invite-page.js');

const escapeAttr = (value) => value.replace(/&/g, '&amp;');

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

test('convite = link clicável com a sala, e volta igual ao ser lido', () => {
  for (const [base, room, url] of [
    ['wss://abc-def.trycloudflare.com', 'sala-k3x9q2a', 'wss://abc-def.trycloudflare.com'],
    ['192.168.0.10:47800', 'filme sexta', 'ws://192.168.0.10:47800'],
    ['wss://x.example.com/', 'Ação/Terror', 'wss://x.example.com'],
  ]) {
    const link = inviteLink(base, room);
    assert.match(link, /^https?:\/\//, 'o convite é um link http(s), clicável no Discord/WhatsApp');
    assert.deepEqual(parseServerAddress(link), { url, room }, link);
  }
  assert.equal(inviteLink('wss://a.trycloudflare.com', 'sala-1'), 'https://a.trycloudflare.com/sala-1');
  assert.equal(inviteLink('192.168.0.10:47800', 'sala-1'), 'http://192.168.0.10:47800/sala-1');
});

test('link telao:// leva o convite inteiro e só ele', () => {
  const invite = 'https://abc-def.trycloudflare.com/filme-sexta';
  const link = deepLinkFor(invite);
  assert.equal(link, 'telao://entrar/?convite=https%3A%2F%2Fabc-def.trycloudflare.com%2Ffilme-sexta');
  assert.deepEqual(parseDeepLink(link), { url: 'wss://abc-def.trycloudflare.com', room: 'filme-sexta', invite });
  assert.deepEqual(parseDeepLink(deepLinkFor('http://192.168.0.10:47800/sala')).url, 'ws://192.168.0.10:47800');
  assert.equal(parseDeepLink('telao://entrar/?convite=https%3A%2F%2Fsem-sala.com'), null, 'sem sala, não é convite');
  assert.equal(parseDeepLink('https://abc.com/sala'), null);
  assert.equal(parseDeepLink('telao://%%%'), null);
});

test('convite copiado: reconhece links de convite e ignora outros textos', () => {
  assert.equal(parseInviteText('https://abc-def.trycloudflare.com/filme-sexta').room, 'filme-sexta');
  assert.equal(parseInviteText('  http://192.168.0.10:47800/sala-1\n').url, 'ws://192.168.0.10:47800');
  assert.equal(parseInviteText('192.168.0.10:47800/sala-1').room, 'sala-1');
  assert.equal(parseInviteText(deepLinkFor('https://a.trycloudflare.com/x')).room, 'x');
  // A mensagem inteira copiada do chat, e o ponto final colado no link.
  const fromChat = parseInviteText('Entra aí: https://abc-def.trycloudflare.com/sala-k3x9q2a.');
  assert.equal(fromChat.room, 'sala-k3x9q2a');
  assert.equal(fromChat.invite, 'https://abc-def.trycloudflare.com/sala-k3x9q2a');
  assert.equal(parseInviteText('(https://abc-def.trycloudflare.com/filme)').room, 'filme');
  assert.equal(parseInviteText('vê isso https://youtu.be/abc e entra https://a-b.trycloudflare.com/sala-2').room, 'sala-2');
  assert.equal(parseInviteText('wss://meu-servidor.com.br/sala').url, 'wss://meu-servidor.com.br');
  // O link fixo do servidor do Telão.
  const fixed = parseInviteText('bora: https://telao.xmbc.workers.dev/filme-sexta');
  assert.equal(fixed.url, PUBLIC_SERVER);
  assert.equal(fixed.room, 'filme-sexta');
  assert.equal(inviteLink(PUBLIC_SERVER, 'filme sexta'), 'https://telao.xmbc.workers.dev/filme%20sexta');
  for (const text of [
    '', 'oi, tudo bem?', 'https://www.youtube.com/', 'https://site.com/a/b/c', 'senha123', 'x'.repeat(400),
    // Links de um segmento só que não são do Telão (o que mais aparece copiado).
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://discord.gg/abc123',
    'https://www.twitch.tv/gaules', 'https://x.com/fulano', 'https://github.com/fulano',
    'http://192.168.0.1/login', 'https://abc.trycloudflare.com/sala?x=1', 'https://abc.trycloudflare.com/a/b',
    'https://abc.trycloudflare.com/', 'https://user:senha@abc.trycloudflare.com/sala',
    // Outros sites do workers.dev não são o Telão; http:// também não é o link fixo.
    'https://outro.xmbc.workers.dev/sala', 'https://telao.outra.workers.dev/sala', 'http://telao.xmbc.workers.dev/sala',
    'https://telao.xmbc.workers.dev/', 'https://telao.xmbc.workers.dev/a/b',
  ]) {
    assert.equal(parseInviteText(text), null, `não é convite: ${text.slice(0, 50)}`);
  }
});

test('link telao:// na linha de comando', () => {
  assert.equal(findDeepLink(['Telao.exe', '--profile=b', 'telao://entrar/?convite=x']), 'telao://entrar/?convite=x');
  assert.equal(findDeepLink(['Telao.exe', 'https://x.com']), null);
  assert.equal(findDeepLink(undefined), null);
});

test('página do convite: monta o link certo e escapa o que vem da URL', () => {
  const req = (url, headers = {}) => ({ url, method: 'GET', headers: { host: 'abc-def.trycloudflare.com', ...headers } });
  const via = inviteFor({ host: 'abc-def.trycloudflare.com', scheme: 'https', url: '/filme-sexta' });
  assert.equal(via.invite, 'https://abc-def.trycloudflare.com/filme-sexta');
  assert.equal(via.deepLink, deepLinkFor(via.invite));
  assert.equal(inviteFor({ host: '192.168.0.10:47800', scheme: 'http', url: '/sala' }).invite, 'http://192.168.0.10:47800/sala');
  assert.equal(inviteFor({ host: 'evil.com"><script>', scheme: 'http', url: '/sala' }), null, 'host inválido');
  assert.equal(inviteFor({ host: 'abc-def.trycloudflare.com', scheme: 'http', url: '/a/b' }), null, 'sala com barra não é convite');
  // No servidor da Cloudflare a URL chega completa.
  const cloud = httpResponse({ method: 'GET', url: 'https://telao.xmbc.workers.dev/Filme%20Sexta', host: 'telao.xmbc.workers.dev', scheme: 'https' });
  assert.equal(cloud.status, 200);
  assert.ok(cloud.body.includes(escapeAttr(deepLinkFor('https://telao.xmbc.workers.dev/Filme%20Sexta'))));
  assert.ok(cloud.body.includes('releases/latest'), 'quem não tem o app acha onde baixar');
  assert.equal(httpResponse({ method: 'HEAD', url: '/sala', host: 'x.trycloudflare.com', scheme: 'https' }).body, undefined);
  assert.equal(httpResponse({ method: 'POST', url: '/sala', host: 'x.trycloudflare.com', scheme: 'https' }).status, 405);
  // Atrás do túnel, o servidor do PC monta o convite com https.
  const tunneled = { headers: {} };
  handleHttpRequest(req('/filme-sexta', { 'x-forwarded-proto': 'https' }), {
    writeHead: () => {}, end: (body) => { tunneled.body = String(body); },
  });
  assert.ok(tunneled.body.includes(escapeAttr(deepLinkFor('https://abc-def.trycloudflare.com/filme-sexta'))));

  const render = (url) => {
    const out = { status: 0, headers: {}, body: '' };
    handleHttpRequest(req(url), {
      writeHead: (status, headers) => { out.status = status; out.headers = headers; },
      end: (body) => { out.body = String(body ?? ''); },
    });
    return out;
  };
  const page = render(`/${encodeURIComponent('<img src=x onerror=alert(1)>')}`);
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes('<img src=x'), 'o nome da sala não vira HTML');
  assert.ok(page.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(page.headers['X-Frame-Options'], 'DENY');
  assert.equal(render('/').status, 200);
  assert.equal(render('/favicon.ico').status, 404);
  assert.ok(render('/robots.txt').body.includes('Disallow: /'));
});

test('servidor da Cloudflare: salas, repasse e faxina de quem caiu', async () => {
  // WebSockets e Durable Object de mentira, com o que o Lobby usa da API.
  const socket = () => ({
    readyState: 1, sent: [], attachment: null, closedWith: null,
    send(text) { this.sent.push(JSON.parse(text)); },
    close(code) { this.closedWith = code; this.readyState = 3; },
    serializeAttachment(value) { this.attachment = structuredClone(value); },
    deserializeAttachment() { return structuredClone(this.attachment); },
  });
  const sockets = [];
  const pings = new Map();
  let alarm = null;
  const ctx = {
    getWebSockets: () => sockets,
    getWebSocketAutoResponseTimestamp: (ws) => pings.get(ws) ?? null,
    storage: { getAlarm: async () => alarm, setAlarm: async (time) => { alarm = time; } },
  };
  const lobby = new Lobby(ctx, {});
  const join = async (room, name) => {
    const ws = socket();
    sockets.push(ws);
    await lobby.webSocketMessage(ws, JSON.stringify({ type: 'join', room, name, state: { version: '1.3.0' } }));
    return ws;
  };
  const last = (ws) => ws.sent.at(-1);

  const ana = await join('Filme', 'Ana');
  const bia = await join('filme', 'Bia');
  const caio = await join('outra', 'Caio');
  assert.equal(last(bia).type, 'welcome');
  assert.deepEqual(last(bia).peers.map((p) => p.name), ['Ana'], 'só quem está na mesma sala');
  assert.equal(last(ana).type, 'peer-joined');
  assert.equal(caio.sent.length, 1, 'outra sala não fica sabendo');
  assert.ok(alarm !== null, 'faxina agendada');

  await lobby.webSocketMessage(ana, JSON.stringify({ type: 'signal', to: bia.attachment.id, data: { x: 1 } }));
  assert.deepEqual(last(bia), { type: 'signal', from: ana.attachment.id, data: { x: 1 } });
  await lobby.webSocketMessage(ana, JSON.stringify({ type: 'signal', to: caio.attachment.id, data: { x: 1 } }));
  assert.equal(caio.sent.length, 1, 'sinal não atravessa salas');
  await lobby.webSocketMessage(bia, JSON.stringify({ type: 'state', state: { sharing: true, label: 'Jogo' } }));
  assert.equal(last(ana).type, 'peer-state');
  assert.equal(bia.attachment.state.sharing, true, 'estado guardado no WebSocket (sobrevive à hibernação)');
  await lobby.webSocketMessage(bia, 'pong');
  await lobby.webSocketMessage(bia, JSON.stringify(null));

  // Bia mandou "ping" há 2 min e sumiu; Ana nunca mandou (versão antiga): fica.
  const biaId = bia.attachment.id;
  pings.set(bia, new Date(Date.now() - 120_000));
  pings.set(caio, new Date());
  await lobby.alarm();
  assert.equal(bia.closedWith, 4000);
  assert.deepEqual(last(ana), { type: 'peer-left', id: biaId });
  assert.equal(ana.closedWith, null);
  assert.equal(caio.closedWith, null);
  assert.ok(alarm > Date.now(), 'faxina continua enquanto há gente');

  // Fechar a conexão avisa quem fica, uma vez só.
  const before = caio.sent.length;
  const dani = await join('outra', 'Dani');
  lobby.webSocketClose(dani);
  lobby.webSocketError(dani);
  assert.equal(caio.sent.length - before, 2, 'peer-joined e um peer-left');
  assert.equal(last(caio).type, 'peer-left');
});

test('câmera: envio do tamanho em que cada um mostra, erros claros, só para versões novas', () => {
  // Câmera em 540p: monitor grande recebe tudo; monitor pequeno (360p) recebe menos.
  assert.deepEqual(cameraEncoding({ height: 540 }, 0), { scaleResolutionDownBy: 1, maxBitrate: CAMERA_BITRATE, maxFramerate: 30 });
  const small = cameraEncoding({ height: 540 }, 360);
  assert.equal(small.scaleResolutionDownBy, 1.5);
  assert.ok(small.maxBitrate < CAMERA_BITRATE && small.maxBitrate >= 250_000);
  assert.equal(cameraEncoding({ height: 540 }, 720).scaleResolutionDownBy, 1, 'nunca aumenta');
  assert.equal(cameraEncoding(undefined, 360).scaleResolutionDownBy, 1);

  assert.match(cameraErrorMessage({ name: 'NotAllowedError' }), /Privacidade/);
  assert.match(cameraErrorMessage({ name: 'NotReadableError' }), /outro programa/);
  assert.match(cameraErrorMessage({ name: 'NotFoundError' }), /Nenhuma câmera/);
  assert.match(cameraErrorMessage(new Error('falhou')), /falhou/);

  assert.equal(CAMERA_VERSION, '1.4.0');
  assert.equal(supportsCamera({ state: { version: '1.4.0' } }), true);
  assert.equal(supportsCamera({ state: { version: '1.10.2' } }), true);
  assert.equal(supportsCamera({ state: { version: '1.3.0' } }), false, 'a 1.3 misturaria câmera e tela');
  assert.equal(supportsCamera({ state: {} }), false);
  assert.equal(supportsCamera(undefined), false);
});

test('predefinições de qualidade e H.264 automático', () => {
  assert.equal(matchPreset(QUALITY_PRESETS.find((p) => p.id === 'game').settings), 'game');
  assert.equal(matchPreset({ resolution: '1080p', fps: 30, bitrate: 0, optimize: 'motion', codec: 'auto' }), 'movie');
  assert.equal(matchPreset({ resolution: '1080p', fps: 45, bitrate: 0, optimize: 'motion', codec: 'auto' }), null);
  // "Automático" é sempre H.264: quem assiste decodifica na placa de vídeo.
  assert.equal(resolveCodec('auto'), 'H264');
  assert.equal(resolveCodec('VP9'), 'VP9');
  assert.equal(resolveCodec('VP8'), 'VP8');
});

test('sugestão de um clique quando a internet ou o processador não dão conta', () => {
  const game = { resolution: '1080p', fps: 60, bitrate: 0, optimize: 'motion', codec: 'auto' };
  // Codec escolhido que pesa no processador + placa de vídeo disponível: sugere H.264.
  assert.equal(suggestLowerSettings({ ...game, codec: 'VP9' }, 'cpu', { hardwareH264: true }).settings.codec, 'H264');
  // "Automático" com placa de vídeo já é H.264: a próxima saída é baixar o FPS.
  assert.equal(suggestLowerSettings(game, 'cpu', { hardwareH264: true }).settings.fps, 30);
  const fps = suggestLowerSettings(game, 'bandwidth');
  assert.equal(fps.settings.fps, 30);
  assert.equal(fps.text, 'Baixar para 30 quadros/s');
  const res = suggestLowerSettings({ ...game, fps: 30 }, 'bandwidth');
  assert.equal(res.settings.resolution, '720p');
  assert.equal(res.text, 'Baixar para 720p');
  assert.equal(suggestLowerSettings({ ...game, resolution: 'native', fps: 30 }, 'cpu').settings.resolution, '1080p');
  assert.equal(suggestLowerSettings({ ...game, resolution: '720p', fps: 30 }, 'bandwidth').settings.bitrate, 2);
  assert.equal(suggestLowerSettings({ ...game, resolution: '480p', fps: 15, bitrate: 2 }, 'bandwidth'), null);
});

test('envio sob medida: a altura em que a tela aparece decide o tamanho enviado', () => {
  // Tela pequena (coluna do destaque, ~140 px) pede 360p; grade média, 540p/720p; grande ou tela cheia, a cheia.
  assert.equal(wantedHeight(140), 360);
  assert.equal(wantedHeight(400), 540);
  assert.equal(wantedHeight(600), 720);
  assert.equal(wantedHeight(700), 0);
  assert.equal(wantedHeight(Infinity), 0);
  assert.equal(wantedHeight(0), 0);
  assert.equal(scaleForHeight(1080, 360), 3);
  assert.equal(scaleForHeight(1080, 0), 1, 'sem pedido: imagem cheia');
  assert.equal(scaleForHeight(720, 1080), 1, 'nunca aumenta');
  const game = { resolution: '1080p', fps: 60, bitrate: 0, optimize: 'motion', codec: 'auto' };
  const track = { width: 1920, height: 1080 };
  const full = sendEncoding(game, track, 0);
  assert.deepEqual(full, { scaleResolutionDownBy: 1, maxBitrate: targetBitrate(game, track) });
  const small = sendEncoding(game, track, 360);
  assert.equal(small.scaleResolutionDownBy, 3);
  assert.ok(small.maxBitrate < full.maxBitrate / 4 && small.maxBitrate >= 600_000, 'bitrate proporcional à área, com um mínimo');
});

test('sem compressão na placa de vídeo, 60 fps vira 30 com 2 ou mais pessoas assistindo', () => {
  const game = { resolution: '1080p', fps: 60, bitrate: 0, optimize: 'motion', codec: 'auto' };
  assert.equal(effectiveFps(game, { hardware: false, viewers: 1 }), 60);
  assert.equal(effectiveFps(game, { hardware: false, viewers: 2 }), 30);
  assert.equal(effectiveFps(game, { hardware: true, viewers: 4 }), 60, 'na placa de vídeo, sem limite');
  assert.equal(effectiveFps({ ...game, codec: 'VP9' }, { hardware: true, viewers: 2 }), 30, 'VP9 é sempre no processador');
  assert.equal(effectiveFps({ ...game, fps: 30 }, { hardware: false, viewers: 5 }), 30);
});

test('multivisor: o arranjo que deixa cada imagem 16:9 maior', () => {
  assert.equal(bestColumns(1, 990, 790), 1);
  assert.equal(bestColumns(2, 990, 790), 1, 'palco alto: uma tela sobre a outra');
  assert.equal(bestColumns(2, 1880, 1000), 2, 'palco largo: lado a lado');
  assert.equal(bestColumns(3, 1880, 1000), 2);
  assert.equal(bestColumns(4, 1600, 900), 2);
  assert.equal(bestColumns(6, 1600, 700), 3);
  assert.equal(bestColumns(3, 0, 0), 1, 'palco ainda sem tamanho');
});

test('versões: quem está desatualizado na sala', () => {
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, 'compara como número, não como texto');
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(compareVersions(undefined, '1.3.0'), -1, 'sem versão = mais antiga');
  const peers = [{ id: 'a', version: '1.3.0' }, { id: 'b', version: '1.2.0' }, { id: 'c' }, { id: 'd', version: '1.4.0' }];
  assert.deepEqual([...outdatedPeers('1.3.0', peers, true)].sort(), ['b', 'c']);
  assert.equal(outdatedPeers('1.3.0', peers, false).size, 0, 'servidor antigo não repassa versões: não dá para saber');
});

test('sinal: ótimo, bom ou ruim', () => {
  assert.equal(levelFrom({ rtt: 0.03, loss: 0 }), 'good');
  assert.equal(levelFrom({ rtt: 0.2, loss: 0 }), 'ok');
  assert.equal(levelFrom({ rtt: 0.03, loss: 0.03 }), 'ok');
  assert.equal(levelFrom({ rtt: 0.03, loss: 0, limited: true }), 'ok');
  assert.equal(levelFrom({ rtt: 0.5, loss: 0 }), 'bad');
  assert.equal(levelFrom({ rtt: null, loss: null }), null);
  assert.equal(peerSignal({ recvVideo: { lossRate: 0.1 }, route: { rtt: 0.02 } }), 'bad');
  assert.equal(peerSignal({ sendVideo: { bitrate: 1e6, limitation: 'bandwidth' }, remoteVideo: { rtt: 0.02, fractionLost: 0 } }), 'ok');
  assert.equal(peerSignal({ route: { rtt: 0.02 } }), 'good');
  assert.equal(peerSignal(null), null);
});

test('o que limita a transmissão: processador, seu upload ou só a conexão de alguém', () => {
  assert.equal(limitReason([]), null);
  assert.equal(limitReason(['none', 'none']), null);
  assert.equal(limitReason(['none', 'cpu']), 'cpu', 'o processador é um só');
  assert.equal(limitReason(['bandwidth']), 'bandwidth');
  assert.equal(limitReason(['bandwidth', 'bandwidth']), 'bandwidth');
  assert.equal(limitReason(['bandwidth', 'none']), null, 'uma pessoa com conexão ruim não é culpa do seu upload');
  assert.equal(limitReason(['bandwidth', 'none', 'none']), null);
  assert.equal(limitReason(['bandwidth', 'bandwidth', 'none']), 'bandwidth', 'a maioria limitada aponta para o seu upload');
  assert.equal(limitReason(['bandwidth', 'bandwidth', 'none', 'none']), null);
  assert.equal(limitReason([undefined, 'bandwidth']), null, 'quem ainda não tem estatística conta como não limitado');
});

test('argumentos do auxiliar de som em cada modo', () => {
  const base = { sourceId: 'window:4242:0', exclude: ['Discord.exe'], selfExe: 'Telao.exe', pid: 99 };
  assert.deepEqual(helperArgs({ ...base, mode: 'all' }),
    ['--mode', 'all', '--exclude-pids', '99', '--exclude-names', 'Discord.exe,Telao.exe']);
  assert.deepEqual(helperArgs({ ...base, mode: 'app' }).slice(0, 2), ['--mode', 'app']);
  assert.deepEqual(helperArgs({ ...base, mode: 'app' }).slice(-2), ['--hwnd', '4242']);
  const pick = helperArgs({ ...base, mode: 'pick', include: ['Spotify', 'chrome.exe', 'spotify.exe'] });
  assert.deepEqual(pick.slice(0, 2), ['--mode', 'names']);
  assert.deepEqual(pick.slice(-2), ['--include-names', 'Spotify.exe,chrome.exe,spotify.exe']);
  assert.deepEqual(helperArgs({ ...base, mode: 'pick', include: [] }).slice(-2), ['--include-names', '-']);
  // Escolher um app excluído não o libera: a lista de excluídos continua valendo
  // (a interface mostra esses apps desativados, com "(excluído)").
  const pickExcluded = helperArgs({ ...base, mode: 'pick', include: ['Discord.exe'] });
  assert.deepEqual(pickExcluded.slice(4, 6), ['--exclude-names', 'Discord.exe,Telao.exe']);
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
  dark: ['#16171a', '#0e0f11', '#0f1013', '#08090a'],
  light: ['#f7f7f8', '#eceef1', '#e8eaee', '#dfe1e5'],
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
  assert.deepEqual(Theme.normalize(null), { theme: 'dark', accent: '#d92b26' });
  assert.deepEqual(Theme.normalize({ theme: 'azul', accent: 'xyz' }), { theme: 'dark', accent: '#d92b26' });
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
  assert.deepEqual(normalizeAppearance(null), { theme: 'dark', backgrounds: { dark: '#0e0f11', light: '#eceef1' } });
  assert.deepEqual(normalizeAppearance({ theme: 'roxo', backgrounds: { dark: 'red', light: '#ABCDEF' } }),
    { theme: 'dark', backgrounds: { dark: '#0e0f11', light: '#ABCDEF' } });
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
  // Os botões do Windows na barra de título integrada usam a cor da barra e do texto.
  const { titleBarOverlay, TITLE_BAR_HEIGHT } = require('../src/main/appearance.js');
  for (const [mode, css] of [['dark', root], ['light', light]]) {
    assert.deepEqual(titleBarOverlay(mode), { color: value(css, '--panel'), symbolColor: value(css, '--text'), height: TITLE_BAR_HEIGHT }, `barra de título (${mode})`);
  }
  assert.match(CSS, /\.room \{[^}]*grid-template-rows: 48px/, 'a barra superior tem a altura da barra de título');
});
