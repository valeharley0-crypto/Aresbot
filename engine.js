'use strict';
/**
 * ARES — IA MENTOR ENGINE (XAUUSD + FOREX) — exécution cTrader uniquement.
 * Un moteur = UN utilisateur (état, config, risque et journal isolés).
 * Logique pure : état, risque, mode DAY TRADE, OPR, NEWS, Profit Protection, journal.
 * Aucune donnée de marché, d'order flow ou de news n'est inventée : donnée absente -> "UNAVAILABLE" -> WAIT/BLOCK.
 * Aucune garantie de profit ni de floor : spread, slippage, gaps et exécution broker peuvent faire dévier les résultats.
 */
const fs = require('fs');
const path = require('path');
const risk = require('./risk');
const analysis = require('./analysis');
const newsCore = require('./news-core');          // NEWS USA importantes seulement (NFP, CPI, FOMC...)
const fundamental = require('./fundamental');   // analyse fondamentale USD (IA Mentor) : plus de Gemini, jamais de NEUTRAL

const FOREX_SYM = { pointSize: 0.00001, contractSize: 100000, maxDevPts: 80 };   // 1 point = 1/10 de pip (5 décimales)
const DEFAULTS = {
  symbol: 'XAUUSD',              // symbole par défaut (news, prix de secours)
  // Symboles connus du moteur. pointSize = 1 « point ». La valeur $/point/lot réelle vient de cTrader (vpl) ; contractSize = secours de calcul.
  // Pour ajouter une paire : une ligne ici + son nom dans symbolsAllowed (aucun autre changement de moteur).
  symbols: {
    XAUUSD: { pointSize: 0.1, contractSize: 100, maxDevPts: 30 },
    EURUSD: FOREX_SYM, GBPUSD: FOREX_SYM, AUDUSD: FOREX_SYM, NZDUSD: FOREX_SYM, EURGBP: FOREX_SYM, USDCHF: FOREX_SYM, USDCAD: FOREX_SYM,
    USDJPY: { pointSize: 0.001, contractSize: 100000, maxDevPts: 80 },
    EURJPY: { pointSize: 0.001, contractSize: 100000, maxDevPts: 80 },
    GBPJPY: { pointSize: 0.001, contractSize: 100000, maxDevPts: 80 }
  },
  symbolsAllowed: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],   // choisis par l'utilisateur
  active: 'OFF',                 // 'OFF' | 'NORMAL' | 'PROP' (règles de compte)
  mode: 'NORMAL',                // 'NORMAL' | 'PROP'
  tradingMode: 'DAYTRADE',       // UN SEUL mode : 'DAYTRADE' (M5/M15, XAUUSD + EURUSD + GBPUSD + USDJPY). Le scalping a été supprimé.
  combined: false,               // inutile : un seul mode (DAY TRADE)
  autoTrade: false,              // Auto Trade ON/OFF : le robot analyse ET envoie les ordres
  liveExecution: true,           // TOUJOURS true : ordres réels envoyés à cTrader (plus de mode PAPER). false uniquement si l'admin coupe l'exécution (GLOBAL_LIVE_ALLOWED=0)
  timezone: 'UTC',
  pointSize: 0.1, contractSize: 100,
  startBalance: null,            // solde de départ si cTrader ne l'a pas encore envoyé
  riskPerTradePct: 0.5,          // % du solde risqué par trade (plafond)
  minLot: 0.01, lotStep: 0.01, maxLot: 5,
  maxActiveTrades: 0,            // setups simultanés (toutes paires confondues) : 0 = ILLIMITÉ. Le risque se règle depuis le site (onglet OBJECTIF)
  signalTTLSec: 60,              // ordre non pris en charge par cTrader après ce délai -> EXPIRED
  maxEntryDeviationPoints: 30,
  priceMaxAgeSec: 15,
  // Session : plus d'entrée après noEntryAfterUTC ; les positions du Mentor sont clôturées à closeAllUTC (jamais gardées la nuit)
  session: { enabled: true, startUTC: '06:00', noEntryAfterUTC: '19:30', closeAllUTC: '20:45' },   // startUTC : début de la fenêtre du robot (Auto Trade)
  // Paramètres par mode. Distances en « points-or » (1 pt-or = 0.10 $ sur l'or ; forex converti à valeur monétaire égale par lot : 10 pts-or = 10 pips).
  modes: {
    // Paramètres du mode DAY TRADE. Distances en « points-or » (1 pt-or = 0.10 $ sur l'or ; forex converti à valeur monétaire égale par lot : 10 pts-or = 10 pips).
    // DAY TRADE : M5 (entrée + structure) + M15 (biais). XAUUSD + EURUSD SEULEMENT. Sessions Londres + New York seulement. TP1 = 1R (+BE) · TP2 = 3R.
    DAYTRADE: { timeframes: [1, 3, 5, 15], tf: { entry: 5, structure: 5, htf: 15 }, symbols: ['XAUUSD'], entry: 'BOS', tp1: 20, tp2: null, tp3: null, tp1R: 1, tp1Frac: 0.5, single: false, three: false, rr: 3, rrMode: 'AUTO', slMax: 10, minSl: 4, minAtr: 4, maxAtr: 90, maxSpread: 6, onePerPair: false, cooldownMin: 0, cooldownAfterLossMin: 0, maxSignalsPerDay: 3, maxSignalsPerWeek: 7, windowsUTC: [['07:00', '11:00'], ['12:30', '16:30']] }
  },
  // ZONES CLÉS (DAY TRADE) : M15 + M5, score /100, entrée sur la 1re zone >= minScore touchée. modes.DAYTRADE.entry = 'ZONES' | 'SMC' | 'BOTH'
  dayZones: {},   // (ancienne stratégie supprimée : clé vide gardée seulement pour les vieilles migrations)
  smc: { slMinPips: 50, slMaxPips: 100, tp1MinPips: 50, tp1MaxPips: 100, tp2MinPips: 200, tp2MaxPips: 250, zoneMaxPips: 120, requireFib: false },   // stratégie SMC : SL 50–100 pips, TP1 50–100, TP2 200–250 (1 pip = 0,10 $)
  dayFilters: { setups: [], pairs: [], sens: [], hours: [], parts: [], factors: [] },   // retraits validés (train/test) : setups, paires, sens BUY/SELL, heures UTC, confirmations
  // SETUPS DU PDF (Turtle Soup, SH+BMS+RTO, SMS+BMS+RTO) : tradés en parallèle des zones clés, le premier setup valide est pris
  analysis: JSON.parse(JSON.stringify(analysis.DEFAULT_ANALYSIS)),   // confluence configurable : poids, minScore, minComponents, orderFlow ON/OFF
  split: { enabled: true },      // plusieurs positions (TP1 / TP2 / TP3) au même prix d'entrée
  // COMPTE MICRO (ex. 5 $) : si le lot minimum dépasse riskPerTradePct, il reste autorisé tant que le risque réel ≤ maxRiskPct % du solde.
  micro: { enabled: true, balanceBelow: 100, maxRiskPct: 25, singleUseTp2: false },   // false : une position unique vise TP1 (plus proche, touché bien plus souvent) ; true visait TP2 = objectif lointain
  normal: { objectivePoints: 20, dailyLossPoints: 30, maxTrades: 0, stopAtObjective: false, minRR: 1 },
  // PROFIT PROTECTION : voir risk.js. target = null -> normal.objectivePoints. Le robot NE S'ARRÊTE PAS à la cible.
  profitProtection: Object.assign(JSON.parse(JSON.stringify(risk.DEFAULT_PROFIT_PROTECTION)), { target: null }),
  risk: { maxConsecutiveLosses: 2, maxDrawdownPct: 40, maxSlippagePts: 5, maxOpenPositions: 30, maxDailyLossMoney: null, closeOnSlippage: false },
  prop: {
    accountSize: null, profitTarget: null, dailyLossLimit: null, maxOverallLoss: null,
    maxTrades: null, maxRiskPerTradeMoney: null, minTradingDays: null, consistencyMaxDayPct: null
  },
  opr: {                         // OPR : stratégie XAUUSD M5 (range d'ouverture + RSI), robot AUTOMATIQUE séparé de l'IA Mentor
    enabled: false, autoTrade: false, pauseMentor: true,   // pendant la fenêtre OPR l'IA Mentor est en PAUSE, l'OPR continue seul
    tz: 'Europe/Paris', symbol: 'XAUUSD',
    oprStart: '02:25', oprEnd: '02:35', greenStart: '02:35', redStart: '04:15',   // heure française
    minPips: 300, maxPips: 1900, rsiLen: 7, rsiOB: 95, rsiOS: 35, slMaxPips: 10000, rr: 2, riskPct: 1, noFriday: true,
    sessions: []                 // fenêtres supplémentaires [{days:[1,2,3,4,5], start:'08:30', end:'09:30'}] (heure du fuseau de config)
  },
  news: {
    enabled: true, autoTrade: false, requireData: true, maxStaleMin: 180,   // requireData : calendrier indisponible/périmé -> WAIT/BLOCK
    relevantCurrencies: ['USD'], impacts: ['high'], coreOnly: true,   // coreOnly : NFP, CPI, PCE, FOMC... seulement
    announceBeforeMin: 120, pauseBeforeMin: 60, analysisBeforeMin: 60, executeBeforeSec: 60, resumeAfterMin: 10,   // T-2h : annonce · T-1h : analyse IA + pause · T-1min : entrée robot
    slPoints: 10, tpPoints: 10, tp2Points: 20,
    perSymbol: { default: { slPoints: 100, tpPoints: 100, tp2Points: 200 }, XAUUSD: { slPoints: 10, tpPoints: 10, tp2Points: 20 } },
    minConfidence: 70, minDeviationPct: 2, riskPerTradePct: 0.5,   // 70 % minimum pour entrer sur une news
    symbols: ['XAUUSD', 'EURUSD']
  }
};


const DAY_SYMS = ['XAUUSD'];   // GOLD MENTOR : l'or (XAUUSD) uniquement — imposé, quelle que soit la configuration enregistrée
  const DAY_SYMS_OLD = ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'];   // le DAY TRADE trade l'or + EURUSD + 2 paires forex très liquides (GBPUSD, USDJPY) — imposé, quelle que soit la configuration enregistrée
