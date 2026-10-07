'use strict';

/**
 * ARES — cTrader Manager
 * 1 user = 1 engine + 1 cTrader session
 */

const path = require('path');

const { createEngine } = require('../moteur');
const { CTraderSession } = require('./execution');
const { createTokenStore, USER_RE } = require('./token-store');
const { createOAuth } = require('./oauth');

function createManager(opts = {}) {
  const dataRoot =
    opts.dataRoot ||
    process.env.DATA_DIR ||
    path.join(process.cwd(), 'data');

  const tokens =
    opts.tokens ||
    createTokenStore({ dir: dataRoot });

  const oauth =
    opts.oauth ||
    createOAuth(opts.oauthOpts || {});

  const clientId =
    opts.clientId || process.env.CTRADER_CLIENT_ID;

  const clientSecret =
    opts.clientSecret || process.env.CTRADER_CLIENT_SECRET;

  const log =
    opts.log ||
    ((...args) => console.log(...args));

  const users = new Map();

  function validUser(userId) {
    const u = String(userId || '');

    if (!USER_RE.test(u)) {
      throw new Error('userId invalide');
    }

    return u;
  }

  function get(userId) {
    const u = validUser(userId);

    if (users.has(u)) {
      return users.get(u);
    }

    const rec = {
      engine: null,
      session: null
    };

    /*
     * Engine créé AVANT la session.
     * preTrade est relié à la session cTrader une fois celle-ci créée.
     */
    rec.engine = createEngine({
      dataDir: path.join(dataRoot, 'users', u),
      userId: u,
      now: opts.now,
      fetch: opts.fetch,
      orderFlow: opts.orderFlow,

      preTrade: async order => {
        if (!rec.session) {
          return {
            ok: false,
            reason: 'cTrader session indisponible'
          };
        }

        return rec.session.preTrade(order);
      }
    });

    rec.session = new CTraderSession({
      userId: u,
      engine: rec.engine,
      oauth,
      tokens,
      clientId,
      clientSecret,
      WebSocketImpl: opts.WebSocketImpl,
      now: opts.now,
      log
    });

    users.set(u, rec);

    return rec;
  }

  function engine(userId) {
    return get(userId).engine;
  }

  function session(userId) {
    return get(userId).session;
  }

  return {
    get,
    engine,
    session,

    tokens,
    oauth,

    users: () => [...users.keys()],

    sessionStatus(userId) {
      return session(userId).publicStatus();
    },

    /**
     * Redémarre les sessions déjà autorisées.
     */
    async startAll() {
      for (const userId of tokens.users()) {
        try {
          await get(userId).session.start();
        } catch (e) {
          log(
            '[ctrader] start',
            userId,
            e && e.message
          );
        }
      }
    },

    /**
     * OAuth callback :
     * code + state -> token chiffré -> session cTrader
     */
    async handleCallback(code, state, fallbackUser) {
      if (!code) {
        throw new Error('code OAuth manquant');
      }

      let userId = oauth.consumeState(state);

      /*
       * Fallback volontairement limité.
       */
      if (
        !userId &&
        !state &&
        fallbackUser &&
        process.env.CTRADER_SINGLE_USER_FALLBACK === 'true'
      ) {
        userId = validUser(fallbackUser);
      }

      if (!userId) {
        throw new Error(
          'état OAuth invalide ou expiré : relancer « Connect cTrader »'
        );
      }

      const token = await oauth.exchangeCode(code);

      tokens.set(userId, {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        accountId: null,
        isLive: null
      });

      await session(userId).stop();

      try {
        await session(userId).start();
      } catch (e) {
        log(
          '[ctrader] session après OAuth',
          userId,
          e && e.message
        );
      }

      return userId;
    },

    async disconnect(userId) {
      const u = validUser(userId);

      await session(u).stop();
      tokens.delete(u);

      return {
        ok: true,
        userId: u
      };
    },

    async tickAll() {
      await Promise.all(
        [...users.values()].map(rec =>
          rec.engine.tick().catch(e => {
            console.error(
              '[mentor] tick',
              rec.engine.userId,
              e && e.message
            );
          })
        )
      );
    },

    broadcastNews(events) {
      for (const rec of users.values()) {
        rec.engine.setNews(events);
      }
    },

    heartbeatNews(at) {
      for (const rec of users.values()) {
        rec.engine.newsFeedHeartbeat(at);
      }
    },

    async emergencyStop(userId, reason) {
      const rec = get(userId);

      const result =
        rec.engine.emergencyStop(reason);

      try {
        const status = rec.session.publicStatus();

        if (
          status &&
          (
            status.status === 'CONNECTED' ||
            status.connected === true
          )
        ) {
          result.closed =
            await rec.session.closeAll(
              'emergency stop'
            );
        }
      } catch (e) {
        result.closeError =
          String(e && e.message);
      }

      return result;
    },

    async emergencyStopAll(reason) {
      const out = {};

      for (const userId of users.keys()) {
        out[userId] =
          await this.emergencyStop(
            userId,
            reason
          );
      }

      return out;
    },

    overview() {
      return [...users.entries()].map(
        ([userId, rec]) => {
          const mentor =
            rec.engine.status();

          return {
            userId,

            cTrader:
              rec.session.publicStatus(),

            mentor: mentor.status,

            tradingMode:
              mentor.tradingMode,

            autoTrade:
              mentor.autoTrade,

            openPositions:
              mentor.openPositions,

            dailyPL:
              mentor.dailyPL,

            balance:
              mentor.balance,

            equity:
              mentor.equity,

            errors:
              rec.engine
                .logs(200)
                .filter(l =>
                  /ERROR|EXEC_ERROR|SLIPPAGE/
                    .test(
                      String(
                        l.decision ||
                        l.status ||
                        ''
                      )
                    )
                )
                .slice(-3)
                .map(l => ({
                  at: l.timestamp,
                  reason: l.reason
                }))
          };
        }
      );
    }
  };
}

module.exports = {
  createManager
};
