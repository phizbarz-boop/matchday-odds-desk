'use strict';
// Settled virtual rollover and daily-pick legs train a small calibration table.
// With no history the table is empty and selection is unchanged.
const MODEL_KEY='strategy-learning:model:v1';
const SAMPLES_KEY='strategy-learning:samples:v1';
const MAX_SAMPLES=800, MIN_ADJUST=8, MIN_AVOID=12;
const emptyModel=()=>({trainedAt:null,openIds:[],buckets:{},leagues:{},decisiveLegs:0});
const round=n=>Math.round(n*1000)/1000;
const clip=value=>String(value??'').replace(/\s+/g,' ').trim().slice(0,80);

function oddsBand(odds,strategy){
 const n=Number(odds);
 if(!Number.isFinite(n))return 'unknown';
 if(String(strategy).startsWith('virtual'))return n<1.18?'<1.18':n<1.24?'1.18-1.24':'>=1.24';
 return n<1.4?'<1.4':n<1.8?'1.4-1.8':n<2.5?'1.8-2.5':'>=2.5';
}
function probBand(probability){
 const n=Number(probability);
 if(!Number.isFinite(n))return 'unknown';
 return n<70?'<70':n<80?'70-80':n<90?'80-90':'>=90';
}
function bucketKeys(sample,leg){
 const strategy=sample.strategy,odds=oddsBand(leg.startingOdds??leg.odds,strategy),prob=probBand(leg.modelProbability);
 if(String(strategy).startsWith('virtual')){
  const field=leg.field||leg.betType||'market';
  const pair=[clip(leg.home),clip(leg.away)].join(' vs ');
  return [`${strategy}|${field}|${pair}`,`${strategy}|${field}|${clip(leg.league)||'league'}|${odds}`,`${strategy}|${field}|${odds}`,`${strategy}|${field}`];
 }
 const bet=leg.betType||'market',sport=clip(leg.sport||'sport').toLowerCase();
 return [`daily-picks|${sport}|${bet}|${odds}|${prob}`,`daily-picks|${bet}|${prob}`,`daily-picks|${bet}`];
}
function decisive(status){return status==='won'||status==='half_won'||status==='lost'||status==='half_lost';}
function wonStatus(status){return status==='won'||status==='half_won';}

