'use strict';
/**
 * ARES SAFE SCALPER — robot scalping GOLD + Forex (cTrader Open API).
 *
 * Fonctionnement (style des vidéos) :
 *  1. Signal M1 (EMA9 / EMA21 + RSI14, bougies fermées) -> le robot ouvre un « basket » : N positions au marché (5 par défaut),
 *     lot calculé selon le solde, + un ordre STOP opposé (protection / recovery borné) placé à une zone ATR de l'entrée.
 *  2. Si le STOP opposé est déclenché, le basket est verrouillé ; un nouveau STOP (retour au sens initial) est placé, au maximum `maxFlips` fois.
 *  3. Le basket est clôturé AUTOMATIQUEMENT (toutes les positions + ordres) quand son P/L net atteint `targetUsd`.
 *  4. Garde-fous « SAFE » : perte maximum par basket, perte maximum par jour, SL d'urgence sur chaque position, spread maximum, arrêt d'urgence.
 *
 * Le module utilise la session cTrader existante (manager.session(userId)) : OAuth, jetons et compte restent inchangés.
 * Il ne dépend PAS du moteur IA Mentor. Aucune donnée n'est simulée : sans connexion cTrader, le robot reste en attente.
 * Aucun profit n'est garanti.
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');

const LABEL = 'ARESSCALP';
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');

const DEFAULTS = {
  symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],   // GOLD + Forex ; seuls les symboles disponibles chez le broker sont utilisés
  positionsPerBasket: 5,        // positions ouvertes ensemble à chaque signal (minimum 5)
  lotDivisor: 100000,           // lot par position = solde / lotDivisor (arrondi au pas du broker, minimum = lot minimal)
  maxLotPerPosition: 5,
  targetUsd: 5,                 // le basket est clôturé automatiquement quand son P/L net atteint cette valeur ($)
  maxBasketLossPct: 3,          // perte maximale d'un basket (% du solde) : clôture de tout
  maxDailyLossPct: 6,           // perte maximale du jour (% du solde de début de journée) : robot en pause jusqu'au lendemain
  hedge: { enabled: true, zoneAtr: 2.5, maxFlips: 2 },   // ordre STOP opposé (style vidéo) à zoneAtr × ATR M1 de l'entrée, max 2 inversions
  emergencySlAtr: 12,           // SL d'urgence sur chaque position (× ATR M1) au cas où le serveur s'arrête
  maxSpreadAtr: 0.5,            // pas d'entrée si spread > 0,5 × ATR
  cooldownSec: 20,              // délai minimal entre deux baskets sur le même symbole
  maxBasketMinutes: 240,        // sécurité : au-delà, clôture du basket s'il n'est pas en perte ; à 1,5 × cette durée il est clôturé quoi qu'il arrive
  maxOpenBaskets: 4
};

function ema(v, n) { const k = 2 / (n + 1); const o = []; let e = v[0]; for (let i = 0; i < v.length; i++) { e = i === 0 ? v[0] : v[i] * k + e * (1 - k); o.push(e); } return o; }
function rsi(c, n) {
  if (c.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}
function atr(b, n) {
  if (b.length <= n) return null;
  let a = 0;
  for (let i = 1; i <= n; i++) a += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  a /= n;
  for (let i = n + 1; i < b.length; i++) a = (a * (n - 1) + Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))) / n;
  return a;
}
/** Signal M1 sur bougies fermées. Retourne { action: BUY|SELL|WAIT, reason, atr, ... }. Pur (testable). */
function computeSignal(bars) {
  if (!bars || bars.length < 40) return { action: 'WAIT', reason: 'historique M1 insuffisant' };
  const closes = bars.map(b => b.c), e9 = ema(closes, 9), e21 = ema(closes, 21), i = bars.length - 1;
  const R = rsi(closes, 14), A = atr(bars, 14), c = closes[i];
  if (R == null || !(A > 0)) return { action: 'WAIT', reason: 'indicateurs indisponibles' };
  const base = { atr: A, rsi: R, ema9: e9[i], ema21: e21[i] };
  if (e9[i] > e21[i] && c > e9[i] && R >= 50 && R <= 80) return Object.assign({ action: 'BUY', reason: 'EMA9 > EMA21 · clôture > EMA9 · RSI ' + r2(R) }, base);
  if (e9[i] < e21[i] && c < e9[i] && R <= 50 && R >= 20) return Object.assign({ action: 'SELL', reason: 'EMA9 < EMA21 · clôture < EMA9 · RSI ' + r2(R) }, base);
  return Object.assign({ action: 'WAIT', reason: 'pas de tendance claire M1 (RSI ' + r2(R) + ')' }, base);
}

