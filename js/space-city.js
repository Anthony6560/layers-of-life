(function (global) {
  'use strict';

  var PROJECTS = [
    { id: 'checkup', index: '01', title: '城市体检', meta: '实习 · 深规院更新中心', type: 'CHECKUP', summary: '从南山进入城南古巷，查看片区底数、公共服务与出行覆盖。' },
    { id: 'convenience', index: '02', title: '便利店格局演化', meta: '课程项目 · 多源时空数据', type: 'SPACE-TIME', summary: '从分布、服务覆盖与时空演化，到深圳便利店网络的驱动机制。' }
  ];

  var MIN_DISTANCE = 1.5;
  var MAX_DISTANCE = 62;
  var GLOBAL_DISTANCE = 45;
  var GLOBAL_ELEVATION = .72;
  var DETAIL_ELEVATION = .32;
  var GLOBAL_ORBIT_TARGET = { x: 2.2, y: .45, z: -2.2 };
  var VIEW_TRANSITION_RATE = .012;
  var SHADOW_SLOT_MS = 10 * 60 * 1000;

  var state = {
    shell: null,
    stage: null,
    host: null,
    renderer: null,
    rendererError: '',
    contextLost: false,
    contextRecovery: null,
    rendererProfile: '',
    scene: null,
    camera: null,
    layers: {},
    materials: {},
    terrainMesh: null,
    sunLight: null,
    nextSunLight: null,
    shadowKey: '',
    preparedShadowKey: '',
    shadowTask: 0,
    shadowGeneration: 0,
    lastShadowBakeMs: 0,
    shadowsEnabled: false,
    cityMeta: null,
    baseMaterial: null,
    theme: '',
    frame: 0,
    open: false,
    built: false,
    assemblyStart: 0,
    activeProject: 0,
    azimuth: 2.4216,
    elevation: GLOBAL_ELEVATION,
    distance: 45,
    targetAzimuth: 2.4216,
    targetElevation: GLOBAL_ELEVATION,
    targetDistance: 45,
    orbitX: GLOBAL_ORBIT_TARGET.x,
    orbitY: GLOBAL_ORBIT_TARGET.y,
    orbitZ: GLOBAL_ORBIT_TARGET.z,
    targetOrbitX: GLOBAL_ORBIT_TARGET.x,
    targetOrbitY: GLOBAL_ORBIT_TARGET.y,
    targetOrbitZ: GLOBAL_ORBIT_TARGET.z,
    lastInteraction: 0,
    lastFrame: 0,
    wheelLock: 0,
    restoreFocus: null,
    onResize: null,
    resizeObserver: null,
    onKeydown: null
  };

  function css(name, fallback) {
    var value = global.getComputedStyle(state.shell || document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
  function ease(value) { return 1 - Math.pow(1 - clamp(value, 0, 1), 3); }

  function positionCamera() {
    var horizontal = Math.cos(state.elevation) * state.distance;
    state.camera.position.set(
      state.orbitX + Math.sin(state.azimuth) * horizontal,
      state.orbitY + Math.sin(state.elevation) * state.distance,
      state.orbitZ + Math.cos(state.azimuth) * horizontal
    );
    state.camera.lookAt(state.orbitX, state.orbitY, state.orbitZ);
  }

  function shellHTML() {
    var projects = PROJECTS.map(function (project, index) {
      return '<button class="s-project__button" type="button" data-project="' + index + '" data-project-id="' + project.id + '">' +
        '<span class="s-project__index">' + project.index + ' / ' + project.type + '</span>' +
        '<span class="s-project__title">' + project.title + '</span>' +
        '<span class="s-project__meta">' + project.meta + '</span></button>';
    }).join('');

    return '<section id="space-city" data-state="closed" role="dialog" aria-modal="true" ' +
      'aria-labelledby="space-city-title" aria-hidden="true">' +
      '<header class="s-city__bar">' +
        '<button class="s-city__back" type="button" data-city-action="close"><span aria-hidden="true">←</span><span>返回空间</span></button>' +
        '<div class="s-city__identity"><strong id="space-city-title">更“近”一步</strong><span>NANSHAN / URBAN SPACE &amp; TIME</span></div>' +
        '<div class="s-city__readout"><i aria-hidden="true"></i><span data-city-readout>AUTO ROTATION / TERRAIN ON</span></div>' +
      '</header>' +
      '<div class="s-city__body">' +
        '<div class="s-city__stage" data-city-stage data-view="global">' +
          '<div class="s-city__canvas" data-city-canvas></div>' +
          '<div class="s-city__stamp" aria-hidden="true"><b>NS</b><span>URBAN SECTION<br>1 : 24000</span></div>' +
          '<div class="s-city__attribution">DEM 150M / CGCS2000</div>' +
          '<div class="s-city__toolbar">' +
            '<div class="s-city__zoom" aria-label="视图缩放">' +
              '<button class="s-city__icon-button" type="button" data-city-action="zoom-in" aria-label="放大">+</button>' +
              '<button class="s-city__icon-button" type="button" data-city-action="zoom-out" aria-label="缩小">−</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<aside class="s-projects" aria-label="项目入口">' +
          '<div class="s-projects__head"><p>PROJECT INDEX / ' + String(PROJECTS.length).padStart(2, '0') + '</p><h2>项目入口</h2></div>' +
          '<div class="s-projects__orbit" data-project-orbit>' + projects + '</div>' +
          '<div class="s-projects__detail" aria-live="polite">' +
            '<p class="s-projects__type" data-project-type></p>' +
            '<p class="s-projects__summary" data-project-summary></p>' +
            '<p class="s-projects__state"></p>' +
          '</div>' +
        '</aside>' +
      '</div>' +
    '</section>';
  }

  function mountShell() {
    if (state.shell) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = shellHTML();
    state.shell = wrap.firstChild;
    document.body.appendChild(state.shell);
    state.stage = state.shell.querySelector('[data-city-stage]');
    state.host = state.shell.querySelector('[data-city-canvas]');

    state.shell.addEventListener('click', handleShellClick);
    state.stage.addEventListener('click', toggleMapView);
    state.shell.querySelector('[data-project-orbit]').addEventListener('wheel', projectWheel, { passive: false });

    state.onResize = resize;
    state.onKeydown = keydown;
    global.addEventListener('resize', state.onResize);
    if (global.ResizeObserver) {
      state.resizeObserver = new global.ResizeObserver(resize);
      state.resizeObserver.observe(state.host);
    }
    document.addEventListener('keydown', state.onKeydown);
    updateProject(0, false);
  }

  function makeLineMaterial(color, opacity) {
    var material = new global.THREE.LineBasicMaterial({ color: color, transparent: true, opacity: opacity, depthWrite: false });
    material.userData.baseOpacity = opacity;
    return material;
  }

  function makeCitySurface(options) {
    var THREE = global.THREE;
    // Per-light fragment shadows: an intensity-zero precomputed sun must not
    // multiply the current sun's lighting (MeshLambert's getShadowMask does).
    var material = new THREE.MeshPhongMaterial(Object.assign({ specular: 0x000000, shininess: 0 }, options));
    material.extensions = { derivatives: true };
    material.onBeforeCompile = function (shader) {
      var chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
      var start = chunk.indexOf('\tfloat getShadow(');
      var end = chunk.indexOf('\tvec2 cubeToUV', start);
      var getShadow = chunk.slice(start, end);
      // PCF neighbors lie at different depths on a sloped receiver. Compare
      // against that receiver plane at each actual depth-map texel center.
      getShadow = getShadow.replace('shadowCoord.z += shadowBias;',
        'shadowCoord.z += shadowBias;\n' +
        'vec3 cityDx = dFdx(shadowCoord.xyz), cityDy = dFdy(shadowCoord.xyz);\n' +
        'float cityDet = cityDx.x * cityDy.y - cityDx.y * cityDy.x;\n' +
        'vec2 cityDepthGradient = abs(cityDet) > 1e-12 ? vec2(cityDx.z * cityDy.y - cityDy.z * cityDx.y, cityDy.z * cityDx.x - cityDx.z * cityDy.x) / cityDet : vec2(0.0);');
      getShadow = getShadow.split('texture2DCompare( shadowMap,').join('cityShadowCompare( shadowMap,')
        .split('shadowCoord.z )').join('shadowCoord.z, shadowCoord.xy, cityDepthGradient, shadowMapSize )');
      var helper = 'float cityShadowCompare(sampler2D depths, vec2 uv, float depth, vec2 receiverUV, vec2 gradient, vec2 size) {\n' +
        'vec2 center = (floor(uv * size) + 0.5) / size;\n' +
        'return step(depth + dot(gradient, center - receiverUV), unpackRGBAToDepth(texture2D(depths, uv)));\n}\n';
      shader.fragmentShader = shader.fragmentShader.replace('#include <shadowmap_pars_fragment>',
        chunk.slice(0, start) + helper + getShadow + chunk.slice(end));
    };
    return material;
  }

  function pointInRing(point, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var a = ring[i], b = ring[j];
      var crosses = ((a[1] > point[1]) !== (b[1] > point[1])) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / ((b[1] - a[1]) || 1e-9) + a[0];
      if (crosses) inside = !inside;
    }
    return inside;
  }

  function insideBoundary(point, boundary) {
    return boundary.some(function (ring) { return pointInRing(point, ring); });
  }

  function sampleTerrain(terrain, x, z) {
    // Use the exact rendered triangle plane, not a different bilinear surface.
    if (terrain && terrain.surfaceCells) {
      var gx = clamp(Math.floor((x - terrain.x0) / terrain.dx), 0, terrain.width - 2);
      var gz = clamp(Math.floor((z - terrain.y0) / terrain.dy), 0, terrain.height - 2);
      var triangles = terrain.surfaceCells[gz * (terrain.width - 1) + gx] || [];
      for (var i = 0; i < triangles.length; i++) {
        var t = triangles[i], a = t[0], b = t[1], c = t[2];
        var denominator = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
        if (Math.abs(denominator) < 1e-12) continue;
        var u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / denominator;
        var v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / denominator;
        if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) return u * a[1] + v * b[1] + (1 - u - v) * c[1];
      }
    }
    return sampleTerrainGrid(terrain, x, z);
  }

  function sampleTerrainGrid(terrain, x, z) {
    if (!terrain || !terrain.heights || !terrain.width || !terrain.height) return 0;
    var fx = clamp((x - terrain.x0) / terrain.dx, 0, terrain.width - 1);
    var fy = clamp((z - terrain.y0) / terrain.dy, 0, terrain.height - 1);
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var x1 = Math.min(terrain.width - 1, x0 + 1), y1 = Math.min(terrain.height - 1, y0 + 1);
    var tx = fx - x0, ty = fy - y0;
    var a = terrain.heights[y0 * terrain.width + x0] || 0;
    var b = terrain.heights[y0 * terrain.width + x1] || 0;
    var c = terrain.heights[y1 * terrain.width + x0] || 0;
    var d = terrain.heights[y1 * terrain.width + x1] || 0;
    return ((a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty) * terrain.verticalScale;
  }

  function segmentIntersection(a, b, c, d) {
    var abx = b[0] - a[0], abz = b[1] - a[1];
    var cdx = d[0] - c[0], cdz = d[1] - c[1];
    var denominator = abx * cdz - abz * cdx;
    if (Math.abs(denominator) < 1e-10) return null;
    var acx = c[0] - a[0], acz = c[1] - a[1];
    var t = (acx * cdz - acz * cdx) / denominator;
    var u = (acx * abz - acz * abx) / denominator;
    if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
    return [a[0] + abx * t, a[1] + abz * t];
  }

  function clippedCell(ring, minX, minZ, maxX, maxZ) {
    var corners = [[minX, minZ], [maxX, minZ], [maxX, maxZ], [minX, maxZ]];
    var inside = corners.map(function (point) { return pointInRing(point, ring); });
    if (inside.every(Boolean)) return corners;
    var points = corners.filter(function (_, index) { return inside[index]; });
    var edges = [[corners[0], corners[1]], [corners[1], corners[2]], [corners[2], corners[3]], [corners[3], corners[0]]];
    for (var i = 0; i < ring.length; i++) {
      var a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[0] >= minX && a[0] <= maxX && a[1] >= minZ && a[1] <= maxZ) points.push([a[0], a[1]]);
      edges.forEach(function (edge) {
        var hit = segmentIntersection(a, b, edge[0], edge[1]);
        if (hit) points.push(hit);
      });
    }
    var unique = [];
    points.forEach(function (point) {
      if (!unique.some(function (other) { return Math.abs(point[0] - other[0]) < 1e-6 && Math.abs(point[1] - other[1]) < 1e-6; })) unique.push(point);
    });
    if (unique.length < 3) return [];
    var center = unique.reduce(function (sum, point) { return [sum[0] + point[0], sum[1] + point[1]]; }, [0, 0]);
    center[0] /= unique.length; center[1] /= unique.length;
    return unique.sort(function (a, b) {
      return Math.atan2(a[1] - center[1], a[0] - center[0]) - Math.atan2(b[1] - center[1], b[0] - center[0]);
    });
  }

  function terrainGeometry(data) {
    var THREE = global.THREE;
    var terrain = data.terrain;
    var positions = [], uvs = [];
    terrain.surfaceCells = [];
    var maxX = terrain.x0 + terrain.dx * (terrain.width - 1);
    var maxY = terrain.y0 + terrain.dy * (terrain.height - 1);
    function vertexAt(point) {
      return [Math.fround(point[0]), Math.fround(sampleTerrainGrid(terrain, point[0], point[1])), Math.fround(point[1])];
    }
    function push(vertex) {
      positions.push(vertex[0], vertex[1], vertex[2]);
      uvs.push((vertex[0] - terrain.x0) / (maxX - terrain.x0), (vertex[2] - terrain.y0) / (maxY - terrain.y0));
      return vertex;
    }
    for (var gy = 0; gy < terrain.height - 1; gy++) {
      for (var gx = 0; gx < terrain.width - 1; gx++) {
        var minX = terrain.x0 + gx * terrain.dx;
        var minZ = terrain.y0 + gy * terrain.dy;
        var maxCellX = minX + terrain.dx;
        var maxCellZ = minZ + terrain.dy;
        var cell = terrain.surfaceCells[gy * (terrain.width - 1) + gx] = [];
        data.boundary.forEach(function (ring) {
          var polygon = clippedCell(ring, minX, minZ, maxCellX, maxCellZ);
          for (var p = 1; p < polygon.length - 1; p++) {
            // Y-up normals are needed even with the GIS negative-Z transform.
            var a = vertexAt(polygon[0]), b = vertexAt(polygon[p + 1]), c = vertexAt(polygon[p]);
            var area = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
            // Clipped boundary slivers can collapse or invert when stored as Float32.
            if (Math.abs(area) < 1e-10) continue;
            if (area > 0) { var swap = b; b = c; c = swap; }
            cell.push([push(a), push(b), push(c)]);
          }
        });
      }
    }
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  function buildBase(data, colors) {
    var THREE = global.THREE;
    var group = state.layers.base;
    var lineMat = makeLineMaterial(colors.space, .88);
    var fillMat = makeCitySurface({ color: colors.paper2, side: THREE.DoubleSide });
    var sideMat = makeCitySurface({ color: colors.spaceDark, transparent: true, opacity: .7, side: THREE.DoubleSide });
    var bottomMat = new THREE.MeshBasicMaterial({ color: colors.paper2, transparent: true, opacity: .9, side: THREE.DoubleSide });
    state.baseMaterial = fillMat;
    state.materials.terrain = fillMat;
    state.materials.boundary = lineMat;
    state.materials.baseSide = sideMat;
    state.terrainMesh = new THREE.Mesh(terrainGeometry(data), fillMat);
    state.terrainMesh.castShadow = true;
    state.terrainMesh.receiveShadow = true;
    group.add(state.terrainMesh);

    var thickness = .18;
    data.boundary.forEach(function (ring) {
      var points = ring.map(function (p) { return new THREE.Vector3(p[0], .012, p[1]); });
      group.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), lineMat));

      var shape = new THREE.Shape();
      ring.forEach(function (p, i) { if (i === 0) shape.moveTo(p[0], p[1]); else shape.lineTo(p[0], p[1]); });
      var bottomGeometry = new THREE.ShapeGeometry(shape);
      var bottom = new THREE.Mesh(bottomGeometry, bottomMat);
      bottom.rotation.x = Math.PI / 2;
      bottom.position.y = -thickness;
      group.add(bottom);

      var sides = [];
      for (var i = 0; i < ring.length; i++) {
        var a = ring[i], b = ring[(i + 1) % ring.length];
        sides.push(a[0],0,a[1], b[0],0,b[1], b[0],-thickness,b[1]);
        sides.push(a[0],0,a[1], b[0],-thickness,b[1], a[0],-thickness,a[1]);
      }
      var sideGeometry = new THREE.BufferGeometry();
      sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(sides, 3));
      sideGeometry.computeVertexNormals();
      group.add(new THREE.Mesh(sideGeometry, sideMat));
    });

  }

  function updateCityTheme(force) {
    var night = document.documentElement.classList.contains('m-theme-night');
    var theme = night ? 'night' : 'light';
    if (!force && state.theme === theme) return;
    state.theme = theme;
    var palette = night ? {
      road: css('--contour-color', '#AAB79E'),
      building: css('--terrain-surface-shade-dark', '#202A24'),
      buildingEdge: css('--terrain-surface', '#485744'),
      boundary: css('--ambient-contour-color', '#73816E'),
      terrain: css('--ambient-surface-low', '#1F2C24')
    } : {
      road: css('--terrain-surface-shade-dark', '#5E7050'),
      building: css('--terrain-surface', '#A8B893'),
      buildingEdge: '#718362',
      boundary: css('--color-space-light', '#8B9FA7'),
      terrain: '#D7DED0'
    };
    var roadTone = night ? { trunk: .03, primary: .01, secondary: -.01, local: -.03 } :
      { trunk: -.03, primary: -.01, secondary: .01, local: .03 };
    if (state.materials.roads) state.materials.roads.forEach(function (material) {
      material.color.set(palette.road);
      material.color.offsetHSL(0, 0, roadTone[material.userData.roadLevel] || 0);
    });
    if (state.materials.buildingFace) {
      state.materials.buildingFace.color.set(palette.building);
    }
    if (state.materials.buildingLine) state.materials.buildingLine.color.set(palette.buildingEdge);
    if (state.materials.boundary) state.materials.boundary.color.set(palette.boundary);
    if (state.materials.terrain) state.materials.terrain.color.set(palette.terrain);
  }

  function shadowFocus() {
    var detail = state.targetDistance <= MIN_DISTANCE + .01;
    var checkup = global.CityCheckup && global.CityCheckup.isActive();
    return {
      x: state.targetOrbitX,
      y: state.targetOrbitY,
      z: state.targetOrbitZ,
      extent: checkup ? 4 : detail ? 1.8 : 18,
      key: (checkup ? 'checkup:' : detail ? 'detail:' : 'global:') +
        state.targetOrbitX.toFixed(3) + ':' + state.targetOrbitY.toFixed(3) + ':' + state.targetOrbitZ.toFixed(3)
    };
  }

  function shadowLightAt(environment, slot) {
    // The city is Shenzhen, independently of the homepage's site location.
    var sun = environment.solarPosition(slot * SHADOW_SLOT_MS + SHADOW_SLOT_MS * .5, 22.54, 113.95);
    sun.mode = sun.elevation > 6 ? 'day' : sun.elevation < -6 ? 'night' : 'twilight';
    return sun;
  }

  function lightIntensity(light) {
    return light.mode === 'night' ? .16 : light.mode === 'twilight' ? .52 : .78;
  }

  function refreshShadowMaterials() {
    if (!state.scene) return;
    state.scene.traverse(function (object) {
      if (!object.material) return;
      var materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach(function (material) { material.needsUpdate = true; });
    });
  }

  function configureSunLight(sun, light, focus, intensity) {
    var azimuth = (Number(light.azimuth) || 0) * Math.PI / 180;
    var elevation = Math.max(3, Number(light.elevation) || 3) * Math.PI / 180;
    var distance = 35;
    var horizontal = Math.cos(elevation) * distance;
    sun.position.set(
      focus.x + Math.sin(azimuth) * horizontal,
      focus.y + Math.sin(elevation) * distance,
      focus.z - Math.cos(azimuth) * horizontal
    );
    sun.target.position.set(focus.x, focus.y, focus.z);
    sun.intensity = intensity;
    sun.visible = true;
    sun.castShadow = true;
    sun.shadow.camera.left = -focus.extent;
    sun.shadow.camera.right = focus.extent;
    sun.shadow.camera.top = focus.extent;
    sun.shadow.camera.bottom = -focus.extent;
    sun.shadow.camera.updateProjectionMatrix();
    sun.target.updateMatrixWorld();
    sun.updateMatrixWorld();
  }

  function cancelShadowTask() {
    state.shadowGeneration++;
    if (!state.shadowTask) return;
    global.clearTimeout(state.shadowTask);
    state.shadowTask = 0;
  }

  function scheduleShadowBake(sun, key, done) {
    cancelShadowTask();
    var generation = state.shadowGeneration;
    var bake = function () {
      state.shadowTask = 0;
      if (generation !== state.shadowGeneration || !state.open || !state.shadowsEnabled || state.renderer.getContext().isContextLost()) return;
      var startedAt = performance.now();
      // Background RAF throttling must not bake the assembly's compressed buildings.
      var visibleScale = state.layers.buildings.scale.y;
      state.layers.buildings.scale.y = 1;
      state.scene.updateMatrixWorld(true);
      sun.shadow.needsUpdate = true;
      state.renderer.shadowMap.needsUpdate = true;
      try {
        state.renderer.render(state.scene, state.camera);
      } finally {
        state.layers.buildings.scale.y = visibleScale;
        state.scene.updateMatrixWorld(true);
        state.renderer.shadowMap.needsUpdate = false;
        sun.shadow.needsUpdate = false;
      }
      state.lastShadowBakeMs = performance.now() - startedAt;
      if (done) done(key);
    };
    var assemblyRemaining = state.assemblyStart ? state.assemblyStart + 2800 - performance.now() : 0;
    state.shadowTask = global.setTimeout(bake, Math.max(300, assemblyRemaining));
  }

  function prepareNextShadow(environment, slot, focus, manualClock) {
    if (manualClock) {
      state.preparedShadowKey = '';
      return;
    }
    var nextSlot = slot + 1;
    var nextLight = shadowLightAt(environment, nextSlot);
    var nextKey = nextSlot + ':' + focus.key + ':' + nextLight.mode;
    if (nextLight.mode === 'night') {
      state.preparedShadowKey = '';
      return;
    }
    configureSunLight(state.nextSunLight, nextLight, focus, 0);
    state.nextSunLight.shadow.needsUpdate = false;
    scheduleShadowBake(state.nextSunLight, nextKey, function (readyKey) {
      state.preparedShadowKey = readyKey;
    });
  }

  function disableNightShadows(light, key) {
    cancelShadowTask();
    state.renderer.shadowMap.enabled = false;
    state.shadowsEnabled = false;
    state.sunLight.castShadow = false;
    state.nextSunLight.castShadow = false;
    state.sunLight.intensity = lightIntensity(light);
    state.nextSunLight.intensity = 0;
    state.shadowKey = key;
    state.preparedShadowKey = '';
  }

  function updateSunLight() {
    if (!state.sunLight || !state.nextSunLight) return;
    if (global.ConvenienceStoreCube && global.ConvenienceStoreCube.isActive()) {
      if (state.shadowKey === 'store-cube') return;
      cancelShadowTask();
      state.renderer.shadowMap.enabled = false;
      state.shadowsEnabled = false;
      state.sunLight.visible = false;
      state.nextSunLight.visible = false;
      state.shadowKey = 'store-cube';
      state.preparedShadowKey = '';
      return;
    }
    state.sunLight.visible = true;
    state.nextSunLight.visible = true;
    var environment = global.Scene && global.Scene._ && global.Scene._.Environment;
    if (!environment || !environment.getLight || !environment.getClock) return;
    var clock = environment.getClock();
    var slot = Math.floor(clock.dateMs / SHADOW_SLOT_MS);
    var focus = shadowFocus();
    var light = shadowLightAt(environment, slot);
    var night = light.mode === 'night' || document.documentElement.classList.contains('m-theme-night');
    var key = slot + ':' + focus.key + ':' + (night ? 'night' : light.mode);
    if (key === state.shadowKey && state.shadowsEnabled === !night) return;
    if (night) {
      disableNightShadows(light, key);
      return;
    }

    cancelShadowTask();
    state.renderer.shadowMap.enabled = true;
    state.shadowsEnabled = true;
    refreshShadowMaterials();
    if (state.preparedShadowKey === key) {
      var swap = state.sunLight;
      state.sunLight = state.nextSunLight;
      state.nextSunLight = swap;
      state.sunLight.intensity = lightIntensity(light);
      state.nextSunLight.intensity = 0;
      state.nextSunLight.castShadow = false;
      state.shadowKey = key;
      state.preparedShadowKey = '';
      prepareNextShadow(environment, slot, focus, clock.manual);
      return;
    }

    configureSunLight(state.sunLight, light, focus, lightIntensity(light));
    state.nextSunLight.intensity = 0;
    state.nextSunLight.castShadow = false;
    state.shadowKey = key;
    state.preparedShadowKey = '';
    scheduleShadowBake(state.sunLight, key, function () {
      prepareNextShadow(environment, slot, focus, clock.manual);
    });
  }

  function roadRibbonGeometry(lines, width, terrain) {
    var THREE = global.THREE;
    var positions = [], indices = [];
    lines.forEach(function (line) {
      for (var i = 1; i < line.length; i++) {
        var a = line[i - 1], b = line[i];
        var dx = b[0] - a[0], dz = b[1] - a[1];
        var length = Math.hypot(dx, dz);
        if (!length) continue;
        var nx = -dz / length * width * .5;
        var nz = dx / length * width * .5;
        var ay = sampleTerrain(terrain, a[0], a[1]) + .0004;
        var by = sampleTerrain(terrain, b[0], b[1]) + .0004;
        var offset = positions.length / 3;
        positions.push(a[0] + nx, ay, a[1] + nz, a[0] - nx, ay, a[1] - nz);
        positions.push(b[0] + nx, by, b[1] + nz, b[0] - nx, by, b[1] - nz);
        indices.push(offset, offset + 2, offset + 1, offset + 1, offset + 2, offset + 3);
      }
    });
    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  function buildRoads(data, colors) {
    var THREE = global.THREE;
    var styles = {
      trunk: { width: .072, opacity: .98 },
      primary: { width: .046, opacity: .88 },
      secondary: { width: .028, opacity: .7 },
      local: { width: .014, opacity: .5 }
    };
    state.materials.roads = [];
    state.layers.roads.userData.drawObjects = [];
    Object.keys(styles).forEach(function (level) {
      var style = styles[level];
      var material = makeCitySurface({ color: colors.ink, transparent: true, opacity: style.opacity, depthWrite: false, side: THREE.DoubleSide });
      material.userData.roadLevel = level;
      var geometry = roadRibbonGeometry(data.roads[level] || [], style.width, data.terrain);
      var object = new THREE.Mesh(geometry, material);
      object.receiveShadow = true;
      object.userData.fullCount = geometry.index ? geometry.index.count : 0;
      object.userData.level = level;
      state.materials.roads.push(material);
      state.layers.roads.userData.drawObjects.push(object);
      state.layers.roads.add(object);
    });
  }

  function buildingGeometry(buildings, terrain) {
    var THREE = global.THREE;
    var edges = [];
    var faces = [];
    var ranges = [];
    buildings.forEach(function (building, buildingIndex) {
      var faceStart = faces.length / 3;
      var edgeStart = edges.length / 3;
      var height = building[0];
      var sourceRings = building[1];
      if (!sourceRings || !sourceRings[0] || sourceRings[0].length < 3) return;
      var rings = sourceRings.map(function (ring, index) {
        var points = ring.slice();
        var clockwise = THREE.ShapeUtils.isClockWise(points.map(function (p) { return new THREE.Vector2(p[0], p[1]); }));
        // Exterior wall normals point outwards; holes point into the courtyard.
        if (clockwise !== (index === 0)) points.reverse();
        return points;
      });
      var ground = rings[0].map(function (point) {
        return sampleTerrain(terrain, point[0], point[1]);
      });
      var averageGround = ground.reduce(function (sum, value) { return sum + value; }, 0) / ground.length;
      var roof = Math.max(Math.max.apply(null, ground) + .001, averageGround + height);
      var contour = rings[0].map(function (p) { return new THREE.Vector2(Math.fround(p[0]), Math.fround(p[1])); });
      var holes = rings.slice(1).map(function (ring) {
        return ring.map(function (p) { return new THREE.Vector2(Math.fround(p[0]), Math.fround(p[1])); });
      });
      var flat = contour.slice();
      holes.forEach(function (hole) { flat = flat.concat(hole); });
      var triangles = THREE.ShapeUtils.triangulateShape(contour.slice(), holes.map(function (hole) { return hole.slice(); }));
      triangles.forEach(function (triangle) {
        var a = flat[triangle[0]], b = flat[triangle[1]], c = flat[triangle[2]];
        var area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        if (Math.abs(area) < 1e-10) return;
        var upward = area < 0;
        (upward ? triangle : [triangle[0], triangle[2], triangle[1]]).forEach(function (index) {
          var p = flat[index];
          faces.push(p.x, roof, p.y);
        });
      });
      rings.forEach(function (ring) {
        for (var i = 0; i < ring.length; i++) {
          var a = ring[i], b = ring[(i + 1) % ring.length];
          var aBase = sampleTerrain(terrain, a[0], a[1]) - .0002;
          var bBase = sampleTerrain(terrain, b[0], b[1]) - .0002;
          edges.push(a[0],roof,a[1], b[0],roof,b[1]);
          edges.push(a[0],aBase,a[1], a[0],roof,a[1]);
          faces.push(a[0],aBase,a[1], b[0],bBase,b[1], b[0],roof,b[1]);
          faces.push(a[0],aBase,a[1], b[0],roof,b[1], a[0],roof,a[1]);
        }
      });
      ranges.push({ index: buildingIndex, start: faceStart, count: faces.length / 3 - faceStart,
        edgeStart: edgeStart, edgeCount: edges.length / 3 - edgeStart });
    });
    return { edges: edges, faces: faces, ranges: ranges };
  }

  function buildBuildings(data, colors) {
    var THREE = global.THREE;
    var group = state.layers.buildings;
    var lineMat = makeLineMaterial(colors.spaceDark, .72);
    var faceMat = makeCitySurface({ color: colors.spaceLight, depthWrite: true, side: THREE.DoubleSide });
    state.materials.buildingLine = lineMat;
    state.materials.buildingFace = faceMat;

    var built = buildingGeometry(data.buildings, data.terrain);
    var lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute('position', new THREE.Float32BufferAttribute(built.edges, 3));
    var lines = new THREE.LineSegments(lineGeometry, lineMat);
    lines.userData.fullCount = lineGeometry.getAttribute('position').count;
    group.add(lines);
    group.userData.drawObject = lines;

    var faceGeometry = new THREE.BufferGeometry();
    faceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(built.faces, 3));
    faceGeometry.computeVertexNormals();
    var faces = new THREE.Mesh(faceGeometry, faceMat);
    faces.castShadow = true;
    faces.receiveShadow = true;
    group.add(faces);
    group.userData.faceObject = faces;
    group.userData.buildingRanges = built.ranges;
  }

  function makeShadowSun(THREE) {
    var sun = new THREE.DirectionalLight(0xffffff, 0);
    var mapSize = Math.min(4096, state.renderer.capabilities.maxTextureSize || 4096);
    sun.castShadow = true;
    sun.shadow.mapSize.set(mapSize, mapSize);
    sun.shadow.camera.near = .1;
    sun.shadow.camera.far = 65;
    sun.shadow.bias = -.000008;
    sun.shadow.normalBias = .001;
    sun.shadow.radius = 2;
    sun.shadow.autoUpdate = false;
    sun.shadow.needsUpdate = false;
    state.scene.add(sun);
    state.scene.add(sun.target);
    return sun;
  }

  function buildScene() {
    if (state.built) return true;
    var THREE = global.THREE;
    var data = global.NANSHAN_CITY_DATA;
    if (!THREE || !data || !state.host) return false;
    state.cityMeta = data.meta || {};

    var colors = {
      paper0: css('--color-paper-0', '#F7FAEF'),
      paper2: css('--color-paper-2', '#E3E9D3'),
      ink: css('--color-ink-3', '#48533A'),
      space: css('--color-space', '#3D5F6C'),
      spaceLight: css('--color-space-light', '#8B9FA7'),
      spaceDark: css('--color-space-dark', '#2B434C'),
      accent: css('--color-accent', '#4F6B2C'),
      rhythm: css('--color-rhythm-dark', '#6F5D2A')
    };

    var profiles = [
      { antialias: true, alpha: true, powerPreference: 'default' },
      { antialias: false, alpha: true, powerPreference: 'low-power' }
    ];
    state.rendererError = '';
    for (var profile = 0; profile < profiles.length; profile++) {
      try {
        state.renderer = new THREE.WebGLRenderer(profiles[profile]);
        state.rendererProfile = profiles[profile].powerPreference;
        break;
      } catch (error) { state.rendererError = String(error.message || error); }
    }
    if (!state.renderer) {
      state.host.innerHTML = '<div class="s-city__render-error"><p>三维显示暂时不可用</p><button type="button" data-city-action="retry-render">重新尝试</button></div>';
      return false;
    }
    state.rendererError = '';
    state.host.textContent = '';
    state.renderer.setPixelRatio(Math.min(1.75, global.devicePixelRatio || 1));
    state.renderer.setClearColor(0x000000, 0);
    state.renderer.outputEncoding = THREE.sRGBEncoding;
    state.renderer.shadowMap.enabled = false;
    state.renderer.shadowMap.autoUpdate = false;
    state.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    state.host.appendChild(state.renderer.domElement);
    state.contextRecovery = state.renderer.getContext().getExtension('WEBGL_lose_context');
    state.renderer.domElement.addEventListener('webglcontextlost', function (event) {
      event.preventDefault(); state.contextLost = true;
      cancelShadowTask();
      if (state.frame) global.cancelAnimationFrame(state.frame);
      state.frame = 0;
      if (!state.host.querySelector('.s-city__render-error')) {
        state.host.insertAdjacentHTML('beforeend', '<div class="s-city__render-error"><p>三维画面正在恢复</p><button type="button" data-city-action="retry-render">重新尝试</button></div>');
      }
    });
    state.renderer.domElement.addEventListener('webglcontextrestored', function () {
      state.contextLost = false;
      var notice = state.host.querySelector('.s-city__render-error');
      if (notice) notice.remove();
      state.shadowKey = state.preparedShadowKey = '';
      state.lastFrame = 0;
      resize();
      if (state.open && !state.frame) state.frame = global.requestAnimationFrame(animate);
    });

    state.scene = new THREE.Scene();
    state.camera = new THREE.PerspectiveCamera(34, 1, .1, 120);
    positionCamera();
    ['base', 'roads', 'buildings'].forEach(function (name) {
      state.layers[name] = new THREE.Group();
      state.layers[name].name = name;
      /* GIS northing maps to -Z in Three.js's right-handed Y-up space. */
      state.layers[name].scale.z = -1;
      state.scene.add(state.layers[name]);
    });

    buildBase(data, colors);
    buildRoads(data, colors);
    buildBuildings(data, colors);
    state.scene.add(new THREE.HemisphereLight(colors.paper0, colors.spaceDark, .54));
    state.sunLight = makeShadowSun(THREE);
    state.nextSunLight = makeShadowSun(THREE);
    state.built = true;
    if (global.CityCheckup) global.CityCheckup.init({
      state: state,
      sampleTerrain: function (x, z) { return sampleTerrain(data.terrain, x, z); },
      makeSurface: makeCitySurface,
      buildingGeometry: function (buildings) { return buildingGeometry(buildings, data.terrain); },
      resize: resize,
      restoreView: function () {
        state.targetDistance = GLOBAL_DISTANCE;
        state.targetElevation = GLOBAL_ELEVATION;
        state.targetOrbitX = GLOBAL_ORBIT_TARGET.x;
        state.targetOrbitY = GLOBAL_ORBIT_TARGET.y;
        state.targetOrbitZ = GLOBAL_ORBIT_TARGET.z;
        state.stage.setAttribute('data-view', 'global');
        updateCityTheme(true);
        updateProject(state.activeProject, false);
      }
    });
    if (global.ConvenienceStoreCube) global.ConvenienceStoreCube.init({
      state: state,
      restoreView: function () {
        if (global.ConvenienceStoreCube) global.ConvenienceStoreCube.exit(false);
        state.targetDistance = GLOBAL_DISTANCE;
        state.targetElevation = GLOBAL_ELEVATION;
        state.targetOrbitX = GLOBAL_ORBIT_TARGET.x;
        state.targetOrbitY = GLOBAL_ORBIT_TARGET.y;
        state.targetOrbitZ = GLOBAL_ORBIT_TARGET.z;
        state.stage.setAttribute('data-view', 'global');
        updateCityTheme(true);
        updateProject(state.activeProject, false);
      }
    });
    updateCityTheme(true);
    resize();
    return true;
  }

  function resize() {
    if (!state.built || !state.host || !state.camera) return;
    var rect = state.host.getBoundingClientRect();
    var width = Math.max(1, rect.width);
    var height = Math.max(1, rect.height);
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }

  function updateProject(index, fromWheel) {
    var count = PROJECTS.length;
    state.activeProject = (index + count) % count;
    var buttons = state.shell.querySelectorAll('[data-project]');
    buttons.forEach(function (button, itemIndex) {
      var delta = itemIndex - state.activeProject;
      if (delta > count / 2) delta -= count;
      if (delta < -count / 2) delta += count;
      var abs = Math.abs(delta);
      var y = 50 + delta * 15;
      var x = 8 + abs * 11;
      var scale = abs === 0 ? 1 : abs === 1 ? .86 : .73;
      var opacity = abs === 0 ? 1 : abs === 1 ? .68 : .38;
      button.style.setProperty('--project-y', y + '%');
      button.style.setProperty('--project-x', x + '%');
      button.style.setProperty('--project-scale', scale);
      button.style.setProperty('--project-opacity', opacity);
      button.setAttribute('aria-current', itemIndex === state.activeProject ? 'true' : 'false');
      button.tabIndex = itemIndex === state.activeProject ? 0 : -1;
    });
    var project = PROJECTS[state.activeProject];
    state.shell.querySelector('[data-project-type]').textContent = project.index + ' / ' + project.type;
    state.shell.querySelector('[data-project-summary]').textContent = project.summary;
    state.shell.querySelector('.s-projects__state').textContent = project.id === 'checkup' ?
      '城南古巷 · 点击卡片进入' :
      '五期观测 · 点击卡片进入';
    if (!fromWheel && global.innerWidth <= 980) {
      var activeButton = buttons[state.activeProject];
      if (activeButton && activeButton.scrollIntoView) activeButton.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
    state.lastInteraction = performance.now();
  }

  function handleShellClick(event) {
    var action = event.target.closest('[data-city-action]');
    if (action) {
      var type = action.getAttribute('data-city-action');
      if (type === 'close') close();
      if (type === 'retry-render' && state.contextLost && state.renderer) {
        if (state.contextRecovery) state.contextRecovery.restoreContext(); return;
      }
      if (type === 'retry-render' && !state.built && buildScene()) {
        resize();
        state.assemblyStart = performance.now();
        state.lastFrame = 0;
        if (!state.frame) state.frame = global.requestAnimationFrame(animate);
      }
      if (type === 'zoom-in') state.targetDistance = clamp(state.targetDistance - 4, MIN_DISTANCE, MAX_DISTANCE);
      if (type === 'zoom-out') state.targetDistance = clamp(state.targetDistance + 4, MIN_DISTANCE, MAX_DISTANCE);
      return;
    }
    var project = event.target.closest('[data-project]');
    if (project) {
      var index = Number(project.getAttribute('data-project'));
      var wasCentered = index === state.activeProject;
      updateProject(index, false);
      if (wasCentered && PROJECTS[index].id === 'checkup' && global.CityCheckup) global.CityCheckup.enter(PROJECTS[index].title);
      if (wasCentered && PROJECTS[index].id === 'convenience' && global.ConvenienceStoreCube) global.ConvenienceStoreCube.enter(PROJECTS[index].title);
    }
  }

  function toggleMapView(event) {
    if (event.target.closest('button, a, [data-city-action]')) return;
    if (global.CityCheckup && global.CityCheckup.isActive()) { global.CityCheckup.mapClick(event); return; }
    if (global.ConvenienceStoreCube && global.ConvenienceStoreCube.isActive()) { global.ConvenienceStoreCube.mapClick(event); return; }
    var rect = state.renderer.domElement.getBoundingClientRect();
    var pointer = new global.THREE.Vector2(
      (event.clientX - rect.left) / rect.width * 2 - 1,
      -(event.clientY - rect.top) / rect.height * 2 + 1
    );
    var raycaster = new global.THREE.Raycaster();
    state.scene.updateMatrixWorld(true);
    raycaster.setFromCamera(pointer, state.camera);
    var hit = state.terrainMesh && raycaster.intersectObject(state.terrainMesh, false)[0];
    if (!hit) return;
    var detail = state.targetDistance <= MIN_DISTANCE + .01;
    if (detail) {
      state.targetDistance = GLOBAL_DISTANCE;
      state.targetElevation = GLOBAL_ELEVATION;
      state.targetOrbitX = GLOBAL_ORBIT_TARGET.x;
      state.targetOrbitY = GLOBAL_ORBIT_TARGET.y;
      state.targetOrbitZ = GLOBAL_ORBIT_TARGET.z;
    } else {
      state.targetDistance = MIN_DISTANCE;
      state.targetElevation = DETAIL_ELEVATION;
      state.targetOrbitX = hit.point.x;
      state.targetOrbitY = hit.point.y + .08;
      state.targetOrbitZ = hit.point.z;
    }
    state.stage.setAttribute('data-view', detail ? 'global' : 'detail');
    state.lastInteraction = performance.now();
  }

  function projectWheel(event) {
    event.preventDefault();
    var now = performance.now();
    if (now < state.wheelLock) return;
    state.wheelLock = now + 150;
    updateProject(state.activeProject + (event.deltaY > 0 ? 1 : -1), true);
  }

  function keydown(event) {
    if (!state.open) return;
    if (global.CityCheckup && global.CityCheckup.isActive()) {
      if (event.key === 'Escape') { event.preventDefault(); global.CityCheckup.exit(); }
      if (event.key !== 'Tab') return;
    }
    if (global.ConvenienceStoreCube && global.ConvenienceStoreCube.isActive()) {
      if (event.key === 'Escape') { event.preventDefault(); global.ConvenienceStoreCube.exit(true); return; }
      if (event.key !== 'Tab') return;
    }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); updateProject(state.activeProject + 1, false); }
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); updateProject(state.activeProject - 1, false); }
    if (event.key === 'Tab') {
      var items = Array.prototype.slice.call(state.shell.querySelectorAll('button:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')).filter(function (item) {
        return item.tabIndex >= 0 && item.getClientRects().length && global.getComputedStyle(item).visibility !== 'hidden';
      });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      else if (!state.shell.contains(document.activeElement)) { event.preventDefault(); first.focus(); }
    }
  }

  function animate(now) {
    if (!state.open || !state.built || state.contextLost || state.renderer.getContext().isContextLost()) { state.frame = 0; return; }
    var dt = state.lastFrame ? Math.min(100, now - state.lastFrame) : 1000 / 60;
    state.lastFrame = now;
    var assembly = ease((now - state.assemblyStart) / 2600);
    updateCityTheme(false);
    updateSunLight();

    var motion = global.CameraMotion;
    var reduced = global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var checkupActive = global.CityCheckup && global.CityCheckup.isActive();
    var cubeActive = global.ConvenienceStoreCube && global.ConvenienceStoreCube.isActive();
    var spin = reduced || checkupActive || cubeActive ? 0 : motion ? motion.spin(dt) : dt * .000027;
    state.targetAzimuth += spin;
    state.azimuth += spin;
    state.azimuth = motion ? motion.angle(state.azimuth, state.targetAzimuth, dt) : state.azimuth + (state.targetAzimuth - state.azimuth) * VIEW_TRANSITION_RATE;
    var viewRate = reduced ? 1 : motion ? motion.rate(dt) : 1 - Math.pow(1 - VIEW_TRANSITION_RATE, dt * 60 / 1000);
    state.elevation += (state.targetElevation - state.elevation) * viewRate;
    state.distance += (state.targetDistance - state.distance) * viewRate;
    state.orbitX += (state.targetOrbitX - state.orbitX) * viewRate;
    state.orbitY += (state.targetOrbitY - state.orbitY) * viewRate;
    state.orbitZ += (state.targetOrbitZ - state.orbitZ) * viewRate;

    positionCamera();

    var roadProgress = ease((assembly - .12) / .32);
    var buildingProgress = ease((assembly - .28) / .44);
    var roadObjects = state.layers.roads.userData.drawObjects || [];
    var buildingObject = state.layers.buildings.userData.drawObject;
    roadObjects.forEach(function (roadObject) {
      roadObject.geometry.setDrawRange(0, Math.floor(roadObject.userData.fullCount * roadProgress / 3) * 3);
    });
    if (buildingObject) buildingObject.geometry.setDrawRange(0, Math.floor(buildingObject.userData.fullCount * buildingProgress));
    state.layers.buildings.scale.y = .02 + .98 * buildingProgress;

    if (global.CityCheckup) global.CityCheckup.tick(dt);
    if (global.ConvenienceStoreCube) global.ConvenienceStoreCube.tick(dt);

    state.renderer.render(state.scene, state.camera);
    state.frame = global.requestAnimationFrame(animate);
  }

  function pauseHome() {
    var engine = global.Scene && global.Scene._ && global.Scene._.MapEngine;
    if (engine && typeof engine.suspend === 'function') engine.suspend('space-city');
    else if (engine && typeof engine.stop === 'function') engine.stop();
    if (global.TerrainOrbit) global.TerrainOrbit.suspendGPU();
  }

  function resumeHome() {
    if (global.TerrainOrbit) global.TerrainOrbit.resumeGPU();
    var engine = global.Scene && global.Scene._ && global.Scene._.MapEngine;
    if (engine && typeof engine.resume === 'function') engine.resume('space-city');
    else if (engine && typeof engine.start === 'function') engine.start();
  }

  function open() {
    if (global.MomentsRoom && global.MomentsRoom.isOpen()) global.MomentsRoom.close();
    mountShell();
    if (state.open) return;
    state.restoreFocus = document.activeElement;
    pauseHome();
    var renderReady = buildScene();
    if (global.CityCheckup) global.CityCheckup.exit(false);
    if (global.ConvenienceStoreCube) global.ConvenienceStoreCube.exit(false);
    state.elevation = GLOBAL_ELEVATION;
    state.targetElevation = GLOBAL_ELEVATION;
    state.distance = GLOBAL_DISTANCE;
    state.targetDistance = GLOBAL_DISTANCE;
    state.orbitX = state.targetOrbitX = GLOBAL_ORBIT_TARGET.x;
    state.orbitY = state.targetOrbitY = GLOBAL_ORBIT_TARGET.y;
    state.orbitZ = state.targetOrbitZ = GLOBAL_ORBIT_TARGET.z;
    state.shadowKey = '';
    state.stage.setAttribute('data-view', 'global');
    if (state.camera) positionCamera();
    state.open = true;
    state.assemblyStart = performance.now();
    state.lastFrame = 0;
    state.lastInteraction = performance.now();
    updateProject(0, false);
    document.body.classList.add('s-city-open');
    state.shell.setAttribute('data-state', 'open');
    state.shell.setAttribute('aria-hidden', 'false');
    if (renderReady) {
      global.requestAnimationFrame(function () { resize(); });
      state.frame = global.requestAnimationFrame(animate);
    }
    var back = state.shell.querySelector('[data-city-action="close"]');
    if (back) back.focus();
  }

  function close() {
    if (!state.open) return;
    if (global.CityCheckup) global.CityCheckup.exit(false);
    if (global.ConvenienceStoreCube) global.ConvenienceStoreCube.exit(false);
    cancelShadowTask();
    state.open = false;
    if (state.frame) global.cancelAnimationFrame(state.frame);
    state.frame = 0;
    state.shell.setAttribute('data-state', 'closed');
    state.shell.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('s-city-open');
    releaseSceneGPU();
    resumeHome();
    if (state.restoreFocus && typeof state.restoreFocus.focus === 'function') state.restoreFocus.focus();
  }

  function releaseSceneGPU() {
    if (!state.built || !state.renderer) return;
    var resources = new Set();
    state.scene.traverse(function (object) {
      if (object.geometry) resources.add(object.geometry);
      var materials = object.material ? Array.isArray(object.material) ? object.material : [object.material] : [];
      materials.forEach(function (material) {
        resources.add(material);
        Object.keys(material).forEach(function (key) { if (material[key] && material[key].isTexture) resources.add(material[key]); });
      });
      if (object.shadow && object.shadow.map) { object.shadow.map.dispose(); object.shadow.map = null; }
    });
    resources.forEach(function (resource) { resource.dispose(); });
    state.renderer.renderLists.dispose();
    state.renderer.setRenderTarget(null);
    state.renderer.setSize(1, 1, false);
    state.shadowKey = state.preparedShadowKey = '';
  }

  function inspect(options) {
    if (!state.built || !state.renderer || state.contextLost || state.renderer.getContext().isContextLost()) return { webgl: false, contextLost: state.contextLost, nonZeroSamples: 0, rendererError: state.rendererError };
    // Diagnostics must not repopulate a hidden scene's released GPU buffers.
    if (state.open) state.renderer.render(state.scene, state.camera);
    var gl = state.renderer.getContext();
    var nonZero = 0;
    var width = gl.drawingBufferWidth;
    var height = gl.drawingBufferHeight;
    for (var row = 1; row <= 5; row++) {
      for (var col = 1; col <= 5; col++) {
        var pixel = new Uint8Array(4);
        gl.readPixels(Math.floor(width * col / 6), Math.floor(height * row / 6), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        if (pixel[0] || pixel[1] || pixel[2] || pixel[3]) nonZero++;
      }
    }
    var shadowTexture = null;
    if (options && options.shadowTexture && state.sunLight && state.sunLight.shadow && state.sunLight.shadow.map) {
      try {
        var shadowWidth = state.sunLight.shadow.map.width;
        var shadowHeight = state.sunLight.shadow.map.height;
        var shadowPixels = new Uint8Array(shadowWidth * shadowHeight * 4);
        state.renderer.readRenderTargetPixels(state.sunLight.shadow.map, 0, 0, shadowWidth, shadowHeight, shadowPixels);
        var shadowMin = 255, shadowMax = 0, shadowNonWhite = 0;
        var shadowStep = Math.max(4, Math.floor(shadowPixels.length / (65536 * 4)) * 4);
        for (var sp = 0; sp < shadowPixels.length; sp += shadowStep) {
          var packed = shadowPixels[sp] + shadowPixels[sp + 1] + shadowPixels[sp + 2] + shadowPixels[sp + 3];
          shadowMin = Math.min(shadowMin, shadowPixels[sp]);
          shadowMax = Math.max(shadowMax, shadowPixels[sp]);
          if (packed < 1016) shadowNonWhite++;
        }
        shadowTexture = { min: shadowMin, max: shadowMax, nonWhite: shadowNonWhite };
      } catch (ignore) { shadowTexture = { error: true }; }
    }
    return {
      webgl: true,
      rendererProfile: state.rendererProfile,
      nonZeroSamples: nonZero,
      width: width,
      height: height,
      cityTheme: state.theme,
      sceneChildren: state.scene.children.length,
      layerChildren: Object.keys(state.layers).map(function (name) { return [name, state.layers[name].children.length]; }),
      camera: state.camera.position.toArray(),
      orbitTarget: [state.orbitX, state.orbitY, state.orbitZ],
      targetOrbit: [state.targetOrbitX, state.targetOrbitY, state.targetOrbitZ],
      elevation: state.elevation,
      targetElevation: state.targetElevation,
      distance: state.distance,
      targetDistance: state.targetDistance,
      azimuth: state.azimuth,
      targetAzimuth: state.targetAzimuth,
      motionTauMs: global.CameraMotion ? global.CameraMotion.tauMs : null,
      rotationRadiansPerMs: global.CameraMotion ? global.CameraMotion.radiansPerMs : null,
      shadowKey: state.shadowKey,
      preparedShadowKey: state.preparedShadowKey,
      shadowsEnabled: state.shadowsEnabled,
      shadowMapEnabled: state.renderer.shadowMap.enabled,
      shadowTaskPending: !!state.shadowTask,
      lastShadowBakeMs: state.lastShadowBakeMs,
      shadowLights: [state.sunLight, state.nextSunLight].map(function (light) {
        return light ? {
          castShadow: light.castShadow,
          intensity: light.intensity,
          mapSize: light.shadow.map ? [light.shadow.map.width, light.shadow.map.height] : null,
          needsUpdate: !!light.shadow.needsUpdate
        } : null;
      }),
      shadowTexture: shadowTexture,
      frame: state.frame,
      glError: gl.getError()
    };
  }

  function snapshot() {
    if (!state.built || !state.renderer) return '';
    (state.layers.roads.userData.drawObjects || []).forEach(function (object) {
      object.geometry.setDrawRange(0, object.userData.fullCount);
    });
    if (state.layers.buildings.userData.drawObject) {
      state.layers.buildings.userData.drawObject.geometry.setDrawRange(0, state.layers.buildings.userData.drawObject.userData.fullCount);
    }
    state.layers.buildings.scale.y = 1;
    updateCityTheme(true);
    updateSunLight();
    state.distance = state.targetDistance;
    state.elevation = state.targetElevation;
    state.orbitX = state.targetOrbitX;
    state.orbitY = state.targetOrbitY;
    state.orbitZ = state.targetOrbitZ;
    positionCamera();
    state.renderer.render(state.scene, state.camera);
    return state.renderer.domElement.toDataURL('image/png');
  }

  global.SpaceCity = { open: open, close: close, isOpen: function () { return state.open; }, inspect: inspect, snapshot: snapshot };
})(typeof window !== 'undefined' ? window : this);
