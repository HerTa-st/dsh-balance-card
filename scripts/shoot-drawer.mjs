/**
 * 抓「余额与用量」抽屉的四张 PNG：closed / mid-open(~120ms) / open / mid-close(~110ms)。
 *
 * 中间帧不用「点完 sleep 120ms 再截图」——截图本身有几十毫秒延迟，抓到的帧不确定。
 * 这里用 Web Animations API 把卡片/图片上的动画 **pause 并 currentTime=120**，摆到确定的中间帧再截。
 *
 * 用法：
 *   node shoot-drawer.mjs <带 token 的 lab URL> [调试端口]
 *
 * 输出（工作区根目录）：
 *   _drawer-closed.png / _drawer-mid-open.png / _drawer-open.png / _drawer-mid-close.png
 */
import { join } from "node:path";
import { OUT_DIR, buttonSize, launch, navigate, reload, waitFor, sleep, screenshot } from "./cdp-session.mjs";

const url = process.argv[2];
const port = Number(process.argv[3] ?? 9339);
if (url === undefined) {
  console.error("用法: node shoot-drawer.mjs <带 token 的 lab URL> [调试端口]");
  process.exit(2);
}

const SIZE = buttonSize();
const MAIN_MS = 120;
const CLOSE_MS = 110;
const PAD = 48;

const session = await launch({ port });
const page = (fn) => session.evaluate("(" + fn.toString() + ")()");
const pageCall = (fn, ...args) =>
  session.evaluate("(" + fn.toString() + ")(" + args.map((a) => JSON.stringify(a)).join(",") + ")");

async function clickDot() {
  return page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return false;
    const r = dot.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    return true;
  });
}

/** 把当前卡片 + 图片上的动画暂停在指定毫秒，返回被暂停的动画条数。 */
async function pauseAnimationsAt(ms) {
  return pageCall(
    async (ms) => {
      const sleep = (wait) => new Promise((r) => setTimeout(r, wait));
      const card = document.querySelector(".dsh-bc-card");
      const dot = document.querySelector(".dsh-bc-dot");
      if (card === null || dot === null) return -1;
      // 过渡可能晚一两帧才建立：最多等 ~80ms 再定格（都发生在 280ms 过渡的前半段）。
      let anims = [];
      for (let i = 0; i < 8; i++) {
        anims = [].concat(card.getAnimations(), dot.getAnimations());
        if (anims.length > 0) break;
        await sleep(10);
      }
      for (const a of anims) {
        try {
          a.pause();
          a.currentTime = ms;
        } catch {
          /* 某些动画不支持改写时间，跳过 */
        }
      }
      return anims.length;
    },
    ms,
  );
}

/** 恢复（播完）当前所有动画。 */
async function finishAnimations() {
  return page(() => {
    const card = document.querySelector(".dsh-bc-card");
    const dot = document.querySelector(".dsh-bc-dot");
    if (card === null || dot === null) return false;
    for (const a of [].concat(card.getAnimations(), dot.getAnimations())) {
      try {
        a.play();
      } catch {
        /* 已结束的动画不用管 */
      }
    }
    return true;
  });
}

/** 计算截图区域：图片 + 卡片最终位置的并集，四周留 PAD，再夹进视口。 */
async function computeClip() {
  return pageCall(
    (pad) => {
      const dot = document.querySelector(".dsh-bc-dot");
      const card = document.querySelector(".dsh-bc-card");
      if (dot === null || card === null) return null;
      const dr = dot.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const left = Math.min(dr.left, cr.left) - pad;
      const top = Math.min(dr.top, cr.top) - pad;
      const right = Math.max(dr.right, cr.right) + pad;
      const bottom = Math.max(dr.bottom, cr.bottom) + pad;
      const x = Math.max(0, Math.floor(left));
      const y = Math.max(0, Math.floor(top));
      const width = Math.min(window.innerWidth - x, Math.ceil(right) - x);
      const height = Math.min(window.innerHeight - y, Math.ceil(bottom) - y);
      return { x: x, y: y, width: width, height: height };
    },
    PAD,
  );
}

const outFiles = {
  closed: join(OUT_DIR, "_drawer-closed.png"),
  midOpen: join(OUT_DIR, "_drawer-mid-open.png"),
  open: join(OUT_DIR, "_drawer-open.png"),
  midClose: join(OUT_DIR, "_drawer-mid-close.png"),
};

try {
  console.log("浏览器: " + session.version.Browser);
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1500, deviceScaleFactor: 1, mobile: false });
  await navigate(session, url, { settleMs: 9000 });
  await page(() => {
    localStorage.removeItem("dsh-balance-card:state");
    return true;
  });
  await reload(session, { settleMs: 9000 });
  await waitFor(session, "document.querySelector('.dsh-bc-root') !== null", { timeoutMs: 20000, label: "root 出现" });
  await sleep(1500);

  // 先展开并等稳定，拿到「最终落位」用来算统一截图区域。
  await clickDot();
  await sleep(700);
  const clip = await computeClip();
  if (clip === null) throw new Error("量不到卡片/图片矩形，无法截图");
  console.log("截图区域: " + JSON.stringify(clip) + "（CSS px，输出 ×2）");

  // ① closed：收起并等过渡结束
  await clickDot();
  await sleep(600);
  await screenshot(session, outFiles.closed, clip);
  console.log("✓ " + outFiles.closed);

  // ② mid-open：点开 → 立即把动画暂停在 ~120ms → 截图
  await clickDot();
  const openPaused = await pauseAnimationsAt(MAIN_MS);
  await sleep(120);
  await screenshot(session, outFiles.midOpen, clip);
  console.log("✓ " + outFiles.midOpen + "（暂停动画 " + openPaused + " 条 @ " + MAIN_MS + "ms）");

  // ③ open：播完动画、等稳定
  await finishAnimations();
  await sleep(700);
  await screenshot(session, outFiles.open, clip);
  console.log("✓ " + outFiles.open);

  // ④ mid-close：点图片收起 → 动画暂停在 ~110ms → 截图
  await clickDot();
  const closePaused = await pauseAnimationsAt(CLOSE_MS);
  await sleep(120);
  await screenshot(session, outFiles.midClose, clip);
  console.log("✓ " + outFiles.midClose + "（暂停动画 " + closePaused + " 条 @ " + CLOSE_MS + "ms）");

  await finishAnimations();
  await sleep(400);
} catch (error) {
  console.error("截图脚本出错：" + String(error && error.message !== undefined ? error.message : error));
  process.exitCode = 2;
} finally {
  try {
    await session.send("Emulation.clearDeviceMetricsOverride");
  } catch {
    /* 浏览器可能已经关了 */
  }
  try {
    session.close();
  } catch {
    /* 关不掉就算了 */
  }
}
