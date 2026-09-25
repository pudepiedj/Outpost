// Deterministic game simulation. No drawing, no DOM: runs in the browser or headless in Node.
//
//   const state = createGame({ seed, slots: [{faction:'vanguard'}, {faction:'swarm'}, null] });
//   issue(state, player, command);   // from a human UI or a bot
//   step(state);                      // advance one tick (1/16 s)
//   observe(state, player);           // fog-filtered view: all a bot is ever given

import {
  TICK_RATE, DT, MAX_SUPPLY, SUPPLY_PER_BASE, FACTIONS, UNITS, BUILDINGS, MAP_SIZES, def,
  MINE_TIME, MINE_AMOUNT, GAS_TIME, GAS_AMOUNT, LARVA_TIME, LARVA_MAX,
  SHIELD_REGEN, SHIELD_DELAY, QUEUE_MAX, REPAIR_COST, COLONY_SHIELD, FORD_SPEED, WEATHER, WEATHER_CALM_START, canHit,
} from './data.js';
import { generateMap, mulberry32, HIGH, DECO_FORD } from './map.js';
import { createPathfinder, lineWalkable } from './path.js';
import { checkPlacement, isPowered } from './rules.js';

export { TICK_RATE };

// ---------------------------------------------------------------- setup

export function createGame({ seed = 1, slots, mapSize = 'medium' }) {
  const ms = MAP_SIZES[mapSize] || MAP_SIZES.medium;
  const map = generateMap(seed, ms.size, ms.starts);
  const N = map.size;
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const state = {
    tick: 0, seed, rng, map, N, mapSize,
    ents: new Map(), nextId: 1,
    occ: new Int32Array(N * N),
    walk: new Uint8Array(N * N),
    players: [],
    events: [], inbox: [], // inbox: events raised by commands between ticks, delivered with the next tick
    over: false, winner: -1,
    pf: createPathfinder(N),
    circles: new Map(),
    weather: { type: 'clear', until: WEATHER_CALM_START * TICK_RATE, next: null }, wrng: mulberry32(seed ^ 0x5eed1e55),
  };
  state.weather.next = rollWeather(state, 'clear');
  for (let i = 0; i < N * N; i++) state.walk[i] = map.pass[i];
  state.slow = map.deco.map(d => (d === DECO_FORD ? 1 : 0)); // fords cost the pathfinder extra
  state.region = labelRegions(map);
  state.pathCache = new Map();

  for (const r of map.resources) {
    const e = addEntity(state, {
      kind: 'resource', type: r.type, owner: -1, tx: r.tx, ty: r.ty, w: r.w, h: r.h,
      x: r.tx + r.w / 2, y: r.ty + r.h / 2, amount: r.amount, building: 0, miner: 0,
    });
    stampOcc(state, e.tx, e.ty, e.w, e.h, e.id);
  }

  // Randomly assign start locations to slots (on bigger maps some are left empty)
  const order = map.starts.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }

  for (let p = 0; p < 3; p++) {
    const slot = slots[p];
    const player = {
      id: p, active: !!slot, alive: !!slot, faction: slot ? slot.faction : null,
      minerals: 50, gas: 0, supplyUsed: 0, supplyCap: 0,
      visible: new Uint8Array(N * N), explored: new Uint8Array(N * N),
      memory: new Map(), start: null, lastAttackMsg: -1e9, dome: null,
      stats: { mined: 0, gasMined: 0, unitsBuilt: 0, kills: 0, losses: 0 },
    };
    state.players.push(player);
    if (!slot) continue;
    const f = FACTIONS[slot.faction];
    const s = map.starts[order[p]];
    player.start = { x: s.x, y: s.y };
    const bdef = BUILDINGS[f.base];
    const b = createBuilding(state, p, f.base, Math.floor(s.x) - 1, Math.floor(s.y) - 1);
    b.done = true; b.progress = bdef.time; b.hp = b.maxHp; b.shield = b.maxShield;
    for (let i = 0; i < 4; i++) {
      const u = spawnUnit(state, p, f.worker, b);
      const m = nearestResource(state, u.x, u.y, 'mineral', 10);
      if (m) setOrder(u, { type: 'gather', res: m.id, phase: 'toRes' });
    }
  }
  updateSupply(state);
  updateVisibility(state);
  return state;
}

// Label the areas you can walk between (terrain only, buildings ignored), so impossible routes fail fast.
function labelRegions(map) {
  const N = map.size, lab = new Int32Array(N * N);
  let next = 0;
  for (let s = 0; s < N * N; s++) {
    if (lab[s] || !map.pass[s]) continue;
    const id = ++next, stack = [s]; lab[s] = id;
    while (stack.length) {
      const t = stack.pop(), x = t % N, y = (t / N) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy, n = ny * N + nx;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N || lab[n] || !map.pass[n] || Math.abs(map.elev[t] - map.elev[n]) > 1) continue;
        lab[n] = id; stack.push(n);
      }
    }
  }
  return lab;
}

function addEntity(state, e) {
  e.id = state.nextId++;
  e.dead = false;
  state.ents.set(e.id, e);
  return e;
}

function stampOcc(state, tx, ty, w, h, id) {
  const N = state.N;
  if (state.pathCache) state.pathCache.clear();
  for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) {
    const i = y * N + x;
    state.occ[i] = id;
    state.walk[i] = id ? 0 : state.map.pass[i];
  }
}

function createBuilding(state, owner, type, tx, ty) {
  const d = BUILDINGS[type];
  const b = addEntity(state, {
    kind: 'building', type, owner, tx, ty, size: d.size,
    x: tx + d.size / 2, y: ty + d.size / 2,
    maxHp: d.hp, hp: d.hp * 0.1, maxShield: d.shield || 0, shield: 0, armor: d.armor || 0,
    done: false, progress: 0, lastBuilt: -1, lastHit: -1e9,
    queue: [], prodProgress: 0, rally: null, powered: true,
    larva: d.larva ? LARVA_MAX : 0, larvaTimer: 0, eggs: [],
    geyser: 0, gasBusyUntil: 0, cooldown: 0, target: 0, facing: Math.PI * 0.8, rechargeUntil: 0,
  });
  if (d.onGeyser) {
    const g = state.ents.get(state.occ[ty * state.N + tx]);
    if (g && g.kind === 'resource') { b.geyser = g.id; g.building = b.id; }
  }
  stampOcc(state, tx, ty, d.size, d.size, b.id);
  return b;
}

function spawnUnit(state, owner, type, near, towards) {
  const d = UNITS[type];
  const [x, y] = freeSpotNear(state, near, towards);
  const u = addEntity(state, {
    kind: 'unit', type, owner, x, y, px: x, py: y,
    maxHp: d.hp, hp: d.hp, maxShield: d.shield || 0, shield: d.shield || 0, armor: d.armor || 0,
    radius: d.radius, order: { type: 'idle' }, target: 0, cooldown: 0,
    path: null, pathI: 0, pathGoal: null, repathAt: 0, stuck: 0, lastPos: [x, y], lastHit: -1e9,
    carry: null, hidden: false, facing: 0, resume: null, air: !!d.air,
  });
  state.players[owner].stats.unitsBuilt++;
  return u;
}

