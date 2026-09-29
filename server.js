'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');

const app = express();

app.use(express.json({ limit: '32kb' }));

const PORT = process.env.PORT || 8080;

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || 'CHANGE_ME_WEBHOOK_SECRET';

const EA_TOKEN =
  process.env.EA_TOKEN || 'CHANGE_ME_EA_TOKEN';

const TWELVEDATA_API_KEY =
  process.env.TWELVEDATA_API_KEY || '';

/* =========================================================
   NEWS MODULE
========================================================= */

const news = require('./news-routes')(app);

app.get('/news-module.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(
    path.join(__dirname, 'news-module.js')
  );
});

/*
  NEWS GUARD doit être placé avant le ROBOT.
*/
app.use(
  '/api/robot/execute',
  news.newsGuard
);


/* =========================================================
   ROBOT MODULE
========================================================= */

const robot = require('./robot-module')({
  express,
  dataFile:
    process.env.ROBOT_DATA_FILE ||
    './robot-data.json'
});

app.use(robot.router);


/* =========================================================
   MEMORY
========================================================= */

let latestSignal = null;
let lastAck = null;


/* =========================================================
   SECURITY
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
   SIGNAL VALIDATION
========================================================= */

function validateSignal(s) {
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
      s[key] === undefined ||
      s[key] === null ||
      s[key] === ''
    ) {
      return `missing_${key}`;
    }
  }

  if (
    !['BUY', 'SELL'].includes(
      String(s.side).toUpperCase()
    )
  ) {
    return 'bad_side';
  }

  if (
    !['LIMIT', 'MARKET'].includes(
      String(s.orderType).toUpperCase()
    )
  ) {
    return 'bad_orderType';
  }

  for (const key of [
    'entry',
    'sl',
    'tp1'
  ]) {
    if (!Number.isFinite(Number(s[key]))) {
      return `bad_${key}`;
    }
  }

  return null;
}


/* =========================================================
   TWELVEDATA CACHE + RATE LIMIT
=========================================================

   Plan actuel :
   8 crédits/minute

   Sécurité :
   maximum 6 requêtes upstream/minute.

   Les 2 crédits restants servent de marge de sécurité.

========================================================= */

const TD_CACHE = new Map();
const TD_INFLIGHT = new Map();

const TD_WINDOW = {
  started: Date.now(),
  used: 0
};

const TD_SAFE_LIMIT = 6;

const TD_TTL_MS = {
  quote: 30 * 1000,
  price: 30 * 1000,
  time_series: 5 * 60 * 1000,
  exchange_rate: 5 * 60 * 1000
};

const TD_ALLOWED = new Set([
  'time_series',
  'quote',
  'price',
  'exchange_rate'
]);


/* =========================================================
   RESET RATE WINDOW
========================================================= */

function tdWindowReset() {
  const now = Date.now();

  if (
    now - TD_WINDOW.started >= 60000
  ) {
    TD_WINDOW.started = now;
    TD_WINDOW.used = 0;
  }
}


/* =========================================================
   CACHE KEY
========================================================= */

function tdKey(endpoint, params) {
  const sorted = Object.entries(params)
    .sort(([a], [b]) =>
      a.localeCompare(b)
    );

  return (
    endpoint +
    '?' +
    sorted
      .map(
        ([key, value]) =>
          `${key}=${String(value)}`
      )
      .join('&')
  );
}


/* =========================================================
   TWELVEDATA REQUEST
========================================================= */

