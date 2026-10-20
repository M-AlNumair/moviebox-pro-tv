// Native player tests (docs/PLAYER.md "Testing"). Standalone: node test/player.test.cjs
// Runs NativePlayer from a bundle of src/00-core.js, 10-site.js, 20-api.js and 55-player.js (+ shell.css and
// player.css as CSS_TEXT) on a blank mock page with a stub #mbptv root, against the mock routes in
// tools/mock-extra.cjs (local silent WAV "streams", a failing HLS URL, progress recording). Keys are real keyboard
// events routed the way App routes them: Keys.name(event) -> NativePlayer.key(name, event).
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { launch, openPage, makeRunner, mockSite, root } = require('./helpers.cjs');

const FILES = ['00-core.js', '10-site.js', '20-api.js', '55-player.js'];
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function cssText() {
  return ['shell.css', 'player.css'].map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')).join('\n');
}

// Stub root + the App's key routing + recorded hooks.
const HARNESS = `
  var style = document.createElement('style');
  style.id = 'mbptv-css';
  style.appendChild(document.createTextNode(CSS_TEXT));
  document.head.appendChild(style);
  var mbRoot = document.getElementById('mbptv');
  var events = [];
  var hooks = {
    mount: mbRoot,
    onOpen: function () { events.push({ type: 'open' }); mbRoot.setAttribute('data-screen', 'player'); },
    onClose: function (info) { events.push({ type: 'close', info: info }); mbRoot.setAttribute('data-screen', 'detail'); },
    onFallback: function (req, reason) { events.push({ type: 'fallback', req: req, reason: reason }); },
    onProgress: function (info) { events.push({ type: 'progress', info: info }); },
    onNext: function (req) { events.push({ type: 'next', req: req }); }
  };
  window.addEventListener('keydown', function (e) {
    var name = Keys.name(e);
    if (!name || !NativePlayer.active()) return;
    if (NativePlayer.key(name, e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.__p = { NativePlayer: NativePlayer, Log: Log, Api: Api, Prefs: Prefs, Site: Site, U: U, Keys: Keys, events: events, hooks: hooks,
    play: function (req) { return NativePlayer.play(req, hooks); } };
`;

function bundle(origin) {
  return ['(function () {', "'use strict';", "var VERSION = 'test';", 'var START_URL = ' + JSON.stringify(origin + '/') + ';',
    'var CSS_TEXT = ' + JSON.stringify(cssText()) + ';']
    .concat(FILES.map(f => fs.readFileSync(path.join(root, 'src', f), 'utf8')))
    .concat([HARNESS, '}());'])
    .join('\n');
}

const fixture = name => fs.readFileSync(path.join(root, 'test', 'fixtures', name), 'utf8');

const t = makeRunner('player');
let server, browser, origin, code;
const pages = [];

async function open(cookies = {}, opts = {}) {
  const page = await openPage(browser, { tv: false, ua: opts.ua });
  pages.push(page);
  if (process.env.DEBUG_CONSOLE) page.on('console', m => console.log('    console: ' + m.text().slice(0, 300)));
  const list = Object.keys(cookies).map(name => ({ name, value: String(cookies[name]), url: origin }));
  if (list.length) await page.context_.addCookies(list);
  await page.goto(origin + '/__player/blank');
  await page.addScriptTag({ content: code });
  await page.evaluate(() => Promise.all([fetch('/__mock/progress-log?reset=1'), fetch('/__mock/player-log?reset=1')]));
  // hls.js's CDN copy is the mock's (tests never reach the network); opts.config may override it.
  await page.evaluate(o => window.__p.NativePlayer.configure({ hlsCdn: o + '/__cdn/hls.min.js' }), origin);
  if (opts.config) await page.evaluate(c => window.__p.NativePlayer.configure(c), opts.config);
  if (opts.saver) {
    await page.evaluate(() => {
      window.__saver = [];
      window.webapis = { appcommon: { AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 0, SCREEN_SAVER_ON: 1 },
        setScreenSaver: function (state) { window.__saver.push(state); } } };
    });
  }
  return page;
}

async function done(page) {
  // Never log stream URLs; never throw.
  const entries = await page.evaluate(() => window.__p.Log.entries().concat(window.__p.Log.persisted()).map(e => e.label + ' ' + e.msg).join('\n'));
  assert.ok(!/__media|\.m3u8|\.wav|\.mp4|sign=|REDACTED|__subs|\.srt|\.vtt|get_srt_content/.test(entries), 'a stream or subtitle URL reached the log:\n' + entries);
  assert.deepStrictEqual(page.errors, [], 'page errors');
  // The player's last progress post goes out now, not as the page closes (it would land in the next test's log).
  await page.evaluate(() => { try { window.__p.NativePlayer.stop('test-end'); } catch (e) {} return new Promise(r => setTimeout(r, 150)); }).catch(() => {});
  await page.context_.close();
}

const MOVIE = { kind: 'movie', id: '40102', title: 'The Batman' };
const EPISODE = { kind: 'tv', id: '17417', season: 1, episode: 1, title: 'Putin: A Russian Spy Story', showTitle: 'Putin: A Russian Spy Story', episodeTitle: 'The Rise of Putin' };

const play = (page, req) => page.evaluate(r => window.__p.play(r), req);
const info = page => page.evaluate(() => window.__p.NativePlayer.info());
const events = (page, type) => page.evaluate(ty => window.__p.events.filter(e => !ty || e.type === ty), type);
const video = page => page.evaluate(() => { const v = document.querySelector('#mbptv-player video'); return v ? { t: v.currentTime, paused: v.paused, d: v.duration } : null; });
const setTime = (page, s) => page.evaluate(x => { document.querySelector('#mbptv-player video').currentTime = x; }, s);
const progressLog = page => page.evaluate(() => fetch('/__mock/progress-log').then(r => r.json()));
const playerLog = page => page.evaluate(() => fetch('/__mock/player-log').then(r => r.json()));
const rootClass = page => page.evaluate(() => { const r = document.getElementById('mbptv-player'); return r ? ' ' + r.className + ' ' : ''; });
const state = page => page.evaluate(() => { const r = document.getElementById('mbptv-player'); return r ? r.getAttribute('data-state') : ''; });
const text = (page, sel) => page.evaluate(s => { const n = document.querySelector(s); return n ? n.textContent.replace(/\s+/g, ' ').trim() : null; }, sel);
const focusedAction = page => page.evaluate(() => { const n = document.querySelector('#mbptv-player .mbp-btns .is-focused'); return n ? n.getAttribute('data-action') : ''; });
const key = (page, name) => page.evaluate(n => window.__p.NativePlayer.key(n, {}), name);

async function waitPlaying(page, extra, timeout = 20000) {
  try {
  await page.waitForFunction(x => {
    const i = window.__p.NativePlayer.info();
    const v = document.querySelector('#mbptv-player video');
    if (!i || i.state !== 'playing' || !i.started || !v || v.paused) return false;
    for (const k in (x || {})) if (i[k] !== x[k]) return false;
    return true;
  }, extra || null, { timeout });
  } catch (e) {
    const log = await page.evaluate(() => window.__p.Log.entries().map(x => x.msg).join('\n')).catch(() => '');
    throw new Error(e.message + '\nwanted ' + JSON.stringify(extra) + ', info ' + JSON.stringify(await info(page).catch(() => null)) + '\n' + log.split('\n').slice(-25).join('\n'));
  }
}

async function waitTime(page, min, timeout = 20000) {
  await page.waitForFunction(m => { const v = document.querySelector('#mbptv-player video'); return v && v.currentTime >= m; }, min, { timeout });
}

async function waitClass(page, cls, on = true, timeout = 10000) {
  await page.waitForFunction(([c, o]) => {
    const r = document.getElementById('mbptv-player');
    return !!r && (' ' + r.className + ' ').indexOf(' ' + c + ' ') >= 0 === o;
  }, [cls, on], { timeout });
}

async function waitPosts(page, n, timeout = 8000) {
  const until = Date.now() + timeout;
  for (;;) {
    const list = await progressLog(page);
    if (list.length >= n) return list;
    if (Date.now() > until) throw new Error(`expected ${n} progress posts, got ${list.length}: ` + JSON.stringify(list.map(p => p.body)));
    await page.waitForTimeout(100);
  }
}

function near(actual, expected, tol, label) {
  assert.ok(Math.abs(actual - expected) <= tol, `${label || 'value'}: ${actual} not within ${tol} of ${expected}`);
}

/* ---------- pure helpers ---------- */

t.test('parser reads the player data with regexes, skipping the commented sources line and never evaluating', async () => {
  const page = await open();
  const out = await page.evaluate(([tv, movie]) => {
    const P = window.__p.NativePlayer;
    const evil = 'var sources = [{"type":"video/mp4","file":"https://x.example/a.mp4","label":"ORG"}]; window.__evil = 1;\nvar seconds = 5;';
    const commentedFirst = '  //var sources = [{"type":"video/mp4","file":"https://decoy.example/d.mp4","label":"ORG"}];\n' +
      '  var sources = [{"type":"application\\/x-mpegURL","file":"https:\\/\\/real.example\\/r.m3u8","label":"AUTO"}];';
    return { tv: P._parse(tv), movie: P._parse(movie), vip: P._parse('{"code":-1,"msg":"VIP only"}'), evil: P._parse(evil), evilRan: !!window.__evil,
      commented: P._parse(commentedFirst), empty: P._parse(''), garbage: P._parse('<html><body>nothing</body></html>') };
  }, [fixture('player-tv.txt'), fixture('player-movie.txt')]);
  const tv = out.tv;
  assert.deepStrictEqual(tv.sources.map(s => s.label), ['ORG', 'AUTO', '1080p', '720p', '360p']);
  assert.ok(tv.sources.every(s => /^https:\/\/(usa7-as01|hls)\.shegu\.net\//.test(s.src)), 'the commented //var sources line was used');
  assert.deepStrictEqual(tv.sources.map(s => s.hls), [false, true, true, true, true]);
  assert.strictEqual(tv.sources[0].width, 1920);
  assert.strictEqual(tv.seconds, 31);
  assert.strictEqual(tv.mp4Id, '886357');
  assert.deepStrictEqual(tv.next, { season: 1, episode: 2 });
  assert.strictEqual(tv.tid, '17417');
  assert.strictEqual(tv.season, 1);
  assert.strictEqual(tv.episode, 1);
  assert.deepStrictEqual(tv.skips, { start: -1, end: -1 });
  assert.deepStrictEqual(tv.post, { type: 'tv', tid: '17417', season: '1', episode: '1' });
  assert.strictEqual(tv.progressUrl, '/index/index/tv_progress');
  assert.strictEqual(tv.ok, true);
  const mv = out.movie;
  assert.strictEqual(mv.sources[0].h265, true);
  assert.strictEqual(mv.next, null);
  assert.strictEqual(mv.seconds, 3);
  assert.deepStrictEqual(mv.post, { type: 'movie', mid: '1831' });
  assert.strictEqual(mv.progressUrl, '/index/index/movie_progress');
  assert.strictEqual(out.vip.code, -1);
  assert.strictEqual(out.vip.msg, 'VIP only');
  assert.strictEqual(out.vip.sources.length, 0);
  assert.strictEqual(out.evilRan, false, 'player data must never be evaluated');
  assert.strictEqual(out.evil.sources.length, 1);
  assert.deepStrictEqual(out.commented.sources.map(s => s.src), ['https://real.example/r.m3u8']);
  assert.strictEqual(out.empty.ok, false);
  assert.strictEqual(out.garbage.sources.length, 0);
  await done(page);
});

t.test('stream order: TV tries AUTO HLS (+audio=aac) first; elsewhere a decodable ORG MP4 comes first', async () => {
  const page = await open();
  const out = await page.evaluate(src => {
    const P = window.__p.NativePlayer, sources = P._parse(src).sources;
    const hevc = sources.map(s => Object.assign({}, s, s.label === 'ORG' ? { h265: true } : {}));
    const h264Only = mime => /avc1/.test(mime) ? 'probably' : '';
    const labels = list => list.map(c => c.label);
    return {
      tv: P._order(sources, { tv: true, aac: true, canPlay: () => '' }),
      desk: labels(P._order(sources, { tv: false, aac: false, canPlay: h264Only })),
      deskAac: P._order(sources, { tv: false, aac: true, canPlay: h264Only }),
      deskHevc: labels(P._order(hevc, { tv: false, aac: false, canPlay: h264Only })),
      deskHevcOk: labels(P._order(hevc, { tv: false, aac: false, canPlay: () => 'maybe' }))
    };
  }, fixture('player-tv.txt'));
  assert.deepStrictEqual(out.tv.map(c => c.label), ['AUTO', 'ORG', '1080p', '720p', '360p']);
  assert.ok(/[?&]audio=aac$/.test(out.tv[0].src), 'AUTO carries audio=aac on TV');
  assert.ok(out.tv.filter(c => c.hls).every(c => /audio=aac/.test(c.src)), 'every HLS URL carries audio=aac on TV');
  assert.ok(!/audio=aac/.test(out.tv[1].src), 'the MP4 is untouched');
  assert.deepStrictEqual(out.desk, ['ORG', 'AUTO', '1080p', '720p', '360p']);
  assert.ok(out.deskAac.filter(c => c.hls).every(c => /audio=aac/.test(c.src)), 'aac when EAC3 is unsupported');
  assert.deepStrictEqual(out.deskHevc, ['AUTO', '1080p', '720p', '360p', 'ORG'], 'undecodable HEVC ORG goes last');
  assert.deepStrictEqual(out.deskHevcOk, ['ORG', 'AUTO', '1080p', '720p', '360p']);
  await done(page);
});

/* ---------- playback ---------- */

t.test('movie: loading screen at once, AUTO HLS fails, the ORG MP4 plays (TV rules: audio=aac, POST jwplayer=1)', async () => {
  const page = await open({ mbp_len: 300 });
  assert.strictEqual(await play(page, Object.assign({ backdrop: origin + '/__img/tmdb/t/p/w1280/TEST_backdrop_40102.jpg' }, MOVIE)), true);
  assert.strictEqual(await state(page), 'loading');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-load-title'), 'The Batman');
  assert.strictEqual(await page.evaluate(() => document.getElementById('mbptv').contains(document.getElementById('mbptv-player'))), true, 'mounted in #mbptv');
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), true);
  assert.deepStrictEqual((await events(page, 'open')).length, 1);
  await waitPlaying(page);
  const i = await info(page);
  assert.strictEqual(i.label, 'ORG');
  assert.strictEqual(i.stream, 'mp4');
  assert.strictEqual(i.kind, 'movie');
  assert.strictEqual(i.id, '40102');
  near(i.duration, 300, 1, 'duration');
  const log = await playerLog(page);
  const player = log.filter(e => e.kind === 'player');
  assert.strictEqual(player.length, 1);
  assert.strictEqual(player[0].method, 'POST');
  assert.strictEqual(player[0].query.mfid, '2176222', 'Prefs quality "best" plays the first listed file');
  assert.strictEqual(player[0].query.jwplayer, '1');
  assert.strictEqual(player[0].xrw, 'XMLHttpRequest');
  const media = log.filter(e => e.kind === 'media');
  assert.ok(/^\/__media\/bad-auto\.m3u8$/.test(media[0].path), 'AUTO HLS is tried first on a TV: ' + media[0].path);
  assert.strictEqual(media[0].query.audio, 'aac');
  assert.ok(media.some(m => m.path === '/__media/ep.wav' && m.query.q === 'org'), 'then the ORG MP4');
  const entries = await page.evaluate(() => window.__p.Log.entries().map(e => e.msg).join('\n'));
  assert.ok(/stream AUTO failed: media-\d/.test(entries), entries);
  assert.ok(/playing ORG/.test(entries));
  assert.strictEqual(await text(page, '#mbptv-player .mbp-title'), 'The Batman');
  await done(page);
});

