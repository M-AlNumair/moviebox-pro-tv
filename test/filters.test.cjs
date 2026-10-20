// Search and filters (docs/ARCHITECTURE.md sections 3, 5.2, 5.3, 6.2): the site adapter for the list pages' filter
// panel, the mobile search layout, the website's actor search and actor pages; Api.people; and the TV flows on the
// mock site: the Movies / TV Shows filter sheet, the client-side minimum IMDb rating, People search and the person
// screen, Search's genre and year entry points. Standalone: node test/filters.test.cjs [title filter...]
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const H = require('./helpers.cjs');
const K = require('./app.test.cjs');

const FILES = ['00-core.js', '10-site.js', '20-api.js'];
function bundle(origin) {
  return ['(function () {', "'use strict';", "var VERSION = 'test';", 'var START_URL = ' + JSON.stringify(origin + '/') + ';', "var CSS_TEXT = '';"]
    .concat(FILES.map(f => fs.readFileSync(path.join(H.root, 'src', f), 'utf8')))
    .concat(['window.__data = { U: U, Site: Site, Api: Api };', '}());'])
    .join('\n');
}
const fixture = name => fs.readFileSync(path.join(H.root, 'test', 'fixtures', name), 'utf8');

const filters = process.argv.slice(2).map(s => s.toLowerCase());
const { test, run } = H.makeRunner('filters');
let site, browser, O, sitePage, code, requests = [];

function unit(title, fn) {
  if (filters.length && !filters.some(f => title.toLowerCase().indexOf(f) >= 0)) return;
  test(title, fn);
}

// Site/Api tests: a bundle of the data layer on a mock page (no tv.js).
async function at(pathname, cookies) {
  await sitePage.context().clearCookies();
  if (cookies) await sitePage.context().addCookies(Object.keys(cookies).map(name => ({ name, value: cookies[name], url: O + '/' })));
  await sitePage.goto(O + pathname);
  await sitePage.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch (e) {} });
  sitePage.errors.length = 0;
  requests = [];
  await sitePage.addScriptTag({ content: code });
}

// Fetches a mock page (with the page's cookies) and runs Site[method](doc, url, ...extra).
function parsed(pathname, method, extra) {
  return sitePage.evaluate(async ({ p, m, extra }) => {
    const r = await fetch(p, { credentials: 'same-origin' });
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    return window.__data.Site[m].apply(null, [doc, new URL(p, location.href).href].concat(extra || []));
  }, { p: pathname, m: method, extra: extra || [] });
}

function fromHtml(html, url, method) {
  return sitePage.evaluate(({ html, url, method }) => window.__data.Site[method](new DOMParser().parseFromString(html, 'text/html'), url), { html, url, method });
}

// App flows: the built tv.js on the mock site, driven with remote keys only.
function flow(title, opts, fn) {
  if (filters.length && !filters.some(f => title.toLowerCase().indexOf(f) >= 0)) return;
  test(title, async () => {
    const page = await K.openApp(browser, O, Object.assign({ path: null }, opts));
    page.posts = [];
    page.on('request', r => { if (r.method() === 'POST') page.posts.push({ url: r.url(), body: r.postData() || '' }); });
    if (opts.cookies) await page.context_.addCookies(Object.keys(opts.cookies).map(name => ({ name, value: opts.cookies[name], url: O + '/' })));
    await page.goto(O + (opts.path || '/'));
    try {
      await fn(page);
      await page.waitForTimeout(100);
      if (page.errors.length) await K.fail(page, 'Uncaught page errors:\n    ' + page.errors.slice(0, 4).join('\n    '));
    } catch (e) {
      const file = await K.snap(page, path.join(H.root, 'test', 'artifacts', 'filters-FAIL-' + title.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) + '.png'));
      if (file) e.message += '\n  screenshot: ' + path.relative(H.root, file);
      throw e;
    } finally {
      await K.closeApp(page);
    }
  });
}

const listRequests = (page, re) => page.requests.map(u => u.replace(O, '')).filter(u => re.test(u));
const gridKeys = page => K.cardKeys(page, '.is-current [data-zone="grid"]');
const barLabels = page => page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv .is-current .mb-filter-bar [data-f]'), e => e.textContent.trim()));

async function openMovies(page) {
  await K.waitScreen(page, 'home');
  await K.waitFocus(page);
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'grid cards', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length > 0, null, 8000);
}

