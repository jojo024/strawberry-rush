/*
 * Strawberry Rush — core game logic.
 *
 * Pure simulation module: no DOM, no canvas, no timers. The browser loads it
 * as a plain <script> (exposing window.GameLogic); Node requires it for unit
 * tests. All randomness flows through a seedable RNG so simulations are
 * deterministic and testable.
 *
 * Coordinate system: tile units. Column 0 is the left edge, row 0 is the TOP
 * (goal / food-truck row); the player starts on the bottom row. Entities use
 * continuous positions in tile units; the player's logical location is always
 * a tile, animated between tiles by a short hop.
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
    HOP_TIME: 0.12,        // seconds for a one-tile hop
    DASH_TILES: 3,         // max tiles covered by a dash
    DASH_TIME: 0.22,       // seconds for a full dash
    DASH_COST: 3,          // strawberries required; dash consumes the WHOLE stack
    SLOTH_GRACE: 4,        // seconds standing still before the penalty starts
    SLOTH_INTERVAL: 2,     // seconds between strawberry losses once slothful
    FLASH_IDLE_MIN: 2.5,   // photographer flash cycle: idle wait range
    FLASH_IDLE_MAX: 6.0,
    FLASH_CHARGE: 0.8,     // telegraph duration before the flash fires
    FLASH_ACTIVE: 0.25,    // window during which crossing the gap photobombs
    PHOTOBOMB_LOSS: 2,     // strawberries lost on a photobomb (capped at owned)
    PLAYER_HALF_W: 0.30,   // player hitbox half-extents, in tiles
    PLAYER_HALF_H: 0.30,
    NPC_HALF_H: 0.30,      // NPCs vary in width, share a height
    WRAP_MARGIN: 1.5       // how far off-grid NPCs travel before wrapping
  };

  // Per-type NPC tuning. halfW is the collision half-width in tiles.
  //  - posh: slow, wide (entitled amounts of personal space), fairly steady
  //  - wheelchair: steady speed, never stops or turns, slightly wide
  //  - kid: tiny hitbox but erratic — frequent turns, stops and sprints
  var NPC_TYPES = {
    posh: {
      halfW: 0.55, speedMin: 0.8, speedMax: 1.2,
      stopChance: 0.10, turnChance: 0.03, jitterMin: 0.75, jitterMax: 1.25,
      thinkMin: 1.2, thinkMax: 2.6
    },
    wheelchair: {
      halfW: 0.48, speedMin: 1.1, speedMax: 1.5,
      stopChance: 0, turnChance: 0, jitterMin: 1, jitterMax: 1,
      thinkMin: 2.0, thinkMax: 4.0
    },
    kid: {
      halfW: 0.22, speedMin: 1.4, speedMax: 2.0,
      stopChance: 0.15, turnChance: 0.15, jitterMin: 0.5, jitterMax: 2.2,
      thinkMin: 0.5, thinkMax: 1.4
    }
  };

  // ---------------------------------------------------------------------
  // Seedable RNG (mulberry32) — deterministic runs for tests and for
  // stable procedural decoration in the renderer.
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
  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  // ---------------------------------------------------------------------
  // Stage definitions (rows listed TOP to BOTTOM; first row must be the
  // goal, last the start). lane(dir, speed, count, mix): dir +1 = walking
  // right, -1 = walking left; speed in tiles/second; count = NPCs on the
  // lane's wrap-around loop; mix = allowed NPC types.
  // ---------------------------------------------------------------------
  function lane(dir, speed, count, mix) {
    return { kind: 'lane', dir: dir, speed: speed, count: count,
             mix: mix || ['posh', 'posh', 'wheelchair', 'kid'] };
  }
  var G = { kind: 'grass' };
  var GOAL = { kind: 'goal' };
  var START = { kind: 'start' };

  var STAGES = [
    {
      name: 'The Southern Lawn', cols: 13,
      rows: [GOAL, G,
             lane(1, 0.9, 3), lane(-1, 1.0, 3), G,
             lane(1, 1.0, 3), G,
             lane(-1, 0.9, 3), lane(1, 1.1, 3), G,
             G, START],
      berries: 8, photographerPairs: 1
    },
    {
      name: 'Henman Hill Hustle', cols: 13,
      rows: [GOAL, G,
             lane(-1, 1.1, 4), lane(1, 1.2, 4), G,
             lane(-1, 1.3, 4), lane(1, 1.0, 4), G,
             lane(1, 1.2, 4), lane(-1, 1.1, 4), G,
             G, START],
      berries: 8, photographerPairs: 1
    },
    {
      name: 'The Tea Terrace', cols: 13,
      rows: [GOAL, G,
             lane(1, 1.3, 5), lane(-1, 1.4, 4), G,
             lane(1, 1.5, 4), lane(-1, 1.2, 5), G,
             lane(-1, 1.4, 4), lane(1, 1.3, 5), G,
             lane(-1, 1.2, 4), G, START],
      berries: 9, photographerPairs: 2
    },
    {
      name: 'Schools Day Scramble', cols: 13,
      rows: [GOAL, G,
             lane(1, 1.4, 5, ['kid', 'kid', 'kid', 'posh']),
             lane(-1, 1.5, 5, ['kid', 'kid', 'wheelchair']), G,
             lane(1, 1.6, 4, ['kid', 'kid', 'posh']),
             lane(-1, 1.3, 5, ['kid', 'kid', 'kid']), G,
             lane(1, 1.5, 5, ['kid', 'posh', 'kid']),
             lane(-1, 1.6, 4, ['kid', 'kid', 'wheelchair']), G,
             G, START],
      berries: 10, photographerPairs: 2
    },
    {
      name: 'Centre Court Crush', cols: 13,
      rows: [GOAL, G,
             lane(-1, 1.6, 6), lane(1, 1.7, 5), G,
             lane(-1, 1.8, 5), lane(1, 1.5, 6), G,
             lane(1, 1.7, 5), lane(-1, 1.9, 5), G,
             lane(1, 1.6, 6), lane(-1, 1.7, 5), G, START],
      berries: 10, photographerPairs: 3
    }
  ];

  // ---------------------------------------------------------------------
  // Game construction
  // ---------------------------------------------------------------------
  function createGame(stageDef, seed) {
    var rng = makeRng(seed === undefined ? 1 : seed);
    var rows = stageDef.rows;
    var cols = stageDef.cols;

    var game = {
      stage: stageDef,
      cols: cols,
      numRows: rows.length,
      rng: rng,
      seed: seed === undefined ? 1 : seed,
      status: 'playing',          // 'playing' | 'stageClear' | 'dead'
      deathCause: null,
      time: 0,
      strawberries: 0,
      berriesCollected: 0,        // lifetime count this stage (score display)
      dashesUsed: 0,
      events: [],                 // drained by the shell for SFX/UI feedback
      player: null,
      npcs: [],
      photographers: [],          // pairs
      berries: [],
      blocked: {},                // "col,row" -> true (photographer tiles)
      slothTimer: 0,              // seconds since the player last hopped
      slothLossTimer: 0
    };

    var startRow = rows.length - 1;
    game.player = {
      col: Math.floor(cols / 2), row: startRow,   // logical tile
      x: Math.floor(cols / 2), y: startRow,       // continuous position
      px: Math.floor(cols / 2), py: startRow,     // previous position (render lerp)
      hop: null,                                  // {fromC,fromR,toC,toR,t,dur,dash}
      facing: 'up'
    };

    spawnNpcs(game);
    spawnPhotographers(game, stageDef.photographerPairs || 0);
    spawnBerries(game, stageDef.berries || 0);
    return game;
  }

  function spawnNpcs(game) {
    var rows = game.stage.rows;
    for (var r = 0; r < rows.length; r++) {
      var def = rows[r];
      if (def.kind !== 'lane') continue;
      var span = game.cols + 2 * C.WRAP_MARGIN;
      for (var i = 0; i < def.count; i++) {
        var type = pick(game.rng, def.mix);
        var t = NPC_TYPES[type];
        // Spread NPCs evenly around the wrap loop with a little jitter so a
        // lane never starts as an impassable wall.
        var x = -C.WRAP_MARGIN + (span * i) / def.count +
                rand(game.rng, 0, span / def.count * 0.5);
        game.npcs.push({
          type: type, row: r,
          x: x, px: x,
          dir: def.dir,
          baseSpeed: def.speed * rand(game.rng, t.speedMin, t.speedMax),
          speedMult: 1,
          halfW: t.halfW,
          mode: 'walk',            // 'walk' | 'stopped'
          modeT: 0,
          think: rand(game.rng, t.thinkMin, t.thinkMax)
        });
      }
    }
  }

  function spawnPhotographers(game, pairCount) {
    // Photographers stand on grass rows facing each other across a 2-tile
    // gap. Their own tiles are impassable; the gap tiles are the photobomb
    // danger zone while the flash is active.
    var rows = game.stage.rows;
    var grassRows = [];
    for (var r = 1; r < rows.length - 1; r++) {
      if (rows[r].kind === 'grass') grassRows.push(r);
    }
    var used = {};
    for (var p = 0; p < pairCount && grassRows.length; p++) {
      var row;
      do { row = pick(game.rng, grassRows); } while (used[row] && grassRows.length > 1);
      used[row] = true;
      var leftCol = randInt(game.rng, 1, game.cols - 5); // leaves room for gap+partner
      var rightCol = leftCol + 3;
      var danger = [leftCol + 1, leftCol + 2];
      game.photographers.push({
        row: row, leftCol: leftCol, rightCol: rightCol, dangerCols: danger,
        phase: 'idle',             // 'idle' -> 'charging' -> 'flash' -> 'idle'
        phaseT: rand(game.rng, C.FLASH_IDLE_MIN, C.FLASH_IDLE_MAX),
        bombed: false              // one photobomb max per flash
      });
      game.blocked[leftCol + ',' + row] = true;
      game.blocked[rightCol + ',' + row] = true;
    }
  }

  function spawnBerries(game, count) {
    var rows = game.stage.rows;
    var attempts = 0;
    while (game.berries.length < count && attempts < 500) {
      attempts++;
      var r = randInt(game.rng, 1, rows.length - 2); // never on goal/start rows
      var c = randInt(game.rng, 0, game.cols - 1);
      if (game.blocked[c + ',' + r]) continue;
      var clash = false;
      for (var i = 0; i < game.berries.length; i++) {
        if (game.berries[i].col === c && game.berries[i].row === r) { clash = true; break; }
      }
      if (!clash) game.berries.push({ col: c, row: r, alive: true });
    }
  }

  // ---------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------
  var DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function tileWalkable(game, col, row) {
    if (col < 0 || col >= game.cols || row < 0 || row >= game.numRows) return false;
    if (game.blocked[col + ',' + row]) return false;
    return true;
  }

  /**
   * Attempt a move. dir: 'up'|'down'|'left'|'right'; dash: boolean.
   * Returns true if the player started a hop. A dash needs a full stack of
   * DASH_COST strawberries and consumes ALL strawberries (full-stack rule).
   * Both are ignored mid-hop — one deliberate tap per hop.
   */
  function applyInput(game, dir, dash) {
    if (game.status !== 'playing') return false;
    var p = game.player;
    if (p.hop) return false;
    var d = DIRS[dir];
    if (!d) return false;
    p.facing = dir;

    if (dash) {
      if (game.strawberries < C.DASH_COST) return false;
      // Travel up to DASH_TILES, stopping before the first blocked tile.
      var steps = 0;
      for (var i = 1; i <= C.DASH_TILES; i++) {
        if (tileWalkable(game, p.col + d[0] * i, p.row + d[1] * i)) steps = i;
        else break;
      }
      if (steps === 0) return false; // wall in the way: keep the stack
      game.strawberries = 0;         // dash devours the whole stack
      game.dashesUsed++;
      startHop(game, p.col + d[0] * steps, p.row + d[1] * steps,
               C.DASH_TIME * steps / C.DASH_TILES, true);
      game.events.push({ type: 'dash', tiles: steps });
      return true;
    }

    if (!tileWalkable(game, p.col + d[0], p.row + d[1])) return false;
    startHop(game, p.col + d[0], p.row + d[1], C.HOP_TIME, false);
    return true;
  }

  function startHop(game, toC, toR, dur, isDash) {
    var p = game.player;
    p.hop = { fromC: p.col, fromR: p.row, toC: toC, toR: toR, t: 0, dur: dur, dash: isDash };
    p.col = toC; p.row = toR;          // logical tile updates immediately
    game.slothTimer = 0;               // moving resets the sloth clock
    game.slothLossTimer = 0;
  }

  // ---------------------------------------------------------------------
  // Simulation step — fixed dt (the shell calls this at 60 Hz)
  // ---------------------------------------------------------------------
  function step(game, dt) {
    if (game.status !== 'playing') return;
    game.time += dt;

    stepPlayer(game, dt);
    stepSloth(game, dt);
    stepNpcs(game, dt);
    stepPhotographers(game, dt);
    checkCollisions(game);
    if (game.status !== 'playing') return;

    // Win: any tile on the goal row.
    if (game.player.row === 0 && !game.player.hop) {
      game.status = 'stageClear';
      game.events.push({ type: 'stageClear' });
    }
  }

  function stepPlayer(game, dt) {
    var p = game.player;
    p.px = p.x; p.py = p.y;
    if (!p.hop) return;
    p.hop.t += dt;
    var k = Math.min(1, p.hop.t / p.hop.dur);
    p.x = p.hop.fromC + (p.hop.toC - p.hop.fromC) * k;
    p.y = p.hop.fromR + (p.hop.toR - p.hop.fromR) * k;
    if (k >= 1) {
      p.x = p.hop.toC; p.y = p.hop.toR;
      p.hop = null;
      collectBerry(game, p.col, p.row);
    }
  }

  function collectBerry(game, col, row) {
    for (var i = 0; i < game.berries.length; i++) {
      var b = game.berries[i];
      if (b.alive && b.col === col && b.row === row) {
        b.alive = false;
        game.strawberries++;
        game.berriesCollected++;
        game.events.push({ type: 'berry', count: game.strawberries });
        return;
      }
    }
  }

  function stepSloth(game, dt) {
    var p = game.player;
    if (p.hop) return;
    game.slothTimer += dt;
    if (game.slothTimer < C.SLOTH_GRACE) return;
    if (game.strawberries <= 0) return; // nothing left to lose, no extra penalty
    game.slothLossTimer += dt;
    if (game.slothLossTimer >= C.SLOTH_INTERVAL) {
      game.slothLossTimer -= C.SLOTH_INTERVAL;
      game.strawberries--;
      game.events.push({ type: 'slothLoss', count: game.strawberries });
    }
  }

  function stepNpcs(game, dt) {
    var t, npc;
    for (var i = 0; i < game.npcs.length; i++) {
      npc = game.npcs[i];
      npc.px = npc.x;
      t = NPC_TYPES[npc.type];

      // Behaviour brain: on each "think", maybe stop, turn, or change pace.
      npc.think -= dt;
      if (npc.think <= 0) {
        npc.think = rand(game.rng, t.thinkMin, t.thinkMax);
        var roll = game.rng();
        if (roll < t.stopChance) {
          npc.mode = 'stopped';
          npc.modeT = rand(game.rng, 0.4, 1.2);
        } else if (roll < t.stopChance + t.turnChance) {
          npc.dir = -npc.dir;
        } else {
          npc.speedMult = rand(game.rng, t.jitterMin, t.jitterMax);
        }
      }

      if (npc.mode === 'stopped') {
        npc.modeT -= dt;
        if (npc.modeT <= 0) npc.mode = 'walk';
        continue;
      }

      npc.x += npc.dir * npc.baseSpeed * npc.speedMult * dt;

      // Wrap around the lane loop (object pooling: NPCs are never
      // created/destroyed during play, just recycled across the edge).
      var lo = -C.WRAP_MARGIN, hi = game.cols - 1 + C.WRAP_MARGIN;
      if (npc.x > hi) { npc.x = lo; npc.px = lo; }
      else if (npc.x < lo) { npc.x = hi; npc.px = hi; }
    }
  }

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
      // Photobomb: player occupies a gap tile while the flash is live.
      if (ph.phase === 'flash' && !ph.bombed) {
        var pc = Math.round(game.player.x), pr = Math.round(game.player.y);
        if (pr === ph.row && ph.dangerCols.indexOf(pc) !== -1) {
          ph.bombed = true;
          var loss = Math.min(C.PHOTOBOMB_LOSS, game.strawberries);
          game.strawberries -= loss;
          game.events.push({ type: 'photobomb', lost: loss, count: game.strawberries });
        }
      }
    }
  }

  function checkCollisions(game) {
    var p = game.player;
    for (var i = 0; i < game.npcs.length; i++) {
      var npc = game.npcs[i];
      if (Math.abs(npc.row - p.y) >= C.NPC_HALF_H + C.PLAYER_HALF_H) continue;
      if (Math.abs(npc.x - p.x) < npc.halfW + C.PLAYER_HALF_W) {
        game.status = 'dead';
        game.deathCause = npc.type;
        game.events.push({ type: 'dead', cause: npc.type });
        return;
      }
    }
  }

  return {
    C: C,
    NPC_TYPES: NPC_TYPES,
    STAGES: STAGES,
    lane: lane,
    ROW: { GOAL: GOAL, GRASS: G, START: START },
    makeRng: makeRng,
    createGame: createGame,
    applyInput: applyInput,
    step: step,
    tileWalkable: tileWalkable
  };
});
