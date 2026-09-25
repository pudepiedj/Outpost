// Economy assistant for a human player: a partial bot that only looks after workers, supply and repairs.
// It uses the same fog-filtered observe() view and the same commands as any player, so it can't
// do anything the human couldn't. The human keeps full control and can override it at any time.

import { UNITS, BUILDINGS, FACTIONS } from './data.js';
import { findBuildSpot } from './bots/placement.js';

const IDLE_GRACE = 48;      // ticks (3 s) a worker may stand idle near a base before being sent to mine
const HOME_RADIUS = 14;     // only idle workers this close to one of your bases are touched
const RESERVE = 125;        // minerals the assist leaves for the player once the economy is going

export function createAssist({ player, faction, map }) {
  const F = FACTIONS[faction];
  const idleSince = new Map();
  const gasStaffed = new Set();
  const spotTries = new Map();
  const dronesPending = []; // Swarm eggs don't reveal their type, so remember drones we ordered
  let lastSupplyTry = -1e9, noSpotUntil = 0;
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const assist = {
    workers: true,
    supply: true,
    onTick(obs) {
      const cmds = [];
      const units = obs.mine.filter(e => e.kind === 'unit');
      const blds = obs.mine.filter(e => e.kind === 'building');
      const workers = units.filter(u => UNITS[u.type].worker);
      const bases = blds.filter(b => BUILDINGS[b.type].base && b.done);
      if (!bases.length) return cmds;

      let minerals = obs.minerals, gas = obs.gas, supplyFree = obs.supplyCap - obs.supplyUsed;
      for (const w of workers) if (w.order.type === 'build' && w.order.phase === 'toSite' && !w.order.bid) {
        const c = BUILDINGS[w.order.btype].cost; minerals -= c[0]; gas -= c[1];
      }
      const afford = c => minerals >= c[0] && gas >= c[1];
      const spend = c => { minerals -= c[0]; gas -= c[1]; };

      const mineralsNear = b => obs.resources.filter(r => r.type === 'mineral' && d2(r, b) < 11);
      const patches = obs.resources.filter(r => r.type === 'mineral' && bases.some(b => d2(r, b) < 11));
      const gasBlds = blds.filter(b => BUILDINGS[b.type].onGeyser && b.done);

      // Supply first: a supply block stalls everything, workers included.
      if (assist.supply && obs.supplyCap < obs.supplyMax && obs.supplyUsed >= 6 && obs.tick - lastSupplyTry > 16 * 2) {
        // Supply already on its way, from unfinished buildings and workers walking to a site.
        const pending = blds.reduce((n, b) => n + (!b.done ? BUILDINGS[b.type].supply || 0 : 0), 0) +
          workers.reduce((n, w) => n + (w.order.type === 'build' && !w.order.bid ? BUILDINGS[w.order.btype].supply || 0 : 0), 0);
        const producers = blds.filter(b => b.done && (BUILDINGS[b.type].produces || []).length).length;
        const sd = BUILDINGS[F.supply];
        // keep enough headroom for every production building to keep working while supply is built
        const headroom = 4 + producers * 3;
        const need = obs.supplyCap + pending < Math.min(obs.supplyMax, obs.supplyUsed + headroom);
        if (need && !afford(sd.cost)) spend(sd.cost); // save up: don't spend the money on workers meanwhile
        else if (need) {
          const home = bases[0];
          const spot = obs.tick < noSpotUntil ? null : findBuildSpot(obs, map, F.supply, home, key => (spotTries.get(key) || 0) >= 2);
          if (!spot) noSpotUntil = obs.tick + 32;
          if (spot) {
            const site = { x: spot.tx + sd.size / 2, y: spot.ty + sd.size / 2 };
            // prefer a miner; if nobody is mining (fields run dry), any worker not already building will do
            let pool = workers.filter(w => w.order.type === 'gather' && !w.hidden);
            if (!pool.length) pool = workers.filter(w => (w.order.type === 'idle' || w.order.type === 'move') && !w.hidden);
            const w = (pool.some(w => !w.carry) ? pool.filter(w => !w.carry) : pool).sort((a, b) => d2(a, site) - d2(b, site))[0];
            if (w) {
              const key = `${F.supply}:${spot.tx},${spot.ty}`;
              spotTries.set(key, (spotTries.get(key) || 0) + 1);
              cmds.push({ type: 'build', units: [w.id], btype: F.supply, tx: spot.tx, ty: spot.ty });
              spend(sd.cost);
              lastSupplyTry = obs.tick;
            }
          }
        }
      }

      if (assist.workers) {
        // 1. Idle workers near home go back to mining (least-crowded patch first).
        const load = new Map();
        for (const w of workers) if (w.order.type === 'gather') load.set(w.order.res, (load.get(w.order.res) || 0) + 1);
        for (const w of workers) {
          if (w.order.type !== 'idle' || w.hidden) { idleSince.delete(w.id); continue; }
          if (!idleSince.has(w.id)) { idleSince.set(w.id, obs.tick); continue; }
          if (obs.tick - idleSince.get(w.id) < IDLE_GRACE) continue;
          if (!bases.some(b => d2(b, w) < HOME_RADIUS)) continue;
          let best = null, bestScore = Infinity;
          for (const r of patches) {
            const sc = (load.get(r.id) || 0) * 6 + d2(r, w) * 0.1;
            if (sc < bestScore) { bestScore = sc; best = r; }
          }
          if (best) { cmds.push({ type: 'gather', units: [w.id], target: best.id }); load.set(best.id, (load.get(best.id) || 0) + 1); idleSince.delete(w.id); }
        }

        // 2. Each new gas building gets three workers, once (move them off again if you like).
        for (const g of gasBlds) {
          if (gasStaffed.has(g.id)) continue;
          gasStaffed.add(g.id);
          const already = workers.filter(w => w.order.type === 'gather' && w.order.res === g.id).length;
          const pick = workers.filter(w => w.order.type === 'gather' && !w.carry && !w.hidden && !gasBlds.some(x => x.id === w.order.res))
            .sort((a, b) => d2(a, g) - d2(b, g)).slice(0, Math.max(0, 3 - already));
          if (pick.length) cmds.push({ type: 'gather', units: pick.map(w => w.id), target: g.id });
        }

        // 3. Keep bases training workers up to a sensible number: two per mineral patch plus three per gas.
        // Past the first dozen it only spends money above a reserve, so the player can always afford
        // a building, a tower or army too.
        const sites = [];
        for (const b of bases) if (mineralsNear(b).length && !sites.some(x => d2(x, b) < 8)) sites.push(b);
        const patchCount = sites.reduce((n, b) => n + mineralsNear(b).length, 0);
        const target = Math.min(60, Math.max(8, 2 * patchCount) + 3 * gasBlds.length);
        while (dronesPending.length && obs.tick - dronesPending[0] > UNITS.drone.time * 16 + 8) dronesPending.shift();
        let have = workers.length + dronesPending.length + blds.reduce((n, b) => n + b.queue.filter(t => UNITS[t].worker).length, 0);
        const wd = UNITS[F.worker];
        const reserve = have < 12 ? 0 : RESERVE;
        for (const b of bases) {
          if (have >= target || supplyFree < wd.supply || minerals - wd.cost[0] < reserve || !afford(wd.cost)) break;
          if (BUILDINGS[b.type].larva) {
            // never take the last larva: the player needs them for everything else
            if (b.larva < (have < 8 ? 1 : 2)) continue;
            dronesPending.push(obs.tick);
          } else if (b.queue.length > 0) continue;
          cmds.push({ type: 'train', building: b.id, utype: F.worker });
          spend(wd.cost); supplyFree -= wd.supply; have++;
        }
      }

      if (assist.workers && minerals >= 40) {
        // 4. Damaged buildings near a base get two or three repairers (they go back to mining after).
        for (const b of blds) {
          if (!b.done || b.hp > b.maxHp * 0.8 || !bases.some(x => d2(x, b) < HOME_RADIUS + 4)) continue;
          const on = workers.filter(w => w.order.type === 'repair' && w.order.target === b.id).length;
          const want = b.hp < b.maxHp * 0.4 ? 3 : 2;
          if (on >= want) continue;
          const pick = workers.filter(w => w.order.type === 'gather' && !w.carry && !w.hidden).sort((a, c) => d2(a, b) - d2(c, b)).slice(0, want - on);
          if (pick.length) cmds.push({ type: 'repair', units: pick.map(w => w.id), target: b.id });
        }
      }

      return cmds;
    },
  };
  return assist;
}
