'use strict';
/**
 * SMC ARES ENGINE — les 5 modèles d'entrée de la vidéo « The Best Entry Strategies In SMC & ICT » (Smart Risk).
 * Breaker Block · Classic FVG · Mitigation Block · IFVG · Order Block.
 *
 * Contexte (vidéo) : zone/liquidité HTF (M15/H1/jour/Asie) -> MSS/CHoCH sur M5 -> modèle d'entrée (ordre LIMIT).
 * Règle du robot : le modèle qui se complète le PREMIER est pris ; si plusieurs se complètent sur la même bougie,
 * celui qui a le meilleur SCORE (0-100) est pris. Un seul trade à la fois (par symbole).
 * TP : RR 2 ou RR 3 (TP1 = moitié : RR 1 ou RR 1.5), puis SL de la position 2 au BE après TP1.
 * Aucune donnée simulée. Le même fichier sert au robot (Node) et au backtest du site (navigateur).
 * Pas de « look-ahead » : à la bougie k, seules les données fermées jusqu'à k sont utilisées.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SMCEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const M5 = 300000, HOUR = 3600000, DAY = 86400000;
  const MODELS = ['Breaker', 'Mitigation', 'IFVG', 'OrderBlock', 'FVG'];   // ordre de priorité si score identique
  const SYMBOL_BUFFER = { XAUUSD: 0.4, EURUSD: 0.00015, GBPUSD: 0.0002, USDJPY: 0.02 };   // « quelques pips » au-delà de la zone
  const DEFAULTS = {
    lookback: 90,          // bougies M5 max entre le dernier swing et la cassure
    dispBody: 0.55,        // déplacement : corps >= 55 % de la bougie
    dispAtr: 0.7,          // ... et amplitude >= 0,7 × ATR(14) M5
    tolAtr: 1.5,           // tolérance (× ATR) pour dire qu'une zone HTF a été touchée
    aoiAgeMs: 72 * HOUR,   // âge maximal d'une zone / liquidité HTF
    tpAgeMs: 96 * HOUR,    // âge maximal d'une liquidité HTF prise comme cible
    buffer: null,          // marge au-delà de la zone (unités de prix) ; null -> 0,12 × ATR
    bufferAtr: 0.12,
    entryMode: 'edge',     // 'edge' : bord de la zone (vidéo) · 'mid' : 50 % de la zone (variante de la vidéo)
    pendingBars: 36, pendingBarsOB: 72,   // validité de l'ordre LIMIT (bougies M5)
    rrRule: 'nearest',     // 'nearest' : liquidité HTF la plus proche décide RR 3 / RR 2 / pas de trade ; 'first2R' : première liquidité >= 2R
    minRiskAtr: 0.6, maxRiskAtr: 10,
    fixedSl: 0,            // > 0 : SL FIXE en unités de prix (or : 10 = 10 $ de prix = 10 $ pour 0,01 lot) ; 0 = SL de la zone (vidéo)
    ltf: 5,                // unité de temps de confirmation / d'entrée : 5 (M5) ou 15 (M15) ; HTF = M15+H1+jour+Asie (M5) ou H1+jour+Asie (M15)
    session: true,         // Londres 08-17 / New York 08-17 (heure locale), lundi-vendredi
    // --- options de TEST (désactivées par défaut = vidéo seule) ---
    minScore: 0,           // ignorer les setups dont le score est < minScore (0 / 25 / 50 / 75 / 100)
    htfBias: false,        // true : trader seulement dans le sens de la structure H1 (dernière cassure H1)
    models: null           // null = les 5 ; sinon liste ex. ['Breaker','FVG']
  };

  // ---------- utilitaires ----------
  const fmtCache = {}, sessCache = new Map();
  function winOpen(tz, d) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', weekday: 'short' }));
    let h = 0, wd = ''; f.formatToParts(d).forEach(p => { if (p.type === 'hour') h = Number(p.value); if (p.type === 'weekday') wd = p.value; });
    return wd !== 'Sat' && wd !== 'Sun' && h >= 8 && h < 17;
  }
  function inSession(ts) {
    const hk = Math.floor(ts / HOUR); let r = sessCache.get(hk);
    if (r === undefined) { if (sessCache.size > 6000) sessCache.clear(); const d = new Date(hk * HOUR); r = winOpen('Europe/London', d) || winOpen('America/New_York', d); sessCache.set(hk, r); }
    return r;
  }
  function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
  function upperBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= x) lo = m + 1; else hi = m; } return lo; }
  function aggregate(bars, minutes) {
    const ms = minutes * 60000, out = []; let cur = null;
    for (const x of bars) {
      const g = Math.floor(x.t / ms) * ms;
      if (!cur || cur.t !== g) { cur = { t: g, o: x.o, h: x.h, l: x.l, c: x.c, closeT: g + ms }; out.push(cur); }
      else { if (x.h > cur.h) cur.h = x.h; if (x.l < cur.l) cur.l = x.l; cur.c = x.c; }
    }
    return out;
  }
  function atrSeries(b, n) {
    const out = new Float64Array(b.length); let a = 0;
    for (let i = 1; i < b.length; i++) {
      const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
      a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n; out[i] = i < n ? 0 : a;
    }
    return out;
  }
  function rawPivots(b, L, R) {
    const out = [];
    for (let i = L; i < b.length - R; i++) {
      let hi = true, lo = true;
      for (let j = 1; j <= L && (hi || lo); j++) { if (b[i - j].h >= b[i].h) hi = false; if (b[i - j].l <= b[i].l) lo = false; }
      for (let j = 1; j <= R && (hi || lo); j++) { if (b[i + j].h > b[i].h) hi = false; if (b[i + j].l < b[i].l) lo = false; }
      if (hi) out.push({ i, p: b[i].h, type: 'H', conf: i + R });
      if (lo) out.push({ i, p: b[i].l, type: 'L', conf: i + R });
    }
    return out;
  }
  function alt(arr) {   // alternance H/L : on garde le plus extrême quand deux pivots du même type se suivent
    const o = [];
    for (const q of arr) { const l = o[o.length - 1]; if (l && l.type === q.type) { if ((q.type === 'H' && q.p >= l.p) || (q.type === 'L' && q.p <= l.p)) o[o.length - 1] = q; } else o.push(q); }
    return o;
  }
  function cntConf(raw, idx) { let lo = 0, hi = raw.length; while (lo < hi) { const m = (lo + hi) >> 1; if (raw[m].conf <= idx) lo = m + 1; else hi = m; } return lo; }
  /** bougies consécutives de même couleur (max 3) à partir de idx (ou juste avant) : « dernière bougie / série de bougies » de la vidéo */
  function runBlock(b, idx, bull) {
    const isC = x => (bull ? x.c > x.o : x.c < x.o); let j = idx, g = 0;
    while (j >= 0 && g < 4 && !isC(b[j])) { j--; g++; }
    if (j < 0 || g >= 4) return null;
    let lo = b[j].l, hi = b[j].h, n = 1, m = j - 1;
    while (m >= 0 && n < 3 && isC(b[m])) { if (b[m].l < lo) lo = b[m].l; if (b[m].h > hi) hi = b[m].h; n++; m--; }
    return { lo, hi };
  }
  function fvgOverlap(b, from, to, lo, hi) {   // un FVG haussier dans [from, to] chevauche-t-il [lo, hi] ?
    for (let j = Math.max(1, from + 1); j < to; j++) {
      if (b[j - 1].h < b[j + 1].l) { const gl = b[j - 1].h, gh = b[j + 1].l; if (Math.min(hi, gh) > Math.max(lo, gl)) return true; }
    }
    return false;
  }
  const bodyOK = (x, minRange, cfg) => { const r = x.h - x.l; return r > 0 && r >= minRange && Math.abs(x.c - x.o) / r >= cfg.dispBody; };

  // ---------- vue haussière (la vue « baissière » est la même chose sur des prix inversés) ----------
  function buildView(m5, sgn, times, bar) {
    const bars = sgn > 0 ? m5 : m5.map(x => ({ t: x.t, o: -x.o, h: -x.l, l: -x.h, c: -x.c }));
    const v = { sgn, m5: bars, bar }; v.m15 = aggregate(bars, 15); v.h1 = aggregate(bars, 60);
    v.p5 = rawPivots(bars, 2, 2); v.p15 = rawPivots(v.m15, 3, 3); v.p60 = rawPivots(v.h1, 2, 2);
    const n = bars.length; v.nc5 = new Int32Array(n); v.i15 = new Int32Array(n); v.i60 = new Int32Array(n);
    let pc = 0, p15 = -1, p60 = -1;
    for (let k = 0; k < n; k++) {
      while (pc < v.p5.length && v.p5[pc].conf <= k) pc++; v.nc5[k] = pc;
      const now = bars[k].t + bar;
      while (p15 + 1 < v.m15.length && v.m15[p15 + 1].closeT <= now) p15++; v.i15[k] = p15;
      while (p60 + 1 < v.h1.length && v.h1[p60 + 1].closeT <= now) p60++; v.i60[k] = p60;
    }
    v.bias60 = new Int8Array(v.h1.length);   // biais H1 : +1 si la dernière cassure H1 est haussière, -1 si baissière (vue miroir : inversé)
    { let pi = 0, lH = null, lL = null, bias = 0;
      for (let j = 0; j < v.h1.length; j++) {
        while (pi < v.p60.length && v.p60[pi].conf <= j) { const q = v.p60[pi++]; if (q.type === 'H') lH = q; else lL = q; }
        const c = v.h1[j].c; if (lH && c > lH.p) bias = 1; else if (lL && c < lL.p) bias = -1; v.bias60[j] = bias;
      } }
    v.aoi = buildAOI(v, times); return v;
  }
  function buildAOI(v, times) {
    const b = v.m5, bar = v.bar, sweepBars = Math.ceil(4 * DAY / bar), zoneBars = Math.ceil(3 * DAY / bar), dem = [], liqL = [], liqH = [];
    const add = (type, p, formedT, tf) => (type === 'L' ? liqL : liqH).push({ p, formedT, tf, sweptT: Infinity });
    [[v.m15, v.p15, 'M15'], [v.h1, v.p60, 'H1']].forEach(a => a[1].forEach(q => add(q.type, q.p, a[0][q.conf].closeT, a[2] || (a[0] === v.m15 ? 'M15' : 'H1'))));
    let day = null;
    const asia = () => { if (day && !day.asiaDone && day.ah != null) { day.asiaDone = true; add('H', day.ah, day.d0 + 7 * HOUR, 'ASIA'); add('L', day.al, day.d0 + 7 * HOUR, 'ASIA'); } };
    const flush = () => { if (!day) return; asia(); add('H', day.h, day.d0 + DAY, 'D'); add('L', day.l, day.d0 + DAY, 'D'); };
    for (let i = 0; i < b.length; i++) {
      const d0 = Math.floor(b[i].t / DAY) * DAY;
      if (!day || day.d0 !== d0) { flush(); day = { d0, h: -Infinity, l: Infinity, ah: null, al: null, asiaDone: false }; }
      if (b[i].t - d0 >= 7 * HOUR) asia();   // la plage Asie (00:00-07:00 UTC) est publiée dès 07:00, pas à la fin du jour
      if (b[i].h > day.h) day.h = b[i].h; if (b[i].l < day.l) day.l = b[i].l;
      if (b[i].t - d0 < 7 * HOUR) { day.ah = day.ah == null ? b[i].h : Math.max(day.ah, b[i].h); day.al = day.al == null ? b[i].l : Math.min(day.al, b[i].l); }
    }   // le jour en cours (incomplet) n'est pas publié : pas de PDH/PDL avant la fin du jour
    if (day && b.length && b[b.length - 1].t + bar >= day.d0 + DAY) { flush(); day = null; }   // dernière bougie = 23:55 : le jour vient de se terminer
    const swept = (arr, isLow) => arr.forEach(lv => { const s = lowerBound(times, lv.formedT), e = Math.min(b.length, s + sweepBars); for (let i = s; i < e; i++) { if (isLow ? b[i].l < lv.p : b[i].h > lv.p) { lv.sweptT = b[i].t; break; } } });
    swept(liqL, true); swept(liqH, false);
    // zones de demande HTF : dernière bougie baissière avant l'impulsion haussière qui casse la structure (OB M15 / H1)
    [[v.m15, v.p15, 'M15'], [v.h1, v.p60, 'H1']].forEach(a => {
      const S = a[0], raw = a[1]; let pi = 0, lastH = null, lastL = null;
      for (let j = 1; j < S.length; j++) {
        while (pi < raw.length && raw[pi].conf <= j) { const q = raw[pi++]; if (q.type === 'H') lastH = q; else lastL = q; }
        if (!lastH || !lastL || lastL.i >= j) continue;
        if (!(S[j].c > lastH.p && S[j - 1].c <= lastH.p)) continue;
        let disp = false; for (let m = Math.max(lastL.i, j - 6); m <= j; m++) { const x = S[m], r = x.h - x.l; if (r > 0 && x.c > x.o && (x.c - x.o) / r >= 0.5) { disp = true; break; } }
        if (!disp) continue;
        const z = runBlock(S, lastL.i, false); if (!z) continue;
        const zone = { lo: z.lo, hi: z.hi, formedT: S[j].closeT, tf: a[2], invalidT: Infinity };
        const s = lowerBound(times, zone.formedT), e = Math.min(b.length, s + zoneBars);
        for (let i = s; i < e; i++) if (b[i].c < zone.lo) { zone.invalidT = b[i].t; break; }
        dem.push(zone);
      }
    });
    const srt = (a) => { a.sort((x, y) => x.formedT - y.formedT); a.T = Float64Array.from(a.map(x => x.formedT)); return a; };
    return { dem: srt(dem), liqL: srt(liqL), liqH: srt(liqH) };
  }
  /** contexte HTF : le plus bas du mouvement (xP) a-t-il touché une zone HTF ou balayé une liquidité HTF ? */
  function aoiCheck(v, xP, Tend, legT, A, cfg, skipM15Zones) {   // Tend = fin de la bougie du point bas
    let ok = false, sweep = false, htf = false;
    const a = v.aoi, from = lowerBound(a.dem.T, legT - cfg.aoiAgeMs), to = upperBound(a.dem.T, legT), l15 = cfg.ltf === 15;   // unité de base M15 : le contexte HTF = H1 / jour / Asie seulement
    for (let i = from; i < to; i++) { const z = a.dem[i]; if ((skipM15Zones || l15) && z.tf === 'M15') continue; if (z.invalidT < Tend) continue; if (xP <= z.hi && xP >= z.lo - cfg.tolAtr * A) { ok = true; if (z.tf !== 'M15') htf = true; } }
    const f2 = lowerBound(a.liqL.T, legT - cfg.aoiAgeMs), t2 = upperBound(a.liqL.T, legT);
    for (let i = f2; i < t2; i++) { const lv = a.liqL[i]; if (l15 && lv.tf === 'M15') continue; if (lv.sweptT >= legT - 12 * v.bar && lv.sweptT < Tend && xP < lv.p) { ok = true; sweep = true; if (lv.tf !== 'M15') htf = true; } }
    return { ok, sweep, htf };
  }

  // ---------- contexte ----------
  function buildContext(m5in, ltfIn) {
    const raw = [], seen = new Set();
    for (const x of m5in) { if (x && Number.isFinite(x.t) && x.h >= x.l && !seen.has(x.t)) { seen.add(x.t); raw.push({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c }); } }
    raw.sort((a, b) => a.t - b.t);
    const ltf = ltfIn === 15 ? 15 : 5, bar = ltf * 60000, base = ltf === 15 ? aggregate(raw, 15).map(x => ({ t: x.t, o: x.o, h: x.h, l: x.l, c: x.c })) : raw;
    const times = Float64Array.from(base.map(x => x.t));
    return { m5: base, raw5: raw, ltf, bar, times, atr: atrSeries(base, 14), up: buildView(base, 1, times, bar), down: buildView(base, -1, times, bar) };
  }

  // ---------- détection ----------
  function scanM5(v, ctx, k, cfg, out) {
    const b = v.m5, A = ctx.atr[k], n = v.nc5[k], now = b[k].t + ctx.bar, sc = M5 / ctx.bar, tfn = ctx.ltf === 15 ? 'M15' : 'M5'; if (n < 6) return;
    const win = alt(v.p5.slice(Math.max(0, n - 40), n)), m = win.length; if (m < 3) return;
    const buf = cfg.buffer != null ? cfg.buffer : cfg.bufferAtr * A, close = b[k].c;
    // --- Breaker / Mitigation / FVG : bas (L1) -> haut (H1) -> bas (L2) puis déplacement qui casse H1 ---
    let i = m - 1, H2 = null; if (win[i].type === 'H') { H2 = win[i]; i--; }
    if (i >= 2 && win[i].type === 'L' && win[i - 1].type === 'H' && win[i - 2].type === 'L' && !(H2 && H2.p >= win[i - 1].p)) {
      const L2 = win[i], H1 = win[i - 1], L1 = win[i - 2];
      let fresh = k - L2.i <= Math.ceil(cfg.lookback * sc) && close > H1.p;
      for (let j = L2.i + 1; fresh && j < k; j++) if (b[j].c > H1.p) fresh = false;
      let disp = false; if (fresh) for (let j = L2.i + 1; j <= k; j++) if (b[j].c > b[j].o && bodyOK(b[j], cfg.dispAtr * A, cfg)) { disp = true; break; }
      if (fresh && disp) {
        const legUp = L2.p < L1.p ? L2 : L1, Tend = b[legUp.i].t + ctx.bar, legT = b[L1.i].t;
        const aoi = aoiCheck(v, legUp.p, Tend, legT, A, cfg, false);
        if (aoi.ok) {
          const strong = b[k].c > b[k].o && bodyOK(b[k], cfg.dispAtr * A, cfg), zone = runBlock(b, H1.i, true);
          if (zone && zone.hi < close - 0.05 * A && L2.p !== L1.p) {
            const model = L2.p < L1.p ? 'Breaker' : 'Mitigation';
            out.push({ model, tf: tfn, zone, sl: (model === 'Breaker' ? zone.lo : Math.min(zone.lo, L2.p)) - buf, parts: { sweep: aoi.sweep || model === 'Breaker', mss: strong, fvg: fvgOverlap(b, L2.i, k, zone.lo, zone.hi), htf: aoi.htf }, aoi, k });
          }
          for (let j = k - 1; j > L2.i; j--) {   // FVG haussier dans l'impulsion du MSS, encore intact
            if (!(b[j - 1].h < b[j + 1].l)) continue;
            const g = { lo: b[j - 1].h, hi: b[j + 1].l }; if (g.hi - g.lo < 0.1 * A) continue;
            let touched = false; for (let q = j + 2; q <= k; q++) if (b[q].l <= g.hi) { touched = true; break; }
            if (touched) continue;
            out.push({ model: 'FVG', tf: tfn, zone: g, sl: L2.p - buf, parts: { sweep: aoi.sweep || L2.p < L1.p, mss: strong, fvg: !!(zone && Math.min(zone.hi, g.hi) > Math.max(zone.lo, g.lo)), htf: aoi.htf }, aoi, k });
            break;
          }
        }
      }
    }
    // --- IFVG : un FVG baissier non respecté (clôture au-dessus) devient support ---
    for (let j = k - 3; j >= Math.max(2, k - Math.ceil(70 * sc)); j--) {
      if (!(b[j - 1].l > b[j + 1].h)) continue;
      const g = { lo: b[j + 1].h, hi: b[j - 1].l }; if (g.hi - g.lo < 0.1 * A) continue;
      if (!(close > g.hi)) continue;
      let first = true, entered = false, xLow = Infinity, xi = j;
      for (let q = j + 2; q < k; q++) { if (b[q].c > g.hi) { first = false; break; } if (b[q].h >= g.lo) entered = true; }
      if (!first || !entered) continue;
      for (let q = j - 1; q <= k; q++) if (b[q].l < xLow) { xLow = b[q].l; xi = q; }
      const aoi = aoiCheck(v, xLow, b[xi].t + ctx.bar, b[j - 1].t, A, cfg, false); if (!aoi.ok) continue;
      let lastH = null; for (let q = m - 1; q >= 0; q--) if (win[q].type === 'H') { lastH = win[q]; break; }
      out.push({ model: 'IFVG', tf: tfn, zone: g, sl: xLow - buf, parts: { sweep: aoi.sweep, mss: !!(lastH && close > lastH.p), fvg: fvgOverlap(b, j + 1, k, g.lo, g.hi), htf: aoi.htf }, aoi, k });
      break;
    }
  }
  function scanOB(v, ctx, k, cfg, out) {   // Order Block : M15 (ou plus), HTF = H1 / jour / Asie
    const b5 = v.m5, now = b5[k].t + ctx.bar, j = v.i15[k], S = v.m15; if (j < 10 || S[j].closeT !== now) return;
    const n = cntConf(v.p15, j); if (n < 4) return;
    const win = alt(v.p15.slice(Math.max(0, n - 30), n)); let H = null, L = null;
    for (let q = win.length - 1; q >= 0 && !(H && L); q--) { if (win[q].type === 'H' && !H) H = win[q]; if (win[q].type === 'L' && !L) L = win[q]; }
    if (!H || !L || L.i >= j || j - L.i > 40) return;
    if (!(S[j].c > H.p && S[j - 1].c <= H.p)) return;
    let rg = 0; for (let q = j - 14; q < j; q++) rg += S[q].h - S[q].l; rg /= 14;
    let disp = false, strong = false; for (let q = L.i; q <= j; q++) if (S[q].c > S[q].o && bodyOK(S[q], 0.7 * rg, cfg)) { disp = true; if (q === j) strong = true; }
    if (!disp) return;
    let xLow = Infinity, xi = L.i; for (let q = L.i; q <= j; q++) if (S[q].l < xLow) { xLow = S[q].l; xi = q; }
    const A = ctx.atr[k], aoi = aoiCheck(v, xLow, S[xi].closeT, S[Math.max(0, L.i - 4)].t, A, cfg, true); if (!aoi.ok) return;
    const zone = runBlock(S, L.i, false); if (!zone || !(zone.hi < S[j].c - 0.05 * A)) return;
    const buf = cfg.buffer != null ? cfg.buffer : cfg.bufferAtr * A;
    out.push({ model: 'OrderBlock', tf: 'M15', zone, sl: zone.lo - buf, parts: { sweep: aoi.sweep, mss: strong, fvg: fvgOverlap(S, L.i, j, zone.lo, zone.hi), htf: aoi.htf }, aoi, k });
  }
  /** entrée / SL / TP (RR 2 ou 3) ; renvoie null si le setup n'est pas exploitable */
  function finalize(c, v, ctx, k, cfg) {
    const A = ctx.atr[k], now = v.m5[k].t + ctx.bar, close = v.m5[k].c;
    const fixed = cfg.fixedSl > 0, entry = cfg.entryMode === 'mid' ? (c.zone.lo + c.zone.hi) / 2 : c.zone.hi, sl = fixed ? entry - cfg.fixedSl : c.sl, R = entry - sl;
    if (!(R > 0) || (!fixed && (R < cfg.minRiskAtr * A || R > cfg.maxRiskAtr * A)) || entry > close - 0.05 * A) return null;
    const a = v.aoi.liqH, from = lowerBound(a.T, now - cfg.tpAgeMs), to = upperBound(a.T, now);
    let best = null;
    for (let i = from; i < to; i++) { const lv = a[i]; if ((cfg.ltf === 15 && lv.tf === 'M15') || lv.sweptT < now || lv.p <= entry) continue; const av = (lv.p - entry) / R; if (cfg.rrRule === 'first2R') { if (av >= 2 && (!best || lv.p < best.p)) best = { p: lv.p, av, tf: lv.tf }; } else if (!best || lv.p < best.p) best = { p: lv.p, av, tf: lv.tf }; }
    if (!best || best.av < 2) return null;
    const rr = best.av >= 3 ? 3 : 2, f1 = rr === 3 ? 1.5 : 1;
    const score = (c.parts.sweep ? 25 : 0) + (c.parts.mss ? 25 : 0) + (c.parts.fvg ? 25 : 0) + (c.parts.htf ? 25 : 0);
    const o = { model: c.model, tf: c.tf, side: v.sgn > 0 ? 'BUY' : 'SELL', entry, sl, tp1: entry + f1 * R, tp2: entry + rr * R, rr, risk: R, zone: { lo: c.zone.lo, hi: c.zone.hi }, score, parts: c.parts, target: best.p, targetTf: best.tf, aoiTf: c.aoi && c.aoi.htf ? 'HTF' : 'M15', k, trigT: now, pendingBars: Math.max(2, Math.ceil((c.model === 'OrderBlock' ? cfg.pendingBarsOB : cfg.pendingBars) * M5 / ctx.bar)), atr: A, ltf: ctx.ltf };
    if (v.sgn < 0) { ['entry', 'sl', 'tp1', 'tp2', 'target'].forEach(f => { o[f] = -o[f]; }); o.zone = { lo: -c.zone.hi, hi: -c.zone.lo }; }
    return o;
  }
  /** tous les setups complétés à la bougie k (fermée) + celui qui est choisi (voir règle) */
  function scan(ctx, k, cfgIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {}), res = { cands: [], chosen: null };
    if (k < 150 || !(ctx.atr[k] > 0)) return res;
    if (cfg.ltf !== ctx.ltf) cfg.ltf = ctx.ltf;   // le contexte décide de l'unité de temps
    const now = ctx.m5[k].t + ctx.bar; if (cfg.session && !inSession(now)) return res;
    [ctx.up, ctx.down].forEach(v => {
      if (cfg.htfBias) { const j = v.i60[k]; if (j < 0 || v.bias60[j] <= 0) return; }
      const raw = []; scanM5(v, ctx, k, cfg, raw); scanOB(v, ctx, k, cfg, raw);
      raw.forEach(c => { const f = finalize(c, v, ctx, k, cfg); if (f && f.score >= cfg.minScore && (!cfg.models || cfg.models.indexOf(f.model) >= 0)) res.cands.push(f); });
    });
    res.cands.sort((a, b) => b.score - a.score || MODELS.indexOf(a.model) - MODELS.indexOf(b.model));
    res.chosen = res.cands[0] || null; return res;
  }

  // ---------- backtest (bougies M5, un trade à la fois, 2 positions TP1 / TP2, BE après TP1) ----------
  function newStats() { return { trades: 0, wins: 0, losses: 0, tp: 0, be: 0, sl: 0, r: 0 }; }
  /** simulateur pas à pas : run(n) traite n bougies et renvoie true quand c'est fini ; result() donne les tableaux */
  function createBacktest(m5, cfgIn, optsIn) {
    const cfg = Object.assign({}, DEFAULTS, cfgIn || {}), o = Object.assign({ spread: 0, riskUsd: 10, warmup: 600 }, optsIn || {});
    const ctx = buildContext(m5, cfg.ltf), b = ctx.m5, spr = o.spread, trades = [], by = {}, bySc = {}; MODELS.forEach(m => { by[m] = newStats(); }); by.TOTAL = newStats(); [0, 25, 50, 75, 100].forEach(x => { bySc[x] = newStats(); });
    const byRR = { 2: newStats(), 3: newStats() };   // résultats séparés pour les trades RR 2 et RR 3
    // M15 : détection sur M15, mais l'exécution (remplissage, SL, TP, BE) est simulée bougie M5 par bougie M5 (plus précis)
    let subs = null;
    if (ctx.ltf === 15) { subs = new Array(b.length); let p = 0; for (let i = 0; i < b.length; i++) { const arr = [], end = b[i].t + ctx.bar; while (p < ctx.raw5.length && ctx.raw5[p].t < end) { if (ctx.raw5[p].t >= b[i].t) arr.push(ctx.raw5[p]); p++; } subs[i] = arr; } }
    let pend = null, pos = null, k = Math.min(ctx.ltf === 15 ? Math.ceil(o.warmup / 3) + 100 : o.warmup, Math.max(0, b.length - 2));
    const close = (res, R, bar) => {   // R = résultat du trade en multiples du risque total (les 2 positions)
      const w = (o.lotMult && o.lotMult[pos.c.score]) || 1, Rw = R * w;   // lot proportionnel au score (ex. score 100 = 2× le lot du score 75)
      const t = Object.assign({}, pos.c, { result: res, R, w, Rw, closedT: b[bar].t, openedT: pos.openT });
      trades.push(t); [by[t.model], by.TOTAL, bySc[t.score] || (bySc[t.score] = newStats()), byRR[t.rr]].forEach(s => { s.trades++; s.r += Rw; if (res === 'SL') { s.losses++; s.sl++; } else { s.wins++; if (res === 'TP') s.tp++; else s.be++; } });
      pos = null;
    };
    function exec(x) {   // une bougie d'exécution (M5)
      if (pend) {
        const c = pend.c, L = c.side === 'BUY';
        if (L ? x.c <= c.sl : x.c >= c.sl) { pend = null; return; }   // ordre LIMIT invalidé (clôture au-delà du SL avant remplissage)
        if (!(L ? x.l + spr <= c.entry : x.h >= c.entry)) return;
        pos = { c, tp1Hit: false, openT: x.t }; pend = null;
        if (L ? x.l <= c.sl : x.h + spr >= c.sl) close('SL', -1, k);   // bougie de remplissage : seul le SL est compté (prudent)
        return;
      }
      const c = pos.c, L = c.side === 'BUY', rr1 = Math.abs(c.tp1 - c.entry) / c.risk, rr2 = c.rr;
      const hitSL = L ? x.l <= c.sl : x.h + spr >= c.sl, hitTP1 = L ? x.h >= c.tp1 : x.l + spr <= c.tp1, hitTP2 = L ? x.h >= c.tp2 : x.l + spr <= c.tp2, hitBE = L ? x.l <= c.entry : x.h + spr >= c.entry;
      if (!pos.tp1Hit) {
        if (hitSL) close('SL', -1, k);
        else if (hitTP1) { pos.tp1Hit = true; if (hitTP2) close('TP', 0.5 * rr1 + 0.5 * rr2, k); }
      } else if (hitBE) close('BE', 0.5 * rr1, k);        // après TP1 : retour au prix d'entrée = BE (compté gagnant)
      else if (hitTP2) close('TP', 0.5 * rr1 + 0.5 * rr2, k);
    }
    function step() {
      if (!pend && !pos) { const r = scan(ctx, k, cfg); if (r.chosen) pend = { c: r.chosen, from: k }; return; }
      if (pend && k - pend.from > pend.c.pendingBars) { pend = null; return; }   // ordre LIMIT expiré (en bougies de l'unité de base)
      const list = subs ? subs[k] : [b[k]];
      for (let q = 0; q < list.length; q++) { exec(list[q]); if (!pend && !pos) break; }
    }
    return {
      total: b.length, get index() { return k; },
      run(n) { const end = Math.min(b.length - 1, k + n); for (; k < end; k++) step(); return k >= b.length - 1; },
      result() {
        const fin = src => { const out = {}; Object.keys(src).forEach(m => { const s = src[m]; out[m] = Object.assign({}, s, { winRate: s.trades ? s.wins / s.trades * 100 : null, usd: s.r * o.riskUsd, avgR: s.trades ? s.r / s.trades : null }); }); return out; };
        const mid = b.length ? (b[0].t + b[b.length - 1].t) / 2 : 0, hv = [newStats(), newStats()], av = { n: 0, risk: 0, tp1: 0, tp2: 0, rr2: 0, rr3: 0 };
        trades.forEach(t => {
          const h = hv[t.openedT < mid ? 0 : 1]; h.trades++; h.r += t.Rw; if (t.result === 'SL') { h.losses++; h.sl++; } else { h.wins++; if (t.result === 'TP') h.tp++; else h.be++; }
          av.n++; av.risk += t.risk; av.tp1 += Math.abs(t.tp1 - t.entry); av.tp2 += Math.abs(t.tp2 - t.entry); if (t.rr === 3) av.rr3++; else av.rr2++;
        });
        const avg = av.n ? { risk: av.risk / av.n, tp1: av.tp1 / av.n, tp2: av.tp2 / av.n, rr2: av.rr2, rr3: av.rr3 } : null;
        return { by: fin(by), byScore: fin(bySc), byRR: fin(byRR), halves: fin({ first: hv[0], second: hv[1] }), halfAt: mid, avg, trades, ltf: ctx.ltf, bars: ctx.raw5.length, from: b.length ? b[0].t : null, to: b.length ? b[b.length - 1].t : null };
      }
    };
  }
  function backtest(m5, cfg, opts) { const t = createBacktest(m5, cfg, opts); t.run(Infinity); return t.result(); }
  /** navigateur : rend la main à l'interface toutes les ~2000 bougies (barre de progression) */
  function backtestAsync(m5, cfg, opts) {
    return new Promise((resolve, reject) => {
      let t; try { t = createBacktest(m5, cfg, opts); } catch (e) { return reject(e); }
      const pump = () => { try { const done = t.run(2000); if (opts && opts.onProgress) opts.onProgress(t.index / Math.max(1, t.total)); if (done) resolve(t.result()); else setTimeout(pump, 0); } catch (e) { reject(e); } };
      setTimeout(pump, 0);
    });
  }

  return { DEFAULTS, MODELS, SYMBOL_BUFFER, inSession, aggregate, buildContext, scan, createBacktest, backtest, backtestAsync, M5 };
});
