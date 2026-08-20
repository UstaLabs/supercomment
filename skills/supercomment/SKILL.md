---
name: supercomment
description: "Use when the user reports a UI bug by pointing rather than describing — when a .supercomment/ directory exists, when a supercomment server is running, or when the user says things like 'check the comments', 'read my reports', 'what did I flag', 'see the inbox', 'I left a comment on the page'. Also use when setting supercomment up on a site so the user can click an element and send its selector, console, network, errors and reproduction steps back to you."
---

# supercomment

The user has a way to point at a broken thing in their browser instead of describing it. They click an element (or record a flow), write a sentence, and a report lands where you can read it — carrying the element's CSS selector and HTML, the console log, every network request, uncaught errors, and numbered reproduction steps.

Your job is the other half: **read those reports and fix what they point at.**

## Find the reports first

Check in this order, and stop at the first that yields something:

1. **A running server** — the richest source, because it tracks read state:
   ```bash
   curl -s 'http://localhost:4321/inbox.md?markRead=1'
   ```
   Returns every unread report as one Markdown document and marks them read, so the next call returns only what's new. If it returns `_No reports._`, there is nothing to act on — say so rather than guessing.

2. **The files on disk**, if no server is up:
   ```bash
   ls -t .supercomment/*.md | head -20
   ```
   Each `<id>.md` is a full report; `<id>.json` is the same data unabridged. Read the newest first.

3. **Pasted JSON** — the user may paste a report directly when no endpoint was configured; it falls back to their clipboard.

If none of these exist, the user hasn't set it up. Jump to **Setting it up**.

## Read a report properly

Every report has the user's sentence at the top as a blockquote. That's the complaint. Everything below it is evidence — **don't stop at the complaint**, the evidence usually names the actual bug.

| Section | What to do with it |
| --- | --- |
| **Element** | `selector` is a real CSS selector for the element. Use its classes, `id`, text and `outerHTML` to locate the component in the source — grep the class name or the visible text. `rect` tells you the rendered size, which is how you confirm a layout complaint. |
| **Steps to reproduce** | A numbered list from a recording. Follow it literally to reproduce before you theorise. Timestamps line up with the network and console entries below. |
| **Errors** | Uncaught exceptions and rejections with stacks and `file:line:column`. Usually the fastest route to the cause. |
| **Network** | Status, method, URL, timing. Failed requests carry the response body. A 404 or 500 here often *is* the bug the user described in UI terms. |
| **Console** | The app's own logging, in order. |

**The user's wording describes a symptom; the evidence names the cause.** "The button does nothing" plus a 500 on `POST /api/checkout` means fix the endpoint, not the button. Say which one you're fixing.

## Working the reports

1. Read all unread reports before changing anything — several often share one root cause.
2. For each, locate the code from the selector or the stack trace. Prefer grepping the element's class or its visible text over guessing at file names.
3. Reproduce using the recorded steps where present.
4. Fix, then verify against what the report actually claimed — if it said a request 404s, confirm the request now succeeds.
5. Report back per item, quoting the user's own sentence so they can match your answer to what they flagged.

Only mark reports read (`?markRead=1`) once you've actually read them — that flag is what stops them reappearing.

## Setting it up

If the user wants this on a site that doesn't have it:

```bash
npx supercomment            # sink on :4321, writes ./.supercomment
```

Then, as the **first** thing in the page's `<head>` — before any other script:

```html
<script src="http://localhost:4321/supercomment.js"
        data-endpoint="http://localhost:4321/report"></script>
```

Placement matters and is not stylistic. The library wraps `console`, `fetch`, `XMLHttpRequest` and the error handlers at parse time; anything loaded earlier is invisible to it, so the error that happened *before* the user decided to report it would be lost.

Add `.supercomment/` to `.gitignore`.

Then tell the user how to drive it — they need to know this or the setup is useless:

- **💬 button** (bottom-right) opens three modes, and is the only way in on mobile
- <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>K</kbd> — pick an element
- <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>U</kbd> — report the page
- <kbd>Ctrl/Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Y</kbd> — record a flow, then stop and describe it

## Things that will trip you up

- **Selectors are point-in-time.** Generated against the DOM as it was; a re-render may make one stale. Treat it as a strong hint for locating source, not as something to assert against now.
- **Values in steps are real, secrets are not.** Password fields, `data-sc-mask`, and card/CVC/OTP autocomplete fields record as `••••••`. Never treat those bullets as the literal value, and don't ask the user to paste the real one.
- **Buffers are capped** — 200 console lines, 100 requests, 50 errors by default. An old event may have rolled off.
- **Context is opt-in, so absence means nothing.** Console, network and error entries start unchecked; the user ticks what looked relevant. A report with no Network section does **not** mean no requests were made — it means they didn't attach any. If you need something that isn't there, ask them to reproduce it and tick that group, rather than concluding it didn't happen.
- **`type` tells you the shape**: `element` (they pointed at something), `page` (whole-page complaint), `recording` (has repro steps).

## Reference

Full options, payload schema and server routes: <https://github.com/UstaLabs/supercomment>
