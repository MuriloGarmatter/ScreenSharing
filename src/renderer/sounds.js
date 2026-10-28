// Sons curtos de aviso, gerados na hora (sem arquivos de áudio).
// O som do próprio Telão não entra na transmissão: o app é excluído da captura.

const TONES = {
  start: [[660, 0], [880, 0.09]], // começou a transmitir (sobe)
  stop: [[880, 0], [587, 0.09]], // parou (desce)
  pause: [[740, 0], [740, 0.12]], // pausou / retomou
  stream: [[523, 0], [659, 0.08], [784, 0.16]], // alguém começou a transmitir
  join: [[587, 0], [784, 0.08]], // alguém entrou
  'mic-on': [[494, 0], [740, 0.07]], // microfone ligado (sobe)
  'mic-off': [[740, 0], [494, 0.07]], // microfone desligado (desce)
  'deafen-on': [[392, 0], [262, 0.08]], // vozes silenciadas (desce, mais grave)
  'deafen-off': [[262, 0], [392, 0.08]], // voltou a ouvir (sobe, mais grave)
  error: [[311, 0], [311, 0.14]], // não deu (dois toques graves)
};

let context = null;

/** No navegador (iPhone), o som só sai se for "acordado" num toque: chame dentro de um. */
export function primeSounds() {
  try {
    context ||= new AudioContext();
    if (context.state !== 'running') context.resume().catch(() => {});
  } catch { /* sem saída de áudio */ }
}

export function playSound(kind) {
  const notes = TONES[kind];
  if (!notes) return;
  try {
    context ||= new AudioContext();
    if (context.state === 'suspended') context.resume().catch(() => {});
    const now = context.currentTime + 0.01;
    for (const [frequency, offset] of notes) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.07, now + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.16);
      osc.connect(gain).connect(context.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.18);
    }
  } catch {
    // Sem saída de áudio: segue sem som.
  }
}
