'use strict';
const {decodeBookingSelections}=require('./bookingDecoder');
function codes(value){
 const list=Array.isArray(value)?value:String(value||'').split(/[\s,;]+/).filter(Boolean);
 if(list.length<2||list.length>3)throw Error('Enter two or three SportyBet booking codes.');
 const result=list.map(c=>String(c).trim().toUpperCase());
 if(result.some(c=>!/^[A-Z0-9_-]{4,24}$/.test(c)))throw Error('Enter valid SportyBet booking codes, separated by spaces or new lines.');
 if(new Set(result).size!==result.length)throw Error('Enter different booking codes.');
 return result;
}
const spec=v=>v&&typeof v==='object'?Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>k+'='+x).join('|'):String(v??'').split('|').map(x=>x.trim()).filter(Boolean).sort().join('|');
const selectionKey=row=>JSON.stringify([String(row.eventId),String(row.marketId),String(row.outcomeId),spec(row.specifier)||null]);
async function currentRows(row){
 const sporty=require('./sportybet');
 return sporty.flattenDetailedMarkets(await sporty.direct.fetchEventDetail(row.eventId),row);
}
async function preview(value,{getBooking,normalize,getCurrent=currentRows}){
 const sources=codes(value),events=new Map(),exact=new Map();let duplicates=0;
 for(const code of sources){
  const raw=decodeBookingSelections(await getBooking(code,{fresh:true}));
  if(!raw.length||raw.length>50)throw Error(code+': could not read a ticket containing 1–50 selections.');
  for(const item of raw){
   const row=normalize(item);
   if(!row.eventId||!row.marketId||!row.outcomeId)throw Error(code+': a selection has incomplete market details. No selections were merged.');
   row.specifier=spec(row.specifier)||null;
   if(item.live===true)row.live=true;
   const key=selectionKey(row);
   if(exact.has(key)){duplicates++;exact.get(key).sourceCodes.push(code);continue;}
   const entry={...row,sourceCodes:[code]};exact.set(key,entry);
   const eventId=String(row.eventId);if(!events.has(eventId))events.set(eventId,[]);events.get(eventId).push(entry);
  }
 }
 if(events.size>50)throw Error('Combined ticket has '+events.size+' unique games. SportyBet allows at most 50; split or shorten the source tickets first.');
 const selections=[],conflictsResolved=[];
 for(const group of events.values()){
  if(group.length===1){selections.push(group[0]);continue;}
  let current;try{current=await getCurrent(group[0]);}catch(error){throw Error('Could not verify current odds for '+(group[0].home+' vs '+group[0].away)+'. Please retry.');}
  const available=new Map(current.filter(c=>Number(c.odds)>1&&!c.suspended&&c.active!==false).map(c=>[selectionKey(c),c]));
  const verified=group.map(c=>{const fresh=available.get(selectionKey(c));return fresh?{...c,odds:Number(fresh.odds),oddsVerified:true}:null;}).filter(Boolean).sort((a,b)=>b.odds-a.odds);
  if(!verified.length)throw Error('None of the conflicting selections is currently available for '+group[0].home+' vs '+group[0].away+'. No ticket was booked.');
  const kept=verified[0],discarded=group.filter(c=>selectionKey(c)!==selectionKey(kept)).map(c=>({...c,verifiedOdds:available.get(selectionKey(c))?.odds??null}));
  selections.push(kept);conflictsResolved.push({eventId:kept.eventId,home:kept.home,away:kept.away,kept,discarded});
 }
 const priced=selections.every(c=>Number(c.odds)>1);
 return {sourceCodes:sources,selections,duplicatesRemoved:duplicates,conflictsResolved,combinedOdds:priced?selections.reduce((n,c)=>n*Number(c.odds),1):null};
}
module.exports={codes,preview};
