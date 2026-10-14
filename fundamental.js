'use strict';
/**
 * ARES — fundamental.js · ANALYSE FONDAMENTALE USD par l'IA Mentor (sans IA externe, sans clé API).
 *
 * Principe : chaque publication USD réelle du calendrier est notée comme une « surprise » normalisée
 * (écart / taille typique de la surprise de CET indicateur), orientée selon son effet sur le dollar
 * (chômage et demandes d'allocations : sens inverse). Le score tient compte aussi :
 *   - du CONTEXTE : surprises réelles des 7 derniers jours (emploi / inflation / croissance), pondérées et dégradées dans le temps ;
 *   - de l'ATTENTE avant publication : prévision vs précédent (poids réduit : c'est une attente, pas un résultat) ;
 *   - de la POLITIQUE de la Fed (décisions, discours, minutes) déduite de l'inflation et de l'emploi récents.
 * Résultat : un score USD U dans [-1 ; +1], puis un biais par paire. JAMAIS de NEUTRAL : le signe de U tranche toujours
 * (conviction faible signalée). Même sans aucun chiffre, un verdict par défaut (conviction très faible) est donné : l'analyse répond toujours.
 *
 * Honnêteté : c'est une lecture fondamentale probabiliste, pas une prédiction garantie. Avant la publication, la direction
 * se décide sur la surprise (réel vs prévu) ; le biais est donc recalculé dès que « Actual » est publié.
 */

const PAIRS = {   // usdQuote : true si USD est la devise de cotation (XXX/USD) ; sens : sensibilité de la paire à une surprise USD
  XAUUSD: { usdQuote: true, sens: 1.0 },
  EURUSD: { usdQuote: true, sens: 0.95 },
  GBPUSD: { usdQuote: true, sens: 0.9 },
  USDJPY: { usdQuote: false, sens: 0.9 },
  USDCHF: { usdQuote: false, sens: 0.85 },
  USDCAD: { usdQuote: false, sens: 0.85 }
};

