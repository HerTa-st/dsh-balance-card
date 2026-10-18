/**
 * 把一张截图按像素打成字符图 —— 用来**直接看到**目标在哪，而不是猜坐标。
 *
 * 分类：
 *   `.` 接近白（页面/卡片底色）
 *   `T` 中性灰（界面文字，三通道接近且偏暗）
 *   `D` 紫调（圆点里的图）
 *   `#` 其他（深色帽子、边界等）
 *
 * 用法：node ascii-map.mjs <截图> [每格像素数，默认 2]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require(
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs",
);

const file = process.argv[2];
const step = Number(process.argv[3] ?? 2);
if (file === undefined) {
  console.error("用法: node ascii-map.mjs <截图> [每格像素数]");
  process.exit(2);
}

const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const px = (x, y) => {
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};

console.log(`图 ${info.width}×${info.height}，每格 ${step}px；列头是 x 坐标（每 10 格标一个数字）`);

// 列头
let header = "    ";
for (let x = 0; x < info.width; x += step) header += x % 20 === 0 ? String(Math.floor(x / 10) % 10) : " ";
console.log(header);

for (let y = 0; y < info.height; y += step) {
  let line = String(y).padStart(3, " ") + " ";
  for (let x = 0; x < info.width; x += step) {
    const [r, g, b] = px(x, y);
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    let ch;
    if (mx > 240 && mx - mn < 12) ch = ".";
    else if (b - r > 15) ch = "D";
    else if (mx - mn < 25) ch = "T";
    else ch = "#";
    line += ch;
  }
  console.log(line);
}
