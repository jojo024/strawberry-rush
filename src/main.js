/*
 * Strawberry Rush — shell: game loop, stage flow, HUD.
 *
 * Fixed-timestep simulation (60 Hz) with render interpolation: the loop
 * accumulates real elapsed time, steps the pure logic in constant DT slices
 * (deterministic collisions and timers regardless of display refresh), and
 * renders once per animation frame with alpha = leftover/DT so movement
 * stays smooth on 120 Hz+ screens.
 */
(function () {
  'use strict';

  var GL = window.GameLogic, GR = window.GameRender;
  var DT = 1 / 60;
  var MAX_FRAME = 0.25; // clamp for tab-switch pauses: avoid a spiral of death

  var canvas = document.getElementById('game');
  var hud = {
    berries: document.getElementById('hud-berries'),
    dash: document.getElementById('hud-dash'),
    stage: document.getElementById('hud-stage'),
    sloth: document.getElementById('hud-sloth'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlaySub: document.getElementById('overlay-sub')
  };

  var shell = {
    mode: 'menu',        // 'menu' | 'playing' | 'stageClear' | 'dead' | 'won'
    stageIndex: 0,
    game: null,
    bank: 0,             // strawberries carried into the current stage
    totalCollected: 0,
    acc: 0,
    last: 0
  };

  // ------------------------------------------------------------- stage flow
  function startStage(index) {
    shell.stageIndex = index;
    shell.game = GL.createGame(GL.STAGES[index], (Date.now() ^ (index * 7919)) >>> 0);
    shell.game.strawberries = shell.bank;
    GR.setupCanvas(canvas, shell.game);
    shell.mode = 'playing';
    hideOverlay();
    updateHud();
  }

  function showOverlay(title, sub) {
    hud.overlayTitle.textContent = title;
    hud.overlaySub.textContent = sub;
    hud.overlay.classList.remove('hidden');
  }
  function hideOverlay() { hud.overlay.classList.add('hidden'); }

  var DEATH_LINES = {
    posh: 'Flattened by a gentleman in linen. He didn’t even notice.',
    wheelchair: 'Clipped by a very determined wheelchair user.',
    kid: 'Taken out by a sprinting child. Naturally.'
  };

  function onGameOver(cause) {
    shell.mode = 'dead';
    showOverlay('Ouch!', (DEATH_LINES[cause] || 'The crowd claims another victim.') +
      '  —  Space to retry this stage.');
  }

  function onStageClear() {
    shell.bank = shell.game.strawberries; // carry the stack to the next lawn
    if (shell.stageIndex >= GL.STAGES.length - 1) {
      shell.mode = 'won';
      showOverlay('LUNCH ACQUIRED 🍓',
        'All 5 stages crossed. Strawberries gathered: ' + shell.totalCollected +
        '.  —  Space to play again.');
    } else {
      shell.mode = 'stageClear';
      showOverlay('Stage ' + (shell.stageIndex + 1) + ' clear!',
        'Next: “' + GL.STAGES[shell.stageIndex + 1].name + '”  —  Space to continue.');
    }
  }

  function onAction() {
    if (shell.mode === 'menu') { shell.bank = 0; shell.totalCollected = 0; startStage(0); }
    else if (shell.mode === 'stageClear') startStage(shell.stageIndex + 1);
    else if (shell.mode === 'dead') startStage(shell.stageIndex); // bank unchanged: retry with what you brought in
    else if (shell.mode === 'won') { shell.bank = 0; shell.totalCollected = 0; startStage(0); }
  }

  function onMove(dir, dash) {
    if (shell.mode !== 'playing') return;
    GL.applyInput(shell.game, dir, dash);
  }

  // ------------------------------------------------------------- HUD
  function pulse(el) {
    el.classList.remove('pulse');
    void el.offsetWidth; // restart the CSS animation
    el.classList.add('pulse');
  }

  function updateHud() {
    var g = shell.game;
    if (!g) return;
    hud.berries.textContent = '🍓 ' + g.strawberries;
    hud.stage.textContent = 'Stage ' + (shell.stageIndex + 1) + '/5 · ' + g.stage.name;
    var armed = g.strawberries >= GL.C.DASH_COST;
    hud.dash.textContent = armed ? 'DASH READY — double-tap!' : 'dash at 3 🍓';
    hud.dash.classList.toggle('armed', armed);
    var slothy = shell.mode === 'playing' && !g.player.hop &&
                 g.slothTimer >= GL.C.SLOTH_GRACE && g.strawberries > 0;
    hud.sloth.classList.toggle('hidden', !slothy);
  }

  function drainEvents() {
    var evts = shell.game.events;
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'berry') { shell.totalCollected++; pulse(hud.berries); }
      else if (e.type === 'photobomb' && e.lost > 0) pulse(hud.berries);
      else if (e.type === 'slothLoss') pulse(hud.berries);
      else if (e.type === 'dead') onGameOver(e.cause);
      else if (e.type === 'stageClear') onStageClear();
    }
    evts.length = 0;
  }

  // ------------------------------------------------------------- game loop
  function frame(now) {
    if (!shell.last) shell.last = now;
    var elapsed = Math.min((now - shell.last) / 1000, MAX_FRAME);
    shell.last = now;

    if (shell.mode === 'playing') {
      shell.acc += elapsed;
      while (shell.acc >= DT) {
        GL.step(shell.game, DT);
        shell.acc -= DT;
        drainEvents();
        if (shell.mode !== 'playing') { shell.acc = 0; break; }
      }
      updateHud();
    }
    if (shell.game) GR.draw(canvas, shell.game, shell.acc / DT);
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------- boot
  GameInput.createInput(onMove, onAction);
  // Pre-render stage 1 behind the menu so the title screen has a backdrop.
  shell.game = GL.createGame(GL.STAGES[0], 20260709);
  GR.setupCanvas(canvas, shell.game);
  shell.mode = 'menu';
  showOverlay('Strawberry Rush 🍓',
    'Cross the crowd, reach the food truck. Arrows/WASD to hop, ' +
    'double-tap to dash (costs your whole stack of 3+). ' +
    'Don’t dawdle, don’t photobomb. — Space to start.');
  updateHud();
  requestAnimationFrame(frame);
})();
