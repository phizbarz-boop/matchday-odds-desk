'use strict';
const {selectionKey}=require('./sportyPublicCache');
const PLANS=[{id:'10000',label:'10,000x',targetOdds:10000},{id:'2500',label:'2,500x',targetOdds:2500},
  {id:'500',label:'500x',targetOdds:500},{id:'100a',label:'100x A',targetOdds:100},
  {id:'100b',label:'100x B',targetOdds:100},{id:'100c',label:'100x C',targetOdds:100}];
const betTypeKey=c=>String(c.betType||`${c.sport}:${c.marketId}`).toLowerCase();
const winningProbability=c=>Number.isFinite(Number(c.fullWinProbability))&&c.fullWinProbability!=null?Number(c.fullWinProbability):Number(c.probability);
const ticketSignature=selections=>selections.map(selectionKey).sort().join(';');
function inWindow(c,start,end){const t=Date.parse(c.kickoffUtc||'');return c.live!==true&&Number.isFinite(t)&&t>start+60000&&t<=end&&Number(c.odds)>1&&winningProbability(c)>0&&winningProbability(c)<=100;}
function canUse(candidate,used){
  const type=betTypeKey(candidate),event=String(candidate.eventId),key=selectionKey(candidate);
  if(!used.events.has(event)&&!used.types.has(type))return true;
  const record=used.picks.get(key);
  return Boolean(record&&record.count<3&&record.probability>=90&&Number(candidate.probability)>=90&&record.type===type);
}
function emptyUsage(){return {events:new Set(),types:new Set(),picks:new Map()};}
function recordSelections(used,selections){for(const c of selections){const key=selectionKey(c),old=used.picks.get(key);used.events.add(String(c.eventId));used.types.add(betTypeKey(c));used.picks.set(key,{count:(old?.count||0)+1,probability:Math.min(old?.probability??100,Number(c.probability)),type:betTypeKey(c)});}}

