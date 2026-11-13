'use strict';
/**
 * ARES IP — stratégie unique du robot (remplace toutes les anciennes stratégies).
 *
 *  • Zones OB + FVG sur M5 / M15 / M30 / H1, validées par une zone clé H4 (même sens, qui se chevauchent).
 *  • Score /6 (FVG fort, impulsion forte, BOS récent, sweep récent, tendance, session) — pas de volume (cTrader n'en fournit pas ici).
 *  • PROBABILITÉ : estimée sur l'historique réel (taux de réussite et espérance en R par TF × grade, après spread).
 *    Le robot ne prend que les zones dont l'espérance est positive. Jamais de zone « au hasard ».
 *  • Pas de trades opposés : si H1 et M30 ne sont pas d'accord, seul le sens de la zone la plus probable reste.
 *  • Une seule zone à la fois : la plus proche du prix parmi les zones retenues.
 *  • SL 50–100 pips (5–10 $ sur l'or), jamais plus serré. RR choisi par le robot (liquidité proche), entre minRR et maxRR.
 *  • Backtest 1 an : résultats séparés par TF + robot (probabilité apprise « walk-forward » : jamais avec le futur).
 *
 * Fonctions pures (aucun accès réseau). Bougies : [{ t (ms, ouverture), o, h, l, c }] triées, FERMÉES seulement.
 */

const DEFAULTS = {
  tfEntry: [5, 15, 30, 60], tfKey: 240,
  swingLen: 10, breakWin: 3, sweepWin: 20, tgtLen: 5,
  atrLen: 14, fvgMin: 0.10, impMin: 0.50, obMin: 0.30, obMax: 3.0, obLook: 5, zoneMode: 'WICK',
  fvgStrong: 0.35, impStrong: 1.0, sessFrom: 7, sessTo: 21,
  minScore: 4, gradeA: 5, gradeB: 4, maxAge: 300,
  entryMode: 'MID', slBuf: 0.15, minSL: 5, maxSL: 10, minRR: 1.5, maxRR: 4, defaultRR: 3, tpBuf: 0.2,
  useKey: true, maxDist: 8,
  spread: 0.25, slippage: 0.05,
  minSamples: 8, priorN: 8, minExp: 0.05
};
const PIP = 0.1;   // XAUUSD : 1 pip = 0.10 $ (50 pips = 5 $, 100 pips = 10 $)
const clone = o => JSON.parse(JSON.stringify(o));
const cfgOf = c => Object.assign({}, DEFAULTS, c || {});
const r2 = x => Math.round(x * 100) / 100;

/** Agrège des bougies M5 (ou autre) en bougies de `tf` minutes. */
function aggregate(bars, tf) {
  const ms = tf * 60000, out = [];
  let cur = null;
  for (const b of bars) {
    const t0 = Math.floor(b.t / ms) * ms;
    if (!cur || cur.t !== t0) { cur = { t: t0, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(cur); }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; }
  }
  return out;
}

/** Plan d'ordre : entrée limit, SL (min/max en $), TP structurel (RR entre minRR et maxRR). Retourne null si le SL dépasse maxSL. */
function makePlan(side, top, bot, atr, targets, C) {
  const buy = side === 'BUY';
  const entry = C.entryMode === 'MID' ? (top + bot) / 2 : (buy ? top : bot);
  let sl = buy ? bot - C.slBuf * atr : top + C.slBuf * atr, risk = Math.abs(entry - sl);
  if (risk < C.minSL) { sl = buy ? entry - C.minSL : entry + C.minSL; risk = C.minSL; }   // jamais plus serré que 50 pips
  if (risk > C.maxSL + 1e-9) return null;                                                   // plus de 100 pips : zone refusée
  let tp = null;
  for (const p of targets) {   // cibles de liquidité (swings non touchés) triées par distance
    const d = Math.abs(p - entry);
    if (d < C.minRR * risk) continue;
    tp = d > C.maxRR * risk ? (buy ? entry + C.maxRR * risk : entry - C.maxRR * risk) : (buy ? p - C.tpBuf : p + C.tpBuf);
    break;
  }
  if (tp === null) tp = buy ? entry + C.defaultRR * risk : entry - C.defaultRR * risk;
  const dist = Math.abs(tp - entry);
  if (dist < C.minRR * risk - 1e-9) tp = buy ? entry + C.minRR * risk : entry - C.minRR * risk;
  return { entry: r2(entry), sl: r2(sl), tp: r2(tp), risk: r2(risk), rr: r2(Math.abs(tp - entry) / risk), slPips: Math.round(risk / PIP) };
}

