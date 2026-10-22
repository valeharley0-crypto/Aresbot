'use strict';
/**
 * ARES SAFE SCALPER — robot scalping GOLD + Forex (cTrader Open API) · STYLE « STRADDLE » (vidéo TikTok XAUUSD M1).
 *
 * Fonctionnement :
 *  1. Le robot ENTRE TOUT DE SUITE (pas besoin d'attendre un signal) : N positions au marché (5 par défaut) dans le sens du biais M1
 *     (couleur de la dernière bougie M1 fermée ; aucun indicateur EMA/RSI) + AU MÊME MOMENT un ordre STOP dans le sens OPPOSÉ, très proche (≈ 1 × ATR M1).
 *     -> on voit toujours un BUY et un SELL : l'un ouvert, l'autre en attente (comme dans la vidéo).
 *  2. STOP-AND-REVERSE (comme la vidéo) : le STOP opposé SUIT le prix de près (il ne s'éloigne jamais : un SELL ouvert -> le BUY STOP descend avec le prix ; un BUY ouvert -> le SELL STOP monte).
 *     Quand le STOP est touché, les positions de l'ancien sens sont FERMÉES AUSSITÔT (plus de verrouillage BUY+SELL) et le robot est dans le nouveau sens, avec un nouveau STOP qui suit à son tour. Au maximum `maxFlips` inversions.
 *  Plusieurs symboles (XAUUSD + EURUSD par défaut) tournent EN MÊME TEMPS, un basket par symbole.
 *  3. Le basket est clôturé AUTOMATIQUEMENT (toutes les positions + ordres) quand son P/L net atteint la cible.
 *     La cible est calculée AUTOMATIQUEMENT par le robot (% du solde × niveau de lot) : plus de panneau « Objectif ».
 *  4. Lot : minimal au départ (solde ÷ lotDivisor), puis monté d'un cran après chaque basket gagnant (max `maxLotLevel`), remis au minimum après une perte.
 *  5. Garde-fous « SAFE » (tous automatiques, aucun réglage sur le site) : SL court sur CHAQUE position (market ET stop), perte maximum par basket (1 % du solde),
 *     perte maximum par jour (3 %, flottant compris), 2 inversions maximum et plus d'inversion si la perte approche la limite, sortie rapide après inversion,
 *     durée maximum courte, spread maximum, arrêt d'urgence.
 *  6. Positions orphelines : toute position/ordre ARESSCALP sans basket connu est fermé/annulé (rien ne reste ouvert sans surveillance, rien n'est caché).
 *
 * Le module utilise la session cTrader existante (manager.session(userId)) : OAuth, jetons et compte restent inchangés.
 * Il ne dépend PAS du moteur IA Mentor. Aucune donnée n'est simulée : sans connexion cTrader, le robot reste en attente.
 * Aucun profit n'est garanti : le style « straddle » peut enchaîner des inversions perdantes (spread, gaps, slippage).
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');

const LABEL = 'ARESSCALP';
const CFG_VERSION = 6;   // v3 : risque réduit (SL court, perte max 1 %, 2 inversions) — les anciens réglages sont remplacés, seuls les symboles sont gardés
const FLIP_LOSS_FRAC = 0.6;   // plus d'inversion si la perte du basket dépasse 60 % de la perte max
const QUICK_EXIT_FRAC = 0.5;  // après une inversion : fermeture dès que le net atteint 50 % de la cible
const ORPHAN_GRACE_MS = 15000;
const EMPTY_GRACE_MS = 6000;
const TRAIL_EVERY_MS = 300;   // le STOP suiveur est recalé au plus toutes les 1,2 s par basket
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');

const DEFAULTS = {
  symbols: ['XAUUSD', 'EURUSD'],   // GOLD + EURUSD en même temps ; on peut en ajouter (GBPUSD...). Le nom est cherché chez le broker (XAUUSD, XAUUSD-STD, GOLD...)
  positionsPerBasket: 1,        // positions ouvertes ensemble au même prix (minimum 5 conseillé)
  lotDivisor: 100000,           // lot de base par position = solde / lotDivisor (arrondi au pas du broker, minimum = lot minimal)
  autoLot: false,               // lot constant : le robot calcule le lot lui-même d'après le solde du compte (risque), sans montée de cran
  maxLotLevel: 2,               // nombre maximal de crans (lot final = lot de base × (1 + crans))
  maxLotPerPosition: 5,
  autoTarget: true,             // cible du basket calculée par le robot : solde × targetPct % × niveau de lot (minimum minTargetUsd)
  targetPct: 0.5,
  minTargetUsd: 1,
  targetUsd: 5,                 // utilisé seulement si autoTarget = false
  maxBasketLossPct: 1,          // perte maximale d'un basket (% du solde) : clôture de tout (plancher = 4 × le coût d'ouverture/spread du basket)
  maxDailyLossPct: 3,           // perte maximale du jour, flottant compris (% du solde de début de journée) : robot en pause jusqu'au lendemain
  hedge: { enabled: true, zoneAtr: 0.2, maxFlips: 10 },   // STOP suiveur opposé à zoneAtr × ATR M1 du prix (proche, comme la vidéo), max 6 inversions
  emergencySlAtr: 3,            // SL court sur chaque position (× ATR M1), au-delà de la zone du STOP opposé ; protège aussi si le serveur s'arrête
  maxSpreadAtr: 0.5,            // pas d'entrée si spread > 0,5 × ATR
  cooldownSec: 5,               // délai minimal entre deux baskets sur le même symbole
  maxBasketMinutes: 15,         // scalping : au-delà, clôture du basket s'il n'est pas en perte ; à 1,5 × cette durée il est clôturé quoi qu'il arrive
  maxOpenBaskets: 2,
  sessionFilter: true           // true : le robot n'ouvre de trade que pendant les sessions Londres / New York
};

function atr(b, n) {
  if (b.length <= n) return null;
  let a = 0;
  for (let i = 1; i <= n; i++) a += Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
  a /= n;
  for (let i = n + 1; i < b.length; i++) a = (a * (n - 1) + Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))) / n;
  return a;
}
/** Sens d'entrée : UNIQUEMENT la bougie M1 fermée la plus récente (haussière -> BUY, baissière -> SELL). Aucun indicateur (ni EMA ni RSI). L'ATR ne sert qu'à mesurer la distance du STOP et du SL. */
function computeSignal(bars) {
  if (!bars || bars.length < 20) return { action: 'WAIT', reason: 'historique M1 insuffisant' };
  const last = bars[bars.length - 1], A = atr(bars, 14);
  if (!(A > 0)) return { action: 'WAIT', reason: 'volatilité M1 indisponible' };
  const up = last.c >= last.o;
  return { action: up ? 'BUY' : 'SELL', reason: 'bougie M1 ' + (up ? 'haussière' : 'baissière') + ' (clôture ' + last.c + ')', atr: A };
}
const entryBias = (bars, sig) => sig;   // compatibilité : le sens vient déjà de la bougie

