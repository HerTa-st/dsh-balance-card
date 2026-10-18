/**
 * 余额查询 —— 两条来源，按顺序：
 *
 * 1. **官方 API key**：`GET https://api.deepseek.com/user/balance`，
 *    返回 `total_balance / granted_balance / topped_up_balance`，权威、与登录态无关。
 * 2. **DSH 账号登录态（回退）**：`GET <platformOrigin>/api/v0/users/get_user_summary`，
 *    令牌取自 DSH 凭据服务里 `deepseek-account-platform/default` 记录的
 *    `payload.token`，请求头 `x-dsh-auth-token`（与 DSH 自己的账号链一致）。
 *    平台返回 `normal_wallets`（充值）与 `bonus_wallets`（赠金）两组钱包 ——
 *    同样能拼出「总额 + 赠金 + 充值」的拆分。
 *
 * 为什么要回退：DSH 桌面版默认用**账号登录**（`deepseek-account` provider），
 * 很多环境里 `DEEPSEEK_API_KEY` 没配或已失效；这时卡片不该只显示「密钥无效」。
 * 账号链只在 API key 不可用（未配置 / 被拒）时使用，有效 API key 仍然优先。
 *
 * ## 密钥/令牌的处理
 *
 * 两样都走 DSH 的凭据服务现读，**不落盘、不缓存明文、不进日志**：
 *   `ctx.credentials.resolve("DEEPSEEK_API_KEY")` → `{ value, source }`
 *   `ctx.credentials.readRecord("deepseek-account-platform/default")` → `{ kind, payload }`
 * 解析优先级由 DSH 自己决定，所以这里不需要知道密钥存在哪，也不该去读 YAML。
 *
 * 客户端拿不到密钥 —— 官方明写 "Secret values cross in one direction only"，
 * `ctx.remote.credentials` 只有 `describe/set/unset`。所以本模块**只在宿主侧运行**。
 */

import { CURRENCY } from "./pricing.js";

/** 官方余额接口。 */
const BALANCE_URL = "https://api.deepseek.com/user/balance";

/** 默认密钥引用名 —— 与官方 `llm-deepseek-api-key` 的默认值一致。 */
export const DEFAULT_KEY_REF = "DEEPSEEK_API_KEY";

/**
 * DSH 账号登录态在凭据服务里的记录名。
 *
 * 与 `@deepseek-ai/dsh-deepseek-account-platform` 的 `credentialKey("deepseek-account-platform", "default")`
 * 完全一致 —— 这里刻意用**字符串字面量**而不是 import 那个包：卡片不依赖 DSH 内部包，
 * 记录不存在时按「未登录」处理即可。
 */
export const ACCOUNT_RECORD_KEY = "deepseek-account-platform/default";

/** 平台账号接口的默认 origin；记录里的 `issuer` 优先。 */
export const DEFAULT_PLATFORM_ORIGIN = "https://platform.deepseek.com";

/** 平台余额接口路径 —— 与 DSH 自己 `account.getBalance` 打的是同一条。 */
const ACCOUNT_BALANCE_PATH = "/api/v0/users/get_user_summary";

/**
 * 状态常量。卡片按这个决定怎么画，**不要**把失败画成红色横幅 —— 余额查不到
 * 不等于用户不能干活。
 */
export const BALANCE_STATUS = {
  /** 服务正常，拿到余额。 */
  ready: "ready",
  /** 没有配置密钥（或凭据服务不在）。 */
  unconfigured: "unconfigured",
  /** 密钥无效 / 被拒（401、403）。 */
  unauthorized: "unauthorized",
  /** 断网、超时、5xx、响应不是预期形状。 */
  unreachable: "unreachable",
};

/**
 * 从凭据服务读一把密钥。
 *
 * 用 `ctx.get("credentials")` 而不是硬注入：服务缺席时（无头/精简组合）应当优雅降级，
 * 而不是把整个插件卡成 PENDING —— 这与 `dsh-herta` 里 `credentialReader` 的写法一致。
 *
 * @param ctx cordis 上下文。
 * @param ref 引用名。
 * @returns 密钥字符串，或 `null`（未配置）。
 */
