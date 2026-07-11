/*
 * Strawberry Rush — core game logic (v5: campaign, economy, loadout).
 *
 * Pure simulation module: no DOM, no canvas, no timers. The browser loads it
 * as a plain <script> (exposing window.GameLogic); Node requires it for unit
 * tests. All randomness flows through a seedable RNG so simulations are
 * deterministic and testable.
 *
 * v5 adds a full campaign layer on top of v4's free movement:
 *  - Strawberries are CURRENCY. A dash costs exactly DASH_COST (not the whole
 *    stack). The golden berry in every level banks +GOLD_VALUE.
 *  - 8 levels introduce one mechanic at a time (see LEVELS). Each has a
 *    `theme` (scenery, renderer-only) and `warmth` (0..1) — hotter levels
 *    physically slow the player unless countered by a passive/item.
 *  - A LOADOUT: one passive skill + two active items. Items are one-time-use
 *    shields (recharge each level); a bought upgrade makes them reusable.
 *    Passives are always-on stat buffs. Definitions live in PASSIVES/ITEMS.
 *  - New hazards: SECURITY guards (chase unless you carry accreditation) and
 *    TENNIS BALLS (dodge, or bat away with a racket).
 *
 * Coordinate system: tile units; integer coordinates are tile centers.
 * Column 0 is the left edge, row 0 is the TOP (goal / food-truck row); the
 * player starts on the bottom row. Terrain is a tile grid (authoring, pathing,
 * hazards); only the player moves continuously.
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
    HEAT_SLOW: 0.32,       // max fraction slowed at warmth = 1
    DASH_SPEED: 13,        // tiles/second during a dash burst
    DASH_TIME: 0.32,       // seconds a dash burst lasts (~4 tiles)
    DASH_COST: 3,          // strawberries a dash spends (fixed — currency)

    HEARTS: 3,             // base hits you can take (a passive can add one)
    HIT_BERRY_LOSS: 2,     // strawberries dropped when hit
    INVULN_TIME: 2.0,      // seconds of invulnerability after a hit respawn

    SLOTH_GRACE: 4,        // seconds standing still before the penalty starts
    SLOTH_INTERVAL: 2,     // seconds between strawberry losses once slothful

    FLASH_IDLE_MIN: 2.2,   // photographer flash cycle: idle wait range
    FLASH_IDLE_MAX: 5.0,
    FLASH_CHARGE: 0.8,     // telegraph duration before the flash fires
    FLASH_ACTIVE: 0.3,     // window during which crossing the gap photobombs
    PHOTOBOMB_LOSS: 2,     // strawberries lost on a photobomb (capped at owned)

    SPRINKLER_IDLE_MIN: 2.6,
    SPRINKLER_IDLE_MAX: 5.2,
    SPRINKLER_WARN: 1.1,
    SPRINKLER_SPRAY: 1.6,
    SPRINKLER_LOSS: 2,
    SPRINKLER_STUN: 0.8,

    FAN_AGGRO: 3.6, FAN_DEAF: 6.0, FAN_CHASE_SPEED: 3.0,
    SECURITY_AGGRO: 4.5, SECURITY_DEAF: 8.0, SECURITY_SPEED: 3.4,
    CALTROPS_RADIUS: 2.2, CALTROPS_SLOW: 0.35, // wheelchairs near you slow to 35%

    BALL_RADIUS: 0.28,     // tennis-ball collider
    BALL_SERVE_MIN: 1.6,   // per-court serve telegraph range
    BALL_SERVE_MAX: 3.2,
    BALL_SPEED: 6.5,       // default ball speed (levels can override)

    PLAYER_R: 0.30,        // player collision radius vs NPCs, in tiles
    BERRY_R: 0.45,         // pickup radius for strawberries
    GOLD_VALUE: 5,         // strawberries banked by the golden berry
    GROUP_RADIUS: 2.0      // wanderers drift back when this far from their group
  };

  // Per-type NPC tuning. radius = collision radius; turn = max heading change
  // per "think"; speed/jitter in tiles/second.
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
    security:   { radius: 0.44, speedMin: 1.6, speedMax: 1.9, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1,
                  thinkMin: 9, thinkMax: 9 },
    fan:        { radius: 0.32, speedMin: 0.8, speedMax: 1.0, turn: 1.4,
                  stopChance: 0.2, jitterMin: 0.8, jitterMax: 1.2,
                  thinkMin: 0.9, thinkMax: 1.8 },
    seated:     { radius: 0.30, speedMin: 0, speedMax: 0, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1,
                  thinkMin: 99, thinkMax: 99 },
    // Formation members move in lockstep across the screen (see stepMarcher).
    marcher:    { radius: 0.44, speedMin: 1, speedMax: 1, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1, thinkMin: 99, thinkMax: 99 },
    ballkid:    { radius: 0.26, speedMin: 1, speedMax: 1, turn: 0,
                  stopChance: 0, jitterMin: 1, jitterMax: 1, thinkMin: 99, thinkMax: 99 }
  };

  // ---------------------------------------------------------------------
  // LOADOUT: one passive + two active items. Costs are in strawberries.
  // These registries are shared by the shop UI and the effect logic.
  //
  //  passive: always-on. `speedMul`, `heatResist` (0..1 of heat cancelled),
  //           `bonusHearts`, `rugImmune`, `dashRefund` (berries back per dash).
  //  item.mode 'charge': a one-time save vs `counters`, refilled each level;
  //           the upgrade makes it reusable (infinite charges per level).
  //  item.mode 'aura': a continuous effect while equipped; the upgrade widens
  //           it (documented per item in the Handbook).
  // ---------------------------------------------------------------------
  var PASSIVES = {
    none:    { name: 'None', cost: 0, desc: 'No passive equipped.' },
    speed:   { name: 'Fresh Legs', cost: 16, speedMul: 1.16,
               desc: 'Move 16% faster everywhere.' },
    linen:   { name: 'Linen Whites', cost: 16, heatResist: 0.7,
               desc: 'Cancels 70% of warm-day slowdown.' },
    heart:   { name: 'Iron Constitution', cost: 34, bonusHearts: 1,
               desc: 'Start every level with a 4th heart.' },
    surefoot:{ name: 'Sure-Footed', cost: 20, rugImmune: true,
               desc: 'Picnic rugs no longer slow you down.' },
    thrift:  { name: 'Thrifty Dasher', cost: 24, dashRefund: 1,
               desc: 'Every dash refunds 1 🍓 (net cost 2).' }
  };

  var ITEMS = {
    racket:    { name: 'Tennis Racket', cost: 12, mode: 'charge', counters: 'ball',
                 upgradeCost: 18, upgradeName: 'Carbon Racket',
                 desc: 'Bat away a tennis ball instead of taking the hit.',
                 upgradeDesc: 'Reusable — bat away every ball, all level.' },
    lollipop:  { name: 'Lollipop', cost: 10, mode: 'charge', counters: 'kid',
                 upgradeCost: 14, upgradeName: 'Giant Gobstopper',
                 desc: 'Survive a charging child (they stop for the sweet).',
                 upgradeDesc: 'Reusable — every kid collision is survived.' },
    umbrella:  { name: 'Umbrella', cost: 10, mode: 'charge', counters: 'sprinkler',
                 upgradeCost: 14, upgradeName: 'Golf Umbrella',
                 desc: 'Shrug off one sprinkler soaking (no loss, no stun).',
                 upgradeDesc: 'Reusable — stay dry through every sprinkler.' },
    sunglasses:{ name: 'Sunglasses', cost: 14, mode: 'aura', counters: 'flash',
                 upgradeCost: 16, upgradeName: 'Polarised Shades',
                 desc: 'Photographer flashes never cost you strawberries.',
                 upgradeDesc: 'Also shrug off the blinding dazzle entirely.' },
    accred:    { name: 'Accreditation', cost: 20, mode: 'aura', counters: 'security',
                 upgradeCost: 22, upgradeName: 'AAA Pass',
                 desc: 'Security guards ignore you instead of chasing.',
                 upgradeDesc: 'Autograph fans lose interest in you too.' },
    caltrops:  { name: 'Caltrops', cost: 12, mode: 'aura', counters: 'wheelchair',
                 upgradeCost: 16, upgradeName: 'Spike Strip',
                 desc: 'Nearby wheelchair users slow right down.',
                 upgradeDesc: 'Wider radius, and it slows sprinting kids too.' }
  };

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
  // Level authoring helpers keep the 8 definitions terse and consistent.
  // Every zone spans a row band; hedges between them get 2-tile gates.
  // ---------------------------------------------------------------------
  function zonesFor(rows, names) {
    // Split the playable rows (1..rows-2) into evenly-sized zone bands with
    // a 1-row hedge gap between each. Thresholds are set per band.
    var n = names.length;
    var top = 1, bottom = rows - 2;              // start row (rows-1) stays open
    var span = bottom - top + 1;
    var band = Math.floor((span - (n - 1)) / n); // rows per zone, minus gaps
    var zones = [], hedgeRows = [];
    var r = top;
    for (var i = 0; i < n; i++) {
      var rowMin = r, rowMax = (i === n - 1) ? bottom : r + band - 1;
      zones.push({ name: names[i], rowMin: rowMin, rowMax: rowMax,
                   threshold: i === n - 1 ? null : rowMax,
                   ground: 'grass', speedScale: 1 });
      if (i < n - 1) { hedgeRows.push(rowMax + 1); r = rowMax + 2; }
    }
    return { zones: zones, hedgeRows: hedgeRows };
  }

  // ---------------------------------------------------------------------
  // LEVEL GENERATOR. Levels are grown procedurally from a compact spec so
  // they can be long, endless, and consistently balanced. The 10 ranked
  // levels use fixed seeds (identical for every player — fair leaderboard);
  // endless mode reuses the same generator with a run-derived seed.
  //
  // Placement is validated: hedge gates are always open (2 tiles wide, one
  // left + one right), point hazards are sparse and never seal a row, walls
  // are short partial segments off the hedge rows, and patrols are laid only
  // on rows with a long clear run — so connectivity and patrol-clearance
  // hold by construction (a BFS relaxation pass is a final safety net).
  // ---------------------------------------------------------------------
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1)), t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function pickGates(rng, cols) {
    var half = Math.floor(cols / 2);
    var g1 = 1 + Math.floor(rng() * Math.max(1, half - 3));
    var g2 = half + 1 + Math.floor(rng() * Math.max(1, cols - 4 - half));
    g1 = Math.max(1, Math.min(g1, half - 2));
    g2 = Math.max(half + 1, Math.min(g2, cols - 3));
    return [g1, g1 + 1, g2, g2 + 1];
  }

  function placeWall(rng, occ, hedgeSet, rows, cols) {
    for (var t = 0; t < 24; t++) {
      var r = 3 + Math.floor(rng() * (rows - 6));
      if (hedgeSet[r]) continue;
      var len = 3 + Math.floor(rng() * 4);       // 3..6 tiles
      if (len > cols - 9) continue;              // always leave a wide opening
      var side = rng() < 0.5 ? 0 : 1;
      var c0 = side ? (cols - 1 - len - Math.floor(rng() * 2)) : Math.floor(rng() * 2);
      c0 = Math.max(0, Math.min(cols - 1 - len, c0));
      var ok = true;
      for (var c = c0; c <= c0 + len; c++) { if (occ[r][c]) { ok = false; break; } }
      if (!ok) continue;
      for (var c2 = c0; c2 <= c0 + len; c2++) occ[r][c2] = 1;
      return { row: r, c0: c0, c1: c0 + len };
    }
    return null;
  }

  function placePoints(rng, occ, hedgeSet, rows, cols, count, cb) {
    var placed = 0, tries = 0;
    while (placed < count && tries < count * 40 + 40) {
      tries++;
      var r = 2 + Math.floor(rng() * (rows - 4));
      var c = 1 + Math.floor(rng() * (cols - 2));
      if (hedgeSet[r] || occ[r][c]) continue;
      occ[r][c] = 1; cb(c, r); placed++;
    }
  }

  function placePhotographer(rng, occ, hedgeSet, rows, cols) {
    for (var t = 0; t < 40; t++) {
      var r = 2 + Math.floor(rng() * (rows - 4));
      if (hedgeSet[r]) continue;
      var lc = 1 + Math.floor(rng() * (cols - 5));
      if (occ[r][lc] || occ[r][lc + 1] || occ[r][lc + 2] || occ[r][lc + 3]) continue;
      occ[r][lc] = 1; occ[r][lc + 3] = 1;
      return { row: r, leftCol: lc };
    }
    return null;
  }

  function placeCourt(rng, zones, cols, idx, balls, speed) {
    var zi = Math.min(zones.length - 1, idx + Math.floor(rng() * Math.max(1, zones.length - 1)));
    var z = zones[zi];
    var h = Math.min(5, z.rowMax - z.rowMin);
    if (h < 3) return null;
    var rowMin = z.rowMin + Math.floor(rng() * Math.max(1, z.rowMax - z.rowMin - h));
    rowMin = Math.max(1, Math.min(rowMin, z.rowMax - h));
    return { colMin: 2, colMax: cols - 3, rowMin: rowMin, rowMax: rowMin + h, balls: balls, speed: speed };
  }

  function placeBlanket(rng, occ, zones, hedgeSet, rows, cols) {
    for (var t = 0; t < 30; t++) {
      var z = zones[Math.floor(rng() * zones.length)];
      if (z.ground === 'path') continue;
      var w = 2 + Math.floor(rng() * 2), h = 1 + Math.floor(rng() * 2);
      var c = 1 + Math.floor(rng() * Math.max(1, cols - 2 - w));
      var r = z.rowMin + Math.floor(rng() * Math.max(1, z.rowMax - z.rowMin - h));
      var ok = true;
      for (var rr = r; rr < r + h && ok; rr++) {
        if (hedgeSet[rr]) { ok = false; break; }
        for (var cc = c; cc < c + w; cc++) { if (occ[rr][cc]) { ok = false; break; } }
      }
      if (!ok) continue;
      return { col: c, row: r, w: w, h: h };
    }
    return null;
  }

  function longestRun(occ, r, cols) {
    var best = null, bs = 0, s = -1;
    for (var c = 0; c <= cols; c++) {
      if (c < cols && occ[r][c] === 0) { if (s < 0) s = c; }
      else { if (s >= 0) { var len = c - s; if (len > bs) { bs = len; best = [s, c - 1]; } } s = -1; }
    }
    return best;
  }

  function findClearPatrol(rng, occ, hedgeSet, zones, cols, minLen) {
    var rowsList = [];
    zones.forEach(function (z) { for (var r = z.rowMin; r <= z.rowMax; r++) if (!hedgeSet[r]) rowsList.push(r); });
    shuffle(rowsList, rng);
    for (var i = 0; i < rowsList.length; i++) {
      var run = longestRun(occ, rowsList[i], cols);
      if (run && (run[1] - run[0] + 1) >= minLen) {
        var c0 = run[0] + 1, c1 = run[1] - 1;
        if (c1 - c0 + 1 >= minLen - 2) return { row: rowsList[i], c0: c0, c1: c1 };
      }
    }
    return null;
  }

  // A big crowd crossing in formation — 2-3 rows deep with a 2-wide gap
  // corridor you must slot into and track as it slides across.
  function addFormation(rng, zones, cols, npcs) {
    var zi = Math.max(0, Math.min(zones.length - 2, 1 + Math.floor(rng() * Math.max(1, zones.length - 2))));
    var z = zones[zi];
    var bandRows = [], r0 = z.rowMin + 1;
    for (var r = r0; r <= Math.min(z.rowMax - 1, r0 + 1); r++) bandRows.push(r); // 2 rows deep
    if (bandRows.length < 1) return;
    var dir = rng() < 0.5 ? 1 : -1;
    var speed = 0.9 + rng() * 0.3;                          // slow enough to read
    var spacing = 1.6, slots = Math.ceil((cols + 3) / spacing);
    var gap = 1 + Math.floor(rng() * Math.max(1, slots - 4));
    for (var s = 0; s < slots; s++) {
      if (s >= gap && s <= gap + 2) continue;              // a generous 3-wide corridor
      var x = -1.5 + s * spacing;
      for (var b = 0; b < bandRows.length; b++) npcs.push({ type: 'marcher', col: x, row: bandRows[b], dir: dir, speed: speed });
    }
  }

  // A line of six ball kids in matching green or purple, jogging across.
  function addBallkidLine(rng, zones, cols, npcs) {
    var z = zones[Math.floor(rng() * zones.length)];
    var r = z.rowMin + Math.floor(rng() * (z.rowMax - z.rowMin + 1));
    var dir = rng() < 0.5 ? 1 : -1;
    var speed = 1.8 + rng() * 0.5;
    var uniform = rng() < 0.5 ? 'green' : 'purple';
    var spacing = 1.4, base = 1 + rng() * Math.max(1, cols - 8);
    for (var k = 0; k < 6; k++) npcs.push({ type: 'ballkid', col: base + k * spacing, row: r, dir: dir, speed: speed, uniform: uniform });
  }

  function placeFan(rng, occ, zones, hedgeSet, cols) {
    for (var t = 0; t < 30; t++) {
      var z = zones[Math.floor(rng() * zones.length)];
      var r = z.rowMin + Math.floor(rng() * (z.rowMax - z.rowMin + 1));
      var c = 1 + Math.floor(rng() * (cols - 2));
      if (hedgeSet[r] || occ[r][c]) continue;
      return { type: 'fan', col: c, row: r, rowMin: z.rowMin, rowMax: z.rowMax };
    }
    return null;
  }

  function findClearTile(occ, hedgeSet, rMin, rMax, cols, rng, preferCorner) {
    if (preferCorner) {
      var corners = [[0, rMin], [cols - 1, rMin], [0, rMin + 1], [cols - 1, rMin + 1]];
      for (var i = 0; i < corners.length; i++) {
        var c = corners[i][0], r = corners[i][1];
        if (!hedgeSet[r] && !occ[r][c]) return { col: c, row: r };
      }
    }
    for (var t = 0; t < 200; t++) {
      var r2 = rMin + Math.floor(rng() * (rMax - rMin + 1)), c2 = Math.floor(rng() * cols);
      if (!hedgeSet[r2] && !occ[r2][c2]) return { col: c2, row: r2 };
    }
    return { col: 0, row: 1 };
  }

  function terrainConnected(def) {
    var terrain = buildTerrain(def), rows = def.rows, cols = def.cols;
    var seen = {}, q = [[def.startCol, def.startRow]];
    seen[def.startCol + ',' + def.startRow] = 1;
    while (q.length) {
      var p = q.shift();
      if (p[1] === 0) return true;
      var dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (var i = 0; i < 4; i++) {
        var nc = p[0] + dirs[i][0], nr = p[1] + dirs[i][1], k = nc + ',' + nr;
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        if (!seen[k] && terrain[nr][nc].block === null) { seen[k] = 1; q.push([nc, nr]); }
      }
    }
    return false;
  }

  function genLevel(spec) {
    var cols = spec.cols, rows = spec.rows;
    var rng = makeRng(spec.seed >>> 0);
    var zh = zonesFor(rows, spec.zoneNames);
    var zones = zh.zones, hedgeRows = zh.hedgeRows;
    var hedgeSet = {}; hedgeRows.forEach(function (r) { hedgeSet[r] = 1; });
    (spec.pathZones || []).forEach(function (zi) { if (zones[zi]) zones[zi].ground = 'path'; });
    zones.forEach(function (z, i) {
      var t = (zones.length - 1 - i) / Math.max(1, zones.length - 1); // 0 bottom .. 1 top
      z.speedScale = 0.9 + 0.35 * t + (spec.speedBump || 0);
    });

    var occ = []; for (var r = 0; r < rows; r++) { var row = []; for (var c = 0; c < cols; c++) row.push(0); occ.push(row); }
    var hedges = hedgeRows.map(function (hr) {
      var gaps = pickGates(rng, cols);
      for (var cc = 0; cc < cols; cc++) if (gaps.indexOf(cc) === -1) occ[hr][cc] = 1;
      return { row: hr, gaps: gaps };
    });

    var m = spec.mechanics || {};
    var walls = [];
    for (var wi = 0; wi < (m.walls || 0); wi++) { var wl = placeWall(rng, occ, hedgeSet, rows, cols); if (wl) walls.push(wl); }
    var trees = [];
    placePoints(rng, occ, hedgeSet, rows, cols, m.trees || 0, function (c2, r2) { trees.push({ col: c2, row: r2, kind: 'tree' }); });
    placePoints(rng, occ, hedgeSet, rows, cols, m.umbrellas || 0, function (c2, r2) { trees.push({ col: c2, row: r2, kind: 'umbrella' }); });
    var sprinklers = [];
    placePoints(rng, occ, hedgeSet, rows, cols, m.sprinklers || 0, function (c2, r2) { sprinklers.push({ col: c2, row: r2 }); });
    var photographers = [];
    for (var pi = 0; pi < (m.photographers || 0); pi++) { var ph = placePhotographer(rng, occ, hedgeSet, rows, cols); if (ph) photographers.push(ph); }
    var tennisCourts = [];
    for (var ci = 0; ci < (m.courtCount || 0); ci++) { var ct = placeCourt(rng, zones, cols, ci, m.ballsPerCourt || 2, m.ballSpeed || 6.5); if (ct) tennisCourts.push(ct); }

    var blankets = [], seated = [];
    for (var bi = 0; bi < (m.rugs || 0); bi++) {
      var bl = placeBlanket(rng, occ, zones, hedgeSet, rows, cols);
      if (!bl) continue;
      blankets.push(bl);
      var sn = 2 + (rng() < 0.5 ? 1 : 0);
      for (var si = 0; si < sn; si++) {
        seated.push({ type: 'seated', col: bl.col + 0.4 + (si % bl.w) * 0.9, row: bl.row + 0.4 + Math.floor(si / bl.w) * 0.9 });
      }
    }

    var npcs = [];
    zones.forEach(function (z, i) {
      // Roaming crowd — roughly doubled to fill the now-much-bigger grounds.
      var groups = 2 + (rng() < 0.6 ? 1 : 0) + (m.crowd > 1 ? 1 : 0);
      for (var g = 0; g < groups; g++) npcs.push({ type: 'posh', count: 3, rowMin: z.rowMin, rowMax: z.rowMax, group: 'p' + i + '_' + g });
      // A generous helping of loose slow-moving picnickers everywhere.
      npcs.push({ type: 'posh', count: 4 + 2 * (m.slowExtra || 0), rowMin: z.rowMin, rowMax: z.rowMax });
      if (m.wheelchairs) npcs.push({ type: 'wheelchair', count: 2 + (rng() < 0.5 ? 1 : 0), rowMin: z.rowMin, rowMax: z.rowMax });
      if (m.kids) {
        npcs.push({ type: 'kid', count: 3, rowMin: z.rowMin, rowMax: z.rowMax, group: 'k' + i + 'a' });
        if (rng() < 0.7) npcs.push({ type: 'kid', count: 3, rowMin: z.rowMin, rowMax: z.rowMax, group: 'k' + i + 'b' });
      }
    });
    seated.forEach(function (s) { npcs.push(s); });
    for (var fi = 0; fi < (m.fans || 0); fi++) { var fn = placeFan(rng, occ, zones, hedgeSet, cols); if (fn) npcs.push(fn); }
    for (var stw = 0; stw < (m.stewards || 0); stw++) { var pr = findClearPatrol(rng, occ, hedgeSet, zones, cols, 7); if (pr) npcs.push({ type: 'steward', waypoints: [[pr.c0, pr.row], [pr.c1, pr.row]] }); }
    for (var scy = 0; scy < (m.security || 0); scy++) { var pr2 = findClearPatrol(rng, occ, hedgeSet, zones, cols, 7); if (pr2) npcs.push({ type: 'security', waypoints: [[pr2.c0, pr2.row], [pr2.c1, pr2.row]] }); }
    // Late-game "crossing crowd" formations and lines of ball kids.
    for (var ff = 0; ff < (m.formations || 0); ff++) addFormation(rng, zones, cols, npcs);
    for (var bkl = 0; bkl < (m.ballkidLines || 0); bkl++) addBallkidLine(rng, zones, cols, npcs);

    // Golden berry: a RANDOM clear tile anywhere in the final (top) zone —
    // the "end section" the player crosses last — so it's not always a corner.
    var endZone = zones[0];
    var gb = findClearTile(occ, hedgeSet, 1, endZone.rowMax, cols, rng, false);

    var def = {
      name: spec.name, intro: spec.intro || '', theme: spec.theme, warmth: spec.warmth,
      truckColorIndex: spec.truckColorIndex || 0,
      cols: cols, rows: rows, startCol: spec.startCol, startRow: rows - 1,
      zones: zones, hedges: hedges, walls: walls, barriers: [], trees: trees, blankets: blankets,
      sprinklers: sprinklers, photographers: photographers, tennisCourts: tennisCourts,
      npcs: npcs, berryCount: spec.berryCount || Math.round(rows * 0.6), goldenBerry: gb
    };
    // Safety net: relax the two blocking hazard classes if anything sealed the path.
    if (!terrainConnected(def)) def.walls = [];
    if (!terrainConnected(def)) def.photographers = [];
    return def;
  }

  // ---- ranked campaign: 10 fixed-seed levels, each ~2x the old length ----
  var THEME_ARR = ['dawn', 'morning', 'midday', 'noon', 'afternoon', 'goldenhour', 'dusk', 'dusk', 'night', 'night'];
  var WARMTH_ARR = [0.0, 0.15, 0.35, 0.85, 0.6, 0.35, 0.2, 0.15, 0.1, 0.05];
  var NAME_ARR = ['The Garden Gate', 'The Long Lawn', 'The Children’s Field', 'The Midday Concourse',
    'The Members’ Enclosure', 'The Practice Courts', 'The Terrace Gauntlet', 'Centre Court',
    'The Semi-Final', 'The Champions’ Gala'];
  var INTRO_ARR = [
    'Just the crowd — genteel folk wandering and changing direction.',
    'New: picnic rugs slow your step, and a sprinkler starts up.',
    'New: children — tiny, fast, and utterly unpredictable.',
    'New: photographers’ flashes and patrolling stewards — and midday heat slows you.',
    'New: autograph fans give chase, and security guards hunt anyone without a pass.',
    'New: live tennis — flying balls will bowl you over. Bring a racket.',
    'Everything at once now, and the grounds keep getting longer.',
    'Dense crowds, balls, flashes and patrols across the show court.',
    'The penultimate test — every hazard, at pace.',
    'The floodlit finale. Good luck.'
  ];
  var ZONE_POOL = ['The Forecourt', 'The Queue', 'Garden Gate', 'The Terrace', 'The Concourse',
    'Members’ Lawn', 'Rose Walk', 'Trophy Walk', 'Centre Court', 'Champions’ Lawn'];
  function zoneNamesFor(count) {
    var names = ZONE_POOL.slice(-count);
    return names.slice().reverse(); // top-down: finale zone first
  }
  function rankedMechanics(n) {
    return {
      trees: 3 + (n >> 2), umbrellas: 1 + (n >= 5 ? 1 : 0),
      walls: n >= 8 ? 3 : (n >= 6 ? 2 : 0),
      rugs: n >= 1 ? 2 + (n >> 2) : 0,
      sprinklers: n >= 1 ? Math.min(1 + (n >> 1), 6) : 0,
      wheelchairs: n >= 1, kids: n >= 2,
      photographers: n >= 3 ? Math.min(2 + (n >> 2), 6) : 0,
      stewards: n >= 3 ? 1 + (n >= 6 ? 1 : 0) : 0,
      fans: n >= 4 ? 1 + (n >= 7 ? 1 : 0) : 0,
      security: n >= 4 ? 1 + (n >> 2) : 0,
      courtCount: n >= 5 ? (n >= 7 ? 2 : 1) : 0,
      ballsPerCourt: 2, ballSpeed: 6.0 + n * 0.14,
      crowd: 1 + (n >= 5 ? 1 : 0),
      slowExtra: Math.min(1 + (n >> 2), 2),             // more slow walkers, capped
      formations: n >= 7 ? 1 : 0,                       // one "end of game" crossing crowd (L8+)
      ballkidLines: (n >= 5 ? 1 : 0) + (n >= 8 ? 1 : 0) // lines of ball kids (L6+)
    };
  }
  var RANKED_SPECS = [];
  for (var _n = 0; _n < 10; _n++) {
    var _rows = 44 + _n * 3;
    var _zc = Math.max(3, Math.min(7, Math.round(_rows / 11)));
    RANKED_SPECS.push({
      name: NAME_ARR[_n], intro: INTRO_ARR[_n], theme: THEME_ARR[_n], warmth: WARMTH_ARR[_n],
      cols: 21, rows: _rows, startCol: 10, zoneNames: zoneNamesFor(_zc),
      pathZones: _n >= 3 ? [1] : [], speedBump: 0.03 * _n,
      mechanics: rankedMechanics(_n), seed: 1000 + _n * 97,
      berryCount: Math.round(_rows * 0.6), truckColorIndex: _n
    });
  }
  var LEVELS = RANKED_SPECS.map(genLevel);

  // ---- endless mode: same generator, run-derived seed, untracked ----
  function makeEndlessSpec(n, seed) {
    var rows = Math.min(46 + n * 2, 84);
    var zc = Math.max(4, Math.min(8, Math.round(rows / 11)));
    var diff = Math.min(4 + n, 9);
    return {
      name: 'Endless ' + n, intro: 'A freshly-grown ground — nothing is tracked out here.',
      theme: THEME_ARR[(n - 1 + THEME_ARR.length) % THEME_ARR.length],
      warmth: [0.1, 0.3, 0.6, 0.85, 0.4][n % 5],
      cols: 21, rows: rows, startCol: 10, zoneNames: zoneNamesFor(zc),
      pathZones: [1], speedBump: 0.02 * Math.min(n, 10),
      mechanics: rankedMechanics(diff), seed: (seed ^ Math.imul(n, 2654435761)) >>> 0,
      berryCount: Math.round(rows * 0.6), truckColorIndex: (n - 1)
    };
  }
  function generateEndless(n, seed) { return genLevel(makeEndlessSpec(n, seed === undefined ? 12345 : seed)); }

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
      for (c = 0; c < def.cols; c++) terrain[r].push({ t: ground, block: null });
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
    (def.trees || []).forEach(function (t) { terrain[t.row][t.col].block = t.kind; });
    (def.blankets || []).forEach(function (b) {
      for (r = b.row; r < b.row + (b.h || 1); r++) {
        for (c = b.col; c < b.col + (b.w || 1); c++) {
          if (!terrain[r][c].block) terrain[r][c].t = 'blanket';
        }
      }
    });
    (def.sprinklers || []).forEach(function (s) { terrain[s.row][s.col].block = 'sprinkler'; });
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
  // Loadout helpers
  // ---------------------------------------------------------------------
  function normalizeLoadout(loadout) {
    var lo = loadout || {};
    var items = (lo.items || []).filter(function (k) { return ITEMS[k]; }).slice(0, 2);
    return {
      passive: PASSIVES[lo.passive] ? lo.passive : 'none',
      items: items,
      upgraded: lo.upgraded || {}   // { itemKey: true }
    };
  }
  function passiveDef(game) { return PASSIVES[game.loadout.passive] || PASSIVES.none; }
  function hasItem(game, key) { return game.loadout.items.indexOf(key) !== -1; }
  function itemUpgraded(game, key) { return !!game.loadout.upgraded[key]; }
  function itemReady(game, key) {
    // A charge item is "ready" while it has charges (or is upgraded/reusable).
    if (!hasItem(game, key)) return false;
    if (itemUpgraded(game, key)) return true;
    return (game.itemCharges[key] || 0) > 0;
  }
  function consumeCharge(game, key) {
    if (itemUpgraded(game, key)) { game.events.push({ type: 'itemUsed', key: key, reusable: true }); return; }
    game.itemCharges[key] = Math.max(0, (game.itemCharges[key] || 0) - 1);
    game.events.push({ type: 'itemUsed', key: key, left: game.itemCharges[key] });
  }
  function initCharges(game) {
    game.itemCharges = {};
    game.loadout.items.forEach(function (key) {
      if (ITEMS[key].mode === 'charge') {
        game.itemCharges[key] = itemUpgraded(game, key) ? Infinity : 1;
      }
    });
  }

  // ---------------------------------------------------------------------
  // Game construction
  // ---------------------------------------------------------------------
  function createGame(levelDef, seed, loadout) {
    var def = levelDef || LEVELS[0];
    var rng = makeRng(seed === undefined ? 1 : seed);

    var game = {
      level: def,
      cols: def.cols,
      numRows: def.rows,
      warmth: def.warmth || 0,
      terrain: buildTerrain(def),
      rng: rng,
      seed: seed === undefined ? 1 : seed,
      status: 'playing',
      deathCause: null,
      time: 0,
      hearts: C.HEARTS,
      invuln: 0,
      strawberries: 0,
      berriesCollected: 0,
      dashesUsed: 0,
      events: [],
      loadout: normalizeLoadout(loadout),
      itemCharges: {},
      player: null,
      npcs: [],
      photographers: [],
      sprinklers: [],
      balls: [],
      courts: (def.tennisCourts || []).map(function (c) { return c; }),
      berries: [],
      checkpoint: { col: def.startCol, row: def.startRow },
      checkpointStage: 0,
      slothTimer: 0,
      slothLossTimer: 0
    };

    game.hearts = C.HEARTS + (passiveDef(game).bonusHearts || 0);
    initCharges(game);

    game.player = {
      x: def.startCol, y: def.startRow,
      px: def.startCol, py: def.startRow,
      col: def.startCol, row: def.startRow,
      lastRow: def.startRow,
      moveX: 0, moveY: 0,
      dirX: 0, dirY: -1,
      dash: null,
      moving: false,
      stun: 0
    };

    spawnNpcs(game, def);
    spawnPhotographers(game, def);
    spawnSprinklers(game, def);
    spawnBalls(game, def);
    spawnBerries(game, def);
    return game;
  }

  function isBlockedAt(game, col, row) {
    if (col < 0 || col >= game.cols || row < 0 || row >= game.numRows) return true;
    return game.terrain[row][col].block !== null;
  }
  function tileWalkable(game, col, row) { return !isBlockedAt(game, col, row); }

  function spawnNpcs(game, def) {
    (def.npcs || []).forEach(function (spec) {
      var t = NPC_TYPES[spec.type];
      var zone = spec.rowMin !== undefined ? zoneForRow(def, spec.rowMin) : null;
      var scale = spec.speedScale || (zone ? zone.speedScale : 1);

      if (spec.type === 'steward' || spec.type === 'security') {
        game.npcs.push({
          type: spec.type,
          x: spec.waypoints[0][0], y: spec.waypoints[0][1],
          px: spec.waypoints[0][0], py: spec.waypoints[0][1],
          waypoints: spec.waypoints, wpIndex: 1,
          speed: rand(game.rng, t.speedMin, t.speedMax) * scale,
          heading: 0, radius: t.radius, group: null,
          chasing: false,
          yMin: 0, yMax: game.numRows - 1
        });
        return;
      }

      // Pre-expanded formation members: a single instance per spec, moving
      // horizontally across the grounds in lockstep with its formation.
      if (spec.type === 'marcher' || spec.type === 'ballkid') {
        game.npcs.push({
          type: spec.type, x: spec.col, y: spec.row, px: spec.col, py: spec.row,
          dir: spec.dir, speed: spec.speed, radius: t.radius,
          uniform: spec.uniform || null, heading: spec.dir > 0 ? 0 : Math.PI,
          group: null, yMin: spec.row, yMax: spec.row, chasing: false, mode: 'walk'
        });
        return;
      }

      var count = spec.count || 1;
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
            x = Math.max(0.5, Math.min(game.cols - 1.5, anchorX + rand(game.rng, -1, 1)));
            y = Math.max(spec.rowMin, Math.min(spec.rowMax, anchorY + rand(game.rng, -1, 1)));
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
          type: spec.type, x: x, y: y, px: x, py: y,
          heading: rand(game.rng, 0, Math.PI * 2),
          baseSpeed: rand(game.rng, t.speedMin, t.speedMax) * scale,
          speed: 0, radius: t.radius, group: spec.group || null,
          yMin: spec.rowMin !== undefined ? spec.rowMin : y,
          yMax: spec.rowMax !== undefined ? spec.rowMax : y,
          mode: 'walk', modeT: 0, chasing: false,
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
        col: s.col, row: s.row, phase: 'idle',
        phaseT: rand(game.rng, C.SPRINKLER_IDLE_MIN, C.SPRINKLER_IDLE_MAX),
        soaked: false
      });
    });
  }

  function spawnBalls(game, def) {
    (def.tennisCourts || []).forEach(function (court, ci) {
      var n = court.balls || 1;
      for (var i = 0; i < n; i++) {
        var ang = rand(game.rng, 0.4, Math.PI - 0.4) * (i % 2 ? 1 : -1);
        var sp = court.speed || C.BALL_SPEED;
        game.balls.push({
          court: court, ci: ci,
          x: rand(game.rng, court.colMin + 1, court.colMax - 1),
          y: rand(game.rng, court.rowMin + 0.5, court.rowMax - 0.5),
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
          serve: rand(game.rng, C.BALL_SERVE_MIN, C.BALL_SERVE_MAX) // telegraph before first flight
        });
      }
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
  function setMove(game, dx, dy) {
    var p = game.player;
    var m = Math.sqrt(dx * dx + dy * dy);
    if (m > 1e-6) {
      p.moveX = dx / m; p.moveY = dy / m;
      p.dirX = p.moveX; p.dirY = p.moveY;
    } else { p.moveX = 0; p.moveY = 0; }
  }

  /**
   * Dash in the direction the player ASKED for (dx, dy) — the key/gesture
   * that triggered the dash — not whatever way they happened to be moving.
   * Falls back to the current facing when no direction is supplied.
   */
  function tryDash(game, dx, dy) {
    if (game.status !== 'playing') return false;
    var p = game.player;
    if (p.stun > 0 || p.dash) return false;
    if (game.strawberries < C.DASH_COST) return false;
    var m = Math.sqrt((dx || 0) * (dx || 0) + (dy || 0) * (dy || 0));
    var ux, uy;
    if (m > 1e-6) { ux = dx / m; uy = dy / m; }
    else { ux = p.dirX; uy = p.dirY; if (!ux && !uy) { ux = 0; uy = -1; } }
    game.strawberries -= C.DASH_COST;
    game.strawberries += (passiveDef(game).dashRefund || 0);
    game.dashesUsed++;
    p.dirX = ux; p.dirY = uy;                 // dashing turns you to face that way
    p.dash = { t: 0, dur: C.DASH_TIME, dx: ux, dy: uy };
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
    stepBalls(game, dt);
    checkCollisions(game);
    if (game.status !== 'playing') return;

    if (game.player.y <= 0.35) {
      game.status = 'won';
      game.events.push({ type: 'won', time: game.time, berries: game.berriesCollected });
    }
  }

  function circleBlocked(game, x, y) {
    var r = C.PLAYER_R * 0.9;
    var c0 = Math.round(x - r), c1 = Math.round(x + r);
    var r0 = Math.round(y - r), r1 = Math.round(y + r);
    for (var rr = r0; rr <= r1; rr++) {
      for (var cc = c0; cc <= c1; cc++) {
        if (isBlockedAt(game, cc, rr)) return true;
      }
    }
    return false;
  }

  // Player base speed after warmth (heat) and passive modifiers.
  function playerSpeed(game) {
    var sp = C.PLAYER_SPEED * (passiveDef(game).speedMul || 1);
    var heat = game.warmth * C.HEAT_SLOW;
    heat *= (1 - (passiveDef(game).heatResist || 0));
    sp *= (1 - heat);
    return sp;
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
        var sp = playerSpeed(game);
        if (game.terrain[p.row][p.col].t === 'blanket' && !passiveDef(game).rugImmune) {
          sp *= C.BLANKET_SLOW;
        }
        vx = p.moveX * sp; vy = p.moveY * sp;
      }
    }
    p.moving = vx !== 0 || vy !== 0;
    if (p.moving) { game.slothTimer = 0; game.slothLossTimer = 0; }

    var nx = Math.max(0, Math.min(game.cols - 1, p.x + vx * dt));
    if (!circleBlocked(game, nx, p.y)) p.x = nx;
    else if (p.dash) p.dash = null;
    var ny = Math.max(0, Math.min(game.numRows - 1, p.y + vy * dt));
    if (!circleBlocked(game, p.x, ny)) p.y = ny;
    else if (p.dash) p.dash = null;

    p.col = Math.round(p.x);
    p.row = Math.round(p.y);
    if (p.row !== p.lastRow) { p.lastRow = p.row; checkCheckpoint(game); }
    collectBerries(game);
  }

  function checkCheckpoint(game) {
    var zones = game.level.zones || [];
    var p = game.player;
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
        game.events.push({ type: b.golden ? 'goldBerry' : 'berry', count: game.strawberries });
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
    var caltrops = hasItem(game, 'caltrops');
    var caltropsUp = caltrops && itemUpgraded(game, 'caltrops');
    var caltropR = caltropsUp ? C.CALTROPS_RADIUS * 1.5 : C.CALTROPS_RADIUS;

    for (var i = 0; i < game.npcs.length; i++) {
      var npc = game.npcs[i];
      npc.px = npc.x; npc.py = npc.y;

      if (npc.type === 'seated') continue;
      if (npc.type === 'marcher' || npc.type === 'ballkid') { stepMarcher(game, npc, dt); continue; }
      if (npc.type === 'steward') { stepSteward(game, npc, dt); continue; }
      if (npc.type === 'security') { stepSecurity(game, npc, dt); continue; }
      if (npc.type === 'fan') stepFanBrain(game, npc);

      var t = NPC_TYPES[npc.type];
      if (!npc.chasing) {
        npc.think -= dt;
        if (npc.think <= 0) {
          npc.think = rand(game.rng, t.thinkMin, t.thinkMax);
          var roll = game.rng();
          if (roll < t.stopChance) { npc.mode = 'stopped'; npc.modeT = rand(game.rng, 0.4, 1.3); }
          else {
            npc.mode = 'walk';
            var steered = false;
            if (npc.group) {
              var cx = 0, cy = 0, cnt = 0;
              for (var m = 0; m < game.npcs.length; m++) {
                if (game.npcs[m].group === npc.group) { cx += game.npcs[m].x; cy += game.npcs[m].y; cnt++; }
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

      // Caltrops: slow wheelchairs (and, upgraded, kids) near the player.
      var slowMul = 1;
      if (caltrops && (npc.type === 'wheelchair' || (caltropsUp && npc.type === 'kid'))) {
        var pdx = npc.x - game.player.x, pdy = npc.y - game.player.y;
        if (pdx * pdx + pdy * pdy < caltropR * caltropR) slowMul = C.CALTROPS_SLOW;
      }
      moveNpc(game, npc, dt, slowMul);
    }
  }

  // Formation members march straight across their fixed row, wrapping at the
  // edges. Because every member of a formation shares a direction and speed,
  // the whole line (and the gap corridor cut into it) translates rigidly —
  // so a marching crowd stays in formation and you must slot into the gap.
  function stepMarcher(game, npc, dt) {
    var lo = -1.5, hi = game.cols - 1 + 1.5;
    npc.x += npc.dir * npc.speed * dt;
    if (npc.x > hi) npc.x = lo + (npc.x - hi);
    else if (npc.x < lo) npc.x = hi - (lo - npc.x);
  }

  function stepSteward(game, npc, dt) { patrolTo(game, npc, dt, npc.speed); }

  function stepSecurity(game, npc, dt) {
    // Chases the player unless accreditation is equipped; otherwise patrols.
    var accredited = hasItem(game, 'accred');
    var p = game.player;
    var dx = p.x - npc.x, dy = p.y - npc.y;
    var d2 = dx * dx + dy * dy;
    if (accredited) { npc.chasing = false; }
    else if (npc.chasing) {
      if (d2 > C.SECURITY_DEAF * C.SECURITY_DEAF) {
        npc.chasing = false;
        game.events.push({ type: 'securityLost' });
      }
    } else if (d2 < C.SECURITY_AGGRO * C.SECURITY_AGGRO) {
      npc.chasing = true;
      game.events.push({ type: 'securitySpotted' });
    }
    if (npc.chasing) {
      var d = Math.sqrt(d2) || 1;
      var nx = npc.x + (dx / d) * C.SECURITY_SPEED * dt;
      var ny = npc.y + (dy / d) * C.SECURITY_SPEED * dt;
      if (!isBlockedAt(game, Math.round(nx), Math.round(ny))) { npc.x = nx; npc.y = ny; }
      else { // step around obstacles: try each axis
        if (!isBlockedAt(game, Math.round(nx), Math.round(npc.y))) npc.x = nx;
        else if (!isBlockedAt(game, Math.round(npc.x), Math.round(ny))) npc.y = ny;
      }
    } else {
      patrolTo(game, npc, dt, npc.speed);
    }
  }

  function patrolTo(game, npc, dt, speed) {
    var wp = npc.waypoints[npc.wpIndex];
    var dx = wp[0] - npc.x, dy = wp[1] - npc.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.08) { npc.wpIndex = (npc.wpIndex + 1) % npc.waypoints.length; return; }
    npc.heading = Math.atan2(dy, dx);
    var move = Math.min(d, speed * dt);
    npc.x += (dx / d) * move; npc.y += (dy / d) * move;
  }

  function stepFanBrain(game, npc) {
    var p = game.player;
    var dx = p.x - npc.x, dy = p.y - npc.y;
    var d2 = dx * dx + dy * dy;
    var inBand = p.y >= npc.yMin - 0.5 && p.y <= npc.yMax + 0.5;
    // Upgraded accreditation makes fans lose interest too.
    var vip = hasItem(game, 'accred') && itemUpgraded(game, 'accred');
    if (vip) { npc.chasing = false; return; }
    if (npc.chasing) {
      if (d2 > C.FAN_DEAF * C.FAN_DEAF || !inBand) { npc.chasing = false; game.events.push({ type: 'fanLost' }); }
    } else if (inBand && d2 < C.FAN_AGGRO * C.FAN_AGGRO) {
      npc.chasing = true; game.events.push({ type: 'fanSpotted' });
    }
    if (npc.chasing) npc.heading = Math.atan2(dy, dx);
  }

  function moveNpc(game, npc, dt, slowMul) {
    var sp = (npc.chasing ? C.FAN_CHASE_SPEED : npc.speed) * (slowMul || 1);
    var nx = npc.x + Math.cos(npc.heading) * sp * dt;
    var ny = npc.y + Math.sin(npc.heading) * sp * dt;
    if (nx < 0 || nx > game.cols - 1) { npc.heading = Math.PI - npc.heading; nx = Math.max(0, Math.min(game.cols - 1, nx)); }
    if (ny < npc.yMin || ny > npc.yMax) { npc.heading = -npc.heading; ny = Math.max(npc.yMin, Math.min(npc.yMax, ny)); }
    if (isBlockedAt(game, Math.round(nx), Math.round(ny))) { npc.heading += Math.PI + rand(game.rng, -0.7, 0.7); return; }
    npc.x = nx; npc.y = ny;
  }

  // ------------------------------------------------------------- hazards
  function stepPhotographers(game, dt) {
    var shades = hasItem(game, 'sunglasses');
    for (var i = 0; i < game.photographers.length; i++) {
      var ph = game.photographers[i];
      ph.phaseT -= dt;
      if (ph.phaseT <= 0) {
        if (ph.phase === 'idle') { ph.phase = 'charging'; ph.phaseT = C.FLASH_CHARGE; game.events.push({ type: 'flashCharge' }); }
        else if (ph.phase === 'charging') { ph.phase = 'flash'; ph.phaseT = C.FLASH_ACTIVE; ph.bombed = false; game.events.push({ type: 'flash' }); }
        else { ph.phase = 'idle'; ph.phaseT = rand(game.rng, C.FLASH_IDLE_MIN, C.FLASH_IDLE_MAX); }
      }
      if (ph.phase === 'flash' && !ph.bombed) {
        var pc = game.player.col, pr = game.player.row;
        if (pr === ph.row && ph.dangerCols.indexOf(pc) !== -1) {
          ph.bombed = true;
          if (shades) { game.events.push({ type: 'flashBlocked' }); }
          else {
            var loss = Math.min(C.PHOTOBOMB_LOSS, game.strawberries);
            game.strawberries -= loss;
            game.events.push({ type: 'photobomb', lost: loss, count: game.strawberries });
          }
        }
      }
    }
  }

  function stepSprinklers(game, dt) {
    for (var i = 0; i < game.sprinklers.length; i++) {
      var s = game.sprinklers[i];
      s.phaseT -= dt;
      if (s.phaseT <= 0) {
        if (s.phase === 'idle') { s.phase = 'warn'; s.phaseT = C.SPRINKLER_WARN; }
        else if (s.phase === 'warn') { s.phase = 'spray'; s.phaseT = C.SPRINKLER_SPRAY; s.soaked = false; game.events.push({ type: 'spray', col: s.col, row: s.row }); }
        else { s.phase = 'idle'; s.phaseT = rand(game.rng, C.SPRINKLER_IDLE_MIN, C.SPRINKLER_IDLE_MAX); }
      }
      if (s.phase === 'spray' && !s.soaked) {
        var pc = game.player.col, pr = game.player.row;
        if (Math.abs(pc - s.col) <= 1 && Math.abs(pr - s.row) <= 1 && !(pc === s.col && pr === s.row)) {
          s.soaked = true;
          if (itemReady(game, 'umbrella')) { consumeCharge(game, 'umbrella'); game.events.push({ type: 'umbrellaSave' }); }
          else {
            var loss = Math.min(C.SPRINKLER_LOSS, game.strawberries);
            game.strawberries -= loss;
            game.player.stun = C.SPRINKLER_STUN;
            game.events.push({ type: 'sprinklerHit', lost: loss, count: game.strawberries });
          }
        }
      }
    }
  }

  function stepBalls(game, dt) {
    for (var i = 0; i < game.balls.length; i++) {
      var b = game.balls[i];
      if (b.serve > 0) { b.serve -= dt; continue; } // telegraph before flight
      var ct = b.court;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.x < ct.colMin) { b.x = ct.colMin; b.vx = Math.abs(b.vx); }
      else if (b.x > ct.colMax) { b.x = ct.colMax; b.vx = -Math.abs(b.vx); }
      if (b.y < ct.rowMin) { b.y = ct.rowMin; b.vy = Math.abs(b.vy); }
      else if (b.y > ct.rowMax) { b.y = ct.rowMax; b.vy = -Math.abs(b.vy); }
    }
  }

  // ------------------------------------------------------------ collisions
  function checkCollisions(game) {
    if (game.invuln > 0) return;
    var p = game.player, i;

    for (i = 0; i < game.npcs.length; i++) {
      var npc = game.npcs[i];
      var r = npc.radius + C.PLAYER_R;
      var dx = npc.x - p.x, dy = npc.y - p.y;
      if (dx * dx + dy * dy < r * r) {
        // Lollipop saves a kid collision without spending a heart.
        if (npc.type === 'kid' && itemReady(game, 'lollipop')) {
          consumeCharge(game, 'lollipop');
          game.invuln = 1.0;                 // brief grace so it doesn't re-trigger
          game.events.push({ type: 'lollipopSave' });
          return;
        }
        hitPlayer(game, npc.type);
        return;
      }
    }

    for (i = 0; i < game.balls.length; i++) {
      var ball = game.balls[i];
      if (ball.serve > 0) continue;
      var br = C.BALL_RADIUS + C.PLAYER_R;
      var bdx = ball.x - p.x, bdy = ball.y - p.y;
      if (bdx * bdx + bdy * bdy < br * br) {
        if (itemReady(game, 'racket')) {
          consumeCharge(game, 'racket');
          ball.vx = -ball.vx; ball.vy = -ball.vy; // bat it back
          ball.serve = 0.25;                       // brief reset so it clears you
          game.invuln = 0.6;
          game.events.push({ type: 'ballBatted' });
        } else {
          hitPlayer(game, 'ball');
        }
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
    p.lastRow = p.row; p.dash = null; p.stun = 0;
    game.invuln = C.INVULN_TIME;
    game.slothTimer = 0; game.slothLossTimer = 0;
  }

  return {
    C: C,
    NPC_TYPES: NPC_TYPES,
    PASSIVES: PASSIVES,
    ITEMS: ITEMS,
    LEVELS: LEVELS,
    LEVEL: LEVELS[0],
    RANKED_SPECS: RANKED_SPECS,
    generateEndless: generateEndless,
    makeRng: makeRng,
    createGame: createGame,
    normalizeLoadout: normalizeLoadout,
    setMove: setMove,
    tryDash: tryDash,
    step: step,
    tileWalkable: tileWalkable,
    zoneForRow: zoneForRow
  };
});
