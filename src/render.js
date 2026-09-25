// Canvas renderer: isometric (2:1) view of the square tile grid. World tile (x, y) maps to iso
// pixels ((x - y) * HW, (x + y) * HH). The simulation is untouched: this is only a projection.
// Procedural art (upright buildings and units with visible faces), cliffs, fog of war, effects,
// and a diamond minimap. Terrain is pre-rendered lazily in screen-space chunks.

import { UNITS, BUILDINGS, PLAYER_COLORS, COLONY_SHIELD } from './data.js';
import { LOW, RAMP, HIGH, DECO_ROCK, DECO_WATER } from './map.js';
import { isVisibleTo } from './sim.js';

export const T = 32;            // unit/art scale in pixels per tile at zoom 1
export const HW = 32, HH = 16;  // half width / half height of a tile diamond at zoom 1
const CLIFF = 18;               // height of a cliff face in pixels
const SQ2 = Math.SQRT2;
const TAU = Math.PI * 2;

function hash(x, y, s = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x, y, cell, s) {
  const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
  const fx = x / cell - gx, fy = y / cell - gy;
  const sm = t => t * t * (3 - 2 * t);
  const a = hash(gx, gy, s), b = hash(gx + 1, gy, s), c = hash(gx, gy + 1, s), d = hash(gx + 1, gy + 1, s);
  const u = sm(fx), v = sm(fy);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function tileHSL(e, d, x, y) {
  const n = (valueNoise(x, y, 7, 3) - 0.5) * 8 + (valueNoise(x, y, 2.5, 4) - 0.5) * 3 + (hash(x, y) - 0.5) * 1.2;
  if (d === DECO_WATER) return [206, 42, 22 + n * 0.4];
  if (d === DECO_ROCK) return [26, 10, 15 + n * 0.5];
  if (e === HIGH) return [37, 19, 36 + n];
  if (e === RAMP) return [34, 20, 32 + n];
  return [30, 23, 26 + n];
}
const hsl = ([h, s, l], dl = 0) => `hsl(${h},${s}%,${Math.max(0, Math.min(100, l + dl))}%)`;
const isoX = (x, y) => (x - y) * HW, isoY = (x, y) => (x + y) * HH;

// ---------------------------------------------------------------- terrain chunks

const CW = 1024, CHH = 512;

function makeTerrain(map) {
  const N = map.size;
  const E = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? -1 : map.elev[y * N + x]);
  const D = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? DECO_ROCK : map.deco[y * N + x]);
  const X0 = -N * HW, Y0 = -40;
  const cols = Math.ceil(2 * N * HW / CW), rows = Math.ceil((2 * N * HH + CLIFF + 60) / CHH);
  const cache = new Map();

  function diamond(g, x, y, grow = 0) {
    const cx = isoX(x + 0.5, y + 0.5), cy = isoY(x + 0.5, y + 0.5);
    g.beginPath(); g.moveTo(cx, cy - HH - grow); g.lineTo(cx + HW + grow * 2, cy); g.lineTo(cx, cy + HH + grow); g.lineTo(cx - HW - grow * 2, cy); g.closePath();
  }
  function wquad(g, pts) { // polygon from world points
    g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(isoX(x, y), isoY(x, y)) : g.moveTo(isoX(x, y), isoY(x, y)))); g.closePath();
  }

  function ground(g, x, y) {
    const i = y * N + x, e = map.elev[i], d = map.deco[i];
    const col = d === DECO_ROCK ? [26, 12, 19 + (hash(x, y, 3) - 0.5) * 3] : tileHSL(e, d, x, y);
    g.fillStyle = hsl(col); diamond(g, x, y, 0.6); g.fill();
    if (d === DECO_WATER) {
      // banks: dark drop along the back edges, sand along any shore
      for (const [dx, dy, pts] of [
        [0, -1, [[x, y], [x + 1, y], [x + 1, y + 0.3], [x, y + 0.3]]], [-1, 0, [[x, y], [x + 0.3, y], [x + 0.3, y + 1], [x, y + 1]]],
      ]) if (D(x + dx, y + dy) !== DECO_WATER) { g.fillStyle = 'rgba(0,10,25,0.45)'; wquad(g, pts); g.fill(); }
      for (const [dx, dy, pts] of [
        [0, -1, [[x, y], [x + 1, y], [x + 1, y + 0.1], [x, y + 0.1]]], [-1, 0, [[x, y], [x + 0.1, y], [x + 0.1, y + 1], [x, y + 1]]],
        [0, 1, [[x, y + 0.88], [x + 1, y + 0.88], [x + 1, y + 1], [x, y + 1]]], [1, 0, [[x + 0.88, y], [x + 1, y], [x + 1, y + 1], [x + 0.88, y + 1]]],
      ]) if (D(x + dx, y + dy) !== DECO_WATER) { g.fillStyle = 'rgba(214,194,146,0.55)'; wquad(g, pts); g.fill(); }
      const o = 0.25 + hash(x, y, 5) * 0.5, sx = isoX(x + o, y + 0.5), sy = isoY(x + o, y + 0.5);
      g.strokeStyle = 'rgba(170,215,255,0.16)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(sx - 12, sy); g.quadraticCurveTo(sx, sy - 4, sx + 12, sy); g.stroke();
      return;
    }
    for (let k = 0; k < (d ? 3 : 8); k++) {
      const px = isoX(x + hash(x, y, k + 1), y + hash(x, y, k + 11)), py = isoY(x + hash(x, y, k + 1), y + hash(x, y, k + 11));
      g.fillStyle = hash(x, y, k + 21) < 0.5 ? 'rgba(0,0,0,0.11)' : 'rgba(255,238,200,0.07)';
      const s = 1.5 + hash(x, y, k + 31) * 3;
      g.fillRect(px - s, py - s * 0.35, s * 2, s * 0.7);
    }
    if (e === RAMP) {
      const gx = (E(x + 1, y) === HIGH) - (E(x - 1, y) === HIGH) + ((E(x - 1, y) === LOW) - (E(x + 1, y) === LOW));
      const gy = (E(x, y + 1) === HIGH) - (E(x, y - 1) === HIGH) + ((E(x, y - 1) === LOW) - (E(x, y + 1) === LOW));
      const l = Math.hypot(gx, gy) || 1, ux = gx / l, uy = gy / l;
      g.save(); diamond(g, x, y, 0.6); g.clip();
      g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 2;
      for (const t of [-0.35, -0.05, 0.25]) {
        const mx = x + 0.5 + ux * t, my = y + 0.5 + uy * t;
        g.beginPath(); g.moveTo(isoX(mx - uy, my + ux), isoY(mx - uy, my + ux)); g.lineTo(isoX(mx + uy, my - ux), isoY(mx + uy, my - ux)); g.stroke();
      }
      g.restore();
    }
  }

  function cliffs(g, x, y) {
    if (E(x, y) !== HIGH) return;
    const face = (ax, ay, bx, by, light) => {
      const A = [isoX(ax, ay), isoY(ax, ay)], B = [isoX(bx, by), isoY(bx, by)];
      // shadow cast on the low ground below
      g.fillStyle = 'rgba(0,0,0,0.22)';
      g.beginPath(); g.moveTo(A[0], A[1] + CLIFF); g.lineTo(B[0], B[1] + CLIFF); g.lineTo(B[0], B[1] + CLIFF + 9); g.lineTo(A[0], A[1] + CLIFF + 9); g.closePath(); g.fill();
      const gr = g.createLinearGradient(0, Math.min(A[1], B[1]), 0, Math.max(A[1], B[1]) + CLIFF);
      gr.addColorStop(0, light ? '#6a5540' : '#4a3a2c'); gr.addColorStop(1, light ? '#33271c' : '#1f1711');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.lineTo(B[0], B[1] + CLIFF); g.lineTo(A[0], A[1] + CLIFF); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1;
      for (const k of [0.38, 0.7]) { g.beginPath(); g.moveTo(A[0], A[1] + CLIFF * k); g.lineTo(B[0], B[1] + CLIFF * k); g.stroke(); }
      for (let k = 0; k < 3; k++) {
        const t = hash(x, y, k + 100 + (light ? 7 : 0)), px = A[0] + (B[0] - A[0]) * t, py = A[1] + (B[1] - A[1]) * t;
        g.beginPath(); g.moveTo(px, py + 3); g.lineTo(px + 1, py + CLIFF - 2); g.stroke();
      }
      g.strokeStyle = 'rgba(255,232,190,0.35)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(A[0], A[1]); g.lineTo(B[0], B[1]); g.stroke();
    };
    const rim = (ax, ay, bx, by) => {
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(isoX(ax, ay), isoY(ax, ay) - 1.5); g.lineTo(isoX(bx, by), isoY(bx, by) - 1.5); g.stroke();
      g.strokeStyle = 'rgba(255,232,190,0.28)'; g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(isoX(ax, ay), isoY(ax, ay) + 1); g.lineTo(isoX(bx, by), isoY(bx, by) + 1); g.stroke();
    };
    if (E(x, y - 1) === LOW) rim(x, y, x + 1, y);
    if (E(x - 1, y) === LOW) rim(x, y, x, y + 1);
    if (E(x, y + 1) === LOW) face(x, y + 1, x + 1, y + 1, true);
    if (E(x + 1, y) === LOW) face(x + 1, y, x + 1, y + 1, false);
  }

  function objects(g, x, y) {
    const i = y * N + x, e = map.elev[i], d = map.deco[i];
    if (d === DECO_ROCK) {
      const k = 2 + Math.floor(hash(x, y, 9) * 2);
      const rocks = [];
      for (let j = 0; j < k; j++) rocks.push([x + 0.2 + hash(x, y, j + 40) * 0.6, y + 0.2 + hash(x, y, j + 50) * 0.6, j]);
      rocks.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
      for (const [wx, wy, j] of rocks) {
        const px = isoX(wx, wy), py = isoY(wx, wy), br = 7 + hash(x, y, j + 60) * 8, l = 18 + hash(x, y, j + 70) * 10;
        g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.ellipse(px + 3, py + 1, br * 1.1, br * 0.5, 0, 0, TAU); g.fill();
        const gr = g.createRadialGradient(px - br * 0.35, py - br * 1.0, br * 0.1, px, py - br * 0.55, br * 1.1);
        gr.addColorStop(0, hsl([28, 9, l + 12])); gr.addColorStop(0.6, hsl([26, 9, l])); gr.addColorStop(1, hsl([24, 10, l - 9]));
        g.fillStyle = gr;
        g.beginPath(); g.moveTo(px - br, py);
        g.quadraticCurveTo(px - br * 1.05, py - br * 0.9, px - br * 0.3, py - br * 1.25);
        g.quadraticCurveTo(px + br * 0.5, py - br * 1.45, px + br, py - br * 0.5);
        g.quadraticCurveTo(px + br * 1.05, py + br * 0.2, px, py + br * 0.35);
        g.quadraticCurveTo(px - br * 0.8, py + br * 0.3, px - br, py);
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(px - br * 0.2, py - br * 1.2); g.lineTo(px + br * 0.1, py - br * 0.4); g.stroke();
      }
      return;
    }
    if (d || e === RAMP) return;
    const px = isoX(x + 0.5, y + 0.5), py = isoY(x + 0.5, y + 0.5);
    if (hash(x, y, 77) < 0.05) { // pebbles
      for (let j = 0; j < 3; j++) {
        const ox = (hash(x, y, j + 80) - 0.5) * 30, oy = (hash(x, y, j + 90) - 0.5) * 14, rr = 2 + hash(x, y, j + 95) * 2.5;
        g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(px + ox + 1, py + oy + 1, rr * 1.2, rr * 0.6, 0, 0, TAU); g.fill();
        g.fillStyle = hsl([28, 12, 30 + hash(x, y, j + 96) * 10]); g.beginPath(); g.ellipse(px + ox, py + oy - rr * 0.4, rr, rr * 0.75, 0, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,240,210,0.18)'; g.beginPath(); g.ellipse(px + ox - rr * 0.3, py + oy - rr * 0.7, rr * 0.4, rr * 0.25, 0, 0, TAU); g.fill();
      }
    } else if (hash(x, y, 78) < 0.03) { // dry shrub
      g.strokeStyle = 'rgba(128,116,62,0.75)'; g.lineWidth = 1.2;
      for (let j = 0; j < 7; j++) {
        const a = -Math.PI / 2 + (j - 3) * 0.3, len = 6 + hash(x, y, j + 120) * 6;
        g.beginPath(); g.moveTo(px, py); g.quadraticCurveTo(px + Math.cos(a) * len * 0.5, py + Math.sin(a) * len * 0.7, px + Math.cos(a) * len, py + Math.sin(a) * len); g.stroke();
      }
    } else if (hash(x, y, 79) < 0.02) { // crack
      g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(px - 14, py - 2); g.lineTo(px - 4, py + 2); g.lineTo(px + 3, py - 1); g.lineTo(px + 13, py + 3); g.stroke();
    }
  }

  function build(ci, cj) {
    const c = document.createElement('canvas'); c.width = CW; c.height = CHH;
    const g = c.getContext('2d');
    const ox = X0 + ci * CW, oy = Y0 + cj * CHH;
    g.translate(-ox, -oy);
    const u0 = Math.floor(ox / HW) - 2, u1 = Math.ceil((ox + CW) / HW) + 2;
    const v0 = Math.floor((oy - CLIFF - 12) / HH) - 2, v1 = Math.ceil((oy + CHH + 40) / HH) + 1;
    const tiles = [];
    for (let v = Math.max(0, v0); v <= Math.min(2 * N - 2, v1); v++) for (let u = u0; u <= u1; u++) {
      if ((u + v) & 1) continue;
      const x = (u + v) / 2, y = (v - u) / 2;
      if (x < 0 || y < 0 || x >= N || y >= N) continue;
      tiles.push(x, y);
    }
    for (let k = 0; k < tiles.length; k += 2) ground(g, tiles[k], tiles[k + 1]);
    for (let k = 0; k < tiles.length; k += 2) { cliffs(g, tiles[k], tiles[k + 1]); objects(g, tiles[k], tiles[k + 1]); }
    return c;
  }

  // Draw the visible part of the terrain. cam is the iso pixel at the screen's top-left.
  return function draw(ctx, cam, z, W, H) {
    const i0 = Math.max(0, Math.floor((cam.x - X0) / CW)), i1 = Math.min(cols - 1, Math.floor((cam.x + W / z - X0) / CW));
    const j0 = Math.max(0, Math.floor((cam.y - Y0) / CHH)), j1 = Math.min(rows - 1, Math.floor((cam.y + H / z - Y0) / CHH));
    let budget = cache.size ? 3 : 99;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = i + ',' + j;
      let c = cache.get(key);
      if (c) { cache.delete(key); cache.set(key, c); } // keep LRU order
      else if (budget-- > 0) { c = build(i, j); cache.set(key, c); if (cache.size > 48) cache.delete(cache.keys().next().value); }
      if (!c) continue;
      const sx = Math.floor((X0 + i * CW - cam.x) * z), sy = Math.floor((Y0 + j * CHH - cam.y) * z);
      const ex = Math.ceil((X0 + (i + 1) * CW - cam.x) * z), ey = Math.ceil((Y0 + (j + 1) * CHH - cam.y) * z);
      ctx.drawImage(c, sx, sy, ex - sx, ey - sy);
    }
  };
}

