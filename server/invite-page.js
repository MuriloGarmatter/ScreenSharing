'use strict';

// Página do convite. Quem abre o link do convite no navegador
// (ex.: https://telao.xmbc.workers.dev/sala-abc) vê esta página: o botão
// "Abrir no Telão" usa o link telao:// para abrir o app já entrando na sala,
// e há instruções para quando o app não abre.
// httpResponse não depende do Node: o servidor da Cloudflare (worker/) usa a mesma.

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const MAX_ROOM = 64;
const DOWNLOAD_URL = 'https://github.com/MuriloGarmatter/ScreenSharing/releases/latest';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Monta o convite a partir do endereço pedido; null se não for um convite válido. */
function inviteFor({ host, scheme, url }) {
  if (!HOST_RE.test(host)) return null;
  let room;
  try {
    room = decodeURIComponent(new URL(url, 'http://local').pathname.replace(/^\/+|\/+$/g, '')).trim();
  } catch {
    return null;
  }
  if (!room || room.length > MAX_ROOM || room.includes('/')) return null;
  const invite = `${scheme === 'https' ? 'https' : 'http'}://${host}/${encodeURIComponent(room)}`;
  return { room, invite, deepLink: `telao://entrar/?convite=${encodeURIComponent(invite)}` };
}

// As mesmas cores do app ("mesa de corte": grafite, luz vermelha de "no ar").
const STYLE = `
:root{color-scheme:dark;--bg:#0e0f11;--panel:#16171a;--raised:#222428;--text:#eceef1;--muted:#9da1a9;--border:#26282d;--border-strong:#3a3d44;--accent:#d92b26;--accent-hover:#bb2521}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#eceef1;--panel:#f7f7f8;--raised:#fff;--text:#121316;--muted:#555a63;--border:#d9dce1;--border-strong:#b8bdc6}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
main{width:100%;max-width:480px;padding:28px;border-radius:6px;background:var(--panel);border:1px solid var(--border)}
.brand{display:flex;align-items:center;gap:8px;margin:0 0 20px;font:700 15px/1 Bahnschrift,"Segoe UI",sans-serif;letter-spacing:.06em;text-transform:uppercase}
.tally{width:10px;height:10px;border-radius:2px;background:var(--accent)}
h1{margin:0 0 6px;font:600 22px/1.25 Bahnschrift,"Segoe UI Variable Display","Segoe UI",sans-serif}
h2{margin:24px 0 6px;font:600 15px/1.3 Bahnschrift,"Segoe UI",sans-serif}
p{margin:8px 0}.muted{color:var(--muted);font-size:13.5px}.room{font-weight:700;word-break:break-all}
a{color:inherit}
.btn{display:block;margin:20px 0 6px;padding:12px;border-radius:4px;background:var(--accent);color:#fff;text-align:center;font-weight:600;text-decoration:none}
.btn:hover{background:var(--accent-hover)}
.btn:focus-visible,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-disabled="true"]{opacity:.7;cursor:progress}
ol{margin:6px 0;padding-left:20px}li{margin:4px 0}
code{display:block;margin-top:8px;padding:10px;border-radius:4px;border:1px solid var(--border);background:var(--bg);font:13px "Cascadia Mono",Consolas,ui-monospace,monospace;word-break:break-all;user-select:all}
button{margin-top:8px;padding:7px 14px;border-radius:4px;border:1px solid var(--border-strong);background:var(--raised);color:var(--text);font:inherit;font-weight:600;cursor:pointer}
`;

function invitePage({ room, invite, deepLink }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Convite para o Telão</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <p class="brand"><span class="tally" aria-hidden="true"></span>Telão</p>
  <h1>Convite para a sala</h1>
  <p>Você foi convidado para a sala <span class="room">${escapeHtml(room)}</span>.</p>
  <a class="btn" id="open" href="${escapeHtml(deepLink)}">Abrir no Telão</a>
  <p class="muted">Se o navegador perguntar, permita abrir o Telão.</p>
  <h2>Não abriu?</h2>
  <ol>
    <li>Ainda não tem o Telão? Baixe o instalador (Windows) em
      <a href="${DOWNLOAD_URL}" rel="noopener noreferrer">github.com/MuriloGarmatter/ScreenSharing</a>,
      instale e clique no convite de novo.</li>
    <li>Ou abra o Telão, escolha <b>Entrar com convite</b> e cole este endereço:</li>
  </ol>
  <code id="invite">${escapeHtml(invite)}</code>
  <button type="button" id="copy">Copiar endereço</button>
</main>
<script>
(function () {
  var code = document.getElementById('invite');
  var copy = document.getElementById('copy');
  copy.addEventListener('click', function () {
    var done = function () { copy.textContent = 'Copiado!'; };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code.textContent).then(done);
    } else {
      var range = document.createRange();
      range.selectNodeContents(code);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if (document.execCommand('copy')) done();
    }
  });
  // Tenta abrir o app sozinho. Depois de cada tentativa o botão fica travado uns
  // segundos ("Abrindo o Telão…"), para um segundo clique não abrir outra cópia.
  var open = document.getElementById('open');
  var label = open.textContent;
  var busy = false;
  var launch = function () {
    busy = true;
    open.textContent = 'Abrindo o Telão…';
    open.setAttribute('aria-disabled', 'true');
    setTimeout(function () {
      busy = false;
      open.textContent = label;
      open.removeAttribute('aria-disabled');
    }, 6000);
  };
  open.addEventListener('click', function (event) {
    if (busy) event.preventDefault();
    else launch();
  });
  setTimeout(function () { launch(); location.href = open.getAttribute('href'); }, 400);
})();
</script>
</body>
</html>`;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Resposta HTTP do servidor da sala (o WebSocket é tratado à parte).
 * url pode ser só o caminho ("/sala") ou o endereço completo; scheme é como o
 * convite chegou ("https" atrás do túnel ou da Cloudflare). Devolve { status, headers, body }.
 */
function httpResponse({ method, url, host, scheme }) {
  let pathname = '/';
  try {
    pathname = new URL(url, 'http://local').pathname;
  } catch { /* fica na raiz */ }
  const reply = (status, type, body) => ({
    status,
    headers: { 'Content-Type': type, ...SECURITY_HEADERS },
    body: method === 'HEAD' ? undefined : body,
  });
  const text = 'text/plain; charset=utf-8';
  if (method !== 'GET' && method !== 'HEAD') return reply(405, text, 'Método não permitido.\n');
  if (pathname === '/' || pathname === '/health') return reply(200, text, 'Telão: servidor de sinalização ativo.\n');
  if (pathname === '/robots.txt') return reply(200, text, 'User-agent: *\nDisallow: /\n');
  if (pathname === '/favicon.ico') return reply(404, text, '');
  const invite = inviteFor({ host: String(host || ''), scheme, url });
  if (!invite) return reply(404, text, 'Convite inválido.\n');
  return reply(200, 'text/html; charset=utf-8', invitePage(invite));
}

/** Atende as requisições HTTP no servidor do PC (http.Server do Node). */
function handleHttpRequest(req, res) {
  // Atrás do túnel da Cloudflare a conexão original é https.
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const { status, headers, body } = httpResponse({
    method: req.method,
    url: req.url,
    host: req.headers.host,
    scheme: forwarded === 'https' ? 'https' : 'http',
  });
  res.writeHead(status, headers);
  res.end(body);
}

module.exports = { handleHttpRequest, httpResponse, inviteFor, invitePage, escapeHtml };
