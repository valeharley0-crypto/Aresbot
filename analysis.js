'use strict';
/**
 * ARES — ANALYSE DE MARCHÉ (SMC + structure + Order Flow optionnel), mode-driven.
 * Fonctions pures. Entrée : bougies fermées par timeframe. Aucune donnée n'est inventée :
 * si une donnée manque (bougies, order flow, news) -> composant UNAVAILABLE ou WAIT.
 *
 * SCALPING : VRAI SCALP (evaluateScalp) — tendance M5 (EMA21/EMA50) · micro-tendance M3 (EMA9/EMA21) · entrée M1 sur pullback EMA ou sweep+reclaim
 *            · TP court unique · SL serré derrière le micro-swing · tous les symboles cochés
 * DAYTRADE : ZONES CLÉS M15 + M5 notées /100 (keyZones) — entrée sur la 1re zone >= 80 touchée ; SMC (evaluate) en option (XAUUSD + EURUSD seulement)
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
  minConfidencePct: 70,   // score de confluence minimal en % (score / score max) : SCALPING et DAYTRADE
  // --- Filtres de QUALITÉ (réduisent les entrées « poursuite de prix » qui finissent en SL) ---
  requireBreak: true,       // une cassure de structure récente (BOS/CHoCH) est OBLIGATOIRE : un simple biais ancien ne suffit plus
  requireZoneOrSweep: true, // entrée seulement sur sweep de liquidité OU retest d'une zone FVG / Order Block (on n'achète/vend plus au milieu de nulle part)
  htfStrict: true,          // biais du timeframe supérieur obligatoirement aligné quand il diffère du timeframe de structure (DAYTRADE : M15 ; un range ne valide plus)
  trigBodyMin: 0.4,         // bougie de confirmation : corps ≥ 40 % de sa taille (pas de mèche d'indécision)
  trigMaxAtr: 2.5,          // ... et taille ≤ 2.5 × ATR (pas de bougie d'épuisement : on ne court pas après le mouvement)
  // --- SL STRUCTUREL : placé derrière la structure (sweep / OB / creux-sommet), jamais dans le bruit ---
  slAtrMin: 0.8,            // distance SL minimale = 0.8 × ATR du timeframe de structure
  slBufferAtr: 0.3,         // marge derrière le niveau structurel = 0.3 × ATR (min 1.5 pt-or)
  weights: { structure: 3, mtf: 2, trigger: 2, sweep: 2, zone: 2, premiumDiscount: 1, orderFlow: 2 },
  orderFlow: { enabled: false, requireWhenEnabled: false }   // true : filtre ON + donnée indisponible -> WAIT
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


// ---------------------------------------------------------------------------------------------
// SCALPING — vraie stratégie de scalp (indépendante du moteur SMC du DAY TRADE)
// ---------------------------------------------------------------------------------------------
const SCALP = {
  emaFast: 9, emaSlow: 21, emaTrend: 50,
  rsiLen: 14, rsiBuy: [40, 72], rsiSell: [28, 60],   // on n'achète pas un marché épuisé / on ne vend pas un marché déjà écrasé
  pullbackBars: 6,         // le prix a touché la zone EMA9-EMA21 (M1) dans les N dernières bougies
  pullbackTolAtr: 0.25,    // tolérance autour de l'EMA21
  sweepBars: 8,            // sweep M1 d'un micro-creux/sommet dans les N dernières bougies
  trendMinGapAtr: 0.25,    // écart EMA21-EMA50 (M5) minimal en ATR M5 : en dessous = range, pas de scalp (0.15 -> 0.25)
  trigBodyMin: 0.5, trigMaxAtr: 2.2,
  slBufferAtr: 0.3, slAtrMin: 1.0,   // SL derrière le micro-swing, jamais à moins de 1 ATR M1 (avant 0.7 : touché par le bruit)
  requirePullback: true,   // le retour sur EMA9-21 est OBLIGATOIRE (le sweep seul ne suffit plus : c'était l'entrée la plus perdante)
  rr: 1.3,                 // (ancien mode TP fixe) TP1 = max(TP minimal du mode, rr × SL)
  roomFactor: 1.0,         // (ancien mode TP fixe) espace libre >= roomFactor × distance TP
  roomR: 1.5               // (mode TP en R) espace libre jusqu'au prochain swing M3 >= roomR × SL
};

/** TP en multiples de R (R = distance réelle entrée->SL). tp1 = tp1R × R (≈ clôture partielle + BE), tp2 = tp2R × R. Retourne null = ancien mode TP fixe en points. */
function rTargets(ctx, entry, risk, d) {
  const rt = ctx.rT;
  if (!rt || !(rt.tp1R > 0) || !(risk > 0)) return null;
  const tp1 = entry + d * risk * rt.tp1R, tp2 = rt.tp2R > rt.tp1R ? entry + d * risk * rt.tp2R : null;
  return { tp1, tp2, tp3: null };
}

function emaSeries(cs, n) {
  if (!cs || cs.length < n) return null;
  const k = 2 / (n + 1); let e = 0;
  for (let i = 0; i < n; i++) e += cs[i].c; e /= n;
  const out = new Array(cs.length).fill(null); out[n - 1] = e;
  for (let i = n; i < cs.length; i++) { e = cs[i].c * k + e * (1 - k); out[i] = e; }
  return out;
}

function rsiLast(cs, n) {
  if (!cs || cs.length <= n) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = cs[i].c - cs[i - 1].c; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < cs.length; i++) { const d = cs[i].c - cs[i - 1].c; ag = (ag * (n - 1) + Math.max(d, 0)) / n; al = (al * (n - 1) + Math.max(-d, 0)) / n; }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** SCALPING : bougies FERMÉES uniquement. Retourne le même format que evaluate(). */
