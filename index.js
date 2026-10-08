'use strict';
/**
 * ARES — IA MENTOR : routes API (Auth · cTrader · IA Engine · Order Flow · News · Risk · Journal · Admin) + boucle 1 s.
 * Utilisation dans server.js :
 *   const mentor = require('./index.js')(express);  app.use(mentor.router);  mentor.start();
 *
 * Variables d'environnement : voir .env.example (aucun secret n'est jamais envoyé au frontend ni écrit dans les logs).
 * Authentification (Dingana 1) : clé d'API MENTOR_API_KEY -> utilisateur OWNER_USER_ID ; ADMIN_API_KEY -> administrateur.
 * Un résolveur plus riche (comptes + JWT) se branche via opts.resolveUser(req) -> { userId, role } sans toucher aux routes.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createManager } = require('./ctrader/manager');
const { OrderFlowHub } = require('./providers/providers');
const { USER_RE } = require('./ctrader/token-store');

module.exports = function createMentor(express, opts = {}) {
  const dataRoot = opts.dataRoot || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const orderFlow = opts.orderFlow || new OrderFlowHub({ maxAgeSec: Number(process.env.ORDERFLOW_MAX_AGE_SEC) || 30 });
  const manager = opts.manager || createManager({ dataRoot, orderFlow, WebSocketImpl: opts.WebSocketImpl });
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
    if (['SCALPING', 'SWING'].includes(String(src.tradingMode).toUpperCase())) out.tradingMode = String(src.tradingMode).toUpperCase();
    bool(src, out, 'autoTrade');
    if (typeof src.liveExecution === 'boolean') out.liveExecution = src.liveExecution && G.liveAllowed;
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
      num(o, d, 'minScore', 0, 20); num(o, d, 'minComponents', 1, 7);
      if (o.weights && typeof o.weights === 'object') { d.weights = {}; for (const k of ['structure', 'mtf', 'trigger', 'sweep', 'zone', 'premiumDiscount', 'orderFlow']) num(o.weights, d.weights, k, 0, 10); }
      if (o.orderFlow && typeof o.orderFlow === 'object') { d.orderFlow = {}; bool(o.orderFlow, d.orderFlow, 'enabled'); bool(o.orderFlow, d.orderFlow, 'requireWhenEnabled'); }
    });
    sub('news', (o, d) => { bool(o, d, 'enabled'); bool(o, d, 'autoTrade'); bool(o, d, 'requireData'); });
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
  router.get('/api/mentor/status', readLimit, auth, safe(req => Object.assign(E(req).status(), { user: req.user.userId, suspended: admin.suspended.includes(req.user.userId), ctrader: manager.sessionStatus(req.user.userId), orderFlow: orderFlow.status() })));
  router.get('/api/mentor/signal', readLimit, auth, safe(req => ({ ok: true, decision: E(req).status().decision, trades: E(req).trades(10) })));
  router.get('/api/mentor/risk', readLimit, auth, safe(req => E(req).risk()));
  router.get('/api/mentor/trades', readLimit, auth, safe(req => ({ ok: true, trades: E(req).trades(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/journal', readLimit, auth, safe(req => ({ ok: true, journal: E(req).journal(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/news', readLimit, auth, safe(req => Object.assign({ ok: true }, E(req).news(), { events: E(req).newsEvents() })));
  router.get('/api/prop/status', readLimit, auth, safe(req => Object.assign({ ok: true }, E(req).propStatus())));
  router.get('/api/mentor/log', readLimit, auth, safe(req => ({ ok: true, logs: E(req).logs(Math.min(+req.query.n || 100, 500)) })));
  router.get('/api/mentor/config', readLimit, auth, safe(req => ({ ok: true, config: E(req).getConfig(), limits: admin.limits })));

  // ---------- IA Mentor : écriture (par utilisateur) ----------
  router.post('/api/signal', writeLimit, auth, json, async (req, res) => {
    const err = validSignal(req.body); if (err) return reject(res, err);
    await safe(r => E(r).submitSignal(req.body, 'NORMAL'))(req, res);
  });
  router.post('/api/mentor/config', writeLimit, auth, json, safe(req => ({ ok: true, config: E(req).setConfig(sanitizeConfig(req.body)) })));
  router.post('/api/mentor/mode', writeLimit, auth, json, safe(req => E(req).setTradingMode(req.body && req.body.tradingMode)));
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

  // ---------- cTrader : autorisation OAuth + compte ----------
  router.get('/api/ctrader/status', readLimit, auth, safe(req => Object.assign({ ok: true, configured: manager.oauth.configured(), tokenStorage: manager.tokens.available() }, manager.sessionStatus(req.user.userId))));
  router.get('/api/ctrader/connect-url', authLimit, auth, safe(req => {
    if (!manager.tokens.available()) throw new Error('TOKEN_ENCRYPTION_KEY non configurée sur le serveur');
    return { ok: true, url: manager.oauth.buildAuthUrl(req.user.userId, 'trading') };
  }));
  router.get('/api/ctrader/callback', authLimit, async (req, res) => {   // redirection navigateur depuis id.ctrader.com : protégée par le « state » à usage unique
    const back = process.env.CTRADER_POST_CONNECT_URL || '/';
    try {
      if (!req.query.code) throw new Error('code d\'autorisation absent');
      await manager.handleCallback(String(req.query.code), req.query.state ? String(req.query.state) : '', process.env.CTRADER_SINGLE_USER_FALLBACK === '1' ? OWNER : null);
      res.redirect(back + (back.includes('?') ? '&' : '?') + 'ctrader=ok');
    } catch (e) { console.error('[ctrader] callback:', manager.oauth.redact(e && e.message)); res.redirect(back + (back.includes('?') ? '&' : '?') + 'ctrader=error'); }
  });
  router.post('/api/ctrader/account', writeLimit, auth, json, safe(async req => {
    const id = String(req.body && req.body.accountId || ''); if (!/^\d{1,18}$/.test(id)) throw new Error('accountId invalide');
    return Object.assign({ ok: true }, await manager.session(req.user.userId).selectAccount(id));
  }));
  router.post('/api/ctrader/reconnect', writeLimit, auth, json, safe(async req => { await manager.session(req.user.userId).stop(); await manager.session(req.user.userId).start(); return Object.assign({ ok: true }, manager.sessionStatus(req.user.userId)); }));
  router.post('/api/ctrader/disconnect', writeLimit, auth, json, safe(req => manager.disconnect(req.user.userId)));

  // ---------- Order Flow (source externe réelle) ----------
  router.post('/api/orderflow/push', limiter(600), json, (req, res) => {
    const expected = process.env.ORDERFLOW_PUSH_KEY;
    if (!expected) return res.status(503).json({ ok: false, error: 'ORDERFLOW_PUSH_KEY non configurée' });
    if (!eq(keyOf(req), expected)) return res.status(401).json({ ok: false, error: 'clé invalide' });
    try { res.json(orderFlow.push(req.body || {})); } catch (e) { reject(res, String(e.message)); }
  });
  router.get('/api/orderflow/status', readLimit, auth, safe(() => Object.assign({ ok: true }, orderFlow.status())));

  // ---------- Mode de trading (SCALPING / SWING) — persistant côté serveur (état du moteur de l'utilisateur) ----------
  const modeView = e => { const s = e.status(); return { ok: true, tradingMode: s.tradingMode, timeframes: s.timeframes, persisted: true }; };
  router.get('/api/trading-mode', readLimit, auth, safe(req => modeView(E(req))));
  router.post('/api/trading-mode', writeLimit, auth, json, safe(req => {
    const r = E(req).setTradingMode(req.body && (req.body.tradingMode || req.body.mode));
    return r.ok ? modeView(E(req)) : r;
  }));

  // ---------- Bookmap / Exocharts : données RÉELLES uniquement (jamais de simulation) ----------
  for (const id of ['bookmap', 'exocharts']) {
    router.get('/api/' + id + '/status', readLimit, auth, safe(() => Object.assign({ ok: true }, orderFlow.source(id).status())));
    router.get('/api/' + id + '/data', readLimit, auth, safe(req => {
      const sym = String(req.query.symbol || E(req).getConfig().symbol || 'XAUUSD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
      const src = orderFlow.source(id), st = src.status(), d = src.get(sym);
      const available = d.status === 'AVAILABLE' || d.status === 'STALE';
      const data = available ? Object.fromEntries(Object.entries(d).filter(([k]) => !['status', 'source', 'ts', 'ageSec'].includes(k))) : null;
      return { ok: true, source: id, symbol: sym, connection: st.connection, status: d.status, data, ts: d.ts ? new Date(d.ts).toISOString() : null, ageSec: d.ageSec != null ? d.ageSec : null,
        message: available ? (d.status === 'STALE' ? 'DATA STALE : donnée trop ancienne, ignorée par l\'IA' : 'Données réelles') : `${src.label} : NOT CONNECTED · DATA UNAVAILABLE. Connect a supported ${src.label} data source.` };
    }));
  }

  // ---------- News partagées (écriture réservée à l'administrateur) ----------
  router.post('/api/mentor/news/events', writeLimit, adminOnly, json, safe(req => { const ev = Array.isArray(req.body) ? req.body : (req.body && req.body.events) || []; manager.broadcastNews(ev.slice(0, 200)); return { ok: true, count: ev.length }; }));

  // ---------- Admin ----------
  router.get('/api/admin/overview', readLimit, adminOnly, safe(() => ({ ok: true, users: manager.overview().map(u => Object.assign(u, { suspended: admin.suspended.includes(u.userId) })), suspended: admin.suspended, limits: admin.limits, orderFlow: orderFlow.status(), serverTime: new Date().toISOString() })));
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

  // ---------- boucle 1 s ----------
  let timer = null, busy = false;
  function start() {
    if (timer) return;
    manager.get(OWNER);   // l'utilisateur propriétaire existe toujours
    if (orderFlow.start) orderFlow.start();   // interroge les sources HTTP configurées (BOOKMAP_API_URL / EXOCHARTS_API_URL)
    manager.startAll().catch(e => console.error('[ctrader] startAll:', manager.oauth.redact(e && e.message)));
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await manager.tickAll(); } catch (e) { console.error('[mentor] tick:', e && e.message); }
      busy = false;
    }, 1000);
    if (timer.unref) timer.unref();
    console.log('[mentor] IA Mentor démarré (multi-utilisateur, cTrader uniquement)');
  }
  function stop() { if (timer) clearInterval(timer); timer = null; if (orderFlow.stop) orderFlow.stop(); }

  return { router, manager, engine: manager.engine(OWNER), orderFlow, start, stop, _admin: () => admin };
};