/** Session de trading : lundi-vendredi, Londres 08:00-17:00 (heure de Londres) OU New York 08:00-17:00 (heure de New York) ; le décalage horaire d'été est géré automatiquement. */
function inSession(ts) {
  const d = new Date(ts), get = (tz, o) => new Intl.DateTimeFormat('en-GB', Object.assign({ timeZone: tz, hourCycle: 'h23' }, o)).format(d);
  const win = tz => { const h = Number(get(tz, { hour: '2-digit' })), wd = get(tz, { weekday: 'short' }); return wd !== 'Sat' && wd !== 'Sun' && h >= 8 && h < 17; };
  return win('Europe/London') || win('America/New_York');
}

function sanitizeConfig(src, cur) {
  const c = JSON.parse(JSON.stringify(cur || DEFAULTS));
  if (!src || typeof src !== 'object') return c;
  const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
  if (Array.isArray(src.symbols)) { const s = src.symbols.slice(0, 12).map(norm).filter(x => /^[A-Z]{3,12}$/.test(x)); if (s.length) c.symbols = Array.from(new Set(s)); }
  if (typeof src.autoLot === 'boolean') c.autoLot = src.autoLot;
  if (typeof src.sessionFilter === 'boolean') c.sessionFilter = src.sessionFilter;
  if (typeof src.autoTarget === 'boolean') c.autoTarget = src.autoTarget;
  n('positionsPerBasket', 1, 10); c.positionsPerBasket = Math.round(c.positionsPerBasket);
  n('lotDivisor', 500, 1e6); n('maxLotPerPosition', 0.01, 100); n('targetUsd', 0.5, 100000);
  n('targetPct', 0.05, 20); n('minTargetUsd', 0.2, 10000); n('maxLotLevel', 0, 10); c.maxLotLevel = Math.round(c.maxLotLevel);
  n('maxBasketLossPct', 0.2, 50); n('maxDailyLossPct', 0.5, 90); n('emergencySlAtr', 1.5, 50); n('maxSpreadAtr', 0.05, 5);
  n('cooldownSec', 2, 3600); n('maxBasketMinutes', 5, 1440); n('maxOpenBaskets', 1, 12); c.maxOpenBaskets = Math.round(c.maxOpenBaskets);
  if (src.hedge && typeof src.hedge === 'object') {
    if (typeof src.hedge.enabled === 'boolean') c.hedge.enabled = src.hedge.enabled;
    if (Number.isFinite(Number(src.hedge.zoneAtr))) c.hedge.zoneAtr = clamp(Number(src.hedge.zoneAtr), 0.3, 10);
    if (Number.isFinite(Number(src.hedge.maxFlips))) c.hedge.maxFlips = Math.round(clamp(Number(src.hedge.maxFlips), 0, 10));
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
    this.history = []; this.logs = []; this.signals = {}; this.lotLevel = 0;
    this.day = { date: null, startBalance: null, pnl: 0 }; this.pausedUntilDay = null;
    this.live = { positions: [], orders: [], pnlById: {}, at: 0, error: null };
    this.barsCache = {}; this.busy = false; this.lastTick = 0; this.lastCooldown = {}; this.orphans = [];
    this._load();
  }
  log(msg) { this.logs.unshift({ t: new Date(this.now()).toISOString(), msg: String(msg).slice(0, 240) }); if (this.logs.length > 150) this.logs.length = 150; }
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j.config) {
        // ancienne config (avant le style vidéo) : on repart des nouveaux réglages, en gardant seulement les symboles choisis
        if (j.cfgVersion === CFG_VERSION) this.config = sanitizeConfig(j.config, DEFAULTS);
        else this.config = sanitizeConfig({}, DEFAULTS);   // v4 : nouveau style (STOP suiveur) + GOLD & EURUSD ensemble
      }
      if (Number.isFinite(Number(j.lotLevel))) this.lotLevel = clamp(Math.round(Number(j.lotLevel)), 0, 10);
      this.active = j.active === true; if (j.stats) this.stats = Object.assign(this.stats, j.stats);
      if (Array.isArray(j.history)) this.history = j.history.slice(0, 300);
      if (j.baskets && typeof j.baskets === 'object') this.baskets = j.baskets;
      if (j.day) this.day = j.day; if (j.pausedUntilDay) this.pausedUntilDay = j.pausedUntilDay;
    } catch (e) { /* premier démarrage : statistiques à zéro */ }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ cfgVersion: CFG_VERSION, lotLevel: this.lotLevel, active: this.active, config: this.config, stats: this.stats, history: this.history.slice(0, 300), baskets: this.baskets, day: this.day, pausedUntilDay: this.pausedUntilDay }));
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
  // Le site ne règle QUE les symboles : lot, cible, SL et risque sont gérés par le robot lui-même (tout autre champ reçu est ignoré).
  setConfig(src) { this.config = sanitizeConfig({ symbols: src && src.symbols }, this.config); this.save(); return { ok: true, config: this.config }; }
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
  /** Nom réel du symbole chez le broker : XAUUSD -> XAUUSD, XAUUSD-STD (XAUUSDSTD), XAUUSD.r, GOLD... */
  resolve(want) {
    const s = this.sess(), specs = (s && s.specs) || {}, w = norm(want);
    if (specs[w]) return w;
    const keys = Object.keys(specs);
    let k = keys.find(x => x.startsWith(w));
    if (!k && w === 'XAUUSD') k = keys.find(x => x === 'GOLD' || x.startsWith('GOLD') || x.startsWith('XAU'));
    return k || null;
  }
  /** Unités de l'instrument par lot (cTrader : lotSize est en « centièmes d'unité », ex. 10 000 000 = 100 000 unités). */
  unitsPerLot(sp) { return Math.max(1e-9, sp.lotSize / 100); }
  lotMult() { return this.config.autoLot ? 1 + clamp(this.lotLevel, 0, this.config.maxLotLevel) : 1; }
  /** Lot calculé par le robot : on risque maxBasketLossPct % du SOLDE du compte (quel qu'il soit : 5 $, 10 $, 1000 $...) jusqu'au SL ;
   *  le résultat est ramené dans les limites du broker lues dans cTrader (lot minimal, pas, lot maximal). */
  lotsFor(name, slDist) {
    const s = this.sess(), sp = s.specs[name], bal = num(s.balance, 0), step = sp.lotStep || 0.01, min = sp.minLot || 0.01;
    const riskUsd = bal * this.config.maxBasketLossPct / 100;
    let lots = slDist > 0 ? riskUsd / (slDist * this.unitsPerLot(sp)) : min;
    lots = clamp(lots * this.lotMult(), min, Math.min(this.config.maxLotPerPosition, sp.maxLot || 1e9));
    return Math.round(Math.max(min, Math.floor(lots / step + 1e-9) * step) * 1e6) / 1e6;
  }
  /** Cible du basket : automatique = solde × targetPct % × niveau de lot (minimum minTargetUsd). */
  targetFor(b) {
    const c = this.config;
    if (!c.autoTarget) return r2(c.targetUsd);
    const bal = num(this.sess() && this.sess().balance, 0);
    return r2(Math.max(c.minTargetUsd, bal * c.targetPct / 100 * ((b && b.lotMult) || 1)));
  }

  // ---------- ordres ----------
  async market(name, side, lots, comment, slDist) {
    const s = this.sess(), sp = s.specs[name];
    await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 1, tradeSide: side === 'BUY' ? 1 : 2, volume: s._volume(sp, lots), relativeStopLoss: s._grid(sp, slDist), label: LABEL, comment });
  }
  async stop(name, side, volume, price, comment, slDist) {
    const s = this.sess(), sp = s.specs[name], vol = sp.maxVolume > 0 ? Math.min(volume, sp.maxVolume) : volume, px = Number(Number(price).toFixed(sp.digits));
    const req = { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 3, tradeSide: side === 'BUY' ? 1 : 2, volume: vol, stopPrice: px, timeInForce: 1, expirationTimestamp: this.now() + (this.config.maxBasketMinutes + 5) * 60000, label: LABEL, comment };
    // SL d'urgence ABSOLU sur l'ordre STOP (les SL relatifs ne concernent que les ordres au marché) : la position déclenchée est protégée même si le serveur s'arrête
    if (slDist > 0) req.stopLoss = Number((side === 'BUY' ? px - slDist : px + slDist).toFixed(sp.digits));
    await s.client.request(PT.NEW_ORDER_REQ, req);
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
    this.lotLevel = win ? Math.min(this.config.maxLotLevel, this.lotLevel + 1) : 0;   // lot minimal puis monté d'un cran après un gain ; retour au minimum après une perte
    this.history.unshift({ id: b.id, symbol: name, side: b.side, positions: count, lots: b.lots, flips: b.flips || 0, lotMult: b.lotMult || 1, openedAt: b.openedAt, closedAt: this.now(), pnl: net, result: win ? 'GAGNANT' : 'PERDANT', reason });
    if (this.history.length > 300) this.history.length = 300;
    this.log(`${name} : basket clôturé (${reason}) ${net >= 0 ? '+' : ''}${net} $`);
    delete this.baskets[name]; this.lastCooldown[name] = this.now(); this.save();
  }
  /** Chaque trade fermé par le STOP suiveur compte comme un trade (gagnant/perdant) dans les statistiques. */
  recordLeg(name, b, side, pnl, count) {
    const win = pnl > 0;
    this.stats.baskets++; if (win) this.stats.wins++; else this.stats.losses++;
    this.stats.pnl = r2(this.stats.pnl + pnl); this.stats.best = Math.max(this.stats.best, pnl); this.stats.worst = Math.min(this.stats.worst, pnl);
    this.day.pnl = r2((this.day.pnl || 0) + pnl);
    this.history.unshift({ id: b.id + '-' + (b.flips || 0), symbol: name, side, positions: count, lots: b.lots, flips: b.flips || 0, lotMult: b.lotMult || 1, openedAt: b.openedAt, closedAt: this.now(), pnl, result: win ? 'GAGNANT' : 'PERDANT', reason: 'STOP touché' });
    if (this.history.length > 300) this.history.length = 300;
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
      const gap = (Object.keys(this.baskets).length || this.live.positions.length) ? 300 : 2000;   // en trade : mise à jour chaque seconde (panel Trade live)
      if (this.now() - this.lastTick < gap) return; this.lastTick = this.now();
      const s = this.sess(), dk = this.dayKey();
      if (this.day.date !== dk) { this.day = { date: dk, startBalance: num(s.balance, null), pnl: 0 }; this.pausedUntilDay = null; }
      if (this.day.startBalance == null && s.balance != null) this.day.startBalance = num(s.balance, null);
      const hasWork = this.active || Object.keys(this.baskets).length || this.live.positions.length;
      if (!hasWork) {
        // robot arrêté et rien à suivre : on vérifie quand même toutes les 10 s qu'aucune position/ordre ARESSCALP ne reste caché
        if (this.now() - (this.lastIdleCheck || 0) < 10000) return;
        this.lastIdleCheck = this.now();
      }
      await this.refresh();
      await this.manage();
      if (this.active && this.pausedUntilDay !== dk) await this.hunt();
    } catch (e) { this.live.error = String(e && e.message || e).slice(0, 200); this.log('erreur cycle : ' + this.live.error); }
    finally { this.busy = false; }
  }
  basketNet(b) { return r2(this.live.positions.filter(p => p.basket === b.id).reduce((a, p) => a + p.pnl, 0) + (b.realized || 0)); }
  /** Positions/ordres ARESSCALP sans basket connu : fermés/annulés (jamais de position cachée et sans surveillance). */
  async sweepOrphans() {
    const s = this.sess(), ids = new Set(Object.values(this.baskets).map(b => b.id)), t = this.now();
    const op = this.live.positions.filter(p => !ids.has(p.basket) && (!p.openedAt || t - p.openedAt > ORPHAN_GRACE_MS));
    const oo = this.live.orders.filter(o => !ids.has(o.basket));
    this.orphans = this.live.positions.filter(p => !ids.has(p.basket)).map(p => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl }));
    for (const o of oo) { try { await s.cancelOrder(o.id); this.log('ordre orphelin annulé ' + o.id); } catch (e) { this.log('annulation ordre orphelin ' + o.id + ' : ' + (e && e.message)); } }
    for (const p of op) { try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); this.log(`${p.symbol} : position orpheline ${p.side} fermée (${p.pnl >= 0 ? '+' : ''}${p.pnl} $)`); } catch (e) { this.log('clôture orpheline ' + p.id + ' : ' + (e && e.message)); } }
  }
  lossCapFor(b, bal) {
    // 1 % du solde, mais jamais moins de 4 × le coût d'ouverture (spread) du basket : sinon un petit compte fermerait chaque basket aussitôt ouvert
    return r2(Math.max(bal * this.config.maxBasketLossPct / 100, (b.openCost || 0) * 4));
  }
  async manage() {
    const s = this.sess(), bal = num(s.balance, 0);
    await this.sweepOrphans();
    for (const name of Object.keys(this.baskets)) {
      const b = this.baskets[name], mine = this.live.positions.filter(p => p.basket === b.id), ords = this.live.orders.filter(o => o.basket === b.id);
      if (b.closing) { if (!mine.length) { for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } } this._finish(name, b, this.basketNet(b), b.closing, 0); } else await this.closeBasket(name, b.closing); continue; }
      if (!mine.length && !ords.length && this.now() - b.openedAt > 15000) {
        // vide pendant au moins EMPTY_GRACE_MS d'affilée (une réponse broker incomplète ne doit pas faire oublier des positions encore ouvertes)
        if (!b.emptySince) { b.emptySince = this.now(); continue; }
        if (this.now() - b.emptySince < EMPTY_GRACE_MS) continue;
        this.log(name + ' : basket sans position (fermé par le broker : SL ?)'); this._finish(name, b, this.basketNet(b), 'FERMÉ PAR LE BROKER', 0); continue;
      }
      b.emptySince = null;
      const net = this.basketNet(b), ageMin = (this.now() - b.openedAt) / 60000;
      if (b.openCost == null && mine.length) b.openCost = Math.max(0, r2(-net));   // coût d'ouverture (spread) mesuré une seule fois
      const lossCap = this.lossCapFor(b, bal);
      if (net <= -lossCap) { await this.closeBasket(name, 'PERTE MAX BASKET'); continue; }
      await this.reverseAndTrail(name, b, mine, ords, net, lossCap);
    }
  }
  /** STOP-AND-REVERSE : (1) si le STOP opposé a été touché -> on ferme l'ancien sens aussitôt ; (2) sinon le STOP opposé suit le prix. */
  async reverseAndTrail(name, b, mine, ords, net, lossCap) {
    const s = this.sess(), cfg = this.config, sp = s.specs[name];
    const cur = mine.filter(p => p.side === b.side), opp = mine.filter(p => p.side !== b.side);
    if (opp.length) {
      // le STOP opposé est touché : les positions de l'ancien sens sont fermées tout de suite (pas de verrouillage BUY+SELL)
      for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { /* déjà exécuté ou annulé */ } }
      let failed = 0, legPnl = 0;
      for (const p of cur) {
        try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); legPnl = r2(legPnl + p.pnl); }
        catch (e) { failed++; this.log(`${name} : fermeture ${p.side} ${p.id} : ${e && e.message}`); }
      }
      if (failed) { b.realized = r2((b.realized || 0) + legPnl); return; }   // on recommence au prochain cycle ; b.side ne change qu'une fois l'ancien sens totalement fermé
      const from = b.side, to = opp[0].side, legTotal = r2(legPnl + (b.realized || 0)); b.realized = 0;
      this.recordLeg(name, b, from, legTotal, cur.length);
      if (cfg.sessionFilter && !inSession(this.now())) {   // fin de session : on ne repart pas dans l'autre sens
        let oppPnl = 0, okAll = true;
        for (const p of opp) { try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); oppPnl = r2(oppPnl + p.pnl); } catch (e) { okAll = false; } }
        if (okAll) { this.recordLeg(name, b, opp[0].side, oppPnl, opp.length); this.log(`${name} : STOP touché hors session -> trade fermé, pas d'inversion`); delete this.baskets[name]; this.lastCooldown[name] = this.now(); this.save(); }
        else { b.side = opp[0].side; b.realized = 0; }
        return;
      }
      b.flips = (b.flips || 0) + 1; b.side = to; b.n = opp.length;
      b.entry = opp.reduce((a, p) => a + p.price * p.volume, 0) / opp.reduce((a, p) => a + p.volume, 0);
      b.baseVolume = opp.reduce((a, p) => a + p.volume, 0); b.lastTrail = 0; b.openCost = null; b.openedAt = this.now();
      this.log(`${name} : STOP touché -> ${from} fermé (${legTotal >= 0 ? '+' : ''}${legTotal} $), ${to} actif`);
      this.save();
      return;
    }
    if (!cur.length || !cfg.hedge.enabled) return;
    if (this.now() - (b.lastTrail || 0) < TRAIL_EVERY_MS) return;
    const q = this.quote(name); if (!q) return;
    const long = b.side === 'BUY', oppSide = long ? 'SELL' : 'BUY', zone = b.zone || (q.ask - q.bid) * 3;
    const target = long ? q.bid - zone : q.ask + zone, o = ords[0] || null;
    const step = Math.max(Math.pow(10, -sp.digits) * 2, (q.ask - q.bid) * 0.25);   // le STOP se rapproche dès que le prix bouge un peu
    if (o) {
      const better = long ? target - o.stopPrice : o.stopPrice - target;   // le STOP ne fait que se rapprocher du prix
      if (!(better >= step)) return;
      b.lastTrail = this.now();
      try { await s.cancelOrder(o.id); } catch (e) { return; }   // déjà déclenché : l'inversion sera traitée au prochain cycle
    } else b.lastTrail = this.now();
    const px = long ? Math.min(target, q.bid - Math.pow(10, -sp.digits)) : Math.max(target, q.ask + Math.pow(10, -sp.digits));
    try { await this.stop(name, oppSide, b.baseVolume, px, b.id, b.slDist); b.stopPx = px; }
    catch (e) { this.log(`${name} : STOP ${oppSide} suiveur refusé : ${e && e.message}`); }
  }
  async hunt() {
    const s = this.sess(), cfg = this.config, t = this.now();
    const floating = Object.keys(this.baskets).reduce((a, n) => a + this.basketNet(this.baskets[n]), 0);
    if (this.day.startBalance > 0 && (this.day.pnl || 0) + floating <= -(this.day.startBalance * cfg.maxDailyLossPct / 100)) {
      this.pausedUntilDay = this.dayKey(); this.log(`perte journalière max atteinte (${cfg.maxDailyLossPct} %) — robot en pause jusqu'à demain`); this.save(); return;
    }
    const sessionOk = !cfg.sessionFilter || inSession(t);
    for (const want of cfg.symbols) {
      if (Object.keys(this.baskets).length >= cfg.maxOpenBaskets) break;
      const name = this.resolve(want);
      if (!name) { this.signals[want] = { action: 'WAIT', reason: 'symbole introuvable chez le broker', at: t }; continue; }
      if (this.baskets[name]) continue;
      if (!sessionOk) { this.signals[name] = { action: 'WAIT', reason: 'hors session (Londres 08:00-17:00 / New York 08:00-17:00, lun-ven)', at: t }; continue; }
      if (t - (this.lastCooldown[name] || 0) < cfg.cooldownSec * 1000) continue;
      let bars; try { bars = await this.bars(name); } catch (e) { this.signals[name] = { action: 'WAIT', reason: 'historique indisponible', at: t }; continue; }
      let sig = computeSignal(bars);
      this.signals[name] = Object.assign({ at: t }, sig);
      if (sig.action === 'WAIT') continue;
      const q = this.quote(name); if (!q) { this.signals[name].reason = 'pas de prix en direct'; continue; }
      if (q.ask - q.bid > sig.atr * cfg.maxSpreadAtr) { this.signals[name].reason = 'spread trop large (' + r2(q.ask - q.bid) + ')'; continue; }
      await this.openBasket(name, sig, q);
      await this.refresh().catch(() => {});   // le panel Trade voit tout de suite les positions et le STOP
    }
  }
  async openBasket(name, sig, q) {
    const s = this.sess(), cfg = this.config, sp = s.specs[name], id = 'SS' + name.slice(0, 6) + this.now().toString(36);
    const side = sig.action, entry = side === 'BUY' ? q.ask : q.bid, zone = Math.max(sig.atr * cfg.hedge.zoneAtr, (q.ask - q.bid) * 3);
    const slDist = Math.max(sig.atr * cfg.emergencySlAtr, zone * 2.5), lots = this.lotsFor(name, slDist);
    // petit compte : le lot minimal du broker peut être trop gros pour le solde -> on n'entre pas (protège le compte)
    const bal = num(s.balance, 0), spreadCost = (q.ask - q.bid) * lots * this.unitsPerLot(sp) * cfg.positionsPerBasket;
    if (Math.max(bal * cfg.maxBasketLossPct / 100, spreadCost * 4) > bal * 0.5) {
      if (this.signals[name]) this.signals[name].reason = `solde ${r2(bal)} $ trop petit pour ${name} (lot minimal ${lots} = coût/risque trop élevé)`;
      if (!this._smallWarn || this.now() - this._smallWarn > 60000) { this._smallWarn = this.now(); this.log(`${name} : solde trop petit pour le lot minimal du broker (${lots}) : pas d'entrée`); }
      return;
    }
    const b = { id, symbol: name, side, entry, lots, lotMult: this.lotMult(), openedAt: this.now(), flips: 0, n: 0, realized: 0, baseVolume: 0, hedgePx: side === 'BUY' ? entry - zone : entry + zone, zone, slDist };
    let opened = 0;
    for (let i = 0; i < cfg.positionsPerBasket; i++) {
      try { await this.market(name, side, lots, id, slDist); opened++; }
      catch (e) { this.log(`${name} : ordre ${side} refusé : ${e && e.message}`); break; }
    }
    if (!opened) return;
    b.n = opened; b.baseVolume = s._volume(sp, lots) * opened;
    this.baskets[name] = b;
    this.log(`${name} : ${side} × ${opened} positions (${r2(lots)} lot chacune, cran ${this.lotLevel}) — ${sig.reason}`);
    if (cfg.hedge.enabled && cfg.hedge.maxFlips > 0) {
      const opp = side === 'BUY' ? 'SELL' : 'BUY';
      try { await this.stop(name, opp, b.baseVolume, b.hedgePx, id, slDist); this.log(`${name} : ${opp} STOP suiveur placé à ${Number(b.hedgePx).toFixed(sp.digits)} (il suit le prix)`); }
      catch (e) { this.log(`${name} : STOP ${opp} refusé : ${e && e.message}`); }
    }
    this.save();
  }

  // ---------- vue pour l'interface ----------
  status() {
    const s = this.sess(), conn = this.connected(), dk = this.dayKey();
    const baskets = Object.keys(this.baskets).map(name => {
      const b = this.baskets[name], mine = this.live.positions.filter(p => p.basket === b.id), q = conn ? this.quote(name) : null, sp = conn && s.specs[name];
      const sum = (side, f) => r2(mine.filter(p => p.side === side).reduce((a, p) => a + (f(p) || 0), 0));
      const target = this.targetFor(b), net = this.basketNet(b);
      return {
        symbol: name, id: b.id, side: b.side, lotsPerPosition: r2(b.lots), lotMult: b.lotMult || 1, positions: mine.length, entry: b.entry, flips: b.flips || 0, maxFlips: this.config.hedge.maxFlips,
        net, target, targetAuto: this.config.autoTarget, progress: target > 0 ? Math.max(0, Math.min(100, net / target * 100)) : 0, openedAt: b.openedAt,
        bid: q ? q.bid : null, ask: q ? q.ask : null, digits: sp ? sp.digits : 2,
        buy: { count: mine.filter(p => p.side === 'BUY').length, lots: sum('BUY', p => p.lots), pnl: sum('BUY', p => p.pnl) },
        sell: { count: mine.filter(p => p.side === 'SELL').length, lots: sum('SELL', p => p.lots), pnl: sum('SELL', p => p.pnl) },
        pending: this.live.orders.filter(o => o.basket === b.id).map(o => ({ id: o.id, side: o.side, price: o.stopPrice, lots: sp ? r2(o.volume / sp.lotSize) : null })),
        items: mine.map(p => ({ id: p.id, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl })), closing: b.closing || null
      };
    });
    const total = this.stats.wins + this.stats.losses;
    return {
      ok: true, active: this.active, connected: conn, state: !conn ? 'CTRADER NON CONNECTÉ' : this.pausedUntilDay === dk ? 'PAUSE (perte jour max)' : this.active ? (baskets.length ? 'EN TRADE' : 'ANALYSE') : 'ARRÊTÉ',
      account: conn ? { balance: s.balance, freeMargin: s.freeMargin, accountId: s.accountId } : null,
      config: this.config, lotLevel: this.lotLevel, baskets, signals: this.signals, serverTime: this.now(), liveAt: this.live.at,
      stats: Object.assign({}, this.stats, { winRate: total ? r2(this.stats.wins / total * 100) : null, total }),
      day: { date: this.day.date, pnl: r2(this.day.pnl || 0) }, orphans: this.orphans || [], history: this.history.slice(0, 50), logs: this.logs.slice(0, 40), error: this.live.error
    };
  }
}

