'use strict';
const key=r=>String(r.eventId)+'|'+Boolean(r.live);
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function winnerOddsGap(rows,threshold=5,{atMost=false}={}){
 const groups=new Map(),eligible=new Map();
 for(const r of rows){
  if(!r.eventId||!Number.isFinite(Number(r.odds))||!(Number(r.odds)>1)||r.active===false||r.suspended)continue;
  const football=/football|soccer/i.test(r.sport||''),name=String(r.marketDesc||'');
  if(football&&String(r.marketId)!=='1')continue;
  if(/half|quarter|period|\bset\b|\bgame\b|handicap|spread|corner|card|\b[12]\s*-?\s*up\b|total|over\/under|double chance/i.test(name))continue;
  if(!football&&!/winner|moneyline|match result|1x2/i.test(name))continue;
  const k=key(r)+'|'+r.marketId+'|'+(r.specifier||'');
  if(!groups.has(k))groups.set(k,new Map());groups.get(k).set(String(r.outcomeId),r);
 }
 for(const map of groups.values()){
  const group=[...map.values()];
  const side=c=>{const t=String(c.outcomeDesc||'').trim();return /^(home|1)$/i.test(t)||norm(t)===norm(c.home)&&!!norm(t)?'home':/^(away|2)$/i.test(t)||norm(t)===norm(c.away)&&!!norm(t)?'away':null;};
  const h=group.filter(c=>side(c)==='home'),a=group.filter(c=>side(c)==='away');
  if(h.length!==1||a.length!==1)continue;
  const gap=Math.abs(Number(h[0].odds)-Number(a[0].odds));
  if(atMost?gap<=threshold+1e-9:gap>threshold+1e-9)eligible.set(key(h[0]),{homeOdds:Number(h[0].odds),awayOdds:Number(a[0].odds),gap});
 }
 return eligible;
}
function configuredWinnerOddsGap(rows,{winnerGapOnly=false,winnerGapMaxOne=false,winnerGapMaxTwo=false}={}){
 if([winnerGapOnly,winnerGapMaxOne,winnerGapMaxTwo].filter(Boolean).length>1)throw Error('Choose only one winner odds gap filter');
 return winnerOddsGap(rows,winnerGapMaxOne?1:winnerGapMaxTwo?2:5,{atMost:winnerGapMaxOne||winnerGapMaxTwo});
}
module.exports={winnerOddsGap,configuredWinnerOddsGap,key};
