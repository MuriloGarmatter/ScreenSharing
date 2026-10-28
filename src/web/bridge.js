// Telão no navegador (iPhone, Android, Mac, Linux): esta ponte faz o papel do
// preload do Electron (window.telao). O que só existe no app do Windows (bandeja,
// atalhos globais, som por app, hospedar no PC, atualização) fica de fora; o resto
// usa o equivalente do navegador. scripts/build-web.js põe a versão no lugar de
// __TELAO_VERSION__ e carrega este arquivo antes de tudo na página.
(function () {
  'use strict';

  const VERSION = '__TELAO_VERSION__';
  const ua = navigator.userAgent;
  // O iPadOS se apresenta como um Mac: o toque denuncia.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  const mobile = ios || android;
  // Transmitir a tela pelo navegador só dá no computador (iPhone e Android não deixam).
  const canShareScreen = !mobile && typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const root = document.documentElement;
  root.classList.add('web');
  if (ios) root.classList.add('ios');
  if (mobile) root.classList.add('mobile');

  const noop = async () => {};
  const onlyOnWindows = async () => { throw new Error('Isso só existe no Telão para Windows.'); };

  // Tela acesa enquanto você assiste. O navegador solta a trava quando a página
  // some (outro app, tela bloqueada); ao voltar, ela é pedida de novo.
  let wantAwake = false;
  let lock = null;
  async function syncWakeLock() {
    if (!('wakeLock' in navigator)) return;
    try {
      if (wantAwake && !lock && document.visibilityState === 'visible') {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!wantAwake && lock) {
        await lock.release();
        lock = null;
      }
    } catch { /* sem permissão (ou bateria fraca): segue sem */ }
  }
  document.addEventListener('visibilitychange', syncWakeLock);

  window.telao = {
    appInfo: async () => ({
      version: VERSION, platform: 'web', web: true, mobile, ios, canShareScreen,
      // Pelo navegador do computador, o som vai junto se o navegador oferecer.
      systemAudio: canShareScreen, appAudio: false, selfExe: '', defaultExcludedApps: [],
      integratedTitleBar: false,
    }),
    // A lista do que transmitir é a do navegador: aqui só uma opção, "pergunte".
    listSources: async () => (canShareScreen
      ? [{ id: 'web', type: 'screen', name: 'Tela, janela ou aba', detail: 'O navegador pergunta qual', thumbnail: null }]
      : []),
    selectSource: noop,
    startServer: onlyOnWindows,
    stopServer: noop,
    startTunnel: onlyOnWindows,
    downloadCloudflared: onlyOnWindows,
    onTunnelProgress: () => {},
    onTunnelClosed: () => {},
    startAppAudio: onlyOnWindows,
    stopAppAudio: noop,
    listAudioApps: async () => [],
    onAppAudioData: () => {},
    onAppAudioEvent: () => {},
    // O convite vem no endereço (/app/?sala=nome, o botão "Entrar pelo navegador"
    // da página do convite). Fica no endereço de propósito: "Adicionar à Tela de
    // Início" guarda o atalho já com a sala da turma.
    takePendingInvite: async () => {
      const room = new URLSearchParams(location.search).get('sala');
      if (!room) return null;
      const invite = `${location.origin}/${encodeURIComponent(room)}`;
      return `telao://entrar/?convite=${encodeURIComponent(invite)}`;
    },
    onInvite: () => {},
    readClipboard: async () => '', // ler a área de transferência pediria permissão a cada vez
    setStatus: async () => [], // sem bandeja nem atalhos globais
    onCommand: () => {},
    attention: noop,
    showWindow: noop,
    setAppearance: async () => (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'),
    copyText: (text) => navigator.clipboard.writeText(text),
    keepAwake: async (on) => {
      wantAwake = on === true;
      await syncWakeLock();
    },
    getUpdateStatus: async () => ({ status: 'idle' }), // a versão web é sempre a mais nova
    onUpdateStatus: () => {},
    installUpdate: noop,
    quitApp: noop,
  };
})();
