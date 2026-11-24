'use strict';
/**
 * SMCRT — moteur de stratégie (fonctions pures, bougies FERMÉES uniquement, aucun repaint).
 *  H4  : CRT = bougie 1 (range) + bougie 2 qui balaie un côté et CLÔTURE à l'intérieur du range
 *  M15 : CHoCH après le sweep + POI (OB / FVG)
 *  M5  : OB M5 dans le POI M15 = prix d'entrée (ordre LIMIT)
 *  SL = au-delà de la mèche du sweep · TP1 = 50 % du range · TP2 = autre côté du range · aucun RR minimum.
 * Les bougies H4 sont construites depuis M15, alignées sur 00/04/08/12/16/20 UTC.
 */
const M5 = 300000, M15 = 900000, H4 = 14400000, D1 = 86400000;
const DEF = {
  fractalK: 2, maxAgeH4: 6, slBufRange: 0.02,
  riskBase: 2, riskHigh: 3, highScore: 80,      // % du solde ; risque haut si le score objectif >= highScore
  sessionFx: [[7, 11], [12, 16]]                 // killzones UTC (Forex / Gold). Indices synthétiques : 24/7
};
// motifs de noms de symbole (déjà normalisés : MAJUSCULES + lettres/chiffres). Les variantes « 1s » (ex. VOLATILITY751SINDEX) sont exclues.
const PAIR_MATCH = {
  XAUUSD: /^(XAUUSD|GOLD|XAU)/, EURUSD: /^EURUSD/,
  V75: /^(VOLATILITY|VOL|V|R)75(INDEX)?$|^VOLATILITY75(?!\d)|^VOL75(?!\d)/,
  V100: /^(VOLATILITY|VOL|V|R)100(INDEX)?$|^VOLATILITY100(?!\d)|^VOL100(?!\d)/
};
const isSynth = s => /VOLATILITY|^V\d|^R_\d|^1HZ|BOOM|CRASH|STEP/i.test(String(s || ''));

function agg(bars, size, now) {
  const out = []; let cur = null;
  for (const b of bars) {
    const k = Math.floor(b.t / size) * size;
    if (!cur || cur.t !== k) { cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(cur); }
    else { if (b.h > cur.h) cur.h = b.h; if (b.l < cur.l) cur.l = b.l; cur.c = b.c; }
  }
  return out.filter(x => x.t + size <= now);   // seulement les bougies complètes
}

function detectCRT(h4, cfg) {
  const n = h4.length;
  for (let a = 0; a < cfg.maxAgeH4 && n - 2 - a >= 0; a++) {
    const c2 = h4[n - 1 - a], c1 = h4[n - 2 - a];
    if (c2.h > c1.h && c2.c < c1.h && c2.c > c1.l && c2.l >= c1.l) return { dir: 'SELL', c1, c2, ext: c2.h, range: { h: c1.h, l: c1.l }, tClose: c2.t + H4 };
    if (c2.l < c1.l && c2.c > c1.l && c2.c < c1.h && c2.h <= c1.h) return { dir: 'BUY', c1, c2, ext: c2.l, range: { h: c1.h, l: c1.l }, tClose: c2.t + H4 };
  }
  return null;
}

