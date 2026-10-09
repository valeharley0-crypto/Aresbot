'use strict';

/**

* ARES — cTrader Manager
* 
* Gère une session cTrader par utilisateur.
* Compatible avec IA Mentor :
* OAuth
* Token Store
* CTraderSession
* IA Mentor Engine
* Trading mode
* Emergency stop
* News broadcast
* Tick loop
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

this.logf =
  typeof log === 'function'
    ? log
    : console.log;

this.oauth =
  new CTraderOAuth({
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

* =========================================================
* ENGINE
* =========================================================
  */

engine(userId = 'owner') {

return this._getSession(
  userId
).engine;

}

/*

* Compatibilité IA Mentor :
* index.js appelle manager.get(...)
  */
  get(userId = 'owner') {

return this.engine(userId);

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

* =========================================================
* SESSION
* =========================================================
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

* Compatibilité avec les routes IA Mentor
  */
  sessionStatus(userId = 'owner') {

const id =
  String(userId || 'owner');

const session =
  this.sessions.get(id);

if (!session) {

  const token =
    this.tokens.get(id);

  return {
    status:
      token && token.accessToken
        ? 'AUTHORIZED'
        : 'DISCONNECTED',

    message:
      token && token.accessToken
        ? 'cTrader autorisé'
        : 'cTrader non connecté',

    accountId:
      token && token.accountId
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

if (
  typeof session.publicStatus ===
  'function'
) {
  return session.publicStatus();
}

return {
  status:
    session.status ||
    'DISCONNECTED',

  message:
    session.message ||
    '',

  accountId:
    session.accountId || null,

  isLive:
    !!session.isLive,

  accounts:
    session.accounts || []
};

}

/*

* =========================================================
* OAUTH
* =========================================================
  */

oauthState(userId = 'owner') {

const id = String(userId || 'owner');
const key = String(process.env.TOKEN_ENCRYPTION_KEY || process.env.CTRADER_CLIENT_SECRET || 'ares');
const body = Buffer.from(JSON.stringify({ u: id, t: Date.now(), r: crypto.randomBytes(8).toString('hex') })).toString('base64url');
const sig = crypto.createHmac('sha256', key).update(body).digest('base64url');
const state = body + '.' + sig;

this.oauthStates.set(state, { userId: id, createdAt: Date.now() });
this._cleanupStates();

return state;

}

/* Vérifie un state signé (valable 15 min) même après un redémarrage du serveur */
_verifySignedState(state) {
try {
  const [body, sig] = String(state).split('.');
  if (!body || !sig) return null;
  const key = String(process.env.TOKEN_ENCRYPTION_KEY || process.env.CTRADER_CLIENT_SECRET || 'ares');
  const good = crypto.createHmac('sha256', key).update(body).digest('base64url');
  if (good.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
  const d = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!d || !d.u || Date.now() - Number(d.t) > 15 * 60 * 1000) return null;
  return { userId: String(d.u) };
} catch (_) { return null; }
}

buildAuthUrl(userId = 'owner') {

const state =
  this.oauthState(userId);

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
    now - data.createdAt > maxAge
  ) {
    this.oauthStates.delete(
      state
    );
  }
}

}

async handleCallback(
code,
state,
fallbackUserId = null
) {

if (!code) {
  throw new Error(
    'code OAuth manquant'
  );
}

let saved =
  this.oauthStates.get(
    String(state)
  );

/*
 * Fallback single-user uniquement
 * s'il est explicitement demandé.
 */
if (
  !saved &&
  fallbackUserId
) {
  saved = {
    userId:
      String(fallbackUserId)
  };
}

if (!saved && state) {
  saved = this._verifySignedState(state);
}

/*
 * cTrader peut renvoyer seulement ?code=... sans « state » (cf. doc Spotware).
 * Dans ce cas : on rattache le code à la demande de connexion la plus récente
 * (valable 10 min), uniquement s'il n'y a qu'un seul utilisateur en attente.
 */
if (!saved && !state) {
  this._cleanupStates();
  const users = new Set();
  let last = null;
  for (const [k, d] of this.oauthStates) {
    users.add(d.userId);
    if (!last || d.createdAt > last.d.createdAt) last = { k, d };
  }
  if (users.size === 1 && last) {
    saved = last.d;
    state = last.k;
  }
}

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
  this._getSession(userId);

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

* =========================================================
* CONNECT
* =========================================================
  */

async connect(userId = 'owner') {

const session =
  this._getSession(userId);

await session.start();

return session.publicStatus();

}

async reconnect(
userId = 'owner'
) {

const session =
  this._getSession(userId);

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

* =========================================================
* ACCOUNT
* =========================================================
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
  this._getSession(userId);

return session.selectAccount(
  accountId
);

}

/*

* =========================================================
* STATUS
* =========================================================
  */

status(userId = 'owner') {

return this.sessionStatus(
  userId
);

}

/*

* =========================================================
* TOKEN
* =========================================================
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

* =========================================================
* EMERGENCY STOP
* =========================================================
  */

async emergencyStop(
userId = 'owner',
reason = 'arrêt d’urgence'
) {

const id =
  String(userId || 'owner');

const engine =
  this.engine(id);

const results = [];

try {

  if (
    engine &&
    typeof engine.setAutoTrade ===
    'function'
  ) {
    engine.setAutoTrade(false);
  }

  if (
    engine &&
    typeof engine.setBlock ===
    'function'
  ) {
    engine.setBlock(reason);
  }

  const session =
    this.sessions.get(id);

  if (
    session &&
    typeof session.closeAll ===
    'function'
  ) {
    await session.closeAll();
  }

  if (
    session &&
    typeof session.emergencyStop ===
    'function'
  ) {
    await session.emergencyStop(
      reason
    );
  }

  results.push({
    userId: id,
    ok: true,
    reason
  });

} catch (error) {

  results.push({
    userId: id,
    ok: false,
    error:
      error && error.message
        ? error.message
        : String(error)
  });
}

return {
  ok:
    results.every(x => x.ok),

  userId: id,

  reason,

  results
};

}

async emergencyStopAll(
reason = 'arrêt d’urgence administrateur'
) {

const users =
  Array.from(
    this.sessions.keys()
  );

/*
 * Le owner existe toujours côté IA
 * même si aucune session cTrader n'est
 * encore connectée.
 */
if (!users.includes('owner')) {
  users.push('owner');
}

const results = [];

for (const userId of users) {

  results.push(
    await this.emergencyStop(
      userId,
      reason
    )
  );
}

return results;

}

/*

* =========================================================
* NEWS
* =========================================================
  */

heartbeatNews(at) {
  for (const [userId, session] of this.sessions) {
    try {
      const e = session && session.engine;
      if (e && typeof e.newsFeedHeartbeat === 'function') e.newsFeedHeartbeat(at);
    } catch (error) {
      this.log('news heartbeat error', userId, error && error.message);
    }
  }
  return { ok: true };
}

async closeAll(userId = 'owner', reason = 'demande utilisateur') {
  const id = String(userId || 'owner');
  const session = this.sessions.get(id);
  if (!session || typeof session.closeAll !== 'function') {
    return { ok: false, error: 'aucune session cTrader' };
  }
  await session.closeAll(reason);
  return { ok: true };
}

broadcastNews(events) {

const list =
  Array.isArray(events)
    ? events
    : [];

for (
  const [
    userId,
    session
  ] of this.sessions
) {

  try {

    const engine =
      session.engine;

    if (engine && typeof engine.setNews === 'function') {
      engine.setNews(list);
      continue;
    }

    if (
      engine &&
      typeof engine.setNewsEvents ===
      'function'
    ) {
      engine.setNewsEvents(
        list
      );
      continue;
    }

    if (
      engine &&
      typeof engine.updateNews ===
      'function'
    ) {
      engine.updateNews(
        list
      );
      continue;
    }

    if (
      engine &&
      typeof engine.pushNews ===
      'function'
    ) {
      for (
        const event
        of list
      ) {
        engine.pushNews(
          event
        );
      }
    }

  } catch (error) {

    this.log(
      'news broadcast error',
      userId,
      error && error.message
    );
  }
}

return {
  ok: true,
  count: list.length
};

}

/*

* =========================================================
* TICK
* =========================================================
  */

async tickAll() {

const results = [];

for (
  const [
    userId,
    session
  ] of this.sessions
) {

  try {

    let result = null;

    if (
      session &&
      typeof session.tick ===
      'function'
    ) {
      result =
        await session.tick();
    }

    else if (
      session &&
      session.engine &&
      typeof session.engine.tick ===
      'function'
    ) {
      result =
        await session.engine.tick();
    }

    else if (
      session &&
      session.engine &&
      typeof session.engine.update ===
      'function'
    ) {
      result =
        await session.engine.update();
    }

    results.push({
      userId,
      ok: true,
      result
    });

  } catch (error) {

    results.push({
      userId,
      ok: false,
      error:
        error && error.message
          ? error.message
          : String(error)
    });
  }
}

return results;

}

/*

* =========================================================
* START / STOP ALL
* =========================================================
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
        error && error.message
          ? error.message
          : String(error)
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

* =========================================================
* ADMIN / DEBUG
* =========================================================
  */

overview() {

const users = [];

for (
  const [
    userId,
    session
  ] of this.sessions
) {

  const token =
    this.tokens.get(userId);

  users.push({
    userId,

    status:
      session.status ||
      'DISCONNECTED',

    accountId:
      session.accountId
        ? String(session.accountId)
        : (
            token &&
            token.accountId
              ? String(token.accountId)
              : null
          ),

    isLive:
      !!(
        token &&
        token.isLive
      ),

    positions:
      session.positions &&
      typeof session.positions.size ===
      'number'
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
    typeof this.tokens.count ===
    'function'
      ? this.tokens.count()
      : 0
};

}
}

/*

* =========================================================
* FACTORY
* =========================================================
  */

function createManager(opts = {}) {

if (!opts.engineFactory) {

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
      return new EngineModule.Engine({
        userId
      });
    }

    if (
      EngineModule.default &&
      typeof EngineModule.default ===
      'function'
    ) {
      return new EngineModule.default(
        userId
      );
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
