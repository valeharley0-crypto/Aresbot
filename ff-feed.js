'use strict';

/**
 * ff-feed.js — ARES · calendrier économique (Forex Factory via le flux public faireconomy)
 *
 * RÈGLES
 *  - Aucune news n'est inventée : seules les lignes réellement reçues du flux sont exposées.
 *  - Flux indisponible => getEvents() renvoie [] (jamais d'exception) et status().state = 'UNAVAILABLE'.
 *  - En cas d'échec après un succès, le dernier calendrier réel est conservé ; status().fetchedAt
 *    garde l'heure du DERNIER succès, ce qui permet au moteur de détecter un calendrier périmé.
 *  - Compatible avec l'ancienne API : start / stop / refresh / update / get / getNews / getEvents / status.
 *
 * CONFIGURATION (variables d'environnement, toutes facultatives)
 *  NEWS_CALENDAR_URL   une ou plusieurs URL séparées par des virgules (défaut : flux faireconomy cette semaine + semaine prochaine)
 *  NEWS_FEED_URL       ancien nom, toujours accepté si NEWS_CALENDAR_URL est vide
 *  NEWS_REFRESH_MIN    période de rafraîchissement en minutes (défaut 30, minimum 5)
 *
 * Forme d'un événement exposé :
 *  { id, name, title, country, currency, impact: 'high'|'medium'|'low'|'holiday'|'unknown', ts (ms), time (ISO),
 *    category|null, forecast|null, previous|null, actual|null (nombres), forecastText, previousText, actualText (texte brut du flux) }
 */

const DEFAULT_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
];

const DEFAULTS = {
  enabled: true,
  refreshMs: 30 * 60 * 1000,
  retryMinMs: 60 * 1000,
  timeoutMs: 10000,
  staleAfterMs: 3 * 60 * 60 * 1000,
  maxEvents: 1500,
  minGapMs: 30 * 1000,
  backoff429Ms: 15 * 60 * 1000
};

let options = Object.assign({}, DEFAULTS);
let events = [];
let fetchedAt = 0;
let lastAttemptAt = 0;
let lastError = null;
let failures = 0;
let nextAllowedAt = 0;
let timer = null;
let running = false;
let inflight = null;
let fetchImpl = null; // injection pour les tests

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function configuredUrls() {
  const raw = process.env.NEWS_CALENDAR_URL || process.env.NEWS_FEED_URL || '';
  const list = String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(s => /^https?:\/\//i.test(s));
  return list.length ? list : DEFAULT_URLS.slice();
}

function envRefreshMs() {
  const m = Number(process.env.NEWS_REFRESH_MIN);
  return Number.isFinite(m) && m >= 5 ? m * 60 * 1000 : null;
}

/* ------------------------------------------------------------------ */
/* Normalisation (données réelles uniquement)                          */
/* ------------------------------------------------------------------ */

const COUNTRY_TO_CCY = {
  US: 'USD', USA: 'USD', 'UNITED STATES': 'USD',
  EU: 'EUR', EMU: 'EUR', EUROZONE: 'EUR',
  GB: 'GBP', UK: 'GBP', 'UNITED KINGDOM': 'GBP',
  JP: 'JPY', JAPAN: 'JPY',
  CA: 'CAD', CANADA: 'CAD',
  AU: 'AUD', AUSTRALIA: 'AUD',
  NZ: 'NZD', 'NEW ZEALAND': 'NZD',
  CH: 'CHF', SWITZERLAND: 'CHF',
  CN: 'CNY', CHINA: 'CNY'
};

function toCurrency(raw) {
  const c = String(raw.currency || '').trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(c)) return c;
  const k = String(raw.country || '').trim().toUpperCase();
  if (COUNTRY_TO_CCY[k]) return COUNTRY_TO_CCY[k];
  return /^[A-Z]{3}$/.test(k) ? k : (k || 'ALL').slice(0, 12);
}

function toImpact(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (s.includes('high')) return 'high';
  if (s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  if (s.includes('holiday') || s.includes('non-economic') || s.includes('non economic')) return 'holiday';
  return 'unknown';
}

const MULT = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, '%': 1, '': 1 };

/** "0.3%" -> 0.3 · "227K" -> 227000 · "-1.2M" -> -1200000 · "" / "4.25-4.50%" / texte libre -> null */
function parseValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!s) return null;
  if (/^[<>~≈]?\s*-?\d+(\.\d+)?\s*[%KMBT]?\s*-\s*\d/i.test(s)) return null; // fourchette : ambigu, non interprété
  const m = s.match(/^[<>~≈]?\s*(-?\d+(?:\.\d+)?)\s*([KMBT%]?)/i);
  if (!m) return null;
  const n = Number(m[1]) * (MULT[m[2].toUpperCase()] || 1);
  return Number.isFinite(n) ? n : null;
}

