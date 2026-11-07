'use strict';
const names=s=>String(s||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
function playerName(c){
 if(c.playerName)return String(c.playerName);
 const market=String(c.marketDesc||'').replace(/[–—]/g,'-'),outcome=String(c.outcomeDesc||'').trim();
 if(/^player not to score$/i.test(market)&&! /^(?:yes|no|none|other|any other|no goalscorer|under|over)(?:\b|$)/i.test(outcome))return outcome;
 const reversed=market.match(/^(?:player )?(?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer)\s+-\s+(.+)$/i);if(reversed)return reversed[1];
 const named=market.match(/^(.+?)\s+-\s+(?:player )?(?:not to score|to score(?: anytime)?|(?:anytime )?goalscorer|(?:total )?goals(?: over\s*\/\s*under)?)$/i);
 if(named&&!['home','away',names(c.home),names(c.away)].includes(names(named[1])))return named[1];
 return null;
}
function role(p){const pos=String(p.position||p.pos||'').toUpperCase();return /^(CB|DC|CENTRE.?BACK|CENTER.?BACK)$/.test(pos)?0:/^(D|DF|DEF|DEFENDER|LB|RB|LWB|RWB)$/.test(pos)?1:/^(M|MF|MID|MIDFIELDER|CM|DM|CDM|CAM|AM|LM|RM)$/.test(pos)?2:3;}
function samePlayer(a,b){const x=names(a),y=names(b);if(!x||!y)return false;if(x===y)return true;const aa=x.split(' '),bb=y.split(' ');return aa.length===2&&bb.length===2&&aa[1]===bb[1]&&(aa[0].length===1||bb[0].length===1)&&aa[0][0]===bb[0][0];}
async function enrich(candidates,{loadLineup,minProbability=0,minEdge=0,diagnostics={},maxFixtures=12,budgetMs=20000}){
 const memo=new Map(),out=[],began=Date.now();Object.assign(diagnostics,{offered:candidates.length,fixtures:0,confirmedStarters:0,unmatchedPlayers:0,lineupUnavailable:0,failures:{}});
 for(const c of candidates){const id=String(c.eventId);if(!memo.has(id)){if(memo.size>=maxFixtures||Date.now()-began>=budgetMs){diagnostics.scanLimited=(diagnostics.scanLimited||0)+1;continue;}diagnostics.fixtures++;try{memo.set(id,await loadLineup(c));}catch(error){diagnostics.failures[id]=String(error.code||error.message||'LINEUP_UNAVAILABLE').slice(0,100);memo.set(id,[]);}}
  const starters=memo.get(id)||[];if(!starters.length){diagnostics.lineupUnavailable++;continue;}
  const name=playerName(c),matches=name?starters.filter(p=>samePlayer(name,p.name)):[];
  if(matches.length!==1){diagnostics.unmatchedPlayers++;continue;}
  const p=matches[0];if(Number(c.probability)<minProbability||Number(c.edge)<minEdge)continue;
  diagnostics.confirmedStarters++;out.push({...c,playerName:p.name,playerPosition:p.position||null,lineupVerified:true,lineupProvider:'api_sports',playerPositionRank:role(p),lineupNote:'Confirmed starter · '+(p.position||'position unavailable')});
 }
 return out.sort((a,b)=>a.playerPositionRank-b.playerPositionRank||b.probability-a.probability);
}
async function lineupLoader({redis,signal,env=process.env}={}){
 const api=require('./apiSportsH2h').createApiH2h({redis,env}),{matchFixture}=require('./apiSportsH2hData');
 const dates=new Map();
 return async c=>{
  if(!env.APISPORTS_KEY)throw Object.assign(Error('API key is required to verify starting lineups'),{code:'LINEUP_API_KEY_MISSING'});
  const date=new Date(c.kickoffUtc).toISOString().slice(0,10);if(!dates.has(date))dates.set(date,api.request('football','/fixtures',{date,timezone:'UTC'},{signal,ttl:600}));const fixtures=await dates.get(date);
  const fixture=matchFixture(fixtures.response,c);if(!fixture)throw Object.assign(Error('Fixture could not be matched'),{code:'LINEUP_FIXTURE_UNMAPPED'});
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
module.exports={playerName,role,samePlayer,enrich,lineupLoader,singlePriceCandidates};
