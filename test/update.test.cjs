// MovieBox Pro app update prompt (src/65-update.js, docs/ARCHITECTURE.md sections 4 and 10): the TizenBrew service's
// ws://127.0.0.1:8081/mbp-update channel is faked with page.routeWebSocket; the page looks like Tizen (a Tizen user
// agent plus a minimal window.tizen whose exit() is recorded). Standalone: node test/update.test.cjs [title filter...]
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('./helpers.cjs');
const K = require('./app.test.cjs');

const WS = 'ws://127.0.0.1:8081/mbp-update';
const SHA = 'ab'.repeat(32);
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIZEN_STUB = `window.tizen = { application: { getCurrentApplication: function () {
  return { exit: function () { window.__exitCalls = (window.__exitCalls || 0) + 1; } };
} } };`;
const SHOTS = process.env.UPDATE_SHOTS || '';

const filters = process.argv.slice(2).map(s => s.toLowerCase());
const { test, run } = H.makeRunner('update');
let site, browser, O;

function reply(extra) {
  return Object.assign({ ok: true, installed: '2.0.6', running: '2.0.6', latest: '2.0.6', available: false, notes: '', size: 0, sha256: '', busy: null, last: null }, extra || {});
}
const AVAILABLE = reply({ latest: '2.0.7', available: true, notes: 'Faster start.\nFixes the player on Tizen 9.', size: 928653, sha256: SHA });

// The fake service. script(msg, ws, page) answers each client message; page.sent records them all, page.sockets counts
// connections. opts.refuse closes every connection at once; opts.silent never answers.
async function service(page, script, opts = {}) {
  page.sent = [];
  page.sockets = 0;
  await page.routeWebSocket(WS, ws => {
    page.sockets++;
    if (opts.refuse) { ws.close({ code: 1011, reason: 'refused' }); return; }
    ws.onMessage(m => {
      let msg = null;
      try { msg = JSON.parse(String(m)); } catch (e) { msg = { raw: String(m) }; }
      page.sent.push(msg);
      if (!opts.silent && script) script(msg, obj => ws.send(JSON.stringify(obj)), ws);
    });
  });
}

function checkOnly(payload) {
  return (msg, send) => { if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload }); };
}

function flow(title, opts, fn) {
  if (filters.length && !filters.some(f => title.toLowerCase().indexOf(f) >= 0)) return;
  test(title, async () => {
    const page = await K.openApp(browser, O, { path: null, ua: opts.ua });
    if (opts.tizen !== false) await page.context_.addInitScript({ content: TIZEN_STUB });
    if (opts.clock) await page.clock.install();
    page.wsSeen = [];
    page.on('websocket', w => page.wsSeen.push(w.url()));
    try {
      if (opts.service !== false) await service(page, opts.script, opts);
      await page.goto(O + '/');
      await K.waitScreen(page, 'home');
      await K.waitFocus(page);
      await fn(page);
      const errs = page.errors.filter(e => !/WebSocket/.test(e));
      if (errs.length) await K.fail(page, 'Uncaught page errors or Log.error output:\n    ' + errs.slice(0, 4).join('\n    '));
    } finally {
      await K.closeApp(page);
    }
  });
}

const dialogState = page => page.evaluate(() => {
  const d = document.querySelector('#mbptv [data-dialog="update"]');
  const r = document.getElementById('mbptv');
  const f = document.querySelector('#mbptv .is-focused');
  return {
    open: !!d,
    layer: r ? r.getAttribute('data-layer') : null,
    text: d ? d.textContent.replace(/\s+/g, ' ').trim() : '',
    actions: d ? Array.prototype.map.call(d.querySelectorAll('[data-action]'), b => b.getAttribute('data-action')) : [],
    focus: f ? f.getAttribute('data-action') || f.getAttribute('data-fk') || '' : '',
    focusActive: !!f && f === document.activeElement,
    focusInDialog: !!f && !!d && d.contains(f)
  };
});

