// Fonte "PS5": recebe do telao-ps5.exe o vídeo H.264 (ainda comprimido) e o som (PCM),
// decodifica o vídeo na placa de vídeo (WebCodecs) e entrega uma MediaStream que vai
// para os amigos como qualquer tela.

const WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url);
const CONNECT_TIMEOUT_MS = 30_000;
const FIRST_FRAME_TIMEOUT_MS = 15_000;
const KEYFRAME_RETRY_MS = 1_000;
const MAX_DECODE_QUEUE = 30; // mais que isso atrasado: recomeça do próximo quadro completo

const active = new Set();

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function routePs5Video(session, id, payload) {
  for (const capture of active) capture.handleVideo(session, id, payload);
}

export function routePs5Audio(session, payload) {
  for (const capture of active) capture.handleAudio(session, payload);
}

export function routePs5Event(session, event) {
  for (const capture of active) capture.handleEvent(session, event);
}

// ---------- H.264 (Annex-B) ----------

/** Unidades NAL de um quadro Annex-B: [{ type, start, end }] (start: depois do start code). */
export function nalUnits(data) {
  const units = [];
  let i = 0;
  let start = -1;
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        let end = i;
        while (end > start && data[end - 1] === 0) end--; // zero antes do start code de 4 bytes
        units.push({ type: data[start] & 0x1f, start, end });
      }
      i += 3;
      start = i;
    } else {
      i++;
    }
  }
  if (start >= 0 && start < data.length) units.push({ type: data[start] & 0x1f, start, end: data.length });
  return units;
}

/** Quadro completo (IDR): dá para começar a decodificar a partir dele. */
export function isKeyframe(data) {
  return nalUnits(data).some((u) => u.type === 5);
}

/** "avc1.PPCCLL" a partir do SPS do quadro (perfil, restrições e nível), ou null. */
export function avcCodec(data) {
  const sps = nalUnits(data).find((u) => u.type === 7);
  if (!sps || sps.end - sps.start < 4) return null;
  const hex = (b) => b.toString(16).padStart(2, '0');
  return `avc1.${hex(data[sps.start + 1])}${hex(data[sps.start + 2])}${hex(data[sps.start + 3])}`;
}

