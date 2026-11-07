'use strict';
const {watParts}=require('./watScheduler');
const {normalizedSport}=require('./telegramMixedSelector');
const {selectionKey}=require('./sportyPublicCache');
const {winningProbability,ticketSignature}=require('./telegramNext12h');
const todayLongShots=require('./todayLongShots');
const DAILY_HIGH_ODDS=[[30000,20,2],[10000,12,2.5],[1000,10,2.25]].flatMap(([targetOdds,maxGames,maxLegOdds])=>
 [1,2].map(variation=>({id:`dailyHigh${targetOdds}v${variation}`,label:`DAILY ${targetOdds.toLocaleString('en-GB')}x${targetOdds===1000?'+':''} · VARIATION ${variation}`,targetOdds,maxGames,maxLegOdds,minimumOdds:1000,floor:0,minGames:1,todayLongShot:true,dailyHighOdds:true})));
function oddsCapacity(rows,maxGames){
 const topByEvent=new Map();
 for(const c of rows){const id=String(c.eventId);topByEvent.set(id,Math.max(topByEvent.get(id)||1,Number(c.odds)));}
 return {fixtures:topByEvent.size,maxOdds:topByEvent.size?[...topByEvent.values()].sort((a,b)=>b-a).slice(0,maxGames).reduce((n,o)=>n*o,1):0};
}
function highOddsCapacity(pool,plan,{now,dateKey,excluded=new Set()}){
 return oddsCapacity(pool.filter(c=>eligible(c,plan,now,dateKey,excluded)),plan.maxGames);
}
function chooseLongShot(rows,plan,{now,signatures,uses}){
 if(!plan.dailyHighOdds)return todayLongShots.choose(rows,{now,signatures,uses});
 if(oddsCapacity(rows,plan.maxGames).maxOdds<plan.minimumOdds)return [];
 return require('./autoPicker').selectAutoBet(rows.map(c=>({...c,odds:Number(c.odds),probability:Number(c.probability??winningProbability(c)),edge:Number(c.edge)||0,qualityScore:c.qualityScore??winningProbability(c)})),{
  targetOdds:plan.targetOdds,maxSelections:plan.maxGames,trials:100,closestFallbackMin:plan.minimumOdds,
  preferEarlyStrong:true,excludedTickets:signatures,signatureOf:ticketSignature
 }).selections.sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||winningProbability(b)-winningProbability(a));
}
const oddsBelowMinimum=(odds,plan)=>plan.dailyHighOdds?odds<plan.minimumOdds:odds<=plan.minimumOdds+1e-9;
const PLANS=[
 ...['football','handball'].map(sport=>({id:sport+'70long',label:sport.toUpperCase()+' LONG SHOT · 70% · UP TO 20 GAMES',floor:70,sport,maxGames:20,longShot:true})),
 {id:'basketballSpecialty15',label:'BASKETBALL · PERIOD POINTS & PLAYER REBOUNDS · UP TO 15 GAMES',floor:0,sport:'basketball',maxGames:15,sameDayOnly:true,betTypes:[...require('./basketballPeriodMarkets').IDS,'basketball_rebounds_highest_under']},
 {id:'streak3no70short',label:'ANY TEAM 3+ GOALS IN A ROW — NO · GAP ≤1 · 70%',floor:70,sport:'football',maxGames:10,betTypes:['streak_3_no'],winnerGapMaxOne:true},
 {id:'footballU4570shortgap',label:'FOOTBALL UNDER 4.5 · GAP ≤1 · 70%',floor:70,sport:'football',maxGames:10,betTypes:['under45'],winnerGapMaxOne:true},
 {id:'footballMulti',label:'MULTI · MODEL RANKED · NO FLOOR · UP TO 20 GAMES',floor:0,sport:'football',maxGames:20,multi:true},
 ...todayLongShots.PLANS,
 ...DAILY_HIGH_ODDS
];
const onDemandFootballMarkets=new Set(require('./footballExtraMarkets').SPECIAL_TYPES.map(([id])=>id));
function removedMarket(c,plan){if(require('./footballExtraMarkets').removedSelection(c))return true;if(onDemandFootballMarkets.has(c.betType))return true;if(['first10_goals_under05','first20_goals_under05'].includes(c.betType))return true;if(!plan.upcomingOnly&&['oneup','oneup_extended','dc_under45'].includes(c.betType))return true;if(plan.multi)return (c.fullWinProbability??c.probability)==null||!c.multiQualified||!require('./multiPick').matches(c,c.multiWinnerGap);const t=String(c.betType||''),m=String(c.marketDesc||'');return /corners?|shots[_ ]?(?:on[_ ]?)?target/i.test(t+' '+m)||['over05','over15'].includes(t)||(plan.longShot&&!plan.hockeyHighestUnder&&(/over|under|total|(?:^|_)ou(?:_|$)/i.test(t+' '+m)||c.specifier?.includes('total=')));}
const isWinner=c=>['home_win','away_win','basketball_winner','hockey_winner','handball_winner','volleyball_winner','tennis_winner'].includes(c.betType);
const typeKey=c=>String(c.betType||`${normalizedSport(c)}:${c.marketId}`).toLowerCase();
const pairKey=c=>JSON.stringify([String(c.eventId),typeKey(c)]);
function finishBy(c,now,dateKey,days){
 const start=Date.parse(c.kickoffUtc||'');if(c.live===true||!Number.isFinite(start)||start<=now.getTime()+60000)return false;
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;
 const end=explicit?Date.parse(explicit):start+({football:3,tennis:(Number(c.bestOf||c.liveState?.bestOf)===5?6:4),basketball:4,hockey:4,handball:3,volleyball:4}[normalizedSport(c)]||6)*3600000;
 return Number.isFinite(end)&&end>start&&end<Date.parse(dateKey+'T23:00:00Z')+days*86400000;
}
function sameDay(c,now,dateKey){
 const start=Date.parse(c.kickoffUtc||'');
 return Number.isFinite(start)&&watParts(new Date(start)).date===dateKey&&finishBy(c,now,dateKey,0);
}
function withinWeek(c,now){const start=Date.parse(c.kickoffUtc||'');return c.live!==true&&Number.isFinite(start)&&start>now.getTime()+60000&&start<=now.getTime()+7*86400000;}
function resolveFloorSlot(headers,now=new Date()){
 const parts=watParts(now),manualTest=String(headers['x-matchday-run-mode']||'').toLowerCase()==='manual';
 if(manualTest){const id=String(headers['x-matchday-run-id']||'').trim();if(!/^[a-zA-Z0-9_-]{1,160}$/.test(id))throw Error('A valid manual run ID is required');return {dateKey:parts.date,slotKey:parts.date+'Tmanual-'+id,slotTime:`${String(Math.floor(parts.minute/60)).padStart(2,'0')}:${String(parts.minute%60).padStart(2,'0')}`,manualTest:true};}
 const slotTime=parts.minute>=18*60?'18:00':parts.minute>=7*60?'07:00':null;
 return slotTime?{dateKey:parts.date,slotKey:parts.date+'T'+slotTime,slotTime,manualTest:false}:null;
}
function dailyPriority(c,now,dateKey){if(sameDay(c,now,dateKey))return 0;const tomorrow=new Date(Date.parse(dateKey+'T12:00:00Z')+86400000).toISOString().slice(0,10);return sameDay(c,now,tomorrow)?1:2;}
function eligible(c,plan,now,dateKey,excluded){const p=winningProbability(c);return (!plan.sameDayOnly||c.betType!=='basketball_rebounds_highest_under'||c.highestAvailableUnder===true)&&(!plan.hockeyHighestUnder||c.hockeyHighestUnderQualified===true)&&!removedMarket(c,plan)&&c.h2hCheck?.allowed!==false&&!['goalkicks_under155','goalkicks_under165'].includes(c.betType)&&(!plan.winnerGapBelowOne||c.winnerGapBelowOneQualified===true)&&!require('./telegramPickMarkets').isHandicap(c)&&(plan.todayLongShot?todayLongShots.eligible(c,now,dateKey,plan.maxLegOdds,plan.dailyHighOdds):plan.sameDayOnly?sameDay(c,now,dateKey):plan.finishByTomorrow?finishBy(c,now,dateKey,1):plan.upcomingOnly?(c.live!==true&&Number.isFinite(Date.parse(c.kickoffUtc))&&Date.parse(c.kickoffUtc)>+now+60000):(plan.longShot?withinWeek(c,now):dailyPriority(c,now,dateKey)<2))&&Number(c.odds)>1&&Number.isFinite(p)&&p>=plan.floor&&p<=100&&(!plan.winnerGapAboveEight||c.winnerGapAboveEightQualified===true)&&(!plan.winnerGapMaxOne||c.winnerGapMaxOneQualified===true)&&(!plan.betTypes||plan.betTypes.includes(c.betType))&&(!plan.sport||normalizedSport(c)===plan.sport)&&(!plan.winnerGapOnly||(isWinner(c)&&c.winnerGapQualified===true))&&!excluded.has(pairKey(c));}
function buildPack(pool,{now=new Date(),dateKey=watParts(now).date,excluded=new Set(),plans=PLANS}={}){
 const chosen=plans.map(p=>({...p,selections:[]}));
 const signatures=new Set(),uses=new Map();
 for(const p of chosen){
  if(p.todayLongShot){const eligibleRows=pool.filter(c=>eligible(c,p,now,dateKey,excluded));if(p.dailyHighOdds)p.capacity={...oddsCapacity(eligibleRows,p.maxGames),sourceRows:pool.length};p.selections=chooseLongShot(eligibleRows,p,{now,signatures,uses});p.alternatives=[];if(p.selections.length){signatures.add(require('./telegramNext12h').ticketSignature(p.selections));for(const c of p.selections){const key=selectionKey(c);uses.set(key,(uses.get(key)||0)+1);}}continue;}
  const sorted=pool.filter(c=>eligible(c,p,now,dateKey,excluded)).sort((a,b)=>(p.longShot||p.multi?0:dailyPriority(a,now,dateKey)-dailyPriority(b,now,dateKey))||(p.longShot?(Number(b.odds)-Number(a.odds)||winningProbability(b)-winningProbability(a)):(winningProbability(b)-winningProbability(a)||Number(a.odds)-Number(b.odds)||selectionKey(a).localeCompare(selectionKey(b)))));
  const events=new Set();
  for(const c of sorted){if(events.has(String(c.eventId)))continue;p.selections.push(c);events.add(String(c.eventId));if(p.selections.length===p.maxGames)break;}
  if(p.targetOdds){const result=require('./telegramNext12h').bestProbabilityTicket(sorted,p.targetOdds,{maxSelections:p.maxGames});p.selections=result.reachedTarget?result.selections:[];}
  p.alternatives=[];for(const c of sorted){if(events.has(String(c.eventId)))continue;p.alternatives.push(c);events.add(String(c.eventId));if(p.alternatives.length===p.maxGames)break;}
 }
 return {dateKey,plans:chosen};
}
async function runFloorPicks(deps,ctx){
 const {redis,dateKey,slotKey,signal,manualTest=false,shouldAbort=()=>false}=ctx;if(!redis)throw Error('Persistent Redis storage is required');
 const check=async()=>{if(signal?.aborted||shouldAbort())throw Error('Probability batch cancelled');if(ctx.assertLease)await ctx.assertLease();};
 const activePlans=deps.plans||PLANS,build=deps.buildPack||buildPack,namespace=deps.namespace||'telegram:floor:v3';
 const packKey=`${namespace}:pack:${slotKey}`,stateKey=`${namespace}:state:${slotKey}`,dailyKey=deps.namespace?`${namespace}:used:${dateKey}`:`telegram:floor:used:${dateKey}`;
 let poolPromise;const loadPool=()=>poolPromise||(poolPromise=deps.loadPool({signal}));
 await check();let raw=await redis.get(packKey),pack;
 if(raw){pack=JSON.parse(raw);const missing=activePlans.filter(p=>!pack.plans.some(old=>old.id===p.id));if(missing.length){const excluded=manualTest?new Set():new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));const fresh=build(await loadPool(),{now:deps.now(),dateKey,excluded,plans:activePlans});pack.plans.push(...fresh.plans.filter(p=>missing.some(m=>m.id===p.id)));}pack.plans=pack.plans.map(p=>{const active=activePlans.find(a=>a.id===p.id);return active?{...p,...active,selections:p.selections.filter(c=>!['goalkicks_under155','goalkicks_under165'].includes(c.betType)).slice(0,active.maxGames)}:p;});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}else{const excluded=manualTest?new Set():new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));const pool=await loadPool();await check();pack=build(pool,{now:deps.now(),dateKey,excluded,plans:activePlans});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
 if(deps.preparePack){pack=await deps.preparePack(pack,{redis,dateKey,slotKey,loadPool,now:deps.now()});await check();await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
 const results=[];
 for(const plan of pack.plans.filter(p=>activePlans.some(active=>active.id===p.id))){await check();const states=(await redis.hVals(stateKey)).map(x=>JSON.parse(x)),previous=states.find(x=>x.id===plan.id);
  if(previous&&['completed','posting','booking','unknown','empty'].includes(previous.status)){results.push({id:plan.id,skipped:true,reason:previous.status});continue;}
  const save=async(status,extra={})=>{await redis.hSet(stateKey,plan.id,JSON.stringify({id:plan.id,status,...extra}));await redis.expire(stateKey,172800);};
  let uncertain=false,attemptedSelections=plan.selections;
  try{
   const validated=plan.selections.length?await deps.validate(plan.selections,{signal,plan}):[];await check();const requested=new Set(plan.selections.map(selectionKey));
   let selections=validated.filter(c=>requested.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,new Set()));
   const backups=plan.targetOdds?[]:plan.alternatives||[];for(let i=0;selections.length<plan.maxGames&&i<backups.length;){await check();const batch=backups.slice(i,i+Math.max(1,(plan.maxGames-selections.length)*2));i+=batch.length;const keys=new Set(batch.map(selectionKey));const fresh=await deps.validate(batch,{signal,plan});for(const c of fresh){if(selections.length>=plan.maxGames)break;if(keys.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,new Set())&&!selections.some(x=>String(x.eventId)===String(c.eventId)))selections.push(c);}}
   const initialFreshCount=selections.length,initialFreshOdds=selections.reduce((n,c)=>n*Number(c.odds),1);
   let duplicate=false,reserveCount=0;
   if(plan.todayLongShot){
    const prior=states.filter(s=>s.id!==plan.id&&(s.id.startsWith('today10k')||s.id.startsWith('dailyHigh'))&&['completed','posting','booking','unknown'].includes(s.status));
    const signatures=new Set(prior.filter(s=>s.selections?.length).map(s=>ticketSignature(s.selections)));
    const uses=new Map();for(const state of prior)for(const c of state.selections||[]){const key=selectionKey(c);uses.set(key,(uses.get(key)||0)+1);}
    duplicate=signatures.has(ticketSignature(selections));
    if(!selections.length||oddsBelowMinimum(initialFreshOdds,plan)||duplicate){
     const used=manualTest?new Set():new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));
     const current=new Set(selections.map(selectionKey)),seen=new Set();
     const reserve=(await loadPool()).filter(c=>!requested.has(selectionKey(c))&&!current.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,used))
      .sort((a,b)=>winningProbability(b)-winningProbability(a));
     const suggested=plan.dailyHighOdds?chooseLongShot([...selections,...reserve],plan,{now:deps.now(),signatures,uses}).filter(c=>!current.has(selectionKey(c))):[];
     const batch=[];for(const c of [...suggested,...reserve]){if(seen.has(String(c.eventId)))continue;seen.add(String(c.eventId));batch.push(c);if(batch.length===Math.max(15,suggested.length))break;}
     reserveCount=batch.length;
     await check();
     const keys=new Set(batch.map(selectionKey));
     const fresh=batch.length?await deps.validate(batch,{signal,plan}):[];
     await check();
     selections=chooseLongShot([...selections,...fresh.filter(c=>keys.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,used))],plan,{now:deps.now(),signatures,uses});
    }
   }
   if(plan.dailyHighOdds)selections.sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||winningProbability(b)-winningProbability(a));
   if(selections.length>plan.maxGames||new Set(selections.map(c=>String(c.eventId))).size!==selections.length)throw Error('Ticket selection validation failed');
   const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1);
   const oddsTooLow=plan.todayLongShot?oddsBelowMinimum(combinedOdds,plan):plan.targetOdds&&combinedOdds+1e-9<plan.targetOdds;
   if(!selections.length||selections.length<(plan.minGames||1)||oddsTooLow){await save('empty');await check();const detail=plan.todayLongShot?`${plan.capacity?`Pool: ${plan.capacity.sourceRows} modeled selections, ${plan.capacity.fixtures} eligible fixtures; maximum combined odds before fresh checks: ${plan.capacity.maxOdds.toFixed(2)}x. `:''}Planned ${plan.selections.length} legs; fresh check kept ${initialFreshCount} (${initialFreshCount?initialFreshOdds.toFixed(2):'no'} odds)${duplicate?'; matches an earlier ticket':''}. Checked ${reserveCount} replacement candidates. No distinct slip ${plan.dailyHighOdds?'at or above':'above'} ${plan.minimumOdds.toLocaleString('en-GB')} odds; no ticket booked.`:`no qualifying variation met the odds and game-count rules (${plan.floor===0?'no probability floor':plan.floor+'% floor'}); no ticket booked.`;await deps.send(`${plan.label}: ${detail}`,{signal});results.push({id:plan.id,reason:'insufficient_eligible_games',...(plan.todayLongShot?{detail}:{})});continue;}
   // Reserve before booking: an ambiguous upstream response cannot safely be
   // retried as a new ticket, and evening must not reuse its match/type pairs.
   attemptedSelections=selections;await save('booking',{selections});if(!manualTest){await redis.hSet(dailyKey,`${slotKey}:${plan.id}`,JSON.stringify(selections.map(pairKey)));await redis.expire(dailyKey,172800);}uncertain=true;if(deps.reserveSelections)await deps.reserveSelections(selections,{redis,slotKey,plan,now:deps.now()});await check();
   const booking=await deps.book(selections);await check();if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('Complete SportyBet booking code not confirmed');
   const ticketId=`${deps.namespace||'floor'}:${slotKey}:${plan.id}`;
   await deps.saveCode(redis,dateKey,{targetOdds:`MODEL FLOOR · ${plan.label} · ${ctx.slotTime} WAT`,combinedOdds,shareCode:booking.shareCode,generatedAt:deps.now().toISOString()});
   await deps.track(redis,{ticketId,label:`MODEL FLOOR · ${plan.label}`,targetOdds:plan.targetOdds||combinedOdds,combinedOdds,sportScope:plan.sport||'all',minProbability:plan.floor,selections,shareCode:booking.shareCode,shareURL:booking.shareURL,delivery:'prepared',liveMode:'prematch'});
   await save('posting',{selections,shareCode:booking.shareCode});
   await check();await deps.send(`${manualTest?'MANUAL TEST · ':''}${plan.label} · ${ctx.slotTime} WAT\n${booking.shareCode} · ${combinedOdds.toFixed(2)} odds${plan.todayLongShot&&combinedOdds<plan.targetOdds?' (fallback)':''}${booking.shareURL?"\n"+booking.shareURL:""}\n${selections.length} games · maximum ${plan.maxGames} · per-game floor ${plan.floor}%${plan.todayLongShot?'\nKickoff order (WAT) · odds · model probability\n'+todayLongShots.message(selections):''}`,{signal});
   await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});await save('completed',{selections,shareCode:booking.shareCode});results.push({id:plan.id,sent:true,shareCode:booking.shareCode,combinedOdds});
  }catch(e){await save(uncertain?'unknown':'failed',{...(uncertain?{selections:attemptedSelections}:{}),error:String(e.message).slice(0,180)});results.push({id:plan.id,error:uncertain?'Booking or delivery outcome unconfirmed; automatic duplicate suppressed.':String(e.message),retryable:!uncertain});if(signal?.aborted||shouldAbort())throw e;}
 }
 return {ticketsSent:results.filter(x=>x.sent).length,results,retryable:results.some(x=>x.retryable)};
}
module.exports={highOddsCapacity,PLANS,DAILY_HIGH_ODDS,typeKey,pairKey,sameDay,withinWeek,dailyPriority,resolveFloorSlot,eligible,buildPack,runFloorPicks};