// A bounded dynamic search maximizes the product of estimated winning
// probabilities at the target. One choice per fixture, no quality-score or
// shortest-ticket preference; exact log-odds are retained for target checks.
function bestProbabilityTicket(candidates,targetOdds,{maxSelections=40,bins=500,excludedTickets=new Set()}={}){
  const groups=new Map(),goal=Math.log(targetOdds),step=goal/bins;
  for(const c of candidates){if(!groups.has(String(c.eventId)))groups.set(String(c.eventId),[]);groups.get(String(c.eventId)).push(c);}
  let states=new Map([['0:0',{legs:[],oddsLog:0,probLog:0}]]),best=null,fallback=null;
  for(const options of groups.values()){
    const next=new Map(states);
    for(const state of states.values())for(const c of options){
      if(state.legs.length>=maxSelections)continue;
      const node={legs:[...state.legs,c],oddsLog:state.oddsLog+Math.log(c.odds),probLog:state.probLog+Math.log(Math.max(1e-12,winningProbability(c)/100))};
      if(node.oddsLog+1e-12>=goal&&!excludedTickets.has(ticketSignature(node.legs))){if(!best||node.probLog>best.probLog+1e-12||(Math.abs(node.probLog-best.probLog)<1e-12&&node.oddsLog<best.oddsLog))best=node;continue;}
      if(node.oddsLog<goal&&(!fallback||node.oddsLog>fallback.oddsLog+1e-12||(Math.abs(node.oddsLog-fallback.oddsLog)<1e-12&&node.probLog>fallback.probLog)))fallback=node;
      const key=Math.floor(node.oddsLog/step)+':'+node.legs.length,old=next.get(key);
      if(!old||node.probLog>old.probLog)next.set(key,node);
    }
    // Keep a bounded frontier when a full public board contains thousands of
    // combinations. This is a search estimate, not a guarantee of an optimum.
    if(next.size>2400)states=new Map([...next].sort((a,b)=>b[1].probLog/Math.max(.01,b[1].oddsLog)-a[1].probLog/Math.max(.01,a[1].oddsLog)).slice(0,2400));else states=next;
  }
  const chosen=best||fallback;return {selections:chosen?.legs||[],combinedOdds:chosen?Math.exp(chosen.oddsLog):1,
    reachedTarget:Boolean(best),estimatedWinningProbability:chosen?Math.exp(chosen.probLog)*100:0,targetOdds};
}
function allocateTypes(candidates){
  const groups=new Map();for(const c of candidates){const type=betTypeKey(c);if(!groups.has(type))groups.set(type,[]);groups.get(type).push(c);}
  const summaries=[...groups].map(([type,rows])=>{const byEvent=new Map();rows.forEach(c=>{const old=byEvent.get(c.eventId);if(!old||winningProbability(c)>winningProbability(old))byEvent.set(c.eventId,c);});
    const available=[...byEvent.values()].sort((a,b)=>winningProbability(b)-winningProbability(a)).slice(0,40);
    return {type,quality:available.reduce((n,c)=>n+winningProbability(c),0)/Math.max(1,available.length),capacity:available.reduce((n,c)=>n+Math.log(c.odds),0)};}).sort((a,b)=>b.quality-a.quality||b.capacity-a.capacity||a.type.localeCompare(b.type));
  const assignments=PLANS.map(()=>({types:new Set(),capacity:0})),remaining=summaries.slice();
  // Very short-priced high-probability families may reach 100x, but cannot
  // reach 10,000x within 40 legs. Reserve them for a target they can support.
  for(let i=0;i<PLANS.length&&remaining.length;i++){
    const fit=remaining.findIndex(summary=>summary.capacity+1e-12>=Math.log(PLANS[i].targetOdds));
    const [summary]=remaining.splice(fit>=0?fit:0,1);assignments[i].types.add(summary.type);assignments[i].capacity+=summary.capacity;
  }
  for(const summary of remaining){
    const target=assignments.map((group,i)=>({i,coverage:group.capacity/Math.log(PLANS[i].targetOdds)})).sort((a,b)=>a.coverage-b.coverage)[0].i;
    assignments[target].types.add(summary.type);assignments[target].capacity+=summary.capacity;}
  return assignments;
}
function buildNext12hPack(candidates,{now=new Date(),windowEnd=null,maxSelections=40}={}){
  const start=now.getTime(),end=windowEnd?Date.parse(windowEnd):start+12*3600000;
  const pool=candidates.filter(c=>inWindow(c,start,end)&&winningProbability(c)>=75),assignments=allocateTypes(pool),used=emptyUsage(),plans=[],signatures=new Set(),bookingOrder=[];
  for(let i=0;i<PLANS.length;i++){
    const available=pool.filter(c=>canUse(c,used)&&(assignments[i].types.has(betTypeKey(c))||used.picks.has(selectionKey(c))));
    let result=bestProbabilityTicket(available.filter(c=>winningProbability(c)>=80),PLANS[i].targetOdds,{maxSelections,excludedTickets:signatures});let minProbability=80;
    // A requested target is never silently replaced by an under-target code.
    if(result.reachedTarget){recordSelections(used,result.selections);signatures.add(ticketSignature(result.selections));bookingOrder.push(PLANS[i].id);}
    plans.push({...PLANS[i],...result,minProbability,assignedBetTypes:[...assignments[i].types],...(!result.reachedTarget?{reason:'target_unreachable_with_separation_rules'}:{})});
  }
  // After the initial allocations, unused families and eligible repeated
  // selections can rescue a target without taking any completed ticket's
  // exclusive matches or types.
  for(let i=0;i<plans.length;i++)if(!plans[i].reachedTarget){
    let result=bestProbabilityTicket(pool.filter(c=>canUse(c,used)&&winningProbability(c)>=80),plans[i].targetOdds,{maxSelections,excludedTickets:signatures});let minProbability=80;if(!result.reachedTarget&&plans[i].targetOdds>=500){result=bestProbabilityTicket(pool.filter(c=>canUse(c,used)),plans[i].targetOdds,{maxSelections,excludedTickets:signatures});minProbability=75;}
    if(result.reachedTarget){recordSelections(used,result.selections);signatures.add(ticketSignature(result.selections));plans[i]={...plans[i],...result,minProbability};delete plans[i].reason;bookingOrder.push(plans[i].id);}
  }
  const owners=new Map();
  for(const id of bookingOrder){const plan=plans.find(p=>p.id===id),dependencies=new Set();
    for(const c of plan.selections){const type=betTypeKey(c);if(!owners.has(type))owners.set(type,id);else if(owners.get(type)!==id)dependencies.add(owners.get(type));}
    plan.dependencies=[...dependencies];
  }
  return {createdAt:now.toISOString(),windowEnd:new Date(end).toISOString(),plans,bookingOrder};
}
function ticketText(plan,selections,booking,context){
  const combined=selections.reduce((n,c)=>n*Number(c.odds),1),chance=selections.reduce((n,c)=>n*winningProbability(c)/100,1)*100;
  const lines=[`🟢 PLOT207 SPORTS · NEXT 12H · ${plan.label}`,`${context.dateKey} · ${context.slotTime} WAT`,
    `Combined odds: ${combined.toFixed(2)} · ${selections.length} games`,
    `Per-game model floor: ${plan.minProbability||80}%`,
    `Estimated combined chance: ${chance.toPrecision(3)}% (independence assumption)`,
    `SportyBet code: ${booking.shareCode}`,...(booking.shareURL?[booking.shareURL]:[]),''];
  selections.forEach((c,i)=>lines.push(`${i+1}. ${c.home} vs ${c.away}\n${c.outcomeDesc} · ${c.marketDesc} @ ${Number(c.odds).toFixed(2)} · ${Number(c.probability).toFixed(1)}%`));
  if(selections.some(c=>c.fullWinProbability==null&&/push|half|equivalent/i.test(c.settlementNote||'')))lines.push('Push/half-settlement selections use fair-price probability estimates.');
  const chunks=[];let text='';for(const line of lines){if((text+'\n'+line).length>3800){chunks.push(text);text=`${plan.label} · continued\nSportyBet code: ${booking.shareCode}`;}text+=(text?'\n':'')+line;}if(text)chunks.push(text);return chunks;
}
async function runNext12hPicks(deps,context){
  const {redis,slotKey,dateKey,slotTime,signal,shouldAbort}=context;
  if(!redis)throw new Error('REDIS_URL is required for the next-12-hours Telegram batch');
  const check=()=>{if(shouldAbort()||signal?.aborted)throw new Error('Next-12-hours batch cancelled');};check();
  const packKey=`telegram:next12h:pack:${slotKey}`,statusKey=`telegram:next12h:plans:${slotKey}`;
  let pack;const raw=await redis.get(packKey);if(raw)pack=JSON.parse(raw);
  if(!pack){const candidates=await deps.loadPool({signal});check();pack=buildNext12hPack(candidates,{now:deps.now(),maxSelections:40});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
  const previous=await redis.hVals(statusKey),used=emptyUsage(),signatures=new Set(),states=new Map(previous.map(raw=>{const value=JSON.parse(raw);return [value.id,value];}));
  for(const state of states.values())if(['completed','posting','delivery_unknown'].includes(state.status)){recordSelections(used,state.selections||[]);signatures.add(ticketSignature(state.selections||[]));}
  const results=[];let bookingChecked=false;
  const ordering=pack.bookingOrder||pack.plans.map(p=>p.id);
  const ordered=[...ordering.map(id=>pack.plans.find(p=>p.id===id)).filter(Boolean),...pack.plans.filter(p=>!ordering.includes(p.id))];
  for(const plan of ordered){
    check();const prior=states.get(plan.id);
    if(prior&&['completed','posting','delivery_unknown','no_eligible_games'].includes(prior.status)){results.push({id:plan.id,skipped:true,reason:prior.status});continue;}
    const state=async(status,extra={})=>{const value={id:plan.id,status,...extra};await redis.hSet(statusKey,plan.id,JSON.stringify(value));await redis.expire(statusKey,172800);states.set(plan.id,value);};
    const waiting=(plan.dependencies||[]).filter(id=>!['completed','posting','delivery_unknown'].includes(states.get(id)?.status));
    if(waiting.length){
      const permanent=waiting.some(id=>states.get(id)?.status==='no_eligible_games');
      await state(permanent?'no_eligible_games':'dependency_waiting',{reason:'shared_pick_source_ticket_unavailable'});
      results.push({id:plan.id,skipped:true,reason:'shared_pick_source_ticket_unavailable',retryable:!permanent});continue;
    }
    if(!plan.reachedTarget){await state('no_eligible_games',{reason:plan.reason});results.push({id:plan.id,skipped:true,reason:plan.reason});continue;}
    let posting=false,delivered=false,tracked=false,selections=[];
    try{
      selections=(await deps.validate(plan.selections,{signal})).filter(c=>inWindow(c,deps.now().getTime(),Date.parse(pack.windowEnd))&&canUse(c,used)&&winningProbability(c)>=(plan.minProbability||(plan.targetOdds>=500?75:80)));check();
      const unique=new Set(selections.map(c=>String(c.eventId))),combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1);
      if(!selections.length||unique.size!==selections.length||selections.length>40||combinedOdds+1e-9<plan.targetOdds){await state('no_eligible_games',{reason:'markets_changed_or_target_not_reached'});results.push({id:plan.id,skipped:true,reason:'markets_changed_or_target_not_reached'});continue;}
      if(signatures.has(ticketSignature(selections))){await state('no_eligible_games',{reason:'duplicate_ticket_variation'});results.push({id:plan.id,skipped:true,reason:'duplicate_ticket_variation'});continue;}
      if(!bookingChecked){await deps.assertBookingReady();bookingChecked=true;}
      const booking=await deps.book(selections);check();
      if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw new Error('SportyBet did not return the complete next-12-hours ticket');
      const ticketId=`next12h:${slotKey}:${plan.id}`;
      await deps.track(redis,{ticketId,label:`NEXT 12H · ${plan.label}`,targetOdds:plan.targetOdds,combinedOdds,
        sportScope:'all',selections,shareCode:booking.shareCode,shareURL:booking.shareURL,delivery:'prepared',liveMode:'prematch'});tracked=true;
      await deps.saveCode(redis,dateKey,slotKey,plan,booking,combinedOdds);check();
      // Persist the exact validated selections before starting any send. A
      // crash/ambiguous send reserves their matches and types during a retry.
      await state('posting',{selections,shareCode:booking.shareCode});posting=true;recordSelections(used,selections);signatures.add(ticketSignature(selections));
      for(const chunk of ticketText(plan,selections,booking,context)){check();await deps.send(chunk,{signal});}delivered=true;
      await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});
      await state('completed',{selections,shareCode:booking.shareCode});results.push({id:plan.id,sent:true,shareCode:booking.shareCode,combinedOdds,selections:selections.length});
    }catch(err){
      if(posting&&tracked)await deps.updateTrack(redis,`next12h:${slotKey}:${plan.id}`,{delivery:delivered?'posted':'unknown'}).catch(()=>{});
      await state(posting?'delivery_unknown':'failed_before_post',{...(posting?{selections}:{}),reason:String(err.message).slice(0,180)}).catch(()=>{});
      results.push({id:plan.id,sent:delivered,error:String(err.message).slice(0,180),deliveryUnknown:posting&&!delivered});
      if(shouldAbort()||signal?.aborted)throw err;
    }
  }
  return {sent:results.some(r=>r.sent),ticketsSent:results.filter(r=>r.sent).length,results,
    retryable:results.some(r=>r.retryable||r.error&&!r.deliveryUnknown),windowEnd:pack.windowEnd};
}
module.exports={PLANS,betTypeKey,winningProbability,ticketSignature,inWindow,canUse,emptyUsage,recordSelections,bestProbabilityTicket,allocateTypes,buildNext12hPack,ticketText,runNext12hPicks};
