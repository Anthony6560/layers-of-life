/* Shared, elapsed-time camera motion. Units are milliseconds and radians. */
(function (global) {
  'use strict';
  var TAU = -1000 / 60 / Math.log(1 - .012);
  var SPIN = .000027;
  function delta(dt) { return Math.max(0, Math.min(100, Number(dt) || 0)); }
  function rate(dt) { return 1 - Math.exp(-delta(dt) / TAU); }
  function damp(current, target, dt) { return current + (target - current) * rate(dt); }
  function angle(current, target, dt) { return current + Math.atan2(Math.sin(target - current), Math.cos(target - current)) * rate(dt); }
  global.CameraMotion = { tauMs: TAU, settleMs: TAU * 4, radiansPerMs: SPIN, rate: rate, damp: damp, angle: angle, spin: function (dt) { return delta(dt) * SPIN; } };
})(window);
