# Development notes: macro determinism

Read this before changing PLAY / RECORD / clock / input. It is the state of the
Level 26 determinism work as of 2026-09-22.

## Status (2026-09-22, later): PLAY is deterministic

Fresh L18 take: RECORD + 6 PLAYs all `trace: matched ... max d=0.0000`.
Every piece below was needed; do not remove one without a replay test.
All live in `src/game/physics.js` unless noted.

1. `frame.js` clock seed floored to a whole second (dt rounding was seed-dependent).
2. Bullet `m_localTime` (world+0x170) zeroed at load and arm (leftover from unpinned play).
3. Before `loadLevel:` the ball is removed from the world (vt+0xb8). The game
   adds the new scene while the ball's old leaf is still in the dbvt.
4. At arm: rigid bodies' interp transform/velocities and world inverse inertia
   rebuilt from the pose (the ball body is reused across loads).
5. At arm: every body removed and re-added in order with its filter
   (vt+0xb8 / vt+0xb0, **int** group/mask at proxy+0x08/+0x0c - reading shorts
   gave mask 0 and everything fell through the floor).
6. dbvt counters reset at load/arm; `m_cupdates` = 100 (full stale-pair sweep;
   the partial sweep keyed on `m_newpairs` shifted a frame run to run).
7. `btDbvt::optimizeIncremental` (Aerox+0x460f0, `offsets.js`) is skipped during
   TAS takes via a CModule gate. It rotates the tree by comparing heap addresses.
8. Yaw: `touchesMoved` pans yaw between ticks; tilt steer turns inside the tick.
   New tapes store the pre-tick yaw in column 5; PLAY writes it before the tick.
   Old tapes use column 3 (exact while steer is 0). Previous-row yaw is wrong.
9. Memory: autorelease pool around JS hook sections + gc only when idle/paused/
   at arm (a forced gc mid-run is a 70-650ms hitch; none at all leaked to jetsam).

Diagnostics: `trace:` lines compare ball position vs RECORD every frame (cheap).
`tas.macro.state.physTrace = true` adds a per-frame Bullet fingerprint and prints
the first differing tick (~5-10ms/frame - it made RECORD visibly lag).

Tapes recorded before these fixes cannot match PLAY exactly; re-record.

## Goal

Make PLAY deterministic and faithful to RECORD. Same tape, same physics, every
time.

Reference take: **Level 26, 2571 frames, skip intro @161, Get Ready dismiss @208**
(HiFinish 2571f / 42.85). That take used to replay cleanly. Later “fixes” made
PLAY desync: the ball dies mid-line, a tip/respawn screen appears, and runs
differ from play to play.

Restore that fidelity. Do not invent new tap behavior. Do not “help” by
dismissing unexpected tips.

## Build and inject

Edit `src/` only. The injected file is always `dist/aerox-tas.js`.

```powershell
powershell -ExecutionPolicy Bypass -File tools\bundle.ps1
```

```bash
frida -U -n Aerox -l dist/aerox-tas.js
```

- Do not `%load` or paste the path into the Frida REPL. Quit and relaunch with `-l`.
- After every `src` change, rebuild. Reload Frida and paste logs.
- Never wipe `src/tas/skin-defaults.js`. If `assets/skins` is empty, keep the
  existing defaults (`golf.png` was overwritten once this way).
- There is no useful git history. `tools/_restore_2300/` is a reconstructed
  snapshot of macro / frame / input / level / camera from the
  “clock-fix / 1153f clean” era, before native-play experiments.

## How macros work

One row per `processGameFrame`, not per wall-clock second:

```
[steer, thrust, buttons, yaw, events]
```

`steer` / `thrust` are the **final** `tiltSteer` / `tiltThrust` after the game
computes them. PLAY writes those into EAGLView `accelY` / `-accelX` with
`motionManager` NULL and calibration zeroed (`src/game/input.js`). That is
Original-tilt equivalent.

