/**
 * dsh-balance-card —— 宿主侧。
 *
 * 干三件事：
 *   1. 按需（而不是常驻）刷新**用量**：增量解压会话日志、折成今日/近 7 天/本月的 token 与估算花费；
 *   2. 按需读**官方余额**：`ctx.credentials` 现读密钥 → `api.deepseek.com/user/balance` → 5 分钟缓存；
 *   3. 把两样东西经**自己的一条 HTTP 路由**下发给卡片（密钥永不出宿主）。
 *
 * ## 为什么用 `ctx.inject(["webServer"], cb)` 而不是 `ctx.get("webServer")`
 *
 * 宿主行的挂载**早于** webserver 行就绪：那时 `ctx.get("webServer")` 拿到的是
 * `undefined`，直接用它 + 早退就变成「静默不注册任何路由」（页面上全 404，错误哪里都不出现）。
 * `ctx.inject` 等服务出现再回调；在无头组合里它只是不触发，不会把插件卡成 PENDING。
 * 这条结论来自上游 `dsh-herta` 的实测注释，这里照抄同一写法。
 *
 * ## 所有副作用都包在 `ctx.effect(...)` 里
 *
 * 返回 disposer，随 fiber 释放 —— 卸载插件时路由与缓存一起消失（验收标准第 5 条）。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACCOUNT_RECORD_KEY, BALANCE_STATUS, BalanceReader, DEFAULT_KEY_REF } from "./balance.js";
import { CURRENCY, CURRENCY_SYMBOL, PRICING_SOURCE, PRICING_VERIFIED_AT } from "./pricing.js";
import { UsageAggregator } from "./usage.js";

/** 与 `cordis.patch.yml` 里的 loader 条目 id 一致。 */
export const name = "balance-card";

/**
 * 要注入的服务。
 *
 * `webServer` 用于注册自己的路由；`workspaceRegistry` 用来问「现在的工作区是哪个」，
 * 但它不一定存在（精简组合里没有），所以只用 `ctx.get` 做可选读取。
 */
export const inject = ["webServer"];

/** 卡片数据路由前缀。客户端里写死同一个值（相对路径，无前导斜杠）。 */
export const DATA_ROUTE = "/balance-card";

/**
 * 按钮图标的目录与白名单。
 *
 * 只有一个文件，所以白名单是**写死的一条** —— 这样根本不存在路径穿越的可能，
 * 不需要写 `../` 过滤与规范化（那是最容易写错的一类安全代码）。
 * 换图只需替换 `lib/assets/icon.png`（生成脚本见 `scripts/build-icon.mjs`）。
 */
const ICON_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const ICON_FILES = {
  "icon.png": "image/png",
  "icon@2x.png": "image/png",
};

/**
 * 把 cwd 编成 DSH 的会话目录 slug。
 *
 * 规则（逐条对照 `C:\Users\梦源\.dsh\sessions` 下真实目录名反推出来的）：
 *   1. 去掉结尾的分隔符；
 *   2. 去掉盘符后的冒号（`E:` → `E`）；
 *   3. **先**把分隔符换成 `-`；
 *   4. **再**把每个**非 ASCII 字符**换成 `~` + **该字符码点的四位大写十六进制** ——
 *      「工」= U+5DE5 → `~5DE5`（注意不是 UTF-8 字节 `~E5~B7~A5`）；
 *   5. 整体包在 `--…--` 里。
 *
 * 例：`E:\deepseek工作区\HerTa` → `--E-deepseek~5DE5~4F5C~533A-HerTa--`。
 *
 * ⚠️ 这里错了**不会报任何错**，只会一个会话目录都匹配不上，表现为「用量永远是 0」。
 * 所以自测里对这个函数是逐例断言，不是随手跑一下。
 *
 * 只用来**比对**，不做反向解码（slug 不可逆）。
 */
export function workspaceSlug(cwd) {
  const trimmed = String(cwd).replace(/[\\/]+$/u, "");
  const noColon = trimmed.replace(/^([A-Za-z]):/u, "$1");
  const dashed = noColon.replace(/[\\/]/gu, "-");
  let out = "";
  for (const ch of dashed) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) {
      out += ch;
    } else if (cp <= 0xffff) {
      out += "~" + cp.toString(16).toUpperCase().padStart(4, "0");
    } else {
      // 星平面字符（emoji 等）：拆成代理对，各写四位 —— DSH 的编码器按 UTF-16 单元走。
      for (let i = 0; i < ch.length; i += 1) {
        out += "~" + ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, "0");
      }
    }
  }
  return "--" + out + "--";
}

/** 本机时区相对 UTC 的偏移（分钟，东为正）。渲染进程与宿主同机，所以固定偏移够用。 */
function localOffsetMinutes() {
  // getTimezoneOffset() 的符号与直觉相反：UTC+8 返回 -480。
  return -new Date().getTimezoneOffset();
}

