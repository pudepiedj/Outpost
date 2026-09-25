// Browser front end: menu, game loop, human input, HUD, bot hosting.

import { createGame, step, issue, observe, publicMap, placementCtx } from './sim.js';
import { TICK_RATE, UNITS, BUILDINGS, FACTIONS, PLAYER_COLORS, PLAYER_NAMES, REPAIR_COST, COLONY_SHIELD, MAP_SIZES, SUPPLY_PER_BASE, VERSION, WEATHER, buildingsOf } from './data.js';
import { checkPlacement } from './rules.js';
import { createRenderer } from './render.js';
import { BOTS } from './bots/index.js';
import { createAssist } from './assist.js';

const $ = id => document.getElementById(id);
const canvas = $('view'), mini = $('mini');
const SPEEDS = [0.5, 1, 1.5, 2, 4, 8];

const G = {
  state: null, R: null, human: -1, bots: [], sel: new Set(), mode: null, groups: {},
  paused: false, speedI: 1, acc: 0, last: 0, running: false,
  mouse: { x: 0, y: 0, inside: false }, drag: null, pan: null, keys: new Set(),
  lastClick: { t: 0, type: null }, lastAlert: null, lastGroupKey: { k: null, t: 0 },
  orderMarker: null, hudT: 0, cardSig: '', infoSig: '', cardButtons: [], over: false,
};

// ======================================================================= menu

const CONTROLLERS = [['human', 'Human'], ['human-assist', 'Human + economy assist'], ...Object.entries(BOTS).flatMap(([id, b]) => Object.entries(b.styles).map(([sid, s]) => [`bot:${id}:${sid}`, `Bot — ${s.label}`])), ['off', 'Empty']];
const FACTION_OPTS = [...Object.entries(FACTIONS).map(([k, f]) => [k, f.name]), ['random', 'Random']];
const defaults = [['human-assist', 'vanguard'], ['bot:standard:balanced', 'swarm'], ['bot:standard:balanced', 'ascendant']];

function loadPrefs() { try { return JSON.parse(localStorage.getItem('outpost.menu')) || null; } catch { return null; } }
function savePrefs(p) { try { localStorage.setItem('outpost.menu', JSON.stringify(p)); } catch { /* private mode */ } }

