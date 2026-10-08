'use strict';
/**
 * ARES — Providers de données (remplaçables sans toucher au moteur) :
 *   MarketDataProvider : prix / bougies / compte  -> source réelle = cTrader (ctrader/execution.js alimente le moteur)
 *   OrderFlowProvider  : Bookmap + Exocharts (+ source externe) -> delta, CVD, footprint, imbalance, absorption, volume profile, POC, VAH/VAL, liquidité...
 *   NewsProvider       : calendrier macro (Forex Factory via ff-feed.js)
 * RÈGLE ABSOLUE : jamais de donnée inventée. Chaque source a un état explicite :
 *   connexion : CONNECTED | NOT_CONNECTED      donnée : AVAILABLE | STALE | UNAVAILABLE
 */

class MarketDataProvider { name() { return 'abstract'; } status() { return { status: 'UNAVAILABLE' }; } }
class CTraderMarketData extends MarketDataProvider {
  constructor(manager) { super(); this.manager = manager; }
  name() { return 'cTrader Open API'; }
  status(userId) { const s = this.manager.sessionStatus(userId); return { status: s.status === 'CONNECTED' ? 'AVAILABLE' : 'UNAVAILABLE', detail: s.message }; }
}

const SCALARS = ['delta', 'cvd', 'imbalance', 'bidAskImbalance', 'absorption', 'sweeps', 'volume', 'bid', 'ask', 'poc', 'vwap', 'vah', 'val', 'bidDepth', 'askDepth'];
const ARRAYS = ['heatmap', 'liquidityZones', 'footprint', 'volumeProfile', 'largeOrders', 'dom', 'tape'];
const MAX_ARRAY = 300, MAX_KEYS = 12;

/** Valide un message order flow : champs connus uniquement, nombres finis, tableaux bornés d'objets plats. Lève une Error sinon. */
function sanitizeFlow(body) {
  const out = {}; let n = 0;
  for (const f of SCALARS) if (body[f] !== undefined && body[f] !== null) { const v = Number(body[f]); if (!Number.isFinite(v)) throw new Error(f + ' doit être numérique'); out[f] = v; n++; }
  for (const f of ARRAYS) {
    if (body[f] === undefined || body[f] === null) continue;
    if (!Array.isArray(body[f])) throw new Error(f + ' doit être un tableau');
    out[f] = body[f].slice(0, MAX_ARRAY).map(row => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(f + ' : objets plats requis');
      const o = {}; const ks = Object.keys(row).slice(0, MAX_KEYS);
      for (const k of ks) { const v = row[k]; if (typeof v === 'number' && Number.isFinite(v)) o[k] = v; else if (typeof v === 'string') o[k] = v.slice(0, 40); else if (typeof v === 'boolean') o[k] = v; }
      return o;
    });
    n++;
  }
  if (!n) throw new Error('aucune mesure order flow dans le message');
  return out;
}
const symKey = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '');

/**
 * Une source (Bookmap, Exocharts ou externe). Deux modes d'alimentation RÉELS :
 *  - PUSH : un add-on / exporteur réel POST sur /api/orderflow/push (clé ORDERFLOW_PUSH_KEY) avec source = id.
 *  - HTTP : si <ID>_API_URL est défini, le serveur interroge GET <URL>?symbol=XAUUSD (Authorization: Bearer <ID>_API_KEY) et attend un JSON
 *           avec les champs ci-dessus (à plat ou sous "data"). La clé reste côté serveur.
 * Sans URL ni message reçu : NOT_CONNECTED / UNAVAILABLE. Aucune valeur n'est jamais fabriquée.
 */
