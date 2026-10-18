/**
 * 用无头 Edge + CDP 验证「余额与用量」卡片**真的在浏览器里活着**，并逐条跑验收清单。
 *
 * 本版按**新形态**重写（2026-10-18）：
 *   - 卡片不再「点开后在按钮上方」；图片按钮**永不卸载**，卡片常驻 DOM、点图片后从图片左侧滑出。
 *   - 展开状态唯一真相：root 的 data-open="true"|"false"。
 *   - 落位：卡片右边缘 = 图片**可见**左边缘（contain 实画区）− 8px；垂直中心对齐；视口 8px 夹取。
 *   - 旧的 data-align=above-button/below-button 断言已删除。
 *
 * 用法：
 *   node verify-card.mjs <带 token 的 lab URL> [调试端口]
 *
 * 注意：Edge 用 stdio:"ignore" 启动 —— 受限沙箱禁止带管道的子进程。
 */
import { REPO, buttonSize, launch, navigate, reload, waitFor, sleep } from "./cdp-session.mjs";

const SIZE = buttonSize();
const DOT_W = SIZE.w;
const DOT_H = SIZE.h;
const GAP = 8;

const url = process.argv[2];
const port = Number(process.argv[3] ?? 9337);

if (url === undefined) {
  console.error("用法: node verify-card.mjs <带 token 的 lab URL> [调试端口]");
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

/**
 * 页面级定时器探针：记录 setInterval/clearInterval 的延时与 id，用来验证
 * 「展开时注册 60s 自动刷新、收起时清掉」——不用真等 60 秒。
 */
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

/** 点一下图片（真实 PointerEvent 序列：down → up）。 */
async function clickDot() {
  return page(() => {
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return { ok: false, reason: "no dot" };
    const r = dot.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
    };
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    return { ok: true, x: x, y: y };
  });
}

/** 拖动图片或卡片：move 分两段，超过 4px 阈值。 */
async function drag(selector, dx, dy) {
  return pageCall(
    (selector, dx, dy) => {
      const el = document.querySelector(selector);
      if (el === null) return { ok: false, reason: "no " + selector };
      const r = el.getBoundingClientRect();
      const sx = Math.round(r.left + r.width / 2);
      const sy = Math.round(r.top + Math.min(12, r.height / 3));
      const mk = (type, x, y, buttons) =>
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "mouse",
          button: 0,
          buttons: buttons,
          clientX: x,
          clientY: y,
        });
      el.dispatchEvent(mk("pointerdown", sx, sy, 1));
      el.dispatchEvent(mk("pointermove", sx + Math.round(dx / 2), sy + Math.round(dy / 2), 1));
      el.dispatchEvent(mk("pointermove", sx + dx, sy + dy, 1));
      el.dispatchEvent(mk("pointerup", sx + dx, sy + dy, 0));
      return { ok: true };
    },
    selector,
    dx,
    dy,
  );
}

/** 当前状态 + 关键几何。 */
async function snapshot() {
  return page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null) return { error: "no root" };
    const rr = root.getBoundingClientRect();
    const dr = dot === null ? null : dot.getBoundingClientRect();
    const cr = card === null ? null : card.getBoundingClientRect();
    const cs = card === null ? null : getComputedStyle(card);
    const round = (v) => Math.round(v);
    return {
      open: root.dataset.open,
      hasDot: dot !== null,
      hasCard: card !== null,
      root: { left: rr.left, top: rr.top, w: rr.width, h: rr.height, right: rr.right, bottom: rr.bottom },
      dot: dr === null ? null : { left: dr.left, top: dr.top, w: dr.width, h: dr.height, right: dr.right, bottom: dr.bottom },
      card: cr === null ? null : { left: cr.left, top: cr.top, w: cr.width, h: cr.height, right: cr.right, bottom: cr.bottom },
      cardOpacity: cs === null ? null : cs.opacity,
      cardPointerEvents: cs === null ? null : cs.pointerEvents,
      cardVisibility: cs === null ? null : cs.visibility,
      cardInert: card !== null && card.hasAttribute("inert"),
      cardAriaHidden: card === null ? null : card.getAttribute("aria-hidden"),
      dotAriaExpanded: dot === null ? null : dot.getAttribute("aria-expanded"),
      dotRole: dot === null ? null : dot.getAttribute("role"),
      dotTabIndex: dot === null ? null : dot.getAttribute("tabindex"),
      cardStyleLeft: card === null ? null : card.style.left,
      cardStyleTop: card === null ? null : card.style.top,
      dotBox: root.dataset.dotBox === undefined ? null : root.dataset.dotBox,
      placeInfo: root.dataset.placeInfo === undefined ? null : root.dataset.placeInfo,
      alignAttr: root.dataset.align === undefined ? null : root.dataset.align,
      stored: localStorage.getItem("dsh-balance-card:state"),
      viewport: { w: window.innerWidth, h: window.innerHeight },
      dotRectRounded: round(dr === null ? 0 : dr.left) + "," + round(dr === null ? 0 : dr.top) + "," + round(dr === null ? 0 : dr.width) + "," + round(dr === null ? 0 : dr.height),
    };
  });
}