function evaluateScalp(ctx) {
  const cfg = Object.assign({}, DEFAULT_ANALYSIS, ctx.cfg || {});
  const P = Object.assign({}, SCALP, (ctx.cfg || {}).scalp || {});
  const tf = ctx.tf, ce = ctx.candles[tf.entry] || [], cm = ctx.candles[tf.structure] || [], ct = ctx.candles[tf.htf] || [];
  const mk = (why, comps, extra) => Object.assign({ action: 'WAIT', wait: why, confidence: 0, score: 0, maxScore: 0, components: comps || [] }, extra || {});
  const need = P.emaTrend + 5;
  if (ce.length < need) return mk(`DATA_UNAVAILABLE: bougies M${tf.entry} insuffisantes (${ce.length}/${need})`);
  if (cm.length < P.emaSlow + 5) return mk(`DATA_UNAVAILABLE: bougies M${tf.structure} insuffisantes (${cm.length}/${P.emaSlow + 5})`);
  if (ct.length < need) return mk(`DATA_UNAVAILABLE: bougies M${tf.htf} insuffisantes (${ct.length}/${need})`);
  const price = ctx.price && ctx.price.mid; if (!price) return mk('DATA_UNAVAILABLE: prix indisponible');

  const A = ctx.limits || {};
  if (A.maxSpreadEq != null && ctx.spreadEq > A.maxSpreadEq) return mk(`spread ${r2(ctx.spreadEq)} > ${A.maxSpreadEq} (pts-or)`);
  const atr1 = atr(ce, cfg.atrPeriod); if (!atr1) return mk('DATA_UNAVAILABLE: ATR M' + tf.entry);
  const atrEq = ctx.toEq(atr1);
  if (A.minAtrEq != null && atrEq < A.minAtrEq) return mk(`marché trop calme (ATR M${tf.entry} ${r2(atrEq)} pts-or)`);
  if (A.maxAtrEq != null && atrEq > A.maxAtrEq) return mk(`marché trop violent (ATR M${tf.entry} ${r2(atrEq)} pts-or)`);

  // 1) TENDANCE M5 : EMA21 vs EMA50, pente, clôture du bon côté, écart minimal (sinon range)
  const e5s = emaSeries(ct, P.emaSlow), e5t = emaSeries(ct, P.emaTrend), n5 = ct.length - 1;
  const f5 = e5s[n5], t5 = e5t[n5], slope5 = f5 - e5s[n5 - 3], atr5 = atr(ct, cfg.atrPeriod) || atr1;
  let dir = null;
  if (f5 > t5 && slope5 > 0 && ct[n5].c > f5) dir = 'BUY';
  else if (f5 < t5 && slope5 < 0 && ct[n5].c < f5) dir = 'SELL';
  if (!dir) return mk(`pas de tendance M${tf.htf} nette (EMA${P.emaSlow}/EMA${P.emaTrend}) : pas de scalp`);
  if (Math.abs(f5 - t5) < P.trendMinGapAtr * atr5) return mk(`tendance M${tf.htf} trop plate (écart EMA < ${P.trendMinGapAtr} ATR) : range`);
  const buy = dir === 'BUY', comps = [], add = (name, pass, detail, weight) => comps.push({ name, pass, detail, weight, state: pass ? 'OK' : 'NO' });
  add('tendance M' + tf.htf, true, `EMA${P.emaSlow} ${buy ? '>' : '<'} EMA${P.emaTrend} · pente ${buy ? 'haussière' : 'baissière'}`, 3);

  // 2) MICRO-TENDANCE M3 : EMA9 vs EMA21 alignées
  const e3f = emaSeries(cm, P.emaFast), e3s = emaSeries(cm, P.emaSlow), n3 = cm.length - 1;
  const microOk = buy ? (e3f[n3] > e3s[n3] && cm[n3].c > e3s[n3]) : (e3f[n3] < e3s[n3] && cm[n3].c < e3s[n3]);
  add('micro M' + tf.structure, microOk, `EMA${P.emaFast}/EMA${P.emaSlow} M${tf.structure} ${microOk ? 'alignées' : 'non alignées'}`, 2);
  if (!microOk) return mk(`micro-tendance M${tf.structure} non alignée avec ${dir}`, comps);

  // 3) SETUP M1 : pullback sur EMA9-EMA21 OU sweep d'un micro-creux/sommet avec reclaim
  const e1f = emaSeries(ce, P.emaFast), e1s = emaSeries(ce, P.emaSlow), n1 = ce.length - 1;
  if (!(buy ? e1f[n1] > e1s[n1] : e1f[n1] < e1s[n1])) return mk(`EMA${P.emaFast}/EMA${P.emaSlow} M${tf.entry} non alignées : micro-tendance M${tf.entry} cassée`, comps);
  const tol = P.pullbackTolAtr * atr1;
  let pull = false;
  for (let i = n1 - P.pullbackBars; i < n1; i++) {            // la bougie de trigger (n1) est exclue du test de touche
    if (i < 1) continue;
    if (buy ? ce[i].l <= e1s[i] + tol && ce[i].c >= e1s[i] - tol : ce[i].h >= e1s[i] - tol && ce[i].c <= e1s[i] + tol) { pull = true; break; }
  }
  const swE = swings(ce, 2); let sw = null;
  const refs = (buy ? swE.L : swE.H).filter(x => x.i < n1 - 2 && x.i >= n1 - P.sweepBars - 12).slice(-3);
  for (let b = n1 - 1; b >= Math.max(1, n1 - P.sweepBars) && !sw; b--) for (const r of refs) {
    if (r.i >= b - 1) continue;
    if (buy ? (ce[b].l < r.price && ce[b].c > r.price) : (ce[b].h > r.price && ce[b].c < r.price)) { sw = { level: r.price, extreme: buy ? ce[b].l : ce[b].h }; break; }
  }
  add('pullback EMA', pull, pull ? `retour sur EMA${P.emaFast}-${P.emaSlow} M${tf.entry}` : 'pas de retour sur les EMA', 2);
  add('sweep M' + tf.entry, !!sw, sw ? `sweep ${r2(sw.level)} puis reclaim` : 'aucun sweep', 2);
  if (P.requirePullback ? !pull : (!pull && !sw)) return mk(P.requirePullback ? 'pas de retour (pullback) sur EMA9-21 : on ne poursuit pas le prix' : 'ni pullback EMA ni sweep+reclaim : on ne poursuit pas le prix', comps);

  // 4) TRIGGER M1 : bougie de confirmation (rupture de la bougie précédente, corps net, pas d'épuisement)
  const k1 = ce[n1], k0 = ce[n1 - 1], rng = Math.max(k1.h - k1.l, 1e-9), body = Math.abs(k1.c - k1.o) / rng;
  const base = buy ? (k1.c > k1.o && k1.c > k0.h && k1.c > e1f[n1]) : (k1.c < k1.o && k1.c < k0.l && k1.c < e1f[n1]);
  const trig = base && body >= P.trigBodyMin && rng <= P.trigMaxAtr * atr1;
  add('trigger M' + tf.entry, trig, `bougie M${tf.entry} ${trig ? 'de confirmation (corps ' + Math.round(body * 100) + '%)' : (base ? 'trop faible/épuisée' : 'sans confirmation')}`, 2);
  if (!trig) return mk('pas de bougie de confirmation M' + tf.entry, comps);

  // 5) RSI M1 : ni épuisé ni écrasé
  const rsi = rsiLast(ce, cfg.rsiLen || P.rsiLen), band = buy ? P.rsiBuy : P.rsiSell;
  const rsiOk = rsi !== null && rsi >= band[0] && rsi <= band[1];
  add('RSI M' + tf.entry, rsiOk, `RSI ${rsi === null ? '?' : Math.round(rsi)} (zone ${band[0]}-${band[1]})`, 1);
  if (!rsiOk) return mk(`RSI M${tf.entry} ${rsi === null ? '?' : Math.round(rsi)} hors zone ${band[0]}-${band[1]} : marché épuisé`, comps);

  // 6) SL derrière le micro-swing, TP court, espace libre jusqu'au prochain swing M3
  const entry = buy ? (ctx.price.ask || price) : (ctx.price.bid || price);
  const buf = Math.max(ctx.dist(1.0), P.slBufferAtr * atr1), minDist = Math.max(ctx.dist(A.minSlEq || 0), P.slAtrMin * atr1);
  const rec = ce.slice(-4);
  const anchors = buy ? [Math.min(...rec.map(x => x.l)), sw && sw.extreme] : [Math.max(...rec.map(x => x.h)), sw && sw.extreme];
  const cand = anchors.filter(x => Number.isFinite(x) && (buy ? x < entry : x > entry)).map(x => (buy ? x - buf : x + buf));
  let sl = cand.length ? (buy ? Math.min(...cand) : Math.max(...cand)) : (buy ? entry - minDist : entry + minDist);
  if (Math.abs(entry - sl) < minDist) sl = buy ? entry - minDist : entry + minDist;
  const slEq = ctx.toEq(Math.abs(entry - sl));
  if (A.minSlEq != null && slEq < A.minSlEq) return mk(`SL ${r2(slEq)} pts-or < ${A.minSlEq} : trop serré`, comps);
  if (A.slMax != null && slEq > A.slMax) return mk(`SL ${r2(slEq)} pts-or > maximum ${A.slMax} : scalp ignoré`, comps);
  if (ctx.spreadEq && ctx.spreadEq > 0.3 * slEq) return mk(`spread ${r2(ctx.spreadEq)} pts-or > 30 % du SL (${r2(slEq)}) : scalp non rentable`, comps);
  const T = ctx.targets || {}, d = buy ? 1 : -1, RT = rTargets(ctx, entry, Math.abs(entry - sl), d);
  const tpEq = RT ? slEq * (ctx.rT.tp2R > ctx.rT.tp1R ? ctx.rT.tp2R : ctx.rT.tp1R) : Math.max(T.tp1 || 0, P.rr * slEq), tp1 = RT ? RT.tp1 : entry + d * ctx.dist(tpEq);
  const swM = swings(cm, cfg.swingK), wall = (buy ? swM.H.filter(x => x.price > entry) : swM.L.filter(x => x.price < entry)).slice(-1)[0];   // obstacle = prochain swing M3 devant le prix
  const room = wall ? ctx.toEq(Math.abs(wall.price - entry)) : Infinity;
  const roomOk = RT ? room >= P.roomR * slEq : room >= P.roomFactor * tpEq;
  add('espace libre', roomOk, wall ? `swing M${tf.structure} à ${r2(room)} pts-or (TP ${r2(tpEq)})` : 'aucun obstacle M' + tf.structure, 1);
  if (!roomOk) return mk(`obstacle M${tf.structure} à ${r2(room)} pts-or avant le TP (${r2(tpEq)}) : scalp ignoré`, comps);

  const maxScore = comps.reduce((a, c) => a + c.weight, 0), score = comps.filter(c => c.pass).reduce((a, c) => a + c.weight, 0), confidence = Math.round(score / maxScore * 100);
  const res = { components: comps, score, maxScore, confidence };
  if (cfg.minConfidencePct && confidence < cfg.minConfidencePct) return Object.assign(mk(`score ${confidence}% < minimum ${cfg.minConfidencePct}%`, comps), res);
  const names = comps.filter(c => c.pass).map(c => c.name).join(' + ');
  return Object.assign({ action: dir, entry, sl, tp1, tp2: RT ? RT.tp2 : null, tp3: null, slEq: r2(slEq), tpEq: r2(tpEq),
    reason: `SCALPING ${dir} · ${names} · score ${score}/${maxScore} (${confidence}%) · SL ${r2(slEq)} / TP ${r2(tpEq)} pts-or · ATR M${tf.entry} ${r2(atrEq)}` }, res);
}

