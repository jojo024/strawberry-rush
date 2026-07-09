'use strict';
/*
 * Unit tests for the pure game logic. Run with: node --test
 * (uses Node's built-in test runner — zero dependencies)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const GL = require('../src/logic.js');

const { C } = GL;
const DT = 1 / 60;

/** Minimal quiet stage: no NPCs, no photographers, no berries. */
function quietStage(extra) {
  return Object.assign({
    name: 'test', cols: 7,
    rows: [GL.ROW.GOAL, GL.ROW.GRASS, GL.ROW.GRASS, GL.ROW.GRASS, GL.ROW.START],
    berries: 0, photographerPairs: 0
  }, extra || {});
}

/** Advance the sim by (roughly) `seconds` in fixed steps. */
function run(game, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) GL.step(game, DT);
}

/** Hop once and let the hop animation finish. */
function hop(game, dir, dash) {
  const ok = GL.applyInput(game, dir, !!dash);
  run(game, dash ? C.DASH_TIME + DT : C.HOP_TIME + DT);
  return ok;
}

// ---------------------------------------------------------------- movement

test('single tap moves exactly one tile after the hop completes', () => {
  const g = GL.createGame(quietStage(), 1);
  const startRow = g.player.row;
  assert.equal(GL.applyInput(g, 'up', false), true);
  assert.equal(g.player.row, startRow - 1); // logical tile moves immediately
  run(g, C.HOP_TIME + DT);
  assert.equal(g.player.y, startRow - 1);   // continuous position lands
  assert.equal(g.player.hop, null);
});

test('input is ignored mid-hop (one tap, one hop)', () => {
  const g = GL.createGame(quietStage(), 1);
  GL.applyInput(g, 'up', false);
  assert.equal(GL.applyInput(g, 'up', false), false);
});

test('movement is clamped to the grid', () => {
  const g = GL.createGame(quietStage(), 1);
  g.player.col = 0; g.player.x = 0;
  assert.equal(GL.applyInput(g, 'left', false), false);
  assert.equal(g.player.col, 0);
});

test('player cannot walk into a photographer tile', () => {
  const g = GL.createGame(quietStage(), 1);
  g.blocked[g.player.col + ',' + (g.player.row - 1)] = true;
  assert.equal(GL.applyInput(g, 'up', false), false);
});

// ---------------------------------------------------------------- berries

test('landing on a strawberry collects it', () => {
  const g = GL.createGame(quietStage(), 1);
  g.berries.push({ col: g.player.col, row: g.player.row - 1, alive: true });
  hop(g, 'up');
  assert.equal(g.strawberries, 1);
  assert.equal(g.berries[0].alive, false);
});

test('a collected strawberry cannot be collected twice', () => {
  const g = GL.createGame(quietStage(), 1);
  g.berries.push({ col: g.player.col, row: g.player.row - 1, alive: true });
  hop(g, 'up');
  hop(g, 'down');
  hop(g, 'up');
  assert.equal(g.strawberries, 1);
});

// ---------------------------------------------------------------- dash

test('dash requires a full stack and consumes ALL strawberries', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = C.DASH_COST - 1;
  assert.equal(GL.applyInput(g, 'up', true), false, 'no dash below the cost');

  g.strawberries = C.DASH_COST + 1; // 4 in the stack
  const row = g.player.row;
  assert.equal(GL.applyInput(g, 'up', true), true);
  run(g, C.DASH_TIME + DT);
  assert.equal(g.player.row, row - C.DASH_TILES, 'dash covers 3 tiles');
  assert.equal(g.strawberries, 0, 'full-stack rule: everything is spent');
});

test('dash stops short at the grid edge instead of leaving it', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = C.DASH_COST;
  g.player.col = 1; g.player.x = 1;
  assert.equal(GL.applyInput(g, 'left', true), true);
  run(g, C.DASH_TIME + DT);
  assert.equal(g.player.col, 0, 'travelled only the 1 available tile');
  assert.equal(g.strawberries, 0);
});

test('dash into an immediate wall is refused and keeps the stack', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = C.DASH_COST;
  g.player.col = 0; g.player.x = 0;
  assert.equal(GL.applyInput(g, 'left', true), false);
  assert.equal(g.strawberries, C.DASH_COST);
});

// ---------------------------------------------------------------- sloth

test('standing still past the grace period drains strawberries steadily', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = 3;
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 3, 'grace period is free');
  run(g, 0.5 + C.SLOTH_INTERVAL + DT);
  assert.equal(g.strawberries, 2, 'first loss after grace + interval');
  run(g, C.SLOTH_INTERVAL);
  assert.equal(g.strawberries, 1, 'steady drain continues');
});

test('sloth penalty never goes below zero', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = 1;
  run(g, C.SLOTH_GRACE + 3 * C.SLOTH_INTERVAL + 1);
  assert.equal(g.strawberries, 0);
});

test('moving resets the sloth clock', () => {
  const g = GL.createGame(quietStage(), 1);
  g.strawberries = 3;
  run(g, C.SLOTH_GRACE - 0.5);
  hop(g, 'up');
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 3, 'no loss: clock restarted on the hop');
});

// ---------------------------------------------------------------- photobomb

function stageWithPair() {
  const g = GL.createGame(quietStage(), 1);
  const row = g.player.row - 1;
  g.photographers.push({
    row, leftCol: 1, rightCol: 4, dangerCols: [2, 3],
    phase: 'idle', phaseT: 0.5, bombed: false
  });
  g.blocked['1,' + row] = true;
  g.blocked['4,' + row] = true;
  return { g, row };
}

