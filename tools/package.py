"""Build the rootless jailbreak package and the Sileo/Cydia repo.

    python tools/package.py            # build packaging/out/*.deb and repo/
    python tools/package.py --version 0.2.0

The .deb installs Frida Gadget as a tweak that loads only into Aerox, plus a
config that makes the gadget run aerox-tas.js from disk at launch. No PC and
no frida-server needed on the device.

    /var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.dylib   Frida Gadget
    /var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.plist   bundle filter
    /var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.config  gadget config
    /var/jb/Library/AeroMod/aerox-tas.js                             the tool

The gadget reads <its own name>.config, so the three files share a name.
Rootless (Dopamine, rootless palera1n) only; architecture iphoneos-arm64.

repo/ is a flat Sileo repo (Packages, Packages.bz2/.gz, Release, debs/) to
publish as the Sqix2018/sqix2018.github.io repo (https://sqix2018.github.io/). Frida Gadget is downloaded once into
packaging/cache/ (not committed).
"""

import argparse
import bz2
import gzip
import hashlib
import io
import json
import lzma
import os
import shutil
import ssl
import tarfile
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRIDA_VERSION = '17.18.0'
GADGET_URL = ('https://github.com/frida/frida/releases/download/{v}/'
              'frida-gadget-{v}-ios-universal.dylib.xz')
PACKAGE_ID = 'com.sqix2018.aeromod'
NAME = 'AeroMod'
ARCH = 'iphoneos-arm64'
PREFIX = 'var/jb'
TWEAK_DIR = PREFIX + '/Library/MobileSubstrate/DynamicLibraries'
SCRIPT_PATH = '/' + PREFIX + '/Library/AeroMod/aerox-tas.js'
REPO_URL = 'https://sqix2018.github.io/'


CERT_HELP = '''
Could not download Frida Gadget: this Python can't verify HTTPS certificates.
Common with the python.org installer on macOS. Fix it once, then run again:

    /Applications/Python\\ 3.XX/Install\\ Certificates.command     (use your version)
or
    python3 -m pip install --upgrade certifi

Or download {name} yourself from
    {url}
and pass it with --gadget path/to/{name}
'''


def fetch(url):
    try:
        with urllib.request.urlopen(url) as r:
            return r.read()
    except urllib.error.URLError as err:
        if 'CERTIFICATE_VERIFY_FAILED' not in str(err):
            raise
    # python.org's macOS build ships without the system certificates. certifi
    # has them, if it is installed.
    try:
        import certifi
    except ImportError:
        raise SystemExit(CERT_HELP.format(url=url, name=url.rsplit('/', 1)[1]))
    ctx = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(url, context=ctx) as r:
        return r.read()


def gadget(local=None):
    """Frida Gadget dylib bytes. `local` may be a .dylib or the release .xz."""
    if local:
        data = open(local, 'rb').read()
        return lzma.decompress(data) if local.endswith('.xz') else data
    cache = os.path.join(ROOT, 'packaging', 'cache')
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f'FridaGadget-{FRIDA_VERSION}.dylib')
    if not os.path.exists(path):
        url = GADGET_URL.format(v=FRIDA_VERSION)
        print('downloading', url)
        data = lzma.decompress(fetch(url))
        with open(path, 'wb') as f:
            f.write(data)
    return open(path, 'rb').read()


def tar_gz(entries):
    """entries: list of (path, bytes or None for a dir, mode)."""
    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode='w:gz', format=tarfile.GNU_FORMAT) as t:
        for path, data, mode in entries:
            info = tarfile.TarInfo('./' + path if path else '.')
            info.mtime = now
            info.uid = info.gid = 0
            info.uname = info.gname = 'root'
            info.mode = mode
            if data is None:
                info.type = tarfile.DIRTYPE
                t.addfile(info)
            else:
                info.size = len(data)
                t.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def ar(members):
    out = io.BytesIO()
    out.write(b'!<arch>\n')
    now = int(time.time())
    for name, data in members:
        header = (f'{name:<16}{now:<12}{0:<6}{0:<6}{0o100644:<8o}{len(data):<10}`\n').encode()
        out.write(header)
        out.write(data)
        if len(data) % 2:
            out.write(b'\n')
    return out.getvalue()


# Frida ships the gadget signed with its own Apple certificate. Dopamine only
# loads ad-hoc (ldid) signed tweaks - the cert-signed gadget failed dlopen with
# "code signature invalid". Re-sign it on the device at install time.
POSTINST = (
    '#!/bin/sh\n'
    'DYLIB=/var/jb/Library/MobileSubstrate/DynamicLibraries/AeroMod.dylib\n'
    'LDID=/var/jb/usr/bin/ldid\n'
    '[ -x "$LDID" ] || LDID="$(command -v ldid)"\n'
    'if [ -z "$LDID" ]; then echo "AeroMod: ldid not found"; exit 1; fi\n'
    '"$LDID" -S "$DYLIB" || { echo "AeroMod: ldid -S failed"; exit 1; }\n'
    'echo "AeroMod: gadget re-signed (ad-hoc)"\n'
    'exit 0\n'
).encode()


