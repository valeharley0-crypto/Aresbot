'use strict';

/**
 * ARES — Module d'exécution cTrader
 *
 * Une session par utilisateur / compte cTrader.
 *
 * Gère :
 * - OAuth / access token
 * - connexion cTrader
 * - application/account authentication
 * - comptes
 * - balance / equity / marge
 * - symboles
 * - prix temps réel
 * - historique
 * - positions
 * - ordres marché
 * - SL / TP
 * - modification
 * - clôture
 *
 * IMPORTANT :
 * Lorsqu'un accountId/isLive est ajouté au token store,
 * les accessToken/refreshToken/expiresAt existants sont conservés.
 */

const { CTraderClient, PT, PERIOD } = require('./client');

const E = {
  ORDER_ACCEPTED: 2,
  ORDER_FILLED: 3,
  ORDER_REJECTED: 7,
  ORDER_PARTIAL_FILL: 11
};

const ENUM_NAME = {
  2: 'ORDER_ACCEPTED',
  3: 'ORDER_FILLED',
  7: 'ORDER_REJECTED',
  11: 'ORDER_PARTIAL_FILL'
};

const isEt = (v, code) =>
  v === code || v === ENUM_NAME[code];

const norm = s =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const P5 = 1e5;


/**
 * Fusion sûre du token existant.
 *
 * Très important :
 * ne jamais remplacer un accessToken/refreshToken
 * simplement parce qu'on ajoute accountId/isLive.
 */
function mergeToken(tokens, userId, patch) {
  const current =
    typeof tokens.get === 'function'
      ? (tokens.get(userId) || {})
      : {};

  return {
    ...current,
    ...patch
  };
}


class CTraderSession {

  constructor({
    userId,
    engine,
    oauth,
    tokens,
    clientId,
    clientSecret,
    WebSocketImpl,
    now = () => Date.now(),
    log = () => {}
  }) {

    Object.assign(this, {
      userId,
      engine,
      oauth,
      tokens,
      clientId,
      clientSecret,
      WebSocketImpl,
      now,
      logf: log
    });

    this.client = null;

    this.status = 'DISCONNECTED';
    this.message = '';

    this.accounts = [];

    this.light = new Map();
    this.byName = new Map();
    this.specs = {};
    this.quotes = {};
    this.conv = {};

    this.positions = new Map();
    this.posToTrade = new Map();
    this.margins = new Map();

    this.timers = [];

    this.backoff = 2000;
    this.stopped = true;

    this.moneyDigits = 2;
    this.accountType = null;
    this.closedDay = null;
    this.depositAssetId = null;

    this.accountId = null;
    this.balance = null;
    this.freeMargin = null;
  }


  log(...a) {
    try {
      this.logf(
        '[ctrader:' + this.userId + ']',
        ...a.map(x =>
          typeof x === 'string'
            ? this.oauth.redact(x)
            : x
        )
      );
    } catch (_) {}
  }


  setStatus(status, message, extra) {

    this.status = status;
    this.message = message || '';

    try {

      if (
        this.engine &&
        typeof this.engine.setExecStatus === 'function'
      ) {

        this.engine.setExecStatus(
          Object.assign(
            {
              status,
              message: this.message
            },
            extra || {}
          )
        );

      }

    } catch (e) {

      this.log(
        'setExecStatus:',
        e && e.message
      );

    }
  }


  publicStatus() {

    const token =
      this.tokens.get(this.userId) || {};

    return {

      status: this.status,

      message: this.message,

      accountId:
        token.accountId ||
        this.accountId ||
        null,

      isLive:
        !!token.isLive,

      accounts:
        this.accounts.map(a => ({
          accountId:
            String(a.ctidTraderAccountId),

          isLive:
            !!a.isLive,

          login:
            a.traderLogin || null,

          broker:
            a.brokerTitleShort || null
        })),

      accountType:
        this.accountType,

      balance:
        this.balance,

      freeMargin:
        this.freeMargin,

      symbols:
        Object.keys(this.specs)
    };
  }


  // =========================================================
  // START / STOP
  // =========================================================

  async start() {

    this.stopped = false;

    try {

      await this._connectFlow();

      this.backoff = 2000;

    } catch (e) {

      this.log(
        'start:',
        e && e.message
      );

      this.setStatus(
        this.status === 'SELECT_ACCOUNT'
          ? 'SELECT_ACCOUNT'
          : 'ERROR',

        e && e.message
          ? e.message
          : 'Erreur cTrader'
      );

      if (
        this.status !== 'SELECT_ACCOUNT'
      ) {
        this._scheduleReconnect();
      }
    }
  }


  async stop() {

    this.stopped = true;

    this._clearTimers();

    if (this._rt) {
      clearTimeout(this._rt);
      this._rt = null;
    }

    if (this.client) {

      try {
        await this.client.close();
      } catch (_) {}

      this.client = null;
    }

    this.setStatus(
      'DISCONNECTED',
      'session arrêtée'
    );
  }


