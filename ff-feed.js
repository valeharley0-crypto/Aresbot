'use strict';
/* ff-feed.js — Forecast / Previous des news américaines (flux gratuit Forex Factory).
   Le flux ne donne PAS l'Actual. Rien n'est inventé : champ vide => null. */
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const REFRESH_MS = 20 * 60 * 1000;   // le flux est limité en fréquence : on garde un cache
let cache = { events: [], fetchedAt: 0, ok: false, error: '' };
let busy = null, timer = null;

const KINDS = [
  ['corecpi', /core cpi/i], ['cpi', /\bcpi\b|consumer price/i], ['corepce', /core pce/i], ['pce', /\bpce\b/i],
  ['nfp', /non-?farm|payroll/i], ['ahe', /average hourly/i], ['unemp', /unemployment rate/i],
  ['claims', /jobless|unemployment claims/i], ['ppi', /\bppi\b|producer price/i], ['gdp', /\bgdp\b/i],
  ['retail', /retail sales/i], ['adp', /\badp\b/i], ['jolts', /jolts|job openings/i], ['ism', /\bism\b/i],
  ['rates', /interest rate|fed funds|rate decision|fomc statement/i]
];
const CATEGORY = { cpi: 'inflation', corecpi: 'inflation', ppi: 'inflation', pce: 'inflation', corepce: 'inflation',
  nfp: 'employment', ahe: 'employment', adp: 'employment', jolts: 'employment', unemp: 'unemployment', claims: 'unemployment',
  gdp: 'growth', retail: 'growth', ism: 'growth', rates: 'rates' };
const kindOf = n => { for (const [k, re] of KINDS) if (re.test(n)) return k; return null; };
const numVal = v => {
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

async function refresh() {
  if (busy) return busy;
  busy = (async () => {
    try {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      const t = ac ? setTimeout(() => ac.abort(), 10000) : null;
      const res = await fetch(FF_URL, ac ? { signal: ac.signal } : {});
      if (t) clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const list = await res.json();
      if (!Array.isArray(list)) throw new Error('format inattendu');
      const events = [];
      for (const o of list) {
        const ts = Date.parse(o.date);
        if (!isFinite(ts)) continue;
        const name = String(o.title || '');
        const kind = kindOf(name);
        const fRaw = String(o.forecast || '').trim(), pRaw = String(o.previous || '').trim();
        events.push({ name, country: String(o.country || ''), ts, impact: String(o.impact || '').toLowerCase(),
          kind, category: kind ? CATEGORY[kind] || null : null,
          forecastRaw: fRaw || null, previousRaw: pRaw || null, forecast: numVal(fRaw), previous: numVal(pRaw) });
      }
      cache = { events, fetchedAt: Date.now(), ok: true, error: '' };
    } catch (e) {
      cache.ok = false; cache.error = String(e && e.message || e);   // on garde les dernières données
      console.warn('[ff-feed]', cache.error);
    } finally { busy = null; }
  })();
  return busy;
}
function getEvents() {
  if (Date.now() - cache.fetchedAt > REFRESH_MS) refresh();
  return cache.events;
}
function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();
}
module.exports = { start, refresh, getEvents, status: () => ({ ok: cache.ok, fetchedAt: cache.fetchedAt, error: cache.error, count: cache.events.length }), _kindOf: kindOf };