async function fetchTwelveData(
  endpoint,
  params
) {
  tdWindowReset();

  const key = tdKey(
    endpoint,
    params
  );

  const ttl =
    TD_TTL_MS[endpoint] ||
    60000;

  const now = Date.now();

  /* ---------- CACHE ---------- */

  const cached =
    TD_CACHE.get(key);

  if (
    cached &&
    now - cached.at < ttl
  ) {
    return {
      data: cached.data,
      usage: {
        used: TD_WINDOW.used,
        cached: true
      },
      stale: false
    };
  }


  /* ---------- SAME REQUEST ALREADY RUNNING ---------- */

  if (
    TD_INFLIGHT.has(key)
  ) {
    return TD_INFLIGHT.get(key);
  }


  /* ---------- RATE LIMIT ---------- */

  if (
    TD_WINDOW.used >=
    TD_SAFE_LIMIT
  ) {
    /*
      Si une ancienne donnée existe,
      on peut la retourner en mode stale.
    */

    if (cached) {
      return {
        data: cached.data,
        usage: {
          used: TD_WINDOW.used,
          cached: true
        },
        stale: true
      };
    }

    const error =
      new Error(
        'TwelveData safe rate limit reached. Please retry after the cache window.'
      );

    error.code =
      'TD_RATE_LIMIT';

    throw error;
  }


  /* ---------- CREATE REQUEST ---------- */

  const promise = (async () => {
    TD_WINDOW.used++;

    const query =
      new URLSearchParams({
        ...params,
        apikey:
          TWELVEDATA_API_KEY
      });

    const url =
      `https://api.twelvedata.com/${endpoint}?${query.toString()}`;

    const response =
      await fetch(url);

    const data =
      await response.json();


    /* ---------- TWELVEDATA ERROR ---------- */

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
      const error =
        new Error(
          data?.message ||
          'TwelveData request failed'
        );

      error.code =
        'TD_UPSTREAM_ERROR';

      error.status =
        response.status || 400;

      error.data = data;

      throw error;
    }


    /* ---------- SAVE CACHE ---------- */

    TD_CACHE.set(
      key,
      {
        at: Date.now(),
        data
      }
    );


    return {
      data,
      usage: {
        used: TD_WINDOW.used,
        cached: false
      },
      stale: false
    };
  })();


  TD_INFLIGHT.set(
    key,
    promise
  );

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
    path.join(
      __dirname,
      'index.html'
    )
  );
});


/* =========================================================
   HEALTH
========================================================= */

app.get('/health', (req, res) => {
  tdWindowReset();

  res.json({
    ok: true,

    service:
      'ares-trade-bridge',

    signal:
      latestSignal
        ? latestSignal.id
        : null,

    lastAck,

    twelvedata: {
      used:
        TD_WINDOW.used,

      safeLimit:
        TD_SAFE_LIMIT,

      cacheEntries:
        TD_CACHE.size,

      windowStarted:
        new Date(
          TD_WINDOW.started
        ).toISOString()
    }
  });
});


/* =========================================================
   TWELVEDATA PROXY
========================================================= */

app.get(
  '/api/td/:endpoint',
  async (req, res) => {
    try {

      if (!TWELVEDATA_API_KEY) {
        return res.status(500).json({
          ok: false,
          error:
            'TWELVEDATA_API_KEY is missing'
        });
      }


      const endpoint =
        String(
          req.params.endpoint || ''
        ).trim();


      if (
        !TD_ALLOWED.has(endpoint)
      ) {
        return res.status(400).json({
          ok: false,
          error:
            'unsupported_endpoint'
        });
      }


      /*
        XAU/USD est imposé côté serveur.
      */

      const params = {
        symbol: 'XAU/USD'
      };


      /*
        Paramètres autorisés uniquement.
      */

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


      for (
        const key of allowedParams
      ) {

        if (
          req.query[key] !== undefined &&
          req.query[key] !== ''
        ) {
          params[key] =
            String(
              req.query[key]
            );
        }
      }


      const result =
        await fetchTwelveData(
          endpoint,
          params
        );


      return res.json({
        ok: true,

        data:
          result.data,

        usage:
          result.usage,

        stale:
          result.stale
      });

    } catch (error) {

      console.error(
        'TwelveData proxy error:',
        error
      );


      if (
        error.code ===
        'TD_RATE_LIMIT'
      ) {
        return res.status(429).json({
          ok: false,

          error:
            'TWELVEDATA_RATE_LIMIT',

          message:
            error.message
        });
      }


      return res.status(
        error.status || 500
      ).json({
        ok: false,

        error:
          error.message ||
          'TwelveData connection failed',

        data:
          error.data ||
          undefined
      });
    }
  }
);


/* =========================================================
   WEBHOOK
========================================================= */

