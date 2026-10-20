'use strict';

// Link público grátis via Cloudflare Quick Tunnel (cloudflared).
// Permite que amigos pela internet acessem o servidor hospedado neste PC sem
// abrir portas no roteador (funciona até com CGNAT).

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const DOWNLOAD_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const EXE = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

function findCloudflared(binDir) {
  const candidates = [
    process.env.TELAO_CLOUDFLARED,
    path.join(binDir, EXE),
  ];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', EXE),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', EXE),
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', EXE),
    );
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, EXE));
  }
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

/** Inicia o túnel e resolve com { url, stop } assim que o link público aparece. */
function startTunnel(exe, port, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    const stop = () => { if (proc.exitCode === null) proc.kill(); };
    const finish = (err, url) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) { stop(); reject(err); } else resolve({ url, stop, process: proc });
    };
    const onData = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
      const match = URL_RE.exec(output);
      if (match) finish(null, match[0]);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.once('error', (err) => finish(new Error(`Não foi possível executar o cloudflared: ${err.message}`)));
    proc.once('exit', (code) => {
      const tail = output.trim().split(/\r?\n/).slice(-3).join(' ');
      finish(new Error(`O cloudflared encerrou (código ${code}). ${tail}`));
    });
    const timer = setTimeout(() => finish(new Error('O cloudflared não gerou o link a tempo.')), timeoutMs);
  });
}

/** Baixa o cloudflared oficial (GitHub da Cloudflare) para binDir. */
async function downloadCloudflared(binDir, onProgress = () => {}) {
  if (process.platform !== 'win32') {
    throw new Error('Download automático só no Windows. Instale o cloudflared pelo gerenciador de pacotes.');
  }
  fs.mkdirSync(binDir, { recursive: true });
  const target = path.join(binDir, EXE);
  const temp = `${target}.download`;
  const res = await fetch(DOWNLOAD_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Falha no download (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    received += chunk.length;
    if (total) onProgress(received / total);
  });
  await pipeline(body, fs.createWriteStream(temp));
  fs.renameSync(temp, target);
  return target;
}

module.exports = { findCloudflared, startTunnel, downloadCloudflared, URL_RE };
