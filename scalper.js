'use strict';
/**
 * ARES HFT — robot cTrader (Open API) : scalping TICK à haute fréquence sur XAUUSD + EURUSD.
 * Remplace TOUTES les anciennes stratégies (LOR, OPR, SMC / IA Mentor). Moteur de signal : hft-engine.js.
 *
 *  1. Le robot écoute les ticks bid/ask LIVE du broker (événements SPOT de cTrader) : aucune bougie, aucune donnée simulée.
 *  2. À chaque tick, hft-engine.js cherche une impulsion courte et propre, dans le sens de la micro-tendance, avec un spread faible.
 *  3. Entrée au MARCHÉ avec SL et TP relatifs (exprimés en bp du prix) posés par le broker dès l'ouverture : 1 position par paire.
 *  4. Gestion : verrouillage du gain (SL remonté après `lockAtFrac` du TP), sortie au temps (`maxHoldSec`), cooldown, limite de trades
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
const CFG_VERSION = 'hft-1';        // une autre version (ancien robot LOR) : on garde seulement les paires, statistiques remises à zéro
const BOT_NAME = 'ARES HFT';
const ORPHAN_GRACE_MS = 15000, OPEN_WAIT_MS = 9000, EMPTY_GRACE_MS = 1500;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const r3 = x => Math.round(x * 1000) / 1000;
const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');
const PAIRS = ['XAUUSD', 'EURUSD'];

const DEFAULTS = {
  symbols: ['XAUUSD', 'EURUSD'],
  // --- risque ---
  riskPct: 0.5,              // % du solde risqué par trade (jusqu'au SL)
  fixedLot: 0,               // > 0 : lot fixe (ignore riskPct)
  maxLotPerPosition: 50,
  maxOpenTrades: 2,          // 1 trade par paire -> 2 au maximum
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
    this.signals[name] = sig;
    if (sig.action !== 'WAIT') this.enter(name, sig, t).catch(e => { this.log(name + ' : erreur entrée : ' + (e && e.message)); });
  }
  /** résultat réel d'une clôture : somme brute + swap + commission du deal de clôture (EXECUTION_EVENT du broker) */
  onExec(p) {
    const d = p && p.deal, pos = p && p.position; if (!d || !d.closePositionDetail || !pos || !pos.tradeData || pos.tradeData.label !== LABEL) return;
    const id = String(pos.tradeData.comment || ''), name = Object.keys(this.trades).find(k => this.trades[k].id === id); if (!name) return;
    const st = this.trades[name], cpd = d.closePositionDetail, md = cpd.moneyDigits != null ? Number(cpd.moneyDigits) : (d.moneyDigits != null ? Number(d.moneyDigits) : (this._s && this._s.moneyDigits != null ? Number(this._s.moneyDigits) : 2));
    st.realized = r2((Number(cpd.grossProfit) + Number(cpd.swap || 0) + Number(cpd.commission || 0) + Number(cpd.pnlConversionFee || 0)) / Math.pow(10, md));
    st.closePx = Number(d.executionPrice) || null; st.closedAt = this.now(); st.gotClose = true;
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
  async enter(name, sig, t) {
    const why = this.gate(name, t); sig.gate = why; if (why) return;
    const s = this.sess(), sp = s.specs[name], q = this.lastQ[name], cfg = this.config, L = sig.action === 'BUY';
    if (!sp || !q) return;
    const px = L ? q.ask : q.bid, lv = HFT.levels(px, this.hftCfg()), lots = this.lotsFor(name, lv.sl), bal = num(s.balance, 0), risk$ = lots * lv.sl * this.unitsPerLot(sp);
    if (cfg.fixedLot <= 0 && risk$ > Math.max(bal * cfg.riskPct / 100 * 3, 0.5) && risk$ > bal * 0.10) {
      sig.gate = 'lot minimal trop gros pour le solde (risque ' + r2(risk$) + ' $)'; if (t - this.lastRiskLog > 60000) { this.lastRiskLog = t; this.log(name + ' : ' + sig.gate); } return;
    }
    const id = 'H' + name.slice(0, 3) + (this.seq++ % 36).toString(36) + t.toString(36);
    const st = { id, symbol: name, side: sig.action, lots, slBp: cfg.slBp, tpBp: cfg.tpBp, slDist: lv.sl, tpDist: lv.tp, refPx: px, spreadBp: sig.spreadBp, sigAt: t, sentAt: t, state: 'ENVOI', opened: false, locked: false, last: 0, realized: 0, maxFav: null, reason: sig.reason };
    this.inflight[name] = true; this.trades[name] = st; this.save();   // enregistré AVANT l'envoi : un ordre n'est jamais orphelin
    let vol = s._volume(sp, lots); if (sp.maxVolume > 0) vol = Math.min(vol, sp.maxVolume);
    try {
      const t0 = Date.now();
      await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 1, tradeSide: L ? 1 : 2, volume: vol, relativeStopLoss: s._grid(sp, lv.sl), relativeTakeProfit: s._grid(sp, lv.tp), label: LABEL, comment: id });
      st.ackMs = Date.now() - t0; this.noteLat(st.ackMs); st.state = 'ENVOYÉ';
      this.entryTimes.push(t); this.day.trades = (this.day.trades || 0) + 1;
      this.log(`${name} : ${sig.action} marché · ${lots} lot · SL ${cfg.slBp} bp · TP ${cfg.tpBp} bp · ${sig.reason} · ack ${st.ackMs} ms`);
    } catch (e) {
      this.log(name + ' : ordre refusé : ' + (e && e.message)); delete this.trades[name]; this.lastExit[name] = this.now();
    } finally { this.inflight[name] = false; this.save(); }
  }

  // ---------- fermeture / suivi ----------
  async closePos(p, why) { const s = this.sess(); try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); return true; } catch (e) { this.log('clôture ' + p.id + (why ? ' (' + why + ')' : '') + ' : ' + (e && e.message)); return false; } }
  async amendLock(p, st) {
    const s = this.sess(), sp = s.specs[p.symbol];
    await s.client.request(PT.AMEND_POSITION_SLTP_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), stopLoss: Number(Number(st.lockPx).toFixed(sp.digits)), takeProfit: Number(Number(st.tpPx).toFixed(sp.digits)) });
  }
  async closeSetup(name, reason) {
    const st = this.trades[name]; if (!st) return;
    const mine = this.live.positions.filter(p => p.basket === st.id);
    if (!st.opened && !mine.length) { delete this.trades[name]; this.save(); return; }   // jamais ouvert : rien n'est compté
    st.closing = reason || 'MANUEL'; mine.forEach(p => { st.last = p.pnl; });
    let failed = 0; for (const p of mine) { if (!(await this.closePos(p, reason))) failed++; }
    if (!failed && !mine.length) this._finish(name, st, reason);
  }
  _finish(name, st, reason) {
    const net = r2(st.realized != null && st.gotClose ? st.realized : (st.last || 0)), L = st.side === 'BUY', eps = (st.tpDist || 0) * 0.03;
    let result;
    if (st.closing) result = (st.closing === 'TEMPS' ? 'TEMPS' : 'MANUEL') + (net > 0 ? '+' : '-');
    else {
      const px = st.closePx != null ? st.closePx : null, hitTp = px != null ? (L ? px >= st.tpPx - eps : px <= st.tpPx + eps) : (net > 0 && st.maxFav != null && (L ? st.maxFav >= st.tpPx : st.maxFav <= st.tpPx));
      result = hitTp ? 'TP' : (net > 0 ? 'LOCK' : 'SL');
    }
    const win = net > 0, S = this.stats, SY = S.bySymbol[name] || (S.bySymbol[name] = { trades: 0, wins: 0, losses: 0, pnl: 0 }), hold = st.openedAt ? Math.max(0, (st.closedAt || this.now()) - st.openedAt) : 0;
    [S, SY].forEach(x => { x.trades++; if (win) x.wins++; else x.losses++; x.pnl = r2((x.pnl || 0) + net); });
    S.byResult[result] = (S.byResult[result] || 0) + 1; S.best = Math.max(S.best, net); S.worst = Math.min(S.worst, net);
    if (net > 0) S.grossWin = r2(S.grossWin + net); else S.grossLoss = r2(S.grossLoss + Math.abs(net));
    S.holdMs += hold; if (st.slipBp != null) { S.slipBp = r3(S.slipBp + st.slipBp); S.slipN++; } if (st.ackMs != null) { S.ackMs += st.ackMs; S.ackN++; }
    this.day.pnl = r2((this.day.pnl || 0) + net); if (this.week) this.week.pnl = r2((this.week.pnl || 0) + net);
    this.consec = win ? 0 : (this.consec || 0) + 1; this.lastExit[name] = this.now();
    this.history.unshift({ id: st.id, symbol: name, side: st.side, lots: st.lots, openedAt: st.openedAt || st.sentAt, closedAt: st.closedAt || this.now(), holdMs: hold, entry: st.fill || st.refPx, closePx: st.closePx || null, slipBp: st.slipBp != null ? st.slipBp : null, spreadBp: st.spreadBp, ackMs: st.ackMs != null ? st.ackMs : null, pnl: net, result, reason: reason || '' });
    if (this.history.length > 300) this.history.length = 300;
    this.log(`${name} : ${st.side} clôturé → ${result} ${net >= 0 ? '+' : ''}${net} $ (${Math.round(hold / 100) / 10} s)`);
    delete this.trades[name]; this.save();
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {});
    for (const name of Object.keys(this.trades)) { try { await this.closeSetup(name, reason || 'clôture manuelle'); } catch (e) { this.log(name + ' : ' + (e && e.message)); } }
    const s = this.sess();
    for (const p of this.live.positions) { if (!Object.values(this.trades).some(b => p.basket === b.id)) await this.closePos(p, 'orpheline'); }
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
    const s = this.sess(), ids = Object.values(this.trades).map(b => b.id), t = this.now(), mineOf = x => ids.indexOf(x.basket) >= 0;
    const op = this.live.positions.filter(p => !mineOf(p) && (!p.openedAt || t - p.openedAt > ORPHAN_GRACE_MS));
    this.orphans = this.live.positions.filter(p => !mineOf(p)).map(p => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl }));
    for (const o of this.live.orders.filter(o => !mineOf(o))) { try { await s.cancelOrder(o.id); this.log('ordre orphelin annulé ' + o.id); } catch (e) { this.log('annulation ordre orphelin ' + o.id + ' : ' + (e && e.message)); } }
    for (const p of op) { if (await this.closePos(p, 'orpheline')) this.log(`${p.symbol} : position orpheline ${p.side} fermée (${p.pnl >= 0 ? '+' : ''}${p.pnl} $)`); }
  }
  async manage() {
    const t = this.now(), cfg = this.config;
    await this.sweepOrphans();
    for (const name of Object.keys(this.trades)) {
      const st = this.trades[name], p = this.live.positions.find(x => x.basket === st.id), q = this.quote(name), L = st.side === 'BUY';
      if (p) {
        st.last = p.pnl; st.emptySince = null;
        if (q) { const px = L ? q.bid : q.ask; st.maxFav = st.maxFav == null ? px : (L ? Math.max(st.maxFav, px) : Math.min(st.maxFav, px)); }
        if (!st.opened) {
          st.opened = true; st.state = 'OUVERT'; st.openedAt = p.openedAt || t; st.fill = p.price;
          st.slipBp = r3((L ? p.price - st.refPx : st.refPx - p.price) / st.refPx * 1e4);   // coût du glissement (positif = fill plus cher que prévu)
          st.tpPx = L ? p.price + st.tpDist : p.price - st.tpDist; st.slPx = L ? p.price - st.slDist : p.price + st.slDist;
          st.lockPx = L ? p.price + st.tpDist * 0.25 : p.price - st.tpDist * 0.25;
          this.log(`${name} : ${st.side} ouvert @ ${p.price} · glissement ${st.slipBp} bp`); this.save();
        }
        if (st.closing) { await this.closePos(p, st.closing); continue; }
        // sortie au temps
        if (t - st.openedAt > cfg.maxHoldSec * 1000) { st.closing = 'TEMPS'; await this.closePos(p, 'temps'); continue; }
        // verrouillage du gain : SL remonté quand le gain atteint lockAtFrac du TP
        if (cfg.lockAtFrac > 0 && !st.locked && q && st.tpDist > 0) {
          const gain = L ? q.bid - p.price : p.price - q.ask;
          if (gain >= st.tpDist * cfg.lockAtFrac) {
            st.locked = true;
            try { await this.amendLock(p, st); this.log(`${name} : gain verrouillé (SL @ ${Number(st.lockPx).toFixed(5)})`); } catch (e) { this.log(name + ' : verrouillage impossible : ' + (e && e.message)); }
            this.save();
          }
        }
        continue;
      }
      // pas de position : ouverture en attente, ou trade terminé
      if (!st.opened) { if (!this.inflight[name] && t - st.sentAt > OPEN_WAIT_MS) { this.log(name + ' : ordre jamais ouvert (abandon)'); delete this.trades[name]; this.lastExit[name] = t; this.save(); } continue; }
      if (st.gotClose) { this._finish(name, st, st.closing || 'fermé par le broker'); continue; }
      if (!st.emptySince) { st.emptySince = t; continue; }
      if (t - st.emptySince >= EMPTY_GRACE_MS * 2) this._finish(name, st, st.closing || 'fermé par le broker');
    }
  }

  // ---------- vue pour l'interface ----------
  status() {
    const s = this.sess(), conn = this.connected(), dk = this.dayKey(), t = this.now(), sessionOpen = !this.config.sessionFilter || inSession(t, this.config);
    const trades = Object.keys(this.trades).map(name => {
      const st = this.trades[name], q = conn ? this.quote(name) : null, sp = conn && s.specs[name], p = this.live.positions.find(x => x.basket === st.id);
      return { id: st.id, symbol: name, side: st.side, state: st.closing ? 'CLÔTURE' : st.state, lots: r2(st.lots), entry: st.fill || st.refPx, sl: st.slPx || null, tp: st.tpPx || null, locked: !!st.locked, net: r2(p ? p.pnl : (st.last || 0)), openedAt: st.openedAt || null, heldMs: st.openedAt ? t - st.openedAt : 0, maxHoldSec: this.config.maxHoldSec, ackMs: st.ackMs != null ? st.ackMs : null, slipBp: st.slipBp != null ? st.slipBp : null, spreadBp: st.spreadBp, bid: q ? q.bid : null, ask: q ? q.ask : null, digits: sp ? sp.digits : 5, reason: st.reason };
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
