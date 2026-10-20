'use strict';
/**
 * ARES — NOUVELLE STRATÉGIE SMC (remplace TOUTES les anciennes stratégies ; aucun ATR, aucun ancien signal).
 *
 *  H1        : contexte / structure / biais (informatif, ne bloque JAMAIS un trade contre-tendance) + liquidités.
 *  M30 / M15 : OB valides (zones d'entrée), anciennes zones encore valides conservées.
 *  M15       : CHOCH / BOS ; on attend le DERNIER BOS confirmé (un CHOCH seul ne déclenche rien).
 *  Liquidité : EQH / EQL / Previous High-Low / PDH-PDL / Swing / Double Top-Bottom = élément central (cohérence de la zone + cibles).
 *  Fibonacci : confluence supplémentaire seulement (jamais seul).
 *  M5        : prix dans la zone -> confirmation M5 (cassure du dernier high / low M5) -> ENTRY.
 *  SL fixe 50–100 pips (5–10 $), TP1 50–100 pips, TP2 200–250 pips, BE sur le reste après TP1.
 *
 * Fonctions PURES (mêmes règles en live et en backtest). Prix en $ (XAUUSD : 1 pip = 0.10 $).
 * La vente = même logique appliquée à des bougies inversées (mirrorC), puis remise dans le bon sens.
 */
const r2 = x => Math.round(x * 100) / 100;
const MIN = 60000;

const SMC = {
  k: 2,                  // fractale : sommet / creux confirmé par k bougies de chaque côté
  slMinUsd: 5, slMaxUsd: 10,           // SL : 50 – 100 pips
  tp1MinUsd: 5, tp1MaxUsd: 10,         // TP1 : 50 – 100 pips
  tp2MinUsd: 20, tp2MaxUsd: 25,        // TP2 : 200 – 250 pips
  slBufUsd: 0.3,         // marge fixe derrière la structure (pas d'ATR)
  eqTolUsd: 0.8,         // tolérance EQH / EQL (fixe)
  zoneMinUsd: 1, zoneMaxUsd: 12,       // taille d'une zone exploitable
  zoneMaxAgeBars: 700,   // âge max d'une zone (bougies M15 ≈ 7 jours) : une ancienne zone valide reste utilisable
  liqNearUsd: 4,         // une liquidité (côté stop) doit se trouver dans / juste sous la zone
  sweepBars: 48,         // sweep récent (bougies M15)
  structMaxBars: 192,    // le dernier BOS M15 doit dater de moins de 2 jours
  confirmMaxBars: 36,    // confirmation M5 : au plus 36 bougies après le creux dans la zone
  entryMaxMin: 10,       // entrée seulement dans les 10 min suivant la confirmation M5
  entryDevUsd: 2,        // écart max prix / confirmation
  targetMaxUsd: 80,      // une liquidité cible doit exister au-dessus de l'entrée
  requireFib: false,     // Fibonacci = confirmation supplémentaire (true : exigée)
  fibLo: 0.5, fibHi: 0.786
};
// compat : anciennes clés de config (plus utilisées)
const ZONES = {}, WADE = { ignoreFactors: [] }, DEFAULT_ANALYSIS = {}, ZONE_PROFILES = {};

