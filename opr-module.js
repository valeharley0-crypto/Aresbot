/* ARES — panneau OPR (robot AUTOMATIQUE côté serveur). Chargé par index.html via <script src="opr-module.js">.
 *   GET  /api/mentor/opr          -> état du jour (range, tableau, signal), trades OPR, P/L
 *   POST /api/mentor/config {opr} -> ON/OFF du robot OPR
 * Pendant la fenêtre OPR (heure française) l'IA Mentor est en PAUSE : l'OPR continue seul, sans l'IA Mentor.
 * Aucune donnée simulée : sans bougies M5 réelles de cTrader => « DATA_UNAVAILABLE ». Aucun profit garanti.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var st = { d: null, err: '', last: '', busy: false };
  var G = '#00e676', R = '#ff3d71', Y = '#ffb020';

  function api(path, method, body) {
    if (typeof window.__aresApi !== 'function') return Promise.reject(new Error('key'));
    return window.__aresApi(path, method, body);
  }
  function money(v) { var n = Number(v) || 0; return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + ' $'; }
  function hm(iso) { try { return new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  var STAGES = {
    WAIT_RANGE: ['⏳', 'En attente du début de l\'OPR'], FORMING: ['🕒', 'OPR en formation…'], WATCHING: ['👀', 'Surveillance : cassure du range (clôture M5)'],
    RANGE_OUT: ['⛔', 'OPR hors limites : pas de trade aujourd\'hui'], EXPIRED: ['⌛', 'Fenêtre terminée'], BLOCKED: ['⛔', 'Pas de trade le vendredi'],
    CLOSED: ['💤', 'Marché fermé (week-end)'], NO_DATA: ['⚪', 'DATA_UNAVAILABLE : bougies M5 indisponibles']
  };

  function ensureCard() {
    var panel = $('panelOpr'); if (!panel) return null;
    var c = $('oprBotCard');
    if (!c) {
      c = document.createElement('div'); c.id = 'oprBotCard'; c.className = 'card'; c.style.cssText = 'margin-bottom:16px;border-left:4px solid ' + Y;
      panel.insertBefore(c, panel.firstChild);
      c.addEventListener('click', function (ev) {
        var b = ev.target.closest && ev.target.closest('[data-opr]'); if (!b || st.busy) return;
        var on = !(st.d && st.d.enabled && st.d.autoTrade);
        if (on && !window.confirm('Activer le robot OPR automatique ? Il enverra de VRAIS ordres sur cTrader (commence par un compte DEMO).')) return;
        st.busy = true;
        api('/api/mentor/config', 'POST', { opr: { enabled: on, autoTrade: on } }).then(refresh).catch(function (e) { st.err = e.message === 'key' ? 'key' : 'net'; draw(); }).then(function () { st.busy = false; });
      });
    }
    return c;
  }

  function draw() {
    var c = ensureCard(); if (!c) return;
    var d = st.d, h;
    if (st.err === 'key') h = '<div class="empty">Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI.</div>';
    else if (st.err || !d) h = '<div class="empty">' + (st.err ? 'Serveur injoignable.' : 'Chargement…') + '</div>';
    else {
      var on = d.enabled && d.autoTrade, S = STAGES[d.stage] || ['•', d.stage];
      h = '<div class="card-title"><span>🤖 ROBOT OPR · ' + esc(d.symbol) + ' · M5 · heure française</span><span style="font:700 12px monospace;color:' + (on ? G : R) + '">' + (on ? '● AUTO ON' : '○ AUTO OFF') + '</span></div>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
        '<button class="btn ' + (on ? '' : 'primary') + '" data-opr="1">' + (on ? '⏹ Arrêter le robot OPR' : '▶ Activer le robot OPR (automatique)') + '</button>' +
        '<span style="font-size:13px;font-weight:700;color:' + (d.mentorPaused ? Y : 'var(--muted,#8292aa)') + '">' + (d.mentorPaused ? '⏸ IA Mentor en PAUSE (OPR actif)' : 'IA Mentor : normal (hors fenêtre OPR)') + '</span></div>' +
        '<div style="font-size:14px;margin:6px 0"><b>' + S[0] + ' ' + esc(S[1]) + '</b>' + (d.note ? ' <span style="color:var(--muted,#8292aa)">· ' + esc(d.note) + '</span>' : '') + '</div>';
      if (d.range) h += '<div class="mono" style="font-size:13px;margin:4px 0 8px">Range OPR : haut <b>' + esc(d.range.hi) + '</b> · bas <b>' + esc(d.range.lo) + '</b> · <b style="color:' + (d.range.ok ? G : R) + '">' + esc(d.range.pips) + ' pips</b> (limites ' + esc(d.config.minPips) + '–' + esc(d.config.maxPips) + ')</div>';
      if (d.rows) h += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px">' + d.rows.map(function (r) {
        var col = r.ok == null ? 'var(--muted,#8292aa)' : r.ok ? G : R;
        return '<span style="padding:5px 12px;border-radius:999px;border:1px solid ' + col + ';color:' + col + ';font-size:13px;font-weight:700">' + esc(r.l) + ' ' + esc(r.v) + '</span>';
      }).join('') + '</div>';
      if (d.signal) h += '<div style="font-weight:800;font-size:16px;color:' + (d.signal.dir === 'BUY' ? G : R) + ';margin:6px 0">' + (d.signal.dir === 'BUY' ? '▲' : '▼') + ' Signal ' + esc(d.signal.dir) + ' (tableau tout vert)' + (d.today && d.today.done ? ' · ✅ trade envoyé' : (on ? ' · envoi au robot…' : ' · robot OFF : aucun ordre')) + '</div>';
      var s = d.stats || {};
      h += '<div style="display:flex;gap:22px;flex-wrap:wrap;margin:12px 0 6px">' +
        '<div><div style="font-size:12px;color:var(--muted,#8292aa)">P/L TOTAL OPR</div><b style="font-size:20px;color:' + ((s.pnlMoney || 0) >= 0 ? G : R) + '">' + money(s.pnlMoney) + '</b></div>' +
        '<div><div style="font-size:12px;color:var(--muted,#8292aa)">CE MOIS</div><b style="font-size:20px;color:' + ((s.monthPnl || 0) >= 0 ? G : R) + '">' + money(s.monthPnl) + '</b></div>' +
        '<div><div style="font-size:12px;color:var(--muted,#8292aa)">TRADES</div><b style="font-size:20px">' + esc(s.total || 0) + '</b> <small>' + esc(s.wins || 0) + ' TP · ' + esc(s.losses || 0) + ' SL</small></div>' +
        '<div><div style="font-size:12px;color:var(--muted,#8292aa)">WIN RATE</div><b style="font-size:20px">' + (s.winRate == null ? '—' : s.winRate + '%') + '</b></div></div>';
      var tr = (d.trades || []).slice(0, 10);
      h += tr.length ? '<div style="max-height:260px;overflow:auto"><table style="width:100%;font-size:13px"><thead><tr><th>Date (FR)</th><th>Sens</th><th>Entry</th><th>SL</th><th>TP</th><th>Résultat</th></tr></thead><tbody>' + tr.map(function (t) {
        var res = t.status === 'CLOSED' ? (t.outcome === 'WIN' ? '<b style="color:' + G + '">TP ✅ ' + money(t.pnlMoney) + '</b>' : t.outcome === 'LOSS' ? '<b style="color:' + R + '">SL ❌ ' + money(t.pnlMoney) + '</b>' : '➖ ' + money(t.pnlMoney)) : (t.status === 'OPEN' ? '⏳ OPEN' : esc(t.status));
        return '<tr><td>' + esc(hm(t.ts)) + '</td><td style="color:' + (t.action === 'BUY' ? G : R) + '">' + esc(t.action) + '</td><td>' + esc(Number(t.entry).toFixed(2)) + '</td><td>' + esc(Number(t.sl).toFixed(2)) + '</td><td>' + esc(Number(t.tp).toFixed(2)) + '</td><td>' + res + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="empty" style="padding:10px 0">Aucun trade OPR du robot pour le moment.</div>';
      h += '<div style="font-size:12px;color:var(--muted,#8292aa);margin-top:10px">OPR ' + esc(d.config.oprStart) + '–' + esc(d.config.oprEnd) + ' · entrée ' + esc(d.config.greenStart) + '–' + esc(d.config.redStart) + ' (heure française) · RSI ' + esc(d.config.rsiLen) + ' (' + esc(d.config.rsiOS) + '–' + esc(d.config.rsiOB) + ') · RR ' + esc(d.config.rr) + ' · risque ' + esc(d.config.riskPct) + '% · 1 trade/jour · pas de trade le vendredi. Aucun profit garanti.</div>';
    }
    if (h !== st.last) { st.last = h; c.innerHTML = h; }
  }

  function visible() { var p = $('panelOpr'); return !!p && p.style.display !== 'none'; }
  function refresh() {
    return api('/api/mentor/opr').then(function (j) { st.d = j; st.err = ''; }).catch(function (e) { st.err = e && e.message === 'key' ? 'key' : 'net'; }).then(draw);
  }
  ['tabPanelOpr'].forEach(function (id) { var b = $(id); if (b) b.addEventListener('click', function () { setTimeout(refresh, 150); }); });
  document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('#aresSidebar3D [data-t="tabPanelOpr"]'); if (t) setTimeout(refresh, 250); });
  setInterval(function () { if (visible()) refresh(); }, 8000);
  setTimeout(function () { ensureCard(); draw(); if (visible()) refresh(); }, 1500);
  window.AresOpr = { refresh: refresh };
})();

/* ---------- Panneau ROBOT : boutons SCALPING / DAY TRADE / LES DEUX / STOP + P/L par stratégie ---------- */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var G = '#00e676', R = '#ff3d71', st = { s: null, pl: null, err: '', last: '', busy: false };
  function api(p, m, b) { return typeof window.__aresApi === 'function' ? window.__aresApi(p, m, b) : Promise.reject(new Error('key')); }
  function money(v) { var n = Number(v) || 0; return '<b style="color:' + (n >= 0 ? G : R) + '">' + (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(2) + ' $</b>'; }
  function card() {
    var p = $('panelRobot'); if (!p) return null;
    var c = $('ctlCard');
    if (!c) {
      c = document.createElement('div'); c.id = 'ctlCard'; c.className = 'card'; c.style.cssText = 'margin-bottom:16px;border-left:4px solid #00d4ff';
      p.insertBefore(c, p.firstChild);
      c.addEventListener('click', function (ev) {
        var b = ev.target.closest && ev.target.closest('[data-ctl]'); if (!b || st.busy) return;
        var v = b.getAttribute('data-ctl'), seq;
        if (v !== 'STOP' && !window.confirm('Les ordres sont RÉELS sur cTrader. Continuer ? (DEMO conseillé au début)')) return;
        if (v === 'STOP') seq = [['/api/mentor/autotrade', { autoTrade: false }]];
        else if (v === 'BOTH') seq = [['/api/mentor/combined', { combined: true }], ['/api/mentor/autotrade', { autoTrade: true }]];
        else seq = [['/api/mentor/combined', { combined: false }], ['/api/mentor/mode', { tradingMode: v }], ['/api/mentor/autotrade', { autoTrade: true }]];
        st.busy = true;
        seq.reduce(function (pr, x) { return pr.then(function () { return api(x[0], 'POST', x[1]); }); }, Promise.resolve()).then(refresh).catch(function () { st.err = 'net'; draw(); }).then(function () { st.busy = false; });
      });
    }
    return c;
  }
  function draw() {
    var c = card(); if (!c) return; var s = st.s, pl = st.pl, h;
    if (st.err === 'key') h = '<div class="empty">Clé serveur requise : saisis MENTOR_API_KEY dans le panneau ARES AI.</div>';
    else if (!s) h = '<div class="empty">' + (st.err ? 'Serveur injoignable.' : 'Chargement…') + '</div>';
    else {
      var on = !!s.autoTrade, mode = s.combined ? 'BOTH' : s.tradingMode;
      var btn = function (k, label) { var a = on && mode === k; return '<button class="btn ' + (a ? 'primary' : '') + '" data-ctl="' + k + '" style="flex:1;min-width:120px;' + (a ? 'outline:2px solid ' + G : '') + '">' + label + (a ? ' ✅' : '') + '</button>'; };
      h = '<div class="card-title"><span>🎛 CONTRÔLE ROBOT</span><span style="font:700 12px monospace;color:' + (on ? G : R) + '">' + (on ? '● ' + (s.combined ? 'SCALPING + DAY TRADE' : s.tradingMode) + ' ACTIF' : '○ ARRÊTÉ') + '</span></div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap">' + btn('SCALPING', '⚡ SCALPING') + btn('DAYTRADE', '📈 DAY TRADE') + btn('BOTH', '🔁 LES DEUX') +
        '<button class="btn" data-ctl="STOP" style="flex:1;min-width:120px;' + (!on ? 'outline:2px solid ' + R : '') + '">⏹ STOP</button></div>' +
        '<div style="font-size:12px;color:var(--muted,#8292aa);margin:8px 0 14px">Score minimum 70 % · SCALPING M1/M3 · DAY TRADE M5/M15 (OR). Un bouton = ce mode seulement (l\'autre s\'arrête). LES DEUX = ensemble. STOP = plus de nouvelle entrée.</div>';
      if (pl && pl.categories) {
        var rows = Object.keys(pl.categories).map(function (k) { return pl.categories[k]; }).concat([pl.all]);
        h += '<div class="card-title" style="margin-top:6px"><span>📊 P/L par stratégie</span></div><div style="overflow:auto"><table style="width:100%;font-size:13px"><thead><tr><th>Stratégie</th><th>Aujourd\'hui</th><th>Mois</th><th>Total</th><th>Trades</th><th>TP/SL</th><th>Ouverts</th></tr></thead><tbody>' +
          rows.map(function (o) { return '<tr' + (o.label === 'TOTAL' ? ' style="font-weight:800;border-top:2px solid rgba(130,146,170,.4)"' : '') + '><td><b>' + esc(o.label) + '</b></td><td>' + money(o.today) + '</td><td>' + money(o.month) + '</td><td>' + money(o.total) + '</td><td>' + esc(o.trades) + '</td><td>' + esc(o.wins) + '/' + esc(o.losses) + '</td><td>' + esc(o.open) + '</td></tr>'; }).join('') + '</tbody></table></div>';
      }
    }
    if (h !== st.last) { st.last = h; c.innerHTML = h; }
  }
  function visible() { var p = $('panelRobot'); return !!p && p.style.display !== 'none'; }
  function refresh() {
    return Promise.all([api('/api/mentor/status').then(function (j) { st.s = j; }), api('/api/mentor/pl').then(function (j) { st.pl = j; })])
      .then(function () { st.err = ''; }).catch(function (e) { st.err = e && e.message === 'key' ? 'key' : 'net'; }).then(draw);
  }
  document.addEventListener('click', function (e) { var t = e.target.closest && e.target.closest('#tabPanelRobot,#aresSidebar3D [data-t="tabPanelRobot"]'); if (t) setTimeout(refresh, 250); });
  setInterval(function () { if (visible()) refresh(); }, 8000);
  setTimeout(function () { card(); draw(); if (visible()) refresh(); }, 1500);
})();