// ---------------------------------------------------------------------------------------------
// DAY TRADE — ZONES CLÉS M15 + M5 (offre / demande)
// Chaque zone reçoit un score /100. Seules les zones >= minScore (80) sont tradées.
// Entrée : la PREMIÈRE zone valide que le prix TOUCHE (état « TOUCHÉ »). SL derrière la zone, TP1/TP2 du mode.
// ---------------------------------------------------------------------------------------------
const ZONES = {
  enabled: true,
  minScore: 80,                    // score minimal pour qu'une zone soit tradable
  lookback: { 5: 200, 15: 120 },   // nb de bougies fermées analysées par timeframe
  impulseAtr: 1.4,                 // l'impulsion qui quitte la zone doit faire >= 1.4 ATR
  impulseBars: 3,                  // ... en 3 bougies maximum
  maxWidthAtr: 2.0,                // zone plus large que 2 ATR (même en corps seul) = ignorée
  maxVisits: 2,                    // zone déjà retestée plus de 2 fois = épuisée
  touchTolAtr: 0.05,               // tolérance de « touche » = 5 % ATR autour de la zone
  slBufferAtr: 0.2,                // SL = bord lointain de la zone ± 0.2 ATR (min 1.5 pt-or)
  htfVeto: true,                   // zone contre le biais M15 = ignorée
  maxShown: 10,                    // zones affichées par paire sur le site
  // --- FILTRES SMC (v2) : une zone qui ne remplit pas TOUTES ces conditions n'est JAMAIS tradée ---
  requireBos: true,                // l'impulsion qui quitte la zone doit avoir cassé la structure (BOS)
  requireBias: 'notAgainst',       // 'aligned' = biais M15 obligatoirement dans le sens (strict) · 'notAgainst' = un range est toléré
  requirePD: true,                 // achat seulement en DISCOUNT, vente seulement en PREMIUM (moitié du range M15)
  requireSweep: false,             // true = sweep de liquidité obligatoire juste avant la réaction (profil STRICT)
  // --- CONFIRMATION M5 : on n'entre plus au 1er contact, on attend la bougie de rejet ---
  confirmBars: 3,                  // la zone doit avoir été touchée dans les N dernières bougies M5 fermées
  confirmBodyMin: 0.4,             // bougie de rejet : corps >= 40 % de sa taille
  trigMaxAtr: 2.5,                 // ... et taille <= 2.5 ATR (pas d'épuisement)
  slAtrMin: 0.8,                   // SL jamais plus proche que 0.8 ATR M5
  slMaxAtr: 3,                     // SL max = 3 ATR M5 (au lieu d'un nombre de points fixe, trop serré sur l'or)
  slCapEq: 28,                     // plafond absolu du SL en pts-or (reste sous la marge de perte journalière du robot)
  minRoomR: 2,                     // espace libre jusqu'au prochain swing M15 >= 2 R (sinon TP2 irréaliste)
  maxSpreadSlPct: 0.2              // le spread ne doit pas dépasser 20 % du SL
};
/** Profils du backtest : STRICT = tous les filtres SMC · BALANCED = défaut (un biais M15 en range est toléré, sweep facultatif). */
const ZONE_PROFILES = {
  BALANCED: { requireBias: 'notAgainst', requireBos: true, requirePD: true, requireSweep: false },
  STRICT: { requireBias: 'aligned', requireBos: true, requirePD: true, requireSweep: true }
};

