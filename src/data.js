// Static game data: factions, units, buildings. Shared by the simulation, the UI and the bots.

export const TICK_RATE = 16;          // simulation ticks per game second
export const DT = 1 / TICK_RATE;
export const MAX_SUPPLY = 100;
export const MAP_SIZE = 112;          // tiles per side ("medium")

export const PLAYER_COLORS = ['#4f8cff', '#ff5a4f', '#3ecf6e'];
export const PLAYER_NAMES = ['Blue', 'Red', 'Green'];

export const FACTIONS = {
  vanguard: {
    name: 'Vanguard',
    blurb: 'Engineers stay on site to construct. Build anywhere. Long-range siege crawlers.',
    base: 'hub', worker: 'engineer', supply: 'depot', gas: 'refinery',
    buildStyle: 'construct',
  },
  swarm: {
    name: 'Swarm',
    blurb: 'Drones morph into buildings, which must sit on creep. Hives spawn larvae; everything regenerates.',
    base: 'hive', worker: 'drone', supply: 'pod', gas: 'extractor',
    buildStyle: 'morph',
  },
  ascendant: {
    name: 'Ascendant',
    blurb: 'Acolytes start a warp-in and walk away. Most buildings need pylon power. Shields regenerate.',
    base: 'nexus', worker: 'acolyte', supply: 'pylon', gas: 'assimilator',
    buildStyle: 'warp',
  },
};

// range: distance between edges, in tiles. speed: tiles/second. cooldown: seconds.
// cost: [minerals, gas]. time: seconds. count: units produced per order.
export const UNITS = {
  engineer: { faction: 'vanguard', name: 'Engineer', worker: true, hp: 60, armor: 0, speed: 2.8, sight: 7, range: 0.3, damage: 5, cooldown: 1.1, cost: [50, 0], time: 12, supply: 1, radius: 0.32, key: 'E' },
  trooper:  { faction: 'vanguard', name: 'Trooper', hp: 45, armor: 0, speed: 2.6, sight: 8, range: 4, damage: 6, cooldown: 0.6, cost: [50, 0], time: 18, supply: 1, radius: 0.3, key: 'T', ranged: true },
  crawler:  { faction: 'vanguard', name: 'Crawler', hp: 160, armor: 1, speed: 2.2, sight: 10, range: 6.5, damage: 28, cooldown: 2.0, splash: 0.9, cost: [150, 75], time: 30, supply: 3, radius: 0.55, key: 'C', ranged: true, requires: ['factory'] },

  drone:    { faction: 'swarm', name: 'Drone', worker: true, hp: 40, armor: 0, speed: 2.9, sight: 7, range: 0.3, damage: 5, cooldown: 1.1, cost: [50, 0], time: 12, supply: 1, radius: 0.32, key: 'D', regen: 0.4 },
  biter:    { faction: 'swarm', name: 'Biter', hp: 35, armor: 0, speed: 4.2, sight: 7, range: 0.3, damage: 5, cooldown: 0.55, cost: [50, 0], time: 17, supply: 0.5, count: 2, radius: 0.27, key: 'B', regen: 0.4, requires: ['pit'] },
  spitter:  { faction: 'swarm', name: 'Spitter', hp: 85, armor: 0, speed: 2.9, sight: 9, range: 4.5, damage: 11, cooldown: 0.85, cost: [75, 25], time: 22, supply: 2, radius: 0.4, key: 'S', regen: 0.4, ranged: true, requires: ['den'] },

  acolyte:  { faction: 'ascendant', name: 'Acolyte', worker: true, hp: 20, shield: 20, armor: 0, speed: 2.8, sight: 7, range: 0.3, damage: 5, cooldown: 1.1, cost: [50, 0], time: 12, supply: 1, radius: 0.32, key: 'E' },
  warden:   { faction: 'ascendant', name: 'Warden', hp: 100, shield: 60, armor: 1, speed: 2.6, sight: 8, range: 0.3, damage: 16, cooldown: 1.2, cost: [100, 0], time: 28, supply: 2, radius: 0.4, key: 'W' },
  lancer:   { faction: 'ascendant', name: 'Lancer', hp: 80, shield: 80, armor: 1, speed: 3.0, sight: 10, range: 6, damage: 13, cooldown: 1.35, cost: [125, 50], time: 30, supply: 2, radius: 0.42, key: 'L', ranged: true, requires: ['core'] },
};

