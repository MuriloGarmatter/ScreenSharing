import { DEFAULT_PORT, inviteAddress, parseServerAddress } from './address.js';
import { AppAudioCapture, LevelMeter, routeAppAudioData, routeAppAudioEvent } from './app-audio.js';
import { Mesh } from './mesh.js';
import {
  AUDIO_CONSTRAINTS, BITRATES, CODECS, DEFAULT_SHARE_SETTINGS, FRAME_RATES, OPTIMIZE, RESOLUTIONS,
  targetBitrate, videoConstraints,
} from './media.js';
import { LIMITATION_TEXT, StatsTracker, describeRoute, hardwareLabel } from './stats.js';
import { $, $$, el, formatBitrate, formatFps, hueFor, hydrateIcons, icon, toast } from './ui.js';

const api = window.telao;
const Theme = window.TelaoTheme; // theme.js, carregado antes no <head>
const PREFS_KEY = Theme.PREFS_KEY; // a mesma chave que o theme.js lê na abertura

const state = {
  info: { systemAudio: false, appAudio: false, defaultExcludedApps: [] },
  mesh: null,
  inRoom: false,
  serverUrl: '',
  hosting: null, // { port, addresses, publicUrl, tunnel: 'off'|'starting'|'on'|'missing'|'error', tunnelError, download }
  share: null, // { stream, source, audio, audioMode: 'all'|'app'|'system'|'none', appAudio, meter, preview }
  meterTimer: null,
  tiles: new Map(), // peerId -> tile
  trackers: new Map(), // peerId -> StatsTracker
  statsTimer: null,
  picker: { sources: [], tab: 'screen', selected: null },
};

const prefs = loadPrefs();

// ---------- Preferências ----------

