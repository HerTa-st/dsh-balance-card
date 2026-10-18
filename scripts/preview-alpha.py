#!/usr/bin/env python
"""把透明 PNG 叠在棋盘格上预览 —— 用来确认「透明底」是真的。

白色页面会把透明区域渲染成白色，于是看起来像"白底图"。
棋盘格是行业通用的透明指示，一眼就能区分「图里有白底」与「透明叠在白底上」。

同时出一张「深色主题下」的预览，用来判断人物在暗背景上是否还看得清。

用法：python preview-alpha.py <输入透明 png> [--out 前缀] [--height 264]
"""
import argparse
import sys

import numpy as np
from PIL import Image, ImageDraw


def checkerboard(size, cell=12, light=(255, 255, 255), dark=(214, 214, 214)):
    w, h = size
    board = Image.new("RGB", size, light)
    draw = ImageDraw.Draw(board)
    for y in range(0, h, cell):
        for x in range(0, w, cell):
            if ((x // cell) + (y // cell)) % 2 == 1:
                draw.rectangle([x, y, x + cell - 1, y + cell - 1], fill=dark)
    return board


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=None, help="输出前缀；默认与输入同目录同主名")
    ap.add_argument("--height", type=int, default=264, help="预览里人物的高度")
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGBA")
    if img.height != args.height:
        scale = args.height / img.height
        img = img.resize((max(1, round(img.width * scale)), args.height), Image.LANCZOS)

    prefix = args.out or args.src.rsplit(".", 1)[0]
    pad = 16

    # 1) 棋盘格（浅）
    canvas = checkerboard((img.width + pad * 2, img.height + pad * 2))
    canvas.paste(img, (pad, pad), img)
    light_path = f"{prefix}-preview-checker.png"
    canvas.save(light_path)
    print(f"写出 {light_path}（棋盘格＝透明）")

    # 2) 深色底（黑塔主题那种暗紫底），看人物在暗背景上是否还清楚
    dark_canvas = Image.new("RGB", (img.width + pad * 2, img.height + pad * 2), (23, 19, 29))
    dark_canvas.paste(img, (pad, pad), img)
    dark_path = f"{prefix}-preview-dark.png"
    dark_canvas.save(dark_path)
    print(f"写出 {dark_path}（深色底）")

    # 3) 顺手把 alpha 分布打成一行数字，便于写报告
    a = np.asarray(Image.open(args.src).convert("RGBA"))[:, :, 3]
    print(f"alpha 统计：全透明 {(a == 0).mean() * 100:.1f}%，全不透明 {(a == 255).mean() * 100:.1f}%，"
          f"半透明 {((a > 0) & (a < 255)).mean() * 100:.1f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
