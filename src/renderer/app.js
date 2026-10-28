import {
  DEFAULT_PORT, PUBLIC_SERVER, inviteLink, parseDeepLink, parseInviteText, parseServerAddress,
} from './address.js';
import { AppAudioCapture, LevelMeter, exeLabel, routeAppAudioData, routeAppAudioEvent } from './app-audio.js';
import { Mesh, REACTIONS, supportsCamera, supportsVoice } from './mesh.js';
import {
  AUDIO_CONSTRAINTS, BITRATES, CAMERA_CONSTRAINTS, CODECS, cameraErrorMessage, micErrorMessage, voiceConstraints, DEFAULT_SHARE_SETTINGS, FRAME_RATES, OPTIMIZE, QUALITY_PRESETS, RESOLUTIONS,
  detectHardwareH264, effectiveFps, matchPreset, presetSpec, resolveCodec, suggestLowerSettings, targetBitrate,
  videoConstraints, wantedHeight,
} from './media.js';
import { bestColumns } from './layout.js';
import { outdatedPeers } from './version.js';
import { playSound, primeSounds } from './sounds.js';
import {
  LIMITATION_TEXT, SIGNAL_TEXT, StatsTracker, describeRoute, hardwareLabel, levelFrom, limitReason, peerSignal,
} from './stats.js';
import { $, $$, el, formatBitrate, formatFps, hydrateIcons, icon, toast } from './ui.js';

const api = window.telao;
const Theme = window.TelaoTheme; // theme.js, carregado antes no <head>
const PREFS_KEY = Theme.PREFS_KEY; // a mesma chave que o theme.js lê na abertura
const SUGGEST_AFTER_SECONDS = 8; // limitação contínua antes de sugerir algo mais leve
const SUGGEST_SNOOZE_MS = 5 * 60 * 1000;
const STATS_INTERVAL_MS = 2000; // estatísticas (sinal, envio, sugestões): a cada 2 s pesa menos
const PREVIEW_FPS = 5; // a prévia de "Sua transmissão" é só para conferir

const state = {
  info: { systemAudio: false, appAudio: false, defaultExcludedApps: [] },
  mesh: null,
  inRoom: false,
  joining: false,
  serverUrl: '',
  hosting: null, // { port, addresses, publicUrl, tunnel: 'off'|'starting'|'on'|'missing'|'error', tunnelError, download }
  share: null, // { stream, source, audio, audioMode: 'all'|'app'|'pick'|'system'|'none', appAudio, meter, preview, paused }
  camera: null, // { stream, track }: a minha câmera, ligada
  cameraStarting: false,
  mic: null, // o meu microfone, ligado: { ctx, gate, outTrack, input, source, level, open, threshold } (ver startMic)
  micStarting: false,
  deafened: false, // "Silenciar vozes": não ouço ninguém (vale só nesta sessão)
  micBeforeDeafen: false,
  voices: new Map(), // peerId -> { audio, source, gain }: a voz da pessoa (ver syncVoice)
  voiceCtx: null, // o AudioContext onde as vozes tocam (com o volume de cada uma)
  speaking: new Map(), // id (ou 'me') -> hora em que falou por último
  speakingTimer: null,
  starting: null, // marca do início de transmissão em andamento (sair da sala a invalida)
  pendingInvite: null, // convite clicado enquanto ainda conectava: abre quando a tentativa termina
  meterTimer: null,
  clockTimer: null, // relógio do tempo no ar
  tiles: new Map(), // peerId (tela) ou peerId:cam (câmera) -> monitor
  trackers: new Map(), // peerId -> StatsTracker
  statsTimer: null,
  picker: { sources: [], tab: 'screen', selected: null, windowThumbs: false, loads: 0 },
  pinned: null, // chave do monitor em destaque
  sharingPeers: new Set(), // quem está transmitindo (para avisar quando alguém começa)
  lastAnnounce: new Map(), // peerId -> hora do último aviso "começou a transmitir"
  hwH264: false, // a placa de vídeo comprime H.264?
  limit: { reason: null, seconds: 0 },
  suggestion: null,
  suggestSnoozeUntil: 0,
  shortcutWarned: false,
  clipboardInvite: null,
  clipboardText: '',
  clipboardDismissed: '',
  pickApps: [],
  pickStale: false, // a lista de apps com som é refeita a cada vez que o seletor abre
  reactionTimes: [],
  hiddenLong: false, // Telão escondido há alguns segundos: só o som das transmissões chega
  hiddenTimer: null,
  viewTimer: null,
  resizeObserver: typeof ResizeObserver === 'function' ? new ResizeObserver(() => scheduleViewSync()) : null,
  capWarned: false, // aviso de "30 fps sem placa de vídeo" já mostrado nesta transmissão
  update: null, // { status, version, percent, portable } vindo do processo principal
  updateDismissed: '', // a versão cuja faixa na sala foi dispensada ("Agora não")
  joinedAs: 'join', // como entrei na sala atual: 'host' (criei) ou 'join' (convite)
  passwordFor: '', // o servidor que pediu senha: só para ele o campo Senha aparece
  airState: 'off', // 'off' | 'live' | 'paused': o leitor de tela é avisado quando muda
};

const prefs = loadPrefs();

// ---------- Preferências ----------

function loadPrefs() {
  const defaults = {
    name: '', room: '', mode: 'join',
    serverUrl: '',
    // Criar sala: 'cloud' = no servidor do Telão (link fixo), 'pc' = este PC hospeda.
    hostWhere: 'cloud',
    hostPort: DEFAULT_PORT, tunnel: true,
    turnUrls: '', turnUsername: '', turnCredential: '',
    share: { ...DEFAULT_SHARE_SETTINGS }, audio: true, antiEcho: true,
    // Som: 'all' = todos os apps menos os excluídos, 'app' = só o app da janela,
    // 'pick' = só os apps escolhidos, 'system' = tudo, sem filtro.
    audioModeScreen: 'all', audioModeWindow: 'app',
    audioExclude: null, // null = lista padrão
    audioPick: [], // nomes dos apps escolhidos em 'pick'
    appearance: null, // { theme, accent }; null = padrão (ver theme.js)
    sounds: true,
    volumes: {}, // nome da pessoa -> { volume, muted }
    lastShare: null, // { id, type, name, audio }: para o atalho começar direto
    copiedInvites: [], // convites que eu mesmo copiei (não viram a faixa "você copiou um convite")
    consoleHidden: false, // painel da sala (coluna da direita) recolhido
    cameraId: '', // a última câmera usada
    micOn: false, // o microfone liga sozinho ao entrar (a última escolha)
    micId: '', // o último microfone usado
    voiceVolumes: {}, // nome da pessoa -> { volume, muted } da voz
    // Ajustes do microfone (como no Discord): sensibilidade automática ou o limite em
    // dB, e o tratamento do Chromium (redução de ruído, cancelamento de eco, ganho).
    voiceAuto: true, voiceThreshold: -50,
    voiceNoise: true, voiceEcho: true, voiceGain: true,
  };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    // Senhas não são guardadas (versões antigas guardavam: descarta).
    delete saved.serverPassword;
    delete saved.hostPassword;
    return { ...defaults, ...saved, share: { ...defaults.share, ...(saved.share || {}) } };
  } catch {
    return defaults;
  }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* sem armazenamento */ }
}

function cleanError(err) {
  const message = String(err?.message || err || 'Erro desconhecido.');
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

function randomRoom() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `sala-${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 7)}`;
}

function chime(kind) {
  if (prefs.sounds !== false) playSound(kind);
}

// ---------- No navegador (iPhone, Android, Mac) ----------
// O mesmo app roda no navegador (ver src/web/bridge.js): o que é do Windows some
// (atalhos globais, bandeja, hospedar no PC, som por app) e o resto se ajusta.

const isWeb = () => state.info.web === true;
/** Dá para transmitir a tela aqui? No iPhone e no Android, o navegador não deixa. */
const canShareScreen = () => !isWeb() || state.info.canShareScreen === true;
/** O atalho no fim de uma dica, " (Ctrl+Alt+M)": só no app do Windows, onde ele existe. */
const keyHint = (combo) => (isWeb() ? '' : ` (${combo})`);

/** O som da sala (vozes e, no navegador, também as telas) toca neste AudioContext. */
function roomAudio() {
  state.voiceCtx ||= new AudioContext({ latencyHint: 'interactive' });
  return state.voiceCtx;
}

/**
 * No iPhone o som só sai depois de um toque na página. Entrar na sala (um toque)
 * já libera; se a página entrou sozinha pelo convite, ou o iPhone suspendeu o som,
 * uma tecla pede o toque (ver unlockAudio).
 */
function checkAudioRunning() {
  const ctx = state.voiceCtx;
  if (!ctx) return;
  ctx.resume().catch(() => {});
  setTimeout(() => {
    if (state.voiceCtx === ctx && state.inRoom && ctx.state !== 'running') $('#audio-unlock').hidden = false;
  }, 600);
}

function unlockAudio() {
  $('#audio-unlock').hidden = true;
  primeSounds();
  roomAudio().resume().catch(() => {});
  for (const tile of state.tiles.values()) tile.video.play().catch(() => {});
  for (const voice of state.voices.values()) voice.audio.play().catch(() => {});
  applyAudioRouting();
}

// ---------- Tela de entrada ----------

function restoreJoinForm() {
  $('#name').value = prefs.name;
  // Só quem hospeda ganha um nome de sala sorteado; quem entra usa o do convite.
  $('#room').value = prefs.room || (prefs.mode === 'host' ? randomRoom() : '');
  $('#server-url').value = prefs.serverUrl;
  $('#host-port').value = prefs.hostPort;
  $('#host-tunnel').checked = prefs.tunnel;
  $('#turn-urls').value = prefs.turnUrls;
  $('#turn-username').value = prefs.turnUsername;
  $('#turn-credential').value = prefs.turnCredential;
  $(prefs.mode === 'host' ? '#mode-host' : '#mode-join').checked = true;
  $(prefs.hostWhere === 'pc' ? '#host-pc' : '#host-cloud').checked = true;
  syncModeFields();
}

function currentMode() {
  return $('#mode-host').checked ? 'host' : 'join';
}

function currentHostWhere() {
  // No navegador, a sala é sempre no servidor do Telão (hospedar no PC é do app do Windows).
  return !isWeb() && $('#host-pc').checked ? 'pc' : 'cloud';
}

function syncModeFields() {
  const host = currentMode() === 'host';
  const cloud = currentHostWhere() === 'cloud';
  $('#host-fields').hidden = !host;
  $('#join-fields').hidden = host;
  $('#host-pc-fields').hidden = cloud;
  $('#host-where-desc').textContent = cloud
    ? 'Link fixo: mande uma vez e use sempre. Ninguém precisa deixar o PC hospedando.'
    : 'Seu PC hospeda: rede local e, se quiser, um link pela internet que muda a cada vez.';
  // O campo Sala fica junto do que importa em cada modo (e na ordem do Tab).
  const field = $('#room-field');
  if (host) $('#host-fields').prepend(field);
  else $('#join-fields').insertBefore(field, $('#server-password-field'));
  syncJoinFields();
  $('#room-random').hidden = !host;
  $('#mode-desc').textContent = host ? 'Você cria a sala e convida os amigos.' : 'Alguém criou a sala e te mandou o link.';
  $('#room-label').textContent = host ? 'Nome da sala' : 'Sala';
  $('#room').placeholder = host ? 'ex.: filme-sexta' : 'vem junto no convite';
  $('#join-btn').textContent = host ? 'Criar sala e entrar' : 'Entrar na sala';
  if (host && !$('#room').value.trim()) $('#room').value = randomRoom();
  updateSlate();
}

/**
 * Entrar com convite: só o campo Convite. O campo Sala aparece só se o convite não
 * trouxer a sala, e o Senha só quando o servidor desse convite pediu senha.
 */
function syncJoinFields() {
  const host = currentMode() === 'host';
  const address = host ? null : parseServerAddress($('#server-url').value);
  $('#room-field').hidden = !host && !(address && !address.room);
  $('#server-password-field').hidden = host || !address || address.url !== state.passwordFor;
}