/** Candidats de zones (impulsion + bougie de base) sur UN timeframe. Sans score final. */
function zoneCandidates(cs, tfMin, Z) {
  const n = cs.length, a = atr(cs, 14);
  if (!a || n < 30) return [];
  const sw = swings(cs, 2), out = [], from = Math.max(2, n - ((Z.lookback || {})[tfMin] || 120));
  for (let i = from; i < n - 2; i++) {
    const b = cs[i], rngB = Math.max(b.h - b.l, 1e-9);
    for (const dir of ['BUY', 'SELL']) {
      const buy = dir === 'BUY';
      const opp = buy ? b.c < b.o : b.c > b.o, small = Math.abs(b.c - b.o) / rngB < 0.35;
      if (!opp && !small) continue;                                        // base = bougie opposée (ou indécision)
      const nx = cs[i + 1];
      if (!(buy ? nx.c > nx.o : nx.c < nx.o)) continue;                    // la bougie suivante lance l'impulsion
      const end = Math.min(n - 1, i + Z.impulseBars);
      let ext = buy ? -Infinity : Infinity, brokeBase = false;
      for (let k = i + 1; k <= end; k++) {
        ext = buy ? Math.max(ext, cs[k].h) : Math.min(ext, cs[k].l);
        if (buy ? cs[k].c > b.h : cs[k].c < b.l) brokeBase = true;
      }
      const disp = buy ? ext - b.l : b.h - ext;
      if (!brokeBase || disp < Z.impulseAtr * a) continue;
      let lo = b.l, hi = b.h;
      if (hi - lo > Z.maxWidthAtr * a) { lo = Math.min(b.o, b.c); hi = Math.max(b.o, b.c); }   // trop large : corps seul
      if (!(hi - lo > 0) || hi - lo > Z.maxWidthAtr * a) continue;
      // vie de la zone : cassée (clôture au-delà du bord lointain) ou épuisée (trop de retests) = rejetée
      let broken = false, visits = 0, inside = false;
      for (let k = end + 1; k < n; k++) {
        const c = cs[k];
        if (buy ? c.c < lo : c.c > hi) { broken = true; break; }
        const touch = buy ? c.l <= hi : c.h >= lo;
        if (touch && !inside) { visits++; inside = true; } else if (!touch) inside = false;
      }
      if (broken || visits > Z.maxVisits) continue;
      // cassure de structure par l'impulsion (BOS) + FVG laissé derrière
      const ref = (buy ? sw.H : sw.L).filter(x => x.i < i).slice(-1)[0];
      let bos = false;
      if (ref) for (let k = i + 1; k <= Math.min(n - 1, end + 3); k++) if (buy ? cs[k].c > ref.price : cs[k].c < ref.price) { bos = true; break; }
      let fvg = false;
      for (let k = i + 1; k <= end && k + 1 < n; k++) if (buy ? cs[k - 1].h < cs[k + 1].l : cs[k - 1].l > cs[k + 1].h) { fvg = true; break; }
      // réaction antérieure : un creux/sommet confirmé déjà dans la zone (support / résistance)
      const tolP = 0.3 * a, prior = (buy ? sw.L : sw.H).some(x => x.i < i && x.price >= lo - tolP && x.price <= hi + tolP);
      out.push({ id: `M${tfMin}:${dir}:${b.t}`, tf: tfMin, dir, type: buy ? 'DEMAND' : 'SUPPLY', lo, hi, t: b.t, atr: a, dispAtr: disp / a, visits, bos, fvg, prior });
    }
  }
  return out;
}