async function waitDialog(page, what, test, timeout = 9000) {
  await K.waitUntil(page, what, t => {
    const d = document.querySelector('#mbptv [data-dialog="update"]');
    if (!d) return false;
    return !t || d.textContent.replace(/\s+/g, ' ').indexOf(t) >= 0;
  }, test || '', timeout);
  return dialogState(page);
}

const noDialog = async page => assert.strictEqual((await dialogState(page)).open, false, 'no update dialog');
const toast = page => page.evaluate(() => { const t = document.getElementById('mbptv-toast'); return t ? t.textContent : ''; });

async function waitSent(page, type, timeout = 9000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const m = (page.sent || []).find(x => x.type === type);
    if (m) return m;
    await page.waitForTimeout(60);
  }
  throw new Error('No ' + type + ' was sent; sent: ' + JSON.stringify(page.sent));
}

flow('no update: the check is sent once, nothing is shown, Diagnostics says up to date', { script: checkOnly(reply()) }, async page => {
  await waitSent(page, 'CheckAppUpdate');
  await page.waitForTimeout(1200);
  await noDialog(page);
  assert.strictEqual(page.sent.length, 1);
  await K.press(page, 'ArrowDown');
  const st = await page.evaluate(() => window.__mbptv.App.state());
  assert.strictEqual(st.layer, '');
  const facts = await page.evaluate(() => window.__mbptv.Log.entries().filter(e => e.label === 'update').map(e => e.msg).join(' | '));
  assert.ok(/reply ok installed 2\.0\.6/.test(facts), facts);
  await page.evaluate(() => window.__mbptv.App.push('diagnostics', {}));
  await K.waitScreen(page, 'diagnostics');
  const row = await page.evaluate(() => {
    const ks = Array.prototype.filter.call(document.querySelectorAll('#mbptv .mb-fact'), f => /App update/.test(f.textContent));
    return ks.length ? ks[0].textContent : '';
  });
  assert.ok(/Up to date \(2\.0\.6\)/.test(row), row);
});

flow('update available: dialog with Later focused; Later closes, sends nothing and is not asked again this launch', { script: checkOnly(AVAILABLE) }, async page => {
  const d = await waitDialog(page, 'the update dialog');
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, 'update-prompt.png') }); }
  assert.strictEqual(d.layer, 'dialog');
  assert.ok(d.text.indexOf('MovieBox Pro app update') >= 0, d.text);
  assert.ok(d.text.indexOf('Version 2.0.7 is available. You have 2.0.6.') >= 0, d.text);
  assert.ok(d.text.indexOf('Faster start.') >= 0, d.text);
  assert.ok(d.text.indexOf('The app closes while it installs. Open it again afterwards.') >= 0, d.text);
  assert.deepStrictEqual(d.actions, ['update-install', 'update-later']);
  assert.strictEqual(d.focus, 'update-later');
  assert.ok(d.focusActive, 'Later is document.activeElement');
  // The notes are text, never markup, and clipped to three lines.
  const clamp = await page.evaluate(() => getComputedStyle(document.querySelector('#mbptv .mb-update-notes')).webkitLineClamp);
  assert.strictEqual(String(clamp), '3');
  await K.press(page, 'Enter', 1, 300);
  await noDialog(page);
  assert.strictEqual(page.sent.filter(m => m.type === 'InstallAppUpdate').length, 0);
  const f = await K.waitFocus(page);
  assert.notStrictEqual(f.zone, 'dialog');
  // Elsewhere and back to Home in the same launch, and a reload (sessionStorage): no second check, no dialog.
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
  await K.back(page);
  await K.waitScreen(page, 'home');
  await page.waitForTimeout(4500);
  await noDialog(page);
  await page.reload();
  await K.waitScreen(page, 'home');
  await page.waitForTimeout(4500);
  await noDialog(page);
  assert.strictEqual(page.sent.filter(m => m.type === 'CheckAppUpdate').length, 1);
  const later = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:update:v1')).later);
  assert.strictEqual(later.version, '2.0.7');
  // A day later in the same launch, Home asks again.
  await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('mbptv:update:v1'));
    s.later.at -= 86400000 + 1000; s.at -= 86400000 + 1000;
    sessionStorage.setItem('mbptv:update:v1', JSON.stringify(s));
  });
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
  await K.back(page);
  await K.waitScreen(page, 'home');
  await waitDialog(page, 'the update dialog again after 24 h');
  assert.strictEqual(page.sent.filter(m => m.type === 'CheckAppUpdate').length, 2);
});

