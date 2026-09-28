const express = require("express");
const crypto = require("crypto");
const path = require("path");

const app = express();

app.use(express.json({ limit: "32kb" }));

// Serve index.html from the root of the project
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

const PORT = process.env.PORT || 8080;
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "CHANGE_ME_WEBHOOK_SECRET";
const EA_TOKEN =
  process.env.EA_TOKEN || "CHANGE_ME_EA_TOKEN";

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

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ares-trade-bridge",
    signal: latestSignal ? latestSignal.id : null,
    lastAck
  });
});

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
      s.riskPercent == null ? null : Number(s.riskPercent),
    score: s.score == null ? null : Number(s.score),
    tf: s.tf == null ? null : String(s.tf),
    magic: s.magic == null ? 260926 : Number(s.magic),
    createdAt:
      s.createdAt || new Date().toISOString(),
    status: "NEW"
  };

  // Ignore exact duplicate IDs
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

app.post("/api/v1/ack", (req, res) => {
  const token = req.get("x-ea-token");

  if (!safeEqual(token, EA_TOKEN)) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized"
    });
  }

  const { id, status, message } = req.body || {};

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
    latestSignal.status = lastAck.status;
  }

  res.json({
    ok: true
  });
});

app.listen(PORT, () => {
  console.log(
    `Ares trade bridge listening on :${PORT}`
  );
});
