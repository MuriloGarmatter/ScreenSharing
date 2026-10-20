'use strict';

// Abre o app em modo de desenvolvimento. Remove ELECTRON_RUN_AS_NODE, que o
// VS Code às vezes deixa no ambiente e faria o Electron rodar como Node puro.

const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [path.join(__dirname, '..'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
