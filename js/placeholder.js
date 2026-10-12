/* =============================================================================
 * placeholder.js —— 「坐标之外 / Layers of Life」占位图工厂 + 内置兜底文案
 * -----------------------------------------------------------------------------
 * 所有者：Agent D（内容呈现模块）
 * 依据：《05-UI设计规范》§6.8 占位图 / §5.4 地标图形语言
 *       《06-开发接口契约》§4.1 取用规则、§4.2 容错要求、§5 视觉契约
 *
 * 硬约束（违反即返工）：
 *   1. 零外部网络请求 —— 不引用任何图片 / 字体 / 图标库，全部由 JS 现场生成
 *   2. 颜色不写死 —— 内联 SVG 一律用 var(--field-color*) 变量，
 *      由容器上的 data-field 驱动换色；仅 dataUri() 需要字面色值时，
 *      从 site.data.js 的 fields[].color* 读取（数据驱动，不是硬编码）
 *   3. 文案不写死 —— 界面文案取自 SITE_DATA.messages.*，缺失时回落到下方
 *      FALLBACK_MESSAGES；严禁渲染出 undefined
 *
 * 对外接口（挂载在 window.Placeholder）：
 *   Placeholder.FALLBACK_MESSAGES  内置兜底文案常量（content-module.js 消费）
 *   Placeholder.messages(site)     合并 messages + 兜底 → 完整文案表
 *   Placeholder.msg(site, key)     取单条文案，永不返回 undefined
 *   Placeholder.svg(field, opts)   返回内联 <svg> 字符串（用 CSS 变量着色）
 *   Placeholder.markup(field,o)    返回完整 .c-placeholder 块
 *   Placeholder.dataUri(field,o)   返回 data:image/svg+xml,...（需显式色值）
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 一、内置兜底文案常量
   * ---------------------------------------------------------------------------
   * 为什么必须有这一份：契约 §4.1 / §4.2 规定 messages 缺失时不得渲染 undefined。
   * 「空状态 / 错误 / 占位标记」三类文案是验收重点，必须与 messages 的键一一对应。
   * 其余为结构性 UI 文案（分段标签、按钮），同样走这里统一兜底，
   * 保证 content-module.js 中不出现任何中文字面量。
   * ------------------------------------------------------------------------- */
  var FALLBACK_MESSAGES = {
    /* —— 契约 §4.2 点名的三类（与 site.data.js 的 messages 键一一对应）—— */
    emptyWorks: '这一片场还没有作品。',
    emptyNotes: '这一片场还没有留下印记。',
    emptyNotesAll: '还没有留下任何印记。',
    errorData: '内容数据没能加载。请检查 assets/data/ 下的 .data.js 文件是否被改动过。',
    placeholderTag: '待补',
    loadFailed: '页面没能正常启动，请用较新版本的浏览器打开。',

    /* —— 结构性 UI 文案（数据里没有对应键时的兜底）—— */
    back: '返回全景',
    tabWorks: '作品',
    tabNotes: '印记',
    expand: '展开',
    collapse: '收起',
    emptyHint: '换个分段看看。',
    aboutTitle: '关于',
    notesTitle: '印记',
    fieldFallback: '这一片场'
  };

  /* ---------------------------------------------------------------------------
   * 二、基础工具
   * ------------------------------------------------------------------------- */

  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 数值取整到 2 位小数，避免生成超长 d 属性 */
  function n2(v) {
    return Math.round(v * 100) / 100;
  }

  /** 文案取值：数据优先 → 兜底 → 空串（永不 undefined / null） */
  function msg(site, key) {
    var v;
    if (site && site.messages && has(site.messages, key)) v = site.messages[key];
    if (v === undefined || v === null || v === '') v = FALLBACK_MESSAGES[key];
    if (v === undefined || v === null) v = '';
    return String(v);
  }

  /** 合并成完整文案表（content-module.js 一次性取用） */
  function messages(site) {
    var out = {};
    var k;
    for (k in FALLBACK_MESSAGES) {
      if (has(FALLBACK_MESSAGES, k)) out[k] = msg(site, k);
    }
    /* 数据里额外的键也一并带出，方便日后扩展而无需改本文件 */
    if (site && site.messages) {
      for (k in site.messages) {
        if (has(site.messages, k) && out[k] === undefined) out[k] = site.messages[k];
      }
    }
    return out;
  }

  /** 在 site.fields 里按 id 找场；找不到返回 null（绝不抛错） */
  function findField(site, id) {
    if (!site || !site.fields || !site.fields.length) return null;
    for (var i = 0; i < site.fields.length; i++) {
      if (site.fields[i] && site.fields[i].id === id) return site.fields[i];
    }
    return null;
  }

  /* 三个场的字面色值只从数据里取，不在本文件里写死 */
  function fieldColors(fieldId, site) {
    var f = findField(site || global.SITE_DATA, fieldId);
    if (!f) return null;
    return { main: f.color || '', light: f.colorLight || '', dark: f.colorDark || '' };
  }

  /* ---------------------------------------------------------------------------
   * 三、三类图案的几何生成
   * ------------------------------------------------------------------------- */

  /** 等高线：闭合不规则曲线。扰动公式同《05》§5.4① / §6.8 */
  function contourPath(cx, cy, R, phase, steps) {
    var d = '';
    var i, t, r, x, y;
    for (i = 0; i <= steps; i++) {
      t = (i / steps) * Math.PI * 2;
      r = R * (1 + 0.13 * Math.sin(3 * t + phase) + 0.07 * Math.sin(5 * t));
      x = cx + r * Math.cos(t);
      y = cy + r * Math.sin(t);
      d += (i === 0 ? 'M' : 'L') + n2(x) + ',' + n2(y);
    }
    return d + 'Z';
  }

  /** 波形：60 段折线拟合正弦（《05》§6.8 rhythm） */
  function wavePath(w, cy, amp, period, steps) {
    var d = '';
    var i, x, y;
    for (i = 0; i <= steps; i++) {
      x = (w * i) / steps;
      y = cy - amp * Math.sin((2 * Math.PI * x) / period);
      d += (i === 0 ? 'M' : 'L') + n2(x) + ',' + n2(y);
    }
    return d;
  }

  /** 极坐标取点 */
  function polar(cx, cy, r, deg) {
    var a = (deg * Math.PI) / 180;
    return { x: n2(cx + r * Math.cos(a)), y: n2(cy + r * Math.sin(a)) };
  }

  /* ---------------------------------------------------------------------------
   * 四、SVG 生成
   * ---------------------------------------------------------------------------
   * viewBox 固定 400×300。所有描边色走 var(--field-color*)，
   * 因此同一段标记在三个场下会自动换成青灰 / 赭石 / 苔绿。
   * literalColors 为真时（dataUri 场景）改用传入的字面色值。
   * ------------------------------------------------------------------------- */
  function buildSvg(fieldId, literalColors) {
    var C = literalColors
      ? {
          main: literalColors.main,
          light: literalColors.light,
          dark: literalColors.dark
        }
      : {
          /* 内联进 DOM 时用变量，跨场复用同一段标记 */
          main: 'var(--field-color)',
          light: 'var(--field-color-light)',
          dark: 'var(--field-color-dark)'
        };

    var cx = 200;
    var cy = 150;
    var open = '<svg class="c-placeholder__art" viewBox="0 0 400 300" aria-hidden="true" focusable="false">';
    var close = '</svg>';
    var body = '';

    if (fieldId === 'rhythm') {
      /* ② 波形 / 脉冲：正弦折线 + 波峰 5 个小圆 */
      var amp = 52;
      var period = 200;
      body += '<path d="' + wavePath(400, cy, amp, period, 60) + '" fill="none" ' +
        'stroke="' + C.main + '" stroke-width="1.6" stroke-linecap="round" opacity=".5"/>';
      var peaks = [0.1, 0.3, 0.5, 0.7, 0.9];
      for (var p = 0; p < peaks.length; p++) {
        var px = 400 * peaks[p];
        var py = cy - amp * Math.sin((2 * Math.PI * px) / period);
        body += '<circle cx="' + n2(px) + '" cy="' + n2(py) + '" r="3" fill="' +
          (p === 2 ? C.main : C.light) + '" opacity="' + (p === 2 ? '.5' : '.38') + '"/>';
      }
      /* 两道极淡的参考线，暗示“节拍刻度” */
      body += '<path d="M 0,' + cy + ' L 400,' + cy + '" stroke="' + C.main +
        '" stroke-width="1" opacity=".16" stroke-dasharray="2 5"/>';
    } else if (fieldId === 'field') {
      /* ③ 扇形射线：1 原点 + 7 条等角射线 + 2 道弧 */
      var ox = 200;
      var oy = 268;
      var len = 150;
      var i2, pt;
      for (i2 = 0; i2 <= 6; i2++) {
        pt = polar(ox, oy, len, -90 - 45 + i2 * 15); /* -135° ~ -45°：朝上张开的 90° 扇面 */
        body += '<line x1="' + ox + '" y1="' + oy + '" x2="' + pt.x + '" y2="' + pt.y +
          '" stroke="' + C.main + '" stroke-width="1" stroke-linecap="round" opacity="' +
          n2(0.55 - i2 * 0.03) + '"/>';
      }
      var a1 = polar(ox, oy, 95, -135);
      var a2 = polar(ox, oy, 95, -45);
      var b1 = polar(ox, oy, len, -135);
      var b2 = polar(ox, oy, len, -45);
      body += '<path d="M ' + a1.x + ',' + a1.y + ' A 95,95 0 0 1 ' + a2.x + ',' + a2.y +
        '" fill="none" stroke="' + C.light + '" stroke-width="0.8" opacity=".55"/>';
      body += '<path d="M ' + b1.x + ',' + b1.y + ' A 150,150 0 0 1 ' + b2.x + ',' + b2.y +
        '" fill="none" stroke="' + C.main + '" stroke-width="1.2" opacity=".4"/>';
      body += '<circle cx="' + ox + '" cy="' + oy + '" r="2.5" fill="' + C.main + '" opacity=".5"/>';
    } else if (fieldId === 'light') {
      /* ④ 光圈 / 取景框（光影 · 摄影）：六边光圈叶 + 四角取景框 */
      var apR = 74;
      var blades = 6;
      var rot0 = -90;
      var pts = [];
      for (var b = 0; b < blades; b++) {
        pts.push(polar(cx, cy, apR, rot0 + b * (360 / blades)));
      }
      var dpath = 'M';
      for (var b3 = 0; b3 < pts.length; b3++) {
        dpath += ' ' + n2(pts[b3].x) + ',' + n2(pts[b3].y) + (b3 < pts.length - 1 ? ' L' : ' Z');
      }
      body += '<path d="' + dpath + '" fill="none" stroke="' + C.main +
        '" stroke-width="1.3" stroke-linejoin="round" opacity=".5"/>';
      /* 光圈叶：每个六边形顶点连向内侧，形成交叠的叶片 */
      for (var b4 = 0; b4 < blades; b4++) {
        var vtx = pts[b4];
        var inner = polar(cx, cy, apR * 0.44, rot0 + b4 * (360 / blades) + 30);
        body += '<line x1="' + n2(vtx.x) + '" y1="' + n2(vtx.y) + '" x2="' + n2(inner.x) + '" y2="' +
          n2(inner.y) + '" stroke="' + C.main + '" stroke-width="1" stroke-linecap="round" opacity="' +
          n2(0.42 - b4 * 0.035) + '"/>';
      }
      /* 中心小孔 */
      body += '<circle cx="' + cx + '" cy="' + cy + '" r="' + n2(apR * 0.2) + '" fill="none" stroke="' +
        C.light + '" stroke-width="1" opacity=".6"/>';
      /* 取景框四角标 */
      var fx = 58, fy = 40, fw = 284, fh = 220, cl = 22;
      var corners = [[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx, fy + fh, 1, -1], [fx + fw, fy + fh, -1, -1]];
      for (var c3 = 0; c3 < corners.length; c3++) {
        var cn = corners[c3];
        body += '<path d="M ' + (cn[0] + cn[2] * cl) + ',' + cn[1] + ' L ' + cn[0] + ',' + cn[1] +
          ' L ' + cn[0] + ',' + (cn[1] + cn[3] * cl) + '" fill="none" stroke="' + C.dark +
          '" stroke-width="1.4" stroke-linecap="square" opacity=".34"/>';
      }
    } else if (fieldId === 'taste') {
      /* ⑤ 香气涡旋（味道 · 料理）：两条螺线 + 浮起的气味点 */
      for (var s2 = 0; s2 < 2; s2++) {
        var spiral = '';
        var steps = 96;
        var rMax = 104 - s2 * 28;
        for (var st = 0; st <= steps; st++) {
          var t = st / steps;
          var sp = polar(cx, cy, rMax * (1 - t * 0.86), -90 + t * 940 + s2 * 150);
          spiral += (st === 0 ? 'M ' : 'L ') + n2(sp.x) + ',' + n2(sp.y) + ' ';
        }
        body += '<path d="' + spiral.replace(/\s+$/, '') + '" fill="none" stroke="' +
          (s2 === 0 ? C.main : C.light) + '" stroke-width="' + (s2 === 0 ? 1.3 : 1) +
          '" stroke-linecap="round" opacity="' + (s2 === 0 ? '.5' : '.4') + '"/>';
      }
      /* 气味点：越往上越小越淡，暗示热气升起 */
      var odots = [[-36, -92, 3.4, '.5'], [20, -116, 2.6, '.38'], [54, -84, 2, '.26']];
      for (var d4 = 0; d4 < odots.length; d4++) {
        body += '<circle cx="' + (cx + odots[d4][0]) + '" cy="' + (cy + odots[d4][1]) + '" r="' +
          odots[d4][2] + '" fill="' + C.main + '" opacity="' + odots[d4][3] + '"/>';
      }
    } else {
      /* ① 等高线 / 默认：5 条嵌套不规则闭合曲线 */
      var radii = [120, 96, 76, 58, 43];
      for (var k = 0; k < radii.length; k++) {
        body += '<path d="' + contourPath(cx, cy, radii[k], k * 1.7, 72) + '" fill="none" ' +
          'stroke="' + C.main + '" stroke-width="1.2" stroke-linecap="round" opacity="' +
          n2(0.5 - k * 0.06) + '"/>';
      }
      /* 一条穿过中心的断线，制造“断层” */
      body += '<line x1="60" y1="150" x2="340" y2="150" stroke="' + C.dark +
        '" stroke-width="1" stroke-dasharray="3 4" opacity=".28"/>';
    }

    return open + body + close;
  }

  /* ---------------------------------------------------------------------------
   * 五、对外接口
   * ------------------------------------------------------------------------- */

  /**
   * 内联 SVG 字符串（颜色用 CSS 变量，供直接插入 DOM）
   * @param {string} fieldId 'space' | 'rhythm' | 'field'
   */
  function svg(fieldId, opts) {
    opts = opts || {};
    return buildSvg(fieldId, opts.colors || null);
  }

  /**
   * 完整占位图块（《05》§6.8 的结构）
   * @param {string} fieldId
   * @param {Object} opts
   *   opts.site       SITE_DATA，用于取场名与 placeholderTag
   *   opts.label      覆盖 aria-label；默认「{场名} · {待补}」
   *   opts.hidden     为真时整块 aria-hidden（已有真实图片盖在上层时使用）
   *   opts.colors     字面色值（一般不用；内联场景一律走变量）
   */
  function markup(fieldId, opts) {
    opts = opts || {};
    var site = opts.site || global.SITE_DATA;
    var tag = msg(site, 'placeholderTag');
    var f = findField(site, fieldId);
    var name = f && f.name ? f.name : '';
    /* aria-label 必须非空（《05》§6.8）；没有场名时退化为标签本身 */
    var label = opts.label || (name ? name + ' · ' + tag : tag);

    var attrs = ' class="c-placeholder" data-field="' + esc(fieldId || '') + '"';
    if (opts.hidden) attrs += ' aria-hidden="true"';
    else attrs += ' role="img" aria-label="' + esc(label) + '"';

    return '<div' + attrs + '>' + svg(fieldId, opts) +
      '<span class="c-placeholder__tag">' + esc(tag) + '</span></div>';
  }

  /**
   * data-URI 形式（供 <img src> 使用）。
   * ⚠️ CSS 变量在 data-URI 中无法解析，因此这里必须用字面色值：
   *    优先 opts.colors，其次从 site.fields[].color* 读取（数据驱动）。
   *    两者都没有时退回变量字符串（此时在 <img> 里不会着色，属预期降级）。
   */
  function dataUri(fieldId, opts) {
    opts = opts || {};
    var site = opts.site || global.SITE_DATA;
    var colors = opts.colors || fieldColors(fieldId, site) || {
      main: 'var(--field-color)',
      light: 'var(--field-color-light)',
      dark: 'var(--field-color-dark)'
    };
    var s = buildSvg(fieldId, colors).replace('class="c-placeholder__art" ', '');
    return 'data:image/svg+xml,' + encodeURIComponent(s);
  }

  var Placeholder = {
    FALLBACK_MESSAGES: FALLBACK_MESSAGES,
    messages: messages,
    msg: msg,
    svg: svg,
    markup: markup,
    dataUri: dataUri,
    fieldColors: fieldColors
  };

  global.Placeholder = Placeholder;
})(typeof window !== 'undefined' ? window : this);