function sanitizeConfig(src, cur) {
  const c = JSON.parse(JSON.stringify(cur || DEFAULTS));
  if (!src || typeof src !== 'object') return c;
  const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
  if (Array.isArray(src.symbols)) { const s = src.symbols.slice(0, 12).map(norm).filter(x => /^[A-Z]{3,12}$/.test(x)); if (s.length) c.symbols = Array.from(new Set(s)); }
  n('positionsPerBasket', 1, 10); c.positionsPerBasket = Math.round(c.positionsPerBasket);
  n('lotDivisor', 500, 1e6); n('maxLotPerPosition', 0.01, 100); n('targetUsd', 0.5, 100000);
  n('maxBasketLossPct', 0.2, 50); n('maxDailyLossPct', 0.5, 90); n('emergencySlAtr', 4, 50); n('maxSpreadAtr', 0.05, 5);
  n('cooldownSec', 5, 3600); n('maxBasketMinutes', 5, 1440); n('maxOpenBaskets', 1, 12); c.maxOpenBaskets = Math.round(c.maxOpenBaskets);
  if (src.hedge && typeof src.hedge === 'object') {
    if (typeof src.hedge.enabled === 'boolean') c.hedge.enabled = src.hedge.enabled;
    if (Number.isFinite(Number(src.hedge.zoneAtr))) c.hedge.zoneAtr = clamp(Number(src.hedge.zoneAtr), 0.5, 10);
    if (Number.isFinite(Number(src.hedge.maxFlips))) c.hedge.maxFlips = Math.round(clamp(Number(src.hedge.maxFlips), 0, 4));
  }
  return c;
}

