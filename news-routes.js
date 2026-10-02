/* =====================================================================
   news-routes.js — routes NEWS + garde « TRADE_BLOCKED_NEWS » (côté serveur)
   Aucune clé FinanceCalendar (API publique). Aucun secret dans ce fichier.
   Seule variable Render à ajouter : NEWS_ADMIN_TOKEN (protège l'écriture
   des réglages globaux : les membres ne peuvent pas les modifier).
   Requiert Node 18+ (fetch natif) et Express (déjà utilisé par server.js).
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FC_BASE = 'https://www.financecalendar.com/wp-json/fc/v1';
const REFRESH_MS = 5 * 60 * 1000;          // l'API met ses réponses en cache ~5 min
const STALE_MAX_MS = 6 * 60 * 60 * 1000;   // données gardées 6 h si l'API tombe
const SETTINGS_FILE = path.join(process.env.NEWS_DATA_DIR || __dirname, 'news-settings.json');
const DEFAULTS = { protection: true, before: 30, after: 30, high: true, medium: false, low: false, aiFund: true, goldImpact: true };

function normSettings(s) {
  s = s || {};
  const b = (v, d) => (v === undefined ? d : v === true || v === 'on' || v === 'true');
  const n = (v, d) => { v = Number(v); return Number.isFinite(v) && v >= 0 && v <= 180 ? Math.round(v) : d; };
  return {
    protection: b(s.protection, DEFAULTS.protection), before: n(s.before, DEFAULTS.before), after: n(s.after, DEFAULTS.after),
    high: b(s.high, DEFAULTS.high), medium: b(s.medium, DEFAULTS.medium), low: b(s.low, DEFAULTS.low),
    aiFund: b(s.aiFund, DEFAULTS.aiFund), goldImpact: b(s.goldImpact, DEFAULTS.goldImpact)
  };
}

let settings = { ...DEFAULTS };
try { settings = normSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); } catch (e) { /* défauts */ }
function saveSettings() { try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) { console.warn('[news] settings non persistés:', e.message); } }