async function openSheet(page) {
  await K.activate(page, '#mbptv .is-current [data-action="filters"]');
  await K.waitUntil(page, 'the filter sheet', () => !!document.querySelector('#mbptv [data-sheet="filters"]'), null, 4000);
}

async function openSearch(page) {
  await K.waitScreen(page, 'home');
  await K.waitFocus(page);
  await K.activate(page, '[data-action="nav-search"]');
  await K.waitScreen(page, 'search');
  await K.waitFocus(page);
}

// ---- Site and Api ------------------------------------------------------------------------------------------------

unit('Site.filters reads the list page panel: groups, labels, applied values, named countries only, best quality first', async () => {
  await at('/tvshow/556');
  const f = await parsed('/movie', 'filters');
  assert.strictEqual(f.kind, 'movie');
  assert.strictEqual(f.live, true);
  assert.deepStrictEqual(f.groups.map(g => g.name), ['sort', 'genr', 'year', 'tomato_meter', 'quality', 'rating', 'country']);
  const g = name => f.groups.find(x => x.name === name);
  assert.deepStrictEqual(g('sort').options.map(o => o.value), ['add', 'tomato_meter', 'rating', 'view']);
  assert.deepStrictEqual(g('sort').options.map(o => o.label), ['Recently added', 'Rotten Tomatoes', 'IMDb rating', 'Most watched']);
  assert.strictEqual(g('genr').options.length, 27);
  assert.strictEqual(g('genr').multi, true);
  assert.deepStrictEqual(g('genr').options.slice(0, 3), [{ value: '1', label: 'Action' }, { value: '2', label: 'Adventure' }, { value: '3', label: 'Animation' }]);
  assert.ok(g('genr').options.some(o => o.value === '17' && o.label === 'Sci-Fi'));
  assert.deepStrictEqual(g('year').options.slice(-2).map(o => o.value), ['1960-1969', 'Before 1960']);
  assert.deepStrictEqual(g('tomato_meter').options.map(o => o.label), ['Certified Fresh', 'Fresh', 'Rotten']);
  assert.deepStrictEqual(g('quality').options.map(o => o.value), ['4K', 'BLU-RAY', 'WEBDL', 'DVD', 'HDTV', 'TC']);
  assert.deepStrictEqual(g('quality').options.slice(0, 3).map(o => o.label), ['4K', 'Blu-ray', 'WEB-DL']);
  assert.deepStrictEqual(g('rating').options.map(o => o.value), ['G', 'PG', 'PG-13', 'R', 'NC-17']);
  assert.strictEqual(g('country').options.length, 10, 'only the named flags, not the code badges');
  assert.deepStrictEqual(g('country').options[0], { value: 'United States', label: 'United States' });
  assert.ok(!g('country').options.some(o => /^[A-Z]{2}$/.test(o.value)));
  assert.strictEqual(f.selected.sort, '', 'the default sort (Added) reads as no sort');
  assert.deepStrictEqual(f.selected.genr, []);
  const tv = await parsed('/tvshow', 'filters');
  assert.strictEqual(tv.kind, 'tv');
  assert.strictEqual(await parsed('/movie/40102', 'filters'), null, 'a page without the panel has none');
  const spec = await sitePage.evaluate(() => window.__data.Site.filterSpec('tv'));
  assert.strictEqual(spec.live, false);
  assert.deepStrictEqual(spec.groups.find(x => x.name === 'sort').options.map(o => o.value), ['rating', 'tomato_meter', 'view']);
  assert.deepStrictEqual(spec.groups.find(x => x.name === 'tomato_meter').options.map(o => o.value), ['FRESH', 'Rotten']);
  assert.deepStrictEqual(sitePage.errors, []);
});

unit('Site.list on the mobile Movies layout: cards, chips, next page and the filter panel', async () => {
  await at('/tvshow/556', { mocklist: 'mobile' });
  const l = await parsed('/movie', 'list');
  assert.strictEqual(l.items.length, 6);
  assert.strictEqual(l.items[0].key, 'movie:83485');
  assert.strictEqual(l.items[0].title, "Neil Peart: No One's Disciple");
  assert.strictEqual(l.items[0].rating, '8.7');
  assert.strictEqual(l.items[0].tomato, '', 'a 0% Tomatometer is empty');
  assert.strictEqual(l.items[1].badge, 'Blu-ray');
  assert.ok(l.items.every(i => /\/__img\/thumb\/thumb_TEST_movie_\d+\.png$/.test(i.poster)));
  assert.strictEqual(l.chips.length, 4);
  assert.strictEqual(l.next, O + '/movie?page=2');
  assert.ok(l.filters && l.filters.groups.length === 7);
});

