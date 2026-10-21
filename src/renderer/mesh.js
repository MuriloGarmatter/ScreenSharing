// Malha P2P: uma RTCPeerConnection com cada participante da sala.
// A sinalização passa pelo servidor; vídeo e áudio vão direto entre os PCs.
// Usa o padrão "perfect negotiation" para que qualquer lado possa
// (re)negociar a qualquer momento sem colisões.

import {
  AUDIO_BITRATE, mungeRemoteSdp, pickCodec, sendEncoding, startBitrateKbps, videoConstraints,
} from './media.js';

const CONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
// "ping" ao servidor: mantém a conexão viva e mostra ao servidor que ainda estou
// na sala (o da Cloudflare tira quem ficou mais de 90 s sem mandar).
const KEEPALIVE_MS = 30_000;
const ICE_RESTART_DELAYS_MS = [8000, 15000, 30000]; // conexão P2P que não sobe (o lado "polite" espera o dobro)
const REACTION_WINDOW_MS = 2000;
const REACTION_LIMIT = 8; // por pessoa, a cada 2 s
const FULL_VIEW = { video: true, audio: true, height: 0 };

export const REACTIONS = ['😂', '🔥', '👏', '😮', '❤️', '👍'];

const sameView = (a, b) => Boolean(a && b) && a.video === b.video && a.audio === b.audio && a.height === b.height;

export class Mesh extends EventTarget {
  #ws = null;
  #closed = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #keepaliveTimer = null;

  constructor({ url, room, name, password, version }) {
    super();
    this.url = url;
    this.room = room;
    this.name = name;
    this.password = password || '';
    this.version = version || '';
    this.id = null;
    this.iceServers = [];
    this.serverFeatures = []; // o que o servidor da sala sabe fazer (ex.: 'version')
    this.peers = new Map();
    this.share = null; // { stream, videoTrack, audioTrack, settings }
    this.state = { sharing: false, version: this.version };
    this.serverConnected = false;
  }

  /** Conecta ao servidor e entra na sala. Rejeita com uma mensagem amigável. */
  connect() {
    return this.#open();
  }

  leave() {
    this.#closed = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#keepaliveTimer);
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
    this.setState({ sharing: true, paused: false, audio: !!this.share.audioTrack, label: info?.label || '' });
  }

  /**
   * Pausa sem renegociar: faixa desligada = quadros pretos e silêncio para quem
   * assiste; o estado "pausado" avisa os outros para mostrarem um aviso.
   */
  setPaused(paused) {
    const share = this.share;
    if (!share) return;
    share.videoTrack.enabled = !paused;
    if (share.audioTrack) share.audioTrack.enabled = !paused;
    this.setState({ ...this.state, paused });
  }

