#!/usr/bin/env python
"""把角色从原图里抠出来，做成可当按钮用的透明 PNG（**问号一起带上**）。

## 为什么需要专门的抠图步骤

用户要的是「直接把图里的角色扣出来当按钮」，不是圆形裁切。原图里除了主角还有几样东西，
用连通块把它们分开了（`scripts/list-components.py` 会把每块的位置/颜色/亮度列出来）：

| 块 | 是什么 | 处理 |
|---|---|---|
| 主角（最大块） | 黑塔本人 | **保留** |
| 问号（紫色，**分成两块**：弯钩 + 下面的点） | 用户要的，属于按钮的一部分 | **保留** |
| 左侧淡色残影（很亮，亮度 ≈198） | 原画的水印式重复人物 | 丢掉 |
| 顶部若干细碎亮块 | 纸张纹理/噪点 | 丢掉 |

## 判定规则（不是拍脑袋，是照着上表量出来的）

1. **主角**：面积最大的连通块。
2. **问号**：**紫调**块（`B - R >= 20` 且足够饱和）且离左边足够远。
   - 紫色判据把问号（均色 `(146,119,202)`，B-R=56）与残影（`(201,193,198)`，B-R=-3）分开；
   - 「离左边远」把问号与残影里可能出现的紫调细节分开；
   - 面积门槛滤掉抗锯齿产生的碎点。
3. 其余一律丢掉。

## 做法

从图像四边 flood fill 标出背景 → 找非背景连通块 → 按上面的规则保留主角 + 问号 →
对保留部分的并集取包围盒 → 边缘轻微羽化 → 输出带 alpha 的 PNG。

用法：
  python extract-character.py <原图> <输出 png> [--tolerance 40] [--margin 3]
"""
import argparse
import os
import sys
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

MAX_DIM = 1600  # 太大的图先缩，flood fill 与连通域都是 O(N)

# ── 保留规则的可调参数（默认值来自 list-components.py 的实测） ──
# MIN_KEEP_AREA=25：问号由 3 块组成（1080 / 179 / 37 像素），最小那块 37；
# 门槛要比它小，否则问号会缺一角（试过 40，把 37 那块挡掉了）。
MIN_KEEP_AREA = 25        # 保留块的最小面积（滤掉抗锯齿碎点）
PURPLE_B_MINUS_R = 18     # 紫调判据：蓝通道比红通道高出这么多
PURPLE_SATURATION = 10    # 紫调判据：通道极差至少这么大
FAR_FROM_LEFT = 40        # 保留块必须离左边这么远（把残影所在区域排除）