unit('Site.url.browse and Site.normFilters build the website filter URLs', async () => {
  await at('/tvshow/556');
  const r = await sitePage.evaluate(() => {
    const S = window.__data.Site;
    return [
      S.url.browse('movie', {}),
      S.url.browse('tv', null),
      S.url.browse('movie', { sort: 'add' }),
      S.url.browse('movie', { sort: 'rating', genr: ['1', '8'], year: 'Before 1960', tomato_meter: 'CERTIFIED-FRESH', quality: '4K', rating: 'PG-13', country: ['United States', 'Japan'] }, 2),
      S.url.browse('tv', { genr: '6', year: '2024' }),
      S.normFilters({ sort: 'add', genr: '1-8', year: 2023, country: 'United States,Japan', min: '7', junk: 'x', quality: { a: 1 } })
    ];
  });
  assert.strictEqual(r[0], O + '/movie');
  assert.strictEqual(r[1], O + '/tvshow');
  assert.strictEqual(r[2], O + '/movie', 'the default sort adds nothing');
  assert.strictEqual(r[3], O + '/movie?sort=rating&genr=1-8&year=Before%201960&tomato_meter=CERTIFIED-FRESH&quality=4K&rating=PG-13&country=United%20States,Japan&page=2');
  assert.strictEqual(r[4], O + '/tvshow?genr=6&year=2024');
  assert.deepStrictEqual(r[5], { sort: '', genr: ['1', '8'], year: '2023', tomato_meter: '', quality: '', rating: '', country: ['United States', 'Japan'] });
});

unit('Site.search reads the mobile search layout: titles, years, genres, runtime, rating; next page after 15 results', async () => {
  await at('/tvshow/556', { mocksearch: 'mobile' });
  const s = await parsed('/index/search?word=batman&type=all', 'search');
  assert.strictEqual(s.query, 'batman');
  assert.strictEqual(s.total, null, 'the mobile layout names no total');
  assert.deepStrictEqual(s.types, []);
  assert.deepStrictEqual(s.items.map(i => i.key), ['movie:40102', 'tv:556', 'tv:10911', 'tv:10742', 'movie:5170']);
  const [batman, show] = s.items;
  assert.strictEqual(batman.title, 'The Batman');
  assert.strictEqual(batman.year, '2022');
  assert.strictEqual(batman.runtime, '176 min');
  assert.deepStrictEqual(batman.genres, ['Action', 'Crime', 'Drama']);
  assert.strictEqual(batman.rating, '7.8');
  assert.strictEqual(show.title, 'The Batman');
  assert.strictEqual(show.year, '2004');
  assert.strictEqual(show.runtime, '');
  assert.ok(show.genres.indexOf('Animation') === 0);
  assert.strictEqual(s.next, '', 'five results: no next page');
  // A full page (15 results) on page 2 of TV shows: the next page keeps the word and the type.
  const html = fixture('search-mobile.html');
  const lis = html.match(/<li class="clear" style="margin-bottom: \.3rem;">[\s\S]*?<\/li>/g);
  let more = [];
  for (let i = 0; i < 3; i++) more = more.concat(lis.map(l => l.replace(/\/(movie|tvshow)\/(\d+)/, (m, k, id) => '/' + k + '/' + id + i)));
  const full = await fromHtml(html.replace(lis.join('\n'), more.join('\n')), O + '/index/search?word=batman&type=tv&page=2', 'search');
  assert.strictEqual(full.items.length, 15);
  assert.strictEqual(full.type, 'tv');
  assert.strictEqual(full.next, O + '/index/search?word=batman&type=tv&page=3');
});

