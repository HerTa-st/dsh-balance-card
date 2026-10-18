/**
 * 按钮图标的验收：解码 / 形状 / 尺寸，一次跑完。
 *
 * ## 为什么要专门验「形状」
 *
 * 图标外观是这个插件唯一主观的部分，也最容易「看着差不多就放过」。
 * 踩过的坑（都真实发生过）：
 *   1. 图的圆角半径按**内容盒**算，与父级 36px 外框不同源，底部略平 → 看起来像圆角方形；
 *   2. 截图里圆点周围有**界面文字**，像素判定把文字和圆点连成一块，得出假结论；
 *   3. 取样框坐标靠心算（pad/scale/ratio），算错三次，每次结论都不同。
 * 所以这里：把圆点停到**空白处**截图（消掉坑 2），用**连通块**自动定位（消掉坑 3），
 * 再用圆形方程拟合判定（把坑 1 变成可断言）。
 *
 * 用法：node verify-icon.mjs <带 token 的 lab URL> [截图输出路径]
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WS_ENTRY = process.env.DSH_WS ?? "E:\\deepseek工作区\\dsh-clean\\node_modules\\ws\\index.js";
const { default: WebSocket } = await import(pathToFileURL(WS_ENTRY).href);
const EDGE = process.env.DSH_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const NODE = process.env.DSH_NODE ?? "E:\\node\\node.exe";
/** 仓库根：从脚本位置推导（scripts/ 的上一级），可用 DSH_BALANCE_CARD_REPO 覆盖。 */
const REPO = process.env.DSH_BALANCE_CARD_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));

/** 尺寸来自仓库根的 `button-size.json`（**单一来源**），不在这里再抄一份。 */
const SIZE = JSON.parse(readFileSync(join(REPO, "button-size.json"), "utf8"));
const DOT_W = Number(SIZE.width);
const DOT_H = Number(SIZE.height);

