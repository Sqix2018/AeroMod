# AeroMod instructions

Every tab and control. Installing is in [docs/INSTALL.md](docs/INSTALL.md); the reasoning behind the trickier tools is in [docs/THEORY.md](docs/THEORY.md).

Tap the **AeroMod** pill to open the panel; drag the pill or the panel header by its grip. **SETTINGS → Visible tabs** hides tabs you do not use (MACRO, LOG and SKIN start hidden). SETTINGS itself can't be hidden.

While AeroMod is open, finishes never write a menu best or a Game Center score.

---

## SPEED

| Control | What it does |
|---|---|
| Speed slider (0.05×–3×) and 0.1× / 0.25× / 0.5× / 1× / 2× | How many physics ticks run per second while a macro is recording or playing. Each tick is always exactly 1/60 s, so a take recorded at 0.5× plays back identically at 1×. |
| PAUSE / RESUME | Freezes the simulation; the game keeps drawing. Step frames from MACRO. |

Outside a macro, the game runs on its own clock and the slider has no effect.

---

## TIME

Split golds are **TAS-local** (stored by AeroMod), not the game's bests.

| Control | What it does |
|---|---|
| Level timer | Shows the big run clock. |
| Split overlay | Shows the split list. |
| Segment timer | Time since the last split. |
| Reset splits on death | A death restarts the split run. |
| PLACE POINT | Drops a split box (40 units across) at the ball. A split stamps when you **leave** the box. |
| DEL POINT | Removes the last split box. |
| NEXT SPLIT | Teleports to the next unset box. Keyboard **N**. |
| RESET GOLD | Clears this level's golds. |

---

## MOVE

| Control | What it does |
|---|---|
| X / Y / Z | Target coordinates. Y is up. |
| SELECT COORDINATE ON MAP | Full-screen top-down map; tap a spot to fill X and Z. Y is kept (a top view has no height). |
| TELEPORT | Instant move. |
| SLIDE TO | Moves in short hops. Use this if TELEPORT drops you through a floor. |
| COPY CURRENT | Fills the fields with the ball's position. |
| Nudge X− X+ Y− Y+ Z− Z+ | One unit each. |
| STOP BALL | Near-zero velocity. It is never exactly zero: the game divides by speed and a true zero turns into NaN. |

---

## INPUT

| Control | What it does |
|---|---|
| Virtual tilt | An on-screen arrow pad replaces the accelerometer, so the device can lie flat. |
| Hardware keyboard | A paired keyboard drives the game (keys below). |
| Tilt magnitude | 5–100 % of the current control scheme's maximum tilt. |
| Invert steer / Invert thrust | Flips the pad and keyboard directions. Real device tilt is never inverted. |
| Controls: Original / Alternate | Read-only: the game's own control setting. |

**Keyboard:** arrows = tilt · Space = pause · `.` = +1 frame · `,` = +10 frames · N = next split · B = alt brake (when enabled).

---

## MACRO

A macro is one row per physics tick, starting from a fresh level load. The intro fly-around counts: platforms move during it, so the frame you skip the intro on is part of the run. Macros are saved per level in `Documents/aerox-tas`.

