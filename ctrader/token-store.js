'use strict';

/**
 * ARES — Persistent & encrypted cTrader token store
 *
 * - Tokens never exposed to frontend
 * - AES-256-GCM encryption
 * - Persistent storage when /data is available
 * - In-memory fallback for local development
 * - Compatible API:
 *   save / set / load / get / remove / clear
 *   has / available / keyConfigured / count
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USER_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/*
 * Render Persistent Disk:
 *
 * Mount Path recommended:
 *   /data
 *
 * File:
 *   /data/ares-ctrader-tokens.json
 *
 * If /data does not exist, the module uses:
 *   ./data/ares-ctrader-tokens.json
 *
 * This fallback is useful locally, but on Render it is persistent
 * only if the directory is backed by a persistent disk.
 */
const DATA_DIR =
  process.env.CTRADER_TOKEN_DIR ||
  (
    fs.existsSync('/data')
      ? '/data'
      : path.join(__dirname, '..', 'data')
  );

const STORE_FILE =
  process.env.CTRADER_TOKEN_FILE ||
  path.join(
    DATA_DIR,
    'ares-ctrader-tokens.json'
  );

let STORE = new Map();

let loaded = false;

/* ------------------------------------------------------------------ */
/* Encryption                                                          */
/* ------------------------------------------------------------------ */

function getEncryptionKey() {
  const raw =
    process.env.TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY manquante'
    );
  }

  if (
    /^[0-9a-fA-F]{64}$/.test(
      String(raw)
    )
  ) {
    return Buffer.from(
      String(raw),
      'hex'
    );
  }

  return crypto
    .createHash('sha256')
    .update(
      String(raw),
      'utf8'
    )
    .digest();
}

function encrypt(value) {
  const key =
    getEncryptionKey();

  const iv =
    crypto.randomBytes(12);

  const cipher =
    crypto.createCipheriv(
      'aes-256-gcm',
      key,
      iv
    );

  const plaintext =
    Buffer.from(
      JSON.stringify(value),
      'utf8'
    );

  const encrypted =
    Buffer.concat([
      cipher.update(
        plaintext
      ),
      cipher.final()
    ]);

  const tag =
    cipher.getAuthTag();

  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decrypt(blob) {
  if (
    !blob ||
    blob.v !== 1 ||
    blob.alg !== 'aes-256-gcm'
  ) {
    throw new Error(
      'token chiffré invalide'
    );
  }

  const key =
    getEncryptionKey();

  const iv =
    Buffer.from(
      blob.iv,
      'base64'
    );

  const tag =
    Buffer.from(
      blob.tag,
      'base64'
    );

  const encrypted =
    Buffer.from(
      blob.data,
      'base64'
    );

  const decipher =
    crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      iv
    );

  decipher.setAuthTag(tag);

  const plaintext =
    Buffer.concat([
      decipher.update(
        encrypted
      ),
      decipher.final()
    ]);

  return JSON.parse(
    plaintext.toString('utf8')
  );
}

/* ------------------------------------------------------------------ */
/* File persistence                                                    */
/* ------------------------------------------------------------------ */

function ensureDirectory() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(
      DATA_DIR,
      {
        recursive: true
      }
    );
  }
}

function loadStore() {
  if (loaded) {
    return;
  }

  loaded = true;

  try {
    ensureDirectory();

    if (
      !fs.existsSync(
        STORE_FILE
      )
    ) {
      STORE = new Map();
      return;
    }

    const raw =
      fs.readFileSync(
        STORE_FILE,
        'utf8'
      );

    if (!raw.trim()) {
      STORE = new Map();
      return;
    }

    const parsed =
      JSON.parse(raw);

    if (
      !parsed ||
      typeof parsed !== 'object'
    ) {
      STORE = new Map();
      return;
    }

    STORE = new Map(
      Object.entries(parsed)
    );
  } catch (error) {
    console.error(
      '[ctrader-token-store] chargement impossible:',
      error.message
    );

    STORE = new Map();
  }
}