/** 解析配置里的路径（支持 `~`）。 */
function resolvePath(p, fallback) {
  const raw = typeof p === "string" && p.trim() !== "" ? p.trim() : fallback;
  if (raw.startsWith("~")) return join(homedir(), raw.slice(1));
  return raw;
}

/** 从 DSH_HOME 推会话目录。 */
function defaultSessionsRoot() {
  const home =
    typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
  return join(home, "sessions");
}

/** 默认缓存位置：`<DSH_HOME>/cache/dsh-balance-card/events.json`。 */
function defaultCachePath() {
  const home =
    typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME !== ""
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
  return join(home, "cache", "dsh-balance-card", "events.json");
}

/**
 * 猜当前工作区。
 *
 * 刻意**不去注入** `workspaceRegistry` / `workspace`：那些服务在不同组合里名字与
 * 行为都不一样，注入一个不存在的服务会把整行卡住。这里按「配置 > 进程 cwd」拿，
 * 需要更精确时由配置显式指定 —— 一个不精确但绝不失败的默认，好过精确但会挂的猜测。
 */
function defaultWorkspace() {
  return process.cwd();
}

/**
 * schemastery 由宿主提供，用 `createRequire` **同步**取 —— 刻意不用顶层 `await import`：
 * 顶层 await 会把整个模块变成异步模块，万一某个加载路径不接受异步模块，
 * 代价是整行加载失败；而这里没有必须异步的理由。
 */