function train(samples,now=new Date()){
 const groups=new Map();
 let decisiveLegs=0;
 for(const sample of samples){
  if(sample.status==='open')continue;
  for(const leg of sample.legs||[]){
   if(!decisive(leg.status))continue;
   decisiveLegs++;
   for(const key of bucketKeys(sample,leg)){
    const group=groups.get(key)||{n:0,wins:0,losses:0,expected:0};
    group.n++;
    if(wonStatus(leg.status))group.wins++;else group.losses++;
    const p=Number(leg.modelProbability);
    group.expected+=Number.isFinite(p)?Math.min(100,Math.max(0,p))/100:0.5;
    groups.set(key,group);
   }
  }
 }
 const leagues={};
 for(const sample of samples){
  if(sample.status==='open'||!String(sample.strategy||'').startsWith('virtual'))continue;
  for(const leg of sample.legs||[]){
   const field=leg.field||leg.betType;
   const league=clip(leg.league);
   if((field!=='u45'&&field!=='o05')||!league||!decisive(leg.status))continue;
   const key=field+'|'+league;
   const row=leagues[key]||{n:0,wins:0,losses:0};
   row.n++;
   if(wonStatus(leg.status))row.wins++;else row.losses++;
   leagues[key]=row;
  }
 }
 for(const row of Object.values(leagues))row.observedWinRate=round(row.wins/row.n);
 const buckets={};
 for(const [key,group] of groups){
  if(group.n<MIN_ADJUST)continue;
  const observed=group.wins/group.n,expected=group.expected/group.n||0;
  const factor=Math.min(1,Math.max(0.7,expected>0?observed/expected:1));
  const avoid=group.n>=MIN_AVOID&&observed<0.5&&observed+0.15<expected;
  buckets[key]={n:group.n,wins:group.wins,losses:group.losses,observedWinRate:round(observed),expectedWinRate:round(expected),factor:avoid?0:round(factor),avoid,
   reason:avoid?`Avoid ${key}: won ${group.wins} of ${group.n}, model expected ${(expected*100).toFixed(0)}%`:(factor<0.999?`Downweight ${key}: won ${group.wins} of ${group.n} against a ${(expected*100).toFixed(0)}% model`:null)};
 }
 return {trainedAt:now.toISOString(),openIds:[...new Set(samples.filter(sample=>sample.status==='open').map(sample=>sample.id))].slice(-400),buckets,leagues,decisiveLegs};
}
function decide(model,leg){
 if(!model?.buckets)return {avoid:false,factor:1,reason:null};
 for(const key of bucketKeys({strategy:leg.strategy},leg)){
  const bucket=model.buckets[key];
  if(!bucket)continue;
  return {avoid:bucket.avoid===true,factor:bucket.avoid?0:Number(bucket.factor)||1,reason:bucket.reason,key};
 }
 return {avoid:false,factor:1,reason:null};
}
function scale(value,factor){const n=Number(value);return Number.isFinite(n)?Math.max(0,Math.min(100,Math.round(n*factor*10)/10)):value;}
function adjustDailyRows(rows,model){
 if(!Array.isArray(rows)||!model?.buckets||!Object.keys(model.buckets).length)return rows;
 let changed=false;const out=[];
 for(const row of rows){
  const base=row.fullWinProbability!=null&&Number.isFinite(Number(row.fullWinProbability))?Number(row.fullWinProbability):Number(row.probability);
  const decision=decide(model,{strategy:'daily-picks',sport:row.sport,betType:row.betType,startingOdds:row.odds,modelProbability:base,league:row.tournament||row.league,home:row.home,away:row.away});
  if(decision.avoid){changed=true;continue;}
  if(decision.factor<0.999&&Number.isFinite(base)){
   changed=true;
   const next=scale(base,decision.factor);
   out.push({...row,probabilityBeforeLearning:row.probabilityBeforeLearning??base,probability:next,...(row.fullWinProbability!=null?{fullWinProbability:next}:{}),learningNote:decision.reason});
  }else out.push(row);
 }
 return changed?out:rows;
}
function rdpPlace(...values){
 const text=values.map(value=>clip(value).toLowerCase()).filter(Boolean).join(' ');
 const found=new Set();
 if(/\b(spain|spanish|españa)\b/.test(text))found.add('spain');
 if(/\b(france|french|français)\b/.test(text))found.add('france');
 if(/\b(england|english)\b/.test(text))found.add('england');
 return found.size===1?[...found][0]:null;
}
function rdpLeagueBlock(){
 // Team rates from the one-year virtual prior decide the market. A league name no longer blocks Italy, Germany or France.
 return null;
}
function filterVirtualBoard(board,model,strategy){
 if(!Array.isArray(board))return board;
 const rdp=strategy==='virtual-rollover-rdp';
 const hasBuckets=!!(model?.buckets&&Object.keys(model.buckets).length);
 if(!rdp&&!hasBuckets)return board;
 let changed=false;
 const next=board.map(item=>{
  const rows=[];
  for(const row of item.rows||[]){
   const league=row.league||item.fixture?.league;
   const country=row.country||item.fixture?.country;
   if(rdp){
    const blocked=rdpLeagueBlock(row.field,league,country);
    if(blocked){changed=true;continue;}
   }
   if(!hasBuckets){rows.push(row);continue;}
   const decision=decide(model,{strategy,field:row.field,betType:row.field,startingOdds:row.odds,modelProbability:row.probability,league,home:row.home,away:row.away});
   if(decision.avoid){changed=true;continue;}
   if(decision.factor<0.999&&Number.isFinite(Number(row.probability))){changed=true;rows.push({...row,rawProbability:row.probability,probability:scale(row.probability,decision.factor),learningNote:decision.reason});}
   else rows.push(row);
  }
  return rows.length?{...item,rows}:null;
 }).filter(Boolean);
 return changed?next:board;
}
function virtualWon(leg,result){
 if(leg.field==='h35')return Number.isInteger(result.fh)?result.fh<3.5:null;
 if(leg.field==='tu25'){const goals=leg.side==='home'?result.h:leg.side==='away'?result.a:null;return Number.isInteger(goals)?goals<2.5:null;}
 const total=result.h+result.a;
 return leg.field==='u55'?total<5.5:leg.field==='u45'?total<4.5:leg.field==='o05'?total>0.5:total>1.5;
}
function explainVirtualLeg(leg,result){
 const price=Number(leg.startingOdds??leg.odds);
 const base={eventId:leg.eventId,home:leg.home,away:leg.away,league:leg.league||null,country:leg.country||null,kickoffUtc:leg.kickoffUtc||null,marketId:leg.marketId,outcomeId:leg.outcomeId,specifier:leg.specifier||null,pick:leg.pick,field:leg.field,betType:leg.field,sport:'Virtual Football',startingOdds:Number.isFinite(price)?price:null,modelProbability:Number.isFinite(Number(leg.rawProbability??leg.modelProbability??leg.probability))?Number(leg.rawProbability??leg.modelProbability??leg.probability):null};
 if(!result)return {...base,status:'pending',failed:false,reason:null};
 if(result.void)return {...base,status:'void',failed:false,score:null,reason:'Match voided, abandoned or cancelled'};
 const total=result.h+result.a,won=virtualWon(leg,result),line=leg.pick||leg.field;
 if(won==null)return {...base,status:'pending',failed:false,score:`${result.h}-${result.a}`,goals:total,reason:null};
 const scoreText=leg.field==='h35'&&Number.isInteger(result.fh)?`1st half ${result.fh}`:`${result.h}-${result.a}`;
 return {...base,status:won?'won':'lost',failed:!won,score:scoreText,goals:leg.field==='h35'?result.fh:total,
  reason:won?null:`${leg.home} vs ${leg.away} played ${line} at starting odds ${Number.isFinite(price)?price.toFixed(2):'unknown'}. ${leg.field==='h35'?'1st half '+result.fh+' goals':'Full-time '+result.h+'-'+result.a+' ('+total+' goals)'}, so this leg lost.`};
}
function virtualTicketId(lane,code){return String(lane?.key||'virtual-rollover')+':'+code;}
function virtualStrategy(lane){return lane?.band?'virtual-rollover-band':lane?.key&&lane.key!=='virtual-rollover:v1'?'virtual-rollover-rdp':'virtual-rollover';}
function virtualSample({lane,code,ticket,legs,stake,step,openedAt}){
 return {id:virtualTicketId(lane,code),strategy:virtualStrategy(lane),planId:lane?.title||'ROLL OVER',ticketId:virtualTicketId(lane,code),shareCode:code,openedAt,combinedOdds:Number(ticket.odds)||null,modelProbability:Number(ticket.probability),stake:stake??null,step:step??null,status:'open',lostAt:null,lossReason:null,failedEventIds:[],
  legs:legs.map(leg=>({eventId:leg.eventId,home:leg.home,away:leg.away,league:leg.league||null,country:leg.country||null,kickoffUtc:leg.kickoffUtc||null,marketId:leg.marketId,outcomeId:leg.outcomeId,specifier:leg.specifier||null,pick:leg.pick,field:leg.field,betType:leg.field,sport:'Virtual Football',startingOdds:Number(leg.odds)||null,modelProbability:Number(leg.rawProbability??leg.probability),status:'open',failed:false,reason:null}))};
}
function dailySample(slip,openedAt){
 const id=String(slip.ticketId||slip.shareCode);
 return {id,strategy:'daily-picks',planId:slip.label||slip.planId||'daily',ticketId:id,shareCode:slip.shareCode||null,openedAt,combinedOdds:Number(slip.combinedOdds)||null,modelProbability:null,stake:null,step:null,status:'open',lostAt:null,lossReason:null,failedEventIds:[],
  legs:(slip.selections||[]).map(leg=>({eventId:String(leg.eventId||''),marketId:String(leg.marketId||''),outcomeId:String(leg.outcomeId||''),specifier:leg.specifier||null,home:leg.home||'',away:leg.away||'',league:leg.tournament||leg.league||'',sport:leg.sport||'',betType:leg.betType||'',pick:leg.outcomeDesc||leg.pick||'',marketDesc:leg.marketDesc||'',kickoffUtc:leg.kickoffUtc||null,startingOdds:Number(leg.odds)||null,modelProbability:Number(leg.probabilityBeforeLearning??leg.fullWinProbabilityBeforeLearning??leg.fullWinProbability??leg.probability),status:'open',failed:false,reason:null}))};
}
function lossReason(legs){return legs.filter(leg=>leg.failed&&leg.reason).map(leg=>leg.reason).join(' | ')||null;}
function applyLegResult(saved,incoming){
 const key=leg=>[leg.eventId,leg.marketId,leg.outcomeId,leg.specifier||''].join('|');
 const found=new Map((saved.legs||[]).map(leg=>[key(leg),{...leg}]));
 for(const leg of incoming){
  const id=key(leg),prior=found.get(id)||{};
  const modelProbability=Number.isFinite(Number(prior.modelProbability))?Number(prior.modelProbability):leg.modelProbability;
 const startingOdds=Number.isFinite(Number(prior.startingOdds))?Number(prior.startingOdds):leg.startingOdds;
 found.set(id,{...prior,...leg,startingOdds,modelProbability});
 }
 return [...found.values()];
}
async function readJson(redis,key){if(!redis)return null;const raw=await redis.get(key);if(!raw)return null;try{return JSON.parse(raw);}catch{return null;}}
async function readModel(redis){
 const model=(await readJson(redis,MODEL_KEY))||emptyModel();
 if(model.leagues)return model;
 const samples=(await readJson(redis,SAMPLES_KEY))||[];
 return {...model,leagues:train(samples).leagues};
}
async function openIds(redis){return new Set((await readModel(redis)).openIds||[]);}
async function writeState(redis,samples,now){
 const open=samples.filter(sample=>sample.status==='open'),closed=samples.filter(sample=>sample.status!=='open');
 const room=Math.max(0,MAX_SAMPLES-open.length);
 const capped=[...open,...closed.slice(-room)].slice(-MAX_SAMPLES);
 const model=train(capped,now);
 await redis.set(SAMPLES_KEY,JSON.stringify(capped));
 await redis.set(MODEL_KEY,JSON.stringify(model));
 return {samples:capped,model};
}
async function recordSample(redis,sample,now=new Date()){
 if(!redis||!sample?.id)return null;
 const samples=(await readJson(redis,SAMPLES_KEY))||[];
 if(samples.some(row=>row.id===sample.id))return sample;
 samples.push(sample);
 await writeState(redis,samples,now);
 return sample;
}
async function settleSample(redis,id,patch,now=new Date()){
 if(!redis||!id)return null;
 const samples=(await readJson(redis,SAMPLES_KEY))||[];
 const index=samples.findIndex(sample=>sample.id===id);
 if(index<0)return null;
 const current=samples[index];
 if(current.status!=='open'&&current.status===patch.status)return current;
 const legs=applyLegResult(current,patch.legs||[]);
 const failed=legs.filter(leg=>leg.failed);
 const status=String(patch.status||current.status||'open').toLowerCase();
 const settledAt=patch.settledAt||now.toISOString();
 samples[index]={...current,status,settledAt,lostAt:failed.length?settledAt:null,failedEventIds:failed.map(leg=>leg.eventId),lossReason:lossReason(legs),legs};
 await writeState(redis,samples,now);
 return samples[index];
}
function scoreline(event){
 if(!event||typeof event!=='object')return null;
 try{const score=require('./liveModel').liveState({...event,liveState:undefined});if(Number.isInteger(score.homeScore)&&Number.isInteger(score.awayScore))return score.homeScore+'-'+score.awayScore;}catch{}
 return null;
}
function dailyLegUpdate(leg){
 const failed=leg.status==='lost'||leg.status==='half_lost';
 const played=[leg.marketDesc,leg.outcomeDesc||leg.pick||leg.betType].filter(Boolean).join(' · ');
 const score=leg.score?` Final score ${leg.score}.`:'';
 return {eventId:leg.eventId,marketId:leg.marketId,outcomeId:leg.outcomeId,specifier:leg.specifier||null,status:leg.status,failed,score:leg.score||null,startingOdds:Number(leg.odds)||null,modelProbability:Number(leg.probability)||null,home:leg.home,away:leg.away,sport:leg.sport,betType:leg.betType,pick:leg.outcomeDesc||leg.pick,marketDesc:leg.marketDesc,kickoffUtc:leg.kickoffUtc,
  reason:failed?`${leg.home||'Home'} vs ${leg.away||'Away'} played ${played||leg.betType||'selection'} at starting odds ${Number(leg.odds)||'?'}.${score} ${leg.reason||leg.source||'The selection lost.'}`.replace(/\s+/g,' ').trim():(leg.status==='push'||leg.status==='void'?(leg.reason||'Selection void or pushed'):null)};
}
async function observeSettlement(redis,{ticketId,status,settledAt,legs}){
 if(!redis||!ticketId||status==='pending')return null;
 if(!(await openIds(redis)).has(String(ticketId)))return null;
 return settleSample(redis,String(ticketId),{status,settledAt,legs:(legs||[]).map(dailyLegUpdate)});
}
module.exports={MODEL_KEY,SAMPLES_KEY,MAX_SAMPLES,MIN_ADJUST,MIN_AVOID,train,decide,adjustDailyRows,filterVirtualBoard,explainVirtualLeg,virtualTicketId,virtualStrategy,virtualSample,dailySample,readModel,openIds,recordSample,settleSample,observeSettlement,scoreline};
