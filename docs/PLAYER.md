# Native player (0.3.1; subtitles added after 0.3.1)

## Why

The website's own playback path failed on the user's Samsung TV ("The website didn't start playback").

- **Old TVs:** the site's main title-page inline script (60–135 KB, holding the Play handler, `if (play)` auto-play and `init_player`) declares `let` variables in sloppy mode. Chromium < 49 (Tizen 3.0, 2017 TVs) rejects the whole script, so the Play button does nothing.
- **Newer TVs:** the page must first download and run jQuery, JW Player (261 KB), video.js (545 KB, which uses optional chaining and so throws on Chromium < 80) and hls.js (364 KB). That easily exceeds our old 10-second wait, and the flow depends on the site's page scripts.

So 0.3.1 plays video itself, in its own full-screen `<video>`, using the same endpoints the site's player uses. The website player stays as a fallback.

## Real endpoints (verified 2026-09-24 on the live site, signed in)

1. **Files for a movie:** the movie page `/movie/ID` has `.sidebarbg2 ul li.play[oss_download_url="/index/index/player?mfid=N"]`, one per file. The file name is in the `span`, and quality comes from `img[src*=ic_choose_(4k|fullhd|hd|sd|org)]`, plus size and date. There can be several (for example a 1080p WEBRip at 6.71 GB and a 2160p HDR at 14.47 GB).
2. **Files for an episode:** `POST /index/index/tv_file`, form-encoded `tid=ID&season=S&episode=E`, with header `X-Requested-With: XMLHttpRequest`. It returns `{"code":1,"msg":"success","data":{"list":"<li class=\"play\" oss_download_url=\"/index/index/player?tfid=N\" ...>...</li>"}}`. On failure it returns `code != 1` and a `msg`. Fixture: `test/fixtures/tv_file.json`.
3. **Player data:** `POST <oss_download_url>&jwplayer=1`, same header, empty body. It returns about 200 KB of HTML/JS (the site injects it into `#player_box`). A negative code comes back as JSON `{"code":-1,"msg":"..."}` (for example VIP-only or not ready). Fixtures: `test/fixtures/player-tv.txt`, `test/fixtures/player-movie.txt`. Parse with regexes, never eval:
   - `var sources = [ ... ];` is a JSON array. Use the **first occurrence that is not on a `//` comment line**; a second, commented-out `//var sources = ...` follows it. Items: `{type: 'video/mp4' | 'application/x-mpegURL', file, label: 'ORG' | 'AUTO' | '1080p' | '720p' | '360p', mp4_id, h265: 0|1, width, height, bitstream, size, hdr, fps}`.
     - `ORG` is the original MP4 (it can be HEVC or 4K HDR; see `h265`/`hdr`).
     - `AUTO` is adaptive HLS. The fixed HLS labels are H.264 transcodes.
   - Also parse:
     - `var seconds = N;` — the resume position in seconds.
     - `var mp4_id = N;`
     - `var next_season = 'S';` and `var next_episode = 'E';` — empty strings when there is no next episode.
     - `var tid = N; var current_season = S; var current_episode = E;` — TV only.
     - `var skips = '{json}';` — `{start, end, ...}`, where `-1` means unknown. Treat `start > 0` as "intro ends at start" and `end > 0` as "credits begin at end".
     - `var post = {json};` — the progress payload base, for example `{"type":"tv","tid":17417,"season":1,"episode":1}` or `{"type":"movie","mid":1831}`.
     - `url : "/index/index/(tv|movie)_progress"` — the progress endpoint.
   - **TV audio fix:** on Samsung/LG TVs the site appends `audio=aac` to every HLS URL, because EAC3 audio stalls in native HLS. Do the same when `Platform.isTV`, or when `MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')` is false. This stays so with hls.js on a TV (see "HLS engine"): the site's own TV player is hls.js with `audio=aac` too, and the AAC-only master keeps one audio group, so the audio languages are simple to switch.
4. **Progress:** `POST /index/index/tv_progress` (TV) or `/index/index/movie_progress` (movie), form-encoded as the `post` object plus `over` (`runtime - time < 300 ? 1 : 0`), `seconds` (integer current time) and `mp4_id`, with header `X-Requested-With: XMLHttpRequest`. The site sends it periodically and on stop. Skip it when the time hasn't changed, when duration is unknown, or when playback never started. This keeps Continue Watching and the site's resume points in sync.
5. **Stream behaviour:**
   - **Desktop Chromium:** the ORG MP4 (H.264) plays directly in `<video>`; first frame arrived in about 3.5 s. Native HLS reports `canPlayType('application/vnd.apple.mpegurl') === 'maybe'`, but the AUTO m3u8 failed with `MEDIA_ERR_SRC_NOT_SUPPORTED` (4).
   - **Samsung TVs up to Tizen 8:** they play HLS natively in `<video>` through the platform player.
   - **Samsung Tizen 9** (UA70CU7000 after its 2026 update; `Mozilla/5.0 (SMART-TV; LINUX; Tizen 9.0) AppleWebKit/537.36 (KHTML, like Gecko) 120.0.6099.5/9.0 TV Safari/537.36`, Chromium 120, measured 2026-10-20 in TizenBrew): every HLS address set as `<video>.src` fails at once with media error 4 (`MEDIA_ERR_SRC_NOT_SUPPORTED`), but Media Source Extensions work, so HLS plays through hls.js (see "HLS engine"). The website's own JW Player does the same on such browsers (JW Player 8.26.4 bundles hls.js 1.2.1 in `/static/js/jwplayer4/provider.hlsjs.js`).
   - Stream URLs carry signed, time-limited, account- and IP-bound tokens: **never log or persist them**.

