'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const {
  app, BrowserWindow, Menu, clipboard, desktopCapturer, ipcMain, powerSaveBlocker, screen, session, shell,
} = require('electron');
const { attachSignaling, turnServers, DEFAULT_ICE_SERVERS } = require('../../server/signaling');
const { findCloudflared, startTunnel, downloadCloudflared } = require('./tunnel');
const { AppAudio, DEFAULT_EXCLUDED_APPS } = require('./app-audio');

// "--profile=nome" usa uma pasta de dados separada, permitindo abrir duas
// instâncias no mesmo PC (útil para testar).
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) {
  const profile = profileArg.slice('--profile='.length).replace(/[^\w-]/g, '');
  if (profile) app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()}-${profile}`));
}

const ICON_PATH = path.join(__dirname, '..', 'renderer', 'assets', 'icon.png');

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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#0d1117',
    title: 'Telão',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    show: false,
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
  mainWindow.on('closed', () => { mainWindow = null; });
}

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

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  const ownWindowId = mainWindow ? mainWindow.getMediaSourceId() : null;
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const screenInfo = describeScreens(screens);
  const result = screens.map((s, i) => ({
    id: s.id,
    type: 'screen',
    name: screenInfo[i].name,
    detail: screenInfo[i].detail,
    thumbnail: s.thumbnail.toDataURL(),
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
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Telão: servidor de sinalização ativo.\n');
  });
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
}));

ipcMain.handle('appaudio:start', (_event, options = {}) => appAudio.start({
  session: String(options.session || ''),
  mode: options.mode === 'app' ? 'app' : 'all',
  sourceId: options.sourceId,
  exclude: options.exclude,
}));
ipcMain.handle('appaudio:stop', (_event, session) => appAudio.stop(String(session)));

ipcMain.handle('clipboard:write', (_event, text) => clipboard.writeText(String(text)));

ipcMain.handle('power:keep-awake', (_event, on) => {
  if (on && powerBlockerId === null) powerBlockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!on && powerBlockerId !== null) {
    powerSaveBlocker.stop(powerBlockerId);
    powerBlockerId = null;
  }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  setupDisplayMedia();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => appAudio.stop());

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !hosted) return;
  event.preventDefault();
  quitting = true;
  stopHosted().finally(() => app.quit());
});