function loadSchema() {
  try {
    const mod = createRequire(import.meta.url)("@deepseek-ai/schemastery");
    // 同一个包在不同运行时里可能解析到**两种构建**：ESM（导出在 .default 上）或 CJS
    // （module.exports 本身就是 Schema，没有 .default）。只取 .default 会在 CJS 下拿到
    // undefined —— 不抛错、绕过下面的 null 分支，然后在 z.object 处把整个 bundle 加载炸掉
    // （实测：dsh 0.2.1-rc.2 的 profile 运行时 + link 安装会走 CJS）。两种都要吃。
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

/** 配置字段表 —— 默认值、取值范围、说明都集中在这里。 */
const FIELDS = {
  /** 密钥引用名 —— 与 DSH provider 配置里的 `apiKeyEnv` 对齐即可。 */
  keyRef: { kind: "string", def: DEFAULT_KEY_REF },
  /** 会话日志根目录。默认 `$DSH_HOME/sessions`；lab 里可指向真实 home 以显示真数字。 */
  sessionsRoot: { kind: "string", def: "" },
  /** 只统计这个工作区。空 = 用宿主当前工作目录。 */
  workspace: { kind: "string", def: "" },
  /**
   * 落盘缓存路径。默认 `<DSH_HOME>/cache/dsh-balance-card/events.json`；
   * 显式配置成 `-` 可禁用（纯内存）。
   */
  cachePath: { kind: "string", def: "auto" },
  /** 余额缓存时长（毫秒）。 */
  balanceTtlMs: { kind: "number", def: 300_000, min: 0, max: 3_600_000 },
  /** 单次余额请求超时（毫秒）。 */
  balanceTimeoutMs: { kind: "number", def: 8_000, min: 1_000, max: 60_000 },
  /** 覆盖官方余额接口（用于本地假服务器验证四种失败态）。 */
  balanceUrl: { kind: "string", def: "" },
  /** 测试钩子：`ok` / `unconfigured` / `unauthorized` / `unreachable`。设了就完全不碰网络。 */
  mockBalance: { kind: "string", def: "" },
  /** API key 不可用（未配置 / 被拒）时是否回退到 DSH 账号登录态。 */
  accountFallback: { kind: "boolean", def: true },
  /** DSH 账号 grant 在凭据服务里的记录名。 */
  accountRecord: { kind: "string", def: ACCOUNT_RECORD_KEY },
  /** 平台账号接口 origin；空 = 用 grant 里的 issuer。 */
  platformOrigin: { kind: "string", def: "" },
  /** 打印调试日志。 */
  debug: { kind: "boolean", def: false },
};

export const Config = (() => {
  const z = loadSchema();
  if (z === null || z === undefined || typeof z.object !== "function") return undefined;
  const clamp = (field, value) => {
    const spec = FIELDS[field];
    if (value < spec.min) return spec.min;
    if (value > spec.max) return spec.max;
    return value;
  };
  return z.object({
    keyRef: z.string().default(FIELDS.keyRef.def).volatile(),
    sessionsRoot: z.string().default(FIELDS.sessionsRoot.def).volatile(),
    workspace: z.string().default(FIELDS.workspace.def).volatile(),
    cachePath: z.string().default(FIELDS.cachePath.def).volatile(),
    balanceTtlMs: z
      .number()
      .min(FIELDS.balanceTtlMs.min)
      .max(FIELDS.balanceTtlMs.max)
      .default(FIELDS.balanceTtlMs.def)
      .volatile(),
    balanceTimeoutMs: z
      .number()
      .min(FIELDS.balanceTimeoutMs.min)
      .max(FIELDS.balanceTimeoutMs.max)
      .default(FIELDS.balanceTimeoutMs.def)
      .volatile(),
    balanceUrl: z.string().default(FIELDS.balanceUrl.def).volatile(),
    mockBalance: z.string().default(FIELDS.mockBalance.def).volatile(),
    accountFallback: z.boolean().default(FIELDS.accountFallback.def).volatile(),
    accountRecord: z.string().default(FIELDS.accountRecord.def).volatile(),
    platformOrigin: z.string().default(FIELDS.platformOrigin.def).volatile(),
    debug: z.boolean().default(FIELDS.debug.def).volatile(),
  });
})();

/**
 * 读一个配置项。
 *
 * 带 `.volatile()` 的字段在运行时是**活引用**，要先 `.get()`；但 Config 也可能
 * 不存在（schemastery 不可用时），那时传来的是普通对象。所以两种都吃。
 */
function readConfig(config, field) {
  const raw = config?.[field];
  const value = raw !== null && typeof raw === "object" && typeof raw.get === "function" ? raw.get() : raw;
  if (value === undefined || value === null || value === "") return FIELDS[field].def;
  const spec = FIELDS[field];
  if (spec.kind === "number" && typeof value === "number") {
    return Math.min(Math.max(value, spec.min), spec.max);
  }
  if (spec.kind === "string" && typeof value !== "string") return spec.def;
  if (spec.kind === "boolean") return value === true;
  return value;
}

/** 造一个假的余额读取器，用来精确复现四种失败态。 */
function mockBalanceReader(kind) {
  return async (now) => {
    if (kind === "ok") {
      return {
        status: BALANCE_STATUS.ready,
        at: now,
        balance: {
          currency: "CNY",
          total: 12.34,
          granted: 0,
          toppedUp: 12.34,
          isAvailable: true,
          others: [],
        },
      };
    }
    if (kind === "unauthorized") {
      return {
        status: BALANCE_STATUS.unauthorized,
        at: now,
        httpStatus: 401,
        detail: "mock：官方接口拒绝了这个密钥（HTTP 401）",
      };
    }
    if (kind === "unreachable") {
      return { status: BALANCE_STATUS.unreachable, at: now, detail: "mock：请求超时" };
    }
    return { status: BALANCE_STATUS.unconfigured, at: now, detail: "mock：未配置" };
  };
}

/** JSON 响应。 */
function sendJson(res, statusCode, body) {
  const text = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

/**
 * 插件入口。
 * @param ctx cordis 上下文。
 * @param config 见 `Config`。
 */
export function apply(ctx, config) {
  const debug = readConfig(config, "debug") === true;
  const log = (msg) => {
    if (debug) console.log(`[dsh-balance-card] ${msg}`);
  };

  const sessionsRoot = resolvePath(readConfig(config, "sessionsRoot"), defaultSessionsRoot());
  const workspace = resolvePath(readConfig(config, "workspace"), defaultWorkspace());
  const slug = workspaceSlug(workspace);

  const cacheSetting = readConfig(config, "cachePath");
  const cachePath = cacheSetting === "-" || cacheSetting === "off" ? "" : cacheSetting === "auto" || cacheSetting === "" ? defaultCachePath() : cacheSetting;

  const usage = new UsageAggregator({
    sessionsRoot,
    workspaceSlug: slug,
    offsetMinutes: localOffsetMinutes(),
    cachePath,
  });

  const mock = readConfig(config, "mockBalance");
  /** 落盘缓存是否已在进程内装载过（只装一次）。 */
  let cacheLoadedOnce = false;
  const balance = new BalanceReader({
    keyRef: readConfig(config, "keyRef"),
    ttlMs: readConfig(config, "balanceTtlMs"),
    timeoutMs: readConfig(config, "balanceTimeoutMs"),
    url: readConfig(config, "balanceUrl") === "" ? undefined : readConfig(config, "balanceUrl"),
    mock: mock === "" ? null : mockBalanceReader(mock),
    accountFallback: readConfig(config, "accountFallback") !== false,
    accountRecord: readConfig(config, "accountRecord"),
    platformOrigin: readConfig(config, "platformOrigin"),
  });

  log(`已挂载：sessionsRoot=${sessionsRoot}`);
  log(`工作区 slug=${slug}`);
  if (mock !== "") log(`mockBalance=${mock}（不会碰网络）`);

  /**
   * 取数据。用量每次刷新都算（增量的，绝大多数文件会被 mtime+size 跳过）；
   * 余额走自身缓存。
   * @param force 手动刷新：跳过余额缓存。
   */
  async function snapshot(force) {
    // 落盘缓存只在**进程内第一次**取数时装载一次。
    if (cachePath !== "" && !cacheLoadedOnce) {
      cacheLoadedOnce = true;
      try {
        await mkdir(dirname(cachePath), { recursive: true });
        const hit = await usage.loadCache();
        log(hit ? `已装载事件缓存：${cachePath}` : `无可用事件缓存，本轮全量解析（${cachePath}）`);
      } catch (error) {
        log(`事件缓存装载失败（继续跑，不致命）：${String(error?.message ?? error)}`);
      }
    }

    const scan = await usage.collect();
    const sum = usage.summarize();
    const bal = await balance.get(ctx, { force: force === true });

    // 有变化才落盘。这里**等它写完**：缓存是首开提速的关键，如果异步写而用户在首开后
    // 立刻再打开一次，第二次会撞上还没写完的缓存，导致又全量解析一遍（实测过这个竞态）。
    // 写一次约 40 ms，相对全量解析的 2.5 秒可以忽略。
    if (cachePath !== "" && scan.changed > 0) {
      const ok = await usage.saveCache();
      if (ok) log(`事件缓存已更新：${cachePath}`);
    }

    return {
      generatedAt: Date.now(),
      balance: bal,
      usage: sum,
      scan: { ...scan, changedThisRound: usage.lastChanged, cachePath: cachePath === "" ? null : cachePath },
      pricing: {
        currency: CURRENCY,
        symbol: CURRENCY_SYMBOL,
        source: PRICING_SOURCE,
        verifiedAt: PRICING_VERIFIED_AT,
        peakOnly: true,
      },
    };
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: "prefix",
      path: DATA_ROUTE,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? DATA_ROUTE, "http://127.0.0.1");
          const force = url.searchParams.get("force") === "1";

          if (url.pathname === `${DATA_ROUTE}/snapshot` || url.pathname === DATA_ROUTE) {
            sendJson(res, 200, await snapshot(force));
            return;
          }
          if (url.pathname === `${DATA_ROUTE}/refresh`) {
            // 手动刷新：丢掉余额缓存 + 重算用量。
            balance.invalidate();
            sendJson(res, 200, await snapshot(true));
            return;
          }
          if (url.pathname === `${DATA_ROUTE}/health`) {
            sendJson(res, 200, {
              ok: true,
              plugin: name,
              sessionsRoot,
              workspace,
              slug,
              mock: mock === "" ? null : mock,
              files: usage.files.size,
              lastScanAt: usage.lastScanAt,
              // 诊断用：最近一次余额来自哪条链（api-key / dsh-account）、结果与时间。
              balanceLast: balance.last === null
                ? null
                : { status: balance.last.status, source: balance.last.source ?? null, at: balance.last.at },
              // 诊断用：宿主自己看到的图标目录与白名单，排查「页面拿不到图」时第一眼要看的东西。
              iconDir: ICON_DIR,
              iconWhitelist: Object.keys(ICON_FILES),
              hostNow: new Date().toISOString(),
            });
            return;
          }

          // 按钮图标：白名单里的一条。浏览器从卡片里按相对路径请求，
          // 所以拿到的就是当前主题下的按钮图。
          if (url.pathname === `${DATA_ROUTE}/icon.png` || url.pathname === `${DATA_ROUTE}/icon@2x.png`) {
            const file = url.pathname.slice(DATA_ROUTE.length + 1);
            const type = ICON_FILES[file];
            const full = join(ICON_DIR, file);
            try {
              const info = await stat(full);
              const body = await readFile(full);
              res.statusCode = 200;
              res.setHeader("content-type", type);
              res.setHeader("content-length", String(info.size));
              res.setHeader("cache-control", "no-cache"); // 换图后要立刻生效
              res.setHeader("etag", `"${info.size}-${Math.round(info.mtimeMs)}"`);
              if (req.headers["if-none-match"] === res.getHeader("etag")) {
                res.statusCode = 304;
                res.end();
                return;
              }
              res.end(body);
            } catch (error) {
              // 图标缺失不该让卡片坏掉：客户端会把 img 藏起来、退回内置的 SVG。
              // 但失败原因必须能查 —— 所以带上宿主自己看到的路径与 errno，而不是只回一句 404。
              sendJson(res, 404, {
                ok: false,
                error: `icon not found: ${file}`,
                iconDir: ICON_DIR,
                resolved: full,
                errno: error?.code ?? null,
                message: String(error?.message ?? error),
              });
            }
            return;
          }

          sendJson(res, 404, { ok: false, error: "unknown route" });
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    });
    log(`数据路由已挂：${DATA_ROUTE}`);
    return dispose;
  }, "dsh-balance-card: data route");
}
