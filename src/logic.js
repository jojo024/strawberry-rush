/*
 * Strawberry Rush — core game logic (v4: free movement, three levels).
 *
 * Pure simulation module: no DOM, no canvas, no timers. The browser loads it
 * as a plain <script> (exposing window.GameLogic); Node requires it for unit
 * tests. All randomness flows through a seedable RNG so simulations are
 * deterministic and testable.
 *
 * v4 changes:
 *  - FREE MOVEMENT: the player is no longer tile-bound. setMove(game, dx, dy)
 *    sets an analog direction (any angle; diagonals normalized) and the
 *    player glides at PLAYER_SPEED, sliding along walls with a circular
 *    collider. tryDash(game) spends a full berry stack for a speed burst.
 *  - THREE LEVELS on wider 21-column grids (the wider world is what zooms
 *    the camera out), each 34-38 rows tall with four themed zones.
 *  - `walls`: partial hedge segments for maze-like layouts.
 *
 * Coordinate system: tile units; integer coordinates are tile centers.
 * Column 0 is the left edge, row 0 is the TOP (goal / food-truck row); the
 * player starts on the bottom row. The terrain is still a tile grid (for
 * authoring, pathing and hazards) — only movement is continuous.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.GameLogic = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Tuning constants (exported for tests and UI)
  // ---------------------------------------------------------------------
  var C = {
    PLAYER_SPEED: 5.2,     // tiles/second, free movement
    BLANKET_SLOW: 0.55,    // speed multiplier while crossing a picnic rug
    DASH_SPEED: 13,        // tiles/second during a dash burst
    DASH_TIME: 0.32,       // seconds a dash burst lasts (~4 tiles)
    DASH_COST: 3,          // strawberries required; dash consumes the WHOLE stack

    HEARTS: 3,             // hits you can take
    HIT_BERRY_LOSS: 2,     // strawberries dropped when hit
    INVULN_TIME: 2.0,      // seconds of invulnerability after a hit respawn

    SLOTH_GRACE: 4,        // seconds standing still before the penalty starts
    SLOTH_INTERVAL: 2,     // seconds between strawberry losses once slothful

    FLASH_IDLE_MIN: 2.2,   // photographer flash cycle: idle wait range
    FLASH_IDLE_MAX: 5.0,
    FLASH_CHARGE: 0.8,     // telegraph duration before the flash fires
    FLASH_ACTIVE: 0.3,     // window during which crossing the gap photobombs
    PHOTOBOMB_LOSS: 2,     // strawberries lost on a photobomb (capped at owned)

    SPRINKLER_IDLE_MIN: 2.6, // sprinkler cycle: dry wait range
    SPRINKLER_IDLE_MAX: 5.2,
    SPRINKLER_WARN: 1.1,   // sputtering telegraph before the spray
    SPRINKLER_SPRAY: 1.6,  // full-spray duration (soaks the 8 surrounding tiles)
    SPRINKLER_LOSS: 2,     // strawberries lost when soaked
    SPRINKLER_STUN: 0.8,   // seconds you stand dripping, unable to move

    FAN_AGGRO: 3.6,        // autograph hunter notices you inside this radius
    FAN_DEAF: 6.0,         // ...and gives up beyond this radius
    FAN_CHASE_SPEED: 3.0,  // tiles/s while chasing

    PLAYER_R: 0.30,        // player collision radius vs NPCs, in tiles
    BERRY_R: 0.45,         // pickup radius for strawberries
    GOLD_VALUE: 3,         // strawberries granted by the golden berry
    GROUP_RADIUS: 2.0      // wanderers drift back when this far from their group
  };

  // Per-type NPC tuning. radius = collision radius in tiles; turn = max
  // random heading change per "think"; speed/jitter in tiles per second.
  var NPC_TYPES = {
    posh:       { radius: 0.50, speedMin: 0.65, speedMax: 1.05, turn: 1.1,
                  stopChance: 0.22, jitterMin: 0.8, jitterMax: 1.2,
                  thinkMin: 1.2, thinkMax: 2.6 },
    kid:        { radius: 0.24, speedMin: 1.5, speedMax: 2.3, turn: Math.PI,
                  stopChance: 0.15, jitterMin: 0.5, jitterMax: 1.6,
                  thinkMin: 0.4, thinkMax: 1.1 },
    wheelchair: { radius: 0.42, speedMin: 1.2, speedMax: 1.7, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1,
                  thinkMin: 3.0, thinkMax: 5.0 },
    steward:    { radius: 0.40, speedMin: 1.5, speedMax: 1.8, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1,
                  thinkMin: 9, thinkMax: 9 },
    fan:        { radius: 0.32, speedMin: 0.8, speedMax: 1.0, turn: 1.4,
                  stopChance: 0.2, jitterMin: 0.8, jitterMax: 1.2,
                  thinkMin: 0.9, thinkMax: 1.8 },
    seated:     { radius: 0.30, speedMin: 0, speedMax: 0, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1,
                  thinkMin: 99, thinkMax: 99 }
  };

  // ---------------------------------------------------------------------
  // Seedable RNG (mulberry32)
  // ---------------------------------------------------------------------
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function rand(rng, min, max) { return min + rng() * (max - min); }
  function randInt(rng, min, max) { return Math.floor(rand(rng, min, max + 1)); }

  // ---------------------------------------------------------------------
  // THE LEVELS. Each: 21 cols wide (wider = camera shows more), row 0 =
  // food truck (goal), last row = start. Hedge rows split the grounds into
  // four zones; `walls` are partial hedge segments for maze pockets. Every
  // layout is guarded by a BFS connectivity test.
  // ---------------------------------------------------------------------
  var LEVELS = [
    {
      name: 'The Championship Grounds',
      cols: 21, rows: 34,
      startCol: 10, startRow: 33,
      zones: [
        { name: 'Courtside Lawn', rowMin: 1,  rowMax: 8,  threshold: 8,  ground: 'grass', speedScale: 1.25 },
        { name: 'The Concourse',  rowMin: 10, rowMax: 17, threshold: 17, ground: 'path',  speedScale: 1.15 },
        { name: 'Picnic Terrace', rowMin: 19, rowMax: 26, threshold: 26, ground: 'grass', speedScale: 1.05 },
        { name: 'The Queue',      rowMin: 28, rowMax: 32, threshold: null, ground: 'grass', speedScale: 0.85 }
      ],
      hedges: [ // gates are two tiles wide — sized for free movement
        { row: 9,  gaps: [5, 6, 15, 16] },
        { row: 18, gaps: [3, 4, 16, 17] },
        { row: 27, gaps: [10, 11, 17, 18] }
      ],
      walls: [],
      barriers: [
        { row: 13, c0: 7, c1: 13 },
        { row: 15, c0: 0, c1: 4 },
        { row: 30, c0: 3, c1: 8 }
      ],
      trees: [
        { col: 14, row: 29, kind: 'tree' }, { col: 3,  row: 31, kind: 'tree' },
        { col: 10, row: 22, kind: 'tree' }, { col: 0,  row: 25, kind: 'umbrella' },
        { col: 20, row: 21, kind: 'umbrella' }, { col: 16, row: 24, kind: 'tree' },
        { col: 2,  row: 6,  kind: 'tree' }, { col: 18, row: 3,  kind: 'tree' },
        { col: 6,  row: 2,  kind: 'umbrella' }
      ],
      blankets: [
        { col: 2, row: 20, w: 3, h: 2 }, { col: 13, row: 19, w: 3, h: 2 },
        { col: 6, row: 25, w: 2, h: 2 }, { col: 17, row: 25, w: 2, h: 1 }
      ],
      sprinklers: [{ col: 5, row: 23 }, { col: 15, row: 21 }, { col: 9, row: 4 }],
      photographers: [
        { row: 12, leftCol: 2 }, { row: 16, leftCol: 12 }, { row: 5, leftCol: 13 }
      ],
      npcs: [
        { type: 'posh', count: 3, rowMin: 28, rowMax: 32, group: 'qA' },
        { type: 'posh', count: 2, rowMin: 28, rowMax: 32, group: 'qB' },
        { type: 'wheelchair', count: 1, rowMin: 28, rowMax: 32 },
        { type: 'seated', col: 13.3, row: 19.3 }, { type: 'seated', col: 14.7, row: 19.4 },
        { type: 'seated', col: 13.5, row: 20.4 }, { type: 'seated', col: 14.4, row: 20.3 },
        { type: 'seated', col: 2.4,  row: 20.3 }, { type: 'seated', col: 3.6,  row: 20.4 },
        { type: 'seated', col: 2.7,  row: 21.4 },
        { type: 'seated', col: 6.4,  row: 25.4 }, { type: 'seated', col: 7.4,  row: 26.3 },
        { type: 'kid', count: 3, rowMin: 19, rowMax: 26, group: 'siblings' },
        { type: 'posh', count: 2, rowMin: 19, rowMax: 26, group: 'strollers' },
        { type: 'kid', count: 1, rowMin: 19, rowMax: 26 },
        { type: 'steward', waypoints: [[1, 10], [19, 10]] },
        { type: 'steward', waypoints: [[8, 17], [16, 17], [16, 14], [8, 14]] },
        { type: 'posh', count: 3, rowMin: 10, rowMax: 17, group: 'promenade' },
        { type: 'posh', count: 2, rowMin: 10, rowMax: 17 },
        { type: 'wheelchair', count: 2, rowMin: 10, rowMax: 17 },
        { type: 'fan', col: 4, row: 11, rowMin: 10, rowMax: 17 },
        { type: 'kid', count: 3, rowMin: 1, rowMax: 8, group: 'tag' },
        { type: 'posh', count: 3, rowMin: 1, rowMax: 8, group: 'gala' },
        { type: 'wheelchair', count: 2, rowMin: 1, rowMax: 8 },
        { type: 'kid', count: 2, rowMin: 1, rowMax: 8 },
        { type: 'fan', col: 17, row: 6, rowMin: 1, rowMax: 8 }
      ],
      berryCount: 22,
      goldenBerry: { col: 20, row: 1 }
    },
    {
      name: 'The Orangery Maze',
      cols: 21, rows: 36,
      startCol: 10, startRow: 35,
      zones: [
        { name: 'Fountain Court', rowMin: 1,  rowMax: 8,  threshold: 8,  ground: 'grass', speedScale: 1.4 },
        { name: 'The Orangery',   rowMin: 10, rowMax: 17, threshold: 17, ground: 'path',  speedScale: 1.2 },
        { name: 'Rose Parterre',  rowMin: 19, rowMax: 26, threshold: 26, ground: 'grass', speedScale: 1.1 },
        { name: 'Garden Gate',    rowMin: 28, rowMax: 34, threshold: null, ground: 'grass', speedScale: 0.9 }
      ],
      hedges: [
        { row: 9,  gaps: [2, 3, 10, 11] },
        { row: 18, gaps: [7, 8, 15, 16] },
        { row: 27, gaps: [4, 5, 16, 17] }
      ],
      walls: [ // the maze pockets
        { row: 21, c0: 2, c1: 8 }, { row: 21, c0: 12, c1: 18 },
        { row: 24, c0: 6, c1: 14 },
        { row: 12, c0: 0, c1: 5 }, { row: 12, c0: 9, c1: 13 },
        { row: 15, c0: 7, c1: 16 } // open lane on the right flank too
      ],
      barriers: [
        { row: 31, c0: 8, c1: 12 }, { row: 29, c0: 0, c1: 3 }
      ],
      trees: [
        { col: 2,  row: 33, kind: 'tree' }, { col: 18, row: 30, kind: 'tree' },
        { col: 6,  row: 32, kind: 'umbrella' }, { col: 14, row: 32, kind: 'umbrella' },
        { col: 17, row: 22, kind: 'umbrella' }, { col: 0,  row: 24, kind: 'umbrella' },
        { col: 5,  row: 5,  kind: 'tree' }, { col: 15, row: 4,  kind: 'tree' }
      ],
      blankets: [
        { col: 9, row: 19, w: 3, h: 1 }, { col: 2, row: 25, w: 2, h: 2 }
      ],
      sprinklers: [ // the fountains of Fountain Court, plus the parterre
        { col: 10, row: 5 }, { col: 3, row: 3 }, { col: 17, row: 7 },
        { col: 9, row: 22 }, { col: 13, row: 26 }
      ],
      photographers: [
        { row: 11, leftCol: 14 }, { row: 16, leftCol: 1 },
        { row: 20, leftCol: 14 }, { row: 7, leftCol: 7 }
      ],
      npcs: [
        { type: 'posh', count: 3, rowMin: 28, rowMax: 34, group: 'gateA' },
        { type: 'posh', count: 2, rowMin: 28, rowMax: 34, group: 'gateB' },
        { type: 'wheelchair', count: 1, rowMin: 28, rowMax: 34 },
        { type: 'kid', count: 1, rowMin: 28, rowMax: 34 },
        { type: 'seated', col: 2.4, row: 25.4 }, { type: 'seated', col: 3.4, row: 25.6 },
        { type: 'seated', col: 2.6, row: 26.3 }, { type: 'seated', col: 9.5, row: 19.2 },
        { type: 'kid', count: 3, rowMin: 19, rowMax: 26, group: 'roses' },
        { type: 'posh', count: 2, rowMin: 19, rowMax: 26, group: 'parterre' },
        { type: 'wheelchair', count: 1, rowMin: 19, rowMax: 26 },
        { type: 'steward', waypoints: [[1, 13], [19, 13]] },
        { type: 'steward', waypoints: [[3, 10], [17, 10]] },
        { type: 'posh', count: 3, rowMin: 10, rowMax: 17, group: 'orangery' },
        { type: 'wheelchair', count: 2, rowMin: 10, rowMax: 17 },
        { type: 'kid', count: 2, rowMin: 10, rowMax: 17, group: 'chase' },
        { type: 'fan', col: 18, row: 13, rowMin: 10, rowMax: 17 },
        { type: 'kid', count: 4, rowMin: 1, rowMax: 8, group: 'sprint' },
        { type: 'posh', count: 3, rowMin: 1, rowMax: 8, group: 'court' },
        { type: 'wheelchair', count: 2, rowMin: 1, rowMax: 8 },
        { type: 'fan', col: 3, row: 6, rowMin: 1, rowMax: 8 }
      ],
      berryCount: 26,
      goldenBerry: { col: 0, row: 1 }
    },
    {
      name: 'Centre Court Gala',
      cols: 21, rows: 38,
      startCol: 10, startRow: 37,
      zones: [
        { name: "Champions' Lawn",    rowMin: 1,  rowMax: 8,  threshold: 8,  ground: 'grass', speedScale: 1.3 },
        { name: 'Trophy Walk',        rowMin: 10, rowMax: 17, threshold: 17, ground: 'path',  speedScale: 1.35 },
        { name: "Members' Enclosure", rowMin: 19, rowMax: 26, threshold: 26, ground: 'grass', speedScale: 1.2 },
        { name: 'The Forecourt',      rowMin: 28, rowMax: 36, threshold: null, ground: 'grass', speedScale: 1.0 }
      ],
      hedges: [
        { row: 9,  gaps: [8, 9, 14, 15] },
        { row: 18, gaps: [4, 5, 10, 11] },
        { row: 27, gaps: [2, 3, 17, 18] }
      ],
      walls: [
        { row: 23, c0: 0, c1: 6 }, { row: 23, c0: 10, c1: 16 },
        { row: 13, c0: 4, c1: 9 }, { row: 13, c0: 15, c1: 18 },
        { row: 33, c0: 7, c1: 13 }
      ],
      barriers: [
        { row: 11, c0: 0, c1: 2 }, { row: 11, c0: 18, c1: 20 },
        { row: 31, c0: 8, c1: 12 }
      ],
      trees: [
        { col: 4,  row: 29, kind: 'tree' }, { col: 16, row: 35, kind: 'tree' },
        { col: 1,  row: 34, kind: 'umbrella' },
        { col: 8,  row: 20, kind: 'tree' }, { col: 13, row: 25, kind: 'umbrella' },
        { col: 2,  row: 4,  kind: 'tree' }, { col: 18, row: 5,  kind: 'umbrella' },
        { col: 10, row: 6,  kind: 'tree' }
      ],
      blankets: [
        { col: 16, row: 20, w: 3, h: 2 }, { col: 4, row: 25, w: 2, h: 1 }
      ],
      sprinklers: [
        { col: 6, row: 25 }, { col: 14, row: 19 },
        { col: 5, row: 3 }, { col: 15, row: 6 }
      ],
      photographers: [
        { row: 15, leftCol: 1 }, { row: 12, leftCol: 11 },
        { row: 21, leftCol: 3 }, { row: 24, leftCol: 15 },
        { row: 5, leftCol: 8 }
      ],
      npcs: [
        { type: 'posh', count: 3, rowMin: 28, rowMax: 36, group: 'promA' },
        { type: 'posh', count: 3, rowMin: 28, rowMax: 36, group: 'promB' },
        { type: 'wheelchair', count: 1, rowMin: 28, rowMax: 36 },
        { type: 'kid', count: 2, rowMin: 28, rowMax: 36, group: 'dart' },
        { type: 'seated', col: 16.4, row: 20.3 }, { type: 'seated', col: 17.6, row: 20.5 },
        { type: 'seated', col: 16.6, row: 21.4 },
        { type: 'seated', col: 4.4,  row: 25.3 }, { type: 'seated', col: 5.4,  row: 25.5 },
        { type: 'kid', count: 3, rowMin: 19, rowMax: 26, group: 'galaKids' },
        { type: 'posh', count: 3, rowMin: 19, rowMax: 26, group: 'members' },
        { type: 'wheelchair', count: 1, rowMin: 19, rowMax: 26 },
        { type: 'steward', waypoints: [[6, 16], [14, 16]] },
        { type: 'steward', waypoints: [[2, 10], [18, 10]] },
        { type: 'posh', count: 3, rowMin: 10, rowMax: 17, group: 'walk' },
        { type: 'wheelchair', count: 2, rowMin: 10, rowMax: 17 },
        { type: 'kid', count: 2, rowMin: 10, rowMax: 17 },
        { type: 'fan', col: 16, row: 11, rowMin: 10, rowMax: 17 },
        { type: 'kid', count: 3, rowMin: 1, rowMax: 8, group: 'finalTag' },
        { type: 'posh', count: 3, rowMin: 1, rowMax: 8, group: 'champagne' },
        { type: 'wheelchair', count: 2, rowMin: 1, rowMax: 8 },
        { type: 'fan', col: 2, row: 6, rowMin: 1, rowMax: 8 }
      ],
      berryCount: 28,
      goldenBerry: { col: 20, row: 1 }
    }
  ];

  // ---------------------------------------------------------------------
  // Terrain construction
  // ---------------------------------------------------------------------
  function buildTerrain(def) {
    var terrain = [];
    var r, c;
    for (r = 0; r < def.rows; r++) {
      terrain.push([]);
      var zone = zoneForRow(def, r);
      var ground = zone ? zone.ground : 'grass';
      for (c = 0; c < def.cols; c++) {
        terrain[r].push({ t: ground, block: null });
      }
    }
    (def.hedges || []).forEach(function (h) {
      for (c = 0; c < def.cols; c++) {
        if (h.gaps.indexOf(c) === -1) terrain[h.row][c].block = 'hedge';
      }
    });
    (def.walls || []).forEach(function (wl) {
      for (c = wl.c0; c <= wl.c1; c++) terrain[wl.row][c].block = 'hedge';
    });
    (def.barriers || []).forEach(function (b) {
      for (c = b.c0; c <= b.c1; c++) terrain[b.row][c].block = 'barrier';
    });
    (def.trees || []).forEach(function (t) {
      terrain[t.row][t.col].block = t.kind;
    });
    (def.blankets || []).forEach(function (b) {
      for (r = b.row; r < b.row + (b.h || 1); r++) {
        for (c = b.col; c < b.col + (b.w || 1); c++) {
          if (!terrain[r][c].block) terrain[r][c].t = 'blanket';
        }
      }
    });
    (def.sprinklers || []).forEach(function (s) {
      terrain[s.row][s.col].block = 'sprinkler';
    });
    (def.photographers || []).forEach(function (p) {
      terrain[p.row][p.leftCol].block = 'photographer';
      terrain[p.row][p.leftCol + 3].block = 'photographer';
    });
    return terrain;
  }

  function zoneForRow(def, row) {
    var zones = def.zones || [];
    for (var i = 0; i < zones.length; i++) {
      if (row >= zones[i].rowMin && row <= zones[i].rowMax) return zones[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Game construction
  // ---------------------------------------------------------------------
  function createGame(levelDef, seed) {
    var def = levelDef || LEVELS[0];
    var rng = makeRng(seed === undefined ? 1 : seed);

    var game = {
      level: def,
      cols: def.cols,
      numRows: def.rows,
      terrain: buildTerrain(def),
      rng: rng,
      seed: seed === undefined ? 1 : seed,
      status: 'playing',          // 'playing' | 'won' | 'dead'
      deathCause: null,
      time: 0,
      hearts: C.HEARTS,
      invuln: 0,
      strawberries: 0,
      berriesCollected: 0,
      dashesUsed: 0,
      events: [],                 // drained by the shell for SFX/UI feedback
      player: null,
      npcs: [],
      photographers: [],
      sprinklers: [],
      berries: [],
      checkpoint: { col: def.startCol, row: def.startRow },
      checkpointStage: 0,
      slothTimer: 0,
      slothLossTimer: 0
    };

    game.player = {
      x: def.startCol, y: def.startRow,       // continuous position
      px: def.startCol, py: def.startRow,     // previous position (render lerp)
      col: def.startCol, row: def.startRow,   // rounded tile (HUD, hazards)
      lastRow: def.startRow,
      moveX: 0, moveY: 0,                     // analog input direction (unit)
      dirX: 0, dirY: -1,                      // last facing (for dash/render)
      dash: null,                             // {t, dur, dx, dy}
      moving: false,
      stun: 0
    };

    spawnNpcs(game, def);
    spawnPhotographers(game, def);
    spawnSprinklers(game, def);
    spawnBerries(game, def);
    return game;
  }

  function isBlockedAt(game, col, row) {
    if (col < 0 || col >= game.cols || row < 0 || row >= game.numRows) return true;
    return game.terrain[row][col].block !== null;
  }

  function tileWalkable(game, col, row) {
    return !isBlockedAt(game, col, row);
  }

  function spawnNpcs(game, def) {
    (def.npcs || []).forEach(function (spec) {
      var t = NPC_TYPES[spec.type];
      var zone = spec.rowMin !== undefined ? zoneForRow(def, spec.rowMin) : null;
      var scale = spec.speedScale || (zone ? zone.speedScale : 1);

      if (spec.type === 'steward') {
        game.npcs.push({
          type: 'steward',
          x: spec.waypoints[0][0], y: spec.waypoints[0][1],
          px: spec.waypoints[0][0], py: spec.waypoints[0][1],
          waypoints: spec.waypoints, wpIndex: 1,
          speed: rand(game.rng, t.speedMin, t.speedMax) * scale,
          heading: 0, radius: t.radius, group: null,
          yMin: 0, yMax: game.numRows - 1
        });
        return;
      }

      var count = spec.count || 1;

      // Grouped wanderers spawn as a cluster around a shared anchor, so
      // parties enter the world already walking together.
      var anchorX = null, anchorY = null;
      if (spec.group) {
        var atries = 0;
        do {
          anchorX = rand(game.rng, 1.5, game.cols - 2.5);
          anchorY = rand(game.rng, spec.rowMin + 0.5, spec.rowMax - 0.5);
          atries++;
        } while (isBlockedAt(game, Math.round(anchorX), Math.round(anchorY)) && atries < 60);
      }

      for (var i = 0; i < count; i++) {
        var x, y, tries = 0;
        if (spec.col !== undefined) { x = spec.col; y = spec.row; }
        else if (spec.group) {
          do {
            x = Math.max(0.5, Math.min(game.cols - 1.5,
                anchorX + rand(game.rng, -1.0, 1.0)));
            y = Math.max(spec.rowMin, Math.min(spec.rowMax,
                anchorY + rand(game.rng, -1.0, 1.0)));
            tries++;
          } while (isBlockedAt(game, Math.round(x), Math.round(y)) && tries < 60);
        } else {
          do {
            x = rand(game.rng, 0.5, game.cols - 1.5);
            y = rand(game.rng, spec.rowMin, spec.rowMax);
            tries++;
          } while (isBlockedAt(game, Math.round(x), Math.round(y)) && tries < 60);
        }
        game.npcs.push({
          type: spec.type,
          x: x, y: y, px: x, py: y,
          heading: rand(game.rng, 0, Math.PI * 2),
          baseSpeed: rand(game.rng, t.speedMin, t.speedMax) * scale,
          speed: 0,
          radius: t.radius,
          group: spec.group || null,
          yMin: spec.rowMin !== undefined ? spec.rowMin : y,
          yMax: spec.rowMax !== undefined ? spec.rowMax : y,
          mode: 'walk',            // 'walk' | 'stopped'
          modeT: 0,
          chasing: false,          // fan only
          think: rand(game.rng, 0, t.thinkMax)
        });
        var npc = game.npcs[game.npcs.length - 1];
        npc.speed = npc.baseSpeed;
      }
    });
  }

  function spawnPhotographers(game, def) {
    (def.photographers || []).forEach(function (p) {
      game.photographers.push({
        row: p.row, leftCol: p.leftCol, rightCol: p.leftCol + 3,
        dangerCols: [p.leftCol + 1, p.leftCol + 2],
        phase: 'idle',
        phaseT: rand(game.rng, C.FLASH_IDLE_MIN, C.FLASH_IDLE_MAX),
        bombed: false
      });
    });
  }

  function spawnSprinklers(game, def) {
    (def.sprinklers || []).forEach(function (s) {
      game.sprinklers.push({
        col: s.col, row: s.row,
        phase: 'idle',
        phaseT: rand(game.rng, C.SPRINKLER_IDLE_MIN, C.SPRINKLER_IDLE_MAX),
        soaked: false
      });
    });
  }

  function spawnBerries(game, def) {
    var attempts = 0;
    var count = def.berryCount || 0;
    while (game.berries.length < count && attempts < 900) {
      attempts++;
      var r = randInt(game.rng, 1, game.numRows - 2);
      var c = randInt(game.rng, 0, game.cols - 1);
      if (isBlockedAt(game, c, r)) continue;
      var clash = false;
      for (var i = 0; i < game.berries.length; i++) {
        if (game.berries[i].col === c && game.berries[i].row === r) { clash = true; break; }
      }
      if (!clash) game.berries.push({ col: c, row: r, alive: true, golden: false });
    }
    if (def.goldenBerry && !isBlockedAt(game, def.goldenBerry.col, def.goldenBerry.row)) {
      game.berries.push({ col: def.goldenBerry.col, row: def.goldenBerry.row,
                          alive: true, golden: true });
    }
  }

  // ---------------------------------------------------------------------
  // Input — free movement
  // ---------------------------------------------------------------------

  /**
   * Set the player's analog movement direction (any vector; normalized
   * here, zero vector = stand still). The shell calls this every tick from
   * the current input state.
   */
  function setMove(game, dx, dy) {
    var p = game.player;
    var m = Math.sqrt(dx * dx + dy * dy);
    if (m > 1e-6) {
      p.moveX = dx / m; p.moveY = dy / m;
      p.dirX = p.moveX; p.dirY = p.moveY;
    } else {
      p.moveX = 0; p.moveY = 0;
    }
  }

  /**
   * Dash: a speed burst in the current movement (or facing) direction.
   * Needs a full stack of DASH_COST strawberries and consumes ALL of them.
   */
  function tryDash(game) {
    if (game.status !== 'playing') return false;
    var p = game.player;
    if (p.stun > 0 || p.dash) return false;
    if (game.strawberries < C.DASH_COST) return false;
    var dx = p.dirX, dy = p.dirY;
    if (!dx && !dy) { dx = 0; dy = -1; } // default: upfield
    game.strawberries = 0;
    game.dashesUsed++;
    p.dash = { t: 0, dur: C.DASH_TIME, dx: dx, dy: dy };
    game.events.push({ type: 'dash' });
    return true;
  }

  // ---------------------------------------------------------------------
  // Simulation step — fixed dt (the shell calls this at 60 Hz)
  // ---------------------------------------------------------------------
  function step(game, dt) {
    if (game.status !== 'playing') return;
    game.time += dt;
    if (game.invuln > 0) game.invuln = Math.max(0, game.invuln - dt);
    if (game.player.stun > 0) game.player.stun = Math.max(0, game.player.stun - dt);

    stepPlayer(game, dt);
    stepSloth(game, dt);
    stepNpcs(game, dt);
    stepPhotographers(game, dt);
    stepSprinklers(game, dt);
    checkCollisions(game);
    if (game.status !== 'playing') return;

    // Win: reach the goal row.
    if (game.player.y <= 0.35) {
      game.status = 'won';
      game.events.push({ type: 'won', time: game.time,
                         berries: game.berriesCollected });
    }
  }

  /** Would a player circle at (x, y) overlap any blocked tile? */
  function circleBlocked(game, x, y) {
    var r = C.PLAYER_R * 0.9; // slight forgiveness for squeezing gates
    var c0 = Math.round(x - r), c1 = Math.round(x + r);
    var r0 = Math.round(y - r), r1 = Math.round(y + r);
    for (var rr = r0; rr <= r1; rr++) {
      for (var cc = c0; cc <= c1; cc++) {
        if (isBlockedAt(game, cc, rr)) return true;
      }
    }
    return false;
  }

  function stepPlayer(game, dt) {
    var p = game.player;
    p.px = p.x; p.py = p.y;

    var vx = 0, vy = 0;
    if (p.stun <= 0) {
      if (p.dash) {
        p.dash.t += dt;
        vx = p.dash.dx * C.DASH_SPEED;
        vy = p.dash.dy * C.DASH_SPEED;
        if (p.dash.t >= p.dash.dur) p.dash = null;
      } else if (p.moveX !== 0 || p.moveY !== 0) {
        var sp = C.PLAYER_SPEED;
        if (game.terrain[p.row][p.col].t === 'blanket') sp *= C.BLANKET_SLOW;
        vx = p.moveX * sp;
        vy = p.moveY * sp;
      }
    }
    p.moving = vx !== 0 || vy !== 0;
    if (p.moving) { game.slothTimer = 0; game.slothLossTimer = 0; }

    // Per-axis move + collide = natural wall sliding.
    var nx = Math.max(0, Math.min(game.cols - 1, p.x + vx * dt));
    if (!circleBlocked(game, nx, p.y)) p.x = nx;
    else if (p.dash) p.dash = null;      // a wall stops a dash
    var ny = Math.max(0, Math.min(game.numRows - 1, p.y + vy * dt));
    if (!circleBlocked(game, p.x, ny)) p.y = ny;
    else if (p.dash) p.dash = null;

    p.col = Math.round(p.x);
    p.row = Math.round(p.y);
    if (p.row !== p.lastRow) {
      p.lastRow = p.row;
      checkCheckpoint(game);
    }
    collectBerries(game);
  }

  function checkCheckpoint(game) {
    var zones = game.level.zones || [];
    var p = game.player;
    // Zones are listed top-down. Count how many zone thresholds the player
    // has crossed (from the bottom up); passing a new one plants a checkpoint.
    var crossed = 0;
    for (var z = zones.length - 1; z >= 0; z--) {
      var th = zones[z].threshold;
      if (th !== null && th !== undefined && p.row <= th) crossed = zones.length - 1 - z;
    }
    if (crossed > game.checkpointStage) {
      game.checkpointStage = crossed;
      game.checkpoint = { col: p.col, row: p.row };
      var zone = zoneForRow(game.level, p.row);
      game.events.push({ type: 'checkpoint', zone: zone ? zone.name : '' });
    }
  }

  function collectBerries(game) {
    var p = game.player;
    for (var i = 0; i < game.berries.length; i++) {
      var b = game.berries[i];
      if (!b.alive) continue;
      var dx = b.col - p.x, dy = b.row - p.y;
      if (dx * dx + dy * dy < C.BERRY_R * C.BERRY_R) {
        b.alive = false;
        var value = b.golden ? C.GOLD_VALUE : 1;
        game.strawberries += value;
        game.berriesCollected += value;
        game.events.push({ type: b.golden ? 'goldBerry' : 'berry',
                           count: game.strawberries });
      }
    }
  }

  function stepSloth(game, dt) {
    var p = game.player;
    if (p.moving) return;
    game.slothTimer += dt;
    if (game.slothTimer < C.SLOTH_GRACE) return;
    if (game.strawberries <= 0) return;
    game.slothLossTimer += dt;
    if (game.slothLossTimer >= C.SLOTH_INTERVAL) {
      game.slothLossTimer -= C.SLOTH_INTERVAL;
      game.strawberries--;
      game.events.push({ type: 'slothLoss', count: game.strawberries });
    }
  }

  // ------------------------------------------------------------------ NPCs
  function stepNpcs(game, dt) {
    for (var i = 0; i < game.npcs.length; i++) {
      var npc = game.npcs[i];
      npc.px = npc.x; npc.py = npc.y;

      if (npc.type === 'seated') continue; // picnickers hold their spot
      if (npc.type === 'steward') { stepSteward(game, npc, dt); continue; }
      if (npc.type === 'fan') stepFanBrain(game, npc);

      var t = NPC_TYPES[npc.type];
      if (!npc.chasing) {
        npc.think -= dt;
        if (npc.think <= 0) {
          npc.think = rand(game.rng, t.thinkMin, t.thinkMax);
          var roll = game.rng();
          if (roll < t.stopChance) {
            npc.mode = 'stopped';
            npc.modeT = rand(game.rng, 0.4, 1.3);
          } else {
            npc.mode = 'walk';
            var steered = false;
            if (npc.group) {
              var cx = 0, cy = 0, cnt = 0;
              for (var m = 0; m < game.npcs.length; m++) {
                if (game.npcs[m].group === npc.group) {
                  cx += game.npcs[m].x; cy += game.npcs[m].y; cnt++;
                }
              }
              if (cnt > 1) {
                cx /= cnt; cy /= cnt;
                var gdx = cx - npc.x, gdy = cy - npc.y;
                if (gdx * gdx + gdy * gdy > C.GROUP_RADIUS * C.GROUP_RADIUS) {
                  npc.heading = Math.atan2(gdy, gdx) + rand(game.rng, -0.4, 0.4);
                  steered = true;
                }
              }
            }
            if (!steered) npc.heading += rand(game.rng, -t.turn, t.turn);
            npc.speed = npc.baseSpeed * rand(game.rng, t.jitterMin, t.jitterMax);
          }
        }
        if (npc.mode === 'stopped') {
          npc.modeT -= dt;
          if (npc.modeT <= 0) npc.mode = 'walk';
          continue;
        }
      }
      moveNpc(game, npc, dt);
    }
  }

  function stepSteward(game, npc, dt) {
    var wp = npc.waypoints[npc.wpIndex];
    var dx = wp[0] - npc.x, dy = wp[1] - npc.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.08) {
      npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length;
      return;
    }
    npc.heading = Math.atan2(dy, dx);
    var move = Math.min(d, npc.speed * dt);
    npc.x += (dx / d) * move;
    npc.y += (dy / d) * move;
  }

  function stepFanBrain(game, npc) {
    var p = game.player;
    var dx = p.x - npc.x, dy = p.y - npc.y;
    var d2 = dx * dx + dy * dy;
    var inBand = p.y >= npc.yMin - 0.5 && p.y <= npc.yMax + 0.5;
    if (npc.chasing) {
      if (d2 > C.FAN_DEAF * C.FAN_DEAF || !inBand) {
        npc.chasing = false;
        game.events.push({ type: 'fanLost' });
      }
    } else if (inBand && d2 < C.FAN_AGGRO * C.FAN_AGGRO) {
      npc.chasing = true;
      game.events.push({ type: 'fanSpotted' });
    }
    if (npc.chasing) npc.heading = Math.atan2(dy, dx);
  }

  function moveNpc(game, npc, dt) {
    var sp = npc.chasing ? C.FAN_CHASE_SPEED : npc.speed;
    var nx = npc.x + Math.cos(npc.heading) * sp * dt;
    var ny = npc.y + Math.sin(npc.heading) * sp * dt;

    if (nx < 0 || nx > game.cols - 1) {
      npc.heading = Math.PI - npc.heading;
      nx = Math.max(0, Math.min(game.cols - 1, nx));
    }
    if (ny < npc.yMin || ny > npc.yMax) {
      npc.heading = -npc.heading;
      ny = Math.max(npc.yMin, Math.min(npc.yMax, ny));
    }
    if (isBlockedAt(game, Math.round(nx), Math.round(ny))) {
      npc.heading += Math.PI + rand(game.rng, -0.7, 0.7);
      return;
    }
    npc.x = nx; npc.y = ny;
  }

  // ------------------------------------------------------------- hazards
  function stepPhotographers(game, dt) {
    for (var i = 0; i < game.photographers.length; i++) {
      var ph = game.photographers[i];
      ph.phaseT -= dt;
      if (ph.phaseT <= 0) {
        if (ph.phase === 'idle') {
          ph.phase = 'charging';
          ph.phaseT = C.FLASH_CHARGE;
          game.events.push({ type: 'flashCharge' });
        } else if (ph.phase === 'charging') {
          ph.phase = 'flash';
          ph.phaseT = C.FLASH_ACTIVE;
          ph.bombed = false;
          game.events.push({ type: 'flash' });
        } else {
          ph.phase = 'idle';
          ph.phaseT = rand(game.rng, C.FLASH_IDLE_MIN, C.FLASH_IDLE_MAX);
        }
      }
      if (ph.phase === 'flash' && !ph.bombed) {
        var pc = game.player.col, pr = game.player.row;
        if (pr === ph.row && ph.dangerCols.indexOf(pc) !== -1) {
          ph.bombed = true;
          var loss = Math.min(C.PHOTOBOMB_LOSS, game.strawberries);
          game.strawberries -= loss;
          game.events.push({ type: 'photobomb', lost: loss, count: game.strawberries });
        }
      }
    }
  }

  function stepSprinklers(game, dt) {
    for (var i = 0; i < game.sprinklers.length; i++) {
      var s = game.sprinklers[i];
      s.phaseT -= dt;
      if (s.phaseT <= 0) {
        if (s.phase === 'idle') {
          s.phase = 'warn';
          s.phaseT = C.SPRINKLER_WARN;
        } else if (s.phase === 'warn') {
          s.phase = 'spray';
          s.phaseT = C.SPRINKLER_SPRAY;
          s.soaked = false;
          game.events.push({ type: 'spray', col: s.col, row: s.row });
        } else {
          s.phase = 'idle';
          s.phaseT = rand(game.rng, C.SPRINKLER_IDLE_MIN, C.SPRINKLER_IDLE_MAX);
        }
      }
      if (s.phase === 'spray' && !s.soaked) {
        var pc = game.player.col, pr = game.player.row;
        if (Math.abs(pc - s.col) <= 1 && Math.abs(pr - s.row) <= 1 &&
            !(pc === s.col && pr === s.row)) {
          s.soaked = true;
          var loss = Math.min(C.SPRINKLER_LOSS, game.strawberries);
          game.strawberries -= loss;
          game.player.stun = C.SPRINKLER_STUN;
          game.events.push({ type: 'sprinklerHit', lost: loss,
                             count: game.strawberries });
        }
      }
    }
  }

  // ------------------------------------------------------------ collisions
  function checkCollisions(game) {
    if (game.invuln > 0) return;
    var p = game.player;
    for (var i = 0; i < game.npcs.length; i++) {
      var npc = game.npcs[i];
      var r = npc.radius + C.PLAYER_R;
      var dx = npc.x - p.x, dy = npc.y - p.y;
      if (dx * dx + dy * dy < r * r) {
        hitPlayer(game, npc.type);
        return;
      }
    }
  }

  function hitPlayer(game, cause) {
    game.hearts--;
    var loss = Math.min(C.HIT_BERRY_LOSS, game.strawberries);
    game.strawberries -= loss;
    game.events.push({ type: 'hit', cause: cause, hearts: game.hearts, lost: loss });
    if (game.hearts <= 0) {
      game.status = 'dead';
      game.deathCause = cause;
      game.events.push({ type: 'dead', cause: cause });
      return;
    }
    var p = game.player;
    p.x = game.checkpoint.col; p.y = game.checkpoint.row;
    p.px = p.x; p.py = p.y;
    p.col = game.checkpoint.col; p.row = game.checkpoint.row;
    p.lastRow = p.row;
    p.dash = null; p.stun = 0;
    game.invuln = C.INVULN_TIME;
    game.slothTimer = 0;
    game.slothLossTimer = 0;
  }

  return {
    C: C,
    NPC_TYPES: NPC_TYPES,
    LEVELS: LEVELS,
    LEVEL: LEVELS[0],           // convenience alias
    makeRng: makeRng,
    createGame: createGame,
    setMove: setMove,
    tryDash: tryDash,
    step: step,
    tileWalkable: tileWalkable,
    zoneForRow: zoneForRow
  };
});
