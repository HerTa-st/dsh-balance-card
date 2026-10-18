/**
 * 从这张图里裁出几个候选头像，用于给卡片按钮选图标。
 *
 * 用法：node make-icon.mjs <原图> <输出目录>
 * 输出 `<输出目录>/cand-1..N.png`（各 144×144）与一张带网格的对照图。
 */
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const sharp = require(
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs",
);

const src = process.argv[2];
const outDir = process.argv[3];
if (src === undefined || outDir === undefined) {
  console.error("用法: node make-icon.mjs <原图> <输出目录>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

/**
 * 候选裁剪：{left, top, width, height}（原图坐标），输出正方形。
 *
 * 坐标是**看着 overlay.png 量出来的**，不是估的：
 *   脸的眼睛大约在 y≈205–225、脸宽 x≈180–290、下巴到 y≈272；
 *   巫师帽大约 y≈85–195。第一版候选全偏高了（框落在眼睛以上），这是修正后的。
 */
const CANDIDATES = [
  { name: "cand-1-eyes", left: 182, top: 190, width: 82, height: 82 },
  { name: "cand-2-face", left: 176, top: 184, width: 100, height: 92 },
  { name: "cand-3-face-hat", left: 170, top: 170, width: 124, height: 108 },
  { name: "cand-4-head", left: 162, top: 156, width: 134, height: 122 },
  { name: "cand-5-hat", left: 168, top: 96, width: 128, height: 128 },
  { name: "cand-6-full", left: 150, top: 150, width: 146, height: 129 },
];

/** 把裁剪框夹进图内（脸贴右边缘，不夹就会 `extract_area: bad extract area`）。 */
function clampToImage(crop, meta) {
  const width = Math.min(crop.width, meta.width);
  const height = Math.min(crop.height, meta.height);
  const left = Math.max(0, Math.min(crop.left, meta.width - width));
  const top = Math.max(0, Math.min(crop.top, meta.height - height));
  return { ...crop, left, top, width, height };
}

const SIZE = 144;
const meta = await sharp(src).metadata();
const written = [];
for (const raw of CANDIDATES) {
  const c = clampToImage(raw, meta);
  const out = join(outDir, `${c.name}.png`);
  await sharp(src)
    .extract({ left: c.left, top: c.top, width: c.width, height: c.height })
    .resize(SIZE, SIZE, { kernel: "lanczos3", fit: "cover" })
    .png()
    .toFile(out);
  written.push({ ...c, out });
  console.log(`写出 ${c.name}.png  extract(${c.left},${c.top},${c.width},${c.height})`);
}

// 对照图：把原图放大 2 倍并画上候选框，方便肉眼确认坐标对不对
const { width, height } = meta;
const svg = `<svg width="${width * 2}" height="${height * 2}">
${CANDIDATES.map((raw, i) => {
  const c = clampToImage(raw, meta);
  return (
    `<rect x="${c.left * 2}" y="${c.top * 2}" width="${c.width * 2}" height="${c.height * 2}" fill="none" stroke="#ff3b7f" stroke-width="2"/>` +
    `<text x="${c.left * 2 + 4}" y="${c.top * 2 + 18}" font-size="16" fill="#ff3b7f" font-family="sans-serif">${i + 1}</text>`
  );
}).join("")}
</svg>`;
const base = await sharp(src).resize(width * 2, height * 2, { kernel: "lanczos3" }).png().toBuffer();
writeFileSync(join(outDir, "overlay.png"), await sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer());
console.log(`写出 overlay.png（原图 2× + 候选框编号）`);
