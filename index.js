'use strict';
/**
 * API du robot SMC + connexion cTrader.
 *   /api/smc/*      : robot (état, activer, réglages, annuler, backtest)
 *   /api/ctrader/*  : connexion cTrader (OAuth), compte, déconnexion
 * Authentification : en-tête x-api-key = MENTOR_API_KEY (ou ADMIN_API_KEY).
 */
const crypto = require('crypto');
const path = require('path');
const { createManager } = require('./ctrader/manager');
const createSmc = require('./smc-bot');
const createEngineLite = require('./engine-lite');
const { USER_RE } = require('./ctrader/token-store');

module.exports = function createApp(express, opts = {}) {
  const dataRoot = opts.dataRoot || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const manager = opts.manager || createManager({ dataRoot, orderFlow: null, engineFactory: createEngineLite, WebSocketImpl: opts.WebSocketImpl });
  const smc = createSmc({ manager, dataRoot });
  const router = express.Router(), json = express.json({ limit: '64kb' });
  const OWNER = USER_RE.test(process.env.OWNER_USER_ID || '') ? process.env.OWNER_USER_ID : 'owner';

  const eq = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };
  const keyOf = req => req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const resolveUser = req => {
    const k = keyOf(req);
    if (process.env.ADMIN_API_KEY && eq(k, process.env.ADMIN_API_KEY)) return { userId: OWNER, role: 'admin' };
    if (process.env.MENTOR_API_KEY && eq(k, process.env.MENTOR_API_KEY)) return { userId: OWNER, role: 'user' };
    return null;
  };
  const auth = (req, res, next) => { const u = resolveUser(req); if (!u) return res.status(401).json({ ok: false, error: 'authentification requise' }); req.user = u; next(); };
  const hits = new Map();
  const limiter = (max, windowMs = 60000) => (req, res, next) => {
    const k = (req.ip || '') + '|' + (req.baseUrl || '') + (req.route && req.route.path || ''), t = Date.now(), h = (hits.get(k) || []).filter(x => t - x < windowMs);
    if (h.length >= max) return res.status(429).json({ ok: false, error: 'trop de requêtes, réessayez plus tard' });
    h.push(t); hits.set(k, h); if (hits.size > 5000) for (const [kk, vv] of hits) if (!vv.length || t - vv[vv.length - 1] > windowMs) hits.delete(kk);
    next();
  };
  const readLimit = limiter(300), writeLimit = limiter(60), authLimit = limiter(20);
  const safe = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) { console.error('[api]', req.method, req.path, e && e.message); res.status(500).json({ ok: false, error: String(e && e.message || e).replace(/(access|refresh)[_-]?token[^,;]*/gi, '[redacted]').slice(0, 300) }); }
  };
  router.use(['/api/smc', '/api/ctrader'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.MENTOR_CORS_ORIGIN) { res.set('Access-Control-Allow-Origin', process.env.MENTOR_CORS_ORIGIN); res.set('Access-Control-Allow-Headers', 'x-api-key, authorization, content-type'); res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  /* ---------- robot SMC ---------- */
  const U = req => smc.get(req.user.userId);
  router.get('/api/smc/status', readLimit, auth, safe(req => U(req).status()));
  router.post('/api/smc/active', writeLimit, auth, json, safe(req => U(req).setActive(!!(req.body && req.body.active === true))));
  router.post('/api/smc/config', writeLimit, auth, json, safe(req => U(req).setConfig(req.body)));
  router.post('/api/smc/cancel', writeLimit, auth, json, safe(req => U(req).cancel(req.body && req.body.symbol)));
  router.post('/api/smc/close-all', writeLimit, auth, json, safe(req => U(req).closeAll('clôture manuelle')));
  router.post('/api/smc/emergency', writeLimit, auth, json, safe(async req => { await smc.emergencyStop(req.user.userId); return manager.emergencyStop(req.user.userId); }));
  router.post('/api/smc/reset-stats', writeLimit, auth, json, safe(req => U(req).resetStats()));
  router.post('/api/smc/backtest', writeLimit, auth, json, safe(req => U(req).backtestStart(req.body)));
  router.get('/api/smc/backtest/:id', readLimit, auth, safe(req => U(req).backtestGet(req.params.id)));

  /* ---------- cTrader ---------- */
  router.get('/api/ctrader/status', readLimit, auth, safe(req => Object.assign({ ok: true, configured: manager.oauth.configured(), tokenStorage: manager.tokens.keyConfigured ? manager.tokens.keyConfigured() : manager.tokens.available() }, manager.sessionStatus(req.user.userId))));
  router.get('/api/ctrader/connect-url', authLimit, auth, safe(async req => {
    if (!(manager.tokens.keyConfigured ? manager.tokens.keyConfigured() : manager.tokens.available())) throw new Error('TOKEN_ENCRYPTION_KEY non configurée sur le serveur (≥ 16 caractères)');
    if (process.env.CTRADER_ACCESS_TOKEN) { await manager.seedFromEnv(req.user.userId); const b = process.env.CTRADER_POST_CONNECT_URL || '/'; return { ok: true, url: b + (b.includes('?') ? '&' : '?') + 'ctrader=ok' }; }
    return { ok: true, url: manager.oauth.buildAuthUrl(req.user.userId, 'trading') };
  }));
  router.get('/api/ctrader/callback', authLimit, async (req, res) => {   // redirection navigateur depuis id.ctrader.com (protégée par le « state » à usage unique)
    const back = process.env.CTRADER_POST_CONNECT_URL || '/', sep = back.includes('?') ? '&' : '?';
    try {
      if (!req.query.code) throw new Error('code d\'autorisation absent');
      await manager.handleCallback(String(req.query.code), req.query.state ? String(req.query.state) : '', process.env.CTRADER_SINGLE_USER_FALLBACK === '1' ? OWNER : null);
      res.redirect(back + sep + 'ctrader=ok');
    } catch (e) { console.error('[ctrader] callback:', String((e && e.message) || e).slice(0, 300)); res.redirect(back + sep + 'ctrader=error&reason=' + encodeURIComponent(String((e && e.message) || e).replace(/(client_secret|code|token)=[^&\s]+/gi, '$1=***').slice(0, 400))); }
  });
  router.post('/api/ctrader/account', writeLimit, auth, json, safe(async req => {
    const id = String(req.body && req.body.accountId || ''); if (!/^\d{1,18}$/.test(id)) throw new Error('accountId invalide');
    return Object.assign({ ok: true }, await manager.session(req.user.userId).selectAccount(id));
  }));
  router.post('/api/ctrader/reconnect', writeLimit, auth, json, safe(async req => {
    if (process.env.CTRADER_ACCESS_TOKEN) { await manager.seedFromEnv(req.user.userId); return { ok: true }; }
    await manager.session(req.user.userId).stop(); await manager.session(req.user.userId).start(); return Object.assign({ ok: true }, manager.sessionStatus(req.user.userId));
  }));
  router.post('/api/ctrader/disconnect', writeLimit, auth, json, safe(req => manager.disconnect(req.user.userId)));

  /* ---------- démarrage ---------- */
  let timer = null, busy = false;
  function start() {
    if (timer) return;
    manager.get(OWNER); smc.start([OWNER]);
    manager.startAll().catch(e => console.error('[ctrader] startAll:', manager.oauth.redact(e && e.message)));
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await manager.tickAll(); } catch (e) { console.error('[ctrader] tick:', e && e.message); }
      try { await smc.tickAll(); } catch (e) { console.error('[smc] tick:', e && e.message); }
      busy = false;
    }, 1000);
    if (timer.unref) timer.unref();
    console.log('[smc] robot SMC démarré (cTrader)');
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { router, manager, smc, start, stop };
};
