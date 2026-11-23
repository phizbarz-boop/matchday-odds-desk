'use strict';
const {randomUUID}=require('node:crypto');
const sporty=require('./sportybet');
const {RULES:RDP_RULES}=require('../jobs/rollover-run-state.cjs');
const {modelFromStats}=require('./sportyFootballModel');
const {liveState,ongoing}=require('./liveModel');
const learning=require('./strategyLearning');
const teamPrior=require('./vfTeamPrior');
const teamGoal=require('./teamGoalMarket');
const SPORT='sr:sport:202120001', KEY='virtual-rollover:v1', START=250000;
const STANDARD=Object.freeze({key:KEY,minOdds:1.12,maxOdds:1.30,maxLegs:2,opening:START,marketFields:Object.freeze(['o05','u45','u55','h35']),title:'ROLL OVER · VIRTUAL FOOTBALL'});
const RDP=Object.freeze({key:'virtual-rollover:rdp:v1',minOdds:1.15,maxOdds:1.55,maxLegs:RDP_RULES.maxLegs,opening:200000,marketFields:Object.freeze(['o05','u45','u55','h35']),whitelist:true,title:'RDP ROLL OVER · VIRTUAL FOOTBALL'});
const RDP_WHITELIST={
 u55:{spain:['ESP','RAY','VCF'],italy:['BFC','FRO','LEC']},
 h35:{spain:['ESP','GET','RAY'],italy:['BFC','LEC']},
 o05:{england:['CHE','LIV','MCI','MUN','NEW']},
 u45:{spain:['BIL','ESP','RAY','RSO','VCF'],italy:['BFC','LEC','UDI']}
};
const BAND_TEAMS={
 u55:{spain:['ESP','RAY','VCF'],italy:['BFC','FRO','LEC']},
 h35:{spain:['ESP','GET','RAY'],italy:['BFC','LEC']},
 o05:{england:['CHE','LIV','MCI','MUN','NEW']},
 u45:{spain:['BIL','ESP','RAY','RSO','VCF'],italy:['BFC','LEC','UDI']}
};
const BAND=Object.freeze({key:'virtual-rollover:band:v1',minOdds:1.12,maxOdds:1.19,maxLegs:2,maxLegOdds:1.19,opening:150000,takeProfitWins:20,marketFields:Object.freeze(['u55','h35','o05','u45']),band:true,nextRound:true,title:'WHITELIST BAND · VIRTUAL FOOTBALL'});
const TIMES=Array.from({length:48},(_,i)=>String(i>>1).padStart(2,'0')+':'+(i%2?'30':'00'));
const watSlot=ms=>{const parts=new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(ms));const hour=parts.find(part=>part.type==='hour').value;const minute=Number(parts.find(part=>part.type==='minute').value)<30?'00':'30';return hour+':'+minute;};
const MARKETS={'4.5:13':['Under 4.5 Goals','u45'],'0.5:12':['Over 0.5 Goals','o05'],'1.5:12':['Over 1.5 Goals','o15'],'5.5:13':['Under 5.5 Goals','u55']};
const money=c=>'₦'+(c/100).toLocaleString('en-NG',{minimumFractionDigits:2,maximumFractionDigits:2});
const idOf=x=>String(x?.eventId??x?.event_id??'');
const label=x=>typeof x==='string'?x:String(x?.name??'');
const freshState=(lane=STANDARD)=>({balance:lane.opening??START,step:0,count:0,day:null,pending:null,last:null,watch:[],history:[],lastSlot:null});
async function stateOf(redis,lane=STANDARD){const raw=await redis.get(lane.key);if(!raw)return freshState(lane);const state=JSON.parse(raw);if(lane.opening&&!state.pending&&state.step===0&&(state.balance===START||(lane===RDP&&[100000,200000,500000].includes(state.balance)&&state.balance!==lane.opening)))state.balance=lane.opening;return state;}
async function resetRdpCodeCount(redis,{orderId,dateKey}){
 const lock=RDP.key+':lock',token=randomUUID();
 if(await redis.set(lock,token,{NX:true,EX:30})!=='OK')return {status:'busy'};
 try{
  const state=await stateOf(redis,RDP);
  const applied=state.lossResetDay===dateKey?state.lossResetOrders||[]:[];
  if(applied.includes(orderId))return {status:'already_reset'};
  state.day=dateKey;
  state.count=0;
  state.lossResetDay=dateKey;
  state.lossResetOrders=[...applied,orderId];
  const saved=await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then redis.call("SET",KEYS[2],ARGV[2]); return 1 end',
   {keys:[lock,RDP.key],arguments:[token,JSON.stringify(state)]});
  return {status:saved===1?'reset':'busy'};
 }finally{
  await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end',{keys:[lock],arguments:[token]}).catch(()=>{});
 }
}
function totals(e,fixture,lane){
 return sporty.flattenDetailedMarkets(e,{...fixture,sport:'Virtual Football'}).flatMap(r=>{
  const line=String(r.specifier??'').match(/^total=(0\.5|1\.5|2\.5|3\.5|4\.5|5\.5)$/)?.[1];
  const listed=r.marketId==='18'?MARKETS[line+':'+r.outcomeId]:null;
  const marketName=String(r.marketDesc||'').toLowerCase();
  const halfName=r.marketId==='68'||/(?:1st|first)\s+half|halftime|half time|half-time/.test(marketName);
  const halfLines={'1.5':['1st Half Under 1.5','h15'],'2.5':['1st Half Under 2.5','h25'],'3.5':['1st Half Under 3.5','h35']};
  const half=halfLines[line]&&String(r.outcomeId)==='13'&&halfName?halfLines[line]:null;
  const halfOver=line==='0.5'&&String(r.outcomeId)==='12'&&halfName&&!/\b(?:home|away|team)\b/.test(marketName)?['1st Half Over 0.5','ho05']:null;
  const under25=line==='2.5'&&String(r.outcomeId)==='13'&&r.marketId==='18'&&!halfName?['Under 2.5','u25']:null;
  const outcomeName=String(r.outcomeDesc||'').toLowerCase();
  const gg=(r.marketId==='29'||/gg\/ng|both teams to score|\bbtts\b/.test(marketName))&&(String(r.outcomeId)==='74'||/\byes\b|^gg$/.test(outcomeName))&&!/\bno\b|\bng\b/.test(outcomeName)?['GG Yes','gg']:null;
  const teamLines=[['home','0.5','over',fixture.home+' Over 0.5','t05','home'],['away','0.5','over',fixture.away+' Over 0.5','t05','away'],['home','1.5','under',fixture.home+' Under 1.5','tu15','home'],['away','1.5','under',fixture.away+' Under 1.5','tu15','away'],['home','2.5','under',fixture.home+' Under 2.5','tu25','home'],['away','2.5','under',fixture.away+' Under 2.5','tu25','away']];
  const team=teamLines.find(([side,teamLine,direction])=>teamGoal.isTeamTotalSelection(r,side,teamLine,direction));
  const hit=listed||half||halfOver||under25||gg||(team?[team[3],team[4],team[5]]:null);
  return hit&&r.eventId===fixture.eventId&&r.odds>1&&r.odds<=(lane.maxLegOdds??lane.maxOdds)&&(!lane.marketFields||lane.marketFields.includes(hit[1]))?[{...fixture,marketId:r.marketId,outcomeId:r.outcomeId,specifier:r.specifier,odds:r.odds,pick:hit[0],field:hit[1],...(hit[2]?{side:hit[2]}:{})}]:[];
 });
}
function rdpVirtualCountry(...labels){
 const rules=[['spain','spain'],['spanish','spain'],['españa','spain'],['italy','italy'],['italian','italy'],['italia','italy'],['germany','germany'],['german','germany'],['deutschland','germany'],['france','france'],['french','france'],['français','france'],['england','england'],['english','england']];
 const found=new Set();
 for(const value of labels){
  const name=label(value).toLowerCase();
  if(!name)continue;
  for(const [word,country] of rules)if(name===word||new RegExp('(?:^|[^a-z])'+word+'(?:[^a-z]|$)','i').test(name))found.add(country);
 }
 return found.size===1?[...found][0]:null;
}
const isRdpVirtualCountry=country=>['spain','france','england'].includes(country);
function bandAllowed(row){
 const teams=BAND_TEAMS[row?.field]?.[rdpVirtualCountry(row?.country,row?.league)];
 return !!teams&&teams.some(code=>teamListed(row?.home,new Set([code]))||teamListed(row?.away,new Set([code])));
}
function rdpWhitelistAllowed(row){
 const listed=RDP_WHITELIST[row?.field]?.[rdpVirtualCountry(row?.country,row?.league)];
 if(!listed)return false;
 const names=row?.field==='tu25'?(row.side==='home'?[row.home]:row.side==='away'?[row.away]:[row.home,row.away]):[row.home,row.away];
 return names.some(name=>listed.some(code=>teamListed(name,new Set([code]))));
}
function deskSession(input={}){
 const maxUnder=input.session==='max-under';
 const botMix=input.session==='bot-mix';
 const wide=input.session==='higher'||maxUnder||botMix;
 return {higher:input.session==='higher',maxUnder,botMix,horizonMs:wide?6*3600000:1800000,maxLegOdds:maxUnder||botMix?20:wide?5:null};
}
async function fixtures(client,now,signal,lane=STANDARD,horizonMs=1800000){
 const pages=horizonMs>1800000?4:1;
 const seen=new Set();
 const board=[];
 for(let page=1;page<=pages;page++){
  const fields=lane.marketFields||[];
  const ids=new Set(['18']);
  if(['h15','h25','h35','ho05'].some(field=>fields.includes(field)))ids.add('68');
  if(['t05','tu15','tu25'].some(field=>fields.includes(field))){ids.add('19');ids.add('20');}
  if(fields.includes('gg'))ids.add('29');
  const payload=await client.fetchPrematchPage(SPORT,page,100,{marketIds:[...ids].join(','),timeoutMs:7000});
  signal?.throwIfAborted();
  const events=sporty.extractUpcomingEvents(payload).events;
  if(!events.length)break;
  let latest=0;
  for(const e of events){
   const f=sporty.fixtureContext(e,'Virtual Football');
   const sport=String(e.sport?.id??e.sportId??'');
   const tournament=label(f.tournament);
   const league=String(e.tournamentId??e.tournament?.id??(label(f.category)&&tournament?label(f.category)+'/'+tournament:''));
   const kickoffUtc=sporty.normalizeOutcome(e).kickoffUtc;
   const kick=Date.parse(kickoffUtc);
   if(Number.isFinite(kick))latest=Math.max(latest,kick);
   if(require('./isSimFixture').product(e)==='srl'||(sport&&sport!==SPORT)||!/^sr:match:\d+$/.test(f.eventId)||seen.has(f.eventId)||e.banned||ongoing(e)||!f.home||!f.away||f.home===f.away||!league||!(kick>now+20000&&kick<now+horizonMs))continue;
   const country=rdpVirtualCountry(f.category,f.tournament);
   seen.add(f.eventId);
   const fixture={eventId:f.eventId,home:f.home,away:f.away,kickoffUtc,league,...(country?{country}:{})};
   board.push({fixture,rows:totals(e,fixture,lane)});
  }
  if(events.length<100||latest>now+horizonMs)break;
 }
 return board.sort((a,b)=>Date.parse(a.fixture.kickoffUtc)-Date.parse(b.fixture.kickoffUtc));
}
async function resultFor(client,f,signal,observed=null,clock=Date.now){
 signal?.throwIfAborted();
 const payload=await client.fetchEventDetail(f.eventId);
 const root=payload?.data??payload, e=root?.event??root;
 if(idOf(e)!==f.eventId)return null;
 const context=sporty.fixtureContext(e,'Virtual Football');
 if(context.home!==f.home||context.away!==f.away)return null;
 const live=liveState(e);
 if(/\b(cancelled|canceled|void|abandoned)\b/i.test(live.phase))return {void:true};
 const virtualEnded=/^end$/i.test(String(e.matchStatus??'').trim());
 if((!virtualEnded&&!/\b(?:FT|full[- ]?time|finished|ended)\b/i.test(live.phase))||/half[- ]?time|extra time/i.test(live.phase)){
  if(observed&&ongoing(e)&&clock()>=Date.parse(f.kickoffUtc))observed.startedObservedAt??=new Date(clock()).toISOString();
  return null;
 }
 if(observed)observed.finishedObservedAt??=new Date(clock()).toISOString();
 // Use explicit regulation score or the full-time event score, never a price or partial score.
 const regulation=require('./liveModel').scorePair(e.fullTimeScore??e.regulationScore??(virtualEnded?e.setScore:null));
 const {homeScore:h,awayScore:a}=regulation?{homeScore:regulation.home,awayScore:regulation.away}:live;
 if(!Number.isInteger(h)||!Number.isInteger(a)||h<0||a<0)return null;
 const halves=require('./liveModel').scoreSeries(e.gameScore),first=halves[0];
 const fh=first&&Number.isInteger(first.home+first.away)?first.home+first.away:null;
 return Number.isInteger(fh)?{h,a,fh}:{h,a};
}
function predict(f,history,now,formPanel){
 const cutoff=Math.min(now,Date.parse(f.kickoffUtc));
 const past=history.filter(x=>x.league===f.league&&x.eventId!==f.eventId&&x.verifiedAt<cutoff&&x.verifiedAt>=cutoff-7*86400000);
 const form=team=>past.filter(x=>x.home===team||x.away===team).sort((a,b)=>b.verifiedAt-a.verifiedAt).slice(0,12)
  .map(x=>x.home===team?[x.h,x.a]:[x.a,x.h]);
 const h=formPanel?.home??form(f.home),a=formPanel?.away??form(f.away);
 if(h.length<5||a.length<5)return null;
 const avg=(r,i)=>r.reduce((n,x)=>n+x[i],0)/r.length;
 return modelFromStats(f,{...f,capturedAt:new Date(now).toISOString(),homeGoalsFor:avg(h,0),homeGoalsAgainst:avg(h,1),awayGoalsFor:avg(a,0),awayGoalsAgainst:avg(a,1)});
}
function goalProbability(model,row){
 const field=row?.field||row;
 const {goalLambdaHome:h,goalLambdaAway:a}=model;
 const ready=[h,a].every(value=>Number.isFinite(value)&&value>=0);
 if(field==='ho05'&&ready)return Math.min(100,Math.round((1-Math.exp(-(h+a)/2))*1000)/10);
 if(field==='u25'&&ready)return poissonUnder(h+a,2);
 if(field==='gg'&&ready)return Math.min(100,Math.round((1-Math.exp(-h))*(1-Math.exp(-a))*1000)/10);
 if((field==='t05'||field==='tu15'||field==='tu25')&&ready){
  const lambda=row?.side==='away'?a:h;
  const chance=field==='t05'?1-Math.exp(-lambda):poissonUnder(lambda,field==='tu25'?2:1)/100;
  return Math.min(100,Math.round(chance*1000)/10);
 }
 if(field==='o15'&&Number.isFinite(model.o15))return model.o15;
 const halfLimit={h15:1,h25:2,h35:3};
 if(field!=='u55'&&halfLimit[field]==null)return model[field];
 if(!ready)return null;
 const lambda=halfLimit[field]!=null?(h+a)/2:h+a,limit=halfLimit[field]??5;
 let term=Math.exp(-lambda),sum=term;
 for(let goals=1;goals<=limit;goals++){term*=lambda/goals;sum+=term;}
 return Math.min(100,100*sum);
}
const CLEAN_TEAMS={
 u45:new Set(['RAY','MON']),
 u55:new Set(['BFC','NAP','MON','ALA','CEL','ELC','GET','OSA','RAY','RBB','MAI','SVE']),
 o05:new Set(['NFO','BMU','SGE','VFB','LEH']),
 h35:new Set(['NFO','FIO','INT','MON','ROM','ALA','OSA','RAY','RBB','VIL','MAI','SGE','AUX','PFC','B29','LEN']),
 h15:new Set(['ALA','ESP','RAY','VCF']),
 h25:new Set(['ALA','ESP','LEC','RAY','RSO','VCF']),
 ho05:new Set(['CHE','LIV','NEW']),
 o15:new Set(['CHE','NEW']),
 u25:new Set(['ALA','RAY','VCF']),
 gg:new Set(['CHE','NEW']),
 t05:new Set(['CHE','MCI','NEW']),
 tu15:new Set(['ESP','LEC','RAY','VCF']),
 tu25:new Set(['ESP','LEC','RAY','VCF'])
};
function teamListed(name,set){
 return String(name||'').toUpperCase().split(/[^A-Z0-9]+/).some(token=>set.has(token));
}
function priorField(field){
 if(field==='h15'||field==='h25')return 'h35';
 if(field==='o15'||field==='ho05'||field==='t05'||field==='gg')return 'o05';
 if(field==='tu15'||field==='tu25'||field==='u25')return 'u45';
 return field;
}
function listedTeam(name,field){
 const set=CLEAN_TEAMS[field];
 return !!name&&(!!set&&teamListed(name,set)||teamPrior.best(name,field));
}
function focusTeam(row){return row?.side==='home'?row.home:row?.side==='away'?row.away:null;}
function scoringLambda(home,away){
 const rates=[teamPrior.rate(home,'o05'),teamPrior.rate(away,'o05')].filter(rate=>Number.isFinite(rate));
 return rates.length?rates.reduce((sum,rate)=>sum-Math.log(1-Math.min(99.9,Math.max(0.1,rate))/100),0)/rates.length:null;
}
function poissonUnder(lambda,limit){
 let term=Math.exp(-lambda),sum=term;
 for(let goals=1;goals<=limit;goals++){term*=lambda/goals;sum+=term;}
 return Math.min(100,Math.round(sum*1000)/10);
}
function halfPrior(home,away,field){
 const lambda=scoringLambda(home,away);
 return lambda==null?null:poissonUnder(lambda/2,field==='h15'?1:2);
}
function derivedProbability(row){
 const lambda=scoringLambda(row.home,row.away);
 if(row.field==='h15'||row.field==='h25')return halfPrior(row.home,row.away,row.field);
 if(lambda==null)return null;
 if(row.field==='ho05')return Math.min(100,Math.round((1-Math.exp(-lambda/2))*1000)/10);
 if(row.field==='o15')return Math.min(100,Math.round((1-Math.exp(-lambda)*(1+lambda))*1000)/10);
 if(row.field==='u25')return poissonUnder(lambda,2);
 if(row.field==='gg'){
  const homeRate=teamPrior.rate(row.home,'o05'), awayRate=teamPrior.rate(row.away,'o05');
  if(!Number.isFinite(homeRate)||!Number.isFinite(awayRate))return null;
  const homeLambda=-Math.log(1-Math.min(99.9,Math.max(0.1,homeRate))/100)/2, awayLambda=-Math.log(1-Math.min(99.9,Math.max(0.1,awayRate))/100)/2;
  return Math.min(100,Math.round((1-Math.exp(-homeLambda))*(1-Math.exp(-awayLambda))*1000)/10);
 }
 const team=focusTeam(row), rate=teamPrior.rate(team,'o05');
 if(!Number.isFinite(rate))return null;
 const teamLambda=-Math.log(1-Math.min(99.9,Math.max(0.1,rate))/100)/2;
 if(row.field==='tu25')return poissonUnder(teamLambda,2);
 const chance=row.field==='t05'?1-Math.exp(-teamLambda):row.field==='tu15'?Math.exp(-teamLambda)*(1+teamLambda):null;
 return chance==null?null:Math.min(100,Math.round(chance*1000)/10);
}
function teamOnAnyList(name){
 return ['o05','u45','u55','h35','h15','h25','ho05','o15','u25','gg','t05','tu15','tu25'].some(field=>CLEAN_TEAMS[field]&&(teamListed(name,CLEAN_TEAMS[field])||teamPrior.best(name,field)));
}
function rowTeamAllowed(row){
 const fields=[row?.field,priorField(row?.field)];
 const focus=focusTeam(row);
 const names=focus?[focus]:[row?.home,row?.away];
 return names.some(name=>fields.some(field=>listedTeam(name,field)));
}
function marketProbability(model,row){
 const hist=teamPrior.matchRate(row.home,row.away,row.field);
 const live=model?.goalModelAvailable?goalProbability(model,row):null;
 if(Number.isFinite(hist)&&Number.isFinite(live))return Math.round((hist*0.65+live*0.35)*10)/10;
 if(Number.isFinite(hist))return hist;
 if(Number.isFinite(live))return live;
 return derivedProbability(row);
}
function qualification(row){
 const fields=[...new Set([row?.field,priorField(row?.field)])];
 const focus=focusTeam(row);
 const names=focus?[focus]:[row?.home,row?.away];
 const named=names.some(name=>fields.some(field=>CLEAN_TEAMS[field]&&teamListed(name,CLEAN_TEAMS[field])));
 const best=names.some(name=>fields.some(field=>teamPrior.best(name,field)));
 return !named&&!best?null:[named?'whitelist':null,best?'year top 20%':null].filter(Boolean).join(' + ');
}
function numberIn(value,min,max,fallback){
 const n=Number(value);
 return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
}
function deskOptions(input={}){
 const allowed=['o05','u45','u55','h35','h25','h15','ho05','o15','t05','tu15','u25','gg','tu25'];
 const markets=[...new Set((Array.isArray(input.markets)?input.markets:allowed).filter(field=>allowed.includes(field)))];
 const minOdds=numberIn(input.minOdds,1.05,1e12,1.2);
 const maxOdds=Math.max(minOdds,numberIn(input.maxOdds,minOdds,1e12,2));
 return {markets:markets.length?markets:[...allowed],minOdds,maxOdds,maxLegs:Math.round(numberIn(input.maxLegs,1,50,3)),minProbability:numberIn(input.minProbability,0,99,75)};
}
function select(board,history,now,used=new Set(),lane=STANDARD){
 board=(board||[]).map(item=>({...item,rows:(item.rows||[]).filter(row=>{
  const teamOk=lane.band?bandAllowed(row):lane.whitelist?rdpWhitelistAllowed(row):lane.trustedOnly?rowTeamAllowed(row):lane.oneListed?teamOnAnyList(row.home)||teamOnAnyList(row.away):lane.stack||rowTeamAllowed(row);
  return teamOk&&(!lane.marketFields||lane.marketFields.includes(row.field));
 })})).filter(item=>item.rows.length);
 if(lane.note)lane.note.teamPass=board.reduce((count,item)=>count+item.rows.length,0);
 let rows=board.flatMap(({fixture,rows})=>{
  if(used.has(fixture.eventId))return [];
  const model=predict(fixture,history,now,fixture.formPanel);
  return rows.map(r=>({...r,probability:marketProbability(model,r)})).filter(r=>Number.isFinite(r.probability)&&r.probability>0&&r.probability<=100);
 });
 if(lane.note)lane.note.priced=rows.length;
 if(Number.isFinite(Number(lane.minProbability)))rows=rows.filter(r=>r.probability+1e-9>=Number(lane.minProbability));
 if(lane.note)lane.note.aboveFloor=rows.length;
 if(lane.band){
  const bestByEvent=new Map();
  for(const r of rows){
   const prev=bestByEvent.get(r.eventId);
   if(!prev||r.probability>prev.probability||(r.probability===prev.probability&&r.odds<prev.odds))bestByEvent.set(r.eventId,r);
  }
  rows=[...bestByEvent.values()];
 }
 let wider=null;
 if(lane.nextRound&&rows.length){
  const soon=Math.min(...rows.map(r=>Date.parse(r.kickoffUtc)).filter(Number.isFinite));
  const round=rows.filter(r=>Date.parse(r.kickoffUtc)<=soon+3*60*1000);
  if(round.length&&round.length<rows.length){wider=rows;rows=round;}
 }
 if(lane.stack){
  const cap=lane.maxLegOdds??lane.maxOdds;
  const byEvent=new Map();
  for(const r of rows){
   if(r.odds>cap+1e-9)continue;
   const prev=byEvent.get(r.eventId);
   if(!prev||r.odds>prev.odds||(r.odds===prev.odds&&r.probability>prev.probability))byEvent.set(r.eventId,r);
  }
  const take=list=>{
   const picked=[]; let odds=1, probability=1;
   for(const r of list){
    if(picked.length>=lane.maxLegs)break;
    const combined=odds*r.odds;
    if(combined>lane.maxOdds+1e-9)continue;
    picked.push(r); odds=combined; probability*=r.probability/100;
   }
   return {legs:picked,odds,probability};
  };
  const events=[...byEvent.values()];
  const safe=take(events.sort((a,b)=>b.probability-a.probability||a.odds-b.odds));
  const reach=take([...events].sort((a,b)=>b.odds-a.odds||b.probability-a.probability));
  if(lane.note)lane.note.bestOdds=Math.max(safe.odds,reach.odds);
  const chosen=lane.preferLong?reach:(safe.odds+1e-9>=lane.minOdds?safe:reach);
  return chosen.legs.length&&(lane.preferLong||chosen.odds+1e-9>=lane.minOdds)?chosen:null;
 }
 let best=null;
 const legs=[], events=new Set();
 function visit(start,odds,probability){
  if(odds>=lane.minOdds-1e-9&&(!best||probability>best.probability||(probability===best.probability&&legs.length<best.legs.length)))
   best={legs:[...legs],odds,probability};
  if(legs.length===lane.maxLegs||best&&probability<best.probability)return;
  for(let i=start;i<rows.length;i++){
   const r=rows[i], combined=odds*r.odds;
   if(r.odds>(lane.maxLegOdds??lane.maxOdds)||combined>lane.maxOdds+1e-9||events.has(r.eventId))continue;
   legs.push(r);events.add(r.eventId);
   visit(i+1,combined,probability*r.probability/100);
   events.delete(r.eventId);legs.pop();
  }
 }
 visit(0,1,1);
 if(!best&&wider){rows=wider;visit(0,1,1);}
 return best;
}
async function addVirtualForm(board,history,now,signal,readForm){
 for(const {fixture,rows} of board.filter(x=>x.rows.length&&!predict(x.fixture,history,now)).slice(0,4)){
  if(signal?.aborted)break;
  try{const form=await readForm(fixture,{signal});if(form)fixture.formPanel=form;}
  catch(err){console.warn('[Virtual Roll Over stats]',String(err.message).slice(0,140));}
 }
}
const configuredForm=()=>process.env.VIRTUAL_ROLLOVER_STATS_ENABLED!=='false'?require('./virtualRollOverForm').collect:null;
function settle(ticket,results,opening=START){
 if(results.some(x=>!x))return null;
 let factor=1,active=0;
 for(const [i,r] of results.entries()){
  if(r.void)continue;
  active++;
  const leg=ticket.legs[i],total=r.h+r.a;
  const halfLimit={h15:1.5,h25:2.5,h35:3.5};
  const teamGoals=leg.field==='tu25'?leg.side==='home'?r.h:leg.side==='away'?r.a:null:null;
  const won=teamGoals!=null?teamGoals<2.5:halfLimit[leg.field]!=null?(Number.isInteger(r.fh)?r.fh<halfLimit[leg.field]:null):leg.field==='u55'?total<5.5:leg.field==='u45'?total<4.5:leg.field==='o05'?total>0.5:total>1.5;
  if(won==null)return null;
  if(!won)return {status:'Lost',returned:0,nextBalance:opening,nextStep:0};
  factor*=leg.odds;
 }
 const returned=Math.round(ticket.stake*factor);
 const nextStep=ticket.step+(active?1:0);
 const banked=active>0&&Number(ticket.takeProfitWins)>0&&nextStep>=Number(ticket.takeProfitWins);
 const settled={status:active?'Won':'Void',returned,nextBalance:banked?opening:returned,nextStep:banked?0:nextStep};
 if(banked)settled.banked=true;
 return settled;
}
function summary(s,lane=STANDARD){
 const p=s.pending;
 const lines=[lane.title,`Tracked balance: ${money(s.balance)} · Wins in this run: ${s.step}`,`Codes today: ${s.count} (WAT)`];
 const timingLabel=value=>new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Lagos',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value))+' WAT';
 for(const row of Object.values(s.last?.timings??{})){
  const times=[row.kickoffUtc&&'Kickoff scheduled: '+timingLabel(row.kickoffUtc),row.startedObservedAt&&'Live first seen: '+timingLabel(row.startedObservedAt),row.finishedObservedAt&&'Finish confirmed: '+timingLabel(row.finishedObservedAt)].filter(Boolean);
  if(times.length)lines.push(times.join(' · '));
 }
 if(s.last)lines.push(`Last settled: ${s.last.status} · Returned ${money(s.last.returned)}`);
 for(const row of (s.record||[]).slice(-5))lines.push(`${String(row.status).toUpperCase()} ${row.code} · Returned ${money(row.returned)}`);
 if(p&&Number.isFinite(p.modelProbability))lines.push(`Model estimate: ${(p.modelProbability*100).toFixed(1)}%${p.legs.length>1?' (assuming independent legs)':''}`);
 if(p)lines.push(`Pending: ${p.code} · ${p.odds.toFixed(3)}x`,`Stake ${money(p.stake)} · Potential return ${money(Math.round(p.stake*p.odds))}`,...p.legs.map(l=>`${l.home} vs ${l.away} — ${l.pick}`));
 else if(s.lastReason==='no_qualifying_ticket')lines.push('No qualifying ticket on the latest check. The model needs verified recent results for both teams.');
 else lines.push('No ticket awaiting settlement.');
 return lines.join('\n');
}
async function run({redis,slotKey,dateKey,signal,assertLease,shouldAbort,pendingCode},{client=sporty.direct,book=sporty.bookBet,send,clock=Date.now,readForm=configuredForm(),lane=STANDARD}){
 if(!redis)return {retryable:true,reason:'rollover_redis_required'};
 const lock=lane.key+':lock', token=randomUUID();
 if(await redis.set(lock,token,{NX:true,EX:300})!=='OK')return {retryable:true,reason:'rollover_busy'};
 try{
  const s=await stateOf(redis,lane);
  if(pendingCode&&s.pending?.code!==pendingCode)return {reason:'pending_changed',ticketsSent:0};
  const check=async()=>{signal?.throwIfAborted();await assertLease?.();if(shouldAbort?.()||await redis.get(lock)!==token)throw Error('Roll Over slot lease expired');};
  const save=async()=>{await check();await redis.set(lane.key,JSON.stringify(s));};
  const readResult=async (f,observed)=>{await check();try{return await resultFor(client,f,signal,observed,clock);}catch(err){signal?.throwIfAborted();return null;}};
  if(s.day!==dateKey){s.day=dateKey;s.count=0;}
  if(s.pending){
   const outcomes=[];
   s.pending.timings??={};
   for(const f of s.pending.legs){
    const observation=s.pending.timings[f.eventId]??={kickoffUtc:f.kickoffUtc};
    if(!observation.result&&Date.parse(f.kickoffUtc)<=clock()){
     observation.result=await readResult(f,observation);
     if(observation.result?.void)observation.voidObservedAt??=new Date(clock()).toISOString();
    }
    outcomes.push(observation.result??null);
   }
   const settled=settle(s.pending,outcomes,lane.opening??START);
   if(settled){
    const pending=s.pending,code=pending.code,settledAt=new Date(clock()).toISOString();
    const legReports=pending.legs.map((leg,i)=>learning.explainVirtualLeg(leg,outcomes[i]));
    s.last={...settled,code,timings:pending.timings};s.balance=settled.nextBalance;s.step=settled.nextStep;s.pending=null;s.lastReason=null;
    await save();
    await learning.settleSample(redis,learning.virtualTicketId(lane,code),{status:settled.status.toLowerCase(),settledAt,legs:legReports},new Date(clock())).catch(err=>console.warn('[strategy-learning]',String(err.message).slice(0,160)));
    s.record=[...(s.record||[]),{code,status:settled.status,returned:settled.returned,stake:pending.stake,at:settledAt,legs:pending.legs.map(leg=>({home:leg.home,away:leg.away,pick:leg.pick}))}].slice(-30);
    await save();
    await send(`${lane.title}\n${code} · ${settled.status.toUpperCase()}${settled.banked?' · Take profit, reset to '+money(lane.opening):''}\nReturn: ${money(settled.returned)} · Next stake: ${money(s.balance)}\n${pending.legs.map(leg=>leg.home+' vs '+leg.away+' — '+leg.pick).join('\n')}`);
   }else if(pendingCode||s.pending){
    await save();
    return {reason:'awaiting_settlement',ticketsSent:0};
   }
  }
  const now=clock();
  s.history=s.history.filter(x=>x.verifiedAt>=now-7*86400000);
  s.watch=s.watch.filter(x=>Date.parse(x.kickoffUtc)>now-86400000);
  const due=s.watch.filter(x=>Date.parse(x.kickoffUtc)<now-300000).slice(0,12);
  for(const f of due){
   const r=await readResult(f);
   if(r){s.watch=s.watch.filter(x=>x.eventId!==f.eventId);if(!r.void)s.history.push({...f,...r,verifiedAt:clock()});}
   else {s.watch=s.watch.filter(x=>x.eventId!==f.eventId);s.watch.push(f);}
  }
  const board=await fixtures(client,clock(),signal,lane);
  let learned=board;
  try{learned=learning.filterVirtualBoard(board,await learning.readModel(redis),learning.virtualStrategy(lane));}catch(err){console.warn('[strategy-learning]',String(err.message).slice(0,160));}
  const known=new Set([...s.watch,...s.history].map(x=>x.eventId));
  for(const {fixture} of board.slice(0,12))if(!known.has(fixture.eventId))s.watch.push(fixture);
  await save();
  if(s.pending||s.lastSlot===slotKey||s.bookedSlot===slotKey)return {reason:s.pending?'awaiting_settlement':'already_attempted',ticketsSent:0};
  if(String(slotKey).startsWith('boot:')&&s.bookedSlot===watSlot(clock()))return {reason:'already_attempted',ticketsSent:0};
  if(readForm)await addVirtualForm(board,s.history,clock(),signal,readForm);
  const ticket=select(learned.filter(({fixture})=>Date.parse(fixture.kickoffUtc)>clock()+20000),s.history,clock(),new Set(s.used||[]),lane);
  if(!ticket){s.lastReason='no_qualifying_ticket';await save();return {reason:s.lastReason,ticketsSent:0};}
  // Re-read the offered market IDs and prices before creating a share code.
  const refreshed=await fixtures(client,clock(),signal,lane);
  const legs=ticket.legs.map(l=>refreshed.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
  if(legs.some(x=>!x))return {reason:'prices_changed',ticketsSent:0};
  s.lastSlot=/^\d{2}:\d{2}$/.test(String(slotKey))?slotKey:watSlot(clock());
  s.bookedSlot=watSlot(clock());
  s.used=[...(s.used||[]),...legs.map(l=>l.eventId)].slice(-120);
  await save();
  const booked=await book(legs);
  const code=String(booked?.shareCode??'');
  if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Roll Over share code not confirmed');
  s.pending={code,legs,odds:ticket.odds,modelProbability:ticket.probability,stake:s.balance,step:s.step,...(lane.takeProfitWins?{takeProfitWins:lane.takeProfitWins}:{})};
  s.count++;s.lastReason=null;
  await save();
  await learning.recordSample(redis,learning.virtualSample({lane,code,ticket,legs:ticket.legs,stake:s.pending.stake,step:s.pending.step,openedAt:new Date(clock()).toISOString()}),new Date(clock())).catch(err=>console.warn('[strategy-learning]',String(err.message).slice(0,160)));
  // Persist the code before posting so an ambiguous Telegram response cannot duplicate a pick.
  await check();
  await send(summary(s,lane)+`\nhttps://www.sportybet.com/ng/?shareCode=${code}`);
  return {ticketsSent:1};
 }finally{
  await redis.eval('if redis.call("GET",KEYS[1])==ARGV[1] then return redis.call("DEL",KEYS[1]) end',{keys:[lock],arguments:[token]}).catch(()=>{});
 }
}
// Manual checks read the saved form but never advance the scheduled chain.
async function preview(redis,{client=sporty.direct,book=null,clock=Date.now,signal,readForm=configuredForm()}={}){
 const state=await stateOf(redis);
 const now=clock(),rawBoard=await fixtures(client,now,signal);
 let board=rawBoard;
 try{board=learning.filterVirtualBoard(rawBoard,await learning.readModel(redis),learning.virtualStrategy(STANDARD));}catch{}
 if(readForm)await addVirtualForm(board,state.history,now,signal,readForm);
 const notes={statsFixtures:board.filter(x=>x.fixture.formPanel).length,fixtures:board.length,offeredSelections:board.reduce((n,x)=>n+x.rows.length,0),
  verifiedResults:state.history.filter(x=>x.verifiedAt>=now-7*86400000).length};
 const ticket=select(board.filter(x=>Date.parse(x.fixture.kickoffUtc)>clock()+20000),state.history,clock(),new Set(state.used||[]));
 if(!ticket)return {status:'no_ticket',reason:!notes.fixtures?'No upcoming virtual fixtures returned':!notes.offeredSelections?'No supported open totals were found':!notes.verifiedResults&&!notes.statsFixtures?'No verified virtual results saved yet and no usable match Stats panel was read':'No eligible combination met the form and odds requirements',...notes};
 const result={status:'preview',odds:ticket.odds,modelProbability:ticket.probability,
  selections:ticket.legs.map(({home,away,pick,odds,kickoffUtc})=>({home,away,pick,odds,kickoffUtc})),...notes};
 if(!book)return result;
 const refresh=await fixtures(client,clock(),signal);
 const legs=ticket.legs.map(l=>refresh.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.marketId===l.marketId&&r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
 if(legs.some(x=>!x))return {...result,status:'no_ticket',reason:'Prices or availability changed before code generation'};
 signal?.throwIfAborted();
 const booked=await book(legs),code=String(booked?.shareCode??'');
 if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Roll Over test share code not confirmed');
 return {...result,status:'booked',code,link:'https://www.sportybet.com/ng/?shareCode='+code};
}
async function buildDesk(redis,input,{client=sporty.direct,book=null,clock=Date.now,signal,readForm=configuredForm()}={}){
 const options=deskOptions(input);
 const note={};
 const session=deskSession(input);
 if(session.maxUnder){options.markets=['u45','u55','h35','h25','h15'];options.minOdds=1.05;}
 if(session.botMix){options.markets=(options.markets||[]).filter(field=>['h15','ho05','o15','t05','tu15','u25','gg','tu25'].includes(field));if(!options.markets.length)options.markets=['h15','ho05','o15','t05','tu15','u25','gg','tu25'];options.minOdds=Math.max(1.05,options.minOdds);}
 const lane={key:'virtual-desk:v1',minOdds:options.minOdds,maxOdds:options.maxOdds,maxLegs:options.maxLegs,minProbability:options.minProbability,marketFields:Object.freeze(options.markets),...(session.maxLegOdds?{maxLegOdds:session.maxLegOdds}:{}),preferLong:session.maxUnder||session.botMix,trustedOnly:input.trustedOnly===true,oneListed:input.oneListed===true,stack:true,note,title:'VIRTUAL TICKET'};
 const state=await stateOf(redis);
 const now=clock(),board=await fixtures(client,now,signal,lane,session.horizonMs);
 if(readForm)await addVirtualForm(board,state.history,now,signal,readForm);
 const usable=board.filter(x=>Date.parse(x.fixture.kickoffUtc)>now+20000);
 const ticket=select(usable,state.history,now,new Set(),lane);
 const notes={fixtures:board.length,offeredSelections:board.reduce((n,x)=>n+x.rows.length,0),pricedSelections:note.priced||0,aboveFloor:note.aboveFloor||0,minProbability:options.minProbability,minOdds:options.minOdds,maxOdds:options.maxOdds,maxLegs:options.maxLegs,markets:options.markets,session:session.botMix?'bot-mix':session.maxUnder?'max-under':session.higher?'higher':'next',horizonMinutes:session.horizonMs/60000};
 if(!ticket)return {status:'no_ticket',reason:!notes.fixtures?'No upcoming virtual fixtures':!notes.offeredSelections?'No prices for the selected bet type. A single price above the maximum combined odds cannot be used.':!notes.pricedSelections?(input.trustedOnly===true&&!note.teamPass?'No team passed the whitelist or the year top 20%.':input.oneListed===true&&!note.teamPass?'No game had one team on the whitelist or the year top 20%.':'No team has a model probability for the selected bet type'):!notes.aboveFloor?`No selection reached the ${options.minProbability}% probability floor`:(note.bestOdds?`No combination met the combined odds. The best ${options.maxLegs} prices on this board combine to ${Number(note.bestOdds).toFixed(2)}. Lower the minimum or allow more picks.`:'No combination met the combined odds'),...notes};
 const selections=ticket.legs.map(leg=>({home:leg.home,away:leg.away,pick:leg.pick,field:leg.field,odds:leg.odds,kickoffUtc:leg.kickoffUtc,probability:leg.probability,yearRate:teamPrior.matchRate(leg.home,leg.away,leg.field),qualified:qualification(leg),eventId:leg.eventId,marketId:leg.marketId,outcomeId:leg.outcomeId,specifier:leg.specifier??''}));
 const result={status:'preview',odds:ticket.odds,modelProbability:ticket.probability,selections,...notes};
 if(!book)return result;
 const refresh=await fixtures(client,clock(),signal,lane,session.horizonMs);
 const legs=ticket.legs.map(l=>refresh.find(x=>x.fixture.eventId===l.eventId)?.rows.find(r=>r.marketId===l.marketId&&r.specifier===l.specifier&&r.outcomeId===l.outcomeId&&r.odds===l.odds));
 if(legs.some(x=>!x))return {...result,status:'no_ticket',reason:'Prices changed before the code was created'};
 const booked=await book(legs),code=String(booked?.shareCode??'');
 if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Virtual ticket share code not confirmed');
 return {...result,status:'booked',code,link:'https://www.sportybet.com/ng/?shareCode='+code};
}
function matchKept(board,selections){
 const legs=[], missing=[];
 for(const selection of Array.isArray(selections)?selections:[]){
  const row=board.find(item=>item.fixture.eventId===selection?.eventId)?.rows.find(item=>item.marketId===String(selection.marketId)&&String(item.outcomeId)===String(selection.outcomeId)&&String(item.specifier??'')===String(selection.specifier??''));
  if(!row)missing.push(selection);
  else legs.push({...row,probability:selection.probability,qualified:selection.qualified,yearRate:selection.yearRate});
 }
 return {legs,missing};
}
async function rebookDesk(input,{client=sporty.direct,book=null,clock=Date.now,signal}={}){
 const kept=(Array.isArray(input?.selections)?input.selections:[]).filter(selection=>selection?.eventId&&selection.marketId&&selection.outcomeId).slice(0,50);
 if(!kept.length)return {status:'no_ticket',reason:'Keep at least one game before generating a new code.'};
 if(!book)return {status:'no_ticket',reason:'The new code was not requested.'};
 const lane={marketFields:Object.freeze(['o05','u45','u55','h35','h25','h15','ho05','o15','t05','tu15','u25','gg','tu25']),maxOdds:1e12,maxLegOdds:20};
 const board=await fixtures(client,clock(),signal,lane,6*3600000);
 const found=matchKept(board,kept);
 if(found.missing.length)return {status:'no_ticket',reason:'These games are no longer open: '+found.missing.map(selection=>selection.home+' vs '+selection.away).join(', ')};
 const booked=await book(found.legs),code=String(booked?.shareCode??'');
 if(!/^[A-Za-z0-9]{4,32}$/.test(code)||booked.unavailableOutcomes?.length)throw Error('Virtual ticket share code not confirmed');
 const selections=found.legs.map(leg=>({home:leg.home,away:leg.away,pick:leg.pick,field:leg.field,odds:leg.odds,kickoffUtc:leg.kickoffUtc,probability:leg.probability,yearRate:leg.yearRate,qualified:leg.qualified,eventId:leg.eventId,marketId:leg.marketId,outcomeId:leg.outcomeId,specifier:leg.specifier??''}));
 const odds=selections.reduce((total,leg)=>total*leg.odds,1);
 const modelProbability=selections.reduce((total,leg)=>total*(Number(leg.probability)||0)/100,1);
 return {status:'booked',code,link:'https://www.sportybet.com/ng/?shareCode='+code,odds,modelProbability,selections};
}
module.exports={RDP,BAND,isRdpVirtualCountry,resetRdpCodeCount,preview,TIMES,run,stateOf,summary,select,settle,fixtures,resultFor,freshState,rowTeamAllowed,bandAllowed,rdpWhitelistAllowed,deskOptions,deskSession,buildDesk,matchKept,rebookDesk};
