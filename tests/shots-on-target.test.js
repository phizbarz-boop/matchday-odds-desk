'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const S=require('../lib/shotsOnTargetMarkets'),{modelOfferedMarkets}=require('../lib/offeredMarketModel');
function pair(line,over=false){return ['Over','Under'].map((side,i)=>({eventId:'E',sport:'Football',home:'H',away:'A',tournament:'Test',kickoffUtc:'2026-10-25T12:00:00Z',marketId:'900393',marketDesc:'Shots on Target Over/Under',specifier:'total='+line,outcomeId:i?'13':'12',outcomeDesc:side,odds:(i===0)===over?1.25:4,marketOutcomeCount:2}));}
test('three exact shots-on-target lines get separate IDs from complete current prices',()=>{
 for(const [line,over,id] of [[13.5,false,S.IDS[0]],[12.5,false,S.IDS[1]],[4.5,true,S.IDS[2]]]){const c=modelOfferedMarkets(pair(line,over)).candidates.find(c=>c.betType===id);assert.ok(c);assert.equal(c.specifier,'total='+line);assert.equal(c.marketId,'900393');assert.equal(c.outcomeId,over?'12':'13');assert.equal(c.probability,76.2);assert.equal(c.independentModel,false);}
});
test('player, team, first-half, total shots and conflicting lines cannot replace match shots on target',()=>{
 const c=pair(13.5)[1];for(const change of [{marketDesc:'1st Half Shots On Target Over/Under'},{marketDesc:'Home Team Shots on Target Over/Under'},{marketDesc:'Player shots on target Over/Under'},{marketDesc:'Shots Over/Under'},{specifier:'total=12.5',outcomeDesc:'Under 13.5'},{sport:'Ice Hockey'},{live:true}])assert.equal(S.betTypeFor({...c,...change}),null);
 assert.equal(S.betTypeFor(pair(11.5)[1]),null);assert.equal(S.betTypeFor(pair(4.5)[1]),null);
 assert.ok(!modelOfferedMarkets([c]).candidates.some(x=>S.IDS.includes(x.betType)));
});
test('shots on target never settle from the football goal score',()=>{for(const c of [pair(13.5)[1],pair(4.5,true)[0]])assert.equal(require('../lib/liveSettlement').settleSelection({...c,betType:S.betTypeFor(c)},{status:3,matchStatus:'FT',homeScore:1,awayScore:0}).status,'pending');});
test('direct public collection uses verified full-match ID and filters the raw winner gap before scoring',async()=>{
 const {withPublicSportyRequest}=require('../lib/sportyRequest'),now=new Date('2026-10-24T06:00:00Z');
 async function collect(gap,flags){return withPublicSportyRequest(()=>S.collectShotsOnTargetCandidates({now:()=>now,hours:168,minProbability:70,...flags,client:{fetchPrematchPage:async(_sport,_page,_size,opts)=>{assert.equal(opts.marketIds,'1,900393');return{data:{totalNum:1,events:[{eventId:'E',homeTeamName:'H',awayTeamName:'A',estimateStartTime:+now+3600000,markets:[{id:'1',desc:'1X2',outcomes:[{id:'1',desc:'Home',odds:1.7},{id:'2',desc:'Draw',odds:8},{id:'3',desc:'Away',odds:1.7+gap}]},...[13.5,12.5,4.5].map(line=>({id:'900393',desc:'Shots on Target Over/Under',specifier:'total='+line,outcomes:pair(line,line===4.5).map(x=>({id:x.outcomeId,desc:x.outcomeDesc,odds:x.odds}))}))]}]}};},fetchEventDetail:()=>assert.fail('No detail calls')}}));}
 assert.equal((await collect(1,{winnerGapMaxOne:true})).length,3);assert.equal((await collect(1.01,{winnerGapMaxOne:true})).length,0);assert.equal((await collect(8,{winnerGapAboveEight:true})).length,0);assert.equal((await collect(8.01,{winnerGapAboveEight:true})).length,3);assert.equal((await collect(1,{winnerGapMaxOne:true,minProbability:80})).length,0);
});
test('Telegram shots tickets use 10/20 caps with distinct Under and Over gap rules',()=>{
 const {PLANS,buildPack}=require('../lib/telegramFloorPicks'),now=new Date('2026-10-24T06:00:00Z');
 const rows=[];for(let i=0;i<40;i++)for(const type of S.IDS)rows.push({...pair(type===S.IDS[0]?13.5:type===S.IDS[1]?12.5:4.5,type===S.IDS[2])[type===S.IDS[2]?0:1],eventId:'E'+i,betType:type,probability:80,winnerGapMaxOneQualified:type!==S.IDS[2],winnerGapAboveEightQualified:type===S.IDS[2]});
 const plans=buildPack(rows,{now}).plans.filter(p=>p.id.startsWith('shots'));assert.equal(plans.length,4);assert.deepEqual(plans.map(p=>p.selections.length),[10,20,10,20]);for(const p of plans){assert.equal(p.floor,70);assert.equal(new Set(p.selections.map(c=>c.eventId)).size,p.maxGames);assert.ok(p.selections.every(c=>p.betTypes.includes(c.betType)));if(p.id.startsWith('shotsUnder'))assert.equal(p.winnerGapMaxOne,true);else assert.equal(p.winnerGapAboveEight,true);}
 assert.ok(PLANS.filter(p=>p.longShot&&!p.id.startsWith('shots')).every(p=>p.maxGames===30));
});
test('website removes the throw-in checkbox and offers three exact selectable shots markets',()=>{
 const fs=require('node:fs'),vm=require('node:vm'),html=fs.readFileSync(require('node:path').join(__dirname,'../public/index.html'),'utf8');
 assert.ok(!html.includes("{id:'throwins_highest_under',label:"));for(const id of S.IDS)assert.ok(html.includes("{id:'"+id+"',label:"));
 const single=name=>html.split('\n').find(l=>l.startsWith('function '+name+'('));const functions=['parseCornerLineUi','fairFootballUi','footballPick','findFootballSporty'];
 const code=functions.map(n=>n==='fairFootballUi'?html.slice(html.indexOf('function fairFootballUi('),html.indexOf('\nfunction cornerProbUi(')):single(n)).join('\n');
 const ctx={DATA:{football:{shots_on_target:{rows:[...pair(13.5),...pair(12.5),...pair(4.5,true)]}}},AUTO_BET_TYPES:S.TYPES.map(([id,label])=>({id,label})),footballSource:()=> 'shots_on_target',resultP:()=>({}),outcomeText:x=>x.outcomeDesc.toLowerCase()};vm.createContext(ctx);vm.runInContext(code,ctx);
 for(const id of S.IDS){ctx.kind=id;ctx.fixture={eventId:'E'};const result=vm.runInContext('const sp=findFootballSporty(fixture,kind); ({sp,pick:footballPick(fixture,kind,sp)})'.replace('const sp=','var sp='),ctx);assert.equal(S.betTypeFor(result.sp),id);assert.equal(result.pick.prob,76.2);assert.ok(result.pick.label.includes('Shots on Target'));}
});