/** Saída de vídeo: MediaStreamTrackGenerator (Chromium) ou, sem ele, um canvas. */
function createVideoSink() {
  if (typeof window.MediaStreamTrackGenerator === 'function') {
    const generator = new window.MediaStreamTrackGenerator({ kind: 'video' });
    const writer = generator.writable.getWriter();
    return {
      track: generator,
      write(frame) {
        // Fila cheia: descarta este quadro (o próximo já vem atrás), em vez de acumular atraso.
        if (writer.desiredSize !== null && writer.desiredSize <= 0) return frame.close();
        writer.write(frame).catch(() => {});
      },
      close() { writer.close().catch(() => {}); generator.stop(); },
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const track = canvas.captureStream().getVideoTracks()[0];
  return {
    track,
    write(frame) {
      if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      ctx.drawImage(frame, 0, 0);
      frame.close();
    },
    close() { track.stop(); },
  };
}

export class Ps5Capture extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.session = `ps5-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    this.decoder = null;
    this.codec = null;
    this.sink = null;
    this.audio = null; // { ctx, node, output }
    this.info = null; // evento "connected"
    this.stopped = false;
    this.lastKeyRequest = 0;
    this.frames = 0;
    this.waiters = null; // { connected, firstFrame } enquanto a conexão começa
  }

  /**
   * Conecta ao console pareado e devolve a MediaStream (vídeo e, se pedido, som).
   * onStatus recebe 'connecting' | 'waking' para a interface mostrar o andamento.
   */
  async start({ id, settings, audio, onStatus }) {
    active.add(this);
    this.onStatus = onStatus;
    this.sink = createVideoSink();
    const tracks = [this.sink.track];
    if (audio) tracks.push(await this.startAudio());

    // Os eventos podem chegar logo depois do processo abrir: as esperas já existem
    // antes, e os prazos só contam depois que o console acordou e a conexão começou.
    const connected = this.waitFor('connected');
    const firstFrame = this.waitFor('firstFrame');
    try {
      onStatus?.('connecting');
      const result = await this.api.ps5Start({ session: this.session, id, settings });
      if (result?.cancelled || this.stopped) throw new DOMException('Cancelado', 'AbortError');
      await withTimeout(connected, CONNECT_TIMEOUT_MS, 'O PS5 não respondeu a tempo.');
      await withTimeout(firstFrame, FIRST_FRAME_TIMEOUT_MS, 'A imagem do PS5 não chegou.');
    } catch (err) {
      this.stop();
      throw err;
    } finally {
      this.waiters = null;
    }
    return new MediaStream(tracks);
  }

  waitFor(name) {
    this.waiters ??= {};
    const promise = new Promise((resolve, reject) => { this.waiters[name] = { resolve, reject }; });
    promise.catch(() => {}); // quem espera trata; sem isso, a que não chegou a ser esperada vira erro solto
    return promise;
  }

  settle(name, value) {
    const waiter = this.waiters?.[name];
    if (!waiter) return;
    delete this.waiters[name];
    waiter.resolve(value);
  }

  failStart(err) {
    if (!this.waiters) return false;
    for (const waiter of Object.values(this.waiters)) waiter.reject(err);
    this.waiters = null;
    return true;
  }

  async startAudio() {
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(WORKLET_URL);
    const output = ctx.createMediaStreamDestination();
    output.channelCount = 2;
    const node = new AudioWorkletNode(ctx, 'telao-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    node.connect(output);
    await ctx.resume();
    this.audio = { ctx, node, output };
    const track = output.stream.getAudioTracks()[0];
    track.contentHint = 'music';
    return track;
  }

  // ---------- Vídeo ----------

  requestKeyframe() {
    const now = performance.now();
    if (now - this.lastKeyRequest < KEYFRAME_RETRY_MS) return;
    this.lastKeyRequest = now;
    this.api.ps5Keyframe(this.session);
  }

  resetDecoder() {
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
  }

  createDecoder(codec) {
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (err) => {
        console.warn(`Decodificador do PS5: ${err?.name}: ${err?.message}`);
        if (this.decoder === decoder) this.decoder = null;
        this.requestKeyframe();
      },
    });
    // Sem "hardwareAcceleration": o Chromium usa a placa de vídeo quando ela decodifica
    // H.264 e cai para o processador quando não ("prefer-hardware" falharia nesse caso).
    decoder.configure({ codec, optimizeForLatency: true });
    this.codec = codec;
    return decoder;
  }

  handleVideo(session, id, payload) {
    if (session !== this.session || this.stopped) return;
    const key = isKeyframe(payload);
    if (key) {
      const codec = avcCodec(payload) || this.codec;
      if (!codec) return this.requestKeyframe();
      if (!this.decoder || this.decoder.state === 'closed' || codec !== this.codec) {
        this.resetDecoder();
        try {
          this.decoder = this.createDecoder(codec);
        } catch (err) {
          this.fail(`A placa de vídeo não decodifica o vídeo do PS5 (${err.message}).`);
          return;
        }
      }
    } else if (!this.decoder) {
      return this.requestKeyframe(); // sem um quadro completo antes, não dá para começar
    }
    if (this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
      // O decodificador ficou para trás: recomeça do próximo quadro completo.
      this.resetDecoder();
      return this.requestKeyframe();
    }
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(performance.now() * 1000), data: payload }));
    } catch (err) {
      console.warn('Quadro do PS5 recusado:', err);
      this.resetDecoder();
      this.requestKeyframe();
    }
  }

  onFrame(frame) {
    if (this.stopped || !this.sink) return frame.close();
    this.frames += 1;
    if (this.frames === 1) this.settle('firstFrame', { width: frame.displayWidth, height: frame.displayHeight });
    this.sink.write(frame);
  }

  // ---------- Som e eventos ----------

  handleAudio(session, payload) {
    if (session !== this.session || this.stopped || !this.audio) return;
    const samples = payload.byteOffset % 2 === 0
      ? new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1)
      : new Int16Array(payload.slice().buffer);
    this.audio.node.port.postMessage(samples, [samples.buffer]);
  }

  handleEvent(session, event) {
    if (session !== this.session || this.stopped) return;
    switch (event.event) {
      case 'connecting':
      case 'waking':
        this.onStatus?.(event.event);
        break;
      case 'connected':
        this.info = event;
        this.settle('connected', event);
        break;
      case 'warning':
        this.dispatchEvent(new CustomEvent('warning', { detail: event.message }));
        break;
      case 'quit':
        // "STOPPED" é o próprio Telão parando o receptor (parar, ou trocar de transmissão).
        if (event.reason !== 'STOPPED') this.fail(event.message || 'O PS5 encerrou a conexão.');
        break;
      case 'error':
        if (event.fatal !== false) this.fail(event.message || 'O receptor do PS5 falhou.');
        else this.dispatchEvent(new CustomEvent('warning', { detail: event.message }));
        break;
      case 'exit':
        if (!event.expected) this.fail('A conexão com o PS5 caiu.');
        break;
      default:
        break;
    }
  }

  /** Erro: antes de conectar, faz o start() falhar; depois, avisa que a transmissão acabou. */
  fail(message) {
    if (this.failStart(new Error(message))) return;
    if (this.stopped) return;
    this.dispatchEvent(new CustomEvent('ended', { detail: message }));
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    active.delete(this);
    this.failStart(new DOMException('Cancelado', 'AbortError'));
    this.api.ps5Stop(this.session);
    this.resetDecoder();
    this.sink?.close();
    this.sink = null;
    if (this.audio) {
      this.audio.node.disconnect();
      this.audio.ctx.close().catch(() => {});
      this.audio = null;
    }
  }
}
