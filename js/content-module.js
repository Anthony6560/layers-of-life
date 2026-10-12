/* =============================================================================
 * content-module.js —— window.ContentModule（Agent D）
 * -----------------------------------------------------------------------------
 * 依据：《06-开发接口契约》§2.3 接口、§3.1 容器、§3.2 类名前缀、§4 数据契约、§5 视觉契约
 *       《05-UI设计规范》§6.1–6.8 组件规范
 *       《03-PRD》§4.2 作品展示、§4.3 碎片笔记流
 *
 * 纪律：
 *   · 只操作调用方传入的容器内部；不假定 window.Scene 存在（契约 §3.5）
 *   · 类名统一 c- 前缀；颜色一律 var(--field-color*)；文案一律取自 messages
 *   · 日期比较只用字符串比较（契约 §4.3），绝不用 new Date()
 *   · 任何缺字段的数据都不得抛错、不得渲染 undefined
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * 0. 常量与工具
   * ------------------------------------------------------------------------- */

  var VIEW_ABOUT = 'about';
  var VIEW_NOTES = 'notes';

  var FIELD_IDS = ['space', 'light', 'rhythm', 'taste', 'field'];

  /** 笔记正文硬上限（PRD M-05 §4.3.2） */
  var NOTE_LIMIT = 120;

  var PLACEHOLDER = global.Placeholder || null;

  /** 内置兜底文案表（来自 placeholder.js，契约 §4.1） */
  var FALLBACK = (PLACEHOLDER && PLACEHOLDER.FALLBACK_MESSAGES) || {};

  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function isArr(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function isObj(v) {
    return v && typeof v === 'object' && !isArr(v);
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 转义成可用于 data-* 选择器的短标识 */
  function idOf(v) {
    return String(v === undefined || v === null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
  }

  /**
   * 取一条界面文案：
   *   site.messages[key] → placeholder.js 兜底常量 → 空串
   * 绝不返回 undefined / null（契约 §4.2）。
   */
  function t(key) {
    var m = state.ctx && state.ctx.site ? state.ctx.site.messages : null;
    var v = m ? m[key] : undefined;
    if (v === undefined || v === null || v === '') v = FALLBACK[key];
    if (v === undefined || v === null) v = '';
    /* 数据里允许提供更细粒度的键（如 tabWorks），一并支持 */
    return String(v);
  }

  /** 取场定义；找不到返回 null */
  function findField(site, id) {
    if (!site || !isArr(site.fields)) return null;
    for (var i = 0; i < site.fields.length; i++) {
      if (site.fields[i] && site.fields[i].id === id) return site.fields[i];
    }
    return null;
  }

  /**
   * 排序：按 date 倒序（新→旧）。
   * 契约 §4.3 —— date 是 YYYY-MM / YYYY-MM-DD，字典序即时间序，禁止 new Date()。
   */
  function byDateDesc(a, b) {
    var da = a && a.date ? String(a.date) : '';
    var db = b && b.date ? String(b.date) : '';
    if (da === db) return 0;
    return da < db ? 1 : -1;
  }

  /** 安全取数组 */
  function arr(v) {
    return isArr(v) ? v : [];
  }

  /** 非空字符串 */
  function str(v) {
    if (v === undefined || v === null) return '';
    return String(v);
  }

  /** 占位图块（委托 placeholder.js；缺失时退化为一个空标记，绝不破图） */
  function placeholderFor(fieldId, opts) {
    if (PLACEHOLDER && typeof PLACEHOLDER.markup === 'function') {
      return PLACEHOLDER.markup(fieldId, opts || {});
    }
    return '<div class="c-placeholder" data-field="' + esc(fieldId) +
      '" aria-hidden="true"></div>';
  }

  /* ---------------------------------------------------------------------------
   * 1. 模块内部状态
   * ------------------------------------------------------------------------- */

  var state = {
    container: null,
    root: null,
    ctx: null,      /* 归一化后的 { id, site, works, notes } */
    mode: 'full',
    segment: 'works',
    hasBar: true,    /* 是否渲染自带顶栏（对方已提供返回按钮时为 false） */
    openWork: null,
    openNotes: {},
    onClick: null,
    onKeydown: null,
    unsub: null
  };

  /* ---------------------------------------------------------------------------
   * 2. 数据归一化（契约 §3.5：只在 mount 时读取传入的 ctx）
   * ------------------------------------------------------------------------- */

  function normalize(ctx) {
    ctx = ctx || {};
    var site = isObj(ctx.site) ? ctx.site : (isObj(global.SITE_DATA) ? global.SITE_DATA : null);
    var works = isArr(ctx.works) ? ctx.works
      : (global.WORKS_DATA && isArr(global.WORKS_DATA.works) ? global.WORKS_DATA.works : []);
    var notes = isArr(ctx.notes) ? ctx.notes
      : (global.NOTES_DATA && isArr(global.NOTES_DATA.notes) ? global.NOTES_DATA.notes : []);
    return {
      id: str(ctx.id),
      site: site,
      works: works,
      notes: notes
    };
  }

  /* ---------------------------------------------------------------------------
   * 3. 通用片段
   * ------------------------------------------------------------------------- */

  /** 返回按钮（行为交给 Scene.closeOverlay，契约 §2.3 / 任务说明） */
  function backButtonHTML() {
    return '<button type="button" class="c-back" data-action="back">' +
      '<span class="c-back__label">' + esc(t('back')) + '</span></button>';
  }

  function barHTML() {
    return '<div class="c-bar">' + backButtonHTML() + '</div>';
  }

  /**
   * 外部弹层通过地图点击 / ESC 关闭，不再生成额外返回栏。
   * 独立挂载本模块时仍保留自带返回入口。
   */
  function hasExternalBack() {
    var doc = global.document;
    if (!doc) return false;
    try {
      if (state.container && typeof state.container.closest === 'function' && state.container.closest('#overlay')) return true;
      if (typeof doc.getElementById === 'function' && doc.getElementById('back-btn')) return true;
      if (typeof doc.querySelector === 'function' && doc.querySelector('.m-back')) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  /** 空状态：残缺的等高线环（《05》§6.7，3/4 圆弧 + 一个断口） */
  function emptyHTML(text, hint) {
    var mark = '<svg class="c-empty__mark" viewBox="0 0 72 72" aria-hidden="true" focusable="false">' +
      '<path d="M36 8 A28 28 0 1 1 8 36" fill="none" stroke="var(--color-ink-faint)" ' +
      'stroke-width="1.5" stroke-linecap="round"/></svg>';
    var h = hint ? '<p class="c-empty__hint">' + esc(hint) + '</p>' : '';
    /* role="status"：内容变化时由屏幕阅读器播报（《05》§9.4） */
    return '<div class="c-empty" role="status">' + mark +
      '<p class="c-empty__text">' + esc(text) + '</p>' + h + '</div>';
  }

  /** 数据整体缺失时的错误卡（契约 §4.2 最后一行，兜底用，不白屏） */
  function errorHTML() {
    var text = t('errorData');
    if (!text) text = t('loadFailed');
    return '<div class="c-error" role="alert">' +
      '<p class="c-error__text">' + esc(text) + '</p></div>';
  }

  /* ---------------------------------------------------------------------------
   * 4. 作品卡（《05》§6.1 + PRD §4.2.2 / §4.2.3）
   * ------------------------------------------------------------------------- */

  function coverHTML(work, cls) {
    var fieldId = str(work.field) || (state.ctx ? state.ctx.id : '');
    var cover = str(work.cover);
    var box = '<div class="' + cls + '">';
    if (cover) {
      /* 真实封面存在：占位图垫在底层，图加载失败时只需隐藏 <img> 即自然降级 */
      box += placeholderFor(fieldId, { site: state.ctx.site, hidden: true });
      box += '<img class="c-work__img" src="' + esc(cover) + '" alt="' +
        esc(str(work.title)) + '" loading="lazy" decoding="async">';
    } else {
      /* cover 为空 → 直接给占位图（契约 §4.2 第一行） */
      box += placeholderFor(fieldId, { site: state.ctx.site });
    }
    return box + '</div>';
  }

  function tagsHTML(tags, cls) {
    var list = arr(tags);
    if (!list.length) return '';   /* tags 为空 → 整行不渲染（不留空行） */
    var out = '';
    for (var i = 0; i < list.length; i++) {
      if (list[i] === undefined || list[i] === null || list[i] === '') continue;
      out += '<li class="' + cls + '">' + esc(list[i]) + '</li>';
    }
    if (!out) return '';
    return '<ul class="c-work__tags">' + out + '</ul>';
  }

  /** 详情正文：description 缺失 → 整段不渲染，也不会出现空标题 */
  function descHTML(desc) {
    var list = arr(desc);
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var p = str(list[i]);
      if (!p) continue;
      out += '<p class="c-work__para">' + esc(p) + '</p>';
    }
    if (!out) return '';
    return '<div class="c-work__desc">' + out + '</div>';
  }

  /** 图集：images 为空 → 不渲染 */
  function galleryHTML(images, title) {
    var list = arr(images);
    var out = '';
    for (var i = 0; i < list.length; i++) {
      var src = str(list[i]);
      if (!src) continue;
      out += '<figure class="c-work__fig"><img src="' + esc(src) + '" alt="' +
        esc(str(title)) + '" loading="lazy" decoding="async"></figure>';
    }
    if (!out) return '';
    return '<div class="c-work__gallery">' + out + '</div>';
  }

  function workHTML(work, index) {
    var id = idOf(work.id);
    var open = state.openWork === work.id;
    var meta = [];
    if (str(work.date)) meta.push('<span class="c-work__date">' + esc(work.date) + '</span>');
    if (str(work.role)) meta.push('<span class="c-work__role">' + esc(work.role) + '</span>');

    var h = '<article class="c-work" id="c-work-' + esc(id) + '" data-work="' + esc(id) +
      '" data-expanded="' + (open ? 'true' : 'false') + '" style="--c-i:' + (index % 8) + '"' +
      ' data-action="toggle-work" data-id="' + esc(id) + '">';

    h += coverHTML(work, 'c-work__cover');
    h += '<h3 class="c-work__title">' + esc(str(work.title)) + '</h3>';
    if (meta.length) h += '<p class="c-work__meta">' + meta.join('<span class="c-work__dot">·</span>') + '</p>';
    h += '<div class="c-work__divider"></div>';
    if (str(work.summary)) h += '<p class="c-work__summary">' + esc(work.summary) + '</p>';

    h += '<button type="button" class="c-work__toggle" data-action="toggle-work" data-id="' +
      esc(id) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-controls="c-work-detail-' +
      esc(id) + '">' + esc(t(open ? 'collapse' : 'expand')) + '</button>';

    /* 详情面板：始终在 DOM 里，靠 data-expanded 驱动 grid-template-rows 过渡 */
    h += '<div class="c-work__detail" id="c-work-detail-' + esc(id) + '" aria-hidden="' +
      (open ? 'false' : 'true') + '"><div class="c-work__detail-inner">';
    h += coverHTML(work, 'c-work__detail-cover');
    h += '<p class="c-work__detail-meta">' + meta.join('<span class="c-work__dot">·</span>') + '</p>';
    h += tagsHTML(work.tags, 'c-tag');
    h += descHTML(work.description);
    h += galleryHTML(work.images, work.title);
    h += '</div></div>';

    return h + '</article>';
  }

  /* ---------------------------------------------------------------------------
   * 5. 笔记条（《05》§6.2 + PRD §4.3）
   * ------------------------------------------------------------------------- */

  function noteHTML(note, index) {
    var id = idOf(note.id);
    var fieldId = str(note.field);
    var f = findField(state.ctx.site, fieldId);
    var text = str(note.text);
    var long = text.length > NOTE_LIMIT;
    var open = !!state.openNotes[note.id];

    /* 折叠态：硬截断到 120 字（PRD M-05 的硬限制），CSS 侧再叠 4 行 clamp 兜底 */
    var shown = long && !open ? text.slice(0, NOTE_LIMIT) + '…' : text;

    var h = '<article class="c-note" data-note="' + esc(id) + '"' +
      (fieldId ? ' data-field="' + esc(fieldId) + '"' : '') +
      ' data-clamped="' + (long && !open ? 'true' : 'false') + '"' +
      (long ? ' data-full="' + esc(text) + '"' : '') +
      ' style="--c-i:' + (index % 8) + '">';

    h += '<div class="c-note__body"><p class="c-note__text">' + esc(shown) + '</p></div>';

    if (long) {
      h += '<button type="button" class="c-note__more" data-action="toggle-note" data-id="' +
        esc(id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
        esc(t(open ? 'collapse' : 'expand')) + '</button>';
    }

    var meta = '';
    if (f && str(f.nameEn)) {
      meta += '<span class="c-note__field">' + esc(f.nameEn) + '</span>';
    }
    if (str(note.date)) {
      meta += '<time class="c-note__date" datetime="' + esc(note.date) + '">' +
        esc(note.date) + '</time>';
    }
    if (meta) h += '<p class="c-note__meta">' + meta + '</p>';

    /* 笔记可选配图：image 非空才渲染，同样以占位图垫底 */
    var img = str(note.image);
    if (img) {
      h += '<div class="c-note__figure">' + placeholderFor(fieldId, { site: state.ctx.site, hidden: true }) +
        '<img class="c-note__img" src="' + esc(img) + '" alt="" loading="lazy" decoding="async"></div>';
    }

    return h + '</article>';
  }

  function notesListHTML(notes, timeline) {
    var sorted = notes.slice().sort(byDateDesc);
    var out = '';
    for (var i = 0; i < sorted.length; i++) {
      out += noteHTML(sorted[i], i);
    }
    return '<div class="c-notes"' + (timeline ? ' data-timeline="true"' : '') + '>' + out + '</div>';
  }

  /** 场域筛选：field 相同的笔记；field 缺失的条目不参与任何场 */
  function notesOfField(notes, fieldId) {
    var out = [];
    for (var i = 0; i < notes.length; i++) {
      if (notes[i] && str(notes[i].field) === fieldId) out.push(notes[i]);
    }
    return out;
  }

  function worksOfField(works, fieldId) {
    var out = [];
    for (var i = 0; i < works.length; i++) {
      if (works[i] && str(works[i].field) === fieldId) out.push(works[i]);
    }
    return out;
  }

  function spaceViewHTML(field) {
    var h = '<div class="c-view c-space-view" data-view="field" data-field="space">';
    h += '<header class="c-head">';
    h += '<p class="c-head__eyebrow">' + esc(str(field.nameEn) || 'SPACE') + '</p>';
    h += '<h2 class="c-head__title" id="c-overlay-title">' + esc(str(field.name) || '空间') + '</h2>';
    if (str(field.subtitle)) h += '<p class="c-head__subtitle">' + esc(field.subtitle) + '</p>';
    if (str(field.intro)) h += '<p class="c-head__intro">' + esc(field.intro) + '</p>';
    h += '</header>';

    h += '<section class="c-space-entry" aria-labelledby="c-space-entry-title">';
    h += '<div class="c-space-entry__copy">';
    h += '<h3 class="c-space-entry__title" id="c-space-entry-title"><button class="c-space-entry__button" type="button" data-action="enter-city" aria-label="更近一步，进入项目空间">更“近”一步<span aria-hidden="true"> ↗</span></button></h3>';
    h += '<p class="c-space-entry__desc">这里有我的课程、科研和实习项目，关注城市在时间和空间中的变化。</p>';
    h += '</div>';
    h += '</section></div>';
    return h;
  }

  /* ---------------------------------------------------------------------------
   * 6. 三种视图
   * ------------------------------------------------------------------------- */

  /** 场域页：场名 + 英文名 + 自述 + 分段切换 + 列表 */
  function fieldViewHTML(field) {
    var ctx = state.ctx;
    var fieldId = field.id;
    if (fieldId === 'space') return spaceViewHTML(field);
    if (fieldId === 'rhythm') return rhythmViewHTML(field);
    if (fieldId === 'field') return baseballViewHTML(field);
    if (fieldId === 'light' || fieldId === 'taste') return momentsViewHTML(field);
    var works = worksOfField(ctx.works, fieldId).sort(byDateDesc);
    var notes = notesOfField(ctx.notes, fieldId);

    var h = '<div class="c-view" data-view="field" data-field="' + esc(fieldId) + '">';

    /* —— 页眉 —— */
    h += '<header class="c-head">';
    if (str(field.nameEn)) h += '<p class="c-head__eyebrow">' + esc(field.nameEn) + '</p>';
    if (str(field.name)) h += '<h2 class="c-head__title" id="c-overlay-title">' + esc(field.name) + '</h2>';
    if (str(field.subtitle)) h += '<p class="c-head__subtitle">' + esc(field.subtitle) + '</p>';
    if (str(field.intro)) h += '<p class="c-head__intro">' + esc(field.intro) + '</p>';
    h += '</header>';

    /* —— 分段切换（作品 / 印记）—— */
    var seg = state.segment === 'notes' ? 'notes' : 'works';
    h += '<div class="c-segmented" role="tablist">' +
      '<button type="button" role="tab" class="c-segmented__item" data-action="segment" ' +
      'data-segment="works" aria-selected="' + (seg === 'works' ? 'true' : 'false') + '">' +
      esc(t('tabWorks')) + '<span class="c-segmented__count">' + works.length + '</span></button>' +
      '<button type="button" role="tab" class="c-segmented__item" data-action="segment" ' +
      'data-segment="notes" aria-selected="' + (seg === 'notes' ? 'true' : 'false') + '">' +
      esc(t('tabNotes')) + '<span class="c-segmented__count">' + notes.length + '</span></button>' +
      '</div>';

    /* —— 面板 —— */
    h += '<div class="c-panel" role="tabpanel">';
    if (seg === 'works') {
      if (works.length) {
        h += '<div class="c-works">';
        for (var i = 0; i < works.length; i++) h += workHTML(works[i], i);
        h += '</div>';
      } else {
        h += emptyHTML(t('emptyWorks'), '');
      }
    } else {
      if (notes.length) {
        h += notesListHTML(notes, false);
      } else {
        h += emptyHTML(t('emptyNotes'), '');
      }
    }
    h += '</div>';

    return h + '</div>';
  }

  function momentsViewHTML(field) {
    var light = field.id === 'light';
    return '<div class="c-view" data-view="field" data-field="'+esc(field.id)+'"><header class="c-head">'+
      '<p class="c-head__eyebrow">'+esc(field.nameEn)+'</p><h2 class="c-head__title" id="c-overlay-title">'+esc(field.name)+'</h2>'+
      '<p class="c-head__subtitle">'+(light?'摄影与日常':'饮食记录')+'</p></header><section class="c-space-entry"><div class="c-space-entry__copy">'+
      '<h3 class="c-space-entry__title"><button class="c-space-entry__button" type="button" data-action="enter-moments" data-category="'+esc(field.id)+'">'+
      (light?'翻开相册':'坐下来，慢慢尝')+'<span aria-hidden="true"> ↗</span></button></h3><p class="c-space-entry__desc">'+
      (light?'照片，以及拍下它们时的几句话。':'做过的，吃过的，记得的。')+'</p></div></section></div>';
  }

  function baseballViewHTML(field) {
    var h = '<div class="c-view c-field-view" data-view="field" data-field="field"><header class="c-head">';
    h += '<p class="c-head__eyebrow">FIELD</p><h2 class="c-head__title" id="c-overlay-title">场</h2>';
    h += '<p class="c-head__subtitle">棒球 · 垒球</p></header>';
    h += '<section class="c-space-entry"><div class="c-space-entry__copy">';
    h += '<h3 class="c-space-entry__title"><button class="c-space-entry__button" type="button" data-action="enter-field">到球场去<span aria-hidden="true"> ↗</span></button></h3>';
    h += '<p class="c-space-entry__desc">从小学到大学，两次走进球场。这里有我的球队、比赛，也有场外的故事。</p></div></section></div>';
    return h;
  }

  function rhythmViewHTML(field) {
    var h = '<div class="c-view c-rhythm-view" data-view="field" data-field="rhythm"><header class="c-head">';
    h += '<p class="c-head__eyebrow">' + esc(str(field.nameEn) || 'RHYTHM') + '</p>';
    h += '<h2 class="c-head__title" id="c-overlay-title">' + esc(str(field.name) || '节奏') + '</h2>';
    h += '<p class="c-head__subtitle">音乐创作</p></header>';
    h += '<section class="c-space-entry"><div class="c-space-entry__copy">';
    h += '<h3 class="c-space-entry__title"><button class="c-space-entry__button" type="button" data-action="enter-rhythm">听一会儿<span aria-hidden="true"> ↗</span></button></h3>';
    h += '<p class="c-space-entry__desc">旋律、词句，还有它们组成的故事。</p></div></section></div>';
    return h;
  }

  /** 关于页：多段正文，排版按《05》§3.7③ */
  function aboutViewHTML() {
    var about = state.ctx.site && isObj(state.ctx.site.about) ? state.ctx.site.about : null;
    var paras = about ? arr(about.paragraphs) : [];
    var title = about && str(about.title) ? str(about.title) : t('aboutTitle');

    var h = '<div class="c-view" data-view="about">';
    h += '<header class="c-head">';
    if (title) h += '<h2 class="c-head__title" id="c-overlay-title">' + esc(title) + '</h2>';
    h += '</header>';

    if (paras.length) {
      h += '<div class="c-about">';
      for (var i = 0; i < paras.length; i++) {
        var p = str(paras[i]);
        if (!p) continue;
        h += '<p class="c-about__para">' + esc(p) + '</p>';
      }
      h += '</div>';
    } else {
      h += emptyHTML(t('emptyNotesAll'), '');
    }
    return h + '</div>';
  }

  /** 全站印记聚合流：全部笔记按日期倒序，单列时间轴 */
  function notesViewHTML() {
    var all = arr(state.ctx.notes);
    var site = state.ctx.site;
    var title = site && site.notesLandmark && str(site.notesLandmark.name)
      ? str(site.notesLandmark.name) : t('notesTitle');

    var h = '<div class="c-view" data-view="notes">';
    h += '<header class="c-head">';
    if (title) h += '<h2 class="c-head__title" id="c-overlay-title">' + esc(title) + '</h2>';
    if (all.length) {
      h += '<p class="c-head__count"><span class="c-num">' + all.length + '</span></p>';
    }
    h += '</header>';

    if (all.length) h += notesListHTML(all, true);
    else h += emptyHTML(t('emptyNotesAll'), '');

    return h + '</div>';
  }

  /** 内容区（不含顶栏），供分段切换时整块重渲染 */
  function viewHTML() {
    var ctx = state.ctx;
    if (!ctx || !ctx.site) return errorHTML();
    if (ctx.id === VIEW_ABOUT) return aboutViewHTML();
    if (ctx.id === VIEW_NOTES) return notesViewHTML();

    var field = findField(ctx.site, ctx.id);
    if (!field) {
      /* 场 id 不在数据里：给一个不带 undefined 的最小场定义，走空状态而不是报错 */
      field = { id: ctx.id, name: '', nameEn: ctx.id ? String(ctx.id).toUpperCase() : '', subtitle: '', intro: '' };
    }
    return fieldViewHTML(field);
  }

  /** 根节点内容 = 顶栏（返回按钮，可缺省）+ 可滚动内容区（《05》§6.3） */
  function buildHTML() {
    return (state.hasBar ? barHTML() : '') + '<div class="c-body">' + viewHTML() + '</div>';
  }

  /* ---------------------------------------------------------------------------
   * 7. DOM 辅助（全部做了能力检测，便于在无 DOM 的桩环境里跑）
   * ------------------------------------------------------------------------- */

  function qs(sel) {
    var r = state.root;
    if (!r || typeof r.querySelector !== 'function') return null;
    try { return r.querySelector(sel); } catch (e) { return null; }
  }

  function rerender() {
    if (!state.root) return;
    try { state.root.innerHTML = buildHTML(); } catch (e) { /* 极端情况下不留白 */ }
  }

  /* ---------------------------------------------------------------------------
   * 8. 交互
   * ------------------------------------------------------------------------- */

  /** 返回全景：行为由 Agent C 的 Scene.closeOverlay() 负责，这里只做调用 */
  function requestClose() {
    var S = global.Scene;
    if (S && typeof S.closeOverlay === 'function') {
      try { S.closeOverlay(); return; } catch (e) { /* 落到下面的兜底 */ }
    }
    /* Scene 尚未就位（并行开发期）：直接卸载自身，避免界面卡死 */
    unmount();
  }

  function setSegment(seg) {
    if (seg !== 'works' && seg !== 'notes') return;
    if (state.segment === seg) return;
    state.segment = seg;
    rerender();
    /* 段落切换后把焦点交还给当前选中的分段按钮（键盘可达性） */
    var active = qs('[data-segment="' + seg + '"]');
    if (active && typeof active.focus === 'function') {
      try { active.focus(); } catch (e) { /* 忽略 */ }
    }
  }

  function workCard(id) {
    return qs('[data-work="' + id + '"]');
  }

  function toggleWork(id) {
    if (!id) return;
    var open = state.openWork !== id;
    var prevId = state.openWork;
    state.openWork = open ? id : null;

    var card = workCard(id);
    var prevCard = prevId && prevId !== id ? workCard(idOf(prevId)) : null;
    if (prevCard && prevCard !== card && typeof prevCard.setAttribute === 'function') {
      applyWorkOpen(prevCard, false);
    }
    if (card && typeof card.setAttribute === 'function') {
      applyWorkOpen(card, open);
    } else {
      rerender();   /* 无 DOM 查询能力时退回整块重渲染 */
    }
  }

  function applyWorkOpen(card, open) {
    card.setAttribute('data-expanded', open ? 'true' : 'false');
    var btn = typeof card.querySelector === 'function'
      ? card.querySelector('[data-action="toggle-work"]') : null;
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = t(open ? 'collapse' : 'expand');
    }
    var detail = typeof card.querySelector === 'function'
      ? card.querySelector('.c-work__detail') : null;
    if (detail) detail.setAttribute('aria-hidden', open ? 'false' : 'true');
  }

  function noteItem(id) {
    return qs('[data-note="' + id + '"]');
  }

  function toggleNote(id) {
    if (!id) return;
    var open = !state.openNotes[id];
    if (open) state.openNotes[id] = true; else delete state.openNotes[id];

    var item = noteItem(id);
    if (item && typeof item.setAttribute === 'function') {
      item.setAttribute('data-clamped', open ? 'false' : 'true');
      var btn = typeof item.querySelector === 'function'
        ? item.querySelector('[data-action="toggle-note"]') : null;
      if (btn) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.textContent = t(open ? 'collapse' : 'expand');
      }
      /* 正文节点整块替换，保证折叠态严格 ≤120 字 */
      var body = typeof item.querySelector === 'function'
        ? item.querySelector('.c-note__body') : null;
      var full = str(item.getAttribute ? item.getAttribute('data-full') : '');
      if (body && full) {
        body.innerHTML = '<p class="c-note__text">' + esc(
          open ? full : full.slice(0, NOTE_LIMIT) + '…'
        ) + '</p>';
      }
    } else {
      rerender();
    }
  }

  function handleClick(e) {
    var target = e && e.target;
    if (!target) return;
    var el = null;
    if (typeof target.closest === 'function') el = target.closest('[data-action]');
    else return;
    if (!el || !state.root || !el.getAttribute) return;
    if (typeof state.root.contains === 'function' && !state.root.contains(el)) return;

    var action = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');
    if (action === 'back') {
      if (e.preventDefault) e.preventDefault();
      requestClose();
    } else if (action === 'segment') {
      setSegment(el.getAttribute('data-segment'));
    } else if (action === 'toggle-work') {
      toggleWork(id);
    } else if (action === 'toggle-note') {
      toggleNote(id);
    } else if (action === 'enter-city') {
      if (global.SpaceCity && typeof global.SpaceCity.open === 'function') {
        global.SpaceCity.open();
      }
    } else if (action === 'enter-rhythm') {
      if (global.RhythmPlayer) global.RhythmPlayer.open();
    } else if (action === 'enter-field') {
      if (global.FieldRoom) global.FieldRoom.open();
    } else if (action === 'enter-moments') {
      if (global.MomentsRoom) global.MomentsRoom.open(el.getAttribute('data-category'));
    }
  }

  /** 分段切换器的左右方向键（tablist 惯例） */
  function handleKeydown(e) {
    var target = e && e.target;
    if (!target || typeof target.getAttribute !== 'function') return;
    if (target.getAttribute('data-action') !== 'segment') return;
    var key = e.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
    if (e.preventDefault) e.preventDefault();
    setSegment(state.segment === 'works' ? 'notes' : 'works');
  }

  /** 封面 / 配图加载失败：隐藏 <img>，底层的占位图自然显露（契约 §4.2 第一行） */
  function handleResourceError(e) {
    var target = e && e.target;
    if (!target || !target.className) return;
    var cls = String(target.className);
    if (cls.indexOf('c-work__img') < 0 && cls.indexOf('c-note__img') < 0) return;
    if (target.setAttribute) target.setAttribute('data-broken', 'true');
    else if (target.style) target.style.display = 'none';
  }

  /* ---------------------------------------------------------------------------
   * 9. 公开接口（契约 §2.3）
   * ------------------------------------------------------------------------- */

  /**
   * 挂载内容视图。
   * @param {HTMLElement} container Agent C 提供的覆盖层容器（#overlay-content）
   * @param {Object} ctx { id, site, works, notes }
   */
  function mount(container, ctx) {
    if (!container) return;
    unmount();                       /* 先清干净，避免重复挂载叠加 */

    state.container = container;
    state.ctx = normalize(ctx);
    state.segment = 'works';
    state.hasBar = !hasExternalBack();
    state.openWork = null;
    state.openNotes = {};

    var doc = global.document;
    if (!doc || typeof doc.createElement !== 'function') return;

    var root = doc.createElement('div');
    root.className = 'c-root';
    root.setAttribute('data-view', state.ctx.id === VIEW_ABOUT ? VIEW_ABOUT
      : state.ctx.id === VIEW_NOTES ? VIEW_NOTES : 'field');
    if (FIELD_IDS.indexOf(state.ctx.id) >= 0) root.setAttribute('data-field', state.ctx.id);
    root.setAttribute('data-mode', state.mode);
    /* self：自带顶栏 + 自带内边距/滚动；external：骨架由 Agent C 提供，本模块只填内容 */
    root.setAttribute('data-shell', state.hasBar ? 'self' : 'external');

    try { root.innerHTML = buildHTML(); } catch (err) { root.innerHTML = errorHTML(); }

    if (typeof root.addEventListener === 'function') {
      state.onClick = handleClick;
      state.onKeydown = handleKeydown;
      root.addEventListener('click', state.onClick, false);
      root.addEventListener('keydown', state.onKeydown, false);
      /* 资源 error 不冒泡，须用捕获阶段 */
      try { root.addEventListener('error', handleResourceError, true); } catch (e2) { /* 忽略 */ }
    }

    state.root = root;
    if (typeof container.appendChild === 'function') container.appendChild(root);

    /* 感知性能降级（契约 §2.2 / §2.4），Scene 未就位时静默跳过 */
    var S = global.Scene;
    if (S && typeof S.on === 'function') {
      try {
        state.unsub = S.on('mode:change', function (p) {
          if (p && p.mode) setMode(p.mode);
        });
      } catch (e3) { state.unsub = null; }
    }
  }

  /** 卸载并清理（移除监听器、清空容器） */
  function unmount() {
    if (typeof state.unsub === 'function') {
      try { state.unsub(); } catch (e) { /* 忽略 */ }
    }
    state.unsub = null;

    var root = state.root;
    if (root && typeof root.removeEventListener === 'function') {
      try {
        if (state.onClick) root.removeEventListener('click', state.onClick, false);
        if (state.onKeydown) root.removeEventListener('keydown', state.onKeydown, false);
        root.removeEventListener('error', handleResourceError, true);
      } catch (e2) { /* 忽略 */ }
    }
    state.onClick = null;
    state.onKeydown = null;

    var container = state.container;
    if (container) {
      try { container.innerHTML = ''; } catch (e3) { /* 忽略 */ }
    }

    state.root = null;
    state.container = null;
    state.ctx = null;
    state.openWork = null;
    state.openNotes = {};
  }

  /** 性能模式：'full' | 'static' | 'reduced'（降级时关掉自身动效，功能与布局不变） */
  function setMode(mode) {
    state.mode = mode || 'full';
    if (state.root && typeof state.root.setAttribute === 'function') {
      state.root.setAttribute('data-mode', state.mode);
    }
  }

  global.ContentModule = {
    mount: mount,
    unmount: unmount,
    setMode: setMode
  };
})(typeof window !== 'undefined' ? window : this);
