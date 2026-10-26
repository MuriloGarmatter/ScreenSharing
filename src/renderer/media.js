// Opções de qualidade e ajustes de mídia da transmissão.

export const RESOLUTIONS = [
  { id: '480p', label: '480p', width: 854, height: 480 },
  { id: '720p', label: '720p (HD)', width: 1280, height: 720 },
  { id: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080 },
  { id: '1440p', label: '1440p (2K)', width: 2560, height: 1440 },
  { id: 'native', label: 'Nativa (sem reduzir)', width: null, height: null },
];

export const FRAME_RATES = [5, 10, 15, 24, 30, 45, 60];

// 0 = automático (calculado pela resolução e FPS). Valores em Mb/s.
export const BITRATES = [0, 1, 2, 3, 5, 8, 12, 16, 25, 40];

// Rótulos curtos: o seletor fica numa coluna estreita do painel.
export const OPTIMIZE = [
  { id: 'motion', label: 'Movimento' },
  { id: 'detail', label: 'Nitidez' },
];

export const CODECS = [
  { id: 'auto', label: 'Automático' },
  { id: 'H264', label: 'H.264 (usa a GPU se houver)' },
  { id: 'VP8', label: 'VP8' },
  { id: 'VP9', label: 'VP9 (mais qualidade, mais CPU)' },
  { id: 'AV1', label: 'AV1 (o mais pesado)' },
];

export const DEFAULT_SHARE_SETTINGS = { resolution: '1080p', fps: 30, bitrate: 0, optimize: 'motion', codec: 'auto' };

// Predefinições: um clique em vez de cinco menus.
export const QUALITY_PRESETS = [
  { id: 'game', label: 'Jogo', use: 'Jogos e tudo que mexe rápido', settings: { resolution: '1080p', fps: 60, bitrate: 0, optimize: 'motion', codec: 'auto' } },
  { id: 'movie', label: 'Filme', use: 'YouTube e vídeos (é o padrão)', settings: { resolution: '1080p', fps: 30, bitrate: 0, optimize: 'motion', codec: 'auto' } },
  { id: 'text', label: 'Texto', use: 'Código, planilhas, textos', settings: { resolution: 'native', fps: 15, bitrate: 0, optimize: 'detail', codec: 'auto' } },
  { id: 'slow', label: 'Internet fraca', use: 'Quando a internet não ajuda', settings: { resolution: '720p', fps: 30, bitrate: 3, optimize: 'motion', codec: 'auto' } },
];

/** Resumo técnico de uma predefinição, como aparece na tecla: "1080p · 60 fps". */
export function presetSpec(settings) {
  const res = settings.resolution === 'native' ? 'Nativa' : settings.resolution;
  return `${res} · ${settings.fps} fps${settings.bitrate ? ` · ${settings.bitrate} Mb/s` : ''}`;
}

/** Id da predefinição que corresponde aos ajustes, ou null ("personalizado"). */
export function matchPreset(settings) {
  const keys = ['resolution', 'fps', 'bitrate', 'optimize', 'codec'];
  const found = QUALITY_PRESETS.find((p) => keys.every((k) => String(p.settings[k]) === String(settings[k])));
  return found ? found.id : null;
}

/**
 * Descobre se a placa de vídeo comprime H.264 para WebRTC (codificação por
 * hardware: quase não pesa no processador). Na dúvida, responde false.
 */
export async function detectHardwareH264() {
  try {
    if (!navigator.mediaCapabilities?.encodingInfo) return false;
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: { contentType: 'video/H264', width: 1920, height: 1080, bitrate: 6_000_000, framerate: 30 },
    });
    return Boolean(info.supported && info.powerEfficient);
  } catch {
    return false;
  }
}

/**
 * "Automático" é H.264. Quem assiste decodifica H.264 na placa de vídeo
 * (praticamente todo PC faz isso; VP8 seria decodificado no processador, e
 * cada transmissão assistida pesaria), e quem transmite codifica na placa
 * quando ela tem codificador. Sem codificador, o H.264 por software pesa
 * o mesmo que o VP8.
 */
export function resolveCodec(codec) {
  return codec === 'auto' ? 'H264' : codec;
}

const RESOLUTION_STEPS = ['480p', '720p', '1080p', '1440p', 'native'];

/**
 * Sugere ajustes mais leves quando a transmissão está limitada pela internet
 * ('bandwidth') ou pelo processador ('cpu'). Devolve { settings, text } ou null.
 */
