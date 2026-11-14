'use strict';
/**
 * ARES — moteur du robot (risque, prop, news, exécution cTrader, journal) + STRATÉGIE UNIQUE « ARES IP » (voir ares-ip.js).
 * Les anciennes stratégies (zones clés /100, Wade, SMC modules A/B, LOR/OPR, scalper) ont été supprimées.
 */
const fs = require('fs');
const path = require('path');
const risk = require('./risk');
const newsCore = require('./news-core');          // NEWS USA importantes seulement (NFP, CPI, FOMC...) : sert de filtre (pause avant/après)
const fundamental = require('./fundamental');   // analyse fondamentale USD
const IP = require('./ares-ip');                // stratégie Ares IP (zones, probabilité, backtest)


const FOREX_SYM = { pointSize: 0.00001, contractSize: 100000, maxDevPts: 80 };   // 1 point = 1/10 de pip (5 décimales)
const DEFAULTS = {
  symbol: 'XAUUSD',
  symbols: {
    XAUUSD: { pointSize: 0.1, contractSize: 100, maxDevPts: 30 },
    EURUSD: FOREX_SYM, GBPUSD: FOREX_SYM,
    USDJPY: { pointSize: 0.001, contractSize: 100000, maxDevPts: 80 }
  },
  symbolsAllowed: ['XAUUSD'],
  active: 'OFF',                 // 'OFF' | 'NORMAL' | 'PROP'
  mode: 'NORMAL',                // 'NORMAL' | 'PROP'
  tradingMode: 'DAYTRADE',
  combined: false,
  autoTrade: false,              // Auto Trade ON/OFF : le robot analyse ET envoie les ordres limit
  liveExecution: true,           // ordres réels envoyés à cTrader (false uniquement si l'admin coupe l'exécution)
  timezone: 'UTC',
  pointSize: 0.1, contractSize: 100,
  startBalance: null,
  riskPerTradePct: 0.5,          // % du solde risqué par trade (plafond)
  minLot: 0.01, lotStep: 0.01, maxLot: 5,
  maxActiveTrades: 0,
  signalTTLSec: 60,
  maxEntryDeviationPoints: 30,
  priceMaxAgeSec: 15,
  session: { enabled: false, startUTC: '06:00', noEntryAfterUTC: '19:30', closeAllUTC: '20:45' },
  // DAY TRADE (Ares IP) : distances en « points-or » (1 pt-or = 0.10 $ ; 50 pips = 50 pts-or ; 100 pips = 100 pts-or).
  modes: {
    DAYTRADE: { timeframes: [5, 15, 30, 60, 240], tf: { entry: 5, structure: 5, htf: 60 }, symbols: ['XAUUSD'], entry: 'IP', tp1: 20, tp2: null, tp3: null, tp1R: 1, tp1Frac: 0.5, single: true, three: false, rr: 3, rrMode: 'AUTO', slMax: 100, minSl: 50, minAtr: 0, maxAtr: 900, maxSpread: 12, onePerPair: false, cooldownMin: 0, cooldownAfterLossMin: 0, maxSignalsPerDay: 0, maxSignalsPerWeek: 0 }
  },
  ip: JSON.parse(JSON.stringify(IP.DEFAULTS)),   // réglages Ares IP (SL min/max, RR min/max, seuils de probabilité…)
  split: { enabled: false },     // une seule position par setup (TP unique choisi par le robot)
  micro: { enabled: true, balanceBelow: 100, maxRiskPct: 25, singleUseTp2: false },
  normal: { objectivePoints: 20, dailyLossPoints: 300, maxTrades: 0, stopAtObjective: false, minRR: 1 },   // 300 pts-or = 3 pertes de 100 pips
  profitProtection: Object.assign(JSON.parse(JSON.stringify(risk.DEFAULT_PROFIT_PROTECTION)), { target: null, enabled: false }),
  risk: { maxConsecutiveLosses: 2, maxDrawdownPct: 40, maxSlippagePts: 5, maxOpenPositions: 30, maxDailyLossMoney: null, closeOnSlippage: false },
  prop: {
    accountSize: null, profitTarget: null, dailyLossLimit: null, maxOverallLoss: null,
    maxTrades: null, maxRiskPerTradeMoney: null, minTradingDays: null, consistencyMaxDayPct: null
  },
  news: {
    enabled: true, autoTrade: false, requireData: false, maxStaleMin: 180,
    relevantCurrencies: ['USD'], impacts: ['high'], coreOnly: true,
    announceBeforeMin: 120, pauseBeforeMin: 60, analysisBeforeMin: 60, executeBeforeSec: 60, resumeAfterMin: 10,
    slPoints: 10, tpPoints: 10, tp2Points: 20,
    perSymbol: { default: { slPoints: 100, tpPoints: 100, tp2Points: 200 }, XAUUSD: { slPoints: 10, tpPoints: 10, tp2Points: 20 } },
    minConfidence: 70, minDeviationPct: 2, riskPerTradePct: 0.5,
    symbols: ['XAUUSD']
  }
};

