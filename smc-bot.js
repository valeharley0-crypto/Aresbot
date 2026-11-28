'use strict';
/**
 * SMC — robot cTrader (XAUUSD + EURUSD).
 * Biais H1/H4 · M15 direction + POI · M5 confirmation + entrée · SL 50-100 pips · TP en RR fixe · BE à 50 % du chemin.
 * Le biais (H1/H4), le RR (2/3) et le mode d'entrée (LIMIT / DIRECT / LES DEUX) sont choisis AUTOMATIQUEMENT par le backtest
 * (sélection sur la 1re moitié de la période, vérification sur la 2e moitié), sauf si l'utilisateur impose un choix.
 * Ordres envoyés pour de vrai (utiliser un compte DEMO pour tester). Aucun profit n'est garanti.
 */
const fs = require('fs');
const path = require('path');
const { PT } = require('./ctrader/client');
const E = require('./smc-engine');

const LABEL = 'ARESSMC';
const PAIRS = ['XAUUSD', 'EURUSD'];
const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = x => Math.round(x * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const DEFAULTS = { symbols: PAIRS.slice(), aliases: {}, biasMode: 'AUTO', rrMode: 'AUTO', entryMode: 'AUTO', riskBase: 1, riskHigh: 2, maxDailyLossPct: 3, minPerWeek: 5, minN: 30, autoBacktest: true };
const STATE_LABEL = { SCAN: 'ANALYSE', PENDING: 'ORDRE EN ATTENTE', OPEN: 'TRADE OUVERT', BE: 'BE ACTIF (trade protégé)' };

class UserSmc {
  constructor({ userId, dataRoot, manager }) {
    this.userId = userId; this.manager = manager; this.file = path.join(dataRoot, 'smc-' + userId + '.json');
    this.active = false; this.config = JSON.parse(JSON.stringify(DEFAULTS)); this.chosen = null; this.btRows = null; this.btAt = 0;
    this.ph = {}; this.stats = { bySymbol: {} }; this.history = []; this.fills = {}; this.skip = {}; this.logs = [];
    this.day = { date: null, startBalance: null, pnl: 0 }; this.live = { positions: [], orders: [], at: 0 };
    this.busy = false; this.lastRef = 0; this.jobs = {}; this._client = null;
    try { const j = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.active = j.active === true; Object.assign(this.config, j.config || {}); ['chosen', 'btRows', 'btAt', 'ph', 'stats', 'history', 'fills', 'skip', 'day'].forEach(k => { if (j[k] !== undefined) this[k] = j[k]; }); } catch (e) { /* premier démarrage */ }
  }
  now() { return Date.now(); }
  log(m) { this.logs.unshift({ t: new Date().toISOString(), msg: String(m).slice(0, 240) }); if (this.logs.length > 120) this.logs.length = 120; }
  save() { try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ active: this.active, config: this.config, chosen: this.chosen, btRows: this.btRows, btAt: this.btAt, ph: this.ph, stats: this.stats, history: this.history.slice(0, 300), fills: this.fills, skip: this.skip, day: this.day })); } catch (e) { /* ignore */ } }
  sess() { try { return this.manager.session(this.userId); } catch (e) { return null; } }
  connected() { const s = this.sess(); return !!(s && s.status === 'CONNECTED' && s.client && s.client.ready && s.accountId); }
  dayKey() { return new Date(this.now()).toISOString().slice(0, 10); }
  setActive(on) { this.active = on === true; this.log(this.active ? 'robot ACTIVÉ' : 'robot ARRÊTÉ (les trades ouverts restent protégés par leur SL/TP)'); this.save(); return { ok: true, active: this.active }; }
  setConfig(src) {
    const c = this.config; src = src || {};
    const n = (k, lo, hi) => { if (src[k] !== undefined && src[k] !== '' && Number.isFinite(Number(src[k]))) c[k] = clamp(Number(src[k]), lo, hi); };
    n('riskBase', 0.1, 10); n('riskHigh', 0.1, 10); n('maxDailyLossPct', 0.5, 50); n('minPerWeek', 0, 50); n('minN', 10, 200);
    if (['AUTO', 'H1', 'H4'].indexOf(src.biasMode) >= 0) c.biasMode = src.biasMode;
    if (['AUTO', '2', '3'].indexOf(String(src.rrMode)) >= 0) c.rrMode = String(src.rrMode);
    if (['AUTO', 'LIMIT', 'DIRECT', 'BOTH'].indexOf(src.entryMode) >= 0) c.entryMode = src.entryMode;
    if (typeof src.autoBacktest === 'boolean') c.autoBacktest = src.autoBacktest;
    if (src.aliases && typeof src.aliases === 'object') PAIRS.forEach(k => { if (typeof src.aliases[k] === 'string') c.aliases[k] = norm(src.aliases[k]); });
    this.save(); return { ok: true, config: c };
  }
  resetStats() { this.stats = { bySymbol: {} }; this.history = []; this.save(); return { ok: true }; }

  /** paramètres effectifs : auto (backtest) ou imposés */
  eff() {
    const c = this.config, ch = this.chosen;
    const biasTf = c.biasMode === 'AUTO' ? (ch && ch.biasTf) : c.biasMode, rr = c.rrMode === 'AUTO' ? (ch && ch.rr) : Number(c.rrMode), mode = c.entryMode === 'AUTO' ? (ch && ch.mode) : c.entryMode;
    return { biasTf, rr, mode, ready: !!(biasTf && rr && mode) };
  }
  tableFor(sym, e) { const t = this.chosen && this.chosen.tables && this.chosen.tables[sym]; return (t && t[e.biasTf + '|' + e.rr]) || null; }

  resolve(want) {
    const s = this.sess(), specs = (s && s.specs) || {}, a = this.config.aliases[want]; if (a && specs[a]) return a;
    return Object.keys(specs).find(k => E.PAIR_MATCH[want].test(k)) || null;
  }
  attach() {
    const s = this.sess(); if (!s || !s.client || this._client === s.client) return; this._client = s.client;
    s.client.on('message', m => { try { if (m && m.payloadType === PT.EXECUTION_EVENT) this.onExec(m.payload || {}); } catch (e) { this.log('exec : ' + (e && e.message)); } });
  }
  onExec(p) {
    const d = p.deal, pos = p.position; if (!d || !d.closePositionDetail || !pos || !pos.tradeData || pos.tradeData.label !== LABEL) return;
    const id = String(pos.tradeData.comment || ''), sym = Object.keys(this.ph).find(k => this.ph[k].id === id); if (!sym) return;
    const st = this.ph[sym], c = d.closePositionDetail, s = this.sess(), md = c.moneyDigits != null ? Number(c.moneyDigits) : (s && s.moneyDigits != null ? Number(s.moneyDigits) : 2);
    st.realized = r2((st.realized || 0) + (Number(c.grossProfit) + Number(c.swap || 0) + Number(c.commission || 0) + Number(c.pnlConversionFee || 0)) / Math.pow(10, md));
    st.closePx = Number(d.executionPrice) || st.closePx;
    if (pos.positionStatus === 2 || pos.positionStatus === 'POSITION_STATUS_CLOSED') st.gotClose = true;
  }
  async refresh() {
    const s = this.sess(), rec = await s.client.request(PT.RECONCILE_REQ, { ctidTraderAccountId: s.accountId });
    const positions = (rec.payload.position || []).filter(p => p && p.tradeData && p.tradeData.label === LABEL && (p.positionStatus === 1 || p.positionStatus === 'POSITION_STATUS_OPEN' || p.positionStatus == null))
      .map(p => ({ id: String(p.positionId), comment: String(p.tradeData.comment || ''), volume: Number(p.tradeData.volume), price: Number(p.price), tp: Number(p.takeProfit) || null, sl: Number(p.stopLoss) || null }));
    const orders = (rec.payload.order || []).filter(o => o && o.tradeData && o.tradeData.label === LABEL).map(o => ({ id: String(o.orderId), comment: String(o.tradeData.comment || '') }));
    this.live = { positions, orders, at: this.now() };
  }
  quote(name) { const s = this.sess(), sp = s && s.specs && s.specs[name], q = sp && s.quotes && s.quotes[String(sp.symbolId)]; return (!q || !(q.bid > 0) || !(q.ask > 0)) ? null : q; }
  unitsPerLot(sp) { return Math.max(1e-9, sp.lotSize / 100); }
  /** lot automatique selon le setup (risque % / distance du SL) ; si le lot minimal dépasse le risque, le robot PREND le trade quand même et affiche le risque réel */
  sizing(sp, name, bal, riskPct, slDist) {
    const s = this.sess(), rate = s._quoteToDeposit(name); if (!(rate > 0)) return null;
    const step = sp.lotStep || 0.01, min = sp.minLot || 0.01, max = sp.maxLot || 1e9, per = slDist * this.unitsPerLot(sp) * rate;
    const want = (bal * riskPct / 100) / per, lots = clamp(Math.max(min, Math.floor(want / step + 1e-9) * step), min, max);
    const risk$ = lots * per; return { lots: Math.round(lots * 1e6) / 1e6, risk$: r2(risk$), realPct: r2(bal > 0 ? risk$ / bal * 100 : 0), minLotForced: want < min };
  }
  async bars(name) {
    const s = this.sess(), t = this.now();
    const m5 = await s.fetchHistory(name, 5, t - 7 * 86400000, t), m15 = await s.fetchHistory(name, 15, t - 25 * 86400000, t);
    return { m5: m5.filter(b => b.t + 300000 <= t), m15: m15.filter(b => b.t + 900000 <= t) };
  }
  gate(sym) {
    const c = this.config, s = this.sess();
    if (this.fills[sym] === this.dayKey()) return '1 trade par jour déjà pris sur ' + sym;
    if (c.maxDailyLossPct > 0 && this.day.startBalance > 0 && -(this.day.pnl || 0) >= this.day.startBalance * c.maxDailyLossPct / 100) return 'pause : perte du jour atteinte';
    if (!(num(s.balance, 0) > 0)) return 'solde inconnu';
    return null;
  }

  async scan(sym, name, t) {
    const st = this.ph[sym], e = this.eff();
    if (!e.ready) { st.info = this.chosen === null && this.btAt ? 'aucun réglage rentable au backtest : robot en pause' : 'en attente du backtest (réglage automatique)'; st.zones = []; return; }
    const d = await this.bars(name), P = E.prep(sym, d.m5, d.m15, e.biasTf, t);
    if (d.m5.length < 200 || d.m15.length < 300) { st.info = 'historique insuffisant'; return; }
    const i = d.m5.length - 1, r = E.decide(P, i, { mode: e.mode, rr: e.rr, prob: this.tableFor(sym, e), minN: this.config.minN });
    st.bias = r.bias; st.info = r.reason; st.price = r.price;
    st.zones = r.zones.filter(z => z.fresh).sort((a, b) => (b.prob && b.prob.ok ? 1 : 0) - (a.prob && a.prob.ok ? 1 : 0) || Math.abs(a.mid - r.price) - Math.abs(b.mid - r.price)).slice(0, 8);
    if (st.phase === 'PENDING' && st.planObj) {
      const v = E.stillValid(P, st.planObj, i); if (!v.ok) { await this.cancelPending(sym, v.reason); return; }
      return;
    }
    if (st.phase !== 'SCAN' || !this.active) return;
    const plan = r.plan; if (!plan) return;
    if (this.skip[plan.id]) { st.info = 'setup déjà traité'; return; }
    await this.place(sym, name, plan, e, t);
  }
  async place(sym, name, plan, e, t) {
    const st = this.ph[sym], s = this.sess(), sp = s.specs[name], q = this.quote(name), S = plan.dir > 0, why = this.gate(sym);
    if (why) { st.info = why; return; }
    if (!q) { st.info = 'pas de prix'; return; }
    const riskPct = plan.type === 'ZONE' ? this.config.riskHigh : this.config.riskBase, bal = num(s.balance, 0), sz = this.sizing(sp, name, bal, riskPct, plan.slDist);
    if (!sz) { st.info = 'conversion de devise indisponible'; return; }
    const id = 'M' + sym.slice(0, 3) + t.toString(36), px = x => Number(Number(x).toFixed(sp.digits)); let vol = s._volume(sp, sz.lots); if (sp.maxVolume > 0) vol = Math.min(vol, sp.maxVolume);
    const market = plan.type === 'DIRECT', expire = t + (plan.type === 'ZONE' ? 72 : 6) * 3600000;
    if (!market && (S ? q.ask <= plan.entry : q.bid >= plan.entry)) { st.info = 'prix déjà au niveau de l’entrée'; return; }
    Object.assign(st, { id, planId: plan.id, planObj: plan, type: plan.type, dir: S ? 'BUY' : 'SELL', entry: px(plan.entry), sl: px(plan.sl), tp: px(plan.tp), beAt: px(plan.be), rr: plan.rr, slDist: plan.slDist, tpDist: plan.tpDist, lots: sz.lots, risk$: sz.risk$, riskPct, realRiskPct: sz.realPct, minLotForced: sz.minLotForced, prob: plan.prob || null, volume: vol, realized: 0, gotClose: false, beDone: false, closing: null, phase: 'PENDING', sentAt: t });
    const base = { ctidTraderAccountId: s.accountId, symbolId: sp.symbolId, tradeSide: S ? 1 : 2, volume: vol, label: LABEL, comment: id };
    try {
      if (market) await s.client.request(PT.NEW_ORDER_REQ, Object.assign(base, { orderType: 1, relativeStopLoss: s._grid(sp, plan.slDist), relativeTakeProfit: s._grid(sp, plan.tpDist) }));
      else await s.client.request(PT.NEW_ORDER_REQ, Object.assign(base, { orderType: 2, limitPrice: st.entry, stopLoss: st.sl, takeProfit: st.tp, timeInForce: 1, expirationTimestamp: expire }));
      st.info = market ? 'entrée directe envoyée' : 'ordre limit placé';
      this.log(`${sym} : ${plan.type} ${st.dir} ${market ? 'MARCHÉ' : 'LIMIT ' + st.entry} · SL ${st.sl} · TP ${st.tp} · RR 1:${plan.rr} · ${sz.lots} lot · risque ${sz.realPct} %${sz.minLotForced ? ' (lot minimal : risque plus élevé que prévu)' : ''}`);
    } catch (er) { this.log(sym + ' : ordre refusé : ' + (er && er.message)); st.phase = 'SCAN'; st.info = 'ordre refusé'; this.skip[plan.id] = true; }
    this.save();
  }
  async cancelPending(sym, why) {
    const st = this.ph[sym], s = this.sess(); await this.refresh().catch(() => {});
    const o = this.live.orders.find(x => x.comment === st.id);
    if (o) { try { await s.cancelOrder(o.id); } catch (e) { this.log(sym + ' : annulation impossible (' + (e && e.message) + ')'); return false; } }
    this.log(sym + ' : ordre retiré · ' + why); if (st.planId) this.skip[st.planId] = true;
    st.phase = 'SCAN'; st.info = 'retiré : ' + why; st.planObj = null; this.save(); return true;
  }
  /** bouton « Annuler » du site : ordre en attente -> retiré ; trade ouvert -> fermé au marché */
  async cancel(sym) {
    sym = String(sym || '').toUpperCase(); const st = this.ph[sym]; if (!st) return { ok: false, error: 'paire inconnue' };
    await this.refresh().catch(() => {});
    if (st.phase === 'PENDING') return { ok: await this.cancelPending(sym, 'annulé par l’utilisateur') };
    if (st.phase === 'OPEN' || st.phase === 'BE') { const p = this.live.positions.find(x => x.comment === st.id); if (!p) return { ok: false, error: 'position introuvable' }; st.closing = 'MANUEL'; await this.closePos(p); return { ok: true }; }
    return { ok: false, error: 'rien à annuler' };
  }
  async closePos(p) { const s = this.sess(); try { await s.client.request(PT.CLOSE_POSITION_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), volume: p.volume }); return true; } catch (e) { this.log('clôture ' + p.id + ' : ' + (e && e.message)); return false; } }
  async amendBE(sym, p) {
    const st = this.ph[sym], s = this.sess(), sp = s.specs[st.name || ''] || s.specs[this.resolve(sym)], S = st.dir === 'BUY', fill = st.fill || p.price;
    const tp = p.tp || Number((S ? fill + st.tpDist : fill - st.tpDist).toFixed(sp.digits));
    try { await s.client.request(PT.AMEND_POSITION_SLTP_REQ, { ctidTraderAccountId: s.accountId, positionId: Number(p.id), stopLoss: Number(fill.toFixed(sp.digits)), takeProfit: tp }); return true; }
    catch (e) { this.log(sym + ' : BE impossible : ' + (e && e.message)); return false; }
  }
  async manage(sym) {
    const st = this.ph[sym], t = this.now(), p = this.live.positions.find(x => x.comment === st.id), o = this.live.orders.find(x => x.comment === st.id), q = this.quote(st.name || this.resolve(sym) || ''), S = st.dir === 'BUY';
    if (st.phase === 'PENDING') {
      if (p) { st.phase = 'OPEN'; st.openedAt = t; st.fill = p.price; if (st.type === 'DIRECT') { st.entry = p.price; st.beAt = Number((S ? p.price + 0.5 * st.tpDist : p.price - 0.5 * st.tpDist).toFixed(5)); } this.fills[sym] = this.dayKey(); st.info = 'trade ouvert'; this.log(`${sym} : ${st.dir} ouvert @ ${p.price}`); this.save(); return; }
      if (!o && t - st.sentAt > 8000) { st.phase = 'SCAN'; st.info = 'ordre expiré / annulé'; st.planObj = null; this.save(); return; }
      if (o && q && (S ? q.bid >= st.beAt : q.ask <= st.beAt)) await this.cancelPending(sym, 'le prix est parti à 50 % du setup sans remplir l’ordre');
      return;
    }
    if (st.phase !== 'OPEN' && st.phase !== 'BE') return;
    if (!p) { if (!st.gotClose && t - (st.lastSeen || t) < 4000) return; return this.finish(sym); }
    st.lastSeen = t;
    if (!st.beDone && q && !st.busyBe && (S ? q.bid >= st.beAt : q.ask <= st.beAt)) {
      st.busyBe = true;
      try { if (await this.amendBE(sym, p)) { st.beDone = true; st.phase = 'BE'; st.info = 'BE actif : SL à l’entrée (50 % du chemin atteint)'; this.log(sym + ' : BE automatique'); this.save(); } } finally { st.busyBe = false; }
    }
  }
  finish(sym) {
    const st = this.ph[sym], net = r2(st.realized || 0), px = st.closePx, tol = 0.15 * (st.slDist || 0);
    let res; if (st.closing) res = 'MANUEL'; else if (px != null && Math.abs(px - st.tp) <= Math.max(tol, 0.1 * st.tpDist)) res = 'TP'; else if (st.beDone && px != null && Math.abs(px - (st.fill || st.entry)) <= tol) res = 'BE'; else if (px != null && Math.abs(px - st.sl) <= tol) res = 'SL'; else res = net > 0 ? 'TP' : st.beDone ? 'BE' : 'SL';
    const S = this.stats, SY = S.bySymbol[sym] || (S.bySymbol[sym] = { trades: 0, tp: 0, be: 0, sl: 0, pnl: 0 });
    [S, SY].forEach(x => { x.trades = (x.trades || 0) + 1; x.pnl = r2((x.pnl || 0) + net); if (res === 'TP') x.tp = (x.tp || 0) + 1; else if (res === 'BE') x.be = (x.be || 0) + 1; else if (res === 'SL') x.sl = (x.sl || 0) + 1; });
    this.day.pnl = r2((this.day.pnl || 0) + net);
    this.history.unshift({ symbol: sym, type: st.type, dir: st.dir, entry: st.entry, sl: st.sl, tp: st.tp, rr: st.rr, lots: st.lots, openedAt: st.openedAt, closedAt: this.now(), res, pnl: net });
    this.log(`${sym} : clôturé → ${res} ${net >= 0 ? '+' : ''}${net} $`);
    this.ph[sym] = { phase: 'SCAN', info: 'en attente du prochain setup', name: st.name, zones: st.zones, bias: st.bias }; this.save();
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
        const name = this.resolve(sym), st = this.ph[sym] || (this.ph[sym] = { phase: 'SCAN', info: 'démarrage' });
        if (!name) { st.phase = 'SCAN'; st.info = 'symbole introuvable chez le broker'; st.name = null; continue; }
        names[sym] = name; st.name = name;
        if (st.phase === 'PENDING' || st.phase === 'OPEN' || st.phase === 'BE') await this.manage(sym);
      }
      if (this.active && this.config.autoBacktest && !this.eff().ready && !this.runningJob() && t - (this.btTry || 0) > 6 * 3600000 && !(this.btAt && !this.chosen && t - this.btAt < 24 * 3600000)) { this.btTry = t; try { this.backtestStart({ months: 12, auto: true }); this.log('backtest automatique lancé (réglage du biais / RR / entrée)'); } catch (e) { this.log('backtest auto : ' + (e && e.message)); } }
      if (this.active && this.config.autoBacktest && this.chosen && t - this.btAt > 14 * 86400000 && !this.runningJob() && t - (this.btTry || 0) > 6 * 3600000) { this.btTry = t; try { this.backtestStart({ months: 12, auto: true }); this.log('backtest automatique (mise à jour toutes les 2 semaines)'); } catch (e) { /* ignore */ } }
      const slot = Math.floor(t / 300000), due = t - slot * 300000 >= 4000;   // 4 s après chaque clôture M5
      for (const sym of Object.keys(names)) {
        const st = this.ph[sym]; if (!due || st.slot === slot) continue;
        if (st.phase === 'OPEN' || st.phase === 'BE') continue;
        st.slot = slot; try { await this.scan(sym, names[sym], t); } catch (e) { st.info = 'analyse : ' + String(e && e.message || e).slice(0, 100); }
      }
    } finally { this.busy = false; }
  }
  async closeAll(reason) {
    await this.refresh().catch(() => {}); const s = this.sess();
    for (const p of this.live.positions) { const k = Object.keys(this.ph).find(x => this.ph[x].id === p.comment); if (k) this.ph[k].closing = 'MANUEL'; await this.closePos(p); }
    for (const o of this.live.orders) { try { await s.cancelOrder(o.id); } catch (e) { /* ignore */ } }
    Object.keys(this.ph).forEach(k => { if (this.ph[k].phase === 'PENDING') { this.ph[k].phase = 'SCAN'; this.ph[k].info = 'annulé : ' + (reason || 'arrêt'); } });
    this.save(); return { ok: true };
  }
  runningJob() { return Object.values(this.jobs).some(j => j.status === 'run'); }
  status() {
    const s = this.sess(), c = this.connected(), SY = this.stats.bySymbol, e = this.eff();
    const pairs = this.config.symbols.map(sym => {
      const st = this.ph[sym] || { phase: 'SCAN', info: '' }, y = SY[sym] || { trades: 0, tp: 0, be: 0, sl: 0, pnl: 0 }, live = st.phase === 'PENDING' || st.phase === 'OPEN' || st.phase === 'BE';
      return { symbol: sym, broker: st.name || null, phase: st.phase, state: STATE_LABEL[st.phase] || st.phase, info: st.info || '', bias: st.bias === 1 ? 'BUY' : st.bias === -1 ? 'SELL' : null, price: st.price || null,
        trade: live ? { type: st.type, dir: st.dir, entry: st.entry, sl: st.sl, tp: st.tp, beAt: st.beAt, rr: st.rr, lots: st.lots, risk$: st.risk$, riskPct: st.riskPct, realRiskPct: st.realRiskPct, minLotForced: !!st.minLotForced, beDone: !!st.beDone, prob: st.prob || null } : null, cancellable: live,
        zones: (st.zones || []).map(z => ({ id: z.id, dir: z.dir === 1 ? 'BUY' : 'SELL', lo: z.lo, hi: z.hi, mid: z.mid, fvg: z.fvg, plan: z.plan, skip: z.skip, prob: z.prob ? { ok: z.prob.ok, key: z.prob.key, pTp: z.prob.pTp, pBe: z.prob.pBe, pReturn: z.prob.pReturn, meanR: z.prob.meanR, n: z.prob.nFill } : null })),
        stats: { trades: y.trades, tp: y.tp, be: y.be, sl: y.sl, winTp: y.trades ? Math.round(y.tp / y.trades * 1000) / 10 : 0, winBe: y.trades ? Math.round((y.tp + y.be) / y.trades * 1000) / 10 : 0, pnl: y.pnl } };
    });
    const S = this.stats, tot = { trades: S.trades || 0, tp: S.tp || 0, be: S.be || 0, sl: S.sl || 0, pnl: S.pnl || 0 }; tot.winTp = tot.trades ? Math.round(tot.tp / tot.trades * 1000) / 10 : 0; tot.winBe = tot.trades ? Math.round((tot.tp + tot.be) / tot.trades * 1000) / 10 : 0;
    const job = Object.values(this.jobs).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null;
    return { ok: true, active: this.active, connected: c, state: !c ? 'CTRADER NON CONNECTÉ' : !e.ready ? 'ATTENTE BACKTEST' : this.active ? 'ROBOT ACTIF' : 'ARRÊTÉ', balance: c ? num(s.balance, null) : null, config: this.config, effective: e, chosen: this.chosen ? { biasTf: this.chosen.biasTf, rr: this.chosen.rr, mode: this.chosen.mode, minOk: this.chosen.minOk, at: this.btAt } : null,
      backtestAt: this.btAt, dayPnl: this.day.pnl || 0, pairs, total: tot, history: this.history.slice(0, 50), logs: this.logs.slice(0, 40), job: job ? { id: job.id, status: job.status, progress: job.progress, msg: job.msg, auto: !!job.auto } : null, rows: this.btRows };
  }

  /* ---------- backtest (données réelles du broker) : sélection sur la 1re moitié, vérification sur la 2e */
  backtestStart(P) {
    if (!this.connected()) throw new Error('cTrader non connecté');
    if (this.runningJob()) throw new Error('un backtest est déjà en cours');
    const s = this.sess(), id = 'bt' + this.now().toString(36), months = clamp(Math.round(num(P && P.months, 12)), 1, 12);
    const job = this.jobs[id] = { id, status: 'run', progress: 0, msg: 'démarrage', months, auto: !!(P && P.auto), startedAt: this.now(), result: null, error: null };
    Object.keys(this.jobs).slice(0, -3).forEach(k => delete this.jobs[k]);
    (async () => {
      try {
        const syms = this.config.symbols, to = this.now(), from = to - months * 30 * 86400000, mid = from + (to - from) / 2, weeks = (mid - from) / (7 * 86400000), data = {};
        for (let i = 0; i < syms.length; i++) {
          const sym = syms[i], name = this.resolve(sym); if (!name) throw new Error('symbole introuvable chez le broker : ' + sym);
          const m5 = (await s.fetchHistory(name, 5, from - 4 * 86400000, to, f => { job.progress = 0.8 * (i + f) / syms.length; job.msg = sym + ' : historique M5'; })).filter(b => b.t + 300000 <= to);
          if (m5.length < 5000) throw new Error('historique M5 trop court pour ' + sym + ' (' + m5.length + ' bougies)');
          data[sym] = { m5, m15: E.agg(m5, E.M15, to) };
        }
        const rows = [], tables = {}, trades = {};
        let k = 0; const total = syms.length * 2 * 2;
        for (const sym of syms) for (const biasTf of ['H1', 'H4']) {
          job.msg = sym + ' : analyse ' + biasTf; await sleep(5);
          const Pr = E.prep(sym, data[sym].m5, data[sym].m15, biasTf, to); tables[sym] = tables[sym] || {};
          for (const rr of [2, 3]) {
            const tabTrain = E.buildProb(Pr, { from, to: mid, rr }); tables[sym][biasTf + '|' + rr] = E.buildProb(Pr, { from, to, rr });
            for (const mode of ['LIMIT', 'DIRECT', 'BOTH']) {
              const key = biasTf + '|' + rr + '|' + mode; trades[key] = trades[key] || { train: [], test: [], per: {} };
              const a = E.backtest(Pr, { mode, rr, prob: tabTrain, from, to: mid }), b = E.backtest(Pr, { mode, rr, prob: tabTrain, from: mid, to });
              trades[key].train = trades[key].train.concat(a); trades[key].test = trades[key].test.concat(b); trades[key].per[sym] = { train: E.statsOf(a, weeks), test: E.statsOf(b, weeks) };
            }
            k++; job.progress = 0.8 + 0.2 * k / total; await sleep(5);
          }
        }
        Object.keys(trades).forEach(key => { const [biasTf, rr, mode] = key.split('|'); const tr = trades[key]; rows.push({ biasTf, rr: Number(rr), mode, train: E.statsOf(tr.train, weeks), test: E.statsOf(tr.test, weeks), per: tr.per }); });
        rows.forEach(r => { r.weeklyR = Math.round(r.train.rPerTrade * r.train.perWeek * 100) / 100; });
        rows.sort((a, b) => b.weeklyR - a.weeklyR);
        const min = this.config.minPerWeek, pos = rows.filter(r => r.train.rPerTrade > 0 && r.train.trades >= 20), okMin = pos.filter(r => r.train.perWeek >= min);
        const pick = okMin[0] || pos[0] || null;
        this.chosen = pick ? { biasTf: pick.biasTf, rr: pick.rr, mode: pick.mode, minOk: !!okMin[0], tables } : null;
        if (!pick) this.chosen = null;
        this.btRows = rows.slice(0, 12).map(r => ({ biasTf: r.biasTf, rr: r.rr, mode: r.mode, train: r.train, test: r.test, weeklyR: r.weeklyR }));
        this.btAt = this.now();
        job.result = { months, rows: this.btRows, chosen: pick ? { biasTf: pick.biasTf, rr: pick.rr, mode: pick.mode, minOk: !!okMin[0] } : null, perPair: pick ? pick.per : null, tables: pick ? Object.fromEntries(syms.map(sy => [sy, tables[sy][pick.biasTf + '|' + pick.rr]])) : null,
          note: 'Choix fait sur la 1re moitié de la période (TRAIN) et vérifié sur la 2e moitié (TEST, hors échantillon). Spread inclus, commission non incluse. 1 trade/jour/paire. SL prioritaire dans une même bougie. Win % (TP) = TP seulement ; Win + BE % compte aussi les trades protégés (BE = 0 R).' };
        job.status = 'done'; job.progress = 1; job.msg = pick ? ('réglage automatique : ' + pick.biasTf + ' · RR 1:' + pick.rr + ' · ' + pick.mode) : 'aucun réglage rentable : robot en pause';
        this.log('backtest terminé : ' + job.msg); this.save();
      } catch (e) { job.status = 'error'; job.error = String(e && e.message || e).slice(0, 200); this.log('backtest : ' + job.error); }
    })();
    return { ok: true, id };
  }
  backtestGet(id) { const j = this.jobs[id]; return j ? Object.assign({ ok: true }, j) : { ok: false, error: 'backtest introuvable' }; }
}

module.exports = function createSmc({ manager, dataRoot }) {
  const users = new Map();
  const get = uid => { if (!users.has(uid)) users.set(uid, new UserSmc({ userId: uid, dataRoot, manager })); return users.get(uid); };
  const emergencyStop = async uid => { const u = get(uid); u.active = false; u.save(); try { await u.closeAll('ARRÊT D\'URGENCE'); } catch (e) { /* ignore */ } return { ok: true }; };
  return {
    get, emergencyStop,
    tickAll: async () => { for (const u of users.values()) await u.tick(); },
    start: ids => {
      const all = new Set(ids || []);
      try { fs.readdirSync(dataRoot).forEach(f => { const m = /^smc-([A-Za-z0-9_-]+)\.json$/.exec(f); if (m) all.add(m[1]); }); } catch (e) { /* premier démarrage */ }
      all.forEach(id => get(id));
    },
    emergencyStopAll: async () => { for (const id of Array.from(users.keys())) await emergencyStop(id); return { ok: true }; }
  };
};
module.exports.DEFAULTS = DEFAULTS;
