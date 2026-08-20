#!/usr/bin/env node
/**
 * End-to-end test: boots the real server, drives a real Chrome against the
 * demo page, and asserts on what lands on disk.
 *
 *   npm test
 *   CHROME=/path/to/chrome npm test
 *
 * Every bug this library has shipped so far was found by driving it in a
 * browser rather than by reading the code, so the test suite does the same.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const PORT = Number(process.env.PORT || 4399);
const BASE = `http://127.0.0.1:${PORT}`;

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  ];
  return candidates.find((p) => fs.existsSync(p));
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
}

async function waitForServer(tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/reports');
      if (r.ok) return true;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome found. Set CHROME=/path/to/chrome.');
    process.exit(2);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercomment-test-'));
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), '--port', String(PORT), '--dir', dir], {
    stdio: 'ignore'
  });

  let browser;
  try {
    if (!(await waitForServer())) throw new Error('server never came up on ' + BASE);

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: 'new',
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const failedRequests = [];
    page.on('requestfailed', (r) => failedRequests.push(r.url()));

    const resp = await page.goto(BASE, { waitUntil: 'networkidle0' });
    check('demo page serves', resp.status() === 200, 'HTTP ' + resp.status());

    const boot = await page.evaluate(() => ({
      api: typeof window.supercomment,
      version: window.supercomment && window.supercomment.version,
      host: !!document.getElementById('supercomment-root')
    }));
    check('client boots and mounts', boot.api === 'object' && boot.host, 'v' + boot.version);

    const pkgVersion = require('../package.json').version;
    check('client version matches package', boot.version === pkgVersion, `${boot.version} vs ${pkgVersion}`);

    /* ---- capture buffers ---- */
    await page.evaluate(() => {
      noise();
      notFound();
      boom();
    });
    await new Promise((r) => setTimeout(r, 700));
    const snap = await page.evaluate(() => window.supercomment.snapshot());
    check('console captured', snap.console.length >= 3, snap.console.length + ' entries');
    check('failed request captured', snap.network.some((n) => n.ok === false), JSON.stringify(snap.network.map((n) => n.status)));
    check('uncaught error captured', snap.errors.length >= 1, (snap.errors[0] || {}).message);

    /* ---- mode menu ---- */
    await page.evaluate(() => document.getElementById('supercomment-root').shadowRoot.querySelector('.launch').click());
    await new Promise((r) => setTimeout(r, 200));
    const menu = await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      const titles = Array.from(root.querySelectorAll('.mi b'));
      return {
        open: root.querySelector('.menu').style.display === 'block',
        titles: titles.map((e) => e.textContent),
        colors: titles.map((e) => getComputedStyle(e).color)
      };
    });
    check('menu offers three modes', menu.open && menu.titles.length === 3, menu.titles.join(' / '));
    // regression: .menu had a background but no color, so titles inherited black
    check('menu titles are legible', menu.colors.every((c) => c === 'rgb(250, 250, 250)'), menu.colors[0]);

    /* ---- element picking ---- */
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.supercomment.pick());
    await page.click('.spec.off .price');
    await new Promise((r) => setTimeout(r, 250));
    const picked = await page.evaluate(
      () => document.getElementById('supercomment-root').shadowRoot.querySelector('.sel').textContent
    );
    check('picks the clicked element', /div\.spec\.off/.test(picked), picked);
    // regression: :nth-of-type was appended at every level
    check('selector stays readable', !/nth-of-type/.test(picked) && picked.length < 90, picked.length + ' chars');

    const unique = await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      const box = root.querySelector('.sel');
      const els = Array.from(document.querySelectorAll('body *')).filter((e) => !e.closest('#supercomment-root'));
      let hit = 0;
      for (const el of els) {
        window.supercomment.open(el);
        try {
          if (document.querySelector(box.textContent) === el) hit++;
        } catch (_) {}
      }
      return { total: els.length, hit };
    });
    check('every selector resolves to its element', unique.hit === unique.total, `${unique.hit}/${unique.total}`);
    await page.keyboard.press('Escape');

    /* ---- recording ---- */
    await page.evaluate(() => window.supercomment.record());
    await page.type('#email', 'ahmet@example.com', { delay: 5 });
    await page.select('#qty', '3 seats');
    await page.type('#coupon', 'LAUNCH20', { delay: 5 });
    await page.type('#card', '4242424242424242', { delay: 3 });
    await page.click('button[onclick="applyCoupon()"]');
    await new Promise((r) => setTimeout(r, 500));
    await page.click('button[type="submit"]');
    await new Promise((r) => setTimeout(r, 500));

    const steps = await page.evaluate(() => window.supercomment.steps());
    check('records the flow', steps.length >= 6, steps.length + ' steps');
    check('masks card numbers', steps.some((s) => s.value === '••••••'), 'card field');
    // regression: an autoscroll mid-word split typing into two steps
    const emailSteps = steps.filter((s) => s.type === 'input' && /email/i.test(s.label || ''));
    check('collapses a typing burst', emailSteps.length === 1, emailSteps.map((s) => s.value).join(' | '));
    // regression: <select> was labelled with every option concatenated
    const sel = steps.find((s) => s.type === 'select');
    check('labels controls by their <label>', sel && sel.label === 'Quantity', sel && sel.label);
    // regression: collapsing a burst bumped its timestamp past later steps
    const ts = steps.map((s) => s.t);
    check('step timestamps stay ordered', ts.every((v, i) => i === 0 || v >= ts[i - 1]), ts.join(','));

    await page.evaluate(() => window.supercomment.stop());
    await new Promise((r) => setTimeout(r, 300));

    const groups = await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      return Array.from(root.querySelectorAll('.grp')).map((g) => g.querySelector('.gname').textContent);
    });
    check('composer lists every capture group', groups.join(',') === 'Steps,Errors,Network,Console', groups.join(','));

    /* ---- per-entry picking + send ---- */
    // captured context is opt-in; recorded steps are the exception
    const defaults = await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      const out = {};
      Array.from(root.querySelectorAll('.grp')).forEach((g) => {
        const name = g.querySelector('.gname').textContent;
        const boxes = Array.from(g.querySelectorAll('.gi input'));
        out[name] = { total: boxes.length, checked: boxes.filter((b) => b.checked).length };
      });
      return out;
    });
    check('context groups start unchecked',
      defaults.Console.checked === 0 && defaults.Network.checked === 0 && defaults.Errors.checked === 0,
      `console ${defaults.Console.checked}/${defaults.Console.total}, ` +
        `network ${defaults.Network.checked}/${defaults.Network.total}, ` +
        `errors ${defaults.Errors.checked}/${defaults.Errors.total}`);
    check('recorded steps start checked',
      defaults.Steps.total > 0 && defaults.Steps.checked === defaults.Steps.total,
      `${defaults.Steps.checked}/${defaults.Steps.total}`);

    // opt two console lines in, leave the rest out
    const consoleTotal = await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      const grp = Array.from(root.querySelectorAll('.grp')).find((g) => g.querySelector('.gname').textContent === 'Console');
      grp.classList.add('open');
      const boxes = grp.querySelectorAll('.gi input');
      boxes[0].click();
      boxes[1].click();
      return boxes.length;
    });
    await page.evaluate(() => {
      const root = document.getElementById('supercomment-root').shadowRoot;
      root.querySelector('textarea').value = 'Coupon 404s and Pay throws instead of surfacing the error.';
      root.querySelector('.send').click();
    });
    await new Promise((r) => setTimeout(r, 1200));

    const list = await (await fetch(BASE + '/reports')).json();
    const latest = list[0];
    check('report reaches the server', !!latest, latest && latest.id);
    check('typed as a recording', latest && latest.type === 'recording', latest && latest.type);
    check('sends only what was ticked', latest && latest.counts.console === 2,
      latest && `${latest.counts.console} of ${consoleTotal} console entries`);
    check('omits untouched groups', latest && latest.counts.network === 0 && latest.counts.errors === 0,
      latest && `network ${latest.counts.network}, errors ${latest.counts.errors}`);

    const md = await (await fetch(`${BASE}/reports/${latest.id}?format=md`)).text();
    check('markdown carries repro steps', /## Steps to reproduce/.test(md), (md.match(/^\d+\. /gm) || []).length + ' numbered');
    check('markdown never leaks the card', !/4242/.test(md), /4242/.test(md) ? 'LEAKED' : 'clean');

    /* ---- agent skill ---- */
    const skillRes = await fetch(BASE + '/skill.md');
    const skillBody = await skillRes.text();
    check('server exposes the agent skill', skillRes.ok && /^---\nname: supercomment/.test(skillBody),
      skillBody.length + ' bytes');

    const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supercomment-skill-'));
    const run = (args) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js'), ...args], {
          cwd: skillDir,
          stdio: 'ignore'
        });
        c.on('exit', (code) => resolve(code));
      });

    const installed = await run(['install-skill']);
    const skillPath = path.join(skillDir, '.claude', 'skills', 'supercomment', 'SKILL.md');
    check('install-skill writes the skill', installed === 0 && fs.existsSync(skillPath), 'exit ' + installed);
    check('installed skill matches the source',
      fs.existsSync(skillPath) &&
        fs.readFileSync(skillPath, 'utf8') ===
          fs.readFileSync(path.join(__dirname, '..', 'skills', 'supercomment', 'SKILL.md'), 'utf8'),
      'byte-identical');
    const second = await run(['install-skill']);
    check('install-skill refuses to clobber', second === 1, 'exit ' + second);
    const forced = await run(['install-skill', '--force']);
    check('install-skill --force overwrites', forced === 0, 'exit ' + forced);
    fs.rmSync(skillDir, { recursive: true, force: true });

    /* ---- inbox ---- */
    const inbox = await (await fetch(BASE + '/inbox.md?markRead=1')).text();
    check('inbox returns unread reports', /## Steps to reproduce/.test(inbox), inbox.length + ' bytes');
    const empty = await (await fetch(BASE + '/inbox.md')).text();
    check('markRead consumes the inbox', /No reports/.test(empty), empty.trim());

    check('no failed asset requests', failedRequests.length === 0, failedRequests.join(', ') || 'none');
  } catch (err) {
    check('harness completed', false, err.message);
  } finally {
    if (browser) await browser.close();
    server.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
