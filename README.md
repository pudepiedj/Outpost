# Outpost

A three-faction real-time strategy game in the spirit of StarCraft (1998), for the browser.
Plain JavaScript and 2D canvas, no build step, no dependencies.

The core rule from the original is kept: **you see only what your units and buildings can see.**

- **Black:** unexplored. Nothing is known, not even the terrain.
- **Grey:** explored but not currently in sight. You see terrain and the *last known* state of enemy
  buildings (they may have been destroyed since), but never live units.
- **Clear:** currently visible.
- Low ground cannot see up cliffs. High ground can see down.

Choose the map size in the menu: **Medium** (112×112, 3 start locations), **Large** (176×176, 5) or
**Huge** (240×240, 6). On Large and Huge there are more start locations than players, so you have to scout
to find the enemy. The minimap marks possible start locations you haven't seen yet. Bigger maps also have
more expansions, including a ring of contested bases round the middle.

Every player slot can be **Human**, **Human + economy assist**, **Bot** (Easy, Balanced or Rush) or **Empty**.
Easy bots keep a small economy, never attack before minute 9, send small waves and rest for three minutes after each. Bots receive exactly the same fog-filtered
view a human does. They cannot see the full game state.

## Running it

Double-click `Outpost.command`, or:

```bash
python3 ~/Development/Outpost/serve.py
```

then open <http://127.0.0.1:8642>. A web server is needed because browsers won't load JS modules
or Web Workers from `file://`.

## Economy assist

With **Human + economy assist**, two switches appear in the top bar:

- **Auto-workers:** keeps every base training workers until each mineral line is saturated (two per
  mineral patch plus 3 per gas building). Once you have a dozen workers it only spends minerals above a
  reserve of 125, and it never takes a Swarm Hive's last larva, so the rest of your income is yours. It also sends workers idle for 3 seconds near a base back to mining, puts 3 workers on each
  new gas building once, and sends two or three workers to repair damaged buildings near your bases.
- **Auto-supply:** builds Depots / Brood Pods / Pylons early enough that every production building
  can keep working, and saves up for them before spending on workers.

You can turn either off mid-game. The assist is a partial bot (`src/assist.js`): it acts through the
same fog-filtered view and commands as everyone else. It will spend minerals on workers and supply,
so the army, buildings and fighting are yours. A worker you deliberately park near your base is
sent back to mining after 3 seconds; one parked further out is left alone.

## The factions

| | Vanguard | Swarm | Ascendant |
|---|---|---|---|
| Building | Engineer stays on site until done | Drone morphs into the building (consumed) | Acolyte starts a warp-in and walks away |
| Placement | Anywhere | On creep (spread by Hives and Brood Pods) | In a Pylon power field |
| Production | Queues in buildings | Hives grow larvae (max 3); units hatch in parallel | Queues in Gateways (need power) |
| Special | Crawler: long range, splash | Everything regenerates; Biters come in pairs | Shields regenerate after 7 s out of combat |
| Defence tower | Sentry Turret | Thorn Mound (on creep) | Aegis Spire (needs power) |
| Flyer | Hawk gunship (Factory) | Stinger (Hive, needs Spitter Den) | Seraph (Gateway, needs Core) |

Flyers cross cliffs and see up onto high ground. Only ranged units, towers and other flyers can hit them:
Crawlers, Biters, Wardens and workers can't. Any worker can repair its own buildings (R); Vanguard engineers
can also repair Crawlers and Hawks. Repair runs at build speed and costs 30% of the price for a full repair.

**Terrain and weather.** Mountain ranges and deep rivers block ground units; flyers pass over both.
Ranges have gaps you can walk through, and rivers have shallow fords where units wade across at about half
speed. Weather rolls across the whole map every minute or two (the first three minutes are always clear):
rain (a little slower, sight −1), snow (slower, flyers slightly slower, sight −2), fog (sight −4) and dust
storms (slower, flyers much slower, sight −3). The current weather and the next one are shown next to the
clock. Settings: `WEATHER` and `FORD_SPEED` in `src/data.js`.

**Colony shield.** Once you have built every other building type of your faction, you can build its shield
generator (Bulwark Generator, Carapace Heart or Sanctum Projector; key Z) inside your main base. Only one can
exist at a time. Select it and press **D** to raise a shimmering dome over the main base (not expansions).
Enemies can't enter it or shoot through it. Their fire hits the dome and wears down its strength instead,
and the generator shows through the dome, so they know what to aim for. Your own units come and go and
fire out freely. The dome falls when its strength is gone or its time runs out, and the generator then
recharges before it can be raised again. All the numbers are in `COLONY_SHIELD` in `src/data.js`
(defaults: radius 12, 150 s, 6000 strength, armour 1, 150 s recharge).

