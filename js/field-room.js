(function (global) {
  'use strict';
  var state = { shell:null, open:false, section:null, team:'baseball', towel:0, focus:null, inert:[], gallery:[], photo:0, photoFocus:null, transition:0, story:null, recordYear:'all' };
  var sections = [
    {id:'journey',name:'故事',english:'STORY',lead:'棒球，一个关于回家的游戏。',x:50,y:74},
    {id:'teams',name:'球队',english:'TEAMS',lead:'垒球，还是棒球？',x:71,y:62},
    {id:'games',name:'比赛',english:'GAMES',lead:'输赢，一起扛。',x:50,y:23},
    {id:'club',name:'俱乐部',english:'CLUB',lead:'深大棒垒，欣欣向荣！',x:27,y:62},
    {id:'records',name:'记忆',english:'MEMORIES',lead:'一路成长，一路遇见。',x:84,y:47},
    {id:'pendant',name:'一根断棒',english:'A BROKEN BAT',lead:'2024年的一击，留给每一个人。',x:24,y:85}
  ];
  function esc(v) { return String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function data() { return global.FIELD_DATA; }
  function sources() { return global.FIELD_SOURCES_DATA; }
  function find(s) { return state.shell.querySelector(s); }
  function engine() { return global.Scene && global.Scene._ && global.Scene._.MapEngine; }
  function fieldSVG() {
    if(global.FIELD_CAD_DATA)return global.FIELD_CAD_DATA.svg;
    return '<svg viewBox="0 0 800 740" aria-hidden="true" focusable="false"><g class="f-contours">' +
      '<path d="M24 237Q400 -92 776 237 M11 214Q400 -142 789 214 M0 190Q400 -190 800 190 M0 165Q400 -240 800 165 M0 140Q400 -292 800 140"/>' +
      '<path d="M92 308Q400 33 708 308 M120 336Q400 85 680 336 M149 365Q400 139 651 365"/></g>' +
      '<g class="f-field-lines"><path class="f-outfield" d="M39 269Q400 -29 761 269L400 630Z"/>' +
      '<path d="M97 327Q400 65 703 327 M214 444Q400 220 586 444 M400 630L265 495L400 360L535 495Z"/>' +
      '<path d="M400 630L29 259 M400 630L771 259 M376 640H353V598H376 M424 640H447V598H424"/>' +
      '<circle cx="400" cy="490" r="21"/><path d="M389 487H411 M388 622H412V633L400 644L388 633Z"/>' +
      '<path d="M265 485L275 495L265 505L255 495Z M400 350L410 360L400 370L390 360Z M535 485L545 495L535 505L525 495Z"/>' +
      '<path d="M336 664Q400 724 464 664"/></g></svg>';
  }
  function mount() {
    if(state.shell)return;
    document.body.insertAdjacentHTML('beforeend','<section id="field-room" data-state="closed" role="dialog" aria-modal="true" aria-labelledby="field-room-title" aria-hidden="true">' +
      '<header class="f-bar"><button type="button" data-f-action="close">← 返回场</button><h2 id="field-room-title">场 <span>/ FIELD</span></h2></header>' +
      '<div class="f-body"><section class="f-map" aria-label="球场导航"><canvas class="f-stadium-canvas" aria-hidden="true"></canvas><svg class="f-stadium-leaders" aria-hidden="true"></svg><div class="f-map__caption"><h3>回到球场</h3><p>为什么棒球是最好的运动？<br>因为其他的运动都没有棒球棒！</p></div>' +
      '<div class="f-diamond">'+fieldSVG()+'<nav aria-label="选择球场内容">' + sections.map(function(s,i){return '<button type="button" data-f-section="'+s.id+'" style="--x:'+s.x+'%;--y:'+s.y+'%" aria-controls="f-content" aria-current="false"><span class="m-landmark__row"><span class="m-landmark__badge">'+String(i+1).padStart(2,'0')+'</span><span class="m-landmark__cn">'+s.name+'</span></span></button>';}).join('') +
      '</nav></div><footer class="f-map__footer"><span>Since 2015</span></footer></section>' +
      '<section class="f-reading" aria-label="球场内容" tabindex="-1" hidden><div class="f-chapter-bar"><button type="button" data-f-action="overview">↙ 回到球场</button><span data-f-chapter-label></span><button type="button" data-f-action="next">下一站 →</button></div><div id="f-content"></div></section></div>' +
      '<div class="f-lightbox" role="dialog" aria-modal="true" aria-label="照片浏览" hidden><div class="f-lightbox__bar"><span data-f-photo-count></span><button type="button" data-f-action="photo-close" aria-label="关闭照片">关闭 ×</button></div>' +
      '<button class="f-photo-prev" type="button" data-f-action="photo-prev" aria-label="上一张照片">←</button><figure><img alt=""><figcaption></figcaption></figure><button class="f-photo-next" type="button" data-f-action="photo-next" aria-label="下一张照片">→</button></div></section>');
    state.shell=document.getElementById('field-room');
    state.shell.querySelectorAll('.f-field-lines path, .f-cad-lines path').forEach(function(path){path.setAttribute('pathLength','1');});
    state.shell.addEventListener('click',function(e){
      var section=e.target.closest('[data-f-section]'); if(section){select(section.dataset.fSection);return;}
      var year=e.target.closest('[data-f-year]'); if(year){state.recordYear=year.dataset.fYear;render();find('[data-f-year="'+state.recordYear+'"]').focus({preventScroll:true});return;}
      var team=e.target.closest('[data-f-team]'); if(team){state.team=team.dataset.fTeam;render();find('[data-f-team="'+state.team+'"]').focus();return;}
      var towel=e.target.closest('[data-f-towel]'); if(towel){state.towel=Number(towel.dataset.fTowel);render();find('[data-f-towel="'+state.towel+'"]').focus();return;}
      var photo=e.target.closest('[data-f-photo]'); if(photo){showPhoto(Number(photo.dataset.fPhoto),true);return;}
      var action=e.target.closest('[data-f-action]'); if(!action)return;
      var a=action.dataset.fAction;
      if(a==='close')close(); if(a==='photo-close')closePhoto();
      if(a==='overview')overview();
      if(a==='next'){var index=sections.findIndex(function(s){return s.id===state.section;});select(sections[(index+1)%sections.length].id);}
      if(a==='photo-prev')showPhoto(state.photo-1); if(a==='photo-next')showPhoto(state.photo+1);
    });
    document.addEventListener('keydown',keydown);
  }
  function heading(k,title,lead) { return '<header class="f-heading"><span>'+k+'</span><h3>'+title+'</h3>'+(lead?'<p>'+lead+'</p>':'')+'</header>'; }
  function chapterHeading(id) { var i=sections.findIndex(function(s){return s.id===id;}),s=sections[i];return heading(String(i+1).padStart(2,'0')+' / '+s.english,s.name,s.lead); }
  function timeline(rows) { return '<ol class="f-timeline">'+rows.map(function(r){return '<li><time>'+esc(r.date)+'</time><h4>'+esc(r.title)+'</h4><p>'+esc(r.text)+'</p></li>';}).join('')+'</ol>'; }
  function photo(src,alt,cls,thumbnail) {
    var n=state.gallery.length;state.gallery.push({src:src,alt:alt});
    return '<button type="button" class="f-image '+(cls||'')+'" data-f-photo="'+n+'" aria-label="放大：'+esc(alt)+'"><img src="'+esc(thumbnail||src)+'" alt="'+esc(alt)+'" loading="lazy" decoding="async"></button>';
  }
  function teams() {
    return chapterHeading('teams') + '<section class="f-team-group" aria-labelledby="f-school-teams"><h4 id="f-school-teams">校队</h4><div class="f-teams">'+data().teams.filter(function(t){return t.id!=='college';}).map(function(t,i){
      return '<section class="f-team"><span class="f-team-index" aria-hidden="true">0'+(i+1)+'</span><span class="f-kicker">'+esc(t.label)+'</span><h4>'+esc(t.name)+'</h4><p>'+esc(t.text)+'</p></section>';
    }).join('')+'</div></section><section class="f-team-group" aria-labelledby="f-college-teams"><h4 id="f-college-teams">院队</h4>'+collegeTeams()+'</section>';
  }
  function games() {
    var selected=data().teams.find(function(t){return t.id===state.team;});
    var names={baseball:'校棒球队',college:'建规男队',women:'校女垒'};
    var rows=data().competitions.filter(function(r){return r.team===state.team;});
    return chapterHeading('games')+'<div class="f-scoreboard">'+
      '<div class="f-switch" role="group" aria-label="比赛队伍">'+data().teams.map(function(t){return '<button type="button" data-f-team="'+t.id+'" aria-pressed="'+(t.id===state.team)+'">'+names[t.id]+'</button>';}).join('')+'</div>' +
      '<h4 class="f-games-title">'+esc(selected.name)+'</h4><ol class="f-games">'+rows.map(function(r){return '<li><time>'+esc(r.date)+'</time><div><h5>'+esc(r.short)+'</h5><p>'+esc(r.name)+'</p></div><strong'+(r.rank===1?' class="f-champion"':'')+'><b>'+r.rank+'</b><span>'+(r.rank===1?'冠军':r.rank===2?'亚军':'名')+'</span></strong></li>';}).join('')+'</ol>' +
      '</div>';
  }
  function club() {
    return chapterHeading('club') +
      '<section class="f-club-intro"><h4>'+esc(data().club.name)+' <span>（'+esc(data().club.shortName)+'）</span></h4>'+data().club.paragraphs.map(function(p){return '<p class="f-lead">'+esc(p)+'</p>';}).join('')+'</section>' +
      '<div class="f-photo-pair">'+photo('assets/media/field/club/image4.webp','球场上的交流')+photo('assets/media/field/club/image6.webp','垒球训练')+'</div>';
  }
  function collegeTeams() {
    var colleges=sources().colleges,t=colleges[state.towel];
    return '<div class="f-switch f-towel-tabs" role="group" aria-label="选择院队">'+colleges.map(function(c,i){return '<button type="button" data-f-towel="'+i+'" aria-pressed="'+(i===state.towel)+'">'+esc(c.name)+'</button>';}).join('')+'</div>' +
      '<article class="f-college"><figure class="f-college-design">'+photo(t.images[0],t.name+'运动毛巾设计','f-towel-image')+'<figcaption>运动毛巾设计</figcaption></figure>' +
      '<section class="f-college-intro" aria-label="'+esc(t.name)+'院队介绍"><header><span class="f-kicker">文创设计时的院队介绍</span><h4>'+esc(t.name)+'</h4></header>'+t.paragraphs.map(function(p){return '<p>'+esc(p)+'</p>';}).join('')+'</section></article>';
  }
  function pendant() {
    return chapterHeading('pendant') +
      '<section class="f-pendant-model" aria-label="断棒挂件三维展示">' +
      '<div class="f-pendant-view"><canvas aria-label="断棒挂件：按住左键拖拽旋转，滚轮缩放"></canvas><img class="f-pendant-fallback" src="assets/media/field/pendant/front-01.svg" alt="挂件正面CAD雕刻"><span class="f-pendant-loading" role="status">加载挂件…</span></div>' +
      '<div class="f-pendant-versions" role="group" aria-label="选择成员">'+global.FIELD_PENDANT_CATALOG.map(function(v,i){return '<button type="button" data-pendant-version="'+v.id+'" aria-pressed="'+(i===0)+'"><span>'+esc(v.name)+'</span>'+(v.number===null?'':'<small>#'+esc(v.number)+'</small>')+'</button>';}).join('')+'</div><a class="f-pendant-download" data-pendant-download href="assets/media/field/pendant/pendant-20.glb" download>下载模型 ↗</a></section>' +
      '<section class="f-pendant-story"><p>2025年夏天，我和两位队友，把一根被打断的木棒做成半圆形挂件，送给棒球队的每一位成员。</p></section>';
  }
  function records() {
    var article=sources().article;
    var moments=global.MomentsContent?global.MomentsContent.group('field'):data().moments;
    var entries=[{date:article.date,type:'article',item:article}].concat(moments.map(function(m){return {date:m.date,type:'moment',item:m};})).sort(function(a,b){return b.date.replace(/\./g,'-').localeCompare(a.date.replace(/\./g,'-'));});
    var rows=entries.filter(function(e){return state.recordYear==='all'||e.date.slice(0,4)===state.recordYear;});
    return chapterHeading('records') +
      (global.MomentsContent?'<div class="f-memory-tools"><nav class="f-memory-years" aria-label="按年份浏览记忆">'+global.MomentsContent.filters(entries,state.recordYear,'data-f-year')+'</nav></div>':'')+
      '<div class="f-records">'+rows.map(function(e){var m=e.item;
        if(e.type==='moment'){
          var text=global.MomentsContent?global.MomentsContent.paragraphs(m.paragraphs):(m.paragraphs||[]).map(function(p){return '<p>'+esc(p)+'</p>';}).join('');
          return '<article class="f-record f-moment" data-moment-id="'+esc(m.id)+'"><time datetime="'+esc(m.date.replace(' ','T')+'+08:00')+'">'+esc(m.date.slice(0,10).replace(/-/g,'.'))+' · 朋友圈</time>'+(m.location?'<p class="f-location">'+esc(m.location)+'</p>':'')+(m.title?'<h4>'+esc(m.title)+'</h4>':'')+(text?'<div class="f-moment-text">'+text+'</div>':'')+(m.images.length?'<div class="f-moment-grid" data-images="'+m.images.length+'">'+m.images.map(function(img,i){return photo(typeof img==='string'?img:img.src,m.date.slice(0,10)+(m.location?' · '+m.location:'')+' · 第 '+(i+1)+' 张','',img.thumb);}).join('')+'</div>':'')+'</article>';
        }
        return '<article class="f-record"><time datetime="'+esc(m.date)+'">'+esc(m.date)+' · 海峡杯后</time><h4>'+esc(m.title)+'</h4>' + m.sections.map(function(s,i){return '<section class="f-story-block">'+s.paragraphs.map(function(p){return '<p>'+esc(p)+'</p>';}).join('')+'<div class="f-photo-pair">'+s.images.map(function(src,j){return photo(src,'《棒球让我遇见什么》· '+(i+1)+'-'+(j+1));}).join('')+'</div></section>';}).join('')+'</article>';
      }).join('')+'</div>'+(rows.length?'':'<p class="f-memory-empty">这一年还没有记录。</p>');
  }
  function journey() {
    var rows=data().journey.concat(data().storyRoles),points=[[180,320],[720,190],[1250,480],[1770,280],[1810,900],[1300,1120],[720,880],[250,1180]],seam='M'+points[0].join(','),nodes='';
    for(var i=0;i<points.length-1;i++){
      var a=points[Math.max(0,i-1)],b=points[i],c=points[i+1],d=points[Math.min(points.length-1,i+2)];
      seam+='C'+[b[0]+(c[0]-a[0])/6,b[1]+(c[1]-a[1])/6,c[0]-(d[0]-b[0])/6,c[1]-(d[1]-b[1])/6,c[0],c[1]].map(function(v){return v.toFixed(2);}).join(',');
    }
    var cards=rows.map(function(r,i){var p=points[i];nodes+='<circle cx="'+p[0]+'" cy="'+p[1]+'" r="6"/>';return '<li class="f-journey-stop" style="left:'+(p[0]-140)+'px;top:'+(p[1]+32)+'px"><time>'+esc(r.date)+'</time><h4>'+esc(r.title)+'</h4><p>'+esc(r.text)+'</p></li>';}).join('');
    return '<div class="f-story-space" tabindex="0" role="region" aria-label="按住左键或用单指拖拽浏览故事，可向任意方向移动；方向键也可移动"><div class="f-story-world"><svg class="f-story-seam" viewBox="0 0 2200 1560" aria-hidden="true"><path class="f-story-thread" d="'+seam+'"/><path class="f-story-stitches"/><g class="f-story-nodes">'+nodes+'</g></svg><ol>'+cards+'</ol></div><div class="f-story-caption">'+chapterHeading('journey')+'</div><div class="f-story-range"><span>2015 — 至今</span><span>拖拽，继续故事 ↔</span></div></div>';
  }
  function closeStory() { if(state.story)state.story.close();state.story=null; }
  function mountStory() {
    var viewport=find('.f-story-space'),world=viewport.querySelector('.f-story-world'),path=world.querySelector('.f-story-thread'),stitches='';
    var length=path.getTotalLength(),pan={x:0,y:0},drag=null,ready=false,oldWidth=0,oldHeight=0;
    for(var distance=12;distance<length-12;distance+=20){
      var p=path.getPointAtLength(distance),a=path.getPointAtLength(distance-1),b=path.getPointAtLength(distance+1),dx=b.x-a.x,dy=b.y-a.y,n=Math.hypot(dx,dy),tx=dx/n,ty=dy/n;
      [-1,1].forEach(function(sign){stitches+='M'+(p.x-5*tx-sign*8*ty).toFixed(2)+','+(p.y-5*ty+sign*8*tx).toFixed(2)+'L'+(p.x+5*tx+sign*2*ty).toFixed(2)+','+(p.y+5*ty-sign*2*tx).toFixed(2);});
    }
    world.querySelector('.f-story-stitches').setAttribute('d',stitches);
    function paint(){
      var w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;
      pan.x=Math.max(w-2200-96,Math.min(96,pan.x));pan.y=Math.max(h-1560-96,Math.min(160,pan.y));
      world.style.transform='translate3d('+pan.x+'px,'+pan.y+'px,0)';viewport.dataset.panX=pan.x;viewport.dataset.panY=pan.y;
    }
    function resize(){
      var w=viewport.clientWidth,h=viewport.clientHeight;if(!w||!h)return;
      if(!ready){pan.x=(w<700?w/2:w*.2)-180;pan.y=Math.max(210,h*.42)-320;ready=true;}
      else {pan.x+=(w-oldWidth)/2;pan.y+=(h-oldHeight)/2;}
      oldWidth=w;oldHeight=h;paint();
    }
    function release(e){if(!drag||e&&e.pointerId!==drag.id)return;var id=drag.id;drag=null;viewport.classList.remove('is-dragging');if(viewport.hasPointerCapture(id))viewport.releasePointerCapture(id);}
    viewport.addEventListener('pointerdown',function(e){if(e.button!==0||!e.isPrimary||drag)return;e.preventDefault();viewport.focus({preventScroll:true});drag={id:e.pointerId,x:e.clientX,y:e.clientY,panX:pan.x,panY:pan.y};viewport.setPointerCapture(e.pointerId);viewport.classList.add('is-dragging');});
    viewport.addEventListener('pointermove',function(e){if(!drag||e.pointerId!==drag.id)return;pan.x=drag.panX+e.clientX-drag.x;pan.y=drag.panY+e.clientY-drag.y;paint();});
    viewport.addEventListener('pointerup',release);viewport.addEventListener('pointercancel',release);viewport.addEventListener('lostpointercapture',release);
    viewport.addEventListener('wheel',function(e){if(!e.ctrlKey)e.preventDefault();},{passive:false});
    viewport.addEventListener('keydown',function(e){var d={ArrowLeft:[140,0],ArrowRight:[-140,0],ArrowUp:[0,140],ArrowDown:[0,-140]}[e.key];if(!d)return;e.preventDefault();e.stopPropagation();pan.x+=d[0];pan.y+=d[1];paint();});
    var observer=new ResizeObserver(resize);observer.observe(viewport);resize();state.story={close:function(){observer.disconnect();release();}};
  }
  function render() {
    closeStory();
    if(global.FieldPendant)global.FieldPendant.close();
    state.gallery=[];
    var html=state.section==='journey'?journey():
      state.section==='teams'?teams():state.section==='games'?games():state.section==='club'?club():state.section==='pendant'?pendant():records();
    find('#f-content').innerHTML=html;
    if(state.section==='journey')mountStory();
    if(state.section==='pendant'&&global.FieldPendant)global.FieldPendant.open(find('.f-pendant-model'));
  }
  function select(id) {
    var index=sections.findIndex(function(s){return s.id===id;});if(index<0)return;
    state.section=id;state.shell.dataset.section=id;
    clearTimeout(state.transition);
    state.shell.dataset.view='approaching';
    state.shell.querySelectorAll('[data-f-section]').forEach(function(b){b.setAttribute('aria-current',String(b.dataset.fSection===id));});
    var p=sections[index],diamond=find('.f-diamond');
    diamond.style.setProperty('--focus-x',(50-p.x)*1.15+'%');diamond.style.setProperty('--focus-y',(55-p.y)*.8+'%');
    diamond.style.setProperty('--focus-scale','1.5');
    find('.f-map').inert=true;find('.f-reading').hidden=true;
    if(global.FieldStadium)global.FieldStadium.focus(id);
    find('[data-f-chapter-label]').textContent=p.name;
    render();find('.f-reading').scrollTop=0;
    var show=function(){if(!state.open||state.section!==id)return;state.shell.dataset.view='chapter';find('.f-reading').hidden=false;find('.f-reading').focus({preventScroll:true});state.transition=0;};
    if(global.matchMedia('(prefers-reduced-motion: reduce)').matches)show();else state.transition=setTimeout(show,850);
  }
  function overview() {
    closeStory();
    if(global.FieldPendant)global.FieldPendant.close();
    clearTimeout(state.transition);state.transition=0;
    var previous=state.section;state.section=null;state.gallery=[];
    state.shell.dataset.view='overview';state.shell.dataset.section='';
    find('.f-reading').hidden=true;find('#f-content').textContent='';find('.f-map').inert=false;
    if(global.FieldStadium)global.FieldStadium.overview();
    find('.f-diamond').style.setProperty('--focus-x','0%');find('.f-diamond').style.setProperty('--focus-y','0%');find('.f-diamond').style.setProperty('--focus-scale','1');
    state.shell.querySelectorAll('[data-f-section]').forEach(function(b){b.setAttribute('aria-current','false');});
    if(previous)find('[data-f-section="'+previous+'"]').focus({preventScroll:true});
  }
  function open() {
    if(state.open)return;
    // Second-level rooms are exclusive, even when invoked programmatically.
    if(global.MomentsRoom&&global.MomentsRoom.isOpen())global.MomentsRoom.close();
    if(global.RhythmPlayer&&global.RhythmPlayer.isOpen())global.RhythmPlayer.close();
    if(global.SpaceCity&&global.SpaceCity.isOpen())global.SpaceCity.close();
    mount();state.focus=document.activeElement;state.open=true;
    state.shell.dataset.state='open';state.shell.setAttribute('aria-hidden','false');
    state.inert=Array.prototype.map.call(document.querySelectorAll('#app, .m-time-control'),function(el){var before=el.inert;el.inert=true;return {el:el,before:before};});
    var map=engine();if(map&&map.suspend)map.suspend('field-room');
    if(global.TerrainOrbit)global.TerrainOrbit.suspendGPU();
    overview();find('[data-f-action="close"]').focus();
    if(global.FieldStadium)global.FieldStadium.open(find('.f-map'));
  }
  function close() {
    if(!state.open)return;if(!find('.f-lightbox').hidden)closePhoto();
    closeStory();clearTimeout(state.transition);state.transition=0;
    if(global.FieldPendant)global.FieldPendant.close();
    if(global.FieldStadium)global.FieldStadium.close();
    state.open=false;state.shell.dataset.state='closed';state.shell.setAttribute('aria-hidden','true');
    state.inert.forEach(function(item){item.el.inert=item.before;});state.inert=[];
    if(global.TerrainOrbit)global.TerrainOrbit.resumeGPU();
    var map=engine();if(map&&map.resume)map.resume('field-room');
    if(state.focus&&state.focus.isConnected)state.focus.focus();
  }
  function showPhoto(index,initial) {
    if(!state.gallery.length)return;state.photo=(index+state.gallery.length)%state.gallery.length;
    var box=find('.f-lightbox'),p=state.gallery[state.photo];
    if(initial){state.photoFocus=document.activeElement;find('.f-body').inert=true;find('.f-bar').inert=true;if(global.FieldStadium)global.FieldStadium.cover(true);}
    box.hidden=false;box.querySelector('img').src=p.src;box.querySelector('img').alt=p.alt;box.querySelector('figcaption').textContent=p.alt;
    find('[data-f-photo-count]').textContent=(state.photo+1)+' / '+state.gallery.length;
    if(initial)find('[data-f-action="photo-close"]').focus();
  }
  function closePhoto() {
    find('.f-lightbox').hidden=true;find('.f-lightbox img').removeAttribute('src');find('.f-body').inert=false;find('.f-bar').inert=false;
    if(global.FieldStadium)global.FieldStadium.cover(false);
    if(state.photoFocus&&state.photoFocus.isConnected)state.photoFocus.focus();
  }
  function keydown(e) {
    if(!state.open)return;var viewing=!find('.f-lightbox').hidden;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(viewing)closePhoto();else if(state.section)overview();else close();return;}
    if(viewing&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();showPhoto(state.photo+(e.key==='ArrowLeft'?-1:1));}
    if(e.key==='Tab') {
      var scope=viewing?find('.f-lightbox'):state.shell;
      var buttons=Array.prototype.filter.call(scope.querySelectorAll('button, a[href], summary, [tabindex="0"]'),function(b){return !b.disabled&&!b.closest('[inert]')&&b.getClientRects().length;});
      var first=buttons[0],last=buttons[buttons.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  }
  global.FieldRoom={open:open,close:close,isOpen:function(){return state.open;}};
})(window);
