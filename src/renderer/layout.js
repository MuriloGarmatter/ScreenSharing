// Arranjo do multivisor: quantas colunas deixam cada imagem 16:9 o maior possível
// no palco (duas telas num palco alto ficam uma sobre a outra, não lado a lado).

/**
 * count telas num palco de width × height pixels, com gap entre elas e uma faixa
 * de rótulo de `strip` pixels embaixo de cada imagem. Devolve o número de colunas.
 */
export function bestColumns(count, width, height, { gap = 8, strip = 30, aspect = 16 / 9 } = {}) {
  if (count <= 1 || !(width > 0) || !(height > 0)) return 1;
  let best = 1;
  let bestWidth = 0;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellWidth = (width - gap * (cols - 1)) / cols;
    const cellHeight = (height - gap * (rows - 1)) / rows - strip;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    const videoWidth = Math.min(cellWidth, cellHeight * aspect);
    // Empate (diferença de 1 px): fica com menos colunas, que deixa a grade mais calma.
    if (videoWidth > bestWidth + 1) {
      best = cols;
      bestWidth = videoWidth;
    }
  }
  return best;
}
