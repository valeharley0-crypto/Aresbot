'use strict';
/**
 * ARES — RISK ENGINE (fonctions pures, testables).
 * Protected Profit Floor + Trailing Profit Protection + multiplicateur de lot + contrôles pré-trade.
 * IMPORTANT : le floor est un objectif de protection configurable, JAMAIS une garantie
 * (spread, slippage, gaps et exécution broker peuvent le dépasser).
 */
const r2 = x => Math.round(x * 100) / 100;

const DEFAULT_PROFIT_PROTECTION = {
  enabled: true,
  unit: 'POINTS',            // 'POINTS' (points-or, dépend du lot) | 'MONEY' (devise du compte)
  target: 20,                // objectif qui active le floor (20 points, ou ex. 20 USD si unit = MONEY)
  initialRisk: 5,            // part du profit encore risquable AU MOMENT du verrouillage (0 = rien n'est risqué -> plus aucun trade possible)
  trailing: { enabled: true, giveBack: 10 },   // le floor suit le meilleur P/L du jour moins giveBack
  lotScaling: { enabled: true, step: 10, maxMultiplier: 3 }   // +1× le lot de base tous les `step` au-dessus de la cible, plafonné
};

/**
 * @param pp   config profitProtection
 * @param peak meilleur P/L net du jour (même unité que pp.unit)
 * @param net  P/L net actuel du jour (même unité)
 * @returns { enabled, locked, floor, budget, multiplier, breached }
 *   floor      : niveau protégé (même unité), null tant que la cible n'est pas atteinte
 *   budget     : marge de perte encore autorisée = net - floor (>= 0)
 *   multiplier : multiplicateur de lot (>= 1) applicable une fois verrouillé
 */
function floorState(pp, peak, net) {
  const none = { enabled: !!(pp && pp.enabled), locked: false, floor: null, budget: null, multiplier: 1, breached: false };
  if (!pp || !pp.enabled || !(pp.target > 0)) return none;
  if (!(peak >= pp.target)) return none;
  let floor = pp.target - Math.max(0, pp.initialRisk || 0);
  if (pp.trailing && pp.trailing.enabled) floor = Math.max(floor, peak - Math.max(0, pp.trailing.giveBack || 0));
  floor = Math.min(floor, peak);
  let multiplier = 1;
  const ls = pp.lotScaling;
  if (ls && ls.enabled && ls.step > 0) multiplier = Math.min(Math.max(1, ls.maxMultiplier || 1), 1 + Math.floor((peak - pp.target) / ls.step + 1e-9));
  const budget = Math.max(0, r2(net - floor));
  return { enabled: true, locked: true, floor: r2(floor), budget, multiplier, breached: net <= floor + 1e-9 };
}

/** Drawdown depuis le plus haut d'equity. maxPct = 0/null -> désactivé. */
function drawdownState(peakEquity, equity, maxPct) {
  if (!maxPct || !(peakEquity > 0) || equity === null || equity === undefined) return { ok: true, pct: null };
  const pct = r2((peakEquity - equity) / peakEquity * 100);
  return { ok: pct < maxPct, pct };
}

function consecutiveLossState(losses, max) {
  if (!max) return { ok: true };
  return { ok: losses < max, losses, max };
}

/** Vérifie que le volume demandé respecte min / max / pas du broker. Retourne { ok, lots, reason }. */
function normalizeLots(lots, { minLot, maxLot, lotStep }) {
  if (!(lots > 0)) return { ok: false, lots: 0, reason: 'volume nul' };
  const st = lotStep > 0 ? lotStep : 0.01;
  let l = Math.floor(lots / st + 1e-9) * st;
  l = +l.toFixed(8);
  if (maxLot > 0 && l > maxLot) l = maxLot;
  if (l < minLot - 1e-12) return { ok: false, lots: 0, reason: `volume ${lots} < minimum broker ${minLot}` };
  return { ok: true, lots: +l.toFixed(8) };
}

module.exports = { DEFAULT_PROFIT_PROTECTION, floorState, drawdownState, consecutiveLossState, normalizeLots };
