/*! supercomment v0.1.0 | MIT | https://github.com/UstaLabs/supercomment#readme */
/*!
 * supercomment v0.1.0 — drop-in page commenting + context capture
 * https://github.com/AhmetHuseyinDOK/supercomment
 *
 * Put this FIRST in <head> so console/network/error capture starts before
 * anything else runs:
 *
 *   <script src="/supercomment.js" data-endpoint="http://localhost:4321/report"></script>
 *
 * Hotkeys: Ctrl/Cmd+Shift+K  pick an element and comment
 *          Ctrl/Cmd+Shift+U  page-level report (no element)
 *          Esc               cancel
 *
 * MIT licensed. Zero dependencies.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined' || window.__supercomment) return;

  var VERSION = '0.1.0';
  var HOST_ID = 'supercomment-root';

  /* ------------------------------------------------------------------ *
   * Config
   * ------------------------------------------------------------------ */

  var script =
    document.currentScript ||
    (function () {
      var all = document.querySelectorAll('script[src*="supercomment"]');
      return all[all.length - 1] || null;
    })();

  function dataAttrs(el) {
    var out = {};
    if (!el || !el.dataset) return out;
    var map = {
      endpoint: 'endpoint',
      project: 'project',
      hotkey: 'hotkey',
      pagehotkey: 'pageHotkey',
      recordhotkey: 'recordHotkey',
      button: 'button',
      console: 'captureConsole',
      network: 'captureNetwork',
      errors: 'captureErrors',
      bodies: 'captureBodies',
      screenshot: 'screenshot',
      maxlogs: 'maxLogs',
      maxnetwork: 'maxNetwork',
      theme: 'theme'
    };
    for (var k in el.dataset) {
      if (!Object.prototype.hasOwnProperty.call(map, k.toLowerCase())) continue;
      var v = el.dataset[k];
      if (v === 'true') v = true;
      else if (v === 'false') v = false;
      else if (/^\d+$/.test(v)) v = parseInt(v, 10);
      out[map[k.toLowerCase()]] = v;
    }
    return out;
  }

  var cfg = assign(
    {
      endpoint: null, // POST target. null => clipboard/console fallback
      project: location.host || 'local',
      hotkey: 'ctrl+shift+k',
      pageHotkey: 'ctrl+shift+u',
      recordHotkey: 'ctrl+shift+y',
      button: true, // floating launcher button
      captureConsole: true,
      captureNetwork: true,
      captureErrors: true,
      captureBodies: 'errors', // 'errors' | 'always' | 'never'
      screenshot: 'ask', // 'ask' (checkbox, off) | 'on' (checkbox, on) | 'off'
      maxLogs: 200,
      maxNetwork: 100,
      maxErrors: 50,
      maxBody: 2000,
      theme: 'dark',
      onSend: null // optional (payload) => Promise|void, overrides transport
    },
    dataAttrs(script),
    window.SUPERCOMMENT_CONFIG || {}
  );

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  }

  /* ------------------------------------------------------------------ *
   * Buffers + capture (installed immediately, before page scripts run)
   * ------------------------------------------------------------------ */

  function Ring(max) {
    this.max = max;
    this.items = [];
  }
  Ring.prototype.push = function (item) {
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
  };
  Ring.prototype.all = function () {
    return this.items.slice();
  };
  Ring.prototype.clear = function () {
    this.items.length = 0;
  };

  var logs = new Ring(cfg.maxLogs);
  var network = new Ring(cfg.maxNetwork);
  var errors = new Ring(cfg.maxErrors);

  var t0 = Date.now();
  function now() {
    return Date.now();
  }
  function since() {
    return Date.now() - t0;
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + '…[' + (s.length - n) + ' more chars]' : s;
  }

  function stringifyArg(a, depth) {
    depth = depth || 0;
    try {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      var t = typeof a;
      if (t === 'string') return a;
      if (t === 'number' || t === 'boolean' || t === 'bigint') return String(a);
      if (t === 'function') return '[Function ' + (a.name || 'anonymous') + ']';
      if (t === 'symbol') return a.toString();
      if (a instanceof Error) return (a.stack || a.name + ': ' + a.message);
      if (typeof Element !== 'undefined' && a instanceof Element)
        return '<' + a.tagName.toLowerCase() + (a.id ? '#' + a.id : '') + '>';
      if (depth > 2) return '[Object]';
      var seen = [];
      return JSON.stringify(a, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.indexOf(v) !== -1) return '[Circular]';
          seen.push(v);
        }
        if (typeof v === 'function') return '[Function]';
        if (typeof v === 'bigint') return String(v);
        return v;
      });
    } catch (e) {
      try {
        return String(a);
      } catch (e2) {
        return '[Unserializable]';
      }
    }
  }

  function formatArgs(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) parts.push(stringifyArg(args[i]));
    return truncate(parts.join(' '), 4000);
  }

  // --- console ---
  var nativeConsole = {};
  if (cfg.captureConsole && window.console) {
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var orig = console[level];
      if (typeof orig !== 'function') return;
      nativeConsole[level] = orig.bind(console);
      console[level] = function () {
        try {
          logs.push({ level: level, t: since(), at: new Date().toISOString(), text: formatArgs(arguments) });
        } catch (e) {
          /* never break the page */
        }
        return orig.apply(console, arguments);
      };
    });
  }
  function rawLog() {
    (nativeConsole.log || console.log).apply(console, arguments);
  }

  // --- errors ---
  if (cfg.captureErrors) {
    window.addEventListener(
      'error',
      function (e) {
        try {
          if (e.target && e.target !== window && e.target.tagName) {
            // resource load failure (img/script/link)
            errors.push({
              kind: 'resource',
              t: since(),
              at: new Date().toISOString(),
              message: 'Failed to load ' + e.target.tagName.toLowerCase(),
              source: e.target.src || e.target.href || ''
            });
            return;
          }
          errors.push({
            kind: 'error',
            t: since(),
            at: new Date().toISOString(),
            message: e.message,
            source: e.filename,
            line: e.lineno,
            column: e.colno,
            stack: e.error && e.error.stack ? truncate(e.error.stack, 3000) : null
          });
        } catch (_) {}
      },
      true
    );

    window.addEventListener('unhandledrejection', function (e) {
      try {
        var r = e.reason;
        errors.push({
          kind: 'unhandledrejection',
          t: since(),
          at: new Date().toISOString(),
          message: r && r.message ? r.message : stringifyArg(r),
          stack: r && r.stack ? truncate(r.stack, 3000) : null
        });
      } catch (_) {}
    });
  }

  // --- network ---
  var endpointAbs = null;
  try {
    if (cfg.endpoint) endpointAbs = new URL(cfg.endpoint, location.href).href;
  } catch (_) {
    endpointAbs = cfg.endpoint;
  }

  // Exact URL match only — a prefix test would swallow sibling routes
  // (endpoint "/report" must not hide the app's own "/reports" calls).
  function isOwnRequest(url) {
    if (!endpointAbs) return false;
    try {
      return new URL(String(url), location.href).href === endpointAbs;
    } catch (_) {
      return String(url) === cfg.endpoint;
    }
  }

  function shouldCaptureBody(ok) {
    if (cfg.captureBodies === 'always') return true;
    if (cfg.captureBodies === 'never') return false;
    return !ok; // 'errors'
  }

  if (cfg.captureNetwork && window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (isOwnRequest(url)) return nativeFetch.apply(this, arguments);

      var start = now();
      var entry = {
        kind: 'fetch',
        method: method,
        url: url,
        t: since(),
        at: new Date().toISOString(),
        status: null,
        ok: null,
        ms: null
      };
      if (init && init.body && cfg.captureBodies === 'always') {
        try {
          entry.requestBody = truncate(typeof init.body === 'string' ? init.body : '[non-string body]', cfg.maxBody);
        } catch (_) {}
      }
      network.push(entry);

      return nativeFetch.apply(this, arguments).then(
        function (res) {
          entry.status = res.status;
          entry.ok = res.ok;
          entry.ms = now() - start;
          if (shouldCaptureBody(res.ok)) {
            try {
              res
                .clone()
                .text()
                .then(function (txt) {
                  entry.responseBody = truncate(txt, cfg.maxBody);
                })
                .catch(function () {});
            } catch (_) {}
          }
          return res;
        },
        function (err) {
          entry.ok = false;
          entry.ms = now() - start;
          entry.error = err && err.message ? err.message : String(err);
          throw err;
        }
      );
    };
  }

  if (cfg.captureNetwork && window.XMLHttpRequest) {
    var XHR = window.XMLHttpRequest.prototype;
    var origOpen = XHR.open;
    var origSend = XHR.send;
    XHR.open = function (method, url) {
      this.__sc = { method: String(method || 'GET').toUpperCase(), url: String(url) };
      return origOpen.apply(this, arguments);
    };
    XHR.send = function (body) {
      var self = this;
      var meta = this.__sc;
      if (meta && !isOwnRequest(meta.url)) {
        var start = now();
        var entry = {
          kind: 'xhr',
          method: meta.method,
          url: meta.url,
          t: since(),
          at: new Date().toISOString(),
          status: null,
          ok: null,
          ms: null
        };
        if (body && cfg.captureBodies === 'always') {
          try {
            entry.requestBody = truncate(typeof body === 'string' ? body : '[non-string body]', cfg.maxBody);
          } catch (_) {}
        }
        network.push(entry);
        this.addEventListener('loadend', function () {
          entry.status = self.status;
          entry.ok = self.status >= 200 && self.status < 400;
          entry.ms = now() - start;
          if (shouldCaptureBody(entry.ok)) {
            try {
              if (self.responseType === '' || self.responseType === 'text')
                entry.responseBody = truncate(self.responseText, cfg.maxBody);
            } catch (_) {}
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------------------ *
   * Action recorder — turns "it breaks sometimes" into repro steps
   * ------------------------------------------------------------------ */

  var rec = { active: false, startedAt: 0, steps: [], lastScrollAt: 0, timer: null };

  // Direct text only — a <label> containing a badge shouldn't read "Card masked".
  function ownText(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) out += el.childNodes[i].nodeValue;
    }
    return out.trim().replace(/\s+/g, ' ');
  }

  // A form control is named by its <label>, never by its own content — the
  // innerText of a <select> is every option concatenated together.
  function fieldLabel(el) {
    if (el.id) {
      try {
        var l = document.querySelector('label[for="' + esc(el.id) + '"]');
        if (l) {
          var t = ownText(l) || truncate((l.innerText || '').trim().replace(/\s+/g, ' '), 60);
          if (t) return truncate(t, 60);
        }
      } catch (_) {}
    }
    var wrap = el.closest ? el.closest('label') : null;
    if (wrap) {
      var wt = ownText(wrap);
      if (wt) return truncate(wt, 60);
    }
    return truncate(
      el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('placeholder') || el.tagName.toLowerCase(),
      60
    );
  }

  function labelFor(el) {
    if (!el || el.nodeType !== 1) return '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)) return fieldLabel(el);
    var t = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (!t) t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
    return truncate(t, 60);
  }

  // Never record a secret. Password fields, opt-in data-sc-mask, and anything
  // autocomplete says is a card or one-time code.
  function isMasked(el) {
    if (!el.getAttribute) return false;
    if ((el.getAttribute('type') || '').toLowerCase() === 'password') return true;
    if (el.hasAttribute('data-sc-mask')) return true;
    return /cc-|credit|card|cvc|cvv|one-time|otp/.test((el.getAttribute('autocomplete') || '').toLowerCase());
  }

  function step(s) {
    if (!rec.active) return;
    s.t = since();
    s.at = new Date().toISOString();
    rec.steps.push(s);
    if (rec.steps.length > 500) rec.steps.shift();
    paintRecPill();
  }

  function stepText(s) {
    switch (s.type) {
      case 'click':
        return 'Click ' + (s.label ? '"' + s.label + '"' : '<' + s.tag + '>');
      case 'input':
        return 'Type "' + s.value + '" into ' + (s.label || s.selector);
      case 'select':
        return 'Choose "' + s.value + '" in ' + (s.label || s.selector);
      case 'key':
        return 'Press ' + s.key;
      case 'scroll':
        return 'Scroll to y=' + s.y;
      case 'submit':
        return 'Submit ' + (s.selector || 'form');
      case 'navigate':
        return 'Open ' + s.url;
      case 'resize':
        return 'Resize to ' + s.w + 'x' + s.h;
    }
    return s.type;
  }

  var STEP_TAG = { click: 'CLK', input: 'TYPE', select: 'PICK', key: 'KEY', scroll: 'SCRL', submit: 'SUB', navigate: 'NAV', resize: 'SIZE' };

  function onRecClick(e) {
    var el = e.target;
    if (!el || el === host || el.nodeType !== 1) return;
    step({ type: 'click', selector: cssPath(el), tag: el.tagName.toLowerCase(), label: labelFor(el) });
  }

  function onRecInput(e) {
    var el = e.target;
    if (!el || el === host || el.nodeType !== 1 || el.value === undefined) return;
    var sel = cssPath(el);
    var kind = el.tagName === 'SELECT' ? 'select' : 'input';
    var value = isMasked(el) ? '\u2022\u2022\u2022\u2022\u2022\u2022' : truncate(String(el.value), 120);

    // Collapse a burst of keystrokes in one field into a single step. Scrolls
    // and resizes don't interrupt — an autoscroll landing mid-word must not
    // split "ahmet@example.com" in two — but a real action does. Blur fires
    // 'change' after 'input' with an unchanged value; that's a duplicate.
    var sawAction = false;
    for (var i = rec.steps.length - 1; i >= 0 && i > rec.steps.length - 12; i--) {
      var st = rec.steps[i];
      if (st.type === 'scroll' || st.type === 'resize') continue;
      if (st.type === kind && st.selector === sel) {
        if (st.value === value) return; // nothing actually changed
        if (!sawAction) {
          // keep the original timestamp: it's when the user started typing
          // here, and bumping it forward would put the step list out of
          // chronological order against the network and console entries.
          st.value = value;
          paintRecPill();
          return;
        }
        break; // genuinely edited again later in the flow
      }
      sawAction = true;
    }
    step({ type: kind, selector: sel, label: labelFor(el), value: value });
  }

  var RECORDED_KEYS = ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
  function onRecKey(e) {
    if (RECORDED_KEYS.indexOf(e.key) === -1) return; // not a keylogger — text arrives via 'input'
    if (e.target === host) return;
    step({ type: 'key', key: e.key, selector: e.target && e.target.nodeType === 1 ? cssPath(e.target) : null });
  }

  function onRecScroll() {
    var n = now();
    if (n - rec.lastScrollAt < 500) return;
    rec.lastScrollAt = n;
    step({ type: 'scroll', y: Math.round(window.scrollY), x: Math.round(window.scrollX) });
  }

  function onRecSubmit(e) {
    step({ type: 'submit', selector: e.target && e.target.nodeType === 1 ? cssPath(e.target) : null });
  }

  function onRecNav() {
    step({ type: 'navigate', url: location.href });
  }

  function onRecResize() {
    var n = now();
    if (n - (rec.lastResizeAt || 0) < 500) return;
    rec.lastResizeAt = n;
    step({ type: 'resize', w: window.innerWidth, h: window.innerHeight });
  }

  // SPA route changes look like navigation to a human, so record them as such.
  if (window.history && history.pushState) {
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var out = orig.apply(this, arguments);
        onRecNav();
        return out;
      };
    });
  }

  var REC_EVENTS = [
    [document, 'click', onRecClick, true],
    [document, 'input', onRecInput, true],
    [document, 'change', onRecInput, true],
    [document, 'keydown', onRecKey, true],
    [document, 'submit', onRecSubmit, true],
    [window, 'scroll', onRecScroll, true],
    [window, 'resize', onRecResize, false],
    [window, 'hashchange', onRecNav, false],
    [window, 'popstate', onRecNav, false]
  ];

  function startRecording() {
    if (rec.active) return;
    closeMenu();
    stopPicking();
    closePanel();
    rec.active = true;
    rec.startedAt = now();
    rec.steps = [];
    step({ type: 'navigate', url: location.href });
    REC_EVENTS.forEach(function (e) { e[0].addEventListener(e[1], e[2], e[3]); });
    ui.launch.classList.add('rec');
    ui.launch.textContent = '\u25A0';
    ui.launch.title = 'Stop recording';
    ui.recPill.style.display = 'flex';
    rec.timer = setInterval(paintRecPill, 1000);
    paintRecPill();
    toast('Recording. Reproduce the bug, then press stop.', 3200);
  }

  function stopRecording(openComposer) {
    if (!rec.active) return;
    rec.active = false;
    clearInterval(rec.timer);
    REC_EVENTS.forEach(function (e) { e[0].removeEventListener(e[1], e[2], e[3]); });
    ui.launch.classList.remove('rec');
    ui.launch.textContent = '\uD83D\uDCAC';
    ui.launch.title = 'Comment (' + cfg.hotkey + ')';
    ui.recPill.style.display = 'none';
    if (openComposer !== false) openPanel(null, { recording: true });
  }

  function recElapsed() {
    var sec = Math.floor((now() - rec.startedAt) / 1000);
    return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2);
  }

  function paintRecPill() {
    if (!ui.recPill || !rec.active) return;
    ui.recCount.textContent = recElapsed() + ' \u00B7 ' + rec.steps.length + ' step' + (rec.steps.length === 1 ? '' : 's');
  }

  /* ------------------------------------------------------------------ *
   * Element description
   * ------------------------------------------------------------------ */

  function esc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    var path = [];
    var node = el;
    while (node && node.nodeType === 1 && path.length < 8) {
      var sel = node.nodeName.toLowerCase();
      if (node.id) {
        path.unshift(sel + '#' + esc(node.id));
        break;
      }
      var cls = (node.getAttribute('class') || '')
        .trim()
        .split(/\s+/)
        .filter(function (c) {
          return c && c.length < 30 && !/^(sc-|css-)/.test(c);
        })
        .slice(0, 2);
      if (cls.length) sel += '.' + cls.map(esc).join('.');

      // Only disambiguate with :nth-of-type when tag+class isn't already
      // unique among siblings — an unconditional index makes every selector
      // unreadable for the human and the agent reading the report.
      var parent = node.parentElement;
      if (parent) {
        var ambiguous = true;
        try {
          ambiguous = parent.querySelectorAll(':scope > ' + sel).length > 1;
        } catch (_) {
          ambiguous = true;
        }
        if (ambiguous) {
          var sib = node,
            nth = 1;
          while ((sib = sib.previousElementSibling)) if (sib.nodeName === node.nodeName) nth++;
          sel += ':nth-of-type(' + nth + ')';
        }
      }
      path.unshift(sel);
      node = parent;
    }

    var out = path.join(' > ');
    // A selector that doesn't resolve back to this element is worse than a
    // vague one — fall back to something honest.
    try {
      if (document.querySelector(out) !== el) {
        var alt = el.id ? el.nodeName.toLowerCase() + '#' + esc(el.id) : null;
        if (alt && document.querySelector(alt) === el) return alt;
      }
    } catch (_) {}
    return out;
  }

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return null;
    var r = el.getBoundingClientRect();
    var attrs = {};
    for (var i = 0; i < el.attributes.length && i < 25; i++) {
      var a = el.attributes[i];
      attrs[a.name] = truncate(a.value, 200);
    }
    return {
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: el.getAttribute('class') || null,
      text: truncate((el.innerText || el.textContent || '').trim().replace(/\s+/g, ' '), 300),
      html: truncate(el.outerHTML, 3000),
      attributes: attrs,
      rect: {
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height)
      }
    };
  }

  function pageInfo() {
    return {
      url: location.href,
      path: location.pathname,
      title: document.title,
      referrer: document.referrer || null,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      userAgent: navigator.userAgent,
      language: navigator.language
    };
  }

  /* ------------------------------------------------------------------ *
   * Screenshot (getDisplayMedia — no third-party rasterizer)
   * ------------------------------------------------------------------ */

  function captureScreenshot() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia)
      return Promise.reject(new Error('getDisplayMedia unsupported in this browser'));

    var stream;
    return navigator.mediaDevices
      .getDisplayMedia({ video: { displaySurface: 'browser' }, audio: false, preferCurrentTab: true })
      .then(function (s) {
        stream = s;
        var video = document.createElement('video');
        video.srcObject = s;
        video.muted = true;
        return video.play().then(function () {
          return new Promise(function (res) {
            setTimeout(function () {
              res(video);
            }, 180);
          });
        });
      })
      .then(function (video) {
        var canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        return canvas.toDataURL('image/jpeg', 0.8);
      })
      .then(
        function (data) {
          if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
          return data;
        },
        function (err) {
          if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
          throw err;
        }
      );
  }

  /* ------------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------------ */

  function uid() {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function send(payload) {
    if (typeof cfg.onSend === 'function') {
      return Promise.resolve(cfg.onSend(payload)).then(function () {
        return { via: 'onSend' };
      });
    }
    if (!cfg.endpoint) return fallback(payload);

    var f = nativeFetchRef() || window.fetch;
    return f.call(window, cfg.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Supercomment': VERSION },
      body: JSON.stringify(payload),
      mode: 'cors',
      credentials: 'omit'
    }).then(function (res) {
      if (!res.ok) throw new Error('endpoint returned ' + res.status);
      return { via: 'endpoint' };
    });
  }

  function nativeFetchRef() {
    return typeof nativeFetch !== 'undefined' ? nativeFetch : null;
  }

  function fallback(payload) {
    rawLog('%c[supercomment] report (no endpoint configured)', 'color:#8b5cf6;font-weight:bold', payload);
    var text = JSON.stringify(payload, null, 2);
    var p = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText(text).then(function () { return { via: 'clipboard' }; })
      : Promise.reject(new Error('no clipboard'));
    return p.catch(function () {
      try {
        var blob = new Blob([text], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'supercomment-' + payload.id + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        return { via: 'download' };
      } catch (e) {
        return { via: 'console' };
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * UI (shadow DOM so page styles can never touch it)
   * ------------------------------------------------------------------ */

  var host, root, ui = {};
  var picking = false;
  var target = null;
  var pins = [];

  var CSS_TEXT = [
    ':host,*{box-sizing:border-box}',
    '.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;',
    "font:13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}",
    '.hl{position:fixed;border:2px solid #8b5cf6;background:rgba(139,92,246,.14);border-radius:3px;',
    'pointer-events:none;transition:all .05s linear;display:none}',
    '.tag{position:fixed;background:#8b5cf6;color:#fff;font-size:11px;padding:2px 6px;border-radius:4px;',
    'white-space:nowrap;pointer-events:none;display:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
    '.hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:#18181b;color:#fafafa;',
    'padding:8px 14px;border-radius:999px;box-shadow:0 8px 30px rgba(0,0,0,.35);display:none;',
    'pointer-events:none;border:1px solid #3f3f46}',
    '.hint b{color:#a78bfa}',
    '.launch{position:fixed;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;border:none;',
    'background:#8b5cf6;color:#fff;font-size:19px;cursor:pointer;pointer-events:auto;',
    'box-shadow:0 6px 22px rgba(139,92,246,.45);display:flex;align-items:center;justify-content:center;',
    'transition:transform .12s ease}',
    '.launch:hover{transform:scale(1.08)}',
    '.panel{position:fixed;right:18px;bottom:18px;width:360px;max-width:calc(100vw - 36px);',
    'background:#18181b;color:#e4e4e7;border:1px solid #3f3f46;border-radius:12px;',
    'box-shadow:0 20px 60px rgba(0,0,0,.5);pointer-events:auto;display:none;overflow:hidden}',
    '.panel.light{background:#fff;color:#18181b;border-color:#e4e4e7}',
    '.head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #3f3f46}',
    '.panel.light .head{border-color:#e4e4e7}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#8b5cf6;flex:none}',
    '.title{font-weight:600;font-size:13px;flex:1}',
    '.x{background:none;border:none;color:inherit;opacity:.6;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}',
    '.x:hover{opacity:1}',
    '.body{padding:12px}',
    '.sel{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#a78bfa;',
    'background:rgba(139,92,246,.12);padding:5px 8px;border-radius:6px;margin-bottom:9px;',
    'word-break:break-all;max-height:56px;overflow:auto}',
    'textarea{width:100%;min-height:82px;resize:vertical;background:#27272a;color:inherit;',
    'border:1px solid #3f3f46;border-radius:8px;padding:9px;font:inherit;outline:none}',
    '.panel.light textarea{background:#f4f4f5;border-color:#e4e4e7}',
    'textarea:focus{border-color:#8b5cf6}',
    '.opts{display:flex;flex-wrap:wrap;gap:9px;margin:10px 0 12px}',
    '.opt{display:flex;align-items:center;gap:5px;font-size:11.5px;opacity:.85;cursor:pointer;user-select:none}',
    '.opt input{accent-color:#8b5cf6;margin:0;cursor:pointer}',
    '.opt .n{opacity:.55;font-family:ui-monospace,Menlo,monospace}',
    '.row{display:flex;gap:8px;align-items:center}',
    '.send{flex:1;background:#8b5cf6;color:#fff;border:none;border-radius:8px;padding:9px 14px;',
    'font:600 13px/1 inherit;cursor:pointer}',
    '.send:hover{background:#7c3aed}.send:disabled{opacity:.5;cursor:default}',
    '.ghost{background:none;border:1px solid #3f3f46;color:inherit;border-radius:8px;padding:9px 12px;',
    'font:13px/1 inherit;cursor:pointer}',
    '.panel.light .ghost{border-color:#e4e4e7}',
    '.ghost:hover{border-color:#8b5cf6}',
    '.msg{font-size:11.5px;margin-top:9px;min-height:15px;opacity:.8}',
    '.msg.err{color:#f87171}.msg.ok{color:#4ade80}',
    '.shot{margin-top:9px;border-radius:6px;border:1px solid #3f3f46;max-width:100%;display:none}',
    '.pin{position:absolute;width:22px;height:22px;border-radius:50% 50% 50% 2px;background:#8b5cf6;',
    'color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;',
    'pointer-events:auto;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
    '.pins{position:absolute;inset:0;pointer-events:none}',
    '.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#18181b;color:#fafafa;',
    'border:1px solid #3f3f46;padding:9px 16px;border-radius:8px;box-shadow:0 8px 30px rgba(0,0,0,.4);',
    'display:none;pointer-events:none}',

    /* FAB mode menu */
    /* the menu must set its own color, not inherit: nothing up the shadow
       tree defines one, so `inherit` resolves to the UA default black. */
    '.menu{position:fixed;right:18px;bottom:72px;width:236px;background:#18181b;color:#fafafa;',
    'border:1px solid #3f3f46;border-radius:12px;padding:5px;display:none;pointer-events:auto;',
    'box-shadow:0 18px 50px rgba(0,0,0,.5)}',
    '.menu.light{background:#fff;color:#18181b;border-color:#e4e4e7}',
    '.menu.light .mi small{color:#71717a}',
    '.mi{display:flex;gap:10px;align-items:flex-start;width:100%;background:none;border:none;color:inherit;',
    "font:inherit;text-align:left;padding:9px 10px;border-radius:8px;cursor:pointer}",
    '.mi:hover{background:#27272a}',
    '.menu.light .mi:hover{background:#f4f4f5}',
    '.mi .ico{flex:none;width:18px;text-align:center;font-size:13px;line-height:1.5}',
    '.mi .tt{flex:1}',
    '.mi b{display:block;font-weight:600;font-size:12.5px}',
    '.mi small{display:block;color:#a1a1aa;font-size:11px;line-height:1.35;margin-top:1px}',
    '.mi .kb{flex:none;font:10.5px/1.6 ui-monospace,Menlo,monospace;color:#71717a}',

    /* recording state */
    '.launch.rec{background:#ef4444;box-shadow:0 6px 22px rgba(239,68,68,.5);font-size:14px}',
    '.recpill{position:fixed;right:72px;bottom:26px;display:none;align-items:center;gap:7px;',
    'background:#18181b;color:#fafafa;border:1px solid #ef4444;padding:7px 12px;border-radius:999px;',
    "font:600 12px/1 ui-monospace,Menlo,monospace;pointer-events:auto;cursor:pointer;",
    'box-shadow:0 8px 26px rgba(0,0,0,.4);white-space:nowrap}',
    '.recpill .rdot{width:8px;height:8px;border-radius:50%;background:#ef4444;flex:none}',
    '@media (prefers-reduced-motion:no-preference){',
    '.recpill .rdot{animation:scblink 1.4s ease-in-out infinite}}',
    '@keyframes scblink{0%,100%{opacity:1}50%{opacity:.25}}',

    /* pickable capture groups */
    '.grp{border:1px solid #3f3f46;border-radius:8px;margin-bottom:7px;overflow:hidden}',
    '.panel.light .grp{border-color:#e4e4e7}',
    '.ghead{display:flex;align-items:center;gap:8px;padding:7px 9px;cursor:pointer;user-select:none}',
    '.ghead:hover{background:#212125}',
    '.panel.light .ghead:hover{background:#f4f4f5}',
    '.ghead input{accent-color:#8b5cf6;margin:0;cursor:pointer;flex:none}',
    '.ghead .gname{font-size:12px;font-weight:500}',
    '.ghead .cnt{margin-left:auto;font:10.5px/1 ui-monospace,Menlo,monospace;color:#a1a1aa}',
    '.ghead .car{font-size:8px;color:#71717a;transition:transform .15s;flex:none;width:8px}',
    '.grp.open .car{transform:rotate(90deg)}',
    '.grp.empty{opacity:.45}',
    '.glist{display:none;max-height:148px;overflow:auto;padding:3px;border-top:1px solid #3f3f46}',
    '.panel.light .glist{border-color:#e4e4e7}',
    '.grp.open .glist{display:block}',
    '.gi{display:flex;gap:7px;align-items:flex-start;padding:4px 5px;border-radius:5px;cursor:pointer}',
    '.gi:hover{background:#27272a}',
    '.panel.light .gi:hover{background:#f4f4f5}',
    '.gi input{accent-color:#8b5cf6;margin:2px 0 0;flex:none;cursor:pointer}',
    '.gi .lv{flex:none;font:700 9px/1.7 ui-monospace,Menlo,monospace;padding:0 4px;border-radius:3px;',
    'background:#3f3f46;color:#a1a1aa;min-width:31px;text-align:center}',
    '.gi .lv.err{background:#450a0a;color:#fca5a5}',
    '.gi .lv.ok{background:#052e16;color:#86efac}',
    '.gi .lv.warn{background:#422006;color:#fcd34d}',
    '.gi .lv.acc{background:rgba(139,92,246,.2);color:#c4b5fd}',
    '.gi .tx{flex:1;min-width:0;font:11px/1.5 ui-monospace,Menlo,monospace;color:#d4d4d8;',
    'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.panel.light .gi .tx{color:#3f3f46}'
  ].join('');

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'class') el.className = attrs[k];
      else if (k === 'text') el.textContent = attrs[k];
      else if (k === 'html') el.innerHTML = attrs[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), attrs[k]);
      else el.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  function buildUI() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-supercomment', VERSION);
    root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    root.appendChild(h('style', { text: CSS_TEXT }));

    ui.layer = h('div', { class: 'layer' });
    ui.hl = h('div', { class: 'hl' });
    ui.tag = h('div', { class: 'tag' });
    ui.hint = h('div', {
      class: 'hint',
      html: 'Click any element to comment · <b>Esc</b> to cancel'
    });
    ui.pins = h('div', { class: 'pins' });
    ui.toast = h('div', { class: 'toast' });

    ui.launch = h('button', {
      class: 'launch',
      title: 'Comment (' + cfg.hotkey + ')',
      text: '\uD83D\uDCAC',
      onclick: function () {
        if (rec.active) return stopRecording();
        toggleMenu();
      }
    });

    ui.recCount = h('span', { text: '0:00' });
    ui.recPill = h('div', {
      class: 'recpill',
      title: 'Stop recording',
      onclick: function () { stopRecording(); }
    }, [h('span', { class: 'rdot' }), ui.recCount, h('span', { text: '\u00B7 stop' })]);

    ui.menu = h('div', { class: 'menu' + (cfg.theme === 'light' ? ' light' : '') }, [
      menuItem('\u25CE', 'Pick an element', 'Click the thing that looks wrong', cfg.hotkey, function () {
        closeMenu();
        startPicking();
      }),
      menuItem('\u270E', 'Report this page', 'No element \u2014 just the page and its logs', cfg.pageHotkey, function () {
        closeMenu();
        openPanel(null);
      }),
      menuItem('\u25CF', 'Record actions', 'Capture the steps that trigger it', cfg.recordHotkey, function () {
        startRecording();
      })
    ]);

    ui.selBox = h('div', { class: 'sel' });
    ui.textarea = h('textarea', { placeholder: "What's wrong / what should change?" });
    ui.optShot = h('input', { type: 'checkbox' });
    if (cfg.screenshot === 'on') ui.optShot.checked = true;

    ui.groupBox = h('div', {});
    ui.shot = h('img', { class: 'shot' });
    ui.msg = h('div', { class: 'msg' });
    ui.sendBtn = h('button', { class: 'send', text: 'Send', onclick: submit });
    ui.pickBtn = h('button', { class: 'ghost', text: 'Pick element', onclick: function () { closePanel(); startPicking(); } });

    var opts = h('div', { class: 'opts' });
    if (cfg.screenshot !== 'off')
      opts.appendChild(h('label', { class: 'opt' }, [ui.optShot, h('span', { text: 'attach screenshot' })]));

    ui.panel = h('div', { class: 'panel' + (cfg.theme === 'light' ? ' light' : '') }, [
      h('div', { class: 'head' }, [
        h('div', { class: 'dot' }),
        h('div', { class: 'title', text: 'supercomment' }),
        h('button', { class: 'x', text: '✕', onclick: closePanel })
      ]),
      h('div', { class: 'body' }, [
        ui.selBox,
        ui.textarea,
        ui.groupBox,
        opts,
        h('div', { class: 'row' }, [ui.sendBtn, ui.pickBtn]),
        ui.shot,
        ui.msg
      ])
    ]);

    ui.layer.appendChild(ui.pins);
    ui.layer.appendChild(ui.hl);
    ui.layer.appendChild(ui.tag);
    ui.layer.appendChild(ui.hint);
    ui.layer.appendChild(ui.toast);
    if (cfg.button) {
      ui.layer.appendChild(ui.launch);
      ui.layer.appendChild(ui.menu);
    }
    ui.layer.appendChild(ui.recPill);
    ui.layer.appendChild(ui.panel);
    root.appendChild(ui.layer);

    (document.body || document.documentElement).appendChild(host);
  }

  function toast(text, ms) {
    ui.toast.textContent = text;
    ui.toast.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { ui.toast.style.display = 'none'; }, ms || 2200);
  }

  function menuItem(icon, title, sub, key, onclick) {
    return h('button', { class: 'mi', onclick: onclick }, [
      h('span', { class: 'ico', text: icon }),
      h('span', { class: 'tt' }, [h('b', { text: title }), h('small', { text: sub })]),
      h('span', { class: 'kb', text: shortKey(key) })
    ]);
  }

  function shortKey(spec) {
    if (!spec) return '';
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    return String(spec)
      .split('+')
      .map(function (p) {
        if (p === 'ctrl' || p === 'cmd' || p === 'mod') return mac ? '\u2318' : 'Ctrl';
        if (p === 'shift') return '\u21E7';
        if (p === 'alt') return mac ? '\u2325' : 'Alt';
        return p.toUpperCase();
      })
      .join(mac ? '' : '+');
  }

  function openMenu() {
    if (!ui.menu) return;
    ui.menu.style.display = 'block';
    document.addEventListener('click', onOutsideMenu, true);
  }

  function closeMenu() {
    if (!ui.menu) return;
    ui.menu.style.display = 'none';
    document.removeEventListener('click', onOutsideMenu, true);
  }

  function menuOpen() {
    return !!(ui.menu && ui.menu.style.display === 'block');
  }

  function toggleMenu() {
    menuOpen() ? closeMenu() : openMenu();
  }

  function onOutsideMenu(e) {
    if (e.target !== host) closeMenu(); // events from our shadow root retarget to the host
  }

  /* ---------------- picking ---------------- */

  var cursorStyle = null;

  function startPicking() {
    if (picking) return;
    closePanel();
    picking = true;
    ui.hint.style.display = 'block';
    if (cfg.button) ui.launch.style.display = 'none';
    cursorStyle = document.createElement('style');
    cursorStyle.textContent = '*{cursor:crosshair !important}';
    document.head.appendChild(cursorStyle);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onPick, true);
    document.addEventListener('scroll', onMoveRefresh, true);
  }

  function stopPicking() {
    if (!picking) return;
    picking = false;
    ui.hint.style.display = 'none';
    ui.hl.style.display = 'none';
    ui.tag.style.display = 'none';
    if (cfg.button) ui.launch.style.display = '';
    if (cursorStyle && cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle);
    cursorStyle = null;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onPick, true);
    document.removeEventListener('scroll', onMoveRefresh, true);
  }

  var lastHover = null;

  function onMove(e) {
    var el = e.target;
    if (!el || el === host || el.nodeType !== 1) return;
    lastHover = el;
    highlight(el);
  }

  function onMoveRefresh() {
    if (lastHover) highlight(lastHover);
  }

  function highlight(el) {
    var r = el.getBoundingClientRect();
    ui.hl.style.display = 'block';
    ui.hl.style.left = r.left + 'px';
    ui.hl.style.top = r.top + 'px';
    ui.hl.style.width = r.width + 'px';
    ui.hl.style.height = r.height + 'px';
    var label = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    ui.tag.textContent = label;
    ui.tag.style.display = 'block';
    var top = r.top > 24 ? r.top - 22 : r.bottom + 4;
    ui.tag.style.left = Math.max(4, r.left) + 'px';
    ui.tag.style.top = top + 'px';
  }

  function onPick(e) {
    if (e.target === host) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    stopPicking();
    openPanel(el);
  }

  /* ---------------- panel ---------------- */

  // Each capture group is a list of individually selectable entries. The
  // buffers are frozen when the panel opens so indices can't shift underneath
  // the checkboxes while you're deciding what to send.
  var groups = {};

  function makeGroup(key, name, items, render, openByDefault) {
    var boxes = [];
    var master = h('input', { type: 'checkbox', checked: 'checked' });
    var list = h('div', { class: 'glist' });

    items.forEach(function (item, i) {
      var meta = render(item);
      var cb = h('input', { type: 'checkbox', checked: 'checked' });
      cb.addEventListener('change', function () {
        master.checked = boxes.some(function (b) { return b.checked; });
      });
      boxes.push(cb);
      list.appendChild(
        h('label', { class: 'gi' }, [
          cb,
          h('span', { class: 'lv ' + (meta.cls || ''), text: meta.tag }),
          h('span', { class: 'tx', text: meta.text, title: meta.text })
        ])
      );
      void i;
    });

    var grp = h('div', { class: 'grp' + (items.length ? '' : ' empty') + (openByDefault && items.length ? ' open' : '') });
    var head = h('div', { class: 'ghead' }, [
      master,
      h('span', { class: 'car', text: '\u25B6' }),
      h('span', { class: 'gname', text: name }),
      h('span', { class: 'cnt', text: items.length ? items.length + ' captured' : 'none' })
    ]);

    master.addEventListener('click', function (e) { e.stopPropagation(); });
    master.addEventListener('change', function () {
      boxes.forEach(function (b) { b.checked = master.checked; });
    });
    head.addEventListener('click', function () {
      if (items.length) grp.classList.toggle('open');
    });

    grp.appendChild(head);
    grp.appendChild(list);

    return {
      el: grp,
      pick: function () {
        return items.filter(function (_, i) { return boxes[i].checked; });
      }
    };
  }

  function netMeta(n) {
    return {
      cls: n.status == null ? 'warn' : n.ok ? 'ok' : 'err',
      tag: n.status == null ? '\u00B7\u00B7\u00B7' : String(n.status),
      text: n.method + ' ' + n.url + (n.ms == null ? '' : '  ' + n.ms + 'ms')
    };
  }

  function openPanel(el, opts) {
    opts = opts || {};
    closeMenu();
    target = el && el.nodeType === 1 ? el : null;

    ui.selBox.textContent = target
      ? cssPath(target)
      : opts.recording
      ? rec.steps.length + ' recorded steps on ' + location.pathname
      : location.pathname + '  (page-level report)';

    ui.textarea.value = '';
    ui.textarea.placeholder = opts.recording
      ? 'What went wrong during those steps?'
      : "What's wrong / what should change?";
    ui.msg.textContent = '';
    ui.msg.className = 'msg';
    ui.shot.style.display = 'none';
    ui.shot.removeAttribute('src');
    ui.sendBtn.disabled = false;
    ui.sendBtn.textContent = 'Send';

    // freeze the buffers for the life of this panel
    groups = {};
    ui.groupBox.innerHTML = '';
    if (opts.recording || rec.steps.length) {
      groups.steps = makeGroup('steps', 'Steps', rec.steps.slice(), function (st) {
        return { cls: 'acc', tag: STEP_TAG[st.type] || 'STEP', text: stepText(st) };
      }, !!opts.recording);
      ui.groupBox.appendChild(groups.steps.el);
    }
    groups.errors = makeGroup('errors', 'Errors', errors.all(), function (e) {
      return { cls: 'err', tag: 'ERR', text: e.message };
    }, errors.items.length > 0 && !opts.recording);
    groups.network = makeGroup('network', 'Network', network.all(), netMeta, false);
    groups.console = makeGroup('console', 'Console', logs.all(), function (c) {
      return {
        cls: c.level === 'error' ? 'err' : c.level === 'warn' ? 'warn' : '',
        tag: c.level.slice(0, 4).toUpperCase(),
        text: c.text
      };
    }, false);
    [groups.errors, groups.network, groups.console].forEach(function (g) {
      ui.groupBox.appendChild(g.el);
    });

    if (cfg.button) {
      ui.launch.style.display = 'none';
      closeMenu();
    }
    ui.panel.style.display = 'block';
    setTimeout(function () { ui.textarea.focus(); }, 30);
  }

  function closePanel() {
    ui.panel.style.display = 'none';
    if (cfg.button && !rec.active) ui.launch.style.display = '';
    target = null;
  }

  function buildPayload(comment, screenshot) {
    var steps = groups.steps ? groups.steps.pick() : [];
    return {
      id: uid(),
      v: VERSION,
      type: steps.length ? 'recording' : target ? 'element' : 'page',
      project: cfg.project,
      createdAt: new Date().toISOString(),
      comment: comment,
      page: pageInfo(),
      element: target ? describeElement(target) : null,
      screenshot: screenshot || null,
      steps: steps,
      console: groups.console ? groups.console.pick() : [],
      network: groups.network ? groups.network.pick() : [],
      errors: groups.errors ? groups.errors.pick() : []
    };
  }

  function submit() {
    var comment = ui.textarea.value.trim();
    if (!comment) {
      ui.msg.className = 'msg err';
      ui.msg.textContent = 'Write something first.';
      ui.textarea.focus();
      return;
    }
    ui.sendBtn.disabled = true;
    ui.sendBtn.textContent = 'Sending…';
    ui.msg.className = 'msg';
    ui.msg.textContent = '';

    var shotPromise = Promise.resolve(null);
    if (ui.optShot.checked && cfg.screenshot !== 'off') {
      ui.msg.textContent = 'Pick this tab in the screen-share dialog…';
      ui.panel.style.visibility = 'hidden';
      shotPromise = captureScreenshot()
        .then(function (d) {
          ui.panel.style.visibility = '';
          return d;
        })
        .catch(function (err) {
          ui.panel.style.visibility = '';
          ui.msg.className = 'msg err';
          ui.msg.textContent = 'Screenshot skipped: ' + err.message;
          return null;
        });
    }

    var pinTarget = target;

    shotPromise
      .then(function (shot) {
        var payload = buildPayload(comment, shot);
        return send(payload).then(function (res) {
          return { payload: payload, res: res };
        });
      })
      .then(function (out) {
        if (pinTarget) addPin(pinTarget, out.payload);
        closePanel();
        toast(
          out.res.via === 'endpoint'
            ? '✓ Sent to ' + cfg.endpoint
            : out.res.via === 'clipboard'
            ? '✓ Copied report to clipboard'
            : out.res.via === 'download'
            ? '✓ Report downloaded'
            : '✓ Report captured'
        );
      })
      .catch(function (err) {
        ui.sendBtn.disabled = false;
        ui.sendBtn.textContent = 'Send';
        ui.msg.className = 'msg err';
        ui.msg.textContent = 'Failed: ' + (err && err.message ? err.message : String(err));
      });
  }

  /* ---------------- pins ---------------- */

  function addPin(el, payload) {
    var n = pins.length + 1;
    var dot = h('div', {
      class: 'pin',
      text: String(n),
      title: payload.comment,
      onclick: function (e) {
        e.stopPropagation();
        toast('#' + n + ' — ' + payload.comment, 4000);
      }
    });
    ui.pins.appendChild(dot);
    var pin = { el: el, dot: dot, payload: payload };
    pins.push(pin);
    positionPins();
  }

  function positionPins() {
    pins.forEach(function (p) {
      if (!p.el.isConnected) {
        p.dot.style.display = 'none';
        return;
      }
      var r = p.el.getBoundingClientRect();
      p.dot.style.display = 'flex';
      p.dot.style.left = Math.max(0, r.left - 6) + 'px';
      p.dot.style.top = Math.max(0, r.top - 6) + 'px';
      p.dot.style.position = 'fixed';
    });
  }
  window.addEventListener('scroll', positionPins, true);
  window.addEventListener('resize', positionPins);

  /* ---------------- hotkeys ---------------- */

  function matchHotkey(e, spec) {
    var parts = String(spec).toLowerCase().split('+');
    var key = parts[parts.length - 1];
    var need = { ctrl: false, shift: false, alt: false, meta: false };
    parts.slice(0, -1).forEach(function (p) {
      if (p === 'ctrl' || p === 'cmd' || p === 'mod') { need.ctrl = true; need.meta = true; }
      else if (p === 'shift') need.shift = true;
      else if (p === 'alt' || p === 'option') need.alt = true;
    });
    var modOk = need.ctrl || need.meta ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
    if (!modOk) return false;
    if (need.shift !== e.shiftKey) return false;
    if (need.alt !== e.altKey) return false;
    return String(e.key || '').toLowerCase() === key;
  }

  document.addEventListener(
    'keydown',
    function (e) {
      if (e.key === 'Escape') {
        if (menuOpen()) { closeMenu(); return; }
        if (picking) { stopPicking(); return; }
        if (ui.panel && ui.panel.style.display === 'block') { closePanel(); return; }
      }
      if (matchHotkey(e, cfg.hotkey)) {
        e.preventDefault();
        picking ? stopPicking() : startPicking();
      } else if (matchHotkey(e, cfg.pageHotkey)) {
        e.preventDefault();
        stopPicking();
        openPanel(null);
      } else if (cfg.recordHotkey && matchHotkey(e, cfg.recordHotkey)) {
        e.preventDefault();
        rec.active ? stopRecording() : startRecording();
      }
    },
    true
  );

  /* ------------------------------------------------------------------ *
   * Public API + boot
   * ------------------------------------------------------------------ */

  var api = {
    version: VERSION,
    config: cfg,
    open: function (el) { openPanel(el || null); },
    pick: startPicking,
    cancel: stopPicking,
    menu: function () { toggleMenu(); },
    record: startRecording,
    stop: function (openComposer) { stopRecording(openComposer); },
    recording: function () {
      return rec.active ? { since: rec.startedAt, steps: rec.steps.length } : null;
    },
    steps: function () { return rec.steps.slice(); },
    /** Send a report programmatically, no UI. */
    report: function (comment, opts) {
      opts = opts || {};
      target = opts.element || null;
      var payload = {
        id: uid(),
        v: VERSION,
        type: opts.element ? 'element' : 'page',
        project: cfg.project,
        createdAt: new Date().toISOString(),
        comment: comment,
        page: pageInfo(),
        element: opts.element ? describeElement(opts.element) : null,
        screenshot: opts.screenshot || null,
        steps: opts.steps === false ? [] : rec.steps.slice(),
        console: opts.console === false ? [] : logs.all(),
        network: opts.network === false ? [] : network.all(),
        errors: opts.errors === false ? [] : errors.all()
      };
      target = null;
      return send(payload).then(function (r) { return { id: payload.id, via: r.via }; });
    },
    snapshot: function () {
      return {
        page: pageInfo(),
        console: logs.all(),
        network: network.all(),
        errors: errors.all(),
        steps: rec.steps.slice()
      };
    },
    screenshot: captureScreenshot,
    clear: function () { logs.clear(); network.clear(); errors.clear(); }
  };

  window.supercomment = api;
  window.__supercomment = true;

  function boot() {
    if (document.getElementById(HOST_ID)) return;
    buildUI();
    rawLog(
      '%c[supercomment]%c ready · ' + cfg.hotkey + ' pick · ' + cfg.pageHotkey + ' report · ' + cfg.recordHotkey + ' record' +
        (cfg.endpoint ? ' · → ' + cfg.endpoint : ' · no endpoint (clipboard fallback)'),
      'color:#8b5cf6;font-weight:bold',
      'color:inherit'
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
