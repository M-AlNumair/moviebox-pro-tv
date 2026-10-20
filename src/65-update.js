/* Update: asks the TizenBrew service (ws://127.0.0.1:8081/mbp-update) whether a newer MovieBox Pro app (the TizenBrew
   app itself) is published and offers it on Home. Nothing is downloaded or installed unless the viewer presses Install.
   Samsung (Tizen) only, never on the LG webOS port. Once per launch (sessionStorage), after Home has been idle for 3 s;
   Later snoozes that version for this launch (24 h if the launch keeps running). Every failure is logged and shows
   nothing; the dialog never traps the viewer for good. */
var Update = (function () {
  var WS_URL = 'ws://127.0.0.1:8081/mbp-update', KEY = 'mbptv:update:v1';
  var IDLE_MS = 3000, TICK_MS = 500, REPLY_MS = 6000, STALL_MS = 90000, INSTALL_STALL_MS = 180000, DAY = 86400000;
  var TITLE = 'MovieBox Pro app update';
  var poll = null, idle = 0, idleKey = null, checking = false, stopped = false;
  var conn = null, stallTimer = null, connectTimer = null;
  /* dlg: {layer, box, mode: 'offer'|'busy'|'result', state, status} while the update dialog is open. */
  var dlg = null;

  function supported() {
    try {
      var ua = String(navigator.userAgent || '');
      if (/Web0S|webOS|NetCast|LG Browser/i.test(ua) || window.PalmSystem || window.webOSSystem) return false;
      return !!window.tizen || /Tizen/i.test(ua);
    } catch (e) { return false; }
  }

  /* sessionStorage: {at: last finished check, later: {version, at}, last: an unshown previous-attempt result, note} */
  function load() {
    var s = Store.session.get(KEY, null);
    return s && typeof s === 'object' ? s : {};
  }
  function save(patch) {
    var s = load();
    for (var k in patch) if (patch.hasOwnProperty(k)) s[k] = patch[k];
    Store.session.set(KEY, s);
  }
  function note(text) { try { save({ note: text }); } catch (e) {} }

  function due() {
    var s = load(), now = U.now();
    if (s.last) return true;
    if (s.later && now - (s.later.at || 0) < DAY) return false;
    return !(s.at && now - s.at < DAY);
  }

  function str(v) { return v == null ? '' : String(v); }
  function sentence(v) { return str(v).replace(/[\s.]+$/, ''); }

  /* ---------- Idle watch on Home ---------- */

  function homeShown() {
    try {
      if (stopped || poll || checking || dlg || !supported() || !due()) return;
      idle = 0;
      idleKey = null;
      poll = setInterval(U.guard(tick, 'update-idle'), TICK_MS);
    } catch (e) { Log.warn('update', e); }
  }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  function showable(st) {
    return st.screen === 'home' && st.mode === 'shell' && !st.layer && !Overlays.startingShown();
  }

  function tick() {
    if (!document.getElementById('mbptv')) { stop(); return; }
    var st = App.state();
    /* Left Home: wait for the next time it is shown. */
    if (st.screen !== 'home' && st.screen !== 'loading') { stopPoll(); return; }
    if (!showable(st) || st.focusKey !== idleKey) { idle = 0; idleKey = st.focusKey; return; }
    idle += TICK_MS;
    if (idle < IDLE_MS) return;
    stopPoll();
    check();
  }

  /* ---------- Socket ---------- */

  /* Opens the channel and sends `first` once connected. onMsg(message) per JSON frame; onEnd(reason) once, when the
     socket closes or cannot be opened (not after close()). */
  function open(first, onMsg, onEnd) {
    var ws = null, ended = false;
    function end(why) { if (!ended) { ended = true; U.guard(onEnd, 'update-end')(why); } }
    var c = {
      opened: false,
      close: function () {
        ended = true;
        try { ws.onopen = null; ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(); } catch (e) {}
      }
    };
    try { ws = new WebSocket(WS_URL); } catch (e) { end('connect: ' + (e && e.message || e)); return null; }
    ws.onopen = U.guard(function () {
      c.opened = true;
      Log.info('update', 'send ' + first.type + (first.payload ? ' ' + first.payload.version : ''));
      ws.send(JSON.stringify(first));
    }, 'update-open');
    ws.onmessage = U.guard(function (ev) {
      var m = U.parseJSON(str(ev && ev.data));
      if (!m || typeof m !== 'object' || !m.type) { Log.warn('update', 'unreadable message'); return; }
      onMsg(m, m.payload && typeof m.payload === 'object' ? m.payload : {});
    }, 'update-message');
    ws.onerror = function () {};
    ws.onclose = U.guard(function (ev) { end('closed' + (ev && ev.code ? ' (' + ev.code + ')' : '') + (c.opened ? '' : ' before connecting')); }, 'update-close');
    return c;
  }

  function drop() {
    if (conn) { conn.close(); conn = null; }
    clearTimeout(stallTimer); stallTimer = null;
    clearTimeout(connectTimer); connectTimer = null;
  }

  /* ---------- Check ---------- */

  function check() {
    if (checking || dlg) return;
    checking = true;
    var finished = false, timer = null, c = null;
    function finish(p, err) {
      if (finished) return;
      finished = true;
      checking = false;
      clearTimeout(timer);
      if (err) {
        if (c) c.close();
        Log.warn('update', 'check failed: ' + err);
        note('Check failed: ' + err);
        save({ at: U.now() });
        return;
      }
      try { handle(p, c); } catch (e) { if (c) c.close(); Log.warn('update', e); }
    }
    try {
      timer = U.later(function () { finish(null, 'no reply in ' + (REPLY_MS / 1000) + ' s'); }, REPLY_MS, 'update-timeout');
      c = open({ type: 'CheckAppUpdate' }, function (m, p) {
        if (m.type === 'CheckAppUpdate' && !finished) finish(p, null);
        else if (c && c.onMsg) c.onMsg(m, p);
      }, function (why) { finish(null, why); });
    } catch (e) { finish(null, str(e && e.message || e)); }
  }

  function summary(p) {
    var b = p.busy, l = p.last;
    return (p.ok === false ? 'error "' + str(p.error) + '"' : 'ok') + ' installed ' + str(p.installed) + ' running ' + str(p.running) +
      ' latest ' + str(p.latest) + ' available ' + !!p.available + (b ? ' busy ' + str(b.state) + ' ' + str(b.version) : '') +
      (l ? ' last ' + str(l.status) + ' ' + str(l.version) : '');
  }

  function handle(p, c) {
    Log.info('update', 'reply ' + summary(p));
    if (p.last && typeof p.last === 'object') save({ last: p.last });
    /* The viewer moved on while the reply was on its way: ask again the next time Home is idle. */
    if (!showable(App.state())) {
      if (c) c.close();
      Log.info('update', 'not on Home any more; checking again later');
      homeShown();
      return;
    }
    var s = load(), last = s.last;
    save({ at: U.now(), last: null });
    note(p.ok === false ? 'Check failed: ' + str(p.error) : p.available ? 'Version ' + str(p.latest) + ' available (installed ' + str(p.installed) + ')' : 'Up to date (' + str(p.installed) + ')');
    if (last && last.status === 'updated') App.toast('MovieBox Pro app updated to ' + str(last.version));
    if (last && last.status === 'failed') {
      if (c) c.close();
      lastFailed(last, p.installed);
      return;
    }
    if (p.ok !== false && p.busy && typeof p.busy === 'object') {
      conn = c;
      watch(c);
      busy(p.busy);
      return;
    }
    if (c) c.close();
    if (p.ok === false || !p.available) return;
    var later = s.later;
    if (later && later.version === p.latest && U.now() - (later.at || 0) < DAY) { Log.info('update', 'snoozed ' + str(p.latest)); return; }
    offer(p);
  }

  /* ---------- Dialog ---------- */

  /* spec: {mode, lines: [[cls, text]], buttons: [{label, action, icon, primary, run, focus}]} */
  function render(spec) {
    var fresh = !dlg || !dlg.layer.parentNode;
    if (fresh) {
      var layer = U.el('div', 'mb-layer mb-layer--dialog');
      U.el('div', 'mb-layer-dim', null, layer);
      var box = U.el('div', 'mb-dialog mb-update', null, layer);
      box.setAttribute('data-dialog', 'update');
      dlg = { layer: layer, box: box };
    }
    dlg.mode = spec.mode;
    dlg.status = null;
    var b = U.empty(dlg.box);
    U.el('div', 'mb-h1', TITLE, b);
    var target = null;
    U.each(spec.lines, function (l) {
      var n = U.el('div', l[0], l[1], b);
      if (l[2]) dlg.status = n;
    });
    if (spec.buttons && spec.buttons.length) {
      var btns = Kit.zone(U.el('div', 'mb-btns', null, b), 'dialog');
      U.each(spec.buttons, function (d) {
        var n = Kit.button({ label: d.label, icon: d.icon, action: d.action, primary: d.primary, parent: btns, key: 'dlg|' + d.action });
        n.__run = U.guard(d.run, 'update-' + d.action);
        if (d.focus || !target) target = n;
      });
    } else {
      /* No buttons while busy: focus rests on the status line, so OK can never reach the screen underneath. */
      target = Kit.focusable(dlg.status || b.lastChild, 'dlg|update-status');
    }
    if (fresh) App.openLayer('dialog', dlg.layer, { focus: target, name: 'update', onBack: U.guard(onBack, 'update-back'), onClose: onClosed });
    else App.focus(target);
  }

  function onBack() {
    if (!dlg) return;
    if (dlg.mode === 'offer') { later(); return; }
    if (dlg.mode === 'busy') { Log.info('update', 'Back ignored while busy'); return; }
    close();
  }

  function onClosed() { dlg = null; drop(); }

  function close() { if (dlg) App.closeLayer('dialog'); }

  function offer(p) {
    Log.info('update', 'offer ' + str(p.latest));
    var lines = [['mb-body', 'Version ' + str(p.latest) + ' is available. You have ' + str(p.installed) + '.']];
    if (p.notes) lines.push(['mb-body mb-clamp3 mb-update-notes', str(p.notes)]);
    lines.push(['mb-body mb-update-hint', 'The app closes while it installs. Open it again afterwards.']);
    render({ mode: 'offer', lines: lines, buttons: [
      { label: 'Install', action: 'update-install', run: function () { install(p); } },
      { label: 'Later', action: 'update-later', primary: true, focus: true, run: later }
    ] });
    dlg.version = str(p.latest);
  }

  function later() {
    Log.info('update', 'user chose Later');
    save({ later: { version: dlg && dlg.version || '', at: U.now() } });
    close();
  }

  function lastFailed(last, installed) {
    Log.info('update', 'previous attempt failed: ' + str(last.version) + ' ' + str(last.message));
    var lines = [['mb-body', 'The app update to ' + str(last.version) + ' didn’t install. Your app is unchanged (' + str(installed || last.from) + ').']];
    if (last.message) lines.push(['mb-body mb-clamp3 mb-update-notes', str(last.message)]);
    render({ mode: 'result', lines: lines, buttons: [{ label: 'OK', action: 'update-ok', primary: true, run: close }] });
  }

  /* ---------- Install and progress ---------- */

  function statusText(b) {
    var st = str(b && b.state);
    if (st === 'verifying') return 'Checking the download…';
    if (st === 'installing') return 'Installing… MovieBox Pro will close; open it again afterwards.';
    var r = +(b && b.received) || 0, t = +(b && b.total) || 0;
    return 'Downloading…' + (t > 0 ? ' ' + Math.min(100, Math.floor(r * 100 / t)) + '%' : '');
  }

  function busy(b) {
    var st = str(b && b.state) || 'downloading';
    if (!dlg || dlg.mode !== 'busy') {
      Log.info('update', 'status ' + st + ' ' + str(b && b.version));
      render({ mode: 'busy', lines: [['mb-body mb-update-status', statusText(b), true]] });
    } else {
      if (dlg.state !== st) Log.info('update', 'status ' + st + ' ' + str(b && b.version));
      if (dlg.status) dlg.status.textContent = statusText(b);
    }
    dlg.state = st;
    stall();
  }

  /* Downloading or verifying with no word for 90 s fails; installing waits longer (the TV closes the app), then
     offers OK so the dialog never stays up for good. */
  function stall() {
    clearTimeout(stallTimer);
    var installing = dlg && dlg.state === 'installing';
    stallTimer = U.later(function () {
      if (!dlg || dlg.mode !== 'busy') return;
      if (dlg.state === 'installing') {
        Log.warn('update', 'no result after installing');
        render({ mode: 'result', lines: [['mb-body', statusText({ state: 'installing' })]], buttons: [{ label: 'OK', action: 'update-ok', primary: true, run: close }] });
        return;
      }
      Log.warn('update', 'no response for ' + (STALL_MS / 1000) + ' s');
      note('Install failed: no response');
      drop();
      render({ mode: 'result', lines: [['mb-body', 'No response from the TizenBrew service.']], buttons: [{ label: 'OK', action: 'update-ok', primary: true, run: close }] });
    }, installing ? INSTALL_STALL_MS : STALL_MS, 'update-stall');
  }

  function watch(c) { if (c) c.onMsg = onInstallMsg; }

  function onInstallMsg(m, p) {
    if (m.type === 'AppUpdateStatus') { busy(p); return; }
    if (m.type === 'InstallAppUpdate') result(p);
  }

  function result(p) {
    drop();
    if (p.ok) {
      Log.info('update', 'installed ' + str(p.version));
      note('Updated to ' + str(p.version) + ' (restart needed)');
      render({ mode: 'result', lines: [['mb-body', 'Updated to ' + str(p.version) + '. Close MovieBox Pro and open it again to finish.']], buttons: [
        { label: 'Close app', icon: 'power', action: 'update-close-app', run: function () { Log.info('update', 'user chose Close app'); App.exitApp(); } },
        { label: 'OK', action: 'update-ok', primary: true, focus: true, run: close }
      ] });
      return;
    }
    Log.warn('update', 'install failed at ' + str(p.stage) + ': ' + str(p.error));
    note('Install failed: ' + str(p.error));
    fail(sentence(p.error) || 'unknown error');
  }

  function fail(why) {
    drop();
    render({ mode: 'result', lines: [['mb-body', 'Update failed: ' + why + '. Your current app is unchanged.']], buttons: [{ label: 'OK', action: 'update-ok', primary: true, run: close }] });
  }

  function install(p) {
    Log.info('update', 'user chose Install ' + str(p.latest));
    drop();
    busy({ state: 'downloading', version: p.latest });
    var heard = false, c = null;
    c = open({ type: 'InstallAppUpdate', payload: { version: str(p.latest), sha256: str(p.sha256) } }, function (m, q) {
      heard = true;
      clearTimeout(connectTimer);
      if (c && c.onMsg) c.onMsg(m, q);
    }, function (why) {
      if (conn !== c) return;
      conn = null;
      /* Installing: the TV closes the whole app, so a closed socket is expected; keep the installing text. Otherwise
         a socket that never answered failed to start anything; one that did answer is covered by the stall timer. */
      if (!heard && dlg && dlg.mode === 'busy' && dlg.state === 'downloading') {
        Log.warn('update', 'install connection ' + why);
        note('Install failed: ' + why);
        fail('couldn’t reach the TizenBrew service');
        return;
      }
      Log.info('update', 'connection ' + why + (dlg ? ' while ' + str(dlg.state) : ''));
    });
    if (!c) return;
    conn = c;
    watch(c);
    connectTimer = U.later(function () {
      if (conn !== c || heard) return;
      Log.warn('update', 'install: no reply in ' + (REPLY_MS / 1000) + ' s');
      note('Install failed: no reply');
      fail('couldn’t reach the TizenBrew service');
    }, REPLY_MS, 'update-connect');
  }

  function stop() {
    stopped = true;
    stopPoll();
    drop();
  }

  return {
    homeShown: homeShown, stop: stop, supported: supported,
    /* One line for Diagnostics: the outcome of the last check or install this launch. */
    summary: function () {
      if (!supported()) return 'Samsung TizenBrew only';
      var n = load().note;
      return n ? str(n) : checking ? 'Checking…' : 'Not checked yet';
    }
  };
}());
