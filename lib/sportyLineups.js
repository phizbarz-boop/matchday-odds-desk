'use strict';
const PREFIX='sportybet:player-lineups:v1:',QUEUE=PREFIX+'queue';
const fixtureKey=c=>PREFIX+'fixture:'+String(c.eventId),dataKey=c=>PREFIX+'data:'+String(c.eventId);
const decode=s=>{try{return s?JSON.parse(s):null;}catch{return null;}};
function displayName(value){const parts=String(value||'').split(',').map(s=>s.trim());return parts.length===2?parts[1]+' '+parts[0]:String(value||'').trim();}
function parseUsual(payload,{teamId,seasonId}){
 const query=`stats_team_usuallineup/${teamId}/${seasonId}`;
 if(payload?.queryUrl!==query)return null;
 const data=payload.doc?.find(d=>d.event==='stats_team_usuallineup')?.data;
 if(!Array.isArray(data?.players)||data.players.length!==11)return null;
 const rows=data.players.map(p=>({id:String(p._id||''),name:displayName(p.name),position:p.position?.name||p.primaryposition?.name||null,positionCode:p.position?.matchpos||p.primaryposition?._position||null,teamId:String(teamId),basis:'usual',provider:'sportybet',startingLineupConfirmed:false}));
 if(rows.some(p=>!p.id||!p.name)||new Set(rows.map(p=>p.id)).size!==11)return null;
 return rows;
}
function timelineIdentity(payload,c){
 const id=String(c.eventId).replace(/^sr:match:/,'');
 if(payload?.queryUrl!=='match_timelinedelta/'+id)return null;
 const m=payload.doc?.find(d=>d.event==='match_timelinedelta')?.data?.match;
 const same=require('./apiSportsH2hData').sameTeam;
 if(!m||String(m._id)!==id||m._sid!==1||!/^\d+$/.test(String(m._seasonid))||m.removed||m.cancelled)return null;
 for(const side of ['home','away'])if(![m.teams?.[side]?.name,m.teams?.[side]?.mediumname].some(n=>n&&same(n,c[side],'football')))return null;
 if(!Number.isFinite(Number(m._dt?.uts))||Math.abs(Number(m._dt.uts)*1000-Date.parse(c.kickoffUtc))>90*60000)return null;
 const teams=['home','away'].map(side=>String(m.teams[side].uid));if(teams.some(t=>!/^\d+$/.test(t))||teams[0]===teams[1])return null;
 return {teams,seasonId:String(m._seasonid)};
}
function usable(e,c,now=Date.now()){
 return (e?.basis==='usual'||(e?.basis==='confirmed'&&e.provider==='espn'&&e.startingLineupConfirmed===true&&Array.isArray(e.players)&&e.players.every(p=>p.startingLineupConfirmed===true)))&&e.eventId===String(c.eventId)&&e.home===c.home&&e.away===c.away&&e.kickoffUtc===c.kickoffUtc&&now-Date.parse(e.capturedAt)>=0&&now-Date.parse(e.capturedAt)<6*3600000&&Array.isArray(e.players)&&e.players.length===22;
}
async function readOrQueue(redis,c){
 if(!redis)throw Object.assign(Error('Shared SportyBet lineup cache is unavailable'),{code:'SPORTYBET_LINEUP_CACHE_UNAVAILABLE'});
 const evidence=decode(await redis.get(dataKey(c)));
 if(usable(evidence,c))return evidence.players.map(p=>({...p,provider:evidence.provider||'sportybet',basis:evidence.basis,startingLineupConfirmed:evidence.basis==='confirmed'}));
 if(!/^sr:match:\d+$/.test(String(c.eventId)))return [];
 const fixture=Object.fromEntries(['eventId','home','away','sport','kickoffUtc','tournament','category'].map(k=>[k,c[k]??'']));
 await redis.set(fixtureKey(c),JSON.stringify(fixture),{EX:172800});await redis.sAdd(QUEUE,String(c.eventId));await redis.expire(QUEUE,172800);
 throw Object.assign(Error('SportyBet usual lineup queued for automatic public collection'),{code:'SPORTYBET_USUAL_LINEUP_PENDING'});
}
module.exports={PREFIX,QUEUE,fixtureKey,dataKey,decode,parseUsual,timelineIdentity,usable,readOrQueue,displayName};
