// Aparência do Telão: tema (escuro, claro ou igual ao Windows) e cor de destaque.
// Script clássico (não é módulo) carregado no <head>: aplica a aparência salva
// antes da primeira pintura, para a janela não "piscar" com a cor padrão.
// Expõe tudo em globalThis.TelaoTheme (usado pelo app.js e pelos testes).
(function () {
  'use strict';

  const PREFS_KEY = 'telao.prefs.v1';
  const DEFAULT_APPEARANCE = { theme: 'dark', accent: '#2563eb' };
  const THEMES = ['dark', 'light', 'system'];
  const PRESETS = [
    { name: 'Azul', color: '#2563eb' },
    { name: 'Roxo', color: '#7c3aed' },
    { name: 'Rosa', color: '#db2777' },
    { name: 'Vermelho', color: '#dc2626' },
    { name: 'Laranja', color: '#c2410c' },
    { name: 'Amarelo', color: '#eab308' },
    { name: 'Verde', color: '#15803d' },
    { name: 'Ciano', color: '#0e7490' },
    { name: 'Grafite', color: '#475569' },
  ];
  // Superfícies de cada modo; precisam bater com --panel, --bg e --bg-sunken do styles.css.
  const SURFACES = {
    dark: { panel: '#151a21', bg: '#0d1117', sunken: '#090c10' },
    light: { panel: '#ffffff', bg: '#f4f6f9', sunken: '#e9edf2' },
  };
  // Pior caso para bordas e anéis de foco: no escuro, a superfície mais clara em que
  // eles aparecem (o painel); no claro, a mais escura (o fundo rebaixado da sala).
  const UI_REFERENCE = { dark: SURFACES.dark.panel, light: SURFACES.light.sunken };
  const WHITE = { r: 255, g: 255, b: 255 };
  const BLACK = { r: 0, g: 0, b: 0 };

  function parseHex(value) {
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value || '').trim());
    if (!match) return null;
    let hex = match[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function toHex(color) {
    return `#${[color.r, color.g, color.b]
      .map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  function rgba(color, alpha) {
    return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${alpha})`;
  }

  /** Luminância relativa (WCAG 2). */
  function luminance(color) {
    const channel = (v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  }

  /** Razão de contraste (WCAG 2), de 1 a 21. */
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function mix(a, b, t) {
    return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
  }

  /** Texto legível sobre a cor: branco se der 4,5:1; senão o que contrastar mais (preto). */
  function readableOn(color) {
    if (contrast(WHITE, color) >= 4.5) return WHITE;
    return contrast(BLACK, color) > contrast(WHITE, color) ? BLACK : WHITE;
  }

  /**
   * Clareia (fundo escuro) ou escurece (fundo claro) a cor até ter o contraste mínimo.
   * Trabalha com canais inteiros, arredondando na direção do alvo: assim o valor
   * final em hexadecimal também cumpre o mínimo (e cada passo sempre avança).
   */
  function ensureContrast(color, background, minimum) {
    const target = luminance(background) < 0.5 ? WHITE : BLACK;
    const round = target === WHITE ? Math.ceil : Math.floor;
    const step = (c) => {
      const next = mix(c, target, 0.06);
      return { r: round(next.r), g: round(next.g), b: round(next.b) };
    };
    let current = { r: Math.round(color.r), g: Math.round(color.g), b: Math.round(color.b) };
    for (let i = 0; i < 80 && contrast(current, background) < minimum; i++) current = step(current);
    return current;
  }

  function rotateHue(color, degrees) {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return color;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
    h = (h + degrees / 360 + 1) % 1;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = (t) => {
      let x = t;
      if (x < 0) x += 1;
      if (x > 1) x -= 1;
      if (x < 1 / 6) return p + (q - p) * 6 * x;
      if (x < 1 / 2) return q;
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
      return p;
    };
    return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 };
  }

  function normalize(appearance) {
    const theme = THEMES.includes(appearance && appearance.theme) ? appearance.theme : DEFAULT_APPEARANCE.theme;
    const parsed = parseHex(appearance && appearance.accent);
    return { theme, accent: parsed ? toHex(parsed) : DEFAULT_APPEARANCE.accent };
  }

  /** 'light' ou 'dark'. "Igual ao Windows" segue o tema do sistema. */
  function effectiveMode(theme) {
    if (theme === 'light' || theme === 'dark') return theme;
    try {
      return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  }

  /** Variáveis CSS derivadas da cor de destaque, para o modo dado. */
  function accentVars(accentHex, mode) {
    const accent = parseHex(accentHex) || parseHex(DEFAULT_APPEARANCE.accent);
    const reference = parseHex(UI_REFERENCE[mode === 'light' ? 'light' : 'dark']);
    const text = readableOn(accent);
    // Bordas, foco e indicadores precisam de 3:1 contra o fundo (WCAG 1.4.11).
    const ui = ensureContrast(accent, reference, 3);
    // No hover, o fundo do botão se afasta da cor do texto (o contraste só melhora).
    const hover = text === WHITE ? mix(accent, BLACK, 0.14) : mix(accent, WHITE, 0.18);
    const logoTo = rotateHue(accent, 40);
    const dark = mode !== 'light';
    return {
      '--accent': toHex(accent),
      '--accent-hover': toHex(hover),
      '--accent-text': toHex(text),
      '--accent-ui': toHex(ui),
      '--accent-soft': rgba(ui, dark ? 0.18 : 0.14),
      '--logo-from': toHex(accent),
      '--logo-to': toHex(logoTo),
      '--glow-1': rgba(accent, dark ? 0.16 : 0.12),
      '--glow-2': rgba(logoTo, dark ? 0.13 : 0.1),
    };
  }

  /**
   * Aplica a aparência na página e devolve { theme, accent, mode }. Com "Igual ao
   * Windows", o processo principal pode informar o modo certo em modeOverride.
   */
  function apply(appearance, root, modeOverride) {
    const target = root || document.documentElement;
    const normalized = normalize(appearance);
    const mode = modeOverride === 'light' || modeOverride === 'dark' ? modeOverride : effectiveMode(normalized.theme);
    target.dataset.mode = mode;
    for (const [name, value] of Object.entries(accentVars(normalized.accent, mode))) {
      target.style.setProperty(name, value);
    }
    return { ...normalized, mode };
  }

  function load() {
    try {
      return normalize(JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').appearance);
    } catch {
      return { ...DEFAULT_APPEARANCE };
    }
  }

  globalThis.TelaoTheme = {
    PREFS_KEY, DEFAULT_APPEARANCE, PRESETS, SURFACES, UI_REFERENCE,
    parseHex, toHex, luminance, contrast, readableOn, ensureContrast, rotateHue,
    normalize, effectiveMode, accentVars, apply, load,
  };

  if (typeof document !== 'undefined' && document.documentElement) {
    try { apply(load()); } catch { /* fica a aparência padrão do CSS */ }
  }
})();
