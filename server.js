'use strict';
/**
 * Serveur du robot SMC (Express) : API (index.js) + site (index.html).
 * Variables d'environnement (Render) : MENTOR_API_KEY, TOKEN_ENCRYPTION_KEY, CTRADER_CLIENT_ID, CTRADER_CLIENT_SECRET, CTRADER_REDIRECT_URI,
 * (facultatif) DATA_DIR = dossier persistant, ADMIN_API_KEY, OWNER_USER_ID, PORT.
 */
const express = require('express');
const path = require('path');

/* Charge .env (local) sans dépendance ; les variables déjà définies (Render) sont prioritaires. */
try {
  const envFile = path.join(__dirname, '.env');
  if (require('fs').existsSync(envFile)) {
    for (const line of require('fs').readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    }
  }
} catch (_) { /* ignore */ }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Frame-Options', 'SAMEORIGIN'); next(); });
app.use(express.json({ limit: '64kb' }));
const PORT = Number(process.env.PORT || 8080);
process.on('unhandledRejection', reason => { console.error('[process] promesse rejetée non gérée:', reason && reason.message ? reason.message : reason); });

let bot = null;
try {
  bot = require('./index.js')(express);
  app.use(bot.router);
  bot.start();
  console.log('[smc] chargé');
} catch (error) { bot = null; console.error('[smc] non chargé:', error && error.message); }

app.get('/', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(__dirname, 'index.html'), err => { if (err && !res.headersSent) res.status(500).type('text/plain').send('index.html introuvable'); }); });
app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/health', (req, res) => res.json({ ok: true, service: 'smc-bot', loaded: !!bot, ctrader: {
  configured: !!(process.env.CTRADER_CLIENT_ID && process.env.CTRADER_CLIENT_SECRET && process.env.CTRADER_REDIRECT_URI),
  tokenStorage: !!(process.env.TOKEN_ENCRYPTION_KEY && String(process.env.TOKEN_ENCRYPTION_KEY).length >= 16) } }));
app.use('/api', (req, res) => res.status(bot ? 404 : 503).json({ ok: false, error: bot ? 'route inconnue' : 'robot non chargé sur le serveur', path: req.path }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && (err.status || err.statusCode) ? err.status || err.statusCode : 500, bodyError = err && err.type === 'entity.parse.failed';
  if (status >= 500) console.error('[server]', err && err.message);
  return res.status(bodyError ? 400 : status).json({ ok: false, error: bodyError ? 'JSON invalide' : status === 413 ? 'corps trop volumineux' : 'erreur serveur' });
});

const server = app.listen(PORT, () => { const a = server.address(); console.log('Serveur SMC à l\'écoute sur le port ' + (a && typeof a === 'object' ? a.port : PORT)); });
server.on('error', error => { console.error('[server] démarrage impossible:', error && error.message); process.exit(1); });
function shutdown(signalName) {
  console.log('[server] ' + signalName + ' reçu : arrêt propre');
  try { if (bot && bot.stop) bot.stop(); } catch (e) { /* ignore */ }
  const done = () => process.exit(0);
  Promise.resolve(bot && bot.manager && typeof bot.manager.stopAll === 'function' ? bot.manager.stopAll() : null).catch(() => {}).then(() => server.close(done));
  setTimeout(done, 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
