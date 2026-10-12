(function (global) {
  'use strict';

  var CUBE_DISTANCE = 20;
  var CUBE_ELEVATION = 0.52;
  var CUBE_TARGET_Y = 2.72;
  var CUBE_WIDTH = 9.3;
  var CUBE_DEPTH = 4.5;
  var CUBE_HEIGHT = 5.6;
  var CELL = 0.1;

  var state = {
    ctx: null,
    group: null,
    meshes: [],
    materials: [],
    panel: null,
    overlay: null,
    active: false,
    cursor: 4,
    playing: true,
    originalTitle: '',
    lastPanelKey: '',
    lastTheme: '',
    maxCount: 1,
    labels: [],
    wires: [],
    selectedCell: null,
    pulse: null,
    elapsed: 0,
    ready: false
  };

  function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }
  function css(name, fallback) {
    var value = global.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }
  function color(value, fallback) {
    return new global.THREE.Color(value || fallback);
  }

  function timeY(year, data) {
    var years = data.meta.observedYears;
    var first = years[0];
    var last = years[years.length - 1];
    return ((year - first) / (last - first)) * CUBE_HEIGHT;
  }

  function rectangleLine(width, depth, y, material) {
    var THREE = global.THREE;
    var geometry = new THREE.BufferGeometry();
    var hw = width / 2, hd = depth / 2;
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -hw, y, -hd, hw, y, -hd,
      hw, y, -hd, hw, y, hd,
      hw, y, hd, -hw, y, hd,
      -hw, y, hd, -hw, y, -hd
    ], 3));
    return new THREE.LineSegments(geometry, material);
  }

  function line(points, material) {
    var geometry = new global.THREE.BufferGeometry();
    geometry.setAttribute('position', new global.THREE.Float32BufferAttribute(points, 3));
    return new global.THREE.LineSegments(geometry, material);
  }

  function makeCube(data) {
    var THREE = global.THREE;
    var group = new THREE.Group();
    group.name = 'convenience-store-time-cube';
    group.visible = false;

    var baseColor = color(css('--color-paper-2', '#dce5ce'));
    var lineColor = color(css('--color-space-dark', '#2b434c'));
    var activeColor = color(css('--color-accent', '#4f6b2c'));
    var quietColor = color(css('--color-space-light', '#8b9fa7'));
    var wireMaterial = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: .48 });
    var softMaterial = new THREE.LineBasicMaterial({ color: quietColor, transparent: true, opacity: .28 });

    var floor = new THREE.Mesh(
      new THREE.PlaneGeometry(CUBE_WIDTH, CUBE_DEPTH),
      new THREE.MeshBasicMaterial({ color: baseColor, transparent: true, opacity: .14, side: THREE.DoubleSide })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0;
    floor.receiveShadow = false;
    group.add(floor);

    var cube = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE_WIDTH, CUBE_HEIGHT, CUBE_DEPTH)),
      wireMaterial
    );
    cube.position.y = CUBE_HEIGHT / 2;
    group.add(cube);

    data.slices.forEach(function (slice) {
      var frame = rectangleLine(CUBE_WIDTH, CUBE_DEPTH, timeY(slice.year, data), softMaterial);
      group.add(frame);
      var outline = [];
      (data.boundary || []).forEach(function (ring) {
        for (var i = 1; i < ring.length; i++) {
          [ring[i - 1], ring[i]].forEach(function (p) {
            outline.push((p[0] - data.meta.grid.cols / 2) * CELL, timeY(slice.year, data), -(p[1] - data.meta.grid.rows / 2) * CELL);
          });
        }
      });
      group.add(line(outline, softMaterial));
    });
    state.wires = [wireMaterial, softMaterial];

    var axisX = CUBE_WIDTH / 2 + .34;
    var axisZ = -CUBE_DEPTH / 2;
    group.add(line([axisX, 0, axisZ, axisX, CUBE_HEIGHT, axisZ], wireMaterial));

    var maxCount = 1;
    data.slices.forEach(function (slice) {
      slice.cells.forEach(function (cell) { maxCount = Math.max(maxCount, cell[2]); });
    });
    state.maxCount = maxCount;

    data.slices.forEach(function (slice, sliceIndex) {
      var material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: false,
        transparent: true,
        opacity: .86,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      var geometry = new THREE.BoxGeometry(CELL * .78, .055, CELL * .78);
      var mesh = new THREE.InstancedMesh(geometry, material, slice.cells.length);
      var matrix = new THREE.Matrix4();
      slice.cells.forEach(function (cell, index) {
        var col = cell[0], row = cell[1], count = cell[2];
        var x = (col + .5 - data.meta.grid.cols / 2) * CELL;
        var z = -(row + .5 - data.meta.grid.rows / 2) * CELL;
        var y = timeY(slice.year, data);
        var strength = Math.sqrt(count / maxCount);
        // Time occupies the vertical axis. Counts only control colour.
        matrix.identity();
        matrix.setPosition(x, y, z);
        mesh.setMatrixAt(index, matrix);
        var instanceColor = quietColor.clone().lerp(activeColor, .18 + strength * .82);
        mesh.setColorAt(index, instanceColor);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.userData.sliceIndex = sliceIndex;
      mesh.userData.year = slice.year;
      mesh.userData.records = slice.records;
      mesh.userData.baseOpacity = .86;
      group.add(mesh);
      state.meshes.push(mesh);
      state.materials.push(material);
    });

    state.pulse = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(CELL, CUBE_HEIGHT, CELL)), wireMaterial);
    state.pulse.visible = false;
    group.add(state.pulse);
    state.group = group;
    return group;
  }

  function recolor(data) {
    if (!state.meshes.length) return;
    var activeColor = color(css('--color-accent', '#4f6b2c'));
    var quietColor = color(css('--color-space-light', '#8b9fa7'));
    state.wires[0].color.set(css('--color-ink-2', '#333d28'));
    state.wires[1].color.set(css('--color-ink-3', '#48533a'));
    state.meshes.forEach(function (mesh, sliceIndex) {
      var cells = data.slices[sliceIndex].cells;
      cells.forEach(function (cell, index) {
        var strength = Math.sqrt(cell[2] / state.maxCount);
        mesh.setColorAt(index, quietColor.clone().lerp(activeColor, .18 + strength * .82));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    state.lastTheme = document.documentElement.classList.contains('m-theme-night') ? 'night' : 'light';
  }

  function panelHTML(data) {
    return global.ConvenienceResearch.html(data, state.maxCount);
  }

  function updatePanel(data) {
    if (!state.panel) return;
    var index = Math.round(state.cursor);
    var slice = data.slices[index];
    var lower = Math.floor(state.cursor), upper = Math.ceil(state.cursor);
    var current = state.panel.querySelector('[data-store-current]');
    var records = state.panel.querySelector('[data-store-records]');
    var cells = state.panel.querySelector('[data-store-cells]');
    if (current) {
      current.textContent = lower === upper ? slice.year + ' · 观测期' : data.slices[lower].year + '–' + data.slices[upper].year + ' · 视觉过渡';
    }
    if (records) records.textContent = lower === upper ? Number(slice.records).toLocaleString('en-US') : '—';
    if (cells) cells.textContent = lower === upper ? Number(slice.occupiedCells).toLocaleString('en-US') : '—';
    state.panel.querySelectorAll('[data-store-year]').forEach(function (button, buttonIndex) {
      button.setAttribute('aria-pressed', lower === upper && buttonIndex === index ? 'true' : 'false');
    });
    var play = state.panel.querySelector('[data-store-play]');
    if (play) {
      play.textContent = state.playing ? '暂停时间演示' : '播放时间演示';
      play.setAttribute('aria-pressed', state.playing ? 'true' : 'false');
    }
    state.lastPanelKey = Math.floor(state.cursor) + ':' + Math.ceil(state.cursor) + ':' + (state.playing ? '1' : '0');
  }

  function updateMeshes() {
    state.meshes.forEach(function (mesh, index) {
      var distance = Math.abs(index - state.cursor);
      var weight = Math.max(0, 1 - Math.min(1, distance));
      mesh.material.opacity = .12 + .74 * weight;
      mesh.material.depthWrite = false;
      mesh.visible = true;
    });
  }

  function setCursor(index, data, userAction) {
    state.cursor = clamp(Number(index) || 0, 0, data.slices.length - 1);
    if (userAction) state.playing = false;
    updateMeshes();
    updatePanel(data);
    syncTimeline(data);
  }

  function cursorFromYear(year, data) {
    var years = data.meta.observedYears;
    for (var i = 1; i < years.length; i++) {
      if (year <= years[i]) return i - 1 + (year - years[i - 1]) / (years[i] - years[i - 1]);
    }
    return years.length - 1;
  }
  function syncTimeline(data) {
    var lo = Math.floor(state.cursor), hi = Math.ceil(state.cursor);
    var year = data.slices[lo].year + (data.slices[hi].year - data.slices[lo].year) * (state.cursor - lo);
    var slider = state.panel.querySelector('[data-store-timeline]');
    if (slider) slider.value = year;
    // The map caption belongs to the research chapter; years live in the panel.
  }

  function bindPanel(data) {
    if (!state.panel) return;
    state.panel.addEventListener('click', function (event) {
      var year = event.target.closest('[data-store-year]');
      if (year) { setCursor(Number(year.getAttribute('data-store-year')), data, true); return; }
      var play = event.target.closest('[data-store-play]');
      if (play) {
        state.playing = !state.playing;
        // Resume from the current real-time coordinate without a frame jump.
        var lo = Math.floor(state.cursor), hi = Math.ceil(state.cursor);
        var year = data.slices[lo].year + (data.slices[hi].year - data.slices[lo].year) * (state.cursor - lo);
        state.elapsed = Math.acos(1 - 2 * (year - 2012) / 11) / (Math.PI * 2) * 36000;
        updatePanel(data); return;
      }
      var back = event.target.closest('[data-store-back]');
      if (back && state.ctx && state.ctx.restoreView) state.ctx.restoreView();
    });
    state.panel.querySelector('[data-store-timeline]').addEventListener('input', function (event) {
      setCursor(cursorFromYear(Number(event.target.value), data), data, true);
    });
  }

  function init(ctx) {
    if (state.ready || !ctx || !ctx.state || !global.CONVENIENCE_STORE_DATA || !global.CONVENIENCE_RESEARCH_DATA || !global.ConvenienceResearch || !global.THREE) return;
    state.ctx = ctx;
    var data = global.CONVENIENCE_STORE_DATA;
    ctx.state.scene.add(makeCube(data));
    var projects = ctx.state.shell.querySelector('.s-projects');
    if (projects) {
      projects.insertAdjacentHTML('beforeend', panelHTML(data));
      state.panel = projects.querySelector('[data-store-panel]');
      bindPanel(data);
    }
    var stage = ctx.state.stage;
    if (stage) {
      var overlay = document.createElement('div');
      overlay.className = 's-store__overlay';
      overlay.hidden = true;
      overlay.innerHTML = '<span></span><strong data-store-overlay>便利店分布</strong><small></small>';
      stage.appendChild(overlay);
      state.overlay = overlay;
      data.slices.forEach(function (slice) {
        var label = document.createElement('span');
        label.className = 's-store__axis-label';
        label.textContent = slice.year;
        stage.appendChild(label);
        label.hidden = true;
        state.labels.push({ element: label, point: new global.THREE.Vector3(CUBE_WIDTH/2 + .34, timeY(slice.year, data), -CUBE_DEPTH/2) });
      });
    }
    state.ready = true;
    recolor(data);
    state.setCursor = function (index) { setCursor(index, global.CONVENIENCE_STORE_DATA, true); };
    if (global.ConvenienceResearch) global.ConvenienceResearch.init(ctx, state);
  }

  function enter(title) {
    if (!state.ready || !state.ctx || state.active) return;
    var city = state.ctx.state;
    state.originalTitle = city.shell.querySelector('#space-city-title').textContent;
    city.shell.querySelector('#space-city-title').textContent = title || global.CONVENIENCE_STORE_DATA.meta.shortTitle;
    state.active = true;
    state.playing = false;
    state.cursor = 4;
    state.elapsed = 0;
    state.lastPanelKey = '';
    city.shell.dataset.projectMode = 'store';
    city.stage.dataset.view = 'store';
    Object.keys(city.layers).forEach(function (name) { city.layers[name].visible = false; });
    city.terrainMesh.visible = false;
    state.group.visible = true;
    city.targetDistance = CUBE_DISTANCE;
    city.targetElevation = CUBE_ELEVATION;
    city.targetOrbitX = 0;
    city.targetOrbitY = CUBE_TARGET_Y;
    city.targetOrbitZ = 0;
    if (state.panel) state.panel.hidden = false;
    if (state.overlay) state.overlay.hidden = false;
    updateMeshes();
    updatePanel(global.CONVENIENCE_STORE_DATA);
    syncTimeline(global.CONVENIENCE_STORE_DATA);
    city.shell.querySelector('[data-city-readout]').textContent = 'SPACE-TIME CUBE / OBSERVED YEARS';
    if (global.ConvenienceResearch) global.ConvenienceResearch.enter();
  }

  function exit(restore) {
    if (!state.ctx) return;
    var city = state.ctx.state;
    var wasActive = state.active;
    if (wasActive && global.ConvenienceResearch) global.ConvenienceResearch.exit();
    state.active = false;
    state.playing = false;
    if (state.group) state.group.visible = false;
    if (state.panel) state.panel.hidden = true;
    if (state.overlay) state.overlay.hidden = true;
    state.labels.forEach(function (label) { label.element.hidden = true; });
    if (wasActive) {
      city.shell.querySelector('#space-city-title').textContent = state.originalTitle || '更“近”一步';
      city.shell.removeAttribute('data-project-mode');
      city.stage.dataset.view = 'global';
      Object.keys(city.layers).forEach(function (name) { city.layers[name].visible = true; });
      city.terrainMesh.visible = true;
      city.shell.querySelector('[data-city-readout]').textContent = 'AUTO ROTATION / TERRAIN ON';
      if (restore && state.ctx.restoreView) state.ctx.restoreView();
    }
  }

  function tick(dt) {
    if (!state.active || !state.ready) return;
    var data = global.CONVENIENCE_STORE_DATA;
    var theme = document.documentElement.classList.contains('m-theme-night') ? 'night' : 'light';
    if (theme !== state.lastTheme) recolor(data);
    if (state.playing && !(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      state.elapsed = (state.elapsed + dt) % 36000;
      // A periodic cosine traverses real year spacing, with zero speed at both
      // ends. It cannot jump from 2023 directly back to 2012 at the loop seam.
      var yearPosition = 2012 + 11 * (.5 - .5 * Math.cos(state.elapsed / 36000 * Math.PI * 2));
      state.cursor = cursorFromYear(yearPosition, data);
      updateMeshes();
      var panelKey = Math.floor(state.cursor) + ':' + Math.ceil(state.cursor) + ':1';
      if (panelKey !== state.lastPanelKey) updatePanel(data);
      syncTimeline(data);
    }
    var rect = state.ctx.state.host.getBoundingClientRect();
    state.labels.forEach(function (label) {
      var p = label.point.clone().project(state.ctx.state.camera);
      label.element.hidden = Math.abs(p.z) > 1;
      label.element.style.transform = 'translate(' + (p.x*.5+.5)*rect.width + 'px,' + (-p.y*.5+.5)*rect.height + 'px)';
    });
    if (global.ConvenienceResearch) global.ConvenienceResearch.tick(dt);
  }

  function mapClick(event) {
    if (!state.active) return;
    if (global.ConvenienceResearch && !global.ConvenienceResearch.isCube()) { global.ConvenienceResearch.mapClick(event); return; }
    var THREE = global.THREE, city = state.ctx.state;
    var rect = city.renderer.domElement.getBoundingClientRect();
    var pointer = new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1);
    var ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, city.camera);
    var hits = ray.intersectObjects(state.meshes, false);
    if (!hits.length) return;
    var hit = hits[0], data = global.CONVENIENCE_STORE_DATA;
    var cell = data.slices[hit.object.userData.sliceIndex].cells[hit.instanceId];
    selectCell(cell[0], cell[1]);
  }
  function selectCell(col, row) {
    var data = global.CONVENIENCE_STORE_DATA;
    state.selectedCell = [col, row];
    state.pulse.visible = true;
    state.pulse.position.set((col+.5-data.meta.grid.cols/2)*CELL, CUBE_HEIGHT/2, -(row+.5-data.meta.grid.rows/2)*CELL);
    var rows = data.slices.map(function (slice) {
      var cell = slice.cells.find(function (c) { return c[0] === col && c[1] === row; });
      var count = cell ? cell[2] : 0;
      return '<div><span>' + slice.year + '</span><i style="--store-bar:' + (count/state.maxCount*100) + '%"></i><b>' + count + '</b></div>';
    }).join('');
    state.panel.querySelector('[data-store-profile]').innerHTML = '<h3>选中网格 · 五期对照</h3>' + rows;
  }

  global.ConvenienceStoreCube = {
    init: init,
    enter: enter,
    exit: exit,
    tick: tick,
    isActive: function () { return state.active; },
    mapClick: mapClick,
    selectCell: selectCell,
    inspect: function () { return { ready: state.ready, active: state.active, cursor: state.cursor, playing: state.playing,
      years: global.CONVENIENCE_STORE_DATA.meta.observedYears, selectedCell: state.selectedCell,
      counts: state.meshes.map(function (m) { return m.count; }),
      opacities: state.meshes.map(function (m) { return m.material.opacity; }),
      geometries: state.meshes.length, theme: state.lastTheme }; }
  };
})(typeof window !== 'undefined' ? window : this);
