'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/cornerMarkets');
const {buildCandidates}=require('../lib/autoPicker');
const {modelOfferedMarkets}=require('../lib/offeredMarketModel');
const {withPublicSportyRequest}=require('../lib/sportyRequest');
function pair(line){return ['Over','Under'].map((side,i)=>({eventId:'corner-event',sport:'Football',home:'Home',away:'Away',tournament:'Test League',kickoffUtc:'2026-10-25T12:00:00Z',marketId:'166',marketDesc:'Corners - Over/Under',specifier:'total='+line,outcomeId:i?'13':'12',outcomeDesc:side,odds:i?1.25:4,marketOutcomeCount:2}));}
test('both exact full-match corner lines work without historical statistics and keep provider identity',async()=>{
 const rows=[...pair(11.5),...pair(12.5),...pair(9.5)];
 for(const id of C.IDS){const c=buildCandidates({predictions:{matches:[]},footballMarkets:{corners:{rows}},betTypes:[id],sportScope:'football',minProbability:70,minEdge:0});assert.equal(c.length,1);assert.equal(c[0].betType,id);assert.equal(c[0].marketId,'166');assert.equal(c[0].outcomeId,'13');assert.equal(c[0].specifier,id===C.IDS[0]?'total=11.5':'total=12.5');assert.equal(c[0].probability,76.2);}
 const offered=modelOfferedMarkets(rows).candidates;for(const id of C.IDS)assert.ok(offered.some(c=>c.betType===id));
});
test('half/team corners, other lines, conflicting lines and non-football are not relabelled',()=>{
 const c=pair(11.5)[1];for(const change of [{marketDesc:'1st Half Corners - Over/Under'},{marketDesc:'Home Corners - Over/Under'},{sport:'Basketball'},{live:true},{specifier:'total=10.5'},{outcomeDesc:'Over'},{outcomeDesc:'Under 12.5'}])assert.equal(C.betTypeFor({...c,...change}),null);
 assert.equal(C.betTypeFor(pair(10.5)[1]),null);
 const rows=pair(11.5);assert.equal(buildCandidates({predictions:{matches:[]},footballMarkets:{corners:{rows:[rows[1]]}},betTypes:C.IDS,minProbability:0}).length,0);
});
test('public corners feed requests observed market 166, paginates, and never calls event details',async()=>{
 const sporty=require('../lib/sportybet'),now=new Date('2026-10-23T08:00:00Z');let calls=0;
 const scan=await withPublicSportyRequest(()=>C.collectCornerMarkets({now:()=>now,client:{fetchPrematchPage:async(sport,page,size,opts)=>{calls++;assert.equal(sport,sporty.SPORT_IDS.football);assert.equal(opts.marketIds,'166');assert.equal(page,calls);if(page===2)return{data:{totalNum:2,tournaments:[{name:'Test',events:[{eventId:'second',homeTeamName:'Home',awayTeamName:'Away',estimateStartTime:+now+7200000,markets:[]}]}]}};return{data:{totalNum:2,tournaments:[{name:'Test',events:[{eventId:'first',homeTeamName:'Home',awayTeamName:'Away',estimateStartTime:+now+3600000,markets:[{id:'166',desc:'Corners - Over/Under',specifier:'total=12.5',outcomes:pair(12.5).map(x=>({id:x.outcomeId,desc:x.outcomeDesc,odds:x.odds}))}]}]}]}};},fetchEventDetail:()=>assert.fail('No detail calls')}}));assert.equal(calls,2);assert.equal(scan.coverage.complete,true);assert.equal(scan.coverage.detailReads,0);assert.equal(scan.rows.length,2);assert.equal((await C.candidatesFromRows(scan.rows,{betTypes:C.IDS,minProbability:70})).length,1);
});
test('website and bot register both lines, including Pro and natural-language requests',()=>{
 const fs=require('node:fs'),bot=require('../lib/telegramAiBot'),html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');for(const id of C.IDS){assert.ok(bot.ALL_BET_IDS.includes(id));assert.ok(bot.allowedBetIdsForPlan('pro').includes(id));assert.ok(html.includes(id));}
 const p=bot.parseNaturalRequest('build football corners under 11.5');assert.ok(p.betTypes.includes(C.IDS[0]));assert.ok(!p.betTypes.includes(C.IDS[1]));assert.equal(p.maxMatchOdds,null);
 const vm=require('node:vm');for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
});
test('website shows corner-feed fixtures missing from general predictions and selects only the requested line',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
 const source=name=>html.split('\n').find(l=>l.startsWith('function '+name+'('));
 const functions=['parseCornerLineUi','poissonCornerUi','fairFootballUi','cornerProbUi','footballPick','findFootballSporty','renderFootball'];
 // fairFootballUi is multi-line; use its exact body rather than a test model.
 const code=functions.map(n=>n==='fairFootballUi'?html.slice(html.indexOf('function fairFootballUi('),html.indexOf('\nfunction cornerProbUi(')):source(n)).join('\n');
 const cards=[],list={innerHTML:'',appendChild:c=>cards.push(c)},data={football:{corners:{loaded:true,rows:[...pair(11.5),...pair(12.5)]}}};
 const ctx={DATA:data,FOOTBALL:[],state:{market:{football:'corners_under115'},leagues:new Set(['Test League']),minProb:70,limit:10},document:{getElementById:()=>list,createElement:()=>({querySelector:()=>({})})},footballSource:()=> 'corners',resultP:()=>({h:0,d:0,a:0}),outcomeText:x=>x.outcomeDesc.toLowerCase(),tier:()=>({c:'',l:''}),esc:x=>String(x),fmtKickoff:x=>x,impliedOdds:x=>100/x,isSelected:()=>false,h2hHtml:()=>'',summary:()=>{}};
 vm.runInNewContext(code+'\nrenderFootball()',ctx);assert.equal(cards.length,1);assert.ok(cards[0].innerHTML.includes('Under 11.5 Corners'));assert.ok(!cards[0].innerHTML.includes('Under 12.5 Corners'));
});
