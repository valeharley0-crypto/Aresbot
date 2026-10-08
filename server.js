'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
res.set('X-Content-Type-Options', 'nosniff');
res.set('Referrer-Policy', 'no-referrer');
res.set('X-Frame-Options', 'SAMEORIGIN');
next();
});

app.use(express.json({ limit: '32kb' }));

const PORT = Number(process.env.PORT || 8080);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || '';

/* =========================================================
IA MENTOR
========================================================= */

let mentor = null;

try {
const createMentor = require('./index.js');
mentor = createMentor(express);

if (mentor && mentor.router) {
app.use(mentor.router);
}

if (mentor && typeof mentor.start === 'function') {
mentor.start();
}

console.log('[mentor] IA Mentor chargé');
} catch (error) {
console.error(
'[mentor] IA Mentor non chargé:',
error && error.message
);
}

/* =========================================================
NEWS FEED
========================================================= */

try {
const ff = require('./ff-feed');
const { NewsProvider } = require('./providers/providers');

const newsProvider = new NewsProvider(ff);

if (ff && typeof ff.start === 'function') {
ff.start().catch
? ff.start().catch(err =>
console.error('[news] démarrage:', err && err.message)
)
: null;
}

const feedNews = () => {
try {
if (!mentor || !mentor.manager) return;

  if (ff && typeof ff.status === 'function') {
    const status = ff.status();

    if (status && status.ok && status.fetchedAt) {
      mentor.manager.heartbeatNews(status.fetchedAt);
    }
  }

  if (
    newsProvider &&
    typeof newsProvider.upcoming === 'function'
  ) {
    const events = newsProvider.upcoming(Date.now());

    if (Array.isArray(events) && events.length) {
      mentor.manager.broadcastNews(events);
    }
  }
} catch (error) {
  console.error(
    '[mentor] flux news:',
    error && error.message
  );
}

};

setTimeout(feedNews, 5000);

const feedTimer = setInterval(feedNews, 30000);

if (feedTimer.unref) {
feedTimer.unref();
}

console.log('[news] feed chargé');
} catch (error) {
console.warn(
'[news] feed indisponible:',
error && error.message
);
}

/* =========================================================
MÉMOIRE
========================================================= */

let latestSignal = null;

/* =========================================================
SÉCURITÉ
========================================================= */

function safeEqual(a, b) {
const aa = Buffer.from(String(a || ''));
const bb = Buffer.from(String(b || ''));

return (
aa.length === bb.length &&
crypto.timingSafeEqual(aa, bb)
);
}

/* =========================================================
VALIDATION SIGNAL
========================================================= */

function validateSignal(signal) {
const required = [
'id',
'symbol',
'side',
'orderType',
'entry',
'sl',
'tp1'
];

for (const key of required) {
if (
signal[key] === undefined ||
signal[key] === null ||
signal[key] === ''
) {
return "missing_${key}";
}
}

if (!['BUY', 'SELL'].includes(
String(signal.side).toUpperCase()
)) {
return 'bad_side';
}

if (!['LIMIT', 'MARKET'].includes(
String(signal.orderType).toUpperCase()
)) {
return 'bad_orderType';
}

for (const key of ['entry', 'sl', 'tp1']) {
if (!Number.isFinite(Number(signal[key]))) {
return "bad_${key}";
}
}

return null;
}

/* =========================================================
TWELVE DATA
========================================================= */

const TD_CACHE = new Map();
const TD_INFLIGHT = new Map();

const TD_WINDOW = {
started: Date.now(),
used: 0
};

const TD_SAFE_LIMIT = 6;

const TD_TTL_MS = {
quote: 30000,
price: 30000,
time_series: 300000,
exchange_rate: 300000
};

const TD_ALLOWED = new Set([
'time_series',
'quote',
'price',
'exchange_rate'
]);

function tdWindowReset() {
const now = Date.now();

if (now - TD_WINDOW.started >= 60000) {
TD_WINDOW.started = now;
TD_WINDOW.used = 0;
}
}

function tdWaitMs() {
tdWindowReset();

const elapsed = Date.now() - TD_WINDOW.started;
const remaining = 60000 - elapsed;

return Math.max(1000, remaining + 1000);
}

function sleep(ms) {
return new Promise(resolve => setTimeout(resolve, ms));
}

function isHistoricalRequest(params) {
if (params.start_date || params.end_date) {
return true;
}

if (
params.outputsize &&
Number(params.outputsize) > 100
) {
return true;
}

return false;
}

