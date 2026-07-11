/*
 * Strawberry Rush — input handling (v6: configurable dash).
 *
 * Keyboard: arrows / WASD are read as a live analog vector — hold any
 * combination for 8-way movement; the logic normalizes it. Dash fires in the
 * direction you ASK for, not the way you were drifting:
 *   - (optional) double-tapping a direction dashes THAT direction, and
 *   - the DASH KEY (default Shift, rebindable) dashes the direction currently
 *     held (or your facing if none).
 * Both triggers are configurable via a mutable `config` object the shell
 * owns: { doubleTapDash: bool, dashKey: code | 'Shift' }. It's read live, so
 * changing it in the Settings screen takes effect immediately.
 *
 * Touch: press and drag = virtual joystick; a quick tap = action; a
 * two-finger tap = dash (in the current drag direction, else facing).
 *
 * The shell polls getMoveVector() each tick and receives onDash(dx, dy) /
 * onAction() callbacks; captureNextKey(cb) grabs one keypress for rebinding.
 */
(function (root) {
  'use strict';

  var TAP_MAX_PX = 14;
  var TAP_MAX_MS = 260;
  var DRAG_DEADZONE = 12;
  var DOUBLE_TAP_MS = 280;

  var KEY_VECS = {
    ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
    ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0]
  };
  var DIR_OF = {
    ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right'
  };
  var DIR_VEC = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function isShift(code) { return code === 'ShiftLeft' || code === 'ShiftRight'; }

  // Friendly name for a key code, for the Settings UI.
  function keyLabel(code) {
    if (code === 'Shift') return 'Shift';
    var map = {
      ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
      ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
      AltLeft: 'Left Alt', AltRight: 'Right Alt', Space: 'Space',
      Tab: 'Tab', Enter: 'Enter', Backquote: '`', Backslash: '\\',
      BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
      Comma: ',', Period: '.', Slash: '/', Minus: '-', Equal: '='
    };
    if (map[code]) return map[code];
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    return code || '?';
  }

  /**
   * config: { doubleTapDash: bool, dashKey: code | 'Shift' } (mutable, read live).
   */
  function createInput(onDash, onAction, config) {
    config = config || { doubleTapDash: true, dashKey: 'Shift' };
    var down = {};            // e.code -> true while held
    var touchVec = null;      // {x, y} while dragging
    var lastTapDir = null, lastTapTime = 0;
    var capturing = false, captureCb = null;

    function keysVec() {
      var x = 0, y = 0;
      for (var code in down) { var v = KEY_VECS[code]; if (v) { x += v[0]; y += v[1]; } }
      return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
    }
    function isDashKey(code) {
      return config.dashKey === 'Shift' ? isShift(code) : code === config.dashKey;
    }

    root.addEventListener('keydown', function (e) {
      // Rebinding: swallow the next usable key and report it.
      if (capturing) {
        e.preventDefault();
        var code = e.code;
        if (code === 'Escape') { capturing = false; var c0 = captureCb; captureCb = null; if (c0) c0(null); return; }
        if (KEY_VECS[code] || code === 'Space' || code === 'Enter') return; // reserved — keep waiting
        capturing = false; var c1 = captureCb; captureCb = null; if (c1) c1(isShift(code) ? 'Shift' : code);
        return;
      }

      if (isDashKey(e.code)) {
        e.preventDefault();
        if (!e.repeat) { var v = keysVec(); onDash(v.x, v.y); } // dash the held direction
        return;
      }
      if (KEY_VECS[e.code]) {
        e.preventDefault();
        if (!e.repeat) {
          down[e.code] = true;
          if (config.doubleTapDash) {
            var dir = DIR_OF[e.code], now = performance.now();
            if (dir === lastTapDir && now - lastTapTime < DOUBLE_TAP_MS) {
              var d = DIR_VEC[dir]; onDash(d[0], d[1]);          // dash the tapped direction
              lastTapDir = null;
            } else { lastTapDir = dir; lastTapTime = now; }
          }
        }
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        onAction();
      }
    });

    root.addEventListener('keyup', function (e) { delete down[e.code]; });
    root.addEventListener('blur', function () { down = {}; touchVec = null; });

    // ------------------------------------------------------------- touch
    var touchStart = null;
    root.addEventListener('touchstart', function (e) {
      var t = e.changedTouches[0];
      if (e.touches.length >= 2) { var tv = touchVec || { x: 0, y: 0 }; onDash(tv.x, tv.y); return; }
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
        if (quick && Math.abs(dx) < TAP_MAX_PX && Math.abs(dy) < TAP_MAX_PX) onAction();
      }
      touchStart = null;
      touchVec = null;
    }, { passive: true });

    return {
      getMoveVector: function () { return touchVec ? { x: touchVec.x, y: touchVec.y } : keysVec(); },
      captureNextKey: function (cb) { capturing = true; captureCb = cb; },
      cancelCapture: function () { capturing = false; captureCb = null; }
    };
  }

  root.GameInput = { createInput: createInput, keyLabel: keyLabel };
})(typeof self !== 'undefined' ? self : this);
