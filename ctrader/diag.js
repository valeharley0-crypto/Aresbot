'use strict';
/*
 * Diagnostic Spotware (support) — actif seulement si CTRADER_DIAG=1.
 * Journalise (UTC) les requêtes/réponses complètes : ProtoOAApplicationAuthReq (live + demo) avec clientMsgId,
 * et la requête REST /apps/token. Le client_secret n'est JAMAIS affiché (longueur + contrôle des caractères seulement).
 */
const crypto = require('crypto');
const https = require('https');
const TAG = '[ctrader-diag]';
const now = () => new Date().toISOString();
const log = (...a) => console.log(TAG, now(), ...a);

function describe(name, v) {
  const s = v == null ? '' : String(v);
  const bad = (s.match(/[^A-Za-z0-9_\-.~]/g) || []).map(c => 'U+' + c.codePointAt(0).toString(16));
  log(`${name}: longueur=${s.length} caractères_inattendus=${JSON.stringify(bad)}`);
}

function wsAuth(host, clientId, clientSecret) {
  return new Promise(resolve => {
    let WS; try { WS = require('ws'); } catch (e) { log(host, 'module ws absent'); return resolve(); }
    const url = `wss://${host}:5036`;
    const clientMsgId = crypto.randomUUID();
    const req = { clientMsgId, payloadType: 2100, payload: { clientId, clientSecret } };
    const shown = { clientMsgId, payloadType: 2100, payload: { clientId, clientSecret: `*** (${String(clientSecret).length} car.)` } };
    let done = false;
    const end = () => { if (!done) { done = true; try { ws.close(); } catch (_) {} resolve(); } };
    const ws = new WS(url);
    const timer = setTimeout(() => { log(host, 'TIMEOUT 15s sans réponse'); end(); }, 15000);
    ws.on('open', () => { log(host, 'WS ouvert', url); log(host, 'REQUEST', JSON.stringify(shown)); ws.send(JSON.stringify(req)); });
    ws.on('message', d => {
      const txt = String(d);
      let m = null; try { m = JSON.parse(txt); } catch (_) {}
      if (m && m.payloadType === 51) return;   // heartbeat
      log(host, 'RESPONSE', txt);
      clearTimeout(timer); end();
    });
    ws.on('error', e => { log(host, 'WS erreur', e && e.message); clearTimeout(timer); end(); });
    ws.on('close', c => { log(host, 'WS fermé', c); clearTimeout(timer); end(); });
  });
}

function rest(clientId, clientSecret) {
  return new Promise(resolve => {
    const q = `grant_type=refresh_token&refresh_token=diag-invalid&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
    const shown = q.replace(/client_secret=[^&]*/, `client_secret=*** (${String(clientSecret).length} car.)`);
    log('REST REQUEST', 'GET https://openapi.ctrader.com/apps/token?' + shown);
    const r = https.request('https://openapi.ctrader.com/apps/token?' + q, { method: 'GET', headers: { Accept: 'application/json', 'Content-Type': 'application/json' } }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { log('REST RESPONSE status=' + res.statusCode, 'headers=' + JSON.stringify(res.headers), 'body=' + b); resolve(); });
    });
    r.on('error', e => { log('REST erreur', e.message); resolve(); });
    r.setTimeout(15000, () => { log('REST TIMEOUT'); r.destroy(); resolve(); });
    r.end();
  });
}

async function run() {
  setTimeout(async () => {
    const clientId = process.env.CTRADER_CLIENT_ID;
    const clientSecret = process.env.CTRADER_CLIENT_SECRET;
    log('=== DIAGNOSTIC DÉMARRÉ ===');
    log('clientId (valeur exacte JSON):', JSON.stringify(clientId));
    describe('clientId', clientId); describe('clientSecret', clientSecret);
    await wsAuth('live.ctraderapi.com', clientId, clientSecret);
    await wsAuth('demo.ctraderapi.com', clientId, clientSecret);
    await rest(clientId, clientSecret);
    log('=== DIAGNOSTIC TERMINÉ ===');
  }, 4000);
}
module.exports = { run };
