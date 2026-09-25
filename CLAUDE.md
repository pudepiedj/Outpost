# Outpost: notes for Claude

Browser RTS (three factions, fog of war) in plain JavaScript ES modules and 2D canvas.
No build step, no dependencies, no package install. See README.md for gameplay, controls and the bot API.

## Running

- Browser: `python3 serve.py` then open http://127.0.0.1:8642 (modules and Web Workers need http, not file://).
- Headless: `node tools/arena.mjs --games 5 --seed 1` runs bot-vs-bot games of the real simulation, ~200x real time.
  Use it after any change to `src/sim.js`, `src/data.js`, `src/map.js`, `src/rules.js` or the bots.
- Visual check in the cloud: Playwright + Chromium are preinstalled (`require('playwright')` from the global npm root);
  load the page, click `#start`, screenshot. The Google Font fails behind the sandbox proxy; that error is harmless.

## Architecture rules

- `src/sim.js` is deterministic and the only authority. It must not import anything browser-only
  (the arena runs it in Node). Renderer, HUD and input never mutate game state except through `issue()`.
- Bots and the economy assist see only `observe(state, player)` (fog-filtered). Never give them the full state.
- All tunable numbers (units, buildings, costs, map size) live in `src/data.js`.
- `src/render.js` owns everything visual, including the screen <-> world projection
  (`screenToWorld`, `worldToScreen`, `miniToWorld`); `src/main.js` must go through those, never do its own math.
  The view is isometric (2:1): world tile (x, y) maps to iso pixels ((x - y) * 32, (x + y) * 16) at zoom 1.
  All art is procedural canvas drawing; there are no image assets.
- Faction/unit names are original (Vanguard, Swarm, Ascendant). Keep art and names original; do not copy Blizzard assets.

## Conventions

- Match the existing dense style: short helpers, few comments, no frameworks, no TypeScript.
- Keep the game playable on a Mac with Safari and Chrome; the owner runs it locally via `Outpost.command`.
- Develop on the session's feature branch; the owner pulls it locally to play-test.
