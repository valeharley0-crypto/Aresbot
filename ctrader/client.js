'use strict';

/**
 * cTrader Open API — JSON/WebSocket
 * Compatible avec le reste de ARES :
 * execution.js / manager.js
 */

const EventEmitter = require('events');

const PT = {
  HEARTBEAT: 51,

  APP_AUTH_REQ: 2100,
  APP_AUTH_RES: 2101,

  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,

  NEW_ORDER_REQ: 2106,
  AMEND_POSITION_SLTP_REQ: 2110,
  CLOSE_POSITION_REQ: 2111,

  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,

  TRADER_REQ: 2121,
  TRADER_RES: 2122,

  RECONCILE_REQ: 2124,
  RECONCILE_RES: 2125,

  EXECUTION_EVENT: 2126,

  SUBSCRIBE_SPOTS_REQ: 2127,
  SUBSCRIBE_SPOTS_RES: 2128,

  SPOT_EVENT: 2131,
  ORDER_ERROR_EVENT: 2132,

  GET_TRENDBARS_REQ: 2137,
  GET_TRENDBARS_RES: 2138,

  EXPECTED_MARGIN_REQ: 2139,
  EXPECTED_MARGIN_RES: 2140,

  MARGIN_CHANGED_EVENT: 2141,
  ERROR_RES: 2142,

  TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,

  ACCOUNTS_BY_TOKEN_REQ: 2149,
  ACCOUNTS_BY_TOKEN_RES: 2150,

  ACCOUNT_DISCONNECT_EVENT: 2164,

  UNREALIZED_PNL_REQ: 2187,
  UNREALIZED_PNL_RES: 2188
};

const HOSTS = {
  demo: 'demo.ctraderapi.com',
  live: 'live.ctraderapi.com'
};

const PERIOD = {
  1: 1,
  5: 5,
  15: 7,
  30: 8
};

class CTraderClient extends EventEmitter {
  constructor({
    env = 'demo',
    port = 5036,
    clientId,
    clientSecret,
    WebSocketImpl,
    heartbeatMs = 10000,
    timeoutMs = 15000
  } = {}) {
    super();

    this.env = env === 'live' ? 'live' : 'demo';
    this.host = HOSTS[this.env];
    this.port = Number(port) || 5036;

    this.clientId = clientId;
    this.clientSecret = clientSecret;

    this.WS =
      WebSocketImpl ||
      (() => {
        try {
          return require('ws');
        } catch (_) {
          return typeof WebSocket !== 'undefined'
            ? WebSocket
            : null;
        }
      })();

    this.heartbeatMs = heartbeatMs;
    this.timeoutMs = timeoutMs;

    this.ws = null;
    this.seq = 0;
    this.pending = new Map();

    this.hb = null;
    this.ready = false;
    this.appAuthorized = false;
    this.closing = false;
  }

  url() {
    return `wss://${this.host}:${this.port}`;
  }

  async connect() {
    if (!this.WS) {
      throw new Error(
        'WebSocket indisponible : installer le paquet "ws"'
      );
    }

    if (!this.clientId) {
      throw new Error(
        'CTRADER_CLIENT_ID manquant'
      );
    }

    if (!this.clientSecret) {
      throw new Error(
        'CTRADER_CLIENT_SECRET manquant'
      );
    }

    this.closing = false;
    this.ready = false;
    this.appAuthorized = false;

    await new Promise((resolve, reject) => {
      const ws = new this.WS(this.url());

      this.ws = ws;

      let done = false;

      const finish = (fn, value) => {
        if (done) return;
        done = true;
        fn(value);
      };

      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (_) {}

        finish(
          reject,
          new Error(
            'connexion cTrader : délai dépassé'
          )
        );
      }, this.timeoutMs);

      const on = (event, fn) => {
        if (typeof ws.addEventListener === 'function') {
          ws.addEventListener(event, fn);
        } else if (typeof ws.on === 'function') {
          ws.on(event, fn);
        }
      };

      on('open', () => {
        clearTimeout(timer);
        finish(resolve);
      });

      on('error', error => {
        clearTimeout(timer);

        this.emit('error_', error);

        const message =
          error && error.message
            ? error.message
            : 'erreur WebSocket';

        finish(
          reject,
          new Error(
            'connexion cTrader : ' + message
          )
        );
      });

      on('close', () => {
        this.ready = false;
        this.appAuthorized = false;

        this._stopHb();

        this._failAll(
          new Error('connexion cTrader fermée')
        );

        if (!this.closing) {
          this.emit('disconnected');
        }
      });

      on('message', message => {
        this._onMessage(
          message && message.data !== undefined
            ? message.data
            : message
        );
      });
    });

    this._startHb();

    /*
     * Application Authentication
     */
    let response;

    try {
      response = await this.request(
        PT.APP_AUTH_REQ,
        {
          clientId: this.clientId,
          clientSecret: this.clientSecret
        }
      );
    } catch (error) {
      this.ready = false;
      this.appAuthorized = false;

      throw error;
    }

    if (
      !response ||
      response.payloadType !== PT.APP_AUTH_RES
    ) {
      this.ready = false;
      this.appAuthorized = false;

      const type =
        response && response.payloadType;

      throw new Error(
        `cTrader Application Auth invalide (${type || 'aucune réponse'})`
      );
    }

    this.appAuthorized = true;
    this.ready = true;

    return response;
  }

  _startHb() {
    this._stopHb();

    this.hb = setInterval(() => {
      try {
        this._raw({
          payloadType: PT.HEARTBEAT,
          payload: {}
        });
      } catch (_) {}
    }, this.heartbeatMs);

    if (this.hb && this.hb.unref) {
      this.hb.unref();
    }
  }

  _stopHb() {
    if (this.hb) {
      clearInterval(this.hb);
      this.hb = null;
    }
  }

  _raw(obj) {
    if (
      this.ws &&
      this.ws.readyState === 1
    ) {
      this.ws.send(
        JSON.stringify(obj)
      );
      return;
    }

    throw new Error(
      'connexion cTrader fermée'
    );
  }

  _failAll(error) {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.t);
