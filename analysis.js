'use strict';
/**
 * ARES — ANALYSE DE MARCHÉ (SMC + structure + Order Flow optionnel), mode-driven.
 * Fonctions pures. Entrée : bougies fermées par timeframe. Aucune donnée n'est inventée :
 * si une donnée manque (bougies, order flow, news) -> composant UNAVAILABLE ou WAIT.
 *
 * SCALPING : trigger M1, structure M5, biais M15
 * SWING    : trigger M15 (= structure), biais M30
 */
const r2 = x => Math.round(x * 100) / 100;

const DEFAULT_ANALYSIS = {
  swingK: 2,              // fractale : un sommet/creux est confirmé par K bougies de chaque côté
  breakLookback: 12,      // une cassure (BOS/CHoCH) reste valable N bougies
  sweepLookback: 8,
  fvgLookback: 40,
  obLookback: 30,
  zoneToleranceAtr: 0.25, // le prix « touche » une zone à ±0.25 ATR
  atrPeriod: 14,
  htfVeto: true,          // biais HTF opposé = WAIT
  minScore: 6,            // score de confluence minimal
  minComponents: 3,       // nb minimal de composants validés
  weights: { structure: 3, mtf: 2, trigger: 2, sweep: 2, zone: 2, premiumDiscount: 1, orderFlow: 2 },
  orderFlow: { enabled: false, requireWhenEnabled: true }   // true : filtre ON + donnée indisponible -> WAIT
};

function atr(cs, n) {
  if (!cs || cs.length < n + 1) return null;
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) s += Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
  return s / n;
}

/** sommets / creux confirmés (fractales). */
function swings(cs, k) {
  const H = [], L = [];
  for (let i = k; i < cs.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(cs[i].h > cs[i - j].h && cs[i].h >= cs[i + j].h)) hi = false;
      if (!(cs[i].l < cs[i - j].l && cs[i].l <= cs[i + j].l)) lo = false;
    }
    if (hi) H.push({ i, price: cs[i].h });
    if (lo) L.push({ i, price: cs[i].l });
  }
  return { H, L };
}

function biasOf(sw) {
  const h = sw.H.slice(-2), l = sw.L.slice(-2);
  if (h.length < 2 || l.length < 2) return 'RANGE';
  if (h[1].price > h[0].price && l[1].price > l[0].price) return 'BULL';
  if (h[1].price < h[0].price && l[1].price < l[0].price) return 'BEAR';
  return 'RANGE';
}

/** cassure récente : close au-delà du dernier sommet/creux confirmé. CHoCH = cassure contre le biais précédent. */
function lastBreak(cs, sw, bias, lookback) {
  const n = cs.length;
  let found = null;
  for (let b = n - 1; b >= Math.max(1, n - lookback) && !found; b--) {
    const sh = sw.H.filter(x => x.i < b - 0).slice(-1)[0], sl = sw.L.filter(x => x.i < b).slice(-1)[0];
    if (sh && cs[b].c > sh.price && cs[b - 1].c <= sh.price) found = { type: bias === 'BEAR' ? 'CHOCH_UP' : 'BOS_UP', level: sh.price, bar: b, barsAgo: n - 1 - b, from: sl };
    else if (sl && cs[b].c < sl.price && cs[b - 1].c >= sl.price) found = { type: bias === 'BULL' ? 'CHOCH_DOWN' : 'BOS_DOWN', level: sl.price, bar: b, barsAgo: n - 1 - b, from: sh };
  }
  return found;
}

/** Liquidity sweep : mèche au-delà d'un creux/sommet antérieur puis clôture de retour. */
function sweep(cs, sw, dir, lookback) {
  const n = cs.length;
  for (let b = n - 1; b >= Math.max(1, n - lookback); b--) {
    if (dir === 'BUY') {
      const ref = sw.L.filter(x => x.i < b - 1).slice(-3);
      for (const r of ref) if (cs[b].l < r.price && cs[b].c > r.price) return { bar: b, level: r.price, extreme: cs[b].l };
    } else {
      const ref = sw.H.filter(x => x.i < b - 1).slice(-3);
      for (const r of ref) if (cs[b].h > r.price && cs[b].c < r.price) return { bar: b, level: r.price, extreme: cs[b].h };
    }
  }
  return null;
}

