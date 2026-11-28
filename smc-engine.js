'use strict';
/**
 * SMC — moteur de stratégie (fonctions pures, bougies FERMÉES uniquement, aucun repaint).
 *
 *  BIAS (H1 ou H4)  : structure (dernier BOS/CHoCH) -> BUY ou SELL ; aucun trade contre le biais.
 *  M15              : direction (BOS M15 dans le sens du biais) + POI = OB (+ FVG) nés de ce BOS.
 *  M5               : confirmation (CHoCH/BOS M5) + entrée.
 *
 *  3 façons d'entrer (même biais, mêmes zones) :
 *   RETEST : la zone M15 est touchée -> CHoCH M5 -> ordre LIMIT sur l'OB M5.
 *   DIRECT : BOS M5 de continuation dans le sens du biais -> entrée marché.
 *   ZONE   : zone M15 PAS ENCORE touchée dont la probabilité MESURÉE (backtest) est élevée -> ordre LIMIT dans la zone.
 *
 *  SL : au-delà de la structure ; min 50 pips / max 100 pips (Gold 5.00-10.00 · EURUSD 0.0050-0.0100) :
 *       trop petit -> élargi au minimum ; trop grand -> setup ignoré (jamais resserré dans la structure).
 *  TP : RR fixe (2 ou 3), non limité. BE automatique quand le prix a fait 50 % du chemin vers le TP.
 *  Ordre limit : retiré si le prix fait 50 % du chemin sans l'avoir rempli, ou si la zone / le biais est invalidé.
 *  Probabilités : jamais inventées, elles viennent du backtest (taux et R/trade mesurés).
 */
const M5 = 300000, M15 = 900000, H1 = 3600000, H4 = 14400000, D1 = 86400000;
const MAX_ZONE_AGE = 7 * D1, RETEST_WINDOW = 6 * 3600000, ZONE_EXPIRE_BARS = 864, LIMIT_EXPIRE_BARS = 72;

const PAIR_MATCH = { XAUUSD: /^(XAUUSD|GOLD|XAU)/, EURUSD: /^EURUSD/ };
function pairSpec(sym) {   // distances en unités de prix
  if (/XAU|GOLD/i.test(sym)) return { min: 5.0, max: 10.0, buf: 0.3, spread: 0.25 };
  if (/JPY/i.test(sym)) return { min: 0.5, max: 1.0, buf: 0.03, spread: 0.008 };
  return { min: 0.005, max: 0.01, buf: 0.0003, spread: 0.00008 };
}

/* ---------- utilitaires */
const upper = (arr, t, key) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if ((key ? arr[m][key] : arr[m]) <= t) lo = m + 1; else hi = m; } return lo; };   // nb d'éléments <= t
const lower = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < t) lo = m + 1; else hi = m; } return lo; };           // 1er index >= t
const r3 = x => Math.round(x * 1000) / 1000;

function agg(bars, size, now) {
  const out = []; let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(cur); }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; }
  }
  return out.filter(x => x.t + size <= (now == null ? Infinity : now));
}

/* ---------- structure : BOS / CHoCH (causal : un événement n'utilise que le passé) */
function structure(bars, k, size) {
  const ev = []; let hi = null, lo = null, trend = 0;
  for (let j = 0; j < bars.length; j++) {
    const c = j - k;
    if (c >= k) {
      let isH = true, isL = true;
      for (let q = 1; q <= k; q++) {
        if (!(bars[c].h > bars[c - q].h && bars[c].h > bars[c + q].h)) isH = false;
        if (!(bars[c].l < bars[c - q].l && bars[c].l < bars[c + q].l)) isL = false;
      }
      if (isH) hi = { i: c, p: bars[c].h };
      if (isL) lo = { i: c, p: bars[c].l };
    }
    const b = bars[j];
    if (hi && b.c > hi.p) { ev.push({ i: j, dir: 1, level: hi.p, sh: hi.i, t: b.t + size }); trend = 1; hi = null; }
    else if (lo && b.c < lo.p) { ev.push({ i: j, dir: -1, level: lo.p, sh: lo.i, t: b.t + size }); trend = -1; lo = null; }
  }
  return { trend, events: ev };
}

