import { gpuL0Smooth as l0Smooth } from './gpu-l0.js';
// Bounded FFT memory. Large images use local overlapping solves, not global L0.
export async function smoothLarge(rgb,w,h,lam,progress){
 if(2**Math.ceil(Math.log2(w))*2**Math.ceil(Math.log2(h))<=1048576)
  return l0Smooth(rgb,w,h,lam,()=>{},progress);
 // 768 + 2*128 = 1024 exactly. The old 512 core also needed a 1024 FFT,
 // wasting most of that work on padding. Keep the same maximum FFT size.
 const out=new Float32Array(rgb.length),core=768,halo=128;
 let done=0,total=Math.ceil(w/core)*Math.ceil(h/core);
 for(let y=0;y<h;y+=core)for(let x=0;x<w;x+=core){
  progress(`大图局部平滑 ${++done}/${total}`);
  const a=Math.max(0,x-halo),b=Math.max(0,y-halo),r=Math.min(w,x+core+halo),d=Math.min(h,y+core+halo),tw=r-a,th=d-b;
  const tile=new Float32Array(tw*th*3);
  for(let j=0;j<th;j++)tile.set(rgb.subarray(((b+j)*w+a)*3,((b+j)*w+r)*3),j*tw*3);
  const filtered=await l0Smooth(tile,tw,th,lam);
  for(let j=y;j<Math.min(h,y+core);j++)out.set(filtered.subarray(((j-b)*tw+x-a)*3,((j-b)*tw+Math.min(w,x+core)-a)*3),(j*w+x)*3);
 }
 return out;
}
