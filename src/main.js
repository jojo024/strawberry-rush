/*
 * Strawberry Rush — shell: game loop, campaign, shop, handbook, HUD.
 *
 * Fixed-timestep simulation (60 Hz) with render interpolation. Free movement:
 * every tick the shell reads the live input vector and feeds it to the logic;
 * double-tap / Shift requests a dash.
 *
 * Campaign & economy:
 *  - 8 levels back to back. Strawberries are a persistent CURRENCY (the
 *    "bank"): they carry between levels, a dash spends 3, and the shop spends
 *    them on gear.
 *  - Between levels a SHOP/loadout screen lets you buy items & passives (owned
 *    forever), equip one passive + two items, and upgrade items to be
 *    reusable. Purchases persist in localStorage across playthroughs.
 *  - Hearts refill each level; dying retries the level with the bank & loadout
 *    you entered it with. Best campaign time persists.
 */
(function () {
  'use strict';

  var GL = window.GameLogic, GR = window.GameRender;
  var DT = 1 / 60;
  var MAX_FRAME = 0.25;
  var SAVE_KEY = 'strawberryRushSaveV5';

  var canvas = document.getElementById('game');
  var el = function (id) { return document.getElementById(id); };
  var hud = {
    hearts: el('hud-hearts'), berries: el('hud-berries'), dash: el('hud-dash'),
    item1: el('hud-item1'), item2: el('hud-item2'), passive: el('hud-passive'),
    zone: el('hud-zone'), time: el('hud-time'), sloth: el('hud-sloth'),
    progress: el('progress-fill'), toast: el('toast'),
    overlay: el('overlay'), overlayTitle: el('overlay-title'),
    overlaySub: el('overlay-sub'), overlayButtons: el('overlay-buttons'),
    shop: el('shop'), shopBank: el('shop-bank'), shopBody: el('shop-body'),
    handbook: el('handbook'), handbookBody: el('handbook-body')
  };

  // ---- persistent profile -------------------------------------------------
  function defaultProfile() {
    return { owned: {}, upgraded: {}, passivesOwned: { none: true },
             loadout: { passive: 'none', items: [] }, bestTime: null };
  }
  var profile = loadProfile();
  function loadProfile() {
    try {
      var p = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (p && p.owned) { return Object.assign(defaultProfile(), p); }
    } catch (e) { /* ignore */ }
    return defaultProfile();
  }
  function saveProfile() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(profile)); } catch (e) {} }

  var shell = {
    mode: 'menu',          // 'menu' | 'shop' | 'playing' | 'dead' | 'won'
    levelIndex: 0,
    game: null,
    bank: 0,               // strawberries carried (currency)
    levelStartBank: 0,
    totalTime: 0,
    acc: 0, last: 0,
    lastZone: '', toastTimer: null,
    handbookReturn: null   // where to go when the handbook closes
  };
  var input;

  // ---- helpers ------------------------------------------------------------
  function fmtTime(t) {
    var m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
  }
  function currentLoadout() {
    return { passive: profile.loadout.passive, items: profile.loadout.items.slice(), upgraded: profile.upgraded };
  }

  // ---- screen visibility --------------------------------------------------
  function show(screen) { screen.classList.remove('hidden'); }
  function hide(screen) { screen.classList.add('hidden'); }
  function hideAllScreens() { hide(hud.overlay); hide(hud.shop); hide(hud.handbook); }

  function overlay(title, sub, buttons) {
    hud.overlayTitle.textContent = title;
    hud.overlaySub.textContent = sub;
    hud.overlayButtons.innerHTML = '';
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn' + (b.ghost ? ' ghost' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      hud.overlayButtons.appendChild(btn);
    });
    hideAllScreens(); show(hud.overlay);
  }

  // ---- campaign flow ------------------------------------------------------
  function openShop(nextIndex) {
    shell.mode = 'shop';
    shell.levelIndex = nextIndex;
    buildShop(nextIndex);
    hideAllScreens(); show(hud.shop);
  }

  function startLevel(index) {
    shell.levelIndex = index;
    shell.levelStartBank = shell.bank;
    shell.game = GL.createGame(GL.LEVELS[index], (Date.now() ^ (index * 7919)) >>> 0, currentLoadout());
    shell.game.strawberries = shell.bank;
    GR.setupCanvas(canvas, shell.game);
    shell.mode = 'playing';
    shell.lastZone = zoneLabel();
    hideAllScreens();
    updateHud();
  }

  function startCampaign() { shell.bank = 0; shell.totalTime = 0; openShop(0); }

  var DEATH_LINES = {
    posh: 'Flattened by a gentleman in linen. He didn’t even notice.',
    wheelchair: 'Clipped by a very determined wheelchair user.',
    kid: 'Bowled over by a sprinting child. (A lollipop would have helped.)',
    steward: 'Escorted firmly off the premises by a steward.',
    security: 'Detained by security. (Accreditation, perhaps?)',
    fan: 'Mobbed for an autograph you couldn’t give.',
    ball: 'Beaned by a stray serve. (Bring a racket next time.)'
  };

  function onGameOver(cause) {
    shell.mode = 'dead';
    overlay('Out of hearts!',
      (DEATH_LINES[cause] || 'The crowd claims another victim.') +
      '  You retry ' + GL.LEVELS[shell.levelIndex].name + ' with what you brought in.',
      [{ label: 'Retry level', onClick: function () { shell.bank = shell.levelStartBank; startLevel(shell.levelIndex); } },
       { label: 'Handbook', ghost: true, onClick: function () { openHandbook('dead'); } }]);
  }

  function onLevelWon(e) {
    shell.bank = shell.game.strawberries;
    shell.totalTime += e.time;
    if (shell.levelIndex >= GL.LEVELS.length - 1) {
      shell.mode = 'won';
      var line = 'All ' + GL.LEVELS.length + ' grounds crossed in ' + fmtTime(shell.totalTime) +
                 ' with ' + shell.bank + ' 🍓 banked.';
      if (profile.bestTime === null || shell.totalTime < profile.bestTime) {
        line += profile.bestTime === null ? '  A time to beat!' : '  New best! (was ' + fmtTime(profile.bestTime) + ')';
        profile.bestTime = shell.totalTime; saveProfile();
      } else line += '  Best: ' + fmtTime(profile.bestTime) + '.';
      overlay('LUNCH ACQUIRED 🍓', line,
        [{ label: 'Play again', onClick: startCampaign },
         { label: 'Handbook', ghost: true, onClick: function () { openHandbook('won'); } }]);
    } else {
      overlay('Level ' + (shell.levelIndex + 1) + ' clear!',
        'Crossed “' + GL.LEVELS[shell.levelIndex].name + '” in ' + fmtTime(e.time) +
        '. Next up: “' + GL.LEVELS[shell.levelIndex + 1].name + '” — ' +
        GL.LEVELS[shell.levelIndex + 1].intro,
        [{ label: 'To the shop →', onClick: function () { openShop(shell.levelIndex + 1); } }]);
    }
  }

  function onDash() { if (shell.mode === 'playing') GL.tryDash(shell.game); }

  // ---- shop ---------------------------------------------------------------
  function canAfford(cost) { return shell.bank >= cost; }

  function buildShop(nextIndex) {
    var lvl = GL.LEVELS[nextIndex];
    hud.shopBank.textContent = '🍓 ' + shell.bank + ' in the bank  ·  next: ' + lvl.name +
      (nextIndex === 0 ? '' : '  ·  “' + lvl.intro + '”');
    var body = hud.shopBody;
    body.innerHTML = '';

    // Passives (choose one).
    body.appendChild(sectionTitle('Passive skill — equip one'));
    var pg = grid();
    Object.keys(GL.PASSIVES).forEach(function (key) {
      if (key === 'none') return;
      pg.appendChild(passiveCard(key));
    });
    // "no passive" toggle
    pg.appendChild(passiveCard('none'));
    body.appendChild(pg);

    // Items (own many, equip two).
    body.appendChild(sectionTitle('Active items — equip up to two'));
    var ig = grid();
    Object.keys(GL.ITEMS).forEach(function (key) { ig.appendChild(itemCard(key)); });
    body.appendChild(ig);
  }

  function sectionTitle(t) {
    var d = document.createElement('div'); d.className = 'shop-section-title'; d.textContent = t; return d;
  }
  function grid() { var d = document.createElement('div'); d.className = 'card-grid'; return d; }

  function passiveCard(key) {
    var def = GL.PASSIVES[key];
    var owned = key === 'none' || profile.passivesOwned[key];
    var equipped = profile.loadout.passive === key;
    var card = document.createElement('div');
    card.className = 'card' + (equipped ? ' equipped' : '');
    card.innerHTML = '<div class="name">' + def.name + '</div>' +
      '<div class="desc">' + def.desc + '</div>';
    var row = document.createElement('div'); row.className = 'row';
    if (!owned) {
      row.appendChild(costTag(def.cost));
      row.appendChild(miniBtn('Buy', 'buy', !canAfford(def.cost), function () {
        shell.bank -= def.cost; profile.passivesOwned[key] = true; saveProfile(); refreshShop();
      }));
    } else {
      row.appendChild(miniBtn(equipped ? 'Equipped' : 'Equip', equipped ? 'on' : 'equip', false, function () {
        profile.loadout.passive = key; saveProfile(); refreshShop();
      }));
    }
    card.appendChild(row);
    return card;
  }

  function itemCard(key) {
    var def = GL.ITEMS[key];
    var owned = profile.owned[key];
    var upgraded = profile.upgraded[key];
    var equipped = profile.loadout.items.indexOf(key) !== -1;
    var slotsFull = profile.loadout.items.length >= 2 && !equipped;
    var card = document.createElement('div');
    card.className = 'card' + (equipped ? ' equipped' : '');
    var counters = { ball: 'tennis balls', kid: 'children', sprinkler: 'sprinklers',
                     flash: 'photo flashes', security: 'security guards', wheelchair: 'wheelchairs' }[def.counters] || def.counters;
    card.innerHTML = '<div class="name">' + def.name +
      (upgraded ? ' <span class="tag">' + def.upgradeName + '</span>' : '') + '</div>' +
      '<div class="desc">' + def.desc + ' <em style="opacity:.7">(vs ' + counters + ')</em>' +
      (upgraded ? '<br><span style="color:var(--accent)">' + def.upgradeDesc + '</span>' : '') + '</div>';
    var row = document.createElement('div'); row.className = 'row';
    if (!owned) {
      row.appendChild(costTag(def.cost));
      row.appendChild(miniBtn('Buy', 'buy', !canAfford(def.cost), function () {
        shell.bank -= def.cost; profile.owned[key] = true; saveProfile(); refreshShop();
      }));
    } else {
      row.appendChild(miniBtn(equipped ? 'Equipped' : 'Equip', equipped ? 'on' : 'equip', slotsFull, function () {
        var items = profile.loadout.items, i = items.indexOf(key);
        if (i !== -1) items.splice(i, 1);
        else if (items.length < 2) items.push(key);
        saveProfile(); refreshShop();
      }));
      if (!upgraded) {
        row.appendChild(miniBtn('Upgrade ' + def.upgradeCost + '🍓', 'up', !canAfford(def.upgradeCost), function () {
          shell.bank -= def.upgradeCost; profile.upgraded[key] = true; saveProfile(); refreshShop();
        }));
      } else {
        var ug = document.createElement('span'); ug.className = 'owned-tag'; ug.textContent = 'upgraded'; row.appendChild(ug);
      }
    }
    card.appendChild(row);
    return card;
  }

  function costTag(c) { var s = document.createElement('span'); s.className = 'cost'; s.textContent = c + '🍓'; return s; }
  function miniBtn(label, cls, disabled, onClick) {
    var b = document.createElement('button'); b.className = 'mini ' + cls; b.textContent = label;
    if (disabled) b.disabled = true; else b.addEventListener('click', onClick);
    return b;
  }
  function refreshShop() { buildShop(shell.levelIndex); }

  // ---- handbook -----------------------------------------------------------
  function openHandbook(returnTo) {
    shell.handbookReturn = returnTo;
    buildHandbook();
    hideAllScreens(); show(hud.handbook);
  }
  function closeHandbook() {
    var r = shell.handbookReturn;
    hide(hud.handbook);
    if (r === 'shop') { show(hud.shop); }
    else if (r === 'menu' || r === 'dead' || r === 'won') { show(hud.overlay); }
  }

  function hbRow(k, v) {
    return '<div class="hb-row"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>';
  }
  function buildHandbook() {
    var C = GL.C;
    var h = '';
    h += '<div class="hb-section"><h3>Controls</h3>' +
      hbRow('Move', 'Arrow keys / WASD — hold any combination for smooth 8-direction movement. On touch, press &amp; drag anywhere.') +
      hbRow('Dash', 'Double-tap a direction (or press Shift). A burst of speed that spends ' + C.DASH_COST + ' 🍓.') +
      hbRow('Goal', 'Reach the food truck at the top of each of the ' + GL.LEVELS.length + ' grounds.') + '</div>';

    h += '<div class="hb-section"><h3>Strawberries &amp; hearts</h3>' +
      hbRow('Strawberries 🍓', 'Your currency AND your fuel. Collect them on the ground, spend them on dashes and in the shop. They carry between levels.') +
      hbRow('Golden strawberry', 'One hides in every level, worth ' + C.GOLD_VALUE + ' 🍓 — usually somewhere risky.') +
      hbRow('Hearts', C.HEARTS + ' per level. A hit costs a heart + ' + C.HIT_BERRY_LOSS + ' 🍓 and sends you to your last checkpoint. Zero hearts = retry.') +
      hbRow('Sloth', 'Stand still ' + C.SLOTH_GRACE + 's and you start dropping a 🍓 every ' + C.SLOTH_INTERVAL + 's. Keep moving.') +
      hbRow('Warm days', 'Hotter levels (look for the haze) physically slow you. Linen Whites or a cooler head help.') + '</div>';

    h += '<div class="hb-section"><h3>The crowd &amp; hazards</h3>' +
      hbRow('Picnickers', 'Wander and change direction; walk in groups. Just don’t touch them.') +
      hbRow('Children', 'Tiny, fast, chaotic. A Lollipop lets you survive a collision.') +
      hbRow('Wheelchair users', 'Fast straight lines. Caltrops slow the ones near you.') +
      hbRow('Picnic rugs', 'Walkable, but they slow your step. Sure-Footed ignores them.') +
      hbRow('Photographers', 'Flash across a 2-tile gap. Cross during the flash and lose ' + C.PHOTOBOMB_LOSS + ' 🍓. Sunglasses ignore it.') +
      hbRow('Sprinklers', 'A blue ring warns, then a 3×3 spray soaks you: −' + C.SPRINKLER_LOSS + ' 🍓 and a brief stun. An Umbrella keeps you dry.') +
      hbRow('Security guards', 'Chase anyone without Accreditation. With a pass, they ignore you entirely.') +
      hbRow('Autograph fans', 'Chase you when you get close. Upgraded Accreditation makes them lose interest too.') +
      hbRow('Tennis balls', 'Fly around practice courts and cost a heart on contact. A Racket bats them away.') + '</div>';

    h += '<div class="hb-section"><h3>The shop — passives (equip one)</h3>';
    Object.keys(GL.PASSIVES).forEach(function (k) {
      if (k === 'none') return;
      h += hbRow(GL.PASSIVES[k].name + ' <span class="cost">' + GL.PASSIVES[k].cost + '🍓</span>', GL.PASSIVES[k].desc);
    });
    h += '</div>';

    h += '<div class="hb-section"><h3>The shop — items (equip two)</h3>';
    Object.keys(GL.ITEMS).forEach(function (k) {
      var d = GL.ITEMS[k];
      h += hbRow(d.name + ' <span class="cost">' + d.cost + '🍓</span>',
        d.desc + ' <em style="opacity:.7">Upgrade (' + d.upgradeCost + '🍓): ' + d.upgradeDesc + '</em>');
    });
    h += '</div>';

    hud.handbookBody.innerHTML = h;
  }

  // ---- HUD ----------------------------------------------------------------
  function pulse(e2) { e2.classList.remove('pulse'); void e2.offsetWidth; e2.classList.add('pulse'); }
  function toast(msg) {
    hud.toast.textContent = msg; hud.toast.classList.add('show');
    clearTimeout(shell.toastTimer);
    shell.toastTimer = setTimeout(function () { hud.toast.classList.remove('show'); }, 1700);
  }
  function zoneLabel() {
    var g = shell.game; if (!g) return '';
    var zone = GL.zoneForRow(g.level, g.player.row);
    var name = g.player.row === 0 ? 'the food truck' : (zone ? zone.name : shell.lastZone);
    return 'L' + (shell.levelIndex + 1) + '/' + GL.LEVELS.length + ' · ' + name;
  }
  var ITEM_ICON = { racket: '🎾', lollipop: '🍭', umbrella: '☂️', sunglasses: '🕶️', accred: '🪪', caltrops: '✸' };
  function itemChipLabel(g, key) {
    var d = GL.ITEMS[key], icon = ITEM_ICON[key] || '?';
    if (d.mode === 'aura') return icon + ' ' + shortName(key);
    var ch = g.itemCharges[key];
    if (ch === Infinity) return icon + ' ∞';
    return icon + ' ×' + (ch || 0);
  }
  function shortName(key) {
    return { sunglasses: 'shades', accred: 'pass', caltrops: 'caltrops' }[key] || key;
  }
  function updateItemChip(chip, g, key) {
    chip.classList.remove('empty', 'spent');
    if (!key) { chip.textContent = '—'; chip.classList.add('empty'); return; }
    chip.textContent = itemChipLabel(g, key);
    if (GL.ITEMS[key].mode === 'charge' && g.itemCharges[key] === 0) chip.classList.add('spent');
  }

  function updateHud() {
    var g = shell.game; if (!g) return;
    var hearts = '';
    for (var i = 0; i < g.hearts; i++) hearts += '❤️';
    var maxH = GL.C.HEARTS + (GL.PASSIVES[g.loadout.passive].bonusHearts || 0);
    for (i = g.hearts; i < maxH; i++) hearts += '🖤';
    hud.hearts.textContent = hearts;
    hud.berries.textContent = '🍓 ' + g.strawberries;
    hud.time.textContent = fmtTime(shell.totalTime + g.time);
    var armed = g.strawberries >= GL.C.DASH_COST;
    hud.dash.textContent = armed ? 'dash ready' : 'dash 3 🍓';
    hud.dash.classList.toggle('armed', armed);

    updateItemChip(hud.item1, g, g.loadout.items[0]);
    updateItemChip(hud.item2, g, g.loadout.items[1]);
    var pas = GL.PASSIVES[g.loadout.passive];
    hud.passive.textContent = g.loadout.passive === 'none' ? 'no passive' : '★ ' + pas.name;

    var label = zoneLabel(); if (label) shell.lastZone = label;
    hud.zone.textContent = shell.lastZone;
    hud.progress.style.width = Math.round(100 * (1 - g.player.row / g.level.startRow)) + '%';

    var slothy = shell.mode === 'playing' && !g.player.moving &&
                 g.slothTimer >= GL.C.SLOTH_GRACE && g.strawberries > 0;
    hud.sloth.classList.toggle('hidden', !slothy);
  }

  function drainEvents() {
    var evts = shell.game.events; if (!evts.length) return;
    GR.onEvents(shell.game, evts);
    for (var i = 0; i < evts.length; i++) {
      var e = evts[i];
      if (e.type === 'berry') pulse(hud.berries);
      else if (e.type === 'goldBerry') { pulse(hud.berries); toast('Golden strawberry! +' + GL.C.GOLD_VALUE + ' 🍓'); }
      else if (e.type === 'photobomb' && e.lost > 0) { pulse(hud.berries); toast('Photobombed! −' + e.lost + ' 🍓'); }
      else if (e.type === 'slothLoss') pulse(hud.berries);
      else if (e.type === 'sprinklerHit') { pulse(hud.berries); toast('Soaked! −' + e.lost + ' 🍓'); }
      else if (e.type === 'umbrellaSave') toast('Umbrella up — stayed dry!');
      else if (e.type === 'lollipopSave') toast('Lollipop! The kid stopped for the sweet.');
      else if (e.type === 'ballBatted') toast('Nice backhand! Ball batted away.');
      else if (e.type === 'flashBlocked') { /* silent — shades just work */ }
      else if (e.type === 'itemUsed' && !e.reusable && e.left === 0) toast(itemName(e.key) + ' used up.');
      else if (e.type === 'hit') { pulse(hud.hearts); if (e.hearts > 0) toast('Ouch! Back to the checkpoint.'); }
      else if (e.type === 'checkpoint') toast('Checkpoint — ' + e.zone);
      else if (e.type === 'securitySpotted') toast('Security has spotted you — no pass!');
      else if (e.type === 'fanSpotted') toast('A fan has spotted you — run!');
      else if (e.type === 'dead') onGameOver(e.cause);
      else if (e.type === 'won') onLevelWon(e);
    }
    evts.length = 0;
  }
  function itemName(key) { return GL.ITEMS[key] ? GL.ITEMS[key].name : key; }

  // ---- game loop ----------------------------------------------------------
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

  // ---- input glue: Space/Enter advances the current screen ----------------
  function onAction() {
    if (shell.mode === 'menu') startCampaign();
    else if (shell.mode === 'shop') startLevel(shell.levelIndex);
    // 'dead'/'won' advance via their overlay buttons; handbook via its button.
  }

  // ---- boot ---------------------------------------------------------------
  input = GL_input();
  function GL_input() { return GameInput.createInput(onDash, onAction); }

  window.addEventListener('resize', function () { if (shell.game) GR.resize(canvas, shell.game); });
  el('shop-continue').addEventListener('click', function () { startLevel(shell.levelIndex); });
  el('shop-handbook').addEventListener('click', function () { openHandbook('shop'); });
  el('handbook-close').addEventListener('click', closeHandbook);

  // Pre-render the first grounds behind the menu.
  shell.game = GL.createGame(GL.LEVELS[0], 20260710, currentLoadout());
  GR.setupCanvas(canvas, shell.game);
  shell.mode = 'menu';
  var bestLine = profile.bestTime !== null ? ' · best ' + fmtTime(profile.bestTime) : '';
  overlay('Strawberry Rush 🍓',
    'An evening run across ' + GL.LEVELS.length + ' grounds to the food truck. Move freely; ' +
    'double-tap (or Shift) to dash. Strawberries are your currency — spend them on gear in the ' +
    'shop between levels. Learn each hazard as it arrives, one per level.' + bestLine,
    [{ label: 'Start', onClick: startCampaign },
     { label: 'Handbook', ghost: true, onClick: function () { openHandbook('menu'); } }]);
  updateHud();
  requestAnimationFrame(frame);
})();