/** Moteur d'UN timeframe : traite les bougies fermées une à une. Garde la dernière zone ⭐ de chaque sens. */
function createTf(tf, C) {
  const ms = tf * 60000, n = C.atrLen;
  const O = [], H = [], L = [], K = [], T = [];
  let i = -1, atr = null, trSum = 0, sHi = null, sLo = null, trd = 0;
  let lastBullBrk = -1e9, lastBearBrk = -1e9, lastSwpHi = -1e9, lastSwpLo = -1e9;
  let bull = null, bear = null, bullIdx = 0, bearIdx = 0;
  const tHi = [], tLo = [], done = [];
  const grade = s => (s >= C.gradeA ? 'A' : s >= C.gradeB ? 'B' : 'C');

  function pivotAt(arr, p, len, isHigh, last) {   // pivot confirmé à l'index p (len barres de chaque côté)
    if (p - len < 0) return false;
    const v = arr[p];
    for (let j = p - len; j < p; j++) if (isHigh ? arr[j] >= v : arr[j] <= v) return false;
    for (let j = p + 1; j <= last; j++) if (isHigh ? arr[j] > v : arr[j] < v) return false;
    return true;
  }
  function finish(z, endT) { z.endT = endT; done.push(z); }
  function oppositeOB(bullSide) {
    for (let k = 2; k <= 2 + C.obLook; k++) {
      const x = i - k; if (x < 0) return -1;
      if (bullSide ? K[x] < O[x] : K[x] > O[x]) return k;
    }
    return -1;
  }
  function zoneRange(k) {
    const x = i - k;
    return C.zoneMode === 'BODY' ? { top: Math.max(O[x], K[x]), bot: Math.min(O[x], K[x]) } : { top: H[x], bot: L[x] };
  }
  function build(side, off, gap, body) {
    const buy = side === 'BUY', zr = zoneRange(off);
    // zone valide : aucune clôture au-delà de la zone entre l'OB et la bougie C
    for (let k = 0; k <= off - 1; k++) if (buy ? K[i - k] < zr.bot : K[i - k] > zr.top) return null;
    let s = 0;
    s += gap >= C.fvgStrong * atr ? 1 : 0;
    s += body >= C.impStrong * atr ? 1 : 0;
    s += (i - (buy ? lastBullBrk : lastBearBrk)) <= C.breakWin ? 1 : 0;
    s += (i - (buy ? lastSwpLo : lastSwpHi)) <= C.sweepWin ? 1 : 0;
    s += trd === (buy ? 1 : -1) ? 1 : 0;
    const hr = new Date(T[i]).getUTCHours();
    s += (hr >= C.sessFrom && hr < C.sessTo) ? 1 : 0;
    if (s < C.minScore) return null;
    const tg = (buy ? tHi.filter(p => !p.done && p.price > (zr.top + zr.bot) / 2).map(p => p.price).sort((a, b) => a - b)
      : tLo.filter(p => !p.done && p.price < (zr.top + zr.bot) / 2).map(p => p.price).sort((a, b) => b - a));
    const plan = makePlan(side, zr.top, zr.bot, atr, tg, C);
    if (!plan) return null;
    return { tf, side, top: zr.top, bot: zr.bot, score: s, grade: grade(s), bornT: T[i - off], startT: T[i] + ms, endT: null, plan, id: `${tf}|${side}|${T[i - off]}` };
  }

  return {
    tf, ms,
    push(b) {
      i++; O[i] = b.o; H[i] = b.h; L[i] = b.l; K[i] = b.c; T[i] = b.t;
      const pc = i > 0 ? K[i - 1] : b.c, tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
      if (i < n) { trSum += tr; if (i === n - 1) atr = trSum / n; } else atr = (atr * (n - 1) + tr) / n;
      // pivots de structure
      const p = i - C.swingLen;
      if (p >= 0) { if (pivotAt(H, p, C.swingLen, true, i)) sHi = H[p]; if (pivotAt(L, p, C.swingLen, false, i)) sLo = L[p]; }
      // pivots « liquidité » (cibles de TP)
      const q = i - C.tgtLen;
      if (q >= 0) {
        if (pivotAt(H, q, C.tgtLen, true, i)) { tHi.push({ price: H[q], done: false }); if (tHi.length > 40) tHi.shift(); }
        if (pivotAt(L, q, C.tgtLen, false, i)) { tLo.push({ price: L[q], done: false }); if (tLo.length > 40) tLo.shift(); }
      }
      for (const x of tHi) if (!x.done && b.h > x.price) x.done = true;
      for (const x of tLo) if (!x.done && b.l < x.price) x.done = true;
      // sweeps puis cassures (clôture au-delà du dernier pivot)
      if (sLo !== null && b.l < sLo && b.c > sLo) lastSwpLo = i;
      if (sHi !== null && b.h > sHi && b.c < sHi) lastSwpHi = i;
      if (sHi !== null && b.c > sHi) { trd = 1; lastBullBrk = i; sHi = null; }
      else if (sLo !== null && b.c < sLo) { trd = -1; lastBearBrk = i; sLo = null; }
      // invalidation / expiration
      const closeT = T[i] + ms;
      if (bull && (b.c < bull.bot || i - bullIdx > C.maxAge)) { finish(bull, closeT); bull = null; }
      if (bear && (b.c > bear.top || i - bearIdx > C.maxAge)) { finish(bear, closeT); bear = null; }
      if (!(atr > 0) || i < 3) return;
      // FVG haussier (A = i-2, B = i-1, C = i) -> demand
      if (L[i] > H[i - 2] && K[i - 1] > O[i - 1]) {
        const off = oppositeOB(true), gap = L[i] - H[i - 2], body = K[i - 1] - O[i - 1];
        if (off >= 2) {
          const x = i - off, obH = H[x] - L[x];
          if (gap >= C.fvgMin * atr && body >= C.impMin * atr && obH >= C.obMin * atr && obH <= C.obMax * atr) {
            const z = build('BUY', off, gap, body);
            if (z) { if (bull) finish(bull, closeT); bull = z; bullIdx = i; }
          }
        }
      }
      // FVG baissier -> supply
      if (H[i] < L[i - 2] && K[i - 1] < O[i - 1]) {
        const off = oppositeOB(false), gap = L[i - 2] - H[i], body = O[i - 1] - K[i - 1];
        if (off >= 2) {
          const x = i - off, obH = H[x] - L[x];
          if (gap >= C.fvgMin * atr && body >= C.impMin * atr && obH >= C.obMin * atr && obH <= C.obMax * atr) {
            const z = build('SELL', off, gap, body);
            if (z) { if (bear) finish(bear, closeT); bear = z; bearIdx = i; }
          }
        }
      }
    },
    current: () => ({ bull, bear, trend: trd, atr }),
    zones() { return done.concat([bull, bear].filter(Boolean).map(z => Object.assign({}, z, { endT: Infinity }))); }
  };
}

