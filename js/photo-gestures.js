(function(global){
  'use strict';
  function attach(image,options){
    var pointers=new Map(),gesture=null,scale=1,x=0,y=0,pinched=false;
    image.draggable=false;
    function bounds(){
      var fit=Math.min(image.clientWidth/(image.naturalWidth||1),image.clientHeight/(image.naturalHeight||1));
      return {x:Math.max(0,((image.naturalWidth||1)*fit*scale-image.clientWidth)/2),y:Math.max(0,((image.naturalHeight||1)*fit*scale-image.clientHeight)/2)};
    }
    function paint(){
      var b=bounds();x=Math.max(-b.x,Math.min(b.x,x));y=Math.max(-b.y,Math.min(b.y,y));
      image.style.transform='translate('+x+'px,'+y+'px) scale('+scale+')';image.dataset.zoom=scale.toFixed(3);
    }
    function reset(){scale=1;x=y=0;gesture=null;pinched=false;pointers.clear();image.style.transform='';image.dataset.zoom='1';}
    function begin(){
      var p=Array.from(pointers.values());
      gesture=p.length>1?{gap:Math.max(1,Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)),scale:scale}:
        p.length?{startX:p[0].x,startY:p[0].y,x:x,y:y}:null;
      if(p.length>1)pinched=true;
    }
    image.addEventListener('pointerdown',function(e){
      if(e.pointerType==='mouse'||e.button!==0)return;
      e.preventDefault();if(!pointers.size)pinched=false;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});image.setPointerCapture(e.pointerId);begin();
    });
    image.addEventListener('pointermove',function(e){
      if(!pointers.has(e.pointerId)||!gesture)return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});var p=Array.from(pointers.values());
      if(p.length>1){scale=Math.max(1,Math.min(5,gesture.scale*Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y)/gesture.gap));paint();}
      else if(scale>1.01){x=gesture.x+p[0].x-gesture.startX;y=gesture.y+p[0].y-gesture.startY;paint();}
    });
    function release(e){
      if(!pointers.has(e.pointerId))return;
      var swipe=null;
      if(e.type==='pointerup'&&pointers.size===1&&!pinched&&scale<=1.01&&gesture){
        var dx=e.clientX-gesture.startX,dy=e.clientY-gesture.startY;
        if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.5)swipe=dx<0?options.next:options.previous;
      }
      pointers.delete(e.pointerId);begin();
      if(image.hasPointerCapture(e.pointerId))image.releasePointerCapture(e.pointerId);
      if(swipe)swipe();
    }
    image.addEventListener('pointerup',release);image.addEventListener('pointercancel',release);image.addEventListener('lostpointercapture',release);
    image.addEventListener('load',reset);
    new MutationObserver(reset).observe(image,{attributes:true,attributeFilter:['src']});
    new ResizeObserver(paint).observe(image);
    return {reset:reset};
  }
  global.PhotoGestures={attach:attach};
})(window);
