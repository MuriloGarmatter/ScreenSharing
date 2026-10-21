# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Desktop app for Windows 10/11 built with Electron (the UI is HTML/CSS/JS in a single window, plus a tray icon, notifications, and a picture-in-picture window).

## Users

A group of friends (typically 2 to 6) who play games together and already talk on Discord. They want to show each other a game, a movie, or a video with high quality, without Discord's voice leaking into the shared sound. The owner wants it to feel like a respectable, finished product ("de respeito, não qualquer coisa"), even though the audience is friends.

## Product Purpose

Telão lets one person host a room and friends join from an invite link; anyone in the room can share a screen or window with sound, and everyone watches each other's streams. Success: friends join in seconds, the stream looks sharp, the voice call never leaks into the sound, and the game keeps running smoothly while sharing or watching.

## Positioning

What Discord's screen share does not give this group:

- High quality for free: 1080p at 60 fps without paying for Nitro.
- Sound without Discord: per-app audio capture; the voice call and other excluded apps never go into the stream.
- Light while gaming: GPU compression, global shortcuts (Ctrl+Alt+T start/stop, Ctrl+Alt+P pause), stop watching a stream, auto-reduced streams when the window is hidden.
- Direct between the PCs: peer-to-peer; no third-party server stores or relays the media (the host's PC runs the signaling, optionally through a free Cloudflare tunnel).

## Operating Context

- Used alongside a running game and a Discord call; the Telão window is often behind a fullscreen game, on a second monitor, or reduced to the floating picture-in-picture window.
- Entry points: open the app and create a room (host) or join with an invite; clicking a `telao://` invite link opens the app directly in the room; a copied invite is detected on focus.
- In a room: share screen or window (quality presets, sound mode: all apps except excluded / only this window's app / only chosen apps / everything), pause, stop, switch source; watch others in a grid with spotlight, volume per person, reactions, stats, stop watching.
- Portuguese (Brazil) is the only UI language.

## Capabilities and Constraints

- Mesh WebRTC: each viewer costs the sender one encode; quality and audio controls belong to the sender.
- Per-app audio capture needs Windows 10 2004+; the Telão itself is always excluded to avoid echo.
- Invites: `https://<tunnel>.trycloudflare.com/<room>` or `http://<lan-ip>:<port>/<room>`; the host's server serves an invite web page with an "Abrir no Telão" button.
- Users can customize theme (dark / light / system) and accent color; this was requested by the owner.
- Distribution: GitHub pre-releases (installer + portable exe), private repo, files shared with friends directly.
- Open decision: the product name. The owner allowed changing everything, including the name; "Telão" stays until a new name is chosen (renaming affects the `telao://` protocol, installer, and existing invites).

## Brand Commitments

None binding. The current name, icon, and colors may all be replaced.

## Evidence on Hand

- README.md (Portuguese, detailed user guide) and the GitHub pre-releases.
- No logos, testimonials, user counts, or benchmarks exist; do not invent any.

## Product Principles

1. The game comes first: anything Telão does while a game runs must stay light and out of the way.
2. Joining and sharing take seconds, with no networking knowledge required.
3. The voice call never leaks: sound privacy is a guarantee, not a setting to discover.
4. Respect over gimmick: a finished, trustworthy tool, not a toy.
5. Plain Portuguese: say what happens, never networking jargon in the main path.
