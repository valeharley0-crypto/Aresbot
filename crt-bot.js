'use strict';
/**
 * SMCRT — robot cTrader : H4 CRT → M15 CHoCH/POI → M5 entrée (ordre LIMIT).
 * 1 trade par paire et par jour · 2 POSITIONS : position 1 -> TP1 (50 % du range CRT), position 2 -> TP2 (autre côté du range) · après TP1 : SL de la position 2 -> BE · TP1 (+BE) = WIN · aucun RR minimum.
 * Exécution TOUJOURS réelle (plus de mode PAPER). Compte en USD supposé pour le calcul du risque.
 * Même interface que l'ancien scalper (get / start / tickAll / emergencyStop...) : index.js n'a presque rien à changer.
 * Aucun profit n'est garanti. Tester d'abord sur DEMO.
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');
const E = require('./crt-engine');

const LABEL = 'ARESCRT';
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PAIRS = ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD', 'V10', 'V50'];
const baseId = c => String(c || '').split(':')[0];
const DEFAULT_SYMBOLS = ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDCAD', 'V50'];
// nom demandé -> motif du symbole chez le broker (Deriv : « Volatility 75 Index » -> VOLATILITY75INDEX ; les variantes « 1s » sont exclues)
const MATCH = E.PAIR_MATCH;
const DEFAULTS = { symbols: DEFAULT_SYMBOLS.slice(), aliases: {}, maxDailyLossPct: 4, maxTotalRiskPct: 8, liveExecution: true, riskBase: 1, riskHigh: 2, highScore: 80, maxRealRiskPct: 10, minExpR: 1, pairsV2: true };

class UserCrt {
  constructor({ userId, dataRoot, manager }) {
    this.userId = userId; this.manager = manager; this.file = path.join(dataRoot, 'crt-' + userId + '.json');
    this.active = false; this.config = JSON.parse(JSON.stringify(DEFAULTS));
    this.ph = {}; this.stats = { bySymbol: {} }; this.history = []; this.fills = {}; this.skip = {}; this.logs = [];
    this.day = { date: null, startBalance: null, pnl: 0 }; this.live = { positions: [], orders: [], at: 0 };
    this.busy = false; this.lastRef = 0; this.jobs = {}; this._client = null;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.active = j.active === true; this.config = Object.assign({}, DEFAULTS, j.config || {}); this.ph = j.ph || {}; this.stats = j.stats || this.stats; this.history = j.history || []; this.fills = j.fills || {}; this.skip = j.skip || {}; this.day = j.day || this.day; this.prob = j.prob || {}; } catch (e) { /* premier démarrage */ }
    this.prob = this.prob || {}; this.config.liveExecution = true;   // plus de PAPER
    if (!this.config.pairsV2) { ['GBPUSD', 'AUDUSD'].forEach(x => { if (this.config.symbols.indexOf(x) < 0) this.config.symbols.push(x); }); this.config.pairsV2 = true; }
    if (!this.config.minExpRv2) { this.config.minExpR = 1; this.config.minExpRv2 = true; }   // R/trade minimum 1
    if (!this.config.pairsV3) { if (this.config.symbols.indexOf('USDCAD') < 0) this.config.symbols.push('USDCAD'); this.config.pairsV3 = true; }   // GOLD remplacé par USDCAD
    this.config.symbols = (this.config.symbols || []).filter(x => PAIRS.indexOf(x) >= 0);   // V25 / V75 / V100 / USDJPY retirés
  }
  now() { return Date.now(); }
  log(m) { this.logs.unshift({ t: new Date().toISOString(), msg: String(m).slice(0, 240) }); if (this.logs.length > 120) this.logs.length = 120; }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ active: this.active, config: this.config, ph: this.ph, stats: this.stats, history: this.history.slice(0, 300), fills: this.fills, skip: this.skip, day: this.day, prob: this.prob })); } catch (e) { /* ignore */ } }
  sess() { try { return this.manager.session(this.userId); } catch (e) { return null; } }
  connected() { const s = this.sess(); return !!(s && s.status === 'CONNECTED' && s.client && s.client.ready && s.accountId); }
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }
  setActive(on) { this.active = on === true; this.log(this.active ? 'robot ACTIVÉ' : 'robot ARRÊTÉ (les trades ouverts restent gérés)'); this.save(); return { ok: true, active: this.active }; }
  setConfig(src) {
    const c = this.config; src = src || {};
    const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
    n('maxDailyLossPct', 0, 50); n('maxTotalRiskPct', 0.5, 50); n('riskBase', 0.1, 10); n('riskHigh', 0.1, 10); n('highScore', 0, 100); n('maxRealRiskPct', 1, 50); n('minExpR', 0, 5); n('minRR', 0, 10);
    c.liveExecution = true;   // plus de PAPER : toujours réel
    if (Array.isArray(src.symbols)) { const s = src.symbols.map(x => String(x).toUpperCase()).filter(x => PAIRS.indexOf(x) >= 0); if (s.length) c.symbols = Array.from(new Set(s)); }
    if (src.aliases && typeof src.aliases === 'object') PAIRS.forEach(k => { if (typeof src.aliases[k] === 'string') c.aliases[k] = norm(src.aliases[k]); });
    this.save(); return { ok: true, config: c };
  }
  resetStats() { this.stats = { bySymbol: {} }; this.history = []; this.save(); return { ok: true }; }

  resolve(want) {
    const s = this.sess(), specs = (s && s.specs) || {}, a = this.config.aliases[want]; if (a && specs[a]) return a;
    const keys = Object.keys(specs); return keys.find(k => MATCH[want].test(k)) || null;
  }
  attach() {
    const s = this.sess(); if (!s || !s.client || this._client === s.client) return;
    this._client = s.client;
    s.client.on('message', m => { try { if (m && m.payloadType === PT.EXECUTION_EVENT) this.onExec(m.payload || {}); } catch (e) { this.log('exec : ' + (e && e.message)); } });
  }
  /** P/L réel d'une clôture (partielle ou finale) : brut + swap + commission */
  onExec(p) {
    const d = p.deal, pos = p.position; if (!d || !d.closePositionDetail || !pos || !pos.tradeData || pos.tradeData.label !== LABEL) return;
    const cm = String(pos.tradeData.comment || ''), id = baseId(cm), sym = Object.keys(this.ph).find(k => this.ph[k].id === id); if (!sym) return;
    const st = this.ph[sym], c = d.closePositionDetail, s = this.sess(), md = c.moneyDigits != null ? Number(c.moneyDigits) : (s && s.moneyDigits != null ? Number(s.moneyDigits) : 2);
    st.realized = r2((st.realized || 0) + (Number(c.grossProfit) + Number(c.swap || 0) + Number(c.commission || 0) + Number(c.pnlConversionFee || 0)) / Math.pow(10, md));
    st.closePx = Number(d.executionPrice) || st.closePx;
    if (/:1$/.test(cm)) st.leg1Px = Number(d.executionPrice) || st.leg1Px;   // prix de sortie de la position 1 (TP1 ou SL)
    if (pos.positionStatus === 2 || pos.positionStatus === 'POSITION_STATUS_CLOSED') st.gotClose = true;
  }
  async refresh() {
    const s = this.sess(), rec = await s.client.request(PT.RECONCILE_REQ, { ctidTraderAccountId: s.accountId });
    const sideOf = v => (v === 1 || v === 'BUY' || v === 'TRADE_SIDE_BUY' ? 'BUY' : 'SELL');
    const positions = (rec.payload.position || []).filter(p => p && p.tradeData && p.tradeData.label === LABEL && (p.positionStatus === 1 || p.positionStatus === 'POSITION_STATUS_OPEN' || p.positionStatus == null))
      .map(p => ({ id: String(p.positionId), comment: String(p.tradeData.comment || ''), volume: Number(p.tradeData.volume), price: Number(p.price), side: sideOf(p.tradeData.tradeSide) }));
    const orders = (rec.payload.order || []).filter(o => o && o.tradeData && o.tradeData.label === LABEL).map(o => ({ id: String(o.orderId), comment: String(o.tradeData.comment || '') }));
    this.live = { positions, orders, at: this.now() };
  }
  unitsPerLot(sp) { return Math.max(1e-9, sp.lotSize / 100); }
  /** devise de cotation -> USD : USDJPY (et USDxxx) cote en JPY etc. : 1 unité = 1/prix USD. Les autres (XAUUSD, EURUSD, GBPUSD, AUDUSD, indices) cotent en USD. */
  conv(name, px) { return /^USD[A-Z]{3}$/.test(norm(name)) && px > 0 ? 1 / px : 1; }
  /** probabilité MESURÉE par backtest (score -> tranche ; sinon la paire) ; sans valeur tant que l'échantillon < 30 trades */
  probFor(sym, score) {
    const P = this.prob[sym]; if (!P || !P.all) return null;
    const b = P.buckets && P.buckets[E.bucketOf(score, this.config.highScore)], use = b && b.reliable ? b : (P.all.reliable ? P.all : null);
    if (!use) return { p: null, n: P.all.n, note: 'échantillon insuffisant (< ' + E.MIN_N + ' trades)' };
    return { p: use.p, lo: use.lo, hi: use.hi, n: use.n, pTP2: use.pTP2, expR: use.expR, scope: use === b ? 'score' : 'paire' };
  }
  lotsFor(sp, bal, riskPct, slDist) {
    const step = sp.lotStep || 0.01, min = sp.minLot || 0.01, max = sp.maxLot || 1e9, fl = v => Math.round(Math.floor(v / step + 1e-9) * step * 1e6) / 1e6;
    const lots = slDist > 0 ? (bal * riskPct / 100) / (slDist * this.unitsPerLot(sp)) : min;
    return clamp(Math.max(min, fl(lots)), min, max);
  }
  quote(name) { const s = this.sess(), sp = s && s.specs && s.specs[name], q = sp && s.quotes && s.quotes[String(sp.symbolId)]; return (!q || !(q.bid > 0) || !(q.ask > 0)) ? null : q; }
  exposure() { return Object.keys(this.ph).reduce((a, k) => a + (['PENDING', 'OPEN', 'TP1'].indexOf(this.ph[k].phase) >= 0 ? num(this.ph[k].riskPct, 0) : 0), 0); }

  async bars(name) {
    const s = this.sess(), t = this.now(), m5 = await s.fetchHistory(name, 5, t - 3 * 86400000, t), m15 = await s.fetchHistory(name, 15, t - 10 * 86400000, t);
    return { m5: m5.filter(b => b.t + 300000 <= t), m15: m15.filter(b => b.t + 900000 <= t) };
  }
  async scan(sym, name, t) {
    const st = this.ph[sym], d = await this.bars(name), r = E.analyze(sym, d.m15, d.m5, t, this.config);
    st.info = r.reason; st.view = r.state === 'SETUP' ? { dir: r.dir, entry: r.entry, sl: r.sl, tp1: r.tp1, tp2: r.tp2, rr1: r2(r.rr1), rr2: r2(r.rr2), score: r.score, why: r.why, riskPct: r.riskPct, prob: this.probFor(sym, r.score) } : (r.dir ? { dir: r.dir } : null);
    if (st.phase === 'PENDING') {   // ordre en attente : toujours valable ?
      if (r.state === 'SETUP' && r.id === st.setupId) return;
      if (r.state === 'MISSED' && r.reason === 'zone déjà touchée') return;   // touché : exécution en cours
      await this.cancelPending(sym, 'setup invalidé : ' + r.reason); return;
    }
    if (st.phase !== 'SCAN' && st.phase !== 'WAIT') return;
    st.phase = r.state === 'WAIT_CHOCH' ? 'WAIT' : 'SCAN';
    if (r.state !== 'SETUP' || !this.active) return;
    if (this.skip[r.id]) { st.info = 'setup annulé manuellement'; return; }
    await this.place(sym, name, r, t);
  }
  gate(sym, r) {
    const c = this.config, dk = this.dayKey(), s = this.sess();
    if (this.fills[sym] === dk) return '1 trade par jour déjà pris sur ' + sym;
    if (c.maxDailyLossPct > 0 && this.day.startBalance > 0 && -(this.day.pnl || 0) >= this.day.startBalance * c.maxDailyLossPct / 100) return 'pause : perte du jour atteinte';
    if (this.exposure() + r.riskPct > Math.max(c.maxTotalRiskPct, num(c.maxRealRiskPct, 0))) return 'risque total ouvert trop élevé';
    if (!(num(s.balance, 0) > 0)) return 'solde inconnu';
    return null;
  }
  async place(sym, name, r, t) {
    const st = this.ph[sym], s = this.sess(), sp = s.specs[name], q = this.quote(name), S = r.dir === 'SELL', why = this.gate(sym, r);
    if (why) { st.info = why; return; }
    const dec = E.decide(this.prob[sym], r.score, this.config);   // décision automatique issue du backtest
    if (!dec.ok) { st.info = dec.note; return; }
    if (!q) { st.info = 'pas de prix'; return; }
    if (S ? q.bid >= r.entry : q.ask <= r.entry) { st.info = 'prix déjà dans la zone d\'entrée'; return; }
    const bal = num(s.balance, 0), riskPct = dec.learn ? r.riskPct : dec.riskPct, slDist = Math.abs(r.sl - r.entry) * this.conv(name, r.entry), lots = dec.learn ? (sp.minLot || 0.01) : this.lotsFor(sp, bal, dec.riskPct, slDist), risk$ = lots * slDist * this.unitsPerLot(sp);
    const realPct = bal > 0 ? risk$ / bal * 100 : 0;   // petit compte : le lot minimum peut dépasser le risque voulu ; accepté seulement jusqu'à maxRealRiskPct % du solde
    if (realPct > riskPct * 1.05 && realPct > num(this.config.maxRealRiskPct, 10)) { st.info = 'lot minimal trop gros pour ce SL : risque ' + r2(risk$) + ' $ (' + r2(realPct) + ' % > ' + num(this.config.maxRealRiskPct, 10) + ' % max)'; return; }
    const id = 'C' + sym + t.toString(36), px = x => Number(Number(x).toFixed(sp.digits));
    let vol = s._volume(sp, lots); if (sp.maxVolume > 0) vol = Math.min(vol, sp.maxVolume);
    // 2 positions : moitié -> TP1, moitié -> TP2. Lot trop petit pour couper en 2 : 1 seule position vers TP2 (SL -> BE quand le prix touche TP1).
    const step = sp.stepVolume || 1, min = sp.minVolume || 0, v1 = Math.floor(vol / 2 / step) * step, v2 = Math.floor((vol - v1) / step) * step, split = v1 >= min && v1 > 0 && v2 >= min;
    const single = !!r.single, dual = split && !single;
    Object.assign(st, { id, setupId: r.id, dir: r.dir, entry: px(r.entry), sl: px(r.sl), tp1: px(r.tp1), tp2: px(r.tp2), rr1: r2(r.rr1), rr2: r2(r.rr2), score: r.score, why: r.why, prob: this.probFor(sym, r.score), riskPct: r2(realPct), riskMoney: r2(risk$), lots, volume: vol, split: dual, single, name, realized: 0, gotClose: false, tp1done: false, leg1Px: null, phase: 'PENDING', sentAt: t });
    const legs = single ? [[vol, st.tp1, ':0']] : dual ? [[v1, st.tp1, ':1'], [v2, st.tp2, ':2']] : [[vol, st.tp2, ':0']];
    try {
      for (const L of legs) await s.client.request(PT.NEW_ORDER_REQ, { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, orderType: 2, tradeSide: S ? 2 : 1, volume: L[0], limitPrice: st.entry, stopLoss: st.sl, takeProfit: L[1], timeInForce: 1, expirationTimestamp: t + 20 * 3600000, label: LABEL, comment: id + L[2] });
      st.info = single ? 'ordre limit placé (TP1 seul · lot x2 · RR < 1:2)' : dual ? 'ordres limit placés (2 positions : TP1 + TP2)' : 'ordre limit placé (1 position, lot trop petit pour 2)';
      this.log(`${sym} : ${r.dir} LIMIT ${st.entry} · SL ${st.sl} · TP1 ${st.tp1} (RR ${st.rr1}) · TP2 ${st.tp2} (RR ${st.rr2}) · ${lots} lot${dual ? ' (2 positions)' : single ? ' (TP1 seul, lot x2)' : ''} · risque ${riskPct} %`);
    } catch (e) {
      this.log(sym + ' : ordre refusé : ' + (e && e.message)); st.phase = 'SCAN'; st.info = 'ordre refusé'; this.skip[r.id] = true;
      await this.refresh().catch(() => {}); for (const o of this.live.orders.filter(x => baseId(x.comment) === id)) { try { await s.cancelOrder(o.id); } catch (e2) { /* ignore */ } }   // annule la 1re jambe si la 2e est refusée
    }
    this.save();
  }
  async cancelPending(sym, why) {
    const st = this.ph[sym], s = this.sess();
    for (const o of this.live.orders.filter(x => baseId(x.comment) === st.id)) { try { await s.cancelOrder(o.id); } catch (e) { this.log(sym + ' : annulation impossible (' + (e && e.message) + ')'); return false; } }
    this.log(sym + ' : ordre annulé · ' + why); if (st.setupId) this.skip[st.setupId] = true;
    st.phase = 'SCAN'; st.info = 'annulé : ' + why; st.view = null; this.save(); return true;
  }
  /** bouton « Annuler » du site : ordre en attente -> annulé ; trade ouvert -> fermé au marché */
  async cancel(sym) {
    sym = String(sym || '').toUpperCase(); const st = this.ph[sym]; if (!st) return { ok: false, error: 'paire inconnue' };
    await this.refresh().catch(() => {});
    if (st.phase === 'PENDING') { const ok = await this.cancelPending(sym, 'annulé par l\'utilisateur'); return { ok }; }
    if (st.phase === 'OPEN' || st.phase === 'TP1') { const ps = this.live.positions.filter(x => baseId(x.comment) === st.id); if (!ps.length) return { ok: false, error: 'position introuvable' }; st.closing = 'MANUEL'; for (const p of ps) await this.closePos(p, p.volume); return { ok: true }; }
    return { ok: false, error: 'rien à annuler' };
  }
  async closePos(p, volume) { const s = this.sess(); try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume }); return true; } catch (e) { this.log('clôture ' + p.id + ' : ' + (e && e.message)); return false; } }
  /** SL de la position -> prix d'entrée (breakeven), TP inchangé */
  async amendBE(sym, p, tp) {
    const st = this.ph[sym], s = this.sess(), sp = s.specs[st.name];
    try { await s.client.request(PT.AMEND_POSITION_SLTP_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), stopLoss: Number(Number(st.entry).toFixed(sp.digits)), takeProfit: tp }); st.be = true; this.log(sym + ' : SL → BE'); return true; }
    catch (e) { this.log(sym + ' : BE impossible : ' + (e && e.message)); return false; }
  }
  async manage(sym) {
    const st = this.ph[sym], t = this.now();
    const legs = this.live.positions.filter(x => baseId(x.comment) === st.id), ords = this.live.orders.filter(x => baseId(x.comment) === st.id);
    if (st.phase === 'PENDING') {
      if (legs.length) { st.phase = 'OPEN'; st.openedAt = t; st.fill = legs[0].price; this.fills[sym] = this.dayKey(); st.info = 'trade ouvert'; this.log(`${sym} : ${st.dir} ouvert @ ${legs[0].price}`); this.save(); }
      else if (!ords.length && t - st.sentAt > 8000) { st.phase = 'SCAN'; st.info = 'ordre expiré / annulé'; st.view = null; this.save(); }
      return;
    }
    if (st.phase !== 'OPEN' && st.phase !== 'TP1') return;
    if (!legs.length) {   // toutes les positions sont fermées : bilan
      if (!st.gotClose && t - (st.lastSeen || t) < 4000) return;
      return this.finish(sym);
    }
    st.lastSeen = t;
    if (st.tp1done || st.busyTp1) return;
    const S = st.dir === 'SELL', eps = Math.abs(st.entry - st.tp1) * 0.1;
    st.busyTp1 = true;
    try {
      if (st.split) {   // position 1 fermée par son TP1 (le courtier l'a exécutée) -> SL de la position 2 au BE
        const l1 = legs.find(x => /:1$/.test(x.comment)), l2 = legs.find(x => /:2$/.test(x.comment));
        if (!l1 && l2 && st.leg1Px != null && (S ? st.leg1Px <= st.tp1 + eps : st.leg1Px >= st.tp1 - eps)) {
          st.tp1done = true; st.phase = 'TP1'; st.info = 'TP1 touché (WIN) · position 2 -> TP2 · SL au BE'; this.log(sym + ' : TP1 touché'); await this.amendBE(sym, l2, st.tp2); this.save();
        }
      } else if (!st.single) {   // 1 seule position vers TP2 : SL -> BE quand le prix touche TP1 (TP1 seul : la position se ferme à TP1)
        const l0 = legs[0], q = this.quote(st.name);
        if (l0 && q && (S ? q.ask <= st.tp1 : q.bid >= st.tp1) && await this.amendBE(sym, l0, st.tp2)) { st.tp1done = true; st.phase = 'TP1'; st.info = 'TP1 touché (WIN) · SL au BE'; this.log(sym + ' : TP1 touché'); this.save(); }
      }
    } finally { st.busyTp1 = false; }
  }
  finish(sym) {
    const st = this.ph[sym], net = r2(st.realized || 0), S = st.dir === 'SELL', px = st.closePx, eps = Math.abs(st.entry - st.tp1) * 0.1;
    if (!st.tp1done && st.leg1Px != null && (S ? st.leg1Px <= st.tp1 + eps : st.leg1Px >= st.tp1 - eps)) st.tp1done = true;   // TP1 et TP2 touchés presque ensemble
    const e2 = Math.abs(st.entry - st.tp2) * 0.03;
    if (st.single && !st.closing && net > 0) st.tp1done = true;
    let res; if (st.closing) res = 'MANUEL'; else if (st.single) res = st.tp1done ? 'TP1' : 'SL'; else if (st.tp1done && px != null && Math.abs(px - st.tp2) <= e2) res = 'TP2'; else if (st.tp1done) res = 'BE'; else res = 'SL';
    const win = st.tp1done || net > 0, R = st.riskMoney > 0 ? r2(2 * net / st.riskMoney) : null, S0 = this.stats, SY = S0.bySymbol[sym] || (S0.bySymbol[sym] = { trades: 0, wins: 0, losses: 0, pnl: 0, rSum: 0, tp1: 0, tp2: 0, sl: 0, be: 0 });
    [S0, SY].forEach(x => { x.trades = (x.trades || 0) + 1; if (win) x.wins = (x.wins || 0) + 1; else x.losses = (x.losses || 0) + 1; x.pnl = r2((x.pnl || 0) + net); x.rSum = r2((x.rSum || 0) + (R || 0)); if (st.tp1done) x.tp1 = (x.tp1 || 0) + 1; if (res === 'TP2') x.tp2 = (x.tp2 || 0) + 1; if (res === 'SL') x.sl = (x.sl || 0) + 1; if (res === 'BE') x.be = (x.be || 0) + 1; });
    this.day.pnl = r2((this.day.pnl || 0) + net);
    this.history.unshift({ symbol: sym, dir: st.dir, entry: st.entry, sl: st.sl, tp1: st.tp1, tp2: st.tp2, rr1: st.rr1, rr2: st.rr2, lots: st.lots, openedAt: st.openedAt, closedAt: this.now(), res, pnl: net, R });
    this.log(`${sym} : clôturé → ${res} ${net >= 0 ? '+' : ''}${net} $ (${R == null ? '?' : R} R)`);
    this.ph[sym] = { phase: 'SCAN', info: 'en attente du prochain CRT' }; this.save();
  }
  async tick() {
    if (this.busy) return; this.busy = true;
    try {
      if (!this.connected()) return;
      this.attach(); const s = this.sess(), t = this.now(), dk = this.dayKey();
      if (this.day.date !== dk) { this.day = { date: dk, startBalance: num(s.balance, null), pnl: 0 }; this.save(); }
      if (t - this.lastRef >= 2000) { this.lastRef = t; await this.refresh(); }
      const names = {};
      for (const sym of this.config.symbols) {
        const name = this.resolve(sym); if (!name) { this.ph[sym] = Object.assign(this.ph[sym] || { phase: 'SCAN' }, { phase: 'SCAN', info: 'symbole introuvable chez le broker', name: null }); continue; }
        names[sym] = name; const st = this.ph[sym] || (this.ph[sym] = { phase: 'SCAN', info: 'démarrage' }); st.name = st.name || name;
        if (st.phase === 'PENDING' || st.phase === 'OPEN' || st.phase === 'TP1') await this.manage(sym);
      }
      const slot = Math.floor(t / 900000), due = t - slot * 900000 >= 3000;   // 3 s après chaque clôture M15
      for (const sym of Object.keys(names)) {
        const st = this.ph[sym]; if (!due || st.slot === slot) continue;
        if (st.phase !== 'SCAN' && st.phase !== 'WAIT' && st.phase !== 'PENDING') continue;
        st.slot = slot; try { await this.scan(sym, names[sym], t); } catch (e) { st.info = 'analyse : ' + String(e && e.message || e).slice(0, 100); }
      }
    } finally { this.busy = false; }
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {}); const s = this.sess();
    for (const p of this.live.positions) { const k = Object.keys(this.ph).find(x => this.ph[x].id === baseId(p.comment)); if (k) this.ph[k].closing = 'MANUEL'; await this.closePos(p, p.volume); }
    for (const o of this.live.orders) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    Object.keys(this.ph).forEach(k => { if (this.ph[k].phase === 'PENDING') { this.ph[k].phase = 'SCAN'; this.ph[k].info = 'annulé : ' + (reason || 'arrêt'); } });
    this.save(); return { ok: true };
  }
  status() {
    const s = this.sess(), c = this.connected(), SY = this.stats.bySymbol;
    const pairs = this.config.symbols.map(sym => {
      const st = this.ph[sym] || { phase: 'SCAN', info: '' }, y = SY[sym] || { trades: 0, wins: 0, losses: 0, pnl: 0, tp1: 0, tp2: 0, sl: 0, be: 0 };
      const state = { SCAN: 'ANALYSE', WAIT: 'EN ATTENTE CHoCH M15', PENDING: 'ORDRE LIMIT PLACÉ', OPEN: 'TRADE OUVERT', TP1: 'TP1 TOUCHÉ' }[st.phase] || st.phase;
      const v = (st.phase === 'PENDING' || st.phase === 'OPEN' || st.phase === 'TP1') ? st : (st.view || {});
      return { symbol: sym, broker: st.name || null, state, phase: st.phase, info: st.info || '', dir: v.dir || null, entry: v.entry || null, sl: v.sl || null, tp1: v.tp1 || null, tp2: v.tp2 || null, rr1: v.rr1 || null, rr2: v.rr2 || null, prob: v.prob || null, score: v.score != null ? v.score : null, riskPct: v.riskPct || null, lots: st.lots || null, cancellable: st.phase === 'PENDING' || st.phase === 'OPEN' || st.phase === 'TP1',
        stats: { trades: y.trades, wins: y.wins, losses: y.losses, winrate: y.trades ? Math.round(y.wins / y.trades * 1000) / 10 : 0, pnl: y.pnl, tp1: y.tp1, tp2: y.tp2, sl: y.sl, be: y.be, rSum: r2(y.rSum || 0), expectancyR: y.trades ? r2((y.rSum || 0) / y.trades) : null } };
    });
    const S = this.stats, tot = { trades: S.trades || 0, wins: S.wins || 0, losses: S.losses || 0, pnl: S.pnl || 0, rSum: r2(S.rSum || 0) }; tot.expectancyR = tot.trades ? r2(tot.rSum / tot.trades) : null; tot.winrate = tot.trades ? Math.round(tot.wins / tot.trades * 1000) / 10 : 0;
    return { ok: true, active: this.active, connected: c, state: !c ? 'CTRADER NON CONNECTÉ' : this.active ? 'ROBOT ACTIF' : 'ARRÊTÉ', balance: c ? num(s.balance, null) : null, config: this.config, dayPnl: this.day.pnl || 0, exposure: this.exposure(), pairs, total: tot, history: this.history.slice(0, 50), logs: this.logs.slice(0, 40) };
  }
  // ---------- backtest ----------
  backtestStart(P) {
    const s = this.sess(); if (!this.connected()) throw new Error('cTrader non connecté');
    const id = 'bt' + this.now().toString(36), months = clamp(Math.round(num(P && P.months, 12)), 1, 12), bal = clamp(num(P && P.balance, 100), 1, 1000000);
    const job = this.jobs[id] = { id, status: 'run', progress: 0, msg: 'démarrage', months, result: null, error: null };
    Object.keys(this.jobs).slice(0, -3).forEach(k => delete this.jobs[k]);
    (async () => {
      try {
        const syms = PAIRS.slice(), prev = this.config.symbols.slice(), to = this.now(), from = to - months * 30 * 86400000, out = [], ctx = {};
        for (let i = 0; i < syms.length; i++) {
          const sym = syms[i], name = this.resolve(sym); if (!name) { out.push({ symbol: sym, error: 'symbole introuvable chez le broker' }); continue; }
          const m5 = (await s.fetchHistory(name, 5, from - 4 * 86400000, to, f => { job.progress = (i + f) / syms.length; job.msg = sym + ' : historique M5'; })).filter(b => b.t + 300000 <= to);
          const m15 = E.agg(m5, 900000, to); const sp0 = s.specs[name] || {}; ctx[sym] = { U: this.unitsPerLot(sp0) * this.conv(name, m5.length ? m5[m5.length - 1].c : 1), minLot: sp0.minLot || 0.01, step: sp0.lotStep || 0.01 };
          job.msg = sym + ' : simulation'; await sleep(5);
          const r = E.backtest(sym, m15, m5, { from, to, cfg: this.config }); out.push({ symbol: sym, stats: r.stats, trades: r.trades.length, prob: this.prob[sym] = Object.assign(E.probability(r.trades, this.config.highScore), { months, at: this.now() }) }); this.save();
          out[out.length - 1]._t = r.trades; out[out.length - 1].verdict = E.verdicts(this.prob[sym], this.config); out[out.length - 1].sim = E.simulate(r.trades, bal, ctx, this.config);
        }
        const ok = out.filter(x => x.stats), all = ok.map(x => ({ trades: x._t })), total = ok.length ? E.mergeStats(all) : null;
        total && (total.perWeek = Math.round(ok.reduce((a, x) => a + x.stats.trades, 0) / (months * 30 / 7) * 10) / 10);
        // RETRAIT AUTOMATIQUE : toute paire mesurée (>= 20 trades) sous le R/trade minimum sort de la liste (plus scannée, plus tradée) ; celles qui passent y entrent
        const keep = [], removed = [];
        out.forEach(x => { const A = this.prob[x.symbol] && this.prob[x.symbol].all, was = prev.indexOf(x.symbol) >= 0; if (!x.stats || !A || A.n < 20) { if (was) keep.push(x.symbol); return; } if (A.expR < num(this.config.minExpR, 0.15)) { x.removed = true; removed.push(x.symbol); } else keep.push(x.symbol); });
        this.config.symbols = keep; this.save();
        if (total) total.sim = E.simulate([].concat.apply([], ok.filter(x => keep.indexOf(x.symbol) >= 0).map(x => x._t)), bal, ctx, this.config);
        out.forEach(x => delete x._t); job.result = { months, balance: bal, removed, kept: keep, pairs: out, total, note: 'Simulation sur historique réel M5 · 1 trade/jour/paire · SL prioritaire dans une même bougie · 1R = risque d\'une position · SL = −2R · TP1 (+BE) = +rr1 = win · TP1 + TP2 = rr1 + rr2 · RR setup < 1:2 : TP1 seul, lot ×2 = +2×rr1 · probabilités = taux réellement mesurés (affichés seulement si ≥ 30 trades) · spread et commissions non inclus' };
        job.status = 'done'; job.progress = 1; job.msg = 'terminé';
      } catch (e) { job.status = 'error'; job.error = String(e && e.message || e).slice(0, 200); }
    })();
    return { ok: true, id };
  }
  backtestGet(id) { const j = this.jobs[id]; return j ? Object.assign({ ok: true }, j) : { ok: false, error: 'backtest introuvable' }; }
}

module.exports = function createCrt({ manager, dataRoot }) {
  const users = new Map();
  const get = uid => { if (!users.has(uid)) users.set(uid, new UserCrt({ userId: uid, dataRoot, manager })); return users.get(uid); };
  const emergencyStop = async uid => { const u = get(uid); u.active = false; u.save(); try { await u.closeAll('ARRÊT D\'URGENCE'); } catch (e) { /* ignore */ } return { ok: true }; };
  return {
    get,
    tickAll: async () => { for (const u of users.values()) await u.tick(); },
    start: ids => {
      const all = new Set(ids || []);
      try { fs.readdirSync(dataRoot).forEach(f => { const m = /^crt-([A-Za-z0-9_-]+)\.json$/.exec(f); if (m) all.add(m[1]); }); } catch (e) { /* premier démarrage */ }
      all.forEach(id => { get(id); try { manager.engine(id).setAutoTrade(false); } catch (e) { /* ancien moteur absent */ } });
    },
    emergencyStop,
    emergencyStopAll: async () => { for (const id of Array.from(users.keys())) await emergencyStop(id); return { ok: true }; }
  };
};
module.exports.DEFAULTS = DEFAULTS;
