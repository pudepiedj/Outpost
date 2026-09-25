// Economy assistant for a human player: a partial bot that only looks after workers and supply.
// It uses the same fog-filtered observe() view and the same commands as any player, so it can't
// do anything the human couldn't. The human keeps full control and can override it at any time.

import { UNITS, BUILDINGS, FACTIONS, MAX_SUPPLY } from './data.js';
import { findBuildSpot } from './bots/placement.js';

const IDLE_GRACE = 48;      // ticks (3 s) a worker may stand idle near a base before being sent to mine
const HOME_RADIUS = 14;     // only idle workers this close to one of your bases are touched

export function createAssist({ player, faction, map }) {
  const F = FACTIONS[faction];
  const idleSince = new Map();
  const gasStaffed = new Set();
  const spotTries = new Map();
  const dronesPending = []; // Swarm eggs don't reveal their type, so remember drones we ordered
  let lastSupplyTry = -1e9;
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

        // 3. Keep bases training workers up to a sensible number.
        const sites = [];
        for (const b of bases) if (mineralsNear(b).length && !sites.some(x => d2(x, b) < 8)) sites.push(b);
        const target = Math.min(60, 18 * Math.max(1, sites.length) + 3 * gasBlds.length);
        while (dronesPending.length && obs.tick - dronesPending[0] > UNITS.drone.time * 16 + 8) dronesPending.shift();
        let have = workers.length + dronesPending.length + blds.reduce((n, b) => n + b.queue.filter(t => UNITS[t].worker).length, 0);
        const wd = UNITS[F.worker];
        for (const b of bases) {
          if (have >= target || supplyFree < wd.supply || !afford(wd.cost)) break;
          if (BUILDINGS[b.type].larva) {
            // leave a larva for the player's own army unless the economy is tiny
            if (b.larva < (workers.length < 12 ? 1 : 2)) continue;
            dronesPending.push(obs.tick);
          } else if (b.queue.length > 0) continue;
          cmds.push({ type: 'train', building: b.id, utype: F.worker });
          spend(wd.cost); supplyFree -= wd.supply; have++;
        }
      }

      if (assist.supply && obs.supplyCap < MAX_SUPPLY && obs.supplyUsed >= 8 && obs.tick - lastSupplyTry > 16 * 6) {
        const pending = blds.some(b => !b.done && (BUILDINGS[b.type].supply || 0) > 0) ||
          workers.some(w => w.order.type === 'build' && !w.order.bid && (BUILDINGS[w.order.btype].supply || 0) > 0);
        const producers = blds.filter(b => b.done && (BUILDINGS[b.type].produces || []).length).length;
        const sd = BUILDINGS[F.supply];
        if (!pending && supplyFree <= 3 + producers * 2 && afford(sd.cost)) {
          const home = bases[0];
          const spot = findBuildSpot(obs, map, F.supply, home, key => (spotTries.get(key) || 0) >= 2);
          if (spot) {
            const site = { x: spot.tx + sd.size / 2, y: spot.ty + sd.size / 2 };
            const w = workers.filter(w => w.order.type === 'gather' && !w.carry && !w.hidden).sort((a, b) => d2(a, site) - d2(b, site))[0];
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
      return cmds;
    },
  };
  return assist;
}
