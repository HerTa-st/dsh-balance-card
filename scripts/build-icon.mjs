/**
 * 从**抠好的角色图**生成按钮资产。
 *
 * 与上一版（圆形裁切）的区别：用户要的是「把角色扣出来直接当按钮」，
 * 所以按钮就是角色本身 —— 无圆形裁切、无边框、无底色，靠 alpha 站住。
 *
 * ## 尺寸
 *
 * 角色是竖长的（抠出来 211×268，比例约 0.787），所以按钮不是正方形：
 * 显示尺寸 `DOT_W × DOT_H = 72×88`（宽约等于原来 36px 的 2 倍，且不变形）。
 * 1x / 2x 两档，客户端 `srcset` 自动取 2x。
 *
 * ## 前提
 *
 * 输入必须是**带 alpha 的抠图**。生成它：
 *   python scripts\extract-character.py lib\assets\icon-source.jpg lib\assets\character-cutout.png
 *
 * 用法：node build-icon.mjs [输入抠图] [输出 1x 路径]
 */
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const sharp = require(
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs",
);

/** 仓库根：从脚本位置推导（scripts/ 的上一级），可用 DSH_BALANCE_CARD_REPO 覆盖。 */
const REPO = process.env.DSH_BALANCE_CARD_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 尺寸的**单一来源**：仓库根的 `button-size.json`。
 *
 * 三处需要知道尺寸：客户端（CSS）、出图脚本（像素）、验收脚本（断言）。
 * 靠"改的时候记得同步三处"必然有一天忘记，所以：
 *   - 只有 `button-size.json` 是手工改的；
 *   - 本脚本读它，并**把数字写回客户端的标记区**；
 *   - 验收脚本也读同一份 JSON。
 */
const size = JSON.parse(readFileSync(join(REPO, "button-size.json"), "utf8"));
const DOT_W = Number(size.width);
const DOT_H = Number(size.height);
if (!Number.isFinite(DOT_W) || !Number.isFinite(DOT_H) || DOT_W <= 0 || DOT_H <= 0) {
  console.error("button-size.json 里的 width/height 必须是正整数");
  process.exit(2);
}

const src = process.argv[2] ?? join(REPO, "lib", "assets", "character-cutout.png");
const out = process.argv[3] ?? join(REPO, "lib", "assets", "icon.png");

/**
 * 把尺寸同步进客户端的标记区。
 *
 * 标记边界缺一不可 —— 没有标记就报错退出，而不是"大致找个地方改"：
 * 静默改错地方会让 CSS 尺寸与图片像素不一致，表现为图被拉伸或模糊，很难查。
 */
function syncClientSize() {
  const clientPath = join(REPO, "lib", "client.js");
  const text = readFileSync(clientPath, "utf8");
  const start = "// >>> BUTTON_SIZE_START";
  const end = "// <<< BUTTON_SIZE_END";
  const startAt = text.indexOf(start);
  const endAt = text.indexOf(end);
  if (startAt === -1 || endAt === -1 || endAt < startAt) {
    console.error(`找不到客户端里的尺寸标记区（${start} … ${end}）—— 拒绝乱改，先确认标记还在`);
    process.exit(3);
  }
  const block = `${start}\n    const DOT_W = ${DOT_W};\n    const DOT_H = ${DOT_H};\n    `;
  const next = text.slice(0, startAt) + block + text.slice(endAt);
  if (next === text) {
    console.log(`客户端尺寸已是 ${DOT_W}×${DOT_H}，无需改动`);
    return;
  }
  writeFileSync(clientPath, next, "utf8");
  console.log(`已同步客户端尺寸：DOT_W=${DOT_W}、DOT_H=${DOT_H}`);
}

mkdirSync(dirname(out), { recursive: true });
syncClientSize();

const meta = await sharp(src).metadata();
if (meta.hasAlpha !== true) {
  console.error(`输入没有 alpha 通道（${src}）—— 先用 extract-character.py 生成抠图`);
  process.exit(2);
}
console.log(`输入 ${meta.width}×${meta.height}（含 alpha），目标显示 ${DOT_W}×${DOT_H}`);

/** 按目标比例等比缩放并居中放进透明画布 —— 不变形、不留白边。 */
async function render(width, height) {
  const inner = await sharp(src)
    .resize(width, height, { kernel: "lanczos3", fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const m = await sharp(inner).metadata();
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: inner, left: Math.round((width - m.width) / 2), top: Math.round((height - m.height) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer()
    .then((buf) => ({ buf, w: m.width, h: m.height }));
}

const one = await render(DOT_W, DOT_H);
const two = await render(DOT_W * 2, DOT_H * 2);
await sharp(one.buf).toFile(out);
await sharp(two.buf).toFile(out.replace(/\.png$/u, "@2x.png"));
console.log(`写出：${out}（${DOT_W}×${DOT_H}，内容 ${one.w}×${one.h}）`);
console.log(`写出：${out.replace(/\.png$/u, "@2x.png")}（${DOT_W * 2}×${DOT_H * 2}，内容 ${two.w}×${two.h}）`);

// 预览：按显示尺寸再放大 8 倍，肉眼确认「在这个尺寸下还认得出是谁」
await sharp(one.buf)
  .resize(DOT_W * 8, DOT_H * 8, { kernel: "nearest" })
  .png()
  .toFile(join(dirname(out), `icon-preview-${DOT_W}px.png`));
console.log(`写出：icon-preview-${DOT_W}px.png（显示尺寸放大 8×）`);
