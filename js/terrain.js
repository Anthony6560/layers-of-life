/* ============================================================================
   terrain.js —— 地形计算（纯数学，**不碰 DOM**）
   ----------------------------------------------------------------------------
   职责（docs/08 §4）：把「内容量」变成「高度场」，再从高度场提取等高线。

   本文件是 v2.0 地形机制的全部数学落点，三个纯函数：
     buildHeightField(fields, works, notes, opts) → { data, n, max, … }
     extractContours(heightField, interval, opts) → [{ level, segments, isIndex }]
     traceContours(contours, heightField)         → [{ level, isIndex, rings }]
     hillshade(heightField, azimuth, altitude, opts) → Float32Array
     computeExtent(fields, heightField, sigma)    → { x0, y0, x1, y1 }

   设计约束：
     · 全部参数（σ / 权重 / REFERENCE / 等高距 / 网格数）从 SITE_DATA.terrain
       读取（readParams），**不写死**；缺数据时只回落到一组与 docs/08 §4.2
       逐字一致的缺省值，保证「数据文件损坏时地图仍在」（契约 §4.2）。
     · 零外部依赖、零 DOM 访问 —— 可直接在 Node 里跑数学自验。
     · 确定性：同一份数据永远得到同一张地图，不使用随机数（docs/08 §4.2）。

   命名空间（契约 §2.1）：只写 window.Scene._.Terrain，不新增全局变量。
   ============================================================================ */

