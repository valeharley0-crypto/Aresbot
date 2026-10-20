'use strict';
/**
 * ARES — ANALYSE DE MARCHÉ (SMC + structure + Order Flow optionnel), mode-driven.
 * Fonctions pures. Entrée : bougies fermées par timeframe. Aucune donnée n'est inventée :
 * si une donnée manque (bougies, order flow, news) -> composant UNAVAILABLE ou WAIT.
 *
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
  minConfidencePct: 70,   // score de confluence minimal en % (score / score max) : DAY TRADE
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


/** Regroupe des bougies fermées (ex. M15) en bougies de `factor` fois plus longues (ex. 4 -> H1). Seuls les groupes COMPLETS sont gardés. */
function aggregate(cs, factor, tfMin) {
  const span = factor * tfMin * 60000, out = []; let cur = null;
  for (const k of cs) {
    const g = Math.floor(k.t / span) * span;
    if (!cur || cur.t !== g) { if (cur && cur.n === factor) out.push(cur); cur = { t: g, o: k.o, h: k.h, l: k.l, c: k.c, n: 1 }; }
    else { cur.h = Math.max(cur.h, k.h); cur.l = Math.min(cur.l, k.l); cur.c = k.c; cur.n++; }
  }
  if (cur && cur.n === factor) out.push(cur);
  return out;
}
/** Tendance H1 (construite depuis le M15) : 'BUY' si EMA20 > EMA50 et clôture > EMA50, 'SELL' dans le cas inverse, sinon null (range). */
function h1Trend(c15) {
  const h1 = aggregate(c15, 4, 15);
  if (h1.length < 55) return null;
  const e20 = emaSeries(h1, 20), e50 = emaSeries(h1, 50), n = h1.length - 1;
  if (!e20 || !e50 || e20[n] == null || e50[n] == null) return null;
  if (e20[n] > e50[n] && h1[n].c > e50[n]) return 'BUY';
  if (e20[n] < e50[n] && h1[n].c < e50[n]) return 'SELL';
  return null;
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

// ---------------------------------------------------------------------------------------------
// DAY TRADE — ZONES CLÉS M15 + M5 (offre / demande)
// Chaque zone reçoit un score /100. Seules les zones >= minScore (80) sont tradées.
// Entrée : la PREMIÈRE zone valide que le prix TOUCHE (état « TOUCHÉ »). SL derrière la zone, TP1/TP2 du mode.
// ---------------------------------------------------------------------------------------------
const ZONES = {
  enabled: true,
  minScore: 75,                    // score minimal pour qu'une zone soit tradable
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
  requireBias: 'notAgainst',       // (tendance H1 obligatoire = pas de contre-tendance) // 'aligned' = biais M15 obligatoirement dans le sens (strict) · 'notAgainst' = un range est toléré
  requirePD: false,                // premium/discount SUPPRIMÉ (remplacé par l'OTE)
  requireSweep: false,             // true = sweep de liquidité obligatoire juste avant la réaction (profil STRICT)
  // --- CONFIRMATION M5 : on n'entre plus au 1er contact, on attend la bougie de rejet ---
  confirmBars: 3,                  // la zone doit avoir été touchée dans les N dernières bougies M5 fermées
  confirmBodyMin: 0.4,             // bougie de rejet : corps >= 40 % de sa taille
  trigMaxAtr: 2.5,                 // ... et taille <= 2.5 ATR (pas d'épuisement)
  slAtrMin: 0.8,                   // SL jamais plus proche que 0.8 ATR M5
  slMaxAtr: 3,                     // SL max = 3 ATR M5 (au lieu d'un nombre de points fixe, trop serré sur l'or)
  slCapEq: 0,                      // plafond ABSOLU du SL en pts-or : 0 = désactivé. L'ancien 28 pts-or ($2.8 sur l'or) était PLUS PETIT que le SL minimum (0.8 ATR) dès que l'ATR M5 dépassait ~$3.5 : presque tous les trades étaient refusés. Le plafond est maintenant slMaxAtr × ATR M5.
  minRoomR: 1,                     // espace libre jusqu'au prochain swing M15 >= 1 R (TP1 atteignable)
  maxSpreadSlPct: 0.1,             // le spread ne doit pas dépasser 10 % du SL
  requireFvg: true,                // OB de qualité : l'impulsion doit laisser un FVG (déséquilibre) derrière elle
  // --- ARES SMC : entrée LIMIT à l'OTE (retracement 62-79 % de l'impulsion) dans la zone clé ---
  requireOte: false,               // l'OTE n'est PAS obligatoire : c'est un bonus de points dans le score de la zone (+ prix d'entrée si la zone croise la bande 62-79 %)
  missedPtsEq: 15,                 // zone « manquée » : la zone n'a PAS été touchée et le prix est déjà à cette distance d'elle = plus jamais prise (forex : 15 pts-or = 15 pips)
  missedPtsEqBySym: { XAUUSD: 150 }, // OR : 15 points = 15 $ = 150 pts-or (1 pt-or = 0.1 $)
  oteLo: 0.62, oteHi: 0.79, oteMid: 0.705,
  clusterAtr: 0.5,                 // zones de même sens à moins de 0.5 ATR l'une de l'autre = UNE seule zone (la mieux notée)
  limitMaxApproachAtr: 8,          // l'ordre limit n'est posé que si le prix est à <= 8 ATR M5 de l'entrée
  limitExpiryBars: 144,            // un ordre limit non touché est annulé après 144 bougies M5 (12 h) ; il est aussi annulé si la zone est cassée ou « manquée »
  requireH1: true                  // tendance H1 (EMA20/EMA50 construites depuis le M15) obligatoirement dans le sens du trade : plus de trade contre la tendance
};
/** Profils du backtest : STRICT = tous les filtres SMC · BALANCED = défaut (un biais M15 en range est toléré, sweep facultatif). */
const ZONE_PROFILES = {
  BALANCED: { requireBias: 'notAgainst', requireBos: true, requirePD: false, requireSweep: false },
  STRICT: { requireBias: 'aligned', requireBos: true, requirePD: false, requireSweep: true }
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
      out.push({ id: `M${tfMin}:${dir}:${b.t}`, tf: tfMin, dir, type: buy ? 'DEMAND' : 'SUPPLY', lo, hi, t: b.t, atr: a, ext, origin: buy ? b.l : b.h, dispAtr: disp / a, visits, bos, fvg, prior });
    }
  }
  return out;
}

/** OTE (Optimal Trade Entry) : bande de retracement 62-79 % de l'impulsion qui quitte la zone, croisée avec la zone. entry = point de la zone le plus proche de 70.5 %. */
function oteOf(z, Z) {
  const lo = Z.oteLo != null ? Z.oteLo : 0.62, hi = Z.oteHi != null ? Z.oteHi : 0.79, mid = Z.oteMid != null ? Z.oteMid : 0.705;
  if (!Number.isFinite(z.ext) || !Number.isFinite(z.origin)) return { ok: false, why: 'impulsion inconnue' };
  const buy = z.dir === 'BUY', leg = Math.abs(z.ext - z.origin);
  if (!(leg > 0)) return { ok: false, why: 'impulsion nulle' };
  const at = r => (buy ? z.ext - r * leg : z.ext + r * leg);
  const bLo = Math.min(at(lo), at(hi)), bHi = Math.max(at(lo), at(hi)), m = at(mid);
  const cLo = Math.max(bLo, z.lo), cHi = Math.min(bHi, z.hi);
  if (!(cLo <= cHi)) return { ok: false, lo: bLo, hi: bHi, mid: m, why: 'la zone ne croise pas la bande OTE 62-79 %' };
  return { ok: true, lo: bLo, hi: bHi, mid: m, entry: Math.min(cHi, Math.max(cLo, m)) };
}


/* =====================================================================================================
 * GOLD SMC — modèle du trader : SWEEP de liquidité → BMS/BOS → RTO dans la zone OB M15 (affinée en M5)
 *  1. biais M30 (M15 agrégées) : dernière cassure de structure (CHoCH/BOS) — jamais contre-tendance
 *  2. sweep : mèche au-delà d'un sommet/creux M15 intact (« $$$ »), la clôture revient dedans
 *  3. BMS : une clôture M15 casse la structure dans l'autre sens (avec FVG), dans les 16 bougies
 *  4. zone OB = dernière bougie opposée à l'origine du mouvement ; plus de 15 points → affinée sur les M5 de cette bougie
 *  5. ordre LIMIT au milieu de la zone ; SL derrière la zone ET derrière la mèche du sweep
 *  6. TP1 = 1R (puis BE) ; TP2 = prochaine liquidité opposée (RR variable, >= 2R) ; RR total affiché
 *  Zone morte pour toujours : cassée, expirée (12 h), touchée sans nous, ou prix à 15 $ de la zone sans l'avoir touchée.
 * ===================================================================================================== */
