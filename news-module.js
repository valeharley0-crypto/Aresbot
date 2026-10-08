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
    lastStatus: '',
    lastLive: ''
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


  /* ---------- carte « NEWS À VENIR » : annonce T-2h · analyse IA T-1h · entrée robot T-1min ---------- */
  var PAIRS = [['XAUUSD', 'XAU/USD'], ['EURUSD', 'EUR/USD'], ['GBPUSD', 'GBP/USD'], ['USDJPY', 'USD/JPY'], ['USDCHF', 'USD/CHF'], ['USDCAD', 'USD/CAD']];

  function hms(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    var neg = sec < 0; sec = Math.abs(Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (neg ? '-' : '') + [h, m, s].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
  }

  function phaseHtml(m, secLeft) {
    var t = m.timing || {}, aMin = t.analysisBeforeMin || 60, eSec = t.executeBeforeSec || 60;
    var steps = [
      { k: 'ann', label: 'Annonce', sub: 'T-' + ((t.announceBeforeMin || 120) / 60) + 'h', on: true },
      { k: 'ana', label: 'Analyse IA', sub: 'T-' + aMin + ' min', on: secLeft <= aMin * 60 },
      { k: 'ent', label: 'Entrée robot', sub: 'T-' + Math.round(eSec / 60) + ' min', on: secLeft <= eSec }
    ];
    return '<div style="display:flex;gap:6px;margin:10px 0">' + steps.map(function (x) {
      return '<div style="flex:1;text-align:center;padding:6px 2px;border-radius:10px;font-size:11px;border:1px solid ' +
        (x.on ? 'var(--cyan,#00d4ff)' : 'var(--line,#26324a)') + ';color:' + (x.on ? 'var(--cyan,#00d4ff)' : 'var(--muted,#8292aa)') + '">' +
        (x.on ? '✔ ' : '') + '<b>' + x.label + '</b><br>' + x.sub + '</div>';
    }).join('') + '</div>';
  }

  function pairsHtml(m) {
    var a = m.bias || {}, pb = a.pairBias, traded = (m.tradeSymbols || []);
    if (!pb) return '<div class="ai-note">Analyse IA : ' + esc(a.bias === 'PENDING' ? 'en attente (démarre à T-' + ((m.timing && m.timing.analysisBeforeMin) || 60) + ' min).' : (a.reason || 'DATA_UNAVAILABLE')) + '</div>';
    return '<div style="font-size:11px;color:var(--muted,#8292aa);margin-top:6px;text-transform:uppercase">Biais par paire · pré-news</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">' + PAIRS.map(function (p) {
        var b = pb[p[0]] || { bias: 'NEUTRAL', confidence: 0 };
        var col = b.bias === 'BUY' ? '#00e676' : b.bias === 'SELL' ? '#ff3d71' : '#8292aa';
        var arrow = b.bias === 'BUY' ? '▲ ' : b.bias === 'SELL' ? '▼ ' : '';
        var isT = traded.indexOf(p[0]) >= 0;
        return '<span style="padding:5px 10px;border-radius:999px;border:1px solid ' + col + ';color:' + col + ';font-size:12px;font-weight:700">' +
          p[1] + ' ' + arrow + esc(b.bias) + (b.confidence ? ' ' + b.confidence + '%' : '') + (isT ? ' 🤖' : '') + '</span>';
      }).join('') + '</div>' +
      '<div class="ai-note">🤖 = paire tradée par le robot (' + esc(traded.join(' + ')) + '). ' + esc(a.reason || '') + '</div>';
  }

  function drawLive() {
    var host = $('newsLiveBox');
    if (!host) {
      var ref = $('newsAutoTradeStatus');
      if (!ref || !ref.parentNode) return;
      host = document.createElement('div'); host.id = 'newsLiveBox';
      ref.parentNode.insertBefore(host, ref.nextSibling);
    }
    var m = state.mentor, html = '';
    if (m && !state.error && !m.dataStale && m.announced && m.event) {
      var e = m.event, secLeft = Math.round((Date.parse(e.time) - Date.now()) / 1000);
      var ex = m.execution;
      html = '<div style="margin:10px 0;padding:12px;border-radius:14px;background:var(--panel-2,#0f1a2e);border:1px solid #ff3d71;border-left-width:4px">' +
        '<div style="font-size:11px;color:#ff3d71;font-weight:800;letter-spacing:.06em">🚨 NEWS HIGH IMPACT ' + (secLeft > 0 ? 'À VENIR' : 'PUBLIÉE') + '</div>' +
        '<div style="font-size:16px;font-weight:800;margin:4px 0">' + esc(e.title) + '</div>' +
        '<div style="font-family:\'JetBrains Mono\',monospace;font-size:20px;font-weight:800">' + (secLeft > 0 ? 'News in : ' + hms(secLeft) : 'Publiée') + '</div>' +
        phaseHtml(m, secLeft) +
        '<div style="display:flex;gap:16px;font-size:12px"><span>Forecast <b>' + val(e.forecast) + '</b></span><span>Previous <b>' + val(e.previous) + '</b></span><span>Actual <b>' + val(e.actual) + '</b></span></div>' +
        pairsHtml(m) +
        (ex ? '<div style="margin-top:8px;font-size:12px">Exécution : <b>' + esc(ex.status) + '</b>' + (ex.reason ? ' — ' + esc(ex.reason) : '') + '</div>' : '') +
        '</div>';
    }
    if (html !== state.lastLive) { state.lastLive = html; host.innerHTML = html; }
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
      var lastDay = '', rows = '';
      c.events.forEach(function (e, i) {
        var imp = esc(e.impact || 'low');
        var d = new Date(e.time), dk = isNaN(d) ? '' : d.toLocaleDateString(undefined, { weekday: 'long', day: '2-digit', month: 'short' });
        if (dk !== lastDay) { lastDay = dk; rows += '<div class="nt-day">' + esc(dk || '—') + '</div>'; }
        var tm = isNaN(d) ? esc(fmtTime(e.time)) : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        rows += '<div class="n-item ' + imp + '" data-i="' + i + '">' +
          '<div class="nt-time">' + tm + '<small>' + esc(countdown(e.time)) + '</small></div>' +
          '<div class="nt-main"><span class="n-badge ' + imp + '">' + imp.toUpperCase() + '</span> <span class="nt-cur">' + esc(e.currency) + '</span>' +
          '<div class="n-name">' + esc(e.title) + '</div></div>' +
          '<div class="nt-vals"><span><i>Prév.</i><b>' + val(e.forecast) + '</b></span><span><i>Préc.</i><b>' + val(e.previous) + '</b></span><span><i>Réel</i><b>' + val(e.actual) + '</b></span></div></div>';
      });
      h = '<div class="nt-wrap">' + rows + '</div>' + footer(c);
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
      .then(function () { drawStatus(); drawList(); drawLive(); });
  }

  function tick() { if (visible()) refresh(); }
  setInterval(function () { if (visible()) drawLive(); }, 1000);   // compte à rebours HH:MM:SS

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

  setInterval(tick, 5000);
  setTimeout(function () { drawStatus(); drawList(); tick(); }, 1500);
  // Le garde-fou Auto Trade a besoin de l'état de pause même quand l'onglet NEWS est fermé.
  setInterval(function () {
    if (!visible()) api('/api/mentor/news').then(function (j) { state.mentor = j; state.error = ''; }).catch(function () {});
  }, 20000);
})();
