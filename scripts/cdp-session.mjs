/**
 * 无头 Edge + CDP 的最小封装 —— verify-card / verify-drawer / shoot-drawer 共用的那套代码。
 *
 * ## 为什么 Edge 用 `stdio: "ignore"` 启动
 *
 * 受限沙箱禁止带管道的子进程：`spawn(..., { stdio: "pipe" })` 会 EPERM。忽略 stdio
 * 是唯一能起浏览器的方式（见 scripts/verify-card.mjs 的老注释）。
 *
 * ## 用法
 *
 *   import { REPO, buttonSize, launch, waitFor, navigate, reload, evaluate, sleep } from "./cdp-session.mjs";
 *   const s = await launch({ port: 9337 });
 *   await navigate(s, url);
 *   ...
 *   s.close();
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** ws 模块不在插件仓库里，用 dsh-clean 的副本（README 里验证过）。 */
const WS_ENTRY = process.env.DSH_WS ?? "E:\\deepseek工作区\\dsh-clean\\node_modules\\ws\\index.js";
const EDGE = process.env.DSH_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

/** 插件仓库根目录：从脚本位置推导（scripts/ 的上一级），换机器不用改代码；可用 DSH_BALANCE_CARD_REPO 覆盖。 */
export const REPO = process.env.DSH_BALANCE_CARD_REPO ?? dirname(dirname(fileURLToPath(import.meta.url)));
/** 截图等产物的默认目录（仓库根的上一级 = 工作区根）。 */
export const OUT_DIR = join(REPO, "..");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 按钮尺寸（单一来源是仓库根的 button-size.json）。 */
export function buttonSize() {
  const size = JSON.parse(readFileSync(join(REPO, "button-size.json"), "utf8"));
  return { w: Number(size.width), h: Number(size.height) };
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return await res.json();
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`DevTools 端口 ${port} 在 ${Math.round(timeoutMs / 1000)} 秒内没就绪` + (lastError === null ? "" : `（${String(lastError.message ?? lastError)}）`));
}

/**
 * 起一个无头 Edge，连上它的 page target。
 * @returns {Promise<{ws:any, browser:any, send:Function, evaluate:Function, consoleErrors:string[], consoleLogs:string[], version:any, close:Function}>}
 */
export async function launch({ port = 9337, width = 1400, height = 1500, initScripts = [], attach = process.env.DSH_CDP_ATTACH === "1" } = {}) {
  const { default: WebSocket } = await import(pathToFileURL(WS_ENTRY).href);
  const profileDir = attach ? null : mkdtempSync(join(tmpdir(), "dsh-balance-card-cdp-"));
  const browser = attach ? null : spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      // 显式窗口大小：不给自己默认窗口很矮（实测 676px 高），落位模式会跟真实使用不同。
      `--window-size=${width},${height}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  // attach 模式：不自己起浏览器，连到别人已经开好的 --remote-debugging-port（受限沙箱里起不了 Edge 时用）。
  const version = await waitForDevtools(port);
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  // attach 模式下浏览器里可能有多个 tab（比如别的页面 + about:blank）：
  // 优先选已经加载了真实页面的 target，避免把断言跑在一个空白 tab 上。
  const pages = targets.filter((t) => t.type === "page");
  const page = pages.find((t) => t.url !== "about:blank") ?? pages[0];
  if (page === undefined) throw new Error("没找到 page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const consoleLogs = [];

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
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
      if (msg.params.type === "error") consoleErrors.push(text);
      else consoleLogs.push(text);
    }
    if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
    }
  });

  function send(method, params) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }

  async function evaluate(expression) {
    const out = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (out.exceptionDetails !== undefined) {
      throw new Error(
        `页面求值抛错：${out.exceptionDetails.text ?? ""} ${out.exceptionDetails.exception?.description ?? ""}`,
      );
    }
    return out.result?.value;
  }

  await send("Runtime.enable");
  await send("Page.enable");
  for (const source of initScripts) {
    await send("Page.addScriptToEvaluateOnNewDocument", { source });
  }

  return {
    ws,
    browser,
    send,
    evaluate,
    consoleErrors,
    consoleLogs,
    version,
    close() {
      try {
        ws.close();
      } catch {
        /* 关不掉就算了 */
      }
      try {
        if (browser !== null) browser.kill();
      } catch {
        /* 同上 */
      }
    },
  };
}

/** 导航并等待页面稳定（首开要全量解压会话日志，实测约 2.4 秒）。 */
export async function navigate(session, url, { settleMs = 9000 } = {}) {
  await session.send("Page.navigate", { url });
  await sleep(settleMs);
}

/** 重新加载并等待。 */
export async function reload(session, { settleMs = 8000 } = {}) {
  await session.send("Page.reload");
  await sleep(settleMs);
}

/** 轮询页面表达式直到它返回真值（或超时）。 */
export async function waitFor(session, expression, { timeoutMs = 15000, intervalMs = 200, label = expression } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await session.evaluate(expression)) === true) return true;
    } catch {
      /* 页面还没就绪，继续等 */
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时：${label}`);
}

/** 截一张 PNG。clip 用 CSS 像素；scale=2 输出高清图。 */
export async function screenshot(session, filePath, clip) {
  const params = { format: "png", fromSurface: true, captureBeyondViewport: false };
  if (clip !== undefined) params.clip = { ...clip, scale: 2 };
  const out = await session.send("Page.captureScreenshot", params);
  writeFileSync(filePath, Buffer.from(out.data, "base64"));
  return filePath;
}