  _clearTimers() {

    this.timers.forEach(t => {
      try {
        clearInterval(t);
      } catch (_) {}
    });

    this.timers = [];
  }


  _scheduleReconnect() {

    if (
      this.stopped ||
      this._rt
    ) {
      return;
    }

    this._rt = setTimeout(
      async () => {

        this._rt = null;

        if (!this.stopped) {
          await this.start();
        }

      },
      this.backoff
    );

    if (this._rt.unref) {
      this._rt.unref();
    }

    this.backoff =
      Math.min(
        this.backoff * 2,
        60000
      );
  }


  // =========================================================
  // TOKENS
  // =========================================================

  async _ensureTokens() {

    let t =
      this.tokens.get(this.userId);

    if (
      !t ||
      !t.accessToken
    ) {

      throw Object.assign(
        new Error(
          'cTrader non autorisé : connecter le compte (OAuth)'
        ),
        {
          fatal: true
        }
      );
    }


    /*
     * Refresh préventif.
     *
     * On conserve TOUS les autres champs du token :
     * accountId, isLive, etc.
     */
    if (
      t.refreshToken &&
      t.expiresAt &&
      t.expiresAt - this.now()
        < 2 * 86400000
    ) {

      try {
        const n =
          await this.oauth.refresh(
            t.refreshToken
          );

        this.tokens.set(
          this.userId,
          mergeToken(
            this.tokens,
            this.userId,
            {
              accessToken:
                n.accessToken,

              refreshToken:
                n.refreshToken ||
                t.refreshToken,

              expiresAt:
                n.expiresAt
            }
          )
        );

        t =
          this.tokens.get(
            this.userId
          );
      } catch (e) {
        // Refresh raté : on garde le token actuel (peut encore être valide) au lieu de tout bloquer
        this.log('refresh préventif:', e && e.message);
      }
    }

    return t;
  }


  // =========================================================
  // ACCOUNTS
  // =========================================================

  async listAccounts(accessToken) {

    for (
      const env of [
        'live',
        'demo'
      ]
    ) {

      const c =
        new CTraderClient({
          env,
          clientId:
            this.clientId,
          clientSecret:
            this.clientSecret,
          WebSocketImpl:
            this.WebSocketImpl
        });

      try {

        await c.connect();

        const r =
          await c.request(
            PT.ACCOUNTS_BY_TOKEN_REQ,
            {
              accessToken
            }
          );

        await c.close();

        const list =
          (
            r &&
            r.payload &&
            r.payload.ctidTraderAccount
          ) || [];

        if (list.length) {
          return list;
        }

      } catch (e) {

        try {
          await c.close();
        } catch (_) {}

        this.log(
          'listAccounts',
          env,
          e && e.message
        );
      }
    }

    return [];
  }


  async selectAccount(accountId) {

    const a =
      this.accounts.find(
        x =>
          String(
            x.ctidTraderAccountId
          ) === String(accountId)
      );

    if (!a) {

      throw new Error(
        'compte inconnu (autoriser puis lister les comptes)'
      );
    }


    /*
     * IMPORTANT :
     * on garde accessToken,
     * refreshToken et expiresAt.
     */
    this.tokens.set(
      this.userId,
      mergeToken(
        this.tokens,
        this.userId,
        {
          accountId:
            String(
              a.ctidTraderAccountId
            ),

          isLive:
            !!a.isLive
        }
      )
    );


    await this.stop();

    await this.start();

    return this.publicStatus();
  }


  // =========================================================
  // CONNECT FLOW
  // =========================================================

