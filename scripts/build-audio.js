'use strict';

// Compila native/TelaoAudio.cs -> resources/telao-audio.exe usando o compilador
// C# do .NET Framework 4, que já vem instalado em todo Windows 10/11.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') {
  console.log('Captura de som por aplicativo só existe no Windows; nada a compilar.');
  process.exit(0);
}

const windir = process.env.WINDIR || 'C:\\Windows';
const csc = [
  path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
  path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
].find((p) => fs.existsSync(p));
if (!csc) {
  console.error('csc.exe do .NET Framework 4 não encontrado.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const source = path.join(root, 'native', 'TelaoAudio.cs');
const output = path.join(root, 'resources', 'telao-audio.exe');
fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(csc, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', `/out:${output}`, source], { stdio: 'inherit' });
console.log(`Gerado: ${path.relative(root, output)}`);
