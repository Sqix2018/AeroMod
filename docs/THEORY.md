# How the tools work

The reasoning behind the tools that don't explain themselves. File references are to `src/`.

---

## Frame-exact timing

Aerox runs its whole game step, `processGameFrame`, once per screen refresh. It measures the time since the last frame and feeds that `dt` to the Bullet physics engine, the intro timer and the run timer. Real frame times jitter, so two identical inputs never produce an identical run.

AeroMod swaps that method for its own (`game/frame.js`). During a macro take, every tick:

- `NSDate` is pinned to a TAS clock that advances exactly 1/60 s, and
- `stepSimulation:` always receives exactly 1/60.

The speed slider only changes **how many** of those fixed ticks run per second of wall time. That's why a take recorded at 0.5× plays back identically at 1×, and why REFRESH PHYSICS can safely run at up to 8×.

Outside a macro the game keeps its own clock, so casual play feels normal.

### Everything else that had to be pinned

Fixed ticks weren't enough on their own. Bullet keeps internal state that survives level loads and made replays drift: leftover time, broadphase counters, the order of bodies in the world, and a tree-rebalancing step that sorts by heap address. At the start of every take AeroMod resets or rebuilds all of these. The full list, and why each item is needed, is in [DEVELOPMENT.md](DEVELOPMENT.md).

---

## What a macro stores

One row per tick: `steer, thrust, buttons, yaw, events, pre-tick yaw`.

- **Steer and thrust are the game's final tilt values**, not raw accelerometer data. The device tilt, the on-screen pad and a keyboard all record the same way, and playback writes the values back where the game reads them.
- **Yaw.** Swiping the camera turns the ball's heading, and that happens *between* ticks, while tilt-steering turns *inside* the tick. The row stores the yaw the tick started on, so both kinds of turn replay exactly.
- **Taps aren't recorded as touches.** Only two taps change the run: skipping the intro and dismissing "Get Ready!" (or a mid-run tip). AeroMod records those as events and replays them by running the same code the touch handler runs.

Macro files store floats as raw 32-bit patterns, so saving and loading can't round anything.

---

## Rewind and REFRESH PHYSICS

Bullet has no way to run backwards. **Rewind restores snapshots**: the ball's and any moved object's position, rotation and velocity, captured every tick while recording (and during CONTINUE).

A snapshot can't restore Bullet's hidden state: which surfaces are touching, the list of overlapping pairs, the collision tree and the order of bodies in the world. After a rewind, the next frames usually play out the same anyway. But when the ball has been interacting with crates or other movables, especially ones that respawn, that hidden state can differ, and a take edited with many rewinds may not replay the way you recorded it.

**REFRESH PHYSICS** fixes that by replaying the take from a clean level load up to where you are, at up to 8× speed. That replay is exactly what PLAY will do later, so anything recorded after it is deterministic. The console reports the first frame where the replay differed from what you recorded. The frames are kept: if you like how it plays out, carry on; if not, rewind to before that frame, re-record and refresh again.

### RECOVER FROM TAPE

Every recorded or replayed tick is also written to `tape.log`, with each value's exact bits. A macro that was deleted or overwritten can usually be rebuilt from it.

---

## SHIFT INTRO

Moving platforms run from the moment the level loads, including during the intro fly-around. The tick you skip the intro on therefore decides where every platform is for the rest of the run.

SHIFT INTRO changes that tick without re-recording. The ball is frozen, and:

- **+N** simply lets the platforms run forward.
- **−N** means "start earlier". Platforms can't run backwards and snapshots can't rewind their animation timer, so AeroMod removes N idle intro frames and does a quick replay to show the result. It can't go earlier than intro frame 1.

When you stop, the skip tap moves by the net amount and every later input moves with it.

---

## Death warps

A death warp is a death that completes the level. It's a quirk of how Bullet finds collisions. Everything below was worked out from the game binary and confirmed against recorded warps.

**The pieces**

- `ResetPlayer` is the kill volume (the ocean). Touching it teleports the ball back to its spawn.
- `EndFlare` is the finish trigger: the tall beam at the goal (3 wide, 24 tall, thin). Touching it completes the level.
- Bullet's broadphase keeps a tree of bounding boxes. After a teleport, the ball's box for that frame is the **union of where it was and where it went**: a long box stretching from the death point to the spawn.

**Three conditions, all required**

1. **Armed.** Normally the ball is the last body in Bullet's world list, and the kill is processed before anything else can react. When a movable object (crate, plank, barrel…) falls into the void, the game removes it and adds it back, which moves the ball up the list. Now, in that frame, the ball's stretched box is checked against the tree *after* the teleport. That is what FORCE VOID and AUTO VOID set up.
2. **Tree order.** In that pass, EndFlare has to be reached before ResetPlayer. That depends on how the tree was built at load, so it varies from load to load and nothing can control it. It is why an armed death inside the zone doesn't warp every time.
3. **Geometry: the zone.** The stretched death→spawn box has to overlap EndFlare's box. That's pure geometry, so it gives an exact region per spawn:
   - on each horizontal axis, if the spawn is within EndFlare's width (plus the ball's size), any death position works;
   - if the spawn is past EndFlare on that axis, the death has to be on or behind EndFlare's far side;
   - **height:** the spawn has to be high enough that the box reaches EndFlare's bottom. On most levels the beam starts well above every spawn, and those levels can't warp at all.

**The green box on the warp map is condition 3**, computed from the game's own level files (`tools/scn_zones.py` → `tas/warpzones-data.js`) for every level, start spawn and checkpoint. It matched every recorded warp we could check. Warps outside the box would mean the model is incomplete, so AeroMod keeps those (and only those) and prints `OFF-MODEL WARP`.

Levels that have no movables can't be armed. The WARP status line tells you when a level has none.

---

## Ball skins

The live ball is one of the game's "hero ball" models. Skins **borrow another model's look** instead of changing the ball's physics:

- **Wraps** (Globe, Comet, flags…) borrow the smooth tennis-ball sphere (hero ball 3) and upload the image as its texture, cropped to 1024×512.
- **Mirror** borrows the sphere and replaces every texture layer with the live sky reflection, the same reflection hero ball 0 (silver) uses.
- **Golden** puts hero ball 5's own materials (a flat gold layer plus the sky reflection) on the smooth sphere. It hides that ball's glow layer, which is the orange stripes, and swaps its flat gold for a brighter one.
- **Glass** copies only hero ball 4's outer shell, without the lightning inside.

Borrowed materials are shared with the Change Ball menu, so AeroMod puts the originals back whenever you're on the main menu and re-applies the skin when a level starts.
