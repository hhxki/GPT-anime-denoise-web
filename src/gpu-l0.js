// Float32 L0 solver. All FFT stages and iterations stay on the GPU.
// Same edge-extension / periodic boundary convention as the CPU reference.
let devicePromise;
const kernels = new Map();
async function device() {
  if (!devicePromise) devicePromise = (async () => {
    if (!navigator.gpu) throw Error('L0 需要 WebGPU');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw Error('无法取得 WebGPU 设备');
    const d = await adapter.requestDevice();
    d.lost.then(() => { devicePromise = null; kernels.clear(); });
    return d;
  })().catch(e => { devicePromise = null; throw e; });
  return devicePromise;
}
async function compile(d,w,h) {
  const key=`${w}x${h}`;
  if(kernels.has(key))return kernels.get(key);
  const n=w*h;
  const common=`
const W:u32=${w}u; const H:u32=${h}u; const N:u32=${n}u;
struct Params { stage:u32, axis:u32, inverse:u32, beta:f32, lam:f32, pad:u32, pad2:u32, pad3:u32 }
@group(0) @binding(0) var<storage,read> a:array<vec2f>;
@group(0) @binding(1) var<storage,read_write> b:array<vec2f>;
@group(0) @binding(2) var<storage,read> original:array<vec2f>;
@group(0) @binding(3) var<uniform> p:Params;
`;
  const sources={
    reverse:`let size=select(W,H,p.axis==1u); let stride=select(1u,W,p.axis==1u);
      let pos=(i/stride)%size; let bits=u32(log2(f32(size)));
      let rev=reverseBits(pos)>>(32u-bits); b[i]=a[i-pos*stride+rev*stride];`,
    fft:`let stride=select(1u,W,p.axis==1u); let size=select(W,H,p.axis==1u);
      let pos=(i/stride)%size; let spanHalf=p.stage/2u; let j=pos%spanHalf;
      let low=i-(pos%p.stage)*stride+j*stride;
      let angle=select(-1.0,1.0,p.inverse==1u)*6.283185307179586*f32(j)/f32(p.stage);
      let z=a[low+spanHalf*stride]; let cs=cos(angle); let sn=sin(angle);
      let t=vec2f(z.x*cs-z.y*sn,z.x*sn+z.y*cs);
      b[i]=a[low]+select(t,-t,pos%p.stage>=spanHalf);`,
    gradient:`if(i>=N){return;} let x=i%W; let y=i/W;
      let right=y*W+(x+1u)%W; let below=((y+1u)%H)*W+x;
      var energy=0.0; var g:array<vec2f,3>;
      for(var c=0u;c<3u;c++){let off=c*N;g[c]=vec2f(a[off+right].x-a[off+i].x,a[off+below].x-a[off+i].x);energy+=dot(g[c],g[c]);}
      for(var c=0u;c<3u;c++){b[c*N+i]=select(g[c],vec2f(0.0),energy<p.lam/p.beta);}`,
    divergence:`let off=(i/N)*N;let j=i%N;let x=j%W;let y=j/W;
      let left=off+y*W+(x+W-1u)%W;let above=off+((y+H-1u)%H)*W+x;
      b[i]=vec2f(a[left].x-a[i].x+a[above].y-a[i].y,0.0);`,
    update:`let j=i%N;let sx=sin(3.141592653589793*f32(j%W)/f32(W));let sy=sin(3.141592653589793*f32(j/W)/f32(H));
      let den=1.0+p.beta*4.0*(sx*sx+sy*sy);b[i]=(original[i]+p.beta*a[i])/den;`,
    normalize:`b[i]=vec2f(a[i].x/f32(N),0.0);`,
  };
  const layout=d.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
    {binding:1,visibility:GPUShaderStage.COMPUTE,buffer:{type:'storage'}},
    {binding:2,visibility:GPUShaderStage.COMPUTE,buffer:{type:'read-only-storage'}},
    {binding:3,visibility:GPUShaderStage.COMPUTE,buffer:{type:'uniform'}},
  ]});
  const pipelines={};
  for(const [name,body] of Object.entries(sources)){
    const module=d.createShaderModule({code:common+`@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){let i=id.x;if(i>=3u*N){return;}${body}}`});
    pipelines[name]=await d.createComputePipelineAsync({layout:d.createPipelineLayout({bindGroupLayouts:[layout]}),compute:{module,entryPoint:'main'}});
  }
  const result={layout,pipelines};kernels.set(key,result);return result;
}
export async function gpuL0Smooth(rgb,width,height,lam,check=()=>{},progress=()=>{}) {
  if(!Number.isFinite(lam)||lam<0)throw Error('Invalid L0 strength');
  if(width<1||height<1||rgb.length!==width*height*3)throw Error('Invalid RGB image');
  if(lam===0)return rgb.slice();
  const w=2**Math.ceil(Math.log2(Math.max(2,width))),h=2**Math.ceil(Math.log2(Math.max(2,height))),n=w*h;
  if(n>1048576)throw Error('GPU L0 单块超出内存预算');
  const d=await device(),{layout,pipelines}=await compile(d,w,h),bytes=n*3*8;
  const buffers=[],uniforms=new Map();
  const alloc=(size,usage)=>{const b=d.createBuffer({size,usage});buffers.push(b);return b;};
  const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST;
  const state=alloc(bytes,usage),original=alloc(bytes,usage),a=alloc(bytes,usage),b=alloc(bytes,usage),grad=alloc(bytes,usage);
  const read=alloc(bytes,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);
  try{
    const data=new Float32Array(n*6);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)for(let c=0;c<3;c++)data[(c*n+y*w+x)*2]=rgb[(Math.min(y,height-1)*width+Math.min(x,width-1))*3+c];
    d.queue.writeBuffer(state,0,data);
    const dispatch=(enc,name,src,dst,stage=0,axis=0,inverse=0,beta=0)=>{
      const key=`${stage},${axis},${inverse},${beta}`;let uniform=uniforms.get(key);
      if(!uniform){const raw=new ArrayBuffer(32),u=new Uint32Array(raw),f=new Float32Array(raw);u[0]=stage;u[1]=axis;u[2]=inverse;f[3]=beta;f[4]=lam;
        uniform=alloc(32,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST);d.queue.writeBuffer(uniform,0,raw);uniforms.set(key,uniform);}
      const bind=d.createBindGroup({layout,entries:[{binding:0,resource:{buffer:src}},{binding:1,resource:{buffer:dst}},{binding:2,resource:{buffer:original}},{binding:3,resource:{buffer:uniform}}]});
      const pass=enc.beginComputePass();pass.setPipeline(pipelines[name]);pass.setBindGroup(0,bind);pass.dispatchWorkgroups(Math.ceil((name==='gradient'?n:n*3)/256));pass.end();
    };
    const fft=(enc,input,inverse)=>{
      let src=input;
      for(let axis=0;axis<2;axis++){
        let dst=src===a?b:a;dispatch(enc,'reverse',src,dst,0,axis,inverse);src=dst;
        for(let stage=2;stage<=(axis?h:w);stage*=2){dst=src===a?b:a;dispatch(enc,'fft',src,dst,stage,axis,inverse);src=dst;}
      }
      return src;
    };
    let enc=d.createCommandEncoder();const spectrum=fft(enc,state,0);enc.copyBufferToBuffer(spectrum,0,original,0,bytes);d.queue.submit([enc.finish()]);
    let count=0;const total=Math.ceil(Math.log2(1e5/(2*lam)));
    for(let beta=2*lam;beta<1e5;beta*=2){
      check();enc=d.createCommandEncoder();dispatch(enc,'gradient',state,grad,0,0,0,beta);dispatch(enc,'divergence',grad,a);
      const div=fft(enc,a,0),freq=div===a?b:a;dispatch(enc,'update',div,freq,0,0,0,beta);
      const spatial=fft(enc,freq,1);dispatch(enc,'normalize',spatial,state);
      d.queue.submit([enc.finish()]);
      // Bound queued work; no intermediate CPU readback.
      if(++count%4===0){await d.queue.onSubmittedWorkDone();progress(count/total);}
    }
    enc=d.createCommandEncoder();enc.copyBufferToBuffer(state,0,read,0,bytes);d.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);check();const result=new Float32Array(rgb.length),mapped=new Float32Array(read.getMappedRange());
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)for(let c=0;c<3;c++)result[(y*width+x)*3+c]=Math.max(0,Math.min(1,mapped[(c*n+y*w+x)*2]));
    read.unmap();progress(1);return result;
  }finally{for(const buffer of buffers)buffer.destroy();}
}