const GOLD = {
  swingK: 3, lookbackM15: 160, sweepMinAtr: 0.1, sweepCloseBars: 2, bmsMaxBars: 16, expiryM15: 48,
  zoneMaxEq: 150,            // 150 pts-or = 15 $ : au-delà, la zone est affinée sur les M5
  minRR: 2, maxRR: 8, slBufferAtr: 0.1, slCapAtr: 4, maxSpreadSlPct: 0.05, requireFvg: true
};
function aggregateTf(cs, n) {   // n bougies consécutives alignées sur l'horloge (M15 x 2 = M30)
  const ms = (cs.length > 1 ? cs[1].t - cs[0].t : 900000) * n, map = new Map();
  for (const c of cs) { const b = Math.floor(c.t / ms) * ms; let g = map.get(b); if (!g) { g = { t: b, o: c.o, h: c.h, l: c.l, c: c.c, n: 0 }; map.set(b, g); } g.h = Math.max(g.h, c.h); g.l = Math.min(g.l, c.l); g.c = c.c; g.n++; }
  return Array.from(map.values()).filter(g => g.n === n);
}
function trendBMS(cs, k) {      // 'UP' / 'DOWN' : sens de la dernière cassure de structure (clôture au-delà du dernier swing)
  const sw = swings(cs, k); if (!sw.H.length || !sw.L.length) return null;
  let trend = null, lastH = null, lastL = null, hi = 0, li = 0;
  for (let i = 0; i < cs.length; i++) {
    while (hi < sw.H.length && sw.H[hi].i + k <= i) { lastH = sw.H[hi]; hi++; }
    while (li < sw.L.length && sw.L[li].i + k <= i) { lastL = sw.L[li]; li++; }
    if (lastH && cs[i].c > lastH.price) { trend = 'UP'; lastH = null; }
    else if (lastL && cs[i].c < lastL.price) { trend = 'DOWN'; lastL = null; }
  }
  return trend;
}
function goldSmc(ctx) {
  const Z = Object.assign({}, ZONES, ctx.zonesCfg || {}), G = Object.assign({}, GOLD, Z.gold || {}), out = { setups: [], bias: null, wait: null };
  const c15 = (ctx.candles && ctx.candles[15]) || [], c5 = (ctx.candles && ctx.candles[5]) || [];
  if (c15.length < 80 || c5.length < 40) { out.wait = `DATA_UNAVAILABLE: bougies M15 ${c15.length} / M5 ${c5.length} insuffisantes`; return out; }
  const a15 = atr(c15, 14); if (!a15) { out.wait = 'ATR M15 indisponible'; return out; }
  const k = G.swingK, px = ctx.price.mid, dist = ctx.dist, toEq = ctx.toEq;
  const m30 = aggregateTf(c15.slice(-260), 2), trend = m30.length >= 24 ? trendBMS(m30, 2) : null;
  out.bias = trend === 'UP' ? 'BULL' : trend === 'DOWN' ? 'BEAR' : 'RANGE';
  const missedEq = (Z.missedPtsEqBySym || {})[ctx.symbol] != null ? Z.missedPtsEqBySym[ctx.symbol] : (Z.missedPtsEq != null ? Z.missedPtsEq : 15), missedPx = dist(missedEq);
  const base = Math.max(0, c15.length - G.lookbackM15), ch = c15.slice(base), n = ch.length, sw = swings(ch, k), levels = liquidityLevels(c15, a15);
  const over = G.sweepMinAtr * a15, found = [];
  for (let j = k + 3; j < n; j++) {
    const b = ch[j], jEnd = Math.min(n - 1, j + G.sweepCloseBars);
    for (const dir of ['SELL', 'BUY']) {     // SELL : sweep d'un sommet ; BUY : sweep d'un creux
      const sells = dir === 'SELL', pool = (sells ? sw.H : sw.L).filter(s => s.i + k < j && s.i > j - 90);
      let hit = null;
      for (const s of pool) {
        const pierced = sells ? b.h > s.price + over : b.l < s.price - over; if (!pierced) continue;
        let intact = true; for (let q = s.i + 1; q < j; q++) if (sells ? ch[q].h > s.price : ch[q].l < s.price) { intact = false; break; }
        if (!intact) continue;
        let back = sells ? b.c < s.price : b.c > s.price; for (let q = j + 1; !back && q <= jEnd; q++) back = sells ? ch[q].c < s.price : ch[q].c > s.price;
        if (!back) continue;
        if (!hit || (sells ? s.price > hit.price : s.price < hit.price)) hit = s;
      }
      if (hit) { let ext = sells ? b.h : b.l; for (let q = j; q <= jEnd; q++) ext = sells ? Math.max(ext, ch[q].h) : Math.min(ext, ch[q].l); found.push({ j, dir, level: hit, ext }); }
    }
  }
  for (const ev of found.slice(-12)) {
    const { j, dir, ext } = ev, sells = dir === 'SELL', d = sells ? -1 : 1, id = `G:${dir}:${ch[j].t}`;
    const st = { id, setup: 'GOLD_SMC', action: 'WAIT', wait: null, dead: false, pending: false };
    // structure à casser : dernier swing opposé confirmé avant le sweep
    const opp = (sells ? sw.L : sw.H).filter(s => s.i < j && s.i + k <= j).slice(-1)[0];
    if (!opp) continue;
    let m = -1; for (let q = j + 1; q <= Math.min(n - 1, j + G.bmsMaxBars); q++) if (sells ? ch[q].c < opp.price : ch[q].c > opp.price) { m = q; break; }
    if (m < 0) { if (n - 1 - j > G.bmsMaxBars) continue; st.wait = 'sweep détecté : attente de la cassure (BMS)'; st.pending = true; st.zone = null; out.setups.push(st); continue; }
    let fvg = false; for (let q = j + 1; q < m && q + 1 < n; q++) if (sells ? ch[q + 1].h < ch[q - 1].l : ch[q + 1].l > ch[q - 1].h) { fvg = true; break; }
    // zone OB : dernière bougie opposée à l'origine du mouvement (corps + mèche côté opposé au sweep)
    let oi = j - 1 >= 0 ? j - 1 : j; for (let q = j - 1; q <= m - 1; q++) if (q >= 0 && (sells ? ch[q].h > ch[oi].h : ch[q].l < ch[oi].l)) oi = q;
    const isOpp = q => (sells ? ch[q].c > ch[q].o : ch[q].c < ch[q].o);
    let ob = oi; if (!isOpp(ob)) for (const q of [oi - 1, oi - 2, oi + 1]) if (q >= 0 && q < m && isOpp(q)) { ob = q; break; }
    const oc = ch[ob], bodyLo = Math.min(oc.o, oc.c), bodyHi = Math.max(oc.o, oc.c);
    let lo = sells ? oc.l : bodyLo, hi = sells ? bodyHi : oc.h, refined = false;
    if (hi - lo > dist(G.zoneMaxEq)) {   // zone > 15 points : affinage sur les M5 de la bougie OB
      const sub = c5.filter(x => x.t >= oc.t && x.t < oc.t + 900000), subOpp = sub.filter(x => (sells ? x.c > x.o : x.c < x.o));
      const pick = (subOpp.length ? subOpp : sub).reduce((p, x) => (!p || (sells ? x.h > p.h : x.l < p.l) ? x : p), null);
      if (pick) { lo = sells ? pick.l : Math.min(pick.o, pick.c); hi = sells ? Math.max(pick.o, pick.c) : pick.h; refined = true; }
    }
    if (!(hi > lo)) continue;
    const entry = (lo + hi) / 2, zone = { id, tf: 'M15', dir, type: sells ? 'SUPPLY' : 'DEMAND', lo, hi, score: null, merged: 1, members: [id], ote: null };
    st.zone = zone;
    // zone morte ?
    let touched = false, broken = false; for (let q = m + 1; q < n; q++) { if (sells ? ch[q].h >= lo : ch[q].l <= hi) touched = true; if (sells ? ch[q].c > hi : ch[q].c < lo) broken = true; }
    const away = sells ? lo - px : px - hi;
    if (broken) { st.dead = true; st.wait = 'zone cassée'; out.setups.push(st); continue; }
    if (touched) { st.dead = true; st.wait = 'zone déjà touchée sans ordre rempli'; out.setups.push(st); continue; }
    if (n - 1 - m > G.expiryM15) { st.dead = true; st.wait = 'setup expiré (> 12 h)'; out.setups.push(st); continue; }
    if (away >= missedPx) { st.dead = true; st.wait = `zone manquée : le prix est à ${Math.round(toEq(away))} pts-or de la zone sans l'avoir touchée (≥ ${missedEq})`; out.setups.push(st); continue; }
    if (trend !== (sells ? 'DOWN' : 'UP')) { st.wait = `contre la tendance M30 (${out.bias}) : refusé`; out.setups.push(st); continue; }
    if (G.requireFvg !== false && !fvg) { st.wait = 'pas de FVG dans le déplacement (BMS non validé)'; out.setups.push(st); continue; }
    if (sells ? px >= entry : px <= entry) { st.wait = 'le prix est déjà à l\'entrée : pas d\'ordre limit possible'; out.setups.push(st); continue; }
    // SL : derrière la zone ET la mèche du sweep
    const buf = Math.max(dist(10), G.slBufferAtr * a15), sl = sells ? Math.max(hi, ext) + buf : Math.min(lo, ext) - buf, risk = Math.abs(sl - entry), riskEq = toEq(risk);
    if (risk > G.slCapAtr * a15) { st.dead = true; st.wait = `SL ${Math.round(riskEq)} pts-or > ${G.slCapAtr} ATR M15 : zone trop large`; out.setups.push(st); continue; }
    if (ctx.spreadEq && ctx.spreadEq > G.maxSpreadSlPct * riskEq) { st.wait = `spread ${r2(ctx.spreadEq)} pts-or > ${Math.round(G.maxSpreadSlPct * 100)} % du SL`; st.pending = true; out.setups.push(st); continue; }
    // TP2 = prochaine liquidité opposée donnant >= minRR (RR variable) ; TP1 = 1R puis BE
    const side = sells ? 'SSL' : 'BSL', ahead = levels.filter(l => l.side === side && (sells ? l.price < entry : l.price > entry)).sort((p, q) => Math.abs(p.price - entry) - Math.abs(q.price - entry));
    const tgt = ahead.find(l => Math.abs(l.price - entry) / risk >= G.minRR);
    if (!tgt) { st.wait = `aucune liquidité opposée à >= ${G.minRR}R devant`; st.pending = true; out.setups.push(st); continue; }
    const tp2R = Math.min(G.maxRR, (Math.abs(tgt.price - entry) - dist(5)) / risk), tp2 = entry + d * risk * tp2R, tp1 = entry + d * risk;
    const frac = (ctx.rT && ctx.rT.frac) || 0.5, rrTotal = Math.round((frac * 1 + (1 - frac) * tp2R) * 100) / 100;
    // OTE (bonus de points, jamais obligatoire) : l'entrée est entre 0,5 et 0,79 du mouvement sweep → BMS
    let legExt = sells ? Infinity : -Infinity; for (let q = j; q <= m; q++) legExt = sells ? Math.min(legExt, ch[q].l) : Math.max(legExt, ch[q].h);
    const retr = sells ? (entry - legExt) / (ext - legExt) : (legExt - entry) / (legExt - ext), oteOk = retr >= 0.5 && retr <= 0.79;
    const parts = [
      { name: 'sweep de liquidité', pts: 1, max: 1, detail: `${ev.level.price.toFixed(2)} balayé` }, { name: 'BMS', pts: 1, max: 1, detail: 'structure cassée' },
      { name: 'FVG', pts: fvg ? 1 : 0, max: 1, detail: fvg ? 'FVG dans le déplacement' : 'aucun FVG' }, { name: 'biais M30', pts: 1, max: 1, detail: out.bias },
      { name: 'OTE 0,5-0,79', pts: oteOk ? 1 : 0, max: 1, detail: `retracement ${(retr * 100).toFixed(0)} %` }, { name: 'zone affinée M5', pts: refined ? 1 : 0, max: 1, detail: refined ? 'M15 > 15 pts → M5' : 'zone M15 ≤ 15 pts' },
      { name: 'RR ≥ 3', pts: tp2R >= 3 ? 1 : 0, max: 1, detail: `TP2 ${tp2R.toFixed(1)}R sur ${tgt.type}` }
    ];
    zone.ote = { ok: oteOk, lo: null, hi: null, entry };
    Object.assign(st, { action: sells ? 'SELL' : 'BUY', wait: null, entry, sl, tp1, tp2, tp3: null, limit: true, expiryBars: Z.limitExpiryBars || 144, slEq: r2(riskEq), rrPicked: r2(tp2R), rrPlanned: r2(tp2R), rrTotal,
      parts, components: parts.map(p => ({ name: p.name, pass: p.pts > 0, detail: p.detail, weight: 1, state: p.pts > 0 ? 'OK' : 'NO' })), confidence: 100, score: 100, maxScore: 100,
      reason: `GOLD SMC ${dir} LIMIT · sweep ${ev.level.price.toFixed(2)} → BMS · OB M15${refined ? ' (M5)' : ''} ${r2(lo)}-${r2(hi)} · entrée ${r2(entry)} · SL ${r2(riskEq)} pts-or · TP1 1R · TP2 ${tp2R.toFixed(1)}R (${tgt.type}) · RR total ${rrTotal}` });
    out.setups.push(st);
  }
  // doublons : même sens et zones qui se recouvrent → on garde le plus récent
  const kept = [];
  for (const s of out.setups.slice().reverse()) { if (!s.zone) { kept.push(s); continue; } if (!kept.some(o => o.zone && o.zone.dir === s.zone.dir && o.zone.lo - 0.5 * a15 <= s.zone.hi && s.zone.lo - 0.5 * a15 <= o.zone.hi)) kept.push(s); }
  out.setups = kept;
  return out;
}

