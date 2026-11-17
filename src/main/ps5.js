'use strict';

// Receptor de Remote Play do PS5: controla o telao-ps5.exe (ver native/ps5/PROTOCOL.md),
// guarda os consoles pareados e repassa para a interface o vídeo H.264 (ainda
// comprimido), o som (PCM) e os eventos da sessão.

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createFrameParser } = require('./app-audio');

const WAKE_TIMEOUT_MS = 40_000;
const WAKE_POLL_MS = 2_000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

function isHex(value, bytes) {
  return typeof value === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'i').test(value);
}

/** Endereço IPv4 ou nome simples: vai como argumento do helper, então nada de espaços ou aspas. */
function cleanHost(value) {
  const host = String(value || '').trim();
  return /^[\w.:-]{1,253}$/.test(host) ? host : null;
}

/** Resolução e FPS que o PS5 entrega: ele só faz 720p/1080p a 30/60. */
function streamProfile(settings = {}) {
  const resolution = settings.resolution === '480p' || settings.resolution === '720p' ? '720p' : '1080p';
  const fps = Number(settings.fps) > 30 ? 60 : 30;
  const args = ['--resolution', resolution, '--fps', String(fps)];
  const mbps = Number(settings.bitrate);
  // Pede ao console um pouco mais do que vai para os amigos: o Telão comprime de novo.
  if (mbps > 0) args.push('--bitrate', String(Math.round(Math.min(Math.max(mbps * 1.5, 5), 40) * 1000)));
  return { resolution, fps, args };
}

class Ps5 {
  constructor({ helperPath, storeFile, logFile, send, crypto = null }) {
    this.helperPath = helperPath;
    this.storeFile = storeFile;
    this.logFile = logFile;
    this.send = send;
    this.crypto = crypto; // { available(), encrypt(text) -> Buffer, decrypt(Buffer) -> text } (safeStorage)
    this.proc = null;
    this.session = null;
    this.starting = null;
  }

  get supported() {
    // Um .js é o receptor falso dos testes (roda em qualquer sistema).
    if (/\.js$/i.test(this.helperPath)) return fs.existsSync(this.helperPath);
    return process.platform === 'win32' && fs.existsSync(this.helperPath);
  }

  // ---------- Consoles pareados ----------

  readStore() {
    try {
      const data = JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
      return { accountId: typeof data.accountId === 'string' ? data.accountId : '', consoles: Array.isArray(data.consoles) ? data.consoles : [] };
    } catch {
      return { accountId: '', consoles: [] };
    }
  }

  writeStore(store) {
    fs.mkdirSync(path.dirname(this.storeFile), { recursive: true });
    fs.writeFileSync(this.storeFile, JSON.stringify(store, null, 2));
  }

  /** As chaves do pareamento ficam cifradas pelo Windows (DPAPI), quando dá. */
  sealKeys(keys) {
    const text = JSON.stringify(keys);
    if (this.crypto?.available()) return { sealed: this.crypto.encrypt(text).toString('base64') };
    return { plain: keys };
  }

  openKeys(entry) {
    try {
      if (entry.keys?.sealed && this.crypto?.available()) return JSON.parse(this.crypto.decrypt(Buffer.from(entry.keys.sealed, 'base64')));
      if (entry.keys?.plain) return entry.keys.plain;
    } catch { /* chave ilegível: tratada como não pareado */ }
    return null;
  }

  /** Consoles pareados, sem as chaves (é o que a interface vê). */
  list() {
    const store = this.readStore();
    return {
      accountId: store.accountId,
      consoles: store.consoles.map(({ id, name, host }) => ({ id, name, host })),
    };
  }

  forget(id) {
    const store = this.readStore();
    store.consoles = store.consoles.filter((c) => c.id !== id);
    this.writeStore(store);
    return this.list();
  }

  // ---------- Helper ----------

