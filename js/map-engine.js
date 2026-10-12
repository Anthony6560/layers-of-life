/* ============================================================================
   map-engine.js —— Canvas 绘制：内容驱动的地形（高度场 → 等高线）+ 2.5D 轴测
   ----------------------------------------------------------------------------
   v2.0 重写（docs/08 §4 是唯一依据）。职责（契约 §1）：
     「Canvas 绘制：等高线、地标图形语言、分层视差」

   与 v1 的根本差别：
     v1：手绘等高线图案（4 个固定种子 + 正弦扰动），与内容无关。
     v2：**内容驱动的高度场**（js/terrain.js）→ marching squares 预计算等高线
         → 预计算阴影循环 → 2.5D 轴测投影 → painter's algorithm 绘制。
         内容越多的地方山越高、等高线越密（docs/08 §4.7）。

   关键设计：
     ① 高度场与等高线**只算一次**（脏标记缓存），平移/缩放一律复用 —— 风险 R-7；
        几何缓存在**世界坐标**里，与镜头无关，因此缩放不触发重算（严格强于
        「缩放跨档时重算」的最低要求）。
     ② 地标与地形走**同一个投影函数**（projectNorm）—— 风险 R-8。
     ③ 等高线线宽随局部梯度衰减，密集区不糊成一片 —— 风险 R-9。
     ④ 全部参数与颜色从 tokens.css / SITE_DATA.terrain 读取，JS 内零硬编码色值。
     ⑤ 5 个地标图形语言（docs/08 §一 C-8）：contour / aperture / wave / swirl / sector。
   ============================================================================ */