/** Toutes les zones (vie complète) d'un timeframe sur un jeu de bougies. */
function zonesOf(bars, tf, C) { const e = createTf(tf, C); for (const b of bars) e.push(b); return e.zones(); }

// ---------------------------------------------------------------------------------------------------------------
//  Probabilité (statistiques par TF × grade)
// ---------------------------------------------------------------------------------------------------------------
const bucketKey = z => `${z.tf}|${z.grade}`;
function newStats() { return {}; }
function addStat(st, key, Rnet) { const s = (st[key] = st[key] || { n: 0, w: 0, sumR: 0 }); s.n++; if (Rnet > 0) s.w++; s.sumR += Rnet; }
/** Probabilité de gain (réduite vers le niveau « neutre »), espérance en R, et décision. */
function probOf(st, z, C) {
  const s = st[bucketKey(z)] || { n: 0, w: 0, sumR: 0 }, p0 = 1 / (1 + C.defaultRR);
  const pWin = (s.w + p0 * C.priorN) / (s.n + C.priorN), expR = s.sumR / (s.n + C.priorN);
  return { n: s.n, pWin: Math.round(pWin * 1000) / 1000, expR: Math.round(expR * 1000) / 1000, ok: s.n >= C.minSamples && expR >= C.minExp };
}

/** Sélection : (1) zones à probabilité suffisante, (2) un seul sens (celui de la meilleure espérance), (3) la plus proche du prix. */
function selectBest(alive, st, C) {
  const acc = [];
  for (const z of alive) { const p = probOf(st, z, C); if (p.ok) acc.push({ z, p }); }
  if (!acc.length) return null;
  let top = acc[0];
  for (const a of acc) if (a.p.expR > top.p.expR + 1e-9 || (Math.abs(a.p.expR - top.p.expR) <= 1e-9 && a.z.tf > top.z.tf)) top = a;
  const side = top.z.side;
  let best = null;
  for (const a of acc) { if (a.z.side !== side || a.z.dist > C.maxDist) continue; if (!best || a.z.dist < best.z.dist) best = a; }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
//  BACKTEST
// ---------------------------------------------------------------------------------------------------------------
function lowerBound(arr, x) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < x) lo = m + 1; else hi = m; } return lo; }