`processGameFrame` (simplified):

- `dt = NSDate - lastFrameTime`
- if `motionManager == NULL`: `tiltSteer = accelY - calibY`,
  `tiltThrust = (calibX - accelX) / divisor`
- if `inPlay && !menuFlag`: `cameraYaw += steer * 0.2 * (dt * ~60) * …`
  then apply force along the new facing

Yaw feeds the next force. `menuFlag` (tips / Get Ready) **freezes** physics.
`introPlaying` still simulates — the skip frame matters for moving platforms.

Events: `EVENT_SKIP_INTRO = 1`, `EVENT_DISMISS = 2`. Replay **only** the taps
that are on the tape, on those frames (plus a one-frame previous-row retry).
Get Ready on this take is frame 208.

Mid-run tips that were not recorded must **not** be auto-tapped. An unexpected
tip during PLAY means the run already desynced (death / respawn). Leave the tip
up. Do not dismiss it. Do not abort PLAY as a feature.

### Clock and speed

During RECORD / PLAY, `NSDate` and `stepSimulation` are pinned to exactly 1/60
(`src/game/frame.js`, native C pin, last write before `originalImp`).

SPEED is a clean hack: every simulated tick is still 1/60. 0.5x skips display
frames; 2x runs two 1/60 ticks on one vsync. Do **not** multiply `dt` by SPEED.
Record at 0.5x / play at 1x must be the same function.

### Smooth cam

Playback-only, next to PLAY CLEAN. Rotate the camera node around the draw, then
put recorded `cameraYaw` back before the next physics tick. It must never leak
into the next `processGameFrame`.

### Hook order

`src/index.js`: `macro.install()` then `input.install()`. Macro pre-hook
publishes override; input pre-hook writes ivars. Keep that order.

## What worked

Do not abandon this path.

Era: clock pin + JS PLAY + yaw written **before** the tick and pinned **after**
+ CoreMotion restored after each tick + skip / dismiss only from the tape.

Evidence:

- A 1153f take played clean once the clock pin landed (`dt` was no longer
  1/60 + JS hook time).
- L26 2571f then replayed cleanly on that path.
- Smooth cam was added after that as view-only. Keep it, but physics fidelity
  comes first.
- Best recent L26 log on that path: `skip@161`, `dismiss@208`, playing through
  ~1916, `phase=message` around 2036. Almost finished. Then a tip (desync
  death), then hook off. That is the high-water mark — get back there, then
  past the finish.

## What was tried and made it worse

Do not repeat these.

1. **Native C PLAY** (`armNativePlay`): skip / dismiss then stuck on
   `phase=message`, hook off, `steer native`. Owner does not want native-play
   experiments. JS PLAY only. `stopNativePlay` on arm is correct. Do not
   re-enable `armNativePlay`.
2. **Removed yaw-before-tick** (only pin after). L26 died much earlier.
   Current `src` put yaw-before-tick **back**. Keep it unless you can prove a
   better model against the 2571f take.
3. **Auto-dismiss leftover tips** when `cursor >= dismissAt` and no future
   dismiss on the tape. Owner rejected this. Recorded tips are already on the
   tape. An unexpected screen is a failed run, not a missing tap.
4. **`abortPlayback` on “unexpected tip”**. Fired at 640f on the same take that
   previously reached ~2000. Removed. Do not bring it back.
5. **Tape `console.log` / per-frame RECORD-vs-PLAY compare spam**. Leaked
   ~20MB RSS every 2s, then jetsam. File-only logging if you need compare data.
6. **Rewind snapshots every PLAY frame** (full mesh byte arrays). Crashed the
   device. PLAY must not capture rewind. RECORD snapshots are ball + a few
   `mass>0` bodies, floats only.
7. **Treating `loadLevel` `currentMenu=6` as user pause.** False
   `PLAY stopped - pause` on clean takes. Do not treat menu 6 as pause-abort.
