(function (global) {
  'use strict';
  var worker = null, nextId = 0, jobs = new Map();
  var diagnostics = { source: 'pending', prepareMs: 0, error: '' };
  function workerMain() {
    self.window = self;
    function database() {
      return new Promise(function (resolve) {
        var request;
        try { request = indexedDB.open('layers-of-life-terrain-v1', 1); } catch (e) { resolve(null); return; }
        request.onupgradeneeded = function () { request.result.createObjectStore('cycles'); };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { resolve(null); };
      });
    }
    async function readCache(key) {
      var db = await database(); if (!db) return null;
      return new Promise(function (resolve) {
        var request = db.transaction('cycles').objectStore('cycles').get('latest');
        request.onsuccess = function () { var entry = request.result; db.close(); resolve(entry && entry.key === key ? entry.cycle : null); };
        request.onerror = function () { db.close(); resolve(null); };
      });
    }
    async function writeCache(key, cycle) {
      var db = await database(); if (!db) return;
      try {
        var transaction = db.transaction('cycles', 'readwrite');
        transaction.objectStore('cycles').put({ key: key, cycle: cycle }, 'latest');
        transaction.oncomplete = transaction.onerror = transaction.onabort = function () { db.close(); };
      } catch (e) { db.close(); }
    }
    function buffers(value, seen, out) {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      if (ArrayBuffer.isView(value)) { if (!seen.has(value.buffer)) { seen.add(value.buffer); out.push(value.buffer); } return; }
      Object.keys(value).forEach(function (key) { buffers(value[key], seen, out); });
    }
    self.onmessage = async function (event) {
      var message = event.data, input = message.input, start = performance.now();
      try {
        // Geometry is independent of theme, viewport and sun; current light is
        // recalculated separately even on a cache hit. Keep only the latest cycle.
        var key = JSON.stringify({ revision: 2, fields: input.site.fields, terrain: input.site.terrain,
          ambient: input.site.environment.ambientTerrain, works: input.works, notes: input.notes,
          states: input.states, grid: [input.tokens.surfaceGrid, input.tokens.ambientSurfaceGrid] });
        var reusable = await readCache(key);
        var cycle = Scene._.MapEngine.computeWorkerCycle(input, reusable, function (progress) {
          self.postMessage({ id: message.id, progress: progress });
        });
        await writeCache(key, cycle);
        var transfer = []; buffers(cycle, new Set(), transfer);
        self.postMessage({ id: message.id, cycle: cycle, source: reusable ? 'cache' : 'worker',
          prepareMs: performance.now() - start }, transfer);
      } catch (error) { self.postMessage({ id: message.id, error: String(error.stack || error) }); }
    };
  }
  function prepare(input) {
    if (!global.Worker) return Promise.resolve(null);
    diagnostics = { source: 'pending', startedAt: performance.now(), prepareMs: 0, error: '' };
    return new Promise(function (resolve) {
      try {
        if (!worker) {
          // Reuse the loaded module source. Blob workers also work when the
          // owner opens index.html directly, where importScripts(file:) fails.
          var url = URL.createObjectURL(new Blob(['self.window=self;', global.Scene._.Terrain.workerSource,
            global.Scene._.MapEngine.workerSource, '(' + workerMain.toString() + ')()'], { type: 'text/javascript' }));
          worker = new Worker(url); URL.revokeObjectURL(url);
          worker.onmessage = function (event) {
            var result = event.data, job = jobs.get(result.id);
            if (!job || result.progress != null) return;
            jobs.delete(result.id);
            diagnostics = { source: result.source || 'fallback', startedAt: diagnostics.startedAt,
              readyAt: performance.now(), prepareMs: result.prepareMs || 0, error: result.error || '' };
            if (result.error) console.warn('[TerrainPrecompute]', result.error);
            job(result.cycle || null);
          };
          worker.onerror = function (event) {
            diagnostics.source = 'fallback'; diagnostics.error = event.message;
            jobs.forEach(function (job) { job(null); }); jobs.clear(); worker.terminate(); worker = null;
          };
        }
        var id = ++nextId; jobs.set(id, resolve);
        worker.postMessage({ id: id, input: input });
      } catch (error) { diagnostics.source = 'fallback'; diagnostics.error = String(error); resolve(null); }
    });
  }
  global.TerrainPrecompute = { prepare: prepare, inspect: function () { return Object.assign({}, diagnostics); } };
})(window);
