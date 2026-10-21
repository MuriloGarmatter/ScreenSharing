---
name: Telão
description: Compartilhamento de tela P2P com som por aplicativo, desenhado como uma mesa de corte de transmissão.
colors:
  tally-red: "#d92b26"
  tally-red-hover: "#bb2521"
  on-tally-text: "#ffffff"
  console-bg: "#0e0f11"
  console-sunken: "#08090a"
  console-panel: "#16171a"
  key-face: "#222428"
  key-face-hover: "#2b2e33"
  field-well: "#0f1013"
  hairline: "#26282d"
  hairline-strong: "#3a3d44"
  console-text: "#eceef1"
  console-muted: "#9da1a9"
  placeholder: "#80858e"
  monitor-wall: "#050506"
  monitor-black: "#000000"
  umd-strip: "#0c0c0e"
  umd-line: "#1d1e22"
  wall-text: "#d9dce1"
  wall-muted: "#8b9098"
  wall-faint: "#4f535a"
  meter-off: "#2b2e33"
  light-meter-off: "#cdd1d8"
  light-bg: "#eceef1"
  light-sunken: "#dfe1e5"
  light-panel: "#f7f7f8"
  light-key-face: "#ffffff"
  light-hairline: "#d9dce1"
  light-hairline-strong: "#b8bdc6"
  light-text: "#121316"
  light-muted: "#555a63"
  signal-ok: "#3dd68c"
  signal-ok-text: "#7fe7b4"
  signal-warn: "#f5a524"
  signal-warn-text: "#ffcf7a"
  signal-danger: "#e5484d"
  signal-danger-text: "#ff9b9e"
typography:
  display:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "40px"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.015em"
  headline:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.2
  title:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  panel-title:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.005em"
  body:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  hint:
    fontFamily: "Segoe UI Variable Text, Segoe UI, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
  slate-label:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1.5
    letterSpacing: "0.06em"
  label-strip:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.05em"
    fontFeature: "tnum"
  readout:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.2
    fontFeature: "tnum"
  timecode:
    fontFamily: "Bahnschrift, Segoe UI Variable Display, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    letterSpacing: "0.02em"
    fontFeature: "tnum"
  mono:
    fontFamily: "Cascadia Mono, Consolas, ui-monospace, monospace"
    fontSize: "12.5px"
    lineHeight: 1.5
rounded:
  tally: "1px"
  monitor: "2px"
  lamp: "2px"
  chip: "3px"
  key: "4px"
  segmented: "5px"
  dialog: "6px"
spacing:
  hairline-gap: "3px"
  key-gap: "6px"
  wall-gap: "8px"
  stack: "12px"
  panel: "16px"
  dialog: "20px"
  card: "24px"
