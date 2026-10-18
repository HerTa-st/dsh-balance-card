/**
 * dsh-balance-card 抽屉形态专项验收（动画 + 落位 + 层级 + 键盘 + 窄视口 + 减少动效）。
 *
 * 与 verify-card.mjs 的分工：
 *   verify-card.mjs   —— 集成/回归：挂载、收起/展开、拖动、✕、reload 持久、数据链路、console。
 *   verify-drawer.mjs —— 新形态细节：抽出动画的**中间帧**、tap 回弹动画、右缘贴着图片可见左缘、
 *                        垂直居中、视口夹取、图片始终最上层可点、窄视口允许压图、键盘开合、reduced-motion。
 *
 * 用法：
 *   node verify-drawer.mjs <带 token 的 lab URL> [调试端口]
 *
 * 注意：Edge 用 stdio:"ignore" 启动 —— 受限沙箱禁止带管道的子进程。
 */
import { buttonSize, launch, navigate, reload, waitFor, sleep } from "./cdp-session.mjs";

const SIZE = buttonSize();
const DOT_W = SIZE.w;
const DOT_H = SIZE.h;
const GAP = 8;
const OPEN_MS_MIN = 180;
const OPEN_MS_MAX = 320;

const url = process.argv[2];
const port = Number(process.argv[3] ?? 9338);

if (url === undefined) {
  console.error("用法: node verify-drawer.mjs <带 token 的 lab URL> [调试端口]");
  process.exit(2);
}

const results = [];
function check(label, condition, detail) {
  results.push({ label, ok: condition === true, detail });
  console.log("  " + (condition === true ? "✓" : "✗") + " " + label + (detail === undefined ? "" : " —— " + detail));
}
function section(text) {
  console.log("\n" + text);
}

/** 页面级定时器探针：验证 60s 自动刷新注册/清理，不用真等 60 秒。 */
const TIMER_INIT = [
  "window.__dshBcTimers = { intervals: [], clears: [] };",
  "(function () {",
  "  var si = window.setInterval;",
  "  var ci = window.clearInterval;",
  "  window.setInterval = function (fn, ms) {",
  "    var id = si.apply(window, arguments);",
  "    try { window.__dshBcTimers.intervals.push({ id: id, ms: ms }); } catch (e) {}",
  "    return id;",
  "  };",
  "  window.clearInterval = function (id) {",
  "    try { window.__dshBcTimers.clears.push(id); } catch (e) {}",
  "    return ci.apply(window, arguments);",
  "  };",
  "})();",
].join("\n");

const session = await launch({ port, initScripts: [TIMER_INIT] });
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

async function clickClose() {
  return page(() => {
    const btn = document.querySelector(".dsh-bc-close");
    if (btn === null) return false;
    btn.click();
    return true;
  });
}

async function drag(selector, dx, dy) {
  return pageCall(
    (selector, dx, dy) => {
      const el = document.querySelector(selector);
      if (el === null) return false;
      const r = el.getBoundingClientRect();
      const sx = Math.round(r.left + r.width / 2);
      const sy = Math.round(r.top + Math.min(12, r.height / 3));
      const mk = (type, x, y, buttons) =>
        new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", button: 0, buttons: buttons, clientX: x, clientY: y });
      el.dispatchEvent(mk("pointerdown", sx, sy, 1));
      el.dispatchEvent(mk("pointermove", sx + Math.round(dx / 2), sy + Math.round(dy / 2), 1));
      el.dispatchEvent(mk("pointermove", sx + dx, sy + dy, 1));
      el.dispatchEvent(mk("pointerup", sx + dx, sy + dy, 0));
      return true;
    },
    selector,
    dx,
    dy,
  );
}

/** 是否展开 + data-open 值。 */
async function isOpen() {
  return page(() => {
    const root = document.querySelector(".dsh-bc-root");
    return root === null ? null : root.dataset.open;
  });
}