  async _connectFlow() {

    this._clearTimers();

    if (this.client) {

      try {
        await this.client.close();
      } catch (_) {}

      this.client = null;
    }


    this.setStatus(
      'CONNECTING',
      'connexion à cTrader…'
    );


    let t =
      await this._ensureTokens();


    /*
     * Aucun compte sélectionné :
     * récupérer les comptes liés au token.
     */
    if (!t.accountId) {

      this.accounts =
        await this.listAccounts(
          t.accessToken
        );


      if (!this.accounts.length) {

        throw new Error(
          'aucun compte cTrader accessible avec cette autorisation'
        );
      }


      /*
       * Plusieurs comptes :
       * laisser l'utilisateur choisir.
       */
      if (
        this.accounts.length > 1
      ) {

        this.setStatus(
          'SELECT_ACCOUNT',
          'plusieurs comptes : choisir le compte de trading'
        );

        throw Object.assign(
          new Error(
            'choisir le compte de trading'
          ),
          {
            fatal: true
          }
        );
      }


      /*
       * UN SEUL COMPTE.
       *
       * IMPORTANT :
       * merge avec le token existant.
       */
      const account =
        this.accounts[0];

      this.tokens.set(
        this.userId,
        mergeToken(
          this.tokens,
          this.userId,
          {
            accountId:
              String(
                account.ctidTraderAccountId
              ),

            isLive:
              !!account.isLive
          }
        )
      );


      t =
        this.tokens.get(
          this.userId
        );
    }


    if (
      !t ||
      !t.accessToken
    ) {

      throw new Error(
        'accessToken cTrader absent après sélection du compte'
      );
    }


    const accId =
      Number(t.accountId);


    if (
      !Number.isFinite(accId) ||
      accId <= 0
    ) {

      throw new Error(
        'ctidTraderAccountId invalide'
      );
    }


    const c =
      this.client =
        new CTraderClient({
          env:
            t.isLive
              ? 'live'
              : 'demo',

          clientId:
            this.clientId,

          clientSecret:
            this.clientSecret,

          WebSocketImpl:
            this.WebSocketImpl
        });


    c.on(
      'message',
      m => {

        try {
          this._onEvent(m);
        } catch (e) {
          this.log(
            'event',
            e && e.message
          );
        }
      }
    );


    c.on(
      'disconnected',
      () => {

        if (
          this.stopped ||
          c !== this.client
        ) {
          return;
        }

        this.setStatus(
          'DISCONNECTED',
          'connexion cTrader perdue : reconnexion…'
        );

        this._clearTimers();

        this._scheduleReconnect();
      }
    );


    await c.connect();


    /*
     * Account authentication.
     *
     * Le CTraderClient doit avoir effectué
     * l'application authentication pendant
     * sa connexion.
     */
    try {

      await c.request(
        PT.ACCOUNT_AUTH_REQ,
        {
          ctidTraderAccountId:
            accId,

          accessToken:
            t.accessToken
        }
      );

    } catch (e) {

      const code =
        String(
          e &&
          (
            e.code ||
            e.errorCode ||
            ''
          )
        ).toUpperCase();


      /*
       * Token expiré/invalide :
       * refresh puis nouvelle AccountAuth.
       */
      if (
        (
          code.includes('EXPIRED') ||
          code.includes('INVALID')
        ) &&
        t.refreshToken
      ) {

        const n =
          await this.oauth.refresh(
            t.refreshToken
          );


        this.tokens.set(
          this.userId,
          mergeToken(
            this.tokens,
            this.userId,
            {
              accessToken:
                n.accessToken,

              refreshToken:
                n.refreshToken ||
                t.refreshToken,

              expiresAt:
                n.expiresAt
            }
          )
        );


        t =
          this.tokens.get(
            this.userId
          );


        await c.request(
          PT.ACCOUNT_AUTH_REQ,
          {
            ctidTraderAccountId:
              accId,

            accessToken:
              t.accessToken
          }
        );

      } else {

        throw e;
      }
    }


    this.accountId =
      accId;


    await this._loadTrader();

    await this._loadSymbols();

    await this._subscribe();

    await this._reconcile();

    await this._refreshAccount();


    this.setStatus(
      'CONNECTED',
      'connecté',
      {
        accountId:
          String(accId),

        isLive:
          !!t.isLive,

        accountType:
          this.accountType
      }
    );


    if (
      this.engine &&
      typeof this.engine.updateAccount === 'function'
    ) {

      this.engine.updateAccount({
        accountId:
          String(accId),

        isLive:
          !!t.isLive
      });
    }


    this.timers.push(

      setInterval(
        () =>
          this._orderLoop(),
        1000
      ),

      setInterval(
        () =>
          this._refreshAccount()
            .catch(e =>
              this.log(
                'refresh',
                e && e.message
              )
            ),
        15000
      ),

      setInterval(
        () =>
          this._refreshVpl(),
        30000
      )
    );


    this.timers.forEach(
      x =>
        x.unref &&
        x.unref()
    );


    this._seedHistory()
      .catch(e =>
        this.log(
          'seed',
          e && e.message
        )
      );


    this.log(
      'connecté, compte',
      accId,
      t.isLive
        ? 'LIVE'
        : 'DEMO'
    );
  }


  // =========================================================
  // TRADER
  // =========================================================

  async _loadTrader() {

    const r =
      await this.client.request(
        PT.TRADER_REQ,
        {
          ctidTraderAccountId:
            this.accountId
        }
      );


    const tr =
      r.payload.trader || {};


    this.moneyDigits =
      tr.moneyDigits != null
        ? Number(tr.moneyDigits)
        : 2;


    this.balance =
      Number(tr.balance) /
      Math.pow(
        10,
        this.moneyDigits
      );


    this.depositAssetId =
      tr.depositAssetId;

    this.accountType =
      tr.accountType;


    const netted =
      tr.accountType === 1 ||
      tr.accountType === 'NETTED';


    if (
      netted &&
      this.engine &&
      typeof this.engine.getConfig === 'function' &&
      typeof this.engine.setConfig === 'function'
    ) {

      const cfg =
        this.engine.getConfig();

      if (
        cfg &&
        cfg.split &&
        cfg.split.enabled
      ) {

        this.engine.setConfig({
          split: {
            enabled: false
          }
        });

        this.log(
          'compte NETTED : positions multiples TP1/TP2 désactivées'
        );
      }
    }


    if (
      tr.accessRights === 2 ||
      tr.accessRights === 'NO_TRADING' ||
      tr.accessRights === 1 ||
      tr.accessRights === 'CLOSE_ONLY'
    ) {

      this.log(
        'droits du compte limités :',
        tr.accessRights
      );
    }
  }


