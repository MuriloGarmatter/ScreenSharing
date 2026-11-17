'use strict';

// Teste do receptor de PS5, SEM abrir nada na tela: um Electron com janela oculta
// (show: false, fora da barra de tarefas) roda src/main/ps5.js + src/renderer/ps5.js
// de verdade contra o receptor falso (test/fixtures/fake-ps5.js), que entrega um
// vídeo H.264 de 640x360 a 30 fps e um tom de 440 Hz.
// Uso: npm run test:ps5

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, safeStorage } = require('electron');
const { Ps5 } = require('../src/main/ps5');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-ps5-test-'));
const STATE_FILE = path.join(os.tmpdir(), 'telao-fake-ps5-state');
app.setPath('userData', TMP);
app.disableHardwareAcceleration(); // sem placa: o WebCodecs decodifica no processador (o caminho mais restrito)

let win = null;
const ps5 = new Ps5({
  helperPath: path.join(__dirname, 'fixtures', 'fake-ps5.js'),
  storeFile: path.join(TMP, 'ps5.json'),
  logFile: path.join(TMP, 'logs', 'ps5.log'),
  send: (channel, ...args) => { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); },
  crypto: {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buffer) => safeStorage.decryptString(buffer),
  },
});

// Os mesmos canais do main.js.
ipcMain.handle('ps5:list', () => ps5.list());
ipcMain.handle('ps5:discover', (_e, o = {}) => ps5.discover({ host: o.host }));
ipcMain.handle('ps5:register', (_e, o = {}) => ps5.register(o));
ipcMain.handle('ps5:forget', (_e, id) => ps5.forget(String(id)));
ipcMain.handle('ps5:start', (_e, o = {}) => ps5.start({ session: String(o.session), id: String(o.id), settings: o.settings || {} }));
ipcMain.handle('ps5:keyframe', (_e, session) => ps5.requestKeyframe(String(session)));
ipcMain.on('ps5:stats', (_e, session, line) => ps5.logStats(String(session), String(line)));
ipcMain.handle('ps5:stop', (_e, session) => { ps5.stop(String(session)); });

const page = (code) => win.webContents.executeJavaScript(`(async () => { const h = window.harness; ${code} })()`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures += 1;
    console.log(`  FALHA ${name}: ${err.message}`);
  }
}

