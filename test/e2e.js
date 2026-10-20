'use strict';

// Teste de ponta a ponta: ABRE DUAS JANELAS DO APP neste PC e toca dois tons
// baixinhos (por ~1 minuto).
//   - "Alice" hospeda a sala e "Bob" entra pelo endereço da rede.
//   - Uma janela com animação garante movimento na tela (para medir o FPS).
//   - ToneApp.exe toca 440 Hz e FakeDiscord.exe toca 880 Hz (no papel do Discord).
//   - Alice transmite a tela em 720p/30 com "todos os apps, menos os excluídos"
//     e FakeDiscord.exe na lista de excluídos.
//   - Bob confere resolução, FPS e o espectro do som: 440 Hz chega, 880 Hz não.
//   - Alice muda para 480p/10 e H.264 ao vivo; Bob também transmite; Alice para.
// Uso: npm run test:e2e   (E2E_SCREENSHOTS=pasta para salvar capturas de tela)

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const electronPath = require('electron');
const { _electron: electron } = require('playwright-core');

const APP_DIR = path.join(__dirname, '..');
const PORT = 47999;
const ROOM = `e2e-${Date.now().toString(36)}`;
const SHOTS = process.env.E2E_SCREENSHOTS || '';
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

async function launch(profile) {
  const app = await electron.launch({ executablePath: electronPath, args: [APP_DIR, `--profile=${profile}`], env });
  const page = await app.firstWindow();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') console.log(`  [${profile} ${msg.type()}] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`  [${profile} pageerror] ${err.message}`));
  await page.waitForSelector('#join-form');
  return { app, page };
}

function startToneApps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-e2e-'));
  const source = path.join(__dirname, 'fixtures', 'ToneApp.cs');
  for (const name of ['ToneApp.exe', 'FakeDiscord.exe']) {
    execFileSync(CSC, ['/nologo', '/platform:x64', `/out:${path.join(dir, name)}`, source]);
  }
  const procs = [
    spawn(path.join(dir, 'ToneApp.exe'), ['440', '120'], { windowsHide: true }),
    spawn(path.join(dir, 'FakeDiscord.exe'), ['880', '120'], { windowsHide: true }),
  ];
  return () => {
    for (const p of procs) p.kill();
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 1000);
  };
}

/** Janela sempre visível com animação contínua, na tela principal. */
function openAnimationWindow(app) {
  return app.evaluate(({ BrowserWindow, screen }) => {
    const { x, y } = screen.getPrimaryDisplay().workArea;
    const win = new BrowserWindow({ x: x + 40, y: y + 40, width: 480, height: 270, frame: false, alwaysOnTop: true, title: 'Telao Teste Animacao' });
    const html = '<body style="margin:0;background:#111"><canvas id="c" width="480" height="270"></canvas><script>'
      + 'const g=document.getElementById("c").getContext("2d");let t=0;'
      + '(function f(){t++;g.fillStyle="#111";g.fillRect(0,0,480,270);'
      + 'g.fillStyle="hsl("+(t*3%360)+",80%,60%)";g.fillRect((t*7)%480,100,60,60);'
      + 'g.fillStyle="#fff";g.font="20px sans-serif";g.fillText("quadro "+t,10,30);requestAnimationFrame(f)})()'
      + '</script></body>';
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

/** Resolução e FPS reais do vídeo recebido. */
function measureVideo(page) {
  return page.evaluate(async () => {
    const video = document.querySelector('.tile video');
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames += 1;
        if (performance.now() - start >= 3000) resolve();
        else video.requestVideoFrameCallback(tick);
      };
      video.requestVideoFrameCallback(tick);
      setTimeout(resolve, 6000);
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      fps: Math.round(frames / ((performance.now() - start) / 1000)),
      audioTracks: video.srcObject.getAudioTracks().length,
    };
  });
}

/** Intensidade (dB) de 440 Hz e 880 Hz no som recebido. */
function measureTones(page) {
  return page.evaluate(async () => {
    const stream = document.querySelector('.tile video').srcObject;
    const ctx = new AudioContext({ sampleRate: 48000 });
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 16384;
    analyser.smoothingTimeConstant = 0;
    ctx.createMediaStreamSource(stream).connect(analyser);
    await new Promise((r) => setTimeout(r, 2000));
    const data = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(data);
    const binHz = ctx.sampleRate / analyser.fftSize;
    const peak = (hz) => Math.max(...[-2, -1, 0, 1, 2].map((d) => data[Math.round(hz / binHz) + d]));
    const result = { db440: Math.round(peak(440)), db880: Math.round(peak(880)) };
    await ctx.close();
    return result;
  });
}

async function step(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`• ${name} … `);
  const result = await fn();
  console.log(`ok (${Date.now() - t0} ms)`);
  return result;
}

