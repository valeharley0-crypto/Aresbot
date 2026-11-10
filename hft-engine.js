'use strict';
/**
 * ARES HFT — moteur de signal TICK (prix live bid/ask du broker). Aucune bougie, aucune donnée simulée.
 *
 * Principe (momentum de micro-structure) : on n'entre que sur une impulsion très courte, propre et dans le sens de la micro-tendance :
 *  1) flux de prix FRAIS (dernier tick récent) et spread faible (en points de base du prix : 1 bp = 0,01 %) ;
 *  2) impulsion : le prix (mid) a bougé d'au moins `impulseBp` dans la fenêtre `windowMs`, avec au moins `minTicks` ticks,
 *     dont `dirFrac` (%) dans le même sens (mouvement propre, pas un bruit aller-retour) ;
 *  3) le prix est du bon côté de sa moyenne mobile exponentielle (`trendMs`) et au plus haut/bas des `breakMs` dernières ms ;
 *  4) pas de spike : l'impulsion ne dépasse pas `maxImpulseBp` (on ne court pas après une annonce) ;
 *  5) le TP doit valoir au moins `minTpSpread` × le spread (sinon les frais mangent le gain).
 * SL / TP sont exprimés en bp du prix : ils s'adaptent à l'or comme à l'EURUSD.
 * Le même fichier peut tourner dans Node (robot). Aucun profit n'est garanti : sans données tick historiques fiables, le seul
 * « backtest » honnête est la statistique des trades réellement exécutés (DEMO d'abord).
 */
const DEFAULTS = {
  windowMs: 1500,        // fenêtre de l'impulsion
  breakMs: 5000,         // le prix doit être au plus haut (BUY) / plus bas (SELL) de cette période
  trendMs: 30000,        // constante de temps de la moyenne mobile exponentielle (micro-tendance)
  impulseBp: 1.2,        // impulsion minimale (bp) dans windowMs
  maxImpulseBp: 6,       // impulsion maximale (bp) : au-delà = spike, on ne trade pas
  minTicks: 4,           // nombre minimal de ticks dans la fenêtre
  dirFrac: 0.7,          // part minimale des ticks dans le sens de l'impulsion
  maxSpreadBp: 2.5,      // spread maximal accepté (bp)
  spreadWidenMax: 1.5,   // le spread ne doit pas dépasser 1,5 × son niveau médian des 10 dernières secondes
  staleMs: 1500,         // dernier tick plus vieux que ça = flux périmé, on ne trade pas
  tpBp: 4,               // take profit (bp)
  slBp: 6,               // stop loss (bp)
  minTpSpread: 2         // TP >= 2 × spread
};

const mid = (b, a) => (b + a) / 2;

/** Mémoire des ticks d'une paire (fenêtre glissante). */
class TickBook {
  constructor(keepMs) { this.keepMs = keepMs || 120000; this.t = []; this.bid = []; this.ask = []; this.mid = []; }
  get length() { return this.t.length; }
  /** Ajoute un tick (ignoré si identique au précédent ou invalide). Retourne true si ajouté. */
  push(t, bid, ask) {
    if (!(bid > 0) || !(ask > 0) || ask < bid) return false;
    const n = this.t.length;
    if (n && this.bid[n - 1] === bid && this.ask[n - 1] === ask) return false;
    this.t.push(t); this.bid.push(bid); this.ask.push(ask); this.mid.push(mid(bid, ask));
    const lim = t - this.keepMs; let k = 0; while (k < this.t.length - 1 && this.t[k] < lim) k++;
    if (k > 0) { this.t.splice(0, k); this.bid.splice(0, k); this.ask.splice(0, k); this.mid.splice(0, k); }
    return true;
  }
  last() { const n = this.t.length - 1; return n < 0 ? null : { t: this.t[n], bid: this.bid[n], ask: this.ask[n], mid: this.mid[n] }; }
  /** index du premier tick dont t >= from */
  from(from) { let i = this.t.length; while (i > 0 && this.t[i - 1] >= from) i--; return i; }
}

const median = a => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** EMA exponentielle pondérée par le temps sur les ticks de la fenêtre [now - 4 × tau, now]. */
function ema(book, tau, now) {
  const i0 = book.from(now - 4 * tau); if (i0 >= book.length) return null;
  let e = book.mid[i0];
  for (let i = i0 + 1; i < book.length; i++) { const dt = book.t[i] - book.t[i - 1], a = 1 - Math.exp(-dt / tau); e += a * (book.mid[i] - e); }
  return e;
}

