'use strict';
/*
 * Unit tests for the pure game logic (v4: free movement, three levels).
 * Run with: node --test  (Node's built-in runner — zero dependencies)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const GL = require('../src/logic.js');

const { C } = GL;
const DT = 1 / 60;

/** Minimal quiet level: open grass, no NPCs, no hazards, no berries. */
function quietLevel(extra) {
  return Object.assign({
    name: 'test', cols: 7, rows: 12,
    startCol: 3, startRow: 11,
    zones: [{ name: 'Z', rowMin: 1, rowMax: 10, threshold: null,
              ground: 'grass', speedScale: 1 }],
    hedges: [], walls: [], barriers: [], trees: [], blankets: [],
    sprinklers: [], photographers: [], npcs: [], berryCount: 0,
    goldenBerry: null
  }, extra || {});
}

/** Advance the sim by (roughly) `seconds` in fixed steps. */
function run(game, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) GL.step(game, DT);
}

/** Move in a direction for a duration, then stop. */
function moveFor(game, dx, dy, seconds) {
  GL.setMove(game, dx, dy);
  run(game, seconds);
  GL.setMove(game, 0, 0);
}

/** Teleport the player (tests only). */
function placePlayer(game, x, y) {
  const p = game.player;
  p.x = x; p.y = y; p.px = x; p.py = y;
  p.col = Math.round(x); p.row = Math.round(y); p.lastRow = p.row;
}

/** A stationary dummy NPC parked at (x, y). */
function parkNpc(game, type, x, y) {
  game.npcs.push({
    type, x, y, px: x, py: y, heading: 0,
    baseSpeed: 0, speed: 0, radius: GL.NPC_TYPES[type].radius,
    group: null, yMin: 0, yMax: game.numRows - 1,
    mode: 'stopped', modeT: 999, think: 999, chasing: false
  });
  return game.npcs[game.npcs.length - 1];
}

// ---------------------------------------------------------------- movement

test('free movement glides continuously at PLAYER_SPEED', () => {
  const g = GL.createGame(quietLevel(), 1);
  const y0 = g.player.y;
  moveFor(g, 0, -1, 0.5);
  const dy = y0 - g.player.y;
  assert.ok(Math.abs(dy - C.PLAYER_SPEED * 0.5) < 0.1, 'travelled ~speed*t up');
  const x0 = g.player.x;
  moveFor(g, 1, 0, 0.3);
  assert.ok(g.player.x - x0 > 1.0, 'moves sideways too');
});

test('diagonal movement is normalized (not faster)', () => {
  const g = GL.createGame(quietLevel(), 1);
  const x0 = g.player.x, y0 = g.player.y;
  moveFor(g, 1, -1, 0.5);
  const d = Math.hypot(g.player.x - x0, g.player.y - y0);
  assert.ok(Math.abs(d - C.PLAYER_SPEED * 0.5) < 0.15, 'diagonal speed equals straight');
});

test('movement is clamped to the world edges', () => {
  const g = GL.createGame(quietLevel(), 1);
  moveFor(g, -1, 0, 3);
  assert.ok(g.player.x >= 0, 'left edge');
  moveFor(g, 0, 1, 3);
  assert.ok(g.player.y <= g.numRows - 1, 'bottom edge');
});

test('blocked tiles stop you, but you slide along walls', () => {
  const g = GL.createGame(quietLevel({
    trees: [{ col: 3, row: 9, kind: 'tree' }]
  }), 1);
  placePlayer(g, 3, 11);
  moveFor(g, 0, -1, 1.0);
  assert.ok(g.player.y > 9.5, 'stopped short of the tree tile');
  // Diagonal input against the wall still slides sideways.
  const x0 = g.player.x;
  moveFor(g, 1, -1, 0.4);
  assert.ok(g.player.x - x0 > 0.8, 'slid along the wall');
});

test('picnic blankets slow you down', () => {
  const slow = GL.createGame(quietLevel({
    blankets: [{ col: 3, row: 11, w: 1, h: 1 }]
  }), 1);
  const fast = GL.createGame(quietLevel(), 1);
  moveFor(slow, 0, -1, 0.15);
  moveFor(fast, 0, -1, 0.15);
  const dSlow = 11 - slow.player.y, dFast = 11 - fast.player.y;
  assert.ok(dSlow < dFast * 0.7, 'blanket start is noticeably slower');
});