function buildMenu() {
  const prefs = loadPrefs();
  const box = $('slots'); box.innerHTML = '';
  for (let i = 0; i < 3; i++) {
    const [c, f] = prefs?.slots?.[i] || defaults[i];
    const row = document.createElement('div'); row.className = 'slot';
    row.innerHTML = `<span class="sw" style="background:${PLAYER_COLORS[i]}"></span><span>${PLAYER_NAMES[i]}</span>
      <select class="ctrl">${CONTROLLERS.map(([v, l]) => `<option value="${v}"${v === c ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <select class="fac">${FACTION_OPTS.map(([v, l]) => `<option value="${v}"${v === f ? ' selected' : ''}>${l}</option>`).join('')}</select>`;
    box.appendChild(row);
  }
  $('seed').value = prefs?.seed || 1 + Math.floor(Math.random() * 99999);
  $('mapSize').innerHTML = Object.entries(MAP_SIZES).map(([k, m]) => `<option value="${k}"${k === (prefs?.mapSize || 'medium') ? ' selected' : ''}>${m.name} (${m.size}×${m.size}, ${m.starts} start locations)</option>`).join('');
  $('version').textContent = `Version: ${VERSION}`;
  $('factionInfo').innerHTML = Object.values(FACTIONS).map(f => `<div><b>${f.name}</b>${f.blurb}</div>`).join('');
  for (const el of document.querySelectorAll('.helpBody')) el.innerHTML = HELP.map(([k, v]) => `<kbd>${k}</kbd><span>${v}</span>`).join('');
}

const HELP = [
  ['Left click / drag', 'Select units (drag a box). Shift adds. Double-click selects all of that type on screen.'],
  ['Right click (or Ctrl+click)', 'Move, attack, gather, repair a damaged building with workers, or set a rally point for buildings'],
  ['R, then click', 'Repair a damaged building (workers; Vanguard engineers also fix Crawlers and Hawks)'],
  ['Terrain and weather', 'Mountains and deep rivers block ground units (flyers pass over). Fords cross rivers, but wading is slow. Rain and snow slow everyone; fog and dust storms cut sight. The forecast is next to the clock'],
  ['Colony shield', 'Once every other building type is built, build the shield generator (Z) in your main base. Select it and press D to raise a dome enemies can neither enter nor shoot through, until it fades or is shot down'],
  ['Q then click', 'Gather: send workers to a mineral field or your finished gas building'],
  ['A then click', 'Attack-move (fight anything on the way) or attack a target'],
  ['S / H / M', 'Stop / hold position / move'],
  ['Build keys', 'With a worker selected, press a building key (shown on the buttons), then click to place'],
  ['Train keys', 'With a building selected, press a unit key. X cancels the last item.'],
  ['Ctrl+1…9, 1…9', 'Set / recall control groups (press twice to jump the camera)'],
  ['Arrows, screen edges, two-finger scroll', 'Move the camera. Pinch or [ ] to zoom.'],
  ['Minimap', 'Left click moves the camera, right click orders a move'],
  ['Backspace / Tab', 'Jump to your base / to the latest alert'],
  ['Space, − / =', 'Pause, slower / faster'],
  ['Esc', 'Cancel targeting or placement, or a building queued for funds'],
  ['Short of money?', 'Place a building anyway: it is queued, the worker waits at the site, and it goes up as soon as you can afford it. The money is held for it (the economy assist won\'t spend it)'],
  ['Auto-workers / Auto-supply', 'Top-bar switches (on with "Human + economy assist"): keep training workers until the mineral lines are full (always leaving you 125 minerals), send idle ones near base back to mining, staff new gas buildings, repair damaged buildings near your bases, and build supply before you are blocked'],
];

$('reseed').onclick = () => { $('seed').value = 1 + Math.floor(Math.random() * 999999); };
$('start').onclick = () => {
  const rows = [...document.querySelectorAll('.slot')];
  const slots = rows.map(r => ({ controller: r.querySelector('.ctrl').value, faction: r.querySelector('.fac').value }));
  const err = $('menuErr');
  if (slots.filter(s => s.controller.startsWith('human')).length > 1) { err.textContent = 'Only one human player per game.'; return; }
  if (slots.filter(s => s.controller !== 'off').length < 2) { err.textContent = 'At least two players are needed.'; return; }
  err.textContent = '';
  const seed = Math.max(1, Math.min(999999, parseInt($('seed').value, 10) || 1));
  const mapSize = $('mapSize').value;
  savePrefs({ slots: slots.map(s => [s.controller, s.faction]), seed, mapSize });
  const facs = Object.keys(FACTIONS);
  for (const s of slots) if (s.faction === 'random') s.faction = facs[Math.floor(Math.random() * facs.length)];
  startGame({ seed, slots, mapSize });
};

// ======================================================================= bots

class BotHost {
  constructor(p, faction, botId, style, map) {
    this.p = p; this.pending = false; this.inbox = []; this.inline = null;
    const args = { player: p, faction, map, style };
    const goInline = () => { if (!this.inline) { this.inline = BOTS[botId].create(args); this.pending = false; } };
    try {
      this.worker = new Worker(new URL('./bots/worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'cmds') { this.inbox.push(...m.cmds); this.pending = false; }
        else if (m.type === 'error') { this.pending = false; feed(`${PLAYER_NAMES[p]} bot error: ${m.message.split('\n')[0]}`, 'alert'); console.error(m.message); }
      };
      this.worker.onerror = e => { console.warn('bot worker failed, running inline', e); this.worker = null; goInline(); };
      this.worker.postMessage({ type: 'init', botId, args });
    } catch (err) { goInline(); }
  }
  request(obs) {
    if (this.inline) {
      try { this.inbox.push(...(this.inline.onTick(obs) || [])); } catch (e) { console.error(e); }
      return;
    }
    if (this.pending || !this.worker) return;
    this.pending = true;
    this.worker.postMessage({ type: 'obs', obs }, [obs.visible.buffer, obs.explored.buffer]);
  }
  drain() { const c = this.inbox; this.inbox = []; return c; }
  dispose() { if (this.worker) this.worker.terminate(); }
}

// ======================================================================= game setup

function startGame(cfg) {
  for (const b of G.bots) b?.dispose();
  const slots = cfg.slots.map(s => (s.controller === 'off' ? null : { faction: s.faction }));
  const st = createGame({ seed: cfg.seed, slots, mapSize: cfg.mapSize });
  G.state = st;
  G.human = cfg.slots.findIndex(s => s.controller.startsWith('human'));
  G.assist = null;
  if (G.human >= 0) {
    G.assist = createAssist({ player: G.human, faction: cfg.slots[G.human].faction, map: publicMap(st) });
    G.assist.workers = G.assist.supply = cfg.slots[G.human].controller === 'human-assist';
  }
  syncAssistButtons();
  G.R = createRenderer(canvas, mini, st);
  G.R.viewer = G.human >= 0 ? G.human : -1;
  const map = publicMap(st);
  G.bots = cfg.slots.map((s, p) => {
    if (!s.controller.startsWith('bot:')) return null;
    const [, botId, style] = s.controller.split(':');
    return new BotHost(p, s.faction, botId, style, map);
  });
  G.sel = new Set(); G.mode = null; G.groups = {}; G.paused = false; G.acc = 0; G.over = false;
  G.cardSig = null; G.infoSig = ''; G.lastAlert = null;
  $('menu').classList.add('hidden'); $('gameover').classList.add('hidden');
  $('topbar').classList.remove('hidden'); $('panel').classList.remove('hidden');
  $('banner').classList.add('hidden'); $('feed').innerHTML = '';
  setupViewSelect();
  G.R.resize();
  const me = G.human >= 0 ? st.players[G.human].start : { x: st.N / 2, y: st.N / 2 };
  G.R.centerOn(me.x + 1.5, me.y + 1.5);
  $('btnPause').textContent = 'Pause';
  $('btnSpeed').textContent = SPEEDS[G.speedI] + '×';
  if (G.human >= 0) {
    const f = FACTIONS[st.players[G.human].faction];
    feed(`You are ${PLAYER_NAMES[G.human]} — ${f.name}. Explore to find your enemies.`, 'good');
  } else feed('Spectating. Use the view menu to see the map through one player’s fog.', 'good');
  if (!G.running) { G.running = true; G.last = performance.now(); requestAnimationFrame(frame); }
}

function setupViewSelect() {
  const sel = $('viewSel'), st = G.state;
  const spectator = G.human < 0 || !st.players[G.human].alive || G.over;
  sel.classList.toggle('hidden', !spectator);
  sel.innerHTML = `<option value="-1">Full map</option>` + st.players.filter(p => p.active).map(p => `<option value="${p.id}">${PLAYER_NAMES[p.id]}'s view (${FACTIONS[p.faction].name})</option>`).join('');
  sel.value = String(G.R.viewer);
}
$('viewSel').onchange = e => { G.R.viewer = +e.target.value; G.sel.clear(); };

// ======================================================================= loop

function frame(now) {
  const st = G.state;
  const dt = Math.min(0.25, (now - G.last) / 1000);
  G.last = now;
  if (st && !G.paused && !st.over) {
    G.acc += dt * SPEEDS[G.speedI] * TICK_RATE;
    let n = 0;
    while (G.acc >= 1 && n < 80) { tickOnce(); G.acc -= 1; n++; }
    if (n >= 80) G.acc = 0;
    if (st.over && !G.over) gameOver();
  }
  if (st) {
    scrollCamera(dt);
    for (const id of G.sel) { const e = st.ents.get(id); if (!e || e.dead || (e.kind === 'unit' && e.hidden) || !G.R.canSee(e)) G.sel.delete(id); }
    const ui = buildUiState();
    G.R.draw(G.paused || st.over ? 1 : Math.min(1, G.acc), ui, now / 1000);
    if (now - G.hudT > 100) { G.hudT = now; updateHud(); }
  }
  requestAnimationFrame(frame);
}

function tickOnce() {
  const st = G.state;
  if (st.tick % 4 === 0) {
    for (const b of G.bots) {
      if (!b || !st.players[b.p].alive) continue;
      for (const c of b.drain()) issue(st, b.p, c);
      b.request(observe(st, b.p));
    }
  }
  if (G.pending) tryPending();
  if (G.assist) { G.assist.hold = heldCost(); G.assist.keep = G.pending ? G.pending.wid : 0; }
  if (G.assist && st.tick % 4 === 2 && st.players[G.human].alive && (G.assist.workers || G.assist.supply)) {
    for (const c of G.assist.onTick(observe(st, G.human))) {
      if (issue(st, G.human, c) && c.type === 'build') feed(`Assist: building a ${BUILDINGS[c.btype].name}`, '');
    }
  }
  step(st);
  G.R.addEvents(st.events, performance.now() / 1000);
  for (const ev of st.events) handleEvent(ev);
}

// Money the player has earmarked: a building being placed, or one queued until it can be afforded.
function heldCost() {
  const c = [0, 0];
  if (G.mode?.type === 'build') { const k = BUILDINGS[G.mode.btype].cost; c[0] += k[0]; c[1] += k[1]; }
  if (G.pending) { const k = BUILDINGS[G.pending.btype].cost; c[0] += k[0]; c[1] += k[1]; }
  return c;
}

function tryPending() {
  const st = G.state, p = G.pending, me = st.players[G.human], bd = BUILDINGS[p.btype];
  const w = st.ents.get(p.wid);
  if (!w || w.dead || !me.alive) { G.pending = null; feed(`Queued ${bd.name} cancelled: its worker is gone`, 'warn'); return; }
  if (w.order.type !== 'move' && w.order.type !== 'idle') { G.pending = null; feed(`Queued ${bd.name} cancelled: its worker was given other orders`, 'warn'); return; }
  if (me.minerals < bd.cost[0] || me.gas < bd.cost[1]) return;
  G.pending = null;
  if (!cmd({ type: 'build', units: [w.id], btype: p.btype, tx: p.tx, ty: p.ty })) feed(`Couldn't build the queued ${bd.name}`, 'warn');
}

function handleEvent(ev) {
  const st = G.state, H = G.human;
  if (ev.type === 'msg' && ev.player === H) feed(ev.text, 'warn');
  else if (ev.type === 'attacked' && ev.player === H) { feed(ev.player === H ? 'You are under attack!' : '', 'alert'); G.lastAlert = { x: ev.x, y: ev.y }; }
  else if (ev.type === 'complete' && ev.player === H) feed(`${BUILDINGS[ev.btype].name} complete`, 'good');
  else if (ev.type === 'weather') { const wd = WEATHER[ev.weather]; feed(`Weather: ${wd.name}${weatherEffects(wd)}`, ev.weather === 'clear' ? 'good' : 'warn'); }
  else if (ev.type === 'dome') {
    const mine = ev.player === H, who = `${PLAYER_NAMES[ev.player]}'s`;
    const text = { up: mine ? `Colony shield raised for ${COLONY_SHIELD.duration} s` : `${who} colony shield is up`, fading: mine ? 'Colony shield fading: 15 seconds left' : '', expired: mine ? 'Colony shield has faded' : `${who} colony shield has faded`, broken: mine ? 'Colony shield destroyed!' : `${who} colony shield has been broken`, lost: mine ? 'Colony shield lost with its generator' : '' }[ev.what];
    if (text) feed(text, mine ? (ev.what === 'up' ? 'good' : 'alert') : 'warn');
  }
  else if (ev.type === 'eliminated') {
    feed(`${PLAYER_NAMES[ev.player]} (${FACTIONS[st.players[ev.player].faction].name}) has been eliminated`, ev.player === H ? 'alert' : 'good');
    if (ev.player === H && !st.over) {
      banner('DEFEATED', '#ff6a5a');
      G.R.viewer = -1; G.sel.clear(); G.mode = null; setupViewSelect(); syncAssistButtons();
      feed('You can keep watching the remaining players.', 'warn');
    }
  }
}

function gameOver() {
  G.over = true;
  const st = G.state, H = G.human, w = st.winner;
  let title = w < 0 ? 'Draw' : `${PLAYER_NAMES[w]} (${FACTIONS[st.players[w].faction].name}) wins`;
  if (H >= 0) title = w === H ? 'VICTORY' : 'DEFEAT';
  $('goTitle').textContent = title;
  $('goTitle').style.color = H >= 0 ? (w === H ? '#6dff8a' : '#ff6a5a') : w >= 0 ? PLAYER_COLORS[w] : '';
  const t = st.tick / TICK_RATE;
  const rows = st.players.filter(p => p.active).map(p => `<tr><td><span style="color:${PLAYER_COLORS[p.id]}">■</span> ${PLAYER_NAMES[p.id]}${p.id === H ? ' (you)' : ''} — ${FACTIONS[p.faction].name}</td>
    <td>${p.stats.mined}</td><td>${p.stats.gasMined}</td><td>${p.stats.unitsBuilt}</td><td>${p.stats.kills}</td><td>${p.stats.losses}</td>
    <td>${p.alive ? (p.id === w ? 'Winner' : '—') : fmtTime(p.defeatedAt / TICK_RATE)}</td></tr>`).join('');
  $('goStats').innerHTML = `<tr><th>Player</th><th>Minerals</th><th>Gas</th><th>Units</th><th>Kills</th><th>Losses</th><th>Eliminated</th></tr>${rows}
    <tr><td colspan="7" style="text-align:left;color:var(--dim)">Game length ${fmtTime(t)} · ${MAP_SIZES[st.mapSize].name} map, seed ${st.seed}</td></tr>`;
  $('gameover').classList.remove('hidden');
}
$('goView').onclick = () => { $('gameover').classList.add('hidden'); G.R.viewer = -1; setupViewSelect(); };
$('goMenu').onclick = toMenu;
$('btnMenu').onclick = () => { if (G.over || confirm('Quit this game and return to the menu?')) toMenu(); };
function toMenu() {
  for (const b of G.bots) b?.dispose();
  G.bots = []; G.state = null;
  $('gameover').classList.add('hidden'); $('topbar').classList.add('hidden'); $('panel').classList.add('hidden');
  $('banner').classList.add('hidden');
  const c = canvas.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, canvas.width, canvas.height);
  buildMenu(); $('menu').classList.remove('hidden');
}
$('btnPause').onclick = togglePause;
$('btnAutoW').onclick = () => { if (G.assist) { G.assist.workers = !G.assist.workers; syncAssistButtons(); } };
$('btnAutoS').onclick = () => { if (G.assist) { G.assist.supply = !G.assist.supply; syncAssistButtons(); } };
function syncAssistButtons() {
  const show = !!G.assist && G.state && G.state.players[G.human].alive;
  for (const [id, on] of [['btnAutoW', G.assist?.workers], ['btnAutoS', G.assist?.supply]]) {
    $(id).classList.toggle('hidden', !show);
    $(id).classList.toggle('on', !!on);
  }
}
$('btnSpeed').onclick = () => setSpeed((G.speedI + 1) % SPEEDS.length);
$('btnHelp').onclick = () => $('help').classList.toggle('hidden');
$('helpClose').onclick = () => $('help').classList.add('hidden');
function togglePause() { if (!G.state) return; G.paused = !G.paused; $('btnPause').textContent = G.paused ? 'Resume' : 'Pause'; banner(G.paused ? 'PAUSED' : null); }
function setSpeed(i) { G.speedI = Math.max(0, Math.min(SPEEDS.length - 1, i)); $('btnSpeed').textContent = SPEEDS[G.speedI] + '×'; }

// ======================================================================= feedback

function feed(text, cls = '') {
  if (!text) return;
  const box = $('feed');
  const lastEl = box.lastElementChild;
  if (lastEl && lastEl.textContent === text) { lastEl.style.opacity = 1; clearTimeout(lastEl._t); lastEl._t = setTimeout(() => fade(lastEl), 3500); return; }
  const el = document.createElement('div'); el.textContent = text; el.className = cls;
  box.appendChild(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  el._t = setTimeout(() => fade(el), 3500);
}
function fade(el) { el.style.opacity = 0; setTimeout(() => el.remove(), 700); }
function banner(text, color) {
  const b = $('banner');
  if (!text) { b.classList.add('hidden'); return; }
  b.textContent = text; b.style.color = color || '#fff'; b.classList.remove('hidden');
}
function fmtTime(s) { s = Math.floor(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

// ======================================================================= selection & commands

const own = e => e && G.human >= 0 && e.owner === G.human && G.R.viewer === G.human;
function selected() { return [...G.sel].map(id => G.state.ents.get(id)).filter(Boolean); }
function selUnits() { return selected().filter(e => e.kind === 'unit' && own(e)); }
function selBuildings() { return selected().filter(e => e.kind === 'building' && own(e)); }
function cmd(c) { return issue(G.state, G.human, c); }

function clickSelect(sx, sy, shift) {
  const e = G.R.entityAt(sx, sy, G.acc);
  const now = performance.now();
  const dbl = e && now - G.lastClick.t < 350 && G.lastClick.id === e.id;
  G.lastClick = { t: now, id: e?.id };
  if (!e) { if (!shift) G.sel.clear(); return; }
  if (dbl && e.kind === 'unit') {
    const ids = [];
    for (const u of G.state.ents.values()) {
      if (u.kind !== 'unit' || u.owner !== e.owner || u.type !== e.type || u.hidden) continue;
      const p = G.R.worldToScreen(u.x, u.y);
      if (p.x >= 0 && p.y >= 0 && p.x <= G.R.W && p.y <= G.R.H) ids.push(u.id);
    }
    G.sel = new Set(ids.slice(0, 48));
    return;
  }
  if (shift && own(e) && selected().every(own)) {
    if (G.sel.has(e.id)) G.sel.delete(e.id); else G.sel.add(e.id);
  } else G.sel = new Set([e.id]);
}

function boxSelect(r, shift) {
  const x0 = Math.min(r.x0, r.x1), x1 = Math.max(r.x0, r.x1), y0 = Math.min(r.y0, r.y1), y1 = Math.max(r.y0, r.y1);
  const ids = [];
  const pickOwner = G.R.viewer; // in spectator mode, box-select that player's units
  for (const u of G.state.ents.values()) {
    if (u.kind !== 'unit' || u.hidden) continue;
    if (pickOwner >= 0 ? u.owner !== pickOwner : false) continue;
    const p = G.R.worldToScreen(u.x, u.y);
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 - 4 && p.y <= y1 + 20 * G.R.zoom) ids.push(u.id); // sprites stand above their ground point
  }
  if (!ids.length) return;
  if (shift && selected().every(own)) for (const id of ids) G.sel.add(id);
  else G.sel = new Set(ids.slice(0, 48));
}

function marker(x, y, attack) { G.R && (G.orderMarker = { x, y, attack, t0: performance.now() / 1000 }); }

function smartCommand(sx, sy) {
  const st = G.state;
  const units = selUnits(), blds = selBuildings();
  const w = G.R.screenToWorld(sx, sy);
  const t = G.R.entityAt(sx, sy, G.acc);
  if (units.length) {
    const ids = units.map(u => u.id);
    if (t && t.owner >= 0 && t.owner !== G.human && t.kind !== 'resource') { cmd({ type: 'attack', units: ids, target: t.id }); marker(t.x, t.y, true); return; }
    if (t && t.kind === 'resource' && t.type === 'mineral') { cmd({ type: 'gather', units: ids, target: t.id }); marker(t.x, t.y); return; }
    if (t && t.kind === 'unit' && t.owner === G.human && UNITS[t.type].mech && t.hp < t.maxHp && units.some(u => UNITS[u.type].worker) && FACTIONS[st.players[G.human].faction].buildStyle === 'construct') {
      cmd({ type: 'repair', units: units.filter(u => UNITS[u.type].worker).map(u => u.id), target: t.id }); marker(t.x, t.y); return;
    }
    if (t && t.kind === 'building' && t.owner === G.human) {
      const bd = BUILDINGS[t.type];
      const workers = units.filter(u => UNITS[u.type].worker);
      if (workers.length) {
        if (bd.onGeyser && t.done && t.hp >= t.maxHp) { cmd({ type: 'gather', units: workers.map(u => u.id), target: t.id }); marker(t.x, t.y); return; }
        if (t.done && t.hp < t.maxHp) { cmd({ type: 'repair', units: workers.map(u => u.id), target: t.id }); marker(t.x, t.y); return; }
        if (bd.onGeyser && t.done) { cmd({ type: 'gather', units: workers.map(u => u.id), target: t.id }); marker(t.x, t.y); return; }
        if (!t.done && FACTIONS[st.players[G.human].faction].buildStyle === 'construct') { for (const u of workers) cmd({ type: 'resume', units: [u.id], target: t.id }); marker(t.x, t.y); return; }
        if (bd.onGeyser && !t.done) { feed(`${bd.name} isn't finished yet`, 'warn'); return; }
        if (bd.dropoff && workers.some(u => u.carry)) { cmd({ type: 'returnCargo', units: workers.filter(u => u.carry).map(u => u.id) }); marker(t.x, t.y); return; }
      }
    }
    cmd({ type: 'move', units: ids, x: w.x, y: w.y }); marker(w.x, w.y);
    return;
  }
  if (blds.length) {
    for (const b of blds) cmd({ type: 'rally', building: b.id, x: w.x, y: w.y, target: t && t.kind === 'resource' ? t.id : 0 });
    marker(w.x, w.y);
  }
}

function placementAt(sx, sy, btype) {
  const w = G.R.screenToWorld(sx, sy);
  const bd = BUILDINGS[btype];
  let tx = Math.round(w.x - bd.size / 2), ty = Math.round(w.y - bd.size / 2);
  if (bd.onGeyser) {
    for (const e of G.state.ents.values()) {
      if (e.kind === 'resource' && e.type === 'geyser' && Math.abs(e.x - w.x) < 2 && Math.abs(e.y - w.y) < 2) { tx = e.tx; ty = e.ty; break; }
    }
  }
  const chk = checkPlacement(placementCtx(G.state, G.human), btype, tx, ty);
  return { btype, tx, ty, ok: chk.ok, reason: chk.reason };
}

function applyMode(sx, sy, shift) {
  const m = G.mode;
  const units = selUnits();
  if (m.type === 'build') {
    const pl = placementAt(sx, sy, m.btype);
    const workers = units.filter(u => UNITS[u.type].worker);
    if (!workers.length) { G.mode = null; return; }
    if (!pl.ok) { feed(pl.reason, 'warn'); return; }
    const cx = pl.tx + BUILDINGS[m.btype].size / 2, cy = pl.ty + BUILDINGS[m.btype].size / 2;
    const w = workers.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0];
    const bd = BUILDINGS[m.btype], me = G.state.players[G.human];
    if (me.minerals >= bd.cost[0] && me.gas >= bd.cost[1]) {
      if (cmd({ type: 'build', units: [w.id], btype: m.btype, tx: pl.tx, ty: pl.ty })) { marker(cx, cy); if (!shift) G.mode = null; }
      return;
    }
    // can't afford it yet: queue it. The worker walks to the site now; income is held for it, and it goes up
    // as soon as there's enough.
    if (G.pending) feed(`Replaced the queued ${BUILDINGS[G.pending.btype].name}`, 'warn');
    G.pending = { btype: m.btype, tx: pl.tx, ty: pl.ty, wid: w.id };
    cmd({ type: 'move', units: [w.id], x: cx, y: cy + bd.size / 2 + 0.6 });
    feed(`${bd.name} queued: it will be built when you have ${costStr(bd.cost)}. Esc cancels.`, '');
    marker(cx, cy); G.mode = null;
    return;
  }
  const w = G.R.screenToWorld(sx, sy);
  const t = G.R.entityAt(sx, sy, G.acc);
  const ids = units.map(u => u.id);
  if (m.type === 'gather') {
    const ok = t && ((t.kind === 'resource' && t.type === 'mineral') || (t.kind === 'building' && t.owner === G.human && BUILDINGS[t.type].onGeyser));
    if (!ok) { feed('Click a mineral field, or your own finished gas building', 'warn'); return; }
    if (t.kind === 'building' && !t.done) { feed(`${BUILDINGS[t.type].name} isn't finished yet`, 'warn'); return; }
    cmd({ type: 'gather', units: units.filter(u => UNITS[u.type].worker).map(u => u.id), target: t.id }); marker(t.x, t.y);
    if (!shift) G.mode = null;
    return;
  }
  if (m.type === 'repair') {
    if (!t || t.owner !== G.human || t.kind === 'resource') { feed('Click one of your damaged buildings' + (FACTIONS[G.state.players[G.human].faction].buildStyle === 'construct' ? ' or mechanical units' : ''), 'warn'); return; }
    cmd({ type: 'repair', units: units.filter(u => UNITS[u.type].worker).map(u => u.id), target: t.id }); marker(t.x, t.y);
    if (!shift) G.mode = null;
    return;
  }
  if (m.type === 'attack') {
    if (t && t.kind !== 'resource' && t.owner !== G.human) { cmd({ type: 'attack', units: ids, target: t.id }); marker(t.x, t.y, true); }
    else { cmd({ type: 'attackMove', units: ids, x: w.x, y: w.y }); marker(w.x, w.y, true); }
  } else if (m.type === 'move') { cmd({ type: 'move', units: ids, x: w.x, y: w.y }); marker(w.x, w.y); }
  if (!shift) G.mode = null;
}

function buildUiState() {
  const ui = { selection: G.sel, player: G.human, hoverId: null, dragRect: null, placement: null, orderMarker: G.orderMarker };
  if (G.drag && (Math.abs(G.drag.x1 - G.drag.x0) > 4 || Math.abs(G.drag.y1 - G.drag.y0) > 4)) ui.dragRect = G.drag;
  if (G.mode && G.mode.type === 'build' && G.mouse.inside) ui.placement = placementAt(G.mouse.x, G.mouse.y, G.mode.btype);
  ui.pending = G.pending;
  if (G.mouse.inside && !G.drag) { const e = G.R.entityAt(G.mouse.x, G.mouse.y, G.acc); ui.hoverId = e ? e.id : null; }
  canvas.classList.toggle('targeting', !!G.mode);
  return ui;
}

// ======================================================================= command card

function cardButtons() {
  const st = G.state, H = G.human;
  if (H < 0 || G.R.viewer !== H || !st.players[H].alive) return [];
  const pl = st.players[H];
  const units = selUnits(), blds = selBuildings();
  const out = [];
  const held = G.pending ? BUILDINGS[G.pending.btype].cost : [0, 0];
  const affordable = c => pl.minerals - held[0] >= c[0] && pl.gas - held[1] >= c[1];
  const reqMissing = t => ((UNITS[t] || BUILDINGS[t]).requires || []).filter(r => ![...st.ents.values()].some(e => e.kind === 'building' && e.owner === H && e.type === r && e.done));
  if (units.length) {
    out.push({ key: 'M', glyph: 'MOVE', name: 'Move', tip: 'Move to a point, ignoring enemies', act: () => { G.mode = { type: 'move' }; }, active: G.mode?.type === 'move' });
    out.push({ key: 'S', glyph: 'STOP', name: 'Stop', tip: 'Stop and stand ready', act: () => cmd({ type: 'stop', units: units.map(u => u.id) }) });
    out.push({ key: 'A', glyph: 'ATK', name: 'Attack', tip: 'Click a target, or ground to attack-move', act: () => { G.mode = { type: 'attack' }; }, active: G.mode?.type === 'attack' });
    if (!units.every(u => UNITS[u.type].worker)) out.push({ key: 'H', glyph: 'HOLD', name: 'Hold position', tip: 'Stay put and fire at anything in range', act: () => cmd({ type: 'hold', units: units.map(u => u.id) }) });
    if (units.some(u => UNITS[u.type].worker)) {
      out.push({ key: 'R', glyph: 'REPAIR', name: 'Repair', tip: `Click a damaged building of yours${pl.faction === 'vanguard' ? ' or a Crawler/Hawk' : ''}. Restores it at its build speed for ${Math.round(REPAIR_COST * 100)}% of its cost. Right-click does the same. Several workers repair faster.`, act: () => { G.mode = { type: 'repair' }; }, active: G.mode?.type === 'repair' });
      out.push({ key: 'Q', glyph: 'GATHER', name: 'Gather', tip: 'Click a mineral field, or your finished gas building (refinery/extractor/assimilator). Same as right-click or Ctrl+click on it.', act: () => { G.mode = { type: 'gather' }; }, active: G.mode?.type === 'gather' });
      for (const bt of buildingsOf(pl.faction)) {
        const bd = BUILDINGS[bt], miss = reqMissing(bt);
        out.push({
          key: bd.key, glyph: abbrev(bd.name), name: 'Build ' + bd.name, tag: 'build', cost: bd.cost, missing: miss, dis: miss.length > 0, short: !affordable(bd.cost),
          tip: buildingTip(bt) + (affordable(bd.cost) ? '' : ' Not enough yet: place it anyway and it will be built as soon as you can afford it.'), active: G.mode?.type === 'build' && G.mode.btype === bt,
          act: () => {
            if (miss.length) return feed(`Requires ${miss.map(r => BUILDINGS[r].name).join(', ')}`, 'warn');
            G.mode = { type: 'build', btype: bt };
          },
        });
      }
    }
  } else if (blds.length) {
    const type = blds[0].type;
    const same = blds.filter(b => b.type === type && b.done);
    const bd = BUILDINGS[type];
    if (same.length) for (const ut of bd.produces || []) {
      const ud = UNITS[ut], miss = reqMissing(ut);
      out.push({
        key: ud.key, glyph: abbrev(ud.name), name: 'Train ' + ud.name + (ud.count > 1 ? ` ×${ud.count}` : ''), tag: 'train', cost: ud.cost, missing: miss, dis: miss.length > 0 || !affordable(ud.cost),
        tip: unitTip(ut),
        act: () => {
          if (!affordable(ud.cost)) return feed(G.pending && pl.minerals >= ud.cost[0] && pl.gas >= ud.cost[1] ? `Minerals are held for your queued ${BUILDINGS[G.pending.btype].name}` : pl.minerals < ud.cost[0] ? 'Not enough minerals' : 'Not enough gas', 'warn');
          // queue on the least busy building of this type
          const b = same.slice().sort((a, c) => (a.queue.length + a.eggs.length - a.larva) - (c.queue.length + c.eggs.length - c.larva))[0];
          cmd({ type: 'train', building: b.id, utype: ut });
        },
      });
    }
    const b0 = blds[0];
    if (bd.dome && b0.done) {
      const pl = st.players[H], wait = Math.ceil((b0.rechargeUntil - st.tick) / TICK_RATE);
      const C = COLONY_SHIELD;
      out.push({
        key: 'D', glyph: 'SHIELD', name: 'Raise colony shield', dis: !!pl.dome || wait > 0,
        tip: pl.dome ? 'The shield is already up' : wait > 0 ? `Recharging: ready in ${wait} s` : `A dome over your main base (radius ${C.radius}) for ${C.duration} s. Enemies can't enter it or shoot through it; their fire hits the dome instead (${C.hp} strength). Your own units come and go and fire out freely. Recharges for ${C.recharge} s after it falls.`,
        act: () => cmd({ type: 'shield', building: b0.id }),
      });
    }
    if (!b0.done || b0.queue.length || b0.eggs.length) out.push({ key: 'X', glyph: 'CANCEL', name: b0.done ? 'Cancel last' : 'Cancel construction', tip: b0.done ? 'Cancel the last unit in the queue (full refund)' : 'Cancel this building (75% refund)', act: () => cmd({ type: 'cancel', building: b0.id }), slot: 11 });
  }
  return out;
}

function weatherEffects(wd) {
  const bits = [];
  if (wd.sight) bits.push(`sight ${wd.sight}`);
  if (wd.speed < 1) bits.push(`speed −${Math.round(100 - wd.speed * 100)}%`);
  if (wd.airSpeed < 1) bits.push(`flyers −${Math.round(100 - wd.airSpeed * 100)}%`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

function abbrev(name) {
  const w = name.split(' ');
  return (w.length > 1 ? w.map(s => s[0]).join('') : name.slice(0, 4)).toUpperCase();
}
function costStr(c) { return `${c[0]}${c[1] ? ' / ' + c[1] : ''}`; }
function buildingTip(bt) {
  const b = BUILDINGS[bt];
  const bits = [];
  if (b.supply) bits.push(`+${b.supply} supply`);
  if (b.produces) bits.push('Trains ' + b.produces.map(u => UNITS[u].name).join(', '));
  if (b.dropoff) bits.push('Resource drop-off');
  if (b.creep) bits.push(`Spreads creep (radius ${b.creep})`);
  if (b.power) bits.push(`Powers buildings within ${b.power}`);
  if (b.onGeyser) bits.push('Build on a gas geyser');
  if (b.needsPower) bits.push('Needs pylon power');
  if (b.damage) bits.push(`Defence: shoots ground and air units, damage ${b.damage}, range ${b.range}`);
  if (b.faction === 'swarm' && !b.base && !b.onGeyser) bits.push('Must be placed on creep');
  return bits.join('. ') + `. Build time ${b.time}s.`;
}
function unitTip(ut) {
  const u = UNITS[ut];
  return `${u.air ? 'Flying: crosses cliffs, sees up onto high ground. ' : ''}HP ${u.hp}${u.shield ? ` + ${u.shield} shields` : ''}${u.armor ? `, armour ${u.armor}` : ''}. Damage ${u.damage}${u.splash ? ' (splash)' : ''}, range ${u.range > 1 ? u.range : 'melee'}${u.air || u.antiAir ? ', hits air and ground' : ', ground only'}. Supply ${u.supply * (u.count || 1)}. Train time ${u.time}s.`;
}

function renderCard() {
  const btns = cardButtons();
  const sig = btns.map(b => `${b.key}${b.glyph}${b.dis ? 1 : 0}${b.short ? 1 : 0}${b.active ? 1 : 0}`).join('|');
  G.cardButtons = btns;
  if (sig === G.cardSig) return;
  G.cardSig = sig;
  const card = $('card'); card.innerHTML = '';
  const slots = new Array(12).fill(null);
  let i = 0;
  for (const b of btns) { if (b.slot !== undefined) slots[b.slot] = b; else { while (slots[i]) i++; if (i < 12) slots[i++] = b; } }
  for (const b of slots) {
    if (!b) { const d = document.createElement('div'); d.className = 'empty'; card.appendChild(d); continue; }
    const el = document.createElement('button');
    el.className = (b.dis ? 'dis ' : '') + (b.short ? 'short ' : '') + (b.active ? 'active' : '');
    el.innerHTML = `${b.tag ? `<span class="tag ${b.tag}">${b.tag}</span>` : ''}<span class="key">${b.key}</span><span class="glyph">${b.glyph}</span>${b.cost ? `<span class="cost">${costStr(b.cost)}</span>` : ''}`;
    el.onclick = e => { e.stopPropagation(); b.act(); G.cardSig = null; };
    el.onmouseenter = () => showTip(el, b);
    el.onmouseleave = () => $('tooltip').classList.add('hidden');
    card.appendChild(el);
  }
}
function showTip(el, b) {
  const t = $('tooltip');
  t.innerHTML = `<b>${b.name}</b> <span class="tc">[${b.key}]</span>${b.cost ? `<br><span style="color:var(--min)">${b.cost[0]} minerals</span>${b.cost[1] ? ` · <span style="color:var(--gas)">${b.cost[1]} gas</span>` : ''}` : ''}
    <br><span class="tc">${b.tip || ''}</span>${b.missing?.length ? `<br><span class="req">Requires ${b.missing.map(r => BUILDINGS[r].name).join(', ')}</span>` : ''}`;
  t.classList.remove('hidden');
  const r = el.getBoundingClientRect();
  t.style.left = Math.max(8, Math.min(innerWidth - 290, r.left - 60)) + 'px';
  t.style.top = (r.top - t.offsetHeight - 8) + 'px';
}

// ======================================================================= HUD

function updateHud() {
  const st = G.state;
  const pid = G.R.viewer >= 0 ? G.R.viewer : G.human >= 0 && st.players[G.human].alive ? G.human : -1;
  const pl = pid >= 0 ? st.players[pid] : null;
  $('rMin').textContent = pl ? Math.floor(pl.minerals) : '—';
  $('rGas').textContent = pl ? Math.floor(pl.gas) : '—';
  $('rSup').textContent = pl ? `${fmtSup(pl.supplyUsed)}/${pl.supplyCap}` : '—';
  $('rSup').title = pl ? `Supply used / provided. Ceiling ${pl.supplyMax}: each extra base you hold raises it by ${SUPPLY_PER_BASE}, up to ${MAP_SIZES[st.mapSize].supplyMax} on this map.` : '';
  $('rSup').classList.toggle('blocked', !!pl && pl.supplyUsed >= pl.supplyCap && pl.supplyCap < pl.supplyMax);
  // the ceiling, on maps where territory can raise it
  $('rSupMax').textContent = pl && MAP_SIZES[st.mapSize].supplyMax > 100 ? `max ${pl.supplyMax}` : '';
  $('clock').textContent = fmtTime(st.tick / TICK_RATE);
  const w = st.weather, wd = WEATHER[w.type], left = (w.until - st.tick) / TICK_RATE;
  $('weatherInd').innerHTML = `<b>${wd.name}</b>${weatherEffects(wd)} · ${left < 30 ? `<span style="color:#e8c86a">${WEATHER[w.next].name} in ${fmtTime(left)}</span>` : `then ${WEATHER[w.next].name}`}`;
  const dm = pl && pl.dome;
  $('domeInd').classList.toggle('hidden', !dm);
  if (dm) $('domeInd').textContent = `Shield ${fmtTime((dm.until - st.tick) / TICK_RATE)} · ${Math.ceil(100 * dm.hp / dm.maxHp)}%`;
  renderCard();
  renderInfo();
}
const fmtSup = s => (Number.isInteger(s) ? s : s.toFixed(1));

function renderInfo() {
  const st = G.state, info = $('info');
  const ents = selected();
  if (!ents.length) {
    const html = G.human >= 0 && G.R.viewer === G.human
      ? `<div class="hint">Select units with a left click or drag. Right click to move, gather or attack.<br>Your workers are mining. Build supply and production, then scout — the rest of the map is hidden until your units see it.</div>`
      : `<div class="hint">Spectating. Choose whose fog of war to watch from the menu at top right, or "Full map".</div>`;
    if (G.infoSig !== 'none') { info.innerHTML = html; G.infoSig = 'none'; }
    return;
  }
  if (ents.length > 1) {
    const html = `<div class="multi">${ents.slice(0, 36).map(e => {
      const hp = e.hp / e.maxHp;
      return `<span data-id="${e.id}" style="border-color:${PLAYER_COLORS[e.owner] || ''}55">${abbrev(UNITS[e.type]?.name || BUILDINGS[e.type].name)}<i style="width:${Math.round(hp * 38)}px;background:${hp > 0.6 ? '#46d160' : hp > 0.3 ? '#e2c23a' : '#e2483a'}"></i></span>`;
    }).join('')}</div>`;
    if (html !== G.infoSig) { info.innerHTML = html; G.infoSig = html; }
    return;
  }
  const e = ents[0];
  let html = '';
  if (e.kind === 'resource') {
    const vis = G.R.viewer < 0 || G.R.canSee(e);
    html = `<div class="iTitle">${e.type === 'mineral' ? 'Mineral field' : 'Gas geyser'}</div><div class="iStats"><span>Remaining <b>${vis ? e.amount : '?'}</b></span></div>`;
  } else {
    const d = UNITS[e.type] || BUILDINGS[e.type];
    const ownerName = `<span class="iOwner" style="color:${PLAYER_COLORS[e.owner]}">${PLAYER_NAMES[e.owner]} · ${FACTIONS[d.faction].name}</span>`;
    const stats = [`HP <b>${Math.ceil(e.hp)}/${e.maxHp}</b>`];
    if (e.maxShield) stats.push(`Shields <b>${Math.ceil(e.shield)}/${e.maxShield}</b>`);
    if (e.armor) stats.push(`Armour <b>${e.armor}</b>`);
    if (e.kind === 'unit' || d.damage) { stats.push(`Damage <b>${d.damage}${d.splash ? ' splash' : ''}</b>`); stats.push(`Range <b>${d.range > 1 ? d.range : 'melee'}</b>`); stats.push(`Sight <b>${d.sight}</b>`); }
    html = `<div class="iTitle">${d.name} ${ownerName}</div><div class="iStats">${stats.map(s => `<span>${s}</span>`).join('')}</div>`;
    const mineOrSpectate = e.owner === G.R.viewer || G.R.viewer < 0;
    if (mineOrSpectate) html += `<div class="iStatus">${statusText(e)}</div>`;
    if (mineOrSpectate && e.kind === 'building') {
      if (!e.done) html += `<div class="bar"><i style="width:${(100 * e.progress / d.time).toFixed(1)}%"></i></div>`;
      else if (e.queue.length) html += `<div class="queue">${e.queue.map((t, i) => `<span>${abbrev(UNITS[t].name)}${i === 0 ? `<i style="width:${(100 * e.prodProgress / UNITS[t].time).toFixed(0)}%"></i>` : ''}</span>`).join('')}</div>`;
      else if (e.eggs.length) html += `<div class="queue">${e.eggs.map(eg => `<span>${abbrev(UNITS[eg.type].name)}<i style="width:${(100 * eg.t / UNITS[eg.type].time).toFixed(0)}%"></i></span>`).join('')}</div>`;
    }
  }
  if (html !== G.infoSig) { info.innerHTML = html; G.infoSig = html; }
}

function statusText(e) {
  const st = G.state;
  if (e.kind === 'building') {
    const d = BUILDINGS[e.type];
    if (!e.done) {
      const stalled = FACTIONS[d.faction].buildStyle === 'construct' && e.lastBuilt < st.tick - 2;
      return `Under construction — ${Math.floor(100 * e.progress / d.time)}%${stalled ? ' <span style="color:var(--bad)">(no engineer: right-click it with one)</span>' : ''}`;
    }
    const bits = [];
    if (d.needsPower && !e.powered) bits.push('<span style="color:var(--bad)">Unpowered — build a Pylon nearby</span>');
    if (d.larva) bits.push(`Larvae <b>${e.larva}/3</b>${e.eggs.length ? ` · ${e.eggs.length} egg${e.eggs.length > 1 ? 's' : ''}` : ''}`);
    if (d.supply) bits.push(`Provides ${d.supply} supply`);
    if (e.queue.length) bits.push(`Training ${UNITS[e.queue[0]].name}`);
    if (d.dome) {
      const dm = st.players[e.owner].dome, wait = Math.ceil((e.rechargeUntil - st.tick) / TICK_RATE);
      bits.push(dm ? `<span style="color:#7fd3ff">Shield up: ${fmtTime((dm.until - st.tick) / TICK_RATE)} left, strength ${Math.ceil(dm.hp)}/${dm.maxHp}</span>` : wait > 0 ? `Recharging: ${fmtTime(wait)}` : '<span style="color:#7fd3ff">Shield ready (D)</span>');
    }
    return bits.join(' · ') || 'Ready';
  }
  const o = e.order;
  const carry = e.carry ? ` · carrying ${e.carry.amount} ${e.carry.kind === 'gas' ? 'gas' : 'minerals'}` : '';
  switch (o.type) {
    case 'idle': return (e.target ? 'Engaging' : 'Idle') + carry;
    case 'hold': return 'Holding position';
    case 'move': return 'Moving' + carry;
    case 'attackMove': return e.target ? 'Engaging' : 'Attack-moving';
    case 'attack': return 'Attacking';
    case 'gather': {
      const r = st.ents.get(o.res);
      const what = r && r.kind === 'building' ? 'gas' : 'minerals';
      return ({ toRes: `Heading to ${what}`, waiting: 'Waiting for a free patch', mining: `Harvesting ${what}`, toDrop: 'Returning cargo' })[o.phase] + carry;
    }
    case 'repair': { const t = st.ents.get(o.target); return t ? `Repairing ${(UNITS[t.type] || BUILDINGS[t.type]).name}` : 'Repairing'; }
    case 'build': return o.phase === 'toSite' ? `Going to build ${BUILDINGS[o.btype].name}` : `Constructing ${BUILDINGS[o.btype].name}`;
  }
  return '';
}

$('info').addEventListener('click', e => {
  const s = e.target.closest('[data-id]');
  if (!s) return;
  const id = +s.dataset.id;
  if (e.shiftKey) G.sel.delete(id); else G.sel = new Set([id]);
});

// ======================================================================= input

function localPos(e, el) { const r = el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

canvas.addEventListener('contextmenu', e => e.preventDefault());
mini.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('mousedown', e => {
  if (!G.state) return;
  const p = localPos(e, canvas);
  const right = e.button === 2 || (e.button === 0 && e.ctrlKey); // Ctrl+click is right-click on a Mac
  if (e.button === 0 && !right) {
    if (G.mode) { applyMode(p.x, p.y, e.shiftKey); return; }
    G.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, shift: e.shiftKey };
  } else if (right) {
    if (G.mode) { G.mode = null; return; }
    smartCommand(p.x, p.y);
  } else if (e.button === 1) {
    e.preventDefault();
    G.pan = { x: e.clientX, y: e.clientY, cx: G.R.cam.x, cy: G.R.cam.y };
  }
});
window.addEventListener('mousemove', e => {
  if (!G.state) return;
  const p = localPos(e, canvas);
  G.mouse.x = p.x; G.mouse.y = p.y;
  G.mouse.inside = p.x >= 0 && p.y >= 0 && p.x < canvas.clientWidth && p.y < canvas.clientHeight;
  G.mouse.cx = e.clientX; G.mouse.cy = e.clientY;
  if (G.drag) { G.drag.x1 = p.x; G.drag.y1 = p.y; }
  if (G.pan) { G.R.cam.x = G.pan.cx - (e.clientX - G.pan.x) / G.R.zoom; G.R.cam.y = G.pan.cy - (e.clientY - G.pan.y) / G.R.zoom; G.R.clampCam(); }
});
window.addEventListener('mouseup', e => {
  if (!G.state) return;
  if (e.button === 1) G.pan = null;
  if (e.button !== 0 || !G.drag) return;
  const d = G.drag; G.drag = null;
  if (Math.abs(d.x1 - d.x0) <= 4 && Math.abs(d.y1 - d.y0) <= 4) clickSelect(d.x0, d.y0, d.shift || e.shiftKey);
  else boxSelect(d, d.shift || e.shiftKey);
  G.cardSig = null;
});
document.addEventListener('mouseleave', () => { G.mouse.inside = false; G.mouse.cx = -1; });
window.addEventListener('blur', () => { G.keys.clear(); G.mouse.cx = -1; });

canvas.addEventListener('wheel', e => {
  if (!G.state) return;
  e.preventDefault();
  const p = localPos(e, canvas);
  if (e.ctrlKey) G.R.setZoom(G.R.zoom * Math.exp(-e.deltaY * 0.01), p.x, p.y);
  else { G.R.cam.x += e.deltaX / G.R.zoom; G.R.cam.y += e.deltaY / G.R.zoom; G.R.clampCam(); }
}, { passive: false });

function miniToWorld(e) { const p = localPos(e, mini); return G.R.miniToWorld(p.x, p.y); }
let miniDrag = false;
mini.addEventListener('mousedown', e => {
  if (!G.state) return;
  const w = miniToWorld(e);
  const right = e.button === 2 || (e.button === 0 && e.ctrlKey);
  if (e.button === 0 && !right) {
    if (G.mode && G.mode.type !== 'build') {
      const ids = selUnits().map(u => u.id);
      if (G.mode.type === 'attack') cmd({ type: 'attackMove', units: ids, x: w.x, y: w.y }); else cmd({ type: 'move', units: ids, x: w.x, y: w.y });
      G.mode = null; return;
    }
    miniDrag = true; G.R.centerOn(w.x, w.y);
  } else if (right) {
    const units = selUnits();
    if (units.length) cmd({ type: 'move', units: units.map(u => u.id), x: w.x, y: w.y });
    else for (const b of selBuildings()) cmd({ type: 'rally', building: b.id, x: w.x, y: w.y });
  }
});
window.addEventListener('mousemove', e => { if (miniDrag && G.state) { const w = miniToWorld(e); G.R.centerOn(w.x, w.y); } });
window.addEventListener('mouseup', () => { miniDrag = false; });

function scrollCamera(dt) {
  const R = G.R, sp = 900 * dt / R.zoom;
  let dx = 0, dy = 0;
  if (G.keys.has('ArrowLeft')) dx -= sp; if (G.keys.has('ArrowRight')) dx += sp;
  if (G.keys.has('ArrowUp')) dy -= sp; if (G.keys.has('ArrowDown')) dy += sp;
  const { cx, cy } = G.mouse;
  if (cx >= 0 && document.hasFocus() && !G.drag && !miniDrag && $('menu').classList.contains('hidden') && $('gameover').classList.contains('hidden')) {
    const edge = 6;
    if (cx <= edge) dx -= sp; else if (cx >= innerWidth - edge) dx += sp;
    if (cy <= edge) dy -= sp; else if (cy >= innerHeight - 3) dy += sp;
  }
  if (dx || dy) { R.cam.x += dx; R.cam.y += dy; R.clampCam(); }
}

window.addEventListener('keydown', e => {
  if (!G.state || !$('menu').classList.contains('hidden')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key;
  if (k.startsWith('Arrow')) { G.keys.add(k); e.preventDefault(); return; }
  if (k === ' ') { e.preventDefault(); togglePause(); return; }
  if (k === 'Escape') { if (!G.mode && G.pending) { feed(`Queued ${BUILDINGS[G.pending.btype].name} cancelled`, 'warn'); G.pending = null; } G.mode = null; $('help').classList.add('hidden'); G.cardSig = null; return; }
  if (k === 'F1' || k === '?') { e.preventDefault(); $('help').classList.toggle('hidden'); return; }
  if (k === '-' || k === '_') { setSpeed(G.speedI - 1); return; }
  if (k === '=' || k === '+') { setSpeed(G.speedI + 1); return; }
  if (k === '[') { G.R.setZoom(G.R.zoom / 1.2); return; }
  if (k === ']') { G.R.setZoom(G.R.zoom * 1.2); return; }
  if (k === 'Backspace') {
    e.preventDefault();
    const H = G.human;
    if (H >= 0) { const b = [...G.state.ents.values()].find(x => x.kind === 'building' && x.owner === H && BUILDINGS[x.type].base); const s = b || G.state.players[H].start; G.R.centerOn(s.x + 1.5, s.y + 1.5); }
    return;
  }
  if (k === 'Tab') { e.preventDefault(); if (G.lastAlert) G.R.centerOn(G.lastAlert.x, G.lastAlert.y); return; }
  if (/^[1-9]$/.test(k)) {
    if (e.ctrlKey || e.metaKey) { e.preventDefault(); G.groups[k] = [...G.sel].filter(id => own(G.state.ents.get(id))); feed(`Group ${k} set`, ''); return; }
    const ids = (G.groups[k] || []).filter(id => G.state.ents.get(id));
    G.groups[k] = ids;
    if (!ids.length) return;
    const now = performance.now();
    if (G.lastGroupKey.k === k && now - G.lastGroupKey.t < 400) {
      const es = ids.map(id => G.state.ents.get(id));
      G.R.centerOn(es.reduce((s, x) => s + x.x, 0) / es.length, es.reduce((s, x) => s + x.y, 0) / es.length);
    }
    G.lastGroupKey = { k, t: now };
    if (e.shiftKey) for (const id of ids) G.sel.add(id); else G.sel = new Set(ids);
    G.cardSig = null;
    return;
  }
  if (e.metaKey || e.altKey) return; // Ctrl+letter works like the plain letter (Mac users reach for Ctrl)
  const up = k.toUpperCase();
  const b = cardButtons().find(b => b.key === up);
  if (b) { e.preventDefault(); b.act(); G.cardSig = null; }
});
window.addEventListener('keyup', e => G.keys.delete(e.key));

// Debug handle for the browser console: OUTPOST.state, OUTPOST.R.centerOn(x, y), ...
window.OUTPOST = G;
G.debug = { tickOnce, draw: () => { G.R.draw(1, buildUiState(), performance.now() / 1000); updateHud(); } };

buildMenu();
