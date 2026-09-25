// Building placement from a player's own (fog-filtered) observation.
// Shared by the reference bot and the human economy assistant.

import { BUILDINGS } from '../data.js';
import { checkPlacement } from '../rules.js';
import { canStepLevels } from '../map.js';

// Tiles connected to (sx, sy) on foot, ignoring buildings. Cached per map and start.
const regions = new WeakMap();
export function reachable(map, sx, sy) {
  let byStart = regions.get(map);
  if (!byStart) regions.set(map, byStart = new Map());
  const N = map.size, s0 = Math.floor(sy) * N + Math.floor(sx);
  if (byStart.has(s0)) return byStart.get(s0);
  const seen = new Uint8Array(N * N), q = [s0];
  seen[s0] = 1;
  while (q.length) {
    const i = q.pop(), x = i % N, y = (i / N) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, j = ny * N + nx;
      if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[j] || !map.pass[j] || !canStepLevels(map.elev[i], map.elev[j])) continue;
      seen[j] = 1; q.push(j);
    }
  }
  byStart.set(s0, seen);
  return seen;
}

// Tiles this player knows to be occupied: own/seen buildings, resources, and sites workers are heading to.
export function knownBlocked(obs, map) {
  const N = map.size, g = new Uint8Array(N * N);
  const stamp = (tx, ty, w, h) => { for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (x >= 0 && y >= 0 && x < N && y < N) g[y * N + x] = 1; };
  for (const b of obs.mine) if (b.kind === 'building') stamp(b.tx, b.ty, b.size, b.size);
  for (const e of obs.enemies) if (e.kind === 'building') stamp(e.tx, e.ty, e.size, e.size);
  for (const e of obs.remembered) stamp(e.tx, e.ty, e.size, e.size);
  for (const r of obs.resources) stamp(r.tx, r.ty, r.w, r.h);
  for (const w of obs.mine) if (w.kind === 'unit' && w.order.type === 'build' && !w.order.bid && w.order.tx !== undefined) {
    const s = BUILDINGS[w.order.btype].size; stamp(w.order.tx, w.order.ty, s, s);
  }
  return g;
}

export function placementCtxFromObs(obs, map, blocked) {
  const N = map.size;
  const units = obs.mine.filter(e => e.kind === 'unit');
  return {
    map, blocked: (x, y) => blocked[y * N + x] === 1,
    ownBuildings: obs.mine.filter(e => e.kind === 'building'),
    geysers: obs.resources.filter(r => r.type === 'geyser').map(r => ({ id: r.id, tx: r.tx, ty: r.ty, taken: r.taken || units.some(w => w.order.type === 'build' && w.order.tx === r.tx && w.order.ty === r.ty) })),
    resources: obs.resources,
    explored: (x, y) => obs.explored[y * N + x] === 1,
    start: obs.start,
  };
}

// Find a tidy spot for a building near home: clear of mineral lines and ramps, with a
// one-tile walking lane around it. `skip(key)` can veto spots that failed before.
export function findBuildSpot(obs, map, bt, home, skip = () => false) {
  const N = map.size, bd = BUILDINGS[bt], s = bd.size;
  const blds = obs.mine.filter(e => e.kind === 'building');
  const bases = blds.filter(b => BUILDINGS[b.type].base).sort((a, b) => a.id - b.id);
  const blocked = knownBlocked(obs, map);
  const ctx = placementCtxFromObs(obs, map, blocked);
  if (bd.onGeyser) {
    const g = ctx.geysers.filter(g => !g.taken && bases.some(b => b.done && Math.hypot(g.tx + 1 - b.x, g.ty + 1 - b.y) < 12))[0];
    return g ? { tx: g.tx, ty: g.ty } : null;
  }
  // search around the main first, then around every other base once the main fills up
  const anchors = bd.needsPower ? blds.filter(b => BUILDINGS[b.type].power && b.done) : bases.filter(b => b.done);
  if (!anchors.length) return null;
  // a walkway all round the building: open, walkable ground reachable from its level (no cliff, water or
  // mountain hard against it), so buildings never seal off a pocket
  const ringClear = (tx, ty) => {
    const lvl = map.elev[ty * N + tx];
    for (let y = ty - 1; y <= ty + s; y++) for (let x = tx - 1; x <= tx + s; x++) {
      if (x < 0 || y < 0 || x >= N || y >= N || blocked[y * N + x]) return false;
      const i = y * N + x;
      if (!map.pass[i] || Math.abs(map.elev[i] - lvl) > 1) return false;
    }
    return true;
  };
  const reach = reachable(map, home.x, home.y);
  let best = null, bestD = Infinity;
  for (const R of [14, 22]) { // widen the search once the area near the anchors fills up
  if (best) break;
  for (const a of anchors) {
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const tx = Math.floor(a.x - s / 2) + dx, ty = Math.floor(a.y - s / 2) + dy;
      const cx = tx + s / 2, cy = ty + s / 2;
      const dd = Math.hypot(cx - home.x, cy - home.y) + Math.hypot(cx - a.x, cy - a.y) * 0.3;
      if (dd >= bestD || dd < 3) continue;
      if (skip(`${bt}:${tx},${ty}`)) continue;
      if (obs.resources.some(r => Math.hypot(r.x - cx, r.y - cy) < s / 2 + 3.2)) continue;
      if (map.ramps.some(r => Math.hypot(r.x - cx, r.y - cy) < s / 2 + 3)) continue;
      if (!ringClear(tx, ty)) continue;
      if (!reach[ty * N + tx] || !reach[(ty + s - 1) * N + tx + s - 1]) continue;
      if (!checkPlacement(ctx, bt, tx, ty).ok) continue;
      best = { tx, ty }; bestD = dd;
    }
  }
  }
  return best;
}
