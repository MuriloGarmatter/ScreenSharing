// Processador de áudio: reproduz, dentro do grafo do Web Audio, o PCM que chega
// de um app capturado. Um buffer pequeno absorve a irregularidade de chegada
// dos pacotes; se acumular demais, descarta o excesso para não criar atraso.

const PRIME_SECONDS = 0.04;
const MAX_SECONDS = 0.25;
const TARGET_SECONDS = 0.06;

class TelaoPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = Math.ceil(sampleRate);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.readIndex = 0;
    this.count = 0;
    this.primed = false;
    this.port.onmessage = (event) => this.push(event.data);
  }

  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.count === this.capacity) {
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.count -= 1;
      }
      const w = (this.readIndex + this.count) % this.capacity;
      this.left[w] = samples[2 * i] / 32768;
      this.right[w] = samples[2 * i + 1] / 32768;
      this.count += 1;
    }
    if (this.count > MAX_SECONDS * sampleRate) {
      const drop = this.count - Math.round(TARGET_SECONDS * sampleRate);
      this.readIndex = (this.readIndex + drop) % this.capacity;
      this.count -= drop;
    }
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    if (!this.primed) {
      if (this.count < PRIME_SECONDS * sampleRate) return true; // silêncio até juntar um pouco
      this.primed = true;
    }
    for (let i = 0; i < left.length; i++) {
      if (this.count > 0) {
        left[i] = this.left[this.readIndex];
        right[i] = this.right[this.readIndex];
        this.readIndex = (this.readIndex + 1) % this.capacity;
        this.count -= 1;
      } else {
        left[i] = 0;
        right[i] = 0;
      }
    }
    if (this.count === 0) this.primed = false;
    return true;
  }
}

registerProcessor('telao-pcm', TelaoPcm);
