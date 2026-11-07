'use strict';
const names=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function stripTeam(value,c){const m=String(value).match(/^(.*?)\s*\(([^()]*)\)\s*$/);return m&&[c.home,c.away].some(team=>require('./apiSportsH2hData').sameTeam(m[2],team,'football'))?m[1].trim():String(value);}
function playerName(c){
 if(c.playerName)return stripTeam(String(c.playerName),c);
 const market=String(c.marketDesc||'').replace(/[–—]/g,'-'),outcome=String(c.outcomeDesc||'').trim();
 if(/^player not to score$/i.test(market)&&! /^(?:yes|no|none|other|any other|no goalscorer|under|over)(?:\b|$)/i.test(outcome))return stripTeam(outcome,c);
 const reversed=market.match(/^(?:player )?(?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer)\s+-\s+(.+)$/i);if(reversed)return reversed[1];
 const named=market.match(/^(.+?)\s+-\s+(?:player )?(?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer|(?:total )?goals(?: over\s*\/\s*under)?)$/i);
 if(named&&!['home','away',names(c.home),names(c.away)].includes(names(named[1])))return named[1];
 return null;
}
function role(p){const pos=String(p.position||p.pos||p.positionCode||'').toUpperCase();return /^(CB|DC|CENTRE.?BACK|CENTER.?BACK|CENTRAL DEFENDER)$/.test(pos)?0:/^(D|DF|DEF|DEFENDER|LB|RB|LWB|RWB|RIGHT BACK|LEFT BACK)$/.test(pos)?1:/^(M|MF|MID|MIDFIELDER|CM|DM|CDM|CAM|AM|LM|RM|CENTRAL MIDFIELDER|DEFENSIVE MIDFIELDER|RIGHT WINGER|LEFT WINGER)$/.test(pos)?2:3;}
function samePlayer(a,b){const display=require('./sportyLineups').displayName;const x=names(display(a)),y=names(display(b));if(!x||!y)return false;if(x===y)return true;const aa=x.split(' '),bb=y.split(' ');return aa.length>=2&&aa.length===bb.length&&aa.slice(1).join(' ')===bb.slice(1).join(' ')&&(aa[0].length===1||bb[0].length===1)&&aa[0][0]===bb[0][0];}
async function enrich(candidates,{loadLineup,minProbability=0,minEdge=0,diagnostics={},maxFixtures=64,budgetMs=20000}){
 const groups=new Map(),out=[],began=Date.now();
 Object.assign(diagnostics,{offered:candidates.length,fixtures:0,confirmedStarters:0,unmatchedPlayers:0,lineupUnavailable:0,fixturesUnavailable:0,failures:{},mappingSamples:[]});
 for(const c of candidates){const id=String(c.eventId);if(!groups.has(id))groups.set(id,[]);groups.get(id).push(c);}
 const queue=[...groups.values()].sort((a,b)=>(Date.parse(a[0].kickoffUtc)||Infinity)-(Date.parse(b[0].kickoffUtc)||Infinity));
 let blocked=null;
 for(const group of queue){const c=group[0],id=String(c.eventId);
  if(blocked||diagnostics.fixtures>=maxFixtures||Date.now()-began>=budgetMs){diagnostics.scanLimited=(diagnostics.scanLimited||0)+group.length;continue;}
  diagnostics.fixtures++;let starters=[];
  try{starters=await loadLineup(c)||[];}catch(error){const code=String(error.code||error.message||'LINEUP_UNAVAILABLE').slice(0,100);diagnostics.failures[id]=code;if(error.mappingDiagnostics&&diagnostics.mappingSamples.length<3)diagnostics.mappingSamples.push(error.mappingDiagnostics);if(['API_DAILY_BUDGET','API_DAILY_QUOTA','API_QUOTA_UNAVAILABLE','API_MINUTE_BUDGET','API_RATE_LIMIT','LINEUP_API_KEY_MISSING','SPORTYBET_LINEUP_CACHE_UNAVAILABLE'].includes(code)){blocked=code;diagnostics.blockedReason=code;}}
  if(!starters.length){diagnostics.lineupUnavailable+=group.length;diagnostics.fixturesUnavailable++;continue;}
  for(const row of group){const name=playerName(row),matches=name?starters.filter(p=>samePlayer(name,p.name)):[];
   if(matches.length!==1){diagnostics.unmatchedPlayers++;continue;}
   const p=matches[0];if(Number(row.probability)<minProbability||Number(row.edge)<minEdge)continue;
   const usual=p.basis==='usual';diagnostics.matchedPlayers=(diagnostics.matchedPlayers||0)+1;if(!usual)diagnostics.confirmedStarters++;out.push({...row,playerName:p.name,playerPosition:p.position||null,lineupVerified:true,lineupProvider:p.provider||'api_sports',lineupBasis:usual?'usual':'confirmed',startingLineupConfirmed:!usual,playerPositionRank:role(p),lineupNote:(usual?'SportyBet usual lineup · starting place unconfirmed':'Confirmed starter')+' · '+(p.position||'position unavailable')});
  }
 }
 diagnostics.confirmedFixtureCount=new Set(out.map(c=>String(c.eventId))).size;
 return out.sort((a,b)=>a.playerPositionRank-b.playerPositionRank||b.probability-a.probability);
}