Resources: minerals (mined from crystal fields) and gas (needs a refinery/extractor/assimilator on a geyser).
You lose when all of your buildings are destroyed. The last player standing wins.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select (Shift adds, double-click selects that type on screen) |
| Right click (or Ctrl+click) | Move / attack / gather / repair / resume construction / set rally point |
| R, then click | Repair a damaged building (any worker) or, for Vanguard, a Crawler or Hawk |
| Q, then click | Gather from a mineral field or your finished gas building |
| A, then click | Attack-move or attack a target |
| S / H / M | Stop / hold position / move |
| Letter keys | Build (worker selected) or train (building selected); shown on the command card |
| X | Cancel last queued unit or unfinished building |
| Ctrl+1…9 / 1…9 | Set / recall control group (double-tap to jump the camera there) |
| Arrows, screen edges, two-finger scroll | Pan. Pinch or `[` `]` to zoom |
| Backspace / Tab | Jump to your base / to the last alert |
| Space, `-` `=` | Pause, change speed (0.5× to 8×) |

## Writing a bot

A bot is an ES module exporting `createBot`:

```js
export function createBot({ player, faction, map, style }) {
  return {
    onTick(obs) {          // called 4 times per game second
      return [ /* commands */ ];
    },
  };
}
```

Register it in `src/bots/index.js`. It then appears in the menu and can be used in the arena.
In the browser each bot runs in its own Web Worker.

**`map`** (static, public): `size`, `elev` (0 low, 1 ramp, 2 high), `pass` (1 walkable terrain; fords are walkable but slow),
`starts` (all possible start locations), `bases` (every expansion site), `ramps`.

**`obs`** (per tick, fog-filtered):

| field | contents |
|---|---|
| `tick`, `player`, `faction`, `start` | |
| `minerals`, `gas`, `supplyUsed`, `supplyCap` | |
| `mine` | your units and buildings, with orders, cargo, queues, larvae, construction progress |
| `enemies` | enemy units/buildings **currently visible** |
| `remembered` | enemy buildings seen before and not visible now (may be stale) |
| `resources` | mineral fields and geysers on explored tiles (`amount` only if visible) |
| `visible`, `explored` | `Uint8Array(size*size)`, row-major |
| `players` | `{id, active, alive}` for each slot |
| `weather` | `{type, until, next}`: see `WEATHER` in data.js |
| `domes` | raised colony shields you know of: `{owner, x, y, r, hp, maxHp, until}` |

**Commands** (`units` is an array of your unit ids):

```js
{ type: 'move' | 'attackMove', units, x, y }
{ type: 'attack', units, target }          // target must be visible to you
{ type: 'gather', units, target }          // mineral field id, or your finished gas building's id
{ type: 'returnCargo', units }
{ type: 'stop' | 'hold', units }
{ type: 'build', units: [workerId], btype, tx, ty }  // top-left tile; see src/rules.js
{ type: 'resume', units: [workerId], target }        // Vanguard: continue an unfinished building
{ type: 'train', building, utype }
{ type: 'cancel', building }
{ type: 'rally', building, x, y, target? }
{ type: 'repair', units, target }          // own damaged building (or Vanguard mech unit)
{ type: 'shield', building }               // raise the colony shield from your generator
```

Invalid commands are rejected by the simulation, which is the only authority. `src/rules.js`
exports `checkPlacement`, the same placement check the game uses. `src/bots/standard.js`
is a complete reference bot with two styles (Balanced and Rush).

## Headless arena

The simulation runs in Node without the renderer, about 300× real time:

```bash
node tools/arena.mjs --games 10 --seed 1 --p1 vanguard:balanced --p2 swarm:rush --p3 ascendant:balanced
```

Options: `--size medium|large|huge` picks the map, `--minutes N` sets the time limit, `--verbose` prints a per-minute summary, and `--p3 off`
runs a two-player game. Slot spec is `faction:style[:botId]`.

## Layout

```
index.html, style.css     page and HUD
src/data.js               units, buildings, factions: all tunable numbers live here
src/map.js                seeded map generator (plateaus, ramps, expansions, rivers, mountains, obstacles)
src/sim.js                deterministic simulation, fog of war, observe()
src/path.js               A* + path smoothing
src/rules.js              building placement rules
src/render.js             isometric canvas renderer, procedural art, fog overlay, minimap
src/main.js               menu, game loop, input, HUD, bot hosting
src/assist.js             economy assistant for human players
src/bots/                 bot registry, worker wrapper, shared placement, reference bot
tools/arena.mjs           headless bot-vs-bot runner
```

In the browser console, `OUTPOST.state` is the live game state.
