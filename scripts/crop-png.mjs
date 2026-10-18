/**
 * 按给定矩形裁剪一张 PNG（用 DSH 自带的 sharp，不额外装东西）。
 *
 * 用法：node crop-png.mjs <输入 png> <输出 png> <x> <y> <宽> <高> [放大倍数]
 */
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const require = createRequire(import.meta.url);
// 注意：profile 里的 sharp 是指向不存在路径的**断链 junction**，不能用。
// 这里用 dsh-017 那份可读副本里的实体 sharp。
const SHARP =
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs";

const [, , input, output, x, y, w, h, scale] = process.argv;
if (input === undefined || output === undefined) {
  console.error("用法: node crop-png.mjs <输入 png> <输出 png> <x> <y> <宽> <高> [放大倍数]");
  process.exit(2);
}

const sharp = require(SHARP);
const factor = scale === undefined ? 1 : Number(scale);

const buf = readFileSync(input);
const meta = await sharp(buf).metadata();
console.log(`输入 ${meta.width}×${meta.height}`);

const left = Math.max(0, Math.round(Number(x)));
const top = Math.max(0, Math.round(Number(y)));
const width = Math.min(Math.round(Number(w)), meta.width - left);
const height = Math.min(Math.round(Number(h)), meta.height - top);
console.log(`裁剪 x=${left} y=${top} w=${width} h=${height}（超出部分已夹到图内）`);

let pipeline = sharp(buf).extract({ left, top, width, height });
if (factor > 1) pipeline = pipeline.resize({ width: width * factor, kernel: "lanczos3" });
const out = await pipeline.png().toBuffer();
writeFileSync(output, out);
console.log(`已写出：${output}（${(out.length / 1024).toFixed(1)} KB）`);
