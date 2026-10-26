'use strict';
function planQueue(fixtures,{now=Date.now(),evidence=new Map(),failures=new Map(),attempts=new Map(),refreshEvidence=()=>false,forceRetry=false}={}){
 const tiers=[[],[],[]],fresh=[],deferred=[];
 for(const c of fixtures){const id=String(c.eventId),e=evidence.get(id),a=attempts.get(id),f=failures.get(id);
  if(e&&!refreshEvidence(c,e)){fresh.push(id);continue;}
  const retry=Date.parse(f?.retryAfter||a?.retryAfter||''),legacyRetry=Date.parse(f?.failedAt||'')+900000;
  if(!forceRetry&&(Number.isFinite(retry)?retry>now:legacyRetry>now)){deferred.push(id);continue;}
  // First checks globally precede retries; cached-history upgrades come last.
  const tier=e?2:a||f?1:0;tiers[tier].push(c);
 }
 const ordered=[];
 for(const items of tiers){const groups=new Map();for(const c of items){const key=String(c.sport||'Unknown');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(c);}for(const rows of groups.values())rows.sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));while([...groups.values()].some(g=>g.length))for(const rows of groups.values())if(rows.length)ordered.push(rows.shift());}
 return{ordered,fresh,deferred,coverage:{awaitingFirstCheck:tiers[0].length,retriesReady:tiers[1].length,apiUpgradesReady:tiers[2].length,retriesDeferred:deferred.length,freshSkipped:fresh.length}};
}
module.exports={planQueue};
