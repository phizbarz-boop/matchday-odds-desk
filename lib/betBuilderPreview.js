'use strict';

const MAX_PICKS=10;
const MAX_SHARE_ROWS=50;
const floorOf=value=>value==null?55:Math.min(100,Math.max(0,Number(value)||0));
const matchLimit=value=>Math.min(8,Math.max(1,parseInt(value,10)||4));
const marketKey=c=>String(c.marketId)+'?'+String(c.specifier??'');
const bound=legs=>Math.max(0,legs.reduce((sum,c)=>sum+c.modelProbability,0)-100*(legs.length-1));
const publicLeg=({betType,market,pick,modelProbability})=>({betType,market,pick,modelProbability});
function preview(candidates,{minProbability=55,maxMatches=4,now=Date.now(),quoteCandidates=false}={}){
 const floor=floorOf(minProbability);
 const groups=new Map();
 for(const c of candidates||[]){
  const modelProbability=Number(c.fullWinProbability??c.probability);
  if(!/^(football|soccer)$/i.test(c.sport||'')||c.live||c.suspended||c.active===false||
    !c.eventId||!(Date.parse(c.kickoffUtc)>now)||!Number.isFinite(Number(c.odds))||Number(c.odds)<=1||
    !Number.isFinite(modelProbability)||modelProbability<floor||modelProbability>100)continue;
  const row={...c,modelProbability,market:c.marketDesc||c.betType,pick:c.outcomeDesc||c.pick||c.betType};
  if(!selectionPayload(row))continue;
  if(!groups.has(c.eventId))groups.set(c.eventId,new Map());
  const rows=groups.get(c.eventId),key=marketKey(c)+'/'+c.outcomeId;
  if(!rows.has(key)||rows.get(key).modelProbability<modelProbability)rows.set(key,row);
 }
 const alternatives=[];
 for(const [eventId,rows] of groups){
  const pool=[...rows.values()].sort((a,b)=>b.modelProbability-a.modelProbability||Number(a.odds)-Number(b.odds)).slice(0,120);
  const first=pool[0],second=pool.find(c=>marketKey(c)!==marketKey(first));
  if(!second)continue;
  alternatives.push({eventId,home:first.home,away:first.away,kickoffUtc:first.kickoffUtc,pool,selections:[first,second],modelLowerBound:bound([first,second])});
 }
 alternatives.sort((a,b)=>b.modelLowerBound-a.modelLowerBound||Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
 const builders=alternatives.slice(0,matchLimit(maxMatches)).map(({pool,...g})=>({...g,selections:g.selections.map(publicLeg)}));
 return {builders,candidateMatches:alternatives.length,minProbability:floor,...(quoteCandidates?{alternatives}:{})};
}
function selectionPayload(c){
 const market=String(c.marketId),outcome=String(c.outcomeId),specifier=String(c.specifier??'');
 if(!/^\d+$/.test(market)||!/^\d+$/.test(outcome)||!/^[a-z0-9_.=|+:-]{0,120}$/i.test(specifier))return null;
 return {id:`uof:3/sr:sport:1/${market}/${outcome}?${specifier}`,odds:String(c.odds),probability:(c.modelProbability/100).toFixed(10)};
}

async function quotePreview(candidates,options,quote){
 const planned=preview(candidates,{...options,quoteCandidates:true});
 const limit=matchLimit(options.maxMatches);
 const maxPicks=Math.min(MAX_PICKS,Math.max(3,parseInt(options.maxPicks,10)||8));
 const target=Number(options.targetOdds);
 const queue=planned.alternatives.slice(0,Math.min(12,limit+4));
 const quoted=[];
 const stopAt=Date.now()+25000;
 let attempts=0,failures=0,invalid=0;
 async function worker(){
  while(queue.length&&Date.now()<stopAt){
   const {pool,selections:seed,modelLowerBound,...group}=queue.shift();
   if(!/^sr:match:\d+$/.test(group.eventId))continue;
   let accepted=[],data=null;
   const rejected=new Set();
   for(let tries=0;tries<maxPicks+5&&Date.now()<stopAt;tries++){
    const first=accepted[0]||pool.find(c=>!rejected.has(c));
    if(!first)break;
    const current=accepted.length?accepted:[first];
    const next=pool.find(c=>!rejected.has(c)&&!current.some(x=>marketKey(x)===marketKey(c))&&
     !(data?.incompatibleMarkets||[]).some(m=>String(m.marketId)===String(c.marketId)&&String(m.specifier??'')===String(c.specifier??'')&&Array.isArray(m.outcomeIds)&&m.outcomeIds.map(String).includes(String(c.outcomeId))));
    if(!next)break;
    const picks=[...current,next],selections=picks.map(selectionPayload);
    attempts++;
    try{
     const reply=(await quote({eventId:group.eventId,selections,odds:data?.odds??selections[0].odds,latestSelection:selections.at(-1)}))?.data;
     const odds=Number(reply?.odds);
     if(reply?.valid!==true||!Number.isFinite(odds)||odds<=1){
      invalid++;rejected.add(next);
      if(!accepted.length&&(tries===2||!pool.some(c=>!rejected.has(c)&&marketKey(c)!==marketKey(first)))){rejected.clear();rejected.add(first);}
      continue;
     }
     accepted=picks;data=reply;
     if(accepted.length>=maxPicks)break;
    }catch{failures++;break;}
   }
   if(data)quoted.push({...group,odds:Number(data.odds),modelLowerBound:bound(accepted),
    bookingSelection:{eventId:group.eventId,marketId:String(data.marketId??''),outcomeId:String(data.outcomeId??''),
     children:accepted.map(({marketId,outcomeId,specifier})=>({marketId:String(marketId),outcomeId:String(outcomeId),specifier:specifier||null}))},
    selections:accepted.map(publicLeg)});
  }
 }
 await Promise.all(Array.from({length:3},worker));
 quoted.sort((a,b)=>Number(b.selections.length>=3)-Number(a.selections.length>=3)||b.modelLowerBound-a.modelLowerBound||b.selections.length-a.selections.length||Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc)||a.eventId.localeCompare(b.eventId));
 const builders=[];
 let combinedOdds=1,shareRows=0;
 for(const group of quoted){
  if(builders.length>=limit)break;
  const rows=group.selections.length+1;
  if(shareRows+rows>MAX_SHARE_ROWS)continue;
  builders.push(group);shareRows+=rows;
  combinedOdds*=group.odds;
  if(target>1&&combinedOdds>=target)break;
 }
 return {builders,combinedOdds:builders.length?combinedOdds:null,candidateMatches:planned.candidateMatches,minProbability:planned.minProbability,
   targetReached:target>1?combinedOdds>=target:null,attempts,failures,invalid};
}

function validBookingSelections(rows){
 return Array.isArray(rows)&&rows.length>=1&&rows.length<=8&&
  rows.reduce((n,s)=>n+1+(s?.children?.length||0),0)<=MAX_SHARE_ROWS&&
  new Set(rows.map(s=>s?.eventId)).size===rows.length&&new Set(rows.map(s=>s?.marketId)).size===rows.length&&rows.every(s=>
   /^sr:match:\d+$/.test(s?.eventId)&&/^\d+bb\d+$/.test(s.marketId)&&/^\d+$/.test(s.outcomeId)&&!s.specifier&&!s.live&&
   Array.isArray(s.children)&&s.children.length>=2&&s.children.length<=MAX_PICKS&&new Set(s.children.map(c=>c&&marketKey(c))).size===s.children.length&&
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

module.exports={preview,quotePreview,validBookingSelections,bookGroups};