/** 落位期望值（按客户端 placeCard 的公式在页面里重算，逐项对比）。 */
async function placement() {
  return page(() => {
    const root = document.querySelector(".dsh-bc-root");
    const dot = document.querySelector(".dsh-bc-dot");
    const card = document.querySelector(".dsh-bc-card");
    if (root === null || dot === null || card === null) return { error: "missing" };
    // 用 root 的矩形量：root 不参与点击回弹动画，而 dot 在 tap keyframe 期间会被缩放
    // （客户端的 placeCard 也是这么改的）。
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
    const styleLeft = Number.parseFloat(card.style.left);
    const styleTop = Number.parseFloat(card.style.top);
    return {
      paintedLeft: paintedLeft,
      paintedW: paintedW,
      dotLeft: dr.left,
      dotTop: dr.top,
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
      desiredLeft: desiredLeft,
      desiredTop: desiredTop,
      clampLeft: left !== desiredLeft,
      clampTop: top !== desiredTop,
      styleLeft: styleLeft,
      styleTop: styleTop,
      expectedStyleLeft: left,
      expectedStyleTop: top,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dotW: dr.width,
      dotH: dr.height,
    };
  });
}

/** elementFromPoint 在图片中心命中谁 —— 验证图片永远是最上层、可点。 */
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
      isDot: el === dot,
      dotZ: getComputedStyle(dot).zIndex,
      cardZ: card === null ? null : getComputedStyle(card).zIndex,
      x: x,
      y: y,
    };
  });
}