/** 点开：在同一段页面脚本里采样「点击前 / ~120ms / 450ms」三个点。 */
async function sampleOpenAnimation() {
  return page(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null || dot === null || card === null) return { error: "missing" };
    const readCard = () => {
      const cs = getComputedStyle(card);
      const r = card.getBoundingClientRect();
      return {
        opacity: cs.opacity,
        transform: cs.transform,
        visibility: cs.visibility,
        pointerEvents: cs.pointerEvents,
        left: r.left,
        right: r.right,
        top: r.top,
        bottom: r.bottom,
        anims: card.getAnimations().map(function (a) {
          const timing = a.effect === null ? null : a.effect.getTiming();
          return {
            type: a.constructor.name,
            transitionProperty: a.transitionProperty === undefined ? null : a.transitionProperty,
            animationName: a.animationName === undefined ? null : a.animationName,
            durationMs: timing === null ? null : timing.duration,
            playState: a.playState,
          };
        }),
      };
    };
    const before = readCard();
    const rr = dot.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, clientX: Math.round(rr.left + rr.width / 2), clientY: Math.round(rr.top + rr.height / 2) };
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    // data-tap 是 React 状态 → 下一帧才落到 DOM（实测 ~16ms），所以等 60ms 再采；
    // 420ms 的 keyframe 此时还在跑。采完再等 60ms，正好在点击后 ~120ms 采卡片的中间帧。
    await sleep(60);
    const tapAfterClick = {
      dataTap: dot.getAttribute("data-tap"),
      animationName: getComputedStyle(dot).animationName,
      anims: dot.getAnimations().map(function (a) {
        return { animationName: a.animationName === undefined ? null : a.animationName, currentTime: a.currentTime };
      }),
    };
    await sleep(60);
    const mid = readCard();
    await sleep(340);
    const end = readCard();
    return { before: before, mid: mid, end: end, tap: tapAfterClick, open: root.dataset.open };
  });
}

/** 点收起（点图片）：同样采三个点。 */
async function sampleCloseAnimation() {
  return page(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null || dot === null || card === null) return { error: "missing" };
    const readCard = () => {
      const cs = getComputedStyle(card);
      const r = card.getBoundingClientRect();
      return { opacity: cs.opacity, transform: cs.transform, visibility: cs.visibility, pointerEvents: cs.pointerEvents, left: r.left, right: r.right, top: r.top, bottom: r.bottom, anims: card.getAnimations().length };
    };
    const rr = dot.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 2, pointerType: "mouse", button: 0, buttons: 1, clientX: Math.round(rr.left + rr.width / 2), clientY: Math.round(rr.top + rr.height / 2) };
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    await sleep(110);
    const mid = readCard();
    await sleep(350);
    const end = readCard();
    return { mid: mid, end: end, open: root.dataset.open, tap: dot.getAttribute("data-tap") };
  });
}

/** 落位数学：按 placeCard 的公式重算期望值。 */
async function placement() {
  return page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null || dot === null || card === null) return { error: "missing" };
    // 用 root 量：root 不参与 tap 动画（dot 在回弹 keyframe 期间会被缩放）。
    const dr = root.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const img = dot.querySelector("img");
    let paintedW = dr.width;
    if (img !== null && img.naturalWidth > 0 && img.naturalHeight > 0) {
      const scale = Math.min(dr.width / img.naturalWidth, dr.height / img.naturalHeight);
      paintedW = img.naturalWidth * scale;
    }
    const paintedLeft = dr.left + (dr.width - paintedW) / 2;
    const desiredLeft = paintedLeft - dr.left - 8 - cw;
    const desiredTop = Math.round((dr.height - ch) / 2);
    const lowerLeft = 8 - dr.left;
    const upperLeft = Math.max(lowerLeft, window.innerWidth - cw - 8 - dr.left);
    const left = Math.min(Math.max(lowerLeft, desiredLeft), upperLeft);
    const lowerTop = 8 - dr.top;
    const upperTop = Math.max(lowerTop, window.innerHeight - ch - 8 - dr.top);
    const top = Math.min(Math.max(lowerTop, desiredTop), upperTop);
    return {
      paintedLeft: paintedLeft,
      paintedW: paintedW,
      dotLeft: dr.left,
      dotTop: dr.top,
      dotRight: dr.right,
      dotBottom: dr.bottom,
      dotCenterY: dr.top + dr.height / 2,
      cardLeft: cr.left,
      cardRight: cr.right,
      cardTop: cr.top,
      cardBottom: cr.bottom,
      cardW: cw,
      cardH: ch,
      cardCenterY: cr.top + ch / 2,
      expectedRight: paintedLeft - 8,
      expectedLeftViewport: dr.left + left,
      expectedTopViewport: dr.top + top,
      clampLeft: left !== desiredLeft,
      clampTop: top !== desiredTop,
      styleLeft: Number.parseFloat(card.style.left),
      styleTop: Number.parseFloat(card.style.top),
      expectedStyleLeft: left,
      expectedStyleTop: top,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      overlapDot: !(cr.right <= dr.left || cr.left >= dr.right || cr.bottom <= dr.top || cr.top >= dr.bottom),
    };
  });
}