  // =========================================================
  // SYMBOLS
  // =========================================================

  async _loadSymbols() {

    const r =
      await this.client.request(
        PT.SYMBOLS_LIST_REQ,
        {
          ctidTraderAccountId:
            this.accountId
        }
      );


    this.light.clear();
    this.byName.clear();


    for (
      const s of
      (
        r.payload.symbol ||
        []
      )
    ) {

      this.light.set(
        String(s.symbolId),
        s
      );

      this.byName.set(
        norm(s.symbolName),
        s
      );
    }


    const cfg =
      this.engine.getConfig();

    const allowed =
      Array.isArray(
        cfg.symbolsAllowed
      )
        ? cfg.symbolsAllowed
        : [];


    const need = [];
    const missing = [];


    for (
      const name of allowed
    ) {

      const l =
        this.byName.get(
          norm(name)
        );

      if (l) {
        need.push(l);
      } else {
        missing.push(name);
      }
    }


    if (missing.length) {

      this.log(
        'symboles absents chez ce broker :',
        missing.join(',')
      );
    }


    const extra = [];


    for (
      const l of need
    ) {

      if (
        String(l.quoteAssetId) ===
        String(this.depositAssetId)
      ) {
        continue;
      }


      const c =
        [...this.light.values()]
          .find(x =>

            (
              String(x.baseAssetId) ===
                String(l.quoteAssetId) &&

              String(x.quoteAssetId) ===
                String(this.depositAssetId)
            ) ||

            (
              String(x.baseAssetId) ===
                String(this.depositAssetId) &&

              String(x.quoteAssetId) ===
                String(l.quoteAssetId)
            )
          );


      if (c) {

        this.conv[
          norm(l.symbolName)
        ] = {

          id:
            String(c.symbolId),

          inverse:
            String(c.baseAssetId) ===
            String(this.depositAssetId)
        };

        extra.push(c);
      }
    }


    this.watch =
      [
        ...new Map(
          [
            ...need,
            ...extra
          ].map(
            x => [
              String(x.symbolId),
              x
            ]
          )
        ).values()
      ];


    const ids =
      need.map(
        x =>
          Number(x.symbolId)
      );


    if (!ids.length) {

      throw new Error(
        'aucun symbole autorisé disponible chez ce broker'
      );
    }


    const d =
      await this.client.request(
        PT.SYMBOL_BY_ID_REQ,
        {
          ctidTraderAccountId:
            this.accountId,

          symbolId:
            ids
        }
      );


    for (
      const s of
      (
        d.payload.symbol ||
        []
      )
    ) {

      const l =
        this.light.get(
          String(s.symbolId)
        );

      if (!l) {
        continue;
      }


      const name =
        norm(l.symbolName);

      const lot =
        Number(s.lotSize);


      if (!(lot > 0)) {

        this.log(
          'lotSize absent pour',
          name
        );

        continue;
      }


      this.specs[name] = {

        symbolId:
          Number(s.symbolId),

        digits:
          Number(s.digits),

        pipPosition:
          Number(s.pipPosition),

        lotSize:
          lot,

        minVolume:
          Number(s.minVolume) || 0,

        stepVolume:
          Number(s.stepVolume) || 0,

        maxVolume:
          Number(s.maxVolume) || 0,

        quoteAssetId:
          l.quoteAssetId,

        minLot:
          (Number(s.minVolume) || 0) /
          lot,

        lotStep:
          (Number(s.stepVolume) || 0) /
          lot,

        maxLot:
          (Number(s.maxVolume) || 0) /
          lot,

        unitsPerLot:
          lot / 100,

        tradingMode:
          s.tradingMode
      };
    }
  }


  _quoteToDeposit(name) {

    const sp =
      this.specs[name];

    if (!sp) {
      return null;
    }


    if (
      String(sp.quoteAssetId) ===
      String(this.depositAssetId)
    ) {
      return 1;
    }


    const c =
      this.conv[name];

    if (!c) {
      return null;
    }


    const q =
      this.quotes[c.id];


    if (
      !q ||
      !(q.bid > 0) ||
      !(q.ask > 0)
    ) {
      return null;
    }


    const mid =
      (q.bid + q.ask) / 2;


    return c.inverse
      ? 1 / mid
      : mid;
  }


