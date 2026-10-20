'use strict';

// Captura de som por aplicativo (Windows 10 2004+ / 11): controla o
// telao-audio.exe e repassa para a interface o áudio de cada app
// (PCM 16 bits, estéreo, 48 kHz) e os eventos (apps capturados/excluídos).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Apps de voz/chamada que, por padrão, nunca entram no som da transmissão.
const DEFAULT_EXCLUDED_APPS = [
  'Discord.exe', 'DiscordPTB.exe', 'DiscordCanary.exe', 'DiscordDevelopment.exe',
  'TeamSpeak.exe', 'ts3client_win64.exe', 'ts3client_win32.exe',
  'ms-teams.exe', 'Teams.exe', 'Zoom.exe', 'Skype.exe',
  'WhatsApp.exe', 'Telegram.exe', 'slack.exe', 'mumble.exe',
  'Guilded.exe', 'Element.exe', 'Signal.exe',
];

function windowsBuild() {
  const match = /^10\.0\.(\d+)/.exec(os.release());
  return match ? Number(match[1]) : 0;
}

/**
 * Lê o protocolo do telao-audio.exe: pacotes [tipo u8][id u32][tamanho u32][dados],
 * que podem chegar quebrados em pedaços arbitrários pelo pipe.
 */
function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 9) {
      const length = buffer.readUInt32LE(5);
      if (buffer.length < 9 + length) break;
      onFrame(buffer[0], buffer.readUInt32LE(1), buffer.subarray(9, 9 + length));
      buffer = buffer.subarray(9 + length);
    }
  };
}

function normalizeExeName(name) {
  const base = String(name || '').trim().replace(/^.*[\\/]/, '');
  if (!base || base.length > 128 || /[,;"\r\n]/.test(base)) return null;
  return /\.exe$/i.test(base) ? base : `${base}.exe`;
}

class AppAudio {
  constructor({ helperPath, send }) {
    this.helperPath = helperPath;
    this.send = send;
    this.proc = null;
    this.session = null;
  }

  get supported() {
    return process.platform === 'win32' && windowsBuild() >= 19041 && fs.existsSync(this.helperPath);
  }

  start({ session, mode, sourceId, exclude }) {
    this.stop();
    if (!this.supported) throw new Error('A captura de som por aplicativo não está disponível neste sistema.');
    const args = ['--mode', 'all', '--exclude-pids', String(process.pid)];
    // Além deste processo (por PID), exclui outras cópias do Telão abertas no
    // mesmo PC: senão uma capturaria o som que a outra está tocando (eco em loop).
    const names = [...(Array.isArray(exclude) ? exclude : []), path.basename(process.execPath)]
      .map(normalizeExeName).filter(Boolean);
    if (names.length) args.push('--exclude-names', names.join(','));
    const hwnd = /^window:(\d+):/.exec(String(sourceId || ''));
    if (mode === 'app' && hwnd) {
      args[1] = 'app';
      args.push('--hwnd', hwnd[1]);
    }

    const proc = spawn(this.helperPath, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.proc = proc;
    this.session = session;
    proc.stdout.on('data', createFrameParser((type, id, payload) => {
      if (type === 1) {
        // Cópia com buffer próprio: o IPC não arrasta junto o resto do buffer do pipe.
        this.send('appaudio:data', session, id, new Uint8Array(payload));
      } else if (type === 2) {
        try { this.send('appaudio:event', session, JSON.parse(payload.toString('utf8'))); } catch { /* ignora */ }
      }
    }));
    proc.stdin.on('error', () => {});
    proc.once('error', (err) => {
      this.send('appaudio:event', session, { event: 'error', fatal: true, message: `Falha ao iniciar a captura de som: ${err.message}` });
    });
    proc.once('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      this.send('appaudio:event', session, { event: 'exit', code, expected: proc.stopRequested === true });
    });
    return { session };
  }

  stop(session) {
    if (session !== undefined && session !== this.session) return;
    const proc = this.proc;
    this.proc = null;
    this.session = null;
    if (!proc || proc.exitCode !== null) return;
    proc.stopRequested = true;
    proc.stdin.end(); // o helper sai sozinho ao perder o stdin
    setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 1500);
  }
}

module.exports = { AppAudio, DEFAULT_EXCLUDED_APPS, createFrameParser, normalizeExeName };
