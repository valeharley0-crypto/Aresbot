'use strict';
/* broker-feed.js — reçoit les données RÉELLES du compte MT5 (envoyées par l'EA) et les sert à la page.
   Ajout dans server.js (une seule ligne, après app.use(robot.router);) :
       require('./broker-feed')(app);
   Variables Render déjà utilisées : EA_TOKEN (écriture par l'EA) et MENTOR_API_KEY (lecture par la page). */
const crypto = require('crypto');

module.exports = function (app) {
  const EA_TOKEN = process.env.EA_TOKEN || '';
  const READ_KEY = process.env.MENTOR_API_KEY || '';
  const state = { account: null, quotes: {}, positions: [], deals: [], updatedAt: null };

  const eq = (a, b) => {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  };

  app.post('/api/v1/report', (req, res) => {
    if (!EA_TOKEN || !eq(req.get('x-ea-token'), EA_TOKEN)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const b = req.body || {};
    if (b.account && typeof b.account === 'object') state.account = b.account;
    if (Array.isArray(b.quotes)) {
      const q = {};
      b.quotes.slice(0, 20).forEach(x => { if (x && x.s) q[String(x.s)] = { bid: Number(x.b), ask: Number(x.a) }; });
      state.quotes = q;
    }
    if (Array.isArray(b.positions)) state.positions = b.positions.slice(0, 50);
    if (Array.isArray(b.deals)) state.deals = b.deals.slice(0, 200);
    state.updatedAt = Date.now();
    res.json({ ok: true });
  });

  app.get('/api/broker/state', (req, res) => {
    if (!READ_KEY || !eq(req.get('x-api-key'), READ_KEY)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, serverTime: Date.now(), ...state });
  });
};