// dir : +1 = valeur plus haute que prévu => USD plus fort ; -1 = inverse. w : poids (importance). scale : taille typique d'une surprise (même unité que le flux).
const INDICATORS = [
  { key: 'policy_minutes', re: /fomc (meeting )?minutes/, family: 'policy', w: 2, label: 'Minutes FOMC' },
  { key: 'policy_speech', re: /fomc (statement|press)|fed chair|powell|fomc member|fed .*speaks|monetary policy report|beige book/, family: 'policy', w: 1.6, label: 'Communication de la Fed' },
  { key: 'fed_rate', re: /federal funds|fed funds|interest rate decision|fomc.*rate|rate decision/, family: 'rates', w: 3, scale: 0.25, dir: 1, label: 'Taux directeur Fed' },
  { key: 'adp', re: /\badp\b/, family: 'labor', w: 1.2, scale: 50000, dir: 1, label: 'ADP Emploi' },
  { key: 'nfp', re: /non-?farm|\bnfp\b|employment situation|payrolls?/, family: 'labor', w: 3, scale: 75000, dir: 1, label: 'Non-Farm Payrolls' },
  { key: 'unemp_rate', re: /unemployment rate/, family: 'labor', w: 2.5, scale: 0.1, dir: -1, label: 'Taux de chômage' },
  { key: 'claims', re: /unemployment claims|jobless claims|initial claims|continuing claims/, family: 'labor', w: 1.3, scale: 12000, dir: -1, label: 'Demandes d\'allocations' },
  { key: 'ahe', re: /average hourly earnings|avg hourly|hourly earnings/, family: 'labor', w: 2, scale: 0.1, dir: 1, label: 'Salaire horaire moyen' },
  { key: 'eci', re: /employment cost/, family: 'labor', w: 1.5, scale: 0.1, dir: 1, label: 'Coût de l\'emploi' },
  { key: 'jolts', re: /jolts|job openings/, family: 'labor', w: 1.2, scale: 300000, dir: 1, label: 'JOLTS (offres d\'emploi)' },
  { key: 'pce', re: /\bpce\b|pce price/, family: 'inflation', w: 3, scale: 0.1, dir: 1, label: 'PCE (inflation Fed)' },
  { key: 'cpi', re: /\bcpi\b|consumer price/, family: 'inflation', w: 3, scale: 0.1, dir: 1, label: 'CPI (inflation)' },
  { key: 'ppi', re: /\bppi\b|producer price/, family: 'inflation', w: 1.5, scale: 0.2, dir: 1, label: 'PPI (prix producteurs)' },
  { key: 'import_prices', re: /import prices/, family: 'inflation', w: 0.7, scale: 0.3, dir: 1, label: 'Prix import' },
  { key: 'retail', re: /retail sales/, family: 'growth', w: 2, scale: 0.4, dir: 1, label: 'Ventes au détail' },
  { key: 'gdp', re: /\bgdp\b(?!.*price)/, family: 'growth', w: 2, scale: 0.4, dir: 1, label: 'PIB' },
  { key: 'ism', re: /\bism\b/, family: 'growth', w: 2, scale: 1.5, dir: 1, label: 'ISM' },
  { key: 'pmi', re: /\bpmi\b|s&p global/, family: 'growth', w: 1.2, scale: 1.2, dir: 1, label: 'PMI' },
  { key: 'sentiment', re: /consumer sentiment|uom|michigan/, family: 'growth', w: 1, scale: 3, dir: 1, label: 'Sentiment consommateurs' },
  { key: 'confidence', re: /consumer confidence|cb consumer/, family: 'growth', w: 1, scale: 4, dir: 1, label: 'Confiance consommateurs' },
  { key: 'durable', re: /durable goods/, family: 'growth', w: 1, scale: 1, dir: 1, label: 'Commandes de biens durables' },
  { key: 'indprod', re: /industrial production/, family: 'growth', w: 0.8, scale: 0.3, dir: 1, label: 'Production industrielle' },
  { key: 'regional', re: /philly fed|empire state|richmond|kansas city|dallas fed/, family: 'growth', w: 0.8, scale: 8, dir: 1, label: 'Enquête régionale Fed' },
  { key: 'housing', re: /housing starts|building permits|existing home sales|new home sales|pending home/, family: 'growth', w: 0.6, rel: 0.05, dir: 1, label: 'Immobilier' },
  { key: 'trade', re: /trade balance/, family: 'growth', w: 0.5, rel: 0.1, dir: 1, label: 'Balance commerciale' }
];

const MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '%': 1, '': 1 };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sgn = x => (x > 0 ? 1 : x < 0 ? -1 : 0);