unit('Site.people reads the actor search answer; malformed input gives []', async () => {
  await at('/tvshow/556');
  const r = await sitePage.evaluate(json => {
    const S = window.__data.Site;
    return { list: S.people(json), obj: S.people(JSON.parse(json)), bad: [S.people(''), S.people('{"code":1}'), S.people(null), S.people(42), S.people('<a href="/actor/x">x</a>')] };
  }, fixture('search_actor.json'));
  assert.strictEqual(r.list.length, 10);
  assert.deepStrictEqual(r.list[0], { id: '17848', key: 'person:17848', name: 'Tom Hanks', href: O + '/actor/17848', image: 'https://images.chuaxin.com/actor/TEST_person_17848.jpg', movies: 130, shows: 38 });
  const initials = r.list.find(p => p.name === 'Zach Hanks');
  assert.strictEqual(initials.image, '', 'initials only: no picture');
  assert.strictEqual(initials.movies, 3);
  assert.deepStrictEqual(r.obj, r.list);
  assert.deepStrictEqual(r.bad, [[], [], [], [], []]);
});

unit('Site.list on a person\'s titles (actor_works): the heading and title-less cards; Site.detail reads mobile cast links', async () => {
  await at('/tvshow/556');
  const l = await parsed('/index/index/actor_works?id=24314&type=movie', 'list');
  assert.strictEqual(l.title, 'Movies of “Robert Pattinson”');
  assert.strictEqual(l.items.length, 8);
  assert.strictEqual(l.items[0].key, 'movie:208');
  assert.strictEqual(l.items[0].title, '', 'the mobile layout names no titles');
  assert.strictEqual(l.items[0].rating, '5.1');
  assert.strictEqual(l.items[0].tomato, '46%');
  const tv = await parsed('/index/index/actor_works?id=24314&type=tv', 'list');
  assert.ok(tv.items.every(i => i.kind === 'tv'));
  const d = await fromHtml(fixture('cast-mobile.html'), O + '/movie/41635', 'detail');
  assert.deepStrictEqual(d.cast.map(c => [c.name, c.job, c.href]), [
    ['Ruben Fleischer', 'Director', O + '/actor/194166'], ['Art Marcum', 'Writer', O + '/actor/174540'],
    ['Matt Holloway', 'Writer', O + '/actor/174551'], ['Rafe Judkins', 'Writer', O + '/actor/346121']]);
  assert.strictEqual(d.cast[1].role, 'written by');
  const ids = await sitePage.evaluate(o => [window.__data.Site.personId(o + '/actor/24314'), window.__data.Site.personId('/actor/12?x=1'), window.__data.Site.personId('/movie/1'), window.__data.Site.personId('https://elsewhere.example/actor/5')], O);
  assert.deepStrictEqual(ids, ['24314', '12', '', '']);
});

unit('Api.people posts the website\'s actor search once per page and keeps the answer', async () => {
  await at('/tvshow/556');
  const posts = [];
  const onReq = r => { if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() }); };
  sitePage.on('request', onReq);
  try {
    const call = (q, p) => sitePage.evaluate(({ q, p }) => new Promise(res => window.__data.Api.people(q, p, (err, r) => res({ err, r }))), { q, p });
    const a = await call('tom hanks', 1);
    assert.strictEqual(a.err, null);
    assert.strictEqual(a.r.items.length, 10);
    assert.strictEqual(a.r.next, true);
    assert.strictEqual(a.r.query, 'tom hanks');
    assert.deepStrictEqual(posts, [{ url: O + '/index/search/search?key=tom%20hanks', body: 'key=tom%20hanks&page=1&type=actor&ajax=1' }]);
    const again = await call('Tom Hanks', 1);
    assert.strictEqual(again.r.items.length, 10);
    assert.strictEqual(posts.length, 1, 'the same search is answered from memory');
    const b = await call('tom hanks', 2);
    assert.strictEqual(b.r.items.length, 3);
    assert.strictEqual(b.r.next, false);
    const none = await call('zzqnobody', 1);
    assert.deepStrictEqual(none.r.items, []);
    const empty = await call('  ', 1);
    assert.strictEqual(posts.length, 3, 'an empty query posts nothing');
    assert.deepStrictEqual(empty.r.items, []);
    await sitePage.context().addCookies([{ name: 'mockgate', value: '1', url: O + '/' }]);
    const out = await call('someone', 1);
    assert.strictEqual(out.err && out.err.code, 'signed-out');
  } finally {
    sitePage.off('request', onReq);
    await sitePage.context().clearCookies();
  }
});

// ---- TV flows ----------------------------------------------------------------------------------------------------

