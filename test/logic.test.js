'use strict';
/*
 * Unit tests for the pure game logic (v5: campaign, economy, loadout).
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
    name: 'test', theme: 'dawn', warmth: 0,
    cols: 7, rows: 12, startCol: 3, startRow: 11,
    zones: [{ name: 'Z', rowMin: 1, rowMax: 10, threshold: null,
              ground: 'grass', speedScale: 1 }],
    hedges: [], walls: [], barriers: [], trees: [], blankets: [],
    sprinklers: [], photographers: [], tennisCourts: [], npcs: [],
    berryCount: 0, goldenBerry: null
  }, extra || {});
}

function run(game, seconds) {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) GL.step(game, DT);
}
function moveFor(game, dx, dy, seconds) {
  GL.setMove(game, dx, dy); run(game, seconds); GL.setMove(game, 0, 0);
}
function placePlayer(game, x, y) {
  const p = game.player;
  p.x = x; p.y = y; p.px = x; p.py = y;
  p.col = Math.round(x); p.row = Math.round(y); p.lastRow = p.row;
}
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
  assert.ok(Math.abs((y0 - g.player.y) - C.PLAYER_SPEED * 0.5) < 0.1);
});

test('diagonal movement is normalized (not faster)', () => {
  const g = GL.createGame(quietLevel(), 1);
  const x0 = g.player.x, y0 = g.player.y;
  moveFor(g, 1, -1, 0.5);
  const d = Math.hypot(g.player.x - x0, g.player.y - y0);
  assert.ok(Math.abs(d - C.PLAYER_SPEED * 0.5) < 0.15);
});

test('blocked tiles stop you, but you slide along walls', () => {
  const g = GL.createGame(quietLevel({ trees: [{ col: 3, row: 9, kind: 'tree' }] }), 1);
  placePlayer(g, 3, 11);
  moveFor(g, 0, -1, 1.0);
  assert.ok(g.player.y > 9.5, 'stopped short of the tree');
  const x0 = g.player.x;
  moveFor(g, 1, -1, 0.4);
  assert.ok(g.player.x - x0 > 0.8, 'slid along the wall');
});

test('picnic blankets slow you; Sure-Footed passive cancels it', () => {
  const base = GL.createGame(quietLevel({ blankets: [{ col: 3, row: 11, w: 1, h: 1 }] }), 1);
  const sure = GL.createGame(quietLevel({ blankets: [{ col: 3, row: 11, w: 1, h: 1 }] }), 1,
    { passive: 'surefoot' });
  const open = GL.createGame(quietLevel(), 1);
  moveFor(base, 0, -1, 0.15); moveFor(sure, 0, -1, 0.15); moveFor(open, 0, -1, 0.15);
  assert.ok((11 - base.player.y) < (11 - open.player.y) * 0.7, 'blanket is slower');
  assert.ok(Math.abs((11 - sure.player.y) - (11 - open.player.y)) < 0.02, 'Sure-Footed ignores it');
});

// ---------------------------------------------------------------- warmth & passives

test('warm levels slow the player; Linen Whites restores most of it', () => {
  const cool = GL.createGame(quietLevel({ warmth: 0 }), 1);
  const hot = GL.createGame(quietLevel({ warmth: 1 }), 1);
  const linen = GL.createGame(quietLevel({ warmth: 1 }), 1, { passive: 'linen' });
  moveFor(cool, 0, -1, 0.3); moveFor(hot, 0, -1, 0.3); moveFor(linen, 0, -1, 0.3);
  const dCool = 11 - cool.player.y, dHot = 11 - hot.player.y, dLinen = 11 - linen.player.y;
  assert.ok(dHot < dCool * 0.75, 'heat noticeably slows you');
  assert.ok(dLinen > dHot, 'Linen Whites recovers speed');
});

test('Fresh Legs passive makes you faster', () => {
  const base = GL.createGame(quietLevel(), 1);
  const fast = GL.createGame(quietLevel(), 1, { passive: 'speed' });
  moveFor(base, 0, -1, 0.3); moveFor(fast, 0, -1, 0.3);
  assert.ok((11 - fast.player.y) > (11 - base.player.y) * 1.1);
});

test('Iron Constitution passive grants a fourth heart', () => {
  const g = GL.createGame(quietLevel(), 1, { passive: 'heart' });
  assert.equal(g.hearts, C.HEARTS + 1);
});

// ---------------------------------------------------------------- berries & currency

test('walking over a strawberry collects it, once', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.berries.push({ col: 3, row: 10, alive: true, golden: false });
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, 1);
  moveFor(g, 0, 1, 0.5); moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, 1, 'cannot collect twice');
});

test('the golden strawberry banks GOLD_VALUE (5)', () => {
  assert.equal(C.GOLD_VALUE, 5);
  const g = GL.createGame(quietLevel(), 1);
  g.berries.push({ col: 3, row: 10, alive: true, golden: true });
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.strawberries, 5);
});

// ---------------------------------------------------------------- dash (currency)

test('dash spends exactly DASH_COST and keeps the rest', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 7;
  GL.setMove(g, 0, -1);
  const y0 = g.player.y;
  assert.equal(GL.tryDash(g), true);
  assert.equal(g.strawberries, 7 - C.DASH_COST, 'only the dash cost is spent');
  run(g, C.DASH_TIME);
  assert.ok(y0 - g.player.y > C.PLAYER_SPEED * C.DASH_TIME * 1.5, 'a real burst of speed');
});

test('dash fires in the pressed direction, not the drift direction', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 9;
  placePlayer(g, 3, 6);
  GL.setMove(g, -1, 0);       // drifting left
  run(g, 0.1);
  const x0 = g.player.x, y0 = g.player.y;
  assert.equal(GL.tryDash(g, 0, -1), true, 'dash up while moving left');
  run(g, C.DASH_TIME);
  assert.ok(y0 - g.player.y > 2, 'moved UP a lot');
  assert.ok(Math.abs(g.player.x - x0) < 0.3, 'barely moved horizontally');
});

test('dash with no direction falls back to current facing', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 6;
  placePlayer(g, 3, 6);
  GL.setMove(g, 1, 0); run(g, 0.05); GL.setMove(g, 0, 0); // now facing right
  const x0 = g.player.x;
  assert.equal(GL.tryDash(g, 0, 0), true);
  run(g, C.DASH_TIME);
  assert.ok(g.player.x - x0 > 2, 'dashed the way it was facing (right)');
});

test('a dash below the cost is refused and costs nothing', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = C.DASH_COST - 1;
  GL.setMove(g, 0, -1);
  assert.equal(GL.tryDash(g), false);
  assert.equal(g.strawberries, C.DASH_COST - 1);
});

test('Thrifty Dasher passive refunds one strawberry per dash', () => {
  const g = GL.createGame(quietLevel(), 1, { passive: 'thrift' });
  g.strawberries = 5;
  GL.setMove(g, 0, -1);
  GL.tryDash(g);
  assert.equal(g.strawberries, 5 - C.DASH_COST + 1, 'net cost is 2');
});

// ---------------------------------------------------------------- sloth

test('standing still past the grace drains strawberries; moving resets it', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 3;
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 3, 'grace period is free');
  run(g, 0.5 + C.SLOTH_INTERVAL + DT);
  assert.equal(g.strawberries, 2);
  moveFor(g, 0, -1, 0.2);
  run(g, C.SLOTH_GRACE - 0.5);
  assert.equal(g.strawberries, 2, 'clock restarted by moving');
});

// ---------------------------------------------------------------- photographers

function levelWithPair(loadout) {
  const g = GL.createGame(quietLevel({ photographers: [{ row: 4, leftCol: 1 }] }), 1, loadout);
  return { g, ph: g.photographers[0] };
}

test('crossing the gap during the flash loses strawberries, once', () => {
  const { g, ph } = levelWithPair();
  g.strawberries = 5; placePlayer(g, 2, 4);
  ph.phase = 'flash'; ph.phaseT = C.FLASH_ACTIVE; ph.bombed = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 3);
  GL.step(g, DT);
  assert.equal(g.strawberries, 3, 'same flash cannot bomb twice');
});

test('Sunglasses (aura item) negate the photographer flash loss', () => {
  const { g, ph } = levelWithPair({ items: ['sunglasses'] });
  g.strawberries = 5; placePlayer(g, 2, 4);
  ph.phase = 'flash'; ph.phaseT = C.FLASH_ACTIVE; ph.bombed = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5, 'shades block the loss');
  assert.ok(g.events.some(e => e.type === 'flashBlocked'));
});

test('flash cycle advances idle -> charging -> flash -> idle', () => {
  const { g, ph } = levelWithPair();
  ph.phase = 'idle'; ph.phaseT = 0.3;
  run(g, 0.4); assert.equal(ph.phase, 'charging');
  run(g, C.FLASH_CHARGE); assert.equal(ph.phase, 'flash');
  run(g, C.FLASH_ACTIVE + DT); assert.equal(ph.phase, 'idle');
});

// ---------------------------------------------------------------- sprinklers & umbrella

function levelWithSprinkler(loadout) {
  const g = GL.createGame(quietLevel({ sprinklers: [{ col: 3, row: 3 }] }), 1, loadout);
  return { g, s: g.sprinklers[0] };
}

test('being sprayed costs berries and the stun freezes movement', () => {
  const { g, s } = levelWithSprinkler();
  g.strawberries = 5; placePlayer(g, 3, 4);
  s.phase = 'spray'; s.phaseT = C.SPRINKLER_SPRAY; s.soaked = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5 - C.SPRINKLER_LOSS);
  assert.ok(g.player.stun > 0);
  const y0 = g.player.y;
  moveFor(g, 0, 1, 0.3);
  assert.ok(Math.abs(g.player.y - y0) < 0.01, 'stun freezes movement');
});

test('Umbrella (charge item) shrugs off one soaking, then is spent', () => {
  const { g, s } = levelWithSprinkler({ items: ['umbrella'] });
  g.strawberries = 5; placePlayer(g, 3, 4);
  s.phase = 'spray'; s.phaseT = C.SPRINKLER_SPRAY; s.soaked = false;
  GL.step(g, DT);
  assert.equal(g.strawberries, 5, 'no loss — umbrella saved you');
  assert.equal(g.player.stun, 0, 'no stun either');
  assert.ok(g.events.some(e => e.type === 'umbrellaSave'));
  // Second sprinkler this level: the single charge is gone.
  const s2 = g.sprinklers[0];
  s2.phase = 'spray'; s2.phaseT = C.SPRINKLER_SPRAY; s2.soaked = false;
  placePlayer(g, 3, 4);
  GL.step(g, DT);
  assert.equal(g.strawberries, 5 - C.SPRINKLER_LOSS, 'charge spent, second soak lands');
});

test('an UPGRADED umbrella is reusable all level', () => {
  const g = GL.createGame(quietLevel({ sprinklers: [{ col: 3, row: 3 }] }), 1,
    { items: ['umbrella'], upgraded: { umbrella: true } });
  g.strawberries = 5;
  for (let k = 0; k < 3; k++) {
    const s = g.sprinklers[0];
    s.phase = 'spray'; s.phaseT = C.SPRINKLER_SPRAY; s.soaked = false;
    placePlayer(g, 3, 4);
    GL.step(g, DT);
  }
  assert.equal(g.strawberries, 5, 'never soaked with the reusable upgrade');
});

// ---------------------------------------------------------------- kids & lollipop

test('a kid collision costs a heart; a Lollipop saves it once', () => {
  const hurt = GL.createGame(quietLevel(), 1);
  parkNpc(hurt, 'kid', hurt.player.x, hurt.player.y);
  GL.step(hurt, DT);
  assert.equal(hurt.hearts, C.HEARTS - 1);

  const saved = GL.createGame(quietLevel(), 1, { items: ['lollipop'] });
  parkNpc(saved, 'kid', saved.player.x, saved.player.y);
  GL.step(saved, DT);
  assert.equal(saved.hearts, C.HEARTS, 'lollipop absorbed the hit');
  assert.ok(saved.events.some(e => e.type === 'lollipopSave'));
});

// ---------------------------------------------------------------- caltrops

test('Caltrops slow a wheelchair user that comes near the player', () => {
  const g = GL.createGame(quietLevel({
    npcs: [{ type: 'wheelchair', col: 3, row: 8, rowMin: 6, rowMax: 9 }]
  }), 1, { items: ['caltrops'] });
  const w = g.npcs[0];
  w.heading = -Math.PI / 2; w.speed = w.baseSpeed = 1.5;
  placePlayer(g, 4.8, 8);           // within caltrops radius, clear of collision
  const y0 = w.y;
  run(g, 0.3);
  const slowed = Math.abs(w.y - y0);
  // Compare to an un-caltropped run.
  const g2 = GL.createGame(quietLevel({
    npcs: [{ type: 'wheelchair', col: 3, row: 8, rowMin: 6, rowMax: 9 }]
  }), 1);
  const w2 = g2.npcs[0];
  w2.heading = -Math.PI / 2; w2.speed = w2.baseSpeed = 1.5;
  g2.player.x = 99; g2.player.y = 99; // player far away, no slowing
  const y02 = w2.y; run(g2, 0.3);
  assert.ok(slowed < Math.abs(w2.y - y02) * 0.6, 'caltrops meaningfully slow it');
});

// ---------------------------------------------------------------- security & accreditation

test('security guards chase without a pass, and ignore you with Accreditation', () => {
  const noPass = GL.createGame(quietLevel({
    npcs: [{ type: 'security', waypoints: [[1, 3], [5, 3]] }]
  }), 1);
  const s = noPass.npcs[0];
  placePlayer(noPass, 3, 3);
  GL.step(noPass, DT);
  assert.equal(s.chasing, true, 'spotted the unaccredited player');
  assert.ok(noPass.events.some(e => e.type === 'securitySpotted'));

  const pass = GL.createGame(quietLevel({
    npcs: [{ type: 'security', waypoints: [[1, 3], [5, 3]] }]
  }), 1, { items: ['accred'] });
  placePlayer(pass, 3, 3);
  GL.step(pass, DT);
  assert.equal(pass.npcs[0].chasing, false, 'accreditation keeps you invisible');
});

test('a chasing security guard closes the distance', () => {
  const g = GL.createGame(quietLevel({
    npcs: [{ type: 'security', waypoints: [[1, 3], [5, 3]] }]
  }), 1);
  placePlayer(g, 4, 3);
  GL.step(g, DT);
  const d0 = Math.hypot(g.npcs[0].x - g.player.x, g.npcs[0].y - g.player.y);
  run(g, 0.3);
  const d1 = Math.hypot(g.npcs[0].x - g.player.x, g.npcs[0].y - g.player.y);
  assert.ok(d1 < d0, 'gaining on the player');
});

// ---------------------------------------------------------------- tennis balls & racket

test('a served tennis ball costs a heart on contact', () => {
  const g = GL.createGame(quietLevel({
    tennisCourts: [{ colMin: 1, colMax: 5, rowMin: 2, rowMax: 5, balls: 1, speed: 5 }]
  }), 1);
  const b = g.balls[0];
  b.serve = 0; b.x = 3; b.y = 3; b.vx = 0; b.vy = 0;
  placePlayer(g, 3, 3);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS - 1, 'the ball bowled you over');
  assert.equal(g.deathCause, null); // still alive with hearts left
});

test('the serve telegraph is harmless until the ball is live', () => {
  const g = GL.createGame(quietLevel({
    tennisCourts: [{ colMin: 1, colMax: 5, rowMin: 2, rowMax: 5, balls: 1, speed: 5 }]
  }), 1);
  const b = g.balls[0];
  b.serve = 1.0; b.x = 3; b.y = 3;
  placePlayer(g, 3, 3);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS, 'no hit during the serve telegraph');
});

test('a Racket bats the ball away instead of taking the hit', () => {
  const g = GL.createGame(quietLevel({
    tennisCourts: [{ colMin: 1, colMax: 5, rowMin: 2, rowMax: 5, balls: 1, speed: 5 }]
  }), 1, { items: ['racket'] });
  const b = g.balls[0];
  b.serve = 0; b.x = 3; b.y = 3; b.vx = 4; b.vy = 0;
  placePlayer(g, 3, 3);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS, 'no damage — racket saved you');
  assert.ok(b.vx < 0, 'the ball was batted back');
  assert.ok(g.events.some(e => e.type === 'ballBatted'));
});

// ---------------------------------------------------------------- hearts & checkpoints

test('a collision respawns you at the checkpoint with invulnerability', () => {
  const g = GL.createGame(quietLevel(), 1);
  g.strawberries = 5;
  moveFor(g, 0, -1, 0.4);
  parkNpc(g, 'posh', g.player.x, g.player.y);
  GL.step(g, DT);
  assert.equal(g.hearts, C.HEARTS - 1);
  assert.equal(g.strawberries, 5 - C.HIT_BERRY_LOSS);
  assert.equal(g.player.row, g.level.startRow, 'back at the checkpoint');
  assert.ok(g.invuln > 0);
});

test('running out of hearts ends the run', () => {
  const g = GL.createGame(quietLevel(), 1);
  parkNpc(g, 'posh', g.player.x, g.player.y);
  GL.step(g, DT);
  run(g, C.HEARTS * (C.INVULN_TIME + 0.1));
  assert.equal(g.status, 'dead');
  assert.equal(g.hearts, 0);
});

test('crossing a zone threshold plants a checkpoint', () => {
  const g = GL.createGame(quietLevel({
    zones: [
      { name: 'Upper', rowMin: 1, rowMax: 5, threshold: 5, ground: 'grass', speedScale: 1 },
      { name: 'Lower', rowMin: 6, rowMax: 10, threshold: null, ground: 'grass', speedScale: 1 }
    ]
  }), 1);
  assert.equal(g.checkpointStage, 0);
  moveFor(g, 0, -1, 0.8);
  assert.equal(g.checkpointStage, 0);
  moveFor(g, 0, -1, 0.5);
  assert.equal(g.checkpointStage, 1);
  assert.ok(g.events.some(e => e.type === 'checkpoint'));
});

// ---------------------------------------------------------------- crowd AI (all levels)

test('wanderers stay in their band and off blocked tiles, in EVERY level', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 99 + li);
    run(g, 8);
    for (const npc of g.npcs) {
      // Marchers/ball-kids are formations: they cross the full width and wrap
      // past the edges, ignoring terrain (like lane traffic) — excluded here.
      if (npc.type === 'marcher' || npc.type === 'ballkid') continue;
      assert.ok(npc.x >= -0.001 && npc.x <= g.cols - 1 + 0.001, `L${li + 1} x in world`);
      assert.ok(npc.y >= npc.yMin - 0.001 && npc.y <= npc.yMax + 0.001,
                `L${li + 1} ${npc.type} stays in its band`);
      if (npc.type !== 'security') { // a chasing guard may briefly overlap a prop tile
        assert.equal(g.terrain[Math.round(npc.y)][Math.round(npc.x)].block, null,
                     `L${li + 1} ${npc.type} off blocked tiles`);
      }
    }
  }
});

test('grouped wanderers stay together as parties', () => {
  const g = GL.createGame(GL.LEVELS[0], 5);
  run(g, 20);
  const groups = {};
  for (const n of g.npcs) if (n.group) (groups[n.group] = groups[n.group] || []).push(n);
  assert.ok(Object.keys(groups).length >= 3);
  for (const name of Object.keys(groups)) {
    const m = groups[name]; if (m.length < 2) continue;
    const cx = m.reduce((s, n) => s + n.x, 0) / m.length;
    const cy = m.reduce((s, n) => s + n.y, 0) / m.length;
    for (const n of m) assert.ok(Math.hypot(n.x - cx, n.y - cy) < 5.0, name + ' stays near its party');
  }
});

test('seated picnickers hold their spot', () => {
  const li = GL.LEVELS.findIndex(L => (L.npcs || []).some(n => n.type === 'seated'));
  assert.ok(li >= 0, 'some ranked level seats picnickers on rugs');
  const g = GL.createGame(GL.LEVELS[li], 3);
  const before = g.npcs.filter(n => n.type === 'seated').map(n => [n.x, n.y]);
  assert.ok(before.length >= 2);
  run(g, 10);
  assert.deepEqual(g.npcs.filter(n => n.type === 'seated').map(n => [n.x, n.y]), before);
});

test('stewards & security patrol routes never cross blocked tiles', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 1);
    for (const npc of g.npcs) {
      if (npc.type !== 'steward' && npc.type !== 'security') continue;
      for (let i = 0; i < npc.waypoints.length; i++) {
        const [ax, ay] = npc.waypoints[i], [bx, by] = npc.waypoints[(i + 1) % npc.waypoints.length];
        for (let k = 0; k <= 20; k++) {
          const x = ax + (bx - ax) * k / 20, y = ay + (by - ay) * k / 20;
          assert.equal(g.terrain[Math.round(y)][Math.round(x)].block, null,
            `L${li + 1} ${npc.type} patrol clear at (${x.toFixed(1)},${y.toFixed(1)})`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------- levels & win

test('later levels feature crossing formations and lines of six ball kids', () => {
  // Formations (marchers) appear in the late ranked levels…
  const anyMarcher = GL.LEVELS.some(L => (L.npcs || []).some(n => n.type === 'marcher'));
  assert.ok(anyMarcher, 'a marching-crowd formation exists somewhere late');
  const early = GL.LEVELS.slice(0, 6).some(L => (L.npcs || []).some(n => n.type === 'marcher'));
  assert.ok(!early, 'no formations in the first six levels');
  // …ball kids come as lines of exactly six with a shared uniform colour.
  const withKids = GL.LEVELS.find(L => (L.npcs || []).some(n => n.type === 'ballkid'));
  assert.ok(withKids, 'some level has ball kids');
  const kids = withKids.npcs.filter(n => n.type === 'ballkid');
  assert.equal(kids.length % 6, 0, 'ball kids come in groups of six');
  assert.ok(kids.every(n => n.uniform === 'green' || n.uniform === 'purple'), 'green or purple uniforms');
});

test('formation members march across their row and wrap at the edges', () => {
  const g = GL.createGame(quietLevel({
    npcs: [{ type: 'marcher', col: 3, row: 4, dir: 1, speed: 2 }]
  }), 1);
  const mch = g.npcs.find(n => n.type === 'marcher');
  assert.ok(mch, 'marcher spawned');
  const y0 = mch.y;
  run(g, 0.3);
  assert.ok(mch.x > 3, 'moved along its row');
  assert.equal(mch.y, y0, 'stays on its row');
  run(g, 10); // long enough to wrap around
  assert.ok(mch.x >= -1.6 && mch.x <= g.cols - 1 + 1.6, 'wrapped within the lane margins');
});

test('reaching the top row wins the level', () => {
  const g = GL.createGame(quietLevel(), 1);
  GL.setMove(g, 0, -1); run(g, 5);
  assert.equal(g.status, 'won');
  assert.ok(g.events.some(e => e.type === 'won'));
});

test('the ranked campaign has 10 long levels with rising size and themes', () => {
  assert.equal(GL.LEVELS.length, 10);
  for (let i = 0; i < GL.LEVELS.length; i++) {
    assert.ok(GL.LEVELS[i].rows >= 44, 'levels are at least ~2x the old length');
    if (i > 0) assert.ok(GL.LEVELS[i].rows >= GL.LEVELS[i - 1].rows, 'levels grow (or hold)');
    assert.ok(typeof GL.LEVELS[i].theme === 'string' && GL.LEVELS[i].theme.length, 'has a theme');
    assert.ok(GL.LEVELS[i].warmth >= 0 && GL.LEVELS[i].warmth <= 1, 'warmth in range');
    assert.ok(GL.LEVELS[i].goldenBerry, 'every level has a golden berry');
  }
});

test('the generator is deterministic; endless levels are valid & winnable', () => {
  // ranked levels are identical each load (fixed seeds — fair leaderboard)
  const a = GL.createGame(GL.LEVELS[6], 1), b = GL.createGame(GL.LEVELS[6], 1);
  assert.deepEqual(a.terrain.map(r => r.map(c => c.block)), b.terrain.map(r => r.map(c => c.block)));
  for (let n = 1; n <= 6; n++) {
    const d1 = GL.generateEndless(n, 777), d2 = GL.generateEndless(n, 777);
    assert.deepEqual(d1.hedges, d2.hedges, 'endless is deterministic for a (n, seed)');
    assert.ok(d1.rows >= 46, 'endless levels are long too');
    const g = GL.createGame(d1, n);
    const seen = new Set(), q = [[d1.startCol, d1.startRow]];
    seen.add(d1.startCol + ',' + d1.startRow);
    let reached = false;
    while (q.length) {
      const [c, r] = q.shift();
      if (r === 0) { reached = true; break; }
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nc = c + dc, nr = r + dr, k = nc + ',' + nr;
        if (!seen.has(k) && GL.tileWalkable(g, nc, nr)) { seen.add(k); q.push([nc, nr]); }
      }
    }
    assert.ok(reached, 'endless level ' + n + ' is winnable on foot');
    assert.ok(g.berries.some(x => x.golden), 'endless level has a golden berry');
  }
});

test('simulation is deterministic for a given seed and loadout', () => {
  const mk = () => GL.createGame(GL.LEVELS[3], 42, { passive: 'speed', items: ['racket', 'accred'] });
  const a = mk(), b = mk();
  run(a, 5); run(b, 5);
  assert.deepEqual(
    a.npcs.map(n => [n.x.toFixed(6), n.y.toFixed(6)]),
    b.npcs.map(n => [n.x.toFixed(6), n.y.toFixed(6)])
  );
});

test('EVERY level has a walkable path from start to the food truck', () => {
  for (let li = 0; li < GL.LEVELS.length; li++) {
    const g = GL.createGame(GL.LEVELS[li], 1);
    const seen = new Set(), q = [[g.level.startCol, g.level.startRow]];
    seen.add(g.level.startCol + ',' + g.level.startRow);
    let reached = false;
    while (q.length) {
      const [c, r] = q.shift();
      if (r === 0) { reached = true; break; }
      for (const [dc, dr] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
        const nc = c + dc, nr = r + dr, k = nc + ',' + nr;
        if (!seen.has(k) && GL.tileWalkable(g, nc, nr)) { seen.add(k); q.push([nc, nr]); }
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
      assert.ok(b.row > 0 && b.row < g.numRows - 1);
    }
    for (const ph of g.photographers) {
      assert.equal(GL.tileWalkable(g, ph.leftCol, ph.row), false);
      assert.equal(GL.tileWalkable(g, ph.rightCol, ph.row), false);
    }
    for (const s of g.sprinklers) assert.equal(GL.tileWalkable(g, s.col, s.row), false);
    run(g, 10);
    assert.equal(g.status, 'playing', `L${li + 1} start row is safe for 10s`);
  }
});

test('mechanics are introduced gradually across the campaign', () => {
  const has = (L, type) => (L.npcs || []).some(n => n.type === type);
  // L1 is only wandering posh — no kids, hazards, or aggressors.
  const L1 = GL.LEVELS[0];
  assert.ok(!has(L1, 'kid') && !has(L1, 'fan') && !has(L1, 'security'), 'L1 is gentle');
  assert.equal((L1.sprinklers || []).length, 0, 'L1 has no sprinklers');
  assert.equal((L1.photographers || []).length, 0, 'L1 has no photographers');
  // Tennis balls only appear from L6 onward.
  for (let i = 0; i < 5; i++) assert.equal((GL.LEVELS[i].tennisCourts || []).length, 0,
    `L${i + 1} has no tennis courts yet`);
  assert.ok((GL.LEVELS[5].tennisCourts || []).length > 0, 'L6 introduces tennis');
  // Security appears from L5 onward, not before.
  assert.ok(!GL.LEVELS.slice(0, 4).some(L => has(L, 'security')), 'no security before L5');
  assert.ok(has(GL.LEVELS[4], 'security'), 'L5 introduces security');
});
