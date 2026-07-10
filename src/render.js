/*
 * Strawberry Rush — renderer (v3: dusk garden party, fullscreen).
 *
 * Everything is drawn procedurally (zero image assets). The scene is a
 * summer evening: deep indigo sky with twinkling stars and a moon, a warm
 * ember of sunset on the horizon, strings of fairy lights sagging across
 * the grounds, lanterns on the hedge gates, fireflies over the lawns, and
 * drifting ground mist. Crowds read as dark evening-wear figures with warm
 * rim light; strawberries glow like embers so they pop against the dark.
 *
 * Presentation is pseudo-3D and fullscreen:
 *  - the canvas fills the window; the world is drawn in a fixed logical
 *    space (cols*TILE wide) and scaled crisply to device pixels;
 *  - a smoothed camera follows the player up the scrolling grounds;
 *  - perspective sprite scaling (nearer = larger), y-sorted props/people,
 *    drop shadows, walk cycles, squash-and-stretch hops;
 *  - light pools under every bulb and around the player, drawn additively;
 *  - particles (sparkles, splashes, confetti) and camera shake.
 *
 * The renderer owns only cosmetic state (camera, particles, shake); the
 * simulation stays pure. draw() takes the game plus an interpolation factor
 * `alpha` (0..1 between the previous and current fixed-timestep positions).
 */
