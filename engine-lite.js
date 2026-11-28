'use strict';
/**
 * Engine minimal (remplace l'ancien engine.js de 2000 lignes + analysis.js).
 * Il ne contient AUCUNE stratégie : il sert seulement d'interface aux modules cTrader (ctrader/manager.js, ctrader/execution.js)
 * qui l'appellent pour la config des symboles, les comptes, les prix et les ordres. La stratégie est dans smc-engine.js / smc-bot.js.
 */
module.exports = function createEngineLite() {
  const cfg = { symbolsAllowed: ['XAUUSD', 'EURUSD'], split: { enabled: false } }, noop = () => {};
  return {
    getConfig: () => cfg, setConfig: () => cfg,
    updateAccount: noop, setCandles: noop, setExecStatus: noop, execPending: noop, execCancelled: noop, execFail: noop, cancelLimit: noop,
    activeTrades: () => [], execNext: () => null, cancelNext: () => null, execAck: () => null, execResult: () => null, beTargets: () => [], sessionCloseDue: () => false,
    scalperTick: async () => {}, tick: async () => {}, update: async () => {},
    setAutoTrade: noop, setBlock: noop, setNews: noop, setNewsEvents: noop, updateNews: noop, pushNews: noop,
    status: () => ({ ok: true })
  };
};
