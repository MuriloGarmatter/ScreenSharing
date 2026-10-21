'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const {
  app, BrowserWindow, Menu, Notification, Tray, clipboard, desktopCapturer, globalShortcut, ipcMain,
  nativeImage, nativeTheme, powerSaveBlocker, screen, session, shell,
} = require('electron');
const { attachSignaling, turnServers, DEFAULT_ICE_SERVERS } = require('../../server/signaling');
const { handleHttpRequest } = require('../../server/invite-page');
const { findCloudflared, startTunnel, downloadCloudflared } = require('./tunnel');
const { AppAudio, DEFAULT_EXCLUDED_APPS } = require('./app-audio');
const { autoUpdater } = require('electron-updater');
const { normalizeAppearance, titleBarOverlay } = require('./appearance');

// No Windows a barra superior do app é a barra de título (sem a moldura padrão).
const INTEGRATED_TITLE_BAR = process.platform === 'win32';
const { PROTOCOL, findDeepLink } = require('./deeplink');

// "--profile=nome" usa uma pasta de dados separada, permitindo abrir duas
// instâncias no mesmo PC (útil para testar).
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) {
  const profile = profileArg.slice('--profile='.length).replace(/[^\w-]/g, '');
  if (profile) app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()}-${profile}`));
}

const ASSETS = path.join(__dirname, '..', 'renderer', 'assets');
const ICON_PATH = path.join(ASSETS, 'icon.png');

// Notificações do Windows precisam do id do app (o mesmo do instalador).
if (process.platform === 'win32') app.setAppUserModelId('br.telao.app');

// Uma janela por perfil: abrir de novo (ou clicar num convite telao://) traz a
// janela que já existe e repassa o convite para ela.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();
let pendingDeepLink = findDeepLink(process.argv);

let mainWindow = null;
let pendingCapture = { sourceId: null, audio: false };

// O executável auxiliar fica fora do app.asar (não dá para executar de dentro dele).
const appAudio = new AppAudio({
  helperPath: app.isPackaged
    ? path.join(process.resourcesPath, 'telao-audio.exe')
    : path.join(__dirname, '..', '..', 'resources', 'telao-audio.exe'),
  send: (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  },
});
let hosted = null; // { httpServer, signaling, port, tunnel }
let powerBlockerId = null;

// ---------- Aparência ----------
// A interface guarda tema e cor; aqui fica só o necessário antes de ela carregar:
// o tema nativo e a cor de fundo da janela (evita piscar escuro no tema claro).

const appearanceFile = () => path.join(app.getPath('userData'), 'appearance.json');

function readAppearance() {
  try {
    return normalizeAppearance(JSON.parse(fs.readFileSync(appearanceFile(), 'utf8')));
  } catch {
    return normalizeAppearance(null);
  }
}

/** Troca o tema nativo e devolve o modo que vale agora ('dark' ou 'light'). */
function applyNativeTheme(theme) {
  nativeTheme.themeSource = theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

// Devolve o modo efetivo: com "Igual ao Windows" só aqui se sabe o certo na hora.
ipcMain.handle('appearance:set', (_event, options = {}) => {
  const current = readAppearance();
  const next = normalizeAppearance(options, current);
  const mode = applyNativeTheme(next.theme);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setBackgroundColor(next.backgrounds[mode]);
    if (INTEGRATED_TITLE_BAR) mainWindow.setTitleBarOverlay(titleBarOverlay(mode));
  }
  if (JSON.stringify(next) !== JSON.stringify(current)) {
    try {
      fs.writeFileSync(appearanceFile(), JSON.stringify(next));
    } catch (err) {
      console.warn('Não foi possível salvar a aparência:', err.message);
    }
  }
  return mode;
});

function createWindow() {
  const appearance = readAppearance();
  const mode = applyNativeTheme(appearance.theme);
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: appearance.backgrounds[mode],
    title: 'Telão',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show: false,
    // Barra de título integrada: os botões do Windows ficam sobre a barra do app.
    ...(INTEGRATED_TITLE_BAR ? { titleBarStyle: 'hidden', titleBarOverlay: titleBarOverlay(mode) } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      // Quem transmite costuma minimizar o app: não desacelerar nada em segundo plano.
      backgroundThrottling: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toUpperCase() === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// ---------- Convites clicáveis (telao://) ----------

function registerProtocol() {
  // Em desenvolvimento não registra, para não tomar o link do app instalado.
  if (!app.isPackaged) return;
  // Com o Telão aberto, o link aponta para esta cópia em execução: o clique cai
  // direto no requestSingleInstanceLock. (Na portátil, apontar para o .exe
  // portátil faria o lançador extrair de novo por cima da cópia em uso.)
  app.setAsDefaultProtocolClient(PROTOCOL);
}

// Ao sair, a portátil devolve o link ao .exe portátil, que extrai e abre o Telão.
function restoreProtocolForPortable() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (app.isPackaged && portable) app.setAsDefaultProtocolClient(PROTOCOL, portable, []);
}

function deliverDeepLink(link) {
  if (!link) return;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send('invite:open', link);
  } else {
    pendingDeepLink = link;
  }
}

app.on('second-instance', (_event, argv) => {
  showWindow();
  deliverDeepLink(findDeepLink(argv));
});

ipcMain.handle('window:show', () => showWindow());

ipcMain.handle('invite:pending', () => {
  const link = pendingDeepLink;
  pendingDeepLink = null;
  return link;
});

// ---------- Bandeja, selo "ao vivo" na barra de tarefas e atalhos globais ----------

let tray = null;
let liveStatus = { inRoom: false, sharing: false, paused: false };
// Atalhos que valem até com o jogo em primeiro plano (só enquanto está numa sala).
const SHORTCUTS = { 'Control+Alt+P': 'pause-toggle', 'Control+Alt+T': 'share-toggle' };
let shortcutsOn = false;

async function sendCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Começar a transmitir chama o getDisplayMedia, que o Chromium só aceita logo
  // depois de um gesto do usuário, e a tecla do atalho global não chega à página.
  // executeJavaScript com userGesture=true marca esse gesto (vale uns 5 s).
  if (command === 'share-toggle') await mainWindow.webContents.executeJavaScript('0', true).catch(() => {});
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send('command', command);
}

function updateTray() {
  const { sharing, paused } = liveStatus;
  if (tray) {
    tray.setImage(path.join(ASSETS, sharing ? 'tray-live.png' : 'tray.png'));
    tray.setToolTip(sharing ? (paused ? 'Telão: transmissão pausada' : 'Telão: no ar') : 'Telão');
    const items = [{ label: 'Abrir o Telão', click: showWindow }];
    if (updateState.status === 'ready') {
      items.push({ label: `Reiniciar e atualizar para a ${updateState.version}`, click: installUpdate });
    }
    if (sharing) {
      items.push(
        { type: 'separator' },
        { label: paused ? 'Retomar transmissão' : 'Pausar transmissão', accelerator: 'Ctrl+Alt+P', click: () => sendCommand('pause-toggle') },
        { label: 'Parar transmissão', click: () => sendCommand('share-stop') },
      );
    }
    items.push({ type: 'separator' }, { label: 'Sair do Telão', click: () => app.quit() });
    tray.setContextMenu(Menu.buildFromTemplate(items));
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    const badge = sharing ? nativeImage.createFromPath(path.join(ASSETS, 'live-badge.png')) : null;
    mainWindow.setOverlayIcon(badge, sharing ? 'Ao vivo' : '');
  }
}

function createTray() {
  tray = new Tray(path.join(ASSETS, 'tray.png'));
  tray.on('click', showWindow);
  updateTray();
}

/** Liga/desliga os atalhos globais; devolve os que outro programa já usa. */
function setShortcuts(on) {
  if (on === shortcutsOn) return [];
  shortcutsOn = on;
  if (!on) {
    for (const key of Object.keys(SHORTCUTS)) globalShortcut.unregister(key);
    return [];
  }
  const taken = [];
  for (const [key, command] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.register(key, () => sendCommand(command))) taken.push(key.replace('Control', 'Ctrl'));
  }
  return taken;
}

ipcMain.handle('status:set', (_event, status = {}) => {
  liveStatus = { inRoom: status.inRoom === true, sharing: status.sharing === true, paused: status.paused === true };
  updateTray();
  return setShortcuts(liveStatus.inRoom);
});

// Chama a atenção quando a janela não está em foco (alguém começou a transmitir).
// As notificações ficam guardadas até sumirem: se o coletor de lixo levasse o
// objeto, o clique nela deixaria de trazer a janela.
const NOTIFY_MIN_INTERVAL_MS = 8000;
const liveNotifications = new Set();
let lastNotificationAt = 0;

ipcMain.handle('attention', (_event, options = {}) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  mainWindow.flashFrame(true);
  if (!Notification.isSupported() || Date.now() - lastNotificationAt < NOTIFY_MIN_INTERVAL_MS) return;
  lastNotificationAt = Date.now();
  const notification = new Notification({
    title: String(options.title || 'Telão').slice(0, 80),
    body: String(options.body || '').slice(0, 200),
    icon: ICON_PATH,
    silent: true,
  });
  const forget = () => liveNotifications.delete(notification);
  notification.on('click', () => { forget(); showWindow(); });
  notification.on('close', forget);
  notification.on('failed', forget);
  liveNotifications.add(notification);
  notification.show();
});

// ---------- Captura de tela ----------

function describeScreens(sources) {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  let index = 0;
  return sources.map((s) => {
    index += 1;
    const display = displays.find((d) => String(d.id) === s.display_id);
    if (!display) return { name: `Tela ${index}`, detail: '' };
    const w = Math.round(display.size.width * display.scaleFactor);
    const h = Math.round(display.size.height * display.scaleFactor);
    const primary = display.id === primaryId ? ' · principal' : '';
    return { name: `Tela ${index}`, detail: `${w}×${h}${primary}`, width: w, height: h };
  });
}

ipcMain.handle('sources:list', async (_event, options) => {
  // Sem miniaturas a lista sai bem mais rápido (o atalho Ctrl+Alt+T usa assim).
  const thumbnails = options?.thumbnails !== false;
  const size = { width: 400, height: 225 };
  const none = { width: 0, height: 0 };
  const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumbnails ? size : none });
  // Miniatura de janela custa caro: o Windows desenha cada janela aberta (até a do
  // jogo) e o PC engasga. Só quando a aba Janelas pede; o ícone é barato.
  const windows = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: thumbnails && options?.windowThumbnails ? size : none,
    fetchWindowIcons: thumbnails,
  });
  const sources = [...screens, ...windows];
  const ownWindowId = mainWindow ? mainWindow.getMediaSourceId() : null;
  const screenInfo = describeScreens(screens);
  const result = screens.map((s, i) => ({
    id: s.id,
    type: 'screen',
    name: screenInfo[i].name,
    detail: screenInfo[i].detail,
    thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
  }));
  for (const s of sources) {
    if (!s.id.startsWith('window:') || s.id === ownWindowId || !s.name) continue;
    result.push({
      id: s.id,
      type: 'window',
      name: s.name,
      detail: '',
      thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    });
  }
  return result;
});

ipcMain.handle('sources:select', (_event, sourceId, withAudio) => {
  pendingCapture = { sourceId: String(sourceId || ''), audio: withAudio === true };
});

function setupDisplayMedia() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((s) => s.id === pendingCapture.sourceId);
      if (!source) return callback(null);
      const streams = { video: source };
      // Áudio do sistema (loopback) só existe no Windows.
      if (pendingCapture.audio && request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (err) {
      console.error('Falha ao preparar captura:', err);
      callback(null);
    }
  });

  const allowed = new Set(['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'screen-wake-lock']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
}

// ---------- Servidor hospedado neste PC ----------

function lanAddresses() {
  const list = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family === 'IPv4' && !e.internal) list.push({ name, address: e.address });
    }
  }
  return list;
}

async function stopHosted() {
  if (!hosted) return;
  const current = hosted;
  hosted = null;
  if (current.tunnel) current.tunnel.stop();
  await current.signaling.close();
  await new Promise((resolve) => current.httpServer.close(() => resolve()));
}

ipcMain.handle('server:start', async (_event, options = {}) => {
  await stopHosted();
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Porta inválida (use entre 1024 e 65535).');
  const iceServers = [...DEFAULT_ICE_SERVERS, ...turnServers(options.turn)];
  // HTTP: a página do convite (quem abre o link no navegador) e a verificação de saúde.
  const httpServer = http.createServer(handleHttpRequest);
  const signaling = attachSignaling(httpServer, {
    password: typeof options.password === 'string' ? options.password : '',
    getIceServers: async () => iceServers,
  });
  try {
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, resolve);
    });
  } catch (err) {
    await signaling.close();
    if (err.code === 'EADDRINUSE') throw new Error(`A porta ${port} já está em uso. Escolha outra.`);
    throw err;
  }
  hosted = { httpServer, signaling, port, tunnel: null };
  return { port, addresses: lanAddresses() };
});

ipcMain.handle('server:stop', () => stopHosted());

ipcMain.handle('tunnel:start', async () => {
  if (!hosted) throw new Error('Nenhum servidor hospedado.');
  if (hosted.tunnel) return { url: hosted.tunnel.url };
  const exe = findCloudflared(path.join(app.getPath('userData'), 'bin'));
  if (!exe) return { missing: true };
  const current = hosted;
  const tunnel = await startTunnel(exe, current.port);
  if (hosted !== current) { tunnel.stop(); throw new Error('O servidor foi encerrado.'); }
  const url = tunnel.url.replace(/^https:/, 'wss:');
  current.tunnel = { url, stop: tunnel.stop };
  tunnel.process.once('exit', () => {
    if (hosted === current && current.tunnel && current.tunnel.url === url) {
      current.tunnel = null;
      mainWindow?.webContents.send('tunnel:closed');
    }
  });
  return { url };
});

ipcMain.handle('tunnel:download', async () => {
  await downloadCloudflared(path.join(app.getPath('userData'), 'bin'), (fraction) => {
    mainWindow?.webContents.send('tunnel:progress', fraction);
  });
  return true;
});

// ---------- Utilidades ----------

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  systemAudio: process.platform === 'win32',
  appAudio: appAudio.supported,
  defaultExcludedApps: DEFAULT_EXCLUDED_APPS,
  selfExe: path.basename(process.execPath),
  integratedTitleBar: INTEGRATED_TITLE_BAR,
}));

ipcMain.handle('appaudio:start', (_event, options = {}) => appAudio.start({
  session: String(options.session || ''),
  mode: ['app', 'pick'].includes(options.mode) ? options.mode : 'all',
  sourceId: options.sourceId,
  exclude: options.exclude,
  include: options.include,
}));
ipcMain.handle('appaudio:stop', (_event, session) => appAudio.stop(String(session)));
ipcMain.handle('appaudio:list', () => appAudio.listApps());

ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(String(text)));
// Só o texto, e curto: a interface procura nele um convite copiado.
// (Conforme a versão do Electron, readText devolve o texto ou uma Promise.)
ipcMain.handle('clipboard:read', async () => {
  const text = await clipboard.readText();
  return typeof text === 'string' ? text.slice(0, 500) : '';
});

ipcMain.handle('power:keep-awake', (_event, on) => {
  if (on && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
});

// ---------- Atualização automática ----------
// As versões saem no GitHub (repositório público). Instalado pelo Setup, o Telão baixa
// a nova sozinho e instala ao fechar, ou na hora pelo botão "Reiniciar e atualizar".
// O portátil não consegue se substituir: só avisa e abre a página para baixar.

const PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);
const RELEASES_URL = 'https://github.com/MuriloGarmatter/ScreenSharing/releases/latest';
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
// status: idle | downloading | ready (instalado, já baixada) | available (portátil) | none | error
let updateState = { status: 'idle', version: '', percent: 0, portable: PORTABLE };

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update:status', updateState);
  updateTray();
}

function installUpdate() {
  if (updateState.status === 'ready') {
    // Instala em silêncio e abre o Telão de novo já atualizado.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return true;
  }
  if (updateState.status === 'available') {
    shell.openExternal(RELEASES_URL);
    return true;
  }
  return false;
}

function setupUpdates() {
  if (!app.isPackaged) return; // rodando pelo código (npm start): sem atualização
  autoUpdater.allowPrerelease = true; // as versões saem como "pré-lançamento" no GitHub
  autoUpdater.autoDownload = !PORTABLE;
  autoUpdater.autoInstallOnAppQuit = !PORTABLE;
  autoUpdater.on('update-available', (info) => {
    setUpdateState({ status: PORTABLE ? 'available' : 'downloading', version: info.version, percent: 0 });
  });
  autoUpdater.on('download-progress', (progress) => setUpdateState({ status: 'downloading', percent: Math.round(progress.percent) }));
  autoUpdater.on('update-downloaded', (info) => setUpdateState({ status: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'none' }));
  autoUpdater.on('error', (err) => {
    console.warn('Atualização:', err?.message || err);
    // Um erro na checagem não apaga uma atualização que já está pronta.
    if (updateState.status !== 'ready') setUpdateState({ status: 'error' });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15_000); // depois de abrir, sem atrasar a entrada na sala
  setInterval(check, UPDATE_CHECK_MS);
}

ipcMain.handle('update:status', () => updateState);
ipcMain.handle('update:install', () => installUpdate());

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  registerProtocol();
  setupDisplayMedia();
  createWindow();
  createTray();
  setupUpdates();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  appAudio.stop();
  if (tray) tray.destroy();
  if (gotSingleInstanceLock) restoreProtocolForPortable();
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !hosted) return;
  event.preventDefault();
  quitting = true;
  stopHosted().finally(() => app.quit());
});