/** Jambe d'impulsion d'un BOS : extrême du pullback, OB (dernière bougie opposée) et FVG. */
function legOf(bars, ev) {
  const up = ev.dir === 1; let s = -1;
  for (let q = ev.sh + 1; q <= ev.i; q++) { if (s < 0 || (up ? bars[q].l < bars[s].l : bars[q].h > bars[s].h)) s = q; }
  if (s < 0) return null;
  let ob = bars[s];
  for (let q = s; q >= Math.max(0, s - 3); q--) { if (up ? bars[q].c < bars[q].o : bars[q].c > bars[q].o) { ob = bars[q]; break; } }
  let fvg = false;
  for (let q = s + 1; q < ev.i; q++) { if (up ? bars[q - 1].h < bars[q + 1].l : bars[q - 1].l > bars[q + 1].h) { fvg = true; break; } }
  return { s, ext: up ? bars[s].l : bars[s].h, ob: { t: ob.t, l: ob.l, h: ob.h, mid: (ob.l + ob.h) / 2 }, fvg };
}

/* ---------- préparation (calculée UNE fois ; utilisée par le live ET par le backtest) */
function prep(sym, m5, m15, biasTf, now) {
  const size = biasTf === 'H1' ? H1 : H4, htf = agg(m15, size, now);
  const evH = structure(htf, 2, size).events.map(e => ({ dir: e.dir, t: e.t }));
  const s15 = structure(m15, 2, M15).events, s5 = structure(m5, 2, M5).events;
  const atr = new Array(m15.length).fill(0);
  for (let i = 1; i < m15.length; i++) {
    let sum = 0, n = 0;
    for (let q = Math.max(1, i - 13); q <= i; q++) { sum += Math.max(m15[q].h - m15[q].l, Math.abs(m15[q].h - m15[q - 1].c), Math.abs(m15[q].l - m15[q - 1].c)); n++; }
    atr[i] = sum / n;
  }
  const m5t = m5.map(b => b.t), m15c = m15.map(b => b.t + M15), zones = [];
  for (const ev of s15) {
    const leg = legOf(m15, ev); if (!leg) continue;
    const up = ev.dir === 1, z = { id: (up ? 'B' : 'S') + m15[leg.s].t, dir: ev.dir, lo: leg.ob.l, hi: leg.ob.h, mid: leg.ob.mid, fvg: leg.fvg, t0: ev.t, tTouch: Infinity, tDead: Infinity, far: up ? leg.ob.l : leg.ob.h };
    for (let q = lower(m5t, z.t0); q < m5.length && m5[q].t < z.t0 + MAX_ZONE_AGE; q++) {
      const b = m5[q];
      if (z.tTouch === Infinity && (up ? b.l <= z.hi : b.h >= z.lo)) z.tTouch = b.t + M5;
      if (up ? b.c < z.lo : b.c > z.hi) { z.tDead = b.t + M5; break; }
    }
    zones.push(z);
  }
  return { sym, m5, m15, evH, s15, s5, atr, zones, m5t, m15c, spec: pairSpec(sym), biasTf };
}
const lastDir = (list, T) => { const n = upper(list, T, 't'); return n ? list[n - 1].dir : 0; };

/* ---------- plan : SL min/max, TP en RR, BE à 50 % */
function mkPlan(P, type, dir, entry, extreme, rr, id, zone) {
  const sp = P.spec; let slDist = Math.abs(entry - (dir > 0 ? extreme - sp.buf : extreme + sp.buf));
  if (slDist > sp.max) return { skip: 'SL trop grand (> ' + sp.max + ')' };
  if (slDist < sp.min) slDist = sp.min;
  const tpDist = slDist * rr;
  return { id, type, dir, entry, sl: dir > 0 ? entry - slDist : entry + slDist, tp: dir > 0 ? entry + tpDist : entry - tpDist, be: dir > 0 ? entry + 0.5 * tpDist : entry - 0.5 * tpDist, slDist, tpDist, rr, zoneId: zone ? zone.id : null, far: zone ? zone.far : null };
}