function buildMiniTerrain(map) {
  const N = map.size, c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const img = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    const [h, s, l] = tileHSL(map.elev[i], map.deco[i], x, y);
    const [r, gg, b] = hslToRgb(h / 360, s / 100, Math.min(1, (l + 6) / 100));
    img.data.set([r, gg, b, 255], i * 4);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function hslToRgb(h, s, l) {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255].map(Math.round);
}

function shade(hex, k) { // k in [-1,1]
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = k < 0 ? 0 : 255, a = Math.abs(k);
  r = Math.round(r + (t - r) * a); g = Math.round(g + (t - g) * a); b = Math.round(b + (t - b) * a);
  return `rgb(${r},${g},${b})`;
}

// Visual heights in pixels at zoom 1: used for health bars and mouse picking.
const BH = {
  hub: 62, depot: 22, barracks: 50, factory: 66, refinery: 40,
  hive: 46, pod: 32, pit: 22, den: 36, extractor: 30,
  nexus: 62, pylon: 54, gateway: 60, core: 42, assimilator: 30,
  turret: 34, thorn: 36, spire: 58,
  bulwark: 46, heart: 36, sanctum: 50,
};
const FLY = 34; // flying units hover this high (pixels at zoom 1)
const UH = { engineer: 16, trooper: 24, crawler: 20, drone: 12, biter: 12, spitter: 26, acolyte: 26, warden: 28, lancer: 30, hawk: FLY + 12, stinger: FLY + 10, seraph: FLY + 14 };

// ---------------------------------------------------------------- renderer