/** "89K" -> 89000 · "0.3%" -> 0.3 · "4.25-4.50%" / texte libre / vide -> null */
function parseValue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s || /^[<>~≈]?\s*-?\d+(\.\d+)?\s*[%KMBT]?\s*-\s*\d/i.test(s)) return null;
  const m = s.match(/^[<>~≈]?\s*(-?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const n = Number(m[1]) * (MULT[m[2].toUpperCase()] || 1);
  return Number.isFinite(n) ? n : null;
}

function classify(title) {
  const t = String(title || '').toLowerCase();
  for (const ind of INDICATORS) if (ind.re.test(t)) return ind;
  return null;
}

const suffixOf = sample => { const m = String(sample == null ? '' : sample).trim().match(/([KMBT%])\s*$/i); return m ? m[1].toUpperCase() : ''; };
function fmtLike(n, sample) {
  const sfx = suffixOf(sample), d = MULT[sfx] || 1, x = Math.round((n / d) * 100) / 100;
  return String(x).replace('.', ',') + (sfx === '%' ? '%' : sfx);
}
function show(raw, parsed) {
  if (raw !== null && raw !== undefined && raw !== '' && typeof raw === 'string') return raw;
  return parsed === null ? '—' : String(Math.round(parsed * 100) / 100);
}

/* ---------------------------------------------------------------------------------------------- */
/* Contexte global : calendrier USD des derniers jours (alimenté par le serveur, partagé)          */
/* ---------------------------------------------------------------------------------------------- */
let CONTEXT = [];   // événements { title, time, impact, forecast, previous, actual } (valeurs numériques ou texte)
function setContext(events) { CONTEXT = Array.isArray(events) ? events.slice(0, 600) : []; }
function getContext() { return CONTEXT; }

const evTime = e => (Number.isFinite(e.t) ? e.t : (Number.isFinite(e.ts) ? e.ts : Date.parse(e.time)));
const evKey = e => String(e.id || '') || (String(e.title || e.name) + '|' + evTime(e));

/** Surprise orientée USD d'un événement DÉJÀ publié : s dans [-1 ; +1] (+ = USD plus fort), ou null. */
function surpriseScore(ind, ev) {
  const f = parseValue(ev.forecast), p = parseValue(ev.previous), a = parseValue(ev.actual);
  if (a === null) return null;
  let diff, k = 1, base = f;
  if (f !== null) diff = a - f; else if (p !== null) { diff = a - p; k = 0.6; base = p; } else return null;
  const scale = ind.scale || (ind.rel ? Math.max(Math.abs(base) * ind.rel, 1e-9) : null);
  if (!scale) return null;
  return { s: Math.tanh((diff / scale) / 1.5) * (ind.dir || 1) * k, diff, base: f !== null ? 'prévision' : 'précédent' };
}

/** Contexte : momentum par famille et composite général, à partir des publications réelles des 7 derniers jours. */
function buildContext(now, exceptKey, events) {
  const fam = {}, rows = []; let sumAll = 0, wAll = 0;
  for (const e of (events || CONTEXT)) {
    const t = evTime(e); if (!Number.isFinite(t) || t >= now || now - t > 7 * 864e5) continue;
    if (exceptKey && evKey(e) === exceptKey) continue;
    if (String(e.currency || 'USD').toUpperCase() !== 'USD') continue;
    const ind = classify(e.title || e.name); if (!ind || ind.family === 'policy' || ind.family === 'rates') continue;
    const sp = surpriseScore(ind, e); if (!sp) continue;
    const decay = Math.exp(-((now - t) / 864e5) / 3.5), w = ind.w * decay;
    const F = fam[ind.family] || (fam[ind.family] = { sum: 0, w: 0 });
    F.sum += sp.s * w; F.w += w; sumAll += sp.s * w; wAll += w;
    rows.push({ title: String(e.title || e.name), label: ind.label, family: ind.family, s: sp.s, actual: show(e.actual, parseValue(e.actual)), forecast: show(e.forecast, parseValue(e.forecast)), t });
  }
  const momentum = f => (fam[f] ? fam[f].sum / (fam[f].w + 1.5) : 0);   // rétrécissement : une seule donnée ne sature jamais
  return { n: rows.length, rows, momentum, composite: wAll ? sumAll / (wAll + 3) : 0, policyTilt: 0.65 * momentum('inflation') + 0.35 * momentum('labor') };
}

/* ---------------------------------------------------------------------------------------------- */
/* Analyse d'un événement                                                                         */
/* ---------------------------------------------------------------------------------------------- */
function pairsFromUsd(U, conf) {
  const out = {}, strong = U > 0;
  for (const [name, p] of Object.entries(PAIRS)) {
    const bias = p.usdQuote ? (strong ? 'SELL' : 'BUY') : (strong ? 'BUY' : 'SELL');
    out[name] = { bias, confidence: Math.max(51, Math.round(50 + (conf - 50) * p.sens)) };
  }
  return out;
}

function analyzeEvent(ev, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let ind = classify(ev.title || ev.name);
  const key = evKey(ev), ctx = buildContext(now, key, opts.context);
  const f = parseValue(ev.forecast), p = parseValue(ev.previous), a = parseValue(ev.actual);
  const published = a !== null;
  const drivers = []; let U = 0, basis, E = 0, S = 0, strongData = false, capPre = 72;

  const GENERIC = { key: 'generic', family: 'other', w: 1, rel: 0.03, dir: 1, label: String(ev.title || ev.name || 'News USD') };
  const isGeneric = !ind; if (isGeneric) ind = GENERIC;

  const M = ind.family === 'policy' || ind.family === 'rates' ? ctx.policyTilt : (ind.family === 'other' ? ctx.composite : ctx.momentum(ind.family));
  const C = ctx.composite;

  if (ind.family === 'policy') {
    U = 0.65 * ctx.policyTilt + 0.35 * C; basis = 'POLICY_CONTEXT'; capPre = 62;
    drivers.push({ label: 'Orientation de la Fed', text: `Déduite des chiffres récents : inflation ${arrow(ctx.momentum('inflation'))}, emploi ${arrow(ctx.momentum('labor'))} → ton ${ctx.policyTilt > 0 ? 'plutôt restrictif (USD soutenu)' : 'plutôt accommodant (USD pénalisé)'}.` });
  } else if (ind.family === 'rates') {
    const sp = published ? surpriseScore(ind, ev) : null;
    if (sp) { S = sp.s; U = 0.8 * S + 0.12 * ctx.policyTilt + 0.08 * C; basis = 'ACTUAL_VS_FORECAST'; strongData = true; drivers.push({ label: 'Décision publiée', text: `Réel ${show(ev.actual, a)} vs prévu ${show(ev.forecast, f)} : ${S > 0 ? 'plus restrictif que prévu → USD plus fort' : S < 0 ? 'plus accommodant que prévu → USD plus faible' : 'conforme'}.` }); }
    else {
      E = f !== null && p !== null ? Math.tanh(((f - p) / ind.scale) / 1.5) : 0;
      U = 0.5 * E + 0.35 * ctx.policyTilt + 0.15 * C; basis = 'POLICY_CONTEXT'; capPre = 66;
      drivers.push({ label: 'Attente du marché', text: f !== null && p !== null && f !== p ? `Prévision ${show(ev.forecast, f)} vs actuel ${show(ev.previous, p)} : ${f > p ? 'hausse attendue' : 'baisse attendue'} (déjà largement intégrée).` : 'Maintien attendu : le biais vient du ton probable de la Fed (inflation + emploi récents).' });
    }
  } else if (published && surpriseScore(ind, ev)) {
    const sp = surpriseScore(ind, ev); S = sp.s; strongData = true;
    U = 0.8 * S + 0.12 * M + 0.08 * C; basis = f !== null ? 'ACTUAL_VS_FORECAST' : 'ACTUAL_VS_PREVIOUS';
    drivers.push({ label: 'Surprise', text: `Réel ${show(ev.actual, a)} vs ${sp.base} ${show(f !== null ? ev.forecast : ev.previous, f !== null ? f : p)} (écart ${signed(sp.diff, f !== null ? ev.forecast : ev.previous)}) → ${ind.dir === -1 ? (S > 0 ? 'chiffre plus faible que prévu' : 'chiffre plus élevé que prévu') : (S > 0 ? 'chiffre plus fort que prévu' : 'chiffre plus faible que prévu')} → USD ${S > 0 ? 'plus fort' : 'plus faible'}.` });
  } else if (f !== null && p !== null) {
    const scale = ind.scale || (ind.rel ? Math.max(Math.abs(p) * ind.rel, 1e-9) : 1);
    E = Math.tanh(((f - p) / scale) / 1.5) * (ind.dir || 1);
    U = 0.55 * E + 0.30 * M + 0.15 * C; basis = 'FORECAST_VS_PREVIOUS';
    drivers.push({ label: 'Attente', text: `Prévision ${show(ev.forecast, f)} vs précédent ${show(ev.previous, p)} (${signed(f - p, ev.forecast)}) → le consensus attend ${E > 0 ? 'un chiffre favorable au dollar' : 'un chiffre défavorable au dollar'}.` });
  } else if (ctx.n) {
    U = 0.6 * M + 0.4 * C; basis = 'CONTEXT_ONLY'; capPre = 60;
    drivers.push({ label: 'Valeurs manquantes', text: 'Prévision ou précédent non publié(s) : le biais vient uniquement du contexte USD récent.' });
  } else { U = 0; basis = 'DEFAULT_USD'; capPre = 55; drivers.push({ label: 'Sans chiffres', text: 'Aucune valeur ni contexte récent : verdict par défaut, dollar considéré légèrement soutenu (valeur refuge). Conviction très faible.' }); }

  if (basis !== 'POLICY_CONTEXT' || ind.family === 'rates') {
    if (ctx.n) drivers.push({ label: 'Contexte USD (7 j)', text: `${ctx.n} publication(s) réelle(s) ces 7 derniers jours. ${cap(famName(ind.family))} : ${arrow(M)} ; ensemble des données USD : ${arrow(C)}.` });
  }

  // Jamais de NEUTRAL : si U est quasi nul, le contexte puis l'attente tranchent (conviction faible).
  let weak = false;
  if (Math.abs(U) < 0.03) {
    const pick = [M, C, E, S].find(x => Math.abs(x) > 0.005);
    U = (pick === undefined ? 1 : sgn(pick)) * 0.03; weak = true;
  }

  const agree = [E || S, M, C].filter(x => Math.abs(x) > 0.02).map(sgn);
  const aligned = agree.length > 1 && agree.every(x => x === sgn(U)), conflict = agree.some(x => x !== sgn(U));
  let conf = strongData ? 50 + 44 * Math.min(1, Math.abs(U) / 0.7) : 50 + 40 * Math.min(1, Math.abs(U) / 0.8);
  conf += aligned ? 3 : (conflict ? -4 : 0);
  conf = Math.round(clamp(conf, 51, strongData ? 92 : capPre));

  const usdStronger = U > 0, pairBias = pairsFromUsd(U, conf);
  const goldImpact = ind.w >= 2.5 ? 'HIGH' : ind.w >= 1.5 ? 'MEDIUM' : 'LOW';
  const reason = `${ind.label} : ${drivers[0].text} Dollar ${usdStronger ? 'plus fort' : 'plus faible'} → XAUUSD ${pairBias.XAUUSD.bias}${weak ? ' (conviction faible)' : ''}.`;

  return {
    ok: true,
    analysis: {
      bias: pairBias.XAUUSD.bias, confidence: pairBias.XAUUSD.confidence, data: 'REAL', basis, reason, weak,
      usd: usdStronger ? 'STRONGER' : 'WEAKER', usdScore: Math.round(U * 100) / 100, goldImpact,
      indicator: { key: ind.key, label: ind.label, family: ind.family, weight: ind.w },
      pairBias, drivers, scenarios: scenarios(ind, ev, f), published
    }
  };
}

function scenarios(ind, ev, f) {
  if (f === null || !ind.scale || ind.family === 'policy') return null;
  const hi = f + ind.scale, lo = f - ind.scale, up = ind.dir === -1 ? lo : hi, down = ind.dir === -1 ? hi : lo;   // seuils de surprise « significative »
  const mk = usdUp => { const o = {}; for (const [n, p] of Object.entries(PAIRS)) o[n] = p.usdQuote ? (usdUp ? 'SELL' : 'BUY') : (usdUp ? 'BUY' : 'SELL'); return o; };
  return {
    threshold: fmtLike(ind.scale, ev.forecast),
    usdUp: { when: `${ind.dir === -1 ? 'Réel ≤' : 'Réel ≥'} ${fmtLike(up, ev.forecast)}`, pairs: mk(true) },
    usdDown: { when: `${ind.dir === -1 ? 'Réel ≥' : 'Réel ≤'} ${fmtLike(down, ev.forecast)}`, pairs: mk(false) }
  };
}

function arrow(x) { return Math.abs(x) < 0.05 ? 'sans tendance nette' : x > 0 ? 'au-dessus des attentes (USD ▲)' : 'sous les attentes (USD ▼)'; }
function signed(d, sample) { return (d > 0 ? '+' : d < 0 ? '−' : '') + fmtLike(Math.abs(d), sample); }
function cap(x) { return x.charAt(0).toUpperCase() + x.slice(1); }
function famName(f) { return { labor: 'l\'emploi', inflation: 'l\'inflation', growth: 'la croissance' }[f] || 'ce secteur'; }

/** Analyse tous les événements d'une liste calendrier (impact high ou medium). Renvoie la liste enrichie (champ analysis / analysisError). */
function analyzeCalendar(events, opts = {}) {
  const ctxEvents = opts.context || CONTEXT, now = opts.now || Date.now();
  return (events || []).map(e => {
    const r = analyzeEvent(e, { now, context: ctxEvents });
    const analysis = r.ok ? Object.assign({}, r.analysis, { analyzed_at: new Date(now).toISOString(), phase: parseValue(e.actual) !== null ? 'POST' : 'PRE' }) : null;
    return Object.assign({}, e, { analysis, analysisError: r.ok ? null : r.reason });
  });
}

module.exports = { analyzeEvent, analyzeCalendar, setContext, getContext, classify, parseValue, PAIRS, INDICATORS };
