// Leitura das estatísticas do WebRTC (resolução, FPS, bitrate, codec, rota, perdas)
// e o resumo em "sinal": ótimo, bom ou ruim.

export class StatsTracker {
  #prev = new Map();

  /** Variação de um contador desde a leitura anterior (por id + nome). */
  #delta(id, name, value, timestamp) {
    const key = `${id}:${name}`;
    const prev = this.#prev.get(key);
    this.#prev.set(key, { value, timestamp });
    if (!prev || timestamp <= prev.timestamp || value < prev.value) return null;
    return { amount: value - prev.value, seconds: (timestamp - prev.timestamp) / 1000 };
  }

  #rate(id, bytes, timestamp) {
    const d = this.#delta(id, 'bytes', bytes, timestamp);
    return d ? (d.amount * 8) / d.seconds : null;
  }

  async collect(pc, { remoteVideoTrackId } = {}) {
    const report = await pc.getStats();
    const all = new Map();
    report.forEach((s) => all.set(s.id, s));
    const codecOf = (s) => {
      const c = s.codecId && all.get(s.codecId);
      return c ? c.mimeType.split('/')[1] : null;
    };
    const result = { sendVideo: null, sendAudio: null, recvVideo: null, recvAudio: null, remoteVideo: null, route: null };

    for (const s of all.values()) {
      if (s.type === 'outbound-rtp') {
        const bitrate = this.#rate(s.id, s.bytesSent || 0, s.timestamp);
        if (s.kind === 'video') {
          const item = {
            width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, bitrate,
            codec: codecOf(s), implementation: s.encoderImplementation,
            hardware: s.powerEfficientEncoder, limitation: s.qualityLimitationReason,
          };
          if (!result.sendVideo || (bitrate || 0) > (result.sendVideo.bitrate || 0)) result.sendVideo = item;
        } else if (s.kind === 'audio') {
          if (!result.sendAudio || (bitrate || 0) > (result.sendAudio.bitrate || 0)) result.sendAudio = { bitrate, codec: codecOf(s) };
        }
      } else if (s.type === 'inbound-rtp') {
        const bitrate = this.#rate(s.id, s.bytesReceived || 0, s.timestamp);
        if (s.kind === 'video') {
          const lost = this.#delta(s.id, 'lost', s.packetsLost || 0, s.timestamp);
          const received = this.#delta(s.id, 'received', s.packetsReceived || 0, s.timestamp);
          const total = (lost?.amount || 0) + (received?.amount || 0);
          const item = {
            width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, bitrate,
            codec: codecOf(s), implementation: s.decoderImplementation,
            hardware: s.powerEfficientDecoder, lost: s.packetsLost || 0,
            lossRate: lost && received ? (total ? lost.amount / total : 0) : null,
          };
          if (!result.recvVideo || s.trackIdentifier === remoteVideoTrackId) result.recvVideo = item;
        } else if (s.kind === 'audio') {
          if (!result.recvAudio || (bitrate || 0) > (result.recvAudio.bitrate || 0)) result.recvAudio = { bitrate, codec: codecOf(s) };
        }
      } else if (s.type === 'remote-inbound-rtp' && s.kind === 'video') {
        // O que o outro lado relata sobre o vídeo que NÓS enviamos.
        result.remoteVideo = { fractionLost: s.fractionLost ?? null, rtt: s.roundTripTime ?? null };
      }
    }

    let pair = null;
    for (const s of all.values()) {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId) || pair;
    }
    if (!pair) {
      for (const s of all.values()) if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    }
    if (pair) {
      const local = all.get(pair.localCandidateId);
      const remote = all.get(pair.remoteCandidateId);
      result.route = {
        local: local?.candidateType,
        remote: remote?.candidateType,
        protocol: local?.protocol,
        rtt: pair.currentRoundTripTime,
      };
    }
    return result;
  }
}

export function describeRoute(route) {
  if (!route || !route.local) return null;
  if (route.local === 'relay' || route.remote === 'relay') {
    return { text: 'via TURN', kind: 'warn', title: 'Conexão retransmitida por um servidor TURN' };
  }
  if (route.local === 'host' && route.remote === 'host') {
    return { text: 'rede local', kind: 'ok', title: 'Conexão direta pela rede local' };
  }
  return { text: 'P2P direto', kind: 'ok', title: 'Conexão direta pela internet' };
}

export const SIGNAL_TEXT = { good: 'ótimo', ok: 'bom', bad: 'ruim' };

/** Nível pelo atraso (s) e pela perda de pacotes (0 a 1). */
export function levelFrom({ rtt = null, loss = null, limited = false }) {
  if (rtt === null && loss === null) return null;
  const r = rtt ?? 0;
  const l = loss ?? 0;
  if (l > 0.06 || r > 0.35) return 'bad';
  if (limited || l > 0.02 || r > 0.15) return 'ok';
  return 'good';
}

/**
 * Sinal da conexão com uma pessoa, do ponto de vista do que mais importa:
 * a tela que eu recebo dela, a tela que eu envio para ela, ou só o atraso.
 */
export function peerSignal(stats) {
  if (!stats) return null;
  if (stats.recvVideo?.lossRate != null) {
    return levelFrom({ rtt: stats.route?.rtt ?? null, loss: stats.recvVideo.lossRate });
  }
  if (stats.sendVideo?.bitrate) {
    return levelFrom({
      rtt: stats.remoteVideo?.rtt ?? stats.route?.rtt ?? null,
      loss: stats.remoteVideo?.fractionLost ?? null,
      limited: stats.sendVideo.limitation === 'bandwidth',
    });
  }
  return levelFrom({ rtt: stats.route?.rtt ?? null });
}

/**
 * O que limita a transmissão como um todo, a partir do motivo de cada envio
 * (qualityLimitationReason de cada pessoa): 'cpu', 'bandwidth' ou null.
 * O processador é um só, então um envio limitado por ele já basta. A banda é
 * estimada por pessoa: uma conexão ruim (o Wi-Fi de alguém) não é culpa do seu
 * upload, e o WebRTC já baixa só aquele envio. Por isso a banda só conta quando
 * todos os envios estão limitados (até 2 pessoas) ou a maioria (3 ou mais).
 */
export function limitReason(reasons) {
  if (reasons.includes('cpu')) return 'cpu';
  const limited = reasons.filter((r) => r === 'bandwidth').length;
  if (!limited) return null;
  const enough = reasons.length < 3 ? limited === reasons.length : limited > reasons.length / 2;
  return enough ? 'bandwidth' : null;
}

export function hardwareLabel(item) {
  if (item?.hardware === true) return 'GPU';
  if (item?.hardware === false) return 'CPU';
  return '';
}

export const LIMITATION_TEXT = {
  cpu: 'Limitado pelo processador (CPU)',
  bandwidth: 'Limitado pela internet (banda)',
  other: 'Limitado pelo navegador',
};
