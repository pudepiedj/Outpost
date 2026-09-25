// Building placement rules, shared by the simulation (authoritative), the human UI and bots.
//
// ctx = {
//   map,                       // public map (size, elev, pass)
//   blocked(tx, ty) -> bool,   // tile occupied by a known building or resource
//   ownBuildings: [{type, x, y, done}],
//   geysers: [{id, tx, ty, taken}],
//   resources: [{tx, ty, w, h}], // for the "no base next to minerals" rule
//   explored(tx, ty) -> bool,  // optional: tile has been seen by this player
//   start: {x, y},             // optional: the player's start location (for the colony shield)
// }

import { BUILDINGS, placementRule, COLONY_SHIELD } from './data.js';
import { RAMP } from './map.js';

export function checkPlacement(ctx, type, tx, ty) {
  const b = BUILDINGS[type];
  if (!b) return { ok: false, reason: 'Unknown building' };
  const { map } = ctx, N = map.size, s = b.size;
  const rule = placementRule(type);

  if (rule === 'geyser') {
    const g = ctx.geysers.find(g => g.tx === tx && g.ty === ty);
    if (!g) return { ok: false, reason: 'Must be placed on a gas geyser' };
    if (g.taken) return { ok: false, reason: 'Geyser already taken' };
    if (ctx.explored && !ctx.explored(tx, ty)) return { ok: false, reason: 'Unexplored' };
    return { ok: true, geyser: g.id };
  }

  if (tx < 1 || ty < 1 || tx + s > N - 1 || ty + s > N - 1) return { ok: false, reason: 'Out of bounds' };
  const lvl = map.elev[ty * N + tx];
  for (let y = ty; y < ty + s; y++) for (let x = tx; x < tx + s; x++) {
    const i = y * N + x;
    if (!map.pass[i] || map.elev[i] === RAMP || map.elev[i] !== lvl) return { ok: false, reason: "Can't build there" };
    if (ctx.blocked(x, y)) return { ok: false, reason: "Can't build there" };
    if (ctx.explored && !ctx.explored(x, y)) return { ok: false, reason: 'Unexplored' };
  }
  const cx = tx + s / 2, cy = ty + s / 2;

  if (b.base) {
    for (const r of ctx.resources) {
      const rx = r.tx + r.w / 2, ry = r.ty + r.h / 2;
      if (Math.abs(rx - cx) < s / 2 + r.w / 2 + 2.5 && Math.abs(ry - cy) < s / 2 + r.h / 2 + 2.5)
        return { ok: false, reason: 'Too close to resources' };
    }
  }
  if (rule === 'creep') {
    for (let y = ty; y < ty + s; y++) for (let x = tx; x < tx + s; x++) {
      if (!hasCreep(ctx.ownBuildings, x + 0.5, y + 0.5)) return { ok: false, reason: 'Must be built on creep' };
    }
  }
  if (b.dome) {
    if (ctx.ownBuildings.some(o => o.type === type)) return { ok: false, reason: `Only one ${b.name} at a time` };
    if (ctx.start && Math.hypot(cx - ctx.start.x, cy - ctx.start.y) > COLONY_SHIELD.placeWithin) return { ok: false, reason: 'Must be built in your main base' };
  }
  if (rule === 'power') {
    if (!isPowered(ctx.ownBuildings, cx, cy)) return { ok: false, reason: 'Must be built in a pylon field' };
  }
  return { ok: true };
}

export function hasCreep(ownBuildings, x, y) {
  for (const o of ownBuildings) {
    const r = BUILDINGS[o.type].creep;
    if (r && o.done && Math.hypot(o.x - x, o.y - y) <= r) return true;
  }
  return false;
}

export function isPowered(ownBuildings, x, y) {
  for (const o of ownBuildings) {
    const r = BUILDINGS[o.type].power;
    if (r && o.done && Math.hypot(o.x - x, o.y - y) <= r) return true;
  }
  return false;
}