t.test('stream order: configure({tvOrder}) moves the named labels first on a TV only, for start-time experiments', async () => {
  const page = await open();
  const out = await page.evaluate(src => {
    const P = window.__p.NativePlayer, sources = P._parse(src).sources, labels = list => list.map(c => c.label);
    const cfg = P.configure({ tvOrder: '720p, ORG' });
    const r = {
      cfg: cfg.tvOrder,
      tv: labels(P._order(sources, { tv: true, aac: true, canPlay: () => '', prefer: '720p, ORG' })),
      unknown: labels(P._order(sources, { tv: true, aac: true, canPlay: () => '', prefer: 'nope' })),
      none: labels(P._order(sources, { tv: true, aac: true, canPlay: () => '' }))
    };
    r.reset = P.configure({ tvOrder: '' }).tvOrder;
    return r;
  }, fixture('player-tv.txt'));
  assert.strictEqual(out.cfg, '720p, ORG');
  assert.deepStrictEqual(out.tv, ['720p', 'ORG', 'AUTO', '1080p', '360p']);
  assert.deepStrictEqual(out.unknown, ['AUTO', 'ORG', '1080p', '720p', '360p']);
  assert.deepStrictEqual(out.none, ['AUTO', 'ORG', '1080p', '720p', '360p']);
  assert.strictEqual(out.reset, '');
  await done(page);
});

t.test('a movie whose title page was already read plays without reading it again; the log names the start times', async () => {
  const page = await open({ mbp_len: 120 });
  await page.evaluate(() => new Promise(r => window.__p.Api.detail('movie', '40102', () => r())));
  const titleReads = [];
  page.on('request', r => { if (/\/movie\/40102(?:[?#]|$)/.test(r.url())) titleReads.push(r.url()); });
  await play(page, MOVIE);
  await waitPlaying(page);
  assert.deepStrictEqual(titleReads, [], 'the cached title page names the files');
  const player = (await playerLog(page)).filter(e => e.kind === 'player');
  assert.strictEqual(player.length, 1);
  assert.strictEqual(player[0].query.mfid, '2176222', 'the first listed file, as before');
  const entries = await page.evaluate(() => window.__p.Log.entries().map(e => e.msg).join('\n'));
  assert.ok(/files 2 \(from the title page already read\)/.test(entries), entries);
  assert.ok(/playing ORG after \d+\.\d s \(data \d+\.\d, src \d+\.\d, (?:[a-z]+ \d+\.\d, )*meta \d+\.\d.*stream 2 of 5\)/.test(entries), entries);
  await done(page);
});

t.test('desktop browsers play a decodable ORG MP4 first (no HLS attempt)', async () => {
  const page = await open({ mbp_len: 120 }, { ua: DESKTOP_UA });
  await play(page, MOVIE);
  await waitPlaying(page);
  assert.strictEqual((await info(page)).label, 'ORG');
  const media = (await playerLog(page)).filter(e => e.kind === 'media');
  assert.ok(media.length && media.every(m => m.path === '/__media/ep.wav'), JSON.stringify(media.map(m => m.path)));
  await done(page);
});

t.test('resume at var seconds, with the chip; Down then OK starts over', async () => {
  const page = await open({ mbp_len: 300, mbp_seconds: 95 });
  await play(page, MOVIE);
  await waitPlaying(page);
  near((await video(page)).t, 95, 2.5, 'resumed position');
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-chip.is-on'));
  assert.strictEqual(await text(page, '#mbptv-player .mbp-chip'), 'Resumed at 1:35 · press Down for Start over');
  await page.keyboard.press('ArrowDown');
  assert.ok((await rootClass(page)).indexOf(' is-osd ') >= 0);
  assert.strictEqual(await focusedAction(page), 'start-over');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#mbptv-player video').currentTime < 5);
  assert.strictEqual((await video(page)).paused, false);
  await done(page);
});

t.test('no resume when seconds is at most 10 or within the last minute', async () => {
  for (const [secs, len] of [[8, 300], [250, 300]]) {
    const page = await open({ mbp_len: len, mbp_seconds: secs });
    await play(page, MOVIE);
    await waitPlaying(page);
    assert.ok((await video(page)).t < 5, `seconds=${secs} must not resume`);
    assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-chip.is-on')), false);
    await done(page);
  }
});

t.test('OSD appears on any key, hides after 4 s while playing and stays while paused; OK pauses and plays', async () => {
  const page = await open({ mbp_len: 300 });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitClass(page, 'is-osd', false, 7000);
  await page.keyboard.press('ArrowUp');
  assert.ok((await rootClass(page)).indexOf(' is-osd ') >= 0, 'Up shows the OSD');
  const shownAt = Date.now();
  await waitClass(page, 'is-osd', false, 7000);
  near(Date.now() - shownAt, 4000, 900, 'auto-hide delay (ms)');
  await page.keyboard.press('Enter');
  assert.strictEqual((await video(page)).paused, true, 'OK pauses');
  assert.ok((await rootClass(page)).indexOf(' is-paused ') >= 0);
  assert.ok((await rootClass(page)).indexOf(' is-osd ') >= 0);
  await page.waitForTimeout(5000);
  assert.ok((await rootClass(page)).indexOf(' is-osd ') >= 0, 'the OSD stays while paused');
  await page.keyboard.press('Enter');
  assert.strictEqual((await video(page)).paused, false, 'OK plays');
  await waitClass(page, 'is-osd', false, 7000);
  await done(page);
});

t.test('progress posts the site payload to movie_progress (pause, seek, periodic) and reports onProgress', async () => {
  // 1200 s of media, so over = (runtime - time < 300) is 0 early on, as in a real film.
  const page = await open({ mbp_len: 1200 }, { config: { seekReport: 300 } });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 2.2);
  assert.strictEqual((await progressLog(page)).length, 0, 'nothing posted before a reason to');
  await page.keyboard.press('Enter');
  await waitPosts(page, 1);
  const first = (await progressLog(page))[0];
  assert.strictEqual(first.path, '/index/index/movie_progress');
  assert.strictEqual(first.method, 'POST');
  assert.strictEqual(first.xrw, 'XMLHttpRequest');
  assert.ok(/application\/x-www-form-urlencoded/.test(first.type));
  assert.deepStrictEqual(Object.keys(first.body), ['type', 'mid', 'over', 'seconds', 'mp4_id']);
  assert.strictEqual(first.body.type, 'movie');
  assert.strictEqual(first.body.mid, '40102');
  assert.strictEqual(first.body.over, '0');
  assert.strictEqual(first.body.mp4_id, '886357');
  assert.ok(/^\d+$/.test(first.body.seconds) && +first.body.seconds >= 2, 'integer seconds: ' + first.body.seconds);
  const ev = (await events(page, 'progress')).map(e => e.info);
  assert.deepStrictEqual(Object.keys(ev[0]).sort(), ['duration', 'episode', 'id', 'kind', 'over', 'season', 'seconds']);
  assert.strictEqual(ev[0].kind, 'movie');
  assert.strictEqual(ev[0].seconds, +first.body.seconds);
  assert.strictEqual(ev[0].duration, 1200);
  await page.waitForTimeout(1500);
  assert.strictEqual((await progressLog(page)).length, 1, 'no duplicate post while paused');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await waitPosts(page, 2, 5000);
  const seek = (await progressLog(page))[1];
  assert.ok(+seek.body.seconds >= 12, 'a seek posts the new position: ' + seek.body.seconds);
  await done(page);

  // Periodic posts while playing (every 20 s by default; 1.2 s here), each at a new second.
  const page2 = await open({ mbp_len: 1200 }, { config: { progressEvery: 1200 } });
  await play(page2, MOVIE);
  await waitPlaying(page2);
  await waitPosts(page2, 2, 8000);
  const ticks = (await progressLog(page2)).map(p => +p.body.seconds);
  assert.ok(ticks[1] > ticks[0], 'ticks advance: ' + ticks.join(', '));
  await done(page2);
});

t.test('Left/Right seek by 10 s after 400 ms; holding accelerates to 30 s and 60 s steps with a bubble', async () => {
  const page = await open({ mbp_len: 1200 });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 1);
  let t0 = (await video(page)).t;
  await page.keyboard.press('ArrowRight');
  assert.ok((await rootClass(page)).indexOf(' is-seeking ') >= 0, 'bubble shown while the seek is pending');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-bubble-delta'), '+10 s');
  assert.ok((await video(page)).t < t0 + 3, 'not applied before 400 ms');
  await page.waitForTimeout(700);
  near((await video(page)).t, t0 + 10, 1.5, 'after Right');
  assert.ok((await rootClass(page)).indexOf(' is-seeking ') < 0);
  t0 = (await video(page)).t;
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(700);
  near((await video(page)).t, t0 - 10, 1.5, 'after Left');
  // Hold Right: 1 press + 19 auto-repeats = 10 + 4x10 + 10x30 + 5x60 = 650 s.
  t0 = (await video(page)).t;
  for (let i = 0; i < 20; i++) await page.keyboard.down('ArrowRight');
  await page.keyboard.up('ArrowRight');
  const bubble = await text(page, '#mbptv-player .mbp-bubble-delta');
  assert.ok(/^\+\d+:\d\d$/.test(bubble), 'bubble shows the jump: ' + bubble);
  await page.waitForTimeout(800);
  const jumped = (await video(page)).t - t0;
  assert.ok(jumped > 600 && jumped < 700, 'hold acceleration reached 60 s steps: jumped ' + jumped);
  await done(page);
});

t.test('quality sheet lists Auto/1080p/720p/360p/Original (+ files) and switching keeps the position', async () => {
  const page = await open({ mbp_len: 300, mbp_seconds: 60 });
  await play(page, MOVIE);
  await waitPlaying(page);
  // The resume chip is up, so Down lands on Start over; Quality sits just left of it.
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await focusedAction(page), 'start-over');
  await page.keyboard.press('ArrowLeft');
  assert.strictEqual(await focusedAction(page), 'quality');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="quality"] .mbp-btn-value'), 'Original');
  await page.keyboard.press('Enter');
  await waitClass(page, 'is-sheet');
  const rows = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player [data-quality]'), r => ({
    q: r.getAttribute('data-quality'), cur: r.classList.contains('is-current'), focus: r.classList.contains('is-focused'), meta: (r.querySelector('.mbp-opt-meta') || {}).textContent || '' })));
  assert.deepStrictEqual(rows.map(r => r.q), ['AUTO', '1080p', '720p', '360p', 'ORG']);
  assert.deepStrictEqual(rows.filter(r => r.cur).map(r => r.q), ['ORG']);
  assert.deepStrictEqual(rows.filter(r => r.focus).map(r => r.q), ['ORG']);
  assert.ok(/1920 × 1080/.test(rows[4].meta) && /H\.264/.test(rows[4].meta), rows[4].meta);
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#mbptv-player [data-file-index]').length), 2, 'both movie files listed');
  const before = (await video(page)).t;
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await waitClass(page, 'is-sheet', false);
  await waitPlaying(page, { label: '720p' });
  await waitTime(page, before - 3, 8000);
  near((await video(page)).t, before, 3, 'position after the switch');
  const media = (await playerLog(page)).filter(e => e.kind === 'media' && e.query.q === '720p');
  assert.ok(media.length && media[0].query.audio === 'aac', '720p HLS requested with audio=aac');
  await done(page);
});

