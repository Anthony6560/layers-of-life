(function (global) {
  'use strict';
  var state = { shell:null, open:false, category:'light', year:'all', rows:[], post:null, photo:null, focus:null, photoFocus:null, inert:[] };
  var titles = {light:'光影',taste:'味道'};
  function esc(value) { return String(value == null ? '' : value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function group(category) { return global.MOMENTS_DATA && global.MOMENTS_DATA.groups[category] || []; }
  function paragraphs(rows) {
    return (rows || []).filter(function(text){return text.trim()&&!/^[（(]?\s*无文字\s*[）)]?$/.test(text.trim());}).map(function(text) {
      var output='',offset=0,pattern=/https?:\/\/[^\s<>]+/g,match;
      while((match=pattern.exec(text))){output+=esc(text.slice(offset,match.index))+'<a href="'+esc(match[0])+'" target="_blank" rel="noopener noreferrer">'+esc(match[0])+'</a>';offset=match.index+match[0].length;}
      return '<p>'+output+esc(text.slice(offset))+'</p>';
    }).join('');
  }
  function years(rows) { return rows.map(function(r){return r.date.slice(0,4);}).filter(function(y,i,a){return a.indexOf(y)===i;}).sort().reverse(); }
  function filters(rows,year,attribute) {
    return ['all'].concat(years(rows)).map(function(y){return '<button type="button" '+attribute+'="'+y+'" aria-pressed="'+(y===year)+'">'+(y==='all'?'全部':y)+'</button>';}).join('');
  }
  function imageMarkup(img,alt,cls) {
    return '<img'+(cls?' class="'+cls+'"':'')+' src="'+esc(img.thumb||img.src)+'" width="'+img.width+'" height="'+img.height+'" alt="'+esc(alt)+'" loading="lazy" decoding="async">';
  }
  function find(selector) { return state.shell.querySelector(selector); }
  function mapEngine() { return global.Scene && global.Scene._ && global.Scene._.MapEngine; }
  function mount() {
    if(state.shell)return;
    document.body.insertAdjacentHTML('beforeend','<section id="moments-room" data-state="closed" role="dialog" aria-modal="true" aria-labelledby="moments-room-title" aria-hidden="true">'+
      '<header class="p-bar"><button type="button" data-p-action="close">返回</button><h2 id="moments-room-title"></h2></header>'+
      '<div class="p-body"><header class="p-heading"><span data-p-english></span><h3 data-p-title></h3><p data-p-lead></p></header><div class="p-tools"><nav class="p-years" aria-label="按年份浏览" data-p-years></nav></div><div class="p-collection" data-p-collection></div></div>'+
      '<section class="p-lightbox" role="dialog" aria-modal="true" aria-label="照片浏览" hidden><header><span data-p-photo-count></span><button type="button" data-p-action="photo-close">关闭 ×</button></header><button type="button" data-p-action="photo-prev" aria-label="上一张照片">←</button><figure><img alt=""><figcaption></figcaption></figure><button type="button" data-p-action="photo-next" aria-label="下一张照片">→</button></section></section>');
    state.shell=document.getElementById('moments-room');
    if(global.PhotoGestures)global.PhotoGestures.attach(find('.p-lightbox img'),{previous:function(){showPhoto(state.photo-1);},next:function(){showPhoto(state.photo+1);}});
    state.shell.addEventListener('click',function(e){
      var year=e.target.closest('[data-p-year]');if(year){state.year=year.dataset.pYear;render();find('[data-p-year="'+state.year+'"]').focus();return;}
      var inline=e.target.closest('[data-p-inline-photo]');if(inline){
        state.post=state.rows.find(function(r){return r.id===inline.closest('[data-moment-id]').dataset.momentId;});
        state.photoFocus=document.activeElement;find('.p-body').inert=true;find('.p-bar').inert=true;
        showPhoto(Number(inline.dataset.pInlinePhoto));find('[data-p-action="photo-close"]').focus();return;
      }
      var action=e.target.closest('[data-p-action]');if(!action)return;
      switch(action.dataset.pAction){
        case 'close':close();break;
        case 'photo-close':closePhoto();break;case 'photo-prev':showPhoto(state.photo-1);break;case 'photo-next':showPhoto(state.photo+1);break;
      }
    });
    document.addEventListener('keydown',keydown);
  }
  function render() {
    var rows=group(state.category);state.rows=rows.filter(function(r){return state.year==='all'||r.date.slice(0,4)===state.year;});
    find('[data-p-years]').innerHTML=filters(rows,state.year,'data-p-year');
    find('[data-p-collection]').innerHTML=state.rows.map(function(post){
      var text=paragraphs(post.paragraphs);
      return '<article class="p-moment" data-moment-id="'+post.id+'"><header class="p-moment-meta"><time datetime="'+post.date.replace(' ','T')+'+08:00">'+post.date.slice(0,10).replace(/-/g,'.')+'</time>'+
        (post.location?'<span class="p-location" aria-label="位置：'+esc(post.location)+'">'+esc(post.location)+'</span>':'')+'</header>'+
        (text?'<div class="p-post-text">'+text+'</div>':'')+(post.images.length?'<div class="p-post-images" data-images="'+post.images.length+'">'+post.images.map(function(img,i){return '<button type="button" data-p-inline-photo="'+i+'" aria-label="放大 '+post.date.slice(0,10)+' 的第 '+(i+1)+' 张照片">'+imageMarkup(img,post.date.slice(0,10)+' · 第 '+(i+1)+' 张')+'</button>';}).join('')+'</div>':'')+'</article>';
    }).join('');
  }
  function showPhoto(index) {
    var photos=state.post.images;if(!photos.length)return;
    state.photo=(index+photos.length)%photos.length;var img=photos[state.photo];
    find('.p-lightbox').hidden=false;find('.p-lightbox img').src=img.src;find('.p-lightbox img').alt=state.post.date.slice(0,10)+' · 第 '+(state.photo+1)+' 张';
    find('.p-lightbox figcaption').textContent=state.post.date.slice(0,10)+(state.post.location?' · '+state.post.location:'');
    find('[data-p-photo-count]').textContent=(state.photo+1)+' / '+photos.length;
    find('[data-p-action="photo-prev"]').disabled=photos.length<2;find('[data-p-action="photo-next"]').disabled=photos.length<2;
  }
  function closePhoto() {
    find('.p-lightbox').hidden=true;find('.p-lightbox img').removeAttribute('src');state.photo=null;
    find('.p-body').inert=false;find('.p-bar').inert=false;state.post=null;
    if(state.photoFocus&&state.photoFocus.isConnected)state.photoFocus.focus({preventScroll:true});
  }
  function open(category) {
    if(!titles[category])return;
    if(state.open)close();
    [global.FieldRoom,global.RhythmPlayer,global.SpaceCity].forEach(function(room){if(room&&room.isOpen())room.close();});
    mount();state.focus=document.activeElement;state.category=category;state.year='all';state.open=true;
    state.shell.dataset.category=category;state.shell.dataset.state='open';state.shell.setAttribute('aria-hidden','false');
    find('#moments-room-title').textContent=titles[category];find('[data-p-title]').textContent=titles[category];
    find('[data-p-english]').textContent=category==='light'?'LIGHT':'TASTE';
    find('[data-p-lead]').textContent=category==='light'?'照片，以及拍下它们时的几句话。':'做过的，吃过的，记得的。';
    render();find('.p-body').scrollTop=0;
    state.inert=Array.prototype.map.call(document.querySelectorAll('#app, .m-time-control'),function(el){var before=el.inert;el.inert=true;return {el:el,before:before};});
    var map=mapEngine();if(map&&map.suspend)map.suspend('moments-room');
    find('[data-p-action="close"]').focus();
  }
  function close() {
    if(!state.open)return;
    if(!find('.p-lightbox').hidden)closePhoto();
    state.open=false;state.shell.dataset.state='closed';state.shell.setAttribute('aria-hidden','true');
    // Release images rather than retaining a second, hidden photo collection.
    find('[data-p-collection]').textContent='';state.rows=[];
    state.inert.forEach(function(item){item.el.inert=item.before;});state.inert=[];
    var map=mapEngine();if(map&&map.resume)map.resume('moments-room');
    if(state.focus&&state.focus.isConnected)state.focus.focus({preventScroll:true});
  }
  function keydown(e) {
    if(!state.open)return;
    var photo=!find('.p-lightbox').hidden,scope=photo?find('.p-lightbox'):state.shell;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();if(photo)closePhoto();else close();return;}
    if(photo&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();showPhoto(state.photo+(e.key==='ArrowLeft'?-1:1));}
    if(e.key==='Tab'){
      var buttons=Array.prototype.filter.call(scope.querySelectorAll('button,a[href]'),function(el){return !el.disabled&&!el.closest('[inert]')&&el.getClientRects().length;});
      var first=buttons[0],last=buttons[buttons.length-1];
      if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
    }
  }
  global.MomentsContent={group:group,paragraphs:paragraphs,filters:filters,esc:esc};
  global.MomentsRoom={open:open,close:close,isOpen:function(){return state.open;}};
})(window);
