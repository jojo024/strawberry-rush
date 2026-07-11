# Strawberry Rush 🍓

A zero-dependency browser arcade game: a free-movement dash across **ten
long, procedurally-built grounds**, from a cool dawn garden to a floodlit
night gala, buying gear between levels to survive an ever-growing cast of
hazards. Finish all ten to log your score on a local **leaderboard**, then
run it again or play **endless** generated levels forever. You are a
broadcast engineer — dressed head-to-toe in black, headset glowing —
weaving through a posh garden party to reach the food truck.

## Run it

No build step, no dependencies. Either:

- **Double-click `index.html`** — works straight from the filesystem, or
- serve the folder and open it: `python -m http.server 8081`
  → <http://localhost:8081> (8080 tends to be taken).

Fills the whole window and adapts to resizes. Works in current Chrome,
Firefox, Safari and Edge. Total payload is a few tens of KB.

## Modes

- **Ranked** — the 10 fixed campaign levels (identical for every player, so
  the leaderboard is fair). Finish all ten and your score —
  **strawberries banked × 10 − seconds** — is logged. Collect the **golden
  strawberry on all 10 levels** for a **⭐ PERFECT run** (+250 bonus).
  Starting a fresh ranked run **resets everything**: no gear, no
  strawberries, a clean race. Your run is **saved to the browser** — quit to
  the menu and **Resume** right where you left off.
- **Endless** — the same generator with a random seed, scaling up forever
  and untracked, for practice and fun.

Between every level (**and after a death**) a **shop** lets you spend
strawberries on gear, and
after clearing a level you can **Continue** or **Replay** it.

## Controls

| Input | Action |
|---|---|
| Arrow keys / WASD | **Move freely in any direction** — hold combinations for diagonals; you slide along walls |
| **Double-tap a direction** (or **Shift**) | **Dash**: a burst of speed that spends **3 🍓**. It fires in the direction you press — double-tap dashes that way; Shift dashes the way you’re currently holding. |
| Space / Enter | Advance menus / start the level from the shop |
| Touch | Press & drag = joystick · tap = advance · two-finger tap = dash |

An in-game **Handbook** (button on the menu, shop, and leaderboard)
explains every control, hazard, item, and passive.

## Strawberries are currency

Strawberries are both your fuel and your money. Collect them on the ground;
they **carry between levels** as your bank. A dash spends 3. Each level
hides a **golden strawberry worth 5** at a **random spot in the final
section** near the food truck. Grab it on all 10 ranked levels for a
**perfect run**. The **shop** spends strawberries on gear.

## Settings

A **Settings** screen (from the menu) lets you tune dashing:

- **Double-tap to dash** — turn the double-tap trigger on or off (handy if
  you dash by accident while weaving).
- **Dash key** — rebind it from the default **Shift** to any key (movement
  keys, Space and Enter are reserved). Press the button and hit a key;
  Escape cancels.

Settings persist in the browser.

## Global leaderboard (optional Supabase backend)