/** Toutes les zones clés (M15 + M5) notées /100. Ne dépend pas du prix live (le prix sert seulement à zoneState). */
function keyZones(ctx) {
  const Z = Object.assign({}, ZONES, ctx.zonesCfg || {}); Z.lookback = Object.assign({}, ZONES.lookback, (ctx.zonesCfg || {}).lookback || {});
  const tl = ctx.tf.structure, th = ctx.tf.htf, cl = ctx.candles[tl] || [], ch = ctx.candles[th] || [];
  if (cl.length < 40 || ch.length < 40) return { zones: [], bias: null, wait: `DATA_UNAVAILABLE: bougies M${tl}/M${th} insuffisantes (${cl.length}/${ch.length}, minimum 40)` };
  const swH = swings(ch, 2), bias = biasOf(swH), pd = premiumDiscount(swH, 0), eq = pd ? pd.eq : null;
  const h1t = Z.requireH1 ? h1Trend(ch) : null;   // null = range H1 (ou filtre désactivé)
  const A = zoneCandidates(cl, tl, Z), B = tl === th ? [] : zoneCandidates(ch, th, Z), all = A.concat(B);
  const overlap = (x, y) => x.tf !== y.tf && x.dir === y.dir && x.lo <= y.hi && y.lo <= x.hi;
  const roomPx = ctx.targets && ctx.targets.tp1 ? ctx.dist(ctx.targets.tp1) : 0;
  const zones = [], st = ctx.zoneStats || null, drop = (k, z) => { if (st) (st[k] = st[k] || new Set()).add(z.id); };
  if (st) all.forEach(z => drop('candidates', z));
  for (const z of all) {
    const buy = z.dir === 'BUY', aligned = buy ? bias === 'BULL' : bias === 'BEAR', against = buy ? bias === 'BEAR' : bias === 'BULL';
    if (Z.htfVeto && against) { drop('htfVeto', z); continue; }
    if (Z.requireH1 && z.dir !== h1t) { drop('h1', z); continue; }   // tendance H1 absente (range) ou contraire : on ne trade pas
    if (Z.requireBias === 'aligned' && !aligned) { drop('bias', z); continue; }   // SMC strict : biais M15 obligatoirement dans le sens de la zone
    if (Z.requireFvg && !z.fvg) { drop('fvg', z); continue; }   // OB sans déséquilibre (FVG) = pas une zone d'institutionnels
    if (Z.requireBos && !z.bos) { drop('bos', z); continue; }   // SMC : pas de cassure de structure = pas une vraie zone d'institutionnels
    const mid0 = (z.lo + z.hi) / 2, pdOk0 = eq !== null && (buy ? mid0 < eq : mid0 > eq);
    if (Z.requirePD && !pdOk0) { drop('pd', z); continue; }   // SMC : on n'achète pas en premium / on ne vend pas en discount
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
    const ote = oteOf(z, Z);
    add('OTE + espace', (ote.ok ? 5 : 0) + (roomOk ? 5 : 0), 10, `${ote.ok ? 'OTE 62-79 % dans la zone' : 'hors OTE'} · ${roomOk ? 'espace libre' : 'obstacle proche'}`);
    const ignP = Z.ignoreParts || [], keptP = parts.filter(p => !ignP.includes(p.name)), maxP = keptP.reduce((a, p) => a + p.max, 0) || 100;
    const score = Math.round(keptP.reduce((a, p) => a + p.pts, 0) / maxP * 100);   // confirmations retirées = ne comptent plus (score ramené sur 100)
    const checks = { bos: !!z.bos, fvg: !!z.fvg, fresh: z.visits === 0, h1: h1t === z.dir, bias: aligned, pd: pdOk, room: roomOk, overlap: ov };
    if (st) drop(score >= (Z.minScore || 0) ? 'scoreOk' : 'scoreLow', z);
    zones.push(Object.assign({}, z, { score, parts, checks, ote, label: `M${z.tf} ${z.type}` }));
  }
  zones.sort((p, q) => q.score - p.score);
  // ARES SMC : zones de même sens qui se touchent / sont très proches = UNE seule zone (la mieux notée) ; les autres deviennent ses « membres »
  const kept = [], gap = (Z.clusterAtr != null ? Z.clusterAtr : 0.5);
  for (const z of zones) {
    const k = kept.find(o => o.dir === z.dir && o.lo - gap * Math.max(o.atr, z.atr) <= z.hi && z.lo - gap * Math.max(o.atr, z.atr) <= o.hi);
    if (k) { k.members.push(z.id); k.merged = k.members.length; } else { z.members = [z.id]; z.merged = 1; kept.push(z); }
  }
  return { zones: kept, bias, atr: atr(cl, 14), rawZones: zones.length };
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
  const aS = z.atr;
  const buy = z.dir === 'BUY', d = buy ? 1 : -1, entry = buy ? (price.ask || price.mid) : (price.bid || price.mid);
  const ce = ctx.candles[ctx.tf.entry] || [], n = ce.length;
  if (n < 30) return mk(`DATA_UNAVAILABLE: bougies M${ctx.tf.entry} insuffisantes (${n})`, true);
  const atrE = atr(ce, 14) || aS, atrEqZ = ctx.toEq(atrE);   // ATR du TF d'entrée (M5) : les seuils minAtr/maxAtr sont définis en M5
  if (A.minAtrEq != null && atrEqZ < A.minAtrEq) return mk(`marché trop calme (ATR M${ctx.tf.entry} ${r2(atrEqZ)} pts-or)`, true);
  if (A.maxAtrEq != null && atrEqZ > A.maxAtrEq) return mk(`marché trop violent (ATR M${ctx.tf.entry} ${r2(atrEqZ)} pts-or)`, true);
  const nb = Z.confirmBars || 3, tol = Z.touchTolAtr * z.atr, mature = z.t + (Z.impulseBars + 1) * z.tf * 60000;
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
  const BT = ctx.rT ? buildTargets(ctx, entry, risk, d, getLevels(ctx, ch)) : null;
  if (BT && !BT.ok) return mk(BT.why);
  const RT = BT ? { tp1: BT.tp1, tp2: BT.tp2, tp3: null } : null, tp = g => (g ? entry + d * ctx.dist(g) : null);
  const comps = z.parts.map(p => ({ name: p.name, pass: p.pts > 0, detail: p.detail + ` (${p.pts}/${p.max})`, weight: p.max, state: p.pts > 0 ? 'OK' : 'NO' }));
  comps.push({ name: 'rejet M' + ctx.tf.entry, pass: true, detail: `corps ${Math.round(body * 100)} %`, weight: 0, state: 'OK' }, { name: 'sweep', pass: swept, detail: swept ? 'liquidité balayée avant le rejet' : 'aucun sweep', weight: 0, state: swept ? 'OK' : 'NO' });
  return { action: z.dir, entry, sl, tp1: RT ? RT.tp1 : tp(T.tp1), tp2: RT ? RT.tp2 : tp(T.tp2), tp3: RT ? null : tp(T.tp3), slEq: r2(slEq), components: comps, score: z.score, maxScore: 100, confidence: z.score, zone: zoneInfo(z),
    reason: `${ctx.mode} ${z.dir} · zone clé ${z.label} ${r2(z.lo)}-${r2(z.hi)} retestée + rejet M${ctx.tf.entry}${swept ? ' + sweep' : ''} · score ${z.score}/100 · SL ${r2(slEq)} pts-or${RT ? ` · TP1 ${ctx.rT.tp1R}R${RT.tp2 ? ' / TP2 ' + BT.tp2R + 'R (' + BT.why + ')' : ''}` : ''}` };
}
const zoneInfo = z => ({ id: z.id, tf: 'M' + z.tf, dir: z.dir, type: z.type, lo: z.lo, hi: z.hi, score: z.score, merged: z.merged || 1, members: z.members || [z.id], ote: z.ote ? { ok: !!z.ote.ok, lo: z.ote.lo, hi: z.ote.hi, entry: z.ote.entry } : null });

