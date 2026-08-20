# supercomment

Drop one `<script>` in your `<head>` and you can **click any element on any page, write a comment, and send the whole context** — the element's selector and HTML, the console log, every network request, uncaught errors, and optionally a screenshot — to a backend your coding agent reads.

Built for the loop where an agent ships a page and you look at it: instead of describing the bug, you point at it.

- **Zero dependencies.** One file, ~1000 lines, no build step.
- **Loads first.** Put it at the top of `<head>` so console/network/error capture is installed before any app code runs. That's the whole point — you catch the error that happened *before* you decided to report it.
- **Optional backend.** With no endpoint, reports are copied to your clipboard as JSON. With the bundled server, each report lands as a readable Markdown file.

## Quick start

```bash
npx supercomment            # server on :4321, writes to ./.supercomment
```

Then, as the **first** thing in your page's `<head>`:

```html
<script src="http://localhost:4321/supercomment.js"
        data-endpoint="http://localhost:4321/report"></script>
```

Open your page and hit <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd>.

Try it without your own page: `npx supercomment` then open `http://localhost:4321` — the demo site has buttons that dirty each capture buffer, a live readout of what's in them, a deliberately broken pricing card to report, and a checkout flow to record.

## Three modes

The floating 💬 button opens a menu with all three; each also has a hotkey.

| Mode | Key | What it does |
| --- | --- | --- |
| **Pick an element** | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> | Click the thing that looks wrong. Carries its selector, HTML and box. |
| **Report this page** | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> | No element — just the page and its logs. |
| **Record actions** | <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd> | Capture the steps that trigger the bug, then stop and describe it. |

<kbd>Esc</kbd> closes the menu, cancels picking, or closes the panel. Hide the button with `data-button="false"`.

## Recording

Recording turns "it breaks sometimes" into a numbered reproduction. It captures clicks, typing, select changes, form submits, meaningful keys (Enter/Escape/Tab/arrows), scrolls, resizes, and navigation — including SPA route changes via `pushState`. Console, network and errors keep filling their buffers throughout, so the report lines the failing request up against the step that caused it:

```markdown
## Steps to reproduce

1. Open https://app.example.com/checkout  _(0:01)_
2. Type "ahmet@example.com" into Email  _(0:01)_
3. Choose "3 seats" in Quantity  _(0:02)_
4. Click "Apply coupon"  `form.checkout > div.formrow > button.act`  _(0:02)_
```

**What it never records:** `type="password"` fields, anything with `data-sc-mask`, and inputs whose `autocomplete` marks them as a card number, CVC or one-time code — those log as `••••••`. Ordinary keystrokes aren't logged individually either; text is read from the `input` event, so it's a step recorder, not a keylogger.

A burst of typing in one field collapses to a single step, and steps keep the timestamp of when you started typing there, so the list stays in order against the network and console entries.

## Picking what to send

Console, network, error and step entries are listed individually in the composer, each with its own checkbox. Send the one failing request and skip forty noisy logs, or drop the step where you fumbled the form. The group header toggles all of it at once, and the buffers freeze when the panel opens so the checkboxes can't drift.

## Configuration

Via `data-*` attributes on the script tag, or `window.SUPERCOMMENT_CONFIG` set **before** the script loads.

| Attribute | Default | Meaning |
| --- | --- | --- |
| `data-endpoint` | `null` | Where to POST reports. Unset ⇒ clipboard/download fallback. |
| `data-project` | `location.host` | Free-form label carried in the payload. |
| `data-hotkey` | `ctrl+shift+k` | Element-pick hotkey (`ctrl` also matches ⌘). |
| `data-pagehotkey` | `ctrl+shift+u` | Page-report hotkey. |
| `data-recordhotkey` | `ctrl+shift+y` | Start/stop recording. |
| `data-button` | `true` | Show the floating launcher. |
| `data-console` | `true` | Capture `console.*`. |
| `data-network` | `true` | Capture `fetch` + `XMLHttpRequest`. |
| `data-errors` | `true` | Capture `window.onerror` + unhandled rejections. |
| `data-bodies` | `errors` | Response bodies: `errors` \| `always` \| `never`. |
| `data-screenshot` | `ask` | `ask` (checkbox off) \| `on` (checkbox on) \| `off`. |
| `data-maxlogs` | `200` | Console ring-buffer size. |
| `data-maxnetwork` | `100` | Network ring-buffer size. |
| `data-theme` | `dark` | `dark` \| `light`. |

