'use strict';
/**
 * PV : Phantom Liquidity + Volume Reversal Zones (+ structure Instit) — module PUR (aucune dépendance).
 * Même logique que l'indicateur TradingView « Ares Phantom VRZ [Zone Entry] », portée en JS :
 *   - zones Phantom (OB confirmé par FVG, score /8) + zones VRZ (pic de volume sur swing, score /5), sur M5 / M15 / M30 / H1 ;
 *   - candidats : zone Phantom (★ confluence si une zone VRZ la chevauche) ; entrée limit, SL 5-10 $, TP1/TP2/TP3 = RR 1/2/3 ;
 *   - sélection : probabilité (calibrée sur l'historique), pas de sens opposé, espace libre jusqu'à TP2 ;
 *   - backtest : un seul passage M5 + M15, résultats séparés par TF + résultat « robot » (probabilité + verrou de sens).
 * Prix en unités de prix (XAUUSD : 1 = 1 $). Bougies : { t (ms, ouverture), o, h, l, c, v }.
 * Aucun gain garanti : le backtest sert à vérifier, pas à promettre.
 */
const DEFAULT_PV = {
  enabled: true,
  tfs: [5, 15, 30, 60],
  // --- Phantom : détection OB + FVG ---
  atrLen: 14, swLen: 5, fvgMin: 0.10, impMin: 0.50, obMin: 0.30, obMax: 3.0, obLook: 5, zoneMode: 'FULL',   // zoneMode : 'FULL' (mèche complète) | 'BODY'
  // --- Phantom : score /8 ---
  fvgStrong: 0.35, impStrong: 1.0, volStrong: 1.5, volLen: 20, instThr: 2.0, breakWin: 3, sweepWin: 20,
  sessFrom: 7, sessTo: 21, minScore: 5, gradeA: 7, gradeB: 5, maxAge: 300,
  // --- VRZ ---
  pivLen: 5, volMult: 1.8, extMult: 3.0, wickPct: 40, exhATR: 2.0, exhBars: 10, reactATR: 1.0, vhMin: 0.25, vhMax: 1.0, minVRZ: 3, confTol: 0.5,
  // --- plan d'ordre (prix) ---
  entryMode: 'MID', slBuf: 0.15, slMin: 5, slMax: 10, rr1: 1, rr2: 2, rr3: 3, maxDist: 6, beAfterTp1: true,
  // --- robot : qualité / probabilité ---
  needConf: false,        // exiger la confluence Phantom + VRZ
  minN: 30,               // échantillon minimum pour faire confiance à une probabilité
  minEV: 0.15,            // espérance minimale (R par trade) pour prendre un setup calibré
  minRoomR: 2,            // espace libre minimum (en R) avant la zone opposée la plus proche (TP2)
  limitExpiryBars: 48,    // ordre limit annulé après N bougies M5
  spreadX: 4              // TP1 doit valoir au moins N x le spread
};
const TFN = { 5: 'M5', 15: 'M15', 30: 'M30', 60: 'H1' };
const r2 = x => Math.round(x * 100) / 100;

/** Agrège des bougies (volume = somme). La dernière bougie incomplète est retirée. */
function aggBars(c, mins, baseMin) {
  if (!c || !c.length) return [];
  const ms = mins * 60000, out = []; let cur = null;
  for (const b of c) {
    const t0 = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== t0) { if (cur) out.push(cur); cur = { t: t0, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }; }
    else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v || 0; }
  }
  if (cur) out.push(cur);
  const last = c[c.length - 1];
  if (out.length && out[out.length - 1].t + ms > last.t + baseMin * 60000) out.pop();
  return out;
}