/**
 * Évalue le signal sur l'état courant du book. Retourne { action: 'BUY'|'SELL'|'WAIT', reason, ...mesures }.
 * `cfg` : réglages (voir DEFAULTS) ; `now` : horloge (ms).
 */
function evaluate(book, cfgIn, now) {
  const c = Object.assign({}, DEFAULTS, cfgIn || {});
  const L = book.last();
  const out = { action: 'WAIT', reason: '', at: now };
  if (!L || book.length < 12) { out.reason = 'en attente de ticks (' + book.length + ')'; return out; }
  const age = now - L.t; out.ageMs = age;
  if (age > c.staleMs) { out.reason = 'flux de prix périmé (' + age + ' ms)'; return out; }
  const spBp = (L.ask - L.bid) / L.mid * 1e4; out.spreadBp = Math.round(spBp * 100) / 100;
  if (spBp > c.maxSpreadBp) { out.reason = 'spread trop large (' + out.spreadBp + ' bp)'; return out; }
  const sps = []; for (let i = book.from(now - 10000); i < book.length; i++) sps.push((book.ask[i] - book.bid[i]) / book.mid[i] * 1e4);
  const med = sps.length >= 6 ? median(sps) : null;
  if (med != null && spBp > c.spreadWidenMax * Math.max(med, 0.05)) { out.reason = 'spread qui s\'élargit (' + out.spreadBp + ' bp)'; return out; }
  if (c.tpBp < c.minTpSpread * spBp) { out.reason = 'TP trop petit face au spread'; return out; }
  const iw = book.from(now - c.windowMs), n = book.length - iw; out.ticks = n;
  if (n < c.minTicks) { out.reason = 'pas assez de ticks (' + n + '/' + c.minTicks + ')'; return out; }
  const base = iw > 0 ? book.mid[iw - 1] : book.mid[iw];
  const dm = (L.mid - base) / base * 1e4; out.impulseBp = Math.round(dm * 100) / 100;
  let up = 0, dn = 0; for (let i = Math.max(iw, 1); i < book.length; i++) { const d = book.mid[i] - book.mid[i - 1]; if (d > 0) up++; else if (d < 0) dn++; }
  const tot = up + dn; if (!tot) { out.reason = 'aucun mouvement'; return out; }
  const dir = dm > 0 ? 1 : -1, frac = (dir > 0 ? up : dn) / tot; out.dirFrac = Math.round(frac * 100) / 100;
  if (Math.abs(dm) < c.impulseBp) { out.reason = 'pas d\'impulsion (' + out.impulseBp + ' bp < ' + c.impulseBp + ')'; return out; }
  if (Math.abs(dm) > c.maxImpulseBp) { out.reason = 'spike (' + out.impulseBp + ' bp) : ignoré'; return out; }
  if (frac < c.dirFrac) { out.reason = 'mouvement pas assez propre (' + Math.round(frac * 100) + ' % dans le sens)'; return out; }
  const e = ema(book, c.trendMs, now); if (e == null) { out.reason = 'tendance indisponible'; return out; }
  out.ema = e;
  if (dir > 0 ? !(L.mid > e) : !(L.mid < e)) { out.reason = 'contre la micro-tendance'; return out; }
  const ib = book.from(now - c.breakMs); let ext = L.mid;
  for (let i = ib; i < book.length; i++) ext = dir > 0 ? Math.max(ext, book.mid[i]) : Math.min(ext, book.mid[i]);
  if (dir > 0 ? L.mid < ext : L.mid > ext) { out.reason = 'le prix n\'est pas au ' + (dir > 0 ? 'plus haut' : 'plus bas') + ' des ' + Math.round(c.breakMs / 1000) + ' s'; return out; }
  out.action = dir > 0 ? 'BUY' : 'SELL';
  out.reason = 'impulsion ' + (dir > 0 ? 'haussière' : 'baissière') + ' ' + out.impulseBp + ' bp · ' + n + ' ticks · ' + Math.round(frac * 100) + ' % dans le sens · spread ' + out.spreadBp + ' bp';
  return out;
}

/** Distances SL / TP (en unités de prix) pour un prix donné. */
function levels(price, cfgIn) {
  const c = Object.assign({}, DEFAULTS, cfgIn || {});
  return { sl: price * c.slBp / 1e4, tp: price * c.tpBp / 1e4 };
}

module.exports = { DEFAULTS, TickBook, evaluate, levels, ema };
