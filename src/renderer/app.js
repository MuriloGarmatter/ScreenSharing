import {
  DEFAULT_PORT, PUBLIC_SERVER, inviteLink, parseDeepLink, parseInviteText, parseServerAddress,
} from './address.js';
import { AppAudioCapture, LevelMeter, exeLabel, routeAppAudioData, routeAppAudioEvent } from './app-audio.js';
import { Mesh, REACTIONS } from './mesh.js';
import {
  AUDIO_CONSTRAINTS, BITRATES, CODECS, DEFAULT_SHARE_SETTINGS, FRAME_RATES, OPTIMIZE, QUALITY_PRESETS, RESOLUTIONS,
  detectHardwareH264, effectiveFps, matchPreset, presetSpec, resolveCodec, suggestLowerSettings, targetBitrate,
  videoConstraints, wantedHeight,
} from './media.js';
import { bestColumns } from './layout.js';
import { outdatedPeers } from './version.js';
import { playSound } from './sounds.js';
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
  starting: null, // marca do início de transmissão em andamento (sair da sala a invalida)
  pendingInvite: null, // convite clicado enquanto ainda conectava: abre quando a tentativa termina
  meterTimer: null,
  clockTimer: null, // relógio do tempo no ar
  tiles: new Map(), // peerId -> tile
  trackers: new Map(), // peerId -> StatsTracker
  statsTimer: null,
  picker: { sources: [], tab: 'screen', selected: null, windowThumbs: false, loads: 0 },
  pinned: null, // peerId da tela em destaque
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
  updateAnnounced: false,
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
  return $('#host-pc').checked ? 'pc' : 'cloud';
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
  $('#room-random').hidden = !host;
  $('#mode-desc').textContent = host ? 'Você cria a sala e convida os amigos.' : 'Alguém criou a sala e te mandou o link.';
  $('#room-label').textContent = host ? 'Nome da sala' : 'Sala';
  $('#room').placeholder = host ? 'ex.: filme-sexta' : 'vem junto no convite';
  $('#join-btn').textContent = host ? 'Criar sala e entrar' : 'Entrar na sala';
  if (host && !$('#room').value.trim()) $('#room').value = randomRoom();
  updateSlate();
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
    if (!state.pendingInvite) showJoinError(cleanError(err));
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
    const question = state.hosting && state.mesh.peers.size > 0
      ? `Entrar na sala "${invite.room}"? Você está hospedando a sala atual: se sair, os outros participantes perdem a conexão.`
      : `Entrar na sala "${invite.room}"? Você vai sair da sala atual.`;
    if (!window.confirm(question)) return;
    await leaveRoom(true);
  }
  $('#mode-join').checked = true;
  syncModeFields();
  // A senha digitada vale só para o servidor em que foi digitada.
  if (parseServerAddress($('#server-url').value)?.url !== invite.url) $('#server-password').value = '';
  $('#server-url').value = invite.invite;
  $('#room').value = invite.room;
  updateSlate();
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
    if (state.inRoom && !silent) toast(`${peer.name} entrou na sala.`);
  });
  on('peer-left', ({ peer, silent }) => {
    state.sharingPeers.delete(peer.id);
    removeTile(peer.id);
    state.trackers.delete(peer.id);
    renderParticipants();
    renderOutgoing();
    refreshShareSettings();
    updateBitrateHint();
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
  on('remote-track', ({ peer }) => syncTile(peer, true));
  on('remote-media', ({ peer }) => updateTileWaiting(peer));
  on('reaction', showReaction);
  on('connection', ({ peer }) => {
    renderParticipants();
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
    toast(message, 'error', 8000);
    leaveRoom(true);
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
  for (const peer of state.mesh.peers.values()) syncTile(peer);
  layoutTiles();
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(updateStats, STATS_INTERVAL_MS);
  pushStatus();
}

async function leaveRoom(force = false) {
  if (!state.mesh) return;
  if (!force && state.hosting && state.mesh.peers.size > 0) {
    const ok = window.confirm('Você está hospedando esta sala. Se sair, os outros participantes perdem a conexão com o servidor. Sair mesmo assim?');
    if (!ok) return;
  }
  stopShare();
  state.starting = null; // uma transmissão começando agora não vai para a próxima sala
  const mesh = state.mesh;
  state.mesh = null;
  state.inRoom = false;
  mesh.leave();
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  for (const id of [...state.tiles.keys()]) removeTile(id);
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

// ---------- Bandeja, atalhos globais e comandos ----------

/** Informa o processo principal (bandeja, selo "ao vivo", atalhos). */
async function pushStatus() {
  let taken = [];
  try {
    taken = await api.setStatus({ inRoom: state.inRoom, sharing: Boolean(state.share), paused: Boolean(state.share?.paused) });
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
  else if (command === 'share-toggle') toggleShareByShortcut();
}

/**
 * Ctrl+Alt+T: para, ou começa de novo com a mesma tela/janela e o mesmo som.
 * O processo principal manda este comando junto com um "gesto do usuário" (sem
 * ele o getDisplayMedia é recusado). O gesto vale poucos segundos, por isso a
 * lista de telas aqui é a rápida, sem miniaturas.
 */
async function toggleShareByShortcut() {
  if (!state.inRoom || state.starting) return;
  if (state.share) {
    stopShare();
    return;
  }
  const last = prefs.lastShare;
  if (last) {
    let sources = [];
    try { sources = await api.listSources({ thumbnails: false }); } catch { /* cai no seletor */ }
    const source = sources.find((s) => s.id === last.id)
      || (last.type === 'screen' ? sources.find((s) => s.type === 'screen') : null);
    if (source && await startShare(source, last.audio)) return;
  }
  if (!state.inRoom || state.share) return;
  api.showWindow();
  openPicker();
}

function renderSoundsButton() {
  const on = prefs.sounds !== false;
  const btn = $('#sounds-btn');
  btn.innerHTML = icon(on ? 'bell' : 'bell-off');
  btn.setAttribute('aria-pressed', String(on));
  btn.title = on ? 'Sons de aviso: ligados' : 'Sons de aviso: desligados';
  btn.setAttribute('aria-label', 'Sons de aviso'); // o estado vai no aria-pressed
}

// ---------- Convite (quando hospeda) ----------

function inviteRow(link, adapter) {
  const copy = el('button', { class: 'icon-btn small', title: 'Copiar convite', 'aria-label': 'Copiar convite', html: icon('copy') });
  copy.addEventListener('click', async () => {
    await api.copyText(link);
    // O convite que eu mesmo copiei não deve virar a faixa "Você copiou um convite".
    const copied = Array.isArray(prefs.copiedInvites) ? prefs.copiedInvites : [];
    prefs.copiedInvites = [link, ...copied.filter((l) => l !== link)].slice(0, 10);
    savePrefs();
    toast('Convite copiado! Quem clicar nele abre o Telão já na sala.');
  });
  return el('div', { class: 'invite-item' },
    adapter ? el('span', { class: 'invite-iface' }, adapter) : null,
    el('div', { class: 'invite-row' }, el('code', { title: link }, link), copy));
}

// Placas de VPN e de máquinas virtuais vão para o fim da lista.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|hamachi|radmin|zerotier|tailscale|vpn|tap|tun/i;

function renderInvite() {
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

/** onAir: null (não transmite), 'live' ou 'paused': o tally aceso ao lado do nome. */
function participantItem(name, sub, pill, onAir = null) {
  const tally = onAir
    ? el('span', { class: `tally${onAir === 'paused' ? ' paused' : ''}`, title: onAir === 'paused' ? 'Pausado' : 'No ar' })
    : null;
  return el('li', { class: 'participant' },
    avatar(name),
    el('div', { class: 'participant-main' },
      el('div', { class: 'participant-name', title: name }, tally, el('span', {}, name)),
      el('div', { class: 'participant-sub', title: sub }, sub)),
    pill);
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
  if (!level) return el('span', { class: 'pill ok', title }, 'conectado');
  return el('span', { class: `pill signal-pill ${SIGNAL_KIND[level]}`, title },
    signalBars(level), `sinal ${SIGNAL_TEXT[level]}`);
}

function renderParticipants() {
  const mesh = state.mesh;
  if (!mesh) return;
  let mine = state.hosting ? 'Hospedando a sala' : 'Na sala';
  if (state.share) mine = `${state.share.paused ? 'Pausado' : 'Transmitindo'}: ${state.share.source.name}${state.share.audio ? ' · com som' : ''}`;
  const myPill = state.share
    ? el('span', { class: state.share.paused ? 'pill warn' : 'pill live' }, state.share.paused ? 'Pausado' : 'No ar')
    : null;
  const myAir = state.share ? (state.share.paused ? 'paused' : 'live') : null;
  const items = [participantItem(`${mesh.name} (você)`, mine, myPill, myAir)];
  // Quem está numa versão antiga (as melhorias de CPU só valem com todos atualizados).
  const outdated = outdatedPeers(state.info.version,
    [...mesh.peers.values()].map((p) => ({ id: p.id, version: p.state.version })),
    mesh.serverFeatures.includes('version'));
  for (const peer of mesh.peers.values()) {
    let sub = 'Na sala';
    if (peer.state.sharing) {
      sub = `${peer.state.paused ? 'Pausado' : 'Transmitindo'}: ${peer.state.label || 'tela'}${peer.state.audio ? ' · com som' : ''}`;
      if (state.tiles.get(peer.id)?.watching === false) sub += ' · você parou de assistir';
    }
    if (outdated.has(peer.id)) sub += ' · versão antiga do Telão';
    const air = peer.state.sharing ? (peer.state.paused ? 'paused' : 'live') : null;
    items.push(participantItem(peer.name, sub, connectionPill(peer), air));
  }
  $('#participants').replaceChildren(...items);
  $('#participant-count').textContent = String(items.length);
}

// ---------- Telas recebidas ----------

function rememberVolume(tile) {
  const volumes = { ...(prefs.volumes || {}) };
  delete volumes[tile.peerName];
  volumes[tile.peerName] = { volume: tile.video.volume, muted: tile.userMuted };
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

function createTile(peer) {
  const video = el('video', { playsinline: true, autoplay: true });
  const name = el('span', { class: 'tile-name' });
  const label = el('span', { class: 'tile-label' });
  const signal = el('span', { class: 'tile-signal' });
  const stats = el('div', { class: 'tile-stats', hidden: true }, 'Aguardando dados…');
  const pausedText = el('span');
  const paused = el('div', { class: 'tile-paused', html: icon('pause') }, pausedText);
  const unwatchedText = el('span');
  const resumeBtn = el('button', { type: 'button', class: 'btn small primary' }, 'Assistir de novo');
  const unwatched = el('div', { class: 'tile-unwatched', html: icon('eye-off') }, unwatchedText, resumeBtn);
  // Sem aria-live aqui: o leitor de tela anunciaria cada emoji (inclusive os seus).
  const reactions = el('div', { class: 'reactions-layer' });
  const muteBtn = el('button', { class: 'icon-btn', title: 'Silenciar', 'aria-label': 'Silenciar' });
  const volume = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', title: 'Volume', 'aria-label': `Volume de ${peer.name}` });
  const pinBtn = el('button', { class: 'icon-btn', title: 'Destacar esta tela', 'aria-label': 'Destacar esta tela', 'aria-pressed': 'false', html: icon('pin') });
  const pipBtn = el('button', {
    class: 'icon-btn pip-btn', title: 'Janelinha flutuante: fica por cima dos outros programas',
    'aria-label': 'Abrir em janelinha flutuante', 'aria-pressed': 'false', html: icon('pip'),
  });
  const infoBtn = el('button', { class: 'icon-btn info-btn', title: 'Estatísticas da transmissão', 'aria-label': 'Estatísticas da transmissão', html: icon('info') });
  const fullBtn = el('button', { class: 'icon-btn full-btn', title: 'Tela cheia (ou duplo clique)', 'aria-label': 'Tela cheia', html: icon('maximize') });
  const watchBtn = el('button', {
    class: 'icon-btn watch-btn', title: 'Parar de assistir (economiza processador e internet dos dois lados)',
    'aria-label': `Parar de assistir ${peer.name}`, html: icon('eye-off'),
  });
  const reactionBar = el('div', { class: 'reaction-bar', role: 'group', 'aria-label': `Reagir à tela de ${peer.name}` },
    ...REACTIONS.map((emoji) => el('button', {
      type: 'button', title: `Reagir com ${emoji}`, 'aria-label': `Reagir com ${emoji}`,
      onclick: () => sendReaction(peer.id, emoji),
    }, emoji)));
  // Um monitor do multivisor: a imagem (com os controles por cima) e, embaixo, a faixa
  // de rótulo com o tally (aceso = no ar, tracejado = conectando, âmbar = pausado).
  const root = el('div', { class: 'tile waiting', tabindex: '0', dataset: { peer: peer.id } },
    el('div', { class: 'tile-screen' },
      video,
      el('div', { class: 'tile-wait' }, el('div', { class: 'spinner' }), el('span', {}, 'Conectando à transmissão…')),
      paused,
      unwatched,
      reactions,
      stats,
      reactionBar,
      el('div', { class: 'tile-bar' }, muteBtn, volume, el('span', { class: 'spacer' }), pinBtn, watchBtn, pipBtn, infoBtn, fullBtn)),
    el('div', { class: 'umd' }, el('span', { class: 'tally', 'aria-hidden': 'true' }), name, label, signal));

  const tile = {
    root, video, name, label, signal, stats, pausedText, unwatchedText, resumeBtn, watchBtn, reactions,
    muteBtn, volume, pinBtn, pipBtn,
    userMuted: false, peerName: peer.name,
    watching: true, // false = parou de assistir: nada chega dessa pessoa
  };
  watchBtn.addEventListener('click', () => setWatching(peer.id, false));
  resumeBtn.addEventListener('click', () => setWatching(peer.id, true));
  // O tamanho em que a tela aparece decide a resolução pedida a quem transmite.
  state.resizeObserver?.observe(video);
  // O volume de cada pessoa fica lembrado entre as sessões.
  const saved = prefs.volumes?.[peer.name];
  if (saved && Number.isFinite(saved.volume)) {
    volume.value = String(saved.volume);
    video.volume = Math.min(1, Math.max(0, saved.volume));
    tile.userMuted = saved.muted === true;
  }
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    if (video.volume > 0) tile.userMuted = false;
    rememberVolume(tile);
    applyAudioRouting();
  });
  muteBtn.addEventListener('click', () => {
    tile.userMuted = !tile.userMuted;
    rememberVolume(tile);
    applyAudioRouting();
  });
  pinBtn.addEventListener('click', () => {
    state.pinned = state.pinned === peer.id ? null : peer.id;
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
  infoBtn.addEventListener('click', () => {
    stats.hidden = !stats.hidden;
    infoBtn.classList.toggle('active', !stats.hidden);
    renderTileStats(state.mesh?.peers.get(peer.id));
  });
  const toggleFullscreen = () => {
    if (document.fullscreenElement === root) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  };
  fullBtn.addEventListener('click', toggleFullscreen);
  // Clicar numa tela a destaca (o 📌 desfaz); dois cliques abrem a tela cheia.
  video.addEventListener('click', () => {
    if (state.tiles.size < 2 || state.pinned === peer.id) return;
    state.pinned = peer.id;
    layoutTiles();
  });
  video.addEventListener('dblclick', toggleFullscreen);
  for (const type of ['playing', 'resize', 'loadeddata']) {
    video.addEventListener(type, () => {
      const current = state.mesh?.peers.get(peer.id);
      if (current) updateTileWaiting(current);
    });
  }
  return tile;
}

function syncTile(peer, tracksChanged = false) {
  if (!state.mesh) return;
  let tile = state.tiles.get(peer.id);
  if (!peer.state.sharing) {
    if (tile) removeTile(peer.id);
    return;
  }
  if (!tile) {
    tile = createTile(peer);
    state.tiles.set(peer.id, tile);
    $('#tiles').append(tile.root);
    tracksChanged = true;
  }
  tile.name.textContent = peer.name;
  tile.label.textContent = peer.state.label ? `${peer.state.label}${peer.state.audio ? ' · com som' : ''}` : '';
  tile.root.classList.toggle('paused', peer.state.paused === true);
  tile.pausedText.textContent = `${peer.name} pausou a transmissão`;
  tile.unwatchedText.textContent = `Você parou de assistir ${peer.name}`;
  if (tracksChanged) {
    tile.video.srcObject = null;
    tile.video.srcObject = peer.remoteStream;
    tile.video.play().catch(() => {});
  }
  updateTileWaiting(peer);
  applyAudioRouting();
  layoutTiles();
}

function removeTile(peerId) {
  const tile = state.tiles.get(peerId);
  if (!tile) return;
  if (document.fullscreenElement === tile.root) document.exitFullscreen().catch(() => {});
  if (document.pictureInPictureElement === tile.video) document.exitPictureInPicture().catch(() => {});
  state.resizeObserver?.unobserve(tile.video);
  tile.video.srcObject = null;
  tile.root.remove();
  state.tiles.delete(peerId);
  if (state.pinned === peerId) state.pinned = null;
  layoutTiles();
}

function updateTileWaiting(peer) {
  const tile = state.tiles.get(peer.id);
  if (!tile) return;
  const track = peer.remoteStream.getVideoTracks()[0];
  const waiting = !track || track.muted || track.readyState === 'ended' || tile.video.videoWidth === 0;
  tile.root.classList.toggle('waiting', waiting && peer.state.paused !== true && tile.watching);
}

// ---------- O que receber de cada pessoa ----------
// Quem assiste diz a quem transmite o que quer receber (ver Mesh.setView): parou de
// assistir = nada; Telão escondido = só o som; e a imagem na altura em que a tela
// aparece aqui. Quem transmite comprime menos (ou nada) e quem assiste descomprime menos.

const FULL_VIEW = { video: true, audio: true, height: 0 };
const HIDDEN_PAUSE_MS = 5000; // escondido por mais que isso: para de receber a imagem

/** Altura (em pixels da tela) em que o vídeo de uma tela aparece de verdade. */
function shownHeight(tile) {
  if (document.fullscreenElement === tile.root) return Infinity;
  const box = tile.video.getBoundingClientRect();
  if (!box.width || !box.height) return Infinity;
  const { videoWidth, videoHeight } = tile.video;
  const aspect = videoWidth && videoHeight ? videoWidth / videoHeight : 16 / 9;
  return Math.min(box.height, box.width / aspect) * (window.devicePixelRatio || 1);
}

function desiredView(peer) {
  const tile = state.tiles.get(peer.id);
  if (!tile) return FULL_VIEW;
  if (!tile.watching) return { video: false, audio: false, height: 0 };
  const floating = document.pictureInPictureElement === tile.video;
  if (state.hiddenLong && !floating) return { video: false, audio: true, height: 0 };
  return { video: true, audio: true, height: floating ? 0 : wantedHeight(shownHeight(tile)) };
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

/** Parar de assistir (ou voltar a assistir) a transmissão de alguém. */
function setWatching(peerId, watching) {
  const tile = state.tiles.get(peerId);
  if (!tile || tile.watching === watching) return;
  tile.watching = watching;
  tile.root.classList.toggle('unwatched', !watching);
  if (!watching) {
    if (document.pictureInPictureElement === tile.video) document.exitPictureInPicture().catch(() => {});
    if (document.fullscreenElement === tile.root) document.exitFullscreen().catch(() => {});
    tile.resumeBtn.focus();
  } else {
    tile.root.focus();
  }
  const peer = state.mesh?.peers.get(peerId);
  if (peer) updateTileWaiting(peer);
  applyAudioRouting();
  syncViews();
  renderParticipants();
}

function layoutTiles() {
  const count = state.tiles.size;
  $('#empty-stage').hidden = count > 0;
  const tiles = $('#tiles');
  // Multivisor: as colunas que deixam cada imagem maior no palco (descontando o respiro de 8 px).
  const stage = $('#stage');
  tiles.style.setProperty('--cols', String(bestColumns(count, stage.clientWidth - 16, stage.clientHeight - 16)));
  // Destaque: a tela escolhida fica grande e as outras numa coluna ao lado.
  const pinned = count > 1 && state.tiles.has(state.pinned) ? state.pinned : null;
  tiles.classList.toggle('has-spotlight', Boolean(pinned));
  tiles.style.setProperty('--others', String(Math.max(1, count - 1)));
  for (const [id, tile] of state.tiles) {
    tile.root.classList.toggle('pinned', id === pinned);
    tile.pinBtn.setAttribute('aria-pressed', String(id === state.pinned));
    tile.pinBtn.hidden = count < 2;
    tile.pinBtn.title = id === state.pinned ? 'Tirar o destaque' : 'Destacar esta tela';
  }
  updateKeepAwake();
  scheduleViewSync(); // o tamanho de cada tela mudou
}

// ---------- Atualização ----------
// O processo principal baixa a versão nova sozinho (ver setupUpdates no main.js);
// aqui só aparece o aviso: na tela inicial uma faixa, na sala uma tecla no alto.

function renderUpdate(status) {
  if (status) state.update = status;
  const s = state.update;
  const ready = s?.status === 'ready';
  const portable = s?.status === 'available';
  $('#update-banner').hidden = !ready && !portable;
  $('#update-btn').hidden = !ready && !portable;
  if (!ready && !portable) return;
  $('#update-title').textContent = ready ? `Versão ${s.version} pronta` : `Versão ${s.version} disponível`;
  $('#update-detail').textContent = ready
    ? 'Ela entra quando você fechar o Telão, ou agora mesmo:'
    : 'O Telão portátil não se atualiza sozinho: baixe o arquivo novo.';
  $('#update-apply').textContent = ready ? 'Reiniciar e atualizar' : 'Baixar';
  const btn = $('#update-btn');
  btn.title = ready ? `Reiniciar e atualizar para a ${s.version}` : `Baixar a versão ${s.version}`;
  btn.querySelector('.label').textContent = ready ? 'Atualizar' : 'Versão nova';
  if (ready && state.inRoom && !state.updateAnnounced) {
    state.updateAnnounced = true;
    toast(`A versão ${s.version} do Telão foi baixada. Ela entra quando você fechar o app (ou clique em Atualizar).`, 'info', 9000);
  }
}

async function applyUpdate() {
  if (state.update?.status === 'ready' && state.inRoom) {
    const ok = window.confirm(state.hosting
      ? 'Atualizar agora reinicia o Telão, e a sala que você hospeda fecha para todos. Atualizar mesmo assim?'
      : 'Atualizar agora reinicia o Telão, e você sai da sala. Atualizar mesmo assim?');
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
    // Parou de assistir: silencia aqui também (quem transmite numa versão antiga
    // não entende o pedido e continuaria mandando o som).
    const muted = tile.userMuted || echoGuard || !tile.watching;
    tile.video.muted = muted;
    tile.muteBtn.innerHTML = icon(muted || tile.video.volume === 0 ? 'volume-x' : 'volume');
    tile.muteBtn.classList.toggle('active', muted);
    tile.muteBtn.title = echoGuard
      ? 'Silenciado para evitar eco enquanto você transmite com som (dá para mudar no painel)'
      : (tile.userMuted ? 'Ativar som' : 'Silenciar');
    tile.muteBtn.setAttribute('aria-label', tile.muteBtn.title);
  }
}

function updateKeepAwake() {
  api.keepAwake(Boolean(state.share) || state.tiles.size > 0);
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
      peer.stats = await tracker.collect(peer.pc, { remoteVideoTrackId: peer.remoteStream.getVideoTracks()[0]?.id });
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
  const tile = peer && state.tiles.get(peer.id);
  if (!tile) return;
  const s = peer.stats;
  const level = s?.recvVideo?.lossRate != null ? peerSignal(s) : null;
  tile.signal.replaceChildren(...(level ? [signalBars(level), el('span', { class: 'signal-text' }, `sinal ${SIGNAL_TEXT[level]}`)] : []));
  tile.signal.title = level ? `Sinal ${SIGNAL_TEXT[level]}` : '';
  if (tile.stats.hidden) return;
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
  const btn = $('#share-btn');
  btn.classList.toggle('live', sharing);
  btn.classList.toggle('primary', !sharing);
  btn.innerHTML = `${icon(sharing ? 'stop' : 'monitor')}<span class="label">${sharing ? 'Parar transmissão' : 'Compartilhar tela'}</span>`;
  $('#share-live').hidden = !sharing;
  $('#share-live').classList.toggle('paused', paused);
  // Lâmpada NO AR com o tempo no ar: apagada fora do ar, acende ao transmitir, âmbar pausada.
  const onAir = $('#on-air');
  onAir.classList.toggle('off', !sharing);
  onAir.classList.toggle('paused', paused);
  onAir.title = sharing ? 'Tempo no ar' : 'Você não está transmitindo';
  $('#on-air-lamp').textContent = paused ? 'Pausado' : 'No ar';
  if (sharing) updateClock();
  else $('#on-air-time').textContent = '--:--:--';
  $('#anti-echo-row').hidden = state.info.appAudio && state.share?.audioMode !== 'system';
  $('#pause-btn').innerHTML = `${icon(paused ? 'play' : 'pause')}${paused ? 'Retomar' : 'Pausar'}`;
  $('#pause-btn').title = `${paused ? 'Retomar' : 'Pausar'} a transmissão (Ctrl+Alt+P)`;
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
    text = 'Som de todo o computador, sem filtro (inclui chamadas de voz).';
  }
  $('#share-audio-text').textContent = text;
}

function updateMeter() {
  const meter = state.share?.meter;
  const level = meter && !state.share.paused ? meter.level() : 0;
  $('#share-meter').style.setProperty('--level', level.toFixed(3));
}

async function captureSource(sourceId, settings, withAudio) {
  await api.selectSource(sourceId, withAudio);
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints(settings),
      audio: withAudio ? AUDIO_CONSTRAINTS : false,
    });
  } catch (err) {
    if (!withAudio) throw err;
    console.warn('Captura com som falhou; tentando sem som.', err);
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
    if (stillWanted()) toast(`Não foi possível capturar: ${cleanError(err)}`, 'error', 8000);
    return false;
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

// ---------- Escolha da tela ----------

async function openPicker() {
  state.picker.selected = state.share?.source.id ?? state.picker.selected;
  state.pickStale = true; // o que está tocando som agora pode ter mudado
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

function renderSources() {
  const { sources, tab, selected } = state.picker;
  for (const t of $$('.tab')) t.classList.toggle('active', t.dataset.tab === tab);
  const list = sources.filter((s) => s.type === tab);
  const grid = $('#source-grid');
  if (!list.length) {
    grid.replaceChildren(el('p', { class: 'hint' }, tab === 'screen' ? 'Nenhuma tela encontrada.' : 'Nenhuma janela aberta encontrada.'));
  } else {
    grid.replaceChildren(...list.map((s) => {
      const card = el('button', { class: `source-card${s.id === selected ? ' selected' : ''}`, type: 'button', title: s.name, dataset: { id: s.id } },
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
  if (!state.info.systemAudio) hint.textContent = 'O som do computador só pode ser transmitido no Windows.';
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
    list.replaceChildren(el('p', { class: 'hint' }, 'Nenhum app tocando som agora. Dê play no que você quer transmitir e clique em Atualizar.'));
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
  $('#exclude-list').addEventListener('change', () => {
    prefs.audioExclude = parseExcludeList($('#exclude-list').value);
    $('#exclude-list').value = prefs.audioExclude.join('\n');
    savePrefs();
    syncAudioControls();
    if (!$('#pick-apps').hidden) renderPickList(); // a marca "(excluído)" muda
  });
  $('#exclude-reset').addEventListener('click', () => {
    prefs.audioExclude = null;
    $('#exclude-list').value = excludedApps().join('\n');
    savePrefs();
    syncAudioControls();
    if (!$('#pick-apps').hidden) renderPickList();
  });
  syncAudioControls();
}

function setupPicker() {
  const dialog = $('#picker');
  $('#picker-close').addEventListener('click', () => dialog.close());
  $('#picker-cancel').addEventListener('click', () => dialog.close());
  $('#picker-refresh').addEventListener('click', loadSources);
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      state.picker.tab = tab.dataset.tab;
      if (state.picker.tab === 'window' && !state.picker.windowThumbs) {
        for (const t of $$('.tab')) t.classList.toggle('active', t === tab);
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
  applyConsole();
  restoreJoinForm();
  setupQualityControls();
  setupPicker();
  renderSoundsButton();

  for (const radio of $$('input[name="mode"], input[name="host-where"]')) radio.addEventListener('change', syncModeFields);
  $('#server-url').addEventListener('input', () => {
    fillRoomFromAddress();
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
  $('#leave-btn').addEventListener('click', () => leaveRoom());
  $('#sounds-btn').addEventListener('click', () => {
    prefs.sounds = prefs.sounds === false;
    savePrefs();
    renderSoundsButton();
    if (prefs.sounds) playSound('stream');
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
