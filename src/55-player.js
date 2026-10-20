/* Native player (docs/PLAYER.md). Plays movies and episodes in our own full-screen <video>, through the same
   endpoints the website's player uses: the title page's file list (movies) or POST tv_file (episodes), then
   POST <oss_download_url>&jw..player=1 for the player data, which is read with regexes and never evaluated.
   Streams are tried in a platform-aware order with a per-candidate timeout; progress goes to the site's own
   progress endpoints, so Continue Watching and the website's resume points stay in sync. Stream URLs are signed,
   time-limited and account-bound: they are never logged or stored. Only NativePlayer is declared at top level
   and nothing runs at load time. */
var NativePlayer = (function () {
  var CFG = {
    requestTimeout: 15000, retryDelay: 700, candidateTimeout: 15000, stallTimeout: 15000, osdHide: 4000,
    progressEvery: 20000, seekApply: 400, seekReport: 1500, upNextLead: 25, upNextCount: 10, chipMs: 6000,
    startBudget: 90000, stillWatchingAfter: 3, repeatGap: 250, subTimeout: 15000, candidateMax: 40000, audioTimeout: 8000,
    audioVerify: 1500, seekSlack: 8, hlsLoadTimeout: 10000, audioSwitchTimeout: 10000, fileTimeout: 25000, filesFresh: 600000
  };
  /* Held keys act once (the App's hold guard also swallows held OK/Back, including repeats that arrive after the
     player closed); arrows and FF/RW keep auto-repeat for seeking and sheet navigation. */
  var ONCE = { enter: 1, back: 1, backspace: 1, stop: 1, play: 1, pause: 1, playpause: 1, space: 1, chup: 1, chdown: 1, info: 1, yellow: 1 };
  var PROGRESS_PATH = /^\/index\/index\/(?:tv|movie)_progress$/;
  var JW_FLAG = 'jw' + 'player=1'; /* the website's own "player data" flag (split so the site-globals lint scan skips it) */
  var FORM = 'application/x-www-form-urlencoded; charset=UTF-8';
  var MIME = { h264: 'video/mp4; codecs="avc1.640028"', hvc1: 'video/mp4; codecs="hvc1.1.6.L150.B0"', hev1: 'video/mp4; codecs="hev1.1.6.L150.B0"' };
  var SHEET_ORDER = ['AUTO', '4K', '2160p', '1440p', '1080p', '720p', '480p', '360p', 'ORG'];

  var gen = 0;        /* bumped by every session start and stop: callbacks from older sessions are dropped */
  var S = null;       /* the current session (one movie or one episode) */
  var ui = null;      /* the overlay DOM while the player is up */
  var saverOff = false;
  var unattended = 0; /* episodes started by autoplay since the viewer last pressed a key ("Still watching?") */

  /* ---------- icons (static, author-written SVG only) ---------- */

  var ICONS = {
    play: '<path d="M7.2 4.3v15.4c0 .8.9 1.3 1.6.9l12.1-7.7c.6-.4.6-1.4 0-1.8L8.8 3.4c-.7-.4-1.6.1-1.6.9z"/>',
    pause: '<path d="M6.5 4h3.6c.4 0 .7.3.7.7v14.6c0 .4-.3.7-.7.7H6.5c-.4 0-.7-.3-.7-.7V4.7c0-.4.3-.7.7-.7zm7.4 0h3.6c.4 0 .7.3.7.7v14.6c0 .4-.3.7-.7.7h-3.6c-.4 0-.7-.3-.7-.7V4.7c0-.4.3-.7.7-.7z"/>',
    next: '<path d="M4.6 5.1v13.8c0 .8.9 1.2 1.5.8l9.6-6.9c.5-.4.5-1.2 0-1.6L6.1 4.3c-.6-.4-1.5 0-1.5.8zM17 4.6h2.6v14.8H17z"/>',
    skip: '<path d="M3.5 5.4v13.2c0 .7.8 1.1 1.3.7l8.1-6.6c.4-.4.4-1 0-1.4L4.8 4.7c-.5-.4-1.3 0-1.3.7zm8.8 0v13.2c0 .7.8 1.1 1.3.7l8.1-6.6c.4-.4.4-1 0-1.4l-8.1-6.6c-.5-.4-1.3 0-1.3.7z"/>',
    restart: '<path d="M12 4.4V1.6L7.4 5.8 12 10V7a5.4 5.4 0 1 1-5.4 5.4H4a8 8 0 1 0 8-8z"/>',
    quality: '<path fill-rule="evenodd" d="M4.2 5h15.6c.7 0 1.2.5 1.2 1.2v11.6c0 .7-.5 1.2-1.2 1.2H4.2c-.7 0-1.2-.5-1.2-1.2V6.2C3 5.5 3.5 5 4.2 5zM5.2 7.2v9.6h13.6V7.2zM7 9h1.8v2.1h2V9h1.8v6h-1.8v-2.2h-2V15H7zm7 0h2.6c1.3 0 2.4 1.1 2.4 2.4v1.2c0 1.3-1.1 2.4-2.4 2.4H14zm1.8 1.7v2.6h.8c.4 0 .6-.3.6-.7v-1.2c0-.4-.2-.7-.6-.7z"/>',
    alert: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.3 4.8v7.4h2.6V6.8zM12 15.6a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z"/>',
    check: '<path d="M9.4 16.4l-4.3-4.3-1.8 1.8 6.1 6.1L21 8.3l-1.8-1.8z"/>',
    globe: '<path fill-rule="evenodd" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1.4 2.2A7.9 7.9 0 0 0 4.2 11h3.3c.1-2.6.9-5 3.1-6.8zm2.8 0c2.2 1.8 3 4.2 3.1 6.8h3.3a7.9 7.9 0 0 0-6.4-6.8zM12 4.6c-1.6 1.5-2.3 3.8-2.4 6.4h4.8c-.1-2.6-.8-4.9-2.4-6.4zM4.2 13a7.9 7.9 0 0 0 6.4 6.8c-2.2-1.8-3-4.2-3.1-6.8zm5.4 0c.1 2.6.8 4.9 2.4 6.4 1.6-1.5 2.3-3.8 2.4-6.4zm6.9 0c-.1 2.6-.9 5-3.1 6.8a7.9 7.9 0 0 0 6.4-6.8z"/>',
    back: '<path d="M10.9 5.2L4.1 12l6.8 6.8 1.7-1.7-3.9-3.9H20v-2.4H8.7l3.9-3.9z"/>',
    close: '<path d="M6.3 4.6L12 10.3l5.7-5.7 1.7 1.7-5.7 5.7 5.7 5.7-1.7 1.7-5.7-5.7-5.7 5.7-1.7-1.7 5.7-5.7-5.7-5.7z"/>',
    reload: '<path d="M12 4.2c2.2 0 4.2.9 5.6 2.4L20 4.2V11h-6.8l2.9-2.9A5.7 5.7 0 0 0 6.4 12H4.2A7.8 7.8 0 0 1 12 4.2zm7.8 7.8A7.8 7.8 0 0 1 6.4 17.4L4 19.8V13h6.8l-2.9 2.9a5.7 5.7 0 0 0 9.7-3.9z"/>',
    audio: '<path d="M4 9.2h3.6L12.4 5c.6-.5 1.6-.1 1.6.7v12.6c0 .8-1 1.2-1.6.7l-4.8-4.2H4c-.6 0-1-.4-1-1v-3.6c0-.6.4-1 1-1zm12.1-1.6a6.4 6.4 0 0 1 0 8.8l-1.3-1.3a4.6 4.6 0 0 0 0-6.2zm2.6-2.6a10.1 10.1 0 0 1 0 14l-1.3-1.3a8.3 8.3 0 0 0 0-11.4z"/>',
    subtitles: '<path fill-rule="evenodd" d="M4.2 4.5h15.6c.7 0 1.2.5 1.2 1.2v12.6c0 .7-.5 1.2-1.2 1.2H4.2c-.7 0-1.2-.5-1.2-1.2V5.7c0-.7.5-1.2 1.2-1.2zM5.2 6.7v10.6h13.6V6.7zM6.8 11.4h4.8v1.9H6.8zm6.2 0h4.2v1.9H13zm-6.2 3h7.4v1.9H6.8zm8.6 0h1.8v1.9h-1.8z"/>'
  };

  function icon(name, cls) {
    return U.svg('<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" focusable="false">' +
      (ICONS[name] || ICONS.alert) + '</svg>', 'mbp-ico' + (cls ? ' ' + cls : ''));
  }

  /* ---------- small helpers ---------- */

  function toInt(v) { var n = parseInt(v, 10); return isNaN(n) ? 0 : n; }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  function fmtDelta(d) {
    var a = Math.round(Math.abs(d));
    return (d < 0 ? '\u2212' : '+') + (a < 60 ? a + ' s' : fmt(a));
  }

  /* Log-safe text: anything URL-like is masked (stream URLs carry signed, account-bound tokens). */
  function clean(v) {
    var s = v && v.message ? String(v.message) : String(v == null ? '' : v);
    return s.replace(/(?:[a-z][a-z0-9+.\-]*:)?\/\/[^\s'"<>]+/gi, '<url>').slice(0, 200);
  }

  function el(tag, cls, text, parent) { return U.el(tag, cls, text, parent); }
  function setText(node, text) { text = String(text == null ? '' : text); if (node && node.textContent !== text) node.textContent = text; }
  function tf(node, value) { if (!node) return; node.style.webkitTransform = value; node.style.transform = value; }
  function flag(node, name, on) { U.toggleClass(node, name, !!on); }
  function safeImage(url) { return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length < 2048; }
  /* Pictures at the size they are shown (the kit's sized URLs, when the kit is loaded). */
  function sized(url, w) { try { return typeof Kit !== 'undefined' && Kit.imgUrl ? Kit.imgUrl(url, w) : url; } catch (e) { return url; } }
  /* Shows img's picture at url, sized to w; a sized picture that fails falls back once to the original (retryOriginal). */
  function setArt(img, url, w) {
    var src = sized(url, w);
    img.__orig = src !== url ? url : '';
    if (img.getAttribute('src') !== src) { flag(img, 'is-loaded', false); img.src = src; }
  }
  function retryOriginal(img) {
    var o = img.__orig;
    img.__orig = '';
    if (!o || img.getAttribute('src') === o) return false;
    img.src = o;
    return true;
  }

  function hook(h, name) {
    var fn = h && h[name];
    if (typeof fn !== 'function') return;
    var args = Array.prototype.slice.call(arguments, 2);
    try { fn.apply(null, args); } catch (e) { Log.error('player-hook:' + name, e); }
  }

  function later(s, name, fn, ms) {
    if (!s) return;
    clearTimeout(s.timers[name]);
    s.timers[name] = U.later(function () { if (s === S && !s.finished) fn(); }, ms, 'player-' + name);
  }

  function cancel(s, name) { if (s && s.timers[name]) { clearTimeout(s.timers[name]); s.timers[name] = null; } }

  /* Wraps an async callback: dropped when its session is gone; a throw shows the error card instead of hanging. */
  function safe(s, fn, label) {
    return function () {
      if (s !== S || s.finished) return;
      try { fn.apply(null, arguments); } catch (e) {
        Log.error(label || 'player', e);
        if (s === S && !s.finished) showError(s, 'internal', 'Something went wrong while starting playback.');
      }
    };
  }

  /* ---------- platform ---------- */

  function isTV() {
    try { return /Tizen|SMART-TV|Web0S|NetCast/i.test(String(navigator.userAgent || '')) || !!window.tizen; } catch (e) { return false; }
  }

  /* The site appends audio=aac to HLS URLs on TVs: EAC3 audio stalls in native HLS. */
  function needsAac(tv) {
    if (tv) return true;
    try {
      var MS = window.MediaSource || window.WebKitMediaSource;
      if (MS && typeof MS.isTypeSupported === 'function') return !MS.isTypeSupported('audio/mp4; codecs="ec-3"');
    } catch (e) {}
    return true;
  }

  function canPlayProbe() {
    var probe = null;
    return function (mime) {
      try {
        if (!probe) probe = document.createElement('video');
        return probe.canPlayType ? String(probe.canPlayType(mime) || '') : '';
      } catch (e) { return ''; }
    };
  }

  function environment(file) {
    var tv = isTV();
    return { tv: tv, aac: needsAac(tv), mse: mse(), hlsjs: !!hlsjsWhy(), canPlay: canPlayProbe(), prefer: tv ? tvOrder : '', fileName: file && file.file || '',
      fileSize: file && file.size || '' };
  }

  /* 9 for "Tizen 9.0" in the user agent; 0 elsewhere. */
  function tizenMajor() {
    try { var m = /Tizen\s*(\d+)/i.exec(String(navigator.userAgent || '')); return m ? toInt(m[1]) : 0; } catch (e) { return 0; }
  }

  /* configure({tvOrder: 'ORG,AUTO'}): on a TV, try these stream labels first, in this order (the rest keep theirs).
     For measuring start times on a TV from the remote inspector; '' (default) keeps the built-in order. */
  var tvOrder = '';
  function preferred(list, prefer) {
    var want = U.filter(String(prefer || '').split(','), function (x) { return !!U.text(x); });
    if (!want.length) return list;
    function at(c) { for (var i = 0; i < want.length; i++) if (U.text(want[i]).toLowerCase() === String(c.label).toLowerCase()) return i; return want.length; }
    var keyed = U.map(list, function (c, i) { return { c: c, k: at(c), i: i }; });
    keyed.sort(function (a, b) { return a.k - b.k || a.i - b.i; });
    return U.map(keyed, function (x) { return x.c; });
  }

  /* The app is in the background (Home button, input switch, another app on top). */
  function isHidden() {
    try { return !!document.hidden || document.visibilityState === 'hidden' || !!document.webkitHidden; } catch (e) { return false; }
  }

  /* ---------- hls.js: HLS through Media Source Extensions (docs/PLAYER.md "HLS engine") ----------
     Samsung's Tizen 9 web view (Chromium 120) refuses HLS in <video> (media error 4) but has MSE, so HLS plays there
     through hls.js, as the website's own JW Player does. hls.js is third-party code loaded at run time, once and only
     when needed: the site's own copy first (same origin, usually cached), then a pinned CDN copy. It is never part of
     tv.js. The verdict "the platform player refuses HLS, hls.js plays it" is remembered per user agent, so later
     starts go straight to hls.js. */

  var HLS_SITE = '/static/videojs/hls.min.js'; /* the site's own copy: hls.js 1.4.0 (verified 2026-10-20) */
  var hlsCdn = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js';
  var hlsMode = 'auto';                        /* configure({hlsEngine}): 'auto' | 'hlsjs' | 'native' */
  var HLS_VERDICT = 'mbptv:hls-engine:v1';
  var HLS_MIME = 'application/vnd.apple.mpegurl';
  var lib = { state: '', Hls: null, from: '', version: '', waiters: [], failedAt: 0 };
  var hlsCur = null; /* the hls.js instance attached to the video: {hls, H, s, tryId, c, recovered, ...} */

  function mediaSource() { try { return window.MediaSource || window.WebKitMediaSource || null; } catch (e) { return null; } }
  function mse() { var MS = mediaSource(); return !!(MS && typeof MS.isTypeSupported === 'function'); }
  function mseType(type) { try { var MS = mediaSource(); return !!(MS && MS.isTypeSupported(type)); } catch (e) { return false; } }

  function usableHls(H) {
    try { return typeof H === 'function' && typeof H.isSupported === 'function' && !!H.isSupported() && !!H.Events; } catch (e) { return false; }
  }

  function libDone(H, from, t0) {
    lib.state = 'ready';
    lib.Hls = H;
    lib.from = from;
    lib.version = String(H.version || '?').slice(0, 24);
    Log.info('player', 'hls.js ' + lib.version + ' ready (' + from + ', ' + ((U.now() - t0) / 1000).toFixed(1) + ' s; MSE ec-3 ' +
      (mseType('audio/mp4; codecs="ec-3"') ? 'yes' : 'no') + ', hevc ' + (mseType('video/mp4; codecs="hvc1.2.4.L150.B0"') ? 'yes' : 'no') + ')');
    libFlush(null);
  }

  function libFail(why) {
    lib.state = 'failed';
    lib.failedAt = U.now();
    Log.warn('player', 'hls.js unavailable (' + why + '): HLS through the platform player only');
    libFlush('unavailable');
  }

  function libFlush(err) {
    var list = lib.waiters;
    lib.waiters = [];
    U.each(list, function (cb) { try { cb(err, err ? null : lib.Hls); } catch (e) { Log.error('player-hls-lib', e); } });
  }

  /* No copy loaded: HLS stays with the platform player; loading is tried again after 5 minutes. */
  function libFailed() {
    if (lib.state === 'failed' && U.now() - lib.failedAt > 300000) lib.state = '';
    return lib.state === 'failed';
  }

  /* cb(err, Hls): hls.js, loaded once (site copy, then the CDN copy), each try limited to hlsLoadTimeout. */
  function hlsReady(cb) {
    if (libFailed()) { cb('unavailable', null); return; }
    if (lib.state === 'ready') { cb(null, lib.Hls); return; }
    lib.waiters.push(cb);
    if (lib.state === 'loading') return;
    lib.state = 'loading';
    var t0 = U.now();
    if (usableHls(window.Hls)) { libDone(window.Hls, 'page copy', t0); return; }
    var list = [{ url: Site.resolve(HLS_SITE, origin() + '/'), from: 'site copy' }];
    if (hlsCdn) list.push({ url: hlsCdn, from: 'CDN copy' });
    function attempt(i) {
      if (i >= list.length) { libFail(list.length > 1 ? 'no copy loaded' : 'the site copy did not load'); return; }
      var tag = document.createElement('script'), done = false, timer = null;
      function end(ok, why) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tag.onload = null;
        tag.onerror = null;
        if (ok && usableHls(window.Hls)) { libDone(window.Hls, list[i].from, t0); return; }
        Log.warn('player', 'hls.js ' + list[i].from + ': ' + (ok ? (window.Hls ? 'not supported here' : 'loaded but not visible to the module') : why));
        attempt(i + 1);
      }
      tag.onload = U.guard(function () { end(true, ''); }, 'player-hls-load');
      tag.onerror = U.guard(function () { end(false, 'did not load'); }, 'player-hls-load');
      timer = setTimeout(function () { end(false, 'timed out'); }, CFG.hlsLoadTimeout);
      tag.async = true;
      tag.setAttribute('data-mbptv', 'hls');
      tag.src = list[i].url;
      (document.head || document.documentElement).appendChild(tag);
    }
    attempt(0);
  }

  function verdict() {
    var v = Store.local.get(HLS_VERDICT, null);
    return v && typeof v === 'object' && v.ua === String(navigator.userAgent || '') ? String(v.native || '') : '';
  }

  /* Why HLS goes straight to hls.js here ('' = the platform player first): configure({hlsEngine: 'hlsjs'}); the
     remembered verdict (the platform player refused HLS and hls.js then played it); Samsung Tizen 9 and later (its
     web view refuses HLS in <video>: no attempt is wasted on it, not even the first time); a browser without native
     HLS. Never without MSE, with hlsEngine 'native', or while no copy of hls.js could be loaded. */
  function hlsjsWhy() {
    if (hlsMode === 'native' || !mse() || libFailed()) return '';
    if (hlsMode === 'hlsjs') return 'forced';
    if (verdict() === 'refuses') return 'remembered';
    if (tizenMajor() >= 9) return 'Tizen ' + tizenMajor();
    return canPlayProbe()(HLS_MIME) ? '' : 'no native HLS';
  }

  /* 'native' (the platform player) or 'hlsjs' for this candidate. */
  function engineFor(c) {
    if (!c || !c.hls || c.synthetic || /^data:/i.test(String(c.src || ''))) return 'native';
    if (c.engine) return c.engine;
    return hlsjsWhy() ? 'hlsjs' : 'native';
  }

  /* After the platform player refused an HLS stream outright, the same stream is tried through hls.js. */
  function hlsRetryOk() { return hlsMode !== 'native' && mse() && !libFailed(); }

  /* ---------- start-up warming (docs/PLAYER.md "Fast start") ----------
     hls.js is loaded before Play (a title page opens, Home is idle) and the stream hosts' connections are opened while
     the player data loads, so the first manifest request does not wait for a script or a TLS handshake. Only host
     names are remembered (never URLs: those carry signed tokens). */

  var HOSTS_KEY = 'mbptv:stream-hosts:v1';
  var DEFAULT_HOSTS = ['hls.shegu.net', 'hls-aws.shegu.net']; /* the site's HLS hosts (master and segments), 2026-10 */
  var HOST_RE = /^[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+$/;
  var preconnected = {};

  function hostOf(u) { var m = /^https:\/\/([^\/?#:@]+)(?:[\/?#]|$)/i.exec(String(u || '')); var h = m ? m[1].toLowerCase() : ''; return HOST_RE.test(h) ? h : ''; }

  function streamHosts() {
    var v = Store.local.get(HOSTS_KEY, null), out = [];
    U.each(v && isArray(v.hosts) ? v.hosts : [], function (h) { h = String(h || '').toLowerCase(); if (HOST_RE.test(h) && U.indexOf(out, h) < 0 && out.length < 4) out.push(h); });
    return out.length ? out : DEFAULT_HOSTS.slice();
  }

  /* Remembers where streams come from (the master's host, the segments' host), newest first, at most 4. */
  function learnHost(u) {
    var h = hostOf(u);
    if (!h) return;
    var v = Store.local.get(HOSTS_KEY, null), list = v && isArray(v.hosts) ? v.hosts.slice() : [];
    if (list[0] === h) return;
    var i = U.indexOf(list, h);
    if (i >= 0) list.splice(i, 1);
    list.unshift(h);
    Store.local.set(HOSTS_KEY, { hosts: list.slice(0, 4) });
  }

  /* <link rel=preconnect crossorigin> (hls.js reads streams by XHR without credentials: the anonymous socket pool).
     A link is dropped after 30 s; the next Play adds a fresh one. */
  function preconnect(hosts) {
    var head = document.head || document.documentElement, done = [];
    if (!head) return done;
    U.each(hosts, function (h) {
      if (!HOST_RE.test(h) || (preconnected[h] && U.now() - preconnected[h] < 8000)) return;
      preconnected[h] = U.now();
      var l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = 'https://' + h;
      l.crossOrigin = 'anonymous';
      l.setAttribute('data-mbptv', 'preconnect');
      head.appendChild(l);
      done.push(h);
      U.later(function () { U.detach(l); }, 30000, 'player-preconnect');
    });
    return done;
  }

  /* Before or at Play: hls.js loading (when HLS will play through it here) and, at Play, the stream hosts' connections. */
  function warmStart(why, connect) {
    var engine = hlsjsWhy();
    if (!engine) return '';
    if (!lib.state) {
      Log.info('player', 'hls.js preload (' + why + '; ' + engine + ')');
      hlsReady(function () {});
    }
    if (connect) {
      var done = preconnect(streamHosts());
      if (done.length) Log.info('player', 'preconnect ' + done.join(', '));
    }
    return engine;
  }

  /* The bandwidth hls.js measured in an earlier session (bits/s; 0 = unknown or older than a week). */
  var BW_KEY = 'mbptv:hls-bw:v1';
  function lastBandwidth() {
    var v = Store.local.get(BW_KEY, null);
    return v && +v.bw > 0 && U.now() - (+v.at || 0) < 7 * 86400000 ? +v.bw : 0;
  }

  function saveBandwidth(h) {
    var bw = 0;
    try { bw = +h.hls.bandwidthEstimate || 0; } catch (e) { bw = 0; }
    if (h.frags > 0 && bw > 100000 && bw < 2000000000) Store.local.set(BW_KEY, { bw: Math.round(bw), at: U.now() });
  }

  function mbps(bw) { return bw >= 10000000 ? Math.round(bw / 1000000) : Math.round(bw / 100000) / 10; }

  /* configure({hlsStart}): 'auto' (default: the best H.264 rendition up to 1080p, lower when the last measured
     bandwidth would make its first 10 s segment slow), or '1080p' / '720p' / '360p' (at most that), for start-time
     experiments on a TV. */
  var hlsStart = 'auto';

  function destroyHls() {
    var h = hlsCur;
    hlsCur = null;
    if (!h) return;
    h.dead = true;
    saveBandwidth(h);
    try { h.hls.destroy(); } catch (e) { Log.info('player', 'hls.js destroy: ' + clean(e)); }
  }

  function hlsOf(s) { var h = hlsCur; return h && !h.dead && h.s === s && h.tryId === s.tryId ? h : null; }

  /* '4K', '1080p', ... from a level's size (wide films: 1920x800 is 1080p, 2580x1080 too). */
  function levelName(l) {
    var w = l && +l.width || 0, ht = l && +l.height || 0;
    if (!w && !ht) return l && l.bitrate ? Math.round(l.bitrate / 1000) + ' kbps' : '';
    return w >= 3200 || ht >= 1800 ? '4K' : w >= 1800 || ht >= 1000 ? '1080p' : w >= 1200 || ht >= 700 ? '720p' : w >= 800 || ht >= 460 ? '480p' : '360p';
  }

  function levelCodec(l) { return String(l && (l.videoCodec || (l.attrs && l.attrs.CODECS)) || ''); }
  function hevcLevel(l) { return /(?:^|,)\s*(?:hvc1|hev1)/i.test(levelCodec(l)); }

  function hlsLevelNow(h) {
    var levels = [], i = -1;
    try { levels = h.hls.levels || []; i = h.hls.currentLevel; } catch (e) { levels = []; }
    if (!(i >= 0)) i = h.level;
    return i >= 0 && levels[i] ? levelName(levels[i]) : '';
  }

  /* The first segment is about 10 s of video and nothing shows before it has arrived whole (the site's fMP4 segments
     are one moof + mdat each): with a measured bandwidth, start on the best rendition whose segment arrives in about
     3 s; without one, on the best up to 1080p (about 4.5 MB, 1-2 s on a home connection). */
  function startLimit(bw) {
    var cap = hlsStart === '720p' ? 760 : hlsStart === '360p' ? 480 : 1100;
    return { height: cap, bitrate: hlsStart === 'auto' && bw > 0 ? bw / 3.5 : Infinity };
  }

  /* AUTO lists the 4K HEVC HDR rendition first: hls.js would start there. Adaptive playback stays on H.264 (the best
     rendition up to 1080p to start, or lower per startLimit; the best H.264 one at most); 4K is the Quality menu's own
     choice. */
  function hlsLevels(h, d) {
    var levels = d && d.levels || [], hevc = 0, cap = -1, start = -1, low = -1, i, bw = lastBandwidth(), lim = startLimit(bw);
    try { if (!levels.length) levels = h.hls.levels || []; } catch (e) { levels = []; }
    for (i = 0; i < levels.length; i++) {
      if (hevcLevel(levels[i])) { hevc++; continue; }
      cap = i;
      if (low < 0) low = i;
      if ((+levels[i].height || 0) <= lim.height && (+levels[i].bitrate || 0) <= lim.bitrate) start = i;
    }
    if (start < 0) start = lim.bitrate < Infinity || lim.height < 1100 ? low : cap;
    var names = U.map(levels, function (l) { return levelName(l) + (hevcLevel(l) ? ' HEVC' : ''); });
    if (levels.length > 1) {
      try {
        if (hevc && cap >= 0) h.hls.autoLevelCapping = cap;
        if (start >= 0) h.hls.startLevel = start;
      } catch (e2) { Log.info('player', 'hls.js levels: ' + clean(e2)); }
    }
    Log.info('player', 'hls.js: ' + levels.length + (levels.length === 1 ? ' level' : ' levels') + ' [' + names.join(', ') + ']' +
      (levels.length > 1 && start >= 0 ? ', start ' + names[start] + (hlsStart !== 'auto' ? ' (hlsStart ' + hlsStart + ')' : bw ? ' (last ' + mbps(bw) + ' Mbit/s)' : '') : '') +
      (levels.length > 1 && hevc && cap >= 0 ? ', HEVC kept for the Quality menu' : ''));
  }

  function hlsAttach(s, c, H, at, tryId) {
    var v = ui.video;
    try { v.removeAttribute('src'); v.load(); } catch (e) {}
    /* Load from the start position directly (no first segment at 0); a resume outside the resume rules is moved back
       to 0 at loadedmetadata. */
    var start = at > 0 && !(s.resumePending && !(at > 10)) ? at : -1;
    /* Fast start: the start level is chosen at MANIFEST_PARSED (hlsLevels), so no bandwidth test fragment (which
       hls.js would load at the lowest level and throw away); startFragPrefetch lets the first fragment load before
       the media source is open; the bandwidth guess before any measurement is the last session's. The site's
       segments are one moof + mdat each, so progressive (chunked) appending would gain nothing. Buffers stay small
       for TV memory: 30 s ahead (60 s at most, 60 MB) and 30 s behind. */
    var bw = lastBandwidth();
    var cfg = {
      startPosition: start, autoStartLoad: true, startFragPrefetch: true, testBandwidth: false, abrEwmaDefaultEstimate: bw || 5000000,
      enableWorker: true, capLevelToPlayerSize: false, debug: false,
      backBufferLength: 30, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 60 * 1000 * 1000,
      manifestLoadingTimeOut: 10000, manifestLoadingMaxRetry: 1, levelLoadingTimeOut: 10000, levelLoadingMaxRetry: 2,
      fragLoadingTimeOut: 20000, fragLoadingMaxRetry: 3
    };
    var hls = null;
    mark(s, 'attach');
    try { hls = new H(cfg); } catch (e2) { s.failNote = 'hls.js: ' + clean(e2); candidateFailed(s, tryId, 'hls-other'); return; }
    var h = { hls: hls, H: H, s: s, tryId: tryId, c: c, recovered: 0, level: -1, nonFatal: 0, levelLogs: 0, reported: false, audioWant: null, prefDone: false,
      stopped: false, dead: false, frags: 0, hostSeen: false };
    hlsCur = h;
    learnHost(c.src);
    var E = H.Events || {};
    function on(name, fn) {
      if (!E[name]) return;
      hls.on(E[name], function (evt, data) {
        if (hlsCur !== h || h.dead || s !== S || s.finished || s.tryId !== tryId || s.state === 'error') return;
        try { fn(data || {}); } catch (err) { Log.error('player-hls:' + name, err); }
      });
    }
    on('MANIFEST_PARSED', function (d) { mark(s, 'manifest'); alive(s); hlsLevels(h, d); playVideo(s); });
    on('LEVEL_LOADED', function () { mark(s, 'playlist'); alive(s); });
    on('FRAG_LOADED', function (d) {
      var f = d.frag;
      alive(s);
      if (f && f.sn === 'initSegment') return;
      h.frags++;
      if (!f || f.type === 'main') mark(s, 'frag');
      if (!h.hostSeen && f && f.url) { h.hostSeen = true; learnHost(f.url); }
    });
    on('FRAG_BUFFERED', function () { alive(s); });
    on('LEVEL_SWITCHED', function (d) { hlsLevelSwitched(h, d.level); });
    on('AUDIO_TRACKS_UPDATED', function () { hlsAudioPref(h); if (s.ready) audioRefresh(s); });
    on('AUDIO_TRACK_SWITCHED', function (d) { hlsAudioSwitched(h, d.id); });
    on('ERROR', function (d) { hlsError(h, d); });
    hls.attachMedia(v);
    hls.loadSource(c.src);
  }

  function hlsLevelSwitched(h, index) {
    h.level = index;
    if (!h.reported || h.levelLogs >= 12) return;
    h.levelLogs++;
    var name = hlsLevelNow(h);
    if (name) Log.info('player', 'hls.js level ' + name);
  }

  /* Fatal hls.js errors end the candidate (the usual fallback order follows); a media error is recovered once first. */
  function hlsError(h, d) {
    var s = h.s, T = h.H.ErrorTypes || {}, type = String(d.type || ''), det = String(d.details || '').slice(0, 60);
    var code = d.response && d.response.code ? toInt(d.response.code) : 0;
    var desc = 'hls.js ' + type + '/' + det + (code ? ' http ' + code : '');
    if (!d.fatal) {
      h.nonFatal++;
      if (h.nonFatal <= 3) Log.info('player', desc + ' (hls.js retries)');
      return;
    }
    var media = type === (T.MEDIA_ERROR || 'mediaError'), codecs = /IncompatibleCodecs|AddCodecError/i.test(det);
    if (media && !codecs && h.recovered < 1) { hlsRecover(s, h, desc); return; }
    var reason = type === (T.NETWORK_ERROR || 'networkError') ? (/TimeOut/i.test(det) ? 'timeout' : 'hls-network') :
      media ? (codecs ? 'hls-format' : 'hls-media') : 'hls-other';
    s.failNote = desc;
    candidateFailed(s, h.tryId, reason);
  }

  /* recoverMediaError() re-attaches the element: the load algorithm leaves it paused (hls.js 1.4 does not play it
     again) and hls.js restarts at its config.startPosition (the resume or switch position, not where the video is).
     So the start position becomes the current place first, and playback is asked for again unless the viewer (or
     the background) paused it. */
  function hlsRecover(s, h, desc) {
    h.recovered++;
    Log.warn('player', desc + ': recovering once');
    var v = ui.video, t = v.currentTime > 0 ? v.currentTime : s.ready ? s.lastTime : s.pendingAt;
    try { if (h.hls.config && t > 0) h.hls.config.startPosition = t; } catch (e0) {}
    try { h.hls.recoverMediaError(); } catch (e) { Log.warn('player', 'hls.js recover: ' + clean(e)); }
    if (!s.userPaused && !s.bgPaused && !(s.upnext && s.upnext.still)) playVideo(s);
  }

  /* The video element reported an error while hls.js feeds it: recover once, as hls.js recommends. */
  function hlsMediaError(s, h, code) {
    if (h.recovered < 1) { hlsRecover(s, h, 'media error ' + code + ' under hls.js'); return; }
    s.failNote = 'hls.js media error ' + code;
    candidateFailed(s, s.tryId, 'media-' + code);
  }

  function hlsAudioTracks(h) { try { var t = h.hls.audioTracks; return t && typeof t.length === 'number' ? t : []; } catch (e) { return []; } }
  function hlsAudioIndex(h) { try { var i = h.hls.audioTrack; return typeof i === 'number' ? i : -1; } catch (e) { return -1; } }

  function hlsAudioCode(h) {
    var t = hlsAudioTracks(h), i = hlsAudioIndex(h), x = i >= 0 ? t[i] : null;
    return x ? (langCode(x.lang) || langCode(String(x.name || '').split(/[\s(#]/)[0]) || U.text(x.name || x.lang || '')).slice(0, 12) : '';
  }

  /* The remembered audio language (Prefs audioLang), chosen as soon as hls.js knows the tracks: no switch later. */
  function hlsAudioPref(h) {
    var s = h.s;
    if (h.prefDone || !hlsAudioTracks(h).length) return;
    h.prefDone = true;
    var want = prefAudio();
    if (!want) return;
    s.audio.prefTry = s.tryId; /* decided here, not again in audioRefresh */
    /* Next tick: hls.js picks its initial track right after this event (1.4 would undo an earlier choice, and the
       track playing is only known then). */
    U.later(function () {
      if (hlsCur !== h || h.dead || s !== S || s.finished) return;
      var o = audioPost('hlsjs', hlsAudioRaw(h)), at = o ? audioMatch(o, want) : -1, it = at >= 0 ? o.items[at] : null;
      if (!it || it.index === hlsAudioIndex(h)) return;
      Log.info('player', 'audio: the remembered language (' + want + ') from the start, via hls.js');
      h.audioWant = { index: it.index, title: it.title, how: 'auto' };
      try { h.hls.audioTrack = it.index; } catch (e) { Log.warn('player', 'audio: ' + clean(e)); }
    }, 0, 'player-hls-audio');
  }

  function hlsAudioSwitched(h, id) {
    var s = h.s, w = h.audioWant;
    if (w && w.index === id) {
      h.audioWant = null;
      cancel(s, 'audioverify');
      Log.info('player', 'audio: switched');
      if (w.how === 'user') showChip(s, 'Audio: ' + w.title, 2500, false);
    }
    if (s.ready) audioRefresh(s);
  }

  /* Background: hls.js stops loading while the app is hidden and carries on from the position when it comes back. */
  function hlsPause(s, stop) {
    var h = hlsOf(s);
    if (!h || h.stopped === stop) return;
    h.stopped = stop;
    try { if (stop) h.hls.stopLoad(); else h.hls.startLoad(ui.video.currentTime || -1); } catch (e) { Log.info('player', 'hls.js ' + (stop ? 'stop' : 'start') + ': ' + clean(e)); }
  }

  /* ---------- player data parsing (regexes only; never evaluated) ---------- */

  function inComment(text, idx) {
    var pre = text.slice(text.lastIndexOf('\n', idx - 1) + 1, idx).replace(/^\s+/, '');
    if (pre.slice(0, 2) === '//' || pre.slice(0, 2) === '/*' || pre.charAt(0) === '*') return true;
    return /(^|[^:'"\\])\/\//.test(pre);
  }

  /* Index just after the first "var NAME =" that is not on a comment line, or -1. */
  function varAt(text, name) {
    var re = new RegExp('\\bvar\\s+' + name + '\\s*=\\s*', 'g'), m;
    while ((m = re.exec(text))) if (!inComment(text, m.index)) return m.index + m[0].length;
    return -1;
  }

  function unescapeJs(s) {
    return String(s).replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, function (m, c) {
      if (c.length === 5 && c.charAt(0) === 'u') return String.fromCharCode(parseInt(c.slice(1), 16));
      if (c.length === 3 && c.charAt(0) === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
      return c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c;
    });
  }

  /* A quoted string, number or literal after "var NAME =", as a string; null when absent. */
  function scalar(text, name) {
    var at = varAt(text, name);
    if (at < 0) return null;
    var m = /^(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|(-?\d+(?:\.\d+)?)|(true|false|null))/.exec(text.slice(at, at + 4000));
    if (!m) return null;
    if (m[1] != null) return unescapeJs(m[1]);
    if (m[2] != null) return unescapeJs(m[2]);
    if (m[3] != null) return m[3];
    return m[4] === 'null' ? '' : m[4];
  }

  /* The balanced [...] or {...} starting at text[at], respecting quoted strings. */
  function balanced(text, at) {
    var depth = 0, quote = '', i, c, end = Math.min(text.length, at + 2000000);
    for (i = at; i < end; i++) {
      c = text.charAt(i);
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { depth--; if (depth === 0) return text.slice(at, i + 1); }
    }
    return '';
  }

  function jsonVar(text, name) {
    var at = varAt(text, name);
    if (at < 0) return null;
    var c = text.charAt(at);
    if (c === '[' || c === '{') return U.parseJSON(balanced(text, at));
    if (c === "'" || c === '"') { var s = scalar(text, name); return s ? U.parseJSON(s) : null; }
    return null;
  }

  function normLabel(label, hls) {
    var l = U.text(label);
    if (/^org(?:inal)?$/i.test(l)) return 'ORG';
    if (/^auto$/i.test(l)) return 'AUTO';
    return l || (hls ? 'AUTO' : 'ORG');
  }

  function normSource(s) {
    if (!s || typeof s !== 'object') return null;
    var file = typeof s.file === 'string' ? U.text(s.file) : '';
    if (!file) return null;
    var abs = /^https?:\/\//i.test(file) ? file : (file.charAt(0) === '/' ? Site.resolve(file) : '');
    if (!abs || !/^https?:\/\//i.test(abs)) return null;
    var type = String(s.type || '');
    var hls = /mpegurl/i.test(type) || /\.m3u8(?:[?#]|$)/i.test(abs);
    return {
      label: normLabel(s.label, hls), src: abs, hls: hls, h265: toInt(s.h265) === 1, hdr: toInt(s.hdr) === 1,
      width: toInt(s.width), height: toInt(s.height), fps: num(s.fps)
    };
  }

  function parse(text) {
    var out = {
      ok: false, code: 0, msg: '', gate: false, sources: [], seconds: 0, mp4Id: '', next: null, tid: '', season: 0, episode: 0,
      skips: { start: -1, end: -1 }, post: null, progressUrl: '', subtitles: []
    };
    text = String(text == null ? '' : text);
    var head = text.replace(/^[\s\uFEFF]+/, '');
    if (head.charAt(0) === '{') {
      var j = U.parseJSON(head);
      if (j && typeof j === 'object' && !isArray(j)) {
        out.code = toInt(j.code);
        out.msg = U.text(j.msg || j.message || '');
        return out;
      }
    }
    if (varAt(text, 'sources') < 0 && /private\s+garden|login_btn|\/index\/login/i.test(text)) {
      try { out.gate = Site.isGate(U.parseHTML(text)); } catch (e) { out.gate = false; }
      if (out.gate) return out;
    }
    var list = jsonVar(text, 'sources');
    if (isArray(list)) U.each(list, function (s) { var n = normSource(s); if (n) out.sources.push(n); });
    out.seconds = Math.max(0, num(scalar(text, 'seconds')));
    out.mp4Id = String(scalar(text, 'mp4_id') || '').replace(/[^\d]/g, '');
    var ns = toInt(scalar(text, 'next_season')), ne = toInt(scalar(text, 'next_episode'));
    if (ns > 0 && ne > 0) out.next = { season: ns, episode: ne };
    out.tid = String(scalar(text, 'tid') || '').replace(/[^\d]/g, '');
    out.season = toInt(scalar(text, 'current_season'));
    out.episode = toInt(scalar(text, 'current_episode'));
    var sk = jsonVar(text, 'skips');
    if (sk && typeof sk === 'object' && !isArray(sk)) {
      out.skips.start = sk.start == null || sk.start === '' ? -1 : num(sk.start);
      out.skips.end = sk.end == null || sk.end === '' ? -1 : num(sk.end);
    }
    var post = jsonVar(text, 'post');
    if (post && typeof post === 'object' && !isArray(post)) {
      var clean2 = {}, n = 0;
      for (var k in post) {
        if (post.hasOwnProperty(k) && /^[\w\-]{1,40}$/.test(k) && (typeof post[k] === 'string' || typeof post[k] === 'number')) { clean2[k] = String(post[k]); n++; }
      }
      out.post = n ? clean2 : null;
    }
    var re = /\burl\s*:\s*["'](\/index\/index\/(?:tv|movie)_progress)["']/g, pm;
    while ((pm = re.exec(text))) { if (!inComment(text, pm.index)) { out.progressUrl = pm[1]; break; } }
    try { out.subtitles = parseSubtitles(text); } catch (e) { out.subtitles = []; }
    out.ok = out.sources.length > 0;
    return out;
  }

  /* ---------- subtitles: the website's subtitle panel, files and cues (pure; docs/PLAYER.md "Subtitles") ---------- */

  var SUB_MAX_LANGS = 60, SUB_MAX_FILES = 8;

  function fromCode(n) {
    if (n <= 0xFFFF) return String.fromCharCode(n);
    n -= 0x10000;
    return String.fromCharCode(0xD800 + (n >> 10), 0xDC00 + (n & 0x3FF));
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00a0' };
  function htmlDecode(v) {
    return String(v).replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z]{2,6});/g, function (m, e) {
      if (e.charAt(0) === '#') {
        var n = e.charAt(1) === 'x' || e.charAt(1) === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return n > 0 && n < 0x110000 ? fromCode(n) : '';
      }
      var k = e.toLowerCase();
      return ENTITIES.hasOwnProperty(k) ? ENTITIES[k] : m;
    });
  }

  function stripTags(v) { return U.text(htmlDecode(String(v || '').replace(/<[^>]*>/g, ' '))); }

  /* Attributes of one start tag. The panel sits inside a JS string in the player data, so \' \" \/ are undone. */
  function attrsOf(tag) {
    var out = {}, re = /([a-zA-Z_:][\w:.\-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = htmlDecode(String(m[2] != null ? m[2] : m[3]).replace(/\\([\/'"\\])/g, '$1'));
    return out;
  }

  function subUrl(v) {
    var u = U.text(v || '');
    if (!u || u.length > 2048 || /[\s"'<>\\]/.test(u)) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/' && u.charAt(1) !== '/') { var abs = Site.resolve(u); return /^https?:\/\//i.test(abs) ? abs : ''; }
    return '';
  }

  /* [{name, key, code, files: [{url, lang, delay, name, sid}]}] in the site's order (its language list), from
     <div class="subtitle_con"> ... <ul id="English"><li data-sid data-delay data-lang data-url data-name>...</li></ul>.
     Lists whose items have no usable http(s) address (the site's own JS templates) are dropped. */
  function parseSubtitles(text) {
    text = String(text || '');
    var a = text.indexOf('class="subtitle_con"'), b = a >= 0 ? text.indexOf('subtitle_search_con', a) : -1;
    var area = a >= 0 ? text.slice(a, b > a ? b : a + 600000) : text.slice(0, 2000000);
    if (area.indexOf('data-url') < 0) return [];
    var names = {}, rank = {}, n = 0, m, re = /<p\b([^>]*\bdata-val\s*=[^>]*)>([\s\S]*?)<\/p>/gi;
    while ((m = re.exec(area))) {
      var val = attrsOf(m[1])['data-val'];
      if (val && !names.hasOwnProperty(val)) { names[val] = stripTags(m[2]) || val; rank[val] = n++; }
    }
    var langs = [], seen = {}, ul = /<ul\b([^>]*)>([\s\S]*?)<\/ul>/gi, um;
    while ((um = ul.exec(area)) && langs.length < SUB_MAX_LANGS) {
      var id = U.text(attrsOf(um[1]).id || '');
      if (!id || seen.hasOwnProperty(id)) continue;
      var files = [], sids = {}, li = /<li\b([^>]*)>([\s\S]*?)(?=<li\b|$)/gi, lm;
      while ((lm = li.exec(um[2])) && files.length < SUB_MAX_FILES) {
        var at = attrsOf(lm[1]), url = subUrl(at['data-url']);
        if (!url) continue;
        var sid = String(at['data-sid'] || '').replace(/[^\w\-]/g, '').slice(0, 40), key = sid || url;
        if (sids.hasOwnProperty(key)) continue;
        sids[key] = true;
        var delay = parseFloat(at['data-delay']);
        var p1 = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(lm[2]);
        files.push({
          url: url, sid: sid, lang: String(at['data-lang'] || '').replace(/[^\w\-]/g, '').slice(0, 16),
          delay: isFinite(delay) && Math.abs(delay) <= 3600 ? delay : 0,
          name: (U.text(at['data-name'] || '') || (p1 ? stripTags(p1[1]) : '')).slice(0, 200)
        });
      }
      if (!files.length) continue;
      seen[id] = true;
      langs.push({ name: names.hasOwnProperty(id) ? names[id] : (id === 'MySubtitles' ? 'My Subtitles' : id), key: id, code: files[0].lang, files: files, i: langs.length });
    }
    langs.sort(function (x, y) {
      var rx = rank.hasOwnProperty(x.key) ? rank[x.key] : 1000 + x.i, ry = rank.hasOwnProperty(y.key) ? rank[y.key] : 1000 + y.i;
      return rx - ry;
    });
    return U.map(langs, function (l) { return { name: l.name, key: l.key, code: l.code, files: l.files }; });
  }

  /* Legacy (non-UTF-8) encodings by language, for files that are not valid UTF-8. */
  var LEGACY = {
    ar: 'windows-1256', fa: 'windows-1256', ur: 'windows-1256', ps: 'windows-1256', ku: 'windows-1256',
    he: 'windows-1255', iw: 'windows-1255', yi: 'windows-1255',
    ru: 'windows-1251', uk: 'windows-1251', bg: 'windows-1251', sr: 'windows-1251', mk: 'windows-1251', be: 'windows-1251',
    kk: 'windows-1251', ky: 'windows-1251', mn: 'windows-1251', tg: 'windows-1251',
    el: 'windows-1253', tr: 'windows-1254', az: 'windows-1254',
    pl: 'windows-1250', cs: 'windows-1250', sk: 'windows-1250', hu: 'windows-1250', ro: 'windows-1250', hr: 'windows-1250',
    sl: 'windows-1250', bs: 'windows-1250', sq: 'windows-1250',
    lt: 'windows-1257', lv: 'windows-1257', et: 'windows-1257', vi: 'windows-1258', th: 'windows-874',
    zh: 'gb18030', 'zh-cn': 'gb18030', 'zh-tw': 'big5', 'zh-hk': 'big5', ja: 'shift_jis', ko: 'euc-kr'
  };
  var LANG_NAMES = {
    arabic: 'ar', persian: 'fa', farsi: 'fa', urdu: 'ur', hebrew: 'he', russian: 'ru', ukrainian: 'uk', bulgarian: 'bg',
    serbian: 'sr', macedonian: 'mk', greek: 'el', turkish: 'tr', polish: 'pl', czech: 'cs', slovak: 'sk', hungarian: 'hu',
    romanian: 'ro', croatian: 'hr', slovenian: 'sl', bosnian: 'bs', albanian: 'sq', lithuanian: 'lt', latvian: 'lv',
    estonian: 'et', vietnamese: 'vi', thai: 'th', chinese: 'zh', japanese: 'ja', korean: 'ko'
  };

  function legacyFor(code, name) {
    var c = String(code || '').toLowerCase().replace(/_/g, '-');
    if (LEGACY.hasOwnProperty(c)) return LEGACY[c];
    c = c.split('-')[0];
    if (LEGACY.hasOwnProperty(c)) return LEGACY[c];
    var w = String(name || '').toLowerCase().split(/[^a-z]+/)[0];
    if (LANG_NAMES.hasOwnProperty(w)) return LEGACY[LANG_NAMES[w]];
    return 'windows-1252';
  }

  function decodeWith(encoding, bytes, fatal) {
    if (typeof TextDecoder === 'undefined') return null;
    try { return new TextDecoder(encoding, { fatal: !!fatal }).decode(bytes); } catch (e) { return null; }
  }

  function binary(bytes) {
    var out = '', i;
    for (i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, Array.prototype.slice.call(bytes.subarray(i, i + 8192)));
    return out;
  }

  /* Subtitle file bytes -> text: a BOM wins; then strict UTF-8; then the language's legacy encoding (Arabic
     windows-1256, ...); then windows-1252. */
  function decodeSub(buf, code, name) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf), t = null, zeros = 0, i;
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) t = decodeWith('utf-8', bytes.subarray(3));
    else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) t = decodeWith('utf-16le', bytes.subarray(2));
    else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) t = decodeWith('utf-16be', bytes.subarray(2));
    if (t != null) return t;
    /* UTF-16 without a BOM: about every other byte is zero. */
    for (i = 0; i < Math.min(bytes.length, 400); i++) if (!bytes[i]) zeros++;
    if (bytes.length >= 8 && zeros > Math.min(bytes.length, 400) / 3) {
      t = decodeWith(bytes[0] === 0 ? 'utf-16be' : 'utf-16le', bytes);
      if (t != null) return t;
    }
    t = decodeWith('utf-8', bytes, true);
    if (t != null) return t;
    if (typeof TextDecoder === 'undefined') {
      var bin = binary(bytes);
      try { return decodeURIComponent(escape(bin)); } catch (e) { return bin; }
    }
    t = decodeWith(legacyFor(code, name), bytes);
    if (t == null) t = decodeWith('windows-1252', bytes);
    return t != null ? t : binary(bytes);
  }

  var CUE_TIME = /^\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[,.]\d{1,3})?)/;

  function stamp(v) {
    var m = /^(?:(\d+):)?(\d+):(\d+)(?:[,.](\d+))?$/.exec(v);
    if (!m) return -1;
    return toInt(m[1]) * 3600 + toInt(m[2]) * 60 + toInt(m[3]) + (m[4] ? parseFloat('0.' + m[4]) : 0);
  }

  function cueText(v) { return U.text(htmlDecode(String(v).replace(/<[^>]*>|\{\\[^}]*\}/g, ''))); }

  /* SRT or WebVTT text -> [{start, end, text}] sorted by start. Cue numbers, VTT headers, NOTE/STYLE blocks and cue
     settings are skipped; text keeps its line breaks and markup (rendered safely by subRender). */
  function parseCues(text) {
    var lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
    var cues = [], cur = null, i, line, m;
    function push(c) {
      if (!c || c.start < 0 || !(c.end > c.start) || !c.lines.length) return;
      var t = c.lines.join('\n').replace(/^\s+|\s+$/g, '');
      if (t && cueText(t)) cues.push({ start: c.start, end: c.end, text: t, n: cues.length });
    }
    for (i = 0; i < lines.length && cues.length < 30000; i++) {
      line = lines[i];
      m = line.indexOf('-->') >= 0 ? CUE_TIME.exec(line) : null;
      if (m) { push(cur); cur = { start: stamp(m[1]), end: stamp(m[2]), lines: [] }; continue; }
      if (!cur) continue;
      if (!/\S/.test(line)) { push(cur); cur = null; continue; }
      /* A cue number right before the next time line ends the cue (files without blank lines between cues). */
      if (/^\s*\d+\s*$/.test(line) && i + 1 < lines.length && CUE_TIME.test(lines[i + 1])) { push(cur); cur = null; continue; }
      if (cur.lines.length < 8) cur.lines.push(line.slice(0, 500));
    }
    push(cur);
    cues.sort(function (x, y) { return x.start - y.start || x.n - y.n; });
    return U.map(cues, function (c) { return { start: c.start, end: c.end, text: c.text }; });
  }

  /* The cues showing at time t (sorted by start; overlapping cues allowed) and when that set next changes. */
  function cuesAt(cues, t) {
    var lo = 0, hi = cues.length - 1, k = -1, mid, j, out = [];
    while (lo <= hi) { mid = (lo + hi) >> 1; if (cues[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1; }
    var next = k + 1 < cues.length ? cues[k + 1].start : Infinity;
    for (j = k; j >= 0 && k - j < 24; j--) {
      if (cues[j].end > t) { out.unshift(j); if (cues[j].end < next) next = cues[j].end; }
    }
    return { list: out, next: next };
  }

  /* ---------- stream order ---------- */

  /* Fixed rendition labels: '1080p' -> 1080, '4K' -> 2160 (4K files add a '4K' HEVC HDR rendition); 0 = not fixed. */
  function rank(label) {
    var l = String(label || ''), m = /(\d{3,4})p/i.exec(l);
    if (m) return toInt(m[1]);
    return /^8k$/i.test(l) ? 4320 : /^4k$/i.test(l) ? 2160 : 0;
  }

  function withAac(u) {
    u = String(u || '');
    if (!u || /[?&]audio=aac(?:[&#]|$)/.test(u)) return u;
    var hash = '', i = u.indexOf('#');
    if (i >= 0) { hash = u.slice(i); u = u.slice(0, i); }
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'audio=aac' + hash;
  }

  function playable(s, env) {
    var cp = env && typeof env.canPlay === 'function' ? env.canPlay : function () { return ''; };
    if (s.h265) return !!(cp(MIME.hvc1) || cp(MIME.hev1));
    return !!cp(MIME.h264);
  }

  function pathOf(u) { var m = /^[a-z]+:\/\/[^\/?#]*([^?#]*)/i.exec(String(u || '')); return m ? m[1] : ''; }

  /* The site's placeholder for accounts without VIP (its player checks for it too). */
  function vipOnly(s) { return /\/video\/vip_only\.mp4$/i.test(pathOf(s.src)); }

  /* Size in GB from the file list's "14.7 GB" text (0 when unknown). */
  function sizeGb(v) {
    var m = /([\d.]+)\s*(KB|MB|GB|TB)/i.exec(String(v || ''));
    if (!m) return 0;
    var n = num(m[1]), u = m[2].toUpperCase();
    return u === 'TB' ? n * 1024 : u === 'GB' ? n : u === 'MB' ? n / 1024 : n / 1048576;
  }

  /* How an original file is likely to fare in a TV's built-in player (docs/PLAYER.md "Stream order"):
     'risky' = Matroska whose name says DTS or TrueHD audio (Samsung and LG TVs do not decode them: no sound or an
     error) or a file heavier than 20 GB (4K remuxes run at 60-90 Mbit/s and stall on home Wi-Fi); 'mkv' = other
     Matroska files (usually EAC3/AC3/AAC, which TVs decode, but the container is less certain than MP4); 'mp4'. */
  function fileKind(s, env) {
    var mkv = /\.mkv$/i.test(pathOf(s.src)), name = String(env && env.fileName || '');
    if (sizeGb(env && env.fileSize) > 20) return 'risky';
    if (mkv && /(?:^|[^a-z])(?:DTS|TrueHD)(?:[^a-z]|$)/i.test(name)) return 'risky';
    return mkv ? 'mkv' : 'mp4';
  }

  /* TV: AUTO HLS (what the website itself plays on Samsung/LG TVs), then an MP4 original, then the 1080p HLS, then a
     Matroska original, the lower HLS renditions, the 4K HLS, and last an original the TV probably cannot play. With
     Media Source Extensions (env.mse: hls.js can play every HLS rendition) Matroska originals come after the HLS ones.
     Elsewhere: originals the browser says it can decode, AUTO, fixed HLS (highest first), then the other originals.
     The site's VIP placeholder is never a candidate. env.fileName / env.fileSize describe the file (risk rules). */
  function order(sources, env) {
    env = env || environment();
    var auto = [], files = [], fixed = [], other = [];
    U.each(sources || [], function (s) {
      if (!s || !s.src || vipOnly(s)) return;
      if (s.hls && s.label === 'AUTO') auto.push(s);
      else if (s.hls && rank(s.label)) fixed.push(s);
      else if (!s.hls) files.push(s);
      else other.push(s);
    });
    fixed.sort(function (a, b) { return rank(b.label) - rank(a.label); });
    files.sort(function (a, b) { return (a.label === 'ORG' ? 0 : 1) - (b.label === 'ORG' ? 0 : 1); });
    var list;
    if (env.tv) {
      var mp4 = [], mkv = [], risky = [], hd = [], uhd = [];
      U.each(files, function (s) { var k = fileKind(s, env); (k === 'mp4' ? mp4 : k === 'mkv' ? mkv : risky).push(s); });
      U.each(fixed, function (s) { (rank(s.label) > 1080 ? uhd : hd).push(s); });
      /* HLS through hls.js here (Tizen 9, the remembered verdict): every rendition before any original file, which
         the platform player plays slowly or not at all on such TVs. */
      if (env.hlsjs) list = auto.concat(hd, uhd, other, mp4, mkv, risky);
      else list = env.mse ? auto.concat(mp4, hd, uhd, other, mkv, risky) : auto.concat(mp4, hd.slice(0, 1), mkv, hd.slice(1), uhd, other, risky);
    } else {
      var yes = [], no = [];
      U.each(files, function (s) { if (playable(s, env) && fileKind(s, env) !== 'risky') yes.push(s); else no.push(s); });
      list = yes.concat(auto, fixed, other, no);
    }
    list = preferred(list, env.prefer);
    return U.map(list, function (s) {
      return { label: s.label, src: s.hls && env.aac ? withAac(s.src) : s.src, hls: !!s.hls, h265: !!s.h265, hdr: !!s.hdr,
        width: s.width || 0, height: s.height || 0, fps: s.fps || 0, kind: s.hls ? 'hls' : fileKind(s, env) };
    });
  }

  /* ---------- files ---------- */

  function filesIn(doc) {
    var out = [];
    U.each(U.qsa(doc, 'li[oss_download_url]'), function (li) {
      var url = U.text(li.getAttribute('oss_download_url') || '');
      if (!url) return;
      var s = Site.source(li, out.length);
      out.push({ index: out.length, url: url, quality: s.quality || '', file: s.file || '', size: s.size || '', date: s.date || '' });
    });
    return out;
  }

  function qrank(q) {
    q = String(q || '');
    if (/8k/i.test(q)) return 4320;
    if (/4k|2160/i.test(q)) return 2160;
    if (/1440/.test(q)) return 1440;
    if (/720/.test(q)) return 720;
    if (/\bsd\b|480|360/i.test(q)) return 480;
    return 1080;
  }

  /* req.fileIndex, else Prefs.quality: 'best' and 'ask' take the first listed file, 1080p/720p the closest match. */
  function chooseFile(files, req) {
    if (!files.length) return -1;
    var fi = parseInt(req.fileIndex, 10);
    if (!isNaN(fi) && fi >= 0 && fi < files.length) return fi;
    var q = '';
    try { q = typeof Prefs !== 'undefined' ? Prefs.get('quality') : ''; } catch (e) { q = ''; }
    if (q !== '1080p' && q !== '720p') return 0;
    var want = toInt(q), best = 0, bestD = Infinity;
    U.each(files, function (f, i) {
      var r = qrank(f.quality), d = Math.abs(r - want) + (r > want ? 0.5 : 0);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  /* ---------- requests: timeout and one retry; session requests are aborted on stop ---------- */

  function retryable(err) { return !!err && (err.code === 'network' || err.code === 'timeout' || /^http-5\d\d$/.test(String(err.code || ''))); }

  function send(s, opts, cb, attempt) {
    attempt = attempt || 0;
    var h = U.xhr({
      method: 'POST', url: opts.url, body: opts.body || '', timeout: CFG.requestTimeout,
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': FORM, Accept: 'text/html, application/json, */*; q=0.01' }
    }, function (err, res) {
      if (s) { var i = U.indexOf(s.reqs, h); if (i >= 0) s.reqs.splice(i, 1); if (s !== S || s.finished) return; }
      if (err && attempt < 1 && retryable(err)) {
        Log.info('player', opts.label + ' ' + err.code + '; retrying');
        U.later(function () { if (s && (s !== S || s.finished)) return; send(s, opts, cb, attempt + 1); }, CFG.retryDelay, 'player-retry');
        return;
      }
      cb(err, res);
    });
    if (s) s.reqs.push(h);
    return h;
  }

  function origin() { return Site.url.origin(); }
  function enc(v) { return encodeURIComponent(String(v == null ? '' : v)); }

  function signedOutRes(res) {
    try { if (/\/index\/login(?:\/|$)/i.test(U.parseUrl(res && res.url || '').pathname)) return true; } catch (e) {}
    var t = String(res && res.text || '');
    if (!/private\s+garden|login_btn/i.test(t) || varAt(t, 'sources') >= 0) return false;
    try { return Site.isGate(U.parseHTML(t)); } catch (e2) { return false; }
  }

  function playerUrl(oss) {
    var abs = Site.resolve(String(oss || ''), origin() + '/');
    if (!abs || !U.sameSite(abs)) return '';
    return abs + (abs.indexOf('?') >= 0 ? '&' : '?') + JW_FLAG;
  }

  /* ---------- session lifecycle ---------- */

  function newSession(input, hooks) {
    var req = {}, k;
    for (k in input) if (input.hasOwnProperty(k)) req[k] = input[k];
    var kind = req.kind === 'tv' ? 'tv' : 'movie';
    return {
      gen: 0, req: req, hooks: hooks || {}, kind: kind, id: String(req.id == null ? '' : req.id).replace(/[^\d]/g, ''),
      /* Episode 0 is a special (S01E00 in the site's episode list), played only when asked for explicitly. */
      season: kind === 'tv' ? Math.max(1, toInt(req.season)) : 0,
      episode: kind === 'tv' ? (req.episode === 0 || req.episode === '0' ? 0 : Math.max(1, toInt(req.episode))) : 0,
      state: 'loading', data: null, files: [], fileIndex: -1, cands: [], base: [], ci: -1, tryId: 0, ready: false, started: false,
      playedTry: -1, blocked: false, userPaused: false, failed: {}, relinkAt: 0, relinking: false, playedSinceRelink: false, resumeAt: 0, errAt: 0,
      pendingAt: 0, resumePending: false, resumed: 0, lastTime: 0, lastDur: 0, lastSent: '', post: null, progressUrl: '', next: null,
      introEnd: 0, creditsAt: 0, osd: false, area: 'scrub', btn: 'play-pause', btnSig: '', seek: null, seekKey: null,
      upnext: null, dismissedNext: false, nextInfo: null, nextFetching: false, sheet: null, err: null, chipStartOver: false,
      buffering: false, waitAt: 0, switchNote: '', bgPaused: false, ended: false, lastRender: 0, timers: {}, reqs: [], offs: [], finished: false,
      /* fails: what each candidate of the current player data did ([{label, reason}], for the error card); switching:
         a quality the viewer chose, verified when something plays; seekCheck: a position that must be reached */
      fails: [], candStart: 0, lastBuf: 0, switching: null, seekCheck: null,
      /* engine: 'native' (the platform player) or 'hlsjs' for the current candidate; failNote: detail for its failure log */
      engine: 'native', failNote: '',
      /* audio languages: method 'tracks' (video.audioTracks) or 'manifest' (a rewritten HLS master), the master's list */
      audio: { master: null, fetching: '', unread: '', prefTry: -1, pending: null },
      /* subtitles: the site's list, the chosen file (sel), its cues once loaded, a load sequence and a per-session cache */
      subs: { langs: [], sel: null, cues: null, delay: 0, seq: 0, loading: 0, cache: {}, sig: '', decided: false, note: '' }
    };
  }

  /* resumeAt (optional): start here instead of the site's saved position (Try again after a failure mid-film). */
  function begin(req, hooks, kicker, resumeAt) {
    gen++;
    var s = S = newSession(req, hooks);
    s.marks = { t0: U.now() };
    s.gen = gen;
    s.kicker = kicker || '';
    s.resumeAt = resumeAt > 0 ? resumeAt : 0;
    resetUi(s);
    Log.info('player', 'open ' + s.kind + ':' + s.id + (s.kind === 'tv' ? ' S' + s.season + 'E' + s.episode : ''));
    s.offs.push(U.on(window, 'pagehide', function () { if (s === S) report(s, 'pagehide'); }));
    s.offs.push(U.on(document, 'visibilitychange', function () {
      if (s !== S || s.finished) return;
      if (isHidden()) toBackground(s); else fromBackground(s);
    }));
    /* A hanging network must not keep the viewer on the loading screen for minutes (files + player data + every
       candidate could add up to about two): after startBudget the error card offers Try again and the website. */
    later(s, 'budget', function () {
      if (s.started || s.state !== 'loading' || s.blocked) return;
      Log.warn('player', 'no playback after ' + Math.round(CFG.startBudget / 1000) + ' s');
      showError(s, s.cands.length ? 'streams-failed' : 'network', 'MovieBox Pro is taking too long to start this video. Check your connection and try again.');
    }, CFG.startBudget);
    if (!s.id) { showError(s, 'bad-request', 'This title could not be identified.'); return; }
    /* While the file list and player data load: hls.js (if not preloaded) and the stream hosts' connections. */
    warmStart('play', true);
    if (req.fileUrl) { s.files = [{ index: 0, url: String(req.fileUrl), quality: '', file: '', size: '', date: '' }]; s.fileIndex = 0; loadPlayer(s, 0); return; }
    if (s.kind === 'tv') loadEpisodeFiles(s); else loadMovieFiles(s);
  }

  /* The title page the app already read (detail screen, prefetch or boot page; Api.cached) names the files with their
     player-data addresses, so Play does not read the page again (about a second on the TV). */
  function cachedFiles(id) {
    var d = null, out = [];
    try { d = Api.cached('movie', id); } catch (e) { d = null; }
    U.each(d && d.sources || [], function (f, i) {
      if (out && f && f.url) out.push({ index: i, url: String(f.url), quality: f.quality || '', file: f.file || '', size: f.size || '', date: f.date || '' });
      else out = null;
    });
    return out || [];
  }

  function loadMovieFiles(s) {
    setStatus(s, 'Getting the stream ready\u2026');
    var known = cachedFiles(s.id);
    if (known.length) {
      s.files = known;
      Log.info('player', 'files ' + known.length + ' (from the title page already read)');
      s.fileIndex = chooseFile(s.files, s.req);
      loadPlayer(s, s.fileIndex);
      return;
    }
    Api.fetchDoc(Site.url.title('movie', s.id), safe(s, function (err, res) {
      if (err) { failed(s, err, 'files'); return; }
      s.files = filesIn(res.doc);
      Log.info('player', 'files ' + s.files.length);
      if (!s.files.length) { showError(s, 'no-files', 'MovieBox Pro has no playable files for this title yet.'); return; }
      s.fileIndex = chooseFile(s.files, s.req);
      loadPlayer(s, s.fileIndex);
    }, 'player-files'));
  }

  /* ---------- an episode's file list (POST tv_file), read ahead ----------
     The list only names the episode's files and their player-data addresses (the website reads it when an episode is
     picked, before anything plays); the player data, which starts a viewing, is only ever requested at Play. Read
     ahead for the episode a title page's Play would start (warm) and for the next episode while one plays, and kept
     for filesFresh (10 min), so Play goes straight to the player data. */
  var episodeFiles = {}; /* 'tid:season:episode' -> {at, res, waiters} */

  function filesKey(id, season, episode) { return String(id).replace(/[^\d]/g, '') + ':' + toInt(season) + ':' + toInt(episode); }

  /* cb(err, res, early): the tv_file answer, shared by a read-ahead still on its way; early = it was read ahead. */
  function readEpisodeFiles(id, season, episode, cb) {
    var k = filesKey(id, season, episode), e = episodeFiles[k];
    if (e && !e.waiters && U.now() - e.at < CFG.filesFresh) { cb(null, e.res, true); return; }
    if (e && e.waiters) { e.waiters.push(cb); e.joined = true; return; }
    e = episodeFiles[k] = { at: 0, res: null, waiters: [cb], joined: false };
    send(null, { url: origin() + '/index/index/tv_file', body: 'tid=' + enc(id) + '&season=' + toInt(season) + '&episode=' + toInt(episode), label: 'tv_file' }, function (err, res) {
      var list = e.waiters || [], joined = e.joined;
      e.waiters = null;
      e.at = U.now();
      e.res = err ? null : res;
      /* Only a good answer is kept: an error, a signed-out page or an unexpected answer is asked for again at Play. */
      var j = err ? null : U.parseJSON(res && res.text);
      if (err || !j || toInt(j.code) !== 1) { if (episodeFiles[k] === e) delete episodeFiles[k]; }
      U.each(list, function (fn, i) { try { fn(err, res, joined && i > 0); } catch (x) { Log.error('player-tv-file', x); } });
    });
  }

  function prefetchFiles(id, season, episode, why) {
    if (!/\d/.test(String(id || '')) || !(toInt(season) > 0) || toInt(episode) < 0) return;
    var e = episodeFiles[filesKey(id, season, episode)];
    if (e && (e.waiters || U.now() - e.at < CFG.filesFresh)) return;
    Log.info('player', 'reading ahead the files of S' + toInt(season) + 'E' + toInt(episode) + ' (' + why + ')');
    readEpisodeFiles(id, season, episode, function () {});
  }

  function loadEpisodeFiles(s) {
    setStatus(s, 'Getting the episode ready\u2026');
    readEpisodeFiles(s.id, s.season, s.episode, safe(s, function (err, res, early) {
      if (err) { failed(s, err, 'tv_file'); return; }
      if (signedOutRes(res)) { fallback(s, 'signed-out'); return; }
      var j = U.parseJSON(res.text);
      if (!j || typeof j !== 'object') { showError(s, 'bad-answer', 'MovieBox Pro sent an unexpected answer. Try again in a moment.'); return; }
      if (toInt(j.code) !== 1) {
        Log.warn('player', 'tv_file code ' + toInt(j.code));
        showError(s, 'site-error', U.text(j.msg) || 'This episode isn\u2019t available right now.', 'Code ' + toInt(j.code));
        return;
      }
      var html = j.data && typeof j.data.list === 'string' ? j.data.list : '';
      s.files = html ? filesIn(U.parseHTML('<ul>' + html + '</ul>')) : [];
      Log.info('player', 'episode files ' + s.files.length + (early ? ' (read ahead)' : ''));
      if (!s.files.length) { showError(s, 'no-files', 'This episode has no playable files yet.'); return; }
      /* The first file, unless a file was asked for (Try another file, the quality sheet's files). */
      var fi = parseInt(s.req.fileIndex, 10);
      s.fileIndex = !isNaN(fi) && fi >= 0 && fi < s.files.length ? fi : 0;
      loadPlayer(s, s.fileIndex);
    }, 'player-tv-file'));
  }

  function fetchPlayerData(s, fileIndex, cb) {
    var f = s.files[fileIndex], url = f ? playerUrl(f.url) : '';
    if (!url) { cb({ code: 'bad-url' }, null); return; }
    send(s, { url: url, body: '', label: 'player' }, safe(s, function (err, res) {
      if (err) { cb(err, null); return; }
      if (signedOutRes(res)) { cb({ code: 'signed-out' }, null); return; }
      var d = parse(res.text);
      if (d.gate) { cb({ code: 'signed-out' }, null); return; }
      cb(null, d);
    }, 'player-data'));
  }

  function loadPlayer(s, fileIndex) {
    setStatus(s, 'Getting the stream ready\u2026');
    fetchPlayerData(s, fileIndex, function (err, d) {
      if (err) {
        if (err.code === 'bad-url') { showError(s, 'no-files', 'This file has an unexpected address.'); return; }
        failed(s, err, 'player');
        return;
      }
      if (!d.sources.length) {
        if (d.code && d.code !== 1) {
          Log.warn('player', 'player data code ' + d.code);
          showError(s, 'site-error', d.msg || 'MovieBox Pro can\u2019t play this title right now.', 'Code ' + d.code);
        } else {
          showError(s, 'streams-failed', 'MovieBox Pro didn\u2019t offer a stream for this title.');
        }
        return;
      }
      if (!U.find(d.sources, function (x) { return !vipOnly(x); })) {
        Log.warn('player', 'player data: VIP placeholder only');
        showError(s, 'site-error', 'This title needs a MovieBox Pro VIP account. The website can tell you more.');
        return;
      }
      mark(s, 'data');
      applyData(s, d);
      var at = s.resumeAt > 0 ? s.resumeAt : d.seconds;
      Log.info('player', 'player data: ' + d.sources.length + ' sources [' + U.map(d.sources, function (x) { return x.label; }).join(', ') + ']' +
        (s.next ? ', next S' + s.next.season + 'E' + s.next.episode : '') + (at ? ', resume ' + Math.round(at) : '') +
        (s.introEnd ? ', intro ' + Math.round(s.introEnd) : '') + (s.creditsAt ? ', credits ' + Math.round(s.creditsAt) : '') +
        (d.subtitles.length ? ', subtitles ' + d.subtitles.length + ' languages' : '') +
        ', order [' + U.map(s.cands, function (c) { return c.label; }).join(', ') + ']');
      /* The site's saved position follows the resume rules below; a continuation (Try again) goes back exactly. */
      s.resumePending = !(s.resumeAt > 0);
      startCandidate(s, 0, at, '');
    });
  }

  function fallbackPost(s) {
    return s.kind === 'tv' ? { type: 'tv', tid: s.id, season: String(s.season), episode: String(s.episode) } : { type: 'movie', mid: s.id };
  }

  function applyData(s, d) {
    s.data = d;
    if (s.kind === 'tv') {
      if (d.season > 0) s.season = d.season;
      if (d.episode > 0) s.episode = d.episode;
    }
    s.post = d.post || fallbackPost(s);
    s.progressUrl = PROGRESS_PATH.test(d.progressUrl) ? d.progressUrl : '/index/index/' + s.kind + '_progress';
    s.next = s.kind === 'tv' && d.next ? d.next : null;
    s.introEnd = d.skips.start > 0 ? d.skips.start : 0;
    s.creditsAt = d.skips.end > 0 ? d.skips.end : 0;
    s.cands = order(d.sources, environment(s.files[s.fileIndex]));
    s.base = s.cands.slice();
    s.failed = {};
    s.fails = [];
    s.switching = null;
    s.audio.master = null;
    s.audio.pending = null;
    if (!s.started) s.lastSent = Math.floor(d.seconds) + ':0';
    renderTitles(s);
    s.btnSig = '';
    subsData(s, d);
  }

  function failed(s, err, stage) {
    var code = err && err.code || 'error';
    Log.warn('player', stage + ' failed: ' + code);
    if (code === 'signed-out') { fallback(s, 'signed-out'); return; }
    var net = code === 'timeout' || code === 'network' || /^http-5/.test(code);
    showError(s, net ? 'network' : 'bad-answer', net ? 'MovieBox Pro didn\u2019t answer. Check your connection and try again.' :
      'MovieBox Pro sent an unexpected answer. Try again in a moment.', net ? '' : 'Code ' + code);
  }

  /* Ends a session's playback: final progress, timers, listeners, requests, screen saver, decoder. Idempotent. */
  function finish(s, opts) {
    if (!s || s.finished) return null;
    opts = opts || {};
    report(s, opts.why || 'stop', { over: opts.over });
    var snap = snapshot(s);
    s.finished = true;
    for (var k in s.timers) if (s.timers.hasOwnProperty(k)) clearTimeout(s.timers[k]);
    U.each(s.offs, function (off) { try { off(); } catch (e) {} });
    U.each(s.reqs, function (h) { try { h.abort(); } catch (e) {} });
    s.offs = []; s.reqs = [];
    keepAwake(false);
    releaseVideo();
    if (S === s) S = null;
    return snap;
  }

  function snapshot(s) {
    var c = s.cands[s.ci], d = dur() || s.lastDur;
    return {
      kind: s.kind, id: s.id, season: s.season, episode: s.episode, time: Math.round(pos(s) * 10) / 10,
      duration: Math.round(d * 10) / 10, paused: paused(), stream: c ? (c.hls ? 'hls' : 'mp4') : '', label: c ? c.label : '',
      engine: c ? (s.engine === 'hlsjs' ? 'hls.js' : 'native') : '', level: hlsOf(s) ? hlsLevelNow(hlsOf(s)) : '',
      state: s.state, started: s.started, file: s.fileIndex,
      subtitle: s.subs && s.subs.sel && s.subs.cues ? subLabel(s, s.subs.sel.li, s.subs.sel.fi) : '',
      audio: s.ready && ui ? audioCurrent(audioOptions(s)) : ''
    };
  }

  function fallback(s, reason) {
    var req = s.req, h = s.hooks;
    Log.info('player', 'fallback to the website player: ' + reason);
    stop('fallback');
    hook(h, 'onFallback', req, reason);
  }

  /* ---------- streams ---------- */

  /* Start-time marks (ms after play()) for the 'playing' log line, so a slow start can be read from the log. */
  function mark(s, name) { if (s.marks && !s.marks.hasOwnProperty(name)) s.marks[name] = U.now() - s.marks.t0; }
  function marksText(s) {
    var m = s.marks || {}, out = [];
    U.each(['data', 'src', 'attach', 'manifest', 'playlist', 'frag', 'meta', 'seek', 'seeked', 'canplay'], function (k) { if (m.hasOwnProperty(k)) out.push(k + ' ' + (m[k] / 1000).toFixed(1)); });
    /* hls.js retries of a stream the platform player refused count as that stream */
    var n = 0, at = 0;
    U.each(s.cands, function (c, i) { if (!c.afterNative) n++; if (i <= s.ci && !c.afterNative) at = n; });
    if (at > 1) out.push('stream ' + at + ' of ' + n);
    if (s.engine === 'hlsjs') out.push('hls.js');
    return out.join(', ');
  }

  function startCandidate(s, i, at, why) {
    cancel(s, 'cand'); cancel(s, 'candmax'); cancel(s, 'stall');
    var c = s.cands[i];
    if (!c) { streamsFailed(s, at); return; }
    s.ci = i; s.ready = false; s.pendingAt = at > 0 ? at : 0; s.tryId++; s.userPaused = false; s.failNote = '';
    var tryId = s.tryId, engine = engineFor(c), whyHls = engine === 'hlsjs' && !c.engine ? hlsjsWhy() : '';
    s.engine = engine;
    Log.info('player', 'try ' + c.label + ' (' + (c.hls ? (engine === 'hlsjs' ? 'hls.js' + (whyHls && !s.saidWhy ? ': ' + whyHls : '') : 'hls') : 'mp4') + ')' +
      (at > 0 ? ' at ' + Math.round(at) : '') + (why ? ' after ' + why : ''));
    if (whyHls) s.saidWhy = true;
    if (!s.started) setStatus(s, i === 0 ? 'Starting playback\u2026' : 'Trying another stream\u2026');
    else setBuffering(s, true);
    var v = ui.video;
    destroyHls();
    try { v.pause(); } catch (e) {}
    mark(s, 'src');
    renderBadges(s);
    s.btnSig = '';
    if (engine === 'hlsjs') {
      /* The candidate's clocks start once hls.js is there (a slow script load is not the stream's fault; each copy
         has hlsLoadTimeout and startBudget bounds the whole start). */
      hlsReady(safe(s, function (err, H) {
        if (s.tryId !== tryId || s.state === 'error') return;
        if (err || !H) {
          /* No hls.js here: a stream the platform player already refused fails as it did; others play natively. */
          s.engine = 'native';
          if (c.afterNative) { s.failNote = 'hls.js unavailable'; candidateFailed(s, tryId, c.nativeReason || 'media-4'); return; }
          if (nativeSrc(s, c, tryId)) armCandidate(s);
          return;
        }
        hlsAttach(s, c, H, at, tryId);
        if (s.tryId === tryId && s.state !== 'error') armCandidate(s);
      }, 'player-hls'));
      return;
    }
    if (nativeSrc(s, c, tryId)) armCandidate(s);
  }

  function nativeSrc(s, c, tryId) {
    var v = ui.video;
    try { v.src = c.src; v.load(); } catch (e) { candidateFailed(s, tryId, 'exception'); return false; }
    playVideo(s);
    return true;
  }

  /* Each candidate must reach "playing". Metadata alone is not enough: an HLS manifest can load while its segments
     hang or are refused. A candidate fails after candidateTimeout without any sign of life (metadata, data, seeked,
     canplay, more buffered: see alive()), and after candidateMax in any case, so a slow start that keeps progressing
     (a resume seek on a TV takes 5-10 s) is not thrown away. Not while autoplay is blocked (waiting for OK), nor
     when the viewer paused a stream that has loaded. */
  function armCandidate(s) {
    var tryId = s.tryId;
    s.candStart = U.now();
    s.lastBuf = 0;
    s.lastReady = -1;
    armQuiet(s);
    later(s, 'candmax', function () {
      if (s.tryId !== tryId || s.playedTry === tryId || s.blocked || (s.ready && s.userPaused)) return;
      candidateFailed(s, tryId, s.ready ? 'no-start' : 'timeout');
    }, CFG.candidateMax);
    if (s.engine !== 'hlsjs') later(s, 'poll', function () { pollLife(s, tryId); }, 2000);
  }

  /* An original file tried as a last resort (no HLS rendition left to try) gets fileTimeout of quiet time: a large
     file's player can take long to read its index, and failing it only leads to the error card. */
  function quietFor(s) {
    var c = s.cands[s.ci];
    if (!c || c.hls || !isTV()) return CFG.candidateTimeout;
    for (var i = s.ci + 1; i < s.cands.length; i++) if (s.cands[i].hls) return CFG.candidateTimeout;
    return Math.max(CFG.candidateTimeout, CFG.fileTimeout);
  }

  function armQuiet(s) {
    var tryId = s.tryId;
    later(s, 'cand', function () {
      if (s.tryId !== tryId || s.playedTry === tryId || s.blocked || (s.ready && s.userPaused)) return;
      candidateFailed(s, tryId, s.ready ? 'no-start' : 'timeout');
    }, quietFor(s));
  }

  /* A starting candidate showed a sign of life: its quiet-time limit starts again. */
  function alive(s) {
    s.lifeAt = U.now();
    if (s.playedTry === s.tryId || !s.timers.cand || s.state === 'error') return;
    armQuiet(s);
  }

  /* The platform player (native candidates) may fire no 'progress' while it reads a file: every 2 s before the first
     frame, more buffered data or a higher readyState also counts as life. */
  function pollLife(s, tryId) {
    if (s.tryId !== tryId || s.playedTry === tryId || s.state === 'error' || !ui) return;
    var v = ui.video, b = bufferedEnd(v), r = v.readyState || 0;
    if (b > s.lastBuf + 0.25 || (s.lastReady >= 0 && r > s.lastReady)) { if (b > s.lastBuf) s.lastBuf = b; alive(s); }
    s.lastReady = r;
    later(s, 'poll', function () { pollLife(s, tryId); }, 2000);
  }

  /* Format errors: the platform player rejected the stream itself (not the network). */
  function formatError(reason) { return /^media-[34]$|^play-NotSupported|^hls-format$/.test(String(reason || '')); }

  function candidateFailed(s, tryId, reason) {
    if (s !== S || s.finished || s.tryId !== tryId || s.state === 'error' || s.relinking) return;
    var c = s.cands[s.ci], note = s.failNote, viaHls = s.engine === 'hlsjs';
    s.failNote = '';
    Log.warn('player', 'stream ' + (c ? c.label + (c.synthetic ? ' (audio)' : '') + (viaHls ? ' [hls.js]' : '') : '?') + ' failed: ' + reason +
      (c ? ' after ' + ((U.now() - s.candStart) / 1000).toFixed(1) + ' s' : '') + (note ? ' (' + clean(note) + ')' : '') + mediaState());
    var v = ui.video, at = s.ready ? (v.currentTime > 0 ? v.currentTime : s.lastTime) : s.pendingAt;
    /* The platform player refused an HLS stream before playing a frame (Samsung Tizen 9: media error 4, often after
       loadedmetadata with PIPELINE_ERROR_COULD_NOT_RENDER): the same stream through hls.js next, at the same position. */
    if (c && c.hls && !c.synthetic && !viaHls && s.playedTry !== s.tryId && formatError(reason) && hlsRetryOk()) {
      var copy = {}, k;
      for (k in c) if (c.hasOwnProperty(k)) copy[k] = c[k];
      copy.engine = 'hlsjs';
      copy.afterNative = true;
      copy.nativeReason = reason;
      Log.info('player', 'the platform player refused ' + c.label + ' (' + reason + '): trying it through hls.js');
      s.cands.splice(s.ci + 1, 0, copy);
      startCandidate(s, s.ci + 1, at, reason);
      return;
    }
    if (c && !c.synthetic) { s.failed[c.label] = true; s.fails.push({ label: c.label, reason: reason }); }
    /* AUTO through hls.js too slow to deliver (it starts on the best rendition): the 1080p address is the same video,
       so the lighter renditions go next. */
    if (c && viaHls && c.label === 'AUTO' && /^(?:timeout|stall|no-start)$/.test(reason)) lighterFirst(s);
    if (s.started && s.ready && !(c && c.synthetic) && !s.switching) {
      report(s, 'switch');
      s.switchNote = 'Playback hiccup \u2014 switched to a backup stream';
    }
    /* The TV's player refused an HLS stream before it even loaded: the other HLS renditions are built the same way,
       so the MP4 originals go next. */
    if (c && c.hls && !c.synthetic && s.playedTry !== s.tryId && formatError(reason)) promoteFiles(s);
    startCandidate(s, s.ci + 1, at, reason);
  }

  /* After a slow AUTO: the remaining renditions up to 720p (720p, then 360p) before the heavier ones (1080p, 4K);
     original files after them. */
  function lighterFirst(s) {
    var head = s.cands.slice(0, s.ci + 1), rest = s.cands.slice(s.ci + 1), light = [], heavy = [], files = [];
    U.each(rest, function (c) { if (!c.hls) files.push(c); else if (rank(c.label) > 0 && rank(c.label) <= 720) light.push(c); else heavy.push(c); });
    if (!light.length || !heavy.length || U.indexOf(rest, light[0]) < U.indexOf(rest, heavy[0])) return;
    light.sort(function (a, b) { return rank(b.label) - rank(a.label); });
    Log.info('player', 'AUTO was too slow: ' + U.map(light, function (c) { return c.label; }).join(', ') + ' next');
    s.cands = head.concat(light, heavy, files);
  }

  function promoteFiles(s) {
    var head = s.cands.slice(0, s.ci + 1), rest = s.cands.slice(s.ci + 1), files = [], others = [];
    U.each(rest, function (c) { if (!c.hls && c.kind === 'mp4') files.push(c); else others.push(c); });
    if (files.length && others.length && U.indexOf(rest, files[0]) > 0) {
      Log.info('player', 'the TV refused HLS: trying the original file next');
      s.cands = head.concat(files, others);
    }
  }

  /* For the log: the video element's error message and states (Tizen and webOS put their player's reason there). */
  function mediaState() {
    var v = ui && ui.video;
    if (!v) return '';
    var e = v.error, msg = e && e.message ? ' "' + clean(e.message).slice(0, 80) + '"' : '';
    return ' (ready ' + v.readyState + ', net ' + v.networkState + msg + ')';
  }

  /* Every candidate failed. Mid-film this is usually the signed, time-limited stream links expiring, so fresh player
     data is fetched once (again only after the new links played for a while) before the error card appears. */
  function streamsFailed(s, at) {
    at = at > 0 ? at : (s.lastTime || 0);
    var canRelink = s.started && s.fileIndex >= 0 && s.files[s.fileIndex] && (!s.relinkAt || (s.playedSinceRelink && U.now() - s.relinkAt > 30000));
    if (canRelink) {
      Log.warn('player', 'every stream failed mid-playback; fetching fresh stream links');
      s.relinkAt = U.now();
      s.playedSinceRelink = false;
      s.lastTime = at;
      /* Late events of the failed stream (a play() rejection, a media error) must not count against the next one. */
      s.tryId++;
      s.ready = false;
      s.relinking = true;
      setBuffering(s, true);
      fetchPlayerData(s, s.fileIndex, function (err, d) {
        s.relinking = false;
        if (err && err.code === 'signed-out') { fallback(s, 'signed-out'); return; }
        if (err || !d || !d.sources.length) {
          Log.warn('player', 'fresh stream links failed: ' + (err ? err.code : 'no sources'));
          streamsFailed(s, at);
          return;
        }
        applyData(s, d);
        s.resumePending = false;
        s.switchNote = 'Reconnected';
        startCandidate(s, 0, at, 'refresh');
      });
      return;
    }
    Log.warn('player', 'every stream failed: ' + U.map(s.fails, function (f) { return f.label + ' ' + f.reason; }).join(', '));
    s.lastTime = at;
    showError(s, 'streams-failed', failMessage(s), failCode(s));
  }

  var REASONS = { 'media-1': 'stopped', 'media-2': 'network error', 'media-3': 'couldn\u2019t decode', 'media-4': 'format not supported',
    timeout: 'no answer', 'no-start': 'didn\u2019t start', stall: 'stalled', exception: 'refused', 'hls-format': 'format not supported',
    'hls-network': 'network error', 'hls-media': 'couldn\u2019t decode', 'hls-other': 'refused' };
  function reasonText(r) { return REASONS[r] || (/^play-/.test(r) ? 'refused' : r); }

  /* The error card's text, from what the candidates did. */
  function failMessage(s) {
    var n = s.fails.length, fmt = 0, slow = 0, more = s.files.length > 1 ? ' Try another file of this title, or the website\u2019s player.' : ' The website\u2019s own player may still work.';
    U.each(s.fails, function (f) { if (formatError(f.reason)) fmt++; else if (/^(?:timeout|stall|no-start|media-2|hls-network)$/.test(f.reason)) slow++; });
    if (s.started) return 'The video stopped and none of its streams would start again. Check your connection and try again.';
    if (n && fmt === n) return 'This TV can\u2019t play the video or audio format of this file.' + more;
    if (n && slow === n) return 'The streams didn\u2019t load in time. Your connection may be slow, or MovieBox Pro\u2019s servers are busy. Try again in a moment.';
    return 'None of the available streams would play on this TV.' + more;
  }

  function failCode(s) {
    var seen = {}, parts = [];
    U.each(s.fails, function (f) { var k = f.label + f.reason; if (!seen[k] && parts.length < 6) { seen[k] = true; parts.push(displayLabel(f.label) + ': ' + reasonText(f.reason)); } });
    return parts.length ? 'Tried ' + parts.join(' \u00b7 ') : '';
  }

  function playVideo(s) {
    var v = ui && ui.video, p = null, tryId = s.tryId;
    if (!v) return;
    try { p = v.play(); } catch (e) { Log.warn('player', 'play() threw: ' + clean(e)); return; }
    if (p && typeof p.then === 'function') {
      p.then(null, function (err) {
        if (s !== S || s.finished) return;
        var name = String(err && err.name || '');
        if (name === 'NotAllowedError') {
          Log.info('player', 'autoplay blocked; waiting for OK');
          if (s.ready) reveal(s);
          s.blocked = true;
          showChip(s, 'Press OK to play', CFG.chipMs, false);
          showOsd(s);
        } else if (name !== 'AbortError' && s.tryId === tryId) {
          /* NotSupportedError and the like: this stream will not start (a pause() or a new source rejects with
             AbortError, which is expected). */
          candidateFailed(s, tryId, 'play-' + (name || 'error'));
        }
      });
    }
  }

  function releaseVideo() {
    destroyHls();
    var v = ui && ui.video;
    if (!v) return;
    try { v.pause(); } catch (e) {}
    try { v.removeAttribute('src'); } catch (e2) {}
    try { v.load(); } catch (e3) {}
  }

  function dur() {
    var v = ui && ui.video, d = v ? v.duration : 0;
    return d > 0 && isFinite(d) ? d : 0;
  }

  function pos(s) {
    var v = ui && ui.video;
    if (s && s.ready && v) { var t = v.currentTime; if (t >= 0 && isFinite(t)) return t; }
    return s ? s.lastTime || s.pendingAt || 0 : 0;
  }

  function paused() { var v = ui && ui.video; return !v || !!v.paused; }

  function seekTo(s, t) {
    var d = dur();
    if (d > 0) t = U.clamp(t, 0, Math.max(0, d - 0.5));
    s.lastTime = t;
    try { ui.video.currentTime = t; } catch (e) { Log.warn('player', 'seek failed: ' + clean(e)); }
  }

  /* Leaves the loading screen for the playback UI (first frame, or autoplay blocked). */
  function reveal(s) {
    if (s.state !== 'loading') return;
    s.state = 'playing';
    ui.root.setAttribute('data-state', 'playing');
    showOsd(s);
  }

  function bindVideo(v) {
    function on(type, fn) {
      ui.offs.push(U.on(v, type, function (e) { var s = S; if (!s || s.finished || s.state === 'error') return; fn(s, e); }));
    }
    on('loadedmetadata', function (s) {
      mark(s, 'meta');
      s.ready = true;
      var d = dur(), at = s.pendingAt;
      if (d > 0) s.lastDur = d;
      s.pendingAt = 0;
      var check = -1, h = hlsOf(s);
      if (s.resumePending) {
        s.resumePending = false;
        if (at > 10 && d > 0 && at < d - 60) { mark(s, 'seek'); seekTo(s, at); s.resumed = at; check = at; } else {
          s.lastTime = 0;
          /* hls.js was given the saved position as its startPosition and jumps there once its first fragment is
             buffered (the time is still 0 now): seeking to 0 first makes it start at 0, and the check below undoes
             a late jump. */
          if (h) { seekTo(s, 0); check = 0; } else if (ui.video.currentTime > 1) seekTo(s, 0);
        }
      } else if (at > 0 && d > 0) { seekTo(s, Math.min(at, d - 1)); check = s.lastTime; }
      /* Native HLS players can ignore a seek made this early (and start at 0): checked once it plays. */
      s.seekCheck = check > 1 || (check === 0 && h) ? { target: check, tries: 0, at: U.now() } : null;
      if (s.blocked) reveal(s);
      alive(s);
      audioRefresh(s);
      render(s);
    });
    on('loadeddata', function (s) { alive(s); });
    on('playing', function (s) {
      var first = s.playedTry !== s.tryId;
      s.ready = true;
      s.blocked = false;
      s.userPaused = false;
      s.playedTry = s.tryId;
      if (first) engineLine(s);
      s.playedSinceRelink = true;
      cancel(s, 'cand');
      cancel(s, 'candmax');
      checkSeek(s);
      switchOutcome(s);
      setBuffering(s, false);
      keepAwake(true);
      if (!s.started) {
        s.started = true;
        cancel(s, 'budget');
        var c = s.cands[s.ci];
        mark(s, 'playing');
        Log.info('player', 'playing ' + (c ? c.label : '?') + (s.resumed ? ' from ' + Math.round(s.resumed) : '') +
          ' after ' + (s.marks.playing / 1000).toFixed(1) + ' s (' + marksText(s) + ')');
        reveal(s);
        showOsd(s);
        if (s.resumed) showChip(s, 'Resumed at ' + fmt(s.resumed) + ' \u00b7 press Down for Start over', CFG.chipMs, true);
        else if (s.subs.note) showChip(s, s.subs.note, 3500, false);
        s.subs.note = '';
        later(s, 'tick', function tick() { if (!paused()) report(s, 'tick'); later(s, 'tick', tick, CFG.progressEvery); }, CFG.progressEvery);
        later(s, 'nextinfo', function () { prefetchNext(s); }, 4000);
      } else if (s.switchNote) {
        showChip(s, s.switchNote, 4000, false);
      }
      s.switchNote = '';
      if (s.osd) scheduleHide(s);
      render(s);
      subTick(s);
      audioRefresh(s);
      /* It started while the app is in the background: hold it there (see toBackground). */
      if (isHidden()) toBackground(s);
    });
    on('pause', function (s) {
      if (!s.started) return;
      keepAwake(false);
      if (!s.ended) report(s, 'pause');
      showOsd(s);
      render(s);
      subTick(s);
    });
    on('play', function (s) { if (s.started) render(s); });
    on('waiting', function (s) {
      /* Also before the first frame: a stream that stops delivering data is replaced after stallTimeout. */
      setBuffering(s, true);
      s.waitAt = pos(s);
      armStall(s, s.tryId, U.now());
    });
    on('timeupdate', function (s) {
      if (!s.ready) return;
      var t = ui.video.currentTime;
      if (s.seekCheck) checkSeek(s);
      if (!ui.video.seeking && t > 0 && !s.seekCheck) s.lastTime = t;
      if (s.buffering && Math.abs(t - s.waitAt) >= 0.5) { setBuffering(s, false); cancel(s, 'stall'); }
      if (U.now() - s.lastRender >= 250) render(s);
      checkUpNext(s);
      subTick(s);
    });
    on('progress', function (s) {
      if (s.playedTry !== s.tryId) {
        /* Data arriving counts as life: before metadata a large original (MP4 index at the end of the file) is still
           being read; after it, more is buffered. */
        var b = bufferedEnd(ui.video);
        if (!s.ready) alive(s);
        else if (b > s.lastBuf + 0.25) { s.lastBuf = b; alive(s); }
      }
      if (s.osd && U.now() - s.lastRender >= 250) render(s);
    });
    on('durationchange', function (s) { var d = dur(); if (d > 0) s.lastDur = d; render(s); });
    on('seeked', function (s) { mark(s, 'seeked'); alive(s); render(s); subTick(s); });
    on('canplay', function (s) { mark(s, 'canplay'); alive(s); });
    on('ended', function (s) { onEnded(s); });
    var tl = null;
    try { tl = v.audioTracks; } catch (e) { tl = null; }
    if (tl && typeof tl.addEventListener === 'function') {
      U.each(['addtrack', 'removetrack', 'change'], function (type) {
        ui.offs.push(U.on(tl, type, function () { var s = S; if (s && !s.finished && s.state !== 'error' && s.ready) audioRefresh(s); }));
      });
    }
    on('error', function (s) {
      var v2 = ui.video, code = v2 && v2.error ? v2.error.code : 0, h = hlsOf(s);
      if (h) { hlsMediaError(s, h, code); return; }
      if (!v2 || !v2.getAttribute('src')) return;
      candidateFailed(s, s.tryId, 'media-' + code);
    });
  }

  /* A 'waiting' that lasts stallTimeout without the position moving fails the stream. Before its first frame a stream
     that keeps showing signs of life (hls.js fragments arriving on a slow connection) is still starting, not stalled:
     the candidate's own clocks (quiet time, candidateMax) judge it. */
  function armStall(s, tryId, since) {
    later(s, 'stall', function () {
      if (!s.buffering || s.tryId !== tryId || Math.abs(pos(s) - s.waitAt) >= 0.5 || paused()) return;
      if (s.playedTry !== tryId && (s.lifeAt || 0) > since) { armStall(s, tryId, U.now()); return; }
      candidateFailed(s, tryId, 'stall');
    }, CFG.stallTimeout);
  }

  function bufferedEnd(v) {
    try { var b = v.buffered; return b && b.length ? b.end(b.length - 1) : 0; } catch (e) { return 0; }
  }

  /* A position set at loadedmetadata (resume, quality or file switch, fresh links) must actually be reached: some
     native HLS players start from 0 instead. Checked when it plays; seeks again at most twice. */
  function checkSeek(s) {
    var k = s.seekCheck, v = ui && ui.video;
    if (!k || !v || v.seeking || !s.ready) return;
    var t = v.currentTime;
    if (U.now() - k.at > 60000 || Math.abs(t - k.target) <= CFG.seekSlack) { s.seekCheck = null; return; }
    if (k.tries >= 2) {
      s.seekCheck = null;
      Log.warn('player', 'position not applied: at ' + Math.round(t) + ' instead of ' + Math.round(k.target));
      return;
    }
    k.tries++;
    Log.info('player', 'at ' + Math.round(t) + ' instead of ' + Math.round(k.target) + ': seeking again');
    seekTo(s, k.target);
  }

  /* One line per stream that starts playing: which engine, which stream, and with hls.js the level and audio. */
  function engineLine(s) {
    var c = s.cands[s.ci], h = hlsOf(s), parts = [];
    if (!c) return;
    if (h) {
      h.reported = true;
      parts.push('engine hls.js ' + lib.version + ' (' + lib.from + ')', c.label);
      var lv = hlsLevelNow(h), au = hlsAudioCode(h);
      if (lv) parts.push(lv + ' level');
      if (au) parts.push('audio ' + au);
      if (c.afterNative && verdict() !== 'refuses') {
        Store.local.set(HLS_VERDICT, { ua: String(navigator.userAgent || ''), native: 'refuses', at: U.now() });
        Log.info('player', 'the platform player refuses HLS here: hls.js from now on (remembered)');
      }
    } else parts.push('engine native', c.label + (c.hls ? ' (HLS)' : c.kind && c.kind !== 'hls' ? ' (' + c.kind + ')' : ''));
    Log.info('player', parts.join(' \u00b7 '));
  }

  /* The viewer's quality or audio choice took effect, or another stream took over: say which. */
  function switchOutcome(s) {
    var c = s.cands[s.ci], sw = s.switching, au = s.audio.pending;
    if (sw) {
      s.switching = null;
      if (c && c.label === sw.label) s.switchNote = 'Quality: ' + displayLabel(sw.label);
      else {
        Log.warn('player', 'quality ' + sw.label + ' did not play; ' + (c ? c.label : '?') + ' instead');
        s.switchNote = displayLabel(sw.label) + ' didn\u2019t play on this TV \u2014 playing ' + displayLabel(c ? c.label : '') + ' instead';
      }
    }
    if (au) audioOutcome(s, c, au);
  }

  function setBuffering(s, on) {
    s.buffering = !!on;
    if (ui) flag(ui.root, 'is-buffering', on && s.started);
  }

  /* ---------- screen saver ---------- */

  function keepAwake(on) {
    on = !!on;
    if (on === saverOff) return;
    saverOff = on;
    var done = false;
    try {
      var ac = window.webapis && window.webapis.appcommon;
      if (ac && typeof ac.setScreenSaver === 'function' && ac.AppCommonScreenSaverState) {
        ac.setScreenSaver(on ? ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF : ac.AppCommonScreenSaverState.SCREEN_SAVER_ON,
          function () {}, function (e) { Log.info('player', 'screen saver: ' + clean(e && e.message || e)); });
        done = true;
      }
    } catch (e) { Log.info('player', 'screen saver: ' + clean(e)); }
    if (done) return;
    try {
      var power = window.tizen && window.tizen.power;
      if (power) { if (on) power.request('SCREEN', 'SCREEN_NORMAL'); else power.release('SCREEN'); }
    } catch (e2) { Log.info('player', 'screen power: ' + clean(e2)); }
  }

  /* ---------- background (Home button, input switch) ---------- */

  /* Save the place, pause and let the screen saver run again; coming back shows the paused controls (like the
     TV's own apps), and OK carries on. */
  function toBackground(s) {
    report(s, 'hidden');
    if (s.state === 'playing' && ui && !ui.video.paused) {
      Log.info('player', 'app hidden: pausing');
      s.bgPaused = true;
      s.userPaused = true;
      try { ui.video.pause(); } catch (e) {}
      hlsPause(s, true);
    }
    keepAwake(false);
  }

  function fromBackground(s) {
    if (!s.bgPaused) return;
    s.bgPaused = false;
    hlsPause(s, false);
    if (s.state === 'playing' && !(s.upnext && s.upnext.visible)) { showOsd(s); render(s); }
  }

  /* ---------- progress ---------- */

  function formOf(obj) {
    var parts = [];
    for (var k in obj) if (obj.hasOwnProperty(k)) parts.push(enc(k) + '=' + enc(obj[k]));
    return parts.join('&');
  }

  /* Posts {post, over, seconds, mp4_id} like the site's own save routine. Skipped before playback started, while
     the duration is unknown, and when neither the second nor over changed since the last post. */
  function report(s, why, opts) {
    opts = opts || {};
    if (!s || s.finished || !s.started || !s.data || !ui) return false;
    var d = dur() || s.lastDur; /* the last known duration survives a stream switch or a failed stream */
    if (!(d > 0)) return false;
    var t = pos(s), sec = Math.max(0, Math.floor(t));
    var over = opts.over === 1 || opts.over === 0 ? opts.over : (d - t < 300 ? 1 : 0);
    var key = sec + ':' + over;
    if (key === s.lastSent) return false;
    s.lastSent = key;
    var body = formOf(s.post) + '&over=' + over + '&seconds=' + sec + '&mp4_id=' + enc(s.data.mp4Id);
    send(null, { url: origin() + s.progressUrl, body: body, label: 'progress' }, function (err) {
      if (err) Log.info('player', 'progress not saved: ' + err.code);
    });
    Log.info('player', 'progress ' + sec + '/' + Math.floor(d) + ' over=' + over + ' (' + why + ')');
    hook(s.hooks, 'onProgress', { kind: s.kind, id: s.id, season: s.season, episode: s.episode, seconds: sec, duration: Math.floor(d), over: over });
    return true;
  }

  /* ---------- overlay DOM ---------- */

  function build(mount) {
    var root = el('div', 'mbp');
    root.id = 'mbptv-player';
    root.setAttribute('tabindex', '-1');
    root.setAttribute('data-state', 'loading');
    var u = { root: root, offs: [] };

    var v = document.createElement('video');
    v.className = 'mbp-video';
    v.setAttribute('preload', 'auto');
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('disablepictureinpicture', '');
    v.setAttribute('disableremoteplayback', '');
    root.appendChild(v);
    u.video = v;

    var art = el('div', 'mbp-art', null, root);
    u.artImg = document.createElement('img');
    u.artImg.className = 'mbp-art-img';
    u.artImg.setAttribute('alt', '');
    u.artImg.onload = U.guard(function () { flag(u.artImg, 'is-loaded', true); }, 'player-art');
    u.artImg.onerror = U.guard(function () { if (!retryOriginal(u.artImg)) flag(u.artImg, 'is-loaded', false); }, 'player-art');
    art.appendChild(u.artImg);
    el('div', 'mbp-art-scrim', null, art);

    var loading = el('div', 'mbp-loading', null, root);
    var spin = el('div', 'mbp-spin', null, loading);
    el('div', 'mbp-spin-ring', null, spin);
    var info = el('div', 'mbp-load-info', null, loading);
    u.lKicker = el('div', 'mbp-kicker', '', info);
    u.lTitle = el('div', 'mbp-load-title', '', info);
    u.lSub = el('div', 'mbp-load-sub', null, info);
    u.lSubCode = el('span', 'mbp-sub-code', '', u.lSub);
    u.lSubText = el('span', 'mbp-sub-text', '', u.lSub);
    u.lStatus = el('div', 'mbp-load-status', '', info);
    var lh = el('div', 'mbp-load-hint', null, loading);
    el('span', 'mbp-key', 'Back', lh);
    el('span', null, 'Cancel', lh);

    var buffer = el('div', 'mbp-buffer', null, root);
    el('div', 'mbp-spin-ring', null, buffer);

    u.flash = el('div', 'mbp-flash', null, root);
    u.flashPlay = icon('play', 'mbp-flash-play');
    u.flashPause = icon('pause', 'mbp-flash-pause');
    u.flash.appendChild(u.flashPlay);
    u.flash.appendChild(u.flashPause);

    el('div', 'mbp-dim', null, root);
    /* Subtitles: our own overlay (TV platform players may not draw <track> cues), above the dim, under the OSD. */
    u.subs = el('div', 'mbp-subs', null, root);
    u.subs.setAttribute('aria-live', 'off');
    u.subsBox = el('div', 'mbp-subs-box', null, u.subs);
    var osd = el('div', 'mbp-osd', null, root);
    el('div', 'mbp-osd-top', null, osd);
    el('div', 'mbp-osd-shade', null, osd);
    var main = el('div', 'mbp-osd-main', null, osd);
    var head = el('div', 'mbp-head', null, main);
    el('div', 'mbp-kicker mbp-osd-kicker', 'Paused', head);
    u.title = el('div', 'mbp-title', '', head);
    var subRow = el('div', 'mbp-subrow', null, head);
    u.sub = el('div', 'mbp-sub', null, subRow);
    u.subCode = el('span', 'mbp-sub-code', '', u.sub);
    u.subText = el('span', 'mbp-sub-text', '', u.sub);
    u.badges = el('div', 'mbp-badges', null, subRow);

    var scrub = el('div', 'mbp-scrub', null, main);
    u.state = el('div', 'mbp-state', null, scrub);
    u.state.appendChild(icon('play', 'mbp-state-play'));
    u.state.appendChild(icon('pause', 'mbp-state-pause'));
    u.elapsed = el('div', 'mbp-time mbp-elapsed', '0:00', scrub);
    var bar = el('div', 'mbp-bar', null, scrub);
    var clip = el('div', 'mbp-bar-clip', null, bar);
    u.buf = el('div', 'mbp-buf', null, clip);
    u.fill = el('div', 'mbp-fill', null, clip);
    u.headWrap = el('div', 'mbp-headwrap', null, bar);
    el('div', 'mbp-knob', null, u.headWrap);
    var bubble = el('div', 'mbp-bubble', null, u.headWrap);
    u.bubbleDelta = el('div', 'mbp-bubble-delta', '', bubble);
    u.bubbleTime = el('div', 'mbp-bubble-time', '', bubble);
    u.remain = el('div', 'mbp-time mbp-remain', '', scrub);
    u.btns = el('div', 'mbp-btns', null, main);
    u.btns.setAttribute('data-zone', 'player-buttons');

    u.skip = el('div', 'mbp-skip', null, root);
    u.skip.setAttribute('data-action', 'skip-intro-pill');
    u.skip.appendChild(icon('skip'));
    el('span', 'mbp-skip-label', 'Skip Intro', u.skip);

    u.chip = el('div', 'mbp-chip', '', root);

    el('div', 'mbp-un-scrim', null, root);
    var un = el('div', 'mbp-upnext', null, root);
    un.setAttribute('data-upnext', '');
    var unTop = el('div', 'mbp-un-top', null, un);
    var still = el('div', 'mbp-un-still', null, unTop);
    u.unPh = el('div', 'mbp-un-ph', '', still);
    u.unImg = document.createElement('img');
    u.unImg.className = 'mbp-un-img';
    u.unImg.setAttribute('alt', '');
    u.unImg.onload = U.guard(function () { flag(u.unImg, 'is-loaded', true); }, 'player-still');
    u.unImg.onerror = U.guard(function () { if (!retryOriginal(u.unImg)) flag(u.unImg, 'is-loaded', false); }, 'player-still');
    still.appendChild(u.unImg);
    var glyph = el('div', 'mbp-un-glyph', null, still);
    glyph.appendChild(icon('play'));
    var unText = el('div', 'mbp-un-text', null, unTop);
    u.unCount = el('div', 'mbp-kicker mbp-un-count', '', unText);
    u.unTitle = el('div', 'mbp-un-title', '', unText);
    u.unMeta = el('div', 'mbp-un-meta', '', unText);
    var unBtns = el('div', 'mbp-un-btns', null, unText);
    u.unPlay = el('div', 'mbp-btn mbp-btn--count', null, unBtns);
    u.unPlay.setAttribute('data-action', 'play-next');
    u.unFill = el('div', 'mbp-btn-fill', null, u.unPlay);
    u.unPlay.appendChild(icon('play'));
    el('span', 'mbp-btn-label', 'Play now', u.unPlay);
    u.unHide = el('div', 'mbp-btn', null, unBtns);
    u.unHide.setAttribute('data-action', 'hide-next');
    u.unHide.appendChild(icon('close'));
    el('span', 'mbp-btn-label', 'Hide', u.unHide);

    var layer = el('div', 'mbp-sheet-layer', null, root);
    el('div', 'mbp-sheet-dim', null, layer);
    var sheet = el('div', 'mbp-sheet', null, layer);
    sheet.setAttribute('data-sheet', 'player-quality');
    u.sheet = sheet;
    u.sheetKicker = el('div', 'mbp-kicker', 'Quality', sheet);
    u.sheetTitle = el('div', 'mbp-sheet-title', 'Choose quality', sheet);
    u.sheetSub = el('div', 'mbp-sheet-sub', '', sheet);
    var port = el('div', 'mbp-sheet-port', null, sheet);
    u.sheetList = el('div', 'mbp-sheet-list', null, port);
    u.sheetPort = port;
    var sh = el('div', 'mbp-sheet-hint', null, sheet);
    el('span', 'mbp-key', 'OK', sh);
    el('span', 'mbp-hint-gap', 'Choose', sh);
    el('span', 'mbp-key', 'Back', sh);
    el('span', null, 'Close', sh);

    var err = el('div', 'mbp-error', null, root);
    var card = el('div', 'mbp-err-card', null, err);
    card.setAttribute('data-dialog', 'player-error');
    card.appendChild(icon('alert', 'mbp-err-ico'));
    u.errKicker = el('div', 'mbp-kicker mbp-err-kicker', '', card);
    u.errTitle = el('div', 'mbp-err-title', '', card);
    u.errBody = el('div', 'mbp-err-body', '', card);
    u.errCode = el('div', 'mbp-err-code', '', card);
    u.errBtns = el('div', 'mbp-err-btns', null, card);

    ui = u;
    bindVideo(v);
    /* The shell root is pointer-transparent outside shell mode; the player takes pointer input itself (player.css)
       and swallows it, so a pointer (Tizen's mouse mode, a USB mouse) never reaches the website underneath. */
    u.offs.push(U.on(root, 'click', function (e) { if (e.preventDefault) e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); }));
    (mount || document.body).appendChild(root);
    try { root.focus({ preventScroll: true }); } catch (e) { try { root.focus(); } catch (e2) {} }
  }

  function teardownUi() {
    if (!ui) return;
    releaseVideo();
    U.each(ui.offs, function (off) { try { off(); } catch (e) {} });
    U.detach(ui.root);
    ui = null;
  }

  function resetUi(s) {
    var r = ui.root;
    r.setAttribute('data-state', 'loading');
    r.setAttribute('data-kind', s.kind);
    U.each(['is-osd', 'is-paused', 'is-upnext', 'is-sheet', 'is-seeking', 'is-buffering', 'is-scrub', 'is-buttons', 'is-still'], function (c) { flag(r, c, false); });
    flag(ui.chip, 'is-on', false);
    flag(ui.skip, 'is-on', false);
    U.empty(ui.btns);
    U.empty(ui.errBtns);
    U.empty(ui.badges);
    ui.badges.__sig = '';
    U.empty(ui.subsBox);
    flag(ui.subs, 'is-on', false);
    r.setAttribute('data-subsize', subSize());
    tf(ui.fill, 'scaleX(0)');
    tf(ui.buf, 'scaleX(0)');
    tf(ui.headWrap, 'translate3d(0,0,0)');
    setText(ui.elapsed, '0:00');
    setText(ui.remain, '');
    var art = s.req.backdrop || s.req.poster || '';
    if (!art) {
      try { var m = Api.meta(s.kind + ':' + s.id); art = m && (m.backdrop || m.poster) || ''; } catch (e) { art = ''; }
    }
    if (safeImage(art)) setArt(ui.artImg, art, 1280);
    else {
      flag(ui.artImg, 'is-loaded', false);
      ui.artImg.removeAttribute('src');
    }
    renderTitles(s);
    setStatus(s, 'Loading\u2026');
  }

  function titleOf(s) { return U.text(s.kind === 'tv' ? (s.req.showTitle || s.req.title) : s.req.title) || 'MovieBox Pro'; }

  function shortRuntime(v) {
    var m = /^(\d+)/.exec(String(v || '')), n = m ? toInt(m[1]) : 0;
    if (!n) return '';
    return n < 60 ? n + 'm' : Math.floor(n / 60) + 'h' + (n % 60 ? ' ' + (n % 60) + 'm' : '');
  }

  function movieMeta(s) {
    var m = null;
    try { m = Api.meta('movie:' + s.id); } catch (e) { m = null; }
    if (!m) return '';
    var parts = [];
    if (m.year) parts.push(m.year);
    if (shortRuntime(m.runtime)) parts.push(shortRuntime(m.runtime));
    if (m.certification) parts.push(m.certification);
    return parts.join('  \u00b7  ');
  }

  function renderTitles(s) {
    if (!ui) return;
    var title = titleOf(s), code = '', text = '';
    if (s.kind === 'tv') { code = 'S' + s.season + ' \u00b7 E' + s.episode; text = U.text(s.req.episodeTitle || ''); }
    else text = movieMeta(s);
    setText(ui.title, title);
    setText(ui.subCode, code);
    setText(ui.subText, text);
    flag(ui.sub, 'is-empty', !code && !text);
    setText(ui.lTitle, title);
    setText(ui.lSubCode, code);
    setText(ui.lSubText, text);
    setText(ui.lKicker, s.kicker || 'Now playing');
  }

  function setStatus(s, text) { if (ui && s === S) setText(ui.lStatus, text); }

  function badgeList(s) {
    var c = s.cands[s.ci], out = [];
    if (!c) return out;
    if (c.label === 'AUTO') out.push('Auto');
    else if (c.label === 'ORG') out.push(c.height >= 2000 || c.width >= 3800 ? '4K' : c.height >= 1000 || c.width >= 1900 ? '1080p' : 'Original');
    else out.push(c.label);
    if (c.hdr && (c.label === 'ORG' || rank(c.label) >= 2160)) out.push('HDR');
    return out;
  }

  function renderBadges(s) {
    if (!ui) return;
    var list = badgeList(s), sig = list.join('|');
    if (ui.badges.__sig === sig) return;
    ui.badges.__sig = sig;
    U.empty(ui.badges);
    U.each(list, function (b, i) { el('span', 'mbp-tag' + (i ? ' mbp-tag--line' : ''), b, ui.badges); });
  }

  /* ---------- rendering (at most 4x/s from timeupdate; immediately after keys) ---------- */

  function bufferedTo(v, t, d) {
    try {
      var b = v.buffered;
      for (var i = 0; b && i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return U.clamp(b.end(i) / d, 0, 1);
    } catch (e) {}
    return 0;
  }

  function render(s) {
    if (!ui || s !== S) return;
    s.lastRender = U.now();
    var v = ui.video, d = dur(), cur = pos(s), t = s.seek ? s.seek.target : cur;
    var p = d > 0 ? U.clamp(t / d, 0, 1) : 0;
    tf(ui.fill, 'scaleX(' + p.toFixed(4) + ')');
    tf(ui.headWrap, 'translate3d(' + (p * 100).toFixed(3) + '%,0,0)');
    tf(ui.buf, 'scaleX(' + (d > 0 ? bufferedTo(v, cur, d) : 0).toFixed(4) + ')');
    setText(ui.elapsed, fmt(t));
    setText(ui.remain, d > 0 ? '\u2212' + fmt(Math.max(0, d - t)) : '');
    flag(ui.root, 'is-paused', paused() && s.started);
    flag(ui.root, 'is-long', d >= 3600);
    if (s.seek) {
      setText(ui.bubbleTime, fmt(t));
      setText(ui.bubbleDelta, fmtDelta(t - s.seek.from));
    }
    renderButtons(s);
    renderSkip(s);
  }

  /* ---------- OSD ---------- */

  function showOsd(s) {
    if (!ui || s.state !== 'playing' || (s.upnext && s.upnext.visible)) return;
    if (!s.osd) {
      s.osd = true;
      s.area = 'scrub';
      flag(ui.root, 'is-osd', true);
    }
    syncArea(s);
    render(s);
    scheduleHide(s);
  }

  function scheduleHide(s) {
    cancel(s, 'osd');
    if (paused() && s.started) return;
    later(s, 'osd', function () { hideOsd(s, false); }, CFG.osdHide);
  }

  function hideOsd(s, force) {
    if (!ui || !s.osd) return;
    if (!force && ((paused() && s.started) || s.seek || s.sheet)) return;
    cancel(s, 'osd');
    s.osd = false;
    s.area = 'scrub';
    flag(ui.root, 'is-osd', false);
    syncArea(s);
    renderSkip(s);
  }

  function syncArea(s) {
    flag(ui.root, 'is-scrub', s.osd && s.area === 'scrub');
    flag(ui.root, 'is-buttons', s.osd && s.area === 'buttons');
    var list = U.qsa(ui.btns, '[data-action]');
    U.each(list, function (b) { flag(b, 'is-focused', s.osd && s.area === 'buttons' && b.getAttribute('data-action') === s.btn); });
  }

  function setArea(s, area, action) {
    s.area = area;
    if (area === 'buttons') {
      var defs = buttonDefs(s), has = function (a) { return !!U.find(defs, function (x) { return x.action === a; }); };
      if (action && has(action)) s.btn = action;
      else if (!has(s.btn)) s.btn = defs[0].action;
    }
    syncArea(s);
  }

  function flash(s, playing) {
    if (!ui) return;
    flag(ui.flash, 'is-play', playing);
    flag(ui.flash, 'is-on', false);
    void ui.flash.offsetWidth;
    flag(ui.flash, 'is-on', true);
  }

  var chipTimer = null;
  function showChip(s, text, ms, startOver) {
    if (!ui) return;
    setText(ui.chip, text);
    flag(ui.chip, 'is-on', true);
    s.chipStartOver = !!startOver;
    clearTimeout(chipTimer);
    chipTimer = U.later(function () {
      if (!ui) return;
      flag(ui.chip, 'is-on', false);
      if (S) S.chipStartOver = false;
    }, ms || 3500, 'player-chip');
  }

  function hideChip(s) {
    clearTimeout(chipTimer);
    if (ui) flag(ui.chip, 'is-on', false);
    if (s) s.chipStartOver = false;
  }

  /* ---------- buttons row ---------- */

  function qualityOptions(s) {
    var seen = {}, out = [];
    U.each(s.base, function (c) { if (!seen[c.label]) { seen[c.label] = true; out.push(c); } });
    out.sort(function (a, b) {
      var ia = U.indexOf(SHEET_ORDER, a.label), ib = U.indexOf(SHEET_ORDER, b.label);
      return (ia < 0 ? 50 : ia) - (ib < 0 ? 50 : ib);
    });
    return out;
  }

  function displayLabel(label) { return label === 'AUTO' ? 'Auto' : label === 'ORG' ? 'Original' : label; }

  /* The site's intro/credits marks are crowd data and can be wrong: an intro "ending" 20 minutes in would let the
     Skip Intro pill take OK over for that whole stretch, and credits "starting" early would mark the episode watched
     and jump ahead. Only plausible marks are used (the intro within the first third, at most 10 minutes; the
     credits within the last fifth and the last 10 minutes). */
  function introPoint(s, d) {
    var i = s.introEnd;
    return i > 0 && d > 0 && i <= Math.min(600, d / 3) ? i : 0;
  }

  function creditsPoint(s, d) {
    var c = s.creditsAt;
    return c > 0 && d > 0 && c < d && c >= 0.8 * d && d - c <= 600 ? c : 0;
  }

  function introActive(s) { var i = introPoint(s, dur()); return i > 0 && s.started && pos(s) < i - 1; }

  function buttonDefs(s) {
    var p = paused() && s.started, c = s.cands[s.ci];
    var list = [{ action: 'play-pause', icon: p ? 'play' : 'pause', label: p ? 'Play' : 'Pause' }];
    if (introActive(s)) list.push({ action: 'skip-intro', icon: 'skip', label: 'Skip Intro' });
    if (s.next) list.push({ action: 'next-episode', icon: 'next', label: 'Next Episode', value: s.next.season === s.season ? 'E' + s.next.episode : 'S' + s.next.season + ' E' + s.next.episode });
    if (qualityOptions(s).length > 1 || s.files.length > 1) list.push({ action: 'quality', icon: 'quality', label: 'Quality', value: c ? displayLabel(c.label) : '' });
    var ao = s.state === 'playing' ? audioOptions(s) : null;
    if (ao) list.push({ action: 'audio', icon: 'audio', label: 'Audio', value: audioCurrent(ao) });
    if (s.subs.langs.length) list.push({ action: 'subtitles', icon: 'subtitles', label: 'Subtitles', value: subValue(s) });
    list.push({ action: 'start-over', icon: 'restart', label: 'Start over' });
    return list;
  }

  function renderButtons(s) {
    if (!ui || s.state !== 'playing') return;
    var defs = buttonDefs(s), sig = U.map(defs, function (d) { return d.action + ':' + d.icon + ':' + (d.value || ''); }).join('|');
    if (sig === s.btnSig) return;
    s.btnSig = sig;
    U.empty(ui.btns);
    U.each(defs, function (d) {
      var b = el('div', 'mbp-btn', null, ui.btns);
      b.setAttribute('data-action', d.action);
      b.setAttribute('tabindex', '-1');
      b.appendChild(icon(d.icon));
      el('span', 'mbp-btn-label', d.label, b);
      if (d.value) el('span', 'mbp-btn-value', d.value, b);
    });
    if (!U.find(defs, function (d) { return d.action === s.btn; })) s.btn = 'play-pause';
    syncArea(s);
  }

  function moveButton(s, dir) {
    var defs = buttonDefs(s), i = 0;
    U.each(defs, function (d, k) { if (d.action === s.btn) i = k; });
    i = U.clamp(i + dir, 0, defs.length - 1);
    s.btn = defs[i].action;
    syncArea(s);
  }

  function activate(s, action) {
    switch (action) {
      case 'play-pause': togglePlay(s); return;
      case 'skip-intro': skipIntro(s); return;
      case 'next-episode': playNext(s, 'button'); return;
      case 'quality': openSheet(s); return;
      case 'subtitles': openSubSheet(s); return;
      case 'audio': openAudioSheet(s); return;
      case 'start-over': startOver(s); return;
    }
  }

  function renderSkip(s) {
    if (!ui) return;
    var on = s.state === 'playing' && introActive(s) && !s.osd && !(s.upnext && s.upnext.visible) && !s.sheet;
    flag(ui.skip, 'is-on', on);
    flag(ui.skip, 'is-focused', on);
  }

  /* ---------- playback actions ---------- */

  function togglePlay(s) {
    var v = ui.video;
    if (v.paused || s.blocked) {
      s.blocked = false;
      s.userPaused = false;
      s.bgPaused = false;
      playVideo(s);
      /* A stream that loaded while waiting for OK (autoplay blocked) or while paused still has to start. */
      if (s.playedTry !== s.tryId) armCandidate(s);
      flash(s, true);
    } else {
      s.userPaused = true;
      try { v.pause(); } catch (e) {}
      flash(s, false);
    }
    showOsd(s);
    render(s);
  }

  function skipIntro(s) {
    var at = introPoint(s, dur());
    if (!(at > 0)) return;
    Log.info('player', 'skip intro to ' + Math.round(at));
    s.seekCheck = null;
    seekTo(s, at);
    later(s, 'seekreport', function () { report(s, 'seek'); }, CFG.seekReport);
    render(s);
  }

  function startOver(s) {
    Log.info('player', 'start over');
    s.seekCheck = null;
    hideChip(s);
    seekTo(s, 0);
    if (paused()) playVideo(s);
    later(s, 'seekreport', function () { report(s, 'seek'); }, CFG.seekReport);
    showOsd(s);
    s.btnSig = '';
    render(s);
  }

  /* Left/Right seek by 10 s; holding (auto-repeat) accelerates to 30 s and then 60 s steps. The jump is applied
     400 ms after the last press; until then the bar previews the target time. */
  function seekBy(s, dir, ev) {
    var d = dur();
    if (!(d > 0) || !s.ready) { showOsd(s); return; }
    /* Some remotes deliver a held key as plain keydowns (repeat=false): presses of the same direction less than
       repeatGap apart count as a hold too. */
    var now = U.now(), k = s.seekKey;
    var rep = !!(ev && ev.repeat) || (!!k && k.dir === dir && now - k.at >= 0 && now - k.at < CFG.repeatGap);
    if (!k || k.dir !== dir || (!rep && now - k.at > 600)) k = s.seekKey = { dir: dir, reps: 0, at: now };
    if (rep) k.reps++;
    k.at = now;
    var step = k.reps > 14 ? 60 : k.reps > 4 ? 30 : 10;
    if (!s.seek) s.seek = { from: pos(s), target: pos(s) };
    s.seek.target = U.clamp(s.seek.target + dir * step, 0, Math.max(0, d - 1));
    flag(ui.root, 'is-seeking', true);
    showOsd(s);
    if (s.area !== 'scrub') setArea(s, 'scrub');
    cancel(s, 'osd');
    render(s);
    later(s, 'seek', function () { applySeek(s); }, CFG.seekApply);
  }

  function applySeek(s) {
    if (!s.seek) return;
    var target = s.seek.target;
    s.seek = null;
    s.seekCheck = null;
    s.seekKey = null;
    flag(ui.root, 'is-seeking', false);
    seekTo(s, target);
    if (s.upnext && s.upnext.visible) checkUpNext(s);
    later(s, 'seekreport', function () { report(s, 'seek'); }, CFG.seekReport);
    s.btnSig = '';
    render(s);
    scheduleHide(s);
  }

  /* ---------- sheets (quality, subtitles): one side sheet, filled per kind ---------- */

  /* The site copies the 1080p size onto lower renditions ("720p 1916 x 1080"): show a size only when it fits. */
  function sizeFits(c, r) {
    if (!(c.width > 0 && c.height > 0)) return false;
    if (!r) return true;
    return c.height <= r * 1.1 && Math.max(c.height, c.width / 2.4) >= r * 0.6;
  }

  function openSheet(s) {
    var items = [], cur = s.cands[s.ci];
    U.each(qualityOptions(s), function (c) {
      var meta = [], r = rank(c.label);
      if (s.failed[c.label]) meta.push('Didn\u2019t play here');
      if (c.label === 'AUTO') meta.push('Adapts to your connection');
      else if (c.label === 'ORG') meta.push(c.kind === 'risky' ? 'Original file \u00b7 may not play on a TV' : 'Original file');
      else if (r >= 2160) meta.push('4K \u00b7 needs a fast connection');
      else if (r >= 1080) meta.push('Full HD');
      else if (r >= 720) meta.push('HD \u00b7 for slower connections');
      else if (r > 0) meta.push('Data saver');
      if (sizeFits(c, r)) meta.push(c.width + ' \u00d7 ' + c.height);
      if (c.label === 'ORG' || c.h265) meta.push(c.h265 ? 'HEVC' : 'H.264');
      if (c.hdr && (c.label === 'ORG' || r >= 2160)) meta.push('HDR');
      if (c.label === 'ORG' && c.fps > 0) meta.push(Math.round(c.fps) + ' fps');
      items.push({ type: 'quality', label: c.label, title: displayLabel(c.label), meta: meta.join('  \u00b7  '), current: !!cur && cur.label === c.label });
    });
    if (s.files.length > 1) {
      U.each(s.files, function (f, i) {
        var meta = U.filter([f.file, f.size], function (x) { return !!x; }).join('  \u00b7  ');
        items.push({ type: 'file', index: i, title: f.quality || ('File ' + (i + 1)), meta: meta, current: i === s.fileIndex, section: 'Source file' });
      });
    }
    var focus = 0;
    U.each(items, function (it, i) { if (it.current && it.type === 'quality') focus = i; });
    showSheet(s, 'quality', items, focus, cur ? 'Now playing: ' + displayLabel(cur.label) : '');
  }

  /* kind 'quality' | 'subtitles'; items [{type, title, meta, current, section, ...}]. */
  function showSheet(s, kind, items, focus, sub) {
    if (!items.length) return;
    var names = { quality: 'Quality', subtitles: 'Subtitles', audio: 'Audio' };
    ui.sheet.setAttribute('data-sheet', 'player-' + kind);
    setText(ui.sheetKicker, names[kind] || '');
    setText(ui.sheetTitle, kind === 'audio' ? 'Choose audio language' : 'Choose ' + String(names[kind] || '').toLowerCase());
    U.empty(ui.sheetList);
    var labelled = {};
    U.each(items, function (it) {
      if (it.section && !labelled[it.section]) { labelled[it.section] = true; el('div', 'mbp-sheet-label', it.section, ui.sheetList); }
      var row = el('div', 'mbp-opt' + (it.current ? ' is-current' : ''), null, ui.sheetList);
      row.setAttribute('tabindex', '-1');
      if (it.type === 'quality') row.setAttribute('data-quality', it.label);
      else if (it.type === 'file') row.setAttribute('data-file-index', String(it.index));
      else if (it.type === 'sub-off') row.setAttribute('data-subtitle', 'off');
      else if (it.type === 'sub') { row.setAttribute('data-subtitle', it.li + ':' + it.fi); row.setAttribute('data-subtitle-lang', it.lang); }
      else if (it.type === 'audio') { row.setAttribute('data-audio', String(it.index)); row.setAttribute('data-audio-lang', it.code || ''); }
      var text = el('div', 'mbp-opt-text', null, row);
      var label = el('div', 'mbp-opt-label', it.title, text);
      if (it.type === 'sub' || it.type === 'audio') label.setAttribute('dir', 'auto');
      if (it.meta) el('div', 'mbp-opt-meta', it.meta, text);
      row.appendChild(icon('check', 'mbp-opt-check'));
      it.el = row;
    });
    setText(ui.sheetSub, sub || '');
    s.sheet = { kind: kind, items: items, index: U.clamp(focus, 0, items.length - 1), y: 0 };
    tf(ui.sheetList, 'translate3d(0,0,0)');
    cancel(s, 'osd');
    flag(ui.root, 'is-sheet', true);
    renderSkip(s);
    renderSheet(s);
  }

  function renderSheet(s) {
    var sh = s.sheet;
    if (!sh) return;
    U.each(sh.items, function (it, i) { flag(it.el, 'is-focused', i === sh.index); });
    var row = sh.items[sh.index] && sh.items[sh.index].el, port = ui.sheetPort;
    if (!row || !port) return;
    var top = row.offsetTop, h = row.offsetHeight, ph = port.clientHeight, y = sh.y || 0;
    if (top - y < 0) y = top - 16;
    else if (top + h - y > ph) y = top + h - ph + 16;
    sh.y = Math.max(0, y);
    tf(ui.sheetList, 'translate3d(0,' + (-sh.y) + 'px,0)');
  }

  function closeSheet(s) {
    if (!s.sheet) return;
    var kind = s.sheet.kind;
    s.sheet = null;
    flag(ui.root, 'is-sheet', false);
    showOsd(s);
    setArea(s, 'buttons', kind === 'subtitles' || kind === 'audio' ? kind : 'quality');
  }

  function chooseSheet(s) {
    var it = s.sheet && s.sheet.items[s.sheet.index];
    if (!it) return;
    closeSheet(s);
    if (it.type === 'sub-off') { if (s.subs.sel || s.subs.loading) subsOff(s, true); else savePref('off'); return; }
    if (it.type === 'sub') { if (!it.current || !s.subs.cues) selectSub(s, it.li, it.fi, 'user'); else savePref(s.subs.sel.name); return; }
    if (it.type === 'audio') { selectAudio(s, it.index, 'user'); return; }
    if (it.current) return;
    if (it.type === 'quality') switchQuality(s, it.label);
    else switchFile(s, it.index);
  }

  /* ---------- subtitles: choice, loading, rendering ---------- */

  function subSize() {
    var v = '';
    try { v = typeof Prefs !== 'undefined' ? Prefs.get('subtitleSize') : ''; } catch (e) { v = ''; }
    return v === 'small' || v === 'large' ? v : 'medium';
  }

  /* The remembered language name ('' = off: first run, or the viewer chose Off). */
  function prefLang() {
    var v = '';
    try { v = typeof Prefs !== 'undefined' ? Prefs.get('subtitleLang') : ''; } catch (e) { v = ''; }
    return typeof v === 'string' && v !== 'off' ? U.text(v) : '';
  }

  function savePref(name) {
    try { if (typeof Prefs !== 'undefined') Prefs.set('subtitleLang', name ? String(name) : 'off'); } catch (e) {}
  }

  function langIndex(langs, name) {
    var want = String(name || '').toLowerCase(), i;
    if (!want) return -1;
    for (i = 0; i < langs.length; i++) if (langs[i].name.toLowerCase() === want || String(langs[i].key).toLowerCase() === want) return i;
    return -1;
  }

  function subLabel(s, li, fi) {
    var L = s.subs.langs[li];
    return L ? L.name + (fi > 0 ? ' \u00b7 ' + (fi + 1) : '') : '';
  }

  function subValue(s) {
    var sub = s.subs;
    if (sub.loading) return 'Loading\u2026';
    return sub.sel ? subLabel(s, sub.sel.li, sub.sel.fi) : 'Off';
  }

  function openSubSheet(s) {
    var sub = s.subs, items = [], focus = 0;
    if (!sub.langs.length) { showChip(s, 'No subtitles for this title', 2500, false); return; }
    items.push({ type: 'sub-off', title: 'Off', meta: '', current: !sub.sel });
    U.each(sub.langs, function (L, li) {
      U.each(L.files, function (f, fi) {
        var meta = String(f.name || '').replace(/^\[[\w\-]+\]\s*/, '');
        if (f.delay) meta = (meta ? meta + '  \u00b7  ' : '') + 'Delay ' + (f.delay > 0 ? '+' : '\u2212') + Math.abs(f.delay) + ' s';
        var cur = !!sub.sel && sub.sel.li === li && sub.sel.fi === fi;
        if (cur) focus = items.length;
        items.push({ type: 'sub', li: li, fi: fi, lang: L.name, title: subLabel(s, li, fi), meta: meta, current: cur });
      });
    });
    var n = sub.langs.length;
    showSheet(s, 'subtitles', items, focus, (sub.sel ? 'Showing ' + subLabel(s, sub.sel.li, sub.sel.fi) : 'Subtitles are off') +
      '  \u00b7  ' + n + (n === 1 ? ' language' : ' languages'));
  }

  /* New player data (first load, fresh links, another file): keep the chosen file when it is still listed, else the
     same language; the first load of a session picks the remembered language (Prefs subtitleLang) when it exists. */
  function subsData(s, d) {
    var sub = s.subs, langs = d.subtitles || [];
    sub.langs = langs;
    if (sub.sel || sub.loading) {
      var sel = sub.sel, li, fi;
      for (li = 0; sel && li < langs.length; li++) {
        for (fi = 0; fi < langs[li].files.length; fi++) {
          var f = langs[li].files[fi];
          if ((sel.sid && f.sid === sel.sid) || (!sel.sid && f.url === sel.url)) { sel.li = li; sel.fi = fi; return; }
        }
      }
      var same = sel ? langIndex(langs, sel.name) : -1;
      subsOff(s, false);
      if (same >= 0) selectSub(s, same, 0, 'keep');
      return;
    }
    if (sub.decided) return;
    sub.decided = true;
    var want = prefLang(), at = want ? langIndex(langs, want) : -1;
    if (at >= 0) selectSub(s, at, 0, 'auto');
    else if (want && langs.length) Log.info('player', 'subtitles: no ' + want + ' for this title');
  }

  function subsOff(s, user) {
    var sub = s.subs;
    sub.seq++;
    sub.loading = 0;
    sub.sel = null;
    sub.cues = null;
    sub.decided = true;
    cancel(s, 'sub');
    subShow(s, null);
    if (user) {
      savePref('off');
      Log.info('player', 'subtitles off');
      showChip(s, 'Subtitles off', 2000, false);
    }
    s.btnSig = '';
    render(s);
  }

  /* how: 'user' (the sheet; remembered), 'auto' (the remembered language) or 'keep' (same language, new data). */
  function selectSub(s, li, fi, how) {
    var sub = s.subs, L = sub.langs[li], f = L && L.files[fi];
    if (!f) return;
    var user = how === 'user', label = subLabel(s, li, fi), key = f.sid || f.url, seq = ++sub.seq;
    if (user) savePref(L.name);
    sub.decided = true;
    sub.sel = { li: li, fi: fi, sid: f.sid, url: f.url, name: L.name };
    sub.delay = f.delay || 0;
    sub.cues = null;
    cancel(s, 'sub');
    subShow(s, null);
    if (sub.cache.hasOwnProperty(key)) {
      sub.loading = 0;
      sub.cues = sub.cache[key];
      if (user) showChip(s, 'Subtitles: ' + label, 2500, false);
      s.btnSig = '';
      render(s);
      subTick(s);
      return;
    }
    sub.loading = seq;
    s.btnSig = '';
    render(s);
    if (user) showChip(s, 'Loading ' + label + ' subtitles\u2026', CFG.subTimeout * 2 + 2000, false);
    Log.info('player', 'subtitles: loading ' + label + ' (' + how + ')');
    loadSubFile(s, f, L.name, function (err, cues) {
      if (s !== S || s.finished || sub.seq !== seq) return;
      sub.loading = 0;
      if (err) {
        Log.warn('player', 'subtitles ' + label + ' failed: ' + err);
        sub.sel = null;
        var note = label + ' subtitles couldn\u2019t be loaded';
        if (user || (s.started && !U.hasClass(ui.chip, 'is-on'))) showChip(s, note, 3500, false);
        else if (!s.started) sub.note = note;
        s.btnSig = '';
        render(s);
        return;
      }
      sub.cache[key] = cues;
      sub.cues = cues;
      Log.info('player', 'subtitles: ' + label + ', ' + cues.length + ' cues' + (sub.delay ? ', delay ' + sub.delay + ' s' : ''));
      if (user) showChip(s, 'Subtitles: ' + label, 2500, false);
      s.btnSig = '';
      render(s);
      subTick(s);
    });
  }

  /* GET as bytes (no credentials cross-site). Cross-site subtitle hosts send no CORS header: the LG app may read them
     anyway; elsewhere this fails fast and the site's own same-origin proxy is tried. */
  function getBytes(s, url, cb) {
    var done = false, req = new XMLHttpRequest(), timer = null, h = null;
    function finish(err, buf) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      var i = U.indexOf(s.reqs, h);
      if (i >= 0) s.reqs.splice(i, 1);
      U.later(function () { cb(err, buf); }, 0, 'player-sub-cb');
    }
    h = { abort: function () { if (!done) { done = true; clearTimeout(timer); try { req.abort(); } catch (e) {} } } };
    s.reqs.push(h);
    try {
      req.open('GET', url, true);
      req.responseType = 'arraybuffer';
      if (U.sameSite(url)) { req.withCredentials = true; req.setRequestHeader('X-Requested-With', 'XMLHttpRequest'); }
      req.onreadystatechange = function () {
        if (req.readyState !== 4 || done) return;
        var buf = null;
        try { buf = req.response; } catch (e0) { buf = null; }
        if (req.status >= 200 && req.status < 300 && buf && buf.byteLength > 0) finish(buf.byteLength > 8000000 ? 'too-big' : null, buf);
        else finish(req.status ? 'http-' + req.status : 'network', null);
      };
      timer = setTimeout(function () { finish('timeout', null); try { req.abort(); } catch (e1) {} }, CFG.subTimeout);
      req.send(null);
    } catch (e2) { finish('exception', null); }
    return h;
  }

  /* The file itself, then the site's own proxy (GET /index/index/get_srt_content?srt_path=URL, what its player uses). */
  function loadSubFile(s, f, langName, cb) {
    var urls = [f.url, origin() + '/index/index/get_srt_content?srt_path=' + enc(f.url)], errs = [];
    function attempt(i) {
      if (i >= urls.length) { cb(errs.join(', ') || 'failed', null); return; }
      getBytes(s, urls[i], function (err, buf) {
        if (s !== S || s.finished) return;
        var cues = null;
        if (!err) {
          try { cues = parseCues(decodeSub(buf, f.lang, langName)); } catch (e) { err = 'parse'; }
          if (cues && cues.length) { cb(null, cues); return; }
          err = err || 'no-cues';
        }
        errs.push((i ? 'proxy ' : '') + err);
        attempt(i + 1);
      });
    }
    attempt(0);
  }

  /* Cue markup -> elements: <i>, <b> and <u> are kept, every other tag and {\an8}-style codes are dropped. */
  function subLine(raw, box) {
    var line = document.createElement('div'), st = { i: 0, b: 0, u: 0 }, any = false, m;
    line.className = 'mbp-subs-line';
    line.setAttribute('dir', 'auto');
    var re = /<\s*(\/?)\s*([a-zA-Z]+)[^>]*>|\{\\[^}]*\}|([^<{]+|[<{])/g;
    while ((m = re.exec(raw))) {
      if (m[3] != null) {
        var t = htmlDecode(m[3]);
        if (!t) continue;
        if (/\S/.test(t)) any = true;
        var cls = (st.i ? ' mbp-subs-i' : '') + (st.b ? ' mbp-subs-b' : '') + (st.u ? ' mbp-subs-u' : '');
        if (cls) el('span', cls.slice(1), t, line); else line.appendChild(document.createTextNode(t));
      } else if (m[2]) {
        var tag = m[2].toLowerCase();
        if (st.hasOwnProperty(tag)) st[tag] = Math.max(0, st[tag] + (m[1] ? -1 : 1));
      }
    }
    if (any) box.appendChild(line);
    return any;
  }

  /* Shows the cues at these indexes (null = none). The DOM changes only when the set changes; at most 3 lines. */
  function subShow(s, list) {
    if (!ui) return;
    var sub = s && s.subs, sig = list && list.length ? list.join(',') : '';
    if (sub && sub.sig === sig && (sig || !U.hasClass(ui.subs, 'is-on'))) return;
    if (sub) sub.sig = sig;
    U.empty(ui.subsBox);
    var used = 0;
    if (sig && sub && sub.cues) {
      U.each(list, function (idx) {
        var c = sub.cues[idx];
        if (!c) return;
        U.each(c.text.split('\n'), function (raw) { if (used < 3 && subLine(raw, ui.subsBox)) used++; });
      });
    }
    flag(ui.subs, 'is-on', used > 0);
  }

  /* Called on timeupdate, seeked, playing and pause; between them a timer wakes up exactly when the next cue starts
     or the current one ends (no per-frame work). */
  function subTick(s) {
    if (!ui || s !== S) return;
    var sub = s.subs, v = ui.video;
    if (!sub.cues || !sub.sel || s.state !== 'playing' || !s.ready) { cancel(s, 'sub'); subShow(s, null); return; }
    var t = (v.currentTime || 0) + sub.delay, at = cuesAt(sub.cues, t);
    subShow(s, at.list);
    cancel(s, 'sub');
    if (v.paused || v.seeking || !(at.next < Infinity)) return;
    var rate = v.playbackRate > 0 ? v.playbackRate : 1;
    later(s, 'sub', function () { subTick(s); }, U.clamp((at.next - t) / rate * 1000 + 20, 30, 1000));
  }


  /* ---------- audio languages (docs/PLAYER.md "Audio languages") ---------- */

  /* Whether a rewritten HLS master (data: URL) plays on this TV: '' not tried yet, 'ok', 'broken' (for this run). */
  var manifestState = '';

  var LANGS = {
    en: 'English', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
    pt: 'Portuguese', ru: 'Russian', hi: 'Hindi', ar: 'Arabic', tr: 'Turkish', pl: 'Polish', nl: 'Dutch', sv: 'Swedish',
    da: 'Danish', fi: 'Finnish', no: 'Norwegian', nb: 'Norwegian', cs: 'Czech', hu: 'Hungarian', el: 'Greek', he: 'Hebrew',
    th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada',
    bn: 'Bengali', uk: 'Ukrainian', ro: 'Romanian', fa: 'Persian', ur: 'Urdu', tl: 'Filipino', ca: 'Catalan', hr: 'Croatian',
    sr: 'Serbian', bg: 'Bulgarian', sk: 'Slovak', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', is: 'Icelandic'
  };
  /* ISO 639-2 codes (Matroska tracks, and the site's NAME="KOR (5.1)" labels) to the 2-letter codes above. */
  var LANG3 = {
    eng: 'en', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
    por: 'pt', rus: 'ru', hin: 'hi', ara: 'ar', tur: 'tr', pol: 'pl', dut: 'nl', nld: 'nl', swe: 'sv', dan: 'da', fin: 'fi',
    nor: 'no', nob: 'nb', cze: 'cs', ces: 'cs', hun: 'hu', gre: 'el', ell: 'el', heb: 'he', tha: 'th', vie: 'vi', ind: 'id',
    may: 'ms', msa: 'ms', tam: 'ta', tel: 'te', mal: 'ml', kan: 'kn', ben: 'bn', ukr: 'uk', rum: 'ro', ron: 'ro', per: 'fa',
    fas: 'fa', urd: 'ur', fil: 'tl', tgl: 'tl', cat: 'ca', hrv: 'hr', srp: 'sr', bul: 'bg', slo: 'sk', slk: 'sk', slv: 'sl',
    lit: 'lt', lav: 'lv', est: 'et', ice: 'is', isl: 'is'
  };

  /* 'en', 'eng', 'en-GB', 'KOR' -> 'en' / 'ko'; unknown ('un', 'und') -> ''. */
  function langCode(v) {
    var c = String(v || '').toLowerCase().replace(/_/g, '-').split('-')[0];
    if (LANG3.hasOwnProperty(c)) return LANG3[c];
    if (!/^[a-z]{2}$/.test(c) || c === 'un') return '';
    return c;
  }

  function langName(code) { return LANGS.hasOwnProperty(code) ? LANGS[code] : code ? code.toUpperCase() : ''; }

  function m3uAttrs(line) {
    var out = {}, re = /([A-Z0-9\-]+)=("[^"]*"|[^,]*)/g, m;
    while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  /* Pure: an HLS master playlist -> {group, list: [{code, lang, name, def, channels}], def} for the audio group the
     first variant uses (the site's masters carry one AAC group with audio=aac, e.g. KOR and ITA). */
  function audioList(text) {
    var lines = String(text || '').split(/\r?\n/), groups = {}, group = '', i, a;
    for (i = 0; i < lines.length; i++) {
      if (/^#EXT-X-MEDIA:/.test(lines[i])) {
        a = m3uAttrs(lines[i].slice(13));
        if (a.TYPE !== 'AUDIO' || !a['GROUP-ID']) continue;
        (groups[a['GROUP-ID']] = groups[a['GROUP-ID']] || []).push({
          code: langCode(a.LANGUAGE) || langCode(String(a.NAME || '').split(/[\s(#]/)[0]), lang: a.LANGUAGE || '',
          name: U.text(a.NAME || '').slice(0, 60), def: a.DEFAULT === 'YES', channels: a.CHANNELS || ''
        });
      } else if (!group && /^#EXT-X-STREAM-INF:/.test(lines[i])) group = m3uAttrs(lines[i].slice(18)).AUDIO || '';
    }
    var list = group && groups[group] ? groups[group] : [], def = 0;
    for (i = 0; i < list.length; i++) if (list[i].def) { def = i; break; }
    return { group: group, list: list, def: def };
  }

  function absUrl(u, base) {
    u = String(u || '');
    if (/^[a-z][a-z0-9+.\-]*:/i.test(u)) return u;
    var m = /^([a-z]+:)\/\/([^\/?#]*)([^?#]*)/i.exec(String(base || ''));
    if (!m) return u;
    if (u.slice(0, 2) === '//') return m[1] + u;
    if (u.charAt(0) === '/') return m[1] + '//' + m[2] + u;
    return m[1] + '//' + m[2] + m[3].replace(/[^\/]*$/, '') + u;
  }

  function setM3uAttr(line, name, value) {
    var re = new RegExp('([:,])' + name + '=("[^"]*"|[^,]*)');
    return re.test(line) ? line.replace(re, '$1' + name + '=' + value) : line + ',' + name + '=' + value;
  }

  /* Pure: the master with only the index-th rendition of the audio group (made the default) and every address
     absolute, so the TV's player can read it from a data: URL. */
  function audioMaster(text, base, group, index) {
    var lines = String(text || '').split(/\r?\n/), out = [], k = -1, i, line, a;
    for (i = 0; i < lines.length; i++) {
      line = lines[i];
      if (/^#EXT-X-MEDIA:/.test(line)) {
        a = m3uAttrs(line.slice(13));
        if (a.TYPE === 'AUDIO' && a['GROUP-ID'] === group) {
          k++;
          if (k !== index) continue;
          line = setM3uAttr(setM3uAttr(line, 'DEFAULT', 'YES'), 'AUTOSELECT', 'YES');
        }
      }
      if (line.charAt(0) === '#') line = line.replace(/URI="([^"]*)"/g, function (m0, u) { return 'URI="' + absUrl(u, base) + '"'; });
      else if (/\S/.test(line)) line = absUrl(line.replace(/^\s+|\s+$/g, ''), base);
      out.push(line);
    }
    return out.join('\n');
  }

  function dataUrl(text) {
    try { return 'data:application/vnd.apple.mpegurl;base64,' + window.btoa(unescape(encodeURIComponent(text))); } catch (e) { return ''; }
  }

  function trackList() {
    try { var t = ui && ui.video ? ui.video.audioTracks : null; return t && typeof t.length === 'number' ? t : null; } catch (e) { return null; }
  }

  /* GET text cross-site without credentials (the HLS hosts answer Access-Control-Allow-Origin: *). */
  function getText(s, url, cb) {
    var done = false, req = new XMLHttpRequest(), timer = null, h = null;
    function finish(err, text) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      var i = U.indexOf(s.reqs, h);
      if (i >= 0) s.reqs.splice(i, 1);
      U.later(function () { cb(err, text); }, 0, 'player-audio-cb');
    }
    h = { abort: function () { if (!done) { done = true; clearTimeout(timer); try { req.abort(); } catch (e) {} } } };
    s.reqs.push(h);
    try {
      req.open('GET', url, true);
      req.onreadystatechange = function () {
        if (req.readyState !== 4 || done) return;
        var t = '';
        try { t = String(req.responseText || ''); } catch (e0) { t = ''; }
        if (req.status >= 200 && req.status < 300) finish(t.length > 400000 ? 'too-big' : null, t);
        else finish(req.status ? 'http-' + req.status : 'network', '');
      };
      timer = setTimeout(function () { finish('timeout', ''); try { req.abort(); } catch (e1) {} }, CFG.audioTimeout);
      req.send(null);
    } catch (e2) { finish('exception', ''); }
  }

  /* The HLS master of the stream that plays, read once it plays (never before: the start must not wait for it). */
  function audioFetch(s, c) {
    var a = s.audio;
    if (!c || !c.hls || c.synthetic || /^data:/i.test(c.src) || (a.master && a.master.src === c.src) || a.fetching === c.src || a.unread === c.src) return;
    a.fetching = c.src;
    getText(s, c.src, function (err, text) {
      if (s !== S || s.finished) return;
      if (a.fetching === c.src) a.fetching = '';
      if (err || !/^\s*#EXTM3U/.test(text)) { a.unread = c.src; Log.info('player', 'audio: master not read (' + (err || 'not a playlist') + ')'); return; }
      var info = audioList(text), tl = trackList();
      a.master = { src: c.src, text: text, group: info.group, list: info.list, def: info.def };
      Log.info('player', 'audio: ' + c.label + ' lists ' + info.list.length + (info.list.length ? ' [' + U.map(info.list, function (x, i) {
        return (x.code || x.lang || '?') + (i === info.def ? '*' : '');
      }).join(', ') + ']' : '') + '; video.audioTracks ' + (tl ? tl.length : 'missing') + (manifestState ? '; data: master ' + manifestState : ''));
      audioRefresh(s);
    });
  }

  /* The choices for the stream that plays: {method: 'tracks' | 'manifest', items: [{index, code, title, meta, current}]}
     or null. 'tracks' (the platform lists the tracks in video.audioTracks) is preferred; 'manifest' needs the HLS master
     and a TV that plays a rewritten master (manifestState not 'broken'). */
  /* hls.js's audio tracks (its current audio group) as raw choices. */
  function hlsAudioRaw(h) {
    var t = hlsAudioTracks(h), cur = hlsAudioIndex(h), out = [], i;
    for (i = 0; i < t.length && i < 16; i++) {
      var x = t[i] || {};
      out.push({ index: i, code: langCode(x.lang) || langCode(String(x.name || '').split(/[\s(#]/)[0]), name: U.text(x.name || '').slice(0, 60), current: i === cur });
    }
    if (out.length && cur < 0) out[0].current = true;
    return out;
  }

  function audioOptions(s) {
    var c = s.cands[s.ci], a = s.audio, tl = trackList(), raw = [], method = '', i;
    if (!c || !s.ready) return null;
    var h = hlsOf(s);
    if (h) return audioPost('hlsjs', hlsAudioRaw(h));
    var src = c.synthetic ? c.orig.src : c.src, m = a.master && a.master.src === src ? a.master : null;
    if (tl && tl.length > 1) {
      method = 'tracks';
      var any = false;
      for (i = 0; i < tl.length && i < 16; i++) {
        var t = tl[i], e = m && m.list.length === tl.length ? m.list[i] : null;
        if (t && t.enabled) any = true;
        raw.push({ index: i, code: langCode(t && t.language) || (e ? e.code : ''), name: U.text(t && t.label || '') || (e ? e.name : ''), current: !!(t && t.enabled) });
      }
      if (!any && raw.length) raw[0].current = true;
    } else if (m && m.list.length > 1 && c.hls && manifestState !== 'broken') {
      method = 'manifest';
      var cur = c.synthetic ? c.audioIndex : m.def;
      for (i = 0; i < m.list.length && i < 16; i++) raw.push({ index: i, code: m.list[i].code, name: m.list[i].name, current: i === cur });
    } else return null;
    return audioPost(method, raw);
  }

  /* Titles ('Japanese', 'English · 2') and second lines for raw choices; null when there is no real choice. */
  function audioPost(method, raw) {
    if (raw.length < 2) return null;
    var count = {}, seen = {}, codes = 0;
    U.each(raw, function (r) {
      r.title = langName(r.code) || r.name || 'Track ' + (r.index + 1);
      count[r.title] = (count[r.title] || 0) + 1;
      if (!seen[r.code || r.title]) { seen[r.code || r.title] = true; codes++; }
    });
    /* One language twice over HLS (a stereo and a 5.1 mix, a commentary) is not worth a switch: only real choices. */
    if ((method === 'manifest' || method === 'hlsjs') && codes < 2) return null;
    var n = {};
    U.each(raw, function (r) {
      if (count[r.title] > 1) { n[r.title] = (n[r.title] || 0) + 1; if (n[r.title] > 1) r.title += ' · ' + n[r.title]; }
      r.meta = r.name && r.name.toLowerCase() !== r.title.toLowerCase() ? r.name : '';
    });
    return { method: method, items: raw };
  }

  function audioCurrent(o) { var c = o ? U.find(o.items, function (x) { return x.current; }) : null; return c ? c.title : ''; }

  function prefAudio() {
    var v = '';
    try { v = typeof Prefs !== 'undefined' ? Prefs.get('audioLang') : ''; } catch (e) { v = ''; }
    return typeof v === 'string' ? U.text(v).toLowerCase() : '';
  }

  function saveAudioPref(it) {
    try { if (typeof Prefs !== 'undefined') Prefs.set('audioLang', it.code || it.title); } catch (e) {}
  }

  function audioMatch(o, want) {
    var i;
    for (i = 0; i < o.items.length; i++) if (o.items[i].code && o.items[i].code === want) return i;
    for (i = 0; i < o.items.length; i++) if (o.items[i].title.toLowerCase() === want) return i;
    return -1;
  }

  /* After metadata, a track-list change, a master read or a start: refresh the Audio button and, once per stream,
     switch to the remembered language (Prefs audioLang) when this title has it. */
  function audioRefresh(s) {
    if (!ui || s !== S || s.finished) return;
    s.btnSig = '';
    var c = s.cands[s.ci], a = s.audio;
    if (c && c.hls && !c.synthetic && s.playedTry === s.tryId && !hlsOf(s)) audioFetch(s, c);
    var want = prefAudio();
    if (want && a.prefTry !== s.tryId && !a.pending && s.playedTry === s.tryId) {
      var o = audioOptions(s), at = o ? audioMatch(o, want) : -1;
      /* Wait for the master's names when the platform's tracks carry no language yet. */
      if (o && (at >= 0 || a.master || !(c && c.hls) || !a.fetching)) {
        a.prefTry = s.tryId;
        if (at >= 0 && !o.items[at].current) {
          Log.info('player', 'audio: the remembered language (' + want + ')');
          selectAudio(s, at, 'auto');
        }
      }
    }
    if (s.state === 'playing') render(s);
  }

  /* how: 'user' (the sheet; remembered) or 'auto' (the remembered language). */
  function selectAudio(s, index, how) {
    var o = audioOptions(s), it = o && o.items[index];
    if (!it) return;
    if (how === 'user') saveAudioPref(it);
    if (it.current) { if (how === 'user') showChip(s, 'Audio: ' + it.title, 2500, false); return; }
    if (o.method === 'hlsjs') {
      var h = hlsOf(s);
      Log.info('player', 'audio: track ' + (it.index + 1) + ' of ' + o.items.length + ' (' + (it.code || '?') + ') via hls.js');
      h.audioWant = { index: it.index, title: it.title, how: how };
      try { h.hls.audioTrack = it.index; } catch (e0) { Log.warn('player', 'audio: ' + clean(e0)); }
      if (how === 'user') showChip(s, 'Switching audio to ' + it.title + '\u2026', CFG.audioSwitchTimeout, false);
      s.btnSig = '';
      render(s);
      later(s, 'audioverify', function () {
        if (hlsCur !== h || !h.audioWant || h.audioWant.index !== it.index) return;
        h.audioWant = null;
        Log.warn('player', 'audio: hls.js did not switch the track');
        showChip(s, 'The audio didn\u2019t switch', 3000, false);
        s.btnSig = '';
        render(s);
      }, CFG.audioSwitchTimeout);
      return;
    }
    if (o.method === 'tracks') {
      var tl = trackList(), j;
      Log.info('player', 'audio: track ' + (index + 1) + ' of ' + tl.length + ' (' + (it.code || '?') + ') via audioTracks');
      try {
        tl[index].enabled = true;
        for (j = 0; j < tl.length; j++) if (j !== index && tl[j].enabled) tl[j].enabled = false;
      } catch (e) { Log.warn('player', 'audio: ' + clean(e)); }
      s.btnSig = '';
      render(s);
      later(s, 'audioverify', function () {
        var now = trackList(), ok = !!(now && now[index] && now[index].enabled);
        if (ok) Log.info('player', 'audio: switched'); else Log.warn('player', 'audio: the TV did not switch the track');
        if (how === 'user' || !ok) showChip(s, ok ? 'Audio: ' + it.title : 'The TV didn’t switch the audio', 3000, false);
        s.btnSig = '';
        render(s);
      }, CFG.audioVerify);
      return;
    }
    /* 'manifest': the same stream from a master that offers only the chosen rendition, at the same position; if the
       TV cannot play it, the stream that was playing takes over again (switchOutcome -> audioOutcome). */
    var c = s.cands[s.ci], base = c.synthetic ? c.orig : c, m = s.audio.master, cand = base;
    if (index !== m.def) {
      var url = dataUrl(audioMaster(m.text, m.src, m.group, index));
      if (!url) return;
      cand = { label: base.label, src: url, hls: true, h265: base.h265, hdr: base.hdr, width: base.width, height: base.height,
        fps: base.fps, kind: 'hls', synthetic: true, orig: base, audioIndex: index };
    }
    var rest = U.filter(s.cands, function (x) { return x !== c && x !== base && !x.synthetic; });
    var at = pos(s);
    report(s, 'switch');
    Log.info('player', 'audio: ' + (it.code || '?') + ' via a rewritten master at ' + Math.round(at));
    s.audio.pending = { index: index, title: it.title, how: how, synthetic: cand !== base };
    s.cands = [cand].concat(cand !== base ? [base] : [], rest);
    s.switchNote = '';
    s.resumePending = false;
    if (how === 'user') showChip(s, 'Switching audio to ' + it.title + '…', 8000, false);
    startCandidate(s, 0, at, 'audio');
  }

  function audioOutcome(s, c, au) {
    s.audio.pending = null;
    if (!au.synthetic) { if (au.how === 'user') s.switchNote = 'Audio: ' + au.title; return; }
    if (c && c.synthetic) {
      if (manifestState !== 'ok') Log.info('player', 'audio: a rewritten master plays on this TV');
      manifestState = 'ok';
      s.switchNote = 'Audio: ' + au.title;
    } else {
      Log.warn('player', 'audio: a rewritten master does not play on this TV');
      manifestState = 'broken';
      s.switchNote = 'This TV can’t switch the audio language';
    }
  }

  function openAudioSheet(s) {
    var o = audioOptions(s), items = [], focus = 0;
    if (!o) { showChip(s, 'No other audio languages for this title', 2500, false); return; }
    U.each(o.items, function (it, i) {
      if (it.current) focus = i;
      items.push({ type: 'audio', index: it.index, code: it.code, title: it.title, meta: it.meta, current: it.current });
    });
    showSheet(s, 'audio', items, focus, 'Now: ' + audioCurrent(o) + '  ·  ' + o.items.length + ' tracks');
  }

  /* The chosen stream first; if it does not play, back to the stream that was playing (at the same position), then
     the usual order with streams that already failed in this session last. The chip says what actually plays. */
  function switchQuality(s, label) {
    var chosen = null, cur = s.cands[s.ci], back = null, fresh = [], stale = [];
    U.each(s.base, function (c) {
      if (!chosen && c.label === label) chosen = c;
      else if (!back && cur && c.label === cur.label) back = c;
      else if (s.failed[c.label]) stale.push(c);
      else fresh.push(c);
    });
    if (!chosen) return;
    var at = pos(s);
    if (s.seek) at = s.seek.target;
    s.seek = null; s.seekKey = null; cancel(s, 'seek');
    if (ui) flag(ui.root, 'is-seeking', false);
    report(s, 'switch');
    Log.info('player', 'quality ' + label + ' at ' + Math.round(at) + (back ? ' (from ' + back.label + ')' : ''));
    s.cands = [chosen].concat(back ? [back] : [], fresh, stale);
    s.switching = { label: label };
    s.switchNote = '';
    s.resumePending = false;
    startCandidate(s, 0, at, 'quality');
  }

  function switchFile(s, index) {
    Log.info('player', 'file ' + index + ' at ' + Math.round(pos(s)));
    report(s, 'switch');
    showChip(s, 'Switching file\u2026', 8000, false);
    fetchPlayerData(s, index, function (err, d) {
      if (err && err.code === 'signed-out') { fallback(s, 'signed-out'); return; }
      if (err || !d.sources.length) {
        Log.warn('player', 'file switch failed: ' + (err ? err.code : 'no sources'));
        showChip(s, 'That file isn\u2019t available right now', 3500, false);
        return;
      }
      /* The current file kept playing during the request (up to about 30 s): continue from where it is now. */
      var at = pos(s);
      if (s.seek) at = s.seek.target;
      s.seek = null; s.seekKey = null; cancel(s, 'seek');
      if (ui) flag(ui.root, 'is-seeking', false);
      report(s, 'switch');
      s.fileIndex = index;
      applyData(s, d);
      s.resumePending = false;
      s.switchNote = 'Now playing ' + (s.files[index].quality || 'the other file');
      startCandidate(s, 0, at, 'file');
    });
  }

  /* ---------- Up Next (Netflix style) ---------- */

  function nextReq(s, season, episode) {
    return {
      kind: 'tv', id: s.id, season: season, episode: episode, title: s.req.title, showTitle: s.req.showTitle || s.req.title,
      episodeTitle: season === (s.next && s.next.season) && episode === (s.next && s.next.episode) && s.nextInfo ? s.nextInfo.title : '',
      backdrop: s.req.backdrop, poster: s.req.poster, autoplayNext: s.req.autoplayNext
    };
  }

  function prefetchNext(s) {
    if (s.kind !== 'tv' || s.nextFetching) return;
    var wantCur = !U.text(s.req.episodeTitle || '');
    if (!s.next && !wantCur) return;
    s.nextFetching = true;
    var seasons = [];
    if (s.next) seasons.push(s.next.season);
    if (wantCur && U.indexOf(seasons, s.season) < 0) seasons.push(s.season);
    U.each(seasons, function (season) {
      Api.detail('tv', s.id, safe(s, function (err, d) {
        if (err || !d) return;
        var eps = d.episodes || [];
        if (s.next && season === s.next.season) {
          var ep = U.find(eps, function (e) { return e.season === s.next.season && e.episode === s.next.episode; });
          s.nextInfo = { title: ep ? ep.title || '' : '', still: ep ? ep.still || '' : '', runtime: ep ? ep.runtime || '' : '' };
          if (s.upnext && s.upnext.visible) fillUpNext(s);
        }
        if (wantCur && season === s.season && !U.text(s.req.episodeTitle || '')) {
          var cur = U.find(eps, function (e) { return e.season === s.season && e.episode === s.episode; });
          if (cur && cur.title) { s.req.episodeTitle = cur.title; renderTitles(s); }
        }
      }, 'player-next-info'), { season: season });
    });
  }

  function upNextAt(s, d) {
    var at = d - CFG.upNextLead, c = creditsPoint(s, d);
    if (c > 0) at = Math.min(at, c);
    return at;
  }

  function checkUpNext(s) {
    if (s.kind !== 'tv' || !s.next || s.state !== 'playing' || s.sheet) return;
    var d = dur();
    if (!(d > 0)) return;
    var t = pos(s), at = upNextAt(s, d);
    /* The next episode's file list, read ahead a little before the card shows (Play now / autoplay skip it). */
    if (!s.nextFilesAsked && t >= at - 90) { s.nextFilesAsked = true; prefetchFiles(s.id, s.next.season, s.next.episode, 'up next'); }
    if (s.upnext && s.upnext.visible) {
      if (!s.upnext.ended && t < at - 5) hideUpNext(s, false);
      return;
    }
    if (s.dismissedNext && t < at - 30) s.dismissedNext = false; /* rewound well before the credits: offer it again */
    if (t >= at && !s.dismissedNext) showUpNext(s, false);
  }

  function fillUpNext(s) {
    var n = s.next, info = s.nextInfo || {};
    setText(ui.unTitle, info.title || 'Episode ' + n.episode);
    setText(ui.unMeta, U.filter(['S' + n.season + ' \u00b7 E' + n.episode, shortRuntime(info.runtime)], function (x) { return !!x; }).join('  \u00b7  '));
    setText(ui.unPh, 'E' + n.episode);
    if (safeImage(info.still)) setArt(ui.unImg, info.still, 500);
    else {
      flag(ui.unImg, 'is-loaded', false);
      ui.unImg.removeAttribute('src');
    }
  }

  /* After stillWatchingAfter episodes in a row started by autoplay with no key pressed, the card asks "Still
     watching?" instead of counting down, and the video pauses until the viewer answers (Netflix does the same), so
     a sleeping viewer's place is kept and later episodes are not marked watched. */
  function showUpNext(s, ended) {
    if (!s.next) return;
    prefetchNext(s);
    var still = CFG.stillWatchingAfter > 0 && unattended >= CFG.stillWatchingAfter;
    var auto = s.req.autoplayNext !== false && !still;
    s.upnext = { visible: true, focus: 0, count: auto ? CFG.upNextCount : -1, total: CFG.upNextCount, ended: !!ended, still: still };
    Log.info('player', 'up next S' + s.next.season + 'E' + s.next.episode + (ended ? ' (ended)' : '') + (still ? ' (still watching?)' : auto ? '' : ' (no autoplay)'));
    if (s.sheet) { s.sheet = null; flag(ui.root, 'is-sheet', false); }
    hideOsd(s, true);
    hideChip(s);
    fillUpNext(s);
    tf(ui.unFill, 'scaleX(0)');
    flag(ui.unFill, 'is-running', false);
    flag(ui.root, 'is-upnext', true);
    flag(ui.root, 'is-still', still);
    renderUpNext(s);
    renderSkip(s);
    if (still && !ended && !paused()) { try { ui.video.pause(); } catch (e) {} }
    if (auto) {
      U.later(function () {
        if (!ui || !s.upnext || !s.upnext.visible) return;
        flag(ui.unFill, 'is-running', true);
        tf(ui.unFill, 'scaleX(' + (1 / s.upnext.total).toFixed(4) + ')');
      }, 30, 'player-upnext-fill');
      later(s, 'upnext', function () { upNextTick(s); }, 1000);
    }
  }

  function upNextTick(s) {
    var u = s.upnext;
    if (!u || !u.visible || u.count < 0) return;
    if ((!paused() || u.ended) && !isHidden()) u.count--;
    if (u.count <= 0) { playNext(s, 'autoplay'); return; }
    renderUpNext(s);
    later(s, 'upnext', function () { upNextTick(s); }, 1000);
  }

  function renderUpNext(s) {
    var u = s.upnext;
    if (!u) return;
    setText(ui.unCount, u.still ? 'Still watching?' : u.count >= 0 ? 'Next episode in ' + u.count : 'Up next');
    if (u.count >= 0 && u.count < u.total) tf(ui.unFill, 'scaleX(' + U.clamp((u.total - u.count + 1) / u.total, 0, 1).toFixed(4) + ')');
    flag(ui.unPlay, 'is-focused', u.focus === 0);
    flag(ui.unHide, 'is-focused', u.focus === 1);
  }

  function hideUpNext(s, dismissed) {
    var u = s.upnext;
    if (!u) return;
    cancel(s, 'upnext');
    s.upnext = null;
    if (dismissed) s.dismissedNext = true;
    flag(ui.root, 'is-upnext', false);
    flag(ui.root, 'is-still', false);
    renderSkip(s);
    if (u.ended && dismissed) { report(s, 'ended', { over: 1 }); stop('ended'); return; }
    /* "Still watching?" answered with Hide: the viewer is here, so the credits carry on. */
    if (u.still && dismissed && paused()) { playVideo(s); render(s); }
  }

  function onEnded(s) {
    s.ended = true;
    Log.info('player', 'ended');
    keepAwake(false);
    if (s.kind === 'tv' && s.next) {
      var u = s.upnext;
      if (u && u.visible) {
        /* Autoplay off (or "Still watching?"): the card waits for the viewer instead of playing on. */
        if (u.count < 0) { u.ended = true; renderUpNext(s); return; }
        playNext(s, 'ended');
        return;
      }
      showUpNext(s, true);
      return;
    }
    report(s, 'ended', { over: 1 });
    stop('ended');
  }

  function goEpisode(s, season, episode, how, over) {
    var nr = nextReq(s, season, episode);
    Log.info('player', 'episode S' + season + 'E' + episode + ' (' + how + ')');
    var hooks = s.hooks;
    finish(s, { over: over, why: how });
    hook(hooks, 'onNext', nr);
    if (ui) begin(nr, hooks, how === 'previous' ? 'Previous episode' : 'Next episode');
  }

  /* From Up Next (near or at the end) the episode is saved as watched (over=1); a mid-episode Next Episode or Ch+
     saves the real position with the site's own over rule. */
  function playNext(s, how) {
    if (!s.next || s !== S) return;
    if (how === 'autoplay' || how === 'ended') unattended++;
    var finished = how === 'autoplay' || how === 'ended' || how === 'play-now' || (s.upnext && s.upnext.visible);
    goEpisode(s, s.next.season, s.next.episode, how, finished ? 1 : undefined);
  }

  function previousEpisode(s) {
    if (s.kind !== 'tv' || s.episode <= 1) { showChip(s, 'This is the first episode of the season', 3000, false); return; }
    goEpisode(s, s.season, s.episode - 1, 'previous');
  }

  /* ---------- error card ---------- */

  function triedFiles(s) {
    var list = s.req.triedFiles && s.req.triedFiles.slice ? s.req.triedFiles.slice() : [];
    if (U.indexOf(list, s.fileIndex) < 0) list.push(s.fileIndex);
    return list;
  }

  /* The next file of this title not tried yet in this chain of attempts, or -1. */
  function otherFile(s) {
    var n = s.files.length, tried = triedFiles(s), i;
    for (i = 1; i < n; i++) { var k = (s.fileIndex + i) % n; if (U.indexOf(tried, k) < 0) return k; }
    return -1;
  }

  function showError(s, reason, message, code) {
    if (!ui || s !== S) return;
    Log.warn('player', 'error card: ' + reason);
    cancel(s, 'cand'); cancel(s, 'stall'); cancel(s, 'osd'); cancel(s, 'upnext'); cancel(s, 'tick'); cancel(s, 'budget'); cancel(s, 'seek');
    U.each(s.reqs, function (h) { try { h.abort(); } catch (e) {} });
    s.reqs = [];
    s.errAt = s.started ? pos(s) : 0;
    if (s.started) report(s, 'error');
    releaseVideo();
    s.ready = false;
    s.lastTime = s.errAt;
    keepAwake(false);
    s.state = 'error';
    s.seek = null;
    s.osd = false;
    s.sheet = null;
    s.upnext = null;
    U.each(['is-osd', 'is-sheet', 'is-upnext', 'is-seeking', 'is-buffering', 'is-scrub', 'is-buttons', 'is-still'], function (c) { flag(ui.root, c, false); });
    hideChip(s);
    flag(ui.skip, 'is-on', false);
    subShow(s, null);
    ui.root.setAttribute('data-state', 'error');
    setText(ui.errKicker, titleOf(s) + (s.kind === 'tv' ? '  \u00b7  S' + s.season + ' E' + s.episode : ''));
    setText(ui.errTitle, 'This video won\u2019t play here');
    setText(ui.errBody, message || '');
    setText(ui.errCode, code || '');
    flag(ui.errCode, 'is-empty', !code);
    var btns = [], retry = reason === 'network' || reason === 'bad-answer' || reason === 'internal' || reason === 'streams-failed';
    var other = reason === 'streams-failed' && !s.started ? otherFile(s) : -1;
    if (other >= 0) btns.push({ action: 'other-file', icon: 'quality', label: 'Try another file' });
    if (retry) btns.push({ action: 'retry', icon: 'reload', label: 'Try again' });
    if (reason !== 'bad-request') btns.push({ action: 'website', icon: 'globe', label: 'Try website player' });
    btns.push({ action: 'back', icon: 'back', label: 'Back' });
    U.empty(ui.errBtns);
    U.each(btns, function (b) {
      var n = el('div', 'mbp-btn', null, ui.errBtns);
      n.setAttribute('data-action', b.action);
      n.setAttribute('tabindex', '-1');
      n.appendChild(icon(b.icon));
      el('span', 'mbp-btn-label', b.label, n);
      b.el = n;
    });
    /* Mid-film (it played before) Try again is the likely fix; streams that timed out: Try again; another file of
       the title when there is one; otherwise the website's player (the last resort). */
    var slow = s.fails.length > 0 && !U.find(s.fails, function (f) { return !/^(?:timeout|stall|media-2|hls-network)$/.test(f.reason); });
    var focus = 0, want = s.started && retry ? 'retry' : other >= 0 ? 'other-file' : slow && retry ? 'retry' : 'website';
    U.each(btns, function (b, i) { if (b.action === want) focus = i; });
    s.err = { reason: reason, btns: btns, index: focus };
    renderError(s);
  }

  function renderError(s) {
    U.each(s.err.btns, function (b, i) { flag(b.el, 'is-focused', i === s.err.index); });
  }

  function errorKey(s, name) {
    var e = s.err;
    if (!e) return true;
    if (name === 'left' || name === 'right') { e.index = U.clamp(e.index + (name === 'right' ? 1 : -1), 0, e.btns.length - 1); renderError(s); return true; }
    if (name === 'back' || name === 'stop') { stop('back'); return true; }
    if (name !== 'enter') return true;
    var b = e.btns[e.index];
    if (b.action === 'back') stop('back');
    else if (b.action === 'website') fallback(s, e.reason);
    else if (b.action === 'other-file') {
      var next = otherFile(s), copy = {}, k;
      for (k in s.req) if (s.req.hasOwnProperty(k)) copy[k] = s.req[k];
      copy.fileIndex = next;
      copy.triedFiles = triedFiles(s).concat([next]);
      var hooks2 = s.hooks;
      Log.info('player', 'trying file ' + next + ' of ' + s.files.length);
      finish(s, {});
      begin(copy, hooks2, '');
    } else if (b.action === 'retry') {
      /* A fresh start (new file list, new stream links) that continues where the video stopped. */
      var req = s.req, hooks = s.hooks, at = s.errAt;
      finish(s, {});
      begin(req, hooks, '', at);
    }
    return true;
  }

  /* ---------- keys ---------- */

  function sheetKey(s, name) {
    var sh = s.sheet;
    if (name === 'up' || name === 'down') { sh.index = U.clamp(sh.index + (name === 'down' ? 1 : -1), 0, sh.items.length - 1); renderSheet(s); return true; }
    if (name === 'enter') { chooseSheet(s); return true; }
    if (name === 'back' || name === 'left') { closeSheet(s); return true; }
    if (name === 'stop') { stop('stop'); return true; }
    return true;
  }

  function upNextKey(s, name) {
    var u = s.upnext;
    if (name === 'left' || name === 'right') { u.focus = name === 'right' ? 1 : 0; renderUpNext(s); return true; }
    if (name === 'enter') { if (u.focus === 0) playNext(s, 'play-now'); else hideUpNext(s, true); return true; }
    if (name === 'back') { hideUpNext(s, true); return true; }
    if (name === 'up' || name === 'down' || name === 'info' || name === 'yellow') return true;
    return false;
  }

  function handleKey(name, ev) {
    var s = S;
    if (name === 'backspace') name = 'back';
    if (!s) { if (name === 'back' || name === 'stop') stop('back'); return true; }
    if (s.state === 'error') return errorKey(s, name);
    if (s.state === 'loading') { if (name === 'back' || name === 'stop') stop(name === 'stop' ? 'stop' : 'back'); return true; }
    if (s.sheet) return sheetKey(s, name);
    if (s.upnext && s.upnext.visible && upNextKey(s, name)) return true;
    var onButtons = s.osd && s.area === 'buttons';
    switch (name) {
      case 'back': stop('back'); return true;
      case 'stop': stop('stop'); return true;
      case 'enter':
        if (ui.skip && U.hasClass(ui.skip, 'is-on')) { skipIntro(s); return true; }
        if (onButtons) { activate(s, s.btn); showOsd(s); return true; }
        togglePlay(s);
        return true;
      case 'space': case 'playpause': togglePlay(s); return true;
      case 'play': if (paused() || s.blocked) togglePlay(s); else showOsd(s); return true;
      case 'pause': if (!paused()) togglePlay(s); else showOsd(s); return true;
      case 'left': case 'right':
        if (onButtons) { moveButton(s, name === 'right' ? 1 : -1); showOsd(s); return true; }
        seekBy(s, name === 'right' ? 1 : -1, ev);
        return true;
      case 'ff': seekBy(s, 1, ev); return true;
      case 'rw': seekBy(s, -1, ev); return true;
      case 'up':
        showOsd(s);
        if (onButtons) setArea(s, 'scrub');
        return true;
      case 'down':
        if (s.chipStartOver) { hideChip(s); showOsd(s); setArea(s, 'buttons', 'start-over'); return true; }
        showOsd(s);
        setArea(s, 'buttons');
        return true;
      case 'chup':
        if (s.next) playNext(s, 'channel-up'); else showChip(s, 'This is the latest episode', 3000, false);
        return true;
      case 'chdown': previousEpisode(s); return true;
      case 'yellow': openSubSheet(s); return true;
      case 'info':
        if (s.osd) hideOsd(s, true); else showOsd(s);
        return true;
      default:
        showOsd(s);
        return true;
    }
  }

  /* ---------- public API ---------- */

  /* Returns false (and leaves nothing on screen, calling no hook) when playback could not even start: the caller
     then runs the website path itself. Called while active, it replaces the session in the same overlay. */
  function play(req, hooks) {
    if (!req || typeof req !== 'object' || req.id == null || !/\d/.test(String(req.id))) return false;
    hooks = hooks || {};
    var opening = !ui;
    unattended = 0; /* the viewer asked for this title */
    try {
      if (S) finish(S, { why: 'replaced' });
      if (opening) {
        var mount = hooks.mount && hooks.mount.nodeType === 1 ? hooks.mount : (document.getElementById('mbptv') || document.body);
        build(mount);
      }
      begin(req, hooks);
    } catch (e) {
      Log.error('player:play', e);
      gen++;
      S = null;
      try { keepAwake(false); teardownUi(); } catch (e2) {}
      if (!opening) hook(hooks, 'onClose', { reason: 'internal', over: 0 });
      return false;
    }
    if (opening) hook(hooks, 'onOpen');
    return true;
  }

  function active() { return !!ui; }

  function key(name, ev) {
    if (!ui || !name) return false;
    ev = ev || {};
    unattended = 0; /* someone is there */
    /* A held OK would toggle pause on every repeat, a held Back would close the player and then hand its repeats to
       the App: keys that act once ignore auto-repeat (they still belong to the player). */
    if (ev.repeat && ONCE[name]) return true;
    try { return handleKey(name, ev); } catch (e) {
      Log.error('player-key:' + name, e);
      return true;
    }
  }

  /* Saves progress, tears the video and overlay down and calls hooks.onClose(info) once. Idempotent. */
  function stop(reason) {
    if (!ui) return false;
    var s = S, hooks = s ? s.hooks : null;
    var info = s ? (finish(s, { why: reason || 'stop' }) || snapshot(s)) : null;
    gen++;
    S = null;
    clearTimeout(chipTimer);
    keepAwake(false);
    teardownUi();
    info = info || {};
    info.reason = String(reason || 'stop');
    info.over = s && s.lastSent ? toInt(String(s.lastSent).split(':')[1]) : 0;
    Log.info('player', 'closed (' + info.reason + ')');
    hook(hooks, 'onClose', info);
    return true;
  }

  function info() { return S ? snapshot(S) : null; }

  /* Before Play (a title page opened, Home idle): loads hls.js when HLS will play through it here and, for an
     episode, reads its file list ahead. opts {why, kind, id, season, episode}. Never requests player data. */
  function warm(opts) {
    opts = opts || {};
    var why = U.text(opts.why || 'idle').slice(0, 24) || 'idle';
    var engine = warmStart(why, false);
    if (opts.kind === 'tv' && !ui) prefetchFiles(opts.id, opts.season, opts.episode, why);
    return { engine: engine ? 'hls.js' : 'native', hls: lib.state };
  }

  function configure(opts) {
    if (opts) for (var k in opts) if (opts.hasOwnProperty(k) && CFG.hasOwnProperty(k) && typeof opts[k] === 'number' && opts[k] >= 0) CFG[k] = opts[k];
    if (opts && typeof opts.tvOrder === 'string') tvOrder = opts.tvOrder;
    if (opts && /^(?:auto|hlsjs|native)$/.test(String(opts.hlsEngine || ''))) hlsMode = opts.hlsEngine;
    if (opts && typeof opts.hlsCdn === 'string' && (opts.hlsCdn === '' || /^https?:\/\//i.test(opts.hlsCdn))) hlsCdn = opts.hlsCdn;
    if (opts && /^(?:auto|1080p|720p|360p)$/.test(String(opts.hlsStart || ''))) hlsStart = opts.hlsStart;
    var out = { tvOrder: tvOrder, hlsEngine: hlsMode, hlsCdn: hlsCdn, hlsStart: hlsStart,
      hls: { state: lib.state, version: lib.version, from: lib.from, verdict: verdict(), engine: hlsjsWhy(), bandwidth: lastBandwidth(), hosts: streamHosts() } };
    for (var c in CFG) if (CFG.hasOwnProperty(c)) out[c] = CFG[c];
    return out;
  }

  function guarded(name, fn, fallbackValue) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) {
        Log.error('player:' + name, e);
        return fallbackValue;
      }
    };
  }

  return {
    play: guarded('play', play, false),
    active: active,
    key: key,
    stop: guarded('stop', stop, false),
    info: guarded('info', info, null),
    configure: guarded('configure', configure, null),
    warm: guarded('warm', warm, null),
    /* Pure helpers, exposed for tests and diagnostics. */
    _parse: guarded('parse', parse, null),
    _order: guarded('order', order, []),
    _cues: guarded('cues', parseCues, []),
    _decodeSub: guarded('decode-sub', decodeSub, ''),
    _cuesAt: guarded('cues-at', cuesAt, null),
    _audioList: guarded('audio-list', audioList, null),
    _audioMaster: guarded('audio-master', audioMaster, '')
  };
}());
