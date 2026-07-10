/*
 * Strawberry Rush — renderer (v5: themed day→night campaign, fullscreen).
 *
 * Everything is drawn procedurally (zero image assets). Each level carries a
 * `theme` (dawn → night) that repaints the sky, ground, and lighting, and a
 * `warmth` that adds a heat-haze on hot levels. Artificial light (fairy-light
 * strands, gate lanterns, glowing berries) fades in only as evening falls
 * (theme.glow), so daytime levels read bright and clear and the beloved
 * floodlit-night finale keeps its charm.
 *
 * Presentation is pseudo-3D and fullscreen:
 *  - the canvas fills the window; the world is drawn in a fixed logical space
 *    (cols*TILE wide) and scaled crisply to device pixels;
 *  - a smoothed camera follows the player up the scrolling grounds;
 *  - perspective sprite scaling, y-sorted props/people/balls, drop shadows,
 *    walk cycles, squash-and-stretch;
 *  - additive light pools at night; particles and camera shake.
 *
 * The renderer owns only cosmetic state (camera, particles, shake); the
 * simulation stays pure. draw() takes the game plus an interpolation factor
 * `alpha` (0..1 between the previous and current fixed-timestep positions).
 */
(function (root) {
  'use strict';

  var TILE = 46;
  var SKY_H = 170;

  var COMMON = {
    accent: '#7ef0d0',
    skin: ['#e8b88f', '#c98f5a', '#7d5230', '#5d3c1f'],
    outfitsDay: ['#e7d8b8', '#d98fa0', '#7fa8d8', '#e0c46a', '#a58fd8', '#7fc4a0', '#d98080'],
    outfitsEve: ['#cbb9a4', '#a97b96', '#7590b5', '#b3a05f', '#8d81b8', '#74a591', '#b57575'],
    black: '#101018',
    water: 'rgba(150,215,250,0.85)',
    bulb: '#ffd9a0',
    bulbGlow: 'rgba(255,190,110,',
    ember: 'rgba(255,90,80,',
    ballFelt: '#d6f24a'
  };

  // Per-theme palettes. glow (0..1) = how much artificial light shows;
  // dark = glow >= 0.5 (stars, moon, strong light pools).
  var THEMES = {
    dawn:       { glow: 0.18, celestial: 'sun', sunColor: '#ffd9b0', sunLow: true,
                  sky: ['#2d3f74', '#5a6a9e', '#caa0a8', '#f4cd92'],
                  grass: ['#4f9a57', '#489150'], path: '#cdb891',
                  ambient: 'rgba(120,120,180,0.06)' },
    morning:    { glow: 0.0, celestial: 'sun', sunColor: '#fff4d0',
                  sky: ['#59a4df', '#8ec3ec', '#c9e0f2', '#eaf4fb'],
                  grass: ['#57ab5b', '#4fa151'], path: '#d8cba6',
                  ambient: null },
    midday:     { glow: 0.0, celestial: 'sun', sunColor: '#fff8dc',
                  sky: ['#3f97e6', '#79b8ec', '#b6dbf6', '#dcecfb'],
                  grass: ['#5bb35c', '#52a952'], path: '#d8cba6',
                  ambient: null },
    noon:       { glow: 0.0, celestial: 'sun', sunColor: '#fffbe6', hazy: true,
                  sky: ['#6fa9d6', '#a6c8e2', '#d6e2ea', '#efe9d2'],
                  grass: ['#74b25a', '#6aa852'], path: '#ded0a6',
                  ambient: 'rgba(255,228,170,0.10)' },
    afternoon:  { glow: 0.06, celestial: 'sun', sunColor: '#ffedc0',
                  sky: ['#5a9ad8', '#93bfe6', '#d3e0e8', '#ecdfc2'],
                  grass: ['#5aa657', '#519c4e'], path: '#d6c8a0',
                  ambient: 'rgba(255,220,160,0.05)' },
    goldenhour: { glow: 0.45, celestial: 'sun', sunColor: '#ffb85a', sunLow: true,
                  sky: ['#7a6bb0', '#c98f7a', '#f0a860', '#ffd39a'],
                  grass: ['#549a50', '#7f9a46'], path: '#c7ac82',
                  ambient: 'rgba(255,150,70,0.12)' },
    dusk:       { glow: 0.8, celestial: 'moon',
                  sky: ['#0b1030', '#231a4a', '#5a3a52', '#c86a46'],
                  grass: ['#2b5a44', '#26533e'], path: '#4a4550',
                  ambient: 'rgba(20,20,50,0.12)' },
    night:      { glow: 1.0, celestial: 'moon', floodlit: true,
                  sky: ['#0b1030', '#1a1440', '#231a4a', '#3a2a4e'],
                  grass: ['#1f4a50', '#1a4348'], path: '#3b3743',
                  ambient: 'rgba(8,10,30,0.16)' }
  };

  function hash(a, b, c) {
    var h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  var S = {
    cam: 0, camTarget: 0, viewH: 620, fit: 1, lastNow: 0,
    shakeT: 0, shakeMag: 0,
    theme: THEMES.night, glow: 1, dark: true, warmth: 0,
    particles: [], props: [], strands: [], lanterns: [], fireflies: [],
    vignette: null
  };

  function isDark() { return S.glow >= 0.5; }

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
    S.theme = THEMES[game.level.theme] || THEMES.night;
    S.glow = S.theme.glow;
    S.dark = isDark();
    S.warmth = game.warmth || 0;
    computeViewport(canvas, game);
    S.cam = S.camTarget = camTargetFor(game, game.player.y);
    S.particles.length = 0;
    S.shakeT = 0;
    S.props = buildProps(game);

    S.strands = [];
    for (var r = 2.5; r < game.numRows - 2; r += 4.5) S.strands.push(r);
    S.lanterns = [];
    (game.level.hedges || []).forEach(function (h) {
      h.gaps.forEach(function (gap) {
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
    if (S.dark) {
      for (var i = 0; i < 7; i++) {
        S.fireflies.push({
          x: hash(i, 1, game.seed) * game.cols,
          y: 3 + hash(i, 2, game.seed) * (game.numRows - 6),
          a: hash(i, 3, game.seed) * 6.28, t: i * 1.7
        });
      }
    }
    return canvas.getContext('2d');
  }

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
    g.addColorStop(1, S.dark ? 'rgba(4,6,16,0.5)' : 'rgba(20,30,40,0.22)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }

  function buildProps(game) {
    var props = [];
    var r, c;
    for (r = 0; r < game.numRows; r++) {
      var runStart = -1, runKind = null;
      for (c = 0; c <= game.cols; c++) {
        var block = c < game.cols ? game.terrain[r][c].block : null;
        var mergeable = (block === 'hedge' || block === 'barrier') ? block : null;
        if (mergeable && mergeable === runKind) continue;
        if (runKind) props.push({ y: r, kind: runKind, row: r, c0: runStart, c1: c - 1 });
        runKind = mergeable; runStart = c;
        if (block === 'tree' || block === 'umbrella') props.push({ y: r, kind: block, row: r, col: c });
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
  function scaleAt(sy) { return 0.85 + 0.28 * clamp(sy / S.viewH, 0, 1); }
  function bulbCount(w) { return Math.max(6, Math.round(w / 85)); }

  // ------------------------------------------------------------- sky
  function drawSky(ctx, game, w, horizon) {
    var th = S.theme, top = horizon - SKY_H;
    var g = ctx.createLinearGradient(0, top, 0, horizon);
    g.addColorStop(0, th.sky[0]); g.addColorStop(0.4, th.sky[1]);
    g.addColorStop(0.75, th.sky[2]); g.addColorStop(1, th.sky[3]);
    ctx.fillStyle = g;
    ctx.fillRect(0, top, w, SKY_H);

    if (S.dark) {
      for (var st = 0; st < 60; st++) {
        var sx = hash(st, 1, 9) * w, sy = top + hash(st, 2, 9) * SKY_H * 0.7;
        var tw = 0.35 + 0.65 * Math.abs(Math.sin(game.time * (0.6 + hash(st, 3, 9)) + st));
        ctx.fillStyle = 'rgba(240,240,255,' + (tw * (0.4 + 0.5 * S.glow)) + ')';
        var ss = hash(st, 4, 9) < 0.12 ? 2 : 1.2;
        ctx.fillRect(sx, sy, ss, ss);
      }
    }

    // Sun or moon per theme.
    var cx = w * (th.celestial === 'moon' ? 0.78 : 0.24);
    var cy = top + SKY_H * (th.sunLow ? 0.5 : 0.24);
    if (th.celestial === 'moon') {
      var halo = ctx.createRadialGradient(cx, cy, 4, cx, cy, 46);
      halo.addColorStop(0, 'rgba(235,240,255,0.35)'); halo.addColorStop(1, 'rgba(235,240,255,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, 46, 0, 7); ctx.fill();
      ctx.fillStyle = '#eef1fa'; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, 7); ctx.fill();
      ctx.fillStyle = th.sky[1]; ctx.beginPath(); ctx.arc(cx - 6, cy - 3, 11, 0, 7); ctx.fill();
    } else {
      var bloom = ctx.createRadialGradient(cx, cy, 6, cx, cy, 70);
      bloom.addColorStop(0, th.sunColor); bloom.addColorStop(0.3, th.sunColor);
      bloom.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(cx, cy, 70, 0, 7); ctx.fill();
      ctx.fillStyle = th.sunColor; ctx.beginPath(); ctx.arc(cx, cy, 18, 0, 7); ctx.fill();
    }

    // Drifting clouds — pale by day, dark wisps by night.
    ctx.fillStyle = S.dark ? 'rgba(10,14,38,0.5)' : 'rgba(255,255,255,0.7)';
    for (var cl = 0; cl < 3; cl++) {
      var span = w + 300;
      var cxp = ((game.time * (3 + cl) + cl * span / 3) % span) - 150;
      var cyp = top + SKY_H * (0.28 + 0.16 * cl);
      ctx.beginPath();
      ctx.ellipse(cxp, cyp, 70, 10, 0, 0, 7);
      ctx.ellipse(cxp + 40, cyp + 5, 50, 8, 0, 0, 7);
      ctx.ellipse(cxp - 34, cyp + 4, 40, 7, 0, 0, 7);
      ctx.fill();
    }

    var bx = ((game.time * 7) % (w + 160)) - 80;
    drawBalloon(ctx, game, bx, top + SKY_H * 0.34 + Math.sin(game.time * 0.5) * 5);

    // Distant stands.
    var standH = 36;
    ctx.fillStyle = S.dark ? '#0a0f1e' : 'rgba(40,60,50,0.65)';
    ctx.fillRect(0, horizon - standH, w, standH);
    ctx.fillStyle = S.dark ? '#070b17' : 'rgba(30,48,38,0.7)';
    for (var s = 0; s < w; s += 90) {
      ctx.beginPath();
      ctx.moveTo(s, horizon - standH); ctx.lineTo(s + 45, horizon - standH - 14);
      ctx.lineTo(s + 90, horizon - standH); ctx.fill();
    }
    for (var d = 0; d < w; d += 7) {
      var hsh = hash(d, 17, game.seed);
      if (S.dark) {
        var flick = Math.sin(game.time * (0.8 + hsh * 2) + d) > 0.3 ? 1 : 0.4;
        ctx.fillStyle = 'rgba(255,196,120,' + (flick * (0.25 + hsh * 0.5)) + ')';
      } else {
        ctx.fillStyle = 'rgba(240,238,228,' + (0.2 + hsh * 0.4) + ')'; // daytime crowd
      }
      ctx.fillRect(d, horizon - standH + 9 + hsh * 18, 2.4, 2.4);
    }
    for (var f = 40; f < w; f += 140) {
      ctx.strokeStyle = 'rgba(200,200,215,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(f, horizon - standH - 12); ctx.lineTo(f, horizon - standH - 40); ctx.stroke();
      var wave = Math.sin(game.time * 3 + f) * 5;
      ctx.fillStyle = f % 280 === 40 ? 'rgba(138,95,201,0.8)' : 'rgba(126,240,208,0.55)';
      ctx.beginPath();
      ctx.moveTo(f, horizon - standH - 40);
      ctx.quadraticCurveTo(f + 12, horizon - standH - 38 + wave, f + 24, horizon - standH - 34 + wave);
      ctx.lineTo(f, horizon - standH - 30); ctx.fill();
    }
  }

  function drawBalloon(ctx, game, x, y) {
    ctx.fillStyle = S.dark ? '#1c1633' : '#8a5fc9';
    ctx.beginPath(); ctx.arc(x, y, 14, Math.PI, 0); ctx.fill();
    ctx.beginPath(); ctx.moveTo(x - 14, y); ctx.quadraticCurveTo(x, y + 20, x, y + 22);
    ctx.quadraticCurveTo(x, y + 20, x + 14, y); ctx.fill();
    if (S.dark) {
      var fl = 0.5 + 0.5 * Math.sin(game.time * 11);
      ctx.fillStyle = 'rgba(255,170,60,' + (0.25 + 0.35 * fl) + ')';
      ctx.beginPath(); ctx.arc(x, y + 14, 7 + fl * 3, 0, 7); ctx.fill();
    } else {
      ctx.fillStyle = '#f2e8d5';
      ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.quadraticCurveTo(x, y + 18, x, y + 22);
      ctx.quadraticCurveTo(x, y + 18, x + 5, y); ctx.fill();
    }
    ctx.fillStyle = '#3b2c22'; ctx.fillRect(x - 4, y + 24, 8, 6);
  }

  // ------------------------------------------------------------- ground
  function shadeArr(rgbHex, k) {
    var v = parseInt(rgbHex.slice(1), 16);
    var r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    if (k > 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  function groundStyleFor(game, r) {
    var base = S.theme.grass;
    var zones = game.level.zones || [];
    var zone = root.GameLogic ? root.GameLogic.zoneForRow(game.level, r) : null;
    var idx = zone ? zones.indexOf(zone) : -1;
    // Subtle per-zone shift so bands read distinctly within one theme.
    var k = idx <= 0 ? 0.05 : (idx === zones.length - 1 ? -0.06 : 0);
    return [shadeArr(base[0], k), shadeArr(base[1], k)];
  }

  function drawGround(ctx, game, cam, w) {
    var r0 = Math.max(0, Math.floor(cam / TILE));
    var r1 = Math.min(game.numRows - 1, Math.ceil((cam + S.viewH) / TILE));
    for (var r = r0; r <= r1; r++) {
      var y = r * TILE - cam;
      for (var c = 0; c < game.cols; c++) {
        var cell = game.terrain[r][c], x = c * TILE;
        if (cell.t === 'path') {
          ctx.fillStyle = S.theme.path;
          ctx.fillRect(x, y, TILE, TILE);
          ctx.fillStyle = S.dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
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
          if (((r + c * 2) % 6) < 2) {
            ctx.fillStyle = S.dark ? 'rgba(160,220,200,0.03)' : 'rgba(255,255,255,0.05)';
            ctx.fillRect(x, y, TILE, TILE);
          }
          if (r > 0) drawFlower(ctx, game, c, r, x, y);
        }
      }
    }
    ctx.fillStyle = S.dark ? 'rgba(220,235,240,0.12)' : 'rgba(255,255,255,0.28)';
    ctx.fillRect(3, Math.max(0, -cam), 2, S.viewH);
    ctx.fillRect(w - 5, Math.max(0, -cam), 2, S.viewH);
  }

  function drawFlower(ctx, game, c, r, x, y) {
    var h = hash(c, r, game.seed);
    if (h > 0.12) return;
    var fx = x + (0.2 + hash(c, r, 7) * 0.6) * TILE;
    var fy = y + (0.2 + hash(c, r, 11) * 0.6) * TILE;
    if (S.dark) ctx.fillStyle = h < 0.05 ? 'rgba(214,190,240,0.5)' : 'rgba(235,225,210,0.42)';
    else ctx.fillStyle = h < 0.05 ? '#e8d7f5' : (h < 0.09 ? '#fff4f8' : '#f7d84a');
    for (var p = 0; p < 4; p++) {
      var a = p * Math.PI / 2 + h * 6;
      ctx.beginPath(); ctx.arc(fx + Math.cos(a) * 2.4, fy + Math.sin(a) * 2.4, 1.9, 0, 7); ctx.fill();
    }
    if (!S.dark) { ctx.fillStyle = '#f7e06e'; ctx.beginPath(); ctx.arc(fx, fy, 1.5, 0, 7); ctx.fill(); }
  }

  function drawBlanketTile(ctx, game, c, r, x, y) {
    ctx.fillStyle = S.dark ? '#57232f' : '#c94b4b';
    ctx.fillRect(x, y, TILE, TILE);
    ctx.fillStyle = S.dark ? 'rgba(230,208,185,0.22)' : 'rgba(245,235,220,0.7)';
    var stripe = TILE / 5;
    ctx.fillRect(x, y + stripe, TILE, stripe * 0.6);
    ctx.fillRect(x, y + stripe * 3.2, TILE, stripe * 0.6);
    ctx.fillRect(x + stripe, y, stripe * 0.6, TILE);
    ctx.fillRect(x + stripe * 3.2, y, stripe * 0.6, TILE);
    ctx.strokeStyle = 'rgba(20,10,12,0.4)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2);
    if (S.dark && hash(c, r, 31) < 0.2) {
      ctx.fillStyle = 'rgba(255,200,120,0.9)';
      ctx.beginPath(); ctx.arc(x + TILE * 0.75, y + TILE * 0.3, 3, 0, 7); ctx.fill();
      ctx.fillStyle = COMMON.bulbGlow + '0.18)';
      ctx.beginPath(); ctx.arc(x + TILE * 0.75, y + TILE * 0.3, 10, 0, 7); ctx.fill();
    }
  }

  // Tennis courts: a clay/grass rectangle with white lines and a net, under
  // the entities. Drawn in the ground pass.
  function drawCourt(ctx, court, cam) {
    var x = court.colMin * TILE - TILE * 0.5, y = court.rowMin * TILE - cam - TILE * 0.5;
    var w = (court.colMax - court.colMin + 1) * TILE, h = (court.rowMax - court.rowMin + 1) * TILE;
    if (y + h < 0 || y > S.viewH) return;
    ctx.fillStyle = S.dark ? 'rgba(46,86,70,0.55)' : 'rgba(70,130,90,0.4)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 2;
    ctx.strokeRect(x + 4, y + 4, w - 8, h - 8);
    ctx.beginPath(); ctx.moveTo(x + w / 2, y + 4); ctx.lineTo(x + w / 2, y + h - 4); ctx.stroke(); // centre
    // net across the middle row
    ctx.strokeStyle = 'rgba(240,245,250,0.85)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(x + 4, y + h / 2); ctx.lineTo(x + w - 4, y + h / 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(240,245,250,0.3)'; ctx.lineWidth = 1;
    for (var nx = x + 8; nx < x + w - 4; nx += 8) {
      ctx.beginPath(); ctx.moveTo(nx, y + h / 2 - 5); ctx.lineTo(nx, y + h / 2 + 5); ctx.stroke();
    }
  }

  function drawMist(ctx, game, cam, w) {
    if (!S.dark) return;
    ctx.fillStyle = 'rgba(170,190,230,0.045)';
    var worldH = game.numRows * TILE;
    for (var i = 0; i < 4; i++) {
      var span = w + 700;
      var cx = ((game.time * (5 + i * 2) + i * 733) % span) - 350;
      var cy = ((game.time * (2.5 + i) + i * 977) % (worldH + 600)) - 300 - cam;
      if (cy < -220 || cy > S.viewH + 220) continue;
      ctx.beginPath(); ctx.ellipse(cx, cy, 200 + i * 30, 70 + i * 12, 0.35, 0, 7); ctx.fill();
    }
  }

  // Heat haze on warm levels: a warm wash plus a couple of shimmer bands.
  function drawHeatHaze(ctx, game, w) {
    if (S.warmth < 0.4) return;
    var k = (S.warmth - 0.4) / 0.6;
    ctx.fillStyle = 'rgba(255,235,180,' + (0.05 * k) + ')';
    ctx.fillRect(0, 0, w, S.viewH);
    ctx.strokeStyle = 'rgba(255,255,255,' + (0.05 * k) + ')';
    ctx.lineWidth = 6;
    for (var i = 0; i < 4; i++) {
      var yy = S.viewH * (0.3 + i * 0.17);
      ctx.beginPath();
      for (var xx = 0; xx <= w; xx += 20) {
        var oy = Math.sin(xx * 0.05 + game.time * 3 + i) * 3 * k;
        if (xx === 0) ctx.moveTo(xx, yy + oy); else ctx.lineTo(xx, yy + oy);
      }
      ctx.stroke();
    }
  }

  function drawLightPools(ctx, game, cam, w, alpha) {
    if (S.glow < 0.15) return;
    ctx.globalCompositeOperation = 'lighter';
    var i, b, NB = bulbCount(w), gk = S.glow;
    for (i = 0; i < S.strands.length; i++) {
      var ry = S.strands[i] * TILE - cam;
      if (ry < -TILE * 2 || ry > S.viewH + TILE * 2) continue;
      for (b = 1; b <= NB; b++) {
        pool(ctx, (b / (NB + 1)) * w, ry, TILE * 1.5, (0.05 + 0.012 * Math.sin(game.time * 2 + b + i * 3)) * gk);
      }
    }
    for (i = 0; i < S.lanterns.length; i++) {
      var ly = (S.lanterns[i].y + 0.5) * TILE - cam;
      if (ly < -TILE * 2 || ly > S.viewH + TILE * 2) continue;
      pool(ctx, (S.lanterns[i].x + 0.5) * TILE, ly, TILE * 1.9, (0.1 + 0.02 * Math.sin(game.time * 3 + i)) * gk);
    }
    if (S.dark) {
      var px = (lerp(game.player.px, game.player.x, alpha) + 0.5) * TILE;
      var py = (lerp(game.player.py, game.player.y, alpha) + 0.5) * TILE - cam;
      pool(ctx, px, py, TILE * 2.4, 0.07);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
  function pool(ctx, x, y, r, a) {
    var g = ctx.createRadialGradient(x, y, 2, x, y, r);
    g.addColorStop(0, COMMON.bulbGlow + a + ')'); g.addColorStop(1, COMMON.bulbGlow + '0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  }

  function drawStrand(ctx, game, row, cam, w) {
    var baseY = row * TILE - cam, lift = TILE * 1.5;
    ctx.strokeStyle = 'rgba(30,30,45,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, baseY - lift);
    ctx.quadraticCurveTo(w / 2, baseY - lift + 26, w, baseY - lift); ctx.stroke();
    var NB = bulbCount(w);
    for (var b = 1; b <= NB; b++) {
      var u = b / (NB + 1), bx = u * w, by = baseY - lift + 26 * 2 * u * (1 - u) * 2;
      if (S.glow > 0.15) {
        var tw = 0.75 + 0.25 * Math.sin(game.time * 3 + b * 1.3 + row);
        ctx.fillStyle = COMMON.bulbGlow + (0.22 * tw * S.glow) + ')';
        ctx.beginPath(); ctx.arc(bx, by + 4, 8, 0, 7); ctx.fill();
      }
      ctx.fillStyle = S.glow > 0.15 ? COMMON.bulb : '#b7a98c';
      ctx.beginPath(); ctx.arc(bx, by + 4, 2.6, 0, 7); ctx.fill();
    }
    ctx.strokeStyle = '#22222e'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(2, baseY); ctx.lineTo(2, baseY - lift);
    ctx.moveTo(w - 2, baseY); ctx.lineTo(w - 2, baseY - lift); ctx.stroke();
  }

  function drawLantern(ctx, game, ln, cam) {
    var cx = (ln.x + 0.5) * TILE, yBase = (ln.y + 0.6) * TILE - cam, h = TILE * 1.25;
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(cx, yBase); ctx.lineTo(cx, yBase - h); ctx.stroke();
    if (S.glow > 0.15) {
      var fl = 0.8 + 0.2 * Math.sin(game.time * 5 + ln.x * 3 + ln.y);
      ctx.fillStyle = COMMON.bulbGlow + (0.3 * fl * S.glow) + ')';
      ctx.beginPath(); ctx.arc(cx, yBase - h, 12, 0, 7); ctx.fill();
    }
    ctx.fillStyle = S.glow > 0.15 ? '#ffe2b0' : '#c9c2b0';
    ctx.beginPath(); ctx.arc(cx, yBase - h, 4.5, 0, 7); ctx.fill();
    ctx.strokeStyle = '#1a1a24'; ctx.lineWidth = 1.5;
    ctx.strokeRect(cx - 5.5, yBase - h - 6, 11, 12);
  }

  function drawHazardZones(ctx, game, cam) {
    var i;
    for (i = 0; i < game.photographers.length; i++) {
      var ph = game.photographers[i];
      if (ph.phase === 'idle') continue;
      var flashing = ph.phase === 'flash';
      ctx.fillStyle = flashing ? 'rgba(255,255,255,0.8)' : 'rgba(255,214,80,' + (0.16 + 0.14 * Math.sin(game.time * 20)) + ')';
      for (var d = 0; d < ph.dangerCols.length; d++) ctx.fillRect(ph.dangerCols[d] * TILE, ph.row * TILE - cam, TILE, TILE);
    }
    for (i = 0; i < game.sprinklers.length; i++) {
      var s = game.sprinklers[i];
      if (s.phase === 'idle') continue;
      var cx = (s.col + 0.5) * TILE, cy = (s.row + 0.5) * TILE - cam;
      if (s.phase === 'warn') {
        ctx.strokeStyle = 'rgba(150,215,250,' + (0.3 + 0.25 * Math.sin(game.time * 14)) + ')';
        ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, TILE * 1.45, 0, 7); ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(120,190,240,0.16)';
        ctx.fillRect((s.col - 1) * TILE, (s.row - 1) * TILE - cam, TILE * 3, TILE * 3);
        ctx.strokeStyle = COMMON.water; ctx.lineWidth = 2.5;
        var spin = game.time * 5;
        for (var j = 0; j < 6; j++) {
          var a = spin + j * Math.PI / 3;
          ctx.beginPath();
          ctx.moveTo(cx + Math.cos(a) * 5, cy + Math.sin(a) * 5 - 8);
          ctx.quadraticCurveTo(cx + Math.cos(a) * TILE * 0.8, cy + Math.sin(a) * TILE * 0.8 - 16,
            cx + Math.cos(a) * TILE * 1.35, cy + Math.sin(a) * TILE * 1.35);
          ctx.stroke();
        }
      }
    }
    var cp = game.checkpoint;
    if (game.checkpointStage > 0) {
      var mx = (cp.col + 0.5) * TILE, my = (cp.row + 0.5) * TILE - cam;
      ctx.fillStyle = 'rgba(126,240,208,0.12)';
      ctx.beginPath(); ctx.arc(mx, my, TILE * 0.55, 0, 7); ctx.fill();
      ctx.strokeStyle = '#cfe8dd'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(mx + 8, my); ctx.lineTo(mx + 8, my - 18); ctx.stroke();
      ctx.fillStyle = COMMON.accent;
      ctx.beginPath(); ctx.moveTo(mx + 8, my - 18);
      ctx.lineTo(mx + 20, my - 14 + Math.sin(game.time * 4) * 1.5); ctx.lineTo(mx + 8, my - 10); ctx.fill();
    }
  }

  // ------------------------------------------------------------- berries
  function drawBerry(ctx, game, b, cam) {
    var sy0 = (b.row + 0.5) * TILE - cam;
    if (sy0 < -TILE || sy0 > S.viewH + TILE) return;
    var sc = scaleAt(sy0) * (b.golden ? 1.25 : 1);
    var bob = Math.sin(game.time * 3 + b.col * 1.7 + b.row) * 2.2;
    var cx = (b.col + 0.5) * TILE, cy = sy0 + bob, R = TILE * 0.20 * sc;
    ellipseShadow(ctx, cx, sy0 + TILE * 0.3 * sc, R * 0.9, 0.25);
    var glowK = b.golden ? 1 : (0.35 + 0.65 * S.glow); // day berries glow less
    var pulse = 0.5 + 0.5 * Math.sin(game.time * 4 + b.col + b.row * 2);
    var glowCol = b.golden ? 'rgba(255,214,80,' : COMMON.ember;
    if (glowK > 0.1) {
      var glow = ctx.createRadialGradient(cx, cy, 2, cx, cy, R * (b.golden ? 3.4 : 2.6));
      glow.addColorStop(0, glowCol + ((0.28 + 0.14 * pulse) * glowK) + ')'); glow.addColorStop(1, glowCol + '0)');
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(cx, cy, R * (b.golden ? 3.4 : 2.6), 0, 7); ctx.fill();
    }
    var body = ctx.createRadialGradient(cx - R * 0.4, cy - R * 0.3, R * 0.2, cx, cy, R * 1.4);
    if (b.golden) { body.addColorStop(0, '#ffedb0'); body.addColorStop(1, '#e0a12e'); }
    else { body.addColorStop(0, '#ff6a70'); body.addColorStop(1, '#b81b26'); }
    ctx.fillStyle = body;
    ctx.beginPath(); ctx.moveTo(cx, cy + R * 1.1);
    ctx.bezierCurveTo(cx - R * 1.3, cy, cx - R, cy - R * 0.9, cx, cy - R * 0.7);
    ctx.bezierCurveTo(cx + R, cy - R * 0.9, cx + R * 1.3, cy, cx, cy + R * 1.1); ctx.fill();
    ctx.fillStyle = '#2f6b3c'; ctx.beginPath(); ctx.ellipse(cx, cy - R * 0.8, R * 0.6, R * 0.28, 0, 0, 7); ctx.fill();
    ctx.fillStyle = b.golden ? '#fff6dd' : '#ffd9a8';
    ctx.fillRect(cx - R * 0.5, cy - R * 0.1, 1.6, 2.4); ctx.fillRect(cx + R * 0.3, cy + R * 0.1, 1.6, 2.4);
  }

  // ------------------------------------------------------------- props
  function ellipseShadow(ctx, cx, cy, rw, alpha) {
    ctx.fillStyle = 'rgba(0,0,10,' + (alpha || 0.25) + ')';
    ctx.beginPath(); ctx.ellipse(cx, cy, rw, rw * 0.32, 0, 0, 7); ctx.fill();
  }

  function drawHedgeRun(ctx, game, prop, cam) {
    var x = prop.c0 * TILE, w = (prop.c1 - prop.c0 + 1) * TILE;
    var yBase = (prop.row + 0.85) * TILE - cam, hgt = TILE * 0.82;
    var front = S.dark ? '#132821' : '#2e6a34', topc = S.dark ? '#1d382c' : '#3f8445';
    ellipseShadow(ctx, x + w / 2, yBase + 3, w * 0.5, 0.2);
    ctx.fillStyle = front; ctx.fillRect(x + 1, yBase - hgt * 0.55, w - 2, hgt * 0.55);
    ctx.fillStyle = topc;
    ctx.beginPath(); ctx.moveTo(x + 1, yBase - hgt * 0.5);
    for (var c = prop.c0; c <= prop.c1; c++) ctx.arc((c + 0.5) * TILE, yBase - hgt * 0.5, TILE * 0.52, Math.PI, 0);
    ctx.lineTo(x + w - 1, yBase - hgt * 0.5); ctx.closePath(); ctx.fill();
    for (var d = 0; d < w; d += 7) {
      var h = hash(prop.row, d, game.seed);
      ctx.fillStyle = h < 0.5 ? (S.dark ? 'rgba(190,230,210,0.04)' : 'rgba(255,255,255,0.08)') : 'rgba(0,0,0,0.1)';
      ctx.fillRect(x + d, yBase - hgt * (0.15 + h * 0.75), 3, 3);
    }
  }

  function drawBarrierRun(ctx, prop, cam) {
    var x0 = prop.c0 * TILE + 4, x1 = (prop.c1 + 1) * TILE - 4, yBase = (prop.row + 0.72) * TILE - cam;
    ellipseShadow(ctx, (x0 + x1) / 2, yBase + 4, (x1 - x0) * 0.5, 0.14);
    ctx.strokeStyle = S.dark ? '#565e6b' : '#c7cdd4'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x0, yBase - TILE * 0.42); ctx.lineTo(x1, yBase - TILE * 0.42);
    ctx.moveTo(x0, yBase - TILE * 0.2); ctx.lineTo(x1, yBase - TILE * 0.2); ctx.stroke();
    ctx.fillStyle = S.dark ? '#3f4550' : '#9aa3ac';
    for (var x = x0; x <= x1; x += TILE) ctx.fillRect(x - 2, yBase - TILE * 0.5, 4, TILE * 0.5);
    ctx.strokeStyle = 'rgba(138,95,201,0.8)'; ctx.lineWidth = 2;
    for (var s = x0; s + TILE <= x1 + 2; s += TILE) {
      ctx.beginPath(); ctx.moveTo(s, yBase - TILE * 0.32);
      ctx.quadraticCurveTo(s + TILE / 2, yBase - TILE * 0.22, s + TILE, yBase - TILE * 0.32); ctx.stroke();
    }
  }

  function drawTree(ctx, game, prop, cam) {
    var cx = (prop.col + 0.5) * TILE, yBase = (prop.row + 0.8) * TILE - cam, sc = scaleAt(yBase);
    var sway = Math.sin(game.time * 1.2 + prop.col * 2.3) * 2.5;
    ellipseShadow(ctx, cx + 5, yBase + 2, TILE * 0.75 * sc, 0.28);
    ctx.fillStyle = S.dark ? '#2c2019' : '#6b4a2b';
    ctx.fillRect(cx - 4 * sc, yBase - TILE * 0.9 * sc, 8 * sc, TILE * 0.9 * sc);
    var green = S.dark ? ['#15332a', '#1b3f30'] : ['#3f8a45', '#4fa257'];
    var tiers = [[0.95, 0.62], [0.62, 0.5], [0.32, 0.36]];
    for (var i = 0; i < tiers.length; i++) {
      var ty = yBase - TILE * (0.75 + i * 0.42) * sc;
      ctx.fillStyle = i % 2 === 0 ? green[0] : green[1];
      ctx.beginPath();
      ctx.ellipse(cx + sway * (i + 1) * 0.4, ty, TILE * tiers[i][1] * sc, TILE * tiers[i][1] * 0.8 * sc, 0, 0, 7); ctx.fill();
    }
    if (S.glow > 0.3) {
      for (var fl = 0; fl < 8; fl++) {
        var h1 = hash(prop.col, fl, 3), h2 = hash(prop.row, fl, 5);
        var lx = cx + (h1 - 0.5) * TILE * 1.1 * sc + sway * 0.5, lyy = yBase - TILE * (0.6 + h2 * 1.1) * sc;
        var tw = 0.5 + 0.5 * Math.sin(game.time * 2.5 + fl * 2 + prop.col);
        ctx.fillStyle = ['rgba(255,190,110,', 'rgba(126,240,208,', 'rgba(255,140,160,'][fl % 3] + ((0.45 + 0.4 * tw) * S.glow) + ')';
        ctx.beginPath(); ctx.arc(lx, lyy, 2, 0, 7); ctx.fill();
      }
    }
  }

  function drawUmbrella(ctx, game, prop, cam) {
    var cx = (prop.col + 0.5) * TILE, yBase = (prop.row + 0.8) * TILE - cam, sc = scaleAt(yBase);
    ellipseShadow(ctx, cx + 4, yBase + 2, TILE * 0.7 * sc, 0.24);
    ctx.fillStyle = S.dark ? '#464a55' : '#8a8f96';
    ctx.fillRect(cx - 2 * sc, yBase - TILE * 1.05 * sc, 4 * sc, TILE * 1.05 * sc);
    var R = TILE * 0.72 * sc, top = yBase - TILE * 1.05 * sc;
    for (var i = 0; i < 6; i++) {
      ctx.fillStyle = i % 2 === 0 ? (S.dark ? '#33235c' : '#4a2377') : (S.dark ? '#d9cbb2' : '#f2e8d5');
      ctx.beginPath(); ctx.moveTo(cx, top);
      ctx.arc(cx, top + R * 0.35, R, Math.PI + i * Math.PI / 6, Math.PI + (i + 1) * Math.PI / 6); ctx.closePath(); ctx.fill();
    }
    if (S.glow > 0.3) {
      ctx.fillStyle = COMMON.bulbGlow + (0.3 * S.glow) + ')';
      ctx.beginPath(); ctx.arc(cx, top + R * 0.5, 9, 0, 7); ctx.fill();
      ctx.fillStyle = COMMON.bulb; ctx.beginPath(); ctx.arc(cx, top + R * 0.5, 2.5, 0, 7); ctx.fill();
    }
  }

  function drawTruck(ctx, game, cam) {
    var w = TILE * 4.8, h = TILE * 1.15;
    var x = (game.cols * TILE - w) / 2, y = TILE * 0.02 - cam - h * 0.35;
    ellipseShadow(ctx, x + w / 2, y + h + 4, w * 0.5, 0.28);
    var body = ctx.createLinearGradient(0, y, 0, y + h);
    body.addColorStop(0, '#5a3a8f'); body.addColorStop(1, '#33205c');
    ctx.fillStyle = body; roundRect(ctx, x, y + h * 0.16, w, h * 0.84, 9); ctx.fill();
    ctx.fillStyle = '#d9cbb2'; roundRect(ctx, x + 6, y, w - 12, h * 0.3, 6); ctx.fill();
    ctx.fillStyle = '#8f2e3c';
    for (var i = 0; i < 6; i++) ctx.fillRect(x + 6 + i * (w - 12) / 6, y, (w - 12) / 12, h * 0.3);
    for (var bb = 0; bb <= 8; bb++) {
      var bx = x + 8 + bb * (w - 16) / 8, tw = 0.6 + 0.4 * Math.sin(game.time * 4 + bb);
      if (S.glow > 0.15) { ctx.fillStyle = COMMON.bulbGlow + (0.3 * tw * S.glow) + ')'; ctx.beginPath(); ctx.arc(bx, y + h * 0.32, 6, 0, 7); ctx.fill(); }
      ctx.fillStyle = S.glow > 0.15 ? COMMON.bulb : '#efe0c0'; ctx.beginPath(); ctx.arc(bx, y + h * 0.32, 2, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#ffdf9e'; ctx.fillRect(x + w * 0.12, y + h * 0.34, w * 0.5, h * 0.42);
    if (S.dark) {
      var hg = ctx.createRadialGradient(x + w * 0.37, y + h * 0.55, 4, x + w * 0.37, y + h * 0.55, w * 0.5);
      hg.addColorStop(0, COMMON.bulbGlow + '0.25)'); hg.addColorStop(1, COMMON.bulbGlow + '0)');
      ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(x + w * 0.37, y + h * 0.55, w * 0.5, 0, 7); ctx.fill();
    }
    ctx.fillStyle = '#241a38'; ctx.beginPath(); ctx.arc(x + w * 0.3, y + h * 0.62, 7, 0, 7); ctx.fill();
    ctx.fillRect(x + w * 0.3 - 9, y + h * 0.62 + 4, 18, 12);
    ctx.fillStyle = '#f5eedd'; ctx.font = 'bold ' + Math.round(TILE * 0.32) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('LUNCH', x + w * 0.78, y + h * 0.5);
    ctx.fillStyle = '#d8262f'; ctx.beginPath(); ctx.arc(x + w * 0.78, y + h * 0.8, TILE * 0.1, 0, 7); ctx.fill();
    ctx.fillStyle = COMMON.black;
    ctx.beginPath(); ctx.arc(x + w * 0.18, y + h, TILE * 0.14, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.82, y + h, TILE * 0.14, 0, 7); ctx.fill();
  }

  function drawSprinklerHead(ctx, game, s, cam) {
    var cx = (s.col + 0.5) * TILE, cy = (s.row + 0.62) * TILE - cam, sc = scaleAt(cy);
    ellipseShadow(ctx, cx, cy + 3, TILE * 0.24 * sc, 0.2);
    ctx.fillStyle = S.dark ? '#23262e' : '#4a4f57';
    ctx.beginPath(); ctx.ellipse(cx, cy, TILE * 0.2 * sc, TILE * 0.12 * sc, 0, 0, 7); ctx.fill();
    ctx.fillStyle = s.phase === 'idle' ? '#5c666e' : '#8fd0f0';
    ctx.fillRect(cx - 3 * sc, cy - TILE * 0.24 * sc, 6 * sc, TILE * 0.2 * sc);
  }

  // ------------------------------------------------------------- people
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawFigure(ctx, cx, cy, sc, opts) {
    var bw = opts.bodyW * TILE * sc, bh = opts.bodyH * TILE * sc, hr = opts.headR * TILE * sc;
    var bob = opts.moving ? Math.abs(Math.sin(opts.phase)) * 2 * sc : 0, lift = opts.lift || 0;
    if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
    ellipseShadow(ctx, cx, cy, bw * 0.62 * (1 - lift / 60), 0.28);
    cy -= lift + bob;
    if (opts.seated) {
      ctx.fillStyle = 'rgba(20,12,16,0.7)';
      ctx.beginPath(); ctx.ellipse(cx, cy, bw * 0.7, bw * 0.26, 0, 0, 7); ctx.fill();
      bh *= 0.72;
    } else if (opts.moving) {
      var la = Math.sin(opts.phase) * bw * 0.28;
      ctx.strokeStyle = opts.legs || (S.dark ? '#191722' : '#3a3540');
      ctx.lineWidth = Math.max(2.5, bw * 0.18); ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.16, cy - bh * 0.25); ctx.lineTo(cx - bw * 0.16 + la, cy + 2);
      ctx.moveTo(cx + bw * 0.16, cy - bh * 0.25); ctx.lineTo(cx + bw * 0.16 - la, cy + 2); ctx.stroke();
    }
    var g = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    g.addColorStop(0, lighten(opts.body, 0.14)); g.addColorStop(1, darken(opts.body, S.dark ? 0.34 : 0.16));
    ctx.fillStyle = g;
    roundRect(ctx, cx - bw / 2, cy - bh, bw, bh * (opts.moving ? 0.92 : 1), bw * 0.4); ctx.fill();
    if (S.dark) {
      ctx.strokeStyle = 'rgba(255,190,120,0.28)'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(cx - bw * 0.06, cy - bh + bw * 0.42, bw * 0.42, Math.PI * 1.05, Math.PI * 1.6); ctx.stroke();
    }
    ctx.fillStyle = opts.skin;
    ctx.beginPath(); ctx.arc(cx + (opts.facing || 0) * hr * 0.15, cy - bh - hr * 0.35, hr, 0, 7); ctx.fill();
    var hy = cy - bh - hr * 0.35;
    if (opts.hat === 'sun') {
      ctx.fillStyle = opts.hatColor || '#e6d8bc';
      ctx.beginPath(); ctx.ellipse(cx, hy - hr * 0.55, hr * 1.7, hr * 0.55, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, hy - hr * 0.6, hr * 0.85, Math.PI, 0); ctx.fill();
    } else if (opts.hat === 'cap') {
      ctx.fillStyle = opts.hatColor || '#31527d';
      ctx.beginPath(); ctx.arc(cx, hy - hr * 0.35, hr * 0.9, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - hr * 0.9 * (opts.facing >= 0 ? -0.1 : 1), hy - hr * 0.4, hr * 1.0, hr * 0.28);
    } else if (opts.hat === 'boater') {
      ctx.fillStyle = opts.hatColor || '#cbbd97';
      ctx.beginPath(); ctx.ellipse(cx, hy - hr * 0.5, hr * 1.35, hr * 0.4, 0, 0, 7); ctx.fill();
      ctx.fillRect(cx - hr * 0.7, hy - hr * 1.1, hr * 1.4, hr * 0.6);
      ctx.fillStyle = '#3c2a63'; ctx.fillRect(cx - hr * 0.7, hy - hr * 0.75, hr * 1.4, hr * 0.22);
    } else if (opts.hat === 'peak') { // security peaked cap
      ctx.fillStyle = opts.hatColor || '#12141c';
      ctx.beginPath(); ctx.arc(cx, hy - hr * 0.3, hr * 0.95, Math.PI, 0); ctx.fill();
      ctx.fillRect(cx - hr, hy - hr * 0.34, hr * 2, hr * 0.34);
      ctx.fillStyle = '#2a2e3a'; ctx.fillRect(cx - hr * 1.05, hy - hr * 0.1, hr * 1.2 * (opts.facing >= 0 ? 1 : -1) + (opts.facing >= 0 ? 0 : hr * 1.05), hr * 0.2);
    }
    if (opts.shades) { // dark glasses
      ctx.fillStyle = '#0c0c12';
      ctx.fillRect(cx - hr * 0.7, cy - bh - hr * 0.45, hr * 1.4, hr * 0.32);
    }
    ctx.globalAlpha = 1;
  }

  var _tint = {};
  function shade(hex, k) {
    var key = hex + '|' + k; if (_tint[key]) return _tint[key];
    var v = parseInt(hex.slice(1), 16), r = (v >> 16) & 255, g = (v >> 8) & 255, b = v & 255;
    if (k > 0) { r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k; }
    else { r *= 1 + k; g *= 1 + k; b *= 1 + k; }
    var out = 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')'; _tint[key] = out; return out;
  }
  function lighten(hex, k) { return hex[0] === '#' ? shade(hex, k) : hex; }
  function darken(hex, k) { return hex[0] === '#' ? shade(hex, -k) : hex; }
  function hashStr(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }

  function outfitFor(game, npc, idx) {
    var pal = S.dark ? COMMON.outfitsEve : COMMON.outfitsDay;
    var key = npc.group ? hashStr(npc.group) : idx * 7 + 3;
    return pal[Math.floor(hash(key, 3, game.seed) * pal.length)];
  }

  function drawNpc(ctx, game, npc, idx, cam, alpha) {
    var x = lerp(npc.px, npc.x, alpha), y = lerp(npc.py, npc.y, alpha);
    var sy = (y + 0.5) * TILE - cam;
    if (sy < -TILE * 1.5 || sy > S.viewH + TILE * 1.5) return;
    var cx = (x + 0.5) * TILE, sc = scaleAt(sy);
    var facing = Math.cos(npc.heading) >= 0 ? 1 : -1;
    var moving = npc.mode !== 'stopped';
    var phase = game.time * (3 + (npc.speed || 1) * 4) + idx * 1.7;
    var outfit = outfitFor(game, npc, idx);
    var skin = COMMON.skin[Math.floor(hash(idx, 5, game.seed) * COMMON.skin.length)];

    if (npc.type === 'seated') {
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.42, bodyH: 0.4, headR: 0.11, body: outfit, skin: skin,
        seated: true, hat: hash(idx, 8, game.seed) < 0.5 ? 'sun' : null, phase: 0, moving: false, facing: idx % 2 ? 1 : -1 });
    } else if (npc.type === 'wheelchair') {
      drawWheelchair(ctx, game, cx, sy, sc, facing, outfit, skin, idx);
    } else if (npc.type === 'kid') {
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.26, bodyH: 0.26, headR: 0.10, body: outfit, skin: skin,
        hat: 'cap', hatColor: hash(idx, 4, 2) < 0.5 ? '#31527d' : '#8f3d4a', phase: phase, moving: moving, facing: facing });
      if (S.dark) {
        var gcol = ['rgba(126,240,208,', 'rgba(255,140,160,', 'rgba(160,150,255,'][idx % 3];
        ctx.strokeStyle = gcol + '0.9)'; ctx.lineWidth = 2.5 * sc;
        ctx.beginPath(); ctx.moveTo(cx + facing * TILE * 0.16 * sc, sy - TILE * 0.2 * sc);
        ctx.lineTo(cx + facing * TILE * 0.26 * sc, sy - TILE * 0.34 * sc); ctx.stroke();
      }
    } else if (npc.type === 'steward') {
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.42, bodyH: 0.46, headR: 0.11, body: '#2c3e63', legs: '#20293f',
        skin: skin, hat: 'cap', hatColor: '#1f2c49', phase: phase, moving: true, facing: facing });
      var viz = 0.6 + 0.4 * Math.sin(game.time * 6 + idx);
      ctx.fillStyle = 'rgba(242,207,74,' + viz + ')';
      ctx.fillRect(cx - TILE * 0.16 * sc, sy - TILE * 0.42 * sc, TILE * 0.09 * sc, TILE * 0.34 * sc);
    } else if (npc.type === 'security') {
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.46, bodyH: 0.48, headR: 0.115, body: '#20222c', legs: '#141620',
        skin: skin, hat: 'peak', hatColor: '#12141c', shades: true, phase: phase, moving: true, facing: facing });
      // hi-vis "SECURITY" band
      ctx.fillStyle = '#f2cf4a';
      ctx.fillRect(cx - TILE * 0.22 * sc, sy - TILE * 0.34 * sc, TILE * 0.44 * sc, TILE * 0.08 * sc);
      if (npc.chasing) {
        ctx.fillStyle = '#ff5a5a'; ctx.font = 'bold ' + Math.round(TILE * 0.36 * sc) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', cx, sy - TILE * 0.9 * sc - Math.abs(Math.sin(game.time * 9)) * 4);
      }
    } else if (npc.type === 'fan') {
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.36, bodyH: 0.4, headR: 0.11, body: npc.chasing ? '#b8404d' : '#96586e',
        skin: skin, hat: 'boater', phase: phase * (npc.chasing ? 1.8 : 1), moving: moving, facing: facing });
      ctx.fillStyle = '#e8e2d2'; ctx.fillRect(cx + facing * TILE * 0.22 * sc, sy - TILE * 0.5 * sc, 8 * sc, 6 * sc);
      if (npc.chasing) {
        ctx.fillStyle = '#ffdf5e'; ctx.font = 'bold ' + Math.round(TILE * 0.34 * sc) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('!', cx, sy - TILE * 0.85 * sc - Math.abs(Math.sin(game.time * 8)) * 4);
      }
    } else { // posh
      drawFigure(ctx, cx, sy, sc, { bodyW: 0.5, bodyH: 0.46, headR: 0.12, body: outfit, skin: skin,
        hat: 'sun', phase: phase, moving: moving, facing: facing });
      if (hash(idx, 13, game.seed) < 0.3) { ctx.fillStyle = '#e8d98f'; ctx.fillRect(cx + facing * TILE * 0.3 * sc, sy - TILE * 0.46 * sc, 3 * sc, 7 * sc); }
    }
    if (npc.mode === 'stopped') {
      ctx.fillStyle = 'rgba(235,235,245,0.8)'; ctx.font = Math.round(TILE * 0.25 * sc) + 'px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.fillText('…', cx + TILE * 0.3 * sc, sy - TILE * 0.66 * sc);
    }
  }

  function drawWheelchair(ctx, game, cx, cy, sc, facing, outfit, skin, idx) {
    ellipseShadow(ctx, cx, cy, TILE * 0.36 * sc, 0.26);
    var spin = game.time * 7 + idx;
    ctx.strokeStyle = S.dark ? '#454552' : '#3a3a44'; ctx.lineWidth = 3 * sc;
    ctx.beginPath(); ctx.arc(cx - facing * TILE * 0.14 * sc, cy - TILE * 0.1 * sc, TILE * 0.18 * sc, 0, 7); ctx.stroke();
    ctx.strokeStyle = S.dark ? 'rgba(126,240,208,0.5)' : 'rgba(58,58,68,0.5)'; ctx.lineWidth = 1.5 * sc;
    for (var s = 0; s < 3; s++) {
      var a = spin + s * Math.PI / 3;
      ctx.beginPath();
      ctx.moveTo(cx - facing * TILE * 0.14 * sc - Math.cos(a) * TILE * 0.16 * sc, cy - TILE * 0.1 * sc - Math.sin(a) * TILE * 0.16 * sc);
      ctx.lineTo(cx - facing * TILE * 0.14 * sc + Math.cos(a) * TILE * 0.16 * sc, cy - TILE * 0.1 * sc + Math.sin(a) * TILE * 0.16 * sc); ctx.stroke();
    }
    ctx.strokeStyle = S.dark ? '#454552' : '#3a3a44'; ctx.lineWidth = 3 * sc;
    ctx.beginPath(); ctx.arc(cx + facing * TILE * 0.2 * sc, cy - TILE * 0.04 * sc, TILE * 0.09 * sc, 0, 7); ctx.stroke();
    ctx.fillStyle = outfit;
    roundRect(ctx, cx - TILE * 0.14 * sc, cy - TILE * 0.42 * sc, TILE * 0.3 * sc, TILE * 0.36 * sc, 6 * sc); ctx.fill();
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(cx, cy - TILE * 0.5 * sc, TILE * 0.11 * sc, 0, 7); ctx.fill();
  }

  function drawPhotographerPair(ctx, game, ph, cam) {
    var sy = (ph.row + 0.5) * TILE - cam;
    if (sy < -TILE || sy > S.viewH + TILE) return;
    drawOnePhotographer(ctx, game, ph, ph.leftCol, sy, 1);
    drawOnePhotographer(ctx, game, ph, ph.rightCol, sy, -1);
  }
  function drawOnePhotographer(ctx, game, ph, col, sy, face) {
    var cx = (col + 0.5) * TILE, sc = scaleAt(sy);
    drawFigure(ctx, cx, sy, sc, { bodyW: 0.4, bodyH: 0.42, headR: 0.11, body: S.dark ? '#8a8474' : '#c9c0a8',
      skin: COMMON.skin[Math.floor(hash(col, ph.row, game.seed) * COMMON.skin.length)], hat: null, phase: 0, moving: false, facing: face });
    var px = cx + face * TILE * 0.28 * sc, py = sy - TILE * 0.38 * sc;
    ctx.fillStyle = '#15151d'; ctx.fillRect(px - 4 * sc, py - 7 * sc, 8 * sc, 14 * sc);
    ctx.fillStyle = 'rgba(126,240,208,0.9)'; ctx.fillRect(px - 2.5 * sc, py - 5 * sc, 5 * sc, 10 * sc);
    if (ph.phase === 'charging') {
      ctx.fillStyle = 'rgba(255,215,64,' + (0.5 + 0.5 * Math.sin(game.time * 24)) + ')';
      ctx.beginPath(); ctx.arc(px, py - 12 * sc, 4 * sc, 0, 7); ctx.fill();
    }
    if (ph.phase === 'flash') {
      var g = ctx.createRadialGradient(px, py, 2, px, py, TILE * 2.2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, TILE * 2.2, 0, 7); ctx.fill();
    }
  }

  function drawBall(ctx, game, b, cam) {
    var sy = (b.y + 0.5) * TILE - cam;
    if (sy < -TILE || sy > S.viewH + TILE) return;
    var cx = (b.x + 0.5) * TILE, sc = scaleAt(sy), R = TILE * 0.22 * sc;
    ellipseShadow(ctx, cx, sy + TILE * 0.22 * sc, R * 0.9, 0.24);
    if (b.serve > 0) { // serve telegraph: a pulsing marker where it will fly from
      var pl = 0.4 + 0.6 * Math.abs(Math.sin(game.time * 8));
      ctx.strokeStyle = 'rgba(214,242,74,' + pl + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, sy, R * (1.6 + pl), 0, 7); ctx.stroke();
    } else { // motion streak along velocity
      var m = Math.hypot(b.vx, b.vy) || 1;
      ctx.strokeStyle = 'rgba(214,242,74,0.4)'; ctx.lineWidth = R * 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx, sy); ctx.lineTo(cx - b.vx / m * R * 2.4, sy - b.vy / m * R * 2.4); ctx.stroke();
    }
    var g = ctx.createRadialGradient(cx - R * 0.3, sy - R * 0.3, R * 0.2, cx, sy, R * 1.2);
    g.addColorStop(0, '#eaff8a'); g.addColorStop(1, '#a8c832');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, sy, R, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, sy, R, -0.7, 0.7); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, sy, R, Math.PI - 0.7, Math.PI + 0.7); ctx.stroke();
  }

  function drawPlayer(ctx, game, cam, alpha) {
    var p = game.player;
    var x = lerp(p.px, p.x, alpha), y = lerp(p.py, p.y, alpha);
    var cx = (x + 0.5) * TILE, sy = (y + 0.5) * TILE - cam, sc = scaleAt(sy);
    var a = 1;
    if (game.invuln > 0) a = (Math.sin(game.time * 22) > 0) ? 0.9 : 0.35;
    var bob = 0, stretch = 1, lean = 0;
    if (p.moving) { bob = Math.abs(Math.sin(game.time * 11)) * 2.2 * sc; lean = p.dirX * 2.5 * sc; }
    if (p.dash) {
      stretch = 1.2;
      ctx.strokeStyle = 'rgba(126,240,208,0.5)'; ctx.lineWidth = TILE * 0.28 * sc; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx - p.dash.dx * TILE * 1.3, sy - p.dash.dy * TILE * 1.3); ctx.lineTo(cx, sy); ctx.stroke();
    }
    ctx.globalAlpha = a;
    ellipseShadow(ctx, cx, sy, TILE * 0.26 * sc, 0.32);
    var cy = sy - bob; cx += lean;
    var bw = TILE * 0.38 * sc, bh = TILE * 0.48 * sc * stretch;
    ctx.strokeStyle = COMMON.black; ctx.lineWidth = Math.max(3, bw * 0.2); ctx.lineCap = 'round';
    if (p.moving) {
      var la = Math.sin(game.time * 11) * bw * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.18, cy - bh * 0.22); ctx.lineTo(cx - bw * 0.18 + la, sy + 2);
      ctx.moveTo(cx + bw * 0.18, cy - bh * 0.22); ctx.lineTo(cx + bw * 0.18 - la, sy + 2); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - bw * 0.18, cy - bh * 0.2); ctx.lineTo(cx - bw * 0.18, cy + 2);
      ctx.moveTo(cx + bw * 0.18, cy - bh * 0.2); ctx.lineTo(cx + bw * 0.18, cy + 2); ctx.stroke();
    }
    var g = ctx.createLinearGradient(cx - bw / 2, 0, cx + bw / 2, 0);
    g.addColorStop(0, '#2e2d38'); g.addColorStop(1, '#0c0c12');
    ctx.fillStyle = g; roundRect(ctx, cx - bw / 2, cy - bh, bw, bh, bw * 0.35); ctx.fill();
    ctx.fillStyle = '#e0af84'; ctx.beginPath(); ctx.arc(cx, cy - bh - TILE * 0.09 * sc, TILE * 0.115 * sc, 0, 7); ctx.fill();
    ctx.strokeStyle = COMMON.accent; ctx.lineWidth = 2.5 * sc;
    ctx.beginPath(); ctx.arc(cx, cy - bh - TILE * 0.09 * sc, TILE * 0.13 * sc, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    ctx.fillStyle = COMMON.accent; ctx.beginPath(); ctx.arc(cx - TILE * 0.13 * sc, cy - bh - TILE * 0.08 * sc, 3 * sc, 0, 7); ctx.fill();
    ctx.fillStyle = '#c5342b'; ctx.fillRect(cx + TILE * 0.08 * sc, cy - bh * 0.25, 5 * sc, 8 * sc);
    if (p.stun > 0) {
      ctx.fillStyle = COMMON.water;
      for (var d = 0; d < 3; d++) {
        var t = (game.time * 2 + d * 0.4) % 1;
        ctx.beginPath(); ctx.arc(cx - 8 + d * 8, cy - bh - 14 + t * 20, 2.5, 0, 7); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------- particles
  function spawn(x, y, opts) {
    S.particles.push({ x: x, y: y, vx: opts.vx || 0, vy: opts.vy || 0, g: opts.g || 0,
      life: opts.life || 0.6, age: 0, size: opts.size || 3, color: opts.color || '#fff', fade: opts.fade !== false });
    if (S.particles.length > 400) S.particles.splice(0, S.particles.length - 400);
  }
  function burst(x, y, n, mk) { for (var i = 0; i < n; i++) mk(i, Math.PI * 2 * i / n + Math.random() * 0.5); }

  function onEvents(game, events) {
    var p = game.player, px = (p.x + 0.5) * TILE, py = (p.y + 0.5) * TILE;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'berry' || e.type === 'goldBerry') {
        var col = e.type === 'goldBerry' ? '#ffd650' : '#ff8091';
        burst(px, py, e.type === 'goldBerry' ? 20 : 9, function (j, a) {
          spawn(px, py, { vx: Math.cos(a) * 60, vy: Math.sin(a) * 60 - 40, g: 160, life: 0.55, size: 2.5, color: col }); });
      } else if (e.type === 'dash') {
        burst(px, py, 12, function (j, a) { spawn(px, py, { vx: Math.cos(a) * 90, vy: Math.sin(a) * 30, life: 0.4, size: 3, color: 'rgba(126,240,208,0.9)' }); });
      } else if (e.type === 'ballBatted') {
        burst(px, py, 12, function (j, a) { spawn(px, py, { vx: Math.cos(a) * 100, vy: Math.sin(a) * 100, g: 120, life: 0.5, size: 3, color: '#d6f24a' }); });
        S.shakeT = 0.2; S.shakeMag = 3;
      } else if (e.type === 'lollipopSave' || e.type === 'umbrellaSave' || e.type === 'flashBlocked') {
        burst(px, py, 14, function (j, a) { spawn(px, py, { vx: Math.cos(a) * 70, vy: Math.sin(a) * 70 - 30, g: 120, life: 0.6, size: 2.5, color: '#7ef0d0' }); });
      } else if (e.type === 'hit') {
        S.shakeT = 0.45; S.shakeMag = 7;
        burst(px, py, 14, function (j, a) { spawn(px, py, { vx: Math.cos(a) * 120, vy: Math.sin(a) * 120 - 60, g: 260, life: 0.6, size: 3, color: '#e0524f' }); });
      } else if (e.type === 'dead') { S.shakeT = 0.7; S.shakeMag = 10; }
      else if (e.type === 'photobomb') { S.shakeT = 0.25; S.shakeMag = 4; }
      else if (e.type === 'sprinklerHit') {
        S.shakeT = 0.3; S.shakeMag = 4;
        burst(px, py, 16, function (j, a) { spawn(px, py - 10, { vx: Math.cos(a) * 80, vy: -Math.abs(Math.sin(a)) * 130, g: 300, life: 0.7, size: 2.5, color: 'rgba(140,205,240,0.9)' }); });
      } else if (e.type === 'checkpoint') {
        burst(px, py, 12, function (j, a) { spawn(px, py, { vx: Math.cos(a) * 50, vy: Math.sin(a) * 50 - 70, g: 120, life: 0.8, size: 2.5, color: '#7ef0d0' }); });
      } else if (e.type === 'won') {
        for (var cfx = 0; cfx < 90; cfx++) {
          spawn(Math.random() * game.cols * TILE, -20 + Math.random() * -200, {
            vx: (Math.random() - 0.5) * 40, vy: 60 + Math.random() * 80, g: 30, life: 3.5,
            size: 3 + Math.random() * 3, color: ['#e0524f', '#ffd650', '#8a5fc9', '#7ef0d0', '#f2d8e1'][cfx % 5] });
        }
      }
    }
  }

  function stepAndDrawParticles(ctx, cam, dt) {
    for (var i = S.particles.length - 1; i >= 0; i--) {
      var pt = S.particles[i]; pt.age += dt;
      if (pt.age >= pt.life) { S.particles.splice(i, 1); continue; }
      pt.vy += pt.g * dt; pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      var k = 1 - pt.age / pt.life;
      ctx.globalAlpha = pt.fade ? k : 1; ctx.fillStyle = pt.color;
      ctx.fillRect(pt.x - pt.size / 2, pt.y - cam - pt.size / 2, pt.size, pt.size);
    }
    ctx.globalAlpha = 1;
  }

  function stepAndDrawFireflies(ctx, game, cam, dt) {
    for (var i = 0; i < S.fireflies.length; i++) {
      var b = S.fireflies[i]; b.t += dt;
      b.a += (hash(i, Math.floor(b.t), 5) - 0.5) * 2.2 * dt * 4;
      b.x += Math.cos(b.a) * 0.4 * dt; b.y += Math.sin(b.a) * 0.4 * dt;
      b.x = clamp(b.x, 0.5, game.cols - 1.5); b.y = clamp(b.y, 1, game.numRows - 2);
      var sx = (b.x + 0.5) * TILE, sy = (b.y + 0.5) * TILE - cam + Math.sin(b.t * 3) * 4;
      if (sy < -20 || sy > S.viewH + 20) continue;
      var pulse = Math.max(0, Math.sin(b.t * 2.2 + i * 2));
      ctx.fillStyle = 'rgba(200,255,160,' + (0.12 + 0.3 * pulse) + ')';
      ctx.beginPath(); ctx.arc(sx, sy, 5 + pulse * 3, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(230,255,190,' + (0.5 + 0.5 * pulse) + ')'; ctx.fillRect(sx - 1, sy - 1, 2, 2);
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

    ctx.fillStyle = S.theme.sky[3];
    ctx.fillRect(0, 0, w, S.viewH);
    var horizon = -cam;
    if (horizon > 0) drawSky(ctx, game, w, horizon);

    drawGround(ctx, game, cam, w);
    for (var ci = 0; ci < game.courts.length; ci++) drawCourt(ctx, game.courts[ci], cam);
    drawHazardZones(ctx, game, cam);
    drawLightPools(ctx, game, cam, w, alpha);
    drawMist(ctx, game, cam, w);

    for (var i = 0; i < game.berries.length; i++) if (game.berries[i].alive) drawBerry(ctx, game, game.berries[i], cam);
    for (var sp = 0; sp < game.sprinklers.length; sp++) drawSprinklerHead(ctx, game, game.sprinklers[sp], cam);

    // Painter's order: props + people + balls + player, sorted by world y.
    var order = [];
    for (var pr = 0; pr < S.props.length; pr++) order.push(S.props[pr]);
    for (var ln = 0; ln < S.lanterns.length; ln++) order.push({ y: S.lanterns[ln].y + 0.1, kind: 'lantern', ln: S.lanterns[ln] });
    for (var stn = 0; stn < S.strands.length; stn++) order.push({ y: S.strands[stn], kind: 'strand', row: S.strands[stn] });
    for (var n = 0; n < game.npcs.length; n++) order.push({ y: lerp(game.npcs[n].py, game.npcs[n].y, alpha), kind: 'npc', npc: game.npcs[n], idx: n });
    for (var f = 0; f < game.photographers.length; f++) order.push({ y: game.photographers[f].row, kind: 'photo', ph: game.photographers[f] });
    for (var bl = 0; bl < game.balls.length; bl++) order.push({ y: lerp(game.balls[bl].y, game.balls[bl].y, alpha), kind: 'ball', ball: game.balls[bl] });
    order.push({ y: lerp(game.player.py, game.player.y, alpha) + 0.01, kind: 'player' });
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
      else if (it.kind === 'ball') drawBall(ctx, game, it.ball, cam);
      else if (it.kind === 'player') drawPlayer(ctx, game, cam, alpha);
    }

    if (S.dark) stepAndDrawFireflies(ctx, game, cam, dt);
    stepAndDrawParticles(ctx, cam, dt);
    drawHeatHaze(ctx, game, w);

    for (var fl = 0; fl < game.photographers.length; fl++) {
      if (game.photographers[fl].phase === 'flash') {
        ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(0, 0, w, S.viewH); break;
      }
    }
    if (S.theme.ambient) { ctx.fillStyle = S.theme.ambient; ctx.fillRect(0, 0, w, S.viewH); }
    if (S.vignette) ctx.drawImage(S.vignette, 0, 0, w, S.viewH);
    ctx.restore();
  }

  root.GameRender = { TILE: TILE, setupCanvas: setupCanvas, resize: resize, draw: draw, onEvents: onEvents };
})(typeof self !== 'undefined' ? self : this);
