/**
 * 把截图里的一个矩形区域放大导出 —— 用来把形状看到没有歧义。
 *
 * 用法：node zoom-crop.mjs <输入 png> <输出 png> <x> <y> <w> <h> [放大倍数]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require(
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs",
);

const [, , input, output, xs, ys, ws, hs, scaleS] = process.argv;
if (input === undefined || output === undefined) {
  console.error("用法: node zoom-crop.mjs <输入 png> <输出 png> <x> <y> <w> <h> [放大倍数]");
  process.exit(2);
}
const meta = await sharp(input).metadata();
const x = Math.max(0, Math.round(Number(xs)));
const y = Math.max(0, Math.round(Number(ys)));
const w = Math.min(Math.round(Number(ws)), meta.width - x);
const h = Math.min(Math.round(Number(hs)), meta.height - y);
const scale = Number(scaleS ?? 4);
const out = await sharp(input).extract({ left: x, top: y, width: w, height: h }).resize(w * scale, h * scale, { kernel: "nearest" }).png().toBuffer();
await sharp(out).toFile(output);
console.log(`源 ${meta.width}×${meta.height} → 裁剪 ${w}×${h} @ ${x},${y} → 放大 ${scale}× → ${output}`);
