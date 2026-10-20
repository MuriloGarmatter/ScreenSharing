// Leitura das estatísticas do WebRTC (resolução, FPS, bitrate, codec, rota).

export class StatsTracker {
  #prev = new Map();

  #rate(id, bytes, timestamp) {
    const prev = this.#prev.get(id);
    this.#prev.set(id, { bytes, timestamp });
    if (!prev || timestamp <= prev.timestamp || bytes < prev.bytes) return null;
    return ((bytes - prev.bytes) * 8) / ((timestamp - prev.timestamp) / 1000);
  }

  async collect(pc, { remoteVideoTrackId } = {}) {
    const report = await pc.getStats();
    const all = new Map();
    report.forEach((s) => all.set(s.id, s));
    const codecOf = (s) => {
      const c = s.codecId && all.get(s.codecId);
      return c ? c.mimeType.split('/')[1] : null;
    };
    const result = { sendVideo: null, sendAudio: null, recvVideo: null, recvAudio: null, route: null };

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
          const item = {
            width: s.frameWidth, height: s.frameHeight, fps: s.framesPerSecond, bitrate,
            codec: codecOf(s), implementation: s.decoderImplementation,
            hardware: s.powerEfficientDecoder, lost: s.packetsLost || 0,
          };
          if (!result.recvVideo || s.trackIdentifier === remoteVideoTrackId) result.recvVideo = item;
        } else if (s.kind === 'audio') {
          if (!result.recvAudio || (bitrate || 0) > (result.recvAudio.bitrate || 0)) result.recvAudio = { bitrate, codec: codecOf(s) };
        }
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
