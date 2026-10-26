'use strict';
const PREFIX='sportybet:h2h:worker:v1:',QUEUE=PREFIX+'queue',STATUS=PREFIX+'status';
const maxAgeMs=()=>8*86400000;
const retentionSeconds=(c,now)=>Math.max(86400,Math.min(9*86400,Math.ceil(((Date.parse(c?.kickoffUtc)||now+7*86400000)+86400000-now)/1000)));
const usable=(e,c,now)=>e&&String(e.eventId)===String(c.eventId)&&e.home===c.home&&e.away===c.away&&(e.oldAvailable||e.newAvailable)&&Number.isFinite(Date.parse(e.capturedAt))&&now-Date.parse(e.capturedAt)<=maxAgeMs()&&Date.parse(e.capturedAt)<=now+60000;
const fixture=c=>Object.fromEntries(['eventId','home','away','sport','category','country','tournament','kickoffUtc'].filter(k=>c[k]!=null).map(k=>[k,String(c[k]).slice(0,240)]));
const decode=raw=>{try{return raw?JSON.parse(raw):null;}catch{return null;}};
function createH2hCache({getRedis=async()=>null,now=Date.now}={}){
 async function client(){const r=await getRedis();if(!r)throw Error('H2H cache requires REDIS_URL');return r;}
 async function readMany(rows){const r=await client(),unique=[...new Map(rows.filter(require('./h2hScope').enabled).map(c=>[String(c.eventId),c])).values()].slice(0,1000),evidence=new Map(),failures=new Map();for(let i=0;i<unique.length;i+=100){const batch=unique.slice(i,i+100),values=await r.mGet(batch.map(c=>PREFIX+'e:'+c.eventId)),errors=await r.mGet(batch.map(c=>PREFIX+'failure:'+c.eventId));for(let j=0;j<batch.length;j++){const id=String(batch[j].eventId),e=decode(values[j]),f=decode(errors[j]);if(usable(e,batch[j],now())){evidence.set(id,e);if(e.cachePolicy!=='fixture_once_v1')await r.set(PREFIX+'e:'+id,JSON.stringify({...e,cachePolicy:'fixture_once_v1'}),{EX:retentionSeconds(batch[j],now())});}if(f)failures.set(id,f);}}return{evidence,failures};}
 async function enqueue(rows){const r=await client(),items=[...new Map(rows.filter(require('./h2hScope').enabled).filter(c=>/^sr:match:\d+$/.test(String(c.eventId))).map(c=>[String(c.eventId),fixture(c)])).values()].slice(0,1000);if(!items.length)return;const m=r.multi();for(const c of items)m.set(PREFIX+'fixture:'+c.eventId,JSON.stringify(c),{EX:172800});m.sAdd(QUEUE,items.map(c=>c.eventId));m.expire(QUEUE,172800);await m.exec();}
 async function readAndQueue(rows){const result=await readMany(rows);const missing=rows.filter(c=>!result.evidence.has(String(c.eventId)));try{await enqueue(missing);}catch{result.queueUnavailable=true;}return result;}
 return{readMany,readAndQueue,enqueue,
  pending:async()=>{const r=await client();return r.sMembers(QUEUE);},
  fixtures:async ids=>{const r=await client(),rows=[];for(let i=0;i<ids.length;i+=100)rows.push(...(await r.mGet(ids.slice(i,i+100).map(id=>PREFIX+'fixture:'+id))).map(decode));return rows;},
  attempts:async ids=>{const r=await client(),result=new Map();for(let i=0;i<ids.length;i+=100){const batch=ids.slice(i,i+100),values=await r.mGet(batch.map(id=>PREFIX+'attempt:'+id));for(let j=0;j<batch.length;j++){const a=decode(values[j]);if(a)result.set(String(batch[j]),a);}}return result;},
  started:async id=>(await client()).set(PREFIX+'attempt:'+id,JSON.stringify({outcome:'running',lastAttemptAt:new Date(now()).toISOString()}),{EX:172800}),
  fixture:async id=>decode(await(await client()).get(PREFIX+'fixture:'+id)),
  remove:async id=>(await client()).sRem(QUEUE,String(id)),
  put:async(e,c=null)=>{const r=await client(),context=c||e.kickoffUtc&&e||decode(await r.get(PREFIX+'fixture:'+e.eventId)),seconds=retentionSeconds(context,now());await r.set(PREFIX+'e:'+e.eventId,JSON.stringify({...e,cachePolicy:'fixture_once_v1'}),{EX:seconds});await r.set(PREFIX+'attempt:'+e.eventId,JSON.stringify({outcome:'saved',lastAttemptAt:new Date(now()).toISOString()}),{EX:seconds});await r.del(PREFIX+'failure:'+e.eventId);await r.sRem(QUEUE,String(e.eventId));},
  failed:async(id,detail)=>{const r=await client(),seconds=['stats_tab_unavailable','h2h_tabs_unavailable','h2h_panels_unavailable'].includes(detail.reason)?3600:900,value={...detail,failedAt:new Date(now()).toISOString(),retryAfter:new Date(now()+seconds*1000).toISOString()};await r.set(PREFIX+'failure:'+id,JSON.stringify(value),{EX:seconds});await r.set(PREFIX+'attempt:'+id,JSON.stringify({...value,outcome:'failed',lastAttemptAt:value.failedAt}),{EX:172800});},
  saveStatus:async value=>(await client()).set(STATUS,JSON.stringify(value),{EX:86400}),
  status:async()=>decode(await(await client()).get(STATUS))};
}
module.exports={createH2hCache,maxAgeMs,usable,retentionSeconds,PREFIX,QUEUE,STATUS};