flow('Movies: the filter sheet applies sort, genres and year through the website URL; pills show them; the session keeps them; Reset clears', {}, async page => {
  await openMovies(page);
  const before = await gridKeys(page);
  if ((await barLabels(page)).join('|') !== 'Filter and sort') await K.fail(page, 'an unfiltered Movies screen shows only "Filter and sort", got ' + JSON.stringify(await barLabels(page)));
  await openSheet(page);
  const f0 = await K.focusInfo(page);
  if (f0.zone !== 'fgroup:sort' || f0.text !== 'Recently added') await K.fail(page, 'the sheet opens on the chosen sort, got ' + JSON.stringify(f0));
  await K.activate(page, '[data-filter="sort"][data-value="rating"]');
  await K.activate(page, '[data-filter="genr"][data-value="1"]');
  await K.activate(page, '[data-filter="genr"][data-value="8"]');
  await K.activate(page, '[data-filter="year"][data-value="2023"]');
  const sub = await page.evaluate(() => document.querySelector('#mbptv [data-sheet="filters"] .mb-sheet-sub').textContent);
  if (sub !== 'Top IMDb · Action · Drama · 2023') await K.fail(page, 'the sheet names the choices as they are made, got ' + JSON.stringify(sub));
  if (listRequests(page, /^\/movie\?sort=/).length) await K.fail(page, 'nothing loads while the sheet is open');
  await K.back(page);
  await K.waitUntil(page, 'the sheet closed and new titles', b => !document.querySelector('#mbptv [data-sheet="filters"]') && document.querySelector('#mbptv .is-current [data-zone="grid"] [data-key]') && document.querySelector('#mbptv .is-current [data-zone="grid"] [data-key]').getAttribute('data-key') !== b, before[0], 8000);
  const reqs = listRequests(page, /^\/movie\?sort=/);
  if (reqs[0] !== '/movie?sort=rating&genr=1-8&year=2023') await K.fail(page, 'the list should be read with the website filter parameters, got ' + JSON.stringify(reqs));
  const filtered = await gridKeys(page);
  const pills = await barLabels(page);
  if (pills.join('|') !== 'Filter and sort|Top IMDb|Action|Drama|2023|Reset') await K.fail(page, 'the bar shows one pill per filter and Reset, got ' + JSON.stringify(pills));
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:filters:v1') || 'null'));
  if (!stored || stored.movie.sort !== 'rating' || stored.movie.genr.join() !== '1,8' || stored.movie.year !== '2023') await K.fail(page, 'the filters are kept for the session, got ' + JSON.stringify(stored));
  // OK on a pill opens the sheet on that group.
  await K.activate(page, '#mbptv .is-current [data-filter-pill="year"]');
  await K.waitUntil(page, 'the filter sheet', () => !!document.querySelector('#mbptv [data-sheet="filters"]'), null, 4000);
  const fy = await K.focusInfo(page);
  if (fy.zone !== 'fgroup:year' || fy.text !== '2023') await K.fail(page, 'a pill opens the sheet on its own group, got ' + JSON.stringify(fy));
  await K.back(page);
  // Home, then the rail's Movies again: the same filters.
  await K.activate(page, '[data-action="nav-home"]');
  await K.waitScreen(page, 'home');
  page.requests.length = 0;
  await K.activate(page, '[data-action="nav-movies"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'the remembered filters', () => document.querySelectorAll('#mbptv .is-current .mb-filter-pill').length === 4, null, 6000);
  // The filtered page was read a moment ago, so it comes from memory (Api.list): the same titles, no request needed.
  const again = await gridKeys(page);
  if (again[0] !== filtered[0] || listRequests(page, /^\/movie$/).length) await K.fail(page, 'the rail\'s Movies shows the remembered filtered list, got ' + JSON.stringify({ again: again.slice(0, 3), filtered: filtered.slice(0, 3), requests: page.requests }));
  await K.activate(page, '#mbptv .is-current [data-action="filters-reset"]');
  await K.waitUntil(page, 'the filters reset', () => document.querySelectorAll('#mbptv .is-current .mb-filter-pill').length === 0, null, 6000);
  const after = await page.evaluate(() => JSON.parse(sessionStorage.getItem('mbptv:filters:v1')).movie);
  if (after.sort || after.genr.length || after.year) await K.fail(page, 'Reset clears the stored filters, got ' + JSON.stringify(after));
  const f = await K.focusInfo(page);
  if (f.action !== 'filters') await K.fail(page, 'after Reset focus stays in the bar, on Filter and sort, got ' + JSON.stringify(f));
});

flow('Movies: the minimum IMDb rating is checked on the TV and reads more pages until enough titles pass', {}, async page => {
  await openMovies(page);
  await openSheet(page);
  await K.activate(page, '[data-filter="min"][data-value="7"]');
  await K.activate(page, '[data-action="filters-apply"]');
  await K.waitUntil(page, 'the sheet closed', () => !document.querySelector('#mbptv [data-sheet="filters"]'), null, 4000);
  await K.waitUntil(page, 'the count line after three pages', () => /rated 7\+ of 9 checked/.test(document.querySelector('#mbptv .is-current .mb-browse-head .mb-meta').textContent), null, 10000);
  const ratings = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key] .mb-card-sub'), e => parseFloat(e.textContent.replace(/[^\d.]+/g, ' ').trim().split(' ').pop())));
  if (!ratings.length || ratings.some(r => !(r >= 7))) await K.fail(page, 'only titles rated 7 or more show, got ' + JSON.stringify(ratings));
  if (listRequests(page, /^\/movie(\?page=\d+)?$/).length < 3) await K.fail(page, 'the TV reads more pages to fill the grid, got ' + JSON.stringify(page.requests.filter(u => /\/movie/.test(u))));
  if (listRequests(page, /^\/movie\?.*min=/).length) await K.fail(page, 'the minimum rating never goes to the website');
  const pills = await barLabels(page);
  if (pills.indexOf('IMDb 7+') < 0) await K.fail(page, 'the bar shows the IMDb 7+ pill, got ' + JSON.stringify(pills));
});