/** Toutes les zones clés (M15 + M5) notées /100. Ne dépend pas du prix live (le prix sert seulement à zoneState). */
function keyZones(ctx) {
  const Z = Object.assign({}, ZONES, ctx.zonesCfg || {}); Z.lookback = Object.assign({}, ZONES.lookback, (ctx.zonesCfg || {}).lookback || {});
  const tl = ctx.tf.structure, th = ctx.tf.htf, cl = ctx.candles[tl] || [], ch = ctx.candles[th] || [];
  if (cl.length < 40 || ch.length < 40) return { zones: [], bias: null, wait: `DATA_UNAVAILABLE: bougies M${tl}/M${th} insuffisantes (${cl.length}/${ch.length}, minimum 40)` };
  const swH = swings(ch, 2), bias = biasOf(swH), pd = premiumDiscount(swH, 0), eq = pd ? pd.eq : null;
  const A = zoneCandidates(cl, tl, Z), B = tl === th ? [] : zoneCandidates(ch, th, Z), all = A.concat(B);
  const overlap = (x, y) => x.tf !== y.tf && x.dir === y.dir && x.lo <= y.hi && y.lo <= x.hi;
  const roomPx = ctx.targets && ctx.targets.tp1 ? ctx.dist(ctx.targets.tp1) : 0;
  const zones = [];
  for (const z of all) {
    const buy = z.dir === 'BUY', aligned = buy ? bias === 'BULL' : bias === 'BEAR', against = buy ? bias === 'BEAR' : bias === 'BULL';
    if (Z.htfVeto && against) continue;
    if (Z.requireBias === 'aligned' && !aligned) continue;   // SMC strict : biais M15 obligatoirement dans le sens de la zone
    if (Z.requireBos && !z.bos) continue;                    // SMC : pas de cassure de structure = pas une vraie zone d'institutionnels
    const mid0 = (z.lo + z.hi) / 2, pdOk0 = eq !== null && (buy ? mid0 < eq : mid0 > eq);
    if (Z.requirePD && !pdOk0) continue;                     // SMC : on n'achète pas en premium / on ne vend pas en discount
    const parts = [], add = (name, pts, max, detail) => parts.push({ name, pts, max, detail });
    add('impulsion', z.dispAtr >= 2.5 ? 25 : z.dispAtr >= 2 ? 20 : z.dispAtr >= 1.6 ? 15 : 10, 25, `départ ${z.dispAtr.toFixed(1)} ATR`);
    add('zone fraîche', z.visits === 0 ? 20 : z.visits === 1 ? 12 : 5, 20, z.visits === 0 ? 'jamais retestée' : `retestée ${z.visits}×`);
    add('cassure + FVG', (z.bos ? 10 : 0) + (z.fvg ? 5 : 0), 15, `${z.bos ? 'BOS' : 'pas de BOS'} · ${z.fvg ? 'FVG' : 'pas de FVG'}`);
    add(`biais M${th}`, aligned ? 15 : 7, 15, `biais M${th} ${bias}`);
    const ov = all.some(o => overlap(z, o));
    add('confluence', (ov ? 10 : 0) + (z.prior ? 5 : 0), 15, `${ov ? `zone M${z.tf === tl ? th : tl} superposée` : 'pas de superposition M' + (z.tf === tl ? th : tl)}${z.prior ? ' · réaction antérieure' : ''}`);
    const mid = (z.lo + z.hi) / 2, pdOk = eq !== null && (buy ? mid < eq : mid > eq);
    const nxt = (buy ? swH.H.filter(x => x.price > z.hi).sort((p, q) => p.price - q.price) : swH.L.filter(x => x.price < z.lo).sort((p, q) => q.price - p.price))[0];
    const roomOk = !nxt || Math.abs(nxt.price - (buy ? z.hi : z.lo)) >= roomPx;
    add('position', (pdOk ? 5 : 0) + (roomOk ? 5 : 0), 10, `${pdOk ? (buy ? 'discount' : 'premium') : 'mauvaise moitié du range'} · ${roomOk ? 'espace libre' : 'obstacle proche'}`);
    const score = parts.reduce((s, p) => s + p.pts, 0);
    zones.push(Object.assign({}, z, { score, parts, label: `M${z.tf} ${z.type}` }));
  }
  zones.sort((p, q) => q.score - p.score);
  return { zones, bias, atr: atr(cl, 14) };
}

