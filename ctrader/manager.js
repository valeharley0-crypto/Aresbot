'use strict';

/**
 * ARES — cTrader Manager
 *
 * Gère une session cTrader par utilisateur.
 * Relie:
 *   OAuth
 *   Token Store
 *   CTraderSession
 *   IA Mentor Engine
 */

const crypto = require('crypto');

const {
  CTraderOAuth
} = require('./oauth');

const tokenStore =
  require('./token-store');

const {
  CTraderSession
} = require('./execution');


class CTraderManager {

  constructor({
    engineFactory,
    clientId = process.env.CTRADER_CLIENT_ID,
    clientSecret = process.env.CTRADER_CLIENT_SECRET,
    redirectUri = process.env.CTRADER_REDIRECT_URI,
    log = console.log
  } = {}) {

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;

    this.logf = typeof log === 'function'
      ? log
      : console.log;

    this.oauth = new CTraderOAuth({
      clientId,
      clientSecret,
      redirectUri
    });

    this.tokens = tokenStore;

    this.engineFactory =
      typeof engineFactory === 'function'
        ? engineFactory
        : null;

    this.sessions = new Map();

    this.oauthStates = new Map();

    this.closed = false;
  }


  log(...args) {
    try {
      this.logf(
        '[ctrader-manager]',
        ...args
      );
    } catch (_) {}
  }


  /*
   * -----------------------------
   * ENGINE
   * -----------------------------
   */

  engine(userId = 'owner') {

    const session =
      this._getSession(userId);

    return session.engine;
  }


  _createEngine(userId) {

    if (!this.engineFactory) {
      throw new Error(
        'engineFactory manquante'
      );
    }

    return this.engineFactory(
      userId
    );
  }


  /*
   * -----------------------------
   * SESSION
   * -----------------------------
   */

  _getSession(userId) {

    const id =
      String(userId || 'owner');

    let session =
      this.sessions.get(id);

    if (session) {
      return session;
    }

    const engine =
      this._createEngine(id);

    session =
      new CTraderSession({
        userId: id,
        engine,

        oauth: this.oauth,

        tokens: this.tokens,

        clientId:
          this.clientId,

        clientSecret:
          this.clientSecret,

        log: (...args) =>
          this.log(...args)
      });

    this.sessions.set(
      id,
      session
    );

    return session;
  }


  session(userId = 'owner') {

    return this._getSession(
      userId
    );
  }


  /*
   * -----------------------------
   * OAUTH
   * -----------------------------
   */

  oauthState(userId = 'owner') {

    const id =
      String(userId || 'owner');

    const state =
      crypto.randomBytes(32)
        .toString('hex');

    this.oauthStates.set(
      state,
      {
        userId: id,
        createdAt: Date.now()
      }
    );

    this._cleanupStates();

    return state;
  }


  buildAuthUrl(userId = 'owner') {

    const state =
      this.oauthState(
        userId
      );

    return this.oauth.buildAuthUrl(
      state
    );
  }


  _cleanupStates() {

    const now =
      Date.now();

    const maxAge =
      10 * 60 * 1000;

    for (
      const [
        state,
        data
      ] of this.oauthStates
    ) {

      if (
        !data ||
        now - data.createdAt >
          maxAge
      ) {
        this.oauthStates.delete(
          state
        );
      }
    }
  }


  async handleCallback(
    code,
    state
  ) {

    if (!code) {
      throw new Error(
        'code OAuth manquant'
      );
    }

    if (!state) {
      throw new Error(
        'state OAuth manquant'
      );
    }

    const saved =
      this.oauthStates.get(
        String(state)
      );

    if (!saved) {
      throw new Error(
        'state OAuth invalide ou expiré'
      );
    }

    this.oauthStates.delete(
      String(state)
    );

    const userId =
      saved.userId;

    const token =
      await this.oauth.exchangeCode(
        code
      );

    this.tokens.set(
      userId,
      {
        accessToken:
          token.accessToken,

        refreshToken:
          token.refreshToken,

        expiresAt:
          token.expiresAt
      }
    );

    const session =
      this._getSession(
        userId
      );

    await session.start();

    return {
      userId,
      connected:
        session.status ===
        'CONNECTED',

      status:
        session.status,

      message:
        session.message,

      accounts:
        session.accounts || []
    };
  }


  /*
   * -----------------------------
   * CONNECT
   * -----------------------------
   */

  async connect(userId = 'owner') {

    const session =
      this._getSession(
        userId
      );

    await session.start();

    return session.publicStatus();
  }


  async reconnect(
    userId = 'owner'
  ) {

    const session =
      this._getSession(
        userId
      );

    await session.stop();

    await session.start();

    return session.publicStatus();
  }


  async disconnect(
    userId = 'owner'
  ) {

    const id =
      String(userId || 'owner');

    const session =
      this.sessions.get(id);

    if (!session) {
      return {
        status:
          'DISCONNECTED'
      };
    }

    await session.stop();

    return session.publicStatus();
  }


  /*
   * -----------------------------
   * ACCOUNT
   * -----------------------------
   */

