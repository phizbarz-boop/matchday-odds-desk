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
async function preview(value,{getBooking,normalize}){
 const sources=codes(value),events=new Map(),exact=new Map();let duplicates=0;
 for(const code of sources){
  const raw=decodeBookingSelections(await getBooking(code,{fresh:true}));
  if(!raw.length||raw.length>50)throw Error(code+': could not read a ticket containing 1–50 selections.');
  for(const item of raw){
   const row=normalize(item);
   if(!row.eventId||!row.marketId||!row.outcomeId)throw Error(code+': a selection has incomplete market details. No selections were merged.');
   row.specifier=spec(row.specifier)||null;
   if(item.live===true)row.live=true;
   const key=JSON.stringify([row.eventId,row.marketId,row.outcomeId,row.specifier]);
   if(exact.has(key)){duplicates++;continue;}
   if(events.has(row.eventId))throw Error('The same match has different selections across these tickets: '+(row.home&&row.away?row.home+' vs '+row.away:row.eventId)+'. Remove the conflicting selection from one source ticket first.');
   events.set(row.eventId,key);exact.set(key,{...row,sourceCodes:[code]});
  }
 }
 const selections=[...exact.values()];
 if(selections.length>50)throw Error('Combined ticket has '+selections.length+' unique games. SportyBet allows at most 50; split or shorten the source tickets first.');
 const priced=selections.every(c=>Number(c.odds)>1);
 return {sourceCodes:sources,selections,duplicatesRemoved:duplicates,combinedOdds:priced?selections.reduce((n,c)=>n*Number(c.odds),1):null};
}
module.exports={codes,preview};
