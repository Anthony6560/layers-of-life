(function (global) {
  'use strict';

  var state = { shell: null, video: null, audio: null, media: null, visualizer: null, tracks: [], active: -1, open: false, focus: null, inert: [] };
  function esc(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function time(value) { value = Math.max(0, Math.floor(value || 0)); return Math.floor(value / 60) + ':' + String(value % 60).padStart(2, '0'); }
  function number(value) { return String(value + 1).padStart(2, '0'); }
  function find(selector) { return state.shell.querySelector(selector); }
  function engine() { return global.Scene && global.Scene._ && global.Scene._.MapEngine; }
  function tracks() {
    return ((global.WORKS_DATA || {}).works || []).filter(function (w) { return w.field === 'rhythm' && w.media && w.media.src; });
  }
  function shellHTML() {
    return '<section id="rhythm-room" data-state="closed" data-playing="false" role="dialog" aria-modal="true" aria-labelledby="rhythm-room-title" aria-hidden="true">' +
      '<header class="r-room__bar"><button type="button" data-r-action="close">← 返回节奏</button><h2 id="rhythm-room-title">节奏 <span>/ RHYTHM</span></h2><span class="r-room__count" data-r-count></span></header>' +
      '<div class="r-room__body"><section class="r-stage" aria-label="当前作品播放器">' +
        '<div class="r-stage__top"><span data-r-label>01 / 音乐影像</span></div>' +
        '<div class="r-stage__picture"><div class="r-stage__grooves" aria-hidden="true"></div>' +
          '<div class="r-stage__screen"><video controls playsinline preload="metadata" tabindex="0" aria-label="音乐作品视频"></video>' +
            '<div class="r-audio" hidden><canvas class="r-audio__canvas" aria-hidden="true"></canvas><audio controls preload="metadata" tabindex="0" aria-label="音乐作品音频"></audio></div></div></div>' +
        '<section class="r-credits" aria-label="创作背景与参与名单" data-r-credits hidden></section>' +
        '<p class="r-room__error" data-r-error role="status" hidden></p></section>' +
      '<aside class="r-shelf" aria-label="音乐作品"><div class="r-shelf__heading"><span>我的音乐创作</span><span data-r-total></span></div>' +
        '<div class="r-sleeve"><span class="r-sleeve__index" data-r-index></span><h3 data-r-title></h3><p data-r-meta></p>' +
          '<div class="r-record" aria-hidden="true"><div class="r-record__label"><img data-r-cover alt=""><span class="r-record__hole"></span></div></div></div>' +
        '<nav class="r-tracklist" aria-label="选择音乐作品" data-r-tracklist></nav></aside></div></section>';
  }
  function mount() {
    if (state.shell) return;
    document.body.insertAdjacentHTML('beforeend', shellHTML());
    state.shell = document.getElementById('rhythm-room');
    state.video = find('video');
    state.audio = find('audio');
    state.media = state.video;
    state.shell.addEventListener('click', function (event) {
      var track = event.target.closest('[data-r-track]');
      if (track) { select(Number(track.dataset.rTrack), !state.media.paused); return; }
      var control = event.target.closest('[data-r-action]');
      if (!control) return;
      var action = control.dataset.rAction;
      if (action === 'close') close();
    });
    [state.video, state.audio].forEach(function (media) {
      ['play', 'pause', 'ended', 'playing'].forEach(function (name) {
        media.addEventListener(name, function () {
          if (media === state.media) updatePlaying();
        });
      });
      media.addEventListener('error', function () { if (media === state.media && media.hasAttribute('src')) showError('作品暂时无法播放，请刷新后重试。'); });
    });
    document.addEventListener('keydown', keydown);
  }
  function credits(track) {
    var holder = find('[data-r-credits]'), html = '';
    if (track.background) {
      html += '<div class="r-credits__background"><h3>创作背景</h3><p>' + esc(track.background) + '</p></div>';
    }
    var rows = (track.credits || []).filter(function (credit) { return credit.label && credit.names && credit.names.length; });
    if (rows.length) {
      html += '<dl>' + rows.map(function (credit) {
        return '<div class="r-credits__row"><dt>' + esc(credit.label) + '</dt><dd>' + esc(credit.names.join('，')) + '</dd></div>';
      }).join('') + '</dl>';
    }
    holder.innerHTML = html;
    holder.hidden = !html;
  }
  function select(index, autoplay) {
    if (!state.tracks[index]) return;
    if (index === state.active) { if (autoplay) play(); return; }
    releaseMedia();
    state.active = index;
    var track = state.tracks[index], media = track.media;
    var isAudio = media.type === 'audio';
    state.shell.dataset.media = isAudio ? 'audio' : 'video';
    state.video.hidden = isAudio;
    find('.r-audio').hidden = !isAudio;
    state.media = isAudio ? state.audio : state.video;
    if (!isAudio) state.video.poster = track.cover || '';
    state.media.setAttribute('aria-label', track.title);
    state.media.src = media.src;
    state.media.load();
    find('[data-r-title]').textContent = track.title;
    find('[data-r-meta]').textContent = (isAudio ? 'AUDIO' : 'PV') + ' / ' + time(media.duration);
    find('[data-r-label]').textContent = number(index) + ' / ' + (isAudio ? (track.tags || ['音乐']).join(' · ') : '音乐影像');
    find('[data-r-index]').textContent = number(index);
    find('[data-r-cover]').src = track.cover || '';
    find('[data-r-cover]').hidden = !track.cover;
    find('[data-r-count]').textContent = number(index) + ' / ' + String(state.tracks.length).padStart(2, '0');
    find('[data-r-error]').hidden = true;
    state.shell.querySelectorAll('[data-r-track]').forEach(function (button, i) { button.setAttribute('aria-current', String(i === index)); });
    credits(track);
    if (isAudio && media.visualizer === 'play' && global.RhythmVisualizer) {
      state.visualizer = global.RhythmVisualizer.create(find('canvas'), state.audio);
    }
    updatePlaying();
    if (autoplay) play();
  }
  function updatePlaying() {
    if (state.active < 0) return;
    state.shell.dataset.playing = String(!state.media.paused && !state.media.ended);
  }
  function showError(message) { var el = find('[data-r-error]'); el.textContent = message; el.hidden = false; }
  function play() {
    find('[data-r-error]').hidden = true;
    var promise = state.media.play();
    if (promise && promise.catch) promise.catch(function (error) { if (error.name !== 'AbortError') showError('播放未能开始，请再试一次。'); });
  }
  function open(id) {
    if (state.open) return;
    if (global.MomentsRoom && global.MomentsRoom.isOpen()) global.MomentsRoom.close();
    state.tracks = tracks();
    if (!state.tracks.length) return;
    mount();
    state.focus = document.activeElement;
    find('[data-r-tracklist]').innerHTML = state.tracks.map(function (track, i) {
      return '<button type="button" class="r-track" data-r-track="' + i + '" aria-current="false"><span class="r-track__number">' + number(i) +
        '</span><span class="r-track__copy"><strong>' + esc(track.title) + '</strong><small>' + (track.media.type === 'audio' ? 'AUDIO' : 'PV') + '</small></span><span class="r-track__duration">' + time(track.media.duration) + '</span></button>';
    }).join('');
    find('[data-r-total]').textContent = String(state.tracks.length).padStart(2, '0') + ' 首';
    state.open = true;
    state.shell.dataset.state = 'open';
    state.shell.setAttribute('aria-hidden', 'false');
    state.inert = Array.prototype.map.call(document.querySelectorAll('#app, #overlay, .m-time-control'), function (el) {
      var before = el.inert; el.inert = true; return { el: el, before: before };
    });
    var map = engine();
    if (map && map.suspend) map.suspend('rhythm-room');
    else if (map && map.stop) map.stop();
    document.body.classList.add('r-room-open');
    state.active = -1;
    var index = state.tracks.findIndex(function (t) { return t.id === id; });
    select(index >= 0 ? index : 0, false);
    state.media.focus();
  }
  function releaseMedia() {
    if (state.visualizer) { state.visualizer.dispose(); state.visualizer = null; }
    [state.video, state.audio].forEach(function (media) {
      media.pause(); media.removeAttribute('src'); media.load();
    });
  }
  function close() {
    if (!state.open) return;
    releaseMedia();
    state.active = -1;
    state.open = false;
    state.shell.dataset.state = 'closed';
    state.shell.dataset.playing = 'false';
    state.shell.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('r-room-open');
    state.inert.forEach(function (item) { item.el.inert = item.before; });
    state.inert = [];
    var map = engine();
    if (map && map.resume) map.resume('rhythm-room');
    else if (map && map.start) map.start();
    if (state.focus && state.focus.isConnected) state.focus.focus();
  }
  function keydown(event) {
    if (!state.open) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') {
      var items = Array.prototype.filter.call(state.shell.querySelectorAll('button, input, video[controls], audio[controls]'), function (el) { return !el.disabled && el.getClientRects().length; });
      var first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    var track = event.target.closest('[data-r-track]');
    if (track && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      var next = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + state.tracks.length) % state.tracks.length;
      select(next, !state.media.paused);
      find('[data-r-track="' + next + '"]').focus();
    }
  }
  global.RhythmPlayer = { open: open, close: close, isOpen: function () { return state.open; } };
})(window);
