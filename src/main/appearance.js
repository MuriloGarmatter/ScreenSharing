'use strict';

// Aparência guardada pelo processo principal (appearance.json): o tema e a cor de
// fundo de cada modo. Serve para a janela já abrir com o fundo certo, antes de a
// interface carregar (a interface guarda o resto, inclusive a cor de destaque).

const THEMES = ['dark', 'light', 'system'];
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_APPEARANCE = Object.freeze({
  theme: 'dark',
  backgrounds: Object.freeze({ dark: '#0e0f11', light: '#eceef1' }),
});

// Barra de título integrada (Windows): os botões de minimizar, maximizar e fechar são
// desenhados pelo sistema sobre a barra superior do app, com a cor dela (--panel) e
// a cor do texto (--text) de cada modo. A altura é a da barra superior.
const TITLE_BAR_HEIGHT = 48;
const TITLE_BAR = Object.freeze({
  dark: Object.freeze({ color: '#16171a', symbolColor: '#eceef1' }),
  light: Object.freeze({ color: '#f7f7f8', symbolColor: '#121316' }),
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

/** Opções de titleBarOverlay para o modo ('dark' ou 'light'). */
function titleBarOverlay(mode) {
  return { ...TITLE_BAR[mode === 'light' ? 'light' : 'dark'], height: TITLE_BAR_HEIGHT };
}

module.exports = { DEFAULT_APPEARANCE, TITLE_BAR, TITLE_BAR_HEIGHT, normalizeAppearance, titleBarOverlay };
