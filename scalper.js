'use strict';
/**
 * ARES ROBOT SCALPING
 * Style des vidéos : BUY STOP + SELL STOP posés ensemble près du prix (M1), lot minimal arakaraka ny solde,
 * sortie rapide dès qu'un petit gain est pris. Forex + Gold. Aucun objectif / cible : le robot trade tant qu'il
 * est ACTIVÉ et s'arrête (plus aucune nouvelle entrée) dès qu'il est DÉSACTIVÉ.
 *
 * Les « stop orders » sont surveillés côté serveur (prix réel cTrader) puis envoyés au marché,
 * par le même circuit que les autres ordres (engine.execNext -> ctrader/execution.js -> panel Trade live / P/L).
 */

const DEFAULT_SCALPER = {
  symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY'],
  lotPer1000: 0.01,        // lot de base pour 1 000 de solde (0.01 lot / 1 000 $)
  stopSpreadMult: 3,       // distance des stops = max(3 × spread, moitié du range des 60 dernières secondes)
  tpMult: 1.0,             // gain visé par trade = 1 × distance
  slMult: 1.5,             // protection broker = 1.5 × distance
  straddleTTLSec: 45,      // si aucun stop n'est touché : les stops sont reposés au nouveau prix
  maxHoldSec: 90,          // un scalp ne reste jamais ouvert plus longtemps
  cooldownSec: 3,
  maxSpreadMult: 0.6       // pas d'entrée si le spread dépasse 60 % de la distance des stops
};

