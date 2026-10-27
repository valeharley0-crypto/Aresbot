'use strict';
/**
 * LOR — LONDON OPEN REVERSAL · XAU/USD · bougies M5 (UTC / GMT)
 * 1) Range asiatique 00:00-07:00 GMT (Asian high / low)
 * 2) Biais HTF H4 (structure HH+HL / LH+LL) : contre-sens interdit (option)
 * 3) 07:00-10:00 GMT : SWEEP du Asian low (BUY) ou du Asian high (SELL)
 * 4) CHoCH M5 : clôture au-delà du dernier swing qui a mené au sweep
 * 5) Entrée LIMIT sur le FVG (ou l'OB) créé par le CHoCH · discount (BUY) / premium (SELL)
 * 6) SL au-delà de l'extrême du sweep · TP : milieu / extrême opposé du range asiatique ou RR fixe
 * 1 trade par jour maximum. Aucune donnée simulée. Pas de look-ahead : à la bougie k, seules les bougies fermées <= k sont lues.
 * Le même fichier sert au robot (Node) et au backtest du site (navigateur).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LOR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const M5 = 300000, DAY = 86400000;
  const DEFAULTS = {
    asiaStart: '00:00', asiaEnd: '07:00', winStart: '07:00', winEnd: '10:00',   // GMT
    asiaMin: 3, asiaMax: 25,        // taille du range asiatique ($ de prix) : hors limites = pas de trade
    biasFilter: true,               // H4 : interdit de trader contre la structure (neutre accepté)
    sweepBuf: 0.1,                  // le prix doit dépasser le Asian high/low d'au moins 0,10 $
    maxChochBars: 24,               // CHoCH au plus tard 24 bougies M5 (2 h) après le sweep
    fillBars: 12,                   // validité de l'ordre limit (bougies M5) après le CHoCH
    entry: 'mid',                   // 'mid' : 50 % du FVG/OB · 'edge' : bord du FVG/OB
    useOB: true,                    // OB si aucun FVG
    pdFilter: true,                 // BUY sous le milieu du range asiatique, SELL au-dessus
    slBuf: 0.3, slMin: 1.5, slMax: 8,   // marge au-delà du sweep, SL min / max ($ de prix)
    target: 'opposite',             // 'mid' (TP1) · 'opposite' (TP2) · 'rr' (RR fixe)
    rr: 3, minRR: 1.5,              // RR cible si target='rr' ; RR minimum exigé sinon
    beAfterMid: false,              // SL au prix d'entrée dès que le milieu du range est touché
    noFriday: false,
    closeUtc: '16:00'               // sortie forcée (backtest) si ni SL ni TP
  };
  const hm = s => { const a = String(s).split(':').map(Number); return (a[0] || 0) * 60 + (a[1] || 0); };
  const minOf = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
  const dayOf = t => Math.floor(t / DAY);
  const dateStr = t => new Date(t).toISOString().slice(0, 10);
  const r2 = v => Math.round(v * 100) / 100;

  /** Biais H4 à partir des M5 FERMÉES avant `before` : swings fractals 1-1 sur les 14 dernières bougies H4. */
  function bias(m5, before) {
    const H4 = 4 * 3600000, map = new Map();
    for (let i = m5.length - 1; i >= 0; i--) {
      const x = m5[i]; if (x.t + M5 > before) continue;
      const k = Math.floor(x.t / H4); if (map.size > 16 && !map.has(k)) break;
      const b = map.get(k); if (!b) map.set(k, { t: k * H4, h: x.h, l: x.l }); else { if (x.h > b.h) b.h = x.h; if (x.l < b.l) b.l = x.l; }
    }
    const h = [...map.values()].sort((a, b) => a.t - b.t); if (h.length) { const last = h[h.length - 1]; if (last.t + H4 > before) h.pop(); }
    const H = [], L = [];
    for (let i = 1; i < h.length - 1; i++) { if (h[i].h > h[i - 1].h && h[i].h > h[i + 1].h) H.push(h[i].h); if (h[i].l < h[i - 1].l && h[i].l < h[i + 1].l) L.push(h[i].l); }
    if (H.length < 2 || L.length < 2) return 'neutral';
    const h1 = H[H.length - 1], h0 = H[H.length - 2], l1 = L[L.length - 1], l0 = L[L.length - 2];
    return h1 > h0 && l1 > l0 ? 'bull' : (h1 < h0 && l1 < l0 ? 'bear' : 'neutral');
  }

  /** Dernier swing (fractal 2-2) avant la bougie i : haut (BUY) ou bas (SELL) ; repli : extrême des 6 dernières bougies. */
  function swingBefore(c, i, up) {
    for (let j = i - 3; j >= Math.max(2, i - 26); j--) {
      const v = up ? c[j].h : c[j].l; let ok = true;
      for (let q = j - 2; q <= j + 2; q++) { if (q === j || q >= i) continue; if (up ? c[q].h >= v : c[q].l <= v) { ok = false; break; } }
      if (ok) return v;
    }
    let m = up ? -Infinity : Infinity;
    for (let j = Math.max(0, i - 6); j < i; j++) m = up ? Math.max(m, c[j].h) : Math.min(m, c[j].l);
    return m;
  }

  /**
   * Analyse d'UNE journée. day = bougies M5 (UTC) du jour (triées), hist = M5 antérieures (pour le biais H4), now = horloge (ms).
   * Retourne { stage, note, date, asia, bias, side, sweep, choch, zone, plan, fillIdx, reason }.
   * stage : WAIT_ASIA · NO_DATA · BLOCKED · RANGE_OUT · WATCHING · SWEPT · ARMED (ordre limit prêt) · FILLED · NO_ZONE · NO_RR · EXPIRED · NO_SETUP
   */
  function analyzeDay(day, hist, cfgIn, now) {
    const C = Object.assign({}, DEFAULTS, cfgIn || {}), out = { stage: 'WAIT_ASIA', note: '', date: day.length ? dateStr(day[0].t) : null, asia: null, bias: null, side: null, sweep: null, choch: null, zone: null, plan: null, fillIdx: -1 };
    if (!day.length) { out.stage = 'NO_DATA'; out.note = 'Aucune bougie M5'; return out; }
    const dow = new Date(day[0].t).getUTCDay();
    if (dow === 0 || dow === 6) { out.stage = 'BLOCKED'; out.note = 'Week-end'; return out; }
    if (C.noFriday && dow === 5) { out.stage = 'BLOCKED'; out.note = 'Pas de trade le vendredi'; return out; }
    const aS = hm(C.asiaStart), aE = hm(C.asiaEnd), wS = hm(C.winStart), wE = hm(C.winEnd);
    const closed = day.filter(x => x.t + M5 <= now);
    const asiaC = closed.filter(x => { const m = minOf(x.t); return m >= aS && m < aE; });
    if (!closed.some(x => minOf(x.t) >= aE)) { out.note = 'Range asiatique en formation'; return out; }
    if (asiaC.length < Math.floor((aE - aS) / 5 * 0.6)) { out.stage = 'NO_DATA'; out.note = 'Bougies asiatiques insuffisantes'; return out; }
    const hi = Math.max(...asiaC.map(x => x.h)), lo = Math.min(...asiaC.map(x => x.l)), size = hi - lo;
    out.asia = { hi: r2(hi), lo: r2(lo), mid: r2((hi + lo) / 2), size: r2(size) };
    if (size < C.asiaMin || size > C.asiaMax) { out.stage = 'RANGE_OUT'; out.note = 'Range asiatique ' + r2(size) + ' $ hors limites (' + C.asiaMin + '–' + C.asiaMax + ')'; return out; }
    out.bias = bias(hist, day[0].t + wS * 60000);
    out.stage = 'WATCHING'; out.note = 'Attente du sweep du Asian high/low (' + C.winStart + '–' + C.winEnd + ' GMT)';
    const mid = (hi + lo) / 2, c = closed;   // c = bougies fermées de la journée
    let side = 0, sw = -1, ext = 0, lvl = 0, ch = -1;
    for (let i = 0; i < c.length; i++) {
      const x = c[i], m = minOf(x.t);
      if (m < wS) continue;
      if (ch < 0) {
        if (!side) {
          if (m >= wE) { out.stage = 'NO_SETUP'; out.note = 'Aucun sweep dans la fenêtre ' + C.winStart + '–' + C.winEnd; return out; }
          const bu = x.l < lo - C.sweepBuf, se = x.h > hi + C.sweepBuf;
          if (bu === se) continue;   // aucun sweep, ou les deux côtés sur la même bougie (ambigu) : ignoré
          const s = bu ? 1 : -1;
          if (C.biasFilter && ((s === 1 && out.bias === 'bear') || (s === -1 && out.bias === 'bull'))) { out.note = 'Sweep ' + (bu ? 'du low' : 'du high') + ' ignoré : contre le biais H4 (' + out.bias + ')'; continue; }
          side = s; sw = i; ext = bu ? x.l : x.h; lvl = swingBefore(c, i, bu);
          out.side = bu ? 'BUY' : 'SELL'; out.sweep = { t: x.t, price: r2(ext) }; out.stage = 'SWEPT'; out.note = 'Sweep détecté : attente du CHoCH M5';
        } else {
          if (side === 1 ? x.l < ext : x.h > ext) ext = side === 1 ? x.l : x.h;
          if (i - sw > C.maxChochBars) { out.stage = 'NO_SETUP'; out.note = 'Pas de CHoCH dans les ' + C.maxChochBars + ' bougies après le sweep'; return out; }
          if (side === 1 ? x.c > lvl : x.c < lvl) { ch = i; out.choch = { t: x.t, level: r2(lvl) }; } else continue;
        }
      }
      if (ch >= 0 && !out.zone) {
        // zone d'entrée créée par le déplacement (sweep -> CHoCH) : dernier FVG, sinon OB
        let z = null;
        for (let k = ch - 1; k > sw; k--) {
          if (side === 1 && c[k - 1].h < c[k + 1].l) { z = { type: 'FVG', lo: c[k - 1].h, hi: c[k + 1].l }; break; }
          if (side === -1 && c[k - 1].l > c[k + 1].h) { z = { type: 'FVG', lo: c[k + 1].h, hi: c[k - 1].l }; break; }
        }
        if (!z && C.useOB) for (let k = ch - 1; k >= sw; k--) { const o = c[k]; if (side === 1 ? o.c < o.o : o.c > o.o) { z = { type: 'OB', lo: o.l, hi: o.h }; break; } }
        if (!z) { out.stage = 'NO_ZONE'; out.note = 'CHoCH sans FVG ni OB : pas de trade'; return out; }
        const entry = C.entry === 'edge' ? (side === 1 ? z.hi : z.lo) : (z.lo + z.hi) / 2;
        const sl = side === 1 ? ext - C.slBuf : ext + C.slBuf, risk = Math.abs(entry - sl);
        out.zone = { type: z.type, lo: r2(z.lo), hi: r2(z.hi), entry: r2(entry) };
        if (risk < C.slMin || risk > C.slMax) { out.stage = 'NO_ZONE'; out.note = 'SL ' + r2(risk) + ' $ hors limites (' + C.slMin + '–' + C.slMax + ')'; return out; }
        if (C.pdFilter && (side === 1 ? entry > mid : entry < mid)) { out.stage = 'NO_ZONE'; out.note = 'Entrée hors ' + (side === 1 ? 'discount' : 'premium') + ' du range asiatique'; return out; }
        const tp = C.target === 'mid' ? mid : C.target === 'rr' ? entry + side * C.rr * risk : (side === 1 ? hi : lo), rr = (tp - entry) * side / risk;
        if (!(rr >= (C.target === 'rr' ? C.rr : C.minRR) - 1e-9) || (tp - entry) * side <= 0) { out.stage = 'NO_RR'; out.note = 'RR ' + r2(rr) + ' < minimum : pas de trade'; return out; }
        out.plan = { dir: side === 1 ? 'BUY' : 'SELL', entry: r2(entry), sl: r2(sl), tp: r2(tp), mid: r2(mid), risk: r2(risk), rr: r2(rr), ext: r2(ext), expireIdx: ch + C.fillBars };
        out.stage = 'ARMED'; out.note = 'Ordre limit ' + out.plan.dir + ' @ ' + out.plan.entry + ' (' + z.type + ')';
        out.reason = 'LOR ' + out.plan.dir + ' · sweep Asian ' + (side === 1 ? 'low ' + out.asia.lo : 'high ' + out.asia.hi) + ' · CHoCH ' + out.choch.level + ' · ' + z.type + ' ' + out.zone.lo + '-' + out.zone.hi + ' · SL ' + out.plan.sl + ' · TP ' + out.plan.tp + ' · RR ' + out.plan.rr;
        out._ch = ch;
        continue;
      }
      if (out.plan && i > ch) {   // remplissage de l'ordre limit
        const p = out.plan;
        if (out.fillIdx < 0) {
          if (side === 1 ? x.l <= p.sl : x.h >= p.sl) { out.stage = 'EXPIRED'; out.note = 'Le prix a pris le SL avant le remplissage'; return out; }
          if (i > p.expireIdx) { out.stage = 'EXPIRED'; out.note = 'Ordre limit expiré (' + C.fillBars + ' bougies)'; return out; }
          if (side === 1 ? x.l <= p.entry : x.h >= p.entry) { out.fillIdx = i; out.stage = 'FILLED'; out.note = 'Ordre rempli @ ' + p.entry; return out; }
        }
      }
    }
    if (out.stage === 'ARMED' && out.plan && c.length - 1 > out.plan.expireIdx) { out.stage = 'EXPIRED'; out.note = 'Ordre limit expiré'; }
    return out;
  }

  /** Simule la sortie d'un trade rempli (bougies M5 suivantes). Retourne { r, outcome, exitT, bars }. SL prioritaire sur la même bougie. */
  function simulate(day, a, cfgIn, spread) {
    const C = Object.assign({}, DEFAULTS, cfgIn || {}), p = a.plan, s = p.dir === 'BUY' ? 1 : -1, risk = p.risk, cost = (spread || 0) / risk;
    const endM = hm(C.closeUtc);
    let sl = p.sl, be = false, outcome = 'TIME', r = null, exitT = null;
    const f = day[a.fillIdx];
    if (s === 1 ? f.l <= sl : f.h >= sl) return { r: -1 - cost, outcome: 'SL', exitT: f.t };   // sur la bougie de remplissage seul le SL est évalué
    for (let j = a.fillIdx + 1; j < day.length; j++) {
      const y = day[j];
      if (s === 1 ? y.l <= sl : y.h >= sl) { r = be ? 0 : -1; outcome = be ? 'BE' : 'SL'; exitT = y.t; break; }
      if (C.beAfterMid && !be && (s === 1 ? y.h >= p.mid : y.l <= p.mid) && Math.abs(p.mid - p.entry) < Math.abs(p.tp - p.entry)) { be = true; sl = p.entry; }
      if (s === 1 ? y.h >= p.tp : y.l <= p.tp) { r = p.rr; outcome = 'TP'; exitT = y.t; break; }
      if (minOf(y.t) >= endM) { r = (y.c - p.entry) * s / risk; exitT = y.t; break; }
    }
    if (r == null) { const y = day[day.length - 1]; r = (y.c - p.entry) * s / risk; exitT = y.t; }
    return { r: r - cost, outcome: outcome === 'TIME' ? (r > 0 ? 'TIME+' : 'TIME−') : outcome, exitT };
  }

  /**
   * Sortie du ROBOT (même schéma que scalper.js) : le lot TOTAL est réparti en 2 positions.
   *   position 1 (tp1Frac, 50 %) -> TP1 = tp1R (RR 1) ; dès que TP1 est touché, le SL de la position 2 passe au prix d'entrée (BE, effectif à la bougie SUIVANTE) ;
   *   position 2 (le reste) -> TP2 = tp2R (RR 3). SL testé AVANT les TP dans une même bougie (pessimiste). Sortie forcée à closeUtc.
   * R net = tp1Frac × R1 + (1 − tp1Frac) × R2 − coût du spread. Gagnant si R net > 0 (TP1 + BE = +0,5 R).
   */
  function simulateSplit(day, a, cfgIn, spread, spl) {
    const C = Object.assign({}, DEFAULTS, cfgIn || {}), p = a.plan, s = p.dir === 'BUY' ? 1 : -1, risk = p.risk, cost = (spread || 0) / risk, endM = hm(C.closeUtc);
    const sp = Object.assign({ tp1R: 1, tp1Frac: 0.5, tp2R: 3 }, spl || {}), fr = Math.min(0.99, Math.max(0.01, sp.tp1Frac));
    const tp1 = p.entry + s * sp.tp1R * risk, tp2 = p.entry + s * sp.tp2R * risk, f = day[a.fillIdx];
    if (s === 1 ? f.l <= p.sl : f.h >= p.sl) return { r: -1 - cost, outcome: 'SL', exitT: f.t, tp1Hit: false, tp2Hit: false };   // sur la bougie de remplissage seul le SL est évalué
    let sl = p.sl, tp1Hit = false, beNext = false, r1 = null, r2 = null, exitT = null, why = null;
    const open = y => (y.c - p.entry) * s / risk;
    for (let j = a.fillIdx + 1; j < day.length; j++) {
      const y = day[j];
      if (beNext) { sl = p.entry; beNext = false; }   // BE actif à partir de la bougie qui suit TP1
      if (s === 1 ? y.l <= sl : y.h >= sl) { if (!tp1Hit) { r1 = -1; r2 = -1; why = 'SL'; } else { r2 = 0; why = 'BE'; } exitT = y.t; break; }
      if (!tp1Hit && (s === 1 ? y.h >= tp1 : y.l <= tp1)) { tp1Hit = true; r1 = sp.tp1R; beNext = true; }
      if (tp1Hit && (s === 1 ? y.h >= tp2 : y.l <= tp2)) { r2 = sp.tp2R; why = 'TP'; exitT = y.t; break; }
      if (minOf(y.t) >= endM) { const o = open(y); if (!tp1Hit) { r1 = o; r2 = o; } else r2 = o; why = 'TIME'; exitT = y.t; break; }
    }
    if (r2 == null) { const y = day[day.length - 1], o = open(y); if (!tp1Hit) { r1 = o; r2 = o; } else r2 = o; why = 'TIME'; exitT = y.t; }
    const r = fr * r1 + (1 - fr) * r2 - cost;
    return { r, outcome: why === 'TIME' ? (r > 0 ? 'TIME+' : 'TIME−') : why, exitT, tp1Hit, tp2Hit: why === 'TP' };
  }

  const stat = () => ({ trades: 0, tp: 0, sl: 0, be: 0, time: 0, wins: 0, usd: 0, r: 0 });
  function add(s, t) { s.trades++; s.r += t.r; s.usd += t.usd; if (t.outcome === 'TP') s.tp++; else if (t.outcome === 'SL') s.sl++; else if (t.outcome === 'BE') s.be++; else s.time++; if (t.r > 0) s.wins++; }
  function fin(s) { s.winRate = s.trades ? s.wins / s.trades * 100 : null; s.avgR = s.trades ? s.r / s.trades : null; return s; }

  /** Backtest sur une série M5 (UTC, triée). opts : { spread, riskUsd, onProgress }. */
  function backtest(m5, cfgIn, opts) {
    const o = Object.assign({ spread: 0.25, riskUsd: 20 }, opts || {}), C = Object.assign({}, DEFAULTS, cfgIn || {});
    const days = new Map(), starts = [];
    for (let i = 0; i < m5.length; i++) { const k = dayOf(m5[i].t); if (!days.has(k)) { days.set(k, []); starts.push([k, i]); } days.get(k).push(m5[i]); }
    const trades = [], funnel = { days: 0, rangeOut: 0, noSweep: 0, noZone: 0, noRR: 0, expired: 0, filled: 0 }, robot = o.split ? { st: stat(), eq: 0, pk: 0, dd: 0 } : null, robotTrades = [];
    const by = { BUY: stat(), SELL: stat(), TOTAL: stat() }, monthly = {}, reasons = {}, byRR = {};
    for (let n = 0; n < starts.length; n++) {
      const k = starts[n][0], idx0 = starts[n][1], day = days.get(k);
      if (new Date(day[0].t).getUTCDay() % 6 === 0) continue;
      if (o.from && day[0].t < o.from) continue;   // jours avant `from` : historique du biais H4 seulement
      funnel.days++;
      const hist = m5.slice(Math.max(0, idx0 - 1500), idx0);   // ~5 jours de M5 : assez pour ~16 bougies H4 (biais)
      const a = analyzeDay(day, hist, C, day[day.length - 1].t + M5);
      reasons[a.stage] = (reasons[a.stage] || 0) + 1;
      if (a.stage === 'RANGE_OUT') funnel.rangeOut++; else if (a.stage === 'NO_SETUP' || a.stage === 'WATCHING' || a.stage === 'SWEPT') funnel.noSweep++;
      else if (a.stage === 'NO_ZONE') funnel.noZone++; else if (a.stage === 'NO_RR') funnel.noRR++; else if (a.stage === 'EXPIRED' || a.stage === 'ARMED') funnel.expired++;
      if (a.stage === 'FILLED' && o.rrList && o.rrList.length) {   // mode « résultats par RR » : même setup, TP fixe à chaque RR demandé
        funnel.filled++;
        o.rrList.forEach(rr => {
          const p = a.plan, sg = p.dir === 'BUY' ? 1 : -1, plan2 = Object.assign({}, p, { tp: p.entry + sg * rr * p.risk, rr });
          const sm = simulate(day, { plan: plan2, fillIdx: a.fillIdx }, C, o.spread), t = { t: day[a.fillIdx].t, date: a.date, dir: p.dir, r: sm.r, usd: sm.r * o.riskUsd, outcome: sm.outcome };
          const b = byRR[rr] = byRR[rr] || { st: stat(), eq: 0, pk: 0, dd: 0 }; add(b.st, t); b.eq += t.r; if (b.eq > b.pk) b.pk = b.eq; if (b.pk - b.eq > b.dd) b.dd = b.pk - b.eq;
        });
        if (robot) {   // sortie du ROBOT : TP1 50 % @ RR 1 -> BE -> TP2 @ RR 3
          const p = a.plan, sm = simulateSplit(day, a, C, o.spread, o.split), t = { t: day[a.fillIdx].t, date: a.date, dir: p.dir, entry: p.entry, sl: p.sl, rr: o.split.tp2R || 3, r: sm.r, usd: sm.r * o.riskUsd, outcome: sm.outcome, exitT: sm.exitT, tp1Hit: sm.tp1Hit, tp2Hit: sm.tp2Hit, zone: a.zone.type, asia: a.asia };
          add(robot.st, t); robotTrades.push(t); robot.eq += t.r; if (robot.eq > robot.pk) robot.pk = robot.eq; if (robot.pk - robot.eq > robot.dd) robot.dd = robot.pk - robot.eq;
        }
      } else if (a.stage === 'FILLED') {
        funnel.filled++;
        const s = o.split ? simulateSplit(day, a, C, o.spread, o.split) : simulate(day, a, C, o.spread), usd = s.r * o.riskUsd, p = a.plan;
        const t = { t: day[a.fillIdx].t, date: a.date, dir: p.dir, entry: p.entry, sl: p.sl, tp: p.tp, rr: o.split ? (o.split.tp2R || 3) : p.rr, r: s.r, usd, outcome: s.outcome, exitT: s.exitT, tp1Hit: s.tp1Hit, tp2Hit: s.tp2Hit, zone: a.zone.type, asia: a.asia };
        trades.push(t); add(by[p.dir], t); add(by.TOTAL, t);
        const mk = a.date.slice(0, 7); add(monthly[mk] = monthly[mk] || stat(), t);
      }
      if (o.onProgress && n % 10 === 0) o.onProgress(n / starts.length);
    }
    ['BUY', 'SELL', 'TOTAL'].forEach(k => fin(by[k])); Object.keys(monthly).forEach(k => fin(monthly[k]));
    let eq = 0, peak = 0, dd = 0; trades.forEach(t => { eq += t.r; if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; });
    Object.keys(byRR).forEach(k => { fin(byRR[k].st); byRR[k].st.dd = byRR[k].dd; });
    if (robot) { fin(robot.st); robot.st.dd = robot.dd; }
    return { trades, by, monthly, byRR, robot: robot ? robot.st : null, robotTrades, funnel, reasons, maxDdR: dd, from: m5.length ? m5[0].t : null, to: m5.length ? m5[m5.length - 1].t : null, bars: m5.length, cfg: C, spread: o.spread, riskUsd: o.riskUsd };
  }
  function backtestAsync(m5, cfg, opts) { return new Promise((res, rej) => setTimeout(() => { try { res(backtest(m5, cfg, opts)); } catch (e) { rej(e); } }, 20)); }

  return { DEFAULTS, analyzeDay, simulate, simulateSplit, backtest, backtestAsync, bias };
});
