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
    'display:none;pointer-events:none}'
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

    ui.launch = h('button', { class: 'launch', title: 'Comment (' + cfg.hotkey + ')', text: '💬', onclick: function () { startPicking(); } });

    ui.selBox = h('div', { class: 'sel' });
    ui.textarea = h('textarea', { placeholder: "What's wrong / what should change?" });
    ui.optLogs = h('input', { type: 'checkbox', checked: 'checked' });
    ui.optNet = h('input', { type: 'checkbox', checked: 'checked' });
    ui.optErr = h('input', { type: 'checkbox', checked: 'checked' });
    ui.optShot = h('input', { type: 'checkbox' });
    if (cfg.screenshot === 'on') ui.optShot.checked = true;

    ui.nLogs = h('span', { class: 'n' });
    ui.nNet = h('span', { class: 'n' });
    ui.nErr = h('span', { class: 'n' });

    ui.shot = h('img', { class: 'shot' });
    ui.msg = h('div', { class: 'msg' });
    ui.sendBtn = h('button', { class: 'send', text: 'Send', onclick: submit });
    ui.pickBtn = h('button', { class: 'ghost', text: 'Pick element', onclick: function () { closePanel(); startPicking(); } });

    var opts = h('div', { class: 'opts' }, [
      h('label', { class: 'opt' }, [ui.optLogs, h('span', { text: 'console' }), ui.nLogs]),
      h('label', { class: 'opt' }, [ui.optNet, h('span', { text: 'network' }), ui.nNet]),
      h('label', { class: 'opt' }, [ui.optErr, h('span', { text: 'errors' }), ui.nErr])
    ]);
    if (cfg.screenshot !== 'off')
      opts.appendChild(h('label', { class: 'opt' }, [ui.optShot, h('span', { text: 'screenshot' })]));

    ui.panel = h('div', { class: 'panel' + (cfg.theme === 'light' ? ' light' : '') }, [
      h('div', { class: 'head' }, [
        h('div', { class: 'dot' }),
        h('div', { class: 'title', text: 'supercomment' }),
        h('button', { class: 'x', text: '✕', onclick: closePanel })
      ]),
      h('div', { class: 'body' }, [
        ui.selBox,
        ui.textarea,
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
    if (cfg.button) ui.layer.appendChild(ui.launch);
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

  function openPanel(el) {
    target = el && el.nodeType === 1 ? el : null;
    ui.selBox.textContent = target ? cssPath(target) : location.pathname + '  (page-level report)';
    ui.textarea.value = '';
    ui.msg.textContent = '';
    ui.msg.className = 'msg';
    ui.shot.style.display = 'none';
    ui.shot.removeAttribute('src');
    ui.sendBtn.disabled = false;
    ui.sendBtn.textContent = 'Send';
    ui.nLogs.textContent = '(' + logs.items.length + ')';
    ui.nNet.textContent = '(' + network.items.length + ')';
    ui.nErr.textContent = '(' + errors.items.length + ')';
    if (errors.items.length) ui.optErr.checked = true;
    if (cfg.button) ui.launch.style.display = 'none';
    ui.panel.style.display = 'block';
    setTimeout(function () { ui.textarea.focus(); }, 30);
  }

  function closePanel() {
    ui.panel.style.display = 'none';
    if (cfg.button) ui.launch.style.display = '';
    target = null;
  }

  function buildPayload(comment, screenshot) {
    return {
      id: uid(),
      v: VERSION,
      type: target ? 'element' : 'page',
      project: cfg.project,
      createdAt: new Date().toISOString(),
      comment: comment,
      page: pageInfo(),
      element: target ? describeElement(target) : null,
      screenshot: screenshot || null,
      console: ui.optLogs.checked ? logs.all() : [],
      network: ui.optNet.checked ? network.all() : [],
      errors: ui.optErr.checked ? errors.all() : []
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
        console: opts.console === false ? [] : logs.all(),
        network: opts.network === false ? [] : network.all(),
        errors: opts.errors === false ? [] : errors.all()
      };
      target = null;
      return send(payload).then(function (r) { return { id: payload.id, via: r.via }; });
    },
    snapshot: function () {
      return { page: pageInfo(), console: logs.all(), network: network.all(), errors: errors.all() };
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
      '%c[supercomment]%c ready · ' + cfg.hotkey + ' to comment · ' + cfg.pageHotkey + ' to report' +
        (cfg.endpoint ? ' · → ' + cfg.endpoint : ' · no endpoint (clipboard fallback)'),
      'color:#8b5cf6;font-weight:bold',
      'color:inherit'
    );
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
