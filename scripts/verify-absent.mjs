/**
 * 卸载验收的页面侧断言：插件拆掉之后，页面里应当**什么都不剩**。
 *
 * 查四件事：
 *   1. 宿主 div / 样式表 / 卡片根节点都不存在；
 *   2. 插件注册进 localStorage 的键不存在；
 *   3. 插件自己的路由打不通（由 PowerShell 侧断言，这里只做页面内 fetch）；
 *   4. 控制台没有本插件产生的任何 error。
 *
 * 用法：node verify-absent.mjs <带 token 的 lab URL> [调试端口]
 * 退出码 0 = 全部通过。
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
const port = Number(process.argv[3] ?? 9351);
if (url === undefined) {
  console.error("用法: node verify-absent.mjs <带 token 的 lab URL> [调试端口]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 硬超时：任何一步卡住都必须自己退出。
 * 这里学到过教训 —— 先前脚本对浏览器轮询没有上限，Edge 起不来就**永久挂着**。
 */
function deadline(ms, label) {
  const timer = setTimeout(() => {
    console.error(`硬超时（${ms} ms）：${label}`);
    process.exit(9);
  }, ms);
  timer.unref();
  return timer;
}
deadline(120_000, "verify-absent 整体");

const results = [];
function check(label, ok, detail) {
  results.push(ok === true);
  console.log(`  ${ok === true ? "OK  " : "FAIL"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
}

const profileDir = mkdtempSync(join(tmpdir(), "dsh-bc-absent-"));
const browser = spawn(
  EDGE,
  ["--headless=new", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "about:blank"],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
function send(method, params) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expression) {
  const out = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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
      return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
    }
  });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url });
  await sleep(9000);

  const state = await evaluate(`(async () => {
    const res = await fetch('balance-card/health');
    return {
      host: document.getElementById('dsh-balance-card-host') !== null,
      style: document.getElementById('dsh-balance-card-style') !== null,
      root: document.querySelector('.dsh-bc-root') !== null,
      dot: document.querySelector('.dsh-bc-dot') !== null,
      card: document.querySelector('.dsh-bc-card') !== null,
      stateKey: window.localStorage.getItem('dsh-balance-card:state') !== null,
      routeStatus: res.status,
      pageStillWorks: document.title,
    };
  })()`);

  check("宿主 div 不存在", state.host === false);
  check("样式表不存在", state.style === false);
  check("卡片根节点不存在", state.root === false);
  check("圆点不存在", state.dot === false);
  check("卡片不存在", state.card === false);
  check("localStorage 里没有插件留下的键", state.stateKey === false);
  check("插件路由已消失（404）", state.routeStatus === 404, `HTTP ${state.routeStatus}`);
  const pluginErrors = consoleErrors.filter((t) => t.includes("dsh-balance-card"));
  check("控制台没有本插件产生的 error", pluginErrors.length === 0, pluginErrors.join(" | "));
  check("页面本身仍然可用（有标题＝宿主没被弄坏）", typeof state.pageStillWorks === "string" && state.pageStillWorks.length > 0, state.pageStillWorks);

  const failed = results.filter((r) => !r).length;
  console.log(`  ${failed === 0 ? "全部通过" : "有失败"}：${results.length - failed}/${results.length}`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(`验证脚本自身出错：${String(error?.message ?? error)}`);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  try { browser.kill(); } catch {}
}