/** Fair Value Gaps non comblés. */
function fvgs(cs, dir, lookback) {
  const out = [], n = cs.length;
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    const a = cs[i - 2], c = cs[i];
    if (dir === 'BUY' && a.h < c.l) {
      const z = { lo: a.h, hi: c.l, bar: i };
      if (!cs.slice(i + 1).some(x => x.l <= z.lo)) out.push(z);      // non comblé
    } else if (dir === 'SELL' && a.l > c.h) {
      const z = { lo: c.h, hi: a.l, bar: i };
      if (!cs.slice(i + 1).some(x => x.h >= z.hi)) out.push(z);
    }
  }
  return out;
}

/** Order Block : dernière bougie opposée avant l'impulsion qui a cassé la structure (non mitigé). */
function orderBlock(cs, brk, dir) {
  if (!brk) return null;
  const start = brk.from ? brk.from.i : Math.max(0, brk.bar - 10);
  for (let i = brk.bar - 1; i >= Math.max(0, start); i--) {
    const c = cs[i];
    if (dir === 'BUY' && c.c < c.o) { const z = { lo: c.l, hi: c.h, bar: i }; return cs.slice(i + 1).some(x => x.c < z.lo) ? null : z; }
    if (dir === 'SELL' && c.c > c.o) { const z = { lo: c.l, hi: c.h, bar: i }; return cs.slice(i + 1).some(x => x.c > z.hi) ? null : z; }
  }
  return null;
}

function premiumDiscount(sw, price) {
  const h = sw.H.slice(-1)[0], l = sw.L.slice(-1)[0];
  if (!h || !l || h.price <= l.price) return null;
  const eq = (h.price + l.price) / 2;
  return { eq, zone: price < eq ? 'DISCOUNT' : 'PREMIUM', hi: h.price, lo: l.price };
}

const inZone = (z, p, tol) => z && p >= z.lo - tol && p <= z.hi + tol;

/**
 * @param ctx { mode, tf:{entry,structure,htf}, candles:{[min]:[bars fermées]}, price:{bid,ask,mid}, spreadEq, atrEq,
 *              dist:(goldEqPts)=>prixUnits, toEq:(prixUnits)=>goldEqPts, limits:{slMax,minAtrEq,maxAtrEq,maxSpreadEq},
 *              targets:{tp1,tp2,tp3}, orderFlow:{status,delta,cvd,...}, cfg }
 * @returns { action:'BUY'|'SELL'|'WAIT', wait?, confidence, score, maxScore, components[], entry, sl, tp1, tp2, tp3, reason }
 */