(function installMapEngine() {
  "use strict";

  if (!window.Scene) { window.Scene = {}; }
  var Scene = window.Scene;
  if (!Scene._) { Scene._ = {}; }

  /* ══════════════════════════════════════════════════════════════════════════
     令牌读取器 —— 让 Canvas 能用上 CSS 里的设计变量
     ══════════════════════════════════════════════════════════════════════════ */

  function hexToRgb(hex) {
    if (!hex) { return null; }
    var h = String(hex).trim();
    if (h.charAt(0) === "#") { h = h.slice(1); }
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    if (h.length !== 6) { return null; }
    var n = parseInt(h, 16);
    if (isNaN(n)) { return null; }
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgba(c, a) {
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + Math.max(0, Math.min(1, a)).toFixed(3) + ")";
  }

  /** 解析 "cubic-bezier(.65, 0, .35, 1)" → [x1,y1,x2,y2] */
  function parseBezier(str) {
    var m = /cubic-bezier\(([^)]+)\)/.exec(String(str || ""));
    if (!m) { return [0, 0, 1, 1]; }
    var p = m[1].split(",");
    var out = [parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]), parseFloat(p[3])];
    for (var i = 0; i < 4; i++) {
      if (!isFinite(out[i])) { return [0, 0, 1, 1]; }
    }
    return out;
  }

  var cached = null;

  /** 两色线性混合（t = 0 → a，t = 1 → b）。地层板填充色用它现算。 */
  function mixRgb(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ];
  }

  /** 读取全部绘制所需的设计变量。颜色缺失时返回 null（调用方跳过该绘制）。 */
  function readTokens() {
    var cs = window.getComputedStyle(document.documentElement);

    function raw(name) {
      var v = cs.getPropertyValue(name);
      return v ? String(v).trim() : "";
    }
    function num(name, fallback) {
      var x = parseFloat(raw(name));
      return isFinite(x) ? x : fallback;
    }
    function color(name) { return hexToRgb(raw(name)); }

    var tk = {
      /* ---- 纸 ---- */
      paper1:            color("--color-paper-1"),
      paper4:            color("--color-paper-4"),

      /* ---- 等高线（05 §5.1；v2.0 由高度场驱动，仅线宽/透明度仍取令牌）---- */
      contourColor:      color("--contour-color"),
      contourWidth:      num("--contour-width", 1.4),
      contourWidthIndex: num("--contour-width-index", 2.2),
      contourOpacity:    num("--contour-opacity", 0.40),
      contourOpacityIdx: num("--contour-opacity-index", 0.66),

      /* ---- 远景低起伏等高线 ---- */
      ambientContourColor:      color("--ambient-contour-color"),
      ambientContourWidth:      num("--ambient-contour-width", 0.85),
      ambientContourWidthIndex: num("--ambient-contour-width-index", 1.25),
      ambientContourOpacity:    num("--ambient-contour-opacity", 0.22),
      ambientContourOpacityIdx: num("--ambient-contour-opacity-index", 0.34),

      /* ---- 地层板（docs/10 §4.4 / §4.5）----
         ⚠️ 修正记录：初版是「纸色向 --color-ink-4 混 8%」。
         实测混出来是 #E4E9D8，而纸底是 #EFF3E3 —— 每通道只差 11，
         对比度约 1.09:1。再乘上每层 0.025~0.041 的透明度，
         实际色差只有 0.3/255 —— **地层板等于没画**（用户反馈「阴影没出来」）。
         现改为向 --color-ink-3 混 30%，得到明显深于纸底的层色。
         混色按令牌现算，**不硬编码任何色值**。 */
      ink3:              color("--color-ink-3"),
      plateMix:          0.30,

      /* ---- 半透明晕渲地形曲面（docs/10 §4，v2.4）----
         取代了 v2.3 的地层板：曲面从任何角度都有体积，而水平板在低俯仰角下
         投影面积趋零、地形会「消失」。颜色仍然全部走令牌，不硬编码。 */
      surfaceColor:      color("--terrain-surface"),
      surfaceShadeDark:  color("--terrain-surface-shade-dark"),
      surfaceShadeLight: color("--terrain-surface-shade-light"),
      surfaceAlpha:      num("--terrain-surface-alpha", 0.86),
      surfaceAlphaTop:   num("--terrain-surface-alpha-top", 0.94),
      surfaceGrid:       Math.max(8, Math.round(num("--terrain-surface-grid", 160))),
      surfaceFadeStart:  num("--terrain-surface-fade-start", 0.006),
      surfaceFadeEnd:    num("--terrain-surface-fade-end", 0.09),
      castShadowStrength:num("--terrain-cast-shadow-strength", 0.34),
      lightContrast:     num("--terrain-light-contrast", 1.20),
      slopeDarkOpacity:  num("--terrain-slope-dark-opacity", 0.20),
      slopeLightOpacity: num("--terrain-slope-light-opacity", 0.08),
      /* 合成模糊半径。曲面是逐格平面着色，不加模糊会有肉眼可见的方格（见 drawSurface）。 */
      surfaceBlur:       num("--terrain-surface-blur", 8),

      ambientSurfaceColor:      color("--ambient-surface"),
      ambientSurfaceLow:        color("--ambient-surface-low"),
      ambientSurfaceHigh:       color("--ambient-surface-high"),
      ambientSurfaceShadeDark:  color("--ambient-surface-shade-dark"),
      ambientSurfaceShadeLight: color("--ambient-surface-shade-light"),
      ambientSurfaceAlpha:      num("--ambient-surface-alpha", 0.68),
      ambientSurfaceAlphaTop:   num("--ambient-surface-alpha-top", 0.82),
      ambientSurfaceGrid:       Math.max(8, Math.round(num("--ambient-surface-grid", 160))),
      ambientSurfaceBlur:       num("--ambient-surface-blur", 10),

      /* ---- 山体阴影（docs/08 §4.5）已停用 ---- */

      /* ---- 经纬网格（05 §5.2）---- */
      gridStep:          num("--grid-minor-step", 64),
      gridMajorEvery:    num("--grid-major-every", 4),
      gridMinorWidth:    num("--grid-minor-width", 0.75),
      gridMajorWidth:    num("--grid-major-width", 1),
      gridMinorColor:    color("--grid-minor-color"),
      gridMajorColor:    color("--grid-major-color"),
      gridMinorOpacity:  num("--grid-minor-opacity", 0.30),
      gridMajorOpacity:  num("--grid-major-opacity", 0.50),
      gridHideBelow:     num("--grid-minor-hide-below", 24),
      gridNodeSize:      num("--grid-node-size", 2),
      gridNodeOpacity:   num("--grid-node-opacity", 0.35),
      gridDimOpacity:    num("--grid-dim-opacity", 0.12),

      /* ---- 视差（05 §7.4）---- */
      parallaxL1:        num("--parallax-l1", 6),
      parallaxL2:        num("--parallax-l2", 14),
      parallaxLerp:      num("--parallax-lerp", 0.08),

      /* ---- 镜头 ---- */
      scaleMin:          num("--scale-min", 0.6),
      scaleMax:          num("--scale-max", 2.5),
      scaleFocus:        num("--scale-focus", 1.6),
      mapOverscan:       num("--map-overscan", 1.30),

      /* ---- 时序与缓动（契约 §6 / 05 §7.1）---- */
      durCamera:         num("--dur-camera", 600),
      durDragHint:       num("--dur-drag-hint", 2400),
      dragHintDelay:     num("--drag-hint-delay", 2500),
      easeCamera:        parseBezier(raw("--ease-camera")),

      /* ---- 地标尺寸（05 §5.4 尺寸汇总表；v2.0 补齐 5 个场）---- */
      markArt: {
        space:  num("--mark-art-space", 88),
        light:  num("--mark-art-light", 88),
        rhythm: num("--mark-art-rhythm", 92),
        taste:  num("--mark-art-taste", 88),
        field:  num("--mark-art-field", 96),
        about:  num("--mark-art-about", 48),
        notes:  num("--mark-art-notes", 40)
      },
      markHit: {
        space:  num("--mark-hit-abc", 104),
        light:  num("--mark-hit-abc", 104),
        rhythm: num("--mark-hit-abc", 104),
        taste:  num("--mark-hit-abc", 104),
        field:  num("--mark-hit-abc", 104),
        about:  num("--mark-hit-de", 64),
        notes:  num("--mark-hit-de", 64)
      }
    };

    return tk;
  }

  function tokens() {
    if (!cached) { cached = readTokens(); }
    return cached;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     地标图形语言（05 §5.4 的三种 + v2.0 新增的两种，共 5 种）
     颜色统一用 currentColor 由 CSS 注入（.m-landmark{color:var(--fc)}）。
     ══════════════════════════════════════════════════════════════════════════ */

  var gradSeq = 0;

  /* ① 空间 SPACE —— 等高线簇：4 条嵌套不规则闭合曲线 + 1 条断层线 */
  function markSpace() {
    var rings = [
      { r: 44,    w: 1.6, o: 0.85 },
      { r: 33,    w: 1,   o: 0.65 },
      { r: 24.75, w: 1,   o: 0.50 },
      { r: 18.5,  w: 1,   o: 0.38 }
    ];
    var out = "";
    for (var k = 0; k < rings.length; k++) {
      var ring = rings[k];
      var phi = k * 1.7;
      var N = 90;
      var d = "";
      for (var i = 0; i <= N; i++) {
        var th = i / N * Math.PI * 2;
        var r = ring.r * (1 + 0.13 * Math.sin(3 * th + phi) + 0.07 * Math.sin(5 * th));
        d += (i ? "L" : "M") + (50 + r * Math.cos(th)).toFixed(2) + " " +
             (50 + r * Math.sin(th)).toFixed(2);
      }
      out += '<path d="' + d + 'Z" fill="none" stroke="currentColor" stroke-width="' +
             ring.w + '" opacity="' + ring.o + '"/>';
    }
    out += '<line x1="10" y1="84" x2="90" y2="24" ' +
           'style="stroke:var(--color-paper-1)" stroke-width="4" ' +
           'stroke-dasharray="4 5" opacity=".92"/>';
    return out;
  }

  /* ② 光影 LIGHT —— 光圈叶片 + 取景框（v2.0 新增）
        6 片叶片围出中央六边形光孔，外面是镜头圈，四角是取景框的直角括号。
        与「空间」的嵌套闭合曲线差异极大（docs/08 R-11：两者必须一眼分得开）。 */
  function markAperture() {
    var cx = 50, cy = 50;
    var out = "";
    var i, k;

    /* 镜头外圈 + 内圈（双线，像镜筒） */
    out += '<circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" ' +
           'stroke-width="1" opacity=".28"/>';
    out += '<circle cx="50" cy="50" r="34" fill="none" stroke="currentColor" ' +
           'stroke-width="1.4" opacity=".70"/>';

    /* 6 片叶片：内六边形顶点 → 外圈上偏转 56° 的对应点 */
    var rin = 14, rout = 34, skew = 56 * Math.PI / 180;
    var hex = "";
    for (k = 0; k < 6; k++) {
      var a = k * Math.PI / 3;
      var hx = cx + rin * Math.cos(a), hy = cy + rin * Math.sin(a);
      var ox = cx + rout * Math.cos(a + skew), oy = cy + rout * Math.sin(a + skew);
      hex += '<line x1="' + hx.toFixed(2) + '" y1="' + hy.toFixed(2) +
             '" x2="' + ox.toFixed(2) + '" y2="' + oy.toFixed(2) +
             '" stroke="currentColor" stroke-width="1" opacity=".62"/>';
    }
    /* 中央六边形光孔 */
    var poly = "";
    for (k = 0; k < 6; k++) {
      var b = k * Math.PI / 3;
      poly += (k ? "L" : "M") + (cx + rin * Math.cos(b)).toFixed(2) + " " +
              (cy + rin * Math.sin(b)).toFixed(2);
    }
    out += '<path d="' + poly + 'Z" fill="none" stroke="currentColor" ' +
           'stroke-width="1.2" opacity=".85"/>';
    out += hex;

    /* 取景框：四角直角括号 */
    var m = 6, len = 12;
    var corners = [[m, m, 1, 1], [100 - m, m, -1, 1], [m, 100 - m, 1, -1], [100 - m, 100 - m, -1, -1]];
    for (i = 0; i < corners.length; i++) {
      var c = corners[i];
      out += '<path d="M ' + c[0] + " " + (c[1] + c[3] * len) + " L " + c[0] + " " + c[1] +
             " L " + (c[0] + c[2] * len) + " " + c[1] + '" fill="none" ' +
             'stroke="currentColor" stroke-width="1.2" opacity=".55"/>';
    }
    /* 中心对焦点 */
    out += '<circle cx="50" cy="50" r="2" fill="currentColor" opacity=".8"/>';
    return out;
  }

  /* ③ 节奏 RHYTHM —— 脉冲点阵：5×5 点 + 2 道虚线脉冲弧 */
  function markRhythm() {
    var out = "";
    out += '<circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" ' +
           'stroke-width="1" stroke-dasharray="2 5" opacity=".30"/>';
    out += '<circle cx="50" cy="50" r="46" fill="none" stroke="currentColor" ' +
           'stroke-width="1" stroke-dasharray="2 5" opacity=".18"/>';
    var gap = 11;
    for (var i = 0; i < 5; i++) {
      for (var j = 0; j < 5; j++) {
        var d = Math.max(Math.abs(i - 2), Math.abs(j - 2));
        var isCorner = Math.abs(i - 2) === 2 && Math.abs(j - 2) === 2;
        var r, o;
        if (d === 0)      { r = 2.6; o = 1; }
        else if (d === 1) { r = 2.0; o = 0.55; }
        else              { r = isCorner ? 2.0 : 1.6; o = isCorner ? 0.40 : 0.26; }
        out += '<circle cx="' + (50 + (i - 2) * gap) + '" cy="' + (50 + (j - 2) * gap) +
               '" r="' + r + '" fill="currentColor" opacity="' + o + '"/>';
      }
    }
    return out;
  }

  /* ④ 味道 TASTE —— 香气涡旋（v2.0 新增）
        两条反向的对数螺旋 + 三粒"香气"。螺旋是连续的曲线，
        与点阵/扇形/光圈的构成差异足够大。 */
  function markSwirl() {
    var out = "";
    var i, s;
    for (s = 0; s < 2; s++) {
      var phi = s * Math.PI;
      var dir = s ? -1 : 1;
      var d = "";
      var N = 84;
      for (i = 0; i <= N; i++) {
        var t = i / N;
        var th = dir * t * 3.6 * Math.PI + phi;
        var rr = 5 + t * 36;
        d += (i ? "L" : "M") + (50 + rr * Math.cos(th)).toFixed(2) + " " +
             (50 + rr * Math.sin(th)).toFixed(2);
      }
      out += '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="' +
             (s ? 0.9 : 1.4) + '" opacity="' + (s ? 0.30 : 0.72) + '"/>';
    }
    /* 三粒"气味"：越往上越小越淡（docs/09 §二） */
    out += '<circle cx="50" cy="58" r="3.2" fill="currentColor" opacity=".80"/>';
    out += '<circle cx="43" cy="42" r="2.2" fill="currentColor" opacity=".52"/>';
    out += '<circle cx="57" cy="28" r="1.5" fill="currentColor" opacity=".30"/>';
    return out;
  }

  /* ⑤ 场 FIELD —— 扇形射线：1 个原点 + 7 条等角射线 + 2 道弧 */
  function markField(rotateDeg) {
    var ox = 50, oy = 50, len = 44;
    var gid = "m-grad-sector-" + (++gradSeq);
    var out = '<defs><radialGradient id="' + gid + '" cx="' + ox + '" cy="' + oy +
              '" r="' + len + '" gradientUnits="userSpaceOnUse">' +
              '<stop offset="0" stop-color="currentColor" stop-opacity=".85"/>' +
              '<stop offset="1" stop-color="currentColor" stop-opacity=".25"/>' +
              '</radialGradient></defs>';

    for (var k = 0; k < 7; k++) {
      var a = (-45 + k * 15) * Math.PI / 180;
      out += '<line x1="' + ox + '" y1="' + oy +
             '" x2="' + (ox + len * Math.cos(a)).toFixed(2) +
             '" y2="' + (oy + len * Math.sin(a)).toFixed(2) +
             '" stroke="url(#' + gid + ')" stroke-width="1"/>';
    }
    out += sectorArc(ox, oy, 28, 0.8, 0.30);
    out += sectorArc(ox, oy, 44, 1.2, 0.55);
    out += '<circle cx="' + ox + '" cy="' + oy + '" r="2.5" fill="currentColor"/>';
    return '<g transform="rotate(' + rotateDeg + ' ' + ox + ' ' + oy + ')">' + out + '</g>';
  }

  function sectorArc(ox, oy, rad, w, o) {
    function pt(deg) {
      return (ox + rad * Math.cos(deg * Math.PI / 180)).toFixed(2) + " " +
             (oy + rad * Math.sin(deg * Math.PI / 180)).toFixed(2);
    }
    return '<path d="M ' + pt(-45) + ' A ' + rad + ' ' + rad + ' 0 0 1 ' + pt(45) + '" ' +
           'fill="none" stroke="currentColor" stroke-width="' + w + '" opacity="' + o + '"/>';
  }

  /* ⑥ 关于 ABOUT —— 十字 + 中心空心小圆（中性墨色） */
  function markAbout() {
    return '<line x1="30" y1="50" x2="70" y2="50" stroke="currentColor" stroke-width="1" opacity=".7"/>' +
           '<line x1="50" y1="30" x2="50" y2="70" stroke="currentColor" stroke-width="1" opacity=".7"/>' +
           '<circle cx="50" cy="50" r="6" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".85"/>';
  }

  /* ⑦ 印记 NOTES —— 三条长度递减的水平短线（计数刻痕），左对齐 */
  function markNotes() {
    var rows = [[35, 41, 65], [35, 50, 57], [35, 59, 49]];
    var out = "";
    for (var i = 0; i < rows.length; i++) {
      out += '<line x1="' + rows[i][0] + '" y1="' + rows[i][1] + '" x2="' + rows[i][2] +
             '" y2="' + rows[i][1] + '" stroke="currentColor" stroke-width="1.5" ' +
             'stroke-linecap="round" opacity=".78"/>';
    }
    return out;
  }

  /**
   * 构建地标图形的 SVG 内容。
   * @param {string} shape - 'contour'|'aperture'|'wave'|'swirl'|'sector'|'cross'|'tally'
   * @param {Object} [opts] - { rotate: number } 扇形朝向
   * @returns {string} viewBox="0 0 100 100" 的 SVG 内联内容
   */
  function buildMarkSVG(shape, opts) {
    var rotate = (opts && typeof opts.rotate === "number") ? opts.rotate : 30;
    switch (shape) {
      case "contour":  return markSpace();
      case "aperture": return markAperture();
      case "wave":     return markRhythm();
      case "swirl":    return markSwirl();
      case "sector":   return markField(rotate);
      case "cross":    return markAbout();
      case "tally":    return markNotes();
      default:         return markAbout();
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     引擎状态
     ══════════════════════════════════════════════════════════════════════════ */

  var cv = null, ctx = null, layerEl = null, view = { x: 0, y: 0, scale: 1 };

  var vw = 0, vh = 0, dpr = 1;
  var mapW = 0, mapH = 0;

  var running = false;
  var suspensions = new Set();
  var mode = "full";
  var frameId = 0;

  var ptrX = 0, ptrY = 0;
  var curX = 0, curY = 0;
  var parL1 = { x: 0, y: 0 };
  var hintX = 0;
  var hintTimer = 0;

  var dimTarget = 0, dimCur = 0, dimFrom = 0, dimT0 = 0, dimDur = 0;

  var onResizeCb = null;
  var frameHook = null;

  /* ══════════════════════════════════════════════════════════════════════════
     三维正交投影（docs/10 §3）
     --------------------------------------------------------------------------
       yaw   ：绕 z 轴旋转的方位角（无限制）
       pitch ：俯仰角，90° = 正俯视（纯平面地图），0° = 完全平视
       S     ：缩放；世界坐标的两个方向使用相同尺度（见下）

     ① x1 = x·cos(yaw) − y·sin(yaw)
        y1 = x·sin(yaw) + y·cos(yaw)
     ② sx = cx + x1 · S
        sy = cy + ( y1·sin(pitch) − z·cos(pitch) ) · S
     ③ depth = y1·cos(pitch) − z·sin(pitch)      （升序 = 远 → 近）

     ⚠️ 三条都**没有透视除法**：正交投影，远近平行，等高线形状不随距离变形
        （docs/10 §一「不要透视」）。这也是「直线投影后仍是直线」的原因——
        经纬网因此只需投影两个端点。

     **世界坐标** = 归一化投影坐标 × (mapW, mapH)（与 landmarks.js 的
     `normToWorld` 严格一致，地标 DOM 与画布共用同一套坐标）。

     **高度 z 的取值**：地形高度 h 先乘垂直夸张 VE（SITE_DATA.terrain
     .verticalExaggeration）再进入上面的公式 —— 即等高线层 L 画在
     `z = L · VE` 处（docs/10 §4.1 地层板同款）。VE 只影响 z，不影响公式本身。
     ══════════════════════════════════════════════════════════════════════════ */

  var YAW_DEFAULT = -18, PITCH_DEFAULT = 60;   /* docs/10 §3.2 默认机位 */
  var PITCH_MIN = 10, PITCH_MAX = 88;          /* §3.2 的钳位区间 */
  var CAM_MARGIN = 180;                        /* yaw 无限制，只做取模避免数值膨胀 */

  var COS_Y = 1, SIN_Y = 0, COS_P = 1, SIN_P = 0;
  var VE = 0.55;
  var camYaw = YAW_DEFAULT, camPitch = PITCH_DEFAULT;

  /* terrain.js 的取值入口。它若未加载（脚本缺失 / 被改写），地形层整体降级，
     但网格、地标、镜头照常工作 —— 契约 §4.2「降级不失能，绝不白屏」。 */
  function TerrainModule() {
    return (window.Scene && window.Scene._ && window.Scene._.Terrain) || null;
  }

  function EnvironmentModule() {
    return (window.Scene && window.Scene._ && window.Scene._.Environment) || null;
  }

  function environmentConfig() {
    var site = window.SITE_DATA || {};
    return (site.environment && site.environment.ambientTerrain) || {};
  }

  function terrainParams() {
    var T = TerrainModule();
    if (T && typeof T.readParams === "function") { return T.readParams(); }
    return { sigma: 0.12, breadthBase: 0.75, breadthGrowth: 0.28,
             weightWork: 1, weightNote: 0.35, reference: 10,
             contourInterval: 0.1, tilt: 52, verticalExaggeration: 0.55, gridSize: 128 };
  }

  function clampPitch(p) {
    return p < PITCH_MIN ? PITCH_MIN : (p > PITCH_MAX ? PITCH_MAX : p);
  }

  /** 由角度（度）刷新投影常量。地标 / 图层 / 镜头都从这里取同一份真相。 */
  function setCameraAngles(yawDeg, pitchDeg) {
    var y = (typeof yawDeg === "number" && isFinite(yawDeg)) ? yawDeg : camYaw;
    var p = (typeof pitchDeg === "number" && isFinite(pitchDeg)) ? pitchDeg : camPitch;
    p = clampPitch(p);
    /* yaw 无限制，但把角度收进 [-180,180) 防止长时间旋转后精度流失 */
    y = y - Math.round(y / 360) * 360;
    var changed = camYaw !== y || camPitch !== p;
    camYaw = y; camPitch = p;
    var ry = y * Math.PI / 180, rp = p * Math.PI / 180;
    COS_Y = Math.cos(ry); SIN_Y = Math.sin(ry);
    COS_P = Math.cos(rp); SIN_P = Math.sin(rp);
    if (changed && !(window.TerrainOrbit && window.TerrainOrbit.ready()) && (rasterCache.ready || rasterCache.building)) {
      discardLightingLookahead();
      discardRasterTransition();
      clearShadowRasterCache();
      rasterCache.ready = false;
      if (combinedContourCache.ready) { startRasterPreload(true); }
    }
  }

  function getCameraAngles() { return { yaw: camYaw, pitch: camPitch }; }

  /** 垂直夸张：高度 h → 世界 z（地层板 / 等高线 / 地标都用它） */
  function veOf(h) {
    var v = (typeof h === "number" && isFinite(h)) ? h : 0;
    return v * VE;
  }

  function updateProjection() {
    var p = terrainParams();
    var ve = p.verticalExaggeration;
    VE = (typeof ve === "number" && isFinite(ve) && ve > 0) ? ve : 0.55;
    setCameraAngles(camYaw, camPitch);          /* 让常量与当前角度一致 */
  }

  /**
   * docs/10 §3.3 的**字面实现**（纯函数，与模块状态无关）——
   * 自检表逐条断言的就是它。地形渲染走 projectNorm/projectWorld，
   * 二者与之严格同源。
   * @param {Object} [cam] { yaw, pitch, S, cx, cy }（角度制）
   * @returns {{sx:number, sy:number, depth:number}}
   */
  function projectPoint(x, y, z, cam) {
    var o = cam || {};
    var yaw = ((o.yaw == null ? YAW_DEFAULT : o.yaw)) * Math.PI / 180;
    var pit = ((o.pitch == null ? PITCH_DEFAULT : o.pitch)) * Math.PI / 180;
    var S = (typeof o.S === "number" && isFinite(o.S)) ? o.S : 1;
    var cx = (typeof o.cx === "number" && isFinite(o.cx)) ? o.cx : 0;
    var cy = (typeof o.cy === "number" && isFinite(o.cy)) ? o.cy : 0;
    var zz = (typeof z === "number" && isFinite(z)) ? z : 0;
    var c = Math.cos(yaw), s = Math.sin(yaw);
    var x1 = x * c - y * s;
    var y1 = x * s + y * c;
    return {
      sx: cx + x1 * S,
      sy: cy + (y1 * Math.sin(pit) - zz * Math.cos(pit)) * S,
      depth: y1 * Math.cos(pit) - zz * Math.sin(pit)
    };
  }

  /** 归一化地图坐标 (+高度) → 归一化**投影**坐标（再 ×(mapW, mapH) 即世界坐标） */
  function projectNorm(x, y, z) {
    var zz = (typeof z === "number" && isFinite(z)) ? z : 0;
    var x1 = x * COS_Y - y * SIN_Y;
    var y1 = x * SIN_Y + y * COS_Y;
    return { x: x1, y: y1 * SIN_P - zz * COS_P, depth: y1 * COS_P - zz * SIN_P };
  }

  /** 归一化地图坐标 (+高度) → 世界坐标（像素） */
  function projectWorld(x, y, z) {
    var n = projectNorm(x, y, z);
    return { x: n.x * mapW, y: n.y * mapH, depth: n.depth };
  }

  /**
   * 地图坐标 → 归一化投影坐标，**z 取该处的地表高度**（含 VE）。
   * 地标用它站在自己的山顶上（docs/10 §6.1）；与地形共用同一套投影（风险 R-8）。
   * 单独包一层，是为了让「地图坐标 + 地形高度」这个组合只有一个入口 ——
   * 调用方不需要知道垂直夸张 VE 的存在。
   */
  function projectGround(x, y) {
    return projectNorm(x, y, veOf(terrainHeightAt(x, y)));
  }

  /**
   * Painter 排序用的深度（docs/10 §3.3 ③）。**升序 = 远 → 近**。
   * 已乘垂直夸张，与 projectNorm 的 z 约定一致（传地形高度 h）。
   */
  function projectDepth(x, y, h) {
    var zz = veOf(h);
    var y1 = x * SIN_Y + y * COS_Y;
    return y1 * COS_P - zz * SIN_P;
  }

  /**
   * 世界屏幕点 → 归一化地图坐标（地面平面 z = 0 上的逆投影）。
   * 经纬网按视口反查覆盖范围时用；投影是仿射的，因此可闭式求逆。
   */
  function unprojectNorm(sx, sy, viewX, viewY, scale, vw2, vh2) {
    var wx = (sx - vw2) / scale + viewX;
    var wy = (sy - vh2) / scale + viewY;
    var a = wx / (mapW || 1);                       /* = x1 */
    var sp = SIN_P;
    var b = (Math.abs(sp) < 1e-6) ? 0 : wy / ((mapH || 1) * sp);  /* = y1 */
    return { x: a * COS_Y + b * SIN_Y, y: -a * SIN_Y + b * COS_Y };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     地形缓存 —— 风险 R-7 的核心对策（docs/10 §5.2）
     --------------------------------------------------------------------------
     缓存层次（全部**与视角无关**，键 = 数据签名）：

       hf        高度场
       contours  等高线线段（marching squares 原始输出）
       traced    追踪出的闭合环（地层板填充用，Terrain.traceContours）
       layers    按层合并好的绘制序列：每层 = 板（环 + 世界 z + 透明度）
                 + 按「同密度档」分好组的扁平线段数组（等高线合批）
       extent    归一化包围盒

     **只有「地图坐标 → 世界坐标」这一步每帧做**（docs/10 §二：自由旋转后
     投影缓存失效，必须每帧重投影；约 5.8 万次浮点运算，可接受）。
     Canvas 绘制调用数受控靠**合批**，见 docs/10 §5.1。
     ══════════════════════════════════════════════════════════════════════════ */

  var terrainCache = {
    sig: null, hf: null, contours: null, traced: null, layers: null,
    extent: null, points: null
  };

  var ambientCache = {
    sig: null, hf: null, contours: null, traced: null, layers: null
  };

  function emptySurfaceCache() {
    return { hf: null, grid: 0, lightKey: "", stateKey: "",
             quads: null, lamMin: 0, lamMax: 1, hMin: 0, hMax: 1 };
  }

  /* 主体 + 远景的完整预计算循环。运行时只选择相邻关键帧并插值，绝不再
     构造高度场或执行 marching squares。内容变化时后台生成 pendingFrames，
     active frames 继续播放，直到新循环全部完成后一次替换。 */
  var combinedContourCache = {
    key: null,
    frames: [],
    ready: false,
    building: false,
    pendingKey: null,
    pendingFrames: null,
    activeMainSurface: null,
    pendingMainSurface: null,
    activeContent: null,
    pendingContent: null,
    generation: 0,
    startedAt: 0,
    frameCount: 16,
    lightKey: null,
    lighting: false,
    pendingLightKey: null,
    lightGeneration: 0
  };

  /* 柔和曲面用低分辨率位图；等高线用预投影 Path2D，按屏幕 DPR 独立合成。
     放大只变换矢量路径，不放大低清线条，也不重新提取等高线。 */
  var rasterCache = {
    frames: [], ready: false, building: false, generation: 0,
    pending: null, pendingView: null, startedAt: 0, periodMinutes: 0.4,
    view: null, yaw: 0, pitch: 0, job: 0, themeKey: null, contourFrames: [],
    transitionFrame: null, transitionStartedAt: 0, transitionDuration: 900
  };
  /* 海拔色阶 / 等高线与太阳无关，长期保存在 rasterCache。太阳变化只替换
     这套低分辨率阴影叠层，避免每次跨过光照容差都重绘 16 张完整地形。 */
  var shadowRasterCache = {
    frames: [], ready: false, key: null, view: null,
    transitionFrame: null, transitionStartedAt: 0, transitionDuration: 900
  };
  /* 实时太阳阴影使用双缓冲：当前分钟继续播放，下一分钟的曲面缓存与光栅帧
     在后台完整生成。到分钟边界只交换引用，旧画布随即释放显存。 */
  var LIGHT_SLOT_MS = 60000;
  var LIGHT_AZIMUTH_TOLERANCE = 1.5;
  var LIGHT_ELEVATION_TOLERANCE = 0.75;
  var LIGHT_INTENSITY_TOLERANCE = 0.03;
  var TERRAIN_SIGNAL_TOLERANCE = 0.025;
  var lightingLookahead = {
    slot: null, activateAt: 0, key: null, mode: null,
    building: false, ready: false, phase: "idle",
    generation: 0, job: 0, timer: 0,
    frames: null, mainSurface: null,
    rasterFrames: null, pendingRaster: null, rasterView: null
  };
  var preloadWaiters = [];
  var initialWorkerCycle = null;
  var renderFrameOverride = null;
  var rasterizing = false;
  var rasterLayerOverride = null;
  var lastEnvironmentCheck = 0;
  var RASTER_SCALE = 0.75;
  var RASTER_MAX_PIXELS = 1350000;
  var RASTER_OVERSCAN = 1.35;
  var SHADOW_GRID = 48;
  var SHADOW_RASTER_SCALE = 0.46;
  var SHADOW_RASTER_MAX_PIXELS = 520000;

  function rasterScaleForViewport(width, height) {
    var area = Math.max(1, width * height);
    return Math.max(0.35, Math.min(RASTER_SCALE, Math.sqrt(RASTER_MAX_PIXELS / area)));
  }

  function shadowRasterScaleForViewport(width, height) {
    var area = Math.max(1, width * height);
    return Math.max(0.28, Math.min(SHADOW_RASTER_SCALE,
      Math.sqrt(SHADOW_RASTER_MAX_PIXELS / area)));
  }

  function currentRasterThemeKey() {
    if (typeof document === "undefined" || !document.documentElement) { return "day"; }
    return document.documentElement.classList.contains("m-theme-night") ? "night" : "day";
  }

  /* 每帧 stroke() + fill() 的调用预算（docs/10 §5.1 硬约束：< 40） */
  var DRAW_BUDGET = 40;
  var GRID_CALLS = 0;                /* 经纬格网已移除 */
  /* R-9：按局部梯度衰减的线宽与透明度档数。
     档数越多越细腻，但每层就要多一次 stroke()。
     因此档数**按层数自适应**，把总调用数锁死在预算内。 */
  var BUCKET_MAX = 3;
  var WIDTH_FALLOFF = [1, 0.78, 0.55];   /* R-9：按局部梯度衰减的线宽系数 */
  var ALPHA_FALLOFF = [1, 0.86, 0.70];   /* 同步略降不透明度，避免深色堆积 */
  var GRAD_SPLIT = [0.5, 1.2];           /* 梯度分档阈值（归一化单位） */

  /**
   * 选密度档数：保证 `层数 × (1 次 fill + n 次 stroke) + 网格 < 预算`。
   * 当前内容（6 层）取满 3 档 = 6×4+3 = 27 次；内容翻倍（10 层）自动降到
   * 2 档 = 33 次 —— 约束是结构性的，不随内容增长被突破。
   */
  function pickBucketCount(nLevels) {
    for (var b = BUCKET_MAX; b > 1; b--) {
      if (nLevels * (1 + b) + GRID_CALLS < DRAW_BUDGET) { return b; }
    }
    return 1;
  }

  function fieldList() {
    var site = window.SITE_DATA;
    var fs = (site && site.fields) || [];
    var out = [];
    for (var i = 0; i < fs.length; i++) {
      var f = fs[i] || {};
      var pos = f.position || {};
      out.push({ id: f.id, x: pos.x, y: pos.y });
    }
    return out;
  }

  function worksList() { return (window.WORKS_DATA && window.WORKS_DATA.works) || []; }
  function notesList() { return (window.NOTES_DATA && window.NOTES_DATA.notes) || []; }

  /** 数据签名：任何会影响地形的输入都被编码进来 */
  function dataSignature(T, p) {
    var pts = T.contentEquivalents(fieldList(), worksList(), notesList(), p);
    var parts = [];
    for (var i = 0; i < pts.length; i++) {
      parts.push(pts[i].id + ":" + pts[i].works + "," + pts[i].notes);
    }
    parts.push("|p=" + [p.weightWork, p.weightNote, p.reference, p.sigma,
      p.breadthBase, p.breadthGrowth, p.contourInterval, p.tilt,
      p.verticalExaggeration, p.gridSize].join(","));
    return parts.join(";");
  }

  /** 构建（或复用）高度场、等高线、闭合环与合批分组 —— 昂贵，只在数据变化时执行 */
  function ensureTerrain() {
    var T = TerrainModule();
    if (!T) {
      /* terrain.js 缺失：地形层降级为「一张还没开始测的底图」（R-10），
         网格与地标照常渲染，绝不抛错、绝不白屏。 */
      if (!terrainCache.disabled) {
        terrainCache = {
          sig: "unavailable", hf: null, contours: [], traced: [], layers: [],
          disabled: true, points: [],
          extent: { x0: 0, y0: 0, x1: 1, y1: 1 }
        };
      }
      updateProjection();
      return terrainCache;
    }

    var p = T.readParams();
    var sig = dataSignature(T, p);
    if (terrainCache.sig === sig && terrainCache.hf) { return terrainCache; }

    var hf = T.buildHeightField(fieldList(), worksList(), notesList(), p);
    var contours = T.extractContours(hf, p.contourInterval);
    /* 追踪出闭合环：地层板要的是「区域」，不是「线段」（docs/10 §4.2） */
    var traced = (typeof T.traceContours === "function")
      ? T.traceContours(contours, hf) : [];
    /* 不传第三参：extent 按 §4.6 用 2·max(σᵢ) 外扩（而非基准 σ） */
    var extent = T.computeExtent(hf.points, hf);

    terrainCache = {
      sig: sig,
      hf: hf,
      contours: contours,
      traced: traced,
      layers: mergeLayers(
        buildGroups(T, hf, contours, pickBucketCount(contours.length)),
        []                       /* v2.4 起由半透明曲面取代，不再构建板数据 */
      ),
      extent: extent,
      points: hf.points
    };

    /* 投影常量可能随数据里的 VE 变化 */
    updateProjection();
    return terrainCache;
  }

  function ensureAmbientTerrain() {
    var T = TerrainModule();
    var cfg = environmentConfig();
    if (!T || typeof T.buildAmbientHeightField !== "function" || cfg.enabled === false) {
      return { sig: "disabled", hf: null, contours: [], layers: [] };
    }
    var sig;
    try { sig = JSON.stringify(cfg); }
    catch (e) { sig = String(cfg.seed || "ambient"); }
    if (ambientCache.sig === sig && ambientCache.hf) { return ambientCache; }
    var hf = T.buildAmbientHeightField(cfg);
    var contours = T.extractContours(hf, hf.params.contourInterval);
    var traced = typeof T.traceContours === "function" ? T.traceContours(contours, hf) : [];
    ambientCache = {
      sig: sig,
      hf: hf,
      contours: contours,
      traced: traced,
      /* 远景统一为一档线宽，每层仅一次 stroke。 */
      layers: buildGroups(T, hf, contours, 1)
    };
    return ambientCache;
  }

  function quantize(v, step) {
    return Math.round((Number(v) || 0) / step) * step;
  }

  var terrainSignalAnchor = { mood: null, weather: null, key: null };

  function ambientSignalKey(state) {
    var s = state || {};
    var cfg = environmentConfig();
    var tolerance = Number(cfg.changeTolerance);
    if (!(tolerance > 0)) { tolerance = TERRAIN_SIGNAL_TOLERANCE; }
    tolerance = Math.max(0.005, Math.min(0.2, tolerance));
    var mood = Math.max(0, Math.min(1, Number(s.mood) || 0));
    var weather = Math.max(0, Math.min(1, Number(s.weather) || 0));
    if (terrainSignalAnchor.key !== null &&
        Math.abs(mood - terrainSignalAnchor.mood) < tolerance &&
        Math.abs(weather - terrainSignalAnchor.weather) < tolerance) {
      return terrainSignalAnchor.key;
    }
    terrainSignalAnchor.mood = mood;
    terrainSignalAnchor.weather = weather;
    terrainSignalAnchor.key = mood.toFixed(3) + ":" + weather.toFixed(3);
    return terrainSignalAnchor.key;
  }

  function sampleInside(T, hf, x, y) {
    if (!hf || x < hf.x0 || x > hf.x1 || y < hf.y0 || y > hf.y1) { return 0; }
    return T.sampleBilinear(hf, x, y);
  }

  function buildCombinedContourFrame(T, content, ambient, state, cfg, compact) {
    var offsetX = quantize(state.driftX, 0.0015);
    var offsetY = quantize(state.driftY, 0.0015);
    var heightScale = quantize(state.height || 1, 0.02);
    var phase = quantize(state.phase || 0, Math.PI * 2 / 16);
    var warp = quantize(state.warp || 0, 0.01);
    var interval = Number(cfg.combinedContourInterval) > 0
      ? Number(cfg.combinedContourInterval)
      : (Number(cfg.contourInterval) > 0 ? Number(cfg.contourInterval) : 0.04);
    var hf = T.combineHeightFields(content.hf, ambient.hf, {
      ambientScale: heightScale,
      ambientPhase: phase,
      ambientWarp: warp,
      offsetX: offsetX,
      offsetY: offsetY,
      // The combined domain is much wider than the main peaks' source field.
      // Keep their contour detail instead of stretching a 160-cell grid over it.
      gridSize: Math.max(content.hf.n, ambient.hf.n,
        Math.max(160, Math.min(512, Number(cfg.combinedGridSize) || 384))),
      contourInterval: interval
    });
    var contours = T.extractContours(hf, interval);
    // The unified surface and segment batches do not consume closed rings.
    var traced = !compact && typeof T.traceContours === "function" ? T.traceContours(contours, hf) : [];
    /* 0/1 = 远景普通/计曲线，2/3 = 过渡，4/5 = 主体。每段只进入一个桶，
       因而不存在两套线在同一位置叠加；三档仅改变视觉权重。 */
    var batches = [[], [], [], [], [], []];
    for (var i = 0; i < contours.length; i++) {
      var level = contours[i].level;
      var indexOffset = contours[i].isIndex ? 1 : 0;
      var segs = contours[i].segments || [];
      for (var j = 0; j < segs.length; j++) {
        var s = segs[j];
        var mx = (s[0] + s[2]) / 2, my = (s[1] + s[3]) / 2;
        var ch = sampleInside(T, content.hf, mx, my);
        var total = sampleInside(T, hf, mx, my);
        var ratio = total > 1e-6 ? ch / total : 0;
        var band = ratio < 0.28 ? 0 : (ratio < 0.68 ? 1 : 2);
        batches[band * 2 + indexOffset].push(s[0], s[1], s[2], s[3], level);
      }
    }
    return {
      hf: hf, contours: compact ? [] : contours, traced: traced,
      batches: compact ? batches.map(function (batch) { return new Float32Array(batch); }) : batches,
      contentHf: content.hf, ambientHf: ambient.hf,
      state: { height: heightScale, driftX: offsetX, driftY: offsetY,
               phase: phase, warp: warp }
    };
  }

  function notifyPreload(state) {
    for (var i = 0; i < preloadWaiters.length; i++) {
      try { preloadWaiters[i](state); } catch (e) { /* 单个进度订阅不阻断地图 */ }
    }
    if (state && state.ready) { preloadWaiters = []; }
  }

  function rasterPosition(now) {
    var cfg = environmentConfig();
    var duration = Math.max(0.1, Number(rasterCache.periodMinutes) ||
      Number(cfg.periodMinutes) || 0.4) * 60000;
    var elapsed = Math.max(0, (Number(now) || Date.now()) - rasterCache.startedAt);
    /* 最后一张是首帧的同一份闭环副本；只播放前 N 个区间。
       最后一个区间明确走 frame[N-1] → frame[N](===frame[0])，时间回绕时
       两侧像素完全一致，不依赖“数值上大致接近”。 */
    var count = Math.max(1, rasterCache.frames.length - 1);
    var position = (elapsed % duration) / duration * count;
    var index = Math.floor(position);
    return { index: index, progress: position - Math.floor(position) };
  }

  /* 每分钟取一次真实太阳位置。下一分钟会提前烘焙，因此分钟边界只交换缓存，
     不在用户可见的播放路径中做射线计算。 */
  function shadowLightKey(light, dateMs) {
    /* 太阳每分钟的位移通常远低于视觉可辨差异。只有跨过容差桶才生成新阴影，
       否则主线程会为几乎相同的结果反复做全域射线计算。 */
    return Math.round((Number(light.azimuth) || 0) / LIGHT_AZIMUTH_TOLERANCE) + ":" +
      Math.round((Number(light.elevation) || 0) / LIGHT_ELEVATION_TOLERANCE) + ":" +
      Math.round((Number(light.intensity) || 0) / LIGHT_INTENSITY_TOLERANCE) + ":" +
      String(light.mode || "day");
  }

  function snapshotRasterFrames(frames, now) {
    if (!frames || !frames.length) { return null; }
    var pos = rasterPosition(now);
    var prev = frames[pos.index], next = frames[pos.index + 1];
    if (!prev || !next || typeof document === "undefined") { return null; }
    var out = document.createElement("canvas");
    out.width = prev.width; out.height = prev.height;
    var outCtx = out.getContext("2d");
    if (!outCtx) { return null; }
    outCtx.globalAlpha = 1 - pos.progress;
    outCtx.drawImage(prev, 0, 0);
    outCtx.globalCompositeOperation = "lighter";
    outCtx.globalAlpha = pos.progress;
    outCtx.drawImage(next, 0, 0);
    outCtx.globalAlpha = 1;
    outCtx.globalCompositeOperation = "source-over";
    return out;
  }

  function snapshotActiveRaster(now) {
    if (!rasterCache.ready) { return null; }
    return snapshotRasterFrames(rasterCache.frames, now);
  }

  function beginRasterTransition(now) {
    if (rasterCache.transitionFrame) {
      releaseRasterFrames([rasterCache.transitionFrame]);
    }
    rasterCache.transitionFrame = snapshotActiveRaster(now);
    rasterCache.transitionStartedAt = rasterCache.transitionFrame ? now : 0;
  }

  function discardRasterTransition() {
    if (rasterCache.transitionFrame) {
      releaseRasterFrames([rasterCache.transitionFrame]);
      rasterCache.transitionFrame = null;
    }
    rasterCache.transitionStartedAt = 0;
  }

  function beginShadowTransition(now) {
    if (shadowRasterCache.transitionFrame) {
      releaseRasterFrames([shadowRasterCache.transitionFrame]);
    }
    shadowRasterCache.transitionFrame = shadowRasterCache.ready
      ? snapshotRasterFrames(shadowRasterCache.frames, now) : null;
    shadowRasterCache.transitionStartedAt = shadowRasterCache.transitionFrame ? now : 0;
  }

  function discardShadowTransition() {
    if (shadowRasterCache.transitionFrame) {
      releaseRasterFrames([shadowRasterCache.transitionFrame]);
      shadowRasterCache.transitionFrame = null;
    }
    shadowRasterCache.transitionStartedAt = 0;
  }

  function clearShadowRasterCache() {
    discardShadowTransition();
    releaseRasterFrames(shadowRasterCache.frames);
    shadowRasterCache.frames = [];
    shadowRasterCache.ready = false;
    shadowRasterCache.key = null;
    shadowRasterCache.view = null;
  }

  function releaseRasterFrames(frames, keepFrames) {
    if (!frames || !frames.length) { return; }
    var released = [];
    for (var i = 0; i < frames.length; i++) {
      var canvas = frames[i];
      if (!canvas || released.indexOf(canvas) >= 0 ||
          (keepFrames && keepFrames.indexOf(canvas) >= 0)) { continue; }
      released.push(canvas);
      /* 重设尺寸会立即释放 Canvas backing store；仅断引用要等 GC，切换瞬间
         仍可能同时占着两套全屏帧。 */
      try { canvas.width = 1; canvas.height = 1; } catch (e) { /* 非 DOM 测试桩 */ }
    }
    frames.length = 0;
  }

  function finishRasterPreload(generation, job, frames, baseView, contourFrames) {
    if (generation !== combinedContourCache.generation || job !== rasterCache.job) { return; }
    var swapNow = Date.now();
    beginRasterTransition(swapNow);
    var previousStart = rasterCache.startedAt;
    var expiredFrames = rasterCache.frames;
    rasterCache.frames = frames;
    rasterCache.contourFrames = contourFrames || [];
    rasterCache.ready = !!frames.length;
    rasterCache.building = false;
    rasterCache.pending = null;
    rasterCache.pendingView = null;
    rasterCache.view = baseView;
    rasterCache.yaw = camYaw;
    rasterCache.pitch = camPitch;
    if (window.TerrainOrbit) { window.TerrainOrbit.prepareFrames(contourFrames); }
    rasterCache.themeKey = currentRasterThemeKey();
    /* 阴影、尺寸或内容缓存更新不能把地形循环强制跳回第 0 帧。
       首次加载才建立时间原点，后续交换缓存继续沿用原相位。 */
    rasterCache.startedAt = previousStart || Date.now();
    rasterCache.periodMinutes = Number(environmentConfig().periodMinutes) || 0.4;
    if (expiredFrames !== frames) { releaseRasterFrames(expiredFrames, frames); }
    notifyPreload({ phase: "shadow", progress: 0.82, ready: false });
    requestFrame();
    var E = EnvironmentModule();
    var clockState = E && E.getClock ? E.getClock() : null;
    var lightAt = clockState && clockState.manual ? clockState.dateMs : Date.now();
    var light = E && E.getLight ? E.getLight(lightAt) : null;
    var lightKey = light ? shadowLightKey(light, lightAt) : null;
    if (initialWorkerCycle && rasterCache.gpuOnly && window.TerrainOrbit) {
      window.TerrainOrbit.prepareLighting(initialWorkerCycle.shadows);
      window.TerrainOrbit.activateLighting(Date.now());
      var shadowMarker = document.createElement("canvas"); shadowMarker.width = shadowMarker.height = 1;
      shadowRasterCache.frames = initialWorkerCycle.shadows.map(function () { return shadowMarker; });
      shadowRasterCache.ready = true;
      shadowRasterCache.key = initialWorkerCycle.lightKey;
      shadowRasterCache.view = baseView;
      combinedContourCache.lightKey = initialWorkerCycle.lightKey;
      initialWorkerCycle = null;
      notifyPreload({ phase: "shadow", progress: 1, ready: true });
      scheduleLightingLookahead(Date.now());
      return;
    }
    initialWorkerCycle = null;
    if (!light || !startLightingLookahead(light, lightKey,
        Math.floor(lightAt / LIGHT_SLOT_MS), Date.now())) {
      notifyPreload({ phase: "raster", progress: 1, ready: rasterCache.ready });
      scheduleLightingLookahead(Date.now());
    }
  }

  function startRasterPreload(force) {
    var frames = combinedContourCache.frames;
    var generation = combinedContourCache.generation;
    if (!frames || !frames.length) { return; }
    if (!force && rasterCache.building && rasterCache.generation === generation) { return; }

    if (typeof document === "undefined" || !document.createElement || !ctx || !cv) {
      finishRasterPreload(generation, rasterCache.job, [], null);
      return;
    }

    var job = ++rasterCache.job;
    var sourceVw = vw, sourceVh = vh;
    var cacheW = Math.ceil(sourceVw * RASTER_OVERSCAN);
    var cacheH = Math.ceil(sourceVh * RASTER_OVERSCAN);
    var rasterScale = rasterScaleForViewport(cacheW, cacheH);
    var camera = Scene._.Camera;
    var overview = camera && camera.overviewView ? camera.overviewView() :
      (rasterCache.view || view);
    // Never capture the current animated/focused view as the loop's coordinate system.
    var baseView = {
      x: overview.x, y: overview.y, scale: overview.scale, w: sourceVw, h: sourceVh,
      cacheW: cacheW, cacheH: cacheH
    };
    if (rasterCache.pending) { releaseRasterFrames(rasterCache.pending); }
    var pending = new Array(frames.length);
    rasterCache.generation = generation;
    rasterCache.building = true;
    rasterCache.pending = pending;
    rasterCache.pendingView = baseView;
    notifyPreload({ phase: "raster", progress: 0.5, ready: false });

    // The GPU already draws altitude, contours and light from cached world
    // geometry. Baking a second complete Canvas loop is redundant in this path.
    if (window.TerrainOrbit && window.TerrainOrbit.prepareFrames(frames)) {
      var marker = document.createElement("canvas"); marker.width = marker.height = 1;
      rasterCache.gpuOnly = true;
      finishRasterPreload(generation, job, frames.map(function () { return marker; }), baseView, frames);
      return;
    }
    rasterCache.gpuOnly = false;

    function capture(index) {
      if (generation !== combinedContourCache.generation || job !== rasterCache.job) {
        releaseRasterFrames(pending);
        return;
      }
      prepareContourPaths(frames[index]);
      var out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(cacheW * rasterScale));
      out.height = Math.max(1, Math.round(cacheH * rasterScale));
      var outCtx = out.getContext("2d");
      if (!outCtx) {
        finishRasterPreload(generation, job, [], baseView, frames);
        return;
      }

      var oldCtx = ctx, oldCv = cv, oldDpr = dpr, oldVw = vw, oldVh = vh;
      var oldView = view;
      var oldOverride = renderFrameOverride, oldRasterizing = rasterizing;
      var oldLayerOverride = rasterLayerOverride;
      try {
        ctx = outCtx;
        cv = out;
        dpr = rasterScale;
        vw = cacheW;
        vh = cacheH;
        view = baseView;
        rasterizing = true;
        rasterLayerOverride = "base";
        renderFrameOverride = {
          previous: frames[index], current: frames[index], progress: 1,
          ready: true, frameIndex: index, frameCount: frames.length
        };
        paint(0, 0, Date.now());
        pending[index] = out;
      } finally {
        ctx = oldCtx;
        cv = oldCv;
        dpr = oldDpr;
        vw = oldVw;
        vh = oldVh;
        view = oldView;
        renderFrameOverride = oldOverride;
        rasterizing = oldRasterizing;
        rasterLayerOverride = oldLayerOverride;
      }

      notifyPreload({ phase: "raster", progress: 0.5 + (index + 1) / frames.length * 0.5, ready: false });
      if (index + 2 === frames.length) {
        /* 闭环帧直接复用首帧画布：首尾不仅参数相同，而且像素逐位相同。 */
        pending[index + 1] = pending[0];
        notifyPreload({ phase: "raster", progress: 1, ready: false });
        finishRasterPreload(generation, job, pending, baseView, frames);
      } else if (index + 1 < frames.length) {
        window.setTimeout(function () { capture(index + 1); }, 0);
      } else {
        finishRasterPreload(generation, job, pending, baseView, frames);
      }
    }

    capture(0);
  }

  function startCombinedCycleBuild(T, content, ambient, cfg, key, buildLight, lightKey, localFallback) {
    if (!localFallback && window.TerrainPrecompute) {
      discardLightingLookahead();
      var workerGeneration = ++combinedContourCache.generation;
      combinedContourCache.building = true;
      combinedContourCache.pendingKey = key;
      window.TerrainPrecompute.prepare(terrainWorkerInput()).then(function (cycle) {
        if (workerGeneration !== combinedContourCache.generation) return;
        combinedContourCache.building = false; combinedContourCache.pendingKey = null;
        if (cycle) { adoptWorkerCycle(cycle); startRasterPreload(true); }
        else { startCombinedCycleBuild(T, content, ambient, cfg, key, buildLight, lightKey, true); }
      });
      return;
    }
    discardLightingLookahead();
    var E = EnvironmentModule();
    var previousCycleStart = combinedContourCache.startedAt;
    var count = Math.max(8, Math.min(32, Math.round(Number(cfg.cycleFrames) || 16)));
    var generation = ++combinedContourCache.generation;
    /* 多保留一张闭环帧。frames[count] 会直接指向 frames[0]，播放端因此有
       count 个完整插值区间，同时循环边界是严格相等而不是近似相等。 */
    var frames = new Array(count + 1);
    var mainGrid = Math.min(tokens().surfaceGrid, content.hf.n - 1);
    var mainBuilt = buildSurface(content.hf, mainGrid, veOf(1), buildLight,
      { castShadows: false });
    var mainSurface = {
      hf: content.hf,
      traced: content.traced,
      grid: mainGrid,
      lightKey: buildLight.key,
      stateKey: "main:" + buildLight.key,
      lightIntensity: mainBuilt.lightIntensity,
      quads: mainBuilt.quads,
      lamMin: mainBuilt.lamMin,
      lamMax: mainBuilt.lamMax,
      hMin: mainBuilt.hMin,
      hMax: mainBuilt.hMax
    };
    combinedContourCache.building = true;
    combinedContourCache.pendingKey = key;
    combinedContourCache.pendingFrames = frames;
    combinedContourCache.pendingMainSurface = mainSurface;
    combinedContourCache.pendingContent = content;
    combinedContourCache.frameCount = count;
    combinedContourCache.lighting = false;
    combinedContourCache.pendingLightKey = null;
    combinedContourCache.lightGeneration++;

    /* 首次打开没有旧循环可播放，先挂上主体曲面；后续重建则继续播放旧循环，
       直到新循环全部完成后才一次切换。 */
    if (!combinedContourCache.ready || !combinedContourCache.activeMainSurface) {
      combinedContourCache.activeMainSurface = mainSurface;
      combinedContourCache.activeContent = content;
    }

    function stateAt(index) {
      var phase = index / count * Math.PI * 2;
      if (E && typeof E.getAmbientStateAtPhase === "function") {
        return E.getAmbientStateAtPhase(phase);
      }
      return { phase: phase, height: 1, driftX: 0, driftY: 0,
               warp: Number(cfg.warp) || 0 };
    }

    function buildOne(index) {
      if (generation !== combinedContourCache.generation) { return; }
      var frame = buildCombinedContourFrame(T, content, ambient, stateAt(index), cfg);
      /* 基础循环只缓存几何与海拔色阶。实时太阳光照使用独立的低分辨率
         阴影缓存，避免每次光照变化都重绘完整地形。 */
      var tt = tokens();
      var grid = Math.min(tt.ambientSurfaceGrid, frame.hf.n - 1);
      var light = buildLight;
      var built = buildSurface(frame.hf, grid, veOf(1), light,
        { castShadows: false });
      var stateKey = frame.state ? [frame.state.phase, frame.state.warp].join(":") : "";
      frame.surfaceCache = {
        hf: frame.hf,
        grid: grid,
        lightKey: light.key,
        stateKey: stateKey + ":1:0:0",
        lightIntensity: built.lightIntensity,
        quads: built.quads,
        lamMin: built.lamMin,
        lamMax: built.lamMax,
        hMin: built.hMin,
        hMax: built.hMax
      };
      frames[index] = frame;
      notifyPreload({ phase: "terrain", progress: (index + 1) / count * 0.5, ready: false });

      if (index + 1 < count) {
        /* 每个任务只生成一帧，把约 200ms 的工作拆开，避免首屏连续冻结。 */
        window.setTimeout(function () { buildOne(index + 1); }, 24);
        return;
      }

      /* 闭环帧复用首帧对象，保证高度场、等高线、阴影参数全部逐位一致。 */
      frames[count] = frames[0];
      shareCycleLightRange(frames);
      /* 所有帧完整后再切换，播放中永远不会读到半套循环。 */
      combinedContourCache.frames = frames;
      combinedContourCache.key = key;
      combinedContourCache.ready = true;
      combinedContourCache.building = false;
      combinedContourCache.pendingKey = null;
      combinedContourCache.pendingFrames = null;
      combinedContourCache.activeMainSurface = combinedContourCache.pendingMainSurface;
      combinedContourCache.pendingMainSurface = null;
      combinedContourCache.activeContent = combinedContourCache.pendingContent;
      combinedContourCache.pendingContent = null;
      combinedContourCache.lightKey = lightKey;
      /* 内容变化不重置远景循环相位。新旧缓存使用同一时间基准，替换时不会
         突然跳回第 0 帧；首尾仍由 frames[count] === frames[0] 严格闭合。 */
      combinedContourCache.startedAt = previousCycleStart || Date.now();
      startRasterPreload();
    }

    /* 首帧同步生成，第一次打开页面时立刻有完整地形；其余帧后台排队。 */
    buildOne(0);
  }

  /* 每个关键帧若各自用 lamMin/lamMax 拉伸明暗，同一个坡度会随着该帧的
     极值变化而忽明忽暗。循环必须共用一套范围，才能只表现真实的坡向变化。 */
  function shareCycleLightRange(frames) {
    var lo = Infinity, hi = -Infinity, hLo = Infinity, hHi = -Infinity;
    var uniqueCount = Math.max(1, frames.length - 1);
    for (var i = 0; i < uniqueCount; i++) {
      var cache = frames[i] && frames[i].surfaceCache;
      if (!cache) { continue; }
      if (cache.lamMin < lo) { lo = cache.lamMin; }
      if (cache.lamMax > hi) { hi = cache.lamMax; }
      if (cache.hMin < hLo) { hLo = cache.hMin; }
      if (cache.hMax > hHi) { hHi = cache.hMax; }
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-6) { lo = 0; hi = 1; }
    if (!isFinite(hLo) || !isFinite(hHi) || hHi - hLo < 1e-6) { hLo = 0; hHi = 1; }
    for (var j = 0; j < frames.length; j++) {
      var target = frames[j] && frames[j].surfaceCache;
      if (target) {
        target.lamMin = lo; target.lamMax = hi;
        target.hMin = hLo; target.hMax = hHi;
      }
    }
  }

  function shareSurfaceLightRange(surfaces) {
    var lo = Infinity, hi = -Infinity;
    var uniqueCount = Math.max(1, surfaces.length - 1);
    for (var i = 0; i < uniqueCount; i++) {
      var cache = surfaces[i];
      if (!cache) { continue; }
      if (cache.lamMin < lo) { lo = cache.lamMin; }
      if (cache.lamMax > hi) { hi = cache.lamMax; }
    }
    if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-6) { lo = 0; hi = 1; }
    for (var j = 0; j < surfaces.length; j++) {
      if (surfaces[j]) { surfaces[j].lamMin = lo; surfaces[j].lamMax = hi; }
    }
  }

  function discardLightingLookahead(clearTimer) {
    if (window.TerrainOrbit) { window.TerrainOrbit.discardPreparedLighting(); }
    if (clearTimer !== false && lightingLookahead.timer) {
      window.clearTimeout(lightingLookahead.timer);
      lightingLookahead.timer = 0;
    }
    lightingLookahead.job++;
    if (lightingLookahead.rasterFrames) {
      releaseRasterFrames(lightingLookahead.rasterFrames);
    }
    if (lightingLookahead.pendingRaster &&
        lightingLookahead.pendingRaster !== lightingLookahead.rasterFrames) {
      releaseRasterFrames(lightingLookahead.pendingRaster);
    }
    lightingLookahead.slot = null;
    lightingLookahead.activateAt = 0;
    lightingLookahead.key = null;
    lightingLookahead.mode = null;
    lightingLookahead.building = false;
    lightingLookahead.ready = false;
    lightingLookahead.phase = "idle";
    lightingLookahead.frames = null;
    lightingLookahead.mainSurface = null;
    lightingLookahead.rasterFrames = null;
    lightingLookahead.pendingRaster = null;
    lightingLookahead.rasterView = null;
  }

  function startLookaheadRasterBuild(shadowSurfaces, generation, job) {
    if (!shadowSurfaces || !shadowSurfaces.length || !ctx || !cv) {
      discardLightingLookahead();
      return;
    }
    if (window.TerrainOrbit) { window.TerrainOrbit.prepareLighting(shadowSurfaces); }
    var sourceVw = vw, sourceVh = vh;
    var cacheW = Math.ceil(sourceVw * RASTER_OVERSCAN);
    var cacheH = Math.ceil(sourceVh * RASTER_OVERSCAN);
    var rasterScale = shadowRasterScaleForViewport(cacheW, cacheH);
    var pending = new Array(shadowSurfaces.length);
    /* 阴影必须在基础位图的原始视图中烘焙。播放时的点击镜头变化由
       drawRasterFrame 统一变换两层；若直接读取当前 view，两层会错位。 */
    var source = rasterCache.view || rasterCache.pendingView || view;
    var sourceView = { x: source.x, y: source.y, scale: source.scale };
    var baseView = {
      x: sourceView.x, y: sourceView.y, scale: sourceView.scale, w: sourceVw, h: sourceVh,
      cacheW: cacheW, cacheH: cacheH
    };
    if (rasterCache.gpuOnly && window.TerrainOrbit && window.TerrainOrbit.ready()) {
      var marker = document.createElement("canvas"); marker.width = marker.height = 1;
      lightingLookahead.rasterFrames = shadowSurfaces.map(function () { return marker; });
      lightingLookahead.rasterView = baseView;
      lightingLookahead.building = false; lightingLookahead.ready = true;
      lightingLookahead.phase = "ready";
      if (Date.now() >= lightingLookahead.activateAt) activatePreparedLighting(Date.now());
      return;
    }
    lightingLookahead.phase = "raster";
    lightingLookahead.pendingRaster = pending;

    function canceled() {
      return generation !== combinedContourCache.generation ||
        job !== lightingLookahead.job;
    }

    function capture(index) {
      if (canceled()) {
        releaseRasterFrames(pending);
        return;
      }
      var out = document.createElement("canvas");
      out.width = Math.max(1, Math.round(cacheW * rasterScale));
      out.height = Math.max(1, Math.round(cacheH * rasterScale));
      var outCtx = out.getContext("2d");
      if (!outCtx) {
        releaseRasterFrames(pending);
        discardLightingLookahead();
        return;
      }

      var oldCtx = ctx, oldCv = cv, oldDpr = dpr, oldVw = vw, oldVh = vh;
      var oldView = view;
      var oldRasterizing = rasterizing, oldLayerOverride = rasterLayerOverride;
      try {
        ctx = outCtx;
        cv = out;
        dpr = rasterScale;
        vw = cacheW;
        vh = cacheH;
        view = sourceView;
        rasterizing = true;
        rasterLayerOverride = "shadow";
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, vw, vh);
        ctx.save();
        ctx.translate(vw / 2, vh / 2);
        ctx.scale(sourceView.scale, sourceView.scale);
        ctx.translate(-sourceView.x, -sourceView.y);
        drawAmbientShadowSurface(shadowSurfaces[index], tokens(), Date.now(), ctx);
        ctx.restore();
        pending[index] = out;
      } finally {
        ctx = oldCtx;
        cv = oldCv;
        dpr = oldDpr;
        vw = oldVw;
        vh = oldVh;
        view = oldView;
        rasterizing = oldRasterizing;
        rasterLayerOverride = oldLayerOverride;
      }

      notifyPreload({ phase: "shadow", progress: 0.82 +
        (index + 1) / shadowSurfaces.length * 0.18, ready: false });
      if (index + 2 === shadowSurfaces.length) {
        pending[index + 1] = pending[0];
        lightingLookahead.pendingRaster = null;
        lightingLookahead.rasterFrames = pending;
        lightingLookahead.rasterView = baseView;
        lightingLookahead.building = false;
        lightingLookahead.ready = true;
        lightingLookahead.phase = "ready";
        if (Date.now() >= lightingLookahead.activateAt) {
          activatePreparedLighting(Date.now());
        }
      } else if (index + 1 < shadowSurfaces.length) {
        var rasterRemaining = shadowSurfaces.length - index - 2;
        var rasterBudget = lightingLookahead.activateAt - Date.now() - 1800;
        var rasterDelay = rasterRemaining > 0
          ? Math.max(0, Math.min(450, rasterBudget / rasterRemaining)) : 0;
        window.setTimeout(function () { capture(index + 1); }, rasterDelay);
      }
    }

    capture(0);
  }

  function startLightingLookahead(buildLight, lightKey, slot, activateAt) {
    var sourceFrames = combinedContourCache.frames;
    var content = combinedContourCache.activeContent;
    if (!sourceFrames.length || !content || !content.hf ||
        combinedContourCache.building || combinedContourCache.lighting ||
        rasterCache.building) { return false; }

    discardLightingLookahead();
    lightingLookahead.slot = slot;
    lightingLookahead.activateAt = activateAt;
    lightingLookahead.key = lightKey;
    lightingLookahead.mode = buildLight.mode || "day";
    lightingLookahead.building = true;
    lightingLookahead.phase = "surface";
    lightingLookahead.generation = combinedContourCache.generation;
    var generation = lightingLookahead.generation;
    var job = lightingLookahead.job;
    var uniqueCount = Math.max(1, sourceFrames.length - 1);
    var surfaces = new Array(sourceFrames.length);

    function buildOne(index) {
      if (generation !== combinedContourCache.generation ||
          job !== lightingLookahead.job) { return; }
      var frame = sourceFrames[index];
      var grid = Math.min(SHADOW_GRID, frame.hf.n - 1);
      var built = buildSurface(frame.hf, grid, veOf(1), buildLight,
        { castShadows: buildLight.mode !== 'night' });
      var stateKey = frame.state ? [frame.state.phase, frame.state.warp].join(":") : "";
      surfaces[index] = {
        hf: frame.hf, grid: grid, lightKey: lightKey,
        traced: frame.traced,
        stateKey: stateKey + ":1:0:0",
        lightIntensity: built.lightIntensity,
        quads: built.quads, lamMin: built.lamMin, lamMax: built.lamMax,
        hMin: built.hMin, hMax: built.hMax
      };
      if (index + 1 < uniqueCount) {
        /* 把重计算均匀摊在本分钟剩余时间里，预留末尾时间做光栅烘焙。
           这样预计算不会以一串连续长任务挤占正在播放的动画。 */
        var surfaceRemaining = uniqueCount - index - 1;
        var surfaceBudget = lightingLookahead.activateAt - Date.now() - 12000;
        var surfaceDelay = Math.max(24, Math.min(1500,
          surfaceRemaining > 0 ? surfaceBudget / surfaceRemaining : 24));
        window.setTimeout(function () { buildOne(index + 1); }, surfaceDelay);
        return;
      }
      surfaces[uniqueCount] = surfaces[0];
      shareSurfaceLightRange(surfaces);
      lightingLookahead.frames = surfaces;
      lightingLookahead.mainSurface = null;
      startLookaheadRasterBuild(surfaces, generation, job);
    }

    buildOne(0);
    return true;
  }

  function activatePreparedLighting(now) {
    var at = Number(now) || Date.now();
    if (!lightingLookahead.ready || at < lightingLookahead.activateAt ||
        lightingLookahead.generation !== combinedContourCache.generation) { return false; }
    var preparedView = lightingLookahead.rasterView;
    var activeView = rasterCache.view;
    if (!preparedView || !activeView || preparedView.w !== vw || preparedView.h !== vh ||
        preparedView.x !== activeView.x || preparedView.y !== activeView.y ||
        preparedView.scale !== activeView.scale) {
      discardLightingLookahead();
      return false;
    }

    var expiredShadowFrames = shadowRasterCache.frames;
    var nextShadowFrames = lightingLookahead.rasterFrames;
    var nextKey = lightingLookahead.key;
    if (window.TerrainOrbit) { window.TerrainOrbit.activateLighting(at); }

    beginShadowTransition(at);

    if (lightingLookahead.timer) {
      window.clearTimeout(lightingLookahead.timer);
      lightingLookahead.timer = 0;
    }
    lightingLookahead.job++;
    lightingLookahead.frames = null;
    lightingLookahead.rasterFrames = null;
    lightingLookahead.mainSurface = null;
    lightingLookahead.rasterView = null;
    lightingLookahead.pendingRaster = null;
    lightingLookahead.ready = false;
    lightingLookahead.building = false;
    lightingLookahead.phase = "idle";
    lightingLookahead.slot = null;
    lightingLookahead.activateAt = 0;
    lightingLookahead.key = null;
    lightingLookahead.mode = null;

    combinedContourCache.lightKey = nextKey;
    shadowRasterCache.frames = nextShadowFrames;
    shadowRasterCache.ready = !!(nextShadowFrames && nextShadowFrames.length);
    shadowRasterCache.key = nextKey;
    shadowRasterCache.view = preparedView;

    if (expiredShadowFrames !== nextShadowFrames) {
      releaseRasterFrames(expiredShadowFrames, nextShadowFrames);
    }
    lastEnvironmentCheck = at;
    notifyPreload({ phase: "shadow", progress: 1,
      ready: rasterCache.ready && shadowRasterCache.ready });
    requestFrame();
    window.setTimeout(function () { scheduleLightingLookahead(Date.now()); }, 0);
    return true;
  }

  function armLightingBoundary(activateAt) {
    if (lightingLookahead.timer) { window.clearTimeout(lightingLookahead.timer); }
    var delay = Math.max(16, activateAt - Date.now() + 8);
    lightingLookahead.timer = window.setTimeout(function () {
      lightingLookahead.timer = 0;
      var now = Date.now();
      if (lightingLookahead.phase === "tolerance-wait") {
        lightingLookahead.phase = "idle";
        lightingLookahead.slot = null;
        lightingLookahead.activateAt = 0;
        scheduleLightingLookahead(now);
        return;
      }
      if (lightingLookahead.phase === "theme-boundary") {
        /* 让 app.js 先切换昼夜 CSS 令牌；否则会用旧主题颜色烘焙新时段。 */
        requestFrame();
        return;
      }
      if (!activatePreparedLighting(now)) {
        /* 尚未烘焙完时继续播放旧缓存；完成回调会立即切换，不生成重复任务。 */
        ensureCombinedContours(now);
        requestFrame();
      }
    }, delay);
  }

  function scheduleLightingLookahead(now) {
    var E = EnvironmentModule();
    if (!E || typeof E.getLight !== "function" || typeof E.getClock !== "function" ||
        !combinedContourCache.ready || !rasterCache.ready) { return; }
    var clockState = E.getClock();
    if (clockState.manual) {
      discardLightingLookahead();
      return;
    }
    var at = Number(now) || Date.now();
    if (activatePreparedLighting(at)) { return; }
    var nextSlot = Math.floor(at / LIGHT_SLOT_MS) + 1;
    var activateAt = nextSlot * LIGHT_SLOT_MS;
    if ((lightingLookahead.building || lightingLookahead.ready) &&
        lightingLookahead.activateAt > at) {
      armLightingBoundary(lightingLookahead.activateAt);
      return;
    }
    if (combinedContourCache.building || combinedContourCache.lighting ||
        rasterCache.building) { return; }

    var currentLight = E.getLight(at);
    var currentKey = shadowLightKey(currentLight, at);
    var nextLight = null, nextKey = currentKey, scanSlot = nextSlot;
    /* 找到未来第一次真正跨越光照容差的分钟。最多看 30 分钟，避免在太阳
       变化很慢的时段仍每分钟重复启动任务。 */
    for (var scan = 0; scan < 30; scan++, scanSlot++) {
      activateAt = scanSlot * LIGHT_SLOT_MS;
      nextLight = E.getLight(activateAt);
      nextKey = shadowLightKey(nextLight, activateAt);
      if (nextKey !== currentKey) { break; }
    }
    nextSlot = scanSlot;
    if (!nextLight || nextKey === currentKey) {
      discardLightingLookahead();
      lightingLookahead.slot = Math.floor(at / LIGHT_SLOT_MS) + 1;
      lightingLookahead.activateAt = lightingLookahead.slot * LIGHT_SLOT_MS;
      lightingLookahead.phase = "tolerance-wait";
      armLightingBoundary(lightingLookahead.activateAt);
      return;
    }
    if (nextLight.mode !== currentLight.mode) {
      /* 昼夜主题会在边界改变 CSS 颜色；旧主题下预绘制的位图不可复用。 */
      discardLightingLookahead();
      lightingLookahead.slot = nextSlot;
      lightingLookahead.activateAt = activateAt;
      lightingLookahead.mode = nextLight.mode;
      lightingLookahead.phase = "theme-boundary";
      armLightingBoundary(activateAt);
      return;
    }
    if (startLightingLookahead(nextLight, nextKey, nextSlot, activateAt)) {
      armLightingBoundary(activateAt);
    }
  }

  /* 光照变化只重新计算每帧的 Lambert 阴影，不重建高度场、不跑 marching
     squares。旧的 raster 循环继续播放，全部新阴影就绪后再一次性交换。 */
  function startCombinedLightingBuild(buildLight, lightKey) {
    if (!buildLight || combinedContourCache.building) { return; }
    startLightingLookahead(buildLight, lightKey,
      Math.floor(Date.now() / LIGHT_SLOT_MS), Date.now());
  }

  function ensureCombinedContours(now) {
    if (renderFrameOverride) { return renderFrameOverride; }
    var T = TerrainModule();
    var content = ensureTerrain(), ambient = ensureAmbientTerrain();
    if (!T || typeof T.combineHeightFields !== "function" || !content.hf || !ambient.hf) {
      return null;
    }
    var E = EnvironmentModule();
    var cfg = environmentConfig();
    var clockState = E && typeof E.getClock === "function" ? E.getClock() : null;
    var lightDateMs = clockState && clockState.manual
      ? clockState.dateMs : (Number(now) || Date.now());
    if (clockState && clockState.manual) {
      if (lightingLookahead.building || lightingLookahead.ready || lightingLookahead.timer) {
        discardLightingLookahead();
      }
    } else {
      activatePreparedLighting(lightDateMs);
    }
    var light = E && typeof E.getLight === "function"
      ? E.getLight(lightDateMs)
      : { azimuth: 315, renderElevation: 45, intensity: 1, key: "fallback" };
    var signalState = E && typeof E.getAmbientStateAtPhase === "function"
      ? E.getAmbientStateAtPhase(0) : { mood: 0.5, weather: 0.5 };
    var key = content.sig + "|" + ambient.sig + "|" + ambientSignalKey(signalState) +
      "|contour-grid:" + (Number(cfg.combinedGridSize) || 384);
    var lightKey = shadowLightKey(light, lightDateMs);

    if (combinedContourCache.key !== key && combinedContourCache.pendingKey !== key) {
      startCombinedCycleBuild(T, content, ambient, cfg, key, light, lightKey);
    } else if (combinedContourCache.ready && !combinedContourCache.building &&
               combinedContourCache.lightKey !== lightKey &&
               !(lightingLookahead.key === lightKey &&
                 (lightingLookahead.building || lightingLookahead.ready))) {
      startCombinedLightingBuild(light, lightKey);
    }

    var frames = combinedContourCache.frames;
    if (!combinedContourCache.ready || !frames.length) {
      var pending = combinedContourCache.pendingFrames;
      var first = pending && pending[0];
      return first ? { previous: null, current: first, progress: 1, ready: false } : null;
    }

    var duration = Math.max(0.1, Number(cfg.periodMinutes) || 0.4) * 60000;
    var elapsed = Math.max(0, (Number(now) || Date.now()) - combinedContourCache.startedAt);
    var count = Math.max(1, frames.length - 1);
    var position = (elapsed % duration) / duration * count;
    var index = Math.floor(position);
    var progress = position - Math.floor(position);
    return {
      previous: frames[index],
      current: frames[index + 1],
      progress: progress,
      ready: true,
      frameIndex: index,
      frameCount: frames.length
    };
  }

  /**
   * 等高线合批分组（docs/10 §5.1）：**同层 + 同密度档**的线段并成一条 Path。
   * 分组结果与视角无关，因此在这里一次算好；每帧只做「地图坐标 → 世界坐标」。
   * @returns {Array} [{ level, isIndex, z, buckets: [Float64Array, …] }]
   */
  function buildGroups(T, hf, contours, bucketCount) {
    var out = [];
    var nB = Math.max(1, bucketCount | 0);
    for (var L = 0; L < contours.length; L++) {
      var lv = contours[L];
      var segs = lv.segments || [];
      if (!segs.length) { continue; }
      var buckets = [];
      for (var b = 0; b < nB; b++) { buckets.push([]); }

      for (var s = 0; s < segs.length; s++) {
        var g = segs[s];
        /* R-9：局部梯度越大 → 等高线越密 → 线宽衰减 */
        var gr = T.gradientAt(hf, (g[0] + g[2]) / 2, (g[1] + g[3]) / 2);
        var mag = Math.sqrt(gr.gx * gr.gx + gr.gy * gr.gy);
        var k = 0;
        if (nB >= 3) { k = mag < GRAD_SPLIT[0] ? 0 : (mag < GRAD_SPLIT[1] ? 1 : 2); }
        else if (nB === 2) { k = mag < GRAD_SPLIT[1] ? 0 : 1; }
        buckets[k].push(g[0], g[1], g[2], g[3]);
      }

      out.push({
        level: lv.level,
        isIndex: !!lv.isIndex,
        z: veOf(lv.level),                       /* 等高线所在的高度（含 VE） */
        bucketCount: nB,
        buckets: buckets
      });
    }
    return out;
  }

  /* v2.4：地层板数据构建已移除，改由半透明晕曲面的 drawSurface() 直接消费高度场。
     traceContours 仍在 terrain.js 中保留（有独立测试），但渲染层不再使用。 */

  /**
   * 把「合批分组」与「地层板」按层级合并成一条绘制序列（docs/10 §4.3）：
   * 从低到高，每层先铺板、紧接着画该层的等高线。
   * 这样遮挡关系天然成立，无需与线段混排。
   */
  function mergeLayers(groups, plates) {
    var byLevel = {}, i;
    for (i = 0; i < plates.length; i++) {
      byLevel[plates[i].level] = { plate: plates[i] };
    }
    for (i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (byLevel[g.level]) { byLevel[g.level].group = g; }
      else { byLevel[g.level] = { group: g }; }
    }
    var levels = [];
    for (var k in byLevel) {
      if (Object.prototype.hasOwnProperty.call(byLevel, k)) {
        levels.push(parseFloat(k));
      }
    }
    levels.sort(function (a, b) { return a - b; });     /* 低 → 高 */

    var out = [];
    for (i = 0; i < levels.length; i++) {
      var e = byLevel[levels[i]];
      out.push({
        level: levels[i],
        z: veOf(levels[i]),
        plate: e.plate || null,
        group: e.group || null
      });
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     山体阴影（hillshade 曲面）—— **v2.1 已整体移除**（docs/10 §一「不要」）
     --------------------------------------------------------------------------
     原因：实心山体表面是「3D 渲染感」，不是用户要的「等高线感」。
     v2.1 用它换成：地层板（§4，极淡的水平板，只提供厚度）+ 等高线本身。
     terrain.js 的 hillshade() 仍保留为纯计算函数（docs/08 §4.5 未废止），
     但渲染层不再调用它，也不再烘焙离屏画布。
     ══════════════════════════════════════════════════════════════════════════ */

  /* ══════════════════════════════════════════════════════════════════════════
     初始化与尺寸
     ══════════════════════════════════════════════════════════════════════════ */

  function init(options) {
    cv = options.canvas;
    ctx = cv.getContext("2d");
    layerEl = options.layer || null;
    if (options.view) { view = options.view; }
    onResizeCb = options.onResize || null;
    resize();
    return true;
  }

  function resize() {
    if (!cv) { return; }
    discardLightingLookahead();
    discardRasterTransition();
    clearShadowRasterCache();
    var t = tokens();
    dpr = Math.min(window.devicePixelRatio || 1, 3);

    vw = window.innerWidth;
    vh = window.innerHeight;

    cv.width  = Math.round(vw * dpr);
    cv.height = Math.round(vh * dpr);
    cv.style.width  = vw + "px";
    cv.style.height = vh + "px";

    /* Viewport shape must never deform the terrain. The camera fits this
       square world to the available screen; GPU, contours and DOM landmarks
       all consume the same dimensions. */
    mapW = mapH = Math.max(vw, vh) * t.mapOverscan;

    updateProjection();        /* VE / 机位常量与当前数据保持一致 */

    if (Scene._.Landmarks) { Scene._.Landmarks.setMapSize(mapW, mapH); }

    if (onResizeCb) { onResizeCb({ w: vw, h: vh, dpr: dpr, mapW: mapW, mapH: mapH }); }

    if (rasterCache.ready || rasterCache.building) {
      rasterCache.ready = false;
      if (combinedContourCache.ready) { startRasterPreload(true); }
    }

    if (!running && !initialWorkerCycle) { render(frameNow()); }
  }

  function frameNow() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  function getViewport() { return { w: vw, h: vh }; }
  function getMapSize() { return { w: mapW, h: mapH }; }
  function setView(v) { view = v; }

  /* ══════════════════════════════════════════════════════════════════════════
     对外查询（新增，供 camera / landmarks 共用同一套投影）
     ══════════════════════════════════════════════════════════════════════════ */

  function activeTerrain() {
    return combinedContourCache.activeContent || ensureTerrain();
  }

  /** 归一化坐标处的地形高度（双线性采样）。无地形时返回 0（平地）。 */
  function terrainHeightAt(x, y) {
    var c = activeTerrain();
    if (!c.hf) { return 0; }
    var T = TerrainModule();
    if (T && window.TerrainOrbit && window.TerrainOrbit.ready() && rasterCache.contourFrames.length) {
      var phase = rasterPosition(Date.now()), frames = rasterCache.contourFrames;
      var a = T.sampleBilinear(frames[phase.index].hf, x, y), b = T.sampleBilinear(frames[phase.index + 1].hf, x, y);
      return a + (b - a) * phase.progress;
    }
    return T ? T.sampleBilinear(c.hf, x, y) : 0;
  }

  /** 地形的归一化包围盒（§4.6） */
  function getTerrainExtent() {
    return activeTerrain().extent;
  }

  /**
   * 地形在**世界坐标**下的包围盒（**三维拟合**），供镜头 fit 与边界约束使用。
   *
   * ⚠️ docs/10 §3.5：旋转后高度会显著改变包围盒，**不能只在 z = 0 平面上拟合**。
   *    这里投影三组点后取包围盒：
   *      ① 底面四角（z = 0）—— 托住地形的底
   *      ② extent 上 5×5 采样的**真实地表点**（z = h(x,y)·VE）
   *      ③ 各活跃场峰顶（地形极值所在）
   *    → 相对 §3.5 的「8 个角点」是**收紧而非放宽**：包围盒在 z = h_max 处的
   *      四个角是虚的（extent 边缘处地形本就近乎平坦），把它们算进去会凭空
   *      多出约 15–20% 的留白。极值一个不漏，留白一个不多。
   */
  function getTerrainWorldBounds() {
    var c = activeTerrain();
    var e = c.extent;
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    var i, j;

    function acc(x, y, h) {
      var w = projectWorld(x, y, veOf(h));
      if (w.x < x0) { x0 = w.x; }
      if (w.x > x1) { x1 = w.x; }
      if (w.y < y0) { y0 = w.y; }
      if (w.y > y1) { y1 = w.y; }
    }

    acc(e.x0, e.y0, 0);
    acc(e.x1, e.y0, 0);
    acc(e.x0, e.y1, 0);
    acc(e.x1, e.y1, 0);

    var N = 4;
    for (j = 0; j <= N; j++) {
      var y = e.y0 + (e.y1 - e.y0) * (j / N);
      for (i = 0; i <= N; i++) {
        var x = e.x0 + (e.x1 - e.x0) * (i / N);
        acc(x, y, terrainHeightAt(x, y));
      }
    }

    var pts = c.points || [];
    for (i = 0; i < pts.length; i++) {
      if (pts[i].A > 0 && isFinite(pts[i].x) && isFinite(pts[i].y)) {
        acc(pts[i].x, pts[i].y, terrainHeightAt(pts[i].x, pts[i].y));
      }
    }

    if (!isFinite(x0)) {
      var w0 = projectWorld(0, 0, 0), w1 = projectWorld(1, 1, 0);
      return { x0: w0.x, y0: w0.y, x1: w1.x, y1: w1.y };
    }
    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /** 地形统计（自验 / 调试用） */
  function getTerrainInfo() {
    var c = activeTerrain();
    if (!c.hf) {
      return { max: 0, levels: 0, segments: 0, coverage: 0, disabled: true,
               extent: c.extent, points: [] };
    }
    var levels = c.contours.length;
    var segs = 0, i, j;
    for (i = 0; i < levels; i++) { segs += c.contours[i].segments.length; }

    /* 覆盖率按 docs/08 §4.6.1 的口径统计：**归一化方格 [0,1]² 内**，
       高度 ≥ 最低等高距所占的**面积比**。
       采样域已外扩（不被裁平），因此只统计落在 [0,1]² 内的部分；
       每个格子内再做 3×3 双线性细分，把「数格点」的量化误差降到 0.3pp 以内。 */
    var iv = c.hf.params.contourInterval;
    var cover = 0, total = 0, coverAll = 0;
    var T2 = TerrainModule();
    for (j = 0; j < c.hf.n; j++) {
      var yy = c.hf.y0 + j * c.hf.cellY;
      for (i = 0; i < c.hf.n; i++) {
        var xx = c.hf.x0 + i * c.hf.cellX;
        if (c.hf.data[j * c.hf.n + i] >= iv) { coverAll++; }
        for (var sj = 0; sj < 3; sj++) {
          for (var si = 0; si < 3; si++) {
            var px2 = xx + (si - 1) * c.hf.cellX / 3;
            var py2 = yy + (sj - 1) * c.hf.cellY / 3;
            if (px2 < 0 || px2 > 1 || py2 < 0 || py2 > 1) { continue; }
            total++;
            var hv = T2 ? T2.sampleBilinear(c.hf, px2, py2) : 0;
            if (hv >= iv) { cover++; }
          }
        }
      }
    }

    /* 追踪出的闭合环（地层板）与每帧绘制调用估算 —— docs/10 §4.2 / §5.1 */
    var ringCount = 0, plateCount = 0, l;
    for (l = 0; l < (c.traced || []).length; l++) {
      ringCount += c.traced[l].rings.length;
      plateCount++;
    }
    var strokeCalls = 0;
    for (l = 0; l < (c.layers || []).length; l++) {
      var g = c.layers[l].group;
      if (!g) { continue; }
      for (var b = 0; b < g.buckets.length; b++) {
        if (g.buckets[b] && g.buckets[b].length) { strokeCalls++; }
      }
    }

    return {
      max: c.hf.max,
      levels: levels,
      segments: segs,
      rings: ringCount,
      /* 曲面填充次数上界 = 亮度桶 × 淡出档（实际更少：空桶不画、淡出为 0 的格丢弃） */
      drawCalls: { strokes: strokeCalls, fills: SURF_BRIGHT, grid: GRID_CALLS,
                   total: strokeCalls + SURF_BRIGHT + GRID_CALLS },
      coverage: total ? cover / total : 0,
      coverageDomain: coverAll / c.hf.data.length,
      domain: { x0: c.hf.x0, y0: c.hf.y0, x1: c.hf.x1, y1: c.hf.y1 },
      extent: { x0: c.extent.x0, y0: c.extent.y0, x1: c.extent.x1, y1: c.extent.y1 },
      angles: { yaw: camYaw, pitch: camPitch },
      points: c.points.map(function (q) {
        return { id: q.id, A: q.A, sigma: q.sigma, x: q.x, y: q.y };
      })
    };
  }

  /** 强制丢弃地形缓存（数据在运行期变化时使用） */
  function invalidateTerrain() {
    discardLightingLookahead();
    terrainCache = {
      sig: null, hf: null, contours: null, traced: null, layers: null,
      extent: null, points: null
    };
    /* 不中断旧循环；只取消未完成任务并让下一帧为新内容启动后台重建。 */
    combinedContourCache.generation++;
    combinedContourCache.key = null;
    combinedContourCache.building = false;
    combinedContourCache.pendingKey = null;
    combinedContourCache.pendingFrames = null;
    combinedContourCache.pendingMainSurface = null;
    combinedContourCache.pendingContent = null;
    requestFrame();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     经纬网格（05 §5.2）
     ══════════════════════════════════════════════════════════════════════════ */

  function drawGrid(t) {
    if (!t.gridMinorColor || !t.gridMajorColor) { return; }

    /* ⚠️ v2.1：经纬网画在 **z = 0 的地面平面**上（docs/10 §4.4）——
       它定义「这张图的底」，是纸感的关键。
       正交投影是**仿射**的（严格无透视除法）⇒ 直线投影后仍是直线，
       所以每条线只投影两个端点，不必逐点采样。

       覆盖范围 = 视口四角**逆投影**回地面（z = 0）后的归一化包围盒，
       再外扩一格；任意平移 / 缩放 / 旋转下网格都铺满视口。 */
    var stepX = t.gridStep / (mapW || 1);        /* 归一化步长 */
    var stepY = t.gridStep / (mapH || 1);
    if (!(stepX > 0) || !(stepY > 0)) { return; }

    var vw2 = vw / 2, vh2 = vh / 2;
    var ca = unprojectNorm(0, 0, view.x, view.y, view.scale, vw2, vh2);
    var cb = unprojectNorm(vw, 0, view.x, view.y, view.scale, vw2, vh2);
    var cc = unprojectNorm(0, vh, view.x, view.y, view.scale, vw2, vh2);
    var cd = unprojectNorm(vw, vh, view.x, view.y, view.scale, vw2, vh2);
    var x0 = Math.min(ca.x, cb.x, cc.x, cd.x) - stepX;
    var x1 = Math.max(ca.x, cb.x, cc.x, cd.x) + stepX;
    var y0 = Math.min(ca.y, cb.y, cc.y, cd.y) - stepY;
    var y1 = Math.max(ca.y, cb.y, cc.y, cd.y) + stepY;
    if (!isFinite(x0) || !isFinite(x1) || !isFinite(y0) || !isFinite(y1)) { return; }

    var i0 = Math.floor(x0 / stepX), i1 = Math.ceil(x1 / stepX);
    var j0 = Math.floor(y0 / stepY), j1 = Math.ceil(y1 / stepY);
    var MAXL = 400;                   /* 极端缩小下的保护（此时普通网格已被隐藏） */
    if (i1 - i0 > MAXL) { i1 = i0 + MAXL; }
    if (j1 - j0 > MAXL) { j1 = j0 + MAXL; }

    var every = Math.max(1, Math.round(t.gridMajorEvery || 4));
    /* ⚠️ 视觉间距要取**两个方向中更小的那个**：地面平面被俯仰压扁后，
       南北向（screen y）的格距是 64·sin(pitch) 像素 —— pitch 低时它会先
       挤到一起，此时只按 x 方向的 64px 判断会画出摩尔纹般的密网。 */
    var spX = t.gridStep * view.scale;
    var spY = t.gridStep * SIN_P * view.scale;
    var spMin = Math.min(spX, spY);
    var showMinor = spMin >= t.gridHideBelow;
    var dimK = 1 - (1 - t.gridDimOpacity / Math.max(t.gridMinorOpacity, 0.001)) * dimCur;

    var k, nx, ny, p0, p1, kx, ky;

    /* ① 普通网格 —— 合成一条 Path，一次 stroke() */
    if (showMinor) {
      ctx.lineWidth = t.gridMinorWidth / view.scale;
      ctx.strokeStyle = rgba(t.gridMinorColor, t.gridMinorOpacity * dimK);
      ctx.beginPath();
      for (k = i0; k <= i1; k++) {
        if (k % every === 0) { continue; }
        nx = k * stepX;
        p0 = projectWorld(nx, y0, 0); p1 = projectWorld(nx, y1, 0);
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      }
      for (k = j0; k <= j1; k++) {
        if (k % every === 0) { continue; }
        ny = k * stepY;
        p0 = projectWorld(x0, ny, 0); p1 = projectWorld(x1, ny, 0);
        ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
      }
      ctx.stroke();
    }

    /* ② 主线 —— 同样只一次 stroke() */
    ctx.lineWidth = t.gridMajorWidth / view.scale;
    ctx.strokeStyle = rgba(t.gridMajorColor, t.gridMajorOpacity * dimK);
    ctx.beginPath();
    for (kx = Math.floor(i0 / every) * every; kx <= i1; kx += every) {
      nx = kx * stepX;
      p0 = projectWorld(nx, y0, 0); p1 = projectWorld(nx, y1, 0);
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
    }
    for (ky = Math.floor(j0 / every) * every; ky <= j1; ky += every) {
      ny = ky * stepY;
      p0 = projectWorld(x0, ny, 0); p1 = projectWorld(x1, ny, 0);
      ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y);
    }
    ctx.stroke();

    /* ③ 主线交点方点 —— 一个小 Path（多个子路径）+ 一次 fill()
          交点太密时整体跳过：方点会糊成灰带，而且路径会无谓地变长。 */
    var nX = Math.floor((i1 - i0) / every) + 1;
    var nY = Math.floor((j1 - j0) / every) + 1;
    if (spMin * every < 12 || nX * nY > 2500) { return; }

    var dot = t.gridNodeSize / view.scale;
    var h = dot / 2;
    ctx.fillStyle = rgba(t.gridMajorColor, t.gridNodeOpacity * dimK);
    ctx.beginPath();
    for (kx = Math.floor(i0 / every) * every; kx <= i1; kx += every) {
      for (ky = Math.floor(j0 / every) * every; ky <= j1; ky += every) {
        var q = projectWorld(kx * stepX, ky * stepY, 0);
        ctx.moveTo(q.x - h, q.y - h);
        ctx.lineTo(q.x + h, q.y - h);
        ctx.lineTo(q.x + h, q.y + h);
        ctx.lineTo(q.x - h, q.y + h);
        ctx.closePath();
      }
    }
    ctx.fill();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     地形绘制（docs/10 §4）：地层板 + 等高线，按层从低到高**交错**绘制
     --------------------------------------------------------------------------
     顺序即遮挡关系（§4.3）：
       低层板（面积大）→ 低层等高线 → 高层板（面积小、位置高、盖在上面）→ …
     这样天然满足遮挡，无需把线段与板混排。

     调用数（§5.1 硬约束）：一层板 = 一个 Path（含该层全部环）+ **一次 fill()**；
     同层 + 同密度档的等高线合并成一个 Path + 一次 stroke()。
     绝对不要每个环一次 fill。
     ══════════════════════════════════════════════════════════════════════════ */

  function ambientSurfaceStyle(t) {
    return {
      surfaceColor: t.ambientSurfaceColor,
      surfaceColorLow: t.ambientSurfaceLow,
      surfaceColorHigh: t.ambientSurfaceHigh,
      surfaceShadeDark: t.ambientSurfaceShadeDark,
      surfaceShadeLight: t.ambientSurfaceShadeLight,
      surfaceAlpha: t.ambientSurfaceAlpha,
      surfaceAlphaTop: t.ambientSurfaceAlphaTop,
      surfaceGrid: t.ambientSurfaceGrid,
      surfaceBlur: t.ambientSurfaceBlur,
      castShadowStrength: t.castShadowStrength,
      lightContrast: t.lightContrast,
      slopeDarkOpacity: t.slopeDarkOpacity,
      slopeLightOpacity: t.slopeLightOpacity
    };
  }

  function drawAmbientSurface(t, now, dimK, targetCtx) {
    var target = targetCtx || ctx;
    var unified = ensureCombinedContours(now);
    var c = unified && unified.current;
    if (!c || !c.hf || !t.ambientSurfaceColor) { return; }
    var p = typeof unified.progress === "number" ? unified.progress : 1;
    function drawFrame(frame, cache, morphCache, morph) {
      if (!frame || !frame.hf) { return; }
      drawSurface(frame, ambientSurfaceStyle(t), target, dimK, now, {
        cache: cache,
        grid: Math.min(t.ambientSurfaceGrid, frame.hf.n - 1),
        stateKey: frame.state ? [frame.state.phase, frame.state.warp].join(":") : "",
        fixedLight: true,
        morphCache: morphCache,
        morph: morph,
        surfaceFadeStart: t.surfaceFadeStart,
        surfaceFadeEnd: t.surfaceFadeEnd,
        fullDomain: rasterizing,
        layers: rasterLayerOverride || "all"
      });
    }
    /* 顶点高度从旧快照连续插值到新快照；这是真正的几何起伏，不再是两张
       地形图片互相淡入淡出。 */
    drawFrame(c, c.surfaceCache || (c.surfaceCache = emptySurfaceCache()),
      unified.previous
        ? (unified.previous.surfaceCache ||
           (unified.previous.surfaceCache = emptySurfaceCache()))
        : null,
      p);
  }

  function drawAmbientShadowSurface(surface, t, now, targetCtx) {
    if (!surface || !surface.hf || !surface.quads) { return; }
    drawSurface(surface, ambientSurfaceStyle(t), targetCtx || ctx, 1, now, {
      cache: surface,
      grid: surface.grid,
      stateKey: surface.stateKey,
      fixedLight: true,
      fullDomain: true,
      layers: "shadow"
    });
  }

  function drawAmbientLayer(t, now, dimK) {
    /* 合成高度场本身就是连续底座，不再用主体轮廓去硬遮罩远景。 */
    drawAmbientSurface(t, now, dimK);
  }

  function drawTerrain(t, now) {
    var main = combinedContourCache.activeMainSurface;
    if (!main || !main.hf || !main.quads) { return; }

    var dimK = 1 - (1 - t.gridDimOpacity / Math.max(t.gridMinorOpacity, 0.001)) * dimCur;
    /* 主体曲面也只消费循环构建阶段准备好的阴影缓存。 */
    drawSurface(main, t, ctx, dimK, now, {
      cache: main,
      grid: main.grid,
      fixedLight: true,
      stateKey: main.stateKey,
      surfaceFadeStart: t.surfaceFadeStart,
      surfaceFadeEnd: t.surfaceFadeEnd,
      /* 全域阴影已由主体 + 远景的统一高度场承担；主体增强层继续沿最低
         等高线裁剪，避免它自己的矩形高度场边界叠出一块色板。 */
      fullDomain: false
    });
  }

  function prepareContourPaths(frame) {
    if (!frame || !frame.batches || typeof window.Path2D !== "function") { return null; }
    var key = [mapW, mapH, camYaw, camPitch, VE].join(":");
    if (frame.contourPathKey === key && frame.contourPaths) { return frame.contourPaths; }
    var paths = frame.batches.map(function (pts) {
      var tiles = {}, size = 512;
      for (var k = 0; k + 4 < pts.length; k += 5) {
        var zc = veOf(pts[k + 4]) * COS_P;
        var x1 = (pts[k] * COS_Y - pts[k + 1] * SIN_Y) * mapW;
        var y1 = ((pts[k] * SIN_Y + pts[k + 1] * COS_Y) * SIN_P - zc) * mapH;
        var x2 = (pts[k + 2] * COS_Y - pts[k + 3] * SIN_Y) * mapW;
        var y2 = ((pts[k + 2] * SIN_Y + pts[k + 3] * COS_Y) * SIN_P - zc) * mapH;
        var id = Math.floor((x1 + x2) / (2 * size)) + ":" + Math.floor((y1 + y2) / (2 * size));
        var tile = tiles[id];
        if (!tile) {
          tile = tiles[id] = { path: new window.Path2D(), x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        }
        // Each segment belongs to exactly one tile; actual bounds include
        // crossing endpoints, so culling creates neither seams nor duplicate lines.
        tile.x0 = Math.min(tile.x0, x1, x2); tile.y0 = Math.min(tile.y0, y1, y2);
        tile.x1 = Math.max(tile.x1, x1, x2); tile.y1 = Math.max(tile.y1, y1, y2);
        tile.path.moveTo(x1, y1); tile.path.lineTo(x2, y2);
      }
      return Object.keys(tiles).map(function (id) { return tiles[id]; });
    });
    frame.contourPathKey = key;
    frame.contourPaths = paths;
    return paths;
  }

  function drawCombinedContourFrame(frame, t, dimK, opacity, bounds) {
    if (!frame || !frame.batches || opacity <= 0) { return; }
    var scale = view.scale || 1;
    var paths = prepareContourPaths(frame);
    var transitionColor = mixRgb(t.ambientContourColor, t.contourColor, 0.52);
    for (var bi = 0; bi < frame.batches.length; bi++) {
      var pts = frame.batches[bi];
      if (!pts || pts.length < 5) { continue; }
      var band = Math.floor(bi / 2), isIndex = (bi % 2) === 1;
      var color = band === 0 ? t.ambientContourColor : (band === 1 ? transitionColor : t.contourColor);
      var a0 = band === 0
        ? (isIndex ? t.ambientContourOpacityIdx : t.ambientContourOpacity)
        : band === 1
          ? ((isIndex ? t.ambientContourOpacityIdx : t.ambientContourOpacity) * 0.45 +
             (isIndex ? t.contourOpacityIdx : t.contourOpacity) * 0.55)
          : (isIndex ? t.contourOpacityIdx : t.contourOpacity);
      var w0 = band === 0
        ? (isIndex ? t.ambientContourWidthIndex : t.ambientContourWidth)
        : band === 1
          ? ((isIndex ? t.ambientContourWidthIndex : t.ambientContourWidth) * 0.45 +
             (isIndex ? t.contourWidthIndex : t.contourWidth) * 0.55)
          : (isIndex ? t.contourWidthIndex : t.contourWidth);

      if (!paths) {
        ctx.beginPath();
        for (var k = 0; k + 4 < pts.length; k += 5) {
          var x1 = pts[k], y1 = pts[k + 1], x2 = pts[k + 2], y2 = pts[k + 3];
          var zc = veOf(pts[k + 4]) * COS_P;
          ctx.moveTo((x1 * COS_Y - y1 * SIN_Y) * mapW,
            ((x1 * SIN_Y + y1 * COS_Y) * SIN_P - zc) * mapH);
          ctx.lineTo((x2 * COS_Y - y2 * SIN_Y) * mapW,
            ((x2 * SIN_Y + y2 * COS_Y) * SIN_P - zc) * mapH);
        }
      }
      ctx.strokeStyle = rgba(color, a0 * dimK * opacity);
      ctx.lineWidth = Math.max(isIndex ? 0.8 : 0.4, w0 * scale) / scale;
      if (paths) {
        paths[bi].forEach(function (tile) {
          if (bounds && (tile.x1 < bounds.x0 || tile.x0 > bounds.x1 ||
              tile.y1 < bounds.y0 || tile.y0 > bounds.y1)) { return; }
          ctx.stroke(tile.path);
        });
      } else { ctx.stroke(); }
    }
  }

  function drawCombinedContours(t, now) {
    if (!t.contourColor || !t.ambientContourColor) { return; }
    var c = ensureCombinedContours(now);
    if (!c || !c.current) { return; }
    var dimK = 1 - (1 - t.gridDimOpacity / Math.max(t.gridMinorOpacity, 0.001)) * dimCur;
    var p = typeof c.progress === "number" ? c.progress : 1;
    if (c.previous && p < 1) { drawCombinedContourFrame(c.previous, t, dimK, 1 - p); }
    drawCombinedContourFrame(c.current, t, dimK, p);
  }

  var contourCv = null, contourCtx = null;

  function drawRasterContours(t, pos, translateX, translateY) {
    var frames = rasterCache.contourFrames;
    if (!frames || !frames.length) { return; }
    var oldCtx = ctx;
    if (!contourCv && typeof document !== "undefined") {
      contourCv = document.createElement("canvas");
      contourCtx = contourCv.getContext("2d");
    }
    var isolated = !!contourCtx;
    if (isolated) {
      if (contourCv.width !== cv.width || contourCv.height !== cv.height) {
        contourCv.width = cv.width; contourCv.height = cv.height;
      }
      contourCtx.setTransform(1, 0, 0, 1, 0, 0);
      contourCtx.clearRect(0, 0, contourCv.width, contourCv.height);
      ctx = contourCtx;
    }
    ctx.save();
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(vw / 2 + translateX, vh / 2 + translateY);
      ctx.scale(view.scale, view.scale);
      ctx.translate(-view.x, -view.y);
      var dimK = 1 - (1 - t.gridDimOpacity / Math.max(t.gridMinorOpacity, 0.001)) * dimCur;
      var pad = 4 / view.scale;
      var bounds = {
        x0: view.x - (vw / 2 + translateX) / view.scale - pad,
        y0: view.y - (vh / 2 + translateY) / view.scale - pad,
        x1: view.x + (vw / 2 - translateX) / view.scale + pad,
        y1: view.y + (vh / 2 - translateY) / view.scale + pad
      };
      drawCombinedContourFrame(frames[pos.index], t, dimK, 1 - pos.progress, bounds);
      // Interpolate premultiplied line colors on a transparent layer, not on terrain.
      if (isolated) { ctx.globalCompositeOperation = "lighter"; }
      drawCombinedContourFrame(frames[pos.index + 1], t, dimK, pos.progress, bounds);
    } finally {
      ctx.restore();
      ctx = oldCtx;
    }
    if (isolated) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(contourCv, 0, 0);
      ctx.restore();
    }
  }

  var shadowMixCv = null, shadowMixCtx = null;

  function drawShadowRasterOverlay(pos, cacheW, cacheH, now) {
    if (!shadowRasterCache.ready || !shadowRasterCache.frames.length ||
        !shadowRasterCache.view || shadowRasterCache.view.w !== vw ||
        shadowRasterCache.view.h !== vh) { return; }
    var prev = shadowRasterCache.frames[pos.index];
    var next = shadowRasterCache.frames[pos.index + 1];
    if (!prev || !next || typeof document === "undefined") { return; }
    if (!shadowMixCv) {
      shadowMixCv = document.createElement("canvas");
      shadowMixCtx = shadowMixCv.getContext("2d");
    }
    if (!shadowMixCtx) { return; }
    if (shadowMixCv.width !== prev.width || shadowMixCv.height !== prev.height) {
      shadowMixCv.width = prev.width;
      shadowMixCv.height = prev.height;
    }
    shadowMixCtx.setTransform(1, 0, 0, 1, 0, 0);
    shadowMixCtx.clearRect(0, 0, shadowMixCv.width, shadowMixCv.height);

    var transition = shadowRasterCache.transitionFrame;
    var transitionK = 1;
    if (transition) {
      transitionK = Math.max(0, Math.min(1,
        (now - shadowRasterCache.transitionStartedAt) /
        Math.max(1, shadowRasterCache.transitionDuration)));
      if (transitionK >= 1) {
        releaseRasterFrames([transition]);
        shadowRasterCache.transitionFrame = null;
        shadowRasterCache.transitionStartedAt = 0;
        transition = null;
      } else {
        shadowMixCtx.globalAlpha = 1 - transitionK;
        shadowMixCtx.drawImage(transition, 0, 0, transition.width, transition.height,
          0, 0, shadowMixCv.width, shadowMixCv.height);
      }
    }
    shadowMixCtx.globalCompositeOperation = "lighter";
    shadowMixCtx.globalAlpha = (1 - pos.progress) * transitionK;
    shadowMixCtx.drawImage(prev, 0, 0, prev.width, prev.height,
      0, 0, shadowMixCv.width, shadowMixCv.height);
    shadowMixCtx.globalAlpha = pos.progress * transitionK;
    shadowMixCtx.drawImage(next, 0, 0, next.width, next.height,
      0, 0, shadowMixCv.width, shadowMixCv.height);
    shadowMixCtx.globalAlpha = 1;
    shadowMixCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(shadowMixCv, 0, 0, shadowMixCv.width, shadowMixCv.height,
      0, 0, cacheW, cacheH);
  }

  function drawRasterFrame(translateX, translateY, now) {
    if (!rasterCache.ready || !rasterCache.frames.length || !rasterCache.view) { return false; }
    if (window.TerrainOrbit && window.TerrainOrbit.ready()) {
      var phase = rasterPosition(now), style = tokens();
      return window.TerrainOrbit.render({ frames: rasterCache.contourFrames, index: phase.index, progress: phase.progress, width: vw, height: vh, dpr: dpr, mapW: mapW, mapH: mapH, ve: VE, yaw: camYaw, pitch: camPitch, view: view, translateX: translateX, translateY: translateY, tokens: style, dim: 1 - (1 - style.gridDimOpacity / Math.max(style.gridMinorOpacity, .001)) * dimCur, now: now, ctx: ctx, canvas: cv });
    }
    if (rasterCache.gpuOnly) { return false; }
    if (rasterCache.view.w !== vw || rasterCache.view.h !== vh ||
        rasterCache.yaw !== camYaw || rasterCache.pitch !== camPitch) {
      rasterCache.ready = false;
      return false;
    }
    var pos = rasterPosition(now);
    var prev = rasterCache.frames[pos.index];
    var next = rasterCache.frames[pos.index + 1];
    if (!prev || !next) { return false; }

    var ratio = view.scale / Math.max(1e-6, rasterCache.view.scale);
    var cacheW = rasterCache.view.cacheW || vw;
    var cacheH = rasterCache.view.cacheH || vh;
    var tx = vw / 2 + translateX + (rasterCache.view.x - view.x) * view.scale;
    var ty = vh / 2 + translateY + (rasterCache.view.y - view.y) * view.scale;
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(tx, ty);
    ctx.scale(ratio, ratio);
    ctx.translate(-cacheW / 2, -cacheH / 2);
    var transition = rasterCache.transitionFrame;
    var transitionK = 1;
    if (transition) {
      transitionK = Math.max(0, Math.min(1,
        (Date.now() - rasterCache.transitionStartedAt) /
        Math.max(1, rasterCache.transitionDuration)));
      if (transitionK >= 1) {
        releaseRasterFrames([transition]);
        rasterCache.transitionFrame = null;
        rasterCache.transitionStartedAt = 0;
        transition = null;
      } else {
        ctx.globalAlpha = 1 - transitionK;
        ctx.drawImage(transition, 0, 0, transition.width, transition.height,
          0, 0, cacheW, cacheH);
        ctx.globalCompositeOperation = "lighter";
      }
    }
    ctx.globalAlpha = (1 - pos.progress) * transitionK;
    ctx.drawImage(prev, 0, 0, prev.width, prev.height, 0, 0, cacheW, cacheH);
    /* source-over 会让两张半透明图在 50% 处损失有效透明度，形成周期性
       “呼吸”。lighter 在透明底上相加的是预乘颜色与 alpha，得到真正的
       线性插值：(1-p)·prev + p·next。 */
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = pos.progress * transitionK;
    ctx.drawImage(next, 0, 0, next.width, next.height, 0, 0, cacheW, cacheH);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    drawShadowRasterOverlay(pos, cacheW, cacheH, now);
    ctx.restore();
    drawRasterContours(tokens(), pos, translateX, translateY);
    return true;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     地标 DOM 同步（docs/10 §6.1）
     --------------------------------------------------------------------------
     地标的世界坐标是 `(x, y, h(x,y))` —— 站在**它自己的山顶上**，不是地面平面上。
     位置由 landmarks.js 的 nx/ny getter 给出（内部调用本模块的 projectNorm，
     因此与地形**完全同一套投影**，风险 R-8），这里只负责写进 DOM。

     · 每帧写：自由旋转后投影随视角变化，任何静态布局都会滞后（§二）。
     · 写 transform 而不是 --wx/--wy：left/top 会触发布局重算（05 §7.5 禁令），
       transform 只走合成层。
     · 只写平移，**不旋转** —— 地标的文字与图形永远水平朝向屏幕（§6.1）。
     ══════════════════════════════════════════════════════════════════════════ */

  var lmPos = {};        /* id → 上一帧的 transform（无变化就不写样式） */

  function syncLandmarks() {
    var L = Scene._.Landmarks;
    if (!L || typeof L.all !== "function") { return; }
    var list = L.all();
    if (!list || !list.length) { return; }

    for (var i = 0; i < list.length; i++) {
      var lm = list[i];
      var el = lm.el;
      if (!el || !el.style) { continue; }
      var wx = lm.nx * mapW, wy = lm.ny * mapH;
      var tf = "translate3d(" + wx.toFixed(1) + "px," + wy.toFixed(1) + "px,0)";
      if (lmPos[lm.id] !== tf) {
        lmPos[lm.id] = tf;
        el.style.transform = tf;
      }
      /* 镜头边界约束与命中检测共用这两个值（app.js 在 resize 时也写一份） */
      lm.wx = wx; lm.wy = wy;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     绘制入口
     ══════════════════════════════════════════════════════════════════════════ */

  function paint(translateX, translateY, now) {
    // Suspended rooms still prepare resources, but never draw a hidden full
    // viewport. Canvas/WebGL compositing here would block introduction typing.
    if (!rasterizing && suspensions.size) { return; }
    // Until cached geometry is uploaded, the home is hidden by the intro.
    // Do not render several expensive CPU fallback frames during boot.
    if (initialWorkerCycle && !rasterCache.ready && !rasterizing) { return; }
    var t = tokens();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, vw, vh);   /* 不填底色，让 body 的纸张纹透上来 */

    if (!rasterizing && rasterCache.ready && now - lastEnvironmentCheck >= 30000) {
      lastEnvironmentCheck = now;
      ensureCombinedContours(now);
    }
    if (!rasterizing && drawRasterFrame(translateX, translateY, now)) {
      syncLandmarks();
      return;
    }

    ctx.save();
    ctx.translate(vw / 2 + translateX, vh / 2 + translateY);
    ctx.scale(view.scale, view.scale);
    ctx.translate(-view.x, -view.y);

    var dimK = 1 - (1 - t.gridDimOpacity / Math.max(t.gridMinorOpacity, 0.001)) * dimCur;
    /* 底部经纬格网移除：保留纸张纹理作为背景，只由山体与等高线表达地图。 */
    drawAmbientLayer(t, now, dimK, translateX, translateY);
    /* 主体和远景已经合并进同一高度场与同一张全域着色曲面。
       不再叠加仅覆盖五个主体的第二层颜色，否则会让远景看起来没有渲染。 */
    if (!rasterizing || rasterLayerOverride !== "base") { drawCombinedContours(t, now); }

    ctx.restore();

    /* 地标 DOM 与画布同步（在 ctx 变换之外：它写的是 DOM 而不是路径） */
    syncLandmarks();
  }

  /* ────────────────────────────────────────────────────────────────────────
     半透明晕渲地形曲面（docs/10 §4，v2.4）
     ────────────────────────────────────────────────────────────────────────
     几何事实：高度场是 (x, y) 的函数 —— 每个水平坐标上只有一个高度值，
     所以从地平线以上的任意视角看**曲面都不会自遮挡**。整个曲面因此不必
     分层、不必做深度排序。

     曲面颜色分成三个预绘制通道：海拔设色、坡面光照、投射阴影。海拔设色
     始终先铺底；后两层共享这张曲面的透明度预算，只负责塑形，不能覆盖底色。
     所有通道在离屏画布中一起模糊，等高线随后单独绘制并保持锐利。

     几何与光照只在数据变化时重算一次并缓存（与等高线同一套脏标记）；
     逐帧只做投影。                                              */
  var SURF_BRIGHT = 16;   /* 预绘制阶段使用更细亮度级，再由模糊合成消除格状分界。 */
  var SURF_ELEVATION = 8; /* 分层设色档数；只增加预绘制 fill 次数，不影响播放帧率。 */
  var SURF_SHADOW = 6;    /* 投射阴影柔化档；与高度、坡面分开合成。 */
  var SURF_STRIDE = 15;   /* 4 角×xyz + Lambert + 平均高度 + 投射阴影 */
  var surfaceCache = { hf: null, grid: 0, lightKey: "", lightIntensity: 1,
                       quads: null, lamMin: 0, lamMax: 1, hMin: 0, hMax: 1 };
  /* 曲面合成用的离屏画布。曲面必须**先画到离屏、再带模糊合成到主画布** ——
     见 drawSurface 顶部关于「平面着色必然有方格」的说明。 */
  var surfCv = null, surfCtx = null;

  function ensureSurfaceCanvas(w2, h2) {
    if (typeof document === "undefined" || !document.createElement) { return null; }
    if (!surfCv) {
      surfCv = document.createElement("canvas");
      surfCtx = surfCv.getContext("2d");
    }
    if (!surfCtx) { return null; }
    if (surfCv.width !== w2 || surfCv.height !== h2) {
      surfCv.width = w2; surfCv.height = h2;
    }
    return surfCtx;
  }

  function buildSurface(hf, grid, ve, light, transform) {
    var n = hf.n, data = hf.data;
    var tr = transform || {};
    var offsetX = tr.offsetX || 0, offsetY = tr.offsetY || 0;
    var heightScale = typeof tr.heightScale === "number" ? tr.heightScale : 1;
    var x0 = hf.x0, y0 = hf.y0;
    var x1 = hf.x0 + hf.cellX * (n - 1), y1 = hf.y0 + hf.cellY * (n - 1);
    var dx = (x1 - x0) / grid, dy = (y1 - y0) / grid;
    /* 双线性采样 —— 与等高线共用同一份高度场，保证曲面与线严格贴合 */
    function H(x, y) {
      var fx = (x - hf.x0) / hf.cellX, fy = (y - hf.y0) / hf.cellY;
      var j = Math.floor(fx), i = Math.floor(fy);
      if (j < 0) { j = 0; } if (j > n - 2) { j = n - 2; }
      if (i < 0) { i = 0; } if (i > n - 2) { i = n - 2; }
      var tx = fx - j, ty = fy - i;
      var a = data[i * n + j], b = data[i * n + j + 1];
      var c2 = data[(i + 1) * n + j], d2 = data[(i + 1) * n + j + 1];
      return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c2 * (1 - tx) * ty + d2 * tx * ty;
    }
    /* 光源由 environment.js 按站点经纬度与当前时间提供。
       模块不可用时退回传统制图光源，保证独立打开与测试环境仍可渲染。 */
    var L = light || { azimuth: 315, renderElevation: 45, intensity: 1 };
    var AZ = L.azimuth * Math.PI / 180;
    var ALT = L.renderElevation * Math.PI / 180;
    var lx = Math.sin(AZ) * Math.cos(ALT), ly = -Math.cos(AZ) * Math.cos(ALT), lz = Math.sin(ALT);
    var horizontal = Math.sqrt(lx * lx + ly * ly);
    var castShadows = tr.castShadows !== false && horizontal > 1e-5;
    var shadowUx = castShadows ? lx / horizontal : 0;
    var shadowUy = castShadows ? ly / horizontal : 0;
    var shadowRise = castShadows ? Math.tan(ALT) : 0;
    var shadowStep = Math.max(dx, dy) * 1.35;
    var shadowDistance = Math.sqrt((x1 - x0) * (x1 - x0) +
      (y1 - y0) * (y1 - y0));
    var shadowSteps = Math.ceil(shadowDistance / shadowStep);
    /* 160² 个表面格若各自沿整张地图逐格射线，会形成明显的主线程长任务。
       投影最终还会经过 10px 模糊，因此把射线限制到 72 步，并等距覆盖原
       搜索范围，视觉精度不变成硬边，计算量则稳定在可控上限。 */
    if (shadowSteps > 72) {
      shadowSteps = 72;
      shadowStep = shadowDistance / shadowSteps;
    }
    var shadowBias = Math.max(0.0015, ve * 0.004);
    var shadowSoftDepth = Math.max(0.012, ve * 0.055);

    /* 从地表点沿太阳方向在高度场中行进。只在预加载时执行；结果烘焙进
       关键帧，播放阶段没有射线检测开销。返回 0–1 的柔化遮挡强度。 */
    function castShadowAt(x, y, z) {
      if (!castShadows) { return 0; }
      var blocked = 0;
      for (var s = 2; s <= shadowSteps; s++) {
        var dist = s * shadowStep;
        var sx = x + shadowUx * dist, sy = y + shadowUy * dist;
        if (sx <= x0 || sx >= x1 || sy <= y0 || sy >= y1) { break; }
        var terrainZ = H(sx, sy) * ve * heightScale;
        var rayZ = z + shadowRise * dist;
        var clearance = terrainZ - rayZ - shadowBias;
        if (clearance > blocked) {
          blocked = clearance;
          if (blocked >= shadowSoftDepth) { return 1; }
        }
      }
      var q = Math.max(0, Math.min(1, blocked / shadowSoftDepth));
      return q * q * (3 - 2 * q);
    }
    var quads = [], lamMin = Infinity, lamMax = -Infinity;
    var hMin = Infinity, hMax = -Infinity;
    for (var i2 = 0; i2 < grid; i2++) {
      for (var j2 = 0; j2 < grid; j2++) {
        var xa = x0 + dx * j2, xb = xa + dx;
        var ya = y0 + dy * i2, yb = ya + dy;
        var h00 = H(xa, ya), h10 = H(xb, ya), h11 = H(xb, yb), h01 = H(xa, yb);
        var heightScale = transform && typeof transform.heightScale === "number"
          ? transform.heightScale : 1;
        var dhdx = ((h10 + h11) - (h00 + h01)) / 2 / dx * ve * heightScale;
        var dhdy = ((h01 + h11) - (h00 + h10)) / 2 / dy * ve * heightScale;
        var nl = Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
        var lam = (lx * -dhdx + ly * -dhdy + lz) / nl;
        if (!(lam > 0)) { lam = 0; }
        if (lam < lamMin) { lamMin = lam; }
        if (lam > lamMax) { lamMax = lam; }
        var hAvg = (h00 + h10 + h11 + h01) / 4;
        if (hAvg < hMin) { hMin = hAvg; }
        if (hAvg > hMax) { hMax = hAvg; }
        var shadow = castShadowAt((xa + xb) / 2, (ya + yb) / 2,
          hAvg * ve * heightScale);
        /* 每格 15 个数：4 角 × (x,y,z) + lam + hAvg + castShadow */
        quads.push(xa + offsetX, ya + offsetY, h00 * ve * heightScale,
                   xb + offsetX, ya + offsetY, h10 * ve * heightScale,
                   xb + offsetX, yb + offsetY, h11 * ve * heightScale,
                   xa + offsetX, yb + offsetY, h01 * ve * heightScale,
                   lam, hAvg, shadow);
      }
    }
    /* 每个循环关键帧都会长期缓存曲面；TypedArray 显著降低 16 帧的内存占用。 */
    return { quads: new Float32Array(quads), lamMin: lamMin, lamMax: lamMax,
             hMin: hMin, hMax: hMax,
             lightIntensity: isFinite(L.intensity) ? L.intensity : 1 };
  }

  function drawSurface(c, t, ctx, dimK, now, transform) {
    var hf = c.hf;
    if (!hf || !hf.data || !t.surfaceColor) { return 0; }
    /* 主体曲面不能低于高度场单元分辨率，否则放大 / 旋转时
       曲面是粗网格近似，而等高线是高分辨率 marching squares，边缘会脱开。 */
    var tr = transform || {};
    var grid = tr.grid || Math.max(t.surfaceGrid, Math.min(192, hf.n - 1)), ve = veOf(1);
    var cache = tr.cache || surfaceCache;
    var E = EnvironmentModule();
    var lightState = E && typeof E.getLight === "function"
      ? E.getLight(now) : { azimuth: 315, renderElevation: 45, intensity: 1, key: "fallback" };
    var stateKey = String(tr.stateKey || "") + ":" + String(tr.heightScale || 1) + ":" +
                   String(tr.offsetX || 0) + ":" + String(tr.offsetY || 0);
    var cacheValid = cache.hf === hf && cache.grid === grid &&
      cache.quads && cache.quads.length;
    if (!cacheValid || (!tr.fixedLight &&
        (cache.lightKey !== lightState.key || cache.stateKey !== stateKey))) {
      var built = buildSurface(hf, grid, ve, lightState, tr);
      cache.hf = hf; cache.grid = grid; cache.lightKey = lightState.key; cache.stateKey = stateKey;
      cache.lightIntensity = built.lightIntensity; cache.quads = built.quads;
      cache.lamMin = built.lamMin; cache.lamMax = built.lamMax;
      cache.hMin = built.hMin; cache.hMax = built.hMax;
      if (cache === surfaceCache) {
        surfaceCache = cache;
      }
    }
    var quads = cache.quads;
    if (!quads || !quads.length) { return 0; }

    var morphCache = tr.morphCache;
    var morphQuads = morphCache && morphCache.quads;
    var morphP = typeof tr.morph === "number" ? Math.max(0, Math.min(1, tr.morph)) : 1;
    var morphing = !!(morphQuads && morphQuads.length === quads.length && morphP < 1);
    var layerMode = String(tr.layers || "all");
    var drawBaseLayers = layerMode !== "shadow";
    var drawLightLayers = layerMode !== "base";

    var B = SURF_BRIGHT;
    var HEIGHT_BINS = tr.fullDomain ? SURF_ELEVATION : 1;
    var lamMin = morphing
      ? morphCache.lamMin + (cache.lamMin - morphCache.lamMin) * morphP : cache.lamMin;
    var lamMax = morphing
      ? morphCache.lamMax + (cache.lamMax - morphCache.lamMax) * morphP : cache.lamMax;
    var span = Math.max(1e-6, lamMax - lamMin);
    var heightMin = isFinite(cache.hMin) ? cache.hMin : 0;
    var heightMax = isFinite(cache.hMax) ? cache.hMax : 1;
    if (morphing) {
      heightMin = morphCache.hMin + (heightMin - morphCache.hMin) * morphP;
      heightMax = morphCache.hMax + (heightMax - morphCache.hMax) * morphP;
    }
    var heightSpan = Math.max(1e-6, heightMax - heightMin);
    var base = t.surfaceColor, dark = t.surfaceShadeDark, light = t.surfaceShadeLight;
    var low = t.surfaceColorLow || base, high = t.surfaceColorHigh || base;
    var nq = quads.length / SURF_STRIDE, i, o, k, key;
    var elevationBuckets = new Array(HEIGHT_BINS);
    var slopeBuckets = new Array(B);
    var shadowBuckets = new Array(SURF_SHADOW);
    for (i = 0; i < HEIGHT_BINS; i++) { elevationBuckets[i] = null; }
    for (i = 0; i < B; i++) { slopeBuckets[i] = null; }
    for (i = 0; i < SURF_SHADOW; i++) { shadowBuckets[i] = null; }

    for (i = 0; i < nq; i++) {
      o = i * SURF_STRIDE;
      if (drawBaseLayers) {
        var heightBin = 0;
        if (HEIGHT_BINS > 1) {
        var hAvg = morphing
          ? morphQuads[o + 13] + (quads[o + 13] - morphQuads[o + 13]) * morphP
          : quads[o + 13];
        var elevation = Math.max(0, Math.min(1, (hAvg - heightMin) / heightSpan));
        /* 扩大中高海拔的色阶面积。主体峰值只占全域很小一部分，若使用接近
           线性的映射，最高几档会缩成峰顶几个像素并被模糊吃掉。 */
        elevation = Math.pow(elevation, 0.55);
        heightBin = Math.min(HEIGHT_BINS - 1, Math.floor(elevation * HEIGHT_BINS));
        }
        if (!elevationBuckets[heightBin]) { elevationBuckets[heightBin] = []; }
        elevationBuckets[heightBin].push(o);
      }
      if (drawLightLayers) {
        var lamValue = morphing
          ? morphQuads[o + 12] + (quads[o + 12] - morphQuads[o + 12]) * morphP
          : quads[o + 12];
        var castShadow = morphing
          ? morphQuads[o + 14] + (quads[o + 14] - morphQuads[o + 14]) * morphP
          : quads[o + 14];
        var normalizedLight = Math.max(0, Math.min(1, (lamValue - lamMin) / span));
        var lightContrast = Number(t.lightContrast);
        if (!isFinite(lightContrast)) { lightContrast = 1.55; }
        normalizedLight = Math.max(0, Math.min(1,
          0.5 + (normalizedLight - 0.5) * lightContrast));
        normalizedLight = normalizedLight * normalizedLight * (3 - 2 * normalizedLight);
        k = Math.floor(normalizedLight * B);
        if (k < 0) { k = 0; } if (k > B - 1) { k = B - 1; }
        if (!slopeBuckets[k]) { slopeBuckets[k] = []; }
        slopeBuckets[k].push(o);
        if (castShadow > 0.001) {
          var shadowBin = Math.min(SURF_SHADOW - 1,
            Math.floor(Math.max(0, Math.min(1, castShadow)) * SURF_SHADOW));
          if (!shadowBuckets[shadowBin]) { shadowBuckets[shadowBin] = []; }
          shadowBuckets[shadowBin].push(o);
        }
      }
    }

    /* ── 为什么要走离屏 + 模糊 ─────────────────────────────────────────────
       曲面是**逐格平面着色**的：每个格子填一个单一颜色。相邻格子的亮度落在
       不同桶里，就形成肉眼可见的方格（用户反馈「曲面不平滑，有方格效果」）。

       要真正做到平滑只有三条路：
         a) 把网格加密到看不出格子 —— 每帧路径操作数随 n² 增长，会拖垮帧率
         b) 逐格用线性渐变做 Gouraud 着色 —— 每帧上千次 createLinearGradient，更贵
         c) **曲面画到离屏画布，合成到主画布时做一次模糊** ← 采用这条
       (c) 只在合成时付一次模糊的代价，且模糊是 GPU 加速的。等高线仍然画在
       模糊之后的图层上，所以线条保持锐利 —— 得到「柔和的曲面 + 清晰的等高线」。 */
    var blur = t.surfaceBlur;
    var target = ctx;
    var offscreenSaved = false;
    if (blur > 0 && cv) {
      var off = ensureSurfaceCanvas(cv.width, cv.height);
      if (off) {
        off.setTransform(1, 0, 0, 1, 0, 0);
        off.clearRect(0, 0, cv.width, cv.height);
        /* clip() 是 Canvas 的持久状态，setTransform/clearRect 都不会重置它。
           每次离屏绘制必须成对 save/restore，否则动态地形移动时裁剪区会逐帧
           取交集，最终只剩下一小块，视觉上就像被等高线擦除。 */
        off.save();
        offscreenSaved = true;
        /* ⚠️ 离屏必须与主画布用**逐位相同**的变换。
           这里曾经手抄主画布的变换（setTransform(dpr…) + scale），
           结果漏掉了前后两个 translate（居中/视差 + 平移），
           导致曲面与等高线错位、拖动时不跟随、看起来像卡死。
           **不要抄，直接读主画布当前的变换。** */
        var m = (typeof ctx.getTransform === "function") ? ctx.getTransform() : null;
        if (m) {
          off.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
        } else {
          /* 极老的浏览器没有 getTransform：退回手抄，但必须抄全四步 */
          off.setTransform(dpr, 0, 0, dpr, 0, 0);
          off.translate(vw / 2, vh / 2);
          off.scale(view.scale, view.scale);
          off.translate(-view.x, -view.y);
        }
        target = off;
      } else {
        blur = 0;                 /* 不支持离屏则退回直接绘制（无模糊，效果同 v2.4） */
      }
    }

    /* 用**最外层等高线**裁剪曲面。
       曲面边界因此是一条光滑的曲线，而不是四边形网格的台阶 ——
       这是 v2.5 的做法，取代了 v2.4 的「按高度淡出」：
       淡出需要把透明度量化成若干档才能合批，而量化本身就产生台阶。
       改用裁剪后，边界由一条真实等高线决定，且不再需要淡出分档
       （填充次数从 21 降到 7）。 */
    var clipped = false;
    if (!tr.fullDomain && blur > 0 && target !== ctx && c.traced && c.traced.length) {
      var lowest = null, ti, ri, pi;
      for (ti = 0; ti < c.traced.length; ti++) {
        if (!c.traced[ti].rings || !c.traced[ti].rings.length) { continue; }
        if (!lowest || c.traced[ti].level < lowest.level) { lowest = c.traced[ti]; }
      }
      if (lowest) {
        var clipScale = typeof tr.heightScale === "number" ? tr.heightScale : 1;
        var clipX = tr.offsetX || 0, clipY = tr.offsetY || 0;
        var zcl = veOf(lowest.level) * clipScale * COS_P;
        target.beginPath();
        for (ri = 0; ri < lowest.rings.length; ri++) {
          var ring0 = lowest.rings[ri];
          for (pi = 0; pi < ring0.length; pi++) {
            var wx0 = ring0[pi][0] + clipX, wy0 = ring0[pi][1] + clipY;
            var cx0 = (wx0 * COS_Y - wy0 * SIN_Y) * mapW;
            var cy0 = ((wx0 * SIN_Y + wy0 * COS_Y) * SIN_P - zcl) * mapH;
            if (pi === 0) { target.moveTo(cx0, cy0); } else { target.lineTo(cx0, cy0); }
          }
          target.closePath();
        }
        target.clip();
        clipped = true;
      }
    }

    var calls = 0;
    function fillBucket(list, col, alpha) {
      if (!list || !list.length || !(alpha > 0)) { return; }
      target.beginPath();
      for (i = 0; i < list.length; i++) {
        o = list[i];
        /* 四角投影。外扩 0.6px 让相邻格略微重叠 —— 只在边上相接的四边形
           会在抗锯齿下沿缝留下背景色细线（经典的共面接缝）。 */
        var cxs = [0, 0, 0, 0], cys = [0, 0, 0, 0], mx = 0, my = 0, q2, px2, py2;
        for (q2 = 0; q2 < 4; q2++) {
          px2 = quads[o + q2 * 3]; py2 = quads[o + q2 * 3 + 1];
          var zi = o + q2 * 3 + 2;
          var pz = morphing
            ? morphQuads[zi] + (quads[zi] - morphQuads[zi]) * morphP
            : quads[zi];
          var rx = (px2 * COS_Y - py2 * SIN_Y) * mapW;
          var ry = ((px2 * SIN_Y + py2 * COS_Y) * SIN_P - pz * COS_P) * mapH;
          cxs[q2] = rx; cys[q2] = ry; mx += rx; my += ry;
        }
        mx /= 4; my /= 4;
        for (q2 = 0; q2 < 4; q2++) {
          var ddx = cxs[q2] - mx, ddy = cys[q2] - my;
          var dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
          var ex = cxs[q2] + ddx / dl * 0.6, ey = cys[q2] + ddy / dl * 0.6;
          if (q2 === 0) { target.moveTo(ex, ey); } else { target.lineTo(ex, ey); }
        }
        target.closePath();
      }
      target.fillStyle = rgba(col, alpha);
      target.fill();
      calls++;
    }

    /* ① 高度底色：先在离屏层完整生成海拔设色图。透明度只在最终合成时
       应用一次，否则后画的阴影会同时改变颜色和覆盖率，反过来吞掉底色。 */
    var surfaceAlpha = Number(t.surfaceAlpha);
    var surfaceAlphaTop = Number(t.surfaceAlphaTop);
    if (!isFinite(surfaceAlpha)) { surfaceAlpha = 0.68; }
    if (!isFinite(surfaceAlphaTop)) { surfaceAlphaTop = surfaceAlpha; }
    surfaceAlpha = Math.max(0, Math.min(1, surfaceAlpha));
    surfaceAlphaTop = Math.max(0, Math.min(1, surfaceAlphaTop));
    var compositeAlpha = tr.fullDomain
      ? surfaceAlpha * 0.4 + surfaceAlphaTop * 0.6
      : surfaceAlpha;
    var isLayeredOffscreen = target !== ctx;
    var layerAlpha = isLayeredOffscreen ? 1 : compositeAlpha * dimK;
    for (key = 0; drawBaseLayers && key < HEIGHT_BINS; key++) {
      var hk = HEIGHT_BINS > 1 ? (key + 0.5) / HEIGHT_BINS : 0.5;
      var elevationBase = hk < 0.5
        ? mixRgb(low, base, hk * 2)
        : mixRgb(base, high, (hk - 0.5) * 2);
      fillBucket(elevationBuckets[key], elevationBase, layerAlpha);
    }

    /* ② 坡面光照：透明叠色，只塑造朝向，不再吞掉高度色。 */
    var slopeDark = Number(t.slopeDarkOpacity);
    var slopeLight = Number(t.slopeLightOpacity);
    if (!isFinite(slopeDark)) { slopeDark = 0.34; }
    if (!isFinite(slopeLight)) { slopeLight = 0.18; }
    for (key = 0; drawLightLayers && key < B; key++) {
      var tk = B > 1 ? (key + 0.5) / B : 0.5;
      var direction = (tk - 0.5) * 2;
      fillBucket(slopeBuckets[key], direction < 0 ? dark : light,
        Math.abs(direction) * (direction < 0 ? slopeDark : slopeLight) * layerAlpha);
    }

    /* ③ 投射阴影：使用独立透明度，避免再次把高度与坡面合并成一个色值。 */
    var castOpacity = Number(t.castShadowStrength);
    if (!isFinite(castOpacity)) { castOpacity = 0.34; }
    var daylightK = Math.max(0, Math.min(1, cache.lightIntensity));
    daylightK = daylightK * daylightK * (3 - 2 * daylightK);
    for (key = 0; drawLightLayers && key < SURF_SHADOW; key++) {
      var shadowAmount = (key + 0.5) / SURF_SHADOW;
      fillBucket(shadowBuckets[key], dark,
        shadowAmount * castOpacity * daylightK * layerAlpha);
    }

    /* 把离屏曲面带模糊合成到主画布。等高线在之后绘制，因此保持锐利 ——
       最终观感是「柔和的曲面 + 清晰的等高线」。 */
    if (blur > 0 && target !== ctx && surfCv) {
      if (offscreenSaved) {
        target.restore();
        offscreenSaved = false;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);          /* 1:1 设备像素，模糊半径才是可控的 */
      ctx.globalAlpha = compositeAlpha * dimK;
      ctx.filter = "blur(" + blur + "px)";
      ctx.drawImage(surfCv, 0, 0);
      ctx.filter = "none";
      ctx.restore();
      calls++;
    }
    return calls;
  }

  function render(now) {
    if (!ctx || !view) { return; }
    paint(parL1.x + hintX, parL1.y, Date.now());
  }

  /** 静态帧：无视差、无漂移（05 §10.2） */
  function renderStatic() {
    if (!ctx || !view) { return; }
    paint(0, 0, Date.now());
  }

  function requestFrame() {
    if (running) { return; }
    renderStatic();
  }

  function preloadTerrain(onProgress) {
    if (typeof onProgress === "function") { preloadWaiters.push(onProgress); }
    notifyPreload({
      phase: rasterCache.ready ? "raster" : "terrain",
      progress: rasterCache.ready ? 1 : 0,
      ready: rasterCache.ready && shadowRasterCache.ready
    });
    var unified = ensureCombinedContours(Date.now());
    if (unified && combinedContourCache.ready) { startRasterPreload(); }
  }

  function refreshEnvironment() {
    lastEnvironmentCheck = Date.now();
    if (rasterCache.ready && rasterCache.themeKey !== currentRasterThemeKey()) {
      /* 昼夜主题会改变海拔色阶与等高线颜色。只在这个低频边界重建基础
         位图；普通太阳移动仍然只替换轻量阴影缓存。 */
      cached = null;
      discardLightingLookahead();
      startRasterPreload(true);
      requestFrame();
      return;
    }
    ensureCombinedContours(lastEnvironmentCheck);
    requestFrame();
  }

  function getLightingCacheInfo() {
    return {
      activeKey: combinedContourCache.lightKey,
      activeRasterFrames: rasterCache.frames ? rasterCache.frames.length : 0,
      rasterTheme: rasterCache.themeKey,
      rasterBuilding: rasterCache.building,
      activeShadowFrames: shadowRasterCache.frames ? shadowRasterCache.frames.length : 0,
      contourRenderer: window.TerrainOrbit && window.TerrainOrbit.ready() ? "cached-world-vector" : typeof window.Path2D === "function" ? "cached-vector" : "vector",
      orbitRenderer: window.TerrainOrbit ? window.TerrainOrbit.inspect() : null,
      contourPixelRatio: dpr,
      activeContourFrames: rasterCache.contourFrames.length,
      contourGridSize: rasterCache.contourFrames.length ? rasterCache.contourFrames[0].hf.n : 0,
      contourDomain: rasterCache.contourFrames.length ? {
        x0: rasterCache.contourFrames[0].hf.x0, y0: rasterCache.contourFrames[0].hf.y0,
        x1: rasterCache.contourFrames[0].hf.x1, y1: rasterCache.contourFrames[0].hf.y1
      } : null,
      rasterView: rasterCache.view ? Object.assign({}, rasterCache.view) : null,
      pendingRasterView: rasterCache.pendingView ? Object.assign({}, rasterCache.pendingView) : null,
      shadowReady: shadowRasterCache.ready,
      preparedKey: lightingLookahead.key,
      preparedSlot: lightingLookahead.slot,
      activateAt: lightingLookahead.activateAt,
      phase: lightingLookahead.phase,
      building: lightingLookahead.building,
      ready: lightingLookahead.ready,
      preparedRasterFrames: lightingLookahead.rasterFrames
        ? lightingLookahead.rasterFrames.length : 0
    };
  }

  /* ══════════════════════════════════════════════════════════════════════════
     主循环
     ══════════════════════════════════════════════════════════════════════════ */

  function tick(now) {
    if (!running) { return; }
    frameId = window.requestAnimationFrame(tick);

    if (frameHook) { frameHook(now); }

    var t = tokens();

    curX += (ptrX - curX) * t.parallaxLerp;
    curY += (ptrY - curY) * t.parallaxLerp;

    parL1.x = -curX * t.parallaxL1;
    parL1.y = -curY * t.parallaxL1;

    if (layerEl) {
      layerEl.style.transform =
        "translate3d(" + (curX * t.parallaxL2 + hintX).toFixed(2) + "px, " +
        (curY * t.parallaxL2).toFixed(2) + "px, 0)";
    }

    if (dimDur > 0) {
      var p = Math.min(1, (now - dimT0) / dimDur);
      dimCur = dimFrom + (dimTarget - dimFrom) * easeCamera(p);
      if (p >= 1) { dimDur = 0; dimCur = dimTarget; }
    } else {
      dimCur = dimTarget;
    }

    render(now);
  }

  function start() {
    if (running || !ctx || suspensions.size || mode === "reduced") { return; }
    // A late preload completion must not restart the hidden home renderer.
    if (window.SpaceCity && window.SpaceCity.isOpen()) { return; }
    if (window.RhythmPlayer && window.RhythmPlayer.isOpen()) { return; }
    if (window.FieldRoom && window.FieldRoom.isOpen()) { return; }
    running = true;
    frameId = window.requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (frameId) { window.cancelAnimationFrame(frameId); frameId = 0; }
    if (layerEl) { layerEl.style.transform = ""; }
  }

  function isRunning() { return running; }

  function suspend(owner) { suspensions.add(owner); stop(); }
  function resume(owner) { suspensions.delete(owner); start(); }

  /* ══════════════════════════════════════════════════════════════════════════
     缓动
     ══════════════════════════════════════════════════════════════════════════ */

  function easeCamera(p) {
    var c = tokens().easeCamera;
    return cubicBezier(p, c[0], c[1], c[2], c[3]);
  }

  function cubicBezier(t, x1, y1, x2, y2) {
    if (x1 === y1 && x2 === y2) { return t; }
    function A(a, b) { return 1 - 3 * b + 3 * a; }
    function B(a, b) { return 3 * b - 6 * a; }
    function C(a) { return 3 * a; }
    function calc(a, b, u) { return ((A(a, b) * u + B(a, b)) * u + C(a)) * u; }
    function slope(a, b, u) { return 3 * A(a, b) * u * u + 2 * B(a, b) * u + C(a); }

    var u = t;
    for (var i = 0; i < 8; i++) {
      var x = calc(x1, x2, u) - t;
      if (Math.abs(x) < 1e-6) { break; }
      var d = slope(x1, x2, u);
      if (Math.abs(d) < 1e-6) { break; }
      u -= x / d;
    }
    u = Math.min(1, Math.max(0, u));
    return calc(y1, y2, u);
  }

  /* ══════════════════════════════════════════════════════════════════════════
     视差目标 / 拖拽引导
     ══════════════════════════════════════════════════════════════════════════ */

  function setPointer(nx, ny) {
    ptrX = (nx - 0.5) * 2;
    ptrY = (ny - 0.5) * 2;
  }

  function playDragHint() {
    if (mode !== "full") { return; }
    var t = tokens();
    hintTimer = window.setTimeout(function () {
      var t0 = frameNow();
      (function step(now) {
        var p = Math.min(1, (now - t0) / t.durDragHint);
        hintX = (1 - Math.cos(p * Math.PI * 2)) / 2 * 24;
        if (p < 1) {
          window.requestAnimationFrame(step);
        } else {
          hintX = 0;
        }
      })(t0);
    }, t.dragHintDelay);
  }

  function cancelDragHint() {
    if (hintTimer) { window.clearTimeout(hintTimer); hintTimer = 0; }
    hintX = 0;
  }

  /* ══════════════════════════════════════════════════════════════════════════
     网格退让（05 §7.3 步 3）
     ══════════════════════════════════════════════════════════════════════════ */

  function setDim(on) {
    var t = tokens();
    dimFrom = dimCur;
    dimTarget = on ? 1 : 0;
    if (mode === "full") {
      dimT0 = frameNow();
      dimDur = t.durCamera;
    } else {
      dimDur = 0;
      dimCur = dimTarget;
      renderStatic();
    }
  }

  /* ══════════════════════════════════════════════════════════════════════════
     模式切换（契约 §2.2 mode / §6 降级规则）
     ══════════════════════════════════════════════════════════════════════════ */

  function setMode(m) {
    mode = m;
    cached = null;                     /* 重新读令牌：降级态的透明度/线宽不同 */
    var t = tokens();

    if (m === "full" || m === "static") {
      start();
      cancelDragHint();
    } else {
      cancelDragHint();
      stop();
      ptrX = 0; ptrY = 0; curX = 0; curY = 0;
      parL1.x = 0; parL1.y = 0;
      dimCur = dimTarget; dimDur = 0;
      if (layerEl) { layerEl.style.transform = ""; }
      renderStatic();
    }
    return t;
  }

  function getMode() { return mode; }

  function invScale(scale) { return scale ? (1 / scale) : 1; }

  // Shared pure computation: the worker uses these same functions as the
  // renderer, so height, contour alignment and lighting cannot drift apart.
  function computeWorkerCycle(input, reusable, progress) {
    window.SITE_DATA = input.site;
    window.WORKS_DATA = { works: input.works };
    window.NOTES_DATA = { notes: input.notes };
    cached = input.tokens;
    updateProjection();
    if (!reusable) { terrainCache.sig = null; ambientCache.sig = null; }
    var T = TerrainModule(), cfg = environmentConfig(), count = input.states.length;
    var content = reusable ? reusable.content : ensureTerrain();
    var ambient = reusable ? reusable.ambient : ensureAmbientTerrain();
    var frames = reusable ? reusable.frames : new Array(count + 1);
    var light = input.light, shadows = new Array(count + 1);
    var mainGrid = Math.min(cached.surfaceGrid, content.hf.n - 1);
    var mainSurface = Object.assign({ hf: content.hf, traced: content.traced, grid: mainGrid,
      lightKey: light.key, stateKey: 'main:' + light.key },
      buildSurface(content.hf, mainGrid, veOf(1), light, { castShadows: false }));
    for (var i = 0; i < count; i++) {
      var frame = reusable ? frames[i] : buildCombinedContourFrame(T, content, ambient, input.states[i], cfg, true);
      var grid = Math.min(cached.ambientSurfaceGrid, frame.hf.n - 1);
      frame.surfaceCache = Object.assign({ hf: frame.hf, grid: grid, lightKey: light.key,
        stateKey: [frame.state.phase, frame.state.warp, 1, 0, 0].join(':') },
        buildSurface(frame.hf, grid, veOf(1), light, { castShadows: false }));
      frames[i] = frame;
      var shadowGrid = Math.min(SHADOW_GRID, frame.hf.n - 1);
      shadows[i] = Object.assign({ hf: frame.hf, grid: shadowGrid, lightKey: input.lightKey,
        stateKey: frame.surfaceCache.stateKey, traced: frame.traced },
        buildSurface(frame.hf, shadowGrid, veOf(1), light, { castShadows: light.mode !== 'night' }));
      if (progress) progress((i + 1) / count);
    }
    frames[count] = frames[0]; shadows[count] = shadows[0];
    if (!frames[0].meshSource) {
      var hf = frames[0].hf, n = hf.n, positions = new Float32Array(n * n * 3);
      var indices = new Uint32Array((n - 1) * (n - 1) * 6), offset = 0;
      for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
        var k = y * n + x; positions[k * 3] = hf.x0 + x * hf.cellX; positions[k * 3 + 1] = hf.y0 + y * hf.cellY;
        if (x < n - 1 && y < n - 1) { indices.set([k, k + 1, k + n + 1, k, k + n + 1, k + n], offset); offset += 6; }
      }
      frames[0].meshSource = { positions: positions, indices: indices };
    }
    shareCycleLightRange(frames); shareSurfaceLightRange(shadows);
    return { content: content, ambient: ambient, frames: frames, mainSurface: mainSurface,
      shadows: shadows, lightKey: input.lightKey,
      key: content.sig + '|' + ambient.sig + '|' + ambientSignalKey(input.states[0]) +
        '|contour-grid:' + (Number(cfg.combinedGridSize) || 384) };
  }

  function terrainWorkerInput() {
    var E = EnvironmentModule(), cfg = environmentConfig();
    var clock = E.getClock(), at = clock.manual ? clock.dateMs : Date.now();
    var count = Math.max(8, Math.min(32, Math.round(Number(cfg.cycleFrames) || 16)));
    var states = [];
    for (var i = 0; i < count; i++) states.push(E.getAmbientStateAtPhase(i / count * Math.PI * 2));
    var light = E.getLight(at);
    return { site: window.SITE_DATA, works: worksList().map(function (w) { return { field: w.field }; }),
      notes: notesList().map(function (n) { return { field: n.field }; }), tokens: tokens(),
      states: states, light: light, lightKey: shadowLightKey(light, at) };
  }

  function adoptWorkerCycle(cycle) {
    terrainCache = cycle.content; ambientCache = cycle.ambient;
    combinedContourCache.generation++;
    combinedContourCache.frames = cycle.frames;
    combinedContourCache.frameCount = cycle.frames.length - 1;
    combinedContourCache.activeContent = cycle.content;
    combinedContourCache.activeMainSurface = cycle.mainSurface;
    combinedContourCache.key = cycle.key;
    combinedContourCache.lightKey = cycle.lightKey;
    combinedContourCache.ready = true; combinedContourCache.building = false;
    combinedContourCache.startedAt = combinedContourCache.startedAt || Date.now();
    initialWorkerCycle = cycle;
    updateProjection();
  }

  /* ══════════════════════════════════════════════════════════════════════════
     导出
     ══════════════════════════════════════════════════════════════════════════ */

  /* 载入即把投影常量化好（VE / 默认机位的三角函数）——
     否则第一帧 drawGrid 会用到初值 SIN_P = 0，把地面平面压成一条线。 */
  updateProjection();

  Scene._.Tokens = {
    read: readTokens,
    get: tokens,
    invalidate: function () { cached = null; },
    hexToRgb: hexToRgb,
    rgba: rgba
  };

  Scene._.MapEngine = {
    workerSource: '(' + installMapEngine.toString() + ')();',
    prepareTerrainData: function () {
      return window.TerrainPrecompute ? window.TerrainPrecompute.prepare(terrainWorkerInput()) : Promise.resolve(null);
    },
    adoptTerrainData: adoptWorkerCycle,
    computeWorkerCycle: computeWorkerCycle,
    /* —— 契约接口（与 v1 完全一致，app.js / camera.js 无需改动）—— */
    init:            init,
    resize:          resize,
    getViewport:     getViewport,
    getMapSize:      getMapSize,
    setView:         setView,
    render:          render,
    renderStatic:    renderStatic,
    requestFrame:    requestFrame,
    preloadTerrain:  preloadTerrain,
    refreshEnvironment: refreshEnvironment,
    getLightingCacheInfo: getLightingCacheInfo,
    start:           start,
    stop:            stop,
    suspend:         suspend,
    resume:          resume,
    isRunning:       isRunning,
    setFrameHook:    function (fn) { frameHook = fn; },
    setMode:         setMode,
    getMode:         getMode,
    setDim:          setDim,
    setPointer:      setPointer,
    playDragHint:    playDragHint,
    cancelDragHint:  cancelDragHint,
    buildMarkSVG:    buildMarkSVG,
    invScale:        invScale,
    easeCamera:      easeCamera,
    cubicBezier:     cubicBezier,

    /* —— v2.0 新增（纯增量，不替换任何既有成员）—— */
    projectNorm:          projectNorm,
    projectWorld:         projectWorld,
    projectGround:        projectGround,
    terrainHeightAt:      terrainHeightAt,
    getTerrainExtent:     getTerrainExtent,
    getTerrainWorldBounds: getTerrainWorldBounds,
    getTerrainInfo:       getTerrainInfo,
    invalidateTerrain:    invalidateTerrain,
    getAmbientInfo:       function (date) {
      var c = ensureAmbientTerrain();
      var E = EnvironmentModule();
      var light = E && E.getLight ? E.getLight(date) : null;
      var state = E && E.getAmbientState ? E.getAmbientState(date) : null;
      return { enabled: !!c.hf, max: c.hf ? c.hf.max : 0,
               levels: c.contours ? c.contours.length : 0,
               light: light, state: state,
               cycleReady: combinedContourCache.ready,
               cycleBuilding: combinedContourCache.building,
               cycleFrameCount: combinedContourCache.frameCount,
               pendingFrameCount: combinedContourCache.pendingFrames
                 ? combinedContourCache.pendingFrames.filter(function (f) { return !!f; }).length
                 : 0 };
    },
    setAmbientSignals:    function (next) {
      var E = EnvironmentModule();
      var before = E && E.getAmbientStateAtPhase
        ? ambientSignalKey(E.getAmbientStateAtPhase(0)) : "";
      var result = E && E.setSignals ? E.setSignals(next) : null;
      var after = E && E.getAmbientStateAtPhase
        ? ambientSignalKey(E.getAmbientStateAtPhase(0)) : "";
      if (before === after) {
        requestFrame();
        return result;
      }
      discardLightingLookahead();
      combinedContourCache.generation++;
      combinedContourCache.key = null;
      combinedContourCache.building = false;
      combinedContourCache.pendingKey = null;
      combinedContourCache.pendingFrames = null;
      combinedContourCache.pendingMainSurface = null;
      combinedContourCache.pendingContent = null;
      renderStatic();
      return result;
    },

    /* —— v2.1 三维投影层（docs/10 §3，全部为纯增量）—— */
    setCameraAngles:      setCameraAngles,      /* 镜头把 yaw/pitch 推给投影层 */
    getCameraAngles:      getCameraAngles,
    projectPoint:         projectPoint,         /* §3.3 的字面实现（纯函数） */
    projectDepth:         projectDepth,         /* §3.3 ③ Painter 深度 */
    unprojectNorm:        unprojectNorm,        /* 地面平面逆投影（经纬网用） */
    veOf:                 veOf,
    LIMITS:               { yaw: YAW_DEFAULT, pitch: PITCH_DEFAULT,
                            pitchMin: PITCH_MIN, pitchMax: PITCH_MAX }
  };
})();
