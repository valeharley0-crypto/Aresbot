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

  var state = { calendar: null, mentor: null, logs: null, error: '', stale: false, open: {}, lastCards: '', lastStatus: '', lastAlerts: '', lastFooter: '' };
  // Mémoire locale : au retour dans l'app (ou après rechargement par le navigateur) les cartes + leur analyse réapparaissent AU MÊME INSTANT
  // (plus de page vide qui « disparaît »), puis le serveur met à jour. Cartes ouvertes mémorisées aussi.
  var CK = 'ares_news_cal_v2', OK = 'ares_news_open_v2';
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* stockage plein/refusé : on continue sans */ } }
  (function restore() {
    var c = lsGet(CK); if (c && c.c && c.c.events) { state.calendar = c.c; state.stale = true; state.cachedAt = c.t; }
    var o = lsGet(OK); if (o && typeof o === 'object') state.open = o;
  })();
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
      '#newsCards .nw-tb{width:100%;border-collapse:collapse;margin-top:12px;font-size:14px}' +
      '#newsCards .nw-tb th{font-size:11px;color:var(--muted,#8292aa);text-transform:uppercase;letter-spacing:.04em;text-align:left;padding:4px 6px 6px 0;font-weight:600}' +
      '#newsCards .nw-tb td{padding:7px 6px 7px 0;border-top:1px solid rgba(130,146,170,.18);font-weight:700}' +
      '#newsCards .nw-tb td:first-child{font-weight:800}' +
      '#newsCards .nw-pause{margin-top:12px;font-weight:700;color:#ff3d71;font-size:15px}' +
      '#newsCards .nw-tap{margin-top:12px;font-size:14px;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-detail{display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#26324a);font-size:13px;line-height:1.55}' +
      '#newsCards .nw-card.open .nw-detail{display:block}' +
      '#newsCards .nw-detail h4{margin:10px 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-detail .nw-d{margin:4px 0}' +
      '#newsCards .nw-detail .nw-sc{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:6px 0}' +
      '#newsCards .nw-mini{padding:3px 9px;border-radius:999px;border:1px solid;font-size:12px;font-weight:700;white-space:nowrap}' +
      '#newsCards .nw-note{font-size:12px;color:var(--muted,#8292aa);font-style:italic;margin-top:8px}' +
      '#newsCards .nw-res{margin-top:14px;padding:12px 14px;border:2px solid;border-radius:14px;background:rgba(130,146,170,.06)}' +
      '#newsCards .nw-res-h{font:800 17px "JetBrains Mono",monospace;letter-spacing:.03em}' +
      '#newsCards .nw-res-pl{font:800 26px "JetBrains Mono",monospace;margin-top:4px}' +
      '#newsCards .nw-res-pl small{font-size:13px;font-weight:600;color:var(--muted,#8292aa)}' +
      '#newsCards .nw-res-tb{width:100%;border-collapse:collapse;margin-top:8px;font-size:13px}' +
      '#newsCards .nw-res-tb td{padding:5px 6px 5px 0;border-top:1px solid rgba(130,146,170,.18);font-weight:700}' +
      '#newsCards .nw-skip{margin-top:12px;font-size:13px;color:var(--muted,#8292aa)}' +
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
    if (state.error === 'key' && !m) { cls = 'news-status paused'; html = '🔑 Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI.'; }
    else if (state.error && !m) { cls = 'news-status paused'; html = '⚪ Serveur injoignable : NEWS UNAVAILABLE.'; }
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

  /* Résultat réel du robot sur cette news : TP atteint = « KILLED », SL = « SL HIT », avec le P/L en $ et en points. */
  function money(v) { var n = Number(v) || 0; return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + ' $'; }
  function resultHtml(g, name) {
    var ex = null, skip = null;
    g.forEach(function (x) {
      if (!ex && x.execution && x.execution.status === 'EXECUTED') ex = x;
      if (!skip && x.execution && ['NO_TRADE', 'BLOCKED', 'MISSED'].indexOf(x.execution.status) >= 0) skip = x.execution;
    });
    if (!ex) {
      return skip ? '<div class="nw-skip">🚫 Aucun trade sur ' + esc(name) + ' : ' + esc(skip.reason || skip.status) + '</div>' : '';
    }
    var r = ex.result || { state: 'OPEN', pnlMoney: 0, pnlPoints: 0 }, tr = ex.trades || [], st = r.state;
    var c = st === 'WIN' ? '#00e676' : st === 'LOSS' ? '#ff3d71' : '#ffb020';
    var head = st === 'WIN' ? '🏆 ' + name + ' KILLED ✅' : st === 'LOSS' ? '❌ ' + name + ' · SL HIT' : st === 'BREAKEVEN' ? '➖ ' + name + ' · BREAKEVEN' : '⏳ ' + name + ' · TRADE EN COURS';
    var h = '<div class="nw-res" style="border-color:' + c + '"><div class="nw-res-h" style="color:' + c + '">' + esc(head) + '</div>';
    if (st !== 'OPEN') h += '<div class="nw-res-pl" style="color:' + c + '">' + money(r.pnlMoney) + ' <small>(' + (Number(r.pnlPoints) >= 0 ? '+' : '') + esc(r.pnlPoints) + ' pts)</small></div>';
    h += '<table class="nw-res-tb">' + tr.map(function (t) {
      var res = t.status === 'CLOSED' ? (t.hit === 'TP' ? '✅ TP' : t.hit === 'SL' ? '❌ SL' : '➖ BE') : (t.status === 'OPEN' ? '⏳ OPEN' : esc(t.status));
      return '<tr><td>' + esc(t.symbol) + ' ' + (t.action === 'BUY' ? '▲' : '▼') + ' ' + esc(t.action) + (t.leg ? ' ' + esc(t.leg) : '') + '</td><td>' + res + '</td><td style="text-align:right">' + (t.pnlMoney == null ? '—' : money(t.pnlMoney)) + '</td></tr>';
    }).join('') + '</table></div>';
    return h;
  }

  /* Une seule carte par publication (même heure) : « Core CPI m/m » + « Core CPI y/y » = UN bloc avec un petit tableau.
   * Biais affiché seulement pour les paires réellement tradées par le robot (pas les 6 paires, pas de mélange BUY/SELL inutile). */
  function groupHtml(g, traded) {
    var e0 = g[0], t = Date.parse(e0.time), past = isFinite(t) && t < Date.now(), key = 'g' + e0.time;
    var ae = null; g.forEach(function (x) { if (!ae && x.analysis && x.analysis.pairBias) ae = x; });
    var a = ae && ae.analysis, post = a && a.published;
    var high = g.some(function (x) { return String(x.impact).toLowerCase() === 'high'; });
    var show = PAIRS.filter(function (p) { return traded.length ? traded.indexOf(p[0]) >= 0 : (p[0] === 'XAUUSD' || p[0] === 'EURUSD'); });
    var nm = ''; g.forEach(function (x) { if (!nm && x.execution && x.execution.status === 'EXECUTED' && x.key) nm = x.key; }); if (!nm && ae && ae.key) nm = ae.key; if (!nm) nm = (g[0] && g[0].key) || 'NEWS';
    var h = '<div class="nw-card' + (past ? ' done' : '') + (state.open[key] ? ' open' : '') + '" data-k="' + esc(key) + '">' +
      '<div class="nw-title">News USA · ' + esc(nm) + ' · ' + esc(hmMg(t)) + '</div>' +
      '<div class="nw-meta">US · USD · ' + esc(dayMg(t)) + ' (Madagascar)</div>' +
      '<span class="nw-badge"' + (high ? '' : ' style="background:rgba(255,176,32,.16);color:#ffb020"') + '>' + (high ? '🔴 HIGH IMPACT' : '🟠 MEDIUM IMPACT') + '</span>' +
      '<div class="nw-cd" data-t="' + esc(e0.time) + '">' + cdText(e0.time) + '</div>' +
      '<table class="nw-tb"><tr><th>Indicateur</th><th>Prév.</th><th>Préc.</th><th>Réel</th></tr>' +
      g.map(function (x) { return '<tr><td>' + esc(x.title) + '</td><td>' + val(x.forecast) + '</td><td>' + val(x.previous) + '</td><td>' + (x.actual ? esc(x.actual) : '–') + '</td></tr>'; }).join('') + '</table>' +
      '<div class="nw-lbl">Gold impact : <b>' + goldImpact(a) + '</b></div>';
    if (a) {
      h += '<div class="nw-lbl">Biais · ' + (post ? 'post-news' : 'pré-news') + '</div><div class="nw-pills">' +
        show.map(function (p) { return pill(p[1], a.pairBias[p[0]], true); }).join('') + '</div>';
    } else {
      h += '<div class="nw-note">' + esc((g[0] && g[0].analysisError) || 'Analyse indisponible') + '</div>';
    }
    h += resultHtml(g, nm);
    if (g.some(isPaused)) h += '<div class="nw-pause">⏸️ AUTO TRADE PAUSE ACTIVE (fenêtre de protection)</div>';
    h += '<div class="nw-tap">Touchez pour l\'analyse détaillée ' + (state.open[key] ? '▴' : '▾') + '</div>' +
      '<div class="nw-detail">' + detailHtml(ae || e0) + '</div></div>';
    return h;
  }

  function drawCards() {
    var box = $('newsCards'); if (!box) return;
    var c = state.calendar, h;
    if (state.error === 'key' && !c) h = '<div class="empty">Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI (onglet Mentor).</div>';
    else if (state.error && !c) h = '<div class="empty">Serveur injoignable : NEWS UNAVAILABLE.</div>';
    else if (!c) h = '<div class="empty">Chargement du calendrier économique…</div>';
    else if (c.state === 'UNAVAILABLE' || c.available === false) h = '<div class="empty"><b>NEWS UNAVAILABLE</b><br>Aucune donnée réelle disponible' + (c.error ? ' (' + esc(c.error) + ')' : '') + '.<br>Rien n\'est inventé.</div>';
    else {
      var list = (c.events || []).filter(function (e) { return String(e.currency).toUpperCase() === 'USD'; });
      var traded = (state.mentor && state.mentor.tradeSymbols) || [];
      var groups = {}, order = [];
      list.sort(function (x, y) { return Date.parse(x.time) - Date.parse(y.time); }).forEach(function (e) { var k = Date.parse(e.time); if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(e); });
      h = list.length ? order.map(function (k) { return groupHtml(groups[k], traded); }).join('') : '<div class="empty"><b>NFP · CPI · FOMC · PCE</b><br>Aucune de ces publications dans le calendrier réel pour les 14 prochains jours (le flux couvre la semaine en cours + la suivante). Elles apparaîtront ici automatiquement, avec leur analyse fondamentale, dès qu\'elles entrent dans le calendrier.</div>';
      if (state.stale && list.length) h = '<div class="nw-note" style="margin:0 0 10px">⚠️ Données en mémoire' + (state.cachedAt ? ' (dernière mise à jour ' + esc(hmMg(state.cachedAt)) + ')' : '') + ' — reconnexion au serveur…</div>' + h;
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
    state.open[k] = !state.open[k]; lsSet(OK, state.open);
    card.classList.toggle('open', !!state.open[k]);
    state.lastCards = '';   // force le prochain rendu à refléter l'état ouvert/fermé
    var tap = card.querySelector('.nw-tap');
    if (tap) tap.textContent = 'Touchez pour l\'analyse détaillée ' + (state.open[k] ? '▴' : '▾');
  });

  /* ---------- rafraîchissement ---------- */
  function visible() { var p = $('panelNews'); return !!p && p.style.display !== 'none'; }
  function fail(e) { state.error = e && e.message === 'key' ? 'key' : 'net'; }
  function redraw() { drawStatus(); drawCards(); drawFooter(); drawAlerts(); }

  var tickN = 0, busy = false;
  function refresh() {
    if (busy) return Promise.resolve();
    busy = true; tickN++;
    var jobs = [
      api('/api/mentor/news/calendar?currency=USD&impact=high&days=14&past=72').then(function (j) {
        var had = state.calendar && state.calendar.events && state.calendar.events.length;
        if (j && j.ok !== false && !((j.state === 'UNAVAILABLE' || j.available === false) && had)) {   // flux momentanément indisponible : on garde les cartes déjà connues
          state.calendar = j; state.stale = false; state.error = ''; lsSet(CK, { t: Date.now(), c: j });
        } else state.stale = true;
      }).catch(function (e) {
        if (e && e.message === 'key') state.error = 'key';
        else if (!state.calendar) state.error = 'net';
        else state.stale = true;
      }),
      api('/api/mentor/news').then(function (j) { state.mentor = j; }).catch(function () {})
    ];
    if (tickN % 3 === 1) jobs.push(api('/api/mentor/log?n=300').then(function (j) { state.logs = (j && j.logs) || []; }).catch(function () {}));
    return Promise.all(jobs).then(function () { busy = false; redraw(); }, function () { busy = false; redraw(); });
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

  setInterval(function () { if (visible() && !document.hidden) refresh(); }, 8000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { redraw(); if (visible()) refresh(); } });
  window.addEventListener('pageshow', function () { redraw(); if (visible()) refresh(); });
  redraw();   // affichage immédiat depuis la mémoire locale
  setTimeout(function () { redraw(); if (visible()) refresh(); }, 1500);
  // Le garde-fou Auto Trade a besoin de l'état de pause même quand l'onglet NEWS est fermé.
  setInterval(function () {
    if (!visible()) api('/api/mentor/news').then(function (j) { state.mentor = j; state.error = ''; }).catch(function () {});
  }, 20000);
})();