/** A ficha da tela inicial: o que vai acontecer ao entrar (sala, nome, conexão). */
function updateSlate() {
  const host = currentMode() === 'host';
  const address = host ? null : parseServerAddress($('#server-url').value);
  const room = $('#room').value.trim() || address?.room || '';
  $('#slate-mode').textContent = host ? 'Criar sala' : 'Entrar com convite';
  const roomNode = $('#slate-room');
  roomNode.textContent = room || (host ? 'Nome da sala' : 'Sala do convite');
  roomNode.classList.toggle('placeholder', !room);
  $('#slate-name').textContent = $('#name').value.trim() || '—';
  let link = '—';
  if (host && currentHostWhere() === 'cloud') {
    link = room ? inviteLink(PUBLIC_SERVER, room).replace(/^https:\/\//, '') : 'Servidor do Telão';
  } else if (host) {
    link = $('#host-tunnel').checked ? 'Rede local e link pela internet' : 'Só a rede local';
  } else if (address) {
    link = address.url.replace(/^wss?:\/\//, '');
  }
  $('#slate-link').textContent = link;
}

/** Colou um convite (endereço + sala)? Preenche o campo Sala com a sala dele. */
function fillRoomFromAddress() {
  const parsed = parseServerAddress($('#server-url').value);
  if (parsed?.room) $('#room').value = parsed.room;
}

function showJoinError(message, focusSelector) {
  const box = $('#join-error');
  box.textContent = message;
  box.hidden = false;
  if (focusSelector) $(focusSelector).focus();
}

/** Não deu para entrar: o motivo fica na tela (e, se a sala pede senha, o campo aparece). */
function showJoinFailure(err, address) {
  if (err?.code !== 'bad-password' || !address) {
    showJoinError(cleanError(err));
    return;
  }
  const typed = Boolean($('#server-password').value);
  state.passwordFor = address.url;
  syncJoinFields();
  showJoinError(typed
    ? 'Senha incorreta. Confira com quem criou a sala (maiúsculas e minúsculas contam).'
    : 'Essa sala pede senha. Digite a senha que quem criou a sala passou.', '#server-password');
}

function setJoinBusy(busy) {
  state.joining = busy;
  const btn = $('#join-btn');
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
  if (busy) btn.textContent = 'Conectando…';
  else syncModeFields();
}

async function onJoin(event) {
  event.preventDefault();
  if (state.joining) return;
  $('#join-error').hidden = true;
  // No navegador, o toque em "Entrar" é o que libera o som (o iPhone exige um toque).
  // Entrando sozinha pelo link do convite (requestSubmit), não há toque: aí a tecla
  // "Toque para ouvir" aparece quando o som chegar (ver checkAudioRunning).
  if (isWeb() && navigator.userActivation?.isActive !== false) {
    roomAudio().resume().catch(() => {});
    primeSounds();
  }
  const mode = currentMode();
  const address = mode === 'join' ? parseServerAddress($('#server-url').value) : null;
  if (address?.room) $('#room').value = address.room; // o convite manda na sala
  const name = $('#name').value.trim();
  const room = $('#room').value.trim();
  if (!name) return showJoinError('Digite seu nome.', '#name');
  if (mode === 'join' && !address) {
    return showJoinError('Cole o convite que quem criou a sala mandou (ex.: https://telao.xmbc.workers.dev/filme-sexta).', '#server-url');
  }
  if (!room) {
    return showJoinError(mode === 'join'
      ? 'Digite o nome da sala (ou cole o convite completo, que já traz a sala).'
      : 'Digite o nome da sala.', '#room');
  }

  const hostWhere = currentHostWhere();
  Object.assign(prefs, {
    name, room, mode, hostWhere,
    serverUrl: $('#server-url').value.trim(),
    hostPort: Number($('#host-port').value) || DEFAULT_PORT,
    tunnel: $('#host-tunnel').checked,
    turnUrls: $('#turn-urls').value.trim(),
    turnUsername: $('#turn-username').value.trim(),
    turnCredential: $('#turn-credential').value,
  });
  savePrefs();

  setJoinBusy(true);
  $('#clipboard-invite').hidden = true;
  state.joinedAs = mode;
  try {
    let url;
    let password;
    if (mode === 'host' && hostWhere === 'cloud') {
      // A sala fica no servidor do Telão: nada roda neste PC, e o convite não muda.
      url = PUBLIC_SERVER;
      password = '';
    } else if (mode === 'host') {
      password = $('#host-password').value;
      const hosted = await api.startServer({
        port: prefs.hostPort,
        password,
        turn: { urls: prefs.turnUrls, username: prefs.turnUsername, credential: prefs.turnCredential },
      });
      state.hosting = { ...hosted, publicUrl: null, tunnel: 'off', tunnelError: '', download: null };
      url = `ws://127.0.0.1:${hosted.port}`;
    } else {
      url = address.url;
      password = $('#server-password').value;
    }
    const mesh = new Mesh({ url, room, name, password, version: state.info.version });
    state.mesh = mesh;
    state.serverUrl = url;
    wireMesh(mesh);
    await mesh.connect();
    enterRoom();
    if (state.hosting && prefs.tunnel) startTunnel();
  } catch (err) {
    state.mesh?.leave();
    state.mesh = null;
    if (state.hosting) {
      state.hosting = null;
      await api.stopServer().catch(() => {});
    }
    // Tentativa cancelada para abrir outro convite: o erro dela não interessa.
    if (!state.pendingInvite) showJoinFailure(err, address);
  } finally {
    setJoinBusy(false);
    const next = state.pendingInvite;
    state.pendingInvite = null;
    if (next) openInvite(next);
  }
}

// ---------- Convites: link clicado (telao://) e convite copiado ----------

/** O convite é da sala em que já estou? Quem hospeda se conecta por 127.0.0.1. */
function sameRoomAs(invite) {
  if (!state.mesh || !invite || state.mesh.room.toLowerCase() !== invite.room.toLowerCase()) return false;
  if (state.serverUrl === invite.url) return true;
  const hosting = state.hosting;
  if (!hosting) return false;
  const own = [hosting.publicUrl, ...hosting.addresses.map((a) => `${a.address}:${hosting.port}`)];
  return own.some((address) => address && parseServerAddress(address)?.url === invite.url);
}

/** Abre um convite: preenche a tela de entrada e entra (se o nome já estiver lá). */
async function openInvite(invite) {
  if (!invite) return;
  if (state.joining) {
    // Ainda conectando (talvez num link velho): desiste dessa tentativa e abre
    // este convite assim que ela terminar (ver o finally do onJoin).
    state.pendingInvite = invite;
    if (currentMode() === 'join') state.mesh?.leave();
    return;
  }
  if (state.inRoom) {
    if (sameRoomAs(invite)) return;
    const ok = await askConfirm({
      title: `Entrar na sala "${invite.room}"?`,
      text: state.hosting && state.mesh.peers.size > 0
        ? 'Você está hospedando a sala atual: se sair, os outros participantes perdem a conexão.'
        : 'Você vai sair da sala atual.',
      ok: 'Trocar de sala',
    });
    if (!ok) return;
    if (state.inRoom) await leaveRoom(true);
  }
  $('#mode-join').checked = true;
  // A senha digitada vale só para o servidor em que foi digitada.
  if (parseServerAddress($('#server-url').value)?.url !== invite.url) $('#server-password').value = '';
  $('#server-url').value = invite.invite;
  $('#room').value = invite.room;
  syncModeFields(); // (refaz a ficha também)
  $('#clipboard-invite').hidden = true;
  if ($('#name').value.trim()) {
    $('#join-form').requestSubmit();
  } else {
    $('#name').focus();
    toast('Convite carregado. Digite seu nome e clique em Entrar na sala.');
  }
}

/** Ao voltar para o app: se há um convite copiado, oferece usá-lo. */
async function checkClipboardInvite() {
  const banner = $('#clipboard-invite');
  if (state.inRoom || state.joining) {
    banner.hidden = true;
    return;
  }
  let text = '';
  try { text = await api.readClipboard(); } catch { return; }
  const invite = parseInviteText(text);
  // Confere de novo: pode ter entrado numa sala enquanto lia a área de transferência.
  if (!invite || state.inRoom || state.joining || text === state.clipboardDismissed
    || (Array.isArray(prefs.copiedInvites) && prefs.copiedInvites.includes(invite.invite))
    || invite.invite === $('#server-url').value.trim()) {
    banner.hidden = true;
    return;
  }
  state.clipboardInvite = invite;
  state.clipboardText = text;
  const host = invite.url.replace(/^ws(s?):\/\//, '');
  const line = `Sala "${invite.room}" · ${host}`;
  if (banner.hidden) {
    // Mostra a faixa vazia e só depois põe o texto: assim o leitor de tela anuncia.
    $('#clipboard-invite-room').textContent = '';
    banner.hidden = false;
    requestAnimationFrame(() => { $('#clipboard-invite-room').textContent = line; });
  } else {
    $('#clipboard-invite-room').textContent = line;
  }
}

// ---------- Sala ----------

function wireMesh(mesh) {
  const on = (type, handler) => mesh.addEventListener(type, (event) => {
    if (state.mesh === mesh) handler(event.detail);
  });
  on('peer-joined', ({ peer, silent }) => {
    if (peer.state.sharing) state.sharingPeers.add(peer.id);
    syncTile(peer);
    renderParticipants();
    refreshShareSettings();
    updateBitrateHint();
    if (state.camera) renderCameraUi(); // quem chegou numa versão antiga não vê a câmera
    renderVoiceUi();
    pushStatus(); // a bandeja precisa saber se tem gente na sala que você hospeda
    if (state.inRoom && !silent) toast(`${peer.name} entrou na sala.`);
  });
  on('peer-left', ({ peer, silent }) => {
    state.sharingPeers.delete(peer.id);
    removePeerTiles(peer.id);
    removeVoice(peer.id);
    renderVoiceUi();
    state.trackers.delete(peer.id);
    renderParticipants();
    if (state.camera) renderCameraUi(); // o aviso de quem não vê a câmera pode ter mudado
    renderOutgoing();
    refreshShareSettings();
    updateBitrateHint();
    pushStatus();
    if (state.inRoom && !silent) toast(`${peer.name} saiu da sala.`);
  });
  // Alguém parou (ou voltou) de assistir a minha tela, ou mudou o tamanho dela.
  on('view', () => {
    renderOutgoing();
    refreshShareSettings();
    updateBitrateHint();
  });
  on('peer-state', ({ peer }) => {
    const wasSharing = state.sharingPeers.has(peer.id);
    if (peer.state.sharing) state.sharingPeers.add(peer.id);
    else state.sharingPeers.delete(peer.id);
    if (peer.state.sharing && !wasSharing) announceStream(peer);
    syncTile(peer);
    renderParticipants();
  });
  on('remote-track', ({ peer }) => {
    syncTile(peer);
    syncVoice(peer);
  });
  // Alguém ligou ou desligou o microfone.
  on('voice', ({ peer }) => {
    syncVoice(peer);
    renderVoiceUi();
    renderParticipants();
  });
  on('remote-media', ({ peer }) => updateTileWaiting(peer));
  // Alguém ligou ou desligou a câmera.
  on('camera', ({ peer }) => {
    syncTile(peer);
    renderParticipants();
  });
  on('reaction', showReaction);
  on('connection', ({ peer }) => {
    renderParticipants();
    updateTileWaiting(peer);
    if (peer.pc.connectionState === 'failed') {
      toast(`Sem conexão direta com ${peer.name}. Tentando de novo…`, 'warn');
    }
  });
  on('server', ({ connected, reconnected }) => {
    if (!state.inRoom) return;
    setServerStatus(connected);
    if (reconnected) toast('Reconectado ao servidor.');
  });
  on('fatal', ({ message }) => {
    // O motivo fica na tela de entrada (um aviso sumiria sozinho).
    leaveRoom(true).then(() => showJoinError(message));
  });
  on('reconnect-failed', ({ attempt }) => {
    // A reconexão tenta sempre o mesmo endereço. Se a sala foi recriada, o link mudou.
    if (attempt === 3 && !state.hosting) {
      toast('Ainda sem conexão com a sala. Se quem hospeda fechou o Telão ou criou a sala de novo, o endereço mudou: peça o novo, clique em Sair e entre de novo.', 'warn', 20000);
    }
  });
}

/** Alguém começou a transmitir: aviso, som e, com o Telão em segundo plano, notificação. */
function announceStream(peer) {
  if (!state.inRoom) return;
  // No máximo um aviso por pessoa a cada 30 s (liga-desliga não vira enxurrada).
  const now = Date.now();
  if (now - (state.lastAnnounce.get(peer.id) || 0) < 30_000) return;
  state.lastAnnounce.set(peer.id, now);
  toast(`${peer.name} começou a transmitir.`);
  chime('stream');
  api.attention({
    title: `${peer.name} começou a transmitir`,
    body: peer.state.label ? `${peer.state.label} · clique para assistir no Telão` : 'Clique para assistir no Telão.',
  }).catch(() => {});
}

function enterRoom() {
  state.inRoom = true;
  $('#join-view').hidden = true;
  $('#room-view').hidden = false;
  $('#room-title').textContent = state.mesh.room;
  document.title = `Telão · ${state.mesh.room}`;
  setServerStatus(true);
  renderInvite();
  renderShareUi();
  renderCameraUi();
  renderVoiceUi();
  for (const peer of state.mesh.peers.values()) syncTile(peer);
  clearInterval(state.speakingTimer);
  state.speakingTimer = setInterval(updateSpeaking, 150);
  // O microfone volta como estava da última vez, com aviso e som: ele liga sem clique.
  if (prefs.micOn) {
    startMic().then((on) => {
      if (!on || !state.inRoom) return;
      toast(isWeb() ? 'Microfone ligado, como da última vez.' : 'Microfone ligado, como da última vez. Ctrl+Alt+M desliga.', 'info', 7000);
      chime('mic-on');
    });
  }
  layoutTiles();
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(updateStats, STATS_INTERVAL_MS);
  pushStatus();
}

async function leaveRoom(force = false) {
  if (!state.mesh) return;
  if (!force && state.hosting && state.mesh.peers.size > 0) {
    const ok = await askConfirm({
      title: 'Sair e fechar a sala?',
      text: 'Você está hospedando esta sala. Se sair, os outros participantes perdem a conexão com ela.',
      ok: 'Sair mesmo assim',
    });
    if (!ok || !state.mesh) return;
  }
  stopShare();
  stopCamera();
  stopMic();
  state.deafened = false;
  clearInterval(state.speakingTimer);
  state.speakingTimer = null;
  state.speaking.clear();
  for (const id of [...state.voices.keys()]) removeVoice(id);
  state.voiceCtx?.close().catch(() => {});
  state.voiceCtx = null;
  $('#audio-unlock').hidden = true;
  state.starting = null; // uma transmissão começando agora não vai para a próxima sala
  const mesh = state.mesh;
  state.mesh = null;
  state.inRoom = false;
  mesh.leave();
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  for (const key of [...state.tiles.keys()]) removeTile(key, false);
  state.trackers.clear();
  state.sharingPeers.clear();
  state.pinned = null;
  hideSuggestion();
  if (state.hosting) {
    state.hosting = null;
    await api.stopServer().catch(() => {});
  }
  $('#room-view').hidden = true;
  $('#join-view').hidden = false;
  document.title = 'Telão';
  updateKeepAwake();
  pushStatus();
}

function setServerStatus(connected) {
  const pill = $('#server-status');
  pill.className = `pill ${connected ? 'ok' : 'warn'}`;
  pill.textContent = connected ? 'conectado' : 'reconectando…';
  pill.title = connected
    ? `Servidor: ${state.serverUrl}`
    : 'Sem conexão com o servidor. As transmissões em andamento continuam; tentando reconectar.';
}

// ---------- Confirmação ----------
// Uma janela do próprio Telão no lugar do window.confirm (que tem a cara do Windows,
// não a da mesa). Esc e Cancelar respondem "não".

let confirmResolve = null;

function askConfirm({ title, text, ok }) {
  confirmResolve?.(false); // uma pergunta nova toma o lugar da anterior
  const dialog = $('#confirm');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  if (!dialog.open) dialog.showModal();
  $('#confirm-cancel').focus(); // o padrão é o lado seguro
  return new Promise((resolve) => { confirmResolve = resolve; });
}

function answerConfirm(yes) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if ($('#confirm').open) $('#confirm').close();
  resolve?.(yes);
}

// ---------- Bandeja, atalhos globais e comandos ----------

/** Informa o processo principal (bandeja, selo "ao vivo", atalhos). */
async function pushStatus() {
  let taken = [];
  try {
    taken = await api.setStatus({
      inRoom: state.inRoom, sharing: Boolean(state.share), paused: Boolean(state.share?.paused),
      mic: Boolean(state.mic), deafened: state.deafened,
      // Hospedando com gente na sala: fechar o Telão derruba todo mundo (a bandeja pergunta antes).
      hostingOthers: Boolean(state.hosting && state.mesh?.peers.size > 0),
    });
  } catch {
    return;
  }
  if (taken?.length && !state.shortcutWarned) {
    state.shortcutWarned = true;
    toast(taken.length > 1
      ? `Os atalhos ${taken.join(' e ')} já são usados por outro programa e não vão funcionar no Telão.`
      : `O atalho ${taken[0]} já é usado por outro programa e não vai funcionar no Telão.`, 'warn', 9000);
  }
}

function onCommand(command) {
  if (command === 'pause-toggle') {
    togglePause();
    // Pelo atalho, com o jogo na frente, o som é a única confirmação: toca
    // mesmo com os sons de aviso desligados (com eles ligados, já tocou).
    if (state.share && prefs.sounds === false) playSound('pause');
  } else if (command === 'share-stop') stopShare();
  else if (command === 'mic-toggle') toggleMic({ shortcut: true });
  else if (command === 'deafen-toggle') toggleDeafen({ shortcut: true });
  else if (command === 'share-toggle') toggleShareByShortcut();
  else if (command === 'quit-request') confirmQuit();
}

/** "Sair do Telão" na bandeja, no ar ou hospedando com gente: pergunta antes de fechar. */
async function confirmQuit() {
  const ok = await askConfirm({
    title: 'Fechar o Telão?',
    text: state.hosting && state.mesh?.peers.size > 0
      ? 'Você está hospedando a sala: se fechar, os outros participantes perdem a conexão.'
      : 'A sua transmissão para e você sai da sala.',
    ok: 'Fechar o Telão',
  });
  if (ok) api.quitApp();
}

/** A tela principal do Windows (a que a lista marca como "principal"). */
function primaryScreen(sources) {
  const screens = sources.filter((s) => s.type === 'screen');
  return screens.find((s) => /principal/.test(s.detail || '')) || screens[0] || null;
}

/**
 * Ctrl+Alt+T: para, ou começa de novo com a mesma tela/janela e o mesmo som.
 * O processo principal manda este comando junto com um "gesto do usuário" (sem
 * ele o getDisplayMedia é recusado). O gesto vale poucos segundos, por isso a
 * lista de telas aqui é a rápida, sem miniaturas.
 */
async function toggleShareByShortcut() {
  if (!state.inRoom || state.starting) return;
  // Pelo atalho, com o jogo na frente, o som é a única confirmação: toca mesmo com
  // os sons de aviso desligados (com eles ligados, já tocou).
  const confirmBySound = (kind) => { if (prefs.sounds === false) playSound(kind); };
  if (state.share) {
    stopShare();
    confirmBySound('stop');
    return;
  }
  let sources = [];
  try { sources = await api.listSources({ thumbnails: false }); } catch { /* cai no seletor */ }
  const last = prefs.lastShare;
  // A mesma tela ou janela da última vez. Uma janela aberta de novo (o jogo reiniciou)
  // ganha outro id: aí vale a janela com o mesmo nome. Sem última vez, a tela principal.
  const source = (last && (sources.find((s) => s.id === last.id)
    || sources.find((s) => s.type === last.type && s.name === last.name)))
    || (!last || last.type === 'screen' ? primaryScreen(sources) : null);
  if (source && await startShare(source, last ? last.audio : prefs.audio)) {
    confirmBySound('start');
    return;
  }
  if (!state.inRoom || state.share) return;
  // Não deu para começar sozinho (a janela da última vez fechou): o seletor fica
  // pronto no Telão, sem puxar a janela por cima do jogo; som e aviso dizem isso.
  playSound('error');
  api.attention({
    title: 'Escolha o que transmitir',
    body: last?.name ? `"${last.name}" não está aberta. Clique para escolher no Telão.` : 'Clique para escolher no Telão.',
  }).catch(() => {});
  openPicker();
}

// ---------- Convite (quando hospeda) ----------

async function copyInvite(link) {
  await api.copyText(link);
  // O convite que eu mesmo copiei não deve virar a faixa "Você copiou um convite".
  const copied = Array.isArray(prefs.copiedInvites) ? prefs.copiedInvites : [];
  prefs.copiedInvites = [link, ...copied.filter((l) => l !== link)].slice(0, 10);
  savePrefs();
  toast('Convite copiado! Quem clicar nele abre o Telão já na sala.');
}

function inviteRow(link, adapter) {
  const copy = el('button', { class: 'icon-btn small', title: 'Copiar convite', 'aria-label': 'Copiar convite', html: icon('copy') });
  copy.addEventListener('click', () => copyInvite(link));
  return el('div', { class: 'invite-item' },
    adapter ? el('span', { class: 'invite-iface' }, adapter) : null,
    el('div', { class: 'invite-row' }, el('code', { title: link }, link), copy));
}

// Placas de VPN e de máquinas virtuais vão para o fim da lista.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|hamachi|radmin|zerotier|tailscale|vpn|tap|tun/i;

/** O convite principal da sala (o do monitor vazio): o link pela internet, se houver. */
function mainInvite() {
  const room = state.mesh?.room;
  if (!room) return null;
  const hosting = state.hosting;
  if (!hosting) return /^wss:\/\//.test(state.serverUrl) ? inviteLink(state.serverUrl, room) : null;
  if (hosting.publicUrl) return inviteLink(hosting.publicUrl, room);
  const lan = [...hosting.addresses].sort((a, b) => VIRTUAL_ADAPTER.test(a.name) - VIRTUAL_ADAPTER.test(b.name))[0];
  return lan ? inviteLink(`${lan.address}:${hosting.port}`, room) : null;
}

function renderInvite() {
  renderEmptyStage(); // o convite também aparece no monitor vazio
  const hosting = state.hosting;
  const room = state.mesh?.room || '';
  // Sala num servidor pela internet (o do Telão ou o link de quem hospeda): todo
  // mundo pode convidar, com o mesmo link que usou para entrar.
  const shared = !hosting && /^wss:\/\//.test(state.serverUrl) ? inviteLink(state.serverUrl, room) : null;
  const fixed = state.serverUrl === PUBLIC_SERVER;
  $('#invite-panel').hidden = !hosting && !shared;
  if (!hosting && !shared) return;
  $('#invite-hint').replaceChildren(
    'Quem clicar no link abre o Telão já na sala ', el('strong', {}, room), '. ',
    fixed ? 'O link não muda: dá para fixar no canal do Discord.'
      : hosting ? 'Se você pôs senha, mande a senha também.' : '',
  );
  $('#invite-lan').hidden = !hosting;
  if (shared) {
    $('#invite-internet').replaceChildren(
      el('span', { class: 'invite-label', html: fixed ? `${icon('link')}Link fixo` : `${icon('globe')}Pela internet` }),
      inviteRow(shared),
    );
    return;
  }

  const addresses = [...hosting.addresses].sort((a, b) => VIRTUAL_ADAPTER.test(a.name) - VIRTUAL_ADAPTER.test(b.name));
  $('#invite-lan').replaceChildren(
    el('span', { class: 'invite-label', html: `${icon('wifi')}Na mesma rede (Wi-Fi ou cabo)` }),
    ...(addresses.length
      // O nome da placa de rede só aparece quando há mais de uma (Wi-Fi, cabo, VPN…).
      ? addresses.map((a) => inviteRow(inviteLink(`${a.address}:${hosting.port}`, room), addresses.length > 1 ? a.name : null))
      : [el('p', { class: 'hint' }, 'Nenhuma rede local encontrada.')]),
  );

  const internet = [el('span', { class: 'invite-label', html: `${icon('globe')}Pela internet` })];
  if (hosting.download !== null) {
    const bar = el('div', { class: 'progress' }, el('span'));
    bar.style.setProperty('--value', hosting.download.toFixed(3));
    internet.push(el('p', { class: 'hint' }, `Baixando o cloudflared… ${Math.round(hosting.download * 100)}%`), bar);
  } else if (hosting.publicUrl) {
    internet.push(inviteRow(inviteLink(hosting.publicUrl, room)));
  } else if (hosting.tunnel === 'starting') {
    internet.push(el('p', { class: 'hint' }, el('span', { class: 'spinner tiny' }), ' Gerando link público…'));
  } else if (hosting.tunnel === 'missing') {
    internet.push(
      el('p', { class: 'hint' }, 'Para o link público é preciso o cloudflared, programa gratuito e oficial da Cloudflare (cerca de 60 MB).'),
      el('button', { class: 'btn small', html: `${icon('download')}Baixar e criar link`, onclick: downloadAndStartTunnel }),
    );
  } else {
    if (hosting.tunnel === 'error') internet.push(el('p', { class: 'hint error-text' }, hosting.tunnelError));
    internet.push(el('button', { class: 'btn small', html: `${icon('globe')}Criar link público`, onclick: startTunnel }));
  }
  $('#invite-internet').replaceChildren(...internet);
}

async function startTunnel() {
  const hosting = state.hosting;
  if (!hosting) return;
  hosting.tunnel = 'starting';
  renderInvite();
  try {
    const result = await api.startTunnel();
    if (state.hosting !== hosting) return;
    if (result.missing) {
      hosting.tunnel = 'missing';
    } else {
      hosting.publicUrl = result.url;
      hosting.tunnel = 'on';
      toast('Link público criado. Ele pode levar alguns segundos para começar a funcionar.');
    }
  } catch (err) {
    if (state.hosting !== hosting) return;
    hosting.tunnel = 'error';
    hosting.tunnelError = cleanError(err);
  }
  renderInvite();
}

async function downloadAndStartTunnel() {
  const hosting = state.hosting;
  if (!hosting) return;
  hosting.download = 0;
  renderInvite();
  try {
    await api.downloadCloudflared();
  } catch (err) {
    hosting.download = null;
    hosting.tunnel = 'error';
    hosting.tunnelError = `Falha ao baixar o cloudflared: ${cleanError(err)}`;
    renderInvite();
    return;
  }
  hosting.download = null;
  startTunnel();
}

// ---------- Participantes ----------

function avatar(name) {
  return el('span', { class: 'avatar' }, (name.trim()[0] || '?').toUpperCase());
}

/**
 * Uma linha de "Na sala". onAir: null (não transmite), 'live' ou 'paused': o tally
 * aceso ao lado do nome. camera e mic: ícones depois do nome. id: quem é ('me' =
 * você), para o contorno de quem está falando (ver updateSpeaking).
 */
function participantItem({ id, name, sub, pill = null, onAir = null, camera = false, mic = false }) {
  const tally = onAir
    ? el('span', { class: `tally${onAir === 'paused' ? ' paused' : ''}`, title: onAir === 'paused' ? 'Pausado' : 'No ar' })
    : null;
  const badge = (on, kind, label) => (on
    ? el('span', { class: 'participant-media', role: 'img', title: label, 'aria-label': label.toLowerCase(), html: icon(kind) })
    : null);
  const item = el('li', { class: `participant${isSpeaking(id) ? ' speaking' : ''}`, dataset: { peer: id } },
    avatar(name),
    el('div', { class: 'participant-main' },
      el('div', { class: 'participant-name', title: name }, tally, el('span', { class: 'participant-label' }, name),
        badge(mic, 'mic', 'Microfone ligado'), badge(camera, 'camera', 'Câmera ligada')),
      el('div', { class: 'participant-sub', title: sub }, sub)),
    pill);
  // O que muda a linha. A dica do sinal (o atraso, que muda a cada 2 s) fica de fora:
  // ela é atualizada no lugar (ver syncRows).
  item.dataset.sig = JSON.stringify([name, sub, onAir, camera, mic, pill?.className, pill?.textContent, pill?.getAttribute('aria-label')]);
  return item;
}

/**
 * Atualiza a lista só onde mudou: refazê-la inteira a cada 2 s derrubava o cursor
 * do leitor de tela. Uma linha igual continua a mesma (só a dica do sinal muda).
 */
function syncRows(list, items) {
  const current = new Map([...list.children].map((node) => [node.dataset.peer, node]));
  const next = items.map((item) => {
    const old = current.get(item.dataset.peer);
    if (!old || old.dataset.sig !== item.dataset.sig) return item;
    const pill = old.querySelector('.pill');
    const title = item.querySelector('.pill')?.getAttribute('title');
    if (pill && title != null && pill.getAttribute('title') !== title) pill.setAttribute('title', title);
    return old;
  });
  const sameOrder = next.length === list.children.length && next.every((node, i) => list.children[i].dataset.peer === node.dataset.peer);
  if (!sameOrder) {
    list.replaceChildren(...next);
    return;
  }
  next.forEach((node, i) => { if (list.children[i] !== node) list.children[i].replaceWith(node); });
}

const SIGNAL_KIND = { good: 'ok', ok: 'warn', bad: 'bad' };

function signalBars(level) {
  const count = { good: 3, ok: 2, bad: 1 }[level];
  return el('span', { class: `bars b${count}`, 'aria-hidden': 'true' }, el('i'), el('i'), el('i'));
}

function connectionPill(peer) {
  const conn = peer.pc.connectionState;
  if (conn === 'failed') return el('span', { class: 'pill bad', title: 'Não foi possível conectar diretamente' }, 'falhou');
  if (conn !== 'connected') return el('span', { class: 'pill' }, 'conectando…');
  const route = describeRoute(peer.stats?.route);
  const rtt = peer.stats?.route?.rtt;
  const title = [route?.title, rtt != null ? `atraso de ${Math.round(rtt * 1000)} ms` : null].filter(Boolean).join(' · ');
  const level = peerSignal(peer.stats);
  if (!level) return null;
  // Sinal ótimo: só as barrinhas, sem cor nem texto (o texto aparece quando há problema).
  if (level === 'good') {
    return el('span', {
      class: 'pill signal-pill', role: 'img', 'aria-label': `sinal ${SIGNAL_TEXT.good}`,
      title: [`Sinal ${SIGNAL_TEXT.good}`, title].filter(Boolean).join(' · '),
    }, signalBars(level));
  }
  return el('span', { class: `pill signal-pill ${SIGNAL_KIND[level]}`, title },
    signalBars(level), `sinal ${SIGNAL_TEXT[level]}`);
}

function renderParticipants() {
  const mesh = state.mesh;
  if (!mesh) return;
  let mine = state.hosting ? 'Hospedando a sala' : (state.joinedAs === 'host' ? 'Criou a sala' : 'Na sala');
  if (state.share) mine = `${state.share.paused ? 'Pausado' : 'Transmitindo'}: ${state.share.source.name}${state.share.audio ? ' · com som' : ''}`;
  // O seu estado no ar já está na lâmpada NO AR do alto: aqui fica só o tally.
  const myAir = state.share ? (state.share.paused ? 'paused' : 'live') : null;
  if (state.deafened) mine += ' · vozes silenciadas';
  const items = [participantItem({
    id: 'me', name: `${mesh.name} (você)`, sub: mine, onAir: myAir,
    camera: Boolean(state.camera), mic: Boolean(state.mic),
  })];
  // Quem está numa versão antiga (as melhorias de CPU só valem com todos atualizados).
  const outdated = outdatedPeers(state.info.version,
    [...mesh.peers.values()].map((p) => ({ id: p.id, version: p.state.version })),
    mesh.serverFeatures.includes('version'));
  for (const peer of mesh.peers.values()) {
    // Quem você parou de assistir vem primeiro: é o que explica a tela que sumiu.
    const screenOff = peer.state.sharing && state.tiles.get(tileKey(peer.id, 'screen'))?.watching === false;
    const cameraOff = Boolean(peer.remoteCameraId) && state.tiles.get(tileKey(peer.id, 'camera'))?.watching === false;
    const parts = [];
    if (screenOff && cameraOff) parts.push('Você parou de assistir a tela e a câmera');
    else if (screenOff) parts.push('Você parou de assistir a tela');
    else if (cameraOff) parts.push('Você parou de assistir a câmera');
    if (peer.state.sharing) {
      const what = `${peer.state.label || 'tela'}${peer.state.audio ? ' · com som' : ''}`;
      if (screenOff) parts.push(peer.state.paused ? `Pausado: ${what}` : what);
      else parts.push(`${peer.state.paused ? 'Pausado' : 'Transmitindo'}: ${what}`);
    }
    let sub = parts.join(' · ') || 'Na sala';
    if (outdated.has(peer.id)) sub += ' · versão antiga do Telão';
    const air = peer.state.sharing ? (peer.state.paused ? 'paused' : 'live') : null;
    items.push(participantItem({
      id: peer.id, name: peer.name, sub, pill: connectionPill(peer), onAir: air,
      camera: Boolean(peer.remoteCameraId), mic: Boolean(peer.remoteVoiceId),
    }));
  }
  syncRows($('#participants'), items);
  $('#participant-count').textContent = String(items.length);
  arrangeConsole();
}

/**
 * A ordem dos painéis da sala acompanha o momento: Voz sempre logo abaixo de "Na
 * sala"; transmitindo, "Sua transmissão" (compacta) vem em seguida; sozinho, o
 * convite sobe. Os painéis mudam de lugar no HTML, não só na tela: assim o Tab e o
 * leitor de tela seguem a ordem que se vê.
 */
function arrangeConsole() {
  const live = Boolean(state.share);
  const alone = Boolean(state.mesh) && state.mesh.peers.size === 0;
  const box = $('#console');
  box.classList.toggle('is-live', live);
  box.classList.toggle('is-alone', alone);
  const ids = ['room-update', 'people-panel', ...(alone ? ['invite-panel'] : []), 'voice-panel',
    ...(live ? ['share-panel', 'camera-panel'] : ['camera-panel', 'share-panel']),
    ...(alone ? [] : ['invite-panel']), 'shortcuts-panel'];
  const wanted = ids.map((id) => document.getElementById(id));
  if (wanted.every((node, i) => box.children[i] === node)) return;
  const active = document.activeElement;
  box.append(...wanted);
  // Mudar um nó de lugar tira o foco de dentro dele: devolve.
  if (active && box.contains(active) && document.activeElement !== active) active.focus({ preventScroll: true });
}

// ---------- Telas recebidas ----------
// Cada pessoa pode ter dois monitores no multivisor: a tela que ela transmite
// (chave = o id dela) e a câmera (chave = id + ":cam"). Quem você parou de
// assistir sai do palco e fica na fileira "Não assistindo", embaixo.

const tileKey = (peerId, kind) => (kind === 'camera' ? `${peerId}:cam` : peerId);
const CONTROLS_IDLE_MS = 2500; // mouse parado em cima da imagem: os controles somem

function rememberVolume(tile) {
  const volumes = { ...(prefs.volumes || {}) };
  delete volumes[tile.peerName];
  // O valor da barra (no iPhone, o volume do vídeo não muda: o som vai pelo Web Audio).
  volumes[tile.peerName] = { volume: Number(tile.volume.value), muted: tile.userMuted };
  const names = Object.keys(volumes);
  for (const old of names.slice(0, Math.max(0, names.length - 50))) delete volumes[old];
  prefs.volumes = volumes;
  savePrefs();
}

async function togglePictureInPicture(tile) {
  try {
    if (document.pictureInPictureElement === tile.video) await document.exitPictureInPicture();
    else await tile.video.requestPictureInPicture();
  } catch (err) {
    toast(`Não foi possível abrir a janelinha: ${cleanError(err)}`, 'warn');
  }
}

/**
 * Controles por cima da imagem (barra de baixo e reações): aparecem quando o mouse
 * mexe e somem depois de um tempo parado, levando o cursor junto. Pelo teclado
 * (Tab) eles ficam à vista enquanto o foco estiver neles (ver o CSS).
 */
function setupControls(tile) {
  const { root } = tile;
  let timer = 0;
  let holding = false; // mouse em cima dos controles: não somem
  const show = () => {
    root.classList.add('show-controls');
    root.classList.remove('idle');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (holding) return show();
      root.classList.remove('show-controls');
      root.classList.add('idle');
    }, CONTROLS_IDLE_MS);
  };
  root.addEventListener('pointermove', show);
  root.addEventListener('pointerdown', show);
  root.addEventListener('pointerleave', (event) => {
    // No toque, o dedo "sai" ao soltar: os controles ficam até o tempo acabar.
    if (event.pointerType === 'touch') return;
    clearTimeout(timer);
    root.classList.remove('show-controls', 'idle');
  });
  for (const bar of root.querySelectorAll('.tile-bar, .reaction-bar')) {
    bar.addEventListener('pointerenter', () => { holding = true; });
    bar.addEventListener('pointerleave', () => { holding = false; });
  }
}