/** Moteur de zones pour UN timeframe : push(bougie fermée) puis zones(). Logique identique à f_engine du Pine. */
function createZoneEngine(tfMin, P) {
  const bars = [], volWin = [];
  let bi = -1, atr = null;
  let lastHi = null, lastLo = null, trd = 0, lastBullBrk = -1e9, lastBearBrk = -1e9, lastSwpHi = -1e9, lastSwpLo = -1e9;
  const Z = { pb: null, ps: null, vb: null, vs: null };
  const B = k => bars[bars.length - 1 - k];
  const pivotHigh = len => { if (bars.length < 2 * len + 1) return null; const v = B(len).h; for (let j = 1; j <= len; j++) { if (B(len + j).h >= v) return null; if (B(len - j).h > v) return null; } return v; };
  const pivotLow = len => { if (bars.length < 2 * len + 1) return null; const v = B(len).l; for (let j = 1; j <= len; j++) { if (B(len + j).l <= v) return null; if (B(len - j).l < v) return null; } return v; };
  const hourOf = t => new Date(t).getUTCHours();

  function push(raw) {
    const b = { t: raw.t, o: raw.o, h: raw.h, l: raw.l, c: raw.c, v: Number(raw.v) > 0 ? Number(raw.v) : 0 };
    const prev = bars[bars.length - 1];
    const tr = prev ? Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c)) : b.h - b.l;
    atr = atr == null ? tr : (atr * (P.atrLen - 1) + tr) / P.atrLen;
    bi++;
    b.atr = bi >= P.atrLen ? atr : null;
    volWin.push(b.v); if (volWin.length > P.volLen) volWin.shift();
    b.vavg = volWin.length >= P.volLen ? volWin.reduce((s, x) => s + x, 0) / volWin.length : null;
    bars.push(b); if (bars.length > 160) bars.shift();
    const a = b.atr;
    const C = b, Bb = B(1), A = B(2);

    // ----- structure : pivots, sweeps, cassures -----
    const pH = pivotHigh(P.swLen), pL = pivotLow(P.swLen);
    if (pH != null) lastHi = pH;
    if (pL != null) lastLo = pL;
    if (lastLo != null && C.l < lastLo && C.c > lastLo) lastSwpLo = bi;
    if (lastHi != null && C.h > lastHi && C.c < lastHi) lastSwpHi = bi;
    if (lastHi != null && C.c > lastHi) { trd = 1; lastBullBrk = bi; lastHi = null; }
    else if (lastLo != null && C.c < lastLo) { trd = -1; lastBearBrk = bi; lastLo = null; }

    // ----- invalidation / expiration -----
    if (Z.pb && (C.c < Z.pb.bot || bi - Z.pb.bornI > P.maxAge)) Z.pb = null;
    if (Z.ps && (C.c > Z.ps.top || bi - Z.ps.bornI > P.maxAge)) Z.ps = null;
    if (Z.vb && (C.c < Z.vb.bot || bi - Z.vb.bornI > P.maxAge)) Z.vb = null;
    if (Z.vs && (C.c > Z.vs.top || bi - Z.vs.bornI > P.maxAge)) Z.vs = null;
    if (!(a > 0) || !A) return;

    // ----- Phantom : dernière bougie de couleur opposée avant A -----
    let offB = -1, offR = -1;
    for (let k = 2; k <= 2 + P.obLook; k++) { const x = B(k); if (!x) break; if (x.c < x.o && offB < 0) offB = k; if (x.c > x.o && offR < 0) offR = k; }
    const sess = hourOf(Bb.t) >= P.sessFrom && hourOf(Bb.t) < P.sessTo ? 1 : 0;
    const vaOf = k => { const x = B(k); return x && x.vavg != null ? x.vavg : 0; };

    if (C.l > A.h && Bb.c > Bb.o && offB >= 2) {   // demand : FVG haussier (A = [2], B = [1], C = [0])
      const ob = B(offB), gap = C.l - A.h, body = Bb.c - Bb.o, obH = ob.h - ob.l;
      if (gap >= P.fvgMin * a && body >= P.impMin * a && obH >= P.obMin * a && obH <= P.obMax * a) {
        const top = P.zoneMode === 'BODY' ? Math.max(ob.o, ob.c) : ob.h, bot = P.zoneMode === 'BODY' ? Math.min(ob.o, ob.c) : ob.l;
        let valid = true; for (let k = 0; k < offB; k++) if (B(k).c < bot) valid = false;
        if (valid) {
          const va2 = vaOf(2), vaOb = vaOf(offB + 1), inst = vaOb > 0 && ob.v >= P.instThr * vaOb;
          let s = 0;
          s += gap >= P.fvgStrong * a ? 1 : 0; s += body >= P.impStrong * a ? 1 : 0;
          s += va2 > 0 && Bb.v >= P.volStrong * va2 ? 1 : 0; s += inst ? 1 : 0;
          s += bi - lastBullBrk <= P.breakWin ? 1 : 0; s += bi - lastSwpLo <= P.sweepWin ? 1 : 0; s += trd === 1 ? 1 : 0; s += sess;
          if (s >= P.minScore) Z.pb = { dir: 'BUY', kind: 'PH', top, bot, score: s, inst, bornT: ob.t, bornI: bi };
        }
      }
    }
    if (C.h < A.l && Bb.c < Bb.o && offR >= 2) {   // supply : FVG baissier
      const ob = B(offR), gap = A.l - C.h, body = Bb.o - Bb.c, obH = ob.h - ob.l;
      if (gap >= P.fvgMin * a && body >= P.impMin * a && obH >= P.obMin * a && obH <= P.obMax * a) {
        const top = P.zoneMode === 'BODY' ? Math.max(ob.o, ob.c) : ob.h, bot = P.zoneMode === 'BODY' ? Math.min(ob.o, ob.c) : ob.l;
        let valid = true; for (let k = 0; k < offR; k++) if (B(k).c > top) valid = false;
        if (valid) {
          const va2 = vaOf(2), vaOb = vaOf(offR + 1), inst = vaOb > 0 && ob.v >= P.instThr * vaOb;
          let s = 0;
          s += gap >= P.fvgStrong * a ? 1 : 0; s += body >= P.impStrong * a ? 1 : 0;
          s += va2 > 0 && Bb.v >= P.volStrong * va2 ? 1 : 0; s += inst ? 1 : 0;
          s += bi - lastBearBrk <= P.breakWin ? 1 : 0; s += bi - lastSwpHi <= P.sweepWin ? 1 : 0; s += trd === -1 ? 1 : 0; s += sess;
          if (s >= P.minScore) Z.ps = { dir: 'SELL', kind: 'PH', top, bot, score: s, inst, bornT: ob.t, bornI: bi };
        }
      }
    }

    // ----- VRZ : bougie climactique autour du pivot (pivot, avant, après) -----
    const L = P.pivLen;
    if (bars.length < L + P.exhBars + 2) return;
    const zH = pivotHigh(L), zL = pivotLow(L);
    if (zH == null && zL == null) return;
    let bo = L, bv = B(L).v;
    if (B(L + 1).v > bv) { bo = L + 1; bv = B(L + 1).v; }
    if (B(L - 1).v > bv) { bo = L - 1; bv = B(L - 1).v; }
    const avgV = vaOf(bo + 1), vrat = avgV > 0 ? bv / avgV : 0;
    if (!(avgV > 0 && bv >= P.volMult * avgV)) return;
    const cb = B(bo), rg = cb.h - cb.l;
    let lowN = Infinity, highN = -Infinity, cLowN = Infinity, cHighN = -Infinity, lowExh = Infinity, highExh = -Infinity;
    for (let k = 0; k < L; k++) { lowN = Math.min(lowN, B(k).l); highN = Math.max(highN, B(k).h); cLowN = Math.min(cLowN, B(k).c); cHighN = Math.max(cHighN, B(k).c); }
    for (let k = L; k < L + P.exhBars; k++) { lowExh = Math.min(lowExh, B(k).l); highExh = Math.max(highExh, B(k).h); }
    if (zH != null) {   // zone de VENTE (swing high)
      const bodyTop = Math.max(cb.o, cb.c), zT = zH, zB = zT - Math.max(P.vhMin * a, Math.min(P.vhMax * a, zT - bodyTop)), wk = cb.h - bodyTop;
      let sc = 1; sc += vrat >= P.extMult ? 1 : 0; sc += rg > 0 && wk / rg * 100 >= P.wickPct ? 1 : 0; sc += zH - lowExh >= P.exhATR * a ? 1 : 0; sc += zB - lowN >= P.reactATR * a ? 1 : 0;
      if (sc >= P.minVRZ && cHighN <= zT) Z.vs = { dir: 'SELL', kind: 'VRZ', top: zT, bot: zB, score: sc, bornT: cb.t, bornI: bi };
    }
    if (zL != null) {   // zone d'ACHAT (swing low)
      const bodyBot = Math.min(cb.o, cb.c), zB = zL, zT = zB + Math.max(P.vhMin * a, Math.min(P.vhMax * a, bodyBot - zB)), wk = bodyBot - cb.l;
      let sc = 1; sc += vrat >= P.extMult ? 1 : 0; sc += rg > 0 && wk / rg * 100 >= P.wickPct ? 1 : 0; sc += highExh - zL >= P.exhATR * a ? 1 : 0; sc += highN - zT >= P.reactATR * a ? 1 : 0;
      if (sc >= P.minVRZ && cLowN >= zB) Z.vb = { dir: 'BUY', kind: 'VRZ', top: zT, bot: zB, score: sc, bornT: cb.t, bornI: bi };
    }
  }
  const zones = () => ({ pb: Z.pb && Object.assign({}, Z.pb), ps: Z.ps && Object.assign({}, Z.ps), vb: Z.vb && Object.assign({}, Z.vb), vs: Z.vs && Object.assign({}, Z.vs), atr: bars.length ? bars[bars.length - 1].atr : null, trend: trd, lastT: bars.length ? bars[bars.length - 1].t : null });
  return { push, zones, tfMin };
}