class UserScalper {
  constructor({ userId, dataRoot, manager, now }) {
    this.userId = userId; this.manager = manager; this.now = now || (() => Date.now());
    this.file = path.join(dataRoot, 'scalper-' + userId + '.json');
    this.active = false; this.config = JSON.parse(JSON.stringify(DEFAULTS));
    this.baskets = {};                                   // symbol -> basket
    this.stats = { since: this.now(), baskets: 0, wins: 0, losses: 0, pnl: 0, best: 0, worst: 0 };
    this.history = []; this.logs = []; this.signals = {};
    this.day = { date: null, startBalance: null, pnl: 0 }; this.pausedUntilDay = null;
    this.live = { positions: [], orders: [], pnlById: {}, at: 0, error: null };
    this.barsCache = {}; this.busy = false; this.lastTick = 0; this.lastCooldown = {};
    this._load();
  }
  log(msg) { this.logs.unshift({ t: new Date(this.now()).toISOString(), msg: String(msg).slice(0, 240) }); if (this.logs.length > 150) this.logs.length = 150; }
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j.config) this.config = sanitizeConfig(j.config, DEFAULTS);
      this.active = j.active === true; if (j.stats) this.stats = Object.assign(this.stats, j.stats);
      if (Array.isArray(j.history)) this.history = j.history.slice(0, 300);
      if (j.baskets && typeof j.baskets === 'object') this.baskets = j.baskets;
      if (j.day) this.day = j.day; if (j.pausedUntilDay) this.pausedUntilDay = j.pausedUntilDay;
    } catch (e) { /* premier démarrage : statistiques à zéro */ }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ active: this.active, config: this.config, stats: this.stats, history: this.history.slice(0, 300), baskets: this.baskets, day: this.day, pausedUntilDay: this.pausedUntilDay }));
    } catch (e) { /* ignore */ }
  }
  sess() { try { return this.manager.session(this.userId); } catch (e) { return null; } }
  connected() { const s = this.sess(); return !!(s && s.status === 'CONNECTED' && s.client && s.client.ready && s.accountId); }

  setActive(on) {
    this.active = on === true;
    if (this.active) { this.pausedUntilDay = null; try { this.manager.engine(this.userId).setAutoTrade(false); } catch (e) { /* ancien moteur absent */ } }
    this.log(this.active ? 'ARES SAFE SCALPER activé' : 'ARES SAFE SCALPER arrêté (les baskets ouverts restent suivis jusqu\'à leur clôture)');
    this.save(); return { ok: true, active: this.active };
  }
  setConfig(src) { this.config = sanitizeConfig(src, this.config); this.save(); return { ok: true, config: this.config }; }
  resetStats() { this.stats = { since: this.now(), baskets: 0, wins: 0, losses: 0, pnl: 0, best: 0, worst: 0 }; this.history = []; this.save(); return { ok: true }; }

  // ---------- données broker ----------
  async refresh() {
    const s = this.sess(), md = s.moneyDigits != null ? Number(s.moneyDigits) : 2;
    const rec = await s.client.request(PT.RECONCILE_REQ, { ctidTraderAccountId: s.accountId });
    const byId = {}; Object.keys(s.specs || {}).forEach(n => { byId[String(s.specs[n].symbolId)] = n; });
    const positions = (rec.payload.position || []).filter(p => p && p.tradeData && p.tradeData.label === LABEL && (p.positionStatus === 1 || p.positionStatus === 'POSITION_STATUS_OPEN' || p.positionStatus == null)).map(p => ({
      id: String(p.positionId), symbol: byId[String(p.tradeData.symbolId)] || String(p.tradeData.symbolId), side: sideOf(p.tradeData.tradeSide),
      volume: Number(p.tradeData.volume), price: Number(p.price), basket: String(p.tradeData.comment || ''), openedAt: Number(p.tradeData.openTimestamp) || null
    }));
    const orders = (rec.payload.order || []).filter(o => o && o.tradeData && o.tradeData.label === LABEL).map(o => ({
      id: String(o.orderId), symbol: byId[String(o.tradeData.symbolId)] || String(o.tradeData.symbolId), side: sideOf(o.tradeData.tradeSide),
      volume: Number(o.tradeData.volume), stopPrice: Number(o.stopPrice), basket: String(o.tradeData.comment || ''), type: o.orderType
    }));
    const pnlById = {};
    try {
      const u = await s.client.request(PT.UNREALIZED_PNL_REQ, { ctidTraderAccountId: s.accountId });
      const ud = u.payload.moneyDigits != null ? Number(u.payload.moneyDigits) : md;
      (u.payload.positionUnrealizedPnL || []).forEach(x => { if (x.positionId != null) pnlById[String(x.positionId)] = Number(x.netUnrealizedPnL) / Math.pow(10, ud); });
    } catch (e) { this.live.error = 'P/L latent : ' + (e && e.message); }
    positions.forEach(p => { p.pnl = r2(pnlById[p.id] || 0); const sp = s.specs[p.symbol]; p.lots = sp ? r2(p.volume / sp.lotSize) : null; });
    this.live = { positions, orders, pnlById, at: this.now(), error: this.live.error && Date.now() - this.live.at < 5000 ? this.live.error : null };
  }
  async bars(name) {
    const c = this.barsCache[name], t = this.now();
    if (c && t - c.at < 15000) return c.bars;
    const s = this.sess(), minuteEnd = Math.floor(t / 60000) * 60000;
    const raw = await s.fetchHistory(name, 1, minuteEnd - 240 * 60000, t);
    const bars = raw.filter(b => b.t < minuteEnd);   // bougies fermées uniquement
    this.barsCache[name] = { at: t, bars }; return bars;
  }
  quote(name) {
    const s = this.sess(), sp = s.specs[name], q = sp && s.quotes[String(sp.symbolId)];
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return null; return q;
  }
  lotsFor(name) {
    const s = this.sess(), sp = s.specs[name], bal = num(s.balance, 0), step = sp.lotStep || 0.01, min = sp.minLot || 0.01;
    let lots = Math.floor((bal / this.config.lotDivisor) / step + 1e-9) * step;
    lots = clamp(lots, min, Math.min(this.config.maxLotPerPosition, sp.maxLot || 1e9));
    return Math.round(lots / step) * step;
  }

  // ---------- ordres ----------
  async market(name, side, lots, comment, slDist) {
    const s = this.sess(), sp = s.specs[name];
    await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 1, tradeSide: side === 'BUY' ? 1 : 2, volume: s._volume(sp, lots), relativeStopLoss: s._grid(sp, slDist), label: LABEL, comment });
  }
  async stop(name, side, volume, price, comment) {
    const s = this.sess(), sp = s.specs[name];
    await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 3, tradeSide: side === 'BUY' ? 1 : 2, volume, stopPrice: Number(Number(price).toFixed(sp.digits)), timeInForce: 1, expirationTimestamp: this.now() + (this.config.maxBasketMinutes + 5) * 60000, label: LABEL, comment });
  }
  async closeBasket(name, reason) {
    const b = this.baskets[name]; if (!b) return;
    const s = this.sess(), mine = this.live.positions.filter(p => p.basket === b.id), ords = this.live.orders.filter(o => o.basket === b.id);
    const net = r2(mine.reduce((a, p) => a + p.pnl, 0) + (b.realized || 0));
    for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { this.log('annulation ordre ' + o.id + ' : ' + (e && e.message)); } }
    let failed = 0;
    for (const p of mine) { try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); } catch (e) { failed++; this.log('clôture ' + p.id + ' : ' + (e && e.message)); } }
    if (failed) { b.closing = reason; this.log(name + ' : ' + failed + ' position(s) à reclôturer au prochain cycle'); return; }
    this._finish(name, b, net, reason, mine.length);
  }
  _finish(name, b, net, reason, count) {
    const win = net > 0;
    this.stats.baskets++; if (win) this.stats.wins++; else this.stats.losses++;
    this.stats.pnl = r2(this.stats.pnl + net); this.stats.best = Math.max(this.stats.best, net); this.stats.worst = Math.min(this.stats.worst, net);
    this.day.pnl = r2((this.day.pnl || 0) + net);
    this.history.unshift({ id: b.id, symbol: name, side: b.side, positions: count, lots: b.lots, flips: b.flips || 0, openedAt: b.openedAt, closedAt: this.now(), pnl: net, result: win ? 'GAGNANT' : 'PERDANT', reason });
    if (this.history.length > 300) this.history.length = 300;
    this.log(`${name} : basket clôturé (${reason}) ${net >= 0 ? '+' : ''}${net} $`);
    delete this.baskets[name]; this.lastCooldown[name] = this.now(); this.save();
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {});
    for (const name of Object.keys(this.baskets)) { try { await this.closeBasket(name, reason || 'clôture manuelle'); } catch (e) { this.log(name + ' : ' + (e && e.message)); } }
    // positions / ordres orphelins (ARESSCALP sans basket connu)
    const s = this.sess();
    for (const p of this.live.positions) { if (!Object.values(this.baskets).some(b => b.id === p.basket)) { try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); } catch (e) { /* ignore */ } } }
    for (const o of this.live.orders) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    return { ok: true };
  }

  // ---------- boucle ----------
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (!this.connected()) { return; }
      if (this.now() - this.lastTick < 2000) return; this.lastTick = this.now();
      const s = this.sess(), dk = this.dayKey();
      if (this.day.date !== dk) { this.day = { date: dk, startBalance: num(s.balance, null), pnl: 0 }; this.pausedUntilDay = null; }
      if (this.day.startBalance == null && s.balance != null) this.day.startBalance = num(s.balance, null);
      const hasWork = this.active || Object.keys(this.baskets).length || this.live.positions.length;
      if (!hasWork) return;
      await this.refresh();
      await this.manage();
      if (this.active && this.pausedUntilDay !== dk) await this.hunt();
    } catch (e) { this.live.error = String(e && e.message || e).slice(0, 200); this.log('erreur cycle : ' + this.live.error); }
    finally { this.busy = false; }
  }
  basketNet(b) { return r2(this.live.positions.filter(p => p.basket === b.id).reduce((a, p) => a + p.pnl, 0) + (b.realized || 0)); }
  async manage() {
    const s = this.sess(), bal = num(s.balance, 0), lossCap = r2(bal * this.config.maxBasketLossPct / 100);
    for (const name of Object.keys(this.baskets)) {
      const b = this.baskets[name], mine = this.live.positions.filter(p => p.basket === b.id), ords = this.live.orders.filter(o => o.basket === b.id);
      if (b.closing) { if (!mine.length) { for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } } this._finish(name, b, this.basketNet(b), b.closing, 0); } else await this.closeBasket(name, b.closing); continue; }
      if (!mine.length && !ords.length && this.now() - b.openedAt > 15000) { this.log(name + ' : basket sans position (fermé par le broker : SL d\'urgence ?)'); this._finish(name, b, this.basketNet(b), 'FERMÉ PAR LE BROKER', 0); continue; }
      const net = this.basketNet(b), ageMin = (this.now() - b.openedAt) / 60000;
      if (net >= this.config.targetUsd) { await this.closeBasket(name, 'PROFIT'); continue; }
      if (net <= -lossCap) { await this.closeBasket(name, 'PERTE MAX BASKET'); continue; }
      if (ageMin > this.config.maxBasketMinutes && net >= 0) { await this.closeBasket(name, 'DURÉE MAX'); continue; }
      if (ageMin > this.config.maxBasketMinutes * 1.5) { await this.closeBasket(name, 'DURÉE MAX (perte limitée)'); continue; }
      // STOP opposé déclenché ? (le nombre de positions du basket augmente -> inversion)
      const open = mine.length, lastN = b.n || 0;
      if (open > lastN) {
        b.n = open; b.flips = (b.flips || 0) + 1;
        this.log(`${name} : STOP déclenché (inversion ${b.flips}/${this.config.hedge.maxFlips})`);
        const opp = this.live.orders.filter(o => o.basket === b.id);
        for (const o of opp) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
        if (this.config.hedge.enabled && b.flips < this.config.hedge.maxFlips) await this.placeNextStop(name, b, mine);
      }
    }
  }
  async placeNextStop(name, b, mine) {
    // le prochain STOP revient dans le sens opposé du dernier côté ajouté ; prix = zone d'entrée ou zone d'inversion
    const nextSide = b.flips % 2 === 1 ? b.side : (b.side === 'BUY' ? 'SELL' : 'BUY');
    const px = b.flips % 2 === 1 ? b.entry : b.hedgePx;
    const q = this.quote(name); if (!q) return;
    const valid = nextSide === 'BUY' ? px > q.ask : px < q.bid;
    if (!valid) { this.log(`${name} : STOP ${nextSide} non placé (prix déjà dépassé) — la perte max du basket protège`); return; }
    try { await this.stop(name, nextSide, b.baseVolume, px, b.id); } catch (e) { this.log(`${name} : STOP ${nextSide} refusé : ${e && e.message}`); }
  }
  async hunt() {
    const s = this.sess(), cfg = this.config, t = this.now();
    if (this.day.startBalance > 0 && this.day.pnl <= -(this.day.startBalance * cfg.maxDailyLossPct / 100)) {
      this.pausedUntilDay = this.dayKey(); this.log(`perte journalière max atteinte (${cfg.maxDailyLossPct} %) — robot en pause jusqu'à demain`); this.save(); return;
    }
    for (const name of cfg.symbols) {
      if (Object.keys(this.baskets).length >= cfg.maxOpenBaskets) break;
      if (this.baskets[name] || !s.specs[name]) continue;
      if (t - (this.lastCooldown[name] || 0) < cfg.cooldownSec * 1000) continue;
      let bars; try { bars = await this.bars(name); } catch (e) { this.signals[name] = { action: 'WAIT', reason: 'historique indisponible' }; continue; }
      const sig = computeSignal(bars); this.signals[name] = Object.assign({ at: t }, sig);
      if (sig.action === 'WAIT') continue;
      const q = this.quote(name); if (!q) { this.signals[name].reason = 'pas de prix en direct'; continue; }
      if (q.ask - q.bid > sig.atr * cfg.maxSpreadAtr) { this.signals[name].reason = 'spread trop large'; continue; }
      await this.openBasket(name, sig, q);
    }
  }
  async openBasket(name, sig, q) {
    const s = this.sess(), cfg = this.config, sp = s.specs[name], lots = this.lotsFor(name), id = 'SS' + name.slice(0, 6) + this.now().toString(36);
    const side = sig.action, entry = side === 'BUY' ? q.ask : q.bid, zone = Math.max(sig.atr * cfg.hedge.zoneAtr, (q.ask - q.bid) * 4);
    const slDist = Math.max(sig.atr * cfg.emergencySlAtr, zone * 3);
    const b = { id, symbol: name, side, entry, lots, openedAt: this.now(), flips: 0, n: 0, realized: 0, baseVolume: 0, hedgePx: side === 'BUY' ? entry - zone : entry + zone, zone };
    let opened = 0;
    for (let i = 0; i < cfg.positionsPerBasket; i++) {
      try { await this.market(name, side, lots, id, slDist); opened++; }
      catch (e) { this.log(`${name} : ordre ${side} refusé : ${e && e.message}`); break; }
    }
    if (!opened) return;
    b.n = opened; b.baseVolume = s._volume(sp, lots) * opened;
    this.baskets[name] = b;
    this.log(`${name} : ${side} × ${opened} positions (${r2(lots)} lot chacune) — ${sig.reason}`);
    if (cfg.hedge.enabled && cfg.hedge.maxFlips > 0) {
      try { await this.stop(name, side === 'BUY' ? 'SELL' : 'BUY', b.baseVolume, b.hedgePx, id); } catch (e) { this.log(`${name} : STOP de protection refusé : ${e && e.message}`); }
    }
    this.save();
  }

  // ---------- vue pour l'interface ----------
  status() {
    const s = this.sess(), conn = this.connected(), dk = this.dayKey();
    const baskets = Object.keys(this.baskets).map(name => {
      const b = this.baskets[name], mine = this.live.positions.filter(p => p.basket === b.id);
      return { symbol: name, id: b.id, side: b.side, lotsPerPosition: r2(b.lots), positions: mine.length, entry: b.entry, flips: b.flips || 0, net: this.basketNet(b), target: this.config.targetUsd, openedAt: b.openedAt, pending: this.live.orders.filter(o => o.basket === b.id).map(o => ({ side: o.side, price: o.stopPrice })), items: mine.map(p => ({ id: p.id, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl })), closing: b.closing || null };
    });
    const total = this.stats.wins + this.stats.losses;
    return {
      ok: true, active: this.active, connected: conn, state: !conn ? 'CTRADER NON CONNECTÉ' : this.pausedUntilDay === dk ? 'PAUSE (perte jour max)' : this.active ? (baskets.length ? 'EN TRADE' : 'ANALYSE') : 'ARRÊTÉ',
      account: conn ? { balance: s.balance, freeMargin: s.freeMargin, accountId: s.accountId } : null,
      config: this.config, baskets, signals: this.signals,
      stats: Object.assign({}, this.stats, { winRate: total ? r2(this.stats.wins / total * 100) : null, total }),
      day: { date: this.day.date, pnl: r2(this.day.pnl || 0) }, history: this.history.slice(0, 50), logs: this.logs.slice(0, 40), error: this.live.error
    };
  }
}