6. **Subtitles** (verified 2026-10-20 on the LG TV, signed in; live capture of a movie's player data). The player-data answer also carries the website's subtitle panel, as HTML inside a JS string (`$(".jw-wrapper").prepend('<div class="subtitle_con">…')`):
   - Languages, in the site's order: `<div class="subtitle"><div class="left2"><div class="list_scroll"><p data-val="English" class="active3">English</p>…`.
   - Per language a list `<ul id="English">` (the `id` is the `data-val`; uploads appear as `MySubtitles`, "My Subtitles") of `<li data-id="1" data-sid="1488997" data-delay="0" sid_org="0" data-lang="en" data-url="https://images.chuaxin.com/movie_box/movie/srt/…/….en-NNN.srt" data-name="[en]….srt"><p>file name</p><p class="desc">Oct 17, 2026 · </p>…like count…</li>`.
   - The panel ends where `<div class="subtitle_search_con">` starts. The same response also holds the site's JS templates for uploaded subtitles (`data-url="'+data.data.srt_info.file_path+'"`); those are not lists.
   - **Delay:** the site shows the cue at `player.getPosition() + parseInt(data-delay)`: seconds, added to the playback time (a positive delay shows subtitles earlier). Its own delay buttons step ±0.5 s and save with `POST /index/index/set_srt_delay {sid, delay, type}`; we read the value with `parseFloat` (the site's `parseInt` drops the half seconds).
   - **Loading:** the site fetches the file through its own same-origin proxy `GET /index/index/get_srt_content?srt_path=<encodeURIComponent(data-url)>` (text) and parses it itself (split on blank lines + cue numbers, `HH:MM:SS,mmm --> …`, `<font>` turned into `<span>`, binary search by time). On the LG TV a direct XHR to `images.chuaxin.com` also works (200, `application/octet-stream`, no CORS header: the LG app may read cross-site). Files can be in legacy encodings (Arabic windows-1256).
   - The site posts `POST /index/index/subtitle_select {sid, mid}` (and `type: 'del'` for off) when the viewer picks a file; we do not (nothing we show depends on it).
   - **Translate** (not implemented): the panel's translate button posts `POST /index/index/srt_preview {url, lang, sid}` (answer `{code: 1, data: {html}}`, a preview) and opens `.subtitle_translate_con` with a target list `.lang_list2 p[data-lang]` (Arabic is `ar`). The request that actually translates is not in the player-data script (it sets `srt_file2`, `data-newsid` and `data-newurl` elsewhere, presumably in the title page's script or `/static/js/index.js`); confirming then reloads the list with `GET /index/index/subtitle_list?mfid=N` (`{code: 1, html, html2}`: new language list and lists) and selects the new `sid`. Other subtitle endpoints in the script: `srt_encoding` (re-encode an upload), `upload_srt`, `subtitle_del`, `opensubtitles`, `subtitle_download`.
   - Episodes: the old TV fixture (`test/fixtures/player-tv.txt`) has the subtitle code trimmed; the parser reads the same panel from episode answers and finds nothing when it is absent.

7. **Streams on the live site** (verified 2026-10-20 with a signed-in session and the Samsung Tizen 7 user agent, 25 files: 12 movies and 10 shows, old and new, 4K/HDR remuxes, anime, Netflix originals; every candidate answered: HLS 200, originals 206):
   - Every file has the same five or six sources: `ORG`, `AUTO`, `1080p`, `720p`, `360p`, plus **`4K`** (HLS, `h265: 1`, `hdr: 1`) for 4K files. `AUTO` and the fixed labels are the same HLS address (`hls.shegu.net/<id>.m3u8`); a fixed label adds `quality=1080p` and that master lists only that rendition. The player data's `m3u8_url` is always the `AUTO` address.
   - HLS is **fMP4/CMAF** (`#EXT-X-MAP`, `.m4s` segments, ~10 s targets, `#EXT-X-ENDLIST`) with **separate audio renditions**: `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_aac",LANGUAGE="ko",NAME="KOR (5.1)",DEFAULT=YES,CHANNELS="2",URI=...`, one per audio track of the original. Video is H.264 Main (`avc1.4d40xx`, up to level 5.0 for 2580×1080) at about 3.3/1.7/0.66 Mbit/s; the 4K rendition is HEVC Main10 PQ (`hev1|hvc1.2.4.L150|L180`) at about 9 Mbit/s and comes **first** in `AUTO`. Without `audio=aac` the master also lists an `audio_ec3` group (6-channel EAC3) and doubles the variants; `audio=aac` removes it. The server knows no per-language parameter (tried `lang`, `audio_lang`, `audio=ko`, `track`…: same master).
   - Master and media playlists answer `Access-Control-Allow-Origin: *` (scripts may read them without credentials); segments come from `hls-aws.shegu.net` without CORS headers.
   - Several audio renditions: 11 of 25 files (Dark: de, en, de 5.1, en; Demon Slayer: ja, fr; Squid Game: en, ko; Attack on Titan: en, ja; All Quiet on the Western Front: de, en; Parasite 4K remux: ko, it; others one language twice). The `DEFAULT` is often the dub (Squid Game and All Quiet default to English).
   - `ORG` (type `video/mp4` whatever the file) is either an MP4 the site converted (H.264 or HEVC with AAC, often several AAC tracks) or the original **Matroska** (`.mkv`, `application/octet-stream`) with EAC3, AC3, AAC, **DTS** (Oppenheimer 4K remux) or **TrueHD** (+AC3: The Godfather 4K). Remuxes run at 60–90 Mbit/s (Parasite 4K 77.5 GB, Oppenheimer 82 GB). Samsung and LG TVs do not decode DTS or TrueHD.
   - The site's own player on Samsung (`isSamsungTV2()`: `smart-tv`, `tizen`, `tv safari`… in the UA) and LG is JW Player with **only** `m3u8_url` (AUTO + `audio=aac`); JW reads the renditions and audio tracks from the master itself. A source whose file ends in `/video/vip_only.mp4` is the site's placeholder for accounts without VIP.

Loading `/movie/ID` or `/tvshow/ID` pages records nothing. Calling the player endpoint and posting progress are exactly what the site does when the user presses Play; that is expected.

## Contract: `src/55-player.js` defines `var NativePlayer` (plus private helpers inside its IIFE) and `src/player.css`

```js
NativePlayer.play(req, hooks)
// req:   {kind: 'movie' | 'tv', id, season, episode, title, showTitle, episodeTitle, backdrop, poster,
//         fileIndex /* optional movie file choice */, fileUrl /* optional oss_download_url */,
//         autoplayNext /* optional; false = the Up Next card has no countdown and waits for the viewer */}
//         season/episode: a missing or invalid value means 1; episode 0 (a special such as S01E00) only when passed as 0
// hooks: {mount: HTMLElement /* #mbptv root */, onOpen(), onClose(info), onFallback(req, reason),
//         onProgress(info), onNext(nextReq)}
// Returns true when the overlay is up (loading has begun), false when it could not start at all (no usable id,
// or an internal failure while building): then nothing is on screen, no hook was called, and the caller runs the
// website path itself. Called while active, it replaces the session in the same overlay (no onOpen/onClose).
NativePlayer.active()          // true while the player overlay is up (loading, playing, error or up-next)
NativePlayer.key(name, event)  // name from Keys.name(event); returns true for every key while active (the player
                               // owns the remote), false when not active. Auto-repeats (event.repeat) of keys that
                               // act once (OK, Back, Backspace, Stop, Play, Pause, Play/Pause, Space, Ch+/-, Info,
                               // Yellow)
                               // are swallowed; arrows and FF/RW keep repeating (seek, sheet)
NativePlayer.stop(reason)      // saves progress, tears down the video and overlay, calls hooks.onClose(info) once;
                               // returns true, or false when nothing was open (idempotent)
NativePlayer.info()            // {kind, id, season, episode, time, duration, paused, stream: 'hls' | 'mp4', label,
                               //  engine: 'native' | 'hls.js', level (hls.js: the rendition playing, '1080p'; else ''),
                               //  state: 'loading' | 'playing' | 'error', started, file, subtitle, audio} or null when
                               // not active; subtitle = the language showing ('English', 'English · 2'; '' = off or not
                               // loaded yet); audio = the audio track playing when the title offers a choice
                               // ('Japanese'; '' otherwise); for diagnostics, never URLs
NativePlayer.configure(opts)   // test/diagnostic tuning of the timings below, plus tvOrder, hlsEngine ('auto' | 'hlsjs' |
                               //  'native'), hlsCdn (the CDN copy's address; '' = none) and hlsStart ('auto' | '1080p' |
                               //  '720p' | '360p': the most hls.js starts on); returns the current values and hls: {state,
                               //  version, from, verdict, engine (why HLS goes to hls.js here; '' = the platform player
                               //  first), bandwidth (the last measured, bits/s; 0 = none), hosts (stream host names)}
NativePlayer.warm(opts)        // before Play (see "Fast start"): opts {why, kind, id, season, episode}; loads hls.js where HLS
                               //  plays through it and, for an episode (kind 'tv'), reads its file list ahead. Never
                               //  requests player data. Returns {engine: 'hls.js' | 'native', hls: lib state}
NativePlayer._parse(text)      // pure: player-endpoint text -> {code, msg, gate, sources, seconds, mp4Id, next,
                               //  tid, season, episode, skips, post, progressUrl, subtitles, ok}; subtitles =
                               //  [{name, key, code, files: [{url, sid, lang, delay, name}]}] in the site's order
NativePlayer._order(sources, env) // pure: env {tv, aac, canPlay(mime), prefer, fileName, fileSize} -> candidates in try
                               //  order ({label, src, hls, h265, hdr, width, height, fps, kind: 'hls'|'mp4'|'mkv'|'risky'})
NativePlayer._audioList(m3u8)  // pure: HLS master -> {group, list: [{code, lang, name, def, channels}], def}
NativePlayer._audioMaster(m3u8, base, group, index) // pure: the master with only that audio rendition, absolute URIs
NativePlayer._cues(text)       // pure: SRT/WebVTT text -> [{start, end, text}] sorted by start
NativePlayer._decodeSub(bytes, lang, languageName) // pure: file bytes -> text (BOM, UTF-8, legacy by language)
NativePlayer._cuesAt(cues, t)  // pure: {list: [indexes showing at t], next: time the set changes}
```

Hook semantics (as implemented):

- `onOpen()` once, right after the overlay is mounted and loading has begun.
- `onClose(info)` exactly once per overlay: the `play()` that opened it (returned true while the player was not active) gets one `onClose` when the overlay goes away. A `play()` while the player is active replaces the session inside the same overlay with no `onOpen`/`onClose` for the switch (only if building the replacement fails does the overlay close, with `onClose` reason `'internal'`). The overlay goes away on Back/Stop (`reason` `'back'`/`'stop'`), the end of a movie or of a last episode (`'ended'`), `stop(reason)`, and also **before** `onFallback` (`'fallback'`). `info` = the `info()` fields plus `reason` and `over` (0/1, the last value saved to the site).
- `onFallback(req, reason)` right after that `onClose`, when the viewer chose **Try website player** or the site answered signed-out. `req` is the request of the episode that failed (after Up Next it is the later episode). Reasons: `'signed-out'` (no card; route to sign-in), `'streams-failed'`, `'site-error'` (code < 0 or tv_file code != 1, e.g. VIP only), `'no-files'`, `'network'`, `'bad-answer'`, `'internal'`.
- `onProgress({kind, id, season, episode, seconds, duration, over})` each time a progress post is sent.
- `onNext(nextReq)` whenever the player moves to another episode in the same overlay (Up Next countdown or Play now, the Next Episode button, Ch+/Ch−, `ended`). `nextReq` has the `req` shape (`kind: 'tv'`, same `id`, new `season`/`episode`). The previous episode's progress is saved first (`over=1` when it came from Up Next or `ended`).

Timings (`configure`): `requestTimeout` 15000, `retryDelay` 700, `candidateTimeout` 15000 (a starting stream with no sign of life for this long fails), `candidateMax` 40000 (the longest any one stream may take to start), `stallTimeout` 15000, `osdHide` 4000, `progressEvery` 20000, `seekApply` 400, `seekReport` 1500, `upNextLead` 25, `upNextCount` 10, `chipMs` 6000, `startBudget` 90000 (the longest the loading screen waits for a first frame before the error card), `audioTimeout` 8000 (reading the HLS master), `audioVerify` 1500 (checking an audio track switch), `seekSlack` 8 (seconds a position may be off before it is applied again), `stillWatchingAfter` 3 (episodes autoplayed in a row without a key press before "Still watching?"; 0 turns it off), `repeatGap` 250 (same-direction seek presses closer than this count as a hold), `subTimeout` 15000 (each subtitle file request), `hlsLoadTimeout` 10000 (each hls.js copy's script load), `audioSwitchTimeout` 10000 (an hls.js audio switch must be confirmed by then), `fileTimeout` 25000 (the quiet time an original file gets on a TV when no HLS rendition is left to try), `filesFresh` 600000 (how long an episode's file list read ahead stays usable).

DOM (for tests and diagnostics): `#mbptv-player[data-state=loading|playing|error][data-kind]`, classes `is-osd`, `is-paused`, `is-seeking`, `is-buffering`, `is-upnext` (plus `is-still` while it asks "Still watching?"), `is-sheet`, `is-scrub`/`is-buttons` (which OSD row has focus). Buttons row `[data-action=play-pause|skip-intro|next-episode|quality|audio|subtitles|start-over]` (`audio` only when the playing stream offers a choice of audio tracks, its value the track playing; `subtitles` only when the title has subtitles; its value reads the language, "Off" or "Loading…"), floating `.mbp-skip`, quality sheet `[data-sheet=player-quality]` with `[data-quality=AUTO|4K|1080p|720p|360p|ORG]` and (titles and episodes with several files) `[data-file-index]`, the audio sheet (`[data-sheet=player-audio]`) with `[data-audio=INDEX][data-audio-lang=CODE]` rows, the subtitles sheet (the same element, `[data-sheet=player-subtitles]`) with `[data-subtitle=off]` and `[data-subtitle="L:F"][data-subtitle-lang=NAME]` rows (language index : file index), the subtitle overlay `.mbp-subs` (`is-on` while a cue shows) > `.mbp-subs-box` > `.mbp-subs-line[dir=auto]` (spans `.mbp-subs-i|b|u`), `#mbptv-player[data-subsize=small|medium|large]`, Up Next `[data-upnext]` with `[data-action=play-next|hide-next]`, error card `[data-dialog=player-error]` with `[data-action=other-file|retry|website|back]` (`other-file` for `streams-failed` before playback when the title has a file not tried yet; retry for `network`, `bad-answer`, `internal` and `streams-failed`), resume/notice chip `.mbp-chip`. The focused control has `is-focused`.

`App` (in `60-app.js`) calls `NativePlayer.play` from its Play action and routes keys to `NativePlayer.key` while it is active, as the "Integration" section below describes (keep it accurate). `App.nativePlayer()` returns `NativePlayer` for diagnostics and tests. When `Kit` is loaded, the player's artwork goes through `Kit.imgUrl` (backdrop 1280 px, Up Next still 500 px, smaller in TV performance mode) and falls back once to the original URL.

## Behaviour

- **Loading screen:** show immediately over the shell. Black, the backdrop at 35% opacity, the title, the episode line ("S1 · E1 The Rise of Putin"), and a spinner. Back cancels at any time.
- **Files without a second read:** a movie's files (with their `oss_download_url`) come from the title page the app already read (`Api.cached('movie', id)`: the detail screen, a prefetch or the boot page; `Site.detail` sources carry `url`), so Play goes straight to the player data. Only when nothing is cached is `/movie/ID` read first.
- **Start timings in the log:** the `playing …` line ends with `after 11.2 s (data 0.6, src 0.6, meta 3.1, seek 3.1, seeked 9.8, canplay 10.9[, stream 2 of 5])`: seconds after `play()` for the player data, the first `src` set, `loadedmetadata`, the resume seek and its `seeked`, the first `canplay`, and which candidate played. Through hls.js it also names `attach` (hls.js created: later than `src` when the script was still loading), `manifest` (master parsed), `playlist` (first media playlist) and `frag` (first video segment): `playing AUTO from 779 after 4.4 s (data 0.9, src 0.9, attach 0.9, manifest 1.2, playlist 2.4, frag 4.0, meta 4.1, seek 4.1, seeked 4.4, canplay 4.4, hls.js)`. Each mark is the first of the session (the first candidate's, when a later one played). `configure({tvOrder: '720p,ORG'})` tries those labels first on a TV (the rest keep their order; `''`, the default, keeps the order below), for start-time experiments from the remote inspector.
- **Source selection.** Movies use `req.fileIndex`, else `Prefs.quality` (`'best'` = the first listed file, `'1080p'`/`'720p'` = the closest match, `'ask'` = the first file; the detail screen's quality sheet handles "ask"). Episodes use the `tv_file` list: `req.fileIndex` when given (Try another file, the quality sheet's files), else the first entry. The title page's files come from `.sidebarbg2` (desktop layout) or `#file_bg` (the mobile layout TV user agents get; ARCHITECTURE.md §3).
- **Stream order** (`_order`; each candidate carries a `kind`).
  - TV (`Platform.isTV` = UA matches `Tizen|SMART-TV|Web0S|NetCast`, or `window.tizen` exists): **AUTO** HLS (+aac, what the site itself plays on TVs); an **MP4 original**; the **1080p** HLS; a **Matroska original**; 720p, 360p; the **4K** HLS; last a **risky original**: Matroska whose file name says DTS or TrueHD (the TV cannot decode the sound), or any original over 20 GB (remuxes stall on Wi-Fi). With Media Source Extensions (hls.js can play every HLS rendition) a Matroska original waits until after all HLS renditions: AUTO, MP4 original, 1080p, 720p, 360p, 4K, Matroska, risky. Where HLS plays through hls.js from the start (Samsung Tizen 9 and later, the remembered verdict, `hlsEngine: 'hlsjs'`; see "HLS engine"), every HLS rendition comes before any original: AUTO, 1080p, 720p, 360p, 4K, MP4 original, Matroska, risky (the platform player starts originals slowly there, 6–10 s, or not at all). The site's VIP placeholder (`/video/vip_only.mp4`) is never a candidate; when it is all there is, the error card says the title needs VIP.
  - Elsewhere: originals `canPlayType` accepts (HEVC when `h265 == 1`) and that are not risky, then AUTO, fixed HLS from the highest, then the other originals.
  - A candidate fails at once on a media `error` or a `play()` rejection other than `NotAllowedError` (autoplay blocked: wait for OK) or `AbortError` (a new source or a pause). Otherwise it fails after `candidateTimeout` (15 s) **without any sign of life** — metadata, data, `canplay`, `seeked`, more buffered, data arriving (`progress`) before the metadata (a large original whose index sits at the end of the file is still being read), a higher `readyState` or more buffered at a 2 s check (platform players that fire no `progress`), and with hls.js its manifest, playlists and fragments all restart that clock, so a slow but progressing start (a resume seek on a TV takes 5–10 s) is kept — and after `candidateMax` (40 s) in any case. Metadata alone is not enough: an HLS manifest can load while its segments hang or are refused. Through hls.js the clocks start once the script has loaded (a slow script load is not the stream's fault; `startBudget` bounds the whole start). An original file tried as the last resort on a TV (no HLS rendition left after it) gets `fileTimeout` (25 s) of quiet time instead: failing it only leads to the error card. A `waiting` stall of 15 s counts before the first frame too, unless the stream showed signs of life meanwhile (hls.js fragments arriving on a slow connection: the clocks above judge a start that is still progressing). On an error or stall, try the next candidate at the same position.
  - When AUTO through hls.js times out, stalls or does not start, the 1080p address (the same video AUTO starts on) waits: 720p, then 360p, then 1080p and 4K (log `AUTO was too slow: 720p, 360p next`).
  - When the TV's player refuses an HLS stream outright (media error 3/4 or `NotSupportedError` before metadata), the same stream is tried through hls.js next, at the same position (see "HLS engine"). Without hls.js (no MSE, no copy loaded, `hlsEngine: 'native'`), or when hls.js refuses a format too (`hls-format`), the other HLS renditions are built the same way, so MP4 originals move up to be tried next.
  - Every failure is logged with the time it took and the element's `readyState`, `networkState` and `error.message` (Tizen and webOS put their player's reason there), e.g. `stream AUTO failed: media-4 after 0.8 s (ready 0, net 3 "…")`.
  - When every candidate fails before playback started, the error card "This video won't play here" says why — "This TV can't play the video or audio format of this file" (all format errors), "The streams didn't load in time…" (all timeouts/stalls/network), else "None of the available streams would play on this TV" — and lists what was tried on the code line (`Tried Auto: format not supported · Original: no answer · …`). Buttons: **Try another file** (when the title has a file not tried yet in this chain; focused), **Try again** (focused when every stream timed out), **Try website player** (focused otherwise: the last resort) and **Back**.
  - When every candidate fails **mid-playback**, the signed stream links have usually expired: fetch the player data again once (again only after the new links played and 30 s passed) and continue at the same position with a "Reconnected" chip. If that fails too, the error card focuses **Try again**, which starts a fresh session that continues exactly where the video stopped. The position is saved first; `report()` keeps the last known duration across source swaps.
  - The loading screen never waits longer than `startBudget` (90 s) for a first frame: then the error card (Try again, Try website player, Back) says the video is taking too long.
- **Positions are verified:** a position set at `loadedmetadata` (resume, quality or file switch, audio switch, fresh links) is checked when the stream plays; native HLS players can ignore such an early seek and start at 0, so when it is more than `seekSlack` (8 s) off it is applied again (at most twice; logged as `at 0 instead of 95: seeking again`). A seek by the viewer cancels the check. Through hls.js a saved position the resume rules reject (within the last minute) is undone the same way: hls.js got it as its `startPosition` and would jump there once its first fragment is buffered, so the player seeks to 0 at `loadedmetadata` (hls.js then starts at 0) and checks 0.
- **Resume:** start at `seconds` if it is greater than 10 and less than `duration - 60`, and show a small toast-like chip "Resumed at 12:34 · press Down for Start over". Set `currentTime` after `loadedmetadata`.
- **Playback UI** (all inside our root, above everything, `#mbptv-player`):
  - Full-bleed video with `object-fit: contain` on black.
  - **OSD:** a bottom gradient with the show title (large), the episode line, a progress bar (played and buffered), elapsed time, remaining time, and a play/pause state icon. It appears on any key and auto-hides after 4 s while playing; while paused it stays visible.
  - **Buttons row** (Down from the progress area; Left/Right move between buttons; Up returns to the scrubber): **Play/Pause**, **Skip Intro** (only while `currentTime < skips.start`), **Next Episode** (TV, when a next episode exists), **Episodes** (optional, may be omitted), **Quality** (a sheet listing Auto, 4K, 1080p, 720p, 360p and Original with the size and HEVC/HDR info; choosing one switches stream at the current time and verifies it plays), **Audio** (when the stream offers several audio tracks; see "Audio languages"), **Subtitles** (when the title has any; see "Subtitles"), **Start over**.
  - **Keys:**
    - OK: play/pause (when no button is focused).
    - Left/Right: seek ∓10 s. Holding Left/Right (repeat) accelerates to 30 s and then 60 s steps, with a "+30 s" bubble. The seek is applied 400 ms after the last press, with a thumbnail-free time preview on the bar.
    - Up/Down: show the OSD and move between the scrubber and buttons.
    - Media keys play/pause/stop/FF/RW. Ch+/Ch− for next/previous episode.
    - Back: when a sheet is open, close it; otherwise stop, save progress and exit (`hooks.onClose`).
  - **Up Next** (Netflix style, TV only, when a next episode exists):
    - When `skips.end > 0` and `currentTime >= skips.end` (a plausible credits mark only: within the last fifth and the last 10 minutes), or 25 s before the end (or at the `ended` event), show a card at bottom right. It has the next episode's still and title (fetch the season page via `Api.detail('tv', id, {season})` or `Api.fetchDoc(Site.url.title('tv', id, season))`), "Next episode in 10", **Play now** (focused) and **Hide**.
    - The countdown runs to 0, then plays the next episode (`hooks.onNext(nextReq)`, then continue in the same player: stop progress for the current episode with `over=1` and load the next one). Back or Hide dismisses it and keeps watching the credits.
    - With `req.autoplayNext === false` the card has no countdown ("Up next"), and at the `ended` event it waits for the viewer (Play now or Hide/Back) instead of playing on.
    - **Still watching?** After `stillWatchingAfter` (3) episodes in a row started by autoplay with no key pressed, the card reads "Still watching?" without a countdown and the video pauses (the picture dims) until the viewer answers: **Play now** plays the next episode, **Hide**/Back resumes the credits. Any key resets the count, and so does a new `play()`.
    - At the `ended` event with no next episode, save `over=1` and exit to detail.
- **Progress:** report every 20 s while playing, and on pause, on seek (debounced), on stream switch (chosen or automatic), on stop/exit, on an error card, on `ended` and on `pagehide`/`visibilitychange` hidden. Send `hooks.onProgress({kind, id, season, episode, seconds, duration})` so the app can update Continue Watching.
- **Screen saver:** while playing, try `webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF)` and restore it on pause/exit, each in try/catch. If that is unavailable, try `tizen.power.request('SCREEN', 'SCREEN_NORMAL')` and `tizen.power.release('SCREEN')`.
- **Background:** when the app is hidden (Home button, input switch), save progress, pause, and let the screen saver run again. A stream that starts while hidden is paused at once, and the Up Next countdown does not run. Coming back shows the paused controls; OK carries on.
- **Pointer:** `#mbptv-player` takes pointer input (`pointer-events: auto`; the shell root is pointer-transparent outside shell mode) and swallows clicks, so a pointer never reaches the website underneath.
- **Errors:** `code < 0` JSON from the player endpoint shows its `msg` on the error card (for example VIP-only), with **Try website player** and **Back**. A signed-out gate response routes to the sign-in flow via `hooks.onFallback(req, 'signed-out')`.
- **Reliability:**
  - Every handler goes through `U.guard`.
  - Every request has a timeout and one retry.
  - A generation counter drops stale callbacks after stop/next.
  - `stop()` is idempotent.
  - Remove `src` and call `load()` to release the decoder.
  - No site JS globals.
  - No `innerHTML` with site data.
  - Never log stream URLs (log labels and codes only).
- **Performance:** a single `<video>`. The OSD updates at most 4×/s (`timeupdate` throttled). Transitions animate only opacity or transform. No box-shadows on large layers.
- **Implementation details worth knowing** (0.3.1):
  - Down while the resume chip is up focuses **Start over** (OK then restarts); otherwise Down opens the buttons row on Play/Pause.
  - While the controls are hidden and `currentTime < skips.start`, a focused **Skip Intro** pill floats bottom right: OK skips instead of pausing. With the controls up, Skip Intro is a button in the row. Only a plausible intro mark is used (within the first third of the video, at most 10 minutes), so bad site data cannot take OK over for a long stretch.
  - Seek: taps are 10 s; a hold (`event.repeat`, or same-direction presses less than `repeatGap` 250 ms apart, for remotes that send held keys without the flag) steps 10 s for the first 4 repeats, then 30 s, then 60 s after 14. The bubble shows the jump (`+10 s`, `+4:20`) above the target time; the title block dims while seeking.
  - The Up Next countdown pauses while the video is paused. **Hide**/Back dismisses it until the viewer rewinds more than 30 s before the credits point. At `ended` the card comes back (counting down again); Hide or Back there closes the player (`onClose` reason `'ended'`, `over=1`). `req.autoplayNext === false` (and "Still watching?") show the card without a countdown, and it then waits at `ended` too.
  - Next Episode (button) and Ch+ mid-episode save the real position with the site's `over` rule; from Up Next or `ended` the episode is saved with `over=1`. Ch− goes to `episode − 1` in the same season (a chip says so at E1).
  - A mid-playback stream error or a 15 s stall saves progress and switches to the next candidate at the current position with a "switched to a backup stream" chip. When every candidate fails, fresh links are fetched once (see Stream order), then the error card appears.
  - Choosing a quality tries the chosen stream first at the current position; if it does not play, the stream that was playing takes over again at the same position (then the others, those that already failed in this session last). The chip says what actually plays: "Quality: 720p", or "720p didn't play on this TV — playing Original instead"; the sheet marks a rendition that failed "Didn't play here". Sizes that do not fit a rendition (the site copies the 1080p size onto lower ones) are not shown, and HDR only on Original and 4K. Switching files continues from the position when the new file's data arrives (the old file keeps playing meanwhile).
  - The quality sheet also lists the title's files (Source file) when the title page or the episode's `tv_file` list has several; choosing one fetches that file's player data and continues at the same time.
  - The OSD shows a quality badge next to the episode line (Auto, 1080p, 4K, HDR), "Paused" above the title while paused (the picture dims slightly), and remaining time as `−9:24`.
  - The loading screen's kicker reads "Now playing", or "Next episode"/"Previous episode" after an in-player episode change.

## HLS engine (hls.js)

- **Why:** Samsung's Tizen 9 web view refuses HLS in `<video>` (media error 4) but has Media Source Extensions (endpoint 5). hls.js feeds HLS to the video element through MSE; the site's own TV player does the same.
- **Which engine** (per candidate; `info().engine`): an original file always plays natively. An HLS candidate plays through hls.js when MSE exists (`window.MediaSource` with `isTypeSupported`) and either `configure({hlsEngine: 'hlsjs'})`, or this TV is remembered as refusing HLS (below), or the user agent says **Samsung Tizen 9 or later** (its web view refuses HLS in `<video>`: no time is spent on a platform attempt, not even the first time; log `try AUTO (hls.js: Tizen 9)`), or `canPlayType('application/vnd.apple.mpegurl')` is empty. The first HLS `try` line of a session names the reason: `forced`, `remembered`, `Tizen 9`, `no native HLS`. Otherwise it plays natively, and when the platform player refuses it before metadata (media error 3/4, `NotSupportedError`) the same stream is tried through hls.js right after, at the same position (log `the platform player refused AUTO (media-4): trying it through hls.js`). When that hls.js attempt plays, the verdict is stored (`localStorage` `mbptv:hls-engine:v1` = `{ua, native: 'refuses'}`; ignored when the user agent changes, e.g. after a firmware update) and later streams start in hls.js directly. `hlsEngine: 'native'` turns hls.js off.
- **Loading:** lazily, once per page, by a `<script>` element: an `Hls` already on the page; else the site's own copy `/static/videojs/hls.min.js` (same origin, `cache-control: max-age=14400`; **hls.js 1.4.0**, verified 2026-10-20; the title pages and player data captured so far do not load it, but the site serves it); else the pinned CDN copy `https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js`. Each try has `hlsLoadTimeout` (10 s). When none loads (or `Hls` is not visible to the module, as in an isolated world), HLS stays with the platform player for 5 minutes and a stream already refused fails as it did (log `hls.js unavailable (…)`). hls.js is third-party code: it is never part of `tv.js` and is not linted (ARCHITECTURE.md §9); the player only calls its documented API (`Hls.isSupported`, `Hls.Events`, `Hls.ErrorTypes`, `new Hls(config)`, `attachMedia`, `loadSource`, `levels`, `currentLevel`, `startLevel`, `autoLevelCapping`, `audioTracks`, `audioTrack`, `recoverMediaError`, `startLoad`, `stopLoad`, `destroy`).
- **One instance per candidate:** every candidate start (fallback, quality, file switch, fresh links, Try again, another episode, Up Next) destroys the previous instance first; so do `stop()`, the error card and the end of a session. Config: `startPosition` (the resume or switch position, so loading starts there; a saved position outside the resume rules is moved back to 0 at `loadedmetadata`), `startFragPrefetch`, `testBandwidth: false` (the start level is chosen, so hls.js never loads a throw-away bandwidth-test fragment at the lowest level), `abrEwmaDefaultEstimate` = the last measured bandwidth (else 5 Mbit/s), buffers of 30 s ahead (60 s at most, 60 MB) and 30 s behind (TV memory), manifest/playlist timeouts 10 s, fragment timeouts 20 s with 3 retries, worker on. `progressive` stays off: the site's segments are one `moof` + `mdat` each (checked 2026-10-21), so chunked appending could not show anything before the whole segment arrived.
- **Qualities:** the Quality sheet keeps the site's per-quality addresses (a fixed label's master lists only that rendition), so each choice is a new instance and is verified as before. In **AUTO**, the 4K HEVC HDR rendition the site lists first is left to the Quality menu: adaptive playback starts on the best H.264 rendition up to 1080p (`startLevel`) and never goes above the best H.264 one (`autoLevelCapping`). Checked offline with the real 1.4.0 and 1.5.20 (the 4K playlist is never requested in AUTO). With a bandwidth measured in an earlier session (`localStorage` `mbptv:hls-bw:v1` = `{bw, at}`: hls.js's own estimate, saved when an instance that loaded fragments is destroyed; used for a week) the start is the best of those renditions whose bitrate is at most a 3.5th of it, so the first 10 s segment arrives in about 3 s (`start 720p (last 8 Mbit/s)`); without one, 1080p. `configure({hlsStart: '720p'})` caps the start for experiments (`start 720p (hlsStart 720p)`).
- **Errors:** non-fatal hls.js errors are hls.js's own retries (the first three are logged). A fatal media error (or a `<video>` error while hls.js feeds it) is recovered once with `recoverMediaError()`: hls.js 1.4 re-attaches the element (which leaves it paused; hls.js does not play it again) and reloads from its `config.startPosition`, so the player first sets that to the current place and then asks for playback again (unless the viewer or the background paused it); the next one, any fatal network error and other fatal errors end the candidate as usual: `hls-network` (or `timeout` for hls.js time-outs), `hls-format` (incompatible codecs: MP4 originals move up), `hls-media`, `hls-other`. Mid-film this is the usual backup stream and fresh-links path.
- **Background:** hidden → hls.js stops loading (`stopLoad`); back → it loads again from the position (`startLoad`).
- **`audio=aac`:** kept on TVs (endpoint 3). The ready line reports what MSE says about EAC3 and HEVC.
- **Log lines to read on a TV** (no URLs):
  - `hls.js preload (title page; Tizen 9)` or `(home; …)`: hls.js loading before Play; `preconnect hls.shegu.net, hls-aws.shegu.net`: at Play
  - `reading ahead the files of S1E2 (title page)` / `(up next)`, then at Play `episode files 1 (read ahead)`
  - `try AUTO (hls.js: Tizen 9) at 779`: straight to hls.js (or `remembered`, `forced`, `no native HLS`)
  - `the platform player refused AUTO (media-4): trying it through hls.js` (TVs before Tizen 9, first start only), then `try AUTO (hls.js) …`
  - `hls.js 1.4.0 ready (site copy, 0.3 s; MSE ec-3 no, hevc yes)` — version, which copy, load time
  - `hls.js: 4 levels [360p, 720p, 1080p, 4K HEVC], start 1080p (last 28 Mbit/s), HEVC kept for the Quality menu`
  - `the platform player refuses HLS here: hls.js from now on (remembered)`
  - `engine hls.js 1.4.0 (site copy) · AUTO · 1080p level · audio en` — one per stream that starts (natively: `engine native · ORG (mp4)`)
  - `playing AUTO from 779 after 4.4 s (data 0.9, src 0.9, attach 0.9, manifest 1.2, playlist 2.4, frag 4.0, meta 4.1, seek 4.1, seeked 4.4, canplay 4.4, hls.js)`
  - `hls.js level 720p` (adaptive switches, at most 12 per stream)
  - failures: `stream AUTO [hls.js] failed: hls-network after 0.4 s (hls.js networkError/manifestLoadError http 403) (ready 0, net 0)`, `hls.js mediaError/bufferAppendError: recovering once`, `AUTO was too slow: 720p, 360p next`
- **Measured live** (2026-10-20, desktop Chrome on macOS with the Samsung Tizen 9 user agent and the platform player made to refuse HLS like the TV; 4 player-data calls; progress posts answered locally): Squid Game S1E1 and S1E2, Dark S1E1 and the film 83450 all played through the site's hls.js 1.4.0 (start 5–10 s including the 1–3 s player-data request, resume included); audio en→ko (Squid Game) and en→de (Dark, four tracks: GER, ENG 5.1, GER 5.1, ENG 5.1) switched (`audio: switched`); the remembered `ko` was on from the start of the next episode; quality AUTO→720p/1080p/360p kept the position (within 1.5 s) as a new instance; master, playlists and segments (`hls-aws.shegu.net`) are all readable cross-origin by hls.js.

## Fast start

Where the time goes (measured 2026-10-21 against the live site in desktop Chrome on the user's home network, posing as the Tizen 9 TV, CPU slowed 4×; hls.js 1.4.0 from the HTTP cache, as on the TV): the player data (0.6–1.0 s; for an episode `tv_file` first, 0.7 s), the HLS master (0.3–0.5 s, plus a TLS handshake of 0.1–0.3 s on a new connection), the media playlist (1.2–1.6 s: the server builds a 0.5–0.7 MB playlist of signed segment addresses, 200–300 KB gzipped, for each start; the audio playlist comes at the same time), the init segment (0.1 s, plus a second TLS handshake to the segment host), the first 10 s video segment (4.5 MB at 1080p, 1.0–1.5 s), then decoding to the resume point (0.2–0.3 s). The playlists and segments cannot be had earlier: their addresses are signed by the answer before them.

What the player does about it:

- **No platform attempt where it cannot work:** HLS goes straight to hls.js on Tizen 9 and later and wherever the verdict is remembered (see "HLS engine"); every HLS rendition is tried before the original files there.
- **hls.js before Play:** `NativePlayer.warm()` loads it when a title page has rendered (0.8 s after; the App calls it from `screenReady`) and when Home has been idle for 6 s (no key for 1.5 s); `play()` starts loading it too, alongside the file list and player data, when it is not there yet. Only where HLS will play through hls.js (`hls.engine` in `configure()`).
- **Connections before the manifest:** at Play, `<link rel="preconnect" crossorigin>` for the stream hosts (`mbptv:stream-hosts:v1`: the master's and the segments' host names learnt from earlier streams, newest first, at most 4; `hls.shegu.net` and `hls-aws.shegu.net` until then). The handshakes happen while the player data loads. Host names only: stream URLs carry signed tokens and are never stored.
- **The file list read ahead:** an episode's `tv_file` list is read when its title page has rendered (the episode the page's Play would start, through the App's `resolveEpisode`) and 90 s before Up Next for the next episode, and kept 10 minutes. Play and autoplay then request only the player data. The player data itself is never requested before the viewer (or Up Next) starts the episode: that request is what the site treats as watching.
- **hls.js config:** the start level is chosen (no bandwidth test fragment), `startFragPrefetch`, the bandwidth guess before the first measurement is the last session's; see "HLS engine".
- **Tried and left out:** starting on 720p (half the bytes) gained nothing measurable on a 20–30 Mbit/s connection (4.8 s either way: the segment host's latency, not the bandwidth, dominates), so 1080p stays the start on a good connection (`configure({hlsStart: '720p'})` repeats the experiment on a TV); `progressive` cannot help (one `moof` per segment).

Measured time to the first frame (3 runs each; "before" = 0.5.1 with the hls.js verdict already stored, as on the TV; "after" = this version after the title page was shown for 3 s; player data replayed with its measured latency so both see the same answer):

| Title | Before | After |
| --- | --- | --- |
| Movie 83450, resume at 779 s (1080p AUTO, 3 levels) | 5.4, 5.4, 5.8 s | 4.4, 4.7, 4.6 s |
| Episode tv 12860 S1E1, resume at 183 s (360p only) | 4.3, 4.4, 4.2 s | 2.6, 2.9, 2.6 s |
| 4K film 81514, resume at 107 s (AUTO: 4K HEVC + 1080p/720p/360p H.264) | 5.6, 5.0, 5.2 s | 4.7, 4.5, 4.5 s |

On the TV, 0.5.1 measured `player data 0.7 s, hls.js ready 0.3 s, meta 5.0 s, playing after 6.5 s`; the first start on a Tizen 9 TV without the verdict also spent the platform player's refusal before hls.js.

## Subtitles

- **List:** `_parse` reads the panel (regexes over the text, never evaluated; HTML entities and `\'`-style escapes are undone): languages in the order of the site's language list, each with its files (`url`: http(s) only, or a site path made absolute; `sid`; `lang`, the `data-lang` code; `delay` in seconds; `name`, the file name). At most 60 languages and 8 files per language; lists without a usable address are dropped. Logs carry counts and language names only, never subtitle URLs.
- **Overlay, not `<track>`:** cues are drawn by our own `.mbp-subs` layer inside `#mbptv-player` (TV platform players may not draw `<track>` cues). White text, a black outline made of text-shadows, centred near the bottom (5em up), at most 3 lines, 2.75em (44 px at 1080p; Settings > Subtitle size: Small 2.25em, Large 3.375em). While the OSD shows the layer moves up above it (18.5em), and above the Up Next card while that shows. Each line has `dir="auto"` and `unicode-bidi: plaintext`, so Arabic and Hebrew run right-to-left. `<i>`, `<b>` and `<u>` become spans with classes; every other tag (`<font>`, VTT `<c>`/`<v>`, anything else) and `{\an8}`-style codes are dropped, keeping their text; text goes in through text nodes only.
- **Timing:** the shown set is the cues at `video.currentTime + delay` (the site's delay semantics, see endpoint 6), found by binary search (overlapping cues show together). It is checked on `timeupdate`, `seeked`, `playing` and `pause`, and between those a single timer wakes exactly when the set next changes (at most 1 s). The DOM changes only when the set changes.
- **Files:** fetched as bytes (`responseType: 'arraybuffer'`, 15 s timeout, no credentials cross-site), first from the file's own address, then through the site's proxy `GET /index/index/get_srt_content?srt_path=…` (same-origin, `X-Requested-With`). Decoding: a BOM wins (UTF-8, UTF-16); then strict UTF-8; then the language's legacy encoding (`ar`/`fa`/`ur` windows-1256, `he` windows-1255, Cyrillic windows-1251, `el` 1253, `tr` 1254, Central European 1250, Baltic 1257, `vi` 1258, `th` 874, `zh` GB18030, `zh-TW` Big5, `ja` Shift_JIS, `ko` EUC-KR; the language name is used when the code is missing); else windows-1252. SRT and WebVTT are both read (cue numbers, `WEBVTT` headers, NOTE/STYLE blocks and cue settings are skipped). A file with no cues counts as a failure. Parsed cues are kept per session, so switching back is instant.
- **Choosing:** the **Subtitles** button (OSD buttons row, after Quality) or the **Yellow** key opens the sheet: **Off**, then every file, "English", "English · 2" (a language's further files), with the file name and any delay as the second line; the current choice has the check and the focus. OK loads it: the button reads "Loading…" and a chip "Loading English subtitles…", then "Subtitles: English". A file that fails (both addresses) shows the chip "French subtitles couldn't be loaded", the choice falls back to Off, and playback is never touched. Without a panel there is no button and Yellow shows "No subtitles for this title". Back/Left closes the sheet onto the Subtitles button.
- **Remembered:** a choice from the sheet is saved as `Prefs subtitleLang` (the language name; Off saves `'off'`). Every new session (the next title, Ch+/Ch−, Next Episode, Up Next) turns that language on by itself (its first file) when the title has it, silently; a failure there shows the chip once playback runs (after the resume chip, never over it). First run (nothing saved) is Off. A title without the remembered language plays without subtitles and keeps the preference. Fresh stream links or another file keep the chosen file when it is listed again, else the same language.
- **Keys:** Yellow (405, registered on Tizen as `ColorF2Yellow`) opens the sheet from the playback screen (ignored on the Up Next card). LG and Samsung remotes' own subtitle/caption keys are not mapped (their codes are unverified).

## Audio languages

- **With hls.js** (see "HLS engine") the choice is hls.js's own: `hls.audioTracks` (the AAC group's renditions, in the master's order, named from `LANGUAGE`, else the first word of `NAME`) and `hls.audioTrack = i`. Choosing one logs `audio: track 2 of 2 (ko) via hls.js`; hls.js's `AUDIO_TRACK_SWITCHED` confirms it (`audio: switched`, chip "Audio: Korean"); without it within `audioSwitchTimeout` (10 s) the chip says "The audio didn't switch". The remembered language is set as soon as hls.js lists the tracks, one tick after its own initial choice (hls.js 1.4 would otherwise undo it), so the stream starts in it (`audio: the remembered language (ko) from the start, via hls.js`). One language twice gives no button. The master is not read separately.
- **Where the choice comes from (platform player).** The HLS master lists one AAC rendition per audio track of the original (endpoint 7); originals (MP4/MKV) can carry several tracks too. The player offers them two ways, in this order:
  1. **`video.audioTracks`** (Samsung documents `audioTracks` on its `<video>`; the platform player exposes HLS renditions and file tracks there). When it lists two or more tracks, the **Audio** button appears; choosing one sets `enabled` on it and clears the others, and after `audioVerify` (1.5 s) the player checks the choice held (chip "Audio: Japanese", else "The TV didn't switch the audio"). Names come from `track.language` (ISO 639-1/-2 codes mapped to English names), else the master's `LANGUAGE`/`NAME` in the same order, else the track label.
  2. **A rewritten master** when `audioTracks` is missing or lists fewer than two tracks: once an HLS stream plays, its master is read (XHR without credentials, `audioTimeout` 8 s; never logged) and, when its audio group has two or more **languages**, the Audio button offers them. Choosing one plays the same stream from a `data:application/vnd.apple.mpegurl;base64,…` master that keeps only that rendition (made `DEFAULT=YES,AUTOSELECT=YES`, every address absolute), at the same position, as a verified candidate: if the TV's player cannot play it, the stream that was playing takes over again at the same position, the chip says "This TV can't switch the audio language", and the rewritten-master route is not offered again until the app reloads (the default rendition comes back by choosing it again, which plays the original address). This route is a best effort: TV platform players fetch HLS themselves and may refuse `data:` addresses.
- A title with a single track (or, over the rewritten master, one language twice) has no Audio button.
- **Remembered:** a choice from the sheet is saved as `Prefs audioLang` (the language code, e.g. `'ja'`, or the track's name when it has no code). Every new stream (the next title, episodes, fresh links) switches to that language by itself once it plays, when the title has it; otherwise the default track plays and the preference is kept.
- **Log lines to read on a TV:** `audio: AUTO lists 2 [en*, ko]; video.audioTracks 2|missing` (the master's languages, `*` = default, and what the platform exposes), `audio: track 2 of 2 (ko) via audioTracks` then `audio: switched` / `audio: the TV did not switch the track`, or `audio: ko via a rewritten master at 312` then `audio: a rewritten master plays on this TV` / `does not play on this TV`.

## Testing (`test/player.test.cjs`, mock routes in `tools/mock-extra.cjs`)

- `tools/mock-extra.cjs` exports `handle(u, query, cookies, req, res, send, helpers)` and returns true when it handled the route. It provides:
  - `/index/index/tv_file`, which returns the `tv_file.json` shape for any episode, with `tfid = tid*10000 + season*100 + episode` (seasons and episodes up to 99). The next episode is E+1 up to `mbp_eps` (default 10), then E1 of the next season up to `mbp_seasons` (default 3).
  - `/index/index/player?mfid|tfid`, which returns the fixture text with stream URLs rewritten to local media. It includes a failing "HLS" URL (`/__media/bad.m3u8` returns 404) so fallback is exercised, and an ORG MP4-like source `/__media/ep.wav?len=60`, a generated silent WAV that `<video>` can play and seek. Make `var seconds` configurable via a cookie.
  - `/index/index/(tv|movie)_progress`, which records each POST body in memory and returns `{"code":1}`.
  - `/__mock/progress-log`, which returns the recorded posts as JSON; `?reset=1` clears them.
  - A special id (for example `mfid=999`) that returns `{"code":-1,"msg":"VIP only"}`.
- Tests build a bundle of `src/00-core.js`, `10-site.js`, `20-api.js` and `55-player.js` (+ `CSS_TEXT` from `player.css`) with a stub root, as `test/site.test.cjs` does, then drive `NativePlayer` with key events. Cover:
  - movie play with stream fallback (HLS fails, then ORG succeeds);
  - resume at `seconds`;
  - OSD show/hide;
  - OK pause/play;
  - seek ±10 and hold acceleration;
  - progress posts (payload fields and endpoint);
  - quality switch keeps the position;
  - Skip Intro visibility with skips;
  - Up Next appears near the end, counts down and loads the next episode (a new `tv_file` + player request, S1E2);
  - Hide dismisses it;
  - Back exits with an `onClose` info and a final progress post (`over` correct);
  - error card for `code -1`, and "Try website player" calls `onFallback`;
  - `stop()` is idempotent;
  - no stream URL appears in `Log.entries()`;
  - no page errors.
- **hls.js in tests:** the mock serves `tools/mock-hls.js`, a stand-in with the hls.js API surface the player uses, as the site copy (`/static/videojs/hls.min.js`) and as the CDN copy (`/__cdn/hls.min.js`; `test/player.test.cjs` configures `hlsCdn` to it, so tests never reach the network). It reads an HLS master by XHR and plays the WAV named on its `#MOCK-MEDIA` line; test hooks on `window.__hlsMock` (`instances`, `loads`, `summary()`, `fatal(type, details)`, `stuckAudio`). `/__media/mse.m3u8?q=…` is an HLS stream only hls.js plays: the `<video>` element gets 404 (media error 4, like Tizen 9) and a script gets the master (AUTO: 4K HEVC first, then 1080p/720p/360p H.264; English + Korean audio). Cookies: `mbp_hls=mse` (every HLS label; `mbp_auto=mse` for AUTO alone), `mbp_langs=1` (English only), `mbp_hlslib=nosite,nocdn,hang` (the copies 404 / the site copy never answers), `mbp_org=slow` (the original's header trickles in over about 5 s). Tests: the refused stream retried through hls.js from the site copy, the engine line, AUTO's start level and HEVC cap, the verdict remembered (next start directly in hls.js, one load, old instance destroyed); resume via `startPosition`; a quality switch as a new instance at the same position; the Audio sheet from `hls.audioTracks` (switch, remembered, next episode starts in it), no button with one language, an unconfirmed switch; a fatal media error recovered once and the second handing over to the original at the same place; the CDN copy when the site copy is missing, and no copy at all (timeout + 404) leaving HLS to the platform player; background stop/start; a slow-header original kept alive by arriving data; the TV order with MSE.
- As implemented, the mock also serves `/__media/bad-<q>.m3u8|mp4` (404), `/__media/hang.m3u8` (never answers), `/__mock/player-log` (tv_file, player and media requests; `?reset=1`), `/__mock/expire-links` (every stream link issued so far answers 403, like expired signed tokens; links in later player-data answers work) and `/__player/blank` (an empty page with a `#mbptv` root). Subtitles: cookie `mbp_subs=1` (or a comma list of `English,Arabic,Spanish,French`) adds the site's subtitle panel to the player data (the `<ul>` lists in a different order than the language list, plus a commented-out JS template); `/__subs/en.srt` (CRLF SRT with `<i>`, `<font>`, `<b>`, `&amp;`, `{\an8}`, `<script>`), `/__subs/en2.vtt` (WebVTT, listed with `data-delay="2"`), `/__subs/ar-1256.srt` (windows-1256 Arabic bytes), `/__subs/proxy-only.srt` (404 directly; the mock `/index/index/get_srt_content` proxy serves it) and `/__subs/missing.srt` (404 everywhere); the player log records them as `kind: 'subs'`. Since the fast start: `mock-hls.js` behaves like hls.js 1.4 where it matters: the jump to `startPosition` comes once the first fragment is buffered (a tick after `loadedmetadata`) and not while the element is seeking; `recoverMediaError()` re-attaches without playing and restarts at `config.startPosition`; `window.__hlsMock.slowStart` (ms of fragments arriving before the first frame) and `bandwidth` (the instances' `bandwidthEstimate`, default 20 Mbit/s); `summary()` reports `startFragPrefetch`, `testBandwidth` and `abrEwmaDefaultEstimate`. Tests (Tizen 9 user agent): straight to hls.js with the order and preconnect links; `warm()` (hls.js before Play, the file list read ahead, never the player data); the next episode's file list read ahead for Up Next; the start level from the last bandwidth and `hlsStart`; AUTO too slow sends 720p/360p first; a slow but progressing start not failed as a stall; the stream's clocks starting after a slow hls.js load; a saved position in the last minute not resumed through hls.js; a media error recovered at the same place and playing on; seven episode switches leaving one live instance, one script, a bounded number of preconnect links and the quality badge; the hls.js stream order. `test/app.test.cjs` checks the title page's read-ahead of S2E1's files and that Play uses it. The subtitle tests cover the panel parser (site order, delay, codes, template lists dropped), SRT/VTT cue parsing, decoding (UTF-8, windows-1256 by code and by name, BOM, windows-1252), overlapping cues, the sheet rows, timed cues with markup kept safe, the lift above the OSD, the delay, Off, Arabic right-to-left, a failing file (chip, playback untouched), the proxy fallback, the remembered language across episodes and titles, Off remembered, a title without the language, no panel (no button; Yellow's chip) and the size setting; `done()` also fails on any subtitle URL in the log. Per-test cookies: `mbp_bad=720p,360p` (those fixed HLS labels fail), `mbp_master=1` (a script reading a stream address gets an HLS master with English and Korean audio, like the site's; the `<video>` still gets the WAV), `mbp_seconds`, `mbp_len`, `mbp_skips=START,END`, `mbp_next=0`, `mbp_auto=bad|ok|hang`, `mbp_org=ok|bad|hang`, `mbp_all=bad`, `mbp_delay=MS`, `mbp_tvfile=fail`, `mbp_mid`, `mbp_eps`, `mbp_seasons`, and the existing `mockgate=1`. `test/player.test.cjs` also covers the parser and stream order as pure functions, the desktop order, no resume near the ends, periodic and seek progress, the candidate timeout, every stream failing, signed-out routing, Ch+/Ch−, Up Next Back, and the screen saver calls. Since the review fixes, also: a stream that loads its metadata but never plays, the loading budget, held OK/Back and seek acceleration without the repeat flag, autoplay off waiting at the end, "Still watching?", stream links expiring mid-film (refetch and continue; and the error card with Try again continuing there), the app going to the background, implausible intro/credits marks, `play()` replacing an active session, Next Episode across seasons, and pointer input. Since the Tizen stream rules: the TV order with MP4/Matroska/risky originals, 4K and the VIP placeholder; a quality that does not play handing back to the stream that played (chip, position, "Didn't play here"); a resume seek the player ignored being applied again; **Try another file** on the error card; the Audio button from a stand-in `audioTracks` (switch, remembered, applied to the next title), no button with one track or without tracks and master, the master-based route whose `data:` master the browser refuses (hand-back at the same position, button gone, nothing logged), and the master parser and rewrite.

## Integration (for the integrator; keep this section accurate)

The build already appends `src/player.css` to `CSS_TEXT` after `shell.css` (`tools/build.cjs` takes every `src/*.css`), and `55-player.js` sorts between the overlays and `60-app.js`, so `NativePlayer` exists before `App` runs. Steps 1–7 are in `src/60-app.js`; steps 8–10 touch `src/20-api.js`, `src/40-ui-screens.js` and `src/10-site.js`; step 11 is tests and docs.

**Status (0.3.1):** every step is wired. The code differs from the sketches below in these ways, and the code is what counts:
- `playNative` finds the title's model on the screen on top, on the boot page itself (`page.detail`, parsed in `route()`), in memory (`Api.cached`), or in `t.model`. A show-level Play with no episode, no Continue Watching label and no model reads the title page first (`resolveThenPlay`, behind the "Starting playback" overlay; Back cancels; after 6 s it plays with what it has).
- `resolveEpisode` also uses the page's `nextEpisode` (Site.detail: its resume label, else the first unwatched episode) right after the Continue Watching label. An episode card passes `exact: true`, so a special (episode 0) plays as itself (`NativePlayer` accepts episode 0 only when asked for exactly), and `episodeTitle`.
- The hooks collect every progress post's `over` per episode (`onProgress`). On close, the detail screen gets `params.lastPlayed` (where it stopped, `over`, `resume`, and the finished episodes) and `afterPlayback()` shows it at once: the Play label ("Resume S2E2", or the episode after a finished one), watched checks, the progress bar and the season line. The Continue Watching card's position is cleared.
- `refreshDetail` waits 1.5 s (the player's last progress post leaves as it closes), re-reads the title page and patches the screen in place with `refreshModel(m)`. Only a screen that cannot patch is rebuilt, and then only when a progress signature (the Play label, the season and every watched/progress field `Site.detail` gives, found by name) changed and the viewer has not moved.
- After anything played, Home re-fetches Continue Watching 1.5 s later (`afterWatching`).
- `screenReady` calls `warmPlayer(entry)`: 0.8 s after a title page has rendered, `NativePlayer.warm({why: 'title page'})` (for a show with the episode `resolveEpisode` picks for its Play), and 6 s after Home has rendered (only after 1.5 s without a key) `NativePlayer.warm({why: 'home'})` (see "Fast start").
- The watchdog returns after re-applying the `<html>` classes. While the player is up, the monitor pauses every website video outside `#mbptv`.
- `?play=1` pages use the built-in player (step 7).
- Steps 9 and 10 are in `40-ui-screens.js` and `10-site.js`. The settings rows take their labels and help text from `Prefs.describe(name)`, and TV performance mode is a third row. `Site.live.closePlayer` also leaves videos inside `#mbptv` alone.

1. **Split the play path.** Rename the current body of `play(t)` to `playWebsite(t)` (unchanged: live click, or `?play=1` navigation with the "Starting playback" overlay). The new `play(t)` is:

   ```js
   function play(t) {
     if (!t || !t.id) return;
     if (playNative(t)) return;
     playWebsite(t);
   }
   ```

2. **`playNative(t)`** returns false only when the built-in player is switched off or missing, or `NativePlayer.play` refused (no usable id). Then the website path runs. A show-level **Play**/**Resume** never falls back to the website player (that is the path that fails on the user's TV). The detail screen's Play passes no episode, and the Home hero passes only the card's `item`, so an episode is resolved first:

   ```js
   /* The episode a show-level Play/Resume starts: the explicit one; else a resume label (the Continue Watching
      card's "S37E21", or an "S2E3"-style label on the title page's Play button); else the first episode of the
      season the title page shows (the site opens a show on the season being watched); else S1E1. */
   function resolveEpisode(t, model) {
     if (+t.season > 0 && +t.episode > 0) return { season: +t.season, episode: +t.episode };
     var labels = [t.item && t.item.progressLabel, model && model.playLabel];
     for (var i = 0; i < labels.length; i++) {
       var m = /S(\d+)\s*E(\d+)/i.exec(String(labels[i] || ''));
       if (m && +m[1] > 0 && +m[2] > 0) return { season: +m[1], episode: +m[2] };
     }
     var season = model ? +model.season || 0 : 0, first = null;
     U.each(model && model.episodes || [], function (e) {
       if ((!season || +e.season === season) && (!first || +e.episode < +first.episode)) first = e;
     });
     if (first) return { season: +first.season, episode: +first.episode };
     return { season: season || 1, episode: 1 };
   }

   function playNative(t) {
     if (typeof NativePlayer === 'undefined' || Prefs.get('nativePlayer') === false) return false;
     var kind = t.kind === 'tv' ? 'tv' : 'movie';
     var inst = topInst(), model = inst && inst.model ? inst.model() : null, meta = Api.meta(kind + ':' + t.id) || {};
     if (model && (String(model.id) !== String(t.id) || model.kind !== kind)) model = null;
     if (kind === 'movie' && !t.pick && Prefs.get('quality') === 'ask' && model && (model.sources || []).length > 1) {
       /* As the detail screen's Quality button does: the sheet's onPick plays the chosen file. */
       Overlays.quality({ title: model.title, sources: model.sources, onPick: function (src) {
         play({ kind: kind, id: t.id, title: t.title, item: t.item, backdrop: t.backdrop, pick: src });
       } });
       return true;
     }
     var ep = kind === 'tv' ? resolveEpisode(t, model) : null;
     var epInfo = ep && model ? U.find(model.episodes || [], function (e) { return +e.season === ep.season && +e.episode === ep.episode; }) : null;
     /* Never t.title for the name: the detail screen appends "  ·  S2E1" to it. */
     var name = (model && model.title) || (t.item && t.item.title) || meta.title || U.text(String(t.title || '').replace(/\s+\u00b7\s+S\d+\s*E\d+\s*$/i, ''));
     var req = {
       kind: kind, id: String(t.id), season: ep ? ep.season : 0, episode: ep ? ep.episode : 0,
       title: name, showTitle: name, episodeTitle: epInfo ? epInfo.title : '',
       backdrop: t.backdrop || (model && model.backdrop) || meta.backdrop || (t.item && t.item.backdrop) || '',
       poster: (model && model.poster) || meta.poster || (t.item && t.item.poster) || '',
       fileIndex: t.pick && typeof t.pick.index === 'number' ? t.pick.index : undefined,
       autoplayNext: Prefs.get('autoplayEpisodes') !== false
     };
     rememberFocus();
     return NativePlayer.play(req, nativeHooks(t));
   }
   ```

   Do **not** call `playAction(t)` on this path: `lastPlayAt` makes `playCtx().recent` true for 15 s, which lets website-player detection count any large video (step 10 closes that hole as well).

3. **Hooks.** Use a fresh object per call, so `mount` is the live root. After the viewer closes the player, the detail screen shows where they are. It keeps its screen instance (no re-render and no focus jump) unless the title page changed in a way the screen shows. Only the Play/Resume label and the season shown can change, because episode cards carry no progress:

   ```js
   function nativeHooks(t) {
     return {
       mount: root,
       onOpen: function () {
         pending = null; cancelledAt = 0;
         Overlays.hideStarting(); closeAllLayers();
         setMode('player'); setScreenAttr('player');
         U.toggleClass(root, 'rail-open', false);
         Focus.blur();
       },
       onClose: function (info) {
         setMode('shell');
         var entry = top(), same = sameDetail(entry, info);
         if (same) prepareDetail(entry, info);
         if (!stack.length) defaultRoute(); else showEntry(top());
         if (same) refreshDetail(entry, info);
       },
       onFallback: function (req, reason) {
         Log.info('play', 'native player fallback: ' + reason);
         if (reason === 'signed-out') { signedOut(); return; }
         playWebsite({ kind: req.kind, id: req.id, season: req.kind === 'tv' ? req.season : 0, episode: req.kind === 'tv' ? req.episode : 0,
           title: req.showTitle || t.title, item: t.item, backdrop: req.backdrop });
       },
       onProgress: function () { /* nothing required: the site stores it; the detail refresh on close shows it */ },
       onNext: function (next) {
         var entry = top();
         if (entry && entry.screen === 'detail' && next) entry.focusKey = 'ep|' + next.season + 'x' + next.episode;   /* episode card key (40-ui-screens) */
       }
     };
   }

   function sameDetail(entry, info) {
     return !!(entry && entry.screen === 'detail' && info && info.id && String(entry.params.id) === String(info.id) &&
       (entry.params.kind === 'tv' ? 'tv' : 'movie') === info.kind);
   }

   /* Before the screen shows again: rebuilds must read the refreshed Api cache (never the boot page's markup), and
      a show whose Up Next crossed into another season shows that season (the player usually cached its page). */
   function prepareDetail(entry, info) {
     entry.live = false;
     if (info.kind !== 'tv' || !(info.season > 0)) return;
     var shown = entry.inst && entry.inst.model ? entry.inst.model() : null;
     var shownSeason = (shown && +shown.season) || +(entry.params.season || 0);
     entry.params.season = info.season;            /* the screen and refreshDetail now use the same Api cache key */
     if (shownSeason !== info.season) destroyInst(entry);
   }

   /* Re-read the title page (Api.detail with force replaces the cached model), then rebuild only when the viewer has
      not moved yet and the Play/Resume label or the season differs; entry.focusKey (rememberFocus / onNext) puts
      focus back on the played episode. */
   function refreshDetail(entry, info) {
     var season = info.kind === 'tv' ? +(entry.params.season || 0) : 0;
     Api.detail(info.kind, info.id, U.guard(function (err, m) {
       if (err || !m || mode !== 'shell' || top() !== entry || topLayer() || !entry.inst || entry.touched) return;
       var shown = entry.inst.model ? entry.inst.model() : null;
       if (!shown) return;   /* still loading: its own request reads the fresh page */
       if (U.text(shown.playLabel) === U.text(m.playLabel) && +shown.season === +m.season) return;
       rememberFocus();
       destroyInst(entry);
       showEntry(entry);
     }, 'native-refresh'), { force: true, season: season });
   }
   ```

   `onClose` always runs before `onFallback`, so `playWebsite` starts from shell mode with the detail screen on top. `onClose` fires once per overlay. A `play()` while the player is up (it never happens from the App, because the player owns the remote) replaces the session without `onOpen`/`onClose`.

4. **Keys.** First line of `dispatch(name, ev)`:
   `if (typeof NativePlayer !== 'undefined' && NativePlayer.active()) return NativePlayer.key(name, ev);`
   It returns true for every key while active, so `onKeyDown` prevents the default and the website never sees the remote. Keep `isHeldRepeat` in `onKeyDown` **before** `dispatch`, as it is today. It swallows a held OK or Back in every mode, including Back repeats that arrive after the first press closed the player (they would otherwise pop the detail screen and open the Exit dialog). The player also ignores auto-repeat of OK, Back, media keys, Ch+/− and Info itself.

5. **Watchdog and monitor.** In `watchdog()`, right after `guardFrames()` and `setModeClass()` (so the scroll lock stays applied), add `if (NativePlayer.active()) return;`. This means no focus repair, no `Site.live.playerOpen()` checks, and `afterPlayer(false)` never runs for the native player. The first line of `monitor()` is `if (typeof NativePlayer !== 'undefined' && NativePlayer.active()) return;`. `pendingTick` is harmless because `onOpen` clears `pending`.

6. **Leaving the player from app code.** In `leaveToShell()`, `enterWebsite()`, `enterPopup()`, `panic()` and `onPageShow()` (bfcache restore), first call `if (NativePlayer.active()) NativePlayer.stop('app');`. An example is `Api.onSignedOut` → `signedOut()` → `leaveToShell()` while a video plays. `stop` calls `onClose`, which sets shell mode, and the caller then continues as today (`leaveToShell` must not reach `Player.stop()` for it).

7. **`?play=1` pages** (legacy links, bookmarks, pages opened elsewhere) play in the built-in player: `route()` builds the page's stack (`defaultRoute`), passes `liveTitle()` to `playNative({kind, id, season, episode})` and, when it opened, calls `settleUrl()`. A show without an episode resolves through `resolveEpisode` (the boot page's own model gives the Play label and season). The website's own auto-play on that page still runs (it read `play=1` at load), so `siteHold` keeps it quiet: its file list, player and messages close without showing and its videos stay paused, until the viewer's next website play action. A `?play=1` page opened by the website path (`playWebsite`, including **Try website player**) carries sessionStorage `mbptv:webplay:v1` (`{url, t}`, 60 s) and keeps the website's player, so a failing title never loops between the two.

8. **Prefs (`20-api.js`).** Add `nativePlayer: true` and `autoplayEpisodes: true` to `DEFAULTS`, and **remove** `autoplayNext` (done: it is also ignored when read and dropped on the next write, and `Prefs.describe`/`choices`/`next` describe every preference for Settings). Do not reuse `autoplayNext`: nothing reads it today, but `Prefs.set` stores the whole preference object, so every TV where the viewer changed any setting already has `autoplayNext: false` saved. Flipping its default would leave autoplay off exactly there. Update the defaults assertions in `test/api.test.cjs` (3 places) and `docs/ARCHITECTURE.md` §5.3.

9. **Settings rows (`40-ui-screens.js`).** Add two toggles after "Preferred quality":

   ```js
   { key: 'nativePlayer', icon: 'play', label: 'Built-in player', toggle: true, desc: 'Plays movies and episodes in the TV app\u2019s own player (recommended). Turn it off to use the website\u2019s player instead.' },
   { key: 'autoplayEpisodes', icon: 'tv', label: 'Autoplay next episode', toggle: true, desc: 'Plays the next episode automatically when one ends, like Netflix. After three in a row without a button press it asks whether you are still watching.' },
   ```

   The toggle code falls back to `pref(def.key, def.key === 'nativeRemote')` in three places. Make that fallback true for the new keys too, for example `var TOGGLE_ON = { nativeRemote: true, nativePlayer: true, autoplayEpisodes: true };` with `pref(def.key, TOGGLE_ON[def.key] === true)`. Add `setting-nativePlayer` and `setting-autoplayEpisodes` to ARCHITECTURE.md §10. Optionally show `NativePlayer.info()` on the Diagnostics screen (it has no URLs).

10. **Website-player detection (`10-site.js`).** `allVideos()` must skip videos inside our root, so that `Site.live.playerOpen()` and `Site.live.video()` never count the built-in player's full-screen `<video>` as the website player. Steps 4–5 guard the App's own checks while the player is up; this guards every other caller and the moments around open and close:

    ```js
    function allVideos() {
      var shell = document.getElementById('mbptv');
      var mine = function (v) { return !!shell && shell.contains(v); };
      var out = U.map(U.filter(visibleOnly(qsa(document, 'video')), function (v) { return !mine(v); }), function (v) { return { v: v, area: videoArea(v) }; });
      return out.concat(frameVideos());
    }
    ```

    Add a `test/site.test.cjs` case: a large visible video inside `#mbptv` is neither `playerOpen({recent: true})` nor `video()`.

11. **Tests and docs.** `test/player.test.cjs` needs no App. After wiring, extend `test/app.test.cjs` with these cases:
    - Play on a movie detail opens `#mbptv-player` (not `?play=1`), and Back returns to the detail screen with focus on Play.
    - An episode card plays that episode.
    - Play on a show's detail screen (no episode) opens the player on the resolved episode (the fixture show 556 has no resume label, so the first episode of the season shown: S2E1).
    - Holding Back in the player closes it once and leaves the detail screen on top.
    - After Up Next moved to another episode, closing the player focuses that episode's card.
    - `Prefs.set('nativePlayer', false)` restores the old path.

    The mock routes in `tools/mock-extra.cjs` already serve the player endpoints for any page. In `docs/ARCHITECTURE.md`, update:
    - §1 goal 4, which should now read as playing through the website's own endpoints (see "Why" above);
    - §4, with `55-player.js` (`NativePlayer`) and `player.css`;
    - §6.2 "Player mode" and Settings;
    - §10.
