/**
 * 用量聚合 —— 读 DSH 原生会话日志，算出「今日 / 近 7 天 / 本月」的 token 与估算花费。
 *
 * ## 为什么不用官方服务
 *
 * DSH 确实给第三方插件开了 `ctx.sessionQuery` / `ctx.sessionProjections` /
 * `ctx.tokenMeter`，但官方投影只有**会话累计**（`uncachedInputTokens` / `outputTokens` /
 * `cacheReadTokens` / `cacheWriteTokens`），**没有按天、没有按模型的分桶**。
 * 「今日 / 近 7 天 / 本月」+「按 provider/model 拆分」只能从原始会话日志里重新折叠
 * （官方那个 fold 函数 `deriveTurnTokenUsage` 没有导出到 `ctx.*` 上）。
 *
 * ## 两个已实测的坑
 *
 * 1. **zstd 帧是拼接的**：会话文件每追加一次就写一个新的 zstd 帧，
 *    整文件一次性 `zstdDecompressSync` **只解出第一帧**（约 202 字节的会话头），
 *    静默丢掉后面几 MB 的事件。所以必须按魔数 `28 B5 2F FD` 逐帧切、逐帧解。
 * 2. **时间戳是 epoch 毫秒**，按天分桶必须先转本地时区。本机是 UTC+8 固定偏移，
 *    所以这里按 `offsetMinutes` 平移；**不要**照抄按 ISO 字符串前 10 位切的做法，
 *    那会把晚上 8 点后的活动算到「明天」。
 *
 * ## 增量缓存
 *
 * 全量重算一次实测 **约 2.5 秒**（70 文件 / 45 MB 压缩 / 34,350 帧 / 63,689 行 JSON），
 * 而且剖析显示瓶颈**全在 CPU**：zstd 解压 59%、JSON 解析 34%、读盘只有 1.6%。
 * 帧平均只有 1.3 KB，小帧的固定开销叠加起来就是这 2.5 秒。所以：
 *
 *   - **进程内**：每个文件按 `size + mtimeMs` 做键，未变就跳过；变了的只解**新增的帧**；
 *   - **跨进程**（进程重启后的第一次打开）：把「已解析的事件」落盘缓存，
 *     键是 `路径 + size + mtimeMs + 已消费字节数`。
 *
 * ### 为什么落盘缓存不会让数字变陈旧
 *
 * 缓存的是**原始事实**（哪次调用、哪个 provider/model、三段 token 数），不是派生结果。
 * 且键里带着 `size + mtimeMs`：文件一旦变化，这一个文件的缓存就作废、只重解新增部分。
 * 与之相对，`.dshw-usage.json` 那类「缓存按日聚合的派生结果」才会陈旧 —— 那种东西不做。
 * 把 `cachePath` 设成 `""` 就退回纯内存模式。
 */
import { open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { estimateCost, priceOf } from "./pricing.js";

/** zstd 帧魔数。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 会话日志文件名：`session.jsonl.zstd` / `session.v4.jsonl.zstd` / …。 */
const SESSION_FILE_RE = /^session(?:\.v\d+)?\.jsonl\.zstd$/u;

/**
 * 落盘缓存的格式版本。**改了事件形状或提取逻辑就必须 +1** ——
 * 否则旧缓存会被当成有效的读进来，数字会静默错掉。
 */
const CACHE_VERSION = 1;

/**
 * 一次调用的事件（只留算钱和分桶需要的字段）。
 * @typedef {{
 *   t: number,           // epoch ms
 *   provider: string,    // 例：deepseek-account
 *   model: string,       // 例：deepseek-flash
 *   hit: number,         // cacheReadTokens
 *   miss: number,        // uncachedInputTokens
 *   out: number,         // outputTokens（官方已包含 reasoning）
 *   write: number,       // cacheWriteTokens
 * }} UsageEvent
 */

/**
 * 单个会话文件的缓存条目。
 * @typedef {{
 *   size: number,
 *   mtimeMs: number,
 *   consumedBytes: number,  // 已经解压过的字节数（用于增量）
 *   events: UsageEvent[],
 * }} FileEntry
 */

/** 把字节数格式化成「1.27M / 12.3K / 456」这种短标签。 */
export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}

