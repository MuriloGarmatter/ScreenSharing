// Som por aplicativo: recebe o PCM de cada app capturado pelo telao-audio.exe,
// mistura tudo no Web Audio e entrega uma faixa de áudio pronta para o WebRTC.

const WORKLET_URL = new URL('./pcm-worklet.js', import.meta.url);
const active = new Set();

export function routeAppAudioData(session, id, payload) {
  for (const capture of active) capture.handleData(session, id, payload);
}

export function routeAppAudioEvent(session, event) {
  for (const capture of active) capture.handleEvent(session, event);
}

export function exeLabel(name) {
  return String(name || '').replace(/\.exe$/i, '');
}

export class AppAudioCapture extends EventTarget {
  constructor(api) {
    super();
    this.api = api;
    this.session = `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
    this.ctx = null;
    this.output = null;
    this.nodes = new Map(); // id da fonte -> AudioWorkletNode
    this.sources = new Map(); // id da fonte -> nome do .exe
    this.excluded = new Map(); // pid -> nome do .exe
    this.stopped = false;
  }

  /** Inicia a captura e devolve a faixa de áudio (estéreo, 48 kHz). */
  async start({ mode, sourceId, exclude, include }) {
    active.add(this);
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule(WORKLET_URL);
    this.output = ctx.createMediaStreamDestination();
    this.output.channelCount = 2;
    await ctx.resume();
    await this.api.startAppAudio({ session: this.session, mode, sourceId, exclude, include });
    const track = this.output.stream.getAudioTracks()[0];
    track.contentHint = 'music';
    return track;
  }

  handleData(session, id, payload) {
    if (session !== this.session || !this.ctx || this.stopped) return;
    let node = this.nodes.get(id);
    if (!node) {
      node = new AudioWorkletNode(this.ctx, 'telao-pcm', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      node.connect(this.output);
      this.nodes.set(id, node);
    }
    const samples = payload.byteOffset % 2 === 0
      ? new Int16Array(payload.buffer, payload.byteOffset, payload.byteLength >> 1)
      : new Int16Array(payload.slice().buffer);
    node.port.postMessage(samples, [samples.buffer]);
  }

  handleEvent(session, event) {
    if (session !== this.session || this.stopped) return;
    switch (event.event) {
      case 'source':
        this.sources.set(event.id, event.name);
        break;
      case 'source-end': {
        this.sources.delete(event.id);
        const node = this.nodes.get(event.id);
        if (node) node.disconnect();
        this.nodes.delete(event.id);
        break;
      }
      case 'excluded':
        this.excluded.set(event.pid, event.name);
        // Ficou de fora por ter aberto o Telão (o convite foi clicado nele, e o som
        // dele levaria o Telão junto): explica como incluir. O Windows (explorer)
        // também "abre" o Telão, mas não toca som de verdade.
        if (event.reason === 'abriu o Telão' && !/^(explorer|svchost|sihost|runtimebroker)\.exe$/i.test(event.name)) {
          this.dispatchEvent(new CustomEvent('warning', {
            detail: `O som do ${exeLabel(event.name)} fica fora da transmissão porque o Telão foi aberto por ele (pelo convite). Para incluir, feche o Telão e abra de novo pelo menu Iniciar.`,
          }));
        }
        break;
      case 'warning':
        this.dispatchEvent(new CustomEvent('warning', { detail: event.message }));
        break;
      case 'error':
        this.dispatchEvent(new CustomEvent('failure', { detail: event.message }));
        break;
      case 'exit':
        if (!event.expected) {
          this.dispatchEvent(new CustomEvent('failure', { detail: 'A captura de som dos apps parou inesperadamente.' }));
        }
        break;
      default:
        break;
    }
    this.dispatchEvent(new Event('change'));
  }

  /** Nomes (sem .exe) dos apps capturados e dos excluídos, sem repetição e sem os ocultos. */
  summary(hidden = []) {
    const skip = new Set(hidden.filter(Boolean).map((n) => exeLabel(n).toLowerCase()));
    const unique = (names) => [...new Set([...names].map(exeLabel))].filter((n) => !skip.has(n.toLowerCase()));
    return { capturing: unique(this.sources.values()), excluded: unique(this.excluded.values()) };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    active.delete(this);
    this.api.stopAppAudio(this.session);
    for (const node of this.nodes.values()) node.disconnect();
    this.nodes.clear();
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}

/** Medidor do nível do som que está sendo transmitido. */
export class LevelMeter {
  constructor(track) {
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.ctx.createMediaStreamSource(new MediaStream([track])).connect(this.analyser);
    this.data = new Float32Array(this.analyser.fftSize);
  }

  /** Nível de 0 a 1 (escala de -60 dB a 0 dB). */
  level() {
    this.analyser.getFloatTimeDomainData(this.data);
    let sum = 0;
    for (const x of this.data) sum += x * x;
    const rms = Math.sqrt(sum / this.data.length);
    if (rms <= 0) return 0;
    return Math.min(1, Math.max(0, (20 * Math.log10(rms) + 60) / 60));
  }

  close() {
    this.ctx.close().catch(() => {});
  }
}