flow('Back on the prompt is Later', { script: checkOnly(AVAILABLE) }, async page => {
  await waitDialog(page, 'the update dialog');
  await K.back(page);
  await noDialog(page);
  assert.strictEqual(page.sent.filter(m => m.type === 'InstallAppUpdate').length, 0);
  assert.strictEqual(await H.screen(page), 'home');
  const later = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:update:v1')).later);
  assert.strictEqual(later.version, '2.0.7');
});

function installScript(final) {
  return (msg, send, ws) => {
    if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload: AVAILABLE });
    if (msg.type === 'InstallAppUpdate') ws.__install = { send, final };
  };
}

async function driveInstall(page) {
  const d = await waitDialog(page, 'the update dialog');
  assert.strictEqual(d.focus, 'update-later');
  await K.press(page, 'ArrowLeft');
  assert.strictEqual((await dialogState(page)).focus, 'update-install');
  await K.press(page, 'Enter', 1, 200);
  const sent = await waitSent(page, 'InstallAppUpdate');
  assert.deepStrictEqual(sent, { type: 'InstallAppUpdate', payload: { version: '2.0.7', sha256: SHA } });
  let s = await waitDialog(page, 'Downloading', 'Downloading');
  assert.deepStrictEqual(s.actions, []);
  assert.ok(s.focusInDialog && s.focusActive, 'focus stays inside the progress dialog');
}

flow('Install: exact payload, progress, success dialog, Close app exits', { script: (msg, send) => {
  if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload: AVAILABLE });
  if (msg.type === 'InstallAppUpdate') {
    const st = (state, received, total) => ({ type: 'AppUpdateStatus', payload: { state, version: '2.0.7', received, total } });
    setTimeout(() => send(st('downloading', 417894, 928653)), 300);
    setTimeout(() => send(st('verifying', 928653, 928653)), 1800);
    setTimeout(() => send(st('installing', 928653, 928653)), 3300);
    setTimeout(() => send({ type: 'InstallAppUpdate', payload: { ok: true, version: '2.0.7', restartNeeded: true } }), 4800);
  }
} }, async page => {
  await driveInstall(page);
  await waitDialog(page, 'Downloading 45%', 'Downloading… 45%');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'update-progress.png') });
  // Back is ignored while busy.
  await K.back(page);
  assert.strictEqual((await dialogState(page)).open, true);
  await waitDialog(page, 'verifying', 'Checking the download…');
  await waitDialog(page, 'installing', 'Installing… MovieBox Pro will close; open it again afterwards.');
  const done = await waitDialog(page, 'success', 'Updated to 2.0.7. Close MovieBox Pro and open it again to finish.');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'update-success.png') });
  assert.deepStrictEqual(done.actions, ['update-close-app', 'update-ok']);
  await K.navigateTo(page, '[data-action="update-close-app"]');
  await K.press(page, 'Enter', 1, 200);
  assert.strictEqual(await page.evaluate(() => window.__exitCalls || 0), 1);
});

flow('Install failure: failure dialog, OK closes and focus returns to Home', { script: (msg, send) => {
  if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload: AVAILABLE });
  if (msg.type === 'InstallAppUpdate') setTimeout(() => send({ type: 'InstallAppUpdate', payload: { ok: false, version: '2.0.7', stage: 'verify', error: 'Checksum mismatch' } }), 300);
} }, async page => {
  await driveInstall(page);
  const d = await waitDialog(page, 'the failure', 'Update failed: Checksum mismatch. Your current app is unchanged.');
  assert.deepStrictEqual(d.actions, ['update-ok']);
  assert.strictEqual(d.focus, 'update-ok');
  await K.press(page, 'Enter', 1, 250);
  await noDialog(page);
  const f = await K.waitFocus(page);
  assert.strictEqual(await H.screen(page), 'home');
  assert.notStrictEqual(f.zone, 'dialog');
  await K.press(page, 'ArrowDown');
  await K.waitFocus(page);
});

