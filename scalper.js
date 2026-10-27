'use strict';
/**
 * LOR ARES BOT — robot cTrader (Open API) : LONDON OPEN REVERSAL (XAU/USD + EUR/USD, bougies M5). Moteur : lor-engine.js (le même que le backtest du site).
 *
 *  1. Range asiatique 00:00 UTC -> 08:00 heure de Londres (Asian high / low). Heure d'été de Londres gérée automatiquement.
 *  2. Fenêtre 08:00-11:00 heure de Londres : SWEEP du Asian low (BUY) ou du Asian high (SELL) -> CHoCH M5 -> FVG (sinon OB, sinon retest du CHoCH).
 *  3. Entrée en ordre LIMIT sur la zone (50 % du FVG/OB). SL au-delà de l'extrême du sweep.
 *  4. Lot TOTAL réparti en 2 positions égales (50 % / 50 %) : TP1 = 50 % du range asiatique (milieu), TP2 = côté opposé du range (Asian high / low).
 *     Quand TP1 est touché, le SL de la position 2 passe au prix d'entrée (BE). TP1 + BE = trade GAGNANT.
 *  5. 1 trade par jour et par paire. Lot calculé automatiquement selon le risque (% du solde). Aucune donnée simulée : sans connexion cTrader le robot attend. Aucun profit n'est garanti.
 *
 * Le module utilise la session cTrader existante (manager.session(userId)) : OAuth, jetons et compte restent inchangés.
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');
const LOR = require('./lor-engine');                // LOR : London Open Reversal (remplace l'ancien smc-engine.js)
const MODELS = ['LOR'];

const LABEL = 'ARESSCALP';          // même label que l'ancien robot : les anciennes positions orphelines sont fermées automatiquement
const CFG_VERSION = 22;           // 22 : LOR Gold + EURUSD, TP1 = milieu du range asiatique, TP2 = côté opposé (statistiques remises à zéro)
const BOT_NAME = 'LOR Ares Bot';
const M5 = 300000, DAYMS = 86400000;
const ORPHAN_GRACE_MS = 15000, PLACE_GRACE_MS = 9000, EMPTY_GRACE_MS = 4000;
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');

const DEFAULTS = {
  symbols: ['XAUUSD', 'EURUSD'],   // LOR : or + EURUSD, chacun avec son propre profil de seuils (le nom réel est cherché chez le broker)
  riskPct: 1,                // % du solde risqué par trade (les 2 positions ensemble, jusqu'au SL)
  fixedLot: 0,               // > 0 : lot fixe PAR POSITION (ignore riskPct)
  maxLotPerPosition: 50,
  maxOpenTrades: 2,          // un trade par paire (2 paires -> 2 trades maximum en même temps)
  maxSpreadRisk: 0.15,       // pas d'ordre si le spread dépasse 15 % de la distance du SL
  sessionFilter: true,       // analyse seulement de 07:00 UTC à 16:00 UTC, lundi-vendredi
  entryMode: 'mid',          // 'mid' : 50 % du FVG/OB (défaut LOR) · 'edge' : bord de la zone
  maxDailyLossPct: 3,        // perte maximale du jour (% du solde de début de journée) : robot en pause jusqu'au lendemain (0 = pas de limite)
  maxWeeklyLossPct: 0,       // perte maximale de la semaine (% du solde) : 0 = pas de limite
  maxConsecLosses: 0,        // pause du jour après N pertes de suite (0 = désactivé)
  ltf: 5,                    // LOR = M5 uniquement
  tp1R: 1, tp2R: 3, rr: 3,   // (non utilisés : TP1 = milieu du range, TP2 = côté opposé du range asiatique)
  // réglages LOR (voir lor-engine.js ; les seuils range / SL sont relatifs au prix de chaque paire)
  minRR: 2, minTp1R: 0.7, biasFilter: false, useOB: true, maxChochBars: 24, fillBars: 12, maxAttempts: 2, noFriday: false,
  // anciens champs gardés pour l'interface (non utilisés par LOR)
  rrRule: 'nearest', minScore: 0, lotMult75: 1, lotMult100: 1, htfBias: false, minRiskAtr: 0.6, fixedSlGold: 0
};
const LOR_KEYS = ['minRR', 'minTp1R', 'biasFilter', 'useOB', 'maxChochBars', 'fillBars', 'maxAttempts', 'noFriday'];

/** Session de trading : lundi-vendredi, Londres 08:00-17:00 (heure de Londres) OU New York 08:00-17:00 (heure de New York) ; heure d'été gérée. */
const inSession = t => { const d = new Date(t), dow = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes(); return dow >= 1 && dow <= 5 && m >= 7 * 60 && m < 16 * 60; };   // 07:00-16:00 UTC (couvre la fenêtre Londres été + hiver)
// compatibilité avec l'ancien module (server.js peut encore les importer) : l'ancien signal Supertrend n'existe plus
function computeSignal() { return { action: 'WAIT', reason: BOT_NAME + ' : la stratégie Supertrend a été remplacée par LOR (London Open Reversal)' }; }
const entryBias = (bars, sig) => sig;

