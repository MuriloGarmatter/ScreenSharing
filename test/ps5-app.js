'use strict';

// Teste da interface do PS5 no Telão de verdade, SEM abrir nada na tela: o app roda
// com TELAO_HEADLESS=1 (janela nunca mostrada, sem bandeja, sem atalhos, sem avisos),
// mudo, contra o receptor falso (test/fixtures/fake-ps5.js). A sala fica num servidor
// só em 127.0.0.1 e ninguém mais entra: nenhuma conexão sai do PC.
// Uso: npm run test:ps5-app   (PS5_SHOTS=pasta salva capturas da interface)

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const electronPath = require('electron');
const { _electron: electron } = require('playwright-core');
const { attachSignaling } = require('../server/signaling');

const APP_DIR = path.join(__dirname, '..');
const PROFILE = 'ps5-app-test';
const SHOTS = process.env.PS5_SHOTS || '';
const STATE_FILE = path.join(os.tmpdir(), 'telao-fake-ps5-state');

const env = { ...process.env, TELAO_HEADLESS: '1', TELAO_PS5_HELPER: path.join(__dirname, 'fixtures', 'fake-ps5.js') };
delete env.ELECTRON_RUN_AS_NODE;

let failures = 0;
async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`  ok   ${name} (${Date.now() - started} ms)`);
  } catch (err) {
    failures += 1;
    console.log(`  FALHA ${name}: ${String(err.message).split('\n').slice(0, 6).join('\n        ')}`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch((err) => console.log(`  (captura ${name} falhou: ${err.message})`));
}

(async () => {
  fs.rmSync(STATE_FILE, { force: true });
  const server = http.createServer((_req, res) => res.end('ok'));
  const signaling = attachSignaling(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const app = await electron.launch({ executablePath: electronPath, args: [APP_DIR, `--profile=${PROFILE}`, '--mute-audio'], env });
  const userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  const page = await app.firstWindow();
  page.on('pageerror', (err) => { failures += 1; console.log(`  [erro na página] ${err.message}`); });
  page.on('console', (msg) => { if (msg.type() === 'error') console.log(`  [console] ${msg.text()}`); });
  const noneVisible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible()));

  try {
    await page.waitForSelector('#join-form');
    await page.setViewportSize({ width: 1360, height: 860 }).catch(() => {});

    await step('nenhuma janela aparece na tela', async () => {
      assert.equal(await noneVisible(), true);
    });

    await step('entra numa sala (servidor em 127.0.0.1)', async () => {
      await page.fill('#name', 'Teste');
      await page.click('label[for="mode-join"]');
      await page.fill('#server-url', `127.0.0.1:${port}`);
      await page.fill('#room', `ps5-${Date.now().toString(36)}`);
      await page.click('#join-btn');
      await page.waitForSelector('#room-view:not([hidden])', { timeout: 15_000 });
    });

    await step('o seletor tem a aba PS5, só com "Parear um PS5"', async () => {
      await page.click('#share-btn');
      await page.waitForSelector('#picker[open] .source-card', { timeout: 10_000 });
      assert.equal(await page.isVisible('.tab[data-tab="ps5"]'), true);
      await page.click('.tab[data-tab="ps5"]');
      await page.waitForSelector('.source-card.add-card');
      assert.equal(await page.locator('#source-grid .source-card').count(), 1);
      assert.equal(await page.isDisabled('#picker-start'), true, 'sem console escolhido, não dá para transmitir');
      await shot(page, '01-aba-ps5-vazia');
    });

    await step('pareamento: acha o console na rede e preenche o endereço', async () => {
      await page.click('.source-card.add-card');
      await page.waitForSelector('#ps5-pair:not([hidden])');
      await page.waitForSelector('#ps5-found button:has-text("PS5-Teste")', { timeout: 10_000 });
      assert.equal(await page.inputValue('#ps5-host'), '127.0.0.1');
      assert.equal(await page.isVisible('#source-grid'), false);
      assert.equal(await page.isVisible('.picker-foot'), false);
      await shot(page, '02-parear');
    });

    await step('pareamento: valida os campos e mostra o erro do console', async () => {
      await page.click('#ps5-pair-submit');
      assert.match(await page.textContent('#ps5-pair-error'), /ID da conta PSN/);
      await page.click('#ps5-login'); // nos testes o login não abre janela: só confere que o botão está ligado
      await page.waitForFunction(() => /Login indisponível/.test(document.querySelector('#ps5-pair-error').textContent));
      await page.fill('#ps5-account', 'AAAAAAAAAAA=');
      await page.fill('#ps5-pin', '1234');
      await page.click('#ps5-pair-submit');
      assert.match(await page.textContent('#ps5-pair-error'), /8 números/);
      await page.fill('#ps5-pin', '1111 1111');
      assert.equal(await page.inputValue('#ps5-pin'), '11111111', 'o campo só aceita números');
      await page.click('#ps5-pair-submit');
      await page.waitForFunction(() => /código não confere/.test(document.querySelector('#ps5-pair-error').textContent), null, { timeout: 10_000 });
      await shot(page, '03-parear-erro');
    });

    await step('pareamento: com o código certo, o console vira uma fonte escolhida', async () => {
      await page.fill('#ps5-pin', '12345678');
      await page.click('#ps5-pair-submit');
      await page.waitForSelector('#ps5-pair', { state: 'hidden', timeout: 10_000 });
      await page.waitForSelector('.source-card.ps5-card.selected:has-text("PS5-Teste")');
      await page.waitForFunction(() => /Ligado/.test(document.querySelector('.ps5-card .source-detail').textContent), null, { timeout: 10_000 });
      assert.equal(await page.isVisible('#audio-mode'), false, 'o PS5 não tem escolha de apps no som');
      assert.equal(await page.isVisible('#ps5-forget'), true);
      assert.match(await page.textContent('#audio-hint'), /direto do PS5/);
      assert.equal(await page.isDisabled('#picker-start'), false);
      await shot(page, '04-console-pareado');
    });

    await step('transmite o PS5: no ar, com a imagem na prévia e o som do jogo', async () => {
      await page.check('#share-audio');
      await page.click('#picker-start');
      await page.waitForSelector('#share-live:not([hidden])', { timeout: 20_000 });
      assert.match(await page.textContent('#share-source'), /PS5-Teste · com som/);
      assert.equal((await page.textContent('#share-audio-text')).trim(), 'Som do jogo, direto do PS5.');
      await page.waitForFunction(() => document.querySelector('#local-preview').videoWidth > 0, null, { timeout: 10_000 });
      const size = await page.evaluate(() => { const v = document.querySelector('#local-preview'); return [v.videoWidth, v.videoHeight]; });
      assert.deepEqual(size, [640, 360]);
      // A imagem anda (não é um quadro parado).
      const t0 = await page.evaluate(() => document.querySelector('#local-preview').currentTime);
      await page.waitForTimeout(1500);
      const t1 = await page.evaluate(() => document.querySelector('#local-preview').currentTime);
      assert.ok(t1 > t0, 'a prévia não avançou');
      await page.waitForTimeout(600);
      const level = await page.evaluate(() => Number(getComputedStyle(document.querySelector('#share-meter')).getPropertyValue('--level')));
      assert.ok(level > 0.2, `medidor de som parado (${level})`);
      await shot(page, '05-no-ar');
    });

    await step('transmitir o PS5 de novo, já no ar, troca a sessão sem cair', async () => {
      await page.click('#switch-btn');
      await page.waitForSelector('#picker[open] .source-card.ps5-card.selected', { timeout: 10_000 });
      const t0 = await page.textContent('#on-air-time');
      await page.click('#picker-start');
      await page.waitForTimeout(4000);
      assert.equal(await page.isVisible('#share-live'), true, 'saiu do ar na troca');
      const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast.warn, .toast.error')].map((t) => t.textContent));
      assert.deepEqual(toasts, [], 'a troca não pode avisar que a transmissão caiu');
      await page.waitForFunction(() => document.querySelector('#local-preview').videoWidth === 640, null, { timeout: 10_000 });
      const before = await page.evaluate(() => document.querySelector('#local-preview').currentTime);
      await page.waitForTimeout(1200);
      assert.ok(await page.evaluate(() => document.querySelector('#local-preview').currentTime) > before, 'a imagem parou depois da troca');
      assert.notEqual(await page.textContent('#on-air-time'), t0, 'o tempo no ar continua contando');
    });

    await step('pausa e retoma sem derrubar o PS5', async () => {
      await page.click('#pause-btn');
      await page.waitForSelector('#share-live.paused');
      await page.click('#pause-btn');
      await page.waitForSelector('#share-live:not(.paused)');
      assert.equal(await page.isVisible('#share-live'), true);
    });

    await step('parar a transmissão encerra o receptor', async () => {
      await page.click('#share-btn');
      await page.waitForSelector('#share-live', { state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      const log = fs.readFileSync(path.join(userData, 'logs', 'ps5.log'), 'utf8');
      assert.match(log, /telao-ps5 stream 127\.0\.0\.1 1080p@/);
    });

    await step('PS5 em repouso: o Telão acorda e transmite', async () => {
      fs.writeFileSync(STATE_FILE, 'standby');
      await page.click('#share-btn');
      await page.waitForSelector('#picker[open] .tab[data-tab="ps5"]');
      await page.click('.tab[data-tab="ps5"]');
      await page.waitForFunction(() => /Em repouso/.test(document.querySelector('.ps5-card .source-detail')?.textContent || ''), null, { timeout: 10_000 });
      await page.click('.source-card.ps5-card');
      await page.click('#picker-start');
      await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /acordando/.test(t.textContent)), null, { timeout: 10_000 });
      await page.waitForSelector('#share-live:not([hidden])', { timeout: 30_000 });
      await page.click('#share-btn');
      await page.waitForSelector('#share-live', { state: 'hidden', timeout: 10_000 });
    });

    await step('o console continua pareado e dá para esquecer', async () => {
      await page.click('#share-btn');
      await page.waitForSelector('#picker[open] .source-card.ps5-card.selected', { timeout: 10_000 });
      await page.click('#ps5-forget');
      await page.waitForSelector('#confirm[open]');
      await page.click('#confirm-ok');
      await page.waitForSelector('.source-card.ps5-card', { state: 'detached', timeout: 10_000 });
      assert.equal(await page.locator('#source-grid .source-card').count(), 1, 'sobra só "Parear um PS5"');
      const stored = JSON.parse(fs.readFileSync(path.join(userData, 'ps5.json'), 'utf8'));
      assert.deepEqual(stored.consoles, []);
      await page.click('#picker-close');
    });

    await step('até o fim, nenhuma janela apareceu', async () => {
      assert.equal(await noneVisible(), true);
    });
  } catch (err) {
    failures += 1;
    console.error(err);
  } finally {
    await app.close().catch(() => {});
    await signaling.close?.();
    server.close();
    fs.rmSync(STATE_FILE, { force: true });
    if (userData && path.basename(userData).endsWith(PROFILE)) fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} falha(s).` : '\nTudo certo.');
  process.exit(failures ? 1 : 0);
})();