/* ---------- probabilité MESURÉE d'une zone (table issue du backtest) */
const distBucket = (price, z, atr) => { const d = atr > 0 ? Math.abs(price - z.mid) / atr : 99; return d < 2 ? 0 : d < 5 ? 1 : 2; };
const zoneKeys = (z, price, atr) => { const d = distBucket(price, z, atr); return [(z.fvg ? 1 : 0) + '|' + d, '*|' + d, 'ALL']; };
function zoneProb(table, z, price, atr, minN) {
  if (!table) return null;
  for (const k of zoneKeys(z, price, atr)) { const e = table[k]; if (e && e.nFill >= minN) return Object.assign({ key: k, ok: e.meanR - e.se > 0 }, e); }
  return null;
}

/* ---------- décision à la clôture de la bougie M5 d'indice i */
function decide(P, i, cfg) {
  const m5 = P.m5, b = m5[i], T = b.t + M5, price = b.c, bias = lastDir(P.evH, T), trend15 = lastDir(P.s15, T);
  const out = { bias, trend15, plan: null, reason: bias ? 'aucun setup' : 'pas de biais', zones: [], price };
  if (!bias) return out;
  const wantLimit = cfg.mode === 'LIMIT' || cfg.mode === 'BOTH', wantDirect = cfg.mode === 'DIRECT' || cfg.mode === 'BOTH', rr = cfg.rr, plans = [];
  const n15 = upper(P.m15c, T), a = n15 > 0 ? P.atr[n15 - 1] : 0;
  for (const z of P.zones) {
    if (z.dir !== bias || z.t0 > T || z.t0 < T - MAX_ZONE_AGE || z.tDead <= T) continue;
    const fresh = z.tTouch > T, info = { id: z.id, dir: z.dir, lo: z.lo, hi: z.hi, mid: z.mid, fvg: z.fvg, t0: z.t0, fresh };
    if (fresh) {
      const pr = zoneProb(cfg.prob, z, price, a, cfg.minN || 30), plan = mkPlan(P, 'ZONE', bias, z.mid, z.far, rr, 'Z-' + z.id, z);
      info.prob = pr; info.skip = plan.skip || null; info.plan = plan.skip ? null : { entry: plan.entry, sl: plan.sl, tp: plan.tp, rr };
      if (wantLimit && !plan.skip && pr && pr.ok && (bias > 0 ? price > plan.entry && price < plan.be : price < plan.entry && price > plan.be)) plans.push(Object.assign(plan, { prob: pr, prio: 3 }));
    } else if (wantLimit && T - z.tTouch <= RETEST_WINDOW) {
      const n = upper(P.s5, T, 't'); let e = null;
      for (let q = n - 1; q >= 0 && P.s5[q].t > z.tTouch; q--) { if (P.s5[q].dir === bias) { e = P.s5[q]; break; } }
      if (e) {
        const leg = legOf(m5, e);
        if (leg && leg.ob.l <= z.hi && leg.ob.h >= z.lo) {
          const entry = Math.min(z.hi, Math.max(z.lo, leg.ob.mid)); let ext = bias > 0 ? z.lo : z.hi;
          for (let q = e.i; q >= 0 && m5[q].t + M5 >= z.tTouch; q--) ext = bias > 0 ? Math.min(ext, m5[q].l) : Math.max(ext, m5[q].h);
          const plan = mkPlan(P, 'RETEST', bias, entry, ext, rr, 'R-' + z.id + '-' + e.t, z);
          let missed = false;
          for (let q = e.i + 1; q <= i; q++) if (bias > 0 ? (m5[q].l <= entry || m5[q].h >= plan.be) : (m5[q].h >= entry || m5[q].l <= plan.be)) { missed = true; break; }
          if (!plan.skip && !missed && (bias > 0 ? price > entry : price < entry)) plans.push(Object.assign(plan, { prio: 1 }));
        }
      }
    }
    out.zones.push(info);
  }
  if (wantDirect && trend15 === bias) {
    const n = upper(P.s5, T, 't'), e = n ? P.s5[n - 1] : null;
    if (e && e.i === i && e.dir === bias) {
      const leg = legOf(m5, e);
      if (leg) { const plan = mkPlan(P, 'DIRECT', bias, price, leg.ext, rr, 'D-' + e.t, null); if (!plan.skip) plans.push(Object.assign(plan, { prio: 2 })); else out.reason = plan.skip; }
    }
  }
  plans.sort((x, y) => x.prio - y.prio);
  if (plans.length) { out.plan = plans[0]; out.reason = 'setup ' + plans[0].type; }
  return out;
}