/** Prépare les candidats : fenêtre d'éligibilité (zone clé H4), puis résultat « fantôme » de chaque zone sur M5. */
function buildCandidates(bars, C) {
  const m5 = bars[5], ct = m5.map(b => b.t + 300000), cands = [];
  const keyZ = C.useKey ? zonesOf(bars[C.tfKey] || [], C.tfKey, C) : [];
  for (const tf of C.tfEntry) {
    for (const z of zonesOf(bars[tf] || [], tf, C)) {
      let from = z.startT, to = z.endT;
      if (C.useKey) {
        const kz = keyZ.find(k => k.side === z.side && z.top >= k.bot && z.bot <= k.top && Math.max(z.startT, k.startT) < Math.min(z.endT, k.endT));
        if (!kz) continue;
        from = Math.max(z.startT, kz.startT); to = Math.min(z.endT, kz.endT);
      }
      const c = Object.assign({}, z, { from, to });
      const kS = lowerBound(ct, z.startT), kE = lowerBound(ct, from);
      if (kS >= m5.length) continue;
      const buy = z.side === 'BUY', e = z.plan.entry;
      if (buy ? !(m5[kE < m5.length ? kE : m5.length - 1].c > e) : !(m5[kE < m5.length ? kE : m5.length - 1].c < e)) continue;   // prix déjà au-delà de l'entrée
      let fill = -1;
      for (let k = kS + 1; k < m5.length && m5[k].t < to; k++) { if (buy ? m5[k].l <= e : m5[k].h >= e) { fill = k; break; } }
      if (fill !== -1 && fill <= kE) continue;   // touchée avant d'être éligible
      c.kE = kE; c.fill = fill; c.exit = -1; c.exitType = null;
      if (fill !== -1) {
        const p = z.plan;
        for (let k = fill; k < m5.length; k++) {
          const hitSL = buy ? m5[k].l <= p.sl : m5[k].h >= p.sl, hitTP = buy ? m5[k].h >= p.tp : m5[k].l <= p.tp;
          if (hitSL) { c.exit = k; c.exitType = 'SL'; break; }   // SL prioritaire si les deux dans la même bougie
          if (hitTP) { c.exit = k; c.exitType = 'TP'; break; }
        }
        if (c.exit !== -1) {
          const cost = (C.spread + C.slippage) / p.risk;
          c.Rnet = (c.exitType === 'TP' ? p.rr : -1) - cost;
          c.exitCT = ct[c.exit];
        } else c.fill = -1 - 1000000;   // jamais résolue (fin des données) : ignorée
      }
      cands.push(c);
    }
  }
  return cands;
}

