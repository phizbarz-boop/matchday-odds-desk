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
function scorePair(value) {
  const match=typeof value==='string'?value.match(/^\s*(\d+)\s*[:-]\s*(\d+)\s*$/):null;
  const home=numeric(value?.home ?? value?.homeScore ?? match?.[1]);
  const away=numeric(value?.away ?? value?.awayScore ?? match?.[2]);
  return home!=null&&away!=null?{home,away}:null;
}
function scoreSeries(value) {
  if(typeof value==='string'){try{value=JSON.parse(value);}catch{return [];}}
  if(!Array.isArray(value))return [];
  const scores=value.map(scorePair);
  return scores.every(Boolean)?scores:[];
}
function offeredSetFormat(e) {
  const sport=String(e.sport?.id ?? e.sport ?? '');
  if(!/tennis|volleyball|^sr:sport:(5|23)$/i.test(sport))return null;
  for(const market of Array.isArray(e.markets)?e.markets:[]) {
    if(!/^(?:correct score|exact match score|match score)$/i.test(String(market.desc ?? market.name ?? market.description ?? '').trim()))continue;
    const scores=(Array.isArray(market.outcomes)?market.outcomes:[]).map(o=>scorePair(o.desc ?? o.name ?? o.description));
    if(scores.length<2||scores.some(s=>!s))continue;
    const wins=Math.max(...scores.map(s=>Math.max(s.home,s.away)));
    if([2,3].includes(wins)&&scores.some(s=>s.home===wins)&&scores.some(s=>s.away===wins)&&scores.every(s=>s.home!==s.away&&Math.max(s.home,s.away)===wins))return wins*2-1;
  }
  return null;
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
  const games=scoreSeries(e.gameScore),points=scoreSeries(e.pointScore),sets=scorePair(e.setScore);
  const corners=scorePair(e.cornerScore ?? e.cornersScore ?? e.statistics?.corners);
  const bestOf=numeric(e.bestOf ?? e.bestOfSets ?? e.maxSets) || Number(String(e.matchFormat ?? e.format ?? '').match(/best\s*(?:of|[- ])\s*([35])/i)?.[1]) || offeredSetFormat(e);
  const completeGames=!!sets&&games.length>=sets.home+sets.away+1;
  const completePoints=!!sets&&points.length>=sets.home+sets.away+1;
  const currentSet=Number(phase.match(/set\s*([1-5])|([1-5])(?:st|nd|rd|th)?\s+set/i)?.slice(1).find(Boolean)) || null;
  return {phase,homeScore:home,awayScore:away,minute,clock,
    bestOf:[3,5].includes(bestOf)?bestOf:null,
    homeSets:sets?.home ?? null,awaySets:sets?.away ?? null,currentSet,
    homeGames:completeGames?games.reduce((n,s)=>n+s.home,0):null,
    awayGames:completeGames?games.reduce((n,s)=>n+s.away,0):null,
    currentHomeGames:completeGames?games.at(-1).home:null,currentAwayGames:completeGames?games.at(-1).away:null,
    homePoints:completePoints?points.reduce((n,s)=>n+s.home,0):null,
    awayPoints:completePoints?points.reduce((n,s)=>n+s.away,0):null,
    homeCorners:numeric(e.homeCorners ?? corners?.home),awayCorners:numeric(e.awayCorners ?? corners?.away)};
}
function ongoing(e={}) {
  const s=liveState(e),status=s.phase.toLowerCase();
  if(e.banned===true || /not start(?:ed)?|scheduled|upcoming|prematch|pre[- ]?match|postponed|cancelled|canceled|abandoned|interrupted|ended|finished|full[- ]?time|\bft\b|closed|resulted|after extra|\baet\b|after penalties/.test(status))return false;
  for(const k of ['live','inPlay','in_play','isLive','liveBetting','inplay'])if(e[k]!=null && e[k]!=='')return /^(1|true|yes|live)$/i.test(String(e[k]));
  if(/live|in[- ]?play|running|ongoing|[12](?:st|nd)? half|first half|second half|halftime|half[- ]time|extra time|overtime|quarter|period|inning|timeout|break|set\s*\d|\d+(?:st|nd|rd|th)\s+set/.test(status))return true;
  // Do not promote a passed kickoff or a numeric availability status to live.
  return s.minute!=null && s.homeScore!=null && s.awayScore!=null && s.minute>0 && s.minute<=130;
}
function halfwayPlayed(row) {
  if(!ongoing(row))return false;
  const s=liveState(row),sport=String(row.sport||'').toLowerCase(),p=s.phase.toLowerCase();
  const half=/half[- ]?time|halftime|2nd half|second half|2 half/.test(p);
  if(sport.includes('football')||sport==='soccer')return half || (s.minute!=null&&s.minute>=45);
  if(sport.includes('basket'))return /(?:3rd|third|3|4th|fourth|4)\s*quarter|quarter\s*[34]|\bq[34]\b|half[- ]?time|halftime|overtime/.test(p);
  if(sport.includes('hockey'))return /(?:3rd|third|3)\s*period|period\s*3|\bp3\b|overtime/.test(p) || (s.minute!=null&&s.minute>=30);
  if(sport.includes('handball'))return half || (s.minute!=null&&s.minute>=30);
  if(sport.includes('tennis')||sport.includes('volleyball')) {
    const home=s.homeSets ?? s.homeScore,away=s.awaySets ?? s.awayScore,format=s.bestOf||5;
    if(home==null||away==null||home<0||away<0||home>=Math.ceil(format/2)||away>=Math.ceil(format/2))return false;
    const completed=home+away;
    // Set sports have no fixed match duration. Require at least half of the
    // offered match format to be completed; unknown formats use the longer
    // best-of-five boundary rather than guessing from a set number.
    return completed>=Math.ceil(format/2);
  }
  return false;
}
function lateStage(row) {
  const s=liveState(row), sport=String(row.sport||'').toLowerCase(), p=s.phase.toLowerCase();
  if(!halfwayPlayed(row))return false;
  if(sport.includes('football') || sport==='soccer')return s.minute!=null && s.minute>=75 && s.minute<=110 && !/extra|penalt/.test(p);
  if(sport.includes('basket'))return /(?:4th|fourth|4)\s*quarter|quarter\s*4|\bq4\b|overtime/.test(p);
  if(sport.includes('hockey'))return /(?:3rd|third|3)\s*period|period\s*3|\bp3\b|overtime/.test(p);
  if(sport.includes('handball'))return s.minute!=null && s.minute>=50 && /2nd half|second half|2 half/.test(p);
  if(sport.includes('tennis')||sport.includes('volleyball')) {
    const home=s.homeSets ?? s.homeScore,away=s.awaySets ?? s.awayScore;
    // A tied final set is provable from 2:2 even without a format field.
    return home!=null&&away!=null&&home+away===(s.bestOf||5)-1;
  }
  return false;
}
function selectionSide(row) {
  const d=String(row.outcomeDesc||'').trim().toLowerCase();
  if(/^(draw|tie|x)$/.test(d))return 'draw';
  for(const [side,name] of [['home',row.home],['away',row.away]]) {
    const team=String(name||'').trim().toLowerCase();
    if(new RegExp(`^${side}(?:\\b|$)`).test(d)||team&&(d===team||d.startsWith(team+' (')||d.startsWith(team+' +')||d.startsWith(team+' -')))return side;
  }
  const id=String(row.outcomeId||'');
  if(String(row.marketId)==='1'&&id==='2')return 'draw';
  if(['1','4'].includes(id))return 'home';
  if(['3','5'].includes(id))return 'away';
  return null;
}
function selectionWinningNow(row) {
  const s=liveState(row),t=String(row.betType||''),market=String(row.marketDesc||''),d=String(row.outcomeDesc||'').toLowerCase();
  // Scores for a full match cannot evaluate a period/quarter/half selection.
  if(/(?:1st|2nd|3rd|4th|first|second|third|fourth)\s*(?:half|quarter|period|set)|\b(?:race|first goal|last goal)\b|&/i.test(market))return false;
  let home=s.homeScore,away=s.awayScore;
  if(/corners/i.test(market)||t.startsWith('corners_')){home=s.homeCorners;away=s.awayCorners;}
  else if(/tennis/i.test(row.sport||'')&&/total games|game handicap/i.test(market)){home=s.homeGames;away=s.awayGames;}
  else if(/volleyball/i.test(row.sport||'')&&!/total sets|set handicap|winner/i.test(market)) {
    home=s.homePoints ?? s.homeGames;away=s.awayPoints ?? s.awayGames;
  }
  else if(/tennis|volleyball/i.test(row.sport||'')&&/winner|total sets|set handicap/i.test(market)) {
    home=s.homeSets ?? home;away=s.awaySets ?? away;
  }
  if(home==null||away==null||!Number.isFinite(home)||!Number.isFinite(away))return false;
  if(t==='gg_yes'||t==='ng_no'||/both teams.*score/i.test(market)) {
    if(/^(yes|gg)$/.test(d))return home>0&&away>0;
    if(/^(no|ng)$/.test(d))return home===0||away===0;
    return false;
  }
  if(t==='correct_score'||/correct score/i.test(market)){const pair=scorePair(row.outcomeDesc);return !!pair&&home===pair.home&&away===pair.away;}
  if(/\b(?:over|under|total)\b/i.test(market)||/(?:^|_)over|(?:^|_)under/.test(t)) {
    const line=numeric(String(row.specifier||'').match(/total\s*=\s*([+-]?\d+(?:\.\d+)?)/i)?.[1] ?? d.match(/(?:over|under)\s*([+-]?\d+(?:\.\d+)?)/i)?.[1]);
    if(line==null)return false;
    let value=/^home\b/i.test(market)?home:/^away\b/i.test(market)?away:/^home_/.test(t)?home:/^away_/.test(t)?away:home+away;
    if(/total sets/i.test(market))value=Math.max(value,s.currentSet||0,s.currentHomeGames!=null?home+away+1:0);
    const over=/\bover\b/.test(d),under=/\bunder\b/.test(d);
    return over?value>line:under?value<line:false;
  }
  if(t==='dc_1x'||t==='dc_x2'||/double chance/i.test(market)) {
    if(/1x|home or draw|home\/draw/.test(d))return home>=away;
    if(/x2|draw or away|draw\/away/.test(d))return away>=home;
    return false;
  }
  if(/handicap/i.test(market)||/^ah_/.test(t)) {
    const line=numeric(String(row.specifier||'').match(/hcp\s*=\s*([+-]?\d+(?:\.\d+)?)/i)?.[1]);
    const side=selectionSide(row);
    if(line==null||!['home','away'].includes(side))return false;
    return side==='home'?home-away+line>0:away-home-line>0;
  }
  if(/winner|1x2|draw no bet/i.test(market)||['home_win','away_win','draw','dnb'].includes(t)) {
    const side=selectionSide(row);
    if(side==='draw')return !/draw no bet/i.test(market)&&home===away;
    // When sets are tied, a current game/point lead identifies the side ahead.
    if(home===away&&/tennis|volleyball/i.test(row.sport||'')) {
      home=s.currentHomeGames;away=s.currentAwayGames;
      if(home==null||away==null)return false;
    }
    return side==='home'?home>away:side==='away'?away>home:false;
  }
  return false;
}
function liveSelectionEligible(row,{quickCash=false}={}) {
  return halfwayPlayed(row)&&selectionWinningNow(row)&&(!quickCash||lateStage(row));
}
function winningSideSelection(row){return liveSelectionEligible(row,{quickCash:true});}
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
module.exports={parseClock,scorePair,scoreSeries,selectionSide,liveState,ongoing,halfwayPlayed,lateStage,selectionWinningNow,liveSelectionEligible,winningSideSelection,conditionFootballModel};