/** Un ordre en attente est-il toujours valable ? (biais inchangé, zone vivante) */
function stillValid(P, plan, i) {
  const T = P.m5[i].t + M5;
  if (lastDir(P.evH, T) !== plan.dir) return { ok: false, reason: 'biais changé' };
  if (plan.zoneId) { const z = P.zones.find(x => x.id === plan.zoneId); if (!z || z.tDead <= T) return { ok: false, reason: 'zone invalidée' }; }
  return { ok: true };
}

/* ---------- vie d'un ordre sur les bougies M5 (backtest + échantillonnage des probabilités) */
function runOrder(plan, m5, i0, o) {
  const S = plan.dir > 0; let filled = false, stage = 0, sl = plan.sl, fillIdx = -1;
  const fin = (res, R, i) => ({ filled: true, res, R: R - (o.spread || 0) / plan.slDist, fillIdx, endIdx: i });
  for (let i = i0; i < m5.length; i++) {
    const b = m5[i];
    if (!filled) {
      if (o.market) { filled = true; fillIdx = i; }
      else {
        const touch = S ? b.l <= plan.entry : b.h >= plan.entry;
        if (!touch && (S ? b.h >= plan.be : b.l <= plan.be)) return { filled: false, cancel: 'loin', endIdx: i };
        if (plan.far != null && (S ? b.c < plan.far : b.c > plan.far)) return { filled: false, cancel: 'zone invalidée', endIdx: i };
        if (!touch && i - i0 > o.expire) return { filled: false, cancel: 'expiré', endIdx: i };
        if (touch) { filled = true; fillIdx = i; }
      }
      if (!filled) continue;
      if (S ? b.l <= sl : b.h >= sl) return fin('SL', -1, i);   // barre de remplissage : seul le SL est testé (prudent)
      continue;
    }
    if (S ? b.l <= sl : b.h >= sl) return stage ? fin('BE', 0, i) : fin('SL', -1, i);
    if (S ? b.h >= plan.tp : b.l <= plan.tp) return fin('TP', plan.rr, i);
    if (!stage && (S ? b.h >= plan.be : b.l <= plan.be)) { stage = 1; sl = plan.entry; }
  }
  return { filled, open: true, endIdx: m5.length - 1, fillIdx };
}

