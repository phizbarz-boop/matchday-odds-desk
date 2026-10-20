'use strict';
const {watParts}=require('./watScheduler');
const {normalizedSport}=require('./telegramMixedSelector');
const {selectionKey}=require('./sportyPublicCache');
const {winningProbability}=require('./telegramNext12h');
const SPORTS=['football','tennis','basketball','hockey','handball','volleyball'];
const PLANS=[...SPORTS.flatMap(sport=>[
 {id:`${sport}70short`,label:`${sport.toUpperCase()} 70% · 10 GAMES`,floor:70,sport,maxGames:10},
 {id:`${sport}70long`,label:`${sport.toUpperCase()} LONG SHOT 70% · 40 GAMES`,floor:70,sport,maxGames:40,longShot:true}
]),{id:'all70winnersgap',label:'ALL SPORTS WIN ONLY 70% · ODDS GAP >5',floor:70,maxGames:30,winnerGapOnly:true}];
const isWinner=c=>['home_win','away_win','basketball_winner','hockey_winner','handball_winner','volleyball_winner','tennis_winner'].includes(c.betType);
const typeKey=c=>String(c.betType||`${normalizedSport(c)}:${c.marketId}`).toLowerCase();
const pairKey=c=>JSON.stringify([String(c.eventId),typeKey(c)]);
function sameDay(c,now,dateKey){
 const start=Date.parse(c.kickoffUtc||'');if(c.live===true||!Number.isFinite(start)||start<=now.getTime()+60000||watParts(new Date(start)).date!==dateKey)return false;
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;
 const end=explicit?Date.parse(explicit):start+({football:3,tennis:(Number(c.bestOf||c.liveState?.bestOf)===5?6:4),basketball:4,hockey:4,handball:3,volleyball:4}[normalizedSport(c)]||6)*3600000;
 return Number.isFinite(end)&&end>start&&end<Date.parse(dateKey+'T23:00:00Z');
}
function eligible(c,plan,now,dateKey,excluded){const p=winningProbability(c);return sameDay(c,now,dateKey)&&Number(c.odds)>1&&Number.isFinite(p)&&p>=plan.floor&&p<=100&&(!plan.sport||normalizedSport(c)===plan.sport)&&(!plan.winnerGapOnly||(isWinner(c)&&c.winnerGapQualified===true))&&!excluded.has(pairKey(c));}
function buildPack(pool,{now=new Date(),dateKey=watParts(now).date,excluded=new Set()}={}){
 const plans=PLANS.map(p=>({...p,selections:[]}));
 for(const p of plans){
  const sorted=pool.filter(c=>eligible(c,p,now,dateKey,excluded)).sort((a,b)=>p.longShot?(Number(b.odds)-Number(a.odds)||winningProbability(b)-winningProbability(a)):(winningProbability(b)-winningProbability(a)||Number(a.odds)-Number(b.odds)||selectionKey(a).localeCompare(selectionKey(b))));
  const events=new Set();
  for(const c of sorted){if(events.has(String(c.eventId)))continue;p.selections.push(c);events.add(String(c.eventId));if(p.selections.length===p.maxGames)break;}
 }
 return {dateKey,plans};
}
async function runFloorPicks(deps,ctx){
 const {redis,dateKey,slotKey,signal,shouldAbort=()=>false}=ctx;if(!redis)throw Error('Persistent Redis storage is required');
 const check=async()=>{if(signal?.aborted||shouldAbort())throw Error('Probability batch cancelled');if(ctx.assertLease)await ctx.assertLease();};
 const packKey=`telegram:floor:v2:pack:${slotKey}`,stateKey=`telegram:floor:v2:state:${slotKey}`,dailyKey=`telegram:floor:used:${dateKey}`;
 await check();let raw=await redis.get(packKey),pack;
 if(raw)pack=JSON.parse(raw);else{const excluded=new Set((await redis.hVals(dailyKey)).flatMap(x=>JSON.parse(x)));const pool=await deps.loadPool({signal});await check();pack=buildPack(pool,{now:deps.now(),dateKey,excluded});await redis.set(packKey,JSON.stringify(pack),{EX:172800});}
 const results=[];
 for(const plan of pack.plans.filter(p=>PLANS.some(active=>active.id===p.id))){await check();const previous=(await redis.hVals(stateKey)).map(x=>JSON.parse(x)).find(x=>x.id===plan.id);
  if(previous&&['completed','posting','booking','unknown','empty'].includes(previous.status)){results.push({id:plan.id,skipped:true,reason:previous.status});continue;}
  const save=async(status,extra={})=>{await redis.hSet(stateKey,plan.id,JSON.stringify({id:plan.id,status,...extra}));await redis.expire(stateKey,172800);};
  let uncertain=false;
  try{
   const validated=await deps.validate(plan.selections,{signal,plan});await check();const requested=new Set(plan.selections.map(selectionKey));
   const selections=validated.filter(c=>requested.has(selectionKey(c))&&eligible(c,plan,deps.now(),dateKey,new Set()));
   if(selections.length>plan.maxGames||new Set(selections.map(c=>String(c.eventId))).size!==selections.length)throw Error('Ticket selection validation failed');
   if(selections.length<plan.maxGames){await save('empty');await check();await deps.send(`${plan.label}: only ${selections.length}/${plan.maxGames} eligible same-day games at 70%; no ticket booked.`,{signal});results.push({id:plan.id,reason:'insufficient_eligible_games'});continue;}
   // Reserve before booking: an ambiguous upstream response cannot safely be
   // retried as a new ticket, and evening must not reuse its match/type pairs.
   await save('booking',{selections});await redis.hSet(dailyKey,`${slotKey}:${plan.id}`,JSON.stringify(selections.map(pairKey)));await redis.expire(dailyKey,172800);uncertain=true;await check();
   const booking=await deps.book(selections);await check();if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Error('Complete SportyBet booking code not confirmed');
   const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1),ticketId=`floor:${slotKey}:${plan.id}`;
   await deps.saveCode(redis,dateKey,{targetOdds:`MODEL FLOOR · ${plan.label} · ${ctx.slotTime} WAT`,combinedOdds,shareCode:booking.shareCode});
   await deps.track(redis,{ticketId,label:`MODEL FLOOR · ${plan.label}`,targetOdds:combinedOdds,combinedOdds,sportScope:plan.sport||'all',selections,shareCode:booking.shareCode,shareURL:booking.shareURL,delivery:'prepared',liveMode:'prematch'});
   await save('posting',{selections,shareCode:booking.shareCode});
   await check();await deps.send(`${plan.label} · ${ctx.slotTime} WAT\n${booking.shareCode} · ${combinedOdds.toFixed(2)} odds${booking.shareURL?"\n"+booking.shareURL:""}\n${selections.length} games · per-game floor ${plan.floor}%`,{signal});
   await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});await save('completed',{selections,shareCode:booking.shareCode});results.push({id:plan.id,sent:true,shareCode:booking.shareCode,combinedOdds});
  }catch(e){await save(uncertain?'unknown':'failed',{...(uncertain?{selections:plan.selections}:{}),error:String(e.message).slice(0,180)});results.push({id:plan.id,error:uncertain?'Booking or delivery outcome unconfirmed; automatic duplicate suppressed.':String(e.message),retryable:!uncertain});if(signal?.aborted||shouldAbort())throw e;}
 }
 return {ticketsSent:results.filter(x=>x.sent).length,results,retryable:results.some(x=>x.retryable)};
}
module.exports={PLANS,typeKey,pairKey,sameDay,eligible,buildPack,runFloorPicks};