## JS API

```js
supercomment.pick()                 // enter element-picking mode
supercomment.menu()                 // toggle the mode menu
supercomment.open(el)               // open the panel, optionally pre-targeted
supercomment.record()               // start recording actions
supercomment.stop()                 // stop and open the composer; stop(false) to skip it
supercomment.recording()            // { since, steps } while recording, else null
supercomment.steps()                // the recorded steps so far
supercomment.report('checkout 500s') // send with no UI -> Promise<{id, via}>
supercomment.snapshot()             // { page, console, network, errors, steps } right now
supercomment.screenshot()           // Promise<dataURL>
supercomment.clear()                // empty the buffers
```

Custom transport (Sentry, your own API, a Slack webhook…):

```js
window.SUPERCOMMENT_CONFIG = {
  onSend: (payload) => fetch('/my/api', { method: 'POST', body: JSON.stringify(payload) })
};
```

## Report payload

```jsonc
{
  "id": "mt1hw9th-3rajzn",
  "type": "recording",            // or "element" / "page"
  "project": "demo",
  "createdAt": "2026-08-20T12:27:03.221Z",
  "comment": "This heading is too small.",
  "page":    { "url", "title", "viewport", "scroll", "userAgent", "language" },
  "element": { "selector", "tag", "text", "html", "attributes", "rect" },
  "steps":   [ { "type", "t", "selector", "label", "value" } ],   // from Record
  "screenshot": "data:image/jpeg;base64,…",  // stripped to a file by the server
  "console": [ { "level", "t", "at", "text" } ],
  "network": [ { "method", "url", "status", "ok", "ms", "responseBody" } ],
  "errors":  [ { "kind", "message", "source", "line", "column", "stack" } ]
}
```

## Server

`npx supercomment [--port 4321] [--dir .supercomment]`

Each report is written twice: `<id>.json` (full fidelity) and `<id>.md` (what you hand to an agent). Screenshots go to `<dir>/screenshots/`.

| Route | Purpose |
| --- | --- |
| `POST /report` | Ingest. |
| `GET /reports` | JSON summaries, newest first. |
| `GET /reports/:id` | One report (`?format=md` for Markdown). |
| `DELETE /reports/:id` | Delete one. |
| `GET /inbox.md` | **All unread reports as one Markdown doc** (`?markRead=1` to consume, `?all=1` for everything). |
| `GET /` | The demo site. |
| `GET /inbox` | Minimal HTML inbox viewer. |
| `GET /supercomment.js` | The client library. |

### Feeding an agent

The point of `/inbox.md`:

```bash
curl -s 'http://localhost:4321/inbox.md?markRead=1'
```

or just point the agent at the folder — `.supercomment/*.md` is already the format you'd want to paste.

### Selectors

Selectors stop climbing at the nearest `id`, and only add `:nth-of-type` when tag + class isn't already unique among siblings — so you get `section#specimen > div.spec.off > p.price`, not a 200-character index chain. Every generated selector is verified to resolve back to the element it describes before it's sent.

## Screenshots

Screenshots use `navigator.mediaDevices.getDisplayMedia` rather than bundling a DOM rasterizer, which keeps the library dependency-free and captures what the browser actually painted (canvas, video, cross-origin iframes and all). The cost is a browser permission prompt where you pick the tab — so the checkbox is off by default. Every report already carries the element's `outerHTML` and bounding box, which is usually enough.

Requires a secure context (`https://` or `localhost`).

## Notes

- The UI lives in a shadow root, so page CSS can't touch it and it can't touch your page.
- Buffers are fixed-size rings — long-running pages don't grow memory.
- Capture wrappers pass through to the originals and swallow their own errors; a broken report should never break your page.
- The report POST to your own endpoint is excluded from network capture (by exact URL, so a sibling route like `/reports` is still recorded).

## License

MIT
