/* ============================================================================
   landmarks.js —— 地标配置解析、坐标转换、命中检测
   ----------------------------------------------------------------------------
   职责（契约 §1）：「地标配置解析与命中检测」

   ⚠️ 关于全局变量（契约 §2.1）：
     契约规定全站只允许暴露 SITE_DATA / WORKS_DATA / NOTES_DATA / Scene /
     ContentModule 五个全局变量。因此本文件**不新增任何全局变量**，
     而是把内部模块挂在 window.Scene 的 `_` 子对象上，作为四个文件之间
     唯一的私有通信点。window.Scene 的**公开 API** 由 app.js 在最后填充
     （契约 §2.2），本文件只写入 `_` 下的私有成员。

   ⚠️ 关于坐标（PRD §4.4.2 / 05 §5.6）：
     数据中的 position 是 0–1 归一化坐标，与视口尺寸解耦。
     落位公式：worldX = x × MAP_W，其中 MAP_W = viewportWidth × 1.30。
   ============================================================================ */

(function () {
  "use strict";

  if (!window.Scene) { window.Scene = {}; }
  var Scene = window.Scene;
  if (!Scene._) { Scene._ = {}; }

  /* ────────────────────────────────────────────────────────────────────────
     地标类型元数据
     ------------------------------------------------------------------------
     坐标裁定值来自 05 §5.6（A/D/E 为 PRD 给定，B/C 为规范裁定）。
     `metaphor` 字段决定该地标在地图上的图形语言（PRD §4.4.2 / 05 §5.4）：
       contour → 等高线簇   wave → 脉冲点阵   sector → 扇形射线
       cross   → 十字交点   tally → 三道刻痕（中性墨色）
     artToken / hitToken 指向 tokens.css 中的尺寸变量，避免在 JS 里写像素值。
     ──────────────────────────────────────────────────────────────────────── */

  var MARK_META = {
    space:  { artToken: "--mark-art-space",  hitToken: "--mark-hit-abc", shape: "contour"  },
    light:  { artToken: "--mark-art-light",  hitToken: "--mark-hit-abc", shape: "aperture" },
    rhythm: { artToken: "--mark-art-rhythm", hitToken: "--mark-hit-abc", shape: "wave"     },
    taste:  { artToken: "--mark-art-taste",  hitToken: "--mark-hit-abc", shape: "swirl"    },
    field:  { artToken: "--mark-art-field",  hitToken: "--mark-hit-abc", shape: "sector"   },
    about:  { artToken: "--mark-art-about",  hitToken: "--mark-hit-de",  shape: "cross"    },
    notes:  { artToken: "--mark-art-notes",  hitToken: "--mark-hit-de",  shape: "tally"    }
  };

  /* `metaphor`（数据字段）→ `shape`（图形语言），二者一一对应。
     数据里写的是隐喻名，绘制时用的是图形名。
     v2.0 的 5 种图形语言（docs/08 C-8）：contour / aperture / wave / swirl / sector */
  var METAPHOR_TO_SHAPE = {
    contour:  "contour",
    aperture: "aperture",
    wave:     "wave",
    swirl:    "swirl",
    sector:   "sector"
  };

  var list = [];        /* 解析后的地标列表，顺序即语义顺序 A→B→C→D→E */
  var byId = {};
  var mapW = 0, mapH = 0;

  /* ────────────────────────────────────────────────────────────────────────
     解析 SITE_DATA
     ------------------------------------------------------------------------
     数据来源（契约 §4.1：字段定义以 PRD §4.4.2 为唯一依据）：
       site.fields[]        三个场（A/B/C）
       site.notesLandmark   E 印记
       site.aboutLandmark   D 关于
     ⚠️ 不假设任何 PRD 未定义的字段存在：`subtitle` / `nameEn` 缺失时
        对应元素整体不渲染（P-4：表现层零硬编码文案，不自行编造内容）。
     ──────────────────────────────────────────────────────────────────────── */

  function pickPos(o, fallbackX, fallbackY) {
    var p = (o && o.position) || {};
    var x = (typeof p.x === "number" && isFinite(p.x)) ? p.x : fallbackX;
    var y = (typeof p.y === "number" && isFinite(p.y)) ? p.y : fallbackY;
    return { x: clamp01(x), y: clamp01(y) };
  }

  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  function str(v) { return (typeof v === "string") ? v : ""; }

  /**
   * 解析站点数据中的地标定义。
   * @param {Object} site - window.SITE_DATA
   * @returns {Array} 地标描述对象数组
   */
  function parse(site) {
    list = [];
    byId = {};

    var fields = (site && site.fields) || [];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i] || {};
      var id = str(f.id);
      if (!id) { continue; }
      var meta = MARK_META[id] || MARK_META.about;
      var pos = pickPos(f, 0.5, 0.5);
      add({
        id:          id,
        kind:        "field",                       /* 五个场：有识别色 */
        badge:       str(f.landmark),
        name:        str(f.name) || id,
        nameEn:      str(f.nameEn),
        subtitle:    str(f.subtitle),
        intro:       str(f.intro),
        gx:          pos.x,                         /* 地面坐标（归一化，投影前） */
        gy:          pos.y,
        shape:       METAPHOR_TO_SHAPE[str(f.metaphor)] || meta.shape,
        artToken:    meta.artToken,
        hitToken:    meta.hitToken,
        /* 识别色由 site.data.js 提供（05 §2.4 唯一允许的注入方式：
           只覆盖单个变量，不覆盖整个色阶） */
        color:       str(f.color),
        colorLight:  str(f.colorLight),
        colorDark:   str(f.colorDark)
      });
    }

    /* D 关于 —— 坐标原点，"三重身份的交点" */
    var about = (site && site.aboutLandmark) || {};
    if (about && (about.landmark || about.name)) {
      var aPos = pickPos(about, 0.5, 0.5);
      add({
        id: "about", kind: "neutral",
        badge: str(about.landmark),
        name: str(about.name) || str((site && site.about && site.about.title) || ""),
        nameEn: str(about.nameEn),
        subtitle: str(about.subtitle),
        intro: str(about.intro),
        gx: aPos.x, gy: aPos.y,
        shape: MARK_META.about.shape,
        artToken: MARK_META.about.artToken,
        hitToken: MARK_META.about.hitToken
      });
    }

    /* E 印记 —— 全站碎片笔记聚合流 */
    var notes = (site && site.notesLandmark) || {};
    if (notes && (notes.landmark || notes.name)) {
      var nPos = pickPos(notes, 0.68, 0.72);
      add({
        id: "notes", kind: "neutral",
        badge: str(notes.landmark),
        name: str(notes.name) || "",
        nameEn: str(notes.nameEn),
        subtitle: str(notes.subtitle),
        intro: str(notes.intro),
        gx: nPos.x, gy: nPos.y,
        shape: MARK_META.notes.shape,
        artToken: MARK_META.notes.artToken,
        hitToken: MARK_META.notes.hitToken
      });
    }

    return list;
  }

  /* ────────────────────────────────────────────────────────────────────────
     地标必须落在**地形表面上**（风险 R-8）
     ------------------------------------------------------------------------
     v2.0 的地形做了 2.5D 轴测投影：等高线按各自层级 z 做了垂直偏移。
     地标若仍用地面坐标，就会浮在山头下方，点击热区也随之错位。

     做法：地标的 nx / ny **不存值，而是取函数** ——
       nx/ny = MapEngine.projectGround(gx, gy)        // = projectNorm(gx, gy, h·VE)
     即与地形**完全同一套投影函数**，而不是「各算各的」。

     为什么用 getter 而不是在 parse 时算一次：地形高度取决于内容量，
     而 layoutLandmarks() 会在每次窗口尺寸变化时重读 nx/ny；用 getter
     就能保证任何时候读到的都是当前高度场下的正确位置，且 app.js 无需改动。

     约定不变：nx/ny 仍是 [0,1] 量纲的归一化坐标，app.js 依旧
     `worldX = nx × MAP_W`，因此世界坐标与镜头坐标系完全一致。
     ──────────────────────────────────────────────────────────────────────── */

  function projectedOf(gx, gy) {
    var E = Scene._.MapEngine;
    if (!E || typeof E.projectNorm !== "function") { return { x: gx, y: gy }; }
    /* ⚠️ v2.1：走 projectGround（z 取地表高度 **并乘垂直夸张 VE**）。
       投影公式的 z 是「世界高度」，而 terrainHeightAt 返回的是地形高度 h；
       两者差一个 VE。若这里直接传 h，地标会比地形**多抬 1/VE 倍**（≈1.8×），
       在 pitch 低时能明显看出地标浮在山头上方 —— 正是风险 R-8 描述的错位。 */
    try {
      if (typeof E.projectGround === "function") { return E.projectGround(gx, gy); }
      var z = (typeof E.terrainHeightAt === "function") ? E.terrainHeightAt(gx, gy) : 0;
      return E.projectNorm(gx, gy, z);
    } catch (e) {
      return { x: gx, y: gy };
    }
  }

  function add(lm) {
    var gx = lm.gx, gy = lm.gy;
    lm.ground = { x: gx, y: gy };
    delete lm.gx; delete lm.gy;

    Object.defineProperty(lm, "nx", {
      enumerable: true, configurable: true,
      get: function () { return projectedOf(gx, gy).x; }
    });
    Object.defineProperty(lm, "ny", {
      enumerable: true, configurable: true,
      get: function () { return projectedOf(gx, gy).y; }
    });

    list.push(lm);
    byId[lm.id] = lm;
  }

  /* ────────────────────────────────────────────────────────────────────────
     尺寸 / 视口
     ──────────────────────────────────────────────────────────────────────── */

  function setMapSize(w, h) { mapW = w; mapH = h; }
  function getMapSize() { return { w: mapW, h: mapH }; }

  /* ────────────────────────────────────────────────────────────────────────
     坐标转换（归一化 0–1 ↔ 世界坐标 ↔ 屏幕像素）
     ------------------------------------------------------------------------
     屏幕坐标推导（与 camera.js 写入 #map-world 的 transform 必须严格一致）：
       #map-world 的 transform = translate(-view.x*scale + vw/2, …) scale(scale)
       ⇒ screen = (world − view.x) × scale + vw/2
     再叠加 L2 视差层的位移（地标 DOM 位于视差层内）与拖拽引导位移。
     ──────────────────────────────────────────────────────────────────────── */

  /** 归一化 → 世界坐标 */
  function normToWorld(nx, ny) {
    return { x: nx * mapW, y: ny * mapH };
  }

  /** 世界坐标 → 屏幕像素 */
  function worldToScreen(wx, wy, view, vp, offset) {
    var ox = offset ? offset.x : 0;
    var oy = offset ? offset.y : 0;
    return {
      x: (wx - view.x) * view.scale + vp.w / 2 + ox,
      y: (wy - view.y) * view.scale + vp.h / 2 + oy
    };
  }

  /** 屏幕像素 → 世界坐标 */
  function screenToWorld(sx, sy, view, vp, offset) {
    var ox = offset ? offset.x : 0;
    var oy = offset ? offset.y : 0;
    return {
      x: (sx - ox - vp.w / 2) / view.scale + view.x,
      y: (sy - oy - vp.h / 2) / view.scale + view.y
    };
  }

  /** 归一化 → 屏幕像素（地标布局的常用路径） */
  function normToScreen(nx, ny, view, vp, offset) {
    return worldToScreen(nx * mapW, ny * mapH, view, vp, offset);
  }

  /** 屏幕像素 → 归一化（用于把鼠标位置换算回地图坐标） */
  function screenToNorm(sx, sy, view, vp, offset) {
    var w = screenToWorld(sx, sy, view, vp, offset);
    return { x: mapW ? w.x / mapW : 0, y: mapH ? w.y / mapH : 0 };
  }

  /* ────────────────────────────────────────────────────────────────────────
     命中检测
     ------------------------------------------------------------------------
     热区是一个**正方形**（宽高 = 该地标的 --mark-hit-* 变量），
     以地标坐标为中心；与 05 §5.4「命中区域（热区）」表一致。
     这里刻意用几何命中而非 DOM 事件，原因：
       ① 视差层移动时 DOM 与几何位置一致，但契约要求 landmarks.js
          提供命中检测，镜头/拖拽判定都走这条路径，保证唯一真相；
       ② 便于在拖拽阈值判定中区分「点在地标上」与「点在空白处」。
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * @param {number} clientX
   * @param {number} clientY
   * @param {Object} ctx { view, vp:{w,h}, offset:{x,y}, sizes:{} }
   * @returns {Object|null} 命中的地标；多个命中时返回最上层（列表靠后者）
   */
  function hitTest(clientX, clientY, ctx) {
    if (!ctx || !ctx.view || !ctx.vp) { return null; }
    for (var i = list.length - 1; i >= 0; i--) {
      var lm = list[i];
      var s = normToScreen(lm.nx, lm.ny, ctx.view, ctx.vp, ctx.offset);
      var hit = (ctx.sizes && ctx.sizes[lm.id] && ctx.sizes[lm.id].hit) || 0;
      var half = hit / 2;
      /* 命中框至少 44×44（WCAG 2.5.5 / 05 §8.2 规则 3） */
      if (half < 22) { half = 22; }
      if (Math.abs(clientX - s.x) <= half && Math.abs(clientY - s.y) <= half) {
        return lm;
      }
    }
    return null;
  }

  /* ────────────────────────────────────────────────────────────────────────
     查询
     ──────────────────────────────────────────────────────────────────────── */

  function get(id) { return byId[id] || null; }
  function all() { return list; }
  function ids() { return list.map(function (l) { return l.id; }); }
  function has(id) { return Object.prototype.hasOwnProperty.call(byId, id); }

  /** 全部地标在世界坐标下的包围盒（供相机做边界约束用） */
  function worldBounds() {
    if (!list.length) { return null; }
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var w = normToWorld(list[i].nx, list[i].ny);
      if (w.x < x0) { x0 = w.x; }
      if (w.y < y0) { y0 = w.y; }
      if (w.x > x1) { x1 = w.x; }
      if (w.y > y1) { y1 = w.y; }
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1,
             cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }

  Scene._.Landmarks = {
    MARK_META:      MARK_META,
    parse:          parse,
    get:            get,
    all:            all,
    ids:            ids,
    has:            has,
    setMapSize:     setMapSize,
    getMapSize:     getMapSize,
    normToWorld:    normToWorld,
    worldToScreen:  worldToScreen,
    screenToWorld:  screenToWorld,
    normToScreen:   normToScreen,
    screenToNorm:   screenToNorm,
    hitTest:        hitTest,
    worldBounds:    worldBounds
  };
})();
