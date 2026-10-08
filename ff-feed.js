'use strict';

/**
 * ff-feed.js
 * ARES AI — News Feed
 *
 * Compatible avec server.js
 * - Pas de dépendance externe obligatoire
 * - Fournit un feed NEWS stable
 * - Peut être utilisé même si aucune source externe n'est disponible
 * - N'invente aucune donnée de marché
 */

const https = require('https');

const DEFAULT_OPTIONS = {
  enabled: true,
  refreshMs: 5 * 60 * 1000,
  timeoutMs: 10000,
  maxItems: 50
};

let options = { ...DEFAULT_OPTIONS };
let cache = [];
let lastUpdate = null;
let timer = null;

/**
 * Fetch JSON via HTTPS
 */
function fetchJson(url, timeoutMs = options.timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ARES-AI-News/1.0',
          'Accept': 'application/json'
        }
      },
      res => {
        let data = '';

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(
              new Error(`HTTP ${res.statusCode}`)
            );
          }

          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error('Invalid JSON response'));
          }
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Request timeout'));
    });

    req.on('error', reject);
  });
}

/**
 * Normalize a news item
 */
function normalize(item, source = 'unknown') {
  if (!item || typeof item !== 'object') return null;

  const title =
    item.title ||
    item.headline ||
    item.name ||
    '';

  if (!title) return null;

  const published =
    item.published_at ||
    item.publishedAt ||
    item.datetime ||
    item.date ||
    null;

  return {
    id:
      item.id ||
      `${source}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    title: String(title),

    description:
      item.description ||
      item.summary ||
      '',

    source:
      item.source ||
      item.publisher ||
      source,

    url:
      item.url ||
      item.link ||
      null,

    publishedAt: published,

    category:
      item.category ||
      item.type ||
      'NEWS',

    impact:
      item.impact ||
      item.importance ||
      'UNKNOWN',

    symbol:
      item.symbol ||
      'XAUUSD'
  };
}

/**
 * Load news from optional configured URL.
 *
 * Environment variable:
 * NEWS_FEED_URL
 *
 * The endpoint must return either:
 *   { data: [...] }
 *   { news: [...] }
 *   [...]
 */
async function loadExternalFeed() {
  const url = process.env.NEWS_FEED_URL;

  if (!url) {
    return [];
  }

  try {
    const json = await fetchJson(url);

    let items = [];

    if (Array.isArray(json)) {
      items = json;
    } else if (Array.isArray(json.data)) {
      items = json.data;
    } else if (Array.isArray(json.news)) {
      items = json.news;
    } else if (Array.isArray(json.results)) {
      items = json.results;
    }

    return items
      .map(item => normalize(item, 'external'))
      .filter(Boolean);

  } catch (err) {
    console.warn(
      '[news] feed externe indisponible:',
      err.message
    );

    return [];
  }
}

/**
 * Refresh cache
 */
async function refresh() {
  if (!options.enabled) {
    return cache;
  }

  const external = await loadExternalFeed();

  if (external.length > 0) {
    cache = external
      .sort((a, b) => {
        const da = a.publishedAt
          ? new Date(a.publishedAt).getTime()
          : 0;

        const db = b.publishedAt
          ? new Date(b.publishedAt).getTime()
          : 0;

        return db - da;
      })
      .slice(0, options.maxItems);

    lastUpdate = new Date().toISOString();
  }

  return cache;
}

/**
 * Start automatic refresh
 */
function start(customOptions = {}) {
  stop();

  options = {
    ...DEFAULT_OPTIONS,
    ...customOptions
  };

  refresh().catch(err => {
    console.warn(
      '[news] refresh error:',
      err.message
    );
  });

  timer = setInterval(() => {
    refresh().catch(err => {
      console.warn(
        '[news] refresh error:',
        err.message
      );
    });
  }, options.refreshMs);

  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }

  return status();
}

/**
 * Stop feed
 */
function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Return current news
 */
function getNews(limit = options.maxItems) {
  return cache.slice(0, Math.max(1, Number(limit) || 20));
}

/**
 * Return status
 */
function status() {
  return {
    ok: true,
    enabled: options.enabled,
    items: cache.length,
    lastUpdate,
    source: process.env.NEWS_FEED_URL
      ? 'external'
      : 'none',
    symbol: 'XAUUSD'
  };
}

/**
 * Compatibility helpers
 */
function get(limit) {
  return getNews(limit);
}

async function update() {
  return refresh();
}

/**
 * Export compatible with server.js
 */
module.exports = {
  start,
  stop,
  refresh,
  update,
  get,
  getNews,
  getEvents: getNews,
  status
};
