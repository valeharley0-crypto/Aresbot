'use strict';
/**
 * ARES — NEWS USA « CORE » : seules les publications vraiment importantes pour l'or et le dollar.
 * (NFP, CPI, FOMC / taux Fed, PCE)
 * Tout le reste (jobless claims, JOLTS, immobilier, enquêtes régionales, ventes aux enchères...) est ignoré par le panneau et par le robot.
 */
const CORE = [
  { key: 'NFP',  re: /^(?!.*\badp\b).*(non-?farm|\bnfp\b|employment situation|payrolls?)/i },
  { key: 'CPI',  re: /\bcpi\b|consumer price/i },
  { key: 'FOMC', re: /(?!.*minutes)(fomc|federal funds|fed funds|interest rate decision|rate decision|rate statement)/i },
  { key: 'PCE',  re: /\bpce\b/i }
];

/** Nom court (NFP, CPI, FOMC...) ou null si la news n'est pas « core ». */
function coreKey(title) {
  const t = String(title || '');
  for (const c of CORE) if (c.re.test(t)) return c.key;
  return null;
}
const isCore = title => coreKey(title) !== null;

module.exports = { isCore, coreKey, CORE };
