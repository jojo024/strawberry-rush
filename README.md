# Strawberry Rush 🍓

A zero-dependency browser arcade game: a free-movement evening dash across
three lantern-lit grounds. You are a broadcast engineer — dressed
head-to-toe in black, headset glowing — weaving through a posh garden
party to reach the food truck before lunch service ends.

## Run it

No build step, no dependencies. Either:

- **Double-click `index.html`** — works straight from the filesystem, or
- serve the folder and open it: `python -m http.server 8081`
  → <http://localhost:8081> (8080 tends to be taken).

The game fills the whole window and adapts to resizes. Works in current
Chrome, Firefox, Safari and Edge. Total payload is a few tens of KB.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | **Move freely in any direction** — hold combinations for diagonals; you slide along walls |
| **Shift** | **Dash**: a burst of speed in your movement direction — needs 3+ strawberries and consumes your **entire** stack |
| Space / Enter | Start, continue, retry |
| Touch | Press & drag = virtual joystick · tap = action · two-finger tap = dash |

## The campaign — three levels

One continuous evening, seen through a smoothed fullscreen camera over
wide 21-column grounds (the wide grid is what pulls the camera back so you
can see the crowd coming). Strawberries carry over between levels; hearts
refill at each level start; the best **total campaign time** persists in
`localStorage`.

1. **The Championship Grounds** (34 rows) — the opener: The Queue, the
   Picnic Terrace's rugs and sprinklers, the Concourse patrols, and the
   Courtside Lawn.
2. **The Orangery Maze** (36 rows) — hedge-maze pockets, fountain
   sprinklers everywhere, four photographer pairs, tighter routes.
3. **Centre Court Gala** (38 rows) — the finale: five photographer pairs,
   barrier chicanes, the fastest and densest crowds.

Each level climbs through four zones split by hedge walls with
two-tile-wide, lantern-lit gates; entering a new zone plants a
**checkpoint**.

**The crowd moves in groups.** Walking parties spawn together, dress
alike, and drift back toward each other when they stray — the gaps
*between* parties are your routes. Seated picnic circles hold their rugs
as fixed obstacles. Kids sprint chaotically, wheelchairs travel fast
straight lines, stewards patrol learnable loops, and autograph-hunting
fans give chase if you stray close.

## Rules

- **Win** a level by reaching the food truck at the top.
- **Hearts:** 3 per level. Touching anyone costs a heart plus 2
  strawberries and sends you back to your last checkpoint with ~2 s of
  invulnerability. Zero hearts = retry the level with the berries you
  brought in.
- **Strawberries** glow like embers in the dark. Three or more arms your
  dash — but dashing spends the whole stack, so hoarding is a choice.
  Each level hides a **golden strawberry** (worth 3) in a risky corner.
- **Sloth penalty:** stand still for 4 s and you drop a strawberry every 2 s.
- **Photobombs:** photographer pairs flash across a 2-tile gap — blinding
  at night. Amber blink = ~0.8 s of escape time; crossing during the
  flash costs 2 strawberries.
- **Sprinklers:** a pulsing blue ring telegraphs the spray (~1.1 s); the
  3×3 splash zone costs 2 strawberries and stuns you 0.8 s — which, in a
  crowd, is the real danger.
- **Picnic rugs** are walkable but nearly halve your speed.

## Architecture

```
index.html      fullscreen shell: glassy HUD chips (hearts/berries/zone/
                timer), progress bar, toasts, overlay (no inline JS)
src/logic.js    PURE simulation — no DOM/canvas. Free-movement player
                physics (circular collider, per-axis wall sliding), tile
                terrain with zones/walls/checkpoints, 2D NPC brains
                (wander/patrol/chase/group cohesion/seated), hazards,
                and all three level definitions. UMD: browser + Node.
src/render.js   Canvas 2D pseudo-3D renderer, dusk theme. 100% procedural:
                fullscreen crisp scaling, scrolling camera, night sky with
                stars/moon/balloon/lit stands, fairy-light strands and
                gate lanterns with additive light pools, ember-glow
                berries, fireflies, ground mist, perspective sprite
                scaling, y-sorted props and rim-lit people, particles.
src/input.js    Keyboard + touch → a live analog movement vector (8-way
                keys or drag-joystick) plus dash/action callbacks.
src/main.js     Fixed-timestep loop (60 Hz, render-interpolated), level
                campaign flow, HUD, resize, best-time persistence.
test/logic.test.js  Unit tests via Node's built-in runner.
```