components:
  title-bar:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.console-text}"
    height: "48px"
  key:
    backgroundColor: "{colors.key-face}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.key}"
    padding: "0 14px"
    height: "34px"
  key-hover:
    backgroundColor: "{colors.key-face-hover}"
  key-lit:
    backgroundColor: "{colors.tally-red}"
    textColor: "{colors.on-tally-text}"
    rounded: "{rounded.key}"
    padding: "0 14px"
    height: "34px"
  key-lit-hover:
    backgroundColor: "{colors.tally-red-hover}"
  key-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.console-muted}"
    rounded: "{rounded.key}"
    height: "34px"
  key-small:
    rounded: "{rounded.key}"
    padding: "0 10px"
    height: "28px"
  key-big:
    rounded: "{rounded.key}"
    height: "42px"
    width: "100%"
  icon-key:
    backgroundColor: "{colors.key-face}"
    rounded: "{rounded.key}"
    size: "34px"
  format-key:
    backgroundColor: "{colors.key-face}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.key}"
    padding: "7px 12px"
    height: "50px"
  format-key-lit:
    backgroundColor: "{colors.tally-red}"
    textColor: "{colors.on-tally-text}"
  input:
    backgroundColor: "{colors.field-well}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.key}"
    padding: "0 11px"
    height: "36px"
  on-air-lamp:
    backgroundColor: "{colors.tally-red}"
    textColor: "{colors.on-tally-text}"
    typography: "{typography.label-strip}"
    padding: "0 10px"
    height: "30px"
  on-air-lamp-off:
    backgroundColor: "{colors.key-face}"
    textColor: "{colors.console-muted}"
  umd-strip:
    backgroundColor: "{colors.umd-strip}"
    textColor: "{colors.wall-text}"
    typography: "{typography.label-strip}"
    padding: "8px 10px"
  umd-strip-pinned:
    backgroundColor: "{colors.tally-red}"
    textColor: "{colors.on-tally-text}"
  tally:
    backgroundColor: "{colors.tally-red}"
    rounded: "{rounded.tally}"
    size: "10px"
  monitor-tile:
    backgroundColor: "{colors.monitor-black}"
    rounded: "{rounded.monitor}"
  avatar-monogram:
    backgroundColor: "{colors.key-face}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.chip}"
    size: "30px"
  dialog:
    backgroundColor: "{colors.console-panel}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.dialog}"
  toast:
    backgroundColor: "{colors.key-face}"
    textColor: "{colors.console-text}"
    rounded: "{rounded.key}"
    padding: "10px 14px 10px 12px"
---

# Design System: Telão

## Overview

**Creative North Star: "A Mesa de Corte"**

Telão is a broadcast control room for a handful of friends. Every friend is a source on a multiviewer; whoever is on air lights the tally. The window is built from two materials: a graphite console (top bar, the console column on the right, dialogs) and a black monitor wall (the stage, every feed, the idle and empty screens, your own output preview). The wall and its label strips are equipment, so they stay dark in both themes; only the console flips between graphite and light grey. On Windows the console's 48px top bar is also the window's title bar: there is no system frame, and Windows draws its minimize, maximize and close buttons at the right of the bar in the bar's own graphite (or light panel) and text colours.

The system has exactly one light: the user's chosen accent, default tally red. It appears only where a broadcast desk would put a lamp: lit keys, the NO AR lamp, live tallies, the pinned feed's frame and label strip, the selected source and format, the keyboard focus ring. Everything else is neutral, read by hairline rules and under-monitor label text in Bahnschrift condensed. Density is operator density: 34px keys, 6px key grids, 8px wall gaps, rows separated by 1px rules rather than boxed into cards.

It is a Windows-native tool, not a website and not a chat app. It refuses the dark chat-app vocabulary of rounded cards, pills and avatar colours, refuses gamer RGB, and refuses the cold corporate dashboard.

**Key Characteristics:**
- Two materials: graphite console and an always-black monitor wall.
- One user-chosen accent that behaves as the tally light, never as decoration.
- Square hardware: 4px keys, 2px monitors, 1px tally lamps.
- Bahnschrift condensed for anything that would be printed on the equipment: label strips, timecode, readouts, titles.
- Depth from key bevels and hairlines, not from floating cards.
- The top bar is the title bar: one console strip from the logo to the Windows caption buttons.

## Colors

A neutral graphite-and-black instrument palette with one user-chosen tally light, plus status colours used only for signal and warnings.

### Primary
- **Tally Red** (`tally-red`): the default accent and the only colour of "on air". Fills lit keys, the NO AR lamp, live tallies, the pinned tile's frame and label strip, the selected source card, checked app-audio keys and the selected format key. The user may replace it (presets: Vermelho, Laranja, Amarelo, Verde, Ciano, Azul, Roxo, Rosa, Grafite, or any hex); every rule below applies to whatever accent is chosen.
- **Tally Red Pressed** (`tally-red-hover`): hover on a lit key; derived, never hand-picked.
- **Lamp Text** (`on-tally-text`): text and icons on a lit surface; white when it reaches 4.5:1, otherwise black.

