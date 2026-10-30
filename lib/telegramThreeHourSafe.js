'use strict';
const {watParts}=require('./watScheduler'),{bestProbabilityTicket,ticketSignature}=require('./telegramNext12h');
const exactKey=c=>'exact:'+require('./sportyPublicCache').selectionKey(c);
const TIMES=Array.from({length:8},(_,i)=>String(i*3).padStart(2,'0')+':00');
const PLANS=Array.from({length:2},(_,i)=>({id:'safe3'+String.fromCharCode(97+i),label:'EVERY 3H · 3 ODDS '+String.fromCharCode(65+i),floor:70,minGames:6,maxGames:10,targetOdds:3,upcomingOnly:true,finishWithinHours:null,windowEndsAt:null}));
function buildPack(pool,{now=new Date(),dateKey=watParts(now).date,excluded=new Set(),templates=PLANS}={}){const {eligible,pairKey}=require('./telegramFloorPicks'),excludedTickets=new Set(),used=new Set(excluded),plans=[];
 for(const template of templates){const plan={...template},available=pool.filter(c=>eligible(c,plan,now,dateKey,used)&&!used.has(exactKey(c)));const pick=bestProbabilityTicket(available,3,{minSelections:6,maxSelections:10,excludedTickets});const selections=pick.reachedTarget?pick.selections:[];if(selections.length){excludedTickets.add(ticketSignature(selections));for(const c of selections){used.add(pairKey(c));used.add(exactKey(c));}}plans.push({...plan,selections,alternatives:[],combinedOdds:pick.combinedOdds});}return {dateKey,plans};}
const NAMESPACE='telegram:three-safe:v1',RESERVATIONS=NAMESPACE+':reserved-pairs:v1';
const protectedStatus=s=>['completed','posting','booking','unknown'].includes(s);
async function preparePack(pack,{redis,dateKey,slotKey,loadPool,now=new Date()}){
 const {pairKey}=require('./telegramFloorPicks'),blocked=new Set(),states=(await redis.hVals(NAMESPACE+':state:'+slotKey)).map(JSON.parse),pastDate=new Date(Date.parse(dateKey+'T12:00:00Z')-86400000).toISOString().slice(0,10);
 for(const raw of await redis.hVals(RESERVATIONS)){const r=JSON.parse(raw);if(Date.parse(r.kickoffUtc)>+now){blocked.add(r.pair);if(r.exact)blocked.add(r.exact);}}
 // Import recent legacy reservations so an upgrade does not repeat old picks.
 for(const day of [pastDate,dateKey])for(const raw of await redis.hVals(NAMESPACE+':used:'+day))for(const pair of JSON.parse(raw))blocked.add(pair);
 for(const state of states)if(protectedStatus(state.status))for(const c of state.selections||[]){blocked.add(pairKey(c));blocked.add(exactKey(c));}
 let pool;const plans=[];
 for(const template of PLANS){const state=states.find(s=>s.id===template.id),old=pack.plans.find(p=>p.id===template.id);
  if(state&&(protectedStatus(state.status)||state.status==='empty')){plans.push({...old,...template,selections:state.selections||old?.selections||[]});continue;}
  pool||=await loadPool();const one=buildPack(pool,{now,dateKey,excluded:blocked,templates:[template]}).plans[0];const plan={...one,...template};for(const c of plan.selections){blocked.add(pairKey(c));blocked.add(exactKey(c));}plans.push(plan);
 }return {...pack,plans};
}
async function reserveSelections(selections,{redis,slotKey,plan,now=new Date()}){
 const {pairKey}=require('./telegramFloorPicks'),crypto=require('node:crypto');
 for(const c of selections){const pair=pairKey(c),seconds=Math.max(60,Math.min(9*86400,Math.ceil((Date.parse(c.kickoffUtc)-+now)/1000))),value={pair,exact:exactKey(c),kickoffUtc:c.kickoffUtc,slotKey,planId:plan.id};
  for(const identity of [pair,value.exact]){const acquired=await redis.set(NAMESPACE+':pair:'+crypto.createHash('sha256').update(identity).digest('hex'),JSON.stringify(value),{NX:true,EX:seconds});if(acquired!=='OK')throw Error('This match and bet type is already reserved by another three-hour ticket');}
  await redis.hSet(RESERVATIONS,pair,JSON.stringify(value));await redis.expire(RESERVATIONS,9*86400);
 }
}
function resolveSlot(headers,now=new Date()){const p=watParts(now),manualTest=headers['x-matchday-run-mode']==='manual';if(manualTest){const id=String(headers['x-matchday-run-id']||'');if(!/^[a-zA-Z0-9_-]{1,160}$/.test(id))throw Error('A valid manual run ID is required');return {dateKey:p.date,slotKey:p.date+'Tmanual-'+id,slotTime:String(Math.floor(p.minute/60)).padStart(2,'0')+':'+String(p.minute%60).padStart(2,'0'),manualTest:true};}const slotTime=TIMES[Math.floor(p.minute/180)];return {dateKey:p.date,slotKey:p.date+'T'+slotTime,slotTime,manualTest:false};}
module.exports={TIMES,PLANS,NAMESPACE,RESERVATIONS,buildPack,preparePack,reserveSelections,resolveSlot};