export function createRenderer(canvas, mini, state) {
  const ctx = canvas.getContext('2d');
  const mctx = mini.getContext('2d');
  const N = state.N;
  const drawTerrain = makeTerrain(state.map);
  const miniTerrain = buildMiniTerrain(state.map);
  const fog = document.createElement('canvas'); fog.width = fog.height = N;
  const fctx = fog.getContext('2d');
  const fogImg = fctx.createImageData(N, N);
  const creep = document.createElement('canvas'); creep.width = creep.height = N;
  const cctx = creep.getContext('2d');
  let creepKey = '', creepGrid = new Uint8Array(N * N);

  const r = { cam: { x: 0, y: 0 }, zoom: 1, viewer: 0, effects: [], pings: [], W: 0, H: 0, dpr: 1 };
  let z = 1;

  r.resize = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (W !== r.W || H !== r.H || dpr !== r.dpr) {
      r.W = W; r.H = H; r.dpr = dpr;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    const mw = mini.clientWidth, mh = mini.clientHeight;
    if (mini.width !== Math.round(mw * dpr)) { mini.width = Math.round(mw * dpr); mini.height = Math.round(mh * dpr); }
  };
  r.screenToWorld = (sx, sy) => {
    const X = sx / r.zoom + r.cam.x, Y = sy / r.zoom + r.cam.y;
    return { x: (X / HW + Y / HH) / 2, y: (Y / HH - X / HW) / 2 };
  };
  r.worldToScreen = (x, y) => ({ x: (isoX(x, y) - r.cam.x) * r.zoom, y: (isoY(x, y) - r.cam.y) * r.zoom });
  const lookAt = (x, y, sx, sy) => { r.cam.x = isoX(x, y) - sx / r.zoom; r.cam.y = isoY(x, y) - sy / r.zoom; };
  // Keep the point at the centre of the view on the map.
  r.clampCam = () => {
    const cx = r.W / 2, cy = r.H / 2, c = r.screenToWorld(cx, cy);
    const x = Math.max(0, Math.min(N, c.x)), y = Math.max(0, Math.min(N, c.y));
    if (x !== c.x || y !== c.y) lookAt(x, y, cx, cy);
  };
  r.centerOn = (x, y) => { lookAt(x, y, r.W / 2, r.H / 2); r.clampCam(); };
  r.setZoom = (zz, sx = r.W / 2, sy = r.H / 2) => {
    const w = r.screenToWorld(sx, sy);
    r.zoom = Math.max(0.5, Math.min(2, zz));
    lookAt(w.x, w.y, sx, sy); r.clampCam();
  };
  // minimap: the map is drawn as a diamond filling the minimap canvas
  r.miniToWorld = (px, py) => {
    const u = px / mini.clientWidth * 2 * N - N, v = py / mini.clientHeight * 2 * N;
    return { x: Math.max(0, Math.min(N, (u + v) / 2)), y: Math.max(0, Math.min(N, (v - u) / 2)) };
  };

  const viewerPl = () => (r.viewer >= 0 ? state.players[r.viewer] : null);
  const canSee = e => r.viewer < 0 || isVisibleTo(state, r.viewer, e);
  const tileVisible = (x, y) => { const pl = viewerPl(); return !pl || pl.visible[Math.floor(y) * N + Math.floor(x)] === 1; };
  const tileExplored = (x, y) => { const pl = viewerPl(); return !pl || pl.explored[Math.floor(y) * N + Math.floor(x)] === 1; };
  r.canSee = canSee;

  r.addEvents = (events, now) => {
    for (const ev of events) {
      if (ev.type === 'shot') {
        r.effects.push({ ...ev, t0: now, dur: ev.ranged ? (ev.unit === 'spitter' ? 0.3 : 0.14) : 0.16 });
        if (ev.splash) r.effects.push({ type: 'boom', x: ev.tx, y: ev.ty, size: 1.6, t0: now + 0.05, dur: 0.35 });
      } else if (ev.type === 'death') {
        r.effects.push({ type: 'boom', x: ev.x, y: ev.y, size: ev.kind === 'building' ? ev.size * 1.2 : 1.1, t0: now, dur: ev.kind === 'building' ? 0.9 : 0.45, big: ev.kind === 'building' });
      } else if (ev.type === 'domeHit') {
        r.effects.push({ type: 'ripple', x: ev.x, y: ev.y, owner: ev.player, t0: now, dur: 0.5 });
      } else if (ev.type === 'dome') {
        if (ev.what !== 'fading') r.effects.push({ type: ev.what === 'up' ? 'domeRise' : 'domeFall', x: ev.x, y: ev.y, t0: now, dur: ev.what === 'up' ? 1.2 : 1.0 });
      } else if (ev.type === 'attacked' && ev.player === r.viewer) {
        r.pings.push({ x: ev.x, y: ev.y, t0: now });
      }
    }
    if (r.effects.length > 600) r.effects.splice(0, r.effects.length - 600);
  };

  // --------------------------------------------------------------- drawing helpers
  // P: world point (x, y) raised h pixels (at zoom 1) -> screen point
  const P = (x, y, h = 0) => [(isoX(x, y) - r.cam.x) * z, (isoY(x, y) - h - r.cam.y) * z];
  const lerp = (a, b, t) => a + (b - a) * t;
  function poly(pts) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]); ctx.closePath(); }
  function circle(x, y, rr, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, rr), 0, TAU); if (fill) ctx.fill(); if (stroke) ctx.stroke(); }
  function ellipse(x, y, rx, ry, fill, stroke) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, TAU); if (fill) ctx.fill(); if (stroke) ctx.stroke(); }
  function line(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
  // a circle of radius rr (tiles) lying on the ground / at height h
  function groundEllipse(x, y, rr, h = 0) { const [sx, sy] = P(x, y, h); ctx.beginPath(); ctx.ellipse(sx, sy, Math.max(0.5, rr * SQ2 * HW * z), Math.max(0.5, rr * SQ2 * HH * z), 0, 0, TAU); }
  // an axis-aligned box on the grid with visible top, left (+y) and right (+x) faces
  function isoBox(x0, y0, x1, y1, hb, ht, top, left, right, edge = 'rgba(0,0,0,0.3)') {
    const lf = [P(x0, y1, hb), P(x1, y1, hb), P(x1, y1, ht), P(x0, y1, ht)];
    const rf = [P(x1, y1, hb), P(x1, y0, hb), P(x1, y0, ht), P(x1, y1, ht)];
    const tp = [P(x0, y0, ht), P(x1, y0, ht), P(x1, y1, ht), P(x0, y1, ht)];
    ctx.fillStyle = left; poly(lf); ctx.fill();
    ctx.fillStyle = right; poly(rf); ctx.fill();
    ctx.fillStyle = top; poly(tp); ctx.fill();
    if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = Math.max(0.6, 0.8 * z); poly(tp); ctx.stroke(); line(...P(x1, y1, hb), ...P(x1, y1, ht)); }
  }
  // strip on the two visible faces of a box, between heights h0 and h1
  function faceBand(x0, y0, x1, y1, h0, h1, col) {
    ctx.fillStyle = col;
    poly([P(x0, y1, h0), P(x1, y1, h0), P(x1, y1, h1), P(x0, y1, h1)]); ctx.fill();
    poly([P(x1, y1, h0), P(x1, y0, h0), P(x1, y0, h1), P(x1, y1, h1)]); ctx.fill();
  }
  function cylinder(x, y, rr, hb, ht, light, dark, top) {
    const [sx, sy] = P(x, y, hb), [, ty] = P(x, y, ht), rx = rr * SQ2 * HW * z, ry = rr * SQ2 * HH * z;
    const gr = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
    gr.addColorStop(0, light); gr.addColorStop(0.35, light); gr.addColorStop(1, dark);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI); ctx.lineTo(sx - rx, ty); ctx.lineTo(sx + rx, ty); ctx.closePath(); ctx.fill();
    ctx.fillStyle = top; ellipse(sx, ty, rx, ry, true);
  }
  function dome(x, y, rr, hb, hd, c0, c1, c2) {
    const [sx, sy] = P(x, y, hb), rx = rr * SQ2 * HW * z, ry = rr * SQ2 * HH * z, hz = hd * z;
    const gr = ctx.createRadialGradient(sx - rx * 0.35, sy - hz * 0.7, rx * 0.08, sx, sy - hz * 0.3, rx * 1.15);
    gr.addColorStop(0, c0); gr.addColorStop(0.6, c1); gr.addColorStop(1, c2);
    ctx.fillStyle = gr;
    ctx.beginPath(); ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI); ctx.ellipse(sx, sy, rx, ry + hz, 0, Math.PI, TAU); ctx.fill();
  }
  // a point on the surface of a dome, given an angle round it and a fraction of its height
  function domePoint(x, y, rr, hb, hd, ang, t) {
    const k = Math.sqrt(Math.max(0, 1 - t * t));
    return P(x + Math.cos(ang) * rr * k, y + Math.sin(ang) * rr * k, hb + hd * t);
  }
  function crystal(sx, sy, w, h, glow) { // upright octahedron centred at (sx, sy)
    ctx.fillStyle = glow;
    poly([[sx, sy - h], [sx - w, sy], [sx, sy + h * 0.55]]); ctx.fill();
    ctx.fillStyle = 'rgba(40,110,170,0.9)';
    poly([[sx, sy - h], [sx + w, sy], [sx, sy + h * 0.55]]); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    poly([[sx, sy - h], [sx - w * 0.45, sy - h * 0.25], [sx - w * 0.1, sy]]); ctx.fill();
  }
  function halo(sx, sy, rad, rgb, a) {
    const gr = ctx.createRadialGradient(sx, sy, 0, sx, sy, rad);
    gr.addColorStop(0, `rgba(${rgb},${a})`); gr.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = gr; circle(sx, sy, rad, true);
  }

  // --------------------------------------------------------------- creep
  function updateCreep() {
    const srcs = [];
    const pl = viewerPl();
    for (const e of state.ents.values()) if (e.kind === 'building' && BUILDINGS[e.type].creep && e.done && (!pl || e.owner === r.viewer || isVisibleTo(state, r.viewer, e))) srcs.push(e);
    if (pl) for (const g of pl.memory.values()) if (BUILDINGS[g.type].creep && g.done && !srcs.some(s => s.id === g.id)) srcs.push(g);
    const key = r.viewer + ':' + srcs.map(s => s.id).join(',');
    if (key === creepKey) return;
    creepKey = key; creepGrid.fill(0);
    for (const s of srcs) {
      const R = BUILDINGS[s.type].creep;
      for (let y = Math.floor(s.y - R); y <= s.y + R; y++) for (let x = Math.floor(s.x - R); x <= s.x + R; x++) {
        if (x < 0 || y < 0 || x >= N || y >= N || !state.map.pass[y * N + x]) continue;
        if (Math.hypot(x + 0.5 - s.x, y + 0.5 - s.y) <= R) creepGrid[y * N + x] = 1;
      }
    }
    const img = cctx.createImageData(N, N);
    for (let i = 0; i < N * N; i++) if (creepGrid[i]) {
      const x = i % N, y = (i / N) | 0, n = hash(x, y, 12);
      img.data.set([88 + n * 30, 30 + n * 14, 86 + n * 20, 150], i * 4);
    }
    cctx.putImageData(img, 0, 0);
  }
  // draw an N x N per-tile image (fog, creep) over the map with the iso transform
  function drawTileImage(img) {
    const d = r.dpr, k = z * d;
    ctx.save();
    ctx.setTransform(HW * k, HH * k, -HW * k, HH * k, -r.cam.x * k, -r.cam.y * k);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  // --------------------------------------------------------------- main draw
  r.draw = (alpha, ui, now) => {
    r.resize();
    r.clampCam();
    z = r.zoom;
    const dpr = r.dpr, W = r.W, H = r.H;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07080a'; ctx.fillRect(0, 0, W, H);

    ctx.imageSmoothingEnabled = z < 1;
    drawTerrain(ctx, r.cam, z, W, H);

    // visible world range (the screen is a rotated rectangle in world space)
    const cs = [r.screenToWorld(0, 0), r.screenToWorld(W, 0), r.screenToWorld(0, H), r.screenToWorld(W, H)];
    const vx0 = Math.min(...cs.map(c => c.x)) - 3, vx1 = Math.max(...cs.map(c => c.x)) + 5;
    const vy0 = Math.min(...cs.map(c => c.y)) - 3, vy1 = Math.max(...cs.map(c => c.y)) + 5;
    const onScreen = (x, y, m = 80) => { const sx = (isoX(x, y) - r.cam.x) * z, sy = (isoY(x, y) - r.cam.y) * z; return sx > -m * z && sx < W + m * z && sy > -m * z && sy < H + (m + 20) * z; };

    // creep
    updateCreep();
    drawTileImage(creep);
    ctx.fillStyle = 'rgba(160,80,150,0.22)';
    for (let y = Math.max(0, Math.floor(vy0)); y < Math.min(N, vy1); y++) for (let x = Math.max(0, Math.floor(vx0)); x < Math.min(N, vx1); x++) {
      if (!creepGrid[y * N + x] || hash(x, y, 5) > 0.3) continue;
      const [px, py] = P(x + hash(x, y, 6), y + hash(x, y, 7));
      ellipse(px, py, 6 * z, 3 * z, true);
    }

    // fog of war goes under the objects, so tall art is never cut off by the fog behind it
    const pl = viewerPl();
    if (pl) {
      const d = fogImg.data, vis = pl.visible, ex = pl.explored;
      for (let i = 0, j = 3; i < N * N; i++, j += 4) d[j] = vis[i] ? 0 : ex[i] ? 150 : 255;
      fctx.putImageData(fogImg, 0, 0);
      drawTileImage(fog);
    }

    // placement helpers under everything
    if (ui.placement) {
      const bd = BUILDINGS[ui.placement.btype];
      if (bd.needsPower || bd.power) {
        for (const e of state.ents.values()) {
          if (e.kind !== 'building' || e.owner !== ui.player || !BUILDINGS[e.type].power) continue;
          ctx.fillStyle = 'rgba(90,170,255,0.13)'; ctx.strokeStyle = 'rgba(120,190,255,0.5)'; ctx.lineWidth = 1.5;
          groundEllipse(e.x, e.y, BUILDINGS[e.type].power); ctx.fill(); ctx.stroke();
        }
      }
    }
    if (ui.placement && BUILDINGS[ui.placement.btype].dome && ui.player >= 0) {
      const st0 = state.players[ui.player].start;
      ctx.fillStyle = 'rgba(90,170,255,0.10)'; ctx.strokeStyle = 'rgba(140,200,255,0.6)'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]);
      groundEllipse(st0.x, st0.y, COLONY_SHIELD.placeWithin); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(140,200,255,0.3)'; groundEllipse(st0.x, st0.y, COLONY_SHIELD.radius); ctx.stroke(); ctx.setLineDash([]);
    }
    if (ui.placement) {
      const { btype, tx, ty, ok } = ui.placement;
      const s = BUILDINGS[btype].size;
      ctx.fillStyle = ok ? 'rgba(60,220,110,0.30)' : 'rgba(240,60,60,0.35)';
      ctx.strokeStyle = ok ? 'rgba(120,255,160,0.9)' : 'rgba(255,110,110,0.9)'; ctx.lineWidth = 2;
      poly([P(tx, ty), P(tx + s, ty), P(tx + s, ty + s), P(tx, ty + s)]); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
      for (let k = 1; k < s; k++) { line(...P(tx + k, ty), ...P(tx + k, ty + s)); line(...P(tx, ty + k), ...P(tx + s, ty + k)); }
    }

    // entities, painter-sorted by depth (x + y of their centre)
    const list = [];
    for (const e of state.ents.values()) {
      if (e.dead || e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1 || !onScreen(e.x, e.y)) continue;
      if (e.kind === 'resource') { if (tileExplored(e.x, e.y)) list.push([e.x + e.y, e, 0]); continue; }
      if (e.kind === 'unit' && e.hidden) continue;
      if (!canSee(e)) continue;
      list.push([e.kind === 'building' ? e.tx + e.ty + e.size : lerp(e.px, e.x, alpha) + lerp(e.py, e.y, alpha) + (e.air ? 1000 : 0), e, 0]);
    }
    if (pl) for (const g of pl.memory.values()) {
      const live = state.ents.get(g.id);
      if (live && canSee(live)) continue;
      if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
      list.push([g.tx + g.ty + g.size, g, 1]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const sel = ui.selection;
    for (const [, e, ghost] of list) {
      if (e.kind === 'resource') {
        const dim = !tileVisible(e.x, e.y);
        if (dim) { ctx.save(); ctx.globalAlpha = 0.5; }
        drawResource(e, now);
        if (dim) ctx.restore();
      } else if (ghost || e.kind === 'building') drawBuilding(e, now, ghost, sel.has(e.id));
      else drawUnit(e, alpha, now, sel.has(e.id));
    }

    // effects
    r.effects = r.effects.filter(fx => now - fx.t0 < fx.dur);
    for (const fx of r.effects) drawEffect(fx, now);
    for (const q of state.players) if (q.dome && domeSeen(q.dome)) drawDome(q.dome, now);

    // overlays
    for (const [, e, ghost] of list) {
      if (ghost || e.kind === 'resource') continue;
      const hovered = ui.hoverId === e.id;
      if (sel.has(e.id) || hovered || (e.hp < e.maxHp && e.kind === 'unit')) drawBars(e, alpha);
    }
    for (const id of sel) {
      const b = state.ents.get(id);
      if (!b || b.kind !== 'building' || !b.rally || b.owner !== ui.player) continue;
      const [ax, ay] = P(b.x, b.y), [bx, by] = P(b.rally.x, b.rally.y);
      ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(120,255,140,0.7)'; ctx.lineWidth = 1.5;
      line(ax, ay, bx, by); ctx.setLineDash([]);
      ctx.strokeStyle = '#d8ffe0'; ctx.lineWidth = 1.5; line(bx, by, bx, by - 16 * z);
      ctx.fillStyle = '#7dff8c'; poly([[bx, by - 16 * z], [bx + 10 * z, by - 12.5 * z + Math.sin(now * 5) * z], [bx, by - 9 * z]]); ctx.fill();
    }
    if (ui.dragRect) {
      const { x0, y0, x1, y1 } = ui.dragRect;
      ctx.strokeStyle = '#6dff8a'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(80,255,120,0.08)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    if (ui.orderMarker && now - ui.orderMarker.t0 < 0.5) {
      const m = ui.orderMarker, k = (now - m.t0) / 0.5;
      ctx.strokeStyle = m.attack ? `rgba(255,80,80,${1 - k})` : `rgba(90,255,120,${1 - k})`; ctx.lineWidth = 2;
      groundEllipse(m.x, m.y, 0.5 * (1 - k * 0.6)); ctx.stroke();
    }
    drawMinimap(now);
  };

  // --------------------------------------------------------------- resources
  function drawResource(e, now) {
    if (e.type === 'mineral') {
      const k = 0.55 + 0.45 * Math.min(1, e.amount / 1500);
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; groundEllipse(e.x + 0.05, e.y + 0.05, 0.5); ctx.fill();
      ctx.fillStyle = '#2d3a40'; groundEllipse(e.x, e.y, 0.36); ctx.fill();
      const shards = [[0.3, 0.3, 0.75], [0.62, 0.34, 0.95], [0.4, 0.62, 1.0], [0.7, 0.66, 0.7], [0.2, 0.75, 0.55]];
      for (let i = 0; i < shards.length; i++) {
        const [fx, fy, h] = shards[i];
        const [bx, by] = P(e.tx + fx, e.ty + fy), hh = (8 + 16 * h) * k * z, w = 4.2 * z, lean = (i % 2 ? 2 : -2) * z;
        const tw = Math.sin(now * 2 + e.id + i) * 0.1;
        ctx.fillStyle = '#6fd8ff'; poly([[bx - w, by], [bx + lean, by - hh], [bx, by + w * 0.5]]); ctx.fill();
        ctx.fillStyle = '#2b9ccc'; poly([[bx + lean, by - hh], [bx + w, by], [bx, by + w * 0.5]]); ctx.fill();
        ctx.fillStyle = `rgba(230,252,255,${0.45 + tw})`; poly([[bx - w * 0.6, by - hh * 0.2], [bx + lean, by - hh], [bx - w * 0.2, by - hh * 0.35]]); ctx.fill();
      }
    } else {
      const cx = e.tx + 1, cy = e.ty + 1;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; groundEllipse(cx + 0.1, cy + 0.1, 0.98); ctx.fill();
      dome(cx, cy, 0.92, 0, 7, '#4d5946', '#343d31', '#1d231c');
      ctx.fillStyle = '#0a0f09'; groundEllipse(cx, cy, 0.42, 7); ctx.fill();
      ctx.fillStyle = 'rgba(110,224,122,0.25)'; groundEllipse(cx, cy, 0.25, 7); ctx.fill();
      if (!e.building && tileVisible(e.x, e.y)) {
        const [sx, sy] = P(cx, cy, 7);
        for (let i = 0; i < 3; i++) {
          const t = (now * 0.6 + i / 3) % 1;
          ctx.fillStyle = `rgba(150,230,150,${0.25 * (1 - t)})`;
          circle(sx + Math.sin(i * 2 + now) * 4 * z, sy - t * 44 * z, (6 + t * 12) * z, true);
        }
      }
    }
  }

  // --------------------------------------------------------------- buildings
  function drawBuilding(b, now, ghost, selected) {
    const d = BUILDINGS[b.type], f = d.faction, s = b.size;
    const col = ghost ? shade(PLAYER_COLORS[b.owner], -0.35) : PLAYER_COLORS[b.owner];
    const done = b.done;
    const p = done ? 1 : Math.min(1, (b.progress || 0) / d.time);
    const x0 = b.tx, y0 = b.ty, x1 = b.tx + s, y1 = b.ty + s, cx = b.tx + s / 2, cy = b.ty + s / 2;
    ctx.save();
    if (ghost) ctx.globalAlpha = 0.55;
    if (selected) {
      ctx.strokeStyle = b.owner === r.viewer || r.viewer < 0 ? '#6dff8a' : '#ff6060'; ctx.lineWidth = 2;
      groundEllipse(cx, cy, s * 0.62); ctx.stroke();
    }
    // shadow, cast away from the light (upper left)
    ctx.fillStyle = 'rgba(0,0,0,0.26)';
    if (f === 'swarm') { groundEllipse(cx + 0.2, cy + 0.05, s * 0.46); ctx.fill(); }
    else {
      const i = b.type === 'pylon' ? 0.5 : 0.15, sh = Math.min(0.6, BH[b.type] * 0.008);
      poly([P(x0 + i, y0 + i), P(x1 - i + sh, y0 + i - sh * 0.4), P(x1 - i + sh, y1 - i), P(x0 + i, y1 - i)]); ctx.fill();
    }

    if (!done && !ghost) {
      if (f === 'vanguard') ctx.globalAlpha = 0.4 + 0.6 * p;
      if (f === 'ascendant') ctx.globalAlpha = 0.25 + 0.55 * p;
    }
    const k = { x0, y0, x1, y1, cx, cy, col, now, done, p, b };
    if (f === 'vanguard') drawVanguard(b.type, k);
    else if (f === 'swarm') drawSwarm(b.type, k);
    else drawAscendant(b.type, k);
    ctx.globalAlpha = ghost ? 0.55 : 1;

    if (!done && !ghost && f === 'vanguard') { // scaffolding
      const h = BH[b.type] * 0.55, i = 0.12;
      ctx.strokeStyle = 'rgba(235,200,80,0.85)'; ctx.lineWidth = 1;
      for (let t = 0; t <= 4; t++) {
        const u = x0 + i + (s - 2 * i) * t / 4, v = y0 + i + (s - 2 * i) * t / 4;
        line(...P(u, y1 - i, 0), ...P(u, y1 - i, h)); line(...P(x1 - i, v, 0), ...P(x1 - i, v, h));
      }
      for (let t = 1; t <= 3; t++) {
        const hh = h * t / 3;
        line(...P(x0 + i, y1 - i, hh), ...P(x1 - i, y1 - i, hh)); line(...P(x1 - i, y1 - i, hh), ...P(x1 - i, y0 + i, hh));
      }
    } else if (!done && !ghost && f === 'ascendant') { // warp-in shimmer
      const [sx, sy] = P(cx, cy, BH[b.type] * 0.4);
      halo(sx, sy, s * 30 * z, '120,200,255', 0.35 + 0.15 * Math.sin(now * 6));
      ctx.strokeStyle = `rgba(170,225,255,${0.5 + 0.3 * Math.sin(now * 8)})`; ctx.lineWidth = 1;
      for (let t = 0; t < 5; t++) { const u = (t / 5 + now * 0.3) % 1; groundEllipse(cx, cy, s * 0.45, u * BH[b.type]); ctx.stroke(); }
    }
    if (!ghost && b.repairedAt && state.tick - b.repairedAt < 8) {
      const [sx, sy] = P(cx, cy, BH[b.type] * 0.6);
      for (let i = 0; i < 2; i++) {
        const t = (now * 0.8 + i / 2 + b.id * 0.13) % 1, px = sx + Math.sin(i * 3 + b.id) * 14 * z, py = sy - t * 20 * z;
        ctx.strokeStyle = `rgba(120,255,140,${0.9 * (1 - t)})`; ctx.lineWidth = 2 * z;
        line(px - 3 * z, py, px + 3 * z, py); line(px, py - 3 * z, px, py + 3 * z);
      }
    }
    if (done && d.needsPower && !b.powered && !ghost) {
      const [sx, sy] = P(cx, cy, BH[b.type] * 0.6);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; circle(sx, sy, 10 * z, true);
      ctx.fillStyle = '#ff5a4f'; ctx.font = `bold ${Math.round(14 * z)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('⚡', sx, sy + z);
    }
    ctx.restore();
  }

  // Vanguard: riveted steel blocks, team-coloured stripes, hazard paint
  const VG = ['#8e97a1', '#6d7680', '#4a5159'];
  function vgBox(x0, y0, x1, y1, hb, ht, tone = 0) { isoBox(x0, y0, x1, y1, hb, ht, shade(VG[0], tone), shade(VG[1], tone), shade(VG[2], tone)); }
  function windows(x0, x1, y, h0, h1, n, lit) { // on the left (+y) face
    for (let i = 0; i < n; i++) {
      const a = x0 + (x1 - x0) * (i + 0.25) / n, bb = x0 + (x1 - x0) * (i + 0.75) / n;
      ctx.fillStyle = lit ? 'rgba(160,220,255,0.85)' : '#1d2126';
      poly([P(a, y, h0), P(bb, y, h0), P(bb, y, h1), P(a, y, h1)]); ctx.fill();
    }
  }
  function windowsR(x, y0, y1, h0, h1, n, lit) { // on the right (+x) face
    for (let i = 0; i < n; i++) {
      const a = y0 + (y1 - y0) * (i + 0.25) / n, bb = y0 + (y1 - y0) * (i + 0.75) / n;
      ctx.fillStyle = lit ? 'rgba(130,190,230,0.7)' : '#1d2126';
      poly([P(x, a, h0), P(x, bb, h0), P(x, bb, h1), P(x, a, h1)]); ctx.fill();
    }
  }
  function drawVanguard(type, { x0, y0, x1, y1, cx, cy, col, now, done, b }) {
    const blink = (now * 1.5) % 1 < 0.5;
    if (type === 'hub') {
      vgBox(x0 + 0.08, y0 + 0.08, x1 - 0.08, y1 - 0.08, 0, 6, -0.35);
      vgBox(x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25, 6, 30);
      faceBand(x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25, 21, 25, col);
      ctx.fillStyle = '#1b1f24'; poly([P(cx - 0.5, y1 - 0.25, 6), P(cx + 0.5, y1 - 0.25, 6), P(cx + 0.5, y1 - 0.25, 18), P(cx - 0.5, y1 - 0.25, 18)]); ctx.fill();
      ctx.strokeStyle = '#e8c547'; ctx.lineWidth = 1.5 * z;
      for (let t = 0; t < 3; t++) line(...P(cx - 0.45 + t * 0.3, y1 - 0.25, 7), ...P(cx - 0.3 + t * 0.3, y1 - 0.25, 17));
      windowsR(x1 - 0.25, y0 + 0.3, y1 - 0.3, 11, 16, 5, done);
      vgBox(x0 + 0.35, y0 + 0.35, x0 + 1.55, y0 + 1.55, 30, 44, 0.08);
      windows(x0 + 0.35, x0 + 1.55, y0 + 1.55, 36, 40, 3, done);
      // landing pad on the front of the roof
      ctx.fillStyle = '#2d3238'; groundEllipse(cx + 0.45, cy + 0.45, 0.62, 30); ctx.fill();
      ctx.strokeStyle = '#e8c547'; ctx.lineWidth = 2 * z; groundEllipse(cx + 0.45, cy + 0.45, 0.5, 30); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 3 * z;
      line(...P(cx + 0.2, cy + 0.45, 30), ...P(cx + 0.7, cy + 0.45, 30)); line(...P(cx + 0.45, cy + 0.2, 30), ...P(cx + 0.45, cy + 0.7, 30));
      ctx.strokeStyle = '#9aa3ad'; ctx.lineWidth = 1.5 * z; line(...P(x0 + 0.6, y0 + 0.6, 44), ...P(x0 + 0.6, y0 + 0.6, 62));
      line(...P(x0 + 0.6, y0 + 0.6, 56), ...P(x0 + 0.85, y0 + 0.6, 54));
      ctx.fillStyle = blink ? '#ff4040' : '#601010'; circle(...P(x0 + 0.6, y0 + 0.6, 63), 2.2 * z, true);
    } else if (type === 'depot') {
      vgBox(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 0, 16);
      faceBand(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 7, 10, col);
      ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1;
      for (let t = 1; t < 5; t++) { const v = y0 + 0.15 + (y1 - y0 - 0.3) * t / 5; line(...P(x0 + 0.15, v, 16), ...P(x1 - 0.15, v, 16)); }
      vgBox(cx - 0.3, cy - 0.3, cx + 0.2, cy + 0.2, 16, 22, 0.1);
      ctx.fillStyle = done ? '#7dff8c' : '#333'; circle(...P(x1 - 0.3, y1 - 0.15, 12), 1.8 * z, true);
    } else if (type === 'barracks') {
      vgBox(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, 0, 26);
      faceBand(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, 18, 21, col);
      ctx.fillStyle = '#1b1f24'; poly([P(cx - 0.55, y1 - 0.2, 0), P(cx + 0.55, y1 - 0.2, 0), P(cx + 0.55, y1 - 0.2, 15), P(cx - 0.55, y1 - 0.2, 15)]); ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 * z; poly([P(cx - 0.55, y1 - 0.2, 0), P(cx - 0.55, y1 - 0.2, 15), P(cx + 0.55, y1 - 0.2, 15), P(cx + 0.55, y1 - 0.2, 0)]); ctx.stroke();
      windowsR(x1 - 0.2, y0 + 0.3, y1 - 0.3, 9, 13, 4, done);
      vgBox(x0 + 0.35, y0 + 0.35, x1 - 0.35, cy - 0.1, 26, 33, 0.06);
      cylinder(x0 + 0.9, cy + 0.6, 0.18, 26, 31, '#7d8690', '#454c54', '#2b3036');
      cylinder(x1 - 0.8, cy + 0.6, 0.18, 26, 31, '#7d8690', '#454c54', '#2b3036');
      // flag
      const [fx, fy] = P(x1 - 0.5, y0 + 0.5, 33);
      ctx.strokeStyle = '#c9cfd6'; ctx.lineWidth = 1.2 * z; line(fx, fy, fx, fy - 18 * z);
      const wv = Math.sin(now * 5) * 2 * z;
      ctx.fillStyle = col; poly([[fx, fy - 18 * z], [fx + 12 * z, fy - 16 * z + wv], [fx + 11 * z, fy - 10 * z + wv], [fx, fy - 11 * z]]); ctx.fill();
    } else if (type === 'factory') {
      vgBox(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 0, 28, -0.08);
      faceBand(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 22, 25, col);
      // garage door with hazard stripes on the right face
      const gy0 = cy - 0.7, gy1 = cy + 0.7, X = x1 - 0.15;
      ctx.fillStyle = '#26292e'; poly([P(X, gy0, 0), P(X, gy1, 0), P(X, gy1, 18), P(X, gy0, 18)]); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      for (let t = 3; t < 18; t += 3) line(...P(X, gy0, t), ...P(X, gy1, t));
      for (let t = 0; t < 7; t++) {
        const a = gy0 + (gy1 - gy0) * t / 7, bb = gy0 + (gy1 - gy0) * (t + 0.5) / 7;
        ctx.fillStyle = '#e8c547'; poly([P(X, a, 18), P(X, bb, 18), P(X, bb + 0.08, 21), P(X, a + 0.08, 21)]); ctx.fill();
      }
      windows(x0 + 0.3, x1 - 0.3, y1 - 0.15, 12, 16, 4, done);
      ctx.fillStyle = 'rgba(150,200,230,0.5)'; poly([P(x0 + 0.6, cy - 0.2, 28), P(x1 - 0.5, cy - 0.2, 28), P(x1 - 0.5, cy + 0.2, 28), P(x0 + 0.6, cy + 0.2, 28)]); ctx.fill();
      cylinder(x0 + 0.65, y0 + 0.65, 0.3, 28, 64, '#7d8690', '#3b4149', '#1d2126');
      ctx.fillStyle = col; poly([...[0, 1, 2, 3, 4, 5, 6].map(t => { const a = Math.PI * t / 6; return P(x0 + 0.65 + Math.cos(a) * 0.3, y0 + 0.65 + Math.sin(a) * 0.3, 52); }), ...[6, 5, 4, 3, 2, 1, 0].map(t => { const a = Math.PI * t / 6; return P(x0 + 0.65 + Math.cos(a) * 0.3, y0 + 0.65 + Math.sin(a) * 0.3, 56); })]); ctx.fill();
      if (done) {
        const [sx, sy] = P(x0 + 0.65, y0 + 0.65, 64);
        for (let i = 0; i < 3; i++) { const t = (now * 0.4 + i / 3) % 1; ctx.fillStyle = `rgba(190,190,190,${0.35 * (1 - t)})`; circle(sx + t * 10 * z, sy - t * 30 * z, (4 + t * 9) * z, true); }
      }
    } else if (type === 'turret') {
      vgBox(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, 0, 14, -0.1);
      faceBand(x0 + 0.2, y0 + 0.2, x1 - 0.2, y1 - 0.2, 8, 11, col);
      cylinder(cx, cy, 0.42, 14, 20, '#7d8690', '#3b4149', '#5d676f');
      // twin guns on a swivel, aimed at the current target
      const f = b.facing, c = Math.cos(f), sn = Math.sin(f);
      const gun = side => { const ox = -sn * side * 0.14, oy = c * side * 0.14; ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 3 * z; line(...P(cx + ox, cy + oy, 24), ...P(cx + ox + c * 0.75, cy + oy + sn * 0.75, 25)); };
      const back = c + sn < 0;
      if (back) { gun(-1); gun(1); }
      ctx.fillStyle = '#9aa3ad'; groundEllipse(cx, cy, 0.3, 24); ctx.fill();
      ctx.fillStyle = col; groundEllipse(cx, cy, 0.14, 25); ctx.fill();
      if (!back) { gun(-1); gun(1); }
      if (b.target && b.cooldown > BUILDINGS.turret.cooldown - 0.1) { const [mx, my] = P(cx + c * 0.85, cy + sn * 0.85, 25); halo(mx, my, 8 * z, '255,220,120', 0.9); }
    } else if (type === 'bulwark') { // shield generator: armoured block with an emitter array
      vgBox(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 12, -0.2);
      faceBand(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 6, 9, col);
      cylinder(cx, cy, 0.5, 12, 26, '#8e97a1', '#3b4149', '#5d676f');
      const up = !!state.players[b.owner]?.dome, ready = done && !up && state.tick >= (b.rechargeUntil || 0);
      for (let i = 0; i < 4; i++) { // four emitter prongs
        const an = i * TAU / 4 + TAU / 8, px = cx + Math.cos(an) * 0.42, py = cy + Math.sin(an) * 0.42;
        ctx.strokeStyle = '#c9cfd6'; ctx.lineWidth = 2 * z; line(...P(px, py, 26), ...P(cx + Math.cos(an) * 0.2, cy + Math.sin(an) * 0.2, 44));
      }
      const [ox, oy] = P(cx, cy, 44);
      if (done) halo(ox, oy, (up ? 22 : 12) * z, '120,200,255', up ? 0.8 : ready ? 0.45 : 0.15);
      ctx.fillStyle = up || ready ? '#dff4ff' : '#58606a'; circle(ox, oy, 4 * z, true);
    } else if (type === 'refinery') {
      vgBox(x0 + 0.08, y0 + 0.08, x1 - 0.08, y1 - 0.08, 0, 6, -0.3);
      cylinder(cx - 0.1, cy - 0.1, 0.6, 6, 34, '#8e97a1', '#3b4149', '#5d676f');
      ctx.fillStyle = col; poly([...[0, 1, 2, 3, 4, 5, 6].map(t => { const a = Math.PI * t / 6; return P(cx - 0.1 + Math.cos(a) * 0.6, cy - 0.1 + Math.sin(a) * 0.6, 22); }), ...[6, 5, 4, 3, 2, 1, 0].map(t => { const a = Math.PI * t / 6; return P(cx - 0.1 + Math.cos(a) * 0.6, cy - 0.1 + Math.sin(a) * 0.6, 26); })]); ctx.fill();
      ctx.fillStyle = done ? `rgba(110,224,122,${0.7 + 0.2 * Math.sin(now * 3)})` : '#334'; groundEllipse(cx - 0.1, cy - 0.1, 0.25, 34); ctx.fill();
      ctx.strokeStyle = '#5d676f'; ctx.lineWidth = 3 * z; line(...P(cx + 0.4, cy + 0.3, 12), ...P(x1 - 0.2, y1 - 0.2, 12)); line(...P(x1 - 0.2, y1 - 0.2, 12), ...P(x1 - 0.2, y1 - 0.2, 6));
    }
  }

  // Swarm: living, pulsing organic mounds with team-coloured veins
  const SW = ['#b27995', '#6b3552', '#2e1322'];
  function drawSwarm(type, { x0, y0, x1, y1, cx, cy, col, now, done, p, b }) {
    const pulse = 1 + 0.03 * Math.sin(now * 2 + b.id);
    const k = (done ? 1 : 0.45 + 0.55 * p) * pulse;
    const veins = (x, y, rr, hd, n) => {
      ctx.strokeStyle = col; ctx.globalAlpha *= 0.75; ctx.lineWidth = Math.max(1, 1.6 * z);
      for (let i = 0; i < n; i++) {
        const a = i * TAU / n + b.id * 0.7 + 0.3;
        const p0 = domePoint(x, y, rr, 0, hd, a, 0.85), p1 = domePoint(x, y, rr, 0, hd, a + 0.35, 0.45), p2 = domePoint(x, y, rr, 0, hd, a + 0.1, 0.05);
        if (Math.sin(a) + Math.cos(a) < -0.6) continue; // on the far side
        ctx.beginPath(); ctx.moveTo(...p0); ctx.quadraticCurveTo(...p1, ...p2); ctx.stroke();
      }
      ctx.globalAlpha /= 0.75;
    };
    if (!done) {
      dome(cx, cy, 0.95 * k * (x1 - x0) / 2, 0, BH[type] * 0.6 * k, '#8a5a74', '#5a2e44', '#2c1422');
      veins(cx, cy, 0.95 * k * (x1 - x0) / 2, BH[type] * 0.6 * k, 5);
      return;
    }
    if (type === 'hive') {
      dome(cx - 0.85, cy - 0.25, 0.55, 0, 22, ...SW); dome(cx - 0.25, cy - 0.85, 0.55, 0, 24, ...SW);
      dome(cx, cy, 1.2 * pulse, 0, 42 * pulse, ...SW);
      veins(cx, cy, 1.2 * pulse, 42 * pulse, 7);
      for (let i = 0; i < 6; i++) { // bony crown
        const a = i * TAU / 6 + 0.4, [bx, by] = domePoint(cx, cy, 1.2, 0, 42 * pulse, a, 0.8);
        ctx.fillStyle = '#e3d2b4'; poly([[bx - 2.5 * z, by], [bx + Math.cos(a) * 4 * z, by - 11 * z], [bx + 2.5 * z, by]]); ctx.fill();
      }
      dome(cx + 0.75, cy + 0.45, 0.45, 0, 18, ...SW);
      const [mx, my] = domePoint(cx, cy, 1.2, 0, 42, Math.PI * 0.25, 0.25);
      ctx.fillStyle = '#1a0a12'; ellipse(mx, my, 9 * z, 5 * z, true);
      ctx.fillStyle = `rgba(255,150,80,${0.35 + 0.2 * Math.sin(now * 3)})`; ellipse(mx, my + z, 5 * z, 2.5 * z, true);
      if (b.larva !== undefined && (b.owner === r.viewer || r.viewer < 0)) {
        for (let i = 0; i < b.larva; i++) {
          const [lx, ly] = P(x0 + 0.6 + i * 0.7, y1 + 0.15);
          ctx.fillStyle = '#c9a36a'; ellipse(lx + Math.sin(now * 3 + i) * 2 * z, ly, 4.5 * z, 2.8 * z, true);
          ctx.fillStyle = 'rgba(80,40,20,0.6)'; ellipse(lx + Math.sin(now * 3 + i) * 2 * z + 2 * z, ly, 1.5 * z, 2 * z, true);
        }
      }
    } else if (type === 'pod') {
      dome(cx, cy, 0.8 * pulse, 0, 28 * pulse, '#c08aa4', '#7a3e5d', '#33162a');
      veins(cx, cy, 0.8 * pulse, 28 * pulse, 5);
      for (let i = 0; i < 5; i++) {
        const [px, py] = domePoint(cx, cy, 0.8, 0, 28, 0.2 + i * 0.35, 0.3 + (i % 3) * 0.2);
        halo(px, py, 6 * z, '255,200,150', 0.3 + 0.2 * Math.sin(now * 3 + i));
        ctx.fillStyle = 'rgba(255,220,180,0.7)'; circle(px, py, 2 * z, true);
      }
    } else if (type === 'pit') {
      dome(cx, cy, 0.9, 0, 10, ...SW);
      ctx.fillStyle = '#1c0810'; groundEllipse(cx, cy, 0.55, 9); ctx.fill();
      ctx.fillStyle = `rgba(220,60,60,${0.45 + 0.2 * Math.sin(now * 4)})`; groundEllipse(cx, cy, 0.35, 9); ctx.fill();
      for (let i = 0; i < 7; i++) {
        const a = i * TAU / 7 + 0.2, [bx, by] = P(cx + Math.cos(a) * 0.72, cy + Math.sin(a) * 0.72, 6);
        ctx.fillStyle = '#e3d2b4'; poly([[bx - 2 * z, by], [bx - Math.sin(a) * 3 * z, by - 14 * z], [bx + 2 * z, by]]); ctx.fill();
      }
    } else if (type === 'den') {
      dome(cx, cy, 0.85, 0, 22, ...SW);
      veins(cx, cy, 0.85, 22, 4);
      for (let i = 0; i < 4; i++) { // arching ribs
        const a = i * TAU / 4 + 0.8, [ax, ay] = P(cx + Math.cos(a) * 0.75, cy + Math.sin(a) * 0.75, 4), [tx, ty] = P(cx, cy, 36);
        ctx.strokeStyle = '#d7c4a2'; ctx.lineWidth = 2.5 * z;
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(ax + (ax - tx) * 0.2, ty, tx + (ax - tx) * 0.25, ty + 4 * z); ctx.stroke();
      }
      const [ex, ey] = P(cx, cy, 24);
      halo(ex, ey, 12 * z, '123,211,90', 0.5); ctx.fillStyle = '#9be36a'; circle(ex, ey, 3.5 * z, true);
    } else if (type === 'heart') { // shield generator: a beating heart under a blue membrane
      const up = !!state.players[b.owner]?.dome, ready = !up && state.tick >= (b.rechargeUntil || 0);
      const beat = 1 + 0.06 * Math.max(0, Math.sin(now * (up ? 7 : 3.5)));
      dome(cx, cy, 0.8, 0, 14, ...SW);
      veins(cx, cy, 0.8, 14, 6);
      dome(cx, cy, 0.5 * beat, 12, 16 * beat, '#ff9ab8', '#b0305a', '#4a0f24');
      ctx.fillStyle = `rgba(120,200,255,${up ? 0.35 : ready ? 0.22 : 0.08})`;
      const [mx, my] = P(cx, cy, 12); ctx.beginPath(); ctx.ellipse(mx, my, 0.62 * SQ2 * HW * z, (0.62 * SQ2 * HH + 22) * z, 0, Math.PI, TAU); ctx.ellipse(mx, my, 0.62 * SQ2 * HW * z, 0.62 * SQ2 * HH * z, 0, 0, Math.PI); ctx.fill();
      ctx.strokeStyle = `rgba(170,230,255,${up ? 0.8 : 0.4})`; ctx.lineWidth = z; ctx.stroke();
    } else if (type === 'thorn') {
      dome(cx, cy, 0.75, 0, 12, '#9a6a84', '#5a2e44', '#2c1422');
      veins(cx, cy, 0.75, 12, 5);
      // a thick spine that rears up and lashes towards its target
      const f = b.facing, strike = b.target ? Math.max(0, Math.sin(now * 6)) : 0, sway = Math.sin(now * 1.5 + b.id) * 0.1;
      const [bx, by] = P(cx, cy, 10), [mx, my] = P(cx - Math.cos(f) * 0.2 + sway, cy - Math.sin(f) * 0.2, 46 - strike * 6), [tx, ty] = P(cx + Math.cos(f) * (0.45 + strike * 0.35), cy + Math.sin(f) * (0.45 + strike * 0.35), 34 - strike * 8);
      ctx.strokeStyle = '#2c1422'; ctx.lineWidth = 11 * z; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
      ctx.strokeStyle = '#a0647f'; ctx.lineWidth = 8 * z;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 1.5 * z; ctx.globalAlpha *= 0.7;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.quadraticCurveTo(mx, my, tx, ty); ctx.stroke(); ctx.globalAlpha /= 0.7;
      const [dx, dy] = [(Math.cos(f) - Math.sin(f)) * HW, (Math.cos(f) + Math.sin(f)) * HH], dl = Math.hypot(dx, dy) || 1;
      ctx.fillStyle = '#efe0c4'; poly([[tx - dy / dl * 4 * z, ty + dx / dl * 4 * z], [tx + dx / dl * 14 * z, ty + dy / dl * 14 * z + 2 * z], [tx + dy / dl * 4 * z, ty - dx / dl * 4 * z]]); ctx.fill();
      for (let i = 0; i < 5; i++) {
        const a = i * TAU / 5 + 0.5, [sx, sy] = domePoint(cx, cy, 0.75, 0, 12, a, 0.45);
        ctx.fillStyle = '#e3d2b4'; poly([[sx - 2 * z, sy], [sx, sy - 8 * z], [sx + 2 * z, sy]]); ctx.fill();
      }
    } else if (type === 'extractor') {
      dome(cx, cy, 0.85, 0, 22 * pulse, ...SW);
      veins(cx, cy, 0.85, 22 * pulse, 5);
      cylinder(cx, cy, 0.25, 18, 27, '#8a5a74', '#3c1a2c', '#1a0a12');
      const [vx, vy] = P(cx, cy, 27);
      ctx.fillStyle = `rgba(120,230,120,${0.55 + 0.25 * Math.sin(now * 3)})`; ellipse(vx, vy, 7 * z, 3.5 * z, true);
    }
  }

  // Ascendant: stepped golden platforms, pillars and floating blue crystals
  const AS = ['#f0e6c8', '#cdb885', '#9a8550'];
  function asBox(x0, y0, x1, y1, hb, ht, tone = 0) { isoBox(x0, y0, x1, y1, hb, ht, shade(AS[0], tone), shade(AS[1], tone), shade(AS[2], tone)); }
  function spire(x, y, hb, ht, w = 0.12) {
    asBox(x - w, y - w, x + w, y + w, hb, ht, -0.05);
    const [tx, ty] = P(x, y, ht + 8);
    ctx.fillStyle = '#e2cf98'; poly([P(x - w, y + w, ht), P(x + w, y + w, ht), [tx, ty]]); ctx.fill();
    ctx.fillStyle = '#a58f58'; poly([P(x + w, y + w, ht), P(x + w, y - w, ht), [tx, ty]]); ctx.fill();
  }
  function drawAscendant(type, { x0, y0, x1, y1, cx, cy, col, now, done, b }) {
    const glow = `rgba(127,211,255,${0.75 + 0.25 * Math.sin(now * 3)})`;
    const bob = Math.sin(now * 2 + b.id) * 2.5;
    if (type === 'nexus') {
      spire(x0 + 0.35, y0 + 0.35, 8, 30);
      asBox(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 8);
      faceBand(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 3, 5, col);
      asBox(x0 + 0.5, y0 + 0.5, x1 - 0.5, y1 - 0.5, 8, 18, 0.05);
      ctx.fillStyle = '#6e5a2a'; groundEllipse(cx, cy, 0.55, 18); ctx.fill();
      ctx.fillStyle = 'rgba(127,211,255,0.4)'; groundEllipse(cx, cy, 0.4, 18); ctx.fill();
      spire(x1 - 0.35, y0 + 0.35, 8, 30); spire(x0 + 0.35, y1 - 0.35, 8, 30);
      spire(x1 - 0.35, y1 - 0.35, 8, 30);
      const [sx, sy] = P(cx, cy, 44 + bob);
      if (done) halo(sx, sy, 26 * z, '127,211,255', 0.35);
      crystal(sx, sy, 8 * z, 18 * z, done ? glow : 'rgba(127,211,255,0.3)');
    } else if (type === 'pylon') {
      asBox(cx - 0.4, cy - 0.4, cx + 0.4, cy + 0.4, 0, 6);
      faceBand(cx - 0.4, cy - 0.4, cx + 0.4, cy + 0.4, 2, 4, col);
      const [sx, sy] = P(cx, cy, 32 + bob);
      if (done) { ctx.strokeStyle = 'rgba(127,211,255,0.35)'; ctx.lineWidth = 1; groundEllipse(cx, cy, 0.75, 6 + (now * 10 % 10)); ctx.stroke(); halo(sx, sy, 22 * z, '127,211,255', 0.3); }
      crystal(sx, sy, 7 * z, 20 * z, done ? glow : 'rgba(127,211,255,0.3)');
    } else if (type === 'gateway') {
      asBox(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 6);
      faceBand(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 2, 4, col);
      // an arch facing the viewer, from the left corner to the right corner
      const L = [x0 + 0.55, y1 - 0.55], R = [x1 - 0.55, y0 + 0.55];
      const [lx, ly] = P(L[0], L[1], 6), [rx] = P(R[0], R[1], 6), [, topY] = P(cx, cy, 44), [, archY] = P(cx, cy, 58);
      if (done) {
        const gr = ctx.createLinearGradient(0, topY, 0, ly);
        gr.addColorStop(0, `rgba(127,211,255,${0.5 + 0.2 * Math.sin(now * 4)})`); gr.addColorStop(1, 'rgba(60,140,220,0.15)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx, topY); ctx.quadraticCurveTo((lx + rx) / 2, archY, rx, topY); ctx.lineTo(rx, ly); ctx.closePath(); ctx.fill();
      }
      for (const [px, py] of [L, R]) asBox(px - 0.28, py - 0.28, px + 0.28, py + 0.28, 6, 44);
      ctx.strokeStyle = '#d9c68f'; ctx.lineWidth = 5 * z;
      ctx.beginPath(); ctx.moveTo(lx, topY); ctx.quadraticCurveTo((lx + rx) / 2, archY, rx, topY); ctx.stroke();
      ctx.strokeStyle = col; ctx.lineWidth = 2 * z;
      ctx.beginPath(); ctx.moveTo(lx, topY + 3 * z); ctx.quadraticCurveTo((lx + rx) / 2, archY + 3 * z, rx, topY + 3 * z); ctx.stroke();
      ctx.fillStyle = glow; circle((lx + rx) / 2, (topY + archY) / 2 - 2 * z, 3 * z, true);
    } else if (type === 'core') {
      asBox(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 0, 6);
      asBox(x0 + 0.45, y0 + 0.45, x1 - 0.45, y1 - 0.45, 6, 12, 0.05);
      faceBand(x0 + 0.15, y0 + 0.15, x1 - 0.15, y1 - 0.15, 2, 4, col);
      const [sx, sy] = P(cx, cy, 28 + bob);
      const tilt = Math.sin(now * 1.3);
      ctx.strokeStyle = '#d9c68f'; ctx.lineWidth = 2.5 * z;
      ctx.beginPath(); ctx.ellipse(sx, sy, 16 * z, 16 * z * Math.abs(tilt) + 2 * z, 0, Math.PI, TAU); ctx.stroke();
      if (done) halo(sx, sy, 16 * z, '127,211,255', 0.45);
      ctx.fillStyle = done ? glow : 'rgba(127,211,255,0.3)'; circle(sx, sy, 5.5 * z, true);
      ctx.strokeStyle = '#d9c68f';
      ctx.beginPath(); ctx.ellipse(sx, sy, 16 * z, 16 * z * Math.abs(tilt) + 2 * z, 0, 0, Math.PI); ctx.stroke();
    } else if (type === 'sanctum') { // shield generator: three crystals circling a bright core
      const up = !!state.players[b.owner]?.dome, ready = done && !up && state.tick >= (b.rechargeUntil || 0);
      asBox(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 6);
      faceBand(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 2, 4, col);
      asBox(x0 + 0.45, y0 + 0.45, x1 - 0.45, y1 - 0.45, 6, 12, 0.05);
      const [ox, oy] = P(cx, cy, 32 + bob);
      const orbit = now * (up ? 2.2 : 0.8);
      const cr = [0, 1, 2].map(i => { const an = orbit + i * TAU / 3; return [Math.sin(an) + Math.cos(an), P(cx + Math.cos(an) * 0.55, cy + Math.sin(an) * 0.55, 30 + bob + Math.sin(an * 2) * 3)]; });
      for (const [dp, [px, py]] of cr) if (dp < 0) crystal(px, py, 4 * z, 10 * z, done ? glow : 'rgba(127,211,255,0.3)');
      if (done) halo(ox, oy, (up ? 26 : 14) * z, '127,211,255', up ? 0.8 : ready ? 0.45 : 0.15);
      ctx.fillStyle = up || ready ? '#eaf8ff' : '#667'; circle(ox, oy, 5 * z, true);
      for (const [dp, [px, py]] of cr) if (dp >= 0) crystal(px, py, 4 * z, 10 * z, done ? glow : 'rgba(127,211,255,0.3)');
    } else if (type === 'spire') {
      asBox(x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25, 0, 6);
      faceBand(x0 + 0.25, y0 + 0.25, x1 - 0.25, y1 - 0.25, 2, 4, col);
      asBox(cx - 0.3, cy - 0.3, cx + 0.3, cy + 0.3, 6, 36, 0.04);
      const [tx, ty] = P(cx, cy, 36);
      ctx.fillStyle = '#e2cf98'; poly([P(cx - 0.3, cy + 0.3, 36), P(cx + 0.3, cy + 0.3, 36), [tx, ty - 6 * z]]); ctx.fill();
      ctx.fillStyle = '#a58f58'; poly([P(cx + 0.3, cy + 0.3, 36), P(cx + 0.3, cy - 0.3, 36), [tx, ty - 6 * z]]); ctx.fill();
      ctx.fillStyle = done ? glow : '#556'; poly([P(cx - 0.12, cy + 0.3, 14), P(cx + 0.12, cy + 0.3, 14), P(cx + 0.12, cy + 0.3, 30), P(cx - 0.12, cy + 0.3, 30)]); ctx.fill();
      const [ox, oy] = P(cx, cy, 50 + bob);
      if (done && b.powered) halo(ox, oy, (b.target ? 18 : 12) * z, '127,211,255', b.target ? 0.7 : 0.4);
      ctx.fillStyle = done && b.powered ? '#dff4ff' : '#667'; circle(ox, oy, 4.5 * z, true);
    } else if (type === 'assimilator') {
      asBox(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 0, 6);
      faceBand(x0 + 0.1, y0 + 0.1, x1 - 0.1, y1 - 0.1, 2, 4, col);
      dome(cx, cy, 0.65, 6, 18, '#fff6dc', '#cdb885', '#7d6a3a');
      for (let i = 0; i < 3; i++) {
        const [px, py] = domePoint(cx, cy, 0.65, 6, 18, 0.1 + i * 0.7, 0.3);
        ctx.fillStyle = done ? glow : '#556'; ellipse(px, py, 2 * z, 3.5 * z, true);
      }
      const [tx, ty] = P(cx, cy, 25);
      if (done) halo(tx, ty, 10 * z, '110,224,176', 0.6);
    }
  }

  // --------------------------------------------------------------- units
  function drawUnit(u, alpha, now, selected) {
    const wx = lerp(u.px, u.x, alpha), wy = lerp(u.py, u.y, alpha);
    const [gx, gy] = P(wx, wy);
    const d = UNITS[u.type], rr = d.radius, col = PLAYER_COLORS[u.owner];
    const f = u.facing || 0, c = Math.cos(f), s = Math.sin(f);
    // L: a point in the unit's own frame (a forward, b to its right, h up) -> screen
    const L = (a, b, h = 0) => { const ox = a * c - b * s, oy = a * s + b * c; return [gx + (ox - oy) * HW * z, gy + ((ox + oy) * HH - h) * z]; };
    const lell = (a, b, ra, rb, h) => { const pts = []; for (let i = 0; i < 16; i++) { const t = i * TAU / 16; pts.push(L(a + Math.cos(t) * ra, b + Math.sin(t) * rb, h)); } poly(pts); };
    const lquad = (a0, b0, a1, b1, h) => poly([L(a0, b0, h), L(a1, b0, h), L(a1, b1, h), L(a0, b1, h)]);
    const away = c + s < -0.2; // facing into the screen
    const moving = !!(u.path && u.path.length);
    const ph = now * 11 + u.id;
    if (selected) {
      ctx.strokeStyle = u.owner === r.viewer || r.viewer < 0 ? '#6dff8a' : '#ff6060'; ctx.lineWidth = 1.5;
      groundEllipse(wx, wy, rr * 1.3); ctx.stroke();
    }
    ctx.fillStyle = u.air ? 'rgba(0,0,0,0.22)' : 'rgba(0,0,0,0.35)'; groundEllipse(wx + 0.04, wy + 0.04, rr * (u.air ? 0.7 : 0.95)); ctx.fill();
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const legs = (hip, col2, w) => {
      const st = moving ? Math.sin(ph) * 0.12 : 0;
      ctx.strokeStyle = col2; ctx.lineWidth = w * z;
      line(...L(st, -0.08, 0), ...L(0, -0.07, hip)); line(...L(-st, 0.08, 0), ...L(0, 0.07, hip));
    };
    let top = UH[u.type];
    switch (u.type) {
      case 'engineer': {
        const h = 5 + Math.sin(now * 4 + u.id) * 1;
        ctx.fillStyle = 'rgba(120,200,255,0.3)'; groundEllipse(wx, wy, 0.18); ctx.fill();
        for (let t = 0; t <= 4; t++) { ctx.fillStyle = t < 4 ? '#454c54' : '#9aa3ad'; lell(0, 0, 0.3, 0.24, h + t); ctx.fill(); }
        ctx.strokeStyle = '#2b3036'; ctx.lineWidth = z; ctx.stroke();
        ctx.fillStyle = col; lell(-0.2, 0, 0.08, 0.2, h + 4.5); ctx.fill();
        const arm = () => {
          ctx.strokeStyle = '#d6b35a'; ctx.lineWidth = 2.2 * z; line(...L(0.12, 0.14, h + 6), ...L(0.44, 0.16, h + 4));
          const tip = L(0.47, 0.16, h + 4); ctx.fillStyle = '#d6b35a'; circle(tip[0], tip[1], 2 * z, true);
          if (((u.order.type === 'build' && u.order.phase === 'constructing') || (u.order.type === 'repair' && !u.path)) && Math.random() < 0.6) {
            ctx.fillStyle = '#ffe07a'; for (let i = 0; i < 3; i++) circle(tip[0] + (Math.random() - 0.5) * 8 * z, tip[1] + (Math.random() - 0.5) * 6 * z, 1.2 * z, true);
          }
        };
        if (away) arm();
        const [hx, hy] = L(0.02, 0, h + 9);
        const gr = ctx.createRadialGradient(hx - 2 * z, hy - 2.5 * z, z * 0.5, hx, hy, 6 * z);
        gr.addColorStop(0, '#dff4ff'); gr.addColorStop(0.35, '#7fb6d9'); gr.addColorStop(1, '#2c4a5e');
        ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(hx, hy + 2 * z, 6 * z, 7 * z, 0, Math.PI, TAU); ctx.ellipse(hx, hy + 2 * z, 6 * z, 3 * z, 0, 0, Math.PI); ctx.fill();
        if (!away) arm();
        break;
      }
      case 'hawk': { // gunship: fuselage, stub wings, two tilting engine pods
        const h = FLY + Math.sin(now * 3 + u.id) * 2;
        const pods = () => {
          for (const sd of [-1, 1]) {
            ctx.fillStyle = '#3b4149'; lell(-0.05, sd * 0.42, 0.18, 0.1, h + 1); ctx.fill();
            ctx.fillStyle = '#7d8690'; lell(-0.05, sd * 0.42, 0.16, 0.08, h + 3); ctx.fill();
            const [ex, ey] = L(-0.22, sd * 0.42, h + 2); halo(ex, ey, 6 * z, '120,190,255', 0.7);
          }
        };
        ctx.fillStyle = '#4a5159'; poly([L(0.1, -0.42, h + 3), L(0.1, 0.42, h + 3), L(-0.15, 0.42, h + 3), L(-0.15, -0.42, h + 3)]); ctx.fill();
        if (away) pods();
        ctx.fillStyle = '#4a5159'; lell(0, 0, 0.5, 0.17, h); ctx.fill();
        ctx.fillStyle = '#8e97a1'; lell(0, 0, 0.48, 0.15, h + 4); ctx.fill();
        ctx.fillStyle = col; poly([L(-0.35, -0.06, h + 4.5), L(-0.05, -0.06, h + 4.5), L(-0.05, 0.06, h + 4.5), L(-0.35, 0.06, h + 4.5)]); ctx.fill();
        ctx.fillStyle = 'rgba(160,220,255,0.85)'; lell(0.28, 0, 0.12, 0.08, h + 6); ctx.fill();
        ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 2 * z; line(...L(0.3, -0.1, h), ...L(0.6, -0.1, h)); line(...L(0.3, 0.1, h), ...L(0.6, 0.1, h));
        ctx.fillStyle = '#4a5159'; poly([L(-0.42, 0, h + 4), L(-0.55, 0, h + 13), L(-0.5, 0, h + 13), L(-0.3, 0, h + 4)]); ctx.fill();
        if (!away) pods();
        top = h + 14;
        break;
      }
      case 'stinger': { // winged insect with a curled tail
        const h = FLY + Math.sin(now * 5 + u.id) * 2.5;
        const flap = Math.sin(now * 40 + u.id);
        for (const sd of [-1, 1]) {
          ctx.fillStyle = 'rgba(210,230,255,0.35)'; ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = z;
          poly([L(0.08, sd * 0.06, h + 5), L(0.2, sd * 0.55, h + 8 + flap * 6), L(-0.25, sd * 0.5, h + 6 + flap * 5), L(-0.1, sd * 0.06, h + 5)]); ctx.fill(); ctx.stroke();
        }
        ctx.fillStyle = '#4b2f3f'; lell(-0.2, 0, 0.22, 0.12, h); ctx.fill();
        ctx.fillStyle = '#7a4a62'; lell(0.05, 0, 0.2, 0.13, h + 3); ctx.fill();
        ctx.fillStyle = col; lell(-0.25, 0, 0.1, 0.06, h + 3); ctx.fill();
        ctx.strokeStyle = '#2a1520'; ctx.lineWidth = 2.5 * z;
        ctx.beginPath(); ctx.moveTo(...L(-0.38, 0, h)); ctx.quadraticCurveTo(...L(-0.55, 0, h - 8), ...L(-0.35, 0, h - 10)); ctx.stroke();
        ctx.fillStyle = '#e3d2b4'; circle(...L(-0.33, 0, h - 10), 1.8 * z, true);
        ctx.fillStyle = '#2a1520'; lell(0.27, 0, 0.09, 0.08, h + 3); ctx.fill();
        if (!away) { ctx.fillStyle = '#9be36a'; circle(...L(0.32, -0.04, h + 4), 1.3 * z, true); circle(...L(0.32, 0.04, h + 4), 1.3 * z, true); }
        top = h + 12;
        break;
      }
      case 'seraph': { // crystal delta wing with a golden ring
        const h = FLY + 4 + Math.sin(now * 2 + u.id) * 3;
        ctx.fillStyle = '#b0913d'; poly([L(0.5, 0, h), L(-0.35, -0.45, h), L(-0.2, 0, h - 3), L(-0.35, 0.45, h)]); ctx.fill();
        ctx.fillStyle = '#efe4c4'; poly([L(0.5, 0, h + 3), L(-0.35, -0.45, h + 3), L(-0.2, 0, h + 5), L(-0.35, 0.45, h + 3)]); ctx.fill();
        ctx.fillStyle = col; poly([L(0.1, 0, h + 4), L(-0.25, -0.3, h + 3.5), L(-0.2, 0, h + 5), L(-0.25, 0.3, h + 3.5)]); ctx.fill();
        const [cx0, cy0] = L(0.05, 0, h + 8);
        halo(cx0, cy0, 12 * z, '127,211,255', 0.5);
        crystal(cx0, cy0, 4 * z, 8 * z, 'rgba(160,225,255,0.95)');
        ctx.strokeStyle = '#d9c68f'; ctx.lineWidth = 1.5 * z; ellipse(cx0, cy0 + 2 * z, 11 * z, 4 * z, false, true);
        top = h + 18;
        break;
      }
      case 'trooper': {
        const gun = () => { ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 2.6 * z; line(...L(0.02, 0.12, 12), ...L(0.46, 0.12, 13)); ctx.fillStyle = '#ffd98a'; };
        legs(9, '#2a2f36', 3);
        if (away) gun();
        const [bx, by] = L(0, 0, 13);
        const gr = ctx.createLinearGradient(bx - 6 * z, 0, bx + 6 * z, 0);
        gr.addColorStop(0, shade(col, 0.15)); gr.addColorStop(1, shade(col, -0.35));
        ctx.fillStyle = gr; ellipse(bx, by, 5.5 * z, 6 * z, true);
        ctx.fillStyle = '#b9c2cb'; for (const sd of [-0.17, 0.17]) { const [px, py] = L(0, sd, 16); circle(px, py, 2.6 * z, true); }
        const [hx, hy] = L(0, 0, 21);
        ctx.fillStyle = '#cfd6dc'; circle(hx, hy, 4 * z, true);
        ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.beginPath(); ctx.arc(hx, hy, 4 * z, 0.2, Math.PI - 0.2); ctx.fill();
        if (!away) { const [vx, vy] = L(0.12, 0, 21); ctx.fillStyle = '#7fd3ff'; ellipse(vx, vy, 2.4 * z, 1.4 * z, true); }
        if (!away) gun();
        break;
      }
      case 'crawler': {
        const roll = moving ? (now * 6) % 1 : 0;
        for (const sd of [-1, 1]) {
          ctx.fillStyle = '#1b1e22'; lquad(-0.55, sd * 0.3, 0.55, sd * 0.52, 2); ctx.fill();
          ctx.fillStyle = '#2f343a'; lquad(-0.55, sd * 0.3, 0.55, sd * 0.52, 6); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = z;
          for (let t = 0; t < 6; t++) { const a = -0.55 + (t + roll) * 0.183; line(...L(a, sd * 0.3, 6), ...L(a, sd * 0.52, 6)); }
        }
        ctx.fillStyle = '#4b525a'; lquad(-0.45, -0.3, 0.45, 0.3, 7); ctx.fill();
        ctx.fillStyle = '#7d8690'; lquad(-0.45, -0.3, 0.45, 0.3, 11); ctx.fill();
        ctx.strokeStyle = '#2b3036'; ctx.lineWidth = z; ctx.stroke();
        ctx.fillStyle = col; lquad(-0.45, -0.3, -0.33, 0.3, 11.5); ctx.fill();
        const barrel = () => { ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 4 * z; line(...L(0.1, 0, 15), ...L(0.85, 0, 16)); ctx.lineWidth = 5.5 * z; line(...L(0.78, 0, 16), ...L(0.86, 0, 16)); };
        if (away) barrel();
        ctx.fillStyle = '#3b4149'; lell(-0.05, 0, 0.25, 0.22, 12); ctx.fill();
        ctx.fillStyle = shade(col, -0.1); lell(-0.05, 0, 0.23, 0.2, 16); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.2)'; lell(-0.1, -0.05, 0.1, 0.08, 16.5); ctx.fill();
        if (!away) barrel();
        break;
      }
      case 'drone': {
        ctx.strokeStyle = '#2a1810'; ctx.lineWidth = 1.3 * z;
        for (const sd of [-1, 1]) for (const a of [-0.18, 0, 0.18]) {
          const w = moving ? Math.sin(ph * 1.5 + a * 10 + sd) * 0.06 : 0;
          const [kx, ky] = L(a + w, sd * 0.3, 7);
          line(...L(a, sd * 0.12, 5), kx, ky); line(kx, ky, ...L(a + w * 1.5, sd * 0.38, 0));
        }
        ctx.fillStyle = '#3e2a20'; lell(0, 0, 0.32, 0.22, 4); ctx.fill();
        ctx.fillStyle = '#7a5644'; lell(-0.02, 0, 0.3, 0.2, 7); ctx.fill();
        ctx.fillStyle = col; lell(-0.1, 0, 0.14, 0.09, 8.5); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = z; line(...L(0.1, -0.18, 7.5), ...L(0.1, 0.18, 7.5));
        ctx.fillStyle = '#2a1810'; lell(0.3, 0, 0.1, 0.1, 6); ctx.fill();
        ctx.strokeStyle = '#c9a36a'; ctx.lineWidth = 1.5 * z; line(...L(0.36, -0.06, 6), ...L(0.48, -0.02, 5)); line(...L(0.36, 0.06, 6), ...L(0.48, 0.02, 5));
        break;
      }
      case 'biter': {
        ctx.strokeStyle = '#2a1520'; ctx.lineWidth = 1.5 * z;
        for (const sd of [-1, 1]) for (const a of [-0.15, 0.15]) {
          const w = moving ? Math.sin(ph * 2 + a * 20 + sd * 1.5) * 0.1 : 0;
          line(...L(a, sd * 0.08, 5), ...L(a + w, sd * 0.22, 0));
        }
        ctx.fillStyle = '#4b2f3f'; lell(0, 0, 0.3, 0.13, 6); ctx.fill();
        ctx.fillStyle = col; lell(-0.05, 0, 0.18, 0.06, 7.5); ctx.fill();
        for (const a of [-0.15, 0, 0.15]) { const [px, py] = L(a, 0, 8); ctx.fillStyle = '#e3d2b4'; poly([[px - 1.8 * z, py], [px - 3 * z, py - 6 * z], [px + 1.8 * z, py]]); ctx.fill(); }
        ctx.fillStyle = '#5c3a4d'; lell(0.28, 0, 0.1, 0.09, 6); ctx.fill();
        const [tx, ty] = L(0.38, 0, 6); ctx.fillStyle = '#f0e0c8'; circle(tx, ty, 1.5 * z, true);
        break;
      }
      case 'spitter': {
        ctx.fillStyle = '#2e1a28'; lell(-0.15, 0, 0.32, 0.2, 2); ctx.fill();
        ctx.fillStyle = '#5a3b52'; lell(-0.15, 0, 0.3, 0.18, 5); ctx.fill();
        const neck = () => {
          ctx.strokeStyle = '#6a4762'; ctx.lineWidth = 5 * z;
          const [n0x, n0y] = L(0.05, 0, 6), [n1x, n1y] = L(0.1, 0, 16), [hx, hy] = L(0.2, 0, 21);
          ctx.beginPath(); ctx.moveTo(n0x, n0y); ctx.quadraticCurveTo(n1x, n1y, hx, hy); ctx.stroke();
          ctx.fillStyle = '#5a3b52'; ellipse(hx, hy, 5 * z, 4 * z, true);
          ctx.fillStyle = col; circle(hx - 1.5 * z, hy - 1.5 * z, 1.4 * z, true); circle(hx + 1.5 * z, hy - 1.5 * z, 1.4 * z, true);
          const [jx, jy] = L(0.3, 0, 20); ctx.fillStyle = '#2a1520'; ellipse(jx, jy, 2.5 * z, 1.6 * z, true);
        };
        if (away) neck();
        const [sx, sy] = L(-0.22, 0, 11);
        const gr = ctx.createRadialGradient(sx - 2 * z, sy - 2 * z, z, sx, sy, 7 * z);
        gr.addColorStop(0, '#d8ff9a'); gr.addColorStop(0.5, `rgba(123,211,90,${0.8 + 0.15 * Math.sin(now * 4 + u.id)})`); gr.addColorStop(1, '#2f5a22');
        ctx.fillStyle = gr; circle(sx, sy, 6.5 * z, true);
        if (!away) neck();
        break;
      }
      case 'acolyte': {
        const h = 12 + Math.sin(now * 3 + u.id) * 2;
        const [bx, by] = L(0, 0, h);
        ctx.fillStyle = 'rgba(127,211,255,0.35)'; ellipse(bx, by + 8 * z, 4 * z, 2 * z, true);
        ctx.fillStyle = '#e6c878'; poly([[bx, by - 9 * z], [bx - 7 * z, by], [bx, by + 7 * z]]); ctx.fill();
        ctx.fillStyle = '#a88c3e'; poly([[bx, by - 9 * z], [bx + 7 * z, by], [bx, by + 7 * z]]); ctx.fill();
        ctx.fillStyle = col; poly([[bx - 7 * z, by], [bx, by + 2 * z], [bx + 7 * z, by], [bx, by - 2 * z]]); ctx.fill();
        const [ex, ey] = L(0.12, 0, h + 1);
        if (!away) { ctx.fillStyle = '#7fd3ff'; circle(ex, ey, 1.8 * z, true); }
        top = h + 10;
        break;
      }
      case 'warden': {
        const blade = sd => {
          ctx.strokeStyle = 'rgba(127,211,255,0.35)'; ctx.lineWidth = 5 * z; line(...L(0.1, sd * 0.2, 12), ...L(0.55, sd * 0.28, 14));
          ctx.strokeStyle = '#bfeaff'; ctx.lineWidth = 2 * z; line(...L(0.1, sd * 0.2, 12), ...L(0.55, sd * 0.28, 14));
        };
        legs(10, '#8a7436', 3.5);
        if (away) { blade(-1); blade(1); }
        const [bx, by] = L(0, 0, 15);
        ctx.fillStyle = '#e9e1c9'; poly([[bx - 7 * z, by - 6 * z], [bx + 7 * z, by - 6 * z], [bx + 4.5 * z, by + 6 * z], [bx - 4.5 * z, by + 6 * z]]); ctx.fill();
        ctx.fillStyle = '#b8a060'; poly([[bx + 7 * z, by - 6 * z], [bx + 4.5 * z, by + 6 * z], [bx + 1 * z, by + 6 * z], [bx + 3 * z, by - 6 * z]]); ctx.fill();
        ctx.fillStyle = col; poly([[bx - 2 * z, by - 3 * z], [bx + 2 * z, by - 3 * z], [bx + 1.5 * z, by + 7 * z], [bx - 1.5 * z, by + 7 * z]]); ctx.fill();
        const [hx, hy] = L(0, 0, 24);
        ctx.fillStyle = '#d4b366'; circle(hx, hy, 3.8 * z, true);
        ctx.fillStyle = '#e9e1c9'; poly([[hx - 1.2 * z, hy - 3 * z], [hx, hy - 9 * z], [hx + 1.2 * z, hy - 3 * z]]); ctx.fill();
        if (!away) { const [vx, vy] = L(0.1, 0, 24); ctx.fillStyle = '#7fd3ff'; ellipse(vx, vy, 2 * z, 1 * z, true); blade(-1); blade(1); }
        break;
      }
      case 'lancer': {
        const h = 16 + Math.sin(now * 2.5 + u.id) * 1.5;
        ctx.strokeStyle = '#8a7436'; ctx.lineWidth = 2 * z;
        for (const a of [0.9, -0.9, Math.PI]) {
          const w = moving ? Math.sin(ph + a * 2) * 0.05 : 0;
          const [kx, ky] = L(Math.cos(a) * 0.3, Math.sin(a) * 0.3, h + 6);
          line(...L(0, 0, h), kx, ky); line(kx, ky, ...L(Math.cos(a) * 0.45 + w, Math.sin(a) * 0.45, 0));
        }
        const lance = () => {
          ctx.strokeStyle = 'rgba(127,211,255,0.35)'; ctx.lineWidth = 5 * z; line(...L(0, 0, h + 2), ...L(0.8, 0, h + 3));
          ctx.strokeStyle = '#d9c68f'; ctx.lineWidth = 2.5 * z; line(...L(0, 0, h + 2), ...L(0.8, 0, h + 3));
          const [tx, ty] = L(0.84, 0, h + 3); ctx.fillStyle = '#bfeaff'; circle(tx, ty, 2.2 * z, true);
        };
        if (away) lance();
        ctx.fillStyle = '#a88c4a'; lell(0, 0, 0.28, 0.22, h); ctx.fill();
        ctx.fillStyle = '#e9dcb2'; lell(0, 0, 0.24, 0.19, h + 3); ctx.fill();
        ctx.fillStyle = col; lell(-0.02, 0, 0.1, 0.08, h + 4); ctx.fill();
        if (!away) lance();
        top = h + 12;
        break;
      }
    }
    ctx.restore();
    if (u.order.type === 'repair' && !u.path && u.type !== 'engineer') {
      const t = state.ents.get(u.order.target);
      if (t) {
        const [tx, ty] = P(t.x, t.y, t.kind === 'building' ? BH[t.type] * 0.4 : 10), [sx, sy] = L(0.2, 0, 8);
        ctx.strokeStyle = u.type === 'drone' ? `rgba(150,230,120,${0.5 + 0.3 * Math.sin(now * 10)})` : `rgba(140,210,255,${0.5 + 0.3 * Math.sin(now * 10)})`;
        ctx.lineWidth = 1.5 * z; line(sx, sy, tx, ty);
      }
    }
    if (u.carry) {
      const [cx, cy] = L(-0.15, 0.2, top - 4);
      if (u.carry.kind === 'mineral') { ctx.fillStyle = '#63d3ff'; poly([[cx, cy - 4 * z], [cx + 3 * z, cy], [cx, cy + 3 * z], [cx - 3 * z, cy]]); ctx.fill(); }
      else { ctx.fillStyle = '#6ee07a'; circle(cx, cy, 3 * z, true); }
    }
    if (u.maxShield && u.shield > 0 && state.tick - u.lastHit < 4) {
      ctx.strokeStyle = 'rgba(127,211,255,0.8)'; ctx.lineWidth = 2;
      ellipse(gx, gy - top * 0.5 * z, rr * 40 * z, (top * 0.5 + 4) * z, false, true);
    }
  }

  function drawBars(e, alpha) {
    let x, y, w;
    if (e.kind === 'unit') {
      const [sx, sy] = P(lerp(e.px, e.x, alpha), lerp(e.py, e.y, alpha), UH[e.type] + 8);
      w = Math.max(18 * z, UNITS[e.type].radius * 64 * z); x = sx - w / 2; y = sy;
    } else {
      const [sx, sy] = P(e.tx + e.size / 2, e.ty + e.size / 2, BH[e.type] + 10);
      w = e.size * 30 * z; x = sx - w / 2; y = sy;
    }
    const h = Math.max(3, 3.5 * z);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    const hp = Math.max(0, e.hp / e.maxHp);
    ctx.fillStyle = hp > 0.6 ? '#46d160' : hp > 0.3 ? '#e2c23a' : '#e2483a';
    ctx.fillRect(x, y, w * hp, h);
    if (e.maxShield) {
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - 1, y - h - 1, w + 2, h + 1);
      ctx.fillStyle = '#5ab8ff'; ctx.fillRect(x, y - h, w * Math.max(0, e.shield / e.maxShield), h - 1);
    }
    if (e.kind === 'building' && e.owner === r.viewer) {
      const d = BUILDINGS[e.type];
      let prog = null;
      if (!e.done) prog = e.progress / d.time;
      else if (e.queue.length) prog = e.prodProgress / UNITS[e.queue[0]].time;
      if (prog !== null) { ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - 1, y + h + 1, w + 2, h); ctx.fillStyle = '#d8d8d8'; ctx.fillRect(x, y + h + 2, w * prog, h - 2); }
    }
  }

  // --------------------------------------------------------------- effects
  function drawEffect(fx, now) {
    const k = Math.max(0, (now - fx.t0) / fx.dur);
    if (k < 0 || now < fx.t0) return;
    if (fx.type === 'shot') {
      if (!tileVisible(fx.fx, fx.fy) && !tileVisible(fx.tx, fx.ty)) return;
      const src = BUILDINGS[fx.unit] ? BH[fx.unit] * 0.75 : fx.fair ? FLY + 4 : 13;
      const [ax, ay] = P(fx.fx, fx.fy, src), [bx, by] = P(fx.tx, fx.ty, fx.tair ? FLY + 4 : 10);
      if (!fx.ranged) {
        ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2 * z;
        ctx.beginPath(); ctx.arc(bx, by, 7 * z, -1 + k * 2, 0.6 + k * 2); ctx.stroke();
        return;
      }
      if (fx.unit === 'spitter' || fx.unit === 'thorn' || fx.unit === 'stinger') {
        const px = ax + (bx - ax) * k, py = ay + (by - ay) * k - Math.sin(k * Math.PI) * 18 * z;
        ctx.fillStyle = fx.unit === 'thorn' ? '#e3d2b4' : '#8be36a'; circle(px, py, (fx.unit === 'stinger' ? 2.5 : 3.5) * z, true);
        return;
      }
      const colr = fx.unit === 'lancer' || fx.unit === 'seraph' || fx.unit === 'spire' ? '127,211,255' : fx.unit === 'crawler' ? '255,170,60' : '255,230,140';
      ctx.strokeStyle = `rgba(${colr},${1 - k})`; ctx.lineWidth = (fx.unit === 'crawler' || fx.unit === 'spire' ? 3 : fx.unit === 'lancer' || fx.unit === 'seraph' ? 2.5 : 1.5) * z;
      line(ax, ay, bx, by);
      ctx.fillStyle = `rgba(${colr},${1 - k})`; circle(ax + (bx - ax) * 0.08, ay + (by - ay) * 0.08, 3 * z, true);
    } else if (fx.type === 'ripple') {
      if (!tileVisible(fx.x, fx.y)) return;
      const q = state.players[fx.owner], c = q && q.dome ? q.dome : { x: fx.x, y: fx.y };
      const ang = Math.atan2(fx.y - c.y, fx.x - c.x);
      const [x, y] = P(fx.x, fx.y, 14);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2((Math.cos(ang) + Math.sin(ang)) * HH, (Math.cos(ang) - Math.sin(ang)) * HW) + Math.PI / 2);
      ctx.strokeStyle = `rgba(190,235,255,${0.9 * (1 - k)})`; ctx.lineWidth = 2.5 * z;
      ellipse(0, 0, (5 + 22 * k) * z, (3 + 10 * k) * z, false, true);
      ctx.fillStyle = `rgba(130,210,255,${0.35 * (1 - k)})`; ellipse(0, 0, (4 + 14 * k) * z, (2 + 7 * k) * z, true);
      ctx.restore();
    } else if (fx.type === 'domeRise' || fx.type === 'domeFall') {
      const R = COLONY_SHIELD.radius, t = fx.type === 'domeRise' ? k : 1 - k;
      ctx.strokeStyle = `rgba(160,225,255,${0.8 * (1 - k)})`; ctx.lineWidth = 3 * z;
      groundEllipse(fx.x, fx.y, R * (fx.type === 'domeRise' ? 0.2 + 0.8 * k : 1 + 0.3 * k)); ctx.stroke();
      if (fx.type === 'domeFall') for (let i = 0; i < 24; i++) {
        const a = i * TAU / 24, [px, py] = P(fx.x + Math.cos(a) * R, fx.y + Math.sin(a) * R, 10 + 40 * t * Math.abs(Math.sin(a * 3)));
        ctx.fillStyle = `rgba(170,230,255,${0.8 * (1 - k)})`; circle(px, py - k * 20 * z, 2 * z, true);
      }
    } else if (fx.type === 'boom') {
      if (!tileVisible(fx.x, fx.y)) return;
      const [x, y] = P(fx.x, fx.y, 6);
      const rad = fx.size * T * z * 0.5 * (0.4 + k);
      ctx.fillStyle = `rgba(255,${Math.round(200 - 150 * k)},60,${0.7 * (1 - k)})`; circle(x, y, rad, true);
      ctx.strokeStyle = `rgba(255,230,180,${0.6 * (1 - k)})`; ctx.lineWidth = 2 * z; ellipse(x, y + rad * 0.3, rad * 1.3, rad * 0.65, false, true);
      if (fx.big) { ctx.fillStyle = `rgba(60,50,40,${0.5 * (1 - k)})`; circle(x + T * z * 0.3, y - T * z * 0.4 - k * T * z, rad * 0.6, true); }
    }
  }

  // --------------------------------------------------------------- colony shield dome
  function domeSeen(dm) {
    if (r.viewer < 0 || dm.owner === r.viewer) return true;
    for (let k = 0; k < 16; k++) if (tileVisible(Math.max(0, Math.min(N - 1, dm.x + Math.cos(k * TAU / 16) * (dm.r + 0.5))), Math.max(0, Math.min(N - 1, dm.y + Math.sin(k * TAU / 16) * (dm.r + 0.5))))) return true;
    return false;
  }
  function drawDome(dm, now) {
    const [cx, cy] = P(dm.x, dm.y);
    const rx = dm.r * SQ2 * HW * z, ry = dm.r * SQ2 * HH * z, hz = dm.r * 26 * z; // a squashed hemisphere
    const strength = Math.max(0, dm.hp / dm.maxHp), left = (dm.until - state.tick) / 16;
    // flicker when weak or about to fade
    const flick = (strength < 0.25 || left < 15) ? 0.65 + 0.35 * Math.sin(now * (left < 5 ? 30 : 14)) : 1;
    const a = (0.35 + 0.65 * strength) * flick;
    const outline = () => { ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI); ctx.ellipse(cx, cy, rx, ry + hz, 0, Math.PI, TAU); };
    ctx.save();
    // body: clear in the middle, bluer towards the rim (like looking through glass at an angle)
    const gr = ctx.createRadialGradient(cx - rx * 0.25, cy - hz * 0.55, rx * 0.05, cx, cy - hz * 0.3, rx * 1.05);
    gr.addColorStop(0, `rgba(210,240,255,${0.10 * a})`); gr.addColorStop(0.55, `rgba(90,170,255,${0.07 * a})`);
    gr.addColorStop(0.85, `rgba(80,160,255,${0.20 * a})`); gr.addColorStop(1, `rgba(120,200,255,${0.42 * a})`);
    ctx.fillStyle = gr; outline(); ctx.fill();
    ctx.clip();
    // shimmering hex lattice drifting over the surface
    ctx.strokeStyle = `rgba(170,225,255,${0.16 * a})`; ctx.lineWidth = Math.max(0.6, z);
    const cell = 26 * z, hh = cell * 0.866, drift = (now * 8 * z) % (hh * 2);
    for (let row = -1, y = cy - hz - ry - hh * 2 + drift; y < cy + ry + hh; y += hh, row++) {
      for (let x = cx - rx - cell * 2 + (row & 1 ? cell * 0.75 : 0); x < cx + rx + cell; x += cell * 1.5) {
        const tw = 0.5 + 0.5 * Math.sin(now * 2.2 + x * 0.05 + y * 0.07);
        ctx.globalAlpha = 0.4 + 0.6 * tw;
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) { const t = i * TAU / 6; const px = x + Math.cos(t) * cell * 0.5, py = y + Math.sin(t) * hh * 0.5; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // bands of light sweeping up the dome
    for (let i = 0; i < 2; i++) {
      const t = (now * 0.25 + i * 0.5) % 1, yy = cy + ry - t * (hz + ry * 2), w = rx * Math.sqrt(Math.max(0, 1 - Math.pow((cy - yy - hz * 0.2) / (hz + ry), 2)));
      const bg = ctx.createLinearGradient(0, yy - 10 * z, 0, yy + 10 * z);
      bg.addColorStop(0, 'rgba(150,215,255,0)'); bg.addColorStop(0.5, `rgba(170,230,255,${0.14 * a})`); bg.addColorStop(1, 'rgba(150,215,255,0)');
      ctx.fillStyle = bg; ctx.fillRect(cx - w, yy - 10 * z, w * 2, 20 * z);
    }
    ctx.restore();
    // rim: bright edge of the dome, and a glowing ring where it meets the ground
    ctx.strokeStyle = `rgba(160,220,255,${0.55 * a})`; ctx.lineWidth = 2 * z;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry + hz, 0, Math.PI, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(120,200,255,${0.7 * a})`; ctx.lineWidth = 3 * z;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, TAU); ctx.stroke();
    ctx.strokeStyle = `rgba(220,245,255,${0.35 * a})`; ctx.lineWidth = 1.2 * z;
    ctx.beginPath(); ctx.ellipse(cx, cy - 3 * z, rx * 0.985, ry * 0.97, 0, 0, TAU); ctx.stroke();
    // a soft highlight near the top-left, as on glass
    ctx.fillStyle = `rgba(230,248,255,${0.10 * a})`;
    ctx.beginPath(); ctx.ellipse(cx - rx * 0.35, cy - hz * 0.75, rx * 0.25, hz * 0.12, -0.35, 0, TAU); ctx.fill();
  }

  // --------------------------------------------------------------- minimap
  function drawMinimap(now) {
    const dpr = r.dpr, MW = mini.width / dpr, MH = mini.height / dpr, a = MW / (2 * N), bb = MH / (2 * N);
    const toMini = (x, y) => [(x - y) * a + MW / 2, (x + y) * bb];
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.fillStyle = '#000'; mctx.fillRect(0, 0, MW, MH);
    mctx.setTransform(a * dpr, bb * dpr, -a * dpr, bb * dpr, MW / 2 * dpr, 0); // world units from here on
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(miniTerrain, 0, 0);
    const pl = viewerPl();
    for (const e of state.ents.values()) {
      if (e.kind === 'resource') {
        if (!tileExplored(e.x, e.y)) continue;
        mctx.fillStyle = e.type === 'mineral' ? '#63d3ff' : '#4fbf5a';
        mctx.fillRect(e.tx, e.ty, Math.max(1.5, e.w), Math.max(1.5, e.h));
        continue;
      }
      if (e.hidden || !canSee(e)) continue;
      mctx.fillStyle = PLAYER_COLORS[e.owner];
      if (e.kind === 'building') mctx.fillRect(e.tx, e.ty, e.size, e.size);
      else mctx.fillRect(e.x - 1.1, e.y - 1.1, 2.2, 2.2);
    }
    if (pl) {
      for (const g of pl.memory.values()) {
        const live = state.ents.get(g.id);
        if (live && canSee(live)) continue;
        mctx.fillStyle = shade(PLAYER_COLORS[g.owner], -0.4);
        mctx.fillRect(g.tx, g.ty, g.size, g.size);
      }
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(fog, 0, 0);
    }
    for (const q of state.players) if (q.dome && domeSeen(q.dome)) {
      mctx.strokeStyle = '#8fd8ff'; mctx.lineWidth = 1.5 / a; mctx.fillStyle = 'rgba(100,180,255,0.18)';
      mctx.beginPath(); mctx.arc(q.dome.x, q.dome.y, q.dome.r, 0, TAU); mctx.fill(); mctx.stroke();
    }
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // camera view (a rectangle on screen is a rotated rectangle on the map)
    const cs = [[0, 0], [r.W, 0], [r.W, r.H], [0, r.H]].map(([sx, sy]) => { const w = r.screenToWorld(sx, sy); return toMini(w.x, w.y); });
    mctx.strokeStyle = '#ffffff'; mctx.lineWidth = 1;
    mctx.beginPath(); cs.forEach(([x, y], i) => (i ? mctx.lineTo(x, y) : mctx.moveTo(x, y))); mctx.closePath(); mctx.stroke();
    r.pings = r.pings.filter(p => now - p.t0 < 3);
    for (const p of r.pings) {
      const t = ((now - p.t0) % 1), [px, py] = toMini(p.x, p.y);
      mctx.strokeStyle = `rgba(255,70,70,${1 - t})`; mctx.lineWidth = 2;
      mctx.beginPath(); mctx.arc(px, py, 4 + t * 14, 0, TAU); mctx.stroke();
    }
  }

  // --------------------------------------------------------------- picking
  // Works in screen space so that clicking anywhere on a tall sprite selects it.
  r.entityAt = (sx, sy, alpha = 1) => {
    z = r.zoom;
    let best = null, bestD = Infinity;
    for (const e of state.ents.values()) {
      if (e.dead || e.kind !== 'unit' || e.hidden || !canSee(e)) continue;
      const [ux, uy] = P(lerp(e.px, e.x, alpha), lerp(e.py, e.y, alpha));
      const hw = Math.max(8, UNITS[e.type].radius * 40) * z, top = (UH[e.type] + 3) * z;
      if (Math.abs(sx - ux) > hw || sy < uy - top || sy > uy + 6 * z) continue;
      const dd = Math.hypot(sx - ux, sy - (uy - top / 2));
      if (dd < bestD) { bestD = dd; best = e; }
    }
    if (best) return best;
    // buildings and resources: the front-most one whose footprint, raised anywhere up to its height, contains the point
    let front = -Infinity;
    for (const e of state.ents.values()) {
      if (e.dead || e.kind === 'unit') continue;
      if (e.kind === 'building' && !canSee(e)) continue;
      if (e.kind === 'resource' && !tileExplored(e.x, e.y)) continue;
      // a gas building sits on its geyser: pick the building, not the geyser underneath
      if (e.kind === 'resource' && e.building) { const b = state.ents.get(e.building); if (b && canSee(b)) continue; }
      const s = e.size || e.w, h = e.size || e.h;
      const ht = e.kind === 'building' ? BH[e.type] * 0.8 : e.type === 'mineral' ? 20 : 8;
      for (let k = 0; k <= 4; k++) {
        const w = r.screenToWorld(sx, sy + ht * z * k / 4);
        if (w.x >= e.tx && w.x <= e.tx + s && w.y >= e.ty && w.y <= e.ty + h) {
          if (e.x + e.y > front) { front = e.x + e.y; best = e; }
          break;
        }
      }
    }
    return best;
  };

  return r;
}
