# Installing AeroMod

You need **Aerox 1.9.5**: AeroMod reads that version's memory layout and won't work with others. AeroMod is a script (`dist/aerox-tas.js`) that runs inside the game through **Frida**. The three setups differ only in how Frida gets into the game.

**Which Frida version?** Only setup A cares: the `frida` tools on the PC and Frida on the device must be the same major version (17.x). Setups B and C bundle their own Frida (Gadget 17.18.0), so whatever is or isn't installed on the device doesn't matter.

| Setup | Needs | Status |
|---|---|---|
| A. Jailbroken + PC | Jailbreak, USB cable | Works today |
| B. Jailbroken, no PC | Rootless jailbreak (Dopamine), AeroMod from Sileo | Works (tested: Dopamine, iOS 15.8) |
| C. Not jailbroken | Your own decrypted Aerox IPA, `tools/patch_ipa.py`, Sideloadly, StikDebug | Works (tested: iPhone, iOS 18.0.1) |

---

## A. Jailbroken device + PC (works today)

1. On the device, add Frida's repo in Sileo or Cydia (`https://build.frida.re`) and install **Frida**. This runs `frida-server` on the device.
2. On the PC, install Python and then `pip install frida-tools`. The PC's major version must match the device's (e.g. both 17.x).
3. Open Aerox, connect USB, and run from this folder:

   ```bash
   frida -U -n Aerox -l dist/aerox-tas.js
   ```

The Frida console then shows AeroMod's messages and accepts `tas.*` commands. Closing the console unloads AeroMod.

---

## B. Jailbroken, no PC: Sileo package (rootless)

For rootless jailbreaks: Dopamine, or palera1n in rootless mode.

1. In Sileo (or Zebra), add the source `https://sqix2018.github.io/`.
2. Install **AeroMod**.
3. Open Aerox. AeroMod starts on its own; tap the **AeroMod** pill.

If no pill appears after a few seconds, open Aerox's `Documents/aerox-tas/boot.log` in Filza. It records each startup step (bridge, waiting for the app, AeroMod start, `ready`) and the error if one fails. `tools/tweak_diag.js` (run from a PC with Frida) shows whether the tweak loaded at all.

You don't need Frida installed on the device, and no PC is involved. The package carries its own Frida.

**How it works.** Frida also comes as **Frida Gadget**, a library that loads inside one app and runs a script from disk. The package installs:

```
/var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.dylib    Frida Gadget 17.18.0
/var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.plist    load only into com.synoptical.aerox
/var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.config   run the script below on launch
/var/jb/Library/AeroMod/aerox-tas.js                              AeroMod itself
```

The jailbreak's tweak loader (ElleKit on Dopamine) injects the gadget only into Aerox. The gadget then runs `aerox-tas.js`. To try a new build without repackaging, replace that file (for example with Filza) and relaunch Aerox.

- **Don't combine with setup A.** With the package installed, don't also inject from a PC, because two copies would fight over the same hooks. Uninstall the package, or disable it in your tweak manager, to use setup A.
- **Signing.** Frida publishes the gadget signed with its own certificate, which Dopamine refuses (`code signature invalid`). The package therefore depends on `ldid` and re-signs the gadget ad-hoc when it installs.
- **Rootful jailbreaks** (checkra1n, unc0ver) would need a second build with paths without `/var/jb` and architecture `iphoneos-arm`. That build doesn't exist yet.

**Maintainers:** `python tools/package.py` builds the `.deb` into `packaging/out/` and the repo files into `repo/`, which are published as the `Sqix2018/sqix2018.github.io` repo (served at `https://sqix2018.github.io/`).

---

## C. Not jailbroken: sideloading

Tested: iPhone on iOS 18.0.1 with StikDebug. You patch your own copy of the game, install it with **Sideloadly**, and launch it through **StikDebug**, which enables JIT. After a one-time setup on a PC, everything happens on the device.

### 1. Get a decrypted IPA of Aerox 1.9.5

App Store apps are encrypted, and the patch only works on a decrypted copy. This project doesn't provide the game, so use a copy you own. The usual way is to dump it from a jailbroken device that has Aerox 1.9.5 installed from the App Store, using a decrypter such as **CrackerXI+** or **TrollDecrypt** (on the device) or **bagbak** (from a PC). The result is an `.ipa` file.

### 2. Add AeroMod to it

You need Python 3 on a PC and this repository (download the ZIP from GitHub or `git clone`). From the repository folder:

