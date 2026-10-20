/* A stand-in for hls.js, served by the mock site (tools/mock-extra.cjs) at the site's own hls.js address
   (/static/videojs/hls.min.js) and at /__cdn/hls.min.js (the CDN copy in tests). It has the hls.js API surface the
   player uses (Events, ErrorTypes, levels, audioTracks/audioTrack, startLevel, autoLevelCapping, recoverMediaError,
   startLoad/stopLoad, destroy) and "plays" an HLS master by reading it (XHR, no credentials) and handing the media
   address named in its #MOCK-MEDIA line to the <video> element, the way MSE would feed it. Test hooks live on
   window.__hlsMock: instances, loads (which copy loaded), fatal(type, details), and stuckAudio (no switch event). */
(function () {
  'use strict';
  var from = window.__hlsMockFrom || 'site';
  var mock = window.__hlsMock = window.__hlsMock || { instances: [], loads: [], stuckAudio: false };
  mock.loads.push(from);
  var E = {
    MEDIA_ATTACHING: 'hlsMediaAttaching', MEDIA_ATTACHED: 'hlsMediaAttached', MEDIA_DETACHED: 'hlsMediaDetached',
    MANIFEST_LOADING: 'hlsManifestLoading', MANIFEST_LOADED: 'hlsManifestLoaded', MANIFEST_PARSED: 'hlsManifestParsed',
    LEVEL_SWITCHED: 'hlsLevelSwitched', LEVEL_LOADED: 'hlsLevelLoaded', AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
    AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched', FRAG_LOADED: 'hlsFragLoaded', FRAG_BUFFERED: 'hlsFragBuffered',
    ERROR: 'hlsError', DESTROYING: 'hlsDestroying'
  };
  var T = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError', KEY_SYSTEM_ERROR: 'keySystemError', MUX_ERROR: 'muxError', OTHER_ERROR: 'otherError' };

  function attrs(line) {
    var out = {}, re = /([A-Z0-9\-]+)=("[^"]*"|[^,]*)/g, m;
    while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, '');
    return out;
  }

  function parse(text, base) {
    var lines = String(text).split(/\r?\n/), levels = [], audio = [], media = '', i;
    for (i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^#EXT-X-MEDIA:/.test(l)) {
        var a = attrs(l.slice(13));
        if (a.TYPE === 'AUDIO') audio.push({ id: audio.length, groupId: a['GROUP-ID'], lang: a.LANGUAGE || '', name: a.NAME || '', default: a.DEFAULT === 'YES' });
      } else if (/^#EXT-X-STREAM-INF:/.test(l)) {
        var b = attrs(l.slice(18)), res = String(b.RESOLUTION || '0x0').split('x');
        levels.push({ bitrate: +b.BANDWIDTH || 0, width: +res[0] || 0, height: +res[1] || 0, videoCodec: String(b.CODECS || '').split(',')[0], attrs: b });
      } else if (/^#MOCK-MEDIA:/.test(l)) media = new URL(l.slice(12), base).href;
    }
    levels.sort(function (x, y) { return x.bitrate - y.bitrate; });
    return { levels: levels, audio: audio, media: media };
  }

  function Hls(config) {
    this.config = Object.assign({ startPosition: -1 }, config || {});
    this.handlers = {};
    this.levels = [];
    this.audioTracks = [];
    this._audio = -1;
    this._level = -1;
    this.startLevel = -1;
    this.autoLevelCapping = -1;
    this.log = [];
    this.destroyed = false;
    this.from = from;
    this.media = null;
    mock.instances.push(this);
  }
  Hls.version = '1.4.0-mock';
  Hls.isSupported = function () { return !!window.MediaSource; };
  Hls.Events = E;
  Hls.ErrorTypes = T;
  Hls.ErrorDetails = { MANIFEST_LOAD_ERROR: 'manifestLoadError', FRAG_LOAD_ERROR: 'fragLoadError', BUFFER_APPEND_ERROR: 'bufferAppendError' };

  Hls.prototype.on = function (evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); };
  Hls.prototype.off = function (evt, fn) { var l = this.handlers[evt] || []; var i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  Hls.prototype.trigger = function (evt, data) {
    if (this.destroyed) return;
    var self = this;
    (this.handlers[evt] || []).slice().forEach(function (fn) { fn(evt, data || {}); });
    self.log.push(evt);
  };

  Object.defineProperty(Hls.prototype, 'audioTrack', {
    get: function () { return this._audio; },
    set: function (i) {
      if (!(i >= 0 && i < this.audioTracks.length)) return;
      var self = this;
      this._audio = i;
      this.log.push('audioTrack=' + i + (this.media && this.media.readyState > 0 ? '' : ' (before playback)'));
      if (mock.stuckAudio) return;
      setTimeout(function () { self.trigger(E.AUDIO_TRACK_SWITCHED, { id: i }); }, 150);
    }
  });
  Object.defineProperty(Hls.prototype, 'currentLevel', {
    get: function () { return this._level; },
    set: function (i) { this._level = i; this.trigger(E.LEVEL_SWITCHED, { level: i }); }
  });

  Hls.prototype.attachMedia = function (media) {
    var self = this;
    this.media = media;
    this.log.push('attach');
    setTimeout(function () { self.trigger(E.MEDIA_ATTACHED, { media: media }); }, 0);
  };

  Hls.prototype.fail = function (type, details, code) {
    this.trigger(E.ERROR, { type: type, details: details, fatal: true, response: code ? { code: code } : undefined });
  };

  Hls.prototype.loadSource = function (url) {
    var self = this, xhr = new XMLHttpRequest();
    this.url = url;
    this.log.push('load');
    xhr.open('GET', url, true);
    xhr.onload = function () {
      if (self.destroyed) return;
      if (xhr.status < 200 || xhr.status >= 300 || !/^#EXTM3U/.test(xhr.responseText)) { self.fail(T.NETWORK_ERROR, 'manifestLoadError', xhr.status); return; }
      var p = parse(xhr.responseText, url);
      self.levels = p.levels;
      self.audioTracks = p.audio;
      self.mediaUrl = p.media;
      self.feed(self.config.startPosition);
      self.trigger(E.MANIFEST_LOADED, { levels: p.levels, audioTracks: p.audio });
      self.trigger(E.MANIFEST_PARSED, { levels: p.levels, audioTracks: p.audio, firstLevel: 0 });
      self.startLoad(self.config.startPosition);
    };
    xhr.onerror = function () { if (!self.destroyed) self.fail(T.NETWORK_ERROR, 'manifestLoadError', 0); };
    xhr.send();
  };

  /* Like MSE attached to the element: the media source is in place before MANIFEST_PARSED (a play() call made then
     waits for data); playback begins at the start position. */
  Hls.prototype.feed = function (pos) {
    var self = this, media = this.media;
    if (!media || !this.mediaUrl) return;
    media.addEventListener('loadedmetadata', function once() {
      media.removeEventListener('loadedmetadata', once);
      if (self.destroyed) return;
      if (pos > 0) media.currentTime = pos;
      self.currentLevel = self.level;
      self.trigger(E.FRAG_LOADED, {});
      self.trigger(E.FRAG_BUFFERED, {});
    });
    media.src = this.mediaUrl;
  };

  Hls.prototype.startLoad = function (pos) {
    this.log.push('startLoad ' + (pos > 0 ? Math.round(pos) : pos));
    if (!this.media || this.loading || !this.mediaUrl) return;
    this.loading = true;
    var top = this.levels.length - 1;
    if (this.autoLevelCapping >= 0) top = Math.min(top, this.autoLevelCapping);
    this.level = this.startLevel >= 0 ? this.startLevel : top;
    this.trigger(E.LEVEL_LOADED, { level: this.level });
    if (this._audio < 0 && this.audioTracks.length) {
      var def = 0;
      this.audioTracks.forEach(function (t, i) { if (t.default && !def) def = i; });
      this._audio = def;
    }
    this.trigger(E.AUDIO_TRACKS_UPDATED, { audioTracks: this.audioTracks });
  };

  Hls.prototype.stopLoad = function () { this.log.push('stopLoad'); this.loading = false; };

  Hls.prototype.recoverMediaError = function () {
    var media = this.media, t = media ? media.currentTime : 0;
    this.log.push('recoverMediaError');
    if (!media) return;
    media.addEventListener('loadedmetadata', function once() { media.removeEventListener('loadedmetadata', once); if (t > 0) media.currentTime = t; });
    media.src = this.mediaUrl;
    media.play().catch(function () {});
  };

  Hls.prototype.swapAudioCodec = function () { this.log.push('swapAudioCodec'); };

  Hls.prototype.destroy = function () {
    this.log.push('destroy');
    var media = this.media;
    this.destroyed = true;
    this.handlers = {};
    this.media = null;
    if (media) { media.removeAttribute('src'); media.load(); }
  };

  /* Test hook: a fatal error on the newest live instance. */
  mock.fatal = function (type, details, code) {
    var live = mock.instances.filter(function (h) { return !h.destroyed; });
    if (live.length) live[live.length - 1].fail(type, details, code);
    return live.length;
  };
  mock.summary = function () {
    return mock.instances.map(function (h) {
      return { from: h.from, destroyed: h.destroyed, startPosition: h.config.startPosition, startLevel: h.startLevel, cap: h.autoLevelCapping,
        audio: h._audio, levels: h.levels.length, log: h.log.filter(function (x) { return !/^hls/.test(x); }) };
    });
  };

  window.Hls = Hls;
}());
