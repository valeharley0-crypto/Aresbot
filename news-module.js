/* ARES — module NEWS de l'interface (chargé par index.html via <script src="news-module.js">).
 * Remplit le panneau 📰 NEWS (#newsListWrap, #newsAutoTradeStatus, #newsDetailCard) avec le calendrier RÉEL du serveur :
 *   GET /api/mentor/news/calendar  (événements Forex Factory USD, impact high/medium)
 *   GET /api/mentor/news           (état du filtre IA Mentor : pause, calendrier périmé, prochain événement)
 * Aucune donnée simulée : flux indisponible => « NEWS UNAVAILABLE ». Les appels passent par window.__aresApi (clé MENTOR_API_KEY).
 * Expose window.AresNews = { getPauseInfo(), refresh(), events() }  (utilisé par le garde-fou Auto Trade de l'interface).
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var state = {
    calendar: null,   // réponse de /api/mentor/news/calendar
    mentor: null,     // réponse de /api/mentor/news
    error: '',        // '' | 'key' | 'net'
    selected: null,
    lastList: '',
    lastStatus: ''
  };

  function api(path) {
    if (typeof window.__aresApi !== 'function') return Promise.reject(new Error('key'));
    return window.__aresApi(path);
  }

  function fmtTime(iso) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return '—';
    try {
      return new Date(t).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return iso; }
  }

  function val(v) { return v == null || v === '' ? '—' : esc(v); }

  function minutesTo(iso) {
    var t = Date.parse(iso);
    return isFinite(t) ? Math.round((t - Date.now()) / 60000) : null;
  }

  function countdown(iso) {
    var m = minutesTo(iso);
    if (m === null) return '';
    if (m < -1) return 'publié il y a ' + Math.abs(m) + ' min';
    if (m <= 0) return 'maintenant';
    if (m < 90) return 'dans ' + m + ' min';
    if (m < 2880) return 'dans ' + Math.round(m / 60) + ' h';
    return 'dans ' + Math.round(m / 1440) + ' j';
  }

  /* ---------- bandeau d'état (Auto Trade / NEWS) ---------- */
  function drawStatus() {
    var box = $('newsAutoTradeStatus');
    if (!box) return;
    var cls = 'news-status allowed', html;
    var m = state.mentor;

    if (state.error === 'key') {
      cls = 'news-status paused';
      html = '🔑 Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI.';
    } else if (state.error) {
      cls = 'news-status paused';
      html = '⚪ Serveur injoignable : NEWS UNAVAILABLE.';
    } else if (m && m.dataStale) {
      cls = 'news-status paused';
      html = '🔴 NEWS UNAVAILABLE — calendrier absent ou périmé : trading suspendu (règle de sécurité)' +
        '<div class="nsub">Aucune donnée réelle disponible. Rien n\'est inventé.</div>';
    } else if (m && m.paused) {
      cls = 'news-status paused';
      html = '🔴 AUTO TRADE EN PAUSE — ' + esc(m.event && m.event.title || 'news à fort impact') +
        '<div class="nsub">' + esc(m.status || '') + (m.countdownSec != null ? ' · ' + countdown(m.event && m.event.time) : '') + '</div>';
    } else if (m) {
      html = '🟢 AUTO TRADE ALLOWED' + (m.event ? '<div class="nsub">Prochaine news : ' + esc(m.event.title) + ' · ' + esc(countdown(m.event.time)) + '</div>' : '');
    } else {
      cls = 'news-status paused';
      html = '⚪ Chargement…';
    }

    var sig = cls + '|' + html;
    if (sig === state.lastStatus) return;
    state.lastStatus = sig;
    box.className = cls;
    box.innerHTML = html;
  }

  /* ---------- liste du calendrier ---------- */
  function drawList() {
    var wrap = $('newsListWrap');
    if (!wrap) return;
    var h;
    var c = state.calendar;

    if (state.error === 'key') {
      h = '<div class="empty">Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI (onglet Mentor).</div>';
    } else if (state.error) {
      h = '<div class="empty">Serveur injoignable : NEWS UNAVAILABLE.</div>';
    } else if (!c) {
      h = '<div class="empty">Chargement du calendrier économique…</div>';
    } else if (c.state === 'UNAVAILABLE' || c.available === false) {
      h = '<div class="empty"><b>NEWS UNAVAILABLE</b><br>Aucune donnée réelle disponible' + (c.error ? ' (' + esc(c.error) + ')' : '') +
        '.<br>Rien n\'est inventé. L\'IA Mentor continue de fonctionner ; le trading suit la règle « calendrier requis ».</div>';
    } else if (!c.events || !c.events.length) {
      h = '<div class="empty">Aucun événement USD (high / medium) dans les 7 prochains jours d\'après le flux réel.</div>' + footer(c);
    } else {
      h = c.events.map(function (e, i) {
        var imp = esc(e.impact || 'low');
        return '<div class="n-item ' + imp + '" data-i="' + i + '">' +
          '<div><div class="n-name">' + esc(e.title) + '</div>' +
          '<div class="n-meta">' + esc(fmtTime(e.time)) + ' · ' + esc(e.currency) + ' · ' + esc(countdown(e.time)) + '</div></div>' +
          '<div class="n-right"><span class="n-badge ' + imp + '">' + imp.toUpperCase() + '</span><br>' +
          'Prév. ' + val(e.forecast) + ' · Préc. ' + val(e.previous) + '</div></div>';
      }).join('') + footer(c);
    }

    if (h === state.lastList) return;
    state.lastList = h;
    wrap.innerHTML = h;
  }

  function footer(c) {
    var upd = c && c.fetchedAt ? fmtTime(c.fetchedAt) : '—';
    return '<div class="disclaimer">Source : ' + esc(c && c.source || 'calendrier') + ' · dernière mise à jour ' + esc(upd) +
      ' · heures affichées dans le fuseau de ton appareil. Prévision / précédent = valeurs du flux, « — » si non publiées. Information, pas un conseil ni une promesse de gain.</div>';
  }

  /* ---------- détail d'un événement ---------- */
  function openDetail(i) {
    var e = state.calendar && state.calendar.events && state.calendar.events[i];
    var card = $('newsDetailCard');
    if (!e || !card) return;
    state.selected = e.id || i;
    var t = $('newsDetailTitle'), b = $('newsDetailBody');
    if (t) t.textContent = e.title;
    if (b) {
      b.innerHTML =
        '<div class="scn-row"><span>Heure</span><b>' + esc(fmtTime(e.time)) + '</b></div>' +
        '<div class="scn-row"><span>Devise · impact</span><b>' + esc(e.currency) + ' · ' + esc(String(e.impact).toUpperCase()) + '</b></div>' +
        '<div class="scn-row"><span>Prévision</span><b>' + val(e.forecast) + '</b></div>' +
        '<div class="scn-row"><span>Précédent</span><b>' + val(e.previous) + '</b></div>' +
        '<div class="scn-row"><span>Réel</span><b>' + val(e.actual) + '</b></div>' +
        '<div class="ai-note">Le biais Gold n\'est calculé par l\'IA Mentor que pour les événements à fort impact avec une catégorie et des valeurs réelles ; sinon DATA_UNAVAILABLE.</div>';
    }
    card.classList.add('open');
  }

  document.addEventListener('click', function (ev) {
    var item = ev.target.closest && ev.target.closest('#newsListWrap .n-item');
    if (item) return openDetail(Number(item.getAttribute('data-i')));
    if (ev.target && ev.target.id === 'newsDetailClose') {
      var card = $('newsDetailCard');
      if (card) card.classList.remove('open');
    }
  });

  /* ---------- rafraîchissement ---------- */
  function visible() {
    var p = $('panelNews');
    return !!p && p.style.display !== 'none';
  }

  function fail(e) { state.error = e && e.message === 'key' ? 'key' : 'net'; }

  function refresh() {
    return Promise.all([
      api('/api/mentor/news/calendar?currency=USD&impact=high,medium&days=7').then(function (j) { state.calendar = j; }),
      api('/api/mentor/news').then(function (j) { state.mentor = j; })
    ]).then(function () { state.error = ''; })
      .catch(fail)
      .then(function () { drawStatus(); drawList(); });
  }

  function tick() { if (visible()) refresh(); }

  /* ---------- API publique ---------- */
  window.AresNews = {
    /** { paused, event: { name } } : pause news active côté IA Mentor (donnée réelle du serveur) */
    getPauseInfo: function () {
      var m = state.mentor;
      if (m && m.paused && !m.dataStale && m.event) return { paused: true, event: { name: m.event.title || 'News' } };
      return { paused: false, event: null };
    },
    refresh: refresh,
    events: function () { return state.calendar && state.calendar.events ? state.calendar.events.slice() : []; }
  };

  ['tabPanelNews'].forEach(function (id) {
    var b = $(id);
    if (b) b.addEventListener('click', function () { setTimeout(refresh, 150); });
  });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('#aresSidebar3D [data-t="tabPanelNews"]');
    if (t) setTimeout(refresh, 250);
  });

  setInterval(tick, 20000);
  setTimeout(function () { drawStatus(); drawList(); tick(); }, 1500);
  // Le garde-fou Auto Trade a besoin de l'état de pause même quand l'onglet NEWS est fermé.
  setInterval(function () {
    if (!visible()) api('/api/mentor/news').then(function (j) { state.mentor = j; state.error = ''; }).catch(function () {});
  }, 20000);
})();
