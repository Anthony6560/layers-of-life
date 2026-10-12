/* ============================================================================
   camera.js —— 镜头平移 / 缩放 / 聚焦插值 / 边界约束
   ----------------------------------------------------------------------------
   职责（契约 §1）：「镜头平移/缩放/聚焦插值、边界约束」

   设计要点：
     · 镜头只改 view（{x, y, scale}），**不碰布局**——
       地图的平移缩放在 Canvas 的 setTransform 与 #map-world 的 transform 上
       一次性表达，绝不逐帧改任何元素的 left/top（§7.5 动效禁令：
       动效不得改变布局尺寸，禁止触发重排）。
     · 缓动统一取 tokens.css 的 --ease-camera（cubic-bezier(.65,0,.35,1)
       = easeInOutCubic），由 map-engine 的 cubicBezier 求解。
     · mode !== 'full' 时动效时长按 0ms 处理（契约 §6），即瞬移但保留状态转换。
     · 与绘制共用**同一个 rAF**：主循环在跑时由它调用 update()；
       未跑时（降级态）镜头自己起一个临时 rAF，结束即停。
   ============================================================================ */

(function () {
  "use strict";

  if (!window.Scene) { window.Scene = {}; }
  var Scene = window.Scene;
  if (!Scene._) { Scene._ = {}; }

  var Engine = Scene._.MapEngine;
  var Tokens = Scene._.Tokens;

  var view = { x: 0, y: 0, scale: 1, inited: false };

  var vp = { w: 0, h: 0 };
  var mapW = 0, mapH = 0;
  var minScale = 0.6, maxScale = 2.5, focusScale = 1.6, durCamera = 600;

  /* ── 三维视角（docs/10 §3.2 / §6）──────────────────────────────────────
     v2.1：固定 52° 轴测 → 可自由旋转的正交三维。
       · yaw   方位角，**无限制**（可绕着地形一直转）
       · pitch 俯仰角，钳在 [10°, 88°]
         —— 低于 10° 时等高线几乎重叠成一条线、Painter 排序退化；
            90° 时地层板全部退化为零面积，留 2° 让「这是一叠板」始终可见
     角度的**唯一真相**在本模块，由 pushAngles() 推给投影层（map-engine），
     地标（landmarks.js）与地形因此共用同一套投影（风险 R-8）。 */
  var YAW_HOME = -18, PITCH_HOME = 52;
  var PITCH_MIN = 10, PITCH_MAX = 88;
  var YAW_PER_PX = 0.4, PITCH_PER_PX = 0.3;   /* §6 拖拽灵敏度：度 / 屏幕像素 */

  var yaw = YAW_HOME, pitch = PITCH_HOME;
  var pushedYaw = null, pushedPitch = null;

  /* ── 自适应缩放下限（v2.0 / docs/08 §4.6）────────────────────────────────
     PRD 锁定 0.6x 时，地图范围是固定的。v2.0 后地形随内容生长，
     而实测 fit 所需缩放已经是 0.601 —— 只高出下限 0.2%。
     这意味着**再新增一个场，初始视图就装不下全图**（会被钳在 0.6x 并裁掉边距）。
     规则：正常情况下下限仍是 0.6（PRD 不变）；仅当 fit 所需缩放更小、
     即地形确实长大到装不下时，下限跟随下探，留 8% 余量。 */
  var fitFloor = Infinity;
  /* 全景缩放仍按完整地形包围盒计算，中心只做稳定的构图微调。 */
  var OVERVIEW_VERTICAL_BIAS = 0.045;
  /* 初始全景允许随旋转重新适配；用户主动平移/缩放后进入探索态。 */
  var overviewLocked = false;

  function effectiveMinScale() { return Math.min(minScale, fitFloor); }

  /* 视图中心允许偏移到地图平面的比例范围。
     这是一个**比例**（不是像素值），作用是让地图不会"跑丢"到空白区；
     真正的硬约束是下面的"至少一个地标留在视口内"。

     ⚠️ v2.0（docs/08 §4.6）：地形会溢出归一化方格 [0,1]（实测约 −0.11 ~ 1.07），
        因此**只要地形包围盒可用，平移边界就取 extent，而不是 [0,1]** ——
        否则最外层等高线会被挡在可平移范围之外，用户拖到边缘会看到地形被"切平"。
        下面两个常数只在没有地形时（无数据 / 引擎未就位）兜底。 */
  var CENTER_MIN = 0.10;
  var CENTER_MAX = 0.90;

  /* 初始视图 fit 到 extent 时留的边距（docs/08 §4.6：12%） */
  var FIT_MARGIN = 0.12;

  var onChange = null;        /* function(view) —— app.js 用来同步 DOM */
  var focusOffsetFn = null;   /* function() → {x, y} 屏幕像素：聚焦时地标要落在哪 */
  var pointsFn = null;        /* function() → [{x,y}] 世界坐标：边界约束用 */

  var anim = null;            /* 进行中的镜头动画 */
  var selfTick = 0;           /* 降级态下的临时 rAF id */
  var orbit = null, orbitHome = null, orbitAnim = null, orbitLastTime = 0;

  function orbitAvailable() {
    return !!(window.CameraMotion && window.TerrainOrbit && window.TerrainOrbit.ready() && Engine.getMode() === 'full');
  }
  function initOrbit() {
    if (orbit) return;
    var p = Engine.unprojectNorm(0, 0, view.x, view.y, 1, 0, 0);
    orbit = { x: p.x, y: p.y, z: 0, offsetX: 0, offsetY: 0 };
    orbitHome = { x: p.x, y: p.y, z: 0, scale: view.scale, pitch: PITCH_HOME };
  }
  function startOrbit(target, cb) {
    initOrbit(); cancelAnim();
    orbit.followTerrain = !!target.followTerrain;
    orbitAnim = { target: target, startedAt: now(), cb: cb || null };
    ensureTicking();
  }
  function updateOrbit(t) {
    initOrbit();
    var motion = window.CameraMotion, dt = orbitLastTime ? Math.min(100, Math.max(0, t - orbitLastTime)) : 1000 / 60;
    orbitLastTime = t;
    var target = orbitAnim && orbitAnim.target;
    /* 主页与普通局部页保持统一的慢速自转。只要目标没有明确要求
       方位插值，就按经过时间推进，并把角度收回 [-180°, 180°) 以免长期累积。 */
    if (!target || typeof target.yaw !== "number" || !isFinite(target.yaw)) {
      yaw += motion.spin(dt) * 180 / Math.PI;
      yaw = yaw - Math.round(yaw / 360) * 360;
    }
    if (orbitAnim) {
      var rate = motion.rate(dt);
      if (typeof target.yaw === "number" && isFinite(target.yaw)) {
        yaw += (nearestAngle(yaw, target.yaw) - yaw) * rate;
      } else {
        /* target 没有 yaw 时，上面的自转就是唯一的方位变化来源。 */
      }
      if (target.followTerrain) target.z = Engine.veOf(Engine.terrainHeightAt(target.x, target.y));
      ['x', 'y', 'z', 'offsetX', 'offsetY'].forEach(function (key) { orbit[key] += (target[key] - orbit[key]) * rate; });
      view.scale = motion.damp(view.scale, target.scale, dt);
      pitch = motion.damp(pitch, target.pitch, dt);
    } else if (orbit.followTerrain) orbit.z = Engine.veOf(Engine.terrainHeightAt(orbit.x, orbit.y));
    if (orbitAnim && t - orbitAnim.startedAt >= motion.settleMs) {
      var completed = orbitAnim, completedTarget = completed.target;
      orbit.x = completedTarget.x;
      orbit.y = completedTarget.y;
      orbit.z = completedTarget.z;
      orbit.offsetX = completedTarget.offsetX || 0;
      orbit.offsetY = completedTarget.offsetY || 0;
      view.scale = completedTarget.scale;
      pitch = completedTarget.pitch;
      if (typeof completedTarget.yaw === "number" && isFinite(completedTarget.yaw)) {
        yaw = nearestAngle(yaw, completedTarget.yaw);
      }
      orbitAnim = null;
      pushAngles();
      var cb = completed.cb;
      completed.cb = null;
      if (typeof cb === 'function') cb();
    }
    pushAngles();
    var projected = Engine.projectWorld(orbit.x, orbit.y, orbit.z);
    view.x = projected.x - orbit.offsetX / view.scale;
    view.y = projected.y - orbit.offsetY / view.scale;
    emit();
    return !!orbitAnim;
  }

  /* ────────────────────────────────────────────────────────────────────────
     工具
     ──────────────────────────────────────────────────────────────────────── */

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function now() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  function readConfig() {
    var t = Tokens.get();
    minScale   = t.scaleMin;
    maxScale   = t.scaleMax;
    focusScale = t.scaleFocus;
    durCamera  = t.durCamera;
    /* 三维视角的默认机位与钳位区间以**投影层**（map-engine.LIMITS）为准，
       避免两处各写一份 −18° / 60° 然后慢慢分叉 */
    var L = Engine && Engine.LIMITS;
    if (L) {
      if (typeof L.yaw === "number" && isFinite(L.yaw)) { YAW_HOME = L.yaw; }
      if (typeof L.pitch === "number" && isFinite(L.pitch)) { PITCH_HOME = L.pitch; }
      if (typeof L.pitchMin === "number" && isFinite(L.pitchMin)) { PITCH_MIN = L.pitchMin; }
      if (typeof L.pitchMax === "number" && isFinite(L.pitchMax)) { PITCH_MAX = L.pitchMax; }
    }
    if (!view.inited) { yaw = YAW_HOME; pitch = PITCH_HOME; }
    pitch = clampPitch(pitch);
  }

  function emit() {
    if (typeof onChange === "function") { onChange(view); }
  }

  /* ────────────────────────────────────────────────────────────────────────
     初始化 / 尺寸
     ──────────────────────────────────────────────────────────────────────── */

  /* ────────────────────────────────────────────────────────────────────────
     三维视角：状态 → 投影层
     ──────────────────────────────────────────────────────────────────────── */

  function clampPitch(p) {
    if (!isFinite(p)) { return pitch; }
    return p < PITCH_MIN ? PITCH_MIN : (p > PITCH_MAX ? PITCH_MAX : p);
  }

  /**
   * 把当前视角推给投影层，并**作废世界包围盒缓存**。
   * 旋转会让投影后的地形包围盒显著变化（docs/10 §3.5），
   * fit / 边界约束必须跟着重算。
   */
  function pushAngles() {
    if (pushedYaw === yaw && pushedPitch === pitch) { return; }
    pushedYaw = yaw; pushedPitch = pitch;
    var E = Scene._.MapEngine;
    if (E && typeof E.setCameraAngles === "function") {
      E.setCameraAngles(yaw, pitch);
    }
    invalidateBounds();
  }

  /** 取与 from 最接近的等价角度（避免「复位」时绕远路转一大圈） */
  function nearestAngle(from, to) {
    return to + Math.round((from - to) / 360) * 360;
  }

  function getAngles() { return { yaw: yaw, pitch: pitch }; }

  /**
   * 设定视角（度）。yaw 不限、pitch 自动钳位。
   * @returns {boolean} 是否真的发生了变化
   */
  function setAngles(y, p) {
    var ny = (typeof y === "number" && isFinite(y)) ? y : yaw;
    var np = clampPitch(typeof p === "number" ? p : pitch);
    if (Math.abs(ny - yaw) < 1e-9 && Math.abs(np - pitch) < 1e-9) { return false; }
    yaw = ny; pitch = np;
    pushAngles();
    if (view.inited && overviewLocked) {
      var fit = overviewView();
      view.x = fit.x;
      view.y = fit.y;
      view.scale = fit.scale;
    }
    clampView();
    emit();
    return true;
  }

  /**
   * 拖拽 = **旋转**（docs/10 §6）：yaw += dx·0.4°/px，pitch −= dy·0.3°/px。
   * 鼠标往下拖 → 视线抬高（pitch 减小），与「把地形往下拉」的手感一致。
   */
  function rotateBy(dxScreen, dyScreen) {
    cancelAnim();
    /* 方向修正：原为 `yaw + dx`，实测手感相反（向右拖时地形顺时针转，
       与「抓住地形往右拽」的直觉相反）。改为 `yaw − dx`。
       投影公式 x1 = x·cos(yaw) − y·sin(yaw) 中，yaw 增大在屏幕上表现为顺时针，
       所以向右拖要让 yaw 减小，地形才跟着手走。
       pitch 保持不变：向下拖视角压低（更接近平视），与「把远边往下压」一致。 */
    var changed = setAngles(yaw - dxScreen * YAW_PER_PX,
                            pitch - dyScreen * PITCH_PER_PX);
    if (changed) { Engine.requestFrame(); }
    return changed;
  }

  function init(options) {
    onChange = options.onChange || null;
    vp.w = options.w || window.innerWidth;
    vp.h = options.h || window.innerHeight;
    mapW = options.mapW || 0;
    mapH = options.mapH || 0;
    readConfig();
    invalidateBounds();
    pushAngles();          /* 先把视角推给投影层，再算拟合机位 */

    if (!view.inited) {
      /* 初始视图：**自适应地形包围盒**（docs/08 §4.6）。
         地形范围随内容生长，因此"看清全图所需的缩放级别"本身就是内容量的度量。 */
      var home = overviewView();
      view.x = home.x;
      view.y = home.y;
      view.scale = home.scale;
      view.inited = true;
      overviewLocked = true;
    } else {
      clampView();
    }
    return view;
  }

  function onResize(o) {
    vp.w = o.w; vp.h = o.h; mapW = o.mapW; mapH = o.mapH;
    readConfig();
    pushAngles();
    invalidateBounds();
    if (orbit) {
      orbitHome.scale = overviewView().scale;
      var offset = typeof focusOffsetFn === 'function' ? focusOffsetFn() : { x: 0, y: 0 };
      if (orbitAnim) {
        if (overviewLocked) orbitAnim.target.scale = orbitHome.scale;
        else { orbitAnim.target.offsetX = offset.x || 0; orbitAnim.target.offsetY = offset.y || 0; }
      } else if (overviewLocked) view.scale = orbitHome.scale;
      else { orbit.offsetX = offset.x || 0; orbit.offsetY = offset.y || 0; }
      return;
    }
    clampView();
    emit();
  }

  /* ────────────────────────────────────────────────────────────────────────
     广度自适应（docs/08 §4.6）
     ------------------------------------------------------------------------
     地形包围盒由引擎给出（世界坐标，已含 2.5D 的垂直偏移）。
     缓存一份：clampView 在拖拽的每一帧都会被调用。
     ──────────────────────────────────────────────────────────────────────── */

  var boundsCache = null;

  function invalidateBounds() { boundsCache = null; }

  function terrainBounds() {
    if (boundsCache) { return boundsCache; }
    var E = Scene._.MapEngine;
    if (!E || typeof E.getTerrainWorldBounds !== "function") { return null; }
    try { boundsCache = E.getTerrainWorldBounds(); } catch (e) { boundsCache = null; }
    return boundsCache;
  }

  /** 把任意归一化矩形换算成世界包围盒（含高度），供 fitToExtent 使用 */
  function worldBoundsOfNorm(e) {
    var E = Scene._.MapEngine;
    if (!E || typeof E.projectWorld !== "function") { return null; }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var N = 8;
    for (var j = 0; j <= N; j++) {
      var y = e.y0 + (e.y1 - e.y0) * (j / N);
      for (var i = 0; i <= N; i++) {
        var x = e.x0 + (e.x1 - e.x0) * (i / N);
        var z = 0;
        try {
          z = (typeof E.terrainHeightAt === "function") ? E.terrainHeightAt(x, y) : 0;
          /* 投影要的是**世界高度**（含垂直夸张 VE），不是地形高度 h。
             两者差一个 VE —— 与 landmarks.js 的 projectGround 同源（风险 R-8）。 */
          if (typeof E.veOf === "function") { z = E.veOf(z); }
        } catch (err) { z = 0; }
        var w = E.projectWorld(x, y, z);
        if (w.x < x0) { x0 = w.x; }
        if (w.x > x1) { x1 = w.x; }
        if (w.y < y0) { y0 = w.y; }
        if (w.y > y1) { y1 = w.y; }
      }
    }
    if (!isFinite(x0)) { return null; }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /**
   * 计算"能看全 extent"的机位。
   * @param {Object} [extent] 归一化包围盒 {x0,y0,x1,y1}；缺省用引擎给出的地形 extent
   * @returns {{x:number, y:number, scale:number}} 世界坐标下的视图
   */
  function overviewView(extent) {
    var b = extent ? worldBoundsOfNorm(extent) : null;
    if (!b) { b = terrainBounds(); }

    if (!b) {
      /* 无地形（数据缺失 / 引擎未就位）：退回地图平面中心，保持 P-4 的"不白屏" */
      return { x: mapW / 2, y: mapH / 2, scale: 1 };
    }

    var bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    if (!(bw > 0) || !(bh > 0)) { return { x: mapW / 2, y: mapH / 2, scale: 1 }; }

    /* 留 12% 边距：内容占视口的 88% */
    var s = Math.min(vp.w * (1 - FIT_MARGIN) / bw, vp.h * (1 - FIT_MARGIN) / bh);
    if (!isFinite(s) || s <= 0) { s = 1; }

    /* 若 fit 所需缩放低于配置下限，说明地形已长大到 0.6x 装不下 ——
       此时下探下限，而不是把边距裁掉（内容被切边比缩放越界更糟）。 */
    fitFloor = (s < minScale) ? s * 0.92 : Infinity;

    var cx = (b.x0 + b.x1) / 2;
    var cy = (b.y0 + b.y1) / 2;
    /* 山体高度会把主题峰顶推向画面上方，给全景中心留一点下移空间。 */
    cy -= bh * OVERVIEW_VERTICAL_BIAS;

    return { x: cx, y: cy, scale: clampScale(s) };
  }

  /**
   * 初始视图自适应地形包围盒（docs/08 §4.6）。
   * @param {Object} [extent] 归一化包围盒；缺省用引擎的 extent
   * @param {Function} [cb] 动画结束回调
   */
  function fitToExtent(extent, cb) {
    var v = overviewView(extent);
    startAnim({ x: v.x, y: v.y, scale: v.scale }, cb);
    return v;
  }

  /* ────────────────────────────────────────────────────────────────────────
     边界约束（PRD §4.1.2 / 验收标准 3）
     「地图平移不得使可见地标全部移出视口；缩放范围锁定在 0.6x ~ 2.5x」
     ──────────────────────────────────────────────────────────────────────── */

  function clampScale(s) { return clamp(s, effectiveMinScale(), maxScale); }

  function clampView() {
    /* ① 视图中心限制在**地形包围盒**（docs/08 §4.6）。
          地形会溢出 [0,1]，若边界仍取归一化方格，最外层等高线就拖不到
          视野里。没有地形时退回地图平面的比例范围。 */
    var b = terrainBounds();
    if (b) {
      view.x = clamp(view.x, b.x0, b.x1);
      view.y = clamp(view.y, b.y0, b.y1);
    } else {
      view.x = clamp(view.x, mapW * CENTER_MIN, mapW * CENTER_MAX);
      view.y = clamp(view.y, mapH * CENTER_MIN, mapH * CENTER_MAX);
    }

    /* ② 硬约束：视口内至少要有一个地标。
          任意缩放级别下都不能"跑丢"—— 这是 PRD 验收标准 3 的直接实现。 */
    if (typeof pointsFn === "function" && vp.w > 0) {
      var pts = pointsFn() || [];
      if (pts.length) {
        var halfW = vp.w / (2 * view.scale);
        var halfH = vp.h / (2 * view.scale);
        /* 允许地标贴近边缘，但不允许完全离开视口 */
        var margX = halfW * 0.08;
        var margY = halfH * 0.08;
        var any = false, best = null, bestD = Infinity;

        for (var i = 0; i < pts.length; i++) {
          var dx = pts[i].x - view.x;
          var dy = pts[i].y - view.y;
          if (Math.abs(dx) <= halfW + margX && Math.abs(dy) <= halfH + margY) { any = true; break; }
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = pts[i]; }
        }

        if (!any && best) {
          /* 把最近的那个地标拉回视口中心 */
          view.x = best.x;
          view.y = best.y;
          if (b) {
            view.x = clamp(view.x, b.x0, b.x1);
            view.y = clamp(view.y, b.y0, b.y1);
          } else {
            view.x = clamp(view.x, mapW * CENTER_MIN, mapW * CENTER_MAX);
            view.y = clamp(view.y, mapH * CENTER_MIN, mapH * CENTER_MAX);
          }
        }
      }
    }
    return view;
  }

  /* ────────────────────────────────────────────────────────────────────────
     平移
     ──────────────────────────────────────────────────────────────────────── */

  /** @param {number} dxScreen 屏幕像素位移（正值 = 内容向右） */
  function panBy(dxScreen, dyScreen) {
    cancelAnim();
    overviewLocked = false;
    view.x -= dxScreen / view.scale;
    view.y -= dyScreen / view.scale;
    clampView();
    emit();
    Engine.requestFrame();
  }

  /* ────────────────────────────────────────────────────────────────────────
     缩放（锚点为光标，PRD §4.1.2）
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 以某个屏幕点为锚点缩放到目标倍率：锚点下方的世界坐标在缩放前后保持不动。
   * @param {number} newScale
   * @param {number} sx 屏幕 x（锚点）
   * @param {number} sy 屏幕 y（锚点）
   */
  function zoomAt(newScale, sx, sy) {
    cancelAnim();
    overviewLocked = false;
    var s0 = view.scale;
    var s1 = clampScale(newScale);
    if (Math.abs(s1 - s0) < 1e-6) { return false; }

    var wx = view.x + (sx - vp.w / 2) / s0;
    var wy = view.y + (sy - vp.h / 2) / s0;
    view.scale = s1;
    view.x = wx - (sx - vp.w / 2) / s1;
    view.y = wy - (sy - vp.h / 2) / s1;

    clampView();
    emit();
    Engine.requestFrame();
    return true;
  }

  function zoomBy(factor, sx, sy) {
    return zoomAt(view.scale * factor, sx, sy);
  }

  function canZoomIn()  { return view.scale < maxScale - 1e-3; }
  function canZoomOut() { return view.scale > effectiveMinScale() + 1e-3; }

  /* ────────────────────────────────────────────────────────────────────────
     镜头插值（契约 §6：600ms / cubic-bezier(0.65,0,0.35,1)）
     ──────────────────────────────────────────────────────────────────────── */

  function duration() {
    /* 契约 §6 降级规则：mode !== 'full' 时所有动效时长按 0ms 处理，
       但**保留状态转换**（地图瞬移到目标位置的静态帧）。 */
    var m = Engine.getMode();
    return (m === "full") ? durCamera : 0;
  }

  function startAnim(to, cb) {
    /* to 里带 yaw 时，视角也一起插值（「回到全景」要同时转回初始机位） */
    var hasAngle = (typeof to.yaw === "number" && isFinite(to.yaw));
    var toYaw = hasAngle ? nearestAngle(yaw, to.yaw) : yaw;
    var toPitch = hasAngle ? clampPitch(to.pitch) : pitch;

    var d = duration();
    if (d <= 0) {
      cancelAnim();
      view.x = to.x; view.y = to.y; view.scale = to.scale;
      if (hasAngle) { yaw = toYaw; pitch = toPitch; pushAngles(); }
      clampView();
      emit();
      Engine.requestFrame();
      if (typeof cb === "function") { cb(); }
      return;
    }
    anim = {
      from: { x: view.x, y: view.y, scale: view.scale, yaw: yaw, pitch: pitch },
      to:   { x: to.x,   y: to.y,   scale: to.scale, yaw: toYaw, pitch: toPitch },
      hasAngle: hasAngle,
      t0:   now(),
      dur:  d,
      cb:   cb || null
    };
    ensureTicking();
  }

  function cancelAnim() {
    anim = null;
    orbitAnim = null;
    stopSelfTick();
  }

  /** 推进镜头插值。返回 true 表示本帧仍在动画中。
      由 map-engine 的主循环调用（或降级态下由本模块自己的临时 rAF 调用）。 */
  function update(t) {
    if (orbitAvailable()) return updateOrbit(t);
    orbitLastTime = 0;
    if (!anim) { return false; }
    var p = (t - anim.t0) / anim.dur;
    if (p < 0) { p = 0; }
    if (p > 1) { p = 1; }

    var e = Engine.easeCamera(p);          /* easeInOutCubic */
    view.x     = anim.from.x     + (anim.to.x     - anim.from.x)     * e;
    view.y     = anim.from.y     + (anim.to.y     - anim.from.y)     * e;
    view.scale = anim.from.scale + (anim.to.scale - anim.from.scale) * e;
    if (anim.hasAngle) {
      yaw   = anim.from.yaw   + (anim.to.yaw   - anim.from.yaw)   * e;
      pitch = anim.from.pitch + (anim.to.pitch - anim.from.pitch) * e;
      pushAngles();
    }

    clampView();
    emit();

    if (p >= 1) {
      var cb = anim.cb;
      anim = null;
      stopSelfTick();
      if (typeof cb === "function") { cb(); }
      return false;
    }
    return true;
  }

  /* 降级态：主循环没在跑，镜头自己起一个临时 rAF，动画结束即停，
     绝不留下常驻循环（契约 §2.2 / 05 §10.2）。 */
  function ensureTicking() {
    if (Engine.isRunning() || selfTick) { return; }
    (function step(t) {
      var more = update(t);
      Engine.renderStatic();
      selfTick = more ? window.requestAnimationFrame(step) : 0;
    })(now());
  }

  function stopSelfTick() {
    if (selfTick) {
      window.cancelAnimationFrame(selfTick);
      selfTick = 0;
    }
  }

  /* ────────────────────────────────────────────────────────────────────────
     聚焦 / 回到全景
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * 聚焦到世界坐标 (wx, wy)。
   * 桌面端覆盖层占据右侧 --overlay-w 宽，因此把地标推到**可见地图区**的中心，
   * 而不是视口中心 —— 否则地标会被覆盖层盖住（PRD M-08 要求两者同时可见）。
   */
  function focusTo(wx, wy, scale, cb, ground) {
    overviewLocked = false;
    var s1 = clampScale(scale || focusScale);
    var off = (typeof focusOffsetFn === "function") ? focusOffsetFn() : { x: 0, y: 0 };
    if (ground && orbitAvailable()) {
      var z = Engine.veOf(Engine.terrainHeightAt(ground.x, ground.y));
      startOrbit({ x: ground.x, y: ground.y, z: z, offsetX: off.x || 0, offsetY: off.y || 0, scale: s1, pitch: 45, followTerrain: true }, cb);
      return;
    }
    startAnim({
      x: wx - (off.x || 0) / s1,
      y: wy - (off.y || 0) / s1,
      scale: s1
    }, cb);
  }

  /** 回到全景（docs/10 §6）——
      必须**同时**复位三件事：yaw → 初始方位角、pitch → 52°、缩放 → extent 拟合值。
      拟合机位要在**目标视角下**算（§3.5：旋转会显著改变包围盒），
      因此先临时切到目标角度取机位，再把它作为动画终点。
      无地形时退回地图平面中心 scale 1。 */
  function reset(cb) {
    if (orbit && orbitAvailable()) {
      overviewLocked = true;
      startOrbit({ x: orbitHome.x, y: orbitHome.y, z: 0, offsetX: 0, offsetY: 0, scale: orbitHome.scale, pitch: orbitHome.pitch }, cb);
      return;
    }
    var y0 = yaw, p0 = pitch;
    yaw = YAW_HOME; pitch = PITCH_HOME;
    pushAngles();
    var v = overviewView();
    yaw = y0; pitch = p0;
    pushAngles();
    startAnim({ x: v.x, y: v.y, scale: v.scale, yaw: YAW_HOME, pitch: PITCH_HOME }, cb);
    overviewLocked = true;
  }

  function isAnimating() { return !!anim || !!orbitAnim; }

  /* ────────────────────────────────────────────────────────────────────────
     查询 / 依赖注入
     ──────────────────────────────────────────────────────────────────────── */

  function getView() { return view; }
  function getScale() { return view.scale; }

  function setFocusOffsetProvider(fn) { focusOffsetFn = fn; }
  function setPointsProvider(fn) { pointsFn = fn; }

  Scene._.Camera = {
    init:                   init,
    onResize:               onResize,
    getView:                getView,
    getScale:               getScale,
    /* —— v2.1 三维视角（docs/10 §6，纯增量）—— */
    rotateBy:               rotateBy,      /* 拖拽 = 旋转 */
    setAngles:              setAngles,
    getAngles:              getAngles,
    panBy:                  panBy,
    zoomAt:                 zoomAt,
    zoomBy:                 zoomBy,
    canZoomIn:              canZoomIn,
    canZoomOut:             canZoomOut,
    focusTo:                focusTo,
    reset:                  reset,
    fitToExtent:            fitToExtent,
    overviewView:           overviewView,
    invalidateBounds:       invalidateBounds,
    update:                 update,
    isAnimating:            isAnimating,
    cancelAnim:             cancelAnim,
    clampView:              clampView,
    clampScale:             clampScale,
    setFocusOffsetProvider: setFocusOffsetProvider,
    setPointsProvider:      setPointsProvider,
    getLimits:              function () { return { min: effectiveMinScale(), max: maxScale, focus: focusScale }; },
    getOrbitState: function () { return { active: !!orbit, pivot: orbit ? { x: orbit.x, y: orbit.y, z: orbit.z } : null, target: orbitAnim ? Object.assign({}, orbitAnim.target) : null, offset: orbit ? [orbit.offsetX, orbit.offsetY] : [0, 0], tauMs: window.CameraMotion ? window.CameraMotion.tauMs : null, rotationRadiansPerMs: window.CameraMotion ? window.CameraMotion.radiansPerMs : null }; }
  };
})();
