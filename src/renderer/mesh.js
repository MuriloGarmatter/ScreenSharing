// Malha P2P: uma RTCPeerConnection com cada participante da sala.
// A sinalização passa pelo servidor; vídeo e áudio vão direto entre os PCs.
// Usa o padrão "perfect negotiation" para que qualquer lado possa
// (re)negociar a qualquer momento sem colisões.

import { AUDIO_BITRATE, mungeRemoteSdp, pickCodec, startBitrateKbps, targetBitrate, videoConstraints } from './media.js';

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

export class Mesh extends EventTarget {
  #ws = null;
  #closed = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;

  constructor({ url, room, name, password }) {
    super();
    this.url = url;
    this.room = room;
    this.name = name;
    this.password = password || '';
    this.id = null;
    this.iceServers = [];
    this.peers = new Map();
    this.share = null; // { stream, videoTrack, audioTrack, settings }
    this.state = { sharing: false };
    this.serverConnected = false;
  }

  /** Conecta ao servidor e entra na sala. Rejeita com uma mensagem amigável. */
  connect() {
    return this.#open();
  }

  leave() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    for (const id of [...this.peers.keys()]) this.#removePeer(id, true);
    const ws = this.#ws;
    this.#ws = null;
    if (ws) ws.close();
    this.share = null;
  }

  // ---------- Transmissão local ----------

  startShare(stream, settings, info) {
    const videoTrack = stream.getVideoTracks()[0];
    this.share = {
      stream,
      videoTrack,
      audioTrack: stream.getAudioTracks()[0] || null,
      settings: { ...settings },
    };
    videoTrack.contentHint = settings.optimize === 'detail' ? 'detail' : 'motion';
    for (const peer of this.peers.values()) this.#attachShare(peer);
    this.setState({ sharing: true, audio: !!this.share.audioTrack, label: info?.label || '' });
  }

  async updateShareSettings(settings) {
    const share = this.share;
    if (!share) return;
    const previous = share.settings;
    share.settings = { ...settings };
    share.videoTrack.contentHint = settings.optimize === 'detail' ? 'detail' : 'motion';
    if (previous.resolution !== settings.resolution || previous.fps !== settings.fps) {
      try {
        await share.videoTrack.applyConstraints(videoConstraints(settings));
      } catch (err) {
        console.warn('applyConstraints falhou:', err);
      }
    }
    if (this.share !== share) return;
    for (const peer of this.peers.values()) {
      if (previous.codec !== settings.codec && peer.videoTx) this.#applyCodecPreferences(peer.videoTx);
      this.#applySendParams(peer);
    }
  }

  stopShare() {
    if (!this.share) return;
    this.share = null;
    for (const peer of this.peers.values()) {
      for (const tx of [peer.videoTx, peer.audioTx]) this.#deactivate(tx);
    }
    this.setState({ sharing: false });
  }

  setState(state) {
    this.state = { ...state };
    this.#send({ type: 'state', state: this.state });
  }

  // ---------- Servidor de sinalização ----------

  #open() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      try {
        ws = new WebSocket(this.url);
      } catch {
        finish(new Error('Endereço de servidor inválido.'));
        return;
      }
      this.#ws = ws;
      const timer = setTimeout(() => {
        finish(new Error('O servidor não respondeu a tempo. Confira o endereço.'));
        ws.close();
      }, CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        this.#send({ type: 'join', room: this.room, name: this.name, password: this.password, state: this.state });
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.type === 'welcome') {
          this.#onWelcome(msg);
          finish();
        } else if (msg.type === 'error') {
          const err = new Error(msg.message || 'O servidor recusou a entrada.');
          err.fatal = true;
          finish(err);
        } else {
          this.#onMessage(msg);
        }
      };
      ws.onclose = () => {
        if (this.#ws === ws) this.#ws = null;
        if (!settled) {
          finish(new Error('Não foi possível conectar ao servidor. Confira o endereço e se ele está no ar.'));
        } else if (!this.#closed) {
          this.#onDisconnect();
        }
      };
    });
  }

  #onDisconnect() {
    this.serverConnected = false;
    this.#emit('server', { connected: false });
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.#reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.#reconnectAttempt += 1;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(async () => {
      if (this.#closed) return;
      try {
        await this.#open();
      } catch (err) {
        if (this.#closed) return;
        if (err.fatal) {
          this.#emit('fatal', { message: err.message });
        } else {
          this.#emit('reconnect-failed', { attempt: this.#reconnectAttempt });
          this.#scheduleReconnect();
        }
      }
    }, delay);
  }

  #send(msg) {
    if (this.#ws && this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(msg));
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #onWelcome(msg) {
    const reconnected = this.id !== null;
    // Ao reconectar recebemos um novo id: as conexões antigas são refeitas.
    for (const id of [...this.peers.keys()]) this.#removePeer(id, true);
    this.id = msg.id;
    this.iceServers = Array.isArray(msg.iceServers) ? msg.iceServers : [];
    this.serverConnected = true;
    this.#reconnectAttempt = 0;
    for (const p of msg.peers || []) this.#addPeer(p, reconnected);
    this.#emit('server', { connected: true, reconnected });
  }

  #onMessage(msg) {
    switch (msg.type) {
      case 'peer-joined':
        this.#addPeer(msg, false);
        break;
      case 'peer-left':
        this.#removePeer(msg.id, false);
        break;
      case 'peer-state': {
        const peer = this.peers.get(msg.id);
        if (peer) {
          peer.state = msg.state || {};
          this.#emit('peer-state', { peer });
        }
        break;
      }
      case 'signal': {
        const peer = this.peers.get(msg.from);
        if (peer && msg.data) {
          peer.queue = peer.queue
            .then(() => this.#handleSignal(peer, msg.data))
            .catch((err) => console.warn(`Sinalização com ${peer.name}:`, err));
        }
        break;
      }
      default:
        break;
    }
  }

  // ---------- Conexões P2P ----------

  #addPeer({ id, name, state }, silent) {
    if (!id || id === this.id || this.peers.has(id)) return;
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id,
      name: name || 'Anônimo',
      state: state || {},
      pc,
      polite: this.id < id,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      queue: Promise.resolve(),
      paramsQueue: Promise.resolve(),
      remoteStream: new MediaStream(),
      videoTx: null,
      audioTx: null,
      stats: null,
    };
    this.peers.set(id, peer);

    // Canal de dados negociado dos dois lados: estabelece a conexão P2P logo
    // ao entrar, então a transmissão começa rápido quando alguém compartilhar.
    pc.createDataChannel('telao', { negotiated: true, id: 0 });

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal(peer, { description: pc.localDescription });
      } catch (err) {
        console.warn('Falha ao criar oferta:', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signal(peer, { candidate });
    };
    pc.ontrack = ({ track }) => {
      if (!peer.remoteStream.getTrackById(track.id)) peer.remoteStream.addTrack(track);
      track.onmute = () => this.#emit('remote-media', { peer });
      track.onunmute = () => this.#emit('remote-media', { peer });
      this.#emit('remote-track', { peer, track });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      this.#emit('connection', { peer });
    };
    pc.onsignalingstatechange = () => {
      // Depois de cada negociação os parâmetros de envio podem ter sido refeitos.
      if (pc.signalingState === 'stable') this.#applySendParams(peer);
    };

    if (this.share) this.#attachShare(peer);
    this.#emit('peer-joined', { peer, silent });
  }

  #removePeer(id, silent) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    peer.pc.close();
    for (const track of peer.remoteStream.getTracks()) track.stop();
    this.#emit('peer-left', { peer, silent });
  }

  #signal(peer, data) {
    this.#send({ type: 'signal', to: peer.id, data });
  }

  async #handleSignal(peer, { description, candidate }) {
    const { pc } = peer;
    if (pc.signalingState === 'closed') return;
    if (description) {
      const readyForOffer = !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer);
      const collision = description.type === 'offer' && !readyForOffer;
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      peer.settingRemoteAnswer = description.type === 'answer';
      const startKbps = startBitrateKbps(this.share?.settings, this.share?.videoTrack.getSettings());
      try {
        await pc.setRemoteDescription({ type: description.type, sdp: mungeRemoteSdp(description.sdp, { startKbps }) });
      } finally {
        peer.settingRemoteAnswer = false;
      }
      if (description.type === 'offer') {
        await pc.setLocalDescription();
        this.#signal(peer, { description: pc.localDescription });
      }
    } else if (candidate) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        if (!peer.ignoreOffer) throw err;
      }
    }
  }

  // ---------- Envio da transmissão para um participante ----------

  #attachShare(peer) {
    const share = this.share;
    peer.videoTx = this.#setSendTrack(peer, peer.videoTx, share.videoTrack, share.stream, 'video');
    peer.audioTx = this.#setSendTrack(peer, peer.audioTx, share.audioTrack, share.stream, 'audio');
    this.#applySendParams(peer);
  }

  #setSendTrack(peer, tx, track, stream, kind) {
    if (!track) {
      this.#deactivate(tx);
      return tx;
    }
    if (!tx) {
      tx = peer.pc.addTransceiver(track, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [this.#initialEncoding(kind)],
      });
    } else {
      tx.sender.replaceTrack(track).catch((err) => console.warn('replaceTrack falhou:', err));
      tx.sender.setStreams(stream);
      if (tx.direction !== 'sendonly') tx.direction = 'sendonly';
    }
    if (kind === 'video') this.#applyCodecPreferences(tx);
    return tx;
  }

  #deactivate(tx) {
    if (!tx) return;
    try {
      tx.sender.replaceTrack(null).catch(() => {});
      if (tx.direction !== 'inactive') tx.direction = 'inactive';
    } catch {
      // Conexão já fechada.
    }
  }

  #initialEncoding(kind) {
    if (kind === 'audio') return { maxBitrate: AUDIO_BITRATE };
    const { settings, videoTrack } = this.share;
    return { maxBitrate: targetBitrate(settings, videoTrack.getSettings()), maxFramerate: settings.fps };
  }

  #applyCodecPreferences(tx) {
    if (typeof tx.setCodecPreferences !== 'function' || !this.share) return;
    const preference = this.share.settings.codec;
    try {
      if (preference === 'auto') {
        tx.setCodecPreferences([]);
        return;
      }
      const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs || [];
      const mime = `video/${preference}`.toLowerCase();
      const preferred = codecs.filter((c) => c.mimeType.toLowerCase() === mime);
      if (!preferred.length) return;
      tx.setCodecPreferences([...preferred, ...codecs.filter((c) => c.mimeType.toLowerCase() !== mime)]);
    } catch (err) {
      console.warn('setCodecPreferences falhou:', err);
    }
  }

  #applySendParams(peer) {
    peer.paramsQueue = peer.paramsQueue
      .then(() => this.#doApplySendParams(peer))
      .catch((err) => console.warn('setParameters falhou:', err));
    return peer.paramsQueue;
  }

  async #doApplySendParams(peer) {
    const share = this.share;
    // Durante uma negociação os parâmetros mudam por baixo e setParameters
    // falharia; eles são reaplicados quando a negociação termina ("stable").
    // Antes da primeira negociação valem os sendEncodings do addTransceiver.
    if (!share || peer.pc.signalingState !== 'stable') return;

    const video = peer.videoTx?.currentDirection ? peer.videoTx.sender : null;
    if (video?.track) {
      const params = video.getParameters();
      if (params.encodings?.length) {
        const encoding = params.encodings[0];
        encoding.maxBitrate = targetBitrate(share.settings, share.videoTrack.getSettings());
        encoding.maxFramerate = share.settings.fps;
        const codec = pickCodec(params.codecs, share.settings.codec);
        if (codec) encoding.codec = codec;
        else delete encoding.codec;
        try {
          await video.setParameters(params);
        } catch (err) {
          if (!codec) throw err;
          // Versões do Chromium sem troca de codec por encoding: aplica o resto.
          const retry = video.getParameters();
          Object.assign(retry.encodings[0], { maxBitrate: encoding.maxBitrate, maxFramerate: encoding.maxFramerate });
          delete retry.encodings[0].codec;
          await video.setParameters(retry);
        }
      }
    }

    const audio = peer.audioTx?.currentDirection ? peer.audioTx.sender : null;
    if (audio?.track) {
      const params = audio.getParameters();
      if (params.encodings?.length) {
        params.encodings[0].maxBitrate = AUDIO_BITRATE;
        await audio.setParameters(params);
      }
    }
  }
}
