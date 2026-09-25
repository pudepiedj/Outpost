// Canvas renderer: StarCraft-style 3/4 view (square tiles, raised cliffs and buildings with
// front faces), procedural art, two-layer fog of war, effects and the minimap.

import { UNITS, BUILDINGS, PLAYER_COLORS, FACTIONS } from './data.js';
import { LOW, RAMP, HIGH, DECO_ROCK, DECO_WATER } from './map.js';
import { isVisibleTo } from './sim.js';

export const T = 32; // pixels per tile at zoom 1

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

function buildTerrain(map) {
  const N = map.size, c = document.createElement('canvas');
  c.width = c.height = N * T;
  const g = c.getContext('2d');
  const E = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? -1 : map.elev[y * N + x]);
  const D = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? DECO_ROCK : map.deco[y * N + x]);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x, e = map.elev[i], d = map.deco[i], px = x * T, py = y * T;
    const col = tileHSL(e, d, x, y);
    if (d) {
      // ground underneath, then the obstacle with rounded exposed corners
      g.fillStyle = hsl(tileHSL(e, 0, x, y)); g.fillRect(px, py, T, T);
      const same = (dx, dy) => D(x + dx, y + dy) === d;
      const rr = T * 0.45;
      const rad = [
        !same(-1, 0) && !same(0, -1) ? rr : 0, !same(1, 0) && !same(0, -1) ? rr : 0,
        !same(1, 0) && !same(0, 1) ? rr : 0, !same(-1, 0) && !same(0, 1) ? rr : 0,
      ];
      g.fillStyle = hsl(col); g.beginPath(); g.roundRect(px, py, T, T, rad); g.fill();
      g.save(); g.clip(); // keep shore lines and shadows inside the rounded shape
    } else { g.fillStyle = hsl(col); g.fillRect(px, py, T, T); }
    // grain
    for (let k = 0; k < (d ? 0 : 7); k++) {
      const hx = hash(x, y, k + 1), hy = hash(x, y, k + 11), hs = hash(x, y, k + 21);
      g.fillStyle = hs < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,238,200,0.06)';
      const s = 1.5 + hash(x, y, k + 31) * 3;
      g.fillRect(px + hx * (T - s), py + hy * (T - s), s, s * 0.8);
    }
    if (e === RAMP && !d) {
      g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2;
      for (let k = 6; k < T; k += 8) { g.beginPath(); g.moveTo(px, py + k); g.lineTo(px + T, py + k); g.stroke(); }
    }
    if (d === DECO_WATER) {
      g.strokeStyle = 'rgba(160,210,255,0.10)'; g.lineWidth = 1.5;
      const o = hash(x, y, 5) * T;
      g.beginPath(); g.moveTo(px + 3, py + o * 0.8 + 4); g.quadraticCurveTo(px + T / 2, py + o * 0.8, px + T - 3, py + o * 0.8 + 4); g.stroke();
      for (const [dx, dy, ex, ey, ww, hh] of [[0, -1, 0, 0, T, 3], [0, 1, 0, T - 3, T, 3], [-1, 0, 0, 0, 3, T], [1, 0, T - 3, 0, 3, T]]) {
        if (D(x + dx, y + dy) !== DECO_WATER) { g.fillStyle = 'rgba(210,190,140,0.35)'; g.fillRect(px + ex, py + ey, ww, hh); }
      }
    }
    if (d === DECO_ROCK) {
      const k = 3 + Math.floor(hash(x, y, 9) * 3);
      for (let j = 0; j < k; j++) {
        const bx = px + 4 + hash(x, y, j + 40) * (T - 8), by = py + 4 + hash(x, y, j + 50) * (T - 8), br = 5 + hash(x, y, j + 60) * 7;
        g.fillStyle = hsl([25, 8, 20 + hash(x, y, j + 70) * 8]);
        g.beginPath(); g.ellipse(bx, by, br, br * 0.75, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(255,240,220,0.10)';
        g.beginPath(); g.ellipse(bx - br * 0.3, by - br * 0.3, br * 0.45, br * 0.3, 0, 0, Math.PI * 2); g.fill();
      }
      if (D(x, y + 1) !== DECO_ROCK) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(px, py + T - 6, T, 6); }
    }
    if (d) g.restore();
    // doodads on open ground
    if (!d && e !== RAMP && hash(x, y, 77) < 0.035) {
      g.fillStyle = 'rgba(40,30,20,0.55)';
      for (let j = 0; j < 3; j++) { g.beginPath(); g.ellipse(px + 8 + hash(x, y, j + 80) * 16, py + 8 + hash(x, y, j + 90) * 16, 2.5, 2, 0, 0, 7); g.fill(); }
    } else if (!d && e !== RAMP && hash(x, y, 78) < 0.02) {
      g.strokeStyle = 'rgba(120,110,60,0.5)'; g.lineWidth = 1;
      const cx = px + 16, cy = py + 20;
      for (let j = 0; j < 5; j++) { const a = -Math.PI / 2 + (j - 2) * 0.35; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * 7, cy + Math.sin(a) * 7); g.stroke(); }
    }
  }
  // cliffs: high ground edges drawn with a front face and rim
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    if (E(x, y) !== HIGH) continue;
    const px = x * T, py = y * T;
    if (E(x, y + 1) === LOW) {
      const gr = g.createLinearGradient(0, py + T - 14, 0, py + T);
      gr.addColorStop(0, '#4a3a2c'); gr.addColorStop(1, '#241a13');
      g.fillStyle = gr; g.fillRect(px, py + T - 14, T, 14);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let k = 0; k < 4; k++) g.fillRect(px + hash(x, y, k + 100) * T, py + T - 13, 2, 12);
      g.fillStyle = 'rgba(255,230,190,0.22)'; g.fillRect(px, py + T - 15, T, 2);
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(px, py + T, T, 5); // shadow on the low ground
    }
    if (E(x, y - 1) === LOW) { g.fillStyle = 'rgba(255,230,190,0.18)'; g.fillRect(px, py, T, 2); g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillRect(px, py - 4, T, 4); }
    if (E(x - 1, y) === LOW) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(px - 3, py, 3, T); g.fillStyle = 'rgba(255,230,190,0.15)'; g.fillRect(px, py, 2, T); }
    if (E(x + 1, y) === LOW) { g.fillStyle = 'rgba(0,0,0,0.4)'; g.fillRect(px + T - 4, py, 4, T); }
  }
  return c;
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