// ---------------------------------------------------------------- berries

test('walking over a strawberry collects it, once', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.berries.push({ col: 3, row: 10, alive: true, golden: false });
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, 1);
  moveFor(g, 0, 1, 0.5);
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, 1, 'cannot collect twice');
});

test('the golden strawberry is worth GOLD_VALUE', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.berries.push({ col: 3, row: 10, alive: true, golden: true });
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, C.GOLD_VALUE);
});

// ---------------------------------------------------------------- dash

test('dash spends the whole stack for a burst of speed', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = C.DASH_COST + 1;
  GL.setMove(g, 0, -1);
  const y0 = g.player.y;
  assert.equal(GL.tryDash(g), true);
  assert.equal(g.strawberries, 0, 'full-stack rule: everything is spent');
  run(g, C.DASH_TIME);
  const dy = y0 - g.player.y;
  assert.ok(dy > C.PLAYER_SPEED * C.DASH_TIME * 1.5, 'much faster than running');
  assert.ok(g.events.some(e => e.type === 'dash'));
  assert.equal(g.dashesUsed, 1);
});

test('a dash below the cost is refused and costs nothing', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = C.DASH_COST - 1;
  GL.setMove(g, 0, -1);
  assert.equal(GL.tryDash(g), false);
  assert.equal(g.strawberries, C.DASH_COST - 1);
  const y0 = g.player.y;
  run(g, 0.3);
  assert.ok(y0 - g.player.y > 1.0, 'normal movement unaffected');
});

test('a wall stops a dash instead of letting it cross', () => {
  const g = GL.createGame(quietLevel({
    trees: [{ col: 3, row: 9, kind: 'tree' }]
  }), 1);
  placePlayer(g, 3, 11);
  g.strawberries = C.DASH_COST;
  GL.setMove(g, 0, -1);
  GL.tryDash(g);
  run(g, C.DASH_TIME + 0.05);
  assert.ok(g.player.y > 9.5, 'did not pass through the tree');
  assert.equal(g.player.dash, null, 'dash ended at the wall');
});

// ---------------------------------------------------------------- sloth

test('standing still past the grace period drains strawberries steadily', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 3;
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 3, 'grace period is free');
  run(g, 0.5 + C.SLOTH_INTERVAL + DT);
  assert.equal(g.strawberries, 2, 'first loss after grace + interval');
  run(g, C.SLOTH_INTERVAL);
  assert.equal(g.strawberries, 1, 'steady drain continues');
});

test('moving resets the sloth clock and losses stop at zero', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 3;
  run(g, C.SLOTH_GRACE - 0.5);
  moveFor(g, 0, -1, 0.2);
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 3, 'no loss: clock restarted by moving');
  g.strawberries = 1;
  run(g, C.SLOTH_GRACE + 3 * C.SLOTH_INTERVAL + 1);
  assert.equal(g.strawberries, 0, 'never negative');
});

// ---------------------------------------------------------------- photobomb

function levelWithPair() {
  const g = GL.createGame(quietLevel({
    photographers: [{ row: 4, leftCol: 1 }]  // blocks 1 & 4, danger 2 & 3
  }), 1);
  return { g, ph: g.photographers[0] };
}

test('crossing the gap during the flash loses up to 2 strawberries, once', () => {
  const { g, ph } = levelWithPair();
  g.strawberries = 5;
  placePlayer(g, 2, 4);
  ph.phase = 'flash'; ph.phaseT = C.FLASH_ACTIVE; ph.bombed = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 3, 'lost exactly PHOTOBOMB_LOSS');
  GL.step(g, DT);
  assert.equal(g.strawberries, 3, 'same flash cannot bomb twice');
});

test('standing in the gap while the flash is only CHARGING is safe', () => {
  const { g, ph } = levelWithPair();
  g.strawberries = 5;
  placePlayer(g, 3, 4);
  ph.phase = 'charging'; ph.phaseT = C.FLASH_CHARGE;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5, 'telegraph window is escape time');
});

