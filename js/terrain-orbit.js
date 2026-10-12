/* Render the precomputed terrain loop in world coordinates. Camera changes do
 * not regenerate height fields, contours, or shadows. Three.js is local. */
(function (global) {
  'use strict';
  var T = global.THREE, renderer, scene, lineScene, compositeScene, camera, mesh, target;
  var frames = [], wantedFrames = [], cache = new Map(), lights, previousLights, pendingLights, lightStarted = 0;
  var failed = false, contextLost = false, gpuSuspended = false, rendererError = '', width = 0, height = 0, pixelRatio = 1, preparedFrames = 0;
  var uniforms, lineMaterials = [[], []], composite, fallbackTexture;
  var preparing = false;
  var projection = [
    'uniform vec2 mapSize, viewport, viewCenter, screenOffset;',
    'uniform vec4 angles; uniform float zoom, exaggeration;',
    'vec3 projectTerrain(vec3 p) {',
    ' float x = p.x * angles.x - p.y * angles.y;',
    ' float y = p.x * angles.y + p.y * angles.x;',
    ' float z = p.z * exaggeration;',
    ' vec2 screen = (vec2(x, y * angles.z - z * angles.w) * mapSize - viewCenter) * zoom + viewport * .5 + screenOffset;',
    ' return vec3(screen, -(y * angles.w - z * angles.z) / 32.);',
    '}',
    'vec4 clipTerrain(vec3 screen) { return vec4(screen.x / viewport.x * 2. - 1., 1. - screen.y / viewport.y * 2., screen.z, 1.); }'
  ].join('\n');
  function baseUniforms() {
    return { mapSize: { value: new T.Vector2(1, 1) }, viewport: { value: new T.Vector2(1, 1) }, viewCenter: { value: new T.Vector2() }, screenOffset: { value: new T.Vector2() }, angles: { value: new T.Vector4(1, 0, 1, 0) }, zoom: { value: 1 }, exaggeration: { value: .55 } };
  }
  function init() {
    if (renderer) return true;
    if (!T || failed || !global.document) return false;
    try {
      try {
        renderer = new T.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: true, powerPreference: 'default' });
      } catch (creationError) {
        renderer = new T.WebGLRenderer({ canvas: document.createElement('canvas'), alpha: true, antialias: false, powerPreference: 'low-power' });
      }
      renderer.setClearColor(0, 0); renderer.autoClear = false;
      scene = new T.Scene(); lineScene = new T.Scene(); compositeScene = new T.Scene(); camera = new T.Camera();
      uniforms = baseUniforms();
      fallbackTexture = new T.DataTexture(new Uint8Array([128, 0, 255, 255]), 1, 1); fallbackTexture.needsUpdate = true;
      Object.assign(uniforms, { phase: { value: 0 }, domain: { value: new T.Vector4() }, heightRange: { value: new T.Vector2(0, 1) }, low: { value: new T.Vector3() }, middle: { value: new T.Vector3() }, high: { value: new T.Vector3() }, dark: { value: new T.Vector3() }, bright: { value: new T.Vector3() }, alpha: { value: .8 }, contrast: { value: 1.55 }, slopeDark: { value: .34 }, slopeLight: { value: .18 }, castStrength: { value: .34 }, lightMix: { value: 1 }, lightA: { value: fallbackTexture }, lightB: { value: fallbackTexture }, oldLightA: { value: fallbackTexture }, oldLightB: { value: fallbackTexture } });
      var material = new T.ShaderMaterial({ uniforms: uniforms, transparent: true, side: T.DoubleSide,
        vertexShader: projection + '\nattribute float heightA, heightB; uniform float phase; uniform vec4 domain; varying float altitude; varying vec2 terrainUV; void main() { altitude = mix(heightA, heightB, phase); terrainUV = (position.xy - domain.xy) / domain.zw; gl_Position = clipTerrain(projectTerrain(vec3(position.xy, altitude))); }',
        fragmentShader: [
          'uniform vec3 low, middle, high, dark, bright; uniform vec2 heightRange;',
          'uniform float phase, alpha, contrast, slopeDark, slopeLight, castStrength, lightMix;',
          'uniform sampler2D lightA, lightB, oldLightA, oldLightB;',
          'varying float altitude; varying vec2 terrainUV;',
          'void main() {',
          ' float h = pow(clamp((altitude-heightRange.x)/max(.00001,heightRange.y-heightRange.x),0.,1.), .55);',
          ' vec3 color = h < .5 ? mix(low,middle,h*2.) : mix(middle,high,(h-.5)*2.);',
          ' vec3 illumination = mix(mix(texture2D(oldLightA,terrainUV).rgb,texture2D(oldLightB,terrainUV).rgb,phase),mix(texture2D(lightA,terrainUV).rgb,texture2D(lightB,terrainUV).rgb,phase),lightMix);',
          ' float slope = smoothstep(0.,1.,clamp(.5+(illumination.r-.5)*contrast,0.,1.))*2.-1.;',
          ' color = mix(color,slope < 0. ? dark : bright,abs(slope)*(slope < 0. ? slopeDark : slopeLight));',
          ' float daylight = smoothstep(0.,1.,illumination.b);',
          ' color = mix(color,dark,illumination.g*castStrength*daylight);',
          ' gl_FragColor = vec4(color,alpha);',
          '}'
        ].join('\n') });
      mesh = new T.Mesh(new T.BufferGeometry(), material); mesh.frustumCulled = false; scene.add(mesh);
      for (var bank = 0; bank < 2; bank++) for (var band = 0; band < 6; band++) {
        var u = Object.assign({}, uniforms, { lineColor: { value: new T.Vector3() }, opacity: { value: 0 }, lineWidth: { value: 1 } });
        lineMaterials[bank][band] = new T.ShaderMaterial({ uniforms: u, transparent: true, depthTest: false, depthWrite: false, side: T.DoubleSide,
          blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneFactor,
          vertexShader: projection + '\nattribute vec3 segmentStart, segmentEnd; uniform float lineWidth; varying float edge; void main(){vec3 a=projectTerrain(segmentStart),b=projectTerrain(segmentEnd);vec2 d=b.xy-a.xy;vec2 normal=vec2(-d.y,d.x)/max(.0001,length(d));vec3 p=mix(a,b,position.x);p.xy+=normal*position.y*(lineWidth+1.)*.5;edge=position.y;gl_Position=clipTerrain(p);}',
          fragmentShader: 'uniform vec3 lineColor; uniform float opacity; varying float edge; void main(){float a=opacity*(1.-smoothstep(.65,1.,abs(edge)));gl_FragColor=vec4(lineColor*a,a);}' });
      }
      var planeMaterial = new T.ShaderMaterial({ uniforms: { image: { value: null } }, transparent: true, depthTest: false, depthWrite: false, blending: T.CustomBlending, blendSrc: T.OneFactor, blendDst: T.OneMinusSrcAlphaFactor,
        vertexShader: 'varying vec2 texUV; void main(){texUV=position.xy*.5+.5;gl_Position=vec4(position.xy,0.,1.);}',
        fragmentShader: 'uniform sampler2D image; varying vec2 texUV; void main(){gl_FragColor=texture2D(image,texUV);}' });
      composite = new T.Mesh(new T.PlaneGeometry(2, 2), planeMaterial); composite.frustumCulled = false; compositeScene.add(composite);
      renderer.domElement.addEventListener('webglcontextlost', function (event) {
        event.preventDefault(); contextLost = true;
      });
      renderer.domElement.addEventListener('webglcontextrestored', function () {
        // Three.js restores its internal GL state first. Reuse the CPU loop;
        // warm its buffers and textures before restarting the moving view.
        width = height = 0;
        try { warmFrames(); contextLost = false; rendererError = ''; }
        catch (error) { rendererError = String(error.message || error); }
      });
      return true;
    } catch (error) { failed = true; rendererError = String(error.message || error); renderer = null; return false; }
  }
  function lightTexture(surface) {
    var n = surface.grid, q = surface.quads, bytes = new Uint8Array(n * n * 4), shadow = new Float32Array(n * n);
    var span = Math.max(.00001, surface.lamMax - surface.lamMin);
    for (var i = 0; i < n * n; i++) shadow[i] = q[i * 15 + 14];
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var k = y * n + x, blur = 0;
      // World-space Gaussian filtering: shadows remain soft during any orbit.
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) blur += shadow[Math.max(0, Math.min(n - 1, y + dy)) * n + Math.max(0, Math.min(n - 1, x + dx))] * (dx === 0 ? 2 : 1) * (dy === 0 ? 2 : 1);
      bytes[k * 4] = Math.round(Math.max(0, Math.min(1, (q[k * 15 + 12] - surface.lamMin) / span)) * 255);
      bytes[k * 4 + 1] = Math.round(blur / 16 * 255);
      bytes[k * 4 + 2] = Math.round(Math.max(0, Math.min(1, surface.lightIntensity)) * 255);
      bytes[k * 4 + 3] = 255;
    }
    var texture = new T.DataTexture(bytes, n, n); texture.minFilter = texture.magFilter = T.LinearFilter; texture.needsUpdate = true;
    if (!gpuSuspended) renderer.initTexture(texture); return texture;
  }
  function releaseLights(list) { if (list) new Set(list).forEach(function (tex) { tex.dispose(); }); }
  function prepareLighting(surfaces) {
    if (!renderer || contextLost || !surfaces || !surfaces.length) return;
    releaseLights(pendingLights); var seen = new Map();
    pendingLights = surfaces.map(function (surface) { if (!seen.has(surface)) seen.set(surface, lightTexture(surface)); return seen.get(surface); });
  }
  function activateLighting(now) {
    if (!pendingLights) return;
    releaseLights(previousLights); previousLights = lights; lights = pendingLights; pendingLights = null; lightStarted = now;
  }
  function discardPreparedLighting() { releaseLights(pendingLights); pendingLights = null; }
  function prepareFrames(next, onReady) {
    if (next && next.length) wantedFrames = next;
    if (!init() || !next || !next.length || frames === next) { if (onReady) onReady(!!renderer && !preparing); return !!renderer; }
    preparing = !!onReady;
    cache.forEach(function (entry) { entry.geometry.dispose(); entry.lines.children.forEach(function (line) { line.geometry.dispose(); }); entry.baseLight.dispose(); });
    cache.clear(); lineScene.clear(); mesh.geometry.dispose(); frames = next;
    releaseLights(lights); releaseLights(previousLights); releaseLights(pendingLights); lights = previousLights = pendingLights = null;
    var hf = next[0].hf, n = hf.n, count = n * n, source = next[0].meshSource;
    var positions = source ? source.positions : new Float32Array(count * 3);
    var indices = source ? source.indices : new Uint32Array((n - 1) * (n - 1) * 6), offset = 0;
    if (!source) for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var k = y * n + x; positions[k * 3] = hf.x0 + x * hf.cellX; positions[k * 3 + 1] = hf.y0 + y * hf.cellY;
      if (x < n - 1 && y < n - 1) { indices.set([k, k + 1, k + n + 1, k, k + n + 1, k + n], offset); offset += 6; }
    }
    var geometry = new T.BufferGeometry(); geometry.setAttribute('position', new T.BufferAttribute(positions, 3)); geometry.setIndex(new T.BufferAttribute(indices, 1)); mesh.geometry = geometry;
    uniforms.domain.value.set(hf.x0, hf.y0, hf.cellX * (n - 1), hf.cellY * (n - 1));
    function buildFrame(frame) {
      if (cache.has(frame)) return;
      var entry = { height: new T.BufferAttribute(frame.hf.data, 1), lines: new T.Group(), baseLight: lightTexture(frame.surfaceCache) };
      entry.geometry = new T.BufferGeometry(); entry.geometry.setAttribute('position', geometry.getAttribute('position')); entry.geometry.setIndex(geometry.index); entry.geometry.setAttribute('heightA', entry.height); entry.geometry.setAttribute('heightB', entry.height);
      frame.batches.forEach(function (batch, band) {
        var segmentCount = batch.length / 5, starts = new Float32Array(segmentCount * 3), ends = new Float32Array(segmentCount * 3);
        for (var i = 0; i < segmentCount; i++) { starts.set([batch[i * 5], batch[i * 5 + 1], batch[i * 5 + 4]], i * 3); ends.set([batch[i * 5 + 2], batch[i * 5 + 3], batch[i * 5 + 4]], i * 3); }
        var geo = new T.InstancedBufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0], 3)); geo.setIndex([0, 1, 2, 0, 2, 3]);
        geo.setAttribute('segmentStart', new T.InstancedBufferAttribute(starts, 3)); geo.setAttribute('segmentEnd', new T.InstancedBufferAttribute(ends, 3)); geo.instanceCount = segmentCount;
        var object = new T.Mesh(geo, lineMaterials[0][band]); object.frustumCulled = false; entry.lines.add(object);
      });
      entry.lines.visible = false; lineScene.add(entry.lines); cache.set(frame, entry);
    }
    function finish() {
      preparedFrames = cache.size;
      mesh.geometry = cache.get(next[0]).geometry;
      warmFrames(onReady ? function (success) { preparing = false; onReady(success !== false); } : null);
    }
    if (onReady) {
      var index = 0;
      function step() {
        try {
          buildFrame(next[index++]);
          if (index < next.length) global.setTimeout(step, 0);
          else finish();
        } catch (error) { preparing = false; frames = []; rendererError = String(error); onReady(false); }
      }
      global.setTimeout(step, 0);
    } else { next.forEach(buildFrame); finish(); }
    return true;
  }
  function warmFrames(onReady) {
    if (!renderer || gpuSuspended || !frames.length) { if (onReady) onReady(); return; }
    renderer.initTexture(fallbackTexture);
    cache.forEach(function (entry) { renderer.initTexture(entry.baseLight); });
    [lights, previousLights, pendingLights].forEach(function (list) {
      if (list) new Set(list).forEach(function (texture) { renderer.initTexture(texture); });
    });
    renderer.compile(scene, camera); renderer.compile(lineScene, camera); renderer.compile(compositeScene, camera);
    // Upload every loop frame before removing the loading screen. A 1px target
    // warms buffers/programs without filling a screen for each cached frame.
    var warm = new T.WebGLRenderTarget(1, 1); renderer.setRenderTarget(warm);
    function warmEntry(entry) {
      renderer.setRenderTarget(warm);
      mesh.geometry = entry.geometry; entry.lines.visible = true;
      renderer.render(scene, camera); renderer.render(lineScene, camera);
      entry.lines.visible = false; renderer.setRenderTarget(null);
    }
    function finish() { warm.dispose(); mesh.geometry = cache.get(frames[0]).geometry; if (onReady) onReady(); }
    if (onReady) {
      var entries = Array.from(cache.values()), index = 0;
      function step() {
        try { warmEntry(entries[index++]); if (index < entries.length) global.setTimeout(step, 0); else finish(); }
        catch (error) {
          rendererError = String(error); renderer.setRenderTarget(null); warm.dispose(); frames = [];
          onReady(false);
        }
      }
      renderer.setRenderTarget(null); global.setTimeout(step, 0);
    } else { cache.forEach(warmEntry); finish(); }
  }
  function setColor(uniform, rgb) { if (rgb) uniform.value.set(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255); }
  function prepareFramesAsync(next) {
    return new Promise(function (resolve) {
      try { prepareFrames(next, resolve); }
      catch (error) { preparing = false; rendererError = String(error); resolve(false); }
    });
  }
  function blend(a, b, t) { return a.map(function (v, i) { return v + (b[i] - v) * t; }); }
  function render(options) {
    if (gpuSuspended || !ready() || frames !== options.frames) return false;
    var a = cache.get(frames[options.index]), b = cache.get(frames[options.index + 1]); if (!a || !b) return false;
    var w = options.width, h = options.height, dpr = Math.min(1.75, options.dpr || 1);
    if (width !== w || height !== h || pixelRatio !== dpr) {
      width = w; height = h; pixelRatio = dpr; renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
      if (target) target.dispose(); target = new T.WebGLRenderTarget(Math.round(w * dpr), Math.round(h * dpr), { depthBuffer: false });
      composite.material.uniforms.image.value = target.texture;
    }
    var yaw = options.yaw * Math.PI / 180, pitch = options.pitch * Math.PI / 180, t = options.tokens, dim = options.dim;
    uniforms.mapSize.value.set(options.mapW, options.mapH); uniforms.viewport.value.set(w, h); uniforms.viewCenter.value.set(options.view.x, options.view.y); uniforms.screenOffset.value.set(options.translateX, options.translateY);
    uniforms.angles.value.set(Math.cos(yaw), Math.sin(yaw), Math.sin(pitch), Math.cos(pitch)); uniforms.zoom.value = options.view.scale; uniforms.exaggeration.value = options.ve; uniforms.phase.value = options.progress;
    uniforms.heightRange.value.set(frames[options.index].surfaceCache.hMin, frames[options.index].surfaceCache.hMax);
    setColor(uniforms.low, t.ambientSurfaceLow); setColor(uniforms.middle, t.ambientSurfaceColor); setColor(uniforms.high, t.ambientSurfaceHigh); setColor(uniforms.dark, t.ambientSurfaceShadeDark); setColor(uniforms.bright, t.ambientSurfaceShadeLight);
    uniforms.alpha.value = (t.ambientSurfaceAlpha * .4 + t.ambientSurfaceAlphaTop * .6) * dim;
    uniforms.contrast.value = t.lightContrast; uniforms.slopeDark.value = t.slopeDarkOpacity; uniforms.slopeLight.value = t.slopeLightOpacity; uniforms.castStrength.value = t.castShadowStrength;
    var p = Math.min(1, Math.max(0, (options.now - lightStarted) / 900)); uniforms.lightMix.value = previousLights ? p : 1;
    uniforms.lightA.value = lights ? lights[options.index] : a.baseLight; uniforms.lightB.value = lights ? lights[options.index + 1] : b.baseLight;
    uniforms.oldLightA.value = previousLights ? previousLights[options.index] : uniforms.lightA.value; uniforms.oldLightB.value = previousLights ? previousLights[options.index + 1] : uniforms.lightB.value;
    if (previousLights && p >= 1) { releaseLights(previousLights); previousLights = null; uniforms.oldLightA.value = uniforms.lightA.value; uniforms.oldLightB.value = uniforms.lightB.value; }
    mesh.geometry = a.geometry; mesh.geometry.setAttribute('heightB', b.height);
    cache.forEach(function (entry) { entry.lines.visible = false; });
    [a, b].forEach(function (entry, bank) {
      entry.lines.visible = true;
      entry.lines.children.forEach(function (object, bi) {
        object.material = lineMaterials[bank][bi]; var u = object.material.uniforms, band = Math.floor(bi / 2), index = bi % 2 === 1;
        var color = band === 0 ? t.ambientContourColor : band === 1 ? blend(t.ambientContourColor, t.contourColor, .52) : t.contourColor;
        var opacity = band === 0 ? index ? t.ambientContourOpacityIdx : t.ambientContourOpacity : band === 1 ? (index ? t.ambientContourOpacityIdx : t.ambientContourOpacity) * .45 + (index ? t.contourOpacityIdx : t.contourOpacity) * .55 : index ? t.contourOpacityIdx : t.contourOpacity;
        var lineWidth = band === 0 ? index ? t.ambientContourWidthIndex : t.ambientContourWidth : band === 1 ? (index ? t.ambientContourWidthIndex : t.ambientContourWidth) * .45 + (index ? t.contourWidthIndex : t.contourWidth) * .55 : index ? t.contourWidthIndex : t.contourWidth;
        setColor(u.lineColor, color); u.opacity.value = opacity * dim * (bank === 0 ? 1 - options.progress : options.progress); u.lineWidth.value = Math.max(index ? .8 : .4, lineWidth * options.view.scale);
      });
    });
    renderer.setRenderTarget(target); renderer.clear(); renderer.render(lineScene, camera);
    renderer.setRenderTarget(null); renderer.clear(); renderer.render(scene, camera); renderer.render(compositeScene, camera);
    options.ctx.save(); options.ctx.setTransform(1, 0, 0, 1, 0, 0); options.ctx.drawImage(renderer.domElement, 0, 0, options.canvas.width, options.canvas.height); options.ctx.restore();
    return true;
  }
  function ready() { return !!renderer && !preparing && !contextLost && !renderer.getContext().isContextLost() && !!frames.length; }
  function suspendGPU() {
    gpuSuspended = true;
    if (!renderer) return;
    // dispose removes GL allocations, keeping the geometry arrays and texture
    // images intact. Returning uploads the existing loop without recalculation.
    var resources = new Set([mesh.geometry, mesh.material, composite.geometry, composite.material, fallbackTexture]);
    cache.forEach(function (entry) {
      resources.add(entry.geometry); resources.add(entry.baseLight);
      entry.lines.children.forEach(function (line) { resources.add(line.geometry); });
    });
    lineMaterials.forEach(function (bank) { bank.forEach(function (material) { resources.add(material); }); });
    [lights, previousLights, pendingLights].forEach(function (list) { if (list) list.forEach(function (texture) { resources.add(texture); }); });
    resources.forEach(function (resource) { resource.dispose(); });
    if (target) { target.dispose(); target = null; }
    renderer.setRenderTarget(null);
    renderer.setSize(1, 1, false);
    width = height = 0;
    renderer.renderLists.dispose();
  }
  function resumeGPU() {
    if (!gpuSuspended) return;
    gpuSuspended = false;
    // Initial creation can fail while the driver is busy. Returning from a
    // working city scene retries with the already computed world frames.
    if (!renderer && wantedFrames.length) { failed = false; prepareFrames(wantedFrames); return; }
    if (ready()) warmFrames();
  }
  global.TerrainOrbit = { prepareFrames: prepareFrames, prepareFramesAsync: prepareFramesAsync, prepareLighting: prepareLighting, activateLighting: activateLighting, discardPreparedLighting: discardPreparedLighting, render: render, ready: ready, suspendGPU: suspendGPU, resumeGPU: resumeGPU, inspect: function () { return { ready: ready(), failed: failed, contextLost: contextLost, gpuSuspended: gpuSuspended, rendererError: rendererError, preparedFrames: preparedFrames, lightingReady: !!lights, lightingPrepared: !!pendingLights, width: width, height: height, geometries: renderer ? renderer.info.memory.geometries : 0, textures: renderer ? renderer.info.memory.textures : 0, glError: renderer ? renderer.getContext().getError() : null }; } };
})(window);