def background_mask(rgb: np.ndarray, tolerance: int) -> np.ndarray:
    """从四边 flood fill，标出与边缘连通的浅色背景。"""
    h, w, _ = rgb.shape
    # 「浅」：三通道都亮，且通道间差异小（白/浅灰）
    mx = rgb.max(axis=2).astype(np.int16)
    mn = rgb.min(axis=2).astype(np.int16)
    lightish = (mx >= 255 - tolerance) & ((mx - mn) <= tolerance)

    visited = np.zeros((h, w), dtype=bool)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if lightish[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if lightish[y, x] and not visited[y, x]:
                visited[y, x] = True
                queue.append((y, x))

    while queue:
        y, x = queue.popleft()
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and lightish[ny, nx]:
                visited[ny, nx] = True
                queue.append((ny, nx))
    return visited


def components(fg: np.ndarray):
    """找出 fg 里所有 4 邻域连通块。

    返回 `[{id, area, x0, x1, y0, y1, mean_rgb}]`，按面积降序。
    用 8 邻域会把细线连成一片（纸张纹理就会爬进来），所以用 4 邻域。
    """
    h, w = fg.shape
    label = np.zeros((h, w), dtype=np.int32)
    out = []
    for sy in range(h):
        for sx in np.flatnonzero(fg[sy] & (label[sy] == 0)):
            if label[sy, sx] != 0:
                continue
            cid = len(out) + 1
            q = deque([(sy, sx)])
            label[sy, sx] = cid
            xs = []
            ys = []
            while q:
                y, x = q.popleft()
                ys.append(y)
                xs.append(x)
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and label[ny, nx] == 0:
                        label[ny, nx] = cid
                        q.append((ny, nx))
            out.append({
                "id": cid,
                "area": len(ys),
                "x0": min(xs), "x1": max(xs),
                "y0": min(ys), "y1": max(ys),
                "ys": ys, "xs": xs,
            })
    out.sort(key=lambda c: -c["area"])
    return label, out


def is_purple(rgb: np.ndarray, comp) -> bool:
    """块是否紫调 —— 问号的判据。

    只看块的均色：问号均色 (146,119,202)，B-R=56、极差 83；
    残影均色 (201,193,198)，B-R=-3、极差 8 —— 差异极大，阈值取中间很安全。
    """
    colors = rgb[comp["ys"], comp["xs"]].mean(axis=0)
    b_minus_r = colors[2] - colors[0]
    spread = colors.max() - colors.min()
    return b_minus_r >= PURPLE_B_MINUS_R and spread >= PURPLE_SATURATION


def keep_mask(rgb: np.ndarray, fg: np.ndarray, verbose: bool = True):
    """按规则挑出要保留的像素：主角（最大块）+ 紫调且离左边够远的块（问号）。"""
    h, w = fg.shape
    _label, comps = components(fg)
    if len(comps) == 0:
        return np.zeros((h, w), dtype=bool), []

    kept = np.zeros((h, w), dtype=bool)
    decisions = []

    # 1) 主角：面积最大的那块
    hero = comps[0]
    kept[hero["ys"], hero["xs"]] = True
    decisions.append((hero, True, "主角（最大块）"))

    # 2) 问号：紫调 + 足够大 + 离左边够远
    for comp in comps[1:]:
        if comp["area"] < MIN_KEEP_AREA:
            decisions.append((comp, False, f"太小（{comp['area']} < {MIN_KEEP_AREA}）"))
            continue
        if comp["x0"] < FAR_FROM_LEFT:
            decisions.append((comp, False, f"太靠左（x0={comp['x0']} < {FAR_FROM_LEFT}）"))
            continue
        if not is_purple(rgb, comp):
            colors = rgb[comp["ys"], comp["xs"]].mean(axis=0)
            decisions.append((comp, False, f"不是紫调（均色 {tuple(int(v) for v in colors)}）"))
            continue
        kept[comp["ys"], comp["xs"]] = True
        colors = rgb[comp["ys"], comp["xs"]].mean(axis=0)
        decisions.append((comp, True, f"问号（紫调，均色 {tuple(int(v) for v in colors)}）"))

    if verbose:
        print(f"连通块 {len(comps)} 个；决策（按面积降序）：")
        for comp, yes, why in decisions[:12]:
            mark = "保留" if yes else "丢弃"
            print(f"  {mark} id={comp['id']:>4} 面积 {comp['area']:>6} "
                  f"x{comp['x0']}-{comp['x1']} y{comp['y0']}-{comp['y1']} —— {why}")
        if len(decisions) > 12:
            print(f"  …另有 {len(decisions) - 12} 块，全部丢弃")
    return kept, decisions


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--tolerance", type=int, default=40)
    ap.add_argument("--margin", type=int, default=3)
    ap.add_argument("--feather", type=float, default=0.8)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    img = Image.open(args.src).convert("RGB")
    if max(img.size) > MAX_DIM:
        scale = MAX_DIM / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    rgb = np.asarray(img)

    bg = background_mask(rgb, args.tolerance)
    fg = ~bg
    print(f"原图 {img.width}x{img.height}；背景像素 {bg.sum()}，前景 {fg.sum()}")

    kept, _decisions = keep_mask(rgb, fg, verbose=not args.quiet)
    if kept.sum() == 0:
        print("没有任何块被保留", file=sys.stderr)
        return 3
    print(f"保留像素 {kept.sum()}，占前景 {kept.sum() / max(1, fg.sum()):.1%}")

    ys, xs = np.where(kept)
    y0, y1 = max(0, ys.min() - args.margin), min(rgb.shape[0] - 1, ys.max() + args.margin)
    x0, x1 = max(0, xs.min() - args.margin), min(rgb.shape[1] - 1, xs.max() + args.margin)
    print(f"包围盒 x {x0}-{x1}, y {y0}-{y1}（{x1 - x0 + 1}x{y1 - y0 + 1}）")

    alpha = Image.fromarray((kept * 255).astype(np.uint8))
    if args.feather > 0:
        # 轻微模糊边缘，消锯齿
        alpha = alpha.filter(ImageFilter.GaussianBlur(args.feather))

    # 1) 裁到包围盒
    cut = img.crop((x0, y0, x1 + 1, y1 + 1)).convert("RGBA")
    cut.putalpha(alpha.crop((x0, y0, x1 + 1, y1 + 1)))
    cut.save(args.dst)
    print(f"写出 {args.dst}（{cut.width}x{cut.height}，带 alpha）")

    # 2) 同时出一份**不裁剪**的透明全图 —— 便于肉眼核对"留下了什么、丢掉了什么"
    full = img.convert("RGBA")
    full.putalpha(alpha)
    full_path = os.path.join(os.path.dirname(args.dst), "character-full.png")
    full.save(full_path)
    print(f"写出 {full_path}（{full.width}x{full.height}，未裁剪，用于核对取舍）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