/** Analyse complète. m15/m5 : bougies fermées triées. Retourne { state, reason, ...setup } */
function analyze(sym, m15, m5, now, userCfg) {
  const cfg = Object.assign({}, DEF, userCfg || {}), K = cfg.fractalK;
  if (!m15 || m15.length < 120 || !m5 || m5.length < 60) return { state: 'SCAN', reason: 'historique insuffisant' };
  const h4 = agg(m15, H4, now), crt = detectCRT(h4, cfg);
  if (!crt) return { state: 'SCAN', reason: 'aucun CRT H4 valide' };
  const S = crt.dir === 'SELL', rng = crt.range.h - crt.range.l;
  if (!(rng > 0)) return { state: 'SCAN', reason: 'range nul' };
  const base = { id: crt.dir + '-' + crt.c2.t, dir: crt.dir, range: crt.range, ext: crt.ext, crtAt: crt.tClose };
  // bougie M15 du sweep (extrême) dans la bougie 2
  let ei = -1;
  for (let i = 0; i < m15.length; i++) {
    const b = m15[i]; if (b.t < crt.c2.t) continue; if (b.t >= crt.c2.t + H4) break;
    if (S ? b.h === crt.ext : b.l === crt.ext) { ei = i; break; }
  }
  if (ei < 0) return Object.assign(base, { state: 'SCAN', reason: 'bougie du sweep introuvable' });
  // sweep étendu après la clôture : invalide
  for (let i = ei + 1; i < m15.length; i++) if (S ? m15[i].c > crt.ext : m15[i].c < crt.ext) return Object.assign(base, { state: 'INVALID', reason: 'sweep dépassé (cassure)' });
  // niveau de structure à casser (dernier creux/sommet fractal avant l'extrême)
  let ref = null;
  for (let i = ei - K; i >= Math.max(K, ei - 40); i--) {
    let ok = true;
    for (let j = 1; j <= K; j++) { if (S ? !(m15[i].l < m15[i - j].l && m15[i].l < m15[i + j].l) : !(m15[i].h > m15[i - j].h && m15[i].h > m15[i + j].h)) { ok = false; break; } }
    if (ok) { ref = S ? m15[i].l : m15[i].h; break; }
  }
  if (ref == null) { const w = m15.slice(Math.max(0, ei - 8), ei); if (!w.length) return Object.assign(base, { state: 'SCAN', reason: 'structure absente' }); ref = S ? Math.min.apply(null, w.map(x => x.l)) : Math.max.apply(null, w.map(x => x.h)); }
  let ci = -1;
  for (let i = ei + 1; i < m15.length; i++) if (S ? m15[i].c < ref : m15[i].c > ref) { ci = i; break; }
  if (ci < 0) return Object.assign(base, { state: 'WAIT_CHOCH', reason: 'en attente CHoCH M15' });
  const leg = m15.slice(ei, ci + 1);
  // OB M15 : dernière bougie de sens opposé avant la cassure ; sinon bougie du sweep
  let ob = m15[ei];
  for (let i = ci - 1; i >= ei; i--) if (S ? m15[i].c > m15[i].o : m15[i].c < m15[i].o) { ob = m15[i]; break; }
  let zone = { l: ob.l, h: ob.h }, fvg = false;
  for (let i = ei + 1; i < ci; i++) {   // FVG dans le mouvement
    if (S && m15[i - 1].l > m15[i + 1].h) { fvg = true; zone = { l: Math.max(zone.l, m15[i + 1].h) <= m15[i - 1].l ? Math.min(zone.l, m15[i + 1].h) : zone.l, h: Math.max(zone.h, m15[i - 1].l) }; }
    if (!S && m15[i - 1].h < m15[i + 1].l) { fvg = true; zone = { l: Math.min(zone.l, m15[i - 1].h), h: Math.max(zone.h, m15[i + 1].l) }; }
  }
  // entrée M5 : dernier OB M5 qui chevauche le POI M15
  const t0 = m15[ei].t, t1 = m15[ci].t + M15;
  let e5 = null;
  for (let i = m5.length - 1; i >= 0; i--) {
    const b = m5[i]; if (b.t >= t1 || b.t < t0) continue;
    if ((S ? b.c > b.o : b.c < b.o) && b.l <= zone.h && b.h >= zone.l) { e5 = b; break; }
  }
  let entry = e5 ? (e5.h + e5.l) / 2 : (zone.h + zone.l) / 2;
  entry = Math.min(zone.h, Math.max(zone.l, entry));
  const sl = S ? crt.ext + cfg.slBufRange * rng : crt.ext - cfg.slBufRange * rng, tp1 = (crt.range.h + crt.range.l) / 2, tp2 = S ? crt.range.l : crt.range.h;
  if (S ? !(sl > entry && entry > tp1) : !(sl < entry && entry < tp1)) return Object.assign(base, { state: 'INVALID', reason: 'géométrie invalide (entrée / TP1)' });
  // déjà touché après le CHoCH : on ne court pas après le prix
  for (const b of m5) { if (b.t < t1) continue; if (S ? b.h >= entry : b.l <= entry) return Object.assign(base, { state: 'MISSED', reason: 'zone déjà touchée' }); if (S ? b.l <= tp1 : b.h >= tp1) return Object.assign(base, { state: 'MISSED', reason: 'TP1 déjà atteint' }); }
  const risk = Math.abs(sl - entry), rr1 = Math.abs(entry - tp1) / risk, rr2 = Math.abs(entry - tp2) / risk;
  // score objectif /100
  const days = agg(m15, D1, now); let score = 0; const why = [];
  if (days.length) { const d = days[days.length - 1], bull = d.c > d.o; if (S ? !bull : bull) { score += 30; why.push('Daily'); } }
  const bodies = m15.slice(Math.max(0, ci - 14), ci).map(x => Math.abs(x.c - x.o)), avg = bodies.length ? bodies.reduce((a, b) => a + b, 0) / bodies.length : 0;
  if (avg > 0 && Math.abs(m15[ci].c - m15[ci].o) >= 1.2 * avg) { score += 25; why.push('displacement'); }
  if (fvg) { score += 20; why.push('FVG'); }
  if (Math.abs(crt.ext - (S ? crt.range.h : crt.range.l)) >= 0.1 * rng) { score += 10; why.push('sweep profond'); }
  const hr = new Date(now).getUTCHours();
  if (isSynth(sym) || cfg.sessionFx.some(w => hr >= w[0] && hr < w[1])) { score += 15; why.push('session'); }
  return Object.assign(base, { state: 'SETUP', reason: 'setup prêt', entry, sl, tp1, tp2, rr1, rr2, score, why, riskPct: score >= cfg.highScore ? cfg.riskHigh : cfg.riskBase, zone, chochAt: m15[ci].t + M15, fvg });
}