t.test('Skip Intro: floating pill and button while currentTime < skips.start; OK skips to the intro end', async () => {
  const page = await open({ mbp_len: 300, mbp_skips: '40,-1' }, { config: { osdHide: 1200 } });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitClass(page, 'is-osd', false);
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-skip.is-on.is-focused'));
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-btns [data-action="skip-intro"]')), true, 'Skip Intro in the buttons row');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-skip.is-on')), false, 'the pill hides while the OSD shows');
  await waitClass(page, 'is-osd', false);
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-skip.is-on'));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#mbptv-player video').currentTime >= 40);
  assert.strictEqual((await video(page)).paused, false, 'OK on the pill skips instead of pausing');
  await page.waitForFunction(() => !document.querySelector('#mbptv-player .mbp-skip.is-on'));
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-btns [data-action="skip-intro"]')), false);
  await done(page);
});

t.test('Up Next near the end counts down and autoplays S1E2 in the same player (Netflix style)', async () => {
  const page = await open({ mbp_len: 60 }, { config: { upNextCount: 3 } });
  await play(page, EPISODE);
  await waitPlaying(page);
  assert.strictEqual(await text(page, '#mbptv-player .mbp-title'), 'Putin: A Russian Spy Story');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-sub-code'), 'S1 · E1');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-sub-text'), 'The Rise of Putin');
  await page.keyboard.press('ArrowDown');
  assert.ok(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-btns [data-action="next-episode"]')), 'Next Episode button');
  await setTime(page, 34);
  await waitClass(page, 'is-upnext');
  assert.ok(/^Next episode in [123]$/.test(await text(page, '#mbptv-player .mbp-un-count')));
  assert.strictEqual(await text(page, '#mbptv-player .mbp-un-title'), 'Episode 2', 'no title known for S1E2 in the mock season page');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-un-meta'), 'S1 · E2');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player [data-action="play-next"]').classList.contains('is-focused')), true);
  await page.waitForFunction(() => window.__p.events.some(e => e.type === 'next'), null, { timeout: 8000 });
  const next = (await events(page, 'next'))[0].req;
  assert.strictEqual(next.kind, 'tv');
  assert.strictEqual(next.id, '17417');
  assert.strictEqual(next.season, 1);
  assert.strictEqual(next.episode, 2);
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), true, 'the same player continues');
  await waitPlaying(page, { episode: 2 });
  assert.strictEqual(await text(page, '#mbptv-player .mbp-sub-code'), 'S1 · E2');
  const log = await playerLog(page);
  assert.deepStrictEqual(log.filter(e => e.kind === 'tv_file').map(e => e.body), [
    { tid: '17417', season: '1', episode: '1' }, { tid: '17417', season: '1', episode: '2' }]);
  assert.deepStrictEqual(log.filter(e => e.kind === 'player').map(e => e.query.tfid), ['174170101', '174170102']);
  const posts = await progressLog(page);
  const e1 = posts.filter(p => p.body.episode === '1');
  assert.ok(e1.length, 'progress for E1');
  const lastE1 = e1[e1.length - 1];
  assert.strictEqual(lastE1.path, '/index/index/tv_progress');
  assert.deepStrictEqual(Object.keys(lastE1.body), ['type', 'tid', 'season', 'episode', 'over', 'seconds', 'mp4_id']);
  assert.strictEqual(lastE1.body.type, 'tv');
  assert.strictEqual(lastE1.body.tid, '17417');
  assert.strictEqual(lastE1.body.over, '1', 'E1 is saved as watched');
  assert.strictEqual((await events(page, 'close')).length, 0, 'no onClose between episodes');
  await done(page);
});

t.test('Up Next: Hide dismisses and keeps watching; at the end it returns and Back exits with over=1', async () => {
  const page = await open({ mbp_len: 60 });
  await play(page, EPISODE);
  await waitPlaying(page);
  await setTime(page, 36);
  await waitClass(page, 'is-upnext');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-un-count'), 'Next episode in 10');
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player [data-action="hide-next"]').classList.contains('is-focused')), true);
  await page.keyboard.press('Enter');
  await waitClass(page, 'is-upnext', false);
  await page.waitForTimeout(1500);
  assert.ok((await rootClass(page)).indexOf(' is-upnext ') < 0, 'stays dismissed');
  const i = await info(page);
  assert.strictEqual(i.episode, 1);
  assert.strictEqual(i.state, 'playing');
  assert.strictEqual((await video(page)).paused, false, 'keeps watching the credits');
  await setTime(page, 58);
  await waitClass(page, 'is-upnext', true, 8000);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__p.NativePlayer.active());
  const close = (await events(page, 'close'))[0].info;
  assert.strictEqual(close.reason, 'ended');
  assert.strictEqual(close.over, 1);
  assert.strictEqual((await events(page, 'next')).length, 0);
  const last = (await progressLog(page)).pop();
  assert.strictEqual(last.body.over, '1');
  await done(page);
});

t.test('Up Next: Back dismisses the card without leaving the player', async () => {
  const page = await open({ mbp_len: 60 });
  await play(page, EPISODE);
  await waitPlaying(page);
  await setTime(page, 36);
  await waitClass(page, 'is-upnext');
  await page.keyboard.press('Escape');
  await waitClass(page, 'is-upnext', false);
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), true);
  assert.strictEqual((await events(page, 'close')).length, 0);
  await done(page);
});

t.test('Ch- plays the previous episode and Ch+ the next one', async () => {
  const page = await open({ mbp_len: 60 });
  await play(page, Object.assign({}, EPISODE, { episode: 2, episodeTitle: '' }));
  await waitPlaying(page, { episode: 2 });
  assert.strictEqual(await key(page, 'chdown'), true);
  await waitPlaying(page, { episode: 1 });
  assert.strictEqual(await key(page, 'chup'), true);
  await waitPlaying(page, { episode: 2 });
  assert.deepStrictEqual((await events(page, 'next')).map(e => e.req.episode), [1, 2]);
  await done(page);
});

t.test('Back exits: onClose info, a final progress post with the right over, screen saver restored', async () => {
  const page = await open({ mbp_len: 600 }, { saver: true });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 3.2);
  await page.keyboard.press('Escape');
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), false);
  assert.strictEqual(await page.evaluate(() => !!document.getElementById('mbptv-player')), false, 'overlay removed');
  const close = await events(page, 'close');
  assert.strictEqual(close.length, 1);
  assert.strictEqual(close[0].info.reason, 'back');
  assert.strictEqual(close[0].info.kind, 'movie');
  assert.strictEqual(close[0].info.over, 0);
  assert.ok(close[0].info.time >= 3, 'time ' + close[0].info.time);
  await waitPosts(page, 1);
  const last = (await progressLog(page)).pop();
  assert.strictEqual(last.body.over, '0');
  assert.ok(+last.body.seconds >= 3);
  assert.deepStrictEqual(await page.evaluate(() => window.__saver), [0, 1], 'SCREEN_SAVER_OFF while playing, ON after exit');
  await done(page);
});

t.test('code -1 from the player endpoint shows its msg; Try website player calls onFallback', async () => {
  const page = await open();
  await play(page, Object.assign({ fileUrl: '/index/index/player?mfid=999' }, MOVIE));
  await page.waitForFunction(() => document.getElementById('mbptv-player').getAttribute('data-state') === 'error');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-err-body'), 'VIP only');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-err-title'), 'This video won’t play here');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player .mbp-err-btns .is-focused').getAttribute('data-action')), 'website');
  await page.keyboard.press('Enter');
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), false);
  const ev = await events(page);
  assert.deepStrictEqual(ev.map(e => e.type), ['open', 'close', 'fallback']);
  assert.strictEqual(ev[1].info.reason, 'fallback');
  assert.strictEqual(ev[2].reason, 'site-error');
  assert.strictEqual(ev[2].req.id, '40102');
  await done(page);
});

t.test('every stream failing shows "This video won’t play here" (streams-failed); Back closes', async () => {
  const page = await open({ mbp_all: 'bad' });
  await play(page, MOVIE);
  await page.waitForFunction(() => document.getElementById('mbptv-player').getAttribute('data-state') === 'error', null, { timeout: 15000 });
  const tried = (await playerLog(page)).filter(e => e.kind === 'media').map(e => e.path);
  // Five candidates; the platform player refuses each HLS one (media error 4), so hls.js tries it as well (4 + 1 + 4).
  assert.strictEqual(new Set(tried).size, 5, 'all five candidates tried: ' + tried.join(', '));
  assert.strictEqual(tried.length, 9, 'HLS candidates also through hls.js: ' + tried.join(', '));
  // The movie has two files: "Try another file" leads; the website's player stays the last resort before Back.
  assert.deepStrictEqual(await errButtons(page), ['other-file*', 'retry', 'website', 'back']);
  assert.ok(/Try another file of this title/.test(await text(page, '#mbptv-player .mbp-err-body')), await text(page, '#mbptv-player .mbp-err-body'));
  assert.ok(/^Tried Auto: .+ · Original: .+ · 1080p: /.test(await text(page, '#mbptv-player .mbp-err-code')), await text(page, '#mbptv-player .mbp-err-code'));
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player .mbp-err-btns .is-focused').getAttribute('data-action')), 'back');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  const fb = await events(page, 'fallback');
  assert.strictEqual(fb[0].reason, 'streams-failed');
  const page2 = await open({ mbp_all: 'bad' });
  await play(page2, MOVIE);
  await page2.waitForFunction(() => document.getElementById('mbptv-player').getAttribute('data-state') === 'error', null, { timeout: 15000 });
  await page2.keyboard.press('Escape');
  assert.strictEqual(await page2.evaluate(() => window.__p.NativePlayer.active()), false);
  assert.strictEqual((await events(page2, 'fallback')).length, 0);
  await done(page);
  await done(page2);
});

t.test('a stalled candidate times out and the next one starts at the same (resume) position', async () => {
  const page = await open({ mbp_auto: 'hang', mbp_len: 300, mbp_seconds: 95 }, { config: { candidateTimeout: 1500 } });
  await play(page, MOVIE);
  await waitPlaying(page, { label: 'ORG' });
  near((await video(page)).t, 95, 2.5, 'resume kept across the fallback');
  const entries = await page.evaluate(() => window.__p.Log.entries().map(e => e.msg).join('\n'));
  assert.ok(/stream AUTO failed: timeout/.test(entries), entries);
  await done(page);
});

t.test('signed out: routes to sign-in through onFallback(req, "signed-out")', async () => {
  for (const req of [EPISODE, MOVIE]) {
    const page = await open({ mockgate: '1' });
    await play(page, req);
    await page.waitForFunction(() => window.__p.events.some(e => e.type === 'fallback'), null, { timeout: 10000 });
    const fb = (await events(page, 'fallback'))[0];
    assert.strictEqual(fb.reason, 'signed-out', req.kind);
    assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), false);
    await done(page);
  }
});

t.test('stop() is idempotent and a stopped session never calls back', async () => {
  const page = await open({ mbp_len: 300 });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 1.5);
  const r = await page.evaluate(() => [window.__p.NativePlayer.stop('test'), window.__p.NativePlayer.stop('test'), window.__p.NativePlayer.active(), window.__p.NativePlayer.info()]);
  assert.deepStrictEqual(r, [true, false, false, null]);
  await page.waitForTimeout(600);
  assert.strictEqual((await events(page, 'close')).length, 1);
  const posts = (await progressLog(page)).length;
  await page.waitForTimeout(1200);
  assert.strictEqual((await progressLog(page)).length, posts);
  // Back during loading cancels the pending requests; nothing plays later.
  await page.evaluate(() => fetch('/__mock/player-log?reset=1'));
  await page.context_.addCookies([{ name: 'mbp_delay', value: '1500', url: origin }]);
  await play(page, MOVIE);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(2500);
  assert.strictEqual(await page.evaluate(() => window.__p.NativePlayer.active()), false);
  assert.strictEqual((await playerLog(page)).filter(e => e.kind === 'media').length, 0, 'no stream loaded after cancel');
  assert.strictEqual((await events(page, 'close')).length, 2);
  await done(page);
});

/* ---------- review fixes: stalls, held keys, autoplay rules, expiring links, background, bad site marks ---------- */

const errorState = page => page.waitForFunction(() => { const r = document.getElementById('mbptv-player'); return r && r.getAttribute('data-state') === 'error'; }, null, { timeout: 20000 });
const errButtons = page => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player .mbp-err-btns [data-action]'),
  b => b.getAttribute('data-action') + (b.classList.contains('is-focused') ? '*' : '')));
const setHidden = (page, hidden) => page.evaluate(h => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
  const e = document.createEvent('Event'); e.initEvent('visibilitychange', false, false); document.dispatchEvent(e);
}, hidden);
const logText = page => page.evaluate(() => window.__p.Log.entries().map(e => e.msg).join('\n'));

t.test('a stream that loads its metadata but never starts is replaced (no endless "Starting playback")', async () => {
  const page = await open({ mbp_len: 120 }, { config: { candidateTimeout: 1500 } });
  // ORG answers (metadata loads) but play() never resolves, as when HLS segments hang or an audio track is unsupported.
  await page.evaluate(() => {
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return /q=org/.test(this.src) ? new Promise(() => {}) : orig.call(this); };
  });
  await play(page, MOVIE);
  await waitPlaying(page, { label: '1080p' });
  const entries = await logText(page);
  assert.ok(/stream AUTO failed: media-\d/.test(entries), entries);
  assert.ok(/stream ORG failed: no-start/.test(entries), entries);
  await done(page);
});

t.test('loading never hangs: after startBudget the error card offers Try again', async () => {
  const page = await open({ mbp_delay: 20000 }, { config: { startBudget: 1500 } });
  await play(page, MOVIE);
  await errorState(page);
  assert.deepStrictEqual(await errButtons(page), ['retry', 'website*', 'back']);
  assert.ok(/taking too long/.test(await text(page, '#mbptv-player .mbp-err-body')));
  await done(page);
});

