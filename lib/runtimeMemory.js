'use strict';
const fs=require('node:fs'),v8=require('node:v8');
function snapshot({read=path=>fs.readFileSync(path,'utf8'),memory=process.memoryUsage,heap=()=>v8.getHeapStatistics().heap_size_limit}={}){
 const number=path=>{try{const n=Number(String(read(path)).trim());return Number.isFinite(n)&&n>0?n:null;}catch{return null;}};
 const usage=memory(),limit=number('/sys/fs/cgroup/memory.max')||number('/sys/fs/cgroup/memory/memory.limit_in_bytes'),used=number('/sys/fs/cgroup/memory.current')||number('/sys/fs/cgroup/memory/memory.usage_in_bytes');
 const finiteLimit=limit&&limit<1024**5?limit:null;
 return{rssMiB:Math.round(usage.rss/1024**2),heapUsedMiB:Math.round(usage.heapUsed/1024**2),heapLimitMiB:Math.round(heap()/1024**2),hostLimitMiB:finiteLimit?Math.round(finiteLimit/1024**2):null,hostUsedMiB:used?Math.round(used/1024**2):null,availableMiB:finiteLimit&&used!=null?Math.max(0,Math.floor((finiteLimit-used)/1024**2)):null};
}
function beforeBrowserLaunch({inspect=snapshot,logger=console}={}){const state=inspect();logger.info?.('[Runtime memory] H2H browser start '+JSON.stringify(state));if(state.availableMiB!=null&&state.availableMiB<192)throw Object.assign(Error('Not enough host memory to launch H2H browser safely'),{h2hReason:'host_memory_pressure'});return state;}
// Serialize memory-intensive jobs on the web instance. Nested analyzer calls
// share the current admission; unrelated requests fail fast instead of queuing.
function createHeavyWorkGuard({inspect=snapshot,logger=console}={}){
 const context=new (require('node:async_hooks').AsyncLocalStorage)();
 let active=null;
 function check(label){
  const state=inspect();
  if((state.availableMiB!=null&&state.availableMiB<96)||
     (state.heapLimitMiB>0&&state.heapUsedMiB>=state.heapLimitMiB*.82)){
   logger.warn?.('[Runtime memory] deferred '+label+' '+JSON.stringify(state));
   throw Object.assign(Error('Server memory is low; retry shortly'),{code:'HEAVY_WORK_MEMORY_PRESSURE'});
  }
 }
 async function run(label,fn){
  if(active&&context.getStore()===active)return fn();
  if(active)throw Object.assign(Error('Another market job is running; retry shortly'),{code:'HEAVY_WORK_BUSY'});
  check(label);
  const token={};
  active=token;
  try{return await context.run(token,fn);}finally{active=null;}
 }
 return {run,check};
}
module.exports={snapshot,beforeBrowserLaunch,createHeavyWorkGuard};
