// Versões do Telão ("1.3.0"): comparar e saber quem na sala está numa versão antiga.

const VERSION = /^\d+\.\d+\.\d+$/;

/** -1, 0 ou 1. Uma versão ausente ou inválida conta como a mais antiga. */
export function compareVersions(a, b) {
  const parse = (v) => (VERSION.test(String(v ?? '')) ? String(v).split('.').map(Number) : null);
  const x = parse(a);
  const y = parse(b);
  if (!x && !y) return 0;
  if (!x) return -1;
  if (!y) return 1;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Ids de quem está numa versão mais antiga que a minha. Só dá para saber quando o
 * servidor da sala repassa as versões (versionsKnown); aí quem não informou nenhuma
 * é de antes da 1.3.
 */
export function outdatedPeers(mine, peers, versionsKnown) {
  if (!versionsKnown || !VERSION.test(String(mine ?? ''))) return new Set();
  return new Set(peers.filter((p) => compareVersions(p.version, mine) < 0).map((p) => p.id));
}
