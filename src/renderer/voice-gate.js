// Sensibilidade do microfone (como a do Discord): uma "porta" que só deixa a voz
// passar quando o som fica acima de um limite; abaixo dele vai silêncio, e o
// barulho de fundo não chega aos outros. Roda no processamento de áudio, então
// funciona mesmo com a janela do Telão escondida.
//
// Automática: o limite fica um pouco acima do ruído de fundo, que é medido o tempo
// todo (desce na hora com o silêncio e sobe devagar, para a fala não virar "ruído").
// Manual: o limite que a pessoa escolheu, em dB.

const AUTO_MARGIN_DB = 12; // quanto acima do ruído de fundo a voz precisa estar
const AUTO_MIN_DB = -65;
const AUTO_MAX_DB = -30;
const FLOOR_RISE_DB_PER_SECOND = 1;
const HOLD_SECONDS = 0.3; // segura aberto entre as palavras
const ATTACK_SECONDS = 0.005; // abre rápido (não corta o começo da palavra)
const RELEASE_SECONDS = 0.08; // fecha suave (sem estalo)
const REPORT_SECONDS = 0.05; // nível para a interface, 20 vezes por segundo

class VoiceGate extends AudioWorkletProcessor {
  constructor() {
    super();
    this.auto = true;
    this.manual = -50;
    // Começa alto: no primeiro instante de silêncio (entre duas palavras já basta)
    // ele desce até o ruído de verdade. Começar baixo deixaria o barulho passar até subir.
    this.floor = -40;
    this.gain = 0;
    this.hold = 0;
    this.sinceReport = 0;
    this.loudest = -100;
    this.port.onmessage = (event) => {
      const { auto, threshold } = event.data || {};
      if (typeof auto === 'boolean') this.auto = auto;
      if (Number.isFinite(threshold)) this.manual = threshold;
    };
  }

  threshold() {
    if (!this.auto) return this.manual;
    return Math.min(AUTO_MAX_DB, Math.max(AUTO_MIN_DB, this.floor + AUTO_MARGIN_DB));
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    const frames = output[0].length;
    const seconds = frames / sampleRate;
    let db = -100;
    if (input) {
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      db = 10 * Math.log10(sum / input.length + 1e-12);
    }
    // Ruído de fundo: desce na hora, sobe devagar.
    this.floor = db < this.floor ? db : Math.min(db, this.floor + FLOOR_RISE_DB_PER_SECOND * seconds);
    const threshold = this.threshold();
    this.hold = db >= threshold ? HOLD_SECONDS : Math.max(0, this.hold - seconds);
    const open = this.hold > 0;
    const target = open ? 1 : 0;
    const step = 1 / ((open ? ATTACK_SECONDS : RELEASE_SECONDS) * sampleRate);
    for (let i = 0; i < frames; i++) {
      this.gain += Math.max(-step, Math.min(step, target - this.gain));
      const sample = input ? input[i] * this.gain : 0;
      for (let c = 0; c < output.length; c++) output[c][i] = sample;
    }
    this.loudest = Math.max(this.loudest, db);
    this.sinceReport += seconds;
    if (this.sinceReport >= REPORT_SECONDS) {
      this.port.postMessage({ level: this.loudest, open, threshold });
      this.sinceReport = 0;
      this.loudest = -100;
    }
    return true;
  }
}

registerProcessor('telao-voice-gate', VoiceGate);