  command(args) {
    if (/\.js$/i.test(this.helperPath)) {
      return { file: process.execPath, args: [this.helperPath, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };
    }
    return { file: this.helperPath, args, env: process.env };
  }

  /** Roda um modo de resposta única (discover, register, wake) e devolve o JSON. */
  run(args, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      if (!this.supported) return reject(new Error('O receptor do PS5 não está instalado nesta cópia do Telão.'));
      const cmd = this.command(args);
      execFile(cmd.file, cmd.args, { env: cmd.env, windowsHide: true, timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        this.appendLog(`$ telao-ps5 ${args[0]}\n${stderr || ''}`);
        const line = String(stdout || '').trim().split(/\r?\n/).pop();
        let result = null;
        try { result = JSON.parse(line); } catch { /* sem JSON */ }
        if (result && result.ok) return resolve(result);
        if (result && result.error) return reject(new Error(result.error));
        if (err?.killed) return reject(new Error('O PS5 demorou demais para responder.'));
        reject(new Error(err ? `O receptor do PS5 falhou (${err.code ?? err.message}).` : 'Resposta inválida do receptor do PS5.'));
      });
    });
  }

  appendLog(text) {
    if (!this.logFile || !text) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      if (fs.existsSync(this.logFile) && fs.statSync(this.logFile).size > MAX_LOG_BYTES) fs.rmSync(this.logFile);
      fs.appendFileSync(this.logFile, text.endsWith('\n') ? text : `${text}\n`);
    } catch { /* log é opcional */ }
  }

  async discover({ host } = {}) {
    const args = ['discover', '--timeout', '2000'];
    const target = cleanHost(host);
    if (host && !target) throw new Error('Endereço do PS5 inválido.');
    if (target) args.push('--host', target);
    const result = await this.run(args);
    return (Array.isArray(result.consoles) ? result.consoles : [])
      .filter((c) => c && cleanHost(c.host))
      .map((c) => ({ host: c.host, name: String(c.name || 'PS5').slice(0, 64), id: String(c.id || ''), state: c.state === 'ready' ? 'ready' : 'standby', ps5: c.ps5 !== false }));
  }

  /** Pareia com o console (o PIN de 8 dígitos aparece na tela do PS5). */
  async register({ host, pin, accountId }) {
    const target = cleanHost(host);
    if (!target) throw new Error('Digite o endereço IP do PS5.');
    const digits = String(pin || '').replace(/\D/g, '');
    if (digits.length !== 8) throw new Error('O código do PS5 tem 8 números.');
    const account = String(accountId || '').trim();
    if (!/^[A-Za-z0-9+/]{11}=$/.test(account)) throw new Error('ID da conta PSN inválido.');
    const result = await this.run(['register', '--host', target, '--account-id', account, '--pin', digits], 30_000);
    // A chave de registro é o texto que o console mandou, em hexadecimal (o tamanho varia).
    if (!/^(?:[0-9a-f]{2}){1,16}$/i.test(String(result.registKey))) throw new Error('O PS5 respondeu um pareamento inválido.');
    if (!isHex(result.rpKey, 16)) throw new Error('O PS5 respondeu um pareamento inválido.');
    const id = String(result.id || target);
    const entry = { id, name: String(result.name || 'PS5').slice(0, 64), host: target, mac: String(result.mac || ''), keys: this.sealKeys({ registKey: result.registKey, rpKey: result.rpKey }) };
    const store = this.readStore();
    store.accountId = account;
    store.consoles = [...store.consoles.filter((c) => c.id !== id), entry];
    this.writeStore(store);
    return { id: entry.id, name: entry.name, host: entry.host };
  }

  // ---------- Transmissão ----------

  emit(session, event) {
    this.send('ps5:event', session, event);
  }

  /**
   * Onde o console está agora. O roteador pode ter dado outro endereço a ele: se no
   * endereço guardado não há ninguém (ou há outro console), procura pelo id na rede
   * e passa a usar o endereço novo.
   */
  async locate(entry) {
    const sameId = (c) => Boolean(c?.id) && c.id.toLowerCase() === String(entry.id).toLowerCase();
    const [direct] = await this.discover({ host: entry.host }).catch(() => []);
    if (direct && (sameId(direct) || !direct.id)) return direct;
    const moved = (await this.discover().catch(() => [])).find(sameId);
    if (moved && moved.host !== entry.host) {
      this.appendLog(`O console ${entry.name} mudou de ${entry.host} para ${moved.host}.`);
      entry.host = moved.host;
      const store = this.readStore();
      const saved = store.consoles.find((c) => c.id === entry.id);
      if (saved) {
        saved.host = moved.host;
        this.writeStore(store);
      }
    }
    // Sem resposta nenhuma: tenta conectar no endereço guardado assim mesmo.
    return moved || direct || null;
  }

  /** Se o console estiver em repouso, acorda e espera ele ficar pronto. */
  async ensureAwake(session, entry, keys, stillWanted) {
    const found = await this.locate(entry);
    if (!found || found.state === 'ready') return;
    this.emit(session, { event: 'waking' });
    await this.run(['wake', '--host', entry.host, '--regist-key', keys.registKey]);
    const deadline = Date.now() + WAKE_TIMEOUT_MS;
    while (Date.now() < deadline && stillWanted()) {
      await new Promise((r) => setTimeout(r, WAKE_POLL_MS));
      const [now] = await this.discover({ host: entry.host }).catch(() => []);
      if (now?.state === 'ready') return;
    }
    if (stillWanted()) throw new Error('O PS5 não acordou. Confira se "Permitir ligar o PS5 pela rede" está ativado.');
  }

  async start({ session, id, settings }) {
    // O console só aceita uma sessão: a anterior precisa ter fechado antes da nova.
    await this.stop();
    const entry = this.readStore().consoles.find((c) => c.id === id);
    if (!entry) throw new Error('Esse PS5 não está pareado.');
    const keys = this.openKeys(entry);
    if (!keys) throw new Error('Não foi possível ler o pareamento desse PS5. Pareie de novo.');
    const token = {};
    this.starting = token;
    this.session = session;
    const stillWanted = () => this.starting === token;
    await this.ensureAwake(session, entry, keys, stillWanted);
    if (!stillWanted()) return { session, cancelled: true };
    this.starting = null;

    const profile = streamProfile(settings);
    const cmd = this.command(['stream', '--host', entry.host, '--regist-key', keys.registKey, '--rp-key', keys.rpKey, ...profile.args]);
    this.appendLog(`$ telao-ps5 stream ${entry.host} ${profile.resolution}@${profile.fps}`);
    const proc = spawn(cmd.file, cmd.args, { env: cmd.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = proc;
    proc.stdout.on('data', createFrameParser((type, frameId, payload) => {
      // Cópias com buffer próprio: o IPC não arrasta junto o resto do buffer do pipe.
      if (type === 3) this.send('ps5:video', session, frameId, new Uint8Array(payload));
      else if (type === 1) this.send('ps5:audio', session, new Uint8Array(payload));
      else if (type === 2) {
        try { this.emit(session, JSON.parse(payload.toString('utf8'))); } catch { /* ignora */ }
      }
    }));
    proc.stderr.on('data', (chunk) => this.appendLog(chunk.toString('utf8')));
    proc.stdin.on('error', () => {});
    proc.once('error', (err) => {
      this.emit(session, { event: 'error', fatal: true, message: `Falha ao iniciar o receptor do PS5: ${err.message}` });
    });
    proc.once('exit', (code) => {
      if (this.proc === proc) {
        this.proc = null;
        this.session = null;
      }
      this.emit(session, { event: 'exit', code, expected: proc.stopRequested === true });
    });
    return { session, resolution: profile.resolution, fps: profile.fps };
  }

  /** Linha de estatísticas da interface (decodificação e saída do vídeo), só para o log. */
  logStats(session, line) {
    if (session !== this.session) return;
    this.appendLog(`[Telão] ${line.slice(0, 500)}`);
  }

  /** O decodificador da interface perdeu a sequência: pede um quadro completo ao console. */
  requestKeyframe(session) {
    if (session !== this.session || !this.proc || this.proc.exitCode !== null) return;
    this.proc.stdin.write('idr\n');
  }

  /** Para o receptor; a promessa cumpre quando o processo saiu de fato. */
  stop(session) {
    if (session !== undefined && session !== this.session) return Promise.resolve();
    this.starting = null;
    const proc = this.proc;
    this.proc = null;
    this.session = null;
    if (!proc || proc.exitCode !== null) return Promise.resolve();
    proc.stopRequested = true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 3000);
      proc.once('exit', () => { clearTimeout(timer); resolve(); });
      proc.stdin.end(); // o helper encerra a sessão e sai ao perder o stdin
    });
  }
}

module.exports = { Ps5, streamProfile, cleanHost };
