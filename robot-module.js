'use strict';
/**
 * ARES ROBOT MODULE — member auth + MT5 auto-trade orchestration (central VPS).
 *
 * Ajoute seulement des routes NOUVELLES. Ne touche jamais :
 *   GET /health · POST /api/v1/webhook · GET /api/v1/signal · POST /api/v1/ack · GET /api/td/:endpoint
 *
 * Montage dans ton serveur Express existant (2 lignes) :
 *   const robot = require('./robot-module')({ express, dataFile: process.env.ROBOT_DATA_FILE || './robot-data.json' });
 *   app.use(robot.router);
 *
 * Après création d'un signal valide (dans ton webhook existant), 1 ligne :
 *   robot.dispatchSignal({ id, symbol:'XAUUSD', dir:'BUY', entry, sl, tp1, tp2, tp3 });
 *
 * Variables d'environnement (secrets côté serveur uniquement, jamais dans GitHub) :
 *   ROBOT_ENC_KEY          64 caractères hex (32 octets)  -> chiffrement AES-256-GCM des mots de passe broker
 *   EA_API_KEY             clé longue aléatoire du worker VPS/EA (header x-ea-key)
 *   ROBOT_ADMIN_EMAIL / ROBOT_ADMIN_PASSWORD   crée l'admin au démarrage s'il n'existe pas
 *   COOKIE_SAMESITE        Lax (défaut) | None (si le front est sur un autre domaine que l'API)
 *   NODE_ENV=production    cookies Secure
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONTRACT_SIZE = 100;          // XAU/USD : 1 lot = 100 oz -> 1$ de mouvement = 100$ / lot
const LOT_STEP = 0.01, LOT_MAX = 50;
const SIGNAL_TTL_MS = 120000;       // un ordre NEW plus vieux que 2 min est annulé (VPS hors ligne, etc.)
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

module.exports = function createRobot(opts) {
  const express = opts.express;
  const env = opts.env || process.env;
  const dataFile = path.resolve(opts.dataFile || './robot-data.json');
  const now = opts.now || (() => Date.now());

  /* ---------------------------------------------------------------- store (JSON atomique) */
  let db = { users: {}, brokers: {}, settings: {}, signals: {}, executions: {}, sessions: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(dataFile, 'utf8'))); } catch (e) { /* premier démarrage */ }
  function save() {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, dataFile);
  }

  /* ---------------------------------------------------------------- crypto */
  function encKey() {
    const k = env.ROBOT_ENC_KEY || '';
    if (!/^[0-9a-fA-F]{64}$/.test(k)) return null;
    return Buffer.from(k, 'hex');
  }
  function encrypt(plain) {
    const key = encKey(); if (!key) throw new Error('ROBOT_ENC_KEY manquante');
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
  }
  function decrypt(blob) {
    const key = encKey(); if (!key) throw new Error('ROBOT_ENC_KEY manquante');
    const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  function hashPassword(pw, salt) {
    salt = salt || crypto.randomBytes(16).toString('hex');
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
  }
  function checkPassword(pw, user) {
    const h = crypto.scryptSync(pw, user.salt, 64), ref = Buffer.from(user.hash, 'hex');
    return h.length === ref.length && crypto.timingSafeEqual(h, ref);
  }
  const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
  const uid = () => crypto.randomBytes(9).toString('hex');

  /* ---------------------------------------------------------------- utilitaires */
  const dayKey = t => new Date(t).toISOString().slice(0, 10);
  const num = v => (typeof v === 'number' ? v : parseFloat(v));
  const round2 = x => Math.round(x * 100) / 100;
  const maskLogin = l => (l ? '••••' + String(l).slice(-3) : '');
  const DEF_SETTINGS = () => ({ risk: 1, autoTrade: false, maxTrades: 3, maxDailyLoss: 3, maxOpen: 1 });

  function getSettings(userId) {
    if (!db.settings[userId]) db.settings[userId] = DEF_SETTINGS();
    return db.settings[userId];
  }
  function getBroker(userId) {
    return db.brokers[userId] || { status: 'DISCONNECTED' };
  }
  function ensureAdmin() {
    const email = (env.ROBOT_ADMIN_EMAIL || '').toLowerCase(), pw = env.ROBOT_ADMIN_PASSWORD;
    if (!email || !pw) return;
    if (Object.values(db.users).some(u => u.email === email)) return;
    const id = uid(), { salt, hash } = hashPassword(pw);
    db.users[id] = { id, email, role: 'ADMIN', salt, hash, active: true, createdAt: now() };
    save();
  }
  ensureAdmin();

  /* ---------------------------------------------------------------- cookies / sessions */
  function parseCookies(req) {
    const out = {}; String(req.headers.cookie || '').split(';').forEach(p => {
      const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    }); return out;
  }
  function setCookie(res, value, maxAgeSec) {
    const same = env.COOKIE_SAMESITE || 'Lax';
    const secure = env.NODE_ENV === 'production' || same === 'None';
    res.setHeader('Set-Cookie', `ares_sid=${value}; Path=/; HttpOnly; SameSite=${same}; Max-Age=${maxAgeSec}` + (secure ? '; Secure' : ''));
  }
  function currentUser(req) {
    const sid = parseCookies(req).ares_sid; if (!sid) return null;
    const s = db.sessions[sid]; if (!s) return null;
    if (s.exp < now()) { delete db.sessions[sid]; return null; }
    const u = db.users[s.uid]; return u && u.active ? u : null;
  }
  const attempts = {};   // anti brute-force en mémoire
  function tooMany(key) { const a = attempts[key]; return a && a.n >= 5 && now() - a.t < 15 * 60000; }
  function noteFail(key) { const a = attempts[key] && now() - attempts[key].t < 15 * 60000 ? attempts[key] : { n: 0 }; a.n++; a.t = now(); attempts[key] = a; }

  const ok = (res, body) => { res.setHeader('Cache-Control', 'no-store'); res.json(Object.assign({ ok: true }, body || {})); };
  const fail = (res, code, msg) => { res.setHeader('Cache-Control', 'no-store'); res.status(code).json({ ok: false, error: msg }); };

  function needJson(req, res, next) {   // bloque les POST "form" cross-site (CSRF de base)
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'JSON requis');
    next();
  }
  function auth(role) {
    return (req, res, next) => {
      const u = currentUser(req); if (!u) return fail(res, 401, 'Non connecté');
      if (role && u.role !== role) return fail(res, 403, 'Accès refusé');
      req.user = u; next();
    };
  }
  function eaAuth(req, res, next) {
    const k = env.EA_API_KEY || '';
    if (k.length < 24 || !safeEq(req.headers['x-ea-key'] || '', k)) return fail(res, 401, 'Clé EA invalide');
    next();
  }

  /* ---------------------------------------------------------------- moteur : signaux -> exécutions */
  function normalizeSignal(s) {
    if (!s || typeof s !== 'object') throw new Error('Signal invalide');
    const dir = String(s.dir || s.direction || '').toUpperCase();
    if (dir !== 'BUY' && dir !== 'SELL') throw new Error('dir doit être BUY ou SELL');
    const entry = num(s.entry), sl = num(s.sl), tp1 = num(s.tp1), tp2 = num(s.tp2), tp3 = num(s.tp3);
    if (![entry, sl, tp1].every(Number.isFinite)) throw new Error('entry, sl et tp1 sont obligatoires');
    if (dir === 'BUY' && !(sl < entry && tp1 > entry)) throw new Error('BUY : sl < entry < tp1');
    if (dir === 'SELL' && !(sl > entry && tp1 < entry)) throw new Error('SELL : tp1 < entry < sl');
    const symbol = String(s.symbol || 'XAUUSD').replace(/[^A-Za-z0-9._]/g, '').slice(0, 12) || 'XAUUSD';
    let id = s.id ? String(s.id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) : '';
    if (!id) {   // id déterministe : le même signal donne toujours le même id (anti-doublon même sans id fourni)
      const h = crypto.createHash('sha1').update([dir, entry, sl, tp1, dayKey(now())].join('|')).digest('hex').slice(0, 6).toUpperCase();
      id = `ARES-XAU-${dayKey(now()).replace(/-/g, '')}-${h}`;
    }
    return { id, symbol, dir, entry, sl, tp1, tp2: Number.isFinite(tp2) ? tp2 : null, tp3: Number.isFinite(tp3) ? tp3 : null };
  }

  function computeLot(balance, riskPct, entry, sl) {
    const dist = Math.abs(entry - sl);
    if (!(balance > 0) || !(dist > 0)) return null;
    const raw = (balance * riskPct / 100) / (dist * CONTRACT_SIZE);
    const lot = Math.floor(raw / LOT_STEP + 1e-9) * LOT_STEP;
    if (lot < LOT_STEP) return 0;       // risque impossible à respecter avec le lot minimum
    return Math.min(round2(lot), LOT_MAX);
  }

  function todayStats(userId, broker) {
    const dk = dayKey(now()); let count = 0, pnl = 0;
    Object.values(db.executions).forEach(e => {
      if (e.userId !== userId || dayKey(e.createdAt) !== dk) return;
      if (e.status === 'SENT' || e.status === 'EXECUTED') count++;
      if (typeof e.profit === 'number') pnl += e.profit;
    });
    if (typeof broker.dailyPnl === 'number' && broker.dayKey === dk) pnl = Math.min(pnl, broker.dailyPnl);
    return { count, pnl };
  }

  function makeExecution(signal, userId, status, message, lot) {
    const key = signal.id + ':' + userId;
    db.executions[key] = {
      id: key, signalId: signal.id, userId, status, message: message || '', lot: lot == null ? null : lot,
      createdAt: now(), updatedAt: now(), ticket: null, price: null, profit: null, result: null
    };
    return db.executions[key];
  }

  /** Idempotent : un même signal id n'est jamais dispatché deux fois. */
  function dispatchSignal(raw) {
    const s = normalizeSignal(raw);
    if (db.signals[s.id]) return { duplicate: true, signalId: s.id, created: 0 };
    db.signals[s.id] = Object.assign({ createdAt: now(), status: 'NEW' }, s);
    const summary = { duplicate: false, signalId: s.id, created: 0, cancelled: 0 };
    Object.values(db.users).forEach(u => {
      if (u.role !== 'MEMBER' || !u.active) return;
      const st = getSettings(u.id), br = getBroker(u.id);
      if (!st.autoTrade) return;                                   // Auto Trade OFF -> aucune exécution
      if (br.status !== 'CONNECTED') return;                       // broker déconnecté -> aucune exécution
      const stats = todayStats(u.id, br);
      let why = null;
      if (stats.count >= st.maxTrades) why = 'Limite : nombre max de trades du jour atteint';
      else if (typeof br.openPositions === 'number' && br.openPositions >= st.maxOpen) why = 'Limite : positions simultanées max atteint';
      else if (br.balance > 0 && stats.pnl <= -(br.balance * st.maxDailyLoss / 100)) why = 'Limite : perte journalière max atteinte';
      if (why) { makeExecution(s, u.id, 'CANCELLED', why); summary.cancelled++; return; }
      const lot = computeLot(br.balance, st.risk, s.entry, s.sl);
      if (lot === null) { makeExecution(s, u.id, 'FAILED', 'Solde du compte inconnu : lot non calculable'); summary.cancelled++; return; }
      if (lot === 0) { makeExecution(s, u.id, 'FAILED', 'Risque trop faible pour le lot minimum (0.01)'); summary.cancelled++; return; }
      makeExecution(s, u.id, 'NEW', '', lot); summary.created++;
    });
    save();
    return summary;
  }

  function expireOld() {
    let ch = false;
    Object.values(db.executions).forEach(e => {
      if (e.status === 'NEW' && now() - e.createdAt > SIGNAL_TTL_MS) { e.status = 'CANCELLED'; e.message = 'Signal expiré (non pris par le VPS à temps)'; e.updatedAt = now(); ch = true; }
    });
    if (ch) save();
  }

  /* ---------------------------------------------------------------- routes */
  const router = express.Router();
  const json = express.json({ limit: '20kb' });     // par route seulement : n'affecte pas tes routes existantes

  // --- Member auth
  router.post('/api/member/login', json, needJson, (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase(), pw = String((req.body && req.body.password) || '');
    const key = (req.ip || '') + '|' + email;
    if (tooMany(key)) return fail(res, 429, 'Trop de tentatives, réessaie dans 15 minutes');
    const u = Object.values(db.users).find(x => x.email === email);
    if (!u || !u.active || !checkPassword(pw, u)) { noteFail(key); return fail(res, 401, 'Identifiants invalides'); }
    delete attempts[key];
    const sid = crypto.randomBytes(32).toString('hex');
    db.sessions[sid] = { uid: u.id, exp: now() + SESSION_TTL_MS }; save();
    setCookie(res, sid, SESSION_TTL_MS / 1000);
    ok(res, { user: { id: u.id, email: u.email, role: u.role } });
  });
  router.post('/api/member/logout', json, needJson, (req, res) => {
    const sid = parseCookies(req).ares_sid; if (sid && db.sessions[sid]) { delete db.sessions[sid]; save(); }
    setCookie(res, '', 0); ok(res);
  });
  router.get('/api/member/me', auth(), (req, res) => ok(res, { user: { id: req.user.id, email: req.user.email, role: req.user.role } }));

  // --- Admin : créer un membre
  router.post('/api/admin/members', json, needJson, auth('ADMIN'), (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase(), pw = String(req.body.password || '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || pw.length < 8) return fail(res, 400, 'Email valide et mot de passe ≥ 8 caractères requis');
    if (Object.values(db.users).some(u => u.email === email)) return fail(res, 409, 'Email déjà utilisé');
    const id = uid(), { salt, hash } = hashPassword(pw);
    db.users[id] = { id, email, role: 'MEMBER', salt, hash, active: true, createdAt: now() }; save();
    ok(res, { user: { id, email, role: 'MEMBER' } });
  });

  // --- Robot (membre : uniquement SES données)
  router.post('/api/robot/connect', json, needJson, auth('MEMBER'), (req, res) => {
    if (!encKey()) return fail(res, 503, 'Serveur non configuré pour stocker les identifiants (ROBOT_ENC_KEY)');
    const login = String(req.body.login || '').trim(), server = String(req.body.server || '').trim(), pw = String(req.body.password || '');
    if (!/^\d{4,12}$/.test(login)) return fail(res, 400, 'Compte MT5 invalide (chiffres uniquement)');
    if (!/^[\w.\-: ]{2,80}$/.test(server)) return fail(res, 400, 'Serveur invalide');
    if (pw.length < 1 || pw.length > 128) return fail(res, 400, 'Mot de passe invalide');
    db.brokers[req.user.id] = {
      broker: 'MT5', login, server, passEnc: encrypt(pw), status: 'CONNECTING',
      balance: null, openPositions: null, dailyPnl: null, lastError: '', requestedAt: now()
    };
    save();
    ok(res, { status: 'CONNECTING', message: 'Vérification du compte par le serveur d\'exécution…' });
  });
  router.post('/api/robot/disconnect', json, needJson, auth('MEMBER'), (req, res) => {
    delete db.brokers[req.user.id];                      // efface les identifiants chiffrés
    getSettings(req.user.id).autoTrade = false; save();
    ok(res, { status: 'DISCONNECTED' });
  });
  router.get('/api/robot/status', auth('MEMBER'), (req, res) => {
    const br = getBroker(req.user.id), st = getSettings(req.user.id);
    const mine = Object.values(db.executions).filter(e => e.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt);
    const lastExec = mine.find(e => e.status === 'EXECUTED' || e.status === 'SENT') || null;
    const lastSig = mine[0] ? db.signals[mine[0].signalId] : null;
    const sig = s => s && { id: s.id, dir: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, time: s.createdAt };
    ok(res, {
      broker: { name: 'MT5', status: br.status, loginMasked: maskLogin(br.login), server: br.server || '', balance: br.balance == null ? null : br.balance, lastError: br.lastError || '' },
      settings: st,
      lastTrade: lastExec && { signalId: lastExec.signalId, status: lastExec.status, lot: lastExec.lot, time: lastExec.updatedAt, dir: db.signals[lastExec.signalId] && db.signals[lastExec.signalId].dir },
      lastSignal: sig(lastSig)
    });
  });
  router.post('/api/robot/settings', json, needJson, auth('MEMBER'), (req, res) => {
    const st = getSettings(req.user.id), b = req.body || {};
    const clamp = (v, lo, hi, def) => { v = num(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def; };
    st.risk = clamp(b.risk, 0.1, 5, st.risk);
    st.maxTrades = Math.round(clamp(b.maxTrades, 1, 20, st.maxTrades));
    st.maxDailyLoss = clamp(b.maxDailyLoss, 0.5, 20, st.maxDailyLoss);
    st.maxOpen = Math.round(clamp(b.maxOpen, 1, 10, st.maxOpen));
    save(); ok(res, { settings: st });
  });
  router.post('/api/robot/toggle', json, needJson, auth('MEMBER'), (req, res) => {
    const st = getSettings(req.user.id), want = !!(req.body && req.body.autoTrade);
    if (want && getBroker(req.user.id).status !== 'CONNECTED') return fail(res, 409, 'Connecte d\'abord ton compte broker');
    st.autoTrade = want; save(); ok(res, { autoTrade: st.autoTrade });
  });
  router.get('/api/robot/trades', auth('MEMBER'), (req, res) => {
    const rows = Object.values(db.executions).filter(e => e.userId === req.user.id).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(e => {
      const s = db.signals[e.signalId] || {};
      return { time: e.createdAt, signalId: e.signalId, symbol: s.symbol, dir: s.dir, entry: s.entry, sl: s.sl, tp: s.tp1, lot: e.lot, result: e.result, profit: e.profit, status: e.status, message: e.message };
    });
    ok(res, { trades: rows });
  });

  // --- Exécution d'un signal (ADMIN uniquement) — idempotent
  router.post('/api/robot/execute', json, needJson, auth('ADMIN'), (req, res) => {
    try { ok(res, dispatchSignal(req.body)); } catch (e) { fail(res, 400, e.message); }
  });

  // --- Worker central (VPS / EA) : protégé par clé, jamais appelé par le navigateur
  router.get('/api/robot/ea/jobs', eaAuth, (req, res) => {
    expireOld();
    const verify = [], orders = [];
    Object.entries(db.brokers).forEach(([userId, br]) => {
      if (br.status === 'CONNECTING' && br.passEnc) verify.push({ userId, login: br.login, server: br.server, password: decrypt(br.passEnc) });
    });
    Object.values(db.executions).forEach(e => {
      if (e.status !== 'NEW') return;
      const s = db.signals[e.signalId], br = db.brokers[e.userId];
      if (!s || !br || br.status !== 'CONNECTED' || !getSettings(e.userId).autoTrade) { e.status = 'CANCELLED'; e.message = 'Auto Trade OFF ou broker déconnecté'; e.updatedAt = now(); return; }
      e.status = 'SENT'; e.updatedAt = now();            // claim atomique : un seul worker le reçoit
      orders.push({ executionId: e.id, signalId: s.id, userId: e.userId, login: br.login, server: br.server, password: decrypt(br.passEnc),
        symbol: s.symbol, dir: s.dir, entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, lot: e.lot });
    });
    save(); res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, verify, orders });
  });
  router.post('/api/robot/ea/account', json, needJson, eaAuth, (req, res) => {
    const b = req.body || {}, br = db.brokers[b.userId];
    if (!br) return fail(res, 404, 'Compte inconnu');
    if (b.ok === false) { br.status = 'DISCONNECTED'; br.lastError = String(b.error || 'Connexion refusée').slice(0, 200); getSettings(b.userId).autoTrade = false; }
    else {
      br.status = 'CONNECTED'; br.lastError = '';
      if (Number.isFinite(num(b.balance))) br.balance = num(b.balance);
      if (Number.isFinite(num(b.openPositions))) br.openPositions = Math.round(num(b.openPositions));
      if (Number.isFinite(num(b.dailyPnl))) { br.dailyPnl = num(b.dailyPnl); br.dayKey = dayKey(now()); }
    }
    save(); ok(res);
  });
  router.post('/api/robot/ea/report', json, needJson, eaAuth, (req, res) => {
    const b = req.body || {}, e = db.executions[b.executionId];
    if (!e) return fail(res, 404, 'Exécution inconnue');
    if (b.status === 'EXECUTED' || b.status === 'FAILED') {
      if (e.status === 'EXECUTED' && b.status === 'EXECUTED' && e.ticket && b.ticket && e.ticket !== String(b.ticket)) return fail(res, 409, 'Doublon refusé');
      e.status = b.status;
    }
    if (b.ticket != null) e.ticket = String(b.ticket).slice(0, 30);
    if (Number.isFinite(num(b.price))) e.price = num(b.price);
    if (Number.isFinite(num(b.lot))) e.lot = num(b.lot);
    if (Number.isFinite(num(b.profit))) e.profit = round2(num(b.profit));
    if (b.result) e.result = String(b.result).slice(0, 20);
    if (b.error) e.message = String(b.error).slice(0, 200);
    e.updatedAt = now(); save(); ok(res);
  });

  return { router, dispatchSignal, _internal: { db: () => db, computeLot, normalizeSignal, encrypt, decrypt } };
};
