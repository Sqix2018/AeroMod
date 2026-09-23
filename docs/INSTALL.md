# Installing AeroMod

You need **Aerox 1.9.5**: AeroMod reads that version's memory layout and won't work with others. AeroMod is a script (`dist/aerox-tas.js`) that runs inside the game through **Frida**. The three setups differ only in how Frida gets into the game.

**Which Frida version?** Only setup A cares: the `frida` tools on the PC and Frida on the device must be the same major version (17.x). Setups B and C bundle their own Frida (Gadget 17.18.0), so whatever is or isn't installed on the device doesn't matter.

| Setup | Needs | Status |
|---|---|---|
| A. Jailbroken + PC | Jailbreak, USB cable | Works today |
| B. Jailbroken, no PC | Rootless jailbreak (Dopamine), AeroMod from Sileo | Built, testing on iOS 15.8 |
| C. Not jailbroken | Your own decrypted Aerox IPA, `tools/patch_ipa.py`, Sideloadly, a JIT enabler | Experimental, untested |

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

1. In Sileo (or Zebra), add the source `https://sqix2018.github.io/AeroMod/`.
2. Install **AeroMod**.
3. Open Aerox. AeroMod starts on its own; tap the **AeroMod** pill.

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
- **Rootful jailbreaks** (checkra1n, unc0ver) would need a second build with paths without `/var/jb` and architecture `iphoneos-arm`. That build doesn't exist yet.

**Maintainers:** `python tools/package.py` builds the `.deb` into `packaging/out/` and the repo files into `repo/`, which are published on the `gh-pages` branch.

---

## C. Not jailbroken: sideloading (experimental)

You patch your own copy of the game, install it with Sideloadly, and launch it with JIT enabled. After a one-time setup there's no cable.

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
- refuses an IPA that's still encrypted, and warns if it isn't Aerox 1.9.5.

### 3. Install it with Sideloadly

1. On Windows, install [Sideloadly](https://sideloadly.io) and iTunes. Use the iTunes download from apple.com, not the Microsoft Store version: Sideloadly needs its device drivers. On macOS, just Sideloadly.
2. Connect the device by USB, unlock it, and tap **Trust** when it asks.
3. In Sideloadly, enter an Apple ID. A spare one is fine; it's only used to sign the app.
4. Drag `Aerox-AeroMod.ipa` into Sideloadly and press **Start**. Leave the advanced options at their defaults: the patch is already inside the IPA, so there's nothing to inject.
5. On the device:
   - **Settings → General → VPN & Device Management**: trust your Apple ID's developer profile.
   - iOS 16 and later: **Settings → Privacy & Security → Developer Mode** must be on.

With a free Apple ID the app stops opening after **7 days**. Install it again with Sideloadly; your saves and macros stay. SideStore can re-sign on the device instead, without the PC.

If the App Store version of Aerox is installed, it gets replaced by this one, since both have the same bundle ID. The saved data is kept.

### 4. Launch with JIT enabled

AeroMod doesn't only run a script. It generates native code while it runs and patches a few game functions, and stock iOS only allows that for an app launched **with a debugger attached** ("enabling JIT"). Opened from the home screen, the patched game runs normally but AeroMod's hooks fail. Launch it through a JIT enabler instead:

- **iOS 17.4 and later:** **StikDebug**.
- **Older iOS:** **SideStore**'s "Enable JIT", or **AltStore** with AltServer running on a computer on the same Wi-Fi.

StikDebug and SideStore need a one-time *pairing file* made on a computer; each app's guide covers it. After that, JIT is enabled on the device itself over a local VPN, with no cable: open the JIT app, pick Aerox, and the AeroMod pill appears.

**TrollStore** (iOS 14.0-16.6.1 and 17.0 only) installs apps permanently, with no 7-day limit. Whether AeroMod's hooks work there without a debugger hasn't been tested.

This path is **untested on a real device**. If you try it, please open an issue with your iOS version and what happened: whether the pill appeared, and anything in `Documents/aerox-tas/tas.log`.
