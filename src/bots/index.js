// Bot registry. To add your own bot: write a module exporting createBot({player, faction, map, style})
// that returns { onTick(obs) -> commands }, then list it here.
import * as standard from './standard.js';

export const BOTS = {
  standard: { name: 'Standard', module: './standard.js', styles: standard.STYLES, create: standard.createBot },
};