// ---------------------------------------------------------------------------------------------------------------------
// Candidats, probabilité, sélection
// ---------------------------------------------------------------------------------------------------------------------
const gradeOf = (s, P) => (s >= P.gradeA ? 'A' : s >= P.gradeB ? 'B' : 'C');

/** Candidats = zones Phantom de chaque TF (★ si une zone VRZ du même sens les chevauche). Plan : entrée limit, SL min/max, TP1/2/3. */
function buildCands(zonesByTf, P) {
  const out = [];
  for (const tf of P.tfs) {
    const zz = zonesByTf[tf]; if (!zz || !(zz.atr > 0)) continue;
    for (const dir of ['BUY', 'SELL']) {
      const z = dir === 'BUY' ? zz.pb : zz.ps, v = dir === 'BUY' ? zz.vb : zz.vs;
      if (!z) continue;
      const a = zz.atr, tol = P.confTol * a, d = dir === 'BUY' ? 1 : -1;
      const conf = !!v && z.top + tol >= v.bot && z.bot - tol <= v.top;
      const entry = P.entryMode === 'PROX' ? (dir === 'BUY' ? z.top : z.bot) : (z.top + z.bot) / 2;
      const baseR = dir === 'BUY' ? entry - (z.bot - P.slBuf * a) : (z.top + P.slBuf * a) - entry;
      const risk = Math.max(baseR, P.slMin), sl = entry - d * risk;
      out.push({ key: `${tf}|${dir}|${z.bornT}`, tf, tfn: TFN[tf] || ('M' + tf), dir, top: r2(z.top), bot: r2(z.bot), score: z.score, inst: !!z.inst, grade: gradeOf(z.score, P),
        conf, vscore: conf ? v.score : 0, entry: r2(entry), sl: r2(sl), risk: r2(risk), tp1: r2(entry + d * P.rr1 * risk), tp2: r2(entry + d * P.rr2 * risk), tp3: r2(entry + d * P.rr3 * risk),
        bornT: z.bornT, bornI: z.bornI, atr: a, vrz: conf ? { top: r2(v.top), bot: r2(v.bot), score: v.score } : null });
    }
  }
  return out;
}