// ---------------------------------------------------------------- renderer

export function createRenderer(canvas, mini, state) {
  const ctx = canvas.getContext('2d');
  const mctx = mini.getContext('2d');
  const N = state.N;
  const terrain = buildTerrain(state.map);
  const miniTerrain = buildMiniTerrain(state.map);
  const fog = document.createElement('canvas'); fog.width = fog.height = N;
  const fctx = fog.getContext('2d');
  const fogImg = fctx.createImageData(N, N);
  let creepKey = '', creepGrid = new Uint8Array(N * N);

  const r = { cam: { x: 0, y: 0 }, zoom: 1, viewer: 0, effects: [], pings: [], W: 0, H: 0, dpr: 1 };

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
  r.clampCam = () => {
    const vw = r.W / r.zoom, vh = r.H / r.zoom, M = N * T;
    r.cam.x = vw >= M ? (M - vw) / 2 : Math.max(0, Math.min(M - vw, r.cam.x));
    r.cam.y = vh >= M ? (M - vh) / 2 : Math.max(0, Math.min(M - vh + 40, r.cam.y));
  };
  r.centerOn = (x, y) => { r.cam.x = x * T - r.W / r.zoom / 2; r.cam.y = y * T - r.H / r.zoom / 2; r.clampCam(); };
  r.screenToWorld = (sx, sy) => ({ x: (sx / r.zoom + r.cam.x) / T, y: (sy / r.zoom + r.cam.y) / T });
  r.worldToScreen = (x, y) => ({ x: (x * T - r.cam.x) * r.zoom, y: (y * T - r.cam.y) * r.zoom });
  r.setZoom = (z, sx = r.W / 2, sy = r.H / 2) => {
    const w = r.screenToWorld(sx, sy);
    r.zoom = Math.max(0.5, Math.min(2, z));
    r.cam.x = w.x * T - sx / r.zoom; r.cam.y = w.y * T - sy / r.zoom; r.clampCam();
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
      } else if (ev.type === 'attacked' && ev.player === r.viewer) {
        r.pings.push({ x: ev.x, y: ev.y, t0: now });
      }
    }
    if (r.effects.length > 600) r.effects.splice(0, r.effects.length - 600);
  };

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
  }

  // --------------------------------------------------------------- main draw
  r.draw = (alpha, ui, now) => {
    r.resize();
    r.clampCam();
    const dpr = r.dpr, z = r.zoom, W = r.W, H = r.H, S = T * z;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07080a'; ctx.fillRect(0, 0, W, H);

    // terrain
    const sx0 = Math.max(0, r.cam.x), sy0 = Math.max(0, r.cam.y);
    const sx1 = Math.min(N * T, r.cam.x + W / z), sy1 = Math.min(N * T, r.cam.y + H / z);
    ctx.imageSmoothingEnabled = z < 1;
    if (sx1 > sx0 && sy1 > sy0) ctx.drawImage(terrain, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - r.cam.x) * z, (sy0 - r.cam.y) * z, (sx1 - sx0) * z, (sy1 - sy0) * z);
    const tx0 = Math.max(0, Math.floor(r.cam.x / T) - 1), ty0 = Math.max(0, Math.floor(r.cam.y / T) - 1);
    const tx1 = Math.min(N - 1, Math.ceil((r.cam.x + W / z) / T) + 1), ty1 = Math.min(N - 1, Math.ceil((r.cam.y + H / z) / T) + 3);
    const scr = (x, y) => [(x * T - r.cam.x) * z, (y * T - r.cam.y) * z];

    // creep
    updateCreep();
    ctx.fillStyle = 'rgba(96,32,92,0.42)';
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
      if (!creepGrid[y * N + x]) continue;
      const [px, py] = scr(x, y);
      ctx.fillRect(px, py, S + 0.5, S + 0.5);
    }
    ctx.fillStyle = 'rgba(150,70,140,0.25)';
    for (let y = ty0; y <= ty1; y++) for (let x = tx0; x <= tx1; x++) {
      if (!creepGrid[y * N + x] || hash(x, y, 5) > 0.3) continue;
      const [px, py] = scr(x, y);
      ctx.beginPath(); ctx.ellipse(px + S * hash(x, y, 6), py + S * hash(x, y, 7), S * 0.18, S * 0.1, 0, 0, 7); ctx.fill();
    }

    // placement helpers under everything
    if (ui.placement) {
      const bd = BUILDINGS[ui.placement.btype];
      if (bd.needsPower || bd.power) {
        for (const e of state.ents.values()) {
          if (e.kind !== 'building' || e.owner !== ui.player || !BUILDINGS[e.type].power) continue;
          const [px, py] = scr(e.x, e.y);
          ctx.fillStyle = 'rgba(90,170,255,0.13)'; ctx.strokeStyle = 'rgba(120,190,255,0.5)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(px, py, BUILDINGS[e.type].power * S, 0, 7); ctx.fill(); ctx.stroke();
        }
      }
    }

    // entities, painter-sorted by their bottom edge
    const list = [];
    const vx0 = tx0 - 3, vx1 = tx1 + 3, vy0 = ty0 - 3, vy1 = ty1 + 4;
    for (const e of state.ents.values()) {
      if (e.dead || e.x < vx0 || e.x > vx1 || e.y < vy0 || e.y > vy1) continue;
      if (e.kind === 'resource') { if (tileExplored(e.x, e.y)) list.push([e.ty + e.h, e, 0]); continue; }
      if (e.kind === 'unit' && e.hidden) continue;
      if (!canSee(e)) continue;
      list.push([e.kind === 'building' ? e.ty + e.size : lerp(e.py, e.y, alpha), e, 0]);
    }
    const pl = viewerPl();
    if (pl) for (const g of pl.memory.values()) {
      const live = state.ents.get(g.id);
      if (live && canSee(live)) continue;
      if (g.x < vx0 || g.x > vx1 || g.y < vy0 || g.y > vy1) continue;
      list.push([g.ty + g.size, g, 1]);
    }
    list.sort((a, b) => a[0] - b[0]);
    const sel = ui.selection;
    for (const [, e, ghost] of list) {
      if (e.kind === 'resource') drawResource(e, now);
      else if (ghost || e.kind === 'building') drawBuilding(e, now, ghost, sel.has(e.id));
      else drawUnit(e, alpha, now, sel.has(e.id));
    }

    // effects
    r.effects = r.effects.filter(fx => now - fx.t0 < fx.dur);
    for (const fx of r.effects) drawEffect(fx, now);

    // fog of war
    if (pl) {
      const d = fogImg.data, vis = pl.visible, ex = pl.explored;
      for (let i = 0, j = 3; i < N * N; i++, j += 4) d[j] = vis[i] ? 0 : ex[i] ? 150 : 255;
      fctx.putImageData(fogImg, 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(fog, 0, 0, N, N, -r.cam.x * z, -r.cam.y * z, N * S, N * S);
    }

    // overlays above fog
    for (const [, e, ghost] of list) {
      if (ghost || e.kind === 'resource') continue;
      const hovered = ui.hoverId === e.id;
      if (sel.has(e.id) || hovered || (e.hp < e.maxHp && e.kind === 'unit')) drawBars(e, alpha);
    }
    for (const id of sel) {
      const b = state.ents.get(id);
      if (!b || b.kind !== 'building' || !b.rally || b.owner !== ui.player) continue;
      const [ax, ay] = scr(b.x, b.y), [bx, by] = scr(b.rally.x, b.rally.y);
      ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(120,255,140,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#7dff8c'; ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx, by - 14); ctx.lineTo(bx + 9, by - 10); ctx.lineTo(bx, by - 7); ctx.fill();
    }
    if (ui.placement) {
      const { btype, tx, ty, ok } = ui.placement;
      const s = BUILDINGS[btype].size;
      const [px, py] = scr(tx, ty);
      ctx.fillStyle = ok ? 'rgba(60,220,110,0.30)' : 'rgba(240,60,60,0.35)';
      ctx.strokeStyle = ok ? 'rgba(120,255,160,0.9)' : 'rgba(255,110,110,0.9)'; ctx.lineWidth = 2;
      ctx.fillRect(px, py, s * S, s * S); ctx.strokeRect(px + 1, py + 1, s * S - 2, s * S - 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      for (let k = 1; k < s; k++) { ctx.beginPath(); ctx.moveTo(px + k * S, py); ctx.lineTo(px + k * S, py + s * S); ctx.moveTo(px, py + k * S); ctx.lineTo(px + s * S, py + k * S); ctx.stroke(); }
    }
    if (ui.dragRect) {
      const { x0, y0, x1, y1 } = ui.dragRect;
      ctx.strokeStyle = '#6dff8a'; ctx.lineWidth = 1; ctx.fillStyle = 'rgba(80,255,120,0.08)';
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    if (ui.orderMarker && now - ui.orderMarker.t0 < 0.5) {
      const m = ui.orderMarker, k = (now - m.t0) / 0.5;
      const [px, py] = scr(m.x, m.y);
      ctx.strokeStyle = m.attack ? `rgba(255,80,80,${1 - k})` : `rgba(90,255,120,${1 - k})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(px, py, S * 0.5 * (1 - k * 0.6), S * 0.25 * (1 - k * 0.6), 0, 0, 7); ctx.stroke();
    }
    drawMinimap(now);
  };

  const lerp = (a, b, t) => a + (b - a) * t;

  // --------------------------------------------------------------- resources
  function drawResource(e, now) {
    const z = r.zoom, S = T * z;
    const [px, py] = scr0(e.tx, e.ty);
    if (e.type === 'mineral') {
      const k = 0.55 + 0.45 * Math.min(1, e.amount / 1500);
      const shards = [[0.3, 0.72, 0.5], [0.62, 0.7, 0.62], [0.47, 0.55, 0.8], [0.75, 0.82, 0.4], [0.18, 0.86, 0.35]];
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.ellipse(px + S * 0.5, py + S * 0.85, S * 0.48, S * 0.16, 0, 0, 7); ctx.fill();
      for (let i = 0; i < shards.length; i++) {
        const [fx, fy, h] = shards[i];
        const bx = px + fx * S, by = py + fy * S, hh = h * S * k, ww = S * 0.14;
        const tw = Math.sin(now * 2 + e.id + i) * 0.08;
        ctx.fillStyle = i % 2 ? '#3fb8e8' : '#63d3ff';
        ctx.beginPath(); ctx.moveTo(bx - ww, by); ctx.lineTo(bx - ww * 0.4, by - hh); ctx.lineTo(bx + ww * 0.5, by - hh * 0.92); ctx.lineTo(bx + ww, by); ctx.closePath(); ctx.fill();
        ctx.fillStyle = `rgba(220,250,255,${0.35 + tw})`;
        ctx.beginPath(); ctx.moveTo(bx - ww * 0.4, by - hh); ctx.lineTo(bx, by - hh * 0.95); ctx.lineTo(bx - ww * 0.2, by); ctx.lineTo(bx - ww * 0.6, by); ctx.closePath(); ctx.fill();
      }
    } else {
      const cx = px + S, cy = py + S;
      ctx.fillStyle = '#1d231c'; ctx.beginPath(); ctx.ellipse(cx, cy, S * 0.95, S * 0.72, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#2f3a2c'; ctx.beginPath(); ctx.ellipse(cx, cy - S * 0.08, S * 0.8, S * 0.55, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#0c120b'; ctx.beginPath(); ctx.ellipse(cx, cy - S * 0.1, S * 0.36, S * 0.24, 0, 0, 7); ctx.fill();
      if (!e.building && tileVisible(e.x, e.y)) {
        for (let i = 0; i < 3; i++) {
          const t = (now * 0.6 + i / 3) % 1;
          ctx.fillStyle = `rgba(150,230,150,${0.25 * (1 - t)})`;
          ctx.beginPath(); ctx.arc(cx + Math.sin(i * 2 + now) * S * 0.1, cy - S * 0.2 - t * S * 1.2, S * (0.18 + t * 0.3), 0, 7); ctx.fill();
        }
      }
    }
  }
  function scr0(x, y) { return [(x * T - r.cam.x) * r.zoom, (y * T - r.cam.y) * r.zoom]; }

  // --------------------------------------------------------------- buildings
  function drawBuilding(b, now, ghost, selected) {
    const z = r.zoom, S = T * z, d = BUILDINGS[b.type], f = d.faction;
    const col = ghost ? shade(PLAYER_COLORS[b.owner], -0.35) : PLAYER_COLORS[b.owner];
    const [X, Y] = scr0(b.tx, b.ty);
    const W = b.size * S, H = b.size * S;
    const wh = Math.min(W * 0.32, 24 * z);
    const done = b.done;
    const p = done ? 1 : Math.min(1, (b.progress || 0) / d.time);
    ctx.save();
    if (ghost) ctx.globalAlpha = 0.7;
    if (selected) {
      ctx.strokeStyle = b.owner === r.viewer || r.viewer < 0 ? '#6dff8a' : '#ff6060'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(X + W / 2, Y + H * 0.62, W * 0.62, H * 0.45, 0, 0, 7); ctx.stroke();
    }
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(X + W * 0.56, Y + H * 0.8, W * 0.52, H * 0.24, 0, 0, 7); ctx.fill();

    if (!done && !ghost) {
      if (f === 'vanguard') ctx.globalAlpha = 0.35 + 0.65 * p;
      if (f === 'ascendant') ctx.globalAlpha = 0.25 + 0.55 * p;
    }
    const inset = 2 * z;
    const R = { x: X + inset, y: Y - wh * 0.45, w: W - inset * 2, h: H - wh * 0.55 };
    const wallY = Y + H - wh, wallH = wh - inset;

    if (f === 'swarm') drawSwarmBuilding(b, X, Y, W, H, wh, col, now, done, p);
    else {
      const wallCol = f === 'vanguard' ? '#3b4149' : '#8e7438';
      const roofA = f === 'vanguard' ? '#838c96' : '#efe6cc', roofB = f === 'vanguard' ? '#5a626b' : '#c9bb8f';
      // wall
      ctx.fillStyle = wallCol; ctx.fillRect(R.x, wallY, R.w, wallH);
      ctx.fillStyle = col; ctx.fillRect(R.x, wallY + wallH * 0.35, R.w, Math.max(2, 3 * z));
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(R.x, wallY + wallH - 2 * z, R.w, 2 * z);
      // roof
      const gr = ctx.createLinearGradient(0, R.y, 0, R.y + R.h);
      gr.addColorStop(0, roofA); gr.addColorStop(1, roofB);
      ctx.fillStyle = gr; ctx.fillRect(R.x, R.y, R.w, R.h);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h + wallH - 1);
      if (f === 'vanguard') decorateVanguard(b.type, R, wallY, wallH, col, z, now);
      else decorateAscendant(b.type, R, wallY, wallH, col, z, now, done);
    }
    ctx.globalAlpha = ghost ? 0.7 : 1;
    if (!done && !ghost) {
      if (f === 'vanguard') {
        ctx.strokeStyle = 'rgba(230,200,90,0.8)'; ctx.lineWidth = 1;
        for (let k = 0; k <= 4; k++) { const xx = R.x + R.w * k / 4; ctx.beginPath(); ctx.moveTo(xx, R.y); ctx.lineTo(xx, wallY + wallH); ctx.stroke(); }
        for (let k = 0; k <= 3; k++) { const yy = R.y + (wallY + wallH - R.y) * k / 3; ctx.beginPath(); ctx.moveTo(R.x, yy); ctx.lineTo(R.x + R.w, yy); ctx.stroke(); }
      } else if (f === 'ascendant') {
        ctx.fillStyle = `rgba(120,200,255,${0.25 + 0.15 * Math.sin(now * 6)})`;
        ctx.fillRect(R.x, R.y, R.w, wallY + wallH - R.y);
      }
    }
    if (done && d.needsPower && !b.powered && !ghost) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(R.x, R.y, R.w, wallY + wallH - R.y);
      ctx.fillStyle = '#ff5a4f'; ctx.font = `bold ${Math.round(14 * z)}px system-ui`; ctx.textAlign = 'center'; ctx.fillText('⚡', X + W / 2, Y + H / 2);
    }
    ctx.restore();
  }

  function decorateVanguard(type, R, wallY, wallH, col, z, now) {
    const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1;
    for (let k = 1; k < 4; k++) { ctx.beginPath(); ctx.moveTo(R.x + R.w * k / 4, R.y); ctx.lineTo(R.x + R.w * k / 4, R.y + R.h); ctx.stroke(); }
    if (type === 'hub') {
      ctx.fillStyle = '#2d3238'; ctx.beginPath(); ctx.arc(cx, cy, R.h * 0.33, 0, 7); ctx.fill();
      ctx.strokeStyle = '#e8c547'; ctx.lineWidth = 2 * z; ctx.beginPath(); ctx.arc(cx, cy, R.h * 0.27, 0, 7); ctx.stroke();
      ctx.fillStyle = col; ctx.fillRect(cx - 2 * z, cy - R.h * 0.15, 4 * z, R.h * 0.3); ctx.fillRect(cx - R.h * 0.12, cy - 2 * z, R.h * 0.24, 4 * z);
      ctx.fillStyle = (now * 2) % 1 < 0.5 ? '#ff4040' : '#601010'; ctx.beginPath(); ctx.arc(R.x + 5 * z, R.y + 5 * z, 2 * z, 0, 7); ctx.fill();
    } else if (type === 'depot') {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.strokeRect(R.x + R.w * 0.15, R.y + R.h * 0.15, R.w * 0.7, R.h * 0.7);
      ctx.fillStyle = col; ctx.fillRect(R.x + R.w * 0.4, R.y + R.h * 0.4, R.w * 0.2, R.h * 0.2);
    } else if (type === 'barracks') {
      ctx.fillStyle = '#23272c'; ctx.fillRect(cx - R.w * 0.15, wallY + wallH * 0.1, R.w * 0.3, wallH * 0.9);
      ctx.fillStyle = '#3c434b'; ctx.fillRect(R.x + R.w * 0.12, R.y + R.h * 0.2, R.w * 0.22, R.h * 0.25); ctx.fillRect(R.x + R.w * 0.66, R.y + R.h * 0.2, R.w * 0.22, R.h * 0.25);
    } else if (type === 'factory') {
      ctx.fillStyle = '#23272c'; ctx.fillRect(cx - R.w * 0.25, wallY + wallH * 0.1, R.w * 0.5, wallH * 0.9);
      ctx.fillStyle = '#4b525a'; ctx.beginPath(); ctx.ellipse(R.x + R.w * 0.78, R.y + R.h * 0.25, R.w * 0.1, R.w * 0.06, 0, 0, 7); ctx.fill();
      for (let i = 0; i < 2; i++) { const t = (now * 0.5 + i / 2) % 1; ctx.fillStyle = `rgba(200,200,200,${0.3 * (1 - t)})`; ctx.beginPath(); ctx.arc(R.x + R.w * 0.78, R.y + R.h * 0.25 - t * 20 * z, (3 + t * 6) * z, 0, 7); ctx.fill(); }
    } else if (type === 'refinery') {
      ctx.fillStyle = '#5d676f'; ctx.beginPath(); ctx.ellipse(cx, cy, R.w * 0.32, R.h * 0.3, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#6ee07a'; ctx.beginPath(); ctx.ellipse(cx, cy, R.w * 0.12, R.h * 0.1, 0, 0, 7); ctx.fill();
    }
  }

  function decorateAscendant(type, R, wallY, wallH, col, z, now, done) {
    const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
    const glow = `rgba(127,211,255,${0.7 + 0.3 * Math.sin(now * 3)})`;
    ctx.fillStyle = col; ctx.fillRect(R.x, R.y, R.w, 2 * z); ctx.fillRect(R.x, R.y + R.h - 2 * z, R.w, 2 * z);
    const crystal = (x, y, w, h) => {
      ctx.fillStyle = glow; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w, y); ctx.lineTo(x, y + h * 0.6); ctx.lineTo(x - w, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.beginPath(); ctx.moveTo(x, y - h); ctx.lineTo(x + w * 0.4, y - h * 0.2); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
    };
    if (type === 'nexus') {
      for (const [fx, fy] of [[0.1, 0.15], [0.9, 0.15], [0.1, 0.85], [0.9, 0.85]]) { ctx.fillStyle = '#a88c4a'; ctx.beginPath(); ctx.arc(R.x + R.w * fx, R.y + R.h * fy, 3 * z, 0, 7); ctx.fill(); }
      crystal(cx, cy - 6 * z + Math.sin(now * 2) * 2 * z, R.w * 0.14, R.h * 0.45);
    } else if (type === 'pylon') {
      if (done) { ctx.strokeStyle = 'rgba(127,211,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.ellipse(cx, cy + R.h * 0.3, R.w * 0.45, R.h * 0.2, 0, 0, 7); ctx.stroke(); }
      crystal(cx, cy - 8 * z + Math.sin(now * 2.5) * 2 * z, R.w * 0.2, R.h * 0.75);
    } else if (type === 'gateway') {
      ctx.fillStyle = '#2a2418'; ctx.fillRect(cx - R.w * 0.18, wallY - R.h * 0.2, R.w * 0.36, wallH + R.h * 0.2);
      ctx.fillStyle = done ? glow : 'rgba(127,211,255,0.2)'; ctx.fillRect(cx - R.w * 0.12, wallY - R.h * 0.12, R.w * 0.24, wallH + R.h * 0.1);
    } else if (type === 'core') {
      ctx.strokeStyle = glow; ctx.lineWidth = 2 * z; ctx.beginPath(); ctx.ellipse(cx, cy, R.w * 0.3, R.h * 0.3, now, 0, 5); ctx.stroke();
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R.w * 0.1, 0, 7); ctx.fill();
    } else if (type === 'assimilator') {
      ctx.fillStyle = '#a88c4a'; ctx.beginPath(); ctx.ellipse(cx, cy, R.w * 0.34, R.h * 0.32, 0, 0, 7); ctx.fill();
      ctx.fillStyle = '#6ee0b0'; ctx.beginPath(); ctx.ellipse(cx, cy, R.w * 0.14, R.h * 0.12, 0, 0, 7); ctx.fill();
    }
  }

  function drawSwarmBuilding(b, X, Y, W, H, wh, col, now, done, p) {
    const cx = X + W / 2, cy = Y + H * 0.55 - wh * 0.2;
    const pulse = 1 + 0.025 * Math.sin(now * 2 + b.id);
    const k = done ? 1 : 0.45 + 0.55 * p;
    const rx = W * 0.48 * pulse * k, ry = (H * 0.5 + wh * 0.25) * pulse * k;
    const gr = ctx.createRadialGradient(cx - rx * 0.3, cy - ry * 0.4, rx * 0.1, cx, cy, rx * 1.1);
    gr.addColorStop(0, done ? '#a0607a' : '#7a5068'); gr.addColorStop(0.7, '#5a2e44'); gr.addColorStop(1, '#2c1422');
    ctx.fillStyle = gr; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7); ctx.fill();
    // veins in team colour
    ctx.strokeStyle = col; ctx.globalAlpha *= 0.7; ctx.lineWidth = Math.max(1, 1.6 * r.zoom);
    for (let i = 0; i < 5; i++) {
      const a = i * 1.26 + b.id;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * rx * 0.2, cy + Math.sin(a) * ry * 0.2);
      ctx.quadraticCurveTo(cx + Math.cos(a + 0.4) * rx * 0.6, cy + Math.sin(a + 0.4) * ry * 0.6, cx + Math.cos(a) * rx * 0.92, cy + Math.sin(a) * ry * 0.92); ctx.stroke();
    }
    ctx.globalAlpha /= 0.7;
    if (!done) return;
    const z = r.zoom;
    if (b.type === 'hive') {
      for (const [fx, fy] of [[-0.35, 0.3], [0.35, 0.3], [0, -0.2]]) { ctx.fillStyle = '#1a0a12'; ctx.beginPath(); ctx.ellipse(cx + fx * rx, cy + fy * ry, rx * 0.14, ry * 0.1, 0, 0, 7); ctx.fill(); }
      if (b.larva !== undefined && (b.owner === r.viewer || r.viewer < 0)) {
        for (let i = 0; i < b.larva; i++) {
          const lx = X + W * (0.25 + i * 0.25) + Math.sin(now * 3 + i) * 2 * z, ly = Y + H + 2 * z;
          ctx.fillStyle = '#c9a36a'; ctx.beginPath(); ctx.ellipse(lx, ly, 4 * z, 2.5 * z, 0.3, 0, 7); ctx.fill();
        }
      }
    } else if (b.type === 'pod') {
      for (let i = 0; i < 4; i++) { ctx.fillStyle = 'rgba(230,180,200,0.35)'; ctx.beginPath(); ctx.arc(cx + Math.cos(i * 1.7) * rx * 0.5, cy + Math.sin(i * 1.7) * ry * 0.5, rx * 0.12, 0, 7); ctx.fill(); }
    } else if (b.type === 'pit') {
      ctx.fillStyle = '#240d17'; ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.55, ry * 0.45, 0, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(220,60,60,${0.4 + 0.2 * Math.sin(now * 4)})`; ctx.beginPath(); ctx.ellipse(cx, cy, rx * 0.25, ry * 0.2, 0, 0, 7); ctx.fill();
    } else if (b.type === 'den') {
      ctx.fillStyle = '#3a1a2a';
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.5; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * rx * 0.4 - 3 * z, cy + Math.sin(a) * ry * 0.4); ctx.lineTo(cx + Math.cos(a) * rx * 1.05, cy + Math.sin(a) * ry * 1.1); ctx.lineTo(cx + Math.cos(a) * rx * 0.4 + 3 * z, cy + Math.sin(a) * ry * 0.4); ctx.fill(); }
      ctx.fillStyle = '#7bd35a'; ctx.beginPath(); ctx.arc(cx, cy, rx * 0.15, 0, 7); ctx.fill();
    } else if (b.type === 'extractor') {
      ctx.fillStyle = `rgba(120,230,120,${0.5 + 0.2 * Math.sin(now * 3)})`; ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.1, rx * 0.25, ry * 0.2, 0, 0, 7); ctx.fill();
    }
  }

  // --------------------------------------------------------------- units
  function drawUnit(u, alpha, now, selected) {
    const z = r.zoom, S = T * z;
    const wx = lerp(u.px, u.x, alpha), wy = lerp(u.py, u.y, alpha);
    const [x, y] = scr0(wx, wy);
    const d = UNITS[u.type], rad = d.radius * S, col = PLAYER_COLORS[u.owner];
    const f = u.facing || 0;
    if (selected) {
      ctx.strokeStyle = u.owner === r.viewer || r.viewer < 0 ? '#6dff8a' : '#ff6060'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(x, y + rad * 0.3, rad * 1.35, rad * 0.75, 0, 0, 7); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(x, y + rad * 0.35, rad * 1.05, rad * 0.5, 0, 0, 7); ctx.fill();
    let by = y - rad * 0.45;
    ctx.save();
    ctx.lineWidth = Math.max(1, z);
    switch (u.type) {
      case 'engineer': {
        ctx.fillStyle = '#9aa3ad'; ctx.strokeStyle = '#2b3036';
        circle(x, by, rad * 0.85, true, true);
        ctx.fillStyle = col; circle(x, by - rad * 0.1, rad * 0.45, true);
        ctx.strokeStyle = '#d6b35a'; ctx.lineWidth = 2 * z; line(x, by, x + Math.cos(f) * rad * 1.2, by + Math.sin(f) * rad * 1.2);
        if (u.order.type === 'build' && u.order.phase === 'constructing' && Math.random() < 0.5) { ctx.fillStyle = '#ffe07a'; circle(x + Math.cos(f) * rad * 1.3 + (Math.random() - 0.5) * 6 * z, by + Math.sin(f) * rad * 1.3, 1.5 * z, true); }
        break;
      }
      case 'trooper': {
        ctx.fillStyle = col; ctx.strokeStyle = '#15181c';
        circle(x, by, rad * 0.9, true, true);
        ctx.fillStyle = '#cfd6dc'; circle(x + Math.cos(f) * rad * 0.15, by + Math.sin(f) * rad * 0.15 - rad * 0.1, rad * 0.42, true);
        ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 2.5 * z; line(x, by, x + Math.cos(f) * rad * 1.5, by + Math.sin(f) * rad * 1.5);
        break;
      }
      case 'crawler': {
        ctx.translate(x, by); ctx.rotate(f);
        ctx.fillStyle = '#2b2f34'; ctx.fillRect(-rad, -rad * 0.8, rad * 2, rad * 0.35); ctx.fillRect(-rad, rad * 0.45, rad * 2, rad * 0.35);
        ctx.fillStyle = '#7d8690'; ctx.fillRect(-rad * 0.85, -rad * 0.5, rad * 1.7, rad);
        ctx.strokeStyle = '#2b3036'; ctx.strokeRect(-rad * 0.85, -rad * 0.5, rad * 1.7, rad);
        ctx.fillStyle = col; circle(-rad * 0.05, 0, rad * 0.42, true);
        ctx.strokeStyle = '#1b1e22'; ctx.lineWidth = 4 * z; line(0, 0, rad * 1.45, 0);
        break;
      }
      case 'drone': {
        ctx.translate(x, by); ctx.rotate(f);
        ctx.fillStyle = '#6b4a3a'; ctx.strokeStyle = '#2a1810'; ellipse(0, 0, rad, rad * 0.72, true, true);
        ctx.fillStyle = col; ellipse(-rad * 0.15, 0, rad * 0.45, rad * 0.25, true);
        ctx.strokeStyle = '#c9a36a'; ctx.lineWidth = 1.5 * z; line(rad * 0.8, -rad * 0.3, rad * 1.25, -rad * 0.1); line(rad * 0.8, rad * 0.3, rad * 1.25, rad * 0.1);
        break;
      }
      case 'biter': {
        ctx.translate(x, by); ctx.rotate(f);
        ctx.strokeStyle = '#2a1520'; ctx.lineWidth = 1.2 * z;
        const w = Math.sin(now * 18 + u.id) * rad * 0.2 * (u.path ? 1 : 0);
        for (const s of [-1, 1]) for (const k of [-0.5, 0, 0.5]) line(rad * k, 0, rad * k + (k ? w * s : -w * s), s * rad * 0.95);
        ctx.fillStyle = '#4b2f3f'; ellipse(0, 0, rad * 1.1, rad * 0.55, true);
        ctx.fillStyle = col; ellipse(-rad * 0.2, 0, rad * 0.55, rad * 0.2, true);
        ctx.fillStyle = '#e8d0b0'; circle(rad * 0.95, -rad * 0.15, rad * 0.12, true); circle(rad * 0.95, rad * 0.15, rad * 0.12, true);
        break;
      }
      case 'spitter': {
        ctx.translate(x, by); ctx.rotate(f);
        ctx.fillStyle = '#5a3b52'; ctx.strokeStyle = '#22121c'; ellipse(0, 0, rad, rad * 0.8, true, true);
        ctx.fillStyle = `rgba(123,211,90,${0.7 + 0.2 * Math.sin(now * 4 + u.id)})`; ellipse(-rad * 0.35, 0, rad * 0.45, rad * 0.45, true);
        ctx.fillStyle = col; circle(rad * 0.35, -rad * 0.35, rad * 0.14, true); circle(rad * 0.35, rad * 0.35, rad * 0.14, true);
        ctx.fillStyle = '#2a1520'; ellipse(rad * 0.85, 0, rad * 0.25, rad * 0.18, true);
        break;
      }
      case 'acolyte': {
        by -= (1.5 + Math.sin(now * 3 + u.id)) * z;
        ctx.fillStyle = '#d4b366'; ctx.strokeStyle = '#5e4a1c';
        ctx.beginPath(); ctx.moveTo(x, by - rad); ctx.lineTo(x + rad * 0.85, by); ctx.lineTo(x, by + rad * 0.8); ctx.lineTo(x - rad * 0.85, by); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = col; circle(x, by, rad * 0.3, true);
        break;
      }
      case 'warden': {
        ctx.fillStyle = '#e9e1c9'; ctx.strokeStyle = '#6e5a2a';
        circle(x, by, rad * 0.9, true, true);
        ctx.fillStyle = '#d4b366'; circle(x, by - rad * 0.15, rad * 0.55, true);
        ctx.fillStyle = col; circle(x, by - rad * 0.15, rad * 0.25, true);
        ctx.strokeStyle = '#7fd3ff'; ctx.lineWidth = 2.5 * z;
        for (const s of [-1, 1]) { const a = f + s * 0.6; line(x + Math.cos(a) * rad * 0.6, by + Math.sin(a) * rad * 0.6, x + Math.cos(f + s * 0.25) * rad * 1.45, by + Math.sin(f + s * 0.25) * rad * 1.45); }
        break;
      }
      case 'lancer': {
        ctx.translate(x, by); ctx.rotate(f);
        ctx.strokeStyle = '#6e5a2a';
        for (const a of [2.2, -2.2, Math.PI]) line(0, 0, Math.cos(a) * rad, Math.sin(a) * rad);
        ctx.fillStyle = '#d4b366'; ctx.beginPath(); ctx.moveTo(rad * 0.8, 0); ctx.lineTo(-rad * 0.6, -rad * 0.65); ctx.lineTo(-rad * 0.6, rad * 0.65); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.fillStyle = col; circle(-rad * 0.1, 0, rad * 0.28, true);
        ctx.strokeStyle = '#7fd3ff'; ctx.lineWidth = 2 * z; line(rad * 0.3, 0, rad * 1.7, 0);
        break;
      }
    }
    ctx.restore();
    if (u.carry) {
      const cx = x + rad * 0.7, cy = by - rad * 0.9;
      if (u.carry.kind === 'mineral') { ctx.fillStyle = '#63d3ff'; ctx.beginPath(); ctx.moveTo(cx, cy - 4 * z); ctx.lineTo(cx + 3 * z, cy); ctx.lineTo(cx, cy + 3 * z); ctx.lineTo(cx - 3 * z, cy); ctx.fill(); }
      else { ctx.fillStyle = '#6ee07a'; circle(cx, cy, 3 * z, true); }
    }
    // shield flash
    if (u.maxShield && u.shield > 0 && state.tick - u.lastHit < 4) {
      ctx.strokeStyle = 'rgba(127,211,255,0.8)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, by, rad * 1.3, 0, 7); ctx.stroke();
    }
  }
  function circle(x, y, rr, fill, stroke) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, rr), 0, Math.PI * 2); if (fill) ctx.fill(); if (stroke) ctx.stroke(); }
  function ellipse(x, y, rx, ry, fill, stroke) { ctx.beginPath(); ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); if (fill) ctx.fill(); if (stroke) ctx.stroke(); }
  function line(x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }

  function drawBars(e, alpha) {
    const z = r.zoom, S = T * z;
    let x, y, w;
    if (e.kind === 'unit') {
      const [sx, sy] = scr0(lerp(e.px, e.x, alpha), lerp(e.py, e.y, alpha));
      w = Math.max(18 * z, UNITS[e.type].radius * S * 2.2); x = sx - w / 2; y = sy - UNITS[e.type].radius * S * 1.7 - 6 * z;
    } else {
      const [sx, sy] = scr0(e.tx, e.ty);
      w = e.size * S * 0.8; x = sx + e.size * S * 0.1; y = sy - Math.min(e.size * S * 0.32, 24 * z) * 0.45 - 8 * z;
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
    const z = r.zoom, S = T * z;
    if (fx.type === 'shot') {
      if (!tileVisible(fx.fx, fx.fy) && !tileVisible(fx.tx, fx.ty)) return;
      const [ax, ay] = scr0(fx.fx, fx.fy), [bx, by] = scr0(fx.tx, fx.ty);
      const lift = 6 * z;
      if (!fx.ranged) {
        ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2 * z;
        ctx.beginPath(); ctx.arc(bx, by - lift, 7 * z, -1 + k * 2, 0.6 + k * 2); ctx.stroke();
        return;
      }
      if (fx.unit === 'spitter') {
        const px = ax + (bx - ax) * k, py = ay + (by - ay) * k - Math.sin(k * Math.PI) * 18 * z - lift;
        ctx.fillStyle = '#8be36a'; circle(px, py, 3.5 * z, true);
        return;
      }
      const colr = fx.unit === 'lancer' ? '127,211,255' : fx.unit === 'crawler' ? '255,170,60' : '255,230,140';
      ctx.strokeStyle = `rgba(${colr},${1 - k})`; ctx.lineWidth = (fx.unit === 'crawler' ? 3 : fx.unit === 'lancer' ? 2.5 : 1.5) * z;
      ctx.beginPath(); ctx.moveTo(ax, ay - lift); ctx.lineTo(bx, by - lift); ctx.stroke();
      ctx.fillStyle = `rgba(${colr},${1 - k})`; circle(ax + (bx - ax) * 0.08, ay - lift + (by - ay) * 0.08, 3 * z, true);
    } else if (fx.type === 'boom') {
      if (!tileVisible(fx.x, fx.y)) return;
      const [x, y] = scr0(fx.x, fx.y);
      const rad = fx.size * S * 0.5 * (0.4 + k);
      ctx.fillStyle = `rgba(255,${Math.round(200 - 150 * k)},60,${0.7 * (1 - k)})`; circle(x, y - 4 * z, rad, true);
      ctx.strokeStyle = `rgba(255,230,180,${0.6 * (1 - k)})`; ctx.lineWidth = 2 * z; circle(x, y - 4 * z, rad * 1.2, false, true);
      if (fx.big) { ctx.fillStyle = `rgba(60,50,40,${0.5 * (1 - k)})`; circle(x + S * 0.3, y - S * 0.4 - k * S, rad * 0.6, true); }
    }
  }

  // --------------------------------------------------------------- minimap
  function drawMinimap(now) {
    const dpr = r.dpr, MW = mini.width / dpr, MH = mini.height / dpr, k = MW / N;
    mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    mctx.imageSmoothingEnabled = false;
    mctx.drawImage(miniTerrain, 0, 0, MW, MH);
    const pl = viewerPl();
    for (const e of state.ents.values()) {
      if (e.kind === 'resource') {
        if (!tileExplored(e.x, e.y)) continue;
        mctx.fillStyle = e.type === 'mineral' ? '#63d3ff' : '#4fbf5a';
        mctx.fillRect(e.tx * k, e.ty * k, Math.max(1.5, e.w * k), Math.max(1.5, e.h * k));
        continue;
      }
      if (e.hidden || !canSee(e)) continue;
      mctx.fillStyle = PLAYER_COLORS[e.owner];
      if (e.kind === 'building') mctx.fillRect(e.tx * k, e.ty * k, e.size * k, e.size * k);
      else mctx.fillRect(e.x * k - 1.5, e.y * k - 1.5, 3, 3);
    }
    if (pl) {
      for (const g of pl.memory.values()) {
        const live = state.ents.get(g.id);
        if (live && canSee(live)) continue;
        mctx.fillStyle = shade(PLAYER_COLORS[g.owner], -0.4);
        mctx.fillRect(g.tx * k, g.ty * k, g.size * k, g.size * k);
      }
      mctx.imageSmoothingEnabled = true;
      mctx.drawImage(fog, 0, 0, MW, MH);
    }
    // camera box
    const c0 = r.screenToWorld(0, 0), c1 = r.screenToWorld(r.W, r.H);
    mctx.strokeStyle = '#ffffff'; mctx.lineWidth = 1;
    mctx.strokeRect(c0.x * k + 0.5, c0.y * k + 0.5, (c1.x - c0.x) * k, (c1.y - c0.y) * k);
    r.pings = r.pings.filter(p => now - p.t0 < 3);
    for (const p of r.pings) {
      const t = ((now - p.t0) % 1);
      mctx.strokeStyle = `rgba(255,70,70,${1 - t})`; mctx.lineWidth = 2;
      mctx.beginPath(); mctx.arc(p.x * k, p.y * k, 4 + t * 14, 0, 7); mctx.stroke();
    }
  }

  // --------------------------------------------------------------- picking
  r.entityAt = (sx, sy, alpha = 1) => {
    const w = r.screenToWorld(sx, sy);
    let best = null, bestD = Infinity;
    for (const e of state.ents.values()) {
      if (e.dead || e.kind !== 'unit' || e.hidden || !canSee(e)) continue;
      const ux = lerp(e.px, e.x, alpha), uy = lerp(e.py, e.y, alpha) - UNITS[e.type].radius * 0.45;
      const d = Math.hypot(ux - w.x, uy - w.y);
      if (d < UNITS[e.type].radius + 0.3 && d < bestD) { bestD = d; best = e; }
    }
    if (best) return best;
    for (const e of state.ents.values()) {
      if (e.dead || e.kind === 'unit') continue;
      if (e.kind === 'building' && !canSee(e)) continue;
      if (e.kind === 'resource' && !tileExplored(e.x, e.y)) continue;
      // a gas building sits on its geyser: pick the building, not the geyser underneath
      if (e.kind === 'resource' && e.building) { const b = state.ents.get(e.building); if (b && canSee(b)) continue; }
      const s = e.size || e.w, h = e.size || e.h;
      const lift = e.kind === 'building' ? Math.min(s * 0.32, 0.75) * 0.45 : 0.4;
      if (w.x >= e.tx && w.x <= e.tx + s && w.y >= e.ty - lift && w.y <= e.ty + h) return e;
    }
    return null;
  };

  return r;
}
