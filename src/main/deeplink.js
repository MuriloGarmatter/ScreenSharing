'use strict';

// Links telao:// (convites clicáveis). O Windows abre o Telão passando o link
// na linha de comando; se o Telão já está aberto, a nova cópia repassa o link
// para a que já existe e fecha (requestSingleInstanceLock).

const PROTOCOL = 'telao';

function findDeepLink(argv) {
  return (Array.isArray(argv) ? argv : [])
    .find((arg) => typeof arg === 'string' && arg.length < 2048 && /^telao:\/\//i.test(arg)) || null;
}

module.exports = { PROTOCOL, findDeepLink };
