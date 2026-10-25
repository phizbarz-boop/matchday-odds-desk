'use strict';
const {withPublicSportyRequest}=require('./sportyRequest');
const {normalizedSport}=require('./telegramMixedSelector');
function excludeH2hFailures(candidates){
 candidates.h2hFailures=Object.fromEntries(candidates.filter(c=>c.h2hCheck?.allowed===false).map(c=>[c.eventId,c.h2hCheck.status]));
 const blocked=candidates.filter(c=>c.h2hCheck?.allowed===false);for(const c of blocked)candidates.splice(candidates.indexOf(c),1);return candidates;
}
async function loadAnalyzerCandidates(fixtures,{hours=336,signal,scan=require('./expandedMarketScan').scanExpandedMarkets,model=require('./sportyPublicCache').publicCandidates}={}){
 return withPublicSportyRequest(async()=>{
  const sports=[...new Set(fixtures.map(normalizedSport).filter(Boolean))];
  const count=new Set(fixtures.map(c=>String(c.eventId))).size;
  const result=await scan(fixtures,{sports:sports.length?sports:['football','basketball','hockey','tennis','handball','volleyball'],hours,allowUnknownKickoff:true,signal,
   budgetMs:Math.min(150000,Math.max(20000,count*3000)),detailTimeoutMs:12000});
  const catalog={source:'SportyBet exact imported event markets',generatedAt:new Date().toISOString(),sports:{}};
  for(const row of result.rows){const sport=normalizedSport(row);if(!sport)continue;catalog.sports[sport]||={rows:[],fixtures:[]};catalog.sports[sport].rows.push(row);}
  for(const group of Object.values(catalog.sports))group.fixtures=[...new Map(group.rows.map(r=>[String(r.eventId),r])).values()];
  const candidates=excludeH2hFailures(await require('./sportyH2h').checkCandidates(await model(catalog),{signal}));candidates.dataSource=catalog.source;candidates.dataFetchedAt=catalog.generatedAt;candidates.sourceErrors=result.errors||{};candidates.marketCoverage={scan:result.coverage};return candidates;
 },{signal});
}
function unscoredReason(leg,candidates,hours,now=Date.now()) {
 if(candidates.h2hFailures?.[leg.eventId])return 'Excluded before ticket generation because SportyBet H2H verification did not pass: '+candidates.h2hFailures[leg.eventId];
 const kickoff=Date.parse(leg.kickoffUtc||'');
 if(Number.isFinite(kickoff)&&kickoff>now+hours*3600000)return 'This match is outside the selected analysis horizon. Choose 14 or 21 days to include it.';
 if(Number.isFinite(kickoff)&&kickoff<=now)return 'This match has already started or finished and is unavailable to prematch analysis.';
 if(candidates.sourceErrors?.[leg.eventId])return 'Current SportyBet event markets could not be loaded. Please retry.';
 return 'Exact selection decoded, but no probability estimate could be calculated from the available current market data';
}
module.exports={loadAnalyzerCandidates,unscoredReason,excludeH2hFailures};
