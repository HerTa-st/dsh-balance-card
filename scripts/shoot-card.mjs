/**
 * 给卡片/圆点截图（用于肉眼核对与留档）。
 *
 * 踩过的坑都写在这里，免得重踩：
 *   1. 页面**内建视口不大**，卡片默认贴右下角；截图前先把窗口开大、再把元素挪到目标位置。
 *   2. `dot` 模式要把圆点挪到**一片空白处** —— 周围有界面文字时，像素判定会把文字和圆点
 *      连成一块（实测连成 152×73 的一大块，判定直接失效）。
 *   3. `clip` 与 `getBoundingClientRect` 同一套 CSS 坐标，`scale` 单独给倍数；
 *      **不要**用 `Emulation.setDeviceMetricsOverride` 改 dpr，那会让两套坐标错开。
 *   4. 页面内代码用**双引号**，不要用反引号 —— 外层已经是模板字符串，会打架。
 *
 * 用法：node shoot-card.mjs <带 token 的 lab URL> <输出 png> [调试端口] [dot]
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
const port = Number(process.argv[4] ?? 9353);
const mode = process.argv[5] ?? "card";
if (url === undefined || outPath === undefined) {
  console.error("用法: node shoot-card.mjs <带 token 的 lab URL> <输出 png> [调试端口] [card|dot]");
  process.exit(2);
}

const wantDot = mode === "dot";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profileDir = mkdtempSync(join(tmpdir(), "dsh-bc-shot-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1200,1000",
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
  if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.text ?? "eval failed");
  return out.result?.value;
}

/** 页面内脚本：把元素摆到目标位置，并等到它真的画好。 */
function placementScript() {
  return `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const wantDot = ${wantDot ? "true" : "false"};
    const closeBtn = document.querySelector(".dsh-bc-close");
    const dotEl = document.querySelector(".dsh-bc-dot");
    const rootEl = document.querySelector(".dsh-bc-root");
    // 开合状态的唯一真相是 data-open：图片和卡片现在**都常驻** DOM（收起态只是隐藏），
    // 所以不能用「✕ 是否存在」来判断展开 —— 那会永远为真，反而把状态点反。
    const isOpen = rootEl !== null && rootEl.getAttribute("data-open") === "true";

    if (wantDot && isOpen && closeBtn !== null) { closeBtn.click(); await sleep(600); }
    if (!wantDot && !isOpen && dotEl !== null) {
      const r = dotEl.getBoundingClientRect();
      const o = { bubbles: true, cancelable: true, pointerId: 3, pointerType: "mouse", button: 0, buttons: 1,
                  clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
      dotEl.dispatchEvent(new PointerEvent("pointerdown", o));
      dotEl.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, o, { buttons: 0 })));
      await sleep(900);
    }

    const root = document.querySelector(".dsh-bc-root");
    // 「card」模式**不挪位置** —— 要截的就是「点开时它落在哪」，挪了就看不到与按钮的对齐关系。
    if (root !== null && wantDot) {
      root.style.setProperty("right", "auto", "important");
      root.style.setProperty("bottom", "auto", "important");
      root.style.setProperty("left", "880px", "important");
      root.style.setProperty("top", "640px", "important");
    }
    await sleep(500);

    if (wantDot) {
      const img = document.querySelector(".dsh-bc-dot img");
      if (img !== null && !img.complete) {
        await new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); setTimeout(r, 3000); });
      }
      await sleep(400);
    } else {
      for (let i = 0; i < 40; i++) {
        const c = document.querySelector(".dsh-bc-card");
        if (c !== null && /M|K|B/.test(c.innerText)) break;
        await sleep(500);
      }
    }

    const el = wantDot ? document.querySelector(".dsh-bc-dot") : document.querySelector(".dsh-bc-card");
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height,
             vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio,
             text: wantDot ? "" : el.innerText,
             iconComplete: wantDot ? (document.querySelector(".dsh-bc-dot img")?.complete ?? null) : null,
             iconNatural: wantDot ? (document.querySelector(".dsh-bc-dot img")?.naturalWidth ?? 0) : null };
  })()`;
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
  await sleep(14000);

  const box = await evaluate(placementScript());
  if (box === null) throw new Error(wantDot ? "没找到圆点" : "没找到卡片");

  console.log(`视口 ${box.vw}×${box.vh} dpr=${box.dpr}；元素 ${Math.round(box.w)}×${Math.round(box.h)} @ ${Math.round(box.x)},${Math.round(box.y)}`);
  if (wantDot) console.log(`  图标：complete=${box.iconComplete} natural=${box.iconNatural}px`);
  else console.log("卡片文字：\n" + String(box.text).split("\n").map((l) => "  " + l).join("\n"));

  const pad = 20;
  const shot = await send("Page.captureScreenshot", {
    format: "png",
    clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.w + pad * 2, height: box.h + pad * 2, scale: 2 },
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