// Find a walkable tile adjacent to a building (or around a point), nearest to `towards`.
function freeSpotNear(state, near, towards) {
  const N = state.N;
  const s = near.size || 1, tx0 = near.tx ?? Math.floor(near.x), ty0 = near.ty ?? Math.floor(near.y);
  const tgt = towards || { x: near.x, y: near.y + s };
  // only ground connected to where the building (or unit) stands: never a walled-off pocket beside it
  const home = state.region && tx0 >= 0 && ty0 >= 0 && tx0 < N && ty0 < N ? state.region[ty0 * N + tx0] : 0;
  for (let r = 1; r < 12; r++) {
    let best = null, bestD = Infinity;
    for (let y = ty0 - r; y < ty0 + s + r; y++) for (let x = tx0 - r; x < tx0 + s + r; x++) {
      if (x > tx0 - r && x < tx0 + s + r - 1 && y > ty0 - r && y < ty0 + s + r - 1) continue;
      if (x < 0 || y < 0 || x >= N || y >= N || !state.walk[y * N + x]) continue;
      if (home && state.region[y * N + x] !== home && r < 6) continue;
      const d = Math.hypot(x + 0.5 - tgt.x, y + 0.5 - tgt.y);
      if (d < bestD) { bestD = d; best = [x, y]; }
    }
    if (best) {
      const j = () => (state.rng() - 0.5) * 0.4;
      return [best[0] + 0.5 + j(), best[1] + 0.5 + j()];
    }
  }
  return [near.x, near.y];
}

// ---------------------------------------------------------------- queries

const tileOf = (state, x, y) => Math.floor(y) * state.N + Math.floor(x);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Edge-to-edge distance between a unit and any entity.
function gap(u, e) {
  if (e.kind === 'unit') return dist(u, e) - u.radius - e.radius;
  const w = e.kind === 'building' ? e.size : e.w, h = e.kind === 'building' ? e.size : e.h;
  const dx = Math.max(Math.abs(u.x - e.x) - w / 2, 0), dy = Math.max(Math.abs(u.y - e.y) - h / 2, 0);
  return Math.hypot(dx, dy) - u.radius;
}

export function isVisibleTo(state, p, e) {
  if (e.owner === p) return true;
  // a raised colony shield gives away its generator to anyone who can see the dome
  if (state.domesUp && e.kind === 'building' && e.owner >= 0) { const dm = state.players[e.owner].dome; if (dm && dm.gen === e.id && dm.seen[p]) return true; }
  const vis = state.players[p].visible, N = state.N;
  if (e.kind === 'unit') return !e.hidden && vis[tileOf(state, e.x, e.y)] === 1;
  const w = e.size || e.w, h = e.size || e.h;
  for (let y = e.ty; y < e.ty + h; y++) for (let x = e.tx; x < e.tx + w; x++) if (vis[y * N + x]) return true;
  return false;
}

function isExploredBy(state, p, e) {
  const ex = state.players[p].explored, N = state.N;
  for (let y = e.ty; y < e.ty + e.h; y++) for (let x = e.tx; x < e.tx + e.w; x++) if (ex[y * N + x]) return true;
  return false;
}

