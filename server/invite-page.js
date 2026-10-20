'use strict';

// Página do convite. Quem abre o link do convite no navegador
// (ex.: https://xxxx.trycloudflare.com/sala-abc) vê esta página: o botão
// "Abrir no Telão" usa o link telao:// para abrir o app já entrando na sala,
// e há instruções para quando o app não abre.

const HOST_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const MAX_ROOM = 64;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

/** Monta o convite a partir da requisição; null se não for um convite válido. */
function inviteFromRequest(req) {
  const host = String(req.headers.host || '');
  if (!HOST_RE.test(host)) return null;
  // Atrás do túnel da Cloudflare a conexão original é https.
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const scheme = forwarded === 'https' ? 'https' : 'http';
  let room;
  try {
    room = decodeURIComponent(new URL(req.url, 'http://local').pathname.replace(/^\/+|\/+$/g, '')).trim();
  } catch {
    return null;
  }
  if (!room || room.length > MAX_ROOM || room.includes('/')) return null;
  const invite = `${scheme}://${host}/${encodeURIComponent(room)}`;
  return { room, invite, deepLink: `telao://entrar/?convite=${encodeURIComponent(invite)}` };
}

const STYLE = `
:root{color-scheme:light dark;--bg:#0d1117;--panel:#151a21;--text:#e6edf3;--muted:#8d98a6;--border:#283039;--accent:#2563eb}
@media (prefers-color-scheme:light){:root{--bg:#f4f6f9;--panel:#fff;--text:#111827;--muted:#556170;--border:#dde3ea}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:15px/1.5 "Segoe UI",system-ui,sans-serif}
main{width:100%;max-width:480px;padding:28px;border-radius:16px;background:var(--panel);border:1px solid var(--border)}
h1{margin:0 0 6px;font-size:22px}h2{margin:22px 0 6px;font-size:15px}
p{margin:8px 0}.muted{color:var(--muted);font-size:13.5px}.room{font-weight:700;word-break:break-all}
.btn{display:block;margin:18px 0 6px;padding:13px;border-radius:10px;background:var(--accent);color:#fff;text-align:center;font-weight:600;text-decoration:none}
.btn:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn[aria-disabled="true"]{opacity:.7;cursor:progress}
ol{margin:6px 0;padding-left:20px}
code{display:block;margin-top:8px;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--bg);font:13px Consolas,ui-monospace,monospace;word-break:break-all;user-select:all}
button{margin-top:8px;padding:7px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);font:inherit;cursor:pointer}
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
  <h1>📺 Convite para o Telão</h1>
  <p>Você foi convidado para a sala <span class="room">${escapeHtml(room)}</span>.</p>
  <a class="btn" id="open" href="${escapeHtml(deepLink)}">Abrir no Telão</a>
  <p class="muted">Se o navegador perguntar, permita abrir o Telão.</p>
  <h2>Não abriu?</h2>
  <ol>
    <li>Você precisa do Telão no computador (Windows). Peça o arquivo para quem te convidou.</li>
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

/** Atende as requisições HTTP do servidor da sala (o WebSocket é tratado à parte). */
function handleHttpRequest(req, res) {
  let pathname = '/';
  try {
    pathname = new URL(req.url, 'http://local').pathname;
  } catch { /* fica na raiz */ }
  const send = (status, type, body) => {
    res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain; charset=utf-8', 'Método não permitido.\n');
  if (pathname === '/' || pathname === '/health') return send(200, 'text/plain; charset=utf-8', 'Telão: servidor de sinalização ativo.\n');
  if (pathname === '/robots.txt') return send(200, 'text/plain; charset=utf-8', 'User-agent: *\nDisallow: /\n');
  if (pathname === '/favicon.ico') return send(404, 'text/plain; charset=utf-8', '');
  const invite = inviteFromRequest(req);
  if (!invite) return send(404, 'text/plain; charset=utf-8', 'Convite inválido.\n');
  return send(200, 'text/html; charset=utf-8', invitePage(invite));
}

module.exports = { handleHttpRequest, inviteFromRequest, invitePage, escapeHtml };