/** WAIT (le prix approche) · TOUCH (le prix est dans la zone) · BROKEN (le prix a traversé la zone). */
function zoneState(z, price, Z) {
  const tol = ((Z && Z.touchTolAtr) != null ? Z.touchTolAtr : ZONES.touchTolAtr) * z.atr, p = price.mid;
  if (z.dir === 'BUY') return p > z.hi + tol ? 'WAIT' : (p >= z.lo - tol ? 'TOUCH' : 'BROKEN');
  return p < z.lo - tol ? 'WAIT' : (p <= z.hi + tol ? 'TOUCH' : 'BROKEN');
}

/** Zone « armée » : le prix est dedans MAINTENANT, ou une bougie fermée de l'ancien timeframe d'entrée l'a touchée dans les confirmBars dernières bougies (sans la casser). */
function zoneArmed(z, ctx, Z) {
  Z = Object.assign({}, ZONES, Z || {});
  const st = zoneState(z, ctx.price, Z);
  if (st === 'BROKEN') return false;
  if (st === 'TOUCH') return true;
  const ce = ctx.candles[ctx.tf.entry] || [], nb = Z.confirmBars || 3, tol = Z.touchTolAtr * z.atr, mature = z.t + (Z.impulseBars + 1) * z.tf * 60000, buy = z.dir === 'BUY';
  if (ce.length < nb + 2) return false;
  let touched = false;
  for (const k of ce.slice(-nb)) {
    if (k.t <= mature) continue;                                  // bougies de formation de la zone : pas un retest
    if (buy ? k.c < z.lo - tol : k.c > z.hi + tol) return false;  // cassée
    if (buy ? k.l <= z.hi + tol : k.h >= z.lo - tol) touched = true;
  }
  return touched;
}

/**
 * Signal d'entrée sur une zone ARMÉE. Dans l'ordre :
 *  1) la zone a été retestée (touchée) dans les 3 dernières bougies M5 fermées ;
 *  2) CONFIRMATION : la dernière bougie M5 fermée est une bougie de REJET (sens du trade, corps net, clôture du bon côté de la zone, pas d'épuisement) ;
 *  3) (profil STRICT) sweep de liquidité juste avant ;
 *  4) SL derrière la zone ET derrière la mèche du retest (extrême), jamais dans le bruit (>= 0.8 ATR) ;
 *  5) espace libre >= minRoomR × R jusqu'au prochain swing M15 ; spread <= 20 % du SL ;
 *  6) TP1 = tp1R × R (clôture partielle, SL au breakeven ensuite), TP2 = tp2R × R (ex. 1R puis 3R).
 * `pending: true` = « on attend encore la confirmation » : la zone ne doit PAS être verrouillée (le robot réessaie à la prochaine bougie).
 */