  /**
   * O que eu quero receber de uma pessoa: { video, audio, height }. Parar de
   * assistir = sem vídeo e sem som; Telão escondido = só o som; height = a altura
   * em que mostro a tela dela (0 = cheia). Só manda se mudou; se o canal ainda
   * não abriu, manda quando abrir.
   */
  setView(peerId, view) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const next = { video: view.video !== false, audio: view.audio !== false, height: view.height || 0 };
    if (sameView(peer.wantedView, next)) return;
    peer.wantedView = next;
    this.#sendView(peer);
  }

  #sendView(peer) {
    if (peer.channel?.readyState === 'open' && peer.wantedView) {
      peer.channel.send(JSON.stringify({ type: 'view', ...peer.wantedView }));
    }
  }

  /** Envia uma reação a todos (o alvo é quem está transmitindo). */
  sendReaction(target, emoji) {
    if (!REACTIONS.includes(emoji)) return false;
    const message = JSON.stringify({ type: 'reaction', target, emoji });
    let sent = false;
    for (const peer of this.peers.values()) {
      if (peer.channel?.readyState === 'open') {
        peer.channel.send(message);
        sent = true;
      }
    }
    return sent;
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
    // A versão vai junto em todo estado (quem está desatualizado aparece na lista).
    this.state = { ...state, version: this.version };
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
        clearInterval(this.#keepaliveTimer);
        this.#keepaliveTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send('ping');
        }, KEEPALIVE_MS);
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; } // "pong" e outros textos soltos
        if (!msg || typeof msg !== 'object') return;
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
        if (this.#ws === ws) {
          this.#ws = null;
          clearInterval(this.#keepaliveTimer);
        }
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
    this.serverFeatures = Array.isArray(msg.features) ? msg.features : [];
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
      view: { ...FULL_VIEW }, // o que essa pessoa quer receber de mim
      wantedView: null, // o que eu quero receber dela (ver setView)
    };
    this.peers.set(id, peer);

    // Canal de dados negociado dos dois lados: estabelece a conexão P2P logo
    // ao entrar (a transmissão começa rápido) e leva as reações e o "o que eu
    // quero receber" de cada um.
    peer.channel = pc.createDataChannel('telao', { negotiated: true, id: 0 });
    peer.channel.onmessage = (event) => this.#onPeerMessage(peer, event.data);
    peer.channel.onopen = () => this.#sendView(peer);

    pc.onnegotiationneeded = async () => {
      // Na primeira negociação só o lado "impolite" oferece. Se os dois oferecessem
      // juntos, o "polite" teria de desfazer a dele (rollback), e o Chromium às vezes
      // para de juntar candidatos ICE depois disso: a conexão ficava em "new" para
      // sempre. Depois da resposta, se ainda faltar algo, o evento volta a disparar.
      if (peer.polite && !pc.remoteDescription) return;
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
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.watchdog);
      } else if (pc.connectionState === 'failed') {
        // Só um lado refaz o ICE na hora, para as duas ofertas não se cruzarem.
        if (!peer.polite) pc.restartIce();
        this.#watchConnection(peer, 0);
      }
      this.#emit('connection', { peer });
    };
    pc.onsignalingstatechange = () => {
      // Depois de cada negociação os parâmetros de envio podem ter sido refeitos.
      if (pc.signalingState === 'stable') this.#applySendParams(peer);
    };

    if (this.share) this.#attachShare(peer);
    this.#watchConnection(peer, 0);
    this.#emit('peer-joined', { peer, silent });
  }

  /**
   * Se a conexão com alguém não sobe, refaz o ICE (novos candidatos dos dois
   * lados). O lado "impolite" tenta primeiro; o "polite" espera o dobro, só para
   * o caso de o outro não conseguir, e assim as ofertas não se cruzam.
   */
  #watchConnection(peer, attempt) {
    clearTimeout(peer.watchdog);
    if (attempt >= ICE_RESTART_DELAYS_MS.length) return;
    const delay = ICE_RESTART_DELAYS_MS[attempt] * (peer.polite ? 2 : 1);
    peer.watchdog = setTimeout(() => {
      const { pc } = peer;
      if (this.#closed || this.peers.get(peer.id) !== peer || pc.connectionState === 'connected') return;
      pc.restartIce();
      this.#watchConnection(peer, attempt + 1);
    }, delay);
  }

  #onPeerMessage(peer, data) {
    if (typeof data !== 'string' || data.length > 1000) return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg?.type === 'view') this.#onView(peer, msg);
    else if (msg?.type === 'reaction') this.#onReaction(peer, msg);
  }

  /** A pessoa avisou o que quer receber de mim (parou de assistir, só o som, tela pequena). */
  #onView(peer, msg) {
    const height = Number(msg.height);
    const view = {
      video: msg.video !== false,
      audio: msg.audio !== false,
      height: Number.isInteger(height) && height > 0 && height <= 4320 ? height : 0,
    };
    if (sameView(peer.view, view)) return;
    peer.view = view;
    if (this.share) this.#applyView(peer);
    this.#emit('view', { peer });
  }

  #onReaction(peer, msg) {
    if (!REACTIONS.includes(msg.emoji)) return;
    if (typeof msg.target !== 'string' || msg.target.length > 64) return;
    const now = Date.now();
    peer.reactionTimes = (peer.reactionTimes || []).filter((t) => now - t < REACTION_WINDOW_MS);
    if (peer.reactionTimes.length >= REACTION_LIMIT) return;
    peer.reactionTimes.push(now);
    this.#emit('reaction', { from: peer, target: msg.target, emoji: msg.emoji });
  }

  #removePeer(id, silent) {
    const peer = this.peers.get(id);
    if (!peer) return;
    this.peers.delete(id);
    clearTimeout(peer.watchdog);
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
    // Para quem não quer (parou de assistir, ou só o som), o transceptor fica ativo
    // mas sem a faixa: nada é comprimido nem enviado, e voltar não exige renegociar.
    const sent = peer.view[kind] ? track : null;
    if (!tx) {
      tx = peer.pc.addTransceiver(sent || kind, {
        direction: 'sendonly',
        streams: [stream],
        sendEncodings: [this.#initialEncoding(kind, peer)],
      });
    } else {
      tx.sender.replaceTrack(sent).catch((err) => console.warn('replaceTrack falhou:', err));
      tx.sender.setStreams(stream);
      if (tx.direction !== 'sendonly') tx.direction = 'sendonly';
    }
    if (kind === 'video') this.#applyCodecPreferences(tx);
    return tx;
  }

  /** Aplica o que a pessoa quer receber: liga/desliga imagem e som e ajusta o tamanho. */
  #applyView(peer) {
    const share = this.share;
    for (const [tx, track, kind] of [[peer.videoTx, share.videoTrack, 'video'], [peer.audioTx, share.audioTrack, 'audio']]) {
      if (!tx || !track || tx.direction !== 'sendonly') continue;
      const sent = peer.view[kind] ? track : null;
      if (tx.sender.track === sent) continue;
      tx.sender.replaceTrack(sent)
        .then(() => this.#applySendParams(peer))
        .catch((err) => console.warn('replaceTrack falhou:', err));
    }
    this.#applySendParams(peer);
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

  #initialEncoding(kind, peer) {
    if (kind === 'audio') return { maxBitrate: AUDIO_BITRATE };
    const { settings, videoTrack } = this.share;
    return { ...sendEncoding(settings, videoTrack.getSettings(), peer.view.height), maxFramerate: settings.fps };
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
        // Tamanho e bitrate sob medida para a tela em que essa pessoa mostra a minha.
        Object.assign(encoding, sendEncoding(share.settings, share.videoTrack.getSettings(), peer.view.height));
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
          Object.assign(retry.encodings[0], {
            maxBitrate: encoding.maxBitrate,
            maxFramerate: encoding.maxFramerate,
            scaleResolutionDownBy: encoding.scaleResolutionDownBy,
          });
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
