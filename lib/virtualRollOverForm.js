'use strict';
const {sportyRequest}=require('./sportybetDirect');
const normalize=s=>String(s??'').trim().toUpperCase();
function teamForm(team){
 if(!team?.teamId||!Array.isArray(team.recentMatches))return null;
 const rows=team.recentMatches.slice(0,5);
 if(rows.length!==5)return null;
 const names=normalize(team.teamName),id=String(team.teamId);
 const games=rows.map(row=>{
  if(!row||!row.homeTeamId||!row.awayTeamId||String(row.homeTeamId)===String(row.awayTeamId))return null;
  const [h,a]=[row.homeScore,row.awayScore];
  if(![h,a].every(n=>Number.isInteger(n)&&n>=0&&n<=99))return null;
  if(String(row.homeTeamId)===id&&normalize(row.homeTeamName)===names)return [h,a];
  if(String(row.awayTeamId)===id&&normalize(row.awayTeamName)===names)return [a,h];
  return null;
 });
 return games.every(Boolean)?games:null;
}
function parse(payload,fixture){
 const data=payload?.data;
 if(Number(payload?.bizCode)!==10000||!data?.homeTeam||!data?.awayTeam||!fixture.home||!fixture.away)return null;
 if(normalize(data.homeTeam.teamName)!==normalize(fixture.home)||normalize(data.awayTeam.teamName)!==normalize(fixture.away)||
    String(data.homeTeam.teamId)===String(data.awayTeam.teamId))return null;
 const home=teamForm(data.homeTeam),away=teamForm(data.awayTeam);
 return home&&away?{home,away}:null;
}
async function collect(fixture,{signal,request=sportyRequest}={}){
 if(!/^sr:match:\d+$/.test(fixture.eventId))return null;
 signal?.throwIfAborted();
 const data=await request('/scheduledVirtual/api/v1/stats/team_stats',{
  params:{eventId:fixture.eventId,_t:Date.now()},publicRead:true,timeoutMs:2500
 });
 signal?.throwIfAborted();
 return parse(data,fixture);
}
module.exports={collect,parse};
