# AeroMod

A TAS (tool-assisted speedrun) and practice toolkit for **Aerox 1.9.5** on iOS (`com.synoptical.aerox`).

It runs inside the game as a [Frida](https://frida.re/) script and adds a panel with:

- **Frame-exact macros** – record a run tick by tick, replay it identically, rewind and edit it, and resume recording from any point.
- **Speed control and frame stepping** – slow motion, pause, +1 / +10 / +60 frame steps.
- **Splits and a run timer** – drop split boxes anywhere, compare against TAS-local golds.
- **Teleport and a top-down coordinate picker.**
- **Virtual tilt and hardware keyboard input** – play with the device flat on a desk.
- **Death-warp tools** – arm warps on demand and see every level's exact warp zone on a map.
- **Cosmetic ball skins** unlocked by TAS achievements.

With the panel closed (**SETTINGS → CLOSE AEROMOD**) the game is back to stock.

> AeroMod does not include the game. You need your own copy of Aerox 1.9.5.

## Documentation

| File | What it covers |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Getting it onto a device: tethered Frida, jailbreak package, sideloading |
| [INSTRUCTIONS.md](INSTRUCTIONS.md) | Every tab and button |
| [docs/THEORY.md](docs/THEORY.md) | How the less obvious tools work (determinism, rewind, death warps, skins) |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Notes for changing the macro / physics code |

## Install

- **Rootless jailbreak (Dopamine):** add `https://sqix2018.github.io/` in Sileo and install **AeroMod**. No PC needed. Tested on Dopamine, iOS 15.8.
- **Jailbroken + PC:** the quick start below.
- **Not jailbroken:** patch your own decrypted IPA with `tools/patch_ipa.py`, install it with Sideloadly and launch it through StikDebug. Tested on iPhone, iOS 18.0.1.

Details for all three are in [docs/INSTALL.md](docs/INSTALL.md).

## Quick start (jailbroken device + PC)

1. Install **Frida** on the device from its Sileo/Cydia repo, and `frida-tools` on the PC (`pip install frida-tools`, same major version).
2. Open Aerox, plug the device in over USB.
3. From this folder:

   ```bash
   frida -U -n Aerox -l dist/aerox-tas.js
   ```

4. Wait for `ready - tap the AeroMod pill to open the panel`, then tap the **AeroMod** pill.

After a rebuild, quit Frida and inject again. Other ways to install are in [docs/INSTALL.md](docs/INSTALL.md).

### Turning it off and on

- **SETTINGS → CLOSE AEROMOD** unhooks everything: frame loop, input, ad gate, score gate, ball skin.
- Bring it back without re-injecting: hold **two fingers in two different corners** for about half a second, hold **three fingers**, or run `tas.on()` in the Frida console.

While AeroMod is open, finishes **do not** save menu bests or Game Center scores. Close it to set a real time.

## Building

The file you inject is `dist/aerox-tas.js`, bundled from `src/`.

Any OS (macOS, Linux, Windows), Python 3 only:

```bash
python3 tools/bundle.py
```

Windows without Python: `powershell -ExecutionPolicy Bypass -File tools\bundle.ps1` (same output).

With Node (`npm install` first): `npm run build`.

The bundler also bakes `assets/skins/*` into `src/tas/skin-defaults.js`. You only need to build after changing `src/`; the committed `dist/aerox-tas.js` is ready to use.

## Crashes and logs

The Frida console shows what you need while playing. Everything else (per-frame macro tape, perf and memory breadcrumbs) goes to the device:

- `Documents/aerox-tas/tas.log` – rotating log, capped at ~180 KB. Open it with Filza after a crash.
- `Documents/aerox-tas/tape.log` – one line per recorded/played frame. **RECOVER FROM TAPE** can rebuild lost macros from it.

`Process terminated` with **no** `CRASH` lines usually means iOS killed the app for memory; the last `perf` line in `tas.log` shows where.

## Layout

```
src/
  index.js        entry point, console API (tas.*)
  core/           memory helpers, offsets, logging, storage, memory budget
  game/           frame loop, input, ball, level, camera, physics (Bullet) hooks
  tas/            macros, rewind, splits, death warps, skins, achievements
  ui/             panel, HUD, warp map, keyboard, widgets
  vendor/         frida-objc-bridge (Frida 17 no longer builds it in; needed by Gadget)
assets/skins/     ball wrap images, baked in at build time
dist/             aerox-tas.js - the script you inject
tools/
  bundle.py       bundler for any OS (Python 3)
  bundle.ps1      same bundler for Windows PowerShell
  check.py        static require/export sanity check
  scn.py          reader for the game's .scn level files
  scn_zones.py    bakes src/tas/warpzones-data.js from your copy of the game
  package.py      builds the rootless .deb and the Sileo repo (repo/, for sqix2018.github.io)
  patch_ipa.py    adds AeroMod to your own decrypted IPA for sideloading
docs/
```

## Legal

AeroMod is an unofficial fan tool, not affiliated with Synoptical. This repository contains no game code, binaries, levels or textures; do not add any. `src/tas/warpzones-data.js` holds only coordinates computed from the level files. Check the licenses of any images you put in `assets/skins` before publishing them.