export function suggestLowerSettings(settings, reason, { hardwareH264 = false } = {}) {
  const next = { ...settings };
  if (reason === 'cpu' && hardwareH264 && resolveCodec(settings.codec) !== 'H264') {
    next.codec = 'H264';
    return { settings: next, text: 'Usar a placa de vídeo (H.264)' };
  }
  if (next.fps > 30) {
    next.fps = 30;
    return { settings: next, text: 'Baixar para 30 quadros/s' };
  }
  const step = RESOLUTION_STEPS.indexOf(next.resolution);
  if (step > 1) {
    next.resolution = RESOLUTION_STEPS[Math.min(step - 1, 2)]; // nativa/1440p → 1080p, 1080p → 720p
    return { settings: next, text: `Baixar para ${findResolution(next.resolution).id}` };
  }
  if (reason === 'bandwidth' && (next.bitrate === 0 || next.bitrate > 2)) {
    next.bitrate = 2;
    return { settings: next, text: 'Limitar a 2 Mb/s' };
  }
  if (next.fps > 15) {
    next.fps = 15;
    return { settings: next, text: 'Baixar para 15 quadros/s' };
  }
  return null;
}

// Som do computador: estéreo, sem filtros de voz (que estragam música e jogos).
export const AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
};
export const AUDIO_BITRATE = 160_000;

const MAX_AUTO_BITRATE = 30_000_000;
const MIN_AUTO_BITRATE = 800_000;

export function findResolution(id) {
  return RESOLUTIONS.find((r) => r.id === id) || RESOLUTIONS[2];
}

/** Restrições de captura (resolução máxima mantendo a proporção + FPS). */
export function videoConstraints(settings) {
  const res = findResolution(settings.resolution);
  const constraints = { frameRate: { ideal: settings.fps, max: settings.fps } };
  if (res.width) {
    constraints.width = { max: res.width };
    constraints.height = { max: res.height };
  }
  return constraints;
}

/** Bitrate de vídeo (bps) por pessoa assistindo. */
export function targetBitrate(settings, trackSettings) {
  if (settings.bitrate) return settings.bitrate * 1_000_000;
  const res = findResolution(settings.resolution);
  const width = res.width || trackSettings?.width || 1920;
  const height = res.height || trackSettings?.height || 1080;
  const bitsPerPixel = settings.optimize === 'detail' ? 0.08 : 0.1;
  const bps = width * height * settings.fps * bitsPerPixel;
  return Math.round(Math.min(Math.max(bps, MIN_AUTO_BITRATE), MAX_AUTO_BITRATE));
}

// ---------- Envio sob medida para cada pessoa ----------

/** Alturas que quem assiste pode pedir (0 = resolução cheia). */
export const VIEW_HEIGHTS = [360, 540, 720];
const MIN_SCALED_BITRATE = 600_000;

/**
 * Altura que vale pedir para uma tela mostrada com `shown` pixels de altura
 * (já multiplicados pela escala do Windows). Com folga de 15%; 0 = cheia.
 */
export function wantedHeight(shown) {
  if (!Number.isFinite(shown) || shown <= 0) return 0;
  return VIEW_HEIGHTS.find((h) => h >= shown * 1.15) || 0;
}

/** Quanto reduzir uma imagem de `height` linhas para quem pediu `wanted` (0 = cheia). */
export function scaleForHeight(height, wanted) {
  if (!wanted || !height || wanted >= height) return 1;
  return Math.round((height / wanted) * 100) / 100;
}

/**
 * Parâmetros do envio para uma pessoa: imagem reduzida ao tamanho em que ela
 * mostra a tela e bitrate proporcional à área (menos trabalho para os dois PCs).
 */
export function sendEncoding(settings, trackSettings, wanted) {
  const scale = scaleForHeight(trackSettings?.height, wanted);
  const full = targetBitrate(settings, trackSettings);
  const maxBitrate = scale > 1 ? Math.min(full, Math.max(MIN_SCALED_BITRATE, Math.round(full / (scale * scale)))) : full;
  return { scaleResolutionDownBy: scale, maxBitrate };
}

// ---------- Câmera ----------
// Até 540p a 30 fps: rosto não precisa de mais, e cada pessoa assistindo é uma
// compressão a mais no PC de quem liga a câmera.

export const CAMERA_CONSTRAINTS = {
  width: { ideal: 960 },
  height: { ideal: 540 },
  frameRate: { ideal: 30, max: 30 },
};
export const CAMERA_BITRATE = 900_000;
const MIN_CAMERA_BITRATE = 250_000;

/** Envio da câmera para uma pessoa: do tamanho em que ela mostra a câmera. */
export function cameraEncoding(trackSettings, wanted) {
  const scale = scaleForHeight(trackSettings?.height, wanted);
  return {
    scaleResolutionDownBy: scale,
    maxBitrate: Math.max(MIN_CAMERA_BITRATE, Math.round(CAMERA_BITRATE / (scale * scale))),
    maxFramerate: 30,
  };
}

