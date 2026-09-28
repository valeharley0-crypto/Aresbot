const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(express.json({ limit: "32kb" }));

const PORT = process.env.PORT || 8080;

const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "CHANGE_ME_WEBHOOK_SECRET";

const EA_TOKEN =
  process.env.EA_TOKEN || "CHANGE_ME_EA_TOKEN";

const TWELVEDATA_API_KEY =
  process.env.TWELVEDATA_API_KEY || "";

let latestSignal = null;
let lastAck = null;

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

function validateSignal(s) {
  const required = [
    "id",
    "symbol",
    "side",
    "orderType",
    "entry",
    "sl",
    "tp1"
  ];

  for (const k of required) {
    if (
      s[k] === undefined ||
      s[k] === null ||
      s[k] === ""
    ) {
      return `missing_${k}`;
    }
  }

  if (!["BUY", "SELL"].includes(String(s.side).toUpperCase())) {
    return "bad_side";
  }

  if (
    !["LIMIT", "MARKET"].includes(
      String(s.orderType).toUpperCase()
    )
  ) {
    return "bad_orderType";
  }

  for (const k of ["entry", "sl", "tp1"]) {
    if (!Number.isFinite(Number(s[k]))) {
      return `bad_${k}`;
    }
  }

  return null;
}


/* =========================
   HOME
========================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});


/* =========================
   HEALTH
========================= */

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ares-trade-bridge",
    signal: latestSignal ? latestSignal.id : null,
    lastAck
  });
});


/* =========================
   TWELVEDATA PROXY
========================= */

app.get("/api/td/:endpoint", async (req, res) => {
  try {
    if (!TWELVEDATA_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: "TWELVEDATA_API_KEY is missing"
      });
    }

    const endpoint = String(req.params.endpoint || "").trim();

    const allowedEndpoints = [
      "time_series",
      "quote",
      "price",
      "exchange_rate"
    ];

    if (!allowedEndpoints.includes(endpoint)) {
      return res.status(400).json({
        ok: false,
        error: "unsupported_endpoint"
      });
    }

    const params = new URLSearchParams();

    /*
      XAU/USD is fixed server-side.
      The frontend cannot replace the symbol.
    */
    params.set("symbol", "XAU/USD");

    /*
      Forward only safe parameters.
    */
    const allowedParams = [
      "interval",
      "outputsize",
      "timezone",
      "start_date",
      "end_date",
      "format",
      "dp"
    ];

    for (const key of allowedParams) {
      if (
        req.query[key] !== undefined &&
        req.query[key] !== ""
      ) {
        params.set(key, String(req.query[key]));
      }
    }

    params.set("apikey", TWELVEDATA_API_KEY);

    const url =
      `https://api.twelvedata.com/${endpoint}?${params.toString()}`;

    const response = await fetch(url);

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error: data?.message || "TwelveData request failed",
        data
      });
    }

    if (
      data &&
      (
        data.status === "error" ||
        data.code
      )
    ) {
      return res.status(400).json({
        ok: false,
        error:
          data.message ||
          "TwelveData API error",
        data
      });
    }

    return res.json({
      ok: true,
      data,
      usage: data?.usage || null,
      stale: false
    });

  } catch (error) {
    console.error("TwelveData proxy error:", error);

    return res.status(500).json({
      ok: false,
      error: "TwelveData connection failed"
    });
  }
});


/* =========================
   WEBHOOK
========================= */

app.post("/api/v1/webhook", (req, res) => {
  const secret = req.get("x-webhook-secret");

  if (!safeEqual(secret, WEBHOOK_SECRET)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized"
    });
  }

  const s = req.body || {};

  const err = validateSignal(s);

  if (err) {
    return res.status(400).json({
      ok: false,
      error: err
    });
  }

  const normalized = {
    id: String(s.id),
    symbol: String(s.symbol),
    side: String(s.side).toUpperCase(),
    orderType: String(s.orderType).toUpperCase(),
    entry: Number(s.entry),
    sl: Number(s.sl),
    tp1: Number(s.tp1),
    tp2: s.tp2 == null ? null : Number(s.tp2),
    tp3: s.tp3 == null ? null : Number(s.tp3),
    volume: s.volume == null ? null : Number(s.volume),
    riskPercent:
      s.riskPercent == null
        ? null
        : Number(s.riskPercent),
    score:
      s.score == null
        ? null
        : Number(s.score),
    tf:
      s.tf == null
        ? null
        : String(s.tf),
    magic:
      s.magic == null
        ? 260926
        : Number(s.magic),
    createdAt:
      s.createdAt ||
      new Date().toISOString(),
    status: "NEW"
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

  return res.json({
    ok: true,
    accepted: true,
    id: normalized.id
  });
});


/* =========================
   EA SIGNAL
========================= */

app.get("/api/v1/signal", (req, res) => {
  const token = req.get("x-ea-token");

  if (!safeEqual(token, EA_TOKEN)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized"
    });
  }

  res.json({
    ok: true,
    signal: latestSignal
  });
});


/* =========================
   EA ACK
========================= */

app.post("/api/v1/ack", (req, res) => {
  const token = req.get("x-ea-token");

  if (!safeEqual(token, EA_TOKEN)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized"
    });
  }

  const {
    id,
    status,
    message
  } = req.body || {};

  lastAck = {
    id: String(id || ""),
    status: String(status || ""),
    message: String(message || ""),
    at: new Date().toISOString()
  };

  if (
    latestSignal &&
    latestSignal.id === lastAck.id
  ) {
    latestSignal.status =
      lastAck.status;
  }

  res.json({
    ok: true
  });
});


/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `Ares trade bridge listening on :${PORT}`
  );
});
