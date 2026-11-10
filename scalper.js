'use strict';
/**
 * ARES HFT — robot cTrader (Open API) : scalping TICK à haute fréquence sur XAUUSD + EURUSD.
 * Remplace TOUTES les anciennes stratégies (LOR, OPR, SMC / IA Mentor). Moteur de signal : hft-engine.js.
 *
 *  1. Le robot écoute les ticks bid/ask LIVE du broker (événements SPOT de cTrader) : aucune bougie, aucune donnée simulée.
 *  2. À chaque tick, hft-engine.js cherche une impulsion courte et propre, dans le sens de la micro-tendance, avec un spread faible.
 *  3. Entrée au MARCHÉ en 2, 4 ou 5 POSITIONS selon le score d'assurance du signal (0-100) : peu assuré = 2, assuré = 4, très assuré = 5.
 *     Même SL pour toutes, TP étagés (le premier proche, le dernier plus loin), posés par le broker dès l'ouverture. Le lot est calculé par le robot :
 *     risque % × multiplicateur (×1 / ×1,5 / ×2), plafonné à `maxTotalRiskPct` du solde, puis réparti sur les positions. 1 trade (groupe) par paire.
 *  4. Gestion : dès qu'un TP est touché (ou après `lockAtFrac` du TP) le SL des positions restantes est remonté (gain verrouillé), sortie au temps (`maxHoldSec`), cooldown, limite de trades
 *     par minute / par jour, garde de latence, spread, session et fenêtres de pause (UTC). Pertes max jour / semaine / série.
 *  5. Lot calculé automatiquement : risque (% du solde) ÷ distance du SL. Aucun profit n'est garanti.
 *
 * Réalité technique : serveur Render -> cTrader Open API, donc latence de l'ordre de 100 ms à 1 s. C'est du scalping haute
 * fréquence, pas du HFT de colocation. Le module utilise la session cTrader existante (manager.session(userId)).
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');
const HFT = require('./hft-engine');

const LABEL = 'ARESSCALP';          // même label qu'avant : les anciennes positions / ordres orphelins sont fermés / annulés automatiquement
const CFG_VERSION = 'hft-2';        // une autre version (ancien robot LOR) : on garde seulement les paires, statistiques remises à zéro
const BOT_NAME = 'ARES HFT';
const ORPHAN_GRACE_MS = 15000, OPEN_WAIT_MS = 9000, EMPTY_GRACE_MS = 1500;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');
const PAIRS = ['XAUUSD', 'EURUSD'];
const LADDER = { 1: [1], 2: [0.8, 1.4], 4: [0.6, 0.9, 1.2, 1.7], 5: [0.6, 0.8, 1.0, 1.4, 1.8] };   // TP de chaque position, en multiples de tpBp
const tid = b => String(b || '').split('-')[0];   // commentaire d'une position = <id du trade>-<n° de position>

const DEFAULTS = {
  symbols: ['XAUUSD', 'EURUSD'],
  // --- risque ---
  riskPct: 0.5,              // % du solde risqué par trade (jusqu'au SL)
  fixedLot: 0,               // > 0 : lot fixe (ignore riskPct)
  maxLotPerPosition: 50,
  maxOpenTrades: 2,          // 1 trade (groupe de positions) par paire -> 2 au maximum
  minScore: 55, score4: 70, score5: 85,   // score d'assurance du signal : < 55 pas de trade · 55-69 = 2 positions · 70-84 = 4 positions · 85+ = 5 positions
  riskMult4: 1.5, riskMult5: 2,           // risque du trade = riskPct × 1 (2 positions) / × riskMult4 (4 positions) / × riskMult5 (5 positions)
  maxTotalRiskPct: 1.5,                   // plafond du risque TOTAL d'un trade (% du solde), toutes positions confondues
  maxDailyLossPct: 3,        // perte maximale du jour (% du solde de début de journée) : pause jusqu'au lendemain (0 = off)
  maxWeeklyLossPct: 0,       // perte maximale de la semaine (0 = off)
  maxConsecLosses: 5,        // pause du jour après N pertes de suite (0 = off)
  // --- cadence ---
  cooldownSec: 15,           // pause minimale entre deux trades d'une même paire
  maxTradesPerMin: 4,        // trades ouverts au maximum par minute (toutes paires)
  maxTradesPerDay: 150,      // 0 = pas de limite
  maxLatencyMs: 900,         // si l'ordre met plus longtemps à être accepté (moyenne), le robot s'arrête de trader (le temps que ça revienne)
  // --- session ---
  sessionFilter: true, sessionStartUtc: 7, sessionEndUtc: 20,   // lundi-vendredi, heures UTC (Londres + New York)
  blockWindows: '',          // fenêtres de pause UTC « HH:MM-HH:MM » séparées par des virgules (ex. annonces : 12:25-12:50,14:55-15:10)
  // --- signal tick + sortie (en bp du prix : 1 bp = 0,01 %) ---
  impulseBp: HFT.DEFAULTS.impulseBp, maxImpulseBp: HFT.DEFAULTS.maxImpulseBp, windowMs: HFT.DEFAULTS.windowMs, minTicks: HFT.DEFAULTS.minTicks,
  dirFrac: HFT.DEFAULTS.dirFrac, maxSpreadBp: HFT.DEFAULTS.maxSpreadBp, tpBp: HFT.DEFAULTS.tpBp, slBp: HFT.DEFAULTS.slBp,
  maxHoldSec: 60,            // sortie au temps : le trade est fermé au marché après N secondes
  lockAtFrac: 0.6            // quand le gain atteint 60 % du TP, le SL est remonté (le gain est verrouillé) ; 0 = off
};

/** fenêtres « HH:MM-HH:MM » -> [[début, fin] en minutes UTC] */
function parseWindows(s) {
  const out = [];
  String(s || '').split(',').forEach(x => {
    const m = /^\s*([01]?\d|2[0-3]):([0-5]\d)\s*-\s*([01]?\d|2[0-3]):([0-5]\d)\s*$/.exec(x);
    if (m) out.push([Number(m[1]) * 60 + Number(m[2]), Number(m[3]) * 60 + Number(m[4])]);
  });
  return out.slice(0, 12);
}
const inBlock = (t, wins) => { const d = new Date(t), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return wins.some(w => (w[0] <= w[1] ? m >= w[0] && m < w[1] : m >= w[0] || m < w[1])); };
/** Session : lundi-vendredi, [sessionStartUtc ; sessionEndUtc[ en UTC. */
const inSession = (t, c) => { const d = new Date(t), dow = d.getUTCDay(), h = d.getUTCHours(), cc = c || DEFAULTS; return dow >= 1 && dow <= 5 && h >= cc.sessionStartUtc && h < cc.sessionEndUtc; };