function sanitizeConfig(src, cur) {
  const c = JSON.parse(JSON.stringify(cur || DEFAULTS));
  if (!src || typeof src !== 'object') return c;
  const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== null && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
  if (Array.isArray(src.symbols)) { const s = src.symbols.slice(0, 12).map(norm).filter(x => x === 'XAUUSD' || x === 'EURUSD'); if (s.length) c.symbols = Array.from(new Set(s)); }   // LOR : or + EURUSD seulement
  if (typeof src.sessionFilter === 'boolean') c.sessionFilter = src.sessionFilter;
  if (src.entryMode === 'edge' || src.entryMode === 'mid') c.entryMode = src.entryMode;
  if (src.rrRule === 'nearest' || src.rrRule === 'first2R') c.rrRule = src.rrRule;
  ['biasFilter', 'useOB', 'noFriday'].forEach(k => { if (typeof src[k] === 'boolean') c[k] = src[k]; });
  n('minRR', 1, 10); n('minTp1R', 0.1, 5); n('maxChochBars', 3, 200); n('fillBars', 1, 200); n('maxAttempts', 1, 3); c.maxAttempts = Math.round(c.maxAttempts);
  n('maxWeeklyLossPct', 0, 90); n('maxConsecLosses', 0, 20); c.maxConsecLosses = Math.round(c.maxConsecLosses);
  n('riskPct', 0.05, 10); n('fixedLot', 0, 100); n('maxLotPerPosition', 0.01, 100); n('maxOpenTrades', 1, 6); c.maxOpenTrades = Math.round(c.maxOpenTrades);
  n('maxSpreadRisk', 0.02, 1); n('maxDailyLossPct', 0, 90); n('minScore', 0, 100); n('minRiskAtr', 0.2, 5); n('fixedSlGold', 0, 200); n('lotMult75', 0.1, 10); n('lotMult100', 0.1, 10);
  c.ltf = 5;   // LOR = M5 uniquement
  if (typeof src.htfBias === 'boolean') c.htfBias = src.htfBias;
  return c;
}

