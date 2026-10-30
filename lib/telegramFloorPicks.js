'use strict';
const {watParts}=require('./watScheduler');
const {normalizedSport}=require('./telegramMixedSelector');
const {selectionKey}=require('./sportyPublicCache');
const {winningProbability}=require('./telegramNext12h');
const SPORTS=['football','tennis','basketball','hockey','handball','volleyball'];
const PLANS=[...SPORTS.flatMap(sport=>[
 {id:`${sport}70short`,label:`${sport.toUpperCase()} 70% · UP TO 10 GAMES`,floor:70,sport,maxGames:10},
 {id:`${sport}70long`,label:`${sport.toUpperCase()} LONG SHOT 70% · UP TO 30 GAMES`,floor:70,sport,maxGames:30,longShot:true}
]),{id:'all70winnersgap',label:'ALL SPORTS WIN ONLY 70% · UP TO 30 · ODDS GAP >5',floor:70,maxGames:30,winnerGapOnly:true}];
PLANS.push(
 {id:'corners70short',label:'CORNERS UNDER 11.5 / 12.5 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:require('./cornerMarkets').IDS},
 {id:'corners70long',label:'CORNERS UNDER 11.5 / 12.5 LONG SHOT · 70% · UP TO 30 GAMES',floor:70,sport:'football',maxGames:30,longShot:true,betTypes:require('./cornerMarkets').IDS},
 {id:'goalkicks15570short',label:'GOAL KICKS UNDER 15.5 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['goalkicks_under155']},
 {id:'goalkicks16570short',label:'GOAL KICKS UNDER 16.5 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['goalkicks_under165']}
);
PLANS.push(
 {id:'streak3no70short',winnerGapMaxOne:true,label:'ANY TEAM 3+ GOALS IN A ROW — NO · GAP ≤1 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['streak_3_no']},
 {id:'streak3no70long',winnerGapMaxOne:true,label:'ANY TEAM 3+ GOALS IN A ROW — NO LONG SHOT · GAP ≤1 · 70% · UP TO 30 GAMES',floor:70,sport:'football',maxGames:30,longShot:true,betTypes:['streak_3_no']}
);
PLANS.push(
 {id:'footballU4570shortgap',label:'FOOTBALL UNDER 4.5 · GAP ≤1 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['under45'],winnerGapMaxOne:true},
 {id:'footballU4570longgap',label:'FOOTBALL UNDER 4.5 LONG SHOT · GAP ≤1 · 70% · UP TO 30 GAMES',floor:70,sport:'football',maxGames:30,longShot:true,betTypes:['under45'],winnerGapMaxOne:true},
 {id:'corners12570shortgap',label:'CORNERS UNDER 12.5 · GAP ≤1 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['corners_under125'],winnerGapMaxOne:true},
 {id:'corners12570longgap',label:'CORNERS UNDER 12.5 LONG SHOT · GAP ≤1 · 70% · UP TO 30 GAMES',floor:70,sport:'football',maxGames:30,longShot:true,betTypes:['corners_under125'],winnerGapMaxOne:true}
);
PLANS.push(
 {id:'shotsUnder70shortgap',label:'SHOTS ON TARGET UNDER 13.5 / 12.5 · GAP ≤1 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['shots_target_under135','shots_target_under125'],winnerGapMaxOne:true},
 {id:'shotsUnder70longgap',label:'SHOTS ON TARGET UNDER 13.5 / 12.5 LONG SHOT · GAP ≤1 · 70% · UP TO 20 GAMES',floor:70,sport:'football',maxGames:20,longShot:true,betTypes:['shots_target_under135','shots_target_under125'],winnerGapMaxOne:true},
 {id:'shotsOver70shortgap',label:'SHOTS ON TARGET OVER 4.5 · GAP >8 · 70% · UP TO 10 GAMES',floor:70,sport:'football',maxGames:10,betTypes:['shots_target_over45'],winnerGapAboveEight:true},
 {id:'shotsOver70longgap',label:'SHOTS ON TARGET OVER 4.5 LONG SHOT · GAP >8 · 70% · UP TO 20 GAMES',floor:70,sport:'football',maxGames:20,longShot:true,betTypes:['shots_target_over45'],winnerGapAboveEight:true}
);
// Current Telegram catalogue. Keep the combined 11.5/12.5 corner plans.
const RETIRED=new Set(['tennis70short','corners70short','shotsOver70shortgap','shotsUnder70shortgap','football70short','basketball70short','hockey70short','handball70short','volleyball70short','goalkicks15570short','goalkicks16570short','corners12570shortgap','corners12570longgap']);
for(let i=PLANS.length-1;i>=0;i--)if(RETIRED.has(PLANS[i].id))PLANS.splice(i,1);
for(const plan of PLANS)if(plan.longShot){plan.maxGames=20;plan.label=plan.label.replace(/UP TO \d+ GAMES/,'UP TO 20 GAMES');}
PLANS.push(...['over05','over15'].map(type=>({id:type+'70gapshort',label:(type==='over05'?'OVER 0.5':'OVER 1.5')+' GOALS · GAP <1 · 70% · UP TO 20 GAMES',floor:70,sport:'football',maxGames:20,betTypes:[type],winnerGapBelowOne:true})));
const isWinner=c=>['home_win','away_win','basketball_winner','hockey_winner','handball_winner','volleyball_winner','tennis_winner'].includes(c.betType);
const typeKey=c=>String(c.betType||`${normalizedSport(c)}:${c.marketId}`).toLowerCase();
const pairKey=c=>JSON.stringify([String(c.eventId),typeKey(c)]);
function sameDay(c,now,dateKey){
 const start=Date.parse(c.kickoffUtc||'');if(c.live===true||!Number.isFinite(start)||start<=now.getTime()+60000||new Date(start+3600000).toISOString().slice(0,10)!==dateKey)return false;
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;
 const end=explicit?Date.parse(explicit):start+({football:3,tennis:(Number(c.bestOf||c.liveState?.bestOf)===5?6:4),basketball:4,hockey:4,handball:3,volleyball:4}[normalizedSport(c)]||6)*3600000;
 return Number.isFinite(end)&&end>start&&end<Date.parse(dateKey+'T23:00:00Z');
}
function withinWeek(c,now){const start=Date.parse(c.kickoffUtc||'');return c.live!==true&&Number.isFinite(start)&&start>now.getTime()+60000&&start<=now.getTime()+7*86400000;}
function resolveFloorSlot(headers,now=new Date()){
 const parts=watParts(now),manualTest=String(headers['x-matchday-run-mode']||'').toLowerCase()==='manual';
 if(manualTest){const id=String(headers['x-matchday-run-id']||'').trim();if(!/^[a-zA-Z0-9_-]{1,160}$/.test(id))throw Error('A valid manual run ID is required');return {dateKey:parts.date,slotKey:parts.date+'Tmanual-'+id,slotTime:`${String(Math.floor(parts.minute/60)).padStart(2,'0')}:${String(parts.minute%60).padStart(2,'0')}`,manualTest:true};}
 const slotTime=parts.minute>=18*60?'18:00':parts.minute>=7*60?'07:00':null;
 return slotTime?{dateKey:parts.date,slotKey:parts.date+'T'+slotTime,slotTime,manualTest:false}:null;
}
function dailyPriority(c,now,dateKey){if(sameDay(c,now,dateKey))return 0;const tomorrow=new Date(Date.parse(dateKey+'T12:00:00Z')+86400000).toISOString().slice(0,10);return sameDay(c,now,tomorrow)?1:2;}
function eligible(c,plan,now,dateKey,excluded){const p=winningProbability(c);return c.h2hCheck?.allowed!==false&&!['goalkicks_under155','goalkicks_under165'].includes(c.betType)&&(!plan.winnerGapBelowOne||c.winnerGapBelowOneQualified===true)&&!require('./telegramPickMarkets').isHandicap(c)&&(plan.upcomingOnly?(c.live!==true&&Number.isFinite(Date.parse(c.kickoffUtc))&&Date.parse(c.kickoffUtc)>+now+60000):(plan.longShot?withinWeek(c,now):dailyPriority(c,now,dateKey)<2))&&Number(c.odds)>1&&Number.isFinite(p)&&p>=plan.floor&&p<=100&&(!plan.winnerGapAboveEight||c.winnerGapAboveEightQualified===true)&&(!plan.winnerGapMaxOne||c.winnerGapMaxOneQualified===true)&&(!plan.betTypes||plan.betTypes.includes(c.betType))&&(!plan.sport||normalizedSport(c)===plan.sport)&&(!plan.winnerGapOnly||(isWinner(c)&&c.winnerGapQualified===true))&&!excluded.has(pairKey(c));}
function buildPack(pool,{now=new Date(),dateKey=watParts(now).date,excluded=new Set(),plans=PLANS}={}){
 const chosen=plans.map(p=>({...p,selections:[]}));
 for(const p of chosen){
  const sorted=pool.filter(c=>eligible(c,p,now,dateKey,excluded)).sort((a,b)=>(p.longShot?0:dailyPriority(a,now,dateKey)-dailyPriority(b,now,dateKey))||(p.longShot?(Number(b.odds)-Number(a.odds)||winningProbability(b)-winningProbability(a)):(winningProbability(b)-winningProbability(a)||Number(a.odds)-Number(b.odds)||selectionKey(a).localeCompare(selectionKey(b)))));
  const events=new Set();
  for(const c of sorted){if(events.has(String(c.eventId)))continue;p.selections.push(c);events.add(String(c.eventId));if(p.selections.length===p.maxGames)break;}
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
 if(raw){pack=JSON.parse(raw);const missing=activePlans.filter(p=>!pack.plans.some(old=>old.id===p.id));if(missing.length){const excluded=manualTest?new Set():new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));const fresh=build(await loadPool(),{now:deps.now(),dateKey,excluded});pack.plans.push(...fresh.plans.filter(p=>missing.some(m=>m.id===p.id)));}pack.plans=pack.plans.map(p=>{const active=activePlans.find(a=>a.id===p.id);return active?{...p,...active,selections:p.selections.filter(c=>!['goalkicks_under155','goalkicks_under165'].includes(c.betType)).slice(0,active.maxGames)}:p;});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}else{const excluded=manualTest?new Set():new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));const pool=await loadPool();await check();pack=build(pool,{now:deps.now(),dateKey,excluded});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
 if(deps.preparePack){pack=await deps.preparePack(pack,{redis,dateKey,slotKey,loadPool,now:deps.now()});await check();await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
 const results=[];
 for(const plan of pack.plans.filter(p=>activePlans.some(active=>active.id===p.id))){await check();const previous=(await redis.hVals(stateKey)).map(x=>JSON.parse(x)).find(x=>x.id===plan.id);
  if(previous&&['completed','posting','booking','unknown','empty'].includes(previous.status)){results.push({id:plan.id,skipped:true,reason:previous.status});continue;}
  const save=async(status,extra={})=>{await redis.hSet(stateKey,plan.id,JSON.stringify({id:plan.id,status,...extra}));await redis.expire(stateKey,172800);};
  let uncertain=false,attemptedSelections=plan.selections;
  try{
   const validated=await deps.validate(plan.selections,{signal,plan});await check();const requested=new Set(plan.selections.map(selectionKey));
   const selections=validated.filter(c=>requested.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,new Set()));
   const backups=plan.targetOdds?[]:plan.alternatives||[];for(let i=0;selections.length<plan.maxGames&&i<backups.length;){await check();const batch=backups.slice(i,i+Math.max(1,(plan.maxGames-selections.length)*2));i+=batch.length;const keys=new Set(batch.map(selectionKey));const fresh=await deps.validate(batch,{signal,plan});for(const c of fresh){if(selections.length>=plan.maxGames)break;if(keys.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,new Set())&&!selections.some(x=>String(x.eventId)===String(c.eventId)))selections.push(c);}}
   if(selections.length>plan.maxGames||new Set(selections.map(c=>String(c.eventId))).size!==selections.length)throw Error('Ticket selection validation failed');
   if(!selections.length||selections.length<(plan.minGames||1)||plan.targetOdds&&selections.reduce((n,c)=>n*Number(c.odds),1)+1e-9<plan.targetOdds){await save('empty');await check();await deps.send(`${plan.label}: no qualifying variation met the probability, odds and game-count rules at ${plan.floor}%; no ticket booked.`,{signal});results.push({id:plan.id,reason:'insufficient_eligible_games'});continue;}
   // Reserve before booking: an ambiguous upstream response cannot safely be
   // retried as a new ticket, and evening must not reuse its match/type pairs.
   attemptedSelections=selections;await save('booking',{selections});if(!manualTest){await redis.hSet(dailyKey,`${slotKey}:${plan.id}`,JSON.stringify(selections.map(pairKey)));await redis.expire(dailyKey,172800);}uncertain=true;if(deps.reserveSelections)await deps.reserveSelections(selections,{redis,slotKey,plan,now:deps.now()});await check();
   const booking=await deps.book(selections);await check();if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('Complete SportyBet booking code not confirmed');
   const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1),ticketId=`${deps.namespace||'floor'}:${slotKey}:${plan.id}`;
   await deps.saveCode(redis,dateKey,{targetOdds:`MODEL FLOOR · ${plan.label} · ${ctx.slotTime} WAT`,combinedOdds,shareCode:booking.shareCode});
   await deps.track(redis,{ticketId,label:`MODEL FLOOR · ${plan.label}`,targetOdds:plan.targetOdds||combinedOdds,combinedOdds,sportScope:plan.sport||'all',selections,shareCode:booking.shareCode,shareURL:booking.shareURL,delivery:'prepared',liveMode:'prematch'});
   await save('posting',{selections,shareCode:booking.shareCode});
   await check();await deps.send(`${manualTest?'MANUAL TEST · ':''}${plan.label} · ${ctx.slotTime} WAT\n${booking.shareCode} · ${combinedOdds.toFixed(2)} odds${booking.shareURL?"\n"+booking.shareURL:""}\n${selections.length} games · maximum ${plan.maxGames} · per-game floor ${plan.floor}%`,{signal});
   await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});await save('completed',{selections,shareCode:booking.shareCode});results.push({id:plan.id,sent:true,shareCode:booking.shareCode,combinedOdds});
  }catch(e){await save(uncertain?'unknown':'failed',{...(uncertain?{selections:attemptedSelections}:{}),error:String(e.message).slice(0,180)});results.push({id:plan.id,error:uncertain?'Booking or delivery outcome unconfirmed; automatic duplicate suppressed.':String(e.message),retryable:!uncertain});if(signal?.aborted||shouldAbort())throw e;}
 }
 return {ticketsSent:results.filter(x=>x.sent).length,results,retryable:results.some(x=>x.retryable)};
}
module.exports={PLANS,typeKey,pairKey,sameDay,withinWeek,dailyPriority,resolveFloorSlot,eligible,buildPack,runFloorPicks};
