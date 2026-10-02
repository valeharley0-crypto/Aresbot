'use strict';
/**
 * ARES — IA MENTOR ENGINE (XAUUSD + FOREX)
 * Logique pure : état, risque, modes (NORMAL / PROP), OPR, NEWS, pont MT5, logs.
 * Aucune donnée de marché ou de news n'est inventée : si une donnée manque -> "UNAVAILABLE" -> WAIT/BLOCK.
 * Aucune garantie de profit : ce moteur filtre et bloque, il ne promet rien.
 */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  symbol: 'XAUUSD',              // symbole par défaut (news, prix de secours)
  // Symboles autorisés. pointSize = 1 « point » du moteur (gold 0.1$, forex 1 pip).
  // La valeur $/point/lot réelle vient du broker (envoyée par l'EA : vpl) ; contractSize = secours.
  symbols: {
    XAUUSD: { pointSize: 0.1, contractSize: 100, maxDevPts: 30 },
    EURUSD: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    GBPUSD: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    AUDUSD: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    NZDUSD: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    EURGBP: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    USDCHF: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    USDCAD: { pointSize: 0.0001, contractSize: 100000, maxDevPts: 8 },
    USDJPY: { pointSize: 0.01, contractSize: 100000, maxDevPts: 8 },
    EURJPY: { pointSize: 0.01, contractSize: 100000, maxDevPts: 8 },
    GBPJPY: { pointSize: 0.01, contractSize: 100000, maxDevPts: 8 }
  },
  active: 'OFF',                 // bouton frontend : 'OFF' | 'NORMAL' | 'PROP'
  mode: 'NORMAL',                // 'NORMAL' | 'PROP' (suit 'active' quand actif)
  liveExecution: false,          // false = PAPER (aucun ordre servi au pont MT5)
  timezone: 'UTC',               // fuseau pour reset journalier, OPR, etc.
  pointSize: 0.1,                // 1 point = 0.10 $ (identique à PT dans index.html)
  contractSize: 100,             // oz par lot
  startBalance: null,            // solde de départ si MT5 ne l'envoie pas
  riskPerTradePct: 0.5,          // % du solde risqué par trade (plafond)
  minLot: 0.01, lotStep: 0.01, maxLot: 5,
  maxActiveTrades: 2,
  signalTTLSec: 60,              // ordre non récupéré par l'EA après ce délai -> EXPIRED
  maxEntryDeviationPoints: 30,   // écart max signal.entry vs prix réel
  priceMaxAgeSec: 15,
  paperMaxMinutes: 30,           // un trade PAPER sans résultat est clos (sans P/L) après ce délai
  normal: { objectivePoints: 20, dailyLossPoints: 10, maxTrades: 0, stopAtObjective: false, postObjectiveRiskPoints: 0, minRR: 1 },
  prop: {
    accountSize: null, profitTarget: null, dailyLossLimit: null, maxOverallLoss: null,
    maxTrades: null, maxRiskPerTradeMoney: null, minTradingDays: null, consistencyMaxDayPct: null
  },
  opr: { sessions: [] },         // [{days:[1,2,3,4,5], start:'08:30', end:'09:30'}] (heure locale du fuseau)
  news: {
    enabled: true, autoTrade: false,
    relevantCurrencies: ['USD'], impacts: ['high'],
    pauseBeforeMin: 60, analysisBeforeMin: 30, executeBeforeSec: 30, resumeAfterMin: 10,
    tpPoints: 55, slPoints: 30, minConfidence: 55, minDeviationPct: 2, riskPerTradePct: 0.5,
    symbols: ['XAUUSD', 'EURUSD']   // symboles tradés sur news USD (USD fort : gold/EURUSD SELL, USDJPY BUY)
  }
};

const CATEGORY_USD_SIGN = {   // +1 : valeur plus haute que prévu = USD plus fort = Gold plutôt baissier
  inflation: 1, employment: 1, growth: 1, rates: 1, unemployment: -1
};

const ACTIVE = ['PENDING', 'SENT', 'OPEN', 'PAPER', 'UNCONFIRMED'];
const clone = o => JSON.parse(JSON.stringify(o));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = clone(a);
  for (const k of Object.keys(b || {})) out[k] = isObj(b[k]) && isObj(out[k]) ? merge(out[k], b[k]) : b[k];
  return out;
}
const num = v => (v === null || v === undefined || v === '' ? null : (Number.isFinite(+v) ? +v : null));
const r2 = x => Math.round(x * 100) / 100;

