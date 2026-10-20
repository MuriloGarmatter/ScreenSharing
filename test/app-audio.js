'use strict';

// Testa o telao-audio.exe de verdade: toca dois tons baixinhos, um por
// "ToneApp.exe" (440 Hz) e outro por "FakeDiscord.exe" (880 Hz, no papel do
// Discord), e confere que só o primeiro é capturado.
// Uso: npm run test:audio

const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HELPER = path.join(ROOT, 'resources', 'telao-audio.exe');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function compileToneApps(dir) {
  const source = path.join(__dirname, 'fixtures', 'ToneApp.cs');
  for (const name of ['ToneApp.exe', 'FakeDiscord.exe']) {
    execFileSync(CSC, ['/nologo', '/platform:x64', `/out:${path.join(dir, name)}`, source], { stdio: 'inherit' });
  }
}

/** Intensidade de uma frequência no sinal (algoritmo de Goertzel), 48 kHz. */
function toneLevel(samples, hz) {
  const k = (2 * Math.PI * hz) / 48000;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (const x of samples) {
    const s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / samples.length;
}

/** Roda o helper por alguns segundos e devolve eventos e estatísticas por fonte. */
function runHelper(args, seconds) {
  return new Promise((resolve, reject) => {
    const proc = spawn(HELPER, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    const events = [];
    const audio = new Map(); // id -> amostras do canal esquerdo
    let buffer = Buffer.alloc(0);
    proc.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 9) {
        const type = buffer[0];
        const id = buffer.readUInt32LE(1);
        const length = buffer.readUInt32LE(5);
        if (buffer.length < 9 + length) break;
        const payload = buffer.subarray(9, 9 + length);
        buffer = buffer.subarray(9 + length);
        if (type === 2) {
          events.push(JSON.parse(payload.toString('utf8')));
        } else if (type === 1) {
          const samples = audio.get(id) || [];
          for (let i = 0; i + 3 < payload.length; i += 4) samples.push(payload.readInt16LE(i) / 32768);
          audio.set(id, samples);
        }
      }
    });
    proc.once('error', reject);
    setTimeout(() => {
      proc.stdin.end(); // o helper sai quando o stdin fecha
      setTimeout(() => proc.kill(), 1000);
    }, seconds * 1000);
    proc.once('exit', () => {
      const sources = events.filter((e) => e.event === 'source').map((e) => {
        const all = audio.get(e.id) || [];
        const tail = all.slice(-48000); // último segundo, já estável
        const rms = tail.length ? Math.sqrt(tail.reduce((sum, x) => sum + x * x, 0) / tail.length) : 0;
        return {
          name: e.name,
          pid: e.pid,
          rms: Number(rms.toFixed(4)),
          tone440: Number(toneLevel(tail, 440).toFixed(4)),
          tone880: Number(toneLevel(tail, 880).toFixed(4)),
        };
      });
      resolve({ events, sources });
    });
  });
}

(async () => {
  assert.ok(fs.existsSync(HELPER), 'rode "npm run build:audio" antes');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-audio-test-'));
  compileToneApps(dir);
  const tone = spawn(path.join(dir, 'ToneApp.exe'), ['440', '40'], { windowsHide: true });
  const discord = spawn(path.join(dir, 'FakeDiscord.exe'), ['880', '40'], { windowsHide: true });
  try {
    await new Promise((r) => setTimeout(r, 1500));

    const list = JSON.parse(execFileSync(HELPER, ['--mode', 'list']).toString());
    console.log('Apps com sessão de áudio:', list.map((s) => s.name).join(', '));
    assert.ok(list.some((s) => s.name === 'ToneApp.exe'), 'ToneApp.exe deve aparecer na lista');

    console.log('\n1) Todo o PC, menos FakeDiscord.exe');
    // (O PID deste teste não entra na exclusão: ele é o "pai" dos apps de tom,
    // e excluir um processo exclui também os filhos dele.)
    const all = await runHelper(['--mode', 'all', '--exclude-names', 'FakeDiscord.exe'], 4);
    console.log('   fontes:', all.sources);
    console.log('   excluídos:', all.events.filter((e) => e.event === 'excluded').map((e) => `${e.name} (${e.reason})`));
    const toneSource = all.sources.find((s) => s.name === 'ToneApp.exe');
    assert.ok(toneSource, 'ToneApp.exe deve ser capturado');
    assert.ok(toneSource.rms > 0.01, 'o som do ToneApp deve chegar com volume');
    assert.ok(toneSource.tone440 > 0.01, 'o tom de 440 Hz (ToneApp) deve estar presente');
    assert.ok(toneSource.tone880 < 0.001, 'o tom de 880 Hz (FakeDiscord) não pode vazar');
    assert.ok(!all.sources.some((s) => s.name === 'telao-audio.exe'), 'o helper não pode capturar a si mesmo');
    assert.ok(!all.sources.some((s) => s.name === 'FakeDiscord.exe'), 'FakeDiscord.exe NÃO pode ser capturado');
    assert.ok(all.events.some((e) => e.event === 'excluded' && e.name === 'FakeDiscord.exe'), 'deve avisar que excluiu o FakeDiscord');

    console.log('\n2) Só o app de um processo (ToneApp)');
    const app = await runHelper(['--mode', 'app', '--pid', String(tone.pid), '--exclude-names', 'FakeDiscord.exe'], 3);
    console.log('   fontes:', app.sources);
    assert.deepEqual(app.sources.map((s) => s.name), ['ToneApp.exe']);

    console.log('\n3) Só o app de um processo excluído (FakeDiscord) → nada');
    const blocked = await runHelper(['--mode', 'app', '--pid', String(discord.pid), '--exclude-names', 'FakeDiscord.exe'], 3);
    console.log('   fontes:', blocked.sources);
    assert.equal(blocked.sources.length, 0);

    console.log('\n4) Todo o PC, excluindo pelo PID (como o Telão exclui a si mesmo)');
    const byPid = await runHelper(['--mode', 'all', '--exclude-pids', String(discord.pid)], 3);
    console.log('   fontes:', byPid.sources);
    assert.ok(byPid.sources.some((s) => s.name === 'ToneApp.exe'));
    assert.ok(!byPid.sources.some((s) => s.name === 'FakeDiscord.exe'));

    console.log('\nCAPTURA POR APLICATIVO OK');
  } catch (err) {
    console.error('\nFALHOU:', err.message);
    process.exitCode = 1;
  } finally {
    tone.kill();
    discord.kill();
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 500);
  }
})();
