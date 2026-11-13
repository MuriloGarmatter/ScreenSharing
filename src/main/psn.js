'use strict';

// Login na PSN para descobrir o ID da conta, que o PS5 exige no pareamento do
// Remote Play. É o mesmo caminho do aplicativo oficial (e do chiaki-ng): a pessoa
// entra na página da Sony, a Sony devolve um código, e com ele se pergunta o número
// da conta. O Telão não vê nem guarda a senha, e joga fora o código e o token:
// só o ID da conta fica salvo.

const crypto = require('node:crypto');

// Identificação do aplicativo Remote Play, pública (a mesma que o chiaki-ng usa).
const CLIENT_ID = 'ba495a24-818c-472b-b12d-ff231c1b5745';
const CLIENT_SECRET = 'mvaiZkRsAsI1IBkY';
const SCOPE = 'psn:clientapp referenceDataService:countryConfig.read pushNotification:webSocket.desktop.connect sessionManager:remotePlaySession.system.update';
const REDIRECT_URI = 'https://remoteplay.dl.playstation.net/remoteplay/redirect';
const AUTHORIZE_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/authorize';
const TOKEN_URL = 'https://auth.api.sonyentertainmentnetwork.com/2.0/oauth/token';
const DUID_PREFIX = '0000000700410080';

/** A página de login da Sony. */
function loginUrl(random = crypto.randomBytes(16)) {
  const params = new URLSearchParams({
    service_entity: 'urn:service-entity:psn',
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    request_locale: 'pt_BR',
    ui: 'pr',
    service_logo: 'ps',
    layout_type: 'popup',
    smcid: 'remoteplay',
    prompt: 'always',
    PlatformPrivacyWs1: 'minimal',
    duid: DUID_PREFIX + Buffer.from(random).toString('hex'),
  });
  return `${AUTHORIZE_URL}?${params}`;
}

/** O código que a Sony devolve no endereço de retorno, ou null se não for ele. */
function redirectCode(url) {
  if (typeof url !== 'string' || !url.startsWith(REDIRECT_URI)) return null;
  try {
    return new URL(url).searchParams.get('code') || null;
  } catch {
    return null;
  }
}

/** O login foi recusado ou cancelado na página da Sony (o retorno vem com "error"). */
function redirectError(url) {
  if (typeof url !== 'string' || !url.startsWith(REDIRECT_URI)) return null;
  try {
    const params = new URL(url).searchParams;
    return params.get('error_description') || params.get('error') || null;
  } catch {
    return null;
  }
}

/** Número da conta (decimal) -> os 8 bytes, do menos para o mais significativo, em base64. */
function accountIdFromUserId(userId) {
  const text = String(userId ?? '').trim();
  if (!/^\d{1,19}$/.test(text)) throw new Error('A Sony respondeu um número de conta inválido.');
  const value = BigInt(text);
  if (value > 0x7fffffffffffffffn) throw new Error('A Sony respondeu um número de conta inválido.');
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64LE(value);
  return bytes.toString('base64');
}

/** Troca o código do login pelo ID da conta (base64, como o pareamento pede). */
async function accountIdFromCode(code, fetchImpl = fetch) {
  const auth = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`;
  const ask = async (url, options) => {
    let response;
    try {
      response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error('Não foi possível falar com a Sony. Confira a internet e tente de novo.');
    }
    if (!response.ok) throw new Error(`A Sony recusou o login (erro ${response.status}). Tente de novo.`);
    try {
      return await response.json();
    } catch {
      throw new Error('A Sony respondeu algo inesperado. Tente de novo.');
    }
  };
  const token = await ask(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, scope: SCOPE, redirect_uri: REDIRECT_URI }).toString(),
  });
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('A Sony não devolveu o acesso. Tente de novo.');
  const info = await ask(`${TOKEN_URL}/${encodeURIComponent(token.access_token)}`, {
    method: 'GET',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
  });
  return accountIdFromUserId(info.user_id);
}

module.exports = { loginUrl, redirectCode, redirectError, accountIdFromUserId, accountIdFromCode, REDIRECT_URI };