| Control | What it does |
|---|---|
| RECORD | Restarts the level and records every tick. Type a name first to autosave. Crossing the finish stops and saves. |
| PLAY | Restarts and replays the loaded take, then lets the finish play out. |
| PLAY CLEAN | PLAY with the panel hidden, for clips. Pausing aborts the take and brings the UI back. |
| CONTINUE | Replays the take at normal speed, then keeps recording from its end. **PAUSE or −N during it leaves off right there**, and the replay builds an undo buffer you can walk back through. |
| CONTINUE PAUSES | ON: CONTINUE freezes when the replay runs out so you can RESUME into recording. OFF: recording starts immediately. |
| STOP | Ends RECORD / PLAY; a partial take is kept. |
| PAUSE, −60 −10 −1 +1 +10 +60 | Pause and step. Negative steps restore undo snapshots (up to 2 minutes back) and trim the take to that frame. They never replay. |
| Frame # + JUMP | Jump to a frame: restores a snapshot if one exists, otherwise replays to it. |
| REFRESH PHYSICS | Replays the take from the start at up to 8× and pauses where you are. Press it after lots of rewinds, especially around crates, so what you record next plays back exactly. The console reports the first frame that came out different; nothing is cut. See [THEORY](docs/THEORY.md#rewind-and-refresh-physics). |
| SMOOTH CAM | PLAY only: smooths the *view* toward the recorded camera yaw. Physics still uses the recorded values. |
| SHIFT INTRO | Retimes the whole run against the moving platforms. The ball freezes; **+N** runs the platforms forward, **−N** starts them earlier (a quick replay previews it). Stop to move the intro-skip tap by that many frames; every later input moves with it. |
| REVERT INTRO | Puts the intro-skip timing back to before any SHIFT INTRO edits. |
| Name, SAVE, DELETE | Saves under the macro's own level. DELETE moves the file to `aerox-tas/trash/` rather than erasing it. The first overwrite of a file in a session copies the old one to `aerox-tas/backups/`. |
| RECOVER FROM TAPE | Rebuilds the newest runs found in `tape.log` as `tape NN …` macros. New tapes store exact values, so recovered takes are bit-exact. |
| Macro list | This level's macros. A trailing `...` means it never reached the finish. |

---

## WARP

Tools for **death warps**: dying in a specific way that completes the level. How they work is in [THEORY](docs/THEORY.md#death-warps).

| Control | What it does |
|---|---|
| Status line | Whether this load is armed, deaths and warps so far, checkpoint state. |
| FORCE VOID | Drops a movable object (crate, plank, barrel…) into the void. That arms the next ball death to be able to warp. |
| AUTO VOID | Does FORCE VOID automatically after every respawn or restart, skipping the intro and Get Ready. |
| Checkpoint | Keeps the spawn on the level's checkpoint (or the start) across resets. The warp zone depends on which spawn you die from. |
| Warp map | Top-down overlay: the **green box is the exact zone** where an armed death can warp, for this level and spawn. Title says `no warp` when this spawn can't warp at all. |
| Layer LIVE / CP ON / CP OFF | Which spawn the map shows. |
| Object drop Y | Height FORCE VOID drops objects to (−24 to 16). Lower it if big crates bounce off the stage instead of falling. |

Only warps that land **outside** the predicted zone are saved and drawn on the map; the console prints `OFF-MODEL WARP` when one happens. None are expected.

---

## LOG

The last 80 AeroMod lines, a CLEAR button and an auto-scroll toggle. The full log is `Documents/aerox-tas/tas.log`.

---

## SKIN

Cosmetic ball skins, unlocked on the ACHIEVE tab. They never change your real ball selection or the physics, and CLOSE AEROMOD puts the normal ball back.

| Control | What it does |
|---|---|
| STOCK BALL | Removes the skin. |
| Skin buttons | Apply a skin. Locked skins show `???`. |
| Flag | Cycles flag wraps once Flags is unlocked. |

Wraps (Globe, Eyeball, Golf, Comet, Galaxy, Clock, Neon, flags) are images from `assets/skins`, scaled to 1024×512 and wrapped on the smooth ball. **Mirror**, **Golden** and **Glass** are built from the game's own balls; see [THEORY](docs/THEORY.md#ball-skins).

---

## ACHIEVE

TAS achievements that unlock skins. Locked rows show only their title. **RESET ACHIEVEMENTS** relocks everything on this device; it never touches Game Center.

| Title | Unlocks | How |
|---|---|---|
| Around the world | Globe | Death-warp a level. |
| Third eye | Eyeball | Death-warp 3 different levels. |
| Warp nomad | Flags | Death-warp 5 different levels. |
| Hole in one | Golf | Finish a level with a macro. |
| Reflection | Mirror | Finish with Invert steer and Invert thrust on, using the virtual pad or keyboard. |
| Aurum | Golden | Beat every TAS gold split on a later run. |
| Record shattered | Glass | Level 1 under 3.00 s, without a warp. |
| Shooting star | Comet | Teleport at least 250 units. |
| Wormhole | Galaxy | Death-warp within 1.50 s of the start. |
| Tick by tick | Clock | Press +1 frame 20 times in a row. |
| Smooth moves | Neon | PLAY CLEAN a macro with SMOOTH CAM on. |

---

## SETTINGS

| Control | What it does |
|---|---|
| Visible tabs | Show or hide tabs. |
| Block interstitial ads | Stops mid-run full-screen ads (an ad mid-PLAY breaks the replay). Banners are untouched. |
| Coordinate readout | Small live X/Y/Z box. |
| Alt brake | Brake control for the Alternate tilt scheme (keyboard **B**). |
| RESTART LEVEL | Reloads the current level. |
| UNLOCK ALL LEVELS | Opens every level in level select. For sideloaded copies, which start at level 1 and never save TAS finishes. Can't be relocked. |
| UI size (50–100 %) | Scales the whole AeroMod UI, text included. Phones default to 70 %. |
| Rewind snaps | OFF clears and stops the undo buffer. |
| Warp watch | OFF stops the death watcher, warp map and AUTO VOID. |
| Skin apply | OFF restores the stock ball and refuses skins. |
| OPEN INSTRUCTIONS | Opens this page in Safari. |
| CLOSE AEROMOD | Unhooks everything. See the README to turn it back on. |

---

## Frida console

With a tethered session, `tas` is available in the console:

```js
tas.pause(); tas.resume(); tas.speed(0.5); tas.step(1); tas.back(10); tas.jump(2888);
tas.rec('name'); tas.play(); tas.playClean(); tas.stop(); tas.macros();
tas.save(0); tas.load(0);            // ball-only save slots (no platforms/crates)
tas.tp(10, 5, -20); tas.slide(10, 5, -20); tas.pos();
tas.forceVoid(); tas.autoVoid(true);
tas.off(); tas.on(); tas.logs(); tas.mem();
```