flow('socket closes while installing: the installing text stays', { script: (msg, send, ws) => {
  if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload: AVAILABLE });
  if (msg.type === 'InstallAppUpdate') {
    setTimeout(() => send({ type: 'AppUpdateStatus', payload: { state: 'installing', version: '2.0.7', received: 1, total: 1 } }), 1500);
    setTimeout(() => ws.close({ code: 1001 }), 2200);
  }
} }, async page => {
  await driveInstall(page);
  await waitDialog(page, 'installing', 'Installing…');
  await page.waitForTimeout(1500);
  const d = await dialogState(page);
  assert.ok(d.open && d.text.indexOf('Installing… MovieBox Pro will close') >= 0, d.text);
  assert.deepStrictEqual(d.actions, []);
});

flow('no word for 90 s while downloading: "No response" with OK', { clock: true, script: (msg, send) => {
  if (msg.type === 'CheckAppUpdate') send({ type: 'CheckAppUpdate', payload: AVAILABLE });
  if (msg.type === 'InstallAppUpdate') setTimeout(() => send({ type: 'AppUpdateStatus', payload: { state: 'downloading', version: '2.0.7', received: 10, total: 0 } }), 200);
} }, async page => {
  await driveInstall(page);
  await page.waitForTimeout(600);
  assert.ok(/Downloading…$/.test((await dialogState(page)).text), 'no percentage without a total');
  await page.clock.fastForward(91000);
  const d = await waitDialog(page, 'the no-response failure', 'No response from the TizenBrew service.');
  assert.deepStrictEqual(d.actions, ['update-ok']);
  await K.press(page, 'Enter', 1, 250);
  await noDialog(page);
});

flow('last updated: a toast', { script: checkOnly(reply({ installed: '2.0.7', running: '2.0.7', latest: '2.0.7', last: { status: 'updated', version: '2.0.7', from: '2.0.6', message: '', at: 1 } })) }, async page => {
  await waitSent(page, 'CheckAppUpdate');
  await K.waitUntil(page, 'the updated toast', () => /MovieBox Pro app updated to 2\.0\.7/.test((document.getElementById('mbptv-toast') || {}).textContent || ''));
  await noDialog(page);
});

flow('last failed: a dialog with OK', { script: checkOnly(reply({ last: { status: 'failed', version: '2.0.7', from: '2.0.6', message: 'Install refused by the TV (code 3).', at: 1 } })) }, async page => {
  const d = await waitDialog(page, 'the last-failed dialog', "The app update to 2.0.7 didn’t install. Your app is unchanged (2.0.6).");
  assert.ok(d.text.indexOf('Install refused by the TV (code 3).') >= 0, d.text);
  assert.deepStrictEqual(d.actions, ['update-ok']);
  assert.strictEqual(d.focus, 'update-ok');
  await K.press(page, 'Enter', 1, 250);
  await noDialog(page);
  assert.ok(!/updated to/.test(await toast(page)));
});

flow('busy on check: the progress dialog follows the running install', { script: (msg, send) => {
  if (msg.type !== 'CheckAppUpdate') return;
  send({ type: 'CheckAppUpdate', payload: reply({ latest: '2.0.7', available: true, sha256: SHA, busy: { state: 'downloading', version: '2.0.7', received: 100, total: 400 } }) });
  setTimeout(() => send({ type: 'AppUpdateStatus', payload: { state: 'verifying', version: '2.0.7', received: 400, total: 400 } }), 800);
} }, async page => {
  const d = await waitDialog(page, 'the progress dialog', 'Downloading… 25%');
  assert.deepStrictEqual(d.actions, []);
  assert.ok(d.focusInDialog && d.focusActive);
  await waitDialog(page, 'verifying', 'Checking the download…');
  assert.strictEqual(page.sent.filter(m => m.type === 'InstallAppUpdate').length, 0);
});

