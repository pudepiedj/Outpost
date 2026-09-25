// A reference bot that plays any faction. It sees only what observe() gives it (fog applies)
// and acts only through commands, exactly like a human player.
//
// Bot interface:
//   export function createBot({ player, faction, map, style }) -> { onTick(obs) -> command[] }
// onTick is called about four times per game second. See README.md for the obs/command formats.

import { UNITS, BUILDINGS, FACTIONS, MAX_SUPPLY } from '../data.js';
import { checkPlacement } from '../rules.js';
import { findBuildSpot, knownBlocked, placementCtxFromObs } from './placement.js';

export const STYLES = {
  balanced: { label: 'Balanced', workers: 18, gasAt: 12, firstWave: 12, waveGrowth: 4, scoutAt: 9, expandAt: 36 },
  rush:     { label: 'Rush',     workers: 12, gasAt: 99, firstWave: 6,  waveGrowth: 3, scoutAt: 8, expandAt: 50 },
  // Easy: a small economy, one production building, no attacks before minute 9, small capped waves
  // and a long pause after each one, so a human has time to build up.
  easy:     { label: 'Easy',     workers: 10, gasAt: 10, firstWave: 8,  waveGrowth: 2, scoutAt: 12, expandAt: 999, slow: true, attackAfter: 540, maxWave: 12, restAfter: 180 },
};

const BUILD_ORDERS = {
  balanced: {
    vanguard:  [['depot', 9], ['barracks', 11], ['refinery', 12], ['barracks', 14], ['factory', 16], ['turret', 20], ['barracks', 24], ['turret', 30]],
    swarm:     [['pod', 9], ['pit', 11], ['extractor', 12], ['den', 15], ['thorn', 18], ['hive', 20], ['thorn', 28]],
    ascendant: [['pylon', 8], ['gateway', 10], ['assimilator', 11], ['core', 13], ['gateway', 15], ['spire', 20], ['gateway', 24], ['spire', 30]],
  },
  easy: {
    vanguard:  [['depot', 9], ['barracks', 12], ['refinery', 14], ['factory', 20]],
    swarm:     [['pod', 9], ['pit', 12], ['extractor', 14], ['den', 20]],
    ascendant: [['pylon', 8], ['gateway', 11], ['assimilator', 13], ['core', 18]],
  },
  rush: {
    vanguard:  [['depot', 8], ['barracks', 9], ['barracks', 10], ['barracks', 13]],
    swarm:     [['pit', 9], ['pod', 9], ['hive', 14]],
    ascendant: [['pylon', 8], ['gateway', 9], ['gateway', 10], ['gateway', 14]],
  },
};