test('flash cycle advances idle -> charging -> flash -> idle', () => {
  const { g, ph } = levelWithPair();
  ph.phase = 'idle'; ph.phaseT = 0.3;
  run(g, 0.4);
  assert.equal(ph.phase, 'charging');
  run(g, C.FLASH_CHARGE);
  assert.equal(ph.phase, 'flash');
  run(g, C.FLASH_ACTIVE + DT);
  assert.equal(ph.phase, 'idle');
});

// ---------------------------------------------------------------- sprinklers

function levelWithSprinkler() {
  const g = GL.createGame(quietLevel({
    sprinklers: [{ col: 3, row: 3 }]
  }), 1);
  return { g, s: g.sprinklers[0] };
}

test('sprinkler cycle advances idle -> warn -> spray -> idle', () => {
  const { g, s } = levelWithSprinkler();
  s.phase = 'idle'; s.phaseT = 0.3;
  run(g, 0.4);
  assert.equal(s.phase, 'warn');
  run(g, C.SPRINKLER_WARN);
  assert.equal(s.phase, 'spray');
  run(g, C.SPRINKLER_SPRAY + DT);
  assert.equal(s.phase, 'idle');
});

test('being sprayed costs berries and the stun freezes movement', () => {
  const { g, s } = levelWithSprinkler();
  g.strawberries = 5;
  placePlayer(g, 3, 4);   // adjacent to the sprinkler
  s.phase = 'spray'; s.phaseT = C.SPRINKLER_SPRAY; s.soaked = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5 - C.SPRINKLER_LOSS);
  assert.ok(g.player.stun > 0, 'player is stunned');
  const y0 = g.player.y;
  moveFor(g, 0, 1, 0.3);   // try to walk while dripping
  assert.ok(Math.abs(g.player.y - y0) < 0.01, 'stun freezes movement');
  GL.step(g, DT);
  assert.equal(g.strawberries, 5 - C.SPRINKLER_LOSS, 'one soak per spray');
  run(g, C.SPRINKLER_STUN);
  moveFor(g, 0, 1, 0.2);
  assert.ok(g.player.y > y0, 'movement resumes after the stun');
});

test('the sprinkler tile itself is blocked and warn phase is dry', () => {
  const { g, s } = levelWithSprinkler();
  assert.equal(GL.tileWalkable(g, 3, 3), false);
  g.strawberries = 5;
  placePlayer(g, 3, 4);
  s.phase = 'warn'; s.phaseT = C.SPRINKLER_WARN;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5, 'warning phase does not soak');
});

// ---------------------------------------------------------------- hearts

test('a collision costs a heart and berries and respawns at the checkpoint', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 5;
  moveFor(g, 0, -1, 0.4);
  parkNpc(g, 'posh', g.player.x, g.player.y);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS - 1);
  assert.equal(g.strawberries, 5 - C.HIT_BERRY_LOSS);
  assert.equal(g.player.row, g.level.startRow, 'back at the start checkpoint');
  assert.ok(g.invuln > 0, 'mercy window granted');
  assert.equal(g.status, 'playing');
});

test('invulnerability prevents immediate re-hits; three hits end the run', () => {
  const g = GL.createGame(quietLevel(), 1);
  parkNpc(g, 'posh', g.player.x, g.player.y);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS - 1, 'first hit lands');
  run(g, 1.0);
  assert.equal(g.hearts, C.HEARTS - 1, 'invulnerable: no second hit yet');
  run(g, 2 * (C.INVULN_TIME + 0.1));
  assert.equal(g.status, 'dead');
  assert.equal(g.hearts, 0);
  assert.equal(g.deathCause, 'posh');
});

test('a near miss outside the combined radius is safe', () => {
  const g = GL.createGame(quietLevel(), 1);
  const gap = GL.NPC_TYPES.posh.radius + C.PLAYER_R + 0.05;
  parkNpc(g, 'posh', g.player.x + gap, g.player.y);
  GL.step(g, DT);
  assert.equal(g.status, 'playing');
});

// ---------------------------------------------------------------- checkpoints

