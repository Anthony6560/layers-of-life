/* ============================================================================
   app.js —— 启动器
   ----------------------------------------------------------------------------
   职责（契约 §1）：「加载数据 → 初始化引擎 → 绑定导航 → 挂载内容模块」

   执行顺序（严格）：
     ① 数据可用性检测（最早，早于任何数据消费）—— 契约 §4.2
     ② 解析地标 → 初始化引擎与镜头
     ③ 生成地标语义层 / 控件层 / 引导文案
     ④ 性能探针与模式决策 —— 契约 §0 /《04》§4.2 降级决策流
     ⑤ 创建并暴露 window.Scene（契约 §2.2 全部方法 + §2.4 全部事件）
     ⑥ 绑定交互（拖拽 / 缩放 / 键盘 / 深链接）

   ⚠️ 关于全局变量（契约 §2.1）：本文件是 window.Scene **公开 API** 的唯一
      填充处；landmarks.js / map-engine.js / camera.js 只往 Scene._ 写私有成员。
   ============================================================================ */

(function () {
  "use strict";

  /* ══════════════════════════════════════════════════════════════════════════
     0 —— 内置兜底常量
     --------------------------------------------------------------------------
     ⚠️ 契约 §4.2：数据文件的语法写坏时浏览器抛的是 SyntaxError，该文件
        **整份不执行** —— 不存在"JSON.parse 失败"可以捕获。因此这里检测的是
        **全局变量是否存在**，且错误文案必须内置兜底，因为它本来要读的
        site.messages 此刻大概率也不可用。
     ══════════════════════════════════════════════════════════════════════════ */

  var FALLBACK = {
    title:        "坐标之外",
    errorTitle:   "内容数据没能加载",
    errorBody:    "页面其余部分工作正常，但读不到 assets/data/ 下的内容数据。",
    errorHint:    "常见原因：改数据文件时少了逗号、用了中文引号、或少了一个 } 或 ]。详见 docs/07-内容填充指南.md",
    errorAction:  "重新加载",
    loadFailed:   "页面没能正常启动，请用较新版本的 Chrome / Edge / Safari / Firefox 打开。",
    emptyWorks:   "这一片场还没有作品。",
    emptyNotes:   "这一片场还没有留下印记。",
    emptyNotesAll:"还没有留下任何印记。",
    degradeNote:  "已切换为低帧率动态地图，全部内容仍可访问。"
  };

  /* ══════════════════════════════════════════════════════════════════════════
     1 —— 数据可用性检测（必须最先执行）
     ══════════════════════════════════════════════════════════════════════════ */

  var hasData = !!(window.SITE_DATA && window.WORKS_DATA && window.NOTES_DATA);

  var site  = window.SITE_DATA || null;
  var works = (window.WORKS_DATA && window.WORKS_DATA.works) || [];
  var notes = (window.NOTES_DATA && window.NOTES_DATA.notes) || [];

  /* 文案读取：一律先走 site.messages，缺失时回落到内置常量，绝不渲染 undefined */
  function msg(key, fallback) {
    var m = site && site.messages;
    var v = m ? m[key] : null;
    return (typeof v === "string" && v) ? v : fallback;
  }

  var TITLE = (site && site.meta && site.meta.title) || FALLBACK.title;

  /* 共用主页绿系。注入变量引用而非固定 HEX，避免行内颜色阻止昼夜切换。 */
  function applyFieldColors() {
    if (!site || !site.fields || !document.documentElement) { return; }
    var root = document.documentElement.style;
    for (var i = 0; i < site.fields.length; i++) {
      var f = site.fields[i];
      if (!f || !f.id) { continue; }
      root.setProperty("--color-" + f.id, "var(--field-accent)");
      root.setProperty("--color-" + f.id + "-light", "var(--field-accent-soft)");
      root.setProperty("--color-" + f.id + "-dark", "var(--field-accent-strong)");
    }
  }

  /* 依赖（landmarks.js / map-engine.js / camera.js 提供） */
  var Lm     = window.Scene && window.Scene._ && window.Scene._.Landmarks;
  var Engine = window.Scene && window.Scene._ && window.Scene._.MapEngine;
  var Camera = window.Scene && window.Scene._ && window.Scene._.Camera;
  var Tokens = window.Scene && window.Scene._ && window.Scene._.Tokens;
  var Environment = window.Scene && window.Scene._ && window.Scene._.Environment;

  /* ══════════════════════════════════════════════════════════════════════════
     2 —— 内部状态与事件总线
     ══════════════════════════════════════════════════════════════════════════ */

  var state = { view: "overview", activeId: null, mode: "full" };
  var handlers = {};

  function on(event, handler) {
    if (typeof handler !== "function") { return function () {}; }
    if (!handlers[event]) { handlers[event] = []; }
    handlers[event].push(handler);
    return function off() {
      var a = handlers[event] || [];
      var i = a.indexOf(handler);
      if (i >= 0) { a.splice(i, 1); }
    };
  }

  function emit(event, payload) {
    var a = handlers[event];
    if (!a || !a.length) { return; }
    /* 复制一份再遍历：允许处理器在回调里取消订阅 */
    a.slice().forEach(function (fn) {
      try { fn(payload || {}); } catch (err) {
        /* 单个订阅者出错不应中断整条链路 */
        if (window.console && console.warn) { console.warn("[Scene] 事件处理器异常：" + event, err); }
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     3 —— 工具
     ══════════════════════════════════════════════════════════════════════════ */

  function $(id) { return document.getElementById(id); }

  function updateTerrainPreloader(info) {
    var host = $("terrain-preloader");
    var bar = $("terrain-preloader-progress");
    var label = $("terrain-preloader-label");
    if (!host) { return; }
    var progress = info && isFinite(info.progress) ? Math.max(0, Math.min(1, info.progress)) : 0;
    if (bar) { bar.style.width = (progress * 100).toFixed(1) + "%"; }
    if (label && info && !info.ready) {
      label.textContent = "地图准备中";
    }
    if (info && info.ready && label) { label.textContent = "地图已准备好"; }
  }

  var sceneBootFinished = false;

  function finishSceneBoot(mode) {
    if (sceneBootFinished) { return; }
    sceneBootFinished = true;
    updateTerrainPreloader({ ready: true, progress: 1 });
    var enterScene = function () {
      state.mode = "";
      applyMode(mode, false);
      if (!hasData) { renderErrorCard(); }
      if (Engine.isRunning()) { Engine.requestFrame(); } else { Engine.renderStatic(); }
      emit("scene:ready", {});
      if (hasData) { restoreFromHash(); }
    };
    if (window.IntroScreen) { window.IntroScreen.ready(enterScene); }
    else { $("terrain-preloader").setAttribute("data-state", "ready"); enterScene(); }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text != null) { n.textContent = text; }
    return n;
  }

  function nowMs() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  function reduceMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     4 —— 模式决策与性能探针（契约 §0 /《04》§4.2）
     ══════════════════════════════════════════════════════════════════════════ */

  /**
   * 初始模式判定。
   *   prefers-reduced-motion: reduce  → 'reduced'（关闭全部动效）
   *   prefers-reduced-motion 之外一律使用 'full'。
   *   预计算循环已经把高度场、等高线和阴影计算移出播放阶段，不能再依据
   *   设备核数或短时帧率自动关闭流畅动画。
   */
  function decideInitialMode() {
    if (reduceMotion()) { return "reduced"; }
    return "full";
  }

  /* 保留探针函数供调试调用，但不再自动切换 mode。播放阶段只做缓存帧插值，
     短时的预计算任务不应把页面永久锁进低帧率模式。 */
  function startPerfProbe() {
    var t = Tokens.get();
    var win = t.perfProbeWindow || 3000;
    var threshold = t.perfFpsThreshold || 25;
    var frames = 0;
    var t0 = nowMs();

    (function sample(now) {
      frames++;
      var elapsed = now - t0;
      if (elapsed < win) {
        window.requestAnimationFrame(sample);
        return;
      }
      var fps = frames / (elapsed / 1000);
      if (fps < threshold && window.console && console.info) {
        console.info("[Scene] 当前帧率较低，但继续保持预计算地形动画");
      }
    })(t0);
  }

  /** 切换运行模式：引擎、CSS 类、内容模块三方同步 */
  function applyMode(mode, announce) {
    if (state.mode === mode) { return; }
    state.mode = mode;

    document.body.classList.toggle("m-mode-static",  mode === "static");
    document.body.classList.toggle("m-mode-reduced", mode === "reduced");

    if (Engine) { Engine.setMode(mode); }

    /* 契约 §2.3：由 Agent C 在性能降级时调用，Agent D 据此关闭自身动效 */
    if (window.ContentModule && typeof window.ContentModule.setMode === "function") {
      window.ContentModule.setMode(mode);
    }

    emit("mode:change", { mode: mode });
    if (announce) { showToast(msg("degradeNote", FALLBACK.degradeNote)); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     5 —— 地标语义层（契约 §3.3）
     ══════════════════════════════════════════════════════════════════════════ */

  var landmarks = [];
  var worldEl = null;

  /** 统计某个场的内容量，用于 aria-label（05 §9.4） */
  function countFor(id) {
    if (id === "about") { return ""; }
    if (id === "notes") {
      return notes.length ? (notes.length + " 条印记") : "";
    }
    var w = 0, n = 0, i;
    for (i = 0; i < works.length; i++) { if (works[i] && works[i].field === id) { w++; } }
    for (i = 0; i < notes.length; i++) { if (notes[i] && notes[i].field === id) { n++; } }
    var parts = [];
    if (w) { parts.push(w + " 件作品"); }
    if (n) { parts.push(n + " 条印记"); }
    return parts.join("，");
  }

  function ariaLabelFor(lm) {
    var s = lm.badge ? ("地标 " + lm.badge + "，") : "";
    s += lm.name;
    if (lm.subtitle) { s += "：" + lm.subtitle; }
    var c = countFor(lm.id);
    if (c) { s += "，" + c; }
    return s;
  }

  function labelHTML(lm) {
    var html = '<span class="m-landmark__label" aria-hidden="true">' +
               '<span class="m-landmark__row">';
    if (lm.badge && lm.kind === "field") {
      html += '<span class="m-landmark__badge">' + esc(lm.badge) + "</span>";
    }
    html += '<span class="m-landmark__cn">' + esc(lm.name) + "</span></span>";
    if (lm.nameEn) { html += '<span class="m-landmark__en">' + esc(lm.nameEn) + "</span>"; }
    if (lm.subtitle) { html += '<span class="m-landmark__sub">' + esc(lm.subtitle) + "</span>"; }
    return html + "</span>";
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function buildLandmarks() {
    worldEl = $("map-world");
    if (!worldEl || !Engine || !Tokens) { return; }

    landmarks.forEach(function (lm) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "m-landmark";
      btn.setAttribute("data-id", lm.id);
      btn.setAttribute("data-field", lm.id);
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", ariaLabelFor(lm));
      btn.innerHTML = '<span class="m-landmark__hit">' + labelHTML(lm) + '</span>';

      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        openLandmark(lm.id);
      });

      worldEl.appendChild(btn);
      lm.el = btn;
    });
  }

  /** 把归一化坐标落到世界坐标，写进每个地标的 transform。
      ⚠️ v2.1：三维自由旋转后这个位置**随视角变化**，因此 map-engine 每帧会
      再刷一次（syncLandmarks）——这里负责初次布局与窗口尺寸变化。 */
  function layoutLandmarks() {
    if (!Engine) { return; }
    var m = Engine.getMapSize();
    landmarks.forEach(function (lm) {
      if (!lm.el) { return; }
      lm.wx = lm.nx * m.w;
      lm.wy = lm.ny * m.h;
      lm.el.style.transform =
        "translate3d(" + lm.wx.toFixed(1) + "px," + lm.wy.toFixed(1) + "px,0)";
    });
  }

  /* ══════════════════════════════════════════════════════════════════════════
     6 —— 镜头 → DOM 同步
     --------------------------------------------------------------------------
     镜头的平移缩放只写两个地方：Canvas 的 setTransform（引擎内部）与
     #map-world 的 transform。**绝不逐帧改任何元素的 left/top**（§7.5 禁令）。
     ══════════════════════════════════════════════════════════════════════════ */

  function syncWorld(view) {
    if (!worldEl || !Engine) { return; }
    var vp = Engine.getViewport();

    worldEl.style.transform =
      "translate(" + (-view.x * view.scale + vp.w / 2).toFixed(2) + "px, " +
                     (-view.y * view.scale + vp.h / 2).toFixed(2) + "px) " +
      "scale(" + view.scale.toFixed(4) + ")";

    /* 反向缩放：任何缩放级别下标注字号不变（05 §5.5）*/
    worldEl.style.setProperty("--inv", (1 / view.scale).toFixed(4));

    updateScaleReadout(view.scale);
    updateLabelDensity(view.scale);
  }

  /* 缩放 < 0.8x 时隐藏副标题与英文名（05 §5.5 缩放时的标注行为） */
  function updateLabelDensity(scale) {
    var layer = $("landmark-layer");
    if (!layer) { return; }
    layer.setAttribute("data-z", scale < 0.8 ? "far" : "near");
  }

  /* ══════════════════════════════════════════════════════════════════════════
     7 —— L4 控件层
     ══════════════════════════════════════════════════════════════════════════ */

  var scaleLabel = null, scaleTag = null;
  var timeInput = null, timezoneSelect = null, timeReadout = null, sunReadout = null;
  var environmentMode = "", environmentLightKey = "", clockTimer = 0;

  var TIMEZONES = [
    [-480, "UTC−08:00"], [-300, "UTC−05:00"], [0, "UTC±00:00"],
    [330, "UTC+05:30"], [480, "UTC+08:00"], [540, "UTC+09:00"],
    [600, "UTC+10:00"], [720, "UTC+12:00"]
  ];

  function two(v) { return v < 10 ? "0" + v : String(v); }

  function datetimeInputValue(ms, offset) {
    var d = new Date(Number(ms) + Number(offset || 0) * 60000);
    return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) +
      "T" + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
  }

  function datetimeInputMs(value, offset) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
    if (!m) { return NaN; }
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - Number(offset || 0) * 60000;
  }

  function applyEnvironmentTheme(light, forceRender) {
    if (!light) { return; }
    var root = document.documentElement;
    var next = light.mode || "day";
    root.classList.toggle("m-theme-night", next === "night");
    root.classList.toggle("m-theme-twilight", next === "twilight");
    root.style.setProperty("--twilight-strength", String(light.twilight || 0));
    root.style.setProperty("--twilight-angle", ((light.azimuth || 0) + 90).toFixed(1) + "deg");
    root.style.setProperty("--daylight-blend", String(light.dayBlend == null ? 1 : light.dayBlend));
    if (environmentMode !== next) {
      environmentMode = next;
      if (Tokens && Tokens.invalidate) { Tokens.invalidate(); }
      forceRender = true;
    }
    if (forceRender || environmentLightKey !== light.key) {
      environmentLightKey = light.key;
      if (Engine && typeof Engine.refreshEnvironment === "function") {
        Engine.refreshEnvironment();
      } else if (Engine) {
        Engine.renderStatic();
      }
    }
  }

  function updateClockUI(forceRender) {
    if (!Environment || !Environment.getClock) { return; }
    var c = Environment.getClock();
    var light = Environment.getLight(c.dateMs);
    if (timeReadout) {
      timeReadout.textContent = Environment.formatZoned(c.dateMs, c.timezoneOffsetMinutes) +
        "  " + c.timezoneLabel + (c.manual ? " · MANUAL" : " · LIVE");
    }
    if (sunReadout) {
      var modeName = light.mode === "night" ? "夜间" : (light.mode === "twilight" ? "晨昏" : "白天");
      sunReadout.textContent = modeName + " · 太阳高度 " + light.elevation.toFixed(1) +
        "° · 方位 " + light.azimuth.toFixed(0) + "°";
    }
    if (timeInput && document.activeElement !== timeInput) {
      timeInput.value = datetimeInputValue(c.dateMs, c.timezoneOffsetMinutes);
    }
    applyEnvironmentTheme(light, !!forceRender);
  }

  function applyManualClock() {
    if (!Environment || !timeInput || !timezoneSelect) { return; }
    var offset = Number(timezoneSelect.value);
    var ms = datetimeInputMs(timeInput.value, offset);
    if (!isFinite(ms)) { return; }
    Environment.setClock({
      manual: true, dateMs: ms, timezoneOffsetMinutes: offset,
      timezoneLabel: timezoneSelect.options[timezoneSelect.selectedIndex].text
    });
    updateClockUI(true);
  }

  function buildControls() {
    var host = $("map-controls");
    if (!host) { return; }

    /* 手动平移 / 旋转 / 缩放已关闭。镜头只允许由地标点击后的 focusTo
       与关闭内容后的 reset 驱动，因此不再生成缩放控件。 */

    /* ---- 临时时间实验台：用于检查实时太阳阴影、昼夜和晨昏过渡 ---- */
    if (Environment && Environment.getClock) {
      var clock = Environment.getClock();
      /* 便于视觉回归：?previewTime=2026-10-01T18:30&previewTz=480 */
      try {
        var previewParams = new URLSearchParams(window.location.search || "");
        var previewTime = previewParams.get("previewTime");
        var previewTz = Number(previewParams.get("previewTz"));
        if (previewTime && isFinite(previewTz)) {
          var previewMs = datetimeInputMs(previewTime, previewTz);
          if (isFinite(previewMs)) {
            Environment.setClock({ manual: true, dateMs: previewMs,
              timezoneOffsetMinutes: previewTz, timezoneLabel: Environment.offsetLabel(previewTz) });
            clock = Environment.getClock();
          }
        }
      } catch (previewError) { /* 老浏览器忽略预览参数 */ }
      var timePanel = el("section", "m-time-control");
      timePanel.setAttribute("aria-label", "太阳时间与时区预览");
      timeReadout = el("output", "m-time-control__clock", "");
      sunReadout = el("div", "m-time-control__sun", "");
      timeInput = el("input", "m-time-control__datetime");
      timeInput.type = "datetime-local";
      timeInput.step = "60";
      timeInput.setAttribute("aria-label", "预览日期与时间");
      timezoneSelect = el("select", "m-time-control__zone");
      timezoneSelect.setAttribute("aria-label", "预览时区");
      for (var tz = 0; tz < TIMEZONES.length; tz++) {
        var option = el("option", "", TIMEZONES[tz][1]);
        option.value = String(TIMEZONES[tz][0]);
        if (TIMEZONES[tz][0] === clock.timezoneOffsetMinutes) { option.selected = true; }
        timezoneSelect.appendChild(option);
      }
      var timeActions = el("div", "m-time-control__actions");
      var applyTimeBtn = el("button", "m-time-control__btn", "应用时间");
      applyTimeBtn.type = "button";
      var liveTimeBtn = el("button", "m-time-control__btn", "回到实时");
      liveTimeBtn.type = "button";
      timeActions.appendChild(applyTimeBtn);
      timeActions.appendChild(liveTimeBtn);
      timePanel.appendChild(timeReadout);
      timePanel.appendChild(sunReadout);
      timePanel.appendChild(timeInput);
      timePanel.appendChild(timezoneSelect);
      timePanel.appendChild(timeActions);
      host.appendChild(timePanel);

      var twilightLayer = el("div", "m-day-night-layer");
      twilightLayer.setAttribute("aria-hidden", "true");
      $("app").insertBefore(twilightLayer, $("map-canvas"));

      applyTimeBtn.addEventListener("click", applyManualClock);
      timeInput.addEventListener("change", applyManualClock);
      timezoneSelect.addEventListener("change", function () {
        var c = Environment.getClock();
        Environment.setClock({
          manual: c.manual, dateMs: c.manual ? c.dateMs : null,
          timezoneOffsetMinutes: Number(timezoneSelect.value),
          timezoneLabel: timezoneSelect.options[timezoneSelect.selectedIndex].text
        });
        updateClockUI(true);
      });
      liveTimeBtn.addEventListener("click", function () {
        Environment.setClock({
          manual: false, timezoneOffsetMinutes: Number(timezoneSelect.value),
          timezoneLabel: timezoneSelect.options[timezoneSelect.selectedIndex].text
        });
        updateClockUI(true);
      });
      updateClockUI(true);
      clockTimer = window.setInterval(function () { updateClockUI(false); }, 1000);
    }

    /* ---- 比例尺（05 §6.6）：必须真实响应缩放，否则违反 P-2 ---- */
    var scale = el("div", "m-scale");
    scale.setAttribute("aria-hidden", "true");
    var bar = el("div", "m-scale__bar");
    for (var i = 0; i < 4; i++) { bar.appendChild(el("i", "m-scale__seg")); }
    scaleLabel = el("div", "m-scale__label", "");
    scale.appendChild(bar);
    scale.appendChild(scaleLabel);
    host.appendChild(scale);

    /* ---- 图廓坐标（装饰性，锚定"这是一张地图"的认知；SCALE 行真实响应缩放）---- */
    scaleTag = el("div", "m-graticule-tag", "");
    host.appendChild(scaleTag);

    /* ---- 页脚手写体签名（数据驱动：meta.signature）---- */
    var sig = (site && site.meta && site.meta.signature) || "";
    if (sig) {
      var sign = el("div", "m-sign", sig);
      host.appendChild(sign);
    }

    updateScaleReadout(Camera.getScale());
  }

  /* 比例尺刻度映射（05 §6.6）：scale = 1.0 时 96px = 500 m */
  var SCALE_BASE_M = 500;

  function updateScaleReadout(scale) {
    if (scaleLabel) {
      var meters = Math.round(SCALE_BASE_M / scale / 50) * 50;
      scaleLabel.textContent = "0 — " + (meters >= 1000
        ? (meters / 1000).toFixed(1) + " km"
        : meters + " m");
    }
    if (scaleTag) {
      /* 图廓上的比例分母同样随缩放变化，避免它退化成一张贴纸（P-2）*/
      var denom = Math.round(24000 / scale / 100) * 100;
      scaleTag.textContent = "34°16′N 108°56′E\nSCALE 1 : " + denom + "\nCONTOUR INTERVAL 10 M";
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     8 —— 引导文案（数据驱动：hero.headline / subline / hint）
     ══════════════════════════════════════════════════════════════════════════ */

  function buildHero() {
    var host = $("hero-caption");
    if (!host) { return; }
    var hero = (site && site.hero) || {};

    host.appendChild(el("div", "m-hero__rule"));
    host.appendChild(el("h1", "m-hero__title", hero.headline || TITLE));
    if (hero.subline) { host.appendChild(el("p", "m-hero__sub", hero.subline)); }
    /* 05 §10.3：reduced-motion 下 A-17 拖拽引导被移除，
       由这行小字补偿，因此它在降级态下更要显示 */
    if (hero.hint) { host.appendChild(el("p", "m-hero__hint", hero.hint)); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     9 —— 覆盖层
     ══════════════════════════════════════════════════════════════════════════ */

  var DEFAULT_ZOOM = 1;   /* 全景态的缩放倍率（05 §7.3 步 4：scale 1.0 → 1.6）*/

  function titleFor(lm) {
    if (lm.id === "about") { return (site && site.about && site.about.title) || lm.name; }
    if (lm.nameEn) { return lm.name + " " + lm.nameEn; }
    return lm.name;
  }

  function openLandmark(id) {
    var lm = Lm ? Lm.get(id) : null;
    if (!lm) { return; }

    /* 已经在该场：不重复推进镜头 */
    if (state.view === "focused" && state.activeId === id) { return; }

    /* 从另一个场直接切换：先把旧内容卸掉，避免两套内容叠加 */
    if (state.view === "focused") { teardownContent(); }

    state.activeId = id;
    setActive(id, true);
    emit("landmark:focus", { id: id });

    var w = Lm.normToWorld(lm.nx, lm.ny);
    Camera.focusTo(w.x, w.y, Camera.getLimits().focus, function () { mountContent(lm); }, lm.ground);
  }

  function mountContent(lm) {
    var overlay = $("overlay");
    var content = $("overlay-content");
    if (!overlay || !content) { return; }

    /* 视觉契约（契约 §5）：让 Agent D 能取到 --field-color */
    content.setAttribute("data-field", lm.id);

    /* 标题在挂载前写好，保证 dialog 的 aria-labelledby 立刻有效 */
    var titleEl = $("overlay-title");
    if (titleEl) { titleEl.textContent = titleFor(lm); }

    /* 契约 §3.5：调用 ContentModule 前必须判空 —— 对方文件尚未就位时不得崩溃 */
    var mounted = false;
    if (window.ContentModule && typeof window.ContentModule.mount === "function") {
      try {
        window.ContentModule.mount(content, { id: lm.id, site: site, works: works, notes: notes });
        mounted = true;
      } catch (err) {
        if (window.console && console.error) { console.error("[Scene] ContentModule.mount 失败", err); }
      }
    }
    if (!mounted) { renderDevPlaceholder(content, lm); }

    overlay.setAttribute("data-state", "open");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("m-overlay-open");

    Engine.setDim(true);              /* §7.3 步 3：网格退让 */

    state.view = "focused";
    setLandmarkTabindex(-1);          /* §9.3 Tab 陷阱：地图地标此时不可聚焦 */
    focusOverlay();

    document.title = TITLE + " — " + lm.name;   /* 05 §9.5 */
    writeHash(lm.id);

    emit("overlay:open", { id: lm.id });
  }

  /** 开发期解耦占位：Agent D 的模块尚未就位时，至少让内容区不是空白。
      文案走 site.messages.loadFailed，缺失时有内置兜底（P-4：不硬编码）。 */
  function renderDevPlaceholder(content, lm) {
    content.textContent = "";
    var box = el("div", "m-error-card");
    box.appendChild(el("div", "m-error-card__title", "内容模块未就位"));
    box.appendChild(el("div", "m-error-card__body",
      msg("loadFailed", FALLBACK.loadFailed) + "（当前打开的是「" + lm.name + "」）"));
    content.appendChild(box);
  }

  function teardownContent() {
    if (window.ContentModule && typeof window.ContentModule.unmount === "function") {
      try { window.ContentModule.unmount(); } catch (err) {
        if (window.console && console.warn) { console.warn("[Scene] ContentModule.unmount 失败", err); }
      }
    }
    var content = $("overlay-content");
    if (content) { content.textContent = ""; }
  }

  function closeOverlay() {
    if (window.MomentsRoom && window.MomentsRoom.isOpen()) {
      window.MomentsRoom.close();
      return;
    }
    if (window.FieldRoom && window.FieldRoom.isOpen()) {
      window.FieldRoom.close();
      return;
    }
    if (window.RhythmPlayer && window.RhythmPlayer.isOpen()) {
      window.RhythmPlayer.close();
      return;
    }
    if (window.SpaceCity && typeof window.SpaceCity.isOpen === "function" && window.SpaceCity.isOpen()) {
      window.SpaceCity.close();
      return;
    }
    if (state.view !== "focused") { return; }

    var prevId = state.activeId;
    var overlay = $("overlay");

    /* 编排（05 §7.3 返回时）：覆盖层淡出与镜头拉回**并行** */
    teardownContent();
    if (overlay) {
      overlay.setAttribute("data-state", "closed");
      overlay.setAttribute("aria-hidden", "true");
    }
    document.body.classList.remove("m-overlay-open");

    state.view = "overview";
    state.activeId = null;
    document.title = TITLE;
    clearHash();

    Camera.reset();                    /* 600ms --ease-camera */
    Engine.setDim(false);

    var t = Tokens.get();
    var restoreDelay = (state.mode === "full") ? (t.durCamera * 2 / 3) : 0;
    var tabDelay = (state.mode === "full") ? t.durOverlayOut : 0;

    /* 其余地标「等相机拉回到 2/3 处再显现」，避免突然冒出来（05 §7.3 步 4）*/
    window.setTimeout(function () { setActive(null, false); }, restoreDelay);
    window.setTimeout(function () { setLandmarkTabindex(0); }, tabDelay);

    returnFocus(prevId);
    emit("overlay:close", {});
  }

  /** 聚焦时其余地标退让（05 §7.3 步 2：opacity 1 → 0.25） */
  function setActive(id, dim) {
    landmarks.forEach(function (lm) {
      if (!lm.el) { return; }
      var isActive = (id === lm.id);
      lm.el.setAttribute("data-dim", (dim && !isActive) ? "1" : "0");
      lm.el.setAttribute("aria-expanded", isActive ? "true" : "false");
    });
  }

  function setLandmarkTabindex(v) {
    landmarks.forEach(function (lm) {
      if (!lm.el) { return; }
      if (v < 0) { lm.el.setAttribute("tabindex", "-1"); }
      else { lm.el.removeAttribute("tabindex"); }
    });
  }

  function focusOverlay() {
    var overlay = $("overlay");
    var b = overlay && (focusables(overlay)[0] || overlay);
    if (b) {
      try { b.focus({ preventScroll: true }); } catch (e) { b.focus(); }
    }
  }

  /** 关闭时焦点返回触发它的那个地标（05 §9.3：不要回到 body） */
  function returnFocus(id) {
    var lm = id && Lm ? Lm.get(id) : null;
    if (lm && lm.el) {
      try { lm.el.focus({ preventScroll: true }); } catch (e) { lm.el.focus(); }
      return;
    }
    var b = $("overlay");
    if (b && document.activeElement === b) { b.blur(); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     10 —— L6 提示条（A-16）
     ══════════════════════════════════════════════════════════════════════════ */

  var toastEl = null, toastTimer = 0, toastOutTimer = 0;

  function showToast(text) {
    var host = $("global-message");
    if (!host) { return; }
    if (toastEl && toastEl.parentNode === host) { host.removeChild(toastEl); }
    window.clearTimeout(toastTimer);
    window.clearTimeout(toastOutTimer);

    toastEl = el("div", "m-toast", text);
    host.appendChild(toastEl);
    /* 强制一次重排，保证 transition 从初始态开始 */
    void toastEl.offsetWidth;
    toastEl.setAttribute("data-state", "in");

    var t = Tokens.get();
    /* §10.2：降级态下停留时间从 4s 延长到 8s（无滑动动画，需要更多阅读时间）*/
    var dwell = (state.mode === "full") ? t.toastDwell : t.toastDwellStatic;
    toastTimer = window.setTimeout(function () {
      if (!toastEl) { return; }
      toastEl.removeAttribute("data-state");
      toastOutTimer = window.setTimeout(function () {
        if (toastEl && toastEl.parentNode) { toastEl.parentNode.removeChild(toastEl); }
        toastEl = null;
      }, t.durToastOut);
    }, dwell);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     11 —— 数据错误卡片（05 §10.4 / 契约 §4.2）
     ⚠️ 地图本身必须仍然可见 —— 这保证了即使数据全丢，视觉作品感仍在。
     ══════════════════════════════════════════════════════════════════════════ */

  function renderErrorCard() {
    var host = $("global-message");
    if (!host) { return; }

    var card = el("div", "m-error-card");
    card.setAttribute("role", "alert");

    card.appendChild(el("div", "m-error-card__title", msg("errorTitle", FALLBACK.errorTitle)));
    card.appendChild(el("div", "m-error-card__body", msg("errorBody", FALLBACK.errorBody)));

    var hint = el("div", "m-error-card__hint", msg("errorHint", FALLBACK.errorHint));
    card.appendChild(hint);

    var btn = el("button", "m-error-card__btn", msg("errorAction", FALLBACK.errorAction));
    btn.type = "button";
    btn.addEventListener("click", function () { window.location.reload(); });
    card.appendChild(btn);

    host.appendChild(card);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     12 —— 交互：地标点击 / 返回 / 键盘可访问性 / 深链接
     ══════════════════════════════════════════════════════════════════════════ */

  /* 点在空白处 = 返回全景（PRD §3.2 /《04》状态机：点击地图空白 → 返回中）*/
  function onAppClick(e) {
    if (state.view !== "focused") { return; }
    if (e.target && e.target.closest && e.target.closest(".m-landmark")) { return; }
    if (e.target && e.target.closest && e.target.closest("#map-controls")) { return; }
    /* 【集成修复·关键】#overlay 是 #app 的子元素，若不在此处排除，
       点击覆盖层内的作品卡 / 分段切换 / 「展开」按钮会冒泡到这里，
       把整个覆盖层关掉——表现为「点什么都关窗」。
       右侧内容的点击不触发地图返回。 */
    if (e.target && e.target.closest && e.target.closest("#overlay")) { return; }
    closeOverlay();
  }

  function bindInteraction() {
    var app = $("app");

    /* 只保留点击驱动的状态 / 视角变换，不注册拖拽、滚轮、捏合或键盘平移。 */
    app.addEventListener("click", onAppClick);

    /* 捕获阶段先处理左半屏，包括地标：聚焦后点击左侧不再打开另一个场。
       时间调试控件仍可操作；城市第二界面保持它自己的返回交互。 */
    document.addEventListener("click", function (e) {
      if (e.detail === 0) { return; }  /* 键盘激活入口没有鼠标坐标。 */
      if (state.view !== "focused" ||
          (window.MomentsRoom && window.MomentsRoom.isOpen()) ||
          (window.FieldRoom && window.FieldRoom.isOpen()) ||
          (window.RhythmPlayer && window.RhythmPlayer.isOpen()) ||
          (window.SpaceCity && window.SpaceCity.isOpen && window.SpaceCity.isOpen())) { return; }
      if (e.target && e.target.closest && e.target.closest(".m-time-control")) { return; }
      var inOverlay = e.target && e.target.closest && e.target.closest("#overlay");
      var leftMap = window.innerWidth >= 768 ? e.clientX < window.innerWidth / 2 : !inOverlay;
      if (!leftMap) { return; }
      e.preventDefault();
      e.stopPropagation();
      closeOverlay();
    }, true);

    window.addEventListener("resize", function () {
      Engine.resize();
      layoutLandmarks();
      Engine.requestFrame();
    });

    window.addEventListener("keydown", onKeyDown);
  }

  function onKeyDown(e) {
    if (window.MomentsRoom && window.MomentsRoom.isOpen()) { return; }
    if (window.FieldRoom && window.FieldRoom.isOpen()) { return; }
    if (window.RhythmPlayer && window.RhythmPlayer.isOpen()) { return; }
    if (window.SpaceCity && typeof window.SpaceCity.isOpen === "function" && window.SpaceCity.isOpen()) {
      return;
    }
    /* ESC：从任意子状态返回全景（《04》状态机 / 05 §9.3）*/
    if (e.key === "Escape") {
      if (state.view === "focused") { e.preventDefault(); closeOverlay(); }
      return;
    }

    /* Tab 陷阱：覆盖层打开时焦点限制在覆盖层内（05 §9.3）*/
    if (e.key === "Tab" && state.view === "focused") {
      trapTab(e);
      return;
    }

    /* 方向键不再操纵镜头。 */
  }

  function focusables(root) {
    var sel = 'a[href], button:not([disabled]), input:not([disabled]), ' +
              'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    var all = root.querySelectorAll(sel);
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      if (n.offsetWidth || n.offsetHeight || n.getClientRects().length) { out.push(n); }
    }
    return out;
  }

  function trapTab(e) {
    var overlay = $("overlay");
    if (!overlay) { return; }
    var f = focusables(overlay);
    if (!f.length) { return; }
    var first = f[0], last = f[f.length - 1];
    var inside = overlay.contains(document.activeElement);

    if (!inside) { e.preventDefault(); first.focus(); return; }
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* ---- 深链接（PRD §3.2：URL hash 记录当前位置，P1 需求）---- */

  var HASH_RE = /^#\/field\/([a-z]+)$/;

  function writeHash(id) {
    try { window.history.replaceState(null, "", "#/field/" + id); } catch (e) { /* file:// 下忽略 */ }
  }
  function clearHash() {
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch (e) { /* file:// 下忽略 */ }
  }
  function restoreFromHash() {
    var m = HASH_RE.exec(window.location.hash || "");
    if (!m) { return; }
    if (Lm && Lm.has(m[1])) { openLandmark(m[1]); }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     13 —— 启动
     ══════════════════════════════════════════════════════════════════════════ */

  function boot() {
    if (window.IntroScreen) { window.IntroScreen.start(); }
    /* --- 3.0 识别色注入必须最先，否则首帧会用到 tokens.css 的默认色 --- */
    applyFieldColors();

    /* --- 3.1 引擎先行：它同时负责 canvas 尺寸与地图平面尺寸 --- */
    var cameraReady = false;

    Engine.init({
      canvas: $("map-canvas"),
      layer: $("landmark-layer"),
      onResize: function (o) { if (cameraReady) { Camera.onResize(o); } }
    });

    /* --- 3.2 地标解析（在镜头初始化之前，因为镜头需要地标点做边界约束）--- */
    landmarks = Lm.parse(site);
    Lm.setMapSize(Engine.getMapSize().w, Engine.getMapSize().h);

    /* --- 3.3 镜头 --- */
    var m = Engine.getMapSize();
    Camera.init({
      w: window.innerWidth,
      h: window.innerHeight,
      mapW: m.w,
      mapH: m.h,
      onChange: syncWorld
    });
    cameraReady = true;

    Camera.setPointsProvider(function () {
      return landmarks.map(function (lm) { return { x: lm.wx, y: lm.wy }; });
    });

    /* 桌面端覆盖层占右侧 --overlay-w，聚焦时把地标推到可见地图区的中心 */
    Camera.setFocusOffsetProvider(function () {
      var overlay = $("overlay");
      var w = (overlay && overlay.offsetWidth) ? overlay.offsetWidth : 0;
      var wide = window.innerWidth >= 768;
      /* 桌面和平板都让出右半屏；手机居中。 */
      return wide ? { x: -w / 2, y: 0 } : { x: 0, y: 0 };
    });

    Engine.setView(Camera.getView());
    Engine.setFrameHook(function (t) { Camera.update(t); });

    /* --- 3.4 DOM --- */
    buildLandmarks();
    layoutLandmarks();
    buildControls();
    buildHero();
    syncWorld(Camera.getView());

    /* --- 3.5 交互先绑定；地形完成前由开屏层拦截视觉与点击 --- */
    bindInteraction();

    /* --- 3.6 完整预加载后才启动播放 --- */
    var mode = hasData ? decideInitialMode() : "static";
    if (!hasData) {
      finishSceneBoot(mode);
      return;
    }

    /* reduced 只作为预加载期间的暂停态，不代表低帧率播放。 */
    state.mode = "";
    applyMode("reduced", false);
    updateTerrainPreloader({ phase: "terrain", progress: 0, ready: false });
    if (Engine && typeof Engine.preloadTerrain === "function") {
      Engine.preloadTerrain(function (info) {
        updateTerrainPreloader(info);
        if (info && info.ready) { finishSceneBoot(mode); }
      });
    } else {
      finishSceneBoot(mode);
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     14 —— 暴露 window.Scene（契约 §2.2 / §2.4）
     ══════════════════════════════════════════════════════════════════════════ */

  var Scene = window.Scene || (window.Scene = {});

  Scene.data = {
    site:  site,
    works: works,
    notes: notes
  };

  Scene.openLandmark = openLandmark;
  Scene.closeOverlay = closeOverlay;
  Scene.getState = function () {
    return { view: state.view, activeId: state.activeId };
  };
  /* 运行期新增 / 删除作品或印记后调用。旧循环继续播放，新主体、远景、
     统一等高线与太阳阴影全部完成后再原子切换。 */
  Scene.refreshTerrain = function () {
    if (!Engine || typeof Engine.invalidateTerrain !== "function") { return false; }
    Engine.invalidateTerrain();
    emit("terrain:rebuild", {});
    return true;
  };
  Scene.on = on;

  /* mode 既是只读查询也是可写开关：写它会走完整的降级链路
     （引擎换模式 + ContentModule.setMode + mode:change 事件） */
  Object.defineProperty(Scene, "mode", {
    enumerable: true,
    configurable: false,
    get: function () { return state.mode; },
    set: function (v) {
      if (v !== "full" && v !== "static" && v !== "reduced") { return; }
      applyMode(v, false);
    }
  });

  if (!Engine || !Camera || !Lm) {
    /* 依赖缺失（某种加载顺序错误）：至少报出来，且不白屏 */
    if (window.console && console.error) { console.error("[Scene] 引擎模块缺失，请检查 index.html 的脚本顺序"); }
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
