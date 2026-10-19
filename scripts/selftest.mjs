/**
 * 自测 —— 不依赖 DSH。
 *
 * 覆盖三件容易悄悄坏掉的事：
 *   1. slug 编码：错了就一个会话目录都匹配不上（表现为「用量永远是 0」，不报错）；
 *   2. 用量折叠：zstd 帧必须**逐帧**解，整文件一次解只会拿到 202 字节的会话头；
 *   3. 四种余额状态：用本地假服务器精确复现 200 / 401 / 503 / 未配置。
 *
 * 跑法：`E:\node\node.exe scripts/selftest.mjs`（可选 `--sessions-root <路径>`）。
 */
import { createServer } from "node:http";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ACCOUNT_RECORD_KEY,
  BALANCE_STATUS,
  BalanceReader,
  looksLikeApiKey,
  parseAccountBalance,
  parseBalance,
  readAccountGrant,
} from "../lib/balance.js";
import { workspaceSlug } from "../lib/index.js";
import { CN_HOLIDAYS, estimateCost, isPeakAt, priceOf } from "../lib/pricing.js";
import { UsageAggregator, formatMoney, formatTokens } from "../lib/usage.js";

let failures = 0;
let checks = 0;

function ok(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── 1. slug 编码 ───────────────────────────────────────────────
section("1. slug 编码");
const CASES = [
  ["E:\\deepseek工作区\\HerTa", "--E-deepseek~5DE5~4F5C~533A-HerTa--"],
  ["E:\\deepseek工作区", "--E-deepseek~5DE5~4F5C~533A--"],
  ["C:\\Users\\梦源\\.dsh", "--C-Users-~68A6~6E90-.dsh--"],
];
for (const [cwd, expected] of CASES) {
  const actual = workspaceSlug(cwd);
  ok(`${cwd}`, actual === expected, `得到 ${actual}，期望 ${expected}`);
}

// ── 2. 单价与花费 ──────────────────────────────────────────────
section("2. 单价与花费（峰谷两档）");
ok("flash 有单价", priceOf("deepseek-flash") !== null);
ok("mimo 无公开单价（应返回 null，不是 0）", priceOf("mimo-v2.6-flash") === null);
const oneMPeak = estimateCost("deepseek-flash", { cacheHit: 1_000_000, cacheMiss: 0, output: 0 });
ok("flash：高峰 1M 命中 = ￥0.04", oneMPeak !== null && Math.abs(oneMPeak - 0.04) < 1e-9, `得到 ${oneMPeak}`);
const oneMOff = estimateCost("deepseek-flash", { cacheHit: 1_000_000, cacheMiss: 0, output: 0 }, { peak: false });
ok("flash：空闲 1M 命中 = ￥0.02（官方：空闲价是高峰价一半）", oneMOff !== null && Math.abs(oneMOff - 0.02) < 1e-9, `得到 ${oneMOff}`);
const mixedPeak = estimateCost("deepseek-flash", { cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000 });
ok("flash：高峰 三段各 1M = ￥10.04", mixedPeak !== null && Math.abs(mixedPeak - 10.04) < 1e-9, `得到 ${mixedPeak}`);
const mixedOff = estimateCost("deepseek-flash", { cacheHit: 1_000_000, cacheMiss: 1_000_000, output: 1_000_000 }, { peak: false });
ok("flash：空闲 三段各 1M = ￥5.02", mixedOff !== null && Math.abs(mixedOff - 5.02) < 1e-9, `得到 ${mixedOff}`);
const proPeakMiss = estimateCost("deepseek-v4-pro", { cacheHit: 0, cacheMiss: 1_000_000, output: 0 });
ok("pro：高峰 1M 未命中 = ￥9", proPeakMiss !== null && Math.abs(proPeakMiss - 9) < 1e-9, `得到 ${proPeakMiss}`);
const proOffMiss = estimateCost("deepseek-v4-pro", { cacheHit: 0, cacheMiss: 1_000_000, output: 0 }, { peak: false });
ok("pro：空闲 1M 未命中 = ￥4.5", proOffMiss !== null && Math.abs(proOffMiss - 4.5) < 1e-9, `得到 ${proOffMiss}`);
ok("无单价模型返回 null", estimateCost("mimo-v2.6-flash", { cacheHit: 1e6, cacheMiss: 0, output: 0 }) === null);
ok("formatMoney(0.004) → <￥0.01", formatMoney(0.004) === "<￥0.01", formatMoney(0.004));
ok("formatTokens(1_275_011) → 1.28M", formatTokens(1_275_011) === "1.28M", formatTokens(1_275_011));

// ── 2b. 峰谷时段判定 ────────────────────────────────────────────
section("2b. 峰谷时段判定（北京时间、法定节假日）");
/** 把北京时间（YYYY-MM-DD HH:mm）换成 epoch ms。 */
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
const PEAK_CASES = [
  ["周一 08:59", bj(2026, 10, 19, 8, 59), false],
  ["周一 09:00（高峰起点）", bj(2026, 10, 19, 9, 0), true],
  ["周一 11:59", bj(2026, 10, 19, 11, 59), true],
  ["周一 12:00（高峰终点 = 空闲）", bj(2026, 10, 19, 12, 0), false],
  ["周一 13:59", bj(2026, 10, 19, 13, 59), false],
  ["周一 14:00（下午高峰起点）", bj(2026, 10, 19, 14, 0), true],
  ["周一 17:59", bj(2026, 10, 19, 17, 59), true],
  ["周一 18:00（下午高峰终点 = 空闲）", bj(2026, 10, 19, 18, 0), false],
  ["周六 10:00（周末全天空闲）", bj(2026, 10, 17, 10, 0), false],
  ["国庆 10-01 周四 10:00（法定节假日）", bj(2026, 10, 1, 10, 0), false],
  ["中秋 09-25 周五 10:00（法定节假日）", bj(2026, 9, 25, 10, 0), false],
  ["春节 02-17 周二 10:00（法定节假日）", bj(2026, 2, 17, 10, 0), false],
  ["01-04 周日 10:00（调休上班日也是周末）", bj(2026, 1, 4, 10, 0), false],
  ["08-14 周五 10:00（峰谷生效前一律空闲价）", bj(2026, 8, 14, 10, 0), false],
  ["08-17 周一 10:00（生效后第一个工作日）", bj(2026, 8, 17, 10, 0), true],
];
for (const [name, at, expected] of PEAK_CASES) {
  ok(`峰谷：${name}`, isPeakAt(at) === expected, `得到 ${isPeakAt(at)}，期望 ${expected}`);
}
ok("节假日表 33 天（2026 国办发明电〔2025〕7 号）", CN_HOLIDAYS.size === 33, `size=${CN_HOLIDAYS.size}`);

// ── 3. 余额响应解析 ────────────────────────────────────────────
section("3. 余额响应解析");
const OFFICIAL = {
  is_available: true,
  balance_infos: [
    { currency: "CNY", total_balance: "12.34", granted_balance: "0.00", topped_up_balance: "12.34" },
  ],
};
const parsed = parseBalance(OFFICIAL);
ok("币种", parsed?.currency === "CNY", String(parsed?.currency));
ok("总额 12.34", parsed?.total === 12.34, String(parsed?.total));
ok("赠金 0", parsed?.granted === 0, String(parsed?.granted));
ok("充值 12.34", parsed?.toppedUp === 12.34, String(parsed?.toppedUp));
ok("is_available", parsed?.isAvailable === true);
ok("两种币种时优先人民币", parseBalance({
  is_available: true,
  balance_infos: [
    { currency: "USD", total_balance: "1.00", granted_balance: "0", topped_up_balance: "1.00" },
    { currency: "CNY", total_balance: "7.00", granted_balance: "0", topped_up_balance: "7.00" },
  ],
})?.currency === "CNY");
ok("空 balance_infos → null", parseBalance({ is_available: true, balance_infos: [] }) === null);
ok("占位符不算有效密钥", looksLikeApiKey("your-key-here") === false);
ok("短串不算有效密钥", looksLikeApiKey("sk-1") === false);
ok("真形状算有效密钥", looksLikeApiKey("sk-abcdefghijklmnopqrstuvwxyz012345") === true);

// ── 3b. DSH 账号链响应解析（平台 get_user_summary 的信封）────────
section("3b. DSH 账号链余额解析");
const ACCOUNT_ENVELOPE = {
  code: 0,
  msg: "",
  data: {
    biz_code: 0,
    biz_msg: "",
    biz_data: {
      normal_wallets: [{ currency: "CNY", balance: "2.4426070600000000" }],
      bonus_wallets: [{ currency: "CNY", balance: "3.7249164000000000" }],
      total_costs: [{ currency: "CNY", amount: "158.64" }],
    },
  },
};
const accountParsed = parseAccountBalance(ACCOUNT_ENVELOPE);
ok("账号链：充值取自 normal_wallets", accountParsed?.toppedUp === 2.44260706, String(accountParsed?.toppedUp));
ok("账号链：赠金取自 bonus_wallets", accountParsed?.granted === 3.7249164, String(accountParsed?.granted));
ok("账号链：总额 = 充值 + 赠金", accountParsed?.total === 6.16752346, String(accountParsed?.total));
ok("账号链：币种", accountParsed?.currency === "CNY", String(accountParsed?.currency));
ok("账号链：无钱包 → null", parseAccountBalance({ code: 0, data: { biz_data: {} } }) === null);
ok(
  "账号链：也能吃已拆信封的 biz_data",
  parseAccountBalance({ normal_wallets: [{ currency: "CNY", balance: "1" }], bonus_wallets: [] })?.total === 1,
);
ok(
  "账号链：多种币种优先人民币",
  parseAccountBalance({
    data: {
      biz_data: {
        normal_wallets: [
          { currency: "USD", balance: "1.00" },
          { currency: "CNY", balance: "7.00" },
        ],
        bonus_wallets: [{ currency: "CNY", balance: "2.00" }],
      },
    },
  })?.total === 9,
);

// readAccountGrant：只认 grant + payload.token，且 issuer 可缺省
const grantCtx = (record) => ({ get: () => ({ readRecord: async () => record }) });
ok(
  "读账号 grant：token + issuer",
  JSON.stringify(await readAccountGrant(grantCtx({ kind: "grant", payload: { token: "t", issuer: "https://x" } }))) ===
    JSON.stringify({ token: "t", issuer: "https://x" }),
);
ok(
  "读账号 grant：缺 issuer 用默认 origin",
  (await readAccountGrant(grantCtx({ kind: "grant", payload: { token: "t" } })))?.issuer ===
    "https://platform.deepseek.com",
);
ok("读账号 grant：非 grant 记录 → null", (await readAccountGrant(grantCtx({ kind: "secret", payload: {} }))) === null);
ok("读账号 grant：凭据服务缺席 → null", (await readAccountGrant({ get: () => undefined })) === null);

// ── 4. 四种余额状态（本地假服务器）────────────────────────────
section("4. 四种余额状态");
async function balanceStateTest() {
  /** 平台账号链的假响应；由用例切换成 200 / 40003。 */
  let accountMode = "ok";
  let accountCalls = 0;
  const routes = {
    "/ok": (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(OFFICIAL));
    },
    "/unauthorized": (res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails" } }));
    },
    "/unreachable": (res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Server Overloaded" } }));
    },
    "/garbage": (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ nope: true }));
    },
    "/api/v0/users/get_user_summary": (res) => {
      accountCalls += 1;
      if (accountMode === "invalid") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ code: 40003, msg: "Authorization Failed (invalid token)", data: null }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ACCOUNT_ENVELOPE));
    },
  };
  const server = createServer((req, res) => {
    const handler = routes[req.url ?? "/"];
    if (handler === undefined) {
      res.writeHead(404).end();
      return;
    }
    handler(res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 假 ctx：凭据服务返回一把形状合法的密钥（不是真密钥 —— 只是形状）。
  const fakeCtx = (ref, value) => ({
    get: (name) => (name === "credentials" ? { resolve: async (r) => (r === ref ? { value, source: "test" } : undefined) } : undefined),
  });

  const readerFor = (path) =>
    new BalanceReader({ url: base + path, timeoutMs: 3000, ttlMs: 0 });

  const ready = await readerFor("/ok").get(fakeCtx("DEEPSEEK_API_KEY", "sk-" + "a".repeat(30)), { force: true });
  ok("200 → ready", ready.status === BALANCE_STATUS.ready, ready.status);
  ok("ready 带余额", ready.balance?.total === 12.34);

  const unauthorized = await readerFor("/unauthorized").get(fakeCtx("DEEPSEEK_API_KEY", "sk-" + "a".repeat(30)), { force: true });
  ok("401 → unauthorized", unauthorized.status === BALANCE_STATUS.unauthorized, unauthorized.status);

  const unreachable = await readerFor("/unreachable").get(fakeCtx("DEEPSEEK_API_KEY", "sk-" + "a".repeat(30)), { force: true });
  ok("503 → unreachable", unreachable.status === BALANCE_STATUS.unreachable, unreachable.status);
  ok("503 带 httpStatus", unreachable.httpStatus === 503, String(unreachable.httpStatus));

  const garbage = await readerFor("/garbage").get(fakeCtx("DEEPSEEK_API_KEY", "sk-" + "a".repeat(30)), { force: true });
  ok("形状不符 → unreachable", garbage.status === BALANCE_STATUS.unreachable, garbage.status);

  const noKey = await readerFor("/ok").get(fakeCtx("DEEPSEEK_API_KEY", undefined), { force: true });
  ok("无密钥 → unconfigured", noKey.status === BALANCE_STATUS.unconfigured, noKey.status);

  const noService = await readerFor("/ok").get({ get: () => undefined }, { force: true });
  ok("凭据服务缺席 → unconfigured", noService.status === BALANCE_STATUS.unconfigured, noService.status);

  // ── DSH 账号登录态回退 ────────────────────────────────────────
  section("4b. DSH 账号登录态回退");
  const ACCOUNT_GRANT = { kind: "grant", payload: { version: 1, token: "T".repeat(64), issuer: base } };
  const fakeCtxBoth = (keyValue, grant) => ({
    get: (name) =>
      name === "credentials"
        ? {
            resolve: async (ref) =>
              ref === "DEEPSEEK_API_KEY" && keyValue !== undefined ? { value: keyValue, source: "test" } : undefined,
            readRecord: async (key) => (key === ACCOUNT_RECORD_KEY && grant !== undefined ? grant : undefined),
          }
        : undefined,
  });
  const okReader = () => new BalanceReader({ url: base + "/ok", timeoutMs: 3000, ttlMs: 0 });
  const badKeyReader = () => new BalanceReader({ url: base + "/unauthorized", timeoutMs: 3000, ttlMs: 0 });

  accountCalls = 0;
  const viaApiKey = await okReader().get(fakeCtxBoth("sk-" + "a".repeat(30), ACCOUNT_GRANT), { force: true });
  ok("有可用 API key 时优先 API key", viaApiKey.status === BALANCE_STATUS.ready && viaApiKey.source === "api-key", `${viaApiKey.status}/${viaApiKey.source}`);
  ok("API key 成功时完全不碰账号链", accountCalls === 0, `账号链被打了 ${accountCalls} 次`);

  accountCalls = 0;
  const viaAccount = await badKeyReader().get(fakeCtxBoth("sk-" + "a".repeat(30), ACCOUNT_GRANT), { force: true });
  ok(
    "API key 被拒 → 回退账号链成功",
    viaAccount.status === BALANCE_STATUS.ready && viaAccount.source === "dsh-account",
    `${viaAccount.status}/${viaAccount.source} ${viaAccount.detail ?? ""}`,
  );
  ok("账号链余额取自钱包拆分", viaAccount.balance?.total === 6.16752346, String(viaAccount.balance?.total));
  ok("账号链只请求一次", accountCalls === 1, `打了 ${accountCalls} 次`);

  const noKeyViaAccount = await readerFor("/ok").get(fakeCtxBoth(undefined, ACCOUNT_GRANT), { force: true });
  ok(
    "没有 API key 时直接用账号链",
    noKeyViaAccount.status === BALANCE_STATUS.ready && noKeyViaAccount.source === "dsh-account",
    `${noKeyViaAccount.status}/${noKeyViaAccount.source}`,
  );

  accountMode = "invalid";
  const bothBad = await badKeyReader().get(fakeCtxBoth("sk-" + "a".repeat(30), ACCOUNT_GRANT), { force: true });
  ok("API key 被拒 + 账号登录态失效 → unauthorized", bothBad.status === BALANCE_STATUS.unauthorized, bothBad.status);
  ok("失败原因两条都写出来", String(bothBad.detail).includes("账号"), String(bothBad.detail));
  accountMode = "ok";

  accountCalls = 0;
  const noFallback = await new BalanceReader({ url: base + "/unauthorized", timeoutMs: 3000, ttlMs: 0, accountFallback: false }).get(
    fakeCtxBoth("sk-" + "a".repeat(30), ACCOUNT_GRANT),
    { force: true },
  );
  ok("accountFallback=false 时保持原行为", noFallback.status === BALANCE_STATUS.unauthorized && accountCalls === 0, `${noFallback.status}/${accountCalls}`);

  const noGrant = await readerFor("/ok").get(fakeCtxBoth(undefined, undefined), { force: true });
  ok("没有账号记录时如实说", noGrant.status === BALANCE_STATUS.unconfigured && String(noGrant.detail).includes("账号记录"), `${noGrant.status} ${noGrant.detail}`);

  // 缓存：ttl 内第二次不应再打服务器。
  let hits = 0;
  const counting = createServer((req, res) => {
    hits += 1;
    routes["/ok"](res);
  });
  await new Promise((resolve) => counting.listen(0, "127.0.0.1", resolve));
  const cachedReader = new BalanceReader({ url: `http://127.0.0.1:${counting.address().port}/ok`, ttlMs: 60_000 });
  const ctx2 = fakeCtx("DEEPSEEK_API_KEY", "sk-" + "a".repeat(30));
  await cachedReader.get(ctx2);
  await cachedReader.get(ctx2);
  ok("ttl 内命中缓存，只打一次服务器", hits === 1, `打了 ${hits} 次`);

  await new Promise((resolve) => counting.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}

// ── 5. 用量折叠（真实会话日志）─────────────────────────────────
section("5. 用量折叠（真实会话日志）");
async function usageTest(sessionsRoot) {
  const slug = workspaceSlug("E:\\deepseek工作区\\HerTa");
  let names = [];
  try {
    names = readdirSync(sessionsRoot);
  } catch (error) {
    ok(`能读到会话根目录 ${sessionsRoot}`, false, String(error?.message ?? error));
    return;
  }
  const matched = names.filter((n) => statSync(join(sessionsRoot, n)).isDirectory() && n === slug);
  ok(`slug 能在真实目录里命中（${slug}）`, matched.length === 1, `命中 ${matched.length} 个：${names.join(", ")}`);

  const aggregator = new UsageAggregator({
    sessionsRoot,
    workspaceSlug: slug,
    offsetMinutes: 480,
  });
  const t0 = Date.now();
  const scan = await aggregator.collect();
  const coldMs = Date.now() - t0;
  const summary = aggregator.summarize();

  console.log(`    文件 ${scan.files} 个，重算 ${scan.changed} 个，耗时 ${coldMs} ms`);
  console.log(`    事件 ${summary.totals.events} 次调用`);
  console.log(`    今日   ${formatTokens(summary.windows.today.hit + summary.windows.today.miss + summary.windows.today.out)} · ${formatMoney(summary.windows.today.cost)}`);
  console.log(`    近 7 天 ${formatTokens(summary.windows.week.hit + summary.windows.week.miss + summary.windows.week.out)} · ${formatMoney(summary.windows.week.cost)}`);
  console.log(`    本月   ${formatTokens(summary.windows.month.hit + summary.windows.month.miss + summary.windows.month.out)} · ${formatMoney(summary.windows.month.cost)}`);
  console.log(`    全部   ${formatTokens(summary.windows.all.hit + summary.windows.all.miss + summary.windows.all.out)} · ${formatMoney(summary.windows.all.cost)}`);

  ok("扫到了会话文件", scan.files > 0, `files=${scan.files}`);
  ok("折出了调用事件", summary.totals.events > 0, `events=${summary.totals.events}`);
  ok("近 7 天 ≥ 今日", summary.windows.week.calls >= summary.windows.today.calls);
  ok("本月 ≥ 近 7 天", summary.windows.month.calls >= summary.windows.week.calls);
  ok("全部 ≥ 本月", summary.windows.all.calls >= summary.windows.month.calls);
  ok("有缓存命中 token（证明逐帧解压生效）", summary.windows.all.hit > 0, `hit=${summary.windows.all.hit}`);
  for (const [key, win] of Object.entries(summary.windows)) {
    ok(`峰谷次数之和 = 调用次数（${key}）`, win.peakCalls + win.offPeakCalls === win.calls, `${win.peakCalls}+${win.offPeakCalls} vs ${win.calls}`);
    if (!win.unpriced) {
      ok(`峰谷花费之和 = 总花费（${key}）`, Math.abs(win.peakCost + win.offPeakCost - win.cost) < 1e-9, `${win.peakCost}+${win.offPeakCost} vs ${win.cost}`);
    }
  }

  // 增量：第二次几乎不动任何文件，且数字不变。
  const t1 = Date.now();
  const scan2 = await aggregator.collect();
  const warmMs = Date.now() - t1;
  const summary2 = aggregator.summarize();
  console.log(`    第二轮：重算 ${scan2.changed} 个，耗时 ${warmMs} ms`);
  ok("第二轮跳过未变文件", scan2.changed === 0, `changed=${scan2.changed}`);
  ok("第二轮数字一致", summary2.windows.all.calls === summary.windows.all.calls, `${summary2.windows.all.calls} vs ${summary.windows.all.calls}`);

  // ── 落盘缓存：换一个**新进程**最关心的场景 —— 进程重启后第一次打开要快 ──
  const cachePath = join(tmpdir(), `dsh-balance-card-selftest-${process.pid}.json`);
  const fresh = new UsageAggregator({ sessionsRoot, workspaceSlug: slug, offsetMinutes: 480, cachePath });
  const tSave = Date.now();
  const coldScan = await fresh.collect();
  const fullParseMs = Date.now() - tSave;
  const coldSummary = fresh.summarize();
  const saved = await fresh.saveCache();
  ok("能写出落盘缓存", saved === true, cachePath);

  const warmed = new UsageAggregator({ sessionsRoot, workspaceSlug: slug, offsetMinutes: 480, cachePath });
  const loaded = await warmed.loadCache();
  const tWarm = Date.now();
  await warmed.collect();
  const warmFromCacheMs = Date.now() - tWarm;
  const warmSummary = warmed.summarize();
  ok("能装载落盘缓存", loaded === true);
  ok("装缓存后数字与全量一致", warmSummary.windows.all.calls === coldSummary.windows.all.calls,
    `${warmSummary.windows.all.calls} vs ${coldSummary.windows.all.calls}`);
  ok("装缓存后同一窗口花费也一致", Math.abs(warmSummary.windows.month.cost - coldSummary.windows.month.cost) < 1e-9);
  console.log(`    全量 ${fullParseMs} ms → 装缓存后 ${warmFromCacheMs} ms（提速约 ${(fullParseMs / Math.max(1, warmFromCacheMs)).toFixed(1)}×）`);
  ok("装缓存后明显更快（至少 5×）", warmFromCacheMs * 5 < fullParseMs, `${warmFromCacheMs} ms vs ${fullParseMs} ms`);

  // 缓存键必须认 size+mtime：伪造一个「mtime 变了」的条目，应当被当作失效而重算。
  const stale = new UsageAggregator({ sessionsRoot, workspaceSlug: slug, offsetMinutes: 480, cachePath });
  await stale.loadCache();
  for (const entry of stale.files.values()) entry.mtimeMs = 1;
  const staleScan = await stale.collect();
  ok("缓存键带 mtime：伪造 mtime 后全部重算（证明不会读到陈旧数字）", staleScan.changed === staleScan.files, `changed=${staleScan.changed} files=${staleScan.files}`);

  // 坏缓存不该让插件崩
  writeFileSync(cachePath, "{ 这不是 JSON", "utf8");
  const broken = new UsageAggregator({ sessionsRoot, workspaceSlug: slug, offsetMinutes: 480, cachePath });
  const brokenLoaded = await broken.loadCache();
  ok("坏缓存被安全忽略（不抛错）", brokenLoaded === false);
  await broken.collect();
  ok("坏缓存后仍能正常聚合", broken.summarize().windows.all.calls === coldSummary.windows.all.calls);
  rmSync(cachePath, { force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  const idx = argv.indexOf("--sessions-root");
  const sessionsRoot =
    idx !== -1 && argv[idx + 1] !== undefined
      ? argv[idx + 1]
      : join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? "", ".dsh"), "sessions");

  await balanceStateTest();
  await usageTest(sessionsRoot);

  console.log(`\n${failures === 0 ? "全部通过" : "有失败"}：${checks - failures}/${checks}`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
