'use strict';

/**
 * ARES — Secure cTrader token store
 *
 * Stockage serveur uniquement.
 * Les tokens OAuth ne sont jamais exposés au frontend.
 */

const crypto = require('crypto');

const USER_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const STORE = new Map();

function getEncryptionKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY manquante'
    );
  }

  /*
   * On accepte une clé hexadécimale de 32 octets
   * ou une chaîne quelconque transformée en SHA-256.
   */
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  return crypto
    .createHash('sha256')
    .update(raw, 'utf8')
    .digest();
}

function encrypt(value) {
  const key = getEncryptionKey();

  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  const plaintext = Buffer.from(
    JSON.stringify(value),
    'utf8'
  );

  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);

  const tag = cipher.getAuthTag();

  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decrypt(blob) {
  if (!blob || blob.v !== 1) {
    throw new Error(
      'token chiffré invalide'
    );
  }

  const key = getEncryptionKey();

  const iv = Buffer.from(
    blob.iv,
    'base64'
  );

  const tag = Buffer.from(
    blob.tag,
    'base64'
  );

  const encrypted = Buffer.from(
    blob.data,
    'base64'
  );

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    iv
  );

  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([
    decipher.update(encrypted),
    decipher.final()
  ]);

  return JSON.parse(
    plaintext.toString('utf8')
  );
}

function assertUser(userId) {
  if (!USER_RE.test(String(userId || ''))) {
    throw new Error(
      'userId invalide'
    );
  }
}

function sanitizeTokenData(data) {
  const src = data || {};

  return {
    accessToken:
      src.accessToken
        ? String(src.accessToken)
        : null,

    refreshToken:
      src.refreshToken
        ? String(src.refreshToken)
        : null,

    expiresAt:
      src.expiresAt != null
        ? Number(src.expiresAt)
        : null,

    accountId:
      src.accountId != null
        ? String(src.accountId)
        : null,

    isLive:
      Boolean(src.isLive),

    updatedAt:
      Date.now()
  };
}

function save(userId, data) {
  assertUser(userId);

  const clean =
    sanitizeTokenData(data);

  const encrypted =
    encrypt(clean);

  STORE.set(
    String(userId),
    encrypted
  );

  return true;
}

function set(userId, data) {
  return save(userId, data);
}

function load(userId) {
  assertUser(userId);

  const blob =
    STORE.get(String(userId));

  if (!blob) {
    return null;
  }

  try {
    return decrypt(blob);
  } catch (error) {
    STORE.delete(String(userId));

    throw new Error(
      'impossible de déchiffrer les tokens cTrader'
    );
  }
}

function get(userId) {
  return load(userId);
}

function remove(userId) {
  assertUser(userId);

  return STORE.delete(
    String(userId)
  );
}

function clear(userId) {
  return remove(userId);
}

function has(userId) {
  assertUser(userId);

  return STORE.has(
    String(userId)
  );
}

function available(userId) {
  if (userId == null) {
    return STORE.size > 0;
  }

  const t = load(userId);

  return Boolean(
    t &&
    t.accessToken
  );
}

/** La clé de chiffrement est-elle configurée sur le serveur ? (indépendant de la présence de jetons) */
function keyConfigured() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  return !!raw && String(raw).length >= 16;
}

function count() {
  return STORE.size;
}

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

  count
};
