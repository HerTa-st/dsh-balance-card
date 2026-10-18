/**
 * 验证卡片的色板与黑塔主题**共存**：把主题的两套令牌（深/浅）分别注到 `:root` 上，
 * 量卡片的**实际解析值**，确认：
 *   1. 卡片确实吃的是 `--dsw-alias-*` 令牌（换令牌就换色，不是硬编码）；
 *   2. 深色下正文是浅色、浅色下正文是深色（对比度没搞反）；
 *   3. 两种色板下正文与背景的对比度都够用。
 *
 * 令牌取值来源：`dsh-theme-herta/lib/theme.js` 的 `TOKENS_DARK` / `TOKENS_LIGHT`。
 *
 * 用法：`node verify-theme.mjs <带 token 的 lab URL> [调试端口]`
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
const port = Number(process.argv[3] ?? 9339);
if (url === undefined) {
  console.error("用法: node verify-theme.mjs <带 token 的 lab URL> [调试端口]");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: condition === true });
  console.log(`  ${condition === true ? "✓" : "✗"} ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
}

async function waitForDevtools(p) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/json/version`);
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  throw new Error(`DevTools 端口 ${p} 没就绪`);
}

/** 与 theme.js 的 TOKENS_DARK 一致（只取卡片用到的那些）。 */
const DARK = {
  "--dsw-alias-bg-overlay": "rgba(46, 38, 54, 0.95)",
  "--dsw-alias-bg-layer-3": "rgba(56, 46, 66, 0.88)",
  "--dsw-alias-border-l1": "rgba(180, 159, 187, 0.18)",
  "--dsw-alias-border-l2": "rgba(180, 159, 187, 0.30)",
  "--dsw-alias-label-primary": "#ebdfe7",
  "--dsw-alias-label-secondary": "#b49fbb",
  "--dsw-alias-label-tertiary": "#88749e",
  "--dsw-alias-label-caption": "#7e6d90",
  "--dsw-alias-label-dimmed": "#564969",
  "--dsw-alias-brand-primary": "#9b8ae0",
};
/** 与 theme.js 的 TOKENS_LIGHT 一致。 */
const LIGHT = {
  "--dsw-alias-bg-overlay": "rgba(255, 255, 255, 0.97)",
  "--dsw-alias-bg-layer-3": "#ebe3f0",
  "--dsw-alias-border-l1": "rgba(86, 73, 105, 0.14)",
  "--dsw-alias-border-l2": "rgba(86, 73, 105, 0.24)",
  "--dsw-alias-label-primary": "#2e2636",
  "--dsw-alias-label-secondary": "#564969",
  "--dsw-alias-label-tertiary": "#88749e",
  "--dsw-alias-label-caption": "#7e6d90",
  "--dsw-alias-label-dimmed": "#a99bb8",
  "--dsw-alias-brand-primary": "#65549b",
};

const profileDir = mkdtempSync(join(tmpdir(), "dsh-balance-card-theme-"));
const browser = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
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

/** 相对亮度 + 对比度（WCAG 口径）。 */
const CONTRAST_EXPR = `(function(rgbA, rgbB){
  const lum = (c) => { const s = c.map(v => { const x = v/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); }); return 0.2126*s[0] + 0.7152*s[1] + 0.0722*s[2]; };
  const a = lum(rgbA), b = lum(rgbB);
  return (Math.max(a,b) + 0.05) / (Math.min(a,b) + 0.05);
})`;

