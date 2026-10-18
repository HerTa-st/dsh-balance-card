/**
 * 单价表 —— 估算花费的唯一真相。
 *
 * ## 为什么是「内置但可覆盖」的 JSON
 *
 * DSH 自己**完全没有钱的概念**（`dsh-token-meter` 的 README 原文：
 * "Occupancy is a reference figure, not a billing record"），所以单价必须由插件自带。
 * 官方改过一次价（2026-08-16 起启用峰谷定价、2026-09 又降价），因此：
 *   - 数值不写死在代码里，集中在这一个文件；
 *   - 每条都带 `source` 与 `verifiedAt`，卡片上也会标出来；
 *   - 用户可以用 `pricingPath` 配置项指向自己的 JSON 整份覆盖。
 *
 * ## 币种
 *
 * 卡片统一人民币（与余额同币种），所以只取官方中文价格页的「元」那一列。
 * 官方英文页同价、币种为 $，这里不用。
 *
 * ## 峰谷价
 *
 * 官方确实有峰谷价（空闲价 = 高峰价的一半），但本项目**刻意不做**峰谷折算
 * （已确认的决定）：只按**高峰价**估，因此估算值偏保守（偏高），并在卡片上标明。
 * 折算逻辑一旦要做，正确的做法是按时段把每次调用分桶 —— 那是另一个量级的工作。
 *
 * ## 字段
 *
 * 每 1M tokens 的价格，单位人民币元：
 *   - `cacheHit`  —— 缓存命中输入（官方页面写「缓存命中」）
 *   - `cacheMiss` —— 缓存未命中输入
 *   - `output`    —— 输出（含 reasoning，DSH 的 outputTokens 已包含它）
 *
 * `null` 表示**没有公开单价**，该模型只列 token 数、不算钱 —— 与其编一个数字，
 * 不如承认不知道（小米 token 套餐、bailian 的 qwen 系列都是这种情况）。
 */

/** 价格表里出现的币种。卡片只支持这一种，换币种要连单价表一起换。 */
export const CURRENCY = "CNY";

/** 货币符号，卡片渲染用。 */
export const CURRENCY_SYMBOL = "¥";

/** 官方人民币价格页。 */
export const PRICING_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

/** 这份数值是哪天核对官方页面的。 */
export const PRICING_VERIFIED_AT = "2026-10-09";

/**
 * 按模型 id 查单价。键是官方模型 id，另附旧名别名（官方仍接受旧名并按新模型计费）。
 * @type {Record<string, { cacheHit: number | null, cacheMiss: number | null, output: number | null }>}
 */
export const PRICES = {
  // DeepSeek-V4.1-Flash：官方中文页「缓存命中 ￥0.02 / 缓存未命中 ￥1 / 输出 ￥4」每 1M。
  "deepseek-flash": { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  // 旧名/下线名，官方仍接受并按 Flash 计费（见官方更新日志）。
  "deepseek-v4-flash": { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  "deepseek-v4-flash-vision-exp": { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  "deepseek-chat": { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  "deepseek-reasoner": { cacheHit: 0.02, cacheMiss: 1, output: 4 },

  // DeepSeek-V4-Pro：官方中文页「缓存命中 ￥0.15 / 缓存未命中 ￥4.5 / 输出 ￥13.5」每 1M。
  "deepseek-v4-pro": { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  "deepseek-v4-pro-0813": { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
};

/** 非 DeepSeek 的模型：明确标出「无公开单价」，只列 token。 */
export const UNPRICED_MODEL_PREFIXES = ["mimo-", "MiMo-", "qwen", "ZHIPU/", "MiniMax-"];

/**
 * 查一个模型的单价。
 * @param model 模型 id。
 * @returns 单价，或 `null`（没有公开单价 —— 只列 token，不算钱）。
 */
export function priceOf(model) {
  if (typeof model !== "string" || model === "") return null;
  const hit = PRICES[model];
  if (hit !== undefined) return hit;
  return null;
}

/**
 * 用 token 三段算一次估算花费（人民币元）。
 *
 * @param model 模型 id。
 * @param tokens `{ cacheHit, cacheMiss, output }`，单位是 token 数。
 * @returns 元；**没有单价时返回 `null`**（不是 0 —— 0 会被误读成「免费的」）。
 */
export function estimateCost(model, tokens) {
  const price = priceOf(model);
  if (price === null) return null;
  const hit = tokens.cacheHit ?? 0;
  const miss = tokens.cacheMiss ?? 0;
  const out = tokens.output ?? 0;
  const perMillion = 1_000_000;
  return (
    (hit / perMillion) * (price.cacheHit ?? 0) +
    (miss / perMillion) * (price.cacheMiss ?? 0) +
    (out / perMillion) * (price.output ?? 0)
  );
}

/**
 * 把一份外部 JSON 合并进内置价格表。
 * @param base 内置表（形状同 `PRICES`）。
 * @param override 用户提供的表；只覆盖它显式给出的模型。
 */
export function mergePrices(base, override) {
  if (override === null || typeof override !== "object") return base;
  const out = { ...base };
  for (const [model, price] of Object.entries(override)) {
    if (price === null || typeof price !== "object") continue;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    out[model] = { cacheHit: num(price.cacheHit), cacheMiss: num(price.cacheMiss), output: num(price.output) };
  }
  return out;
}