/**
 * Catégorie utilisée par le moteur pour estimer un biais USD/Gold (inflation, employment, growth, rates, unemployment).
 * Classement par mots-clés du titre ; titre non reconnu => null => le moteur répondra DATA_UNAVAILABLE (rien d'inventé).
 */
function classify(title) {
  const t = String(title || '').toLowerCase();
  if (/unemployment|jobless|claimant/.test(t)) return 'unemployment';
  if (/\bcpi\b|\bppi\b|\bpce\b|inflation|price index|deflator|\bprices?\b/.test(t)) return 'inflation';
  if (/non-?farm|\bnfp\b|employment change|payroll|\badp\b|average hourly earnings|employment cost|jolts|job openings/.test(t)) return 'employment';
  if (/federal funds|fed funds|interest rate|rate decision|rate statement/.test(t)) return 'rates';
  if (/\bgdp\b|retail sales|\bism\b|\bpmi\b|durable goods|consumer confidence|consumer sentiment|industrial production/.test(t)) return 'growth';
  return null;
}

const slug = s => String(s).toLowerCase().replace(/\W+/g, '-');

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.name || raw.event || '').trim();
  if (!title) return null;

  let ts = NaN;
  if (raw.date !== undefined) ts = Date.parse(raw.date);
  if (!Number.isFinite(ts) && raw.datetimeISO !== undefined) ts = Date.parse(raw.datetimeISO);
  if (!Number.isFinite(ts) && raw.datetime !== undefined) ts = Date.parse(raw.datetime);
  if (!Number.isFinite(ts) && Number.isFinite(Number(raw.dateline))) ts = Number(raw.dateline) * 1000;
  if (!Number.isFinite(ts)) return null; // sans heure fiable : ignoré (jamais d'heure inventée)

  const currency = toCurrency(raw);
  const txt = v => (v === null || v === undefined || v === '' ? null : String(v));
  return {
    id: `${currency}-${ts}-${slug(title)}`,
    name: title,
    title,
    country: currency, // le flux faireconomy donne le code devise dans « country »
    currency,
    impact: toImpact(raw.impact !== undefined ? raw.impact : raw.importance),
    ts,
    time: new Date(ts).toISOString(),
    category: classify(title),
    forecast: parseValue(raw.forecast),
    previous: parseValue(raw.previous),
    actual: parseValue(raw.actual),
    forecastText: txt(raw.forecast),
    previousText: txt(raw.previous),
    actualText: txt(raw.actual)
  };
}

function extractItems(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of ['events', 'data', 'news', 'results', 'calendar']) {
      if (Array.isArray(json[k])) return json[k];
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Réseau                                                              */
/* ------------------------------------------------------------------ */

async function fetchJson(url) {
  if (fetchImpl) return fetchImpl(url);
  if (typeof fetch !== 'function') throw new Error('fetch indisponible (Node >= 18 requis)');
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const to = ac ? setTimeout(() => ac.abort(), options.timeoutMs) : null;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'ARES-AI-News/2.0' },
      signal: ac ? ac.signal : undefined
    });
    if (!res.ok) {
      const e = new Error('HTTP ' + res.status);
      e.status = res.status;
      throw e;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('délai dépassé');
    throw e;
  } finally {
    if (to) clearTimeout(to);
  }
}

/* ------------------------------------------------------------------ */
/* Rafraîchissement                                                    */
/* ------------------------------------------------------------------ */

