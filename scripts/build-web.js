'use strict';

// Monta o Telão para o navegador (iPhone, Android, Mac, Linux) em worker/public/app/:
// a mesma interface do app (src/renderer), com a ponte src/web/bridge.js no lugar do
// preload do Electron. O servidor da Cloudflare serve esses arquivos em /app/; o
// wrangler roda este script antes de cada deploy (e no "wrangler dev").

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const renderer = path.join(root, 'src', 'renderer');
const out = path.join(root, 'worker', 'public', 'app');
const { version } = require(path.join(root, 'package.json'));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// Tudo da interface, menos o index.html (refeito abaixo).
fs.cpSync(renderer, out, { recursive: true, filter: (from) => from !== path.join(renderer, 'index.html') });

// A ponte, com a versão (quem está numa versão antiga do app vê o aviso de sempre).
const bridge = fs.readFileSync(path.join(root, 'src', 'web', 'bridge.js'), 'utf8');
const token = "'__TELAO_VERSION__'"; // a constante (o nome também aparece no comentário)
if (!bridge.includes(token)) throw new Error('bridge.js sem a constante da versão');
fs.writeFileSync(path.join(out, 'bridge.js'), bridge.replace(token, JSON.stringify(version)));

// "Adicionar à Tela de Início": abre como um app, sem a barra do navegador. Sem
// start_url, o atalho guarda o endereço da página (com a sala da turma).
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), `${JSON.stringify({
  name: 'Telão',
  short_name: 'Telão',
  display: 'standalone',
  background_color: '#0e0f11',
  theme_color: '#16171a',
  icons: [{ src: 'assets/icon.png', sizes: '256x256', type: 'image/png' }],
}, null, 2)}\n`);

// A mesma página do app, com a ponte carregada antes de tudo.
const anchor = '<script src="theme.js"></script>';
let html = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
if (!html.includes(anchor)) throw new Error(`index.html sem ${anchor}`);
html = html.replace(anchor, [
  '<script src="bridge.js"></script>',
  '<link rel="manifest" href="manifest.webmanifest">',
  '<link rel="icon" href="assets/icon.png">',
  '<link rel="apple-touch-icon" href="assets/icon.png">',
  '<meta name="apple-mobile-web-app-capable" content="yes">',
  '<meta name="mobile-web-app-capable" content="yes">',
  '<meta name="apple-mobile-web-app-title" content="Telão">',
  '<meta name="theme-color" content="#16171a">',
  anchor,
].join('\n  '));
fs.writeFileSync(path.join(out, 'index.html'), html);

const count = fs.readdirSync(out, { recursive: true }).length;
console.log(`Telão ${version} para o navegador: ${count} arquivos em ${path.relative(root, out)}`);
