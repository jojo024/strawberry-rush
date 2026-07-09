/*
 * Strawberry Rush — input handling.
 *
 * Keyboard: arrows or WASD move one tile per deliberate tap (key auto-repeat
 * is ignored). A double-tap of the same direction within DOUBLE_TAP_MS asks
 * for a dash — the logic module decides whether the player can afford it.
 *
 * Touch: swipe to hop, double-swipe the same direction to dash, plain tap
 * hops forward.
 */
(function (root) {
  'use strict';

  var DOUBLE_TAP_MS = 260;
  var SWIPE_MIN_PX = 24;

  var KEYMAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  };

  /**
   * onMove(dir, dash) — fired for every movement intent.
   * onAction() — fired for space/enter/tap (menu advance, restart).
   */
  function createInput(onMove, onAction) {
    var lastDir = null, lastTime = 0;

    function intent(dir) {
      var now = performance.now();
      var dash = (dir === lastDir && now - lastTime < DOUBLE_TAP_MS);
      // A consumed double-tap resets the chain so a triple-tap doesn't
      // read as two dashes.
      lastDir = dash ? null : dir;
      lastTime = now;
      onMove(dir, dash);
    }

    root.addEventListener('keydown', function (e) {
      if (e.repeat) return;
      var dir = KEYMAP[e.code];
      if (dir) {
        e.preventDefault();
        intent(dir);
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        onAction();
      }
    });

    // ------------------------------------------------------------- touch
    var touchStart = null;
    root.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      touchStart = { x: t.clientX, y: t.clientY, time: performance.now() };
    }, { passive: true });

    root.addEventListener('touchend', function (e) {
      if (!touchStart) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) < SWIPE_MIN_PX && Math.abs(dy) < SWIPE_MIN_PX) {
        onAction();          // tap: menu advance…
        intent('up');        // …and hop forward while playing
        return;
      }
      if (Math.abs(dx) > Math.abs(dy)) intent(dx > 0 ? 'right' : 'left');
      else intent(dy > 0 ? 'down' : 'up');
    }, { passive: true });
  }

  root.GameInput = { createInput: createInput, DOUBLE_TAP_MS: DOUBLE_TAP_MS };
})(typeof self !== 'undefined' ? self : this);
