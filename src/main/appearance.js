'use strict';

// Aparência guardada pelo processo principal (appearance.json): o tema e a cor de
// fundo de cada modo. Serve para a janela já abrir com o fundo certo, antes de a
// interface carregar (a interface guarda o resto, inclusive a cor de destaque).

const THEMES = ['dark', 'light', 'system'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_APPEARANCE = Object.freeze({
  theme: 'dark',
  backgrounds: Object.freeze({ dark: '#0d1117', light: '#f4f6f9' }),
});

/** Valida o que veio do arquivo ou da interface; o que for inválido vem de fallback. */
function normalizeAppearance(value, fallback = DEFAULT_APPEARANCE) {
  const source = value && typeof value === 'object' ? value : {};
  const backgrounds = source.backgrounds && typeof source.backgrounds === 'object' ? source.backgrounds : {};
  return {
    theme: THEMES.includes(source.theme) ? source.theme : fallback.theme,
    backgrounds: {
      dark: HEX_COLOR.test(backgrounds.dark) ? backgrounds.dark : fallback.backgrounds.dark,
      light: HEX_COLOR.test(backgrounds.light) ? backgrounds.light : fallback.backgrounds.light,
    },
  };
}

module.exports = { DEFAULT_APPEARANCE, normalizeAppearance };