The accent is a derived family computed by `theme.js`, not a fixed palette:
- `--accent`: the raw chosen colour, for filled lamps and keys.
- `--accent-text`: white if contrast with the accent is at least 4.5:1, else whichever of black or white contrasts more.
- `--accent-hover`: the accent mixed 14% toward black (white text) or 18% toward white (black text), so hover only ever improves text contrast.
- `--accent-ui`: the accent walked toward white (dark mode) or black (light mode) in integer steps until it has 3:1 against the worst-case surface (dark: the panel `#16171a`; light: the sunken background `#dfe1e5`). Used for focus rings, field focus borders, the spinner, the audio meter fill, the progress fill, the clipboard-invite border and the scrollbar thumb while dragging.
- `--accent-soft`: `--accent-ui` at 18% (dark) / 14% (light), for focus halos, text selection and the clipboard-invite wash.

### Neutral
- **Console Graphite** (`console-panel`): top bar, console column, join card, dialogs.
- **Console Floor** (`console-bg`) and **Sunken Floor** (`console-sunken`): window background and the deepest recess.
- **Key Face** (`key-face`) / **Key Face Hover** (`key-face-hover`): every unlit key, monogram, tag and toast.
- **Field Well** (`field-well`): inputs, the timecode window, invite code wells, progress tracks; darker than the panel so fields read as recessed.
- **Hairline** (`hairline`) and **Strong Hairline** (`hairline-strong`): panel separators and row rules; key and field borders.
- **Console Text** (`console-text`), **Console Muted** (`console-muted`), **Placeholder** (`placeholder`).
- **Light console** (`light-bg`, `light-sunken`, `light-panel`, `light-key-face`, `light-hairline`, `light-hairline-strong`, `light-text`, `light-muted`): the same roles in light mode, switched by `:root[data-mode="light"]`.
- **Monitor Wall** (`monitor-wall`), **Monitor Black** (`monitor-black`), **UMD Strip** (`umd-strip`), **UMD Line** (`umd-line`), **Wall Text** (`wall-text`), **Wall Muted** (`wall-muted`), **Wall Faint** (`wall-faint`): the equipment. Identical in both themes. Wall Faint is the unlit value on the wall: the idle tally's outline, the not-watching tally, the empty source thumbnail icon and the slate's placeholder room name.
- **Meter Off** (`meter-off` dark, `light-meter-off` light): the unlit segment of the audio meter, so the scale stays visible at zero. The meter sits on the console, not the wall, so this value follows the mode.

### Status
- **Signal OK / Warn / Danger** (`signal-ok`, `signal-warn`, `signal-danger` and their `-text` variants; light mode swaps to `#1f9d55`, `#c27c0e`, `#d1242b` with darker text values): connection status lamps, signal bars, warnings, errors and the paused (amber) state. Never used for "on air".

### Named Rules
**The One Light Rule.** The accent means "lit": on air, selected, pinned, pressed-on, focused. If an element is not in one of those states, it is not accent-coloured. No accent headings, borders on idle cards, gradients or glows.

**The Derived Accent Rule.** Never hard-code the accent or a tint of it in a component. Fills use `--accent`; anything that must be seen against the console (focus ring, field focus border, meters, spinners, thin outlines) uses `--accent-ui`, which `theme.js` guarantees at 3:1. Text on a lit fill uses `--accent-text`.

**The Equipment Stays Dark Rule.** The monitor wall, every tile, the idle and empty monitors, the output preview and their label strips keep their black and near-black values in light mode. Over video, which is always black, use white for spinners and focus outlines rather than the accent.

**The Three Wall Greys Rule.** Text and marks on the monitor wall use only `--wall-text` (read), `--wall-muted` (labels, details) and `--wall-faint` (unlit, placeholder), plus white for the single large statement on a monitor. No other greys are hard-coded on the wall.

**The Neutral Monogram Rule.** Participant monograms are neutral key faces. Colour there would be confused with the tally.

## Typography

