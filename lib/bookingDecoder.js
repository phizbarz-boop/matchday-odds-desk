'use strict';
const spec=v=>v&&typeof v==='object'?Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>`${k}=${x}`).join('|'):String(v??'').split('|').map(x=>x.trim()).filter(Boolean).sort().join('|');
function decodeBookingSelections(payload){
 if(!payload||typeof payload!=='object')return [];
 const b=payload.data&&typeof payload.data==='object'?payload.data:payload;
 const events=Array.isArray(b.outcomes)?b.outcomes:[];
 const selected=b.ticket?.selections;
 const flatten=(e,m,o,s={})=>({...e,...s,sport:e.sport?.name||e.sport||s.sport||'',
  tournament:e.sport?.category?.tournament?.name||e.tournament||'',
  marketId:String(s.marketId??m?.id??m?.marketId??''),marketDesc:m?.desc||m?.name||s.marketDesc||'',
  outcomeId:String(s.outcomeId??o?.id??o?.outcomeId??''),outcomeDesc:o?.desc||o?.name||s.outcomeDesc||'',
  specifier:s.specifier??s.specifiers??m?.specifier??m?.specifiers??null,odds:s.odds??o?.odds??null});
 if(Array.isArray(selected)&&selected.length&&events.some(e=>Array.isArray(e.markets))){
  return selected.map(s=>{
   const e=events.find(e=>String(e.eventId)===String(s.eventId))||{};
   const matches=(e.markets||[]).filter(m=>String(m.id??m.marketId)===String(s.marketId)&&spec(m.specifier??m.specifiers)===spec(s.specifier??s.specifiers));
   const m=matches.length===1?matches[0]:null;
   const os=(m?.outcomes||[]).filter(o=>String(o.id??o.outcomeId)===String(s.outcomeId));
   return flatten(e,m,os.length===1?os[0]:null,s);
  });
 }
 for(const key of ['outcomes','selections','bets','items'])if(Array.isArray(b[key])){
  return b[key].flatMap(e=>Array.isArray(e.markets)?e.markets.flatMap(m=>(m.outcomes||[]).map(o=>flatten(e,m,o))):[e]);
 }
 if(Array.isArray(selected))return selected;
 return [];
}
module.exports={decodeBookingSelections};