function loadPrefs() {
  const defaults = {
    name: '', room: '', mode: 'join',
    serverUrl: '',
    hostPort: DEFAULT_PORT, tunnel: true,
    turnUrls: '', turnUsername: '', turnCredential: '',
    share: { ...DEFAULT_SHARE_SETTINGS }, audio: true, antiEcho: true,
    // Som: 'all' = todos os apps menos os excluídos, 'app' = só o app da janela,
    // 'system' = tudo, sem filtro. Lembrado separadamente para tela e janela.
    audioModeScreen: 'all', audioModeWindow: 'app',
    audioExclude: null, // null = lista padrão
    appearance: null, // { theme, accent }; null = padrão (ver theme.js)
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
  syncModeFields();
}

function currentMode() {
  return $('#mode-host').checked ? 'host' : 'join';
}

function syncModeFields() {
  const host = currentMode() === 'host';
  $('#host-fields').hidden = !host;
  $('#join-fields').hidden = host;
  $('#join-btn').textContent = host ? 'Criar sala e entrar' : 'Entrar na sala';
  $('#room').placeholder = host ? 'ex.: filme-sexta' : 'vem junto no endereço do convite';
  if (host && !$('#room').value.trim()) $('#room').value = randomRoom();
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
  const btn = $('#join-btn');
  btn.disabled = busy;
  btn.classList.toggle('busy', busy);
  if (busy) btn.textContent = 'Conectando…';
  else syncModeFields();
}

async function onJoin(event) {
  event.preventDefault();
  $('#join-error').hidden = true;
  const mode = currentMode();
  const address = mode === 'join' ? parseServerAddress($('#server-url').value) : null;
  if (address?.room) $('#room').value = address.room; // o convite manda na sala
  const name = $('#name').value.trim();
  const room = $('#room').value.trim();
  if (!name) return showJoinError('Digite seu nome.', '#name');
  if (mode === 'join' && !address) {
    return showJoinError('Cole o endereço que quem hospeda mandou (ex.: wss://xxxx.trycloudflare.com/sala-abc).', '#server-url');
  }
  if (!room) {
    return showJoinError(mode === 'join'
      ? 'Digite o nome da sala (ou cole o endereço completo do convite, que já traz a sala).'
      : 'Digite o nome da sala.', '#room');
  }

  Object.assign(prefs, {
    name, room, mode,
    serverUrl: $('#server-url').value.trim(),
    hostPort: Number($('#host-port').value) || DEFAULT_PORT,
    tunnel: $('#host-tunnel').checked,
    turnUrls: $('#turn-urls').value.trim(),
    turnUsername: $('#turn-username').value.trim(),
    turnCredential: $('#turn-credential').value,
  });
  savePrefs();

  setJoinBusy(true);
  try {
    let url;
    let password;
    if (mode === 'host') {
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
    const mesh = new Mesh({ url, room, name, password });
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
    showJoinError(cleanError(err));
  } finally {
    setJoinBusy(false);
  }
}

// ---------- Sala ----------

function wireMesh(mesh) {
  const on = (type, handler) => mesh.addEventListener(type, (event) => {
    if (state.mesh === mesh) handler(event.detail);
  });
  on('peer-joined', ({ peer, silent }) => {
    syncTile(peer);
    renderParticipants();
    updateBitrateHint();
    if (state.inRoom && !silent) toast(`${peer.name} entrou na sala.`);
  });
  on('peer-left', ({ peer, silent }) => {
    removeTile(peer.id);
    state.trackers.delete(peer.id);
    renderParticipants();
    renderOutgoing();
    updateBitrateHint();
    if (state.inRoom && !silent) toast(`${peer.name} saiu da sala.`);
  });
  on('peer-state', ({ peer }) => {
    syncTile(peer);
    renderParticipants();
  });
  on('remote-track', ({ peer }) => syncTile(peer, true));
  on('remote-media', ({ peer }) => updateTileWaiting(peer));
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
  state.statsTimer = setInterval(updateStats, 1000);
}

async function leaveRoom(force = false) {
  if (!state.mesh) return;
  if (!force && state.hosting && state.mesh.peers.size > 0) {
    const ok = window.confirm('Você está hospedando esta sala. Se sair, os outros participantes perdem a conexão com o servidor. Sair mesmo assim?');
    if (!ok) return;
  }
  stopShare();
  const mesh = state.mesh;
  state.mesh = null;
  state.inRoom = false;
  mesh.leave();
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  for (const id of [...state.tiles.keys()]) removeTile(id);
  state.trackers.clear();
  if (state.hosting) {
    state.hosting = null;
    await api.stopServer().catch(() => {});
  }
  $('#room-view').hidden = true;
  $('#join-view').hidden = false;
  document.title = 'Telão';
  updateKeepAwake();
}

function setServerStatus(connected) {
  const pill = $('#server-status');
  pill.className = `pill ${connected ? 'ok' : 'warn'}`;
  pill.textContent = connected ? 'conectado' : 'reconectando…';
  pill.title = connected
    ? `Servidor: ${state.serverUrl}`
    : 'Sem conexão com o servidor. As transmissões em andamento continuam; tentando reconectar.';
}

// ---------- Convite (quando hospeda) ----------

function inviteRow(text, adapter) {
  const copy = el('button', { class: 'icon-btn small', title: 'Copiar convite', 'aria-label': 'Copiar convite', html: icon('copy') });
  copy.addEventListener('click', async () => {
    await api.copyText(text);
    toast('Convite copiado! Ele já inclui o nome da sala.');
  });
  return el('div', { class: 'invite-item' },
    adapter ? el('span', { class: 'invite-iface' }, adapter) : null,
    el('div', { class: 'invite-row' }, el('code', { title: text }, text), copy));
}

// Placas de VPN e de máquinas virtuais vão para o fim da lista.
const VIRTUAL_ADAPTER = /vethernet|virtualbox|vmware|wsl|hyper-v|loopback|bluetooth|hamachi|radmin|zerotier|tailscale|vpn|tap|tun/i;

function renderInvite() {
  const hosting = state.hosting;
  $('#invite-panel').hidden = !hosting;
  if (!hosting) return;
  const room = state.mesh?.room || '';
  $('#invite-room').textContent = room;

  const addresses = [...hosting.addresses].sort((a, b) => VIRTUAL_ADAPTER.test(a.name) - VIRTUAL_ADAPTER.test(b.name));
  $('#invite-lan').replaceChildren(
    el('span', { class: 'invite-label', html: `${icon('wifi')}Na mesma rede (Wi-Fi ou cabo)` }),
    ...(addresses.length
      ? addresses.map((a) => inviteRow(inviteAddress(`${a.address}:${hosting.port}`, room), a.name))
      : [el('p', { class: 'hint' }, 'Nenhuma rede local encontrada.')]),
  );

  const internet = [el('span', { class: 'invite-label', html: `${icon('globe')}Pela internet` })];
  if (hosting.download !== null) {
    const bar = el('div', { class: 'progress' }, el('span'));
    bar.style.setProperty('--value', hosting.download.toFixed(3));
    internet.push(el('p', { class: 'hint' }, `Baixando o cloudflared… ${Math.round(hosting.download * 100)}%`), bar);
  } else if (hosting.publicUrl) {
    internet.push(inviteRow(inviteAddress(hosting.publicUrl, room)));
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
  const node = el('span', { class: 'avatar' }, (name.trim()[0] || '?').toUpperCase());
  node.style.setProperty('--hue', hueFor(name));
  return node;
}

function participantItem(name, sub, pill) {
  return el('li', { class: 'participant' },
    avatar(name),
    el('div', { class: 'participant-main' },
      el('div', { class: 'participant-name', title: name }, name),
      el('div', { class: 'participant-sub', title: sub }, sub)),
    pill);
}

function connectionPill(peer) {
  const conn = peer.pc.connectionState;
  if (conn === 'failed') return el('span', { class: 'pill bad', title: 'Não foi possível conectar diretamente' }, 'falhou');
  if (conn !== 'connected') return el('span', { class: 'pill' }, 'conectando…');
  const route = describeRoute(peer.stats?.route);
  if (!route) return el('span', { class: 'pill ok' }, 'conectado');
  const rtt = peer.stats.route.rtt;
  const title = rtt != null ? `${route.title} · latência ${Math.round(rtt * 1000)} ms` : route.title;
  return el('span', { class: `pill ${route.kind}`, title }, route.text);
}

function renderParticipants() {
  const mesh = state.mesh;
  if (!mesh) return;
  const mine = state.share
    ? `Transmitindo: ${state.share.source.name}${state.share.audio ? ' · com som' : ''}`
    : (state.hosting ? 'Hospedando a sala' : 'Na sala');
  const items = [participantItem(`${mesh.name} (você)`, mine, state.share ? el('span', { class: 'pill live' }, 'AO VIVO') : null)];
  for (const peer of mesh.peers.values()) {
    const sub = peer.state.sharing
      ? `Transmitindo: ${peer.state.label || 'tela'}${peer.state.audio ? ' · com som' : ''}`
      : 'Na sala';
    items.push(participantItem(peer.name, sub, connectionPill(peer)));
  }
  $('#participants').replaceChildren(...items);
  $('#participant-count').textContent = String(items.length);
}

// ---------- Telas recebidas ----------

function createTile(peer) {
  const video = el('video', { playsinline: true, autoplay: true });
  const name = el('span', { class: 'tile-name' });
  const label = el('span', { class: 'tile-label' });
  const stats = el('div', { class: 'tile-stats', hidden: true }, 'Aguardando dados…');
  const muteBtn = el('button', { class: 'icon-btn', title: 'Silenciar' });
  const volume = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: '1', title: 'Volume' });
  const infoBtn = el('button', { class: 'icon-btn', title: 'Estatísticas da transmissão', html: icon('info') });
  const fullBtn = el('button', { class: 'icon-btn', title: 'Tela cheia (ou duplo clique)', html: icon('maximize') });
  const root = el('div', { class: 'tile waiting', tabindex: '0', dataset: { peer: peer.id } },
    video,
    el('div', { class: 'tile-wait' }, el('div', { class: 'spinner' }), el('span', {}, 'Conectando à transmissão…')),
    el('div', { class: 'tile-top' }, name, label),
    stats,
    el('div', { class: 'tile-bar' }, muteBtn, volume, el('span', { class: 'spacer' }), infoBtn, fullBtn));

  const tile = { root, video, name, label, stats, muteBtn, volume, userMuted: false };
  volume.addEventListener('input', () => {
    video.volume = Number(volume.value);
    if (video.volume > 0) tile.userMuted = false;
    applyAudioRouting();
  });
  muteBtn.addEventListener('click', () => {
    tile.userMuted = !tile.userMuted;
    applyAudioRouting();
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
  tile.video.srcObject = null;
  tile.root.remove();
  state.tiles.delete(peerId);
  layoutTiles();
}

function updateTileWaiting(peer) {
  const tile = state.tiles.get(peer.id);
  if (!tile) return;
  const track = peer.remoteStream.getVideoTracks()[0];
  const waiting = !track || track.muted || track.readyState === 'ended' || tile.video.videoWidth === 0;
  tile.root.classList.toggle('waiting', waiting);
}

function layoutTiles() {
  const count = state.tiles.size;
  $('#empty-stage').hidden = count > 0;
  $('#tiles').style.setProperty('--cols', String(count <= 1 ? 1 : count <= 4 ? 2 : 3));
  updateKeepAwake();
}

function applyAudioRouting() {
  // No som por aplicativo o próprio Telão já fica de fora (sem eco). Só no modo
  // "sem filtro" o som dos outros precisa ser silenciado enquanto você transmite.
  const echoGuard = Boolean(state.share?.audioMode === 'system' && prefs.antiEcho);
  for (const tile of state.tiles.values()) {
    const muted = tile.userMuted || echoGuard;
    tile.video.muted = muted;
    tile.muteBtn.innerHTML = icon(muted || tile.video.volume === 0 ? 'volume-x' : 'volume');
    tile.muteBtn.classList.toggle('active', muted);
    tile.muteBtn.title = echoGuard
      ? 'Silenciado para evitar eco enquanto você transmite com som (dá para mudar no painel)'
      : (tile.userMuted ? 'Ativar som' : 'Silenciar');
  }
}

function updateKeepAwake() {
  api.keepAwake(Boolean(state.share) || state.tiles.size > 0);
}

// ---------- Estatísticas ----------

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
  for (const peer of mesh.peers.values()) {
    renderTileStats(peer);
    updateTileWaiting(peer);
  }
  renderParticipants();
  renderOutgoing();
}

function renderTileStats(peer) {
  const tile = peer && state.tiles.get(peer.id);
  if (!tile || tile.stats.hidden) return;
  const s = peer.stats;
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
  if (!state.share || !state.mesh) {
    box.replaceChildren();
    return;
  }
  const rows = [];
  for (const peer of state.mesh.peers.values()) {
    const v = peer.stats?.sendVideo;
    if (!v?.bitrate || !v.width) {
      rows.push(el('div', { class: 'out-row' }, el('strong', {}, peer.name), el('span', {}, 'iniciando envio…')));
      continue;
    }
    const hw = hardwareLabel(v);
    const parts = [`${v.width}×${v.height}`, formatFps(v.fps), formatBitrate(v.bitrate), `${v.codec || '?'}${hw ? ` (${hw})` : ''}`];
    const limit = v.limitation && v.limitation !== 'none' ? LIMITATION_TEXT[v.limitation] : null;
    rows.push(el('div', { class: 'out-row' },
      el('strong', {}, peer.name),
      el('span', {}, parts.join(' · ')),
      limit ? el('span', { class: 'limit' }, limit) : null));
  }
  box.replaceChildren(
    rows.length
      ? el('span', { class: 'invite-label' }, 'Enviando para cada pessoa')
      : el('p', { class: 'hint' }, 'Ninguém na sala para receber sua transmissão ainda.'),
    ...rows,
  );
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
  $('#anti-echo').checked = prefs.antiEcho;
  $('#anti-echo').addEventListener('change', () => {
    prefs.antiEcho = $('#anti-echo').checked;
    savePrefs();
    applyAudioRouting();
  });
  updateBitrateHint();
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

function onQualityChange() {
  prefs.share = readShareSettings();
  savePrefs();
  if (state.share && state.mesh) state.mesh.updateShareSettings(prefs.share).then(updateBitrateHint);
  updateBitrateHint();
}

function updateBitrateHint() {
  const settings = readShareSettings();
  const track = state.share?.stream.getVideoTracks()[0];
  const bps = targetBitrate(settings, track?.getSettings());
  const viewers = state.mesh ? state.mesh.peers.size : 0;
  let text = `Até ${formatBitrate(bps)} para cada pessoa assistindo`;
  if (viewers > 1) text += `: upload total de até ${formatBitrate(bps * viewers)} com ${viewers} pessoas`;
  $('#bitrate-hint').textContent = `${text}.`;
}

// ---------- Transmissão ----------

function renderShareUi() {
  const sharing = Boolean(state.share);
  const btn = $('#share-btn');
  btn.classList.toggle('live', sharing);
  btn.classList.toggle('primary', !sharing);
  btn.innerHTML = `${icon(sharing ? 'stop' : 'monitor')}<span class="label">${sharing ? 'Parar transmissão' : 'Compartilhar tela'}</span>`;
  $('#share-live').hidden = !sharing;
  $('#anti-echo-row').hidden = state.info.appAudio && state.share?.audioMode !== 'system';
  const preview = $('#local-preview');
  if (sharing) {
    $('#share-source').textContent = `${state.share.source.name} · ${state.share.audio ? 'com som' : 'sem som'}`;
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

function renderShareAudio() {
  const share = state.share;
  $('#share-audio-info').hidden = !share?.audio;
  if (!share?.audio) return;
  let text;
  if (share.appAudio) {
    const { capturing, excluded } = share.appAudio.summary([state.info.selfExe]);
    const what = share.audioMode === 'app' ? `Som só de ${share.source.name}` : 'Som dos apps';
    text = `${what}: ${capturing.length ? capturing.join(', ') : 'nenhum tocando agora'}.`;
    if (excluded.length) text += ` Fora da transmissão: ${excluded.join(', ')}.`;
  } else {
    text = 'Som de todo o computador, sem filtro (inclui chamadas de voz).';
  }
  $('#share-audio-text').textContent = text;
}

function updateMeter() {
  const meter = state.share?.meter;
  $('#share-meter').style.setProperty('--level', meter ? meter.level().toFixed(3) : '0');
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
  share.appAudio?.stop();
  share.meter?.close();
}

/** Modo de som efetivo: "só o app" só existe para janelas. */
function effectiveAudioMode(source, enabled) {
  if (!enabled) return 'none';
  if (!state.info.appAudio) return state.info.systemAudio ? 'system' : 'none';
  const mode = source.type === 'window' ? prefs.audioModeWindow : prefs.audioModeScreen;
  if (mode === 'app' && source.type !== 'window') return 'all';
  return ['all', 'app', 'system'].includes(mode) ? mode : 'all';
}

async function startShare(source, audioEnabled) {
  if (!state.mesh) return;
  const settings = readShareSettings();
  const mode = effectiveAudioMode(source, audioEnabled);
  let stream;
  try {
    stream = await captureSource(source.id, settings, mode === 'system');
  } catch (err) {
    toast(`Não foi possível capturar: ${cleanError(err)}`, 'error', 8000);
    return;
  }

  let appAudio = null;
  if (mode === 'all' || mode === 'app') {
    appAudio = new AppAudioCapture(api);
    try {
      const track = await appAudio.start({ mode, sourceId: source.id, exclude: excludedApps() });
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
    preview: new MediaStream(stream.getVideoTracks()),
  };
  if (!state.mesh) {
    releaseShare(share);
    return;
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
  state.mesh.startShare(stream, settings, { label: source.name, audio: share.audio });
  if (previous) releaseShare(previous);
  clearInterval(state.meterTimer);
  state.meterTimer = share.meter ? setInterval(updateMeter, 100) : null;
  renderShareUi();
  applyAudioRouting();
  updateKeepAwake();
}

function stopShare(reason) {
  if (!state.share) return;
  const share = state.share;
  state.share = null;
  state.mesh?.stopShare();
  releaseShare(share);
  clearInterval(state.meterTimer);
  state.meterTimer = null;
  if (reason) toast(reason, 'warn');
  if (state.inRoom) renderShareUi();
  applyAudioRouting();
  updateKeepAwake();
}

// ---------- Escolha da tela ----------

async function openPicker() {
  state.picker.selected = state.share?.source.id ?? state.picker.selected;
  $('#picker').showModal();
  await loadSources();
}

async function loadSources() {
  const grid = $('#source-grid');
  grid.replaceChildren(el('div', { class: 'grid-loading' }, el('div', { class: 'spinner' })));
  try {
    state.picker.sources = await api.listSources();
  } catch (err) {
    grid.replaceChildren(el('p', { class: 'hint' }, `Não foi possível listar as telas: ${cleanError(err)}`));
    return;
  }
  const { sources } = state.picker;
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

function syncAudioControls() {
  const enabled = $('#share-audio').checked;
  const source = selectedSource();
  const isWindow = source?.type === 'window';
  const select = $('#audio-mode');
  const modes = isWindow ? ['app', 'all', 'system'] : ['all', 'system'];
  select.replaceChildren(...modes.map((m) => el('option', { value: m }, AUDIO_MODE_LABELS[m])));
  select.value = effectiveAudioMode(source || { type: 'screen' }, true);
  select.disabled = !enabled;
  $('#exclude-toggle').textContent = `Apps excluídos (${excludedApps().length})`;

  const hint = $('#audio-hint');
  if (!state.info.systemAudio) hint.textContent = 'O som do computador só pode ser transmitido no Windows.';
  else if (!enabled) hint.textContent = 'A transmissão vai sem som.';
  else if (!state.info.appAudio) hint.textContent = 'Inclui todo o som do PC. O som dos outros participantes fica mudo enquanto você transmite, para evitar eco.';
  else if (select.value === 'app') hint.textContent = `Só o som de "${source.name}". Discord e os outros apps excluídos ficam de fora.`;
  else if (select.value === 'all') hint.textContent = 'Discord, TeamSpeak e os outros apps excluídos ficam de fora. O som do Telão também, então não há eco.';
  else hint.textContent = 'Captura tudo, inclusive chamadas de voz. O som dos outros participantes fica mudo enquanto você transmite, para evitar eco.';
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
  $('#exclude-toggle').addEventListener('click', () => {
    $('#exclude-editor').hidden = !$('#exclude-editor').hidden;
  });
  $('#exclude-list').addEventListener('change', () => {
    prefs.audioExclude = parseExcludeList($('#exclude-list').value);
    $('#exclude-list').value = prefs.audioExclude.join('\n');
    savePrefs();
    syncAudioControls();
  });
  $('#exclude-reset').addEventListener('click', () => {
    prefs.audioExclude = null;
    $('#exclude-list').value = excludedApps().join('\n');
    savePrefs();
    syncAudioControls();
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
      renderSources();
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
    dialog.close();
    await startShare(source, state.info.systemAudio && $('#share-audio').checked);
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
  restoreJoinForm();
  setupQualityControls();
  setupPicker();

  for (const radio of $$('input[name="mode"]')) radio.addEventListener('change', syncModeFields);
  $('#server-url').addEventListener('input', fillRoomFromAddress);
  $('#room-random').addEventListener('click', () => { $('#room').value = randomRoom(); });
  $('#join-form').addEventListener('submit', onJoin);
  $('#share-btn').addEventListener('click', () => (state.share ? stopShare() : openPicker()));
  $('#switch-btn').addEventListener('click', openPicker);
  $('#stop-btn').addEventListener('click', () => stopShare());
  $('#leave-btn').addEventListener('click', () => leaveRoom());

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

  (prefs.name ? $('#room') : $('#name')).focus();
}

init().catch((err) => console.error('Falha ao iniciar:', err));
