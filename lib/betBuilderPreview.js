'use strict';

const resultTypes=new Set(['home_win','draw','away_win']);
const companionTypes=new Set(['home_over05','away_over05','over05','over15','over25','under25','under45','gg_yes','ng_no','first_half_goals_under25','second_half_goals_over05']);
function preview(candidates,{minProbability=55,maxMatches=4,now=Date.now(),quoteCandidates=false}={}){
 const floor=Math.min(95,Math.max(0,Number(minProbability)||0));
 const limit=Math.min(8,Math.max(1,parseInt(maxMatches,10)||4));
 const groups=new Map();
 for(const c of candidates||[]){
  const probability=Number(c.fullWinProbability??c.probability);
  if(!/^(football|soccer)$/i.test(c.sport||'')||c.live||c.suspended||c.active===false||
    !c.eventId||!c.marketId||!c.outcomeId||!(Date.parse(c.kickoffUtc)>now)||!Number.isFinite(Number(c.odds))||Number(c.odds)<=1||
    !Number.isFinite(probability)||probability<floor||probability>100||
    (!resultTypes.has(c.betType)&&!companionTypes.has(c.betType)))continue;
  const id=String(c.eventId);
  if(!groups.has(id))groups.set(id,{results:[],companions:[]});
  groups.get(id)[resultTypes.has(c.betType)?'results':'companions'].push({...c,modelProbability:probability});
 }
 const builders=[];
 const alternatives=[];
 for(const [eventId,{results,companions}] of groups){
  const pairs=[];
  const teamTypes=new Set(['home_over05','away_over05']);
  const totalTypes=new Set(['over05','over15','over25','under25','under45']);
  const allowedPairs=results.flatMap(a=>companions.map(b=>[a,b]));
  for(const [i,a] of companions.entries())for(const b of companions.slice(i+1)){
   if((teamTypes.has(a.betType)&&(teamTypes.has(b.betType)||totalTypes.has(b.betType)))||
      (teamTypes.has(b.betType)&&totalTypes.has(a.betType)))allowedPairs.push([a,b]);
  }
  for(const [a,b] of allowedPairs){
   if(String(a.marketId)===String(b.marketId))continue;
   const modelLowerBound=Math.max(0,a.modelProbability+b.modelProbability-100);
   if(modelLowerBound<=0)continue;
   pairs.push({eventId,home:a.home,away:a.away,kickoffUtc:a.kickoffUtc,modelLowerBound,selections:[a,b].map(c=>({
    betType:c.betType,market:c.marketDesc||c.betType,pick:c.outcomeDesc||c.pick||c.betType,modelProbability:c.modelProbability,...(quoteCandidates?{marketId:c.marketId,outcomeId:c.outcomeId,specifier:c.specifier,odds:c.odds}:{})
   }))});
  }
  pairs.sort((a,b)=>b.modelLowerBound-a.modelLowerBound);
  if(pairs.length){builders.push(pairs[0]);if(quoteCandidates)alternatives.push(pairs.slice(0,2));}
 }
 builders.sort((a,b)=>b.modelLowerBound-a.modelLowerBound||Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
 return {builders:builders.slice(0,limit),candidateMatches:builders.length,minProbability:floor,...(quoteCandidates?{alternatives}:{})};
}
function selectionPayload(c){
 const market=String(c.marketId),outcome=String(c.outcomeId),specifier=String(c.specifier??'');
 if(!/^\d+$/.test(market)||!/^\d+$/.test(outcome)||!/^[a-z0-9_.=|+:-]{0,120}$/i.test(specifier))return null;
 return {id:`uof:3/sr:sport:1/${market}/${outcome}?${specifier}`,odds:String(c.odds),probability:(c.modelProbability/100).toFixed(10)};
}

async function quotePreview(candidates,options,quote){
 const planned=preview(candidates,{...options,quoteCandidates:true});
 const limit=Math.min(8,Math.max(1,parseInt(options.maxMatches,10)||4));
 const target=Number(options.targetOdds);
 const queue=planned.alternatives.sort((a,b)=>b[0].modelLowerBound-a[0].modelLowerBound).slice(0,Math.min(12,limit+4));
 const quoted=[];
 let attempts=0,failures=0,invalid=0;
 async function worker(){
  while(queue.length){
   for(const group of queue.shift()){
    const selections=group.selections.map(selectionPayload);
    if(selections.some(s=>!s)||!/^sr:match:\d+$/.test(group.eventId))continue;
    attempts++;
    try{
     const data=(await quote({eventId:group.eventId,selections,odds:selections[0].odds,latestSelection:selections[1]}))?.data;
     const odds=Number(data?.odds);
     if(data?.valid!==true||!Number.isFinite(odds)||odds<=1){invalid++;continue;}
     quoted.push({...group,odds,bookingSelection:{eventId:group.eventId,marketId:String(data.marketId??''),outcomeId:String(data.outcomeId??''),children:group.selections.map(({marketId,outcomeId,specifier})=>({marketId:String(marketId),outcomeId:String(outcomeId),specifier:specifier||null}))},selections:group.selections.map(({betType,market,pick,modelProbability})=>({betType,market,pick,modelProbability}))});
     break;
    }catch{failures++;break;}
   }
  }
 }
 await Promise.all(Array.from({length:3},worker));
 quoted.sort((a,b)=>b.modelLowerBound-a.modelLowerBound||Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||a.eventId.localeCompare(b.eventId));
 const builders=[];
 let combinedOdds=1;
 for(const group of quoted.slice(0,limit)){
  builders.push(group);
  combinedOdds*=group.odds;
  if(target>1&&combinedOdds>=target)break;
 }
 return {builders,combinedOdds:builders.length?combinedOdds:null,candidateMatches:planned.candidateMatches,minProbability:planned.minProbability,
   targetReached:target>1?combinedOdds>=target:null,attempts,failures,invalid};
}

function validBookingSelections(rows){
 return Array.isArray(rows)&&rows.length>=1&&rows.length<=8&&
  new Set(rows.map(s=>s?.eventId)).size===rows.length&&new Set(rows.map(s=>s?.marketId)).size===rows.length&&rows.every(s=>
   /^sr:match:\d+$/.test(s?.eventId)&&/^\d+bb\d+$/.test(s.marketId)&&/^\d+$/.test(s.outcomeId)&&!s.specifier&&!s.live&&
   Array.isArray(s.children)&&s.children.length===2&&s.children[0]?.marketId!==s.children[1]?.marketId&&
   s.children.every(c=>typeof c?.marketId==='string'&&/^\d+$/.test(c.marketId)&&typeof c.outcomeId==='string'&&/^\d+$/.test(c.outcomeId)&&
    (c.specifier==null||typeof c.specifier==='string'&&/^[a-z0-9_.=|+:-]{1,120}$/i.test(c.specifier))));
}
function shareSelections(rows){
 return rows.flatMap(({eventId,marketId,outcomeId,children})=>[
  ...children.map(c=>({eventId,marketId:c.marketId,outcomeId:c.outcomeId,...(c.specifier?{specifier:c.specifier}:{}),parentBetBuilderMarketId:marketId})),
  {eventId,marketId,outcomeId},
 ]);
}
async function bookGroups(rows,{bookBet,getBooking}){
 if(!validBookingSelections(rows))throw Error('Refresh Bet Builder to get valid SportyBet group quotes.');
 const selections=shareSelections(rows);
 const booked=await bookBet(selections);
 const unknown=()=>Object.assign(Error('SportyBet did not confirm all Bet Builder groups on the shared slip.'),{code:'BET_BUILDER_UNCONFIRMED',bookingOutcomeUnknown:!!booked?.shareCode});
 if(!booked?.shareCode||booked.unavailableOutcomes?.length)throw unknown();
 let ticket;
 try{ticket=await getBooking(booked.shareCode,{fresh:true});}catch{throw unknown();}
 const spec=v=>(v&&typeof v==='object'?Object.entries(v).map(([k,x])=>k+'='+x):String(v??'').split('|')).filter(Boolean).sort().join('|');
 const key=s=>JSON.stringify([String(s.eventId),String(s.marketId),String(s.outcomeId),spec(s.specifier??s.specifiers),String(s.parentBetBuilderMarketId??'')]);
 const decoded=require('./bookingDecoder').decodeBookingSelections(ticket);
 const outcomeRows=require('./bookingDecoder').decodeBookingSelections({outcomes:ticket?.outcomes});
 const matches=rows=>{
  const actual=new Set(rows.map(key));
  return rows.length===selections.length&&selections.every(s=>actual.has(key(s)));
 };
 if(!matches(decoded)&&!matches(outcomeRows))throw unknown();
 return booked;
}

module.exports={preview,quotePreview,validBookingSelections,bookGroups,marketTypes:[...resultTypes,...companionTypes]};
