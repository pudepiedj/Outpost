// Runs one bot in a Web Worker so a slow bot can't stall the game.
// Receives {type:'init', botId, args} then {type:'obs', obs}; replies {type:'cmds', cmds}.
import { BOTS } from './index.js';

let bot = null;
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try { bot = BOTS[m.botId].create(m.args); }
    catch (err) { self.postMessage({ type: 'error', message: String(err && err.stack || err) }); }
    return;
  }
  if (m.type === 'obs') {
    let cmds = [];
    try { cmds = (bot && bot.onTick(m.obs)) || []; }
    catch (err) { self.postMessage({ type: 'error', message: String(err && err.stack || err) }); }
    self.postMessage({ type: 'cmds', cmds });
  }
};