async function main() {
  fs.rmSync(STATE_FILE, { force: true });
  win = new BrowserWindow({
    show: false, skipTaskbar: true, focusable: false, width: 320, height: 240,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', backgroundThrottling: false,
    },
  });
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log(`    [página] ${message}`); });
  await win.loadFile(path.join(__dirname, 'fixtures', 'ps5-page.html'));
  for (let i = 0; i < 50 && !(await win.webContents.executeJavaScript('window.harnessReady === true')); i++) await wait(100);
  console.log(`Saída de vídeo: ${(await page('return h.generator;')) ? 'MediaStreamTrackGenerator' : 'canvas (alternativa)'}`);

  await step('procura na rede acha o PS5', async () => {
    const found = await page('return h.api.ps5Discover({});');
    assert.equal(found.length, 1);
    assert.equal(found[0].name, 'PS5-Teste');
    assert.equal(found[0].state, 'ready');
  });

  await step('código errado: o pareamento falha com a mensagem do receptor', async () => {
    const msg = await page(`try { await h.api.ps5Register({ host: '127.0.0.1', accountId: 'AAAAAAAAAAA=', pin: '11111111' }); return 'passou'; } catch (e) { return e.message; }`);
    assert.match(msg, /código não confere/);
  });

  await step('pareia e guarda as chaves cifradas', async () => {
    const paired = await page(`return h.api.ps5Register({ host: '127.0.0.1', accountId: 'AAAAAAAAAAA=', pin: '12345678' });`);
    assert.deepEqual(paired, { id: 'fake-ps5-id', name: 'PS5-Teste', host: '127.0.0.1' });
    const list = await page('return h.api.ps5List();');
    assert.equal(list.consoles.length, 1);
    assert.equal(list.accountId, 'AAAAAAAAAAA=');
    assert.equal(JSON.stringify(list).includes('0123456789abcdef'), false, 'a interface não pode ver as chaves');
    const stored = fs.readFileSync(path.join(TMP, 'ps5.json'), 'utf8');
    if (safeStorage.isEncryptionAvailable()) assert.equal(stored.includes('0123456789abcdef'), false, 'chave em texto puro no disco');
  });

  await step('transmite: vídeo 640x360 ~30 fps e som de 440 Hz', async () => {
    const result = await page(`
      const cap = new h.Ps5Capture(h.api);
      window.cap = cap;
      const stream = await cap.start({ id: 'fake-ps5-id', settings: { resolution: '1080p', fps: 60 }, audio: true });
      const video = stream.getVideoTracks()[0];
      const [count, peak] = await Promise.all([h.countFrames(video, 2000), h.audioPeak(stream.getAudioTracks()[0])]);
      return { count, peak, tracks: stream.getTracks().map((t) => t.kind).sort() };`);
    assert.deepEqual(result.tracks, ['audio', 'video']);
    assert.deepEqual(result.count.size, [640, 360]);
    assert.ok(result.count.frames >= 45, `só ${result.count.frames} quadros em 2 s`);
    assert.ok(Math.abs(result.peak.hz - 440) < 15, `pico em ${result.peak.hz} Hz`);
    assert.ok(result.peak.db > -60, `som baixo demais (${result.peak.db} dB)`);
  });

  await step('decodificador perdido: pede keyframe e volta sozinho', async () => {
    const frames = await page(`
      window.cap.resetDecoder();
      const video = window.cap.sink.track;
      await new Promise((r) => setTimeout(r, 300));
      return (await h.countFrames(video, 2000)).frames;`);
    assert.ok(frames >= 25, `só ${frames} quadros depois de perder o decodificador`);
    const log = fs.readFileSync(path.join(TMP, 'logs', 'ps5.log'), 'utf8');
    assert.match(log, /pedido de keyframe/);
  });

  await step('parar encerra o receptor', async () => {
    await page('window.cap.stop();');
    await wait(500);
    assert.equal(ps5.proc, null);
    // Ao parar, a interface manda as estatísticas finais para o log (para investigar travadas).
    const log = fs.readFileSync(path.join(TMP, 'logs', 'ps5.log'), 'utf8');
    assert.match(log, /\[Telão\] Decodificação em [\d.]+ s: \d+ quadros chegaram/);
  });

  await step('PS5 em repouso: acorda e conecta', async () => {
    fs.writeFileSync(STATE_FILE, 'standby');
    const result = await page(`
      const statuses = [];
      const cap = new h.Ps5Capture(h.api);
      const stream = await cap.start({ id: 'fake-ps5-id', settings: {}, audio: false, onStatus: (s) => statuses.push(s) });
      const n = (await h.countFrames(stream.getVideoTracks()[0], 800)).frames;
      cap.stop();
      return { statuses, n, tracks: stream.getTracks().length };`);
    // Conectando, acordando o console e, com ele pronto, conectando de novo.
    assert.deepEqual(result.statuses, ['connecting', 'waking', 'connecting']);
    assert.equal(result.tracks, 1, 'sem som pedido, só o vídeo');
    assert.ok(result.n > 10);
  });

  await step('PS5 encerra no meio: avisa que a transmissão acabou', async () => {
    process.env.FAKE_PS5_QUIT_AFTER_MS = '1500';
    try {
      const message = await page(`
        const cap = new h.Ps5Capture(h.api);
        const ended = new Promise((r) => cap.addEventListener('ended', (e) => r(e.detail)));
        await cap.start({ id: 'fake-ps5-id', settings: {}, audio: false });
        const msg = await Promise.race([ended, new Promise((r) => setTimeout(() => r('não avisou'), 4000))]);
        cap.stop();
        return msg;`);
      assert.match(message, /encerrou a Reprodução Remota/);
    } finally {
      delete process.env.FAKE_PS5_QUIT_AFTER_MS;
    }
  });

  await step('console não pareado: erro claro', async () => {
    const msg = await page(`try { await new h.Ps5Capture(h.api).start({ id: 'outro', settings: {} }); return 'passou'; } catch (e) { return e.message; }`);
    assert.match(msg, /não está pareado/);
  });

  await step('esquecer remove o console', async () => {
    const list = await page(`return h.api.ps5Forget('fake-ps5-id');`);
    assert.equal(list.consoles.length, 0);
  });
}

app.whenReady()
  .then(main)
  .catch((err) => { failures += 1; console.error(err); })
  .finally(() => {
    ps5.stop();
    fs.rmSync(STATE_FILE, { force: true });
    console.log(failures ? `\n${failures} falha(s).` : '\nTudo certo.');
    setTimeout(() => {
      // No Windows o Chromium ainda pode estar segurando a pasta: sem o try, o erro impedia o app.exit.
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fica para a limpeza do sistema */ }
      app.exit(failures ? 1 : 0);
    }, 300);
  });
