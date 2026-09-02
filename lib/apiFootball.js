// API-Football (API-Sports) integration used to expand Matchday's football coverage
// and to build an independent corner-total model from recent fixture statistics.
// Server-side only. Never expose API_FOOTBALL_KEY to the browser.

const BASE = 'https://v3.football.api-sports.io';

function apiKey() {
  return process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_API_KEY || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let lastCallAt = 0;

async function apiFetch(path, params = {}) {
  const key = apiKey();
  if (!key) {
    const e = new Error('Missing API_FOOTBALL_KEY environment variable');
    e.code = 'API_FOOTBALL_KEY_MISSING';
    throw e;
  }
  const minGap = Math.max(50, parseInt(process.env.API_FOOTBALL_MIN_INTERVAL_MS || '120', 10));
  const wait = lastCallAt + minGap - Date.now();
  if (wait > 0) await sleep(wait);
  const url = new URL(`${BASE}${path}`);
  Object.entries(params).forEach(([k,v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });
  if (String(process.env.API_FOOTBALL_LOG_CALLS || 'true').toLowerCase() !== 'false') {
    console.log(`[API-Football] GET ${path}${url.search}`);
  }
  const res = await fetch(url, { headers: { 'x-apisports-key': key, Accept: 'application/json' } });
  lastCallAt = Date.now();
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok || (json.errors && Object.keys(json.errors).length)) {
    const e = new Error(`API-Football ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    e.status = res.status;
    e.payload = json;
    throw e;
  }
  return json;
}

function normTeam(name) {
  return String(name || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, 'and')
    .replace(/\b(fc|cf|afc|sc|ssc|ac|club|football|futbol|calcio|fk|sk|sv|cd|ud|rc|real)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

function compact(name) { return normTeam(name).replace(/\s+/g, ''); }
function tokenSet(name) { return new Set(normTeam(name).split(/\s+/).filter(Boolean)); }
function jaccard(a,b) {
  const A=tokenSet(a), B=tokenSet(b); if(!A.size||!B.size) return 0;
  let hit=0; for(const x of A) if(B.has(x)) hit++;
  return hit/(A.size+B.size-hit);
}
function teamScore(a,b) {
  const x=compact(a), y=compact(b); if(!x||!y) return 0;
  if(x===y) return 1;
  if(Math.min(x.length,y.length)>=6 && (x.includes(y)||y.includes(x))) return 0.92;
  return jaccard(a,b);
}

function fixtureMatchScore(sporty, api) {
  const direct=(teamScore(sporty.home,api?.teams?.home?.name)+teamScore(sporty.away,api?.teams?.away?.name))/2;
  const reversed=(teamScore(sporty.home,api?.teams?.away?.name)+teamScore(sporty.away,api?.teams?.home?.name))/2;
  let score=Math.max(direct,reversed*0.75);
  const st=Date.parse(sporty.kickoffUtc||''), at=Number(api?.fixture?.timestamp)*1000;
  if(Number.isFinite(st)&&Number.isFinite(at)) {
    const mins=Math.abs(st-at)/60000;
    if(mins<=5) score+=0.12; else if(mins<=60) score+=0.07; else if(mins<=180) score+=0.02; else score-=0.12;
  }
  return Math.max(0,Math.min(1,score));
}

async function getFixturesByDate(date) {
  const j=await apiFetch('/fixtures',{date,timezone:'UTC'});
  return Array.isArray(j.response)?j.response:[];
}

async function getPrediction(fixtureId) {
  const j=await apiFetch('/predictions',{fixture:fixtureId});
  return Array.isArray(j.response)&&j.response.length?j.response[0]:null;
}

function pct(v) {
  const n=Number(String(v??'').replace('%','').trim());
  return Number.isFinite(n)?n:null;
}

function predictedGoalNumber(v) {
  const s=String(v??'').trim();
  if(!s) return null;
  const nums=s.match(/\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite)||[];
  if(!nums.length) return null;
  // API values are commonly a point estimate or a range. Use the range midpoint.
  return nums.reduce((a,b)=>a+b,0)/nums.length;
}

function poissonPmf(k,lambda) {
  let fact=1; for(let i=2;i<=k;i++) fact*=i;
  return Math.exp(-lambda)*Math.pow(lambda,k)/fact;
}
function scoreMatrix(lh,la,max=9) {
  const m=[]; for(let h=0;h<=max;h++){const row=[];for(let a=0;a<=max;a++)row.push(poissonPmf(h,lh)*poissonPmf(a,la));m.push(row);}return m;
}
function modelFromApiPrediction(apiFixture, pred) {
  const p=pred?.predictions||{};
  const h=pct(p?.percent?.home), d=pct(p?.percent?.draw), a=pct(p?.percent?.away);
  let lh=predictedGoalNumber(p?.goals?.home), la=predictedGoalNumber(p?.goals?.away);
  if(!(lh>0)||!(la>0)) return null; // do not fabricate scoring rates when API omits them
  lh=Math.min(5,Math.max(0.15,lh)); la=Math.min(5,Math.max(0.15,la));
  const matrix=scoreMatrix(lh,la);
  let btts=0,o15=0,u45=0,o25=0,oneUpHome=0,oneUpAway=0,mass=0,top={h:0,a:0,p:0};
  for(let hg=0;hg<matrix.length;hg++)for(let ag=0;ag<matrix[hg].length;ag++){
    const pr=matrix[hg][ag]; mass+=pr; if(pr>top.p)top={h:hg,a:ag,p:pr};
    if(hg>0&&ag>0)btts+=pr; if(hg+ag>1)o15+=pr; if(hg+ag>2)o25+=pr; if(hg+ag<5)u45+=pr;
    oneUpHome+=pr*(hg>ag?1:hg/(ag+1)); oneUpAway+=pr*(ag>hg?1:ag/(hg+1));
  }
  if(mass>0){btts/=mass;o15/=mass;o25/=mass;u45/=mass;oneUpHome/=mass;oneUpAway/=mass;}
  let hh=h,dd=d,aa=a;
  if(![hh,dd,aa].every(Number.isFinite)) {
    let wh=0,wd=0,wa=0; for(let hg=0;hg<matrix.length;hg++)for(let ag=0;ag<matrix[hg].length;ag++){const pr=matrix[hg][ag]; if(hg>ag)wh+=pr;else if(hg===ag)wd+=pr;else wa+=pr;}
    hh=wh/mass*100;dd=wd/mass*100;aa=wa/mass*100;
  }
  const total=hh+dd+aa||100; hh=hh/total*100;dd=dd/total*100;aa=aa/total*100;
  return {
    league: apiFixture?.league?.name||'', leagueCode:`api:${apiFixture?.league?.id||''}`,
    home: apiFixture?.teams?.home?.name||'', away: apiFixture?.teams?.away?.name||'',
    kickoffUtc: apiFixture?.fixture?.date||null, apiFootballFixtureId:apiFixture?.fixture?.id||null,
    apiFootballHomeTeamId:apiFixture?.teams?.home?.id||null, apiFootballAwayTeamId:apiFixture?.teams?.away?.id||null,
    h:Math.round(hh), d:Math.round(dd), a:Math.round(aa), btts:Math.round(btts*100), o15:Math.round(o15*100),
    u45:Math.round(u45*100), o25:Math.round(o25*100), oneUpHome:Math.round(oneUpHome*100), oneUpAway:Math.round(oneUpAway*100),
    score:`${top.h}-${top.a}`, scoreP:Math.round(top.p/mass*100), pick:['Home Win','Draw','Away Win'][[hh,dd,aa].indexOf(Math.max(hh,dd,aa))],
    pickProb:Math.round(Math.max(hh,dd,aa)), dataSource:'API-Football', apiFootballAdvice:p?.advice||'',
    apiFootballGoalLambdaHome:Math.round(lh*100)/100, apiFootballGoalLambdaAway:Math.round(la*100)/100,
  };
}

function extractCornersFromFixture(fx, teamId) {
  const stats=Array.isArray(fx?.statistics)?fx.statistics:[];
  if(stats.length<2) return null;
  const sideHome=Number(fx?.teams?.home?.id)===Number(teamId);
  let hs=stats.find(s=>Number(s?.team?.id)===Number(fx?.teams?.home?.id));
  let as=stats.find(s=>Number(s?.team?.id)===Number(fx?.teams?.away?.id));
  const val=s=>{const x=s?.statistics?.find(z=>String(z?.type||'').toLowerCase()==='corner kicks')?.value;const n=Number(x);return Number.isFinite(n)?n:null;};
  const hc=val(hs), ac=val(as); if(!Number.isFinite(hc)||!Number.isFinite(ac)) return null;
  return {for:sideHome?hc:ac, against:sideHome?ac:hc, total:hc+ac};
}

async function getRecentCornerProfile(teamId, last=8) {
  const n=Math.max(3,Math.min(15,parseInt(last,10)||8));
  // Do not send "FT-AET-PEN" as one status value. API-Football expects valid fixture
  // statuses, and combining them this way can yield zero fixtures. Pull recent matches,
  // then keep completed fixtures locally.
  const list=await apiFetch('/fixtures',{team:teamId,last:Math.min(30,n*2)});
  const allFixtures=Array.isArray(list.response)?list.response:[];
  const finished=new Set(['FT','AET','PEN']);
  const fixtures=allFixtures.filter(x=>finished.has(String(x?.fixture?.status?.short||''))).slice(0,n);
  if(!fixtures.length){
    console.warn(`[API-Football] corner profile team ${teamId}: no completed recent fixtures`);
    return null;
  }
  const ids=fixtures.map(x=>x?.fixture?.id).filter(Boolean).slice(0,20);
  let detailed=[];
  if(ids.length){
    try {
      const batch=await apiFetch('/fixtures',{ids:ids.join('-')});
      detailed=Array.isArray(batch.response)?batch.response:[];
    } catch(e) {
      console.warn(`[API-Football] batch fixture details team ${teamId}: ${e.message}`);
    }
  }
  const byId=new Map(detailed.map(x=>[String(x?.fixture?.id),x]));
  const samples=[];
  const fallbackLimit=Math.max(0,Math.min(10,parseInt(process.env.API_FOOTBALL_CORNER_STAT_FALLBACK_CALLS||'10',10)));
  let fallbacks=0;
  for(const fx0 of fixtures){
    let fx=byId.get(String(fx0?.fixture?.id))||fx0;
    let s=extractCornersFromFixture(fx,teamId);
    if(!s&&fallbacks<fallbackLimit){
      try{
        const st=await apiFetch('/fixtures/statistics',{fixture:fx0?.fixture?.id});
        const stats=Array.isArray(st.response)?st.response:[];
        fx={...fx0,statistics:stats}; s=extractCornersFromFixture(fx,teamId); fallbacks++;
      }catch(e){
        console.warn(`[API-Football] fixture statistics ${fx0?.fixture?.id}: ${e.message}`);
      }
    }
    if(s)samples.push(s);
    else console.warn(`[API-Football] no Corner Kicks statistic for fixture ${fx0?.fixture?.id} team ${teamId}`);
  }
  const minSamples=Math.max(1,Math.min(5,parseInt(process.env.API_FOOTBALL_CORNER_MIN_SAMPLES||'2',10)));
  if(samples.length<minSamples){
    console.warn(`[API-Football] corner profile team ${teamId}: ${samples.length} usable corner-stat samples; need ${minSamples}`);
    return null;
  }
  console.log(`[API-Football] corner profile team ${teamId}: ${samples.length} usable samples`);
  const avg=k=>samples.reduce((a,x)=>a+x[k],0)/samples.length;
  return {teamId:Number(teamId),samples:samples.length,cornersFor:avg('for'),cornersAgainst:avg('against'),totalCorners:avg('total')};
}

function cornerModel(homeProfile,awayProfile) {
  if(!homeProfile||!awayProfile)return null;
  const homeLambda=(homeProfile.cornersFor+awayProfile.cornersAgainst)/2;
  const awayLambda=(awayProfile.cornersFor+homeProfile.cornersAgainst)/2;
  const totalLambda=Math.max(2,Math.min(18,homeLambda+awayLambda));
  const firstHalfShare=Math.max(0.25,Math.min(0.65,Number(process.env.API_FOOTBALL_1H_CORNER_SHARE || 0.46)));
  return {homeLambda:Math.round(homeLambda*100)/100,awayLambda:Math.round(awayLambda*100)/100,totalLambda:Math.round(totalLambda*100)/100,
    firstHalfHomeLambda:Math.round(homeLambda*firstHalfShare*100)/100,
    firstHalfAwayLambda:Math.round(awayLambda*firstHalfShare*100)/100,
    firstHalfShare:Math.round(firstHalfShare*1000)/1000,
    samplesHome:homeProfile.samples,samplesAway:awayProfile.samples};
}

function totalCornerProbability(lambda,line,isOver=true) {
  const l=Number(line); if(!(lambda>0)||!Number.isFinite(l))return null;
  // Standard .5 lines: Over x.5 means at least ceil(x.5) corners.
  const threshold=Math.floor(l)+1;
  let underEq=0; for(let k=0;k<threshold;k++)underEq+=poissonPmf(k,lambda);
  const over=Math.max(0,Math.min(1,1-underEq));
  return (isOver?over:1-over)*100;
}

async function enrichSportyFixtures(sportyEvents,{daysAhead=7,maxFixtures=180,cornerEventIds=new Set()}={}) {
  const events=[]; const seen=new Set();
  for(const r of sportyEvents||[]){const k=String(r.eventId||'');if(!k||seen.has(k))continue;seen.add(k);events.push(r);}
  if(!events.length)return [];
  const byDate=new Map();
  for(const e of events){const d=new Date(e.kickoffUtc||'');if(Number.isNaN(d.getTime()))continue;const ds=d.toISOString().slice(0,10);if(!byDate.has(ds))byDate.set(ds,[]);byDate.get(ds).push(e);}
  const dateEntries=[...byDate.entries()].slice(0,Math.max(1,daysAhead+1));
  const matched=[];
  for(const [date,sRows] of dateEntries){
    let af=[]; try{af=await getFixturesByDate(date);}catch(e){console.warn(`API-Football fixtures ${date}: ${e.message}`);continue;}
    for(const s of sRows){
      let best=null,bestScore=0; for(const a of af){const sc=fixtureMatchScore(s,a);if(sc>bestScore){bestScore=sc;best=a;}}
      if(best&&bestScore>=0.78)matched.push({sporty:s,api:best,matchConfidence:bestScore});
    }
  }
  console.log(`[API-Football] fixture matching: sporty=${events.length}, matched=${matched.length}`);
  matched.sort((a,b)=>b.matchConfidence-a.matchConfidence);
  const limited=matched.slice(0,Math.max(1,maxFixtures));
  const teamCornerCache=new Map();
  const out=[];
  for(const m of limited){
    let pred=null; try{pred=await getPrediction(m.api.fixture.id);}catch(e){console.warn(`API-Football prediction ${m.api.fixture.id}: ${e.message}`);}

    // IMPORTANT: Corner modelling must not depend on API-Football /predictions.
    // Some leagues/fixtures have statistics coverage but no prediction response.
    // Build a minimal match row from the matched fixture so corner profiles can still be attached.
    let row=pred?modelFromApiPrediction(m.api,pred):null;
    if(!row){
      row={
        home:m.api?.teams?.home?.name || m.sporty.home,
        away:m.api?.teams?.away?.name || m.sporty.away,
        league:m.api?.league?.name || m.sporty.tournament || '',
        kickoffUtc:m.api?.fixture?.date || m.sporty.kickoffUtc || null,
        h:0,d:0,a:0,btts:0,over15:0,under45:0,oneUpHome:0,oneUpAway:0,
        source:'API-Football fixture/statistics',
      };
    }

    // Preserve exact SportyBet identifiers/names for reliable market matching.
    row.eventId=String(m.sporty.eventId||'');
    row.sportyEventId=String(m.sporty.eventId||'');
    row.home=m.sporty.home;
    row.away=m.sporty.away;
    row.league=m.sporty.tournament||row.league;
    row.kickoffUtc=m.sporty.kickoffUtc||row.kickoffUtc;
    row.apiFootballFixtureId=m.api?.fixture?.id || null;
    row.apiFootballMatchConfidence=Math.round(m.matchConfidence*100);
    const buildAllCorners = String(process.env.API_FOOTBALL_BUILD_ALL_CORNER_PROFILES || 'true').toLowerCase() !== 'false';
    if(buildAllCorners || cornerEventIds.has(String(m.sporty.eventId))){
      const hid=m.api?.teams?.home?.id, aid=m.api?.teams?.away?.id;
      const getCached=async id=>{const k=String(id);if(teamCornerCache.has(k))return teamCornerCache.get(k);let p=null;try{p=await getRecentCornerProfile(id,parseInt(process.env.API_FOOTBALL_CORNER_LAST_MATCHES||'8',10));}catch(e){console.warn(`Corner profile team ${id}: ${e.message}`);}teamCornerCache.set(k,p);return p;};
      if(hid&&aid){const hp=await getCached(hid),ap=await getCached(aid);const cm=cornerModel(hp,ap);if(cm)row.corners=cm;}
    }
    out.push(row);
  }
  return out;
}

module.exports={apiFetch,getFixturesByDate,getPrediction,getRecentCornerProfile,cornerModel,totalCornerProbability,enrichSportyFixtures,fixtureMatchScore,normTeam};