```bash
python tools/patch_ipa.py path/to/Aerox.ipa
```

This writes `Aerox-AeroMod.ipa` next to the original. The first run downloads Frida Gadget 17.18.0 from Frida's GitHub releases. The script:

- adds `AeroMod.dylib` (Frida Gadget), `AeroMod.config` and `aerox-tas.js` to the app's `Frameworks/` folder;
- adds one *weak* load command to the game's executable so iOS loads the gadget at launch. If the gadget is ever missing, the game still starts normally;
- turns on Files app sharing, so the game's `Documents` folder (`boot.log`, `tas.log`, your macros) appears under **Files → On My iPhone → Aerox** once AeroMod has run;
- refuses an IPA that's still encrypted, and warns if it isn't Aerox 1.9.5.

### 3. Install Aerox with Sideloadly

1. On Windows, install [Sideloadly](https://sideloadly.io), plus **iTunes** and **iCloud** from apple.com (not the Microsoft Store versions; Sideloadly needs their drivers). On macOS, just Sideloadly.
2. Connect the device by USB, unlock it, and tap **Trust**.
3. In Sideloadly, sign in with an Apple ID (a spare one is fine), drag in `Aerox-AeroMod.ipa`, and press **Start**. Leave the advanced options alone.
4. On the device: **Settings → General → VPN & Device Management** → trust your Apple ID, and **Settings → Privacy & Security → Developer Mode** → on (the device restarts; the option appears after the first sideloaded app).

Use **Sideloadly for Aerox**. Installing the patched game through iLoader reported success but didn't work in testing.

**It installs as a second copy.** The App Store Aerox stays, and the sideloaded one appears next to it with its own save data. That means it starts with only level 1 unlocked, and TAS finishes never save progress. Use **SETTINGS → UNLOCK ALL LEVELS** once.

### 4. Set up StikDebug (JIT) with iLoader

StikDebug launches an app with a debugger attached ("JIT"), which iOS requires for AeroMod's hooks. It's set up once with **iLoader** on the PC:

1. Download **iLoader** (PC program) and the **StikDebug** `.ipa` from their official pages.
2. In iLoader, sign in with your Apple ID.
3. Import the StikDebug `.ipa` into iLoader and install it.
4. In iLoader, choose **Manage pairing file** and select StikDebug. That puts the device's pairing file inside StikDebug.
5. On the device, install **LocalDevVPN** from the App Store. StikDebug talks to the device's debugging service through this local VPN.

### 5. Launch Aerox through StikDebug

1. Open **LocalDevVPN** and connect.
2. Open **StikDebug** and pick **Aerox** (the sideloaded copy). It launches with JIT and the **AeroMod** pill appears.

Things learned the hard way:

- **Always launch the modded game from StikDebug.** Opened from the Home Screen or Spotlight search, the sideloaded copy runs *without* AeroMod (it looks like a third copy of the game, but it's the same app without JIT). After being closed it can crash on the next plain launch.
- **Don't add it to the Home Screen.** It isn't needed, and removing the icon again makes it easy to delete the app by accident. Deleting it means sideloading it again.
- **The VPN only matters at launch.** Once running, Aerox keeps going if LocalDevVPN disconnects. Launching again needs the VPN connected and StikDebug.

### Every 7 days (free Apple ID)

Apps signed with a free Apple ID stop opening after **7 days**. Re-sign each app **with the tool that installed it**: Sideloadly for Aerox, iLoader for StikDebug. A reinstall with the same tool keeps its data (saves, macros, StikDebug's pairing file). Re-sign both on the same day.

**SideStore (optional)** can do this re-signing on the device, with no PC. It refreshes its apps in the background while LocalDevVPN is connected, and it refreshes itself too. Two catches:

- SideStore can only refresh itself **before** it expires. If it lapses past 7 days, you need the PC again to reinstall it.
- A free Apple ID allows **3 sideloaded apps** at a time: SideStore, StikDebug and Aerox use all three. SideStore can only refresh apps it manages, so to have it handle Aerox, install the patched `.ipa` through SideStore (from the Files app) rather than Sideloadly.

**TrollStore** (iOS 14.0-16.6.1 and 17.0 only) installs apps permanently, with no 7-day limit. Whether AeroMod works there without a debugger hasn't been tested.

If something doesn't work, open an issue with the device, iOS version, what happened, and `aerox-tas/boot.log` from **Files → On My iPhone → Aerox**.
