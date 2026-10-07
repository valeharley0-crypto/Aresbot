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

const AUTH_URL = 'https://id.ctrader.com/my/settings/openapi';
const TOKEN_URL = 'https://openapi.ctrader.com/apps/token';

class CTraderOAuth {
  constructor({
    clientId = process.env.CTRADER_CLIENT_ID,
    clientSecret = process.env.CTRADER_CLIENT_SECRET,
    redirectUri = process.env.CTRADER_REDIRECT_URI
  } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
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
      response_type: 'code',
      scope: 'trading',
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

    try {
      response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
          'Accept':
            'application/json'
        },
        body: body.toString()
      });
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

    if (
      !data ||
      !data.accessToken
    ) {
      throw new Error(
        'cTrader OAuth : accessToken absent dans la réponse'
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
