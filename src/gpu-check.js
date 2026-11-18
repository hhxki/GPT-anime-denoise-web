import {gpuL0Smooth} from './gpu-l0.js';
import {l0Smooth} from './l0.js';
document.querySelector('#run').onclick=async()=>{
 const output=document.querySelector('#result');output.textContent='开始\n';
 try{
 for(const [w,h] of [[32,32],[63,47],[768,768]]){
  const input=new Float32Array(w*h*3);for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)input[(y*w+x)*3+c]=.2+.15*c+.2*(x>w/2)+.01*Math.sin(x*3+y*7+c);
  let t=performance.now();const gpu=await gpuL0Smooth(input,w,h,.001);const gpuMs=performance.now()-t;
  t=performance.now();const cpu=await l0Smooth(input,w,h,.001);const cpuMs=performance.now()-t;
  let max=0,sum=0,bad=0;for(let i=0;i<gpu.length;i++){const diff=Math.abs(gpu[i]-cpu[i]);max=Math.max(max,diff);sum+=diff;if(!Number.isFinite(gpu[i]))bad++;}
  output.textContent+=JSON.stringify({w,h,gpuMs:Math.round(gpuMs),cpuMs:Math.round(cpuMs),max255:max*255,mean255:sum/gpu.length*255,bad})+'\n';
  if(bad||max>.02)throw Error('精度检查未通过');
 }
 output.textContent+='PASS';
 }catch(e){output.textContent+='FAIL '+e.stack;}
};