function evaluate(ctx) {
  const cfg = Object.assign({}, DEFAULT_ANALYSIS, ctx.cfg || {});
  cfg.weights = Object.assign({}, DEFAULT_ANALYSIS.weights, (ctx.cfg || {}).weights || {});
  cfg.orderFlow = Object.assign({}, DEFAULT_ANALYSIS.orderFlow, (ctx.cfg || {}).orderFlow || {});
  const W = cfg.weights, out = comps => ({ action: 'WAIT', confidence: 0, score: 0, maxScore: 0, components: comps || [] });
  const wait = (why, comps) => Object.assign(out(comps), { wait: why });
  const tf = ctx.tf, cs = (ctx.candles[tf.structure] || []), ce = (ctx.candles[tf.entry] || []), ch = (ctx.candles[tf.htf] || []);
  const need = cfg.swingK * 2 + 12;
  if (cs.length < need + cfg.atrPeriod) return wait(`DATA_UNAVAILABLE: bougies M${tf.structure} insuffisantes (${cs.length}/${need + cfg.atrPeriod})`);
  if (ce.length < cfg.atrPeriod + 3) return wait(`DATA_UNAVAILABLE: bougies M${tf.entry} insuffisantes`);
  if (ch.length < need) return wait(`DATA_UNAVAILABLE: bougies M${tf.htf} insuffisantes (${ch.length}/${need})`);
  const price = ctx.price && ctx.price.mid; if (!price) return wait('DATA_UNAVAILABLE: prix indisponible');

  // filtres de marché
  const A = ctx.limits || {};
  if (A.maxSpreadEq != null && ctx.spreadEq > A.maxSpreadEq) return wait(`spread ${r2(ctx.spreadEq)} > ${A.maxSpreadEq} (pts-or)`);
  const atrS = atr(cs, cfg.atrPeriod), atrEq = ctx.toEq(atrS);
  if (A.minAtrEq != null && atrEq < A.minAtrEq) return wait(`marché trop calme (ATR M${tf.structure} ${r2(atrEq)} pts-or)`);
  if (A.maxAtrEq != null && atrEq > A.maxAtrEq) return wait(`marché trop violent (ATR M${tf.structure} ${r2(atrEq)} pts-or)`);

  const swS = swings(cs, cfg.swingK), swH = swings(ch, cfg.swingK);
  const biasS = biasOf(swS), biasH = biasOf(swH);
  const brk = lastBreak(cs, swS, biasS, cfg.breakLookback);
  let dir = null;
  if (brk) dir = brk.type.endsWith('UP') ? 'BUY' : 'SELL';
  else if (biasS === 'BULL') dir = 'BUY'; else if (biasS === 'BEAR') dir = 'SELL';
  if (!dir) return wait(`aucune direction : structure M${tf.structure} en range, pas de cassure`);

  const comps = [], add = (name, pass, detail, weight, state) => comps.push({ name, pass, detail, weight, state: state || (pass ? 'OK' : 'NO') });
  const aligned = (b) => (dir === 'BUY' ? b === 'BULL' : b === 'BEAR');

  // 1) structure
  const sOk = !!(brk && ((dir === 'BUY' && brk.type.endsWith('UP')) || (dir === 'SELL' && brk.type.endsWith('DOWN')))) || aligned(biasS);
  add('structure', sOk, brk ? `${brk.type} (il y a ${brk.barsAgo} bougies) · biais M${tf.structure} ${biasS}` : `biais M${tf.structure} ${biasS}`, W.structure);
  // 2) MTF
  if (cfg.htfVeto && biasH !== 'RANGE' && !aligned(biasH)) return wait(`biais M${tf.htf} ${biasH} opposé à ${dir} (veto HTF)`, comps);
  add('mtf', aligned(biasH), `biais M${tf.htf} ${biasH}`, W.mtf);
  // 3) trigger (bougie de confirmation sur le timeframe d'entrée)
  const e1 = ce[ce.length - 1], e0 = ce[ce.length - 2];
  const trig = dir === 'BUY' ? (e1.c > e1.o && e1.c > e0.h) : (e1.c < e1.o && e1.c < e0.l);
  add('trigger', trig, `bougie M${tf.entry} ${trig ? 'de confirmation' : 'sans confirmation'}`, W.trigger);
  // 4) liquidity sweep
  const sw = sweep(cs, swS, dir, cfg.sweepLookback);
  add('sweep', !!sw, sw ? `sweep ${r2(sw.level)} (mèche ${r2(sw.extreme)})` : 'aucun sweep récent', W.sweep);
  // 5) zone FVG / OB
  const tol = cfg.zoneToleranceAtr * atrS;
  const fv = fvgs(cs, dir, cfg.fvgLookback).filter(z => inZone(z, price, tol)).slice(-1)[0] || null;
  const ob = orderBlock(cs.slice(-cfg.obLookback - cfg.breakLookback), brk && { ...brk, bar: brk.bar - Math.max(0, cs.length - (cfg.obLookback + cfg.breakLookback)), from: brk.from && { i: Math.max(0, brk.from.i - Math.max(0, cs.length - (cfg.obLookback + cfg.breakLookback))) } }, dir);
  const obHit = ob && inZone(ob, price, tol) ? ob : null;
  add('zone', !!(fv || obHit), fv ? `FVG ${r2(fv.lo)}-${r2(fv.hi)}` : obHit ? `Order Block ${r2(obHit.lo)}-${r2(obHit.hi)}` : 'prix hors FVG/OB', W.zone);
  // 6) premium / discount
  const pd = premiumDiscount(swS, price);
  const pdOk = !!pd && ((dir === 'BUY' && pd.zone === 'DISCOUNT') || (dir === 'SELL' && pd.zone === 'PREMIUM'));
  add('premiumDiscount', pdOk, pd ? `${pd.zone} (équilibre ${r2(pd.eq)})` : 'range indéfini', W.premiumDiscount);
  // 7) order flow (jamais inventé)
  const of = ctx.orderFlow || { status: 'UNAVAILABLE' };
  if (cfg.orderFlow.enabled) {
    if (of.status !== 'AVAILABLE') {
      add('orderFlow', false, `ORDER FLOW ${of.status || 'UNAVAILABLE'} : donnée non exploitable`, W.orderFlow, of.status || 'UNAVAILABLE');
      if (cfg.orderFlow.requireWhenEnabled) return wait(`Order Flow ${of.status || 'UNAVAILABLE'} alors que le filtre est ON`, comps);
    } else {
      const d = Number(of.delta), cv = Number(of.cvd);
      const ofOk = Number.isFinite(d) && (dir === 'BUY' ? d > 0 : d < 0) && (!Number.isFinite(cv) || (dir === 'BUY' ? cv >= 0 : cv <= 0));
      add('orderFlow', ofOk, `delta ${Number.isFinite(d) ? d : '?'} · CVD ${Number.isFinite(cv) ? cv : '?'}`, W.orderFlow, 'AVAILABLE');
    }
  }

  const evaluable = comps.filter(c => c.state === 'OK' || c.state === 'NO' || c.state === 'AVAILABLE');
  const maxScore = evaluable.reduce((a, c) => a + c.weight, 0), score = comps.filter(c => c.pass).reduce((a, c) => a + c.weight, 0);
  const passed = comps.filter(c => c.pass).length, confidence = maxScore ? Math.round(score / maxScore * 100) : 0;
  const base = { components: comps, score, maxScore, confidence };
  if (!sOk) return Object.assign(wait('structure non alignée', comps), base);
  if (!trig) return Object.assign(wait('pas de bougie de confirmation sur le timeframe d\'entrée', comps), base);
  if (score < cfg.minScore || passed < cfg.minComponents) return Object.assign(wait(`confluence insuffisante : score ${score}/${maxScore} (min ${cfg.minScore}), ${passed} composants (min ${cfg.minComponents})`, comps), base);

  // SL structurel : sous/sur le dernier creux/sommet récent, le sweep ou l'OB, + marge
  const rec = ce.slice(-5), buf = Math.max(ctx.dist(1), 0.15 * atrS);
  let sl;
  if (dir === 'BUY') { let lo = Math.min(...rec.map(x => x.l)); if (sw) lo = Math.min(lo, sw.extreme); if (obHit) lo = Math.min(lo, obHit.lo); sl = lo - buf; }
  else { let hi = Math.max(...rec.map(x => x.h)); if (sw) hi = Math.max(hi, sw.extreme); if (obHit) hi = Math.max(hi, obHit.hi); sl = hi + buf; }
  const entry = dir === 'BUY' ? (ctx.price.ask || price) : (ctx.price.bid || price);
  const slEq = ctx.toEq(Math.abs(entry - sl));
  if (A.minSlEq != null && slEq < A.minSlEq) return Object.assign(wait(`SL ${r2(slEq)} pts-or < ${A.minSlEq} : trop serré (bruit/spread)`, comps), base);
  if (A.slMax != null && slEq > A.slMax) return Object.assign(wait(`SL structurel ${r2(slEq)} pts-or > maximum ${A.slMax} : setup ignoré`, comps), base);
  const d = dir === 'BUY' ? 1 : -1, T = ctx.targets || {};
  const tp = g => (g ? entry + d * ctx.dist(g) : null);
  const names = comps.filter(c => c.pass).map(c => c.name).join(' + ');
  return Object.assign({ action: dir, entry, sl, tp1: tp(T.tp1), tp2: tp(T.tp2), tp3: tp(T.tp3), slEq: r2(slEq),
    reason: `${ctx.mode} ${dir} · confluence ${names} · score ${score}/${maxScore} (${confidence}%) · SL ${r2(slEq)} pts-or · ATR ${r2(atrEq)}` }, base);
}

module.exports = { evaluate, DEFAULT_ANALYSIS, _t: { swings, biasOf, lastBreak, sweep, fvgs, orderBlock, premiumDiscount, atr } };