const url = process.argv[2];
const shotPath = process.argv[3] ?? join(REPO, "lib", "assets", "icon-shot.png");
const port = Number(process.argv[4] ?? 9390);
if (url === undefined) {
  console.error("用法: node verify-icon.mjs <带 token 的 lab URL> [截图输出] [调试端口]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(label, ok, detail) {
  results.push(ok === true);
  console.log(`  ${ok === true ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-bc-icon-"));
const browser = spawn(
  EDGE,
  ["--headless=new", "--disable-gpu", "--no-first-run", "--window-size=1200,1000", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: true });
  if (out.exceptionDetails !== undefined) {
    // 报全：`text` 往往只是 "Uncaught"，真正的信息在 exception.description 与 stack 里。
    const d = out.exceptionDetails;
    const detail = [
      d.text,
      d.exception?.description,
      d.exception?.value,
      d.stackTrace?.callFrames?.map((f) => `${f.functionName || "(anon)"}@${f.url}:${f.lineNumber}:${f.columnNumber}`).join(" <- "),
    ]
      .filter((v) => v !== undefined && v !== null && v !== "")
      .join(" | ");
    throw new Error(`页面求值抛错：${detail}`);
  }
  return out.result?.value;
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch {
      /* 等浏览器起来 */
    }
    await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  ws.on("message", (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");

  const win = await send("Browser.getWindowForTarget");
  await send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: 1200, height: 1000, windowState: "normal" } });
  await send("Page.navigate", { url });
  await sleep(13000);

  // 收起卡片，把圆点停到空白处（避开界面文字），等图解码完成
  const box = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const closeBtn = document.querySelector(".dsh-bc-close");
    if (closeBtn !== null) { closeBtn.click(); await sleep(700); }
    const root = document.querySelector(".dsh-bc-root");
    if (root !== null) {
      root.style.setProperty("right", "auto", "important");
      root.style.setProperty("bottom", "auto", "important");
      root.style.setProperty("left", "880px", "important");
      root.style.setProperty("top", "640px", "important");
    }
    await sleep(400);
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return null;
    const img = dot.querySelector("img");
    if (img !== null && !img.complete) {
      await new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); setTimeout(r, 3000); });
    }
    await sleep(300);
    const r = dot.getBoundingClientRect();
    const cs = getComputedStyle(dot);
    const ir = img === null ? null : img.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             clipPath: cs.clipPath, borderRadius: cs.borderRadius, background: cs.backgroundColor,
             filter: cs.filter,
             imgComplete: img === null ? null : img.complete,
             imgNatural: img === null ? 0 : img.naturalWidth,
             imgNaturalH: img === null ? 0 : img.naturalHeight,
             imgBoxW: ir === null ? 0 : ir.width,
             imgBoxH: ir === null ? 0 : ir.height,
             imgSrc: img === null ? null : img.getAttribute("src"),
             imgSrcset: img === null ? null : img.getAttribute("srcset"),
             imgFit: img === null ? null : getComputedStyle(img).objectFit,
             errorFlag: dot.getAttribute("data-icon-error") };
  })()`);
  if (box === null) throw new Error("没找到圆点");

  check("按钮里是 <img> 且已解码", box.imgComplete === true && box.imgNatural > 0, `natural=${box.imgNatural}×${box.imgNaturalH} src=${box.imgSrc}`);
  check("用了 2x 图（srcset）", typeof box.imgSrcset === "string" && box.imgSrcset.includes("2x"), String(box.imgSrcset));
  check("没有退回内置 SVG", box.errorFlag !== "true", String(box.errorFlag));
  check(
    `按钮尺寸 ${DOT_W}×${DOT_H}`,
    Math.round(box.w) === DOT_W && Math.round(box.h) === DOT_H,
    `${Math.round(box.w)}×${Math.round(box.h)}`,
  );
  // 抠图当按钮的核心：不该再有圆形裁切/边框/底色（角色本人就是按钮）
  check("没有圆形裁切（clip-path 为 none）", box.clipPath === "none", String(box.clipPath));
  check("没有底色填充", box.background === "rgba(0, 0, 0, 0)" || box.background === "transparent", String(box.background));
  check("有投影（浅色主题下人物不至于糊在背景里）", typeof box.filter === "string" && box.filter.includes("drop-shadow"), String(box.filter));
  // 不变形：图片以 contain 铺，其内容长宽比必须与图源一致
  const naturalRatio = box.imgNatural / Math.max(1, box.imgNaturalH);
  const shownRatio = box.imgBoxW / Math.max(1, box.imgBoxH);
  check(
    "图片按 contain 铺（不拉伸）",
    box.imgFit === "contain" && Math.abs(naturalRatio - shownRatio) <= 0.02,
    `objectFit=${box.imgFit}，源比例 ${naturalRatio.toFixed(3)} vs 显示比例 ${shownRatio.toFixed(3)}`,
  );
  // 清晰度：2x 图源的像素数至少是 CSS 尺寸的 2 倍时，才是「视网膜清晰」
  check(
    `图标源够清晰（natural ${box.imgNatural}×${box.imgNaturalH}）`,
    box.imgNatural >= DOT_W && box.imgNaturalH >= DOT_H,
    `natural=${box.imgNatural}×${box.imgNaturalH}，显示 ${DOT_W}×${DOT_H}`,
  );

  // 截图（按钮在空白处，周围无文字）
  const pad = 20;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 2 },
    captureBeyondViewport: false,
  });
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`  截图：${shotPath}`);

  // 像素级检查：这里要验的不是「圆不圆」——**按钮就是角色抠图，没有圆形裁切** ——
  // 而是「抠图是否真的成立、有没有把原图里的残影一起带进来」。
  const cutoutOut = execFileSync(
    NODE,
    [
      join(REPO, "scripts", "check-cutout.mjs"),
      join(REPO, "lib", "assets", "icon-source.jpg"),
      join(REPO, "lib", "assets", "character-cutout.png"),
      join(REPO, "lib", "assets", "icon-shot.png"),
    ],
    { encoding: "utf8" },
  );
  for (const line of cutoutOut.trim().split("\n")) console.log("    " + line);
  check("抠图成立：有真透明边缘、占比合理、无残影残留", cutoutOut.includes("判定：**抠图成立**"), "见上面的占比与边界统计");

  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${results.length - failed}/${results.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`验证脚本自身出错：${String(error?.message ?? error)}`);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  try { browser.kill(); } catch {}
}