function persistStore() {
  ensureDirectory();

  const object =
    Object.fromEntries(
      STORE.entries()
    );

  const tmp =
    `${STORE_FILE}.tmp`;

  fs.writeFileSync(
    tmp,
    JSON.stringify(
      object,
      null,
      2
    ),
    {
      encoding: 'utf8',
      mode: 0o600
    }
  );

  fs.renameSync(
    tmp,
    STORE_FILE
  );
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function assertUser(userId) {
  if (
    !USER_RE.test(
      String(userId || '')
    )
  ) {
    throw new Error(
      'userId invalide'
    );
  }
}

/* ------------------------------------------------------------------ */
/* Token sanitization                                                  */
/* ------------------------------------------------------------------ */

function sanitizeTokenData(data) {
  const src =
    data || {};

  return {
    accessToken:
      src.accessToken
        ? String(
            src.accessToken
          )
        : null,

    refreshToken:
      src.refreshToken
        ? String(
            src.refreshToken
          )
        : null,

    expiresAt:
      src.expiresAt != null
        ? Number(
            src.expiresAt
          )
        : null,

    accountId:
      src.accountId != null
        ? String(
            src.accountId
          )
        : null,

    isLive:
      Boolean(
        src.isLive
      ),

    updatedAt:
      Date.now()
  };
}

/* ------------------------------------------------------------------ */
/* Save                                                                 */
/* ------------------------------------------------------------------ */

function save(userId, data) {
  assertUser(userId);

  loadStore();

  const clean =
    sanitizeTokenData(
      data
    );

  /*
   * Important:
   * Si un refresh token n'est pas renvoyé lors d'un refresh,
   * on conserve l'ancien refresh token.
   */
  const previous =
    STORE.get(
      String(userId)
    );

  let previousData = null;

  if (previous) {
    try {
      previousData =
        decrypt(previous);
    } catch (_) {
      previousData = null;
    }
  }

  if (
    !clean.refreshToken &&
    previousData &&
    previousData.refreshToken
  ) {
    clean.refreshToken =
      previousData.refreshToken;
  }

  if (
    !clean.accessToken &&
    previousData &&
    previousData.accessToken
  ) {
    clean.accessToken =
      previousData.accessToken;
  }

  if (
    clean.accountId === null &&
    previousData &&
    previousData.accountId !== null
  ) {
    clean.accountId =
      previousData.accountId;
  }

  const encrypted =
    encrypt(clean);

  STORE.set(
    String(userId),
    encrypted
  );

  persistStore();

  return true;
}

function set(userId, data) {
  return save(
    userId,
    data
  );
}

/* ------------------------------------------------------------------ */
/* Load                                                                */
/* ------------------------------------------------------------------ */

function load(userId) {
  assertUser(userId);

  loadStore();

  const blob =
    STORE.get(
      String(userId)
    );

  if (!blob) {
    return null;
  }

  try {
    return decrypt(blob);
  } catch (error) {
    console.error(
      '[ctrader-token-store] déchiffrement impossible:',
      error.message
    );

    /*
     * Ne supprime pas automatiquement le token persistant.
     * Une erreur de clé pourrait sinon détruire les données.
     */
    throw new Error(
      'impossible de déchiffrer les tokens cTrader'
    );
  }
}

function get(userId) {
  return load(
    userId
  );
}

/* ------------------------------------------------------------------ */
/* Remove                                                               */
/* ------------------------------------------------------------------ */

function remove(userId) {
  assertUser(userId);

  loadStore();

  const result =
    STORE.delete(
      String(userId)
    );

  if (result) {
    persistStore();
  }

  return result;
}

function clear(userId) {
  return remove(
    userId
  );
}

/* ------------------------------------------------------------------ */
/* Status                                                               */
/* ------------------------------------------------------------------ */

function has(userId) {
  assertUser(userId);

  loadStore();

  return STORE.has(
    String(userId)
  );
}

function available(userId) {
  if (userId == null) {
    loadStore();

    return STORE.size > 0;
  }

  const token =
    load(userId);

  return Boolean(
    token &&
    (
      token.accessToken ||
      token.refreshToken
    )
  );
}

function keyConfigured() {
  const raw =
    process.env.TOKEN_ENCRYPTION_KEY;

  return Boolean(
    raw &&
    String(raw).length >= 16
  );
}

function count() {
  loadStore();

  return STORE.size;
}

function storageInfo() {
  loadStore();

  return {
    file: STORE_FILE,
    directory: DATA_DIR,
    persistent:
      DATA_DIR === '/data' ||
      Boolean(
        process.env.CTRADER_TOKEN_DIR
      ),
    users:
      STORE.size,
    keyConfigured:
      keyConfigured()
  };
}

/* ------------------------------------------------------------------ */
/* Exports                                                             */
/* ------------------------------------------------------------------ */

module.exports = {
  USER_RE,

  save,
  set,

  load,
  get,

  remove,
  clear,

  has,
  available,

  keyConfigured,
  count,

  storageInfo
};
