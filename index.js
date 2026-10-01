'use strict';
/**
 * ARES — IA MENTOR : routes API + boucle 1 s.
 * Utilisation dans server.js (2 lignes) :
 *   const mentor = require('./mentor')(express);
 *   app.use(mentor.router); mentor.start();
 *
 * Variables d'environnement (Render) :
 *   MENTOR_API_KEY   clé pour écrire (signal, config, news, block)       — obligatoire pour les routes POST
 *   MT5_BRIDGE_KEY   clé de l'EA MT5 (next / ack / result / account)     — obligatoire pour le pont
 *   TWELVEDATA_API_KEY  (ou TWELVEDATA_KEY) prix réel de secours
 *   MENTOR_CORS_ORIGIN  origine autorisée pour les GET (défaut: *)
 */
const crypto = require('crypto');
const { createEngine } = require('./engine');

module.exports = function createMentor(express, opts = {}) {
  const engine = createEngine(opts);
  const router = express.Router();
  const json = express.json({ limit: '256kb' });

  const eq = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const keyOf = req => req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const needKey = envName => (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) return res.status(503).json({ ok: false, error: `${envName} non configurée sur le serveur` });
    if (!eq(keyOf(req), expected)) return res.status(401).json({ ok: false, error: 'clé invalide' });
    next();
  };
  const writer = needKey('MENTOR_API_KEY');
  const bridge = needKey('MT5_BRIDGE_KEY');

  // CORS en lecture seule pour le frontend existant
  router.use(['/api/mentor', '/api/prop'], (req, res, next) => {
    if (req.method === 'GET') {
      res.set('Access-Control-Allow-Origin', process.env.MENTOR_CORS_ORIGIN || '*');
      res.set('Cache-Control', 'no-store');
    }
    next();
  });
  const safe = fn => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(500).json({ ok: false, error: String(e && e.message || e) }); }
  };

  // ----- lecture (frontend) -----
  router.get('/api/mentor/status', safe(() => engine.status()));
  router.get('/api/mentor/signal', safe(() => ({ ok: true, decision: engine.status().decision, trades: engine.trades(10) })));
  router.get('/api/mentor/risk', safe(() => engine.risk()));
  router.get('/api/mentor/news', safe(() => Object.assign({ ok: true }, engine.news(), { events: engine.newsEvents() })));
  router.get('/api/prop/status', safe(() => Object.assign({ ok: true }, engine.propStatus())));
  router.get('/api/mentor/log', safe(req => ({ ok: true, logs: engine.logs(Math.min(+req.query.n || 100, 500)) })));

  // ----- écriture (clé requise) -----
  router.post('/api/signal', writer, json, safe(req => engine.submitSignal(req.body || {}, 'NORMAL')));
  router.get('/api/mentor/config', writer, safe(() => ({ ok: true, config: engine.getConfig() })));
  router.post('/api/mentor/config', writer, json, safe(req => ({ ok: true, config: engine.setConfig(req.body || {}) })));
  router.post('/api/mentor/news/events', writer, json, safe(req => Object.assign({ ok: true }, engine.setNews(Array.isArray(req.body) ? req.body : (req.body && req.body.events) || []))));
  router.post('/api/mentor/active', writer, json, safe(req => engine.setActive(req.body && req.body.active)));
  router.post('/api/mentor/block', writer, json, safe(req => engine.setBlock(req.body && req.body.reason ? String(req.body.reason) : 'Blocage manuel')));
  router.post('/api/mentor/unblock', writer, json, safe(() => engine.setBlock(null)));
  router.post('/api/mentor/trades/:id/close', writer, json, safe(req => engine.manualClose(req.params.id, req.body || {})));

  // ----- pont MT5 (clé EA requise) -----
  router.get('/api/mentor/bridge/next', bridge, safe(() => ({ ok: true, order: engine.bridgeNext() })));
  router.post('/api/mentor/bridge/ack', bridge, json, safe(req => engine.bridgeAck(req.body || {})));
  router.post('/api/mentor/bridge/result', bridge, json, safe(req => engine.bridgeResult(req.body || {})));
  router.post('/api/mentor/bridge/account', bridge, json, safe(req => engine.updateAccount(req.body || {})));

  let timer = null, busy = false;
  function start() {
    if (timer) return;
    timer = setInterval(async () => {
      if (busy) return; busy = true;
      try { await engine.tick(); } catch (e) { console.error('[mentor] tick:', e && e.message); }
      busy = false;
    }, 1000);
    if (timer.unref) timer.unref();
    console.log('[mentor] IA Mentor démarré (liveExecution=' + engine.getConfig().liveExecution + ')');
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { router, engine, start, stop };
};