class UserScalper {
  constructor({ userId, dataRoot, manager, now }) {
    this.userId = userId; this.manager = manager; this.now = now || (() => Date.now());
    this.file = path.join(dataRoot, 'scalper-' + userId + '.json');
    this.active = false; this.config = JSON.parse(JSON.stringify(DEFAULTS));
    this.setups = {}; this.baskets = this.setups;       // symbole -> trade en cours (alias « baskets » gardé pour compatibilité)
    this.stats = this._freshStats();
    this.history = []; this.logs = []; this.signals = {}; this.zoneLog = []; this.ind = {};
    this.day = { date: null, startBalance: null, pnl: 0 }; this.pausedUntilDay = null; this.week = { key: null, startBalance: null, pnl: 0 }; this.consec = 0;
    this.live = { positions: [], orders: [], pnlById: {}, at: 0, error: null };
    this.barsCache = {}; this.scan = {}; this.busy = false; this.lastTick = 0; this.orphans = []; this.seq = 0;
    this._load();
  }
  _freshStats() { const by = {}; MODELS.forEach(m => { by[m] = { trades: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, pnl: 0 }; }); const rr = {}; return { bySymbol: {}, byRR: rr, since: this.now(), trades: 0, baskets: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, pnl: 0, best: 0, worst: 0, byModel: by }; }
  log(msg) { this.logs.unshift({ t: new Date(this.now()).toISOString(), msg: String(msg).slice(0, 240) }); if (this.logs.length > 150) this.logs.length = 150; }
  _load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const same = j.cfgVersion === CFG_VERSION;
      if (j.config) this.config = same ? sanitizeConfig(j.config, DEFAULTS) : sanitizeConfig({ symbols: j.config.symbols }, DEFAULTS);   // ancien robot : on garde seulement les symboles
      this.active = same && j.active === true;
      if (same) {
        if (j.stats) { this.stats = Object.assign(this._freshStats(), j.stats); if (!this.stats.byRR) this.stats.byRR = {}; if (!this.stats.bySymbol) this.stats.bySymbol = {}; MODELS.forEach(m => { if (!this.stats.byModel[m]) this.stats.byModel[m] = { trades: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, pnl: 0 }; }); }
        if (Array.isArray(j.history)) this.history = j.history.slice(0, 300);
        if (j.setups && typeof j.setups === 'object') { this.setups = j.setups; this.baskets = this.setups; }
        if (Array.isArray(j.zoneLog)) this.zoneLog = j.zoneLog.slice(0, 40);
        if (j.day) this.day = j.day; if (j.pausedUntilDay) this.pausedUntilDay = j.pausedUntilDay; if (j.week) this.week = j.week; this.consec = Number(j.consec) || 0;
      }
    } catch (e) { /* premier démarrage : statistiques à zéro */ }
  }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify({ cfgVersion: CFG_VERSION, active: this.active, config: this.config, stats: this.stats, history: this.history.slice(0, 300), setups: this.setups, zoneLog: this.zoneLog.slice(0, 40), day: this.day, pausedUntilDay: this.pausedUntilDay, week: this.week, consec: this.consec }));
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
  setConfig(src) { this.config = sanitizeConfig(src, this.config); this.save(); return { ok: true, config: this.config }; }
  resetStats() { this.stats = this._freshStats(); this.history = []; this.save(); return { ok: true }; }

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
  /** Bougies M5 FERMÉES (cache incrémental). L'historique M5 est demandé au broker ; M15 / H1 sont reconstruits par le moteur. */
  async m5(name) {
    const s = this.sess(), t = this.now(), end = Math.floor(t / M5) * M5; let c = this.barsCache[name];
    let raw = [];
    if (!c || !c.bars.length || end - c.bars[c.bars.length - 1].t > 45 * 60000) {
      c = { bars: [] };
      for (let a = end - 6 * DAYMS; a < t; a += 2 * DAYMS) { const part = await s.fetchHistory(name, 5, a, Math.min(t, a + 2 * DAYMS)); raw = raw.concat(part || []); }
    } else raw = (await s.fetchHistory(name, 5, c.bars[c.bars.length - 1].t - 3 * M5, t)) || [];
    const map = new Map(c.bars.map(b => [b.t, b]));
    raw.filter(b => b && b.t < end && b.h >= b.l).forEach(b => map.set(b.t, { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c }));
    const bars = Array.from(map.values()).sort((a, b) => a.t - b.t).slice(-2200);
    if (bars.length > 60) {   // contrôle : l'espacement doit être de 5 minutes (sinon la période demandée n'est pas M5 : on ne trade pas)
      let ok = 0; for (let i = bars.length - 50; i < bars.length; i++) if (bars[i].t - bars[i - 1].t === M5) ok++;
      if (ok < 30) throw new Error('historique : espacement M5 inattendu (' + ok + '/50)');
    }
    this.barsCache[name] = { bars, at: t }; return bars;
  }
  quote(name) { const s = this.sess(), sp = s.specs[name], q = sp && s.quotes[String(sp.symbolId)]; return (!q || !(q.bid > 0) || !(q.ask > 0)) ? null : q; }
  resolve(want) {
    const s = this.sess(), specs = (s && s.specs) || {}, w = norm(want); if (specs[w]) return w;
    const keys = Object.keys(specs); let k = keys.find(x => x.startsWith(w));
    if (!k && w === 'XAUUSD') k = keys.find(x => x === 'GOLD' || x.startsWith('GOLD') || x.startsWith('XAU'));
    return k || null;
  }
  unitsPerLot(sp) { return Math.max(1e-9, sp.lotSize / 100); }
  /** lot PAR POSITION : le risque total (riskPct % du solde) est réparti sur les 2 positions ; ramené aux limites du broker */
  lotsFor(name, riskDist, score) {
    const s = this.sess(), sp = s.specs[name], bal = num(s.balance, 0), step = sp.lotStep || 0.01, min = sp.minLot || 0.01, max = Math.min(this.config.maxLotPerPosition, sp.maxLot || 1e9);
    const fl = v => Math.round(Math.floor(v / step + 1e-9) * step * 1e6) / 1e6;
    const mult = score >= 100 ? this.config.lotMult100 : score >= 75 ? this.config.lotMult75 : 1;   // le lot monte / descend avec le score
    if (this.config.fixedLot > 0) return clamp(Math.max(min, fl(this.config.fixedLot * mult)), min, max);
    const riskUsd = bal * this.config.riskPct / 100, total = riskDist > 0 ? riskUsd / (riskDist * this.unitsPerLot(sp)) : min;
    return clamp(Math.max(min, fl(total / 2 * mult)), min, max);
  }
  /** réglages passés à LOR.analyzeDay pour UNE paire : profil LOR de la paire (seuils relatifs au prix) + réglages du site. TP1 = milieu du range, TP2 = côté opposé. */
  lorCfg(name) {
    const c = this.config, ov = { entry: c.entryMode === 'edge' ? 'edge' : 'mid', noFriday: !!c.noFriday };
    LOR_KEYS.forEach(k => { if (c[k] !== undefined) ov[k] = c[k]; });
    return LOR.config(name, ov);
  }


  // ---------- ordres ----------
  async limit(name, side, lots, entry, sl, tp, comment, expireAt) {
    const s = this.sess(), sp = s.specs[name], px = v => Number(Number(v).toFixed(sp.digits)); let vol = s._volume(sp, lots); if (sp.maxVolume > 0) vol = Math.min(vol, sp.maxVolume);
    await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 2, tradeSide: side === 'BUY' ? 1 : 2, volume: vol, limitPrice: px(entry), stopLoss: px(sl), takeProfit: px(tp), timeInForce: 1, expirationTimestamp: expireAt, label: LABEL, comment });
  }
  async closePos(p, why) { const s = this.sess(); try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); return true; } catch (e) { this.log('clôture ' + p.id + (why ? ' (' + why + ')' : '') + ' : ' + (e && e.message)); return false; } }
  /** SL de la position 2 -> prix d'entrée (BE) en gardant son TP2 */
  async amendBE(p, be, tp2) {
    const s = this.sess(), sp = s.specs[p.symbol], type = PT.AMEND_POSITION_SLTP_REQ;
    if (!type) throw new Error('AMEND_POSITION_SLTP_REQ absent du client');
    await s.client.request(type, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), stopLoss: Number(Number(be).toFixed(sp.digits)), takeProfit: Number(Number(tp2).toFixed(sp.digits)) });
  }
  zoneEntry(c, extra) { return Object.assign({ id: c.id, symbol: c.symbol, model: c.model, tf: c.tf, side: c.side, entry: c.entry, sl: c.sl, tp1: c.tp1, tp2: c.tp2, rr: c.rr, score: c.score, parts: c.parts, at: this.now(), status: 'DÉTECTÉ' }, extra || {}); }
  setZone(id, status, note) { const z = this.zoneLog.find(x => x.id === id); if (z) { z.status = status; if (note) z.note = note; } }

  async place(name, c) {
    const s = this.sess(), sp = s.specs[name], q = this.quote(name), cfg = this.config, L = c.side === 'BUY', t = this.now();
    if (!q) { this.setZone(c.id, 'REFUSÉ', 'pas de prix en direct'); return false; }
    if (L ? !(c.entry < q.ask) : !(c.entry > q.bid)) { this.setZone(c.id, 'REFUSÉ', 'prix déjà passé sous/sur l\'entrée'); return false; }
    if (q.ask - q.bid > cfg.maxSpreadRisk * c.risk) { this.setZone(c.id, 'REFUSÉ', 'spread trop large (' + r2(q.ask - q.bid) + ')'); return false; }
    ['entry', 'sl', 'tp1', 'tp2'].forEach(f => { c[f] = Number(Number(c[f]).toFixed(sp.digits)); });
    const lots = this.lotsFor(name, c.risk, c.score), bal = num(s.balance, 0), risk$ = lots * 2 * c.risk * this.unitsPerLot(sp);
    if (cfg.fixedLot <= 0 && risk$ > Math.max(bal * cfg.riskPct / 100 * 3, 0.5) && risk$ > bal * 0.10) { this.setZone(c.id, 'REFUSÉ', 'lot minimal trop gros pour le solde (risque ' + r2(risk$) + ' $)'); this.log(name + ' : ' + c.model + ' refusé : lot minimal ' + lots + ' = risque ' + r2(risk$) + ' $'); return false; }
    const id = 'SM' + name.slice(0, 6) + (this.seq++ % 36).toString(36) + t.toString(36), expireAt = t + c.pendingBars * 5 * 60000;
    const st = { id, symbol: name, model: c.model, tf: c.tf, side: c.side, score: c.score, parts: c.parts, rr: c.rr, rr1: c.rr1, entry: c.entry, sl: c.sl, tp1: c.tp1, tp2: c.tp2, risk: c.risk, lots, createdAt: t, expireAt, state: 'PENDING', opened: false, tp1Hit: false, beDone: false, virtualBE: false, realized: 0, last: {}, fill: null, maxFav: null };
    this.setups[name] = st; this.save();   // enregistré AVANT l'envoi : les ordres ne sont jamais orphelins
    try {
      await this.limit(name, c.side, lots, c.entry, c.sl, c.tp1, id + '.1', expireAt);
      await this.limit(name, c.side, lots, c.entry, c.sl, c.tp2, id + '.2', expireAt);
    } catch (e) {
      this.log(name + ' : ordre LIMIT refusé : ' + (e && e.message)); this.setZone(c.id, 'REFUSÉ', String(e && e.message || e).slice(0, 80));
      await this.refresh().catch(() => {}); await this.dropSetup(name, 'ordre refusé', true); return false;
    }
    this.setZone(c.id, 'CHOISI', 'ordre LIMIT placé'); st.zoneId = c.id;
    this.log(`${name} : ${c.model} ${c.side} (${c.tf}) · LIMIT ${c.entry} · SL ${c.sl} · TP1 ${c.tp1} (milieu du range, RR ${c.rr1}) · TP2 ${c.tp2} (côté opposé, RR ${c.rr}) · ${lots} lot × 2`);
    this.save(); return true;
  }
  /** annule les ordres en attente et ferme les positions d'un trade, sans le compter (ordre refusé / invalidé / expiré) */
  async dropSetup(name, reason, silent) {
    const st = this.setups[name]; if (!st) return;
    const s = this.sess(), mine = this.live.positions.filter(p => p.basket.indexOf(st.id + '.') === 0), ords = this.live.orders.filter(o => o.basket.indexOf(st.id + '.') === 0);
    for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { this.log('annulation ordre ' + o.id + ' : ' + (e && e.message)); } }
    for (const p of mine) await this.closePos(p, reason);
    if (st.zoneId && !silent) this.setZone(st.zoneId, 'EXPIRÉ', reason);
    if (!silent) this.log(name + ' : ' + st.model + ' ' + st.side + ' annulé (' + reason + ')');
    delete this.setups[name]; this.save();
  }
  /** clôture d'un trade ouvert (manuelle / arrêt d'urgence) */
  async closeSetup(name, reason) {
    const st = this.setups[name]; if (!st) return;
    const s = this.sess(), mine = this.live.positions.filter(p => p.basket.indexOf(st.id + '.') === 0), ords = this.live.orders.filter(o => o.basket.indexOf(st.id + '.') === 0);
    if (!st.opened && !mine.length) { await this.dropSetup(name, reason); return; }   // jamais rempli : on annule simplement, rien n'est compté
    for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    mine.forEach(p => { st.last[p.id] = p.pnl; });
    let failed = 0; for (const p of mine) { if (!(await this.closePos(p, reason))) failed++; else st.realized = r2((st.realized || 0) + p.pnl); }
    st.closing = reason; if (!failed) this._finish(name, st, reason);
  }
  _finish(name, st, reason, resultIn) {
    const q = this.quote(name), net = r2(st.realized || 0);
    let result = resultIn;
    if (!result) {
      if (st.closing) result = net > 0 ? 'MANUEL+' : 'MANUEL-';
      else if (!st.tp1Hit && !(net > 0 && st.maxFav != null && (st.side === 'BUY' ? st.maxFav >= st.tp1 : st.maxFav <= st.tp1))) result = 'SL';
      else result = (st.maxFav != null && (st.side === 'BUY' ? st.maxFav >= st.tp2 : st.maxFav <= st.tp2)) ? 'TP' : 'BE';
    }
    const win = result === 'TP' || result === 'BE' || result === 'MANUEL+';
    const S = this.stats, M = S.byModel[st.model] || (S.byModel[st.model] = { trades: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, pnl: 0 });
    const SY = (S.bySymbol = S.bySymbol || {})[name] || (S.bySymbol[name] = { trades: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, pnl: 0 });
    [S, M, SY].forEach(x => { x.trades++; if (win) x.wins++; else x.losses++; if (result === 'TP') x.tp++; else if (result === 'BE') x.be++; else if (result === 'SL') x.sl++; x.pnl = r2((x.pnl || 0) + net); });
    S.baskets = S.trades; S.best = Math.max(S.best, net); S.worst = Math.min(S.worst, net);
    this.day.pnl = r2((this.day.pnl || 0) + net);
    if (this.week) this.week.pnl = r2((this.week.pnl || 0) + net);
    this.consec = result === 'SL' || result === 'MANUEL-' ? (this.consec || 0) + 1 : 0;
    this.history.unshift({ id: st.id, symbol: name, model: st.model, tf: st.tf, side: st.side, score: st.score, rr: st.rr, rr1: st.rr1, entry: st.entry, sl: st.sl, tp1: st.tp1, tp2: st.tp2, lots: st.lots, openedAt: st.openedAt || st.createdAt, closedAt: this.now(), pnl: net, result, reason: reason || '' });
    if (this.history.length > 300) this.history.length = 300;
    if (st.zoneId) this.setZone(st.zoneId, result === 'SL' ? 'PERDU (SL)' : result === 'TP' ? 'GAGNÉ (TP2)' : result === 'BE' ? 'GAGNÉ (TP1+BE)' : 'CLÔTURÉ', (net >= 0 ? '+' : '') + net + ' $');
    this.log(`${name} : ${st.model} ${st.side} clôturé → ${result} ${net >= 0 ? '+' : ''}${net} $`);
    delete this.setups[name]; this.save();
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {});
    for (const name of Object.keys(this.setups)) { try { await this.closeSetup(name, reason || 'clôture manuelle'); } catch (e) { this.log(name + ' : ' + (e && e.message)); } }
    const s = this.sess();
    for (const p of this.live.positions) { if (!Object.values(this.setups).some(b => p.basket.indexOf(b.id + '.') === 0)) await this.closePos(p, 'orpheline'); }
    for (const o of this.live.orders) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    return { ok: true };
  }

  // ---------- boucle ----------
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }
  weekKey() { const d = new Date(this.now()), dow = (d.getUTCDay() + 6) % 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10); }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (!this.connected()) { return; }
      const hasSetups = Object.keys(this.setups).length || this.live.positions.length;
      const gap = hasSetups ? 300 : 1500;
      if (this.now() - this.lastTick < gap) return; this.lastTick = this.now();
      const s = this.sess(), dk = this.dayKey();
      if (this.day.date !== dk) { this.day = { date: dk, startBalance: num(s.balance, null), pnl: 0 }; this.pausedUntilDay = null; this.consec = 0; }
      const wk = this.weekKey(); if (this.week.key !== wk) this.week = { key: wk, startBalance: num(s.balance, null), pnl: 0 };
      if (this.week.startBalance == null && s.balance != null) this.week.startBalance = num(s.balance, null);
      if (this.day.startBalance == null && s.balance != null) this.day.startBalance = num(s.balance, null);
      if (!(this.active || hasSetups)) {
        // robot arrêté et rien à suivre : on vérifie quand même toutes les 10 s qu'aucune position/ordre ARESSCALP ne reste caché
        if (this.now() - (this.lastIdleCheck || 0) >= 10000) { this.lastIdleCheck = this.now(); await this.refresh(); await this.sweepOrphans(); }
      } else { await this.refresh(); await this.manage(); }
      await this.hunt().catch(e => { this.live.error = 'analyse : ' + String(e && e.message || e).slice(0, 160); });
    } catch (e) { this.live.error = String(e && e.message || e).slice(0, 200); this.log('erreur cycle : ' + this.live.error); }
    finally { this.busy = false; }
  }
  async sweepOrphans() {
    const s = this.sess(), ids = Object.values(this.setups).map(b => b.id + '.'), t = this.now(), mineOf = x => ids.some(i => x.basket.indexOf(i) === 0);
    const op = this.live.positions.filter(p => !mineOf(p) && (!p.openedAt || t - p.openedAt > ORPHAN_GRACE_MS));
    const oo = this.live.orders.filter(o => !mineOf(o));
    this.orphans = this.live.positions.filter(p => !mineOf(p)).map(p => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, price: p.price, pnl: p.pnl }));
    for (const o of oo) { try { await s.cancelOrder(o.id); this.log('ordre orphelin annulé ' + o.id); } catch (e) { this.log('annulation ordre orphelin ' + o.id + ' : ' + (e && e.message)); } }
    for (const p of op) { if (await this.closePos(p, 'orpheline')) this.log(`${p.symbol} : position orpheline ${p.side} fermée (${p.pnl >= 0 ? '+' : ''}${p.pnl} $)`); }
  }
  async manage() {
    const s = this.sess(), t = this.now();
    await this.sweepOrphans();
    for (const name of Object.keys(this.setups)) {
      const st = this.setups[name], pre = st.id + '.';
      const mine = this.live.positions.filter(p => p.basket.indexOf(pre) === 0), ords = this.live.orders.filter(o => o.basket.indexOf(pre) === 0);
      const p1 = mine.find(p => p.basket === pre + '1'), p2 = mine.find(p => p.basket === pre + '2'), q = this.quote(name), L = st.side === 'BUY';
      if (st.closing) { if (!mine.length) { ords.forEach(async o => { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }); this._finish(name, st, st.closing); } else await this.closeSetup(name, st.closing); continue; }
      // --- suivi des P/L et du meilleur prix ---
      mine.forEach(p => { st.last[p.id] = p.pnl; });
      if (q) { const px = L ? q.bid : q.ask; st.maxFav = st.maxFav == null ? px : (L ? Math.max(st.maxFav, px) : Math.min(st.maxFav, px)); }
      if (mine.length && !st.opened) { st.opened = true; st.state = 'OPEN'; st.openedAt = t; st.fill = (p2 || p1).price; this.log(`${name} : ${st.model} ${st.side} rempli @ ${st.fill}`); if (st.zoneId) this.setZone(st.zoneId, 'OUVERT'); this.save(); }
      // --- positions disparues : on garde leur dernier P/L ---
      for (const key of ['1', '2']) { const was = st['seen' + key], now = !!(key === '1' ? p1 : p2); if (was && !now) { st.realized = r2((st.realized || 0) + (st.last[was] || 0)); if (key === '1' && p2 && !st.tp1Hit) { st.tp1Hit = true; st.state = 'TP1'; this.log(`${name} : TP1 touché → SL de la position 2 au BE`); if (st.zoneId) this.setZone(st.zoneId, 'TP1 touché'); } } st['seen' + key] = now ? (key === '1' ? p1.id : p2.id) : null; }
      // --- BE de la position 2 ---
      if (st.tp1Hit && p2 && !st.beDone) {
        const be = p2.price;
        if (q && (L ? q.bid <= be : q.ask >= be)) { st.beDone = true; await this.closePos(p2, 'BE'); }   // le prix est déjà revenu à l'entrée
        else {
          try { await this.amendBE(p2, be, st.tp2); st.beDone = true; this.log(`${name} : SL position 2 → BE @ ${be}`); }
          catch (e) { st.virtualBE = true; st.beDone = true; st.beLevel = be; this.log(`${name} : modification SL impossible (${e && e.message}) → BE virtuel suivi par le robot`); }
        }
        this.save();
      }
      if (st.virtualBE && p2 && q && (L ? q.bid <= st.beLevel : q.ask >= st.beLevel)) { await this.closePos(p2, 'BE virtuel'); }
      // --- ordre LIMIT en attente : invalidation / expiration ---
      if (!st.opened) {
        if (q && (L ? q.bid <= st.sl : q.ask >= st.sl)) { await this.dropSetup(name, 'prix passé sous le SL avant le remplissage'); continue; }
        if (t > st.expireAt + 3000) { await this.dropSetup(name, 'ordre LIMIT expiré'); continue; }
        if (!mine.length && !ords.length && t - st.createdAt > PLACE_GRACE_MS) { await this.dropSetup(name, 'ordre disparu (expiré / annulé)'); continue; }
        continue;
      }
      // --- fin du trade ---
      if (!mine.length) {
        if (!st.emptySince) { st.emptySince = t; continue; }
        if (t - st.emptySince < EMPTY_GRACE_MS) continue;
        for (const o of ords) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
        this._finish(name, st, 'fermé par le broker'); continue;
      } st.emptySince = null;
    }
  }
  /** analyse M5 à chaque nouvelle bougie fermée ; le robot ne place un ordre que s'il est activé */
  async hunt() {
    const cfg = this.config, t = this.now(), dk = this.dayKey();
    if (cfg.maxDailyLossPct > 0 && this.day.startBalance > 0 && -(this.day.pnl || 0) >= this.day.startBalance * cfg.maxDailyLossPct / 100 && this.pausedUntilDay !== dk) { this.pausedUntilDay = dk; this.log('perte du jour atteinte (' + cfg.maxDailyLossPct + ' %) : robot en pause jusqu\'à demain'); }
    if (cfg.maxConsecLosses > 0 && (this.consec || 0) >= cfg.maxConsecLosses && this.pausedUntilDay !== dk) { this.pausedUntilDay = dk; this.log(this.consec + ' pertes de suite : robot en pause jusqu\'à demain'); }
    const weekHit = cfg.maxWeeklyLossPct > 0 && this.week.startBalance > 0 && -(this.week.pnl || 0) >= this.week.startBalance * cfg.maxWeeklyLossPct / 100;
    if (weekHit && this.weekPauseLogged !== this.week.key) { this.weekPauseLogged = this.week.key; this.log('perte de la semaine atteinte (' + cfg.maxWeeklyLossPct + ' %) : robot en pause jusqu\'à lundi'); }
    const canTrade = this.active && this.pausedUntilDay !== dk && !weekHit;
    const barMs = 5 * 60000, sessionOk = !cfg.sessionFilter || inSession(t), boundary = Math.floor(t / barMs) * barMs;
    for (const want of cfg.symbols) {
      const name = this.resolve(want);
      if (!name) { this.signals[want] = { reason: 'symbole introuvable chez le broker', at: t }; continue; }
      if (!sessionOk) { this.signals[name] = { reason: 'hors session LOR (07:00-16:00 UTC, lun-ven)', at: t }; continue; }
      const sc = this.scan[name] || (this.scan[name] = { done: 0, tries: 0, last: 0 });
      if (sc.done === boundary || t - boundary < 2500 || t - sc.last < 4000) continue;
      sc.last = t;
      let bars; try { bars = await this.m5(name); } catch (e) { this.signals[name] = { reason: 'historique M5 indisponible : ' + String(e && e.message || e).slice(0, 100), at: t }; continue; }
      const lastBar = bars[bars.length - 1];
      if (!lastBar || (lastBar.t !== Math.floor(t / M5) * M5 - M5 && ++sc.tries < 12)) continue;   // la bougie M5 qui vient de fermer n'est pas encore publiée : on réessaie
      sc.tries = 0; sc.done = boundary;
      const L = this.lorCfg(name), d0 = Math.floor(t / DAYMS) * DAYMS, day = bars.filter(x => x.t >= d0), hist = bars.filter(x => x.t < d0).slice(-1500);
      const an = LOR.analyzeDay(day, hist, L, t), res = { cands: [], chosen: null };
      if (an.plan && an.choch && (an.stage === 'ARMED' || an.stage === 'FILLED')) {   // setup LOR complet : ordre LIMIT sur la zone (sweep -> CHoCH -> FVG/OB)
        const p = an.plan, sg = p.dir === 'BUY' ? 1 : -1, R = p.risk;
        const c = { model: 'LOR', tf: 'M5', side: p.dir, entry: p.entry, sl: p.sl, tp1: p.tp1, tp2: p.tp2, rr: p.rr, rr1: p.rr1, score: 100, risk: R, pendingBars: L.fillBars, trigT: an.choch.t,
          parts: [{ name: 'Sweep Asian ' + (p.dir === 'BUY' ? 'low' : 'high') + ' ' + an.sweep.price, pts: 1, max: 1 }, { name: 'CHoCH M5 ' + an.choch.level, pts: 1, max: 1 }, { name: an.zone.type + ' ' + an.zone.lo + '-' + an.zone.hi, pts: 1, max: 1 }] };
        res.cands.push(c); res.chosen = c;
      }
      const fresh = !!an.choch && an.choch.t + M5 === boundary;   // l'ordre n'est posé qu'à la clôture de la bougie du CHoCH (jamais sur un setup ancien)
      this.signals[name] = { at: t, bars: bars.length, candidates: res.cands.length, reason: res.cands.length ? 'setup LOR prêt : ' + an.note : 'LOR : ' + (an.note || an.stage), stage: an.stage, bias: an.bias, asia: an.asia, last: lastBar.c };
      res.cands.forEach(c => { c.symbol = name; c.id = name + '-' + c.model + '-' + c.side + '-' + c.trigT; });
      res.cands.forEach(c => { if (!this.zoneLog.some(z => z.id === c.id)) this.zoneLog.unshift(this.zoneEntry(c, { status: fresh ? 'DÉTECTÉ' : 'ANCIEN' })); });
      if (this.zoneLog.length > 40) this.zoneLog.length = 40;
      const ch = res.chosen;
      if (ch && fresh) {
                if (this.setups[name] || Object.keys(this.setups).length >= cfg.maxOpenTrades) this.setZone(ch.id, 'IGNORÉ', 'un trade est déjà en cours ou limite de trades ouverts');
        else if (!canTrade) this.setZone(ch.id, 'SIGNAL', this.active ? 'pause (limite de perte)' : 'robot arrêté : aucun ordre envoyé');
        else { await this.place(name, ch); await this.refresh().catch(() => {}); }
      }
      this.save();
    }
  }

  // ---------- vue pour l'interface ----------
  status() {
    const s = this.sess(), conn = this.connected(), dk = this.dayKey(), sessionOpen = !this.config.sessionFilter || inSession(this.now());
    const setups = Object.keys(this.setups).map(name => {
      const st = this.setups[name], pre = st.id + '.', mine = this.live.positions.filter(p => p.basket.indexOf(pre) === 0), ords = this.live.orders.filter(o => o.basket.indexOf(pre) === 0);
      const q = conn ? this.quote(name) : null, sp = conn && s.specs[name], open = mine.reduce((a, p) => a + p.pnl, 0);
      return {
        id: st.id, symbol: name, model: st.model, tf: st.tf, side: st.side, score: st.score, parts: st.parts, rr: st.rr, state: st.closing ? 'CLÔTURE' : st.state,
        entry: st.entry, sl: st.sl, tp1: st.tp1, tp2: st.tp2, fill: st.fill, lotsPerPosition: r2(st.lots), createdAt: st.createdAt, openedAt: st.openedAt || null, expireAt: st.expireAt,
        rr1: st.rr1, tp1Hit: st.tp1Hit, be: st.beDone ? (st.virtualBE ? 'virtuel' : 'oui') : 'non', net: r2(open + (st.realized || 0)), open: r2(open), realized: r2(st.realized || 0),
        bid: q ? q.bid : null, ask: q ? q.ask : null, digits: sp ? sp.digits : 2,
        items: mine.map(p => ({ id: p.id, leg: p.basket.slice(-1), side: p.side, lots: p.lots, price: p.price, pnl: p.pnl })),
        pending: ords.map(o => ({ id: o.id, leg: o.basket.slice(-1), side: o.side, price: o.price, lots: sp ? r2(o.volume / sp.lotSize) : null }))
      };
    });
    const total = this.stats.wins + this.stats.losses;
    return {
      ok: true, name: BOT_NAME, active: this.active, connected: conn,
      state: !conn ? 'CTRADER NON CONNECTÉ' : (this.pausedUntilDay === dk || (this.config.maxWeeklyLossPct > 0 && this.week.startBalance > 0 && -(this.week.pnl || 0) >= this.week.startBalance * this.config.maxWeeklyLossPct / 100)) && this.active ? 'PAUSE : limite de perte' : this.active ? (setups.length ? (setups[0].state === 'PENDING' ? 'ORDRE LIMIT EN ATTENTE' : 'EN TRADE') : (sessionOpen ? 'ANALYSE LOR M5' : 'HORS SESSION')) : 'ARRÊTÉ',
      account: conn ? { balance: s.balance, freeMargin: s.freeMargin, accountId: s.accountId } : null,
      config: this.config, session: { filter: !!this.config.sessionFilter, open: sessionOpen }, setups, baskets: setups, zones: this.zoneLog.slice(0, 30), signals: this.signals,
      serverTime: this.now(), liveAt: this.live.at,
      stats: Object.assign({}, this.stats, { winRate: total ? r2(this.stats.wins / total * 100) : null, total }),
      day: { date: this.day.date, pnl: r2(this.day.pnl || 0) }, week: { key: this.week.key, pnl: r2(this.week.pnl || 0) }, consec: this.consec || 0, orphans: this.orphans || [], history: this.history.slice(0, 50), logs: this.logs.slice(0, 40), error: this.live.error
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
