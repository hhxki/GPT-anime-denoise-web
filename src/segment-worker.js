import * as ort from 'onnxruntime-web/webgpu';
import wasmUrl from '../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url';
ort.env.wasm.wasmPaths={wasm:wasmUrl};ort.env.wasm.numThreads=1;
const officialModelUrl = 'https://huggingface.co/skytnt/anime-seg/resolve/a0a563c41338cbe0d23dfb4bfc3e243c518e5768/isnetis.onnx';
const modelSha256 = 'f15622d853e8260172812b657053460e20806f04b9e05147d49af7bed31a6e99';
self.onmessage=async({data:{blob}})=>{
 let session,input,outputs,bmp;
 try{
  if(!navigator.gpu)throw Error('人物识别需要 WebGPU');
  const url=import.meta.env.VITE_SEG_MODEL_URL || officialModelUrl;
  const cache=await caches.open('anime-seg-v1');let response=await cache.match(url);
  const fromCache = !!response;
  if (!response) {
   response = await fetch(url).catch(() => null);
   if (!response?.ok) throw Error('无法从 Hugging Face 下载人物模型，请检查网络后重试');
  }
  const bytes=await response.arrayBuffer();
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  if(digest !== modelSha256){await cache.delete(url);throw Error('人物模型校验失败，请检查下载地址后重试');}
  if (!fromCache) {
   await cache.put(url, new Response(bytes)).catch(() => {});
  }
  session=await ort.InferenceSession.create(bytes,{executionProviders:['webgpu']});
  bmp=await createImageBitmap(blob);const w=bmp.width,h=bmp.height,size=1024;
  const rw=Math.max(1,Math.round(size*w/Math.max(w,h))),rh=Math.max(1,Math.round(size*h/Math.max(w,h))),x=Math.floor((size-rw)/2),y=Math.floor((size-rh)/2);
  const c=new OffscreenCanvas(size,size),g=c.getContext('2d');g.fillStyle='black';g.fillRect(0,0,size,size);g.drawImage(bmp,x,y,rw,rh);
  const p=g.getImageData(0,0,size,size).data,a=new Float32Array(3*size*size);
  for(let i=0;i<size*size;i++)for(let ch=0;ch<3;ch++)a[ch*size*size+i]=p[i*4+ch]/255;
  input=new ort.Tensor('float32',a,[1,3,size,size]);outputs=await session.run({img:input});
  const mask=new ImageData(size,size),values=outputs.mask.data;
  for(let i=0;i<values.length;i++){
   const v=Math.round(255*Math.max(0,Math.min(1,values[i])));
   mask.data[i*4]=mask.data[i*4+1]=mask.data[i*4+2]=v;
   mask.data[i*4+3]=255;
  }
  g.putImageData(mask,0,0);const result=new OffscreenCanvas(w,h),rg=result.getContext('2d');rg.drawImage(c,x,y,rw,rh,0,0,w,h);
  const alpha=new OffscreenCanvas(w,h),ag=alpha.getContext('2d');ag.drawImage(bmp,0,0);const ap=ag.getImageData(0,0,w,h).data,mp=rg.getImageData(0,0,w,h);let share=0;
  for(let i=0;i<w*h;i++){const v=Math.round(mp.data[i*4]*ap[i*4+3]/255);mp.data[i*4]=mp.data[i*4+1]=mp.data[i*4+2]=v;share+=v/255;}
  rg.putImageData(mp,0,0);self.postMessage({blob:await result.convertToBlob({type:'image/png'}),share:share/(w*h)});
 }catch(e){self.postMessage({error:e.message});}
 finally{bmp?.close();input?.dispose();if(outputs)Object.values(outputs).forEach(t=>t.dispose());await session?.release();}
};
