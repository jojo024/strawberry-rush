# Strawberry Rush 🍓

A zero-dependency browser arcade game: a free-movement dash across **eight
grounds**, from a cool dawn garden to a floodlit night gala, buying gear
between levels to survive an ever-growing cast of hazards. You are a
broadcast engineer — dressed head-to-toe in black, headset glowing —
weaving through a posh garden party to reach the food truck.

## Run it

No build step, no dependencies. Either:

- **Double-click `index.html`** — works straight from the filesystem, or
- serve the folder and open it: `python -m http.server 8081`
  → <http://localhost:8081> (8080 tends to be taken).

Fills the whole window and adapts to resizes. Works in current Chrome,
Firefox, Safari and Edge. Total payload is a few tens of KB.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | **Move freely in any direction** — hold combinations for diagonals; you slide along walls |
| **Double-tap a direction** (or **Shift**) | **Dash**: a burst of speed that spends **3 🍓** |
| Space / Enter | Advance menus / start the level from the shop |
| Touch | Press & drag = joystick · tap = advance · two-finger tap = dash |

An in-game **Handbook** (button on the menu and shop) explains every
control, hazard, item, and passive.

## Strawberries are currency

Strawberries are both your fuel and your money. Collect them on the ground;
they **carry between levels** as your bank. A dash spends 3. Each level
hides a **golden strawberry worth 5**, usually somewhere risky. Between
levels the **shop** spends them on gear.

## The shop & loadout

Between every level you visit the clubhouse shop. Purchases are **owned
forever** and persist across playthroughs (localStorage). You equip **one
passive skill + two active items** at a time, swapping freely.

- **Passives** (always-on): Fresh Legs (speed), Linen Whites (beats the
  heat), Iron Constitution (a 4th heart), Sure-Footed (ignore picnic
  rugs), Thrifty Dasher (dashes refund 1 🍓).
- **Items** (one-time-use shields that recharge each level; buy the
  **upgrade** to make them reusable):
  - **Tennis Racket** — bat away a tennis ball
  - **Lollipop** — survive a charging child
  - **Umbrella** — shrug off a sprinkler soaking
  - **Sunglasses** *(aura)* — photo flashes never cost you 🍓
  - **Accreditation** *(aura)* — security guards ignore you (upgrade: fans too)
  - **Caltrops** *(aura)* — nearby wheelchair users slow down (upgrade: kids too)

## The campaign — eight grounds, one new thing at a time

The camera is zoomed out over wide 21-column grounds. Each level carries a
**time-of-day theme** (the scenery shifts dawn → night) and a **warmth**:
hotter levels (look for the heat-haze) physically slow you unless you're
dressed for it. Difficulty and mechanics ramp deliberately:

1. **The Garden Gate** (dawn) — just the crowd: genteel wanderers.
2. **The Picnic Lawn** (morning) — + picnic rugs and a first sprinkler.
3. **The Children’s Field** (midday) — + chaotic sprinting children.
4. **The Photographers’ Concourse** (noon, *hot & slow*) — + flashes & stewards.
5. **The Members’ Enclosure** (afternoon) — + autograph fans and **security guards**.
6. **The Practice Courts** (golden hour) — + flying **tennis balls**.
7. **Centre Court** (dusk) — everything at once, denser.
8. **The Champions’ Gala** (floodlit night) — the finale, at full tilt.

Hearts refill each level (3, or 4 with Iron Constitution). A hit costs a
heart + 2 🍓 and sends you to your last **zone checkpoint** with brief
invulnerability. Zero hearts retries the level with the bank & loadout you
entered it with. Best total campaign time persists.

The crowd moves in **groups** (walking parties that stick together; seated
picnic circles hold their rugs). Kids sprint chaotically; wheelchairs run
fast straight lines; stewards patrol learnable loops; fans and security
give chase.

## Architecture

```
index.html      fullscreen shell: glassy HUD, progress bar, toasts,
                overlay/shop/handbook screens (styling only; no inline JS)
src/logic.js    PURE simulation — no DOM/canvas. Free-movement physics,
                tile terrain (zones/hedges/walls/hazards), 2D NPC brains
                (wander/patrol/chase/group-cohesion/seated/security),
                tennis balls, the economy + loadout effect system, and all
                8 level definitions. UMD: browser global + Node require().
src/render.js   Canvas 2D pseudo-3D renderer. 100% procedural, per-level
                day→night THEMES (sky/ground/lighting), heat haze, security
                guards, tennis courts & balls, y-sorted props/people/balls,
                additive night lighting, particles, camera shake.
src/input.js    Keyboard + touch → an analog movement vector; double-tap or
                Shift for dash. Knows nothing about game rules.
src/main.js     Fixed-timestep loop, campaign flow, the shop & handbook
                (CSP-safe DOM), loadout persistence, HUD, best-time save.
test/logic.test.js  Unit tests via Node's built-in runner.
```

Design decisions and why:

- **Free movement over tile hops** — a circular collider moved per-axis
  against the tile grid gives natural wall-sliding in ~20 lines; NPCs,
  hazards and authoring stay tile-based, only the player is continuous.
- **Everything is data** — levels, passives, and items are declarative
  objects shared by the sim, the shop UI, and the Handbook, so the three
  never drift out of sync. A BFS test proves start→goal connectivity and a
  patrol-clearance test guards NPC routes for **every** level.
- **Pure logic module** — no browser APIs, seedable RNG (mulberry32): the
  AI, economy, and loadout effects are all unit-testable and every bug is
  reproducible from a seed.
- **Themes are renderer-only** — the sim exposes `theme`/`warmth`; the
  renderer maps them to palettes and gates night-only light so daytime
  levels read bright and the night finale keeps its glow.
- **Security posture** — zero external requests, no CDNs, no `eval`, no
  inline event handlers; all dynamic UI built via DOM APIs and text set via
  `textContent`. A suggested CSP header is documented in `index.html`.

## Tests & balance

```
npm test        # = node --test test/logic.test.js  (Node 18+, no deps)
```

39 tests cover: free-movement physics, warmth/heat and every passive,
currency dash, all six items (charge shields, reusable upgrades, and auras)
against their hazards, security chase/accreditation, tennis balls & the
racket, hearts/checkpoints, and — for **all 8 levels** — connectivity,
band containment, patrol validity, construction sanity, and the
gradual-introduction of mechanics.

Balance is tuned against a headless goal-seeking bot (25 seeded runs per
level, each given a level-appropriate loadout): a careful player clears
every level, difficulty rises L1 → L8, and mindless play wins no real
level (random play: 0/25 from level 4 on).

## Known limitations / future ideas

- No audio yet (a small WebAudio synth would fit the zero-asset approach).
- More item upgrade tiers (currently one “reusable/wider” tier each).
- A level-select for owned progress; per-level best times.
- Photographers always face each other horizontally.