class FlowSource {
  constructor({ id, label, url = '', key = '', maxAgeSec = 30, timeoutMs = 5000, now = () => Date.now(), fetchFn = typeof fetch === 'function' ? fetch : null }) {
    Object.assign(this, { id, label, url: String(url || '').trim(), key: String(key || ''), maxAgeMs: maxAgeSec * 1000, timeoutMs, now, fetchFn });
    this.data = {}; this.lastError = null; this.lastOkAt = 0;
  }
  mode() { return this.url ? 'HTTP' : 'PUSH'; }
  push(body) { const sym = symKey(body.symbol); if (!sym) throw new Error('symbol requis'); const f = sanitizeFlow(body); let ts = this.now(); if (body.ts !== undefined) { const t = Number(body.ts); if (Number.isFinite(t) && t > 0 && t <= ts + 5000) ts = t; } this.data[sym] = { ts, fields: f }; this.lastOkAt = this.now(); return { ok: true, source: this.id, symbol: sym }; }
  async poll(symbols) {
    if (!this.url || !this.fetchFn) return;
    for (const s of symbols) {
      try {
        const u = new URL(this.url); u.searchParams.set('symbol', s);
        const ac = typeof AbortController === 'function' ? new AbortController() : null; const t = ac ? setTimeout(() => ac.abort(), this.timeoutMs) : null;
        const res = await this.fetchFn(u.toString(), { headers: Object.assign({ Accept: 'application/json' }, this.key ? { Authorization: 'Bearer ' + this.key } : {}), signal: ac ? ac.signal : undefined });
        if (t) clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json(); const body = (j && typeof j.data === 'object' && j.data) ? j.data : j;
        this.data[s] = { ts: this.now(), fields: sanitizeFlow(body || {}) }; this.lastOkAt = this.now(); this.lastError = null;
      } catch (e) { this.lastError = String(e && e.name === 'AbortError' ? 'délai dépassé' : e && e.message || e).replace(this.key || '\u0000', '***').slice(0, 160); }
    }
  }
  get(symbol) {
    const sym = symKey(symbol), r = this.data[sym];
    if (!r) return { status: 'UNAVAILABLE', source: this.id, reason: this.url ? (this.lastError || 'aucune donnée reçue') : 'aucune donnée reçue (source non connectée)' };
    const age = this.now() - r.ts;
    return Object.assign({ status: age > this.maxAgeMs ? 'STALE' : 'AVAILABLE', source: this.id, ts: r.ts, ageSec: Math.round(age / 1000) }, r.fields);
  }
  status() {
    const recent = this.lastOkAt && this.now() - this.lastOkAt <= this.maxAgeMs;
    const syms = {}; for (const k of Object.keys(this.data)) syms[k] = this.get(k).status;
    const anyAvail = Object.values(syms).includes('AVAILABLE');
    return { id: this.id, label: this.label, mode: this.mode(), configured: !!this.url || this.lastOkAt > 0,
      connection: recent ? 'CONNECTED' : 'NOT_CONNECTED', data: anyAvail ? 'AVAILABLE' : (Object.keys(syms).length ? 'STALE' : 'UNAVAILABLE'),
      lastUpdate: this.lastOkAt ? new Date(this.lastOkAt).toISOString() : null, symbols: syms, error: this.lastError,
      message: recent ? 'Source connectée' : `Connect a supported ${this.label} data source.` };
  }
}

