/* Chengnan project: offline data, shared city model, scroll-linked layers. */
(function (global) {
  'use strict';
  var ctx, data, panel, scroll, legend, info, labels;
  var active = false, ready = false, topic = '', chapter = '', lastTheme = '';
  var groups = {}, baseGroup, pointButtons = [], selectedPoint = null;
  var folderGroup, folderFace, folderLine, folderRanges;
  var folderColorCounts = {};
  var originalTitle = '', cityFaceIndex, cityEdgeIndex;
  var chapterTopics = { overview: 'overview', buildings: 'height', land: 'use', population: 'population', services: 'medical', mobility: 'parks' };
  var titles = { overview: '片区与社区', height: '建筑高度', use: '用地类型', density: '建筑密度', intensity: '开发强度', era: '地块开发年代', population: '人口与职住', medical: '医疗服务', commerce: '便民商业', sports: '体育设施', culture: '文化设施', toilets: '公厕分布', parks: '公园绿地', bus: '公交服务', metro: '轨道服务' };
  var bins = {
    height: ['低于10米', '10—20米', '20—40米', '40—80米', '80米及以上'],
    density: ['低于30%', '30%—50%', '50%—70%', '70%及以上'],
    intensity: ['低于2', '2—4', '4—6', '6及以上'],
    era: ['1990年前', '1990—1999', '2000—2009', '2010年及以后'],
    use: ['居住', '商办', '公共服务', '绿地', '其他']
  };
  function esc(text) { return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function number(value, decimals) { return Number(value).toLocaleString('zh-CN', { maximumFractionDigits: decimals == null ? 1 : decimals }); }
  function pct(value) { return number(value * 100, 2) + '%'; }
  function metric(value, label, unit) { return '<div class="c-checkup__metric"><strong>' + value + '<small>' + (unit || '') + '</small></strong><span>' + label + '</span></div>'; }
  function switches(keys, group) {
    return '<div class="c-checkup__switches" role="group" aria-label="' + group + '">' + keys.map(function (key) {
      return '<button type="button" data-checkup-topic="' + key + '" aria-pressed="false">' + titles[key] + '</button>';
    }).join('') + '</div>';
  }
  function section(key, index, title, content) { return '<section class="c-checkup__section" data-checkup-chapter="' + key + '" id="checkup-' + key + '"><span class="c-checkup__eyebrow">' + index + '</span><h3>' + title + '</h3>' + content + '</section>'; }
  function charts() {
    return data.population.map(function (chart) {
      var rows = chart.labels.map(function (label, i) {
        return '<div class="c-checkup__chart-row"><span>' + esc(label) + '</span><div>' + chart.series.map(function (series, s) {
          return '<div class="c-checkup__bar-line"><i class="series-' + s + '" style="--bar:' + (series.values[i] * 100) + '%"></i><b>' + pct(series.values[i]) + '</b></div>';
        }).join('') + '</div></div>';
      }).join('');
      return '<div class="c-checkup__chart"><h4>' + chart.title + '</h4><div class="c-checkup__chart-key">' + chart.series.map(function (s, i) { return '<span><i class="series-' + i + '"></i>' + s.name + '</span>'; }).join('') + '</div>' + rows + '</div>';
    }).join('');
  }
  function serviceContent(key) {
    var service = data.services[key];
    var content = '<h4>' + service.title + '</h4><div class="c-checkup__metrics">';
    if (key !== 'metro') {
      content += metric(number(service.points.length, 0), '片区及周边设施', '处');
      content += metric(number(service.insideCount, 0), '片区内设施', '处');
    }
    if (service.coverage != null) content += metric(pct(service.coverage), service.denominator + '覆盖率');
    content += '</div>';
    if (service.coverage != null) {
      content += '<p>' + (service.radius ? '以' + service.radius + '米为服务半径，' : '按公园规模采用300、500和1000米服务半径，') + '覆盖' + number(service.coverageArea / 10000, 2) + '公顷' + service.denominator + '。</p><p class="c-checkup__method">服务半径为直线距离。</p>';
    } else {
      content += '<div class="c-checkup__density-list">' + service.densities.map(function (item) { return '<p>' + item.label + '：' + number(item.count, 0) + '处 / ' + number(item.area / 1e6, 4) + '平方公里 <strong>' + number(item.value, 2) + '处/km²</strong></p>'; }).join('') + '</div>';
    }
    return '<div data-checkup-service="' + key + '" hidden>' + content + '</div>';
  }
  function panelHTML() {
    return '<div class="c-checkup" hidden><header class="c-checkup__head"><button type="button" data-checkup-back>项目目录</button><span>实习 / 深规院更新中心</span><h2>城市体检</h2><p>城南古巷城市更新重点片区</p></header>' +
      '<nav class="c-checkup__nav" aria-label="项目章节">' + [['overview', '概况'], ['buildings', '建筑'], ['land', '地块'], ['population', '人口'], ['services', '服务'], ['mobility', '出行']].map(function (item) { return '<button type="button" data-checkup-jump="' + item[0] + '">' + item[1] + '</button>'; }).join('') + '</nav>' +
      '<div class="c-checkup__scroll" tabindex="0" aria-label="城市体检内容">' +
      section('overview', '01 / 片区概况', '城南古巷', '<p>城南古巷是南山区的城市更新重点片区，涉及向南、北头、南园和南山四个社区。这次城市体检关注片区的建筑、用地、人口与公共服务。</p><div class="c-checkup__metrics">' + metric(number(data.meta.area / 10000, 2), '片区面积', '公顷') + metric(data.communities.length, '涉及社区', '个') + '</div><ul class="c-checkup__community-list">' + data.communities.map(function (c, i) { return '<li><span><i data-community-swatch="' + i + '"></i>' + esc(c.name) + '</span><b>' + number(c.area / 10000, 2) + '公顷</b></li>'; }).join('') + '</ul>') +
      section('buildings', '02 / 建筑', '街区的高度', '<div class="c-checkup__metrics">' + metric(data.buildings.count, '建筑', '栋') + metric(number(data.buildings.maxHeight, 1), '最高建筑', '米') + '</div><div class="c-checkup__distribution">' + data.buildings.bins.map(function (bin) { return '<p><span>' + bin.label + '</span><b>' + number(bin.count, 0) + '</b></p>'; }).join('') + '</div>') +
      section('land', '03 / 地块专题', '密度、用途与年代', switches(['use', 'density', 'intensity', 'era'], '地块专题') + '<div data-checkup-land-summary></div><details><summary>用地权属</summary><figure><a href="' + encodeURI(data.plates[0].url) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + encodeURI(data.plates[0].url) + '" alt="城南古巷片区用地权属图"></a></figure></details>') +
      section('population', '04 / 人口与职住', '谁在这里生活和工作', '<p>片区居民的年龄、教育和收入结构，以及常住人口与工作人口的通勤特征。</p>' + charts()) +
      section('services', '05 / 公共服务', '生活服务，覆盖到哪里', switches(['medical', 'commerce', 'sports', 'culture', 'toilets'], '公共服务专题') + ['medical', 'commerce', 'sports', 'culture', 'toilets'].map(serviceContent).join('')) +
      section('mobility', '06 / 绿地与交通', '绿地与出行的连接', switches(['parks', 'bus', 'metro'], '绿地与交通专题') + ['parks', 'bus', 'metro'].map(serviceContent).join('')) +
      '<footer class="c-checkup__footer"><button type="button" data-checkup-back>返回项目目录</button></footer></div></div>';
  }
  function classify(key, value) {
    // Explicit display assignment for the one unspecified-use plot; source stays null.
    if (value == null) return key === 'use' ? 0 : -1;
    if (key === 'density') return value < .3 ? 0 : value < .5 ? 1 : value < .7 ? 2 : 3;
    if (key === 'intensity') return value < 2 ? 0 : value < 4 ? 1 : value < 6 ? 2 : 3;
    if (key === 'era') return value < 1990 ? 0 : value < 2000 ? 1 : value < 2010 ? 2 : 3;
    if (key === 'height') return value < 10 ? 0 : value < 20 ? 1 : value < 40 ? 2 : value < 80 ? 3 : 4;
    if (key === 'use') return /居住/.test(value) ? 0 : /商业|办公/.test(value) ? 1 : /学校|医疗|文化|教育|公共|体育/.test(value) ? 2 : /绿地/.test(value) ? 3 : 4;
    return 0;
  }
  function newGroup(key) {
    var group = new global.THREE.Group();
    group.scale.z = -1;
    group.visible = false;
    group.userData = { alpha: 0, target: 0, key: key };
    ctx.state.scene.add(group);
    groups[key] = group;
    return group;
  }
  function material(kind, band, opacity, surface) {
    var T = global.THREE;
    var mat = surface ? ctx.makeSurface({ color: 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }) : new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false });
    mat.userData = { kind: kind, band: band || 0, opacity: opacity };
    return mat;
  }
  function surface(group, shape, kind, band, opacity, payload) {
    var T = global.THREE, positions = [];
    (shape.surface || []).forEach(function (polygon) {
      var contour = polygon[0].map(function (p) { return new T.Vector2(p[0], p[1]); });
      var holes = polygon.slice(1).map(function (ring) { return ring.map(function (p) { return new T.Vector2(p[0], p[1]); }); });
      var points = contour.slice(); holes.forEach(function (ring) { points = points.concat(ring); });
      T.ShapeUtils.triangulateShape(contour.slice(), holes.map(function (ring) { return ring.slice(); })).forEach(function (indices) {
        var a = points[indices[0]], b = points[indices[1]], c = points[indices[2]];
        if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) > 0) indices = [indices[0], indices[2], indices[1]];
        indices.forEach(function (index) { var p = points[index]; positions.push(p.x, ctx.sampleTerrain(p.x, p.y) + .00015, p.y); });
      });
    });
    if (!positions.length) return;
    var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3)); geo.computeVertexNormals();
    var mesh = new T.Mesh(geo, material(kind, band, opacity, true));
    mesh.receiveShadow = true;
    mesh.userData.payload = payload;
    mesh.renderOrder = kind === 'range' ? 1 : 2;
    group.add(mesh);
  }
  function outline(group, shape, kind, band, opacity, width) {
    var T = global.THREE, positions = [], strips = [];
    (shape.polygons || []).forEach(function (polygon) { polygon.forEach(function (ring) {
      ring.forEach(function (a, index) {
        var b = ring[(index + 1) % ring.length], steps = Math.max(1, Math.ceil(Math.hypot(a[0] - b[0], a[1] - b[1]) / .02));
        for (var step = 0; step < steps; step++) {
          [step / steps, (step + 1) / steps].forEach(function (t) {
            var x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
            positions.push(x, ctx.sampleTerrain(x, z) + .0008, z);
          });
          if (width) {
            var ax = a[0] + (b[0] - a[0]) * step / steps, az = a[1] + (b[1] - a[1]) * step / steps;
            var bx = a[0] + (b[0] - a[0]) * (step + 1) / steps, bz = a[1] + (b[1] - a[1]) * (step + 1) / steps;
            var length = Math.hypot(bx - ax, bz - az);
            if (length > 1e-9) {
              var nx = -(bz - az) / length * width / 2, nz = (bx - ax) / length * width / 2;
              var corners = [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]];
              [0, 1, 2, 0, 2, 3].forEach(function (index) { var p = corners[index]; strips.push(p[0], ctx.sampleTerrain(p[0], p[1]) + .001, p[1]); });
            }
          }
        }
      });
    }); });
    var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
    var line = new T.LineSegments(geo, material(kind, band, opacity, false));
    line.renderOrder = 3;
    group.add(line);
    if (strips.length) {
      var stripGeometry = new T.BufferGeometry(); stripGeometry.setAttribute('position', new T.Float32BufferAttribute(strips, 3));
      var stripMaterial = new T.MeshBasicMaterial({ color: 0xffffff, side: T.DoubleSide, transparent: true, opacity: 0, depthWrite: false });
      stripMaterial.userData = { kind: kind, band: band || 0, opacity: opacity };
      var strip = new T.Mesh(stripGeometry, stripMaterial); strip.renderOrder = 3; group.add(strip);
    }
  }
  function cacheGeometry() {
    baseGroup = newGroup('boundary');
    outline(baseGroup, data.boundary, 'boundary', 0, 1, .005);
    var overview = newGroup('overview');
    data.communities.forEach(function (community, i) { surface(overview, community, 'community', i, .85, { name: community.name, note: '面积 ' + number(community.area / 10000, 2) + '公顷' }); outline(overview, community, 'community', i, 1, .004); });
    ['use', 'density', 'intensity', 'era'].forEach(function (key) {
      var group = newGroup(key);
      data.plots.forEach(function (plot) {
        var band = classify(key, plot[key]);
        surface(group, plot, band < 0 ? 'missing' : key === 'use' ? 'landUse' : 'band', band, .72, { plot: plot });
        outline(group, plot, 'boundary', 0, .55);
      });
    });
    Object.keys(data.services).forEach(function (key) {
      var service = data.services[key], group = newGroup(key);
      if (service.serviceRange) {
        var buffers = newGroup(key + '-buffers');
        surface(buffers, service.serviceRange, 'range', 0, .20);
        (service.bufferBoundaries || [service.serviceRange]).forEach(function (shape) { outline(buffers, shape, 'buffer', 0, .8, .008); });
      }
      if (service.covered) surface(group, service.covered, 'covered', 0, .58);
      if (service.gap) { surface(group, service.gap, 'gap', 0, .72); outline(group, service.gap, 'gap', 0, .8); }
      if (service.land) surface(group, service.land, 'range', 0, .25);
      var T = global.THREE, positions = [];
      service.points.forEach(function (p) { positions.push(p.position[0], ctx.sampleTerrain(p.position[0], p.position[1]) + .007, p.position[1]); });
      var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      var mat = new T.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
      mat.userData = { kind: 'point', opacity: 1 };
      var points = new T.Points(geo, mat); points.renderOrder = 5; group.add(points);
    });
    // Attribute-only coloration of the existing merged building mesh.
    var geometry = ctx.state.layers.buildings.userData.faceObject.geometry;
    var colors = new Float32Array(geometry.getAttribute('position').count * 3); colors.fill(1);
    geometry.setAttribute('color', new global.THREE.BufferAttribute(colors, 3));
    var edges = ctx.state.layers.buildings.userData.drawObject.geometry;
    var edgeColors = new Float32Array(edges.getAttribute('position').count * 3); edgeColors.fill(1);
    edges.setAttribute('color', new global.THREE.BufferAttribute(edgeColors, 3));
    cacheFolderBuildings();
    ready = true;
    recolor();
  }
  function palette() {
    var night = document.documentElement.classList.contains('m-theme-night');
    var p = night ?
      { communities: ['#679580', '#8f9e5c', '#598993', '#ab8e68'], landUses: ['#91b476', '#bea273', '#80adb2', '#548f72', '#a49baa'], bands: ['#3f6150', '#598466', '#78a37c', '#a4c697', '#d0dfb8'], covered: '#7da987', gap: '#b6a17a', point: '#e5edc9', boundary: '#b7d3a4', range: '#83a187', missing: '#5c6460' } :
      { communities: ['#6b9f87', '#a5b16d', '#75a3ae', '#bb9a76'], landUses: ['#91ad72', '#b3986b', '#769ca2', '#4e7d60', '#8c8492'], bands: ['#c7d5b0', '#a1b58a', '#7b966a', '#55754f', '#304e3c'], covered: '#78986b', gap: '#ad906d', point: '#284b35', boundary: '#2c553e', range: '#96ad87', missing: '#a8ada3' };
    // Height is sequential, land use is categorical; keep their palettes separate.
    p.heights = night ? ['#304c40', '#4d7757', '#81a56a', '#b3ce8a', '#e5ecc0'] : ['#e1e7c0', '#b4ca8a', '#7da45f', '#49724d', '#234b3c'];
    p.buffer = night ? '#b3cb92' : '#58784b';
    return p;
  }
  function recolor() {
    if (!ready) return;
    var p = palette();
    Object.keys(groups).forEach(function (key) { groups[key].traverse(function (object) {
      if (!object.material) return;
      var meta = object.material.userData;
      object.material.color.set(meta.kind === 'community' ? p.communities[meta.band] : meta.kind === 'landUse' ? p.landUses[meta.band] : meta.kind === 'band' ? p.bands[Math.max(0, meta.band)] : p[meta.kind] || p.boundary);
    }); });
    lastTheme = document.documentElement.classList.contains('m-theme-night') ? 'night' : 'light';
    updateBuildingColors();
    panel.querySelectorAll('[data-community-swatch]').forEach(function (swatch) { swatch.style.background = p.communities[Number(swatch.dataset.communitySwatch)]; });
    updateLegend();
  }
  function cacheFolderBuildings() {
    var T = global.THREE, original = ctx.state.layers.buildings;
    var remove = new Set(data.buildings.removeIndices);
    var kept = original.userData.buildingRanges.filter(function (range) { return !remove.has(range.index); });
    function indexFor(startKey, countKey) {
      var indices = new Uint32Array(kept.reduce(function (total, range) { return total + range[countKey]; }, 0)), offset = 0;
      kept.forEach(function (range) { for (var i = 0; i < range[countKey]; i++) indices[offset++] = range[startKey] + i; });
      return new T.BufferAttribute(indices, 1);
    }
    cityFaceIndex = indexFor('start', 'count'); cityEdgeIndex = indexFor('edgeStart', 'edgeCount');
    var built = ctx.buildingGeometry(data.buildings.model);
    folderRanges = built.ranges;
    folderGroup = new T.Group(); folderGroup.scale.z = -1; folderGroup.visible = false; folderGroup.name = 'chengnan-buildings';
    function geometry(positions) {
      var geo = new T.BufferGeometry(); geo.setAttribute('position', new T.Float32BufferAttribute(positions, 3));
      var colors = new Float32Array(positions.length); colors.fill(1);
      geo.setAttribute('color', new T.BufferAttribute(colors, 3)); return geo;
    }
    var faceGeometry = geometry(built.faces); faceGeometry.computeVertexNormals();
    folderFace = new T.Mesh(faceGeometry, ctx.makeSurface({ color: 0xffffff, vertexColors: true, side: T.DoubleSide }));
    folderFace.castShadow = true; folderFace.receiveShadow = true;
    folderLine = new T.LineSegments(geometry(built.edges), new T.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: .8 }));
    folderGroup.add(folderFace, folderLine); ctx.state.scene.add(folderGroup);
  }
  function toggleFolderBuildings(enable) {
    var original = ctx.state.layers.buildings;
    original.userData.faceObject.geometry.setIndex(enable ? cityFaceIndex : null);
    original.userData.drawObject.geometry.setIndex(enable ? cityEdgeIndex : null);
    folderGroup.visible = enable;
    ctx.state.shadowKey = ''; ctx.state.preparedShadowKey = '';
  }
  function communityAt(point) {
    function inside(ring) {
      var result = false;
      for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        var a = ring[i], b = ring[j];
        if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
      }
      return result;
    }
    return data.communities.findIndex(function (community) { return community.polygons.some(function (polygon) { return inside(polygon[0]) && !polygon.slice(1).some(inside); }); });
  }
  function colorFolderBuildings() {
    if (!folderFace) return;
    var p = palette(), night = lastTheme === 'night', color = new global.THREE.Color(), edgeColor = new global.THREE.Color();
    var faces = folderFace.geometry.getAttribute('color'), edges = folderLine.geometry.getAttribute('color');
    folderColorCounts = {};
    folderRanges.forEach(function (range) {
      var building = data.buildings.model[range.index], community = -1;
      if (topic === 'overview') {
        var ring = building[1][0], point = ring.reduce(function (sum, p) { return [sum[0] + p[0], sum[1] + p[1]]; }, [0, 0]);
        community = communityAt([point[0] / ring.length, point[1] / ring.length]);
      }
      color.set(topic === 'height' ? p.heights[classify('height', building[0] * 1000)] : community >= 0 ? p.communities[community] : night ? '#40634e' : '#a1b58a');
      edgeColor.set(community >= 0 ? p.communities[community] : night ? '#91ae89' : '#54754e');
      if (topic === 'height') edgeColor.copy(color).multiplyScalar(night ? 1.2 : .65);
      if (topic === 'use') {
        var plotIndex = data.buildings.plotIndices[range.index];
        var band = plotIndex == null ? -1 : classify('use', data.plots[plotIndex].use);
        color.set(band < 0 ? p.missing : p.landUses[band]);
        // Outline keeps the class hue while separating adjacent roofs and walls.
        edgeColor.copy(color).multiplyScalar(night ? 1.18 : .65);
      }
      for (var i = range.start; i < range.start + range.count; i++) faces.setXYZ(i, color.r, color.g, color.b);
      for (var j = range.edgeStart; j < range.edgeStart + range.edgeCount; j++) edges.setXYZ(j, edgeColor.r, edgeColor.g, edgeColor.b);
      var colorKey = '#' + color.getHexString();
      folderColorCounts[colorKey] = (folderColorCounts[colorKey] || 0) + 1;
    });
    faces.needsUpdate = true; edges.needsUpdate = true;
  }
  function updateBuildingColors() {
    if (!ctx) return;
    var mat = ctx.state.materials.buildingFace, line = ctx.state.materials.buildingLine, enable = active;
    if (mat.vertexColors !== enable) { mat.vertexColors = enable; mat.needsUpdate = true; }
    if (line.vertexColors !== enable) { line.vertexColors = enable; line.needsUpdate = true; }
    if (!enable) {
      var night = document.documentElement.classList.contains('m-theme-night');
      mat.color.set(night ? getComputedStyle(ctx.state.shell).getPropertyValue('--terrain-surface-shade-dark').trim() || '#202A24' : getComputedStyle(ctx.state.shell).getPropertyValue('--terrain-surface').trim() || '#A8B893');
      line.color.set(night ? getComputedStyle(ctx.state.shell).getPropertyValue('--terrain-surface').trim() || '#485744' : '#718362');
      return;
    }
    mat.color.set('#ffffff');
    line.color.set('#ffffff');
    var geo = ctx.state.layers.buildings.userData.faceObject.geometry, attribute = geo.getAttribute('color');
    var edgeAttribute = ctx.state.layers.buildings.userData.drawObject.geometry.getAttribute('color');
    var p = palette(), selected = new Set(data.buildings.indices);
    var color = new global.THREE.Color(), edgeColor = new global.THREE.Color();
    ctx.state.layers.buildings.userData.buildingRanges.forEach(function (range) {
      var inside = selected.has(range.index), night = lastTheme === 'night';
      color.set(inside ? (topic === 'height' ? p.heights[classify('height', global.NANSHAN_CITY_DATA.buildings[range.index][0] * 1000)] : night ? '#40634e' : '#a1b58a') : night ? '#26352d' : '#d4dccc');
      edgeColor.set(inside ? night ? '#91ae89' : '#54754e' : night ? '#334b3d' : '#c9d3be');
      for (var i = range.start; i < range.start + range.count; i++) attribute.setXYZ(i, color.r, color.g, color.b);
      for (var j = range.edgeStart; j < range.edgeStart + range.edgeCount; j++) edgeAttribute.setXYZ(j, edgeColor.r, edgeColor.g, edgeColor.b);
    });
    attribute.needsUpdate = true;
    edgeAttribute.needsUpdate = true;
    colorFolderBuildings();
  }
  function updateLegend() {
    if (!legend || !active) return;
    var p = palette(), items = [];
    if (bins[topic]) items = bins[topic].map(function (label, i) { return [label, (topic === 'use' ? p.landUses : topic === 'height' ? p.heights : p.bands)[i]]; });
    else if (topic === 'overview') items = data.communities.map(function (c, i) { return [c.name, p.communities[i]]; });
    else if (data.services[topic]) items = data.services[topic].coverage != null ? [['服务范围', p.buffer], ['覆盖', p.covered], ['未覆盖', p.gap], ['设施点位', p.point]] : [['土地范围', p.range], ['公厕点位', p.point]];
    if (['density', 'intensity', 'era'].indexOf(topic) >= 0 && data.plots.some(function (plot) { return plot[topic] == null; })) items.push(['无数据', p.missing]);
    if (topic === 'use' && data.buildings.plotIndices.some(function (index) { return index == null; })) items.push(['未关联用地', p.missing]);
    legend.innerHTML = '<b>城南古巷 / ' + titles[topic] + '</b><div>' + items.map(function (item) { return '<span><i style="background:' + item[1] + '"></i>' + esc(item[0]) + '</span>'; }).join('') + '</div>';
  }
  function landSummary(key) {
    var counts = {}, missing = 0;
    data.plots.forEach(function (plot) { var band = classify(key, plot[key]); if (band < 0) missing++; else counts[band] = (counts[band] || 0) + 1; });
    return '<div class="c-checkup__metrics">' + metric(data.plots.length, '地块', '个') + '</div><div class="c-checkup__distribution">' + bins[key].map(function (label, i) { return '<p><span>' + label + '</span><b>' + (counts[i] || 0) + '</b></p>'; }).join('') + (missing ? '<p><span>未记录</span><b>' + missing + '</b></p>' : '') + '</div><p class="c-checkup__method">' + (key === 'use' ? '用地类型参考规划分类；混合用途按居住优先归类。' : key === 'era' ? '按地块开发年代分组。' : key === 'density' ? '建筑密度表示建筑占地面积与地块面积的比例。' : '容积率表示总建筑面积与地块面积的比例。') + '</p>';
  }
  function setTopic(key, moveCamera) {
    if (!active || !titles[key]) return;
    var changed = key !== topic;
    topic = key;
    Object.keys(groups).forEach(function (name) { groups[name].userData.target = name === 'boundary' || name === key || name === key + '-buffers' ? 1 : 0; });
    panel.querySelectorAll('[data-checkup-topic]').forEach(function (button) { button.setAttribute('aria-pressed', button.dataset.checkupTopic === key ? 'true' : 'false'); });
    panel.querySelectorAll('[data-checkup-service]').forEach(function (block) { block.hidden = block.dataset.checkupService !== key; });
    // Preserve the last active panel in the other chapter when switching chapters.
    var serviceKey = chapterTopics.services, mobilityKey = chapterTopics.mobility;
    [serviceKey, mobilityKey].forEach(function (item) { var block = panel.querySelector('[data-checkup-service="' + item + '"]'); if (block) block.hidden = false; });
    if (bins[key] && key !== 'height') panel.querySelector('[data-checkup-land-summary]').innerHTML = landSummary(key);
    if (changed) { selectedPoint = null; info.hidden = true; rebuildLabels(); updateBuildingColors(); }
    if (moveCamera) {
      var s = ctx.state, center = data.meta.center;
      s.targetOrbitX = center[0]; s.targetOrbitZ = -center[1]; s.targetOrbitY = ctx.sampleTerrain(center[0], center[1]) + .045;
      // Fixed reading views; heading, center, tilt and distance share one easing.
      var desiredAzimuth = key === 'height' ? -.45 : -.12;
      s.targetAzimuth = s.azimuth + Math.atan2(Math.sin(desiredAzimuth - s.azimuth), Math.cos(desiredAzimuth - s.azimuth));
      s.targetElevation = key === 'height' ? .62 : data.services[key] ? 1.12 : .99;
      s.targetDistance = key === 'height' ? 4 : data.services[key] ? 6.6 : 4.3;
      if (global.matchMedia('(prefers-reduced-motion: reduce)').matches) { s.orbitX = s.targetOrbitX; s.orbitY = s.targetOrbitY; s.orbitZ = s.targetOrbitZ; s.distance = s.targetDistance; s.elevation = s.targetElevation; s.azimuth = s.targetAzimuth; }
    }
    updateLegend();
    ctx.state.shell.querySelector('[data-city-readout]').textContent = '城南古巷 / ' + titles[key];
  }
  function activateChapter(key) {
    if (key === chapter) return;
    chapter = key;
    panel.querySelectorAll('[data-checkup-jump]').forEach(function (button) { button.setAttribute('aria-current', button.dataset.checkupJump === key ? 'true' : 'false'); });
    setTopic(chapterTopics[key], true);
  }
  function onScroll() {
    if (!active) return;
    var anchor = scroll.getBoundingClientRect().top + Math.min(100, scroll.clientHeight * .25), next = 'overview';
    panel.querySelectorAll('[data-checkup-chapter]').forEach(function (section) { if (section.getBoundingClientRect().top <= anchor) next = section.dataset.checkupChapter; });
    activateChapter(next);
  }
  function rebuildLabels() {
    labels.replaceChildren(); pointButtons = [];
    var service = data.services[topic];
    if (!service) return;
    service.points.forEach(function (point, i) {
      var button = document.createElement('button'); button.type = 'button';
      if (point.named) button.textContent = point.name;
      else { button.className = 'c-checkup__pulse'; button.style.setProperty('--pulse-delay', (-i * .27) + 's'); }
      button.dataset.checkupPoint = topic + ':' + i; button.setAttribute('aria-label', (point.name || (topic === 'metro' ? '地铁站点' : service.title)) + '，' + (point.inside ? '片区内' : '片区周边'));
      labels.appendChild(button); pointButtons.push({ element: button, point: point, index: i });
    });
  }
  function showPoint(key, index) {
    if (!data.services[key] || !data.services[key].points[index]) return;
    var parentChapter = ['parks', 'bus', 'metro'].indexOf(key) >= 0 ? 'mobility' : 'services';
    chapterTopics[parentChapter] = key;
    setTopic(key, false);
    var point = data.services[key].points[index]; selectedPoint = index;
    if (!point.named) { info.hidden = true; return; }
    info.innerHTML = '<strong>' + esc(point.name) + '</strong><p>' + (point.inside ? '片区内' : '片区周边') + (point.level ? ' · ' + esc(point.level) : '') + (point.areaHa != null ? ' · ' + number(point.areaHa, 2) + '公顷' : '') + '</p>';
    info.hidden = false;
  }
  function init(context) {
    ctx = context; data = global.CHENGNAN_CHECKUP_DATA;
    if (!data) return;
    ctx.state.shell.querySelector('.s-projects').insertAdjacentHTML('beforeend', panelHTML());
    panel = ctx.state.shell.querySelector('.c-checkup'); scroll = panel.querySelector('.c-checkup__scroll');
    legend = document.createElement('div'); legend.className = 'c-checkup__legend'; legend.hidden = true;
    info = document.createElement('div'); info.className = 'c-checkup__info'; info.hidden = true; info.setAttribute('aria-live', 'polite');
    labels = document.createElement('div'); labels.className = 'c-checkup__labels'; labels.hidden = true;
    ctx.state.stage.append(legend, info, labels);
    scroll.addEventListener('scroll', onScroll, { passive: true });
    scroll.addEventListener('wheel', function (event) { event.stopPropagation(); }, { passive: true });
    ctx.state.shell.addEventListener('click', function (event) {
      var back = event.target.closest('[data-checkup-back]'); if (back) { exit(); return; }
      var jump = event.target.closest('[data-checkup-jump]');
      if (jump) { var key = jump.dataset.checkupJump; var section = panel.querySelector('#checkup-' + key); scroll.scrollTo({ top: section.offsetTop, behavior: global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); return; }
      var toggle = event.target.closest('[data-checkup-topic]');
      if (toggle) { var key = toggle.dataset.checkupTopic; var parent = toggle.closest('[data-checkup-chapter]').dataset.checkupChapter; chapterTopics[parent] = key; setTopic(key, false); return; }
      var point = event.target.closest('[data-checkup-point]'); if (point) { var parts = point.dataset.checkupPoint.split(':'); showPoint(parts[0], Number(parts[1])); }
    });
    panel.querySelector('[data-checkup-land-summary]').innerHTML = landSummary('use');
    ['medical', 'parks'].forEach(function (key) { panel.querySelector('[data-checkup-service="' + key + '"]').hidden = false; });
    // All geometry is prepared once, before the reader enters the project.
    cacheGeometry();
  }
  function enter(title) {
    if (!ctx || !panel || !ready) return;
    active = true; topic = ''; chapter = '';
    originalTitle = ctx.state.shell.querySelector('#space-city-title').textContent;
    ctx.state.shell.querySelector('#space-city-title').textContent = title || '城市体检';
    toggleFolderBuildings(true);
    ctx.state.shell.dataset.projectMode = 'checkup'; ctx.state.stage.dataset.view = 'checkup';
    panel.hidden = false; legend.hidden = false; labels.hidden = false;
    ctx.resize();
    scroll.scrollTop = 0; activateChapter('overview');
    panel.querySelector('[data-checkup-back]').focus({ preventScroll: true });
  }
  function exit(restore) {
    if (!ctx || !panel) return;
    var wasActive = active; active = false; topic = ''; chapter = '';
    if (wasActive) {
      ctx.state.shell.querySelector('#space-city-title').textContent = originalTitle || '更“近”一步';
      toggleFolderBuildings(false);
    }
    ctx.state.shell.removeAttribute('data-project-mode');
    panel.hidden = true; legend.hidden = true; info.hidden = true; labels.hidden = true;
    ctx.resize();
    Object.keys(groups).forEach(function (key) {
      groups[key].userData.target = 0;
      if (restore === false) { groups[key].userData.alpha = 0; groups[key].visible = false; }
    });
    updateBuildingColors();
    ctx.state.shell.querySelector('[data-city-readout]').textContent = 'AUTO ROTATION / TERRAIN ON';
    if (wasActive && restore !== false) { ctx.restoreView(); ctx.state.shell.querySelector('[data-project="4"]').focus({ preventScroll: true }); }
  }
  function tick(dt) {
    if (!ready) return;
    var theme = document.documentElement.classList.contains('m-theme-night') ? 'night' : 'light';
    if (theme !== lastTheme) recolor();
    var speed = global.matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 1 - Math.exp(-dt / 260);
    Object.keys(groups).forEach(function (key) {
      var group = groups[key], s = group.userData;
      s.alpha += (s.target - s.alpha) * speed;
      if (s.alpha < .002 && !s.target) { group.visible = false; return; }
      group.visible = true;
      group.traverse(function (object) { if (object.material) object.material.opacity = s.alpha * object.material.userData.opacity; });
    });
    if (active) { ctx.state.materials.buildingFace.color.set('#ffffff'); ctx.state.materials.buildingLine.color.set('#ffffff'); }
    if (!active || !pointButtons.length) return;
    var rect = ctx.state.host.getBoundingClientRect(), occupied = [];
    pointButtons.forEach(function (item) {
      var point = item.point.position, vector = new global.THREE.Vector3(point[0], ctx.sampleTerrain(point[0], point[1]) + .008, -point[1]).project(ctx.state.camera);
      var x = (vector.x + 1) * rect.width / 2, y = (1 - vector.y) * rect.height / 2;
      var dot = !item.point.named;
      var outside = vector.z < -1 || vector.z > 1 || x < 10 || x > rect.width - (dot ? 10 : 130) || y < 10 || y > rect.height - 70;
      var overlap = occupied.some(function (p) { return Math.abs(p[0] - x) < 115 && Math.abs(p[1] - y) < 25; });
      var show = !outside && (dot || !overlap || item.index === selectedPoint);
      item.element.hidden = !show;
      item.element.style.transform = 'translate(' + Math.round(x + (dot ? -7 : 8)) + 'px,' + Math.round(y - (dot ? 7 : 10)) + 'px)';
      item.element.classList.toggle('is-selected', item.index === selectedPoint);
      if (show && !dot) occupied.push([x, y]);
    });
  }
  function mapClick(event) {
    if (!active) return;
    var rect = ctx.state.renderer.domElement.getBoundingClientRect();
    var ray = new global.THREE.Raycaster();
    ray.setFromCamera(new global.THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), ctx.state.camera);
    var group = groups[topic];
    if (!group) return;
    var hit = ray.intersectObjects(group.children, false).find(function (h) { return h.object.userData.payload; });
    if (!hit) { info.hidden = true; selectedPoint = null; return; }
    var payload = hit.object.userData.payload;
    if (payload.plot) {
      var p = payload.plot;
      info.innerHTML = '<strong>' + esc(p.name) + '</strong><p>' + esc(p.use == null ? '居住用地' : p.use) + '<br>密度 ' + (p.density == null ? '未记录' : pct(p.density)) + ' · 容积率 ' + (p.intensity == null ? '未记录' : number(p.intensity, 2)) + '<br>开发年代 ' + (p.era == null ? '未记录' : number(p.era, 0)) + ' · ' + number(p.area / 10000, 2) + '公顷</p>';
    } else info.innerHTML = '<strong>' + esc(payload.name) + '</strong><p>' + esc(payload.note) + '</p>';
    info.hidden = false;
  }
  global.CityCheckup = { init: init, enter: enter, exit: exit, tick: tick, mapClick: mapClick, isActive: function () { return active; }, inspect: function () { return { active: active, ready: ready, chapter: chapter, topic: topic, folderBuildingCount: data ? data.buildings.count : 0, folderBuildingColors: folderColorCounts, folderBuildingsVisible: !!(folderGroup && folderGroup.visible), cityBuildingsMasked: !!(ctx && ctx.state.layers.buildings.userData.faceObject.geometry.index), cacheGroups: Object.keys(groups).length, visibleGroups: Object.keys(groups).filter(function (key) { return groups[key].visible; }) }; } };
})(window);
