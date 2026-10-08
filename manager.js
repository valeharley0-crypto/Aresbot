'use strict';

/**
 * ARES — cTrader Manager
 * 1 utilisateur = 1 moteur IA (engine.js) + 1 session cTrader (execution.js).
 *
 * API utilisée par index.js / server.js :
 *   get(userId) · engine(userId) · session(userId) · sessionStatus(userId)
 *   tokens · oauth · users()
 *   startAll() · stopAll() · tickAll()
 *   handleCallback(code, state, fallbackUser) · disconnect(userId) · reconnect(userId)
 *   emergencyStop(userId, reason) · emergencyStopAll(reason) · closeAll(userId, reason)
 *   broadcastNews(events) · heartbeatNews(at) · overview()
 */

const path = require('path');

/**
 * Charge le moteur IA. Le fichier du dépôt s'appelle engine.js ; « moteur.js » est accepté en repli
 * UNIQUEMENT si engine.js est introuvable (une vraie erreur dans engine.js n'est jamais masquée).
 */
function loadEngineModule() {
  try {
    return require('../engine');
  } catch (e) {
    const missing = e && e.code === 'MODULE_NOT_FOUND' && /['"]\.\.\/engine['"]/.test(String(e.message));
    if (!missing) throw e;
  }
  return require('../moteur');
}

const { createEngine } = loadEngineModule();
const { CTraderSession } = require('./execution');
const { createTokenStore, USER_RE } = require('./token-store');
const { createOAuth } = require('./oauth');

function createManager(opts = {}) {
  const dataRoot = opts.dataRoot || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const tokens = opts.tokens || createTokenStore({ dir: dataRoot });
  const oauth = opts.oauth || createOAuth(opts.oauthOpts || {});
  const clientId = opts.clientId || process.env.CTRADER_CLIENT_ID;
  const clientSecret = opts.clientSecret || process.env.CTRADER_CLIENT_SECRET;
  const log = opts.log || ((...args) => console.log(...args));
  const users = new Map();

  function validUser(userId) {
    const u = String(userId || '');
    if (!USER_RE.test(u)) throw new Error('userId invalide');
    return u;
  }

  function get(userId) {
    const u = validUser(userId);
    if (users.has(u)) return users.get(u);

    const rec = { engine: null, session: null };

    // Le moteur est créé AVANT la session ; preTrade est relié à la session cTrader une fois celle-ci créée.
    rec.engine = createEngine({
      dataDir: path.join(dataRoot, 'users', u),
      userId: u,
      now: opts.now,
      fetch: opts.fetch,
      orderFlow: opts.orderFlow,
      preTrade: async order => {
        if (!rec.session) return { ok: false, reason: 'cTrader session indisponible' };
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

  const engine = userId => get(userId).engine;
  const session = userId => get(userId).session;

  const manager = {
    get,
    engine,
    session,
    tokens,
    oauth,

    users: () => [...users.keys()],

    sessionStatus(userId) {
      return session(userId).publicStatus();
    },

    /** Redémarre les sessions déjà autorisées (tokens présents). */
    async startAll() {
      for (const userId of tokens.users()) {
        try {
          await get(userId).session.start();
        } catch (e) {
          log('[ctrader] start', userId, e && e.message);
        }
      }
    },

    /** Arrête toutes les sessions cTrader (arrêt propre du serveur). */
    async stopAll() {
      for (const rec of users.values()) {
        try { await rec.session.stop(); } catch (e) { /* ignore */ }
      }
    },

    /** OAuth callback : code + state -> token chiffré -> session cTrader. */
    async handleCallback(code, state, fallbackUser) {
      if (!code) throw new Error('code OAuth manquant');

      let userId = oauth.consumeState(state);

      // Repli mono-utilisateur : uniquement si cTrader ne renvoie pas « state » ET si explicitement activé (1 ou true).
      const fb = process.env.CTRADER_SINGLE_USER_FALLBACK;
      if (!userId && !state && fallbackUser && (fb === '1' || fb === 'true')) {
        userId = validUser(fallbackUser);
      }
      if (!userId) throw new Error('état OAuth invalide ou expiré : relancer « Connect cTrader »');

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
        log('[ctrader] session après OAuth', userId, e && e.message);
      }
      return userId;
    },

    async reconnect(userId) {
      const u = validUser(userId);
      await session(u).stop();
      await session(u).start();
      return session(u).publicStatus();
    },

    async disconnect(userId) {
      const u = validUser(userId);
      await session(u).stop();
      tokens.delete(u);
      return { ok: true, userId: u };
    },

    async tickAll() {
      await Promise.all(
        [...users.values()].map(rec =>
          rec.engine.tick().catch(e => {
            console.error('[mentor] tick', rec.engine.userId, e && e.message);
          })
        )
      );
    },

    /** Calendrier économique réel -> tous les moteurs. */
    broadcastNews(events) {
      const list = Array.isArray(events) ? events : [];
      for (const rec of users.values()) {
        try { rec.engine.setNews(list); } catch (e) { log('[news] setNews', rec.engine.userId, e && e.message); }
      }
      return { ok: true, count: list.length };
    },

    /** Le flux calendrier a répondu à l'instant « at » (ms) : la donnée news n'est pas périmée. */
    heartbeatNews(at) {
      for (const rec of users.values()) {
        try { rec.engine.newsFeedHeartbeat(at); } catch (e) { log('[news] heartbeat', rec.engine.userId, e && e.message); }
      }
    },

    /** Ferme toutes les positions ARES ouvertes de l'utilisateur (sans toucher aux réglages du moteur). */
    async closeAll(userId, reason) {
      const rec = get(userId);
      const status = rec.session.publicStatus();
      if (!status || status.status !== 'CONNECTED') {
        return { ok: false, error: 'cTrader non connecté', status: status && status.status };
      }
      const closed = await rec.session.closeAll(reason || 'fermeture demandée');
      return { ok: true, closed };
    },

    async emergencyStop(userId, reason) {
      const rec = get(userId);
      const result = rec.engine.emergencyStop(reason);
      try {
        const status = rec.session.publicStatus();
        if (status && (status.status === 'CONNECTED' || status.connected === true)) {
          result.closed = await rec.session.closeAll('emergency stop');
        }
      } catch (e) {
        result.closeError = String(e && e.message);
      }
      return result;
    },

    async emergencyStopAll(reason) {
      const out = {};
      for (const userId of users.keys()) {
        out[userId] = await this.emergencyStop(userId, reason);
      }
      return out;
    },

    overview() {
      return [...users.entries()].map(([userId, rec]) => {
        const mentor = rec.engine.status();
        return {
          userId,
          cTrader: rec.session.publicStatus(),
          mentor: mentor.status,
          tradingMode: mentor.tradingMode,
          autoTrade: mentor.autoTrade,
          openPositions: mentor.openPositions,
          dailyPL: mentor.dailyPL,
          balance: mentor.balance,
          equity: mentor.equity,
          errors: rec.engine
            .logs(200)
            .filter(l => /ERROR|EXEC_ERROR|SLIPPAGE/.test(String(l.decision || l.status || '')))
            .slice(-3)
            .map(l => ({ at: l.timestamp, reason: l.reason }))
        };
      });
    }
  };

  return manager;
}

module.exports = { createManager };