(async () => {
  const stopTones = startToneApps();
  const a = await launch('e2e-a');
  const b = await launch('e2e-b');
  try {
    await step('Alice hospeda a sala', async () => {
      await a.page.fill('#name', 'Alice');
      await a.page.fill('#room', ROOM);
      await a.page.click('label[for="mode-host"]');
      await a.page.fill('#host-port', String(PORT));
      await a.page.uncheck('#host-tunnel');
      await shot(a.page, '01-entrada-hospedar');
      await a.page.click('#join-btn');
      await a.page.waitForSelector('#room-view:not([hidden])', { timeout: 10_000 });
    });

    await step('Bob entra pelo endereço da rede', async () => {
      await b.page.fill('#name', 'Bob');
      await b.page.fill('#room', ROOM);
      await b.page.click('label[for="mode-join"]');
      await b.page.fill('#server-url', `127.0.0.1:${PORT}`);
      await b.page.click('#join-btn');
      await b.page.waitForSelector('#room-view:not([hidden])', { timeout: 10_000 });
    });

    await step('conexão P2P estabelecida dos dois lados', async () => {
      await a.page.waitForSelector('.participant:has-text("Bob") .pill.ok', { timeout: 15_000 });
      await b.page.waitForSelector('.participant:has-text("Alice") .pill.ok', { timeout: 15_000 });
    });

    await openAnimationWindow(a.app);

    await step('Alice escolhe 720p / 30 fps, a tela principal e exclui o FakeDiscord', async () => {
      await a.page.selectOption('#q-resolution', '720p');
      await a.page.selectOption('#q-fps', '30');
      await a.page.selectOption('#q-codec', 'auto');
      await a.page.click('#share-btn');
      await a.page.waitForSelector('.source-card', { timeout: 10_000 });
      await a.page.click('.source-card:has-text("principal")');
      await a.page.check('#share-audio');
      await a.page.selectOption('#audio-mode', 'all');
      await a.page.click('#exclude-toggle');
      const defaults = await a.page.inputValue('#exclude-list');
      await a.page.fill('#exclude-list', `${defaults}\nFakeDiscord.exe`);
      await shot(a.page, '02-seletor-de-tela');
      await a.page.click('#picker-start');
      await a.page.waitForSelector('#share-live:not([hidden])', { timeout: 10_000 });
    });

    await step('Alice vê o ToneApp capturado e o FakeDiscord fora', async () => {
      await a.page.waitForFunction(() => {
        const text = document.querySelector('#share-audio-text').textContent;
        return text.includes('ToneApp') && /Fora da transmissão:.*FakeDiscord/.test(text);
      }, null, { timeout: 15_000 });
    });
    console.log('  som (Alice):', await a.page.textContent('#share-audio-text'));

    const first = await step('Bob recebe a imagem', async () => {
      await b.page.waitForFunction(() => {
        const v = document.querySelector('.tile video');
        return v && v.videoWidth > 0 && !document.querySelector('.tile').classList.contains('waiting');
      }, null, { timeout: 20_000 });
      await b.page.waitForTimeout(3000);
      return measureVideo(b.page);
    });
    console.log('  recebido:', first);
    assert.ok(first.width <= 1280 && first.height <= 720, 'resolução deve respeitar 720p');
    assert.ok(first.width >= 640, 'não deve começar borrado (resolução muito baixa)');
    assert.ok(first.fps >= 12 && first.fps <= 32, 'fps deve ficar perto de 30');
    assert.equal(first.audioTracks, 1);

    const tones = await step('Bob recebe 440 Hz (ToneApp) e NÃO 880 Hz (FakeDiscord)', async () => {
      await b.page.hover('.tile');
      await b.page.click('.tile-bar .icon-btn >> nth=0'); // silencia no Bob (só analisa)
      return measureTones(b.page);
    });
    console.log('  espectro (Bob):', tones);
    assert.ok(tones.db440 > -70, 'o som do ToneApp deve chegar');
    assert.ok(tones.db880 < tones.db440 - 30, 'o som do FakeDiscord não pode chegar');

    console.log('  envio (Alice):', (await a.page.textContent('#outgoing')).replace(/\s+/g, ' ').trim());
    await b.page.click('.tile-bar button[title^="Estatísticas"]');
    await b.page.waitForTimeout(1500);
    console.log('  estatísticas (Bob):', (await b.page.textContent('.tile-stats')).replace(/\n/g, ' | '));
    await shot(a.page, '03-alice-transmitindo');
    await shot(b.page, '04-bob-assistindo');

    const second = await step('Alice muda ao vivo para 480p / 10 fps', async () => {
      await a.page.selectOption('#q-resolution', '480p');
      await a.page.selectOption('#q-fps', '10');
      await b.page.waitForFunction(() => {
        const v = document.querySelector('.tile video');
        return v && v.videoWidth > 0 && v.videoWidth <= 854;
      }, null, { timeout: 15_000 });
      await b.page.waitForTimeout(2000);
      return measureVideo(b.page);
    });
    console.log('  recebido:', second);
    assert.ok(second.width <= 854 && second.height <= 480, 'resolução deve cair para 480p');
    assert.ok(second.fps <= 12, 'fps deve cair para ~10');

    await step('Alice troca o codec para H.264', async () => {
      await a.page.selectOption('#q-codec', 'H264');
      await a.page.waitForFunction(() => /H264/.test(document.querySelector('#outgoing').textContent), null, { timeout: 15_000 });
    });
    console.log('  envio (Alice):', (await a.page.textContent('#outgoing')).replace(/\s+/g, ' ').trim());

    await step('Bob também transmite e Alice vê', async () => {
      await b.page.click('#share-btn');
      await b.page.waitForSelector('.source-card', { timeout: 10_000 });
      await b.page.click('.source-card >> nth=0');
      await b.page.uncheck('#share-audio');
      await b.page.click('#picker-start');
      await a.page.waitForFunction(() => {
        const v = document.querySelector('.tile video');
        return v && v.videoWidth > 0;
      }, null, { timeout: 20_000 });
    });
    await a.page.waitForTimeout(1500);
    await shot(a.page, '05-alice-vendo-bob');

    await step('Alice para e o quadro some para o Bob', async () => {
      await a.page.click('#stop-btn');
      await b.page.waitForFunction(() => document.querySelectorAll('.tile').length === 0, null, { timeout: 10_000 });
    });

    await step('Bob sai e Alice vê a saída', async () => {
      await b.page.click('#leave-btn');
      await b.page.waitForSelector('#join-view:not([hidden])');
      await a.page.waitForFunction(() => !document.querySelector('#participants').textContent.includes('Bob'), null, { timeout: 10_000 });
      await a.page.waitForFunction(() => document.querySelectorAll('.tile').length === 0);
    });

    console.log('\nTODOS OS PASSOS PASSARAM');
  } catch (err) {
    console.error('\nFALHOU:', err.message);
    await shot(a.page, 'erro-alice').catch(() => {});
    await shot(b.page, 'erro-bob').catch(() => {});
    process.exitCode = 1;
  } finally {
    stopTones();
    await a.app.close().catch(() => {});
    await b.app.close().catch(() => {});
  }
})();
