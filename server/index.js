#!/usr/bin/env node
/**
 * supercomment server — zero-dependency report sink.
 *
 *   npx supercomment              # serve on :4321, write to ./.supercomment
 *   node server/index.js --port 4321 --dir .supercomment
 *
 * Endpoints
 *   POST   /report          accept a report -> writes <dir>/<id>.json + <dir>/<id>.md
 *   GET    /reports         list reports (JSON summaries, newest first)
 *   GET    /reports/:id     one full report (?format=md for markdown)
 *   DELETE /reports/:id     delete one
 *   GET    /inbox.md        unread reports concatenated as markdown (agent-friendly)
 *   GET    /supercomment.js serves the client library
 *   GET    /                tiny HTML inbox viewer
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const C = { purple: '\u001b[35m', red: '\u001b[31m', dim: '\u001b[90m', off: '\u001b[0m' };

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : def;
}

const PORT = parseInt(arg('port', process.env.SUPERCOMMENT_PORT || '4321'), 10);
const DIR = path.resolve(arg('dir', process.env.SUPERCOMMENT_DIR || '.supercomment'));
const SHOTS = path.join(DIR, 'screenshots');
const MAX_BODY = 12 * 1024 * 1024; // 12MB — screenshots arrive base64

fs.mkdirSync(SHOTS, { recursive: true });

const CLIENT = path.join(__dirname, '..', 'src', 'supercomment.js');

/* ---------------------------------------------------------------- */

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
}

function fence(lang, body) {
  return '```' + lang + '\n' + body + '\n```';
}

function toMarkdown(r) {
  const L = [];
  const kind = r.type === 'element' ? 'Element comment' : 'Page report';
  L.push(`# ${kind} — ${r.id}`);
  L.push('');
  L.push(`> ${String(r.comment || '').split('\n').join('\n> ')}`);
  L.push('');
  L.push('## Where');
  L.push(`- **URL:** ${r.page && r.page.url}`);
  L.push(`- **Title:** ${r.page && r.page.title}`);
  L.push(`- **When:** ${r.createdAt}`);
  if (r.page && r.page.viewport) {
    L.push(`- **Viewport:** ${r.page.viewport.w}x${r.page.viewport.h} @${r.page.viewport.dpr}x`);
  }
  if (r.page) L.push(`- **UA:** ${r.page.userAgent}`);

  if (r.element) {
    L.push('');
    L.push('## Element');
    L.push(`- **Selector:** \`${r.element.selector}\``);
    L.push(
      `- **Rect:** x=${r.element.rect.x} y=${r.element.rect.y} ${r.element.rect.w}x${r.element.rect.h}`
    );
    if (r.element.text) L.push(`- **Text:** ${r.element.text}`);
    L.push('');
    L.push(fence('html', r.element.html));
  }

  if (r.screenshotFile) {
    L.push('');
    L.push('## Screenshot');
    L.push(`![screenshot](./screenshots/${path.basename(r.screenshotFile)})`);
  }

  if (r.errors && r.errors.length) {
    L.push('');
    L.push(`## Errors (${r.errors.length})`);
    L.push(
      fence(
        'text',
        r.errors
          .map((e) => {
            let s = `[${e.kind}] ${e.message}`;
            if (e.source) s += `\n  at ${e.source}:${e.line || 0}:${e.column || 0}`;
            if (e.stack) s += `\n${e.stack}`;
            return s;
          })
          .join('\n\n')
      )
    );
  }

  if (r.network && r.network.length) {
    const failed = r.network.filter((n) => n.ok === false);
    L.push('');
    L.push(`## Network (${r.network.length} requests, ${failed.length} failed)`);
    L.push(
      fence(
        'text',
        r.network
          .map((n) => {
            const status = String(n.status == null ? '---' : n.status).padStart(3);
            let s = `${status} ${String(n.method).padEnd(6)} ${n.url}  (${n.ms == null ? '?' : n.ms + 'ms'})`;
            if (n.error) s += `\n      error: ${n.error}`;
            if (n.responseBody) s += `\n      body: ${n.responseBody.replace(/\n/g, '\n      ')}`;
            return s;
          })
          .join('\n')
      )
    );
  }

  if (r.console && r.console.length) {
    L.push('');
    L.push(`## Console (${r.console.length})`);
    L.push(
      fence(
        'text',
        r.console.map((c) => `${String(c.level).toUpperCase().padEnd(5)} ${c.text}`).join('\n')
      )
    );
  }

  L.push('');
  return L.join('\n');
}

