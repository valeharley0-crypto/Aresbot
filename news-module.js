/* ARES — module NEWS de l'interface (chargé par index.html via <script src="news-module.js">).
 * Panneau 📰 NEWS : news USA à fort impact uniquement, avec l'ANALYSE FONDAMENTALE de l'IA Mentor (serveur, fundamental.js).
 *   GET /api/mentor/news/calendar  -> événements USD (réels, Forex Factory) + analysis { pairBias BUY/SELL, confidence, drivers, scenarios }
 *   GET /api/mentor/news           -> état du filtre IA Mentor (pause, calendrier périmé, prochain événement, paires tradées)
 *   GET /api/mentor/log            -> alertes récentes (analyses et décisions news)
 * Aucune donnée simulée : flux indisponible => « NEWS UNAVAILABLE ». Plus d'IA externe (Gemini supprimée), aucune clé requise.
 * Les heures sont affichées en heure de Madagascar (Indian/Antananarivo).
 * Expose window.AresNews = { getPauseInfo(), refresh(), events() }  (utilisé par le garde-fou Auto Trade de l'interface).
 */
(function () {
  'use strict';

  var TZ = 'Indian/Antananarivo';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  var state = { calendar: null, mentor: null, logs: null, error: '', open: {}, lastCards: '', lastStatus: '', lastAlerts: '', lastFooter: '' };
  var PAIRS = [['XAUUSD', 'XAU/USD'], ['EURUSD', 'EUR/USD'], ['GBPUSD', 'GBP/USD'], ['USDJPY', 'USD/JPY'], ['USDCHF', 'USD/CHF'], ['USDCAD', 'USD/CAD']];

  /* ---------- styles propres au module (le panneau reste autonome) ---------- */
  (function css() {
    if ($('newsCardsCss')) return;
    var st = document.createElement('style'); st.id = 'newsCardsCss';
    st.textContent =
      '#newsCards .nw-card{background:var(--panel-2,#0f1a2e);border:1px solid var(--line,#26324a);border-left:4px solid #ff3d71;border-radius:16px;padding:16px 16px 14px;margin-bottom:14px;cursor:pointer}' +
      '#newsCards .nw-card.done{opacity:.78}' +
      '#newsCards .nw-title{font-size:19px;font-weight:800;line-height:1.25}' +
      '#newsCards .nw-meta{font-size:13px;color:var(--muted,#8292aa);margin-top:4px}' +
      '#newsCards .nw-badge{display:inline-block;margin-top:12px;padding:5px 12px;border-radius:999px;background:rgba(255,61,113,.16);color:#ff3d71;font:700 13px "JetBrains Mono",monospace;letter-spacing:.05em}' +
      '#newsCards .nw-cd{font:700 20px "JetBrains Mono",monospace;margin:10px 0 2px;line-height:1.3}' +
      '#newsCards .nw-vals{display:flex;gap:22px;margin-top:14px}' +
      '#newsCards .nw-vals i{display:block;font-style:normal;font-size:14px;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-vals b{display:block;font-size:19px;margin-top:2px}' +
      '#newsCards .nw-lbl{font-size:13px;color:var(--muted,#8292aa);text-transform:uppercase;letter-spacing:.04em;margin-top:14px}' +
      '#newsCards .nw-gold{font-size:19px;font-weight:800;margin-top:2px}' +
      '#newsCards .nw-pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
      '#newsCards .nw-pill{padding:7px 14px;border-radius:999px;border:1px solid;font-size:14px;font-weight:700;white-space:nowrap}' +
      '#newsCards .nw-pause{margin-top:12px;font-weight:700;color:#ff3d71;font-size:15px}' +
      '#newsCards .nw-tap{margin-top:12px;font-size:14px;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-detail{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#26324a);font-size:13px;line-height:1.55}' +
      '#newsCards .nw-card.open .nw-detail{display:block}' +
      '#newsCards .nw-detail h4{margin:10px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-detail .nw-d{margin:4px 0}' +
      '#newsCards .nw-detail .nw-sc{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}' +
      '#newsCards .nw-mini{padding:3px 9px;border-radius:999px;border:1px solid;font-size:12px;font-weight:700;white-space:nowrap}' +
      '#newsCards .nw-note{font-size:12px;color:var(--muted,#8292aa);font-style:italic;margin-top:8px}' +
      '#newsFooter{font-size:13px;color:var(--muted,#8292aa);padding:14px 16px;background:rgba(130,146,170,.08);border-radius:12px;margin:6px 0 18px;line-height:1.5}' +
      '#newsFooter a{color:#00d4ff}' +
      '#newsAlertsWrap .nw-al{display:flex;gap:10px;padding:8px 0;border-bottom:1px solid rgba(130,146,170,.12);font-size:13px}' +
      '#newsAlertsWrap .nw-al time{color:var(--muted,#8292aa);font-family:"JetBrains Mono",monospace;white-space:nowrap}';
    document.head.appendChild(st);
  })();

  function api(path) {
    if (typeof window.__aresApi !== 'function') return Promise.reject(new Error('key'));
    return window.__aresApi(path);
  }

  /* ---------- heures (Madagascar) ---------- */
  function dayMg(t) { try { return new Date(t).toLocaleDateString('fr-FR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: 'short' }); } catch (e) { return ''; } }
  function hmMg(t) { try { return new Date(t).toLocaleTimeString('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function fmtTime(iso) { var t = Date.parse(iso); return isFinite(t) ? dayMg(t) + ' · ' + hmMg(t) : '—'; }
  function val(v) { return v == null || v === '' ? '—' : esc(v); }
  function hms(sec) {
    var neg = sec < 0; sec = Math.abs(Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (neg ? '-' : '') + [h, m, s].map(function (x) { return String(x).padStart(2, '0'); }).join(':');
  }
  function cdText(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return '';
    var sec = Math.round((t - Date.now()) / 1000);
    if (sec > 0) return 'News in :<br>' + hms(sec);
    var min = Math.floor(-sec / 60);
    return min < 1 ? 'Publiée à l\'instant' : 'Publiée il y a ' + (min < 90 ? min + ' min' : Math.round(min / 60) + ' h');
  }

  /* ---------- bandeau d'état Auto Trade ---------- */
  function drawStatus() {
    var box = $('newsAutoTradeStatus');
    if (!box) return;
    var cls = 'news-status allowed', html, m = state.mentor;
    if (state.error === 'key') { cls = 'news-status paused'; html = '🔑 Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI.'; }
    else if (state.error) { cls = 'news-status paused'; html = '⚪ Serveur injoignable : NEWS UNAVAILABLE.'; }
    else if (m && m.dataStale) {
      cls = 'news-status paused';
      html = '🔴 NEWS UNAVAILABLE — calendrier absent ou périmé : trading suspendu (règle de sécurité)<div class="nsub">Aucune donnée réelle disponible. Rien n\'est inventé.</div>';
    } else if (m && m.paused) {
      cls = 'news-status paused';
      html = '🔴 AUTO TRADE EN PAUSE — ' + esc(m.event && m.event.title || 'news à fort impact') + '<div class="nsub">' + esc(m.status || '') + '</div>';
    } else if (m) {
      html = '🟢 AUTO TRADE ALLOWED' + (m.event ? '<div class="nsub">Prochaine news : ' + esc(m.event.title) + ' · ' + esc(fmtTime(m.event.time)) + ' (Madagascar)</div>' : '');
    } else { cls = 'news-status paused'; html = '⚪ Chargement…'; }
    var sig = cls + '|' + html;
    if (sig === state.lastStatus) return;
    state.lastStatus = sig; box.className = cls; box.innerHTML = html;
  }

  /* ---------- cartes d'événements ---------- */
  var col = function (b) { return b === 'BUY' ? '#00e676' : '#ff3d71'; };
  function pill(name, b, traded) {
    var c = col(b.bias);
    return '<span class="nw-pill" style="color:' + c + ';border-color:' + c + '"><b>' + name + '</b> ' + (b.bias === 'BUY' ? '▲ ' : '▼ ') + esc(b.bias) + ' ' + b.confidence + '%' + (traded ? ' 🤖' : '') + '</span>';
  }
  function mini(name, bias) { var c = col(bias); return '<span class="nw-mini" style="color:' + c + ';border-color:' + c + '">' + name + ' ' + (bias === 'BUY' ? '▲' : '▼') + ' ' + bias + '</span>'; }
  function goldImpact(a) {
    var g = a && a.goldImpact;
    return g === 'HIGH' ? '🔴 HIGH' : g === 'MEDIUM' ? '🟠 MEDIUM' : g === 'LOW' ? '🟢 LOW' : '—';
  }
  function isPaused(e) {
    var m = state.mentor;
    return !!(m && m.paused && !m.dataStale && m.event && Date.parse(m.event.time) === Date.parse(e.time) && String(m.event.title) === String(e.title));
  }

  function detailHtml(e) {
    var a = e.analysis;
    if (!a) return '<div class="nw-d">' + esc(e.analysisError || 'Analyse indisponible') + '</div>';
    var h = '<h4>Lecture fondamentale · ' + esc(a.indicator && a.indicator.label || '') + '</h4>';
    h += (a.drivers || []).map(function (d) { return '<div class="nw-d"><b>' + esc(d.label) + ' :</b> ' + esc(d.text) + '</div>'; }).join('');
    h += '<div class="nw-d"><b>Verdict :</b> dollar ' + (a.usd === 'STRONGER' ? 'plus fort ▲' : 'plus faible ▼') + ' (score ' + esc(a.usdScore) + ' sur ±1)' + (a.weak ? ' — conviction faible' : '') + '. XAU/USD <b style="color:' + col(a.bias) + '">' + esc(a.bias) + ' ' + a.confidence + '%</b>.</div>';
    if (a.scenarios && !a.published) {
      var s = a.scenarios;
      h += '<h4>Scénarios à la publication (surprise significative ±' + esc(s.threshold) + ')</h4>' +
        '<div class="nw-sc"><b>' + esc(s.usdUp.when) + '</b> → USD ▲ : ' + PAIRS.map(function (p) { return mini(p[1], s.usdUp.pairs[p[0]]); }).join('') + '</div>' +
        '<div class="nw-sc"><b>' + esc(s.usdDown.when) + '</b> → USD ▼ : ' + PAIRS.map(function (p) { return mini(p[1], s.usdDown.pairs[p[0]]); }).join('') + '</div>';
    }
    h += '<div class="nw-note">' + (a.published
      ? 'Biais post-news : calculé sur la surprise réelle (réel vs prévu).'
      : 'Biais pré-news : une attente (prévision vs précédent + contexte des 7 derniers jours), pas une certitude. Il est recalculé dès la publication du « Actual », qui décide de la direction réelle.') +
      ' La confiance mesure la conviction de l\'analyse, pas une probabilité de gain. Aucun profit garanti.</div>';
    return h;
  }

  function cardHtml(e, traded) {
    var a = e.analysis, post = a && a.published, t = Date.parse(e.time), past = isFinite(t) && t < Date.now();
    var h = '<div class="nw-card' + (past ? ' done' : '') + (state.open[e.id || e.time + e.title] ? ' open' : '') + '" data-k="' + esc(e.id || e.time + e.title) + '">' +
      '<div class="nw-title">' + esc(e.title) + '</div>' +
      '<div class="nw-meta">US · ' + esc(e.currency) + ' · ' + esc(dayMg(t)) + ' · ' + esc(hmMg(t)) + ' (Madagascar)</div>' +
      '<span class="nw-badge"' + (String(e.impact).toLowerCase() === 'high' ? '' : ' style="background:rgba(255,176,32,.16);color:#ffb020"') + '>' + (String(e.impact).toLowerCase() === 'high' ? '🔴 HIGH IMPACT' : '🟠 MEDIUM IMPACT') + '</span>' +
      '<div class="nw-cd" data-t="' + esc(e.time) + '">' + cdText(e.time) + '</div>' +
      '<div class="nw-vals"><span><i>Forecast</i><b>' + val(e.forecast) + '</b></span><span><i>Previous</i><b>' + val(e.previous) + '</b></span><span><i>Actual</i><b>' + (e.actual ? esc(e.actual) : '–') + '</b></span></div>' +
      '<div class="nw-lbl">Gold impact</div><div class="nw-gold">' + goldImpact(a) + '</div>';
    if (a && a.pairBias) {
      h += '<div class="nw-lbl">Biais par paire · ' + (post ? 'post-news' : 'pré-news') + '</div><div class="nw-pills">' +
        PAIRS.map(function (p) { return pill(p[1], a.pairBias[p[0]], traded.indexOf(p[0]) >= 0); }).join('') + '</div>';
    } else {
      h += '<div class="nw-lbl">Biais par paire</div><div class="nw-note">' + esc(e.analysisError || 'Analyse indisponible') + '</div>';
    }
    if (isPaused(e)) h += '<div class="nw-pause">⏸️ AUTO TRADE PAUSE ACTIVE (fenêtre de protection)</div>';
    h += '<div class="nw-tap">Touchez pour l\'analyse détaillée ' + (state.open[e.id || e.time + e.title] ? '▴' : '▾') + '</div>' +
      '<div class="nw-detail">' + detailHtml(e) + '</div></div>';
    return h;
  }

  function drawCards() {
    var box = $('newsCards'); if (!box) return;
    var c = state.calendar, h;
    if (state.error === 'key') h = '<div class="empty">Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI (onglet Mentor).</div>';
    else if (state.error) h = '<div class="empty">Serveur injoignable : NEWS UNAVAILABLE.</div>';
    else if (!c) h = '<div class="empty">Chargement du calendrier économique…</div>';
    else if (c.state === 'UNAVAILABLE' || c.available === false) h = '<div class="empty"><b>NEWS UNAVAILABLE</b><br>Aucune donnée réelle disponible' + (c.error ? ' (' + esc(c.error) + ')' : '') + '.<br>Rien n\'est inventé.</div>';
    else {
      var list = (c.events || []).filter(function (e) { return String(e.currency).toUpperCase() === 'USD'; });
      var traded = (state.mentor && state.mentor.tradeSymbols) || [];
      h = list.length ? list.map(function (e) { return cardHtml(e, traded); }).join('') : '<div class="empty">Aucune news USA dans la fenêtre d\'après le flux réel.</div>';
    }
    if (h === state.lastCards) return;
    state.lastCards = h; box.innerHTML = h;
  }

  function drawFooter() {
    var box = $('newsFooter'); if (!box) return;
    var c = state.calendar, upd = c && c.fetchedAt ? hmMg(Date.parse(c.fetchedAt)) : '—';
    var h = 'Données du calendrier : ' + esc(c && c.source || 'calendrier') + ' · dernière mise à jour ' + esc(upd) + ' · heures affichées en heure de Madagascar. Membres : lecture seule. Information, pas un conseil ni une promesse de gain.';
    if (h !== state.lastFooter) { state.lastFooter = h; box.innerHTML = h; }
  }

  function drawAlerts() {
    var box = $('newsAlerts'); if (!box) return;
    var rows = (state.logs || []).filter(function (l) { return l && l.kind === 'news'; }).slice(-8).reverse();
    var h = rows.length ? rows.map(function (l) {
      return '<div class="nw-al"><time>' + esc(dayMg(Date.parse(l.timestamp))) + ' ' + esc(hmMg(Date.parse(l.timestamp))) + '</time><span><b>' + esc(l.decision) + '</b> — ' + esc(l.reason) + '</span></div>';
    }).join('') : '<div class="empty" style="padding:18px 0">Aucune alerte pour le moment.</div>';
    if (h !== state.lastAlerts) { state.lastAlerts = h; box.innerHTML = h; }
  }

  document.addEventListener('click', function (ev) {
    var card = ev.target.closest && ev.target.closest('#newsCards .nw-card');
    if (!card) return;
    var k = card.getAttribute('data-k');
    state.open[k] = !state.open[k];
    card.classList.toggle('open', !!state.open[k]);
    state.lastCards = '';   // force le prochain rendu à refléter l'état ouvert/fermé
    var tap = card.querySelector('.nw-tap');
    if (tap) tap.textContent = 'Touchez pour l\'analyse détaillée ' + (state.open[k] ? '▴' : '▾');
  });

  /* ---------- rafraîchissement ---------- */
  function visible() { var p = $('panelNews'); return !!p && p.style.display !== 'none'; }
  function fail(e) { state.error = e && e.message === 'key' ? 'key' : 'net'; }
  function redraw() { drawStatus(); drawCards(); drawFooter(); drawAlerts(); }

  var tickN = 0;
  function refresh() {
    tickN++;
    var jobs = [
      api('/api/mentor/news/calendar?currency=USD&impact=high,medium&days=7&past=24').then(function (j) { state.calendar = j; }),
      api('/api/mentor/news').then(function (j) { state.mentor = j; })
    ];
    if (tickN % 3 === 1) jobs.push(api('/api/mentor/log?n=300').then(function (j) { state.logs = (j && j.logs) || []; }).catch(function () {}));
    return Promise.all(jobs).then(function () { state.error = ''; }).catch(fail).then(redraw);
  }

  setInterval(function () {   // compte à rebours HH:MM:SS sans re-rendre les cartes
    if (!visible()) return;
    var els = document.querySelectorAll('#newsCards .nw-cd');
    for (var i = 0; i < els.length; i++) { var h = cdText(els[i].getAttribute('data-t')); if (els[i].innerHTML !== h) els[i].innerHTML = h; }
  }, 1000);

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

  ['tabPanelNews'].forEach(function (id) { var b = $(id); if (b) b.addEventListener('click', function () { setTimeout(refresh, 150); }); });
  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('#aresSidebar3D [data-t="tabPanelNews"]');
    if (t) setTimeout(refresh, 250);
  });

  setInterval(function () { if (visible()) refresh(); }, 8000);
  setTimeout(function () { redraw(); if (visible()) refresh(); }, 1500);
  // Le garde-fou Auto Trade a besoin de l'état de pause même quand l'onglet NEWS est fermé.
  setInterval(function () {
    if (!visible()) api('/api/mentor/news').then(function (j) { state.mentor = j; state.error = ''; }).catch(function () {});
  }, 20000);
})();