/** Boucle de simulation sur M5. mode : 'TF' (une seule TF, la plus proche) ou 'ROBOT' (probabilité + sens unique, stats walk-forward). */
function simulate(cands, m5, C, mode, tfOnly, riskUsd) {
  const list = cands.filter(c => (tfOnly == null || c.tf === tfOnly) && c.fill > -500000).sort((a, b) => a.from - b.from);
  const shadows = cands.filter(c => c.exitCT).sort((a, b) => a.exitCT - b.exitCT);
  const st = newStats(), trades = [];
  let ptr = 0, sp = 0, act = null, pend = null;
  const alive = [];
  const ctOf = k => m5[k].t + 300000;
  const closeTrade = (c, k) => trades.push({ tf: c.tf, side: c.side, grade: c.grade, score: c.score, entry: c.plan.entry, sl: c.plan.sl, tp: c.plan.tp, rr: c.plan.rr, slPips: c.plan.slPips,
    outcome: c.exitType, R: r2(c.Rnet), tOpen: m5[c.fill].t, tClose: ctOf(k), pnlUsd: r2(c.Rnet * riskUsd) });
  for (let k = 0; k < m5.length; k++) {
    const tc = ctOf(k);
    while (sp < shadows.length && shadows[sp].exitCT <= tc) { addStat(st, bucketKey(shadows[sp]), shadows[sp].Rnet); sp++; }   // statistiques : seulement le passé
    while (ptr < list.length && list[ptr].from <= tc) alive.push(list[ptr++]);
    for (let j = alive.length - 1; j >= 0; j--) { const c = alive[j]; if (c.to <= tc || (c.fill !== -1 && c.fill <= k)) alive.splice(j, 1); }   // expirée ou touchée
    if (act && act.exit === k) { closeTrade(act, k); act = null; }
    if (!act && pend && pend.fill === k) { if (pend.exit === k) closeTrade(pend, k); else act = pend; pend = null; }
    if (act) continue;
    const cl = m5[k].c, view = [];
    for (const c of alive) { if (c.fill !== -1 && c.fill <= k) continue; const d = c.side === 'BUY' ? cl - c.plan.entry : c.plan.entry - cl; if (d > 0) view.push(Object.assign({}, c, { dist: d })); }
    if (!view.length) { pend = null; continue; }
    let pick = null;
    if (mode === 'ROBOT') { const b = selectBest(view, st, C); pick = b ? b.z : null; }
    else { let nb = null; for (const z of view) if (z.dist <= C.maxDist && (!nb || z.dist < nb.dist)) nb = z; pick = nb; }
    pend = pick ? alive.find(c => c.id === pick.id) : null;
  }
  return trades;
}

function summarize(trades) {
  const n = trades.length, tp = trades.filter(t => t.outcome === 'TP').length, sl = n - tp;
  const win = trades.filter(t => t.R > 0), lose = trades.filter(t => t.R <= 0);
  const sw = win.reduce((a, t) => a + t.R, 0), sl2 = Math.abs(lose.reduce((a, t) => a + t.R, 0));
  const netR = trades.reduce((a, t) => a + t.R, 0);
  let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0;
  for (const t of trades) { cum += t.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (t.R <= 0) { streak++; maxStreak = Math.max(maxStreak, streak); } else streak = 0; }
  return {
    trades: n, tp, sl, winRate: n ? Math.round(tp / n * 1000) / 10 : null, netR: r2(netR), expectancy: n ? r2(netR / n) : null,
    profitFactor: sl2 > 0 ? r2(sw / sl2) : (sw > 0 ? null : 0), maxDrawdownR: r2(dd), maxLosingStreak: maxStreak,
    avgRR: n ? r2(trades.reduce((a, t) => a + t.rr, 0) / n) : null, avgSlPips: n ? Math.round(trades.reduce((a, t) => a + t.slPips, 0) / n) : null,
    pnlUsd: r2(trades.reduce((a, t) => a + (t.pnlUsd || 0), 0))
  };
}
function monthly(trades) {
  const m = {};
  for (const t of trades) { const k = new Date(t.tClose).toISOString().slice(0, 7); (m[k] = m[k] || []).push(t); }
  return Object.keys(m).sort().map(k => Object.assign({ month: k }, summarize(m[k])));
}

/**
 * Backtest complet. bars = { 5:[], 15:[], 30:[], 60:[], 240:[] } (historique réel, plus ancien d'abord).
 * opts : { from, to (ms), riskUsd, cfg }. Retourne les résultats par TF, le robot, les stats utilisables en live.
 */