**Display / Label Font:** Bahnschrift (with Segoe UI Variable Display, Segoe UI)
**Body Font:** Segoe UI Variable Text (with Segoe UI, system-ui)
**Mono Font:** Cascadia Mono (with Consolas), for invite links, hex values and the exclusion list

**Character:** Bahnschrift is the lettering printed on the desk: condensed, numeric, a little industrial. Segoe UI Variable carries everything an operator reads as prose, so the app feels like Windows rather than a web page.

### Hierarchy
- **Display** (600, 40px, 1.1, -0.015em, max 18ch, wraps anywhere): the room name on the start screen's session slate, white on black; while the field is empty it shows a placeholder ("Nome da sala" / "Sala do convite") in Wall Faint.
- **Headline** (600, 26px, 1.2): the "Ninguém está transmitindo" message on the empty monitor.
- **Title** (600, 20px, 1.25): the join card title and the dialog titles.
- **Panel title** (600, 16px, 1.25): console-column section heads ("Na sala", "Sua transmissão"), with a muted tabular count beside them. The room name in the top bar uses the same face at 16px; the wordmark is 700, 20px, condensed, uppercase, 0.04em.
- **Body** (400, 14px, 1.45): base text, key labels at weight 600.
- **Hint** (400, 12.5px, muted): field labels (600), helper text, participant sub-lines (12px).
- **Label strip** (700, 13px, line-height 1, 0.05em, uppercase, condensed, tabular): the source name on every UMD strip and the NO AR lamp (0.1em). The source detail on the same strip is weight 500, not uppercase.
- **Readout** (500, 13px, condensed, tabular): format specs ("1080p · 60 fps"), source details, outgoing stats, status lamps (600), stats overlay.
- **Timecode** (600, 15px, 0.02em, tabular): the on-air clock beside the NO AR lamp.
- **Slate label** (700, 13px, 0.06em, uppercase, condensed, Wall Muted): the field names on the session slate ("Você", "Conexão"); their values are Bahnschrift 500 16px in Wall Text. The slate's mode line ("Criar sala" / "Entrar com convite") is the same voice at 14px, 0.08em: a slate field whose value changes with the form, not a label decorating a heading.
- **Reactions** sit on the ramp: 20px in the reaction bar, 26px over your output preview, 40px floating over a feed.

### Named Rules
**The Printed On The Desk Rule.** Anything a broadcast desk would silkscreen or display on a readout (label strips, lamps, timecode, specs, counts, kbd caps) is Bahnschrift, condensed, with tabular numerals. Sentences and form text are Segoe UI Variable.

**The Uppercase Belongs To Equipment Rule.** Uppercase with tracking is reserved for the wordmark, the NO AR lamp, the source name on label strips and the field labels of the session slate. Section heads and titles are sentence case, and no title gets an uppercase label set above it.

## Layout

The window is a fixed app grid, not a scrolling page. The body never scrolls; only the console column, the join card and the source grid scroll.