t.test('held keys act once: OK toggles pause once, Back on Up Next only hides the card; fast taps without the repeat flag accelerate', async () => {
  const page = await open({ mbp_len: 600 });
  await play(page, MOVIE);
  await waitPlaying(page);
  await page.evaluate(() => { window.__pp = []; const v = document.querySelector('#mbptv-player video');
    v.addEventListener('pause', () => window.__pp.push('pause')); v.addEventListener('play', () => window.__pp.push('play')); });
  for (let i = 0; i < 9; i++) { await page.keyboard.down('Enter'); await page.waitForTimeout(40); }
  await page.keyboard.up('Enter');
  await page.waitForTimeout(300);
  assert.deepStrictEqual(await page.evaluate(() => window.__pp), ['pause'], 'one toggle for a held OK');
  assert.strictEqual((await video(page)).paused, true);
  // Some remotes deliver a held key as plain keydowns: 20 Right presses 70 ms apart still accelerate.
  await page.keyboard.press('Enter');
  const t0 = (await video(page)).t;
  for (let i = 0; i < 20; i++) { await key(page, 'right'); await page.waitForTimeout(70); }
  await page.waitForTimeout(900);
  const jumped = (await video(page)).t - t0;
  assert.ok(jumped > 300, 'fast presses accelerate: jumped ' + jumped);
  await done(page);

  const page2 = await open({ mbp_len: 60 });
  await play(page2, EPISODE);
  await waitPlaying(page2);
  await setTime(page2, 36);
  await waitClass(page2, 'is-upnext');
  for (let i = 0; i < 5; i++) { await page2.keyboard.down('Escape'); await page2.waitForTimeout(40); }
  await page2.keyboard.up('Escape');
  await waitClass(page2, 'is-upnext', false);
  assert.strictEqual(await page2.evaluate(() => window.__p.NativePlayer.active()), true, 'the repeats of Back did not close the player');
  assert.strictEqual((await events(page2, 'close')).length, 0);
  await done(page2);
});

t.test('autoplay off: the Up Next card has no countdown and waits at the end; OK plays the next episode', async () => {
  const page = await open({ mbp_len: 60 });
  await play(page, Object.assign({}, EPISODE, { autoplayNext: false }));
  await waitPlaying(page);
  await setTime(page, 36);
  await waitClass(page, 'is-upnext');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-un-count'), 'Up next');
  await setTime(page, 58.5);
  await page.waitForFunction(() => document.querySelector('#mbptv-player video').ended, null, { timeout: 8000 });
  await page.waitForTimeout(2500);
  assert.strictEqual((await info(page)).episode, 1, 'no autoplay at the end');
  assert.strictEqual((await events(page, 'next')).length, 0);
  assert.ok((await rootClass(page)).indexOf(' is-upnext ') >= 0, 'the card waits');
  await page.keyboard.press('Enter');
  await waitPlaying(page, { episode: 2 });
  assert.strictEqual((await events(page, 'next')).length, 1);
  await done(page);
});

t.test('"Still watching?": after N unattended autoplays the card pauses and waits; a key resets the count', async () => {
  const page = await open({ mbp_len: 30 }, { config: { upNextCount: 1, stillWatchingAfter: 2 } });
  await play(page, EPISODE);
  await page.waitForFunction(() => / is-still /.test(' ' + (document.getElementById('mbptv-player') || {}).className + ' '), null, { timeout: 60000 });
  assert.strictEqual((await info(page)).episode, 3, 'two episodes autoplayed');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-un-count'), 'Still watching?');
  await page.waitForTimeout(400);
  assert.strictEqual((await video(page)).paused, true, 'paused while asking');
  await page.waitForTimeout(2000);
  assert.strictEqual((await info(page)).episode, 3, 'no countdown');
  assert.deepStrictEqual((await events(page, 'next')).map(e => e.req.episode), [2, 3]);
  const over = (await progressLog(page)).filter(p => p.body.over === '1').map(p => p.body.episode);
  assert.ok(over.indexOf('1') >= 0 && over.indexOf('2') >= 0, 'E1 and E2 saved as watched: ' + over);
  await page.keyboard.press('Enter');
  await waitPlaying(page, { episode: 4 });
  await waitClass(page, 'is-upnext', true, 15000);
  assert.ok(/^Next episode in \d$/.test(await text(page, '#mbptv-player .mbp-un-count')), 'counting down again after a key');
  await done(page);
});

t.test('stream links expiring mid-film: fresh player data is fetched and playback continues at the same place', async () => {
  const page = await open({ mbp_len: 1800 }, { ua: DESKTOP_UA, config: { candidateTimeout: 4000, stallTimeout: 4000 } });
  await play(page, MOVIE);
  await waitPlaying(page);
  await page.waitForTimeout(1200);
  await page.evaluate(() => fetch('/__mock/expire-links'));
  await setTime(page, 1500);
  await page.waitForFunction(() => { const c = document.querySelector('#mbptv-player .mbp-chip.is-on'); return c && c.textContent === 'Reconnected'; }, null, { timeout: 20000 });
  await waitPlaying(page);
  near((await video(page)).t, 1500, 4, 'position after the new links');
  assert.strictEqual((await playerLog(page)).filter(e => e.kind === 'player').length, 2, 'one refetch of the player data');
  assert.ok((await progressLog(page)).some(p => p.body.seconds === '1500'), 'the position was saved at the switch');
  assert.ok(/fetching fresh stream links/.test(await logText(page)));
  await done(page);
});

t.test('every stream failing mid-film: progress kept (with the duration), Try again focused and continuing there', async () => {
  const page = await open({ mbp_len: 1800 }, { ua: DESKTOP_UA, config: { candidateTimeout: 4000, stallTimeout: 4000 } });
  await play(page, MOVIE);
  await waitPlaying(page);
  await page.waitForTimeout(1200);
  await page.context_.addCookies([{ name: 'mbp_all', value: 'bad', url: origin }]);
  await page.evaluate(() => fetch('/__mock/expire-links'));
  await setTime(page, 1500);
  await errorState(page);
  assert.deepStrictEqual(await errButtons(page), ['retry*', 'website', 'back']);
  assert.strictEqual((await playerLog(page)).filter(e => e.kind === 'player').length, 2, 'fresh links were tried once');
  const posts = await progressLog(page);
  assert.ok(posts.some(p => p.body.seconds === '1500' && p.body.over === '0'), 'saved at 1500: ' + JSON.stringify(posts.map(p => p.body.seconds)));
  await page.context_.addCookies([{ name: 'mbp_all', value: 'ok', url: origin }]);
  await page.keyboard.press('Enter');
  await waitPlaying(page);
  near((await video(page)).t, 1500, 4, 'Try again continues where it stopped');
  assert.strictEqual((await events(page, 'close')).length, 0);
  await page.keyboard.press('Escape');
  const close = (await events(page, 'close'))[0].info;
  near(close.duration, 1800, 1, 'onClose duration');
  await done(page);
});

t.test('the app going to the background pauses, saves and lets the screen saver run; coming back shows the paused controls', async () => {
  const page = await open({ mbp_len: 600 }, { saver: true });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 1.5);
  await setHidden(page, true);
  const t0 = (await video(page)).t;
  await page.waitForTimeout(1200);
  const v = await video(page);
  assert.strictEqual(v.paused, true);
  near(v.t, t0, 0.3, 'no playback while hidden');
  assert.deepStrictEqual(await page.evaluate(() => window.__saver), [0, 1]);
  assert.strictEqual((await progressLog(page)).length, 1, 'the place is saved');
  await setHidden(page, false);
  const cls = await rootClass(page);
  assert.ok(cls.indexOf(' is-osd ') >= 0 && cls.indexOf(' is-paused ') >= 0, cls);
  await page.keyboard.press('Enter');
  assert.strictEqual((await video(page)).paused, false, 'OK carries on');
  await done(page);
});

t.test('implausible intro/credits marks from the site are ignored', async () => {
  const page = await open({ mbp_len: 1500, mbp_skips: '-1,200' });
  await play(page, EPISODE);
  await waitPlaying(page);
  await setTime(page, 201);
  await page.waitForTimeout(2000);
  assert.ok((await rootClass(page)).indexOf(' is-upnext ') < 0, 'no Up Next 20 minutes before the end');
  assert.strictEqual((await events(page, 'next')).length, 0);
  assert.ok(!(await progressLog(page)).some(p => p.body.over === '1'), 'not marked watched');
  await done(page);

  const page2 = await open({ mbp_len: 1500, mbp_skips: '1400,-1' }, { config: { osdHide: 800 } });
  await play(page2, EPISODE);
  await waitPlaying(page2);
  await waitClass(page2, 'is-osd', false);
  assert.strictEqual(await page2.evaluate(() => !!document.querySelector('#mbptv-player .mbp-skip.is-on')), false, 'no Skip Intro pill');
  await page2.keyboard.press('Enter');
  assert.strictEqual((await video(page2)).paused, true, 'OK pauses as usual');
  await page2.keyboard.press('ArrowDown');
  assert.strictEqual(await page2.evaluate(() => !!document.querySelector('#mbptv-player [data-action="skip-intro"]')), false);
  await done(page2);
});

t.test('play() while active replaces the session in the same overlay (no onOpen/onClose; the old one is saved)', async () => {
  const page = await open({ mbp_len: 600 });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 2.2);
  await page.evaluate(() => { window.__root = document.getElementById('mbptv-player'); });
  assert.strictEqual(await play(page, EPISODE), true);
  await waitPlaying(page, { kind: 'tv', episode: 1 });
  assert.strictEqual(await page.evaluate(() => window.__root === document.getElementById('mbptv-player')), true, 'same overlay');
  assert.deepStrictEqual((await events(page)).filter(e => e.type === 'open' || e.type === 'close').map(e => e.type), ['open']);
  const movie = (await progressLog(page)).filter(p => p.kind === 'movie');
  assert.ok(movie.length && +movie[movie.length - 1].body.seconds >= 2, 'the movie position was saved');
  await page.keyboard.press('Escape');
  const close = await events(page, 'close');
  assert.strictEqual(close.length, 1);
  assert.strictEqual(close[0].info.kind, 'tv');
  await done(page);
});

t.test('Next Episode crosses into the next season (S1E10 -> S2E1)', async () => {
  const page = await open({ mbp_len: 60, mbp_eps: 10 });
  await play(page, Object.assign({}, EPISODE, { episode: 10, episodeTitle: '' }));
  await waitPlaying(page, { episode: 10 });
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="next-episode"] .mbp-btn-value'), 'S2 E1');
  assert.strictEqual(await key(page, 'chup'), true);
  await waitPlaying(page, { season: 2, episode: 1 });
  assert.strictEqual(await text(page, '#mbptv-player .mbp-sub-code'), 'S2 · E1');
  const log = await playerLog(page);
  assert.deepStrictEqual(log.filter(e => e.kind === 'tv_file').map(e => e.body.season + 'x' + e.body.episode), ['1x10', '2x1']);
  assert.deepStrictEqual(log.filter(e => e.kind === 'player').map(e => e.query.tfid), ['174170110', '174170201']);
  await done(page);
});

t.test('pointer input stays in the player (never reaches the website underneath)', async () => {
  const page = await open({ mbp_len: 120 });
  await page.evaluate(() => { document.getElementById('mbptv').className = 'is-hidden'; window.__clicks = 0; document.addEventListener('click', () => { window.__clicks++; }); });
  await play(page, MOVIE);
  await waitPlaying(page);
  assert.strictEqual(await page.evaluate(() => !!document.elementFromPoint(960, 540).closest('#mbptv-player')), true, 'the player takes pointer hits');
  await page.mouse.click(960, 540);
  assert.strictEqual(await page.evaluate(() => window.__clicks), 0);
  assert.strictEqual((await video(page)).paused, false);
  await done(page);
});

/* ---------- subtitles ---------- */

const mockExtra = require('../tools/mock-extra.cjs');
const subs = page => page.evaluate(() => {
  const r = document.querySelector('#mbptv-player .mbp-subs');
  if (!r) return null;
  const lines = Array.prototype.map.call(r.querySelectorAll('.mbp-subs-line'), l => l.textContent);
  return { on: r.classList.contains('is-on') && getComputedStyle(r).visibility === 'visible', lines, text: lines.join('|') };
});
async function waitSubs(page, text, timeout = 8000) {
  await page.waitForFunction(t => {
    const r = document.querySelector('#mbptv-player .mbp-subs');
    if (!r) return false;
    const lines = Array.prototype.map.call(r.querySelectorAll('.mbp-subs-line'), l => l.textContent).join('|');
    return t === '' ? !r.classList.contains('is-on') : r.classList.contains('is-on') && lines === t;
  }, text, { timeout });
}
/* Pause where the test wants to look (the picture holds still, so cue timing is exact). */
const holdAt = (page, x) => page.evaluate(t => { const v = document.querySelector('#mbptv-player video'); v.pause(); v.currentTime = t; }, x);
const subRows = page => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player [data-sheet="player-subtitles"] [data-subtitle]'), r => ({
  v: r.getAttribute('data-subtitle'), label: r.querySelector('.mbp-opt-label').textContent, meta: (r.querySelector('.mbp-opt-meta') || {}).textContent || '',
  cur: r.classList.contains('is-current'), focus: r.classList.contains('is-focused') })));
const pref = (page, name) => page.evaluate(n => window.__p.Prefs.get(n), name);
async function pickSub(page, value) {
  if ((await rootClass(page)).indexOf(' is-sheet ') < 0) assert.strictEqual(await key(page, 'yellow'), true);
  const rows = await subRows(page);
  const from = rows.findIndex(r => r.focus), to = rows.findIndex(r => r.v === value);
  assert.ok(from >= 0 && to >= 0, 'rows ' + JSON.stringify(rows));
  for (let i = from; i !== to; i += to > from ? 1 : -1) await key(page, to > from ? 'down' : 'up');
  await key(page, 'enter');
}
const waitSub = (page, name, timeout = 10000) => page.waitForFunction(n => { const i = window.__p.NativePlayer.info(); return !!i && i.subtitle === n; }, name, { timeout });

