'use strict';
const key=r=>String(r.eventId)+'|'+Boolean(r.live);
const norm=v=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
function winnerOddsGap(rows,threshold=5){const groups=new Map(),eligible=new Map();for(const r of rows){if(!r.eventId||!(Number(r.odds)>1)||r.active===false||r.suspended)continue;if(/football|soccer/i.test(r.sport||'')&&String(r.marketId)!=='1')continue;if(/half|quarter|period|handicap|\b[12]\s*-?\s*up\b|total|over\/under|double chance/i.test(r.marketDesc||''))continue;const k=key(r)+'|'+r.marketId+'|'+(r.specifier||'');if(!groups.has(k))groups.set(k,[]);groups.get(k).push(r);}
 for(const group of groups.values()){const side=c=>{const t=String(c.outcomeDesc||'').trim();return /^(home|1)$/i.test(t)||norm(t)===norm(c.home)&&!!norm(t)?'home':/^(away|2)$/i.test(t)||norm(t)===norm(c.away)&&!!norm(t)?'away':null;};const h=group.filter(c=>side(c)==='home'),a=group.filter(c=>side(c)==='away');if(h.length!==1||a.length!==1)continue;const gap=Math.abs(Number(h[0].odds)-Number(a[0].odds));if(gap>threshold+1e-9)eligible.set(key(h[0]),{homeOdds:Number(h[0].odds),awayOdds:Number(a[0].odds),gap});}return eligible;
}
module.exports={winnerOddsGap,key};
