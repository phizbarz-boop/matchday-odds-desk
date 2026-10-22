(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TicketSplit=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 const key=x=>[x.eventId,x.marketId,x.outcomeId,x.specifier||''].join('|');
 function splitTicket(selections,parts=5){
  if(!Array.isArray(selections)||!selections.length||selections.length>50)throw Error('Choose a ticket containing 1–50 matches.');
  parts=Number(parts);if(!Number.isInteger(parts)||parts<1||parts>10||parts>selections.length)throw Error('Choose 1–10 tickets, with at least one match in each.');
  if(selections.some(x=>!x.eventId||!x.marketId||!x.outcomeId||!(Number(x.odds)>1)||x.replaced))throw Error('Every original selection needs its exact market, outcome and odds. Analyze the original code without replacements first.');
  if(new Set(selections.map(key)).size!==selections.length)throw Error('The ticket contains repeated selections. Remove exact duplicates first.');
  const probability=x=>x.supported===false||x.probability==null||!Number.isFinite(Number(x.probability))?null:Number(x.probability);
  const sorted=selections.map((x,i)=>({...x,originalPosition:i+1})).sort((a,b)=>(probability(b)??-1)-(probability(a)??-1)||a.originalPosition-b.originalPosition);
  const base=Math.floor(sorted.length/parts),extra=sorted.length%parts;let offset=0;
  return Array.from({length:parts},(_,i)=>{const rows=sorted.slice(offset,offset+base+(i<extra?1:0));offset+=rows.length;const ps=rows.map(probability).filter(p=>p!=null);return {index:i+1,selections:rows,combinedOdds:rows.reduce((n,x)=>n*Number(x.odds),1),minProbability:ps.length?Math.min(...ps):null,maxProbability:ps.length?Math.max(...ps):null,unscored:rows.length-ps.length};});
 }
 return {splitTicket,key};
});
