'use strict';
(()=>{
 let source=null,sourceImage=null,output=null,outputImage=null,strokes=[],drawing=null,busy=false,showAfter=false,epoch=0;
 const surface=$('retouch-canvas'),paint=surface.getContext('2d');
 function status(text){$('retouch-status').textContent=text;}
 function controls(){
  $('retouch-auto').disabled=busy||!sourceImage;
  $('retouch-run').disabled=busy||!sourceImage||!strokes.length;
  $('retouch-save').disabled=busy||!output;
  $('retouch-before').disabled=busy||!sourceImage;
  $('retouch-after').disabled=busy||!outputImage;
  $('retouch-undo').disabled=busy||!strokes.length;
  $('retouch-clear').disabled=busy||!strokes.length;
  for(const id of ['retouch-import','retouch-choose','retouch-tool','retouch-brush','retouch-method','retouch-margin'])$(id).disabled=busy;
  $('retouch-after').classList.toggle('active',showAfter);
  $('retouch-before').classList.toggle('active',!showAfter);
 }
 function draw(){
  if(!sourceImage)return;
  paint.clearRect(0,0,surface.width,surface.height);
  paint.drawImage(showAfter&&outputImage?outputImage:sourceImage,0,0,surface.width,surface.height);
  if(!showAfter&&$('retouch-show-mask').checked){paint.save();paint.fillStyle='rgba(255,113,89,.5)';paint.strokeStyle='rgba(255,113,89,.65)';paint.lineCap='round';paint.lineJoin='round';
   for(const s of strokes){const pts=s.points.map(([x,y])=>[x*surface.width,y*surface.height]);if(s.kind==='rect'){const a=pts[0],b=pts[1]||a;paint.fillRect(Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));}else{paint.lineWidth=s.radius*surface.width*2;paint.beginPath();paint.moveTo(...pts[0]);for(const p of pts.slice(1))paint.lineTo(...p);paint.stroke();paint.beginPath();paint.arc(...pts[0],s.radius*surface.width,0,Math.PI*2);paint.fill();}}
   paint.restore();
  }
 }
 function fit(){if(!sourceImage||!$('page-retouch').classList.contains('active'))return;const box=$('retouch-workspace');const width=Math.max(80,Math.min(box.clientWidth-32,(box.clientHeight-32)*surface.width/surface.height))*Number($('retouch-zoom').value);surface.style.width=width+'px';surface.style.height=width*surface.height/surface.width+'px';draw();}
 function invalidate(){output=null;outputImage=null;showAfter=false;controls();draw();}
 function loadImage(url){return new Promise((resolve,reject)=>{const im=new Image();im.onload=()=>resolve(im);im.onerror=()=>reject(Error('Không đọc được ảnh.'));im.src=url;});}
 window.openRetouch=async id=>{
  if(busy)throw Error('Đang xử lý ảnh; vui lòng chờ hoàn tất.');
  const asset=assetById(id);if(!asset)throw Error('Không tìm thấy ảnh nguồn.');
  const ticket=++epoch;source=null;sourceImage=null;strokes=[];drawing=null;invalidate();setPage('retouch');surface.hidden=true;$('retouch-empty').hidden=false;status('Đang mở ảnh…');
  const im=await loadImage('/media/'+asset.id);if(ticket!==epoch)return;
  source=asset;sourceImage=im;const scale=Math.min(1,1600/im.naturalWidth,1600/im.naturalHeight);surface.width=Math.round(im.naturalWidth*scale);surface.height=Math.round(im.naturalHeight*scale);surface.hidden=false;$('retouch-empty').hidden=true;$('retouch-name').textContent=asset.name;$('retouch-zoom').value='1';status(`${asset.width} × ${asset.height} px · Bấm Xóa tự động để nhận diện logo góc ảnh`);controls();requestAnimationFrame(fit);
 };
 function point(e){const r=surface.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))];}
 surface.addEventListener('pointerdown',e=>{if(busy||!sourceImage||e.button!==0)return;if(strokes.length>=100){toast('Tối đa 100 nét tô. Hãy lưu rồi xử lý tiếp.');return;}e.preventDefault();$('retouch-show-mask').checked=true;invalidate();const p=point(e);drawing={kind:$('retouch-tool').value,points:[p],radius:Math.min(.1,Number($('retouch-brush').value)/2/surface.getBoundingClientRect().width)};strokes.push(drawing);surface.setPointerCapture(e.pointerId);controls();draw();});
 surface.addEventListener('pointermove',e=>{if(!drawing)return;const p=point(e);if(drawing.kind==='rect')drawing.points[1]=p;else if(drawing.points.length<4000)drawing.points.push(p);draw();});
 function end(e){if(!drawing)return;if(drawing.kind==='rect'&&drawing.points.length===1)strokes.pop();drawing=null;if(surface.hasPointerCapture(e.pointerId))surface.releasePointerCapture(e.pointerId);controls();draw();status(`${strokes.length} vùng/nét đã chọn · Sẵn sàng xem trước`);}
 surface.addEventListener('pointerup',end);
 surface.addEventListener('pointercancel',e=>{if(drawing){strokes.pop();drawing=null;controls();draw();}});
 on('retouch-undo','click',()=>{strokes.pop();invalidate();});on('retouch-clear','click',()=>{strokes=[];invalidate();});
 on('retouch-method','change',invalidate);on('retouch-margin','change',invalidate);
 on('retouch-show-mask','change',draw);
 on('retouch-before','click',()=>{$('retouch-show-mask').checked=false;showAfter=false;controls();draw();});on('retouch-after','click',()=>{showAfter=true;controls();draw();});
 on('retouch-zoom','change',fit);window.addEventListener('resize',fit);document.querySelector('[data-page=retouch]').addEventListener('click',()=>requestAnimationFrame(fit));
 on('retouch-import','click',()=>pick(async files=>{if(files.length!==1)throw Error('Chọn một ảnh để xóa logo.');const assets=await upload(files);await openRetouch(assets[0].id);}));
 on('retouch-choose','click',()=>{dialog('Chọn ảnh cần xóa logo',state.assets.length?'<div class="retouch-picker">'+state.assets.map(a=>`<button data-retouch-id="${esc(a.id)}"><img src="/thumb/${esc(a.id)}" alt="${esc(a.name)}" loading="lazy"><span>${esc(a.name)}</span></button>`).join('')+'</div>':'<p>Thư viện chưa có ảnh. Hãy nhập ảnh mới.</p>');$('dialog-body').onclick=e=>{const b=e.target.closest('[data-retouch-id]');if(!b)return;$('dialog').close();openRetouch(b.dataset.retouchId).catch(e=>toast(e.message));};});
 async function runRetouch(automatic=false){
  if(busy||!source||(!automatic&&!strokes.length))return;
  if(!state.logo_removal)throw Error('Hãy đóng và mở lại tool từ mã nguồn để dùng Xóa logo.');
  busy=true;invalidate();status('Đang xóa logo và khôi phục vùng nền…');
  try{const result=await api('/api/retouch',{id:source.id,strokes,automatic,method:$('retouch-method').value,margin:Number($('retouch-margin').value)});const im=await loadImage('data:image/png;base64,'+result.data);output=result;outputImage=im;showAfter=true;status(`${result.width} × ${result.height} px · Kiểm tra kết quả trước khi lưu`);draw();}
  catch(e){$('retouch-manual').open=true;status('Chưa có kết quả: '+e.message);throw e;}
  finally{busy=false;controls();}
 }
 on('retouch-run','click',()=>runRetouch(false));
 on('retouch-auto','click',()=>runRetouch(true));
 on('retouch-save','click',async()=>{if(busy||!output)return;busy=true;controls();try{await api('/api/export',{name:source.name.replace(/\.(png|jpe?g|webp)$/i,'')+' · Xóa logo',data:output.data});await refresh();output=null;status('Đã lưu ảnh mới vào thư viện. Ảnh gốc vẫn được giữ nguyên.');toast('Đã lưu ảnh xóa logo.');}finally{busy=false;controls();}});
 controls();
})();