flow('access denied (token expired or revoked): a dialog with OK, nothing installed, Diagnostics says why', { script: checkOnly(reply({ ok: false, denied: true, error: 'access denied', latest: undefined, available: false, tokenExpiresAt: Date.UTC(2026, 0, 1) })) }, async page => {
  const d = await waitDialog(page, 'the access-denied dialog', 'Update check failed: access denied.');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'update-denied.png') });
  assert.ok(d.text.indexOf('update token has expired or was revoked. Nothing was installed.') >= 0, d.text);
  assert.deepStrictEqual(d.actions, ['update-ok']);
  assert.strictEqual(d.focus, 'update-ok');
  assert.ok(!/token expires/.test(await toast(page)), 'no expiry toast on top of the denied dialog');
  await K.press(page, 'Enter', 1, 250);
  await noDialog(page);
  assert.strictEqual(page.sent.filter(m => m.type === 'InstallAppUpdate').length, 0);
  assert.strictEqual(await H.screen(page), 'home');
  const n = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:update:v1')).note);
  assert.ok(/^Check failed: access denied · token expires 2026-01-01$/.test(n), n);
});

flow('token expires within 14 days: a toast, the offer still shows', { script: checkOnly(Object.assign({}, AVAILABLE, { tokenExpiresAt: Date.now() + 5 * 86400000 })) }, async page => {
  await K.waitUntil(page, 'the expiry toast', () => /App update token expires \d{4}-\d\d-\d\d\. Renew it on the Mac\./.test((document.getElementById('mbptv-toast') || {}).textContent || ''));
  await waitDialog(page, 'the update dialog', 'Version 2.0.7 is available.');
});

flow('token expires in more than 14 days: no toast', { script: checkOnly(reply({ tokenExpiresAt: Date.now() + 200 * 86400000 })) }, async page => {
  await waitSent(page, 'CheckAppUpdate');
  await page.waitForTimeout(1500);
  assert.ok(!/token expires/.test(await toast(page)));
  await noDialog(page);
  const n = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:update:v1')).note);
  assert.ok(/^Up to date \(2\.0\.6\) · token expires \d{4}-\d\d-\d\d$/.test(n), n);
});

flow('connection refused: nothing shown, the app stays usable', { refuse: true }, async page => {
  await K.waitUntil(page, 'the failed check in the log', () => window.__mbptv.Log.entries().some(e => e.label === 'update' && /check failed/.test(e.msg)), null, 9000);
  await noDialog(page);
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
});

flow('no reply: times out after 6 s, nothing shown, the app stays usable', { silent: true }, async page => {
  await waitSent(page, 'CheckAppUpdate');
  await K.waitUntil(page, 'the timeout in the log', () => window.__mbptv.Log.entries().some(e => e.label === 'update' && /no reply in 6 s/.test(e.msg)), null, 9000);
  await noDialog(page);
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
});

flow('not Tizen (desktop browser): no WebSocket at all', { ua: DESKTOP_UA, tizen: false, script: checkOnly(AVAILABLE) }, async page => {
  await page.waitForTimeout(5000);
  await noDialog(page);
  assert.strictEqual(page.sockets, 0);
  assert.deepStrictEqual(page.wsSeen, []);
});

flow('LG webOS user agent: no WebSocket at all', { ua: 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 WebAppManager', tizen: false, script: checkOnly(AVAILABLE) }, async page => {
  await page.waitForTimeout(5000);
  assert.strictEqual(page.sockets, 0);
  assert.deepStrictEqual(page.wsSeen, []);
});

flow('a dialog already open on Home: the check waits until Home is idle', { script: checkOnly(AVAILABLE) }, async page => {
  await K.back(page);
  await K.waitUntil(page, 'the exit dialog', () => !!document.querySelector('#mbptv [data-dialog="exit"]'));
  await page.waitForTimeout(4500);
  assert.strictEqual(page.sent.length, 0);
  await K.press(page, 'Enter', 1, 200);
  await noDialog(page);
  await waitDialog(page, 'the update dialog after the exit dialog closed');
});

(async () => {
  site = await H.mockSite.start();
  browser = await H.launch();
  O = site.origin;
  try { await run(); } finally {
    await browser.close();
    await site.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
