// Headless bot-vs-bot games. Same simulation as the browser, no rendering.
//   node tools/arena.mjs --games 5 --seed 1 --p1 vanguard:balanced --p2 swarm:balanced --p3 ascendant:rush
// A slot can be "off". Bots are called every 4 ticks with their fog-filtered observation.

import { createGame, step, issue, observe, publicMap } from '../src/sim.js';
import { TICK_RATE, PLAYER_NAMES, FACTIONS } from '../src/data.js';
import { BOTS } from '../src/bots/index.js';

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? a.concat([[x.slice(2), arr[i + 1]]]) : a), []));
const games = +(args.games || 3), seed0 = +(args.seed || 1), maxMin = +(args.minutes || 30);
const slotSpec = [args.p1 || 'vanguard:balanced', args.p2 || 'swarm:balanced', args.p3 || 'ascendant:balanced'];
const verbose = 'verbose' in args;

const results = [];
for (let g = 0; g < games; g++) {
  const seed = seed0 + g;
  const slots = slotSpec.map(s => (s === 'off' ? null : { faction: s.split(':')[0] }));
  const state = createGame({ seed, slots });
  const map = publicMap(state);
  const bots = slotSpec.map((s, p) => {
    if (s === 'off') return null;
    const [faction, style = 'balanced', botId = 'standard'] = s.split(':');
    return BOTS[botId].create({ player: p, faction, map, style });
  });
  const t0 = performance.now();
  let issued = 0, rejected = 0;
  while (!state.over && state.tick < maxMin * 60 * TICK_RATE) {
    if (state.tick % 4 === 0) {
      for (let p = 0; p < 3; p++) {
        if (!bots[p] || !state.players[p].alive) continue;
        for (const c of bots[p].onTick(observe(state, p)) || []) { issued++; if (!issue(state, p, c)) rejected++; }
      }
    }
    step(state);
    if (verbose && state.tick % (TICK_RATE * 60) === 0) {
      const line = state.players.filter(p => p.active).map(p => {
        let units = 0, army = 0, blds = 0;
        for (const e of state.ents.values()) if (e.owner === p.id) { if (e.kind === 'unit') { units++; if (!['engineer', 'drone', 'acolyte'].includes(e.type)) army++; } else blds++; }
        return `${PLAYER_NAMES[p.id]}(${p.faction[0]}) ${p.alive ? '' : 'DEAD '}sup ${p.supplyUsed}/${p.supplyCap} m${p.minerals} g${p.gas} u${units} a${army} b${blds} k${p.stats.kills}`;
      }).join(' | ');
      console.log(`  ${String(state.tick / TICK_RATE / 60).padStart(2)}m  ${line}`);
    }
  }
  const secs = state.tick / TICK_RATE;
  const wall = (performance.now() - t0) / 1000;
  const winner = state.over && state.winner >= 0 ? `${PLAYER_NAMES[state.winner]} (${FACTIONS[state.players[state.winner].faction].name})` : 'none (time limit)';
  console.log(`game ${g + 1} seed ${seed}: winner ${winner} after ${Math.floor(secs / 60)}m${String(Math.round(secs % 60)).padStart(2, '0')}s  [${wall.toFixed(1)}s wall, ${(secs / wall).toFixed(0)}x realtime, cmds ${issued} rejected ${rejected}]`);
  for (const p of state.players.filter(p => p.active)) {
    const s = p.stats;
    console.log(`    ${PLAYER_NAMES[p.id].padEnd(5)} ${FACTIONS[p.faction].name.padEnd(9)} mined ${s.mined}/${s.gasMined}  built ${s.unitsBuilt}  kills ${s.kills}  losses ${s.losses}${p.alive ? '' : `  eliminated at ${Math.round(p.defeatedAt / TICK_RATE / 60)}m`}`);
  }
  results.push(state.winner);
}
