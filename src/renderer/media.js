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

export const OPTIMIZE = [
  { id: 'motion', label: 'Movimento (jogos, vídeos)' },
  { id: 'detail', label: 'Nitidez (texto, código)' },
];

export const CODECS = [
  { id: 'auto', label: 'Automático' },
  { id: 'H264', label: 'H.264 (usa a GPU se houver)' },
  { id: 'VP8', label: 'VP8' },
  { id: 'VP9', label: 'VP9 (mais qualidade, mais CPU)' },
  { id: 'AV1', label: 'AV1 (o mais pesado)' },
];

export const DEFAULT_SHARE_SETTINGS = { resolution: '1080p', fps: 30, bitrate: 0, optimize: 'motion', codec: 'auto' };

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
