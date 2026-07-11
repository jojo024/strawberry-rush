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
    leaderboard: el('leaderboard'), lbSub: el('lb-sub'), lbBody: el('leaderboard-body'), lbButtons: el('leaderboard-buttons'),
    settings: el('settings'), settingsBody: el('settings-body')
  };

  var DEFAULT_SETTINGS = { doubleTapDash: true, dashKey: 'Shift' };

  // ---- persistent profile -------------------------------------------------
  function defaultProfile() {
    return { owned: {}, upgraded: {}, passivesOwned: { none: true },
             loadout: { passive: 'none', items: [] }, bestTime: null,
             leaderboard: [], lastName: 'Player',
             settings: { doubleTapDash: true, dashKey: 'Shift' } };
  }
  var profile = loadProfile();
  // Normalise settings once and keep the SAME object — input reads it live.
  profile.settings = Object.assign({}, DEFAULT_SETTINGS, profile.settings || {});
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
  function hideAllScreens() { hide(hud.overlay); hide(hud.shop); hide(hud.handbook); hide(hud.leaderboard); hide(hud.settings); }

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

  // ---- run persistence (per browser, via localStorage) --------------------
  // The whole run — where you are, your bank, your time — is saved so you can
  // quit to the menu and Resume later without losing progress. Gear (owned /
  // upgraded / loadout) already lives in the profile.
  function saveRun() {
    profile.run = { active: true, runMode: shell.runMode, levelIndex: shell.levelIndex,
      endlessNum: shell.endlessNum, runSeed: shell.runSeed, bank: shell.bank, totalTime: shell.totalTime,
      goldens: shell.goldens || {} };
    saveProfile();
  }
  function clearRun() { profile.run = { active: false }; saveProfile(); }
  function resumeRun() {
    var r = profile.run; if (!r || !r.active) { showMenu(); return; }
    shell.runMode = r.runMode; shell.levelIndex = r.levelIndex || 0; shell.endlessNum = r.endlessNum || 0;
    shell.runSeed = r.runSeed || 0; shell.bank = r.bank || 0; shell.totalTime = r.totalTime || 0;
    shell.goldens = r.goldens || {};
    openShop();
  }

  // ---- campaign flow ------------------------------------------------------
  function startRanked() {
    resetRun();
    shell.runMode = 'ranked'; shell.levelIndex = 0; shell.bank = 0; shell.totalTime = 0;
    shell.goldens = {};        // ranked levels whose golden berry you've claimed
    saveRun();
    openShop();
  }
  function startEndless() {
    resetRun();
    shell.runMode = 'endless'; shell.endlessNum = 1; shell.bank = 0; shell.totalTime = 0;
    shell.runSeed = (Date.now() ^ (Math.random() * 0x7fffffff)) >>> 0;
    shell.goldens = {};
    saveRun();
    openShop();
  }

  function openShop() {
    shell.levelDef = makeLevelDef();
    shell.mode = 'shop';
    saveRun();               // shop = safe checkpoint for the saved run
    buildShop();
    hideAllScreens(); show(hud.shop);
  }

  function startLevel() {
    shell.levelStartBank = shell.bank;
    shell.pendingClear = null;
    shell.goldenThisLevel = false;   // did you grab this level's golden on this attempt?
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
      '  Retry ' + shell.levelDef.name + ' with the bank you brought in — or hit the shop first to buy upgrades.',
      [{ label: 'Retry level', onClick: function () { shell.bank = shell.levelStartBank; startLevel(); } },
       { label: 'Shop & retry', onClick: function () { shell.bank = shell.levelStartBank; openShop(); } },
       { label: 'Handbook', ghost: true, onClick: function () { openHandbook('overlay'); } },
       { label: 'Quit to menu', ghost: true, onClick: toMenu }]);
  }

  function onLevelWon(e) {
    shell.pendingClear = { time: e.time, bank: shell.game.strawberries };
    // Credit this level's golden only if you actually cleared the level with it.
    if (shell.runMode === 'ranked' && shell.goldenThisLevel) shell.goldens[shell.levelIndex] = true;
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

  var PERFECT_BONUS = 250;   // for collecting every golden across all 10 levels

  function onCampaignComplete() {
    clearRun(); // the run is finished — no half-run to resume
    var golds = Object.keys(shell.goldens || {}).length;
    var perfect = golds >= RANKED_COUNT;
    var score = Math.round(shell.bank * 10 - shell.totalTime) + (perfect ? PERFECT_BONUS : 0);
    if (profile.bestTime === null || shell.totalTime < profile.bestTime) { profile.bestTime = shell.totalTime; saveProfile(); }
    var inp = document.createElement('input');
    inp.className = 'name-input'; inp.maxLength = 16; inp.value = profile.lastName || 'Player';
    inp.setAttribute('aria-label', 'Your name for the leaderboard');
    var goldLine = perfect
      ? '⭐ PERFECT RUN — every golden strawberry collected! +' + PERFECT_BONUS + ' bonus.'
      : 'Golden strawberries: ' + golds + '/' + RANKED_COUNT + ' (collect all 10 for a perfect score).';
    overlay(perfect ? '⭐ Perfect Champion!' : '🏆 Champion!',
      'All ' + RANKED_COUNT + ' grounds crossed in ' + fmtTime(shell.totalTime) + ' with ' +
      shell.bank + ' 🍓 banked.  ' + goldLine + '  Score: ' + score + '.  Log it on the leaderboard:',
      [{ label: 'Save score', onClick: function () { recordScore(inp.value, score, perfect, golds); showLeaderboard('You’re on the board!'); } },
       { label: 'Skip', ghost: true, onClick: function () { showLeaderboard(); } }],
      inp);
  }

  function toMenu() { showMenu(); }

  // ---- leaderboard (global via Supabase, with a local fallback cache) ------
  // Configure src/config.js with your Supabase URL + anon key to go global.
  // When unset (or offline) the board falls back to this browser's local cache.
  var LB = (window.LEADERBOARD_CONFIG && window.LEADERBOARD_CONFIG.url) ? window.LEADERBOARD_CONFIG : { url: '', anonKey: '' };
  function lbEnabled() { return !!(LB.url && LB.anonKey && typeof fetch === 'function'); }
  function lbHeaders() { return { apikey: LB.anonKey, Authorization: 'Bearer ' + LB.anonKey }; }
  function localTop() { return (profile.leaderboard || []).slice().sort(function (a, b) { return b.score - a.score; }).slice(0, 50); }

  function recordScore(name, score, perfect, golds) {
    name = (name || 'Player').toString().slice(0, 16).trim() || 'Player';
    perfect = !!perfect; golds = Math.max(0, Math.min(RANKED_COUNT, golds || 0));
    score = Math.max(-100000, Math.min(1000000, Math.round(score)));
    profile.lastName = name;
    var entry = { name: name, berries: shell.bank, time: shell.totalTime, score: score, perfect: perfect, golds: golds, date: Date.now() };
    shell.myEntry = entry;
    // Local cache (also the offline board).
    profile.leaderboard.push(entry);
    profile.leaderboard.sort(function (a, b) { return b.score - a.score; });
    profile.leaderboard = profile.leaderboard.slice(0, 50);
    saveProfile();
    // Best-effort global submit.
    if (lbEnabled()) {
      try {
        fetch(LB.url + '/rest/v1/scores', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, lbHeaders()),
          body: JSON.stringify({ name: name, score: score, berries: shell.bank, time_sec: Math.round(shell.totalTime * 10) / 10, golds: golds, perfect: perfect })
        }).catch(function () {});
      } catch (e) {}
    }
  }

  function lbFetchTop(cb) {
    if (!lbEnabled()) { cb(localTop(), 'local'); return; }
    try {
      fetch(LB.url + '/rest/v1/scores?select=name,score,berries,time_sec,golds,perfect&order=score.desc&limit=50', { headers: lbHeaders() })
        .then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
        .then(function (rows) {
          cb(rows.map(function (r) { return { name: r.name, score: r.score, berries: r.berries, time: r.time_sec, golds: r.golds, perfect: r.perfect }; }), 'global');
        })
        .catch(function () { cb(localTop(), 'offline'); });
    } catch (e) { cb(localTop(), 'offline'); }
  }

  function showLeaderboard(note) {
    shell.mode = 'leaderboard';
    hideAllScreens(); show(hud.leaderboard);
    renderLbButtons();
    hud.lbSub.textContent = lbEnabled() ? 'Loading global scores…' : 'Local scores (set up a backend in src/config.js to go global).';
    hud.lbBody.innerHTML = '<div class="lb-empty">Loading…</div>';
    lbFetchTop(function (list, src) { renderLbRows(list, src, note); });
  }

  function renderLbRows(list, src, note) {
    var srcLabel = src === 'global' ? '🌍 Global' : (src === 'offline' ? '📴 Offline — local scores' : '💾 Local scores');
    hud.lbSub.textContent = (note ? note + '  ·  ' : '') + srcLabel +
      '  ·  score = 🍓×10 − seconds, +' + PERFECT_BONUS + ' for a ⭐ perfect run.';
    if (!list.length) {
      hud.lbBody.innerHTML = '<div class="lb-empty">No ranked runs yet. Finish all ' + RANKED_COUNT + ' levels to make the board.</div>';
      return;
    }
    var mine = shell.myEntry;
    var rows = list.map(function (e, i) {
      var isMine = mine && e.name === mine.name && e.score === mine.score && Math.abs((e.time || 0) - mine.time) < 0.05;
      var star = e.perfect ? ' ⭐' : '';
      var golds = (e.golds != null ? e.golds : (e.perfect ? RANKED_COUNT : 0));
      return '<tr' + (isMine ? ' class="you"' : '') + '><td class="lb-rank">#' + (i + 1) + '</td><td>' + escapeHtml(e.name) +
        '</td><td class="num">' + golds + '/' + RANKED_COUNT + ' 🌟</td><td class="num">' + e.berries + ' 🍓</td><td class="num">' + fmtTime(e.time || 0) +
        '</td><td class="num">' + e.score + star + '</td></tr>';
    }).join('');
    hud.lbBody.innerHTML = '<table class="lb-table"><thead><tr><th></th><th>Name</th><th>Gold</th><th>🍓</th><th>Time</th><th>Score</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderLbButtons() {
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
  // ---- settings -----------------------------------------------------------
  function openSettings() { buildSettings(); hideAllScreens(); show(hud.settings); }
  function closeSettings() { if (input.cancelCapture) input.cancelCapture(); showMenu(); }

  function buildSettings() {
    var st = profile.settings, body = hud.settingsBody;
    body.innerHTML = '';

    // Double-tap toggle
    var r1 = document.createElement('div'); r1.className = 'set-row';
    var l1 = document.createElement('div');
    l1.innerHTML = '<div class="set-label">Double-tap to dash</div>' +
      '<div class="set-desc">Quickly tapping a direction twice performs a dash. Turn off if you dash by accident.</div>';
    var tog = document.createElement('div'); tog.className = 'toggle' + (st.doubleTapDash ? ' on' : '');
    tog.innerHTML = '<div class="knob"></div>';
    tog.addEventListener('click', function () { st.doubleTapDash = !st.doubleTapDash; saveProfile(); buildSettings(); });
    r1.appendChild(l1); r1.appendChild(tog); body.appendChild(r1);

    // Dash key rebind
    var r2 = document.createElement('div'); r2.className = 'set-row';
    var l2 = document.createElement('div');
    l2.innerHTML = '<div class="set-label">Dash key</div>' +
      '<div class="set-desc">Hold a direction and press this key to dash. Movement keys, Space and Enter can’t be used.</div>';
    var kb = document.createElement('button'); kb.className = 'keybtn';
    kb.textContent = GameInput.keyLabel(st.dashKey);
    kb.addEventListener('click', function () {
      kb.classList.add('listening'); kb.textContent = 'Press a key… (Esc cancels)';
      input.captureNextKey(function (code) {
        kb.classList.remove('listening');
        if (code) { st.dashKey = code; saveProfile(); }
        buildSettings();
      });
    });
    r2.appendChild(l2); r2.appendChild(kb); body.appendChild(r2);
  }

  function hbRow(k, v) { return '<div class="hb-row"><div class="k">' + k + '</div><div class="v">' + v + '</div></div>'; }
  function buildHandbook() {
    var C = GL.C, h = '';
    h += '<div class="hb-section"><h3>Controls</h3>' +
      hbRow('Move', 'Arrow keys / WASD — hold combinations for smooth 8-direction movement. On touch, press &amp; drag anywhere.') +
      hbRow('Dash', 'Double-tap a direction (or press Shift). A burst of speed that spends ' + C.DASH_COST + ' 🍓.') +
      hbRow('Goal', 'Reach the food truck at the top of each ground.') + '</div>';
    h += '<div class="hb-section"><h3>Modes</h3>' +
      hbRow('Ranked', 'The 10 fixed campaign levels (same for everyone). Finish all 10 to log your score on the leaderboard. Your run is saved — quit and Resume anytime.') +
      hbRow('Endless', 'Freshly generated levels forever, untracked — for practice and fun.') +
      hbRow('Score', 'On the leaderboard: 🍓 remaining × 10 − seconds. Bank berries and go fast.') +
      hbRow('⭐ Perfect run', 'Collect the golden strawberry on all 10 ranked levels for a ⭐ PERFECT score (+' + PERFECT_BONUS + ' bonus). You must grab it on the run where you clear each level.') + '</div>';
    h += '<div class="hb-section"><h3>Strawberries &amp; hearts</h3>' +
      hbRow('Strawberries 🍓', 'Currency AND fuel. Collect them, spend on dashes and gear. They carry between levels.') +
      hbRow('Golden strawberry', 'One per level, worth ' + C.GOLD_VALUE + ' 🍓, hidden somewhere random in the final section near the food truck. Grab them all for a perfect run.') +
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
      else if (e.type === 'goldBerry') { pulse(hud.berries); shell.goldenThisLevel = true; toast('Golden strawberry! +' + GL.C.GOLD_VALUE + ' 🍓'); }
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
    shell.game = GL.createGame(GL.LEVELS[0], 20260710, currentLoadout());
    GR.setupCanvas(canvas, shell.game);
    var best = profile.bestTime !== null ? ' · best ' + fmtTime(profile.bestTime) : '';
    var r = profile.run;
    var buttons = [];
    if (r && r.active) {
      var where = r.runMode === 'endless' ? 'Endless ' + r.endlessNum : 'Level ' + (r.levelIndex + 1) + '/' + RANKED_COUNT;
      buttons.push({ label: 'Resume (' + where + ')', onClick: resumeRun });
    }
    buttons.push({ label: r && r.active ? 'New ranked run' : 'Play ranked', onClick: startRanked });
    buttons.push({ label: 'Endless mode', onClick: startEndless });
    buttons.push({ label: 'Leaderboard', ghost: true, onClick: function () { showLeaderboard(); } });
    buttons.push({ label: 'Settings', ghost: true, onClick: openSettings });
    buttons.push({ label: 'Handbook', ghost: true, onClick: function () { openHandbook('overlay'); } });
    overlay('Strawberry Rush 🍓',
      'Cross ' + RANKED_COUNT + ' grounds to the food truck. Move freely; double-tap (or your dash key) to dash. ' +
      'Strawberries are your currency — spend them on gear in the shop between levels (and after a death). ' +
      'Your run is saved, so you can quit and resume. Finish all ' + RANKED_COUNT + ' to make the leaderboard.' + best,
      buttons);
    shell.mode = 'menu';
    updateHud();
  }

  // ---- boot ---------------------------------------------------------------
  input = GameInput.createInput(onDash, onAction, profile.settings);
  window.addEventListener('resize', function () { if (shell.game) GR.resize(canvas, shell.game); });
  el('shop-continue').addEventListener('click', startLevel);
  el('shop-handbook').addEventListener('click', function () { openHandbook('shop'); });
  el('shop-quit').addEventListener('click', toMenu);
  el('handbook-close').addEventListener('click', closeHandbook);
  el('settings-close').addEventListener('click', closeSettings);
  el('settings-reset').addEventListener('click', function () {
    profile.settings.doubleTapDash = DEFAULT_SETTINGS.doubleTapDash;
    profile.settings.dashKey = DEFAULT_SETTINGS.dashKey;
    saveProfile(); buildSettings();
  });

  showMenu();
  requestAnimationFrame(frame);
})();