app.post(
  '/api/v1/webhook',
  (req, res) => {

    const secret =
      req.get(
        'x-webhook-secret'
      );


    if (
      !safeEqual(
        secret,
        WEBHOOK_SECRET
      )
    ) {
      return res.status(401).json({
        ok: false,
        error:
          'unauthorized'
      });
    }


    const signal =
      req.body || {};


    const validationError =
      validateSignal(signal);


    if (validationError) {
      return res.status(400).json({
        ok: false,
        error:
          validationError
      });
    }


    const normalized = {

      id:
        String(signal.id),

      symbol:
        String(signal.symbol),

      side:
        String(signal.side)
          .toUpperCase(),

      orderType:
        String(signal.orderType)
          .toUpperCase(),

      entry:
        Number(signal.entry),

      sl:
        Number(signal.sl),

      tp1:
        Number(signal.tp1),

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
          : Number(
              signal.riskPercent
            ),

      score:
        signal.score == null
          ? null
          : Number(
              signal.score
            ),

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

      status:
        'NEW'
    };


    /* ---------- DUPLICATE ---------- */

    if (
      latestSignal &&
      latestSignal.id ===
        normalized.id
    ) {
      return res.json({
        ok: true,
        duplicate: true,
        id:
          normalized.id
      });
    }


    /* ---------- NEWS ---------- */

    const pause =
      news.getPause();


    if (pause.paused) {
      normalized.status =
        'BLOCKED_NEWS';
    }


    latestSignal =
      normalized;


    /* ---------- BLOCK DURING NEWS ---------- */

    if (pause.paused) {

      console.log(
        `TRADE_BLOCKED_NEWS: signal ${normalized.id} non exécuté (${pause.event.name})`
      );


      return res.json({

        ok: true,

        accepted: true,

        id:
          normalized.id,

        robot:
          'TRADE_BLOCKED_NEWS',

        news:
          pause.event.name,

        resumeAt:
          new Date(
            pause.resumeAt
          ).toISOString()
      });
    }


    /* ---------- DISPATCH ROBOT ---------- */

    try {

      robot.dispatchSignal({

        id:
          normalized.id,

        symbol:
          'XAUUSD',

        dir:
          normalized.side,

        entry:
          normalized.entry,

        sl:
          normalized.sl,

        tp1:
          normalized.tp1,

        tp2:
          normalized.tp2,

        tp3:
          normalized.tp3
      });

    } catch (error) {

      console.error(
        'Robot dispatch error:',
        error
      );
    }


    return res.json({

      ok: true,

      accepted: true,

      id:
        normalized.id
    });
  }
);


/* =========================================================
   EA SIGNAL
========================================================= */

app.get(
  '/api/v1/signal',
  (req, res) => {

    const token =
      req.get(
        'x-ea-token'
      );


    if (
      !safeEqual(
        token,
        EA_TOKEN
      )
    ) {
      return res.status(401).json({
        ok: false,
        error:
          'unauthorized'
      });
    }


    /*
      NEWS BLOCK
    */

    const pause =
      news.getPause();


    if (
      pause.paused ||
      (
        latestSignal &&
        latestSignal.status ===
          'BLOCKED_NEWS'
      )
    ) {

      return res.json({

        ok: true,

        signal: null,

        blocked:
          'TRADE_BLOCKED_NEWS'
      });
    }


    return res.json({

      ok: true,

      signal:
        latestSignal
    });
  }
);


/* =========================================================
   EA ACK
========================================================= */

app.post(
  '/api/v1/ack',
  (req, res) => {

    const token =
      req.get(
        'x-ea-token'
      );


    if (
      !safeEqual(
        token,
        EA_TOKEN
      )
    ) {
      return res.status(401).json({
        ok: false,
        error:
          'unauthorized'
      });
    }


    const {
      id,
      status,
      message
    } = req.body || {};


    lastAck = {

      id:
        String(id || ''),

      status:
        String(status || ''),

      message:
        String(message || ''),

      at:
        new Date().toISOString()
    };


    if (
      latestSignal &&
      latestSignal.id ===
        lastAck.id
    ) {

      latestSignal.status =
        lastAck.status;
    }


    return res.json({
      ok: true
    });
  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Ares trade bridge listening on :${PORT}`
    );

  }
);