export async function readApiKey(ctx, ref) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined || credentials === null) return null;
  try {
    const hit = await credentials.resolve(ref);
    if (hit === undefined || hit === null) return null;
    const value = typeof hit.value === "string" ? hit.value.trim() : "";
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

/** 判断一把密钥长得像不像有效（挡掉 `"your-key-here"` 这类占位符）。 */
export function looksLikeApiKey(value) {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 16) return false;
  return !/^(your|changeme|placeholder|none|test|xxx)/iu.test(v);
}

/**
 * 读 DSH 账号登录态（浏览器登录后由 DSH 存在凭据服务里的 grant）。
 *
 * 与 `readApiKey` 一样用 `ctx.get("credentials")` 而不是硬注入：服务缺席时优雅降级。
 * 只读记录、**不删**、不发请求 —— 令牌被平台拒绝时也不清账号（清账号是 DSH 自己的职责，
 * 卡片不该因为一次查询把用户登出）。
 *
 * @param ctx cordis 上下文。
 * @param recordKey 记录名，默认 {@link ACCOUNT_RECORD_KEY}。
 * @returns `{ token, issuer }`，或 `null`（未登录 / 服务缺席 / 记录格式不符）。
 */
export async function readAccountGrant(ctx, recordKey = ACCOUNT_RECORD_KEY) {
  const credentials = ctx.get("credentials");
  if (credentials === undefined || credentials === null) return null;
  if (typeof credentials.readRecord !== "function") return null;
  try {
    const record = await credentials.readRecord(recordKey);
    if (record === undefined || record === null || record.kind !== "grant") return null;
    const payload = record.payload;
    if (payload === null || typeof payload !== "object") return null;
    const token = typeof payload.token === "string" ? payload.token.trim() : "";
    if (token === "") return null;
    const issuer =
      typeof payload.issuer === "string" && payload.issuer.trim() !== ""
        ? payload.issuer.trim().replace(/\/+$/u, "")
        : DEFAULT_PLATFORM_ORIGIN;
    return { token, issuer };
  } catch {
    return null;
  }
}

/**
 * 解析官方响应里的 `balance_infos`。
 *
 * 官方字段（金额一律是字符串，保留服务端精度）：
 * `currency`（`CNY` | `USD`）、`total_balance`、`granted_balance`、`topped_up_balance`；
 * 顶层还有 `is_available`（余额够不够继续调用）。
 *
 * @param payload 已解析的 JSON。
 * @param preferredCurrency 优先取哪种币种，默认人民币。
 */
export function parseBalance(payload, preferredCurrency = CURRENCY) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  if (infos.length === 0) return null;
  const pick =
    infos.find((i) => i?.currency === preferredCurrency) ??
    infos.find((i) => i?.currency === "CNY") ??
    infos[0];
  const decimal = (v) => {
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  return {
    currency: typeof pick?.currency === "string" ? pick.currency : CURRENCY,
    total: decimal(pick?.total_balance),
    granted: decimal(pick?.granted_balance),
    toppedUp: decimal(pick?.topped_up_balance),
    isAvailable: payload?.is_available === true,
    others: infos
      .filter((i) => i !== pick)
      .map((i) => ({ currency: i?.currency, total: decimal(i?.total_balance) })),
  };
}

/**
 * 解析 DSH 账号链的余额响应（平台 `get_user_summary`）。
 *
 * 平台把钱包分成两组：`normal_wallets`（充值余额）与 `bonus_wallets`（赠金余额），
 * 金额同样是字符串。拼法与官方接口一致：`total = 充值 + 赠金`。
 * 响应可能带 `{ code, msg, data: { biz_code, biz_data } }` 信封，也可能已经是 `biz_data`，
 * 两种都吃 —— DSH 自己的 `requestAccount` 会先拆一层信封。
 *
 * @param payload 已解析的 JSON。
 * @param preferredCurrency 优先取哪种币种，默认人民币。
 * @returns 与 {@link parseBalance} 同形状的余额对象，或 `null`（没有钱包数据）。
 */