/** Ne rejette jamais. Renvoie la liste courante (éventuellement vide). */
async function refresh(opts = {}) {
  if (!options.enabled) return events.slice();
  const now = Date.now();
  if (inflight) return inflight;
  if (!opts.force && now < nextAllowedAt) return events.slice();
  if (!opts.force && lastAttemptAt && now - lastAttemptAt < options.minGapMs) return events.slice();

  inflight = (async () => {
    lastAttemptAt = Date.now();
    const urls = configuredUrls();
    const merged = new Map();
    let primaryOk = false;
    let primaryError = null;

    for (let i = 0; i < urls.length; i++) {
      try {
        const json = await fetchJson(urls[i]);
        const items = extractItems(json);
        if (!items) throw new Error('réponse inattendue (tableau d\'événements absent)');
        for (const raw of items) {
          const ev = normalize(raw);
          if (ev) merged.set(ev.id, ev);
        }
        if (i === 0) primaryOk = true;
      } catch (e) {
        const msg = String((e && e.message) || e).slice(0, 160);
        if (i === 0) primaryError = msg;
        if (e && e.status === 429) nextAllowedAt = Date.now() + options.backoff429Ms;
        else if (i > 0 && /HTTP 404/.test(msg)) { /* semaine suivante pas encore publiée : normal */ }
        else if (i > 0) console.warn('[news] source secondaire indisponible:', msg);
      }
    }

    if (primaryOk) {
      events = [...merged.values()].sort((a, b) => a.ts - b.ts).slice(0, options.maxEvents);
      fetchedAt = Date.now();
      lastError = null;
      failures = 0;
    } else {
      failures++;
      lastError = primaryError || 'flux indisponible';
      console.warn('[news] calendrier indisponible:', lastError);
    }
    return events.slice();
  })().finally(() => { inflight = null; });

  return inflight;
}

function scheduleNext() {
  if (!running) return;
  const base = options.refreshMs;
  const delay = failures === 0
    ? base
    : Math.min(base, options.retryMinMs * Math.pow(2, Math.min(failures - 1, 6)));
  const wait = Math.max(delay, nextAllowedAt - Date.now(), 1000);
  timer = setTimeout(async () => {
    try { await refresh(); } catch (e) { /* refresh ne rejette pas */ }
    scheduleNext();
  }, wait);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

/** Démarre le rafraîchissement automatique. Renvoie status() (synchrone). */
function start(custom = {}) {
  stop();
  options = Object.assign({}, DEFAULTS, custom);
  const envMs = envRefreshMs();
  if (envMs && custom.refreshMs === undefined) options.refreshMs = envMs;
  running = true;
  refresh({ force: true }).catch(() => {}).then(scheduleNext);
  return status();
}

function stop() {
  running = false;
  if (timer) { clearTimeout(timer); timer = null; }
}

/* ------------------------------------------------------------------ */
/* Lecture                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tous les événements réels connus (triés par heure). Ne lève jamais.
 * Filtres facultatifs : { currency, impact (liste ou chaîne), from (ms), to (ms) }.
 */
function getEvents(filter) {
  let list = events;
  if (filter && typeof filter === 'object') {
    const cur = filter.currency ? String(filter.currency).toUpperCase() : null;
    const imp = filter.impact
      ? (Array.isArray(filter.impact) ? filter.impact : String(filter.impact).split(',')).map(x => String(x).trim().toLowerCase())
      : null;
    list = list.filter(e =>
      (!cur || e.currency === cur) &&
      (!imp || imp.includes(e.impact)) &&
      (!Number.isFinite(filter.from) || e.ts >= filter.from) &&
      (!Number.isFinite(filter.to) || e.ts <= filter.to));
  }
  return list.slice();
}

/** Compatibilité : get(limit) / getNews(limit) renvoient les mêmes événements, tronqués si limit est fourni. */
function getNews(limit) {
  const all = getEvents();
  const n = Number(limit);
  return Number.isFinite(n) && n > 0 ? all.slice(0, n) : all;
}
const get = getNews;
async function update() { return refresh({ force: true }); }

function status() {
  const now = Date.now();
  const age = fetchedAt ? now - fetchedAt : null;
  let state = 'UNAVAILABLE';
  if (fetchedAt) state = age > options.staleAfterMs ? 'STALE' : 'AVAILABLE';
  return {
    ok: fetchedAt > 0,
    state,
    enabled: options.enabled,
    source: 'Forex Factory (faireconomy)',
    urls: configuredUrls().length,
    items: events.length,
    fetchedAt: fetchedAt || null,
    lastUpdate: fetchedAt ? new Date(fetchedAt).toISOString() : null,
    ageSec: age === null ? null : Math.round(age / 1000),
    lastError,
    symbol: 'XAUUSD'
  };
}

/* Utilitaires de test (non utilisés en production) */
function _setFetcher(fn) { fetchImpl = typeof fn === 'function' ? fn : null; }
function _reset() {
  stop();
  events = []; fetchedAt = 0; lastAttemptAt = 0; lastError = null; failures = 0; nextAllowedAt = 0; inflight = null;
  options = Object.assign({}, DEFAULTS);
}

module.exports = {
  start,
  stop,
  refresh,
  update,
  get,
  getNews,
  getEvents,
  status,
  _normalize: normalize,
  _parseValue: parseValue,
  _classify: classify,
  _setFetcher,
  _reset
};