/** Calibration : buckets (TF | grade | confluence) -> n, TP1/TP2/TP3 atteints, SL, R cumulé. */
function buildCalib(trades, trainTo) {
  const buckets = {}, add = (k, t) => { const b = (buckets[k] = buckets[k] || { n: 0, w1: 0, w2: 0, w3: 0, sl: 0, sumR: 0 }); b.n++; b.w1 += t.reached1 ? 1 : 0; b.w2 += t.reached2 ? 1 : 0; b.w3 += t.reached3 ? 1 : 0; b.sl += t.result === 'SL' ? 1 : 0; b.sumR += t.R; };
  let n = 0;
  for (const t of trades) { if (trainTo && t.t >= trainTo) continue; const cf = t.conf ? 1 : 0; add(`${t.tfn}|${t.grade}|${cf}`, t); add(`*|${t.grade}|${cf}`, t); add(`*|*|${cf}`, t); n++; }
  Object.values(buckets).forEach(b => { b.sumR = Math.round(b.sumR * 1000) / 1000; });
  return { buckets, n, trainTo: trainTo || null, builtAt: Date.now() };
}
function estimate(c, calib, P) {
  const cf = c.conf ? 1 : 0, keys = [`${c.tfn}|${c.grade}|${cf}`, `*|${c.grade}|${cf}`, `*|*|${cf}`];
  if (calib && calib.buckets) for (const k of keys) { const b = calib.buckets[k]; if (b && b.n >= P.minN) return { n: b.n, p1: (b.w1 + 1) / (b.n + 2), p3: (b.w3 + 1) / (b.n + 2), ev: b.sumR / b.n, src: k }; }
  return { n: calib && calib.buckets && calib.buckets[keys[0]] ? calib.buckets[keys[0]].n : 0, p1: null, p3: null, ev: null, src: null };
}

