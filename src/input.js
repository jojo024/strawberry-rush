/*
 * Strawberry Rush — input handling (v3: free movement).
 *
 * Keyboard: arrows / WASD are read as a live analog vector — hold any
 * combination for 8-way (diagonal) movement; the logic normalizes it so
 * diagonals aren't faster. SHIFT triggers a dash burst in the direction
 * you're moving (edge-triggered, once per press).
 *
 * Touch: press and drag anywhere = virtual joystick (the drag direction
 * steers you); a quick tap = action; a two-finger tap = dash.
 *
 * This module knows nothing about game rules; the shell polls
 * getMoveVector() every tick and receives onDash/onAction callbacks.
 */
(function (root) {
  'use strict';

  var TAP_MAX_PX = 14;
  var TAP_MAX_MS = 260;
  var DRAG_DEADZONE = 12;

  var KEY_VECS = {
    ArrowUp: [0, -1], KeyW: [0, -1],
    ArrowDown: [0, 1], KeyS: [0, 1],
    ArrowLeft: [-1, 0], KeyA: [-1, 0],
    ArrowRight: [1, 0], KeyD: [1, 0]
  };

  /**
   * onDash() — fired once per Shift press / two-finger tap.
   * onAction() — fired for space/enter/tap (menu advance, restart).
   * Returns { getMoveVector } for the shell's per-tick polling.
   */
  function createInput(onDash, onAction) {
    var down = {};            // e.code -> true while held
    var touchVec = null;      // {x, y} unit-ish vector while dragging

    root.addEventListener('keydown', function (e) {
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
        if (!e.repeat) onDash();
        return;
      }
      if (KEY_VECS[e.code]) {
        e.preventDefault();
        down[e.code] = true;
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        onAction();
      }
    });

    root.addEventListener('keyup', function (e) {
      delete down[e.code];
    });

    // Dropped keyups (alt-tab etc.) shouldn't leave the player running.
    root.addEventListener('blur', function () {
      down = {};
      touchVec = null;
    });

    // ------------------------------------------------------------- touch
    var touchStart = null;
    root.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      if (e.touches.length >= 2) { onDash(); return; }
      touchStart = { x: t.clientX, y: t.clientY, time: performance.now() };
    }, { passive: true });

    root.addEventListener('touchmove', function (e) {
      if (!touchStart) return;
      var t = e.changedTouches[0];
      var dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
      var m = Math.sqrt(dx * dx + dy * dy);
      touchVec = m > DRAG_DEADZONE ? { x: dx / m, y: dy / m } : null;
    }, { passive: true });

    root.addEventListener('touchend', function (e) {
      if (touchStart) {
        var t = e.changedTouches[0];
        var dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
        var quick = performance.now() - touchStart.time < TAP_MAX_MS;
        if (quick && Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX) {
          onAction();
        }
      }
      touchStart = null;
      touchVec = null;
    }, { passive: true });

    return {
      getMoveVector: function () {
        if (touchVec) return { x: touchVec.x, y: touchVec.y };
        var x = 0, y = 0;
        for (var code in down) {
          var v = KEY_VECS[code];
          if (v) { x += v[0]; y += v[1]; }
        }
        // opposite keys cancel; logic normalizes magnitude
        return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
      }
    };
  }

  root.GameInput = { createInput: createInput };
})(typeof self !== 'undefined' ? self : this);
