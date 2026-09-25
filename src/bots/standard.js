// A reference bot that plays any faction. It sees only what observe() gives it (fog applies)
// and acts only through commands, exactly like a human player.
//
// Bot interface:
//   export function createBot({ player, faction, map, style }) -> { onTick(obs) -> command[] }
// onTick is called about four times per game second. See README.md for the obs/command formats.

import { UNITS, BUILDINGS, FACTIONS, MINERAL_AMOUNT } from '../data.js';
import { checkPlacement } from '../rules.js';
import { findBuildSpot, knownBlocked, placementCtxFromObs, reachable } from './placement.js';

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
  // What the bot has learned about every base site: when it last looked, how many minerals are left there
  // (remembered per mineral field), and whether an enemy has built there.
  const siteInfo = map.bases.map(b => ({ x: b.x, y: b.y, lastSeen: -1e9, minerals: null, enemy: false }));
  const resMem = new Map(); // mineral field id -> last seen amount
  let surveyorId = 0, survey = [], nextSurvey = 0;
  const noSpotUntil = new Map(); // building type -> tick: after a failed site search, wait before searching again
  const huntTargets = []; // one per search party while hunting for an enemy we can't see
  const orderedAt = new Map(), restWorker = new Map(); // workers that go straight back to idle are left alone a while
  const maxMining = N >= 220 ? 5 : N >= 160 ? 4 : 3; // mining bases worth running at once, by map size
  const CELL = 8, CW = Math.ceil(N / CELL), seenAt = new Int32Array(CW * CW).fill(-1e6); // when each 8x8 cell was last in sight

  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  return {
    onTick(obs) {
      const cmds = [];
      const mine = obs.mine;
      for (let cy = 0; cy < CW; cy++) for (let cx = 0; cx < CW; cx++) {
        const x = Math.min(N - 1, cx * CELL + CELL / 2), y = Math.min(N - 1, cy * CELL + CELL / 2);
        if (obs.visible[y * N + x]) seenAt[cy * CW + cx] = obs.tick;
      }
      const units = mine.filter(e => e.kind === 'unit');
      const blds = mine.filter(e => e.kind === 'building');
      const workers = units.filter(u => UNITS[u.type].worker && u.id !== scoutId && u.id !== surveyorId);
      const army = units.filter(u => !UNITS[u.type].worker && u.id !== surveyorId);
      updateSites();
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
        if ((restWorker.get(w.id) || 0) > obs.tick) continue;
        if (obs.tick - (orderedAt.get(w.id) ?? -1e9) < 32) { restWorker.set(w.id, obs.tick + 16 * 30); continue; } // stuck somewhere: back off
        let best = null, bestScore = Infinity;
        for (const r of mineralsNearBases) {
          const sc = (load.get(r.id) || 0) * 6 + d2(r, w) * 0.1;
          if (sc < bestScore) { bestScore = sc; best = r; }
        }
        if (best) { cmds.push({ type: 'gather', units: [w.id], target: best.id }); load.set(best.id, (load.get(best.id) || 0) + 1); orderedAt.set(w.id, obs.tick); }
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
      if (obs.supplyCap < obs.supplyMax && !supplyPending && supplyFree <= 3 + producers * 2 && obs.supplyUsed >= 8) {
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
      // Mining bases: expand on a timetable (more on big maps), and always before the local fields run dry.
      const miningBases = [];
      for (const b of bases) if (!miningBases.some(x => d2(x, b) < 8) && fieldsNear(b) > 0) miningBases.push(b);
      const pendingBase = units.some(w => w.order.type === 'build' && !w.order.bid && w.order.btype === F.base) || bases.some(b => !b.done);
      const localLeft = miningBases.reduce((n, b) => n + fieldsNear(b), 0);
      let wantMining = 1 + (obs.supplyUsed >= S.expandAt ? 1 : 0) + (obs.supplyUsed >= S.expandAt + 25 ? 1 : 0) + (obs.supplyUsed >= S.expandAt + 45 ? 1 : 0) + (obs.supplyUsed >= S.expandAt + 60 ? 1 : 0);
      if (localLeft < 3000 * Math.max(1, miningBases.length)) wantMining = Math.max(wantMining, miningBases.length + 1); // running low: next base now
      wantMining = Math.min(wantMining, maxMining + (localLeft < 3000 ? 1 : 0));
      const expanding = miningBases.length < wantMining && !pendingBase;
      if (expanding && !building && (threats.length === 0 || minerals > 600)) expand();
      const saving = expanding && !threats.length ? BUILDINGS[F.base].cost[0] : 0; // hold money back for the new base
      // spare money: more production
      if (minerals - saving > 450 && !building && producers < (S.slow ? 1 : 6)) {
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
      const nextStepCost = nextBuildCost() + saving;
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
      rebalance();
      scoutStep();
      surveyStep();
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
        if ((noSpotUntil.get(bt) || 0) > obs.tick) return null;
        const spot = findBuildSpot(obs, map, bt, home, key => (spotTries.get(key) || 0) >= 2);
        if (!spot) noSpotUntil.set(bt, obs.tick + 32);
        return spot;
      }

      function expand() {
        building = true;
        const bd = BUILDINGS[F.base];
        const ctx = placementCtxFromObs(obs, map, knownBlocked(obs, map));
        const taken = b => blds.some(x => d2(x, b) < 4) || obs.enemies.concat(obs.remembered).some(x => x.size && Math.hypot(x.x - b.x, x.y - b.y) < 8);
        const reach = reachable(map, home.x, home.y);
        const ours = bases.length ? bases : [home];
        const score = s => Math.min(...ours.map(b => d2(b, s))) + (s.minerals === null ? 10 : 0) - (s.minerals ?? MINERAL_AMOUNT * 7) / 1500;
        const spots = siteInfo.filter(s => !taken(s) && !s.enemy && (s.minerals === null || s.minerals > 2500) && reach[Math.floor(s.y + 2) * N + Math.floor(s.x)] &&
          (spotTries.get(`base:${s.x},${s.y}`) || 0) < 3).sort((a, b) => score(a) - score(b));
        const spot = spots[0];
        if (!spot) return;
        const tx = Math.floor(spot.x) - 1, ty = Math.floor(spot.y) - 1;
        let w = units.find(u => u.id === expander);
        if (!w) { w = pickBuilder(spot); if (!w) return; expander = w.id; }
        const explored = obs.explored[ty * N + tx] && obs.explored[(ty + 2) * N + tx + 2];
        if (!explored) { if (w.order.type !== 'move') cmds.push({ type: 'move', units: [w.id], x: spot.x, y: spot.y + 2.5 }); return; }
        if (!afford(bd.cost)) { if (d2(w, spot) > 6 && w.order.type !== 'move') cmds.push({ type: 'move', units: [w.id], x: spot.x, y: spot.y + 2.5 }); return; }
        const key = `base:${spot.x},${spot.y}`;
        if (!checkPlacement(ctx, F.base, tx, ty).ok) { spotTries.set(key, (spotTries.get(key) || 0) + 1); return; }
        spotTries.set(key, (spotTries.get(key) || 0) + 1);
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

      // Minerals left around a base site, from what we have seen (fields not seen yet count as full).
      function fieldsNear(b) {
        let n = 0;
        for (const r of obs.resources) if (r.type === 'mineral' && d2(r, b) < 11) n += r.amount ?? resMem.get(r.id) ?? MINERAL_AMOUNT;
        return n;
      }

      function updateSites() {
        for (const r of obs.resources) if (r.type === 'mineral' && r.amount !== null) resMem.set(r.id, r.amount);
        const enemyB = obs.enemies.filter(e => e.kind === 'building').concat(obs.remembered);
        for (const s of siteInfo) {
          const i = Math.floor(s.y) * N + Math.floor(s.x);
          if (obs.visible[i]) s.lastSeen = obs.tick;
          if (obs.explored[i]) s.minerals = fieldsNear(s);
          s.enemy = enemyB.some(e => Math.hypot(e.x - s.x, e.y - s.y) < 9);
        }
      }

      // Move workers from crowded mineral lines to thin ones (e.g. to a newly finished base).
      function rebalance() {
        if (obs.tick % 32 !== 0) return;
        const lines = bases.filter(b => b.done).map(b => {
          const fields = obs.resources.filter(r => r.type === 'mineral' && d2(r, b) < 11);
          const on = workers.filter(w => w.order.type === 'gather' && fields.some(r => r.id === w.order.res));
          return { b, fields, on, ratio: fields.length ? on.length / fields.length : 99 };
        }).filter(l => l.fields.length);
        if (lines.length < 2) return;
        lines.sort((a, c) => a.ratio - c.ratio);
        const thin = lines[0], crowded = lines[lines.length - 1];
        if (thin.ratio >= 1.6 || crowded.ratio <= 2.2) return;
        const move = crowded.on.filter(w => !w.carry && !w.hidden).slice(0, Math.min(4, Math.ceil((crowded.ratio - thin.ratio) * thin.fields.length / 2)));
        const load = new Map(thin.fields.map(r => [r.id, thin.on.filter(w => w.order.res === r.id).length]));
        for (const w of move) {
          const r = thin.fields.sort((a, c) => load.get(a.id) - load.get(c.id))[0];
          load.set(r.id, load.get(r.id) + 1);
          cmds.push({ type: 'gather', units: [w.id], target: r.id });
        }
      }

      // After the opening scout: every minute or so, send a surveyor round base sites we haven't looked at
      // for a while, to find untouched minerals and enemy expansions. A flyer if we have one.
      function surveyStep() {
        if (!scoutDone || obs.tick < nextSurvey) return;
        let s = units.find(u => u.id === surveyorId);
        if (!s) {
          surveyorId = 0;
          const flyers = units.filter(u => UNITS[u.type].air);
          const cheap = units.filter(u => !UNITS[u.type].worker && !UNITS[u.type].air).sort((a, c) => UNITS[c.type].speed - UNITS[a.type].speed);
          s = flyers[0] || (units.filter(u => !UNITS[u.type].worker).length >= 6 ? cheap[0] : null) || (workers.length >= 14 ? pickBuilder(home) : null);
          if (!s) { nextSurvey = obs.tick + 16 * 20; return; }
          surveyorId = s.id;
          const stale = siteInfo.filter(t => obs.tick - t.lastSeen > 16 * 150 && !bases.some(b => d2(b, t) < 6));
          survey = [];
          let at = { x: s.x, y: s.y };
          while (survey.length < 4 && stale.length) {
            stale.sort((a, c) => d2(a, at) - d2(c, at));
            at = stale.shift(); survey.push(at);
          }
          if (!survey.length) { surveyorId = 0; nextSurvey = obs.tick + 16 * 45; return; }
        }
        survey = survey.filter(t => obs.tick - t.lastSeen > 16 * 10);
        if (!survey.length) { // route done: back to work
          cmds.push(UNITS[s.type].worker ? { type: 'stop', units: [s.id] } : { type: 'move', units: [s.id], x: rally.x, y: rally.y });
          surveyorId = 0; nextSurvey = obs.tick + 16 * 60;
          return;
        }
        const t = survey[0];
        if (s.order.type !== 'move' || Math.hypot(s.order.x - t.x, s.order.y - (t.y + 3)) > 1) cmds.push({ type: 'move', units: [s.id], x: t.x, y: t.y + 3 });
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

      // No enemy building known anywhere: split into search parties of ~4 and sweep the stalest parts of the map.
      function hunt(sendTo) {
        const parties = Math.max(1, Math.min(6, Math.floor(army.length / 4)));
        const sorted = army.slice().sort((a, b) => a.id - b.id);
        const age = (x, y) => obs.tick - seenAt[Math.floor(y / CELL) * CW + Math.floor(x / CELL)];
        huntTargets.length = Math.min(huntTargets.length, parties);
        for (let g = 0; g < parties; g++) {
          const members = sorted.filter((_, i) => i % parties === g);
          if (!members.length) continue;
          const c = { x: members.reduce((n, u) => n + u.x, 0) / members.length, y: members.reduce((n, u) => n + u.y, 0) / members.length };
          let t = huntTargets[g];
          if (!t || Math.hypot(c.x - t.x, c.y - t.y) < 6 || age(t.x, t.y) < 16 * 20) {
            let best = null, bestScore = -Infinity;
            for (let cy = 0; cy < CW; cy++) for (let cx = 0; cx < CW; cx++) {
              const x = cx * CELL + CELL / 2, y = cy * CELL + CELL / 2;
              if (!map.pass[Math.floor(y) * N + Math.floor(x)]) continue;
              if (huntTargets.some((o, j) => j !== g && o && Math.hypot(o.x - x, o.y - y) < 24)) continue; // spread the parties out
              const sc = Math.min(age(x, y), 16 * 600) - Math.hypot(x - c.x, y - c.y) * 6;
              if (sc > bestScore) { bestScore = sc; best = { x, y }; }
            }
            huntTargets[g] = t = best;
          }
          if (t) sendTo(t, 'attackMove', members);
        }
      }

      function chooseTarget(from) {
        const known = obs.enemies.filter(e => e.kind === 'building').concat(obs.remembered);
        if (known.length) {
          const t = known.sort((a, b) => d2(a, from) - d2(b, from))[0];
          return { x: t.x, y: t.y };
        }
        const unseen = map.starts.filter(s => d2(s, home) > 5 && !obs.explored[Math.floor(s.y) * N + Math.floor(s.x)]);
        if (unseen.length) return unseen.sort((a, b) => d2(a, from) - d2(b, from))[0];
        // hunt: bases not looked at for a while first, then the stalest part of the map, nearest first
        const age = (x, y) => obs.tick - seenAt[Math.floor(y / CELL) * CW + Math.floor(x / CELL)];
        const stale = map.bases.filter(b => age(b.x, b.y) > 16 * 90);
        if (stale.length) return stale.sort((a, b) => d2(a, from) - d2(b, from))[0];
        let best = null, bestScore = -Infinity;
        for (let cy = 0; cy < CW; cy++) for (let cx = 0; cx < CW; cx++) {
          const x = cx * CELL + CELL / 2, y = cy * CELL + CELL / 2;
          if (!map.pass[Math.floor(y) * N + Math.floor(x)]) continue;
          const sc = age(x, y) - Math.hypot(x - from.x, y - from.y) * 8;
          if (sc > bestScore) { bestScore = sc; best = { x, y }; }
        }
        return best;
      }

      function fight() {
        if (!army.length) return;
        const cx = army.reduce((s, u) => s + u.x, 0) / army.length, cy = army.reduce((s, u) => s + u.y, 0) / army.length;
        const sendTo = (pt, type = 'attackMove', group = army) => {
          const who = group.filter(u => (u.order.type !== type || Math.hypot((u.order.x ?? 1e9) - pt.x, (u.order.y ?? 1e9) - pt.y) > 2.5) && (restWorker.get(u.id) || 0) <= obs.tick);
          for (const u of who) if (u.order.type === 'idle' && obs.tick - (orderedAt.get(u.id) ?? -1e9) < 32) restWorker.set(u.id, obs.tick + 16 * 20); // can't get there: back off
          const go = who.filter(u => (restWorker.get(u.id) || 0) <= obs.tick);
          for (const u of go) orderedAt.set(u.id, obs.tick);
          if (go.length) cmds.push({ type, units: go.map(u => u.id), x: pt.x, y: pt.y });
        };
        if (threats.length) {
          const t = threats.sort((a, b) => d2(a, home) - d2(b, home))[0];
          const idle = army.filter(u => u.order.type !== 'attack');
          if (idle.length) sendTo({ x: t.x, y: t.y });
          return;
        }
        const rested = !S.attackAfter || (obs.tick >= S.attackAfter * 16 && obs.tick >= restUntil);
        const maxed = obs.supplyUsed >= Math.min(obs.supplyCap, obs.supplyMax) - 3 && obs.supplyCap >= obs.supplyMax - 4; // can't grow: go with what we have
        if (!attacking && (army.length >= wave || (maxed && army.length >= 6)) && rested) { attacking = true; target = null; }
        if (attacking) {
          if (army.length < Math.max(3, Math.min(wave, maxed ? army.length + 1 : wave) * 0.35)) {
            attacking = false; wave = Math.min(S.maxWave || 40, wave + S.waveGrowth); target = null;
            if (S.restAfter) restUntil = obs.tick + S.restAfter * 16;
            sendTo(rally, 'move');
            return;
          }
          const knownB = obs.enemies.some(e => e.kind === 'building') || obs.remembered.length;
          if (!knownB && map.starts.every(s => d2(s, home) <= 5 || obs.explored[Math.floor(s.y) * N + Math.floor(s.x)])) { hunt(sendTo); return; }
          huntTargets.length = 0;
          const arrived = target && Math.hypot(cx - target.x, cy - target.y) < 5 && !obs.enemies.some(e => Math.hypot(e.x - target.x, e.y - target.y) < 10);
          const known = obs.enemies.some(e => e.kind === 'building') || obs.remembered.length;
          if (!target || arrived || (known && obs.tick % 64 === 0)) target = chooseTarget({ x: cx, y: cy });
          if (target) sendTo(target);
          return;
        }
        const far = army.filter(u => u.order.type === 'idle' && Math.hypot(u.x - rally.x, u.y - rally.y) > 5);
        if (far.length) cmds.push({ type: 'move', units: far.map(u => u.id), x: rally.x, y: rally.y });
      }
    },
  };
}
