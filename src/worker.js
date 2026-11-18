import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
import { smoothLarge } from './large-l0.js';
import { validateDimensions } from './limits.js';
ort.env.wasm.wasmPaths = { wasm: wasmUrl };
ort.env.wasm.numThreads = 1;
let session, cache;
const canvas=(w,h)=>new OffscreenCanvas(w,h);
async function model(){
  if(session)return session;
  if(!navigator.gpu)throw Error('需要支持 WebGPU 的浏览器和 HTTPS（本机 localhost 也可以）');
  const url=import.meta.env.VITE_MODEL_URL || new URL('../models/esrgan.onnx',self.location.href).href;
  const storage=await caches.open('anime-model-v1');
  let response=await storage.match(url);
  if(!response){response=await fetch(url);if(!response.ok)throw Error('模型下载失败');await storage.put(url,response.clone());}
  const bytes=await response.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!=='80b3a3b92d69ab457220925f5deb5b9c8b113cb41b075603139a4234c912344d'){await storage.delete(url);throw Error('模型校验失败，请重新下载正确版本');}
  session=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu'],graphOptimizationLevel:'all'});
  return session;
}
self.onmessage=async({data:m})=>{
 const progress=stage=>self.postMessage({id:m.id,stage});
 try{
  const start=performance.now(), bitmap=await createImageBitmap(m.blob),w=bitmap.width,h=bitmap.height;
  try { validateDimensions(w,h); } catch(e) { bitmap.close(); throw e; }
  const original=canvas(w,h),og=original.getContext('2d');og.drawImage(bitmap,0,0);bitmap.close();
  const pixels=og.getImageData(0,0,w,h);
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await m.blob.arrayBuffer()))).join(',')+m.down;
  const cached=cache?.key===hash;
  let rgb;
  const timings={};let phase=performance.now();
  if(cached)rgb=cache.rgb.slice();
  else{
   progress('下载 / 加载 GPU 模型');const net=await model();
   timings.model=(performance.now()-phase)/1000;phase=performance.now();
   cache=null; // Release the previous image before allocating the next one.
   const sw=Math.max(1,Math.round(w*m.down)),sh=Math.max(1,Math.round(h*m.down));
   const small=canvas(sw,sh),sg=small.getContext('2d');sg.drawImage(original,0,0,sw,sh);
   const input=sg.getImageData(0,0,sw,sh).data;
   rgb=new Float32Array(w*h*3);
   const tile=128,halo=96,total=Math.ceil(sw/tile)*Math.ceil(sh/tile);let done=0;
   for(let y=0;y<sh;y+=tile)for(let x=0;x<sw;x+=tile){
    progress(`GPU 分块超分 ${++done}/${total}`);
    const x0=Math.max(0,x-halo),y0=Math.max(0,y-halo),x1=Math.min(sw,x+tile+halo),y1=Math.min(sh,y+tile+halo),tw=x1-x0,th=y1-y0,n=tw*th;
    const a=new Float32Array(n*3);
    for(let j=0;j<th;j++)for(let i=0;i<tw;i++)for(let c=0;c<3;c++)a[c*n+j*tw+i]=input[((j+y0)*sw+i+x0)*4+c]/255;
    const tensor=new ort.Tensor('float32',a,[1,3,th,tw]);let outputs;
    try{outputs=await net.run({input:tensor});const out=outputs.output.data,ow=tw*4,oh=th*4;
    // Sample using global pixel coordinates: no full 4x canvas, consistent seams.
    const left=Math.round(x*w/sw),right=Math.round(Math.min(sw,x+tile)*w/sw),top=Math.round(y*h/sh),bottom=Math.round(Math.min(sh,y+tile)*h/sh);
    for(let j=top;j<bottom;j++)for(let i=left;i<right;i++){
      const sx=Math.max(0,Math.min(ow-1,(i+.5)*sw*4/w-.5-x0*4)),sy=Math.max(0,Math.min(oh-1,(j+.5)*sh*4/h-.5-y0*4));
      const ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;
      for(let c=0;c<3;c++){const base=c*ow*oh; const get=(xx,yy)=>Math.max(0,Math.min(1,out[base+yy*ow+xx]));
      rgb[(j*w+i)*3+c]=(get(ix,iy)*(1-fx)+get(Math.min(ix+1,ow-1),iy)*fx)*(1-fy)+(get(ix,Math.min(iy+1,oh-1))*(1-fx)+get(Math.min(ix+1,ow-1),Math.min(iy+1,oh-1))*fx)*fy;}
    }
    }finally{tensor.dispose();if(outputs)Object.values(outputs).forEach(t=>t.dispose());}
   }
   small.width=1;
   // At most 96 MiB, enough to avoid repeating GPU inference for common 4K images.
   cache=rgb.byteLength<=96*1024*1024?{key:hash,rgb:rgb.slice()}:null;
  }
  timings.sr=(performance.now()-phase)/1000;phase=performance.now();
  if(m.lam>0){progress('L0 平滑（WebGPU）');rgb=await smoothLarge(rgb,w,h,m.lam,s=>progress(`L0 平滑 ${s}`));}
  timings.l0=(performance.now()-phase)/1000;phase=performance.now();
  for(let i=0;i<w*h;i++)for(let c=0;c<3;c++)pixels.data[i*4+c]=Math.round(Math.max(0,Math.min(1,rgb[i*3+c]))*255);
  og.putImageData(pixels,0,0);const blob=await original.convertToBlob({type:'image/png'});
  timings.encode=(performance.now()-phase)/1000;
  self.postMessage({id:m.id,blob,timings,elapsed:(performance.now()-start)/1000,cached,w,h,alpha:pixels.data.some((v,i)=>i%4===3&&v<255)});
 }catch(e){self.postMessage({id:m.id,error:e.message});}
};
