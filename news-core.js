'use strict';
/**
 * ARES — NEWS USA « CORE » : seules les publications vraiment importantes pour l'or et le dollar.
 * (NFP, CPI, PCE, FOMC / taux Fed, discours du président de la Fed, PPI, Retail Sales, GDP, ISM, ADP, chômage, salaires)
 * Tout le reste (jobless claims, JOLTS, immobilier, enquêtes régionales, ventes aux enchères...) est ignoré par le panneau et par le robot.
 */
const CORE = [
  { key: 'NFP',   re: /non-?farm|\bnfp\b|employment situation|payrolls?/i },
  { key: 'UNEMP', re: /unemployment rate/i },
  { key: 'AHE',   re: /average hourly earnings/i },
  { key: 'ADP',   re: /\badp\b/i },
  { key: 'CPI',   re: /\bcpi\b|consumer price/i },
  { key: 'PCE',   re: /\bpce\b/i },
  { key: 'PPI',   re: /\bppi\b|producer price/i },
  { key: 'FOMC',  re: /fomc|federal funds|fed funds|interest rate decision|rate decision|rate statement/i },
  { key: 'FED',   re: /fed chair|powell/i },
  { key: 'RETAIL', re: /retail sales/i },
  { key: 'GDP',   re: /\bgdp\b(?!.*price)/i },
  { key: 'ISM',   re: /\bism\b/i }
];

/** Nom court (NFP, CPI, FOMC...) ou null si la news n'est pas « core ». */
function coreKey(title) {
  const t = String(title || '');
  for (const c of CORE) if (c.re.test(t)) return c.key;
  return null;
}
const isCore = title => coreKey(title) !== null;

module.exports = { isCore, coreKey, CORE };