/** Sommets / creux confirmés par k bougies de chaque côté : { H:[{i,p,t}], L:[…] }. */
function swK(c, k) {
  const H = [], L = [];
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true;
    for (let j = 1; j <= k; j++) {
      if (!(c[i].h > c[i - j].h && c[i].h >= c[i + j].h)) hi = false;
      if (!(c[i].l < c[i - j].l && c[i].l <= c[i + j].l)) lo = false;
      if (!hi && !lo) break;
    }
    if (hi) H.push({ i, p: c[i].h, t: c[i].t });
    if (lo) L.push({ i, p: c[i].l, t: c[i].t });
  }
  return { H, L };
}
/** Regroupe des bougies fermées (durée inMs) en bougies de durée outMs alignées sur l'horloge ; la dernière bougie incomplète est retirée. */
function aggTF(c, inMs, outMs) {
  const out = []; let cur = null;
  for (const b of c) {
    const t0 = Math.floor(b.t / outMs) * outMs;
    if (!cur || cur.t !== t0) { if (cur) out.push(cur); cur = { t: t0, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  if (cur) out.push(cur);
  const last = c[c.length - 1];
  if (out.length && last && out[out.length - 1].t + outMs > last.t + inMs) out.pop();
  return out;
}
const aggN = (c1, n) => (n <= 1 ? c1 || [] : aggTF(c1 || [], MIN, n * MIN));
const mirrorC = c => c.map(b => ({ t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c }));

/** Structure : CHOCH / BOS par clôture au-delà du dernier swing confirmé. BOS = dans le sens de la tendance, CHOCH = contre. */
function structure(c, k) {
  const sw = swK(c, k), n = c.length, events = [];
  let trend = null, ph = 0, pl = 0, curH = null, curL = null, brH = false, brL = false;
  for (let b = k + 1; b < n; b++) {
    while (ph < sw.H.length && sw.H[ph].i + k < b) { curH = sw.H[ph]; brH = false; ph++; }
    while (pl < sw.L.length && sw.L[pl].i + k < b) { curL = sw.L[pl]; brL = false; pl++; }
    if (curH && !brH && c[b].c > curH.p) { brH = true; events.push({ b, t: c[b].t, dir: 'UP', type: trend === 'DOWN' ? 'CHOCH' : 'BOS', level: curH.p, swing: curH }); trend = 'UP'; }
    if (curL && !brL && c[b].c < curL.p) { brL = true; events.push({ b, t: c[b].t, dir: 'DOWN', type: trend === 'UP' ? 'CHOCH' : 'BOS', level: curL.p, swing: curL }); trend = 'DOWN'; }
  }
  return { sw, events, trend };
}

/** Pools de liquidité (côté H = au-dessus des sommets, côté L = sous les creux), avec drapeau « déjà prise ». */
function pools(h1, c15, o) {
  const k = o.k, out = [], n15 = c15.length;
  const add = (side, p, type, t, from) => out.push({ side, p, type, t, from: from == null ? t : from, swept: false });
  const s1 = swK(h1, k), s15 = swK(c15, k);
  s1.H.slice(-40).forEach(s => add('H', s.p, 'Swing H1', s.t));
  s1.L.slice(-40).forEach(s => add('L', s.p, 'Swing H1', s.t));
  s15.H.slice(-30).forEach(s => add('H', s.p, 'Swing M15', s.t));
  s15.L.slice(-30).forEach(s => add('L', s.p, 'Swing M15', s.t));
  if (h1.length) { const b = h1[h1.length - 1]; add('H', b.h, 'Previous High', b.t); add('L', b.l, 'Previous Low', b.t); }
  const last = c15[n15 - 1];
  if (last) {
    const d0 = Math.floor(last.t / 86400000) * 86400000, pd = c15.filter(b => b.t >= d0 - 86400000 && b.t < d0);
    if (pd.length) { add('H', Math.max.apply(null, pd.map(b => b.h)), 'PDH', d0 - 86400000, d0); add('L', Math.min.apply(null, pd.map(b => b.l)), 'PDL', d0 - 86400000, d0); }
  }
  // EQH / EQL / Double Top / Double Bottom : deux swings M15 à moins de eqTol l'un de l'autre
  const rec = n15 - 300;
  const eq = (arr, side) => {
    const L = arr.filter(s => s.i >= rec);
    for (let a = 0; a < L.length; a++) for (let b = a + 1; b < L.length; b++) {
      if (Math.abs(L[a].p - L[b].p) <= o.eqTolUsd) {
        const p = side === 'H' ? Math.max(L[a].p, L[b].p) : Math.min(L[a].p, L[b].p);
        const dbl = L[b].i - L[a].i >= 10;
        add(side, p, side === 'H' ? (dbl ? 'Double Top' : 'EQH') : (dbl ? 'Double Bottom' : 'EQL'), L[b].t);
      }
    }
  };
  eq(s15.H, 'H'); eq(s15.L, 'L');
  // « prise » = un prix plus récent a dépassé le niveau
  let q = 0;
  for (const p of out) {
    let lo = 0, hi = n15;
    while (lo < hi) { const m = (lo + hi) >> 1; if (c15[m].t > p.from) hi = m; else lo = m + 1; }
    q = lo;
    for (let i = q; i < n15; i++) if (p.side === 'H' ? c15[i].h > p.p : c15[i].l < p.p) { p.swept = true; break; }
  }
  return out;
}

/** OB d'ACHAT valides sur un timeframe : origine d'un mouvement qui casse un sommet précédent ; PAS toute dernière bougie, PAS de displacement exigé. */
function buyZones(c, tfName, tfMs, o) {
  const k = o.k, n = c.length, sw = swK(c, k), out = [];
  for (const S of sw.L) {
    if (S.i + k >= n) continue;
    let ph = null; for (let a = sw.H.length - 1; a >= 0; a--) if (sw.H[a].i < S.i) { ph = sw.H[a]; break; }
    if (!ph) continue;
    let b = -1; for (let q = S.i + 1; q < n && q <= S.i + 30; q++) if (c[q].c > ph.p) { b = q; break; }
    if (b < 0) continue;
    let j = -1; for (let q = Math.max(0, S.i - 2); q <= Math.min(S.i + 1, b - 1); q++) if (c[q].c < c[q].o && (j < 0 || c[q].l < c[j].l)) j = q;
    if (j < 0) continue;
    const lo = c[j].l, hi = Math.max(c[j].o, c[j].c), h = hi - lo;
    if (h < o.zoneMinUsd || h > o.zoneMaxUsd) continue;
    let bad = false, touch = -1;
    for (let q = b + 1; q < n; q++) { if (c[q].c < lo) { bad = true; break; } if (touch < 0 && c[q].l <= hi) touch = q; }
    let legHi = -Infinity; for (let q = S.i; q < n; q++) if (c[q].h > legHi) legHi = c[q].h;
    out.push({ id: `${tfName}:BUY:${c[j].t}`, tf: tfName, lo, hi, t: c[j].t, availT: c[b].t + tfMs, breakT: c[b].t, bad, touchT: touch >= 0 ? c[touch].t : null, swingLow: S.p, legHigh: legHi, ageBars: n - 1 - j });
  }
  return out;
}

/** Étape M15 (mise en cache à chaque bougie M15 fermée) : structure, liquidités, zones. Ne dépend que des bougies fermées. */
function m15Stage(c15, o) {
  const h1 = aggTF(c15, 15 * MIN, 60 * MIN), m30 = aggTF(c15, 15 * MIN, 30 * MIN);
  const st = structure(c15, o.k), s1 = structure(h1, o.k), pl = pools(h1, c15, o);
  const z15 = buyZones(c15, 'M15', 15 * MIN, o), z30 = buyZones(m30, 'M30', 30 * MIN, o);
  const zones = z30.slice();
  for (const z of z15) {   // une zone M15 qui recouvre une zone M30 est fusionnée (on garde la M30)
    const dup = z30.some(y => { const ov = Math.min(z.hi, y.hi) - Math.max(z.lo, y.lo); return ov > 0 && ov / Math.min(z.hi - z.lo, y.hi - y.lo) >= 0.6; });
    if (!dup) zones.push(z);
  }
  return { st, bias: s1.trend, pools: pl, zones, n: c15.length, lastT: c15[c15.length - 1].t };
}

/** Étape complète pour l'ACHAT : zones valides -> touche -> confirmation M5 -> entrée / SL / TP. */
function buyPipeline(c15, m5, price, now, o, store) {
  const key = c15[c15.length - 1].t + ':' + c15.length;
  if (store.key !== key) { store.key = key; store.stage = m15Stage(c15, o); }
  const G = store.stage, ev = G.st.events[G.st.events.length - 1], out = [];
  if (!ev || ev.dir !== 'UP' || ev.type !== 'BOS' || G.n - 1 - ev.b > o.structMaxBars) {
    const why = !ev ? 'aucune structure M15' : (ev.type === 'CHOCH' ? 'dernier événement M15 = CHOCH : attente du BOS confirmé' : (ev.dir === 'DOWN' ? 'dernier BOS M15 baissier' : 'BOS M15 trop ancien'));
    return { setups: [], wait: 'BUY : ' + why, ev: null, G };
  }
  const px = price ? price.mid : null, lastM15 = G.lastT + 15 * MIN;
  const need = o.confirmMaxBars + 30, W = m5.slice(-need), w0 = m5.length - W.length, sw5 = swK(W, o.k);
  const hiPools = G.pools.filter(p => p.side === 'H' && !p.swept), loPools = G.pools.filter(p => p.side === 'L');
  for (const z of G.zones) {
    const S = { id: z.id, dir: 'BUY', state: 'ZONE', dead: false, wait: '', zone: { lo: z.lo, hi: z.hi, t: z.t, tf: z.tf, bosLevel: ev.level, bosT: ev.t, bosType: ev.type }, tags: null };
    const dead = why => { S.state = 'DEAD'; S.dead = true; S.wait = why; out.push(S); };
    if (z.bad) { dead('zone invalidée (clôture M15 sous la zone)'); continue; }
    if (z.ageBars > o.zoneMaxAgeBars) { dead('zone trop ancienne'); continue; }
    if (!(z.hi < ev.level)) { dead('zone au-dessus du BOS : pas une zone de retour'); continue; }
    if (px != null && px - z.hi >= 40) { dead('zone trop loin du prix'); continue; }
    // --- liquidité : zone cohérente avec une liquidité (côté stops) + cible disponible ---
    const anchors = loPools.filter(p => p.p >= z.lo - o.liqNearUsd && p.p <= z.hi + 0.5);
    const recent = c15.slice(-Math.min(o.sweepBars, G.n));   // sweep récent : mèche sous une liquidité (côté stops) puis clôture au-dessus
    const sweep = loPools.some(p => p.p >= z.lo - 2 * o.liqNearUsd && p.p <= z.hi + o.liqNearUsd && recent.some(b => b.t > p.from && b.l < p.p && b.c > p.p));
    if (!anchors.length && !sweep) { dead('zone sans liquidité cohérente (aucun EQL / PDL / swing / sweep à la zone)'); continue; }
    const tgtMax = z.hi + o.targetMaxUsd;
    if (!hiPools.some(p => p.p > z.hi + o.tp1MinUsd && p.p <= tgtMax)) { dead('aucune liquidité cible au-dessus de la zone'); continue; }
    // --- Fibonacci : confluence supplémentaire ---
    const R = z.legHigh - z.swingLow, fibA = z.legHigh - o.fibHi * R, fibB = z.legHigh - o.fibLo * R;
    const fib = R > 0 && z.hi >= fibA && z.lo <= fibB;
    if (o.requireFib && !fib) { dead('Fibonacci non confluent (0.5 – 0.786)'); continue; }
    S.tags = { liq: anchors.slice(0, 3).map(p => p.type).concat(sweep ? ['Sweep'] : []), fib, sweep: !!sweep, bias: G.bias, counter: G.bias === 'DOWN' };
    // --- touche ---
    const fromT = Math.max(z.availT, z.touchT != null ? z.touchT : lastM15);
    let q0 = -1;
    for (let q = 0; q < W.length; q++) if (W[q].t >= fromT && W[q].l <= z.hi) { q0 = q; break; }
    if (z.touchT != null && now - z.touchT > (o.confirmMaxBars + 3) * 5 * MIN) { dead('zone déjà touchée sans trade (consommée)'); continue; }
    if (q0 < 0 && z.touchT == null && px != null && px <= z.hi) q0 = W.length;   // touche en direct
    if (q0 < 0 && z.touchT != null) q0 = 0;
    if (q0 < 0) {
      S.wait = 'OB BUY repéré : en attente que le prix touche la zone';
      if (px != null && px - z.hi >= 15) S.wait += ` (${(px - z.hi).toFixed(1)} $)`;
      out.push(S); continue;
    }
    S.state = 'TOUCHED'; S.touchT = z.touchT != null ? z.touchT : now;
    S.wait = 'zone touchée · en attente confirmation M5 BUY (cassure du dernier HIGH M5)';
    if (q0 >= W.length) { out.push(S); continue; }
    // --- confirmation M5 ---
    let low = -1, conf = -1, ref = null;
    for (let q = q0; q < W.length; q++) {
      if (W[q].l <= z.hi && (low < 0 || W[q].l < W[low].l)) low = q;
      if (low < 0) continue;
      let pick = null; for (let a = sw5.H.length - 1; a >= 0; a--) { const sh = sw5.H[a]; if (sh.i < low && sh.i + o.k < q) { pick = sh; break; } }
      if (pick && q > low && W[q].c > pick.p && W[q].c > W[q].o && q - low <= o.confirmMaxBars) { conf = q; ref = pick; break; }
    }
    if (conf < 0) { out.push(S); continue; }
    const entry = W[conf].c, lowest = Math.min(W[low].l, z.lo);
    let sl = lowest - o.slBufUsd, risk = entry - sl;
    S.confirm = { t: W[conf].t + 5 * MIN, lowT: W[low].t, refHigh: ref.p, ob: null };
    if (risk > o.slMaxUsd + 1e-9) { dead(`SL structurel ${risk.toFixed(1)} $ > ${o.slMaxUsd} $ (max ${o.slMaxUsd * 10} pips) : setup non valide`); continue; }
    if (risk < o.slMinUsd) { sl = entry - o.slMinUsd; risk = o.slMinUsd; }   // SL minimum 50 pips (reste derrière la structure)
    if (now - S.confirm.t > o.entryMaxMin * MIN) { dead('confirmation M5 trop ancienne'); continue; }
    if (px != null && Math.abs(px - entry) > o.entryDevUsd) { dead('prix trop éloigné de la confirmation M5'); continue; }
    let slHit = false; for (let q = conf + 1; q < W.length; q++) if (W[q].l <= sl) { slHit = true; break; }
    if (slHit) { dead('SL touché avant l\'entrée'); continue; }
    // --- TP : TP1 50–100 pips, TP2 200–250 pips (liquidité si possible) ---
    const ups = hiPools.map(p => p.p).filter(p => p > entry).sort((a, b) => a - b);
    let tp1 = ups.find(p => p - entry >= o.tp1MinUsd && p - entry <= o.tp1MaxUsd);
    if (tp1 == null) tp1 = entry + Math.max(o.tp1MinUsd, Math.min(o.tp1MaxUsd, risk));
    let tp2 = ups.find(p => p - entry >= o.tp2MinUsd && p - entry <= o.tp2MaxUsd);
    if (tp2 == null) tp2 = entry + (o.tp2MinUsd + o.tp2MaxUsd) / 2;
    if (!(tp2 > tp1)) tp2 = entry + o.tp2MaxUsd;
    const r1 = (tp1 - entry) / risk, r2v = (tp2 - entry) / risk;
    Object.assign(S, { state: 'CONFIRMED', wait: 'confirmation M5 BUY faite : entrée au marché', entry, sl, tp1, tp2, risk, r1, r2: r2v, rrTotal: (r1 + r2v) / 2, rrFinal: r2v, single: false });
    out.push(S);
  }
  return { setups: out, wait: null, ev, G };
}

/** Évaluation complète. ctx = { m15: bougies M15 fermées, m5: bougies M5 fermées, price: {mid}, now, cfg?, cache? } */
function smcEval(ctx) {
  const o = Object.assign({}, SMC, ctx.cfg || {});
  const c15 = ctx.m15 || [], m5 = ctx.m5 || [];
  if (c15.length < 80 || m5.length < 40) return { setups: [], wait: 'bougies insuffisantes (M15 / M5)', high: null, low: null, bias: null, bos: null };
  const store = ctx.cache || {}, kk = c15[c15.length - 1].t + ':' + c15.length;
  store.buy = store.buy || {}; store.sell = store.sell || {};
  if (store.mk !== kk) { store.mk = kk; store.m15s = mirrorC(c15); }
  const now = ctx.now, px = ctx.price || null, pm = px ? { mid: -px.mid } : null;
  const buy = buyPipeline(c15, m5, px, now, o, store.buy);
  const sell = buyPipeline(store.m15s, mirrorC(m5.slice(-(o.confirmMaxBars + 40))), pm, now, o, store.sell);
  const flip = S0 => {
    const S = Object.assign({}, S0, { dir: 'SELL', id: S0.id.replace(':BUY:', ':SELL:') });
    S.zone = Object.assign({}, S0.zone, { lo: -S0.zone.hi, hi: -S0.zone.lo, bosLevel: -S0.zone.bosLevel });
    if (S0.confirm) S.confirm = Object.assign({}, S0.confirm, { refHigh: -S0.confirm.refHigh });
    ['entry', 'sl', 'tp1', 'tp2'].forEach(f => { if (S0[f] != null) S[f] = -S0[f]; });
    if (S0.tags) S.tags = Object.assign({}, S0.tags, { bias: S0.tags.bias === 'UP' ? 'DOWN' : (S0.tags.bias === 'DOWN' ? 'UP' : null), counter: S0.tags.bias === 'UP' });
    S.wait = String(S0.wait).replace(/BUY/g, 'SELL').replace(/HIGH/g, 'LOW').replace(/haussier/g, 'baissier');
    return S;
  };
  const sw = swK(c15, o.k), lastH = sw.H.length ? sw.H[sw.H.length - 1].p : null, lastL = sw.L.length ? sw.L[sw.L.length - 1].p : null;
  const bosB = buy.ev, bosS = sell.ev;
  return { setups: buy.setups.concat(sell.setups.map(flip)), wait: (buy.wait && sell.wait) ? buy.wait + ' · ' + sell.wait.replace(/BUY/g, 'SELL') : null, high: lastH, low: lastL,
    bias: buy.G.bias, bos: bosB ? { dir: 'UP', level: bosB.level, t: bosB.t } : (bosS ? { dir: 'DOWN', level: -bosS.level, t: bosS.t } : null),
    liquidity: buy.G.pools.filter(p => !p.swept).slice(-60).map(p => ({ side: p.side, p: p.p, type: p.type })) };
}

module.exports = { SMC, swK, aggN, aggTF, mirrorC, structure, smcEval, ZONES, WADE, DEFAULT_ANALYSIS, ZONE_PROFILES };
