/*
 * Strawberry Rush — canvas renderer.
 *
 * Everything is drawn procedurally (zero image assets). Wimbledon palette:
 * striped lawns, purple accents, white-and-pastel crowd, player in black.
 * The renderer is stateless with respect to the simulation: it takes the
 * game state plus an interpolation factor `alpha` (0..1 between the previous
 * and current fixed-timestep positions) and draws one frame.
 */
(function (root) {
  'use strict';

  var TILE = 48; // logical pixels per tile; CSS scales the canvas to fit

  var PALETTE = {
    grassA: '#4e9a51',
    grassB: '#469049',
    goalGrass: '#3c8a44',
    path: '#e9e2cd',
    pathEdge: '#d6cdb2',
    purple: '#4a2377',
    purpleLight: '#7a52ad',
    skin: ['#f1c9a5', '#d9a066', '#8d5a2b', '#6b4423'],
    pastels: ['#f7f3ea', '#f2d8e1', '#d8e6f2', '#efe8c8', '#e2d9f0', '#d9efe2'],
    black: '#1a1a1f'
  };

  // Small deterministic hash -> [0,1): stable procedural decoration
  // (flowers, crowd colour choices) that never flickers between frames.
  function hash(a, b, c) {
    var h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function setupCanvas(canvas, game) {
    var dpr = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = game.cols * TILE * dpr;
    canvas.height = game.numRows * TILE * dpr;
    canvas.dataset.dpr = dpr;
    return canvas.getContext('2d');
  }

  // ------------------------------------------------------------- background
  function drawBackground(ctx, game) {
    var rows = game.stage.rows;
    for (var r = 0; r < game.numRows; r++) {
      var y = r * TILE;
      var kind = rows[r].kind;
      if (kind === 'lane') {
        ctx.fillStyle = PALETTE.path;
        ctx.fillRect(0, y, game.cols * TILE, TILE);
        ctx.fillStyle = PALETTE.pathEdge;
        ctx.fillRect(0, y, game.cols * TILE, 2);
        ctx.fillRect(0, y + TILE - 2, game.cols * TILE, 2);
      } else {
        // Mown-stripe lawn: alternate greens per row, subtle column stripes.
        ctx.fillStyle = (r % 2 === 0) ? PALETTE.grassA : PALETTE.grassB;
        if (kind === 'goal') ctx.fillStyle = PALETTE.goalGrass;
        ctx.fillRect(0, y, game.cols * TILE, TILE);
        ctx.fillStyle = 'rgba(255,255,255,0.045)';
        for (var c = 0; c < game.cols; c += 2) {
          ctx.fillRect(c * TILE, y, TILE, TILE);
        }
        if (kind !== 'goal') drawFlowers(ctx, game, r);
      }
    }
    drawFoodTruck(ctx, game);
  }

  function drawFlowers(ctx, game, r) {
    for (var c = 0; c < game.cols; c++) {
      var h = hash(c, r, game.seed);
      if (h > 0.22) continue; // sparse
      var fx = (c + 0.2 + hash(c, r, 7) * 0.6) * TILE;
      var fy = r * TILE + (0.2 + hash(c, r, 11) * 0.6) * TILE;
      var col = h < 0.08 ? '#e8d7f5' : (h < 0.15 ? '#f5f0e8' : '#f2c7d8');
      ctx.fillStyle = col;
      for (var p = 0; p < 4; p++) {
        var a = p * Math.PI / 2 + h * 6;
        ctx.beginPath();
        ctx.arc(fx + Math.cos(a) * 3, fy + Math.sin(a) * 3, 2.6, 0, 7);
        ctx.fill();
      }
      ctx.fillStyle = '#f7e06e';
      ctx.beginPath(); ctx.arc(fx, fy, 2, 0, 7); ctx.fill();
    }
  }

  function drawFoodTruck(ctx, game) {
    // The lunch goal: a purple food truck parked on the top row.
    var w = TILE * 4.4, h = TILE * 0.92;
    var x = (game.cols * TILE - w) / 2, y = TILE * 0.04;
    ctx.fillStyle = PALETTE.purple;
    roundRect(ctx, x, y + h * 0.18, w, h * 0.8, 8); ctx.fill();
    // awning
    ctx.fillStyle = '#fff';
    roundRect(ctx, x + 6, y, w - 12, h * 0.3, 6); ctx.fill();
    ctx.fillStyle = PALETTE.purpleLight;
    for (var i = 0; i < 6; i++) {
      ctx.fillRect(x + 6 + i * (w - 12) / 6, y, (w - 12) / 12, h * 0.3);
    }
    // serving hatch + sign
    ctx.fillStyle = '#f7e9c8';
    ctx.fillRect(x + w * 0.14, y + h * 0.36, w * 0.5, h * 0.4);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.round(TILE * 0.34) + 'px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('LUNCH', x + w * 0.78, y + h * 0.56);
    // wheels
    ctx.fillStyle = PALETTE.black;
    ctx.beginPath(); ctx.arc(x + w * 0.2, y + h, TILE * 0.12, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.8, y + h, TILE * 0.12, 0, 7); ctx.fill();
  }

  // ------------------------------------------------------------- entities
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function shadow(ctx, cx, cy, rw) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + TILE * 0.34, rw, TILE * 0.1, 0, 0, 7);
    ctx.fill();
  }

  function drawBerry(ctx, b) {
    var cx = (b.col + 0.5) * TILE, cy = (b.row + 0.5) * TILE;
    shadow(ctx, cx, cy - TILE * 0.06, TILE * 0.16);
    ctx.fillStyle = '#d8262f';
    ctx.beginPath();
    ctx.moveTo(cx, cy + TILE * 0.22);
    ctx.bezierCurveTo(cx - TILE * 0.26, cy, cx - TILE * 0.2, cy - TILE * 0.18,
                      cx, cy - TILE * 0.14);
    ctx.bezierCurveTo(cx + TILE * 0.2, cy - TILE * 0.18, cx + TILE * 0.26, cy,
                      cx, cy + TILE * 0.22);
    ctx.fill();
    ctx.fillStyle = '#3f9143'; // leafy crown
    ctx.beginPath();
    ctx.ellipse(cx, cy - TILE * 0.16, TILE * 0.12, TILE * 0.055, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = '#f6e3a1'; // seeds
    ctx.fillRect(cx - 3, cy - 2, 1.6, 2.4);
    ctx.fillRect(cx + 2, cy, 1.6, 2.4);
    ctx.fillRect(cx - 1, cy + 5, 1.6, 2.4);
  }

  /** Generic little person. cx/cy = feet-center in px. */
  function drawPerson(ctx, cx, cy, opts) {
    var bw = opts.bodyW, bh = opts.bodyH || TILE * 0.42;
    shadow(ctx, cx, cy, bw * 0.62);
    ctx.fillStyle = opts.body;
    roundRect(ctx, cx - bw / 2, cy - bh, bw, bh + TILE * 0.12, bw * 0.4);
    ctx.fill();
    ctx.fillStyle = opts.skin;
    ctx.beginPath();
    ctx.arc(cx, cy - bh - TILE * 0.02, opts.headR, 0, 7);
    ctx.fill();
    if (opts.hat) { // posh sun hat
      ctx.fillStyle = opts.hat;
      ctx.beginPath();
      ctx.ellipse(cx, cy - bh - opts.headR * 0.9, opts.headR * 1.7,
                  opts.headR * 0.55, 0, 0, 7);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(cx, cy - bh - opts.headR * 0.95, opts.headR * 0.85, Math.PI, 0);
      ctx.fill();
    }
  }

  function drawNpc(ctx, game, npc, alpha) {
    var x = lerp(npc.px, npc.x, alpha);
    var cx = (x + 0.5) * TILE, cy = (npc.row + 0.42) * TILE;
    var idx = game.npcs.indexOf(npc);
    var pastel = PALETTE.pastels[Math.floor(hash(idx, 3, game.seed) * PALETTE.pastels.length)];
    var skin = PALETTE.skin[Math.floor(hash(idx, 5, game.seed) * PALETTE.skin.length)];

    if (npc.type === 'wheelchair') {
      shadow(ctx, cx, cy, TILE * 0.34);
      ctx.strokeStyle = '#3a3a44'; ctx.lineWidth = 3; // wheels
      ctx.beginPath(); ctx.arc(cx - TILE * 0.16, cy + TILE * 0.06, TILE * 0.17, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + TILE * 0.2, cy + TILE * 0.08, TILE * 0.09, 0, 7); ctx.stroke();
      ctx.fillStyle = pastel; // seated body
      roundRect(ctx, cx - TILE * 0.14, cy - TILE * 0.34, TILE * 0.3, TILE * 0.34, 6);
      ctx.fill();
      ctx.fillStyle = skin;
      ctx.beginPath(); ctx.arc(cx, cy - TILE * 0.42, TILE * 0.11, 0, 7); ctx.fill();
    } else if (npc.type === 'kid') {
      drawPerson(ctx, cx, cy + TILE * 0.06, {
        bodyW: TILE * 0.26, bodyH: TILE * 0.24, headR: TILE * 0.1,
        body: PALETTE.pastels[Math.floor(hash(idx, 9, 1) * PALETTE.pastels.length)],
        skin: skin
      });
    } else { // posh
      drawPerson(ctx, cx, cy, {
        bodyW: TILE * 0.52, bodyH: TILE * 0.44, headR: TILE * 0.12,
        body: pastel, skin: skin, hat: '#faf6ec'
      });
    }
    if (npc.mode === 'stopped') { // little "hmm" pause indicator
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = Math.round(TILE * 0.25) + 'px Georgia, serif';
      ctx.textAlign = 'center';
      ctx.fillText('…', cx + TILE * 0.3, cy - TILE * 0.62);
    }
  }

  function drawPhotographerPair(ctx, game, ph) {
    var cy = (ph.row + 0.42) * TILE;
    var charging = ph.phase === 'charging';
    var flashing = ph.phase === 'flash';

    // Danger-zone telegraph: gap tiles glow while the flash charges.
    if (charging || flashing) {
      ctx.fillStyle = flashing ? 'rgba(255,255,255,0.75)'
                               : 'rgba(255,225,90,' + (0.25 + 0.2 * Math.sin(game.time * 20)) + ')';
      for (var i = 0; i < ph.dangerCols.length; i++) {
        ctx.fillRect(ph.dangerCols[i] * TILE, ph.row * TILE, TILE, TILE);
      }
    }

    drawOnePhotographer(ctx, game, ph, ph.leftCol, cy, 1, charging, flashing);
    drawOnePhotographer(ctx, game, ph, ph.rightCol, cy, -1, charging, flashing);
  }

  function drawOnePhotographer(ctx, game, ph, col, cy, face, charging, flashing) {
    var cx = (col + 0.5) * TILE;
    drawPerson(ctx, cx, cy, {
      bodyW: TILE * 0.4, bodyH: TILE * 0.4, headR: TILE * 0.11,
      body: '#f5f0e8',
      skin: PALETTE.skin[Math.floor(hash(col, ph.row, game.seed) * PALETTE.skin.length)]
    });
    // Raised phone, pointed into the gap.
    var px = cx + face * TILE * 0.28, py = cy - TILE * 0.34;
    ctx.fillStyle = '#2b2b33';
    ctx.fillRect(px - 4, py - 7, 8, 14);
    if (charging) {
      ctx.fillStyle = 'rgba(255,215,64,' + (0.5 + 0.5 * Math.sin(game.time * 24)) + ')';
      ctx.beginPath(); ctx.arc(px, py - 12, 4, 0, 7); ctx.fill();
    }
    if (flashing) {
      var g = ctx.createRadialGradient(px, py, 2, px, py, TILE * 1.6);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, TILE * 1.6, 0, 7); ctx.fill();
    }
  }

  function drawPlayer(ctx, game, alpha) {
    var p = game.player;
    var x = lerp(p.px, p.x, alpha), y = lerp(p.py, p.y, alpha);
    var cx = (x + 0.5) * TILE, cy = (y + 0.42) * TILE;

    // Hop arc: lift the sprite mid-hop; dashes leave a purple trail.
    var liftK = 0;
    if (p.hop) {
      var k = Math.min(1, p.hop.t / p.hop.dur);
      liftK = Math.sin(Math.PI * k);
      if (p.hop.dash) {
        ctx.strokeStyle = 'rgba(122,82,173,0.5)';
        ctx.lineWidth = TILE * 0.3; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo((p.hop.fromC + 0.5) * TILE, (p.hop.fromR + 0.42) * TILE);
        ctx.lineTo(cx, cy);
        ctx.stroke();
      }
    }
    var lift = liftK * TILE * 0.22;
    shadow(ctx, cx, cy, TILE * 0.24 * (1 - liftK * 0.4));
    cy -= lift;

    // Broadcast engineer: all black, headset, little belt radio.
    ctx.fillStyle = PALETTE.black;
    roundRect(ctx, cx - TILE * 0.19, cy - TILE * 0.42, TILE * 0.38, TILE * 0.5, 8);
    ctx.fill();
    ctx.fillStyle = '#e8b88b';
    ctx.beginPath(); ctx.arc(cx, cy - TILE * 0.48, TILE * 0.115, 0, 7); ctx.fill();
    ctx.strokeStyle = PALETTE.black; ctx.lineWidth = 3; // headset band + mic
    ctx.beginPath();
    ctx.arc(cx, cy - TILE * 0.48, TILE * 0.13, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
    ctx.fillStyle = PALETTE.black;
    ctx.beginPath(); ctx.arc(cx - TILE * 0.13, cy - TILE * 0.47, 3, 0, 7); ctx.fill();
    ctx.fillStyle = '#c5342b'; // belt radio, a dab of colour
    ctx.fillRect(cx + TILE * 0.08, cy - TILE * 0.06, 5, 8);
  }

  // ------------------------------------------------------------- main draw
  function draw(canvas, game, alpha) {
    var ctx = canvas.getContext('2d');
    var dpr = parseFloat(canvas.dataset.dpr || '1');
    ctx.save();
    ctx.scale(dpr, dpr);

    drawBackground(ctx, game);

    for (var i = 0; i < game.berries.length; i++) {
      if (game.berries[i].alive) drawBerry(ctx, game.berries[i]);
    }
    for (var j = 0; j < game.photographers.length; j++) {
      drawPhotographerPair(ctx, game, game.photographers[j]);
    }

    // Painter's order: entities lower on screen draw on top.
    var order = game.npcs.slice();
    order.sort(function (a, b) { return a.row - b.row; });
    var playerDrawn = false;
    for (var n = 0; n < order.length; n++) {
      if (!playerDrawn && order[n].row > game.player.y) {
        drawPlayer(ctx, game, alpha);
        playerDrawn = true;
      }
      drawNpc(ctx, game, order[n], alpha);
    }
    if (!playerDrawn) drawPlayer(ctx, game, alpha);

    // Whole-screen glint while any flash is live.
    for (var f = 0; f < game.photographers.length; f++) {
      if (game.photographers[f].phase === 'flash') {
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(0, 0, game.cols * TILE, game.numRows * TILE);
        break;
      }
    }
    ctx.restore();
  }

  root.GameRender = { TILE: TILE, setupCanvas: setupCanvas, draw: draw };
})(typeof self !== 'undefined' ? self : this);
