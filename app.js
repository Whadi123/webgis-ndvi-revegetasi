import { fromUrl } from 'https://cdn.jsdelivr.net/npm/geotiff@3.0.5/+esm';
import proj4 from 'https://cdn.jsdelivr.net/npm/proj4@2.12.1/+esm';

const STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
const SIGN = 'https://planetarycomputer.microsoft.com/api/sas/v1/sign?href=';
const classes = [
  {name:'Nonvegetasi', min:-1, max:0, color:'#7f3b08'},
  {name:'Sangat rendah', min:0, max:.2, color:'#d8b365'},
  {name:'Rendah', min:.2, max:.4, color:'#f6e8a8'},
  {name:'Sedang', min:.4, max:.6, color:'#b8e186'},
  {name:'Tinggi', min:.6, max:.8, color:'#4dac26'},
  {name:'Sangat tinggi', min:.8, max:1.01, color:'#1b5e20'}
];
let aoi=null, aoiLayer=null, ndviLayer=null, lastResult=null;

const el=id=>document.getElementById(id);
const map=L.map('map',{zoomControl:false}).setView([-2.5,117],5);
L.control.zoom({position:'bottomright'}).addTo(map);
const osm=L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(map);
const esri=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{maxZoom:19,attribution:'Esri'});
L.control.layers({'OpenStreetMap':osm,'Citra satelit':esri},{},{position:'bottomleft'}).addTo(map);

const now=new Date(), before=new Date(); before.setDate(now.getDate()-30);
el('endDate').value=now.toISOString().slice(0,10); el('startDate').value=before.toISOString().slice(0,10);
el('cloudCover').oninput=e=>el('cloudOutput').value=e.target.value+'%';

['dragenter','dragover'].forEach(evt=>el('dropZone').addEventListener(evt,e=>{e.preventDefault();el('dropZone').classList.add('drag')}));
['dragleave','drop'].forEach(evt=>el('dropZone').addEventListener(evt,e=>{e.preventDefault();el('dropZone').classList.remove('drag')}));
el('dropZone').addEventListener('drop',e=>loadShape(e.dataTransfer.files[0]));
el('shpInput').addEventListener('change',e=>loadShape(e.target.files[0]));

async function loadShape(file){
  if(!file||!file.name.toLowerCase().endsWith('.zip')) return alert('Pilih berkas ZIP yang berisi komponen shapefile.');
  setStatus('Membaca shapefile…',true); el('fileName').textContent=file.name;
  try{
    const geo=await shp(await file.arrayBuffer());
    aoi=Array.isArray(geo)?{type:'FeatureCollection',features:geo.flatMap(g=>g.features)}:geo;
    if(!aoi.features?.length) throw new Error('Geometri tidak ditemukan.');
    const polys=aoi.features.filter(f=>['Polygon','MultiPolygon'].includes(f.geometry?.type));
    if(!polys.length) throw new Error('Shapefile harus berupa poligon.');
    aoi={type:'FeatureCollection',features:polys};
    if(aoiLayer) map.removeLayer(aoiLayer);
    aoiLayer=L.geoJSON(aoi,{style:{color:'#00f59b',weight:2,fillColor:'#00f59b',fillOpacity:.08}}).addTo(map);
    map.fitBounds(aoiLayer.getBounds(),{padding:[30,30]}); el('analyzeBtn').disabled=false;
    setStatus('Area siap dianalisis');
  }catch(err){console.error(err);setStatus('Gagal membaca shapefile');alert('Shapefile gagal dibaca: '+err.message)}
}

el('analyzeBtn').onclick=analyze;
el('fitBtn').onclick=()=>aoiLayer&&map.fitBounds(aoiLayer.getBounds(),{padding:[25,25]});
el('clearBtn').onclick=clearResult;
el('downloadBtn').onclick=downloadCSV;

