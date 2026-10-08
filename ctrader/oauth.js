
'use strict';

/**
 * ARES — cTrader OAuth2
 *
 * Gère:
 * - génération de l'URL OAuth
 * - échange code -> tokens
 * - refresh token
 * - redaction des secrets dans les logs
 */

const crypto = require('crypto');

const AUTH_URL = 'https://id.ctrader.com/my/settings/openapi/grantingaccess/';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

class CTraderOAuth {
  constructor({
    clientId = process.env.CTRADER_CLIENT_ID,
    clientSecret = process.env.CTRADER_CLIENT_SECRET,
    redirectUri = process.env.CTRADER_REDIRECT_URI
  } = {}) {
    const t = v => (v == null ? v : String(v).replace(/\s+#.*$/, '').replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ''));
    // Client ID / Secret : uniquement lettres, chiffres, _ - . ~ (retire les caractères invisibles collés par erreur)
    const strict = v => (v == null ? v : String(v).replace(/[^A-Za-z0-9_\-.~]/g, ''));
    const idT = t(clientId), secT = t(clientSecret);
    this.clientId = strict(idT);
    this.clientSecret = strict(secT);
    this.strippedChars = (idT ? idT.length - this.clientId.length : 0) + (secT ? secT.length - this.clientSecret.length : 0);
    this.redirectUri = t(redirectUri);
  }

  configured() {
    return Boolean(
      this.clientId &&
      this.clientSecret &&
      this.redirectUri
    );
  }

  _requireConfig() {
    if (!this.configured()) {
      throw new Error(
        'CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET / CTRADER_REDIRECT_URI manquants'
      );
    }
  }

  buildAuthUrl(state) {
    this._requireConfig();

    if (!state) {
      throw new Error(
        'state OAuth manquant'
      );
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      scope: 'trading',
      product: 'web',
      state: String(state)
    });

    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code) {
    this._requireConfig();

    if (!code) {
      throw new Error(
        'code OAuth manquant'
      );
    }

    return this._tokenRequest({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: this.redirectUri
    });
  }

  async refresh(refreshToken) {
    this._requireConfig();

    if (!refreshToken) {
      throw new Error(
        'refreshToken manquant'
      );
    }

    return this._tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: String(refreshToken)
    });
  }

  async _tokenRequest(params) {
    const body = new URLSearchParams({
      ...params,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });

    let response;

    // Doc Spotware : échange du code = GET ; refresh = POST (paramètres dans l'URL). Repli sur l'autre méthode si 404/405.
    const isRefresh = params.grant_type === 'refresh_token';
    const attempt = method => {
      const url = `${TOKEN_URL}?${body.toString()}`;
      return fetch(url, { method, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' } });
    };

    try {
      const order = isRefresh ? ['POST', 'GET'] : ['GET', 'POST'];
      response = await attempt(order[0]);
      if (response.status === 404 || response.status === 405) response = await attempt(order[1]);
    } catch (error) {
      throw new Error(
        'cTrader OAuth inaccessible : ' +
        (error.message || 'erreur réseau')
      );
    }

    let data = null;

    try {
      data = await response.json();
    } catch (error) {
      throw new Error(
        `cTrader OAuth réponse invalide (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const code =
        data &&
        (
          data.errorCode ||
          data.error ||
          data.error_description
        );

      throw new Error(
        'cTrader OAuth refusé' +
        (code ? ` : ${code}` : ` (HTTP ${response.status})`)
      );
    }

    // Spotware peut répondre HTTP 200 avec { errorCode, description } et sans jeton.
    if (data && !data.accessToken && data.access_token) data.accessToken = data.access_token;
    if (data && !data.refreshToken && data.refresh_token) data.refreshToken = data.refresh_token;

    if (
      !data ||
      !data.accessToken
    ) {
      const why = data && [data.errorCode || data.error, data.description || data.error_description].filter(Boolean).join(' : ') +
        ' | client_id=' + this.clientId + ' secret(' + String(this.clientSecret).length + ' car.) retirés=' + this.strippedChars + ' redirect=' + this.redirectUri;
      const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
      throw new Error(
        'cTrader OAuth : accessToken absent' +
        (why ? ` — ${String(why).slice(0, 400)}` : ` (champs reçus : ${keys.slice(0, 80)}, HTTP ${response.status})`)
      );
    }

    const expiresIn =
      Number(data.expiresIn) ||
      Number(data.expires_in) ||
      0;

    return {
      accessToken:
        String(data.accessToken),

      refreshToken:
        data.refreshToken
          ? String(data.refreshToken)
          : null,

      expiresAt:
        expiresIn > 0
          ? Date.now() + expiresIn * 1000
          : null
    };
  }

  redact(value) {
    if (
      value === null ||
      value === undefined
    ) {
      return value;
    }

    const s = String(value);

    if (s.length <= 8) {
      return '***';
    }

    return (
      s.slice(0, 4) +
      '***' +
      s.slice(-4)
    );
  }

  randomState() {
    return crypto
      .randomBytes(32)
      .toString('hex');
  }
}

module.exports = {
  CTraderOAuth,
  AUTH_URL,
  TOKEN_URL
};