async function lineupLoader(options={}){if(options.env?.SPORTYBET_PLAYER_LINEUP_SOURCE==='api'||!options.env&&process.env.SPORTYBET_PLAYER_LINEUP_SOURCE==='api')return apiLineupLoader(options);return c=>require('./sportyLineups').readOrQueue(options.redis,c);}
async function apiLineupLoader({redis,signal,env=process.env}={}){
 const api=require('./apiSportsH2h').createApiH2h({redis,env}),{matchFixture,mappingDiagnostics}=require('./apiSportsH2hData');
 const dates=new Map();
 return async c=>{
  if(!env.APISPORTS_KEY)throw Object.assign(Error('API key is required to verify starting lineups'),{code:'LINEUP_API_KEY_MISSING'});
  const date=new Date(c.kickoffUtc).toISOString().slice(0,10);if(!dates.has(date))dates.set(date,api.request('football','/fixtures',{date,timezone:'UTC'},{signal,ttl:600}));const fixtures=await dates.get(date);
  let fixture=matchFixture(fixtures.response,c);
  if(!fixture&&redis){try{const cached=JSON.parse(await redis.get(require('./h2hCache').PREFIX+'e:'+c.eventId)||'null');if(cached?.provider==='api_sports'&&cached.home===c.home&&cached.away===c.away&&cached.providerFixtureId&&cached.providerTeamIds){fixture=fixtures.response.find(f=>String(f.fixture?.id)===String(cached.providerFixtureId)&&f.teams?.home?.id===cached.providerTeamIds.home&&f.teams?.away?.id===cached.providerTeamIds.away&&Math.abs(Date.parse(f.fixture.date)-Date.parse(c.kickoffUtc))<=90*60000);}}catch{}}
  if(!fixture){const detail=mappingDiagnostics(fixtures.response,c);console.warn('[Player lineup mapping] '+JSON.stringify(detail));throw Object.assign(Error('Fixture could not be matched'),{code:'LINEUP_FIXTURE_UNMAPPED',mappingDiagnostics:detail});}
  const result=await api.request('football','/fixtures/lineups',{fixture:fixture.fixture.id},{signal,ttl:120});
  const teams=[fixture.teams.home.id,fixture.teams.away.id],rows=result.response.filter(t=>teams.includes(t.team?.id));
  return rows.flatMap(t=>(t.startXI||[]).map(x=>({name:x.player?.name,position:x.player?.pos,teamId:t.team.id}))).filter(x=>x.name);
 };
}
function singlePriceCandidates(rows,known=[]){
 const M=require('./footballExtraMarkets'),metrics=require('./autoPicker').normalMetrics,keys=new Set(known.map(c=>JSON.stringify([c.eventId,c.marketId,c.outcomeId,c.specifier]))),out=[];
 for(const c of rows){if(c.live||M.scorerSide(c)!=='no'||!playerName(c)||!(Number(c.odds)>1)||c.suspended||c.active===false)continue;
  const key=JSON.stringify([c.eventId,c.marketId,c.outcomeId,c.specifier]);if(keys.has(key))continue;keys.add(key);
  const m=metrics(c.odds,100/Number(c.odds));out.push({...c,...m,betType:'player_not_to_score',playerName:playerName(c),marketKind:'offered',probabilitySource:'SportyBet single-price implied estimate (includes bookmaker margin)',modelBasis:'single_offered_price',independentModel:false,qualityScore:m.probability,qualityScoreBasis:'unvalidated_odds_estimate',edgeType:'unconfirmed',edge:0,expectedValuePct:0});
 }return out;
}
module.exports={playerName,role,samePlayer,enrich,lineupLoader,apiLineupLoader,singlePriceCandidates};