t.test('subtitles: the site panel parses in site order; SRT/VTT cues; UTF-8, windows-1256 and legacy decoding', async () => {
  const page = await open();
  const panelText = mockExtra.playerText('mock.test', { mfid: '1' }, { mbp_subs: '1' });
  const bytes = name => Array.from(mockExtra.SUB_FILES[name]());
  const out = await page.evaluate(([text, tv, en, vtt, ar]) => {
    const P = window.__p.NativePlayer;
    const u8 = a => new Uint8Array(a);
    const noBlank = '1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:02,500 --> 00:00:03,000\nTwo\n';
    const overlap = P._cues('00:00:01.000 --> 00:00:10.000\nLong\n\n00:00:02.000 --> 00:00:03.000\nShort\n');
    return {
      list: P._parse(text).subtitles, tvList: P._parse(tv).subtitles,
      en: P._cues(P._decodeSub(u8(en), 'en', 'English')), vtt: P._cues(P._decodeSub(u8(vtt), 'en', 'English')), noBlank: P._cues(noBlank),
      ar: P._decodeSub(u8(ar), 'ar', 'Arabic'), arByName: P._decodeSub(u8(ar), '', 'Arabic'),
      utf8Ar: P._decodeSub(new TextEncoder().encode('مرحبا'), 'ar', 'Arabic'),
      bom: P._decodeSub(u8([0xEF, 0xBB, 0xBF, 0x48, 0x69]), 'fr', ''), latin: P._decodeSub(u8([0x63, 0x61, 0x66, 0xE9]), 'fr', 'French'),
      at25: P._cuesAt(overlap, 2.5), at5: P._cuesAt(overlap, 5), at0: P._cuesAt(overlap, 0.5)
    };
  }, [panelText, fixture('player-tv.txt'), bytes('en.srt'), bytes('en2.vtt'), bytes('ar-1256.srt')]);
  assert.deepStrictEqual(out.list.map(l => l.name), ['English', 'Arabic', 'Spanish', 'French'], 'the language list gives the order; template lists are dropped');
  const en = out.list[0];
  assert.deepStrictEqual(en.files.map(f => [f.sid, f.lang, f.delay, f.url]), [['9001', 'en', 0, 'http://mock.test/__subs/en.srt'], ['9002', 'en', 2, 'http://mock.test/__subs/en2.vtt']]);
  assert.strictEqual(en.files[0].name, '[en]Mock.Movie.2026.1080p.WEB.en.srt');
  assert.strictEqual(out.list[1].code, 'ar');
  assert.deepStrictEqual(out.tvList, [], 'no panel, no subtitles');
  assert.deepStrictEqual(out.en.map(c => [c.start, c.end]), [[1, 3], [4, 6], [8, 10.5], [20, 40]]);
  assert.strictEqual(out.en[0].text, 'Hello <i>there</i>');
  assert.strictEqual(out.en[1].text, 'Second cue\nwith two lines');
  assert.deepStrictEqual(out.vtt.map(c => [c.start, c.end, c.text]), [[5, 7, 'Delayed cue'], [20, 42, '<c.yellow>Second English file</c>']]);
  assert.deepStrictEqual(out.noBlank.map(c => c.text), ['One', 'Two'], 'cue numbers end a cue even without blank lines');
  assert.strictEqual(out.ar.split(/\r?\n/)[2], 'مرحبا بالعالم', 'windows-1256 Arabic');
  assert.strictEqual(out.arByName.split(/\r?\n/)[2], 'مرحبا بالعالم', 'the language name picks the legacy encoding too');
  assert.strictEqual(out.utf8Ar, 'مرحبا', 'valid UTF-8 wins over the legacy encoding');
  assert.strictEqual(out.bom, 'Hi');
  assert.strictEqual(out.latin, 'café', 'windows-1252 for other languages');
  assert.deepStrictEqual(out.at25, { list: [0, 1], next: 3 }, 'overlapping cues show together');
  assert.deepStrictEqual(out.at5, { list: [0], next: 10 });
  assert.deepStrictEqual(out.at0, { list: [], next: 1 });
  await done(page);
});

t.test('subtitles: the Subtitles sheet lists Off + every file; choosing English shows timed cues (markup safe), lifted above the OSD; English · 2 applies its delay; Off', async () => {
  const page = await open({ mbp_len: 120, mbp_subs: '1' });
  await play(page, MOVIE);
  await waitPlaying(page);
  assert.strictEqual((await info(page)).subtitle, '', 'first run: off');
  assert.strictEqual(await pref(page, 'subtitleLang'), undefined);
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="subtitles"] .mbp-btn-value'), 'Off');
  await key(page, 'yellow');
  await waitClass(page, 'is-sheet');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-sheet-title'), 'Choose subtitles');
  const rows = await subRows(page);
  assert.deepStrictEqual(rows.map(r => r.v), ['off', '0:0', '0:1', '1:0', '2:0', '3:0']);
  assert.deepStrictEqual(rows.map(r => r.label), ['Off', 'English', 'English · 2', 'Arabic', 'Spanish', 'French']);
  assert.ok(rows[0].cur && rows[0].focus, 'Off is current and focused');
  assert.strictEqual(rows[1].meta, 'Mock.Movie.2026.1080p.WEB.en.srt');
  assert.ok(/Delay \+2 s/.test(rows[2].meta), rows[2].meta);
  await pickSub(page, '0:0');
  await waitSub(page, 'English');
  assert.strictEqual(await pref(page, 'subtitleLang'), 'English', 'the choice is remembered');
  await holdAt(page, 1.5);
  await waitSubs(page, 'Hello there');
  const shape = await page.evaluate(() => {
    const box = document.querySelector('#mbptv-player .mbp-subs-box');
    return { tags: Array.prototype.map.call(box.querySelectorAll('*'), n => n.tagName + (n.className ? '.' + n.className : '')),
      italic: box.querySelector('.mbp-subs-i').textContent, dir: box.querySelector('.mbp-subs-line').getAttribute('dir'),
      size: parseFloat(getComputedStyle(box).fontSize) };
  });
  assert.deepStrictEqual(shape.tags, ['DIV.mbp-subs-line', 'SPAN.mbp-subs-i']);
  assert.strictEqual(shape.italic, 'there');
  assert.strictEqual(shape.dir, 'auto');
  near(shape.size, 49.5, 1, 'medium subtitle size at 1080p (2.75em at 1em = 18px)');
  await holdAt(page, 4.5);
  await waitSubs(page, 'Second cue|with two lines');
  await holdAt(page, 8.5);
  await waitSubs(page, 'Fish & chips x');
  assert.deepStrictEqual(await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player .mbp-subs-box *'), n => n.tagName)),
    ['DIV', 'SPAN'], 'only <b> survives as an element; <font>, <script> and {\\an8} are dropped');
  await holdAt(page, 7);
  await waitSubs(page, '');
  // Lifted above the controls while the OSD shows (paused: the OSD stays).
  await holdAt(page, 25);
  await waitSubs(page, 'A long English cue');
  await waitClass(page, 'is-osd');
  await page.waitForTimeout(450);
  const lift = await page.evaluate(() => ({ subs: document.querySelector('#mbptv-player .mbp-subs-box').getBoundingClientRect().bottom,
    osd: document.querySelector('#mbptv-player .mbp-head').getBoundingClientRect().top }));
  assert.ok(lift.subs <= lift.osd + 2, 'subtitles sit above the OSD: ' + JSON.stringify(lift));
  // English · 2 is WebVTT with data-delay 2: shown at video time + 2 s.
  await pickSub(page, '0:1');
  await waitSub(page, 'English · 2');
  await holdAt(page, 3.5);
  await waitSubs(page, 'Delayed cue');
  await holdAt(page, 2.5);
  await waitSubs(page, '');
  assert.strictEqual(await pref(page, 'subtitleLang'), 'English');
  // Off.
  await holdAt(page, 3.5);
  await waitSubs(page, 'Delayed cue');
  await pickSub(page, 'off');
  await waitSubs(page, '');
  assert.strictEqual(await pref(page, 'subtitleLang'), 'off');
  assert.strictEqual((await info(page)).subtitle, '');
  await done(page);
});

t.test('subtitles: Arabic windows-1256 renders right-to-left; a failing file shows a chip and playback carries on; the site proxy is the fallback', async () => {
  const page = await open({ mbp_len: 120, mbp_subs: '1' });
  await play(page, MOVIE);
  await waitPlaying(page);
  await pickSub(page, '1:0');
  await waitSub(page, 'Arabic');
  await holdAt(page, 5);
  await waitSubs(page, 'مرحبا بالعالم');
  assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#mbptv-player .mbp-subs-line')).direction), 'rtl');
  await page.evaluate(() => document.querySelector('#mbptv-player video').play());
  await waitPlaying(page);
  await pickSub(page, '3:0');
  await page.waitForFunction(() => /French subtitles couldn.t be loaded/.test(document.querySelector('#mbptv-player .mbp-chip.is-on') ? document.querySelector('#mbptv-player .mbp-chip').textContent : ''), null, { timeout: 10000 });
  const i = await info(page);
  assert.strictEqual(i.state, 'playing');
  assert.strictEqual(i.subtitle, '');
  assert.strictEqual((await video(page)).paused, false, 'playback is untouched');
  await waitSubs(page, '');
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="subtitles"] .mbp-btn-value'), 'Off');
  // Spanish: the file itself answers 404, the site's same-origin proxy has it.
  await pickSub(page, '2:0');
  await waitSub(page, 'Spanish');
  await holdAt(page, 5);
  await waitSubs(page, 'Hola desde el proxy');
  const log = (await playerLog(page)).filter(e => e.kind === 'subs');
  assert.ok(log.some(e => !e.proxy && e.path === '/__subs/missing.srt'), 'the French file was tried');
  assert.ok(log.some(e => e.proxy && /\/__subs\/missing\.srt$/.test(e.target)), 'then the proxy');
  const proxied = log.find(e => e.proxy && /proxy-only/.test(e.target));
  assert.ok(proxied && proxied.xrw === 'XMLHttpRequest', 'the proxy is asked like the site does');
  await done(page);
});

t.test('subtitles: the remembered language comes back on the next episode (and the next title); Off is remembered too', async () => {
  const page = await open({ mbp_len: 120, mbp_subs: '1' });
  await page.evaluate(() => window.__p.Prefs.set('subtitleLang', 'Arabic'));
  await play(page, EPISODE);
  await waitPlaying(page);
  await waitSub(page, 'Arabic');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player .mbp-chip.is-on') && /subtitles/i.test(document.querySelector('#mbptv-player .mbp-chip').textContent)), false, 'no chip for the automatic choice');
  assert.strictEqual(await key(page, 'chup'), true);
  await waitPlaying(page, { episode: 2 });
  await waitSub(page, 'Arabic');
  await holdAt(page, 3);
  await waitSubs(page, 'مرحبا بالعالم');
  await pickSub(page, 'off');
  await waitSubs(page, '');
  const before = (await playerLog(page)).filter(e => e.kind === 'subs').length;
  await key(page, 'chup');
  await waitPlaying(page, { episode: 3 });
  await page.waitForTimeout(800);
  assert.strictEqual((await info(page)).subtitle, '');
  assert.strictEqual((await playerLog(page)).filter(e => e.kind === 'subs').length, before, 'Off loads nothing');
  // A new title: the remembered language again (here, English chosen on the sheet).
  await pickSub(page, '0:0');
  await waitSub(page, 'English');
  await play(page, MOVIE);
  await waitPlaying(page, { kind: 'movie' });
  await waitSub(page, 'English');
  await done(page);
});

t.test('subtitles: no Subtitles button without a panel (Yellow says so); a remembered language the title lacks stays off', async () => {
  const page = await open({ mbp_len: 120 });
  await page.evaluate(() => window.__p.Prefs.set('subtitleLang', 'Arabic'));
  await play(page, MOVIE);
  await waitPlaying(page);
  await page.keyboard.press('ArrowDown');
  assert.strictEqual(await page.evaluate(() => !!document.querySelector('#mbptv-player [data-action="subtitles"]')), false);
  await key(page, 'yellow');
  assert.strictEqual(await text(page, '#mbptv-player .mbp-chip'), 'No subtitles for this title');
  assert.ok((await rootClass(page)).indexOf(' is-sheet ') < 0);
  await done(page);
  const page2 = await open({ mbp_len: 120, mbp_subs: 'English,French' });
  await page2.evaluate(() => window.__p.Prefs.set('subtitleLang', 'Arabic'));
  await play(page2, MOVIE);
  await waitPlaying(page2);
  await page2.waitForTimeout(600);
  assert.strictEqual((await info(page2)).subtitle, '');
  assert.strictEqual(await pref(page2, 'subtitleLang'), 'Arabic', 'the remembered choice is kept for titles that have it');
  assert.strictEqual((await playerLog(page2)).filter(e => e.kind === 'subs').length, 0);
  await page2.keyboard.press('ArrowDown');
  assert.strictEqual(await text(page2, '#mbptv-player [data-action="subtitles"] .mbp-btn-value'), 'Off');
  await done(page2);
});

