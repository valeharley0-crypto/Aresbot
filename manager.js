'use strict';
/**
 * ARES — Gestionnaire multi-utilisateurs : 1 utilisateur = 1 moteur IA (config, risque, journal, état isolés)
 *                                                          + 1 session cTrader (son propre compte, ses propres tokens).
 * Les données d'un utilisateur ne sont jamais partagées avec un autre : dossier, moteur, session et tokens sont indexés par userId.
 */
const path = require('path');
const { createEngine } = require('../engine');
const { CTraderSession } = require('./execution');
const { createTokenStore, USER_RE } = require('./token-store');
const { createOAuth } = require('./oauth');

function createManager(opts = {}) {
  const dataRoot = opts.dataRoot || process.env.DATA_DIR || path.join(process.cwd(), 'data');
  const tokens = opts.tokens || createTokenStore({ dir: dataRoot });
  const oauth = opts.oauth || createOAuth(opts.oauthOpts || {});
  const clientId = opts.clientId || process.env.CTRADER_CLIENT_ID, clientSecret = opts.clientSecret || process.env.CTRADER_CLIENT_SECRET;
  const users = new Map();   // userId -> { engine, session }
  const log = opts.log || ((...a) => console.log(...a));
  const ok = u => { if (!USER_RE.test(String(u))) throw new Error('userId invalide'); return String(u); };

  function get(userId) {
    const u = ok(userId);
    if (users.has(u)) return users.get(u);
    const rec = { engine: null, session: null };
    rec.engine = createEngine({ dataDir: path.join(dataRoot, 'users', u), userId: u, now: opts.now, fetch: opts.fetch, orderFlow: opts.orderFlow, preTrade: o => rec.session.preTrade(o) });
    rec.session = new CTraderSession({ userId: u, engine: rec.engine, oauth, tokens, clientId, clientSecret, WebSocketImpl: opts.WebSocketImpl, now: opts.now, log });
    users.set(u, rec);
    return rec;
  }
  const engine = u => get(u).engine;
  const session = u => get(u).session;
  return {
    get, engine, session, tokens, oauth, users: () => [...users.keys()],
    sessionStatus: u => session(u).publicStatus(),
    /** Redémarre les sessions des utilisateurs déjà autorisés (au démarrage du serveur). */
    async startAll() { for (const u of tokens.users()) { try { await get(u).session.start(); } catch (e) { log('[ctrader] start', u, e && e.message); } } },
    /** Retour OAuth : code + state -> tokens chiffrés -> session. */
    async handleCallback(code, state, fallbackUser) {
      let userId = oauth.consumeState(state);
      if (!userId && !state && fallbackUser) userId = fallbackUser;   // uniquement si CTRADER_SINGLE_USER_FALLBACK est défini
      if (!userId) throw new Error('état OAuth invalide ou expiré : relancer « Connect cTrader »');
      const t = await oauth.exchangeCode(code);
      tokens.set(userId, { accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt, accountId: null, isLive: null });   // nouvelle autorisation : le compte est (re)choisi
      await session(userId).stop();
      session(userId).start().catch(() => {});
      return userId;
    },
    async disconnect(userId) { await session(userId).stop(); tokens.delete(ok(userId)); return { ok: true }; },
    async tickAll() { await Promise.all([...users.values()].map(r => r.engine.tick().catch(e => console.error('[mentor] tick', r.engine.userId, e && e.message)))); },
    broadcastNews(events) { for (const r of users.values()) { r.engine.setNews(events); } },
    heartbeatNews(at) { for (const r of users.values()) r.engine.newsFeedHeartbeat(at); },
    async emergencyStop(userId, reason) {
      const r = get(userId), res = r.engine.emergencyStop(reason);
      try { if (r.session.status === 'CONNECTED') res.closed = await r.session.closeAll('emergency stop'); } catch (e) { res.closeError = String(e && e.message); }
      return res;
    },
    async emergencyStopAll(reason) { const out = {}; for (const u of users.keys()) out[u] = await this.emergencyStop(u, reason); return out; },
    overview() {
      return [...users.entries()].map(([u, r]) => { const s = r.engine.status(); return { userId: u, cTrader: r.session.publicStatus(), mentor: s.status, tradingMode: s.tradingMode, autoTrade: s.autoTrade, openPositions: s.openPositions, dailyPL: s.dailyPL, balance: s.balance, equity: s.equity, errors: r.engine.logs(200).filter(l => /ERROR|EXEC_ERROR|SLIPPAGE/.test(l.decision)).slice(-3).map(l => ({ at: l.timestamp, reason: l.reason })) }; });
    }
  };
}
module.exports = { createManager };
