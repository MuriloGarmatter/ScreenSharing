// Testes de unidade do PS5: leitura do H.264, perfis de transmissão e login na PSN.
// (O caminho inteiro, com vídeo e som, é o test/ps5.js.)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { avcCodec, isKeyframe, nalUnits } from '../src/renderer/ps5.js';

const require = createRequire(import.meta.url);
const { Ps5, streamProfile, cleanHost } = require('../src/main/ps5.js');
const psn = require('../src/main/psn.js');
const here = path.dirname(fileURLToPath(import.meta.url));

const bytes = (...parts) => Uint8Array.from(parts.flat());
const START4 = [0, 0, 0, 1];
const START3 = [0, 0, 1];
const SPS = [0x67, 0x64, 0x00, 0x2a, 0xac];
const PPS = [0x68, 0xeb, 0xcc];
const IDR = [0x65, 0x88, 0x84];
const P = [0x41, 0x9a, 0x02];

test('nalUnits separa as unidades com start code de 3 e de 4 bytes', () => {
  const data = bytes(START4, SPS, START4, PPS, START3, IDR);
  const units = nalUnits(data);
  assert.deepEqual(units.map((u) => u.type), [7, 8, 5]);
  assert.deepEqual([...data.subarray(units[0].start, units[0].end)], SPS);
  assert.deepEqual([...data.subarray(units[2].start, units[2].end)], IDR);
});

test('isKeyframe: só o quadro com IDR', () => {
  assert.equal(isKeyframe(bytes(START4, SPS, START4, PPS, START4, IDR)), true);
  assert.equal(isKeyframe(bytes(START4, P)), false);
  assert.equal(isKeyframe(bytes(START4, SPS, START4, PPS)), false, 'SPS/PPS sozinhos não são um quadro');
  assert.equal(isKeyframe(new Uint8Array(0)), false);
});

test('avcCodec lê perfil, restrições e nível do SPS', () => {
  assert.equal(avcCodec(bytes(START4, SPS, START4, PPS, START4, IDR)), 'avc1.64002a');
  assert.equal(avcCodec(bytes(START4, P)), null);
});

test('o vídeo de exemplo começa com um quadro completo e dá o codec certo', () => {
  const data = fs.readFileSync(path.join(here, 'fixtures', 'ps5-sample.h264'));
  const first = data.subarray(0, 40_000);
  assert.equal(avcCodec(first), 'avc1.64001e');
  assert.ok(nalUnits(first).some((u) => u.type === 5));
});

test('streamProfile: o PS5 só faz 720p/1080p a 30/60', () => {
  assert.deepEqual(streamProfile({ resolution: '1080p', fps: 60, bitrate: 0 }), { resolution: '1080p', fps: 60, args: ['--resolution', '1080p', '--fps', '60'] });
  assert.equal(streamProfile({ resolution: '480p', fps: 15 }).resolution, '720p');
  assert.equal(streamProfile({ resolution: '480p', fps: 15 }).fps, 30);
  assert.equal(streamProfile({ resolution: 'native', fps: 45 }).resolution, '1080p');
  assert.equal(streamProfile({ resolution: '1440p', fps: 45 }).fps, 60);
  assert.equal(streamProfile().resolution, '1080p');
});

test('streamProfile: bitrate pedido ao console fica entre 5 e 40 Mb/s', () => {
  const kbps = (mbps) => Number(streamProfile({ bitrate: mbps }).args.at(-1));
  assert.equal(kbps(1), 5000);
  assert.equal(kbps(8), 12000);
  assert.equal(kbps(40), 40000);
  assert.equal(streamProfile({ bitrate: 0 }).args.includes('--bitrate'), false);
});

test('cleanHost recusa o que não é endereço', () => {
  assert.equal(cleanHost(' 192.168.0.10 '), '192.168.0.10');
  assert.equal(cleanHost('ps5.local'), 'ps5.local');
  assert.equal(cleanHost('1.2.3.4 --pin 1'), null);
  assert.equal(cleanHost('a"b'), null);
  assert.equal(cleanHost(''), null);
});

