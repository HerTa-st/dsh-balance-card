/**
 * 在 lab profile 的 cordis.patch.yml 里**精确**剥掉 dsh-balance-card 那一段配置。
 *
 * ## 为什么用 Node 而不是 PowerShell 内联脚本
 *
 * 先前用 PowerShell 靠正则删行，在中文与全角破折号（`──`）上栽了两次：要么匹配不上、
 * 要么匹配一半，把后面的行删成孤儿。用 Node 读 UTF-8 字符串、按**标记行**定位区间、
 * 按行号切片，行为确定。
 *
 * 区间的定义：
 *   起点 = 含 `# ── dsh-balance-card` 的那一行；
 *   终点 = 起点之后第一条 `- id: balance-card` 条目**及其 config 块**的最后一行
 *          （即下一条顶格 `- id:` 之前）。
 *
 * 用法：node strip-plugin-config.mjs <patch 路径> <模式 add|remove>
 */
import { readFileSync, writeFileSync } from "node:fs";

const [, , patchPath, mode] = process.argv;
if (patchPath === undefined || (mode !== "remove" && mode !== "add")) {
  console.error("用法: node strip-plugin-config.mjs <patch 路径> <add|remove>");
  process.exit(2);
}

const START_MARK = "# ── dsh-balance-card";

/** 要插入的段落（install 时用）。 */
const BLOCK = [
  "",
  "# ── dsh-balance-card（本次要验证的插件）─────────────────────────────────",
  "#",
  "# 这是**覆盖式条目**，不是 `insert:` —— 包自带的 bundle patch 已经插了 id",
  "# `balance-card`，这里只按 id 合并 config，绝不重复插入。",
  "#",
  "# sessionsRoot / workspace 指向**真实工作区**，让卡片读真数字；",
  "# balanceUrl 指向本地假服务器，用于可控复现失败态。",
  "- id: balance-card",
  "  name: dsh-herta-balance-card",
  "  config:",
  "    workspace: E:\\deepseek工作区\\HerTa",
  "    sessionsRoot: C:\\Users\\梦源\\.dsh\\sessions",
  "    cachePath: E:\\deepseek工作区\\HerTa\\herta-lab\\_balance-card-cache.json",
  "    balanceUrl: http://127.0.0.1:8791/ok",
  "    keyRef: DEEPSEEK_API_KEY",
  "    debug: true",
  "",
];

const text = readFileSync(patchPath, "utf8");
const lines = text.split("\n");

const startIdx = lines.findIndex((l) => l.includes(START_MARK));
if (mode === "remove") {
  if (startIdx === -1) {
    console.log("没有 balance-card 段落，无需删除");
    process.exit(0);
  }
  // 从起点往后找第一条 `- id: balance-card`，再往后找下一条顶格 `- id:` 或文件末尾。
  let entryIdx = -1;
  for (let i = startIdx; i < lines.length; i += 1) {
    if (/^- id: balance-card\s*$/.test(lines[i])) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx === -1) {
    console.log("找不到 `- id: balance-card` 条目，拒绝乱删");
    process.exit(3);
  }
  let endIdx = lines.length;
  for (let i = entryIdx + 1; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const removed = lines.splice(startIdx, endIdx - startIdx);
  // 顺手把留下的多余空行压成一个
  while (lines.length > 1 && lines[lines.length - 1] === "" && lines[lines.length - 2] === "") lines.pop();
  writeFileSync(patchPath, lines.join("\n"), "utf8");
  console.log(`已删除 ${removed.length} 行（${startIdx + 1}–${startIdx + removed.length}）`);
  console.log(`剩余 ${lines.length} 行`);
} else {
  if (startIdx !== -1) {
    console.log("已存在 balance-card 段落，无需插入");
    process.exit(0);
  }
  // 插到文件末尾之前
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  lines.push(...BLOCK.slice(1));
  writeFileSync(patchPath, lines.join("\n"), "utf8");
  console.log(`已插入 ${BLOCK.length - 1} 行`);
}