export function parseAccountBalance(payload, preferredCurrency = CURRENCY) {
  const data = payload?.data?.biz_data ?? payload?.biz_data ?? payload ?? null;
  const normal = Array.isArray(data?.normal_wallets) ? data.normal_wallets : [];
  const bonus = Array.isArray(data?.bonus_wallets) ? data.bonus_wallets : [];
  if (normal.length === 0 && bonus.length === 0) return null;
  const decimal = (v) => {
    const n = typeof v === "string" ? Number.parseFloat(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const currencies = [
    ...new Set(
      [...normal, ...bonus]
        .map((wallet) => (typeof wallet?.currency === "string" ? wallet.currency : null))
        .filter((currency) => currency !== null),
    ),
  ];
  if (currencies.length === 0) return null;
  const pick = currencies.includes(preferredCurrency) ? preferredCurrency : currencies[0];
  const sumOf = (wallets, currency) =>
    wallets
      .filter((wallet) => wallet?.currency === currency)
      .reduce((sum, wallet) => sum + (decimal(wallet?.balance) ?? 0), 0);
  const toppedUp = Math.round(sumOf(normal, pick) * 1e10) / 1e10;
  const granted = Math.round(sumOf(bonus, pick) * 1e10) / 1e10;
  const total = Math.round((toppedUp + granted) * 1e10) / 1e10;
  return {
    currency: pick,
    total,
    granted,
    toppedUp,
    isAvailable: total > 0,
    others: currencies
      .filter((currency) => currency !== pick)
      .map((currency) => ({
        currency,
        total: Math.round((sumOf(normal, currency) + sumOf(bonus, currency)) * 1e10) / 1e10,
      })),
  };
}
/**
 * 带缓存的余额读取器。
 *
 * 缓存 5 分钟（已确认的决定）：余额是分钟级的事，而每次刷新都是打一次用户的账号接口，
 * 面板反复挂载/卸载时不该把账号打到限流。**失败不写缓存**（否则一次断网会锁住 5 分钟）。
 */
export class BalanceReader {
  /**
   * @param options `{ keyRef, ttlMs, timeoutMs, url, mock, accountFallback, accountRecord, platformOrigin }`
   */
  constructor(options = {}) {
    this.keyRef = options.keyRef ?? DEFAULT_KEY_REF;
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.url = options.url ?? BALANCE_URL;
    this.mock = options.mock ?? null;
    /** API key 不可用时是否回退到 DSH 账号登录态（默认开）。 */
    this.accountFallback = options.accountFallback !== false;
    /** DSH 账号 grant 的记录名。 */
    this.accountRecord = options.accountRecord ?? ACCOUNT_RECORD_KEY;
    /** 平台 origin；空 = 用记录里的 issuer。 */
    this.platformOrigin = typeof options.platformOrigin === "string" ? options.platformOrigin : "";
    this.cached = null;
    this.cachedAt = 0;
    /** 最近一次结果，卡片显示用（含失败态与时间戳）。 */
    this.last = null;
    this.inFlight = null;
  }

  /**
   * 取余额。
   * @param ctx cordis 上下文。
   * @param options `{ force?: boolean }` —— `force` 跳过缓存（手动刷新按钮用）。
   */
  async get(ctx, options = {}) {
    const now = Date.now();
    if (options.force !== true && this.cached !== null && now - this.cachedAt < this.ttlMs) {
      return { ...this.cached, cached: true };
    }
    if (this.inFlight !== null) return this.inFlight;

    this.inFlight = this.#fetch(ctx, now)
      .then((result) => {
        this.last = result;
        if (result.status === BALANCE_STATUS.ready) {
          this.cached = result;
          this.cachedAt = Date.now();
        }
        return { ...result, cached: false };
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** 丢掉缓存（配置变更 / 手动刷新）。 */
  invalidate() {
    this.cached = null;
    this.cachedAt = 0;
  }

  /**
   * 取数入口：先 API key；不可用时（未配置 / 被拒 / 失败）回退到 DSH 账号登录态。
   * @param ctx cordis 上下文。
   * @param now 本轮取数的时间戳。
   */
  async #fetch(ctx, now) {
    // 测试钩子：`mock` 是给「四种失败态」的端到端验证用的 ——
    // 本地起的假服务器可以精确返回 200/401/503，而不必拿真密钥去试探。
    if (this.mock !== null) return this.mock(now);

    const apiKey = await this.#fetchApiKey(ctx, now);
    if (apiKey.status === BALANCE_STATUS.ready || this.accountFallback !== true) return apiKey;

    const account = await this.#fetchAccount(ctx, now);
    if (account.status === BALANCE_STATUS.ready) return account;

    // 两条都不可用：把两条原因都写进 detail，避免只说一半。
    const details = [apiKey.detail, account.detail].filter(
      (detail) => typeof detail === "string" && detail !== "",
    );
    return { ...apiKey, accountStatus: account.status, detail: details.join("；") };
  }

  /** 官方 API key 路径。 */
  async #fetchApiKey(ctx, now) {
    const key = await readApiKey(ctx, this.keyRef);
    if (!looksLikeApiKey(key)) {
      return {
        status: BALANCE_STATUS.unconfigured,
        source: "api-key",
        keyRef: this.keyRef,
        at: now,
        detail: key === null ? `${this.keyRef} 未配置` : `${this.keyRef} 的值不像一把有效密钥`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${key}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          status: BALANCE_STATUS.unauthorized,
          source: "api-key",
          keyRef: this.keyRef,
          at: now,
          httpStatus: response.status,
          detail: `官方接口拒绝了这个密钥（HTTP ${response.status}）`,
        };
      }
      if (!response.ok) {
        return {
          status: BALANCE_STATUS.unreachable,
          source: "api-key",
          keyRef: this.keyRef,
          at: now,
          httpStatus: response.status,
          detail: `官方接口返回 HTTP ${response.status}`,
        };
      }
      const payload = await response.json();
      const balance = parseBalance(payload);
      if (balance === null) {
        return {
          status: BALANCE_STATUS.unreachable,
          source: "api-key",
          keyRef: this.keyRef,
          at: now,
          detail: "响应里没有 balance_infos，形状与官方文档不符",
        };
      }
      return {
        status: BALANCE_STATUS.ready,
        source: "api-key",
        keyRef: this.keyRef,
        at: now,
        balance,
        httpStatus: response.status,
      };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return {
        status: BALANCE_STATUS.unreachable,
        source: "api-key",
        keyRef: this.keyRef,
        at: now,
        detail: aborted ? `请求超时（>${this.timeoutMs} ms）` : `请求失败：${String(error?.message ?? error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** DSH 账号登录态路径（浏览器登录后 DSH 存的 grant）。 */
  async #fetchAccount(ctx, now) {
    const grant = await readAccountGrant(ctx, this.accountRecord);
    if (grant === null) {
      return {
        status: BALANCE_STATUS.unconfigured,
        source: "dsh-account",
        at: now,
        detail: `凭据里没有 DSH 账号记录（${this.accountRecord}）`,
      };
    }

    const origin = (this.platformOrigin === "" ? grant.issuer : this.platformOrigin).replace(/\/+$/u, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${origin}${ACCOUNT_BALANCE_PATH}`, {
        method: "GET",
        headers: {
          "x-dsh-auth-token": grant.token,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return {
          status: BALANCE_STATUS.unauthorized,
          source: "dsh-account",
          at: now,
          httpStatus: response.status,
          detail: `DSH 账号登录态被平台拒绝（HTTP ${response.status}），可能需要在设置里重新登录`,
        };
      }
      if (!response.ok) {
        return {
          status: BALANCE_STATUS.unreachable,
          source: "dsh-account",
          at: now,
          httpStatus: response.status,
          detail: `平台账号接口返回 HTTP ${response.status}`,
        };
      }
      const payload = await response.json();
      const code = typeof payload?.code === "number" ? payload.code : 0;
      if (code !== 0) {
        const unauthorized = code === 40002 || code === 40003;
        const message = typeof payload?.msg === "string" && payload.msg !== "" ? payload.msg : `code ${code}`;
        return {
          status: unauthorized ? BALANCE_STATUS.unauthorized : BALANCE_STATUS.unreachable,
          source: "dsh-account",
          at: now,
          httpStatus: response.status,
          detail: unauthorized
            ? `DSH 账号登录态已失效（平台 ${message}），可能需要在设置里重新登录`
            : `平台账号接口报错：${message}`,
        };
      }
      const balance = parseAccountBalance(payload);
      if (balance === null) {
        return {
          status: BALANCE_STATUS.unreachable,
          source: "dsh-account",
          at: now,
          detail: "平台响应里没有钱包数据，形状与 DSH 账号链不符",
        };
      }
      return {
        status: BALANCE_STATUS.ready,
        source: "dsh-account",
        at: now,
        balance,
        httpStatus: response.status,
      };
    } catch (error) {
      const aborted = error?.name === "AbortError";
      return {
        status: BALANCE_STATUS.unreachable,
        source: "dsh-account",
        at: now,
        detail: aborted ? `平台请求超时（>${this.timeoutMs} ms）` : `平台请求失败：${String(error?.message ?? error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