/** 把金额格式化成「￥0.42」。 */
export function formatMoney(yuan) {
  if (yuan === null || !Number.isFinite(yuan)) return "—";
  if (yuan > 0 && yuan < 0.01) return "<￥0.01";
  return "￥" + yuan.toFixed(2);
}

/** 本地日键 `YYYY-MM-DD`（按固定偏移平移，不用时区表）。 */
export function localDayKey(epochMs, offsetMinutes) {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 本地日起点（epoch ms）：把「本地那一天的 00:00」换回 UTC 瞬时。 */
function localDayStart(epochMs, offsetMinutes) {
  const shifted = epochMs + offsetMinutes * 60_000;
  const dayStartShifted = Math.floor(shifted / 86_400_000) * 86_400_000;
  return dayStartShifted - offsetMinutes * 60_000;
}

/**
 * 在缓冲区里按魔数切出所有 zstd 帧。
 * @param buf 完整文件或尾巴。
 * @param from 起始下标（用于只处理新增部分 —— 调用方保证 from 落在帧边界上）。
 */
function sliceFrames(buf, from) {
  const frames = [];
  let at = buf.indexOf(ZSTD_MAGIC, from);
  while (at !== -1) {
    const next = buf.indexOf(ZSTD_MAGIC, at + 4);
    frames.push({ start: at, end: next === -1 ? buf.length : next });
    at = next;
  }
  return frames;
}

/**
 * 从一段已解压文本里抽出用量事件。
 * @param text JSONL 文本。
 * @param out 收事件的数组。
 */
function collectEvents(text, out) {
  for (const line of text.split("\n")) {
    if (line === "" || line[0] !== "{") continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "assistant/message") continue;
    const usage = ev.data?.usage;
    if (usage === undefined || usage === null) continue;
    const source = ev.data?.message?.source;
    out.push({
      t: typeof ev.time === "number" ? ev.time : 0,
      provider: typeof source?.provider === "string" ? source.provider : "(unknown)",
      model: typeof source?.model === "string" ? source.model : "(unknown)",
      hit: num(usage.cacheReadTokens),
      miss: num(usage.inputTokens),
      out: num(usage.outputTokens),
      write: num(usage.cacheWriteTokens),
    });
  }
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 用量聚合器。一次构造长期持有；`collect()` 增量刷新。
 */
export class UsageAggregator {
  /**
   * @param options `{ sessionsRoot, workspaceSlug, offsetMinutes, cachePath }`
   *   `cachePath` 为空字符串则禁用落盘缓存（纯内存）。
   */
  constructor(options) {
    this.sessionsRoot = options.sessionsRoot;
    this.workspaceSlug = options.workspaceSlug ?? null;
    this.offsetMinutes = options.offsetMinutes ?? 480;
    this.cachePath = options.cachePath ?? "";
    /** @type {Map<string, FileEntry>} 键 = 会话文件的绝对路径 */
    this.files = new Map();
    this.lastScanAt = 0;
    this.lastError = null;
    /** 上一轮实际重算的文件数（可观测性用）。 */
    this.lastChanged = 0;
    /** 落盘缓存是否被用上（可观测性用）。 */
    this.cacheLoaded = false;
    this.cacheSavedAt = 0;
  }

  /**
   * 从磁盘装载缓存。
   *
   * 只做**形状校验**，不做正确性推断：每个条目的 `size + mtimeMs` 会在
   * `refreshFile` 里跟真实文件比对，不一致就当没有这条 —— 所以这里不需要
   * 判断「缓存是否过期」，那个判断天然由文件身份完成。
   */
  async loadCache() {
    if (this.cachePath === "") return false;
    let raw;
    try {
      raw = await readFile(this.cachePath, "utf8");
    } catch {
      return false; // 没有缓存文件是正常的第一次运行
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return false; // 缓存坏了就当没有，不要让它把插件拖垮
    }
    if (parsed?.version !== CACHE_VERSION || typeof parsed.files !== "object" || parsed.files === null) {
      return false;
    }
    let loaded = 0;
    for (const [path, entry] of Object.entries(parsed.files)) {
      if (typeof entry?.size !== "number" || typeof entry?.mtimeMs !== "number" || !Array.isArray(entry?.events)) {
        continue;
      }
      this.files.set(path, {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        consumedBytes: typeof entry.consumedBytes === "number" ? entry.consumedBytes : 0,
        events: entry.events,
      });
      loaded += 1;
    }
    this.cacheLoaded = loaded > 0;
    return this.cacheLoaded;
  }

  /** 把当前事件落盘。原子写（先写 .tmp 再改名），避免半个文件把下次启动拖垮。 */
  async saveCache() {
    if (this.cachePath === "") return false;
    const files = {};
    for (const [path, entry] of this.files) {
      files[path] = {
        size: entry.size,
        mtimeMs: entry.mtimeMs,
        consumedBytes: entry.consumedBytes,
        events: entry.events,
      };
    }
    const payload = JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), files });
    try {
      const tmp = `${this.cachePath}.tmp`;
      await writeFile(tmp, payload, "utf8");
      await rename(tmp, this.cachePath);
      this.cacheSavedAt = Date.now();
      return true;
    } catch (error) {
      // 缓存写不进去不该让用量功能失败 —— 记一次原因就好。
      this.lastError = `缓存写入失败：${String(error?.message ?? error)}`;
      return false;
    }
  }

  /** 列出要扫的会话文件。 */
  async listSessionFiles() {
    const out = [];
    let workspaceDirs;
    try {
      workspaceDirs = await readdir(this.sessionsRoot, { withFileTypes: true });
    } catch (error) {
      this.lastError = `读取会话目录失败：${String(error?.message ?? error)}`;
      return out;
    }
    for (const dirent of workspaceDirs) {
      if (!dirent.isDirectory()) continue;
      // 只统计当前工作区：目录名是 cwd 的不可逆编码，所以配上就直接比。
      if (this.workspaceSlug !== null && dirent.name !== this.workspaceSlug) continue;
      const dir = join(this.sessionsRoot, dirent.name);
      let sessionDirs;
      try {
        sessionDirs = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const session of sessionDirs) {
        if (!session.isDirectory()) continue;
        const sessionDir = join(dir, session.name);
        let names;
        try {
          names = await readdir(sessionDir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!SESSION_FILE_RE.test(name)) continue;
          out.push(join(sessionDir, name));
        }
      }
    }
    return out;
  }

  /**
   * 增量刷新。返回本轮统计。
   */
  async collect() {
    const files = await this.listSessionFiles();
    let changed = 0;
    const limit = 4;
    for (let i = 0; i < files.length; i += limit) {
      const batch = files.slice(i, i + limit);
      await Promise.all(
        batch.map(async (path) => {
          try {
            const did = await this.refreshFile(path);
            if (did) changed += 1;
          } catch (error) {
            this.lastError = `处理 ${path} 失败：${String(error?.message ?? error)}`;
          }
        }),
      );
    }
    this.lastChanged = changed;
    this.lastScanAt = Date.now();
    return { files: files.length, changed };
  }

  /**
   * 刷新单个文件：没变就跳过；变了只解新增的帧。
   * @returns 是否真的做了工作。
   */
  async refreshFile(path) {
    const info = await stat(path);
    const entry = this.files.get(path);
    if (entry !== undefined && entry.size === info.size && entry.mtimeMs === info.mtimeMs) {
      return false;
    }

    // 文件被截断/重写（size 变小）时退回全量重解。
    const canAppend = entry !== undefined && info.size > entry.size && entry.consumedBytes <= info.size;
    const from = canAppend ? entry.consumedBytes : 0;
    const handle = await open(path, "r");
    try {
      const length = info.size - from;
      const buf = Buffer.allocUnsafe(length);
      await handle.read(buf, 0, length, from);
      const frames = sliceFrames(buf, 0).filter((f) => f.end > f.start + 4);
      const events = canAppend ? entry.events : [];
      let consumed = from;
      for (const frame of frames) {
        // 末尾那个帧可能是「还没写完」的半个帧 —— 解不开就说明是残缺，留到下一轮。
        let text;
        try {
          text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString("utf8");
        } catch {
          break;
        }
        collectEvents(text, events);
        consumed = from + frame.end;
      }
      this.files.set(path, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        consumedBytes: consumed,
        events,
      });
      return true;
    } finally {
      await handle.close();
    }
  }

  /** 全部事件（按时间升序）。 */
  allEvents() {
    const out = [];
    for (const entry of this.files.values()) out.push(...entry.events);
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  /**
   * 按时间窗汇总。
   * @param now 当前时间（epoch ms），便于测试注入。
   */
  summarize(now = Date.now()) {
    const events = this.allEvents();
    const dayStart = localDayStart(now, this.offsetMinutes);
    const weekStart = dayStart - 6 * 86_400_000;
    const monthStart = (() => {
      const shifted = new Date(now + this.offsetMinutes * 60_000);
      const y = shifted.getUTCFullYear();
      const m = shifted.getUTCMonth();
      return Date.UTC(y, m, 1) - this.offsetMinutes * 60_000;
    })();

    const windows = {
      today: { from: dayStart, label: "今日" },
      week: { from: weekStart, label: "近 7 天" },
      month: { from: monthStart, label: "本月" },
      all: { from: -Infinity, label: "全部" },
    };

    /** @type {Record<string, { calls: number, hit: number, miss: number, out: number, cost: number | null, unpriced: boolean, byModel: Record<string, any> }>} */
    const result = {};
    for (const [key, window] of Object.entries(windows)) {
      result[key] = {
        label: window.label,
        calls: 0,
        hit: 0,
        miss: 0,
        out: 0,
        write: 0,
        cost: 0,
        unpriced: false,
        byModel: {},
      };
    }

    for (const ev of events) {
      for (const [key, window] of Object.entries(windows)) {
        if (ev.t < window.from) continue;
        const bucket = result[key];
        bucket.calls += 1;
        bucket.hit += ev.hit;
        bucket.miss += ev.miss;
        bucket.out += ev.out;
        bucket.write += ev.write;
        const modelKey = `${ev.provider} / ${ev.model}`;
        const byModel =
          bucket.byModel[modelKey] ??
          (bucket.byModel[modelKey] = {
            provider: ev.provider,
            model: ev.model,
            calls: 0,
            hit: 0,
            miss: 0,
            out: 0,
            cost: 0,
            priced: priceOf(ev.model) !== null,
          });
        byModel.calls += 1;
        byModel.hit += ev.hit;
        byModel.miss += ev.miss;
        byModel.out += ev.out;
        const cost = estimateCost(ev.model, { cacheHit: ev.hit, cacheMiss: ev.miss, output: ev.out });
        if (cost === null) bucket.unpriced = true;
        else {
          byModel.cost += cost;
          bucket.cost += cost;
        }
      }
    }

    for (const bucket of Object.values(result)) {
      for (const model of Object.values(bucket.byModel)) {
        if (!model.priced) model.cost = null;
      }
    }

    return {
      windows: result,
      totals: {
        events: events.length,
        firstAt: events.length > 0 ? events[0].t : null,
        lastAt: events.length > 0 ? events[events.length - 1].t : null,
        files: this.files.size,
      },
      offsetMinutes: this.offsetMinutes,
      generatedAt: now,
      error: this.lastError,
    };
  }
}
