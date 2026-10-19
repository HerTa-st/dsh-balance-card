/**
 * 单价表与峰谷计价规则 —— 估算花费的唯一真相。
 *
 * ## 为什么是「内置但可覆盖」的 JSON
 *
 * DSH 自己**完全没有钱的概念**（`dsh-token-meter` 的 README 原文：
 * "Occupancy is a reference figure, not a billing record"），所以单价必须由插件自带。
 * 官方改过一次价（2026-08-16 起启用峰谷定价、2026-09-10 又降价），因此：
 *   - 数值不写死在代码里，集中在这一个文件；
 *   - 每条都带 `source` 与 `verifiedAt`，卡片上也会标出来；
 *   - 要改价就直接改这个文件（`pricingPath` 配置项目前**没有接线**，见 `mergePrices` 注释）。
 *
 * ## 币种
 *
 * 卡片统一人民币（与余额同币种），所以只取官方中文价格页的「元」那一列。
 * 官方英文页同价、币种为 $，这里不用。
 *
 * ## 峰谷价（本版新增）
 *
 * 官方规则（中文页逐字）：「空闲时段价格为高峰时段价格的一半。北京时间周一至周五
 * （不含中国法定节假日）9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，
 * 包括周末及中国法定节假日全天均为空闲时段。」
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/（2026-10-19 核对）
 *
 * 实现口径：
 *   - 逐条事件按**自己的时间戳**判定峰/谷（`isPeakAt`），而不是按「现在」——
 *     否则今日/近 7 天/本月的数字会随查看时刻漂移；
 *   - 时区固定 **UTC+8（北京时间）**，与运行机器的本地时区无关；
 *   - 窗口左闭右开：09:00 起算高峰，12:00 整算空闲；14:00 起算高峰，18:00 整算空闲；
 *   - 峰谷定价 2026-08-16 16:00 UTC 才生效，**更早的事件按空闲价**（等于旧版平铺价，
 *     这样历史数字的口径不变）；
 *   - 节假日表只收录 2026 年（国办发明电〔2025〕7 号）。表外年份不排除节假日，
 *     那天会被当高峰 —— 偏保守（偏高），卡片上标注核验日期。
 *
 * ## 字段
 *
 * 每 1M tokens 的人民币价格，分 `peak`（高峰）/ `offPeak`（空闲）两档：
 *   - `cacheHit`  —— 缓存命中输入（官方页面写「缓存命中」）
 *   - `cacheMiss` —— 缓存未命中输入
 *   - `output`    —— 输出（含 reasoning，DSH 的 outputTokens 已包含它）
 *
 * 模型不在表里 = **没有公开单价**，该模型只列 token 数、不算钱 —— 与其编一个数字，
 * 不如承认不知道（小米 token 套餐、bailian 的 qwen 系列都是这种情况）。
 */

/** 价格表里出现的币种。卡片只支持这一种，换币种要连单价表一起换。 */
export const CURRENCY = "CNY";

/** 货币符号，卡片渲染用。 */
export const CURRENCY_SYMBOL = "¥";

/** 官方人民币价格页。 */
export const PRICING_SOURCE = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";

/** 这份数值是哪天核对官方页面的。 */
export const PRICING_VERIFIED_AT = "2026-10-19";

/** 峰谷定价生效时刻（官方更新日志：2026-08-16 16:00 UTC）。更早的事件按空闲价。 */
export const PEAK_PRICING_STARTED_AT = Date.UTC(2026, 7, 16, 16, 0, 0);

/** 高峰时段按北京时间判定（UTC+8），与运行机器的本地时区无关。 */
export const PEAK_UTC_OFFSET_MINUTES = 480;

/** 高峰窗口（北京时间的一天内分钟数，左闭右开）：9:00-12:00、14:00-18:00。 */
export const PEAK_WINDOWS_MINUTES = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

/** 空闲价 = 高峰价 × 该系数（官方：空闲时段价格为高峰时段价格的一半）。 */
export const OFF_PEAK_RATE_FACTOR = 0.5;

/**
 * 中国法定节假日（北京时间日期，YYYY-MM-DD）—— 法定节假日全天算空闲时段。
 *
 * 来源：国务院办公厅《关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 *
 * 只列**放假日**；调休上班的周末（1/4、2/14、2/28、5/9、9/20、10/10）按官方规则
 * 「周一至周五」本就不算高峰，所以不需要在这里列。
 */
export const CN_HOLIDAYS = new Set([
  // 元旦：1/1-1/3
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节：2/15-2/23
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
  "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明：4/4-4/6
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节：5/1-5/5
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午：6/19-6/21
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋：9/25-9/27
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆：10/1-10/7
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
  "2026-10-06", "2026-10-07",
]);

/** 节假日表的来源（卡片/文档里标注用）。 */
export const HOLIDAY_SOURCE = "https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm";

/** 节假日表覆盖的年份。表外年份按「没有节假日」处理 —— 偏保守（偏高）。 */
export const HOLIDAY_YEARS = [2026];

/**
 * 某个时刻是否处于**高峰时段**。
 *
 * @param epochMs epoch 毫秒。
 * @returns 高峰 true；周末 / 法定节假日 / 峰谷规则生效前 / 窗口外 均为 false。
 */
