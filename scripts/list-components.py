#!/usr/bin/env python
"""列出原图里所有「非背景连通块」的位置、大小、颜色、亮度 —— 用来决定保留哪些。

为什么需要它：问号在原图里是**独立的一块**（和主角不连通），抠图时按「只留最大块」
就被丢掉了。要决定"保留谁"，先得看清每块在哪、长什么样 —— 不靠猜。

用法：python list-components.py <原图> [--tolerance 40] [--min-area 20]
"""
import argparse
import sys
from collections import deque

import numpy as np
from PIL import Image

sys.path.insert(0, __import__("os").path.dirname(__file__))
from importlib import import_module

_extract = import_module("extract-character".replace("-", "_")) if False else None


def background_mask(rgb, tolerance):
    h, w, _ = rgb.shape
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    lightish = (mx >= 255 - tolerance) & ((mx - mn) <= tolerance)
    visited = np.zeros((h, w), dtype=bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if lightish[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if lightish[y, x] and not visited[y, x]:
                visited[y, x] = True
                q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and lightish[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))
    return visited


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--tolerance", type=int, default=40)
    ap.add_argument("--min-area", type=int, default=20)
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGB")
    rgb = np.asarray(img)
    fg = ~background_mask(rgb, args.tolerance)
    h, w = fg.shape
    label = np.zeros((h, w), dtype=np.int32)
    comps = []
    for sy in range(h):
        for sx in np.flatnonzero(fg[sy] & (label[sy] == 0)):
            if label[sy, sx] != 0:
                continue
            cid = len(comps) + 1
            q = deque([(sy, sx)])
            label[sy, sx] = cid
            pix = []
            while q:
                y, x = q.popleft()
                pix.append((y, x))
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and label[ny, nx] == 0:
                        label[ny, nx] = cid
                        q.append((ny, nx))
            ys = [p[0] for p in pix]
            xs = [p[1] for p in pix]
            colors = rgb[[p[0] for p in pix], [p[1] for p in pix]]
            comps.append({
                "id": cid,
                "area": len(pix),
                "x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys),
                "mean": colors.mean(axis=0),
                "lum": colors.mean(),
            })

    comps = [c for c in comps if c["area"] >= args.min_area]
    comps.sort(key=lambda c: -c["area"])
    print(f"图 {w}x{h}；面积 >= {args.min_area} 的块共 {len(comps)} 个（按面积降序）")
    print(f"{'id':>4} {'面积':>7} {'包围盒':>22} {'中心':>14} {'均色 RGB':>18} {'亮度':>6}")
    for c in comps:
        cx = (c["x0"] + c["x1"]) // 2
        cy = (c["y0"] + c["y1"]) // 2
        mean = tuple(int(v) for v in c["mean"])
        print(
            f"{c['id']:>4} {c['area']:>7} "
            f"x{c['x0']:>4}-{c['x1']:<4} y{c['y0']:>3}-{c['y1']:<4} "
            f"({cx:>4},{cy:>4}) {str(mean):>18} {c['lum']:>6.1f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
