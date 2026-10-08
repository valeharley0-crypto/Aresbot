'use strict';
/**

- Client cTrader Open API — JSON sur WebSocket (port 5036), messages { clientMsgId, payloadType, payload }.
- payloadType vérifiés sur le schéma officiel (OpenApiModelMessages.proto) : voir PT ci-dessous.
- Hôtes : demo.ctraderapi.com / live.ctraderapi.com. Un compte « live » doit être autorisé sur l'hôte live.
  */
  const EventEmitter = require('events');

const PT = {
HEARTBEAT: 51,
APP_AUTH_REQ: 2100, APP_AUTH_RES: 2101, ACCOUNT_AUTH_REQ: 2102, ACCOUNT_AUTH_RES: 2103,
NEW_ORDER_REQ: 2106, AMEND_POSITION_SLTP_REQ: 2110, CLOSE_POSITION_REQ: 2111,
SYMBOLS_LIST_REQ: 2114, SYMBOLS_LIST_RES: 2115, SYMBOL_BY_ID_REQ: 2116, SYMBOL_BY_ID_RES: 2117,
TRADER_REQ: 2121, TRADER_RES: 2122, RECONCILE_REQ: 2124, RECONCILE_RES: 2125, EXECUTION_EVENT: 2126,
SUBSCRIBE_SPOTS_REQ: 2127, SUBSCRIBE_SPOTS_RES: 2128, SPOT_EVENT: 2131, ORDER_ERROR_EVENT: 2132,
GET_TRENDBARS_REQ: 2137, GET_TRENDBARS_RES: 2138, EXPECTED_MARGIN_REQ: 2139, EXPECTED_MARGIN_RES: 2140, MARGIN_CHANGED_EVENT: 2141,
ERROR_RES: 2142, TOKEN_INVALIDATED_EVENT: 2147, CLIENT_DISCONNECT_EVENT: 2148,
ACCOUNTS_BY_TOKEN_REQ: 2149, ACCOUNTS_BY_TOKEN_RES: 2150, ACCOUNT_DISCONNECT_EVENT: 2164,
UNREALIZED_PNL_REQ: 2187, UNREALIZED_PNL_RES: 2188
};
const HOSTS = { demo: 'demo.ctraderapi.com', live: 'live.ctraderapi.com' };
const PERIOD = { 1: 1, 5: 5, 15: 7, 30: 8 };   // minutes -> ProtoOATrendbarPeriod (M1=1, M5=5, M15=7, M30=8)

class CTraderClient extends EventEmitter {
constructor({ env = 'demo', port = 5036, clientId, clientSecret, WebSocketImpl, heartbeatMs = 10000, timeoutMs = 15000 } = {}) {
super();
this.host = HOSTS[env] || HOSTS.demo; this.port = port; this.env = env;
this.clientId = clientId; this.clientSecret = clientSecret;
this.WS = WebSocketImpl || (() => { try { return require('ws'); } catch (e) { return typeof WebSocket !== 'undefined' ? WebSocket : null; } })();
this.heartbeatMs = heartbeatMs; this.timeoutMs = timeoutMs;
this.ws = null; this.seq = 0; this.pending = new Map(); this.hb = null; this.ready = false; this.closing = false;
}
url() { return wss://${this.host}:${this.port}; }
async connect() {
if (!this.WS) throw new Error('WebSocket indisponible : installer le paquet "ws" (npm i ws)');
if (!this.clientId || !this.clientSecret) throw new Error('CTRADER_CLIENT_ID / CTRADER_CLIENT_SECRET manquants');
this.closing = false;
await new Promise((resolve, reject) => {
const ws = new this.WS(this.url());
this.ws = ws;
const to = setTimeout(() => { try { ws.close(); } catch (e) { /* ignore / } reject(new Error('connexion cTrader : délai dépassé')); }, this.timeoutMs);
const on = (ev, fn) => (ws.addEventListener ? ws.addEventListener(ev, fn) : ws.on(ev, fn));
on('open', () => { clearTimeout(to); resolve(); });
on('error', e => { clearTimeout(to); this.emit('error_', e); reject(new Error('connexion cTrader : ' + ((e && e.message) || 'erreur'))); });
on('close', () => { this.ready = false; this._stopHb(); this._failAll(new Error('connexion cTrader fermée')); if (!this.closing) this.emit('disconnected'); });
on('message', m => this._onMessage(m && m.data !== undefined ? m.data : m));
});
this._startHb();
await this.request(PT.APP_AUTH_REQ, { clientId: this.clientId, clientSecret: this.clientSecret });
this.ready = true;
}
_startHb() { this._stopHb(); this.hb = setInterval(() => this._raw({ payloadType: PT.HEARTBEAT, payload: {} }), this.heartbeatMs); if (this.hb.unref) this.hb.unref(); }
_stopHb() { if (this.hb) clearInterval(this.hb); this.hb = null; }
_raw(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); else throw new Error('connexion cTrader fermée'); }
_failAll(err) { for (const [, p] of this.pending) { clearTimeout(p.t); p.reject(err); } this.pending.clear(); }
_onMessage(raw) {
let m; try { m = JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { return; }
if (!m || m.payloadType === PT.HEARTBEAT) return;
const p = m.clientMsgId ? this.pending.get(m.clientMsgId) : null;
if (p) {
this.pending.delete(m.clientMsgId); clearTimeout(p.t);
if (m.payloadType === PT.ERROR_RES) { const e = new Error((m.payload && (m.payload.description || m.payload.errorCode)) || 'erreur cTrader'); e.code = m.payload && m.payload.errorCode; e.payload = m.payload; return p.reject(e); }
if (m.payloadType === PT.ORDER_ERROR_EVENT) { const e = new Error((m.payload && (m.payload.description || m.payload.errorCode)) || 'ordre refusé'); e.code = m.payload && m.payload.errorCode; e.payload = m.payload; return p.reject(e); }
if (m.payloadType === PT.EXECUTION_EVENT) this.emit('message', m);   // la réponse à un ordre EST un ExecutionEvent : il doit aussi être traité
return p.resolve(m);
}
this.emit('message', m);   // événements spontanés (spots, exécutions, marge, déconnexions...)
}
/* Envoie une requête et attend la réponse portant le même clientMsgId. Une erreur cTrader rejette avec e.code. /
request(payloadType, payload = {}) {
return new Promise((resolve, reject) => {
const id = 'a' + (++this.seq) + '_' + Date.now().toString(36);
const t = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('cTrader : délai de réponse dépassé (' + payloadType + ')'), { code: 'TIMEOUT' })); }, this.timeoutMs);
this.pending.set(id, { resolve, reject, t });
try { this._raw({ clientMsgId: id, payloadType, payload }); } catch (e) { clearTimeout(t); this.pending.delete(id); reject(e); }
});
}
async close() { this.closing = true; this._stopHb(); this._failAll(new Error('fermé')); try { if (this.ws) this.ws.close(); } catch (e) { / ignore */ } this.ready = false; }
}
module.exports = { CTraderClient, PT, PERIOD, HOSTS };