Design decisions and why:

- **Free movement over tile hops** — the player has a circular collider
  moved per-axis against the tile grid, which gives natural wall-sliding
  with ~20 lines of collision code. NPCs, hazards and level authoring
  stay tile-based; only the player is continuous.
- **Canvas 2D over WebGL** — the night look is built from cheap, reliable
  cues (additive light pools, glows, perspective scaling, y-sorting).
  No toolchain, still a double-click-to-run file, comfortable 60 fps.
- **Fullscreen with fixed logical space** — the world is drawn in a
  `cols × TILE` logical space scaled to the real window at device-pixel
  resolution: art code never sees screen sizes, output stays crisp.
- **Fixed timestep (60 Hz) with render interpolation** — deterministic
  collisions and hazard timers regardless of refresh rate.
- **Pure logic module** — no browser APIs, seedable RNG (mulberry32):
  the free-roaming, group-cohesive AI is unit-testable and every bug is
  reproducible from a seed.
- **Levels as data** — each level is a declarative object (zones, hedges,
  walls, props, hazards, crowd roster). A BFS test proves start→goal
  connectivity for every level, so layout edits can't ship a dead end.
- **Security posture** — zero external requests, no CDNs, no `eval`, no
  inline event handlers, dynamic text via `textContent` only. A suggested
  CSP header is documented in `index.html`.

## Tests & balance

```
npm test        # = node --test test/logic.test.js  (Node 18+, no deps)
```

33 tests cover: free movement (speed, normalized diagonals, edge clamping,
wall sliding), blanket slowdown, proximity berry pickup, dash mechanics
(cost, burst distance, wall stop, refusal below cost), the sloth drain,
photographer and sprinkler cycles, soak-and-stun, hearts/checkpoint
respawn/invulnerability, checkpoint thresholds, and — **for every level** —
NPC zone containment, steward patrol-route validity, construction sanity,
and a BFS proof that the goal is reachable. Plus 2D wandering, group
cohesion, seated immobility, fan aggro/deaggro, and seeded determinism.

Balance is tuned against a headless goal-seeking bot (25 seeded runs per
level): careful play clears every level reliably with difficulty rising
L1 → L3, while random play wins zero runs anywhere.

### Manual playtest checklist

1. Title screen over a live view of the lantern-lit grounds; Space starts.
2. Game fills the window; resizing keeps it crisp.
3. Movement is smooth in all 8 directions; you slide along hedges instead
   of stopping dead; rugs slow you down.
4. Shift with 3+ 🍓 bursts you forward with a teal trail and empties the
   stack; Shift below 3 🍓 does nothing.
5. Crowds cluster in parties; seated circles hold the rugs; a chasing fan
   shows a bouncing “!”.
6. Walk into anyone: heart lost, toast, respawn at checkpoint, ~2 s blink.
7. Clearing a level shows its time; berries carry to the next level and
   hearts refill; after level 3 the total campaign time and best show.
8. Fairy-light strands sag overhead with light pools beneath; lanterns
   flank every gate; fireflies drift; mist rolls; near the top the starry
   sky and lit stands appear.

## Known limitations / future ideas

- No audio yet (a small WebAudio synth would fit the zero-asset approach).
- Difficulty knobs are all in `GameLogic.C` and the `LEVELS` definitions.
- Photographers always face each other horizontally.
- Touch joystick is functional but unrefined (no visual thumbstick).
