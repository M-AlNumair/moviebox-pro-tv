// Speed simulation: runs the built tv.js on the mock site under LG-TV-like conditions and prints timings.
//
//   node tools/speed-sim.cjs [--tvjs tv.js] [--home path/to/home.html] [--cpu 4] [--runs 3] [--only launch,detail,browse,play]
//
// What it emulates (numbers measured on the user's LG 50UN7340, webOS 5 / Chromium 68, 2026-10):
// - webOS injects webOSUserScripts/userScript.js after DOMContentLoaded (WAM BlinkWebView::DocumentLoadFinished), in the
//   main world, so tv.js is evaluated here right after DOMContentLoaded, not at document start;
// - server times: site page navigations 1200 ms to first byte, same-origin XHR documents 900 ms, player data 600 ms,
//   tv_file 600 ms, site scripts 700 ms each (about 100 KB of code each, to cost parse time);
// - artwork from a separate HTTP/2 host (like thumb.chuaxin.com: every request in parallel), 250 ms per picture, about
//   35 KB each, all pictures sharing 1.2 MB/s (so the home page's ~100 pictures take about 3 s each, as on the TV);
//   site pages and scripts are not bandwidth-limited (the browser gives them priority over images);
// - CPU throttled 4x (CDP Emulation.setCPUThrottlingRate), the LG user agent and a 1920x1080 viewport.
// The default home page is the mobile layout fixture; pass --home with the full live capture for the real image count.
// Never contacts the real site (every other host is aborted).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http2 = require('http2');
const { execFileSync } = require('child_process');
const { chromium } = require('./node_modules/playwright-core');
const mockSite = require('./mock-site.cjs');

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
function arg(name, dflt) { const i = argv.indexOf('--' + name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; }
const TVJS = path.resolve(arg('tvjs', path.join(root, 'tv.js')));
const HOME = path.resolve(arg('home', path.join(root, 'test', 'fixtures', 'home-mobile.html')));
const CPU = +arg('cpu', '4');
const RUNS = +arg('runs', '3');
const ONLY = arg('only', 'launch,detail,browse,play').split(',');
// --start /static/launch: start on the light launcher page (Site.pageType 'launcher') instead of the home page.
const START = arg('start', '/');
const LG_UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/68.0.3440.106 Safari/537.36 WebAppManager';
const THUMB_MS = 250, THUMB_BYTES = 35000, THUMB_RATE = 1.2e6;

function certs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbptv-sim-'));
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// The artwork host: HTTP/2 over TLS (every request in parallel, like the real thumbnail host), each picture answered
// after THUMB_MS and padded to about THUMB_BYTES, all of them sharing THUMB_RATE bytes/s (sent in 20 ms rounds, split
// evenly between the open streams). A stream the browser cancels stops taking a share at once.
function startThumbs() {
  const server = http2.createSecureServer(Object.assign(certs(), { allowHTTP1: true }));
  const active = [];
  const stats = { started: 0, finished: 0, cancelled: 0 };
  setInterval(() => {
    if (!active.length) return;
    const share = Math.max(1, Math.floor(THUMB_RATE * 0.02 / active.length));
    for (const a of active.slice()) {
      const chunk = a.body.slice(a.sent, a.sent + share);
      a.sent += chunk.length;
      try { a.stream.write(chunk); } catch (e) {}
      if (a.sent >= a.body.length) { active.splice(active.indexOf(a), 1); stats.finished++; try { a.stream.end(); } catch (e) {} }
    }
  }, 20).unref();
  server.on('stream', (stream, headers) => {
    const p = String(headers[':path'] || '/').split('?')[0];
    let svg = mockSite.artwork(p);
    svg = svg.replace('</svg>', '<!--' + 'x'.repeat(Math.max(0, THUMB_BYTES - svg.length)) + '--></svg>');
    stats.started++;
    let entry = null;
    const timer = setTimeout(() => {
      try { stream.respond({ ':status': 200, 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600' }); } catch (e) { return; }
      entry = { stream, body: Buffer.from(svg), sent: 0 };
      active.push(entry);
    }, THUMB_MS);
    stream.on('close', () => {
      clearTimeout(timer);
      const i = entry ? active.indexOf(entry) : -1;
      if (i >= 0 || !entry) { if (i >= 0) active.splice(i, 1); stats.cancelled++; }
    });
    stream.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, 'localhost', () => resolve({ origin: 'https://localhost:' + server.address().port, stats, close: () => new Promise(r => server.close(r)) })));
}

// About 100 KB of plain code per site script, plus a little work at run time, so the page's own scripts cost parse
// and run time like the real ones (jQuery 1.7, index.js and friends).
const BULK = (() => {
  const parts = [];
  for (let i = 0; i < 2600; i++) parts.push('function f' + i + '(a, b) { var c = a + ' + i + '; if (b) { c = c * 2 + b.length; } return c; }');
  return '(function () {\n' + parts.join('\n') + '\nvar t = Date.now(); while (Date.now() - t < 15) {}\n}());';
})();

function delayFor(req, u) {
  const p = u.pathname;
  if (p === '/tv.js' || p.startsWith('/__mock') || p.startsWith('/__player')) return 0;
  if (p.startsWith('/__media/')) return 200;
  if (p === '/static/launch') return 500;   // a static file: connection setup plus an edge-cached answer
  if (p.startsWith('/static/')) return /\.js$/.test(p) ? 700 : 150;
  if (p === '/index/index/player' || p === '/index/index/tv_file') return 600;
  if (/_progress$/.test(p)) return 150;
  if (p.startsWith('/index/search/autocomplate') || p.startsWith('/index/api/')) return 400;
  const nav = req.headers['sec-fetch-mode'] === 'navigate' || !!req.headers['upgrade-insecure-requests'];
  return nav ? 1200 : 900;
}

// Records, inside every page, when the shell and the first screen's pictures appear (ms after navigationStart).
const PROBE = `(function () {
  if (window.top !== window) return;
  var S = window.__sim = { marks: {} };
  function t0() { return performance.timing.navigationStart; }
  function mark(n) { if (!(n in S.marks)) S.marks[n] = Date.now() - t0(); }
  function tick() {
    try {
      var root = document.getElementById('mbptv');
      if (root) {
        mark('shell');
        var scr = root.getAttribute('data-screen');
        if (scr === 'home' && root.querySelector('.is-current [data-key]')) mark('homeCards');
        if (scr === 'home') {
          var imgs = root.querySelectorAll('.is-current img.mb-card-img'), vis = 0, done = 0, w = innerWidth, h = innerHeight;
          for (var i = 0; i < imgs.length; i++) {
            var r = imgs[i].getBoundingClientRect();
            if (r.width && r.bottom > 0 && r.top < h && r.right > 0 && r.left < w) { vis++; if (/is-loaded|is-error/.test(imgs[i].className)) done++; }
          }
          if (vis && done) mark('firstPoster');
          if (vis >= 8 && done === vis) mark('screenPosters');
        }
      }
    } catch (e) {}
    if (!S.marks.screenPosters) setTimeout(tick, 50);
  }
  tick();
}());`;

async function newPage(browser, thumbs) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, userAgent: LG_UA, deviceScaleFactor: 1, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.route(url => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url.href), r => r.abort());
  await context.addInitScript({ content: PROBE });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  if (CPU > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU });
  const net = { reqs: {}, thumbs: [], changed: false };
  cdp.on('Network.requestWillBeSent', e => {
    if (e.request.url.indexOf(thumbs.origin) === 0) { const r = { id: e.requestId, t: e.timestamp, url: e.request.url }; net.reqs[e.requestId] = r; net.thumbs.push(r); }
  });
  cdp.on('Network.loadingFinished', e => { const r = net.reqs[e.requestId]; if (r) { r.end = e.timestamp; r.bytes = e.encodedDataLength; } });
  cdp.on('Network.loadingFailed', e => {
    // macOS reports interface changes (VPNs and the like) and Chromium then fails requests with ERR_NETWORK_CHANGED:
    // such a run measures nothing useful, so it is repeated.
    if (/NETWORK_CHANGED/.test(e.errorText || '')) net.changed = true;
    const r = net.reqs[e.requestId];
    if (r) { r.end = e.timestamp; r.failed = e.canceled ? 'canceled' : e.errorText; }
  });
  // webOS: the user script runs once per main-frame document, after DOMContentLoaded.
  const code = fs.readFileSync(TVJS, 'utf8');
  page.on('domcontentloaded', () => { setTimeout(() => { page.evaluate(code).catch(() => {}); }, 30); });
  return { context, page, cdp, net };
}

async function waitFor(page, fn, arg, timeout) {
  const t = Date.now();
  await page.waitForFunction(fn, arg, { polling: 50, timeout: timeout || 30000 });
  return Date.now() - t;
}

async function logTimes(page) {
  return page.evaluate(() => {
    const n = performance.timing.navigationStart, out = {};
    const L = window.__mbptv && window.__mbptv.Log;
    (L ? L.entries() : []).forEach(e => { const k = e.label === 'route' ? 'route' : e.label === 'boot' ? 'boot' : ''; if (k && !(k in out)) out[k] = e.t - n; });
    out.dcl = performance.timing.domContentLoadedEventStart - n;
    out.load = performance.timing.loadEventStart > 0 ? performance.timing.loadEventStart - n : -1;
    return Object.assign(out, window.__sim ? window.__sim.marks : {});
  });
}

const homeReady = () => { const r = document.getElementById('mbptv'); return !!r && r.getAttribute('data-screen') === 'home' && !!r.querySelector('.is-current [data-key]'); };
const detailReady = () => {
  const r = document.getElementById('mbptv'), cur = r && r.querySelector('.is-current');
  return !!cur && r.getAttribute('data-screen') === 'detail' && !cur.querySelector('.mb-skel') && !!cur.querySelector('.mb-detail-rows > *');
};
const gridReady = () => { const r = document.getElementById('mbptv'); return !!r && r.getAttribute('data-screen') === 'browse' && !!r.querySelector('.is-current [data-zone="grid"] [data-key]'); };

// A cold start (new browser context). Returns null when the OS reported a network change during the run.
async function launchRun(browser, thumbs, site) {
  const { context, page, net } = await newPage(browser, thumbs);
  const out = {};
  for (const pass of ['cold']) {
    net.thumbs.length = 0;
    const t = Date.now();
    await page.goto(site.origin + START, { waitUntil: 'commit' });
    await waitFor(page, homeReady, null, 30000);
    await page.waitForFunction(() => window.__sim && window.__sim.marks.screenPosters, null, { polling: 100, timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const m = await logTimes(page);
    const route = m.route, bySec = x => x && x.end ? x.end : 0;
    const t0 = net.thumbs.length ? Math.min.apply(null, net.thumbs.map(r => r.t)) : 0;
    out[pass] = Object.assign(m, {
      wall: Date.now() - t,
      thumbs: net.thumbs.length,
      thumbsDone: net.thumbs.filter(r => r.end && !r.failed).length,
      thumbsCanceled: net.thumbs.filter(r => r.failed === 'canceled').length,
      thumbsFailed: net.thumbs.filter(r => r.failed && r.failed !== 'canceled').length,
      thumbBytesKB: Math.round(net.thumbs.reduce((a, r) => a + (r.bytes || 0), 0) / 1024),
      lastThumbSec: Math.round((Math.max.apply(null, net.thumbs.map(bySec).concat([t0])) - t0) * 10) / 10
    });
    void route;
  }
  await context.close();
  return net.changed ? null : out;
}

// From Home: Down to the second row, Right twice, rest `dwell` ms, OK; time until the detail screen shows its model.
async function detailRun(browser, thumbs, site, dwell) {
  const { context, page } = await newPage(browser, thumbs);
  await page.goto(site.origin + '/', { waitUntil: 'commit' });
  await waitFor(page, homeReady);
  await page.waitForTimeout(2500);
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(300);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(dwell);
  await page.keyboard.press('Enter');
  const ms = await waitFor(page, detailReady);
  // Back, then the next card (already seen? no: a new one) after the same dwell.
  await page.keyboard.press('Escape'); await waitFor(page, homeReady); await page.waitForTimeout(400);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(dwell);
  await page.keyboard.press('Enter');
  const ms2 = await waitFor(page, detailReady);
  await context.close();
  return { first: ms, second: ms2 };
}

async function browseRun(browser, thumbs, site, dwell) {
  const { context, page } = await newPage(browser, thumbs);
  await page.goto(site.origin + '/', { waitUntil: 'commit' });
  await waitFor(page, homeReady);
  await page.waitForTimeout(2000);
  const nav = name => page.evaluate(n => window.__mbptv.App.nav(n), name);
  await nav('movies');
  const first = await waitFor(page, gridReady);
  await page.waitForTimeout(800);
  await nav('home'); await waitFor(page, homeReady); await page.waitForTimeout(800);
  await nav('movies');
  const again = await waitFor(page, gridReady);
  await page.waitForTimeout(800);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(250);
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(dwell);
  await page.keyboard.press('Enter');
  const detail = await waitFor(page, detailReady);
  await context.close();
  return { gridFirst: first, gridAgain: again, gridToDetail: detail };
}

// Movie detail -> Play (built-in player) -> playing. AUTO answers with playable local media in the mock.
async function playRun(browser, thumbs, site) {
  const { context, page } = await newPage(browser, thumbs);
  await context.addCookies([{ name: 'mbp_auto', value: 'ok', url: site.origin }, { name: 'mbp_seconds', value: '0', url: site.origin }]);
  await page.goto(site.origin + '/', { waitUntil: 'commit' });
  await waitFor(page, homeReady);
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__mbptv.App.push('detail', { kind: 'movie', id: '40102' }));
  await waitFor(page, detailReady);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { const b = document.querySelector('#mbptv .is-current [data-action="play"]'); window.__mbptv.App.focus(b); });
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  const ms = await waitFor(page, () => { const p = document.getElementById('mbptv-player'); return !!p && p.getAttribute('data-state') === 'playing'; });
  await context.close();
  return { playToFrame: ms };
}

function stats(list) {
  const nums = list.filter(x => typeof x === 'number' && x >= 0).sort((a, b) => a - b);
  if (!nums.length) return '-';
  const med = nums[Math.floor(nums.length / 2)];
  return med + ' (' + nums[0] + '..' + nums[nums.length - 1] + ')';
}

function table(title, runs) {
  console.log('\n' + title);
  const keys = [];
  runs.forEach(r => Object.keys(r).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); }));
  keys.forEach(k => console.log('  ' + (k + '                    ').slice(0, 20) + stats(runs.map(r => r[k]))));
}