function createTile(peer, kind) {
  const camera = kind === 'camera';
  const key = tileKey(peer.id, kind);
  const who = camera ? `a câmera de ${peer.name}` : peer.name;
  const video = el('video', { playsinline: true, autoplay: true });
  // A câmera não tem som: o vídeo dela fica sempre mudo (o atributo "muted" posto
  // por script não muda a propriedade; só no HTML).
  video.muted = camera;
  const name = el('span', { class: 'tile-name' });
  const label = el('span', { class: 'tile-label' });
  const signal = el('span', { class: 'tile-signal' });
  // Silenciado (por você ou contra eco) fica à vista na faixa, mesmo com a barra escondida.
  const muteBadge = camera ? null : el('span', { class: 'tile-muted', role: 'img', hidden: true, html: icon('volume-x') });
  const waitText = el('span', {}, 'Conectando à transmissão…');
  const stats = camera ? null : el('div', { class: 'tile-stats', hidden: true }, 'Aguardando dados…');
  const pausedText = el('span');
  const paused = camera ? null : el('div', { class: 'tile-paused', html: icon('pause') }, pausedText);
  // Sem aria-live aqui: o leitor de tela anunciaria cada emoji (inclusive os seus).
  const reactions = camera ? null : el('div', { class: 'reactions-layer' });
  const muteBtn = camera ? null : el('button', { class: 'icon-btn', title: `Silenciar ${peer.name}`, 'aria-label': `Silenciar ${peer.name}` });
  const volume = camera ? null : el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': `Volume da transmissão de ${peer.name}` });
  const pinBtn = el('button', { class: 'icon-btn', title: 'Destacar', 'aria-label': `Destacar ${who}`, 'aria-pressed': 'false', html: icon('pin') });
  const pipBtn = el('button', {
    class: 'icon-btn pip-btn', title: 'Janelinha flutuante: fica por cima dos outros programas',
    'aria-label': 'Abrir em janelinha flutuante', 'aria-pressed': 'false', html: icon('pip'),
  });
  const infoBtn = camera ? null : el('button', { class: 'icon-btn info-btn', title: 'Estatísticas da transmissão', 'aria-label': 'Estatísticas da transmissão', html: icon('info') });
  const fullBtn = el('button', { class: 'icon-btn full-btn', title: 'Tela cheia (ou duplo clique)', 'aria-label': 'Tela cheia', html: icon('maximize') });
  const watchBtn = el('button', {
    class: 'icon-btn watch-btn', title: 'Parar de assistir: sai do palco e economiza processador e internet dos dois lados',
    'aria-label': `Parar de assistir ${who}`, html: icon('eye-off'),
  });
  const reactionBar = camera ? null : el('div', { class: 'reaction-bar', role: 'group', 'aria-label': `Reagir à tela de ${peer.name}` },
    ...REACTIONS.map((emoji) => el('button', {
      type: 'button', title: `Reagir com ${emoji}`, 'aria-label': `Reagir com ${emoji}`,
      onclick: () => sendReaction(peer.id, emoji),
    }, emoji)));
  // Um monitor do multivisor: a imagem (com os controles por cima) e, embaixo, a faixa
  // de rótulo com o tally (aceso = no ar, tracejado = conectando, âmbar = pausado).
  const root = el('div', {
    class: `tile waiting${camera ? ' camera' : ''}`, tabindex: '0', dataset: { peer: peer.id, key },
    role: 'group', 'aria-label': camera ? `Câmera de ${peer.name}` : `Tela de ${peer.name}`,
  },
    el('div', { class: 'tile-screen' },
      video,
      el('div', { class: 'tile-wait' }, el('div', { class: 'spinner' }), waitText),
      paused,
      reactions,
      stats,
      // Os controles antes das reações: pelo teclado, o que importa vem primeiro.
      el('div', { class: 'tile-bar' }, muteBtn, volume, el('span', { class: 'spacer' }), pinBtn, watchBtn, pipBtn, infoBtn, fullBtn),
      reactionBar),
    el('div', { class: 'umd' }, el('span', { class: 'tally', 'aria-hidden': 'true' }),
      el('span', { class: 'tile-pin', title: 'Em destaque', 'aria-hidden': 'true', html: icon('pin') }),
      name, label, muteBadge, signal));
  root.setAttribute('aria-describedby', 'tile-keys-help');

  const tile = {
    key, peerId: peer.id, kind, root, video, name, label, signal, waitText, stats, pausedText, watchBtn, reactions,
    muteBtn, muteBadge, volume, pinBtn, pipBtn,
    userMuted: false, peerName: peer.name, trackSig: '',
    watching: true, // false = parou de assistir: nada chega e o monitor sai do palco
  };
  watchBtn.addEventListener('click', () => setWatching(key, false));
  // O tamanho em que a imagem aparece decide a resolução pedida a quem transmite.
  state.resizeObserver?.observe(video);
  if (!camera) {
    // O volume de cada pessoa fica lembrado entre as sessões.
    const saved = prefs.volumes?.[peer.name];
    if (saved && Number.isFinite(saved.volume)) {
      volume.value = String(saved.volume);
      video.volume = Math.min(1, Math.max(0, saved.volume));
      tile.userMuted = saved.muted === true;
    }
    const showVolume = () => {
      const percent = `${Math.round(Number(volume.value) * 100)}%`;
      volume.setAttribute('aria-valuetext', percent);
      volume.title = `Volume da transmissão: ${percent}`;
    };
    showVolume();
    volume.addEventListener('input', () => {
      video.volume = Number(volume.value);
      if (Number(volume.value) > 0) tile.userMuted = false;
      showVolume();
      rememberVolume(tile);
      applyAudioRouting();
    });
    muteBtn.addEventListener('click', () => {
      tile.userMuted = !tile.userMuted;
      rememberVolume(tile);
      applyAudioRouting();
    });
    infoBtn.addEventListener('click', () => {
      stats.hidden = !stats.hidden;
      infoBtn.classList.toggle('active', !stats.hidden);
      renderTileStats(state.mesh?.peers.get(peer.id));
    });
  }
  pinBtn.addEventListener('click', () => {
    state.pinned = state.pinned === key ? null : key;
    layoutTiles();
  });
  pipBtn.hidden = !document.pictureInPictureEnabled;
  pipBtn.addEventListener('click', () => togglePictureInPicture(tile));
  video.addEventListener('enterpictureinpicture', () => {
    pipBtn.setAttribute('aria-pressed', 'true');
    syncViews(); // a janelinha continua recebendo mesmo com o Telão escondido
  });
  video.addEventListener('leavepictureinpicture', () => {
    pipBtn.setAttribute('aria-pressed', 'false');
    syncViews();
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement === root) document.exitFullscreen();
    else if (document.fullscreenEnabled) root.requestFullscreen().catch(() => {});
    // iPhone: só o próprio vídeo vai para a tela cheia (do jeito do iOS).
    else video.webkitEnterFullscreen?.();
  };
  fullBtn.addEventListener('click', toggleFullscreen);
  // Clicar numa imagem a destaca (o 📌 desfaz); dois cliques abrem a tela cheia.
  video.addEventListener('click', () => {
    // No toque, tocar na imagem só mostra os controles (destacar fica no 📌).
    if (matchMedia('(pointer: coarse)').matches) return;
    if (watchedTiles().length < 2 || state.pinned === key) return;
    state.pinned = key;
    layoutTiles();
  });
  video.addEventListener('dblclick', toggleFullscreen);
  setupTileKeys(root);
  for (const type of ['playing', 'resize', 'loadeddata']) {
    video.addEventListener(type, () => {
      const current = state.mesh?.peers.get(peer.id);
      if (current) updateTileWaiting(current);
    });
  }
  setupControls(tile);
  return tile;
}

