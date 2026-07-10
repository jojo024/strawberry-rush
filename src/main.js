/*
 * Strawberry Rush — shell: game loop, level campaign, HUD.
 *
 * Fixed-timestep simulation (60 Hz) with render interpolation. Free
 * movement: every tick the shell reads the live input vector and feeds it
 * to the logic (GL.setMove); Shift/two-finger tap requests a dash.
 *
 * Campaign: three levels back to back. Strawberries carry over between
 * levels; hearts refill at each level start; dying retries the current
 * level with the berries you brought into it. The best TOTAL time across
 * all three levels persists in localStorage.
 */
(function () {
  'use strict';

  var GL = window.GameLogic, GR = window.GameRender;
  var DT = 1 / 60;
  var MAX_FRAME = 0.25;
  var BEST_KEY = 'strawberryRushBestV4';

  var canvas = document.getElementById('game');
  var hud = {
    hearts: document.getElementById('hud-hearts'),
    berries: document.getElementById('hud-berries'),
    dash: document.getElementById('hud-dash'),
    zone: document.getElementById('hud-zone'),
    time: document.getElementById('hud-time'),
    sloth: document.getElementById('hud-sloth'),
    progress: document.getElementById('progress-fill'),
    toast: document.getElementById('toast'),
    overlay: document.getElementById('overlay'),
    overlayTitle: document.getElementById('overlay-title'),
    overlaySub: document.getElementById('overlay-sub')
  };

  var shell = {
    mode: 'menu',            // 'menu' | 'playing' | 'levelClear' | 'dead' | 'won'
    levelIndex: 0,
    game: null,
    bank: 0,                 // strawberries carried into the current level
    levelStartBank: 0,       // for retries
    totalTime: 0,            // across completed levels
    acc: 0,
    last: 0,
    lastZone: '',
    toastTimer: null
  };
  var input;

  // ------------------------------------------------------------- campaign
  function startLevel(index) {
    shell.levelIndex = index;
    shell.levelStartBank = shell.bank;
    shell.game = GL.createGame(GL.LEVELS[index], (Date.now() ^ (index * 7919)) >>> 0);
    shell.game.strawberries = shell.bank;
    GR.setupCanvas(canvas, shell.game);
    shell.mode = 'playing';
    shell.lastZone = zoneLabel();
    hideOverlay();
    updateHud();
  }

  function startCampaign() {
    shell.bank = 0;
    shell.totalTime = 0;
    startLevel(0);
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
    kid: 'Taken out by a sprinting child. Naturally.',
    steward: 'Escorted firmly off the premises by a steward.',
    fan: 'Mobbed for an autograph you couldn’t give.',
    seated: 'Trod on a picnic. Unforgivable.'
  };

  function fmtTime(t) {
    var m = Math.floor(t / 60);
    var s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }

  function readBest() {
    try { return parseFloat(localStorage.getItem(BEST_KEY)) || null; }
    catch (e) { return null; }
  }
  function writeBest(t) {
    try { localStorage.setItem(BEST_KEY, String(t)); } catch (e) { /* private mode */ }
  }

  function onGameOver(cause) {
    shell.mode = 'dead';
    showOverlay('Out of hearts!',
      (DEATH_LINES[cause] || 'The crowd claims another victim.') +
      '  —  Space to retry ' + GL.LEVELS[shell.levelIndex].name + '.');
  }

  function onLevelWon(e) {
    shell.bank = shell.game.strawberries;
    shell.totalTime += e.time;
    if (shell.levelIndex >= GL.LEVELS.length - 1) {
      shell.mode = 'won';
      var best = readBest();
      var line = 'All ' + GL.LEVELS.length + ' levels crossed in ' +
                 fmtTime(shell.totalTime) + '.';
      if (best === null || shell.totalTime < best) {
        writeBest(shell.totalTime);
        line += best === null ? '' : '  New best! (was ' + fmtTime(best) + ')';
      } else {
        line += '  Best: ' + fmtTime(best) + '.';
      }
      showOverlay('LUNCH ACQUIRED 🍓', line + '  —  Space to run it again.');
    } else {
      shell.mode = 'levelClear';
      showOverlay('Level ' + (shell.levelIndex + 1) + ' clear! (' + fmtTime(e.time) + ')',
        'Next: “' + GL.LEVELS[shell.levelIndex + 1].name + '” — your ' +
        shell.bank + ' 🍓 come with you, hearts refill.  —  Space to continue.');
    }
  }

  function onAction() {
    if (shell.mode === 'menu' || shell.mode === 'won') startCampaign();
    else if (shell.mode === 'levelClear') startLevel(shell.levelIndex + 1);
    else if (shell.mode === 'dead') {
      shell.bank = shell.levelStartBank;
      startLevel(shell.levelIndex);
    }
  }

  function onDash() {
    if (shell.mode === 'playing') GL.tryDash(shell.game);
  }

  // ------------------------------------------------------------- HUD
  function pulse(el) {
    el.classList.remove('pulse');
    void el.offsetWidth;
    el.classList.add('pulse');
  }

  function toast(msg) {
    hud.toast.textContent = msg;
    hud.toast.classList.add('show');
    clearTimeout(shell.toastTimer);
    shell.toastTimer = setTimeout(function () {
      hud.toast.classList.remove('show');
    }, 1700);
  }

  function zoneLabel() {
    var g = shell.game;
    if (!g) return '';
    var zone = GL.zoneForRow(g.level, g.player.row);
    var name = g.player.row === 0 ? 'The Food Truck' : (zone ? zone.name : shell.lastZone);
    return 'L' + (shell.levelIndex + 1) + '/' + GL.LEVELS.length + ' · ' + name;
  }

  function updateHud() {
    var g = shell.game;
    if (!g) return;
    var hearts = '';
    for (var i = 0; i < GL.C.HEARTS; i++) hearts += i < g.hearts ? '❤️' : '🖤';
    hud.hearts.textContent = hearts;
    hud.berries.textContent = '🍓 ' + g.strawberries;
    hud.time.textContent = fmtTime(shell.totalTime + g.time);
    var armed = g.strawberries >= GL.C.DASH_COST;
    hud.dash.textContent = armed ? 'DASH READY — press Shift!' : 'dash at 3 🍓 (Shift)';
    hud.dash.classList.toggle('armed', armed);

    var label = zoneLabel();
    if (label) shell.lastZone = label;
    hud.zone.textContent = shell.lastZone;

    hud.progress.style.width =
      Math.round(100 * (1 - g.player.row / g.level.startRow)) + '%';

    var slothy = shell.mode === 'playing' && !g.player.moving &&
                 g.slothTimer >= GL.C.SLOTH_GRACE && g.strawberries > 0;
    hud.sloth.classList.toggle('hidden', !slothy);
  }

  function drainEvents() {
    var evts = shell.game.events;
    if (!evts.length) return;
    GR.onEvents(shell.game, evts);
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'berry' || e.type === 'goldBerry') pulse(hud.berries);
      else if (e.type === 'photobomb' && e.lost > 0) { pulse(hud.berries); toast('Photobombed! −' + e.lost + ' 🍓'); }
      else if (e.type === 'slothLoss') pulse(hud.berries);
      else if (e.type === 'sprinklerHit') { pulse(hud.berries); toast('Soaked! −' + e.lost + ' 🍓'); }
      else if (e.type === 'hit') { pulse(hud.hearts); if (e.hearts > 0) toast('Ouch! Back to the checkpoint.'); }
      else if (e.type === 'checkpoint') toast('Checkpoint — ' + e.zone);
      else if (e.type === 'fanSpotted') toast('A fan has spotted you — run!');
      else if (e.type === 'dead') onGameOver(e.cause);
      else if (e.type === 'won') onLevelWon(e);
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
        var v = input.getMoveVector();
        GL.setMove(shell.game, v.x, v.y);
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
  input = GameInput.createInput(onDash, onAction);
  window.addEventListener('resize', function () {
    if (shell.game) GR.resize(canvas, shell.game);
  });
  shell.game = GL.createGame(GL.LEVELS[0], 20260710);
  GR.setupCanvas(canvas, shell.game);
  shell.mode = 'menu';
  var best = readBest();
  showOverlay('Strawberry Rush 🍓',
    'An evening run across ' + GL.LEVELS.length + ' lantern-lit grounds to ' +
    'the food truck. Move freely with arrows/WASD (combine for diagonals). ' +
    'Shift dashes when you carry 3+ 🍓 — it spends the whole stack. ' +
    '3 hearts per level, checkpoints at every zone, berries carry over. ' +
    (best !== null ? 'Best campaign: ' + fmtTime(best) + '. ' : '') +
    '— Space to start.');
  updateHud();
  requestAnimationFrame(frame);
})();
