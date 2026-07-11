/*
 * Strawberry Rush — shell: game loop, campaign, shop, handbook, leaderboard.
 *
 * Two run modes:
 *  - RANKED: the 10 fixed-seed campaign levels. Finishing all 10 logs your
 *    score (remaining strawberries + total time) to a local leaderboard.
 *  - ENDLESS: procedurally generated levels forever, untracked, for practice
 *    and fun. Chosen from the menu or after a ranked run.
 *
 * Between every level a SHOP/loadout screen lets you spend strawberries
 * (currency) on gear, owned forever. After clearing a level you may Continue
 * or Replay it. Dying retries the level with the bank & loadout you entered.
 */
(function () {
  'use strict';

  var GL = window.GameLogic, GR = window.GameRender;
  var DT = 1 / 60;
  var MAX_FRAME = 0.25;
  var SAVE_KEY = 'strawberryRushSaveV5';
  var RANKED_COUNT = GL.LEVELS.length; // 10

  var el = function (id) { return document.getElementById(id); };
  var canvas = el('game');
  var hud = {
    hearts: el('hud-hearts'), berries: el('hud-berries'), dash: el('hud-dash'),
    item1: el('hud-item1'), item2: el('hud-item2'), passive: el('hud-passive'),
    zone: el('hud-zone'), time: el('hud-time'), sloth: el('hud-sloth'),
    progress: el('progress-fill'), toast: el('toast'),
    overlay: el('overlay'), overlayTitle: el('overlay-title'), overlaySub: el('overlay-sub'),
    overlayExtra: el('overlay-extra'), overlayButtons: el('overlay-buttons'),
    shop: el('shop'), shopTitle: el('shop-title'), shopBank: el('shop-bank'), shopBody: el('shop-body'),
    handbook: el('handbook'), handbookBody: el('handbook-body'),
    leaderboard: el('leaderboard'), lbSub: el('lb-sub'), lbBody: el('leaderboard-body'), lbButtons: el('leaderboard-buttons')
  };

  // ---- persistent profile -------------------------------------------------
  function defaultProfile() {
    return { owned: {}, upgraded: {}, passivesOwned: { none: true },
             loadout: { passive: 'none', items: [] }, bestTime: null,
             leaderboard: [], lastName: 'Player' };
  }
  var profile = loadProfile();
  function loadProfile() {
    try {
      var p = JSON.parse(localStorage.getItem(SAVE_KEY));
      if (p && p.owned) return Object.assign(defaultProfile(), p);
    } catch (e) {}
    return defaultProfile();
  }
  function saveProfile() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(profile)); } catch (e) {} }

  var shell = {
    mode: 'menu',                // 'menu' | 'shop' | 'playing'
    runMode: 'ranked',           // 'ranked' | 'endless'
    levelIndex: 0,               // ranked: 0..9
    endlessNum: 0,               // endless: 1..∞
    runSeed: 0,
    levelDef: null,              // the def currently being shopped-for / played
    game: null,
    bank: 0, levelStartBank: 0, totalTime: 0,
    pendingClear: null,          // {time, bank} awaiting Continue/Replay
    acc: 0, last: 0, lastZone: '', toastTimer: null, handbookReturn: null
  };
  var input;

  function fmtTime(t) { var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
  function currentLoadout() { return { passive: profile.loadout.passive, items: profile.loadout.items.slice(), upgraded: profile.upgraded }; }

  function show(s) { s.classList.remove('hidden'); }
  function hide(s) { s.classList.add('hidden'); }
  function hideAllScreens() { hide(hud.overlay); hide(hud.shop); hide(hud.handbook); hide(hud.leaderboard); }

  function overlay(title, sub, buttons, extraNode) {
    hud.overlayTitle.textContent = title;
    hud.overlaySub.textContent = sub;
    hud.overlayExtra.innerHTML = '';
    if (extraNode) hud.overlayExtra.appendChild(extraNode);
    hud.overlayButtons.innerHTML = '';
    (buttons || []).forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn' + (b.ghost ? ' ghost' : '');
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      hud.overlayButtons.appendChild(btn);
    });
    hideAllScreens(); show(hud.overlay);
    shell.mode = 'overlay';
  }

  // ---- level source -------------------------------------------------------
  function makeLevelDef() {
    if (shell.runMode === 'endless') return GL.generateEndless(shell.endlessNum, shell.runSeed);
    return GL.LEVELS[shell.levelIndex];
  }
  function levelLabel() {
    if (shell.runMode === 'endless') return 'Endless ' + shell.endlessNum;
    return 'Level ' + (shell.levelIndex + 1) + '/' + RANKED_COUNT;
  }

  // A brand-new run starts fresh: no strawberries, no gear, nothing owned.
  function resetRun() {
    profile.owned = {}; profile.upgraded = {}; profile.passivesOwned = { none: true };
    profile.loadout = { passive: 'none', items: [] };
    saveProfile();
  }

  // ---- campaign flow ------------------------------------------------------
  function startRanked() {
    resetRun();
    shell.runMode = 'ranked'; shell.levelIndex = 0; shell.bank = 0; shell.totalTime = 0;
    openShop();
  }
  function startEndless() {
    resetRun();
    shell.runMode = 'endless'; shell.endlessNum = 1; shell.bank = 0; shell.totalTime = 0;
    shell.runSeed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    openShop();
  }

  function openShop() {
    shell.levelDef = makeLevelDef();
    shell.mode = 'shop';
    buildShop();
    hideAllScreens(); show(hud.shop);
  }

  function startLevel() {
    shell.levelStartBank = shell.bank;
    shell.pendingClear = null;
    var seed = (Date.now() ^ (shell.levelIndex * 7919) ^ (shell.endlessNum * 104729)) >>> 0;
    shell.game = GL.createGame(shell.levelDef, seed, currentLoadout());
    shell.game.strawberries = shell.bank;
    GR.setupCanvas(canvas, shell.game);
    shell.mode = 'playing';
    shell.lastZone = zoneLabel();
    hideAllScreens();
    updateHud();
  }

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
    overlay('Out of hearts!',
      (DEATH_LINES[cause] || 'The crowd claims another victim.') +
      '  You retry ' + shell.levelDef.name + ' with what you brought in.',
      [{ label: 'Retry level', onClick: function () { shell.bank = shell.levelStartBank; startLevel(); } },
       { label: 'Handbook', ghost: true, onClick: function () { openHandbook('overlay'); } },
       { label: 'Quit to menu', ghost: true, onClick: toMenu }]);
  }

  function onLevelWon(e) {
    shell.pendingClear = { time: e.time, bank: shell.game.strawberries };
    var isFinalRanked = shell.runMode === 'ranked' && shell.levelIndex >= RANKED_COUNT - 1;
    if (isFinalRanked) { commitClear(); onCampaignComplete(); return; }

    var nextName = shell.runMode === 'endless'
      ? 'Endless ' + (shell.endlessNum + 1)
      : '“' + GL.LEVELS[shell.levelIndex + 1].name + '” — ' + GL.LEVELS[shell.levelIndex + 1].intro;
    overlay(shell.levelDef.name + ' — cleared!',
      'Time ' + fmtTime(e.time) + ', ' + shell.game.strawberries + ' 🍓 in hand. Next: ' + nextName,
      [{ label: 'Continue', onClick: function () { commitClear(); advance(); openShop(); } },
       { label: 'Replay level', ghost: true, onClick: function () { shell.bank = shell.levelStartBank; startLevel(); } },
       { label: 'Quit to menu', ghost: true, onClick: toMenu }]);
  }

  function commitClear() {
    if (!shell.pendingClear) return;
    shell.totalTime += shell.pendingClear.time;
    shell.bank = shell.pendingClear.bank;
    shell.pendingClear = null;
  }
  function advance() {
    if (shell.runMode === 'endless') shell.endlessNum++;
    else shell.levelIndex++;
  }

  function onCampaignComplete() {
    var score = Math.round(shell.bank * 10 - shell.totalTime);
    if (profile.bestTime === null || shell.totalTime < profile.bestTime) { profile.bestTime = shell.totalTime; saveProfile(); }
    var inp = document.createElement('input');
    inp.className = 'name-input'; inp.maxLength = 16; inp.value = profile.lastName || 'Player';
    inp.setAttribute('aria-label', 'Your name for the leaderboard');
    overlay('🏆 Champion!',
      'All ' + RANKED_COUNT + ' grounds crossed in ' + fmtTime(shell.totalTime) + ' with ' +
      shell.bank + ' 🍓 banked.  Score: ' + score + '.  Log it on the leaderboard:',
      [{ label: 'Save score', onClick: function () { recordScore(inp.value, score); showLeaderboard('You’re on the board!'); } },
       { label: 'Skip', ghost: true, onClick: function () { showLeaderboard(); } }],
      inp);
  }

  function toMenu() { showMenu(); }

  // ---- leaderboard --------------------------------------------------------
  function recordScore(name, score) {
    name = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
    profile.lastName = name;
    profile.leaderboard.push({ name: name, berries: shell.bank, time: shell.totalTime, score: score, date: Date.now() });
    profile.leaderboard.sort(function (a, b) { return b.score - a.score; });
    profile.leaderboard = profile.leaderboard.slice(0, 20);
    saveProfile();
  }

  function showLeaderboard(note) {
    buildLeaderboard(note);
    shell.mode = 'leaderboard';
    hideAllScreens(); show(hud.leaderboard);
  }
  function buildLeaderboard(note) {
    hud.lbSub.textContent = note || 'Ranked runs — score = 🍓 × 10 − seconds. Higher is better.';
    var lb = profile.leaderboard || [];
    if (!lb.length) {
      hud.lbBody.innerHTML = '<div class="lb-empty">No ranked runs yet. Finish all ' + RANKED_COUNT + ' levels to make the board.</div>';
    } else {
      var newest = lb.reduce(function (m, e, i) { return e.date > lb[m].date ? i : m; }, 0);
      var rows = lb.map(function (e, i) {
        var you = (i === newest) ? ' class="you"' : '';
        return '<tr' + you + '><td class="lb-rank">#' + (i + 1) + '</td><td>' + escapeHtml(e.name) +
          '</td><td class="num">' + e.berries + ' 🍓</td><td class="num">' + fmtTime(e.time) +
          '</td><td class="num">' + e.score + '</td></tr>';
      }).join('');
      hud.lbBody.innerHTML = '<table class="lb-table"><thead><tr><th></th><th>Name</th><th>🍓</th><th>Time</th><th>Score</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }
    hud.lbButtons.innerHTML = '';
    [ { label: 'Play ranked again', onClick: startRanked },
      { label: 'Endless mode', onClick: startEndless },
      { label: 'Menu', ghost: true, onClick: showMenu },
      { label: 'Handbook', ghost: true, onClick: function () { openHandbook('leaderboard'); } }
    ].forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'btn' + (b.ghost ? ' ghost' : '');
      btn.textContent = b.label; btn.addEventListener('click', b.onClick);
      hud.lbButtons.appendChild(btn);
    });
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---- shop ---------------------------------------------------------------
  function canAfford(cost) { return shell.bank >= cost; }
  function buildShop() {
    var lvl = shell.levelDef;
    hud.shopTitle.textContent = shell.runMode === 'endless' ? 'The Clubhouse Shop 🍓 (Endless)' : 'The Clubhouse Shop 🍓';
    hud.shopBank.textContent = '🍓 ' + shell.bank + ' in the bank  ·  next: ' + lvl.name +
      (lvl.intro ? '  ·  “' + lvl.intro + '”' : '');
    var body = hud.shopBody; body.innerHTML = '';
    body.appendChild(sectionTitle('Passive skill — equip one'));
    var pg = grid();
    Object.keys(GL.PASSIVES).forEach(function (key) { if (key !== 'none') pg.appendChild(passiveCard(key)); });
    pg.appendChild(passiveCard('none'));
    body.appendChild(pg);
    body.appendChild(sectionTitle('Active items — equip up to two'));
    var ig = grid();
    Object.keys(GL.ITEMS).forEach(function (key) { ig.appendChild(itemCard(key)); });
    body.appendChild(ig);
  }
  function sectionTitle(t) { var d = document.createElement('div'); d.className = 'shop-section-title'; d.textContent = t; return d; }
  function grid() { var d = document.createElement('div'); d.className = 'card-grid'; return d; }

  function passiveCard(key) {
    var def = GL.PASSIVES[key];
    var owned = key === 'none' || profile.passivesOwned[key];
    var equipped = profile.loadout.passive === key;
    var card = document.createElement('div');
    card.className = 'card' + (equipped ? ' equipped' : '');
    card.innerHTML = '<div class="name">' + def.name + '</div><div class="desc">' + def.desc + '</div>';
    var row = document.createElement('div'); row.className = 'row';
    if (!owned) {
      row.appendChild(costTag(def.cost));
      row.appendChild(miniBtn('Buy', 'buy', !canAfford(def.cost), function () {
        shell.bank -= def.cost; profile.passivesOwned[key] = true;
        if (profile.loadout.passive === 'none') profile.loadout.passive = key; // auto-equip if the slot is free
        saveProfile(); buildShop();
      }));
    } else {
      row.appendChild(miniBtn(equipped ? 'Equipped' : 'Equip', equipped ? 'on' : 'equip', false, function () { profile.loadout.passive = key; saveProfile(); buildShop(); }));
    }
    card.appendChild(row); return card;
  }

  function itemCard(key) {
    var def = GL.ITEMS[key];
    var owned = profile.owned[key], upgraded = profile.upgraded[key];
    var equipped = profile.loadout.items.indexOf(key) !== -1;
    var slotsFull = profile.loadout.items.length >= 2 && !equipped;
    var card = document.createElement('div');
    card.className = 'card' + (equipped ? ' equipped' : '');
    var counters = { ball: 'tennis balls', kid: 'children', sprinkler: 'sprinklers', flash: 'photo flashes', security: 'security guards', wheelchair: 'wheelchairs' }[def.counters] || def.counters;
    card.innerHTML = '<div class="name">' + def.name + (upgraded ? ' <span class="tag">' + def.upgradeName + '</span>' : '') + '</div>' +
      '<div class="desc">' + def.desc + ' <em style="opacity:.7">(vs ' + counters + ')</em>' +
      (upgraded ? '<br><span style="color:var(--accent)">' + def.upgradeDesc + '</span>' : '') + '</div>';
    var row = document.createElement('div'); row.className = 'row';
    if (!owned) {
      row.appendChild(costTag(def.cost));
      row.appendChild(miniBtn('Buy', 'buy', !canAfford(def.cost), function () {
        shell.bank -= def.cost; profile.owned[key] = true;
        if (profile.loadout.items.indexOf(key) === -1 && profile.loadout.items.length < 2) profile.loadout.items.push(key); // auto-equip into a free slot
        saveProfile(); buildShop();
      }));
    } else {
      row.appendChild(miniBtn(equipped ? 'Equipped' : 'Equip', equipped ? 'on' : 'equip', slotsFull, function () {
        var items = profile.loadout.items, i = items.indexOf(key);
        if (i !== -1) items.splice(i, 1); else if (items.length < 2) items.push(key);
        saveProfile(); buildShop();
      }));
      if (!upgraded) {
        row.appendChild(miniBtn('Upgrade ' + def.upgradeCost + '🍓', 'up', !canAfford(def.upgradeCost), function () { shell.bank -= def.upgradeCost; profile.upgraded[key] = true; saveProfile(); buildShop(); }));
      } else { var ug = document.createElement('span'); ug.className = 'owned-tag'; ug.textContent = 'upgraded'; row.appendChild(ug); }
    }
    card.appendChild(row); return card;
  }
  function costTag(c) { var s = document.createElement('span'); s.className = 'cost'; s.textContent = c + '🍓'; return s; }
  function miniBtn(label, cls, disabled, onClick) {
    var b = document.createElement('button'); b.className = 'mini ' + cls; b.textContent = label;
    if (disabled) b.disabled = true; else b.addEventListener('click', onClick);
    return b;
  }

  // ---- handbook -----------------------------------------------------------
  function openHandbook(returnTo) { shell.handbookReturn = returnTo; buildHandbook(); hideAllScreens(); show(hud.handbook); }
  function closeHandbook() {
    var r = shell.handbookReturn; hide(hud.handbook);
    if (r === 'shop') show(hud.shop);
    else if (r === 'leaderboard') show(hud.leaderboard);
    else show(hud.overlay);
  }
  function hbRow(k, v) { return '<div class="hb-row"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  function buildHandbook() {
    var C = GL.C, h = '';
    h += '<div class="hb-section"><h3>Controls</h3>' +
      hbRow('Move', 'Arrow keys / WASD — hold combinations for smooth 8-direction movement. On touch, press &amp; drag anywhere.') +
      hbRow('Dash', 'Double-tap a direction (or press Shift). A burst of speed that spends ' + C.DASH_COST + ' 🍓.') +
      hbRow('Goal', 'Reach the food truck at the top of each ground.') + '</div>';
    h += '<div class="hb-section"><h3>Modes</h3>' +
      hbRow('Ranked', 'The 10 fixed campaign levels (same for everyone). Finish all 10 to log your score on the leaderboard.') +
      hbRow('Endless', 'Freshly generated levels forever, untracked — for practice and fun.') +
      hbRow('Score', 'On the leaderboard: 🍓 remaining × 10 − seconds. Bank berries and go fast.') + '</div>';
    h += '<div class="hb-section"><h3>Strawberries &amp; hearts</h3>' +
      hbRow('Strawberries 🍓', 'Currency AND fuel. Collect them, spend on dashes and gear. They carry between levels.') +
      hbRow('Golden strawberry', 'One per level, worth ' + C.GOLD_VALUE + ' 🍓 — usually somewhere risky.') +
      hbRow('Hearts', C.HEARTS + ' per level. A hit costs a heart + ' + C.HIT_BERRY_LOSS + ' 🍓 and sends you to your last checkpoint. Zero = retry.') +
      hbRow('Sloth', 'Stand still ' + C.SLOTH_GRACE + 's and you drop a 🍓 every ' + C.SLOTH_INTERVAL + 's.') +
      hbRow('Warm days', 'Hotter levels (heat haze) slow you. Linen Whites or a cooler level help.') + '</div>';
    h += '<div class="hb-section"><h3>The crowd &amp; hazards</h3>' +
      hbRow('Picnickers', 'Wander in groups and change direction. Don’t touch them.') +
      hbRow('Children', 'Tiny, fast, chaotic. A Lollipop survives a collision.') +
      hbRow('Wheelchair users', 'Fast straight lines. Caltrops slow the ones near you.') +
      hbRow('Picnic rugs', 'Walkable, but they slow you. Sure-Footed ignores them.') +
      hbRow('Photographers', 'Flash across a 2-tile gap: −' + C.PHOTOBOMB_LOSS + ' 🍓. Sunglasses ignore it.') +
      hbRow('Sprinklers', 'A blue ring warns, then a 3×3 spray soaks you: −' + C.SPRINKLER_LOSS + ' 🍓 and a stun. Umbrella keeps you dry.') +
      hbRow('Security guards', 'Chase anyone without Accreditation. With a pass, they ignore you.') +
      hbRow('Autograph fans', 'Chase when you’re close. Upgraded Accreditation loses them too.') +
      hbRow('Tennis balls', 'Fly around courts and cost a heart on contact. A Racket bats them away.') + '</div>';
    h += '<div class="hb-section"><h3>Shop — passives (equip one)</h3>';
    Object.keys(GL.PASSIVES).forEach(function (k) { if (k !== 'none') h += hbRow(GL.PASSIVES[k].name + ' <span class="cost">' + GL.PASSIVES[k].cost + '🍓</span>', GL.PASSIVES[k].desc); });
    h += '</div><div class="hb-section"><h3>Shop — items (equip two)</h3>';
    Object.keys(GL.ITEMS).forEach(function (k) { var d = GL.ITEMS[k]; h += hbRow(d.name + ' <span class="cost">' + d.cost + '🍓</span>', d.desc + ' <em style="opacity:.7">Upgrade (' + d.upgradeCost + '🍓): ' + d.upgradeDesc + '</em>'); });
    h += '</div>';
    hud.handbookBody.innerHTML = h;
  }

  // ---- HUD ----------------------------------------------------------------
  function pulse(e2) { e2.classList.remove('pulse'); void e2.offsetWidth; e2.classList.add('pulse'); }
  function toast(msg) { hud.toast.textContent = msg; hud.toast.classList.add('show'); clearTimeout(shell.toastTimer); shell.toastTimer = setTimeout(function () { hud.toast.classList.remove('show'); }, 1700); }
  function zoneLabel() {
    var g = shell.game; if (!g) return '';
    var zone = GL.zoneForRow(g.level, g.player.row);
    var name = g.player.row === 0 ? 'the food truck' : (zone ? zone.name : shell.lastZone);
    return levelLabel() + ' · ' + name;
  }
  var ITEM_ICON = { racket: '🎾', lollipop: '🍭', umbrella: '☂️', sunglasses: '🕶️', accred: '🪪', caltrops: '✸' };
  function itemChipLabel(g, key) {
    var d = GL.ITEMS[key], icon = ITEM_ICON[key] || '?';
    if (d.mode === 'aura') return icon + ' ' + ({ sunglasses: 'shades', accred: 'pass', caltrops: 'caltrops' }[key] || key);
    var ch = g.itemCharges[key];
    return ch === Infinity ? icon + ' ∞' : icon + ' ×' + (ch || 0);
  }
  function updateItemChip(chip, g, key) {
    chip.classList.remove('empty', 'spent');
    if (!key) { chip.textContent = '—'; chip.classList.add('empty'); return; }
    chip.textContent = itemChipLabel(g, key);
    if (GL.ITEMS[key].mode === 'charge' && g.itemCharges[key] === 0) chip.classList.add('spent');
  }
  function updateHud() {
    var g = shell.game; if (!g) return;
    var hearts = '', i;
    for (i = 0; i < g.hearts; i++) hearts += '❤️';
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
    hud.passive.textContent = g.loadout.passive === 'none' ? 'no passive' : '★ ' + GL.PASSIVES[g.loadout.passive].name;
    var label = zoneLabel(); if (label) shell.lastZone = label;
    hud.zone.textContent = shell.lastZone;
    hud.progress.style.width = Math.round(100 * (1 - g.player.row / g.level.startRow)) + '%';
    var slothy = shell.mode === 'playing' && !g.player.moving && g.slothTimer >= GL.C.SLOTH_GRACE && g.strawberries > 0;
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
      else if (e.type === 'itemUsed' && !e.reusable && e.left === 0) toast((GL.ITEMS[e.key] ? GL.ITEMS[e.key].name : e.key) + ' used up.');
      else if (e.type === 'hit') { pulse(hud.hearts); if (e.hearts > 0) toast('Ouch! Back to the checkpoint.'); }
      else if (e.type === 'checkpoint') toast('Checkpoint — ' + e.zone);
      else if (e.type === 'securitySpotted') toast('Security has spotted you — no pass!');
      else if (e.type === 'fanSpotted') toast('A fan has spotted you — run!');
      else if (e.type === 'dead') onGameOver(e.cause);
      else if (e.type === 'won') onLevelWon(e);
    }
    evts.length = 0;
  }

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

  function onDash(dx, dy) { if (shell.mode === 'playing') GL.tryDash(shell.game, dx, dy); }
  function onAction() {
    if (shell.mode === 'menu') startRanked();
    else if (shell.mode === 'shop') startLevel();
  }

  // ---- menu ---------------------------------------------------------------
  function showMenu() {
    shell.runMode = 'ranked'; shell.levelIndex = 0;
    shell.game = GL.createGame(GL.LEVELS[0], 20260710, currentLoadout());
    GR.setupCanvas(canvas, shell.game);
    var best = profile.bestTime !== null ? ' · best ' + fmtTime(profile.bestTime) : '';
    overlay('Strawberry Rush 🍓',
      'Cross ' + RANKED_COUNT + ' grounds to the food truck. Move freely; double-tap (or Shift) to dash. ' +
      'Strawberries are your currency — spend them on gear in the shop between levels. Finish all ' +
      RANKED_COUNT + ' to make the leaderboard, then play ranked again or go Endless.' + best,
      [{ label: 'Play ranked', onClick: startRanked },
       { label: 'Endless mode', onClick: startEndless },
       { label: 'Leaderboard', ghost: true, onClick: function () { showLeaderboard(); } },
       { label: 'Handbook', ghost: true, onClick: function () { openHandbook('overlay'); } }]);
    shell.mode = 'menu';
    updateHud();
  }

  // ---- boot ---------------------------------------------------------------
  input = GameInput.createInput(onDash, onAction);
  window.addEventListener('resize', function () { if (shell.game) GR.resize(canvas, shell.game); });
  el('shop-continue').addEventListener('click', startLevel);
  el('shop-handbook').addEventListener('click', function () { openHandbook('shop'); });
  el('shop-quit').addEventListener('click', showMenu);
  el('handbook-close').addEventListener('click', closeHandbook);

  showMenu();
  requestAnimationFrame(frame);
})();