/**
 * Teclado: cada monitor é uma parada só do Tab (eram 13: reações e controles).
 * Enter entra nos controles dele (o Tab anda entre eles e as setas mexem no volume);
 * Esc, ou sair do monitor, volta ao normal.
 */
function setupTileKeys(root) {
  const controls = () => root.querySelectorAll('.tile-bar button, .tile-bar input, .reaction-bar button');
  const setInside = (inside) => {
    root.classList.toggle('keys-inside', inside);
    for (const node of controls()) node.tabIndex = inside ? 0 : -1;
  };
  setInside(false);
  root.addEventListener('keydown', (event) => {
    if (event.target === root && event.key === 'Enter') {
      setInside(true);
      [...controls()].find((node) => !node.hidden && node.getClientRects().length)?.focus();
      event.preventDefault();
    } else if (event.key === 'Escape' && event.target !== root && root.classList.contains('keys-inside')) {
      setInside(false);
      root.focus();
      event.preventDefault();
    }
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget)) setInside(false);
  });
}

const watchedTiles = () => [...state.tiles.values()].filter((t) => t.watching);

/** Cria, atualiza ou tira os monitores de uma pessoa (tela e câmera). */
function syncTile(peer) {
  if (!state.mesh) return;
  syncOneTile(peer, 'screen', peer.state.sharing === true, peer.remoteStream);
  syncOneTile(peer, 'camera', Boolean(peer.remoteCameraId), peer.cameraStream);
  updateTileWaiting(peer);
  applyAudioRouting();
  layoutTiles();
}

function syncOneTile(peer, kind, on, stream) {
  const key = tileKey(peer.id, kind);
  let tile = state.tiles.get(key);
  if (!on) {
    if (tile) removeTile(key, false);
    return;
  }
  if (!tile) {
    tile = createTile(peer, kind);
    state.tiles.set(key, tile);
    $('#tiles').append(tile.root);
  }
  tile.name.textContent = peer.name;
  if (kind === 'camera') {
    tile.label.textContent = 'câmera';
  } else {
    tile.label.textContent = peer.state.label ? `${peer.state.label}${peer.state.audio ? ' · com som' : ''}` : '';
    tile.root.classList.toggle('paused', peer.state.paused === true);
    tile.pausedText.textContent = `${peer.name} pausou a transmissão`;
  }
  // Só religa o vídeo quando as faixas mudaram (religar à toa pisca a imagem).
  const sig = stream.getTracks().map((t) => t.id).join(',');
  if (tile.trackSig !== sig) {
    tile.trackSig = sig;
    tile.video.srcObject = null;
    tile.video.srcObject = stream;
    syncTileAudio(tile, stream);
    tile.video.play().catch((err) => {
      // Modo de economia do iPhone barra até vídeo mudo: um toque libera.
      if (err?.name === 'NotAllowedError') $('#audio-unlock').hidden = false;
    });
  }
}

/**
 * No navegador, o som de uma tela vai pelo Web Audio (vídeo mudo + ganho): no
 * iPhone o volume do vídeo não muda por script, e o som do Web Audio, liberado no
 * toque de "Entrar", toca sem pedir outro toque. No app do Windows, o vídeo toca o som.
 */
function syncTileAudio(tile, stream) {
  if (!isWeb() || tile.kind !== 'screen') return;
  tile.video.muted = true;
  tile.audioSource?.disconnect();
  tile.audioSource = null;
  if (!stream.getAudioTracks().length) return;
  const ctx = roomAudio();
  if (!tile.gain) {
    tile.gain = ctx.createGain();
    tile.gain.connect(ctx.destination);
  }
  tile.audioSource = ctx.createMediaStreamSource(stream);
  tile.audioSource.connect(tile.gain);
  applyAudioRouting();
  checkAudioRunning();
}

function removeTile(key, relayout = true) {
  const tile = state.tiles.get(key);
  if (!tile) return;
  if (document.fullscreenElement === tile.root) document.exitFullscreen().catch(() => {});
  if (document.pictureInPictureElement === tile.video) document.exitPictureInPicture().catch(() => {});
  state.resizeObserver?.unobserve(tile.video);
  tile.audioSource?.disconnect();
  tile.gain?.disconnect();
  tile.video.srcObject = null;
  tile.root.remove();
  state.tiles.delete(key);
  if (state.pinned === key) state.pinned = null;
  if (relayout) layoutTiles();
}

function removePeerTiles(peerId) {
  removeTile(tileKey(peerId, 'screen'), false);
  removeTile(tileKey(peerId, 'camera'), false);
  layoutTiles();
}

/** O que aparece enquanto a imagem não chega: diz quando o problema é a conexão. */
function waitMessage(peer) {
  const conn = peer.pc.connectionState;
  if (conn === 'failed') return `Sem conexão direta com ${peer.name}. Tentando de novo…`;
  if (conn !== 'connected') return `Conectando com ${peer.name}…`;
  return 'Conectando à transmissão…';
}

function updateTileWaiting(peer) {
  for (const [kind, stream] of [['screen', peer.remoteStream], ['camera', peer.cameraStream]]) {
    const tile = state.tiles.get(tileKey(peer.id, kind));
    if (!tile) continue;
    const track = stream.getVideoTracks()[0];
    const waiting = !track || track.muted || track.readyState === 'ended' || tile.video.videoWidth === 0;
    const paused = kind === 'screen' && peer.state.paused === true;
    tile.root.classList.toggle('waiting', waiting && !paused && tile.watching);
    tile.waitText.textContent = waitMessage(peer);
  }
}

// ---------- O que receber de cada pessoa ----------
// Quem assiste diz a quem transmite o que quer receber (ver Mesh.setView): parou de
// assistir = nada; Telão escondido = só o som; e a imagem na altura em que a tela
// aparece aqui. Quem transmite comprime menos (ou nada) e quem assiste descomprime menos.

const FULL_VIEW = { video: true, audio: true, height: 0, camera: true, camHeight: 0 };
const HIDDEN_PAUSE_MS = 5000; // escondido por mais que isso: para de receber a imagem

/** Altura (em pixels da tela) em que o vídeo de um monitor aparece de verdade. */
function shownHeight(tile) {
  if (document.fullscreenElement === tile.root) return Infinity;
  const box = tile.video.getBoundingClientRect();
  if (!box.width || !box.height) return Infinity;
  const { videoWidth, videoHeight } = tile.video;
  const aspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;
  return Math.min(box.height, box.width / aspect) * (window.devicePixelRatio || 1);
}

/** O que um monitor pede: { video, audio, height }. */
function tileView(tile) {
  if (!tile.watching) return { video: false, audio: false, height: 0 };
  const floating = document.pictureInPictureElement === tile.video;
  if (state.hiddenLong && !floating) return { video: false, audio: true, height: 0 };
  return { video: true, audio: true, height: floating ? 0 : wantedHeight(shownHeight(tile)) };
}

function desiredView(peer) {
  const view = { ...FULL_VIEW };
  const screen = state.tiles.get(tileKey(peer.id, 'screen'));
  if (screen) Object.assign(view, tileView(screen));
  const camera = state.tiles.get(tileKey(peer.id, 'camera'));
  if (camera) {
    const { video, height } = tileView(camera);
    Object.assign(view, { camera: video, camHeight: height });
  }
  return view;
}

function syncViews() {
  clearTimeout(state.viewTimer);
  const mesh = state.mesh;
  if (!mesh) return;
  for (const peer of mesh.peers.values()) mesh.setView(peer.id, desiredView(peer));
}

/** Para mudanças de tamanho (que vêm em rajadas): espera assentar. */
function scheduleViewSync() {
  clearTimeout(state.viewTimer);
  state.viewTimer = setTimeout(syncViews, 400);
}

/** Parar de assistir (ou voltar a assistir) a tela ou a câmera de alguém. */
function setWatching(key, watching) {
  const tile = state.tiles.get(key);
  if (!tile || tile.watching === watching) return;
  tile.watching = watching;
  if (!watching) {
    if (document.pictureInPictureElement === tile.video) document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement === tile.root) document.exitFullscreen().catch(() => {});
    if (state.pinned === key) state.pinned = null;
  }
  const peer = state.mesh?.peers.get(tile.peerId);
  if (peer) updateTileWaiting(peer);
  applyAudioRouting();
  layoutTiles();
  syncViews();
  renderParticipants();
  // O foco vai junto: para o botão de voltar (na fileira de baixo) ou para o monitor.
  const target = watching ? tile.root : $(`#offscreen [data-key="${CSS.escape(key)}"]`);
  target?.focus();
}

/**
 * Arranjo do palco. Só os monitores assistidos aparecem. Com destaque, o escolhido
 * fica no palco e os outros na fileira de baixo; sem destaque e com telas no ar,
 * as câmeras vão para a fileira (rosto não precisa do palco todo).
 */
function layoutTiles() {
  const all = [...state.tiles.values()];
  const watched = all.filter((t) => t.watching);
  const unwatched = all.filter((t) => !t.watching);
  const pinned = watched.length > 1 ? watched.find((t) => t.key === state.pinned) || null : null;
  const screens = watched.filter((t) => t.kind === 'screen');
  let main = watched;
  if (pinned) main = [pinned];
  else if (screens.length && screens.length < watched.length) {
    // As câmeras vão para a fileira, mas preenchem os buracos da grade das telas
    // (3 telas numa grade 2×2 deixariam um canto preto).
    const stage = $('#tiles');
    const cols = bestColumns(screens.length, stage.clientWidth, stage.clientHeight);
    const holes = cols * Math.ceil(screens.length / cols) - screens.length;
    main = [...screens, ...watched.filter((t) => t.kind === 'camera').slice(0, holes)];
  }
  const strip = watched.filter((t) => !main.includes(t));

  const tiles = $('#tiles');
  const row = $('#tile-strip');
  all.forEach((tile, index) => {
    tile.root.hidden = !tile.watching;
    tile.root.style.order = String(index); // a ordem de chegada, onde quer que o monitor esteja
    const parent = strip.includes(tile) ? row : tiles;
    // Mudar de lugar tira o monitor da página por um instante, e isso fecharia a
    // tela cheia: o monitor em tela cheia fica onde está.
    const fullscreen = document.fullscreenElement === tile.root;
    if (tile.watching && !fullscreen && tile.root.parentElement !== parent) parent.append(tile.root);
    tile.root.classList.toggle('pinned', tile === pinned);
    tile.pinBtn.setAttribute('aria-pressed', String(tile === pinned));
    tile.pinBtn.hidden = watched.length < 2;
    tile.pinBtn.title = tile === pinned ? 'Tirar o destaque' : 'Destacar';
  });
  tiles.hidden = main.length === 0;
  row.hidden = strip.length === 0;
  renderOffscreen(unwatched);
  renderEmptyStage();
  // Multivisor: as colunas que deixam cada imagem maior no espaço que sobrou.
  tiles.style.setProperty('--cols', String(bestColumns(main.length, tiles.clientWidth, tiles.clientHeight)));
  updateKeepAwake();
  scheduleViewSync(); // o tamanho de cada imagem mudou
}

/**
 * O monitor vazio do palco. Sozinho na sala, ele vira o convite: quem criou a sala
 * manda o link; quem entrou por convite fica sabendo que é o primeiro (e confere a
 * sala: um nome diferente é outra sala, vazia).
 */
function renderEmptyStage() {
  const mesh = state.mesh;
  if (!mesh) return;
  const tiles = [...state.tiles.values()];
  const watched = tiles.filter((t) => t.watching).length;
  const unwatched = tiles.length - watched;
  const alone = mesh.peers.size === 0;
  const stage = $('#empty-stage');
  stage.hidden = watched > 0;
  stage.classList.toggle('is-alone', alone);
  $('#empty-idle').hidden = alone || unwatched > 0;
  $('#empty-unwatched').hidden = alone || unwatched === 0;
  $('#empty-alone').hidden = !alone;
  if (!alone) {
    $('#empty-title').textContent = unwatched ? 'Você não está assistindo ninguém' : 'Ninguém está transmitindo';
    return;
  }
  const host = state.joinedAs === 'host';
  $('#empty-title').textContent = host ? 'Só você na sala por enquanto' : 'Você é o primeiro aqui';
  $('#empty-alone-text').replaceChildren(...(host
    ? ['Mande o convite para a turma: quem clicar nele abre o Telão já na sala ', el('strong', {}, mesh.room), '.']
    : ['Ninguém mais entrou na sala ', el('strong', {}, mesh.room),
      ' ainda. Se a turma já devia estar aqui, confira se o convite é o mesmo: um nome de sala diferente é outra sala, vazia.']));
  const link = mainInvite();
  $('#empty-invite').hidden = !link;
  $('#empty-invite-link').textContent = link || '';
  $('#empty-invite-link').title = link || '';
}

/** "Não assistindo": quem você parou de assistir, para voltar com um clique. */
function renderOffscreen(unwatched) {
  const box = $('#offscreen');
  const peers = state.mesh?.peers;
  const items = unwatched.map((tile) => ({
    tile,
    paused: tile.kind === 'screen' && peers?.get(tile.peerId)?.state.paused === true,
  }));
  // Refaz só quando muda: refazer à toa tiraria o foco de quem usa o teclado.
  const sig = items.map(({ tile, paused }) => `${tile.key}|${tile.peerName}|${paused}`).join('/');
  box.hidden = items.length === 0;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(
    el('span', { class: 'offscreen-label' }, 'Não assistindo'),
    ...items.map(({ tile, paused }) => {
      const camera = tile.kind === 'camera';
      return el('button', {
        type: 'button', class: 'offscreen-chip', dataset: { key: tile.key },
        title: `Voltar a assistir ${camera ? `a câmera de ${tile.peerName}` : tile.peerName}`,
        onclick: () => setWatching(tile.key, true),
      },
      el('span', { class: `tally${paused ? ' paused' : ''}`, 'aria-hidden': 'true' }),
      el('strong', {}, tile.peerName),
      el('span', { class: 'chip-kind' }, camera ? 'câmera' : 'tela'),
      el('span', { class: 'chip-action', html: `${icon('eye')}Assistir` }));
    }),
  );
}

// ---------- Atualização ----------
// O processo principal baixa a versão nova sozinho (ver setupUpdates no main.js);
// aqui só aparece o aviso: na tela inicial uma faixa, na sala uma tecla no alto.

function renderUpdate(status) {
  if (status) state.update = status;
  const s = state.update;
  const ready = s?.status === 'ready';
  const portable = s?.status === 'available';
  const show = ready || portable;
  $('#update-banner').hidden = !show;
  // Na sala, um aviso só: a faixa no topo do painel; dispensada ("Agora não"), fica
  // a tecla do alto, com a lâmpada de novidade.
  const banner = show && state.updateDismissed !== s.version;
  $('#room-update').hidden = !banner;
  $('#update-btn').hidden = !show || banner;
  if (!show) return;
  const title = ready ? `Versão ${s.version} pronta` : `Versão ${s.version} disponível`;
  $('#update-title').textContent = title;
  // Na sala, com o painel estreito, a palavra do fim sai para o título caber na linha.
  $('#room-update-title').replaceChildren(`Versão ${s.version}`, el('span', { class: 'update-word' }, ready ? ' pronta' : ' disponível'));
  $('#update-detail').textContent = ready
    ? 'Ela entra sozinha quando você fechar o Telão.'
    : 'O Telão portátil não se atualiza sozinho: baixe o arquivo novo.';
  // Na sala, a faixa é de uma linha só: o detalhe fica na dica do mouse.
  $('#room-update').title = ready
    ? 'Ela entra quando você fechar o Telão. Atualizar agora tira você da sala por alguns segundos.'
    : 'O Telão portátil não se atualiza sozinho: baixe o arquivo novo.';
  const action = ready ? 'Reiniciar e atualizar' : 'Baixar';
  $('#update-apply').textContent = action;
  $('#room-update-apply').textContent = ready ? 'Atualizar' : 'Baixar';
  $('#room-update-apply').title = ready ? `Reiniciar e atualizar para a ${s.version}` : `Baixar a versão ${s.version}`;
  const btn = $('#update-btn');
  btn.title = ready ? `Reiniciar e atualizar para a ${s.version}` : `Baixar a versão ${s.version}`;
  btn.querySelector('.label').textContent = ready ? 'Atualizar' : 'Versão nova';
}

async function applyUpdate() {
  if (state.update?.status === 'ready' && state.inRoom) {
    const ok = await askConfirm({
      title: `Atualizar para a ${state.update.version} agora?`,
      text: state.hosting
        ? 'O Telão reinicia, e a sala que você hospeda fecha para todos.'
        : 'O Telão reinicia, e você sai da sala por alguns segundos.',
      ok: 'Reiniciar e atualizar',
    });
    if (!ok) return;
  }
  try {
    await api.installUpdate();
  } catch {
    toast('Não foi possível iniciar a atualização.', 'error');
  }
}

/** Painel da sala (coluna da direita): recolhido, o multivisor fica com a janela toda. */
function applyConsole() {
  const hidden = prefs.consoleHidden === true;
  $('#room-view').classList.toggle('console-hidden', hidden);
  const btn = $('#console-btn');
  btn.setAttribute('aria-pressed', String(!hidden));
  btn.setAttribute('aria-label', 'Painel da sala');
  btn.title = hidden ? 'Mostrar o painel da sala' : 'Esconder o painel da sala (mais espaço para as telas)';
  if (state.inRoom) layoutTiles();
}

