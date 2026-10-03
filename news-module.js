/* =====================================================================
   news-module.js — NEWS & AI FUNDAMENTAL (XAU/USD) — module indépendant
   Source : FinanceCalendar (API publique, sans clé)
   https://www.financecalendar.com/wp-json/fc/v1  (/calendar, /today, /next)

   - Aucun secret dans ce fichier.
   - N'invente JAMAIS Actual / Forecast / Previous : champ absent => « — ».
   - N'exécute aucune logique du ROBOT : expose seulement window.AresNews.
   - Tout est encapsulé : une erreur ici ne bloque ni Chart, Signal,
     Backtest, Login ni ROBOT.
   ===================================================================== */
(function () {
  'use strict';
  try {

  /* ------------------------------ Config ------------------------------ */
  var FC_BASE = 'https://www.financecalendar.com/wp-json/fc/v1';
  var API = (window.ARES_API_BASE || '').replace(/\/$/, '');   // même serveur (Render)
  var REFRESH_MS = 5 * 60 * 1000;          // API mise en cache ~5 min côté source
  var FAST_REFRESH_MS = 60 * 1000;         // uniquement autour d'une publication en attente
  var DAYS_AHEAD = 7;
  var TZ_DISPLAY = 'Indian/Antananarivo';  // heure Madagascar (comme le reste du site)
  var LS_ALERTS = 'ares_news_alerts_v1';
  var LS_SETTINGS = 'ares_news_settings_cache_v1';
  var DEFAULTS = { protection: true, before: 30, after: 30, high: true, medium: false, low: false, aiFund: true, goldImpact: true };

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };

  var state = {
    settings: Object.assign({}, DEFAULTS),
    events: [],
    apiOk: null,            // null = inconnu, true/false
    rawCount: 0,
    lastFetch: 0,
    lastError: '',
    selectedId: null,
    alertLog: [],
    timer: null
  };

  /* ------------------------- Paramètres (lecture) ------------------------- */
  try { var c = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null'); if (c) state.settings = Object.assign({}, DEFAULTS, c); } catch (e) {}

  function normSettings(s) {
    s = s || {};
    var b = function (v, d) { return v === undefined ? d : (v === true || v === 'on' || v === 'true'); };
    var n = function (v, d) { v = +v; return isFinite(v) && v >= 0 && v <= 180 ? Math.round(v) : d; };
    return {
      protection: b(s.protection, DEFAULTS.protection), before: n(s.before, DEFAULTS.before), after: n(s.after, DEFAULTS.after),
      high: b(s.high, DEFAULTS.high), medium: b(s.medium, DEFAULTS.medium), low: b(s.low, DEFAULTS.low),
      aiFund: b(s.aiFund, DEFAULTS.aiFund), goldImpact: b(s.goldImpact, DEFAULTS.goldImpact)
    };
  }

  async function loadSettings() {
    try {
      var r = await fetch(API + '/api/news/settings', { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      state.settings = normSettings(j.settings || j);
      try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
    } catch (e) { /* on garde les valeurs en cache / par défaut */ }
    fillAdminForm();
  }

  /* ------------------------- Récupération API ------------------------- */
  function ymd(d) { return d.toISOString().slice(0, 10); }

  function extractList(data) {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      var keys = ['events', 'data', 'results', 'calendar', 'items'];
      for (var i = 0; i < keys.length; i++) if (Array.isArray(data[keys[i]])) return data[keys[i]];
      if (data.event && typeof data.event === 'object') return [data.event];
    }
    return [];
  }

  async function getJson(path) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, 15000);
    try {
      var r = await fetch(FC_BASE + path, { signal: ctl.signal, headers: { Accept: 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async function fetchAll() {
    var now = new Date();
    var to = new Date(now.getTime() + DAYS_AHEAD * 86400000);
    var from = new Date(now.getTime() - 86400000);           // hier : garde les news récentes (fenêtre « après »)
    var list = [];
    try {
      list = extractList(await getJson('/calendar?from=' + ymd(from) + '&to=' + ymd(to)));
    } catch (e1) {
      // repli : /today + /next
      var ok = false;
      try { list = list.concat(extractList(await getJson('/today'))); ok = true; } catch (e2) {}
      try { list = list.concat(extractList(await getJson('/next'))); ok = true; } catch (e3) {}
      if (!ok) throw e1;
    }
    return list;
  }

  /* ------------------------- Normalisation ------------------------- */
  function pick(o, keys) { for (var i = 0; i < keys.length; i++) { var v = o[keys[i]]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; } return null; }

  function parseTime(o) {
    var ts = pick(o, ['timestamp', 'time_ts', 'unix', 'epoch']);
    if (ts !== null && isFinite(+ts)) { ts = +ts; return ts < 1e12 ? ts * 1000 : ts; }
    var keys = ['time_utc', 'datetime_utc', 'date_utc', 'datetime', 'eventDate', 'releaseDate', 'date_time', 'date', 'time'];
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]]; if (!v) continue;
      var s = String(v).trim();
      // date seule + heure séparée
      if (/^\d{4}-\d{2}-\d{2}$/.test(s) && o.time && /^\d{1,2}:\d{2}/.test(String(o.time))) s = s + 'T' + String(o.time).trim().slice(0, 5).padStart(5, '0') + ':00Z';
      else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';   // sans fuseau => UTC (hypothèse à vérifier)
      var t = Date.parse(s);
      if (!isNaN(t)) return t;
    }
    return null;
  }

  function normImpact(o) {
    var raw = String(pick(o, ['impact', 'importance', 'priority', 'impactLevel', 'volatility']) || '').toLowerCase();
    if (/(^|\b)(3|high|red)(\b|$)/.test(raw) || raw.indexOf('high') >= 0) return 'high';
    if (/(^|\b)(2|medium|moderate|orange)(\b|$)/.test(raw) || raw.indexOf('med') >= 0) return 'medium';
    if (/(^|\b)(1|low|yellow)(\b|$)/.test(raw) || raw.indexOf('low') >= 0) return 'low';
    return 'low';
  }

  function isUsd(o, name) {
    var cur = String(pick(o, ['currency', 'countryCurrency', 'currency_code']) || '').toUpperCase();
    if (cur) return cur === 'USD';
    var ctry = String(pick(o, ['country', 'country_code', 'countryCode', 'region']) || '').toLowerCase();
    if (ctry) return ['us', 'usa', 'united states', 'united states of america'].indexOf(ctry) >= 0;
    return /fomc|federal reserve|nonfarm|non-farm|\bnfp\b|jobless|\bcpi\b|\bppi\b|\bpce\b|powell|\bfed\b/i.test(name);
  }

  function fmtVal(v) { if (v === null || v === undefined) return null; var s = String(v).trim(); return s === '' || s === '-' || s === 'null' ? null : s; }

  function normalize(list) {
    var out = [];
    list.forEach(function (o, idx) {
      if (!o || typeof o !== 'object') return;
      var name = String(pick(o, ['title', 'name', 'event', 'description']) || '').trim();
      var t = parseTime(o);
      if (!name || t === null) return;
      var cur = String(pick(o, ['currency', 'countryCurrency', 'currency_code']) || '').toUpperCase();
      var ctry = String(pick(o, ['country', 'country_code', 'countryCode', 'region']) || '').trim();
      var usd = isUsd(o, name);
      out.push({
        id: String(pick(o, ['id', 'event_id', 'uuid']) || (name + '|' + t)),
        name: name, ts: t, usd: usd,
        currency: cur || (usd ? 'USD' : '—'),
        country: ctry || (usd ? 'US' : '—'),
        impact: normImpact(o),
        forecast: fmtVal(pick(o, ['forecast', 'consensus', 'estimate', 'expected'])),
        previous: fmtVal(pick(o, ['previous', 'prior'])),
        actual: fmtVal(pick(o, ['actual', 'result'])),
        url: pick(o, ['url', 'link']) || null
      });
    });
    // dédoublonnage
    var seen = {}, res = [];
    out.forEach(function (e) { var k = e.name + '|' + e.ts; if (!seen[k]) { seen[k] = 1; res.push(e); } });
    return res.sort(function (a, b) { return a.ts - b.ts; });
  }

  /* ------------------------- Forecast / Previous (Forex Factory, via le serveur) ------------------------- */
  var FF_KINDS = [
    ['corecpi', /core cpi/i], ['cpi', /\bcpi\b|consumer price/i], ['corepce', /core pce/i], ['pce', /\bpce\b/i],
    ['nfp', /non-?farm|payroll/i], ['ahe', /average hourly/i], ['unemp', /unemployment rate/i],
    ['claims', /jobless|unemployment claims/i], ['ppi', /\bppi\b|producer price/i], ['gdp', /\bgdp\b/i],
    ['retail', /retail sales/i], ['adp', /\badp\b/i], ['jolts', /jolts|job openings/i], ['ism', /\bism\b/i],
    ['rates', /interest rate|fed funds|rate decision|fomc statement/i]
  ];
  function ffKind(n) { for (var i = 0; i < FF_KINDS.length; i++) if (FF_KINDS[i][1].test(n)) return FF_KINDS[i][0]; return null; }
  function missingVal(v) { return v === null || v === undefined || /^\s*[-\u2014\u2013]?\s*$/.test(String(v)); }
  async function enrichFF(events) {
    var r = await fetch(API + '/api/news/forecasts', { credentials: 'include' });
    if (!r.ok) return;
    var j = await r.json(), ff = (j && j.events) || [];
    events.forEach(function (ev) {
      var k = ffKind(ev.name); if (!k) return;
      for (var i = 0; i < ff.length; i++) {
        var f = ff[i];
        if (f.kind === k && Math.abs(f.ts - ev.ts) <= 2 * 3600000) {
          if (missingVal(ev.forecast) && f.forecastRaw) ev.forecast = f.forecastRaw;
          if (missingVal(ev.previous) && f.previousRaw) ev.previous = f.previousRaw;
          break;
        }
      }
    });
  }

  /* ------------------------- Analyse macro (règles) ------------------------- */
  // Catégories : sens de l'effet d'un Actual SUPÉRIEUR au Forecast sur l'or.
  // dir = -1 : Actual > Forecast => USD/yields en hausse => plutôt baissier Gold ; +1 : inverse.
  var CATS = [
    { key: 'rates',  re: /(fed|fomc).*(interest rate|rate decision|funds rate)|interest rate decision|federal funds/i, label: 'Décision de taux de la Fed', level: 'high', dir: -1, num: true },
    { key: 'cpi',    re: /core cpi|\bcpi\b|consumer price/i,                    label: 'Inflation CPI', level: 'high', dir: -1, num: true },
    { key: 'pce',    re: /core pce|\bpce\b|personal consumption expenditure/i,  label: 'Inflation PCE (indicateur préféré de la Fed)', level: 'high', dir: -1, num: true },
    { key: 'nfp',    re: /non-?farm|\bnfp\b|payrolls/i,                         label: "Emplois non agricoles (NFP)", level: 'high', dir: -1, num: true },
    { key: 'speech', re: /powell|fed chair|fomc (member|press|minutes)|fed (speak|speech|governor)|speaks|testif/i, label: 'Discours / communication de la Fed', level: 'high', dir: 0, num: false },
    { key: 'ppi',    re: /\bppi\b|producer price/i,                             label: 'Inflation PPI (prix producteurs)', level: 'medium', dir: -1, num: true },
    { key: 'unemp',  re: /unemployment rate/i,                                  label: 'Taux de chômage', level: 'medium', dir: +1, num: true },
    { key: 'claims', re: /jobless claims|unemployment claims/i,                 label: 'Inscriptions au chômage (Jobless Claims)', level: 'medium', dir: +1, num: true },
    { key: 'gdp',    re: /\bgdp\b|gross domestic/i,                             label: 'PIB (GDP)', level: 'medium', dir: -1, num: true },
    { key: 'retail', re: /retail sales/i,                                       label: 'Ventes au détail', level: 'medium', dir: -1, num: true },
    { key: 'jobs',   re: /adp|jolts|employment change|job openings/i,          label: "Indicateur d'emploi", level: 'medium', dir: -1, num: true },
    { key: 'activity', re: /ism|pmi|durable goods|industrial production|consumer confidence|michigan|housing|philadelphia|empire state/i, label: "Indicateur d'activité / confiance", level: 'low', dir: -1, num: true }
  ];

  function classify(ev) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].re.test(ev.name)) return CATS[i];
    return { key: 'other', label: 'Autre publication USD', level: ev.impact, dir: -1, num: true };
  }

  function toNum(s) {
    if (s === null || s === undefined) return null;
    var m = String(s).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    var v = parseFloat(m[0]), u = String(s).toUpperCase();
    if (/\dK\b/.test(u)) v *= 1e3; else if (/\dM\b/.test(u)) v *= 1e6; else if (/\dB\b/.test(u)) v *= 1e9;
    return v;
  }

  function goldImpactLevel(ev, cat) {
    var order = { low: 1, medium: 2, high: 3 };
    var lvl = cat.key === 'other' ? ev.impact : cat.level;
    if (ev.impact === 'low' && cat.key === 'other') lvl = 'low';
    return { level: lvl, score: order[lvl] };
  }

  function analyze(ev) {
    var cat = classify(ev), gi = goldImpactLevel(ev, cat);
    var res = { cat: cat, impact: gi.level, hasActual: false, verdict: 'NEUTRAL', buy: 50, sell: 50, surprise: null };
    var a = toNum(ev.actual), f = toNum(ev.forecast);
    if (cat.num && a !== null && f !== null && cat.dir !== 0) {
      res.hasActual = true;
      var diff = a - f, pct = /%/.test(String(ev.actual) + String(ev.forecast));
      var mag = pct ? Math.abs(diff) : (f !== 0 ? Math.abs(diff / f) * 100 : Math.abs(diff));
      var tiers = pct ? [0.05, 0.10, 0.20] : [1, 5, 15];
      var strength = mag < tiers[0] ? 0 : mag < tiers[1] ? 1 : mag < tiers[2] ? 2 : 3;
      res.surprise = diff === 0 ? 'inline' : (diff > 0 ? 'above' : 'below');
      if (strength === 0) { res.verdict = 'NEUTRAL'; }
      else {
        var goldUp = (diff > 0 ? cat.dir : -cat.dir) > 0;    // effet sur l'or
        var pctBuy = [50, 60, 70, 75][strength];
        res.verdict = goldUp ? 'BULLISH' : 'BEARISH';
        res.buy = goldUp ? pctBuy : 100 - pctBuy; res.sell = 100 - res.buy;
      }
    }
    // Avant la publication : biais « pré-news » = prévision vs précédent (signal plus faible, plafonné)
    if (!res.hasActual && cat.num && cat.dir !== 0) {
      var p0 = toNum(ev.previous);
      if (f !== null && p0 !== null) {
        var d2 = f - p0, pct2 = /%/.test(String(ev.forecast) + String(ev.previous));
        var mag2 = pct2 ? Math.abs(d2) : (p0 !== 0 ? Math.abs(d2 / p0) * 100 : Math.abs(d2));
        var tiers2 = pct2 ? [0.05, 0.10, 0.20] : [1, 5, 15];
        var s2 = Math.min(2, mag2 < tiers2[0] ? 0 : mag2 < tiers2[1] ? 1 : 2);
        res.pre = true;
        if (s2 > 0) {
          var up2 = (d2 > 0 ? cat.dir : -cat.dir) > 0, pb = [50, 58, 65][s2];
          res.verdict = up2 ? 'BULLISH' : 'BEARISH';
          res.buy = up2 ? pb : 100 - pb; res.sell = 100 - res.buy;
        }
      }
    }
    return res;
  }

  /* ---- Biais par paire (USD faible => paires « USD en 2e » BUY, paires « USD en 1er » SELL ; or = USD en 2e) ---- */
  var PAIRS = [['XAU/USD', false], ['EUR/USD', false], ['GBP/USD', false], ['USD/JPY', true], ['USD/CHF', true], ['USD/CAD', true]];
  function pairBias(an, usdBase) {
    var buyPct = usdBase ? an.sell : an.buy;           // USD en 1er : sens inversé
    if (an.verdict === 'NEUTRAL' || buyPct === 50) return { side: 'NEUTRAL', pct: 50 };
    return buyPct > 50 ? { side: 'BUY', pct: buyPct } : { side: 'SELL', pct: 100 - buyPct };
  }
  function pairsHtml(an, compact) {
    var h = compact ? '<div style="display:flex;flex-wrap:wrap;gap:6px;font-size:11px">' : '<div class="card-title" style="margin-top:12px">BIAIS PAR PAIRE</div><div style="display:grid;gap:6px">';
    PAIRS.forEach(function (p) {
      var b = pairBias(an, p[1]), col = b.side === 'BUY' ? 'var(--bull)' : b.side === 'SELL' ? 'var(--bear)' : 'var(--muted)';
      var txt = b.side === 'NEUTRAL' ? 'NEUTRAL' : (b.side === 'BUY' ? '▲ BUY ' : '▼ SELL ') + b.pct + '%';
      h += compact
        ? '<span style="padding:4px 8px;border-radius:8px;border:1px solid ' + col + ';color:' + col + ';white-space:nowrap"><b>' + p[0] + '</b> ' + txt + '</span>'
        : '<div class="scn-row"><span>' + p[0] + '</span><b style="color:' + col + '">' + txt + '</b></div>';
    });
    return h + '</div>';
  }

  function verdictLabel(v) { return v === 'BULLISH' ? '🟢 BULLISH GOLD' : v === 'BEARISH' ? '🔴 BEARISH GOLD' : '⚪ NEUTRAL'; }
  function impactLabel(l) { return l === 'high' ? '🔴 HIGH' : l === 'medium' ? '🟡 MEDIUM' : '🟢 LOW'; }
  function impactBadge(l) { return l === 'high' ? '🔴 HIGH IMPACT' : l === 'medium' ? '🟡 MEDIUM IMPACT' : '🟢 LOW IMPACT'; }

  /* Texte pédagogique (français) — 9 points demandés */
  var WHY = {
    rates:  "La Fed fixe le coût de l'argent aux États-Unis. C'est le principal moteur du dollar et des rendements obligataires, donc de l'or (qui ne verse pas d'intérêt).",
    cpi:    "Le CPI mesure l'inflation des prix à la consommation. Il guide directement ce que la Fed fera de ses taux.",
    pce:    "Le PCE est l'indicateur d'inflation que la Fed suit en priorité pour ses décisions.",
    nfp:    "Le NFP compte les emplois créés hors agriculture. Un marché du travail solide ou faible modifie les anticipations de taux.",
    speech: "Les propos du président de la Fed ou de ses membres peuvent changer en quelques minutes les anticipations sur les taux futurs.",
    ppi:    "Le PPI mesure l'inflation côté producteurs ; il annonce parfois la tendance de l'inflation à la consommation.",
    unemp:  "Le taux de chômage indique la santé du marché du travail, un critère central pour la Fed.",
    claims: "Les inscriptions hebdomadaires au chômage sont un indicateur rapide de l'état du marché du travail.",
    gdp:    "Le PIB mesure la croissance de l'économie américaine ; il influence l'appétit pour le dollar et les anticipations de taux.",
    retail: "Les ventes au détail reflètent la consommation, moteur principal de l'économie américaine.",
    jobs:   "Cet indicateur d'emploi donne un aperçu du marché du travail avant ou autour des chiffres officiels.",
    activity: "Indicateur d'activité ou de confiance : il donne une lecture de la conjoncture américaine.",
    other:  "Publication économique américaine susceptible de faire bouger le dollar et, par ricochet, l'or."
  };

  function scenarios(ev, cat) {
    // Retourne [texte scénario Gold favorable, texte scénario Gold défavorable] selon le sens de la catégorie
    if (cat.key === 'speech') return [
      "Un ton plutôt accommodant (« dovish ») : baisses de taux évoquées, prudence sur l'économie → dollar et rendements peuvent reculer, ce qui peut soutenir l'or.",
      "Un ton ferme (« hawkish ») : taux élevés plus longtemps, inflation jugée persistante → dollar et rendements peuvent monter, ce qui peut peser sur l'or."
    ];
    var lowerIsBull = cat.dir === -1;
    var wordsUp = cat.key === 'rates' ? 'un taux plus élevé que prévu (ou un ton plus ferme)' : cat.key === 'unemp' || cat.key === 'claims' ? 'un chiffre plus élevé que prévu (marché du travail plus faible)' : cat.key === 'nfp' || cat.key === 'jobs' ? 'un chiffre plus élevé que prévu (marché du travail plus solide)' : cat.key === 'cpi' || cat.key === 'pce' || cat.key === 'ppi' ? "une inflation plus élevée que prévu" : 'un chiffre plus élevé que prévu';
    var wordsDown = cat.key === 'rates' ? 'un taux plus bas que prévu (ou un ton plus souple)' : cat.key === 'unemp' || cat.key === 'claims' ? 'un chiffre plus bas que prévu (marché du travail plus solide)' : cat.key === 'nfp' || cat.key === 'jobs' ? 'un chiffre plus bas que prévu (marché du travail plus faible)' : cat.key === 'cpi' || cat.key === 'pce' || cat.key === 'ppi' ? "une inflation plus basse que prévu" : 'un chiffre plus bas que prévu';
    var up = "Cela peut renforcer les anticipations de taux élevés, soutenir le dollar et les rendements, et donc peser sur l'or.";
    var down = "Cela peut réduire la pression sur les taux, affaiblir le dollar et les rendements, et donc soutenir l'or.";
    var upG = "Cela peut réduire la pression sur les taux, affaiblir le dollar et les rendements, et donc soutenir l'or.";
    var downG = "Cela peut renforcer les anticipations de taux élevés, soutenir le dollar et les rendements, et donc peser sur l'or.";
    if (lowerIsBull) return ['Favorable à l\'or : ' + wordsDown + '. ' + down, 'Défavorable à l\'or : ' + wordsUp + '. ' + up];
    return ['Favorable à l\'or : ' + wordsUp + '. ' + upG, 'Défavorable à l\'or : ' + wordsDown + '. ' + downG];
  }

  function chain(cat, an, ev) {
    if (!an.hasActual) return '';
    var above = an.surprise === 'above', below = an.surprise === 'below';
    if (an.surprise === 'inline') return "Chiffre conforme aux attentes → peu de surprise → réaction souvent limitée.";
    var goldUp = an.verdict === 'BULLISH';
    var first = cat.key === 'cpi' || cat.key === 'pce' || cat.key === 'ppi' ? (below ? 'Inflation en dessous des attentes → pression inflationniste plus faible' : 'Inflation au-dessus des attentes → pression inflationniste plus forte')
      : cat.key === 'rates' ? (below ? 'Taux plus bas que prévu → politique monétaire moins restrictive' : 'Taux plus haut que prévu → politique monétaire plus restrictive')
      : cat.key === 'nfp' || cat.key === 'jobs' ? (above ? 'Emplois au-dessus des attentes → économie / marché du travail plus solide' : 'Emplois sous les attentes → marché du travail plus faible')
      : cat.key === 'unemp' || cat.key === 'claims' ? (above ? 'Chômage plus élevé que prévu → marché du travail plus faible' : 'Chômage plus bas que prévu → marché du travail plus solide')
      : (above ? 'Chiffre au-dessus des attentes → économie plus solide' : 'Chiffre sous les attentes → économie plus faible');
    return first + (goldUp ? '\n→ anticipations de taux moins restrictives\n→ pression potentielle sur USD / rendements\n→ soutien potentiel à l\'or.' : '\n→ anticipations de taux plus restrictives\n→ soutien potentiel à l\'USD / rendements\n→ pression potentielle sur l\'or.');
  }

  function analysisHtml(ev, an) {
    var cat = an.cat, sc = scenarios(ev, cat), st = state.settings;
    var h = '';
    if (st.goldImpact) h += '<div class="scn-row"><span>GOLD IMPACT</span><b>' + impactLabel(an.impact) + '</b></div>';
    if (st.aiFund) {
      h += '<div class="card-title" style="margin-top:12px">🧠 AI FUNDAMENTAL ANALYSIS</div>';
      h += '<div style="font-size:12px;line-height:1.55">';
      h += '<p><b>1. Qu\'est-ce que cette news ?</b><br>' + esc(cat.label) + ' — « ' + esc(ev.name) + ' ».</p>';
      h += '<p><b>2. Pourquoi est-elle importante ?</b><br>' + esc(WHY[cat.key] || WHY.other) + '</p>';
      h += '<p><b>3. Actual vs Forecast</b><br>Le <i>Forecast</i> est la prévision moyenne des analystes ; l\'<i>Actual</i> est le chiffre publié. C\'est l\'écart entre les deux (la « surprise ») qui fait bouger le marché, plus que le chiffre seul.';
      if (an.hasActual) h += '<br><b>Ici : Actual ' + esc(ev.actual) + ' vs Forecast ' + esc(ev.forecast) + (ev.previous ? ' (Previous ' + esc(ev.previous) + ')' : '') + '.</b>';
      else h += '<br><i>Actual pas encore publié' + (ev.forecast ? ' — Forecast : ' + esc(ev.forecast) : ' — Forecast non fourni par l\'API') + '.</i>';
      h += '</p>';
      var usdTxt, fedTxt, goldTxt;
      if (an.hasActual && an.verdict !== 'NEUTRAL') {
        var b = an.verdict === 'BULLISH';
        usdTxt = b ? "Pression potentielle à la baisse sur l'USD." : "Soutien potentiel à l'USD.";
        fedTxt = b ? "Les anticipations pourraient devenir moins restrictives (moins de pression pour garder des taux élevés)." : "Les anticipations pourraient devenir plus restrictives (taux élevés plus longtemps).";
        goldTxt = b ? "Soutien potentiel à XAU/USD (biais haussier)." : "Pression potentielle sur XAU/USD (biais baissier).";
      } else if (an.hasActual) {
        usdTxt = "Écart faible ou nul : impact limité attendu sur l'USD."; fedTxt = "Pas de changement notable des anticipations de la Fed."; goldTxt = "Réaction directionnelle peu claire (biais neutre).";
      } else {
        usdTxt = "Dépend de l'écart Actual/Forecast : voir scénarios ci-dessous."; fedTxt = "Dépend du résultat : la publication peut renforcer ou réduire les attentes de taux."; goldTxt = "Impact non déterminable avant la publication : biais NEUTRAL.";
      }
      h += '<p><b>4. Impact possible sur l\'USD</b><br>' + usdTxt + '</p>';
      h += '<p><b>5. Impact possible sur les attentes de taux de la Fed</b><br>' + fedTxt + '</p>';
      h += '<p><b>6. Impact potentiel sur XAU/USD</b><br>' + goldTxt + '</p>';
      h += '<p><b>7. Scénario favorable à l\'or</b><br>' + esc(sc[0]) + '</p>';
      h += '<p><b>8. Scénario négatif pour l\'or</b><br>' + esc(sc[1]) + '</p>';
      h += '<p><b>9. Risques de réaction contraire</b><br>Le marché réagit parfois à l\'inverse de la logique attendue : positionnement déjà pris (« buy the rumor, sell the news »), chiffres révisés, détails internes du rapport (ex. inflation « core »), autres publications ou discours au même moment, forte volatilité et spreads élargis juste après la sortie. Un mouvement initial peut s\'inverser en quelques minutes.</p>';
      var ch = chain(cat, an, ev);
      if (ch) h += '<div class="disclaimer" style="white-space:pre-line">' + esc(ch) + '</div>';
      h += '</div>';
    }
    h += biasHtml(an);
    return h;
  }

  function biasHtml(an) {
    var h = '<div class="card-title" style="margin-top:12px">GOLD BIAS</div>';
    if (an.verdict === 'NEUTRAL') {
      h += '<div class="bias-bar"><div class="bias-buy" style="width:50%">NEUTRAL</div><div class="bias-sell" style="width:50%">NEUTRAL</div></div>';
      h += '<div class="scn-row"><span>IMPACT</span><b>' + verdictLabel('NEUTRAL') + '</b></div>';
    } else {
      h += '<div class="bias-bar"><div class="bias-buy" style="width:' + an.buy + '%">BUY BIAS: ' + an.buy + '%</div><div class="bias-sell" style="width:' + an.sell + '%">SELL BIAS: ' + an.sell + '%</div></div>';
      h += '<div class="scn-row"><span>IMPACT</span><b>' + verdictLabel(an.verdict) + '</b></div>';
    }
    h += pairsHtml(an, false);
    if (an.pre) h += '<div class="ai-note">⏱ Biais PRÉ-NEWS : prévision vs précédent (avant la publication, signal plus faible). Il sera recalculé avec l\'Actual.</div>';
    h += '<div class="ai-note">Bias estimé par l\'analyse IA — ce pourcentage n\'est pas une probabilité garantie de mouvement du marché.</div>';
    h += '<div class="disclaimer">Analyse automatique fondée sur des règles macro générales (relation historique usuelle inflation / taux / USD / or). Elle ne constitue ni une certitude ni un conseil financier, et ne déclenche aucun ordre.</div>';
    return h;
  }

  /* ------------------------- Filtrage / fenêtre de pause ------------------------- */
  function enabled(level) { var s = state.settings; return level === 'high' ? s.high : level === 'medium' ? s.medium : s.low; }
  function visibleEvents() { return state.events.filter(function (e) { return e.usd; }); }
  function protectedEvents() { return state.events.filter(function (e) { return e.usd && enabled(e.impact); }); }

  function windowOf(ev) { var s = state.settings; return { start: ev.ts - s.before * 60000, end: ev.ts + s.after * 60000 }; }

  function getPauseInfo(now) {
    now = now || Date.now();
    var s = state.settings;
    var none = { paused: false, status: 'TRADE_ALLOWED', reason: null, event: null, resumeAt: null, phase: 'clear' };
    if (!s.protection || state.apiOk === false && !state.events.length) return none;
    var evs = protectedEvents();
    for (var i = 0; i < evs.length; i++) {
      var w = windowOf(evs[i]);
      if (now >= w.start && now < w.end) {
        return { paused: true, status: 'TRADE_BLOCKED_NEWS', reason: 'HIGH IMPACT NEWS', event: { name: evs[i].name, ts: evs[i].ts, impact: evs[i].impact }, resumeAt: w.end, phase: now < evs[i].ts ? 'before' : 'after' };
      }
    }
    return none;
  }

  function nextProtected(now) {
    now = now || Date.now();
    var evs = protectedEvents().filter(function (e) { return windowOf(e).end > now; });
    return evs.length ? evs[0] : null;
  }

  function lastFinished(now) {
    now = now || Date.now();
    var evs = protectedEvents().filter(function (e) { return windowOf(e).end <= now; });
    return evs.length ? evs[evs.length - 1] : null;
  }

  /* ------------------------- Formatage ------------------------- */
  function fmtCountdown(ms) {
    var neg = ms < 0; ms = Math.abs(ms);
    var s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    var p = function (n) { return String(n).padStart(2, '0'); };
    var d = Math.floor(h / 24);
    var core = (d > 0 ? d + 'j ' + p(h % 24) : p(h)) + ':' + p(m) + ':' + p(x);
    return neg ? '−' + core : core;
  }
  function fmtTime(ts) { try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ_DISPLAY }).format(new Date(ts)); } catch (e) { return new Date(ts).toISOString().slice(11, 16) + ' UTC'; } }
  function fmtDate(ts) { try { return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: '2-digit', month: 'short', timeZone: TZ_DISPLAY }).format(new Date(ts)); } catch (e) { return new Date(ts).toISOString().slice(0, 10); } }

  /* ------------------------- Rendu ------------------------- */
  function statusBanner() {
    var now = Date.now(), info = getPauseInfo(now), box = $('newsAutoTradeStatus');
    if (!box) return;
    if (info.paused) {
      box.className = 'news-status paused';
      box.innerHTML = '<div>🔴 AUTO TRADE PAUSED — HIGH IMPACT NEWS<div class="nsub">' + esc(info.event.name) + ' · reprise à ' + esc(fmtTime(info.resumeAt)) + ' · <span class="mono">TRADE_BLOCKED_NEWS</span></div></div>';
    } else if (!state.settings.protection) {
      box.className = 'news-status allowed';
      box.innerHTML = '<div>🟢 AUTO TRADE ALLOWED<div class="nsub">Protection NEWS désactivée par l\'admin</div></div>';
    } else {
      var nx = nextProtected(now);
      box.className = 'news-status allowed';
      box.innerHTML = '<div>🟢 AUTO TRADE ALLOWED<div class="nsub">' + (nx ? 'Prochaine pause : ' + esc(nx.name) + ' à ' + esc(fmtTime(windowOf(nx).start)) : 'Aucune pause programmée') + '</div></div>';
    }
  }

  function card(ev) {
    var an = analyze(ev), now = Date.now(), st = state.settings;
    var w = windowOf(ev), inWin = st.protection && enabled(ev.impact) && now >= w.start && now < w.end;
    var tag = ev.actual !== null ? '<span class="n-badge low">PUBLIÉ</span>' : (now > ev.ts ? '<span class="n-badge medium">EN ATTENTE ACTUAL</span>' : '');
    var cd = ev.ts > now ? 'News in:<br><b class="nw-cd" data-ts="' + ev.ts + '">' + fmtCountdown(ev.ts - now) + '</b>' : 'Publiée<br><b class="nw-cd" data-ts="' + ev.ts + '">' + fmtCountdown(ev.ts - now) + '</b>';
    return '<div class="n-item ' + ev.impact + '" data-id="' + esc(ev.id) + '" style="flex-direction:column;align-items:stretch;gap:8px">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">' +
        '<div style="min-width:0"><div class="n-name">' + esc(ev.name) + '</div>' +
        '<div class="n-meta">' + esc(ev.country) + ' · ' + esc(ev.currency) + ' · ' + esc(fmtDate(ev.ts)) + ' · ' + esc(fmtTime(ev.ts)) + ' (Madagascar)</div></div>' +
        '<div class="n-right"><span class="n-badge ' + ev.impact + '">' + impactBadge(ev.impact) + '</span> ' + tag + '<div>' + cd + '</div></div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:6px;font-size:12px">' +
        '<div><span style="color:var(--muted)">Forecast</span><br><b class="mono">' + (ev.forecast !== null ? esc(ev.forecast) : '—') + '</b></div>' +
        '<div><span style="color:var(--muted)">Previous</span><br><b class="mono">' + (ev.previous !== null ? esc(ev.previous) : '—') + '</b></div>' +
        '<div><span style="color:var(--muted)">Actual</span><br><b class="mono">' + (ev.actual !== null ? esc(ev.actual) : '—') + '</b></div>' +
        (st.goldImpact ? '<div><span style="color:var(--muted)">GOLD IMPACT</span><br><b>' + impactLabel(an.impact) + '</b></div>' : '') +
      '</div>' +
      '<div><div style="font-size:11px;color:var(--muted);margin-bottom:4px">BIAIS PAR PAIRE' + (an.pre ? ' · pré-news' : '') + '</div>' + pairsHtml(an, true) + '</div>' +
      (inWin ? '<div style="font-size:11px;color:var(--bear)">⏸ AUTO TRADE PAUSE ACTIVE (fenêtre de protection)</div>' : '') +
      '<div style="font-size:11px;color:var(--muted)">Touchez pour l\'analyse détaillée ▾</div>' +
    '</div>';
  }

  function renderList() {
    var wrap = $('newsListWrap'); if (!wrap) return;
    if (state.apiOk === false && !state.events.length) {
      wrap.innerHTML = '<div class="empty" style="color:var(--bear)">NEWS API UNAVAILABLE<br><span style="font-size:11px;color:var(--muted)">NEWS DATA TEMPORARILY UNAVAILABLE — aucune donnée n\'est inventée. Le reste du site fonctionne normalement.</span></div>' + attribution();
      return;
    }
    if (state.apiOk === null) { wrap.innerHTML = '<div class="empty">Chargement du calendrier économique…</div>'; return; }
    var now = Date.now(), lo = now - 3 * 3600000;   // garde les publications récentes visibles 3 h
    var evs = visibleEvents().filter(function (e) { return e.ts >= lo; });
    var shown = evs.filter(function (e) { return enabled(e.impact); });
    var html = '';
    if (state.apiOk === false) html += '<div class="disclaimer" style="color:var(--warn)">⚠ Actualisation impossible — affichage des dernières données reçues (' + esc(new Date(state.lastFetch).toLocaleTimeString('fr-FR')) + ').</div>';
    if (!shown.length) {
      html += '<div class="empty">' + (state.rawCount > 0 && !state.events.length ? 'Réponse reçue (' + state.rawCount + ' éléments) mais format non reconnu — aucune donnée affichée.' : 'Aucun événement USD important à venir sur ' + DAYS_AHEAD + ' jours.') + '</div>';
    } else {
      html += shown.map(card).join('');
    }
    wrap.innerHTML = html + attribution();
  }

  function attribution() {
    return '<div class="disclaimer" style="margin-top:12px">Données du calendrier : <a href="https://www.financecalendar.com" target="_blank" rel="noopener" style="color:var(--cyan)">financecalendar.com</a> · mise à jour ~5 min · heures affichées en heure de Madagascar. Membres : lecture seule.</div>';
  }

  function renderDetail() {
    var cardEl = $('newsDetailCard'), t = $('newsDetailTitle'), b = $('newsDetailBody');
    if (!cardEl || !t || !b) return;
    var ev = state.events.filter(function (e) { return e.id === state.selectedId; })[0];
    if (!ev) { cardEl.classList.remove('open'); return; }
    var an = analyze(ev);
    t.textContent = ev.name;
    b.innerHTML = analysisHtml(ev, an) + confluenceHtml(ev, an);
    cardEl.classList.add('open');
  }

  function technicalDir() {
    var box = $('signalBox'); if (!box) return '—';
    var tx = box.textContent || '', hasB = /\bBUY\b/.test(tx), hasS = /\bSELL\b/.test(tx);
    return hasB && !hasS ? 'BUY' : hasS && !hasB ? 'SELL' : '—';
  }

  function confluenceHtml(ev, an) {
    var now = Date.now(), info = getPauseInfo(now), w = windowOf(ev), st = state.settings;
    var newsState = !st.protection || !enabled(ev.impact) ? 'NON SURVEILLÉE' : now < w.start ? 'À VENIR' : now < w.end ? 'HIGH IMPACT' : 'PASSED';
    var auto = info.paused ? 'PAUSED' : 'ALLOWED';
    return '<div class="card-title" style="margin-top:14px">NEWS + TECHNICAL CONFLUENCE</div>' +
      '<div class="scn-row"><span>TECHNICAL</span><b>' + esc(technicalDir()) + '</b></div>' +
      '<div class="scn-row"><span>FUNDAMENTAL</span><b>' + verdictLabel(an.verdict) + '</b></div>' +
      '<div class="scn-row"><span>NEWS</span><b>' + newsState + '</b></div>' +
      '<div class="scn-row"><span>AUTO TRADE</span><b>' + auto + '</b></div>' +
      '<div class="ai-note">Le biais fondamental n\'est jamais converti en ordre BUY/SELL : l\'exécution reste gérée uniquement par le système ROBOT existant.</div>';
  }

  /* ------------------------- Panneau ROBOT : statut news ------------------------- */
  function ensureRobotBox() {
    var pr = $('panelRobot'); if (!pr) return null;
    var box = $('newsRobotStatus');
    if (!box) {
      box = document.createElement('div'); box.id = 'newsRobotStatus'; box.className = 'card'; box.style.marginTop = '12px';
      var anchor = $('rb_member');
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(box, anchor); else pr.appendChild(box);
    }
    return box;
  }

  function renderRobotBox() {
    var box = ensureRobotBox(); if (!box) return;
    var info = getPauseInfo(), sigEl = $('rb_lastSig'), sig = sigEl ? (sigEl.textContent || '').trim() : '';
    var row = function (k, v) { return '<div class="rb-row"><span>' + k + '</span><b>' + v + '</b></div>'; };
    var title = '<div class="card-title">📰 NEWS PROTECTION</div>';
    if (info.paused) {
      box.innerHTML = title + '<div class="news-status paused" style="display:block;background:rgba(255,61,113,.12);border:1px solid rgba(255,61,113,.3);color:var(--bear);padding:10px 12px;border-radius:10px;margin-bottom:8px;font-weight:600">🔴 AUTO TRADE PAUSED — HIGH IMPACT NEWS</div>' +
        row('Signal', esc(sig && sig !== '—' ? sig : '—')) + row('Robot', 'BLOCKED') + row('Reason', 'HIGH IMPACT NEWS') + row('News', esc(info.event.name)) + row('Resume', esc(fmtTime(info.resumeAt))) + row('Status', 'TRADE_BLOCKED_NEWS');
    } else {
      box.innerHTML = title + '<div style="background:rgba(0,230,118,.12);border:1px solid rgba(0,230,118,.3);color:var(--bull);padding:10px 12px;border-radius:10px;margin-bottom:8px;font-weight:600">🟢 AUTO TRADE ALLOWED</div>' +
        row('News', state.settings.protection ? 'Aucune fenêtre active' : 'Protection désactivée');
    }
  }

  /* ------------------------- Alertes ------------------------- */
  var fired = {};
  try { fired = JSON.parse(localStorage.getItem(LS_ALERTS) || '{}'); } catch (e) {}
  function saveFired() { try { var k = Object.keys(fired); if (k.length > 300) k.sort().slice(0, k.length - 300).forEach(function (x) { delete fired[x]; }); localStorage.setItem(LS_ALERTS, JSON.stringify(fired)); } catch (e) {} }

  function toast(kind, title, lines) {
    var host = $('newsToastHost');
    if (!host) {
      host = document.createElement('div'); host.id = 'newsToastHost';
      host.style.cssText = 'position:fixed;left:8px;right:8px;top:8px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:420px;margin:0 auto';
      document.body.appendChild(host);
    }
    var col = kind === 'warn' ? 'var(--bear)' : kind === 'ok' ? 'var(--bull)' : 'var(--warn)';
    var el = document.createElement('div');
    el.style.cssText = 'pointer-events:auto;background:var(--panel,#0e1626);border:1px solid ' + col + ';color:var(--text,#fff);border-radius:10px;padding:10px 12px;font-size:12px;box-shadow:0 6px 24px rgba(0,0,0,.45)';
    el.innerHTML = '<div style="font-weight:700;color:' + col + '">' + esc(title) + '</div><div style="white-space:pre-line;margin-top:4px">' + esc(lines) + '</div>';
    el.onclick = function () { el.remove(); };
    host.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 20000);
    state.alertLog.unshift({ t: Date.now(), title: title, lines: lines });
    state.alertLog = state.alertLog.slice(0, 12);
    renderAlertLog();
  }

  function renderAlertLog() {
    var el = $('newsAlertLog');
    if (!el) return;
    el.innerHTML = state.alertLog.length ? state.alertLog.map(function (a) {
      return '<div class="scn-row"><span>' + esc(new Date(a.t).toLocaleTimeString('fr-FR')) + ' — ' + esc(a.title) + '</span></div>';
    }).join('') : '<div class="empty">Aucune alerte pour le moment.</div>';
  }

  var TOL = 3 * 60000; // n'affiche que les étapes franchies depuis moins de 3 min (pas de rejeu au chargement)
  function checkAlerts() {
    var now = Date.now(), s = state.settings;
    protectedEvents().forEach(function (ev) {
      var hi = ev.impact === 'high';
      var stages = [
        { k: 'h1', at: ev.ts - 60 * 60000, run: function () { if (hi) toast('info', '🔔 HIGH IMPACT GOLD NEWS', ev.name + '\nNews in:\n01:00:00\nImpact Gold:\nHIGH'); } },
        { k: 'pre', at: ev.ts - s.before * 60000, run: function () { toast('warn', '🔴 NEWS WARNING', ev.name + '\nNews in:\n' + fmtCountdown(ev.ts - Date.now()) + '\nAUTO TRADE PAUSE:\nACTIVE'); } },
        { k: 'rel', at: ev.ts, run: function () { var e2 = state.events.filter(function (x) { return x.id === ev.id; })[0] || ev; toast('warn', '🔴 NEWS RELEASED', e2.name + '\nActual:\n' + (e2.actual !== null ? e2.actual : 'en attente de publication par l\'API')); } },
        { k: 'end', at: ev.ts + s.after * 60000, run: function () { toast('ok', 'NEWS WINDOW FINISHED', 'AUTO TRADE:\nRESUMED'); } }
      ];
      stages.forEach(function (st) {
        var key = ev.id + '|' + ev.ts + '|' + st.k;
        if (fired[key]) return;
        if (now >= st.at) {
          fired[key] = 1;
          if (now - st.at <= TOL) st.run();
          saveFired();
        }
      });
    });
  }

  /* ------------------------- Boucles ------------------------- */
  function tick() {
    document.querySelectorAll('#panelNews .nw-cd').forEach(function (el) {
      var ts = +el.getAttribute('data-ts'); el.textContent = fmtCountdown(ts - Date.now());
    });
    statusBanner(); renderRobotBox(); checkAlerts();
    if ($('newsDetailCard') && $('newsDetailCard').classList.contains('open') && Date.now() % 10000 < 1000) renderDetail();
  }

  function needsFast() {
    var now = Date.now();
    return state.events.some(function (e) { return e.usd && enabled(e.impact) && e.actual === null && now >= e.ts - 120000 && now <= e.ts + 10 * 60000; });
  }

  async function refresh() {
    clearTimeout(state.timer);
    try {
      var raw = await fetchAll();
      state.rawCount = raw.length;
      state.events = normalize(raw);
      try { await enrichFF(state.events); } catch (eFF) { /* forecast indisponible : biais neutre, rien d'inventé */ }
      state.apiOk = true; state.lastError = '';
    } catch (e) {
      state.apiOk = false; state.lastError = String(e && e.message || e);
    }
    state.lastFetch = Date.now();
    renderList(); renderDetail(); tick();
    state.timer = setTimeout(refresh, needsFast() ? FAST_REFRESH_MS : REFRESH_MS);
    loadSettings().then(function () { renderList(); tick(); });
  }

  /* ------------------------- Onglets (additif) ------------------------- */
  function wireTabs() {
    var ids = ['tabPanelGold', 'tabPanelOpr', 'tabPanelRobot', 'tabPanelNews'];
    var panels = ['panelGold', 'panelOpr', 'panelRobot', 'panelNews'];
    var tn = $('tabPanelNews'); if (!tn) return;
    tn.addEventListener('click', function () {
      ids.forEach(function (i) { if ($(i)) $(i).classList.remove('active'); });
      tn.classList.add('active');
      panels.forEach(function (p) { if ($(p)) $(p).style.display = p === 'panelNews' ? 'block' : 'none'; });
      renderList(); tick();
    });
    ['tabPanelGold', 'tabPanelOpr', 'tabPanelRobot'].forEach(function (i) {
      if ($(i)) $(i).addEventListener('click', function () { if ($('panelNews')) $('panelNews').style.display = 'none'; if (tn) tn.classList.remove('active'); });
    });
    var wrap = $('newsListWrap');
    if (wrap) wrap.addEventListener('click', function (ev) {
      var it = ev.target.closest && ev.target.closest('.n-item'); if (!it) return;
      state.selectedId = it.getAttribute('data-id'); renderDetail();
      var d = $('newsDetailCard'); if (d && d.scrollIntoView) d.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    var cl = $('newsDetailClose'); if (cl) cl.addEventListener('click', function () { state.selectedId = null; renderDetail(); });
    // journal d'alertes (ajouté sans toucher au HTML existant)
    var card0 = wrap && wrap.closest('.card');
    if (card0 && !$('newsAlertLog')) {
      var lg = document.createElement('div'); lg.style.marginTop = '14px';
      lg.innerHTML = '<div class="card-title">🔔 Alertes récentes</div><div id="newsAlertLog"></div>';
      card0.appendChild(lg); renderAlertLog();
    }
  }

  /* ------------------------- Admin (réservé admin, écriture côté serveur) ------------------------- */
  function fillAdminForm() {
    var s = state.settings, set = function (id, v) { var e = $(id); if (e) e.value = v; };
    set('newsAdmProtection', s.protection ? 'on' : 'off'); set('newsAdmBefore', s.before); set('newsAdmAfter', s.after);
    set('newsAdmHigh', s.high ? 'on' : 'off'); set('newsAdmMedium', s.medium ? 'on' : 'off'); set('newsAdmLow', s.low ? 'on' : 'off');
    set('newsAdmGoldImpact', s.goldImpact ? 'on' : 'off'); set('newsAdmAiFund', s.aiFund ? 'on' : 'off');
  }

  function wireAdmin() {
    var btn = $('newsAdmSaveBtn'); if (!btn) return;
    if (!$('newsAdmToken')) {
      var f = document.createElement('div'); f.className = 'field'; f.style.marginBottom = '10px';
      f.innerHTML = '<label>Clé admin NEWS (serveur)</label><input id="newsAdmToken" type="password" autocomplete="off" placeholder="NEWS_ADMIN_TOKEN" style="width:100%;min-width:0">';
      btn.parentNode.insertBefore(f, btn);
      var m = document.createElement('div'); m.id = 'newsAdmMsg'; m.style.cssText = 'font-size:12px;color:var(--muted);margin:-8px 0 12px'; btn.parentNode.insertBefore(m, btn.nextSibling);
    }
    btn.addEventListener('click', async function () {
      var msg = $('newsAdmMsg'), say = function (t, err) { if (msg) { msg.textContent = t; msg.style.color = err ? 'var(--bear)' : 'var(--bull)'; } };
      var val = function (id) { return $(id) ? $(id).value : undefined; };
      var body = normSettings({ protection: val('newsAdmProtection'), before: val('newsAdmBefore'), after: val('newsAdmAfter'), high: val('newsAdmHigh'), medium: val('newsAdmMedium'), low: val('newsAdmLow'), goldImpact: val('newsAdmGoldImpact'), aiFund: val('newsAdmAiFund') });
      try {
        var r = await fetch(API + '/api/news/settings', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'x-news-admin': ($('newsAdmToken') && $('newsAdmToken').value) || '' }, body: JSON.stringify(body) });
        var j = {}; try { j = await r.json(); } catch (e) {}
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        state.settings = normSettings(j.settings || body);
        try { localStorage.setItem(LS_SETTINGS, JSON.stringify(state.settings)); } catch (e) {}
        say('Paramètres News enregistrés ✅ (appliqués à tous les membres)'); renderList(); tick();
      } catch (e) { say('Échec : ' + e.message + ' — les règles globales n\'ont pas été modifiées.', true); }
    });
  }

  /* ------------------------- API publique ------------------------- */
  window.AresNews = {
    getPauseInfo: function (n) { try { return getPauseInfo(n); } catch (e) { return { paused: false, event: null }; } },
    getStatus: function () { var i = getPauseInfo(); return i.paused ? 'TRADE_BLOCKED_NEWS' : 'TRADE_ALLOWED'; },
    getEvents: function () { return state.events.slice(); },
    getSettings: function () { return Object.assign({}, state.settings); },
    analyze: function (ev) { var a = analyze(ev); return { verdict: a.verdict, buy: a.buy, sell: a.sell, impact: a.impact, cat: a.cat.key }; },
    refresh: refresh,
    debug: function () { return { apiOk: state.apiOk, error: state.lastError, raw: state.rawCount, parsed: state.events.length, usd: visibleEvents().length }; }
  };

  /* ------------------------- Démarrage ------------------------- */
  function start() {
    try { wireTabs(); wireAdmin(); fillAdminForm(); } catch (e) { console.warn('[news] wiring', e); }
    refresh();
    setInterval(function () { try { tick(); } catch (e) {} }, 1000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  } catch (fatal) { console.warn('[news-module] désactivé :', fatal); }
})();