export function createBot({ player, faction, map, style = 'balanced' }) {
  const S = STYLES[style] || STYLES.balanced;
  const F = FACTIONS[faction];
  const ORDER = (BUILD_ORDERS[style] || BUILD_ORDERS.balanced)[faction];
  const N = map.size;
  const spotTries = new Map();
  let home = null, rally = null;
  let scoutId = 0, scoutDone = false, scoutQueue = [];
  let attacking = false, wave = S.firstWave, target = null;
  let expander = 0, restUntil = 0;

  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  return {
    onTick(obs) {
      const cmds = [];
      const mine = obs.mine;
      const units = mine.filter(e => e.kind === 'unit');
      const blds = mine.filter(e => e.kind === 'building');
      const workers = units.filter(u => UNITS[u.type].worker && u.id !== scoutId);
      const army = units.filter(u => !UNITS[u.type].worker);
      const bases = blds.filter(b => BUILDINGS[b.type].base).sort((a, b) => a.id - b.id);
      if (!home) {
        home = obs.start;
        const ramp = map.ramps.reduce((best, r) => (!best || d2(r, home) < d2(best, home) ? r : best), null);
        rally = ramp ? { x: home.x + (ramp.x - home.x) * 0.75, y: home.y + (ramp.y - home.y) * 0.75 } : home;
        scoutQueue = map.starts.filter(s => d2(s, home) > 5).map(s => ({ x: s.x, y: s.y }));
      }

      // Budget: subtract the cost of buildings workers are on their way to place.
      let minerals = obs.minerals, gas = obs.gas;
      for (const w of units) if (w.order.type === 'build' && w.order.phase === 'toSite' && !w.order.bid) {
        const c = BUILDINGS[w.order.btype].cost; minerals -= c[0]; gas -= c[1];
      }
      let supplyFree = obs.supplyCap - obs.supplyUsed;
      const afford = c => minerals >= c[0] && gas >= c[1];
      const spend = c => { minerals -= c[0]; gas -= c[1]; };
      const count = t => blds.filter(b => b.type === t).length + units.filter(w => w.order.type === 'build' && !w.order.bid && w.order.btype === t).length;
      const doneOf = t => blds.some(b => b.type === t && b.done);
      const reqOk = t => ((UNITS[t] || BUILDINGS[t]).requires || []).every(doneOf);

      const threats = obs.enemies.filter(e => e.kind === 'unit' && blds.some(b => d2(b, e) < 15));

      if (!bases.length) { fight(); return cmds; }

      // ---------------- economy
      const mineralsNearBases = obs.resources.filter(r => r.type === 'mineral' && bases.some(b => b.done && d2(r, b) < 11));
      const load = new Map();
      for (const w of workers) if (w.order.type === 'gather') load.set(w.order.res, (load.get(w.order.res) || 0) + 1);
      const gasBlds = blds.filter(b => BUILDINGS[b.type].onGeyser && b.done);

      for (const w of workers) {
        if (w.order.type !== 'idle') continue;
        let best = null, bestScore = Infinity;
        for (const r of mineralsNearBases) {
          const sc = (load.get(r.id) || 0) * 6 + d2(r, w) * 0.1;
          if (sc < bestScore) { bestScore = sc; best = r; }
        }
        if (best) { cmds.push({ type: 'gather', units: [w.id], target: best.id }); load.set(best.id, (load.get(best.id) || 0) + 1); }
      }
      if (workers.length >= S.gasAt) {
        for (const g of gasBlds) {
          const on = workers.filter(w => w.order.type === 'gather' && w.order.res === g.id).length;
          if (on >= 3) continue;
          const cand = workers.filter(w => w.order.type === 'gather' && w.order.res !== g.id && !gasBlds.some(x => x.id === w.order.res) && !w.carry)
            .sort((a, b) => d2(a, g) - d2(b, g)).slice(0, 3 - on);
          for (const w of cand) cmds.push({ type: 'gather', units: [w.id], target: g.id });
        }
      }

      // count mining sites, not base buildings (a second hive in the main is for larvae)
      const sites = [];
      for (const b of bases) if (b.done && minerals_near(b) && !sites.some(x => d2(x, b) < 8)) sites.push(b);
      const workerTarget = Math.min(60, S.workers * Math.max(1, sites.length) + 3 * gasBlds.length);
      const workersIncoming = blds.reduce((n, b) => n + b.queue.filter(t => UNITS[t].worker).length, 0);
      const wantWorkers = workers.length + workersIncoming < workerTarget;

      // ---------------- building
      let building = false; // at most one new construction per call
      const supplyPending = blds.some(b => !b.done && (BUILDINGS[b.type].supply || 0) > 0) ||
        units.some(w => w.order.type === 'build' && !w.order.bid && (BUILDINGS[w.order.btype].supply || 0) > 0);
      const producers = blds.filter(b => (BUILDINGS[b.type].produces || []).some(t => !UNITS[t].worker)).length;
      if (obs.supplyCap < MAX_SUPPLY && !supplyPending && supplyFree <= 3 + producers * 2 && obs.supplyUsed >= 8) {
        tryBuild(F.supply);
      }
      // build order
      const seen = new Map();
      for (const [bt, at] of ORDER) {
        seen.set(bt, (seen.get(bt) || 0) + 1);
        if (count(bt) >= seen.get(bt)) continue;
        if (obs.supplyUsed >= at && !building) tryBuild(bt);
        break;
      }
      // expansions
      const wantBases = 1 + (obs.supplyUsed >= S.expandAt ? 1 : 0) + (obs.supplyUsed >= S.expandAt + 30 ? 1 : 0) +
        bases.filter(b => b.done && !minerals_near(b)).length;
      const baseSites = [];
      for (const b of bases) if (!baseSites.some(x => d2(x, b) < 8)) baseSites.push(b);
      for (const w of units) if (w.order.type === 'build' && !w.order.bid && w.order.btype === F.base) {
        const p = { x: w.order.tx + 1.5, y: w.order.ty + 1.5 };
        if (!baseSites.some(x => d2(x, p) < 8)) baseSites.push(p);
      }
      if (baseSites.length < wantBases && !building) expand();
      // spare money: more production
      if (minerals > 450 && !building && producers < (S.slow ? 1 : 6)) {
        const extra = faction === 'swarm' ? 'hive' : faction === 'vanguard' ? (doneOf('factory') && producers % 3 === 2 ? 'factory' : 'barracks') : 'gateway';
        if (reqOk(extra)) tryBuild(extra);
      }

      // ---------------- production
      for (const b of bases) {
        if (!b.done || BUILDINGS[b.type].larva) continue;
        if (wantWorkers && b.queue.length === 0 && supplyFree >= 1 && afford(UNITS[F.worker].cost)) {
          cmds.push({ type: 'train', building: b.id, utype: F.worker }); spend(UNITS[F.worker].cost); supplyFree -= 1;
        }
      }
      const nextStepCost = nextBuildCost();
      for (const b of blds) {
        if (!b.done) continue;
        const bd = BUILDINGS[b.type];
        if (bd.larva) {
          let larva = b.larva;
          let dronesQueued = 0;
          while (larva > 0) {
            let t = null;
            if (wantWorkers && dronesQueued < 2 && (threats.length === 0 || army.length > 6)) t = 'drone';
            else if (S.maxWave && army.length >= S.maxWave + 4) break;
            else t = pickArmyUnit(bd.produces);
            if (!t) break;
            const d = UNITS[t];
            const sup = d.supply * (d.count || 1);
            if (!afford(d.cost) || supplyFree < sup) break;
            if (t !== 'drone' && minerals - d.cost[0] < nextStepCost && threats.length === 0) break;
            cmds.push({ type: 'train', building: b.id, utype: t }); spend(d.cost); supplyFree -= sup; larva--;
            if (t === 'drone') dronesQueued++;
          }
          continue;
        }
        if (bd.base || !bd.produces) continue;
        if (S.maxWave && army.length >= (S.maxWave + 4)) continue;
        if (b.queue.length >= (minerals > 600 && !S.slow ? 2 : 1) || !b.powered) continue;
        const t = pickArmyUnit(bd.produces);
        if (!t) continue;
        const d = UNITS[t];
        if (!afford(d.cost) || supplyFree < d.supply) continue;
        if (minerals - d.cost[0] < nextStepCost && threats.length === 0) continue;
        cmds.push({ type: 'train', building: b.id, utype: t }); spend(d.cost); supplyFree -= d.supply;
      }

      repairStep();
      scoutStep();
      fight();
      return cmds;

      // ================= helpers (hoisted)

      function minerals_near(b) { return obs.resources.some(r => r.type === 'mineral' && d2(r, b) < 11); }

      function nextBuildCost() {
        const seen2 = new Map();
        for (const [bt, at] of ORDER) {
          seen2.set(bt, (seen2.get(bt) || 0) + 1);
          if (count(bt) >= seen2.get(bt)) continue;
          return obs.supplyUsed >= at - 1 ? BUILDINGS[bt].cost[0] : 0;
        }
        return 0;
      }

      function pickArmyUnit(list) {
        const opts = list.filter(t => !UNITS[t].worker && reqOk(t));
        if (!opts.length) return null;
        // Prefer the most expensive unit we can afford that uses gas, else the cheapest.
        const gasUnits = opts.filter(t => UNITS[t].cost[1] > 0 && afford(UNITS[t].cost));
        if (gasUnits.length && (army.length % 3 !== 2 || opts.length === 1)) return gasUnits.sort((a, b) => UNITS[b].cost[0] - UNITS[a].cost[0])[(army.length >> 1) % gasUnits.length];
        return opts.filter(t => UNITS[t].cost[1] === 0).sort((a, b) => UNITS[a].cost[0] - UNITS[b].cost[0])[0] || opts[0];
      }

      function pickBuilder(site) {
        const pool = workers.filter(w => w.order.type === 'gather' && !w.carry && !w.hidden && w.id !== expander);
        const pool2 = pool.length ? pool : workers.filter(w => w.order.type === 'gather' || w.order.type === 'idle');
        return pool2.sort((a, b) => d2(a, site) - d2(b, site))[0];
      }

      function tryBuild(bt) {
        building = true;
        const bd = BUILDINGS[bt];
        if (!reqOk(bt) || !afford(bd.cost)) return;
        const spot = findSpot(bt);
        if (!spot) return;
        const w = pickBuilder({ x: spot.tx + bd.size / 2, y: spot.ty + bd.size / 2 });
        if (!w) return;
        const key = `${bt}:${spot.tx},${spot.ty}`;
        spotTries.set(key, (spotTries.get(key) || 0) + 1);
        cmds.push({ type: 'build', units: [w.id], btype: bt, tx: spot.tx, ty: spot.ty });
        spend(bd.cost);
        w.order = { type: 'build', btype: bt, tx: spot.tx, ty: spot.ty }; // so this call won't reuse it
      }

      function findSpot(bt) {
        return findBuildSpot(obs, map, bt, home, key => (spotTries.get(key) || 0) >= 2);
      }

      function expand() {
        building = true;
        const bd = BUILDINGS[F.base];
        const ctx = placementCtxFromObs(obs, map, knownBlocked(obs, map));
        const taken = b => blds.some(x => d2(x, b) < 4) || obs.enemies.concat(obs.remembered).some(x => x.size && Math.hypot(x.x - b.x, x.y - b.y) < 8);
        const spots = map.bases.filter(b => !taken(b)).sort((a, b) => d2(a, home) - d2(b, home));
        const spot = spots[0];
        if (!spot) return;
        const tx = Math.floor(spot.x) - 1, ty = Math.floor(spot.y) - 1;
        let w = units.find(u => u.id === expander);
        if (!w) { w = pickBuilder(spot); if (!w) return; expander = w.id; }
        const explored = obs.explored[ty * N + tx] && obs.explored[(ty + 2) * N + tx + 2];
        if (!explored) { if (w.order.type !== 'move') cmds.push({ type: 'move', units: [w.id], x: spot.x, y: spot.y + 2.5 }); return; }
        if (!afford(bd.cost)) { if (d2(w, spot) > 6 && w.order.type !== 'move') cmds.push({ type: 'move', units: [w.id], x: spot.x, y: spot.y + 2.5 }); return; }
        if (!checkPlacement(ctx, F.base, tx, ty).ok) return;
        cmds.push({ type: 'build', units: [w.id], btype: F.base, tx, ty });
        spend(bd.cost);
        expander = 0;
      }

      function repairStep() {
        if (minerals < 60) return;
        for (const b of blds) {
          if (!b.done || b.hp > b.maxHp * 0.75 || !bases.some(x => d2(x, b) < 14)) continue;
          const on = workers.filter(w => w.order.type === 'repair' && w.order.target === b.id).length;
          const want = b.hp < b.maxHp * 0.4 ? 3 : 2;
          if (on >= want) continue;
          const w = workers.filter(w => w.order.type === 'gather' && !w.carry && !w.hidden).sort((a, c) => d2(a, b) - d2(c, b)).slice(0, want - on);
          if (w.length) cmds.push({ type: 'repair', units: w.map(x => x.id), target: b.id });
        }
      }

      function scoutStep() {
        if (scoutDone) return;
        if (!scoutId) {
          if (obs.supplyUsed < S.scoutAt) return;
          const w = pickBuilder(home);
          if (!w) return;
          scoutId = w.id;
        }
        const s = units.find(u => u.id === scoutId);
        if (!s) { scoutDone = true; return; }
        // drop start locations we've now seen
        scoutQueue = scoutQueue.filter(p => !obs.explored[Math.floor(p.y) * N + Math.floor(p.x)]);
        if (!scoutQueue.length) {
          scoutDone = true; scoutId = 0;
          cmds.push({ type: 'stop', units: [s.id] }); // becomes idle -> economy picks it up
          return;
        }
        const p = scoutQueue.sort((a, b) => d2(a, s) - d2(b, s))[0];
        if (s.order.type !== 'move' || Math.hypot(s.order.x - p.x, s.order.y - p.y) > 1) cmds.push({ type: 'move', units: [s.id], x: p.x, y: p.y });
      }

      function chooseTarget(from) {
        const known = obs.enemies.filter(e => e.kind === 'building').concat(obs.remembered);
        if (known.length) {
          const t = known.sort((a, b) => d2(a, from) - d2(b, from))[0];
          return { x: t.x, y: t.y };
        }
        const unseen = map.starts.filter(s => d2(s, home) > 5 && !obs.explored[Math.floor(s.y) * N + Math.floor(s.x)]);
        if (unseen.length) return unseen.sort((a, b) => d2(a, from) - d2(b, from))[0];
        const unseenBases = map.bases.filter(b => !obs.visible[Math.floor(b.y) * N + Math.floor(b.x)]);
        if (unseenBases.length) return unseenBases[(obs.tick >> 8) % unseenBases.length];
        return null;
      }

      function fight() {
        if (!army.length) return;
        const cx = army.reduce((s, u) => s + u.x, 0) / army.length, cy = army.reduce((s, u) => s + u.y, 0) / army.length;
        const sendTo = (pt, type = 'attackMove') => {
          const who = army.filter(u => u.order.type !== type || Math.hypot((u.order.x ?? 1e9) - pt.x, (u.order.y ?? 1e9) - pt.y) > 2.5);
          if (who.length) cmds.push({ type, units: who.map(u => u.id), x: pt.x, y: pt.y });
        };
        if (threats.length) {
          const t = threats.sort((a, b) => d2(a, home) - d2(b, home))[0];
          const idle = army.filter(u => u.order.type !== 'attack');
          if (idle.length) sendTo({ x: t.x, y: t.y });
          return;
        }
        const rested = !S.attackAfter || (obs.tick >= S.attackAfter * 16 && obs.tick >= restUntil);
        if (!attacking && army.length >= wave && rested) { attacking = true; target = null; }
        if (attacking) {
          if (army.length < Math.max(3, wave * 0.35)) {
            attacking = false; wave = Math.min(S.maxWave || 40, wave + S.waveGrowth); target = null;
            if (S.restAfter) restUntil = obs.tick + S.restAfter * 16;
            sendTo(rally, 'move');
            return;
          }
          const arrived = target && Math.hypot(cx - target.x, cy - target.y) < 5 && !obs.enemies.some(e => Math.hypot(e.x - target.x, e.y - target.y) < 10);
          if (!target || arrived || obs.tick % 64 === 0) target = chooseTarget({ x: cx, y: cy });
          if (target) sendTo(target);
          return;
        }
        const far = army.filter(u => u.order.type === 'idle' && Math.hypot(u.x - rally.x, u.y - rally.y) > 5);
        if (far.length) cmds.push({ type: 'move', units: far.map(u => u.id), x: rally.x, y: rally.y });
      }
    },
  };
}
