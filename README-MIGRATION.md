# ARES IA Mentor — cTrader · SCALPING / SWING · Bookmap · Exocharts

## Installation (Render)
    npm install express ws      # (si pas déjà dans package.json) — Node >= 18
    npm start                   # = node server.js  (le package.json doit contenir "start": "node server.js")
Fichiers à SUPPRIMER du dépôt (100 % MT5) : AresBridgeEA.mq5, ares_agent.py, ares_agent2.py, broker-feed.js, agent-relay.js
Variables Render à SUPPRIMER : EA_TOKEN, MT5_BRIDGE_KEY, CTRADER_ACCESS_TOKEN, CTRADER_REFRESH_TOKEN (jetons Playground = sandbox). Variables à AJOUTER : voir .env (ne jamais le mettre sur GitHub : .gitignore).

## Fonctionnement
- SCALPING (M1 entrée · M5 structure · M15 biais) / SWING (M15 · M30) : un seul mode actif par utilisateur, persistant côté serveur (GET/POST /api/trading-mode). Paramètres séparés (SL/TP/ATR/spread/cooldowns) dans config.modes.
- cTRADER : OAuth officiel, jetons chiffrés côté serveur. CONNECTED / DISCONNECTED / PENDING (si CLIENT_ID/SECRET absents).
- BOOKMAP / EXOCHARTS : aucune donnée simulée. NOT CONNECTED / DATA UNAVAILABLE tant qu'aucune source réelle n'envoie de données.
  * Mode HTTP : BOOKMAP_API_URL / BOOKMAP_API_KEY (idem EXOCHARTS_*). Le serveur appelle GET <URL>?symbol=XAUUSD (Authorization: Bearer <KEY>) et attend un JSON à plat (ou sous "data") avec les champs :
    delta, cvd, imbalance, bidAskImbalance, absorption, sweeps, volume, bid, ask, poc, vwap, vah, val, bidDepth, askDepth + tableaux heatmap, liquidityZones, footprint, volumeProfile, largeOrders, dom, tape.
  * Mode PUSH : POST /api/orderflow/push (x-api-key = ORDERFLOW_PUSH_KEY) avec {"source":"bookmap"|"exocharts","symbol":"XAUUSD", ...mêmes champs}.
  * Donnée plus vieille que ORDERFLOW_MAX_AGE_SEC (30 s) = STALE : ignorée par l'IA. Source absente ou STALE : jamais comptée comme « confirmée ».
  * Bookmap et Exocharts n'ont, à ma connaissance, pas d'API HTTP publique prête à l'emploi : il faut un add-on / exporteur réel ou un service à toi qui respecte ce contrat.

## Nouvelles routes (toutes authentifiées par x-api-key, sauf push : ORDERFLOW_PUSH_KEY)
GET/POST /api/trading-mode · GET /api/bookmap/status · GET /api/bookmap/data?symbol= · GET /api/exocharts/status · GET /api/exocharts/data?symbol=
(existantes conservées : /api/ctrader/*, /api/mentor/*, /api/admin/*, /api/orderflow/push, /api/signal ...)

## Checklist avant déploiement Render
1. Variables : MENTOR_API_KEY, ADMIN_API_KEY, TOKEN_ENCRYPTION_KEY, CTRADER_CLIENT_ID/SECRET/REDIRECT_URI (+ enregistrer le redirect chez Spotware).
2. Déployer ; GET /health ; ouvrir le site, saisir MENTOR_API_KEY dans le panneau ARES AI.
3. Onglet cTRADER : Connect cTrader (compte DEMO d'abord) -> CONNECTED, balance/equity réels.
4. Laisser PAPER (liveExecution=false) plusieurs jours ; vérifier le journal ; seulement ensuite LIVE.
5. BOOKMAP / EXOCHARTS : doivent afficher NOT CONNECTED tant qu'aucune source n'est branchée.
6. Tester EMERGENCY STOP sur DEMO.

## Rien n'est garanti
Le Protected Profit Floor est un objectif de protection : spread, slippage, gaps et exécution du broker peuvent le dépasser. Aucun profit n'est garanti, y compris avec 5 $.
