(function(global){
  'use strict';
  var host,renderer,scene,camera,mesh,geometry,material,observer,frame=0,last=0,open=false,loading=null,token=0,texture=null,textureJobs={};
  function textureData(id){
    if(!textureJobs[id])textureJobs[id]=new Promise(function(resolve,reject){
      var s=document.createElement('script');s.src='assets/media/field/pendant/texture-'+id+'.data.js?v=20261010-logo-wood-plane';
      s.onload=function(){var url=global.FIELD_PENDANT_TEXTURES[id];delete global.FIELD_PENDANT_TEXTURES[id];delete textureJobs[id];s.remove();resolve(url);};
      s.onerror=function(){delete textureJobs[id];s.remove();reject(Error('texture data'));};document.head.appendChild(s);
    });return textureJobs[id];
  }
  var variant='20',motion={yaw:Math.PI+.08,pitch:.08,distance:1.65,centerY:.51},target={yaw:Math.PI+.08,pitch:.08,distance:1.65,centerY:.51},media=global.matchMedia('(prefers-reduced-motion: reduce)');
  function data(){
    if(global.FIELD_PENDANT_DATA)return Promise.resolve(global.FIELD_PENDANT_DATA);
    if(!loading)loading=new Promise(function(resolve,reject){var script=document.createElement('script');script.src='assets/data/field.pendant.data.js?v=20261010-cad-engraving';script.onload=function(){resolve(global.FIELD_PENDANT_DATA);};script.onerror=function(){loading=null;script.remove();reject(Error('model data'));};document.head.appendChild(script);});
    return loading;
  }
  function array(base64,Type){var s=atob(base64),b=new Uint8Array(s.length);for(var i=0;i<s.length;i++)b[i]=s.charCodeAt(i);return new Type(b.buffer);}
  function stop(){if(frame)cancelAnimationFrame(frame);frame=0;last=0;}
  function request(){if(open&&renderer&&!document.hidden&&!frame)frame=requestAnimationFrame(tick);}
  function resize(){if(!renderer||!host)return;var c=host.querySelector('.f-pendant-view'),r=c.getBoundingClientRect();if(!r.width)return;renderer.setSize(r.width,r.height,false);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();request();}
  function paint(){
    var T=global.THREE,night=document.documentElement.classList.contains('m-theme-night');
    renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue('--color-paper-1').trim(),0);
    scene.getObjectByName('ambient').intensity=night?1.1:.95;request();
  }
  function tick(now){
    frame=0;if(!open||!renderer)return;var dt=last?Math.min(80,now-last):16;last=now;
    var rate=media.matches?1:1-Math.exp(-dt/90);
    motion.yaw+=Math.atan2(Math.sin(target.yaw-motion.yaw),Math.cos(target.yaw-motion.yaw))*rate;
    ['pitch','distance','centerY'].forEach(function(k){motion[k]+=(target[k]-motion[k])*rate;});
    var distance=motion.distance,centerY=motion.centerY;distance*=Math.max(1,.85/camera.aspect);
    camera.position.set(distance*Math.sin(motion.yaw)*Math.cos(motion.pitch),centerY+distance*Math.sin(motion.pitch),distance*Math.cos(motion.yaw)*Math.cos(motion.pitch));camera.lookAt(0,centerY,0);renderer.render(scene,camera);
    if(Math.abs(Math.atan2(Math.sin(target.yaw-motion.yaw),Math.cos(target.yaw-motion.yaw)))>.002||['pitch','distance','centerY'].some(function(k){return Math.abs(target[k]-motion[k])>.002;}))request();else last=0;
  }
  function choose(id){
    variant=id;var current=++token;
    host.querySelectorAll('[data-pendant-version]').forEach(function(b){b.setAttribute('aria-pressed',String(b.dataset.pendantVersion===id));});
    host.querySelector('[data-pendant-download]').href='assets/media/field/pendant/pendant-'+id+'.glb';
    host.querySelector('[data-pendant-download]').download='断棒挂件-CAD-'+id+'.glb';
    host.querySelector('.f-pendant-fallback').src='assets/media/field/pendant/front-'+id+'.svg';
    if(!renderer)return;
    host.dataset.loading='true';
    textureData(id).then(function(url){if(!open||current!==token)return;new global.THREE.TextureLoader().load(url,function(next){
      if(!open||current!==token){next.dispose();return;}
      next.flipY=false;next.encoding=global.THREE.sRGBEncoding;next.anisotropy=Math.min(4,renderer.capabilities.getMaxAnisotropy());
      var old=texture;texture=next;material.map=next;material.needsUpdate=true;if(old)old.dispose();host.dataset.loading='false';request();
    },undefined,function(){if(open&&current===token){host.dataset.loading='false';host.dataset.renderer='flat';}});}).catch(function(){if(open&&current===token){host.dataset.loading='false';host.dataset.renderer='flat';}});
  }
  async function mount(container){
    close();host=container;open=true;++token;
    host.addEventListener('click',function(e){
      var version=e.target.closest('[data-pendant-version]');if(version){choose(version.dataset.pendantVersion);return;}
    });
    choose(variant);
    try{
      var d=await data();if(!open||host!==container)return;
      var T=global.THREE;renderer=new T.WebGLRenderer({canvas:host.querySelector('canvas'),alpha:true,antialias:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(1.5,global.devicePixelRatio||1));renderer.outputEncoding=T.sRGBEncoding;
      scene=new T.Scene();camera=new T.PerspectiveCamera(36,1,.01,20);var ambient=new T.HemisphereLight(0xffffff,0x73604c,.95);ambient.name='ambient';scene.add(ambient);var light=new T.DirectionalLight(0xffffff,.75);light.position.set(-1,2,3);scene.add(light);var fill=new T.DirectionalLight(0xffffff,.4);fill.position.set(2,1,-3);scene.add(fill);
      geometry=new T.BufferGeometry();geometry.setAttribute('position',new T.BufferAttribute(array(d.positions,Float32Array),3));geometry.setAttribute('normal',new T.BufferAttribute(array(d.normals,Float32Array),3));geometry.setAttribute('uv',new T.BufferAttribute(array(d.uv,Float32Array),2));geometry.setIndex(new T.BufferAttribute(array(d.indices,Uint32Array),1));geometry.computeBoundingSphere();
      material=new T.MeshStandardMaterial({color:0xffffff,roughness:.85,metalness:0,side:T.DoubleSide});mesh=new T.Mesh(geometry,material);mesh.rotation.x=Math.PI/2;scene.add(mesh);
      host.dataset.renderer='3d';resize();paint();choose(variant);
      observer=new ResizeObserver(resize);observer.observe(host.querySelector('.f-pendant-view'));
      var canvas=host.querySelector('canvas'),drag=null;
      canvas.addEventListener('pointerdown',function(e){if(e.button!==0||!e.isPrimary||drag)return;e.preventDefault();drag={id:e.pointerId,x:e.clientX,y:e.clientY,yaw:target.yaw,pitch:target.pitch};canvas.setPointerCapture(e.pointerId);canvas.classList.add('is-dragging');});
      canvas.addEventListener('pointermove',function(e){if(!drag||e.pointerId!==drag.id)return;target.yaw=drag.yaw-(e.clientX-drag.x)*.008;target.pitch=Math.max(-1.45,Math.min(1.45,drag.pitch+(e.clientY-drag.y)*.006));request();});
      function release(e){if(!drag||e.pointerId!==drag.id)return;drag=null;canvas.classList.remove('is-dragging');if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);}
      canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);canvas.addEventListener('lostpointercapture',release);
      canvas.addEventListener('wheel',function(e){
        if(!open||host!==container||host.dataset.renderer!=='3d')return;
        e.preventDefault();var delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1);
        target.distance=Math.max(.38,Math.min(2.5,target.distance*Math.exp(Math.max(-240,Math.min(240,delta))*.0015)));
        target.centerY=.13+.38*Math.max(0,Math.min(1,(target.distance-.64)/1.01));request();
      },{passive:false});
      canvas.addEventListener('webglcontextlost',function(e){e.preventDefault();if(open&&host===container){stop();host.dataset.renderer='flat';}});
      canvas.addEventListener('webglcontextrestored',function(){if(open&&host===container){host.dataset.renderer='3d';resize();request();}});
    }catch(error){if(open&&host===container){host.dataset.renderer='flat';host.dataset.loading='false';}}
  }
  function close(){open=false;++token;stop();if(observer)observer.disconnect();observer=null;if(texture)texture.dispose();texture=null;if(geometry)geometry.dispose();if(material)material.dispose();if(renderer){renderer.dispose();renderer.forceContextLoss();}renderer=null;geometry=null;material=null;scene=null;mesh=null;host=null;}
  document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else request();});
  new MutationObserver(function(){if(open&&renderer)paint();}).observe(document.documentElement,{attributes:true,attributeFilter:['class']});
  media.addEventListener('change',request);
  global.FieldPendant={open:mount,close:close,inspect:function(){return {open:open,webgl:!!renderer,variant:variant,triangles:renderer?renderer.info.render.triangles:0,textures:renderer?renderer.info.memory.textures:0,running:!!frame,view:Object.assign({},motion),target:Object.assign({},target)};}};
})(window);
