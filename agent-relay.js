'use strict';
/* agent-relay.js — le site envoie login / mot de passe / serveur broker à l'agent du VPS.
   - Le mot de passe n'est JAMAIS écrit sur disque, JAMAIS affiché, JAMAIS renvoyé au navigateur ni loggué.
   - Il reste en mémoire au maximum 5 minutes, jusqu'à ce que l'agent (ares_agent.py sur le VPS) le récupère : lecture unique.
   - Envoi protégé par MENTOR_API_KEY ; lecture par l'agent protégée par MT5_BRIDGE_KEY.
   Ajout dans server.js :   require('./agent-relay')(app);   */
const crypto = require('crypto');

module.exports = function (app) {
  let pending = null;                  // { login, password, server, at }
  let status = { state: 'IDLE', login: null, server: null, mode: null, error: '', at: null };
  let lastConnect = 0;

  const eq = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };
  const need = env => (req, res, next) => {
    const expected = process.env[env];
    if (!expected) return res.status(503).json({ ok: false, error: env + ' non configurée' });
    if (!eq(req.get('x-api-key'), expected)) return res.status(401).json({ ok: false, error: 'clé invalide' });
    next();
  };
  const writer = need('MENTOR_API_KEY'), bridge = need('MT5_BRIDGE_KEY');

  app.post('/api/agent/connect', writer, (req, res) => {
    const b = req.body || {};
    const login = String(b.login || '').trim(), server = String(b.server || '').trim(), password = String(b.password || '');
    if (!/^\d{1,12}$/.test(login)) return res.status(400).json({ ok: false, error: 'login invalide (chiffres)' });
    if (!password || password.length > 128) return res.status(400).json({ ok: false, error: 'mot de passe invalide' });
    if (!server || server.length > 80 || /[\r\n]/.test(server)) return res.status(400).json({ ok: false, error: 'serveur invalide' });
    if (Date.now() - lastConnect < 5000) return res.status(429).json({ ok: false, error: 'trop rapide, réessayez' });
    lastConnect = Date.now();
    pending = { login, password, server, at: Date.now() };
    status = { state: 'PENDING', login, server, mode: null, error: '', at: Date.now() };
    res.json({ ok: true, state: 'PENDING' });
  });

  app.get('/api/agent/next', bridge, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (pending && Date.now() - pending.at <= 5 * 60 * 1000) {
      const c = { login: Number(pending.login), password: pending.password, server: pending.server };
      pending = null;                  // lecture unique : le mot de passe disparaît du serveur
      status.state = 'DELIVERED';
      return res.json({ ok: true, command: c });
    }
    pending = null;
    res.json({ ok: true, command: null });
  });

  app.post('/api/agent/ack', bridge, (req, res) => {
    const b = req.body || {};
    status = { state: b.ok ? 'OK' : 'ERROR', login: String(b.login || status.login || ''), server: String(b.server || status.server || ''),
      mode: b.mode ? String(b.mode).slice(0, 10) : null, error: b.ok ? '' : String(b.error || 'échec').slice(0, 200), at: Date.now() };
    res.json({ ok: true });
  });

  app.get('/api/agent/status', writer, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, pending: !!pending, status });
  });
};