async function hitTestDot() {
  return page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (dot === null) return { error: "no dot" };
    const r = dot.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const el = document.elementFromPoint(x, y);
    return {
      tag: el === null ? null : el.tagName,
      cls: el === null ? null : String(el.className),
      insideDot: el !== null && typeof el.closest === "function" && el.closest(".dsh-bc-dot") !== null,
      dotZ: getComputedStyle(dot).zIndex,
      cardZ: card === null ? null : getComputedStyle(card).zIndex,
    };
  });
}

try {
  console.log("浏览器: " + session.version.Browser);
  // 统一视口（attach 到的浏览器窗口可能很小；落位/夹取都要在固定视口下测）。
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1500, deviceScaleFactor: 1, mobile: false });
  await navigate(session, url, { settleMs: 9000 });
  let initialOpen = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page(() => {
      localStorage.removeItem("dsh-balance-card:state");
      return true;
    });
    await reload(session, { settleMs: 9000 });
    await waitFor(session, "document.querySelector('.dsh-bc-root') !== null", { timeoutMs: 20000, label: "root 出现" });
    await sleep(800);
    initialOpen = await page(() => {
      const root = document.querySelector(".dsh-bc-root");
      return root === null ? null : root.dataset.open;
    });
    if (initialOpen === "false") break;
  }
  check("清状态 + reload 后初始是收起态", initialOpen === "false", String(initialOpen));
  await sleep(700);

  // ── A. 收起态：图片+卡片常驻、层级、可访问性 ─────────────
  section("A. 收起态：图片与卡片都常驻、层级、可访问性");
  const closed = await page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null) return { error: "no root" };
    const rr = root.getBoundingClientRect();
    const dr = dot === null ? null : dot.getBoundingClientRect();
    const cs = card === null ? null : getComputedStyle(card);
    const kids = root === null ? [] : Array.from(root.children).map(function (el) { return el.className; });
    return {
      open: root.dataset.open,
      rootW: rr.width,
      rootH: rr.height,
      dot: dr === null ? null : { w: dr.width, h: dr.height },
      hasCard: card !== null,
      cardOpacity: cs === null ? null : cs.opacity,
      cardVisibility: cs === null ? null : cs.visibility,
      cardPointerEvents: cs === null ? null : cs.pointerEvents,
      cardInert: card !== null && card.hasAttribute("inert"),
      cardAriaHidden: card === null ? null : card.getAttribute("aria-hidden"),
      dotAria: dot === null ? null : { expanded: dot.getAttribute("aria-expanded"), role: dot.getAttribute("role"), tabIndex: dot.getAttribute("tabindex"), label: dot.getAttribute("aria-label") },
      dotZ: dot === null ? null : getComputedStyle(dot).zIndex,
      cardZ: card === null ? null : getComputedStyle(card).zIndex,
      children: kids,
      transform: cs === null ? null : cs.transform,
      transformOrigin: cs === null ? null : cs.transformOrigin,
      cardW: card === null ? null : card.offsetWidth,
      cardH: card === null ? null : card.offsetHeight,
    };
  });
  check("data-open = false", closed.open === "false", String(closed.open));
  check("root 尺寸 = " + DOT_W + "×" + DOT_H, Math.round(closed.rootW) === DOT_W && Math.round(closed.rootH) === DOT_H, Math.round(closed.rootW) + "×" + Math.round(closed.rootH));
  check("图片常驻（" + DOT_W + "×" + DOT_H + "）", closed.dot !== null && Math.round(closed.dot.w) === DOT_W && Math.round(closed.dot.h) === DOT_H);
  check("卡片常驻 DOM", closed.hasCard === true);
  check("root 里同时有 .dsh-bc-card 与 .dsh-bc-dot", closed.children.indexOf("dsh-bc-card") >= 0 && closed.children.indexOf("dsh-bc-dot") >= 0, JSON.stringify(closed.children));
  check("卡片收起态 opacity=0 / visibility=hidden / pointer-events=none", closed.cardOpacity === "0" && closed.cardVisibility === "hidden" && closed.cardPointerEvents === "none", closed.cardOpacity + "/" + closed.cardVisibility + "/" + closed.cardPointerEvents);
  check("卡片收起态 inert + aria-hidden=true", closed.cardInert === true && closed.cardAriaHidden === "true");
  check("图片 role=button / tabIndex=0 / aria-expanded=false", closed.dotAria !== null && closed.dotAria.role === "button" && closed.dotAria.tabIndex === "0" && closed.dotAria.expanded === "false", JSON.stringify(closed.dotAria));
  check("图片层级 z-index 高于卡片", Number(closed.dotZ) > Number(closed.cardZ), "dot=" + closed.dotZ + " card=" + closed.cardZ);
  // transform-origin 的 computed 值是像素（right center → "<cardW>px <cardH/2>px"）。
  const originParts = String(closed.transformOrigin === null ? "" : closed.transformOrigin).trim().split(/\s+/);
  const originX = Number.parseFloat(originParts[0]);
  const originY = Number.parseFloat(originParts[1]);
  check(
    "卡片 transform-origin = right center（从人物背后抽出）",
    Number.isFinite(originX) && Number.isFinite(originY) && Math.abs(originX - closed.cardW) <= 1 && Math.abs(originY - closed.cardH / 2) <= 1,
    String(closed.transformOrigin) + "；card " + closed.cardW + "×" + closed.cardH,
  );

  // ── B. 展开动画：中间帧 ─────────────────────────────────
  section("B. 展开动画：~120ms 有中间帧，450ms 到终值");
  const openAnim = await sampleOpenAnimation();
  check("能采到展开动画三帧", openAnim.error === undefined, JSON.stringify(openAnim).slice(0, 200));
  if (openAnim.error === undefined) {
    check("点击后 data-open 立即变 true", openAnim.open === "true", String(openAnim.open));
    const midOpacity = Number(openAnim.mid.opacity);
    const endOpacity = Number(openAnim.end.opacity);
    const midTransform = String(openAnim.mid.transform);
    const endTransform = String(openAnim.end.transform);
    check("~120ms：透明度在 0 与 1 之间，或 transform 未到终值", (midOpacity > 0.01 && midOpacity < 0.995) || midTransform !== endTransform, "opacity " + openAnim.mid.opacity + "，transform " + midTransform);
    check("~120ms：卡片仍在向右偏移（从左侧抽出 → 起点在右边）", openAnim.mid.left > openAnim.end.left + 2, "mid.left " + openAnim.mid.left.toFixed(1) + " vs end.left " + openAnim.end.left.toFixed(1) + "，差 " + (openAnim.mid.left - openAnim.end.left).toFixed(1) + "px");
    const openDurations = openAnim.mid.anims.filter(function (a) { return a.durationMs !== null; }).map(function (a) { return a.durationMs; });
    const maxDuration = openDurations.length === 0 ? 0 : Math.max.apply(null, openDurations);
    check("展开过渡时长在 " + OPEN_MS_MIN + "–" + OPEN_MS_MAX + "ms", maxDuration >= OPEN_MS_MIN && maxDuration <= OPEN_MS_MAX, "实测 " + maxDuration + "ms（" + JSON.stringify(openAnim.mid.anims.map(function (a) { return a.transitionProperty + "=" + a.durationMs; })) + "）");
    check("450ms 后：opacity=1、transform 到终值（无位移无缩放）", endOpacity === 1 && /matrix\(1, 0, 0, 1, 0, 0\)/.test(endTransform), "opacity " + openAnim.end.opacity + "，transform " + endTransform);
    check("450ms 后：卡片可见可点", openAnim.end.visibility === "visible" && openAnim.end.pointerEvents === "auto", openAnim.end.visibility + "/" + openAnim.end.pointerEvents);
  }

  // ── C. 点击回弹动画（tap）───────────────────────────────
  section("C. 点击回弹动画（data-tap + dsh-bc-tap keyframe）");
  check("点图片后 data-tap 变 true（React 下一帧提交）", openAnim.tap !== undefined && openAnim.tap.dataTap === "true", String(openAnim.tap === undefined ? null : openAnim.tap.dataTap));
  const tapAnim = openAnim.tap === undefined ? null : openAnim.tap.anims.filter(function (a) { return a.animationName === "dsh-bc-tap"; });
  check("dot.getAnimations() 里有 dsh-bc-tap 动画", tapAnim !== null && tapAnim.length >= 1, JSON.stringify(openAnim.tap === undefined ? null : openAnim.tap.anims.slice(0, 3)));
  check("computed animationName = dsh-bc-tap", openAnim.tap !== undefined && String(openAnim.tap.animationName).indexOf("dsh-bc-tap") >= 0, String(openAnim.tap === undefined ? null : openAnim.tap.animationName));
  const activeRule = await page(() => {
    const sheets = Array.from(document.styleSheets);
    for (const sheet of sheets) {
      let rules = [];
      try {
        rules = Array.from(sheet.cssRules);
      } catch {
        continue;
      }
      for (const rule of rules) {
        if (rule.selectorText !== undefined && rule.selectorText.indexOf(".dsh-bc-dot:active") >= 0) {
          return { selector: rule.selectorText, transform: String(rule.style.transform) };
        }
      }
    }
    return null;
  });
  check("CSS 里有 .dsh-bc-dot:active 按下缩放", activeRule !== null && /scale\(0?\.9\d/.test(activeRule.transform), JSON.stringify(activeRule));
  await sleep(600);
  const tapReset = await page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    return { dataTap: dot === null ? null : dot.getAttribute("data-tap"), animations: dot === null ? -1 : dot.getAnimations().length };
  });
  check("~600ms 后 data-tap 复位、动画结束", tapReset.dataTap === "false", "data-tap=" + tapReset.dataTap + "，animations=" + tapReset.animations);

  // ── D. 落位（默认位置 + 拖开后不受夹取影响）──────────────
  section("D. 落位：右缘贴图片可见左缘 − 8px、垂直居中、视口夹取");
  const place1 = await placement();
  if (place1.error === undefined) {
    const dRight = place1.cardRight - place1.expectedRight;
    check("默认位置：右边缘 = 图片可见左边缘 − 8px（≤2px）", Math.abs(dRight) <= 2, "实测 " + place1.cardRight.toFixed(1) + "，期望 " + place1.expectedRight.toFixed(1) + "，差 " + dRight.toFixed(1) + "px");
    const dTop = place1.cardTop - place1.expectedTopViewport;
    check("默认位置：顶边符合「垂直居中 + 8px 视口夹取」", Math.abs(dTop) <= 2, "实测 " + place1.cardTop.toFixed(1) + "，期望 " + place1.expectedTopViewport.toFixed(1) + "，差 " + dTop.toFixed(1) + "px，clampTop=" + place1.clampTop);
    check("卡片在视口内（四周 8px 夹取）", place1.cardLeft >= 8 - 1 && place1.cardTop >= 8 - 1 && place1.cardRight <= place1.innerWidth - 8 + 1 && place1.cardBottom <= place1.innerHeight - 8 + 1, "x " + place1.cardLeft.toFixed(0) + "–" + place1.cardRight.toFixed(0) + " y " + place1.cardTop.toFixed(0) + "–" + place1.cardBottom.toFixed(0) + "；视口 " + place1.innerWidth + "×" + place1.innerHeight);
    check("内联 left/top 为相对 root 的负 left（在图片左侧）", Number.isFinite(place1.styleLeft) && place1.styleLeft < 0 && Math.abs(place1.styleLeft - place1.expectedStyleLeft) <= 1 && Math.abs(place1.styleTop - place1.expectedStyleTop) <= 1, "style left/top = " + place1.styleLeft + "/" + place1.styleTop);
    check("卡片实际位置 = 图片位置 + 内联偏移", Math.abs(place1.cardLeft - (place1.dotLeft + place1.styleLeft)) <= 1 && Math.abs(place1.cardTop - (place1.dotTop + place1.styleTop)) <= 1, "差 " + (place1.cardLeft - (place1.dotLeft + place1.styleLeft)).toFixed(1) + "/" + (place1.cardTop - (place1.dotTop + place1.styleTop)).toFixed(1) + "px");
    check("卡片在图片左侧（card.right ≤ dot.left）", place1.cardRight <= place1.dotLeft, "card.right " + place1.cardRight.toFixed(1) + " vs dot.left " + place1.dotLeft.toFixed(1));
    const info = await page(() => {
      const root = document.querySelector(".dsh-bc-root");
      const dot = document.querySelector(".dsh-bc-dot");
      const dr = dot === null ? null : dot.getBoundingClientRect();
      return {
        dotBox: root === null ? null : root.dataset.dotBox,
        placeInfo: root === null ? null : root.dataset.placeInfo,
        rounded: dr === null ? null : Math.round(dr.left) + "," + Math.round(dr.top) + "," + Math.round(dr.width) + "," + Math.round(dr.height),
      };
    });
    check("data-dot-box = 图片 viewport 矩形 (left,top,w,h)", info.dotBox === info.rounded, "dotBox=" + info.dotBox + "，实测 " + info.rounded);
    check("data-place-info 格式达标（paintedLeft/card/left/top/gap）", info.placeInfo !== null && /paintedLeft=-?\d+ card=320x\d+ left=-?\d+ top=-?\d+ gap=8/.test(info.placeInfo), String(info.placeInfo));
  }
  const hit = await hitTestDot();
  check("图片中心 elementFromPoint 命中图片（图片永远最上层）", hit.insideDot === true, "命中 " + hit.tag + "." + hit.cls);
  check("dot z-index > card z-index", Number(hit.dotZ) > Number(hit.cardZ), "dot=" + hit.dotZ + " card=" + hit.cardZ);

  // 拖开一点，让垂直夹取消失 —— 验证真正的「垂直中心对齐」
  await clickDot();
  await sleep(400);
  await drag(".dsh-bc-dot", 0, -300);
  await sleep(500);
  await clickDot();
  await sleep(500);
  const placeNoClamp = await placement();
  check("拖离底边后：不再触发垂直夹取", placeNoClamp.error === undefined && placeNoClamp.clampTop === false, placeNoClamp.error === undefined ? "clampTop=" + placeNoClamp.clampTop : "");
  check("拖离底边后：卡片垂直中心 = 图片垂直中心（≤2px）", placeNoClamp.error === undefined && Math.abs(placeNoClamp.cardCenterY - placeNoClamp.dotCenterY) <= 2, placeNoClamp.error === undefined ? "差 " + (placeNoClamp.cardCenterY - placeNoClamp.dotCenterY).toFixed(1) + "px" : "");
  check("拖离底边后：右边缘仍贴图片可见左缘 − 8px（≤2px）", placeNoClamp.error === undefined && Math.abs(placeNoClamp.cardRight - placeNoClamp.expectedRight) <= 2, placeNoClamp.error === undefined ? "差 " + (placeNoClamp.cardRight - placeNoClamp.expectedRight).toFixed(1) + "px" : "");

  // ── E. 收起动画：中间帧 ─────────────────────────────────
  section("E. 收起动画：~110ms 有中间帧，450ms 回到收起终值");
  const closeAnim = await sampleCloseAnimation();
  check("能采到收起动画三帧", closeAnim.error === undefined, JSON.stringify(closeAnim).slice(0, 200));
  if (closeAnim.error === undefined) {
    check("点图片后 data-open 变 false", closeAnim.open === "false", String(closeAnim.open));
    const midOpacity = Number(closeAnim.mid.opacity);
    check("~110ms：透明仍在渐变（0 < opacity < 1）或 transform 未到终值", (midOpacity > 0.005 && midOpacity < 0.995) || closeAnim.mid.transform !== closeAnim.end.transform, "opacity " + closeAnim.mid.opacity + "，transform " + closeAnim.mid.transform);
    check("~110ms：卡片仍在可见范围内滑动", closeAnim.mid.visibility === "visible", closeAnim.mid.visibility);
    check("450ms 后：opacity=0、visibility=hidden、pointer-events=none", Number(closeAnim.end.opacity) === 0 && closeAnim.end.visibility === "hidden" && closeAnim.end.pointerEvents === "none", closeAnim.end.opacity + "/" + closeAnim.end.visibility + "/" + closeAnim.end.pointerEvents);
    check("450ms 后：transform 回到 translateX(60%) scale(.95)", /matrix\(0\.95, 0, 0, 0\.95, 192, 0\)/.test(String(closeAnim.end.transform)), String(closeAnim.end.transform));
  }

  // ── F. 键盘开合 ─────────────────────────────────────────
  section("F. 键盘：Enter / Space 也能开合");
  const keyboard = await page(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return { error: "no dot" };
    dot.focus();
    const fire = (key) => dot.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
    fire("Enter");
    await sleep(400);
    const afterEnter = root.dataset.open;
    fire(" ");
    await sleep(400);
    const afterSpace = root.dataset.open;
    return { afterEnter: afterEnter, afterSpace: afterSpace };
  });
  check("Enter 展开", keyboard.afterEnter === "true", String(keyboard.afterEnter));
  check("Space 收起", keyboard.afterSpace === "false", String(keyboard.afterSpace));

  // ── G1. 视口缩小：root 必须被夹回视口（新加的 clampRoot）─────
  section("G1. 视口缩小到 400×700：root 夹回视口、x/y 写回 localStorage");
  // D 步把 root 拖到 (1184,940)（内联 left/top）。缩到 400×700 后它本来会在屏幕外，
  // 客户端新加的 resize clampRoot 应把它夹回 left=208 / top=464。
  await drag(".dsh-bc-dot", -60, -60);
  await sleep(400);
  const draggedPos = await page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const r = root.getBoundingClientRect();
    return { left: r.left, top: r.top };
  });
  await session.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 700, deviceScaleFactor: 1, mobile: false });
  await sleep(1000);
  const afterShrink = await page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const r = root.getBoundingClientRect();
    const dr = dot === null ? null : dot.getBoundingClientRect();
    let stored = null;
    try {
      stored = JSON.parse(localStorage.getItem("dsh-balance-card:state") || "null");
    } catch {
      stored = null;
    }
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dotLeft: dr === null ? null : dr.left,
      dotTop: dr === null ? null : dr.top,
      dotRight: dr === null ? null : dr.right,
      dotBottom: dr === null ? null : dr.bottom,
      stored: stored,
    };
  });
  check("缩窄前 root 确实有内联位置（在视口外）", draggedPos.left > afterShrink.vw && draggedPos.top > afterShrink.vh, "拖动后 " + Math.round(draggedPos.left) + "," + Math.round(draggedPos.top));
  check("视口缩小后 root 被夹回视口（不再跑到屏幕外）", afterShrink.left >= -1 && afterShrink.top >= -1 && afterShrink.right <= afterShrink.vw + 1 && afterShrink.bottom <= afterShrink.vh + 1, "root x " + Math.round(afterShrink.left) + "–" + Math.round(afterShrink.right) + " y " + Math.round(afterShrink.top) + "–" + Math.round(afterShrink.bottom) + "；视口 " + afterShrink.vw + "×" + afterShrink.vh);
  check("夹取后 x/y 写回 localStorage", afterShrink.stored !== null && afterShrink.stored.x === Math.round(afterShrink.left) && afterShrink.stored.y === Math.round(afterShrink.top), JSON.stringify(afterShrink.stored));
  const shrinkHit = await page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return { error: "no dot" };
    const r = dot.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const el = document.elementFromPoint(x, y);
    return {
      x: x,
      y: y,
      insideViewport: x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight,
      insideDot: el !== null && typeof el.closest === "function" && el.closest(".dsh-bc-dot") !== null,
      tag: el === null ? null : el.tagName,
    };
  });
  check("缩窄后图片中心仍在视口内且可命中（按钮不会点不到）", shrinkHit.insideViewport === true && shrinkHit.insideDot === true, JSON.stringify(shrinkHit));

  // ── G2. 窄视口下的落位/压图/层级 ───────────────────────
  section("G2. 窄视口：卡片压到图片上，但图片仍最上层、仍可点");
  if ((await isOpen()) !== "true") {
    await clickDot();
    await sleep(500);
  }
  const narrow = await placement();
  const narrowHit = await hitTestDot();
  check("窄视口下卡片仍完全在视口内（8px 夹取）", narrow.error === undefined && narrow.cardLeft >= 8 - 1 && narrow.cardTop >= 8 - 1 && narrow.cardRight <= narrow.innerWidth - 8 + 1 && narrow.cardBottom <= narrow.innerHeight - 8 + 1, narrow.error === undefined ? "卡片 x " + narrow.cardLeft.toFixed(0) + "–" + narrow.cardRight.toFixed(0) + " y " + narrow.cardTop.toFixed(0) + "–" + narrow.cardBottom.toFixed(0) + "；视口 " + narrow.innerWidth + "×" + narrow.innerHeight : "");
  check("窄视口下触发水平夹取（允许卡片压到图片上）", narrow.error === undefined && narrow.clampLeft === true, narrow.error === undefined ? "clampLeft=" + narrow.clampLeft : "");
  check("窄视口下卡片与图片确实有重叠（设计允许）", narrow.error === undefined && narrow.overlapDot === true, narrow.error === undefined ? String(narrow.overlapDot) : "");
  check("窄视口下图片中心 elementFromPoint 仍命中图片", narrowHit.insideDot === true, "命中 " + narrowHit.tag + "." + narrowHit.cls);
  const overlapHit = await page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (dot === null || card === null) return { error: "missing" };
    const dr = dot.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const x = Math.round(Math.max(cr.left, dr.left) + 4);
    const y = Math.round(dr.top + dr.height / 2);
    const el = document.elementFromPoint(x, y);
    return {
      x: x,
      y: y,
      inCard: x >= cr.left && x <= cr.right && y >= cr.top && y <= cr.bottom,
      insideDot: el !== null && typeof el.closest === "function" && el.closest(".dsh-bc-dot") !== null,
      tag: el === null ? null : el.tagName,
      cls: el === null ? null : String(el.className),
    };
  });
  check("窄视口下卡片/图片重叠处仍命中图片（层级正确）", overlapHit.inCard === true && overlapHit.insideDot === true, JSON.stringify(overlapHit));
  check("窄视口下仍能点图片收起", await clickDot() === true);
  await sleep(400);
  check("窄视口下点图片后确实收起了", (await isOpen()) === "false");
  await session.send("Emulation.clearDeviceMetricsOverride");
  await sleep(600);

  // ── H. prefers-reduced-motion ───────────────────────────
  section("H. prefers-reduced-motion：动画与过渡关掉");
  if ((await isOpen()) === "true") {
    await clickClose();
    await sleep(500);
  }
  await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(300);
  const reduced = await page(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null || dot === null || card === null) return { error: "missing" };
    const cs = getComputedStyle(card);
    const before = { transition: cs.transitionProperty + " " + cs.transitionDuration, animation: getComputedStyle(dot).animationName };
    const r = dot.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 10, pointerType: "mouse", button: 0, buttons: 1, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    await sleep(120);
    const after = { open: root.dataset.open, opacity: getComputedStyle(card).opacity, animations: dot.getAnimations().length };
    return { transition: before.transition, dotAnimationName: before.animation, after: after };
  });
  check("reduce 下卡片 transition:none", reduced.error === undefined && String(reduced.transition) === "none 0s", String(reduced.transition));
  check("reduce 下点开后 120ms 已到 opacity=1（无过渡）", reduced.error === undefined && reduced.after.open === "true" && Number(reduced.after.opacity) === 1, JSON.stringify(reduced.after));
  check("reduce 下点击不再有 keyframe 回弹", reduced.error === undefined && Number(reduced.after.animations) === 0, String(reduced.after === undefined ? null : reduced.after.animations));
  await session.send("Emulation.setEmulatedMedia", { features: [] });
  await sleep(300);

  // ── I. 60s 自动刷新：注册与清理 ─────────────────────────
  section("I. 展开注册 60s 自动刷新、收起清掉");
  const timerBefore = await page(() => {
    const t = window.__dshBcTimers;
    return { open: document.querySelector(".dsh-bc-root").dataset.open, intervals: t.intervals.slice(), clears: t.clears.slice() };
  });
  check("展开态注册了 60s setInterval", timerBefore.open === "true" && timerBefore.intervals.filter(function (v) { return v.ms === 60000; }).length >= 1, JSON.stringify(timerBefore.intervals.filter(function (v) { return v.ms === 60000; }).slice(0, 3)));
  if (timerBefore.open === "true") {
    await clickClose();
  } else {
    await clickDot();
    await sleep(400);
    await clickClose();
  }
  await sleep(500);
  const timerAfter = await page(() => {
    const t = window.__dshBcTimers;
    return { open: document.querySelector(".dsh-bc-root").dataset.open, intervals: t.intervals.slice(), clears: t.clears.slice() };
  });
  const ids60000 = timerAfter.intervals.filter(function (v) { return v.ms === 60000; }).map(function (v) { return v.id; });
  check("收起后 data-open=false", timerAfter.open === "false", String(timerAfter.open));
  check("收起后 60s 定时器被 clearInterval 清掉", ids60000.length >= 1 && ids60000.every(function (id) { return timerAfter.clears.indexOf(id) >= 0; }), "60000 的 id=" + JSON.stringify(ids60000) + "，clears=" + JSON.stringify(timerAfter.clears.slice(-5)));

  // ── J. 控制台 ───────────────────────────────────────────
  section("J. 浏览器控制台");
  const pluginErrors = session.consoleErrors.filter((t) => t.indexOf("dsh-balance-card") >= 0);
  check("没有本插件产生的 console.error", pluginErrors.length === 0, pluginErrors.join(" | "));
  check("页面无任何 console.error / 未捕获异常", session.consoleErrors.length === 0, "共 " + session.consoleErrors.length + " 条");
  if (session.consoleErrors.length > 0) {
    console.log("    页面上的 console.error / 异常：");
    for (const e of session.consoleErrors.slice(0, 8)) console.log("      " + String(e).slice(0, 220));
  }
} catch (error) {
  console.error("验证脚本自身出错：" + String(error && error.message !== undefined ? error.message : error));
  if (session.consoleErrors.length > 0) {
    console.error("收集到的 console.error：");
    for (const e of session.consoleErrors.slice(0, 10)) console.error("  " + String(e).slice(0, 300));
  }
  process.exitCode = 2;
} finally {
  try {
    await session.send("Emulation.clearDeviceMetricsOverride");
  } catch {
    /* 浏览器可能已经关了 */
  }
  try {
    await session.send("Emulation.setEmulatedMedia", { features: [] });
  } catch {
    /* 同上 */
  }
  try {
    session.close();
  } catch {
    /* 关不掉就算了 */
  }
}

const failed = results.filter((r) => !r.ok);
console.log("\n" + (failed.length === 0 ? "全部通过" : "有失败") + "：" + (results.length - failed.length) + "/" + results.length);
if (failed.length > 0) {
  console.log("失败项：");
  for (const r of failed) console.log("  ✗ " + r.label + (r.detail === undefined ? "" : " —— " + r.detail));
}
if (process.exitCode === undefined) process.exitCode = failed.length === 0 ? 0 : 1;
