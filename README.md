# Outpost

A three-faction real-time strategy game in the spirit of StarCraft (1998), for the browser.
Plain JavaScript and 2D canvas, no build step, no dependencies.

The core rule from the original is kept: **you see only what your units and buildings can see.**

- **Black:** unexplored. Nothing is known, not even the terrain.
- **Grey:** explored but not currently in sight. You see terrain and the *last known* state of enemy
  buildings (they may have been destroyed since), but never live units.
- **Clear:** currently visible.
- Low ground cannot see up cliffs. High ground can see down.

Every player slot can be **Human**, **Human + economy assist**, **Bot** or **Empty**. Bots receive exactly the same fog-filtered
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

- **Auto-workers:** keeps every base training workers (up to about 18 per base plus 3 per gas
  building), sends workers idle for 3 seconds near a base back to mining, and puts 3 workers on each
  new gas building once.
- **Auto-supply:** builds a Depot / Brood Pod / Pylon before you run out of supply.

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

Resources: minerals (mined from crystal fields) and gas (needs a refinery/extractor/assimilator on a geyser).
You lose when all of your buildings are destroyed. The last player standing wins.

## Controls

| Input | Action |
|---|---|
| Left click / drag | Select (Shift adds, double-click selects that type on screen) |
| Right click (or Ctrl+click) | Move / attack / gather / resume construction / set rally point |
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

**`map`** (static, public): `size`, `elev` (0 low, 1 ramp, 2 high), `pass` (1 walkable terrain),
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
```

Invalid commands are rejected by the simulation, which is the only authority. `src/rules.js`
exports `checkPlacement`, the same placement check the game uses. `src/bots/standard.js`
is a complete reference bot with two styles (Balanced and Rush).

## Headless arena

The simulation runs in Node without the renderer, about 300× real time:

```bash
node tools/arena.mjs --games 10 --seed 1 --p1 vanguard:balanced --p2 swarm:rush --p3 ascendant:balanced
```

Options: `--minutes N` sets the time limit, `--verbose` prints a per-minute summary, and `--p3 off`
runs a two-player game. Slot spec is `faction:style[:botId]`.

## Layout

```
index.html, style.css     page and HUD
src/data.js               units, buildings, factions: all tunable numbers live here
src/map.js                seeded map generator (plateaus, ramps, expansions, obstacles)
src/sim.js                deterministic simulation, fog of war, observe()
src/path.js               A* + path smoothing
src/rules.js              building placement rules
src/render.js             3/4-view canvas renderer, fog overlay, minimap
src/main.js               menu, game loop, input, HUD, bot hosting
src/assist.js             economy assistant for human players
src/bots/                 bot registry, worker wrapper, shared placement, reference bot
tools/arena.mjs           headless bot-vs-bot runner
```

In the browser console, `OUTPOST.state` is the live game state.