  _refreshVpl() {

    const prices = {};


    for (
      const name of
      Object.keys(this.specs)
    ) {

      const sp =
        this.specs[name];

      const rate =
        this._quoteToDeposit(
          name
        );


      sp.vpl =
        rate
          ? sp.unitsPerLot * rate
          : undefined;


      prices[name] = {

        vpl:
          sp.vpl,

        minLot:
          sp.minLot,

        lotStep:
          sp.lotStep,

        maxLot:
          sp.maxLot,

        digits:
          sp.digits
      };
    }


    if (
      this.engine &&
      typeof this.engine.updateAccount === 'function'
    ) {

      this.engine.updateAccount({
        prices
      });
    }
  }


  async _subscribe() {

    const ids =
      this.watch.map(
        x =>
          Number(x.symbolId)
      );


    await this.client.request(
      PT.SUBSCRIBE_SPOTS_REQ,
      {
        ctidTraderAccountId:
          this.accountId,

        symbolId:
          ids
      }
    );


    await sleep(1500);

    this._refreshVpl();
  }


  async _seedHistory() {

    const now =
      this.now();


    for (
      const name of
      Object.keys(this.specs)
    ) {

      for (
        const tf of
        [1, 5, 15, 30]
      ) {

        if (this.stopped) {
          return;
        }


        try {

          const r =
            await this.client.request(
              PT.GET_TRENDBARS_REQ,
              {
                ctidTraderAccountId:
                  this.accountId,

                symbolId:
                  this.specs[name].symbolId,

                period:
                  PERIOD[tf],

                fromTimestamp:
                  now -
                  10 * 86400000,

                toTimestamp:
                  now,

                count:
                  400
              }
            );


          const bars =
            (
              r.payload.trendbar ||
              []
            )
              .map(b => {

                const low =
                  Number(b.low);

                return {

                  t:
                    Number(
                      b.utcTimestampInMinutes
                    ) * 60000,

                  o:
                    (
                      low +
                      Number(
                        b.deltaOpen || 0
                      )
                    ) / P5,

                  h:
                    (
                      low +
                      Number(
                        b.deltaHigh || 0
                      )
                    ) / P5,

                  l:
                    low / P5,

                  c:
                    (
                      low +
                      Number(
                        b.deltaClose || 0
                      )
                    ) / P5
                };
              })
              .sort(
                (a, b) =>
                  a.t - b.t
              );


          if (
            bars.length &&
            this.engine &&
            typeof this.engine.setCandles === 'function'
          ) {

            this.engine.setCandles(
              name,
              tf,
              bars
            );
          }

        } catch (e) {

          this.log(
            'trendbars',
            name,
            tf,
            e && e.code,
            e && e.message
          );


          if (
            e &&
            e.code ===
              'REQUEST_FREQUENCY_EXCEEDED'
          ) {

            await sleep(2000);
          }
        }


        await sleep(300);
      }
    }


    this.log(
      'historique chargé'
    );
  }


  // =========================================================
  // POSITIONS / ACCOUNT
  // =========================================================

  async _reconcile() {

    const r =
      await this.client.request(
        PT.RECONCILE_REQ,
        {
          ctidTraderAccountId:
            this.accountId
        }
      );


    this.positions.clear();


    for (
      const p of
      (
        r.payload.position ||
        []
      )
    ) {

      this._trackPosition(p);
    }


    if (
      this.engine &&
      typeof this.engine.activeTrades === 'function'
    ) {

      for (
        const t of
        this.engine.activeTrades()
      ) {

        if (t.ticket) {

          this.posToTrade.set(
            String(t.ticket),
            t.id
          );
        }
      }
    }
  }


  _trackPosition(p) {

    if (
      !p ||
      p.positionId == null
    ) {
      return;
    }


    const open =
      p.positionStatus === 1 ||
      p.positionStatus ===
        'POSITION_STATUS_OPEN';


    if (open) {

      this.positions.set(
        String(p.positionId),
        {
          volume:
            Number(
              p.tradeData &&
              p.tradeData.volume
            ),

          symbolId:
            p.tradeData &&
            p.tradeData.symbolId,

          sl:
            p.stopLoss,

          tp:
            p.takeProfit
        }
      );


      if (
        p.usedMargin != null
      ) {

        this.margins.set(
          String(p.positionId),

          Number(p.usedMargin) /
            Math.pow(
              10,
              p.moneyDigits != null
                ? p.moneyDigits
                : this.moneyDigits
            )
        );
      }

    } else {

      this.positions.delete(
        String(p.positionId)
      );

      this.margins.delete(
        String(p.positionId)
      );
    }
  }