t.test('subtitles: Settings > Subtitle size changes the cue size', async () => {
  const page = await open({ mbp_len: 120, mbp_subs: '1' });
  await page.evaluate(() => { window.__p.Prefs.set('subtitleLang', 'English'); window.__p.Prefs.set('subtitleSize', 'large'); });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitSub(page, 'English');
  await holdAt(page, 2);
  await waitSubs(page, 'Hello there');
  near(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#mbptv-player .mbp-subs-box')).fontSize)), 60.75, 1, 'large (3.375em at 1em = 18px)');
  assert.strictEqual(await page.evaluate(() => document.getElementById('mbptv-player').getAttribute('data-subsize')), 'large');
  await done(page);
});

/* ---------- Tizen stream rules, verified switching, audio languages (docs/PLAYER.md) ---------- */

t.test('stream order (TV): AUTO, MP4 original, 1080p, Matroska original, lower HLS, 4K HLS, then risky originals; VIP placeholder dropped', async () => {
  const page = await open();
  const out = await page.evaluate(() => {
    const P = window.__p.NativePlayer, labels = list => list.map(c => c.label + (c.hls ? '' : ':' + c.kind));
    const hls = (label, w, h, extra) => Object.assign({ type: 'application/x-mpegURL', file: 'https://hls.example/1.m3u8?quality=' + label, label, h265: 0, width: w, height: h }, extra || {});
    const org = ext => ({ type: 'video/mp4', file: 'https://cdn.example/vip/p1/movie.1.original.' + ext + '?KEY1=x', label: 'ORG', h265: 1, width: 3840, height: 2160, hdr: 1 });
    const list = ext => P._parse('var sources = ' + JSON.stringify([org(ext), hls('AUTO', 0, 0), hls('4K', 3840, 2160, { h265: 1, hdr: 1 }), hls('1080p', 1920, 1080), hls('720p', 0, 0), hls('360p', 0, 0)]) + ';').sources;
    const tv = { tv: true, aac: true, canPlay: () => 'probably' };
    const vip = P._parse('var sources = ' + JSON.stringify([{ type: 'video/mp4', file: 'https://www.example/video/vip_only.mp4', label: 'ORG' }, hls('AUTO', 0, 0)]) + ';').sources;
    return {
      mp4: labels(P._order(list('mp4'), Object.assign({ fileName: 'Movie.2160p.WEB-DL.mkv', fileSize: '14.7 GB' }, tv))),
      mkv: labels(P._order(list('mkv'), Object.assign({ fileName: 'Movie.2160p.WEB-DL.DDP5.1.Atmos.mkv', fileSize: '14.7 GB' }, tv))),
      dts: labels(P._order(list('mkv'), Object.assign({ fileName: 'Oppenheimer.2023.2160p.UHD.Bluray.REMUX.HDR10.HEVC.DTS-HD.MA.5.1-GHD.mkv', fileSize: '9 GB' }, tv))),
      truehd: labels(P._order(list('mkv'), Object.assign({ fileName: 'The.Godfather.1972.2160p.x265.10bit.HDR.TrueHD.5.1-RARBG.mkv' }, tv))),
      heavy: labels(P._order(list('mp4'), Object.assign({ fileName: 'Parasite.4K.BDRemux.mp4', fileSize: '77.51 GB' }, tv))),
      desk: labels(P._order(list('mp4'), { tv: false, aac: false, canPlay: () => 'probably', fileSize: '82.21 GB' })),
      vip: labels(P._order(vip, tv))
    };
  });
  assert.deepStrictEqual(out.mp4, ['AUTO', 'ORG:mp4', '1080p', '720p', '360p', '4K']);
  assert.deepStrictEqual(out.mkv, ['AUTO', '1080p', 'ORG:mkv', '720p', '360p', '4K']);
  assert.deepStrictEqual(out.dts, ['AUTO', '1080p', '720p', '360p', '4K', 'ORG:risky'], 'DTS cannot be decoded by the TV');
  assert.deepStrictEqual(out.truehd, ['AUTO', '1080p', '720p', '360p', '4K', 'ORG:risky']);
  assert.deepStrictEqual(out.heavy, ['AUTO', '1080p', '720p', '360p', '4K', 'ORG:risky'], 'an 80 GB remux stalls on Wi-Fi');
  assert.deepStrictEqual(out.desk, ['AUTO', '4K', '1080p', '720p', '360p', 'ORG:risky']);
  assert.deepStrictEqual(out.vip, ['AUTO'], 'the VIP placeholder is never played');
  await done(page);
});

t.test('quality: a rendition that does not play hands back to the stream that was playing, at the same position', async () => {
  const page = await open({ mbp_len: 300, mbp_seconds: 60, mbp_bad: '720p' }, { config: { candidateTimeout: 3000 } });
  await play(page, MOVIE);
  await waitPlaying(page, { label: 'ORG' });
  await waitTime(page, 61);
  await key(page, 'down');
  await key(page, 'left');
  assert.strictEqual(await focusedAction(page), 'quality');
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  await key(page, 'up');
  await key(page, 'up');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player [data-quality].is-focused').getAttribute('data-quality')), '720p');
  const before = (await video(page)).t;
  await key(page, 'enter');
  await page.waitForFunction(() => /720p didn’t play on this TV — playing Original instead/.test(document.querySelector('#mbptv-player .mbp-chip').textContent), null, { timeout: 15000 });
  await waitPlaying(page, { label: 'ORG' });
  near((await video(page)).t, before, 3, 'position kept');
  const log = (await playerLog(page)).filter(e => e.kind === 'media').map(e => e.path + (e.query.q ? '?' + e.query.q : ''));
  assert.deepStrictEqual(log.slice(-2), ['/__media/bad-720p.m3u8', '/__media/ep.wav?org'], 'straight back to the stream that played: ' + log.join(', '));
  await key(page, 'down');
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  const meta = await text(page, '#mbptv-player [data-quality="720p"] .mbp-opt-meta');
  assert.ok(/^Didn’t play here/.test(meta), meta);
  // The site copies 1080p sizes onto lower renditions: no "1920 × 1080" on 720p.
  assert.ok(!/1920/.test(meta), meta);
  await done(page);
});

t.test('a resume position the player ignored is applied again once it plays', async () => {
  const page = await open({ mbp_len: 300, mbp_seconds: 95 });
  await page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    let ignored = 0;
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { configurable: true, get() { return d.get.call(this); },
      set(v) { if (v > 0 && !ignored) { ignored++; return; } d.set.call(this, v); } });
  });
  await play(page, MOVIE);
  await waitPlaying(page);
  await waitTime(page, 94);
  near((await video(page)).t, 95, 3, 'resumed after all');
  assert.ok(/at \d+ instead of 95: seeking again/.test(await logText(page)), await logText(page));
  await done(page);
});

t.test('every stream failing: "Try another file" plays the title\'s other file; when all files failed the website is next', async () => {
  const page = await open({ mbp_all: 'bad' });
  await play(page, MOVIE);
  await errorState(page);
  assert.deepStrictEqual(await errButtons(page), ['other-file*', 'retry', 'website', 'back']);
  await page.evaluate(() => fetch('/__mock/player-log?reset=1'));
  await key(page, 'enter');
  await errorState(page);
  const player = (await playerLog(page)).filter(e => e.kind === 'player');
  assert.strictEqual(player.length, 1);
  assert.strictEqual(player[0].query.mfid, '2215085', 'the second file');
  assert.deepStrictEqual(await errButtons(page), ['retry', 'website*', 'back'], 'both files tried');
  assert.ok(/This TV can’t play the video or audio format of this file\.|None of the available streams/.test(await text(page, '#mbptv-player .mbp-err-body')));
  assert.strictEqual((await events(page, 'open')).length, 1, 'same overlay');
  await done(page);
});

/* A stand-in for the platform's AudioTrackList (Tizen documents HTMLMediaElement.audioTracks; desktop Chrome hides it). */
const fakeTracks = (page, langs) => page.evaluate(list => {
  window.__audioSets = [];
  const make = () => {
    const tracks = list.map((l, i) => ({ id: String(i), kind: 'main', label: l.label || '', language: l.language || '', _on: i === 0 }));
    tracks.forEach(t => Object.defineProperty(t, 'enabled', { get() { return this._on; }, set(v) { this._on = !!v; window.__audioSets.push([this.language, !!v]); } }));
    const L = { length: tracks.length, addEventListener() {}, removeEventListener() {} };
    tracks.forEach((t, i) => { L[i] = t; });
    return L;
  };
  Object.defineProperty(HTMLMediaElement.prototype, 'audioTracks', { configurable: true, get() { return this.__at || (this.__at = make()); } });
}, langs);
const audioRows = page => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player [data-sheet="player-audio"] [data-audio]'), r => ({
  i: r.getAttribute('data-audio'), lang: r.getAttribute('data-audio-lang'), title: r.querySelector('.mbp-opt-label').textContent,
  meta: (r.querySelector('.mbp-opt-meta') || {}).textContent || '', cur: r.classList.contains('is-current'), focus: r.classList.contains('is-focused') })));
async function focusButton(page, action) {
  await key(page, 'down');
  for (let i = 0; i < 8 && await focusedAction(page) !== action; i++) await key(page, 'right');
  assert.strictEqual(await focusedAction(page), action);
}

t.test('audio: video.audioTracks with two languages gives an Audio button; the choice switches tracks, is remembered and applied to the next title', async () => {
  const page = await open({ mbp_len: 120 }, { config: { audioVerify: 300 } });
  await fakeTracks(page, [{ language: 'en', label: 'English' }, { language: 'jpn', label: '' }]);
  await play(page, MOVIE);
  await waitPlaying(page);
  await focusButton(page, 'audio');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="audio"] .mbp-btn-value'), 'English');
  const order = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player .mbp-btns [data-action]'), b => b.getAttribute('data-action')));
  assert.ok(order.indexOf('audio') === order.indexOf('quality') + 1, 'after Quality: ' + order.join(','));
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  assert.strictEqual(await page.evaluate(() => document.querySelector('#mbptv-player .mbp-sheet').getAttribute('data-sheet')), 'player-audio');
  const rows = await audioRows(page);
  assert.deepStrictEqual(rows.map(r => [r.i, r.lang, r.title, r.cur, r.focus]), [['0', 'en', 'English', true, true], ['1', 'ja', 'Japanese', false, false]]);
  await key(page, 'down');
  await key(page, 'enter');
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-chip').textContent === 'Audio: Japanese', null, { timeout: 5000 });
  assert.deepStrictEqual(await page.evaluate(() => window.__audioSets), [['jpn', true], ['en', false]]);
  assert.strictEqual(await page.evaluate(() => window.__p.Prefs.get('audioLang')), 'ja');
  assert.strictEqual((await info(page)).audio, 'Japanese');
  // The next title starts in the remembered language by itself.
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  await page.evaluate(() => { window.__audioSets = []; });
  await play(page, MOVIE);
  await waitPlaying(page);
  await page.waitForFunction(() => window.__audioSets.length >= 2, null, { timeout: 5000 });
  assert.deepStrictEqual(await page.evaluate(() => window.__audioSets), [['jpn', true], ['en', false]]);
  assert.ok(/audio: the remembered language \(ja\)/.test(await logText(page)));
  await done(page);
});

t.test('audio: no Audio button with a single track, and none without audioTracks or a master', async () => {
  const page = await open({ mbp_len: 120 });
  await fakeTracks(page, [{ language: 'en', label: 'English' }]);
  await play(page, MOVIE);
  await waitPlaying(page);
  await key(page, 'down');
  const actions = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player .mbp-btns [data-action]'), b => b.getAttribute('data-action')));
  assert.ok(actions.indexOf('audio') < 0, actions.join(','));
  assert.strictEqual((await info(page)).audio, '');
  await done(page);
  const page2 = await open({ mbp_len: 120, mbp_auto: 'ok' });
  await play(page2, MOVIE);
  await waitPlaying(page2, { label: 'AUTO' });
  await page2.waitForFunction(() => /audio: master not read/.test(window.__p.Log.entries().map(e => e.msg).join('\n')), null, { timeout: 8000 });
  await key(page2, 'down');
  assert.ok(!(await page2.evaluate(() => !!document.querySelector('#mbptv-player [data-action="audio"]'))));
  await done(page2);
});

t.test('audio: without audioTracks, the HLS master names the languages; a rewritten master the TV cannot play hands back at the same position', async () => {
  const page = await open({ mbp_len: 300, mbp_auto: 'ok', mbp_master: '1' }, { config: { candidateTimeout: 3000 } });
  await page.evaluate(() => {
    window.__xhrCreds = [];
    const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return open.apply(this, arguments); };
    XMLHttpRequest.prototype.send = function () { if (/__media\/ep\.wav/.test(this.__u)) window.__xhrCreds.push(this.withCredentials); return send.apply(this, arguments); };
  });
  await play(page, MOVIE);
  await waitPlaying(page, { label: 'AUTO' });
  await page.waitForFunction(() => /audio: AUTO lists 2 \[en\*, ko\]; video\.audioTracks missing/.test(window.__p.Log.entries().map(e => e.msg).join('\n')), null, { timeout: 8000 });
  const master = (await playerLog(page)).filter(e => e.kind === 'master');
  assert.strictEqual(master.length, 1, 'the master is read once');
  assert.strictEqual(master[0].query.audio, 'aac');
  assert.deepStrictEqual(await page.evaluate(() => window.__xhrCreds), [false], 'read without credentials (the HLS hosts answer ACAO: *)');
  await waitTime(page, 3);
  await focusButton(page, 'audio');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="audio"] .mbp-btn-value'), 'English');
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  const rows = await audioRows(page);
  assert.deepStrictEqual(rows.map(r => [r.lang, r.title, r.meta, r.cur]), [['en', 'English', 'ENG', true], ['ko', 'Korean', 'KOR', false]]);
  const before = (await video(page)).t;
  await key(page, 'down');
  await key(page, 'enter');
  await page.waitForFunction(() => /This TV can’t switch the audio language/.test(document.querySelector('#mbptv-player .mbp-chip').textContent), null, { timeout: 20000 });
  await waitPlaying(page, { label: 'AUTO' });
  near((await video(page)).t, before, 3, 'position kept');
  const entries = await logText(page);
  assert.ok(/stream AUTO \(audio\) failed/.test(entries) && /a rewritten master does not play on this TV/.test(entries), entries);
  assert.ok(!/data:application|base64|m3u8_proxy/.test(entries), 'the data: master is never logged');
  assert.strictEqual(await page.evaluate(() => window.__p.Prefs.get('audioLang')), 'ko', 'the wish is remembered');
  await key(page, 'down');
  assert.ok(!(await page.evaluate(() => !!document.querySelector('#mbptv-player [data-action="audio"]'))), 'no Audio button once the TV showed it cannot switch');
  await done(page);
});