/**
 * ARES SMC — ORDRE LIMIT sur une zone « assurée » AVANT que le prix la touche.
 * Conditions : zone valide (BOS, FVG, tendance H1, score >= minScore, fraîche), bande OTE 62-79 % croisant la zone, prix encore AU-DESSUS (achat) / EN DESSOUS (vente)
 * de l'entrée, pas trop loin (limitMaxApproachAtr), SL derrière la zone, espace libre >= minRoomR × R, RR 2 ou 3 selon la liquidité, spread <= 20 % du SL.
 * `pending: true` = pas encore posable (prix trop loin / marché calme) : la zone n'est PAS verrouillée. Retour : { action, entry (= prix limite), sl, tp1 (= TP unique), limit: true, expiryBars }.
 */
function zoneLimit(ctx, z) {
  const Z = Object.assign({}, ZONES, ctx.zonesCfg || {});
  const A = ctx.limits || {}, price = ctx.price;
  const mk = (why, pending) => ({ action: 'WAIT', wait: why, pending: !!pending, confidence: z.score, score: z.score, maxScore: 100, components: [], zone: zoneInfo(z) });
  const buy = z.dir === 'BUY', d = buy ? 1 : -1, aS = z.atr;
  const ote = z.ote || oteOf(z, Z);
  if (Z.requireOte === true && !ote.ok) return mk('hors OTE : ' + (ote.why || 'zone non éligible'));
  const entry = ote.ok ? ote.entry : (z.lo + z.hi) / 2;   // OTE si la zone croise la bande 62-79 %, sinon milieu de la zone (50 %)
  const ce = ctx.candles[ctx.tf.entry] || [], n = ce.length;
  if (n < 30) return mk(`DATA_UNAVAILABLE: bougies M${ctx.tf.entry} insuffisantes (${n})`, true);
  const atrE = atr(ce, 14) || aS, atrEqZ = ctx.toEq(atrE), px = price.mid;
  if (A.minAtrEq != null && atrEqZ < A.minAtrEq) return mk(`marché trop calme (ATR M${ctx.tf.entry} ${r2(atrEqZ)} pts-or)`, true);
  if (A.maxAtrEq != null && atrEqZ > A.maxAtrEq) return mk(`marché trop violent (ATR M${ctx.tf.entry} ${r2(atrEqZ)} pts-or)`, true);
  const missedEq = ((Z.missedPtsEqBySym || {})[ctx.symbol] != null ? Z.missedPtsEqBySym[ctx.symbol] : (Z.missedPtsEq != null ? Z.missedPtsEq : 15)), missedPx = ctx.dist(missedEq), away = buy ? px - z.hi : z.lo - px;
  if (away >= missedPx) return Object.assign(mk(`zone manquée : le prix n'a pas touché la zone et est déjà à ${r2(ctx.toEq(away))} pts-or de la zone (≥ ${missedEq})`), { dead: true });   // zone non touchée + prix déjà à 15 pts ($15 sur l'or) = plus jamais prise
  if (buy ? px <= entry : px >= entry) return mk('le prix est déjà à l\'entrée : pas d\'ordre limit possible');
  if (Math.abs(px - entry) > (Z.limitMaxApproachAtr || 8) * atrE) return mk(`prix encore trop loin de l'entrée OTE (> ${Z.limitMaxApproachAtr || 8} ATR M${ctx.tf.entry})`, true);
  const buf = Math.max(ctx.dist(1.5), Z.slBufferAtr * aS), minDist = Math.max(ctx.dist(A.minSlEq || 0), (Z.slAtrMin || 0) * atrE);
  const far = buy ? z.lo : z.hi;
  let sl = buy ? far - buf : far + buf;
  if (Math.abs(entry - sl) < minDist) sl = buy ? entry - minDist : entry + minDist;
  if (buy ? sl >= entry : sl <= entry) return mk('SL incohérent avec l\'entrée OTE');
  const risk = Math.abs(entry - sl), slEq = ctx.toEq(risk);
  const capByAtr = Z.slMaxAtr > 0 ? ctx.toEq(Z.slMaxAtr * atrE) : 0;
  const capEq = Math.min(Z.slCapEq > 0 ? Z.slCapEq : Infinity, Math.max(A.slMax != null ? A.slMax : 0, capByAtr) || Infinity);
  if (slEq > capEq) return mk(`SL derrière la zone ${r2(slEq)} pts-or > maximum ${r2(capEq)} : zone trop large`);
  if (ctx.spreadEq && ctx.spreadEq > (Z.maxSpreadSlPct || 1) * slEq) return mk(`spread ${r2(ctx.spreadEq)} pts-or > ${Math.round((Z.maxSpreadSlPct || 1) * 100)} % du SL (${r2(slEq)})`, true);
  const ch = ctx.candles[ctx.tf.htf] || [];
  if (Z.minRoomR > 0 && ch.length > 20) {
    const swH = swings(ch, 2), wall = (buy ? swH.H.filter(x => x.price > entry).sort((p, q) => p.price - q.price) : swH.L.filter(x => x.price < entry).sort((p, q) => q.price - p.price))[0];
    if (wall && Math.abs(wall.price - entry) < Z.minRoomR * risk) return mk(`obstacle M${ctx.tf.htf} à ${r2(ctx.toEq(Math.abs(wall.price - entry)))} pts-or (< ${Z.minRoomR} R)`);
  }
  const BT = ctx.rT ? buildTargets(ctx, entry, risk, d, getLevels(ctx, ch)) : null;
  if (!BT) return mk('TP indisponible (réglage RR)');
  if (!BT.ok) return mk(BT.why);
  const comps = z.parts.map(p => ({ name: p.name, pass: p.pts > 0, detail: p.detail + ` (${p.pts}/${p.max})`, weight: p.max, state: p.pts > 0 ? 'OK' : 'NO' }));
  return { action: z.dir, entry, sl, tp1: BT.tp1, tp2: BT.tp2 || null, tp3: BT.tp3 || null, limit: true, parts: z.parts, expiryBars: Z.limitExpiryBars || 48, slEq: r2(slEq), rrPicked: BT.tp1R, components: comps, score: z.score, maxScore: 100, confidence: z.score, zone: zoneInfo(z),
    reason: `ARES SMC ${z.dir} LIMIT · zone ${z.label} ${r2(z.lo)}-${r2(z.hi)} · ${ote.ok ? 'OTE' : 'entrée 50 %'} ${r2(entry)} · score ${z.score}/100 · SL ${r2(slEq)} pts-or · RR ${BT.tp3R ? BT.tp1R + '/2/3' : BT.tp1R} (${BT.why})` };
}

// ---------------------------------------------------------------------------------------------
// LIQUIDITÉ + CIBLES (RR fixe 2 ou 3, TP sur la liquidité proche non encore touchée)
// ---------------------------------------------------------------------------------------------
const utcDayOf = t => Math.floor(t / 86400000);
/**
 * Niveaux de liquidité NON ENCORE TOUCHÉS (BSL au-dessus du prix, SSL en dessous) :
 * PDH/PDL (veille), range asiatique (00:00-06:00 UTC), sommets/creux M15 (k=3), sommets/creux égaux.
 * ch = bougies M15 fermées. Retourne [{ type, side:'BSL'|'SSL', price, t }]. Un niveau déjà dépassé depuis sa formation est écarté.
 */
function liquidityLevels(ch, ctxAtr) {
  const out = [];
  if (!ch || ch.length < 40) return out;
  const last = ch[ch.length - 1], today = utcDayOf(last.t), a = ctxAtr || atr(ch, 14) || 0;
  const touchedAfter = (price, side, t0) => { for (let i = ch.length - 1; i >= 0 && ch[i].t > t0; i--) if (side === 'BSL' ? ch[i].h > price : ch[i].l < price) return true; return false; };
  const push = (type, side, price, t) => { if (Number.isFinite(price) && !touchedAfter(price, side, t)) out.push({ type, side, price, t }); };
  // veille
  let prevDay = null;
  for (let i = ch.length - 1; i >= 0; i--) { const d = utcDayOf(ch[i].t); if (d < today) { prevDay = d; break; } }
  if (prevDay !== null) {
    const pd = ch.filter(x => utcDayOf(x.t) === prevDay);
    if (pd.length >= 20) { const t0 = pd[pd.length - 1].t; push('PDH', 'BSL', Math.max(...pd.map(x => x.h)), t0); push('PDL', 'SSL', Math.min(...pd.map(x => x.l)), t0); }
  }
  // range asiatique du jour (00:00-06:00 UTC), seulement une fois terminé
  const asia = ch.filter(x => utcDayOf(x.t) === today && (x.t % 86400000) < 6 * 3600000);
  if (asia.length >= 8 && (last.t % 86400000) >= 6 * 3600000) { const t0 = Math.floor(last.t / 86400000) * 86400000 + 6 * 3600000; push('ASH', 'BSL', Math.max(...asia.map(x => x.h)), t0); push('ASL', 'SSL', Math.min(...asia.map(x => x.l)), t0); }
  // sommets / creux M15 (fractale k=3) des ~100 dernières bougies
  const base = Math.max(0, ch.length - 110), sub = ch.slice(base), sw = swings(sub, 3);
  sw.H.forEach(x => push('SWH', 'BSL', x.price, sub[x.i].t));
  sw.L.forEach(x => push('SWL', 'SSL', x.price, sub[x.i].t));
  // sommets / creux égaux (2 swings à moins de 0.1 ATR l'un de l'autre = liquidité de détail)
  const eqTol = 0.1 * a;
  for (let i = 0; i < sw.H.length; i++) for (let j = i + 1; j < sw.H.length; j++) if (Math.abs(sw.H[i].price - sw.H[j].price) <= eqTol) push('EQH', 'BSL', Math.max(sw.H[i].price, sw.H[j].price), sub[sw.H[j].i].t);
  for (let i = 0; i < sw.L.length; i++) for (let j = i + 1; j < sw.L.length; j++) if (Math.abs(sw.L[i].price - sw.L[j].price) <= eqTol) push('EQL', 'SSL', Math.min(sw.L[i].price, sw.L[j].price), sub[sw.L[j].i].t);
  return out;
}
/**
 * TP FINAL = RR fixe 2 ou 3 selon la liquidité non touchée la plus proche devant le trade :
 *  liquidité à >= 3R -> RR 3 · entre 2R et 3R -> RR 2 · à moins de 2R -> trade refusé (le prix se retournera là).
 *  Modes FIXED2 / FIXED3 : RR imposé. Aucune liquidité visible : RR 2 (prudent).
 * Retourne { ok, tp2R, why }.
 */