async function analyze(){
  if(!aoi) return;
  const start=el('startDate').value,end=el('endDate').value,cloud=+el('cloudCover').value,size=+el('resolution').value;
  if(!start||!end||start>end) return alert('Periksa kembali rentang tanggal.');
  showProgress('Mencari citra terbaik','Menelusuri Sentinel-2 berdasarkan area, tanggal, dan tutupan awan.'); setStatus('Analisis berjalan…',true);
  try{
    const bbox=turf.bbox(aoi);
    const search=await fetch(`${STAC}/search`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({collections:['sentinel-2-l2a'],bbox,datetime:`${start}T00:00:00Z/${end}T23:59:59Z`,limit:50,query:{'eo:cloud_cover':{lte:cloud}},sortby:[{field:'properties.eo:cloud_cover',direction:'asc'}]})});
    if(!search.ok) throw new Error(`STAC HTTP ${search.status}`);
    const data=await search.json();
    if(!data.features?.length) throw new Error('Tidak ditemukan citra sesuai kriteria. Perbesar batas awan atau rentang tanggal.');
    const item=data.features[0], redAsset=item.assets.B04||item.assets.red, nirAsset=item.assets.B08||item.assets.nir;
    if(!redAsset||!nirAsset) throw new Error('Band B04/B08 tidak tersedia pada item citra.');
    showProgress('Mengunduh band spektral','Membaca potongan band merah dan inframerah dekat.');
    const [redUrl,nirUrl]=await Promise.all([sign(redAsset.href),sign(nirAsset.href)]);
    const [red,nir]=await Promise.all([readBand(redUrl,bbox,size),readBand(nirUrl,bbox,size)]);
    showProgress('Menghitung NDVI','Melakukan masking poligon, klasifikasi, dan statistik.');
    const result=buildNdvi(red,nir,bbox,aoi,size,item);
    renderNdvi(result,bbox); updateResults(result,item); lastResult=result;
    setStatus('Analisis selesai');
  }catch(err){console.error(err);setStatus('Analisis gagal');alert('Analisis tidak dapat diselesaikan. '+err.message+'\n\nCatatan: koneksi internet, CORS penyedia data, dan luas AOI dapat memengaruhi proses.');}
  finally{hideProgress()}
}