  async listAccounts(
    userId = 'owner'
  ) {

    const id =
      String(userId || 'owner');

    const token =
      this.tokens.get(id);

    if (
      !token ||
      !token.accessToken
    ) {
      throw new Error(
        'cTrader non autorisé'
      );
    }

    const session =
      this._getSession(id);

    const accounts =
      await session.listAccounts(
        token.accessToken
      );

    session.accounts =
      accounts;

    return accounts;
  }


  async selectAccount(
    userId,
    accountId
  ) {

    const session =
      this._getSession(
        userId
      );

    const result =
      await session.selectAccount(
        accountId
      );

    return result;
  }


  /*
   * -----------------------------
   * STATUS
   * -----------------------------
   */

  status(userId = 'owner') {

    const session =
      this.sessions.get(
        String(userId)
      );

    if (!session) {

      const token =
        this.tokens.get(
          String(userId)
        );

      return {
        status:
          token &&
          token.accessToken
            ? 'AUTHORIZED'
            : 'DISCONNECTED',

        message:
          token &&
          token.accessToken
            ? 'cTrader autorisé'
            : 'cTrader non connecté',

        accountId:
          token &&
          token.accountId
            ? token.accountId
            : null,

        isLive:
          !!(
            token &&
            token.isLive
          ),

        accounts: []
      };
    }

    return session.publicStatus();
  }


  /*
   * -----------------------------
   * TOKEN
   * -----------------------------
   */

  tokensAvailable(
    userId = 'owner'
  ) {

    return this.tokens.available(
      String(userId)
    );
  }


  tokenStatus(
    userId = 'owner'
  ) {

    const token =
      this.tokens.get(
        String(userId)
      );

    if (!token) {
      return {
        authorized: false
      };
    }

    return {
      authorized:
        !!token.accessToken,

      expiresAt:
        token.expiresAt || null,

      accountId:
        token.accountId || null,

      isLive:
        !!token.isLive
    };
  }


  /*
   * -----------------------------
   * START / STOP ALL
   * -----------------------------
   */

  async startAll() {

    if (this.closed) {
      throw new Error(
        'manager fermé'
      );
    }

    const results = [];

    for (
      const [
        userId,
        session
      ] of this.sessions
    ) {

      try {

        await session.start();

        results.push({
          userId,
          ok: true,
          status:
            session.status
        });

      } catch (error) {

        results.push({
          userId,
          ok: false,
          error:
            error.message
        });
      }
    }

    return results;
  }


  async stopAll() {

    for (
      const session
      of this.sessions.values()
    ) {

      try {
        await session.stop();
      } catch (_) {}
    }
  }


  async close() {

    this.closed = true;

    await this.stopAll();

    this.sessions.clear();

    this.oauthStates.clear();
  }


  /*
   * -----------------------------
   * ADMIN / DEBUG
   * -----------------------------
   */

  overview() {

    const users = [];

    for (
      const [
        userId,
        session
      ] of this.sessions
    ) {

      users.push({
        userId,
        status:
          session.status,

        accountId:
          session.accountId
            ? String(session.accountId)
            : null,

        isLive:
          !!(
            this.tokens.get(userId) &&
            this.tokens.get(userId).isLive
          ),

        positions:
          session.positions
            ? session.positions.size
            : 0,

        symbols:
          session.specs
            ? Object.keys(
                session.specs
              )
            : []
      });
    }

    return {
      configured:
        this.oauth.configured(),

      sessions:
        users,

      usersCount:
        users.length,

      tokensCount:
        this.tokens.count()
    };
  }
}


/*
 * --------------------------------
 * FACTORY
 * --------------------------------
 */

function createManager(opts = {}) {

  /*
   * Si aucun engineFactory n'est fourni,
   * on tente de charger automatiquement
   * le moteur ARES.
   */

  if (
    !opts.engineFactory
  ) {

    let EngineModule = null;

    const candidates = [
      '../moteur',
      '../engine',
      '../moteur.js',
      '../engine.js'
    ];

    for (
      const file
      of candidates
    ) {

      try {

        EngineModule =
          require(file);

        break;

      } catch (_) {}
    }

    if (!EngineModule) {

      throw new Error(
        'Impossible de charger le moteur ARES'
      );
    }

    opts.engineFactory =
      function createEngine(
        userId
      ) {

        if (
          typeof EngineModule ===
          'function'
        ) {
          return new EngineModule(
            userId
          );
        }

        if (
          typeof EngineModule.createEngine ===
          'function'
        ) {
          return EngineModule.createEngine(
            userId
          );
        }

        if (
          typeof EngineModule.Engine ===
          'function'
        ) {
          return new EngineModule.Engine(
            {
              userId
            }
          );
        }

        if (
          EngineModule.default
        ) {

          if (
            typeof EngineModule.default ===
            'function'
          ) {
            return new EngineModule.default(
              userId
            );
          }
        }

        throw new Error(
          'Format moteur ARES non reconnu'
        );
      };
  }

  return new CTraderManager(
    opts
  );
}


module.exports = {
  CTraderManager,
  createManager
};