test('crossing the gap during the flash loses up to 2 strawberries, once', () => {
  const { g, row } = stageWithPair();
  g.strawberries = 5;
  g.player.col = 2; g.player.row = row;
  g.player.x = 2; g.player.y = row;
  g.photographers[0].phase = 'flash';
  g.photographers[0].phaseT = C.FLASH_ACTIVE;
  g.photographers[0].bombed = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 3, 'lost exactly PHOTOBOMB_LOSS');
  GL.step(g, DT);
  assert.equal(g.strawberries, 3, 'same flash cannot bomb twice');
});

test('photobomb takes all strawberries when fewer than the penalty', () => {
  const { g, row } = stageWithPair();
  g.strawberries = 1;
  g.player.col = 3; g.player.row = row;
  g.player.x = 3; g.player.y = row;
  g.photographers[0].phase = 'flash';
  g.photographers[0].phaseT = C.FLASH_ACTIVE;
  GL.step(g, DT);
  assert.equal(g.strawberries, 0);
});

test('standing in the gap while the flash is only CHARGING is safe', () => {
  const { g, row } = stageWithPair();
  g.strawberries = 5;
  g.player.col = 2; g.player.row = row;
  g.player.x = 2; g.player.y = row;
  g.photographers[0].phase = 'charging';
  g.photographers[0].phaseT = C.FLASH_CHARGE;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5, 'telegraph window is escape time');
});

test('flash cycle advances idle -> charging -> flash -> idle', () => {
  const { g } = stageWithPair();
  const ph = g.photographers[0];
  run(g, 0.6);
  assert.equal(ph.phase, 'charging');
  run(g, C.FLASH_CHARGE);
  assert.equal(ph.phase, 'flash');
  run(g, C.FLASH_ACTIVE + DT);
  assert.equal(ph.phase, 'idle');
});

// ---------------------------------------------------------------- collision

test('overlapping an NPC in the same lane kills the player', () => {
  const g = GL.createGame(quietStage(), 1);
  g.npcs.push({
    type: 'posh', row: g.player.row, x: g.player.x, px: g.player.x,
    dir: 1, baseSpeed: 0, speedMult: 0, halfW: 0.55,
    mode: 'stopped', modeT: 99, think: 99
  });
  GL.step(g, DT);
  assert.equal(g.status, 'dead');
  assert.equal(g.deathCause, 'posh');
});

test('an NPC in a different lane is harmless', () => {
  const g = GL.createGame(quietStage(), 1);
  g.npcs.push({
    type: 'posh', row: g.player.row - 2, x: g.player.x, px: g.player.x,
    dir: 1, baseSpeed: 0, speedMult: 0, halfW: 0.55,
    mode: 'stopped', modeT: 99, think: 99
  });
  GL.step(g, DT);
  assert.equal(g.status, 'playing');
});

test('a near miss outside the combined hitbox is safe', () => {
  const g = GL.createGame(quietStage(), 1);
  const gap = 0.55 + C.PLAYER_HALF_W + 0.05;
  g.npcs.push({
    type: 'posh', row: g.player.row, x: g.player.x + gap, px: g.player.x + gap,
    dir: 1, baseSpeed: 0, speedMult: 0, halfW: 0.55,
    mode: 'stopped', modeT: 99, think: 99
  });
  GL.step(g, DT);
  assert.equal(g.status, 'playing');
});

// ---------------------------------------------------------------- win / NPCs

test('reaching the goal row clears the stage', () => {
  const g = GL.createGame(quietStage(), 1);
  while (g.player.row > 0 && g.status === 'playing') hop(g, 'up');
  assert.equal(g.status, 'stageClear');
});

test('NPCs wrap around the lane instead of despawning (object pooling)', () => {
  const stage = quietStage({
    rows: [GL.ROW.GOAL, GL.lane(1, 2.0, 1, ['wheelchair']), GL.ROW.START]
  });
  const g = GL.createGame(stage, 1);
  assert.equal(g.npcs.length, 1);
  run(g, 30);
  assert.equal(g.npcs.length, 1, 'never destroyed');
  assert.ok(g.npcs[0].x >= -C.WRAP_MARGIN - 0.001 &&
            g.npcs[0].x <= g.cols - 1 + C.WRAP_MARGIN + 0.001,
            'position stays on the wrap loop');
});

test('simulation is deterministic for a given seed', () => {
  const mk = () => GL.createGame(GL.STAGES[0], 42);
  const a = mk(), b = mk();
  run(a, 5); run(b, 5);
  assert.deepEqual(
    a.npcs.map(n => [n.x.toFixed(6), n.dir, n.mode]),
    b.npcs.map(n => [n.x.toFixed(6), n.dir, n.mode])
  );
});

test('all five shipped stages construct without overlap errors', () => {
  for (let i = 0; i < GL.STAGES.length; i++) {
    const g = GL.createGame(GL.STAGES[i], 7 + i);
    assert.equal(g.status, 'playing');
    assert.ok(g.berries.length > 0, 'berries spawned');
    // Photographer tiles must be inside the grid and marked blocked.
    for (const ph of g.photographers) {
      assert.ok(ph.leftCol >= 0 && ph.rightCol < g.cols);
      assert.ok(g.blocked[ph.leftCol + ',' + ph.row]);
      assert.ok(g.blocked[ph.rightCol + ',' + ph.row]);
    }
    // Berries never sit on blocked tiles or the goal/start rows.
    for (const b of g.berries) {
      assert.ok(!g.blocked[b.col + ',' + b.row]);
      assert.ok(b.row > 0 && b.row < g.numRows - 1);
    }
    // A 10-second unattended sim must not crash or kill the idle player
    // standing on the start row (start rows have no lanes).
    run(g, 10);
    assert.equal(g.status, 'playing');
  }
});