/* ---------- Calendrier (mêmes règles de normalisation que le front) ---------- */
const pick = (o, keys) => { for (const k of keys) { const v = o[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return v; } return null; };
function extractList(d) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') { for (const k of ['events', 'data', 'results', 'calendar', 'items']) if (Array.isArray(d[k])) return d[k]; }
  return [];
}
function parseTime(o) {
  const ts = pick(o, ['timestamp', 'time_ts', 'unix', 'epoch']);
  if (ts !== null && Number.isFinite(+ts)) return +ts < 1e12 ? +ts * 1000 : +ts;
  for (const k of ['time_utc', 'datetime_utc', 'date_utc', 'datetime', 'eventDate', 'releaseDate', 'date_time', 'date', 'time']) {
    const v = o[k]; if (!v) continue;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) && o.time && /^\d{1,2}:\d{2}/.test(String(o.time))) s += 'T' + String(o.time).trim().slice(0, 5).padStart(5, '0') + ':00Z';
    else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(' ', 'T') + 'Z';   // sans fuseau => UTC
    const t = Date.parse(s); if (!isNaN(t)) return t;
  }
  return null;
}
function normImpact(o) {
  const raw = String(pick(o, ['impact', 'importance', 'priority', 'impactLevel', 'volatility']) || '').toLowerCase();
  if (/(^|\b)(3|high|red)(\b|$)/.test(raw) || raw.includes('high')) return 'high';
  if (/(^|\b)(2|medium|moderate|orange)(\b|$)/.test(raw) || raw.includes('med')) return 'medium';
  return 'low';
}
const FOREIGN_RE = /zone euro|eurozone|euro area|euro zone|allemagne|germany|german|\bifo\b|\bzew\b|france|french|ital|espagn|spain|royaume|united kingdom|\buk\b|\bboe\b|\becb\b|\bbce\b|japon|japan|\bboj\b|chine|china|canad|australi|\brba\b|nouvelle-z|new zealand|suisse|swiss/i;
function isUsd(o, name) {
  if (FOREIGN_RE.test(name)) return false;   // l'API étiquette parfois à tort une news étrangère « US · USD »
  const cur = String(pick(o, ['currency', 'countryCurrency', 'currency_code']) || '').toUpperCase();
  if (cur) return cur === 'USD';
  const c = String(pick(o, ['country', 'country_code', 'countryCode', 'region']) || '').toLowerCase();
  if (c) return ['us', 'usa', 'united states', 'united states of america'].includes(c);
  return /fomc|federal reserve|nonfarm|non-farm|\bnfp\b|jobless|\bcpi\b|\bppi\b|\bpce\b|powell|\bfed\b/i.test(name);
}
/* Valeurs numériques (forecast / previous / actual) : "3.2%" -> 3.2, "250K" -> 250. Absent => null (jamais inventé). */
function numVal(v) {
  if (v === null || v === undefined) return null;
  const m = String(v).replace(/\u2212/g, '-').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function guessCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/unemployment rate/.test(n)) return 'unemployment';
  if (/\bcpi\b|\bppi\b|\bpce\b|inflation|price index/.test(n)) return 'inflation';
  if (/non-?farm|\bnfp\b|payroll|jobless|employment change|adp|average hourly|jolts/.test(n)) return 'employment';
  if (/\bgdp\b|retail sales|\bpmi\b|\bism\b|durable goods|industrial production|consumer confidence|housing/.test(n)) return 'growth';
  if (/fomc|interest rate|fed funds|rate decision/.test(n)) return 'rates';
  return null;
}
function normalize(list) {
  const seen = new Set(), out = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const name = String(pick(o, ['title', 'name', 'event', 'description']) || '').trim();
    const ts = parseTime(o);
    if (!name || ts === null) continue;
    const k = name + '|' + ts; if (seen.has(k)) continue; seen.add(k);
    out.push({
      name, ts, usd: isUsd(o, name), impact: normImpact(o), category: guessCategory(name),
      forecast: numVal(pick(o, ['forecast', 'consensus', 'estimate', 'expected'])),
      previous: numVal(pick(o, ['previous', 'prior'])),
      actual: numVal(pick(o, ['actual', 'result']))
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

let cache = { events: [], fetchedAt: 0, ok: null, error: '' };
let inflight = null;
async function refreshCalendar() {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const ymd = d => d.toISOString().slice(0, 10);
      const from = new Date(Date.now() - 86400000), to = new Date(Date.now() + 7 * 86400000);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      let list = [];
      try {
        const r = await fetch(`${FC_BASE}/calendar?from=${ymd(from)}&to=${ymd(to)}`, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        list = extractList(await r.json());
      } finally { clearTimeout(t); }
      cache = { events: normalize(list), fetchedAt: Date.now(), ok: true, error: '' };
    } catch (e) {
      cache.ok = false; cache.error = String(e.message || e);   // on garde les dernières données (jusqu'à STALE_MAX_MS)
    } finally { inflight = null; }
  })();
  return inflight;
}

function getPause(now = Date.now()) {
  const none = { paused: false, status: 'TRADE_ALLOWED', reason: null, event: null, resumeAt: null };
  if (!settings.protection) return none;
  if (!cache.fetchedAt || now - cache.fetchedAt > STALE_MAX_MS) return none;   // ne jamais bloquer sur des données inconnues/périmées
  const on = l => (l === 'high' ? settings.high : l === 'medium' ? settings.medium : settings.low);
  for (const e of cache.events) {
    if (!e.usd || !on(e.impact)) continue;
    const start = e.ts - settings.before * 60000, end = e.ts + settings.after * 60000;
    if (now >= start && now < end) {
      return { paused: true, status: 'TRADE_BLOCKED_NEWS', reason: 'HIGH IMPACT NEWS', event: { name: e.name, ts: e.ts, impact: e.impact }, resumeAt: end };
    }
  }
  return none;
}

/* Middleware à placer devant l'exécution automatique du ROBOT. */
function newsGuard(req, res, next) {
  if (Date.now() - cache.fetchedAt > REFRESH_MS + 60000) refreshCalendar();   // rafraîchissement opportuniste (non bloquant)
  const p = getPause();
  if (!p.paused) return next();
  return res.status(423).json({ ok: false, status: 'TRADE_BLOCKED_NEWS', reason: p.reason, news: p.event.name, resumeAt: new Date(p.resumeAt).toISOString() });
}

function tokenOk(req) {
  const expected = process.env.NEWS_ADMIN_TOKEN || '';
  const got = String(req.get('x-news-admin') || '');
  if (!expected || !got) return false;
  const a = crypto.createHash('sha256').update(expected).digest(), b = crypto.createHash('sha256').update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

function mountNews(app) {
  const express = require('express');
  refreshCalendar();
  const t = setInterval(refreshCalendar, REFRESH_MS); if (t.unref) t.unref();

  app.get('/api/news/settings', (req, res) => res.json({ ok: true, settings }));

  app.post('/api/news/settings', express.json({ limit: '4kb' }), (req, res) => {
    if (!process.env.NEWS_ADMIN_TOKEN) return res.status(503).json({ ok: false, error: 'NEWS_ADMIN_TOKEN non configuré sur le serveur' });
    if (!tokenOk(req)) return res.status(403).json({ ok: false, error: 'Accès admin refusé' });
    settings = normSettings(req.body);
    saveSettings();
    res.json({ ok: true, settings });
  });

  app.get('/api/news/status', (req, res) => {
    const p = getPause();
    res.json({ ok: true, ...p, resumeAt: p.resumeAt ? new Date(p.resumeAt).toISOString() : null, calendar: { ok: cache.ok, fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null } });
  });

  const ff = require('./ff-feed');
  app.get('/api/news/forecasts', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source: 'forexfactory', status: ff.status(), events: ff.getEvents().filter(e => e.country === 'USD') });
  });
  return { newsGuard, getPause, getEvents: () => cache.events };
}

module.exports = mountNews;
module.exports.newsGuard = newsGuard;
module.exports.getPause = getPause;
module.exports._normalize = normalize;
