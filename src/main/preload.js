'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// API mínima exposta à interface (a página não tem acesso ao Node).
contextBridge.exposeInMainWorld('telao', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (sourceId, withAudio) => ipcRenderer.invoke('sources:select', sourceId, withAudio),
  startServer: (options) => ipcRenderer.invoke('server:start', options),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  startTunnel: () => ipcRenderer.invoke('tunnel:start'),
  downloadCloudflared: () => ipcRenderer.invoke('tunnel:download'),
  onTunnelProgress: (callback) => ipcRenderer.on('tunnel:progress', (_event, fraction) => callback(fraction)),
  onTunnelClosed: (callback) => ipcRenderer.on('tunnel:closed', () => callback()),
  startAppAudio: (options) => ipcRenderer.invoke('appaudio:start', options),
  stopAppAudio: (session) => ipcRenderer.invoke('appaudio:stop', session),
  onAppAudioData: (callback) => ipcRenderer.on('appaudio:data', (_event, session, id, payload) => callback(session, id, payload)),
  onAppAudioEvent: (callback) => ipcRenderer.on('appaudio:event', (_event, session, data) => callback(session, data)),
  setAppearance: (options) => ipcRenderer.invoke('appearance:set', options),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  keepAwake: (on) => ipcRenderer.invoke('power:keep-awake', on === true),
});
