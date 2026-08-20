# Changelog

All notable changes to this project are documented here.
This project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-08-20

First release.

### Added

- **Drop-in client** (`src/supercomment.js`) — one zero-dependency script tag, no build step.
  Installs console, `fetch`/`XMLHttpRequest`, `window.onerror` and unhandled-rejection capture
  at parse time so context predating the report is still available.
- **Three modes** from the floating button or a hotkey: pick an element
  (<kbd>Ctrl/Cmd+Shift+K</kbd>), report the page (<kbd>Ctrl/Cmd+Shift+U</kbd>), or record actions
  (<kbd>Ctrl/Cmd+Shift+Y</kbd>).
- **Action recording** — clicks, typing, select changes, submits, meaningful keys, scrolls, resizes
  and navigation (including `pushState`), rendered by the server as numbered reproduction steps.
  Password, `data-sc-mask` and `autocomplete` card/OTP fields are masked; text is read from the
  `input` event rather than keystrokes.
- **Per-entry picking** — console, network, error and step entries are individually selectable in
  the composer. Buffers freeze while the panel is open.
- **Screenshots** via `getDisplayMedia`, so no DOM rasterizer is bundled.
- **Optional server** (`npx supercomment`) — zero-dependency sink writing `<id>.json` and `<id>.md`
  per report, an HTML inbox, and `GET /inbox.md` for agents to read the backlog in one request.
- **Clipboard fallback** when no endpoint is configured.
- Shadow-DOM UI, fixed-size ring buffers, TypeScript definitions, and a browser-driven test suite.