8. **Treating death-warp `inLevel` flicker as “left the level”** and tearing
   UI down mid-finish. Linger / finish pad exists so victory can draw
   (`FINISH_PAD = 90`).
9. **Old SPEED that multiplied `dt`** (0.5x = 1/120, Bullet accumulator
   skipped steps). That made record-slow / play-1x a different game. Already
   replaced. Do not put `dt *= speed` back.
10. **`bundle.ps1` regenerating empty `skin-defaults`** and wiping `golf.png`.
11. **Mixing native-play C tape with JS hooks mid-run.** One path: JS.

## Current `src` state (2026-09-22)

`src/tas/macro.js` `applyBeforeFrame`:

- `setOverride` + buttons
- write `cameraYaw` from this row before the tick (if `pinYaw`, not intro, not complete)
- `replayGates` only for tape skip / dismiss (current or previous row)

`src/tas/macro.js` `applyAfterFrame`:

- pin `cameraYaw` again
- `cursor++`
- no unexpected-tip abort

`src/game/input.js`:

- PLAY writes accel via override
- `restoreAfterFrame` always restores CoreMotion after the tick
- do not keep `motionManager` NULL across frames

`src/game/frame.js`:

- 1x: one `runTick` per `processGameFrame`
- clock pin last-write-before-game
- native play C still exists but must stay unused

`src/game/level.js`:

- `dismissMessage` still sets `inPlay = 1` on Get Ready (physics-facing)

`tools/_restore_2300/` is the pre-native-play reference for these files.

## Known remaining bug

The same L26 tape is not stable. Best play: almost to the end, then a tip
(death). Worse plays: die much earlier after the failed experiments above.
Owner: runs deviate a lot from play to play. Fix consistency of the PLAY
function, not more gate heuristics.

### Likely real drift sources

Investigate. Do not shotgun.

- Anything that writes `cameraYaw` besides the tape pin (smooth cam leak,
  `resetStartYaw` / `checkpointYaw`, visual hold not restored)
- Anything that changes `dt` or `lastFrameTime` if the C pin misses a frame
- `menuFlag` / `inPlay` / skip timing off by one vs RECORD sample point
- JS hook time / RSS leak affecting anything not actually pinned
- `restoreAfterFrame` vs next pre-hook order
- finish / complete ending PLAY before death warp

Do **not** “fix” a mid-run tip by tapping it. That hides desync.

## Owner rules

- Be brief. Do what we know works. Stop theorizing about native play.
- Do not auto-dismiss tips. If a tip appears and it is not on the tape, the
  run already failed.
- PLAY CLEAN + pause = stop the take and restore UI (already implemented).
- Smooth cam is playback-only, next to PLAY CLEAN, view-only.
- Do not commit unless asked.
- Small diffs. Rebuild after changes. Ask for a PLAY of L26 2571f and a
  Frida log.

## Success

Frida log on L26 2571f:

```
playback armed 2571f skip@161 ready@208
PLAY skip intro @161f
PLAY dismiss @208f
```

Hook stays on, `phase=playing`, through the line. No `PLAY failed`, no
unexpected auto-dismiss. Finish plays out (`PLAY 2571f done` / finish
appeared), UI returns.

Same tape twice = same line. No death tip that was not in the recording.

## Start here

1. `src/tas/macro.js` — `applyBeforeFrame`, `applyAfterFrame`, `replayGates`,
   `resetStartYaw`, `applyVisualCam`
2. `src/game/frame.js` — `runTick`, `applyClock`, `ticksThisVsync`, 1x shortcut
3. `src/game/input.js` — `drive`, `applyBeforeFrame`, `restoreAfterFrame`
4. `src/game/level.js` — `dismissMessage`, `skipIntro`, `messageUp`, `inPlay`
5. `tools/_restore_2300/macro.js` — compare PLAY path

Then state the smallest change and why, before editing.
