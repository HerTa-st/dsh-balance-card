/**
 * 本地假余额服务器 —— 只为端到端验证「四种失败态」用。
 *
 * ## 为什么需要它
 *
 * 卡片要区分四种状态：未配置 / 密钥无效 / 半死（5xx、超时、形状不符）/ 正常。
 * 前三种如果拿**真密钥**去打**真接口**是无法可控复现的（总不能故意把 key 弄坏）。
 * 所以这里起一个本地 HTTP 服务，按路径返回不同的真实响应形状：
 *
 *   GET /ok      → 200 + 官方 `/user/balance` 的响应形状（含赠金/充值拆分）
 *   GET /401     → 401 + 官方错误形状的 body（模拟 key 被拒）
 *   GET /503     → 503（模拟服务过载）
 *   GET /garbage → 200 + 形状不符的 body（模拟接口悄悄变了）
 *   GET /hang    → 不回应（模拟超时）
 *
 * 关键：插件走的是**真实 HTTP 路径**（真的发请求、真的看状态码、真的解析 JSON），
 * 只是目标换成了本地地址。这不是把代码 mock 掉。
 *
 * 跑法：`E:\node\node.exe scripts/fake-balance-server.mjs [端口]`（默认 8791）
 */
import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8791);

/** 官方 `/user/balance` 的响应形状（金额是字符串）。 */
const OK_BODY = {
  is_available: true,
  balance_infos: [
    {
      currency: "CNY",
      total_balance: "12.34",
      granted_balance: "2.00",
      topped_up_balance: "10.34",
    },
  ],
};

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  console.log(`[fake-balance] ${req.method} ${path} auth=${req.headers.authorization === undefined ? "无" : "有"}`);

  if (path === "/ok") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(OK_BODY));
    return;
  }
  if (path === "/401") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Authentication Fails", type: "authentication_error" } }));
    return;
  }
  if (path === "/503") {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Server Overloaded" } }));
    return;
  }
  if (path === "/garbage") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ unexpected: true }));
    return;
  }
  if (path === "/hang") {
    // 故意不回应，逼出客户端的超时分支。
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "not found" } }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake-balance] 监听 http://127.0.0.1:${PORT}（/ok /401 /503 /garbage /hang）`);
});
