/**
 * 剖析全量扫描的时间花在哪：读盘 / zstd 解压 / JSON 解析 / 事件提取。
 *
 * 只有知道钱花在哪才谈得上优化 —— 猜「大概是解压慢」是不行的。
 *
 * 用法：node bench-usage.mjs [会话根目录]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const ROOT = process.argv[2] ?? "C:\\Users\\梦源\\.dsh\\sessions";
const SLUG = "--E-deepseek~5DE5~4F5C~533A-HerTa--";
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function listFiles() {
  const out = [];
  const dir = join(ROOT, SLUG);
  for (const session of readdirSync(dir)) {
    const sessionDir = join(dir, session);
    let names;
    try {
      if (!statSync(sessionDir).isDirectory()) continue;
      names = readdirSync(sessionDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (/^session(?:\.v\d+)?\.jsonl\.zstd$/u.test(name)) out.push(join(sessionDir, name));
    }
  }
  return out;
}

function framesOf(buf) {
  const out = [];
  let at = buf.indexOf(MAGIC);
  while (at !== -1) {
    const next = buf.indexOf(MAGIC, at + 4);
    out.push([at, next === -1 ? buf.length : next]);
    at = next;
  }
  return out;
}

const files = listFiles();
const t = { read: 0, frames: 0, decompress: 0, parse: 0, extract: 0 };
let bytes = 0;
let frameCount = 0;
let lines = 0;
let calls = 0;

for (const path of files) {
  let t0 = process.hrtime.bigint();
  const buf = readFileSync(path);
  t.read += Number(process.hrtime.bigint() - t0) / 1e6;
  bytes += buf.length;

  t0 = process.hrtime.bigint();
  const frames = framesOf(buf);
  t.frames += Number(process.hrtime.bigint() - t0) / 1e6;
  frameCount += frames.length;

  for (const [start, end] of frames) {
    t0 = process.hrtime.bigint();
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    } catch {
      continue;
    }
    t.decompress += Number(process.hrtime.bigint() - t0) / 1e6;

    t0 = process.hrtime.bigint();
    const parts = text.split("\n");
    t.extract += Number(process.hrtime.bigint() - t0) / 1e6;

    t0 = process.hrtime.bigint();
    for (const line of parts) {
      if (line === "" || line[0] !== "{") continue;
      lines += 1;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "assistant/message" && ev.data?.usage !== undefined) calls += 1;
    }
    t.parse += Number(process.hrtime.bigint() - t0) / 1e6;
  }
}

const total = t.read + t.frames + t.decompress + t.parse + t.extract;
const row = (k, v) => `  ${k.padEnd(12)} ${v.toFixed(0).padStart(6)} ms  ${((v / total) * 100).toFixed(1).padStart(5)}%`;

console.log(`文件 ${files.length} 个 · 压缩 ${(bytes / 1048576).toFixed(1)} MB · 帧 ${frameCount} 个 · 行 ${lines} 行 · 调用 ${calls} 次`);
console.log(row("读盘", t.read));
console.log(row("找帧边界", t.frames));
console.log(row("zstd 解压", t.decompress));
console.log(row("按行切分", t.extract));
console.log(row("JSON 解析", t.parse));
console.log(row("合计", total));
console.log(`每帧中位大小约 ${(bytes / frameCount / 1024).toFixed(1)} KB（帧多而小 → 每帧固定开销占比高）`);
