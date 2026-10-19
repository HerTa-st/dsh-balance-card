/**
 * dsh-balance-card —— 客户端（浏览器侧）。
 *
 * ## 形式：一张挂在 <body> 下的浮层卡片，不进任何 slot
 *
 * 官方 slot 都是**固定座位**，做不了「随意拖动」。所以这张卡自己往 `document.body`
 * 插一层浮点定位的宿主，因此：不依赖任何 slot 的声明周期，也不怕 slot 被删/改名
 * ——官方 0.2.0 就真的删过一个第三方插件在用的 slot，这是实测教训。
 *
 * ## 不打包
 *
 * 这个文件被 DSH 当作浏览器 bundle **原样**伺服（`exports["./client"]` 指向它自己），
 * 所以不需要 esbuild/tsc：没有构建步骤，改完刷新页面即可。
 * 代价是只能 `require` 外壳**冻结模块表**里的那 9 个名字（react / react-dom / …）。
 *
 * ## 取数
 *
 * `fetch` 的目标路径必须是**文档相对**的（无前导斜杠）：宿主用 `<base href="./">`
 * 伺服界面，根绝对路径会绕过那个前缀，永远打不到宿主路由。
 */
window.__ModuleLoader__.load({
  // 模块身份必须等于包名：宿主按 package.json 的 name 建 boot 图行，
  // 这里若仍用改名前的 `dsh-balance-card`，该行永远等不到注册，客户端会退到
  // 单资源 URL 再跑一遍同一个 bundle —— 第二次注册即
  // `duplicate factory registration` 并让整个 web boot 失败。
  id: "dsh-herta-balance-card",
  factory(require) {
    const React = require("react");

    /** 数据路由前缀 —— 与宿主里的 `DATA_ROUTE` 必须一致。 */
    const DATA_ROUTE = "balance-card";

    /** localStorage 键：位置与展开态（你确认过的决定）。 */
    const STATE_KEY = "dsh-balance-card:state";

    /** 卡片展开时的自动刷新间隔。收起等于停（你确认过的决定）。 */
    const AUTO_REFRESH_MS = 60_000;

    /** 卡片右边缘与图片**可见**左边缘之间的缝（px）。 */
    const CARD_GAP = 8;

    // ── 令牌：只用 --dsw-alias-*，每个都带回退值，主题不在时也不塌 ──
    const T = {
      bg: "var(--dsw-alias-bg-overlay, rgba(46, 38, 54, 0.95))",
      dotBg: "var(--dsw-alias-bg-layer-3, rgba(56, 46, 66, 0.88))",
      border: "var(--dsw-alias-border-l2, rgba(180, 159, 187, 0.30))",
      borderSoft: "var(--dsw-alias-border-l1, rgba(180, 159, 187, 0.18))",
      text: "var(--dsw-alias-label-primary, #ebdfe7)",
      text2: "var(--dsw-alias-label-secondary, #b49fbb)",
      text3: "var(--dsw-alias-label-tertiary, #88749e)",
      dim: "var(--dsw-alias-label-dimmed, #564969)",
      accent: "var(--dsw-alias-brand-primary, #9b8ae0)",
      warn: "var(--dsw-alias-warning-primary, #d9a441)",
      font: "system-ui, 'Microsoft YaHei', sans-serif",
    };

    // ── 小工具 ──
    function fmtTokens(n) {
      if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "0";
      if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
      if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
      if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
      return String(Math.round(n));
    }
    function fmtMoney(yuan) {
      if (yuan === null || typeof yuan !== "number" || !Number.isFinite(yuan)) return "—";
      if (yuan > 0 && yuan < 0.01) return "<￥0.01";
      return "￥" + yuan.toFixed(2);
    }
    function fmtTime(ms) {
      if (typeof ms !== "number" || ms <= 0) return "—";
      const d = new Date(ms);
      const p = (v) => String(v).padStart(2, "0");
      return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    function fmtAmount(value, currency) {
      if (value === null || typeof value !== "number" || !Number.isFinite(value)) return "—";
      const symbol = currency === "USD" ? "$" : "￥";
      return symbol + value.toFixed(2);
    }

    // ── 位置与展开态的持久化 ──
    function loadState() {
      try {
        const raw = window.localStorage.getItem(STATE_KEY);
        if (raw === null) return { x: null, y: null, open: false };
        const v = JSON.parse(raw);
        return {
          x: typeof v.x === "number" ? v.x : null,
          y: typeof v.y === "number" ? v.y : null,
          open: v.open === true,
        };
      } catch {
        return { x: null, y: null, open: false };
      }
    }
    function saveState(state) {
      try {
        window.localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch {
        /* 存不进去不该让卡片坏掉 */
      }
    }

    // ── 按钮尺寸 ──
    // **单一来源是仓库根的 `button-size.json`**；`scripts/build-icon.mjs` 会按它改这段
    // 标记区里的数字，所以不要手改这里（改了下次出图就会被覆盖）。
    // 收起态按钮的显示尺寸（CSS 像素）。**不是正方形** —— 按钮就是角色本人（抠图），
    // 角色是竖长的（抠出来 239×268），做成正方形会把人物压扁。
    // >>> BUTTON_SIZE_START
    const DOT_W = 192;
    const DOT_H = 236;
    // <<< BUTTON_SIZE_END
    /** 图标原始像素（与 build-icon.mjs 的 2x 输出对应），用于校验资产是否跟上。 */
    const ICON_NATIVE = { w: DOT_W * 2, h: DOT_H * 2 };
    /** 按钮里的内置 SVG 兜底图标尺寸（按比例，不至于在大按钮里显得太小）。 */
    const FALLBACK_GLYPH = Math.round(DOT_W * 0.56);

    // ── 样式：一次性注入 <style>，用 data 属性做状态标记 ──
    const STYLE_ID = "dsh-balance-card-style";
    function ensureStyle() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
.dsh-bc-root{position:fixed;right:24px;bottom:24px;width:${DOT_W}px;height:${DOT_H}px;z-index:2147483600;font:13px/1.6 system-ui,'Microsoft YaHei',sans-serif;color:${T.text};-webkit-user-select:none;user-select:none;}
/* 按钮就是**角色本人的抠图**：没有圆形裁切、没有边框、没有底色 —— 靠 alpha 站住。
   所以父级不加 background / border / clip-path；只给一层投影，让它在浅色主题下也不糊在背景里。

   展开时按钮**仍留在 DOM、且仍在最上层**：卡片是从图片左侧"抽"出来的，要让它从人物背后出来
   （卡片 z-index 0 < 按钮 1），而"再点一次图片缩回"也要求图片一直可点。 */
.dsh-bc-dot{position:relative;z-index:1;width:100%;height:100%;display:block;cursor:grab;touch-action:none;background:none;border:none;filter:drop-shadow(0 3px 6px rgba(0,0,0,.38));transition:transform .12s ease,filter .15s ease;-webkit-tap-highlight-color:transparent;}
.dsh-bc-dot:hover{filter:drop-shadow(0 4px 10px rgba(0,0,0,.5));}
.dsh-bc-dot[data-dragging="true"]{cursor:grabbing;}
/* 点击动画：按下立刻缩到 .96；松手时一次 420ms 的 keyframe 回弹到 1.045 再落回 1。
   用属性 data-tap 触发，由客户端的 460ms 定时器复位，所以连点也能再触发。 */
.dsh-bc-dot:active{transform:scale(.96);}
@keyframes dsh-bc-tap{0%{transform:scale(1)}28%{transform:scale(.93)}62%{transform:scale(1.045)}100%{transform:scale(1)}}
.dsh-bc-dot[data-tap="true"]{animation:dsh-bc-tap .42s cubic-bezier(.34,1.4,.64,1);}
/* 取不到图时退回内置 SVG：那时需要一个底色垫住，否则只有线条会看不见 */
.dsh-bc-dot[data-icon-error="true"]{display:grid;place-items:center;background:${T.dotBg};border:1px solid ${T.border};border-radius:12px;}
.dsh-bc-dot img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none;}
.dsh-bc-dot[data-icon-error="true"] img{display:none;}
.dsh-bc-dot svg{width:${FALLBACK_GLYPH}px;height:${FALLBACK_GLYPH}px;display:none;color:${T.accent};}
.dsh-bc-dot[data-icon-error="true"] svg{display:block;}
/* 卡片**常驻**在 root 里（收起态只是不可见、不可点），位置由 JS 写成相对 root 的
   left/top（负 left = 在图片左边）。动画只碰 transform/opacity：
   收起态右移 60%（=192px）+ 缩到 .95 + 透明 = 缩回人物背后；展开态归位。
   z-index 0 < 图片 1，所以滑动时卡片是从人物背后"抽"出来的。 */
.dsh-bc-card{position:absolute;left:0;top:0;z-index:0;width:320px;box-sizing:border-box;padding:14px 16px 12px;border-radius:4px;background:${T.bg};border:1px solid ${T.border};box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:grab;touch-action:none;transform-origin:right center;transform:translateX(60%) scale(.95);opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,transform .16s cubic-bezier(.4,0,1,1),visibility .16s;}
.dsh-bc-root[data-open="true"] .dsh-bc-card{transform:translateX(0) scale(1);opacity:1;visibility:visible;pointer-events:auto;transition:opacity .2s ease,transform .28s cubic-bezier(.2,.9,.3,1.06),visibility .2s;}
.dsh-bc-card[data-dragging="true"]{cursor:grabbing;}
/* 减少动态偏好：不止关掉回弹，开合也直接到位（不再滑） */
@media (prefers-reduced-motion:reduce){.dsh-bc-dot,.dsh-bc-card,.dsh-bc-root[data-open="true"] .dsh-bc-card{transition:none;}.dsh-bc-dot[data-tap="true"]{animation:none;}}
.dsh-bc-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
.dsh-bc-title{font-size:12px;letter-spacing:.04em;color:${T.text2};}
.dsh-bc-acts{display:flex;align-items:center;gap:2px;}
.dsh-bc-btn{cursor:pointer;color:${T.dim};font-size:13px;line-height:1;padding:2px 5px;border-radius:3px;background:none;border:none;font-family:inherit;}
.dsh-bc-btn:hover{color:${T.accent};background:var(--dsw-alias-interactive-bg-hover, rgba(155,138,224,.12));}
.dsh-bc-balance{font:600 30px/1.15 system-ui,'Microsoft YaHei',sans-serif;margin:8px 0 2px;color:${T.text};}
.dsh-bc-balance[data-warn="true"]{color:${T.warn};}
.dsh-bc-sub{font-size:11px;color:var(--dsw-alias-label-caption, #7e6d90);}
.dsh-bc-state{font-size:11px;color:${T.text3};}
.dsh-bc-sep{height:1px;margin:12px 0 10px;background:${T.borderSoft};}
.dsh-bc-row{display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px;}
.dsh-bc-row .k{color:${T.text2};}
.dsh-bc-row .v{color:${T.text};font-variant-numeric:tabular-nums;}
.dsh-bc-row[data-accent="true"] .v{color:${T.accent};}
.dsh-bc-legend{margin-top:10px;font-size:11px;color:${T.dim};line-height:1.5;}
.dsh-bc-error{margin-top:8px;font-size:11px;color:${T.text3};white-space:pre-wrap;word-break:break-word;}
.dsh-bc-retry{cursor:pointer;color:${T.accent};background:none;border:none;font:inherit;padding:0;text-decoration:underline;}
`;
      document.head.appendChild(style);
    }

    /**
     * 收起态的图标。
     *
     * 优先用 `assets/icon.png`（黑塔那张戴巫师帽的头像，经宿主路由下发）；
     * 取不到就退回内置 SVG。**两条路都要能看** —— 图标缺了不该让按钮变成空白。
     */
    function DotIcon() {
      const [broken, setBroken] = React.useState(false);
      return React.createElement(
        React.Fragment,
        null,
        broken
          ? null
          : React.createElement("img", {
              src: DATA_ROUTE + "/icon.png",
              srcSet: DATA_ROUTE + "/icon@2x.png 2x",
              alt: "",
              draggable: false,
              onError: () => setBroken(true),
            }),
        React.createElement(
          "svg",
          { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.4, "aria-hidden": "true" },
          React.createElement("path", { key: 1, d: "M12 2.5c3.6 2.2 3.6 6.6 0 8.8-3.6-2.2-3.6-6.6 0-8.8Z" }),
          React.createElement("path", { key: 2, d: "M4.6 8.2c3.8 1.3 5.8 4.6 4.6 8.4-3.8-1.3-5.8-4.6-4.6-8.4Z" }),
          React.createElement("path", { key: 3, d: "M19.4 8.2c1.2 3.8-.8 7.1-4.6 8.4-1.2-3.8.8-7.1 4.6-8.4Z" }),
          React.createElement("path", { key: 4, d: "M12 15.5v6" }),
        ),
      );
    }

    /** 拖动 + 点击切换。阈值 4px 之内算点击，超过算拖动。
     *
     * 展开后图片**仍在 DOM 里**，所以点图片 = 收起；点卡片本身 = 什么都不做
     * （卡片里有刷新 / 细节 / ✕，只有图片才是开合开关）。
     * 「toggle」只记在「按下点落在图片上」的那一次拖动里 —— 否则点一下卡片空白就把卡片关了。
     */
    function useDrag(rootRef, stateRef, callbacks) {
      const [dragging, setDragging] = React.useState(false);
      const drag = React.useRef(null);
      const cbRef = React.useRef(callbacks);
      React.useEffect(() => {
        cbRef.current = callbacks;
      }, [callbacks]);

      /** 只量矩形、不改样式：**点一下不该把 right/bottom 锚成 left/top**（那会让它不再贴视口右下角）。 */
      const measure = React.useCallback(() => {
        const el = rootRef.current;
        return el === null ? null : el.getBoundingClientRect();
      }, [rootRef]);

      const onPointerDown = React.useCallback(
        (ev) => {
          if (ev.button !== 0) return;
          const target = ev.target;
          const closest =
            target !== null && typeof target.closest === "function" ? target.closest.bind(target) : null;
          // 卡片里的按钮自己处理点击：既不能开始拖动，也不能当成「点图片」去切换开合。
          if (closest !== null && closest(".dsh-bc-close, .dsh-bc-btn, .dsh-bc-retry") !== null) return;
          const r = measure();
          if (r === null) return;
          drag.current = {
            id: ev.pointerId,
            startX: ev.clientX,
            startY: ev.clientY,
            originLeft: r.left,
            originTop: r.top,
            moved: false,
            toggle: closest !== null && closest(".dsh-bc-dot") !== null,
            el: ev.currentTarget,
          };
          setDragging(true);
          try {
            ev.currentTarget.setPointerCapture(ev.pointerId);
          } catch {
            /* 某些环境不支持捕获，退化为普通指针事件 */
          }
        },
        [measure],
      );

      const onPointerMove = React.useCallback(
        (ev) => {
          const d = drag.current;
          if (d === null || d.id !== ev.pointerId) return;
          const dx = ev.clientX - d.startX;
          const dy = ev.clientY - d.startY;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
          d.moved = true;
          const el = rootRef.current;
          if (el === null) return;
          // 第一次真正拖动时才锚定：清掉 right/bottom，让后续 left/top 的位移从按下时的矩形算起。
          if (el.style.right !== "auto") {
            el.style.right = "auto";
            el.style.bottom = "auto";
          }
          const w = el.offsetWidth;
          const h = el.offsetHeight;
          const left = Math.min(Math.max(0, d.originLeft + dx), Math.max(0, window.innerWidth - w));
          const top = Math.min(Math.max(0, d.originTop + dy), Math.max(0, window.innerHeight - h));
          el.style.left = left + "px";
          el.style.top = top + "px";
          stateRef.current.x = Math.round(left);
          stateRef.current.y = Math.round(top);
          // 卡片挂在图片左侧，视口夹取依赖图片当前位置 ⇒ 拖动时每一帧重算。
          cbRef.current.onMove();
        },
        [rootRef, stateRef],
      );

      const finish = React.useCallback(
        (ev) => {
          const d = drag.current;
          if (d === null || d.id !== ev.pointerId) return;
          drag.current = null;
          setDragging(false);
          try {
            d.el.releasePointerCapture(ev.pointerId);
          } catch {
            /* 同上 */
          }
          if (d.moved) {
            saveState(stateRef.current);
            return;
          }
          if (!d.toggle) return;
          cbRef.current.onToggle();
          cbRef.current.onTap();
        },
        [stateRef],
      );

      return { dragging, handlers: { onPointerDown, onPointerMove, onPointerUp: finish, onPointerCancel: finish } };
    }

    /** 卡片主体。 */
    function BalanceCard() {
      const rootRef = React.useRef(null);
      const stateRef = React.useRef(loadState());
      const [open, setOpen] = React.useState(stateRef.current.open);
      const [data, setData] = React.useState(null);
      const [loading, setLoading] = React.useState(false);
      const [failed, setFailed] = React.useState(null);
      const [showError, setShowError] = React.useState(false);

      ensureStyle();

      // 还原上次拖到的位置。**必须在落位之前跑**（放在最靠前的 layout effect 里）：
      // 卡片坐标是相对 root 算的，root 还在默认 right/bottom 时落位会算错。
      // 旧版把这段放在「收起时」的 effect 里；现在 root 恒为图片框，挂载时还原一次就够。
      React.useLayoutEffect(() => {
        const el = rootRef.current;
        if (el === null) return;
        const s = stateRef.current;
        if (s.x === null || s.y === null) return;
        el.style.right = "auto";
        el.style.bottom = "auto";
        el.style.left = Math.min(Math.max(0, s.x), Math.max(0, window.innerWidth - DOT_W)) + "px";
        el.style.top = Math.min(Math.max(0, s.y), Math.max(0, window.innerHeight - DOT_H)) + "px";
      }, []);

      const load = React.useCallback(
        async (force) => {
          setLoading(true);
          setFailed(null);
          const startedAt = Date.now();
          try {
            const url = DATA_ROUTE + "/snapshot" + (force === true ? "?force=1" : "");
            const response = await fetch(url, { headers: { accept: "application/json" } });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const payload = await response.json();
            // 自计时：用户从「点开卡片」到「看见数字」到底等了多久，要能看见而不是靠猜。
            payload.clientMs = Date.now() - startedAt;
            setData(payload);
          } catch (error) {
            // 保留上一次成功的数据（只在有旧数据时不覆盖），并记下错误原文供展开查看。
            setFailed(String(error?.message ?? error));
          } finally {
            setLoading(false);
          }
        },
        [],
      );

      // 展开时拉一次 + 之后按间隔自动刷；收起就停。
      React.useEffect(() => {
        if (!open) return undefined;
        void load(false);
        const timer = window.setInterval(() => void load(false), AUTO_REFRESH_MS);
        return () => window.clearInterval(timer);
      }, [open, load]);

      // ── 展开时的落位：卡片在**图片左侧** ──
      // 卡片是 root 的绝对定位子元素，位置写成**相对 root 的 left/top**。root 就是图片框，
      // 所以 root 的定位始终只表示「图片在哪」；拖动时卡片自动跟着走，不用再维护一份卡片坐标。
      //
      // 为什么要算「可见左边缘」而不是直接用按钮外框：按钮的图是 object-fit: contain 铺的，
      // 抠图比外框窄（源 239×268 在 192×236 的框里只有 192×215 的实画区），按外框算会在
      // 窄的方向多出一截空白，卡片看起来没贴住人物。
      //
      // 与旧版的区别（旧版是「卡片在按钮上方、右下角对齐」）：现在图片**一直在 DOM 里**，
      // 落位随时可以量，所以「记住收起态矩形」「等数据到位再落位」这些补丁都不需要了；
      // 卡片高度会随数字变化，由 ResizeObserver 兜住。
      const cardRef = React.useRef(null);

      /**
       * 把 root 夹回视口内。拖动后的坐标在**窗口变小 / 换分辨率**后可能落到视口外——
       * 那样按钮就再也点不到了（实测：1400×1500 里拖到 x=1188，窗口缩到 400×700 后整块跑出屏幕，
       * elementFromPoint 命中的是 null）。有内联 left/top 才需要夹；默认的 right/bottom 锚点浏览器自己会贴边。
       */
      const clampRoot = React.useCallback(() => {
        const el = rootRef.current;
        if (el === null) return;
        if (el.style.left === "" && el.style.top === "") return;
        const w = el.offsetWidth;
        const h = el.offsetHeight;
        const left = Math.min(Math.max(0, Math.round(parseFloat(el.style.left) || 0)), Math.max(0, window.innerWidth - w));
        const top = Math.min(Math.max(0, Math.round(parseFloat(el.style.top) || 0)), Math.max(0, window.innerHeight - h));
        el.style.left = left + "px";
        el.style.top = top + "px";
        stateRef.current.x = left;
        stateRef.current.y = top;
        saveState(stateRef.current);
      }, [rootRef]);

      const placeCard = React.useCallback(() => {
        const host = rootRef.current;
        const card = cardRef.current;
        if (host === null || card === null) return;
        // ⚠️ 用 **root** 的矩形，不要用按钮的矩形：点开的那一下按钮正在跑点击回弹 keyframe
        // （scale .93 → 1.045 → 1），它量出来是**缩放后**的框 —— 实测按它落位，卡片整体偏高
        // 9～12px，而且动画结束后不会自动纠正（位置只在尺寸变化时重算）。root 不参与动画，
        // offsetWidth/Height 是布局尺寸，正好等于「按钮未缩放时的外框」。
        const rr = host.getBoundingClientRect();
        const dr = { left: rr.left, top: rr.top, width: host.offsetWidth, height: host.offsetHeight };
        if (dr.width === 0 || dr.height === 0) return;
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        if (cw === 0 || ch === 0) return;

        // 图在框内的实际绘制宽度（contain ⇒ 按较紧的一边等比缩放，两侧取最小）
        const dot = host.querySelector(".dsh-bc-dot");
        const img = dot === null ? null : dot.querySelector("img");
        let paintedW = dr.width;
        if (img !== null && img.naturalWidth > 0 && img.naturalHeight > 0) {
          const scale = Math.min(dr.width / img.naturalWidth, dr.height / img.naturalHeight);
          paintedW = img.naturalWidth * scale;
        }
        const paintedLeft = dr.left + (dr.width - paintedW) / 2;

        // 目标：卡片右边缘 = 图片可见左边缘 − CARD_GAP；卡片垂直中心 = 图片垂直中心
        let left = paintedLeft - dr.left - CARD_GAP - cw;
        let top = Math.round((dr.height - ch) / 2);

        // 视口夹取（四周留 8px）。视口窄到放不下时允许卡片压到图片上 —— 图片 z-index 更高、
        // 仍是可点的那一层，所以「再点一次缩回」不会因为被卡片盖住而失效。
        const lowerLeft = 8 - dr.left;
        const upperLeft = Math.max(lowerLeft, window.innerWidth - cw - 8 - dr.left);
        left = Math.min(Math.max(lowerLeft, left), upperLeft);
        const lowerTop = 8 - dr.top;
        const upperTop = Math.max(lowerTop, window.innerHeight - ch - 8 - dr.top);
        top = Math.min(Math.max(lowerTop, top), upperTop);

        card.style.left = Math.round(left) + "px";
        card.style.top = Math.round(top) + "px";

        // 诊断属性：验收脚本/排查要能直接读到「图片在哪、卡片算到哪」，不用靠猜。
        host.dataset.dotBox =
          Math.round(dr.left) + "," + Math.round(dr.top) + "," + Math.round(dr.width) + "," + Math.round(dr.height);
        host.dataset.placeInfo =
          "paintedLeft=" + Math.round(paintedLeft) + " card=" + cw + "x" + ch + " left=" + Math.round(left) +
          " top=" + Math.round(top) + " gap=" + CARD_GAP;
      }, [rootRef]);

      // 展开：算一次落位，并在卡片尺寸变化（数字到齐后会变高）/ 窗口变化时重算。
      React.useLayoutEffect(() => {
        if (!open) return undefined;
        // 用 rAF 而不是同步调用：刚展开这一帧卡片的内联 left/top 还是上一轮的值，
        // 同步量会让过渡起点抖一下；rAF 后一次到位。
        const raf = window.requestAnimationFrame(placeCard);
        const card = cardRef.current;
        if (card === null) return () => window.cancelAnimationFrame(raf);
        const observer = new ResizeObserver(placeCard);
        observer.observe(card);
        return () => {
          window.cancelAnimationFrame(raf);
          observer.disconnect();
        };
      }, [open, placeCard]);

      // 展开/数据刷新后都补一次（卡片高度会随数字变化，垂直居中要跟着走）。
      React.useLayoutEffect(() => {
        if (open) placeCard();
      }, [open, data, placeCard]);

      // 视口变化：**先**把 root 夹回视口内（缩小窗口后按钮不能跑到屏幕外），**再**重算卡片落位。
      // 收起态也要夹 —— 所以这个监听不挂在 open 上。
      React.useLayoutEffect(() => {
        const onResize = () => {
          clampRoot();
          placeCard();
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [clampRoot, placeCard]);

      const toggle = React.useCallback(() => {
        const next = !stateRef.current.open;
        stateRef.current.open = next;
        saveState(stateRef.current);
        setOpen(next);
      }, []);

      // 点击动画：每次点图片把 data-tap 置 true 触发一次 keyframe，460ms 后复位（比动画长 40ms）。
      // 连点的问题：data-tap 在 460ms 内一直是 "true"，属性没变 ⇒ CSS 不会重启动画。
      // 所以这里除了改 state，还**命令式地重排一次 animation**（none → 强制 reflow → 回到 CSS 规则），
      // 这样第二次点击也能重新弹。reduced-motion 下 CSS 已经把 animation 关掉，重排无副作用。
      const dotRef = React.useRef(null);
      const [tap, setTap] = React.useState(0);
      const bump = React.useCallback(() => {
        setTap((n) => n + 1);
        const el = dotRef.current;
        if (el === null) return;
        el.style.animation = "none";
        void el.offsetWidth; // 强制 reflow，否则下一行不会重启动画
        el.style.animation = "";
      }, []);
      React.useEffect(() => {
        if (tap === 0) return undefined;
        const timer = window.setTimeout(() => setTap(0), 460);
        return () => window.clearTimeout(timer);
      }, [tap]);

      const dragCallbacks = React.useMemo(
        () => ({ onToggle: toggle, onTap: bump, onMove: placeCard }),
        [toggle, bump, placeCard],
      );
      const { dragging, handlers } = useDrag(rootRef, stateRef, dragCallbacks);

      const balance = data === null ? null : data.balance;
      const ready = balance !== null && balance.status === "ready";
      const usage = data === null ? null : data.usage;
      const windows = usage === null ? null : usage.windows;

      // 低余额预警：阈值可配（localStorage），默认不预警。
      const threshold = (() => {
        try {
          const raw = window.localStorage.getItem("dsh-balance-card:threshold");
          if (raw === null || raw === "") return null;
          const n = Number.parseFloat(raw);
          return Number.isFinite(n) ? n : null;
        } catch {
          return null;
        }
      })();
      const warn = ready && threshold !== null && typeof balance.balance.total === "number" && balance.balance.total < threshold;

      // ── 图片按钮：**任何时候都渲染** ──
      // 旧版收起态渲染按钮、展开态它被卡片顶掉；现在必须常驻：卡片要从它左侧滑出（从人物背后出来），
      // 而且「再点一次图片缩回」也要求它一直在、一直在最上层、一直可点。
      // 点击动画：data-tap 交给 CSS 的 keyframe（按下 :active 缩到 .96，松手回弹到 1.045 再落回 1）。
      const dotNode = React.createElement(
        "div",
        {
          className: "dsh-bc-dot",
          ref: dotRef,
          role: "button",
          tabIndex: 0,
          "aria-expanded": open ? "true" : "false",
          "aria-label": open ? "收起余额与用量" : "展开余额与用量",
          // 低余额预警：收起态没有数字可染色，所以把提示写进 title（展开态数字会变色）。
          title: (warn ? "余额偏低（" : "余额与用量（") + (open ? "点击收起" : "点击展开") + "，拖动移位）",
          "data-dragging": dragging ? "true" : "false",
          "data-warn": warn ? "true" : "false",
          "data-tap": tap > 0 ? "true" : "false",
          ...handlers,
          onKeyDown: (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            ev.preventDefault();
            toggle();
            bump();
          },
        },
        React.createElement(DotIcon),
      );

      const balanceNode = (() => {
        if (balance === null) {
          return React.createElement("div", { className: "dsh-bc-balance" }, loading ? "…" : "—");
        }
        if (balance.status === "ready") {
          const b = balance.balance;
          return React.createElement(
            "div",
            null,
            React.createElement(
              "div",
              { className: "dsh-bc-balance", "data-warn": warn ? "true" : "false" },
              fmtAmount(b.total, b.currency),
            ),
            React.createElement(
              "div",
              { className: "dsh-bc-sub" },
              `赠金 ${fmtAmount(b.granted, b.currency)} · 充值 ${fmtAmount(b.toppedUp, b.currency)}` +
                (b.isAvailable ? "" : " · 余额不足") +
                ` · ${fmtTime(balance.at)}`,
            ),
          );
        }
        const label =
          balance.status === "unconfigured" ? "未配置" : balance.status === "unauthorized" ? "密钥无效" : "取不到";
        return React.createElement(
          "div",
          null,
          React.createElement(
            "div",
            { className: "dsh-bc-balance", style: { fontSize: "22px", color: T.dim } },
            label + " ?",
          ),
          React.createElement(
            "div",
            { className: "dsh-bc-sub" },
            React.createElement(
              "button",
              { className: "dsh-bc-retry", type: "button", onClick: () => void load(true) },
              "重试",
            ),
            " ",
            balance.detail === undefined ? "" : balance.detail,
          ),
        );
      })();

      const row = (key, accent) => {
        if (windows === null) return null;
        const w = windows[key];
        if (w === undefined) return null;
        return React.createElement(
          "div",
          { className: "dsh-bc-row", "data-accent": accent ? "true" : "false", key },
          React.createElement("span", { className: "k" }, w.label),
          React.createElement("span", { className: "v" }, `${fmtTokens(w.hit + w.miss + w.out)} · ${fmtMoney(w.cost)}`),
        );
      };

      const total = windows === null ? null : windows.all;

      return React.createElement(
        "div",
        { className: "dsh-bc-root", ref: rootRef, "data-open": open ? "true" : "false" },
        React.createElement(
          "div",
          {
            className: "dsh-bc-card",
            ref: cardRef,
            "data-dragging": dragging ? "true" : "false",
            "aria-hidden": open ? "false" : "true",
            // 收起态整张卡片不可交互（也不该被 Tab 聚焦）：inert 只在收起时给。
            inert: open ? undefined : "",
            ...handlers,
          },
          React.createElement(
            "div",
            { className: "dsh-bc-head" },
            React.createElement("span", { className: "dsh-bc-title" }, "余额与用量"),
            React.createElement(
              "span",
              { className: "dsh-bc-acts" },
              React.createElement(
                "button",
                {
                  className: "dsh-bc-btn",
                  type: "button",
                  title: "刷新",
                  onClick: (ev) => {
                    ev.stopPropagation();
                    void load(true);
                  },
                },
                "⟳",
              ),
              React.createElement(
                "button",
                {
                  className: "dsh-bc-btn dsh-bc-close",
                  type: "button",
                  title: "收起",
                  onClick: (ev) => {
                    ev.stopPropagation();
                    toggle();
                  },
                },
                "✕",
              ),
            ),
          ),
          balanceNode,
          React.createElement("div", { className: "dsh-bc-sep" }),
          row("today", true),
          row("week", false),
          row("month", false),
          React.createElement(
            "div",
            { className: "dsh-bc-legend" },
            total === null
              ? loading
                ? "正在读取会话日志…"
                : "还没有读到会话用量"
              : `全部：命中 ${fmtTokens(total.hit)} · 未命中 ${fmtTokens(total.miss)} · 输出 ${fmtTokens(total.out)}`,
            React.createElement("br", null),
            data === null
              ? ""
              : `估算，非账单${data.pricing.peakOffPeak ? "（峰谷价）" : data.pricing.peakOnly ? "（按高峰价）" : ""} · 单价核对于 ${data.pricing.verifiedAt}`,
          ),
          React.createElement(
            "div",
            { className: "dsh-bc-error" },
            React.createElement(
              "span",
              {
                style: { cursor: "pointer", textDecoration: "underline" },
                onClick: () => setShowError((v) => !v),
              },
              showError ? "隐藏细节" : "细节",
            ),
            showError
              ? React.createElement(
                  "div",
                  null,
                  `数据时间 ${fmtTime(data === null ? 0 : data.generatedAt)}` +
                    (data === null ? "" : ` · 本轮 ${data.clientMs} ms（宿主扫描 ${data.scan.files} 个文件，重算 ${data.scan.changed} 个）`) +
                    (failed === null ? "" : ` · 上次请求失败：${failed}`) +
                    (usage !== null && usage.error !== null && usage.error !== undefined ? ` · ${usage.error}` : ""),
                )
              : null,
          ),
        ),
        // 图片放在卡片**之后**渲染：DOM 顺序 + z-index 双保险，保证它永远压在卡片上面。
        dotNode,
      );
    }

    /** 挂载点：自己往 body 插一层，不用任何 slot。 */
    let host = null;
    let reactRoot = null;

    return {
      // 客户端不从宿主服务里取东西：数据走自己的 HTTP 路由。
      inject: [],
      apply(ctx) {
        try {
          host = document.createElement("div");
          host.id = "dsh-balance-card-host";
          document.body.appendChild(host);
          reactRoot = require("react-dom/client").createRoot(host);
          reactRoot.render(React.createElement(BalanceCard));
          console.log("[dsh-balance-card] 卡片已挂载");
        } catch (error) {
          console.error("[dsh-balance-card] 挂载失败：" + String(error?.message ?? error));
        }
        ctx.effect(() => () => {
          try {
            if (reactRoot !== null) reactRoot.unmount();
            if (host !== null && host.parentNode !== null) host.parentNode.removeChild(host);
            const style = document.getElementById(STYLE_ID);
            if (style !== null) style.remove();
          } catch (error) {
            console.error("[dsh-balance-card] 卸载失败：" + String(error?.message ?? error));
          }
        }, "dsh-balance-card: card");
      },
    };
  },
});