function tdKey(endpoint, params) {
const sorted = Object.entries(params)
.sort(([a], [b]) => a.localeCompare(b));

return (
endpoint +
'?' +
sorted
.map(([key, value]) => "${key}=${String(value)}")
.join('&')
);
}

function cleanupCache() {
const now = Date.now();

for (const [key, item] of TD_CACHE.entries()) {
const ttl = TD_TTL_MS[item.endpoint] || 60000;

if (now - item.at > ttl) {
  TD_CACHE.delete(key);
}

}

if (TD_CACHE.size > 300) {
const entries = [...TD_CACHE.entries()]
.sort((a, b) => a[1].at - b[1].at);

const removeCount = TD_CACHE.size - 300;

for (let i = 0; i < removeCount; i++) {
  TD_CACHE.delete(entries[i][0]);
}

}
}

async function fetchTwelveData(endpoint, params) {
if (!TWELVEDATA_API_KEY) {
const error = new Error(
'TWELVEDATA_API_KEY manquante'
);

error.code = 'TD_NO_API_KEY';
throw error;

}

const key = tdKey(endpoint, params);
const ttl = TD_TTL_MS[endpoint] || 60000;
const historical = isHistoricalRequest(params);

const cached = TD_CACHE.get(key);

if (
cached &&
Date.now() - cached.at < ttl
) {
return {
data: cached.data,
usage: {
used: TD_WINDOW.used,
limit: TD_SAFE_LIMIT,
cached: true,
historical
},
stale: false
};
}

if (TD_INFLIGHT.has(key)) {
return TD_INFLIGHT.get(key);
}

const promise = (async () => {
while (true) {
tdWindowReset();

  if (TD_WINDOW.used < TD_SAFE_LIMIT) {
    break;
  }

  if (cached && !historical) {
    return {
      data: cached.data,
      usage: {
        used: TD_WINDOW.used,
        limit: TD_SAFE_LIMIT,
        cached: true,
        historical: false
      },
      stale: true
    };
  }

  const wait = tdWaitMs();

  console.log(
    `[TwelveData] quota atteint, attente ${Math.ceil(
      wait / 1000
    )}s`
  );

  await sleep(wait);
}

TD_WINDOW.used++;

const query = new URLSearchParams({
  ...params,
  apikey: TWELVEDATA_API_KEY
});

const url =
  `https://api.twelvedata.com/${endpoint}?${query.toString()}`;

let response;

try {
  response = await fetch(url);
} catch (error) {
  const networkError = new Error(
    'Échec de la connexion réseau TwelveData'
  );

  networkError.code = 'TD_NETWORK_ERROR';
  throw networkError;
}

let data;

try {
  data = await response.json();
} catch (error) {
  const jsonError = new Error(
    'Réponse TwelveData invalide'
  );

  jsonError.code = 'TD_BAD_RESPONSE';
  throw jsonError;
}

const message = String(
  data && data.message || ''
).toLowerCase();

const rateLimited =
  response.status === 429 ||
  message.includes('credit') ||
  message.includes('limit');

if (rateLimited) {
  TD_WINDOW.started = Date.now();
  TD_WINDOW.used = TD_SAFE_LIMIT;

  if (cached && !historical) {
    return {
      data: cached.data,
      usage: {
        used: TD_WINDOW.used,
        limit: TD_SAFE_LIMIT,
        cached: true,
        historical: false
      },
      stale: true
    };
  }

  const wait = tdWaitMs();

  console.log(
    `[TwelveData] limite atteinte, attente ${Math.ceil(
      wait / 1000
    )}s`
  );

  await sleep(wait);

  return fetchTwelveData(endpoint, params);
}

if (
  !response.ok ||
  (
    data &&
    (
      data.status === 'error' ||
      data.code
    )
  )
) {
  const error = new Error(
    data && data.message ||
    'Échec de la requête TwelveData'
  );

  error.code = 'TD_UPSTREAM_ERROR';
  error.status = response.status || 400;
  error.data = data;

  throw error;
}

TD_CACHE.set(key, {
  at: Date.now(),
  endpoint,
  data
});

cleanupCache();

return {
  data,
  usage: {
    used: TD_WINDOW.used,
    limit: TD_SAFE_LIMIT,
    cached: false,
    historical
  },
  stale: false
};

})();

TD_INFLIGHT.set(key, promise);

try {
return await promise;
} finally {
TD_INFLIGHT.delete(key);
}
}

/* =========================================================
HOME
========================================================= */

app.get('/', (req, res) => {
res.sendFile(
path.join(__dirname, 'index.html')
);
});