flow('TV Shows: the filter sheet builds /tvshow URLs; a category chip leaves the filters to All shows', {}, async page => {
  await K.waitScreen(page, 'home');
  await K.waitFocus(page);
  await K.activate(page, '[data-action="nav-shows"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'grid cards', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length > 0, null, 8000);
  await openSheet(page);
  const anySort = await page.evaluate(() => document.querySelector('#mbptv [data-filter="sort"][data-value=""]').textContent.trim());
  if (anySort !== 'Latest') await K.fail(page, 'TV Shows\' default order is "Latest", got ' + anySort);
  await K.activate(page, '[data-filter="genr"][data-value="6"]');
  await K.activate(page, '[data-filter="quality"][data-value="4K"]');
  await K.back(page);
  await K.waitUntil(page, 'the filtered list', () => document.querySelectorAll('#mbptv .is-current .mb-filter-pill').length === 2, null, 6000);
  if (!listRequests(page, /^\/tvshow\?genr=6&quality=4K$/).length) await K.fail(page, 'the list is read as /tvshow?genr=6&quality=4K, got ' + JSON.stringify(page.requests.filter(u => /tvshow/.test(u))));
  await K.activate(page, { selector: '#mbptv .is-current .mb-browse-tabs [data-f]', index: 1 });
  await K.waitUntil(page, 'the category list and dimmed pills', () => document.querySelector('#mbptv .is-current .mb-filter-bar').classList.contains('is-off'), null, 6000);
  await K.activate(page, { selector: '#mbptv .is-current .mb-browse-tabs [data-f]', index: 0 });
  await K.waitUntil(page, 'All shows again', () => !document.querySelector('#mbptv .is-current .mb-filter-bar').classList.contains('is-off'), null, 6000);
});

flow('Search: People is chosen before typing, fetches nothing while typing, posts the actor search once and opens a person\'s titles', {}, async page => {
  await openSearch(page);
  await K.activate(page, '[data-type="actor"]');
  const ph = await page.evaluate(() => document.querySelector('#mbptv .mb-placeholder').textContent);
  if (ph !== 'Search people by name') await K.fail(page, 'the placeholder follows the People tab, got ' + ph);
  page.requests.length = 0;
  await K.typeOnScreen(page, 'hanks');
  await page.waitForTimeout(600);
  if (page.requests.some(u => /autocomplate|\/index\/search/.test(u)) || page.posts.length) await K.fail(page, 'typing a name fetches nothing, got ' + JSON.stringify(page.requests.concat(page.posts.map(p => p.url))));
  await K.activate(page, '[data-action="search-submit"]');
  await K.waitUntil(page, 'person cards', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-person]').length === 10, null, 8000);
  if (page.posts.length !== 1 || page.posts[0].body !== 'key=hanks&page=1&type=actor&ajax=1') await K.fail(page, 'one actor search POST, got ' + JSON.stringify(page.posts));
  const head = await page.evaluate(() => document.querySelector('#mbptv .mb-results-head .mb-section').textContent);
  if (head !== 'People named “hanks”') await K.fail(page, 'the heading names the people search, got ' + head);
  const f = await K.focusInfo(page);
  if (f.zone !== 'grid' || !/Tom Hanks/.test(f.text)) await K.fail(page, 'the first person takes focus, got ' + JSON.stringify(f));
  // Paging: the last row reads page 2.
  await K.navigateTo(page, { selector: '#mbptv [data-zone="grid"] [data-person]', index: -1 });
  await K.waitUntil(page, 'page 2 of people', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-person]').length === 13, null, 8000);
  if (page.posts.length !== 2 || !/page=2/.test(page.posts[1].body)) await K.fail(page, 'the second page posts page=2, got ' + JSON.stringify(page.posts));
  await K.activate(page, '[data-person="17848"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'the person\'s movies', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length === 8, null, 8000);
  if (!page.requests.some(u => u.indexOf(O + '/index/index/actor_works?id=17848&type=movie') === 0)) await K.fail(page, 'the person screen reads actor_works for movies');
  const hd = await page.evaluate(() => [document.querySelector('#mbptv .is-current .mb-browse-head .mb-h1').textContent, document.querySelector('#mbptv .is-current .mb-browse-head .mb-meta').textContent]);
  if (hd[0] !== 'Tom Hanks' || hd[1] !== '130 movies · 38 TV shows') await K.fail(page, 'the person screen names them and their counts, got ' + JSON.stringify(hd));
  await K.activate(page, { selector: '#mbptv .is-current .mb-browse-tabs [data-f]', index: 1 });
  await K.waitUntil(page, 'the person\'s TV shows', () => { const c = document.querySelector('#mbptv .is-current [data-zone="grid"] [data-key]'); return !!c && /^tv:/.test(c.getAttribute('data-key')); }, null, 8000);
  await K.back(page);
  await K.waitScreen(page, 'search');
  await K.waitUntil(page, 'the people results again', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-person]').length === 13, null, 4000);
  if (page.posts.length !== 2) await K.fail(page, 'going back shows the people already found, without asking again');
});

flow('Search: switching tabs while typing never searches; on the results it searches again in that tab', {}, async page => {
  await openSearch(page);
  await K.typeOnScreen(page, 'bat');
  await page.waitForTimeout(500);
  page.requests.length = 0;
  await K.activate(page, '[data-type="tv"]');
  await K.activate(page, '[data-type="actor"]');
  await K.activate(page, '[data-type="all"]');
  await page.waitForTimeout(400);
  if (page.requests.some(u => /\/index\/search\?/.test(u)) || page.posts.length) await K.fail(page, 'choosing a tab before Search fetches no results, got ' + JSON.stringify(page.requests));
  await K.activate(page, '[data-action="search-submit"]');
  await K.waitUntil(page, 'results', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-key]').length > 0, null, 8000);
  await K.activate(page, '[data-type="actor"]');
  await K.waitUntil(page, 'people results', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-person]').length > 0, null, 8000);
  if (page.posts.length !== 1) await K.fail(page, 'the People tab on the results searches people, got ' + JSON.stringify(page.posts));
  await K.activate(page, '[data-type="movie"]');
  await K.waitUntil(page, 'movie results', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-key^="movie:"]').length > 0 && !document.querySelector('#mbptv [data-zone="grid"] [data-person]'), null, 8000);
});

flow('Search: genre and year chips open Movies (or TV Shows) filtered by them', {}, async page => {
  await openSearch(page);
  await K.waitUntil(page, 'browse chips', () => document.querySelectorAll('#mbptv [data-browse]').length > 10, null, 4000);
  page.requests.length = 0;
  await K.activate(page, '[data-browse="Action"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'grid cards', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length > 0, null, 8000);
  if (!listRequests(page, /^\/movie\?genr=1$/).length) await K.fail(page, 'the Action chip reads /movie?genr=1, got ' + JSON.stringify(page.requests));
  const hd = await page.evaluate(() => [document.querySelector('#mbptv .is-current .mb-kicker').textContent, document.querySelector('#mbptv .is-current .mb-h1').textContent]);
  if (hd.join('|') !== 'Movies|Action') await K.fail(page, 'the screen is titled by the genre, got ' + JSON.stringify(hd));
  const stored = await page.evaluate(() => sessionStorage.getItem('mbptv:filters:v1'));
  if (stored) await K.fail(page, 'a quick genre does not replace the remembered Movies filters, got ' + stored);
  await K.back(page);
  await K.waitScreen(page, 'search');
  await K.activate(page, '[data-type="tv"]');
  await K.waitUntil(page, 'TV browse chips', () => /TV shows/.test(document.querySelector('#mbptv .mb-discover').textContent), null, 4000);
  page.requests.length = 0;
  await K.activate(page, '[data-browse="1990s"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'grid cards', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length > 0, null, 8000);
  if (!listRequests(page, /^\/tvshow\?year=1990-1999$/).length) await K.fail(page, 'the 1990s chip on TV Shows reads /tvshow?year=1990-1999, got ' + JSON.stringify(page.requests));
});

flow('Detail: a cast member opens their titles; a person without movies shows their TV shows', {}, async page => {
  await page.goto(O + '/movie/40102');
  await K.waitScreen(page, 'detail');
  await K.waitFocus(page);
  await K.waitUntil(page, 'cast chips', () => !!document.querySelector('#mbptv [data-zone="row:cast"] [data-person="24314"]'), null, 8000);
  await K.activate(page, '#mbptv [data-zone="row:cast"] [data-person="24314"]');
  await K.waitScreen(page, 'browse');
  await K.waitUntil(page, 'their movies', () => document.querySelectorAll('#mbptv .is-current [data-zone="grid"] [data-key]').length > 0, null, 8000);
  if (!page.requests.some(u => u.indexOf(O + '/index/index/actor_works?id=24314&type=movie') === 0)) await K.fail(page, 'the cast chip opens actor_works for that person');
  const title = await page.evaluate(() => document.querySelector('#mbptv .is-current .mb-h1').textContent);
  if (title !== 'Robert Pattinson') await K.fail(page, 'the person screen is titled by the name, got ' + title);
  await page.evaluate(() => window.__mbptv.App.push('browse', { url: location.origin + '/index/index/actor_works?id=999&type=movie', title: 'Nobody Famous', kicker: 'Person',
    tabs: [{ label: 'Movies', href: location.origin + '/index/index/actor_works?id=999&type=movie' }, { label: 'TV Shows', href: location.origin + '/index/index/actor_works?id=999&type=tv' }],
    person: { id: '999', name: 'Nobody Famous', image: '', meta: '' } }));
  await K.waitUntil(page, 'their TV shows instead', () => { const c = document.querySelector('#mbptv .is-current [data-zone="grid"] [data-key]'); return !!c && /^tv:/.test(c.getAttribute('data-key')); }, null, 8000);
  const sel = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv .is-current .mb-browse-tabs .is-selected'), e => e.textContent.trim()));
  if (sel.join() !== 'TV Shows') await K.fail(page, 'the TV Shows tab is selected, got ' + JSON.stringify(sel));
});

flow('Search on the mobile layout: real titles (not the year) and the count once every page is in', { cookies: { mocksearch: 'mobile' } }, async page => {
  await openSearch(page);
  await K.typeOnScreen(page, 'batman');
  await K.activate(page, '[data-action="search-submit"]');
  await K.waitUntil(page, 'results', () => document.querySelectorAll('#mbptv [data-zone="grid"] [data-key]').length === 5, null, 8000);
  const titles = await page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#mbptv [data-zone="grid"] [data-key] .mb-card-title'), e => e.textContent));
  if (titles[0] !== 'The Batman' || titles.some(t => /^\(\d{4}\)$/.test(t))) await K.fail(page, 'cards carry the titles, got ' + JSON.stringify(titles));
  const count = await page.evaluate(() => document.querySelector('#mbptv .mb-results-head .mb-count').textContent);
  if (count !== '5 titles') await K.fail(page, 'five results on one page: "5 titles", got ' + JSON.stringify(count));
});

(async () => {
  site = await H.mockSite.start();
  O = site.origin;
  code = bundle(O);
  browser = await H.launch();
  sitePage = await H.openPage(browser, { tv: false });
  try { await run(); } finally {
    await browser.close();
    await site.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