try {
  console.log("浏览器: " + session.version.Browser);
  // 统一视口：attach 到的浏览器窗口可能很小（实测 500×320），不归一化的话落位全被视口夹取。
  await session.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1500, deviceScaleFactor: 1, mobile: false });
  await navigate(session, url, { settleMs: 9000 });
  // 先清状态再 reload：否则上一轮存下的 open=true 会让页面一加载就是展开态，测不到点击开合。
  // attach 模式下同一个 origin 可能有别的 tab 在动状态，所以最多重试一次。
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

  // ── 1. 挂载 ─────────────────────────────────────────────
  section("1. 卡片是否真的挂上 DOM");
  const mounted = await page(() => {
    const host = document.getElementById("dsh-balance-card-host");
    const root = document.querySelector(".dsh-bc-root");
    const inBodyTree = () => {
      let n = root === null ? null : root.parentNode;
      while (n !== null && n !== document.body) {
        if (n.id !== "dsh-balance-card-host") return false;
        n = n.parentNode;
      }
      return n === document.body;
    };
    const r = root === null ? null : root.getBoundingClientRect();
    return {
      host: host !== null,
      root: root !== null,
      inBodyTree: inBodyTree(),
      position: root === null ? null : getComputedStyle(root).position,
      zIndex: root === null ? null : getComputedStyle(root).zIndex,
      w: r === null ? 0 : Math.round(r.width),
      h: r === null ? 0 : Math.round(r.height),
      inViewport: r !== null && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      moduleLoader: typeof window.__ModuleLoader__ !== "undefined",
    };
  });
  check("宿主 div 存在", mounted.host);
  check("卡片根节点存在", mounted.root);
  check("挂在 document.body 下（不在任何 slot 里）", mounted.inBodyTree);
  check("root position: fixed", mounted.position === "fixed", String(mounted.position));
  check("root 尺寸 = 图片按钮尺寸 " + DOT_W + "×" + DOT_H, mounted.w === DOT_W && mounted.h === DOT_H, mounted.w + "×" + mounted.h);
  check("root 完全落在视口内", mounted.inViewport, JSON.stringify({ w: mounted.w, h: mounted.h, viewport: mounted.viewport }));
  check("window.__ModuleLoader__ 存在（加载机制一致）", mounted.moduleLoader);

  // ── 2. 收起态（卡片与图片都常驻）────────────────────────
  section("2. 收起态：图片 + 卡片都在 DOM 里，卡片不可见不可点");
  const closed = await snapshot();
  check("data-open = false", closed.open === "false", String(closed.open));
  check("图片按钮常驻 DOM", closed.hasDot);
  check("卡片常驻 DOM（不是卸载）", closed.hasCard);
  check("图片尺寸 " + DOT_W + "×" + DOT_H, closed.dot !== null && Math.round(closed.dot.w) === DOT_W && Math.round(closed.dot.h) === DOT_H, closed.dot === null ? "" : Math.round(closed.dot.w) + "×" + Math.round(closed.dot.h));
  check("卡片 opacity = 0", closed.cardOpacity === "0", String(closed.cardOpacity));
  check("卡片 pointer-events = none", closed.cardPointerEvents === "none", String(closed.cardPointerEvents));
  check("卡片 visibility = hidden", closed.cardVisibility === "hidden", String(closed.cardVisibility));
  check("卡片带 inert（不可聚焦）", closed.cardInert === true, String(closed.cardInert));
  check("卡片 aria-hidden = true", closed.cardAriaHidden === "true", String(closed.cardAriaHidden));
  check("图片 aria-expanded = false", closed.dotAriaExpanded === "false", String(closed.dotAriaExpanded));
  check("图片 role=button / tabIndex=0（可键盘操作）", closed.dotRole === "button" && closed.dotTabIndex === "0", closed.dotRole + "/" + closed.dotTabIndex);
  check("图片里是 <img> 且解码成功", await page(() => { const img = document.querySelector(".dsh-bc-dot img"); return img !== null && img.complete && img.naturalWidth > 0; }));
  check("含 SVG 兜底图标", await page(() => document.querySelector(".dsh-bc-dot svg") !== null));
  check("没有残留旧的 data-align", closed.alignAttr === null, String(closed.alignAttr));

  // ── 3. 点图片展开 ───────────────────────────────────────
  section("3. 点图片展开（卡片从图片左侧滑出）");
  const before = await snapshot();
  await clickDot();
  await sleep(500);
  const opened = await snapshot();
  check("点图片后 data-open = true", opened.open === "true", String(opened.open));
  check("展开后图片仍在 DOM 里", opened.hasDot);
  check("展开后卡片可见", opened.cardOpacity === "1" && opened.cardVisibility === "visible" && opened.cardPointerEvents === "auto", closed.cardOpacity + " → " + opened.cardOpacity);
  check("展开后卡片可交互（无 inert）", opened.cardInert === false);
  check("展开态写进 localStorage", typeof opened.stored === "string" && opened.stored.indexOf('"open":true') >= 0, String(opened.stored));
  check("图片 aria-expanded = true", opened.dotAriaExpanded === "true", String(opened.dotAriaExpanded));
  check("卡片宽度 320px", opened.card !== null && Math.round(opened.card.w) === 320, opened.card === null ? "" : String(Math.round(opened.card.w)));
  check("展开后卡片位置发生变化（相对收起态）", before.card !== null && opened.card !== null && (Math.abs(opened.card.left - before.card.left) > 4 || Math.abs(opened.card.top - before.card.top) > 4), before.card === null ? "" : "left " + before.card.left.toFixed(0) + " → " + opened.card.left.toFixed(0));

  section("3b. 落位：右边缘贴图片可见左缘 − " + GAP + "px、垂直居中、视口夹取");
  const place = await placement();
  check("能取到落位几何", place.error === undefined, JSON.stringify(place).slice(0, 200));
  if (place.error === undefined) {
    const dRight = place.cardRight - place.expectedRight;
    check("卡片右边缘 = 图片可见左边缘 − 8px（≤2px）", Math.abs(dRight) <= 2, "实测 " + place.cardRight.toFixed(1) + "，期望 " + place.expectedRight.toFixed(1) + "，差 " + dRight.toFixed(1) + "px");
    const dTop = place.cardTop - place.expectedTopViewport;
    check("卡片顶边 = 垂直居中后按视口夹取（≤2px）", Math.abs(dTop) <= 2, "实测 " + place.cardTop.toFixed(1) + "，期望 " + place.expectedTopViewport.toFixed(1) + "，差 " + dTop.toFixed(1) + "px" + (place.clampTop ? "（触发垂直夹取）" : ""));
    if (!place.clampTop) {
      const dCenter = place.cardCenterY - place.dotCenterY;
      check("卡片垂直中心 = 图片垂直中心（≤2px）", Math.abs(dCenter) <= 2, "差 " + dCenter.toFixed(1) + "px");
    } else {
      console.log("    垂直中心差 " + (place.cardCenterY - place.dotCenterY).toFixed(1) + "px（夹取导致，按夹取公式断言）");
    }
    check("卡片完全在视口内（四周 8px 夹取）", place.cardLeft >= 8 - 1 && place.cardTop >= 8 - 1 && place.cardRight <= place.innerWidth - 8 + 1 && place.cardBottom <= place.innerHeight - 8 + 1, "卡片 x " + place.cardLeft.toFixed(0) + "–" + place.cardRight.toFixed(0) + " y " + place.cardTop.toFixed(0) + "–" + place.cardBottom.toFixed(0) + "；视口 " + place.innerWidth + "×" + place.innerHeight);
    check("卡片内联 left/top 是相对 root 的 px（left 为负 = 在图片左侧）", Number.isFinite(place.styleLeft) && Number.isFinite(place.styleTop) && Math.abs(place.styleLeft - place.expectedStyleLeft) <= 1 && Math.abs(place.styleTop - place.expectedStyleTop) <= 1, "style left/top = " + place.styleLeft + "px / " + place.styleTop + "px，期望 " + Math.round(place.expectedStyleLeft) + "/" + Math.round(place.expectedStyleTop));
    check("卡片实际位置 = 图片位置 + 内联偏移（证明相对 root）", Math.abs(place.cardLeft - (place.dotLeft + place.styleLeft)) <= 1 && Math.abs(place.cardTop - (place.dotTop + place.styleTop)) <= 1, "差 " + (place.cardLeft - (place.dotLeft + place.styleLeft)).toFixed(1) + " / " + (place.cardTop - (place.dotTop + place.styleTop)).toFixed(1) + "px");
    check("卡片整体在图片左侧（card.right ≤ dot.left）", place.cardRight <= place.dotLeft, "card.right " + place.cardRight.toFixed(1) + " vs dot.left " + place.dotLeft.toFixed(1));
    check("data-place-info 存在且格式正确", opened.placeInfo !== null && /paintedLeft=-?\d+ card=320x\d+ left=-?\d+ top=-?\d+ gap=8/.test(opened.placeInfo), String(opened.placeInfo));
    check("data-dot-box = 图片 viewport 矩形（left,top,w,h）", opened.dotBox === opened.dotRectRounded, "dotBox=" + opened.dotBox + "，实测 " + opened.dotRectRounded);
  }

  const hit = await hitTestDot();
  check("图片中心 elementFromPoint 命中图片（不是卡片）", hit.insideDot === true, "命中 " + hit.tag + "." + hit.cls);
  check("图片层级高于卡片", Number(hit.dotZ) > Number(hit.cardZ), "dot z=" + hit.dotZ + "，card z=" + hit.cardZ);

  // ── 4. 点卡片本体不切换 ─────────────────────────────────
  section("4. 点卡片本体不切换（只有图片是开关）");
  const cardClick = await page(() => {
    const card = document.querySelector(".dsh-bc-card");
    if (card === null) return { error: "no card" };
    const r = card.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height * 0.62);
    const mk = (type, buttons) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 3, pointerType: "mouse", button: 0, buttons: buttons, clientX: x, clientY: y });
    card.dispatchEvent(mk("pointerdown", 1));
    card.dispatchEvent(mk("pointerup", 0));
    return true;
  });
  await sleep(400);
  const afterCardClick = await snapshot();
  check("点卡片空白处后仍保持展开", cardClick === true && afterCardClick.open === "true", String(afterCardClick.open));

  // ── 5. ✕ 收起 ───────────────────────────────────────────
  section("5. ✕ 收起");
  const closeClicked = await page(() => {
    const btn = document.querySelector(".dsh-bc-close");
    if (btn === null) return { ok: false };
    btn.click();
    return { ok: true };
  });
  await sleep(500);
  const closedByX = await snapshot();
  check("点 ✕ 后 data-open = false", closeClicked.ok === true && closedByX.open === "false", String(closedByX.open));
  check("点 ✕ 后卡片回到不可见/不可点", closedByX.cardOpacity === "0" && closedByX.cardPointerEvents === "none", closedByX.cardOpacity + " / " + closedByX.cardPointerEvents);
  check("收起写进 localStorage", typeof closedByX.stored === "string" && closedByX.stored.indexOf('"open":false') >= 0, String(closedByX.stored));

  // ── 6. 拖动（图片 / 卡片）与坐标持久化 ──────────────────
  section("6. 拖动与位置持久化（x/y = 图片框左上角）");
  const beforeDrag = await snapshot();
  const dragDotRes = await drag(".dsh-bc-dot", -120, -90);
  await sleep(500);
  const afterDotDrag = await snapshot();
  const dragged = afterDotDrag.root;
  const movedByDot = Math.abs(dragged.left - (beforeDrag.root.left - 120)) <= 3 && Math.abs(dragged.top - (beforeDrag.root.top - 90)) <= 3;
  check("拖动图片：root 真的移动了", dragDotRes.ok === true && movedByDot, "root " + Math.round(dragged.left) + "," + Math.round(dragged.top) + "（期望约 " + Math.round(beforeDrag.root.left - 120) + "," + Math.round(beforeDrag.root.top - 90) + "）");
  check("拖动图片后仍是收起态", afterDotDrag.open === "false", String(afterDotDrag.open));
  const storedAfterDot = JSON.parse(String(afterDotDrag.stored));
  check("localStorage x/y = 图片框左上角", storedAfterDot.x === Math.round(dragged.left) && storedAfterDot.y === Math.round(dragged.top), "x/y=" + storedAfterDot.x + "/" + storedAfterDot.y + "，root=" + Math.round(dragged.left) + "/" + Math.round(dragged.top));

  await clickDot();
  await sleep(500);
  const beforeCardDrag = await snapshot();
  const cardDragRes = await drag(".dsh-bc-card", 70, -50);
  await sleep(500);
  const afterCardDrag = await snapshot();
  check("拖动卡片：整体移动了", cardDragRes.ok === true && Math.abs(afterCardDrag.root.left - (beforeCardDrag.root.left + 70)) <= 3 && Math.abs(afterCardDrag.root.top - (beforeCardDrag.root.top - 50)) <= 3, "root " + Math.round(beforeCardDrag.root.left) + "," + Math.round(beforeCardDrag.root.top) + " → " + Math.round(afterCardDrag.root.left) + "," + Math.round(afterCardDrag.root.top));
  check("拖动卡片后仍是展开态", afterCardDrag.open === "true", String(afterCardDrag.open));
  check("拖动卡片不改变卡片相对位置（卡片跟着图片走）", Math.abs(afterCardDrag.card.left - afterCardDrag.dot.left - (beforeCardDrag.card.left - beforeCardDrag.dot.left)) <= 1, "相对偏移 " + (beforeCardDrag.card.left - beforeCardDrag.dot.left).toFixed(0) + " → " + (afterCardDrag.card.left - afterCardDrag.dot.left).toFixed(0));
  const storedAfterCard = JSON.parse(String(afterCardDrag.stored));
  check("拖动卡片后 localStorage x/y = 图片框左上角", storedAfterCard.x === Math.round(afterCardDrag.root.left) && storedAfterCard.y === Math.round(afterCardDrag.root.top), "x/y=" + storedAfterCard.x + "/" + storedAfterCard.y);

  // ── 7. 刷新页面后位置与展开态保留 ──────────────────────
  section("7. 刷新后位置与展开态是否保留");
  await reload(session, { settleMs: 9000 });
  await waitFor(session, "document.querySelector('.dsh-bc-root') !== null", { timeoutMs: 20000, label: "reload 后 root 出现" });
  await sleep(1200);
  const afterReload = await snapshot();
  check("刷新后卡片仍在（root/dot/card 都在）", afterReload.hasDot === true && afterReload.hasCard === true && afterReload.error === undefined, JSON.stringify({ dot: afterReload.hasDot, card: afterReload.hasCard }));
  check("刷新后展开态保留（open=true）", afterReload.open === "true", String(afterReload.open));
  check("刷新后位置 = 拖动结果（x/y，±2px）", Math.abs(afterReload.root.left - storedAfterCard.x) <= 2 && Math.abs(afterReload.root.top - storedAfterCard.y) <= 2, "实测 " + Math.round(afterReload.root.left) + "," + Math.round(afterReload.root.top) + " vs 存储 " + storedAfterCard.x + "," + storedAfterCard.y);
  const placeAfterReload = await placement();
  check("刷新后落位仍正确（右边缘 ≤2px）", placeAfterReload.error === undefined && Math.abs(placeAfterReload.cardRight - placeAfterReload.expectedRight) <= 2, "差 " + (placeAfterReload.cardRight - placeAfterReload.expectedRight).toFixed(1) + "px");

  // ── 8. 刷新数据不移动位置 + 60s 自动刷新 ──────────────
  section("8. 展开后刷新不动位置 + 60s 自动刷新定时器");
  const beforeRefresh = await snapshot();
  const refreshClicked = await page(() => {
    const btn = document.querySelector(".dsh-bc-btn[title='刷新']");
    if (btn === null) return { ok: false };
    btn.click();
    return { ok: true };
  });
  await sleep(1500);
  const afterRefresh = await snapshot();
  check("点 ⟳ 刷新数据后位置完全不动（root ±1px）", refreshClicked.ok === true && Math.abs(afterRefresh.root.left - beforeRefresh.root.left) <= 1 && Math.abs(afterRefresh.root.top - beforeRefresh.root.top) <= 1, "root " + Math.round(beforeRefresh.root.left) + "," + Math.round(beforeRefresh.root.top) + " → " + Math.round(afterRefresh.root.left) + "," + Math.round(afterRefresh.root.top));
  check("刷新数据后卡片相对位置不动（内联 left/top ±1px）", afterRefresh.cardStyleLeft === beforeRefresh.cardStyleLeft && afterRefresh.cardStyleTop === beforeRefresh.cardStyleTop, "left/top " + beforeRefresh.cardStyleLeft + "/" + beforeRefresh.cardStyleTop + " → " + afterRefresh.cardStyleLeft + "/" + afterRefresh.cardStyleTop);
  check("展开后仍保持 open=true", afterRefresh.open === "true", String(afterRefresh.open));
  const timerInfo = await page(() => {
    const t = window.__dshBcTimers;
    return { intervals: t === undefined || t === null ? [] : t.intervals.slice(), clears: t === undefined || t === null ? [] : t.clears.slice() };
  });
  const autoRefresh = timerInfo.intervals.filter((v) => v.ms === 60000);
  check("展开时注册了 60s 自动刷新 setInterval", autoRefresh.length >= 1, JSON.stringify(autoRefresh.slice(0, 3)));
  check("自动刷新定时器没有被提前清掉", autoRefresh.every((v) => timerInfo.clears.indexOf(v.id) < 0), "clears=" + JSON.stringify(timerInfo.clears));

  // ── 9. 数据链路 ─────────────────────────────────────────
  section("9. 数据链路（宿主路由 → 卡片）");
  const fetched = await page(async () => {
    const res = await fetch("balance-card/snapshot");
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 就没有下面这些 */
    }
    return {
      status: res.status,
      ok: res.ok,
      keys: json === null ? null : Object.keys(json),
      balance: json === null ? null : json.balance,
      today: json === null || json.usage === null || json.usage === undefined ? null : json.usage.windows.today,
      all: json === null || json.usage === null || json.usage === undefined ? null : json.usage.windows.all,
      files: json === null || json.scan === null || json.scan === undefined ? null : json.scan.files,
    };
  });
  check("自带路由可达（相对路径，无前导斜杠）", fetched.ok === true, "HTTP " + fetched.status);
  check("返回 balance / usage / pricing 三段", Array.isArray(fetched.keys) && fetched.keys.indexOf("balance") >= 0 && fetched.keys.indexOf("usage") >= 0, JSON.stringify(fetched.keys));
  check("余额状态 ready（假服务器 /ok）", fetched.balance !== null && fetched.balance.status === "ready", JSON.stringify(fetched.balance));
  check("余额能拆出赠金/充值", fetched.balance !== null && fetched.balance.balance.granted === 2 && fetched.balance.balance.toppedUp === 10.34, JSON.stringify(fetched.balance === null ? null : fetched.balance.balance));
  check("用量的今日窗口有数字", fetched.today !== null && (fetched.today.calls || 0) > 0, JSON.stringify(fetched.today));
  check("扫到了真实会话文件", (fetched.files || 0) > 0, "files=" + fetched.files);
  console.log("    今日 " + (fetched.today === null ? "?" : fetched.today.calls) + " 次调用 · 全部 " + (fetched.all === null ? "?" : fetched.all.calls) + " 次");

  // ── 10. 卡片文字 ───────────────────────────────────────
  section("10. 卡片最终渲染的数字");
  const finalText = await page(() => {
    const c = document.querySelector(".dsh-bc-card");
    return c === null ? null : c.innerText;
  });
  console.log(String(finalText === null ? "" : finalText).split("\n").map(function (l) { return "    " + l; }).join("\n"));
  check("卡片上出现了人民币金额", typeof finalText === "string" && finalText.indexOf("￥") >= 0);
  check("卡片上出现了 token 数字（不是 loading 态）", typeof finalText === "string" && /M|K|B/.test(finalText));

  // ── 11. 首开耗时 ────────────────────────────────────────
  // 必须先 reload 且 open=false：卡片常驻后，收起态也保留着上一轮的文本，
  // 不 reload 的话「点开→看见数字」会在 0ms 就命中旧文本，测的是假的。
  section("11. 首开耗时（点开 → 看见数字）");
  await page(() => {
    let s = {};
    try {
      s = JSON.parse(localStorage.getItem("dsh-balance-card:state") || "{}");
    } catch {
      s = {};
    }
    s.open = false;
    localStorage.setItem("dsh-balance-card:state", JSON.stringify(s));
    return true;
  });
  await reload(session, { settleMs: 9000 });
  await waitFor(session, "document.querySelector('.dsh-bc-root') !== null", { timeoutMs: 20000, label: "timing reload 后 root 出现" });
  await sleep(800);
  const timing = await page(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const close = document.querySelector(".dsh-bc-close");
    if (close !== null) {
      close.click();
      await sleep(400);
    }
    const dot = document.querySelector(".dsh-bc-dot");
    if (dot === null) return { error: "no dot" };
    const r = dot.getBoundingClientRect();
    const base = { bubbles: true, cancelable: true, pointerId: 11, pointerType: "mouse", button: 0, buttons: 1, clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2) };
    const t0 = performance.now();
    dot.dispatchEvent(new PointerEvent("pointerdown", base));
    dot.dispatchEvent(new PointerEvent("pointerup", Object.assign({}, base, { buttons: 0 })));
    for (let i = 0; i < 80; i++) {
      const c = document.querySelector(".dsh-bc-card");
      if (c !== null && /M|K|B/.test(c.innerText)) return { ms: Math.round(performance.now() - t0) };
      await sleep(100);
    }
    return { ms: null };
  });
  check("点开卡片到看见数字 < 2000 ms", typeof timing.ms === "number" && timing.ms < 2000, timing.ms === null ? "超时未见数字" : timing.ms + " ms");

  // ── 12. 控制台 ─────────────────────────────────────────
  section("12. 浏览器控制台");
  const pluginErrors = session.consoleErrors.filter((t) => t.indexOf("dsh-balance-card") >= 0);
  check("没有本插件产生的 console.error", pluginErrors.length === 0, pluginErrors.join(" | "));
  check("页面无任何 console.error / 未捕获异常", session.consoleErrors.length === 0, "共 " + session.consoleErrors.length + " 条");
  const mountLog = session.consoleLogs.find((t) => t.indexOf("[dsh-balance-card] 卡片已挂载") >= 0);
  check("能看到「卡片已挂载」日志", mountLog !== undefined, mountLog === undefined ? "（没找到）" : mountLog);
  if (session.consoleErrors.length > 0) {
    console.log("    页面上的 console.error / 异常：");
    for (const e of session.consoleErrors.slice(0, 6)) console.log("      " + String(e).slice(0, 200));
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
