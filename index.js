'use strict';
/**
 * ARES — IA MENTOR : routes API (Auth · cTrader · IA Engine · Order Flow · News · Risk · Journal · Admin) + boucle 1 s.
 * Utilisation dans server.js :
 *   const mentor = require('./index.js')(express, { news: newsProvider });  app.use(mentor.router);  mentor.start();
 *   opts.news (facultatif) : NewsProvider (providers/providers.js). Sans lui, NEWS = UNAVAILABLE et l'IA Mentor continue de fonctionner.
 *
 * Variables d'environnement : voir .env.example (aucun secret n'est jamais envoyé au frontend ni écrit dans les logs).
 * Authentification (Dingana 1) : clé d'API MENTOR_API_KEY -> utilisateur OWNER_USER_ID ; ADMIN_API_KEY -> administrateur.
 * Un résolveur plus riche (comptes + JWT) se branche via opts.resolveUser(req) -> { userId, role } sans toucher aux routes.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createManager } = require('./ctrader/manager');
const { USER_RE } = require('./ctrader/token-store');
const newsCore = require('./news-core');       // NEWS USA importantes seulement
const fundamental = require('./fundamental');   // analyse fondamentale USD de l'IA Mentor (remplace l'ancienne IA Gemini)
if (process.env.CTRADER_DIAG === '1') { try { require('./ctrader/diag').run(); } catch (e) { console.log('[ctrader-diag] erreur', e && e.message); } }

module.exports = function createMentor(express, opts = {}) {
  const dataRoot = opts.dataRoot || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const orderFlow = null;   // Order Flow / Bookmap / Exocharts supprimés
  const manager = opts.manager || createManager({ dataRoot, orderFlow, WebSocketImpl: opts.WebSocketImpl });
  const news = opts.news || null;   // NewsProvider : calendrier économique réel (ou null)
  const router = express.Router();
  const json = express.json({ limit: '128kb' });
  const OWNER = USER_RE.test(process.env.OWNER_USER_ID || '') ? process.env.OWNER_USER_ID : 'owner';

  // ---------- état admin persistant (suspensions + limites globales) ----------
  const adminFile = path.join(dataRoot, 'admin-state.json');
  let admin = { suspended: [], limits: { maxRiskPct: Number(process.env.GLOBAL_MAX_RISK_PCT) || 2, maxDrawdownPct: 90, liveAllowed: process.env.GLOBAL_LIVE_ALLOWED !== '0' } };
  try { admin = Object.assign(admin, JSON.parse(fs.readFileSync(adminFile, 'utf8'))); } catch (e) { /* premier démarrage */ }
  const saveAdmin = () => { try { fs.mkdirSync(dataRoot, { recursive: true }); fs.writeFileSync(adminFile, JSON.stringify(admin)); } catch (e) { /* ignore */ } };

  // ---------- sécurité ----------
  const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  const keyOf = req => req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  function resolveUser(req) {
    if (typeof opts.resolveUser === 'function') return opts.resolveUser(req);
    const k = keyOf(req);
    if (process.env.ADMIN_API_KEY && eq(k, process.env.ADMIN_API_KEY)) return { userId: OWNER, role: 'admin' };
    if (process.env.MENTOR_API_KEY && eq(k, process.env.MENTOR_API_KEY)) return { userId: OWNER, role: 'user' };
    if (process.env.MENTOR_PUBLIC_READ === '1' && req.method === 'GET') return { userId: OWNER, role: 'reader' };   // héritage : lecture sans clé (déconseillé)
    return null;
  }
  const auth = (req, res, next) => {
    const u = resolveUser(req);
    if (!u || !USER_RE.test(String(u.userId))) return res.status(401).json({ ok: false, error: 'authentification requise' });
    if (u.role === 'reader' && req.method !== 'GET') return res.status(403).json({ ok: false, error: 'lecture seule' });
    if (admin.suspended.includes(u.userId) && req.method !== 'GET') return res.status(403).json({ ok: false, error: 'compte suspendu par l\'administrateur' });
    req.user = u; next();
  };
  const adminOnly = (req, res, next) => {
    const u = resolveUser(req);
    if (!u || u.role !== 'admin') return res.status(403).json({ ok: false, error: 'administrateur requis' });
    req.user = u; next();
  };
  const hits = new Map();
  const limiter = (max, windowMs = 60000) => (req, res, next) => {
    const k = (req.ip || '') + '|' + (req.baseUrl || '') + (req.route && req.route.path || ''), t = Date.now();
    const h = (hits.get(k) || []).filter(x => t - x < windowMs);
    if (h.length >= max) return res.status(429).json({ ok: false, error: 'trop de requêtes, réessayez plus tard' });
    h.push(t); hits.set(k, h);
    if (hits.size > 5000) for (const [kk, vv] of hits) if (!vv.length || t - vv[vv.length - 1] > windowMs) hits.delete(kk);
    next();
  };
  const readLimit = limiter(240), writeLimit = limiter(60), authLimit = limiter(20);
  const safe = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { console.error('[api]', req.method, req.path, e && e.message); res.status(500).json({ ok: false, error: String(e && e.message || e).replace(/(access|refresh)[_-]?token[^,;]*/gi, '[redacted]').slice(0, 300) }); }
  };
  const E = req => manager.engine(req.user.userId);

  // CORS lecture seule pour le frontend
  router.use(['/api/mentor', '/api/ctrader', '/api/prop', '/api/orderflow', '/api/trading-mode', '/api/bookmap', '/api/exocharts', '/api/admin'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.MENTOR_CORS_ORIGIN) {
      res.set('Access-Control-Allow-Origin', process.env.MENTOR_CORS_ORIGIN);
      res.set('Access-Control-Allow-Headers', 'x-api-key, authorization, content-type');
      res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---------- validation ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const finite = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v));
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  function sanitizeConfig(src) {
    const out = {}, G = admin.limits;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return out;
    const num = (o, d, k, lo, hi) => { if (o && finite(o[k])) d[k] = clamp(Number(o[k]), lo, hi); };
    const bool = (o, d, k) => { if (o && typeof o[k] === 'boolean') d[k] = o[k]; };
    const sub = (k, fn) => { if (src[k] && typeof src[k] === 'object') { const d = {}; fn(src[k], d); if (Object.keys(d).length) out[k] = d; } };
    if (String(src.tradingMode).toUpperCase() === 'DAYTRADE') out.tradingMode = 'DAYTRADE';
    bool(src, out, 'autoTrade'); bool(src, out, 'combined');
    out.liveExecution = !!G.liveAllowed;   // plus de PAPER : ordres réels, sauf coupure admin globale (GLOBAL_LIVE_ALLOWED=0)
    if (Array.isArray(src.symbolsAllowed)) out.symbolsAllowed = src.symbolsAllowed.slice(0, 20).map(s => String(s).toUpperCase().replace(/[^A-Z]/g, '')).filter(Boolean);
    num(src, out, 'riskPerTradePct', 0.05, G.maxRiskPct); num(src, out, 'maxActiveTrades', 1, 5);
    sub('normal', (o, d) => { num(o, d, 'objectivePoints', 1, 500); num(o, d, 'dailyLossPoints', 1, 500); num(o, d, 'maxTrades', 0, 100); num(o, d, 'minRR', 0.5, 10); });
    sub('profitProtection', (o, d) => {
      bool(o, d, 'enabled'); if (['POINTS', 'MONEY'].includes(String(o.unit).toUpperCase())) d.unit = String(o.unit).toUpperCase();
      if (o.target === null) d.target = null; else num(o, d, 'target', 0.01, 1e6);
      num(o, d, 'initialRisk', 0, 1e6);
      if (o.trailing && typeof o.trailing === 'object') { d.trailing = {}; bool(o.trailing, d.trailing, 'enabled'); num(o.trailing, d.trailing, 'giveBack', 0, 1e6); }
      if (o.lotScaling && typeof o.lotScaling === 'object') { d.lotScaling = {}; bool(o.lotScaling, d.lotScaling, 'enabled'); num(o.lotScaling, d.lotScaling, 'step', 0.01, 1e6); num(o.lotScaling, d.lotScaling, 'maxMultiplier', 1, 10); }
    });
    sub('risk', (o, d) => { num(o, d, 'maxConsecutiveLosses', 0, 50); num(o, d, 'maxDrawdownPct', 0, G.maxDrawdownPct); num(o, d, 'maxSlippagePts', 0, 100); num(o, d, 'maxOpenPositions', 1, 20); if (o.maxDailyLossMoney === null) d.maxDailyLossMoney = null; else num(o, d, 'maxDailyLossMoney', 0, 1e7); bool(o, d, 'closeOnSlippage'); });
    sub('analysis', (o, d) => {
      num(o, d, 'minScore', 0, 20); num(o, d, 'minComponents', 1, 7); num(o, d, 'minConfidencePct', 0, 100);
      if (o.weights && typeof o.weights === 'object') { d.weights = {}; for (const k of ['structure', 'mtf', 'trigger', 'sweep', 'zone', 'premiumDiscount', 'orderFlow']) num(o.weights, d.weights, k, 0, 10); }
      if (o.orderFlow && typeof o.orderFlow === 'object') { d.orderFlow = {}; bool(o.orderFlow, d.orderFlow, 'enabled'); bool(o.orderFlow, d.orderFlow, 'requireWhenEnabled'); }
    });
    sub('news', (o, d) => { bool(o, d, 'enabled'); bool(o, d, 'autoTrade'); bool(o, d, 'requireData'); bool(o, d, 'coreOnly'); num(o, d, 'minConfidence', 50, 95); });
    sub('opr', (o, d) => {
      bool(o, d, 'enabled'); bool(o, d, 'autoTrade'); bool(o, d, 'pauseMentor'); bool(o, d, 'noFriday');
      for (const k of ['oprStart', 'oprEnd', 'greenStart', 'redStart']) if (HHMM.test(String(o[k]))) d[k] = o[k];
      num(o, d, 'minPips', 1, 100000); num(o, d, 'maxPips', 1, 100000); num(o, d, 'rsiLen', 2, 50); num(o, d, 'rsiOB', 50, 100); num(o, d, 'rsiOS', 0, 50);
      num(o, d, 'slMaxPips', 10, 100000); num(o, d, 'rr', 0.5, 10); num(o, d, 'riskPct', 0.05, G.maxRiskPct);
    });
    sub('session', (o, d) => { bool(o, d, 'enabled'); for (const k of ['startUTC', 'noEntryAfterUTC', 'closeAllUTC']) if (HHMM.test(String(o[k]))) d[k] = o[k]; });
    sub('micro', (o, d) => { bool(o, d, 'enabled'); num(o, d, 'maxRiskPct', 1, 50); });
    return out;
  }
  function validSignal(b) {
    if (!b || typeof b !== 'object') return 'corps invalide';
    if (!/^[A-Za-z]{3,12}$/.test(String(b.symbol || ''))) return 'symbol invalide';
    if (!['BUY', 'SELL', 'WAIT'].includes(String(b.action || '').toUpperCase())) return 'action doit être BUY, SELL ou WAIT';
    if (String(b.action).toUpperCase() !== 'WAIT') for (const k of ['entry', 'sl']) if (!finite(b[k])) return k + ' numérique requis';
    if (String(b.action).toUpperCase() !== 'WAIT' && !finite(b.tp1) && !finite(b.tp)) return 'tp1 numérique requis';
    for (const k of ['tp2', 'tp3', 'risk']) if (b[k] !== undefined && b[k] !== null && !finite(b[k])) return k + ' invalide';
    return null;
  }
  const reject = (res, msg) => res.status(400).json({ ok: false, error: msg });

  // ---------- IA Mentor : lecture (utilisateur authentifié) ----------
  router.get('/api/mentor/status', readLimit, auth, safe(req => Object.assign(E(req).status(), { user: req.user.userId, suspended: admin.suspended.includes(req.user.userId), ctrader: manager.sessionStatus(req.user.userId), orderFlow: {} })));
  router.get('/api/mentor/signal', readLimit, auth, safe(req => ({ ok: true, decision: E(req).status().decision, trades: E(req).trades(10) })));
  router.get('/api/mentor/risk', readLimit, auth, safe(req => E(req).risk()));
  router.get('/api/mentor/trades', readLimit, auth, safe(req => ({ ok: true, trades: E(req).trades(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/journal', readLimit, auth, safe(req => ({ ok: true, journal: E(req).journal(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/news', readLimit, auth, safe(req => Object.assign({ ok: true }, E(req).news(), { events: E(req).newsEvents() })));
  // Calendrier économique réel (NEWS) : aucun événement n'est inventé ; sans flux : state UNAVAILABLE + liste vide.
  router.get('/api/mentor/news/calendar', readLimit, auth, safe(req => {
    if (!news) return { ok: true, state: 'UNAVAILABLE', available: false, fetchedAt: null, error: 'aucun flux news configuré', count: 0, events: [] };
    const st = news.status();
    const days = clamp(Number(req.query.days) || 7, 1, 14);
    const now = Date.now(), cur = String(req.query.currency || 'USD').slice(0, 3).toUpperCase();
    const raw0 = news.calendar({ now, currency: cur, impacts: String(req.query.impact || 'high').slice(0, 40), days, pastHours: clamp(Number(req.query.past) || 12, 0, 168) });
    // Panneau NEWS : seulement les news USA vraiment importantes (NFP, CPI, PCE, FOMC...). ?all=1 pour tout voir.
    const raw = cur === 'USD' && req.query.all !== '1' ? raw0.filter(e => String(e.impact).toLowerCase() === 'high' && newsCore.isCore(e.title)) : raw0;
    // Analyse fondamentale réelle (USD uniquement) : biais BUY/SELL par paire, jamais NEUTRAL ; contexte = publications des 7 derniers jours.
    const ctx = news.calendar({ now, currency: 'USD', impacts: 'high,medium', days: 1, pastHours: 168 });
    let events = cur === 'USD' ? fundamental.analyzeCalendar(raw, { now, context: ctx }) : raw;
    // Résultat réel du robot : exécution, TP/SL, P/L (même id que le moteur : devise-heure-titre)
    const eng = E(req).newsEvents(), byId = new Map(eng.map(x => [x.id, x]));
    events = events.map(e => {
      const x = byId.get(e.id) || eng.find(y => Date.parse(y.time) === Date.parse(e.time) && y.title === e.title);
      return x ? Object.assign({}, e, { key: newsCore.coreKey(e.title), execution: x.executed || null, trades: x.trades || [], result: x.result || null }) : Object.assign({}, e, { key: newsCore.coreKey(e.title) });
    });
    return { ok: true, state: st.state, available: st.available, source: news.name(), fetchedAt: st.fetchedAt ? new Date(st.fetchedAt).toISOString() : null, error: st.available ? null : st.error, count: events.length, events };
  }));
  router.get('/api/prop/status', readLimit, auth, safe(req => Object.assign({ ok: true }, E(req).propStatus())));
  router.get('/api/mentor/pl', readLimit, auth, safe(req => E(req).plView()));
  router.get('/api/mentor/trade-panel', readLimit, auth, safe(req => E(req).tradePanel()));
  router.get('/api/mentor/day-filters', readLimit, auth, safe(req => ({ ok: true, dayFilters: E(req).getDayFilters() })));
  router.post('/api/mentor/day-filters', writeLimit, auth, json, safe(req => E(req).setDayFilters(sanExclude(req.body) || {})));
  router.post('/api/mentor/limit/:id/cancel', writeLimit, auth, json, safe(req => E(req).cancelLimit(String(req.params.id), 'annulé par l\'utilisateur')));
  router.get('/api/mentor/opr', readLimit, auth, safe(req => E(req).opr()));
  router.get('/api/mentor/log', readLimit, auth, safe(req => ({ ok: true, logs: E(req).logs(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/config', readLimit, auth, safe(req => ({ ok: true, config: E(req).getConfig(), limits: admin.limits })));

  // ---------- IA Mentor : écriture (par utilisateur) ----------
  router.post('/api/signal', writeLimit, auth, json, async (req, res) => {
    const err = validSignal(req.body); if (err) return reject(res, err);
    await safe(r => E(r).submitSignal(req.body, 'NORMAL'))(req, res);
  });
  router.post('/api/mentor/config', writeLimit, auth, json, safe(req => ({ ok: true, config: E(req).setConfig(sanitizeConfig(req.body)) })));
  router.post('/api/mentor/mode', writeLimit, auth, json, safe(req => E(req).setTradingMode(req.body && req.body.tradingMode)));
  router.post('/api/mentor/combined', writeLimit, auth, json, safe(req => E(req).setCombined(req.body && req.body.combined === true)));
  router.post('/api/mentor/autotrade', writeLimit, auth, json, safe(req => E(req).setAutoTrade(req.body && req.body.autoTrade === true)));
  router.post('/api/mentor/active', writeLimit, auth, json, safe(req => E(req).setActive(req.body && req.body.active)));
  router.post('/api/mentor/block', writeLimit, auth, json, safe(req => E(req).setBlock(req.body && req.body.reason ? String(req.body.reason).slice(0, 200) : 'Blocage manuel')));
  router.post('/api/mentor/unblock', writeLimit, auth, json, safe(req => admin.suspended.includes(req.user.userId) ? { ok: false, error: 'compte suspendu par l\'administrateur' } : E(req).setBlock(null)));
  router.post('/api/mentor/emergency-stop', writeLimit, auth, json, safe(req => manager.emergencyStop(req.user.userId, 'demande utilisateur')));
  router.post('/api/mentor/trades/:id/close', writeLimit, auth, json, safe(async req => {
    const e = E(req), t = e.activeTrades().find(x => x.id === req.params.id);
    if (t && t.ticket && manager.session(req.user.userId).status === 'CONNECTED') { try { await manager.session(req.user.userId).closePosition(t.ticket); return { ok: true, requested: true }; } catch (x) { return { ok: false, error: String(x && x.message) }; } }
    return e.manualClose(req.params.id, req.body || {});
  }));
  router.post('/api/mentor/trades/:id/modify', writeLimit, auth, json, safe(async req => {
    const t = E(req).activeTrades().find(x => x.id === req.params.id); const b = req.body || {};
    if (!t || !t.ticket) return { ok: false, error: 'position ouverte introuvable' };
    if ((b.sl !== undefined && !finite(b.sl)) || (b.tp !== undefined && !finite(b.tp))) return { ok: false, error: 'sl / tp numériques' };
    await manager.session(req.user.userId).modifyPosition(t.ticket, { sl: b.sl, tp: b.tp }); return { ok: true };
  }));

  // ---------- BACKTEST sur données historiques réelles (trendbars cTrader) ----------
  const btJobs = new Map();
  const BT_MODE_TFS = { DAYTRADE: [5, 15] };
  const BT_MAX_DAYS = { DAYTRADE: 95 };   // 3 mois maximum par backtest (2 ou 3 mois) : le module B charge beaucoup de bougies M1
  function btRun(job, e, sess) {
    (async () => {
      try {
        const P = job.params, sym = 'XAUUSD', errs = { count: 0, first: null }, bars = {}, info = [], warm = 14 * 86400000, steps = 4;
        let step = 0;
        const upd = (phase, frac) => { job.phase = phase; job.progress = Math.min(0.99, (step + (frac || 0)) / steps); };
        for (const tf of [15, 5]) {   // historique RÉEL du broker (aucune donnée inventée : historique insuffisant = erreur affichée)
          upd(`${sym} · M${tf} : téléchargement de l'historique`, 0);
          bars[tf] = await sess.fetchHistory(sym, tf, P.from - warm, P.to, f => upd(`${sym} · M${tf} : téléchargement de l'historique`, f));
          info.push({ tf: 'M' + tf, bars: bars[tf].length, first: bars[tf].length ? bars[tf][0].t : null, last: bars[tf].length ? bars[tf][bars[tf].length - 1].t : null });
          step++;
        }
        const period = { from: P.from, to: P.to }, modules = {}, all = [];
        const strip = x => { const o = Object.assign({}, x); delete o.byHour; return o; };
        const outcomes = tr => { const o = { both: 0, tp1be: 0, tp: 0, sl: 0, time: 0 }; tr.forEach(t => { const r = String(t.result || ''); if (r === 'TP+TP') o.both++; else if (r === 'TP+BE') o.tp1be++; else if (r === 'TP') o.tp++; else if (r === 'SL') o.sl++; else o.time++; }); return o; };
        const raw = {}, locks = [];
        for (const mod of ['A']) {
          upd(`Gold SMC : analyse (zones M30 + M15 → BOS M15 → entrée M5)`, 0);
          const fun = { seen: new Set(), touched: new Set(), confirmed: new Set(), deadSeen: new Set(), dead: {}, filled: 0, unfilled: 0 };
          const r = await e.backtestSmc(sym, mod, bars, { from: P.from, to: P.to, spreadEq: P.spreadEq, ltf: P.ltf, session: P.sess, cfg: { tp1R: P.tp1R }, errs, funnel: fun, locks, onProgress: f => upd(`Module ${mod} : analyse`, f) });
          raw[mod] = { r, fun }; step++;
        }
        // PAS DE CONTRE : A et B jugés ensemble, dans l'ordre chronologique ; le 1er sens confirmé garde la main tant que son ordre / trade est actif
        const lk = e.smcResolveLocks([].concat(raw.A.r.trades || [], raw.B.r.trades || []), locks), keepSet = new Set(lk.trades);
        for (const mod of ['A']) {
          const { r, fun } = raw[mod];
          const trades = (r.trades || []).filter(t => keepSet.has(t)).sort((x, y) => x.t - y.t);
          trades.forEach(t => all.push(t));
          modules[mod] = { error: r.error || null, summary: strip(e.btSummary(trades, period)), outcomes: outcomes(trades), trades: trades.slice(-300).reverse(),
            funnel: { trendBlocked: fun.trendBlocked || 0, zones: fun.seen.size, touched: fun.touched.size, confirmed: fun.confirmed.size, filled: fun.filled, unfilled: fun.unfilled, dead: Object.entries(fun.dead).sort((x, y) => y[1] - x[1]).slice(0, 6).map(x => ({ reason: x[0], count: x[1] })) } };
        }
        // LOT AUTO : le robot calcule le lot pour risquer `risk` $ avec le SL réel (XAUUSD : 1 lot = 100 oz → 0.01 lot = 1 $ par 1 $ de mouvement = 10 pips). Pas de 0.01 lot, minimum 0.01.
        const riskUsd = P.risk || 10, addMoney = t => {
          const slUsd = t.slUsd || 0, lot = slUsd > 0 ? Math.max(0.01, Math.floor(riskUsd / (slUsd * 100) / 0.01 + 1e-9) * 0.01) : 0.01, real = lot * slUsd * 100;
          t.slPips = Math.round(slUsd * 10 * 10) / 10; t.lot = Math.round(lot * 100) / 100; t.riskUsd = Math.round(real * 100) / 100; t.pnlUsd = Math.round(t.R * real * 100) / 100;
        };
        all.forEach(addMoney); for (const mod of ['A']) { modules[mod].trades.forEach(addMoney); }
        const sumUsd = arr => Math.round(arr.reduce((a, t) => a + (t.pnlUsd || 0), 0) * 100) / 100;
        for (const mod of ['A']) modules[mod].pnlUsd = sumUsd(all.filter(t => t.module === mod));
        all.sort((x, y) => x.t - y.t);
        const rrs = all.map(t => t.rrTot).filter(x => x != null);
        job.result = { modules, total: Object.assign(strip(e.btSummary(all, period)), { pnlUsd: sumUsd(all), riskUsd, outcomes: outcomes(all), rrAvg: rrs.length ? Math.round(rrs.reduce((a, x) => a + x, 0) / rrs.length * 100) / 100 : null }), data: info, ltf: 'M1 / M2 / M3', contre: lk.dropped, errors: errs.count ? { count: errs.count, first: errs.first } : null };
        job.status = 'done'; job.progress = 1; job.phase = 'terminé';
      } catch (x) { job.status = 'error'; job.error = String(x && x.message || x).slice(0, 300); }
      job.endedAt = Date.now();
    })();
  }
  const sanExclude = x => {   // retraits demandés pour CE backtest (setups / paires / sens / heures UTC / confirmations)
    if (!x || typeof x !== 'object') return null;
    const arr = a => (Array.isArray(a) ? a : []).slice(0, 60);
    return { setups: arr(x.setups).map(String), pairs: arr(x.pairs).map(v => String(v).toUpperCase()), sens: arr(x.sens).map(v => String(v).toUpperCase()), hours: arr(x.hours).map(Number).filter(h => h >= 0 && h < 24), parts: arr(x.parts).map(String), factors: arr(x.factors).map(String) };
  };
  router.post('/api/mentor/backtest', writeLimit, auth, json, safe(async req => {
    const b = req.body || {}, uid = req.user.userId, mode = String(b.mode || '').toUpperCase();
    if (!BT_MODE_TFS[mode]) return { ok: false, error: 'mode : DAYTRADE' };
    for (const [id, j] of btJobs) if (Date.now() - (j.endedAt || j.startedAt) > 3600000) btJobs.delete(id);
    const running = Array.from(btJobs.values()).find(j => j.user === uid && j.status === 'running');
    if (running) return { ok: true, id: running.id, already: true };
    const day = x => /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? Date.parse(x + 'T00:00:00Z') : NaN;
    const from = day(b.from), toDay = day(b.to), now = Date.now();
    if (!isFinite(from) || !isFinite(toDay)) return { ok: false, error: 'dates invalides (AAAA-MM-JJ)' };
    const to = Math.min(toDay + 86400000, now);
    if (to <= from) return { ok: false, error: 'la date de fin doit être après la date de début' };
    if (to - from > BT_MAX_DAYS[mode] * 86400000) return { ok: false, error: `période trop longue pour ${mode} : maximum ${BT_MAX_DAYS[mode]} jours` };
    const sess = manager.session(uid);
    if (!sess || sess.status !== 'CONNECTED') return { ok: false, error: 'cTrader doit être CONNECTÉ pour télécharger l\'historique' };
    const e = E(req), cfg = e.getConfig();
    let symbols = Array.isArray(b.symbols) ? b.symbols.map(s => String(s).toUpperCase()).filter(s => /^[A-Z]{3,12}$/.test(s)) : [];
    const DAY_OK = ['XAUUSD'];
    if (mode === 'DAYTRADE') symbols = symbols.filter(s => DAY_OK.includes(s));   // GOLD MENTOR : or uniquement
    if (!symbols.length) symbols = mode === 'DAYTRADE' ? DAY_OK.slice() : (cfg.modes[mode].symbols || cfg.symbolsAllowed || ['XAUUSD']).slice();
    symbols = Array.from(new Set(symbols)).filter(s => sess.specs && sess.specs[s]).slice(0, 6);
    if (!symbols.length) return { ok: false, error: 'aucune paire disponible chez le broker pour ce mode' };
    const spreadEq = finite(b.spreadEq) && +b.spreadEq > 0 ? Math.min(10, +b.spreadEq) : undefined;   // vide = spread réaliste PAR PAIRE (or 2.5, EURUSD 0.5, GBPUSD 0.8, USDJPY 0.6 pts-or)
    const ltf = null;   // module B : M1 + M2 + M3 évalués ensemble (un seul backtest)
    const job = { id: crypto.randomBytes(6).toString('hex'), user: uid, status: 'running', progress: 0, phase: 'démarrage', startedAt: Date.now(), params: { mode, from, to, ltf, spreadEq, symbols, risk: finite(b.risk) && +b.risk > 0 ? Math.min(100000, +b.risk) : 10, tp1R: finite(b.tp1R) && +b.tp1R >= 0 && +b.tp1R <= 5 ? +b.tp1R : 1.2, trend: b.trend !== false && b.trend !== 0 && b.trend !== '0', sess: b.sess === 'KZ' ? 'KZ' : 'ALL' } };
    btJobs.set(job.id, job); btRun(job, e, sess);
    return { ok: true, id: job.id };
  }));
  router.get('/api/mentor/backtest/:id', readLimit, auth, safe(req => {
    const j = btJobs.get(String(req.params.id));
    if (!j || j.user !== req.user.userId) return { ok: false, error: 'backtest introuvable (expiré ?)' };
    return { ok: true, status: j.status, progress: j.progress, phase: j.phase, error: j.error || null, params: j.params, result: j.status === 'done' ? j.result : null };
  }));

  // ---------- cTrader : autorisation OAuth + compte ----------
  router.get('/api/ctrader/status', readLimit, auth, safe(req => Object.assign({ ok: true, configured: manager.oauth.configured(), tokenStorage: manager.tokens.keyConfigured ? manager.tokens.keyConfigured() : manager.tokens.available() }, manager.sessionStatus(req.user.userId))));
  router.get('/api/ctrader/connect-url', authLimit, auth, safe(async req => {
    if (!(manager.tokens.keyConfigured ? manager.tokens.keyConfigured() : manager.tokens.available())) throw new Error('TOKEN_ENCRYPTION_KEY non configurée sur le serveur (≥ 16 caractères)');
    if (process.env.CTRADER_ACCESS_TOKEN) {   // jeton Playground fourni : pas d'OAuth
      await manager.seedFromEnv(req.user.userId);
      const b = process.env.CTRADER_POST_CONNECT_URL || '/';
      return { ok: true, url: b + (b.includes('?') ? '&' : '?') + 'ctrader=ok' };
    }
    return { ok: true, url: manager.oauth.buildAuthUrl(req.user.userId, 'trading') };
  }));
  router.get('/api/ctrader/callback', authLimit, async (req, res) => {   // redirection navigateur depuis id.ctrader.com : protégée par le « state » à usage unique
    const back = process.env.CTRADER_POST_CONNECT_URL || '/';
    try {
      if (!req.query.code) throw new Error('code d\'autorisation absent');
      await manager.handleCallback(String(req.query.code), req.query.state ? String(req.query.state) : '', process.env.CTRADER_SINGLE_USER_FALLBACK === '1' ? OWNER : null);
      res.redirect(back + (back.includes('?') ? '&' : '?') + 'ctrader=ok');
    } catch (e) { console.error('[ctrader] callback:', String((e && e.message) || e).slice(0, 300)); const why = encodeURIComponent(String((e && e.message) || e).replace(/(client_secret|code|token)=[^&\s]+/gi, '$1=***').slice(0, 400)); res.redirect(back + (back.includes('?') ? '&' : '?') + 'ctrader=error&reason=' + why); }
  });
  router.post('/api/ctrader/account', writeLimit, auth, json, safe(async req => {
    const id = String(req.body && req.body.accountId || ''); if (!/^\d{1,18}$/.test(id)) throw new Error('accountId invalide');
    return Object.assign({ ok: true }, await manager.session(req.user.userId).selectAccount(id));
  }));
  router.post('/api/ctrader/reconnect', writeLimit, auth, json, safe(async req => { if (process.env.CTRADER_ACCESS_TOKEN) { await manager.seedFromEnv(req.user.userId); return { ok: true }; } await manager.session(req.user.userId).stop(); await manager.session(req.user.userId).start(); return Object.assign({ ok: true }, manager.sessionStatus(req.user.userId)); }));
  router.post('/api/ctrader/close-all', writeLimit, auth, json, safe(req => manager.closeAll(req.user.userId, 'demande utilisateur')));
  router.post('/api/ctrader/disconnect', writeLimit, auth, json, safe(req => manager.disconnect(req.user.userId)));

  // ---------- Order Flow (source externe réelle) ----------

  // ---------- Mode de trading (DAYTRADE) — persistant côté serveur (état du moteur de l'utilisateur) ----------
  const modeView = e => { const s = e.status(); return { ok: true, tradingMode: s.tradingMode, combined: s.combined, runningModes: s.runningModes, timeframes: s.timeframes, persisted: true }; };
  router.get('/api/trading-mode', readLimit, auth, safe(req => modeView(E(req))));
  router.post('/api/trading-mode', writeLimit, auth, json, safe(req => {
    const r = E(req).setTradingMode(req.body && (req.body.tradingMode || req.body.mode));
    return r.ok ? modeView(E(req)) : r;
  }));


  // ---------- News partagées (écriture réservée à l'administrateur) ----------
  router.post('/api/mentor/news/events', writeLimit, adminOnly, json, safe(req => { const ev = Array.isArray(req.body) ? req.body : (req.body && req.body.events) || []; manager.broadcastNews(ev.slice(0, 200)); return { ok: true, count: ev.length }; }));

  // ---------- Admin ----------
  router.get('/api/admin/overview', readLimit, adminOnly, safe(() => ({ ok: true, users: manager.overview().map(u => Object.assign(u, { suspended: admin.suspended.includes(u.userId) })), suspended: admin.suspended, limits: admin.limits, orderFlow: {}, serverTime: new Date().toISOString() })));
  router.get('/api/admin/user/:id/logs', readLimit, adminOnly, safe(req => { if (!USER_RE.test(req.params.id)) throw new Error('userId invalide'); return { ok: true, logs: manager.engine(req.params.id).logs(Math.min(+req.query.n || 100, 500)) }; }));
  router.post('/api/admin/user/:id/suspend', writeLimit, adminOnly, json, safe(async req => {
    const u = req.params.id; if (!USER_RE.test(u)) throw new Error('userId invalide');
    if (!admin.suspended.includes(u)) admin.suspended.push(u); saveAdmin();
    manager.engine(u).setAutoTrade(false); return Object.assign({ ok: true, suspended: true }, await manager.emergencyStop(u, 'suspendu par l\'administrateur'));
  }));
  router.post('/api/admin/user/:id/unsuspend', writeLimit, adminOnly, json, safe(req => { const u = req.params.id; admin.suspended = admin.suspended.filter(x => x !== u); saveAdmin(); manager.engine(u).setBlock(null); return { ok: true, suspended: false }; }));
  router.post('/api/admin/user/:id/autotrade-off', writeLimit, adminOnly, json, safe(req => manager.engine(req.params.id).setAutoTrade(false)));
  router.post('/api/admin/emergency-stop', writeLimit, adminOnly, json, safe(async () => ({ ok: true, users: await manager.emergencyStopAll('arrêt d\'urgence administrateur') })));
  router.post('/api/admin/limits', writeLimit, adminOnly, json, safe(req => {
    const b = req.body || {};
    if (finite(b.maxRiskPct)) admin.limits.maxRiskPct = clamp(Number(b.maxRiskPct), 0.05, 100);
    if (finite(b.maxDrawdownPct)) admin.limits.maxDrawdownPct = clamp(Number(b.maxDrawdownPct), 1, 100);
    if (typeof b.liveAllowed === 'boolean') admin.limits.liveAllowed = b.liveAllowed;
    saveAdmin(); return { ok: true, limits: admin.limits };
  }));

  // ---------- pompe NEWS : feed réel -> moteurs (aucune donnée inventée) ----------
  let newsTimer = null;
  function pumpNews() {
    if (!news) return;
    try {
      const st = news.status();
      if (!st.available) return;   // UNAVAILABLE : rien n'est envoyé ; le moteur reste en DATA_UNAVAILABLE (règle news.requireData)
      try { fundamental.setContext(news.calendar({ now: Date.now(), currency: 'USD', impacts: 'high,medium', days: 2, pastHours: 168 })); } catch (e) { /* contexte indisponible : l'analyse reste possible sur les chiffres de l'événement */ }
      const events = news.upcoming(Date.now());
      if (events.length) manager.broadcastNews(events);
      manager.heartbeatNews(st.fetchedAt);   // heure du dernier SUCCÈS du flux : le moteur mesure lui-même la péremption
    } catch (e) { console.error('[news] pompe:', e && e.message); }
  }

  // ---------- boucle 1 s ----------
  let timer = null, busy = false;
  function start() {
    if (timer) return;
    manager.get(OWNER);   // l'utilisateur propriétaire existe toujours
    if (news) {
      try { news.start(); } catch (e) { console.warn('[news] démarrage:', e && e.message); }
      const first = setTimeout(pumpNews, 4000); if (first.unref) first.unref();
      newsTimer = setInterval(pumpNews, 15000); if (newsTimer.unref) newsTimer.unref();
    }
    if (orderFlow && orderFlow.start) orderFlow.start();   // interroge les sources HTTP configurées (BOOKMAP_API_URL / EXOCHARTS_API_URL)
    manager.startAll().catch(e => console.error('[ctrader] startAll:', manager.oauth.redact(e && e.message)));
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await manager.tickAll(); } catch (e) { console.error('[mentor] tick:', e && e.message); }
      busy = false;
    }, 1000);
    if (timer.unref) timer.unref();
    console.log('[mentor] IA Mentor démarré (multi-utilisateur, cTrader uniquement)');
  }
  function stop() {
    if (timer) clearInterval(timer); timer = null;
    if (newsTimer) clearInterval(newsTimer); newsTimer = null;
    if (news && typeof news.stop === 'function') news.stop();
    if (orderFlow && orderFlow.stop) orderFlow.stop();
  }

  return { router, manager, engine: manager.engine(OWNER), orderFlow, news, pumpNews, start, stop, _admin: () => admin };
};