  async _refreshAccount() {

    if (
      !this.client ||
      !this.client.ready
    ) {
      return;
    }


    const tr =
      await this.client.request(
        PT.TRADER_REQ,
        {
          ctidTraderAccountId:
            this.accountId
        }
      );


    const trader =
      tr.payload.trader || {};


    const md =
      trader.moneyDigits != null
        ? Number(trader.moneyDigits)
        : this.moneyDigits;


    const balance =
      Number(trader.balance) /
      Math.pow(10, md);


    let unreal = 0;


    try {

      const u =
        await this.client.request(
          PT.UNREALIZED_PNL_REQ,
          {
            ctidTraderAccountId:
              this.accountId
          }
        );


      const ud =
        u.payload.moneyDigits != null
          ? Number(
              u.payload.moneyDigits
            )
          : md;


      unreal =
        (
          u.payload.positionUnrealizedPnL ||
          []
        )
          .reduce(
            (a, x) =>
              a +
              Number(
                x.netUnrealizedPnL
              ) /
                Math.pow(10, ud),
            0
          );

    } catch (e) {

      this.log(
        'pnl latent',
        e && e.message
      );
    }


    const margin =
      [...this.margins.values()]
        .reduce(
          (a, x) =>
            a + x,
          0
        );


    const equity =
      balance + unreal;


    this.freeMargin =
      equity - margin;


    this.balance =
      balance;


    if (
      this.engine &&
      typeof this.engine.updateAccount === 'function'
    ) {

      this.engine.updateAccount({
        balance,
        equity,
        margin,
        freeMargin:
          this.freeMargin
      });
    }
  }


  // =========================================================
  // EVENTS
  // =========================================================

  _onEvent(m) {

    const p =
      m.payload || {};


    switch (m.payloadType) {

      case PT.SPOT_EVENT: {

        const id =
          String(p.symbolId);

        const q =
          (
            this.quotes[id] =
              this.quotes[id] ||
              {}
          );


        if (p.bid != null) {
          q.bid =
            Number(p.bid) / P5;
        }


        if (p.ask != null) {
          q.ask =
            Number(p.ask) / P5;
        }


        const l =
          this.light.get(id);

        const name =
          l &&
          norm(l.symbolName);


        if (
          name &&
          this.specs[name] &&
          q.bid > 0 &&
          q.ask > 0
        ) {

          if (
            this.engine &&
            typeof this.engine.updateAccount === 'function'
          ) {

            this.engine.updateAccount({
              prices: {
                [name]: {
                  bid: q.bid,
                  ask: q.ask
                }
              }
            });
          }
        }

        break;
      }


      case PT.EXECUTION_EVENT:

        this._onExecution(p);

        break;


      case PT.MARGIN_CHANGED_EVENT:

        this.margins.set(
          String(p.positionId),

          Number(p.usedMargin) /
            Math.pow(
              10,
              p.moneyDigits != null
                ? p.moneyDigits
                : this.moneyDigits
            )
        );

        break;


      case PT.ORDER_ERROR_EVENT:

        this.log(
          'erreur ordre',
          p.errorCode,
          p.description
        );

        break;


      case PT.TOKEN_INVALIDATED_EVENT:

        this.setStatus(
          'ERROR',
          'autorisation cTrader invalidée : renouvellement…'
        );

        this._scheduleReconnect();

        break;


      case PT.CLIENT_DISCONNECT_EVENT:
      case PT.ACCOUNT_DISCONNECT_EVENT:

        this.setStatus(
          'DISCONNECTED',
          'session cTrader fermée par le serveur : reconnexion…'
        );

        this._scheduleReconnect();

        break;


      default:
        break;
    }
  }


  _applyClose(posKey, deal) {

    const cpd =
      deal.closePositionDetail;

    if (!cpd) {
      return;
    }


    const tradeId =
      this.posToTrade.get(
        posKey
      );

    if (!tradeId) {
      return;
    }


    const md =
      cpd.moneyDigits != null
        ? Number(cpd.moneyDigits)
        : (
            deal.moneyDigits != null
              ? Number(deal.moneyDigits)
              : this.moneyDigits
          );


    const k =
      Math.pow(10, md);


    const net =
      (
        Number(cpd.grossProfit) +
        Number(cpd.swap || 0) +
        Number(cpd.commission || 0) +
        Number(cpd.pnlConversionFee || 0)
      ) / k;


    if (
      this.engine &&
      typeof this.engine.execResult === 'function'
    ) {

      const r =
        this.engine.execResult({
          id:
            tradeId,

          closePrice:
            Number(
              deal.executionPrice
            ),

          pnlMoney:
            Math.round(
              net * 100
            ) / 100,

          balance:
            Number(cpd.balance) / k
        });


      if (
        !r ||
        !r.ok
      ) {

        this.log(
          'résultat ignoré :',
          r && r.error
        );
      }
    }


    this.posToTrade.delete(
      posKey
    );

    this.positions.delete(
      posKey
    );

    this.margins.delete(
      posKey
    );
  }