Out of the box the leaderboard is **local** to each browser. To make it
**global** (shared by everyone playing your build), point it at a free
[Supabase](https://supabase.com) project — the game submits and reads scores
over its REST API, and falls back to the local cache when offline or
unconfigured.

1. Create a free Supabase project. In the **SQL editor**, run:

   ```sql
   create table if not exists public.scores (
     id bigint generated always as identity primary key,
     name text not null,
     score int not null,
     berries int not null default 0,
     time_sec real not null default 0,
     golds int not null default 0,
     perfect boolean not null default false,
     created_at timestamptz not null default now()
   );
   alter table public.scores enable row level security;

   -- anyone may read the board
   create policy "read scores"  on public.scores for select to anon using (true);

   -- anyone may submit, with light sanity checks (client-only games are spoofable)
   create policy "insert scores" on public.scores for insert to anon
     with check (
       char_length(name) between 1 and 16
       and score between -100000 and 1000000
       and berries >= 0 and golds between 0 and 10
     );
   ```

2. In **Project settings → API**, copy the **Project URL** and the **anon /
   public** key.
3. Paste them into [`src/config.js`](src/config.js):

   ```js
   window.LEADERBOARD_CONFIG = {
     url: 'https://YOURPROJECT.supabase.co',
     anonKey: 'YOUR-ANON-KEY'
   };
   ```

That's it — finishing a ranked run now posts to the shared board, and the
Leaderboard screen shows the global top 50 (with your row highlighted).

Notes: the anon key is meant to be public; row-level security controls what it
can do. For the online board, serve the game over http(s) (e.g. GitHub Pages) —
from `file://` some browsers block the request and it falls back to local. A
client-only leaderboard is inherently spoofable; the checks above are basic
anti-spam, not real anti-cheat.

## The shop & loadout

Between every level you visit the clubhouse shop. Within a run, purchases
are **owned** and you equip **one passive skill + two active items**,
swapping freely. (Starting a brand-new ranked/endless run wipes all of it —
each run earns its gear from scratch.)

- **Passives** (always-on): Fresh Legs (speed), Linen Whites (beats the
  heat), Iron Constitution (a 4th heart), Sure-Footed (ignore picnic rugs),
  Thrifty Dasher (dashes refund 1 🍓).
- **Items** (one-time-use shields that recharge each level; buy the
  **upgrade** to make them reusable): Tennis Racket (bat away a ball),
  Lollipop (survive a child), Umbrella (shrug off a sprinkler), Sunglasses
  *(aura — ignore photo flashes)*, Accreditation *(aura — security ignores
  you; upgrade loses fans too)*, Caltrops *(aura — slow nearby wheelchairs;
  upgrade slows kids too)*.

Every equipped item and passive **shows on the character** (racket in hand,
lanyard on the chest, sun hat, boots…), and upgraded gear looks distinct.

## The campaign — ten grounds, one new thing at a time

Levels are **generated from a compact spec** (the 10 ranked levels use fixed
seeds, so they’re the same for everyone). Each is ~2× the length of the old
levels — 44 to 71 rows tall — seen through a zoomed-out scrolling camera.
Each carries a **time-of-day theme** (dawn → night) and a **warmth**: hotter
levels (heat-haze) physically slow you unless you’re dressed for it.
Difficulty and mechanics ramp deliberately:

1. **The Garden Gate** (dawn) — just the crowd: wandering picnickers.
2. **The Long Lawn** (morning) — + picnic rugs and a sprinkler.
3. **The Children’s Field** (midday) — + chaotic sprinting children.
4. **The Midday Concourse** (noon, *hot & slow*) — + flashes & stewards.
5. **The Members’ Enclosure** (afternoon) — + autograph fans & security guards.
6. **The Practice Courts** (golden hour) — + flying tennis balls & ball kids.
7. **The Terrace Gauntlet** (dusk) — everything, denser.
8. **Centre Court** (dusk) — + a **crossing crowd** you must slot through.
9. **The Semi-Final** (night) — the penultimate test, at pace.
10. **The Champions’ Gala** (floodlit night) — the finale, at full tilt.

Every level is busier now — extra **slow-moving picnickers** everywhere. The
crowd moves in **groups** (walking parties, seated picnic circles). Kids
sprint; wheelchairs run fast straight lines; stewards patrol; fans and
security chase. Two special formations arrive late:

- **Crossing crowds** — a marching column two rows deep crosses the screen
  with a wide gap corridor. You slot into the gap and track it up.
- **Ball kids** — a line of six in matching green or purple, jogging across
  in formation. Dodge the line.

Hearts refill each level (3, or 4 with Iron Constitution). A hit costs a
heart + 2 🍓 and sends you to your last **zone checkpoint** with brief
invulnerability. Zero hearts retries the level with the bank & loadout you
entered it with.

## Architecture

```
index.html      fullscreen shell: glassy HUD, progress bar, toasts,
                overlay / shop / handbook / leaderboard screens (styling only)
src/logic.js    PURE simulation — no DOM/canvas. Free-movement physics,
                the LEVEL GENERATOR (validated: BFS connectivity + patrol
                clearance) with 10 fixed ranked levels + endless, tile
                terrain, 2D NPC brains (wander / patrol / chase / group /
                seated / security / marching formations / ball-kid lines),
                tennis balls, the economy + loadout effect system. UMD.
src/render.js   Canvas 2D pseudo-3D renderer. Per-level day→night themes,
                heat haze, a detailed food truck, marchers & ball kids,
                on-body gear indicators, y-sorted props/people/balls,
                night lighting, particles, camera shake.
src/input.js    Keyboard + touch → an analog movement vector; directional
                dash (double-tap the way you press, or Shift the way you hold).
src/main.js     Fixed-timestep loop, ranked & endless campaign flow, the
                shop / handbook / leaderboard (CSP-safe DOM), run reset,
                HUD, and local score persistence.
test/logic.test.js  Unit tests via Node's built-in runner.
```

Design decisions and why:

- **Levels are generated, not hand-placed** — a compact spec (rows, zones,
  a mechanic set with densities) is grown into a full level with validated
  hedge gates, sparse point hazards, short partial walls, and patrols laid
  only on clear rows — so connectivity and patrol-clearance hold by
  construction (a BFS relaxation pass is the safety net). This is what makes
  levels trivially long, endless, and consistently fair; the 10 ranked
  levels are just fixed-seed generations.
- **Free movement over tile hops** — a circular collider moved per-axis
  against the tile grid; NPCs, hazards and authoring stay tile-based.
- **Directional dash** — the dash reads the key/gesture that triggered it,
  not the drift direction, so tapping “up” while walking left dashes up.
- **Formations march, everything else roams** — marchers/ball-kids move in
  lockstep across their row and wrap at the edges (like lane traffic), so a
  crowd stays in formation and the gap corridor translates rigidly.
- **Fresh runs reset gear** — each ranked/endless run starts with nothing,
  keeping the leaderboard honest and every run a real economy challenge.
- **Security posture** — zero external requests, no CDNs, no `eval`, no
  inline event handlers; all dynamic UI built via DOM APIs, text via
  `textContent`. A suggested CSP header is documented in `index.html`.

## Tests & balance

```
npm test        # = node --test test/logic.test.js  (Node 18+, no deps)
```

44 tests cover: free-movement physics, warmth/heat and every passive, the
**directional** currency dash, all six items (charge shields, reusable
upgrades, auras) vs their hazards, security/accreditation, tennis balls &
the racket, **marching formations** (cross-and-wrap), **ball-kid lines**,
hearts/checkpoints, and — for **all 10 ranked levels plus generated endless
levels** — connectivity, band containment, patrol validity, construction
sanity, the gradual-introduction of mechanics, and generator determinism.

Balance is tuned against a headless goal-seeking bot (level-appropriate
loadouts): a careful player clears every level, difficulty rises steeply
L1 → L10, and mindless play wins no level (random play: 0 everywhere). The
bot never dashes or reads a moving gap, so it’s a conservative lower bound —
the late levels are deliberately brutal, as asked, but always winnable.

## Known limitations / future ideas

- No audio yet (a small WebAudio synth would fit the zero-asset approach).
- The leaderboard is local (localStorage); a shared board needs a backend.
- More item upgrade tiers; per-level best times; a level-select.