module.exports = function createScalper({ manager, dataRoot, now }) {
  const users = new Map();
  const get = uid => { if (!users.has(uid)) users.set(uid, new UserScalper({ userId: uid, dataRoot, manager, now })); return users.get(uid); };
  const emergencyStop = async uid => { const u = get(uid); u.active = false; u.save(); try { await u.closeAll('ARRÊT D\'URGENCE'); } catch (e) { /* ignore */ } return { ok: true }; };
  return {
    get,
    tickAll: async () => { for (const u of users.values()) await u.tick(); },
    // démarrage : reprend les utilisateurs déjà enregistrés (fichiers scalper-<id>.json) et coupe l'ancienne stratégie du moteur IA Mentor
    start: ids => {
      const all = new Set(ids || []);
      try { fs.readdirSync(dataRoot).forEach(f => { const m = /^scalper-([A-Za-z0-9_-]+)\.json$/.exec(f); if (m) all.add(m[1]); }); } catch (e) { /* dossier absent : premier démarrage */ }
      all.forEach(id => { get(id); try { manager.engine(id).setAutoTrade(false); } catch (e) { /* ancien moteur absent */ } });
    },
    emergencyStop,
    emergencyStopAll: async () => { for (const id of Array.from(users.keys())) await emergencyStop(id); return { ok: true }; }
  };
};
module.exports.computeSignal = computeSignal;
module.exports.sanitizeConfig = sanitizeConfig;
module.exports.UserScalper = UserScalper;
module.exports.DEFAULTS = DEFAULTS;