function applyAudioRouting() {
  // No som por aplicativo o próprio Telão já fica de fora (sem eco). Só no modo
  // "sem filtro" o som dos outros precisa ser silenciado enquanto você transmite.
  const echoGuard = Boolean(state.share?.audioMode === 'system' && prefs.antiEcho);
  for (const tile of state.tiles.values()) {
    if (tile.kind !== 'screen') continue; // a câmera não tem som
    // Parou de assistir: silencia aqui também (quem transmite numa versão antiga
    // não entende o pedido e continuaria mandando o som).
    const muted = tile.userMuted || echoGuard || !tile.watching;
    const volume = Number(tile.volume.value);
    if (tile.gain) tile.gain.gain.value = muted ? 0 : volume; // no navegador, o som vai pelo Web Audio
    tile.video.muted = muted || isWeb();
    tile.muteBtn.innerHTML = icon(muted || volume === 0 ? 'volume-x' : 'volume');
    tile.muteBtn.classList.toggle('active', muted);
    tile.muteBtn.title = echoGuard
      ? 'Silenciado para evitar eco enquanto você transmite com som (dá para mudar no painel)'
      : (tile.userMuted ? `Ativar o som de ${tile.peerName}` : `Silenciar ${tile.peerName}`);
    tile.muteBtn.setAttribute('aria-label', tile.muteBtn.title);
    // Na faixa: por que essa pessoa não está sendo ouvida (o volume fica lembrado pelo nome).
    let why = '';
    if (tile.watching && echoGuard) why = 'Som silenciado para evitar eco enquanto você transmite com som (dá para mudar no painel)';
    else if (tile.watching && tile.userMuted) why = `Você silenciou ${tile.peerName}: passe o mouse na tela e clique no alto-falante`;
    else if (tile.watching && volume === 0) why = `O volume de ${tile.peerName} está no zero`;
    tile.muteBadge.hidden = !why;
    tile.muteBadge.title = why;
    tile.muteBadge.setAttribute('aria-label', why || 'som ligado');
  }
}

function updateKeepAwake() {
  api.keepAwake(Boolean(state.share || state.camera) || watchedTiles().length > 0);
}

// ---------- Reações ----------

function floatReaction(layer, emoji, name) {
  if (!layer) return;
  const item = el('span', { class: 'reaction' }, emoji, el('small', {}, name));
  item.style.setProperty('--x', `${10 + Math.random() * 80}%`);
  layer.append(item);
  setTimeout(() => item.remove(), 2700);
}

function sendReaction(targetId, emoji) {
  if (!state.mesh) return;
  const now = Date.now();
  state.reactionTimes = state.reactionTimes.filter((t) => now - t < 2000);
  if (state.reactionTimes.length >= 6) return; // calma: no máximo 6 a cada 2 s
  state.reactionTimes.push(now);
  state.mesh.sendReaction(targetId, emoji);
  floatReaction(state.tiles.get(targetId)?.reactions, emoji, 'você');
}

function showReaction({ from, target, emoji }) {
  if (target === state.mesh?.id) floatReaction($('#preview-reactions'), emoji, from.name);
  else floatReaction(state.tiles.get(target)?.reactions, emoji, from.name);
}

// ---------- Estatísticas, sinal e sugestões ----------

async function updateStats() {
  const mesh = state.mesh;
  if (!mesh) return;
  await Promise.all([...mesh.peers.values()].map(async (peer) => {
    let tracker = state.trackers.get(peer.id);
    if (!tracker) state.trackers.set(peer.id, (tracker = new StatsTracker()));
    try {
      peer.stats = await tracker.collect(peer.pc, {
        remoteVideoTrackId: peer.remoteStream.getVideoTracks()[0]?.id,
        sendVideoMid: peer.videoTx?.mid,
      });
    } catch {
      peer.stats = null;
    }
  }));
  if (state.mesh !== mesh) return;
  // Com a janela escondida ninguém vê os números: só o que serve para sugestões e avisos.
  const visible = !document.hidden;
  for (const peer of mesh.peers.values()) {
    if (visible) renderTileStats(peer);
    updateTileWaiting(peer);
  }
  if (visible) {
    renderParticipants();
    renderOutgoing();
  }
  updateSuggestion();
  refreshShareSettings(); // as estatísticas dizem se a placa de vídeo está comprimindo
}

function renderTileStats(peer) {
  if (!peer) return;
  const s = peer.stats;
  const level = s?.recvVideo?.lossRate != null ? peerSignal(s) : null;
  // O sinal é da conexão com a pessoa: vale para a tela e para a câmera dela.
  for (const kind of ['screen', 'camera']) {
    const monitor = state.tiles.get(tileKey(peer.id, kind));
    if (!monitor) continue;
    // Sinal ótimo: só as barrinhas; o texto aparece quando há problema.
    const parts = level ? [signalBars(level)] : [];
    if (level && level !== 'good') parts.push(el('span', { class: 'signal-text' }, `sinal ${SIGNAL_TEXT[level]}`));
    monitor.signal.replaceChildren(...parts);
    monitor.signal.title = level ? `Sinal ${SIGNAL_TEXT[level]}` : '';
  }
  const tile = state.tiles.get(tileKey(peer.id, 'screen'));
  if (!tile || tile.stats.hidden) return;
  const lines = [];
  const v = s?.recvVideo;
  if (v?.width) {
    lines.push(`${v.width}×${v.height} · ${formatFps(v.fps)}`);
    const hw = hardwareLabel(v);
    lines.push(`${formatBitrate(v.bitrate)} · ${v.codec || '?'}${hw ? ` (decod. ${hw})` : ''}`);
    if (v.lost) lines.push(`pacotes perdidos: ${v.lost}`);
  }
  if (s?.recvAudio?.bitrate) lines.push(`som: ${formatBitrate(s.recvAudio.bitrate)}`);
  const route = describeRoute(s?.route);
  if (route) {
    const rtt = s.route.rtt != null ? ` · ${Math.round(s.route.rtt * 1000)} ms` : '';
    lines.push(`conexão: ${route.text}${rtt}`);
  }
  tile.stats.textContent = lines.join('\n') || 'Aguardando dados…';
}

function renderOutgoing() {
  const box = $('#outgoing');
  $('#outgoing-details').hidden = !state.share || !state.mesh;
  if (!state.share || !state.mesh) {
    box.replaceChildren();
    return;
  }
  $('#outgoing-summary').textContent = String(state.mesh.peers.size);
  const rows = [];
  for (const peer of state.mesh.peers.values()) {
    const v = peer.stats?.sendVideo;
    if (!peer.view.video) {
      // Nada é comprimido para quem parou de assistir (ou está com o Telão escondido).
      const why = peer.view.audio ? 'Telão escondido: só o som' : 'parou de assistir';
      rows.push(el('div', { class: 'out-row' }, el('strong', {}, peer.name), el('span', {}, why)));
      continue;
    }
    if (!v?.bitrate || !v.width) {
      rows.push(el('div', { class: 'out-row' }, el('strong', {}, peer.name), el('span', {}, state.share.paused ? 'pausado' : 'iniciando envio…')));
      continue;
    }
    const hw = hardwareLabel(v);
    const parts = [
      `${v.width}×${v.height}${peer.view.height ? ' (tela pequena lá)' : ''}`,
      formatFps(v.fps), formatBitrate(v.bitrate), `${v.codec || '?'}${hw ? ` (${hw})` : ''}`,
    ];
    const limit = v.limitation && v.limitation !== 'none' ? LIMITATION_TEXT[v.limitation] : null;
    const level = levelFrom({
      rtt: peer.stats.remoteVideo?.rtt ?? peer.stats.route?.rtt ?? null,
      loss: peer.stats.remoteVideo?.fractionLost ?? null,
      limited: v.limitation === 'bandwidth',
    });
    rows.push(el('div', { class: 'out-row' },
      el('strong', { class: 'out-name' }, peer.name,
        level ? el('span', { class: `pill signal-pill ${SIGNAL_KIND[level]}` }, signalBars(level), SIGNAL_TEXT[level]) : null),
      el('span', {}, parts.join(' · ')),
      limit ? el('span', { class: 'limit' }, limit) : null));
  }
  box.replaceChildren(...(rows.length ? rows : [el('p', { class: 'hint' }, 'Ninguém na sala para receber sua transmissão ainda.')]));
}

function hideSuggestion() {
  state.suggestion = null;
  $('#suggestion').hidden = true;
}

/**
 * Se a internet ou o processador limitam a transmissão por alguns segundos
 * seguidos, sugere ajustes mais leves com um clique.
 */
function updateSuggestion() {
  if (!state.share || !state.mesh || state.share.paused) {
    state.limit = { reason: null, seconds: 0 };
    hideSuggestion();
    return;
  }
  // Só conta quem está recebendo a imagem.
  const receiving = [...state.mesh.peers.values()].filter((p) => p.view.video);
  const reason = limitReason(receiving.map((p) => p.stats?.sendVideo?.limitation));
  if (!reason) {
    state.limit = { reason: null, seconds: 0 };
    hideSuggestion();
    return;
  }
  const step = STATS_INTERVAL_MS / 1000;
  state.limit = state.limit.reason === reason ? { reason, seconds: state.limit.seconds + step } : { reason, seconds: step };
  if (state.suggestion || state.limit.seconds < SUGGEST_AFTER_SECONDS || Date.now() < state.suggestSnoozeUntil) return;
  const suggestion = suggestLowerSettings(readShareSettings(), reason, { hardwareH264: hardwareEncoder() });
  if (!suggestion) return;
  const viewers = receiving.length;
  state.suggestion = suggestion;
  $('#suggestion-text').textContent = reason === 'cpu'
    ? 'Seu processador está no limite e a transmissão pode travar.'
    : `Sua internet não está dando conta de enviar nesta qualidade para ${viewers} ${viewers === 1 ? 'pessoa' : 'pessoas'}.`;
  $('#suggestion-apply').textContent = suggestion.text;
  $('#suggestion').hidden = false;
  $('#suggestion').scrollIntoView({ block: 'nearest' });
  // Com o jogo na frente, ninguém vê a faixa: avisa (só pisca/notifica fora de foco).
  api.attention({ title: 'A transmissão está travando', body: `Sugestão: ${suggestion.text}. Clique para abrir o Telão.` }).catch(() => {});
}

// ---------- Qualidade ----------

function fillSelect(selector, options, value, fallback) {
  const select = $(selector);
  select.replaceChildren(...options.map(([v, label]) => el('option', { value: v }, label)));
  select.value = String(value);
  if (!select.value) select.value = String(fallback);
}

function setupQualityControls() {
  const s = prefs.share;
  const d = DEFAULT_SHARE_SETTINGS;
  fillSelect('#q-resolution', RESOLUTIONS.map((r) => [r.id, r.label]), s.resolution, d.resolution);
  fillSelect('#q-fps', FRAME_RATES.map((f) => [String(f), `${f} fps`]), s.fps, d.fps);
  fillSelect('#q-bitrate', BITRATES.map((b) => [String(b), b ? `${b} Mb/s` : 'Automático']), s.bitrate, d.bitrate);
  fillSelect('#q-optimize', OPTIMIZE.map((o) => [o.id, o.label]), s.optimize, d.optimize);
  fillSelect('#q-codec', CODECS.map((c) => [c.id, c.label]), s.codec, d.codec);
  for (const id of ['#q-resolution', '#q-fps', '#q-bitrate', '#q-optimize', '#q-codec']) {
    $(id).addEventListener('change', onQualityChange);
  }
  // Teclas de formato: o nome e, embaixo, o que ele entrega (1080p · 60 fps).
  $('#presets').replaceChildren(...QUALITY_PRESETS.map((preset) => el('button', {
    type: 'button', class: 'preset', 'aria-pressed': 'false', dataset: { preset: preset.id }, title: preset.use,
    onclick: () => applyShareSettings(preset.settings),
  }, el('span', { class: 'preset-name' }, preset.label), el('span', { class: 'preset-spec' }, presetSpec(preset.settings)))));
  $('#anti-echo').checked = prefs.antiEcho;
  $('#anti-echo').addEventListener('change', () => {
    prefs.antiEcho = $('#anti-echo').checked;
    savePrefs();
    applyAudioRouting();
  });
  renderPresets();
  updateBitrateHint();
}

function renderPresets() {
  const active = matchPreset(readShareSettings());
  for (const button of $$('#presets .preset')) button.setAttribute('aria-pressed', String(button.dataset.preset === active));
  $('#preset-custom').hidden = Boolean(active);
  renderQualitySummary();
}

/**
 * A qualidade em uma linha. Fora do ar, o resumo (as teclas ficam no seletor de
 * tela); no ar, a linha que abre as teclas, para mudar sem parar a transmissão.
 */
function renderQualitySummary() {
  const live = Boolean(state.share);
  const settings = readShareSettings();
  const preset = QUALITY_PRESETS.find((p) => p.id === matchPreset(settings));
  const name = preset ? preset.label : 'Personalizada';
  $('#share-idle').hidden = live;
  $('#share-quality').hidden = !live;
  $('#share-quality-summary').textContent = `Qualidade: ${name} · ${presetSpec(settings)}`;
  if (!live) {
    $('#share-idle').replaceChildren('Fora do ar. Em ', el('strong', {}, 'Compartilhar tela'),
      ` você escolhe a tela, o som e a qualidade (agora: ${name.toLowerCase()}, ${presetSpec(settings)}).`);
  }
}

function readShareSettings() {
  return {
    resolution: $('#q-resolution').value,
    fps: Number($('#q-fps').value),
    bitrate: Number($('#q-bitrate').value),
    optimize: $('#q-optimize').value,
    codec: $('#q-codec').value,
  };
}

function applyShareSettings(settings) {
  $('#q-resolution').value = settings.resolution;
  $('#q-fps').value = String(settings.fps);
  $('#q-bitrate').value = String(settings.bitrate);
  $('#q-optimize').value = settings.optimize;
  $('#q-codec').value = settings.codec;
  onQualityChange();
}

/** Quantas pessoas recebem a minha imagem agora (quem parou de assistir não conta). */
function videoViewers() {
  return state.mesh ? [...state.mesh.peers.values()].filter((p) => p.view.video).length : 0;
}

/**
 * A placa de vídeo está comprimindo para todo mundo? As estatísticas do envio dizem
 * com certeza; antes delas, vale o que o Chromium informa (mediaCapabilities).
 */
function hardwareEncoder() {
  const seen = state.mesh
    ? [...state.mesh.peers.values()].map((p) => p.stats?.sendVideo?.hardware).filter((h) => typeof h === 'boolean')
    : [];
  return seen.length ? seen.every(Boolean) : state.hwH264;
}

/** Os ajustes que valem de verdade: "Automático" vira H.264 e o FPS pode ser limitado (ver effectiveFps). */
function meshSettings(settings) {
  const fps = effectiveFps(settings, { hardware: hardwareEncoder(), viewers: videoViewers() });
  return { ...settings, codec: resolveCodec(settings.codec), fps };
}

/** Reaplica os ajustes quando o que vale de verdade mudou (gente entrou, saiu, parou de assistir…). */
function refreshShareSettings() {
  if (!state.share || !state.mesh) return;
  const settings = meshSettings(prefs.share);
  const key = JSON.stringify(settings);
  if (key === state.share.appliedKey) return;
  state.share.appliedKey = key;
  state.mesh.updateShareSettings(settings).then(updateBitrateHint);
  if (settings.fps < prefs.share.fps && !state.capWarned) {
    state.capWarned = true;
    toast('Seu PC está comprimindo a transmissão no processador: com 2 ou mais pessoas assistindo, ela vai a 30 fps para não travar.', 'warn', 9000);
  }
}

function onQualityChange() {
  prefs.share = readShareSettings();
  savePrefs();
  // A sugestão foi calculada para os ajustes de antes: recomeça a contagem.
  state.limit = { reason: null, seconds: 0 };
  hideSuggestion();
  refreshShareSettings();
  updateBitrateHint();
  renderPresets();
}

function updateBitrateHint() {
  const chosen = readShareSettings();
  const settings = meshSettings(chosen);
  const track = state.share?.stream.getVideoTracks()[0];
  const bps = targetBitrate(settings, track?.getSettings());
  const viewers = videoViewers();
  let text = `Até ${formatBitrate(bps)} para cada pessoa assistindo`;
  if (viewers > 1) text += `: upload total de até ${formatBitrate(bps * viewers)} com ${viewers} pessoas`;
  text += '.';
  if (settings.fps < chosen.fps) {
    text += ' Sem compressão na placa de vídeo, com 2 ou mais pessoas assistindo a transmissão vai a 30 fps para não travar o PC.';
  }
  $('#bitrate-hint').textContent = text;
}

// ---------- Transmissão ----------

function renderShareUi() {
  const sharing = Boolean(state.share);
  const paused = Boolean(state.share?.paused);
  // Fora do ar, "Compartilhar tela" é a tecla forte (neutra: o vermelho cheio é só do
  // que está no ar); no ar, "Parar transmissão" é uma tecla comum com o ícone de parar.
  const btn = $('#share-btn');
  btn.classList.toggle('live', sharing);
  btn.classList.toggle('primary', !sharing);
  btn.innerHTML = `${icon(sharing ? 'stop' : 'monitor')}<span class="label">${sharing ? 'Parar transmissão' : 'Compartilhar tela'}</span>`;
  $('#share-live').hidden = !sharing;
  $('#share-live').classList.toggle('paused', paused);
  // Lâmpada NO AR com o tempo no ar: apagada fora do ar, acende ao transmitir, âmbar
  // pausada. No ar, ela também é a tecla de pausar e retomar.
  const onAir = $('#on-air');
  onAir.classList.toggle('off', !sharing);
  onAir.classList.toggle('paused', paused);
  onAir.setAttribute('aria-disabled', String(!sharing));
  onAir.tabIndex = sharing ? 0 : -1; // fora do ar, não é uma parada do Tab
  const action = paused ? 'Retomar' : 'Pausar';
  onAir.title = sharing ? `${action} a transmissão${keyHint('Ctrl+Alt+P')}` : 'Você não está transmitindo';
  onAir.setAttribute('aria-label', sharing ? `${paused ? 'Pausado' : 'No ar'}. ${action} a transmissão` : 'Fora do ar');
  $('#on-air-lamp').textContent = paused ? 'Pausado' : 'No ar';
  $('#on-air-lamp').dataset.hover = action;
  // O símbolo do alto acende (a ordem do painel muda em renderParticipants, abaixo).
  $('#room-view').classList.toggle('is-live', sharing);
  announceAir(sharing ? (paused ? 'paused' : 'live') : 'off');
  renderQualitySummary();
  if (sharing) updateClock();
  else $('#on-air-time').textContent = '--:--:--';
  $('#anti-echo-row').hidden = state.info.appAudio && state.share?.audioMode !== 'system';
  $('#pause-btn').innerHTML = `${icon(paused ? 'play' : 'pause')}${paused ? 'Retomar' : 'Pausar'}`;
  $('#pause-btn').title = `${paused ? 'Retomar' : 'Pausar'} a transmissão${keyHint('Ctrl+Alt+P')}`;
  // No iPhone e no Android não dá para transmitir a tela: sem a tecla, a lâmpada e o painel.
  for (const id of ['#share-btn', '#on-air', '#share-panel']) $(id).hidden = !canShareScreen();
  $('#preview-paused').hidden = !paused;
  const preview = $('#local-preview');
  if (sharing) {
    $('#share-source').textContent = `${state.share.source.name} · ${state.share.audio ? 'com som' : 'sem som'}${paused ? ' · pausada' : ''}`;
    if (preview.srcObject !== state.share.preview) {
      preview.srcObject = state.share.preview;
      preview.play().catch(() => {});
    }
  } else {
    preview.srcObject = null;
  }
  renderShareAudio();
  renderParticipants();
  renderOutgoing();
  updateBitrateHint();
  renderVoiceUi(); // o modo "Tudo (sem filtro)" leva as vozes junto: avisa no painel Voz
}