t.test('audio: the master parser and rewrite (pure)', async () => {
  const page = await open();
  const master = ['#EXTM3U', '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_aac",LANGUAGE="ko",NAME="KOR (5.1)",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="/m3u8_proxy/audio/a_1.m3u8?sign=S1"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_aac",LANGUAGE="it",NAME="ITA (5.1)",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="/m3u8_proxy/audio/a_2.m3u8?sign=S2"',
    '#EXT-X-STREAM-INF:BANDWIDTH=8958000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L180.90,mp4a.40.2",AUDIO="audio_aac",VIDEO-RANGE=PQ',
    'video_2160p.m3u8?sign=V1', ''].join('\n');
  const out = await page.evaluate(m => {
    const P = window.__p.NativePlayer;
    return { list: P._audioList(m), re: P._audioMaster(m, 'https://hls.example/40033921.m3u8?sign=M', 'audio_aac', 1), none: P._audioList('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8') };
  }, master);
  assert.strictEqual(out.list.group, 'audio_aac');
  assert.deepStrictEqual(out.list.list.map(x => [x.code, x.name, x.def]), [['ko', 'KOR (5.1)', true], ['it', 'ITA (5.1)', false]]);
  assert.strictEqual(out.list.def, 0);
  const lines = out.re.split('\n');
  assert.strictEqual(lines.filter(l => /^#EXT-X-MEDIA/.test(l)).length, 1, 'only the chosen rendition');
  assert.ok(/LANGUAGE="it".*DEFAULT=YES,AUTOSELECT=YES.*URI="https:\/\/hls\.example\/m3u8_proxy\/audio\/a_2\.m3u8\?sign=S2"/.test(out.re), out.re);
  assert.ok(lines.indexOf('https://hls.example/video_2160p.m3u8?sign=V1') > 0, 'variant made absolute');
  assert.deepStrictEqual(out.none.list, []);
  await done(page);
});

/* ---------- hls.js (Media Source Extensions) ---------- */

const hlsMock = page => page.evaluate(() => window.__hlsMock ? { loads: window.__hlsMock.loads, list: window.__hlsMock.summary() } : null);

t.test('hls.js: the platform player refuses HLS (media error 4), so the same stream plays through hls.js (site copy); remembered for the next start', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  const i = await info(page);
  assert.strictEqual(i.label, 'AUTO');
  assert.strictEqual(i.level, '1080p');
  assert.strictEqual(i.audio, 'English');
  const log = await logText(page);
  assert.ok(/stream AUTO failed: media-4 .*\n.*the platform player refused AUTO \(media-4\): trying it through hls\.js\ntry AUTO \(hls\.js\) after media-4/.test(log), log);
  assert.ok(/hls\.js 1\.4\.0-mock ready \(site copy, \d+\.\d s; MSE ec-3 (?:yes|no), hevc (?:yes|no)\)/.test(log), log);
  // AUTO lists 4K HEVC first: adaptive playback starts on the best H.264 rendition and never goes to HEVC by itself.
  assert.ok(/hls\.js: 4 levels \[360p, 720p, 1080p, 4K HEVC\], start 1080p, HEVC kept for the Quality menu/.test(log), log);
  assert.ok(/engine hls\.js 1\.4\.0-mock \(site copy\) · AUTO · 1080p level · audio en/.test(log), log);
  assert.ok(/the platform player refuses HLS here: hls\.js from now on \(remembered\)/.test(log), log);
  assert.ok(/playing AUTO after \d+\.\d s \(.*hls\.js\)/.test(log), log);
  let m = await hlsMock(page);
  assert.deepStrictEqual(m.loads, ['site']);
  assert.strictEqual(m.list.length, 1);
  assert.strictEqual(m.list[0].cap, 2, 'autoLevelCapping: the best H.264 level');
  assert.strictEqual(m.list[0].startLevel, 2);
  assert.strictEqual((await page.evaluate(() => window.__p.NativePlayer.configure().hls)).verdict, 'refuses');
  // The next start goes straight to hls.js (no refused attempt first), with a fresh instance; the old one is destroyed.
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  await page.evaluate(() => window.__p.Log.clear ? window.__p.Log.clear() : null);
  await play(page, EPISODE);
  await waitPlaying(page, { engine: 'hls.js', season: 1 });
  const log2 = (await logText(page)).split('open tv:17417').pop();
  assert.ok(/try AUTO \(hls\.js: remembered\)/.test(log2) && !/try AUTO \(hls\)/.test(log2) && !/refused/.test(log2), log2);
  m = await hlsMock(page);
  assert.deepStrictEqual(m.loads, ['site'], 'hls.js loads once');
  assert.deepStrictEqual(m.list.map(x => x.destroyed), [true, false]);
  await done(page);
});

t.test('hls.js: resume starts loading at the saved position; a quality switch is a new instance at the same position (verified)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 300, mbp_seconds: 95 });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  near((await video(page)).t, 95, 2.5, 'resumed position');
  let m = await hlsMock(page);
  assert.strictEqual(m.list[0].startPosition, 95, 'hls.js startPosition');
  // The resume chip is up: Down lands on Start over; Quality is to its left.
  await key(page, 'down');
  for (let k = 0; k < 8 && await focusedAction(page) !== 'quality'; k++) await key(page, 'left');
  assert.strictEqual(await focusedAction(page), 'quality');
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  const rows = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player [data-quality]'), r => r.getAttribute('data-quality')));
  assert.deepStrictEqual(rows, ['AUTO', '1080p', '720p', '360p', 'ORG']);
  const before = (await video(page)).t;
  await key(page, 'down'); await key(page, 'down');
  await key(page, 'enter');
  await waitPlaying(page, { label: '720p', engine: 'hls.js' });
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-chip').textContent === 'Quality: 720p', null, { timeout: 5000 });
  near((await video(page)).t, before, 3, 'position after the switch');
  m = await hlsMock(page);
  assert.deepStrictEqual(m.list.map(x => x.destroyed), [true, false]);
  near(m.list[1].startPosition, before, 3, 'the new instance starts at the position');
  assert.strictEqual(m.list[1].levels, 1, 'a fixed quality is its own master (one rendition)');
  assert.strictEqual((await info(page)).level, '720p');
  assert.ok(/engine hls\.js 1\.4\.0-mock \(site copy\) · 720p · 720p level/.test(await logText(page)));
  // Stop tears the instance down.
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  m = await hlsMock(page);
  assert.ok(m.list.every(x => x.destroyed), 'every instance destroyed after stop');
  await done(page);
});

t.test('hls.js: Audio lists hls.js audio tracks; choosing one switches, is remembered and the next episode starts in it', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 });
  await play(page, EPISODE);
  await waitPlaying(page, { engine: 'hls.js' });
  await page.waitForFunction(() => document.querySelector('#mbptv-player [data-action="audio"]'), null, { timeout: 5000 });
  await focusButton(page, 'audio');
  assert.strictEqual(await text(page, '#mbptv-player [data-action="audio"] .mbp-btn-value'), 'English');
  await key(page, 'enter');
  await waitClass(page, 'is-sheet');
  const rows = await audioRows(page);
  assert.deepStrictEqual(rows.map(r => [r.i, r.lang, r.title, r.meta, r.cur]), [['0', 'en', 'English', 'ENG', true], ['1', 'ko', 'Korean', 'KOR (5.1)', false]]);
  await key(page, 'down');
  await key(page, 'enter');
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-chip').textContent === 'Audio: Korean', null, { timeout: 5000 });
  assert.strictEqual(await page.evaluate(() => window.__p.Prefs.get('audioLang')), 'ko');
  assert.strictEqual((await info(page)).audio, 'Korean');
  const log = await logText(page);
  assert.ok(/audio: track 2 of 2 \(ko\) via hls\.js\naudio: switched/.test(log), log);
  assert.ok(!/audio: master/.test(log), 'no master read of its own under hls.js');
  // Next episode: a new instance picks Korean as soon as hls.js knows the tracks (before playback).
  await key(page, 'chup');
  await waitPlaying(page, { engine: 'hls.js', episode: 2 });
  await page.waitForFunction(() => window.__p.NativePlayer.info().audio === 'Korean', null, { timeout: 5000 });
  assert.ok(/audio: the remembered language \(ko\) from the start, via hls\.js/.test(await logText(page)));
  const m = await hlsMock(page);
  assert.ok(m.list[1].log.indexOf('audioTrack=1 (before playback)') >= 0, JSON.stringify(m.list[1].log));
  await done(page);
});

t.test('hls.js: one audio language means no Audio button; a switch hls.js never confirms says so', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120, mbp_langs: 1 });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  await key(page, 'down');
  let acts = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv-player .mbp-btns [data-action]'), b => b.getAttribute('data-action')));
  assert.ok(acts.indexOf('audio') < 0, acts.join(','));
  await page.context_.addCookies([{ name: 'mbp_langs', value: '2', url: origin }]);
  await page.evaluate(() => { window.__hlsMock.stuckAudio = true; window.__p.NativePlayer.configure({ audioSwitchTimeout: 800 }); });
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  await page.waitForFunction(() => document.querySelector('#mbptv-player [data-action="audio"]'), null, { timeout: 5000 });
  await focusButton(page, 'audio');
  await key(page, 'enter');
  await key(page, 'down');
  await key(page, 'enter');
  await page.waitForFunction(() => document.querySelector('#mbptv-player .mbp-chip').textContent === 'The audio didn’t switch', null, { timeout: 5000 });
  assert.ok(/audio: hls\.js did not switch the track/.test(await logText(page)));
  await done(page);
});

t.test('hls.js: a fatal media error is recovered once; a second one hands over to the next stream at the same place', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 1200 });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  await waitTime(page, 6);
  const before = (await video(page)).t;
  await page.evaluate(() => window.__hlsMock.fatal('mediaError', 'bufferAppendError'));
  await page.waitForFunction(() => window.__hlsMock.summary()[0].log.some(x => /^recoverMediaError/.test(x)), null, { timeout: 5000 });
  // Like hls.js 1.4, the stand-in re-attaches without playing and restarts at config.startPosition: the player sets
  // that to the current place and plays again by itself (no OK needed, no jump back to the start).
  const rec = (await hlsMock(page)).list[0].log.find(x => /^recoverMediaError/.test(x));
  near(+rec.split(' at ')[1], before, 1.5, 'recovery restarts where the video was');
  await waitPlaying(page, { engine: 'hls.js', label: 'AUTO' });
  await page.waitForFunction(b => document.querySelector('#mbptv-player video').currentTime > b + 0.5, before, { timeout: 5000 });
  assert.strictEqual((await video(page)).paused, false, 'playing again after the recovery');
  const at = (await video(page)).t;
  await page.evaluate(() => window.__hlsMock.fatal('mediaError', 'bufferAppendError'));
  await waitPlaying(page, { label: 'ORG' });
  await page.waitForFunction(() => window.__p.Log.entries().some(e => /^engine native/.test(e.msg)), null, { timeout: 5000 });
  near((await video(page)).t, at, 3, 'the backup stream continues at the same place');
  assert.strictEqual((await info(page)).engine, 'native');
  const log = await logText(page);
  assert.ok(/hls\.js mediaError\/bufferAppendError: recovering once/.test(log), log);
  assert.ok(/stream AUTO \[hls\.js\] failed: hls-media after \d+\.\d s \(hls\.js mediaError\/bufferAppendError\)/.test(log), log);
  assert.ok(/engine native · ORG \(mp4\)/.test(log), log);
  assert.ok((await hlsMock(page)).list.every(x => x.destroyed), 'the hls.js instance is gone');
  await done(page);
});

t.test('hls.js: without the site copy the CDN copy loads; without any copy HLS stays with the platform player and the original plays', async () => {
  let page = await open({ mbp_hls: 'mse', mbp_len: 120, mbp_hlslib: 'nosite' });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  let log = await logText(page);
  assert.ok(/hls\.js site copy: did not load\nhls\.js 1\.4\.0-mock ready \(CDN copy/.test(log), log);
  assert.ok(/engine hls\.js 1\.4\.0-mock \(CDN copy\) · AUTO/.test(log), log);
  assert.deepStrictEqual((await hlsMock(page)).loads, ['cdn']);
  await done(page);

  page = await open({ mbp_hls: 'mse', mbp_len: 120, mbp_hlslib: 'hang,nocdn' }, { config: { hlsLoadTimeout: 700 } });
  await play(page, MOVIE);
  await waitPlaying(page, { label: 'ORG' });
  log = await logText(page);
  assert.ok(/hls\.js site copy: timed out\nhls\.js CDN copy: did not load\nhls\.js unavailable \(no copy loaded\): HLS through the platform player only/.test(log), log);
  assert.ok(/stream AUTO failed: media-4 after \d+\.\d s \(hls\.js unavailable\)/.test(log), 'the refused stream fails as it did: ' + log);
  assert.strictEqual((await info(page)).engine, 'native');
  await done(page);
});

t.test('hls.js: the app going to the background stops hls.js loading; coming back starts it again at the position', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  await setHidden(page, true);
  assert.strictEqual((await video(page)).paused, true);
  await setHidden(page, false);
  const log = (await hlsMock(page)).list[0].log;
  assert.ok(log.indexOf('stopLoad') >= 0 && /^startLoad \d+$/.test(log[log.length - 1]), JSON.stringify(log));
  await done(page);
});