async function sign(href){
  const r=await fetch(SIGN+encodeURIComponent(href)); if(!r.ok) throw new Error('Gagal menandatangani URL data.');
  const j=await r.json(); return j.href;
}
async function readBand(url,bbox,size){
  // Gunakan pembacaan pada level GeoTIFF, bukan image.readRasters().
  // Pada image.readRasters(), parameter bbox dapat diabaikan sehingga seluruh tile
  // Sentinel-2 (sekitar 10.980 x 10.980 piksel) dibaca dan browser tampak macet.
  const tiff=await fromUrl(url, {allowFullFile:false});
  const image=await tiff.getImage();
  const geoKeys=image.getGeoKeys();
  const epsg=Number(geoKeys.ProjectedCSTypeGeoKey || geoKeys.GeographicTypeGeoKey || 4326);
  const rasterBBox=transformBbox(bbox,epsg);
  const values=await tiff.readRasters({
    bbox:rasterBBox,
    width:size,
    height:size,
    resampleMethod:'bilinear',
    interleave:true
  });
  if(!values || values.length!==size*size) throw new Error('Potongan raster tidak dapat dibaca dengan ukuran yang diminta.');
  return values;
}
function transformBbox(bbox,epsg){
  if(epsg===4326) return bbox;
  let def;
  if(epsg>=32601&&epsg<=32660){
    def=`+proj=utm +zone=${epsg-32600} +datum=WGS84 +units=m +no_defs`;
  }else if(epsg>=32701&&epsg<=32760){
    def=`+proj=utm +zone=${epsg-32700} +south +datum=WGS84 +units=m +no_defs`;
  }else{
    throw new Error(`Proyeksi raster EPSG:${epsg} belum didukung.`);
  }
  const corners=[
    [bbox[0],bbox[1]],[bbox[0],bbox[3]],
    [bbox[2],bbox[1]],[bbox[2],bbox[3]]
  ].map(pt=>proj4('EPSG:4326',def,pt));
  const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
  return [Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)];
}
function buildNdvi(red,nir,bbox,geo,size,item){
  const canvas=document.createElement('canvas'); canvas.width=size;canvas.height=size;const ctx=canvas.getContext('2d'),img=ctx.createImageData(size,size);
  const vals=[],counts=Array(classes.length).fill(0); const [minX,minY,maxX,maxY]=bbox;
  for(let y=0;y<size;y++) for(let x=0;x<size;x++){
    const i=y*size+x, lon=minX+(x+.5)/size*(maxX-minX), lat=maxY-(y+.5)/size*(maxY-minY), p=turf.point([lon,lat]);
    const inside=geo.features.some(f=>turf.booleanPointInPolygon(p,f));
    const px=i*4; if(!inside){img.data[px+3]=0;continue}
    const r=red[i],n=nir[i],v=(n+r)===0?NaN:(n-r)/(n+r);
    if(!Number.isFinite(v)){img.data[px+3]=0;continue}
    vals.push(v); const ci=classes.findIndex(c=>v>=c.min&&v<c.max), c=classes[Math.max(0,ci)]; counts[Math.max(0,ci)]++;
    const rgb=hexToRgb(c.color);img.data[px]=rgb[0];img.data[px+1]=rgb[1];img.data[px+2]=rgb[2];img.data[px+3]=205;
  }
  if(!vals.length) throw new Error('Tidak ada piksel valid di dalam poligon.');
  ctx.putImageData(img,0,0); const mean=vals.reduce((a,b)=>a+b,0)/vals.length;
  return {dataUrl:canvas.toDataURL('image/png'),mean,min:Math.min(...vals),max:Math.max(...vals),counts,total:vals.length,healthy:vals.filter(v=>v>=.4).length/vals.length*100,itemDate:item.properties.datetime,cloud:item.properties['eo:cloud_cover'],itemId:item.id};
}
function renderNdvi(result,bbox){if(ndviLayer)map.removeLayer(ndviLayer);ndviLayer=L.imageOverlay(result.dataUrl,[[bbox[1],bbox[0]],[bbox[3],bbox[2]]],{opacity:.86,interactive:false}).addTo(map);aoiLayer.bringToFront()}
function updateResults(r,item){
  el('sceneTitle').textContent=`Sentinel-2 · ${new Date(r.itemDate).toLocaleDateString('id-ID')} · awan ${Number(r.cloud).toFixed(1)}%`;
  el('meanNdvi').textContent=r.mean.toFixed(3);el('minNdvi').textContent=r.min.toFixed(3);el('maxNdvi').textContent=r.max.toFixed(3);el('healthyCover').textContent=r.healthy.toFixed(1)+'%';
  el('meanClass').textContent='Kelas '+(classes.find(c=>r.mean>=c.min&&r.mean<c.max)?.name||'—');
  el('classTable').innerHTML=classes.map((c,i)=>`<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c.color};margin-right:7px"></span>${c.name}</td><td>${rangeLabel(c)}</td><td>${r.counts[i].toLocaleString('id-ID')}</td><td>${(r.counts[i]/r.total*100).toFixed(1)}%</td></tr>`).join(''); el('downloadBtn').disabled=false;
}
function rangeLabel(c){if(c.min===-1)return '&lt; 0,00';if(c.max>1)return '&gt; 0,80';return `${c.min.toFixed(2).replace('.',',')}–${c.max.toFixed(2).replace('.',',')}`}
function downloadCSV(){if(!lastResult)return;const r=lastResult,rows=[['Parameter','Nilai'],['Item Sentinel-2',r.itemId],['Tanggal citra',r.itemDate],['Tutupan awan (%)',r.cloud],['NDVI rata-rata',r.mean],['NDVI minimum',r.min],['NDVI maksimum',r.max],['Tutupan NDVI >= 0.40 (%)',r.healthy],[],['Kelas','Piksel','Proporsi (%)'],...classes.map((c,i)=>[c.name,r.counts[i],r.counts[i]/r.total*100])];const csv=rows.map(row=>row.map(v=>`"${v??''}"`).join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download=`hasil-ndvi-${new Date(r.itemDate).toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(a.href)}
function clearResult(){if(ndviLayer){map.removeLayer(ndviLayer);ndviLayer=null}lastResult=null;el('downloadBtn').disabled=true;el('sceneTitle').textContent='Belum ada analisis';['meanNdvi','minNdvi','maxNdvi','healthyCover'].forEach(id=>el(id).textContent='—');el('meanClass').textContent='Menunggu data';el('classTable').innerHTML='<tr><td colspan="4" class="empty">Unggah shapefile dan jalankan analisis.</td></tr>'}
function showProgress(title,text){el('progressTitle').textContent=title;el('progressText').textContent=text;el('progressCard').classList.remove('hidden');el('analyzeBtn').disabled=true}
function hideProgress(){el('progressCard').classList.add('hidden');el('analyzeBtn').disabled=!aoi}
function setStatus(text,busy=false){el('appStatus').innerHTML=`<span style="${busy?'background:#ffd166':''}"></span> ${text}`}
function hexToRgb(h){const n=parseInt(h.slice(1),16);return[(n>>16)&255,(n>>8)&255,n&255]}