/** Backtest d'une paire sur données M15 + M5 (mêmes fonctions que le live). 1 trade / jour, TP1 50 % puis BE. Hypothèse prudente : SL avant TP dans la même bougie. */
function backtest(sym, m15, m5, opts) {
  opts = opts || {}; const cfg = Object.assign({}, DEF, opts.cfg || {}), from = opts.from || (m5.length ? m5[0].t : 0), to = opts.to || Infinity;
  const trades = []; let pend = null, pos = null, i15 = 0; const days = {};
  for (let i = 0; i < m5.length; i++) {
    const b = m5[i], tNow = b.t + M5; if (b.t < from) continue; if (tNow > to) break;
    if (pos) {   // gestion position
      const S = pos.dir === 'SELL', fill = pos.openBar === i;
      const hitSL = S ? b.h >= pos.sl : b.l <= pos.sl;
      if (hitSL) { close(pos.stage === 0 ? 'SL' : 'BE', pos.stage === 0 ? -1 : pos.R1); pos = null; }
      else if (!fill) {
        if (pos.stage === 0 && (S ? b.l <= pos.tp1 : b.h >= pos.tp1)) { pos.stage = 1; pos.R1 = 0.5 * pos.rr1; pos.sl = pos.entry; }
        if (pos && pos.stage === 1 && (S ? b.l <= pos.tp2 : b.h >= pos.tp2)) { close('TP2', pos.R1 + 0.5 * pos.rr2); pos = null; }
      }
      continue;
    }
    if (pend) {   // ordre limit en attente
      const S = pend.dir === 'SELL', d = new Date(b.t).toISOString().slice(0, 10);
      if (S ? b.h >= pend.entry : b.l <= pend.entry) {
        if (days[d]) pend = null; else { days[d] = 1; pos = { dir: pend.dir, entry: pend.entry, sl: pend.sl, tp1: pend.tp1, tp2: pend.tp2, rr1: pend.rr1, rr2: pend.rr2, score: pend.score, riskPct: pend.riskPct, stage: 0, openBar: i, openT: b.t, R1: 0 }; pend = null; i--; continue; }
      }
    }
    // à chaque clôture M15 : (ré)évaluer
    if (tNow % M15 === 0) {
      while (i15 < m15.length && m15[i15].t + M15 <= tNow) i15++;
      const r = analyze(sym, m15.slice(Math.max(0, i15 - 800), i15), m5.slice(Math.max(0, i - 600), i + 1), tNow, cfg);
      if (r.state === 'SETUP') { if (!pend || pend.id !== r.id) pend = r; } else pend = null;
    }
  }
  function close(res, R) { trades.push({ t: pos.openT, dir: pos.dir, entry: pos.entry, res, R: Math.round(R * 100) / 100, rr1: pos.rr1, rr2: pos.rr2, score: pos.score, riskPct: pos.riskPct }); }
  return { symbol: sym, trades, stats: statsOf(trades, from, to === Infinity && m5.length ? m5[m5.length - 1].t : to) };
}

function statsOf(tr, from, to) {
  const n = tr.length, c = r => tr.filter(x => x.res === r).length, sl = c('SL'), be = c('BE'), tp2 = c('TP2'), wins = be + tp2;
  const weeks = Math.max(1, (to - from) / (7 * D1));
  return { trades: n, wins, losses: sl, winrate: n ? Math.round(wins / n * 1000) / 10 : 0, tp1: wins, tp2, sl, be, rrTotal: Math.round(tr.reduce((a, x) => a + x.R, 0) * 100) / 100, perWeek: Math.round(n / weeks * 10) / 10 };
}
function mergeStats(list) { const all = [].concat.apply([], list.map(x => x.trades)); const f = Math.min.apply(null, all.map(x => x.t).concat([Infinity])), l = Math.max.apply(null, all.map(x => x.t).concat([0])); return statsOf(all, f === Infinity ? 0 : f, l); }

module.exports = { PAIR_MATCH, analyze, backtest, statsOf, mergeStats, agg, detectCRT, isSynth, DEF, H4, M15, M5 };