// size: footprint in tiles (square). supply: supply provided. creep/power: radius in tiles.
export const BUILDINGS = {
  hub:       { faction: 'vanguard', name: 'Command Hub', size: 3, hp: 1500, armor: 1, cost: [400, 0], time: 70, supply: 10, produces: ['engineer'], dropoff: true, sight: 10, key: 'C', base: true },
  depot:     { faction: 'vanguard', name: 'Supply Depot', size: 2, hp: 400, armor: 1, cost: [100, 0], time: 20, supply: 8, sight: 7, key: 'D' },
  barracks:  { faction: 'vanguard', name: 'Barracks', size: 3, hp: 1000, armor: 1, cost: [150, 0], time: 40, produces: ['trooper'], sight: 8, key: 'B' },
  factory:   { faction: 'vanguard', name: 'Factory', size: 3, hp: 1250, armor: 1, cost: [200, 100], time: 50, produces: ['crawler'], sight: 8, key: 'F', requires: ['barracks'] },
  refinery:  { faction: 'vanguard', name: 'Refinery', size: 2, hp: 750, armor: 1, cost: [75, 0], time: 25, onGeyser: true, sight: 7, key: 'R' },

  hive:      { faction: 'swarm', name: 'Hive', size: 3, hp: 1500, armor: 1, cost: [300, 0], time: 70, supply: 10, produces: ['drone', 'biter', 'spitter'], dropoff: true, creep: 9, larva: true, sight: 10, key: 'V', base: true, regen: 0.4 },
  pod:       { faction: 'swarm', name: 'Brood Pod', size: 2, hp: 350, armor: 1, cost: [100, 0], time: 20, supply: 8, creep: 5, sight: 7, key: 'O', regen: 0.4 },
  pit:       { faction: 'swarm', name: 'Spawning Pit', size: 2, hp: 750, armor: 1, cost: [200, 0], time: 40, sight: 7, key: 'P', regen: 0.4 },
  den:       { faction: 'swarm', name: 'Spitter Den', size: 2, hp: 850, armor: 1, cost: [100, 50], time: 30, sight: 7, key: 'D', requires: ['pit'], regen: 0.4 },
  extractor: { faction: 'swarm', name: 'Extractor', size: 2, hp: 750, armor: 1, cost: [25, 0], time: 20, onGeyser: true, sight: 7, key: 'E', regen: 0.4 },

  nexus:     { faction: 'ascendant', name: 'Nexus', size: 3, hp: 1000, shield: 1000, armor: 1, cost: [400, 0], time: 70, supply: 10, produces: ['acolyte'], dropoff: true, sight: 10, key: 'N', base: true },
  pylon:     { faction: 'ascendant', name: 'Pylon', size: 2, hp: 200, shield: 200, armor: 1, cost: [100, 0], time: 18, supply: 8, power: 6.5, sight: 7, key: 'P' },
  gateway:   { faction: 'ascendant', name: 'Gateway', size: 3, hp: 500, shield: 500, armor: 1, cost: [150, 0], time: 45, produces: ['warden', 'lancer'], needsPower: true, sight: 8, key: 'G' },
  core:      { faction: 'ascendant', name: 'Core', size: 2, hp: 550, shield: 550, armor: 1, cost: [150, 0], time: 40, needsPower: true, sight: 7, key: 'Y', requires: ['gateway'] },
  assimilator: { faction: 'ascendant', name: 'Assimilator', size: 2, hp: 450, shield: 450, armor: 1, cost: [75, 0], time: 25, onGeyser: true, sight: 7, key: 'E' },
};

export const MINERAL_AMOUNT = 1500;
export const GEYSER_AMOUNT = 2500;
export const MINE_TIME = 2.5, MINE_AMOUNT = 5;
export const GAS_TIME = 1.5, GAS_AMOUNT = 4;
export const LARVA_TIME = 11, LARVA_MAX = 3;
export const SHIELD_REGEN = 2, SHIELD_DELAY = 7;
export const QUEUE_MAX = 5;

export function def(type) { return UNITS[type] || BUILDINGS[type]; }

export function buildingsOf(faction) {
  return Object.keys(BUILDINGS).filter(k => BUILDINGS[k].faction === faction);
}

// Where can a given faction build this? ('creep' for swarm except hive/extractor)
export function placementRule(type) {
  const b = BUILDINGS[type];
  if (b.onGeyser) return 'geyser';
  if (b.faction === 'swarm' && !b.base) return 'creep';
  if (b.needsPower) return 'power';
  return 'free';
}