test('crossing a zone threshold plants a checkpoint', () => {
  const g = GL.createGame(quietLevel({
    zones: [
      { name: 'Upper', rowMin: 1, rowMax: 5, threshold: 5, ground: 'grass', speedScale: 1 },
      { name: 'Lower', rowMin: 6, rowMax: 10, threshold: null, ground: 'grass', speedScale: 1 }
    ]
  }), 1);
  assert.equal(g.checkpointStage, 0);
  moveFor(g, 0, -1, 0.8);      // ~4 tiles: row 7, still Lower
  assert.equal(g.checkpointStage, 0);
  moveFor(g, 0, -1, 0.5);      // crosses into Upper (row <= 5)
  assert.equal(g.checkpointStage, 1);
  assert.ok(g.checkpoint.row <= 5, 'checkpoint planted inside the new zone');
  assert.ok(g.events.some(e => e.type === 'checkpoint'));
});

// ---------------------------------------------------------------- NPC AI

test('wanderers stay in their band and off blocked tiles, in EVERY level', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 99 + li);
    run(g, 8);
    for (const npc of g.npcs) {
      assert.ok(npc.x >= -0.001 && npc.x <= g.cols - 1 + 0.001, 'x in world');
      assert.ok(npc.y >= npc.yMin - 0.001 && npc.y <= npc.yMax + 0.001,
                `L${li + 1} ${npc.type} stays in its band`);
      assert.equal(g.terrain[Math.round(npc.y)][Math.round(npc.x)].block, null,
                   `L${li + 1} ${npc.type} never stands in a blocked tile`);
    }
  }
});

test('NPCs move in 2 dimensions, not just left-right', () => {
  const g = GL.createGame(GL.LEVELS[0], 7);
  const before = g.npcs.map(n => [n.x, n.y]);
  run(g, 12);
  let movedVertically = 0;
  for (let i = 0; i < g.npcs.length; i++) {
    if (Math.abs(g.npcs[i].y - before[i][1]) > 0.5) movedVertically++;
  }
  assert.ok(movedVertically >= 5, 'a real share of the crowd wandered vertically');
});

test('grouped wanderers stay together as parties', () => {
  const g = GL.createGame(GL.LEVELS[0], 5);
  run(g, 20);
  const groups = {};
  for (const n of g.npcs) {
    if (n.group) (groups[n.group] = groups[n.group] || []).push(n);
  }
  assert.ok(Object.keys(groups).length >= 4, 'several parties exist');
  for (const name of Object.keys(groups)) {
    const m = groups[name];
    if (m.length < 2) continue;
    const cx = m.reduce((s, n) => s + n.x, 0) / m.length;
    const cy = m.reduce((s, n) => s + n.y, 0) / m.length;
    for (const n of m) {
      const d = Math.hypot(n.x - cx, n.y - cy);
      assert.ok(d < 5.0, name + ' member near its party (was ' + d.toFixed(2) + ')');
    }
  }
});

test('seated picnickers hold their spot', () => {
  const g = GL.createGame(GL.LEVELS[0], 3);
  const before = g.npcs.filter(n => n.type === 'seated').map(n => [n.x, n.y]);
  assert.ok(before.length >= 4, 'seated parties exist');
  run(g, 10);
  const after = g.npcs.filter(n => n.type === 'seated').map(n => [n.x, n.y]);
  assert.deepEqual(after, before);
});

test('stewards patrol between their waypoints', () => {
  const g = GL.createGame(quietLevel({
    npcs: [{ type: 'steward', waypoints: [[1, 1], [5, 1]] }]
  }), 1);
  const s = g.npcs[0];
  const positions = [];
  for (let i = 0; i < 8; i++) { run(g, 0.5); positions.push(s.x); }
  assert.ok(Math.max(...positions) > 3, 'walked toward the far waypoint');
  assert.ok(positions.every(() => Math.abs(s.y - 1) < 0.1), 'held the patrol line');
  run(g, 6);
  assert.ok(s.x >= 0.9 && s.x <= 5.1, 'still on the patrol segment');
});