module.exports = function createScalper({ manager, dataRoot, now }) {
  const users = new Map();
  const createdTick = async () => { for (const u of users.values()) await u.tick(); };
  const get = uid => { if (!users.has(uid)) users.set(uid, new UserScalper({ userId: uid, dataRoot, manager, now })); return users.get(uid); };
  const emergencyStop = async uid => { const u = get(uid); u.active = false; u.save(); try { await u.closeAll('ARRÊT D\'URGENCE'); } catch (e) { /* ignore */ } return { ok: true }; };
  return {
    get,
    tickAll: async () => { for (const u of users.values()) await u.tick(); },
    // démarrage : reprend les utilisateurs déjà enregistrés (fichiers scalper-<id>.json) et coupe l'ancienne stratégie du moteur IA Mentor
    start: ids => {
      if (!module.exports._fast) { module.exports._fast = setInterval(() => { createdTick().catch(() => {}); }, 300); if (module.exports._fast.unref) module.exports._fast.unref(); }
      const all = new Set(ids || []);
      try { fs.readdirSync(dataRoot).forEach(f => { const m = /^scalper-([A-Za-z0-9_-]+)\.json$/.exec(f); if (m) all.add(m[1]); }); } catch (e) { /* dossier absent : premier démarrage */ }
      all.forEach(id => { get(id); try { manager.engine(id).setAutoTrade(false); } catch (e) { /* ancien moteur absent */ } });
    },
    emergencyStop,
    emergencyStopAll: async () => { for (const id of Array.from(users.keys())) await emergencyStop(id); return { ok: true }; }
  };
};
module.exports.computeSignal = computeSignal;
module.exports.entryBias = entryBias;
module.exports.inSession = inSession;
module.exports.sanitizeConfig = sanitizeConfig;
module.exports.UserScalper = UserScalper;
module.exports.DEFAULTS = DEFAULTS;