/**
 * Évalue les candidats : critères durs (SL max, zone utilisée, distance, espace libre, confluence), puis probabilité.
 * opts.prob = false : pas de filtre de probabilité (backtest par TF). Verrou de sens : le meilleur candidat impose son sens.
 */
function evaluate(cands, zonesByTf, px, calib, P, used, opts) {
  opts = opts || {};
  const spread = opts.spread || 0, rows = [];
  for (const c of cands) {
    const why = [], d = c.dir === 'BUY' ? px - c.entry : c.entry - px;
    if (used && used.has(c.key)) why.push('zone déjà touchée');
    if (c.risk > P.slMax + 1e-9) why.push(`SL ${c.risk} > ${P.slMax}`);
    if (P.needConf && !c.conf) why.push('pas de confluence VRZ');
    if (d < 0) why.push('prix déjà passé'); else if (d > P.maxDist) why.push(`trop loin (${r2(d)})`);
    if (c.risk * P.rr1 < P.spreadX * spread) why.push('TP1 trop proche du spread');
    for (const tf of P.tfs) {   // espace libre jusqu'à TP2 (zones opposées, tous TF)
      const zz = zonesByTf[tf]; if (!zz) continue;
      for (const o of (c.dir === 'BUY' ? [zz.ps, zz.vs] : [zz.pb, zz.vb])) {
        if (!o) continue;
        const gap = c.dir === 'BUY' ? o.bot - c.entry : c.entry - o.top;
        if (gap > 0 && gap < P.minRoomR * c.risk) { why.push(`zone opposée ${TFN[tf] || tf} à ${r2(gap)}`); break; }
      }
    }
    const est = estimate(c, calib, P);
    let q = null, calibrated = est.p1 != null;
    if (opts.prob !== false) {
      if (calibrated) { if (est.ev < P.minEV) why.push(`EV ${r2(est.ev)} < ${P.minEV}`); q = est.ev; }
      else if (!(c.score >= P.gradeA && c.conf)) why.push('non calibré : il faut grade A + confluence VRZ');
      else q = 0;
    }
    rows.push({ c, ok: why.length === 0, why, dist: r2(d), est, calibrated, q });
  }
  const oks = rows.filter(r => r.ok).sort((x, y) => ((y.calibrated ? 1 : 0) - (x.calibrated ? 1 : 0)) || ((y.q || 0) - (x.q || 0)) || (y.c.score - x.c.score) || (y.c.tf - x.c.tf) || (x.dist - y.dist));
  let best = oks[0] || null;
  if (best && opts.lock !== false) for (const r of oks) if (r.c.dir !== best.c.dir) { r.ok = false; r.why.push('conflit de sens (' + best.c.tfn + ' ' + best.c.dir + ' prioritaire)'); }
  if (opts.lockDir) { for (const r of rows) if (r.ok && r.c.dir !== opts.lockDir) { r.ok = false; r.why.push('sens verrouillé (' + opts.lockDir + ')'); } best = rows.filter(r => r.ok).sort((x, y) => (y.q || 0) - (x.q || 0) || (x.dist - y.dist))[0] || null; }
  const near = {};
  rows.filter(r => r.ok).forEach(r => { if (!near[r.c.tf] || r.dist < near[r.c.tf].dist) near[r.c.tf] = r; });
  return { rows, best, near };
}