const AIR_TEXT = {
  live: 'Você está no ar.',
  paused: 'Transmissão pausada: os outros veem uma tela preta.',
  off: 'Você saiu do ar.',
};

/** Avisa o leitor de tela quando você entra no ar, pausa ou sai. */
function announceAir(air) {
  if (state.airState === air) return;
  state.airState = air;
  $('#sr-status').textContent = AIR_TEXT[air];
}

/** Tempo no ar (hh:mm:ss) ao lado da lâmpada NO AR. */
function updateClock() {
  const share = state.share;
  if (!share || document.hidden) return;
  const seconds = Math.max(0, Math.floor((Date.now() - share.startedAt) / 1000));
  const text = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  const node = $('#on-air-time');
  if (node.textContent !== text) node.textContent = text;
}

function renderShareAudio() {
  const share = state.share;
  $('#share-audio-info').hidden = !share?.audio;
  if (!share?.audio) return;
  let text;
  if (share.appAudio) {
    const { capturing, excluded } = share.appAudio.summary([state.info.selfExe]);
    const nobody = share.audioMode === 'pick' ? 'nenhum dos apps escolhidos está tocando agora' : 'nenhum tocando agora';
    const what = share.audioMode === 'app' ? `Som só de ${share.source.name}` : (share.audioMode === 'pick' ? 'Som só de' : 'Som dos apps');
    text = `${what}: ${capturing.length ? capturing.join(', ') : nobody}.`;
    if (excluded.length) text += ` Fora da transmissão: ${excluded.join(', ')}.`;
  } else {
    text = isWeb() ? 'Som escolhido na janela do navegador.' : 'Som de todo o computador, sem filtro (inclui chamadas de voz).';
  }
  $('#share-audio-text').textContent = text;
}

function updateMeter() {
  const meter = state.share?.meter;
  const level = meter && !state.share.paused ? meter.level() : 0;
  $('#share-meter').style.setProperty('--level', level.toFixed(3));
}

async function captureSource(sourceId, settings, withAudio) {
  // No navegador, a lista do que transmitir é a dele; e o pedido tem de sair direto do
  // clique (sem esperar nada antes), senão o navegador recusa.
  if (!isWeb()) await api.selectSource(sourceId, withAudio);
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(settings),
      audio: withAudio ? AUDIO_CONSTRAINTS : false,
    });
  } catch (err) {
    if (!withAudio) throw err;
    console.warn('Captura com som falhou; tentando sem som.', err);
    if (isWeb()) throw err; // no navegador, recusar é recusar (não pergunta de novo)
    await api.selectSource(sourceId, false);
    return navigator.mediaDevices.getDisplayMedia({ video: videoConstraints(settings), audio: false });
  }
}

function releaseShare(share) {
  share.stream.getTracks().forEach((t) => t.stop());
  share.preview.getTracks().forEach((t) => t.stop());
  share.appAudio?.stop();
  share.meter?.close();
}

/**
 * Prévia de "Sua transmissão": só para conferir, então poucos quadros e pequena
 * bastam (desenhar a tela inteira 60 vezes por segundo ali custava processador à
 * toa). É uma cópia da faixa: o limite vale só para ela, não para quem assiste.
 */
function makePreview(videoTrack) {
  const track = videoTrack.clone();
  track.applyConstraints({ frameRate: { max: PREVIEW_FPS }, width: { max: 640 }, height: { max: 360 } }).catch(() => {});
  return new MediaStream([track]);
}

/** Modo de som efetivo: "só o app" só existe para janelas. */
function effectiveAudioMode(source, enabled) {
  if (!enabled) return 'none';
  if (!state.info.appAudio) return state.info.systemAudio ? 'system' : 'none';
  const mode = source.type === 'window' ? prefs.audioModeWindow : prefs.audioModeScreen;
  if (mode === 'app' && source.type !== 'window') return 'all';
  return ['all', 'app', 'pick', 'system'].includes(mode) ? mode : 'all';
}

/** Começa (ou troca) a transmissão. Devolve true se ela começou. */
async function startShare(source, audioEnabled) {
  const mesh = state.mesh;
  if (!mesh || state.starting) return false;
  const starting = {};
  state.starting = starting;
  try {
    return await beginShare(source, audioEnabled, () => state.mesh === mesh && state.starting === starting);
  } finally {
    if (state.starting === starting) state.starting = null;
  }
}

async function beginShare(source, audioEnabled, stillWanted) {
  const settings = readShareSettings();
  const mode = effectiveAudioMode(source, audioEnabled);
  let stream;
  try {
    stream = await captureSource(source.id, settings, mode === 'system');
  } catch (err) {
    if (stillWanted() && err?.name !== 'NotAllowedError') toast(`Não foi possível capturar: ${cleanError(err)}`, 'error', 8000);
    return false;
  }
  if (isWeb()) {
    // O nome do que foi escolhido na lista do navegador.
    const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    source = { ...source, name: { monitor: 'Tela inteira', window: 'Janela', browser: 'Aba do navegador' }[surface] || 'Tela' };
  }

  let appAudio = null;
  if (stillWanted() && (mode === 'all' || mode === 'app' || mode === 'pick')) {
    appAudio = new AppAudioCapture(api);
    try {
      const track = await appAudio.start({ mode, sourceId: source.id, exclude: excludedApps(), include: pickedApps() });
      stream = new MediaStream([...stream.getVideoTracks(), track]);
    } catch (err) {
      appAudio.stop();
      appAudio = null;
      toast(`Não foi possível capturar o som dos apps (${cleanError(err)}). Transmitindo só a imagem.`, 'warn', 8000);
    }
  }

  const audioTrack = stream.getAudioTracks()[0] || null;
  const share = {
    stream,
    source,
    audio: Boolean(audioTrack),
    audioMode: !audioTrack ? 'none' : (appAudio ? mode : 'system'),
    appAudio,
    meter: audioTrack ? new LevelMeter(audioTrack) : null,
    preview: makePreview(stream.getVideoTracks()[0]),
    paused: false,
  };
  // Saiu da sala (ou entrou em outra) enquanto a captura começava: não publica.
  if (!stillWanted()) {
    releaseShare(share);
    return false;
  }
  if (mode === 'system' && !audioTrack) toast('O som do computador não pôde ser capturado. Transmitindo só a imagem.', 'warn', 8000);
  if (appAudio) {
    appAudio.addEventListener('change', () => { if (state.share === share) renderShareAudio(); });
    appAudio.addEventListener('warning', (e) => toast(e.detail, 'warn', 7000));
    appAudio.addEventListener('failure', (e) => { if (state.share === share) toast(e.detail, 'error', 8000); });
  }
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (state.share === share) stopShare('A tela ou janela transmitida foi fechada.');
  });

  const previous = state.share;
  state.share = share;
  if (!previous) state.capWarned = false;
  // Trocar de tela não zera o tempo no ar.
  share.startedAt = previous?.startedAt ?? Date.now();
  clearInterval(state.clockTimer);
  state.clockTimer = setInterval(updateClock, 1000);
  const effective = meshSettings(settings);
  share.appliedKey = JSON.stringify(effective);
  state.mesh.startShare(stream, effective, { label: source.name, audio: share.audio });
  if (previous) releaseShare(previous);
  else chime('start');
  prefs.lastShare = { id: source.id, type: source.type, name: source.name, audio: audioEnabled };
  savePrefs();
  clearInterval(state.meterTimer);
  state.meterTimer = share.meter ? setInterval(updateMeter, 100) : null;
  renderShareUi();
  applyAudioRouting();
  updateKeepAwake();
  pushStatus();
  return true;
}

function stopShare(reason) {
  if (!state.share) return;
  const share = state.share;
  state.share = null;
  state.mesh?.stopShare();
  releaseShare(share);
  clearInterval(state.meterTimer);
  state.meterTimer = null;
  clearInterval(state.clockTimer);
  state.clockTimer = null;
  hideSuggestion();
  chime('stop');
  if (reason) toast(reason, 'warn');
  if (state.inRoom) renderShareUi();
  applyAudioRouting();
  updateKeepAwake();
  pushStatus();
}

/** Pausar: os outros veem tela preta e nenhum som; a captura continua pronta para voltar. */
function setPaused(paused) {
  if (!state.share || state.share.paused === paused) return;
  state.share.paused = paused;
  state.mesh?.setPaused(paused);
  chime('pause');
  renderShareUi();
  pushStatus();
}

function togglePause() {
  if (state.share) setPaused(!state.share.paused);
}

// ---------- Voz ----------
// O microfone vai para todos na sala que estão na 1.5 ou mais nova, com o
// cancelamento de eco e a redução de ruído do Chromium. Desligado, o Telão solta
// o microfone (o Windows deixa de mostrar que ele está em uso).

const SPEAKING_REMOTE = 0.02; // nível da voz que chega (0 a 1, linear) a partir do qual alguém fala
const SPEAKING_HOLD_MS = 450; // segura o contorno entre as palavras
const METER_FLOOR_DB = -70; // o medidor e a barra de sensibilidade vão de -70 a -10 dB
const METER_RANGE_DB = 60;
const VOICE_GATE_URL = new URL('./voice-gate.js', import.meta.url);

/** Abre o microfone com os ajustes de agora (redução de ruído, eco e ganho). */
async function openMicInput(deviceId) {
  const audio = voiceConstraints({ noiseSuppression: prefs.voiceNoise, echoCancellation: prefs.voiceEcho, autoGainControl: prefs.voiceGain });
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { ...audio, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) }, video: false });
    return stream.getAudioTracks()[0];
  } catch (err) {
    // O microfone lembrado pode ter sido desconectado: tenta o padrão do Windows.
    if (!deviceId || !['NotFoundError', 'OverconstrainedError'].includes(err?.name)) throw err;
    return (await navigator.mediaDevices.getUserMedia({ audio, video: false })).getAudioTracks()[0];
  }
}

/**
 * O caminho da voz: microfone → sensibilidade (voice-gate.js) → faixa enviada.
 * A faixa enviada é sempre a mesma enquanto o microfone está ligado: trocar de
 * microfone ou de ajuste só troca a entrada, e quem recebe nem percebe.
 */
async function createVoicePipeline() {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
  try {
    await ctx.audioWorklet.addModule(VOICE_GATE_URL);
    const gate = new AudioWorkletNode(ctx, 'telao-voice-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    gate.connect(dest);
    await ctx.resume();
    const mic = { ctx, gate, outTrack: dest.stream.getAudioTracks()[0], input: null, source: null, level: -100, open: false, threshold: prefs.voiceThreshold };
    gate.port.onmessage = (event) => Object.assign(mic, event.data); // { level, open, threshold }, 20 vezes por segundo
    return mic;
  } catch (err) {
    ctx.close().catch(() => {});
    throw err;
  }
}

/** Manda a sensibilidade para o processador da voz. */
function applyGateSettings() {
  state.mic?.gate.port.postMessage({ auto: prefs.voiceAuto !== false, threshold: Number(prefs.voiceThreshold) || -50 });
}

/**
 * Liga o microfone. Com ele já ligado, troca só a entrada: outro microfone, ou os
 * ajustes de ruído, eco e ganho mudaram (o Chromium só aplica esses ao abrir).
 */
async function startMic(deviceId = prefs.micId) {
  if (state.micStarting || !state.mesh) return false;
  state.micStarting = true;
  renderVoiceUi();
  let input = null;
  try {
    // Com o microfone ligado, solta o atual antes de abrir de novo: se ele continuasse
    // aberto, o Chromium reaproveitaria essa captura com os ajustes antigos.
    if (state.mic?.input) {
      state.mic.source?.disconnect();
      state.mic.input.stop();
      state.mic.input = null;
      state.mic.source = null;
    }
    input = await openMicInput(deviceId);
    if (!state.mesh) return false; // saiu da sala enquanto o microfone abria
    let mic = state.mic;
    if (!mic) {
      mic = await createVoicePipeline();
      if (!state.mesh) {
        mic.ctx.close().catch(() => {});
        return false;
      }
      state.mic = mic;
      state.mesh.setMic(mic.outTrack);
    }
    const old = mic.input;
    mic.source?.disconnect();
    mic.input = input;
    mic.source = mic.ctx.createMediaStreamSource(new MediaStream([input]));
    mic.source.connect(mic.gate);
    input = null; // agora é do caminho da voz
    old?.stop();
    applyGateSettings();
    prefs.micId = mic.input.getSettings().deviceId || '';
    savePrefs();
    const current = mic.input;
    current.addEventListener('ended', () => {
      if (state.mic?.input === current) stopMic('O microfone parou: foi desconectado ou outro programa o pegou.');
    });
    return true;
  } catch (err) {
    toast(micErrorMessage(err), 'error', 10000);
    // Trocando de microfone ou de ajuste, o anterior já foi solto: desliga de vez.
    if (state.mic && !state.mic.input) queueMicrotask(() => stopMic());
    return false;
  } finally {
    input?.stop(); // não chegou a entrar no caminho da voz
    state.micStarting = false;
    if (state.inRoom) {
      renderVoiceUi();
      renderParticipants();
    }
    pushStatus();
  }
}

function stopMic(reason) {
  const mic = state.mic;
  if (!mic) return;
  state.mic = null;
  state.mesh?.setMic(null);
  mic.input?.stop();
  mic.outTrack.stop();
  mic.ctx.close().catch(() => {});
  state.speaking.delete('me');
  if (reason) {
    toast(reason, 'warn');
    // Com o jogo na frente, ninguém vê o aviso: som e notificação também.
    playSound('mic-off');
    api.attention({ title: 'O microfone parou', body: reason }).catch(() => {});
  }
  if (state.inRoom) {
    renderVoiceUi();
    renderParticipants();
  }
  pushStatus();
}

/** Liga ou desliga o microfone (botão, Ctrl+Alt+M, bandeja). A escolha fica lembrada. */
async function toggleMic({ shortcut = false } = {}) {
  if (!state.inRoom || state.micStarting) return;
  if (state.mic) {
    stopMic();
    prefs.micOn = false;
  } else {
    // Falar com as vozes silenciadas não faz sentido: volta a ouvir também (como no Discord).
    if (state.deafened) await setDeafened(false, { restoreMic: false });
    prefs.micOn = await startMic();
  }
  savePrefs();
  // Pelo atalho, com o jogo na frente, o som é a única confirmação: toca sempre.
  if (shortcut || prefs.sounds !== false) playSound(state.mic ? 'mic-on' : 'mic-off');
}

/**
 * Silenciar vozes: não ouço ninguém e o meu microfone desliga junto (como no
 * Discord). Desfazer volta a ouvir e religa o microfone, se ele estava ligado.
 */
async function setDeafened(on, { restoreMic = true } = {}) {
  if (state.deafened === on) return;
  state.deafened = on;
  if (on) {
    state.micBeforeDeafen = Boolean(state.mic);
    stopMic();
  } else if (restoreMic && state.micBeforeDeafen && !state.mic) {
    await startMic();
  }
  applyVoiceRouting();
  renderVoiceUi();
  renderParticipants();
  pushStatus(); // a bandeja mostra "vozes silenciadas"
}

/** Silenciar vozes pela tecla, por Ctrl+Alt+D ou pela bandeja, com o som de confirmação. */
function toggleDeafen({ shortcut = false } = {}) {
  if (!state.inRoom) return;
  setDeafened(!state.deafened);
  // Pelo atalho, com o jogo na frente, o som é a única confirmação: toca sempre.
  if (shortcut || prefs.sounds !== false) playSound(state.deafened ? 'deafen-on' : 'deafen-off');
}

const VOICE_MAX_VOLUME = 2; // dá para aumentar a voz de alguém até 200%, como no Discord

/**
 * Toca a voz de cada pessoa: stream → ganho (o volume dela, até 200%) → alto-falante.
 * O <audio> mudo continua ligado ao stream porque, no Chromium, o áudio que chega pela
 * conexão só flui no Web Audio se também estiver num elemento de mídia.
 */
function syncVoice(peer) {
  if (!state.mesh || !peer.voiceStream.getAudioTracks().length) return;
  const ctx = roomAudio();
  checkAudioRunning();
  let voice = state.voices.get(peer.id);
  if (!voice) {
    const audio = el('audio', { autoplay: true });
    audio.muted = true;
    $('#voices').append(audio);
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    voice = { audio, source: null, gain, sig: '' };
    state.voices.set(peer.id, voice);
  }
  // Só religa quando a faixa mudou (religar à toa corta a voz).
  const sig = peer.voiceStream.getTracks().map((t) => t.id).join(',');
  if (voice.sig !== sig) {
    voice.sig = sig;
    voice.audio.srcObject = null;
    voice.audio.srcObject = peer.voiceStream;
    voice.audio.play().catch(() => {});
    voice.source?.disconnect();
    voice.source = ctx.createMediaStreamSource(peer.voiceStream);
    voice.source.connect(voice.gain);
  }
  applyVoiceRouting();
}

function removeVoice(peerId) {
  const voice = state.voices.get(peerId);
  if (!voice) return;
  voice.source?.disconnect();
  voice.gain.disconnect();
  voice.audio.srcObject = null;
  voice.audio.remove();
  state.voices.delete(peerId);
  state.speaking.delete(peerId);
}

/** O volume da voz de alguém (0 a 2), como ficou lembrado pelo nome. */
function voiceVolume(name) {
  const saved = prefs.voiceVolumes?.[name]?.volume;
  return Number.isFinite(saved) ? Math.min(VOICE_MAX_VOLUME, Math.max(0, saved)) : 1;
}

/** Volume e mudo de cada voz (lembrados pelo nome), e "Silenciar vozes". */
function applyVoiceRouting() {
  for (const [id, voice] of state.voices) {
    const peer = state.mesh?.peers.get(id);
    const muted = state.deafened || (peer && prefs.voiceVolumes?.[peer.name]?.muted === true);
    voice.gain.gain.value = muted || !peer ? 0 : voiceVolume(peer.name);
  }
}

function rememberVoice(name, change) {
  const volumes = { ...(prefs.voiceVolumes || {}) };
  volumes[name] = { volume: 1, muted: false, ...volumes[name], ...change };
  const names = Object.keys(volumes);
  for (const old of names.slice(0, Math.max(0, names.length - 50))) delete volumes[old];
  prefs.voiceVolumes = volumes;
  savePrefs();
  applyVoiceRouting();
}

/** Posição (0 a 1) de um nível em dB no medidor e na barra de sensibilidade. */
function meterPosition(db) {
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / METER_RANGE_DB));
}