// compatibilité (anciens imports) : plus aucune stratégie à bougies
function computeSignal() { return { action: 'WAIT', reason: BOT_NAME + ' : stratégie tick (hft-engine.js)' }; }
const entryBias = (bars, sig) => sig;

function sanitizeConfig(src, cur) {
  const c = JSON.parse(JSON.stringify(cur || DEFAULTS));
  if (!src || typeof src !== 'object') return c;
  const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
  const int = (k, lo, hi) => { n(k, lo, hi); c[k] = Math.round(c[k]); };
  if (Array.isArray(src.symbols)) { const s = src.symbols.slice(0, 12).map(norm).filter(x => PAIRS.indexOf(x) >= 0); if (s.length) c.symbols = Array.from(new Set(s)); }
  if (typeof src.sessionFilter === 'boolean') c.sessionFilter = src.sessionFilter;
  if (typeof src.blockWindows === 'string') c.blockWindows = parseWindows(src.blockWindows).length || !src.blockWindows.trim() ? src.blockWindows.trim().slice(0, 200) : c.blockWindows;
  n('riskPct', 0.05, 5); n('fixedLot', 0, 100); n('maxLotPerPosition', 0.01, 100); int('maxOpenTrades', 1, 2);
  int('minScore', 30, 95); int('score4', 31, 98); int('score5', 32, 99); n('riskMult4', 1, 4); n('riskMult5', 1, 6); n('maxTotalRiskPct', 0.1, 5);
  if (c.score4 <= c.minScore) c.score4 = Math.min(98, c.minScore + 10);
  if (c.score5 <= c.score4) c.score5 = Math.min(99, c.score4 + 10);
  n('maxDailyLossPct', 0, 90); n('maxWeeklyLossPct', 0, 90); int('maxConsecLosses', 0, 50);
  int('cooldownSec', 0, 3600); int('maxTradesPerMin', 1, 30); int('maxTradesPerDay', 0, 2000); int('maxLatencyMs', 100, 5000);
  int('sessionStartUtc', 0, 23); int('sessionEndUtc', 1, 24);
  if (c.sessionEndUtc <= c.sessionStartUtc) { c.sessionStartUtc = DEFAULTS.sessionStartUtc; c.sessionEndUtc = DEFAULTS.sessionEndUtc; }
  n('impulseBp', 0.2, 20); n('maxImpulseBp', 1, 60); int('windowMs', 300, 10000); int('minTicks', 2, 60); n('dirFrac', 0.5, 1);
  n('maxSpreadBp', 0.2, 20); n('tpBp', 0.5, 100); n('slBp', 0.5, 100); int('maxHoldSec', 3, 3600); n('lockAtFrac', 0, 0.95);
  if (c.maxImpulseBp <= c.impulseBp) c.maxImpulseBp = c.impulseBp * 3;
  return c;
}