/** Mensagem amigável para os erros ao abrir a câmera. */
export function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'O Windows bloqueou a câmera. Em Configurações → Privacidade e segurança → Câmera, ligue "Permitir que aplicativos da área de trabalho acessem a câmera".';
    case 'NotReadableError':
    case 'AbortError':
      return 'A câmera está sendo usada por outro programa (Discord, OBS, navegador…). Feche-o e tente de novo.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Nenhuma câmera encontrada. Confira se ela está conectada.';
    default:
      return `Não foi possível abrir a câmera: ${err?.message || err}`;
  }
}

/**
 * FPS que vale de verdade. Sem compressão na placa de vídeo, cada pessoa assistindo
 * é uma compressão inteira no processador: com 2 ou mais, 60 fps trava o PC, e
 * a transmissão fica em 30 fps enquanto for assim.
 */
export function effectiveFps(settings, { hardware = false, viewers = 0 } = {}) {
  const onGpu = hardware && resolveCodec(settings.codec) === 'H264';
  return !onGpu && viewers >= 2 && settings.fps > 30 ? 30 : settings.fps;
}

/** Escolhe, entre os codecs negociados, o que corresponde à preferência. */
export function pickCodec(codecs, preference) {
  if (!preference || preference === 'auto' || !Array.isArray(codecs)) return null;
  const mime = `video/${preference}`.toLowerCase();
  const matches = codecs.filter((c) => c.mimeType.toLowerCase() === mime);
  if (preference === 'H264') {
    // Perfil "constrained baseline" com packetization-mode=1: o que encoders de GPU suportam melhor.
    return matches.find((c) => /packetization-mode=1/.test(c.sdpFmtpLine || '') && /profile-level-id=42e0/i.test(c.sdpFmtpLine || ''))
      || matches.find((c) => /packetization-mode=1/.test(c.sdpFmtpLine || ''))
      || matches[0] || null;
  }
  return matches[0] || null;
}

/** Bitrate inicial (kb/s) da estimativa de banda ao começar a enviar vídeo. */
export function startBitrateKbps(settings, trackSettings) {
  if (!settings) return 2500;
  return Math.min(Math.round(targetBitrate(settings, trackSettings) / 1000), 4000);
}

function parseFmtp(text) {
  const params = new Map();
  for (const part of text.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('=');
    params.set(i < 0 ? p : p.slice(0, i), i < 0 ? '' : p.slice(i + 1));
  }
  return params;
}

function formatFmtp(pt, params) {
  return `a=fmtp:${pt} ${[...params].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';')}`;
}

/**
 * Ajusta a descrição SDP recebida do outro lado. Ela define como NÓS enviamos:
 *  - Opus em estéreo e com bitrate alto (o padrão do WebRTC é mono ~32 kb/s, pensado para voz);
 *  - estimativa de banda inicial realista para o vídeo. O padrão (~300 kb/s) faz a
 *    transmissão começar em 320×180 e, com a tela parada, demorar a melhorar.
 */
export function mungeRemoteSdp(sdp, { startKbps = 2500 } = {}) {
  const lines = sdp.split('\r\n');
  const opus = new Set();
  const video = new Set();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) ([\w-]+)\/(\d+)/i.exec(line);
    if (!m) continue;
    const codec = m[2].toUpperCase();
    if (codec === 'OPUS') opus.add(m[1]);
    else if (['VP8', 'VP9', 'H264', 'H265', 'AV1'].includes(codec)) video.add(m[1]);
  }
  const withFmtp = new Set();
  const out = lines.map((line) => {
    const m = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (!m) return line;
    const pt = m[1];
    if (opus.has(pt)) {
      const params = parseFmtp(m[2]);
      params.set('stereo', '1');
      params.set('sprop-stereo', '1');
      params.set('maxaveragebitrate', String(AUDIO_BITRATE));
      return formatFmtp(pt, params);
    }
    if (video.has(pt)) {
      withFmtp.add(pt);
      const params = parseFmtp(m[2]);
      params.set('x-google-start-bitrate', String(startKbps));
      return formatFmtp(pt, params);
    }
    return line;
  });
  // Codecs sem linha a=fmtp (o VP8 costuma não ter): cria uma logo após o a=rtpmap.
  const result = [];
  for (const line of out) {
    result.push(line);
    const m = /^a=rtpmap:(\d+) /.exec(line);
    if (m && video.has(m[1]) && !withFmtp.has(m[1])) {
      result.push(`a=fmtp:${m[1]} x-google-start-bitrate=${startKbps}`);
    }
  }
  return result.join('\r\n');
}