  _onExecution(p) {

    const order =
      p.order;

    const pos =
      p.position;

    const deal =
      p.deal;

    const et =
      p.executionType;


    if (pos) {
      this._trackPosition(pos);
    }


    if (
      deal &&
      deal.closePositionDetail &&
      pos &&
      (
        pos.positionStatus === 2 ||
        pos.positionStatus ===
          'POSITION_STATUS_CLOSED'
      )
    ) {

      this._applyClose(
        String(pos.positionId),
        deal
      );

      return;
    }


    if (
      (
        isEt(
          et,
          E.ORDER_FILLED
        ) ||

        isEt(
          et,
          E.ORDER_PARTIAL_FILL
        )
      ) &&

      order &&
      order.clientOrderId &&

      pos &&

      !(
        deal &&
        deal.closePositionDetail
      )
    ) {

      const id =
        String(
          order.clientOrderId
        );


      if (
        !this.engine ||
        typeof this.engine.activeTrades !== 'function'
      ) {
        return;
      }


      const tr =
        this.engine
          .activeTrades()
          .find(
            t =>
              t.id === id
          );


      if (!tr) {
        return;
      }


      this.posToTrade.set(
        String(pos.positionId),
        id
      );


      const fill =
        deal &&
        deal.executionPrice != null
          ? Number(
              deal.executionPrice
            )
          : (
              order.executionPrice != null
                ? Number(
                    order.executionPrice
                  )
                : null
            );


      const r =
        this.engine.execAck({
          id,

          positionId:
            String(
              pos.positionId
            ),

          fillPrice:
            fill
        });


      if (
        r &&
        r.closeOnSlippage
      ) {

        this.closePosition(
          String(
            pos.positionId
          )
        ).catch(
          () => {}
        );

      } else if (
        pos.stopLoss == null ||
        pos.takeProfit == null
      ) {

        this._amend(
          pos.positionId,
          tr
        ).catch(
          e =>
            this.log(
              'amend',
              e && e.message
            )
        );
      }

      return;
    }


    if (
      isEt(
        et,
        E.ORDER_REJECTED
      ) &&
      order &&
      order.clientOrderId
    ) {

      this.engine.execFail({
        id:
          String(
            order.clientOrderId
          ),

        reason:
          'ORDER_REJECTED' +
          (
            p.errorCode
              ? ' : ' +
                p.errorCode
              : ''
          )
      });
    }
  }


  // =========================================================
  // ORDERS
  // =========================================================

  _grid(spec, x) {

    const step =
      Math.pow(
        10,
        Math.max(
          0,
          5 - spec.digits
        )
      );


    return Math.max(
      step,

      Math.round(
        Math.round(
          Math.abs(x) * P5
        ) / step
      ) * step
    );
  }


  _volume(spec, lots) {

    let v =
      Math.round(
        lots * spec.lotSize
      );


    if (
      spec.stepVolume > 0
    ) {

      v =
        Math.round(
          v /
          spec.stepVolume
        ) *
        spec.stepVolume;
    }


    if (
      v < spec.minVolume ||

      (
        spec.maxVolume > 0 &&
        v > spec.maxVolume
      )
    ) {

      throw Object.assign(
        new Error(
          `volume ${v} hors limites broker [${spec.minVolume}, ${spec.maxVolume}]`
        ),
        {
          code:
            'BAD_VOLUME'
        }
      );
    }


    return v;
  }


  async placeOrder(o) {

    try {

      const spec =
        this.specs[
          norm(o.symbol)
        ];


      if (!spec) {

        throw Object.assign(
          new Error(
            'symbole indisponible chez ce broker'
          ),
          {
            code:
              'UNKNOWN_SYMBOL'
          }
        );
      }


      if (
        spec.tradingMode &&
        !(
          spec.tradingMode === 0 ||
          spec.tradingMode ===
            'ENABLED'
        )
      ) {

        throw Object.assign(
          new Error(
            'trading désactivé sur ce symbole'
          ),
          {
            code:
              'TRADING_DISABLED'
          }
        );
      }


      const buy =
        o.action === 'BUY';


      const payload = {

        ctidTraderAccountId:
          this.accountId,

        symbolId:
          spec.symbolId,

        orderType:
          1,

        tradeSide:
          buy
            ? 1
            : 2,

        volume:
          this._volume(
            spec,
            o.lots
          ),

        relativeStopLoss:
          this._grid(
            spec,
            o.entryRef - o.sl
          ),

        relativeTakeProfit:
          this._grid(
            spec,
            o.tp - o.entryRef
          ),

        clientOrderId:
          String(o.id)
            .slice(0, 50),

        label:
          'ARES',

        comment:
          String(
            o.comment || ''
          ).slice(0, 100)
      };


      await this.client.request(
        PT.NEW_ORDER_REQ,
        payload
      );

    } catch (e) {

      this.engine.execFail({
        id:
          o.id,

        reason:
          (
            e &&
            e.code
              ? e.code + ' : '
              : ''
          ) +
          (
            e &&
            e.message
              ? e.message
              : String(e)
          )
      });
    }
  }


