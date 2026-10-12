(function (global) {
  'use strict';
  var chapters = [
    ['intro', '研究问题', 'counts'],
    ['methods', '数据与方法', 'counts'],
    ['evolution', '总体演化', 'kde'],
    ['service', '服务覆盖', 'service'],
    ['center', '重心与方向', 'center'],
    ['hierarchy', '网络层级', 'kde'],
    ['growth', '加密与扩张', 'growth'],
    ['cube', '时空立方体', 'cube'],
    ['hotspot', '局部热点动态', 'hotspot'],
    ['model', '模型构建与对比', 'gdp'],
    ['gdp', '经济要素', 'gdp'],
    ['road', '交通要素', 'road'],
    ['urban', '建成环境', 'urban'],
    ['stability', '时序稳定性', 'gdp'],
    ['residual', '残差与诊断', 'residual'],
    ['conclusion', '结论与展望', 'kde']
  ];
  var state = { ctx: null, cube: null, group: null, cache: {}, chapter: 'intro', mode: 'counts',
    theme: '', key: '', current: null, active: false, frame: 0, aspect: 0,
    hotspotSelection: null, hotspotMarker: null, hotspotInfo: null, hotspotIndex: null };
  var CELL = .1;
  function data() { return global.CONVENIENCE_RESEARCH_DATA; }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function percent(n) { return (n * 100).toFixed(1) + '%'; }
  function num(n, places) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: places || 0 }); }
  function xy(p, y) { return [(p[0]-46.5)*CELL, y || 0, -(p[1]-22.5)*CELL]; }

  function bars(values, formatter) {
    var max = Math.max.apply(null, values.map(Math.abs)) || 1;
    return '<div class="s-research__bars">' + values.map(function (v, i) {
      return '<div><span>' + global.CONVENIENCE_STORE_DATA.meta.observedYears[i] + '</span><i style="width:' + Math.abs(v)/max*100 + '%"></i><b>' + formatter(v) + '</b></div>';
    }).join('') + '</div>';
  }
  function trendScale(annual, variable) {
    var means=annual.map(function(s){return s.mean[variable];});
    var low=Math.min.apply(null,means), high=Math.max.apply(null,means);
    var padding=Math.max((high-low)*.25,Math.max(Math.abs(low),Math.abs(high),1)*.002);
    return {min:low-padding,max:high+padding,means:means};
  }
  function trend(variable) {
    var a=data().model.annual, scale=trendScale(a,variable), span=scale.max-scale.min;
    var precision=Math.min(5,Math.max(2,Math.ceil(-Math.log(span)/Math.LN10)+2));
    var format=function(v){return Number(v).toFixed(precision);};
    var yearX=function(year){return 48+(year-a[0].year)/(a[a.length-1].year-a[0].year)*248;};
    var valueY=function(v){return 142-(v-scale.min)/span*108;};
    var coords=a.map(function(s){return [yearX(s.year),valueY(s.mean[variable])];});
    var delta=scale.means[scale.means.length-1]-scale.means[0];
    var signed=function(v){return (v>0?'+':'')+format(v);};
    var relative=Math.abs(scale.means[0])>1e-6?'（'+(delta>0?'+':'')+(delta/Math.abs(scale.means[0])*100).toFixed(1)+'%）':'';
    var ticks=[scale.min,(scale.min+scale.max)/2,scale.max];
    var distribution=a.reduce(function(v,s){return v.concat([s.q25[variable],s.q75[variable],s.mean[variable]]);},[]);
    var low=Math.min.apply(null,distribution), high=Math.max.apply(null,distribution), width=high-low||1;
    var position=function(v){return (v-low)/width*100;};
    return '<div class="s-research__trend-card" data-trend-variable="'+variable+'">' +
      '<div class="s-research__trend-heading"><b>年度均值变化</b><span>2012 → 2023 <strong>'+signed(delta)+'</strong> '+relative+'</span></div>' +
      '<svg class="s-research__trend" viewBox="0 0 328 178" role="img" aria-label="年度系数均值，纵轴聚焦均值范围，使用实际系数刻度">' +
      ticks.map(function(v){var y=valueY(v);return '<line class="s-research__trend-grid" x1="48" x2="307" y1="'+y+'" y2="'+y+'"/><text x="41" y="'+(y+3)+'" text-anchor="end">'+format(v)+'</text>';}).join('') +
      '<polyline points="'+coords.map(function(p){return p.join(',');}).join(' ')+'" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
      a.map(function(s,i){var p=coords[i];return '<circle cx="'+p[0]+'" cy="'+p[1]+'" r="4" fill="currentColor"/><text class="s-research__trend-value" x="'+p[0]+'" y="'+(p[1]-12)+'" text-anchor="middle">'+format(s.mean[variable])+'</text><text x="'+p[0]+'" y="166" text-anchor="middle">'+s.year+'</text>';}).join('') +
      '</svg><p class="s-store__note">纵轴聚焦年度均值范围；各因素使用独立刻度。</p>' +
      '<details class="s-research__distribution"><summary>查看各年系数分布</summary><p class="s-store__note">横条：样本中间50%的范围 · 圆点：均值</p>' +
      '<div class="s-research__distribution-axis"><span>'+num(low,2)+'</span><span>'+num(high,2)+'</span></div>' +
      a.map(function(s){return '<div class="s-research__distribution-row"><span>'+s.year+'</span><div class="s-research__distribution-track"><i style="left:'+position(s.q25[variable])+'%;width:'+(position(s.q75[variable])-position(s.q25[variable]))+'%"></i><b style="left:'+position(s.mean[variable])+'%"></b></div><small>'+num(s.q25[variable],2)+'—'+num(s.q75[variable],2)+'</small></div>';}).join('') +
      '</details></div>';
  }
  function section(id, title, content) {
    var index = chapters.findIndex(function(c) { return c[0] === id; });
    return '<section class="s-research__section" id="store-'+id+'" data-research-section="'+id+'"><span class="s-research__number">'+String(index+1).padStart(2,'0')+'</span><h3>'+title+'</h3>'+content+'</section>';
  }
  function html(d, maxCount) {
    var r = data(), m = r.model, years = d.meta.observedYears;
    var navigation = chapters.map(function(c){return '<option value="'+c[0]+'">'+c[1]+'</option>';}).join('');
    var yearButtons = years.map(function(y,i){return '<button type="button" class="s-store__year" data-store-year="'+i+'" aria-pressed="false">'+y+'</button>';}).join('');
    var content = section('intro', '一张便利店地图，能读出怎样的城市？',
      '<p>便利店连接着社区、通勤与日常消费。这个课程项目把深圳2012—2023年的便利店分布放到同一个时空框架中，观察零售网络如何随城市生长。</p>' +
      '<ol><li>网点从哪里向哪里扩散？</li><li>哪些区域持续集聚，哪些地方出现新的热点？</li><li>经济、道路和建成环境的关联，是否因地点和年份而异？</li></ol>' +
      '<p class="s-store__note">向下浏览，左侧地图会随章节切换。上方年份可用于跨期对照。</p>');
    content += section('methods','从多源数据到时空分析',
      '<p>研究整理了五期高德POI，以及人口、GDP、路网、土地利用与行政边界数据。点位经清洗和坐标统一后，结合核密度、标准差椭圆、服务区分析与GTWR展开研究。</p>' +
      '<div class="s-research__method"><span>空间分布</span><b>核密度 · 重心 · 标准差椭圆</b><span>时间演进</span><b>时空立方体 · 新兴热点</b><span>驱动因素</span><b>GDP · 道路线密度 · 城市化密度</b></div>' +
      '<p>从中心地理论看服务层级，从空间扩散看网络生长，从空间异质性看同一因素在不同地方的关联。研究将这几条线索放进同一套空间分析中。</p>' +
      '<p class="s-store__note">回归采用100 m网格；网页密度图聚合为1 km均值。人口数据用于研究背景与整理，未纳入当前回归。</p>');
    content += section('evolution','总体演化特征',
      '<p>五期记录从'+num(d.slices[0].records)+'条增加到'+num(d.slices[4].records)+'条。左侧切换为原研究的核密度结果，观察密集区域的位置与强度变化。</p>'+bars(d.slices.map(function(s){return s.records;}),num) +
      '<p>原始100 m网格中的非零核密度比例，由'+percent(m.kdeAnnual[0].positiveCells/m.kdeAnnual[0].validCells)+'上升至'+percent(m.kdeAnnual[4].positiveCells/m.kdeAnnual[4].validCells)+'。这个比例描述密度分布范围，与步行服务覆盖不同。</p>');
    content += section('service','走到便利店，需要多远？',
      '<p>沿道路网络生成的500 m服务区，把网点数量转化为步行可达范围。图中保留服务区的实际边界与内部空隙，观察覆盖的延伸与断点。</p>' +
      bars(r.shapes.map(function(s){return s.serviceCoverage;}),percent) +
      '<p class="s-store__note">比例为服务区与深圳边界相交后的面积占比，使用同一投影计算；不代表人口覆盖率。</p>');
    content += section('center','空间重心与方向性演变',
      '<p>把每年的分布概括为一个重心和一条标准差椭圆。重心轨迹呈现整体位置的移动，椭圆展示方向与离散范围。</p>' +
      '<p>研究文档关注整体向西偏北的迁移与阶段性回摆。切换年份，可以对照这一趋势与当年的分布形态。</p><p class="s-store__note">浅色椭圆保留其他年份，当前年份加深；小点按时间顺序连接。</p>');
    content += section('hierarchy','中心、次中心与外围',
      '<p>研究从密度表面识别城市零售网络的层级：福田、罗湖和南山的核心集聚，与宝安、龙华、龙岗等次级中心共同构成多中心格局。</p>' +
      '<p>对照不同年份的高密度斑块与连接带，观察网络是在原有中心加密，还是向外围形成新的集聚。规划轴线与零售密度的空间对应，是文档讨论的另一条线索。</p>');
    content += section('growth','增长来自加密，还是空间扩张？',
      '<p>将2012—2023年的核密度净增长分为两部分：原有非零网格内的变化，以及原本零值网格上的新增密度。</p>' +
      '<div class="s-research__split"><strong>'+percent(m.growth.densificationShare)+'</strong><span>既有覆盖内加密</span><strong>'+percent(1-m.growth.densificationShare)+'</strong><span>新增覆盖区扩张</span></div>' +
      '<p>增长主要发生在已有覆盖范围内。左侧深绿表示加密区域，浅绿表示新增覆盖；灰色表示密度下降。</p><p class="s-store__note">比例按原始100 m核密度表核算，地图以1 km聚合分类显示。净增长含既有网格的下降量，不能直接解释为开店或关店。</p>');
    content += section('cube','把城市的时间竖起来',
      '<p>横向保留深圳的空间位置，竖向表示年份。五个观测切片按真实年份间隔排列；同一网格在不同高度的颜色，呈现它的记录变化。</p>' +
      '<input class="s-store__timeline" data-store-timeline type="range" min="2012" max="2023" step="0.01" value="2023" aria-label="时间切片位置">' +
      '<button type="button" class="s-store__play" data-store-play aria-pressed="false">播放时间演示</button>' +
      '<div class="s-store__metrics"><div><strong data-store-records></strong><span>观测记录</span></div><div><strong data-store-cells></strong><span>有记录网格</span></div><div><strong>1 km</strong><span>网格边长</span></div></div>' +
      '<div class="s-store__legend"><span>低</span><i></i><span>'+maxCount+'条 / 网格</span></div>' +
      '<div class="s-store__profile" data-store-profile><h4>同一位置，五期对照</h4></div>' +
      '<p class="s-store__note">动画只连接五期观测，不生成中间年份的门店数量。</p>');
    content += section('hotspot','哪些地方正在成为热点？',
      '<p>新兴热点分析结合局部集聚与时间趋势，区分新增、连续、加强、持续、分散及振荡等类型。它关注的不只是某一年的密度，而是一个位置的长期变化。</p>' +
      '<div class="s-research__switch"><button type="button" data-hotspot-view="category" aria-pressed="true">演化类型</button><button type="button" data-hotspot-view="bins" aria-pressed="false">逐年冷热点</button></div>' +
      '<label class="s-research__hot-year" hidden>分析年份 <input data-hotspot-year type="range" min="2012" max="2023" step="1" value="2023"><b data-hotspot-year-label>2023</b></label>' +
      '<div class="s-research__categories" data-hotspot-legend></div>' +
      '<p class="s-store__note">此处使用研究中已有的LOCF年度填充方案，未观测年份沿用最近一期数据。冷热点结果受该填充方式影响。</p>');
    content += section('model','从全局关系到局部差异',
      '<p>以便利店核密度为因变量，GDP、道路线密度与城市化密度为自变量。OLS用一组全局系数描述深圳，GTWR允许关系随位置和年份变化。</p>' +
      '<div class="s-research__split"><strong>'+m.olsR2.toFixed(3)+'</strong><span>OLS · R²</span><strong>'+m.diagnostics.R2.toFixed(3)+'</strong><span>GTWR · R²</span></div>' +
      '<p>两者使用同一组5000个时空样本。局部模型的拟合提升，提示这些变量与便利店密度之间存在空间差异。</p><p class="s-store__note">空间带宽'+num(m.diagnostics.bw_s)+' m · 固定距离核。图中系数是样本点估计，不是连续覆盖的观测值。</p>');
    content += section('gdp','经济要素的空间差异',
      '<p>GDP系数在不同位置呈现不同的强度。文档将这种差异作为核心区与边缘区的对照：相同的经济指标变化，可能对应不同的便利店密度变化。</p>'+trend(2) +
      '<p class="s-store__note">绿：正向关联 · 灰紫：负向关联 · 浅色：接近零。色阶跨年份统一；系数描述统计关联。</p>');
    content += section('road','道路连接与商业分布',
      '<p>道路将居民活动与商业网点连接起来。对照道路线密度系数，可以观察交通条件的关联在哪些地方更强，哪些地方较弱或呈负向。</p>'+trend(1) +
      '<p>文档强调路网的基础作用；当前模型输出也保留局部负系数，便于查看不同区域的差异。</p>');
    content += section('urban','建成环境与城市零售',
      '<p>城市化密度衡量建成环境的发育程度。研究关注核心成熟区与外围开发区的不同表现，以及新增建设空间与既有片区加密的关系。</p>'+trend(0) +
      '<p>切换年份，观察建成环境系数在空间上的分布，再与核密度和增长模式对照。</p>');
    content += section('stability','驱动效应是否随时间改变？',
      '<p>将三类系数的年度均值与分布范围放在一起，检验选址关联的时序稳定性。均值变化较小，也可能伴随显著的局部差异。</p>' +
      '<h4>GDP</h4>'+trend(2)+'<h4>道路线密度</h4>'+trend(1)+'<h4>城市化密度</h4>'+trend(0));
    content += section('residual','模型没有解释的部分',
      '<p>标准化残差展示观测密度与预测密度的偏离。绿色为观测高于预测，灰紫为观测低于预测；颜色越深，偏离越明显。</p>' +
      '<p>文档重点讨论机场—福永、大鹏沿海等区域，并提出旅游、空港与产业服务等可能的解释。这些是后续研究线索，残差本身不能证实其成因。</p>' +
      '<div class="s-research__diagnostics"><span>调整R²</span><b>'+m.diagnostics.adj_R2.toFixed(3)+'</b><span>AICc</span><b>'+num(m.diagnostics.AICc,1)+'</b><span>有效参数数量</span><b>'+num(m.diagnostics.ENP,1)+'</b></div>' +
      '<div class="s-research__selection" data-research-selection></div>');
    content += section('conclusion','回到城市的日常',
      '<p>研究从三个角度理解深圳便利店网络：既有覆盖内的加密、多中心的空间结构，以及驱动因素的时空差异。把它们放在一起，才能同时读到增长的规模、位置与关联。</p>' +
      '<h4>还有哪些问题？</h4><p>POI口径与年度填充会影响时间比较；大量零值网格、固定带宽和业态混合也限制了模型解释。未来可细分社区、商务、旅游与产业型网点，并加入人流、轨道可达性和多尺度模型。</p>' +
      '<details><summary>数据与结果口径</summary><p>网页采用清洗后的五期POI记录，保留原提取口径中少量其他类别；使用已有服务区、椭圆与LOCF热点结果。回归系数与诊断采用同一版最新输出，并在同一样本上核算OLS。文档中较早版本的0.613拟合指标未与此版混用。</p></details>');
    return '<aside class="s-store" data-store-panel hidden><button type="button" class="s-store__back" data-store-back>返回项目入口</button>' +
      '<p class="s-store__eyebrow">课程项目 · 2012—2023</p><h2 class="s-store__title">深圳市便利店格局演化与驱动机制</h2>' +
      '<p class="s-store__intro">基于多源时空数据</p><div class="s-research__controls"><label>章节<select data-research-nav aria-label="选择研究章节">'+navigation+'</select></label>' +
      '<div class="s-store__years" role="group" aria-label="观测年份">'+yearButtons+'</div><div class="s-store__readout"><span>观测年份</span><strong data-store-current></strong></div></div>' + content + '</aside>';
  }

  function outline(rings, material, y) {
    var points = [];
    rings.forEach(function(ring) { for(var i=1;i<ring.length;i++) points.push.apply(points, xy(ring[i-1],y).concat(xy(ring[i],y))); });
    var geometry = new global.THREE.BufferGeometry();
    geometry.setAttribute('position',new global.THREE.Float32BufferAttribute(points,3));
    return new global.THREE.LineSegments(geometry,material);
  }
  function mat(color, opacity, line) {
    var T = global.THREE;
    var m = line ? new T.LineBasicMaterial({color:color,transparent:true,opacity:opacity}) :
      new T.MeshBasicMaterial({color:color,transparent:true,opacity:opacity,side:T.DoubleSide,depthWrite:false});
    m.userData.baseOpacity = opacity;
    return m;
  }
  function grid(cells, values, scale, categorical) {
    var T = global.THREE, material = mat('#ffffff',.94), geometry = new T.BoxGeometry(.094,.015,.094);
    var mesh = new T.InstancedMesh(geometry,material,cells.length), matrix = new T.Matrix4();
    var quiet = new T.Color(css('--color-paper-2') || '#cad7b8'), green = new T.Color(css('--color-accent') || '#416038');
    var negative = new T.Color(state.theme === 'night' ? '#a299b4' : '#787389');
    cells.forEach(function(c,i){
      var v = values(c), p = xy([c[0]+.5,c[1]+.5],.025);
      matrix.identity().setPosition(p[0],p[1],p[2]); mesh.setMatrixAt(i,matrix);
      // CSS/legend colours are sRGB; the shared renderer expects linear input.
      // Convert once so categorical tiles retain the legend's saturation.
      var hue = categorical ? new T.Color(categorical(v)).convertSRGBToLinear() : quiet.clone().lerp(v<0?negative:green,Math.max(.12,Math.min(1,Math.sqrt(Math.abs(v)/(scale||1)))));
      mesh.setColorAt(i,hue);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    return mesh;
  }
  function service(polygons) {
    var T=global.THREE, vertices=[], indices=[];
    polygons.forEach(function(polygon){
      var rings=polygon.map(function(r){return r.slice(0,-1).map(function(p){return new T.Vector2((p[0]-46.5)*CELL,-(p[1]-22.5)*CELL);});});
      if(!rings[0] || rings[0].length<3) return;
      var triangles=T.ShapeUtils.triangulateShape(rings[0],rings.slice(1));
      var offset=vertices.length/3;
      rings.forEach(function(r){r.forEach(function(p){vertices.push(p.x,.018,p.y);});});
      triangles.forEach(function(t){indices.push(t[0]+offset,t[1]+offset,t[2]+offset);});
    });
    var geometry=new T.BufferGeometry(); geometry.setAttribute('position',new T.Float32BufferAttribute(vertices,3)); geometry.setIndex(indices);
    return new T.Mesh(geometry,mat(css('--color-accent'),.72));
  }
  var names=['无显著模式','新增','连续','加强','持续','减弱','分散','振荡','历史'];
  function categoryName(v) { return v===0?names[0]:names[Math.abs(v)]+(v>0?'热点':'冷点'); }
  function categoryColor(v) {
    var hot = state.theme==='night' ? ['#364336','#e8b449','#4cbb80','#23815b','#b9df69','#bda06b','#57d7d3','#ca91e3','#8b947c'] :
      ['#c6ccb9','#c99427','#2b805a','#174331','#79ac36','#9f7951','#219ba1','#6e55a6','#7a6a55'];
    var cold = state.theme==='night' ? ['#364336','#aecae9','#658edf','#386cc7','#9188eb','#b9a7de','#88d9f4','#959bd0','#8a95ad'] :
      ['#c6ccb9','#609fd2','#25549b','#18345f','#5960bc','#ad91c8','#5cb6e0','#7367b7','#767590'];
    return (v<0?cold:hot)[Math.abs(v)] || hot[0];
  }
  function makeMap(mode,index) {
    var T=global.THREE, r=data(), d=global.CONVENIENCE_STORE_DATA;
    var group=new T.Group();
    group.add(outline(d.boundary,mat(css('--color-space-dark'),.65,true),.01));
    var cells=r.model.grids[index];
    if(mode==='counts') group.add(grid(d.slices[index].cells,function(c){return c[2];},state.cube.maxCount));
    if(mode==='kde') group.add(grid(cells,function(c){return c[2];},r.model.gridScales[0]));
    if(mode==='service') group.add(service(r.shapes[index].service));
    if(mode==='center') {
      group.add(grid(d.slices[index].cells,function(c){return c[2];},state.cube.maxCount));
      group.children[1].material.userData.baseOpacity=.22;
      r.shapes.forEach(function(s,i){group.add(outline(s.ellipse[0],mat(css('--color-space-dark'),i===index?.95:.19,true),.045+i*.005));});
      group.add(outline([r.shapes.map(function(s){return s.center;})],mat(css('--color-space-dark'),.85,true),.09));
      r.shapes.forEach(function(s,i){var dot=new T.Mesh(new T.SphereGeometry(i===index?.055:.028,10,8),mat(css('--color-space-dark'),i===index?1:.6));dot.position.fromArray(xy(s.center,.095));group.add(dot);});
    }
    if(mode==='growth') {
      var before={}; r.model.grids[0].forEach(function(c){before[c[0]+':'+c[1]]=c[2];});
      // Map classifies aggregated density changes; percentages use full 100m table.
      group.add(grid(r.model.grids[4].filter(function(c){return c[2]>0||(before[c[0]+':'+c[1]]||0)>0;}),function(c){var old=before[c[0]+':'+c[1]]||0;return c[2]<old?-1:old>0?2:1;},1,function(v){return v<0?(state.theme==='night'?'#8d8e8b':'#b1b5ac'):v===2?css('--color-accent'):css('--color-space-light');}));
    }
    if(mode==='hotspot') {
      var hs=state.hotspotView==='bins'?r.hotspots.bins[state.hotspotYear-2012]:r.hotspots.categories;
      group.add(grid(hs,function(c){return c[2];},3,state.hotspotView==='bins'?function(v){return new T.Color(css('--color-paper-2')).lerp(new T.Color(categoryColor(v>0?3:-3)),Math.abs(v)/3).getStyle();}:categoryColor));
    }
    if(['gdp','road','urban','residual'].indexOf(mode)>=0) {
      var field={urban:2,road:3,gdp:4,residual:5}[mode], points=r.model.points[index];
      var coords=[], colors=[], quiet=new T.Color(css('--color-paper-2')), positive=new T.Color(css('--color-accent')), negative=new T.Color(state.theme==='night'?'#b7a6c8':'#79708c');
      var scale=r.model.coefficientScales[field-2];
      points.forEach(function(p){coords.push.apply(coords,xy(p,.055));var c=quiet.clone().lerp(p[field]<0?negative:positive,Math.min(1,.22+Math.abs(p[field])/scale*.78));colors.push(c.r,c.g,c.b);});
      var g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(coords,3));g.setAttribute('color',new T.Float32BufferAttribute(colors,3));
      var material=new T.PointsMaterial({size:.049,vertexColors:true,transparent:true,opacity:.95,depthWrite:false});material.userData.baseOpacity=.95;
      var scatter=new T.Points(g,material);scatter.userData.points=points;group.add(scatter);
    }
    group.userData.weight=0;group.visible=false;state.group.add(group);return group;
  }
  function disposeMaps() {
    Object.keys(state.cache).forEach(function(k){var g=state.cache[k];g.traverse(function(o){if(o.geometry)o.geometry.dispose();if(o.material)o.material.dispose();});state.group.remove(g);});
    state.cache={};state.current=null;state.key='';
  }
  function updateLegend() {
    var legend=state.cube.panel.querySelector('[data-hotspot-legend]');
    legend.innerHTML=state.hotspotView==='bins'?'<span><i style="background:'+categoryColor(3)+'"></i>热点</span><span><i style="background:'+categoryColor(-3)+'"></i>冷点</span><span>显著性：90% / 95% / 99%</span>':
      Object.keys(data().hotspots.categoryCounts).sort(function(a,b){return Number(a)-Number(b);}).map(function(k){var v=Number(k);return '<span><i style="background:'+categoryColor(v)+'"></i>'+categoryName(v)+' <b>'+data().hotspots.categoryCounts[k]+'</b></span>';}).join('');
  }
  function hotspotAt(col,row) {
    return state.hotspotIndex[col+':'+row] || null;
  }
  function updateHotspotInfo() {
    if(!state.hotspotSelection)return;
    var cell=state.hotspotSelection, category=hotspotAt(cell[0],cell[1]);
    var name=category?categoryName(category[2]):'这里没有热点分析结果';
    var detail='2012—2023 · 演化类型';
    if(category && state.hotspotView==='bins') {
      var bin=data().hotspots.bins[state.hotspotYear-2012].find(function(c){return c[0]===cell[0]&&c[1]===cell[1];});
      var value=bin?bin[2]:0;
      detail=state.hotspotYear+' · '+(value===0?'无显著冷热点':(value>0?'热点':'冷点')+' · '+({1:90,2:95,3:99}[Math.abs(value)])+'%置信水平');
    }
    state.hotspotInfo.querySelector('[data-hotspot-type]').textContent=name;
    state.hotspotInfo.querySelector('[data-hotspot-detail]').textContent=category?detail:'未提供该位置的结果';
    state.hotspotInfo.querySelector('i').style.background=category?categoryColor(category[2]):'var(--color-ink-3)';
    state.hotspotMarker.position.fromArray(xy([cell[0]+.5,cell[1]+.5],.055));
    state.hotspotMarker.material.color.set(css('--color-ink-1'));
  }
  function positionHotspotInfo() {
    var visible=state.active&&state.mode==='hotspot'&&!!state.hotspotSelection;
    state.hotspotMarker.visible=visible;
    state.hotspotInfo.hidden=!visible;
    if(!visible)return;
    var rect=state.ctx.state.host.getBoundingClientRect();
    var p=state.hotspotMarker.position.clone().project(state.ctx.state.camera);
    if(Math.abs(p.z)>1 || Math.abs(p.x)>1 || Math.abs(p.y)>1) {state.hotspotInfo.hidden=true;return;}
    var x=(p.x*.5+.5)*rect.width, y=(-p.y*.5+.5)*rect.height;
    var width=state.hotspotInfo.offsetWidth, height=state.hotspotInfo.offsetHeight;
    state.hotspotInfo.style.left=Math.max(12,Math.min(rect.width-width-12,x-width/2))+'px';
    state.hotspotInfo.style.top=Math.max(12,Math.min(rect.height-height-12,y-height-18))+'px';
  }
  function setChapter(id) {
    var c=chapters.find(function(c){return c[0]===id;});if(!c)return;
    state.chapter=id;state.mode=c[2];
    state.cube.panel.querySelector('[data-research-nav]').value=id;
    state.cube.setCursor(Math.round(state.cube.cursor));
    state.cube.panel.querySelector('[data-store-play]').textContent='播放时间演示';
    state.cube.panel.querySelector('[data-store-play]').setAttribute('aria-pressed','false');
    state.cube.panel.querySelector('[data-store-current]').textContent=String(global.CONVENIENCE_STORE_DATA.slices[Math.round(state.cube.cursor)].year)+' · 观测期';
    var city=state.ctx.state;
    city.targetAzimuth=0;
    city.targetElevation=state.mode==='cube'?.58:1.18;
    city.targetOrbitY=state.mode==='cube'?2.72:0;
    city.targetOrbitX=0;city.targetOrbitZ=0;
    fitCamera();
    city.shell.querySelector('[data-city-readout]').textContent=c[1];
    state.cube.overlay.querySelector('[data-store-overlay]').textContent=c[1];
    state.cube.overlay.querySelector('small').textContent='';
    state.cube.overlay.querySelector('span').textContent='';
    state.cube.labels.forEach(function(l){l.element.hidden=state.mode!=='cube';});
    // Keep sticky controls at a stable height, otherwise scroll-linked sections
    // can bounce across their boundary when one chapter hides the year row.
    var fixed=state.mode==='hotspot'||state.mode==='growth';
    state.cube.panel.querySelectorAll('[data-store-year]').forEach(function(b){b.disabled=fixed;});
    state.cube.panel.querySelector('.s-store__readout span').textContent=fixed?'研究时段':'观测年份';
    if(fixed)state.cube.panel.querySelector('[data-store-current]').textContent='2012—2023';
    positionHotspotInfo();
  }
  function fitCamera() {
    var city=state.ctx.state, aspect=city.camera.aspect || 1;
    var horizontal=5.1 / (Math.tan(city.camera.fov*Math.PI/360)*aspect);
    city.targetDistance=state.mode==='cube'?Math.max(20,horizontal*1.22+2):Math.max(16,horizontal*1.15);
    state.aspect=aspect;
  }
  function init(ctx,cube) {
    state.ctx=ctx;state.cube=cube;state.group=new global.THREE.Group();ctx.state.scene.add(state.group);state.group.visible=false;
    state.hotspotView='category';state.hotspotYear=2023;
    state.hotspotIndex={};data().hotspots.categories.forEach(function(c){state.hotspotIndex[c[0]+':'+c[1]]=c;});
    state.hotspotMarker=new global.THREE.LineSegments(new global.THREE.EdgesGeometry(new global.THREE.BoxGeometry(.112,.03,.112)),new global.THREE.LineBasicMaterial({color:css('--color-ink-1'),depthTest:false}));
    state.hotspotMarker.renderOrder=10;state.hotspotMarker.visible=false;ctx.state.scene.add(state.hotspotMarker);
    state.hotspotInfo=document.createElement('div');state.hotspotInfo.className='s-research__hotspot-info';state.hotspotInfo.hidden=true;
    state.hotspotInfo.setAttribute('role','status');state.hotspotInfo.setAttribute('aria-live','polite');
    state.hotspotInfo.innerHTML='<i></i><strong data-hotspot-type></strong><small data-hotspot-detail></small><button type="button" aria-label="关闭热点信息">×</button>';
    state.hotspotInfo.querySelector('button').addEventListener('click',function(e){e.stopPropagation();state.hotspotSelection=null;positionHotspotInfo();});
    ctx.state.stage.appendChild(state.hotspotInfo);
    cube.panel.querySelector('[data-research-nav]').addEventListener('change',function(e){var s=cube.panel.querySelector('#store-'+e.target.value), h=cube.panel.querySelector('.s-research__controls').offsetHeight;cube.panel.scrollTo({top:s.offsetTop-h-12,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});});
    cube.panel.addEventListener('scroll',function(){
      if(!state.active||state.frame)return;
      state.frame=requestAnimationFrame(function(){state.frame=0;var sections=cube.panel.querySelectorAll('[data-research-section]'), id='intro', h=cube.panel.querySelector('.s-research__controls').offsetHeight;sections.forEach(function(s){if(s.offsetTop<=cube.panel.scrollTop+h+38)id=s.dataset.researchSection;});if(id!==state.chapter)setChapter(id);});
    },{passive:true});
    cube.panel.addEventListener('click',function(e){var b=e.target.closest('[data-hotspot-view]');if(!b)return;state.hotspotView=b.dataset.hotspotView;cube.panel.querySelectorAll('[data-hotspot-view]').forEach(function(x){x.setAttribute('aria-pressed',String(x===b));});cube.panel.querySelector('.s-research__hot-year').hidden=state.hotspotView!=='bins';state.key='';updateLegend();updateHotspotInfo();});
    cube.panel.querySelector('[data-hotspot-year]').addEventListener('input',function(e){state.hotspotYear=Number(e.target.value);cube.panel.querySelector('[data-hotspot-year-label]').textContent=state.hotspotYear;state.key='';updateHotspotInfo();});
  }
  function enter() {
    state.active=true;state.group.visible=true;state.cube.panel.scrollTop=0;setChapter('intro');
    state.theme=document.documentElement.classList.contains('m-theme-night')?'night':'day';updateLegend();
    state.ctx.state.shell.querySelector('.s-city__identity span').textContent='深圳 · 2012—2023';
    state.key='';
  }
  function exit() {state.active=false;state.hotspotSelection=null;positionHotspotInfo();if(state.group)state.group.visible=false;state.ctx.state.shell.querySelector('.s-city__identity span').textContent='NANSHAN / URBAN SPACE & TIME';}
  function tick(dt) {
    if(!state.active)return;
    var theme=document.documentElement.classList.contains('m-theme-night')?'night':'day';
    if(theme!==state.theme){state.theme=theme;disposeMaps();updateLegend();updateHotspotInfo();}
    if(state.aspect!==state.ctx.state.camera.aspect)fitCamera();
    var index=Math.round(state.cube.cursor);
    var key=state.mode+':'+index+':'+state.hotspotView+':'+state.hotspotYear;
    if(key!==state.key){state.key=key;state.current=state.mode==='cube'?null:(state.cache[key]||(state.cache[key]=makeMap(state.mode,index)));}
    // Fade prebuilt layers. No geometry rebuild in the animation loop.
    var rate=1-Math.exp(-dt/420), reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
    state.group.children.forEach(function(g){var target=g===state.current?1:0;g.userData.weight=reduced?target:g.userData.weight+(target-g.userData.weight)*rate;g.visible=g.userData.weight>.002;g.traverse(function(o){if(o.material)o.material.opacity=o.material.userData.baseOpacity*g.userData.weight;});});
    state.cube.researchWeight=reduced?(state.mode==='cube'?1:0):(state.cube.researchWeight||0)+((state.mode==='cube'?1:0)-(state.cube.researchWeight||0))*rate;
    state.cube.group.visible=state.cube.researchWeight>.002;
    state.cube.group.scale.y=.05+.95*state.cube.researchWeight;
    state.cube.group.traverse(function(o){if(o.material){var base=o.material.userData.researchOpacity;if(base===undefined){base=o.material.opacity;o.material.userData.researchOpacity=base;}var i=state.cube.meshes.indexOf(o);o.material.opacity=(i>=0?.12+.74*Math.max(0,1-Math.abs(i-state.cube.cursor)):base)*state.cube.researchWeight;}});
    state.cube.labels.forEach(function(l){if(state.mode!=='cube')l.element.hidden=true;});
    if(state.mode!=='cube')state.cube.overlay.querySelector('[data-store-overlay]').textContent=chapters.find(function(c){return c[0]===state.chapter;})[1];
    positionHotspotInfo();
  }
  function mapClick(event) {
    if(!state.current)return;
    var city=state.ctx.state, T=global.THREE, rect=city.renderer.domElement.getBoundingClientRect();
    var ray=new T.Raycaster();ray.params.Points.threshold=.055;ray.setFromCamera(new T.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),city.camera);
    if(state.mode==='hotspot') {
      // Plane picking also covers the small gaps between tiles, and lets a
      // zero/non-significant annual bin still reveal its evolution category.
      var point=ray.ray.intersectPlane(new T.Plane(new T.Vector3(0,1,0),-.025),new T.Vector3());
      if(!point)return;
      var col=Math.floor(point.x/CELL+46.5), row=Math.floor(22.5-point.z/CELL);
      if(col<0||col>=93||row<0||row>=45)return;
      state.hotspotSelection=[col,row];updateHotspotInfo();positionHotspotInfo();return;
    }
    var obj=state.current.children.find(function(o){return o.isPoints;});if(!obj)return;
    var hit=ray.intersectObject(obj)[0];if(!hit)return;var p=obj.userData.points[hit.index];
    var selection=state.cube.panel.querySelector('[data-research-selection]');
    selection.textContent='观测 '+num(p[6],2)+' · 预测 '+num(p[7],2)+' · 标准化残差 '+num(p[5],2);
    var note=state.cube.overlay.querySelector('small');note.textContent=state.mode==='residual'?selection.textContent:'局部系数 '+num(p[{urban:2,road:3,gdp:4}[state.mode]],2);
  }
  global.ConvenienceResearch={html:html,init:init,enter:enter,exit:exit,tick:tick,mapClick:mapClick,
    isCube:function(){return state.mode==='cube';},setChapter:setChapter,inspect:function(){return {chapter:state.chapter,mode:state.mode,cache:Object.keys(state.cache).length,active:state.active,theme:state.theme,hotspotView:state.hotspotView,hotspotSelection:state.hotspotSelection,
      layerReady:!!state.current || state.mode==='cube',
      pointCount:state.current?(state.current.children.find(function(o){return o.isPoints;})||{geometry:{attributes:{position:{count:0}}}}).geometry.attributes.position.count:0};}};
})(window);
