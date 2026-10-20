// Speed work (Site.live.quiet, list cache, prefetch on rest): the built tv.js on the mock site.
// Standalone: node test/speed.test.cjs
'use strict';
const assert = require('assert');
const H = require('./helpers.cjs');

const t = H.makeRunner('speed');
let server, browser, origin;

// The real site's thumbnails come from another host (thumb.chuaxin.com); the mock serves them from its own origin, so
// these pages are rewritten to name them on "localhost" (another host for the page; the request itself is aborted).
async function openWithForeignArt(paths) {
  const page = await H.openPage(browser);
  const foreign = origin.replace('127.0.0.1', 'localhost');
  // The other host answers with a small picture after a moment (registered last, so it runs before the abort-all route).
  await page.route(foreign + '/**', route => setTimeout(() => route.fulfill({ status: 200, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="15"/>' }).catch(() => {}), 300));
  for (const p of paths) {
    await page.route(origin + p, async route => {
      const res = await route.fetch();
      const body = (await res.text()).replace(/(["'(])\/__img\//g, '$1' + foreign + '/__img/');
      await route.fulfill({ response: res, body });
    });
  }
  page.foreign = foreign;
  return page;
}

async function waitHome(page) {
  await page.waitForFunction(() => { const r = document.getElementById('mbptv'); return r && r.getAttribute('data-screen') === 'home' && r.querySelector('.is-current [data-key]'); }, null, { timeout: 15000 });
}

const pageArt = foreign => {
  const shell = document.getElementById('mbptv');
  const imgs = Array.prototype.filter.call(document.querySelectorAll('img'), i => !shell.contains(i));
  const bgs = Array.prototype.filter.call(document.querySelectorAll('[style*="url("], [data-mbptv-bg]'), n => !shell.contains(n));
  const contents = document.querySelector('.contents');
  return {
    quiet: document.documentElement.classList.contains('mbptv-quiet'),
    hidden: contents ? getComputedStyle(contents).visibility : '',
    foreignSrc: imgs.filter(i => (i.getAttribute('src') || '').indexOf(foreign) === 0).length,
    parked: imgs.filter(i => i.hasAttribute('data-mbptv-src')).length,
    parkedBlank: imgs.filter(i => i.hasAttribute('data-mbptv-src')).every(i => /^data:image\/gif/.test(i.getAttribute('src'))),
    parkedBg: bgs.filter(n => n.hasAttribute('data-mbptv-bg') && n.style.backgroundImage === 'none').length,
    foreignBg: bgs.filter(n => n.style.backgroundImage.indexOf(foreign) >= 0).length
  };
};

t.test('Home: the website page\'s own pictures from other hosts are held back and the page is not painted; website view puts them back', async () => {
  const page = await openWithForeignArt(['/']);
  await page.goto(origin + '/');
  await waitHome(page);
  let a = await page.evaluate(pageArt, page.foreign);
  assert.strictEqual(a.quiet, true, 'html.mbptv-quiet');
  assert.strictEqual(a.hidden, 'hidden', 'the page under the shell is not painted');
  assert.strictEqual(a.foreignSrc, 0, 'no site picture from another host keeps downloading');
  assert.ok(a.parked >= 10 && a.parkedBlank, JSON.stringify(a));
  assert.ok(a.parkedBg >= 1 && a.foreignBg === 0, 'banner background pictures are held back too: ' + JSON.stringify(a));
  // The live page still parses the same (the parsers read the held-back addresses).
  const parsed = await page.evaluate(() => { const h = window.__mbptv.Site.home(document); return { rows: h.rows.length, poster: h.rows[1].items[0].poster, banner: h.banners[0] && h.banners[0].image }; });
  assert.ok(parsed.rows >= 3 && parsed.poster.indexOf(page.foreign) === 0 && parsed.banner.indexOf(page.foreign) === 0, JSON.stringify(parsed));
  const cardSrc = await page.evaluate(() => { const i = document.querySelector('#mbptv .is-current [data-key] img.mb-card-img'); return i.__src || i.getAttribute('src') || ''; });
  assert.ok(cardSrc.indexOf(page.foreign) === 0, 'the app\'s own cards still show the posters: ' + cardSrc);
  // Pictures the website's scripts add later are held back as they appear.
  await page.evaluate(f => { const i = document.createElement('img'); i.id = 'late'; i.src = f + '/__img/thumb/late.png'; document.querySelector('.contents').appendChild(i); }, page.foreign);
  await page.waitForTimeout(100);
  assert.strictEqual(await page.evaluate(() => document.getElementById('late').getAttribute('data-mbptv-src') !== null && /^data:/.test(document.getElementById('late').src)), true);
  await page.evaluate(f => { document.getElementById('late').setAttribute('src', f + '/__img/thumb/late2.png'); }, page.foreign);
  await page.waitForTimeout(100);
  assert.strictEqual(await page.evaluate(() => document.getElementById('late').getAttribute('data-mbptv-src')), page.foreign + '/__img/thumb/late2.png');
  // Website view: everything is put back.
  await page.evaluate(() => window.__mbptv.App.openWebsite(''));
  await page.waitForFunction(() => window.__mbptv.App.state().mode === 'native');
  a = await page.evaluate(pageArt, page.foreign);
  assert.deepStrictEqual([a.quiet, a.parked, a.parkedBg], [false, 0, 0], JSON.stringify(a));
  assert.ok(a.foreignSrc >= 10 && a.foreignBg >= 1, JSON.stringify(a));
  assert.strictEqual(a.hidden, 'visible');
  // Back to the TV app: held back again.
  await page.evaluate(() => window.__mbptv.App.exitWebsite());
  await waitHome(page);
  a = await page.evaluate(pageArt, page.foreign);
  assert.deepStrictEqual([a.quiet, a.foreignSrc, a.foreignBg], [true, 0, 0], JSON.stringify(a));
  assert.deepStrictEqual(page.errors, []);
  await page.context_.close();
});

t.test('a title page is never quieted (the App watches its popups and player); teardown puts everything back', async () => {
  const page = await openWithForeignArt(['/movie/40102']);
  await page.goto(origin + '/movie/40102');
  await page.waitForFunction(() => { const r = document.getElementById('mbptv'); return r && r.getAttribute('data-screen') === 'detail'; }, null, { timeout: 15000 });
  await page.waitForTimeout(200);
  const a = await page.evaluate(pageArt, page.foreign);
  assert.deepStrictEqual([a.quiet, a.parked, a.parkedBg], [false, 0, 0], JSON.stringify(a));
  assert.ok(a.foreignSrc >= 1, JSON.stringify(a));
  await page.context_.close();

  const home = await openWithForeignArt(['/']);
  await home.goto(origin + '/');
  await waitHome(home);
  assert.ok((await home.evaluate(pageArt, home.foreign)).parked > 0);
  await home.evaluate(() => window.__mbptv.App.kill());
  const b = await home.evaluate(pageArt, home.foreign);
  assert.deepStrictEqual([b.quiet, b.parked, b.parkedBg], [false, 0, 0], JSON.stringify(b));
  await home.context_.close();
});

async function openTracked() {
  const page = await H.openPage(browser);
  page.reqs = [];
  page.on('request', r => { const u = new URL(r.url()); if (u.origin === origin) page.reqs.push(u.pathname + u.search); });
  return page;
}
const count = (page, re) => page.reqs.filter(u => re.test(u)).length;
async function waitGrid(page) {
  await page.waitForFunction(() => { const r = document.getElementById('mbptv'); return r && r.getAttribute('data-screen') === 'browse' && r.querySelector('.is-current [data-zone="grid"] [data-key]'); }, null, { timeout: 15000 });
}

t.test('browse: a list read moments ago opens at once without a new request; the library shows at once and is read again', async () => {
  const page = await openTracked();
  await page.goto(origin + '/');
  await waitHome(page);
  await page.evaluate(() => window.__mbptv.App.nav('movies'));
  await waitGrid(page);
  assert.strictEqual(count(page, /^\/movie$/), 1);
  const keys = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]'), n => n.getAttribute('data-key')));
  await page.evaluate(() => window.__mbptv.App.nav('home'));
  await waitHome(page);
  await page.evaluate(() => window.__mbptv.App.nav('movies'));
  await waitGrid(page);
  await page.waitForTimeout(300);
  assert.strictEqual(count(page, /^\/movie$/), 1, 'served from the list cache');
  const again = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]'), n => n.getAttribute('data-key')));
  assert.deepStrictEqual(again.slice(0, 3), keys.slice(0, 3), 'the same first page (3 titles in the fixture; later pages load as before)');
  assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-key')), keys[0], 'focus on the first card');
  // The viewer's own list: shown at once from the last read, and read again in the background.
  await page.evaluate(() => window.__mbptv.App.nav('library'));
  await waitGrid(page);
  await page.evaluate(() => window.__mbptv.App.nav('home'));
  await waitHome(page);
  const before = count(page, /^\/index\/index\/my_box$/);
  const t0 = Date.now();
  await page.evaluate(() => window.__mbptv.App.nav('library'));
  await waitGrid(page);
  assert.ok(Date.now() - t0 < 400, 'shown from the cache');
  await page.waitForTimeout(500);
  assert.strictEqual(count(page, /^\/index\/index\/my_box$/), before + 1, 'and read again');
  assert.deepStrictEqual(page.errors, []);
  await page.context_.close();
});

t.test('resting on a grid card prefetches its title page; OK then opens it with no second read', async () => {
  const page = await openTracked();
  await page.goto(origin + '/');
  await waitHome(page);
  await page.evaluate(() => window.__mbptv.App.nav('movies'));
  await waitGrid(page);
  await H.press(page, 'ArrowRight');
  const key = await page.evaluate(() => document.activeElement.getAttribute('data-key'));
  const id = key.split(':')[1], re = new RegExp('^/(movie|tvshow)/' + id + '$');
  await page.waitForTimeout(250);
  assert.strictEqual(count(page, re), 0, 'not before the rest time (500 ms in TV performance mode)');
  await page.waitForTimeout(900);
  assert.strictEqual(count(page, re), 1, 'prefetched after the rest');
  await H.press(page, 'Enter');
  await page.waitForFunction(() => { const r = document.getElementById('mbptv'), c = r && r.querySelector('.is-current'); return r.getAttribute('data-screen') === 'detail' && c && !c.querySelector('.mb-skel'); }, null, { timeout: 5000 });
  assert.strictEqual(count(page, re), 1, 'no second read');
  // Passing over cards quickly prefetches nothing.
  await H.back(page);
  await waitGrid(page);
  const titles = /^\/(movie|tvshow)\/\d+$/, n = count(page, titles);
  await H.press(page, 'ArrowRight', 3, 120);
  await H.press(page, 'ArrowLeft', 3, 120);
  assert.strictEqual(count(page, titles), n);
  await page.context_.close();
});

t.test('Home warms Movies and TV Shows in the background once the viewer rests, so the rail opens them at once', async () => {
  const page = await openTracked();
  await page.goto(origin + '/');
  await waitHome(page);
  await page.waitForTimeout(4500);
  assert.strictEqual(count(page, /^\/(movie|tvshow)$/), 0, 'not in the first seconds');
  await page.waitForTimeout(4500);
  assert.strictEqual(count(page, /^\/movie$/), 1);
  assert.strictEqual(count(page, /^\/tvshow$/), 1);
  const t0 = Date.now();
  await page.evaluate(() => window.__mbptv.App.nav('shows'));
  await waitGrid(page);
  assert.ok(Date.now() - t0 < 400);
  assert.strictEqual(count(page, /^\/tvshow$/), 1);
  await page.context_.close();
});

t.test('launcher: starting on a light static page reads Home by XHR; website view opens the site\'s home and Back returns', async () => {
  const page = await openTracked();
  await page.goto(origin + '/static/launch');
  await waitHome(page);
  const st = await page.evaluate(() => ({ type: window.__mbptv.App.pageType(), rows: document.querySelectorAll('#mbptv .is-current [data-zone^="row:"]').length,
    key: !!document.querySelector('#mbptv [data-key="movie:40102"]') }));
  assert.deepStrictEqual(st, { type: 'launcher', rows: st.rows, key: true });
  assert.ok(st.rows >= 3, 'rows from the fetched home page');
  assert.strictEqual(count(page, /^\/$/), 1, 'Home read once, by XHR');
  // Website view from the launcher opens the site's home page in website mode.
  await page.evaluate(() => window.__mbptv.App.openWebsite(''));
  await page.waitForURL(origin + '/', { timeout: 10000 });
  await page.waitForFunction(() => window.__mbptv && window.__mbptv.App.state().mode === 'native', null, { timeout: 10000 });
  // Back in website mode goes back to the launcher, which shows the TV app again.
  await H.back(page);
  await page.waitForURL(origin + '/static/launch', { timeout: 10000 });
  await waitHome(page);
  assert.strictEqual(await page.evaluate(() => window.__mbptv.App.state().mode), 'shell');
  assert.deepStrictEqual(page.errors, []);
  await page.context_.close();
});

async function main() {
  server = await H.mockSite.start();
  origin = server.origin;
  browser = await H.launch();
  try { await t.run(); } finally {
    await browser.close();
    await server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