(async () => {
  const thumbs = await startThumbs();
  const homeHtml = fs.readFileSync(HOME, 'utf8');
  const site = await mockSite.start({
    delayFor,
    pageFor: p => (p === '/' ? { html: homeHtml } : null),
    transformHtml: html => html.replace(/(["'(])\/__img\//g, '$1' + thumbs.origin + '/__img/'),
    siteScript: () => BULK
  });
  const browser = await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || 'chrome', args: ['--autoplay-policy=no-user-gesture-required', '--ignore-certificate-errors'] });
  console.log('tv.js: ' + path.relative(process.cwd(), TVJS) + ' | home: ' + path.basename(HOME) + ' | start: ' + START + ' | CPU x' + CPU + ' | runs ' + RUNS);
  try {
    if (ONLY.indexOf('launch') >= 0) {
      const cold = [];
      let skipped = 0;
      while (cold.length < RUNS && skipped < 3 * RUNS) {
        const r = await launchRun(browser, thumbs, site);
        if (r) cold.push(r.cold); else skipped++;
      }
      table('Launch, cold cache (ms after navigationStart; median (min..max))' + (skipped ? ' [' + skipped + ' runs repeated: network change]' : ''), cold);
    }
    if (ONLY.indexOf('detail') >= 0) {
      const a = [], b = [];
      for (let i = 0; i < RUNS; i++) { a.push(await detailRun(browser, thumbs, site, 150)); b.push(await detailRun(browser, thumbs, site, 1500)); }
      table('Home card -> detail ready (ms), OK 150 ms after focusing', a);
      table('Home card -> detail ready (ms), OK after a 1.5 s rest', b);
    }
    if (ONLY.indexOf('browse') >= 0) {
      const a = [];
      for (let i = 0; i < RUNS; i++) a.push(await browseRun(browser, thumbs, site, 1500));
      table('Browse Movies (ms): first open, open again, grid card -> detail after a 1.5 s rest', a);
    }
    if (ONLY.indexOf('play') >= 0) {
      const a = [];
      for (let i = 0; i < RUNS; i++) a.push(await playRun(browser, thumbs, site));
      table('Movie detail Play -> first frame (ms, mock media)', a);
    }
  } finally {
    await browser.close();
    await site.close();
    await thumbs.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
