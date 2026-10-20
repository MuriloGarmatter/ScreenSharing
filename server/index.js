'use strict';

// Servidor de sinalização independente, para rodar num PC sempre ligado ou
// numa hospedagem (Render, Railway, Fly.io, VPS, Oracle Free...).
//
// Variáveis de ambiente (todas opcionais):
//   PORT                       porta HTTP/WebSocket (padrão 47800)
//   SERVER_PASSWORD            senha exigida para entrar em qualquer sala
//   TURN_URLS                  ex.: "turn:meu.servidor:3478,turns:meu.servidor:5349"
//   TURN_USERNAME / TURN_CREDENTIAL
//   CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN

const http = require('node:http');
const { attachSignaling, iceServersFromEnv } = require('./signaling');

const port = Number(process.env.PORT) || 47800;
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Telão: servidor de sinalização ativo.\n');
});

const signaling = attachSignaling(server, {
  password: process.env.SERVER_PASSWORD || '',
  getIceServers: iceServersFromEnv(process.env, log),
  log,
});

server.listen(port, () => {
  log(`Servidor de sinalização ouvindo na porta ${port} (ws://SEU-IP:${port})`);
  if (process.env.SERVER_PASSWORD) log('Senha do servidor ativada.');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await signaling.close();
    server.close(() => process.exit(0));
  });
}