(function installTerrain() {
  "use strict";

  if (!window.Scene) { window.Scene = {}; }
  var Scene = window.Scene;
  if (!Scene._) { Scene._ = {}; }

  /* ────────────────────────────────────────────────────────────────────────
     缺省参数 —— 与 docs/08 §4.2 / §4.3 的表格逐字一致。
     只有在 SITE_DATA.terrain 缺失（数据文件损坏）时才用到。
     ──────────────────────────────────────────────────────────────────────── */

  var DEFAULTS = {
    weightWork: 1.00,            /* 作品权重（§4.2 表） */
    weightNote: 0.35,            /* 印记权重：三条印记 ≈ 一件作品 */
    reference:  10,              /* 10 个当量 = 满高 */
    sigma:      0.12,            /* 山体半径**基准值**（§4.2.1 实测标定值） */
    breadthBase:   0.75,         /* 内容为零时的半径系数（§4.2） */
    breadthGrowth: 0.28,         /* 每单位内容当量带来的半径增量（§4.2） */
    contourInterval: 0.1,        /* 等高距 */
    tilt:       52,              /* 轴测倾斜角（度） */
    verticalExaggeration: 0.55,  /* 垂直夸张 VE */
    gridSize:   160,             /* 采样网格 160×160 */
    /* 湍流噪声（见文件头说明）。频率受网格约束，改了 gridSize 要一起复核。 */
    noiseAmp:     0.18,          /* 起伏幅度（乘性）：0.18 ≈ ±18% */
    noiseFreq:    11,            /* 基频（每单位长度的周期数） */
    noiseOctaves: 3,             /* 倍频数 */
    noiseLac:     2.0,           /* 倍频间隔 */
    noiseGain:    0.5,           /* 每倍频的幅度衰减 */
    noiseSeed:    20261001       /* 固定种子 —— 保证同一份数据永远同一张地图 */
  };

  /* 计曲线：**每 5 条等高线加粗一条**（制图惯例，§4.3）。
     ⚠️ 原注释把「每 5 条」与「0.5 的整数倍」当作等价，但那只在等高距 = 0.1 时成立。
     等高距改为 0.05 后两者分道扬镳（每 5 条 = 0.25 的整数倍）。
     以「每 5 条」为准 —— 它随等高距自动缩放，换任何等高距都成立。
     本常量仅在既未传 opts.indexInterval、又拿不到等高距时兜底。 */
  var INDEX_INTERVAL = 0.5;

  /** 计曲线间隔 = 5 × 等高距 */
  function indexIntervalFor(contourInterval) {
    var iv = (typeof contourInterval === "number" && contourInterval > 0) ? contourInterval : 0.1;
    return 5 * iv;
  }

  /* ────────────────────────────────────────────────────────────────────────
     参数读取
     ──────────────────────────────────────────────────────────────────────── */

  function num(v, fallback, min) {
    if (typeof v !== "number" || !isFinite(v)) { return fallback; }
    if (typeof min === "number" && v < min) { return fallback; }
    return v;
  }

  /**
   * 读取地形参数：opts > SITE_DATA.terrain > 内置缺省。
   * @param {Object} [opts] 覆盖项（同名字段）
   */
  function readParams(opts) {
    var d = (window.SITE_DATA && window.SITE_DATA.terrain) || {};
    var o = opts || {};
    function pick(key, min) {
      var v = o[key];
      if (typeof v !== "number" || !isFinite(v) || (typeof min === "number" && v < min)) { v = d[key]; }
      return num(v, DEFAULTS[key], min);
    }
    return {
      weightWork:           pick("weightWork", 0),
      weightNote:           pick("weightNote", 0),
      reference:            pick("reference", 1e-9),
      sigma:                pick("sigma", 1e-9),
      breadthBase:          pick("breadthBase", 0),
      breadthGrowth:        pick("breadthGrowth", 0),
      contourInterval:      pick("contourInterval", 1e-9),
      tilt:                 pick("tilt", 0),
      verticalExaggeration: pick("verticalExaggeration", 0),
      gridSize:             Math.max(2, Math.round(pick("gridSize", 2))),
      noiseAmp:             pick("noiseAmp", 0),
      noiseFreq:            pick("noiseFreq", 1e-9),
      noiseOctaves:         pick("noiseOctaves", 1),
      noiseLac:             pick("noiseLac", 1e-9),
      noiseGain:            pick("noiseGain", 0),
      noiseSeed:            Math.round(pick("noiseSeed", 0))
    };
  }

  /**
   * 单个场的山体半径（§4.2「每个场的实际山体半径随其内容量增长」）：
   *   σᵢ = σ_base · ( breadthBase + breadthGrowth · Aᵢ )
   * 内容多的场，山又高又宽；内容少的场，山又矮又窄。
   * @param {number} A 内容当量 0–1
   * @param {Object} p readParams() 的结果
   * @returns {number} σᵢ（归一化地图单位）
   */
  function sigmaFor(A, p) {
    var params = p || readParams();
    var a = (typeof A === "number" && isFinite(A)) ? A : 0;
    var s = params.sigma * (params.breadthBase + params.breadthGrowth * a);
    return (s > 0 && isFinite(s)) ? s : params.sigma;
  }

  /* ────────────────────────────────────────────────────────────────────────
     内容当量 Aᵢ（§4.2）
     Aᵢ = min( (作品数ᵢ × weightWork + 印记数ᵢ × weightNote) / reference , 1.0 )
     ──────────────────────────────────────────────────────────────────────── */

  /** 取字段 x / y（兼容 {x,y} 与 {nx,ny} 两种写法） */
  function posOf(f) {
    if (!f) { return { x: NaN, y: NaN }; }
    /* 接受三种形态：扁平 x/y、扁平 nx/ny、以及 SITE_DATA 原生的 position:{x,y}。
       最后一种必须有 —— 否则直接传 SITE_DATA.fields 时坐标全部为 undefined，
       被下面的 isFinite 检查静默跳过，得到一张全零高度场（地形变空白且不报错）。
       回归断言见 tests/terrain.test.js §10。 */
    var box = f.position || {};
    var x = (typeof f.x === "number") ? f.x : (typeof f.nx === "number") ? f.nx : box.x;
    var y = (typeof f.y === "number") ? f.y : (typeof f.ny === "number") ? f.ny : box.y;
    return { x: x, y: y };
  }

  /**
   * 计算每个场的内容当量与坐标。
   * @returns {Array} [{ id, x, y, works, notes, A }]
   */
  function contentEquivalents(fields, works, notes, params) {
    var p = params || readParams();
    var fs = fields || [], ws = works || [], ns = notes || [];
    var out = [], i, k;

    /* 先按 field 计数，避免 O(场数 × 条目数) 的重复扫描 */
    var wCount = {}, nCount = {};
    for (i = 0; i < ws.length; i++) {
      var wf = ws[i] && ws[i].field;
      if (wf) { wCount[wf] = (wCount[wf] || 0) + 1; }
    }
    for (i = 0; i < ns.length; i++) {
      var nf = ns[i] && ns[i].field;
      if (nf) { nCount[nf] = (nCount[nf] || 0) + 1; }
    }

    for (k = 0; k < fs.length; k++) {
      var f = fs[k] || {};
      var id = f.id;
      if (!id) { continue; }
      var w = wCount[id] || 0;
      var n = nCount[id] || 0;
      var A = (w * p.weightWork + n * p.weightNote) / p.reference;
      if (!(A > 0)) { A = 0; }          /* NaN / 负数一律归零 */
      if (A > 1) { A = 1; }             /* §4.2 上限：防止单个场压垮地形 */
      var pos = posOf(f);
      out.push({ id: id, x: pos.x, y: pos.y, works: w, notes: n, A: A });
    }
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     高度场（§4.2 + R-07 各向异性修正）
     ------------------------------------------------------------------------
     R-07（用户实测反馈）：各向同性高斯让**每个峰的等高线都是完美同心圆**，
     五座山看起来像五个靶心。真实的等高线是被拉长、不规则、有走向的闭合曲线。
     因此每个场的山体改为**各向异性高斯**（拉长的椭圆）：

       ratio ∈ [1.3, 1.9)   长轴/短轴比
       θ     ∈ [0, π)       长轴方向
       u = (  dx·cosθ + dy·sinθ ) / ( σᵢ·√ratio )
       v = ( −dx·sinθ + dy·cosθ ) / ( σᵢ/√ratio )
       hᵢ = Aᵢ · exp( −(u² + v²) / 2 )

     · ratio / θ **由 field id 哈希确定性推导**（hash01）：同一份数据永远同一张
       地图（§4.2 的确定性承诺），且**绝不使用 Math.random()**。
     · 用 √ratio 与 1/√ratio **对称**缩放 ⇒ 椭圆的面积与原来的圆基本相同，
       §4.2.1 的 σ 标定（鞍峰比 ≈ 0.40）因此仍然成立。
     · 峰心 (dx=dy=0) 处 u=v=0 ⇒ 高度**严格等于 Aᵢ**；Aᵢ = 0 的场直接跳过，
       贡献**严格为 0**。这两条都被 tests 断言锁住。

     ⚠️ 各向异性核**不可分离**（不能拆成 f(x)·g(y)），因此逐点求和：
       128² 网格 × 5 峰 ≈ 8 万次 exp，仍远低于 100ms/次 的预算。
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * id 哈希 → [0,1)。FNV-1a 变体：纯整数运算、确定、无随机数。
   * @param {string} s 场 id
   * @param {number} salt 用途盐（同 id 的不同参数用不同 salt）
   */
  function hash01(s, salt) {
    var str = String(s == null ? "" : s);
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= (salt >>> 0);
    h = Math.imul(h, 16777619) >>> 0;
    return (h >>> 8) / 16777216;              /* [0,1) */
  }

  var ANISO_MIN = 1.3, ANISO_SPAN = 0.6;      /* ratio ∈ [1.3, 1.9) */

  var anisoCache = {};

  /**
   * 某个场的山体形状（R-07）：拉长比与长轴方向，由 id 确定性推导。
   * @returns {{ratio:number, theta:number}}
   */
  function anisoFor(id) {
    var key = String(id == null ? "" : id);
    var hit = anisoCache[key];
    if (hit) { return hit; }
    var r = ANISO_MIN + ANISO_SPAN * hash01(key, 1);
    var v = {
      ratio: r,
      theta: Math.PI * hash01(key, 2),
      /* 预计算的缩放因子与三角函数（每帧不必重算） */
      su: Math.sqrt(r),          /* 长轴半宽系数：σ·√ratio */
      sv: 1 / Math.sqrt(r),      /* 短轴半宽系数：σ/√ratio */
      cos: 0, sin: 0
    };
    v.cos = Math.cos(v.theta);
    v.sin = Math.sin(v.theta);
    anisoCache[key] = v;
    return v;
  }

  /* 采样域相对"内容包围盒 + 2σ"再外扩的安全量（单位：σ）。
     用 3σ 而非 2σ：最低一级等高线（0.1）在 A≈0.65 时的半径是 1.93σ，
     留 3σ 才能保证**最外层等高线完整落在网格内**，不被裁平（R-06）。 */
  var DOMAIN_PAD_SIGMA = 3.0;

  /**
   * 构建高度场。
   *
   * ⚠️ 采样域不是死的 [0,1]（docs/08 §4.6）：场位置分布 0.14–0.82，而每个高斯
   *    的影响半径约 2.5σ，地形实际横跨约 −0.11 ~ 1.07。若网格只覆盖 [0,1]，
   *    靠边的山（本数据里的「场」「味道」「节奏」）最外层等高线会被切平。
   *    因此采样域 = 活跃场包围盒外扩 3·max(σᵢ)，并与 [0,1] 取并集；
   *    返回的 x0/y0/x1/y1 就是网格所覆盖的**地图坐标矩形**。
   *
   * @param {Array} fields - [{ id, x, y }]（归一化坐标）
   * @param {Array} works  - [{ field }]
   * @param {Array} notes  - [{ field }]
   * @param {Object} [opts] - 参数覆盖（sigma / breadthBase / breadthGrowth / gridSize / …）
   * @returns {{data:Float32Array, n:number, max:number, x0:number, y0:number,
   *            x1:number, y1:number, cellX:number, cellY:number,
   *            sigma:number, sigmaMax:number, params:Object, points:Array}}
   */
  /* ────────────────────────────────────────────────────────────────────────
     湍流噪声（value noise + fBm）
     ────────────────────────────────────────────────────────────────────────
     为什么需要它：没有噪声时，高度场是若干解析高斯的和 —— 一个**完美光滑的
     数学曲面**。从它提取出来的等高线必然是规则的椭圆，一眼就能看出是算出来的，
     不像地形。

     正确做法（也是用户指出的）：**先生成带噪声的地形场，再从中提取等高线**。
     这样曲面与等高线共用同一个真实感场，等高线自然就不规则了。

     三条硬约束：
     ① **完全确定性** —— 严禁 Math.random。同一份数据必须永远得到同一张地图，
        否则「地形是内容的函数」这个核心承诺就破了。
     ② **必须乘性，不能加性** —— 加性噪声会让 base=0 的空白区也长出地形，
        破坏「没有内容的地方就是一张白纸」。乘性同时保住 A=0 ⇒ h=0。
     ③ **频率要受网格分辨率约束** —— marching squares 在 128/160 的网格上做，
        噪声波长必须 ≥ 4 个格距，否则等高线会走样（混叠）。
        当前配置：格距 ≈ 0.0084，最高频 11×2² = 44 → 波长 0.023 ≈ 2.7 格 ——
        已接近下限，再提高频次或倍频数会开始混叠。
     ──────────────────────────────────────────────────────────────────────── */
  function hash2(ix, iy, seed) {
    var h = (seed >>> 0) ^ Math.imul(ix | 0, 374761393);
    h = Math.imul(h ^ (iy | 0), 668265263) >>> 0;
    h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0; h ^= h >>> 16;
    return (h >>> 8) / 16777216;                       /* [0, 1) */
  }
  function valueNoise(x, y, seed) {
    var x0 = Math.floor(x), y0 = Math.floor(y);
    var fx = x - x0, fy = y - y0;
    var sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);   /* smoothstep */
    var n00 = hash2(x0, y0, seed), n10 = hash2(x0 + 1, y0, seed);
    var n01 = hash2(x0, y0 + 1, seed), n11 = hash2(x0 + 1, y0 + 1, seed);
    var a = n00 + (n10 - n00) * sx, b = n01 + (n11 - n01) * sx;
    return a + (b - a) * sy;                           /* [0, 1) */
  }
  function fbm(x, y, oct, lac, gain, seed) {
    var amp = 1, frq = 1, sum = 0, norm = 0, i;
    var o = Math.max(1, Math.round(oct));
    for (i = 0; i < o; i++) {
      sum += amp * valueNoise(x * frq, y * frq, seed + i * 131);
      norm += amp;
      amp *= gain; frq *= lac;
    }
    return norm > 0 ? sum / norm : 0.5;                /* [0, 1) */
  }

  function buildHeightField(fields, works, notes, opts) {
    var p = readParams(opts);
    var n = p.gridSize;
    var cells = n - 1;
    var data = new Float32Array(n * n);
    var pts = contentEquivalents(fields, works, notes, p);

    /* 只累加 A>0 且坐标有效的场 —— A=0 的场对 h 的贡献严格是 0 */
    var act = [], i, j, a;
    var ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
    for (i = 0; i < pts.length; i++) {
      var q = pts[i];
      q.sigma = sigmaFor(q.A, p);          /* σᵢ 随该场内容量增长（§4.2） */
      if (q.A > 0 && isFinite(q.x) && isFinite(q.y)) {
        act.push(q);
        if (q.x < ax0) { ax0 = q.x; }
        if (q.x > ax1) { ax1 = q.x; }
        if (q.y < ay0) { ay0 = q.y; }
        if (q.y > ay1) { ay1 = q.y; }
      }
    }

    var sMax = maxSigma(pts, p);
    var pad = DOMAIN_PAD_SIGMA * sMax;

    /* 采样域：活跃场包围盒外扩 pad，再与 [0,1]² 取并集（平坦时即 [0,1]²） */
    var gx0, gy0, gx1, gy1;
    if (act.length) {
      gx0 = Math.min(0, ax0 - pad); gy0 = Math.min(0, ay0 - pad);
      gx1 = Math.max(1, ax1 + pad); gy1 = Math.max(1, ay1 + pad);
    } else {
      gx0 = 0; gy0 = 0; gx1 = 1; gy1 = 1;
    }
    var cellX = (gx1 - gx0) / cells;
    var cellY = (gy1 - gy0) / cells;

    var max = 0;

    if (act.length) {
      var m = act.length;
      /* ⚠️ σᵢ 与 (ratio, θ) 都是**每个峰各自**的，绝不上提到循环外。
         各向异性核不可分离 → 逐峰全网格累加。 */
      for (a = 0; a < m; a++) {
        var pk = act[a];
        var an = anisoFor(pk.id);
        var sigU = pk.sigma * an.su;                 /* σᵢ·√ratio */
        var sigV = pk.sigma * an.sv;                 /* σᵢ/√ratio */
        var i2u = 1 / (2 * sigU * sigU);
        var i2v = 1 / (2 * sigV * sigV);
        var ct = an.cos, st = an.sin;
        var amp = pk.A;

        for (j = 0; j < n; j++) {
          var dy = (gy0 + j * cellY) - pk.y;
          /* 把 dy 的贡献提到内层之前：u 的 dy 项、v 的 dy 项都是常数 */
          var uy = dy * st, vy = dy * ct;
          var row = j * n;
          for (i = 0; i < n; i++) {
            var dx = (gx0 + i * cellX) - pk.x;
            var u = dx * ct + uy;
            var v = -dx * st + vy;
            data[row + i] += amp * Math.exp(-(u * u * i2u + v * v * i2v));
          }
        }
      }
      /* ② 乘性湍流噪声：把光滑的解析曲面变成真实地形。
            乘性（而不是加性）保证空白区严格保持 0 —— 见文件头的三条约束。 */
      if (p.noiseAmp > 0) {
        var nf = p.noiseFreq, no = p.noiseOctaves, nl = p.noiseLac,
            ng = p.noiseGain, ns = p.noiseSeed, na = p.noiseAmp;
        for (j = 0; j < n; j++) {
          var ny = (gy0 + j * cellY) * nf;
          var row2 = j * n;
          for (i = 0; i < n; i++) {
            var v0 = data[row2 + i];
            if (v0 <= 0) { continue; }          /* 空场严格保持 0，绝不因噪声长出地形 */
            var nz = fbm((gx0 + i * cellX) * nf, ny, no, nl, ng, ns);
            data[row2 + i] = v0 * (1 + na * (nz * 2 - 1));
          }
        }
      }

      for (i = 0; i < data.length; i++) {
        if (data[i] > max) { max = data[i]; }
      }
    }

    return {
      data: data,
      n: n,
      max: max,
      x0: gx0, y0: gy0, x1: gx1, y1: gy1,
      cellX: cellX, cellY: cellY,
      sigma: p.sigma,
      sigmaMax: sMax,
      params: p,
      points: pts
    };
  }

  /* ────────────────────────────────────────────────────────────────────────
     远景低起伏高度场
     ------------------------------------------------------------------------
     与内容山完全独立：它只提供环境纵深，不改变作品数量对应的峰高。
     一组确定性的各向异性高斯脊线形成基础地貌，再叠加低频乘性噪声；
     最终统一归一到 relief，保证远景永远低于内容山。
     ──────────────────────────────────────────────────────────────────────── */
  function buildAmbientHeightField(opts) {
    var o = opts || {};
    var ext = o.extent || {};
    var x0 = isFinite(ext.x0) ? Number(ext.x0) : -0.65;
    var y0 = isFinite(ext.y0) ? Number(ext.y0) : -0.78;
    var x1 = isFinite(ext.x1) ? Number(ext.x1) : 1.62;
    var y1 = isFinite(ext.y1) ? Number(ext.y1) : 0.34;
    if (!(x1 > x0)) { x0 = -0.65; x1 = 1.62; }
    if (!(y1 > y0)) { y0 = -0.78; y1 = 0.34; }
    var n = Math.max(32, Math.round(num(o.gridSize, 112, 32)));
    var relief = num(o.relief, 0.14, 0.001);
    var interval = num(o.contourInterval, 0.025, 0.001);
    var count = Math.max(3, Math.min(32, Math.round(num(o.ridgeCount, 18, 3))));
    var seed = Math.round(num(o.seed, 20261002, 0));
    var cellX = (x1 - x0) / (n - 1), cellY = (y1 - y0) / (n - 1);
    var data = new Float32Array(n * n), ridges = [];
    var spanX = x1 - x0, spanY = y1 - y0;
    /* 远景必须覆盖整个视口，而不是在主体后方排成一条山脊。
       用带抖动的二维网格布置低矮山丘：确定性不变，同时让四周都有地形，
       采样域边缘仍在屏幕外渐隐，画面内不会出现突然的空白带。 */
    var aspect = spanX / Math.max(spanY, 1e-6);
    var cols = Math.max(2, Math.ceil(Math.sqrt(count * aspect)));
    var rows = Math.max(2, Math.ceil(count / cols));
    var cellSpanX = spanX / cols, cellSpanY = spanY / rows;

    for (var r = 0; r < count; r++) {
      var col = r % cols, row = Math.floor(r / cols);
      ridges.push({
        x: x0 + (col + 0.18 + hash2(r, 11, seed) * 0.64) * cellSpanX,
        y: y0 + (row + 0.18 + hash2(r, 23, seed) * 0.64) * cellSpanY,
        amp: 0.42 + hash2(r, 37, seed) * 0.58,
        sx: cellSpanX * (0.72 + hash2(r, 41, seed) * 0.70),
        sy: cellSpanY * (0.52 + hash2(r, 53, seed) * 0.58),
        theta: (-Math.PI * 0.38 + hash2(r, 67, seed) * Math.PI * 0.76)
      });
    }

    var max = 0;
    for (var j = 0; j < n; j++) {
      var yy = y0 + j * cellY;
      var edgeY = Math.sin(Math.PI * (j / (n - 1)));
      for (var i = 0; i < n; i++) {
        var xx = x0 + i * cellX;
        var edgeX = Math.sin(Math.PI * (i / (n - 1)));
        var h = 0;
        for (r = 0; r < ridges.length; r++) {
          var q = ridges[r], dx = xx - q.x, dy = yy - q.y;
          var ct = Math.cos(q.theta), st = Math.sin(q.theta);
          var a = dx * ct + dy * st, b = -dx * st + dy * ct;
          h += q.amp * Math.exp(-0.5 * (a * a / (q.sx * q.sx) + b * b / (q.sy * q.sy)));
        }
        var noise = fbm(xx * 3.2, yy * 3.2, 3, 2, 0.5, seed + 701);
        h *= 0.84 + noise * 0.28;
        /* 渐隐只发生在远超视口的采样域边缘，指数降低可避免画面四周
           在最低等高距之前过早归零。 */
        h *= Math.pow(Math.max(0, edgeX * edgeY), 0.22);
        data[j * n + i] = h;
        if (h > max) { max = h; }
      }
    }

    var k = max > 0 ? relief / max : 0;
    for (var p = 0; p < data.length; p++) { data[p] *= k; }
    return {
      data: data, n: n, max: relief,
      x0: x0, y0: y0, x1: x1, y1: y1,
      cellX: cellX, cellY: cellY,
      params: { contourInterval: interval, relief: relief, seed: seed },
      ridges: ridges
    };
  }

  /**
   * 把内容地形与环境地形采样到同一张高度场。
   * 两类地形仍可分别生成和着色，但等高线必须只从这张合成场提取一次，
   * 否则主体边缘会出现两套互不相干的线。
   */
  function combineHeightFields(content, ambient, opts) {
    var c = content || {}, a = ambient || {}, o = opts || {};
    if (!c.data || !c.n) { return a; }
    if (!a.data || !a.n) { return c; }

    var offsetX = isFinite(o.offsetX) ? Number(o.offsetX) : 0;
    var offsetY = isFinite(o.offsetY) ? Number(o.offsetY) : 0;
    var ambientScale = isFinite(o.ambientScale) ? Number(o.ambientScale) : 1;
    var ambientPhase = isFinite(o.ambientPhase) ? Number(o.ambientPhase) : 0;
    var ambientWarp = isFinite(o.ambientWarp) ? Math.max(0, Number(o.ambientWarp)) : 0;
    var x0 = Math.min(c.x0, a.x0 + offsetX), y0 = Math.min(c.y0, a.y0 + offsetY);
    var x1 = Math.max(c.x1, a.x1 + offsetX), y1 = Math.max(c.y1, a.y1 + offsetY);
    var n = Math.max(32, Math.round(Number(o.gridSize) || Math.max(c.n, a.n)));
    var cells = n - 1;
    var cellX = (x1 - x0) / cells, cellY = (y1 - y0) / cells;
    var data = new Float32Array(n * n), max = 0;

    function sampleInside(hf, x, y) {
      if (x < hf.x0 || x > hf.x1 || y < hf.y0 || y > hf.y1) { return 0; }
      return sampleBilinear(hf, x, y);
    }

    for (var j = 0; j < n; j++) {
      var y = y0 + j * cellY;
      for (var i = 0; i < n; i++) {
        var x = x0 + i * cellX;
        /* 远景内部使用两个方向不同的低频波场。每个区域拥有不同相位，
           因而会错峰隆起和回落，而不是整张地形同步呼吸。 */
        var contentH = sampleInside(c, x, y);
        /* warp=0 是公开的静态合成路径，保持原有“平移后采样 × 比例”契约。 */
        if (ambientWarp <= 0) {
          var staticH = contentH + sampleInside(a, x - offsetX, y - offsetY) * ambientScale;
          data[j * n + i] = staticH;
          if (staticH > max) { max = staticH; }
          continue;
        }
        var protect = Math.max(0, Math.min(1, contentH / 0.12));
        protect = protect * protect * (3 - 2 * protect);
        var dynamicWeight = 1 - protect;
        var ax = x - offsetX * dynamicWeight, ay = y - offsetY * dynamicWeight;
        var ux = (ax - a.x0) / Math.max(1e-6, a.x1 - a.x0);
        var uy = (ay - a.y0) / Math.max(1e-6, a.y1 - a.y0);
        var waveA = Math.sin(ambientPhase + ux * Math.PI * 3.2 + uy * Math.PI * 1.4);
        var waveB = Math.cos(ambientPhase * 2 - ux * Math.PI * 1.1 + uy * Math.PI * 3.6);
        var localPulse = 1 + dynamicWeight * ambientWarp * (waveA * 0.68 + waveB * 0.32);
        var bendX = dynamicWeight * ambientWarp * 0.055 *
          Math.sin(ambientPhase + uy * Math.PI * 2.4);
        var bendY = dynamicWeight * ambientWarp * 0.040 *
          Math.cos(ambientPhase * 2 + ux * Math.PI * 2.1);
        var staticAmbient = sampleInside(a, x, y);
        var movingAmbient = sampleInside(a, ax + bendX, ay + bendY) *
          ambientScale * Math.max(0.55, localPulse);
        var ambientH = staticAmbient * protect + movingAmbient * dynamicWeight;
        var h = contentH + ambientH;
        data[j * n + i] = h;
        if (h > max) { max = h; }
      }
    }

    var cp = c.params || {};
    return {
      data: data, n: n, max: max,
      x0: x0, y0: y0, x1: x1, y1: y1,
      cellX: cellX, cellY: cellY,
      sigma: c.sigma, sigmaMax: c.sigmaMax,
      params: {
        contourInterval: Number(o.contourInterval) > 0
          ? Number(o.contourInterval) : cp.contourInterval,
        combined: true,
        ambientScale: ambientScale,
        ambientPhase: ambientPhase,
        ambientWarp: ambientWarp,
        offsetX: offsetX,
        offsetY: offsetY
      },
      points: c.points || []
    };
  }

  /** 所有场中最大的 σᵢ（§4.6 的 extent 扩张量取 2·max(σᵢ)） */
  function maxSigma(pts, p) {
    var s = 0;
    for (var i = 0; i < (pts || []).length; i++) {
      var v = pts[i].sigma;
      if (typeof v !== "number" || !isFinite(v)) { v = sigmaFor(pts[i].A, p); }
      if (v > s) { s = v; }
    }
    return s || (p || readParams()).sigma;
  }

  /** 地图坐标 → 网格浮点索引（列 / 行） */
  function gridIndex(hf, x, y) {
    return { fi: (x - hf.x0) / hf.cellX, fj: (y - hf.y0) / hf.cellY };
  }

  /** 网格索引 → 地图坐标 */
  function mapCoord(hf, i, j) {
    return { x: hf.x0 + i * hf.cellX, y: hf.y0 + j * hf.cellY };
  }

  /** 双线性采样（网格外按边缘钳制）。等高线的线性插值即以此为前提。 */
  function sampleBilinear(hf, x, y) {
    if (!hf || !hf.data) { return 0; }
    var n = hf.n, data = hf.data, cells = n - 1;
    var g = gridIndex(hf, x, y);
    var i = Math.floor(g.fi), j = Math.floor(g.fj);
    if (i < 0) { i = 0; } if (i > cells - 1) { i = cells - 1; }
    if (j < 0) { j = 0; } if (j > cells - 1) { j = cells - 1; }
    var tx = g.fi - i, ty = g.fj - j;
    if (tx < 0) { tx = 0; } if (tx > 1) { tx = 1; }
    if (ty < 0) { ty = 0; } if (ty > 1) { ty = 1; }
    var v00 = data[j * n + i], v10 = data[j * n + i + 1];
    var v01 = data[(j + 1) * n + i], v11 = data[(j + 1) * n + i + 1];
    var top = v00 + (v10 - v00) * tx;
    var bot = v01 + (v11 - v01) * tx;
    return top + (bot - top) * ty;
  }

  /** 中心差分梯度（高度/地图长度）。供密度衰减（R-9）与坡度使用。 */
  function gradientAt(hf, x, y) {
    if (!hf || !hf.data) { return { gx: 0, gy: 0 }; }
    var n = hf.n, data = hf.data;
    var g = gridIndex(hf, x, y);
    var i = Math.round(g.fi), j = Math.round(g.fj);
    if (i < 0) { i = 0; } if (i > n - 1) { i = n - 1; }
    if (j < 0) { j = 0; } if (j > n - 1) { j = n - 1; }
    var i0 = i > 0 ? i - 1 : i, i1 = i < n - 1 ? i + 1 : i;
    var j0 = j > 0 ? j - 1 : j, j1 = j < n - 1 ? j + 1 : j;
    var gx = (data[j * n + i1] - data[j * n + i0]) / ((i1 - i0) * hf.cellX);
    var gy = (data[j1 * n + i] - data[j0 * n + i]) / ((j1 - j0) * hf.cellY);
    return { gx: gx, gy: gy };
  }

  /* ────────────────────────────────────────────────────────────────────────
     等高线提取 —— Marching Squares（§4.3）
     ------------------------------------------------------------------------
     格点约定：n×n 个格点，第 i 列 / 第 j 行位于 (i/(n−1), j/(n−1))。
     单元格 (i,j) 的四角：
        v00 = (i,   j  )   v10 = (i+1, j  )
        v01 = (i,   j+1)   v11 = (i+1, j+1)
     四条边：T(top, v00–v10) R(right, v10–v11) B(bottom, v01–v11) L(left, v00–v01)

     等值点一律用**线性插值**求出（t = (level − va)/(vb − va)），
     绝不取整到格点 —— 否则会出现明显的锯齿阶梯。

     鞍点（case 5 / 10）用双线性鞍点值判别：
        S = (v00·v11 − v10·v01) / (v00 + v11 − v10 − v01)
     这是 marching squares 的标准 asymptotic decider，比取四角平均更准确。
     ──────────────────────────────────────────────────────────────────────── */

  /** level 是否为计曲线（0.5 的整数倍，docs/08 §4.3） */
  function isIndexLevel(level, indexInterval) {
    var ii = (typeof indexInterval === "number" && indexInterval > 0) ? indexInterval : INDEX_INTERVAL;
    var q = level / ii;
    return Math.abs(q - Math.round(q)) < 1e-6;
  }

  /**
   * 从高度场提取等值线。
   * @param {Object} hf - buildHeightField 的返回值
   * @param {number} interval - 等高距（缺省取 SITE_DATA.terrain.contourInterval）
   * @param {Object} [opts] - { indexInterval, maxLevels }
   * @returns {Array} [{ level, segments: [[x1,y1,x2,y2], …], isIndex }]
   *          segments 的坐标是**归一化地图坐标** 0–1，且按行（j 升序）生成，
   *          即「远 → 近」，可直接用于 painter's algorithm（§4.4）。
   */
  function extractContours(hf, interval, opts) {
    var out = [];
    if (!hf || !hf.data || !(hf.n >= 2)) { return out; }

    var p = hf.params || readParams();
    var iv = (typeof interval === "number" && interval > 0) ? interval : p.contourInterval;
    var n = hf.n, data = hf.data, cells = n - 1;
    var ox = hf.x0, oy = hf.y0, cx = hf.cellX, cy = hf.cellY;
    var indexInterval = (opts && opts.indexInterval) || indexIntervalFor(iv);
    var maxLevels = (opts && opts.maxLevels) || 4096;

    if (!(hf.max > 0)) { return out; }          /* 一片诚实的平原：没有任何线 */

    /* 层级：interval, 2·interval, … ≤ h_max（§4.3） */
    var levels = [], k = 1;
    while (k * iv <= hf.max + 1e-9 && levels.length < maxLevels) {
      levels.push(k * iv);
      k++;
    }

    for (var L = 0; L < levels.length; L++) {
      var level = levels[L];
      var segs = [];
      for (var j = 0; j < cells; j++) {
        var r0 = j * n, r1 = r0 + n;
        for (var i = 0; i < cells; i++) {
          var v00 = data[r0 + i],     v10 = data[r0 + i + 1];
          var v01 = data[r1 + i],     v11 = data[r1 + i + 1];

          /* 快速排除：level 不在四角值域内 → 该格无交线。
             用 <= / >= 是为了同时排除「等高线恰好擦过某个角点」的退化格，
             相邻格仍会在共享边上给出同一个插值点，连通性不受影响。 */
          var mn = v00, mx = v00;
          if (v10 < mn) { mn = v10; } else if (v10 > mx) { mx = v10; }
          if (v11 < mn) { mn = v11; } else if (v11 > mx) { mx = v11; }
          if (v01 < mn) { mn = v01; } else if (v01 > mx) { mx = v01; }
          if (level <= mn || level >= mx) { continue; }

          var c = (v00 > level ? 1 : 0) | (v10 > level ? 2 : 0) |
                  (v11 > level ? 4 : 0) | (v01 > level ? 8 : 0);
          if (c === 0 || c === 15) { continue; }

          /* 四条边上的等值点，**线性插值**求出（归一化地图坐标）。
             未跨越 level 的边上，分母为 0，此时该点必不被引用（对应角点
             在 case 位掩码里同号），置为该角点本身即可。 */
          var dT = v10 - v00, dR = v11 - v10, dB = v11 - v01, dL = v01 - v00;
          var tT = dT !== 0 ? (level - v00) / dT : 0;
          var tR = dR !== 0 ? (level - v10) / dR : 0;
          var tB = dB !== 0 ? (level - v01) / dB : 0;
          var tL = dL !== 0 ? (level - v00) / dL : 0;

          /* 网格索引 → **地图坐标**（采样域未必是 [0,1]，见 buildHeightField） */
          var Tx = ox + (i + tT) * cx, Ty = oy + j * cy;
          var Rx = ox + (i + 1) * cx,  Ry = oy + (j + tR) * cy;
          var Bx = ox + (i + tB) * cx, By = oy + (j + 1) * cy;
          var Lx = ox + i * cx,        Ly = oy + (j + tL) * cy;

          switch (c) {
            case 1:  segs.push([Lx, Ly, Tx, Ty]); break;
            case 2:  segs.push([Tx, Ty, Rx, Ry]); break;
            case 3:  segs.push([Lx, Ly, Rx, Ry]); break;
            case 4:  segs.push([Rx, Ry, Bx, By]); break;
            case 6:  segs.push([Tx, Ty, Bx, By]); break;
            case 7:  segs.push([Lx, Ly, Bx, By]); break;
            case 8:  segs.push([Bx, By, Lx, Ly]); break;
            case 9:  segs.push([Tx, Ty, Bx, By]); break;
            case 11: segs.push([Rx, Ry, Bx, By]); break;
            case 12: segs.push([Lx, Ly, Rx, Ry]); break;
            case 13: segs.push([Tx, Ty, Rx, Ry]); break;
            case 14: segs.push([Lx, Ly, Tx, Ty]); break;
            case 5: {                       /* 鞍点：TL 与 BR 在上 */
              var den5 = v00 + v11 - v10 - v01;
              var s5 = Math.abs(den5) < 1e-12
                ? (v00 + v10 + v11 + v01) / 4
                : (v00 * v11 - v10 * v01) / den5;
              if (s5 > level) {
                segs.push([Tx, Ty, Rx, Ry]); segs.push([Bx, By, Lx, Ly]);
              } else {
                segs.push([Lx, Ly, Tx, Ty]); segs.push([Rx, Ry, Bx, By]);
              }
              break;
            }
            case 10: {                      /* 鞍点：TR 与 BL 在上 */
              var den10 = v00 + v11 - v10 - v01;
              var s10 = Math.abs(den10) < 1e-12
                ? (v00 + v10 + v11 + v01) / 4
                : (v00 * v11 - v10 * v01) / den10;
              if (s10 > level) {
                segs.push([Lx, Ly, Tx, Ty]); segs.push([Rx, Ry, Bx, By]);
              } else {
                segs.push([Tx, Ty, Rx, Ry]); segs.push([Bx, By, Lx, Ly]);
              }
              break;
            }
            default: break;
          }
        }
      }
      out.push({ level: level, segments: segs, isIndex: isIndexLevel(level, indexInterval) });
    }
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     等高线追踪（docs/10 §4.2）—— 把无序线段连成闭合环
     ------------------------------------------------------------------------
     extractContours() 产出的是**无序线段**（marching squares 逐格生成），
     无法直接填充。地层板需要的是「区域边界」，因此这里把它们按端点接成
     闭合多边形。

     连接规则（docs/10 §4.2）：
       · 端点用**量化哈希**匹配 —— 浮点端点不会精确相等，
         量化容差取**格距 × TRACE_EPS**（1e-6）
       · 只有首尾闭合的链条才输出；**碰到采样域边界的开口链条一律舍弃**
         （强行闭合会在图边缘拉出一条不存在的假边）

     输出： [{ level, isIndex, rings: [ [[x,y],[x,y],…], … ] }]
           环上首尾点**显式重复**（ring[last] 与 ring[0] 量化后相等），
           调用方可直接 moveTo/lineTo 后 closePath 填充。
     ──────────────────────────────────────────────────────────────────────── */

  var TRACE_EPS = 1e-6;   /* 量化容差 = 格距 × 1e-6（docs/10 §4.2） */

  /** 端点 → 量化键（格距的 1e-6 为量化步长） */
  function quantKey(x, y, q) {
    return Math.round(x * q) + "," + Math.round(y * q);
  }

  /** 把同一层级的一条线段索引塞进端点桶 */
  function pushRef(idx, key, seg, end) {
    var arr = idx[key];
    if (!arr) { arr = []; idx[key] = arr; }
    arr.push({ s: seg, e: end });
  }

  /**
   * 把一层的无序线段接成闭合环。
   * @param {Array} segs - [[x1,y1,x2,y2], …]
   * @param {number} q - 量化倒数（1 / 容差）
   * @returns {Array} 闭合环数组（开口链条已丢弃）
   */
  function connectRings(segs, q) {
    var n = segs.length;
    var used = new Uint8Array(n);
    var idx = {};
    var i, k;

    for (i = 0; i < n; i++) {
      var s = segs[i];
      if (!s || s.length < 4 ||
          !isFinite(s[0]) || !isFinite(s[1]) || !isFinite(s[2]) || !isFinite(s[3])) {
        used[i] = 1;                       /* 脏数据：当作已用，永不参与 */
        continue;
      }
      pushRef(idx, quantKey(s[0], s[1], q), i, 0);
      pushRef(idx, quantKey(s[2], s[3], q), i, 1);
    }

    var rings = [];
    for (i = 0; i < n; i++) {
      if (used[i]) { continue; }
      used[i] = 1;

      var s0 = segs[i];
      var pts = [[s0[0], s0[1]], [s0[2], s0[3]]];
      var startKey = quantKey(s0[0], s0[1], q);
      var curKey = quantKey(s0[2], s0[3], q);
      var closed = false;
      var guard = 0;

      while (guard++ <= n) {
        if (curKey === startKey) { closed = true; break; }
        var cand = idx[curKey];
        if (!cand) { break; }              /* 走到头仍未闭合：开口链条 */
        var next = null;
        for (k = 0; k < cand.length; k++) {
          if (!used[cand[k].s]) { next = cand[k]; break; }
        }
        if (!next) { break; }
        used[next.s] = 1;
        var sg = segs[next.s];
        /* 进入端 = 桶里的那一端；要接的是**另一端** */
        var rx = next.e === 0 ? sg[2] : sg[0];
        var ry = next.e === 0 ? sg[3] : sg[1];
        pts.push([rx, ry]);
        curKey = quantKey(rx, ry, q);
      }

      /* 至少 3 个不同顶点才构成面；首尾显式闭合 */
      if (closed && pts.length >= 4) {
        pts.push([pts[0][0], pts[0][1]]);
        rings.push(pts);
      }
    }
    return rings;
  }

  /**
   * 等高线追踪（docs/10 §4.2）。
   * @param {Array} contours - extractContours 的返回值
   * @param {Object} hf - 高度场（只用它的格距定容差）
   * @returns {Array} [{ level, isIndex, rings }]（只含至少有一个闭合环的层级）
   */
  function traceContours(contours, hf) {
    var out = [];
    if (!contours || !contours.length) { return out; }

    /* 容差来自**格距**：它同时是等值点间距的下界量级 */
    var cell = 1;
    if (hf && isFinite(hf.cellX) && hf.cellX > 0) { cell = hf.cellX; }
    else if (hf && isFinite(hf.cellY) && hf.cellY > 0) { cell = hf.cellY; }
    var tol = cell * TRACE_EPS;
    if (!(tol > 0) || !isFinite(tol)) { tol = TRACE_EPS; }
    var q = 1 / tol;

    for (var L = 0; L < contours.length; L++) {
      var lv = contours[L];
      var segs = lv && lv.segments;
      if (!segs || !segs.length) { continue; }
      var rings = connectRings(segs, q);
      if (rings.length) {
        out.push({ level: lv.level, isIndex: !!lv.isIndex, rings: rings });
      }
    }
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     山体阴影（§4.5）—— 标准地形晕渲
     方位角 315°（西北光源，制图学惯例）、高度角 45°。
     表面法线 n = (−p, −q, 1)，光向量 L = (cosα·sinθ, −cosα·cosθ, sinα)
     （θ = 方位角，α = 高度角；屏幕坐标 x 向右 = 东，y 向下 = 南，
       因此「西北光」的水平分量指向左上 = (−, −)）。
     shade = clamp( dot(n̂, L), 0, 1 )
     ──────────────────────────────────────────────────────────────────────── */

  /**
   * @param {Object} hf - 高度场
   * @param {number} azimuth  - 方位角（度，正北为 0，顺时针）
   * @param {number} altitude - 高度角（度）
   * @param {Object} [opts] - { zScaleX, zScaleY }：把归一化高差换算成屏幕坡度的系数
   * @returns {Float32Array} n×n 的明暗值 0–1
   */
  function hillshade(hf, azimuth, altitude, opts) {
    var out = new Float32Array(hf ? hf.n * hf.n : 0);
    if (!hf || !hf.data || !(hf.n >= 2)) { return out; }

    var n = hf.n, data = hf.data, cells = n - 1, cell = 1 / cells;
    var o = opts || {};
    var zx = (typeof o.zScaleX === "number" && isFinite(o.zScaleX)) ? o.zScaleX : 1;
    var zy = (typeof o.zScaleY === "number" && isFinite(o.zScaleY)) ? o.zScaleY : 1;

    var az = ((azimuth == null ? 315 : azimuth)) * Math.PI / 180;
    var al = ((altitude == null ? 45 : altitude)) * Math.PI / 180;
    var Lx = Math.cos(al) * Math.sin(az);
    var Ly = -Math.cos(al) * Math.cos(az);
    var Lz = Math.sin(al);

    for (var j = 0; j < n; j++) {
      var j0 = j > 0 ? j - 1 : j, j1 = j < n - 1 ? j + 1 : j;
      for (var i = 0; i < n; i++) {
        var i0 = i > 0 ? i - 1 : i, i1 = i < n - 1 ? i + 1 : i;
        var p = ((data[j * n + i1] - data[j * n + i0]) / ((i1 - i0) * cell)) * zx;
        var q = ((data[j1 * n + i] - data[j0 * n + i]) / ((j1 - j0) * cell)) * zy;
        var s = (-p * Lx - q * Ly + Lz) / Math.sqrt(p * p + q * q + 1);
        out[j * n + i] = s < 0 ? 0 : (s > 1 ? 1 : s);
      }
    }
    return out;
  }

  /* ────────────────────────────────────────────────────────────────────────
     广度自适应（§4.6）
     extent = 所有 Aᵢ > 0 的场的包围盒，向外扩张 2·max(σᵢ)
     若全部为 0 → 退化为所有场位置的最小包围盒（保证地标可见）

     ⚠️ 地形会溢出归一化单位方格 [0,1]（场位置 0.14–0.82，影响半径 ≈2.5σ），
        实测横跨约 −0.11 ~ 1.07。extent 允许越界，世界坐标不做硬边界。
     ──────────────────────────────────────────────────────────────────────── */

  function computeExtent(fields, hf, sigma) {
    var fs = fields || [];
    var p = (hf && hf.params) || readParams();
    /* 扩张量 = 2·max(σᵢ)；显式传入的 sigma 优先 */
    var sg = (typeof sigma === "number" && sigma > 0) ? sigma
           : ((hf && hf.sigmaMax) || maxSigma((hf && hf.points) || [], p));

    var ax0 = Infinity, ay0 = Infinity, ax1 = -Infinity, ay1 = -Infinity;
    var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    var hasActive = false;

    for (var i = 0; i < fs.length; i++) {
      var f = fs[i];
      var pos = posOf(f);
      if (!isFinite(pos.x) || !isFinite(pos.y)) { continue; }

      if (pos.x < bx0) { bx0 = pos.x; }
      if (pos.y < by0) { by0 = pos.y; }
      if (pos.x > bx1) { bx1 = pos.x; }
      if (pos.y > by1) { by1 = pos.y; }

      /* 活跃判定：优先用显式的 A；否则用高度场在该点的值（A>0 ⇔ h>0） */
      var active;
      if (typeof f.A === "number") { active = f.A > 0; }
      else if (hf) { active = sampleBilinear(hf, pos.x, pos.y) > 0; }
      else { active = true; }

      if (active) {
        if (pos.x < ax0) { ax0 = pos.x; }
        if (pos.y < ay0) { ay0 = pos.y; }
        if (pos.x > ax1) { ax1 = pos.x; }
        if (pos.y > ay1) { ay1 = pos.y; }
        hasActive = true;
      }
    }

    var x0, y0, x1, y1;
    if (hasActive) {
      x0 = ax0 - 2 * sg; y0 = ay0 - 2 * sg;
      x1 = ax1 + 2 * sg; y1 = ay1 + 2 * sg;
    } else if (isFinite(bx0)) {
      x0 = bx0; y0 = by0; x1 = bx1; y1 = by1;
    } else {
      x0 = 0; y0 = 0; x1 = 1; y1 = 1;      /* 连场都没有：退回整幅图 */
    }

    /* 退化保护：零尺寸的框会让 fit 计算除零 */
    var MIN_SPAN = 0.12;
    if (x1 - x0 < MIN_SPAN) {
      var cx = (x0 + x1) / 2;
      x0 = cx - MIN_SPAN / 2; x1 = cx + MIN_SPAN / 2;
    }
    if (y1 - y0 < MIN_SPAN) {
      var cy = (y0 + y1) / 2;
      y0 = cy - MIN_SPAN / 2; y1 = cy + MIN_SPAN / 2;
    }

    return { x0: x0, y0: y0, x1: x1, y1: y1 };
  }

  /* ────────────────────────────────────────────────────────────────────────
     导出
     ──────────────────────────────────────────────────────────────────────── */

  Scene._.Terrain = {
    workerSource: '(' + installTerrain.toString() + ')();',
    DEFAULTS:            DEFAULTS,
    INDEX_INTERVAL:      INDEX_INTERVAL,
    indexIntervalFor:    indexIntervalFor,
    readParams:          readParams,
    sigmaFor:            sigmaFor,
    anisoFor:            anisoFor,
    hash01:              hash01,
    contentEquivalents:  contentEquivalents,
    buildHeightField:    buildHeightField,
    buildAmbientHeightField: buildAmbientHeightField,
    combineHeightFields: combineHeightFields,
    extractContours:     extractContours,
    traceContours:       traceContours,
    hillshade:           hillshade,
    computeExtent:       computeExtent,
    isIndexLevel:        isIndexLevel,
    sampleBilinear:      sampleBilinear,
    gradientAt:          gradientAt
  };
})();