function evaluateZone(ctx, z) {
  const Z = Object.assign({}, ZONES, ctx.zonesCfg || {});
  const A = ctx.limits || {}, T = ctx.targets || {}, price = ctx.price;
  const mk = (why, pending) => ({ action: 'WAIT', wait: why, pending: !!pending, confidence: z.score, score: z.score, maxScore: 100, components: [], zone: zoneInfo(z) });
  if (A.maxSpreadEq != null && ctx.spreadEq > A.maxSpreadEq) return mk(`spread ${r2(ctx.spreadEq)} > ${A.maxSpreadEq} (pts-or)`, true);
  const aS = z.atr, atrEqZ = ctx.toEq(aS);
  if (A.minAtrEq != null && atrEqZ < A.minAtrEq) return mk(`marché trop calme (ATR ${r2(atrEqZ)} pts-or)`, true);
  if (A.maxAtrEq != null && atrEqZ > A.maxAtrEq) return mk(`marché trop violent (ATR ${r2(atrEqZ)} pts-or)`, true);
  const buy = z.dir === 'BUY', d = buy ? 1 : -1, entry = buy ? (price.ask || price.mid) : (price.bid || price.mid);
  const ce = ctx.candles[ctx.tf.entry] || [], n = ce.length;
  if (n < 30) return mk(`DATA_UNAVAILABLE: bougies M${ctx.tf.entry} insuffisantes (${n})`, true);
  const atrE = atr(ce, 14) || aS, nb = Z.confirmBars || 3, tol = Z.touchTolAtr * z.atr, mature = z.t + (Z.impulseBars + 1) * z.tf * 60000;
  // 1) retest récent, zone non cassée
  const win = ce.slice(-nb).filter(k => k.t > mature);
  let touched = false, ext = buy ? Infinity : -Infinity;
  for (const k of win) {
    if (buy ? k.c < z.lo - tol : k.c > z.hi + tol) return mk('zone cassée par une clôture');
    if (buy ? k.l <= z.hi + tol : k.h >= z.lo - tol) { touched = true; ext = buy ? Math.min(ext, k.l) : Math.max(ext, k.h); }
  }
  if (!touched) return mk('en attente du retest de la zone (aucune bougie M' + ctx.tf.entry + ' ne l\'a touchée)', true);
  // 2) bougie de rejet = confirmation
  const k1 = ce[n - 1], k0 = ce[n - 2], rng = Math.max(k1.h - k1.l, 1e-9), body = Math.abs(k1.c - k1.o) / rng, mid = (z.lo + z.hi) / 2;
  const wick = buy ? (Math.min(k1.o, k1.c) - k1.l) / rng : (k1.h - Math.max(k1.o, k1.c)) / rng;
  const sideOk = buy ? (k1.c > k1.o && k1.c >= mid) : (k1.c < k1.o && k1.c <= mid), brk = buy ? k1.c > k0.h : k1.c < k0.l;
  const reject = sideOk && body >= (Z.confirmBodyMin || 0) && (brk || wick >= 0.4) && rng <= (Z.trigMaxAtr || 99) * atrE;
  if (!reject) return mk(`zone ${z.label} retestée : en attente d'une bougie de rejet M${ctx.tf.entry} (corps ≥ ${Math.round((Z.confirmBodyMin || 0) * 100)} %, clôture ${buy ? 'au-dessus' : 'sous'} du milieu de la zone)`, true);
  // 3) sweep de liquidité (obligatoire en STRICT) : mèche sous un creux (ou sous la zone) puis clôture de retour
  const swE = swings(ce, 2), sw0 = sweep(ce, swE, z.dir, nb + 1);
  let zsw = false;
  for (const k of win) if (buy ? (k.l < z.lo && k.c > z.lo) : (k.h > z.hi && k.c < z.hi)) zsw = true;
  const swept = !!(sw0 || zsw);
  if (Z.requireSweep && !swept) return mk('pas de sweep de liquidité avant le rejet (profil STRICT)', true);
  // 4) SL derrière la zone ET derrière l'extrême du retest
  const buf = Math.max(ctx.dist(1.5), Z.slBufferAtr * aS), minDist = Math.max(ctx.dist(A.minSlEq || 0), (Z.slAtrMin || 0) * atrE);
  const far = buy ? Math.min(z.lo, ext, sw0 ? sw0.extreme : Infinity) : Math.max(z.hi, ext, sw0 ? sw0.extreme : -Infinity);
  let sl = buy ? far - buf : far + buf;
  if (Math.abs(entry - sl) < minDist) sl = buy ? entry - minDist : entry + minDist;
  if (buy ? sl >= entry : sl <= entry) return mk('prix déjà au-delà du SL de la zone');
  const risk = Math.abs(entry - sl), slEq = ctx.toEq(risk);
  const capByAtr = Z.slMaxAtr > 0 ? ctx.toEq(Z.slMaxAtr * atrE) : 0;
  const capEq = Math.min(Z.slCapEq > 0 ? Z.slCapEq : Infinity, Math.max(A.slMax != null ? A.slMax : 0, capByAtr) || Infinity);
  if (slEq > capEq) return mk(`SL derrière la zone ${r2(slEq)} pts-or > maximum ${r2(capEq)} : zone trop large / entrée trop loin`);
  if (ctx.spreadEq && ctx.spreadEq > (Z.maxSpreadSlPct || 1) * slEq) return mk(`spread ${r2(ctx.spreadEq)} pts-or > ${Math.round((Z.maxSpreadSlPct || 1) * 100)} % du SL (${r2(slEq)})`, true);
  // 5) espace libre jusqu'au prochain swing M15 (obstacle)
  const ch = ctx.candles[ctx.tf.htf] || [];
  if (Z.minRoomR > 0 && ch.length > 20) {
    const swH = swings(ch, 2), wall = (buy ? swH.H.filter(x => x.price > entry).sort((p, q) => p.price - q.price) : swH.L.filter(x => x.price < entry).sort((p, q) => q.price - p.price))[0];
    if (wall && Math.abs(wall.price - entry) < Z.minRoomR * risk) return mk(`obstacle M${ctx.tf.htf} à ${r2(ctx.toEq(Math.abs(wall.price - entry)))} pts-or (< ${Z.minRoomR} R) : TP2 irréaliste`);
  }
  // 6) TP en R (TP1 = 1R + BE, TP2 = 3R) ; sinon ancien mode TP fixe
  const RT = rTargets(ctx, entry, risk, d), tp = g => (g ? entry + d * ctx.dist(g) : null);
  const comps = z.parts.map(p => ({ name: p.name, pass: p.pts > 0, detail: p.detail + ` (${p.pts}/${p.max})`, weight: p.max, state: p.pts > 0 ? 'OK' : 'NO' }));
  comps.push({ name: 'rejet M' + ctx.tf.entry, pass: true, detail: `corps ${Math.round(body * 100)} %`, weight: 0, state: 'OK' }, { name: 'sweep', pass: swept, detail: swept ? 'liquidité balayée avant le rejet' : 'aucun sweep', weight: 0, state: swept ? 'OK' : 'NO' });
  return { action: z.dir, entry, sl, tp1: RT ? RT.tp1 : tp(T.tp1), tp2: RT ? RT.tp2 : tp(T.tp2), tp3: RT ? null : tp(T.tp3), slEq: r2(slEq), components: comps, score: z.score, maxScore: 100, confidence: z.score, zone: zoneInfo(z),
    reason: `${ctx.mode} ${z.dir} · zone clé ${z.label} ${r2(z.lo)}-${r2(z.hi)} retestée + rejet M${ctx.tf.entry}${swept ? ' + sweep' : ''} · score ${z.score}/100 · SL ${r2(slEq)} pts-or${RT ? ` · TP1 ${ctx.rT.tp1R}R${RT.tp2 ? ' / TP2 ' + ctx.rT.tp2R + 'R' : ''}` : ''}` };
}
const zoneInfo = z => ({ id: z.id, tf: 'M' + z.tf, dir: z.dir, type: z.type, lo: z.lo, hi: z.hi, score: z.score });

/**
 * @param ctx { mode, tf:{entry,structure,htf}, candles:{[min]:[bars fermées]}, price:{bid,ask,mid}, spreadEq, atrEq,
 *              dist:(goldEqPts)=>prixUnits, toEq:(prixUnits)=>goldEqPts, limits:{slMax,minAtrEq,maxAtrEq,maxSpreadEq},
 *              targets:{tp1,tp2,tp3}, orderFlow:{status,delta,cvd,...}, cfg }
 * @returns { action:'BUY'|'SELL'|'WAIT', wait?, confidence, score, maxScore, components[], entry, sl, tp1, tp2, tp3, reason }
 */