function pickRR(ctx, entry, risk, d, levels) {
  const rt = ctx.rT || {}, mode = rt.mode || 'AUTO';
  if (mode === 'FIXED2') return { ok: true, tp2R: 2, why: 'RR fixe 2' };
  if (mode === 'FIXED3') return { ok: true, tp2R: 3, why: 'RR fixe 3' };
  const side = d > 0 ? 'BSL' : 'SSL';
  const ahead = (levels || []).filter(l => l.side === side && (d > 0 ? l.price > entry : l.price < entry)).sort((p, q) => Math.abs(p.price - entry) - Math.abs(q.price - entry));
  if (!ahead.length) return { ok: true, tp2R: 2, why: 'aucune liquidité visible devant : RR 2' };
  const nl = ahead[0], R = Math.abs(nl.price - entry) / risk;
  if (R >= 3) return { ok: true, tp2R: 3, why: `liquidité ${nl.type} à ${R.toFixed(1)}R : RR 3`, level: nl };
  if (R >= 2) return { ok: true, tp2R: 2, why: `liquidité ${nl.type} à ${R.toFixed(1)}R : RR 2`, level: nl };
  return { ok: false, why: `liquidité ${nl.type} non touchée à ${R.toFixed(1)}R seulement (< 2R) : TP irréaliste`, level: nl };
}
/** Niveaux de liquidité M15 (mis en cache par dernière bougie M15 via ctx.wadeCache). */
function getLevels(ctx, ch, a15) {
  const k = ch.length ? ch[ch.length - 1].t : 0, c = ctx.wadeCache;
  if (c && c.lvKey === k && c.lv) return c.lv;
  const lv = liquidityLevels(ch, a15 || atr(ch, 14));
  if (c) { c.lvKey = k; c.lv = lv; }
  return lv;
}
/** TP1 = tp1R × R (clôture partielle + BE auto), TP2 = tp2R × R (2 ou 3). */
function buildTargets(ctx, entry, risk, d, levels) {
  const rt = ctx.rT;
  if (!rt || !(rt.tp1R > 0) || !(risk > 0)) return null;
  if (rt.three) {   // SMC : 3 positions — TP1 = RR 1 (puis BE), TP2 = RR 2, TP3 = RR 3 (fixes)
    return { ok: true, tp1: entry + d * risk * (rt.tp1R || 1), tp2: entry + d * risk * 2, tp3: entry + d * risk * 3, tp1R: rt.tp1R || 1, tp2R: 2, tp3R: 3, why: 'RR 1 / 2 / 3' };
  }
  if (rt.single) {   // ARES SMC : TP UNIQUE (RR 2 ou 3 selon la liquidité), pas de TP1 partiel ni de breakeven : SL = -1R, TP = +2R / +3R
    const p = pickRR(ctx, entry, risk, d, levels);
    if (!p.ok) return p;
    return { ok: true, tp1: entry + d * risk * p.tp2R, tp2: null, tp3: null, tp1R: p.tp2R, tp2R: null, why: p.why };
  }
  const tp1 = entry + d * risk * rt.tp1R;
  if (!(rt.tp2R > rt.tp1R)) return { ok: true, tp1, tp2: null, tp3: null, why: 'TP unique' };
  const p = pickRR(ctx, entry, risk, d, levels);
  if (!p.ok) return p;
  return { ok: true, tp1, tp2: entry + d * risk * p.tp2R, tp3: null, tp2R: p.tp2R, why: p.why };
}