function isSpeaking(id) {
  return Date.now() - (state.speaking.get(id) || 0) < SPEAKING_HOLD_MS;
}

/** Quem está falando agora: o contorno no avatar, e o medidor do meu microfone. */
function updateSpeaking() {
  const mesh = state.mesh;
  if (!mesh) return;
  const now = Date.now();
  const mic = state.mic;
  if (mic) {
    // O medidor: verde com a voz passando, apagado abaixo do limite (que é a marca).
    const meter = $('#mic-meter-row');
    meter.style.setProperty('--level', meterPosition(mic.level).toFixed(3));
    meter.style.setProperty('--threshold', meterPosition(mic.threshold).toFixed(3));
    meter.classList.toggle('open', mic.open);
    if (prefs.voiceAuto !== false) showSensitivity(Math.round(mic.threshold));
  }
  const levels = [['me', Boolean(mic?.open)]];
  for (const peer of mesh.peers.values()) levels.push([peer.id, mesh.voiceLevel(peer.id) >= SPEAKING_REMOTE]);
  for (const [id, loud] of levels) {
    if (loud) state.speaking.set(id, now);
    const row = $(`#participants [data-peer="${CSS.escape(id)}"]`);
    row?.classList.toggle('speaking', isSpeaking(id));
  }
}

/** A barra de sensibilidade (e o valor que o leitor de tela lê). */
function showSensitivity(db) {
  const slider = $('#sensitivity');
  slider.value = String(db);
  slider.setAttribute('aria-valuetext', `${slider.value} dB`);
}

function renderVoiceUi() {
  const on = Boolean(state.mic);
  const btn = $('#mic-btn');
  btn.setAttribute('aria-pressed', String(on));
  btn.disabled = state.micStarting;
  btn.innerHTML = icon(on ? 'mic' : 'mic-off');
  btn.title = `${on ? 'Desligar' : 'Ligar'} o microfone${keyHint('Ctrl+Alt+M')}`;
  const key = $('#mic-key');
  key.setAttribute('aria-pressed', String(on));
  key.disabled = state.micStarting;
  // Rótulo fixo: o estado é a tecla acesa (e o aria-pressed), não a palavra.
  key.innerHTML = `${icon(on ? 'mic' : 'mic-off')}Microfone`;
  key.title = btn.title;
  const deaf = $('#deafen-key');
  deaf.setAttribute('aria-pressed', String(state.deafened));
  deaf.innerHTML = `${icon(state.deafened ? 'headphones-off' : 'headphones')}Silenciar vozes`;
  deaf.title = state.deafened ? `Voltar a ouvir as vozes${keyHint('Ctrl+Alt+D')}` : `Não ouvir ninguém; o seu microfone desliga junto${keyHint('Ctrl+Alt+D')}`;
  $('#mic-meter-row').hidden = !on;
  $('#mic-meter-off').hidden = on;
  $('#mic-device-field').hidden = true;
  // Ajustes do microfone.
  const auto = prefs.voiceAuto !== false;
  $('#sensitivity-auto').checked = auto;
  $('#sensitivity').disabled = auto;
  if (!auto) showSensitivity(prefs.voiceThreshold);
  $('#voice-noise').checked = prefs.voiceNoise !== false;
  $('#voice-echo').checked = prefs.voiceEcho !== false;
  $('#voice-gain').checked = prefs.voiceGain !== false;
  if (on) renderMicDevices();
  renderVoicePeople();
  // Avisos (só quando há o que avisar): quem não ouve a voz, e o modo de som que
  // levaria as vozes para a transmissão. As dicas fixas ficam em "Ajustes do microfone".
  const notes = [];
  const old = [...(state.mesh?.peers.values() || [])].filter((peer) => !supportsVoice(peer)).map((peer) => peer.name);
  if (old.length) notes.push(`${old.join(', ')} ${old.length > 1 ? 'estão' : 'está'} numa versão antiga do Telão e não ${old.length > 1 ? 'participam' : 'participa'} da voz.`);
  if (state.share?.audioMode === 'system') notes.push('Transmitindo com "Tudo (sem filtro)", as vozes da sala vão junto no som da transmissão.');
  $('#voice-hint').textContent = notes.join(' ');
  $('#voice-hint').hidden = notes.length === 0;
}

/** Lista dos microfones do PC (só aparece com mais de um). */
async function renderMicDevices() {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch { /* sem lista: fica o microfone atual */ }
  if (!state.mic) return;
  const current = state.mic.input?.getSettings().deviceId;
  $('#mic-device').replaceChildren(...devices.map((d, i) => el('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `Microfone ${i + 1}`)));
  $('#mic-device-field').hidden = devices.length < 2;
}

/** Volume da voz de cada pessoa com o microfone ligado (refeito só quando a lista muda). */
function renderVoicePeople() {
  const box = $('#voice-people');
  const people = [...(state.mesh?.peers.values() || [])].filter((peer) => peer.remoteVoiceId);
  box.hidden = people.length === 0;
  const sig = people.map((peer) => `${peer.id}|${peer.name}`).join('/');
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(...people.map((peer) => {
    const volume = el('input', {
      type: 'range', min: '0', max: String(VOICE_MAX_VOLUME), step: '0.05', value: String(voiceVolume(peer.name)),
      'aria-label': `Volume da voz de ${peer.name}`,
    });
    const percent = el('span', { class: 'voice-percent', 'aria-hidden': 'true' });
    const showPercent = () => {
      percent.textContent = `${Math.round(Number(volume.value) * 100)}%`;
      volume.title = `Volume da voz de ${peer.name}: ${percent.textContent}`;
      volume.setAttribute('aria-valuetext', percent.textContent);
    };
    // Um clique duplo volta para 100%.
    volume.addEventListener('dblclick', () => {
      volume.value = '1';
      volume.dispatchEvent(new Event('input'));
    });
    const mute = el('button', { type: 'button', class: 'icon-btn small' });
    const paint = () => {
      const muted = prefs.voiceVolumes?.[peer.name]?.muted === true;
      mute.innerHTML = icon(muted ? 'volume-x' : 'volume');
      mute.classList.toggle('active', muted);
      mute.title = muted ? `Ouvir ${peer.name} de novo` : `Silenciar a voz de ${peer.name}`;
      mute.setAttribute('aria-label', mute.title);
    };
    volume.addEventListener('input', () => {
      rememberVoice(peer.name, { volume: Number(volume.value) });
      showPercent();
    });
    showPercent();
    mute.addEventListener('click', () => {
      rememberVoice(peer.name, { muted: prefs.voiceVolumes?.[peer.name]?.muted !== true });
      paint();
    });
    paint();
    return el('div', { class: 'voice-person' }, el('span', { class: 'voice-name', title: peer.name }, peer.name), volume, percent, mute);
  }));
}

// ---------- Câmera ----------
// A câmera é independente da transmissão de tela: dá para ligar as duas, ou só uma.
// Vai sem som, até 540p a 30 fps, e só para quem está na versão 1.4 ou mais nova.

async function startCamera(deviceId = prefs.cameraId) {
  if (state.cameraStarting || !state.mesh) return;
  state.cameraStarting = true;
  renderCameraUi();
  try {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { ...CAMERA_CONSTRAINTS, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
        audio: false,
      });
    } catch (err) {
      // A câmera lembrada pode ter sido desconectada: tenta a padrão do Windows.
      if (!deviceId || !['NotFoundError', 'OverconstrainedError'].includes(err?.name)) throw err;
      stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA_CONSTRAINTS, audio: false });
    }
    const track = stream.getVideoTracks()[0];
    if (!state.mesh) { // saiu da sala enquanto a câmera abria
      track.stop();
      return;
    }
    useCameraTrack(track);
  } catch (err) {
    toast(cameraErrorMessage(err), 'error', 10000);
  } finally {
    state.cameraStarting = false;
    renderCameraUi();
  }
}

/** Liga a câmera com essa faixa, ou troca a câmera mantendo o mesmo stream. */
function useCameraTrack(track) {
  const camera = state.camera;
  if (camera) {
    const old = camera.track;
    camera.stream.removeTrack(old);
    camera.stream.addTrack(track);
    camera.track = track;
    old.stop();
  } else {
    state.camera = { stream: new MediaStream([track]), track };
    chime('stream');
  }
  prefs.cameraId = track.getSettings().deviceId || '';
  savePrefs();
  // Câmera desconectada (ou tomada por outro programa): desliga e avisa.
  track.addEventListener('ended', () => {
    if (state.camera?.track === track) stopCamera('A câmera parou: foi desconectada ou outro programa a pegou.');
  });
  state.mesh.startCamera(state.camera.stream);
  renderParticipants();
  updateKeepAwake();
}

function stopCamera(reason) {
  const camera = state.camera;
  if (!camera) return;
  state.camera = null;
  state.mesh?.stopCamera();
  for (const track of camera.stream.getTracks()) track.stop();
  if (reason) {
    toast(reason, 'warn');
    // Com o jogo na frente, ninguém vê o aviso: som e notificação também.
    playSound('stop');
    api.attention({ title: 'A câmera parou', body: reason }).catch(() => {});
  } else {
    chime('stop');
  }
  if (state.inRoom) {
    renderCameraUi();
    renderParticipants();
  }
  updateKeepAwake();
}

function renderCameraUi() {
  const on = Boolean(state.camera);
  const btn = $('#camera-btn');
  btn.setAttribute('aria-pressed', String(on));
  btn.disabled = state.cameraStarting;
  btn.title = on ? 'Desligar a câmera' : 'Ligar a câmera (vai sem som)';
  $('#camera-panel').hidden = !on;
  const preview = $('#camera-preview');
  if (!on) {
    preview.srcObject = null;
    return;
  }
  if (preview.srcObject !== state.camera.stream) {
    preview.srcObject = state.camera.stream;
    preview.play().catch(() => {});
  }
  // Quem está numa versão antiga não recebe a câmera.
  const old = [...(state.mesh?.peers.values() || [])].filter((peer) => !supportsCamera(peer)).map((peer) => peer.name);
  $('#camera-hint').textContent = old.length
    ? `${old.join(', ')} ${old.length > 1 ? 'estão' : 'está'} numa versão antiga do Telão e não ${old.length > 1 ? 'veem' : 'vê'} a sua câmera.`
    : 'Vai para todos na sala, sem som.';
  renderCameraDevices();
}

/** Lista das câmeras do PC (só aparece com mais de uma). */
async function renderCameraDevices() {
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  } catch { /* sem lista: fica a câmera atual */ }
  if (!state.camera) return;
  const current = state.camera.track.getSettings().deviceId;
  $('#camera-device').replaceChildren(...devices.map((d, i) => el('option', { value: d.deviceId, selected: d.deviceId === current }, d.label || `Câmera ${i + 1}`)));
  $('#camera-device-field').hidden = devices.length < 2;
  $('#camera-source').textContent = state.camera.track.label || '';
}

// ---------- Escolha da tela ----------

async function openPicker() {
  state.picker.selected = state.share?.source.id ?? state.picker.selected;
  state.pickStale = true; // o que está tocando som agora pode ter mudado
  // A qualidade se escolhe junto com a tela: as teclas vêm do painel para cá (e
  // voltam quando o seletor fecha, ver setupPicker).
  $('#picker-quality').append($('#quality-box'));
  if (!$('#picker').open) $('#picker').showModal();
  await loadSources();
}

async function loadSources() {
  const grid = $('#source-grid');
  grid.replaceChildren(el('div', { class: 'grid-loading' }, el('div', { class: 'spinner' })));
  // A miniatura de janela é a parte cara: o Windows desenha cada janela aberta,
  // até a do jogo, e isso engasga o PC. Só vem quando a aba Janelas está aberta.
  const windowThumbs = state.picker.tab === 'window';
  const load = ++state.picker.loads;
  let sources;
  try {
    sources = await api.listSources({ windowThumbnails: windowThumbs });
  } catch (err) {
    if (load === state.picker.loads) grid.replaceChildren(el('p', { class: 'hint' }, `Não foi possível listar as telas: ${cleanError(err)}`));
    return;
  }
  if (load !== state.picker.loads) return; // uma lista mais nova já está a caminho
  state.picker.sources = sources;
  state.picker.windowThumbs = windowThumbs;
  if (!sources.some((s) => s.id === state.picker.selected)) {
    state.picker.selected = sources.find((s) => s.type === state.picker.tab)?.id ?? null;
  }
  renderSources();
}

/** Marca a aba escolhida (para a vista e para o leitor de tela). */
function markTab(tab) {
  for (const t of $$('.tab')) {
    t.classList.toggle('active', t.dataset.tab === tab);
    t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    t.tabIndex = t.dataset.tab === tab ? 0 : -1; // as setas andam entre as abas
  }
}

