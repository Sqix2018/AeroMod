"""Aerox .scn reader (layout from synScene initWithContentsFromDatastream:).

  u32 nMaterials, then nMaterials x (u32 size, bytes)
  u32 nModels
  u32 n, n x u32
  u32 nUnique, u32 nInst, nInst x u32
  u32 nInst2, nInst2 x (u32 index, 5 flag bytes)
  nModels x (u32 size, model bytes)
"""
import struct
import sys


def u32(d, o):
    return struct.unpack_from('<I', d, o)[0]


def models(path):
    d = open(path, 'rb').read()
    o = 0
    n = u32(d, o); o += 4
    for _ in range(n):
        o += 4 + u32(d, o)
    n_models = u32(d, o); o += 4
    n = u32(d, o); o += 4 + 4 * n
    n_unique = u32(d, o); o += 4
    n_inst = u32(d, o); o += 4 + 4 * n_inst
    n_inst2 = u32(d, o); o += 4 + 9 * n_inst2
    out = []
    for i in range(n_models):
        size = u32(d, o)
        out.append((i, o + 4, d[o + 4:o + 4 + size], i >= n_unique))
        o += 4 + size
    return out, o == len(d), len(d) - o


def name_of(blob):
    ln = blob[0]
    return blob[1:1 + ln].split(b'\0')[0].decode('latin1', 'replace')


if __name__ == '__main__':
    ms, exact, left = models(sys.argv[1])
    print(f'{len(ms)} models, parsed to end: {exact} (left {left})')
    for i, off, blob, inst in ms:
        print(i, hex(off), len(blob), 'inst' if inst else '', repr(blob[:48]))
