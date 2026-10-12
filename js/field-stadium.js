/* CAD footprint is authoritative; all vertical dimensions are illustrative. */
(function(global){
  'use strict';
  var T,host,nav,canvas,renderer,scene,camera,model,frame=0,last=0,opened=false,lost=false,section=null,covered=false;
  var width=0,height=0,theme='',observer,media=global.matchMedia('(prefers-reduced-motion: reduce)');
  var materials={},batches={},anchors={},buttons=[],leaders=[],railPoints=[],tierCount=0;
  var motion={yaw:.22,pitch:.7,distance:68,x:0,y:.6,z:0};
  var target={yaw:.22,pitch:.7,distance:58,x:0,y:.6,z:0};
  var spots={journey:[400,518,0],teams:[470,450,0],games:[400,175,0],club:[292,520,3],records:[662,315,0],pendant:[218,620,0]};
  var offsets={journey:[0,48],teams:[100,14],games:[0,-35],club:[-96,20],records:[102,-16],pendant:[-70,64]};
  function css(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
  function world(p,y){return new T.Vector3((p[0]-400)/20,y||0,(p[1]-370.4413)/20);}
  function material(key,color,line){
    var m=line?new T.LineBasicMaterial({color:color,transparent:true,opacity:key==='edge'?.52:.8}):new T.MeshLambertMaterial({color:color,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});
    m.color.convertSRGBToLinear();return materials[key]=m;
  }
  function append(key,geometry,wire){
    var g=geometry.index?geometry.toNonIndexed():geometry,position=g.getAttribute('position'),normal=g.getAttribute('normal');
    if(!batches[key])batches[key]={positions:[],normals:[]};
    for(var i=0;i<position.array.length;i++)batches[key].positions.push(position.array[i]);
    if(normal)for(var j=0;j<normal.array.length;j++)batches[key].normals.push(normal.array[j]);
    if(wire){var edges=new T.EdgesGeometry(geometry,28);append('edge',edges,false);edges.dispose();}
    if(g!==geometry)g.dispose();geometry.dispose();
  }
  function slab(points,bottom,depth,key,wire){
    if(points.length<3)return;
    var shape=new T.Shape();points.forEach(function(p,i){var x=(p[0]-400)/20,y=-(p[1]-370.4413)/20;if(i===0)shape.moveTo(x,y);else shape.lineTo(x,y);});shape.closePath();
    var geometry=new T.ExtrudeGeometry(shape,{depth:depth,bevelEnabled:false,curveSegments:1,steps:1});
    geometry.rotateX(-Math.PI/2);geometry.translate(0,bottom,0);append(key,geometry,wire);
  }
  function line(points,key){
    if(!batches[key])batches[key]={positions:[],normals:[]};var a=batches[key].positions;
    for(var i=1;i<points.length;i++)a.push(points[i-1].x,points[i-1].y,points[i-1].z,points[i].x,points[i].y,points[i].z);
  }
  function clip(points,n,threshold,keepAbove){
    var out=[];points.forEach(function(p,i){var q=points[(i+1)%points.length],a=(p[0]-400)*n[0]+(p[1]-370.4413)*n[1]-threshold,b=(q[0]-400)*n[0]+(q[1]-370.4413)*n[1]-threshold;
      var pa=keepAbove?a>=-1e-6:a<=1e-6,pb=keepAbove?b>=-1e-6:b<=1e-6;
      if(pa)out.push(p);if(pa!==pb){var t=a/(a-b);out.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t]);}
    });return out;
  }
  function buildModel(){
    model=new T.Group();scene.add(model);batches={};tierCount=0;
    material('base',css('--color-paper-3'));material('grass',css('--ambient-surface'));material('infield',css('--color-accent-wash'));
    material('stands',css('--color-paper-2'));material('platform',css('--color-paper-3'));material('cad',css('--color-accent'),true);material('edge',css('--contour-color'),true);material('rail',css('--color-accent'),true);
    // A low plinth supports the complete drawing. Surface uses recovered CAD faces.
    var circle=[];for(var i=0;i<144;i++){var angle=i*Math.PI*2/144;circle.push([400+333*Math.cos(angle),370.4413+333*Math.sin(angle)]);}slab(circle,-.9,.86,'base',true);
    var faces=global.FIELD_CAD_DATA.faces||[];
    var grass=faces.filter(function(f){return f.area>50000&&f.center[1]>220;}).sort(function(a,b){return b.area-a.area;})[0];
    if(grass)slab(grass.points,-.035,.07,'grass',false);
    var infield=faces.filter(function(f){return f.area>10000&&f.area<24000&&f.center[1]>380&&Math.abs(f.center[0]-400)<5;})[0];
    if(infield)slab(infield.points,.04,.06,'infield',false);
    faces.forEach(function(f){
      var dx=f.center[0]-400,dz=f.center[1]-370.4413,r=Math.hypot(dx,dz);
      if(f.area<45||f.area>8500||f.center[1]<350||r<173)return;
      if(r>280){slab(f.points,0,.65,'platform',true);return;}
      var n=[dx/r,dz/r],values=f.points.map(function(p){return (p[0]-400)*n[0]+(p[1]-370.4413)*n[1];}),lo=Math.min.apply(null,values),hi=Math.max.apply(null,values);
      if(hi-lo<4)return;
      // Slice each real seating bay across its outward direction. Aisles stay open.
      var steps=Math.max(3,Math.min(12,Math.ceil((hi-lo)/4.8)));
      for(var j=0;j<steps;j++){var footprint=clip(clip(f.points,n,lo+(hi-lo)*j/steps,true),n,lo+(hi-lo)*(j+1)/steps,false);if(footprint.length>=3){slab(footprint,0,.38+(j+1)*.22,'stands',true);tierCount++;}}
    });
    global.FIELD_CAD_DATA.paths.forEach(function(path){line(path.points.map(function(p){return world(p,.135);}), 'cad');});
    // The outfield fence follows the actual CAD inner boundary, not a new arc.
    var fence=global.FIELD_CAD_DATA.paths.filter(function(p){return p.type==='ARC'&&p.points.length>30&&p.points.every(function(v){var r=Math.hypot(v[0]-400,v[1]-370.4413);return r>265&&r<272&&v[1]<302;});}).sort(function(a,b){return b.points.length-a.points.length;})[0];
    if(fence){railPoints=fence.points;[.25,1.3].forEach(function(y){line(fence.points.map(function(p){return world(p,y);}), 'rail');});for(var k=0;k<fence.points.length;k+=Math.max(1,Math.floor(fence.points.length/40)))line([world(fence.points[k],.05),world(fence.points[k],1.3)],'rail');}
    // Pitcher's mound follows the circular CAD region; vertical rise is illustrative.
    var mound=faces.find(function(f){return f.area>150&&f.area<600&&Math.abs(f.center[0]-400)<2&&Math.abs(f.center[1]-453.44)<2;});
    if(mound)slab(mound.points,.1,.2,'infield',true);
    Object.keys(batches).forEach(function(key){var batch=batches[key],g=new T.BufferGeometry();g.setAttribute('position',new T.Float32BufferAttribute(batch.positions,3));if(batch.normals.length)g.setAttribute('normal',new T.Float32BufferAttribute(batch.normals,3));var object=batch.normals.length?new T.Mesh(g,materials[key]):new T.LineSegments(g,materials[key]);object.name=key;model.add(object);});
    Object.keys(spots).forEach(function(id){anchors[id]=world(spots[id],spots[id][2]);});
    batches={};
  }
  function palette(){
    if(!renderer)return;
    var next=document.documentElement.classList.contains('m-theme-night')?'night':'day';if(next===theme)return;theme=next;
    var keys={base:'--color-paper-3',grass:'--ambient-surface',infield:'--color-accent-wash',stands:'--color-paper-2',platform:'--color-paper-3',cad:'--color-accent',edge:'--contour-color',rail:'--color-accent'};
    Object.keys(keys).forEach(function(k){materials[k].color.set(css(keys[k])).convertSRGBToLinear();});renderer.setClearColor(css('--color-paper-1'),0);request();
  }
  function create(container){
    T=global.THREE;host=container;nav=host.querySelector('.f-diamond nav');canvas=host.querySelector('.f-stadium-canvas');buttons=Array.prototype.slice.call(nav.querySelectorAll('button'));
    if(!T||!global.FIELD_CAD_DATA.paths)return false;
    try{
      if(!renderer){
        renderer=new T.WebGLRenderer({canvas:canvas,antialias:true,alpha:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(global.devicePixelRatio||1,1.5));renderer.outputEncoding=T.sRGBEncoding;
        scene=new T.Scene();camera=new T.PerspectiveCamera(38,1,.1,180);
        scene.add(new T.HemisphereLight(0xffffff,0x5d6d51,.85));var sun=new T.DirectionalLight(0xffffff,.6);sun.position.set(-20,38,28);scene.add(sun);
        buildModel();
        var svg=host.querySelector('.f-stadium-leaders');buttons.forEach(function(b){var l=document.createElementNS('http://www.w3.org/2000/svg','line');l.dataset.section=b.dataset.fSection;svg.appendChild(l);leaders.push(l);});
        canvas.addEventListener('webglcontextlost',function(e){e.preventDefault();lost=true;stop();host.dataset.renderer='flat';nav.style.removeProperty('visibility');buttons.forEach(function(b){b.style.removeProperty('left');b.style.removeProperty('top');});});
        canvas.addEventListener('webglcontextrestored',function(){lost=false;if(opened){host.dataset.renderer='3d';resize();request();}});
        observer=new MutationObserver(palette);observer.observe(document.documentElement,{attributes:true,attributeFilter:['class']});
        global.addEventListener('resize',function(){if(opened){resize();request();}});
        document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else request();});
        media.addEventListener('change',request);
        buttons.forEach(function(b){b.addEventListener('pointerenter',function(){host.dataset.hover='true';});b.addEventListener('pointerleave',function(){host.dataset.hover='false';request();});});
        nav.addEventListener('focusin',function(){host.dataset.hover='true';});nav.addEventListener('focusout',function(){host.dataset.hover='false';request();});
      }
      if(lost){host.dataset.renderer='flat';return false;}
      host.dataset.renderer='3d';palette();return true;
    }catch(error){host.dataset.renderer='flat';if(renderer){renderer.dispose();renderer=null;}return false;}
  }
  function resize(){
    if(!renderer||lost)return;var r=host.getBoundingClientRect(),changed=Math.abs(width-r.width)>1||Math.abs(height-r.height)>1,first=!width;
    width=Math.max(1,r.width);height=Math.max(1,r.height);renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();
    // Fit the entire stadium when a narrow viewport replaces the desktop view.
    var fit=width<700?17.8/Math.sin(Math.atan(Math.tan(19*Math.PI/180)*camera.aspect))*1.24:58;
    target.distance=section?(width<700?fit*.8:45):fit;
    if(changed)motion.distance=target.distance*(first?1.15:1);
  }
  function cameraPosition(){
    camera.position.set(motion.x+motion.distance*Math.sin(motion.yaw)*Math.cos(motion.pitch),motion.y+motion.distance*Math.sin(motion.pitch),motion.z+motion.distance*Math.cos(motion.yaw)*Math.cos(motion.pitch));
    camera.lookAt(motion.x,motion.y,motion.z);camera.updateMatrixWorld();
  }
  function placeLabels(){
    var rects=[];
    buttons.forEach(function(b,i){var id=b.dataset.fSection,v=anchors[id].clone().project(camera),ax=(v.x+1)*width/2,ay=(1-v.y)*height/2,o=offsets[id],scale=width<700?.36:1;
      var x=ax+o[0]*scale,y=ay+o[1]*scale,bw=b.offsetWidth,bh=b.offsetHeight;
      var minX=bw/2+12,maxX=width-bw/2-12,minY=Math.max(bh/2+10,height*(width<700?.32:.13)),maxY=height-60-bh/2;
      x=Math.max(minX,Math.min(maxX,x));y=Math.max(minY,Math.min(maxY,y));
      // Search free slots rather than bouncing between two occupied labels.
      // Keep the closest available slot to the projected CAD anchor.
      var xs=[x,minX,maxX],ys=[y,minY,maxY],best=null;
      rects.forEach(function(r){ys.push(r.y-(bh+r.h)/2-9,r.y+(bh+r.h)/2+9);});
      xs.forEach(function(cx){ys.forEach(function(cy){
        if(cy<minY||cy>maxY)return;
        if(rects.some(function(r){return Math.abs(cx-r.x)<(bw+r.w)/2+8&&Math.abs(cy-r.y)<(bh+r.h)/2+8;}))return;
        var score=(cx-x)*(cx-x)+(cy-y)*(cy-y);if(!best||score<best.score)best={x:cx,y:cy,score:score};
      });});
      if(best){x=best.x;y=best.y;}
      rects.push({x:x,y:y,w:bw,h:bh});b.style.left=x+'px';b.style.top=y+'px';
      var l=leaders[i];l.setAttribute('x1',ax);l.setAttribute('y1',ay);l.setAttribute('x2',x);l.setAttribute('y2',y);
    });
  }
  function stop(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;}
  function request(){if(opened&&!lost&&!covered&&!document.hidden&&!frame&&renderer)frame=requestAnimationFrame(tick);}
  function tick(now){
    frame=0;if(!opened||lost||covered||document.hidden)return;
    var dt=last?Math.min(80,now-last):16;last=now;var M=global.CameraMotion;
    var spin=!section&&!media.matches&&host.dataset.hover!=='true';if(spin)target.yaw+=M.spin(dt);
    ['pitch','distance','x','y','z'].forEach(function(k){motion[k]=media.matches?target[k]:M.damp(motion[k],target[k],dt);});motion.yaw=media.matches?target.yaw:M.angle(motion.yaw,target.yaw,dt);
    cameraPosition();renderer.render(scene,camera);if(!section)placeLabels();
    var moving=Object.keys(target).some(function(k){var d=target[k]-motion[k];return Math.abs(k==='yaw'?Math.atan2(Math.sin(d),Math.cos(d)):d)>.002;});
    if(spin||moving)request();else last=0;
  }
  function open(container){
    opened=true;section=null;covered=false;
    if(!create(container))return false;
    motion={yaw:.22,pitch:.85,distance:80,x:0,y:.6,z:0};target={yaw:.22,pitch:.7,distance:58,x:0,y:.6,z:0};
    resize();cameraPosition();placeLabels();request();return true;
  }
  function focus(id){
    section=id;if(!renderer)return;var p=anchors[id];if(!p)return;
    target.x=p.x*.62;target.y=.9;target.z=p.z*.62;target.pitch=.5;target.yaw={journey:.1,teams:-.48,games:.25,club:.48,records:-.65,pendant:.4}[id];resize();request();
  }
  function overview(){section=null;if(!renderer)return;target.x=0;target.y=.6;target.z=0;target.pitch=.7;resize();request();}
  function cover(value){covered=value;if(value)stop();else request();}
  function close(){opened=false;stop();if(!renderer)return;model.traverse(function(o){if(o.geometry)o.geometry.dispose();});Object.keys(materials).forEach(function(k){materials[k].dispose();});renderer.renderLists.dispose();renderer.setSize(1,1,false);}
  function inspect(){return {webgl:!!renderer&&!lost,open:opened,contextLost:lost,running:!!frame,section:section,theme:theme,cadPaths:global.FIELD_CAD_DATA.paths.length,tiers:tierCount,geometries:renderer?renderer.info.memory.geometries:0,drawCalls:renderer?renderer.info.render.calls:0,triangles:renderer?renderer.info.render.triangles:0,camera:motion,glError:renderer&&!lost?renderer.getContext().getError():null};}
  global.FieldStadium={open:open,close:close,focus:focus,overview:overview,cover:cover,inspect:inspect};
})(window);