t.test('a large original slow to give up its header counts as alive while data arrives (no timeout, no stall)', async () => {
  // stallTimeout shorter than the 5 s trickle: the 'waiting' fired at play() must not fail a start that shows life.
  const page = await open({ mbp_org: 'slow', mbp_len: 60 }, { config: { candidateTimeout: 2000, stallTimeout: 3000, hlsEngine: 'native' } });
  await play(page, MOVIE);
  await waitPlaying(page, {}, 30000);
  assert.strictEqual((await info(page)).label, 'ORG', await logText(page));
  await done(page);
});

t.test('stream order (TV with Media Source Extensions): Matroska originals after every HLS rendition', async () => {
  const page = await open();
  const out = await page.evaluate(() => {
    const P = window.__p.NativePlayer, can = () => 'maybe';
    const src = [{ label: 'ORG', src: 'https://x.example/a.mkv', hls: false }, { label: 'AUTO', src: 'https://x.example/a.m3u8', hls: true },
      { label: '1080p', src: 'https://x.example/a.m3u8?quality=1080p', hls: true }, { label: '720p', src: 'https://x.example/a.m3u8?quality=720p', hls: true },
      { label: '4K', src: 'https://x.example/a.m3u8?quality=4K', hls: true, h265: true }];
    return { mse: P._order(src, { tv: true, aac: true, mse: true, canPlay: can, fileName: 'a.mkv' }).map(c => c.label),
      plain: P._order(src, { tv: true, aac: true, canPlay: can, fileName: 'a.mkv' }).map(c => c.label) };
  });
  assert.deepStrictEqual(out.mse, ['AUTO', '1080p', '720p', '4K', 'ORG']);
  assert.deepStrictEqual(out.plain, ['AUTO', '1080p', 'ORG', '720p', '4K']);
  await done(page);
});

// ---------- fast start (docs/PLAYER.md "Fast start") ----------

const TIZEN9_UA = 'Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36';

t.test('fast start: on Tizen 9 HLS goes straight to hls.js the first time (no platform attempt), every rendition before the originals; hosts preconnected', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 }, { ua: TIZEN9_UA });
  assert.strictEqual((await page.evaluate(() => window.__p.NativePlayer.configure().hls)).engine, 'Tizen 9');
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js', label: 'AUTO' });
  const log = await logText(page);
  assert.ok(/order \[AUTO, 1080p, 720p, 360p, ORG\]/.test(log), log);
  assert.ok(/try AUTO \(hls\.js: Tizen 9\)/.test(log) && !/try AUTO \(hls\)/.test(log) && !/refused/.test(log), log);
  assert.ok(/preconnect hls\.shegu\.net, hls-aws\.shegu\.net/.test(log), log);
  assert.ok(/playing AUTO after \d+\.\d s \(data \d+\.\d, src \d+\.\d, attach \d+\.\d, manifest \d+\.\d, playlist \d+\.\d, frag \d+\.\d, meta /.test(log), log);
  const links = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('link[data-mbptv=preconnect]'), l => l.rel + ' ' + l.href + ' ' + l.crossOrigin));
  assert.deepStrictEqual(links, ['preconnect https://hls.shegu.net/ anonymous', 'preconnect https://hls-aws.shegu.net/ anonymous']);
  const m = await hlsMock(page);
  assert.deepStrictEqual(m.list[0].config, { startFragPrefetch: true, testBandwidth: false, abrEwmaDefaultEstimate: 5000000 });
  // Only host names are ever stored (no stream URL, no token).
  const stored = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)])));
  assert.ok(!/__media|sign=|REDACTED|tok=/.test(stored), stored);
  await done(page);
});

t.test('fast start: warm() before Play loads hls.js and reads the episode\'s files ahead (never the player data); Play then needs one request', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 }, { ua: TIZEN9_UA });
  const w = await page.evaluate(e => window.__p.NativePlayer.warm({ why: 'title page', kind: 'tv', id: e.id, season: 1, episode: 1 }), EPISODE);
  assert.strictEqual(w.engine, 'hls.js');
  await page.waitForFunction(() => window.__p.NativePlayer.configure().hls.state === 'ready', null, { timeout: 5000 });
  await page.waitForFunction(() => fetch('/__mock/player-log').then(r => r.json()).then(l => l.some(e => e.kind === 'tv_file')), null, { timeout: 5000 });
  let plog = await playerLog(page);
  assert.deepStrictEqual(plog.filter(e => e.kind === 'player'), [], 'warm never asks for player data');
  assert.strictEqual(plog.filter(e => e.kind === 'tv_file').length, 1);
  let log = await logText(page);
  assert.ok(/hls\.js preload \(title page; Tizen 9\)/.test(log) && /reading ahead the files of S1E1 \(title page\)/.test(log), log);
  // A second warm (the page shown again) does nothing new.
  await page.evaluate(e => window.__p.NativePlayer.warm({ why: 'title page', kind: 'tv', id: e.id, season: 1, episode: 1 }), EPISODE);
  await play(page, EPISODE);
  await waitPlaying(page, { engine: 'hls.js' });
  plog = await playerLog(page);
  assert.strictEqual(plog.filter(e => e.kind === 'tv_file').length, 1, 'the read-ahead list is used');
  assert.strictEqual(plog.filter(e => e.kind === 'player').length, 1);
  assert.deepStrictEqual((await hlsMock(page)).loads, ['site'], 'hls.js loaded once, before Play');
  log = await logText(page);
  assert.ok(/episode files 1 \(read ahead\)/.test(log), log);
  // Elsewhere (a TV whose platform player plays HLS) nothing is preloaded.
  const page2 = await open({ mbp_len: 60 });
  const w2 = await page2.evaluate(() => window.__p.NativePlayer.warm({ why: 'home' }));
  assert.deepStrictEqual(w2, { engine: 'native', hls: '' });
  await done(page2);
  await done(page);
});

t.test('fast start: the next episode\'s files are read ahead before Up Next, so autoplay goes straight to its player data', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 40 }, { ua: TIZEN9_UA, config: { upNextCount: 2 } });
  await play(page, EPISODE);
  await waitPlaying(page, { episode: 1 });
  await setTime(page, 30);
  await waitPlaying(page, { episode: 2 }, 30000);
  const files = (await playerLog(page)).filter(e => e.kind === 'tv_file').map(e => e.body.episode);
  assert.deepStrictEqual(files, ['1', '2'], 'one list per episode');
  const log = await logText(page);
  assert.ok(/reading ahead the files of S1E2 \(up next\)[\s\S]*episode files 1 \(read ahead\)/.test(log), log);
  await done(page);
});

t.test('fast start: the start level follows the last measured bandwidth (configure hlsStart overrides it); the estimate is saved', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 }, { ua: TIZEN9_UA });
  await page.evaluate(() => localStorage.setItem('mbptv:hls-bw:v1', JSON.stringify({ bw: 4000000, at: Date.now() })));
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  let log = await logText(page);
  assert.ok(/hls\.js: 4 levels \[360p, 720p, 1080p, 4K HEVC\], start 360p \(last 4 Mbit\/s\)/.test(log), log);
  assert.strictEqual((await hlsMock(page)).list[0].config.abrEwmaDefaultEstimate, 4000000);
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  assert.strictEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('mbptv:hls-bw:v1'))).bw, 20000000, 'hls.js\'s estimate kept for next time');
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  log = (await logText(page)).split('hls.js: 4 levels').pop();
  assert.ok(/^ \[360p, 720p, 1080p, 4K HEVC\], start 1080p \(last 20 Mbit\/s\)/.test(log), log);
  await page.evaluate(() => { window.__p.NativePlayer.stop('test'); window.__p.NativePlayer.configure({ hlsStart: '720p' }); });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  log = (await logText(page)).split('hls.js: 4 levels').pop();
  assert.ok(/^ \[360p, 720p, 1080p, 4K HEVC\], start 720p \(hlsStart 720p\)/.test(log), log);
  await done(page);
});

t.test('fast start: AUTO through hls.js too slow to start sends 720p and 360p before the 1080p address (same video as AUTO\'s start)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_auto: 'hang', mbp_len: 120 }, { ua: TIZEN9_UA, config: { candidateTimeout: 1200 } });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js', label: '720p' }, 20000);
  const log = await logText(page);
  assert.ok(/stream AUTO \[hls\.js\] failed: timeout[\s\S]*AUTO was too slow: 720p, 360p next\ntry 720p \(hls\.js\)/.test(log), log);
  await done(page);
});

t.test('a slow but progressing start is not failed as a stall: hls.js fragments arriving keep it alive (bug: the 15 s waiting timer ignored them)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120 }, { ua: TIZEN9_UA, config: { candidateTimeout: 1200, stallTimeout: 1500 } });
  await page.evaluate(() => { window.__hlsMock = { instances: [], loads: [], stuckAudio: false, slowStart: 4000 }; });
  await play(page, MOVIE);
  // Chromium fires 'waiting' as soon as play() is called on an element with no data yet.
  await page.waitForFunction(() => window.__hlsMock.instances.length > 0 && window.__hlsMock.instances[0].log.indexOf('attach') >= 0, null, { timeout: 5000 });
  await page.evaluate(() => { const e = document.createEvent('Event'); e.initEvent('waiting', false, false); document.querySelector('#mbptv-player video').dispatchEvent(e); });
  await waitPlaying(page, { engine: 'hls.js' }, 20000);
  const log = await logText(page);
  assert.strictEqual((await info(page)).label, 'AUTO', log);
  assert.ok(!/failed/.test(log), log);
  await done(page);
});

t.test('hls.js: a saved position inside the last minute is not resumed (bug: hls.js jumped to its startPosition after the first fragment)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120, mbp_seconds: 100 }, { ua: TIZEN9_UA });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' });
  await page.waitForTimeout(800);
  const v = await video(page);
  assert.ok(v.t < 5, 'started at ' + v.t);
  assert.ok(!/Resumed/.test(await text(page, '#mbptv-player .mbp-chip') || ''));
  await done(page);
});

t.test('many episode switches through hls.js leave one live instance, one hls.js script, a bounded set of preconnect links and the quality badge (bug: the badge went blank)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 60, mbp_eps: 12 }, { ua: TIZEN9_UA });
  await play(page, EPISODE);
  await waitPlaying(page, { episode: 1 });
  assert.strictEqual(await text(page, '#mbptv-player .mbp-badges'), 'Auto');
  for (let e = 2; e <= 7; e++) {
    await key(page, 'chup');
    await waitPlaying(page, { episode: e });
  }
  assert.strictEqual(await text(page, '#mbptv-player .mbp-badges'), 'Auto', 'badge after the switches');
  const m = await hlsMock(page);
  assert.strictEqual(m.list.length, 7);
  assert.deepStrictEqual(m.list.map(x => x.destroyed), [true, true, true, true, true, true, false]);
  const dom = await page.evaluate(() => ({ videos: document.querySelectorAll('video').length, scripts: document.querySelectorAll('script[data-mbptv=hls]').length,
    links: document.querySelectorAll('link[data-mbptv=preconnect]').length }));
  assert.deepStrictEqual({ videos: dom.videos, scripts: dom.scripts }, { videos: 1, scripts: 1 });
  assert.ok(dom.links <= 4, 'preconnect links ' + dom.links);
  await page.evaluate(() => window.__p.NativePlayer.stop('test'));
  assert.ok((await hlsMock(page)).list.every(x => x.destroyed));
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('video').length), 0, 'the overlay and its video are gone');
  await done(page);
});

t.test('hls.js: a stream\'s clocks start once hls.js has loaded (bug: a slow script load used up AUTO\'s quiet time)', async () => {
  const page = await open({ mbp_hls: 'mse', mbp_len: 120, mbp_hlslib: 'hang' }, { ua: TIZEN9_UA, config: { hlsLoadTimeout: 1500, candidateTimeout: 1000 } });
  await play(page, MOVIE);
  await waitPlaying(page, { engine: 'hls.js' }, 15000);
  const log = await logText(page);
  assert.strictEqual((await info(page)).label, 'AUTO', log);
  assert.ok(/hls\.js site copy: timed out\nhls\.js 1\.4\.0-mock ready \(CDN copy/.test(log) && !/failed/.test(log), log);
  await done(page);
});

t.test('stream order: with hls.js as the HLS engine every rendition comes before the originals (MP4 included)', async () => {
  const page = await open();
  const out = await page.evaluate(() => {
    const P = window.__p.NativePlayer, can = () => 'maybe';
    const src = [{ label: 'ORG', src: 'https://x.example/a.mp4', hls: false }, { label: 'AUTO', src: 'https://x.example/a.m3u8', hls: true },
      { label: '4K', src: 'https://x.example/a.m3u8?quality=4K', hls: true, h265: true }, { label: '1080p', src: 'https://x.example/a.m3u8?quality=1080p', hls: true },
      { label: '720p', src: 'https://x.example/a.m3u8?quality=720p', hls: true }, { label: '360p', src: 'https://x.example/a.m3u8?quality=360p', hls: true }];
    return { hlsjs: P._order(src, { tv: true, aac: true, mse: true, hlsjs: true, canPlay: can, fileName: 'a.mp4' }).map(c => c.label),
      native: P._order(src, { tv: true, aac: true, mse: true, canPlay: can, fileName: 'a.mp4' }).map(c => c.label) };
  });
  assert.deepStrictEqual(out.hlsjs, ['AUTO', '1080p', '720p', '360p', '4K', 'ORG']);
  assert.deepStrictEqual(out.native, ['AUTO', 'ORG', '1080p', '720p', '360p', '4K']);
  await done(page);
});

async function main() {
  const extra = path.join(root, 'tools', 'mock-extra.cjs');
  assert.ok(fs.existsSync(extra), 'tools/mock-extra.cjs is required');
  server = await mockSite.start();
  origin = server.origin;
  code = bundle(origin);
  browser = await launch();
  try { await t.run(); } finally {
    for (const p of pages) { try { await p.context_.close(); } catch (e) {} }
    await browser.close();
    await server.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