const DAY_SYMS = ['XAUUSD'];   // or uniquement
const ACTIVE = ['PENDING', 'SENT', 'LIMIT', 'OPEN', 'UNCONFIRMED'];   // LIMIT = ordre limit accepté par cTrader, en attente du prix
const TFS = [1, 3, 5, 15, 30, 60, 240];
const MODE_LIST = ['DAYTRADE'];

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
  const userId = opts.userId || 'owner';
  const fetchFn = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const tdKey = opts.twelveDataKey || process.env.TWELVEDATA_API_KEY || process.env.TWELVEDATA_KEY || '';
  const stateFile = path.join(dataDir, 'mentor-state.json');
  const logFile = path.join(dataDir, 'mentor-log.jsonl');
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) { /* disque non inscriptible: mémoire seule */ }

  const CANDLES = {};   // { SYMBOL: { 1: [...], 5: [...], 15: [...], 30: [...] } } : mémoire seule, rechargé depuis cTrader (trendbars réelles)
  let S = {
    config: clone(DEFAULTS), day: null, trades: [], news: [], newsFeedAt: 0,
    account: { balance: null, equity: null, margin: null, freeMargin: null, ts: 0 }, peakEquity: 0,
    price: { mid: null, ts: 0, src: null }, prices: {}, specs: {}, exec: { provider: 'cTrader', status: 'DISCONNECTED' },
    manualBlock: null, realizedMoney: 0, tradingDays: [], seq: 0, lastDecision: null, autoState: { scan: {} }, zones: {}
  };
  const logs = [];
  let lastLogKey = '';
  let current = { status: 'WAIT', sub: 'MENTOR_ACTIVE', reason: 'Aucun setup valide' };

  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    S = Object.assign(S, saved, { config: merge(DEFAULTS, saved.config || {}) });
  } catch (e) { /* premier démarrage */ }
  if (S.ipVer !== 1) {   // migration unique : nouvelle stratégie Ares IP, réglages propres, on repart sans ordres anciens en attente
    const c = S.config;
    c.modes = clone(DEFAULTS.modes); c.ip = clone(DEFAULTS.ip); c.tradingMode = 'DAYTRADE'; c.combined = false; c.liveExecution = true;
    c.symbolsAllowed = ['XAUUSD']; c.split = clone(DEFAULTS.split); c.session = Object.assign({}, c.session, { enabled: false });
    for (const k of ['dayZones', 'smc', 'dayFilters', 'wade', 'analysis', 'opr']) delete c[k];
    c.news.symbols = ['XAUUSD']; c.news.requireData = false;   // aucun flux calendrier n'est branché dans server.js : requireData=true bloquerait tous les ordres
    c.normal = Object.assign({}, c.normal, { dailyLossPoints: DEFAULTS.normal.dailyLossPoints, minRR: 1 }); c.profitProtection = Object.assign({}, c.profitProtection, { enabled: false });
    S.autoState = { scan: {} }; S.zones = {}; S.smcBook = {}; S.wade = {}; S.ipBook = { used: {}, lastScanT: 0 };
    S.ipVer = 1;
  }
  if (!S.ipBook) S.ipBook = { used: {}, lastScanT: 0 };
  if (!S.zones) S.zones = {};
  delete S.candles;
  if (!S.autoState) S.autoState = {};
  if (!S.autoState.scan) S.autoState.scan = {};
  if (!S.exec) S.exec = { provider: 'cTrader', status: 'DISCONNECTED' };

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
  const modeCfg = mode => cfg().modes[mode || cfg().tradingMode] || cfg().modes.DAYTRADE;
  const modesRunning = () => [cfg().tradingMode];
  const modeAllowsSym = (mode, sym) => DAY_SYMS.includes(sym) && (!modeCfg(mode).symbols || modeCfg(mode).symbols.includes(sym));
  const oprState = () => ({ active: false });   // l'ancien robot LOR n'existe plus
  const modeTradesToday = () => (S.day ? S.day.trades : 0);

  const symOf = s => String(s || cfg().symbol).toUpperCase().replace(/[^A-Z]/g, '');
  const specOf = s => { const d = (cfg().symbols || {})[symOf(s)]; return d ? Object.assign({ pointSize: cfg().pointSize, contractSize: cfg().contractSize }, d) : null; };
  const brokerSpec = s => (S.specs || {})[symOf(s)] || {};
  // $ par point et par lot : valeur réelle cTrader si connue, sinon pointSize × contractSize 
  const vppOf = s => {
    const sp = specOf(s) || { pointSize: cfg().pointSize, contractSize: cfg().contractSize }, b = brokerSpec(s);
    return b.vpl > 0 ? b.vpl * sp.pointSize : sp.pointSize * sp.contractSize / (/JPY$/.test(String(s)) ? 150 : 1);   // secours sans donnée broker : paires en JPY converties (≈ 1/150)
  };
  const eqFactor = sym => { const g = vppOf('XAUUSD'); return g > 0 ? vppOf(sym) / g : 1; };   // 100 points forex = 10 points-or (même valeur par lot)
  const newsSlTp = (c, sym) => { const m = c.news.perSymbol || {}, x = m[sym] || m.default || {}; return { sl: x.slPoints || c.news.slPoints, tp: x.tpPoints || c.news.tpPoints, tp2: x.tp2Points || c.news.tp2Points }; };
  const hhmmUTC = () => { const d = new Date(clock()); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

  // ---------- temps / fuseau ----------
  const FMT = {};
  function localParts(ts, tz) {
    tz = tz || cfg().timezone;
    const f = FMT[tz] || (FMT[tz] = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', weekday: 'short'
    }));
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
      timestamp: new Date(clock()).toISOString(), user: userId, mode: cfg().tradingMode, decision, reason,
      risk: extra.risk || 0, dailyPL: dayNetPts(), tradesToday: d.trades || 0
    }, extra);
    logs.push(entry); if (logs.length > 500) logs.shift();
    try { fs.appendFileSync(logFile, JSON.stringify(entry) + '\n'); } catch (e) { /* ignore */ }
  }

  // ---------- jour ----------
  function balanceInfo() {
    const a = S.account;
    if (a.balance !== null) return { balance: a.balance, equity: a.equity !== null ? a.equity : a.balance, source: 'cTrader' };
    const sb = cfg().mode === 'PROP' && cfg().prop.accountSize ? cfg().prop.accountSize : cfg().startBalance;
    if (sb === null || sb === undefined) return { balance: null, equity: null, source: 'UNAVAILABLE' };
    return { balance: r2(sb + S.realizedMoney), equity: r2(sb + S.realizedMoney), source: 'COMPUTED_FROM_RESULTS' };
  }
  function rollDay(ts) {
    const date = localParts(ts).date;
    if (S.day && S.day.date === date) return;
    const b = balanceInfo();
    S.day = { date, startBalance: b.balance, startEquity: b.equity, profitPts: 0, lossPts: 0, pnlMoney: 0, peakPts: 0, peakMoney: 0, consecLosses: 0, trades: 0, wins: 0, losses: 0, objectiveReached: false };
    log('DAY_RESET', 'Nouveau jour de trading ' + date, { kind: 'day' }, true);
    save();
  }
  const dayNetPts = () => (S.day ? r2(S.day.profitPts - S.day.lossPts) : 0);

  // ---------- prix réel & bougies ----------
  function freshPrice(sym) {
    const k = symOf(sym), p = k === cfg().symbol ? S.price : (S.prices || {})[k];
    return p && p.mid && clock() - p.ts <= cfg().priceMaxAgeSec * 1000 ? p : null;
  }
  async function ensurePrice(sym) {
    const k = symOf(sym);
    if (freshPrice(k)) return freshPrice(k);
    if (k !== 'XAUUSD' || !tdKey || !fetchFn) return null;   // secours TwelveData : or seulement ; refusé par le gate (prix cTrader requis pour les ordres réels)
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
      const p = { mid: m, bid: b, ask: a, ts: clock(), src: 'cTrader' };
      S.prices[k] = p;
      if (k === cfg().symbol) S.price = p;
      if ((cfg().symbolsAllowed || []).includes(k)) feedCandle(k, m, p.ts);
    }
  }
  function feedCandle(k, px, ts) {
    const m = (CANDLES[k] = CANDLES[k] || {});
    for (const tf of TFS) {
      const arr = (m[tf] = m[tf] || []), ms = tf * 60000, t0 = Math.floor(ts / ms) * ms, last = arr[arr.length - 1];
      if (last && last.t === t0) { last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px; last.v = (last.v || 0) + 1; }   // v = volume de ticks (VRZ)
      else if (!last || t0 > last.t) { arr.push({ t: t0, o: px, h: px, l: px, c: px, v: 1 }); if (arr.length > 1500) arr.shift(); }
    }
  }
  /** Historique RÉEL (trendbars cTrader) : bars = [{t(ms), o, h, l, c}] triées. Remplace l'historique, conserve les bougies live plus récentes. */
  function setCandles(sym, tf, bars) {
    const k = symOf(sym); if (!TFS.includes(tf) || !Array.isArray(bars) || !bars.length) return { ok: false };
    const m = (CANDLES[k] = CANDLES[k] || {}), live = (m[tf] || []), lastSeed = bars[bars.length - 1].t;
    m[tf] = bars.filter(b => b && Number.isFinite(b.t) && b.o > 0).concat(live.filter(b => b.t > lastSeed)).slice(-1500);
    return { ok: true, count: m[tf].length };
  }
  const candleCounts = () => { const o = {}; for (const k of Object.keys(CANDLES)) o[k] = Object.fromEntries(TFS.map(tf => [`M${tf}`, (CANDLES[k][tf] || []).length])); return o; };


  // ---------- news ----------
  const relevant = ev => cfg().news.enabled &&
    cfg().news.relevantCurrencies.map(x => x.toUpperCase()).includes(String(ev.currency).toUpperCase()) &&
    cfg().news.impacts.map(x => x.toLowerCase()).includes(String(ev.impact).toLowerCase()) &&
    (!cfg().news.coreOnly || newsCore.isCore(ev.title));

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
    if (!errors.length) S.newsFeedAt = clock();
    save();
    return { count: S.news.length, errors };
  }
  /** Le flux calendrier répond (même sans événement dans la fenêtre) : la donnée news n'est pas périmée. */
  function newsFeedHeartbeat(at) { const t = num(at); S.newsFeedAt = t && t > 0 ? Math.min(t, clock()) : clock(); save(); return { ok: true }; }
  const newsStale = () => cfg().news.enabled && cfg().news.requireData && (!S.newsFeedAt || clock() - S.newsFeedAt > cfg().news.maxStaleMin * 60000);

  /** Analyse fondamentale USD (module fundamental.js) : biais BUY/SELL par paire, jamais NEUTRAL.
   *  Avant publication : attente (prévision vs précédent) + contexte des 7 derniers jours ; après publication : surprise réel vs prévu. */
  function analyze(ev) {
    const base = {
      news_event: ev.title, release_time: ev.time, expected: ev.forecast, previous: ev.previous, actual: ev.actual,
      risk_level: ev.impact === 'high' ? 'HIGH' : 'MEDIUM', analyzed_at: new Date(clock()).toISOString()
    };
    const r = fundamental.analyzeEvent(ev, { now: clock() });
    if (!r.ok) return Object.assign(base, { pairBias: null, bias: 'DATA_UNAVAILABLE', confidence: 0, data: 'UNAVAILABLE', reason: r.reason });
    return Object.assign(base, r.analysis);
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
      else if (ts >= e.t - n.executeBeforeSec * 1000) sub = 'T-1MIN';
      else if (!e.analysis) sub = ts < e.t - n.analysisBeforeMin * 60000 ? 'NEWS_WAIT' : 'FUNDAMENTAL_ANALYSIS';
      else sub = ['BUY', 'SELL'].includes(e.analysis.bias) && e.analysis.confidence >= n.minConfidence ? 'BIAS_CONFIRMED' : 'NO_TRADE';
    }
    const announced = !!ev && ev.t > ts - n.resumeAfterMin * 60000 && ev.t - ts <= (n.announceBeforeMin || 120) * 60000;
    return { paused: !!inPause, announced, event: ev, sub, countdownSec: ev ? Math.round((ev.t - ts) / 1000) : null };
  }

  // ---------- PROFIT PROTECTION (Protected Profit Floor + Trailing) ----------
  const ppCfg = () => Object.assign({}, cfg().profitProtection, { target: cfg().profitProtection.target != null ? cfg().profitProtection.target : cfg().normal.objectivePoints });
  function ppState() {
    const d = S.day, pp = ppCfg();
    if (!d || cfg().mode !== 'NORMAL') return Object.assign(risk.floorState({ enabled: false }, 0, 0), { unit: pp.unit });
    const money = pp.unit === 'MONEY';
    return Object.assign(risk.floorState(pp, money ? (d.peakMoney || 0) : (d.peakPts || 0), money ? d.pnlMoney : dayNetPts()), { unit: money ? 'MONEY' : 'POINTS' });
  }

  // ---------- limites ----------
  function normalLimits() {
    const n = cfg().normal, d = S.day, net = dayNetPts(), rk = cfg().risk || {};
    if (!d) return { stopped: false };
    if (net <= -n.dailyLossPoints) return { stopped: true, reason: `Perte jour ${net} pts ≤ -${n.dailyLossPoints}` };
    if (rk.maxDailyLossMoney && d.pnlMoney <= -rk.maxDailyLossMoney) return { stopped: true, reason: `Perte jour ${d.pnlMoney} ≤ -${rk.maxDailyLossMoney} (max daily loss)` };
    const fl = ppState();
    if (fl.locked && fl.breached) return { stopped: true, reason: `Protected Profit Floor ${fl.floor} ${fl.unit === 'MONEY' ? '' : 'pts '}atteint : trading arrêté pour la journée` };
    if (n.stopAtObjective && net >= n.objectivePoints) return { stopped: true, reason: `Objectif ${n.objectivePoints} pts atteint (${net})` };
    if (n.maxTrades && d.trades >= n.maxTrades) return { stopped: true, reason: `${d.trades}/${n.maxTrades} trades aujourd'hui` };
    return { stopped: false };
  }
  // Marge de perte autorisée (points-or). Une fois la cible atteinte : floor protégé -> marge = P/L - floor.
  function riskBudgetPts() {
    const n = cfg().normal, net = dayNetPts(), fl = ppState();
    if (fl.locked) return fl.unit === 'MONEY' ? null : fl.budget;
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
    if (newsStale()) return { status: 'WAIT', sub: 'NEWS_DATA_UNAVAILABLE', reason: 'DATA_UNAVAILABLE : calendrier news indisponible ou périmé' };
    const fl = ppState();
    if (fl.locked) return { status: 'WAIT', sub: 'PROFIT_LOCKED', reason: `Floor protégé ${fl.floor}${fl.unit === 'MONEY' ? '' : ' pts'} · marge ${fl.budget}${fl.unit === 'MONEY' ? '' : ' pts'} · lot ×${fl.multiplier} · le robot continue` };
    return { status: 'WAIT', sub: 'MENTOR_ACTIVE', reason: 'Aucun setup valide' };
  }

  // ---------- sizing ----------
  function size(slPts, capMoney, sym) {
    const perLot = slPts * vppOf(sym);
    if (!(perLot > 0) || !(capMoney > 0)) return { lots: 0, riskMoney: 0, perLot };
    const bs = brokerSpec(sym);
    const st = bs.lotStep > 0 ? bs.lotStep : cfg().lotStep;
    const minLot = Math.max(cfg().minLot, bs.minLot || 0), maxLot = Math.min(cfg().maxLot, bs.maxLot > 0 ? bs.maxLot : Infinity);
    const nl = risk.normalizeLots(capMoney / perLot, { minLot, maxLot, lotStep: st });
    if (!nl.ok) return { lots: 0, riskMoney: 0, perLot };
    return { lots: nl.lots, riskMoney: r2(nl.lots * perLot), perLot };
  }
  const lotLimits = sym => { const bs = brokerSpec(sym); return { minLot: Math.max(cfg().minLot, bs.minLot || 0), maxLot: Math.min(cfg().maxLot, bs.maxLot > 0 ? bs.maxLot : Infinity), lotStep: bs.lotStep > 0 ? bs.lotStep : cfg().lotStep }; };

  /**
   * Pipeline: SIGNAL -> RISK CHECK -> MODE CHECK -> RULE CHECK -> EXÉCUTION
   * Le Risk Engine s'exécute AVANT chaque ordre ; une règle violée = BLOCK TRADE avec la raison.
   * source: 'NORMAL' (signal manuel ou robot) | 'NEWS' (généré par le moteur news)
   */
  async function gate(p, ts) {
    const checks = [];
    const ok = (stage, detail) => checks.push({ stage, pass: true, detail });
    const bad = (stage, detail) => { checks.push({ stage, pass: false, detail }); return { ok: false, checks, stage, reason: `${stage}: ${detail}` }; };
    const c = cfg(), mode = MODE_LIST.includes(p.tradingMode) ? p.tradingMode : c.tradingMode, m = modeCfg(mode);

    // 1) SIGNAL
    const sym = symOf(p.symbol), sp = specOf(sym);
    if (!sp) return bad('SIGNAL', 'symbole non supporté: ' + sym + ' (ajouter dans config.symbols)');
    if (!(c.symbolsAllowed || []).includes(sym)) return bad('SIGNAL', 'symbole non autorisé par l\'utilisateur: ' + sym);
    if (p.source !== 'NEWS' && p.source !== 'OPR' && !modeAllowsSym(mode, sym)) return bad('SIGNAL', `${mode} : ${sym} non autorisé (symboles du mode : ${m.symbols.join(', ')})`);
    if (!c.liveExecution) return bad('SIGNAL', 'exécution désactivée par l\'admin (GLOBAL_LIVE_ALLOWED=0) : aucun ordre envoyé');
    if (c.session && c.session.enabled && hhmmUTC() >= c.session.noEntryAfterUTC) return bad('SIGNAL', `plus d'entrée après ${c.session.noEntryAfterUTC} UTC (session)`);
    if (!['BUY', 'SELL'].includes(p.action)) return bad('SIGNAL', 'action doit être BUY ou SELL');
    if (c.liveExecution && S.exec.status !== 'CONNECTED') return bad('SIGNAL', 'cTrader non connecté : exécution live impossible');
    const price = await ensurePrice(sym);
    if (!price) return bad('SIGNAL', 'DATA_UNAVAILABLE: prix réel indisponible pour ' + sym + ' (cTrader doit fournir ce symbole)');
    if (c.liveExecution) {
      if (price.src !== 'cTrader') return bad('SIGNAL', 'DATA_UNAVAILABLE: prix cTrader requis en exécution live (source ' + price.src + ')');
      if (!(brokerSpec(sym).vpl > 0)) return bad('SIGNAL', 'DATA_UNAVAILABLE: valeur du point cTrader inconnue pour ' + sym + ' (conversion devise du compte)');
    }
    let entry = num(p.entry), sl = num(p.sl), tp = num(p.tp1) !== null ? num(p.tp1) : num(p.tp);
    const tp2 = num(p.tp2), tp3 = num(p.tp3);
    if (p.source === 'NEWS' || p.source === 'OPR') entry = price.mid;
    if (entry === null || sl === null || tp === null) return bad('SIGNAL', 'entry/sl/tp numériques requis');
    const buy = p.action === 'BUY';
    if (buy ? !(sl < entry && entry < tp) : !(tp < entry && entry < sl)) return bad('SIGNAL', 'incohérence SL/Entry/TP pour ' + p.action);
    if (tp2 !== null && (buy ? !(tp2 > tp) : !(tp2 < tp))) return bad('SIGNAL', 'TP2 doit être au-delà de TP1');
    if (tp3 !== null && tp2 !== null && (buy ? !(tp3 > tp2) : !(tp3 < tp2))) return bad('SIGNAL', 'TP3 doit être au-delà de TP2');
    if (p.limit) {   // ORDRE LIMIT : l'entrée est volontairement à distance du prix (zone assurée), mais du bon côté et pas trop loin
      if (buy ? !(entry < price.mid) : !(entry > price.mid)) return bad('SIGNAL', `ordre limit : le prix (${price.mid}) a déjà atteint l'entrée ${entry}`);
      if (Math.abs(entry - price.mid) > (sp.maxDevPts || c.maxEntryDeviationPoints) * sp.pointSize * 12) return bad('SIGNAL', `ordre limit trop éloigné du prix réel (${price.mid})`);
    } else if (Math.abs(entry - price.mid) > (sp.maxDevPts || c.maxEntryDeviationPoints) * sp.pointSize) return bad('SIGNAL', `entry trop éloigné du prix réel (${price.mid}) : signal périmé`);
    const eqF = eqFactor(sym);
    const slPts = r2(Math.abs(entry - sl) / sp.pointSize);
    let tpPts = r2(Math.abs(tp - entry) / sp.pointSize);
    const slEq = r2(slPts * eqF), tp1Eq = r2(tpPts * eqF);
    if (p.source !== 'OPR' && !p.limit && slEq > m.slMax + 1e-9) return bad('SIGNAL', `SL ${slEq} pts-or > maximum ${m.slMax} (${mode})`);
    if (p.source !== 'NEWS' && p.source !== 'OPR' && !(m.rr > 0) && tp1Eq < m.tp1 - 0.05) return bad('SIGNAL', `TP1 ${tp1Eq} pts-or < minimum ${m.tp1} (${mode})`);
    const spreadEq = price.ask && price.bid ? r2((price.ask - price.bid) / sp.pointSize * eqF) : 0;
    if (spreadEq > m.maxSpread) return bad('SIGNAL', `spread ${spreadEq} pts-or > maximum ${m.maxSpread} (${mode})`);
    ok('SIGNAL', `${mode} ${sym} ${p.action} entry ${entry} SL ${slPts}pts TP1 ${tpPts}pts` + (tp2 !== null ? ` TP2 ${r2(Math.abs(tp2 - entry) / sp.pointSize)}pts` : '') + (tp3 !== null ? ` TP3 ${r2(Math.abs(tp3 - entry) / sp.pointSize)}pts` : '') + ` · spread ${spreadEq} pts-or (prix ${price.src})`);

    // 2) RISK
    const b = balanceInfo(), rk = c.risk || {};
    if (b.balance === null) return bad('RISK', 'DATA_UNAVAILABLE: solde inconnu (cTrader non connecté ou startBalance non défini)');
    if (b.equity !== null) S.peakEquity = Math.max(S.peakEquity || 0, b.equity);
    const dd = rk.maxDrawdownPct > 0 ? risk.drawdownState(S.peakEquity, b.equity, rk.maxDrawdownPct) : { ok: true, pct: 0 };   // 0 = désactivé
    if (!dd.ok) return bad('RISK', `drawdown ${dd.pct}% ≥ ${rk.maxDrawdownPct}% (max drawdown)`);
    const cl = rk.maxConsecutiveLosses > 0 ? risk.consecutiveLossState(S.day.consecLosses || 0, rk.maxConsecutiveLosses) : { ok: true, losses: 0, max: 0 };   // 0 = désactivé
    if (p.source !== 'OPR' && !cl.ok) return bad('RISK', `${cl.losses} pertes consécutives (max ${cl.max})`);
    // 1 SEUL SETUP ACTIF PAR PAIRE : tant qu'il n'est pas terminé (TP / SL / clôture), aucun nouveau trade sur cette paire. Les autres paires restent libres (en parallèle).
    // « 1 trade actif par paire » = OPTION par mode (modes.X.onePerPair, désactivée par défaut). Plafond de setups : maxActiveTrades > 0 seulement (0 = illimité).
    if (p.source !== 'OPR' && p.source !== 'NEWS' && m.onePerPair && activeTrades().some(t => t.symbol === sym)) return bad('RISK', `${sym} : un trade est déjà actif sur cette paire (option 1 trade/paire activée)`);
    if (p.source !== 'OPR' && c.maxActiveTrades > 0 && new Set(activeTrades().map(t => t.setupId || t.id)).size >= Math.max(c.maxActiveTrades, (c.symbolsAllowed || []).length)) return bad('RISK', `trop de setups actifs (max ${c.maxActiveTrades})`);
    const pct = p.source === 'NEWS' ? c.news.riskPerTradePct : (p.source === 'OPR' ? c.opr.riskPct : c.riskPerTradePct);
    let cap = b.balance * pct / 100;
    const asked = num(p.risk); if (asked && asked > 0) cap = Math.min(cap, asked);
    if (c.mode === 'PROP' && c.prop.maxRiskPerTradeMoney) cap = Math.min(cap, c.prop.maxRiskPerTradeMoney);
    let sz = size(slPts, cap, sym), micro = false;
    if (!sz.lots && c.micro && c.micro.enabled && b.balance <= c.micro.balanceBelow) {   // compte micro : lot minimum autorisé si risque ≤ maxRiskPct % du solde
      const ll0 = lotLimits(sym), rm0 = r2(ll0.minLot * sz.perLot), capM = b.balance * c.micro.maxRiskPct / 100;
      if (!(sz.perLot > 0)) return bad('RISK', 'valeur du point indisponible');
      if (rm0 <= capM + 1e-9) { sz = { lots: ll0.minLot, riskMoney: rm0, perLot: sz.perLot }; micro = true; }
      else return bad('RISK', `COMPTE MICRO : lot min ${ll0.minLot} risque ${rm0}$ > ${c.micro.maxRiskPct}% du solde (${r2(capM)}$). Solde minimum pour ce SL : ${r2(rm0 / (c.micro.maxRiskPct / 100))}$`);
    }
    if (!sz.lots) return bad('RISK', `volume minimum cTrader dépasse le risque autorisé (${r2(cap)}$ pour SL ${slPts}pts)`);
    // lot qui monte une fois le profit protégé (Protected Profit Floor)
    let mult = 1;
    const fl = c.mode === 'NORMAL' ? ppState() : { locked: false, multiplier: 1 };
    if (fl.locked && fl.multiplier > 1) {
      const nlz = risk.normalizeLots(sz.lots * fl.multiplier, lotLimits(sym));
      const capMicro = c.micro && c.micro.enabled && b.balance <= c.micro.balanceBelow ? b.balance * c.micro.maxRiskPct / 100 : Infinity;
      if (nlz.ok && r2(nlz.lots * sz.perLot) <= capMicro + 1e-9) { mult = +(nlz.lots / sz.lots).toFixed(4); sz = { lots: nlz.lots, riskMoney: r2(nlz.lots * sz.perLot), perLot: sz.perLot }; }
    }
    // plusieurs positions TP1/TP2/TP3 au même prix
    const tps = [{ tp, tag: 'TP1' }];
    if (tp2 !== null) tps.push({ tp: tp2, tag: 'TP2' });
    if (tp3 !== null && tp2 !== null) tps.push({ tp: tp3, tag: 'TP3' });
    let legs = null;
    if (tps.length > 1 && c.split && c.split.enabled) {
      const ll = lotLimits(sym);
      if (tps.length === 2 && p.tp1Frac > 0.5 && p.tp1Frac < 1) {   // R MINIMUM 1 : part fermée à TP1 > 50 % (TP1 + BE >= +1R)
        const st = ll.lotStep > 0 ? ll.lotStep : 0.01, l1 = +(Math.floor(sz.lots * p.tp1Frac / st + 1e-9) * st).toFixed(8), l2 = +(Math.floor((sz.lots - l1) / st + 1e-9) * st).toFixed(8);
        if (l1 >= ll.minLot - 1e-12 && l2 >= ll.minLot - 1e-12) legs = [l1, l2].map((lt, i) => ({ lots: lt, tp: tps[i].tp, tpPts: r2(Math.abs(tps[i].tp - entry) / sp.pointSize), riskMoney: r2(lt * sz.perLot), tag: tps[i].tag }));
      }
      for (let n = tps.length; n >= 2 && !legs; n--) {
        const hl = +(Math.floor(sz.lots / n / ll.lotStep + 1e-9) * ll.lotStep).toFixed(8);
        if (hl >= ll.minLot - 1e-12) legs = tps.slice(0, n).map(x => ({ lots: hl, tp: x.tp, tpPts: r2(Math.abs(x.tp - entry) / sp.pointSize), riskMoney: r2(hl * sz.perLot), tag: x.tag }));
      }
    }
    if (!legs && tp2 !== null && c.micro && c.micro.singleUseTp2 && !(p.tp1Frac >= 0.8)) { tp = tp2; tpPts = r2(Math.abs(tp2 - entry) / sp.pointSize); }   // 1 seule position : elle vise l'objectif complet
    const totalLots = legs ? +legs.reduce((a, x) => a + x.lots, 0).toFixed(8) : sz.lots;
    const totalRisk = legs ? r2(legs.reduce((a, x) => a + x.riskMoney, 0)) : sz.riskMoney;
    if (rk.maxOpenPositions > 0 && activeTrades().length + (legs ? legs.length : 1) > rk.maxOpenPositions) return bad('RISK', `positions ouvertes > maximum ${rk.maxOpenPositions}`);
    ok('RISK', (legs ? `${legs.length} positions de ${legs[0].lots} lot (${legs.map(x => x.tag + ' ' + x.tpPts + 'pts').join(' / ')})` : `lots ${sz.lots}${micro ? ' (COMPTE MICRO : lot minimum)' : ''}${tp2 !== null ? ` (1 seule position -> TP ${tpPts}pts)` : ''}`) +
      `${mult > 1 ? ` · lot ×${mult} (profit protégé)` : ''}, risque ${totalRisk}$ (${r2(totalRisk / b.balance * 100)}% du solde)`);

    // 3) MODE
    if (p.source !== 'OPR' && c.active === 'OFF') return bad('MODE', 'IA Mentor désactivé (bouton OFF)');
    if (S.manualBlock) return bad('MODE', 'bloqué manuellement: ' + S.manualBlock);
    if (p.source !== 'OPR' && oprState(ts).active) return bad('MODE', 'OPR actif : IA Mentor en pause');
    if (p.source !== 'NEWS') {
      const nc = newsContext(ts);
      if (nc.paused) return bad('MODE', `mode NEWS actif (${nc.event.title}) : trading normal suspendu`);
      if (newsStale()) return bad('MODE', 'DATA_UNAVAILABLE: calendrier news indisponible ou périmé : trading suspendu (news.requireData)');
    }
    ok('MODE', p.source === 'NEWS' ? 'NEWS autorisé' : p.source === 'OPR' ? 'OPR autorisé (robot OPR indépendant de l\'IA Mentor)' : `${mode} autorisé · news OK`);

    // 4) RULE
    if (c.mode === 'PROP') {
      const ps = propStatus();
      if (ps.blocked) return bad('RULE', 'PROP RULE CHECK: ' + ps.reasons.join('; '));
      if (ps.remainingDailyLoss !== null && totalRisk > ps.remainingDailyLoss) return bad('RULE', `PROP RULE CHECK: risque ${totalRisk}$ > marge journalière ${ps.remainingDailyLoss}$`);
      if (ps.remainingOverallLoss !== null && totalRisk > ps.remainingOverallLoss) return bad('RULE', `PROP RULE CHECK: risque ${totalRisk}$ > marge globale ${ps.remainingOverallLoss}$`);
      ok('RULE', 'PROP RULE CHECK ok');
    } else if (p.source === 'OPR') {
      ok('RULE', 'OPR : règles propres à la stratégie OPR (1 trade/jour, RR ' + c.opr.rr + ')');
    } else if (p.source === 'NEWS' && !fl.locked) {
      ok('RULE', 'NEWS: limites propres à la news (voir config.news)');
    } else {
      const nl = normalLimits();
      if (nl.stopped) return bad('RULE', nl.reason);
      const slEqM = r2(slEq * mult);   // en « points-or » au lot de base
      if (fl.locked) {
        if (fl.unit === 'MONEY') { if (totalRisk > fl.budget + 1e-9) return bad('RULE', `profit protégé (floor ${fl.floor}) : risque ${totalRisk} > marge ${fl.budget}`); }
        else if (slEqM > fl.budget + 1e-9) return bad('RULE', `profit protégé (floor ${fl.floor} pts) : SL ${slEqM} pts-or (lot ×${mult}) > marge ${fl.budget} pts`);
      } else {
        const allow = c.normal.dailyLossPoints + dayNetPts();
        if (slEqM > allow) return bad('RULE', `SL ${slEqM} pts-or > marge de perte restante ${r2(allow)} pts-or`);
      }
      if (p.source !== 'NEWS' && tpPts / slPts < c.normal.minRR) return bad('RULE', `RR ${r2(tpPts / slPts)} < ${c.normal.minRR}`);
      ok('RULE', fl.locked ? `Protected Profit Floor respecté (floor ${fl.floor}${fl.unit === 'MONEY' ? '' : ' pts'})` : 'limites NORMAL ok');
    }

    const order = { tradingMode: mode, symbol: sym, action: p.action, entry, sl, tp, tp2, tp3, slPts, tpPts, mult, lots: totalLots, riskMoney: totalRisk, legs };
    if (c.liveExecution && typeof opts.preTrade === 'function') {   // marge réelle cTrader (ProtoOAExpectedMarginReq) vs marge libre
      let r; try { r = await opts.preTrade(order); } catch (e) { r = { ok: false, reason: 'vérification de marge impossible: ' + (e && e.message) }; }
      if (!r || !r.ok) return bad('RISK', (r && r.reason) || 'marge insuffisante');
      ok('RISK', 'marge cTrader suffisante' + (r.detail ? ' (' + r.detail + ')' : ''));
    }
    return { ok: true, checks, order };
  }

  function queue(p, g, ts) {
    const o = g.order, isOpr = p.source === 'OPR', qMode = isOpr ? 'OPR' : (o.tradingMode || cfg().tradingMode), qm = modeCfg(isOpr ? cfg().tradingMode : qMode);
    const legs = o.legs || [{ lots: o.lots, tp: o.tp, tpPts: o.tpPts, riskMoney: o.riskMoney, tag: 'TP1' }];
    const setupId = `T${ts}-${++S.seq}`, totalLots = legs.reduce((a, x) => a + x.lots, 0), made = [];
    const comps = (p.analysis && p.analysis.components) || [];
    const cond = names => comps.filter(x => names.includes(x.name)).map(x => ({ name: x.name, pass: x.pass, detail: x.detail }));
    const nc = newsContext(ts);
    legs.forEach((lg, i) => {
      const t = {
        id: legs.length > 1 ? `${setupId}-${i + 1}` : setupId, setupId, leg: legs.length > 1 ? lg.tag : null, weight: legs.length > 1 ? lg.lots / totalLots : 1, mult: o.mult || 1,
        ts: new Date(ts).toISOString(), user: userId, ctraderAccountId: S.exec.accountId || null, mode: p.source === 'NEWS' ? 'NEWS' : (isOpr ? 'OPR' : cfg().mode), tradingMode: qMode,
        timeframe: p.source === 'NEWS' ? null : (isOpr ? 'M5' : `M${qm.tf.entry}`), symbol: o.symbol,
        action: o.action, entry: o.entry, sl: o.sl, tp: lg.tp, slPts: o.slPts, tpPts: lg.tpPts,
        lots: lg.lots, riskMoney: lg.riskMoney, confidence: p.analysis ? p.analysis.confidence : (p.confidence != null ? p.confidence : null), reason: p.reason || '',
        keyZone: (p.analysis && p.analysis.zone) || null,
        smcConditions: cond(['structure', 'mtf', 'trigger', 'sweep', 'zone', 'premiumDiscount']), orderFlowConditions: cond(['orderFlow']),
        newsCondition: nc.paused ? `PAUSE (${nc.event.title})` : (newsStale() ? 'UNAVAILABLE' : 'OK'),
        status: 'PENDING', execNote: 'en attente d\'envoi à cTrader', result: null
      };
      if (p.limit) { t.orderType = 'LIMIT'; t.limitExpiryTs = ts + (p.expiryMin ? p.expiryMin * 60000 : (p.expiryBars || 48) * 5 * 60000); t.strategy = 'ARES IP'; t.setupName = 'Zone limit'; t.execNote = 'ordre limit en attente d\'envoi à cTrader'; }
      S.trades.push(t); made.push(t);
    });
    while (S.trades.length > 500) S.trades.shift();
    S.day.trades++;
    if (!S.tradingDays.includes(S.day.date)) S.tradingDays.push(S.day.date);
    const t = made[0];
    S.lastDecision = { action: t.action, symbol: t.symbol, entry: t.entry, sl: t.sl, tp: t.tp, tp2: legs.length > 1 ? legs[1].tp : null, tp3: legs.length > 2 ? legs[2].tp : null, risk: o.riskMoney, lots: o.lots,
      mode: t.mode, tradingMode: t.tradingMode, timeframe: t.timeframe, confidence: t.confidence, reason: t.reason, ts: t.ts, id: t.id };
    log('TRADE', `${t.tradingMode} ${t.symbol} ${t.action} ${t.status}` + (legs.length > 1 ? ` · ${legs.length} positions` : ''), { kind: 'trade', signal: p, entry: t.entry, sl: t.sl, tp: t.tp, lots: o.lots, risk: o.riskMoney, tradeId: t.id, tradeIds: made.map(x => x.id), checks: g.checks }, true);
    save();
    Object.defineProperty(t, 'legsIds', { value: made.map(x => x.id), enumerable: false });
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
    return { ok: true, decision: 'TRADE', tradeId: t.id, tradeIds: t.legsIds, status: t.status, order: g.order, checks: g.checks,
      note: 'Ordre RÉEL en attente d\'envoi à cTrader' };
  }

  // ---------- exécution cTrader (appelée par ctrader/execution.js) ----------
  function execNext() {
    if (!cfg().liveExecution || S.exec.status !== 'CONNECTED') return null;
    const t = S.trades.find(x => x.status === 'PENDING');
    if (!t) return null;
    t.status = 'SENT'; t.sentTs = clock(); t.execNote = t.orderType === 'LIMIT' ? 'ordre limit envoyé à cTrader' : 'envoyé à cTrader'; save();
    return { id: t.id, symbol: t.symbol, action: t.action, type: t.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET', lots: t.lots, sl: t.sl, tp: t.tp, entryRef: t.entry, limitPrice: t.orderType === 'LIMIT' ? t.entry : undefined, expiresAt: t.orderType === 'LIMIT' ? t.limitExpiryTs : undefined, comment: 'ARES-' + t.tradingMode };
  }
  /** cTrader a ACCEPTÉ l'ordre limit (il attend le prix). */
  function execPending({ id, orderId }) {
    const t = S.trades.find(x => x.id === id);
    if (!t || t.orderType !== 'LIMIT' || !['SENT', 'UNCONFIRMED', 'PENDING'].includes(t.status)) return { ok: false, error: 'ordre limit inconnu ou état invalide' };
    t.status = 'LIMIT'; t.orderId = orderId != null ? String(orderId) : t.orderId || null; t.execNote = 'ordre limit en attente du prix (cTrader)'; save();
    log('LIMIT', `${t.symbol} ${t.action} limit ${t.entry} posé sur cTrader`, { kind: 'limit', tradeId: id, orderId: t.orderId }, true);
    return { ok: true };
  }
  /** Ordres limit à ANNULER chez cTrader (expiré / news / hors fenêtre / demande utilisateur) : lus par ctrader/execution.js. */
  function cancelNext() {
    const t = S.trades.find(x => x.status === 'LIMIT' && x.cancelReq && !x.cancelSent);
    if (!t) return null;
    t.cancelSent = clock(); save();
    return { id: t.id, orderId: t.orderId, symbol: t.symbol };
  }
  function execCancelled({ id, reason }) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !['LIMIT', 'SENT', 'PENDING', 'UNCONFIRMED'].includes(t.status) || t.orderType !== 'LIMIT') return { ok: false, error: 'ordre limit inconnu ou déjà rempli' };
    t.status = 'CANCELLED'; t.execNote = String(t.cancelReq || reason || 'annulé').slice(0, 160); t.result = { note: t.execNote };
    clearDecision(t, 'Ordre limit annulé : ' + t.execNote);
    if (S.day && (!t.leg || t.leg === 'TP1')) S.day.trades = Math.max(0, S.day.trades - 1);
    log('LIMIT', `${t.symbol} ordre limit annulé : ${t.execNote}`, { kind: 'limit', tradeId: id }, true);
    save();
    return { ok: true };
  }
  /** Annulation demandée depuis le site (panel Trade) ou par une règle. */
  function cancelLimit(id, why) {
    const t = S.trades.find(x => x.id === id);
    if (!t || t.orderType !== 'LIMIT' || !['LIMIT', 'SENT', 'PENDING'].includes(t.status)) return { ok: false, error: 'aucun ordre limit annulable avec cet id' };
    if (t.status === 'PENDING') { t.status = 'CANCELLED'; t.execNote = why || 'annulé avant envoi'; if (S.day) S.day.trades = Math.max(0, S.day.trades - 1); save(); return { ok: true, local: true }; }
    t.cancelReq = why || 'annulé par l\'utilisateur'; save();
    return { ok: true };
  }
  function execAck({ id, positionId, ticket, fillPrice }) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !['SENT', 'UNCONFIRMED', 'PENDING', 'LIMIT'].includes(t.status)) return { ok: false, error: 'ordre inconnu ou état invalide' };
    const sp = specOf(t.symbol) || { pointSize: cfg().pointSize };
    if (t.orderType === 'LIMIT' && !t.touchedAt) t.touchedAt = clock();
    t.status = 'OPEN'; t.ticket = positionId || ticket || null; t.openPrice = num(fillPrice) || t.entry; t.execNote = 'position ouverte';
    const slipEq = r2(Math.abs(t.openPrice - t.entry) / sp.pointSize * eqFactor(t.symbol)), maxS = (cfg().risk || {}).maxSlippagePts;
    const exceeded = !!(maxS && slipEq > maxS);
    if (exceeded) { t.slippageExceeded = true; log('SLIPPAGE', `${t.id} : slippage ${slipEq} pts-or > max ${maxS}`, { kind: 'slip', tradeId: t.id }, true); }
    save();
    log('MANAGING', 'Ordre ouvert ' + id, { kind: 'ack', tradeId: id, ticket: t.ticket }, true);
    return { ok: true, slippageExceeded: exceeded, slippageEq: slipEq, closeOnSlippage: exceeded && !!(cfg().risk || {}).closeOnSlippage };
  }
  /** Ordre refusé / erreur d'exécution cTrader : aucune position ouverte. */
  /** Un signal qui n'a jamais ouvert de position ne doit plus rester affiché comme « signal actif » (notification / carte fantôme). */
  function clearDecision(t, reason) {
    const d = S.lastDecision;
    if (d && d.id && t && String(d.id).startsWith(t.setupId || t.id)) S.lastDecision = { action: 'WAIT', reason, ts: new Date(clock()).toISOString() };
  }
  function execFail({ id, reason }) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !['SENT', 'PENDING', 'UNCONFIRMED', 'LIMIT'].includes(t.status)) return { ok: false, error: 'ordre inconnu ou état invalide' };
    t.status = 'REJECTED'; t.execNote = String(reason || 'refusé').slice(0, 200); t.result = { note: t.execNote };
    clearDecision(t, 'Ordre refusé par cTrader : ' + t.execNote);
    const sib = S.trades.filter(x => x.setupId === t.setupId);
    if (S.day && sib.every(x => ['REJECTED', 'EXPIRED', 'CANCELLED'].includes(x.status))) S.day.trades = Math.max(0, S.day.trades - 1);
    log('EXEC_ERROR', `${t.id} : ${t.execNote}`, { kind: 'execerr', tradeId: id }, true);
    save();
    return { ok: true };
  }
  const CLOSED_ST = ['CLOSED', 'REJECTED', 'CANCELLED', 'EXPIRED'];
  /** Résumé réel (statut, TP/SL, P/L) des trades ouverts par une news. */
  function newsTrades(ev) {
    const ex = ev && ev.executed; if (!ex || ex.status !== 'EXECUTED') return { trades: [], result: null };
    const ids = ex.tradeIds || (ex.tradeId ? [ex.tradeId] : []);
    const trades = ids.map(id => S.trades.find(x => x.id === id)).filter(Boolean).map(t => ({
      id: t.id, symbol: t.symbol, action: t.action, leg: t.leg, lots: t.lots, entry: t.entry, sl: t.sl, tp: t.tp, status: t.status,
      exit: t.exitPrice != null ? t.exitPrice : null, pnlMoney: t.result && t.result.pnlMoney != null ? t.result.pnlMoney : null,
      pnlPoints: t.result && t.result.pnlPoints != null ? t.result.pnlPoints : null, outcome: t.result && t.result.outcome || null,
      hit: t.status === 'CLOSED' ? (t.result.outcome === 'WIN' ? 'TP' : t.result.outcome === 'LOSS' ? 'SL' : 'BE') : null
    }));
    const open = trades.filter(t => ACTIVE.includes(t.status)).length, closed = trades.filter(t => t.status === 'CLOSED');
    const money = r2(closed.reduce((a, t) => a + (t.pnlMoney || 0), 0)), pts = r2(closed.reduce((a, t) => a + (t.pnlPoints || 0), 0));
    const state = !trades.length ? 'NONE' : open ? 'OPEN' : !closed.length ? 'NONE' : money > 0 ? 'WIN' : money < 0 ? 'LOSS' : 'BREAKEVEN';
    return { trades, result: { state, open, pnlMoney: money, pnlPoints: pts, label: state === 'WIN' ? 'KILLED' : state === 'LOSS' ? 'SL HIT' : state === 'OPEN' ? 'EN COURS' : state === 'BREAKEVEN' ? 'BREAKEVEN' : '—' } };
  }
  function newsResult(t) {
    const ev = S.news.find(e => e.executed && (e.executed.tradeIds || []).includes(t.id)); if (!ev) return;
    const v = newsTrades(Object.assign({}, ev, { executed: ev.executed }));
    // newsTrades lit S.trades : le trade courant vient d'être marqué CLOSED juste avant cet appel
    if (!v.result || v.result.state === 'OPEN') return;
    ev.executed.result = v.result;
    const nm = newsCore.coreKey(ev.title) || ev.title;
    log('NEWS RESULT', `${nm} ${v.result.label} ${v.result.state === 'WIN' ? '✅' : v.result.state === 'LOSS' ? '❌' : ''} · ${v.result.pnlMoney >= 0 ? '+' : ''}${v.result.pnlMoney}$ (${v.result.pnlPoints} pts)`, { kind: 'news', result: v.result, eventId: ev.id }, true);
  }
  function closeTrade(t, { closePrice, pnlPoints, pnlMoney, balance, equity }) {
    const open = t.openPrice || t.entry;
    let pts = num(pnlPoints);
    if (pts === null && num(closePrice) !== null) pts = r2((t.action === 'BUY' ? closePrice - open : open - closePrice) / (specOf(t.symbol) || { pointSize: cfg().pointSize }).pointSize);
    if (pts === null) return { ok: false, error: 'pnlPoints ou closePrice requis' };
    let money = num(pnlMoney); if (money === null) money = r2(pts * vppOf(t.symbol) * t.lots);
    t.status = 'CLOSED'; t.exitPrice = num(closePrice); t.execNote = 'clôturé';
    t.result = { closePrice: num(closePrice), pnlPoints: pts, pnlMoney: money, closedAt: new Date(clock()).toISOString(), outcome: money > 0 ? 'WIN' : (money < 0 ? 'LOSS' : 'BREAKEVEN') };
    rollDay(clock());
    const d = S.day, w = (t.weight || 1) * (t.mult || 1) * eqFactor(t.symbol);   // points-or normalisés au lot de base
    if (pts >= 0) { d.profitPts = r2(d.profitPts + pts * w); d.wins++; d.consecLosses = 0; } else { d.lossPts = r2(d.lossPts + Math.abs(pts) * w); d.losses++; d.consecLosses = (d.consecLosses || 0) + 1; S.autoState.lastLossTs = clock(); (S.autoState.lossBy = S.autoState.lossBy || {})[`${t.symbol}:${t.tradingMode}`] = clock(); }
    d.pnlMoney = r2(d.pnlMoney + money); S.realizedMoney = r2(S.realizedMoney + money);
    d.peakPts = Math.max(d.peakPts || 0, dayNetPts()); d.peakMoney = Math.max(d.peakMoney || 0, d.pnlMoney);
    const fl = ppState();
    const reached = cfg().profitProtection.enabled && cfg().mode === 'NORMAL' ? fl.locked : dayNetPts() >= cfg().normal.objectivePoints;
    if (!d.objectiveReached && reached) { d.objectiveReached = true; log('OBJECTIVE', `Objectif jour atteint : Protected Profit Floor ${fl.floor != null ? fl.floor : ''} activé, le robot continue (objectif, pas une promesse)`, { kind: 'obj' }, true); }
    const bal = num(balance), eq = num(equity);
    if (bal !== null) S.account = Object.assign({}, S.account, { balance: bal, equity: eq !== null ? eq : bal, ts: clock() });
    if (t.mode === 'NEWS') newsResult(t);
    log('CLOSED', `${t.id} ${pts} pts / ${money}$`, { kind: 'result', tradeId: t.id, result: t.result, signal: { action: t.action, entry: t.entry, sl: t.sl, tp: t.tp }, risk: t.riskMoney }, true);
    save();
    return { ok: true, trade: t };
  }
  /** Breakeven LIVE : quand la jambe TP1 d'un setup se clôture en gain, retourne les autres jambes encore ouvertes (même setupId) dont le SL doit passer à l'entrée. */
  function beTargets(tradeId) {
    const t = S.trades.find(x => x.id === tradeId);
    if (!t || t.status !== 'CLOSED' || t.leg !== 'TP1' || !t.result || !(t.result.pnlMoney > 0)) return [];
    const out = [];
    for (const x of S.trades) {
      if (x.setupId !== t.setupId || x.id === t.id || x.status !== 'OPEN' || !x.ticket || x.beDone) continue;
      x.beDone = true; out.push({ id: x.id, ticket: x.ticket, sl: num(x.openPrice) || x.entry, symbol: x.symbol });
    }
    if (out.length) { log('BE', `${t.setupId} : TP1 touché, SL des ${out.length} position(s) restante(s) -> breakeven`, { kind: 'be', tradeId: t.id }, true); save(); }
    return out;
  }
  const execResult = body => {
    const t = S.trades.find(x => x.id === body.id);
    if (!t || !ACTIVE.includes(t.status)) return { ok: false, error: 'ordre inconnu ou déjà clos' };
    return closeTrade(t, body);
  };
  function manualClose(id, body) {
    const t = S.trades.find(x => x.id === id);
    if (!t || !ACTIVE.includes(t.status)) return { ok: false, error: 'ordre inconnu ou déjà clos' };
    if (body && (num(body.pnlPoints) !== null || num(body.closePrice) !== null)) return closeTrade(t, body);
    t.status = 'CANCELLED'; t.result = { note: 'clos manuellement sans P/L' }; save();
    return { ok: true, trade: t };
  }
  function updateAccount({ balance, equity, margin, freeMargin, accountId, login, isLive, bid, ask, mid, prices }) {
    const b = num(balance), e = num(equity);
    if (b !== null) S.account = { balance: b, equity: e !== null ? e : b, margin: num(margin), freeMargin: num(freeMargin), ts: clock() };
    if (S.account.equity !== null) S.peakEquity = Math.max(S.peakEquity || 0, S.account.equity);
    if (accountId !== undefined) S.exec.accountId = String(accountId);
    if (login !== undefined) S.exec.login = String(login);
    if (isLive !== undefined) S.exec.isLive = !!isLive;
    if (bid !== undefined || ask !== undefined || mid !== undefined) pushPrice({ bid, ask, mid }, cfg().symbol);
    // prices : { EURUSD: { bid, ask, mid, vpl, minLot, lotStep, maxLot, digits }, ... } valeurs réelles du broker (cTrader)
    if (isObj(prices)) {
      for (const name of Object.keys(prices).slice(0, 30)) {
        const x = prices[name] || {}, k = symOf(name);
        pushPrice({ bid: x.bid, ask: x.ask, mid: x.mid }, k);
        if (x.vpl !== undefined || x.minLot !== undefined || x.lotStep !== undefined || x.maxLot !== undefined)
          S.specs[k] = Object.assign({}, S.specs[k], { vpl: num(x.vpl) > 0 ? num(x.vpl) : (S.specs[k] || {}).vpl, minLot: num(x.minLot) || (S.specs[k] || {}).minLot, lotStep: num(x.lotStep) || (S.specs[k] || {}).lotStep, maxLot: num(x.maxLot) || (S.specs[k] || {}).maxLot, digits: num(x.digits) !== null ? num(x.digits) : (S.specs[k] || {}).digits });
      }
    }
    save();
    return { ok: true };
  }
  /** État de la connexion cTrader (poussé par ctrader/execution.js). */
  function setExecStatus(info) {
    S.exec = Object.assign({}, S.exec, isObj(info) ? info : {}, { provider: 'cTrader', updatedAt: clock() });
    save();
    return { ok: true };
  }

  function plView() {
    const ts = clock(), tz = cfg().timezone, today = localParts(ts, tz).date, month = today.slice(0, 7);
    const cats = { DAYTRADE: 'DAY TRADE', OPR: 'LOR', NEWS: 'NEWS' }, out = {};
    for (const k of Object.keys(cats)) out[k] = { label: cats[k], today: 0, month: 0, total: 0, trades: 0, wins: 0, losses: 0, open: 0 };
    for (const t of S.trades) {
      const k = t.mode === 'OPR' ? 'OPR' : t.mode === 'NEWS' ? 'NEWS' : t.tradingMode; if (!out[k]) continue;
      if (ACTIVE.includes(t.status)) { out[k].open++; continue; }
      if (t.status !== 'CLOSED' || !t.result) continue;
      const m = t.result.pnlMoney || 0, d = localParts(Date.parse(t.result.closedAt || t.ts), tz).date, o = out[k];
      o.total += m; o.trades++; if (d === today) o.today += m; if (d.slice(0, 7) === month) o.month += m;
      if (t.result.outcome === 'WIN') o.wins++; else if (t.result.outcome === 'LOSS') o.losses++;
    }
    const bySym = {};
    for (const t of S.trades) {
      if (t.status !== 'CLOSED' || !t.result || t.mode === 'OPR' || t.mode === 'NEWS') continue;
      const m = t.result.pnlMoney || 0, d = localParts(Date.parse(t.result.closedAt || t.ts), tz).date, o = (bySym[t.symbol] = bySym[t.symbol] || { symbol: t.symbol, today: 0, month: 0, total: 0, trades: 0, wins: 0, losses: 0, be: 0 });
      o.total += m; o.trades++; if (d === today) o.today += m; if (d.slice(0, 7) === month) o.month += m;
      if (t.result.outcome === 'WIN') o.wins++; else if (t.result.outcome === 'LOSS') o.losses++; else o.be++;
    }
    const pairs = Object.values(bySym).map(o => { for (const f of ['today', 'month', 'total']) o[f] = r2(o[f]); return o; }).sort((a, b) => b.total - a.total);
    const all = { label: 'TOTAL', today: 0, month: 0, total: 0, trades: 0, wins: 0, losses: 0, open: 0 };
    for (const k of Object.keys(out)) { const o = out[k]; for (const f of ['today', 'month', 'total']) o[f] = r2(o[f]); for (const f of ['today', 'month', 'total', 'trades', 'wins', 'losses', 'open']) all[f] += o[f]; }
    for (const f of ['today', 'month', 'total']) all[f] = r2(all[f]);
    return { ok: true, date: today, categories: out, all, bySymbol: pairs, balance: balanceInfo().balance };
  }


  const sessionCloseDue = () => !!(cfg().session && cfg().session.enabled && hhmmUTC() >= cfg().session.closeAllUTC);

  // =====================================================================================================================
  // ARES IP — stratégie unique. Zones OB+FVG M5/M15/M30/H1 + zone clé H4 ; probabilité apprise sur l'historique réel (backtest) ;
  // un seul sens à la fois ; une seule zone à la fois (la plus proche parmi les zones retenues) ; SL 50–100 pips ; RR choisi par le robot.
  // =====================================================================================================================
  const ipCfg = () => Object.assign({}, IP.DEFAULTS, cfg().ip || {});
  const ipStatsFile = path.join(dataDir, 'ares-ip-stats.json');
  let IPSTATS = { stats: null, savedAt: null, meta: null };
  try { IPSTATS = Object.assign(IPSTATS, JSON.parse(fs.readFileSync(ipStatsFile, 'utf8'))); } catch (e) { /* aucune statistique : lancer le backtest */ }
  /** Statistiques (TF × grade) issues du dernier backtest : base de la probabilité utilisée par le robot en direct. */
  function setIpStats(stats, meta) {
    if (!stats || typeof stats !== 'object') return { ok: false, error: 'statistiques invalides' };
    IPSTATS = { stats, savedAt: new Date(clock()).toISOString(), meta: meta || null }; IPVIEW = { ts: 0, ev: null };
    try { fs.writeFileSync(ipStatsFile, JSON.stringify(IPSTATS)); } catch (e) { /* mémoire seule */ }
    log('IP', 'Statistiques de probabilité mises à jour (backtest)', { kind: 'ip' }, true);
    return { ok: true, savedAt: IPSTATS.savedAt };
  }
  const ipBars = sym => { const m = CANDLES[sym] || {}, out = {}; for (const tf of [5, 15, 30, 60, 240]) out[tf] = (m[tf] || []).slice(0, -1); return out; };   // bougies FERMÉES seulement
  let IPVIEW = { ts: 0, ev: null };
  function ipEval(force) {
    if (!force && IPVIEW.ev && clock() - IPVIEW.ts < 4000) return IPVIEW.ev;
    const px = freshPrice('XAUUSD');
    let ev; try { ev = IP.evaluate(ipBars('XAUUSD'), IPSTATS.stats || {}, { cfg: ipCfg(), price: px ? px.mid : null }); } catch (e) { ev = { ok: false, wait: 'erreur analyse : ' + (e && e.message) }; }
    IPVIEW = { ts: clock(), ev }; return ev;
  }
  function scanReady(ts) {   // garde commune du scan automatique
    const c = cfg();
    if (!c.autoTrade || c.active === 'OFF') return false;
    if (c.session && c.session.enabled && (hhmmUTC() >= c.session.noEntryAfterUTC || hhmmUTC() < c.session.startUTC)) return false;
    const state = computeState(ts);
    const idle = state.status === 'WAIT' && ['MENTOR_ACTIVE', 'PROFIT_LOCKED'].includes(state.sub);
    return idle || state.status === 'MANAGING';   // MANAGING = un ordre existe déjà : on continue de surveiller la zone retenue
  }
  /** À chaque bougie M5 fermée : zone retenue (probabilité + sens unique + la plus proche) -> ordre LIMIT. Une seule zone à la fois. */
  async function ipScan(ts) {
    if (!scanReady(ts)) return;
    const sym = 'XAUUSD'; if (!(cfg().symbolsAllowed || []).includes(sym)) return;
    const m5 = (CANDLES[sym] || {})[5] || []; if (m5.length < 3) return;
    const lastClosed = m5[m5.length - 2].t, bk = S.ipBook;
    if (bk.lastScanT === lastClosed) return;   // une seule analyse par bougie M5 fermée
    bk.lastScanT = lastClosed;
    if (!IPSTATS.stats) { log('WAIT', 'Ares IP : lancez d\'abord le backtest (probabilités). Aucun ordre sans statistiques.', { kind: 'ip' }); return; }
    const ev = ipEval(true);
    if (!ev.ok) { log('WAIT', 'Ares IP : ' + ev.wait, { kind: 'ip' }); return; }
    const mine = S.trades.filter(t => t.ipKey && ACTIVE.includes(t.status));
    if (mine.some(t => ['OPEN', 'UNCONFIRMED'].includes(t.status))) return;   // trade actif : aucune autre zone avant TP / SL
    const lim = mine.filter(t => t.orderType === 'LIMIT' && ['LIMIT', 'SENT', 'PENDING'].includes(t.status)), best = ev.best;
    if (!best) { for (const t of lim) if (!t.cancelReq) cancelLimit(t.id, 'Ares IP : zone plus retenue (probabilité, sens ou zone clé)'); log('WAIT', 'Ares IP : aucune zone retenue', { kind: 'ip' }); return; }
    if (lim.some(t => t.ipKey === best.id)) return;
    if (lim.length) { for (const t of lim) if (!t.cancelReq) cancelLimit(t.id, 'Ares IP : meilleure zone retenue'); return; }   // la nouvelle zone sera posée au prochain scan
    bk.used = bk.used || {}; bk.cool = bk.cool || {};
    if (bk.used[best.id] || (bk.cool[best.id] || 0) > ts) return;
    const reason = `Ares IP · zone M${best.tf} ${best.side === 'BUY' ? 'demand' : 'supply'} grade ${best.grade} (${best.score}/6) · probabilité ${Math.round(best.pWin * 100)} % · espérance ${best.expR} R · SL ${best.slPips} pips · RR ${best.rr}`;
    const out = await submitSignal({ symbol: sym, tradingMode: 'DAYTRADE', action: best.side, entry: best.entry, sl: best.sl, tp1: best.tp, tp2: null, tp3: null, reason, limit: true,
      expiryMin: Math.min(720, ipCfg().maxAge * best.tf), tp1Frac: 1,
      analysis: { components: [], confidence: Math.round(best.pWin * 100), score: best.score, maxScore: 6, zone: { id: best.id, module: 'IP', tf: 'M' + best.tf, lo: best.bot, hi: best.top } } }, 'NORMAL');
    if (out.ok && out.decision === 'TRADE') {
      const t = S.trades.find(x => x.id === out.tradeId);
      if (t) { t.ipKey = best.id; t.ipTf = 'M' + best.tf; t.timeframe = 'M' + best.tf; t.strategy = 'ARES IP'; t.setupName = `M${best.tf} · grade ${best.grade}`; t.ipProb = best.pWin; t.ipExp = best.expR; t.rrTotal = best.rr; }
      bk.used[best.id] = ts;
      for (const k of Object.keys(bk.used)) if (ts - bk.used[k] > 3 * 86400000) delete bk.used[k];
      log('IP', `${sym} ${best.side} limit ${best.entry} · SL ${best.sl} · TP ${best.tp} · ${reason}`, { kind: 'ip', zone: best.id }, true);
    } else bk.cool[best.id] = ts + 5 * 60000;   // bloqué (risque / limites) : nouvel essai dans 5 min
    save();
  }
  function ipWhy(z, best, ev) {
    if (!z.keyOk) return 'pas de zone clé H4 dans le même sens';
    if (z.touched) return 'déjà touchée';
    if (z.dist <= 0) return 'prix au-delà du limit';
    if (!z.probOk) return `probabilité insuffisante (n=${z.n}, espérance ${z.expR} R)`;
    if (best && z.side !== best.side) return 'sens opposé à la zone la plus probable (pas de contre-sens)';
    if (z.dist > ipCfg().maxDist) return `trop loin (${z.dist} $)`;
    return best && z.id === best.id ? 'RETENUE' : 'plus loin que la zone retenue';
  }
  /** Panel « zone clé » : la zone retenue (probable ET la plus proche), les autres zones et pourquoi elles ne sont pas prises. */
  function tradePanelView() {
    const ts = clock(), ev = ipEval(false), shape = t => ({ id: t.id, ts: t.ts, tf: t.ipTf || t.timeframe, action: t.action, entry: t.entry, sl: t.sl, tp: t.tp, lots: t.lots, status: t.status,
      pnlMoney: t.result && t.result.pnlMoney != null ? t.result.pnlMoney : null, outcome: t.result && t.result.outcome || null, prob: t.ipProb != null ? t.ipProb : null, rr: t.rrTotal != null ? t.rrTotal : null });
    const mine = S.trades.filter(t => t.ipKey), limits = mine.filter(t => t.orderType === 'LIMIT' && ['PENDING', 'SENT', 'LIMIT'].includes(t.status)).map(shape),
      live = mine.filter(t => ['OPEN', 'UNCONFIRMED'].includes(t.status)).map(shape), hist = mine.filter(t => t.status === 'CLOSED').slice(-15).reverse().map(shape);
    const out = { ok: true, strategy: 'Ares IP', ts: new Date(ts).toISOString(), statsReady: !!IPSTATS.stats, statsAt: IPSTATS.savedAt, backtest: IPSTATS.meta || null, balance: balanceInfo().balance,
      limits, live, history: hist, probs: IPSTATS.meta && IPSTATS.meta.probs ? IPSTATS.meta.probs : null };
    if (!ev.ok) return Object.assign(out, { wait: ev.wait, best: null, zones: [] });
    const best = ev.best;
    return Object.assign(out, { price: ev.price, keyZone: ev.keyZone, best: best ? Object.assign({}, best) : null,
      zones: ev.candidates.slice(0, 8).map(z => Object.assign({}, z, { note: ipWhy(z, best, ev) })) });
  }
  function keyZonesView() {
    const ev = IPVIEW.ev;
    return { enabled: true, strategy: 'ARES IP', statsReady: !!IPSTATS.stats, wait: ev && !ev.ok ? ev.wait : null, best: ev && ev.ok && ev.best ? { tf: 'M' + ev.best.tf, side: ev.best.side, entry: ev.best.entry, sl: ev.best.sl, tp: ev.best.tp, rr: ev.best.rr, prob: ev.best.pWin } : null };
  }
  function manageLimits(ts) {
    for (const t of S.trades) {
      if (t.orderType !== 'LIMIT' || t.status !== 'LIMIT' || t.cancelReq) continue;
      const px = freshPrice(t.symbol);   // « touché » : le prix atteint l'entrée de l'ordre limit
      if (px && !t.touchedAt && (t.action === 'BUY' ? px.mid <= t.entry : px.mid >= t.entry)) { t.touchedAt = ts; log('TOUCH', `${t.symbol} prix à l'entrée de l'ordre limit ${t.entry} (touché)`, { kind: 'touch', tradeId: t.id }, true); save(); }
      let why = null;
      if (t.limitExpiryTs && ts > t.limitExpiryTs) why = 'ordre limit expiré (non touché)';
      else if (newsContext(ts).paused) why = 'annulé : pause news';
      if (why) { t.cancelReq = why; log('LIMIT', `${t.symbol} ${why}`, { kind: 'limit', tradeId: t.id }, true); }
    }
  }
  // ---------- tick (1/s) ----------
  async function tick(ts = clock()) {
    rollDay(ts);
    const c = cfg();
    for (const t of S.trades) {
      const age = ts - Date.parse(t.ts);
      if (t.status === 'PENDING' && age > c.signalTTLSec * 1000) { t.status = 'EXPIRED'; t.execNote = 'non envoyé à cTrader dans le délai'; S.day.trades = Math.max(0, S.day.trades - 1); clearDecision(t, 'Ordre non envoyé à cTrader dans le délai : signal annulé'); log('EXPIRED', 'Ordre non pris en charge par cTrader : ' + t.id, { kind: 'exp' }, true); }
      else if (t.status === 'SENT' && ts - t.sentTs > c.signalTTLSec * 1000) { t.status = 'UNCONFIRMED'; t.execNote = 'aucune confirmation cTrader'; log('UNCONFIRMED', 'Aucune confirmation cTrader pour ' + t.id + ' : vérifier le compte puis clore manuellement', { kind: 'unc' }, true); }
    }
    manageLimits(ts);
    try { await ipScan(ts); } catch (e) { log('ERROR', 'Ares IP scan : ' + (e && e.message || e), { kind: 'ip' }); }
    const st = computeState(ts);
    if (st.status !== current.status || st.sub !== current.sub || st.reason !== current.reason) {
      current = st;
      log(st.status, st.reason, { kind: 'state', sub: st.sub });
    }
  }

  // ---------- vues pour le frontend ----------

  function status() {
    const ts = clock(); rollDay(ts);
    const st = computeState(ts), opr = oprState(ts), b = balanceInfo(), nl = normalLimits(), d = S.day, fl = ppState(), m = modeCfg();
    const runModes = modesRunning(), tfs = [...new Set(runModes.flatMap(x => modeCfg(x).timeframes))].sort((a, z) => a - z);
    const active = activeTrades()[0] || null;
    return {
      ok: true, ts: new Date(ts).toISOString(), status: st.status, sub: st.sub, reason: st.reason, mode: cfg().mode, active: cfg().active,
      tradingMode: cfg().tradingMode, combined: !!cfg().combined, runningModes: runModes, timeframes: tfs.map(x => 'M' + x),
      modeInfo: Object.fromEntries(MODE_LIST.map(k => [k, { timeframes: modeCfg(k).timeframes.map(x => 'M' + x), symbols: modeCfg(k).symbols || cfg().symbolsAllowed, tp1: modeCfg(k).tp1, tp2: modeCfg(k).tp2, slMax: modeCfg(k).slMax, tradesToday: modeTradesToday(k), maxSignalsPerDay: modeCfg(k).maxSignalsPerDay > 0 ? modeCfg(k).maxSignalsPerDay * (modeCfg(k).symbols || cfg().symbolsAllowed || []).length : 0, maxPerPair: modeCfg(k).maxSignalsPerDay || 0, rr: modeCfg(k).rr || 0, onePerPair: !!modeCfg(k).onePerPair, entry: k === 'DAYTRADE' ? (modeCfg(k).entry || 'ZONES') : null }])), activePairs: [...new Set(activeTrades().filter(t => t.mode !== 'NEWS').map(t => t.symbol))], autoTrade: cfg().autoTrade, symbolsAllowed: cfg().symbolsAllowed,
      profitLock: { locked: !!fl.locked, enabled: !!cfg().profitProtection.enabled, unit: fl.unit, target: ppCfg().target, floor: fl.floor, budget: fl.budget, lotMultiplier: fl.multiplier, protectedPoints: fl.locked && fl.unit === 'POINTS' ? fl.floor : 0, riskBudgetPoints: riskBudgetPts() === null ? null : r2(riskBudgetPts()) },
      mentor: opr.active ? 'PAUSED' : 'ACTIVE', opr: opr.active ? 'ACTIVE' : 'INACTIVE',
      decision: S.lastDecision || { action: 'WAIT', reason: 'Aucun setup valide' },
      dailyPL: { points: dayNetPts(), profitPoints: d.profitPts, lossPoints: d.lossPts, money: d.pnlMoney, peakPoints: d.peakPts || 0 },
      objective: { points: cfg().normal.objectivePoints, reached: d.objectiveReached }, dailyLossLimit: cfg().normal.dailyLossPoints,
      balance: b.balance, equity: b.equity, margin: S.account.margin, freeMargin: S.account.freeMargin, balanceSource: b.source,
      tradesToday: d.trades, maxTrades: (cfg().mode === 'PROP' ? cfg().prop.maxTrades : cfg().normal.maxTrades) || null, consecutiveLosses: d.consecLosses || 0,
      wins: d.wins, losses: d.losses, normalStopped: nl.stopped, activeTrade: active, openPositions: activeTrades().length,
      news: newsView(ts), prop: cfg().mode === 'PROP' ? propStatus() : { enabled: false },
      dataQuality: { price: freshPrice() ? 'REAL (' + S.price.src + ')' : 'UNAVAILABLE', balance: b.source, news: newsStale() ? 'UNAVAILABLE (périmé)' : (S.newsFeedAt ? 'REAL (flux calendrier)' : 'UNAVAILABLE'), candles: candleCounts(), orderFlow: 'OFF' },
      exec: Object.assign({}, S.exec), liveExecution: cfg().liveExecution, sessionCloseDue: sessionCloseDue(),
      symbols: Object.keys(cfg().symbols || {}), pricesLive: Object.keys(S.prices || {}).filter(k => freshPrice(k)),
      keyZones: keyZonesView(),
      disclaimer: 'Objectif, pas une promesse. Aucune garantie de gain, de floor ni de direction.'
    };
  }
  function newsView(ts) {
    const nc = newsContext(ts), e = nc.event;
    return {
      enabled: cfg().news.enabled, autoTrade: cfg().news.autoTrade, status: nc.paused ? nc.sub : (e ? 'NEWS_WAIT' : 'NO_EVENT'),
      paused: nc.paused, announced: nc.announced, countdownSec: nc.countdownSec, dataStale: newsStale(),
      timing: { announceBeforeMin: cfg().news.announceBeforeMin, analysisBeforeMin: cfg().news.analysisBeforeMin, executeBeforeSec: cfg().news.executeBeforeSec },
      tradeSymbols: cfg().news.symbols,
      event: e ? { id: e.id, title: e.title, time: e.time, impact: e.impact, forecast: e.forecast, previous: e.previous, actual: e.actual } : null,
      bias: e && (e.postAnalysis || e.analysis) ? (e.postAnalysis || e.analysis) : (e ? { bias: 'PENDING', data: 'UNAVAILABLE' } : { bias: 'DATA_UNAVAILABLE', data: 'UNAVAILABLE', reason: 'Aucun événement news saisi' }),
      execution: e ? e.executed : null, tpPoints: cfg().news.tpPoints, slPoints: cfg().news.slPoints
    };
  }
  function riskView() {
    const b = balanceInfo(), d = S.day || {}, ts = clock(), a = activeTrades()[0] || null, fl = ppState(), dd = risk.drawdownState(S.peakEquity, b.equity, cfg().risk.maxDrawdownPct);
    return {
      ok: true, balance: b.balance, equity: b.equity, margin: S.account.margin, freeMargin: S.account.freeMargin, balanceSource: b.source,
      openPL: b.balance !== null && b.equity !== null ? r2(b.equity - b.balance) : null,
      dailyPL: dayNetPts(), dailyLoss: d.lossPts || 0, dailyLossLimit: cfg().normal.dailyLossPoints,
      remainingLossPoints: r2(riskBudgetPts() === null ? cfg().normal.dailyLossPoints + dayNetPts() : riskBudgetPts()), tradesToday: d.trades || 0,
      consecutiveLosses: d.consecLosses || 0, maxConsecutiveLosses: cfg().risk.maxConsecutiveLosses, drawdownPct: dd.pct, maxDrawdownPct: cfg().risk.maxDrawdownPct,
      profitProtection: { locked: !!fl.locked, floor: fl.floor, budget: fl.budget, lotMultiplier: fl.multiplier, unit: fl.unit },
      exposure: a ? { id: a.id, lots: a.lots, riskMoney: a.riskMoney, slPts: a.slPts, tpPts: a.tpPts } : null,
      riskPerTradePct: cfg().riskPerTradePct, maxActiveTrades: cfg().maxActiveTrades, mode: cfg().mode, tradingMode: cfg().tradingMode,
      oprActive: oprState(ts).active, activeTrades: activeTrades().length
    };
  }
  /** Journal de trading de l'utilisateur (un enregistrement par position). */
  function journal(n = 100) {
    return S.trades.slice(-n).map(t => ({
      id: t.id, setupId: t.setupId, leg: t.leg, dateTime: t.ts, user: t.user || userId, ctraderAccount: t.ctraderAccountId || null, symbol: t.symbol,
      mode: t.tradingMode || null, timeframe: t.timeframe || null, direction: t.action, entry: t.entry, openPrice: t.openPrice || null, sl: t.sl, tp: t.tp, exit: t.exitPrice != null ? t.exitPrice : null,
      pnlMoney: t.result && t.result.pnlMoney != null ? t.result.pnlMoney : null, pnlPoints: t.result && t.result.pnlPoints != null ? t.result.pnlPoints : null,
      lots: t.lots, confidence: t.confidence != null ? t.confidence : null, reason: t.reason, smcConditions: t.smcConditions || [], orderFlowConditions: t.orderFlowConditions || [],
      keyZone: t.keyZone || null, newsCondition: t.newsCondition || null, result: t.result ? t.result.outcome || t.result.note || null : null, executionStatus: t.status, executionNote: t.execNote || null
    }));
  }

  const TRADING_MODES = MODE_LIST;
  function setConfig(patch) {
    const before = clone(S.config);
    S.config = merge(S.config, patch || {});
    if (!['NORMAL', 'PROP'].includes(S.config.mode)) S.config.mode = before.mode;
    if (!TRADING_MODES.includes(S.config.tradingMode)) S.config.tradingMode = before.tradingMode;
    S.config.symbolsAllowed = (Array.isArray(S.config.symbolsAllowed) ? S.config.symbolsAllowed : before.symbolsAllowed).map(symOf).filter(s => S.config.symbols[s]);
    if (!S.config.symbolsAllowed.length) S.config.symbolsAllowed = before.symbolsAllowed;
    S.config.autoTrade = !!S.config.autoTrade;
    S.config.combined = false;
    S.ipBook.lastScanT = 0; IPVIEW = { ts: 0, ev: null };
    save();
    log('CONFIG', 'Configuration mise à jour', { kind: 'cfg', patch }, true);
    return S.config;
  }
  function setTradingMode(v) {
    v = String(v || '').toUpperCase();
    if (!TRADING_MODES.includes(v)) return { ok: false, error: 'tradingMode doit être DAYTRADE' };
    S.config.tradingMode = v; save(); log('MODE', 'Mode de trading = ' + v, { kind: 'mode' }, true);
    return { ok: true, tradingMode: v, combined: false, timeframes: modeCfg().timeframes.map(x => 'M' + x) };
  }
  function setCombined() { S.config.combined = false; save(); return { ok: true, combined: false }; }

  function setAutoTrade(on) { S.config.autoTrade = !!on; save(); log('AUTOTRADE', 'Auto Trade = ' + (S.config.autoTrade ? 'ON' : 'OFF'), { kind: 'auto' }, true); return { ok: true, autoTrade: S.config.autoTrade }; }
  function setActive(v) {
    v = String(v || '').toUpperCase();
    if (!['OFF', 'NORMAL', 'PROP'].includes(v)) return { ok: false, error: 'active doit être OFF, NORMAL ou PROP' };
    S.config.active = v; if (v !== 'OFF') S.config.mode = v;
    save(); log('ACTIVE', 'IA Mentor = ' + v, { kind: 'active' }, true);
    return { ok: true, active: v, mode: S.config.mode };
  }
  function setBlock(reason) { S.manualBlock = reason || null; save(); log(reason ? 'BLOCKED' : 'UNBLOCKED', reason || 'Déblocage manuel', { kind: 'blk' }, true); return { ok: true, blocked: S.manualBlock }; }
  /** EMERGENCY STOP : bloque tout, coupe l'Auto Trade, annule les ordres non partis. cTrader ferme les positions via ctrader/execution.js. */
  function emergencyStop(reason) {
    S.manualBlock = 'EMERGENCY STOP' + (reason ? ' : ' + reason : ''); S.config.autoTrade = false;
    let cancelled = 0;
    for (const t of S.trades) { if (t.status === 'PENDING') { t.status = 'CANCELLED'; t.execNote = 'emergency stop'; cancelled++; } else if (t.status === 'LIMIT' && t.orderType === 'LIMIT') { t.cancelReq = 'emergency stop'; cancelled++; } }
    log('EMERGENCY', S.manualBlock, { kind: 'emergency' }, true); save();
    return { ok: true, blocked: S.manualBlock, cancelledPending: cancelled, toClose: activeTrades().filter(t => ['OPEN', 'SENT', 'UNCONFIRMED'].includes(t.status)).map(t => t.id) };
  }

  return {
    tick, submitSignal, status, risk: riskView, setConfig, setActive, setBlock, setNews, newsFeedHeartbeat, setTradingMode, setCombined, setAutoTrade, emergencyStop,
    execNext, execAck, execFail, execPending, execCancelled, cancelNext, cancelLimit, execResult, beTargets, manualClose, updateAccount, setCandles, setExecStatus,
    tradePanel: tradePanelView, plView, getConfig: () => clone(S.config), news: () => newsView(clock()),
    newsEvents: () => S.news.map(e => ({ id: e.id, title: e.title, time: e.time, impact: e.impact, currency: e.currency, category: e.category, forecast: e.forecast, previous: e.previous, actual: e.actual, analysis: e.analysis, executed: e.executed, trades: newsTrades(e).trades, result: newsTrades(e).result })),
    propStatus: () => { rollDay(clock()); return propStatus(); }, logs: (n = 100) => logs.slice(-n), trades: (n = 50) => S.trades.slice(-n), journal,
    activeTrades: () => activeTrades().map(t => Object.assign({}, t)), sessionCloseDue, userId,
    ipEval, setIpStats, ipStats: () => ({ ready: !!IPSTATS.stats, savedAt: IPSTATS.savedAt, meta: IPSTATS.meta }), ipCandles: sym => ipBars(symOf(sym || 'XAUUSD')),
    keyZones: keyZonesView, _internals: { S: () => S, CANDLES }
  };
}

module.exports = { createEngine, DEFAULTS };
