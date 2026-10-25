'use strict';
const fs=require('node:fs'),v8=require('node:v8');
function snapshot({read=path=>fs.readFileSync(path,'utf8'),memory=process.memoryUsage,heap=()=>v8.getHeapStatistics().heap_size_limit}={}){
 const number=path=>{try{const n=Number(String(read(path)).trim());return Number.isFinite(n)&&n>0?n:null;}catch{return null;}};
 const usage=memory(),limit=number('/sys/fs/cgroup/memory.max')||number('/sys/fs/cgroup/memory/memory.limit_in_bytes'),used=number('/sys/fs/cgroup/memory.current')||number('/sys/fs/cgroup/memory/memory.usage_in_bytes');
 const finiteLimit=limit&&limit<1024**5?limit:null;
 return{rssMiB:Math.round(usage.rss/1024**2),heapUsedMiB:Math.round(usage.heapUsed/1024**2),heapLimitMiB:Math.round(heap()/1024**2),hostLimitMiB:finiteLimit?Math.round(finiteLimit/1024**2):null,hostUsedMiB:used?Math.round(used/1024**2):null,availableMiB:finiteLimit&&used!=null?Math.max(0,Math.floor((finiteLimit-used)/1024**2)):null};
}
function beforeBrowserLaunch({inspect=snapshot,logger=console}={}){const state=inspect();logger.info?.('[Runtime memory] H2H browser start '+JSON.stringify(state));if(state.availableMiB!=null&&state.availableMiB<192)throw Object.assign(Error('Not enough host memory to launch H2H browser safely'),{h2hReason:'host_memory_pressure'});return state;}
module.exports={snapshot,beforeBrowserLaunch};