function nearestResource(state, x, y, type, maxD) {
  let best = null, bestD = maxD;
  for (const e of state.ents.values()) {
    if (e.kind !== 'resource' || e.type !== type || e.dead) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function nearestDropoff(state, p, x, y) {
  let best = null, bestD = Infinity;
  for (const e of state.ents.values()) {
    if (e.kind !== 'building' || e.owner !== p || !e.done || !BUILDINGS[e.type].dropoff) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

function ownBuildings(state, p) {
  const out = [];
  for (const e of state.ents.values()) if (e.kind === 'building' && e.owner === p) out.push(e);
  return out;
}

function hasDone(state, p, type) {
  for (const e of state.ents.values()) if (e.kind === 'building' && e.owner === p && e.type === type && e.done) return true;
  return false;
}

function requirementsMet(state, p, type) {
  return (def(type).requires || []).every(r => hasDone(state, p, r));
}

export function placementCtx(state, p) {
  const N = state.N, pl = state.players[p];
  return {
    map: state.map,
    blocked: (x, y) => state.occ[y * N + x] !== 0,
    ownBuildings: ownBuildings(state, p),
    geysers: [...state.ents.values()].filter(e => e.kind === 'resource' && e.type === 'geyser')
      .map(g => ({ id: g.id, tx: g.tx, ty: g.ty, taken: !!g.building })),
    resources: [...state.ents.values()].filter(e => e.kind === 'resource'),
    explored: (x, y) => pl.explored[y * N + x] === 1,
    start: pl.start,
  };
}

// ---------------------------------------------------------------- commands

function msg(state, p, text) { state.inbox.push({ type: 'msg', player: p, text }); }

function setOrder(u, order) {
  u.order = order;
  u.target = order.type === 'attack' ? order.target : 0;
  u.path = null; u.stuck = 0;
  if (u.hidden && order.type !== 'gather') u.hidden = false;
}

export function issue(state, p, cmd) {
  const pl = state.players[p];
  if (!pl || !pl.alive || state.over) return false;
  const ents = state.ents;
  const mine = (cmd.units || []).map(id => ents.get(id)).filter(u => u && !u.dead && u.kind === 'unit' && u.owner === p);
  const target = cmd.target ? ents.get(cmd.target) : null;
  const n = mine.length;

  switch (cmd.type) {
    case 'move':
    case 'attackMove':
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return false;
      for (const u of mine) setOrder(u, { type: cmd.type, x: cmd.x, y: cmd.y, group: n });
      return n > 0;
    case 'stop':
      for (const u of mine) setOrder(u, { type: 'idle' });
      return n > 0;
    case 'hold':
      for (const u of mine) setOrder(u, { type: 'hold' });
      return n > 0;
    case 'attack': {
      if (!target || target.dead || target.kind === 'resource' || !isVisibleTo(state, p, target)) return false;
      for (const u of mine) if (target.id !== u.id) setOrder(u, { type: 'attack', target: target.id });
      return n > 0;
    }
    case 'repair': {
      // a worker restores an own finished building; Vanguard engineers also fix mechanical units
      if (!target || target.dead || target.owner !== p) return false;
      const ok = target.kind === 'building' ? target.done : target.kind === 'unit' && UNITS[target.type].mech && FACTIONS[pl.faction].buildStyle === 'construct';
      if (!ok) { msg(state, p, target.kind === 'building' ? 'Finish the building first' : "Can't repair that"); return false; }
      if (target.hp >= target.maxHp) { msg(state, p, 'Already fully repaired'); return false; }
      let any = false;
      for (const u of mine) {
        if (!UNITS[u.type].worker || u === target) continue;
        const resume = u.order.type === 'gather' ? { res: u.order.res } : u.order.type === 'repair' ? u.resume : null;
        setOrder(u, { type: 'repair', target: target.id }); u.resume = resume; any = true;
      }
      return any;
    }
    case 'gather': {
      // target: a mineral patch, or an own finished gas building
      if (!target || target.dead) return false;
      let res = null;
      if (target.kind === 'resource' && target.type === 'mineral' && isExploredBy(state, p, target)) res = target;
      if (target.kind === 'building' && target.owner === p && BUILDINGS[target.type].onGeyser && target.done) res = target;
      if (!res) return false;
      for (const u of mine) {
        if (!UNITS[u.type].worker) { setOrder(u, { type: 'move', x: res.x, y: res.y, group: n }); continue; }
        const phase = u.carry && ((u.carry.kind === 'gas') === (res.kind === 'building')) ? 'toDrop' : 'toRes';
        setOrder(u, { type: 'gather', res: res.id, phase });
      }
      return n > 0;
    }
    case 'returnCargo':
      for (const u of mine) if (u.carry) setOrder(u, { type: 'gather', res: u.order.res || 0, phase: 'toDrop' });
      return n > 0;
    case 'build': {
      const u = mine[0];
      const d = BUILDINGS[cmd.btype];
      if (!u || !d || d.faction !== pl.faction || !UNITS[u.type].worker) return false;
      if (!requirementsMet(state, p, cmd.btype)) { msg(state, p, `Requires ${d.requires.map(r => BUILDINGS[r].name).join(', ')}`); return false; }
      if (pl.minerals < d.cost[0]) { msg(state, p, 'Not enough minerals'); return false; }
      if (pl.gas < d.cost[1]) { msg(state, p, 'Not enough gas'); return false; }
      const chk = checkPlacement(placementCtx(state, p), cmd.btype, cmd.tx | 0, cmd.ty | 0);
      if (!chk.ok) { msg(state, p, chk.reason); return false; }
      if (d.dome && [...ents.values()].some(w => w.kind === 'unit' && w.owner === p && w !== u && w.order.type === 'build' && w.order.btype === cmd.btype)) { msg(state, p, `Only one ${d.name} at a time`); return false; }
      const resume = u.order.type === 'gather' ? { res: u.order.res } : null;
      setOrder(u, { type: 'build', btype: cmd.btype, tx: cmd.tx | 0, ty: cmd.ty | 0, phase: 'toSite', bid: 0 });
      u.resume = resume;
      return true;
    }
    case 'resume': {
      // Vanguard: send engineers to continue an unfinished building
      if (!target || target.dead || target.kind !== 'building' || target.owner !== p || target.done) return false;
      if (FACTIONS[pl.faction].buildStyle !== 'construct') return false;
      const u = mine.find(u => UNITS[u.type].worker);
      if (!u) return false;
      setOrder(u, { type: 'build', btype: target.type, tx: target.tx, ty: target.ty, phase: 'toSite', bid: target.id });
      return true;
    }
    case 'train': {
      const b = ents.get(cmd.building);
      const d = UNITS[cmd.utype];
      if (!b || b.dead || b.kind !== 'building' || b.owner !== p || !b.done || !d) return false;
      const bd = BUILDINGS[b.type];
      if (!(bd.produces || []).includes(cmd.utype)) return false;
      if (!requirementsMet(state, p, cmd.utype)) { msg(state, p, `Requires ${d.requires.map(r => BUILDINGS[r].name).join(', ')}`); return false; }
      if (bd.needsPower && !b.powered) { msg(state, p, 'Building is unpowered'); return false; }
      const supply = d.supply * (d.count || 1);
      if (pl.minerals < d.cost[0]) { msg(state, p, 'Not enough minerals'); return false; }
      if (pl.gas < d.cost[1]) { msg(state, p, 'Not enough gas'); return false; }
      if (pl.supplyUsed + supply > pl.supplyCap + 1e-9) { msg(state, p, pl.supplyCap >= pl.supplyMax ? (pl.supplyMax < (MAP_SIZES[state.mapSize] || MAP_SIZES.medium).supplyMax ? 'Supply maximum reached: hold more bases to raise it' : 'Supply maximum reached') : 'Not enough supply — build more ' + BUILDINGS[FACTIONS[pl.faction].supply].name + 's'); return false; }
      if (bd.larva) {
        if (b.larva <= 0) { msg(state, p, 'No larvae available'); return false; }
        b.larva--; b.eggs.push({ type: cmd.utype, t: 0 });
      } else {
        if (b.queue.length >= QUEUE_MAX) { msg(state, p, 'Queue is full'); return false; }
        b.queue.push(cmd.utype);
      }
      pl.minerals -= d.cost[0]; pl.gas -= d.cost[1];
      pl.supplyUsed += supply;
      return true;
    }
    case 'cancel': {
      const b = ents.get(cmd.building);
      if (!b || b.dead || b.owner !== p || b.kind !== 'building') return false;
      if (!b.done) {
        const d = BUILDINGS[b.type];
        pl.minerals += Math.floor(d.cost[0] * 0.75); pl.gas += Math.floor(d.cost[1] * 0.75);
        killEntity(state, b, -1, true);
        return true;
      }
      if (b.queue.length) {
        const t = b.queue.pop(); const d = UNITS[t];
        pl.minerals += d.cost[0]; pl.gas += d.cost[1];
        if (!b.queue.length) b.prodProgress = 0;
        return true;
      }
      if (b.eggs.length) {
        const eg = b.eggs.pop(); const d = UNITS[eg.type];
        pl.minerals += d.cost[0]; pl.gas += d.cost[1]; b.larva = Math.min(LARVA_MAX, b.larva + 1);
        return true;
      }
      return false;
    }
    case 'shield': {
      const b = ents.get(cmd.building);
      if (!b || b.dead || b.owner !== p || b.kind !== 'building' || !BUILDINGS[b.type].dome || !b.done) return false;
      if (pl.dome) { msg(state, p, 'The colony shield is already up'); return false; }
      if (state.tick < b.rechargeUntil) { msg(state, p, `Shield generator recharging (${Math.ceil((b.rechargeUntil - state.tick) / TICK_RATE)} s)`); return false; }
      raiseDome(state, p, b);
      return true;
    }
    case 'rally': {
      const b = ents.get(cmd.building);
      if (!b || b.dead || b.owner !== p || b.kind !== 'building') return false;
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return false;
      const res = target && target.kind === 'resource' && target.type === 'mineral' ? target.id : 0;
      b.rally = { x: cmd.x, y: cmd.y, res };
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- tick

export function step(state) {
  if (state.over) return;
  state.events = state.inbox; state.inbox = [];
  state.tick++;
  const units = [], buildings = [];
  for (const e of state.ents.values()) {
    if (e.kind === 'unit') units.push(e); else if (e.kind === 'building') buildings.push(e);
  }
  for (const b of buildings) if (b.owner >= 0) b.powered = !BUILDINGS[b.type].needsPower || isPowered(ownBuildingsCache(state, b.owner, buildings), b.x, b.y);
  for (const u of units) { u.px = u.x; u.py = u.y; }
  for (const u of units) if (!u.dead) updateUnit(state, u);
  separate(state, units);
  for (const b of buildings) if (!b.dead) updateBuilding(state, b);
  regen(state, units, buildings);
  updateDomes(state);
  updateWeather(state);
  removeDead(state);
  updateSupply(state);
  if (state.tick % 2 === 0) updateVisibility(state);
  if (state.tick % TICK_RATE === 0) checkElimination(state);
  state._ownCache = null;
}

function ownBuildingsCache(state, p, buildings) {
  state._ownCache ||= new Map();
  if (!state._ownCache.has(p)) state._ownCache.set(p, buildings.filter(b => b.owner === p));
  return state._ownCache.get(p);
}

// ---- units

function updateUnit(state, u) {
  const d = UNITS[u.type];
  u.cooldown = Math.max(0, u.cooldown - DT);
  // Pushed onto a blocked tile (e.g. a building appeared)? Pop out.
  if (!u.air && !u.hidden && !state.walk[tileOf(state, u.x, u.y)]) {
    const [x, y] = freeSpotNear(state, { x: u.x, y: u.y, tx: Math.floor(u.x), ty: Math.floor(u.y), size: 1 }, u);
    u.x = x; u.y = y; u.path = null;
  }
  const o = u.order;
  switch (o.type) {
    case 'idle':
    case 'hold':
      if (!d.worker) combat(state, u, o.type === 'hold' ? d.range + 0.5 : d.sight, o.type !== 'hold');
      else if (u.target) combat(state, u, d.sight, true);
      break;
    case 'move': {
      const r = moveTo(state, u, o.x, o.y, 0.2 + 0.32 * Math.sqrt(o.group || 1));
      if (r !== 'moving') setOrder(u, { type: 'idle' });
      break;
    }
    case 'attackMove': {
      if (combat(state, u, d.sight, true)) break;
      const r = moveTo(state, u, o.x, o.y, 0.2 + 0.32 * Math.sqrt(o.group || 1));
      if (r !== 'moving') setOrder(u, { type: 'idle' });
      break;
    }
    case 'attack': {
      const t = state.ents.get(o.target);
      if (!t || t.dead || !isVisibleTo(state, u.owner, t)) { setOrder(u, { type: 'idle' }); break; }
      u.target = t.id;
      if (canHit(d, t)) engage(state, u, t, true);
      else if (moveTo(state, u, t.x, t.y, 2, true) === 'failed') setOrder(u, { type: 'idle' }); // can't shoot it: follow it
      break;
    }
    case 'repair': repairStep(state, u, o); break;
    case 'gather': gatherStep(state, u, o); break;
    case 'build': buildStep(state, u, o); break;
  }
}

// Acquire/keep a target and fight it. Returns true while busy fighting.
function combat(state, u, radius, chase) {
  const d = UNITS[u.type];
  let t = u.target ? state.ents.get(u.target) : null;
  if (t && (t.dead || !isVisibleTo(state, u.owner, t) || reach(state, u, t) > d.sight + 2 || !canHit(d, t))) { t = null; u.target = 0; }
  if (!t && (state.tick + u.id) % 4 === 0) {
    t = findTarget(state, u, radius);
    if (t) u.target = t.id;
  }
  if (!t) return false;
  if (!chase && reach(state, u, t) > d.range + 0.05) { u.target = 0; return false; }
  engage(state, u, t, chase);
  return true;
}

function findTarget(state, u, radius) {
  const d = UNITS[u.type];
  let best = null, bestScore = Infinity;
  for (const e of state.ents.values()) {
    if (e.dead || e.owner < 0 || e.owner === u.owner || e.kind === 'resource' || !canHit(d, e)) continue;
    if (Math.abs(e.x - u.x) > radius + 3 || Math.abs(e.y - u.y) > radius + 3) continue;
    const g = reach(state, u, e);
    if (g > radius || !isVisibleTo(state, u.owner, e)) continue;
    // prefer things that can shoot back, then the nearest
    const threat = (e.kind === 'unit' && UNITS[e.type].damage && !UNITS[e.type].worker) || (e.kind === 'building' && BUILDINGS[e.type].damage) ? 0 : e.kind === 'unit' ? 4 : 8;
    const score = g + threat;
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

function engage(state, u, t, chase) {
  const d = UNITS[u.type];
  const g = reach(state, u, t);
  u.facing = Math.atan2(t.y - u.y, t.x - u.x);
  if (g <= d.range + 0.05) {
    u.path = null;
    if (u.cooldown <= 0) { fire(state, u, t); u.cooldown = d.cooldown; }
  } else if (chase) {
    moveTo(state, u, t.x, t.y, 0, true);
  }
}

// Distance a unit must close to hit t: to t itself, or to the enemy dome wall shielding it.
function reach(state, u, t) {
  const g = gap(u, t);
  const dm = state.domesUp && shieldingDome(state, u, t);
  return dm ? Math.min(g, Math.hypot(u.x - dm.x, u.y - dm.y) - dm.r - u.radius) : g;
}

function fire(state, u, t) {
  const d = def(u.type);
  const dm = state.domesUp && shieldingDome(state, u, t);
  if (dm) return hitDome(state, u, t, dm, d);
  state.events.push({ type: 'shot', from: u.id, fx: u.x, fy: u.y, tx: t.x, ty: t.y, owner: u.owner, unit: u.type, ranged: !!d.ranged, splash: !!d.splash, fair: !!u.air, tair: !!t.air });
  damage(state, t, d.damage, u);
  if (d.splash) {
    for (const e of state.ents.values()) {
      if (e === t || e.dead || e.kind !== 'unit' || e.owner === u.owner || e.owner < 0 || e.air !== t.air) continue;
      if (Math.hypot(e.x - t.x, e.y - t.y) <= d.splash + e.radius) damage(state, e, d.damage * 0.5, u);
    }
  }
}

function damage(state, e, amount, src) {
  e.lastHit = state.tick;
  if (e.shield > 0) {
    const s = Math.min(e.shield, amount);
    e.shield -= s; amount -= s;
    if (amount <= 0) return afterHit(state, e, src);
  }
  e.hp -= Math.max(0.5, amount - (e.armor || 0));
  afterHit(state, e, src);
}

function afterHit(state, e, src) {
  const pl = state.players[e.owner];
  if (state.tick - pl.lastAttackMsg > TICK_RATE * 12) {
    pl.lastAttackMsg = state.tick;
    state.events.push({ type: 'attacked', player: e.owner, x: e.x, y: e.y });
  }
  // Idle or harvesting units fight back / call nearby friends
  if (e.kind === 'unit' && src && !e.target && (e.order.type === 'idle') && !UNITS[e.type].worker && canHit(UNITS[e.type], src)) e.target = src.id;
  if (e.hp <= 0) killEntity(state, e, src ? src.owner : -1);
}

function killEntity(state, e, killer, silent) {
  if (e.dead) return;
  e.dead = true;
  if (!silent) state.events.push({ type: 'death', x: e.x, y: e.y, kind: e.kind, size: e.size || e.radius * 2, owner: e.owner, etype: e.type });
  if (killer >= 0 && killer !== e.owner) state.players[killer].stats.kills++;
  if (e.owner >= 0) state.players[e.owner].stats.losses++;
}

function removeDead(state) {
  for (const e of state.ents.values()) {
    if (!e.dead) continue;
    state.ents.delete(e.id);
    if (e.kind === 'building') {
      stampOcc(state, e.tx, e.ty, e.size, e.size, 0);
      if (e.geyser) {
        const g = state.ents.get(e.geyser);
        if (g) { g.building = 0; stampOcc(state, g.tx, g.ty, g.w, g.h, g.id); }
      }
    } else if (e.kind === 'resource') {
      stampOcc(state, e.tx, e.ty, e.w, e.h, 0);
    }
  }
  // Units hidden inside a destroyed gas building pop out
  for (const u of state.ents.values()) {
    if (u.kind === 'unit' && u.hidden && u.order.type === 'gather' && !state.ents.get(u.order.res)) { u.hidden = false; setOrder(u, { type: 'idle' }); }
  }
}

// Workers walk the same long trips again and again: reuse a route between the same two tiles for a while.
// Any change to buildings (stampOcc) clears the cache.
function cachedPath(state, x, y, gx, gy) {
  const N = state.N, s = tileOf(state, x, y), g = tileOf(state, gx, gy);
  if (Math.hypot(gx - x, gy - y) < 20) return state.pf.find(state.walk, state.map.elev, x, y, gx, gy, undefined, state.slow, state.region);
  const key = s * N * N + g, hit = state.pathCache.get(key);
  if (hit && state.tick - hit.t < 16 * 60) { const p = hit.path.map(q => q.slice()); p.partial = hit.path.partial; if (p.length) p[p.length - 1] = hit.path.partial ? p[p.length - 1] : [gx, gy]; return p; }
  const path = state.pf.find(state.walk, state.map.elev, x, y, gx, gy, undefined, state.slow, state.region);
  if (path) { if (state.pathCache.size > 4000) state.pathCache.clear(); state.pathCache.set(key, { t: state.tick, path }); }
  return path;
}

// Path-following movement. Returns 'arrived', 'moving' or 'failed'.
function moveTo(state, u, gx, gy, arrive, chasing) {
  const dGoal = Math.hypot(gx - u.x, gy - u.y);
  if (dGoal <= arrive + 0.05) { u.path = null; return 'arrived'; }
  const W = WEATHER[state.weather.type];
  if (u.air) { // flyers ignore terrain and buildings
    const k = Math.min(1, UNITS[u.type].speed * W.airSpeed * DT / dGoal);
    u.facing = Math.atan2(gy - u.y, gx - u.x);
    tryMove(state, u, u.x + (gx - u.x) * k, u.y + (gy - u.y) * k);
    u.path = [[gx, gy]];
    return 'moving';
  }
  const N = state.N;
  const needPath = !u.path || !u.pathGoal || Math.hypot(u.pathGoal[0] - gx, u.pathGoal[1] - gy) > (chasing ? 1.5 : 0.01) || state.tick >= u.repathAt;
  if (needPath) {
    if (lineWalkable(state.walk, state.map.elev, N, u.x, u.y, gx, gy) && state.walk[tileOf(state, gx, gy)]) u.path = [[gx, gy]];
    else u.path = cachedPath(state, u.x, u.y, gx, gy);
    u.pathI = 0; u.pathGoal = [gx, gy];
    u.repathAt = state.tick + (chasing ? 24 : 96) + (u.id % 8);
    if (!u.path || !u.path.length) { u.path = null; return 'failed'; }
  }
  // string-pulling: skip to the farthest directly-reachable waypoint
  while (u.pathI + 1 < u.path.length && (state.tick + u.id) % 3 === 0) {
    const [nx, ny] = u.path[u.pathI + 1];
    if (!lineWalkable(state.walk, state.map.elev, N, u.x, u.y, nx, ny)) break;
    u.pathI++;
  }
  let [wx, wy] = u.path[u.pathI];
  const last = u.pathI === u.path.length - 1;
  if (!last && Math.hypot(wx - u.x, wy - u.y) < 0.35) { u.pathI++;[wx, wy] = u.path[u.pathI]; }
  const sp = UNITS[u.type].speed * W.speed * (state.map.deco[tileOf(state, u.x, u.y)] === DECO_FORD ? FORD_SPEED : 1) * DT;
  const dx = wx - u.x, dy = wy - u.y, dd = Math.hypot(dx, dy);
  if (dd > 1e-6) {
    u.facing = Math.atan2(dy, dx);
    const k = Math.min(1, sp / dd);
    tryMove(state, u, u.x + dx * k, u.y + dy * k);
  }
  if (last && dd <= sp + 0.01) {
    if (Math.hypot(gx - u.x, gy - u.y) <= arrive + 0.35) { u.path = null; return 'arrived'; }
    // path ended short of the goal: a long route cut off by the search budget carries on from here
    const partial = u.path.partial;
    u.path = null;
    return chasing || partial ? 'moving' : 'failed';
  }
  // stuck detection
  if (state.tick % 16 === u.id % 16) {
    const moved = Math.hypot(u.x - u.lastPos[0], u.y - u.lastPos[1]);
    u.lastPos = [u.x, u.y];
    if (moved < 0.15) { u.stuck++; u.path = null; if (u.stuck > 4) { u.stuck = 0; return chasing ? 'moving' : 'failed'; } }
    else u.stuck = 0;
  }
  return 'moving';
}

function canOccupy(state, fromX, fromY, x, y) {
  const N = state.N;
  if (x < 0 || y < 0 || x >= N || y >= N) return false;
  const a = tileOf(state, fromX, fromY), b = tileOf(state, x, y);
  if (!state.walk[b]) return false;
  return Math.abs(state.map.elev[a] - state.map.elev[b]) <= 1;
}

function tryMove(state, u, nx, ny) {
  if (state.domesUp && domeBlocks(state, u, nx, ny)) return false;
  if (u.air) { const N = state.N; u.x = Math.max(0.5, Math.min(N - 0.5, nx)); u.y = Math.max(0.5, Math.min(N - 0.5, ny)); return true; }
  if (canOccupy(state, u.x, u.y, nx, ny)) { u.x = nx; u.y = ny; return true; }
  if (canOccupy(state, u.x, u.y, nx, u.y)) { u.x = nx; return true; }
  if (canOccupy(state, u.x, u.y, u.x, ny)) { u.y = ny; return true; }
  return false;
}

// Soft collision between ground units. Harvesting workers pass through each other.
function separate(state, units) {
  const cell = 2, W = Math.ceil(state.N / cell);
  const grid = new Map();
  const ghost = u => u.hidden || (u.order.type === 'gather');
  const air = units.filter(u => u.air && !u.dead);
  for (let i = 0; i < air.length; i++) for (let j = i + 1; j < air.length; j++) {
    const u = air[i], v = air[j];
    let dx = v.x - u.x, dy = v.y - u.y, d = Math.hypot(dx, dy);
    const min = (u.radius + v.radius) * 0.8;
    if (d >= min) continue;
    if (d < 1e-4) { dx = 1; dy = ((u.id * 7) % 5) - 2; d = Math.hypot(dx, dy); }
    const push = (min - d) * 0.25;
    tryMove(state, u, u.x - dx / d * push, u.y - dy / d * push); tryMove(state, v, v.x + dx / d * push, v.y + dy / d * push);
  }
  for (const u of units) {
    if (u.dead || u.air || ghost(u)) continue;
    const k = Math.floor(u.x / cell) + Math.floor(u.y / cell) * W;
    let arr = grid.get(k); if (!arr) grid.set(k, arr = []); arr.push(u);
  }
  for (const u of units) {
    if (u.dead || u.air || ghost(u)) continue;
    const cx = Math.floor(u.x / cell), cy = Math.floor(u.y / cell);
    for (let yy = cy - 1; yy <= cy + 1; yy++) for (let xx = cx - 1; xx <= cx + 1; xx++) {
      const arr = grid.get(xx + yy * W); if (!arr) continue;
      for (const v of arr) {
        if (v.id <= u.id) continue;
        let dx = v.x - u.x, dy = v.y - u.y; let d = Math.hypot(dx, dy);
        const min = u.radius + v.radius;
        if (d >= min) continue;
        if (d < 1e-4) { dx = ((u.id * 7) % 5) - 2 + 0.5; dy = 1; d = Math.hypot(dx, dy); }
        const push = (min - d) * 0.5, nx = dx / d, ny = dy / d;
        // units that are firing hold their ground; movers get pushed more
        const uw = u.path ? 1 : 0.5, vw = v.path ? 1 : 0.5, s = uw + vw;
        tryMove(state, u, u.x - nx * push * 2 * uw / s, u.y - ny * push * 2 * uw / s);
        tryMove(state, v, v.x + nx * push * 2 * vw / s, v.y + ny * push * 2 * vw / s);
      }
    }
  }
}

// ---- harvesting

function gatherStep(state, u, o) {
  const pl = state.players[u.owner];
  let res = state.ents.get(o.res);
  if (o.phase === 'toRes' || o.phase === 'mining' || o.phase === 'waiting') {
    if (!res || res.dead) {
      // patch mined out: find another nearby one
      const alt = nearestResource(state, u.x, u.y, 'mineral', 12);
      if (!alt || (res && res.kind === 'building')) { setOrder(u, { type: 'idle' }); return; }
      o.res = alt.id; res = alt; o.phase = 'toRes';
    }
    const isGas = res.kind === 'building';
    if (isGas && (!res.done || res.owner !== u.owner)) { setOrder(u, { type: 'idle' }); return; }
    if (o.phase === 'toRes') {
      if (u.carry) { o.phase = 'toDrop'; return; }
      const r = moveTo(state, u, res.x, res.y, isGas ? res.size / 2 + 0.6 : 1.05);
      if (r === 'arrived' || (r !== 'moving' && gap(u, res) < 0.9)) {
        o.phase = 'waiting';
      } else if (r === 'failed') { setOrder(u, { type: 'idle' }); return; }
      else return;
    }
    if (o.phase === 'waiting') {
      if (isGas) {
        if (state.tick < res.gasBusyUntil) return;
        res.gasBusyUntil = state.tick + Math.round(GAS_TIME * TICK_RATE);
        u.hidden = true; o.phase = 'mining'; o.timer = GAS_TIME; return;
      }
      if (res.miner && res.miner !== u.id && state.ents.get(res.miner)?.order?.phase === 'mining' && state.ents.get(res.miner)?.order?.res === res.id) {
        // patch busy: try a free patch nearby, otherwise wait
        let alt = null, bestD = 5;
        for (const e of state.ents.values()) {
          if (e.kind !== 'resource' || e.type !== 'mineral' || e === res) continue;
          const m = e.miner && state.ents.get(e.miner);
          if (m && m.order && m.order.phase === 'mining' && m.order.res === e.id) continue;
          const dd = Math.hypot(e.x - res.x, e.y - res.y);
          if (dd < bestD) { bestD = dd; alt = e; }
        }
        if (alt && (state.tick + u.id) % 8 === 0) { o.res = alt.id; o.phase = 'toRes'; }
        return;
      }
      res.miner = u.id; o.phase = 'mining'; o.timer = MINE_TIME;
      u.facing = Math.atan2(res.y - u.y, res.x - u.x);
      return;
    }
    if (o.phase === 'mining') {
      o.timer -= DT;
      if (o.timer > 0) return;
      if (isGas) {
        const g = state.ents.get(res.geyser);
        const amt = g ? Math.min(GAS_AMOUNT, g.amount) : 0;
        if (g) g.amount -= amt;
        u.hidden = false;
        const [x, y] = freeSpotNear(state, res, nearestDropoff(state, u.owner, res.x, res.y) || res);
        u.x = x; u.y = y;
        if (amt > 0) u.carry = { kind: 'gas', amount: amt };
      } else {
        const amt = Math.min(MINE_AMOUNT, res.amount);
        res.amount -= amt; res.miner = 0;
        u.carry = { kind: 'mineral', amount: amt };
        if (res.amount <= 0) killEntity(state, res, -1, true);
      }
      o.phase = 'toDrop';
      return;
    }
  }
  if (o.phase === 'toDrop') {
    if (!u.carry) { o.phase = 'toRes'; return; }
    // pick a drop-off once and stick to it (two at the same distance used to make workers dither)
    let drop = o.drop && state.ents.get(o.drop);
    if (!drop || drop.dead || !drop.done || drop.owner !== u.owner) { drop = nearestDropoff(state, u.owner, u.x, u.y); o.drop = drop ? drop.id : 0; }
    if (!drop) { setOrder(u, { type: 'idle' }); return; }
    const r = moveTo(state, u, drop.x, drop.y, drop.size / 2 + 0.55);
    if (r === 'arrived' || gap(u, drop) < 0.6) {
      if (u.carry.kind === 'gas') { pl.gas += u.carry.amount; pl.stats.gasMined += u.carry.amount; }
      else { pl.minerals += u.carry.amount; pl.stats.mined += u.carry.amount; }
      u.carry = null; o.drop = 0;
      if (o.res && state.ents.get(o.res)) o.phase = 'toRes';
      else {
        const alt = nearestResource(state, u.x, u.y, 'mineral', 12);
        if (alt) { o.res = alt.id; o.phase = 'toRes'; } else setOrder(u, { type: 'idle' });
      }
    } else if (r === 'failed') setOrder(u, { type: 'idle' });
  }
}

// ---- construction

function buildStep(state, u, o) {
  const pl = state.players[u.owner];
  const d = BUILDINGS[o.btype];
  const style = FACTIONS[pl.faction].buildStyle;
  if (o.phase === 'toSite') {
    const cx = o.tx + d.size / 2, cy = o.ty + d.size / 2;
    const r = moveTo(state, u, cx, cy, d.size / 2 + 0.9);
    const near = Math.max(Math.abs(u.x - cx), Math.abs(u.y - cy)) <= d.size / 2 + 1.2;
    if (r === 'moving' && !near) return;
    if (!near) { msg(state, u.owner, "Can't reach build site"); finishBuildOrder(state, u); return; }
    if (o.bid) {
      const b = state.ents.get(o.bid);
      if (!b || b.dead || b.done) { finishBuildOrder(state, u); return; }
      o.phase = 'constructing'; u.path = null; return;
    }
    if (pl.minerals < d.cost[0] || pl.gas < d.cost[1]) { msg(state, u.owner, pl.minerals < d.cost[0] ? 'Not enough minerals' : 'Not enough gas'); finishBuildOrder(state, u); return; }
    const chk = checkPlacement(placementCtx(state, u.owner), o.btype, o.tx, o.ty);
    if (!chk.ok) { msg(state, u.owner, chk.reason); finishBuildOrder(state, u); return; }
    pl.minerals -= d.cost[0]; pl.gas -= d.cost[1];
    const b = createBuilding(state, u.owner, o.btype, o.tx, o.ty);
    if (style === 'construct') { o.bid = b.id; o.phase = 'constructing'; u.path = null; }
    else if (style === 'morph') { killEntity(state, u, -1, true); state.players[u.owner].stats.losses--; }
    else finishBuildOrder(state, u);
    return;
  }
  if (o.phase === 'constructing') {
    const b = state.ents.get(o.bid);
    if (!b || b.dead || b.done) { finishBuildOrder(state, u); return; }
    if (gap(u, b) > 1.0) { moveTo(state, u, b.x, b.y, b.size / 2 + 0.8); return; }
    b.lastBuilt = state.tick;
    u.facing = Math.atan2(b.y - u.y, b.x - u.x);
  }
}

// ---- repair

function repairStep(state, u, o) {
  const pl = state.players[u.owner];
  const t = state.ents.get(o.target);
  if (!t || t.dead || t.hp >= t.maxHp) { finishBuildOrder(state, u); return; }
  if (gap(u, t) > 0.9) {
    const r = moveTo(state, u, t.x, t.y, t.kind === 'building' ? t.size / 2 + 0.7 : t.radius + u.radius + 0.3, t.kind === 'unit');
    if (r === 'failed' && gap(u, t) > 1.2) { msg(state, u.owner, "Can't reach it to repair"); finishBuildOrder(state, u); }
    return;
  }
  u.path = null;
  u.facing = Math.atan2(t.y - u.y, t.x - u.x);
  const d = def(t.type);
  const hp = Math.min(t.maxHp - t.hp, t.maxHp * DT / d.time);
  const m = d.cost[0] * REPAIR_COST * hp / t.maxHp, g = d.cost[1] * REPAIR_COST * hp / t.maxHp;
  if (pl.minerals < m || pl.gas < g) { msg(state, u.owner, pl.minerals < m ? 'Not enough minerals to repair' : 'Not enough gas to repair'); finishBuildOrder(state, u); return; }
  pl.minerals -= m; pl.gas -= g;
  t.hp += hp; t.repairedAt = state.tick;
}

function finishBuildOrder(state, u) {
  const r = u.resume; u.resume = null;
  if (r && r.res && state.ents.get(r.res)) setOrder(u, { type: 'gather', res: r.res, phase: 'toRes' });
  else setOrder(u, { type: 'idle' });
}

// ---- buildings

function updateBuilding(state, b) {
  const d = BUILDINGS[b.type];
  const pl = state.players[b.owner];
  if (!b.done) {
    const style = FACTIONS[pl.faction].buildStyle;
    if (style === 'construct' && b.lastBuilt !== state.tick) return;
    b.progress += DT;
    b.hp = Math.min(b.maxHp, b.hp + b.maxHp * 0.9 * DT / d.time);
    if (b.maxShield) b.shield = Math.min(b.maxShield, b.shield + b.maxShield * DT / d.time);
    if (b.progress >= d.time) {
      b.done = true;
      state.events.push({ type: 'complete', player: b.owner, btype: b.type, id: b.id });
    }
    return;
  }
  if (d.larva) {
    if (b.larva < LARVA_MAX) { b.larvaTimer += DT; if (b.larvaTimer >= LARVA_TIME) { b.larvaTimer = 0; b.larva++; } }
    else b.larvaTimer = 0;
    for (const eg of b.eggs) eg.t += DT;
    const hatched = b.eggs.filter(eg => eg.t >= UNITS[eg.type].time);
    b.eggs = b.eggs.filter(eg => eg.t < UNITS[eg.type].time);
    for (const eg of hatched) produce(state, b, eg.type);
    return;
  }
  if (d.damage && b.powered) towerStep(state, b, d);
  if (b.queue.length && b.powered) {
    b.prodProgress += DT;
    if (b.prodProgress >= UNITS[b.queue[0]].time) {
      b.prodProgress = 0;
      produce(state, b, b.queue.shift());
    }
  }
}

// Defensive buildings shoot the nearest enemy unit in range, preferring armed ones.
function towerStep(state, b, d) {
  b.cooldown = Math.max(0, b.cooldown - DT);
  let t = b.target ? state.ents.get(b.target) : null;
  if (t && (t.dead || t.kind !== 'unit' || !isVisibleTo(state, b.owner, t) || gap(t, b) > d.range)) t = null;
  if (!t && (state.tick + b.id) % 4 === 0) {
    let bestScore = Infinity;
    for (const e of state.ents.values()) {
      if (e.dead || e.kind !== 'unit' || e.owner < 0 || e.owner === b.owner || e.hidden || !canHit(d, e)) continue;
      if (Math.abs(e.x - b.x) > d.range + 3 || Math.abs(e.y - b.y) > d.range + 3) continue;
      const g = gap(e, b);
      if (g > d.range || !isVisibleTo(state, b.owner, e)) continue;
      const score = g + (UNITS[e.type].damage && !UNITS[e.type].worker ? 0 : 4);
      if (score < bestScore) { bestScore = score; t = e; }
    }
  }
  b.target = t ? t.id : 0;
  if (!t) return;
  b.facing = Math.atan2(t.y - b.y, t.x - b.x);
  if (b.cooldown <= 0) { fire(state, b, t); b.cooldown = d.cooldown; }
}

function produce(state, b, type) {
  const d = UNITS[type];
  const rally = b.rally;
  for (let i = 0; i < (d.count || 1); i++) {
    const u = spawnUnit(state, b.owner, type, b, rally);
    if (rally && rally.res && d.worker && state.ents.get(rally.res)) setOrder(u, { type: 'gather', res: rally.res, phase: 'toRes' });
    else if (rally) setOrder(u, { type: 'move', x: rally.x, y: rally.y, group: 4 });
    else if (d.worker) {
      const m = nearestResource(state, u.x, u.y, 'mineral', 12);
      if (m) setOrder(u, { type: 'gather', res: m.id, phase: 'toRes' });
    }
  }
  state.events.push({ type: 'trained', player: b.owner, utype: type });
}

function regen(state, units, buildings) {
  for (const e of units.concat(buildings)) {
    if (e.dead) continue;
    const d = def(e.type);
    if (d.regen && e.hp < e.maxHp && (e.kind === 'unit' || e.done)) e.hp = Math.min(e.maxHp, e.hp + d.regen * DT);
    if (e.maxShield && e.shield < e.maxShield && (e.kind === 'unit' || e.done) && state.tick - e.lastHit > SHIELD_DELAY * TICK_RATE)
      e.shield = Math.min(e.maxShield, e.shield + SHIELD_REGEN * DT);
  }
}

function updateSupply(state) {
  const sizeMax = (MAP_SIZES[state.mapSize] || MAP_SIZES.medium).supplyMax;
  const sites = state.players.map(() => []);
  for (const pl of state.players) { pl.supplyUsed = 0; pl.supplyCap = 0; }
  for (const e of state.ents.values()) {
    if (e.owner < 0) continue;
    const pl = state.players[e.owner];
    if (e.kind === 'unit') pl.supplyUsed += UNITS[e.type].supply;
    else if (e.kind === 'building') {
      if (e.done) pl.supplyCap += BUILDINGS[e.type].supply || 0;
      if (e.done && BUILDINGS[e.type].base && !sites[e.owner].some(b => Math.hypot(b.x - e.x, b.y - e.y) < 8)) sites[e.owner].push(e);
      for (const t of e.queue) pl.supplyUsed += UNITS[t].supply * (UNITS[t].count || 1);
      for (const eg of e.eggs) pl.supplyUsed += UNITS[eg.type].supply * (UNITS[eg.type].count || 1);
    }
  }
  for (const pl of state.players) {
    // the ceiling grows with territory: every extra base site you hold, up to the map's limit
    pl.supplyMax = Math.min(sizeMax, MAX_SUPPLY + SUPPLY_PER_BASE * Math.max(0, sites[pl.id].length - 1));
    pl.supplyCap = Math.min(pl.supplyMax, pl.supplyCap);
  }
}

// ---------------------------------------------------------------- colony shield

function raiseDome(state, p, gen) {
  const pl = state.players[p], C = COLONY_SHIELD;
  pl.dome = { owner: p, gen: gen.id, x: pl.start.x, y: pl.start.y, r: C.radius, hp: C.hp, maxHp: C.hp, until: state.tick + C.duration * TICK_RATE, warned: false, seen: [false, false, false] };
  state.domesUp = true;
  // enemy units caught inside are thrown out to the nearest walkable spot beyond the wall
  for (const u of state.ents.values()) {
    if (u.kind !== 'unit' || u.dead || u.owner === p || u.hidden) continue;
    const dx = u.x - pl.dome.x, dy = u.y - pl.dome.y, d = Math.hypot(dx, dy);
    if (d >= pl.dome.r) continue;
    const ux = d > 1e-3 ? dx / d : 1, uy = d > 1e-3 ? dy / d : 0;
    for (let k = pl.dome.r + 0.6; k < pl.dome.r + 12; k += 0.5) {
      const x = pl.dome.x + ux * k, y = pl.dome.y + uy * k;
      if (x < 1 || y < 1 || x >= state.N - 1 || y >= state.N - 1) break;
      if (u.air || state.walk[tileOf(state, x, y)]) { u.x = u.px = x; u.y = u.py = y; u.path = null; break; }
    }
  }
  state.inbox.push({ type: 'dome', what: 'up', player: p, x: pl.dome.x, y: pl.dome.y });
}

function lowerDome(state, pl, why) {
  const g = state.ents.get(pl.dome.gen);
  if (g) g.rechargeUntil = state.tick + COLONY_SHIELD.recharge * TICK_RATE;
  state.events.push({ type: 'dome', what: why, player: pl.id, x: pl.dome.x, y: pl.dome.y });
  pl.dome = null;
  state.domesUp = state.players.some(q => q.dome);
}

function updateDomes(state) {
  if (!state.domesUp) return;
  for (const pl of state.players) {
    const dm = pl.dome;
    if (!dm) continue;
    const g = state.ents.get(dm.gen);
    if (!pl.alive || !g || g.dead) lowerDome(state, pl, 'lost');
    else if (dm.hp <= 0) lowerDome(state, pl, 'broken');
    else if (state.tick >= dm.until) lowerDome(state, pl, 'expired');
    else if (!dm.warned && dm.until - state.tick <= 15 * TICK_RATE) { dm.warned = true; state.events.push({ type: 'dome', what: 'fading', player: pl.id, x: dm.x, y: dm.y }); }
  }
}

const inDome = (dm, x, y) => Math.hypot(x - dm.x, y - dm.y) < dm.r;

// Would this step carry a unit from outside into an enemy's dome?
function domeBlocks(state, u, nx, ny) {
  for (const pl of state.players) {
    const dm = pl.dome;
    if (dm && pl.id !== u.owner && inDome(dm, nx, ny) && !inDome(dm, u.x, u.y)) return true;
  }
  return false;
}

// The enemy dome standing between a shooter outside it and a target inside it, if any.
function shieldingDome(state, u, t) {
  for (const pl of state.players) {
    const dm = pl.dome;
    if (dm && pl.id !== u.owner && t.owner === pl.id && inDome(dm, t.x, t.y) && !inDome(dm, u.x, u.y)) return dm;
  }
  return null;
}

function hitDome(state, u, t, dm, d) {
  // the shot stops where the line from the shooter to the target meets the wall
  const dx = t.x - u.x, dy = t.y - u.y, fx = u.x - dm.x, fy = u.y - dm.y;
  const a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - dm.r * dm.r;
  const disc = b * b - 4 * a * c, k = a > 0 && disc >= 0 ? Math.max(0, (-b - Math.sqrt(disc)) / (2 * a)) : 0;
  const hx = u.x + dx * k, hy = u.y + dy * k;
  state.events.push({ type: 'shot', from: u.id, fx: u.x, fy: u.y, tx: hx, ty: hy, owner: u.owner, unit: u.type, ranged: !!d.ranged, splash: false, fair: !!u.air, tair: false, dome: true });
  state.events.push({ type: 'domeHit', player: dm.owner, x: hx, y: hy });
  dm.hp -= Math.max(0.5, d.damage - COLONY_SHIELD.armor);
  const pl = state.players[dm.owner];
  if (state.tick - pl.lastAttackMsg > TICK_RATE * 12) { pl.lastAttackMsg = state.tick; state.events.push({ type: 'attacked', player: dm.owner, x: hx, y: hy }); }
}

// ---------------------------------------------------------------- weather

function rollWeather(state, prev) {
  const opts = Object.entries(WEATHER).filter(([k]) => k !== prev);
  let x = state.wrng() * opts.reduce((n, [, w]) => n + w.weight, 0);
  for (const [k, w] of opts) { x -= w.weight; if (x <= 0) return k; }
  return opts[0][0];
}

function updateWeather(state) {
  const w = state.weather;
  if (state.tick < w.until) return;
  const d = WEATHER[w.next].dur;
  w.type = w.next;
  w.until = state.tick + Math.round((d[0] + state.wrng() * (d[1] - d[0])) * TICK_RATE);
  w.next = rollWeather(state, w.type);
  state.events.push({ type: 'weather', weather: w.type });
}

// ---------------------------------------------------------------- fog of war

function circle(state, r) {
  let c = state.circles.get(r);
  if (!c) {
    c = [];
    const R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) if (dx * dx + dy * dy <= r * r) c.push([dx, dy]);
    state.circles.set(r, c);
  }
  return c;
}

// A tile is visible to a player if it is within sight of one of their units/buildings and
// not on higher ground than the viewer (low ground cannot see up cliffs; ramps count as low).
function updateVisibility(state) {
  const N = state.N, elev = state.map.elev;
  const level = e => (e === HIGH ? 1 : 0);
  for (const pl of state.players) pl.visible.fill(0);
  for (const e of state.ents.values()) {
    if (e.owner < 0 || e.dead || e.hidden) continue;
    const pl = state.players[e.owner];
    const ws = WEATHER[state.weather.type].sight;
    const sight = Math.max(3, (e.kind === 'unit' ? UNITS[e.type].sight : (e.done ? BUILDINGS[e.type].sight : 4)) + (e.kind === 'unit' ? ws : Math.round(ws / 2)));
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    const vl = e.air ? 1 : level(elev[cy * N + cx]);
    const vis = pl.visible, ex = pl.explored;
    for (const [dx, dy] of circle(state, sight)) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      const i = y * N + x;
      if (level(elev[i]) > vl) continue;
      vis[i] = 1; ex[i] = 1;
    }
  }
  // Who can see some part of each raised dome's rim?
  if (state.domesUp) for (const q of state.players) if (q.dome) {
    const dm = q.dome;
    for (const pl of state.players) {
      dm.seen[pl.id] = false;
      if (!pl.active || pl.id === q.id) continue;
      for (let k = 0; k < 32 && !dm.seen[pl.id]; k++) {
        const x = Math.floor(dm.x + Math.cos(k * Math.PI / 16) * (dm.r + 0.5)), y = Math.floor(dm.y + Math.sin(k * Math.PI / 16) * (dm.r + 0.5));
        if (x >= 0 && y >= 0 && x < N && y < N && pl.visible[y * N + x]) dm.seen[pl.id] = true;
      }
    }
  }
  // Remember enemy buildings as last seen; forget ones seen to be gone.
  for (const pl of state.players) {
    if (!pl.active) continue;
    for (const e of state.ents.values()) {
      if (e.kind !== 'building' || e.owner === pl.id || e.dead) continue;
      if (isVisibleTo(state, pl.id, e)) pl.memory.set(e.id, { id: e.id, type: e.type, owner: e.owner, tx: e.tx, ty: e.ty, size: e.size, x: e.x, y: e.y, done: e.done, seen: state.tick });
    }
    for (const [id, g] of pl.memory) {
      const e = state.ents.get(id);
      if ((!e || e.dead) && pl.visible[Math.floor(g.y) * N + Math.floor(g.x)]) pl.memory.delete(id);
    }
  }
}

function checkElimination(state) {
  for (const pl of state.players) {
    if (!pl.alive) continue;
    let any = false;
    for (const e of state.ents.values()) if (e.kind === 'building' && e.owner === pl.id && !e.dead) { any = true; break; }
    if (!any) {
      pl.alive = false; pl.defeatedAt = state.tick;
      for (const e of state.ents.values()) if (e.owner === pl.id) killEntity(state, e, -1);
      state.events.push({ type: 'eliminated', player: pl.id });
    }
  }
  removeDead(state);
  const alive = state.players.filter(p => p.alive);
  if (alive.length <= 1) { state.over = true; state.winner = alive.length ? alive[0].id : -1; }
}

// ---------------------------------------------------------------- observation (the only thing bots see)

export function publicMap(state) {
  const m = state.map;
  return { size: m.size, elev: m.elev, pass: m.pass, starts: m.starts, bases: m.bases, ramps: m.ramps };
}

function snapOwn(e) {
  const s = { id: e.id, kind: e.kind, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, shield: e.shield, maxShield: e.maxShield };
  if (e.kind === 'unit') {
    s.order = { type: e.order.type, res: e.order.res, btype: e.order.btype, tx: e.order.tx, ty: e.order.ty, bid: e.order.bid, target: e.order.target, x: e.order.x, y: e.order.y, phase: e.order.phase };
    s.carry = e.carry ? { ...e.carry } : null; s.target = e.target; s.hidden = e.hidden; s.air = e.air;
  } else {
    Object.assign(s, { tx: e.tx, ty: e.ty, size: e.size, done: e.done, progress: e.progress, queue: [...e.queue], larva: e.larva, eggs: e.eggs.length, powered: e.powered, rally: e.rally, rechargeUntil: e.rechargeUntil });
  }
  return s;
}

function snapEnemy(e) {
  const s = { id: e.id, kind: e.kind, type: e.type, owner: e.owner, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, shield: e.shield, maxShield: e.maxShield };
  if (e.kind === 'building') Object.assign(s, { tx: e.tx, ty: e.ty, size: e.size, done: e.done });
  return s;
}

export function observe(state, p) {
  const pl = state.players[p];
  const mine = [], enemies = [], resources = [];
  for (const e of state.ents.values()) {
    if (e.dead) continue;
    if (e.owner === p) mine.push(snapOwn(e));
    else if (e.kind === 'resource') {
      if (isExploredBy(state, p, e)) resources.push({ id: e.id, type: e.type, tx: e.tx, ty: e.ty, w: e.w, h: e.h, x: e.x, y: e.y, amount: isVisibleTo(state, p, e) ? e.amount : null, taken: !!e.building });
    } else if (isVisibleTo(state, p, e)) enemies.push(snapEnemy(e));
  }
  const visibleIds = new Set(enemies.map(e => e.id));
  const remembered = [...pl.memory.values()].filter(g => !visibleIds.has(g.id)).map(g => ({ ...g }));
  return {
    tick: state.tick, player: p, faction: pl.faction,
    minerals: pl.minerals, gas: pl.gas, supplyUsed: pl.supplyUsed, supplyCap: pl.supplyCap, supplyMax: pl.supplyMax,
    mine, enemies, remembered, resources,
    visible: pl.visible.slice(), explored: pl.explored.slice(),
    players: state.players.map(q => ({ id: q.id, active: q.active, alive: q.alive })),
    weather: { ...state.weather, next: state.weather.next },
    domes: state.players.filter(q => q.dome && (q.id === p || pl.explored[Math.floor(q.dome.y) * state.N + Math.floor(q.dome.x)])).map(q => ({ ...q.dome })),
    start: pl.start,
  };
}
