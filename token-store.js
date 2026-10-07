'use strict';
/**
 * Stockage CHIFFRÉ (AES-256-GCM) des tokens cTrader, par utilisateur, côté serveur uniquement.
 * Clé : variable d'environnement TOKEN_ENCRYPTION_KEY (aucune valeur par défaut). Sans clé : refus de stocker (jamais en clair).
 * Le frontend ne reçoit JAMAIS un token : seulement des statuts.
 * (Dingana 2 : même interface, stockage en base de données.)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;

function createTokenStore({ dir, secret = process.env.TOKEN_ENCRYPTION_KEY } = {}) {
  const file = path.join(dir, 'ctrader-tokens.enc.json');
  const key = secret && String(secret).length >= 16 ? crypto.createHash('sha256').update(String(secret)).digest() : null;
  let db = {};
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { db = {}; }
  const persist = () => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const need = () => { if (!key) throw new Error('TOKEN_ENCRYPTION_KEY manquante ou trop courte (≥ 16 caractères) : stockage des tokens refusé'); };
  const okUser = u => { if (!USER_RE.test(String(u))) throw new Error('userId invalide'); return String(u); };
  function enc(obj) {
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  }
  function dec(rec) {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(rec.data, 'base64')), d.final()]).toString('utf8'));
  }
  return {
    available: () => !!key,
    /** tokens = { accessToken, refreshToken, expiresAt(ms), accountId?, isLive? } (fusionné avec l'existant) */
    set(userId, patch) {
      need(); const u = okUser(userId);
      const cur = db[u] ? dec(db[u]) : {};
      db[u] = enc(Object.assign(cur, patch)); persist();
    },
    get(userId) {
      if (!key) return null;
      const u = okUser(userId);
      if (!db[u]) return null;
      try { return dec(db[u]); } catch (e) { return null; }   // clé changée / fichier altéré
    },
    has: userId => !!db[okUser(userId)],
    delete(userId) { const u = okUser(userId); delete db[u]; persist(); },
    users: () => Object.keys(db)
  };
}
module.exports = { createTokenStore, USER_RE };