export function isPeakAt(epochMs) {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs)) return false;
  // 峰谷定价生效前：一律按空闲价（等价于旧版的平铺价，历史口径不变）。
  if (epochMs < PEAK_PRICING_STARTED_AT) return false;
  const shifted = new Date(epochMs + PEAK_UTC_OFFSET_MINUTES * 60_000);
  const weekday = shifted.getUTCDay(); // 0 = 周日
  if (weekday === 0 || weekday === 6) return false;
  const dateKey = shifted.toISOString().slice(0, 10);
  if (CN_HOLIDAYS.has(dateKey)) return false;
  const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return PEAK_WINDOWS_MINUTES.some(([start, end]) => minutes >= start && minutes < end);
}

/**
 * 按模型 id 查单价（分峰谷两档）。键是官方模型 id，另附旧名别名。
 * @type {Record<string, { peak: { cacheHit: number, cacheMiss: number, output: number }, offPeak: { cacheHit: number, cacheMiss: number, output: number } }>}
 */
export const PRICES = {
  // DeepSeek-V4.1-Flash（官方中文页，每 1M tokens）：
  //   缓存命中 高峰 ￥0.04 / 空闲 ￥0.02；缓存未命中 高峰 ￥2 / 空闲 ￥1；输出 高峰 ￥8 / 空闲 ￥4。
  "deepseek-flash": {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  // 旧名/下线名，官方仍接受并按 Flash 计费（见官方更新日志）。
  "deepseek-v4-flash": {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  "deepseek-v4-flash-vision-exp": {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  // 更旧的别名（2026-07-24 已停服），保留映射避免历史事件变成「无单价」。
  "deepseek-chat": {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },
  "deepseek-reasoner": {
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
  },

  // DeepSeek-V4-Pro（官方中文页，每 1M tokens）：
  //   缓存命中 高峰 ￥0.30 / 空闲 ￥0.15；缓存未命中 高峰 ￥9 / 空闲 ￥4.5；输出 高峰 ￥27 / 空闲 ￥13.5。
  "deepseek-v4-pro": {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
  "deepseek-v4-pro-0813": {
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
};

/** 非 DeepSeek 的模型：明确标出「无公开单价」，只列 token。 */
export const UNPRICED_MODEL_PREFIXES = ["mimo-", "MiMo-", "qwen", "ZHIPU/", "MiniMax-"];

/**
 * 查一个模型的单价。
 * @param model 模型 id。
 * @param options `{ peak?: boolean }`，默认高峰价（调用方应按事件时间显式传）。
 * @returns 三段单价，或 `null`（没有公开单价 —— 只列 token，不算钱）。
 */
export function priceOf(model, options = {}) {
  if (typeof model !== "string" || model === "") return null;
  const hit = PRICES[model];
  if (hit === undefined) return null;
  return options.peak === false ? hit.offPeak : hit.peak;
}

/**
 * 用 token 三段算一次估算花费（人民币元）。
 *
 * @param model 模型 id。
 * @param tokens `{ cacheHit, cacheMiss, output }`，单位是 token 数。
 * @param options `{ peak?: boolean }`：高峰时段传 true、空闲传 false（默认高峰）。
 * @returns 元；**没有单价时返回 `null`**（不是 0 —— 0 会被误读成「免费的」）。
 */
export function estimateCost(model, tokens, options = {}) {
  const price = priceOf(model, options);
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
 *
 * 两种写法都吃：
 *   - 新格式 `{ peak: {...}, offPeak: {...} }` —— 原样覆盖两档；
 *   - 旧格式平铺 `{ cacheHit, cacheMiss, output }` —— 视为**高峰价**，空闲价按官方一半折算。
 *
 * @param base 内置表（形状同 `PRICES`）。
 * @param override 用户提供的表；只覆盖它显式给出的模型。
 *
 * 现状：**当前没有任何调用点**（`pricingPath` 配置项尚未实现）。保留这个纯函数是为了以后
 * 接配置时不用重写合并逻辑；卡片上的价格目前只来自上面的 `PRICES`。
 */
export function mergePrices(base, override) {
  if (override === null || typeof override !== "object") return base;
  const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const triple = (p) => ({
    cacheHit: numOrNull(p?.cacheHit),
    cacheMiss: numOrNull(p?.cacheMiss),
    output: numOrNull(p?.output),
  });
  const half = (p) => ({
    cacheHit: p.cacheHit === null ? null : p.cacheHit * OFF_PEAK_RATE_FACTOR,
    cacheMiss: p.cacheMiss === null ? null : p.cacheMiss * OFF_PEAK_RATE_FACTOR,
    output: p.output === null ? null : p.output * OFF_PEAK_RATE_FACTOR,
  });
  const out = { ...base };
  for (const [model, price] of Object.entries(override)) {
    if (price === null || typeof price !== "object") continue;
    if (price.peak !== undefined || price.offPeak !== undefined) {
      const peak = triple(price.peak ?? price.offPeak);
      out[model] = { peak, offPeak: triple(price.offPeak ?? price.peak) };
    } else {
      const peak = triple(price);
      out[model] = { peak, offPeak: half(peak) };
    }
  }
  return out;
}

/** 卡片/文档用的一行式规则说明与元数据。 */
export const PRICING_RULES = {
  timeZone: "Asia/Shanghai (UTC+8)",
  peak: "周一至周五 09:00-12:00、14:00-18:00（中国法定节假日除外）",
  offPeakFactor: OFF_PEAK_RATE_FACTOR,
  effectiveFrom: PEAK_PRICING_STARTED_AT,
  holidayYears: HOLIDAY_YEARS,
  holidaySource: HOLIDAY_SOURCE,
};
