/**
 * 截「按钮 + 展开卡片」同框 —— 用来看两者右下角是否对齐。
 *
 * 单独用途：`shoot-card.mjs` 截的是单个元素（把卡片挪到画面中间），看不到对齐关系。
 * 这个脚本点开卡片后**一个像素都不挪**，把两者一起框进来。
 *
 * 用法：node shoot-pair.mjs <带 token 的 lab URL> <输出 png> [调试端口]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WS_ENTRY = process.env.DSH_WS ?? "E:\\deepseek工作区\\dsh-clean\\node_modules\\ws\\index.js";
const { default: WebSocket } = await import(pathToFileURL(WS_ENTRY).href);
const EDGE = process.env.DSH_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const url = process.argv[2];
const outPath = process.argv[3];
const port = Number(process.argv[4] ?? 9445);
if (url === undefined || outPath === undefined) {
  console.error("用法: node shoot-pair.mjs <带 token 的 lab URL> <输出 png> [调试端口]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = mkdtempSync(join(tmpdir(), "dsh-bc-pair-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1400,1700",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ],
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
    const d = out.exceptionDetails;
    throw new Error([d.text, d.exception?.description].filter(Boolean).join(" | "));
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
  await send("Browser.setWindowBounds", { windowId: win.windowId, bounds: { width: 1400, height: 1700, windowState: "normal" } });
  await send("Page.navigate", { url });
  await sleep(14000);

  // 清掉历史坐标，让它是「刚点开」的状态；然后点开，等数字到齐。
  const box = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    try { localStorage.removeItem("dsh-balance-card:state"); } catch {}
    location.reload();
    return null;
  })()`);
  void box;
  await sleep(11000);
  const info = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return { error: "no dot" };
    const r0 = dot.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: 1,
                clientX: Math.round(r0.left + r0.width / 2), clientY: Math.round(r0.top + r0.height / 2) };
    dot.dispatchEvent(new PointerEvent("pointerdown", o));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { buttons: 0 })));
    for (let i = 0; i < 40; i++) {
      const c = document.querySelector(".dsh-bc-card");
      if (c !== null && /M|K|B/.test(c.innerText)) break;
      await sleep(500);
    }
    const host = document.querySelector(".dsh-bc-root");
    const card = document.querySelector(".dsh-bc-card");
    const hb = host.getBoundingClientRect();
    const cb = card.getBoundingClientRect();
    const img = host.querySelector("img");
    let paintedW = hb.width;
    let paintedH = hb.height;
    if (img !== null && img.naturalWidth > 0) {
      const scale = Math.min(hb.width / img.naturalWidth, hb.height / img.naturalHeight);
      paintedW = img.naturalWidth * scale;
      paintedH = img.naturalHeight * scale;
    }
    return {
      host: { x: hb.left, y: hb.top, w: hb.width, h: hb.height, right: hb.right, bottom: hb.bottom },
      paintedRight: hb.left + (hb.width + paintedW) / 2,
      paintedBottom: hb.top + (hb.height + paintedH) / 2,
      card: { x: cb.left, y: cb.top, w: cb.width, h: cb.height, right: cb.right, bottom: cb.bottom },
      vw: window.innerWidth, vh: window.innerHeight,
    };
  })()`);
  if (info.error !== undefined) throw new Error(info.error);
  console.log(`按钮外框 右下 (${info.host.right.toFixed(0)}, ${info.host.bottom.toFixed(0)})；可见右下 (${info.paintedRight.toFixed(0)}, ${info.paintedBottom.toFixed(0)})`);
  console.log(`卡片        右下 (${info.card.right.toFixed(0)}, ${info.card.bottom.toFixed(0)})  尺寸 ${Math.round(info.card.w)}×${Math.round(info.card.h)}`);

  // 裁剪范围：把卡片与按钮**一起**框进来。
  // ⚠️ 展开后按钮**不在 DOM 里**，`host.getBoundingClientRect()` 量到的是**卡片**本身 ——
  // 早先就是这么错的，截出来的图只有卡片。所以按钮位置按「卡片下方 8px 缝」推出来。
  const DOT_W = 192;
  const DOT_H = 236;
  const GAP = 8;
  const dotRight = info.card.right;
  const dotTop = info.card.bottom + GAP;
  const dotLeft = dotRight - DOT_W;
  const dotBottom = dotTop + DOT_H;
  console.log(`按钮推定 x ${dotLeft.toFixed(0)}–${dotRight.toFixed(0)} y ${dotTop.toFixed(0)}–${dotBottom.toFixed(0)}（由卡片位置 + 8px 缝推出）`);

  const pad = 16;
  const left = Math.max(0, Math.min(info.card.x, dotLeft) - pad);
  const top = Math.max(0, Math.min(info.card.y, dotTop) - pad);
  const right = Math.max(info.card.right, dotRight) + pad;
  const bottom = Math.max(info.card.bottom, dotBottom) + pad;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: left, y: top, width: right - left, height: bottom - top, scale: 2 },
    captureBeyondViewport: false,
  });
  writeFileSync(outPath, Buffer.from(shot.data, "base64"));
  console.log(`已写出：${outPath}`);
} catch (error) {
  console.error(`截图失败：${String(error?.message ?? error)}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { browser.kill(); } catch {}
}
