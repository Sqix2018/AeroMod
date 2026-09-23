"""Add AeroMod to your own decrypted Aerox 1.9.5 IPA, for sideloading.

    python tools/patch_ipa.py Aerox.ipa                 # -> Aerox-AeroMod.ipa
    python tools/patch_ipa.py Aerox.ipa -o out.ipa

What it changes (nothing else):

    Payload/Aerox.app/Frameworks/AeroMod.dylib    Frida Gadget (runs the script)
    Payload/Aerox.app/Frameworks/AeroMod.config   "run aerox-tas.js next to me"
    Payload/Aerox.app/Frameworks/aerox-tas.js     AeroMod (dist/aerox-tas.js)
    Payload/Aerox.app/Aerox                        + one LC_LOAD_WEAK_DYLIB for
                                                   @executable_path/Frameworks/AeroMod.dylib
    Payload/Aerox.app/Info.plist                   + Files app sharing, so the game's
                                                   Documents (boot.log, tas.log,
                                                   macros) show in Files -> On My iPhone

The load command is weak, so the game still starts if the dylib is missing.
Signing is left to Sideloadly / SideStore, which re-sign everything anyway.
The IPA must already be decrypted; the script refuses an encrypted one.
"""

import argparse
import json
import os
import plistlib
import struct
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import package  # noqa: E402  (Frida Gadget download/cache lives there)

ROOT = package.ROOT
DYLIB_NAME = 'AeroMod.dylib'
LOAD_PATH = b'@executable_path/Frameworks/' + DYLIB_NAME.encode()

FAT_MAGIC = 0xCAFEBABE
MH_MAGIC_64 = 0xFEEDFACF
LC_SEGMENT_64 = 0x19
LC_ENCRYPTION_INFO_64 = 0x2C
LC_LOAD_DYLIB = 0xC
LC_LOAD_WEAK_DYLIB = 0x80000018


def patch_slice(buf, off):
    """Insert the load command into one 64-bit Mach-O slice at `off` (in place)."""
    magic, cputype, _sub, _ft, ncmds, sizeofcmds, _flags, _res = struct.unpack_from('<IiiIIIII', buf, off)
    if magic != MH_MAGIC_64:
        return 'skipped (not a 64-bit slice)'
    header = 32
    p = off + header
    first_data = None
    for _ in range(ncmds):
        cmd, size = struct.unpack_from('<II', buf, p)
        if cmd == LC_ENCRYPTION_INFO_64:
            cryptid = struct.unpack_from('<I', buf, p + 16)[0]
            if cryptid != 0:
                raise SystemExit('This IPA is still encrypted (cryptid=1). Use a decrypted copy.')
        if cmd in (LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB):
            name_off = struct.unpack_from('<I', buf, p + 8)[0]
            name = bytes(buf[p + name_off:p + size]).split(b'\0')[0]
            if name == LOAD_PATH:
                return 'already patched'
        if cmd == LC_SEGMENT_64:
            nsects = struct.unpack_from('<I', buf, p + 64)[0]
            for s in range(nsects):
                sect_off = struct.unpack_from('<I', buf, p + 72 + s * 80 + 48)[0]
                if sect_off and (first_data is None or sect_off < first_data):
                    first_data = sect_off
        p += size
    name = LOAD_PATH + b'\0'
    cmdsize = (24 + len(name) + 7) & ~7
    end = header + sizeofcmds
    if first_data is None or end + cmdsize > first_data:
        raise SystemExit('Not enough header padding to add the load command.')
    lc = struct.pack('<IIIIII', LC_LOAD_WEAK_DYLIB, cmdsize, 24, 2, 0x10000, 0x10000)
    lc += name + b'\0' * (cmdsize - 24 - len(name))
    if any(buf[off + end:off + end + cmdsize]):
        raise SystemExit('Header padding is not empty; refusing to overwrite it.')
    buf[off + end:off + end + cmdsize] = lc
    struct.pack_into('<II', buf, off + 16, ncmds + 1, sizeofcmds + cmdsize)
    return f'patched (cpu {cputype & 0xff})'


def patch_executable(data):
    buf = bytearray(data)
    magic_be = struct.unpack_from('>I', buf, 0)[0]
    results = []
    if magic_be == FAT_MAGIC:
        n = struct.unpack_from('>I', buf, 4)[0]
        for i in range(n):
            _cpu, _sub, offset, _size, _align = struct.unpack_from('>iiIII', buf, 8 + i * 20)
            results.append(patch_slice(buf, offset))
    else:
        results.append(patch_slice(buf, 0))
    if not any(r.startswith(('patched', 'already')) for r in results):
        raise SystemExit('No 64-bit slice to patch: ' + ', '.join(results))
    return bytes(buf), results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('ipa')
    ap.add_argument('-o', '--output')
    args = ap.parse_args()
    out = args.output or os.path.splitext(args.ipa)[0] + '-AeroMod.ipa'
    script = open(os.path.join(ROOT, 'dist', 'aerox-tas.js'), 'rb').read()
    config = json.dumps({'interaction': {'type': 'script', 'path': 'aerox-tas.js',
                                          'on_change': 'ignore'}}, indent=2).encode()

    src = zipfile.ZipFile(args.ipa)
    info_name = next((n for n in src.namelist()
                      if n.startswith('Payload/') and n.count('/') == 2 and n.endswith('.app/Info.plist')), None)
    if info_name is None:
        raise SystemExit('No Payload/*.app/Info.plist - is this an IPA?')
    app = info_name.rsplit('/', 1)[0] + '/'
    info = plistlib.loads(src.read(info_name))
    if info.get('CFBundleIdentifier') != 'com.synoptical.aerox':
        print(f"warning: bundle id is {info.get('CFBundleIdentifier')}, not com.synoptical.aerox")
    version = info.get('CFBundleShortVersionString')
    if version != '1.9.5':
        print(f'warning: Aerox {version}; AeroMod is built for 1.9.5 and will not work on other versions')
    exe_name = app + info['CFBundleExecutable']
    exe, results = patch_executable(src.read(exe_name))

    # Without a jailbreak there is no Filza: expose Documents in the Files app
    # so boot.log / tas.log / macros can be read and backed up.
    info['UIFileSharingEnabled'] = True
    info['LSSupportsOpeningDocumentsInPlace'] = True
    info_data = plistlib.dumps(info, fmt=plistlib.FMT_BINARY)

    added = {
        app + 'Frameworks/' + DYLIB_NAME: package.gadget(),
        app + 'Frameworks/AeroMod.config': config,
        app + 'Frameworks/aerox-tas.js': script,
    }
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            if item.filename in added:
                continue
            if item.filename == exe_name:
                data = exe
            elif item.filename == info_name:
                data = info_data
            else:
                data = src.read(item.filename)
            dst.writestr(item, data)
        for name, data in added.items():
            zi = zipfile.ZipInfo(name)
            zi.external_attr = (0o100755 if name.endswith('.dylib') else 0o100644) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            dst.writestr(zi, data)
    print(f'{info["CFBundleExecutable"]}: ' + ', '.join(results))
    print(f'wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)')


if __name__ == '__main__':
    main()