function createEngine(opts = {}) {
  const clock = opts.now || (() => Date.now());
  const dataDir = opts.dataDir || path.join(process.cwd(), 'data');
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const tdKey = opts.twelveDataKey || process.env.TWELVEDATA_API_KEY || process.env.TWELVEDATA_KEY || '';
  const stateFile = path.join(dataDir, 'mentor-state.json');
  const logFile = path.join(dataDir, 'mentor-log.jsonl');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* disque non inscriptible: mémoire seule */ }

  let S = {
    config: clone(DEFAULTS), day: null, trades: [], news: [],
    account: { balance: null, equity: null, ts: 0 }, price: { mid: null, ts: 0, src: null }, prices: {}, specs: {},
    manualBlock: null, realizedMoney: 0, tradingDays: [], seq: 0, lastDecision: null
  };
  const logs = [];
  let lastLogKey = '';
  let current = { status: 'WAIT', sub: 'MENTOR_ACTIVE', reason: 'Aucun setup valide' };

  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    S = Object.assign(S, saved, { config: merge(DEFAULTS, saved.config || {}) });
  } catch (e) { /* premier démarrage */ }

  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { fs.writeFileSync(stateFile, JSON.stringify(S)); } catch (e) { /* ignore */ }
    }, 500);
    if (saveTimer.unref) saveTimer.unref();
  }
  const cfg = () => S.config;
  const symOf = s => String(s || cfg().symbol).toUpperCase().replace(/[^A-Z]/g, '');
  const specOf = s => { const d = (cfg().symbols || {})[symOf(s)]; return d ? Object.assign({ pointSize: cfg().pointSize, contractSize: cfg().contractSize }, d) : null; };
  const brokerSpec = s => (S.specs || {})[symOf(s)] || {};
  // $ par point et par lot : valeur réelle du broker si connue, sinon pointSize × contractSize
  const vppOf = s => {
    const sp = specOf(s) || { pointSize: cfg().pointSize, contractSize: cfg().contractSize }, b = brokerSpec(s);
    return b.vpl > 0 ? b.vpl * sp.pointSize : sp.pointSize * sp.contractSize;
  };
  const vpp = () => vppOf(cfg().symbol);

  // ---------- temps / fuseau ----------
  function localParts(ts) {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: cfg().timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    });
    const p = {}; f.formatToParts(new Date(ts)).forEach(x => { p[x.type] = x.value; });
    const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+p.hour) * 60 + (+p.minute), dow };
  }
  const hhmm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? (+m[1]) * 60 + (+m[2]) : null; };

  // ---------- logs ----------
  function log(decision, reason, extra = {}, force = false) {
    const key = decision + '|' + reason + '|' + (extra.kind || '');
    if (!force && key === lastLogKey) return;
    lastLogKey = key;
    const d = S.day || {};
    const entry = Object.assign({
      timestamp: new Date(clock()).toISOString(), mode: cfg().mode, decision, reason,
      risk: extra.risk || 0, dailyPL: dayNetPts(), tradesToday: d.trades || 0
    }, extra);
    logs.push(entry); if (logs.length > 500) logs.shift();
    try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch (e) { /* ignore */ }
  }

  // ---------- jour ----------
  function balanceInfo() {
    const a = S.account;
    if (a.balance !== null) return { balance: a.balance, equity: a.equity !== null ? a.equity : a.balance, source: 'MT5' };
    const sb = cfg().mode === 'PROP' && cfg().prop.accountSize ? cfg().prop.accountSize : cfg().startBalance;
    if (sb === null || sb === undefined) return { balance: null, equity: null, source: 'UNAVAILABLE' };
    return { balance: r2(sb + S.realizedMoney), equity: r2(sb + S.realizedMoney), source: 'COMPUTED_FROM_RESULTS' };
  }
  function rollDay(ts) {
    const date = localParts(ts).date;
    if (S.day && S.day.date === date) return;
    const b = balanceInfo();
    S.day = { date, startBalance: b.balance, startEquity: b.equity, profitPts: 0, lossPts: 0, pnlMoney: 0, trades: 0, wins: 0, losses: 0, objectiveReached: false };
    log('DAY_RESET', 'Nouveau jour de trading ' + date, { kind: 'day' }, true);
    save();
  }
  const dayNetPts = () => (S.day ? r2(S.day.profitPts - S.day.lossPts) : 0);

  // ---------- prix réel ----------
  function freshPrice(sym) {
    const k = symOf(sym), p = k === cfg().symbol ? S.price : (S.prices || {})[k];
    return p && p.mid && clock() - p.ts <= cfg().priceMaxAgeSec * 1000 ? p : null;
  }
  async function ensurePrice(sym) {
    const k = symOf(sym);
    if (freshPrice(k)) return freshPrice(k);
    if (k !== 'XAUUSD' || !tdKey || !fetchFn) return null;   // secours TwelveData : gold seulement
    try {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ac ? setTimeout(() => ac.abort(), 4000) : null;
      const res = await fetchFn('https://api.twelvedata.com/price?symbol=XAU/USD&apikey=' + encodeURIComponent(tdKey), ac ? { signal: ac.signal } : {});
      if (t) clearTimeout(t);
      const j = await res.json();
      const mid = num(j && j.price);
      if (mid && mid > 0) { S.price = { mid, ts: clock(), src: 'TWELVEDATA' }; S.prices[k] = S.price; return S.price; }
    } catch (e) { /* prix indisponible */ }
    return null;
  }
  function pushPrice({ bid, ask, mid }, sym) {
    const k = symOf(sym);
    const b = num(bid), a = num(ask);
    const m = num(mid) || (b && a ? (a + b) / 2 : (b || a));
    if (m && m > 0) {
      const p = { mid: m, bid: b, ask: a, ts: clock(), src: 'MT5' };
      S.prices[k] = p;
      if (k === cfg().symbol) S.price = p;
    }
  }

  // ---------- OPR ----------
  function oprState(ts) {
    const lp = localParts(ts);
    for (const s of cfg().opr.sessions || []) {
      const st = hhmm(s.start), en = hhmm(s.end);
      if (st === null || en === null) continue;
      const days = Array.isArray(s.days) && s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
      const inside = st <= en ? (lp.minutes >= st && lp.minutes < en) : (lp.minutes >= st || lp.minutes < en);
      if (inside && days.includes(lp.dow)) return { active: true, session: s };
    }
    return { active: false, session: null };
  }

  // ---------- news ----------
  const relevant = ev => cfg().news.enabled &&
    cfg().news.relevantCurrencies.map(x => x.toUpperCase()).includes(String(ev.currency).toUpperCase()) &&
    cfg().news.impacts.map(x => x.toLowerCase()).includes(String(ev.impact).toLowerCase());

  function setNews(events) {
    const errors = [];
    (events || []).forEach((e, i) => {
      const t = Date.parse(e && e.time);
      if (!e || !Number.isFinite(t) || !e.title) { errors.push(`event[${i}]: title et time (ISO) requis`); return; }
      const id = String(e.id || `${e.currency || 'USD'}-${t}-${String(e.title).toLowerCase().replace(/\W+/g, '-')}`);
      const old = S.news.find(x => x.id === id);
      const next = {
        id, title: String(e.title), currency: String(e.currency || 'USD').toUpperCase(), impact: String(e.impact || 'high').toLowerCase(),
        category: e.category ? String(e.category).toLowerCase() : null, time: new Date(t).toISOString(), t,
        forecast: num(e.forecast), previous: num(e.previous), actual: num(e.actual)
      };
      if (old) {
        for (const k of ['forecast', 'previous', 'actual']) if (next[k] === null && old[k] !== null) next[k] = old[k];   // une valeur connue n'est jamais effacée par un null
        Object.assign(old, next);
      } else S.news.push(Object.assign(next, { analysis: null, executed: null }));
    });
    S.news = S.news.filter(e => e.t > clock() - 24 * 3600 * 1000);   // purge >24h
    save();
    return { count: S.news.length, errors };
  }

  function analyze(ev) {
    const base = {
      news_event: ev.title, release_time: ev.time, expected: ev.forecast, previous: ev.previous, actual: ev.actual,
      risk_level: ev.impact === 'high' ? 'HIGH' : 'MEDIUM', analyzed_at: new Date(clock()).toISOString()
    };
    const sign = CATEGORY_USD_SIGN[ev.category];
    if (sign === undefined) return Object.assign(base, { bias: 'DATA_UNAVAILABLE', confidence: 0, data: 'UNAVAILABLE', reason: 'Catégorie inconnue ou absente (inflation, employment, growth, rates, unemployment) : pas d\'interprétation fiable' });
    let a, b, basis;
    if (ev.actual !== null && ev.forecast !== null) { a = ev.actual; b = ev.forecast; basis = 'ACTUAL_VS_FORECAST'; }
    else if (ev.forecast !== null && ev.previous !== null) { a = ev.forecast; b = ev.previous; basis = 'FORECAST_VS_PREVIOUS'; }
    else return Object.assign(base, { bias: 'DATA_UNAVAILABLE', confidence: 0, data: 'UNAVAILABLE', reason: 'Valeurs prévision/précédent manquantes : aucune donnée inventée' });
    const dev = (a - b) / (Math.abs(b) > 1e-9 ? Math.abs(b) : 1) * 100;   // écart en %
    const min = cfg().news.minDeviationPct;
    let bias = 'NEUTRAL', confidence = 0, reason;
    if (Math.abs(dev) < min) {
      reason = `Écart ${r2(dev)}% < seuil ${min}% : pas de biais`;
    } else {
      const usdStronger = (dev > 0 ? 1 : -1) * sign > 0;
      bias = usdStronger ? 'SELL' : 'BUY';
      confidence = Math.min(basis === 'ACTUAL_VS_FORECAST' ? 90 : 80, Math.round(45 + Math.abs(dev) * 2));
      reason = `${basis === 'ACTUAL_VS_FORECAST' ? 'Réel' : 'Prévision'} ${a} vs ${basis === 'ACTUAL_VS_FORECAST' ? 'prévision' : 'précédent'} ${b} (${r2(dev)}%) → USD ${usdStronger ? 'plus fort' : 'plus faible'} → Gold ${usdStronger ? 'baissier' : 'haussier'}.`;
      if (basis === 'FORECAST_VS_PREVIOUS') reason += ' Heuristique avant publication : prévision vs précédent ne prédit pas la surprise.';
    }
    return Object.assign(base, { bias, confidence, data: 'REAL', basis, reason });
  }

  function newsContext(ts) {
    const n = cfg().news;
    const list = S.news.filter(relevant).sort((x, y) => x.t - y.t);
    const inPause = list.find(e => ts >= e.t - n.pauseBeforeMin * 60000 && ts <= e.t + n.resumeAfterMin * 60000);
    const next = list.find(e => e.t > ts) || null;
    const ev = inPause || next;
    let sub = null;
    if (inPause) {
      const e = inPause;
      if (ts > e.t) sub = 'POST_NEWS';
      else if (e.executed && e.executed.status === 'EXECUTED') sub = 'EXECUTE';
      else if (ts >= e.t - n.executeBeforeSec * 1000) sub = 'T-30S';
      else if (!e.analysis) sub = ts < e.t - n.analysisBeforeMin * 60000 ? 'NEWS_WAIT' : 'FUNDAMENTAL_ANALYSIS';
      else sub = ['BUY', 'SELL'].includes(e.analysis.bias) && e.analysis.confidence >= n.minConfidence ? 'BIAS_CONFIRMED' : 'NO_TRADE';
    }
    return { paused: !!inPause, event: ev, sub, countdownSec: ev ? Math.round((ev.t - ts) / 1000) : null };
  }

  // ---------- limites ----------
  function normalLimits() {
    const n = cfg().normal, d = S.day, net = dayNetPts();
    if (!d) return { stopped: false };
    if (net <= -n.dailyLossPoints) return { stopped: true, reason: `Perte jour ${net} pts ≤ -${n.dailyLossPoints}` };
    if (n.stopAtObjective && net >= n.objectivePoints) return { stopped: true, reason: `Objectif ${n.objectivePoints} pts atteint (${net})` };
    if (n.maxTrades && d.trades >= n.maxTrades) return { stopped: true, reason: `${d.trades}/${n.maxTrades} trades aujourd'hui` };
    return { stopped: false };
  }
  // Marge de perte autorisée (points). Après l'objectif, les points déjà gagnés sont PROTÉGÉS :
  // seul le surplus au-dessus de l'objectif (+ postObjectiveRiskPoints) peut être risqué.
  function riskBudgetPts() {
    const n = cfg().normal, net = dayNetPts();
    if (S.day && S.day.objectiveReached) return Math.max(0, net - n.objectivePoints + n.postObjectiveRiskPoints);
    return n.dailyLossPoints + net;
  }
  function propStatus() {
    const p = cfg().prop, b = balanceInfo(), d = S.day || {};
    const reasons = [];
    const need = ['accountSize', 'dailyLossLimit', 'maxOverallLoss'].filter(k => p[k] === null || p[k] === undefined);
    if (need.length) reasons.push('Config Prop incomplète: ' + need.join(', '));
    const eq = b.equity;
    const out = {
      enabled: cfg().mode === 'PROP', balance: b.balance, equity: eq, balanceSource: b.source,
      profit: null, remainingDailyLoss: null, remainingOverallLoss: null, progressPct: null, tradesToday: d.trades || 0, tradingDays: S.tradingDays.length
    };
    if (eq !== null && p.accountSize) {
      out.profit = r2(eq - p.accountSize);
      if (p.dailyLossLimit !== null && d.startEquity !== null && d.startEquity !== undefined)
        out.remainingDailyLoss = r2(p.dailyLossLimit - Math.max(0, d.startEquity - eq));
      if (p.maxOverallLoss !== null) out.remainingOverallLoss = r2(p.maxOverallLoss - Math.max(0, p.accountSize - eq));
      if (p.profitTarget) out.progressPct = r2(out.profit / p.profitTarget * 100);
    } else if (!need.length) reasons.push('Solde/equity indisponible');
    if (out.remainingDailyLoss !== null && out.remainingDailyLoss <= 0) reasons.push('Limite de perte journalière atteinte');
    if (out.remainingOverallLoss !== null && out.remainingOverallLoss <= 0) reasons.push('Limite de perte globale atteinte');
    if (p.maxTrades && (d.trades || 0) >= p.maxTrades) reasons.push(`${d.trades}/${p.maxTrades} trades`);
    if (p.consistencyMaxDayPct && p.profitTarget && (d.pnlMoney || 0) >= p.consistencyMaxDayPct / 100 * p.profitTarget) reasons.push('Règle de consistance: gain du jour au plafond');
    out.blocked = reasons.length > 0; out.reasons = reasons;
    out.riskOfViolation = out.remainingDailyLoss !== null && p.dailyLossLimit ? (out.remainingDailyLoss < p.dailyLossLimit * 0.3 ? 'HIGH' : 'LOW') : 'UNKNOWN';
    return out;
  }
  const activeTrades = () => S.trades.filter(t => ACTIVE.includes(t.status));

  // ---------- état global ----------
  function computeState(ts) {
    if (S.manualBlock) return { status: 'BLOCKED', sub: 'BLOCKED', reason: S.manualBlock };
    if (cfg().active === 'OFF') return { status: 'WAIT', sub: 'MENTOR_OFF', reason: 'IA Mentor désactivé' };
    const opr = oprState(ts);
    if (opr.active) return { status: 'OPR MODE', sub: 'MENTOR_PAUSED', reason: 'OPR = ACTIVE, IA MENTOR = PAUSED' };
    if (cfg().mode === 'PROP') {
      const ps = propStatus();
      if (ps.blocked) return { status: 'PROP LIMIT', sub: 'BLOCKED', reason: ps.reasons.join('; ') };
    } else {
      const nl = normalLimits();
      if (nl.stopped) return { status: 'DAILY LIMIT', sub: 'BLOCKED', reason: nl.reason };
    }
    if (activeTrades().length) return { status: 'MANAGING', sub: 'MANAGING', reason: 'Trade IA actif' };
    const nc = newsContext(ts);
    if (nc.paused) return { status: 'NEWS MODE', sub: nc.sub, reason: `News: ${nc.event.title}` };
    if (cfg().mode === 'NORMAL' && S.day && S.day.objectiveReached) return { status: 'WAIT', sub: 'PROFIT_LOCKED', reason: `${cfg().normal.objectivePoints} pts protégés · risque autorisé ${r2(riskBudgetPts())} pts` };
    return { status: 'WAIT', sub: 'MENTOR_ACTIVE', reason: 'Aucun setup valide' };
  }

  // ---------- sizing ----------
  function size(slPts, capMoney, sym) {
    const perLot = slPts * vppOf(sym);
    if (!(perLot > 0) || !(capMoney > 0)) return { lots: 0, riskMoney: 0, perLot };
    const bs = brokerSpec(sym);
    const st = bs.lotStep > 0 ? bs.lotStep : cfg().lotStep;
    const minLot = Math.max(cfg().minLot, bs.minLot || 0), maxLot = Math.min(cfg().maxLot, bs.maxLot > 0 ? bs.maxLot : Infinity);
    let lots = Math.floor(capMoney / perLot / st + 1e-9) * st;
    lots = Math.min(+lots.toFixed(2), maxLot);
    if (lots < minLot) return { lots: 0, riskMoney: 0, perLot };
    return { lots, riskMoney: r2(lots * perLot), perLot };
  }

  /**
   * Pipeline: SIGNAL -> RISK CHECK -> MODE CHECK -> RULE CHECK -> EXECUTION
   * source: 'NORMAL' (signal soumis) | 'NEWS' (généré par le moteur news)
   */
  async function gate(p, ts) {
    const checks = [];
    const ok = (stage, detail) => checks.push({ stage, pass: true, detail });
    const bad = (stage, detail) => { checks.push({ stage, pass: false, detail }); return { ok: false, checks, stage, reason: `${stage}: ${detail}` }; };
    const c = cfg();

    // 1) SIGNAL
    const sym = symOf(p.symbol), sp = specOf(sym);
    if (!sp) return bad('SIGNAL', 'symbole non supporté: ' + sym + ' (ajouter dans config.symbols)');
    if (!['BUY', 'SELL'].includes(p.action)) return bad('SIGNAL', 'action doit être BUY ou SELL');
    const price = await ensurePrice(sym);
    if (!price) return bad('SIGNAL', 'DATA_UNAVAILABLE: prix réel indisponible pour ' + sym + ' (l\'EA doit envoyer ce symbole)');
    let entry = num(p.entry), sl = num(p.sl), tp = num(p.tp);
    if (p.source === 'NEWS') entry = price.mid;
    if (entry === null || sl === null || tp === null) return bad('SIGNAL', 'entry/sl/tp numériques requis');
    const buy = p.action === 'BUY';
    if (buy ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl)) return bad('SIGNAL', 'incohérence SL/Entry/TP pour ' + p.action);
    if (Math.abs(entry - price.mid) > (sp.maxDevPts || c.maxEntryDeviationPoints) * sp.pointSize) return bad('SIGNAL', `entry trop éloigné du prix réel (${price.mid}) : signal périmé`);
    const slPts = r2(Math.abs(entry - sl) / sp.pointSize), tpPts = r2(Math.abs(tp - entry) / sp.pointSize);
    ok('SIGNAL', `${sym} ${p.action} entry ${entry} SL ${slPts}pts TP ${tpPts}pts (prix ${price.src})`);

    // 2) RISK
    const b = balanceInfo();
    if (b.balance === null) return bad('RISK', 'DATA_UNAVAILABLE: solde inconnu (envoyer /account ou définir startBalance)');
    if (activeTrades().length >= c.maxActiveTrades) return bad('RISK', `trade IA déjà actif (max ${c.maxActiveTrades})`);
    const pct = p.source === 'NEWS' ? c.news.riskPerTradePct : c.riskPerTradePct;
    let cap = b.balance * pct / 100;
    const asked = num(p.risk); if (asked && asked > 0) cap = Math.min(cap, asked);
    if (c.mode === 'PROP' && c.prop.maxRiskPerTradeMoney) cap = Math.min(cap, c.prop.maxRiskPerTradeMoney);
    const sz = size(slPts, cap, sym);
    if (!sz.lots) return bad('RISK', `lot minimal dépasse le risque autorisé (${r2(cap)}$ pour SL ${slPts}pts)`);
    ok('RISK', `lots ${sz.lots}, risque ${sz.riskMoney}$ (plafond ${r2(cap)}$)`);

    // 3) MODE
    if (c.active === 'OFF') return bad('MODE', 'IA Mentor désactivé (bouton OFF)');
    if (S.manualBlock) return bad('MODE', 'bloqué manuellement: ' + S.manualBlock);
    if (oprState(ts).active) return bad('MODE', 'OPR actif : IA Mentor en pause');
    if (p.source !== 'NEWS') {
      const nc = newsContext(ts);
      if (nc.paused) return bad('MODE', `mode NEWS actif (${nc.event.title}) : trading normal suspendu`);
    }
    ok('MODE', p.source === 'NEWS' ? 'NEWS autorisé' : 'NORMAL autorisé');

    // 4) RULE
    if (c.mode === 'PROP') {
      const ps = propStatus();
      if (ps.blocked) return bad('RULE', 'PROP RULE CHECK: ' + ps.reasons.join('; '));
      if (ps.remainingDailyLoss !== null && sz.riskMoney > ps.remainingDailyLoss) return bad('RULE', `PROP RULE CHECK: risque ${sz.riskMoney}$ > marge journalière ${ps.remainingDailyLoss}$`);
      if (ps.remainingOverallLoss !== null && sz.riskMoney > ps.remainingOverallLoss) return bad('RULE', `PROP RULE CHECK: risque ${sz.riskMoney}$ > marge globale ${ps.remainingOverallLoss}$`);
      ok('RULE', 'PROP RULE CHECK ok');
    } else if (p.source === 'NEWS' && !S.day.objectiveReached) {
      ok('RULE', 'NEWS: limites propres à la news (voir config.news)');
    } else {
      const nl = normalLimits();
      if (nl.stopped) return bad('RULE', nl.reason);
      const allow = riskBudgetPts(), locked = S.day.objectiveReached;
      if (slPts > allow) return bad('RULE', locked ? `${c.normal.objectivePoints} pts protégés : SL ${slPts}pts > marge ${r2(allow)}pts` : `SL ${slPts}pts > marge de perte restante ${r2(allow)}pts`);
      if (p.source !== 'NEWS' && tpPts / slPts < c.normal.minRR) return bad('RULE', `RR ${r2(tpPts / slPts)} < ${c.normal.minRR}`);
      ok('RULE', locked ? 'profit protégé respecté' : 'limites NORMAL ok');
    }

    return { ok: true, checks, order: { symbol: sym, action: p.action, entry, sl, tp, slPts, tpPts, lots: sz.lots, riskMoney: sz.riskMoney } };
  }

  function queue(p, g, ts) {
    const live = cfg().liveExecution;
    const t = {
      id: `T${ts}-${++S.seq}`, ts: new Date(ts).toISOString(), mode: p.source === 'NEWS' ? 'NEWS' : cfg().mode, symbol: g.order.symbol,
      action: g.order.action, entry: g.order.entry, sl: g.order.sl, tp: g.order.tp, slPts: g.order.slPts, tpPts: g.order.tpPts,
      lots: g.order.lots, riskMoney: g.order.riskMoney, reason: p.reason || '', status: live ? 'PENDING' : 'PAPER', result: null
    };
    S.trades.push(t); if (S.trades.length > 500) S.trades.shift();
    S.day.trades++;
    if (!S.tradingDays.includes(S.day.date)) S.tradingDays.push(S.day.date);
    S.lastDecision = { action: t.action, entry: t.entry, sl: t.sl, tp: t.tp, risk: t.riskMoney, lots: t.lots, mode: t.mode, reason: t.reason, ts: t.ts, id: t.id };
    log('TRADE', `${t.mode} ${t.action} ${t.status}`, { kind: 'trade', signal: p, entry: t.entry, sl: t.sl, tp: t.tp, lots: t.lots, risk: t.riskMoney, tradeId: t.id, checks: g.checks }, true);
    save();
    return t;
  }

  async function submitSignal(p, source) {
    const ts = clock(); rollDay(ts);
    p = Object.assign({}, p, { source: source || 'NORMAL' });
    if (!p.action || String(p.action).toUpperCase() === 'WAIT') {
      log('WAIT', p.reason || 'Signal WAIT', { kind: 'signal' });
      return { ok: true, decision: 'WAIT', reason: p.reason || 'Signal WAIT' };
    }
    p.action = String(p.action).toUpperCase();
    log('ANALYZING', `Signal ${p.action} reçu`, { kind: 'signal', signal: p }, true);
    const g = await gate(p, ts);
    if (!g.ok) {
      S.lastDecision = { action: 'WAIT', reason: g.reason, ts: new Date(ts).toISOString() };
      log('BLOCK TRADE', g.reason, { kind: 'block', signal: p, checks: g.checks }, true);
      return { ok: false, decision: 'BLOCK TRADE', stage: g.stage, reason: g.reason, checks: g.checks };
    }
    log('VALID', 'Signal validé', { kind: 'valid', checks: g.checks }, true);
    const t = queue(p, g, ts);
    return { ok: true, decision: 'TRADE', tradeId: t.id, status: t.status, order: g.order, checks: g.checks,
      note: t.status === 'PAPER' ? 'PAPER : aucun ordre envoyé au broker (liveExecution=false)' : 'Ordre en attente de récupération par le pont MT5' };
  }

  // ---------- pont MT5 ----------
  function bridgeNext() {
    if (!cfg().liveExecution) return null;
    const t = S.trades.find(x => x.status === 'PENDING');
    if (!t) return null;
    t.status = 'SENT'; t.sentTs = clock(); save();
    return { id: t.id, symbol: t.symbol, action: t.action, type: 'MARKET', lots: t.lots, sl: t.sl, tp: t.tp, entryRef: t.entry, comment: 'ARES-' + t.mode };
  }
  function bridgeAck({ id, ticket, fillPrice }) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !['SENT', 'UNCONFIRMED', 'PENDING'].includes(t.status)) return { ok: false, error: 'ordre inconnu ou état invalide' };
    t.status = 'OPEN'; t.ticket = ticket || null; t.openPrice = num(fillPrice) || t.entry; save();
    log('MANAGING', 'Ordre ouvert ' + id, { kind: 'ack', tradeId: id, ticket }, true);
    return { ok: true };
  }
  function closeTrade(t, { closePrice, pnlPoints, pnlMoney, balance, equity }) {
    const open = t.openPrice || t.entry;
    let pts = num(pnlPoints);
    if (pts === null && num(closePrice) !== null) pts = r2((t.action === 'BUY' ? closePrice - open : open - closePrice) / (specOf(t.symbol) || { pointSize: cfg().pointSize }).pointSize);
    if (pts === null) return { ok: false, error: 'pnlPoints ou closePrice requis' };
    let money = num(pnlMoney); if (money === null) money = r2(pts * vppOf(t.symbol) * t.lots);
    t.status = 'CLOSED'; t.result = { closePrice: num(closePrice), pnlPoints: pts, pnlMoney: money, closedAt: new Date(clock()).toISOString() };
    rollDay(clock());
    const d = S.day;
    if (pts >= 0) { d.profitPts = r2(d.profitPts + pts); d.wins++; } else { d.lossPts = r2(d.lossPts + Math.abs(pts)); d.losses++; }
    d.pnlMoney = r2(d.pnlMoney + money); S.realizedMoney = r2(S.realizedMoney + money);
    if (!d.objectiveReached && dayNetPts() >= cfg().normal.objectivePoints) { d.objectiveReached = true; log('OBJECTIVE', `Objectif jour ${cfg().normal.objectivePoints} pts atteint (objectif, pas une promesse)`, { kind: 'obj' }, true); }
    const bal = num(balance), eq = num(equity);
    if (bal !== null) S.account = { balance: bal, equity: eq !== null ? eq : bal, ts: clock() };
    log('CLOSED', `${t.id} ${pts} pts / ${money}$`, { kind: 'result', tradeId: t.id, result: t.result, signal: { action: t.action, entry: t.entry, sl: t.sl, tp: t.tp }, risk: t.riskMoney }, true);
    save();
    return { ok: true, trade: t };
  }
  function bridgeResult(body) {
    const t = S.trades.find(x => x.id === body.id);
    if (!t || !ACTIVE.includes(t.status)) return { ok: false, error: 'ordre inconnu ou déjà clos' };
    return closeTrade(t, body);
  }
  function manualClose(id, body) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !ACTIVE.includes(t.status)) return { ok: false, error: 'ordre inconnu ou déjà clos' };
    if (body && (num(body.pnlPoints) !== null || num(body.closePrice) !== null)) return closeTrade(t, body);
    t.status = 'CANCELLED'; t.result = { note: 'clos manuellement sans P/L' }; save();
    return { ok: true, trade: t };
  }
  function updateAccount({ balance, equity, bid, ask, mid, prices }) {
    const b = num(balance), e = num(equity);
    if (b !== null) S.account = { balance: b, equity: e !== null ? e : b, ts: clock() };
    if (bid !== undefined || ask !== undefined || mid !== undefined) pushPrice({ bid, ask, mid }, cfg().symbol);
    // prices : { EURUSD: { bid, ask, mid, vpl, minLot, lotStep, maxLot }, ... } envoyé par l'EA (valeurs réelles du broker)
    if (isObj(prices)) {
      for (const name of Object.keys(prices).slice(0, 30)) {
        const x = prices[name] || {}, k = symOf(name);
        pushPrice({ bid: x.bid, ask: x.ask, mid: x.mid }, k);
        S.specs[k] = { vpl: num(x.vpl) > 0 ? num(x.vpl) : undefined, minLot: num(x.minLot) || undefined, lotStep: num(x.lotStep) || undefined, maxLot: num(x.maxLot) || undefined };
      }
    }
    save();
    return { ok: true };
  }

  // ---------- tick (1/s) ----------
  async function tick(ts = clock()) {
    rollDay(ts);
    const c = cfg();
    for (const t of S.trades) {
      const age = ts - Date.parse(t.ts);
      if (t.status === 'PENDING' && age > c.signalTTLSec * 1000) { t.status = 'EXPIRED'; S.day.trades = Math.max(0, S.day.trades - 1); log('EXPIRED', 'Ordre non récupéré par le pont: ' + t.id, { kind: 'exp' }, true); }
      else if (t.status === 'SENT' && ts - t.sentTs > c.signalTTLSec * 1000) { t.status = 'UNCONFIRMED'; log('UNCONFIRMED', 'Aucun ACK pour ' + t.id + ' : vérifier MT5 puis clore manuellement', { kind: 'unc' }, true); }
      else if (t.status === 'PAPER' && age > c.paperMaxMinutes * 60000) { t.status = 'PAPER_EXPIRED'; t.result = { note: 'PAPER sans résultat' }; }
    }
    if (c.news.enabled) {
      for (const ev of S.news.filter(relevant)) {
        if (!ev.analysis && ts >= ev.t - c.news.analysisBeforeMin * 60000 && ts < ev.t) {
          ev.analysis = analyze(ev);
          log('NEWS_ANALYSIS', `${ev.title}: ${ev.analysis.bias} (${ev.analysis.confidence}%) — ${ev.analysis.reason}`, { kind: 'news', analysis: ev.analysis }, true);
          save();
        }
        if (ev.analysis && ev.actual !== null && ev.analysis.basis !== 'ACTUAL_VS_FORECAST' && ts >= ev.t) {
          ev.postAnalysis = analyze(ev);   // information seulement, jamais de nouveau trade
        }
        if (!ev.executed && ev.analysis && ts >= ev.t - 45000 && ts < ev.t - c.news.executeBeforeSec * 1000) await ensurePrice();   // pré-chauffe du prix
        if (!ev.executed && ts >= ev.t - c.news.executeBeforeSec * 1000) {
          if (ts >= ev.t - 5000) { ev.executed = { status: 'MISSED', reason: 'fenêtre T-30s dépassée' }; log('NO TRADE', `${ev.title}: fenêtre T-30s manquée`, { kind: 'news' }, true); save(); continue; }
          const a = ev.analysis;
          if (!a) ev.executed = { status: 'NO_TRADE', reason: 'pas d\'analyse fondamentale' };
          else if (!['BUY', 'SELL'].includes(a.bias)) ev.executed = { status: 'NO_TRADE', reason: 'biais ' + a.bias };
          else if (a.confidence < c.news.minConfidence) ev.executed = { status: 'NO_TRADE', reason: `confiance ${a.confidence} < ${c.news.minConfidence}` };
          else if (!c.news.autoTrade) ev.executed = { status: 'NO_TRADE', reason: 'news.autoTrade désactivé' };
          else {
            const ids = [], reasons = [];
            for (const name of (c.news.symbols && c.news.symbols.length ? c.news.symbols : [c.symbol])) {
              const sym = symOf(name), sp = specOf(sym);
              if (!sp) { reasons.push(sym + ': non supporté'); continue; }
              const usdBase = sym.startsWith('USD'), usdQuote = sym.endsWith('USD');
              if (!usdBase && !usdQuote) { reasons.push(sym + ': pas de jambe USD'); continue; }
              const price = await ensurePrice(sym);
              if (!price) { reasons.push(sym + ': DATA_UNAVAILABLE prix'); continue; }
              const act = usdBase && !usdQuote ? (a.bias === 'BUY' ? 'SELL' : 'BUY') : a.bias;   // USD base : sens inversé
              const buy = act === 'BUY', pts = sp.pointSize;
              const r = await submitSignal({
                symbol: sym, action: act, entry: price.mid,
                sl: price.mid + (buy ? -1 : 1) * c.news.slPoints * pts, tp: price.mid + (buy ? 1 : -1) * c.news.tpPoints * pts,
                reason: `NEWS ${ev.title} — ${a.reason}`
              }, 'NEWS');
              if (r.ok) ids.push(r.tradeId); else reasons.push(sym + ': ' + r.reason);
            }
            ev.executed = ids.length ? { status: 'EXECUTED', tradeId: ids[0], tradeIds: ids } : { status: 'BLOCKED', reason: reasons.join(' | ') || 'aucun symbole' };
          }
          if (ev.executed.status !== 'EXECUTED') log('NO TRADE', `${ev.title}: ${ev.executed.reason || ev.executed.status}`, { kind: 'news' }, true);
          save();
        }
      }
    }
    const st = computeState(ts);
    if (st.status !== current.status || st.sub !== current.sub || st.reason !== current.reason) {
      current = st;
      log(st.status, st.reason, { kind: 'state', sub: st.sub });
    }
  }

  // ---------- vues pour le frontend ----------
  function status() {
    const ts = clock(); rollDay(ts);
    const st = computeState(ts), opr = oprState(ts), b = balanceInfo(), nl = normalLimits(), d = S.day;
    const active = activeTrades()[0] || null;
    return {
      ok: true, ts: new Date(ts).toISOString(), status: st.status, sub: st.sub, reason: st.reason, mode: cfg().mode, active: cfg().active,
      profitLock: { locked: !!d.objectiveReached, protectedPoints: d.objectiveReached ? cfg().normal.objectivePoints : 0, riskBudgetPoints: r2(riskBudgetPts()) },
      mentor: opr.active ? 'PAUSED' : 'ACTIVE', opr: opr.active ? 'ACTIVE' : 'INACTIVE',
      decision: S.lastDecision || { action: 'WAIT', reason: 'Aucun setup valide' },
      dailyPL: { points: dayNetPts(), profitPoints: d.profitPts, lossPoints: d.lossPts, money: d.pnlMoney },
      objective: { points: cfg().normal.objectivePoints, reached: d.objectiveReached }, dailyLossLimit: cfg().normal.dailyLossPoints,
      balance: b.balance, equity: b.equity, balanceSource: b.source,
      tradesToday: d.trades, maxTrades: (cfg().mode === 'PROP' ? cfg().prop.maxTrades : cfg().normal.maxTrades) || null,
      wins: d.wins, losses: d.losses, normalStopped: nl.stopped, activeTrade: active,
      news: newsView(ts), prop: cfg().mode === 'PROP' ? propStatus() : { enabled: false },
      dataQuality: { price: freshPrice() ? 'REAL (' + S.price.src + ')' : 'UNAVAILABLE', balance: b.source, news: S.news.length ? 'REAL (saisi)' : 'UNAVAILABLE' },
      liveExecution: cfg().liveExecution,
      symbols: Object.keys(cfg().symbols || {}), pricesLive: Object.keys(S.prices || {}).filter(k => freshPrice(k)),
      disclaimer: 'Objectif, pas une promesse. Aucune garantie de gain ni de direction.'
    };
  }
  function newsView(ts) {
    const nc = newsContext(ts), e = nc.event;
    return {
      enabled: cfg().news.enabled, autoTrade: cfg().news.autoTrade, status: nc.paused ? nc.sub : (e ? 'NEWS_WAIT' : 'NO_EVENT'),
      paused: nc.paused, countdownSec: nc.countdownSec,
      event: e ? { id: e.id, title: e.title, time: e.time, impact: e.impact, forecast: e.forecast, previous: e.previous, actual: e.actual } : null,
      bias: e && e.analysis ? e.analysis : (e ? { bias: 'PENDING', data: 'UNAVAILABLE' } : { bias: 'DATA_UNAVAILABLE', data: 'UNAVAILABLE', reason: 'Aucun événement news saisi' }),
      execution: e ? e.executed : null, tpPoints: cfg().news.tpPoints, slPoints: cfg().news.slPoints
    };
  }
  function risk() {
    const b = balanceInfo(), d = S.day || {}, ts = clock();
    const a = activeTrades()[0] || null;
    return {
      ok: true, balance: b.balance, equity: b.equity, balanceSource: b.source,
      openPL: b.balance !== null && b.equity !== null ? r2(b.equity - b.balance) : null,
      dailyPL: dayNetPts(), dailyLoss: d.lossPts || 0, dailyLossLimit: cfg().normal.dailyLossPoints,
      remainingLossPoints: r2(cfg().normal.dailyLossPoints + dayNetPts()), tradesToday: d.trades || 0,
      exposure: a ? { id: a.id, lots: a.lots, riskMoney: a.riskMoney, slPts: a.slPts, tpPts: a.tpPts } : null,
      riskPerTradePct: cfg().riskPerTradePct, maxActiveTrades: cfg().maxActiveTrades, mode: cfg().mode,
      oprActive: oprState(ts).active, activeTrades: activeTrades().length
    };
  }
  function setConfig(patch) {
    const before = clone(S.config);
    S.config = merge(S.config, patch || {});
    if (!['NORMAL', 'PROP'].includes(S.config.mode)) S.config.mode = before.mode;
    save();
    log('CONFIG', 'Configuration mise à jour', { kind: 'cfg', patch }, true);
    return S.config;
  }
  function setActive(v) {
    v = String(v || '').toUpperCase();
    if (!['OFF', 'NORMAL', 'PROP'].includes(v)) return { ok: false, error: 'active doit être OFF, NORMAL ou PROP' };
    S.config.active = v; if (v !== 'OFF') S.config.mode = v;
    save(); log('ACTIVE', 'IA Mentor = ' + v, { kind: 'active' }, true);
    return { ok: true, active: v, mode: S.config.mode };
  }
  function setBlock(reason) { S.manualBlock = reason || null; save(); log(reason ? 'BLOCKED' : 'UNBLOCKED', reason || 'Déblocage manuel', { kind: 'blk' }, true); return { ok: true, blocked: S.manualBlock }; }

  return {
    tick, submitSignal, status, risk, setConfig, setActive, setBlock, setNews, bridgeNext, bridgeAck, bridgeResult, manualClose, updateAccount,
    getConfig: () => clone(S.config), news: () => newsView(clock()), newsEvents: () => S.news.map(e => ({ id: e.id, title: e.title, time: e.time, impact: e.impact, currency: e.currency, category: e.category, forecast: e.forecast, previous: e.previous, actual: e.actual, analysis: e.analysis, executed: e.executed })),
    propStatus: () => { rollDay(clock()); return propStatus(); }, logs: (n = 100) => logs.slice(-n), trades: (n = 50) => S.trades.slice(-n),
    _analyze: analyze, _internals: { S: () => S }
  };
}

module.exports = { createEngine, DEFAULTS };
