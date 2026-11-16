'use strict';

// Receptor de PS5 FALSO, para os testes: segue o mesmo protocolo do telao-ps5.exe
// (native/ps5/PROTOCOL.md), mas em vez de falar com um console entrega o vídeo de
// ps5-sample.h264 (640x360, 30 fps, em laço) e um tom de 440 Hz.
// Variáveis: FAKE_PS5_STATE=standby (começa em repouso; "wake" acorda),
// FAKE_PS5_QUIT_AFTER_MS (a sessão "cai" depois desse tempo).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const args = process.argv.slice(2);
const mode = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const STATE_FILE = path.join(os.tmpdir(), 'telao-fake-ps5-state');
const reply = (obj) => { process.stdout.write(`${JSON.stringify(obj)}\n`); process.exit(obj.ok ? 0 : 1); };
const consoleState = () => {
  try { return fs.readFileSync(STATE_FILE, 'utf8').trim(); } catch { return process.env.FAKE_PS5_STATE || 'ready'; }
};

const REGIST_KEY = '0123456789abcdef0123456789abcdef';
const RP_KEY = 'fedcba9876543210fedcba9876543210';

if (mode === 'discover') {
  reply({ ok: true, consoles: [{ host: '127.0.0.1', name: 'PS5-Teste', id: 'fake-ps5-id', state: consoleState(), ps5: true }] });
} else if (mode === 'register') {
  if (opt('pin') !== '12345678') reply({ ok: false, error: 'O código não confere. Confira o número na tela do PS5.' });
  reply({ ok: true, name: 'PS5-Teste', id: 'fake-ps5-id', mac: '001122334455', registKey: REGIST_KEY, rpKey: RP_KEY });
} else if (mode === 'wake') {
  fs.writeFileSync(STATE_FILE, 'ready');
  reply({ ok: true });
} else if (mode === 'stream') {
  stream();
} else {
  reply({ ok: false, error: `modo desconhecido: ${mode}` });
}

function packet(type, id, payload) {
  const header = Buffer.alloc(9);
  header[0] = type;
  header.writeUInt32LE(id, 1);
  header.writeUInt32LE(payload.length, 5);
  process.stdout.write(Buffer.concat([header, payload]));
}
function event(obj) {
  packet(2, 0, Buffer.from(JSON.stringify(obj), 'utf8'));
}

/** Quebra o Annex-B em quadros pelo delimitador (AUD, NAL tipo 9). */
function accessUnits(data) {
  const starts = [];
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1 && (data[i + 4] & 0x1f) === 9) starts.push(i);
  }
  return starts.map((s, k) => data.subarray(s, starts[k + 1] ?? data.length));
}

function stream() {
  if (opt('regist-key') !== REGIST_KEY || opt('rp-key') !== RP_KEY) {
    event({ event: 'quit', reason: 'auth', message: 'O PS5 recusou o pareamento.' });
    process.exit(2);
  }
  const frames = accessUnits(fs.readFileSync(path.join(__dirname, 'ps5-sample.h264')));
  const fps = 30;
  let n = 0;
  let idrRequests = 0;
  event({ event: 'connecting' });
  setTimeout(() => {
    event({ event: 'connected', width: 640, height: 360, fps, codec: 'h264' });
    // Ritmo pelo relógio: o setInterval do Windows atrasa (33 ms viram ~46 ms), e
    // contar os quadros devidos mantém os 30 fps de verdade.
    const started = Date.now();
    setInterval(() => {
      const due = Math.floor(((Date.now() - started) * fps) / 1000);
      while (n <= due) { packet(3, n, frames[n % frames.length]); n += 1; }
    }, 5);
    // 10 ms de som por pacote: 480 quadros estéreo de 16 bits.
    let phase = 0;
    let sent = 0;
    setInterval(() => {
      const dueChunks = Math.floor((Date.now() - started) / 10);
      for (; sent < dueChunks; sent++) {
        const pcm = Buffer.alloc(480 * 4);
        for (let i = 0; i < 480; i++) {
          const v = Math.round(Math.sin(phase) * 8000);
          phase += (2 * Math.PI * 440) / 48000;
          pcm.writeInt16LE(v, i * 4);
          pcm.writeInt16LE(v, i * 4 + 2);
        }
        packet(1, 0, pcm);
      }
    }, 5);
  }, 300);
  const quitAfter = Number(process.env.FAKE_PS5_QUIT_AFTER_MS);
  if (quitAfter > 0) {
    setTimeout(() => {
      event({ event: 'quit', reason: 'STREAM_CONNECTION_REMOTE_DISCONNECTED', message: 'O PS5 encerrou a Reprodução Remota.', detail: 'Remote play was disconnected' });
      process.exit(3);
    }, quitAfter);
  }
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (text) => {
    for (const line of text.split('\n')) {
      if (line.trim() === 'idr') {
        idrRequests += 1;
        process.stderr.write(`pedido de keyframe #${idrRequests}\n`);
      }
    }
  });
  // Como o receptor de verdade: ao perder o stdin, avisa que parou e sai com 0.
  process.stdin.on('end', () => {
    event({ event: 'quit', reason: 'STOPPED', message: 'A transmissão do PS5 foi encerrada.' });
    process.exit(0);
  });
}
