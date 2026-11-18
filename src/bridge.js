import { validateFile, validateDimensions } from './limits.js';
let worker,serial=0,stage='',active;
function getWorker(){return worker ||= new Worker(new URL('./worker.js',import.meta.url),{type:'module'});}
const json=x=>new Response(JSON.stringify(x),{headers:{'Content-Type':'application/json'}});
export async function localFetch(path,opts={}){
 const u=new URL(path,location.href);
 if(u.pathname==='/api/info')return json({device:'WebGPU',down:0.6,l0:0.001,output:'浏览器下载',gpu_note:navigator.gpu?'':'当前浏览器没有 WebGPU，请使用支持的浏览器，并通过 HTTPS 访问'});
 if(u.pathname==='/api/progress')return json({stage});
 if(u.pathname==='/api/segment')return new Promise((resolve,reject)=>{
  const w=new Worker(new URL('./segment-worker.js',import.meta.url),{type:'module'});
  w.onerror=e=>{w.terminate();reject(Error(e.message));};
  w.onmessage=({data:r})=>{w.terminate();if(r.error)reject(Error(r.error));else resolve(new Response(r.blob,{headers:{'X-Share':String(r.share)}}));};
  w.postMessage({blob:opts.body});
 });
 if(u.pathname==='/api/cancel'||u.pathname==='/api/quit'){if(active)active();return json({ok:true});}
 if(u.pathname==='/api/save')return json({file:'',dir:''});
 if(u.pathname==='/api/reveal')throw Error('请使用下载按钮保存结果');
 if(u.pathname==='/api/convert'){
  validateFile(opts.body.size);
  const im=await createImageBitmap(opts.body);
  try { validateDimensions(im.width,im.height); } catch(e) { im.close(); throw e; }
  const c=new OffscreenCanvas(im.width,im.height),g=c.getContext('2d');g.drawImage(im,0,0);im.close();return new Response(await c.convertToBlob({type:'image/png'}),{headers:{'X-Alpha':'1'}});
 }
 if(u.pathname==='/api/denoise')return new Promise((resolve,reject)=>{
  const id=++serial,w=getWorker();const cleanup=()=>{active=null;opts.signal?.removeEventListener('abort',abort);};
  const abort=()=>{w.terminate();worker=null;cleanup();reject(new DOMException('已取消','AbortError'));};active=abort;
  opts.signal?.addEventListener('abort',abort,{once:true});if(opts.signal?.aborted)return abort();
  w.onerror=e=>{cleanup();w.terminate();worker=null;reject(Error(e.message));};
  w.onmessage=({data:r})=>{if(r.id!==id)return;if(r.stage){stage=r.stage;return;}cleanup();if(r.error)return reject(Error(r.error));resolve(new Response(r.blob,{headers:{'X-Timings':JSON.stringify(r.timings),'X-Elapsed':String(r.elapsed),'X-Device':'WebGPU','X-SR-Cached':r.cached?'1':'0','X-Alpha':r.alpha?'1':'0'}}));};
  w.postMessage({id,blob:opts.body,down:Number(u.searchParams.get('down')),lam:Number(u.searchParams.get('l0'))});
 });
 throw Error('未知本地操作');
}