(function (root) {
  'use strict';

  var TILE = 46;            // logical pixels per tile (world width = cols*TILE)
  var SKY_H = 170;          // sky band above row 0, in logical px
  var NIGHT_AFTER = 150;    // seconds until full night has settled in

  var PALETTE = {
    purple: '#4a2377',
    purpleLight: '#8a5fc9',
    accent: '#7ef0d0',
    skin: ['#e8b88f', '#c98f5a', '#7d5230', '#5d3c1f'],
    // evening wear: muted, richer than daytime pastels
    outfits: ['#cbb9a4', '#a97b96', '#7590b5', '#b3a05f', '#8d81b8', '#74a591', '#b57575'],
    black: '#101018',
    grass: {                // [even stripe, odd stripe] per zone
      queue:     ['#22423a', '#1d3b33'],
      terrace:   ['#254840', '#204139'],
      courtside: ['#1f4a50', '#1a4348'],
      goal:      ['#1d474d', '#1d474d']
    },
    path: '#3b3743',
    pathSpeck: '#4c4759',
    blanket: '#57232f',
    hedgeFront: '#132821',
    hedgeTop: '#1d382c',
    water: 'rgba(150,215,250,0.85)',
    bulb: '#ffd9a0',
    bulbGlow: 'rgba(255,190,110,',
    ember: 'rgba(255,90,80,'
  };

  // Small deterministic hash -> [0,1): stable procedural decoration that
  // never flickers between frames.
  function hash(a, b, c) {
    var h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  // Renderer-owned cosmetic state.
  var S = {
    cam: 0, camTarget: 0,
    viewH: 620,             // logical viewport height (derived from window)
    fit: 1,                 // window px per logical px
    lastNow: 0,
    shakeT: 0, shakeMag: 0,
    particles: [],
    props: [],              // static y-sorted scenery, built at setup
    strands: [],            // fairy-light strands (world rows)
    lanterns: [],           // lantern posts [{x,y}]
    fireflies: [],
    vignette: null
  };

  // ------------------------------------------------------------- setup
  function computeViewport(canvas, game) {
    var winW = root.innerWidth || 690;
    var winH = root.innerHeight || 620;
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    S.fit = winW / (game.cols * TILE);
    S.viewH = winH / S.fit;
    canvas.width = Math.round(winW * dpr);
    canvas.height = Math.round(winH * dpr);
    canvas.dataset.scale = dpr * S.fit;
    S.vignette = makeVignette(game.cols * TILE, S.viewH);
  }

  function setupCanvas(canvas, game) {
    computeViewport(canvas, game);
    S.cam = S.camTarget = camTargetFor(game, game.player.y);
    S.particles.length = 0;
    S.shakeT = 0;
    S.props = buildProps(game);

    // Fairy-light strands span the grounds every few rows; lantern posts
    // flank each hedge gate.
    S.strands = [];
    for (var r = 2.5; r < game.numRows - 2; r += 4.5) S.strands.push(r);
    S.lanterns = [];
    (game.level.hedges || []).forEach(function (h) {
      h.gaps.forEach(function (gap) {
        // Mount on the hedge tiles flanking the gate — never inside the
        // doorway itself (gates can be several tiles wide).
        [gap - 1, gap + 1].forEach(function (c) {
          if (c < 0 || c >= game.cols) return;
          if (game.terrain[h.row][c].block !== 'hedge') return;
          for (var i = 0; i < S.lanterns.length; i++) {
            if (S.lanterns[i].x === c && S.lanterns[i].y === h.row) return;
          }
          S.lanterns.push({ x: c, y: h.row });
        });
      });
    });

    S.fireflies = [];
    for (var i = 0; i < 7; i++) {
      S.fireflies.push({
        x: hash(i, 1, game.seed) * game.cols,
        y: 3 + hash(i, 2, game.seed) * (game.numRows - 6),
        a: hash(i, 3, game.seed) * 6.28, t: i * 1.7
      });
    }
    return canvas.getContext('2d');
  }

  /** Recompute sizes on window resize without resetting cosmetic state. */
  function resize(canvas, game) {
    computeViewport(canvas, game);
    S.cam = S.camTarget = camTargetFor(game, game.player.y);
  }

  function makeVignette(w, h) {
    var c = root.document ? root.document.createElement('canvas') : null;
    if (!c) return null;
    c.width = Math.max(2, Math.round(w)); c.height = Math.max(2, Math.round(h));
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 0.9);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(4,6,16,0.5)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // Static scenery becomes sortable "props" so entities can pass in front
  // of and behind them. Hedge/barrier runs are merged per row.
  function buildProps(game) {
    var props = [];
    var r, c;
    for (r = 0; r < game.numRows; r++) {
      var runStart = -1, runKind = null;
      for (c = 0; c <= game.cols; c++) {
        var block = c < game.cols ? game.terrain[r][c].block : null;
        var mergeable = (block === 'hedge' || block === 'barrier') ? block : null;
        if (mergeable && mergeable === runKind) continue;
        if (runKind) {
          props.push({ y: r, kind: runKind, row: r, c0: runStart, c1: c - 1 });
        }
        runKind = mergeable;
        runStart = c;
        if (block === 'tree' || block === 'umbrella') {
          props.push({ y: r, kind: block, row: r, col: c });
        }
      }
    }
    props.push({ y: 0.45, kind: 'truck' });
    return props;
  }

  // ------------------------------------------------------------- camera
  function camTargetFor(game, playerY) {
    var worldH = game.numRows * TILE;
    return clamp(playerY * TILE - S.viewH * 0.58, -SKY_H, Math.max(-SKY_H, worldH - S.viewH));
  }

  // Perspective: things lower on screen (nearer the camera) are larger.
  // (Gentler now that the camera is zoomed out.)
  function scaleAt(sy) {
    return 0.85 + 0.28 * clamp(sy / S.viewH, 0, 1);
  }

  // Fairy-light strand bulbs, spaced by world width (shared by the strand
  // sprite and its ground light pools so they always line up).
  function bulbCount(w) {
    return Math.max(6, Math.round(w / 85));
  }

  // ------------------------------------------------------------- sky
  function drawSky(ctx, game, w, horizon, nightT) {
    var top = horizon - SKY_H;
    var g = ctx.createLinearGradient(0, top, 0, horizon);
    g.addColorStop(0, '#0b1030');
    g.addColorStop(0.55, '#231a4a');
    g.addColorStop(0.85, mixRgb([122, 58, 82], [58, 32, 66], nightT));
    g.addColorStop(1, mixRgb([210, 110, 70], [110, 55, 60], nightT)); // sunset ember
    ctx.fillStyle = g;
    ctx.fillRect(0, top, w, SKY_H);

    // Stars twinkle, brightening as the night settles.
    for (var st = 0; st < 60; st++) {
      var sx = hash(st, 1, 9) * w;
      var sy = top + hash(st, 2, 9) * SKY_H * 0.7;
      var tw = 0.35 + 0.65 * Math.abs(Math.sin(game.time * (0.6 + hash(st, 3, 9)) + st));
      ctx.fillStyle = 'rgba(240,240,255,' + (tw * (0.35 + 0.55 * nightT)) + ')';
      var ss = hash(st, 4, 9) < 0.12 ? 2 : 1.2;
      ctx.fillRect(sx, sy, ss, ss);
    }

    // Crescent moon with a soft halo.
    var mx = w * 0.78, my = top + SKY_H * 0.24;
    var halo = ctx.createRadialGradient(mx, my, 4, mx, my, 46);
    halo.addColorStop(0, 'rgba(235,240,255,0.35)');
    halo.addColorStop(1, 'rgba(235,240,255,0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(mx, my, 46, 0, 7); ctx.fill();
    ctx.fillStyle = '#eef1fa';
    ctx.beginPath(); ctx.arc(mx, my, 13, 0, 7); ctx.fill();
    ctx.fillStyle = '#231a4a';
    ctx.beginPath(); ctx.arc(mx - 6, my - 3, 11, 0, 7); ctx.fill();

    // Dark cloud wisps sliding slowly.
    ctx.fillStyle = 'rgba(10,14,38,0.5)';
    for (var cl = 0; cl < 3; cl++) {
      var span = w + 300;
      var cxp = ((game.time * (3 + cl) + cl * span / 3) % span) - 150;
      var cyp = top + SKY_H * (0.3 + 0.15 * cl);
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, 70, 9, 0, 0, 7);
      ctx.ellipse(cxp + 40, cyp + 5, 50, 7, 0, 0, 7);
      ctx.fill();
    }

    // Night balloon drifting, burner flickering.
    var bx = ((game.time * 7) % (w + 160)) - 80;
    var by = top + SKY_H * 0.34 + Math.sin(game.time * 0.5) * 5;
    drawBalloon(ctx, game, bx, by);

    // Distant stands: black silhouette, warm lit windows, pennants.
    var standH = 36;
    ctx.fillStyle = '#0a0f1e';
    ctx.fillRect(0, horizon - standH, w, standH);
    ctx.fillStyle = '#070b17';
    for (var s = 0; s < w; s += 90) {
      ctx.beginPath();
      ctx.moveTo(s, horizon - standH);
      ctx.lineTo(s + 45, horizon - standH - 14);
      ctx.lineTo(s + 90, horizon - standH);
      ctx.fill();
    }
    for (var d = 0; d < w; d += 7) { // warm windows / crowd lights
      var hsh = hash(d, 17, game.seed);
      var flick = Math.sin(game.time * (0.8 + hsh * 2) + d) > 0.3 ? 1 : 0.4;
      ctx.fillStyle = 'rgba(255,196,120,' + (flick * (0.25 + hsh * 0.5)) + ')';
      ctx.fillRect(d, horizon - standH + 9 + hsh * 18, 2.4, 2.4);
    }
    for (var f = 40; f < w; f += 140) { // pennants, backlit
      ctx.strokeStyle = 'rgba(190,190,210,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(f, horizon - standH - 12); ctx.lineTo(f, horizon - standH - 40);
      ctx.stroke();
      var wave = Math.sin(game.time * 3 + f) * 5;
      ctx.fillStyle = f % 280 === 40 ? 'rgba(138,95,201,0.8)' : 'rgba(126,240,208,0.55)';
      ctx.beginPath();
      ctx.moveTo(f, horizon - standH - 40);
      ctx.quadraticCurveTo(f + 12, horizon - standH - 38 + wave,
                           f + 24, horizon - standH - 34 + wave);
      ctx.lineTo(f, horizon - standH - 30);
      ctx.fill();
    }
  }

  function mixRgb(a, b, t) {
    return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' +
      Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')';
  }

  function drawBalloon(ctx, game, x, y) {
    ctx.fillStyle = '#1c1633';
    ctx.beginPath(); ctx.arc(x, y, 14, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.quadraticCurveTo(x, y + 20, x, y + 22);
    ctx.quadraticCurveTo(x, y + 20, x + 14, y); ctx.fill();
    // burner flame flicker lights the envelope from below
    var fl = 0.5 + 0.5 * Math.sin(game.time * 11);
    ctx.fillStyle = 'rgba(255,170,60,' + (0.25 + 0.35 * fl) + ')';
    ctx.beginPath(); ctx.arc(x, y + 14, 7 + fl * 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#3b2c22';
    ctx.fillRect(x - 4, y + 24, 8, 6);
  }

  // ------------------------------------------------------------- ground
  function groundStyleFor(game, r) {
    if (r === 0) return PALETTE.grass.goal;
    var zones = game.level.zones || [];
    var zone = root.GameLogic ? root.GameLogic.zoneForRow(game.level, r) : null;
    var idx = zone ? zones.indexOf(zone) : -1;
    // Zones are listed top-down: 0 = the finale lawn, last = the entrance.
    if (idx === 0) return PALETTE.grass.courtside;
    if (idx === zones.length - 1) return PALETTE.grass.queue;
    return PALETTE.grass.terrace;
  }

  function drawGround(ctx, game, cam, w) {
    var r0 = Math.max(0, Math.floor(cam / TILE));
    var r1 = Math.min(game.numRows - 1, Math.ceil((cam + S.viewH) / TILE));
    for (var r = r0; r <= r1; r++) {
      var y = r * TILE - cam;
      for (var c = 0; c < game.cols; c++) {
        var cell = game.terrain[r][c];
        var x = c * TILE;
        if (cell.t === 'path') {
          ctx.fillStyle = PALETTE.path;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = PALETTE.pathSpeck;
          for (var p = 0; p < 3; p++) {
            var hx = hash(c * 7 + p, r, game.seed);
            ctx.fillRect(x + hx * (TILE - 4), y + hash(c, r * 5 + p, 3) * (TILE - 4), 2.5, 2.5);
          }
        } else if (cell.t === 'blanket') {
          drawBlanketTile(ctx, game, c, r, x, y);
        } else {
          var g = groundStyleFor(game, r);
          ctx.fillStyle = (r + c) % 2 === 0 ? g[0] : g[1];
          ctx.fillRect(x, y, TILE, TILE);
          if (((r + c * 2) % 6) < 2) { // faint mower sheen
            ctx.fillStyle = 'rgba(160,220,200,0.03)';
            ctx.fillRect(x, y, TILE, TILE);
          }
          if (r > 0) drawNightFlower(ctx, game, c, r, x, y);
        }
      }
    }

    // Chalk sidelines, faint in the dark.
    ctx.fillStyle = 'rgba(220,235,240,0.12)';
    ctx.fillRect(3, Math.max(0, -cam), 2, S.viewH);
    ctx.fillRect(w - 5, Math.max(0, -cam), 2, S.viewH);
  }

  function drawNightFlower(ctx, game, c, r, x, y) {
    var h = hash(c, r, game.seed);
    if (h > 0.12) return; // sparse pale blooms catching the light
    var fx = x + (0.2 + hash(c, r, 7) * 0.6) * TILE;
    var fy = y + (0.2 + hash(c, r, 11) * 0.6) * TILE;
    ctx.fillStyle = h < 0.05 ? 'rgba(214,190,240,0.5)' : 'rgba(235,225,210,0.42)';
    for (var p = 0; p < 4; p++) {
      var a = p * Math.PI / 2 + h * 6;
      ctx.beginPath();
      ctx.arc(fx + Math.cos(a) * 2.4, fy + Math.sin(a) * 2.4, 1.9, 0, 7);
      ctx.fill();
    }
  }

  function drawBlanketTile(ctx, game, c, r, x, y) {
    ctx.fillStyle = PALETTE.blanket;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = 'rgba(230,208,185,0.22)';
    var stripe = TILE / 5;
    ctx.fillRect(x, y + stripe, TILE, stripe * 0.6);
    ctx.fillRect(x, y + stripe * 3.2, TILE, stripe * 0.6);
    ctx.fillRect(x + stripe, y, stripe * 0.6, TILE);
    ctx.fillRect(x + stripe * 3.2, y, stripe * 0.6, TILE);
    ctx.strokeStyle = 'rgba(20,10,12,0.5)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
    if (hash(c, r, 31) < 0.2) { // a candle jar on some rugs
      ctx.fillStyle = 'rgba(255,200,120,0.9)';
      ctx.beginPath(); ctx.arc(x + TILE * 0.75, y + TILE * 0.3, 3, 0, 7); ctx.fill();
      ctx.fillStyle = PALETTE.bulbGlow + '0.18)';
      ctx.beginPath(); ctx.arc(x + TILE * 0.75, y + TILE * 0.3, 10, 0, 7); ctx.fill();
    }
  }

  // Ground mist drifting over the lawns.
  function drawMist(ctx, game, cam, w) {
    ctx.fillStyle = 'rgba(170,190,230,0.045)';
    var worldH = game.numRows * TILE;
    for (var i = 0; i < 4; i++) {
      var span = w + 700;
      var cx = ((game.time * (5 + i * 2) + i * 733) % span) - 350;
      var cy = ((game.time * (2.5 + i) + i * 977) % (worldH + 600)) - 300 - cam;
      if (cy < -220 || cy > S.viewH + 220) continue;
      ctx.beginPath();
      ctx.ellipse(cx, cy, 200 + i * 30, 70 + i * 12, 0.35, 0, 7);
      ctx.fill();
    }
  }

  // All the warm light pools, drawn additively in one pass: fairy-light
  // strands, lanterns, and the soft pool the player carries.
  function drawLightPools(ctx, game, cam, w, alpha) {
    ctx.globalCompositeOperation = 'lighter';
    var i, b;
    var NB = bulbCount(w);
    for (i = 0; i < S.strands.length; i++) {
      var ry = S.strands[i] * TILE - cam;
      if (ry < -TILE * 2 || ry > S.viewH + TILE * 2) continue;
      for (b = 1; b <= NB; b++) {
        var bx = (b / (NB + 1)) * w;
        pool(ctx, bx, ry, TILE * 1.5, 0.05 + 0.012 * Math.sin(game.time * 2 + b + i * 3));
      }
    }
    for (i = 0; i < S.lanterns.length; i++) {
      var ly = (S.lanterns[i].y + 0.5) * TILE - cam;
      if (ly < -TILE * 2 || ly > S.viewH + TILE * 2) continue;
      pool(ctx, (S.lanterns[i].x + 0.5) * TILE, ly, TILE * 1.9,
           0.10 + 0.02 * Math.sin(game.time * 3 + i));
    }
    var px = (lerp(game.player.px, game.player.x, alpha) + 0.5) * TILE;
    var py = (lerp(game.player.py, game.player.y, alpha) + 0.5) * TILE - cam;
    pool(ctx, px, py, TILE * 2.4, 0.07);
    ctx.globalCompositeOperation = 'source-over';
  }

  function pool(ctx, x, y, r, a) {
    var g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, PALETTE.bulbGlow + a + ')');
    g.addColorStop(1, PALETTE.bulbGlow + '0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }

  // Fairy-light strands themselves: sagging wires with warm bulbs.
  function drawStrand(ctx, game, row, cam, w) {
    var baseY = row * TILE - cam;
    var lift = TILE * 1.5; // strung overhead
    ctx.strokeStyle = 'rgba(30,30,45,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, baseY - lift);
    ctx.quadraticCurveTo(w / 2, baseY - lift + 26, w, baseY - lift);
    ctx.stroke();
    var NB = bulbCount(w);
    for (var b = 1; b <= NB; b++) {
      var u = b / (NB + 1);
      var bx = u * w;
      var by = baseY - lift + 26 * 2 * u * (1 - u) * 2; // parabola sag
      var tw = 0.75 + 0.25 * Math.sin(game.time * 3 + b * 1.3 + row);
      ctx.fillStyle = PALETTE.bulbGlow + (0.22 * tw) + ')';
      ctx.beginPath(); ctx.arc(bx, by + 4, 8, 0, 7); ctx.fill();
      ctx.fillStyle = PALETTE.bulb;
      ctx.beginPath(); ctx.arc(bx, by + 4, 2.6, 0, 7); ctx.fill();
    }
    // end poles
    ctx.strokeStyle = '#22222e'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(2, baseY); ctx.lineTo(2, baseY - lift);
    ctx.moveTo(w - 2, baseY); ctx.lineTo(w - 2, baseY - lift);
    ctx.stroke();
  }

  function drawLantern(ctx, game, ln, cam) {
    var cx = (ln.x + 0.5) * TILE;
    var yBase = (ln.y + 0.6) * TILE - cam;
    var h = TILE * 1.25;
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, yBase); ctx.lineTo(cx, yBase - h); ctx.stroke();
    var fl = 0.8 + 0.2 * Math.sin(game.time * 5 + ln.x * 3 + ln.y);
    ctx.fillStyle = PALETTE.bulbGlow + (0.3 * fl) + ')';
    ctx.beginPath(); ctx.arc(cx, yBase - h, 12, 0, 7); ctx.fill();
    ctx.fillStyle = '#ffe2b0';
    ctx.beginPath(); ctx.arc(cx, yBase - h, 4.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 5.5, yBase - h - 6, 11, 12);
  }

  // Ground-level hazard telegraphs (drawn on the lawn, under entities).
  function drawHazardZones(ctx, game, cam) {
    var i;
    for (i = 0; i < game.photographers.length; i++) {
      var ph = game.photographers[i];
      if (ph.phase === 'idle') continue;
      var flashing = ph.phase === 'flash';
      ctx.fillStyle = flashing ? 'rgba(255,255,255,0.8)'
        : 'rgba(255,214,80,' + (0.16 + 0.14 * Math.sin(game.time * 20)) + ')';
      for (var d = 0; d < ph.dangerCols.length; d++) {
        ctx.fillRect(ph.dangerCols[d] * TILE, ph.row * TILE - cam, TILE, TILE);
      }
    }
    for (i = 0; i < game.sprinklers.length; i++) {
      var s = game.sprinklers[i];
      if (s.phase === 'idle') continue;
      var cx = (s.col + 0.5) * TILE, cy = (s.row + 0.5) * TILE - cam;
      if (s.phase === 'warn') {
        ctx.strokeStyle = 'rgba(150,215,250,' + (0.3 + 0.25 * Math.sin(game.time * 14)) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, TILE * 1.45, 0, 7); ctx.stroke();
      } else { // spray: moonlit water
        ctx.fillStyle = 'rgba(120,190,240,0.16)';
        ctx.fillRect((s.col - 1) * TILE, (s.row - 1) * TILE - cam, TILE * 3, TILE * 3);
        ctx.strokeStyle = PALETTE.water;
        ctx.lineWidth = 2.5;
        var spin = game.time * 5;
        for (var j = 0; j < 6; j++) {
          var a = spin + j * Math.PI / 3;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5 - 8);
          ctx.quadraticCurveTo(
            cx + Math.cos(a) * TILE * 0.8, cy + Math.sin(a) * TILE * 0.8 - 16,
            cx + Math.cos(a) * TILE * 1.35, cy + Math.sin(a) * TILE * 1.35);
          ctx.stroke();
        }
      }
    }
    // Checkpoint marker: a softly glowing pennant.
    var cp = game.checkpoint;
    if (game.checkpointStage > 0) {
      var mx = (cp.col + 0.5) * TILE, my = (cp.row + 0.5) * TILE - cam;
      ctx.fillStyle = 'rgba(126,240,208,0.12)';
      ctx.beginPath(); ctx.arc(mx, my, TILE * 0.55, 0, 7); ctx.fill();
      ctx.strokeStyle = '#cfe8dd'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx + 8, my); ctx.lineTo(mx + 8, my - 18); ctx.stroke();
      ctx.fillStyle = PALETTE.accent;
      ctx.beginPath();
      ctx.moveTo(mx + 8, my - 18);
      ctx.lineTo(mx + 20, my - 14 + Math.sin(game.time * 4) * 1.5);
      ctx.lineTo(mx + 8, my - 10);
      ctx.fill();
    }
  }

  // ------------------------------------------------------------- berries
  function drawBerry(ctx, game, b, cam) {
    var sy0 = (b.row + 0.5) * TILE - cam;
    if (sy0 < -TILE || sy0 > S.viewH + TILE) return;
    var sc = scaleAt(sy0) * (b.golden ? 1.25 : 1);
    var bob = Math.sin(game.time * 3 + b.col * 1.7 + b.row) * 2.2;
    var cx = (b.col + 0.5) * TILE, cy = sy0 + bob;
    var R = TILE * 0.20 * sc;

    ellipseShadow(ctx, cx, sy0 + TILE * 0.3 * sc, R * 0.9, 0.25);
    // Ember glow: every berry is a little beacon in the dark.
    var pulse = 0.5 + 0.5 * Math.sin(game.time * 4 + b.col + b.row * 2);
    var glowCol = b.golden ? 'rgba(255,214,80,' : PALETTE.ember;
    var glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, R * (b.golden ? 3.4 : 2.6));
    glow.addColorStop(0, glowCol + (0.28 + 0.14 * pulse) + ')');
    glow.addColorStop(1, glowCol + '0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, R * (b.golden ? 3.4 : 2.6), 0, 7); ctx.fill();

    var body = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.3, R * 0.2, cx, cy, R * 1.4);
    if (b.golden) { body.addColorStop(0, '#ffedb0'); body.addColorStop(1, '#e0a12e'); }
    else { body.addColorStop(0, '#ff6a70'); body.addColorStop(1, '#b81b26'); }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.moveTo(cx, cy + R * 1.1);
    ctx.bezierCurveTo(cx - R * 1.3, cy, cx - R, cy - R * 0.9, cx, cy - R * 0.7);
    ctx.bezierCurveTo(cx + R, cy - R * 0.9, cx + R * 1.3, cy, cx, cy + R * 1.1);
    ctx.fill();
    ctx.fillStyle = '#2f6b3c';
    ctx.beginPath();
    ctx.ellipse(cx, cy - R * 0.8, R * 0.6, R * 0.28, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = b.golden ? '#fff6dd' : '#ffd9a8';
    ctx.fillRect(cx - R * 0.5, cy - R * 0.1, 1.6, 2.4);
    ctx.fillRect(cx + R * 0.3, cy + R * 0.1, 1.6, 2.4);
  }

  // ------------------------------------------------------------- props
  function ellipseShadow(ctx, cx, cy, rw, alpha) {
    ctx.fillStyle = 'rgba(0,0,10,' + (alpha || 0.25) + ')';
    ctx.beginPath();
    ctx.ellipse(cx, cy, rw, rw * 0.32, 0, 0, 7);
    ctx.fill();
  }

  function drawHedgeRun(ctx, game, prop, cam) {
    var x = prop.c0 * TILE, w = (prop.c1 - prop.c0 + 1) * TILE;
    var yBase = (prop.row + 0.85) * TILE - cam;
    var hgt = TILE * 0.82;
    ellipseShadow(ctx, x + w / 2, yBase + 3, w * 0.5, 0.2);
    ctx.fillStyle = PALETTE.hedgeFront;
    ctx.fillRect(x + 1, yBase - hgt * 0.55, w - 2, hgt * 0.55);
    ctx.fillStyle = PALETTE.hedgeTop;
    ctx.beginPath();
    ctx.moveTo(x + 1, yBase - hgt * 0.5);
    for (var c = prop.c0; c <= prop.c1; c++) {
      ctx.arc((c + 0.5) * TILE, yBase - hgt * 0.5, TILE * 0.52, Math.PI, 0);
    }
    ctx.lineTo(x + w - 1, yBase - hgt * 0.5);
    ctx.closePath(); ctx.fill();
    for (var d = 0; d < w; d += 7) {
      var h = hash(prop.row, d, game.seed);
      ctx.fillStyle = h < 0.5 ? 'rgba(190,230,210,0.04)' : 'rgba(0,0,0,0.12)';
      ctx.fillRect(x + d, yBase - hgt * (0.15 + h * 0.75), 3, 3);
    }
  }

  function drawBarrierRun(ctx, prop, cam) {
    var x0 = prop.c0 * TILE + 4, x1 = (prop.c1 + 1) * TILE - 4;
    var yBase = (prop.row + 0.72) * TILE - cam;
    ellipseShadow(ctx, (x0 + x1) / 2, yBase + 4, (x1 - x0) * 0.5, 0.14);
    ctx.strokeStyle = '#565e6b'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, yBase - TILE * 0.42); ctx.lineTo(x1, yBase - TILE * 0.42);
    ctx.moveTo(x0, yBase - TILE * 0.2); ctx.lineTo(x1, yBase - TILE * 0.2);
    ctx.stroke();
    ctx.fillStyle = '#3f4550';
    for (var x = x0; x <= x1; x += TILE) {
      ctx.fillRect(x - 2, yBase - TILE * 0.5, 4, TILE * 0.5);
    }
    // glowing rope swag between posts
    ctx.strokeStyle = 'rgba(138,95,201,0.8)'; ctx.lineWidth = 2;
    for (var s = x0; s + TILE <= x1 + 2; s += TILE) {
      ctx.beginPath();
      ctx.moveTo(s, yBase - TILE * 0.32);
      ctx.quadraticCurveTo(s + TILE / 2, yBase - TILE * 0.22, s + TILE, yBase - TILE * 0.32);
      ctx.stroke();
    }
  }

  function drawTree(ctx, game, prop, cam) {
    var cx = (prop.col + 0.5) * TILE;
    var yBase = (prop.row + 0.8) * TILE - cam;
    var sc = scaleAt(yBase);
    var sway = Math.sin(game.time * 1.2 + prop.col * 2.3) * 2.5;
    ellipseShadow(ctx, cx + 5, yBase + 2, TILE * 0.75 * sc, 0.28);
    ctx.fillStyle = '#2c2019';
    ctx.fillRect(cx - 4 * sc, yBase - TILE * 0.9 * sc, 8 * sc, TILE * 0.9 * sc);
    var tiers = [[0.95, 0.62], [0.62, 0.5], [0.32, 0.36]];
    for (var i = 0; i < tiers.length; i++) {
      var ty = yBase - TILE * (0.75 + i * 0.42) * sc;
      ctx.fillStyle = i % 2 === 0 ? '#15332a' : '#1b3f30';
      ctx.beginPath();
      ctx.ellipse(cx + sway * (i + 1) * 0.4, ty, TILE * tiers[i][1] * sc,
                  TILE * tiers[i][1] * 0.8 * sc, 0, 0, 7);
      ctx.fill();
    }
    // fairy lights wound through the canopy
    for (var fl = 0; fl < 8; fl++) {
      var h1 = hash(prop.col, fl, 3), h2 = hash(prop.row, fl, 5);
      var lx = cx + (h1 - 0.5) * TILE * 1.1 * sc + sway * 0.5;
      var lyy = yBase - TILE * (0.6 + h2 * 1.1) * sc;
      var tw = 0.5 + 0.5 * Math.sin(game.time * 2.5 + fl * 2 + prop.col);
      ctx.fillStyle = ['rgba(255,190,110,', 'rgba(126,240,208,', 'rgba(255,140,160,'][fl % 3] +
        (0.45 + 0.4 * tw) + ')';
      ctx.beginPath(); ctx.arc(lx, lyy, 2, 0, 7); ctx.fill();
    }
  }

  function drawUmbrella(ctx, game, prop, cam) {
    var cx = (prop.col + 0.5) * TILE;
    var yBase = (prop.row + 0.8) * TILE - cam;
    var sc = scaleAt(yBase);
    ellipseShadow(ctx, cx + 4, yBase + 2, TILE * 0.7 * sc, 0.24);
    ctx.fillStyle = '#464a55';
    ctx.fillRect(cx - 2 * sc, yBase - TILE * 1.05 * sc, 4 * sc, TILE * 1.05 * sc);
    var R = TILE * 0.72 * sc;
    var top = yBase - TILE * 1.05 * sc;
    for (var i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#33235c' : '#d9cbb2';
      ctx.beginPath();
      ctx.moveTo(cx, top);
      ctx.arc(cx, top + R * 0.35, R, Math.PI + i * Math.PI / 6, Math.PI + (i + 1) * Math.PI / 6);
      ctx.closePath(); ctx.fill();
    }
    // a warm bulb hung under the canopy
    ctx.fillStyle = PALETTE.bulbGlow + '0.3)';
    ctx.beginPath(); ctx.arc(cx, top + R * 0.5, 9, 0, 7); ctx.fill();
    ctx.fillStyle = PALETTE.bulb;
    ctx.beginPath(); ctx.arc(cx, top + R * 0.5, 2.5, 0, 7); ctx.fill();
  }

  function drawTruck(ctx, game, cam) {
    var w = TILE * 4.8, h = TILE * 1.15;
    var x = (game.cols * TILE - w) / 2, y = TILE * 0.02 - cam - h * 0.35;
    ellipseShadow(ctx, x + w / 2, y + h + 4, w * 0.5, 0.28);
    var body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, '#5a3a8f');
    body.addColorStop(1, '#33205c');
    ctx.fillStyle = body;
    roundRect(ctx, x, y + h * 0.16, w, h * 0.84, 9); ctx.fill();
    ctx.fillStyle = '#d9cbb2';
    roundRect(ctx, x + 6, y, w - 12, h * 0.3, 6); ctx.fill();
    ctx.fillStyle = '#8f2e3c';
    for (var i = 0; i < 6; i++) {
      ctx.fillRect(x + 6 + i * (w - 12) / 6, y, (w - 12) / 12, h * 0.3);
    }
    // bulbs along the awning edge
    for (var bb = 0; bb <= 8; bb++) {
      var bx = x + 8 + bb * (w - 16) / 8;
      var tw = 0.6 + 0.4 * Math.sin(game.time * 4 + bb);
      ctx.fillStyle = PALETTE.bulbGlow + (0.3 * tw) + ')';
      ctx.beginPath(); ctx.arc(bx, y + h * 0.32, 6, 0, 7); ctx.fill();
      ctx.fillStyle = PALETTE.bulb;
      ctx.beginPath(); ctx.arc(bx, y + h * 0.32, 2, 0, 7); ctx.fill();
    }
    // glowing serving hatch — the warmest light on the grounds
    ctx.fillStyle = '#ffdf9e';
    ctx.fillRect(x + w * 0.12, y + h * 0.34, w * 0.5, h * 0.42);
    var hg = ctx.createRadialGradient(x + w * 0.37, y + h * 0.55, 4, x + w * 0.37, y + h * 0.55, w * 0.5);
    hg.addColorStop(0, PALETTE.bulbGlow + '0.25)');
    hg.addColorStop(1, PALETTE.bulbGlow + '0)');
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(x + w * 0.37, y + h * 0.55, w * 0.5, 0, 7); ctx.fill();
    // silhouette of the vendor in the hatch
    ctx.fillStyle = '#241a38';
    ctx.beginPath(); ctx.arc(x + w * 0.3, y + h * 0.62, 7, 0, 7); ctx.fill();
    ctx.fillRect(x + w * 0.3 - 9, y + h * 0.62 + 4, 18, 12);
    ctx.fillStyle = '#f5eedd';
    ctx.font = 'bold ' + Math.round(TILE * 0.32) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('LUNCH', x + w * 0.78, y + h * 0.5);
    ctx.fillStyle = '#d8262f';
    ctx.beginPath(); ctx.arc(x + w * 0.78, y + h * 0.8, TILE * 0.1, 0, 7); ctx.fill();
    ctx.fillStyle = PALETTE.black;
    ctx.beginPath(); ctx.arc(x + w * 0.18, y + h, TILE * 0.14, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.82, y + h, TILE * 0.14, 0, 7); ctx.fill();
  }

  function drawSprinklerHead(ctx, game, s, cam) {
    var cx = (s.col + 0.5) * TILE, cy = (s.row + 0.62) * TILE - cam;
    var sc = scaleAt(cy);
    ellipseShadow(ctx, cx, cy + 3, TILE * 0.24 * sc, 0.2);
    ctx.fillStyle = '#23262e';
    ctx.beginPath();
    ctx.ellipse(cx, cy, TILE * 0.2 * sc, TILE * 0.12 * sc, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = s.phase === 'idle' ? '#3c414c' : '#8fd0f0';
    ctx.fillRect(cx - 3 * sc, cy - TILE * 0.24 * sc, 6 * sc, TILE * 0.2 * sc);
  }

  // ------------------------------------------------------------- people
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /**
   * A little evening-lit person. cx/cy = feet-center in SCREEN px, sc =
   * perspective scale. opts: bodyW/bodyH/headR (tile fractions), body
   * (color), skin, hat ('sun'|'cap'|'boater'|null), hatColor, phase (walk
   * cycle), moving, facing (-1/+1), lift (px), alpha, seated.
   */
  function drawFigure(ctx, cx, cy, sc, opts) {
    var bw = opts.bodyW * TILE * sc, bh = opts.bodyH * TILE * sc;
    var hr = opts.headR * TILE * sc;
    var bob = opts.moving ? Math.abs(Math.sin(opts.phase)) * 2 * sc : 0;
    var lift = (opts.lift || 0);
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;

    ellipseShadow(ctx, cx, cy, bw * 0.62 * (1 - lift / 60), 0.28);
    cy -= lift + bob;

    if (opts.seated) {
      // cushion
      ctx.fillStyle = 'rgba(20,12,16,0.7)';
      ctx.beginPath(); ctx.ellipse(cx, cy, bw * 0.7, bw * 0.26, 0, 0, 7); ctx.fill();
      bh *= 0.72;
    } else if (opts.moving) { // scissor legs
      var la = Math.sin(opts.phase) * bw * 0.28;
      ctx.strokeStyle = opts.legs || '#191722';
      ctx.lineWidth = Math.max(2.5, bw * 0.18);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.16, cy - bh * 0.25);
      ctx.lineTo(cx - bw * 0.16 + la, cy + 2);
      ctx.moveTo(cx + bw * 0.16, cy - bh * 0.25);
      ctx.lineTo(cx + bw * 0.16 - la, cy + 2);
      ctx.stroke();
    }

    // Body: dark evening tones with a warm rim from the string lights.
    var g = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    g.addColorStop(0, lighten(opts.body, 0.12));
    g.addColorStop(1, darken(opts.body, 0.38));
    ctx.fillStyle = g;
    roundRect(ctx, cx - bw / 2, cy - bh, bw, bh * (opts.moving ? 0.92 : 1), bw * 0.4);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,190,120,0.28)'; // rim light, upper-left
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.arc(cx - bw * 0.06, cy - bh + bw * 0.42, bw * 0.42, Math.PI * 1.05, Math.PI * 1.6);
    ctx.stroke();

    ctx.fillStyle = opts.skin;
    ctx.beginPath();
    ctx.arc(cx + (opts.facing || 0) * hr * 0.15, cy - bh - hr * 0.35, hr, 0, 7);
    ctx.fill();

    var hy = cy - bh - hr * 0.35;
    if (opts.hat === 'sun') {
      ctx.fillStyle = opts.hatColor || '#d9cbb2';
      ctx.beginPath();
      ctx.ellipse(cx, hy - hr * 0.55, hr * 1.7, hr * 0.55, 0, 0, 7); ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, hy - hr * 0.6, hr * 0.85, Math.PI, 0); ctx.fill();
    } else if (opts.hat === 'cap') {
      ctx.fillStyle = opts.hatColor || '#31527d';
      ctx.beginPath();
      ctx.arc(cx, hy - hr * 0.35, hr * 0.9, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - hr * 0.9 * (opts.facing >= 0 ? -0.1 : 1),
                   hy - hr * 0.4, hr * 1.0, hr * 0.28);
    } else if (opts.hat === 'boater') {
      ctx.fillStyle = opts.hatColor || '#cbbd97';
      ctx.beginPath();
      ctx.ellipse(cx, hy - hr * 0.5, hr * 1.35, hr * 0.4, 0, 0, 7); ctx.fill();
      ctx.fillRect(cx - hr * 0.7, hy - hr * 1.1, hr * 1.4, hr * 0.6);
      ctx.fillStyle = '#3c2a63';
      ctx.fillRect(cx - hr * 0.7, hy - hr * 0.75, hr * 1.4, hr * 0.22);
    }
    ctx.globalAlpha = 1;
  }

  var _tint = {};
  function shade(hex, k) {
    var key = hex + '|' + k;
    if (_tint[key]) return _tint[key];
    var v = parseInt(hex.slice(1), 16);
    var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    if (k > 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
    var out = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
    _tint[key] = out;
    return out;
  }
  function lighten(hex, k) { return hex[0] === '#' ? shade(hex, k) : hex; }
  function darken(hex, k) { return hex[0] === '#' ? shade(hex, -k) : hex; }

  function outfitFor(game, npc, idx) {
    // Group members dress alike (same base outfit, small variation).
    var key = npc.group ? hashStr(npc.group) : idx * 7 + 3;
    var base = PALETTE.outfits[Math.floor(hash(key, 3, game.seed) * PALETTE.outfits.length)];
    return base;
  }

  function hashStr(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  function drawNpc(ctx, game, npc, idx, cam, alpha) {
    var x = lerp(npc.px, npc.x, alpha), y = lerp(npc.py, npc.y, alpha);
    var sy = (y + 0.5) * TILE - cam;
    if (sy < -TILE * 1.5 || sy > S.viewH + TILE * 1.5) return;
    var cx = (x + 0.5) * TILE;
    var sc = scaleAt(sy);
    var facing = Math.cos(npc.heading) >= 0 ? 1 : -1;
    var moving = npc.mode !== 'stopped';
    var phase = game.time * (3 + (npc.speed || 1) * 4) + idx * 1.7;
    var outfit = outfitFor(game, npc, idx);
    var skin = PALETTE.skin[Math.floor(hash(idx, 5, game.seed) * PALETTE.skin.length)];

    if (npc.type === 'seated') {
      drawFigure(ctx, cx, sy, sc, {
        bodyW: 0.42, bodyH: 0.4, headR: 0.11,
        body: outfit, skin: skin, seated: true,
        hat: hash(idx, 8, game.seed) < 0.5 ? 'sun' : null,
        phase: 0, moving: false, facing: idx % 2 ? 1 : -1
      });
      if (hash(idx, 11, game.seed) < 0.6) { // glass raised to the evening
        ctx.fillStyle = '#e8d98f';
        ctx.fillRect(cx + (idx % 2 ? 1 : -1) * TILE * 0.24 * sc,
                     sy - TILE * 0.4 * sc, 3 * sc, 7 * sc);
      }
    } else if (npc.type === 'wheelchair') {
      drawWheelchair(ctx, game, cx, sy, sc, facing, outfit, skin, idx);
    } else if (npc.type === 'kid') {
      drawFigure(ctx, cx, sy, sc, {
        bodyW: 0.26, bodyH: 0.26, headR: 0.10,
        body: outfit, skin: skin, hat: 'cap',
        hatColor: hash(idx, 4, 2) < 0.5 ? '#31527d' : '#8f3d4a',
        phase: phase, moving: moving, facing: facing
      });
      // kids carry glow sticks at night
      var gcol = ['rgba(126,240,208,', 'rgba(255,140,160,', 'rgba(160,150,255,'][idx % 3];
      ctx.strokeStyle = gcol + '0.9)'; ctx.lineWidth = 2.5 * sc;
      ctx.beginPath();
      ctx.moveTo(cx + facing * TILE * 0.16 * sc, sy - TILE * 0.2 * sc);
      ctx.lineTo(cx + facing * TILE * 0.26 * sc, sy - TILE * 0.34 * sc);
      ctx.stroke();
    } else if (npc.type === 'steward') {
      drawFigure(ctx, cx, sy, sc, {
        bodyW: 0.42, bodyH: 0.46, headR: 0.11,
        body: '#232f4d', legs: '#141c30', skin: skin,
        hat: 'cap', hatColor: '#101a30',
        phase: phase, moving: true, facing: facing
      });
      var viz = 0.6 + 0.4 * Math.sin(game.time * 6 + idx); // hi-vis glows
      ctx.fillStyle = 'rgba(242,207,74,' + viz + ')';
      ctx.fillRect(cx - TILE * 0.16 * sc, sy - TILE * 0.42 * sc, TILE * 0.09 * sc, TILE * 0.34 * sc);
    } else if (npc.type === 'fan') {
      drawFigure(ctx, cx, sy, sc, {
        bodyW: 0.36, bodyH: 0.4, headR: 0.11,
        body: npc.chasing ? '#b8404d' : '#96586e', skin: skin, hat: 'boater',
        phase: phase * (npc.chasing ? 1.8 : 1), moving: moving, facing: facing
      });
      ctx.fillStyle = '#e8e2d2'; // autograph book, brandished
      ctx.fillRect(cx + facing * TILE * 0.22 * sc, sy - TILE * 0.5 * sc, 8 * sc, 6 * sc);
      if (npc.chasing) {
        ctx.fillStyle = '#ffdf5e';
        ctx.font = 'bold ' + Math.round(TILE * 0.34 * sc) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', cx, sy - TILE * 0.85 * sc - Math.abs(Math.sin(game.time * 8)) * 4);
      }
    } else { // posh
      drawFigure(ctx, cx, sy, sc, {
        bodyW: 0.5, bodyH: 0.46, headR: 0.12,
        body: outfit, skin: skin, hat: 'sun',
        phase: phase, moving: moving, facing: facing
      });
      if (hash(idx, 13, game.seed) < 0.3) {
        ctx.fillStyle = '#e8d98f';
        ctx.fillRect(cx + facing * TILE * 0.3 * sc, sy - TILE * 0.46 * sc, 3 * sc, 7 * sc);
      }
    }
    if (npc.mode === 'stopped') {
      ctx.fillStyle = 'rgba(235,235,245,0.8)';
      ctx.font = Math.round(TILE * 0.25 * sc) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('…', cx + TILE * 0.3 * sc, sy - TILE * 0.66 * sc);
    }
  }

  function drawWheelchair(ctx, game, cx, cy, sc, facing, outfit, skin, idx) {
    ellipseShadow(ctx, cx, cy, TILE * 0.36 * sc, 0.26);
    var spin = game.time * 7 + idx;
    ctx.strokeStyle = '#454552'; ctx.lineWidth = 3 * sc;
    ctx.beginPath();
    ctx.arc(cx - facing * TILE * 0.14 * sc, cy - TILE * 0.1 * sc, TILE * 0.18 * sc, 0, 7);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(126,240,208,0.5)'; ctx.lineWidth = 1.5 * sc;
    for (var s = 0; s < 3; s++) { // glow-rimmed spokes sell the motion
      var a = spin + s * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(cx - facing * TILE * 0.14 * sc - Math.cos(a) * TILE * 0.16 * sc,
                 cy - TILE * 0.1 * sc - Math.sin(a) * TILE * 0.16 * sc);
      ctx.lineTo(cx - facing * TILE * 0.14 * sc + Math.cos(a) * TILE * 0.16 * sc,
                 cy - TILE * 0.1 * sc + Math.sin(a) * TILE * 0.16 * sc);
      ctx.stroke();
    }
    ctx.strokeStyle = '#454552'; ctx.lineWidth = 3 * sc;
    ctx.beginPath();
    ctx.arc(cx + facing * TILE * 0.2 * sc, cy - TILE * 0.04 * sc, TILE * 0.09 * sc, 0, 7);
    ctx.stroke();
    ctx.fillStyle = outfit;
    roundRect(ctx, cx - TILE * 0.14 * sc, cy - TILE * 0.42 * sc, TILE * 0.3 * sc, TILE * 0.36 * sc, 6 * sc);
    ctx.fill();
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(cx, cy - TILE * 0.5 * sc, TILE * 0.11 * sc, 0, 7); ctx.fill();
  }

  function drawPhotographerPair(ctx, game, ph, cam) {
    var sy = (ph.row + 0.5) * TILE - cam;
    if (sy < -TILE || sy > S.viewH + TILE) return;
    drawOnePhotographer(ctx, game, ph, ph.leftCol, sy, 1);
    drawOnePhotographer(ctx, game, ph, ph.rightCol, sy, -1);
  }

  function drawOnePhotographer(ctx, game, ph, col, sy, face) {
    var cx = (col + 0.5) * TILE;
    var sc = scaleAt(sy);
    drawFigure(ctx, cx, sy, sc, {
      bodyW: 0.4, bodyH: 0.42, headR: 0.11,
      body: '#8a8474', skin: PALETTE.skin[Math.floor(hash(col, ph.row, game.seed) * PALETTE.skin.length)],
      hat: null, phase: 0, moving: false, facing: face
    });
    var px = cx + face * TILE * 0.28 * sc, py = sy - TILE * 0.38 * sc;
    ctx.fillStyle = '#15151d';
    ctx.fillRect(px - 4 * sc, py - 7 * sc, 8 * sc, 14 * sc);
    ctx.fillStyle = 'rgba(126,240,208,0.9)'; // phone screen glow
    ctx.fillRect(px - 2.5 * sc, py - 5 * sc, 5 * sc, 10 * sc);
    if (ph.phase === 'charging') {
      ctx.fillStyle = 'rgba(255,215,64,' + (0.5 + 0.5 * Math.sin(game.time * 24)) + ')';
      ctx.beginPath(); ctx.arc(px, py - 12 * sc, 4 * sc, 0, 7); ctx.fill();
    }
    if (ph.phase === 'flash') { // a night flash is blinding
      var g = ctx.createRadialGradient(px, py, 2, px, py, TILE * 2.2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, TILE * 2.2, 0, 7); ctx.fill();
    }
  }

  function drawPlayer(ctx, game, cam, alpha) {
    var p = game.player;
    var x = lerp(p.px, p.x, alpha), y = lerp(p.py, p.y, alpha);
    var cx = (x + 0.5) * TILE, sy = (y + 0.5) * TILE - cam;
    var sc = scaleAt(sy);

    var a = 1;
    if (game.invuln > 0) a = (Math.sin(game.time * 22) > 0) ? 0.9 : 0.35;

    // Free movement: run bob + lean into the direction of travel; a dash
    // stretches the body and leaves a glowing trail behind it.
    var bob = 0, stretch = 1, lean = 0;
    if (p.moving) {
      bob = Math.abs(Math.sin(game.time * 11)) * 2.2 * sc;
      lean = p.dirX * 2.5 * sc;
    }
    if (p.dash) {
      stretch = 1.2;
      ctx.strokeStyle = 'rgba(126,240,208,0.5)';
      ctx.lineWidth = TILE * 0.28 * sc; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - p.dash.dx * TILE * 1.3, sy - p.dash.dy * TILE * 1.3);
      ctx.lineTo(cx, sy);
      ctx.stroke();
    }

    ctx.globalAlpha = a;
    ellipseShadow(ctx, cx, sy, TILE * 0.26 * sc, 0.32);
    var cy = sy - bob;
    cx += lean;

    var bw = TILE * 0.38 * sc, bh = TILE * 0.48 * sc * stretch;
    ctx.strokeStyle = PALETTE.black;
    ctx.lineWidth = Math.max(3, bw * 0.2); ctx.lineCap = 'round';
    if (p.moving) { // running scissor legs
      var la = Math.sin(game.time * 11) * bw * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.18, cy - bh * 0.22);
      ctx.lineTo(cx - bw * 0.18 + la, sy + 2);
      ctx.moveTo(cx + bw * 0.18, cy - bh * 0.22);
      ctx.lineTo(cx + bw * 0.18 - la, sy + 2);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.18, cy - bh * 0.2); ctx.lineTo(cx - bw * 0.18, cy + 2);
      ctx.moveTo(cx + bw * 0.18, cy - bh * 0.2); ctx.lineTo(cx + bw * 0.18, cy + 2);
      ctx.stroke();
    }
    var g = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    g.addColorStop(0, '#2e2d38');
    g.addColorStop(1, '#0c0c12');
    ctx.fillStyle = g;
    roundRect(ctx, cx - bw / 2, cy - bh, bw, bh, bw * 0.35);
    ctx.fill();
    ctx.fillStyle = '#e0af84';
    ctx.beginPath(); ctx.arc(cx, cy - bh - TILE * 0.09 * sc, TILE * 0.115 * sc, 0, 7); ctx.fill();
    // glowing headset — the player's signature at night
    ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2.5 * sc;
    ctx.beginPath();
    ctx.arc(cx, cy - bh - TILE * 0.09 * sc, TILE * 0.13 * sc, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.fillStyle = PALETTE.accent;
    ctx.beginPath(); ctx.arc(cx - TILE * 0.13 * sc, cy - bh - TILE * 0.08 * sc, 3 * sc, 0, 7); ctx.fill();
    ctx.fillStyle = '#c5342b';
    ctx.fillRect(cx + TILE * 0.08 * sc, cy - bh * 0.25, 5 * sc, 8 * sc);

    if (p.stun > 0) { // dripping wet
      ctx.fillStyle = PALETTE.water;
      for (var d = 0; d < 3; d++) {
        var t = (game.time * 2 + d * 0.4) % 1;
        ctx.beginPath();
        ctx.arc(cx - 8 + d * 8, cy - bh - 14 + t * 20, 2.5, 0, 7);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- particles
  function spawn(x, y, opts) {
    S.particles.push({
      x: x, y: y,
      vx: opts.vx || 0, vy: opts.vy || 0,
      g: opts.g || 0, life: opts.life || 0.6, age: 0,
      size: opts.size || 3, color: opts.color || '#fff',
      fade: opts.fade !== false
    });
    if (S.particles.length > 400) S.particles.splice(0, S.particles.length - 400);
  }

  function burst(x, y, n, mk) {
    for (var i = 0; i < n; i++) mk(i, Math.PI * 2 * i / n + Math.random() * 0.5);
  }

  /** The shell forwards logic events here for cosmetic reactions. */
  function onEvents(game, events) {
    var p = game.player;
    var px = (p.x + 0.5) * TILE, py = (p.y + 0.5) * TILE; // world px
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'berry' || e.type === 'goldBerry') {
        var col = e.type === 'goldBerry' ? '#ffd650' : '#ff8091';
        burst(px, py, e.type === 'goldBerry' ? 18 : 9, function (j, a) {
          spawn(px, py, { vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 40,
                          g: 160, life: 0.55, size: 2.5, color: col });
        });
      } else if (e.type === 'dash') {
        burst(px, py, 12, function (j, a) {
          spawn(px, py, { vx: Math.cos(a) * 90, vy: Math.sin(a) * 30,
                          life: 0.4, size: 3, color: 'rgba(126,240,208,0.9)' });
        });
      } else if (e.type === 'hit') {
        S.shakeT = 0.45; S.shakeMag = 7;
        burst(px, py, 14, function (j, a) {
          spawn(px, py, { vx: Math.cos(a) * 120, vy: Math.sin(a) * 120 - 60,
                          g: 260, life: 0.6, size: 3, color: '#e0524f' });
        });
      } else if (e.type === 'dead') {
        S.shakeT = 0.7; S.shakeMag = 10;
      } else if (e.type === 'photobomb') {
        S.shakeT = 0.25; S.shakeMag = 4;
      } else if (e.type === 'sprinklerHit') {
        S.shakeT = 0.3; S.shakeMag = 4;
        burst(px, py, 16, function (j, a) {
          spawn(px, py - 10, { vx: Math.cos(a) * 80, vy: -Math.abs(Math.sin(a)) * 130,
                               g: 300, life: 0.7, size: 2.5, color: 'rgba(140,205,240,0.9)' });
        });
      } else if (e.type === 'checkpoint') {
        burst(px, py, 12, function (j, a) {
          spawn(px, py, { vx: Math.cos(a) * 50, vy: Math.sin(a) * 50 - 70,
                          g: 120, life: 0.8, size: 2.5, color: '#7ef0d0' });
        });
      } else if (e.type === 'won') {
        for (var cfx = 0; cfx < 90; cfx++) {
          spawn(Math.random() * game.cols * TILE, -20 + Math.random() * -200, {
            vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 80, g: 30,
            life: 3.5, size: 3 + Math.random() * 3,
            color: ['#e0524f', '#ffd650', '#8a5fc9', '#7ef0d0', '#f2d8e1'][cfx % 5]
          });
        }
      }
    }
  }

  function stepAndDrawParticles(ctx, cam, dt) {
    for (var i = S.particles.length - 1; i >= 0; i--) {
      var pt = S.particles[i];
      pt.age += dt;
      if (pt.age >= pt.life) { S.particles.splice(i, 1); continue; }
      pt.vy += pt.g * dt;
      pt.x += pt.vx * dt;
      pt.y += pt.vy * dt;
      var k = 1 - pt.age / pt.life;
      ctx.globalAlpha = pt.fade ? k : 1;
      ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - cam - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;
  }

  function stepAndDrawFireflies(ctx, game, cam, dt) {
    for (var i = 0; i < S.fireflies.length; i++) {
      var b = S.fireflies[i];
      b.t += dt;
      b.a += (hash(i, Math.floor(b.t), 5) - 0.5) * 2.2 * dt * 4;
      b.x += Math.cos(b.a) * 0.4 * dt;
      b.y += Math.sin(b.a) * 0.4 * dt;
      b.x = clamp(b.x, 0.5, game.cols - 1.5);
      b.y = clamp(b.y, 1, game.numRows - 2);
      var sx = (b.x + 0.5) * TILE;
      var sy = (b.y + 0.5) * TILE - cam + Math.sin(b.t * 3) * 4;
      if (sy < -20 || sy > S.viewH + 20) continue;
      var pulse = Math.max(0, Math.sin(b.t * 2.2 + i * 2)); // slow breathing glow
      ctx.fillStyle = 'rgba(200,255,160,' + (0.12 + 0.3 * pulse) + ')';
      ctx.beginPath(); ctx.arc(sx, sy, 5 + pulse * 3, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(230,255,190,' + (0.5 + 0.5 * pulse) + ')';
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }
  }

  // ------------------------------------------------------------- main draw
  function draw(canvas, game, alpha) {
    var ctx = canvas.getContext('2d');
    var scale = parseFloat(canvas.dataset.scale || '1');
    var w = game.cols * TILE;
    var now = performance.now();
    var dt = S.lastNow ? clamp((now - S.lastNow) / 1000, 0, 0.05) : 0.016;
    S.lastNow = now;

    // Smoothed camera chase of the interpolated player.
    var py = lerp(game.player.py, game.player.y, alpha);
    S.camTarget = camTargetFor(game, py);
    S.cam += (S.camTarget - S.cam) * Math.min(1, dt * 6);
    var cam = S.cam;

    ctx.save();
    ctx.scale(scale, scale);

    if (S.shakeT > 0) {
      S.shakeT -= dt;
      var m = S.shakeMag * Math.max(0, S.shakeT) * 2;
      ctx.translate(Math.sin(now * 0.09) * m, Math.cos(now * 0.117) * m);
    }

    var nightT = clamp(game.time / NIGHT_AFTER, 0, 1);

    // Base fill, then sky above the world's top edge.
    ctx.fillStyle = '#0c1220';
    ctx.fillRect(0, 0, w, S.viewH);
    var horizon = -cam; // screen y of world row 0's top edge
    if (horizon > 0) drawSky(ctx, game, w, horizon, nightT);

    drawGround(ctx, game, cam, w);
    drawHazardZones(ctx, game, cam);
    drawLightPools(ctx, game, cam, w, alpha);
    drawMist(ctx, game, cam, w);

    for (var i = 0; i < game.berries.length; i++) {
      if (game.berries[i].alive) drawBerry(ctx, game, game.berries[i], cam);
    }
    for (var sp = 0; sp < game.sprinklers.length; sp++) {
      drawSprinklerHead(ctx, game, game.sprinklers[sp], cam);
    }

    // Painter's order: props + people + player, sorted by world y.
    var order = [];
    for (var pr = 0; pr < S.props.length; pr++) order.push(S.props[pr]);
    for (var ln = 0; ln < S.lanterns.length; ln++) {
      order.push({ y: S.lanterns[ln].y + 0.1, kind: 'lantern', ln: S.lanterns[ln] });
    }
    for (var st = 0; st < S.strands.length; st++) {
      order.push({ y: S.strands[st], kind: 'strand', row: S.strands[st] });
    }
    for (var n = 0; n < game.npcs.length; n++) {
      order.push({ y: lerp(game.npcs[n].py, game.npcs[n].y, alpha),
                   kind: 'npc', npc: game.npcs[n], idx: n });
    }
    for (var f = 0; f < game.photographers.length; f++) {
      order.push({ y: game.photographers[f].row, kind: 'photo',
                   ph: game.photographers[f] });
    }
    order.push({ y: lerp(game.player.py, game.player.y, alpha) + 0.01,
                 kind: 'player' });
    order.sort(function (a, b) { return a.y - b.y; });

    for (var o = 0; o < order.length; o++) {
      var it = order[o];
      var sy = (it.y + 0.5) * TILE - cam;
      if (sy < -TILE * 3.5 || sy > S.viewH + TILE * 3.5) continue;
      if (it.kind === 'hedge') drawHedgeRun(ctx, game, it, cam);
      else if (it.kind === 'barrier') drawBarrierRun(ctx, it, cam);
      else if (it.kind === 'tree') drawTree(ctx, game, it, cam);
      else if (it.kind === 'umbrella') drawUmbrella(ctx, game, it, cam);
      else if (it.kind === 'truck') drawTruck(ctx, game, cam);
      else if (it.kind === 'lantern') drawLantern(ctx, game, it.ln, cam);
      else if (it.kind === 'strand') drawStrand(ctx, game, it.row, cam, w);
      else if (it.kind === 'npc') drawNpc(ctx, game, it.npc, it.idx, cam, alpha);
      else if (it.kind === 'photo') drawPhotographerPair(ctx, game, it.ph, cam);
      else if (it.kind === 'player') drawPlayer(ctx, game, cam, alpha);
    }

    stepAndDrawFireflies(ctx, game, cam, dt);
    stepAndDrawParticles(ctx, cam, dt);

    // Whole-screen glint while any flash is live — dazzling at night.
    for (var fl = 0; fl < game.photographers.length; fl++) {
      if (game.photographers[fl].phase === 'flash') {
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(0, 0, w, S.viewH);
        break;
      }
    }

    // The night deepens slightly as the run goes on.
    if (nightT > 0.02) {
      ctx.fillStyle = 'rgba(8,10,30,' + (0.10 * nightT) + ')';
      ctx.fillRect(0, 0, w, S.viewH);
    }
    if (S.vignette) ctx.drawImage(S.vignette, 0, 0, w, S.viewH);

    ctx.restore();
  }

  root.GameRender = {
    TILE: TILE,
    setupCanvas: setupCanvas, resize: resize, draw: draw, onEvents: onEvents
  };
})(typeof self !== 'undefined' ? self : this);
