'use strict';
const {scoreMatrix,outcomeProbs}=require('./model');
const numeric=x=>x==null || x==='' ? null : Number.isFinite(Number(x)) ? Number(x) : null;
const phaseCodes={H1:'1st half',H2:'2nd half',HT:'half-time',Q1:'1st quarter',Q2:'2nd quarter',Q3:'3rd quarter',Q4:'4th quarter',P1:'1st period',P2:'2nd period',P3:'3rd period',S1:'set 1',S2:'set 2',S3:'set 3',S4:'set 4',S5:'set 5',OT:'overtime',ET:'extra time'};
function parseClock(value,{seconds=false}={}) {
  if(value==null || String(value).trim()==='')return null;
  const text=String(value).trim(),m=text.match(/^(\d+)(?:\+(\d+))?(?::([0-5]\d))?\s*['′]?$/);
  if(m)return m[3]!=null || m[2]!=null || !seconds?Number(m[1])+Number(m[2]||0)+Number(m[3]||0)/60:Number(m[1])/60;
  const n=numeric(text);return n!=null&&n>=0?(seconds?n/60:n):null;
}
function liveState(e={}) {
  if(e.liveState)return e.liveState;
  const bits=[e.liveStatus,e.matchStatus,e.status,e.matchPhase,e.phase,e.period?.name,e.period?.desc,typeof e.period==='string'?e.period:null,e.sportEventStatus?.description,e.sportEventStatus?.status,e.gameStatus].filter(x=>x!=null).map(String);
  const phase=bits.map(x=>phaseCodes[x.trim().toUpperCase()] || x).join(' ');
  const raw=e.score ?? e.currentScore ?? e.matchScore ?? e.setScore ?? e.sportEventStatus?.score;
  const pair=typeof raw==='string'?raw.match(/^\s*(\d+)\s*[:-]\s*(\d+)\s*$/):null;
  const home=numeric(e.homeScore ?? e.homeTeamScore ?? raw?.home ?? raw?.homeScore ?? e.sportEventStatus?.homeScore ?? pair?.[1]);
  const away=numeric(e.awayScore ?? e.awayTeamScore ?? raw?.away ?? raw?.awayScore ?? e.sportEventStatus?.awayScore ?? pair?.[2]);
  const clock=String(e.playedSeconds ?? e.matchMinute ?? e.minute ?? e.playedTime ?? e.clock ?? e.matchTime ?? '');
  const minute=parseClock(clock,{seconds:e.playedSeconds!=null});
  return {phase,homeScore:home,awayScore:away,minute,clock};
}
function ongoing(e={}) {
  const s=liveState(e),status=s.phase.toLowerCase();
  if(e.banned===true || /not start(?:ed)?|scheduled|upcoming|prematch|pre[- ]?match|postponed|cancelled|canceled|abandoned|interrupted|ended|finished|full[- ]?time|\bft\b|closed|resulted|after extra|\baet\b|after penalties/.test(status))return false;
  for(const k of ['live','inPlay','in_play','isLive','liveBetting','inplay'])if(e[k]!=null && e[k]!=='')return /^(1|true|yes|live)$/i.test(String(e[k]));
  if(/live|in[- ]?play|running|ongoing|[12](?:st|nd)? half|first half|second half|halftime|half[- ]time|extra time|overtime|quarter|period|inning|timeout|break|set\s*\d|\d+(?:st|nd|rd|th)\s+set/.test(status))return true;
  // Do not promote a passed kickoff or a numeric availability status to live.
  return s.minute!=null && s.homeScore!=null && s.awayScore!=null && s.minute>0 && s.minute<=130;
}
function lateStage(row) {
  const s=liveState(row), sport=String(row.sport||'').toLowerCase(), p=s.phase.toLowerCase();
  if(s.homeScore==null || s.awayScore==null || s.homeScore===s.awayScore)return false;
  if(sport.includes('football') || sport==='soccer')return s.minute!=null && s.minute>=75 && s.minute<=110 && !/extra|penalt/.test(p);
  if(sport.includes('basket'))return /(?:4th|fourth|4)\s*quarter|quarter\s*4|\bq4\b|overtime/.test(p);
  if(sport.includes('hockey'))return /(?:3rd|third|3)\s*period|period\s*3|\bp3\b|overtime/.test(p);
  if(sport.includes('handball'))return s.minute!=null && s.minute>=50 && /2nd half|second half|2 half/.test(p);
  // A set number without the match format does not establish a final set.
  return false;
}
function winningSideSelection(row) {
  if(!lateStage(row))return false;
  const s=liveState(row), home=s.homeScore>s.awayScore;
  const t=String(row.betType||'');
  if(t==='home_win')return home;
  if(t==='away_win')return !home;
  if(t==='dc_1x')return home;
  if(t==='dc_x2')return !home;
  if(/\b(?:draw|totals?|over|under|corners?|score|sets?|period|quarter|half|race|first|last)\b/i.test(row.marketDesc||'') && !/draw no bet/i.test(row.marketDesc||''))return false;
  const d=String(row.outcomeDesc||'').trim().toLowerCase();
  if(/winner|1x2|draw no bet|handicap/i.test(row.marketDesc||'')) {
    // Handicap outcome descriptions include the line. Only accept an explicit side.
    const h=/^home(?:\b|$)/.test(d) || d===String(row.home||'').toLowerCase() || d.startsWith(String(row.home||'').toLowerCase()+' (') || d.startsWith(String(row.home||'').toLowerCase()+' +') || d.startsWith(String(row.home||'').toLowerCase()+' -');
    const a=/^away(?:\b|$)/.test(d) || d===String(row.away||'').toLowerCase() || d.startsWith(String(row.away||'').toLowerCase()+' (') || d.startsWith(String(row.away||'').toLowerCase()+' +') || d.startsWith(String(row.away||'').toLowerCase()+' -');
    return home?h:a;
  }
  return false;
}
function conditionFootballModel(model,row) {
  const s=liveState(row);
  if(!model.goalModelAvailable || s.homeScore==null || s.awayScore==null || s.minute==null || s.minute>90 || /extra|penalt/.test(s.phase))return {...model,goalModelAvailable:false,corners:null,marketModel:true,dataSource:'SportyBet live no-vig market estimates'};
  // Model final regulation score from the observed score and remaining duration.
  const fraction=Math.max(0.02,(95-s.minute)/95);
  const lh=Number(model.goalLambdaHome)*fraction,la=Number(model.goalLambdaAway)*fraction;
  const remaining=scoreMatrix(lh,la,18), size=19+Math.max(s.homeScore,s.awayScore);
  const m=Array.from({length:size},()=>Array(size).fill(0));
  for(let h=0;h<remaining.length;h++)for(let a=0;a<remaining[h].length;a++)m[h+s.homeScore][a+s.awayScore]=remaining[h][a];
  const p=outcomeProbs(m), mass=p.homeWin+p.draw+p.awayWin, pct=x=>Math.round(x/mass*1000)/10;
  return {...model,liveState:s,corners:null,h:pct(p.homeWin),d:pct(p.draw),a:pct(p.awayWin),btts:pct(p.bttsYes),o05:pct(p.over05),o15:pct(p.over15),o25:pct(p.over25),u45:pct(p.under45),homeO05:pct(p.homeOver05),awayO05:pct(p.awayOver05),homeU45:pct(p.homeUnder45),awayU45:pct(p.awayUnder45),score:`${p.topScore.h}-${p.topScore.a}`,scoreP:pct(p.topScore.p),goalLambdaHome:lh,goalLambdaAway:la,liveScoreMatrix:m,dataSource:'SportyBet goal statistics + live score/time Poisson'};
}
module.exports={parseClock,liveState,ongoing,lateStage,winningSideSelection,conditionFootballModel};