module.exports = function createScalper(ctx) {
  const { S, cfg, clock, freshPrice, specOf, vppOf, balanceInfo, log, save, symOf, rollDay } = ctx;
  const hist = {};    // sym -> [{ t, mid }]
  const arm = {};     // sym -> { buyStop, sellStop, setAt, dist }
  const lastExit = {};
  const r2 = x => Math.round(x * 100) / 100;

  const sc = () => Object.assign({}, DEFAULT_SCALPER, cfg().scalper || {});
  const mine = (sym) => S.trades.filter(t => t.strategy === 'ARES ROBOT SCALPING' && (!sym || t.symbol === sym));
  const live = (sym) => mine(sym).filter(t => ['PENDING', 'SENT', 'UNCONFIRMED', 'OPEN'].includes(t.status));

  function record(sym, mid) {
    const h = (hist[sym] = hist[sym] || []), now = clock();
    h.push({ t: now, mid });
    while (h.length && now - h[0].t > 60000) h.shift();
  }

  function lotsFor(sym) {
    const c = cfg(), b = balanceInfo();
    if (!b || b.balance === null) return null;
    const step = c.lotStep || 0.01, min = c.minLot || 0.01, max = c.maxLot || 5;
    let lots = b.balance / 1000 * sc().lotPer1000;
    lots = Math.floor(lots / step + 1e-9) * step;
    return r2(Math.min(max, Math.max(min, lots)));
  }

  function distanceFor(sym, p) {
    const h = hist[sym] || [], spread = p.ask && p.bid ? p.ask - p.bid : 0;
    let lo = Infinity, hi = -Infinity;
    for (const x of h) { lo = Math.min(lo, x.mid); hi = Math.max(hi, x.mid); }
    const range = h.length > 5 ? hi - lo : 0, sp = specOf(sym);
    return Math.max(spread * sc().stopSpreadMult, range * 0.5, sp ? sp.pointSize * 2 : 0);
  }

  function openTrade(sym, action, p, dist) {
    const c = cfg(), sp = specOf(sym), lots = lotsFor(sym), k = sc();
    if (!sp || !lots) return null;
    const buy = action === 'BUY', entry = buy ? p.ask : p.bid, pts = sp.pointSize;
    const sl = entry + (buy ? -1 : 1) * dist * k.slMult, tp = entry + (buy ? 1 : -1) * dist * k.tpMult;
    const slPts = r2(Math.abs(entry - sl) / pts), tpPts = r2(Math.abs(tp - entry) / pts);
    const ts = clock(), id = `S${ts}-${++S.seq}`;
    const t = {
      id, setupId: id, leg: null, weight: 1, mult: 1, ts: new Date(ts).toISOString(), user: ctx.userId, ctraderAccountId: S.exec.accountId || null,
      mode: c.mode, tradingMode: c.tradingMode, timeframe: 'M1', symbol: sym, action, entry, sl, tp, slPts, tpPts, lots,
      riskMoney: r2(slPts * vppOf(sym) * lots), confidence: null, reason: 'Stop ' + (buy ? 'BUY' : 'SELL') + ' touché',
      keyZone: null, smcConditions: [], orderFlowConditions: [], newsCondition: null,
      strategy: 'ARES ROBOT SCALPING', setupName: 'BUY STOP + SELL STOP',
      status: 'PENDING', execNote: 'en attente d\'envoi à cTrader', result: null
    };
    rollDay(ts);
    S.trades.push(t);
    while (S.trades.length > 500) S.trades.shift();
    S.day.trades++;
    log('TRADE', `SCALP ${sym} ${action} ${lots} lot`, { kind: 'trade', tradeId: id, entry, sl, tp, lots }, true);
    save();
    return t;
  }

  function floating(t, p) {   // gain flottant en prix
    return t.action === 'BUY' ? p.bid - (t.openPrice || t.entry) : (t.openPrice || t.entry) - p.ask;
  }

  async function manageExits(session, sym, p) {
    const k = sc(), now = clock();
    for (const t of live(sym).filter(x => x.status === 'OPEN' && x.ticket)) {
      if (t.closeReqTs && now - t.closeReqTs < 5000) continue;
      const fl = floating(t, p), tpPx = Math.abs(t.tp - t.entry), held = (now - Date.parse(t.ts)) / 1000;
      if (fl >= tpPx || held >= k.maxHoldSec) {
        t.closeReqTs = now;
        try { await session.closePosition(t.ticket); lastExit[sym] = now; } catch (e) { log('SCALP', 'fermeture ' + t.id + ' : ' + (e && e.message), { kind: 'scalp' }, true); }
      }
    }
  }

  /** Appelé chaque seconde par ctrader/execution.js (boucle d'ordres). */
  async function tick(session) {
    const c = cfg(), k = sc(), now = clock();
    const on = !!c.autoTrade && !S.manualBlock && c.liveExecution && S.exec.status === 'CONNECTED';
    for (const raw of k.symbols) {
      const sym = symOf(raw), sp = specOf(sym), p = freshPrice(sym);
      if (!sp || !p || !p.bid || !p.ask) continue;
      record(sym, p.mid);
      await manageExits(session, sym, p);          // les sorties continuent même si le robot est désactivé
      if (!on) { delete arm[sym]; continue; }      // désactivé : plus aucune nouvelle entrée
      if (now - (lastExit[sym] || 0) < k.cooldownSec * 1000) continue;
      const active = live(sym), hasBuy = active.some(t => t.action === 'BUY'), hasSell = active.some(t => t.action === 'SELL');
      let a = arm[sym];
      if (a && !active.length && now - a.setAt > k.straddleTTLSec * 1000) a = null;
      if (!a) {
        const dist = distanceFor(sym, p);
        if (p.ask - p.bid > dist * k.maxSpreadMult) continue;   // spread trop large
        a = arm[sym] = { buyStop: p.ask + dist, sellStop: p.bid - dist, setAt: now, dist };
      }
      if (!hasBuy && p.ask >= a.buyStop) { openTrade(sym, 'BUY', p, a.dist); a.setAt = now; }
      if (!hasSell && p.bid <= a.sellStop) { openTrade(sym, 'SELL', p, a.dist); a.setAt = now; }
      if (!live(sym).length && now - a.setAt > k.straddleTTLSec * 1000) delete arm[sym];
    }
  }

  function view() {
    const k = sc();
    return { name: 'ARES ROBOT SCALPING', active: !!cfg().autoTrade, symbols: k.symbols, stops: Object.fromEntries(Object.entries(arm).map(([s, a]) => [s, { buyStop: a.buyStop, sellStop: a.sellStop }])) };
  }

  return { tick, view, DEFAULT_SCALPER };
};
