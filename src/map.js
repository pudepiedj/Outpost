// Procedural three-player map: high-ground main bases with one ramp each,
// low-ground naturals and thirds, rock and water obstacles.

import { MAP_SIZE, MINERAL_AMOUNT, GEYSER_AMOUNT } from './data.js';

export const LOW = 0, RAMP = 1, HIGH = 2;
export const DECO_NONE = 0, DECO_ROCK = 1, DECO_WATER = 2, DECO_MOUNTAIN = 3, DECO_FORD = 4;
// DECO_FORD is shallow water: walkable, but ground units wade through it slowly (see FORD_SPEED in data.js).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Movement between adjacent tiles is allowed unless it jumps a cliff (low <-> high).
export function canStepLevels(a, b) { return Math.abs(a - b) <= 1; }

export function generateMap(seed, N = MAP_SIZE, K = 3) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const m = tryGenerate(seed + attempt * 7919, N, K);
    if (m) return m;
  }
  throw new Error('map generation failed');
}

// K: number of start locations (main bases on plateaus), spread round a ring.
function tryGenerate(seed, N, K) {
  const rng = mulberry32(seed);
  const elev = new Uint8Array(N * N);
  const pass = new Uint8Array(N * N).fill(1);
  const deco = new Uint8Array(N * N);
  const idx = (x, y) => y * N + x;
  const inb = (x, y) => x >= 0 && y >= 0 && x < N && y < N;

  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) { pass[idx(x, y)] = 0; deco[idx(x, y)] = DECO_ROCK; }
  }

  const c = N / 2, R = N * 0.36;
  const a0 = rng() * Math.PI * 2;
  const starts = [], bases = [], resources = [], ramps = [];

  const rot = (v, ang) => ({ x: v.x * Math.cos(ang) - v.y * Math.sin(ang), y: v.x * Math.sin(ang) + v.y * Math.cos(ang) });
  const deg = Math.PI / 180;

  // Main bases on plateaus
  for (let k = 0; k < K; k++) {
    const a = a0 + k * Math.PI * 2 / K;
    const sx = Math.round(c + R * Math.cos(a)), sy = Math.round(c + R * Math.sin(a));
    const s = { x: sx + 0.5, y: sy + 0.5 };
    const d = norm({ x: c - s.x, y: c - s.y });
    const phase = rng() * Math.PI * 2;
    const edgeR = th => 10.5 + 1.3 * Math.sin(3 * th + phase);
    for (let y = sy - 14; y <= sy + 14; y++) for (let x = sx - 14; x <= sx + 14; x++) {
      if (!inb(x, y)) continue;
      const vx = x + 0.5 - s.x, vy = y + 0.5 - s.y;
      if (Math.hypot(vx, vy) <= edgeR(Math.atan2(vy, vx))) elev[idx(x, y)] = HIGH;
    }
    // Ramp toward the map centre
    const re = edgeR(Math.atan2(d.y, d.x));
    const p = { x: -d.y, y: d.x };
    const rampTiles = [];
    for (let y = sy - 16; y <= sy + 16; y++) for (let x = sx - 16; x <= sx + 16; x++) {
      if (!inb(x, y)) continue;
      const vx = x + 0.5 - s.x, vy = y + 0.5 - s.y;
      const t = vx * d.x + vy * d.y, w = vx * p.x + vy * p.y;
      if (t >= re - 1.6 && t <= re + 1.6 && Math.abs(w) <= 1.7) { elev[idx(x, y)] = RAMP; rampTiles.push([x, y]); }
    }
    ramps.push({ x: s.x + d.x * re, y: s.y + d.y * re, tiles: rampTiles });
    starts.push({ x: s.x, y: s.y });
    bases.push({ x: s.x, y: s.y, start: true });
    placeResources(s, { x: -d.x, y: -d.y }, 8, 6.5);

    // Natural expansion on the low ground beside the ramp
    const sign = k % 2 ? 1 : -1;
    const nd = rot(d, sign * 45 * deg);
    const nat = { x: Math.round(s.x + nd.x * 19) + 0.5, y: Math.round(s.y + nd.y * 19) + 0.5 };
    const nu = rot(d, sign * 90 * deg);
    bases.push({ x: nat.x, y: nat.y, start: false });
    placeResources(nat, nu, 7, 6.5);
  }
  // Third bases between the mains, near the map edge
  for (let k = 0; k < K; k++) {
    const a = a0 + Math.PI / K + k * Math.PI * 2 / K;
    const t = { x: Math.round(c + (R - 2) * Math.cos(a)) + 0.5, y: Math.round(c + (R - 2) * Math.sin(a)) + 0.5 };
    bases.push({ x: t.x, y: t.y, start: false });
    placeResources(t, norm({ x: t.x - c, y: t.y - c }), 7, 6.5);
  }
  // Bigger maps: a ring of contested bases in the middle, and one at the centre
  if (K > 3) {
    for (let k = 0; k < K; k++) {
      const a = a0 + Math.PI / K + k * Math.PI * 2 / K, rr = R * 0.5;
      const t = { x: Math.round(c + rr * Math.cos(a)) + 0.5, y: Math.round(c + rr * Math.sin(a)) + 0.5 };
      bases.push({ x: t.x, y: t.y, start: false });
      placeResources(t, norm({ x: t.x - c, y: t.y - c }), 7, 6.5);
    }
    const t = { x: Math.round(c) + 0.5, y: Math.round(c) + 0.5 };
    bases.push({ x: t.x, y: t.y, start: false });
    placeResources(t, { x: Math.cos(a0), y: Math.sin(a0) }, 8, 6.5);
  }

  function placeResources(b, u, count, rad) {
    const span = count === 8 ? 70 : 60;
    for (let i = 0; i < count; i++) {
      const th = (-span + (2 * span) * i / (count - 1)) * deg;
      const v = rot(u, th);
      let mx = Math.floor(b.x + v.x * rad), my = Math.floor(b.y + v.y * rad);
      // a base needs its minerals just outside its no-build box (see checkPlacement): push out if too close
      for (let k = rad; Math.abs(mx + 0.5 - b.x) < 4.6 && Math.abs(my + 0.5 - b.y) < 4.6 && k < rad + 3; k += 0.25) { mx = Math.floor(b.x + v.x * k); my = Math.floor(b.y + v.y * k); }
      if (!inb(mx, my) || resources.some(r => r.tx === mx && r.ty === my)) continue;
      resources.push({ type: 'mineral', tx: mx, ty: my, w: 1, h: 1, amount: MINERAL_AMOUNT });
    }
    const gv = rot(u, (span + 42) * deg);
    const gx = Math.round(b.x + gv.x * 6.8 - 1), gy = Math.round(b.y + gv.y * 6.8 - 1);
    resources.push({ type: 'geyser', tx: gx, ty: gy, w: 2, h: 2, amount: GEYSER_AMOUNT });
  }

  // Resource tiles and base footprints must be flat, open ground at the base's level.
  for (const b of bases) {
    const lvl = elev[idx(Math.floor(b.x), Math.floor(b.y))];
    for (let y = Math.floor(b.y) - 7; y <= Math.floor(b.y) + 7; y++) for (let x = Math.floor(b.x) - 7; x <= Math.floor(b.x) + 7; x++) {
      if (!inb(x, y) || Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) > 8.5) continue;
      if (elev[idx(x, y)] === RAMP) continue;
      if (b.start) continue; // plateaus are already flat
      elev[idx(x, y)] = lvl;
    }
  }
  for (const r of resources) {
    for (let y = r.ty; y < r.ty + r.h; y++) for (let x = r.tx; x < r.tx + r.w; x++) {
      if (!inb(x, y) || x < 2 || y < 2 || x > N - 3 || y > N - 3) return null;
      if (elev[idx(x, y)] === RAMP) return null;
    }
  }

  // Obstacles, kept only if the map stays connected
  const blockedByRes = new Uint8Array(N * N);
  for (const r of resources) for (let y = r.ty; y < r.ty + r.h; y++) for (let x = r.tx; x < r.tx + r.w; x++) blockedByRes[idx(x, y)] = 1;
  const keyPoints = bases.map(b => [Math.floor(b.x), Math.floor(b.y) + 2]);
  if (!connected()) return null;

  // A feature is painted tile by tile and kept only if every base can still reach every other.
  const protectedAt = (x, y, baseGap, rampGap) => bases.some(b => Math.hypot(b.x - x, b.y - y) < baseGap) || ramps.some(r => Math.hypot(r.x - x, r.y - y) < rampGap);
  function paint(tiles) {
    const changed = [];
    for (const [t, kind] of tiles) {
      if (!pass[t] && deco[t] !== DECO_FORD) continue;
      if (deco[t] && kind === DECO_MOUNTAIN) continue; // mountains don't overwrite water
      changed.push([t, pass[t], deco[t]]);
      deco[t] = kind; pass[t] = kind === DECO_FORD ? 1 : 0;
    }
    if (!connected()) { for (const [t, p0, d0] of changed) { pass[t] = p0; deco[t] = d0; } return false; }
    return true;
  }

  // Rivers: meander from one edge of the map to the far side. Deep water, with shallow fords
  // every so often. They stay clear of bases and ramps (leaving natural crossings there).
  const riverCount = N >= 220 ? 3 : N >= 160 ? 2 : 1;
  for (let r = 0; r < riverCount; r++) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const side = Math.floor(rng() * 4), tpos = 0.2 + rng() * 0.6;
      let x = [tpos * N, N - 2, tpos * N, 2][side], y = [2, tpos * N, N - 2, tpos * N][side];
      let dir = [Math.PI / 2, Math.PI, -Math.PI / 2, 0][side] + (rng() - 0.5) * 0.8, turn = 0;
      const tiles = new Map(), width = 1.2 + rng() * 0.8;
      let sinceFord = 0, nextFord = 16 + rng() * 14, fordLeft = 0;
      for (let step = 0; step < N * 5; step++) {
        turn = turn * 0.92 + (rng() - 0.5) * 0.06;
        dir += turn;
        x += Math.cos(dir) * 0.5; y += Math.sin(dir) * 0.5;
        if (x < 1 || y < 1 || x >= N - 1 || y >= N - 1) break;
        sinceFord += 0.5;
        if (sinceFord > nextFord) { fordLeft = 3; sinceFord = 0; nextFord = 16 + rng() * 14; }
        const ford = fordLeft > 0; if (ford) fordLeft -= 0.5;
        if (protectedAt(x, y, 12, 7)) continue;
        for (let yy = Math.floor(y - width - 1); yy <= y + width + 1; yy++) for (let xx = Math.floor(x - width - 1); xx <= x + width + 1; xx++) {
          if (!inb(xx, yy) || elev[idx(xx, yy)] !== LOW || blockedByRes[idx(xx, yy)]) continue;
          if (Math.hypot(xx + 0.5 - x, yy + 0.5 - y) > width) continue;
          const t = idx(xx, yy);
          if (ford || tiles.get(t) !== DECO_FORD) tiles.set(t, ford ? DECO_FORD : DECO_WATER);
        }
      }
      if (tiles.size > N && paint([...tiles])) break;
    }
  }

  // Mountain ranges: rocky ridges with a pass through them now and then. Flyers go over.
  const ridgeCount = Math.round(3 * (N / 112) ** 2);
  for (let m = 0; m < ridgeCount; m++) {
    let x = 6 + rng() * (N - 12), y = 6 + rng() * (N - 12), dir = rng() * Math.PI * 2, turn = 0;
    const len = 16 + rng() * 30, tiles = new Map();
    let sincePass = 0, nextPass = 8 + rng() * 10, gapLeft = 0;
    for (let d = 0; d < len; d += 0.5) {
      turn = turn * 0.9 + (rng() - 0.5) * 0.08; dir += turn;
      x += Math.cos(dir) * 0.5; y += Math.sin(dir) * 0.5;
      if (x < 3 || y < 3 || x >= N - 3 || y >= N - 3) break;
      sincePass += 0.5;
      if (sincePass > nextPass) { gapLeft = 3.5; sincePass = 0; nextPass = 8 + rng() * 10; }
      if (gapLeft > 0) { gapLeft -= 0.5; continue; }
      if (protectedAt(x, y, 13, 8)) continue;
      const w = 1.1 + 0.9 * Math.sin(Math.PI * d / len) + rng() * 0.3; // thickest in the middle
      for (let yy = Math.floor(y - w - 1); yy <= y + w + 1; yy++) for (let xx = Math.floor(x - w - 1); xx <= x + w + 1; xx++) {
        if (!inb(xx, yy) || elev[idx(xx, yy)] === RAMP || blockedByRes[idx(xx, yy)]) continue;
        if (Math.hypot(xx + 0.5 - x, yy + 0.5 - y) <= w) tiles.set(idx(xx, yy), DECO_MOUNTAIN);
      }
    }
    if (tiles.size) paint([...tiles]);
  }

  for (let i = 0, n = Math.round(34 * (N / 112) ** 2); i < n; i++) {
    const ox = 4 + rng() * (N - 8), oy = 4 + rng() * (N - 8);
    if (bases.some(b => Math.hypot(b.x - ox, b.y - oy) < 13)) continue;
    if (ramps.some(r => Math.hypot(r.x - ox, r.y - oy) < 7)) continue;
    const kind = rng() < 0.35 ? DECO_WATER : DECO_ROCK;
    const rad = 1.5 + rng() * 2.8, stretch = 0.6 + rng() * 0.8, ang = rng() * Math.PI;
    const changed = [];
    for (let y = Math.floor(oy - 6); y <= oy + 6; y++) for (let x = Math.floor(ox - 6); x <= ox + 6; x++) {
      if (!inb(x, y) || !pass[idx(x, y)] || elev[idx(x, y)] === RAMP) continue;
      const dx = x + 0.5 - ox, dy = y + 0.5 - oy;
      const u = dx * Math.cos(ang) + dy * Math.sin(ang), v = (-dx * Math.sin(ang) + dy * Math.cos(ang)) / stretch;
      if (Math.hypot(u, v) <= rad) { changed.push(idx(x, y)); pass[idx(x, y)] = 0; deco[idx(x, y)] = kind; }
    }
    if (!connected()) for (const t of changed) { pass[t] = 1; deco[t] = 0; }
  }

  function connected() {
    const seen = new Uint8Array(N * N);
    const [x0, y0] = keyPoints[0];
    const stack = [idx(x0, y0)]; seen[stack[0]] = 1;
    while (stack.length) {
      const t = stack.pop(), x = t % N, y = (t / N) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (!inb(nx, ny)) continue;
        const n = idx(nx, ny);
        if (seen[n] || !pass[n] || blockedByRes[n] || !canStepLevels(elev[t], elev[n])) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    return keyPoints.every(([x, y]) => seen[idx(x, y)]);
  }

  return { size: N, seed, elev, pass, deco, starts, bases, resources, ramps: ramps.map(r => ({ x: r.x, y: r.y })) };
}

function norm(v) { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; }
