/* Filters (docs/ARCHITECTURE.md section 6.2 "Filter sheet"): the Movies / TV Shows filter state, its labels, the filter
   sheet, and the People pieces (person cards and the person screen's parameters). The server filters by the website's
   own list parameters (Site.url.browse); the minimum IMDb rating is the one filter the website does not offer, so it
   is applied on the TV to the titles it loads (the browse screen pages on until it has enough). The last filters of
   the Movies and TV Shows screens are kept for the session (sessionStorage mbptv:filters:v1). */
var Filters = (function () {
  var el = U.el;
  var KEY = 'mbptv:filters:v1';
  var MIN_CHOICES = [['', 'Any'], ['6', '6+'], ['7', '7+'], ['8', '8+']];
  var SORT_PILLS = { rating: 'Top IMDb', tomato_meter: 'Top Rotten Tomatoes', view: 'Most watched' };
  var QUICK_GENRES = ['1', '5', '8', '13', '17', '3', '19', '16', '6', '7', '9', '10'];
  var QUICK_YEARS = ['2026', '2025', '2024', '2023', '2022', '2010-2015', '2000-2009', '1990-1999'];

  function kindOf(kind) { return kind === 'tv' ? 'tv' : 'movie'; }
  function isArray(x) { return Object.prototype.toString.call(x) === '[object Array]'; }

  /* Every field present: the website's own (Site.normFilters) plus min ('' or '6'..'9', client-side). */
  function norm(f) {
    var out = null;
    try { out = Site.normFilters(f); } catch (e) { out = null; }
    if (!out) out = { sort: '', genr: [], year: '', tomato_meter: '', quality: '', rating: '', country: [] };
    var m = f && typeof f === 'object' ? String(f.min == null ? '' : f.min) : '';
    out.min = /^[5-9]$/.test(m) ? m : '';
    return out;
  }

  function key(f) { return JSON.stringify(norm(f)); }
  function same(a, b) { return key(a) === key(b); }

  function isEmpty(f) {
    f = norm(f);
    for (var k in f) if (f.hasOwnProperty(k) && (isArray(f[k]) ? f[k].length : f[k])) return false;
    return true;
  }

  function serverPart(f) { var o = norm(f); delete o.min; return o; }

  function load(kind) {
    var all = null;
    try { all = Store.session.get(KEY, null); } catch (e) { all = null; }
    return norm(all && typeof all === 'object' ? all[kindOf(kind)] : null);
  }

  function save(kind, f) {
    try {
      var all = Store.session.get(KEY, null);
      if (!all || typeof all !== 'object') all = {};
      all[kindOf(kind)] = norm(f);
      Store.session.set(KEY, all);
    } catch (e) { Log.warn('filters-save', e); }
  }

  function url(kind, f, page) { return Site.url.browse(kindOf(kind), serverPart(f), page); }

  /* The groups the sheet shows: the page's own panel (Site.list(...).filters) or the built-in lists, plus the
     client-side minimum IMDb rating after Year. */
  function groups(kind, fromPage) {
    var spec = fromPage && isArray(fromPage.groups) && fromPage.groups.length ? fromPage : null;
    if (!spec) { try { spec = Site.filterSpec(kindOf(kind)); } catch (e) { spec = { groups: [] }; } }
    var out = [];
    U.each(spec.groups || [], function (g) {
      if (!g || !g.name || !isArray(g.options)) return;
      var options = g.name === 'sort' ? U.filter(g.options, function (o) { return o.value !== 'add'; }) : g.options;
      out.push({ name: g.name, title: g.title || g.name, multi: !!g.multi, options: options, local: false });
      if (g.name === 'year') out.push(minGroup());
    });
    if (!U.find(out, function (g) { return g.name === 'min'; })) out.splice(Math.min(out.length, 3), 0, minGroup());
    return out;
  }

  function minGroup() {
    return { name: 'min', title: 'Minimum IMDb rating', multi: false, local: true,
      options: U.map(MIN_CHOICES.slice(1), function (c) { return { value: c[0], label: 'IMDb ' + c[1] }; }) };
  }

  /* The label of the "nothing chosen" option of a group. */
  function anyLabel(name, kind) {
    if (name === 'sort') return kindOf(kind) === 'tv' ? 'Latest' : 'Recently added';
    return 'Any';
  }

  function yearLabel(v) {
    var m = /^(\d{3})0-(\d{3})9$/.exec(v || '');
    if (m && m[1] === m[2]) return m[1] + '0s';
    return String(v || '').replace(/^(\d{4})-(\d{4})$/, '$1–$2');
  }

  function labelOf(groupsList, name, value) {
    var g = U.find(groupsList || [], function (x) { return x.name === name; });
    var o = g ? U.find(g.options, function (x) { return x.value === value; }) : null;
    if (name === 'year') return yearLabel(o ? o.label : value);
    if (name === 'min') return 'IMDb ' + value + '+';
    return o ? o.label : value;
  }

  /* One pill per chosen value, in the sheet's order: [{group, value, label}]. Two or more countries share one pill. */
  function pills(f, groupsList) {
    f = norm(f);
    var out = [];
    U.each(groupsList, function (g) {
      var v = f[g.name];
      if (isArray(v)) {
        if (g.name === 'country' && v.length > 2) { out.push({ group: g.name, value: '', label: v.length + ' countries' }); return; }
        U.each(v, function (x) { out.push({ group: g.name, value: x, label: labelOf(groupsList, g.name, x) }); });
      } else if (v) out.push({ group: g.name, value: v, label: g.name === 'sort' ? (SORT_PILLS[v] || labelOf(groupsList, g.name, v)) : labelOf(groupsList, g.name, v) });
    });
    return out;
  }

  function summary(f, groupsList) { return U.map(pills(f, groupsList), function (p) { return p.label; }).join(' · '); }

  /* ---------- The filter sheet ---------- */

  /* opts: {kind, title, groups, value, focus: groupName, onApply(f)}. Changes show at once in the sheet; they apply
     when it closes (Back or Show titles). Reset all clears every group and stays open. */
  function sheet(opts) {
    var kind = kindOf(opts.kind), list = opts.groups || groups(kind, null);
    var draft = norm(opts.value), start = key(draft);
    var s = Overlays.sheet({ name: 'filters', kicker: 'Filter and sort', title: opts.title || (kind === 'tv' ? 'TV Shows' : 'Movies'),
      hint: 'OK chooses · Back shows the titles' });
    U.toggleClass(s.box, 'mb-sheet--filters', true);
    var sub = U.qs(s.box, '.mb-sheet-sub');
    var acts = Kit.zone(el('div', 'mb-btns mb-filter-acts', null, s.list), 'buttons:filter-acts');
    Kit.button({ label: 'Show titles', icon: 'check', action: 'filters-apply', parent: acts, primary: true, key: 'filters|apply' }).__run = function () { close(true); };
    Kit.button({ label: 'Reset all', icon: 'reload', action: 'filters-reset', parent: acts, key: 'filters|reset' }).__run = function () {
      draft = norm(null);
      paint();
    };
    var chips = [], focusNode = null;
    U.each(list, function (g) {
      var head = el('div', 'mb-sheet-label mb-filter-label', g.title, s.list);
      if (g.local) el('span', 'mb-filter-note', 'Checked on this TV', head);
      else if (g.multi) el('span', 'mb-filter-note', 'Choose any', head);
      var row = Kit.zone(el('div', 'mb-chiprow mb-filter-group', null, s.list), 'fgroup:' + g.name);
      row.setAttribute('data-filter-group', g.name);
      var all = [{ value: '', label: anyLabel(g.name, kind) }].concat(g.options);
      U.each(all, function (o) {
        var c = Kit.chip(g.name === 'year' ? yearLabel(o.label) : o.label, { key: 'f|' + g.name + '|' + o.value, parent: row });
        c.setAttribute('data-filter', g.name);
        c.setAttribute('data-value', o.value);
        c.__run = function () { toggle(g, o.value); };
        chips.push(c);
      });
    });

    function chosen(name, value) {
      var v = draft[name];
      if (isArray(v)) return value === '' ? !v.length : U.indexOf(v, value) >= 0;
      return (v || '') === value;
    }

    function toggle(g, value) {
      if (g.multi) {
        if (value === '') draft[g.name] = [];
        else {
          var i = U.indexOf(draft[g.name], value);
          if (i >= 0) draft[g.name].splice(i, 1); else draft[g.name].push(value);
        }
      } else draft[g.name] = value;
      paint();
    }

    function paint() {
      U.each(chips, function (c) {
        var on = chosen(c.getAttribute('data-filter'), c.getAttribute('data-value'));
        U.toggleClass(c, 'is-selected', on);
        if (on && !focusNode) focusNode = c;
      });
      var text = summary(draft, list);
      if (sub) sub.textContent = text || 'Showing everything, newest first';
    }

    /* The sheet scrolls to keep the focused chip in view, with its group's title when it is on the group's first line. */
    function reveal(n) {
      if (!n || !s.port) return;
      var row = n.parentNode, label = row && row.previousSibling;
      if (row && U.hasClass(row, 'mb-filter-group') && label && row.firstChild && n.offsetTop === row.firstChild.offsetTop) Kit.reveal(s.list, s.port, label, Kit.em() * 0.5, Kit.em() * 2);
      Kit.reveal(s.list, s.port, n, Kit.em() * 1.5, Kit.em() * 2);
    }

    function close(apply) {
      App.closeLayer('sheet');
      if (apply && key(draft) !== start && opts.onApply) opts.onApply(norm(draft));
    }

    paint();
    var first = opts.focus ? U.qs(s.list, '[data-filter="' + opts.focus + '"].is-selected') || U.qs(s.list, '[data-filter="' + opts.focus + '"]') : null;
    App.openLayer('sheet', s.layer, {
      focus: first || U.qs(s.list, '[data-filter-group] .is-selected') || Focus.firstIn(s.list), name: 'filters',
      onFocus: function (n) { reveal(n); },
      onBack: function () { close(true); }
    });
    return s;
  }

  /* ---------- People ---------- */

  /* A person result card (round picture or initials, name, "130 movies · 38 shows"). OK opens the person screen. */
  function personCard(p) {
    var c = el('div', 'mb-card mb-card--person');
    Kit.focusable(c, 'grid|' + p.key);
    c.setAttribute('data-person', p.id);
    c.__person = p;
    var art = el('div', 'mb-card-art mb-person-art', null, c);
    var initials = U.map(String(p.name || '').split(/\s+/).slice(0, 2), function (w) { return w.charAt(0); }).join('').toUpperCase();
    el('span', 'mb-person-initials', initials, art);
    if (p.image) Kit.img(p.image, { cls: 'mb-card-img', parent: art, w: 300 });
    el('div', 'mb-card-title', p.name || '', c);
    /* "130 movies · 38 shows", wrapping only between the two counts. */
    var counts = [];
    if (p.movies > 0) counts.push(p.movies === 1 ? '1\u00a0movie' : p.movies + '\u00a0movies');
    if (p.shows > 0) counts.push(p.shows === 1 ? '1\u00a0show' : p.shows + '\u00a0shows');
    if (counts.length) el('div', 'mb-card-sub', counts.join(' · '), c);
    return c;
  }

  /* The browse screen's parameters for a person: their movies and their TV shows (the website's actor_works lists),
     movies first unless they have none. p: {id, name, image?, movies?, shows?, job?} (a search result or a cast entry). */
  function personParams(p) {
    var id = String(p.id || '');
    var movies = Site.url.personWorks(id, 'movie'), shows = Site.url.personWorks(id, 'tv');
    var counts = [];
    if (p.movies >= 0) counts.push(p.movies === 1 ? '1 movie' : p.movies + ' movies');
    if (p.shows >= 0) counts.push(p.shows === 1 ? '1 TV show' : p.shows + ' TV shows');
    return {
      url: p.movies === 0 && p.shows > 0 ? shows : movies, title: p.name || 'Person', kicker: p.job || 'Person',
      tabs: [{ label: 'Movies', href: movies }, { label: 'TV Shows', href: shows }],
      person: { id: id, name: p.name || '', image: p.image || '', meta: counts.join(' · ') }
    };
  }

  /* The search screen's quick browse entry points: [{label, filters}] for genres and years. */
  function quick(kind) {
    var spec = null;
    try { spec = Site.filterSpec(kindOf(kind)); } catch (e) { spec = null; }
    var genres = [], years = [];
    var gg = spec ? U.find(spec.groups, function (g) { return g.name === 'genr'; }) : null;
    U.each(QUICK_GENRES, function (id) {
      var o = gg ? U.find(gg.options, function (x) { return x.value === id; }) : null;
      if (o) genres.push({ label: o.label, filters: { genr: [id] } });
    });
    U.each(QUICK_YEARS, function (y) { years.push({ label: yearLabel(y), filters: { year: y } }); });
    return { genres: genres, years: years };
  }

  return {
    norm: norm, same: same, isEmpty: isEmpty, load: load, save: save, url: url, groups: groups, pills: pills,
    summary: summary, labelOf: labelOf, yearLabel: yearLabel, sheet: sheet, personCard: personCard,
    personParams: personParams, quick: quick
  };
}());
