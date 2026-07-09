# Strawberry Rush 🍓

A lightweight, zero-dependency browser arcade game in the Crossy Road /
Frogger tradition. You are a broadcast engineer — dressed head-to-toe in
black — trying to cross a posh, sun-drenched Wimbledon crowd to reach the
food trucks before lunch is over.

## Run it

No build step, no dependencies. Either:

- **Double-click `index.html`** — works straight from the filesystem, or
- serve the folder and open it: `python -m http.server 8081`
  → <http://localhost:8081> (8080 tends to be taken).

Works in current Chrome, Firefox, Safari and Edge. Total payload is a few
tens of KB — well under the 500 KB budget.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | Hop one tile (one deliberate tap per hop; key auto-repeat is ignored) |
| **Double-tap** a direction | **Dash** 3 tiles — requires 3+ strawberries and consumes your **entire** stack |
| Space / Enter | Start, continue, retry |
| Touch: swipe / double-swipe / tap | Hop / dash / hop forward |

## Rules

- **Win** a stage by reaching the food truck at the top. There are **5
  hand-tuned stages**; strawberries carry over between them.
- **Lose** by touching anyone in the crowd. Retry the stage with the
  strawberries you brought into it.
- **Strawberries** are scattered on the ground. Three or more arms your dash
  — but dashing spends the whole stack, so hoarding is a choice.
- **Sloth penalty:** stand still for 4 seconds and you start dropping a
  strawberry every 2 seconds. Keep moving.
- **Photobombs:** photographers stand in facing pairs. Their phone blinks
  amber while the flash charges (~0.8 s) — cross the gap between them while
  the flash actually fires and you lose 2 strawberries.

The crowd is not scenery: posh picnickers are slow but take up entitled
amounts of space, wheelchair users hold a steady line, and children are
tiny, fast, and completely unpredictable.

## Architecture

```
index.html      shell page: HUD, overlay, styling (no inline JS)
src/logic.js    PURE simulation — no DOM/canvas. Grid, movement, dash,
                sloth timer, NPC behaviour brains, flash cycle, collisions,
                stage definitions. UMD: browser global + Node require().
src/render.js   Canvas 2D renderer. 100% procedural drawing (no assets):
                striped lawns, flowers, food truck, crowd, flash effects.
src/input.js    Keyboard + touch → movement intents with double-tap dash
                detection. Knows nothing about game rules.
src/main.js     Game loop + stage flow + HUD updates.
test/logic.test.js  23 unit tests via Node's built-in runner.
```

Design decisions and why:

- **Canvas 2D over WebGL/DOM** — dozens of animated sprites at 60 fps is
  comfortably within Canvas 2D territory, with none of WebGL's complexity
  and no DOM-node churn.
- **Fixed timestep (60 Hz) with render interpolation** — the simulation
  advances in constant 1/60 s slices regardless of display refresh, so
  collision detection and the sloth/flash timers are deterministic. The
  renderer interpolates between the previous and current tick (`alpha`),
  staying smooth on 120 Hz+ screens. Frame time is clamped at 0.25 s so a
  backgrounded tab doesn't cause a catch-up spiral.
- **Pure logic module** — `logic.js` touches no browser API and takes a
  seedable RNG (mulberry32), which is what makes the mechanics unit-testable
  and every bug reproducible from a seed.
- **Object pooling** — lane NPCs are allocated once at stage start and wrap
  around the lane edges forever; nothing is created or destroyed during
  play, so there's no GC stutter.
- **Security posture** — zero external requests, no CDNs, no `eval`, no
  inline event handlers, all dynamic text set via `textContent`. A suggested
  CSP header is documented in `index.html` (not embedded as a meta tag so
  the game still runs from `file://`).
- **Top-down camera with painter's-order depth** — entities lower on screen
  draw over those above, giving a hint of depth without the cost of true
  isometric math.

## Tests

```
npm test        # = node --test test/logic.test.js  (Node 18+, no deps)
```

23 tests cover: tile movement and grid clamping, dash arming/consumption/
wall behaviour, strawberry pickup, the sloth grace period and drain rate,
the photographer flash cycle and photobomb losses, collision hitboxes,
win detection, NPC wrap-around pooling, seeded determinism, and validity
of all five shipped stage layouts.

### Manual playtest checklist

1. Title screen appears; Space starts stage 1.
2. Each arrow/WASD tap hops exactly one tile; holding a key does not repeat.
3. Collect 3 strawberries → HUD shows “DASH READY”; double-tap dashes 3
   tiles and the counter drops to 0.
4. Stand still ~4 s → “losing strawberries — move!” appears and the count
   drains every 2 s, stopping at 0.
5. Photographer phones blink amber, then flash; crossing the gap mid-flash
   costs 2 strawberries; crossing during the blink is safe.
6. Walking into a photographer is simply blocked (not fatal).
7. Touching any pedestrian ends the run with a themed message; Space
   retries the same stage.
8. Reaching the food truck advances the stage; after stage 5 the victory
   screen shows total strawberries collected.
9. On mobile: swipe hops, double-swipe dashes, tap hops forward.

A headless playability check was run during development: a gap-aware bot
cleared all 5 stages across 150 seeded runs while random play always died —
i.e. the game is winnable with skill and lethal without it.

## Known limitations / future ideas

- No audio yet (a small WebAudio synth would fit the zero-asset approach).
- Single life per attempt; no high-score persistence (`localStorage` would
  be an easy add).
- Photographers always face each other horizontally; diagonal pairs could
  add variety.
- No on-screen D-pad — touch is swipe-only.
