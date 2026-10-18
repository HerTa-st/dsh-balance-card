/**
 * 量「首开」到底多慢：从点开卡片到看见数字的**端到端**时间。
 *
 * 分三个数看，别混成一个：
 *   1. 首次 HTTP 请求（冷启动：宿主这一轮要全量解压所有会话日志）；
 *   2. 之后一次 HTTP 请求（增量：mtime+size 都没变，几乎所有文件被跳过）；
 *   3. 卡片自己报的 `clientMs`（浏览器视角的端到端，含网络与 JSON 传输）。
 *
 * 用法：node measure-open.mjs <带 token 的 lab URL> [调试端口]
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const WS_ENTRY = process.env.DSH_WS ?? "E:\\deepseek工作区\\dsh-clean\\node_modules\\ws\\index.js";
const { default: WebSocket } = await import(pathToFileURL(WS_ENTRY).href);
const EDGE = process.env.DSH_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const url = process.argv[2];
const port = Number(process.argv[3] ?? 9362);
if (url === undefined) {
  console.error("用法: node measure-open.mjs <带 token 的 lab URL> [调试端口]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profileDir = mkdtempSync(join(tmpdir(), "dsh-bc-measure-"));
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
  if (out.exceptionDetails !== undefined) throw new Error(out.exceptionDetails.text ?? "eval failed");
  return out.result?.value;
}

try {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) break;
    } catch {
      /* 等 */
    }
    await sleep(250);
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(9000); // 等界面挂载（卡片此时是收起态，还没取数）

  /** 在页面里直接打两次路由，量浏览器视角的耗时。 */
  const measured = await evaluate(`(async () => {
    const t = async (q) => { const s = performance.now(); const r = await fetch('balance-card/snapshot' + q); const j = await r.json(); return { ms: Math.round(performance.now() - s), files: j.scan.files, changed: j.scan.changed, calls: j.usage.windows.today.calls }; };
    const first = await t('?force=1');
    const second = await t('');
    return { first, second };
  })()`);
  console.log(`冷启动（force=1，宿主全量解压）：${measured.first.ms} ms — 扫描 ${measured.first.files} 个文件，重算 ${measured.first.changed} 个`);
  console.log(`增量（无 force，mtime+size 跳过）：${measured.second.ms} ms — 重算 ${measured.second.changed} 个`);

  // 再走一次「用户点开卡片」的真实路径，读卡片自报的 clientMs
  const ui = await evaluate(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const dot = document.querySelector('.dsh-bc-dot');
    if (dot === null) return { error: 'no dot' };
    const r = dot.getBoundingClientRect();
    const o = { bubbles:true, cancelable:true, pointerId:5, pointerType:'mouse', button:0, buttons:1,
                clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2) };
    const t0 = performance.now();
    dot.dispatchEvent(new PointerEvent('pointerdown', o));
    dot.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    // 等卡片上出现数字
    for (let i = 0; i < 60; i++) {
      const c = document.querySelector('.dsh-bc-card');
      if (c !== null && /M|K|B/.test(c.innerText)) return { ms: Math.round(performance.now() - t0), text: c.innerText.split('\\n').slice(0, 6).join(' | ') };
      await sleep(100);
    }
    return { ms: null, text: '超时未见数字' };
  })()`);
  console.log(`点开卡片 → 看见数字：${ui.ms} ms`);
  console.log(`  卡片内容：${ui.text}`);

  // 收起再点开一次：这就是用户在会话里反复开合的实际体验
  const again = await evaluate(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    document.querySelector('.dsh-bc-close').click();
    await sleep(300);
    const dot = document.querySelector('.dsh-bc-dot');
    const r = dot.getBoundingClientRect();
    const o = { bubbles:true, cancelable:true, pointerId:6, pointerType:'mouse', button:0, buttons:1,
                clientX: Math.round(r.left+r.width/2), clientY: Math.round(r.top+r.height/2) };
    const t0 = performance.now();
    dot.dispatchEvent(new PointerEvent('pointerdown', o));
    dot.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    for (let i = 0; i < 60; i++) {
      const c = document.querySelector('.dsh-bc-card');
      if (c !== null && /M|K|B/.test(c.innerText)) return Math.round(performance.now() - t0);
      await sleep(100);
    }
    return null;
  })()`);
  console.log(`再次开合（增量路径）：${again} ms`);
} catch (error) {
  console.error(`失败：${String(error?.message ?? error)}`);
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  try { browser.kill(); } catch {}
}