test('Ps5 guarda os pareados sem expor as chaves e segue o console que mudou de endereço', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telao-ps5-unit-'));
  try {
    const ps5 = new Ps5({ helperPath: path.join(here, 'fixtures', 'fake-ps5.js'), storeFile: path.join(dir, 'ps5.json'), logFile: path.join(dir, 'ps5.log'), send: () => {} });
    assert.deepEqual(ps5.list(), { accountId: '', consoles: [] });
    ps5.writeStore({ accountId: 'AAAAAAAAAAA=', consoles: [{ id: 'FAKE-PS5-ID', name: 'PS5', host: '10.0.0.99', keys: ps5.sealKeys({ registKey: 'aa', rpKey: 'bb' }) }] });
    assert.deepEqual(ps5.list().consoles, [{ id: 'FAKE-PS5-ID', name: 'PS5', host: '10.0.0.99' }]);
    // A busca só acha quem responde: aqui, a rede "responde" o mesmo console em outro endereço.
    ps5.discover = async ({ host } = {}) => (host === '10.0.0.99' ? [] : [{ host: '10.0.0.7', name: 'PS5', id: 'fake-ps5-id', state: 'ready', ps5: true }]);
    const entry = ps5.readStore().consoles[0];
    const found = await ps5.locate(entry);
    assert.equal(found.host, '10.0.0.7');
    assert.equal(entry.host, '10.0.0.7');
    assert.equal(ps5.list().consoles[0].host, '10.0.0.7', 'o endereço novo fica salvo');
    assert.deepEqual(ps5.openKeys(ps5.readStore().consoles[0]), { registKey: 'aa', rpKey: 'bb' });
    assert.deepEqual(ps5.forget('FAKE-PS5-ID').consoles, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PSN: o número da conta vira 8 bytes (do menos significativo) em base64', () => {
  assert.equal(psn.accountIdFromUserId('1'), 'AQAAAAAAAAA=');
  assert.equal(psn.accountIdFromUserId('72623859790382856'), 'CAcGBQQDAgE='); // 0x0102030405060708
  assert.equal(psn.accountIdFromUserId('9223372036854775807'), '/////////38=');
  for (const bad of ['', 'abc', '-1', '9223372036854775808', undefined]) assert.throws(() => psn.accountIdFromUserId(bad));
});

test('PSN: a página de login leva a identificação do Remote Play e um duid novo', () => {
  const url = new URL(psn.loginUrl(Buffer.alloc(16, 0xab)));
  assert.equal(url.origin + url.pathname, 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'ba495a24-818c-472b-b12d-ff231c1b5745');
  assert.equal(url.searchParams.get('redirect_uri'), psn.REDIRECT_URI);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('duid'), `0000000700410080${'ab'.repeat(16)}`);
  assert.notEqual(psn.loginUrl(), psn.loginUrl());
});

test('PSN: só o endereço de retorno da Sony entrega o código', () => {
  assert.equal(psn.redirectCode(`${psn.REDIRECT_URI}?code=AbC123&cid=x`), 'AbC123');
  assert.equal(psn.redirectCode(`${psn.REDIRECT_URI}?error=access_denied`), null);
  assert.equal(psn.redirectError(`${psn.REDIRECT_URI}?error=access_denied`), 'access_denied');
  assert.equal(psn.redirectCode('https://exemplo.com/remoteplay/redirect?code=roubado'), null);
  assert.equal(psn.redirectCode(null), null);
});

test('PSN: troca o código pelo ID da conta em duas chamadas', async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const body = calls.length === 1 ? { access_token: 'tok/en+1', refresh_token: 'r', expires_in: 3600 } : { user_id: '72623859790382856' };
    return { ok: true, status: 200, json: async () => body };
  };
  assert.equal(await psn.accountIdFromCode('AbC123', fakeFetch), 'CAcGBQQDAgE=');
  assert.equal(calls[0].url, 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token');
  assert.equal(calls[0].options.method, 'POST');
  const sent = new URLSearchParams(calls[0].options.body);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('code'), 'AbC123');
  assert.equal(sent.get('redirect_uri'), psn.REDIRECT_URI);
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('ba495a24-818c-472b-b12d-ff231c1b5745:mvaiZkRsAsI1IBkY').toString('base64')}`);
  assert.equal(calls[1].url, 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token/tok%2Fen%2B1');
});

test('PSN: erros da Sony viram mensagens claras', async () => {
  await assert.rejects(psn.accountIdFromCode('x', async () => ({ ok: false, status: 400, json: async () => ({}) })), /recusou o login \(erro 400\)/);
  await assert.rejects(psn.accountIdFromCode('x', async () => { throw new Error('offline'); }), /Confira a internet/);
  await assert.rejects(psn.accountIdFromCode('x', async () => ({ ok: true, status: 200, json: async () => ({}) })), /não devolveu o acesso/);
});