/* =========================================================
NEWS MODULE FRONTEND
========================================================= */

app.get('/news-module.js', (req, res) => {
res.type('application/javascript');

res.sendFile(
path.join(__dirname, 'news-module.js')
);
});

/* =========================================================
HEALTH
========================================================= */

app.get('/health', (req, res) => {
tdWindowReset();

res.json({
ok: true,
service: 'ares-ia-mentor',
mentor: mentor ? 'loaded' : 'not_loaded',
signal: latestSignal
? latestSignal.id
: null,
twelvedata: {
used: TD_WINDOW.used,
safeLimit: TD_SAFE_LIMIT,
cacheEntries: TD_CACHE.size,
inflight: TD_INFLIGHT.size,
windowStarted:
new Date(
TD_WINDOW.started
).toISOString()
}
});
});

/* =========================================================
TWELVE DATA PROXY
========================================================= */

app.get('/api/td/:endpoint', async (req, res) => {
try {
const endpoint =
String(req.params.endpoint || '').trim();

if (!TD_ALLOWED.has(endpoint)) {
  return res.status(400).json({
    ok: false,
    error: 'unsupported_endpoint'
  });
}

const params = {
  symbol: 'XAU/USD'
};

const allowedParams = [
  'interval',
  'outputsize',
  'timezone',
  'start_date',
  'end_date',
  'format',
  'dp',
  'order'
];

for (const key of allowedParams) {
  if (
    req.query[key] !== undefined &&
    req.query[key] !== ''
  ) {
    params[key] = String(req.query[key]);
  }
}

const result =
  await fetchTwelveData(
    endpoint,
    params
  );

return res.json({
  ok: true,
  data: result.data,
  usage: result.usage,
  stale: result.stale
});

} catch (error) {
console.error(
'[TwelveData proxy]',
error
);

return res.status(
  error.status || 500
).json({
  ok: false,
  error:
    error.code ||
    'TWELVEDATA_ERROR',
  message:
    error.message ||
    'Échec de la connexion à TwelveData'
});

}
});

/* =========================================================
WEBHOOK
========================================================= */

app.post('/api/v1/webhook', (req, res) => {
if (!WEBHOOK_SECRET) {
return res.status(503).json({
ok: false,
error: 'webhook_disabled'
});
}

const secret =
req.get('x-webhook-secret');

if (!safeEqual(secret, WEBHOOK_SECRET)) {
return res.status(401).json({
ok: false,
error: 'unauthorized'
});
}

const signal = req.body || {};

const validationError =
validateSignal(signal);

if (validationError) {
return res.status(400).json({
ok: false,
error: validationError
});
}

const normalized = {
id: String(signal.id),
symbol: String(signal.symbol),
side: String(signal.side).toUpperCase(),
orderType:
String(signal.orderType).toUpperCase(),
entry: Number(signal.entry),
sl: Number(signal.sl),
tp1: Number(signal.tp1),
tp2:
signal.tp2 == null
? null
: Number(signal.tp2),
tp3:
signal.tp3 == null
? null
: Number(signal.tp3),
volume:
signal.volume == null
? null
: Number(signal.volume),
riskPercent:
signal.riskPercent == null
? null
: Number(signal.riskPercent),
score:
signal.score == null
? null
: Number(signal.score),
tf:
signal.tf == null
? null
: String(signal.tf),
magic:
signal.magic == null
? 260926
: Number(signal.magic),
createdAt:
signal.createdAt ||
new Date().toISOString(),
status: 'NEW'
};

if (
latestSignal &&
latestSignal.id === normalized.id
) {
return res.json({
ok: true,
duplicate: true,
id: normalized.id
});
}

latestSignal = normalized;

if (mentor && mentor.engine) {
mentor.engine
.submitSignal(
{
symbol: normalized.symbol,
action: normalized.side,
entry: normalized.entry,
sl: normalized.sl,
tp1: normalized.tp1,
tp2: normalized.tp2,
tp3: normalized.tp3,
reason:
"webhook ${normalized.id}"
},
'NORMAL'
)
.then(result => {
if (
result &&
!result.ok
) {
console.log(
'WEBHOOK_BLOCKED:',
normalized.id,
result.reason
);
}
})
.catch(error => {
console.error(
'Erreur de signal:',
error && error.message
);
});
}

return res.json({
ok: true,
accepted: true,
id: normalized.id
});
});

/* =========================================================
SERVER
========================================================= */

app.listen(PORT, () => {
console.log(
"Serveur ARES à l'écoute sur :${PORT}"
);
});