/** Instantané live : moteurs rejoués sur les bougies FERMÉES (M5 + M15 ; M30 et H1 agrégés depuis M15). */
function snapshot(m5, m15, P) {
  const series = { 5: m5, 15: m15, 30: aggBars(m15, 30, 15), 60: aggBars(m15, 60, 15) }, out = {};
  for (const tf of P.tfs) { const eng = createZoneEngine(tf, P); (series[tf] || []).forEach(b => eng.push(b)); out[tf] = eng.zones(); }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulation (backtest)
// ---------------------------------------------------------------------------------------------------------------------
function newTrade(c, tFill, P) {
  const d = c.dir === 'BUY' ? 1 : -1;
  return { tf: c.tf, tfn: c.tfn, dir: c.dir, key: c.key, t: tFill, entry: c.entry, sl: c.sl, slCur: c.sl, risk: c.risk, tps: [c.tp1, c.tp2, c.tp3], rrs: [P.rr1, P.rr2, P.rr3], legs: [null, null, null],
    score: c.score, grade: c.grade, conf: c.conf, inst: c.inst, d, reached1: false, reached2: false, reached3: false, bars: 0 };
}
/** Remplissage d'un ordre limit sur une bougie : si le SL est aussi touché sur la même bougie, perte immédiate (pessimiste). */
function fillTrade(c, T, bar, spread, P) {
  const tr = newTrade(c, T, P), buy = tr.d > 0;
  if (buy ? bar.l <= tr.sl : bar.h + spread >= tr.sl) { tr.legs = [-1, -1, -1]; tr.slHit = true; return { tr, done: true }; }
  return { tr, done: false };
}
/** Avance un trade d'une bougie. Retourne true si terminé. SL prioritaire dans une même bougie (pessimiste). */
function stepTrade(tr, bar, spread, P) {
  tr.bars++;
  const buy = tr.d > 0, open = tr.legs.map((x, i) => (x == null ? i : -1)).filter(i => i >= 0);
  const slHit = buy ? bar.l <= tr.slCur : bar.h + spread >= tr.slCur;
  if (slHit) { const R = tr.slCur === tr.entry ? 0 : -1; open.forEach(i => { tr.legs[i] = R; }); tr.slHit = true; }
  else {
    for (const i of open) {
      const hit = buy ? bar.h >= tr.tps[i] : bar.l + spread <= tr.tps[i];
      if (hit) { tr.legs[i] = tr.rrs[i]; if (i === 0) { tr.reached1 = true; if (P.beAfterTp1) tr.slCur = tr.entry; } if (i === 1) tr.reached2 = true; if (i === 2) tr.reached3 = true; }
    }
  }
  return tr.legs.every(x => x != null);
}
function closeTrade(tr, lastClose) {   // fin des données : on clôture au dernier prix
  tr.legs = tr.legs.map(x => (x == null ? Math.max(-1, Math.min(tr.rrs[2], (lastClose - tr.entry) * tr.d / tr.risk)) : x));
}
function finalizeTrade(tr) {
  tr.R = Math.round(tr.legs.reduce((s, x) => s + x, 0) / 3 * 1000) / 1000;
  tr.result = tr.reached3 ? 'TP3' : tr.reached2 ? (tr.slHit ? 'TP2+BE' : 'TP2') : tr.reached1 ? (tr.slHit ? 'TP1+BE' : 'TP1') : tr.slHit ? 'SL' : 'OUVERT';
  return tr;
}

/** Résumé d'une liste de trades. */
function summarize(trades, period) {
  const n = trades.length;
  if (!n) return { trades: 0, winRate: null, tp1: 0, tp2: 0, tp3: 0, sl: 0, netR: 0, avgR: null, pf: null, maxDD: 0, curve: [], avgPerWeek: 0 };
  let cum = 0, peak = 0, dd = 0, gp = 0, gl = 0; const curve = [];
  const sorted = trades.slice().sort((a, b) => a.t - b.t);
  for (const t of sorted) { cum += t.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (t.R > 0) gp += t.R; else gl += -t.R; curve.push(Math.round(cum * 100) / 100); }
  const step = Math.max(1, Math.ceil(curve.length / 120)), cv = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  const weeks = Math.max(1, ((period && period.to - period.from) || (sorted[n - 1].t - sorted[0].t) || 604800000) / 604800000);
  const c1 = trades.filter(t => t.reached1).length, c2 = trades.filter(t => t.reached2).length, c3 = trades.filter(t => t.reached3).length, sl = trades.filter(t => t.result === 'SL').length;
  return { trades: n, winRate: Math.round(c1 / n * 1000) / 10, tp1: c1, tp2: c2, tp3: c3, sl, netR: Math.round(cum * 100) / 100, avgR: Math.round(cum / n * 1000) / 1000, pf: gl > 0 ? Math.round(gp / gl * 100) / 100 : (gp > 0 ? 99 : null), maxDD: Math.round(dd * 100) / 100, curve: cv, avgPerWeek: Math.round(n / weeks * 10) / 10 };
}

/**
 * Backtest PV : un seul passage sur M5 + M15 (M30 / H1 agrégés).
 *  - par TF : chaque TF est simulé SEUL (un ordre à la fois, sans filtre de probabilité) -> résultats séparés ;
 *  - robot : tous les TF ensemble, un seul ordre à la fois, verrou de sens, filtre de probabilité calibré sur la période d'APPRENTISSAGE
 *    (trainFrac) et jugé sur la période de TEST uniquement (aucune triche).
 * opts : { from, to, spread (prix), trainFrac, cfg (surcharges), onProgress(f) }.
 */
function runBacktest(m5, m15, opts) {
  opts = opts || {};
  const P = Object.assign({}, DEFAULT_PV, opts.cfg || {}), spread = opts.spread != null ? opts.spread : 0.25;
  const from = opts.from || (m5[0] && m5[0].t) || 0, to = opts.to || (m5.length ? m5[m5.length - 1].t + 300000 : 0), trainFrac = opts.trainFrac || 0.7;
  const split = Math.round(from + (to - from) * trainFrac);
  const series = { 5: m5, 15: m15, 30: aggBars(m15, 30, 15), 60: aggBars(m15, 60, 15) };
  const prog = f => { if (opts.onProgress) opts.onProgress(Math.min(1, f)); };

  /** Rejoue la timeline M5 : à chaque bougie M5 fermée, les moteurs reçoivent leurs bougies fermées puis `onStep` est appelé. */
  function replay(onStep, f0, f1) {
    const eng = {}, ptr = {}; P.tfs.forEach(tf => { eng[tf] = createZoneEngine(tf, P); ptr[tf] = 0; });
    for (let i = 0; i < m5.length; i++) {
      const bar = m5[i], T = bar.t + 300000;
      if (bar.t >= to) break;
      for (const tf of P.tfs) { const arr = series[tf], ms = tf * 60000; while (ptr[tf] < arr.length && arr[ptr[tf]].t + ms <= T) eng[tf].push(arr[ptr[tf]++]); }
      const zones = {}; for (const tf of P.tfs) zones[tf] = eng[tf].zones();
      onStep(bar, T, zones, i);
      if (i % 400 === 0) prog(f0 + (f1 - f0) * i / m5.length);
    }
  }

  // ---------- passe 1 : un trader indépendant par TF ----------
  const tfRes = {};
  const T1 = {}; P.tfs.forEach(tf => { T1[tf] = { pend: null, act: null, used: new Set(), trades: [] }; });
  replay((bar, T, zones) => {
    for (const tf of P.tfs) {
      const st = T1[tf], zs = {}; zs[tf] = zones[tf];
      const cands = buildCands(zs, Object.assign({}, P, { tfs: [tf] }));
      if (st.act) { if (stepTrade(st.act, bar, spread, P)) { st.trades.push(finalizeTrade(st.act)); st.act = null; } }
      else if (st.pend) {
        const p = st.pend.c, buy = p.dir === 'BUY', fill = buy ? bar.l + spread <= p.entry : bar.h >= p.entry;
        const alive = cands.some(c => c.key === p.key);
        if (fill) { st.used.add(p.key); const f = fillTrade(p, T, bar, spread, P); st.pend = null; if (f.done) st.trades.push(finalizeTrade(f.tr)); else st.act = f.tr; }
        else if (!alive || T - st.pend.t0 > P.limitExpiryBars * 300000) { st.used.add(p.key); st.pend = null; }
      }
      for (const c of cands) { if (st.used.has(c.key) || (st.pend && st.pend.c.key === c.key)) continue; if (c.dir === 'BUY' ? bar.l + spread <= c.entry : bar.h >= c.entry) st.used.add(c.key); }
      if (!st.act && !st.pend && T >= from) {
        const ev = evaluate(cands, zs, bar.c, null, Object.assign({}, P, { tfs: [tf] }), st.used, { prob: false, spread });
        if (ev.best) st.pend = { c: ev.best.c, t0: T };
      }
    }
  }, 0, 0.45);
  for (const tf of P.tfs) { const st = T1[tf]; if (st.act) { closeTrade(st.act, m5[m5.length - 1].c); st.trades.push(finalizeTrade(st.act)); } tfRes[tf] = st.trades.filter(t => t.t >= from); }

  // ---------- calibration (apprentissage) ----------
  const allTr = [].concat(...P.tfs.map(tf => tfRes[tf]));
  const calib = buildCalib(allTr, split);

  // ---------- passe 2 : robot (tous TF, un seul ordre, verrou de sens, probabilité) — évalué sur le TEST ----------
  const R2 = { pend: null, act: null, used: new Set(), trades: [] };
  replay((bar, T, zones) => {
    const cands = buildCands(zones, P);
    if (R2.act) { if (stepTrade(R2.act, bar, spread, P)) { R2.trades.push(finalizeTrade(R2.act)); R2.act = null; } }
    else if (R2.pend) {
      const p = R2.pend.c, buy = p.dir === 'BUY', fill = buy ? bar.l + spread <= p.entry : bar.h >= p.entry, alive = cands.some(c => c.key === p.key);
      if (fill) { R2.used.add(p.key); const f = fillTrade(p, T, bar, spread, P); R2.pend = null; if (f.done) R2.trades.push(finalizeTrade(f.tr)); else R2.act = f.tr; }
      else if (!alive || T - R2.pend.t0 > P.limitExpiryBars * 300000) { R2.used.add(p.key); R2.pend = null; }
    }
    for (const c of cands) { if (R2.used.has(c.key) || (R2.pend && R2.pend.c.key === c.key)) continue; if (c.dir === 'BUY' ? bar.l + spread <= c.entry : bar.h >= c.entry) R2.used.add(c.key); }
    if (!R2.act && !R2.pend && T >= split) {
      const ev = evaluate(cands, zones, bar.c, calib, P, R2.used, { prob: true, spread });
      if (ev.best) R2.pend = { c: ev.best.c, t0: T };
    }
  }, 0.45, 0.95);
  if (R2.act) { closeTrade(R2.act, m5[m5.length - 1].c); R2.trades.push(finalizeTrade(R2.act)); }

  const slim = t => ({ t: t.t, tf: t.tfn, dir: t.dir, entry: t.entry, sl: t.sl, risk: t.risk, score: t.score, grade: t.grade, conf: t.conf, inst: t.inst, result: t.result, R: t.R });
  const perTf = {};
  for (const tf of P.tfs) perTf[TFN[tf] || ('M' + tf)] = { summary: summarize(tfRes[tf], { from, to }), test: summarize(tfRes[tf].filter(t => t.t >= split), { from: split, to }), trades: tfRes[tf].slice(-120).reverse().map(slim) };
  const robotTrades = R2.trades.filter(t => t.t >= split);
  const buckets = Object.entries(calib.buckets).filter(([k]) => !k.startsWith('*|*')).map(([k, b]) => ({ key: k, n: b.n, p1: Math.round((b.w1 + 1) / (b.n + 2) * 1000) / 10, p3: Math.round((b.w3 + 1) / (b.n + 2) * 1000) / 10, avgR: Math.round(b.sumR / b.n * 1000) / 1000, ok: b.n >= P.minN && b.sumR / b.n >= P.minEV })).sort((a, b) => b.n - a.n).slice(0, 30);
  prog(1);
  return { pv: true, perTf, robot: { summary: summarize(robotTrades, { from: split, to }), trades: robotTrades.slice(-150).reverse().map(slim) }, calib: { n: calib.n, trainTo: split, buckets: calib.buckets, table: buckets }, period: { from, to, split }, spread, cfg: { slMin: P.slMin, slMax: P.slMax, rr: [P.rr1, P.rr2, P.rr3], maxDist: P.maxDist, minN: P.minN, minEV: P.minEV, needConf: P.needConf } };
}

module.exports = { DEFAULT_PV, TFN, aggBars, createZoneEngine, buildCands, buildCalib, estimate, evaluate, snapshot, runBacktest, summarize };