function saveScreenshot(id, dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  const file = path.join(SHOTS, `${id}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

function listReports() {
  return fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function summary(r) {
  return {
    id: r.id,
    type: r.type,
    comment: r.comment,
    createdAt: r.createdAt,
    read: !!r.read,
    url: r.page && r.page.url,
    selector: r.element && r.element.selector,
    counts: {
      console: (r.console || []).length,
      network: (r.network || []).length,
      errors: (r.errors || []).length
    },
    screenshot: !!r.screenshotFile
  };
}

/* ---------------------------------------------------------------- */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(obj, null, 2));
}

function text(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': (type || 'text/plain') + '; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

const VIEWER_HTML = `<!doctype html><meta charset=utf-8><title>supercomment inbox</title>
<style>
body{font:14px/1.5 ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0b0b0d;color:#e4e4e7;margin:0;padding:24px}
h1{font-size:16px;color:#a78bfa;margin:0 0 16px}
.r{border:1px solid #27272a;border-radius:10px;padding:12px 14px;margin-bottom:10px;background:#131316}
.r h2{font-size:14px;margin:0 0 6px;font-weight:600}
.meta{font:11px ui-monospace,Menlo,monospace;color:#71717a;word-break:break-all}
.badge{display:inline-block;background:#27272a;border-radius:4px;padding:1px 6px;margin-right:5px;font-size:11px}
.err{background:#450a0a;color:#fca5a5}
a{color:#a78bfa}
.empty{color:#52525b}
</style>
<h1>supercomment inbox &nbsp;<a href="./" style="font-size:12px;font-weight:400">&larr; demo</a></h1><div id=list class=empty>loading&hellip;</div>
<script>
fetch('reports').then(r=>r.json()).then(rs=>{
  var el=document.getElementById('list');
  if(!rs.length){el.textContent='No reports yet. Open the demo and press Ctrl+Shift+K.';return}
  el.className='';
  el.innerHTML=rs.map(function(r){return '<div class=r>'
    +'<h2>'+String(r.comment).replace(/</g,'&lt;')+'</h2>'
    +'<div class=meta>'+(r.selector||r.type)+' &middot; '+r.url+' &middot; '+new Date(r.createdAt).toLocaleString()+'</div>'
    +'<div style=margin-top:8px>'
    +'<span class="badge'+(r.counts.errors?' err':'')+'">'+r.counts.errors+' errors</span>'
    +'<span class=badge>'+r.counts.network+' net</span>'
    +'<span class=badge>'+r.counts.console+' logs</span>'
    +(r.screenshot?'<span class=badge>&#128247;</span>':'')
    +' <a href="/reports/'+r.id+'?format=md">markdown</a> &middot; '
    +'<a href="/reports/'+r.id+'">json</a>'
    +'</div></div>'}).join('');
});
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Supercomment',
      'Access-Control-Max-Age': '86400'
    });
    return res.end();
  }

  /* --- client library --- */
  if (req.method === 'GET' && (p === '/supercomment.js' || p === '/client.js')) {
    return fs.readFile(CLIENT, (err, buf) => {
      if (err) return text(res, 404, 'client not found at ' + CLIENT);
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    });
  }

  /* --- ingest --- */
  if (req.method === 'POST' && (p === '/report' || p === '/reports')) {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) return req.destroy();
      chunks.push(c);
    });
    req.on('end', () => {
      let r;
      try {
        r = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        return json(res, 400, { error: 'invalid JSON: ' + e.message });
      }
      r.id = safeId(r.id || Date.now().toString(36));
      r.receivedAt = new Date().toISOString();
      r.read = false;

      if (r.screenshot) {
        const file = saveScreenshot(r.id, r.screenshot);
        if (file) r.screenshotFile = file;
        delete r.screenshot; // keep the stored JSON readable
      }

      const mdPath = path.join(DIR, r.id + '.md');
      fs.writeFileSync(path.join(DIR, r.id + '.json'), JSON.stringify(r, null, 2));
      fs.writeFileSync(mdPath, toMarkdown(r));

      const tag = r.type === 'element' ? (r.element && r.element.selector) || 'element' : 'page';
      const errs = (r.errors || []).length;
      console.log(
        '\n' + C.purple + '* ' + r.id + C.off + '  ' + tag +
          '\n  "' + String(r.comment).replace(/\n/g, ' ') + '"' +
          '\n  ' + (r.page && r.page.url) +
          (errs ? '  ' + C.red + errs + ' error(s)' + C.off : '') +
          '\n  -> ' + path.relative(process.cwd(), mdPath)
      );

      json(res, 201, { ok: true, id: r.id, file: mdPath });
    });
    return;
  }

  /* --- agent-friendly inbox --- */
  if (req.method === 'GET' && p === '/inbox.md') {
    const all = listReports();
    const picked = url.searchParams.get('all') === '1' ? all : all.filter((r) => !r.read);
    if (url.searchParams.get('markRead') === '1') {
      picked.forEach((r) => {
        r.read = true;
        fs.writeFileSync(path.join(DIR, r.id + '.json'), JSON.stringify(r, null, 2));
      });
    }
    if (!picked.length) return text(res, 200, '_No reports._\n', 'text/markdown');
    return text(res, 200, picked.map(toMarkdown).join('\n\n---\n\n'), 'text/markdown');
  }

  /* --- list / read / delete --- */
  if (p === '/reports' && req.method === 'GET') {
    return json(res, 200, listReports().map(summary));
  }

  const one = /^\/reports\/([a-zA-Z0-9_-]+)$/.exec(p);
  if (one) {
    const id = safeId(one[1]);
    const jf = path.join(DIR, id + '.json');
    if (!fs.existsSync(jf)) return json(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') {
      fs.unlinkSync(jf);
      try {
        fs.unlinkSync(path.join(DIR, id + '.md'));
      } catch (_) {}
      return json(res, 200, { ok: true });
    }
    const r = JSON.parse(fs.readFileSync(jf, 'utf8'));
    if (url.searchParams.get('format') === 'md') return text(res, 200, toMarkdown(r), 'text/markdown');
    return json(res, 200, r);
  }

  const shot = /^\/screenshots\/([a-zA-Z0-9_.-]+)$/.exec(p);
  if (shot && req.method === 'GET') {
    const f = path.join(SHOTS, path.basename(shot[1]));
    if (!fs.existsSync(f)) return text(res, 404, 'not found');
    res.writeHead(200, { 'Content-Type': f.endsWith('.png') ? 'image/png' : 'image/jpeg' });
    return res.end(fs.readFileSync(f));
  }

  // The demo site is the front door; the inbox viewer lives at /inbox.
  if (req.method === 'GET' && (p === '/' || p === '/demo' || p === '/demo/')) {
    const f = path.join(__dirname, '..', 'demo', 'index.html');
    if (!fs.existsSync(f)) return text(res, 200, VIEWER_HTML, 'text/html');
    return text(res, 200, fs.readFileSync(f, 'utf8'), 'text/html');
  }

  if (req.method === 'GET' && (p === '/inbox' || p === '/inbox/')) {
    return text(res, 200, VIEWER_HTML, 'text/html');
  }

  json(res, 404, {
    error: 'not found',
    try: ['POST /report', 'GET /reports', 'GET /inbox', 'GET /inbox.md', 'GET /supercomment.js', 'GET /']
  });
});

server.listen(PORT, () => {
  console.log('\n' + C.purple + ' supercomment' + C.off + ' server');
  console.log('  demo      http://localhost:' + PORT + '/');
  console.log('  inbox     http://localhost:' + PORT + '/inbox');
  console.log('  endpoint  http://localhost:' + PORT + '/report');
  console.log('  client    http://localhost:' + PORT + '/supercomment.js');
  console.log('  files     ' + DIR);
  console.log('\n  Add to your page <head>:');
  console.log(
    '  ' + C.dim + '<script src="http://localhost:' + PORT + '/supercomment.js" ' +
      'data-endpoint="http://localhost:' + PORT + '/report"></script>' + C.off + '\n'
  );
});
