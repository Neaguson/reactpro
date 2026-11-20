"""Gera os ícones PNG do ReactPro sem dependências externas.
Uso: python tools/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

BG = (11, 11, 12)
GOLD = (201, 169, 97)
OUT = Path(__file__).resolve().parent.parent / "icons"


def png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


def inside_tri(x, y, a, b, c):
    def s(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])
    d1, d2, d3 = s((x, y), a, b), s((x, y), b, c), s((x, y), c, a)
    neg = d1 < 0 or d2 < 0 or d3 < 0
    pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (neg and pos)


def render(size, scale_art, rounded):
    ss = 3
    rows = []
    cx = cy = 0.5
    ring_r = 0.30 * scale_art
    ring_w = 0.035 * scale_art
    tri = [(0.5 - 0.085 * scale_art, 0.5 - 0.135 * scale_art),
           (0.5 - 0.085 * scale_art, 0.5 + 0.135 * scale_art),
           (0.5 + 0.145 * scale_art, 0.5)]
    corner = 0.22
    for py in range(size):
        row = []
        for px in range(size):
            acc_bg = acc_gold = 0
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    inbox = True
                    if rounded:
                        qx = min(x, 1 - x); qy = min(y, 1 - y)
                        if qx < corner and qy < corner:
                            inbox = math.hypot(corner - qx, corner - qy) <= corner
                    if not inbox:
                        continue
                    d = math.hypot(x - cx, y - cy)
                    if abs(d - ring_r) <= ring_w / 2 or inside_tri(x, y, *tri):
                        acc_gold += 1
                    else:
                        acc_bg += 1
            n = ss * ss
            a = (acc_bg + acc_gold) / n
            if a == 0:
                row += [0, 0, 0, 0]
                continue
            g = acc_gold / (acc_bg + acc_gold)
            col = [round(BG[i] * (1 - g) + GOLD[i] * g) for i in range(3)]
            row += col + [round(a * 255)]
        rows.append(row)
    return rows


OUT.mkdir(exist_ok=True)
for name, size, art, rounded in [
    ("icon-192.png", 192, 1.0, False),
    ("icon-512.png", 512, 1.0, False),
    ("icon-180.png", 180, 1.0, False),
    ("maskable-512.png", 512, 0.78, False),
]:
    png(OUT / name, size, size, render(size, art, rounded))
    print("ok", name)