def control_text(version, size_kb):
    return (
        f'Package: {PACKAGE_ID}\n'
        f'Name: {NAME}\n'
        f'Version: {version}\n'
        f'Architecture: {ARCH}\n'
        'Description: TAS and practice toolkit for Aerox 1.9.5. Frame-exact macros, '
        'rewind, splits, teleport, virtual tilt and death-warp tools. Runs on launch '
        f'through Frida Gadget {FRIDA_VERSION}; no PC needed.\n'
        'Maintainer: Sqix2018\n'
        'Author: Sqix2018\n'
        'Section: Tweaks\n'
        'Depends: mobilesubstrate, ldid\n'
        f'Installed-Size: {size_kb}\n'
        'Homepage: https://github.com/Sqix2018/AeroMod\n'
    )


def build_deb(version, local_gadget=None):
    script = open(os.path.join(ROOT, 'dist', 'aerox-tas.js'), 'rb').read()
    dylib = gadget(local_gadget)
    config = json.dumps({
        'interaction': {'type': 'script', 'path': SCRIPT_PATH, 'on_change': 'ignore'},
    }, indent=2).encode()
    plist = b'{ Filter = { Bundles = ( "com.synoptical.aerox" ); }; }\n'
    dirs = ['var', PREFIX, PREFIX + '/Library', PREFIX + '/Library/MobileSubstrate', TWEAK_DIR,
            PREFIX + '/Library/AeroMod']
    files = [
        (TWEAK_DIR + '/AeroMod.dylib', dylib, 0o755),
        (TWEAK_DIR + '/AeroMod.plist', plist, 0o644),
        (TWEAK_DIR + '/AeroMod.config', config, 0o644),
        (SCRIPT_PATH.lstrip('/'), script, 0o644),
    ]
    data = tar_gz([('', None, 0o755)] + [(d, None, 0o755) for d in dirs] + files)
    size_kb = sum(len(f[1]) for f in files) // 1024 + 1
    control = tar_gz([('', None, 0o755),
                      ('control', control_text(version, size_kb).encode(), 0o644),
                      ('postinst', POSTINST, 0o755)])
    deb = ar([('debian-binary', b'2.0\n'), ('control.tar.gz', control), ('data.tar.gz', data)])
    out = os.path.join(ROOT, 'packaging', 'out')
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, f'{PACKAGE_ID}_{version}_{ARCH}.deb')
    open(path, 'wb').write(deb)
    print('built', path, f'{len(deb) / 1e6:.1f} MB')
    return path, control_text(version, size_kb)


def build_repo(debs):
    repo = os.path.join(ROOT, 'repo')
    os.makedirs(os.path.join(repo, 'debs'), exist_ok=True)
    stanzas = []
    for path, control in debs:
        name = os.path.basename(path)
        shutil.copyfile(path, os.path.join(repo, 'debs', name))
        data = open(path, 'rb').read()
        stanzas.append(control.rstrip('\n') + '\n'
                       f'Filename: debs/{name}\n'
                       f'Size: {len(data)}\n'
                       f'MD5sum: {hashlib.md5(data).hexdigest()}\n'
                       f'SHA256: {hashlib.sha256(data).hexdigest()}\n'
                       f'Depiction: https://github.com/Sqix2018/AeroMod\n')
    packages = '\n'.join(stanzas).encode()
    open(os.path.join(repo, 'Packages'), 'wb').write(packages)
    open(os.path.join(repo, 'Packages.bz2'), 'wb').write(bz2.compress(packages))
    open(os.path.join(repo, 'Packages.gz'), 'wb').write(gzip.compress(packages))
    release = ('Origin: AeroMod\nLabel: AeroMod\nSuite: stable\nVersion: 1.0\nCodename: aeromod\n'
               f'Architectures: {ARCH}\nComponents: main\n'
               'Description: AeroMod - TAS toolkit for Aerox\n')
    sums = {'MD5Sum': hashlib.md5, 'SHA256': hashlib.sha256}
    for label, fn in sums.items():
        release += f'{label}:\n'
        for f in ('Packages', 'Packages.bz2', 'Packages.gz'):
            d = open(os.path.join(repo, f), 'rb').read()
            release += f' {fn(d).hexdigest()} {len(d)} {f}\n'
    open(os.path.join(repo, 'Release'), 'w', newline='\n').write(release)
    open(os.path.join(repo, 'index.html'), 'w', encoding='utf-8').write(
        '<!doctype html><title>AeroMod repo</title>'
        f'<p>Sileo / Zebra repo for AeroMod. Add <code>{REPO_URL}</code> as a source.'
        '<p><a href="https://github.com/Sqix2018/AeroMod">Project page</a>\n')
    # GitHub Pages would hide files it treats as Jekyll; serve everything as-is.
    open(os.path.join(repo, '.nojekyll'), 'w').close()
    print('repo ready in', repo)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--version', default=json.load(open(os.path.join(ROOT, 'package.json')))['version'])
    ap.add_argument('--gadget', help='use this Frida Gadget (.dylib or .xz) instead of downloading')
    args = ap.parse_args()
    build_repo([build_deb(args.version, args.gadget)])


if __name__ == '__main__':
    main()
