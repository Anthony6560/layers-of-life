(function (global) {
  'use strict';
  function create(canvas, audio) {
    var ctx = canvas.getContext('2d'), data = global.PLAY_VISUALS_DATA;
    var raf = 0, disposed = false, lastTime = -1;
    var colors = {}, observer, themeObserver;
    var reduced = global.matchMedia('(prefers-reduced-motion: reduce)');
    function palette() {
      var css = global.getComputedStyle(canvas);
      ['--color-paper-0', '--color-paper-2', '--color-paper-4', '--color-accent', '--contour-color', '--color-ink-3'].forEach(function (key) { colors[key] = css.getPropertyValue(key).trim(); });
    }
    function resize() {
      var rect = canvas.getBoundingClientRect(), dpr = Math.min(2, global.devicePixelRatio || 1);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      draw();
    }
    function frame() {
      if (!data || !data.frames.length) return null;
      var position = Math.max(0, Math.min(data.frames.length - 1, audio.currentTime * data.fps));
      var lo = Math.floor(position), hi = Math.min(lo + 1, data.frames.length - 1), part = position - lo;
      return data.frames[lo].map(function (v, i) { return v + (data.frames[hi][i] - v) * part; });
    }
    function draw() {
      if (disposed || !ctx) return;
      var width = canvas.width, height = canvas.height, f = frame(), t = reduced.matches ? 0 : audio.currentTime;
      var energy = f ? f[0] / 255 : 0;
      ctx.setTransform(width / 1000, 0, 0, height / 562.5, 0, 0);
      ctx.clearRect(0, 0, 1000, 562.5);
      ctx.fillStyle = colors['--color-paper-0']; ctx.fillRect(0, 0, 1000, 562.5);
      var glow = ctx.createRadialGradient(730, 200, 10, 730, 200, 340);
      glow.addColorStop(0, colors['--color-paper-2']); glow.addColorStop(1, colors['--color-paper-0']);
      ctx.fillStyle = glow; ctx.fillRect(0, 0, 1000, 562.5);
      ctx.lineWidth = .8; ctx.strokeStyle = colors['--contour-color'];
      for (var ring = 0; ring < 13; ring++) {
        ctx.beginPath();
        var radius = 60 + ring * 19 + energy * 9;
        for (var step = 0; step <= 150; step++) {
          var angle = step / 150 * Math.PI * 2;
          var ripple = Math.sin(angle * 3 + t * .25 + ring * .15) * (3 + energy * 4);
          var x = 716 + Math.cos(angle) * (radius + ripple), y = 238 + Math.sin(angle) * (radius + ripple) * .77;
          if (!step) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath(); ctx.globalAlpha = .13 + ring / 13 * .13; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      for (var ribbon = 0; ribbon < 5; ribbon++) {
        var baseline = 279 + (ribbon - 2) * 15;
        var band = f ? f[1 + ribbon] / 255 : 0;
        ctx.beginPath();
        for (var i = 0; i < 100; i++) {
          var u = i / 99, wavePos = u * (data ? data.wave - 1 : 47), wi = Math.floor(wavePos), mix = wavePos - wi;
          var sample = f ? (f[1 + data.bands + wi] * (1 - mix) + f[1 + data.bands + Math.min(wi + 1, data.wave - 1)] * mix) / 127 : 0;
          var taper = Math.pow(Math.sin(u * Math.PI), 1.2);
          var drift = Math.sin(u * Math.PI * 3 + t * .7 + ribbon * .48) * (10 + energy * 20);
          var y = baseline + taper * (drift + sample * (32 + band * 70));
          if (!i) ctx.moveTo(70, y); else ctx.lineTo(70 + u * 860, y);
        }
        ctx.lineTo(930, 310 + ribbon * 12); ctx.lineTo(70, 310 + ribbon * 12); ctx.closePath();
        ctx.globalAlpha = .05; ctx.fillStyle = colors['--color-accent']; ctx.fill();
        ctx.globalAlpha = ribbon === 2 ? .8 : .3;
        ctx.strokeStyle = ribbon === 2 ? colors['--color-accent'] : colors['--contour-color']; ctx.lineWidth = ribbon === 2 ? 1.8 : .8; ctx.stroke();
      }
      for (var note = 0; note < 32; note++) {
        var strength = f ? f[1 + note % data.bands] / 255 : 0;
        var nx = 96 + note * 26, ny = 210 + Math.sin(note * .71 + t * .23) * 18;
        ctx.globalAlpha = .12 + strength * .44;
        ctx.strokeStyle = colors['--color-accent']; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(nx, ny - strength * 20); ctx.lineTo(nx, ny + strength * 20 + 2); ctx.stroke();
      }
      ctx.globalAlpha = .7; ctx.fillStyle = colors['--color-ink-3']; ctx.font = '12px Consolas, monospace';
      ctx.fillText('PLAY', 72, 64);
      ctx.globalAlpha = 1;
      canvas.dataset.audioTime = audio.currentTime.toFixed(3);
      lastTime = audio.currentTime;
    }
    function tick() {
      raf = 0;
      if (disposed || audio.paused || audio.ended || document.hidden || reduced.matches) return;
      if (audio.currentTime !== lastTime) draw();
      raf = global.requestAnimationFrame(tick);
    }
    function stop() { if (raf) global.cancelAnimationFrame(raf); raf = 0; }
    function start() { stop(); draw(); if (!audio.paused && !audio.ended && !document.hidden && !reduced.matches) raf = global.requestAnimationFrame(tick); }
    function pause() { stop(); draw(); }
    function visibility() { if (document.hidden) stop(); else start(); }
    palette();
    observer = new ResizeObserver(resize); observer.observe(canvas);
    themeObserver = new MutationObserver(function () { palette(); draw(); });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    audio.addEventListener('play', start); audio.addEventListener('pause', pause); audio.addEventListener('ended', pause); audio.addEventListener('seeked', draw);
    document.addEventListener('visibilitychange', visibility); reduced.addEventListener('change', start);
    resize();
    return { dispose: function () {
      disposed = true; stop(); observer.disconnect(); themeObserver.disconnect();
      audio.removeEventListener('play', start); audio.removeEventListener('pause', pause); audio.removeEventListener('ended', pause); audio.removeEventListener('seeked', draw);
      document.removeEventListener('visibilitychange', visibility); reduced.removeEventListener('change', start);
    } };
  }
  global.RhythmVisualizer = { create: create };
})(window);
