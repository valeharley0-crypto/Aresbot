'use strict';
/**
 * cTrader Open API — autorisation OAuth 2.0 officielle (le mot de passe cTrader n'est JAMAIS demandé ni vu par ARES).
 *  1) l'utilisateur est redirigé vers https://id.ctrader.com/my/settings/openapi/grantingaccess/ et s'authentifie chez Spotware
 *  2) Spotware renvoie ?code=... (valable ~1 min) sur CTRADER_REDIRECT_URI
 *  3) le serveur échange le code contre accessToken + refreshToken : GET https://openapi.ctrader.com/apps/token
 *  Le client secret n'existe que dans l'environnement du serveur.
 */
const crypto = require('crypto');

const AUTH_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

function createOAuth({ clientId = process.env.CTRADER_CLIENT_ID, clientSecret = process.env.CTRADER_CLIENT_SECRET, redirectUri = process.env.CTRADER_REDIRECT_URI, fetchFn = typeof fetch === 'function' ? fetch : null, now = () => Date.now() } = {}) {
  const pending = new Map();   // state -> { userId, exp }
  const configured = () => !!(clientId && clientSecret && redirectUri);
  const redact = s => String(s || '').replace(clientSecret ? new RegExp(clientSecret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '***').slice(0, 300);

  function newState(userId) {
    for (const [k, v] of pending) if (v.exp < now()) pending.delete(k);
    const state = crypto.randomBytes(24).toString('hex');
    pending.set(state, { userId, exp: now() + 10 * 60000 });
    return state;
  }
  /** scope : 'trading' (ordres) ou 'accounts' (lecture seule) */
  function buildAuthUrl(userId, scope = 'trading') {
    if (!configured()) throw new Error('cTrader non configuré (CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET / CTRADER_REDIRECT_URI)');
    const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: scope === 'accounts' ? 'accounts' : 'trading', product: 'web', state: newState(userId) });
    return AUTH_URL + '?' + q.toString();
  }
  /** Retourne le userId lié à ce state (usage unique) ou null. */
  function consumeState(state) {
    const v = pending.get(String(state || ''));
    if (!v) return null;
    pending.delete(String(state));
    return v.exp >= now() ? v.userId : null;
  }
  async function call(params) {
    if (!configured()) throw new Error('cTrader non configuré');
    if (!fetchFn) throw new Error('fetch indisponible (Node ≥ 18 requis)');
    const q = new URLSearchParams(Object.assign({ client_id: clientId, client_secret: clientSecret }, params));
    let res, j;
    try {
      res = await fetchFn(TOKEN_URL + '?' + q.toString(), { method: 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } });
      j = await res.json();
    } catch (e) { throw new Error('échange de token impossible : ' + redact(e && e.message)); }
    if (!j || j.errorCode || !j.accessToken) throw new Error('cTrader a refusé l\'autorisation : ' + redact((j && (j.description || j.errorCode)) || ('HTTP ' + (res && res.status))));
    return { accessToken: j.accessToken, refreshToken: j.refreshToken, tokenType: j.tokenType, expiresAt: now() + (Number(j.expiresIn) > 0 ? Number(j.expiresIn) : 2628000) * 1000 };
  }
  return {
    configured, buildAuthUrl, consumeState,
    exchangeCode: code => call({ grant_type: 'authorization_code', code: String(code), redirect_uri: redirectUri }),
    refresh: refreshToken => call({ grant_type: 'refresh_token', refresh_token: String(refreshToken) }),
    redact
  };
}
module.exports = { createOAuth, AUTH_URL, TOKEN_URL };
