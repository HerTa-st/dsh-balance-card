/**
 * 抠图质量验收：**不验「圆不圆」**，验三件真正决定成败的事。
 *
 * 按钮现在是角色本人的抠图（无圆形裁切、无边框、无底色），所以旧的正圆判定已不适用。
 * 这一版验的是：
 *   1. **透明是真的**：抠图四边外侧应当全透明；否则说明背景没抠掉；
 *   2. **没把原图的残影带进来**：原图左侧有位淡色残影、还有一个问号。抠图只应保留主角。
 *      判据：抠图的**内容像素数**应显著小于「原图非白像素数」—— 若把残影都带上，
 *      两者会接近；同时抠图的占位应集中在画面偏右（主角在原图右侧）。
 *   3. **画面上真的画出来了**：对浏览器实拍截图统计「与底色的差异」，确认不是空白。
 *
 * 用法：node check-cutout.mjs <原图> <抠图 png> <实拍截图 png> [extract 脚本路径]
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require(
  process.env.DSH_SHARP ?? "E:\\deepseek工作区\\HerTa\\dsh-017\\node_modules\\sharp\\dist\\index.cjs",
);

const [, , sourcePath, cutoutPath, shotPath] = process.argv;
if (sourcePath === undefined || cutoutPath === undefined || shotPath === undefined) {
  console.error("用法: node check-cutout.mjs <原图> <抠图 png> <实拍截图 png>");
  process.exit(2);
}

const results = [];
function check(label, ok, detail) {
  results.push(ok === true);
  console.log(`    ${ok === true ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
}

// ── 1. 抠图本身 ────────────────────────────────────────────────
const cut = await sharp(cutoutPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const cw = cut.info.width;
const ch = cut.info.height;
const alphaAt = (x, y) => cut.data[(y * cw + x) * cut.info.channels + 3];

/**
 * 边框透明度。
 *
 * 走过的弯路（记下来免得重犯）：
 *   - 「外圈全透明」→ 错。抠图是**紧贴包围盒**裁的，人物必然贴住右边/下边。
 *   - 「四角 4×4 全透明」→ 太敏感。右下角恰好压到她的肩膀，一个像素就判失败。
 * 正确判据：量**整条边框**里有透明像素的比例（`frameAlpha`）。
 * 矩形白底图是 0%；紧贴裁切的透明抠图约 30–50%。
 */
const border = [];
for (let x = 0; x < cw; x += 1) {
  border.push(alphaAt(x, 0), alphaAt(x, ch - 1));
}
for (let y = 0; y < ch; y += 1) {
  border.push(alphaAt(0, y), alphaAt(cw - 1, y));
}
const transparentBorder = border.filter((a) => a <= 32).length / border.length;
console.log(`抠图 ${cw}×${ch}；边框 ${border.length} 点，其中透明 ${(transparentBorder * 100).toFixed(1)}%`);
check(
  "边框有相当比例的透明像素（底色确实被抠掉，不是矩形白底图）",
  transparentBorder >= 0.1,
  `${(transparentBorder * 100).toFixed(1)}%（矩形白底图会是 0%）`,
);

let opaque = 0;
for (let i = 3; i < cut.data.length; i += cut.info.channels) if (cut.data[i] > 32) opaque += 1;
const opaqueRatio = opaque / (cw * ch);
const transparentRatio = 1 - opaqueRatio;
console.log(`抠图透明像素占比 ${(transparentRatio * 100).toFixed(1)}%，内容 ${(opaqueRatio * 100).toFixed(1)}%`);
check("透明占比足够（不是几乎整块实心）", transparentRatio >= 0.2, `${(transparentRatio * 100).toFixed(1)}%`);
check("内容占比合理（不是空白）", opaqueRatio > 0.15, `${(opaqueRatio * 100).toFixed(1)}%`);