const ACTIVE = ['PENDING', 'SENT', 'LIMIT', 'OPEN', 'UNCONFIRMED'];   // LIMIT = ordre limit accepté par cTrader, en attente du prix
const TFS = [1, 3, 5, 15, 30];
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
    if (S.cfgVer !== 5) {   // migration v5 : cTrader uniquement, SCALPING / SWING, Profit Protection
      const c = S.config;
      delete c.dayTrade; delete c.limits; delete c.auto; delete c.bridge;
      if (c.normal) delete c.normal.postObjectiveRiskPoints;
      c.modes = clone(DEFAULTS.modes); c.tradingMode = 'DAYTRADE'; c.session = clone(DEFAULTS.session);
      c.profitProtection = clone(DEFAULTS.profitProtection); c.risk = clone(DEFAULTS.risk); c.analysis = clone(DEFAULTS.analysis);
      c.symbolsAllowed = clone(DEFAULTS.symbolsAllowed); c.autoTrade = false; c.symbols = clone(DEFAULTS.symbols);
      c.news.requireData = DEFAULTS.news.requireData; c.news.maxStaleMin = DEFAULTS.news.maxStaleMin;
      S.cfgVer = 5;
    }
  } catch (e) { /* premier démarrage */ }
  if (S.cfgVer !== 6) {   // migration v6 : SCALPING M1/M3 · DAYTRADE M5/M15 (OR) · plus de PAPER · mode combiné
    const c = S.config;
    c.modes = clone(DEFAULTS.modes);
    if (!MODE_LIST.includes(c.tradingMode)) c.tradingMode = 'DAYTRADE';
    c.liveExecution = true; c.combined = false; delete c.paperMaxMinutes;
    c.maxActiveTrades = Math.max(2, c.maxActiveTrades || 2);
    for (const t of (S.trades || [])) if (t.status === 'PAPER' || t.status === 'PAPER_EXPIRED') { t.status = 'CANCELLED'; t.execNote = 'ancien PAPER supprimé'; }
    S.autoState = { scan: {} };
    S.cfgVer = 6;
  }
  S.cfgVer = 6;
  if (S.newsTimingVer !== 1) {   // migration : annonce 2h · analyse 1h · entrée 1 min · XAUUSD + EURUSD seulement
    const n = S.config.news;
    n.announceBeforeMin = 120; n.pauseBeforeMin = 60; n.analysisBeforeMin = 60; n.executeBeforeSec = 60;
    n.symbols = ['XAUUSD', 'EURUSD'];
    S.newsTimingVer = 1;
  }
  if (S.scoreVer !== 1) {   // migration : score minimum 70 % (SCALPING, DAYTRADE, NEWS) + news core seulement
    S.config.news.minConfidence = 70; S.config.news.coreOnly = true;
    S.config.analysis.minConfidencePct = 70;
    S.scoreVer = 1;
  }
  if (S.slVer !== 2) {   // migration v2 : moins de SL — SL structurel (≥ 0.8 ATR, derrière sweep/OB/swing), filtres qualité, TP plus cohérents, stop après 2 pertes de suite
    const c = S.config, D = DEFAULTS;
    for (const m of ['DAYTRADE']) c.modes[m] = Object.assign({}, c.modes[m], clone(D.modes[m]));
    for (const k of ['requireBreak', 'requireZoneOrSweep', 'htfStrict', 'trigBodyMin', 'trigMaxAtr', 'slAtrMin', 'slBufferAtr']) c.analysis[k] = D.analysis[k];
    c.risk = Object.assign({}, c.risk, { maxConsecutiveLosses: D.risk.maxConsecutiveLosses });
    c.micro = Object.assign({}, c.micro, { singleUseTp2: D.micro.singleUseTp2 });   // compte micro : une seule position -> vise TP1
    S.slVer = 2;
  }
  if (S.multiVer !== 1) {   // migration : scalp réel multi-paires · day trade XAUUSD+EURUSD · 1 setup actif par paire · SCALPING + DAYTRADE ensemble
    const c = S.config;
    c.modes.DAYTRADE = clone(DEFAULTS.modes.DAYTRADE);
    c.combined = true; c.maxActiveTrades = DEFAULTS.maxActiveTrades;
    c.risk = Object.assign({}, c.risk, { maxOpenPositions: DEFAULTS.risk.maxOpenPositions });
    c.normal = Object.assign({}, c.normal, { dailyLossPoints: DEFAULTS.normal.dailyLossPoints });   // avant : 10 pts -> le DAY TRADE (SL min 12) était toujours bloqué par « marge de perte restante »
    S.autoState = { scan: {} };
    S.multiVer = 1;
  }
  if (S.freeVer !== 1) {   // migration : plus de limite « 1 trade par paire » ni de plafond de trades (le risque se règle sur le site) · DAYTRADE = zones clés
    const c = S.config;
    c.maxActiveTrades = 0;
    Object.assign(c.modes.DAYTRADE, { onePerPair: false, cooldownMin: 0, cooldownAfterLossMin: 0, maxSignalsPerDay: 0, entry: 'ZONES' });
    c.dayZones = clone(DEFAULTS.dayZones);
    S.autoState = { scan: {} };
    S.freeVer = 1;
  }
  if (S.freeVer !== 2) {   // migration : SL max DAY TRADE 10 pts · RR 1:2 fixe (TP = 2 × SL) · scalp serré · zones >= 85 de 30 pts max
    const c = S.config;
    Object.assign(c.modes.DAYTRADE, { rr: 2, slMax: 10, minSl: 4, tp1: 20, tp2: null, tp3: null });
    c.dayZones = Object.assign({}, c.dayZones || {}, { minScore: 85, maxWidthPts: 30 });
    S.freeVer = 2;
  }
  if (S.tpRVer !== 1) {   // migration v7 : TP en R (TP1 = 1R + breakeven, TP2 = rr × R) · filtres SMC des zones · sessions Londres/New York · backtest corrigé
    const c = S.config, D = DEFAULTS;
    for (const m of ['DAYTRADE']) {
      const keep = c.modes[m] || {};
      c.modes[m] = Object.assign({}, D.modes[m], { symbols: keep.symbols !== undefined ? keep.symbols : D.modes[m].symbols, maxSignalsPerDay: keep.maxSignalsPerDay || 0, onePerPair: !!keep.onePerPair });
    }
    const dz = c.dayZones || {};
    c.dayZones = Object.assign({}, clone(D.dayZones), dz.minScore ? { minScore: dz.minScore } : {}, dz.maxWidthPts ? { maxWidthPts: dz.maxWidthPts } : {});
    c.normal = Object.assign({}, c.normal, { minRR: 0.9 });   // TP1 = 1R : le contrôle « RR >= 1 » bloquait à cause des arrondis
    S.autoState = { scan: {} }; S.zones = {};
    S.tpRVer = 1;
  }
  if (S.tpRVer !== 2) {   // migration v8 : DAY TRADE = or + EURUSD seulement · TP2 en R remis aux valeurs saines (scalping RR 2 max) · filtre H1
    const c = S.config;
    c.modes.DAYTRADE.symbols = DAY_SYMS.slice();
    c.modes.DAYTRADE.rr = DEFAULTS.modes.DAYTRADE.rr; c.modes.DAYTRADE.tp1R = 1; c.modes.DAYTRADE.tp1Frac = DEFAULTS.modes.DAYTRADE.tp1Frac;
    c.dayZones = Object.assign({}, c.dayZones || {}, { requireH1: true });
    S.autoState = { scan: {} }; S.zones = {};
    S.tpRVer = 2;
  }
  if (S.wadeVer !== 1) {   // migration v9 : DAY TRADE sur 4 paires · RR 2 ou 3 (TP sur la liquidité proche) · setups du PDF · OB avec FVG
    const c = S.config;
    c.modes.DAYTRADE.symbols = DAY_SYMS.slice(); c.modes.DAYTRADE.rrMode = 'AUTO'; c.modes.DAYTRADE.rr = 3; c.modes.DAYTRADE.tp1R = 1;
    c.wade = clone(analysis.WADE);
    c.dayZones = Object.assign({}, c.dayZones || {}, { requireFvg: true });
    c.symbolsAllowed = Array.from(new Set((c.symbolsAllowed || []).concat(DAY_SYMS)));
    S.wade = {}; S.wadeVer = 1;
  }
  if ((S.aresVer || 0) < 1) {   // migration v11 : stratégie unique « ARES SMC » = zones clés + OTE + setups ; TP unique RR 2/3 ; plus de premium/discount ; ordres LIMIT
    const c = S.config;
    c.modes.DAYTRADE.single = true; c.modes.DAYTRADE.rrMode = 'AUTO'; c.modes.DAYTRADE.entry = 'ZONES';
    c.dayZones = Object.assign({}, c.dayZones || {}, { requirePD: false, requireOte: true, oteLo: 0.62, oteHi: 0.79, oteMid: 0.705, clusterAtr: 0.5, limitMaxApproachAtr: 8, limitExpiryBars: 48, minScore: 80 });
    c.normal = Object.assign({}, c.normal, { minRR: 0.9 });
    S.autoState = { scan: {} }; S.zones = {}; S.aresVer = 1;
  }
  if ((S.aresVer || 0) < 2) {   // migration v12 : stratégie STRICTE — ni Turtle Soup ni contre-tendance, OTE = bonus de points, 3 trades/jour et 7/semaine par paire, zone manquée à 15 pts
    const c = S.config;
    c.modes.DAYTRADE.maxSignalsPerDay = 3; c.modes.DAYTRADE.maxSignalsPerWeek = 7;
    c.wade = Object.assign({}, clone(analysis.WADE), { setups: { TS: false, SH_BMS_RTO: true, SMS_BMS_RTO: true }, counterTrend: false });
    c.dayZones = Object.assign({}, c.dayZones || {}, { minScore: 85, requireBias: 'aligned', requireOte: false, maxSpreadSlPct: 0.1, missedPtsEq: 15 });
    S.autoState = { scan: {} }; S.zones = {}; S.aresVer = 2;
  }
  if ((S.aresVer || 0) < 3) {   // migration v13 : zone manquée = 15 $ sur l'or (150 pts-or), 15 pips sur le forex
    const c = S.config;
    c.dayZones = Object.assign({}, c.dayZones || {}, { missedPtsEq: 15, missedPtsEqBySym: { XAUUSD: 150 } });
    S.zones = {}; S.aresVer = 3;
  }
  if ((S.aresVer || 0) < 4) {   // migration v14 : TP1 + BE remis (2 positions : TP1 = WIN, puis BE ; TP2 RR 2/3) + confirmations retirables
    const c = S.config, m = c.modes.DAYTRADE;
    m.single = false; m.tp1R = 1; m.tp1Frac = 0.5; m.rrMode = 'AUTO';
    c.dayFilters = Object.assign({ setups: [], pairs: [], sens: [], hours: [], parts: [], factors: [] }, c.dayFilters || {});
    c.wade = Object.assign({}, c.wade || {}, { ignoreFactors: ['niveau HTF affiné'] });
    S.autoState = { scan: {} }; S.zones = {}; S.aresVer = 4;
  }
  if ((S.aresVer || 0) < 5) {   // migration v15 : SMC tsotra (zones OB) — 3 positions RR 1/2/3, stratégie PDF supprimée, ordres valables 12 h
    const c = S.config, m = c.modes.DAYTRADE;
    m.three = true; m.single = false; m.tp1R = 1; m.rrMode = 'AUTO';
    c.wade = Object.assign({}, c.wade || {}, { enabled: false });
    c.dayZones = Object.assign({}, c.dayZones || {}, { limitExpiryBars: 144, requireFvg: true, minScore: 75, requireBias: 'notAgainst', minRoomR: 1 });
    S.autoState = { scan: {} }; S.zones = {}; S.aresVer = 5;
  }
  if ((S.aresVer || 0) < 6) {   // migration v16 : GOLD MENTOR — or uniquement, modèle sweep → BMS → RTO, TP1 1R (BE) + TP2 = liquidité (RR variable)
    const c = S.config, m = c.modes.DAYTRADE;
    m.entry = 'GOLD'; m.three = false; m.single = false; m.tp1R = 1; m.tp1Frac = 0.5; m.symbols = ['XAUUSD'];
    c.dayZones = Object.assign({}, c.dayZones || {}, { limitExpiryBars: 144, missedPtsEq: 15, missedPtsEqBySym: { XAUUSD: 150 } });
    S.autoState = { scan: {} }; S.zones = {}; S.aresVer = 6;
  }
  if ((S.aresVer || 0) < 7) {   // migration v17 : GOLD MENTOR = SMC « BOS → OB → confirmation LTF » (modules A et B) — l'ancienne stratégie SMC est désactivée
    const c = S.config, m = c.modes.DAYTRADE;
    m.entry = 'BOS'; m.timeframes = [1, 3, 5, 15]; m.symbols = ['XAUUSD']; m.three = false; m.single = false; m.tp1Frac = 0.5; m.maxSignalsPerDay = 3; m.maxSignalsPerWeek = 7;
    c.smc = Object.assign({ ltf: 1 }, c.smc || {});
    S.autoState = { scan: {} }; S.zones = {}; S.smcBook = {}; S.aresVer = 7;
  }
  if ((S.aresVer || 0) < 8) {   // migration v18 : NOUVELLE STRATÉGIE SMC (H1 → M15 → M5) — aucune ancienne logique, aucun ATR, aucun plafond de trades
    const c = S.config, m = c.modes.DAYTRADE;
    m.entry = 'BOS'; m.timeframes = [1, 3, 5, 15]; m.symbols = ['XAUUSD']; m.three = false; m.single = false; m.tp1Frac = 0.5; m.maxSignalsPerDay = 0; m.maxSignalsPerWeek = 0;
    m.slMax = 100; m.minSl = 50; m.tp1 = 50; m.tp2 = 250; m.rr = 3; delete m.minAtr; delete m.maxAtr;
    c.smc = clone(DEFAULTS.smc); delete c.dayZones; delete c.wade;
    S.autoState = { scan: {} }; S.zones = {}; S.wade = {}; S.smcBook = {}; S.aresVer = 8;
  }
  if (S.dayOnlyVer !== 1) {   // migration v10 : SCALPING SUPPRIMÉ — DAY TRADE seul
    const c = S.config;
    if (c.modes) delete c.modes.SCALPING;
    c.tradingMode = 'DAYTRADE'; c.combined = false;
    S.autoState = { scan: {} }; S.dayOnlyVer = 1;
  }
  if (S.slCapVer !== 1) {   // migration : l'ancien plafond SL fixe (28 pts-or = $2.8 sur l'or) bloquait presque tous les trades dès que l'ATR M5 dépassait ~$3.5 → plafond désormais = 3 ATR M5
    const c = S.config;
    if (c.dayZones && c.dayZones.slCapEq === 28) c.dayZones.slCapEq = 0;
    if (c.wade && c.wade.slCapEq === 28) c.wade.slCapEq = 0;
    S.slCapVer = 1;
  }
  if (S.noPropVer !== 1) {   // migration : Prop Firm supprimé — IA Mentor = NORMAL ou OFF seulement
    const c = S.config;
    c.mode = 'NORMAL'; if (c.active === 'PROP') c.active = 'NORMAL';
    S.noPropVer = 1;
  }
  if (!S.zones) S.zones = {};
  if (!S.wade) S.wade = {};
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
  const modesRunning = () => (cfg().combined ? MODE_LIST.slice() : [cfg().tradingMode]);   // modes actifs (combiné = les deux)
  const modeAllowsSym = (mode, sym) => { if (mode === 'DAYTRADE' && !DAY_SYMS.includes(sym)) return false; const m = modeCfg(mode); return !m.symbols || m.symbols.includes(sym); };
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
      if (last && last.t === t0) { last.h = Math.max(last.h, px); last.l = Math.min(last.l, px); last.c = px; }
      else if (!last || t0 > last.t) { arr.push({ t: t0, o: px, h: px, l: px, c: px }); if (arr.length > 700) arr.shift(); }
    }
  }
  /** Historique RÉEL (trendbars cTrader) : bars = [{t(ms), o, h, l, c}] triées. Remplace l'historique, conserve les bougies live plus récentes. */
  function setCandles(sym, tf, bars) {
    const k = symOf(sym); if (!TFS.includes(tf) || !Array.isArray(bars) || !bars.length) return { ok: false };
    const m = (CANDLES[k] = CANDLES[k] || {}), live = (m[tf] || []), lastSeed = bars[bars.length - 1].t;
    m[tf] = bars.filter(b => b && Number.isFinite(b.t) && b.o > 0).concat(live.filter(b => b.t > lastSeed)).slice(-700);
    return { ok: true, count: m[tf].length };
  }
  const candleCounts = () => { const o = {}; for (const k of Object.keys(CANDLES)) o[k] = Object.fromEntries(TFS.map(tf => [`M${tf}`, (CANDLES[k][tf] || []).length])); return o; };

  // ---------- OPR ----------
  function oprWindow(ts) {   // fenêtre de la stratégie OPR (heure française) : Mentor en pause, OPR actif
    const O = cfg().opr;
    if (!O || !O.enabled || !O.pauseMentor) return false;
    const lp = localParts(ts, O.tz), st = hhmm(O.oprStart), en = hhmm(O.redStart);
    if (st === null || en === null) return false;
    if (O.noFriday && lp.dow === 5) return false;
    if (lp.dow === 0 || lp.dow === 6) return false;
    return st <= en ? (lp.minutes >= st && lp.minutes < en) : (lp.minutes >= st || lp.minutes < en);
  }
  function oprState(ts) {
    if (oprWindow(ts)) return { active: true, session: { start: cfg().opr.oprStart, end: cfg().opr.redStart, tz: cfg().opr.tz } };
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
      for (let n = tps.length; n >= 2 && !legs; n--) {
        const hl = +(Math.floor(sz.lots / n / ll.lotStep + 1e-9) * ll.lotStep).toFixed(8);
        if (hl >= ll.minLot - 1e-12) legs = tps.slice(0, n).map(x => ({ lots: hl, tp: x.tp, tpPts: r2(Math.abs(x.tp - entry) / sp.pointSize), riskMoney: r2(hl * sz.perLot), tag: x.tag }));
      }
    }
    if (!legs && tp2 !== null && c.micro && c.micro.singleUseTp2) { tp = tp2; tpPts = r2(Math.abs(tp2 - entry) / sp.pointSize); }   // 1 seule position : elle vise l'objectif complet
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
      if (p.limit) { t.orderType = 'LIMIT'; t.limitExpiryTs = ts + (p.expiryMin ? p.expiryMin * 60000 : (p.expiryBars || 48) * 5 * 60000); t.execNote = 'ordre limit en attente d\'envoi à cTrader'; }
      if (p.smcModule) { t.smcModule = p.smcModule; t.smcKey = p.smcKey; t.strategy = 'ARES SMC'; t.setupName = 'H1 → M15 → M5'; t.rrTotal = p.rrTotal; }
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

  // ---------- ANALYSE IA : SCALPING / SWING (SMC + structure + order flow si réellement disponible) ----------
  const orderFlowFor = sym => {
    try { return opts.orderFlow && typeof opts.orderFlow.get === 'function' ? (opts.orderFlow.get(sym) || { status: 'UNAVAILABLE' }) : { status: 'UNAVAILABLE' }; }
    catch (e) { return { status: 'UNAVAILABLE', error: String(e && e.message || e) }; }
  };
  /** Contexte d'analyse d'une paire pour un mode (bougies FERMÉES, prix live, limites du mode). */
  /** TP en R du mode (null = ancien mode TP fixe) : { tp1R, tp2R, frac }. */
  const rrModeOf = m => { const v = String((m && m.rrMode) || 'AUTO').toUpperCase(); return ['AUTO', 'FIXED2', 'FIXED3'].includes(v) ? v : 'AUTO'; };
  /** TP en R : TP1 = tp1R (clôture partielle + BE auto), TP2 = RR FIXE 2 ou 3 (AUTO = selon la liquidité proche non touchée ; FIXED2 / FIXED3 = imposé). rr:0 = TP unique (laboratoire). */
  const rTOf = (m, mode) => {
    if (m && m.three) return { tp1R: +m.tp1R || 1, tp2R: 2, tp3R: 3, frac: 1 / 3, mode: rrModeOf(m), three: true };   // SMC : TP1 RR1 · TP2 RR2 · TP3 RR3 (3 positions)
    if (m && m.single) return { tp1R: 2, tp2R: null, frac: 1, mode: rrModeOf(m), single: true };   // ARES SMC : TP UNIQUE RR 2 ou 3, sans TP1 partiel ni breakeven
    if (!(m && m.tp1R > 0)) return null;
    const rm = rrModeOf(m);
    const two = m.rr !== 0 && !(m.rr > 0 && m.rr <= m.tp1R);
    return { tp1R: +m.tp1R, tp2R: two ? (rm === 'FIXED2' ? 2 : 3) : null, frac: m.tp1Frac > 0 && m.tp1Frac < 1 ? +m.tp1Frac : 0.5, mode: rm };
  };

  // ---------- DAY TRADE : stratégie SMC unique (H1 → M15 → M5) ----------
  const dayFilters = () => Object.assign({ setups: [], pairs: [], sens: [], hours: [], parts: [], factors: [] }, cfg().dayFilters || {});
  const isExcluded = (F, sym, action, setupKey, ts) => (F.pairs || []).includes(sym) || (F.sens || []).includes(action) || (F.setups || []).includes(setupKey) || (F.hours || []).includes(new Date(ts).getUTCHours());
  const ZC = {};   // cache des zones par paire (recalculées à chaque nouvelle bougie fermée M5/M15)
  // ---------- BACKTEST sur données historiques (trendbars cTrader) : mêmes fonctions d'analyse que le robot en direct ----------
  const BT_SPREAD = { XAUUSD: 2.5, EURUSD: 0.5, GBPUSD: 0.8, USDJPY: 0.6 };   // spread par défaut du backtest (pts-or, 1 pt-or = 0.1 $ d'or = 1 pip forex) : réaliste par paire, modifiable depuis le site
  const BT_LIM = 600;   // bougies fermées passées à l'analyse (comme en direct)
  /** Résumé court d'une variante du laboratoire + découpage « apprentissage / test » (dernier tiers de la période) contre le sur-ajustement. */
  function btCompact(trades) {
    const sorted = trades.slice().sort((a, b) => a.t - b.t), n = sorted.length, cut = n ? sorted[0].t + (sorted[n - 1].t - sorted[0].t) * (2 / 3) : 0;
    const one = a => { const S = btSummary(a); return { trades: S.trades, winRate: S.winRate, netR: S.netR, expectancyR: S.expectancyR, profitFactor: S.profitFactor, maxDrawdownR: S.maxDrawdownR }; };
    return Object.assign(one(sorted), { train: one(sorted.filter(t => t.t <= cut)), test: one(sorted.filter(t => t.t > cut)) });
  }
  /** Apprentissage / test : le DERNIER TIERS de la période (ex. 2 mois sur 6) est le test, jugé séparément (contre le sur-ajustement). */
  function btSplit(trades, from, to) { const cut = from + (to - from) * (2 / 3), A = trades.filter(t => t.t <= cut), B = trades.filter(t => t.t > cut); return { cut, train: btSummary(A, { from, to: cut }), test: btSummary(B, { from: cut, to }) }; }
  /** Analyse d'élimination : chaque setup / paire / sens / heure / confirmation est jugé séparément sur l'apprentissage ET sur le test. RETIRER seulement si mauvais dans les DEUX (>= 12 trades chacun). */
  function btSegments(trades, cut) {
    const MIN = 12, tr = trades.filter(t => t.t <= cut), te = trades.filter(t => t.t > cut);
    const st = a => { const n = a.length, w = a.filter(isWin).length, net = a.reduce((s, t) => s + t.R, 0); return { n, wr: n ? Math.round(w / n * 1000) / 10 : null, netR: Math.round(net * 100) / 100 }; };
    const rows = [], push = (dim, key, label, fa, fb) => {
      const A = st(tr.filter(fa)), B = st(te.filter(fa)), bothN = A.n >= MIN && B.n >= MIN;
      let verdict = 'neutre';
      if (fb) {   // confirmation : avec vs sans
        const A0 = st(tr.filter(fb)), B0 = st(te.filter(fb));
        if (bothN && A0.n >= MIN && B0.n >= MIN) verdict = (A.wr < A0.wr && B.wr < B0.wr) ? 'RETIRER' : (A.wr > A0.wr && B.wr > B0.wr) ? 'GARDER' : 'neutre'; else verdict = 'trop peu de trades';
        rows.push({ dim, key, label, train: A, test: B, without: { train: A0, test: B0 }, verdict });
        return;
      }
      if (bothN) verdict = (A.wr < 45 && B.wr < 45 && A.netR < 0 && B.netR < 0) ? 'RETIRER' : (A.wr >= 50 && B.wr >= 50) ? 'GARDER' : 'neutre'; else verdict = 'trop peu de trades';
      rows.push({ dim, key, label, train: A, test: B, verdict });
    };
    const uniq = f => Array.from(new Set(trades.map(f)));
    uniq(t => t.setup).forEach(k => push('setup', k, k, t => t.setup === k));
    uniq(t => t.symbol).forEach(k => push('pair', k, k, t => t.symbol === k));
    ['BUY', 'SELL'].forEach(k => push('sens', k, k, t => t.action === k));
    uniq(t => new Date(t.t).getUTCHours()).sort((a, b) => a - b).forEach(h => push('hour', h, h + 'h UTC', t => new Date(t.t).getUTCHours() === h));
    const comps = new Set(); trades.forEach(t => Object.keys(t.comp || {}).forEach(k => comps.add(k)));
    comps.forEach(k => { const fam = k.slice(0, 2), inFam = t => (t.comp || {}) && Object.keys(t.comp || {}).some(x => x.startsWith(fam)); push(k.startsWith('Z:') ? 'part' : 'factor', k.slice(2), (k.startsWith('Z:') ? 'zone · ' : 'setup · ') + k.slice(2), t => inFam(t) && (t.comp || {})[k] === true, t => inFam(t) && (t.comp || {})[k] !== true); });
    return rows;
  }
  /** Un trade est GAGNANT dès que TP1 est touché (même si le reste revient au breakeven) ; sinon R net > 0. */
  const isWin = t => (t.win != null ? !!t.win : t.R > 0);
  function btSummary(trades, period) { const S0 = btSummary0(trades, period); const wk = S0.weekly || [], full = wk.length || 1; S0.avgPerWeek = Math.round(S0.trades / full * 10) / 10; S0.weeksUnder4 = wk.filter(w => w.trades < 4).length; S0.weeksCount = wk.length; delete S0.bySetup2; return S0; }
  function btSummary0(trades, period) {
    const n = trades.length, wins = trades.filter(isWin).length, losses = n - wins;
    const sum = a => a.reduce((x, y) => x + y, 0), avg = a => (a.length ? sum(a) / a.length : 0);
    const grossW = sum(trades.filter(t => t.R > 0).map(t => t.R)), grossL = Math.abs(sum(trades.filter(t => t.R <= 0).map(t => t.R)));
    let cum = 0, peak = 0, dd = 0;
    const curve = trades.map(t => { cum += t.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); return Math.round(cum * 100) / 100; });
    const step = Math.max(1, Math.ceil(curve.length / 120));
    const by = {}, mo = {}, bs = {};
    trades.forEach(t => {
      const o = (by[t.symbol] = by[t.symbol] || { symbol: t.symbol, trades: 0, wins: 0, losses: 0, be: 0, tp2: 0, netR: 0 }); o.trades++; if (isWin(t)) o.wins++; else o.losses++; if (t.tp2Hit) o.tp2++; if (t.tp1Hit && !t.tp2Hit && String(t.result).indexOf('BE') >= 0) o.be++; o.netR = Math.round((o.netR + t.R) * 100) / 100;
      const sk = (t.setup || 'ZONE') + (t.counter ? ' (contre-tendance)' : ''), st2 = (bs[sk] = bs[sk] || { setup: sk, trades: 0, wins: 0, netR: 0 }); st2.trades++; if (isWin(t)) st2.wins++; st2.netR = Math.round((st2.netR + t.R) * 100) / 100;
      const k = new Date(t.t).toISOString().slice(0, 7), q = (mo[k] = mo[k] || { month: k, trades: 0, wins: 0, netR: 0 }); q.trades++; if (isWin(t)) q.wins++; q.netR = Math.round((q.netR + t.R) * 100) / 100;
    });
    const withTp2 = trades.filter(t => t.tp2Eq != null);
    return {
      trades: n, wins, losses, winRate: n ? Math.round(wins / n * 1000) / 10 : null,
      netR: Math.round(sum(trades.map(t => t.R)) * 100) / 100,
      expectancyR: n ? Math.round(avg(trades.map(t => t.R)) * 100) / 100 : null,
      profitFactor: grossL > 0 ? Math.round(grossW / grossL * 100) / 100 : (grossW > 0 ? null : 0),
      avgRR: n ? Math.round(avg(trades.map(t => t.rr)) * 100) / 100 : null,
      avgSl: n ? Math.round(avg(trades.map(t => t.slEq)) * 100) / 100 : null,
      avgTp1: n ? Math.round(avg(trades.map(t => t.tp1Eq)) * 100) / 100 : null,
      avgTp2: (() => { const a = trades.filter(t => t.tp2Eq != null).map(t => t.tp2Eq); return a.length ? Math.round(avg(a) * 100) / 100 : null; })(),
      tp2Rate: n ? Math.round(trades.filter(t => t.tp2Hit).length / n * 1000) / 10 : null,      // % de trades qui ont atteint TP2 (objectif complet)
      beRate: n ? Math.round(trades.filter(t => t.tp1Hit && !t.tp2Hit && t.result.indexOf('BE') >= 0).length / n * 1000) / 10 : null,   // % TP1 touché puis retour au breakeven
      maxDrawdownR: Math.round(dd * 100) / 100,
      curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
      byHour: (() => { const h = {}; trades.forEach(t => { const k = String(new Date(t.t).getUTCHours()).padStart(2, '0'); const o = (h[k] = h[k] || { hour: k, trades: 0, wins: 0, netR: 0 }); o.trades++; if (isWin(t)) o.wins++; o.netR = Math.round((o.netR + t.R) * 100) / 100; }); return Object.values(h).sort((a, b) => (a.hour < b.hour ? -1 : 1)); })(),
      byDir: ['BUY', 'SELL'].map(d => { const a = trades.filter(t => t.action === d); return { dir: d, trades: a.length, wins: a.filter(isWin).length, netR: Math.round(sum(a.map(t => t.R)) * 100) / 100 }; }),
      outcomes: (() => { const o = { tp3all: 0, tp2: 0, tp1be: 0, sl: 0, time: 0, tp: 0 }; trades.forEach(t => { const w = String(t.result || '').split('+'), n = w.filter(x => x === 'TP').length; if (w.length === 1 && w[0] === 'SL') o.sl++; else if (w.length === 1 && w[0] === 'TP') o.tp++; else if (n === w.length && n >= 2) o.tp3all++; else if (n >= 2) o.tp2++; else if (n === 1 && w.every(x => x === 'TP' || x === 'BE')) o.tp1be++; else if (w.includes('TIME')) o.time++; else o.sl++; }); return o; })(),
      bySymbol: Object.values(by).map(o => Object.assign(o, { winRate: o.trades ? Math.round(o.wins / o.trades * 1000) / 10 : null, netR: Math.round(o.netR * 100) / 100, expectancyR: o.trades ? Math.round(o.netR / o.trades * 100) / 100 : null })), bySetup: Object.values(bs),
      weekly: (() => {   // trades par semaine (lundi UTC) : 0 compté pour les semaines vides de la période
        const W = {}, wk = t => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
        if (period && period.from && period.to) for (let t = period.from; t < period.to; t += 7 * 86400000) W[wk(t)] = W[wk(t)] || { week: wk(t), trades: 0, wins: 0, netR: 0 };
        trades.forEach(t => { const k = wk(t.t), o = (W[k] = W[k] || { week: k, trades: 0, wins: 0, netR: 0 }); o.trades++; if (isWin(t)) o.wins++; o.netR = Math.round((o.netR + t.R) * 100) / 100; });
        return Object.values(W).sort((a, b) => (a.week < b.week ? -1 : 1));
      })(),
      bySetup2: undefined, byMonth: Object.values(mo).sort((a, b) => (a.month < b.month ? -1 : 1)), partialLegs: withTp2.length
    };
  }

  function scanReady(ts) {   // garde commune aux scans automatiques
    const c = cfg();
    if (!c.autoTrade || c.active === 'OFF') return false;
    if (c.session && c.session.enabled && (hhmmUTC() >= c.session.noEntryAfterUTC || hhmmUTC() < c.session.startUTC)) return false;
    const state = computeState(ts);
    const idle = state.status === 'WAIT' && ['MENTOR_ACTIVE', 'PROFIT_LOCKED'].includes(state.sub);
    return idle || state.status === 'MANAGING';   // MANAGING = d'autres trades sont ouverts : on continue de scanner
  }
  /** Limites optionnelles PAR PAIRE (toutes désactivées par défaut : 0 / false). Retourne la raison ou null. */
  function pairLimited(mode, sym, ts) {
    const m = modeCfg(mode), st = S.autoState, key = `${sym}:${mode}`; st.last = st.last || {}; st.lossBy = st.lossBy || {};
    if (m.onePerPair && activeTrades().some(t => t.symbol === sym && t.mode !== 'NEWS')) return '1 trade actif par paire (option)';
    if (m.maxSignalsPerDay > 0 && modeTradesToday(mode, sym) >= m.maxSignalsPerDay) return `plafond ${m.maxSignalsPerDay} trades/jour/paire`;
    if (m.maxSignalsPerWeek > 0 && modeTradesWeek(mode, sym, ts) >= m.maxSignalsPerWeek) return `plafond ${m.maxSignalsPerWeek} trades/semaine/paire`;
    if (m.cooldownMin > 0 && st.last[key] && ts - st.last[key] < m.cooldownMin * 60000) return 'cooldown';
    if (m.cooldownAfterLossMin > 0 && st.lossBy[key] && ts - st.lossBy[key] < m.cooldownAfterLossMin * 60000) return 'cooldown après perte';
    return null;
  }
  // =====================================================================================================================
  // GOLD MENTOR — NOUVELLE STRATÉGIE SMC (remplace toutes les anciennes) :
  //   H1 contexte / liquidités → M30·M15 OB + CHOCH/BOS (dernier BOS confirmé) → Fibonacci (confluence) → M5 confirmation → ENTRY.
  //   SL 50–100 pips · TP1 50–100 pips · TP2 200–250 pips · BE sur le reste après TP1 · London + New York · aucun ATR.
  // =====================================================================================================================
  const bosOn = () => (modeCfg('DAYTRADE').entry || 'BOS') === 'BOS';
  const smcCfg = () => {
    const u = cfg().smc || {}, o = Object.assign({}, analysis.SMC), pip = (k, d) => { if (u[k] != null && isFinite(u[k])) o[d] = u[k] / 10; };   // 1 pip = 0,10 $
    pip('slMinPips', 'slMinUsd'); pip('slMaxPips', 'slMaxUsd'); pip('tp1MinPips', 'tp1MinUsd'); pip('tp1MaxPips', 'tp1MaxUsd'); pip('tp2MinPips', 'tp2MinUsd'); pip('tp2MaxPips', 'tp2MaxUsd'); pip('zoneMaxPips', 'zoneMaxUsd');
    if (typeof u.requireFib === 'boolean') o.requireFib = u.requireFib;
    return o;
  };
  const SMCCACHE = {};
  const smcBk = () => { S.smcBook = S.smcBook || {}; return (S.smcBook.S = S.smcBook.S || { used: {}, cool: {}, scanT: 0 }); };
  /** Contexte LIVE (bougies FERMÉES seulement). */
  function smcCtx(sym) {
    const cf = smcCfg(), price = freshPrice(sym);
    if (!specOf(sym)) return { wait: 'symbole non supporté' };
    if (!price) return { wait: 'prix indisponible (cTrader)' };
    const closed = n => ((CANDLES[sym] || {})[n] || []).slice(0, -1);
    const m15 = closed(15).slice(-760), m5 = closed(5).slice(-260), last = m5[m5.length - 1];
    if (m15.length < 80 || m5.length < 40) return { wait: `bougies insuffisantes (M15 ${m15.length} · M5 ${m5.length})` };
    if (last && clock() - last.t > 3 * 5 * 60000 + 120000) return { wait: 'bougies M5 périmées (flux de prix interrompu)' };
    return { ctx: { symbol: sym, m15, m5, price, now: clock(), cfg: cf, cache: SMCCACHE } };
  }
  /** Scan temps réel : à chaque bougie M5 fermée, un setup CONFIRMÉ (confirmation M5 faite) = entrée au marché cTrader (TP1 + TP2, BE après TP1). */
  async function smcScan(ts) {
    if (!bosOn() || !modesRunning().includes('DAYTRADE') || !scanReady(ts)) return;
    const c = cfg(), m = modeCfg('DAYTRADE');
    if (m.windowsUTC && !m.windowsUTC.some(w => hhmmUTC() >= w[0] && hhmmUTC() < w[1])) return;   // London + New York seulement
    for (const sym of DAY_SYMS.filter(x => (c.symbolsAllowed || []).includes(x) && modeAllowsSym('DAYTRADE', x))) {
      const b = smcCtx(sym); if (b.wait) continue;
      const bk = smcBk(), lastT = b.ctx.m5[b.ctx.m5.length - 1].t;
      if (bk.scanT === lastT) continue; bk.scanT = lastT;   // une seule analyse par bougie M5 fermée
      const E = analysis.smcEval(b.ctx);
      for (const s of E.setups) {
        if (s.state !== 'CONFIRMED') continue;
        const key = `S:${s.dir}:${s.confirm.t}`;
        if (bk.used[s.id] || bk.used[key] || (bk.cool[key] || 0) > ts || S.trades.some(t => t.smcKey === key && ACTIVE.includes(t.status))) continue;
        if (pairLimited('DAYTRADE', sym, ts)) break;
        const tg = s.tags || {};
        const out = await submitSignal({ symbol: sym, tradingMode: 'DAYTRADE', action: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: null,
          reason: `SMC ${s.dir} · OB ${s.zone.tf} ${r2(s.zone.lo)}-${r2(s.zone.hi)} · BOS M15 ${r2(s.zone.bosLevel)} · liquidité ${(tg.liq || []).join('+') || '—'}${tg.fib ? ' · Fibo ✓' : ''} · confirmation M5 · entrée ${r2(s.entry)} · SL ${r2(s.risk * 10)} pips · RR total ${r2(s.rrTotal)}`,
          limit: false, rrTotal: r2(s.rrTotal), smcModule: 'S', smcKey: key,
          analysis: { components: [], confidence: 100, score: 100, maxScore: 100, zone: { id: s.id, module: 'S', tf: s.zone.tf, lo: s.zone.lo, hi: s.zone.hi } } }, 'NORMAL');
        if (out.ok && out.decision === 'TRADE') {
          bk.used[s.id] = ts; bk.used[key] = ts;
          log('SMC', `${sym} ${s.dir} MARKET ${r2(s.entry)} · SL ${r2(s.risk * 10)} pips · TP1 ${r2(s.tp1)} · TP2 ${r2(s.tp2)} · RR total ${r2(s.rrTotal)}`, { kind: 'smc', zone: s.id }, true);
          save(); break;
        }
        bk.cool[key] = ts + 5 * 60000; save();   // bloqué (risque / limites) : nouvel essai dans 5 min
      }
    }
  }
  /** BACKTEST sur l'historique réel (M15 + M5) : mêmes règles que le live. Entrée au marché à la clôture de la confirmation M5. Retourne { trades }. */
  async function backtestSmc(sym, bars, opts) {
    opts = opts || {};
    sym = symOf(sym);
    const sp = specOf(sym);
    if (!sp) return { error: 'symbole non supporté : ' + sym, trades: [] };
    if (!DAY_SYMS.includes(sym)) return { error: 'Gold Mentor : seulement ' + DAY_SYMS.join(', '), trades: [] };
    const c = cfg(), m = modeCfg('DAYTRADE'), cf = Object.assign({}, smcCfg(), opts.cfg || {});
    for (const n of [15, 5]) if (!bars[n] || bars[n].length < 120) return { error: `historique M${n} insuffisant pour ${sym} (${(bars[n] || []).length} bougies)`, trades: [] };
    const M15 = bars[15], M5 = bars[5], eqF = eqFactor(sym), pt = sp.pointSize, dist = g => g / eqF * pt, toEq = x => x / pt * eqF;
    const spreadEq = opts.spreadEq != null && isFinite(opts.spreadEq) ? Math.max(0, +opts.spreadEq) : (BT_SPREAD[sym] != null ? BT_SPREAD[sym] : 0.5), spreadPx = dist(spreadEq);
    const from = opts.from || 0, to = opts.to || Infinity, cache = {}, used = {}, perDay = {}, perWeek = {}, out = [];
    const dayOf = ts => new Date(ts).toISOString().slice(0, 10), wkOf = ts => new Date(weekStartUTC(ts)).toISOString().slice(0, 10);
    const hhmm = ts => { const d = new Date(ts); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };
    const inSession = ts => { const h = hhmm(ts); if (c.session && c.session.enabled && (h >= c.session.noEntryAfterUTC || h < c.session.startUTC)) return false; return !m.windowsUTC || m.windowsUTC.some(w => h >= w[0] && h < w[1]); };
    const ms5 = 5 * 60000, maxHold = Math.ceil(24 * 60 * 60000 / ms5), funnel = opts.funnel;
    let ph = 0, openUntil = -1, lastYield = Date.now();
    for (let j = 0; j < M5.length - 1; j++) {
      const ts = M5[j].t + ms5;
      if ((j & 63) === 0 && Date.now() - lastYield > 40) { lastYield = Date.now(); if (opts.onProgress) opts.onProgress(j / M5.length); await new Promise(r => setImmediate(r)); }
      if (ts < from) continue;
      if (ts > to) break;
      if (j <= openUntil) continue;
      const dw = new Date(ts).getUTCDay(); if (dw === 0 || dw === 6) continue;
      if (!inSession(ts)) continue;   // London + New York seulement
      if (m.maxSignalsPerDay > 0 && (perDay[dayOf(ts)] || 0) >= m.maxSignalsPerDay) continue;
      if (m.maxSignalsPerWeek > 0 && (perWeek[wkOf(ts)] || 0) >= m.maxSignalsPerWeek) continue;
      while (ph < M15.length && M15[ph].t + 15 * 60000 <= ts) ph++;
      if (ph < 90) continue;
      let E;
      try { E = analysis.smcEval({ m15: M15.slice(Math.max(0, ph - 760), ph), m5: M5.slice(Math.max(0, j + 1 - 260), j + 1), price: { mid: M5[j].c }, now: ts, cfg: cf, cache }); }
      catch (err) { if (opts.errs) { opts.errs.count++; if (!opts.errs.first) opts.errs.first = String(err && err.stack || err).slice(0, 400); } continue; }
      if (funnel) E.setups.forEach(s => { funnel.seen.add(s.id); if (s.state === 'TOUCHED' || s.state === 'CONFIRMED') funnel.touched.add(s.id); if (s.state === 'CONFIRMED') funnel.confirmed.add(s.id); if (s.dead) { const k = String(s.wait).replace(/[0-9.]+/g, '#').slice(0, 70); if (!funnel.deadSeen.has(s.id)) { funnel.deadSeen.add(s.id); funnel.dead[k] = (funnel.dead[k] || 0) + 1; } } });
      const s = E.setups.find(x => x.state === 'CONFIRMED' && !used[x.id] && !used[`S:${x.dir}:${x.confirm.t}`]);
      if (!s) continue;
      const key = `S:${s.dir}:${s.confirm.t}`, dir = s.dir === 'BUY' ? 1 : -1, entry = s.entry, risk = Math.abs(entry - s.sl);
      used[s.id] = true; used[key] = true;
      if (!(risk > 0)) continue;
      if (funnel) funnel.filled++;
      const tps = [s.tp1].concat(s.tp2 != null ? [s.tp2] : []), legs = tps.map(tp => ({ tp, w: tps.length === 1 ? 1 : 0.5, done: false, R: 0, why: '' }));
      let slLvl = s.sl, be = false, endIdx = j, endT = ts, mfe = 0;
      for (let q = j + 1; q < M5.length && q <= j + maxHold; q++) {
        const b = M5[q]; endIdx = q; endT = b.t + ms5;
        mfe = Math.max(mfe, ((dir > 0 ? b.h - entry : entry - b.l) / risk));
        const slHit = dir > 0 ? b.l <= slLvl : b.h >= slLvl;
        if (slHit) { legs.forEach(g => { if (!g.done) { g.done = true; g.R = be ? 0 : -1; g.why = be ? 'BE' : 'SL'; } }); break; }   // SL testé AVANT les TP de la même bougie = pessimiste
        legs.forEach(g => { if (!g.done && (dir > 0 ? b.h >= g.tp : b.l <= g.tp)) { g.done = true; g.R = Math.abs(g.tp - entry) / risk; g.why = 'TP'; } });
        if (!be && legs.length > 1 && legs[0].done && legs[0].why === 'TP' && !legs.every(g => g.done)) { be = true; slLvl = entry; }   // TP1 atteint -> SL du reste à BE
        if (legs.every(g => g.done)) break;
      }
      legs.forEach(g => { if (!g.done) { g.done = true; g.R = (M5[Math.min(endIdx, M5.length - 1)].c - entry) * dir / risk; g.why = 'TIME'; } });
      const Rnet = legs.reduce((a, g) => a + g.w * g.R, 0) - spreadPx / risk, whys = legs.map(g => g.why), tp1Hit = legs[0].why === 'TP';
      const tg = s.tags || {};
      out.push({
        t: ts, placedT: ts, exit: endT, module: 'S', symbol: sym, action: s.dir, entry: +entry.toFixed(3), sl: +s.sl.toFixed(3), tp1: +s.tp1.toFixed(3), tp2: s.tp2 != null ? +s.tp2.toFixed(3) : null,
        slEq: Math.round(toEq(risk) * 100) / 100, slUsd: Math.round(risk * 100) / 100, rr: Math.round(s.rrFinal * 100) / 100, rrTot: Math.round(s.rrTotal * 100) / 100,
        R: Math.round(Rnet * 100) / 100, win: tp1Hit, tp1Hit, tp2Hit: tps.length > 1 && legs[1].why === 'TP', single: tps.length === 1,
        result: whys.every(x => x === whys[0]) && whys[0] !== 'TP' ? whys[0] : whys.join('+'), mfe: Math.round(mfe * 100) / 100, setup: 'SMC', limit: false, counter: !!tg.counter, fib: !!tg.fib, liq: (tg.liq || []).join('+')
      });
      perDay[dayOf(ts)] = (perDay[dayOf(ts)] || 0) + 1; perWeek[wkOf(ts)] = (perWeek[wkOf(ts)] || 0) + 1; openUntil = endIdx;
    }
    return { trades: out };
  }
  /** Panel « Trade » : zone clé → touchée → confirmation M5 → trade actif → TP1 → BE → TP2 ; + résultats. */
  function smcPanelView() {
    const ts = clock(), cf = smcCfg(), sym = 'XAUUSD', price = freshPrice(sym);
    const rrLeg = t => (Math.abs(t.entry - t.sl) > 0 ? Math.abs(t.tp - t.entry) / Math.abs(t.entry - t.sl) : null);
    const rrTotOf = t => { const g = S.trades.filter(x => (x.setupId || x.id) === (t.setupId || t.id)); let L = 0, W = 0; g.forEach(x => { const r = rrLeg(x); if (r != null) { L += (x.lots || 1) * r; W += (x.lots || 1); } }); return W ? r2(L / W) : null; };
    const shape = t => ({ id: t.id, ts: t.ts, action: t.action, leg: t.leg || null, entry: t.entry, sl: t.sl, tp: t.tp, lots: t.lots, riskMoney: t.riskMoney, status: t.status, openPrice: t.openPrice != null ? t.openPrice : null,
      rr: rrLeg(t) != null ? r2(rrLeg(t)) : null, rrTotal: rrTotOf(t), expiresAt: t.limitExpiryTs || null, touched: !!t.touchedAt, cancelReq: t.cancelReq || null, note: t.execNote || null });
    const out = { ok: true, symbol: sym, price: price ? price.mid : null, ltf: 'M5', modules: {}, ts: new Date(ts).toISOString() };
    const mine = S.trades.filter(t => t.smcModule === 'S' && t.mode !== 'OPR' && t.mode !== 'NEWS');
    const groups = {}; mine.filter(t => t.status === 'CLOSED' && t.result).forEach(t => { (groups[t.setupId || t.id] = groups[t.setupId || t.id] || []).push(t); });
    const sets = Object.values(groups).map(g => { const first = g.find(x => x.leg === 'TP1') || g[0]; return { first, pnl: r2(g.reduce((a, x) => a + (x.result.pnlMoney || 0), 0)), risk: g.reduce((a, x) => a + (x.riskMoney || 0), 0), rr: rrTotOf(first) }; }).sort((x, y) => Date.parse(x.first.ts) - Date.parse(y.first.ts));
    const wins = sets.filter(x => x.first.result.outcome === 'WIN').length, losses = sets.filter(x => x.first.result.outcome === 'LOSS').length, be = sets.length - wins - losses;
    const pnl = r2(sets.reduce((a, x) => a + x.pnl, 0)), rSum = r2(sets.reduce((a, x) => a + (x.risk > 0 ? x.pnl / x.risk : 0), 0)), rrSum = sets.reduce((a, x) => a + (x.rr || 0), 0);
    // setups actifs : TP1 atteint ? SL du reste à BE ? TP2 atteint ?
    const act = {}; mine.forEach(t => { (act[t.setupId || t.id] = act[t.setupId || t.id] || []).push(t); });
    const trades = Object.values(act).filter(g => g.some(x => ['PENDING', 'SENT', 'LIMIT', 'OPEN', 'UNCONFIRMED'].includes(x.status))).map(g => {
      const t1 = g.find(x => x.leg === 'TP1'), t2 = g.find(x => x.leg === 'TP2'), first = g[0];
      const tp1Hit = !!(t1 && t1.status === 'CLOSED' && t1.result && t1.result.outcome === 'WIN'), tp2Hit = !!(t2 && t2.status === 'CLOSED' && t2.result && t2.result.outcome === 'WIN');
      const open = g.filter(x => ['OPEN', 'UNCONFIRMED'].includes(x.status));
      return { setupId: first.setupId || first.id, action: first.action, entry: first.entry, openPrice: (open[0] && open[0].openPrice != null) ? open[0].openPrice : null, sl: first.sl, tp1: t1 ? t1.tp : first.tp, tp2: t2 ? t2.tp : null,
        live: open.length > 0, pending: !open.length, tp1Hit, be: tp1Hit && !tp2Hit && open.length > 0, tp2Hit, rrTotal: rrTotOf(first) };
    });
    const info = { module: 'S', title: 'Stratégie SMC · H1 → M15 → M5', htf: 'M15', ltf: 'M5', wait: null, setups: [], trades,
      orders: mine.filter(t => ['PENDING', 'SENT', 'LIMIT'].includes(t.status)).map(shape), live: mine.filter(t => ['OPEN', 'UNCONFIRMED'].includes(t.status)).map(shape),
      history: sets.slice(-10).reverse().map(x => ({ ts: x.first.ts, action: x.first.action, pnlMoney: x.pnl, outcome: x.first.result.outcome, rr: x.rr })),
      stats: { trades: sets.length, wins, losses, be, winRate: sets.length ? Math.round(wins / sets.length * 1000) / 10 : null, pnl, rSum, rrAvg: sets.length ? r2(rrSum / sets.length) : null } };
    const b = smcCtx(sym);
    if (b.wait) info.wait = b.wait;
    else {
      const bk = smcBk(), E = analysis.smcEval(b.ctx), px = b.ctx.price.mid, order = { CONFIRMED: 0, TOUCHED: 1, ZONE: 2 };
      if (E.wait && !E.setups.some(s => !s.dead)) info.wait = E.wait;
      info.bias = E.bias; info.bos = E.bos;
      info.setups = E.setups.filter(s => !s.dead && !bk.used[s.id]).map(s => {
        const z = s.zone, dist = s.dir === 'BUY' ? Math.max(0, px - z.hi) : Math.max(0, z.lo - px), tg = s.tags || {};
        return { id: s.id, dir: s.dir, state: s.state, tf: z.tf, lo: z.lo, hi: z.hi, bosLevel: z.bosLevel, wait: s.wait, distUsd: r2(dist), entry: s.entry != null ? s.entry : null, sl: s.sl != null ? s.sl : null, tp1: s.tp1 != null ? s.tp1 : null, tp2: s.tp2 != null ? s.tp2 : null, rrTotal: s.rrTotal != null ? r2(s.rrTotal) : null,
          liq: tg.liq || [], fib: !!tg.fib, counter: !!tg.counter };
      }).sort((x, y) => (order[x.state] - order[y.state]) || (x.distUsd - y.distUsd)).slice(0, 8);
    }
    out.modules.S = info;
    out.total = info.stats;
    return out;
  }
  /** Vue « Mentor » (visuel seulement) : bougies H1 / M15 / M5, BOS, zone OB, état, entrée live + TP + SL. */
  function smcChart() {
    const sym = 'XAUUSD', price = freshPrice(sym), rawOf = n => ((CANDLES[sym] || {})[n] || []);
    const pack = (arr, k) => arr.slice(-k).map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
    const out = { ok: true, module: 'S', symbol: sym, htf: 'M15', ltf: 'M5', price: price ? price.mid : null, htfCandles: pack(rawOf(15), 90), ltfCandles: pack(rawOf(5), 120), setups: [], high: null, low: null, wait: null, positions: [], ts: new Date(clock()).toISOString() };
    const bk = smcBk(), mine = S.trades.filter(t => t.smcModule === 'S' && t.mode !== 'OPR' && t.mode !== 'NEWS' && ['PENDING', 'SENT', 'LIMIT', 'OPEN', 'UNCONFIRMED'].includes(t.status));
    out.positions = mine.map(t => ({ id: t.id, action: t.action, leg: t.leg || null, entry: t.entry, sl: t.sl, tp: t.tp, status: t.status, openPrice: t.openPrice != null ? t.openPrice : null }));
    const b = smcCtx(sym);
    if (b.wait) { out.wait = b.wait; return out; }
    const E = analysis.smcEval(b.ctx), order = { CONFIRMED: 0, TOUCHED: 1, ZONE: 2 }, px = b.ctx.price.mid;
    out.high = E.high; out.low = E.low; out.bias = E.bias; out.bos = E.bos;
    if (E.wait && !E.setups.some(x => !x.dead)) out.wait = E.wait;
    out.setups = E.setups.filter(x => !x.dead && !bk.used[x.id]).map(x => {
      const z = x.zone, dist = x.dir === 'BUY' ? Math.max(0, px - z.hi) : Math.max(0, z.lo - px);
      return { id: x.id, dir: x.dir, state: x.state, lo: z.lo, hi: z.hi, zoneT: z.t, bosT: z.bosT, bosLevel: z.bosLevel, wait: x.wait, distUsd: r2(dist), ob: null,
        confT: x.confirm ? x.confirm.t : null, refHigh: x.confirm ? x.confirm.refHigh : null, entry: x.entry != null ? x.entry : null, sl: x.sl != null ? x.sl : null, tp1: x.tp1 != null ? x.tp1 : null, tp2: x.tp2 != null ? x.tp2 : null, rrTotal: x.rrTotal != null ? r2(x.rrTotal) : null };
    }).sort((x, y) => (order[x.state] - order[y.state]) || (x.distUsd - y.distUsd)).slice(0, 4);
    return out;
  }
  /** Zones clés (anciennes stratégies supprimées) : forme de réponse conservée pour le site, sans donnée. */
  function keyZonesView() { return { enabled: false, entry: 'BOS', symbols: DAY_SYMS.slice(), pairs: {} }; }
  const modeTradesToday = (mode, sym) => new Set(S.trades.filter(t => t.tradingMode === mode && (!sym || t.symbol === sym) && t.mode !== 'NEWS' && t.mode !== 'OPR' && !['REJECTED', 'EXPIRED', 'CANCELLED'].includes(t.status) && S.day && localParts(Date.parse(t.ts)).date === S.day.date).map(t => t.setupId || t.id)).size;
  const weekStartUTC = ts => { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.getTime(); };
  const modeTradesWeek = (mode, sym, ts) => { const w0 = weekStartUTC(ts); return new Set(S.trades.filter(t => t.tradingMode === mode && (!sym || t.symbol === sym) && t.mode !== 'NEWS' && t.mode !== 'OPR' && !['REJECTED', 'EXPIRED', 'CANCELLED'].includes(t.status) && Date.parse(t.ts) >= w0).map(t => t.setupId || t.id)).size; };
  // ---------- OPR : robot AUTOMATIQUE (XAUUSD M5, range d'ouverture + RSI) — indépendant de l'IA Mentor ----------
  const OPR_PIP = 0.01;
  function oprRsiLast(closes, len) {   // RSI de Wilder, dernière valeur
    if (closes.length <= len) return null;
    let g = 0, l = 0;
    for (let i = 1; i <= len; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
    let ag = g / len, al = l / len;
    for (let i = len + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; ag = (ag * (len - 1) + Math.max(d, 0)) / len; al = (al * (len - 1) + Math.max(-d, 0)) / len; }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  /** Calcule l'état OPR du jour à partir des bougies M5 RÉELLES (cTrader). Rien d'inventé : sans bougies -> stage NO_DATA. */
  function oprCompute(ts) {
    const O = cfg().opr, lp = localParts(ts, O.tz), sym = symOf(O.symbol);
    const oS = hhmm(O.oprStart), oE = hhmm(O.oprEnd), gS = hhmm(O.greenStart), rS = hhmm(O.redStart);
    const out = { symbol: sym, date: lp.date, minutes: lp.minutes, stage: 'WAIT_RANGE', range: null, candle: null, rows: null, signal: null, note: '' };
    if (lp.dow === 0 || lp.dow === 6) { out.stage = 'CLOSED'; out.note = 'Week-end'; return out; }
    if (O.noFriday && lp.dow === 5) { out.stage = 'BLOCKED'; out.note = 'Pas de trade le vendredi (filtre)'; return out; }
    if (lp.minutes < oS) return out;
    const cs = ((CANDLES[sym] || {})[5] || []);
    if (cs.length < O.rsiLen + 2) { out.stage = 'NO_DATA'; out.note = `DATA_UNAVAILABLE : bougies M5 ${sym} insuffisantes (${cs.length})`; return out; }
    const closed = cs.filter(x => x.t + 300000 <= ts), day = [];
    for (let i = closed.length - 1; i >= 0 && closed.length - i <= 400; i--) {
      const q = localParts(closed[i].t, O.tz);
      if (q.date !== lp.date) { if (day.length) break; continue; }
      day.unshift(Object.assign({}, closed[i], { min: q.minutes }));
    }
    const win = day.filter(x => x.min >= oS && x.min < oE);
    if (lp.minutes < oE || !win.length) { out.stage = 'FORMING'; return out; }
    const hi = Math.max(...win.map(x => x.h)), lo = Math.min(...win.map(x => x.l)), pips = (hi - lo) / OPR_PIP;
    out.range = { hi, lo, pips: r2(pips), ok: pips >= O.minPips && pips <= O.maxPips };
    if (!out.range.ok) { out.stage = 'RANGE_OUT'; out.note = `OPR hors limites (${r2(pips)} pips) : pas de trade aujourd'hui`; return out; }
    if (lp.minutes >= rS) { out.stage = 'EXPIRED'; out.note = 'Fenêtre terminée'; return out; }
    out.stage = 'WATCHING';
    const x = day.filter(c => c.min >= oE).slice(-1)[0];
    if (!x) return out;
    const buy = x.c > hi, sell = x.c < lo;
    out.candle = { t: x.t, o: x.o, h: x.h, l: x.l, c: x.c };
    const rsi = oprRsiLast(closed.filter(c => c.t <= x.t).slice(-300).map(c => c.c), O.rsiLen);
    const slD = buy ? x.c - x.l : sell ? x.h - x.c : (x.c >= x.o ? x.c - x.l : x.h - x.c), slPips = slD / OPR_PIP;
    out.rows = [
      { l: 'Heure', v: `${String(Math.floor(x.min / 60)).padStart(2, '0')}:${String(x.min % 60).padStart(2, '0')}`, ok: x.min >= gS && x.min < rS },
      { l: 'OPR', v: `${r2(pips)} pips`, ok: out.range.ok },
      { l: 'RSI', v: rsi == null ? 'N/A' : r2(rsi), ok: rsi == null ? null : (rsi >= O.rsiOS && rsi <= O.rsiOB) },
      { l: 'SL', v: `${r2(slPips)} pips`, ok: slD > 0 && slPips <= O.slMaxPips }
    ];
    if (!(buy || sell)) { out.note = 'En attente d\'une clôture M5 au-delà du range'; return out; }
    if (out.rows.every(r => r.ok === true)) out.signal = { dir: buy ? 'BUY' : 'SELL', rsi: r2(rsi), slPips: r2(slPips) };
    else out.note = 'Cassure détectée mais tableau non vert : pas de trade';
    return out;
  }
  async function oprScan(ts) {
    const O = cfg().opr; if (!O.enabled || !O.autoTrade) return;
    const st = (S.oprRun = S.oprRun || {}), r = oprCompute(ts);
    if (st.date !== r.date) { st.date = r.date; st.done = false; st.tradeId = null; st.lastCandle = null; }
    if (st.done || r.stage !== 'WATCHING' || !r.candle || st.lastCandle === r.candle.t) return;
    st.lastCandle = r.candle.t; save();
    if (!r.signal) { log('WAIT', `OPR ${r.symbol}: ${r.note || 'pas de signal'}`, { kind: 'opr' }); return; }
    const price = await ensurePrice(r.symbol);
    if (!price) { log('WAIT', 'OPR: DATA_UNAVAILABLE prix', { kind: 'opr' }); st.lastCandle = null; return; }
    const buy = r.signal.dir === 'BUY', entry = price.mid, sl = buy ? r.candle.l : r.candle.h, d = Math.abs(entry - sl);
    if (!(d > 0) || (buy ? sl >= entry : sl <= entry)) { log('WAIT', 'OPR: le prix a déjà dépassé le SL de la bougie de signal', { kind: 'opr' }); return; }
    if (d / OPR_PIP > O.slMaxPips) { log('WAIT', `OPR: SL ${r2(d / OPR_PIP)} pips > ${O.slMaxPips}`, { kind: 'opr' }); return; }
    const tp = entry + (buy ? 1 : -1) * O.rr * d;
    const res = await submitSignal({ symbol: r.symbol, action: r.signal.dir, entry, sl, tp, tradingMode: 'OPR',
      reason: `OPR ${r.signal.dir} · cassure du range ${r.range.lo}-${r.range.hi} (${r.range.pips} pips) · RSI ${r.signal.rsi} · SL ${r2(d / OPR_PIP)} pips · RR ${O.rr}` }, 'OPR');
    if (res.ok) { st.done = true; st.tradeId = res.tradeId; st.dir = r.signal.dir; st.at = new Date(ts).toISOString(); save(); }
  }
  /** P/L réel par stratégie : SCALPING, DAY TRADE, OPR, NEWS (aujourd'hui / ce mois / total). */
  function plView() {
    const ts = clock(), tz = cfg().timezone, today = localParts(ts, tz).date, month = today.slice(0, 7);
    const cats = { DAYTRADE: 'DAY TRADE', OPR: 'OPR', NEWS: 'NEWS' }, out = {};
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
  function oprView(ts) {
    const O = cfg().opr, r = oprCompute(ts), st = S.oprRun || {};
    const trades = S.trades.filter(t => t.mode === 'OPR').map(t => ({
      id: t.id, ts: t.ts, symbol: t.symbol, action: t.action, entry: t.entry, sl: t.sl, tp: t.tp, lots: t.lots, riskMoney: t.riskMoney, status: t.status,
      exit: t.exitPrice != null ? t.exitPrice : null, pnlMoney: t.result && t.result.pnlMoney != null ? t.result.pnlMoney : null,
      pnlPoints: t.result && t.result.pnlPoints != null ? t.result.pnlPoints : null, outcome: t.result && t.result.outcome || null, note: t.execNote || null, reason: t.reason
    }));
    const closed = trades.filter(t => t.status === 'CLOSED'), month = localParts(ts, O.tz).date.slice(0, 7);
    const sum = a => r2(a.reduce((x, t) => x + (t.pnlMoney || 0), 0)), wins = closed.filter(t => t.outcome === 'WIN').length, losses = closed.filter(t => t.outcome === 'LOSS').length;
    const m = closed.filter(t => localParts(Date.parse(t.ts), O.tz).date.slice(0, 7) === month);
    return {
      ok: true, enabled: O.enabled, autoTrade: O.autoTrade, pauseMentor: O.pauseMentor, mentorPaused: oprWindow(ts), tz: O.tz, symbol: r.symbol,
      config: { oprStart: O.oprStart, oprEnd: O.oprEnd, greenStart: O.greenStart, redStart: O.redStart, minPips: O.minPips, maxPips: O.maxPips, rsiLen: O.rsiLen, rsiOB: O.rsiOB, rsiOS: O.rsiOS, slMaxPips: O.slMaxPips, rr: O.rr, riskPct: O.riskPct, noFriday: O.noFriday },
      stage: r.stage, note: r.note, range: r.range, candle: r.candle, rows: r.rows, signal: r.signal, today: { done: !!(st.date === r.date && st.done), tradeId: st.date === r.date ? st.tradeId || null : null },
      trades: trades.slice(-30).reverse(),
      stats: { total: closed.length, wins, losses, winRate: closed.length ? Math.round(wins / closed.length * 100) : null, pnlMoney: sum(closed), monthPnl: sum(m), monthTrades: m.length, open: trades.filter(t => ACTIVE.includes(t.status)).length }
    };
  }

  /** Ordres LIMIT en attente : annulation automatique (expirés, pause news, hors fenêtre de trading). */
  function manageLimits(ts) {
    const m = modeCfg('DAYTRADE');
    for (const t of S.trades) {
      if (t.orderType !== 'LIMIT' || t.status !== 'LIMIT' || t.cancelReq) continue;
      const px = freshPrice(t.symbol);   // « touché » : le prix atteint l'entrée de l'ordre limit (notification liée à un ordre RÉEL)
      if (px && !t.touchedAt && (t.action === 'BUY' ? px.mid <= t.entry : px.mid >= t.entry)) { t.touchedAt = ts; log('TOUCH', `${t.symbol} prix à l'entrée de l'ordre limit ${t.entry} (touché)`, { kind: 'touch', tradeId: t.id }, true); save(); }
      let why = null;
      if (t.limitExpiryTs && ts > t.limitExpiryTs) why = 'ordre limit expiré (non touché)';
      else if (newsContext(ts).paused) why = 'annulé : pause news';
      else if (m.windowsUTC && !m.windowsUTC.some(w => hhmmUTC() >= w[0] && hhmmUTC() < w[1])) why = 'annulé : fin de la fenêtre de trading';
      if (why) { t.cancelReq = why; log('LIMIT', `${t.symbol} ${why}`, { kind: 'limit', tradeId: t.id }, true); }
    }
  }
  // ---------- tick (1/s) ----------
  async function tick(ts = clock()) {
    rollDay(ts);
    const c = cfg();
    for (const t of S.trades) {
      const age = ts - Date.parse(t.ts);
      if (t.status === 'PENDING' && age > c.signalTTLSec * 1000) { t.status = 'EXPIRED'; t.execNote = 'non envoyé à cTrader dans le délai'; S.day.trades = Math.max(0, S.day.trades - 1); clearDecision(t, 'Ordre non envoyé à cTrader dans le délai : signal annulé'); log('EXPIRED', 'Ordre non pris en charge par cTrader: ' + t.id, { kind: 'exp' }, true); }
      else if (t.status === 'SENT' && ts - t.sentTs > c.signalTTLSec * 1000) { t.status = 'UNCONFIRMED'; t.execNote = 'aucune confirmation cTrader'; log('UNCONFIRMED', 'Aucune confirmation cTrader pour ' + t.id + ' : vérifier le compte puis clore manuellement', { kind: 'unc' }, true); }
    }
    manageLimits(ts);
    if (c.autoTrade) { try { await smcScan(ts); } catch (e) { console.error('[mentor] smc:', e && e.message); } }
    if (c.opr && c.opr.enabled && c.opr.autoTrade) { try { await oprScan(ts); } catch (e) { console.error('[opr] scan:', e && e.message); } }
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
        if (!ev.executed && ev.analysis && ts >= ev.t - (c.news.executeBeforeSec + 15) * 1000 && ts < ev.t - c.news.executeBeforeSec * 1000) await ensurePrice();   // pré-chauffe du prix
        if (!ev.executed && ts >= ev.t - c.news.executeBeforeSec * 1000) {
          // Une seule entrée par publication : « Core CPI m/m + CPI m/m + CPI y/y » ou « NFP + chômage + salaires » = UN trade (l'indicateur le plus lourd).
          const grp = S.news.filter(x => relevant(x) && x.t === ev.t), wOf = x => (x.analysis && x.analysis.indicator && x.analysis.indicator.weight) || 0;
          const primary = grp.reduce((a, x) => (wOf(x) > wOf(a) ? x : a), grp[0]);
          if (primary && primary.id !== ev.id) { ev.executed = { status: 'GROUPED', primary: primary.id, reason: 'même publication que ' + primary.title }; save(); continue; }
          if (ts >= ev.t - 5000) { ev.executed = { status: 'MISSED', reason: 'fenêtre T-1min dépassée' }; log('NO TRADE', `${ev.title}: fenêtre T-1min manquée`, { kind: 'news' }, true); save(); continue; }
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
              const buy = act === 'BUY', pts = sp.pointSize, nv = newsSlTp(c, sym);
              const r = await submitSignal({
                symbol: sym, action: act, entry: price.mid,
                sl: price.mid + (buy ? -1 : 1) * nv.sl * pts, tp: price.mid + (buy ? 1 : -1) * nv.tp * pts, tp2: price.mid + (buy ? 1 : -1) * nv.tp2 * pts,
                reason: `NEWS ${ev.title} — ${a.reason}`
              }, 'NEWS');
              if (r.ok) ids.push(...(r.tradeIds || [r.tradeId])); else reasons.push(sym + ': ' + r.reason);
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
  const sessionCloseDue = () => !!(cfg().session && cfg().session.enabled && hhmmUTC() >= cfg().session.closeAllUTC);
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
      dataQuality: { price: freshPrice() ? 'REAL (' + S.price.src + ')' : 'UNAVAILABLE', balance: b.source, news: newsStale() ? 'UNAVAILABLE (périmé)' : (S.newsFeedAt ? 'REAL (flux calendrier)' : 'UNAVAILABLE'), candles: candleCounts(), orderFlow: cfg().analysis.orderFlow.enabled ? orderFlowFor(cfg().symbol).status : 'OFF' },
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
  function setDayFilters(f) {
    const clean = a => (Array.isArray(a) ? a : []).slice(0, 60);
    S.config.dayFilters = { setups: clean(f.setups).map(String), pairs: clean(f.pairs).map(x => String(x).toUpperCase()), sens: clean(f.sens).map(x => String(x).toUpperCase()), hours: clean(f.hours).map(Number).filter(h => h >= 0 && h < 24), parts: clean(f.parts).map(String), factors: clean(f.factors).map(String) };
    S.autoState = { scan: {} }; S.zones = {}; save();
    return { ok: true, dayFilters: S.config.dayFilters };
  }
  function syncSmc() {   // le SL fixe 50–100 pips du site pilote aussi le contrôle du moteur d'ordres
    const c = S.config, u = c.smc || {}, m = c.modes && c.modes.DAYTRADE;
    if (m && u.slMaxPips > 0) { m.slMax = u.slMaxPips + 0.5; m.minSl = u.slMinPips || 0; }
  }
  function setConfig(patch) {
    const before = clone(S.config);
    S.config = merge(S.config, patch || {});
    syncSmc();
    if (!['NORMAL', 'PROP'].includes(S.config.mode)) S.config.mode = before.mode;
    if (!TRADING_MODES.includes(S.config.tradingMode)) S.config.tradingMode = before.tradingMode;
    S.config.symbolsAllowed = (Array.isArray(S.config.symbolsAllowed) ? S.config.symbolsAllowed : before.symbolsAllowed).map(symOf).filter(s => S.config.symbols[s]);
    if (!S.config.symbolsAllowed.length) S.config.symbolsAllowed = before.symbolsAllowed;
    S.config.autoTrade = !!S.config.autoTrade;
    S.config.combined = !!S.config.combined;
    S.autoState.scan = {}; for (const k of Object.keys(ZC)) delete ZC[k];
    save();
    log('CONFIG', 'Configuration mise à jour', { kind: 'cfg', patch }, true);
    return S.config;
  }
  function setTradingMode(v) {
    v = String(v || '').toUpperCase();
    if (!TRADING_MODES.includes(v)) return { ok: false, error: 'tradingMode doit être DAYTRADE' };
    S.config.tradingMode = v; S.autoState.scan = {}; save(); log('MODE', 'Mode de trading = ' + v, { kind: 'mode' }, true);
    return { ok: true, tradingMode: v, combined: !!S.config.combined, timeframes: modeCfg().timeframes.map(x => 'M' + x) };
  }
  function setCombined(on) { S.config.combined = !!on; S.autoState.scan = {}; save(); log('MODE', 'Mode combiné (inutile : DAY TRADE seul) = ' + (S.config.combined ? 'ON' : 'OFF'), { kind: 'mode' }, true); return { ok: true, combined: S.config.combined, runningModes: modesRunning() }; }
  function setAutoTrade(on) { S.config.autoTrade = !!on; save(); log('AUTOTRADE', 'Auto Trade = ' + (S.config.autoTrade ? 'ON' : 'OFF'), { kind: 'auto' }, true); return { ok: true, autoTrade: S.config.autoTrade }; }
  function setActive(v) {
    v = String(v || '').toUpperCase();
    if (v === 'PROP') v = 'NORMAL';   // Prop Firm supprimé
    if (!['OFF', 'NORMAL'].includes(v)) return { ok: false, error: 'active doit être OFF ou NORMAL' };
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
    tick, submitSignal, status, risk: riskView, setConfig, setDayFilters, getDayFilters: dayFilters, setActive, setBlock, setNews, newsFeedHeartbeat, setTradingMode, setCombined, setAutoTrade, emergencyStop,
    execNext, execAck, execFail, execPending, execCancelled, cancelNext, cancelLimit, execResult, beTargets, manualClose, updateAccount, setCandles, setExecStatus, btSummary, btSplit, btSegments, tradePanel: smcPanelView, smcChart, backtestSmc, btCompact,
    opr: () => oprView(clock()), plView, getConfig: () => clone(S.config), news: () => newsView(clock()), newsEvents: () => S.news.map(e => ({ id: e.id, title: e.title, time: e.time, impact: e.impact, currency: e.currency, category: e.category, forecast: e.forecast, previous: e.previous, actual: e.actual, analysis: e.analysis, executed: e.executed, trades: newsTrades(e).trades, result: newsTrades(e).result })),
    propStatus: () => { rollDay(clock()); return propStatus(); }, logs: (n = 100) => logs.slice(-n), trades: (n = 50) => S.trades.slice(-n), journal,
    activeTrades: () => activeTrades().map(t => Object.assign({}, t)), sessionCloseDue, userId,
    _analyze: analyze, keyZones: keyZonesView, _internals: { S: () => S, CANDLES }
  };
}

module.exports = { createEngine, DEFAULTS };