test('the autograph hunter chases when close and gives up when far', () => {
  const g = GL.createGame(quietLevel({
    npcs: [{ type: 'fan', col: 1, row: 3, rowMin: 1, rowMax: 5 }]
  }), 1);
  const fan = g.npcs[0];
  assert.equal(fan.chasing, false);
  placePlayer(g, 3, 3);
  GL.step(g, DT);
  assert.equal(fan.chasing, true, 'noticed the player');
  assert.ok(g.events.some(e => e.type === 'fanSpotted'));
  const d0 = Math.hypot(fan.x - g.player.x, fan.y - g.player.y);
  run(g, 0.3);
  const d1 = Math.hypot(fan.x - g.player.x, fan.y - g.player.y);
  assert.ok(d1 < d0, 'closing in on the player');
  assert.equal(g.hearts, C.HEARTS, 'not caught yet');
  placePlayer(g, 3, 11);
  GL.step(g, DT);
  assert.equal(fan.chasing, false, 'lost interest outside its zone');
});

test('the stewards’ authored patrol routes never cross blocked tiles', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 1);
    for (const npc of g.npcs) {
      if (npc.type !== 'steward') continue;
      const wps = npc.waypoints;
      for (let i = 0; i < wps.length; i++) {
        const [ax, ay] = wps[i], [bx, by] = wps[(i + 1) % wps.length];
        for (let k = 0; k <= 20; k++) {
          const x = ax + (bx - ax) * k / 20, y = ay + (by - ay) * k / 20;
          assert.equal(g.terrain[Math.round(y)][Math.round(x)].block, null,
            `L${li + 1} patrol clear at (${x.toFixed(1)},${y.toFixed(1)})`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- levels & win

test('reaching the top row wins the level', () => {
  const g = GL.createGame(quietLevel(), 1);
  GL.setMove(g, 0, -1);
  run(g, 5);
  assert.equal(g.status, 'won');
  assert.ok(g.events.some(e => e.type === 'won'));
});

test('simulation is deterministic for a given seed', () => {
  const mk = () => GL.createGame(GL.LEVELS[0], 42);
  const a = mk(), b = mk();
  run(a, 5); run(b, 5);
  assert.deepEqual(
    a.npcs.map(n => [n.x.toFixed(6), n.y.toFixed(6), n.mode]),
    b.npcs.map(n => [n.x.toFixed(6), n.y.toFixed(6), n.mode])
  );
});

test('EVERY level has a walkable path from start to the food truck', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 1);
    const seen = new Set();
    const queue = [[g.level.startCol, g.level.startRow]];
    seen.add(g.level.startCol + ',' + g.level.startRow);
    let reached = false;
    while (queue.length) {
      const [c, r] = queue.shift();
      if (r === 0) { reached = true; break; }
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nc = c + dc, nr = r + dr, k = nc + ',' + nr;
        if (!seen.has(k) && GL.tileWalkable(g, nc, nr)) {
          seen.add(k);
          queue.push([nc, nr]);
        }
      }
    }
    assert.ok(reached, `L${li + 1} "${GL.LEVELS[li].name}" is winnable on foot`);
  }
});

test('EVERY level constructs cleanly with sane berry/hazard placement', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 7 + li);
    assert.equal(g.status, 'playing');
    assert.ok(g.berries.length >= GL.LEVELS[li].berryCount, 'berries spawned');
    assert.ok(g.berries.some(b => b.golden), 'golden berry present');
    for (const b of g.berries) {
      assert.equal(g.terrain[b.row][b.col].block, null, 'berry not inside a prop');
      assert.ok(b.row > 0 && b.row < g.numRows - 1, 'berry off goal/start rows');
    }
    for (const ph of g.photographers) {
      assert.ok(ph.leftCol >= 0 && ph.rightCol < g.cols);
      assert.equal(GL.tileWalkable(g, ph.leftCol, ph.row), false);
      assert.equal(GL.tileWalkable(g, ph.rightCol, ph.row), false);
    }
    for (const s of g.sprinklers) {
      assert.equal(GL.tileWalkable(g, s.col, s.row), false);
    }
    // A 10-second unattended sim must not crash or hurt the idle player
    // standing on the start row (no NPC band includes it).
    run(g, 10);
    assert.equal(g.status, 'playing');
    assert.equal(g.hearts, C.HEARTS, `L${li + 1} start row is safe`);
  }
});