function renderSources() {
  const { sources, tab, selected } = state.picker;
  markTab(tab);
  const list = sources.filter((s) => s.type === tab);
  const grid = $('#source-grid');
  if (!list.length) {
    grid.replaceChildren(el('p', { class: 'hint' }, tab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta encontrada.'));
  } else {
    grid.replaceChildren(...list.map((s) => {
      const card = el('button', {
        class: `source-card${s.id === selected ? ' selected' : ''}`, type: 'button', title: s.name,
        'aria-pressed': String(s.id === selected), dataset: { id: s.id },
      },
        el('div', { class: 'source-thumb' }, s.thumbnail ? el('img', { src: s.thumbnail, alt: '' }) : el('span', { html: icon('monitor') })),
        el('div', { class: 'source-name' }, s.icon ? el('img', { src: s.icon, alt: '' }) : null, el('span', {}, s.name)),
        s.detail ? el('div', { class: 'source-detail' }, s.detail) : null);
      card.addEventListener('click', () => {
        state.picker.selected = s.id;
        renderSources();
      });
      card.addEventListener('dblclick', () => $('#picker-start').click());
      return card;
    }));
  }
  $('#picker-start').disabled = !sources.some((s) => s.id === state.picker.selected);
  syncAudioControls();
}

// ---------- Opções de som ----------

const AUDIO_MODE_LABELS = {
  all: 'Todos os apps, menos os excluídos',
  app: 'Só o app desta janela',
  pick: 'Só os apps que eu escolher',
  system: 'Tudo, sem filtro (inclui Discord)',
};

function parseExcludeList(text) {
  const names = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(names)].slice(0, 64);
}

function excludedApps() {
  return prefs.audioExclude || state.info.defaultExcludedApps;
}

function selectedSource() {
  return state.picker.sources.find((s) => s.id === state.picker.selected) || null;
}

function isExcludedApp(name) {
  const lower = String(name).toLowerCase();
  return excludedApps().some((n) => {
    const excluded = String(n).toLowerCase();
    return excluded === lower || `${excluded}.exe` === lower;
  });
}

/** Apps marcados que de fato vão no som (os da lista de excluídos nunca vão). */
function pickedApps() {
  return (Array.isArray(prefs.audioPick) ? prefs.audioPick : []).filter((n) => !isExcludedApp(n));
}

function syncAudioControls() {
  const enabled = $('#share-audio').checked;
  const source = selectedSource();
  const isWindow = source?.type === 'window';
  const select = $('#audio-mode');
  const modes = isWindow ? ['app', 'all', 'pick', 'system'] : ['all', 'pick', 'system'];
  select.replaceChildren(...modes.map((m) => el('option', { value: m }, AUDIO_MODE_LABELS[m])));
  select.value = effectiveAudioMode(source || { type: 'screen' }, true);
  select.disabled = !enabled;
  $('#exclude-toggle').textContent = `Apps excluídos (${excludedApps().length})`;
  const picking = state.info.appAudio && enabled && select.value === 'pick';
  // Sem nenhum app marcado em "Só os apps que eu escolher", Transmitir fica desativado
  // (o motivo aparece no aviso logo abaixo).
  $('#picker-start').disabled = !source || (picking && !pickedApps().length);
  const pickPanel = $('#pick-apps');
  if (picking && (pickPanel.hidden || state.pickStale)) {
    state.pickStale = false;
    loadAudioApps();
  }
  pickPanel.hidden = !picking;

  const hint = $('#audio-hint');
  if (isWeb()) {
    hint.textContent = enabled
      ? 'O navegador pergunta o que transmitir. Para ir com som, marque a opção de compartilhar o áudio na janela dele.'
      : 'A transmissão vai sem som.';
  } else if (!state.info.systemAudio) hint.textContent = 'O som do computador só pode ser transmitido no Windows.';
  else if (!enabled) hint.textContent = 'A transmissão vai sem som.';
  else if (!state.info.appAudio) hint.textContent = 'Inclui todo o som do PC. O som dos outros participantes fica mudo enquanto você transmite, para evitar eco.';
  else if (select.value === 'app') hint.textContent = `Só o som de "${source.name}". Discord e os outros apps excluídos ficam de fora.`;
  else if (select.value === 'pick') {
    hint.textContent = pickedApps().length
      ? `Vai só o som de: ${pickedApps().map(exeLabel).join(', ')}.`
      : 'Marque pelo menos um app para ir no som.';
  } else if (select.value === 'all') hint.textContent = 'Discord, TeamSpeak e os outros apps excluídos ficam de fora. O som do Telão também, então não há eco.';
  else hint.textContent = 'Captura tudo, inclusive chamadas de voz. O som dos outros participantes fica mudo enquanto você transmite, para evitar eco.';
}

async function loadAudioApps() {
  $('#pick-list').replaceChildren(el('p', { class: 'hint' }, el('span', { class: 'spinner tiny' }), ' Procurando apps com som…'));
  try {
    state.pickApps = await api.listAudioApps();
  } catch {
    state.pickApps = [];
  }
  renderPickList();
}

function renderPickList() {
  const chosen = new Map(pickedApps().map((n) => [n.toLowerCase(), n]));
  const all = new Map([...state.pickApps, ...pickedApps()].map((n) => [n.toLowerCase(), n]));
  const list = $('#pick-list');
  if (!all.size) {
    list.replaceChildren(el('p', { class: 'hint' }, 'Nenhum app tocando som agora. Dê play no que você quer transmitir e clique em Recarregar.'));
    return;
  }
  list.replaceChildren(...[...all.values()].map((name) => {
    const excluded = isExcludedApp(name);
    const input = el('input', { type: 'checkbox' });
    input.checked = chosen.has(name.toLowerCase()) && !excluded;
    input.disabled = excluded;
    input.addEventListener('change', () => {
      const next = new Map(pickedApps().map((n) => [n.toLowerCase(), n]));
      if (input.checked) next.set(name.toLowerCase(), name);
      else next.delete(name.toLowerCase());
      prefs.audioPick = [...next.values()];
      savePrefs();
      syncAudioControls();
    });
    const title = excluded
      ? `${name} está em "Apps excluídos", então o som dele nunca vai. Para transmiti-lo, tire-o dessa lista.`
      : name;
    return el('label', { class: `check${excluded ? ' disabled' : ''}`, title }, input,
      el('span', {}, exeLabel(name), excluded ? el('em', {}, ' (excluído)') : null));
  }));
}

function setupAudioControls() {
  const supported = state.info.appAudio;
  $('#share-audio').checked = prefs.audio;
  $('#audio-row').hidden = !state.info.systemAudio;
  $('#audio-mode').hidden = !supported;
  $('#exclude-toggle').hidden = !supported;
  $('#exclude-list').value = excludedApps().join('\n');

  $('#share-audio').addEventListener('change', () => {
    prefs.audio = $('#share-audio').checked;
    savePrefs();
    syncAudioControls();
  });
  $('#audio-mode').addEventListener('change', () => {
    const value = $('#audio-mode').value;
    if (selectedSource()?.type === 'window') prefs.audioModeWindow = value;
    else prefs.audioModeScreen = value;
    savePrefs();
    syncAudioControls();
  });
  $('#pick-refresh').addEventListener('click', loadAudioApps);
  $('#exclude-toggle').addEventListener('click', () => {
    $('#exclude-editor').hidden = !$('#exclude-editor').hidden;
  });
  const setExcluded = (list) => {
    prefs.audioExclude = list;
    $('#exclude-list').value = excludedApps().join('\n');
    savePrefs();
    syncAudioControls();
    if (!$('#pick-apps').hidden) renderPickList(); // a marca "(excluído)" muda
  };
  // "Restaurar a lista padrão" vira "Desfazer" por alguns segundos: a lista era sua.
  const resetButton = $('#exclude-reset');
  let undoList = null;
  let undoTimer = 0;
  const showReset = () => {
    clearTimeout(undoTimer);
    undoList = null;
    resetButton.textContent = 'Restaurar a lista padrão';
    resetButton.disabled = !prefs.audioExclude;
  };
  $('#exclude-list').addEventListener('change', () => {
    setExcluded(parseExcludeList($('#exclude-list').value));
    showReset();
  });
  resetButton.addEventListener('click', () => {
    if (undoList) {
      setExcluded(undoList);
      showReset();
      return;
    }
    const previous = prefs.audioExclude;
    setExcluded(null);
    showReset();
    undoList = previous;
    resetButton.textContent = 'Desfazer';
    resetButton.disabled = false;
    undoTimer = setTimeout(showReset, 10000);
  });
  showReset();
  syncAudioControls();
}

function setupPicker() {
  const dialog = $('#picker');
  $('#picker-close').addEventListener('click', () => dialog.close());
  $('#picker-cancel').addEventListener('click', () => dialog.close());
  $('#picker-refresh').addEventListener('click', loadSources);
  // As teclas de qualidade voltam para o painel "Sua transmissão" (ver openPicker).
  dialog.addEventListener('close', () => $('#share-quality-slot').append($('#quality-box')));
  // Abas: as setas (e Home/End) trocam de aba, como nas abas do Windows.
  $('.picker-tabs').addEventListener('keydown', (event) => {
    const tabs = $$('.tab');
    const i = tabs.indexOf(event.target);
    if (i < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let next = event.key === 'ArrowRight' ? i + 1 : event.key === 'ArrowLeft' ? i - 1 : 0;
    if (event.key === 'End') next = tabs.length - 1;
    const tab = tabs[(next + tabs.length) % tabs.length];
    tab.focus();
    tab.click();
  });
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      state.picker.tab = tab.dataset.tab;
      if (state.picker.tab === 'window' && !state.picker.windowThumbs) {
        markTab(state.picker.tab);
        loadSources(); // agora sim, com as miniaturas das janelas
      } else {
        renderSources();
      }
    });
  }
  setupAudioControls();
  $('#picker-start').addEventListener('click', async () => {
    const source = selectedSource();
    if (!source) return;
    // Salva a lista de excluídos mesmo se o campo ainda estiver com o foco.
    if (!$('#exclude-editor').hidden) {
      prefs.audioExclude = parseExcludeList($('#exclude-list').value);
      savePrefs();
    }
    const audio = state.info.systemAudio && $('#share-audio').checked;
    if (audio && effectiveAudioMode(source, true) === 'pick' && !pickedApps().length) {
      $('#audio-hint').textContent = 'Marque pelo menos um app para ir no som (ou desmarque "Transmitir som").';
      return;
    }
    dialog.close();
    await startShare(source, audio);
  });
}

// ---------- Aparência ----------

// Cores de destaque que se confundem com as luzes de estado (ver accentConflict no theme.js).
const ACCENT_CONFLICT = {
  green: 'Essa cor se confunde com o verde de "conectado" e de quem está falando. Dá para usar, mas a luz de "no ar" fica menos clara.',
  amber: 'Essa cor se confunde com o âmbar de "pausado". Dá para usar, mas a luz de "no ar" fica menos clara.',
  gray: 'Essa cor é quase cinza: a luz de "no ar" vai parecer apagada.',
  danger: 'Essa cor se confunde com o vermelho de erro. Dá para usar, mas "no ar" e "deu erro" ficam parecidos.',
};

function currentAppearance() {
  return Theme.normalize(prefs.appearance);
}

/** Aplica tema e cor; o processo principal ajusta o tema nativo e o fundo da janela. */
async function applyAppearance(notifyMain = true) {
  const appearance = currentAppearance();
  Theme.apply(appearance);
  syncAppearanceDialog();
  if (!notifyMain) return;
  try {
    const mode = await api.setAppearance({
      theme: appearance.theme,
      backgrounds: { dark: Theme.SURFACES.dark.bg, light: Theme.SURFACES.light.bg },
    });
    // "Igual ao Windows": quem sabe o modo certo na hora é o processo principal.
    const latest = currentAppearance();
    if (latest.theme === 'system') Theme.apply(latest, undefined, mode);
  } catch (err) {
    console.warn('Não foi possível ajustar o tema da janela:', err);
  }
}

function updateAppearance(changes) {
  prefs.appearance = { ...currentAppearance(), ...changes };
  savePrefs();
  applyAppearance('theme' in changes);
}

function syncAppearanceDialog() {
  const { theme, accent } = currentAppearance();
  for (const radio of $$('input[name="theme"]')) radio.checked = radio.value === theme;
  let isPreset = false;
  for (const swatch of $$('#accent-swatches .swatch')) {
    const selected = swatch.dataset.color === accent;
    if (selected) isPreset = true;
    swatch.setAttribute('aria-pressed', String(selected));
  }
  $('#accent-custom').value = accent;
  $('#accent-custom-label').classList.toggle('selected', !isPreset);
  $('#accent-hex').textContent = accent.toUpperCase();
  const conflict = Theme.accentConflict(accent);
  $('#accent-warning').hidden = !conflict;
  $('#accent-warning').textContent = conflict ? ACCENT_CONFLICT[conflict] : '';
  $('#sounds-on').checked = prefs.sounds !== false;
}

function setupAppearance() {
  const dialog = $('#appearance');
  $('#accent-swatches').replaceChildren(...Theme.PRESETS.map((preset) => {
    const swatch = el('button', {
      type: 'button', class: 'swatch', title: preset.name, 'aria-label': preset.name,
      'aria-pressed': 'false', dataset: { color: preset.color }, html: icon('check'),
    });
    swatch.style.setProperty('--swatch', preset.color);
    swatch.style.setProperty('--swatch-text', Theme.toHex(Theme.readableOn(Theme.parseHex(preset.color))));
    swatch.addEventListener('click', () => updateAppearance({ accent: preset.color }));
    return swatch;
  }));
  for (const radio of $$('input[name="theme"]')) {
    radio.addEventListener('change', () => updateAppearance({ theme: radio.value }));
  }
  $('#accent-custom').addEventListener('input', (event) => updateAppearance({ accent: event.target.value }));
  $('#appearance-reset').addEventListener('click', () => {
    prefs.appearance = null;
    savePrefs();
    applyAppearance();
  });
  // Sons de aviso: ficam nos Ajustes (a barra do alto tinha um sino só para isso).
  $('#sounds-on').addEventListener('change', (event) => {
    prefs.sounds = event.target.checked;
    savePrefs();
    if (prefs.sounds) playSound('stream');
  });
  $('#appearance-close').addEventListener('click', () => dialog.close());
  $('#appearance-done').addEventListener('click', () => dialog.close());
  for (const button of $$('[data-open-appearance]')) {
    button.addEventListener('click', () => {
      syncAppearanceDialog();
      dialog.showModal();
    });
  }
  // "Igual ao Windows": acompanha quando o Windows troca entre claro e escuro.
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (currentAppearance().theme === 'system') applyAppearance();
  });
  applyAppearance();
}

// ---------- Início ----------

async function init() {
  hydrateIcons();
  setupAppearance();
  state.info = await api.appInfo();
  // Barra de título integrada: se o sistema não informar onde ficam os botões do
  // Windows, a barra reserva a largura padrão deles (ver .caption-fallback).
  if (state.info.integratedTitleBar && !navigator.windowControlsOverlay?.visible) {
    document.documentElement.classList.add('caption-fallback');
  }
  $('#slate-version').textContent = state.info.version ? `v${state.info.version}` : '';
  if (isWeb()) {
    // No navegador, a sala é no servidor do Telão: "Onde fica a sala" não tem escolha.
    $('#host-cloud').checked = true;
    $('#host-where-field').hidden = true;
  }
  applyConsole();
  restoreJoinForm();
  setupQualityControls();
  setupPicker();

  for (const radio of $$('input[name="mode"], input[name="host-where"]')) radio.addEventListener('change', syncModeFields);
  $('#server-url').addEventListener('input', () => {
    fillRoomFromAddress();
    syncJoinFields();
    checkClipboardInvite();
    updateSlate();
  });
  for (const id of ['#name', '#room']) $(id).addEventListener('input', updateSlate);
  $('#host-tunnel').addEventListener('change', updateSlate);
  $('#room-random').addEventListener('click', () => {
    $('#room').value = randomRoom();
    updateSlate();
  });
  $('#update-apply').addEventListener('click', applyUpdate);
  $('#update-btn').addEventListener('click', applyUpdate);
  $('#room-update-apply').addEventListener('click', applyUpdate);
  $('#room-update-dismiss').addEventListener('click', () => {
    state.updateDismissed = state.update?.version || '';
    renderUpdate();
    $('#update-btn').focus(); // a faixa sumiu; o aviso continua na tecla do alto
  });
  api.onUpdateStatus(renderUpdate);
  api.getUpdateStatus().then(renderUpdate).catch(() => {});
  $('#console-btn').addEventListener('click', () => {
    prefs.consoleHidden = !prefs.consoleHidden;
    savePrefs();
    applyConsole();
  });
  $('#join-form').addEventListener('submit', onJoin);
  $('#share-btn').addEventListener('click', () => (state.share ? stopShare() : openPicker()));
  $('#switch-btn').addEventListener('click', openPicker);
  $('#stop-btn').addEventListener('click', () => stopShare());
  $('#pause-btn').addEventListener('click', togglePause);
  $('#on-air').addEventListener('click', () => { if (state.share) togglePause(); });
  $('#audio-unlock').addEventListener('click', unlockAudio);
  $('#empty-invite-copy').addEventListener('click', () => {
    const link = mainInvite();
    if (link) copyInvite(link);
  });
  $('#confirm-ok').addEventListener('click', () => answerConfirm(true));
  $('#confirm-cancel').addEventListener('click', () => answerConfirm(false));
  $('#confirm').addEventListener('close', () => answerConfirm(false)); // Esc
  $('#leave-btn').addEventListener('click', () => leaveRoom());
  $('#camera-btn').addEventListener('click', () => (state.camera ? stopCamera() : startCamera()));
  for (const id of ['#mic-btn', '#mic-key']) $(id).addEventListener('click', () => toggleMic());
  $('#deafen-key').addEventListener('click', () => toggleDeafen());
  $('#mic-device').addEventListener('change', (event) => startMic(event.target.value));
  $('#sensitivity-auto').addEventListener('change', (event) => {
    prefs.voiceAuto = event.target.checked;
    // Ao passar para manual, começa no limite que a automática estava usando.
    if (!prefs.voiceAuto && state.mic) prefs.voiceThreshold = Math.round(state.mic.threshold);
    savePrefs();
    applyGateSettings();
    renderVoiceUi();
  });
  $('#sensitivity').addEventListener('input', (event) => {
    prefs.voiceThreshold = Number(event.target.value);
    event.target.setAttribute('aria-valuetext', `${event.target.value} dB`);
    savePrefs();
    applyGateSettings();
  });
  // Redução de ruído, eco e ganho: o Chromium só aplica ao abrir o microfone, então
  // com ele ligado a entrada é reaberta (quem recebe não percebe a troca).
  for (const [id, key] of [['#voice-noise', 'voiceNoise'], ['#voice-echo', 'voiceEcho'], ['#voice-gain', 'voiceGain']]) {
    $(id).addEventListener('change', (event) => {
      prefs[key] = event.target.checked;
      savePrefs();
      if (state.mic) startMic(prefs.micId);
    });
  }
  $('#camera-off-btn').addEventListener('click', () => stopCamera());
  $('#camera-device').addEventListener('change', (event) => startCamera(event.target.value));
  // F6 (e Shift+F6) pula entre a barra do alto, o palco e o painel da sala, como no Windows.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'F6' || !state.inRoom || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    const regions = [$('#room-view .topbar'), $('#stage'), $('#console')].filter((r) => r.getClientRects().length);
    const at = regions.findIndex((r) => r.contains(document.activeElement));
    const step = event.shiftKey ? -1 : 1;
    const region = regions[(at < 0 ? 0 : at + step + regions.length) % regions.length];
    const first = [...region.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .find((n) => n.tabIndex >= 0 && !n.disabled && n.getClientRects().length);
    (first || region).focus();
  });
  $('#suggestion-apply').addEventListener('click', () => {
    if (state.suggestion) applyShareSettings(state.suggestion.settings);
    state.limit = { reason: null, seconds: 0 };
    hideSuggestion();
  });
  $('#suggestion-dismiss').addEventListener('click', () => {
    state.suggestSnoozeUntil = Date.now() + SUGGEST_SNOOZE_MS;
    hideSuggestion();
  });
  $('#clipboard-use').addEventListener('click', () => openInvite(state.clipboardInvite));
  $('#clipboard-dismiss').addEventListener('click', () => {
    state.clipboardDismissed = state.clipboardText;
    $('#clipboard-invite').hidden = true;
    $('#server-url').focus(); // o botão com o foco sumiu junto com a faixa
  });
  window.addEventListener('focus', checkClipboardInvite);
  // Minimizado ou coberto pelo jogo por alguns segundos: para de receber a imagem
  // das transmissões (o som continua; a janelinha flutuante também). Volta na hora
  // em que a janela aparece.
  document.addEventListener('visibilitychange', () => {
    clearTimeout(state.hiddenTimer);
    if (document.hidden) {
      state.hiddenTimer = setTimeout(() => {
        state.hiddenLong = true;
        syncViews();
      }, HIDDEN_PAUSE_MS);
      return;
    }
    state.hiddenLong = false;
    syncViews();
    updateClock();
    // O iPhone suspende o som quando a página some: volta (ou pede um toque).
    if (state.inRoom && isWeb()) checkAudioRunning();
    if (state.inRoom) {
      renderParticipants();
      renderOutgoing();
      for (const peer of state.mesh?.peers.values() || []) renderTileStats(peer);
    }
  });
  document.addEventListener('fullscreenchange', scheduleViewSync);
  // Janela redimensionada: refaz o arranjo do multivisor (uma vez por quadro).
  let layoutFrame = 0;
  window.addEventListener('resize', () => {
    if (!state.inRoom || layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      layoutTiles();
    });
  });

  api.onAppAudioData(routeAppAudioData);
  api.onAppAudioEvent(routeAppAudioEvent);
  api.onTunnelProgress((fraction) => {
    if (!state.hosting || state.hosting.download === null) return;
    state.hosting.download = fraction;
    renderInvite();
  });
  api.onTunnelClosed(() => {
    if (!state.hosting) return;
    state.hosting.publicUrl = null;
    state.hosting.tunnel = 'error';
    state.hosting.tunnelError = 'O link público caiu.';
    renderInvite();
  });
  api.onCommand(onCommand);
  api.onInvite((link) => openInvite(parseDeepLink(link)));

  // "Automático" é H.264; o rótulo diz se a placa de vídeo comprime.
  detectHardwareH264().then((hardware) => {
    state.hwH264 = hardware;
    const option = $('#q-codec option[value="auto"]');
    if (option) option.textContent = hardware ? 'Automático (H.264 na placa de vídeo)' : 'Automático (H.264)';
  });

  if (!prefs.name) $('#name').focus();
  else $(currentMode() === 'join' ? '#server-url' : '#room').focus();
  // O app pode ter sido aberto por um convite clicado (telao://).
  const pending = await api.takePendingInvite().catch(() => null);
  if (pending) openInvite(parseDeepLink(pending));
  else checkClipboardInvite();
}

init().catch((err) => console.error('Falha ao iniciar:', err));
