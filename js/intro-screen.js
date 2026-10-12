(function (global) {
  'use strict';
  var host, lines = [], row = 0, count = 0, timer = 0, due = 0, pausedAt = 0;
  var finished = false, dismissed = false, enter, showAll, onEnter;
  var enterDue = 0, enterTimer = 0;
  var completionCallbacks = [];
  var blocked = [], motion;
  function schedule() {
    if (!document.hidden) timer = global.setTimeout(type, Math.max(0, due - performance.now()));
  }
  function paint(line, length) {
    line.visible.textContent = line.chars.slice(0, length).join('');
    line.remaining.textContent = line.chars.slice(length).join('');
    line.caret.hidden = length === line.chars.length;
  }
  function type() {
    timer = 0;
    if (finished || dismissed) return;
    // Reveal one character per callback; scene preparation starts after typing.
    var line = lines[row], char = line.chars[count];
    count++;
    paint(line, count);
    if (count === line.chars.length) {
      row++; count = 0;
      if (row === lines.length) { complete(); return; }
      due = performance.now() + (row === 1 ? 600 : 420);
    } else {
      due = performance.now() + (/[。！？]/.test(char) ? 518 : /[，；：]/.test(char) ? 237 : 82);
    }
    schedule();
  }
  function complete() {
    if (finished) return;
    global.clearTimeout(timer); timer = 0; finished = true;
    lines.forEach(function (line) { paint(line, line.chars.length); });
    if (showAll) showAll.hidden = true;
    if (host) host.dataset.typing = 'complete';
    enterDue = performance.now() + 2000;
    maybeEnter();
    flushCompletion();
  }
  function flushCompletion() {
    if (!finished || !completionCallbacks.length) return;
    var callbacks = completionCallbacks.splice(0);
    // Paint the last character before starting any expensive scene work.
    global.requestAnimationFrame(function () {
      global.setTimeout(function () { callbacks.forEach(function (callback) { callback(); }); }, 0);
    });
  }
  function whenComplete(callback) {
    completionCallbacks.push(callback);
    flushCompletion();
  }
  function maybeEnter() {
    if (!finished || !onEnter || dismissed) return;
    global.clearTimeout(enterTimer);
    var remaining = enterDue - performance.now();
    if (remaining > 0) enterTimer = global.setTimeout(maybeEnter, remaining);
    else dismiss();
  }
  function visibility() {
    global.clearTimeout(timer); timer = 0;
    if (document.hidden) pausedAt = performance.now();
    else if (!finished && !dismissed) {
      if (pausedAt) due += performance.now() - pausedAt;
      pausedAt = 0; schedule();
    }
  }
  function preference() { if (motion.matches) complete(); }
  function dismiss() {
    if (!onEnter || dismissed || !finished || performance.now() < enterDue) return;
    dismissed = true;
    global.clearTimeout(enterTimer); enterTimer = 0;
    var moveFocus = host.contains(document.activeElement);
    document.removeEventListener('visibilitychange', visibility);
    motion.removeEventListener('change', preference);
    blocked.forEach(function (item) { item.el.inert = item.before; });
    host.dataset.state = 'ready';
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    onEnter();
    var map = document.getElementById('landmark-layer');
    if (map && moveFocus) map.focus({ preventScroll: true });
  }
  function start() {
    if (host) return;
    host = document.getElementById('terrain-preloader');
    if (!host) { finished = true; flushCompletion(); return; }
    enter = document.getElementById('intro-enter');
    showAll = document.getElementById('intro-show-all');
    lines = Array.prototype.map.call(host.querySelectorAll('[data-intro-line]'), function (element) {
      var text = element.textContent;
      element.setAttribute('aria-label', text);
      element.textContent = '';
      var visible = document.createElement('span'), remaining = document.createElement('span'), caret = document.createElement('span');
      visible.setAttribute('aria-hidden', 'true'); remaining.setAttribute('aria-hidden', 'true'); caret.setAttribute('aria-hidden', 'true');
      remaining.className = 'm-intro__remaining'; caret.className = 'm-intro__caret'; caret.hidden = true;
      remaining.textContent = text;
      element.appendChild(visible); element.appendChild(caret); element.appendChild(remaining);
      return { chars: Array.from(text), visible: visible, remaining: remaining, caret: caret };
    });
    blocked = Array.prototype.map.call(document.querySelectorAll('#app, .m-skip'), function (el) {
      var before = el.inert; el.inert = true; return { el: el, before: before };
    });
    showAll.addEventListener('click', complete);
    enter.addEventListener('click', dismiss);
    motion = global.matchMedia('(prefers-reduced-motion: reduce)');
    motion.addEventListener('change', preference);
    document.addEventListener('visibilitychange', visibility);
    host.dataset.typing = 'active';
    due = performance.now() + 320;
    if (document.hidden) pausedAt = performance.now();
    if (motion.matches) complete(); else schedule();
  }
  function ready(callback) {
    if (!host) { callback(); return; }
    if (onEnter) return;
    onEnter = callback;
    host.dataset.state = 'prepared';
    enter.disabled = false;
    maybeEnter();
  }
  global.IntroScreen = { start: start, ready: ready, whenComplete: whenComplete };
})(window);