class UserScalper {
  constructor({ userId, dataRoot, manager, now }) {
    this.userId = userId; this.manager = manager; this.now = now || (() => Date.now());
    this.file = path.join(dataRoot, 'scalper-' + userId + '.json');
    this.active = false; this.config = JSON.parse(JSON.stringify(DEFAULTS));
    this.trades = {}; this.setups = this.trades;                 // symbole -> trade en cours (alias « setups » gardé pour compatibilité)
    this.stats = this._freshStats();
    this.history = []; this.logs = []; this.signals = {};
    this.day = { date: null, startBalance: null, pnl: 0, trades: 0 }; this.pausedUntilDay = null; this.week = { key: null, startBalance: null, pnl: 0 }; this.consec = 0;
    this.live = { positions: [], orders: [], pnlById: {}, at: 0, error: null };
    this.books = {}; this.lastQ = {}; this.idToName = {}; this.wantSet = {}; this.inflight = {}; this.lastExit = {}; this.entryTimes = [];
    this.lat = { ewma: null, n: 0, last: null }; this.busy = false; this.lastTick = 0; this.lastIdleCheck = 0; this.orphans = []; this.seq = 0;
    this._client = null; this._s = null; this._block = []; this._blockSrc = null; this.lastRiskLog = 0;
    this._load();
  }
  _freshStats() { return { since: this.now(), trades: 0, wins: 0, losses: 0, pnl: 0, best: 0, worst: 0, grossWin: 0, grossLoss: 0, holdMs: 0, slipBp: 0, slipN: 0, ackMs: 0, ackN: 0, byResult: {}, bySymbol: {} }; }
  log(msg) { this.logs.unshift({ t: new Date(this.now()).toISOString(), msg: String(msg).slice(0, 240) }); if (this.logs.length > 150) this.logs.length = 150; }
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')), same = j.cfgVersion === CFG_VERSION;
      if (j.config) this.config = same ? sanitizeConfig(j.config, DEFAULTS) : sanitizeConfig({ symbols: j.config.symbols }, DEFAULTS);
      this.active = same && j.active === true;
      if (same) {
        if (j.stats) this.stats = Object.assign(this._freshStats(), j.stats);
        if (Array.isArray(j.history)) this.history = j.history.slice(0, 300);
        if (j.trades && typeof j.trades === 'object') { this.trades = j.trades; this.setups = this.trades; }
        if (j.day) this.day = Object.assign(this.day, j.day); if (j.pausedUntilDay) this.pausedUntilDay = j.pausedUntilDay; if (j.week) this.week = j.week; this.consec = Number(j.consec) || 0;
      }
    } catch (e) { /* premier démarrage : statistiques à zéro */ }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ cfgVersion: CFG_VERSION, active: this.active, config: this.config, stats: this.stats, history: this.history.slice(0, 300), trades: this.trades, day: this.day, pausedUntilDay: this.pausedUntilDay, week: this.week, consec: this.consec }));
    } catch (e) { /* ignore */ }
  }
  sess() { try { return this.manager.session(this.userId); } catch (e) { return null; } }
  connected() { const s = this.sess(); return !!(s && s.status === 'CONNECTED' && s.client && s.client.ready && s.accountId); }

  setActive(on) {
    this.active = on === true;
    if (this.active) { this.pausedUntilDay = null; try { this.manager.engine(this.userId).setAutoTrade(false); } catch (e) { /* ancien moteur absent */ } }
    this.log(this.active ? BOT_NAME + ' activé' : BOT_NAME + ' arrêté (le trade en cours reste suivi jusqu\'à sa clôture)');
    this.save(); return { ok: true, active: this.active };
  }
  setConfig(src) { this.config = sanitizeConfig(src, this.config); this._wantSymbols(); this.save(); return { ok: true, config: this.config }; }
  resetStats() { this.stats = this._freshStats(); this.history = []; this.save(); return { ok: true }; }
  hftCfg() { const c = this.config; return { windowMs: c.windowMs, impulseBp: c.impulseBp, maxImpulseBp: c.maxImpulseBp, minTicks: c.minTicks, dirFrac: c.dirFrac, maxSpreadBp: c.maxSpreadBp, tpBp: c.tpBp, slBp: c.slBp }; }

  // ---------- flux de ticks (événements SPOT du broker) ----------
  book(name) { return this.books[name] || (this.books[name] = new HFT.TickBook(120000)); }
  _wantSymbols() { this.wantSet = {}; const s = this.sess(); (this.config.symbols || []).forEach(w => { const n = this.resolve(w); if (n) this.wantSet[n] = true; }); return s; }
  /** branche l'écoute des événements du client cTrader (une seule fois par client) et met à jour la table symbolId -> nom */
  attach() {
    const s = this.sess(); if (!s || !s.client) return;
    this._s = s; this.idToName = {};
    Object.keys(s.specs || {}).forEach(n => { this.idToName[String(s.specs[n].symbolId)] = n; });
    this._wantSymbols();
    if (this._client !== s.client) {
      this._client = s.client; this.lastQ = {};
      Object.keys(this.wantSet).forEach(n => { const q = this.quote(n); if (q) this.lastQ[n] = { bid: q.bid, ask: q.ask }; });
      s.client.on('message', m => { try { this.onMsg(m); } catch (e) { this.live.error = 'tick : ' + String(e && e.message || e).slice(0, 120); } });
    }
  }
  onMsg(m) {
    if (!m) return; const p = m.payload || {};
    if (m.payloadType === PT.SPOT_EVENT) this.onSpot(p);
    else if (m.payloadType === PT.EXECUTION_EVENT) this.onExec(p);
  }
  onSpot(p) {
    const name = this.idToName[String(p.symbolId)]; if (!name || !this.wantSet[name]) return;
    const q = this.lastQ[name] || (this.lastQ[name] = { bid: 0, ask: 0 });
    if (p.bid != null) q.bid = Number(p.bid) / 1e5; if (p.ask != null) q.ask = Number(p.ask) / 1e5;
    if (!(q.bid > 0 && q.ask > 0)) return;
    const t = this.now(); if (!this.book(name).push(t, q.bid, q.ask)) return;
    this.react(name, t);
  }
  /** à chaque nouveau tick : évalue le signal ; si signal, tente l'entrée (jamais bloquant pour le flux de ticks) */
  react(name, t) {
    const sig = HFT.evaluate(this.book(name), this.hftCfg(), t); sig.symbol = name; delete sig.ema;
    if (sig.action !== 'WAIT') { sig.score = HFT.score(sig, this.hftCfg()); sig.legs = this.legsFor(sig.score); }
    this.signals[name] = sig;
    if (sig.action !== 'WAIT') this.enter(name, sig, t).catch(e => { this.log(name + ' : erreur entrée : ' + (e && e.message)); });
  }
  legsFor(score) { const c = this.config; return score >= c.score5 ? 5 : score >= c.score4 ? 4 : score >= c.minScore ? 2 : 0; }
  riskMult(n) { const c = this.config; return n >= 5 ? c.riskMult5 : n >= 4 ? c.riskMult4 : 1; }
  /** résultat réel d'une clôture : somme brute + swap + commission du deal de clôture (EXECUTION_EVENT du broker) */
  onExec(p) {
    const d = p && p.deal, pos = p && p.position; if (!d || !d.closePositionDetail || !pos || !pos.tradeData || pos.tradeData.label !== LABEL) return;
    const comment = String(pos.tradeData.comment || ''), id = tid(comment), name = Object.keys(this.trades).find(k => this.trades[k].id === id); if (!name) return;
    const st = this.trades[name], cpd = d.closePositionDetail, md = cpd.moneyDigits != null ? Number(cpd.moneyDigits) : (d.moneyDigits != null ? Number(d.moneyDigits) : (this._s && this._s.moneyDigits != null ? Number(this._s.moneyDigits) : 2));
    const net = r2((Number(cpd.grossProfit) + Number(cpd.swap || 0) + Number(cpd.commission || 0) + Number(cpd.pnlConversionFee || 0)) / Math.pow(10, md)), px = Number(d.executionPrice) || null;
    st.realized = r2((st.realized || 0) + net); st.legsClosed = (st.legsClosed || 0) + 1; st.gotClose = true; st.closePx = px; st.closedAt = this.now();
    const lg = (st.legs || [])[Number(comment.split('-')[1]) - 1];   // position fermée à son propre TP ?
    if (lg && lg.tpPx != null && px != null && !st.closing && net > 0) { const eps = lg.tpDist * 0.03; if (st.side === 'BUY' ? px >= lg.tpPx - eps : px <= lg.tpPx + eps) { st.tpHits = (st.tpHits || 0) + 1; lg.hit = true; } }
  }

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
      volume: Number(o.tradeData.volume), price: Number(o.limitPrice != null ? o.limitPrice : o.stopPrice), basket: String(o.tradeData.comment || ''), type: o.orderType
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
  quote(name) { const s = this.sess(), sp = s && s.specs && s.specs[name], q = sp && s.quotes[String(sp.symbolId)]; return (!q || !(q.bid > 0) || !(q.ask > 0)) ? null : q; }
  resolve(want) {
    const s = this.sess(), specs = (s && s.specs) || {}, w = norm(want); if (specs[w]) return w;
    const keys = Object.keys(specs); let k = keys.find(x => x.startsWith(w));
    if (!k && w === 'XAUUSD') k = keys.find(x => x === 'GOLD' || x.startsWith('GOLD') || x.startsWith('XAU'));
    return k || null;
  }
  unitsPerLot(sp) { return Math.max(1e-9, sp.lotSize / 100); }
  /** lot : le risque (riskPct % du solde) divisé par la distance du SL ; ramené aux limites du broker */
  lotsFor(name, slDist) {
    const s = this.sess(), sp = s.specs[name], bal = num(s.balance, 0), step = sp.lotStep || 0.01, min = sp.minLot || 0.01, max = Math.min(this.config.maxLotPerPosition, sp.maxLot || 1e9);
    const fl = v => Math.round(Math.floor(v / step + 1e-9) * step * 1e6) / 1e6;
    if (this.config.fixedLot > 0) return clamp(Math.max(min, fl(this.config.fixedLot)), min, max);
    const riskUsd = bal * this.config.riskPct / 100, total = slDist > 0 ? riskUsd / (slDist * this.unitsPerLot(sp)) : min;
    return clamp(Math.max(min, fl(total)), min, max);
  }
  noteLat(ms) { this.lat.last = ms; this.lat.n++; this.lat.ewma = this.lat.ewma == null ? ms : this.lat.ewma * 0.8 + ms * 0.2; }

  // ---------- entrée ----------
  weekHit() { const c = this.config; return c.maxWeeklyLossPct > 0 && this.week.startBalance > 0 && -(this.week.pnl || 0) >= this.week.startBalance * c.maxWeeklyLossPct / 100; }
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }
  weekKey() { const d = new Date(this.now()), dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10); }
  /** raison pour laquelle on ne trade pas maintenant (null = tout est bon) */
  gate(name, t) {
    const c = this.config;
    if (!this.active) return 'robot arrêté';
    if (!this.connected()) return 'cTrader non connecté';
    if (this.pausedUntilDay === this.dayKey() || this.weekHit()) return 'pause (limite de perte)';
    if (c.sessionFilter && !inSession(t, c)) return 'hors session';
    if (this._blockSrc !== c.blockWindows) { this._blockSrc = c.blockWindows; this._block = parseWindows(c.blockWindows); }
    if (this._block.length && inBlock(t, this._block)) return 'fenêtre de pause (UTC)';
    if (this.trades[name] || this.inflight[name]) return 'trade déjà en cours sur ' + name;
    if (Object.keys(this.trades).length >= c.maxOpenTrades) return 'limite de trades ouverts';
    if (t - (this.lastExit[name] || 0) < c.cooldownSec * 1000) return 'cooldown';
    this.entryTimes = this.entryTimes.filter(x => t - x < 60000);
    if (this.entryTimes.length >= c.maxTradesPerMin) return 'limite de trades par minute';
    if (c.maxTradesPerDay > 0 && (this.day.trades || 0) >= c.maxTradesPerDay) return 'limite de trades du jour';
    if (this.lat.ewma != null && this.lat.ewma > c.maxLatencyMs) return 'latence trop haute (' + Math.round(this.lat.ewma) + ' ms)';
    return null;
  }
  /** plan d'entrée : nombre de positions (2 / 4 / 5) et lot par position. Si le lot minimal du broker dépasse le risque voulu, on réduit le nombre de positions. */
  plan(name, n0, slDist) {
    const s = this.sess(), sp = s.specs[name], c = this.config, bal = num(s.balance, 0), step = sp.lotStep || 0.01, min = sp.minLot || 0.01, max = Math.min(c.maxLotPerPosition, sp.maxLot || 1e9);
    const fl = v => Math.round(Math.floor(v / step + 1e-9) * step * 1e6) / 1e6, upl = this.unitsPerLot(sp);
    for (const n of [5, 4, 2, 1]) {
      if (n > n0) continue;
      if (c.fixedLot > 0) return { n, per: clamp(Math.max(min, fl(c.fixedLot)), min, max) };
      const riskPct = Math.min(c.riskPct * this.riskMult(n), c.maxTotalRiskPct), total = slDist > 0 ? bal * riskPct / 100 / (slDist * upl) : min * n, per = fl(total / n);
      if (per >= min) return { n, per: Math.min(per, max) };
    }
    return { n: 1, per: min };
  }
  async enter(name, sig, t) {
    const why = this.gate(name, t); sig.gate = why; if (why) return;
    const cfg = this.config, n0 = sig.legs || 0;
    if (n0 < 1) { sig.gate = 'score trop bas (' + sig.score + ' < ' + cfg.minScore + ')'; return; }
    const s = this.sess(), sp = s.specs[name], q = this.lastQ[name], L = sig.action === 'BUY';
    if (!sp || !q) return;
    const px = L ? q.ask : q.bid, lv = HFT.levels(px, this.hftCfg()), bal = num(s.balance, 0), upl = this.unitsPerLot(sp), pl = this.plan(name, n0, lv.sl), n = pl.n, ladder = LADDER[n] || [1];
    if (ladder[0] * cfg.tpBp < 1.5 * (sig.spreadBp || 0)) { sig.gate = 'TP1 trop proche du spread'; return; }
    const risk$ = n * pl.per * lv.sl * upl;
    if (cfg.fixedLot <= 0 && risk$ > Math.max(bal * cfg.maxTotalRiskPct / 100 * 2, 0.5) && risk$ > bal * 0.10) {
      sig.gate = 'lot minimal trop gros pour le solde (risque ' + r2(risk$) + ' $)'; if (t - this.lastRiskLog > 60000) { this.lastRiskLog = t; this.log(name + ' : ' + sig.gate); } return;
    }
    const id = 'H' + name.slice(0, 3) + (this.seq++ % 36).toString(36) + t.toString(36), legs = ladder.map((m, i) => ({ i: i + 1, lots: pl.per, tpMult: m, tpDist: lv.tp * m }));
    const st = { id, symbol: name, side: sig.action, n, score: sig.score, legs, lots: r2(n * pl.per), slBp: cfg.slBp, tpBp: cfg.tpBp, slDist: lv.sl, tpDist: lv.tp, refPx: px, spreadBp: sig.spreadBp, sigAt: t, sentAt: t, state: 'ENVOI', opened: false, locked: false, lockIds: {}, last: 0, realized: 0, legsClosed: 0, tpHits: 0, sent: 0, maxCount: 0, maxFav: null, reason: sig.reason };
    this.inflight[name] = true; this.trades[name] = st; this.save();   // enregistré AVANT l'envoi : un ordre n'est jamais orphelin
    let vol = s._volume(sp, pl.per); if (sp.maxVolume > 0) vol = Math.min(vol, sp.maxVolume);
    try {
      const t0 = Date.now();
      const res = await Promise.all(legs.map(lg => s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 1, tradeSide: L ? 1 : 2, volume: vol, relativeStopLoss: s._grid(sp, lv.sl), relativeTakeProfit: s._grid(sp, lg.tpDist), label: LABEL, comment: id + '-' + lg.i })
        .then(() => true, e => { this.log(`${name} : position ${lg.i} refusée : ` + (e && e.message)); return false; })));
      const ok = res.filter(Boolean).length; st.ackMs = Date.now() - t0;
      if (!ok) { this.log(name + ' : aucune position ouverte'); delete this.trades[name]; this.lastExit[name] = this.now(); return; }
      this.noteLat(st.ackMs); st.sent = ok; st.state = 'ENVOYÉ';
      this.entryTimes.push(t); this.day.trades = (this.day.trades || 0) + 1;
      this.log(`${name} : ${sig.action} marché · ${ok}/${n} positions × ${pl.per} lot · score ${sig.score} · SL ${cfg.slBp} bp · TP ${ladder.map(m => r2(m * cfg.tpBp)).join('/')} bp · ack ${st.ackMs} ms`);
    } catch (e) {
      this.log(name + ' : ordre refusé : ' + (e && e.message)); delete this.trades[name]; this.lastExit[name] = this.now();
    } finally { this.inflight[name] = false; this.save(); }
  }

  // ---------- fermeture / suivi ----------
  async closePos(p, why) { const s = this.sess(); try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); return true; } catch (e) { this.log('clôture ' + p.id + (why ? ' (' + why + ')' : '') + ' : ' + (e && e.message)); return false; } }
  async amendLock(p, st) {
    const s = this.sess(), sp = s.specs[p.symbol], lg = (st.legs || [])[Number(String(p.basket).split('-')[1]) - 1], tp = lg && lg.tpPx != null ? lg.tpPx : (st.side === 'BUY' ? st.fill + st.tpDist : st.fill - st.tpDist);
    await s.client.request(PT.AMEND_POSITION_SLTP_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), stopLoss: Number(Number(st.lockPx).toFixed(sp.digits)), takeProfit: Number(Number(tp).toFixed(sp.digits)) });
  }
  minePos(st) { return this.live.positions.filter(p => tid(p.basket) === st.id); }
  async closeSetup(name, reason) {
    const st = this.trades[name]; if (!st) return;
    const mine = this.minePos(st);
    if (!st.opened && !mine.length) { delete this.trades[name]; this.save(); return; }   // jamais ouvert : rien n'est compté
    st.closing = reason || 'MANUEL'; st.last = r2(mine.reduce((a, p) => a + (p.pnl || 0), 0));
    let failed = 0; for (const p of mine) { if (!(await this.closePos(p, reason))) failed++; }
    if (!failed && !mine.length) this._finish(name, st, reason);
  }
  _finish(name, st, reason) {
    const partial = st.gotClose && st.legsClosed < (st.sent || 1), net = r2(st.gotClose ? st.realized : (st.last || 0));
    let result;
    if (st.closing) result = (st.closing === 'TEMPS' ? 'TEMPS' : 'MANUEL') + (net > 0 ? '+' : '-');
    else result = net > 0 ? (st.tpHits > 0 ? 'TP' : 'LOCK') : 'SL';
    const win = net > 0, S = this.stats, SY = S.bySymbol[name] || (S.bySymbol[name] = { trades: 0, wins: 0, losses: 0, pnl: 0 }), hold = st.openedAt ? Math.max(0, (st.closedAt || this.now()) - st.openedAt) : 0;
    [S, SY].forEach(x => { x.trades++; if (win) x.wins++; else x.losses++; x.pnl = r2((x.pnl || 0) + net); });
    S.byResult[result] = (S.byResult[result] || 0) + 1; S.best = Math.max(S.best, net); S.worst = Math.min(S.worst, net);
    if (net > 0) S.grossWin = r2(S.grossWin + net); else S.grossLoss = r2(S.grossLoss + Math.abs(net));
    S.holdMs += hold; if (st.slipBp != null) { S.slipBp = r3(S.slipBp + st.slipBp); S.slipN++; } if (st.ackMs != null) { S.ackMs += st.ackMs; S.ackN++; }
    this.day.pnl = r2((this.day.pnl || 0) + net); if (this.week) this.week.pnl = r2((this.week.pnl || 0) + net);
    this.consec = win ? 0 : (this.consec || 0) + 1; this.lastExit[name] = this.now();
    this.history.unshift({ id: st.id, symbol: name, side: st.side, lots: st.lots, positions: st.sent || st.n, tpHits: st.tpHits || 0, score: st.score, openedAt: st.openedAt || st.sentAt, closedAt: st.closedAt || this.now(), holdMs: hold, entry: st.fill || st.refPx, closePx: st.closePx || null, slipBp: st.slipBp != null ? st.slipBp : null, spreadBp: st.spreadBp, ackMs: st.ackMs != null ? st.ackMs : null, pnl: net, result, reason: reason || '' });
    if (this.history.length > 300) this.history.length = 300;
    this.log(`${name} : ${st.side} clôturé → ${result} ${net >= 0 ? '+' : ''}${net} $ · ${st.tpHits || 0}/${st.sent || st.n} TP (${Math.round(hold / 100) / 10} s)` + (partial ? ' · résultat partiel' : ''));
    delete this.trades[name]; this.save();
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {});
    for (const name of Object.keys(this.trades)) { try { await this.closeSetup(name, reason || 'clôture manuelle'); } catch (e) { this.log(name + ' : ' + (e && e.message)); } }
    const s = this.sess();
    for (const p of this.live.positions) { if (!Object.values(this.trades).some(b => tid(p.basket) === b.id)) await this.closePos(p, 'orpheline'); }
    for (const o of this.live.orders) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    return { ok: true };
  }

  // ---------- boucle (200 ms) : suivi des positions, limites de perte ----------
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (!this.connected()) { return; }
      this.attach();
      const t = this.now(), s = this.sess(), dk = this.dayKey();
      if (this.day.date !== dk) { this.day = { date: dk, startBalance: num(s.balance, null), pnl: 0, trades: 0 }; this.pausedUntilDay = null; this.consec = 0; }
      const wk = this.weekKey(); if (this.week.key !== wk) this.week = { key: wk, startBalance: num(s.balance, null), pnl: 0 };
      if (this.week.startBalance == null && s.balance != null) this.week.startBalance = num(s.balance, null);
      if (this.day.startBalance == null && s.balance != null) this.day.startBalance = num(s.balance, null);
      this.risk();
      const has = Object.keys(this.trades).length || this.live.positions.length;
      const gap = has ? 350 : (this.active ? 3000 : 10000);
      if (t - this.lastTick < gap) return; this.lastTick = t;
      await this.refresh();
      if (this.active || Object.keys(this.trades).length) await this.manage(); else await this.sweepOrphans();
    } catch (e) { this.live.error = String(e && e.message || e).slice(0, 200); this.log('erreur cycle : ' + this.live.error); }
    finally { this.busy = false; }
  }
  risk() {
    const cfg = this.config, dk = this.dayKey();
    if (cfg.maxDailyLossPct > 0 && this.day.startBalance > 0 && -(this.day.pnl || 0) >= this.day.startBalance * cfg.maxDailyLossPct / 100 && this.pausedUntilDay !== dk) { this.pausedUntilDay = dk; this.log('perte du jour atteinte (' + cfg.maxDailyLossPct + ' %) : robot en pause jusqu\'à demain'); this.save(); }
    if (cfg.maxConsecLosses > 0 && (this.consec || 0) >= cfg.maxConsecLosses && this.pausedUntilDay !== dk) { this.pausedUntilDay = dk; this.log(this.consec + ' pertes de suite : robot en pause jusqu\'à demain'); this.save(); }
    if (this.weekHit() && this.weekPauseLogged !== this.week.key) { this.weekPauseLogged = this.week.key; this.log('perte de la semaine atteinte (' + cfg.maxWeeklyLossPct + ' %) : robot en pause jusqu\'à lundi'); }
  }
  async sweepOrphans() {
    const s = this.sess(), ids = Object.values(this.trades).map(b => b.id), t = this.now(), mineOf = x => ids.indexOf(tid(x.basket)) >= 0;
    const op = this.live.positions.filter(p => !mineOf(p) && (!p.openedAt || t - p.openedAt > ORPHAN_GRACE_MS));
    this.orphans = this.live.positions.filter(p => !mineOf(p)).map(p => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl }));
    for (const o of this.live.orders.filter(o => !mineOf(o))) { try { await s.cancelOrder(o.id); this.log('ordre orphelin annulé ' + o.id); } catch (e) { this.log('annulation ordre orphelin ' + o.id + ' : ' + (e && e.message)); } }
    for (const p of op) { if (await this.closePos(p, 'orpheline')) this.log(`${p.symbol} : position orpheline ${p.side} fermée (${p.pnl >= 0 ? '+' : ''}${p.pnl} $)`); }
  }
  async manage() {
    const t = this.now(), cfg = this.config;
    await this.sweepOrphans();
    for (const name of Object.keys(this.trades)) {
      const st = this.trades[name], mine = this.minePos(st), q = this.quote(name), L = st.side === 'BUY';
      if (mine.length) {
        st.last = r2(mine.reduce((a, p) => a + (p.pnl || 0), 0)); st.emptySince = null;
        if (q) { const px = L ? q.bid : q.ask; st.maxFav = st.maxFav == null ? px : (L ? Math.max(st.maxFav, px) : Math.min(st.maxFav, px)); }
        if (mine.length > st.maxCount) st.maxCount = mine.length;
        if (!st.opened) {
          const vol = mine.reduce((a, p) => a + p.volume, 0) || 1;
          st.opened = true; st.state = 'OUVERT'; st.openedAt = Math.min.apply(null, mine.map(p => p.openedAt || t)); st.fill = mine.reduce((a, p) => a + p.price * p.volume, 0) / vol;
          st.slipBp = r3((L ? st.fill - st.refPx : st.refPx - st.fill) / st.refPx * 1e4);   // coût du glissement (positif = fill plus cher que prévu)
          st.legs.forEach(lg => { lg.tpPx = L ? st.fill + lg.tpDist : st.fill - lg.tpDist; });
          st.tpPx = st.legs[st.legs.length - 1].tpPx; st.slPx = L ? st.fill - st.slDist : st.fill + st.slDist;
          st.lockPx = L ? st.fill + st.tpDist * 0.25 : st.fill - st.tpDist * 0.25;
          this.log(`${name} : ${st.side} ouvert @ ${st.fill.toFixed(5)} · ${mine.length} positions · glissement ${st.slipBp} bp`); this.save();
        }
        if (st.closing) { for (const p of mine) await this.closePos(p, st.closing); continue; }
        // sortie au temps : toutes les positions restantes sont fermées
        if (t - st.openedAt > cfg.maxHoldSec * 1000) { st.closing = 'TEMPS'; for (const p of mine) await this.closePos(p, 'temps'); continue; }
        // verrouillage du gain : dès qu'un TP est touché, ou quand le gain atteint lockAtFrac du TP -> SL des positions restantes remonté
        if (!st.locked) {
          if (st.tpHits > 0) st.locked = true;
          else if (cfg.lockAtFrac > 0 && q && st.tpDist > 0 && (L ? q.bid - st.fill : st.fill - q.ask) >= st.tpDist * cfg.lockAtFrac) st.locked = true;
          if (st.locked) { this.log(`${name} : gain verrouillé (SL @ ${Number(st.lockPx).toFixed(5)})`); this.save(); }
        }
        if (st.locked) for (const p of mine) { if (st.lockIds[p.id]) continue; st.lockIds[p.id] = 1; try { await this.amendLock(p, st); } catch (e) { this.log(`${name} : verrouillage position ${p.id} impossible : ` + (e && e.message)); } }
        continue;
      }
      // plus aucune position : ouverture en attente, ou trade terminé
      if (!st.opened) { if (!this.inflight[name] && t - st.sentAt > OPEN_WAIT_MS) { this.log(name + ' : ordres jamais ouverts (abandon)'); delete this.trades[name]; this.lastExit[name] = t; this.save(); } continue; }
      if (st.legsClosed >= (st.sent || st.maxCount || 1)) { this._finish(name, st, st.closing || 'fermé par le broker'); continue; }
      if (!st.emptySince) { st.emptySince = t; continue; }
      if (t - st.emptySince >= EMPTY_GRACE_MS * 2) this._finish(name, st, st.closing || 'fermé par le broker');
    }
  }

  // ---------- vue pour l'interface ----------
  status() {
    const s = this.sess(), conn = this.connected(), dk = this.dayKey(), t = this.now(), sessionOpen = !this.config.sessionFilter || inSession(t, this.config);
    const trades = Object.keys(this.trades).map(name => {
      const st = this.trades[name], q = conn ? this.quote(name) : null, sp = conn && s.specs[name], mine = this.minePos(st);
      return { id: st.id, symbol: name, side: st.side, state: st.closing ? 'CLÔTURE' : st.state, score: st.score, n: st.sent || st.n, openLegs: mine.length, tpHits: st.tpHits || 0, lots: r2(st.lots), legs: (st.legs || []).map(lg => ({ i: lg.i, lots: lg.lots, tp: lg.tpPx || null, hit: !!lg.hit })), entry: st.fill || st.refPx, sl: st.slPx || null, tp: st.tpPx || null, locked: !!st.locked, net: r2((st.realized || 0) + (mine.length ? mine.reduce((a, p) => a + (p.pnl || 0), 0) : (st.gotClose ? 0 : (st.last || 0)))), openedAt: st.openedAt || null, heldMs: st.openedAt ? t - st.openedAt : 0, maxHoldSec: this.config.maxHoldSec, ackMs: st.ackMs != null ? st.ackMs : null, slipBp: st.slipBp != null ? st.slipBp : null, spreadBp: st.spreadBp, bid: q ? q.bid : null, ask: q ? q.ask : null, digits: sp ? sp.digits : 5, reason: st.reason };
    });
    const feed = {};
    Object.keys(this.wantSet).forEach(name => {
      const b = this.books[name], L = b && b.last(); if (!L) { feed[name] = { ticksPerSec: 0, ageMs: null }; return; }
      const n = b.length - b.from(t - 10000);
      feed[name] = { bid: L.bid, ask: L.ask, spreadBp: r2((L.ask - L.bid) / L.mid * 1e4), ticksPerSec: r2(n / 10), ageMs: t - L.t };
    });
    const S = this.stats, total = S.wins + S.losses, paused = this.pausedUntilDay === dk || this.weekHit();
    const stale = this.active && conn && sessionOpen && Object.keys(feed).length && Object.keys(feed).every(k => feed[k].ageMs == null || feed[k].ageMs > 5000);
    return {
      ok: true, name: BOT_NAME, active: this.active, connected: conn,
      state: !conn ? 'CTRADER NON CONNECTÉ' : paused && this.active ? 'PAUSE : limite de perte' : this.active ? (trades.length ? 'HFT · EN TRADE' : (!sessionOpen ? 'HORS SESSION' : stale ? 'FLUX DE PRIX ABSENT' : 'HFT · ANALYSE TICK')) : 'ARRÊTÉ',
      account: conn ? { balance: s.balance, freeMargin: s.freeMargin, accountId: s.accountId } : null,
      config: this.config, session: { filter: !!this.config.sessionFilter, open: sessionOpen }, trades, setups: trades, signals: this.signals, feed,
      latency: { ms: this.lat.ewma == null ? null : Math.round(this.lat.ewma), last: this.lat.last, n: this.lat.n },
      serverTime: t, liveAt: this.live.at,
      stats: Object.assign({}, S, { total, winRate: total ? r2(S.wins / total * 100) : null, profitFactor: S.grossLoss > 0 ? r2(S.grossWin / S.grossLoss) : (S.grossWin > 0 ? null : null), avgHoldSec: total ? r2(S.holdMs / total / 1000) : null, avgSlipBp: S.slipN ? r3(S.slipBp / S.slipN) : null, avgAckMs: S.ackN ? Math.round(S.ackMs / S.ackN) : null, avgWin: S.wins ? r2(S.grossWin / S.wins) : null, avgLoss: S.losses ? r2(S.grossLoss / S.losses) : null }),
      day: { date: this.day.date, pnl: r2(this.day.pnl || 0), trades: this.day.trades || 0 }, week: { key: this.week.key, pnl: r2(this.week.pnl || 0) }, consec: this.consec || 0, orphans: this.orphans || [], history: this.history.slice(0, 50), logs: this.logs.slice(0, 40), error: this.live.error
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
    // démarrage : reprend les utilisateurs déjà enregistrés (fichiers scalper-<id>.json) et coupe l'ancien moteur IA Mentor
    start: ids => {
      if (!module.exports._fast) { module.exports._fast = setInterval(() => { createdTick().catch(() => {}); }, 200); if (module.exports._fast.unref) module.exports._fast.unref(); }
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
module.exports.BOT_NAME = BOT_NAME;