try {
  const version = await waitForDevtools(port);
  console.log(`浏览器: ${version.Browser}`);
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
  console.log("\n加载页面…");
  await send("Page.navigate", { url });
  await sleep(12000);

  // 展开卡片
  await evaluate(`(async () => {
    const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
    const s = JSON.parse(localStorage.getItem('dsh-balance-card:state') ?? '{"open":false}');
    if (!s.open) { const d=document.querySelector('.dsh-bc-dot'); if(d){ const r=d.getBoundingClientRect();
      const o={bubbles:true,cancelable:true,pointerId:9,pointerType:'mouse',button:0,buttons:1,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
      d.dispatchEvent(new PointerEvent('pointerdown',o)); d.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0})); await sleep(500); } }
    return document.querySelector('.dsh-bc-card') !== null;
  })()`);

  /** 应用一套令牌，然后量卡片解析出来的实际颜色。
   *
   * 令牌注入到**卡片自己的宿主元素**上，理由：那样量到的就是卡片这个子树真实的解析结果，
   * 不受 DSH/主题在文档更上层怎么定义的影响。（早先注到 `:root` 上量出来的其实是主题的值 ——
   * 那是探针的 bug，不是卡片的 bug。）
   */
  async function measure(tokens, label) {
    const json = JSON.stringify(tokens);
    return await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      const tokens = ${json};
      const host = document.getElementById('dsh-balance-card-host');
      if (host === null) return { error: 'host missing' };
      // 先清掉上一套，再逐条写上去（写在卡片自己的宿主元素上）。
      for (const k of Object.keys(tokens)) host.style.removeProperty(k);
      await sleep(150);
      for (const [k, v] of Object.entries(tokens)) host.style.setProperty(k, v, 'important');
      await sleep(300);
      // 先确认注入真的生效了，否则后面的量测没有意义。
      const hostVar = getComputedStyle(host).getPropertyValue('--dsw-alias-label-primary').trim();
      const rootVarEl = document.querySelector('.dsh-bc-root');
      const rootVar = rootVarEl === null ? '' : getComputedStyle(rootVarEl).getPropertyValue('--dsw-alias-label-primary').trim();
      const expected = tokens['--dsw-alias-label-primary'];
      const norm = (s) => { const m = (s ?? '').match(/[\\d.]+/g); return m === null ? null : m.slice(0,3).map(Number).join(','); };
      const injected = norm(hostVar) === norm(expected) && norm(rootVar) === norm(expected);
      const pick = (sel, prop) => { const el = document.querySelector(sel); return el === null ? null : getComputedStyle(el)[prop]; };
      const rgb = (s) => { const m = (s ?? '').match(/[\\d.]+/g); if (m === null) return null; return [Math.round(+m[0]), Math.round(+m[1]), Math.round(+m[2])]; };
      const balanceColor = pick('.dsh-bc-balance', 'color');
      const cardBg = pick('.dsh-bc-card', 'backgroundColor');
      const accentColor = pick('.dsh-bc-row[data-accent="true"] .v', 'color');
      return { injected, hostVar, rootVar, expected,
               balanceColor, cardBg, accentColor,
               balanceRgb: rgb(balanceColor), cardBgRgb: rgb(cardBg) };
    })()`);
  }

  async function ensureOpen() {
    return await evaluate(`(async () => {
      const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
      let s = JSON.parse(localStorage.getItem('dsh-balance-card:state') ?? '{"open":false}');
      if (!s.open) {
        const d = document.querySelector('.dsh-bc-dot');
        if (d !== null) {
          const r = d.getBoundingClientRect();
          const o = { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'mouse', button: 0, buttons: 1,
                      clientX: Math.round(r.left + r.width/2), clientY: Math.round(r.top + r.height/2) };
          d.dispatchEvent(new PointerEvent('pointerdown', o));
          d.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
          await sleep(800);
        }
      }
      return document.querySelector('.dsh-bc-card') !== null && document.querySelector('.dsh-bc-balance') !== null;
    })()`);
  }

  const opened = await ensureOpen();
  check("卡片已展开且余额元素存在（否则后面的量测没有意义）", opened === true, String(opened));

  console.log("\n1. 深色令牌");
  const dark = await measure(DARK, "dark");
  console.log(`    注入校验 host=${dark.hostVar} root=${dark.rootVar}（期望 ${dark.expected}）`);
  console.log(`    余额数字色 ${dark.balanceColor} · 卡片底色 ${dark.cardBg} · 强调色 ${dark.accentColor}`);
  check("令牌注入确实生效（否则后面的量测无意义）", dark.injected === true, `host=${dark.hostVar} root=${dark.rootVar}`);
  check("余额数字色解析为深色板的主文本色 #ebdfe7", dark.balanceColor === "rgb(235, 223, 231)", String(dark.balanceColor));
  check("强调色解析为深色板主色 #9b8ae0", dark.accentColor === "rgb(155, 138, 224)", String(dark.accentColor));
  const darkContrast = await evaluate(`${CONTRAST_EXPR}(${JSON.stringify(dark.balanceRgb)}, ${JSON.stringify(dark.cardBgRgb)})`);
  check("深色下正文/底色对比度 ≥ 4.5", darkContrast >= 4.5, `对比度 ${darkContrast.toFixed(2)}`);

  console.log("\n2. 浅色令牌");
  const light = await measure(LIGHT, "light");
  console.log(`    注入校验 host=${light.hostVar} root=${light.rootVar}（期望 ${light.expected}）`);
  console.log(`    余额数字色 ${light.balanceColor} · 卡片底色 ${light.cardBg} · 强调色 ${light.accentColor}`);
  check("令牌注入确实生效", light.injected === true, `host=${light.hostVar} root=${light.rootVar}`);
  check("余额数字色解析为浅色板的主文本色 #2e2636", light.balanceColor === "rgb(46, 38, 54)", String(light.balanceColor));
  check("强调色解析为浅色板主色 #65549b", light.accentColor === "rgb(101, 84, 155)", String(light.accentColor));
  const lightContrast = await evaluate(`${CONTRAST_EXPR}(${JSON.stringify(light.balanceRgb)}, ${JSON.stringify(light.cardBgRgb)})`);
  check("浅色下正文/底色对比度 ≥ 4.5", lightContrast >= 4.5, `对比度 ${lightContrast.toFixed(2)}`);

  console.log("\n3. 两套色板确实不同（证明吃的是令牌而不是硬编码）");
  check("深浅两套量出来的颜色不同", dark.balanceColor !== light.balanceColor, `${dark.balanceColor} vs ${light.balanceColor}`);
  check("深浅两套的强调色不同", dark.accentColor !== light.accentColor, `${dark.accentColor} vs ${light.accentColor}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "全部通过" : "有失败"}：${results.length - failed.length}/${results.length}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  console.error(`验证脚本自身出错：${String(error?.message ?? error)}`);
  process.exitCode = 2;
} finally {
  try {
    ws?.close();
  } catch {
    /* 关不掉就算了 */
  }
  try {
    browser.kill();
  } catch {
    /* 同上 */
  }
}