/* ---------- backtest chronologique : 1 trade / jour / paire, 1 position à la fois */
function backtest(P, o) {
  const cfg = { mode: o.mode, rr: o.rr, prob: o.prob || null, minN: o.minN || 30 }, m5 = P.m5, trades = [], used = new Set(), day = {};
  const from = o.from || 0, to = o.to || Infinity, spread = o.spread != null ? o.spread : P.spec.spread, evAt = new Set(P.s5.map(e => e.i));
  for (let i = 0; i < m5.length; i++) {
    const b = m5[i], T = b.t + M5; if (b.t < from) continue; if (T > to) break;
    if (!(evAt.has(i) || T % M15 === 0)) continue;
    const plan = decide(P, i, cfg).plan; if (!plan || used.has(plan.id)) continue;
    used.add(plan.id);
    const r = runOrder(plan, m5, i + 1, { market: plan.type === 'DIRECT', expire: plan.type === 'ZONE' ? ZONE_EXPIRE_BARS : LIMIT_EXPIRE_BARS, spread });
    if (r.filled) {
      const fd = new Date(m5[r.fillIdx].t).toISOString().slice(0, 10);
      if (!day[fd] && r.res) { day[fd] = 1; trades.push({ t: m5[r.fillIdx].t, type: plan.type, dir: plan.dir, res: r.res, R: r3(r.R), rr: plan.rr }); }
      i = r.endIdx; continue;
    }
    if (r.open) break;
    i = r.endIdx;
  }
  return trades;
}

/* ---------- probabilités mesurées : chaque zone M15 (biais aligné) -> ordre LIMIT théorique dans la zone */
function buildProb(P, o) {
  const m5 = P.m5, from = o.from || 0, to = o.to || Infinity, T = {};
  const add = (k, r) => { const e = T[k] || (T[k] = { n: 0, nFill: 0, nTp: 0, nBe: 0, sum: 0, sum2: 0 }); e.n++; if (r.filled && r.res) { e.nFill++; e.sum += r.R; e.sum2 += r.R * r.R; if (r.res === 'TP') e.nTp++; else if (r.res === 'BE') e.nBe++; } };
  for (const z of P.zones) {
    if (z.t0 < from || z.t0 > to || lastDir(P.evH, z.t0) !== z.dir) continue;
    const i0 = lower(P.m5t, z.t0); if (i0 < 1 || i0 >= m5.length || z.tTouch <= z.t0) continue;
    const n15 = upper(P.m15c, z.t0), a = n15 > 0 ? P.atr[n15 - 1] : 0, price = m5[i0 - 1].c, plan = mkPlan(P, 'ZONE', z.dir, z.mid, z.far, o.rr, 'Z-' + z.id, z);
    if (plan.skip || (z.dir > 0 ? !(price > plan.entry && price < plan.be) : !(price < plan.entry && price > plan.be))) continue;
    const r = runOrder(plan, m5, i0, { expire: ZONE_EXPIRE_BARS, spread: P.spec.spread });
    zoneKeys(z, price, a).forEach(k => add(k, r));
  }
  const out = {};
  Object.keys(T).forEach(k => {
    const e = T[k], mean = e.nFill ? e.sum / e.nFill : 0, vr = e.nFill > 1 ? Math.max(0, e.sum2 / e.nFill - mean * mean) : 1;
    out[k] = { n: e.n, nFill: e.nFill, pReturn: e.n ? r3(e.nFill / e.n) : 0, pTp: e.nFill ? r3(e.nTp / e.nFill) : 0, pBe: e.nFill ? r3(e.nBe / e.nFill) : 0, meanR: r3(mean), se: r3(Math.sqrt(vr / Math.max(1, e.nFill))) };
  });
  return out;
}

function statsOf(tr, weeks) {
  const n = tr.length, c = r => tr.filter(x => x.res === r).length, tp = c('TP'), be = c('BE'), sl = c('SL'), R = tr.reduce((a, x) => a + x.R, 0);
  return { trades: n, tp, be, sl, winTp: n ? Math.round(tp / n * 1000) / 10 : 0, winBe: n ? Math.round((tp + be) / n * 1000) / 10 : 0, rTotal: r3(R), rPerTrade: n ? r3(R / n) : 0, perWeek: weeks > 0 ? Math.round(n / weeks * 10) / 10 : 0 };
}

module.exports = { M5, M15, H1, H4, D1, PAIR_MATCH, pairSpec, agg, structure, legOf, prep, decide, stillValid, runOrder, backtest, buildProb, zoneProb, statsOf, mkPlan };