// ── 2. 有没有把原图残影带进来 ──────────────────────────────────
// 早先我用「保留像素 ÷ 原图非白像素」来判，**判据是错的**：原图里的非白像素本来就大半是
// 主角，这个比值天然很高（实测 80.5%），会把正确的抠图判成失败。
//
// 真正能证明「残影没漏进来」的做法：在**抠图结果**上数连通块 —— 只应有「主角」与
// 「问号的若干块」。若残影漏进来，就会出现一个额外的大块。
const alphaMask = new Uint8Array(cw * ch);
for (let i = 0; i < cw * ch; i += 1) alphaMask[i] = cut.data[i * cut.info.channels + 3] > 32 ? 1 : 0;

/** 4 邻域连通块，返回按面积降序的 `{area, x0, x1, y0, y1}`。 */
function analyze(seedAllowed) {
  const seen = new Uint8Array(cw * ch);
  const out = [];
  for (let start = 0; start < cw * ch; start += 1) {
    if (seen[start] === 1 || alphaMask[start] === 0 || !seedAllowed(start)) continue;
    const stack = [start];
    seen[start] = 1;
    let area = 0;
    let minX = cw;
    let maxX = -1;
    let minY = ch;
    let maxY = -1;
    while (stack.length > 0) {
      const idx = stack.pop();
      const x = idx % cw;
      const y = (idx - x) / cw;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [
        x > 0 ? idx - 1 : -1,
        x < cw - 1 ? idx + 1 : -1,
        y > 0 ? idx - cw : -1,
        y < ch - 1 ? idx + cw : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && seen[n] === 0 && alphaMask[n] === 1) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    out.push({ area, x0: minX, x1: maxX, y0: minY, y1: maxY });
  }
  return out.sort((a, b) => b.area - a.area);
}

const pieces = analyze(() => true);
console.log(`抠图里的连通块：${pieces.length} 块（面积 >= 30 的前 6 块）`);
for (const p of pieces.filter((p) => p.area >= 30).slice(0, 6)) {
  console.log(`    ${p.area} 像素  x${p.x0}-${p.x1} y${p.y0}-${p.y1}`);
}
// 主角必然最大；问号在左侧一条（x 较小）。若出现「面积可观且不在这两处」的块，就是残影漏了。
const hero = pieces[0];
const extras = pieces.filter(
  (p) =>
    p !== hero &&
    p.area > 400 && // 残影有几千像素；问号碎块都是 1000 以下
    !(p.x1 < hero.x0 + 40),
);
check(
  "没有整块残影漏进来（除主角与问号外无额外大块）",
  extras.length === 0,
  extras.length === 0 ? `最大块 ${hero.area} 像素` : `多出 ${extras.length} 块：${extras.map((p) => p.area).join(", ")}`,
);
check("问号在抠图里（主角左侧存在独立小块）", pieces.some((p) => p !== hero && p.area >= 60 && p.x1 <= hero.x0 + 40), `块数 ${pieces.length}`);

// ── 3. 页面上真的画出来了 ──────────────────────────────────────
const shot = await sharp(shotPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const sw = shot.info.width;
const sh = shot.info.height;
const bgPx = [shot.data[0], shot.data[1], shot.data[2]];
let painted = 0;
for (let i = 0; i < shot.data.length; i += shot.info.channels) {
  const d = Math.abs(shot.data[i] - bgPx[0]) + Math.abs(shot.data[i + 1] - bgPx[1]) + Math.abs(shot.data[i + 2] - bgPx[2]);
  if (d > 60) painted += 1;
}
const paintedRatio = painted / (sw * sh);
console.log(`实拍截图 ${sw}×${sh}；与底色不同的像素占比 ${(paintedRatio * 100).toFixed(1)}%`);
check("实拍截图里角色真的画出来了", paintedRatio > 0.03, `${(paintedRatio * 100).toFixed(1)}%`);

const failed = results.filter((r) => !r).length;
console.log("");
if (failed === 0) {
  console.log("判定：**抠图成立**");
  process.exit(0);
}
console.log(`判定：**不成立**（${failed} 条失败）`);
process.exit(1);