  async _amend(positionId, t) {

    return this.client.request(
      PT.AMEND_POSITION_SLTP_REQ,
      {
        ctidTraderAccountId:
          this.accountId,

        positionId:
          Number(positionId),

        stopLoss:
          t.sl,

        takeProfit:
          t.tp
      }
    );
  }


  async modifyPosition(
    positionId,
    { sl, tp }
  ) {

    const body = {

      ctidTraderAccountId:
        this.accountId,

      positionId:
        Number(positionId)
    };


    if (sl != null) {
      body.stopLoss =
        Number(sl);
    }


    if (tp != null) {
      body.takeProfit =
        Number(tp);
    }


    return this.client.request(
      PT.AMEND_POSITION_SLTP_REQ,
      body
    );
  }


  async closePosition(
    positionId
  ) {

    const p =
      this.positions.get(
        String(positionId)
      );


    if (!p) {

      throw new Error(
        'position inconnue ou déjà fermée'
      );
    }


    return this.client.request(
      PT.CLOSE_POSITION_REQ,
      {
        ctidTraderAccountId:
          this.accountId,

        positionId:
          Number(positionId),

        volume:
          p.volume
      }
    );
  }


  async closeAll(reason) {

    const done = [];


    if (
      !this.engine ||
      typeof this.engine.activeTrades !== 'function'
    ) {

      return done;
    }


    for (
      const t of
      this.engine.activeTrades()
    ) {

      if (
        !t.ticket ||
        !this.positions.has(
          String(t.ticket)
        )
      ) {
        continue;
      }


      try {

        await this.closePosition(
          t.ticket
        );

        done.push(
          t.id
        );

      } catch (e) {

        this.log(
          'closeAll',
          t.id,
          e && e.message
        );
      }
    }


    this.log(
      'clôture de toutes les positions :',
      reason || '',
      done.length
    );


    return done;
  }


  async _orderLoop() {

    if (
      this.status !==
      'CONNECTED'
    ) {
      return;
    }


    if (
      this.engine &&
      typeof this.engine.execNext === 'function'
    ) {

      for (
        let i = 0;
        i < 6;
        i++
      ) {

        const o =
          this.engine.execNext();

        if (!o) {
          break;
        }

        await this.placeOrder(o);
      }
    }


    const date =
      new Date(
        this.now()
      )
        .toISOString()
        .slice(0, 10);


    if (
      this.engine &&
      typeof this.engine.sessionCloseDue === 'function' &&
      this.engine.sessionCloseDue() &&
      this.closedDay !== date &&
      typeof this.engine.activeTrades === 'function' &&
      this.engine.activeTrades().length
    ) {

      this.closedDay =
        date;

      await this.closeAll(
        'fin de session'
      );
    }
  }


  async preTrade(order) {

    if (
      this.status !==
      'CONNECTED'
    ) {

      return {
        ok: false,
        reason:
          'cTrader non connecté'
      };
    }


    const spec =
      this.specs[
        norm(order.symbol)
      ];


    if (!spec) {

      return {
        ok: false,
        reason:
          'symbole indisponible chez ce broker'
      };
    }


    let vol;


    try {

      vol =
        this._volume(
          spec,
          order.legs
            ? order.legs[0].lots
            : order.lots
        );

    } catch (e) {

      return {
        ok: false,
        reason:
          e.message
      };
    }


    const legs =
      order.legs
        ? order.legs.length
        : 1;


    const r =
      await this.client.request(
        PT.EXPECTED_MARGIN_REQ,
        {
          ctidTraderAccountId:
            this.accountId,

          symbolId:
            spec.symbolId,

          volume:
            [vol]
        }
      );


    const row =
      (
        r.payload.margin ||
        []
      )[0];


    if (!row) {

      return {
        ok: false,
        reason:
          'marge attendue indisponible'
      };
    }


    const md =
      r.payload.moneyDigits != null
        ? Number(
            r.payload.moneyDigits
          )
        : this.moneyDigits;


    const need =
      Number(
        order.action === 'BUY'
          ? row.buyMargin
          : row.sellMargin
      ) /
      Math.pow(10, md) *
      legs;


    if (
      this.freeMargin == null
    ) {

      return {
        ok: false,
        reason:
          'marge libre inconnue'
      };
    }


    if (
      need * 1.2 >
      this.freeMargin
    ) {

      return {
        ok: false,

        reason:
          `marge insuffisante : requise ≈ ${need.toFixed(2)} (+20 %), libre ${this.freeMargin.toFixed(2)}`
      };
    }


    return {
      ok: true,

      detail:
        `requise ${need.toFixed(2)}, libre ${this.freeMargin.toFixed(2)}`
    };
  }
}


module.exports = {
  CTraderSession
};
