/* ============================================================================
   environment.js -- real-time sun position and ambient-terrain drivers
   ============================================================================ */
(function () {
  "use strict";

  if (!window.Scene) { window.Scene = {}; }
  if (!window.Scene._) { window.Scene._ = {}; }

  var signals = { mood: null, weather: null };
  var lightCache = { bucket: null, value: null };
  var clock = { manualMs: null, timezoneOffsetMinutes: null, timezoneLabel: "" };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function rad(v) { return v * Math.PI / 180; }
  function deg(v) { return v * 180 / Math.PI; }
  function norm360(v) { v %= 360; return v < 0 ? v + 360 : v; }

  function config() {
    return (window.SITE_DATA && window.SITE_DATA.environment) || {};
  }

  function locationConfig() {
    var loc = config().location || {};
    return {
      latitude: isFinite(loc.latitude) ? Number(loc.latitude) : 34.2667,
      longitude: isFinite(loc.longitude) ? Number(loc.longitude) : 108.9333,
      timezoneOffsetMinutes: isFinite(loc.timezoneOffsetMinutes)
        ? Number(loc.timezoneOffsetMinutes) : 480,
      label: String(loc.label || "")
    };
  }

  function resolveDate(date) {
    if (clock.manualMs != null && isFinite(clock.manualMs)) { return new Date(clock.manualMs); }
    return date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  }

  function smoothstep(a, b, v) {
    var t = clamp((v - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /* NOAA solar-position approximation. Azimuth is clockwise from north. */
  function solarPosition(date, latitude, longitude) {
    var d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
    var lat = clamp(Number(latitude) || 0, -90, 90);
    var lon = clamp(Number(longitude) || 0, -180, 180);
    var jd = d.getTime() / 86400000 + 2440587.5;
    var t = (jd - 2451545.0) / 36525;
    var l0 = norm360(280.46646 + t * (36000.76983 + t * 0.0003032));
    var m = norm360(357.52911 + t * (35999.05029 - 0.0001537 * t));
    var e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    var mr = rad(m);
    var c = Math.sin(mr) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
            Math.sin(2 * mr) * (0.019993 - 0.000101 * t) +
            Math.sin(3 * mr) * 0.000289;
    var trueLong = l0 + c;
    var omega = 125.04 - 1934.136 * t;
    var lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
    var seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
    var obliq0 = 23 + (26 + seconds / 60) / 60;
    var obliq = obliq0 + 0.00256 * Math.cos(rad(omega));
    var decl = Math.asin(Math.sin(rad(obliq)) * Math.sin(rad(lambda)));
    var y = Math.tan(rad(obliq / 2)); y *= y;
    var eq = 4 * deg(y * Math.sin(2 * rad(l0)) - 2 * e * Math.sin(mr) +
      4 * e * y * Math.sin(mr) * Math.cos(2 * rad(l0)) -
      0.5 * y * y * Math.sin(4 * rad(l0)) - 1.25 * e * e * Math.sin(2 * mr));
    var utcMinutes = d.getUTCHours() * 60 + d.getUTCMinutes() +
                     d.getUTCSeconds() / 60 + d.getUTCMilliseconds() / 60000;
    var solarMinutes = (utcMinutes + eq + 4 * lon) % 1440;
    if (solarMinutes < 0) { solarMinutes += 1440; }
    var hourAngle = solarMinutes / 4 - 180;
    var har = rad(hourAngle), latr = rad(lat);
    var cosZenith = Math.sin(latr) * Math.sin(decl) +
      Math.cos(latr) * Math.cos(decl) * Math.cos(har);
    var zenith = Math.acos(clamp(cosZenith, -1, 1));
    var elevation = 90 - deg(zenith);
    var azimuth = norm360(deg(Math.atan2(Math.sin(har),
      Math.cos(har) * Math.sin(latr) - Math.tan(decl) * Math.cos(latr))) + 180);
    return { azimuth: azimuth, elevation: elevation };
  }

  function getLight(date) {
    var d = resolveDate(date);
    var bucket = Math.floor(d.getTime() / 30000);
    if (lightCache.bucket === bucket && lightCache.value) { return lightCache.value; }
    var loc = locationConfig();
    var sunCfg = config().sun || {};
    var actual = solarPosition(d, loc.latitude, loc.longitude);
    var minElevation = isFinite(sunCfg.nightElevation) ? Number(sunCfg.nightElevation) : 7;
    var daylight = clamp((actual.elevation + 6) / 32, 0, 1);
    var dayBlend = smoothstep(-6, 6, actual.elevation);
    var mode = actual.elevation > 6 ? "day" : (actual.elevation < -6 ? "night" : "twilight");
    var twilight = mode === "twilight" ? 1 - Math.abs(actual.elevation) / 6 : 0;
    var nightFloor = isFinite(sunCfg.nightIntensity) ? Number(sunCfg.nightIntensity) : 0.18;
    var value = {
      azimuth: actual.azimuth,
      elevation: actual.elevation,
      renderElevation: Math.max(minElevation, actual.elevation),
      intensity: nightFloor + (1 - nightFloor) * daylight,
      isDaylight: actual.elevation >= -0.833,
      mode: mode,
      dayBlend: dayBlend,
      twilight: clamp(twilight, 0, 1),
      location: loc,
      key: (Math.round(actual.azimuth * 2) / 2).toFixed(1) + ":" +
           (Math.round(actual.elevation * 2) / 2).toFixed(1)
    };
    lightCache = { bucket: bucket, value: value };
    return value;
  }

  function ambientConfig() { return config().ambientTerrain || {}; }

  /* 光照预览时间可以被冻结，但远景动画仍继续运行。显式传入日期用于测试，
     页面逐帧传入真实时间。 */
  function resolveAmbientDate(date) {
    return date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  }

  function ambientStateAtPhase(phase) {
    var cfg = ambientConfig();
    var mood = signals.mood == null ? clamp(Number(cfg.mood) || 0.5, 0, 1) : signals.mood;
    var weather = signals.weather == null ? clamp(Number(cfg.weather) || 0.5, 0, 1) : signals.weather;
    var breathe = Math.max(0, Number(cfg.breathe) || 0.08);
    var drift = Math.max(0, Number(cfg.drift) || 0.008);
    var warp = Math.max(0, Number(cfg.warp) || 0.12);
    var driver = String(cfg.driver || "time");
    var influence = driver === "mood" ? mood : driver === "weather" ? weather :
                    driver === "hybrid" ? (mood + weather) / 2 : 0.5;
    return {
      driver: driver,
      phase: phase,
      height: 1 + breathe * Math.sin(phase) + (influence - 0.5) * 0.12,
      /* 使用整数谐波，phase=0 与 2π 的值和导数完全一致。 */
      driftX: drift * Math.sin(phase),
      /* 用正弦谐波让线性关键帧在循环接缝两侧也具有相同离散速度。
         余弦在极值处虽数学光滑，但相邻帧线性插值会形成可见折返。 */
      driftY: drift * 0.55 * Math.sin(phase * 2),
      warp: warp * (0.70 + influence * 0.30),
      mood: mood,
      weather: weather
    };
  }

  function getAmbientState(date) {
    var cfg = ambientConfig();
    var d = resolveAmbientDate(date);
    /* 演示态允许亚分钟周期；正式接入天气 / 心情后可把配置调回数分钟。 */
    var period = Math.max(0.1, Number(cfg.periodMinutes) || 8) * 60000;
    var phase = (d.getTime() % period) / period * Math.PI * 2;
    return ambientStateAtPhase(phase);
  }

  function setSignals(next) {
    var n = next || {};
    if (n.mood == null) { signals.mood = null; }
    else if (isFinite(n.mood)) { signals.mood = clamp(Number(n.mood), 0, 1); }
    if (n.weather == null) { signals.weather = null; }
    else if (isFinite(n.weather)) { signals.weather = clamp(Number(n.weather), 0, 1); }
    return { mood: signals.mood, weather: signals.weather };
  }

  function setClock(next) {
    var n = next || {};
    if (n.manual === false || n.dateMs == null) { clock.manualMs = null; }
    else if (isFinite(n.dateMs)) { clock.manualMs = Number(n.dateMs); }
    if (isFinite(n.timezoneOffsetMinutes)) {
      clock.timezoneOffsetMinutes = clamp(Number(n.timezoneOffsetMinutes), -720, 840);
    }
    if (n.timezoneLabel != null) { clock.timezoneLabel = String(n.timezoneLabel); }
    lightCache = { bucket: null, value: null };
    return getClock();
  }

  function getClock() {
    var loc = locationConfig();
    var offset = clock.timezoneOffsetMinutes == null
      ? loc.timezoneOffsetMinutes : clock.timezoneOffsetMinutes;
    return {
      manual: clock.manualMs != null,
      dateMs: clock.manualMs != null ? clock.manualMs : Date.now(),
      timezoneOffsetMinutes: offset,
      timezoneLabel: clock.timezoneLabel || offsetLabel(offset)
    };
  }

  function offsetLabel(minutes) {
    var m = Number(minutes) || 0;
    var sign = m < 0 ? "−" : "+";
    var a = Math.abs(m), hh = Math.floor(a / 60), mm = Math.round(a % 60);
    return "UTC" + sign + (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
  }

  function formatZoned(dateMs, offsetMinutes) {
    var d = new Date(Number(dateMs) + Number(offsetMinutes || 0) * 60000);
    function two(v) { return v < 10 ? "0" + v : String(v); }
    return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) +
      " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds());
  }

  window.Scene._.Environment = {
    solarPosition: solarPosition,
    getLight: getLight,
    getAmbientState: getAmbientState,
    getAmbientStateAtPhase: ambientStateAtPhase,
    setSignals: setSignals,
    setClock: setClock,
    getClock: getClock,
    formatZoned: formatZoned,
    offsetLabel: offsetLabel,
    getConfig: config
  };
})();