/** Order flow combiné : fusionne les sources AVAILABLE ; STALE si toutes périmées ; UNAVAILABLE sinon. API utilisée par le moteur : get(symbol). */
class OrderFlowHub {
  constructor(opts = {}) {
    const mk = (id, label, env) => new FlowSource({ id, label, url: opts.env ? opts.env[env + '_API_URL'] : process.env[env + '_API_URL'], key: opts.env ? opts.env[env + '_API_KEY'] : process.env[env + '_API_KEY'], maxAgeSec: opts.maxAgeSec || Number(process.env.ORDERFLOW_MAX_AGE_SEC) || 30, now: opts.now, fetchFn: opts.fetchFn });
    this.sources = { bookmap: mk('bookmap', 'Bookmap', 'BOOKMAP'), exocharts: mk('exocharts', 'Exocharts', 'EXOCHARTS'), external: mk('external', 'external', 'ORDERFLOW_EXTERNAL') };
    this.symbols = (opts.symbols || (process.env.ORDERFLOW_SYMBOLS || 'XAUUSD,EURUSD,GBPUSD,USDJPY').split(',')).map(symKey).filter(Boolean);
    this.pollMs = opts.pollMs || Number(process.env.ORDERFLOW_POLL_MS) || 3000; this.timer = null;
  }
  name() { return 'Bookmap / Exocharts / source externe'; }
  push(body) { const id = String(body && body.source || '').toLowerCase(); return (this.sources[id] || this.sources.external).push(body || {}); }
  source(id) { return this.sources[id]; }
  get(symbol) {
    const all = Object.values(this.sources).map(s => s.get(symbol));
    const ok = all.filter(x => x.status === 'AVAILABLE'), st = all.filter(x => x.status === 'STALE');
    if (ok.length) return Object.assign({}, ...ok.map(x => { const o = Object.assign({}, x); delete o.status; return o; }), { status: 'AVAILABLE', sources: ok.map(x => x.source) });
    if (st.length) return { status: 'STALE', sources: st.map(x => x.source), reason: 'données order flow trop anciennes' };
    return { status: 'UNAVAILABLE', reason: 'aucune source order flow connectée' };
  }
  status() {
    const s = Object.values(this.sources).map(x => x.status());
    const avail = s.some(x => x.data === 'AVAILABLE'), stale = s.some(x => x.data === 'STALE');
    return { provider: this.name(), status: avail ? 'AVAILABLE' : (stale ? 'STALE' : 'UNAVAILABLE'), sources: Object.fromEntries(s.map(x => [x.id, x])) };
  }
  start() {
    if (this.timer) return;
    const withUrl = Object.values(this.sources).filter(x => x.url);
    if (!withUrl.length) return;
    const run = () => withUrl.forEach(x => x.poll(this.symbols).catch(() => {}));
    run(); this.timer = setInterval(run, this.pollMs); if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/**
 * Calendrier news : adaptateur sur ff-feed.js (USD, impact élevé pour le moteur).
 * RÈGLES : aucune news inventée · flux absent / en erreur -> état UNAVAILABLE (jamais d'exception, jamais d'événement fictif).
 * Le moteur décide alors (règle news.requireData) : calendrier indisponible ou périmé -> WAIT / BLOCK.
 * Compatible avec un feed qui expose getEvents() (ff-feed.js) ou, à défaut, getNews() / get().
 */
class NewsProvider {
  constructor(feed, opts = {}) {
    this.feed = feed || null;
    this.pastMs = opts.pastMs || 3 * 3600e3;
    this.futureMs = opts.futureMs || 36 * 3600e3;
  }
  name() { return 'Forex Factory (flux faireconomy)'; }
  start() {
    try { if (this.feed && typeof this.feed.start === 'function') this.feed.start(); }
    catch (e) { console.warn('[news] démarrage du feed impossible:', e && e.message); }
    return this.status();
  }
  stop() { try { if (this.feed && typeof this.feed.stop === 'function') this.feed.stop(); } catch (e) { /* ignore */ } }
  refresh() {
    try { return Promise.resolve(this.feed && typeof this.feed.refresh === 'function' ? this.feed.refresh() : []).catch(() => []); }
    catch (e) { return Promise.resolve([]); }
  }
  /** Événements réels du feed (tableau, jamais d'exception). */
  _events() {
    const f = this.feed;
    if (!f) return [];
    try {
      const fn = typeof f.getEvents === 'function' ? f.getEvents
        : (typeof f.getNews === 'function' ? f.getNews : (typeof f.get === 'function' ? f.get : null));
      const list = fn ? fn.call(f) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  /** { state: AVAILABLE | STALE | UNAVAILABLE, available, fetchedAt (ms | null), items, error, source ... } */
  status() {
    let s = null;
    try { s = this.feed && typeof this.feed.status === 'function' ? this.feed.status() : null; } catch (e) { s = null; }
    const fetchedAt = s && Number(s.fetchedAt) > 0 ? Number(s.fetchedAt) : null;
    const state = fetchedAt ? (s.state === 'STALE' ? 'STALE' : 'AVAILABLE') : 'UNAVAILABLE';
    return Object.assign({}, s || {}, {
      provider: this.name(),
      state,
      available: !!fetchedAt,
      fetchedAt,
      items: s && Number.isFinite(s.items) ? s.items : this._events().length,
      error: (s && s.lastError) || (this.feed ? null : 'aucun feed configuré')
    });
  }
  static _ts(e) {
    if (Number.isFinite(e.ts)) return e.ts;
    const t = Date.parse(e.time || e.date || e.publishedAt);
    return Number.isFinite(t) ? t : NaN;
  }
  static _ccy(e) { return String(e.currency || e.country || '').toUpperCase(); }
  /** Événements USD à fort impact pour le moteur (format attendu par engine.setNews). */
  upcoming(now = Date.now()) {
    return this._events()
      .filter(e => {
        const t = NewsProvider._ts(e);
        return NewsProvider._ccy(e) === 'USD' && String(e.impact).toLowerCase() === 'high' &&
          Number.isFinite(t) && t > now - this.pastMs && t < now + this.futureMs;
      })
      .map(e => {
        const t = NewsProvider._ts(e);
        return { title: e.name || e.title, time: new Date(t).toISOString(), currency: 'USD', impact: 'high', category: e.category || null, forecast: e.forecast === undefined ? null : e.forecast, previous: e.previous === undefined ? null : e.previous, actual: null };
      });
  }
  /**
   * Calendrier réel pour l'interface (NEWS). Filtres : currency (défaut USD), impacts (défaut high,medium), days (défaut 7), pastHours (défaut 12).
   * Valeurs prévision / précédent : texte du flux (ex. « 0.3% »), null si non publié.
   */
  calendar({ now = Date.now(), currency = 'USD', impacts = ['high', 'medium'], days = 7, pastHours = 12 } = {}) {
    const cur = currency ? String(currency).toUpperCase() : null;
    const imp = (Array.isArray(impacts) ? impacts : String(impacts).split(',')).map(x => String(x).trim().toLowerCase()).filter(Boolean);
    const from = now - Math.max(0, Number(pastHours) || 0) * 3600e3, to = now + Math.max(1, Number(days) || 7) * 86400e3;
    return this._events()
      .filter(e => {
        const t = NewsProvider._ts(e);
        return Number.isFinite(t) && t >= from && t <= to && (!cur || NewsProvider._ccy(e) === cur) && (!imp.length || imp.includes(String(e.impact).toLowerCase()));
      })
      .sort((a, b) => NewsProvider._ts(a) - NewsProvider._ts(b))
      .map(e => ({
        id: e.id || null, title: e.name || e.title, time: new Date(NewsProvider._ts(e)).toISOString(), currency: NewsProvider._ccy(e), impact: String(e.impact).toLowerCase(),
        category: e.category || null,
        forecast: e.forecastText !== undefined ? e.forecastText : (e.forecast === undefined || e.forecast === null ? null : String(e.forecast)),
        previous: e.previousText !== undefined ? e.previousText : (e.previous === undefined || e.previous === null ? null : String(e.previous)),
        actual: e.actualText !== undefined ? e.actualText : null
      }));
  }
}
module.exports = { MarketDataProvider, CTraderMarketData, FlowSource, OrderFlowHub, NewsProvider, sanitizeFlow, PushOrderFlowProvider: OrderFlowHub };
