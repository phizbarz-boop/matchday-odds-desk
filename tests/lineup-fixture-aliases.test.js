'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{matchFixture}=require('../lib/apiSportsH2hData');
const kickoff='2026-11-07T17:30:00Z';
const cases=[['Nottingham Forest','Man City','Nottingham Forest','Manchester City'],['Osasuna','Athletic Bilbao','Osasuna','Athletic Club'],['Leganes','Albacete Balompie','Leganes','Albacete'],['Stuttgart','Werder Bremen','VfB Stuttgart','Werder Bremen'],['Alverca Futebol','Casa Pia Lisbon','Alverca','Casa Pia'],['AJ Auxerre','Paris FC','Auxerre','Paris FC'],['CA Talleres de Cordoba','Estudiantes de La Plata','Talleres Cordoba','Estudiantes L.P.'],['Gimnasia y Esgrima Mendoza','Independiente Rivadavia','Gimnasia M.','Independ. Rivadavia'],['Deportes La Serena','CD Palestino','D. La Serena','Palestino'],['Benevento Calcio','US Avellino','Benevento','Avellino']];
const fixture=(home,away,extra={})=>({fixture:{id:1,date:kickoff},teams:{home:{id:1,name:home},away:{id:2,name:away}},...extra});
test('every exact name pair supplied in the lineup diagnostics maps with the same kickoff',()=>{
 for(const [home,away,apiHome,apiAway] of cases){const f=fixture(apiHome,apiAway),c={home,away,kickoffUtc:kickoff,sport:'Football'};assert.equal(matchFixture([f],c),f,home+' vs '+away);}
});
test('aliases never merge women, reserve, youth, wrong opponents or ambiguous fixtures',()=>{
 for(const [home,away,apiHome,apiAway] of cases){const c={home,away,kickoffUtc:kickoff,sport:'Football'},f=fixture(apiHome,apiAway);
 for(const suffix of [' W',' U19',' II']){assert.equal(matchFixture([fixture(apiHome+suffix,apiAway)],c),null);assert.equal(matchFixture([fixture(apiHome,apiAway+suffix)],c),null);}
 assert.equal(matchFixture([f,f],c),null);assert.equal(matchFixture([fixture(apiAway,apiHome)],c),null);assert.equal(matchFixture([fixture(apiHome,apiAway,{fixture:{id:1,date:'2026-11-08T17:30:00Z'}})],c),null);
 }
});
test('candidate count distinguishes many players from distinct match slots',()=>{const {selectAutoBet}=require('../lib/autoPicker');const rows=Array.from({length:15},(_,i)=>({eventId:String(i%2),marketId:'m',outcomeId:String(i),odds:1.1,probability:90,qualityScore:90,edge:0}));const r=selectAutoBet(rows,{targetOdds:5,maxSelections:20,trials:50});assert.equal(r.candidateCount,15);assert.equal(r.candidateFixtureCount,2);assert.equal(r.selections.length,2);});
test('player-only scans request up to 160 fixtures and stream just scorer markets',async()=>{
 const sporty=require('../lib/sportybet'),scanner=require('../lib/expandedMarketScan'),oldBase=sporty.getFootballMarket,oldScan=scanner.scanExpandedMarkets;
 sporty.getFootballMarket=async()=>({rows:[]});let options;
 scanner.scanExpandedMarkets=async(fixtures,o)=>{options=o;assert.equal(o.maxEventsOverride,160);assert.equal(typeof o.onFixtureRows,'function');const base={eventId:'e',sport:'Football',home:'Home',away:'Away',kickoffUtc:new Date(Date.now()+3600000).toISOString(),marketId:'900',marketDesc:'Player Not to Score',outcomeId:'John',outcomeDesc:'John Defender',odds:1.1};o.onFixtureRows([base,{...base,marketId:'other',marketDesc:'Full Time Result'}]);return {rows:[],errors:{},coverage:{detailReads:1}};};
 try{const r=await require('../lib/footballExtraMarkets').collect({betTypes:['player_not_to_score'],minEdge:-100});assert.equal(r.marketCoverage.discoveredMarketInstances,1);assert.equal(r.marketCoverage.playerScorer.lineups.offered,1);assert.equal(options.budgetMs,20000);}finally{sporty.getFootballMarket=oldBase;scanner.scanExpandedMarkets=oldScan;}
});
