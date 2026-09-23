"""Bake exact death-warp zones for every level from the game's .scn files.

Per model blob: name (len byte + chars), position at name_end + 40 (3 floats,
game axes), mesh vertices (3 floats each, 3ds Max axes) for non-instanced
models. Max -> game axes: game x = max y, game y = max z, game z = max x.
Checked on L10: EndFlare at (22, 20.13, 90), local y +-1.5, x 0 ->
Bullet box x 20.45.., z 89.95.. which is the live arm-check zone
(x >= 19.4, z >= 88.9 with pad 1.05).

Zone rule (warppredict.zoneFor): per axis, pad = ball r (1) + margin 0.05,
spawn inside [EF.min - pad, EF.max + pad] -> any; above -> death <= max+pad;
below -> death >= min-pad. Height: EF.min.y <= spawn.y + pad.

Writes src/tas/warpzones-data.js.
"""
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(__file__))
import scn  # noqa: E402

APP = r'C:/AeroxDump/com.synoptical.aerox_370532221_1.9.5/Payload/Aerox.app'
OUT = os.path.join(os.path.dirname(__file__), '..', 'src', 'tas', 'warpzones-data.js')
MARGIN = 0.05       # Bullet collision margin on the trigger's box
START_LIFT = 1.5    # loadLevel: spawn = StartPoint + 1.5 y
CP_LIFT = 4.0       # CheckPoint spawn = CheckPoint + (0, 4, 0) (RVA 0x1e0fd0)
BALL_R = 1.0
WORLD = 240
MOVABLE = re.compile(r'plank|crate|barrel|box|ball(?!oon)|log|block|domino|rock|pipe', re.I)


def pos_of(blob):
    n = blob[0] + 1
    return list(struct.unpack_from('<3f', blob, n + 40))


def verts_of(blob):
    """Longest run of plausible float triples after the header."""
    n = blob[0] + 1
    best = []
    for start in range(n + 44, min(len(blob), n + 140)):
        vs = []
        o = start
        while o + 12 <= len(blob):
            v = struct.unpack_from('<3f', blob, o)
            if not all(abs(x) < 200 and (x == 0 or abs(x) > 1e-6) for x in v):
                break
            vs.append(v)
            o += 12
        if len(vs) > len(best):
            best = vs
    return best


def game_box(local):
    xs = [v[1] for v in local]
    ys = [v[2] for v in local]
    zs = [v[0] for v in local]
    return [min(xs), min(ys), min(zs)], [max(xs), max(ys), max(zs)]


def axis(s, lo, hi):
    if lo <= s <= hi:
        return None, None, 'any'
    if s > hi:
        return None, hi, f'<= {hi:.1f}'
    return lo, None, f'>= {lo:.1f}'


def level_files():
    out = []
    for f in os.listdir(APP):
        m = re.match(r'Level(\d{3})\.scn$', f)
        if m:
            out.append((int(m.group(1)), os.path.join(APP, f)))
    return sorted(out)


def main():
    ef_local = None
    levels = {}
    for lv, path in level_files():
        ms, _, _ = scn.models(path)
        byname = {}
        for i, off, blob, inst in ms:
            byname.setdefault(scn.name_of(blob), []).append((blob, inst))
        ef = byname.get('EndFlare')
        sp = byname.get('StartPoint')
        if not ef or not sp:
            levels[lv] = {'error': 'no EndFlare/StartPoint'}
            continue
        blob, inst = ef[0]
        if not inst and ef_local is None:
            # EndFlare: 36 verts right after its 89-byte header (same mesh,
            # no rotation, in every level; checked 1-40).
            n = blob[0] + 1
            vs = [struct.unpack_from('<3f', blob, n + 89 + 12 * k) for k in range(36)]
            ef_local = game_box(vs)
        levels[lv] = {'_ef': (pos_of(blob), inst), '_sp': pos_of(sp[0][0]),
                      '_cp': [(nm, pos_of(b)) for nm, lst in byname.items()
                              if re.match(r'CheckPoint', nm) for b, _ in lst],
                      '_mov': sorted(nm for nm in byname if MOVABLE.search(nm))}
    if ef_local is None:
        sys.exit('no EndFlare mesh found')
    lo_l, hi_l = ef_local
    data = {}
    for lv, v in sorted(levels.items()):
        if 'error' in v:
            data[lv] = v
            continue
        p, _ = v['_ef']
        mi = [p[i] + lo_l[i] - MARGIN for i in range(3)]
        mx = [p[i] + hi_l[i] + MARGIN for i in range(3)]
        spawns = [{'name': 'start', 'cp': False, 'p': [v['_sp'][0], v['_sp'][1] + START_LIFT, v['_sp'][2]]}]
        for nm, c in sorted(v['_cp']):
            spawns.append({'name': nm, 'cp': True, 'p': [c[0], c[1] + CP_LIFT, c[2]]})
        pad = BALL_R + MARGIN
        layers = []
        for s in spawns:
            x0, x1, tx = axis(s['p'][0], mi[0] - pad, mx[0] + pad)
            z0, z1, tz = axis(s['p'][2], mi[2] - pad, mx[2] + pad)
            ok = mi[1] <= s['p'][1] + pad
            layers.append({
                'name': s['name'], 'cp': s['cp'], 'spawn': [round(x, 3) for x in s['p']], 'ok': ok,
                'over': round(mi[1] - (s['p'][1] + pad), 1),
                'rect': {'minX': x0 if x0 is not None else -WORLD, 'maxX': x1 if x1 is not None else WORLD,
                         'minZ': z0 if z0 is not None else -WORLD, 'maxZ': z1 if z1 is not None else WORLD},
                'text': f'x {tx}, z {tz}',
            })
        data[lv] = {'ef': {'mi': [round(x, 3) for x in mi], 'mx': [round(x, 3) for x in mx]},
                    'movables': v['_mov'], 'layers': layers}
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('// Generated by tools/scn_zones.py from the game\'s LevelNNN.scn files.\n')
        f.write('// Exact EndFlare boxes and spawn points; see that script for the rule.\n')
        f.write('module.exports = ')
        json.dump({str(k): v for k, v in data.items()}, f, separators=(',', ':'))
        f.write(';\n')
    for lv, v in sorted(data.items()):
        if 'error' in v:
            print(f'L{lv}: {v["error"]}')
            continue
        parts = [f"{l['name']}: {'ZONE ' + l['text'] if l['ok'] else 'none (EF %.1fu high)' % l['over']}"
                 for l in v['layers']]
        print(f"L{lv} mov {len(v['movables'])}  " + '  |  '.join(parts))


if __name__ == '__main__':
    main()