function evaluate(ctx) {
  if (ctx.mode === 'SCALPING') return evaluateScalp(ctx);   // vrai scalp : stratégie dédiée
  const cfg = Object.assign({}, DEFAULT_ANALYSIS, ctx.cfg || {});
  cfg.weights = Object.assign({}, DEFAULT_ANALYSIS.weights, (ctx.cfg || {}).weights || {});
  cfg.orderFlow = { enabled: false, requireWhenEnabled: false };   // Order Flow supprimé
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
  if (cfg.htfStrict && tf.htf !== tf.structure && !aligned(biasH)) return wait(`biais M${tf.htf} ${biasH} non aligné avec ${dir} (HTF strict : un range ne valide pas)`, comps);
  add('mtf', aligned(biasH), `biais M${tf.htf} ${biasH}`, W.mtf);
  // 3) trigger (bougie de confirmation sur le timeframe d'entrée)
  const e1 = ce[ce.length - 1], e0 = ce[ce.length - 2];
  const atrE = atr(ce, cfg.atrPeriod) || atrS, rng = Math.max(e1.h - e1.l, 1e-9), body = Math.abs(e1.c - e1.o) / rng;
  const trigBase = dir === 'BUY' ? (e1.c > e1.o && e1.c > e0.h) : (e1.c < e1.o && e1.c < e0.l);
  const trig = trigBase && body >= (cfg.trigBodyMin || 0) && (!cfg.trigMaxAtr || rng <= cfg.trigMaxAtr * atrE);
  add('trigger', trig, `bougie M${tf.entry} ${trig ? 'de confirmation (corps ' + Math.round(body * 100) + '%)' : (trigBase ? 'trop faible/épuisée (corps ' + Math.round(body * 100) + '%)' : 'sans confirmation')}`, W.trigger);
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
  if (cfg.requireBreak && !brk) return Object.assign(wait(`aucune cassure de structure M${tf.structure} récente (BOS/CHoCH) : biais seul insuffisant`, comps), base);
  if (cfg.requireZoneOrSweep && !(sw || fv || obHit)) return Object.assign(wait('ni sweep de liquidité ni retest FVG/OB : on n\'entre pas au milieu du mouvement', comps), base);
  if (!trig) return Object.assign(wait('pas de bougie de confirmation sur le timeframe d\'entrée', comps), base);
  if (cfg.minConfidencePct && confidence < cfg.minConfidencePct) return Object.assign(wait(`score ${confidence}% < minimum ${cfg.minConfidencePct}% (score ${score}/${maxScore})`, comps), base);
  if (score < cfg.minScore || passed < cfg.minComponents) return Object.assign(wait(`confluence insuffisante : score ${score}/${maxScore} (min ${cfg.minScore}), ${passed} composants (min ${cfg.minComponents})`, comps), base);

  // SL STRUCTUREL : derrière la structure (sweep, Order Block, dernier creux/sommet du timeframe de structure, extrême récent),
  // marge ATR, et toujours à ≥ slAtrMin × ATR de l'entrée : un SL dans le bruit de marché se fait toucher sans raison.
  const entry = dir === 'BUY' ? (ctx.price.ask || price) : (ctx.price.bid || price);
  const buf = Math.max(ctx.dist(1.5), cfg.slBufferAtr * atrS);
  const minDistPx = Math.max(ctx.dist(A.minSlEq || 0), (cfg.slAtrMin || 0) * atrS);
  const rec = ce.slice(-5);
  const anchors = dir === 'BUY'
    ? [Math.min(...rec.map(x => x.l)), sw && sw.extreme, obHit && obHit.lo, (swS.L.filter(x => x.price < entry).slice(-1)[0] || {}).price]
    : [Math.max(...rec.map(x => x.h)), sw && sw.extreme, obHit && obHit.hi, (swS.H.filter(x => x.price > entry).slice(-1)[0] || {}).price];
  const cand = anchors.filter(x => Number.isFinite(x) && (dir === 'BUY' ? x < entry : x > entry))
    .map(x => (dir === 'BUY' ? x - buf : x + buf))
    .sort((a, b) => Math.abs(entry - a) - Math.abs(entry - b));
  // l'ancre la plus proche qui respecte la distance minimale ; sinon la plus lointaine (puis contrôle slMax)
  let sl = cand.find(x => Math.abs(entry - x) >= minDistPx);
  if (sl === undefined) sl = dir === 'BUY' ? entry - minDistPx : entry + minDistPx;
  const slEq = ctx.toEq(Math.abs(entry - sl));
  if (A.minSlEq != null && slEq < A.minSlEq) return Object.assign(wait(`SL ${r2(slEq)} pts-or < ${A.minSlEq} : trop serré (bruit/spread)`, comps), base);
  if (A.slMax != null && slEq > A.slMax) return Object.assign(wait(`SL structurel ${r2(slEq)} pts-or > maximum ${A.slMax} : setup ignoré (stop derrière la structure trop loin)`, comps), base);
  // SCALPING : le spread ne doit pas manger le trade (>30 % du SL = espérance négative)
  if (ctx.mode === 'SCALPING' && ctx.spreadEq && ctx.spreadEq > 0.3 * slEq) return Object.assign(wait(`spread ${r2(ctx.spreadEq)} pts-or > 30 % du SL (${r2(slEq)}) : scalp non rentable`, comps), base);
  const d = dir === 'BUY' ? 1 : -1, T = ctx.targets || {};
  const tp = g => (g ? entry + d * ctx.dist(g) : null);
  const names = comps.filter(c => c.pass).map(c => c.name).join(' + ');
  return Object.assign({ action: dir, entry, sl, tp1: tp(T.tp1), tp2: tp(T.tp2), tp3: tp(T.tp3), slEq: r2(slEq),
    reason: `${ctx.mode} ${dir} · confluence ${names} · score ${score}/${maxScore} (${confidence}%) · SL ${r2(slEq)} pts-or · ATR ${r2(atrEq)}` }, base);
}

module.exports = { evaluate, evaluateScalp, keyZones, zoneState, zoneArmed, evaluateZone, rTargets, DEFAULT_ANALYSIS, SCALP, ZONES, ZONE_PROFILES, _t: { emaSeries, rsiLast, swings, biasOf, lastBreak, sweep, fvgs, orderBlock, premiumDiscount, atr } };