// ---------------------------------------------------------------------------------------------
// SETUPS DU PDF « WADE FX » : Turtle Soup · SH + BMS + RTO · SMS + BMS + RTO  (continuation ET contre-tendance)
// Principe du PDF : liquidité prise (SH / Turtle Soup) ou Failure Swing (SMS) -> cassure de structure (BMS) -> retour sur l'Order Block (RTO).
// Confluence : au moins 2 facteurs (HTF, ouverture Londres/New York, combinaison de setups, niveau HTF affiné). Contre-tendance H1 : 3 facteurs minimum.
// Tradé en parallèle des zones clés : le PREMIER setup valide qui arrive est pris.
// ---------------------------------------------------------------------------------------------
const WADE = {
  enabled: true,
  setups: { TS: false, SH_BMS_RTO: true, SMS_BMS_RTO: true },   // Turtle Soup RETIRÉ
  ignoreFactors: ['niveau HTF affiné'],   // confirmations qui ne comptent plus (« niveau HTF affiné » = premium/discount, supprimé)
  lookbackBars: 40,         // la prise de liquidité / le failure swing doit dater de moins de N bougies M5
  sweepMinAtr: 0.1,         // mèche au-delà du niveau >= 0.1 ATR M5 (vrai balayage)
  sweepMaxAtr: 3,           // ... mais pas plus de 3 ATR (sinon c'est une vraie cassure)
  tsMaxBarsAfter: 4,        // Turtle Soup : entrée au plus N bougies après le balayage
  confirmBars: 3,           // RTO : l'OB doit avoir été touché dans les N dernières bougies M5
  confirmBodyMin: 0.4, trigMaxAtr: 2.5,
  minConfluence: 2, minConfluenceCounter: 3, counterTrend: false,   // contre-tendance RETIRÉE
  minScore: 80,
  sessionsUTC: [['07:00', '10:00'], ['12:00', '15:00']],   // ouvertures Londres / New York (PDF : 2-3 premières heures)
  slBufferAtr: 0.2, slAtrMin: 0.8, slMaxAtr: 3, slCapEq: 0, maxSpreadSlPct: 0.1
};
const hhmmOf = t => { const d = new Date(t); return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0'); };

/** dernière bougie opposée au sens `dir` dans [from, to) (bloc d'ordres). */
function obIn(cs, from, to, dir) {
  for (let i = Math.min(to, cs.length) - 1; i >= Math.max(0, from); i--) {
    const c = cs[i];
    if (dir === 'BUY' ? c.c < c.o : c.c > c.o) return { lo: c.l, hi: c.h, bar: i, t: c.t };
  }
  return null;
}

/** Trouve les événements de setup récents pour la direction `dir`. Retourne une liste de { setup, key, ob?, level?, sweep?, bms?, extreme, factors[] } */
function wadeEvents(ctx, W, dir, lv, a5) {
  const ce = ctx.candles[ctx.tf.entry] || [], n = ce.length, buy = dir === 'BUY', evs = [];
  const sw5 = swings(ce, 2), from0 = Math.max(3, n - W.lookbackBars);
  // 1) balayages de liquidité (SH / Turtle Soup) : niveaux = liquidité M15 + sommets/creux M5 antérieurs
  const levels = lv.filter(l => l.side === (buy ? 'SSL' : 'BSL')).map(l => ({ price: l.price, type: l.type, t: l.t }));
  (buy ? sw5.L : sw5.H).filter(x => x.i < n - 3).slice(-6).forEach(x => levels.push({ price: x.price, type: 'M5', t: ce[x.i].t }));
  // les niveaux déjà balayés AVANT la fenêtre sont écartés ; on garde le premier balayage de chaque niveau
  const sweeps = [];
  for (const L of levels) {
    for (let b = from0; b < n; b++) {
      const k = ce[b];
      if (k.t <= L.t) continue;
      const pierce = buy ? L.price - k.l : k.h - L.price;
      if (pierce <= 0) continue;
      // premier dépassement du niveau depuis sa formation ?
      let first = true;
      for (let q = Math.max(0, b - 200); q < b; q++) if (ce[q].t > L.t && (buy ? ce[q].l < L.price : ce[q].h > L.price)) { first = false; break; }
      if (!first) break;
      let back = -1, deep = false;
      for (let q = b; q <= Math.min(n - 1, b + 2); q++) { if (buy ? ce[q].c > L.price : ce[q].c < L.price) { back = q; break; } }
      let ext = buy ? Infinity : -Infinity;
      for (let q = b; q <= (back >= 0 ? back : Math.min(n - 1, b + 2)); q++) ext = buy ? Math.min(ext, ce[q].l) : Math.max(ext, ce[q].h);
      const depth = Math.abs(L.price - ext);
      if (depth > W.sweepMaxAtr * a5) deep = true;
      if (back >= 0 && !deep && depth >= W.sweepMinAtr * a5) sweeps.push({ level: L.price, type: L.type, bar: b, back, extreme: ext, depth });
      break;
    }
  }
  sweeps.sort((p, q) => q.back - p.back);   // le plus récent d'abord
  const htfLiq = s => s.type !== 'M5';
  // 2) Turtle Soup : entrée juste après le balayage
  if (W.setups.TS) for (const s of sweeps) {
    if (n - 1 - s.back <= W.tsMaxBarsAfter) evs.push({ setup: 'TS', key: `TS:${dir}:${ce[s.bar].t}`, sweep: s, extreme: s.extreme, htfLiq: htfLiq(s) });
  }
  // 3) SH + BMS + RTO : balayage -> cassure du dernier swing opposé -> retour sur l'OB
  if (W.setups.SH_BMS_RTO) for (const s of sweeps) {
    const ref = (buy ? sw5.H : sw5.L).filter(x => x.i < s.bar).slice(-1)[0];
    const refPx = ref ? ref.price : (buy ? Math.max(...ce.slice(Math.max(0, s.bar - 8), s.bar).map(x => x.h)) : Math.min(...ce.slice(Math.max(0, s.bar - 8), s.bar).map(x => x.l)));
    let m = -1;
    for (let q = s.back; q < n; q++) if (buy ? ce[q].c > refPx : ce[q].c < refPx) { m = q; break; }
    if (m < 0) continue;
    const ob = obIn(ce, s.bar, m, dir) || obIn(ce, s.bar - 1, m, dir);
    if (!ob) continue;
    evs.push({ setup: 'SH_BMS_RTO', key: `SH:${dir}:${ce[s.bar].t}`, sweep: s, bms: { bar: m, level: refPx }, ob, extreme: buy ? Math.min(ob.lo, s.extreme) : Math.max(ob.hi, s.extreme), htfLiq: htfLiq(s) });
  }
  // 4) SMS + BMS + RTO : Failure Swing (échec à refaire un creux/sommet) -> BMS -> RTO
  if (W.setups.SMS_BMS_RTO) {
    const Ls = sw5.L, Hs = sw5.H;
    if (buy && Ls.length >= 3 && Hs.length >= 1) {
      const L1 = Ls[Ls.length - 2], L2 = Ls[Ls.length - 1], L0 = Ls[Ls.length - 3];
      const mids = Hs.filter(x => x.i > L1.i && x.i < L2.i), Hm = mids.sort((p, q) => q.price - p.price)[0];
      if (L1.price < L0.price && L2.price > L1.price && Hm && L2.i >= from0 - 6) {
        let m = -1; for (let q = L2.i + 1; q < n; q++) if (ce[q].c > Hm.price) { m = q; break; }
        const ob = m >= 0 ? obIn(ce, L2.i, m, 'BUY') : null;
        if (ob) evs.push({ setup: 'SMS_BMS_RTO', key: `SMS:BUY:${ce[L2.i].t}`, bms: { bar: m, level: Hm.price }, ob, extreme: Math.min(ob.lo, L2.price), htfLiq: false, failure: true });
      }
    }
    if (!buy && Hs.length >= 3 && Ls.length >= 1) {
      const H1 = Hs[Hs.length - 2], H2 = Hs[Hs.length - 1], H0 = Hs[Hs.length - 3];
      const mids = Ls.filter(x => x.i > H1.i && x.i < H2.i), Lm = mids.sort((p, q) => p.price - q.price)[0];
      if (H1.price > H0.price && H2.price < H1.price && Lm && H2.i >= from0 - 6) {
        let m = -1; for (let q = H2.i + 1; q < n; q++) if (ce[q].c < Lm.price) { m = q; break; }
        const ob = m >= 0 ? obIn(ce, H2.i, m, 'SELL') : null;
        if (ob) evs.push({ setup: 'SMS_BMS_RTO', key: `SMS:SELL:${ce[H2.i].t}`, bms: { bar: m, level: Lm.price }, ob, extreme: Math.max(ob.hi, H2.price), htfLiq: false, failure: true });
      }
    }
  }
  return evs;
}

/**
 * Évalue les setups du PDF sur la dernière bougie M5 fermée. Même format de sortie que evaluateZone.
 * `ctx.wadeUsed` (objet) : clés déjà tradées (jamais deux fois le même setup).
 */
function evaluateWade(ctx) {
  return { action: 'WAIT', wait: 'stratégie PDF supprimée', components: [], score: 0 };   // SUPPRIMÉE : SMC tsotra (zones OB) uniquement
}
function evaluateWadeOLD(ctx) {
  const W = Object.assign({}, WADE, ctx.wadeCfg || {}); W.setups = Object.assign({}, WADE.setups, (ctx.wadeCfg || {}).setups || {});
  W.setups.TS = false; W.counterTrend = false;   // règles FIXES : ni Turtle Soup ni contre-tendance, quelle que soit la config sauvegardée
  const mk = (why, pending) => ({ action: 'WAIT', wait: why, pending: !!pending, confidence: 0, score: 0, maxScore: 100, components: [] });
  if (!W.enabled) return mk('setups PDF désactivés');
  const A = ctx.limits || {}, price = ctx.price, ce = ctx.candles[ctx.tf.entry] || [], ch = ctx.candles[ctx.tf.htf] || [], n = ce.length;
  if (n < 60 || ch.length < 60) return mk(`DATA_UNAVAILABLE: bougies M${ctx.tf.entry}/M${ctx.tf.htf} insuffisantes (${n}/${ch.length})`);
  if (!price || !price.mid) return mk('DATA_UNAVAILABLE: prix indisponible');
  if (A.maxSpreadEq != null && ctx.spreadEq > A.maxSpreadEq) return mk(`spread ${r2(ctx.spreadEq)} > ${A.maxSpreadEq} (pts-or)`, true);
  const a5 = atr(ce, 14), a15 = atr(ch, 14);
  if (!a5 || !a15) return mk('DATA_UNAVAILABLE: ATR');
  const atrEq = ctx.toEq(a5);
  if (A.minAtrEq != null && atrEq < A.minAtrEq) return mk(`marché trop calme (ATR ${r2(atrEq)} pts-or)`, true);
  if (A.maxAtrEq != null && atrEq > A.maxAtrEq) return mk(`marché trop violent (ATR ${r2(atrEq)} pts-or)`, true);
  const lv = getLevels(ctx, ch, a15);
  const swH = swings(ch, 2), biasH = biasOf(swH), h1 = h1Trend(ch), pdM = premiumDiscount(swH, 0), eqM = pdM ? pdM.eq : null;
  const k1 = ce[n - 1], k0 = ce[n - 2], rng = Math.max(k1.h - k1.l, 1e-9), body = Math.abs(k1.c - k1.o) / rng, used = ctx.wadeUsed || {};
  const inSess = (W.sessionsUTC || []).some(w => hhmmOf(k1.t) >= w[0] && hhmmOf(k1.t) < w[1]);
  let best = null, lastWhy = 'aucun setup du PDF (Turtle Soup / SH+BMS+RTO / SMS+BMS+RTO) en formation';
  for (const dir of ['BUY', 'SELL']) {
    const buy = dir === 'BUY', d = buy ? 1 : -1;
    const evs = wadeEvents(ctx, W, dir, lv, a5);
    for (const ev of evs) {
      if (used[ev.key]) continue;
      // direction du marché : H1 (EMA20/50 construites sur M15) ; contre-tendance = H1 opposé
      const counter = h1 !== null && h1 !== dir, withTrend = h1 === dir;
      if (counter && !W.counterTrend) { lastWhy = `${ev.setup} ${dir} contre la tendance H1 (contre-tendance désactivée)`; continue; }
      const entry = buy ? (price.ask || price.mid) : (price.bid || price.mid);
      // ----- déclenchement selon le setup -----
      let ok = false, ob = ev.ob || null, why = '';
      if (ev.setup === 'TS') {
        const lvl = ev.sweep.level, dirOk = buy ? (k1.c > k1.o && k1.c > lvl) : (k1.c < k1.o && k1.c < lvl);
        ok = dirOk && body >= W.confirmBodyMin && rng <= W.trigMaxAtr * a5;
        if (!ok) { lastWhy = `Turtle Soup ${dir} : en attente d'une bougie de confirmation M${ctx.tf.entry} après le balayage de ${ev.sweep.type}`; continue; }
      } else {
        // RTO : retour dans l'OB (touché dans les confirmBars dernières bougies), OB non violé, bougie de rejet
        const tol = 0.05 * a5; let touched = false, brokeOb = false;
        for (let q = Math.max(ev.bms.bar + 1, n - W.confirmBars); q < n; q++) {
          const c = ce[q]; if (buy ? c.c < ob.lo - tol : c.c > ob.hi + tol) brokeOb = true;
          if (buy ? c.l <= ob.hi + tol : c.h >= ob.lo - tol) touched = true;
        }
        for (let q = ev.bms.bar + 1; q < n - W.confirmBars && !brokeOb; q++) if (buy ? ce[q].c < ob.lo - tol : ce[q].c > ob.hi + tol) brokeOb = true;
        if (brokeOb) { lastWhy = `${ev.setup} ${dir} : OB violé`; continue; }
        if (n - 1 <= ev.bms.bar) { lastWhy = `${ev.setup} ${dir} : BMS vient de se former, attente du retour (RTO)`; continue; }
        if (!touched) { lastWhy = `${ev.setup} ${dir} : BMS fait, en attente du retour (RTO) sur l'OB ${r2(ob.lo)}-${r2(ob.hi)}`; continue; }
        const mid = (ob.lo + ob.hi) / 2, wick = buy ? (Math.min(k1.o, k1.c) - k1.l) / rng : (k1.h - Math.max(k1.o, k1.c)) / rng;
        const sideOk = buy ? (k1.c > k1.o && k1.c >= mid) : (k1.c < k1.o && k1.c <= mid), brk = buy ? k1.c > k0.h : k1.c < k0.l;
        ok = sideOk && body >= W.confirmBodyMin && (brk || wick >= 0.4) && rng <= W.trigMaxAtr * a5;
        if (!ok) { lastWhy = `${ev.setup} ${dir} : OB touché, en attente d'une bougie de rejet`; continue; }
      }
      // ----- confluence (PDF : au moins 2 facteurs ; 3 contre la tendance H1) -----
      const factors = [];
      const htfAligned = buy ? biasH === 'BULL' : biasH === 'BEAR';
      if (withTrend || htfAligned) factors.push('analyse HTF alignée (H1 / biais M15)');
      if (ev.htfLiq) factors.push(`liquidité HTF prise (${ev.sweep.type})`);
      if (inSess) factors.push('ouverture Londres / New York');
      if ((ev.setup !== 'TS' && ev.sweep) || (ev.setup === 'SMS_BMS_RTO' && lv.length)) factors.push('setups combinés' + (ev.sweep ? ' (sweep + BMS + RTO)' : ' (failure swing + BMS + RTO)'));
      const refPx = ob ? (ob.lo + ob.hi) / 2 : ev.sweep.level;
      if (eqM !== null && (buy ? refPx < eqM : refPx > eqM)) factors.push(`niveau HTF affiné (${buy ? 'discount' : 'premium'} M${ctx.tf.htf})`);
      if (W.ignoreFactors && W.ignoreFactors.length) for (let q = factors.length - 1; q >= 0; q--) if (W.ignoreFactors.some(n => factors[q].startsWith(n))) factors.splice(q, 1);
      const need = counter ? W.minConfluenceCounter : W.minConfluence;
      if (factors.length < need) { lastWhy = `${ev.setup} ${dir} : confluence ${factors.length}/${need} (${counter ? 'contre-tendance H1' : 'avec la tendance'})`; continue; }
      // ----- SL derrière l'OB / la mèche du balayage -----
      const buf = Math.max(ctx.dist(1.5), W.slBufferAtr * a5), minDist = Math.max(ctx.dist(A.minSlEq || 0), W.slAtrMin * a5);
      const recent = ce.slice(-3), recExt = buy ? Math.min(...recent.map(x => x.l)) : Math.max(...recent.map(x => x.h));
      const far = buy ? Math.min(ev.extreme, recExt) : Math.max(ev.extreme, recExt);
      let sl = buy ? far - buf : far + buf;
      if (Math.abs(entry - sl) < minDist) sl = buy ? entry - minDist : entry + minDist;
      if (buy ? sl >= entry : sl <= entry) { lastWhy = `${ev.setup} ${dir} : prix déjà au-delà du SL`; continue; }
      const risk = Math.abs(entry - sl), slEq = ctx.toEq(risk);
      const capEq = Math.min(W.slCapEq > 0 ? W.slCapEq : Infinity, Math.max(A.slMax != null ? A.slMax : 0, W.slMaxAtr > 0 ? ctx.toEq(W.slMaxAtr * a5) : 0) || Infinity);
      if (slEq > capEq) { lastWhy = `${ev.setup} ${dir} : SL ${r2(slEq)} pts-or > maximum ${r2(capEq)}`; continue; }
      if (ctx.spreadEq && ctx.spreadEq > W.maxSpreadSlPct * slEq) { lastWhy = `${ev.setup} ${dir} : spread > ${Math.round(W.maxSpreadSlPct * 100)} % du SL`; continue; }
      // ----- cibles : TP1 1R (+BE auto) · TP2 sur la liquidité proche non touchée (RR 2 ou 3) -----
      const T = buildTargets(ctx, entry, risk, d, lv);
      if (!T) { lastWhy = 'cibles en R indisponibles'; continue; }
      if (!T.ok) { lastWhy = `${ev.setup} ${dir} : ${T.why}`; continue; }
      const score = Math.min(100, 46 + 12 * factors.length + (ev.setup !== 'TS' ? 6 : 0) + (body >= 0.6 ? 4 : 0));
      if (score < W.minScore) { lastWhy = `${ev.setup} ${dir} : score ${score} < ${W.minScore}`; continue; }
      const name = ev.setup === 'TS' ? 'Turtle Soup' : ev.setup === 'SH_BMS_RTO' ? 'SH + BMS + RTO' : 'SMS + BMS + RTO';
      const comps = factors.map(f => ({ name: f, pass: true, detail: 'confluence PDF', weight: 0, state: 'OK' }));
      comps.unshift({ name: name + (counter ? ' · CONTRE-TENDANCE' : ' · avec la tendance'), pass: true, detail: ev.sweep ? `balayage ${ev.sweep.type} ${r2(ev.sweep.level)}` : `failure swing · BMS ${r2(ev.bms.level)}`, weight: 0, state: 'OK' });
      const cand = { action: dir, entry, sl, tp1: T.tp1, tp2: T.tp2, tp3: null, slEq: r2(slEq), components: comps, score, maxScore: 100, confidence: score, setup: ev.setup, wadeKey: ev.key, counter,
        zone: { id: 'W:' + ev.key, tf: 'M' + ctx.tf.entry, dir, type: ev.setup, lo: ob ? ob.lo : ev.sweep.level, hi: ob ? ob.hi : ev.sweep.level, score },
        reason: `${ctx.mode} ${dir} · ${name}${counter ? ' (contre-tendance H1)' : ''} · ${factors.join(' + ')} · SL ${r2(slEq)} pts-or · TP1 ${ctx.rT.tp1R}R${T.tp2 ? ' / TP2 ' + T.tp2R + 'R (' + T.why + ')' : ''} · score ${score}/100` };
      if (!best || cand.score > best.score) best = cand;
    }
  }
  return best || mk(lastWhy, true);
}

/**
 * @param ctx { mode, tf:{entry,structure,htf}, candles:{[min]:[bars fermées]}, price:{bid,ask,mid}, spreadEq, atrEq,
 *              dist:(goldEqPts)=>prixUnits, toEq:(prixUnits)=>goldEqPts, limits:{slMax,minAtrEq,maxAtrEq,maxSpreadEq},
 *              targets:{tp1,tp2,tp3}, orderFlow:{status,delta,cvd,...}, cfg }
 * @returns { action:'BUY'|'SELL'|'WAIT', wait?, confidence, score, maxScore, components[], entry, sl, tp1, tp2, tp3, reason }
 */
function evaluate(ctx) {
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
  const d = dir === 'BUY' ? 1 : -1, T = ctx.targets || {};
  const tp = g => (g ? entry + d * ctx.dist(g) : null);
  const names = comps.filter(c => c.pass).map(c => c.name).join(' + ');
  return Object.assign({ action: dir, entry, sl, tp1: tp(T.tp1), tp2: tp(T.tp2), tp3: tp(T.tp3), slEq: r2(slEq),
    reason: `${ctx.mode} ${dir} · confluence ${names} · score ${score}/${maxScore} (${confidence}%) · SL ${r2(slEq)} pts-or · ATR ${r2(atrEq)}` }, base);
}


// =====================================================================================================================
// SMC « BOS → OB → confirmation LTF » (or uniquement). Module A : zone M15 → confirmation/entrée M5. Module B : zone M5 → confirmation/entrée LTF (M1/M2/M3).
// Fonctions PURES (mêmes règles en backtest et en live). Prix en $ (XAUUSD : 1 pip = 0.10 $ → 50 pips = 5 $, 100 pips = 10 $).
// =====================================================================================================================
const SMC = { k: 2, lookback: 140, tp1MinUsd: 5, setupMinUsd: 10, rrMin: 2, tp1Fixed: true, bosMinA: 3, bosMinB: 2, confirmMinUsd: 1, missedUsd: 15, slBufAtr: 0.15, slBufMinUsd: 0.2, slMaxAtr: 8, limitMaxMin: 60, confirmMaxBars: 60, ltfWindow: 220, ltf: 1 };

/** Sommets / creux confirmés par k bougies de chaque côté : [{i, p, t}]. */
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
/** M1 → M2/M3… (alignées sur l'horloge). La dernière bougie incomplète est retirée. */
function aggN(c1, n) {
  if (!c1 || n <= 1) return c1 || [];
  const ms = n * 60000, out = []; let cur = null;
  for (const b of c1) {
    const t0 = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== t0) { if (cur) out.push(cur); cur = { t: t0, o: b.o, h: b.h, l: b.l, c: b.c }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
  }
  if (cur) out.push(cur);
  const lastIn = c1[c1.length - 1];
  if (out.length && lastIn && out[out.length - 1].t + ms > lastIn.t + 60000) out.pop();
  return out;
}
const mirrorC = c => c.map(b => ({ t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c }));

/** ÉTAPE HTF (ACHAT ; la vente = même logique sur bougies inversées) : BOS + zones OB + zones déjà invalides / touchées côté HTF. Ne dépend que des bougies HTF fermées → mise en cache. */
function smcHtfStage(H, o) {
  const k = o.k, n = H.length, zones = [], bosMin = o.module === 'A' ? o.bosMinA : o.bosMinB;   // BOS = CLÔTURE au-delà du HIGH + marge mini (A : 3 $ = 30 pips · B : 2 $ = 20 pips) : les mèches ne comptent pas
  if (n < 30) return { zones, n, atrH: 1, swH: { H: [], L: [] }, high: null };
  const swH = swK(H, k), atrH = atr(H, 14) || 1;
  const events = []; let ph = 0, cur = null, broken = false;
  for (let b = k + 1; b < n; b++) {   // BOS = clôture au-dessus du dernier sommet (HIGH) confirmé, une seule fois par sommet
    while (ph < swH.H.length && swH.H[ph].i + k < b) { cur = swH.H[ph]; broken = false; ph++; }
    if (cur && !broken && H[b].c > cur.p + bosMin) { events.push({ b, hi: cur }); broken = true; }
  }
  const seen = new Set();
  for (const ev of events.slice().reverse()) {
    const b = ev.b; if (b < n - o.lookback) continue;
    let s0 = ev.hi.i; for (let j = ev.hi.i; j <= b; j++) if (H[j].l < H[s0].l) s0 = j;   // creux du retour avant la cassure
    const cand = [];
    for (let j = b - 1; j >= Math.max(s0 - 1, 0); j--) if (H[j].c < H[j].o) { cand.push(j); break; }   // dernier OB avant la cassure
    let oj = -1; for (let j = Math.min(s0 + 2, b - 1); j >= Math.max(s0 - 2, 0); j--) if (H[j].c < H[j].o && (oj < 0 || H[j].l < H[oj].l)) oj = j;   // OB à l'origine du mouvement
    if (oj >= 0 && !cand.includes(oj)) cand.push(oj);
    for (const j of cand) {
      const z = { lo: H[j].l, hi: Math.max(H[j].o, H[j].c), t: H[j].t, bosT: H[b].t, bosLevel: ev.hi.p, tf: o.htfName };
      if (!(z.hi > z.lo)) continue;
      const id = `${o.module}:BUY:${z.t}`; if (seen.has(id)) continue; seen.add(id);
      let bad = false; for (let q = b + 1; q < n; q++) if (H[q].c < z.lo) { bad = true; break; }   // zone invalide : clôture HTF sous la zone
      let touchT = null; if (!bad) for (let q = b + 1; q < n; q++) if (H[q].l <= z.hi) { touchT = H[q].t; break; }   // le prix revient dans la zone APRÈS la cassure
      zones.push({ id, z, b, bad, touchT });
    }
  }
  return { zones, n, atrH, swH, high: cur ? cur.p : null };
}
/** ÉTAPE LTF (ACHAT) : touche, confirmation (BOS LTF), OB LTF, entrée / SL / TP. */
function smcBuyLtf(st, H, L, price, o) {
  const k = o.k, n = st.n, atrH = st.atrH, now = o.now, out = [];
  const atrL = atr(L, 14) || (atrH / 3);
  const need = Math.ceil((o.limitMaxMin + 10) * 60000 / o.ltfMs) + o.confirmMaxBars + 5;
  const w0 = Math.max(0, L.length - need), W = L.slice(w0), sw = swK(W, k), livePx = price && price.mid;
  for (const zd of st.zones) {
    const z = zd.z;
    const S = { id: zd.id, module: o.module, ltfName: o.ltfName, dir: 'BUY', state: 'ZONE', zone: z, wait: 'en attente : le prix doit revenir dans la zone', dead: false };
    out.push(S);
    if (zd.bad) { S.state = 'DEAD'; S.dead = true; S.wait = 'zone invalide (clôture sous la zone)'; continue; }
    let touchT = zd.touchT, q0 = -1;
    if (touchT !== null) { for (let q = 0; q < L.length; q++) if (L[q].t >= touchT && L[q].l <= z.hi) { q0 = q; break; } if (q0 < 0 && L.length && L[0].t > touchT) q0 = 0; }
    if (touchT === null && livePx != null && livePx <= z.hi) { touchT = now; q0 = L.length; }
    if (touchT === null) {
      if (livePx != null && livePx - z.hi >= o.missedUsd) { S.state = 'DEAD'; S.dead = true; S.wait = `zone manquée : le prix est à ${(livePx - z.hi).toFixed(1)} $ de la zone sans l'avoir touchée (≥ ${o.missedUsd} $)`; }
      continue;
    }
    S.state = 'TOUCHED'; S.touchT = touchT; S.wait = 'zone touchée · en attente confirmation BUY (cassure du dernier HIGH en ' + o.ltfName + ')';
    if (q0 < 0 || q0 >= L.length) continue;
    const start = Math.max(q0, w0) - w0;
    let lowIdx = -1, conf = -1, refHigh = null;
    for (let q = start; q < W.length; q++) {   // creux du retour dans la zone, puis clôture au-dessus du dernier HIGH LTF
      if (lowIdx < 0 || W[q].l < W[lowIdx].l) lowIdx = q;
      let pick = null; for (let a = sw.H.length - 1; a >= 0; a--) { const sh = sw.H[a]; if (sh.i < lowIdx && sh.i + k < q) { pick = sh; break; } }
      if (pick && q > lowIdx && W[q].c > pick.p + o.confirmMinUsd && q - lowIdx <= o.confirmMaxBars && W[lowIdx].l <= z.hi) { conf = q; refHigh = pick; break; }
    }
    if (conf < 0) continue;
    let ob = -1; for (let j = Math.max(0, lowIdx - 2); j <= Math.min(conf - 1, lowIdx + 2); j++) if (W[j].c < W[j].o && (ob < 0 || W[j].l < W[ob].l)) ob = j;   // OB LTF
    if (ob < 0) ob = lowIdx;
    const obLo = W[ob].l, obHi = Math.max(W[ob].o, W[ob].c), entry = (obLo + obHi) / 2;
    const buf = Math.max(o.slBufAtr * atrL, o.slBufMinUsd), sl = W[lowIdx].l - buf, risk = entry - sl;
    S.confirm = { t: W[conf].t + o.ltfMs, lowT: W[lowIdx].t, refHigh: refHigh.p, ob: { lo: obLo, hi: obHi, t: W[ob].t } };
    if (!(risk > 0)) { S.wait = 'SL incohérent'; continue; }
    if (risk > o.slMaxAtr * atrH) { S.state = 'DEAD'; S.dead = true; S.wait = `SL trop large (${risk.toFixed(1)} $)`; continue; }
    if (now - S.confirm.t > o.limitMaxMin * 60000) { S.state = 'DEAD'; S.dead = true; S.wait = 'confirmation trop ancienne'; continue; }
    let slHit = false; for (let q = conf + 1; q < W.length; q++) if (W[q].l <= sl) { slHit = true; break; }
    if (slHit) { S.state = 'DEAD'; S.dead = true; S.wait = 'SL touché avant l\'entrée'; continue; }
    // TP = liquidité (sommets HTF au-dessus de l'entrée) : TP1 >= tp1MinUsd ; setup >= setupMinUsd ; 2 liquidités → TP1 + TP2 (BE après TP1)
    const lv = [z.bosLevel].concat(st.swH.H.filter(x => x.i >= n - 240).map(x => x.p)).filter(p => p > entry).sort((x, y) => x - y);
    const lev = []; for (const p of lv) if (!lev.length || p - lev[lev.length - 1] > 0.5) lev.push(p);
    // TP1 >= tp1MinUsd (50 pips) ; objectif FINAL = 1re liquidité >= max(setupMinUsd = 100 pips, rrMin × SL) ; plusieurs liquidités → TP1 + TP2 (BE après TP1) ; aucune liquidité avant l'objectif → TP1 fixe à 50 pips (option tp1Fixed)
    const need = Math.max(o.setupMinUsd, (o.rrMin || 0) * risk);
    const c5 = lev.filter(p => p - entry >= o.tp1MinUsd);
    const fin = c5.find(p => p - entry >= need - 1e-9);
    if (fin === undefined) { S.wait = `confirmé mais aucune liquidité ≥ ${need.toFixed(1)} $ (100 pips et RR ≥ ${o.rrMin}) au-dessus de l'entrée`; continue; }
    const mids = c5.filter(p => p < fin - 0.5), beyond = c5.find(p => p > fin + 0.5);
    let tp1, tp2 = null;
    if (mids.length) { tp1 = mids[0]; tp2 = fin; }
    else if (beyond !== undefined) { tp1 = fin; tp2 = beyond; }
    else if (o.tp1Fixed && fin - entry >= 2 * o.tp1MinUsd) { tp1 = entry + o.tp1MinUsd; tp2 = fin; }
    else tp1 = fin;
    const r1 = (tp1 - entry) / risk, r2 = tp2 !== null ? (tp2 - entry) / risk : null;
    Object.assign(S, { state: 'CONFIRMED', wait: 'confirmation BUY faite : entrée dans l\'OB LTF', entry, sl, tp1, tp2, risk, r1, r2, rrTotal: tp2 !== null ? (r1 + r2) / 2 : r1, rrFinal: tp2 !== null ? r2 : r1, single: tp2 === null });
  }
  return out;
}

/** Évaluation d'un module. ctx = { module, htf: [bougies HTF fermées], ltf: [bougies LTF fermées], htfMs, ltfMs, htfName, ltfName, price: {mid}, now, cfg, cache? } */
function smcEval(ctx) {
  const o = Object.assign({}, SMC, ctx.cfg || {}, { module: ctx.module, htfMs: ctx.htfMs, ltfMs: ctx.ltfMs, htfName: ctx.htfName, ltfName: ctx.ltfName, now: ctx.now });
  const H = ctx.htf || [], L = ctx.ltf || [];
  if (H.length < 30 || L.length < 20) return { setups: [], wait: 'bougies insuffisantes', high: null, low: null };
  const store = ctx.cache || {}, key = H[H.length - 1].t + ':' + H.length + ':' + o.module + ':' + o.k + ':' + o.lookback + ':' + o.bosMinA + ':' + o.bosMinB;
  if (store.key !== key) { store.key = key; store.buy = smcHtfStage(H, o); store.sell = smcHtfStage(mirrorC(H), o); }
  const keep = Math.ceil((o.limitMaxMin + 10) * 60000 / o.ltfMs) + o.confirmMaxBars + 5, Lw = L.slice(-Math.max(keep + 10, 40));
  const buy = smcBuyLtf(store.buy, H, Lw, ctx.price, o);
  const pm = ctx.price ? { mid: -ctx.price.mid } : null;
  const sellRaw = smcBuyLtf(store.sell, H, mirrorC(Lw), pm, o);
  const flip = S0 => {   // remet les prix dans le bon sens pour la VENTE
    const S = Object.assign({}, S0, { dir: 'SELL', id: S0.id.replace(':BUY:', ':SELL:') });
    S.zone = Object.assign({}, S0.zone, { lo: -S0.zone.hi, hi: -S0.zone.lo, bosLevel: -S0.zone.bosLevel });
    if (S0.confirm) S.confirm = Object.assign({}, S0.confirm, { refHigh: -S0.confirm.refHigh, ob: { lo: -S0.confirm.ob.hi, hi: -S0.confirm.ob.lo, t: S0.confirm.ob.t } });
    ['entry', 'sl', 'tp1', 'tp2'].forEach(f => { if (S0[f] != null) S[f] = -S0[f]; });
    S.wait = String(S0.wait).replace(/BUY/g, 'SELL').replace(/HIGH/g, 'LOW');
    return S;
  };
  return { setups: buy.concat(sellRaw.map(flip)), wait: null, high: store.buy.high, low: store.sell.high != null ? -store.sell.high : null };
}

module.exports = { SMC, swK, aggN, smcEval, aggregate, h1Trend, evaluate, evaluateWade, liquidityLevels, pickRR, buildTargets, WADE, keyZones, zoneState, zoneArmed, evaluateZone, zoneLimit, oteOf, goldSmc, GOLD, DEFAULT_ANALYSIS, ZONES, ZONE_PROFILES, _t: { emaSeries, rsiLast, swings, biasOf, lastBreak, sweep, fvgs, orderBlock, premiumDiscount, atr } };
