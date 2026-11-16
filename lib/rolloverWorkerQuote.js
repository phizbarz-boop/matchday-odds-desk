'use strict';
const crypto=require('node:crypto');
function authorized(header,token){
 if(typeof token!=='string'||token.length<32||typeof header!=='string'||!header.startsWith('Bearer '))return false;
 const supplied=Buffer.from(header.slice(7)),expected=Buffer.from(token);
 return supplied.length===expected.length&&crypto.timingSafeEqual(supplied,expected);
}
function compare(ticket,rows,normalizeLine,now=Date.now(),{minOdds,maxOdds,maxLegOdds=maxOdds,maxLegs}){
 if(!Array.isArray(ticket?.legs)||ticket.legs.length<1||ticket.legs.length>maxLegs||
  new Set(ticket.legs.map(x=>x.eventId)).size!==ticket.legs.length||!ticket.legs.every(x=>Date.parse(x.kickoffUtc)>now+20000))return {status:'closed_or_near_kickoff'};
 if(!Array.isArray(rows)||rows.length!==ticket.legs.length)return {status:'selection_mismatch'};
 const key=x=>JSON.stringify([String(x.eventId),String(x.marketId),String(x.outcomeId),normalizeLine(x.specifier)]);
 const byKey=new Map(rows.map(x=>[key(x),x]));
 if(byKey.size!==rows.length||new Set(ticket.legs.map(key)).size!==rows.length)return {status:'selection_mismatch'};
 const prices=ticket.legs.map(x=>byKey.get(key(x))?.odds);
 if(prices.some(x=>!Number.isFinite(x)||x<=1))return {status:'selection_mismatch'};
 if(prices.some(x=>x>maxLegOdds))return {status:'selection_odds_above_cap'};
 const odds=prices.reduce((a,b)=>a*b,1);
 if(odds<minOdds-1e-9||odds>maxOdds+1e-9||prices.some((x,i)=>Math.abs(x-ticket.legs[i].odds)>1e-9))
  return {status:'odds_changed',odds};
 return {status:'quote_matches',odds};
}
module.exports={authorized,compare};