function backtest(bars, opts) {
  opts = opts || {};
  const C = cfgOf(opts.cfg), riskUsd = opts.riskUsd > 0 ? opts.riskUsd : 10;
  const from = opts.from || 0, to = opts.to || Infinity;
  const win = tf => (bars[tf] || []).filter(b => b.t < to);   // le warm-up (avant `from`) sert à construire les zones
  const B = {}; [5].concat(C.tfEntry, [C.tfKey]).forEach(tf => { B[tf] = win(tf); });
  if (!B[5].length) return { ok: false, error: 'aucune bougie M5' };
  const cands = buildCandidates(B, C);
  const m5 = B[5], inPeriod = t => t.tOpen >= from;
  const perTf = {};
  for (const tf of C.tfEntry) { const tr = simulate(cands, m5, C, 'TF', tf, riskUsd).filter(inPeriod); perTf[tf] = Object.assign({ tf }, summarize(tr), { monthly: monthly(tr) }); }
  const rob = simulate(cands, m5, C, 'ROBOT', null, riskUsd).filter(inPeriod);
  const byTf = {}; for (const tf of C.tfEntry) byTf[tf] = Object.assign({ tf }, summarize(rob.filter(t => t.tf === tf)));
  // statistiques complètes (pour le live) : toutes les zones de la période
  const stats = newStats(); cands.filter(c => c.exitCT && c.from >= from).forEach(c => addStat(stats, bucketKey(c), c.Rnet));
  const probs = {}; for (const k of Object.keys(stats)) { const [tf, g] = k.split('|'); probs[k] = Object.assign({ tf: +tf, grade: g }, stats[k], probOf(stats, { tf: +tf, grade: g }, C)); }
  return {
    ok: true, cfg: C, riskUsd, period: { from, to: Math.min(to, m5[m5.length - 1].t + 300000) },
    bars: Object.fromEntries(Object.keys(B).map(tf => [tf, B[tf].length])),
    candidates: cands.filter(c => c.from >= from).length,
    perTf, robot: Object.assign({ byTf, monthly: monthly(rob), firstTrade: rob.length ? rob[0].tOpen : null }, summarize(rob), { trades: rob.slice(-200).reverse() }),
    stats, probs
  };
}

// ---------------------------------------------------------------------------------------------------------------
//  LIVE : zones actuelles (bougies fermées) + probabilité (stats du dernier backtest) + sélection
// ---------------------------------------------------------------------------------------------------------------
function evaluate(bars, stats, opts) {
  opts = opts || {};
  const C = cfgOf(opts.cfg), m5 = bars[5] || [];
  if (m5.length < 60) return { ok: false, wait: `bougies M5 insuffisantes (${m5.length})` };
  for (const tf of C.tfEntry.concat([C.tfKey])) if (!bars[tf] || bars[tf].length < 60) return { ok: false, wait: `bougies M${tf} insuffisantes (${(bars[tf] || []).length})` };
  const price = opts.price || m5[m5.length - 1].c;
  const keyE = createTf(C.tfKey, C); for (const b of bars[C.tfKey]) keyE.push(b);
  const kc = keyE.current();
  const kz = { BUY: kc.bull, SELL: kc.bear };
  const out = [], st = stats || {};
  for (const tf of C.tfEntry) {
    const e = createTf(tf, C); for (const b of bars[tf]) e.push(b);
    const cur = e.current();
    for (const z of [cur.bull, cur.bear]) {
      if (!z) continue;
      const k = kz[z.side], keyOk = !C.useKey || (k && z.top >= k.bot && z.bot <= k.top);
      const buy = z.side === 'BUY', en = z.plan.entry;
      let touched = false;
      for (let j = m5.length - 1; j >= 0 && m5[j].t + 300000 > z.startT; j--) if (buy ? m5[j].l <= en : m5[j].h >= en) { touched = true; break; }
      const dist = buy ? price - en : en - price, p = probOf(st, z, C);
      out.push({ id: z.id, tf, side: z.side, top: z.top, bot: z.bot, score: z.score, grade: z.grade, entry: z.plan.entry, sl: z.plan.sl, tp: z.plan.tp, rr: z.plan.rr, slPips: z.plan.slPips,
        dist: r2(dist), keyOk: !!keyOk, touched, bornT: z.bornT, startT: z.startT, n: p.n, pWin: p.pWin, expR: p.expR, probOk: p.ok });
    }
  }
  const alive = out.filter(z => z.keyOk && !z.touched && z.dist > 0);
  const b = selectBest(alive, st, C);
  return { ok: true, price, keyZone: { BUY: kz.BUY ? { top: kz.BUY.top, bot: kz.BUY.bot } : null, SELL: kz.SELL ? { top: kz.SELL.top, bot: kz.SELL.bot } : null },
    candidates: out.sort((a, c) => a.dist - c.dist), best: b ? b.z : null };
}

module.exports = { DEFAULTS, PIP, aggregate, createTf, zonesOf, makePlan, probOf, selectBest, buildCandidates, simulate, summarize, backtest, evaluate, cfgOf };