- **Title bar:** the 48px top bar is the window's drag region (`-webkit-app-region: drag`; keys, fields, links and the on-air housing are `no-drag`). Its right padding reserves the Windows caption buttons through `env(titlebar-area-x)` / `env(titlebar-area-width)`; if the system does not report that area, a 148px fallback is reserved. Below 1180px window width, "Sair" drops its label and becomes a 34px icon key.
- **Room:** two columns, `minmax(0, 1fr) 352px`, under the 48px top bar spanning both. The console column can be collapsed from the top bar; collapsed, the grid becomes one column and the multiviewer takes the whole window. The choice is remembered per user. Left is the monitor wall (8px padding, 8px gaps, black); right is the console column, a stack of panels each `16px 16px 18px` with 12px internal gap, divided by 1px hairlines.
- **Start screen:** the same grammar with a 420px join card on the right (`22px 24px 24px` padding, 16px gap) and one idle monitor filling the wall. The idle monitor holds the session slate (40px vertical padding, `clamp(28px, 6vw, 72px)` horizontal, 22px gap): mode line, room name, a two-column field list (6px row gap, 18px column gap), then the three product facts below a 1px UMD-line rule.
- **Multiviewer:** `layout.js` picks the column count that makes each 16:9 picture as large as possible given the stage size, an 8px gap and a 30px label strip; on a near tie (within 1px) it takes fewer columns. Two feeds on a tall stage stack instead of sitting side by side.
- **Spotlight:** the pinned feed takes the full stage width on the first row; the others sit underneath in `repeat(auto-fill, minmax(220px, 1fr))`, at aspect 16 / 10.4 (picture plus strip), capped at 22vh, showing only the name and signal bars.
- **Tile container queries:** below 380px tile width the hover control bar drops the stats, mini-window and fullscreen keys and shrinks to 30px keys; overlay notices drop their icons.
- **Key grids:** action rows and format keys use equal-column grids with 6px gaps (3 columns for pause / switch / stop, 2 for formats and Entrar / Criar).
- **Dialogs:** source picker `min(980px, 100vw - 48px)`, appearance `min(540px, 100vw - 48px)`; source thumbnails in `repeat(auto-fill, minmax(210px, 1fr))` with 12px gaps.
- **Toasts:** fixed bottom right, 16px from the edges, max 380px wide.

## Elevation & Depth

Hardware depth, not floating paper. Surfaces sit flat and are separated by 1px hairlines and tonal steps (floor, panel, key face, field well). Depth appears only where a physical object would have it: keys carry a 1px top highlight and a tiny drop; fields are recessed with an inner shadow; a pressed key loses its highlight and sinks. Only dialogs and toasts actually float, and only just: a short shadow under a 1px strong-hairline border that is the real edge.

### Shadow Vocabulary
- **Key bevel** (`box-shadow: inset 0 1px 0 var(--key-highlight), 0 1px 2px var(--shadow-sm)`): every unlit key, icon key, format key, segmented thumb, Entrar / Criar choice.
- **Lit key bevel** (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 1px 3px var(--shadow-sm)`): every key filled with the accent.
- **Key pressed** (`box-shadow: inset 0 1px 3px var(--shadow-sm)`): active state.
- **Field well** (`box-shadow: inset 0 1px 2px var(--shadow-sm)`): inputs, selects, textareas, invite code wells.
- **Focus halo** (`box-shadow: inset 0 1px 2px var(--shadow-sm), 0 0 0 3px var(--accent-soft)` with border `--accent-ui`): focused fields.
- **Lift** (`box-shadow: 0 2px 6px var(--shadow-sm)`): dialogs (over a `rgba(0,0,0,0.62)` backdrop) and toasts. The border defines the edge; the shadow only separates it from what is underneath.
- **Monitor frame** (`box-shadow: inset 0 0 0 1px var(--umd-line)`, or `outline: 1px solid var(--umd-line); outline-offset: -1px`): every monitor's edge; pinned becomes `inset 0 0 0 2px var(--accent)`.

### Named Rules
**The Bevel, Not Float Rule.** Shadows describe a key's bevel or a field's recess. Panels and lists never float; only dialogs and toasts lift off the console, with the short 2px lift and their 1px border. No long, soft drop shadows.

## Shapes

Square hardware. Corners are small and graded by object: tally lamps and meter/progress bars 1px; monitors, the NO AR badge and tags 2px; monogram, tabs, kbd caps, source cards and the on-air housing 3px; keys, fields, swatches, toasts and notices 4px; the segmented control 5px; dialogs 6px. Nothing in the system is fully round except the loading spinner. Status lamps and tallies are squares (7px status lamp, 10px tile tally, 8px participant tally), never dots.

Tally states are shape, not only colour: lit = filled accent; connecting = dashed grey outline; paused = amber outline; not watching = dim grey outline; the idle and empty monitors carry an unlit or dashed tally. The audio meter is drawn as segments (5px lit, 2px gaps in the panel colour) so the unlit scale stays visible. Disclosure arrows are a drawn 6px chevron rotating 90 degrees, the same in every place.

The logo mark is a monitor outline with a filled label strip and a small square tally in the accent; `scripts/make-icon.js` draws the same mark for the app and tray icons on a graphite square (tray strip unlit until broadcasting; taskbar badge is the square on-air lamp).

## Components

### Title bar (top bar)
The console's 48px graphite strip, also the window's title bar on Windows. Left: logo mark, the 20px condensed wordmark, a 1px separator, the room name and the connection status lamp. Right: the NO AR housing, then icon keys (console toggle, sounds, appearance), the share key and the ghost "Sair", then the space Windows uses for its caption buttons, drawn by the system in `--panel` with `--text` symbols per mode. The app draws no caption keys of its own.

### Console toggle
An icon key with a drawn "sidebar" glyph (a framed rectangle with the right column ruled off) and `aria-pressed` = console visible. Pressed shows the normal key; released (console hidden) mutes the icon to the muted text colour. It is a view switch, so it never lights in the accent.

### Keys (buttons)
Hardware keys: square, bevelled, labelled in 600 weight.
- **Shape:** 4px corners, 1px strong-hairline border, 34px tall (28px small, 42px full-width big), 14px horizontal padding, 8px icon gap.
- **Unlit:** key face fill, console text; hover steps to the hover face; active sinks into the pressed shadow; disabled at 45% opacity with no bevel.
- **Lit (primary):** accent fill and border, accent text, lit bevel; hover to the derived hover colour. Used for the one action that goes on air or commits (Criar sala e entrar, Transmitir) and for every selected key.
- **Ghost:** transparent, muted text; hover shows the key face (Sair).
- **Stop / live:** an ordinary key with only its icon in danger red ("Parar transmissão", "Parar"). Stopping is never a big red key.
- **Icon key:** 34 x 34 (28 small), same bevel; on video, keys go translucent white (8%, 20% on hover) and a pressed toggle lights in the accent.

### Selection keys
Entrar / Criar, format presets, the segmented theme control, app-audio channel keys and source cards all follow one rule: the chosen one lights in the accent with accent text; the rest are unlit key faces. Format keys are 50px tall and stacked: name (600, 14px) over a Bahnschrift readout spec. The segmented control is the exception: its thumb is a raised key face, not lit.

### Inputs / Fields
- **Style:** field-well fill, 1px strong hairline, 4px corners, 36px tall, 11px padding, inner recess shadow. Labels sit above in 12.5px muted 600.
- **Focus:** border to `--accent-ui` plus a 3px `--accent-soft` halo.
- **Disabled:** 50% opacity. Selects use a drawn chevron in the muted colour. Textareas use the mono face.

### The NO AR lamp and timecode
The signature component. A 30px housing with a 3px corner and 1px accent border: left the lamp (accent fill, uppercase, 700, 0.1em tracking), right the timecode in a field-well window. Off air, the lamp stays in place but unlit (key face, muted text, strong hairline border, `--:--:--`). Paused, the lamp goes dark and only an amber outline and amber text remain. Lighting it plays a 320ms flash (`brightness(2.2) saturate(0.6)` easing to normal, `cubic-bezier(0.16, 1, 0.3, 1)`). A compact version (2px corner, 0.08em tracking) marks the broadcasting participant in the list.

### Multiviewer tile and label strip (UMD)
Each feed is a black monitor with a 2px corner and a 1px inner frame in the UMD line colour, picture on top and a label strip below. The strip is near-black with a 1px top rule: tally square, source name (uppercase, 700, 0.05em), source detail (muted, ellipsis), and signal bars plus text pushed right. Pinned: the frame becomes a 2px accent ring and the whole strip lights in the accent with the tally inverted to accent text. Controls (volume, pin, stop watching, mini window, stats, fullscreen) appear in a translucent black bar over the picture on hover or focus; reactions float above it. The same strip appears under the idle monitor ("Aguardando sessão", with the app version in Wall Muted at its right end), the empty monitor ("Sem sinal") and your own output preview ("Saída").

### Session slate
The start screen's idle monitor is a clapperboard for the session about to start, filled in live from the join form: the mode line, the room name at display size, and a definition list of "Você" and "Conexão" (local network, local network plus internet link, or the invite's host). Empty values show an em dash; an empty room name shows its placeholder in Wall Faint. Below a 1px UMD-line rule, the three product facts: value in Bahnschrift 600 16px white, explanation in 12.5px Wall Muted. Nothing on the slate is accent-coloured; it is not on air.

### Status lamps
Inline readouts in Bahnschrift 600 13px: a 7px square lamp then text. Neutral is muted at 40% lamp opacity; ok / warn / bad switch the whole readout to the status text colour with a full lamp. Signal strength uses three 3px bars (5 / 8 / 12px) instead of a lamp.

### Console rows
Participants and per-viewer outgoing stats are rows separated by 1px hairlines, not cards. The per-viewer stats ("Envio para cada pessoa") are diagnostics: they sit collapsed in a disclosure with the same drawn chevron as "Avançado", a Bahnschrift count of viewers beside the summary, and the disclosure exists only while you are sharing. A participant row is a 30px neutral monogram (Bahnschrift 700), name with its tally square when broadcasting, and a 12px muted sub-line; the on-air badge or signal readout sits on the right.

### Dialogs
Console-graphite surface, 6px corners, strong hairline border, the short lift shadow, 20px Bahnschrift titles, head and foot divided from the body by hairlines. Tabs are 30px, transparent until active, when they become a raised key face.

### Notices and toasts
Warnings and errors are 4px-cornered boxes with a soft status wash and a status-coloured border. Toasts are key-face boxes with a 7px square lamp in the accent (amber for warn, danger for error), rising 8px in 220ms.

### Keyboard caps
`kbd` is a small key: 3px corners, strong hairline with a 2px bottom border, key face fill, Bahnschrift 600 12px.

## Do's and Don'ts

### Do:
- **Do** reserve the accent for lit states: on air, selected, pinned, pressed-on, focused.
- **Do** take accent values from the derived variables: `--accent` for fills, `--accent-ui` for anything thin that must reach 3:1, `--accent-text` for text on a fill.
- **Do** keep the monitor wall, tiles and label strips black in both themes, and use white for spinners and focus outlines over video.
- **Do** frame every picture as a monitor with a label strip and a square tally, including empty and idle states.
- **Do** express state by tally shape too: filled, dashed, amber outline, dim outline.
- **Do** separate console content with 1px hairlines and tonal steps; keep keys at 4px corners with the key bevel.
- **Do** set equipment text (strips, lamps, timecode, specs, counts) in Bahnschrift condensed with tabular numerals.
- **Do** treat the top bar as the title bar: keep it draggable, mark every interactive element in it `no-drag`, and leave the caption-button area free (`env(titlebar-area-*)`, 148px fallback).
- **Do** put diagnostics (per-viewer numbers, advanced settings) in a collapsed disclosure, shown only when they apply.
- **Do** honour `prefers-reduced-motion`: animations collapse to near zero and reactions appear without rising.

### Don't:
- **Don't** use rounded cards, pill-shaped chips or circular avatars; corners stop at 6px and only the spinner is round.
- **Don't** colour participant monograms or decorate idle surfaces with the accent; it would read as a tally.
- **Don't** make "stop" a big red key; only its icon carries the danger colour.
- **Don't** use gradients, glows or RGB effects anywhere in the interface.
- **Don't** use the status green, amber or red to mean "on air"; they are for signal, pause and errors.
- **Don't** let panels or lists float with drop shadows; only dialogs and toasts lift, with the short `0 2px 6px` shadow.
- **Don't** hard-code greys on the monitor wall; use Wall Text, Wall Muted or Wall Faint.
