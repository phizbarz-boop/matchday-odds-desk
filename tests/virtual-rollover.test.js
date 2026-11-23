'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const roll=require('../lib/virtualRollOver');

test('scheduled Roll Over waits for a confirmed score, then rolls the win and resets on a loss',async()=>{
 let now=Date.now()-3600000, id='sr:match:99901', kickoff=now+120000, mode='NS', score='0:0', books=0;
 const messages=[], map=new Map();
 const redis={get:async k=>map.get(k),set:async(k,v,o)=>{if(o?.NX&&map.has(k))return null;map.set(k,v);return 'OK';},eval:async(_,o)=>{if(map.get(o.keys[0])===o.arguments[0])map.delete(o.keys[0]);}};
 const f={eventId:id,homeTeamName:'MON',awayTeamName:'RAY',tournamentId:'777',estimateStartTime:kickoff};
 const active=()=>({...f,eventId:id,estimateStartTime:kickoff,matchStatus:mode,score});
 const client={
  fetchPrematchPage:async sport=>{assert.equal(sport,'sr:sport:202120001');return {data:{events:[{...active(),markets:[
    {id:'18',specifier:'total=4.5',status:0,outcomes:[{id:'13',desc:'Under 4.5',odds:1.2,isActive:1}]},
    {id:'1',status:0,outcomes:[{id:'1',desc:'Home',odds:1.22,isActive:1}]}
  ]}]}};},
  fetchEventDetail:async eventId=>({data:{...active(),eventId,...(eventId!==id?{matchStatus:'FT',score:'1:0'}:{})}})
 };
 const state=roll.freshState();
 for(let i=0;i<5;i++)state.history.push({eventId:'sr:match:'+(500+i),league:'777',home:'MON',away:'RAY',h:1,a:1,verifiedAt:now-3600000-i});
 await redis.set('virtual-rollover:v1',JSON.stringify(state));
 const run=(slotKey,pendingCode)=>roll.run({redis,slotKey,pendingCode,dateKey:'2026-11-15'},{client,clock:()=>now,book:async legs=>{
  assert.equal(legs.length,1);assert.equal(legs[0].specifier,'total=4.5');books++;return {shareCode:'CODE'+books};
 },send:async x=>messages.push(x)});
 const saved=await redis.get('virtual-rollover:v1');
 const preview=await roll.preview(redis,{client,clock:()=>now});
 assert.equal(preview.status,'preview');assert.equal(preview.odds,1.2);
 const code=await roll.preview(redis,{client,clock:()=>now,book:async()=>({shareCode:'TEST13'})});
 assert.equal(code.status,'booked');assert.equal(code.code,'TEST13');
 assert.equal(await redis.get('virtual-rollover:v1'),saved);
 assert.equal(messages.length,0);
 assert.equal((await run('00:00')).ticketsSent,1);
 assert.equal((await run('00:30')).reason,'awaiting_settlement');
 assert.equal(books,1);
 mode='live';now=kickoff+20000;
 assert.equal((await run('settled:CODE1','CODE1')).reason,'awaiting_settlement');
 const observed=(await roll.stateOf(redis)).pending.timings[id];
 assert.equal(observed.kickoffUtc,new Date(kickoff).toISOString());
 assert.equal(observed.startedObservedAt,new Date(now).toISOString());
 const old=id;
 now+=20000;id='sr:match:99902';kickoff=now+120000;mode='NS';
 assert.equal((await run('settled:CODE1','CODE1')).ticketsSent,1);
 const advanced=await roll.stateOf(redis);
 assert.equal(advanced.balance,300000);
 assert.equal(advanced.pending.stake,300000);
 assert.match(messages.at(-2),/WON/);
 assert.match(messages.at(-1),/Model estimate: [0-9.]+%/);
 assert.equal(advanced.last.timings[old].finishedObservedAt,new Date(observed.startedObservedAt ? Date.parse(observed.startedObservedAt)+20000 : 0).toISOString());

 assert.equal((await run('settled:CODE1','CODE1')).reason,'pending_changed');
 assert.equal(books,2);
 mode='FT';score='3:2';now=kickoff+600000;
 await run('02:00');
 assert.equal((await roll.stateOf(redis)).balance,250000);
 assert.match(messages.at(-1),/LOST/);
});
test('no model ticket without verified form, and void legs preserve the applicable stake',()=>{
 assert.equal(roll.select([{fixture:{eventId:'sr:match:9',kickoffUtc:new Date(Date.now()+60000).toISOString()},rows:[]}],[],Date.now()),null);
 assert.deepEqual(roll.settle({stake:250000,step:2,legs:[{odds:1.2,field:'u45'}]},[{void:true}]),{status:'Void',returned:250000,nextBalance:250000,nextStep:2});
});

test('captured virtual Stats response maps scores to the correct teams',async()=>{
 const {collect}=require('../lib/virtualRollOverForm');
 const fixture={eventId:'sr:match:200026111521022',home:'BHA',away:'FUL'};
 const payload={"bizCode":10000,"innerMsg":"success","message":"success","data":{"homeTeam":{"teamName":"BHA","teamId":"191128112403tmp000000016","recentMatches":[{"homeTeamId":"191128112403tmp000000019","awayTeamId":"191128112403tmp000000016","homeTeamName":"LIV","awayTeamName":"BHA","homeScore":0,"awayScore":2},{"homeTeamId":"191128112403tmp000000016","awayTeamId":"191128112403tmp000000015","homeTeamName":"BHA","awayTeamName":"TOT","homeScore":2,"awayScore":0},{"homeTeamId":"191128112403tmp000000016","awayTeamId":"260810160028tmp000000002","homeTeamName":"BHA","awayTeamName":"HUL","homeScore":0,"awayScore":1},{"homeTeamId":"191128112403tmp000000016","awayTeamId":"191128112403tmp000000001","homeTeamName":"BHA","awayTeamName":"ARS","homeScore":2,"awayScore":2},{"homeTeamId":"191128112403tmp000000016","awayTeamId":"191128112403tmp000000009","homeTeamName":"BHA","awayTeamName":"CHE","homeScore":2,"awayScore":1}]},"awayTeam":{"teamName":"FUL","teamId":"191128112403tmp000000022","recentMatches":[{"homeTeamId":"191128112403tmp000000022","awayTeamId":"191128112403tmp000000007","homeTeamName":"FUL","awayTeamName":"CRY","homeScore":2,"awayScore":2},{"homeTeamId":"191128112403tmp000000022","awayTeamId":"191128112403tmp000000011","homeTeamName":"FUL","awayTeamName":"MCI","homeScore":1,"awayScore":2},{"homeTeamId":"191128112403tmp000000022","awayTeamId":"191128112403tmp000000002","homeTeamName":"FUL","awayTeamName":"AST","homeScore":2,"awayScore":1},{"homeTeamId":"191128112403tmp000000022","awayTeamId":"260810160028tmp000000001","homeTeamName":"FUL","awayTeamName":"COV","homeScore":0,"awayScore":4},{"homeTeamId":"191128112403tmp000000022","awayTeamId":"191128112403tmp000000021","homeTeamName":"FUL","awayTeamName":"LEE","homeScore":0,"awayScore":0}]}}};
 const request=async(path,opts)=>{
  assert.equal(path,'/scheduledVirtual/api/v1/stats/team_stats');
  assert.equal(opts.params.eventId,fixture.eventId);
  assert.equal(opts.publicRead,true);
  return payload;
 };
 assert.deepEqual(await collect(fixture,{request}),{home:[[2,0],[2,0],[0,1],[2,2],[2,1]],away:[[2,2],[1,2],[2,1],[0,4],[0,0]]});
 assert.equal(await collect({...fixture,away:'OTHER'},{request}),null);
 payload.data.homeTeam.recentMatches[0].homeScore=null;
 assert.equal(await collect(fixture,{request}),null);
});

test('scheduled virtual End status uses the final setScore and verifies event identity',async()=>{
 const f={eventId:'sr:match:200026111521033',home:'BHA',away:'LEE'};
 const event={...f,matchStatus:'End',eventStatus:3,setScore:'0:4',gameScore:['0:2','0:2'],score:'0:2'};
 const read=e=>roll.resultFor({fetchEventDetail:async()=>({data:{event:e}})},f);
 const result=await read(event);
 assert.deepEqual(result,{h:0,a:4,fh:2});
 assert.equal(roll.settle({stake:250000,step:0,legs:[{field:'u45',odds:1.13}]},[result]).returned,282500);
 assert.equal(await read({...event,matchStatus:'Live'}),null);
 assert.equal(await read({...event,eventId:'sr:match:other'}),null);
});

test('RDP follows the table whitelist and starts at ₦2,000 with 1.15-1.55',()=>{
 assert.equal(roll.RDP.minOdds,1.15);assert.equal(roll.RDP.maxOdds,1.55);assert.equal(roll.RDP.maxLegs,2);assert.equal(roll.RDP.opening,200000);
 assert.deepEqual([...roll.RDP.marketFields],['o05','u45','u55','h35']);
 assert.equal(roll.rdpWhitelistAllowed({field:'u55',country:'spain',home:'ESP',away:'RMA'}),true);
 assert.equal(roll.rdpWhitelistAllowed({field:'o05',country:'england',home:'NFO',away:'ARS'}),false);
 assert.equal(roll.rdpWhitelistAllowed({field:'tu25',country:'germany',home:'KOE',away:'BAY',side:'home'}),false);
 assert.equal(roll.rdpWhitelistAllowed({field:'h35',country:'spain',home:'GET',away:'RMA'}),true);
 assert.equal(roll.settle({stake:200000,step:0,legs:[{field:'h35',odds:1.6}]},[{h:2,a:2,fh:1}],200000).returned,320000);
 assert.equal(roll.settle({stake:200000,step:1,legs:[{field:'h35',odds:1.6}]},[{h:4,a:1,fh:4}],200000).nextBalance,200000);
 assert.equal(roll.settle({stake:200000,step:1,legs:[{field:'h35',odds:1.6}]},[{h:4,a:1}],200000),null);
 assert.equal(roll.settle({stake:200000,step:0,legs:[{field:'tu25',side:'home',odds:1.2}]},[{h:1,a:3}],200000).status,'Won');
 assert.equal(roll.settle({stake:200000,step:0,legs:[{field:'tu25',side:'away',odds:1.2}]},[{h:0,a:3}],200000).status,'Lost');
});

test('research list allows a bet when either team has zero fails on that market',()=>{
 const row=(field,home,away)=>({field,home,away});
 assert.equal(roll.rowTeamAllowed(row('u45','RAY','CHE')),true);
 assert.equal(roll.rowTeamAllowed(row('u45','CHE','ARS')),false);
 assert.equal(roll.rowTeamAllowed(row('u55','RBB','ARS')),true);
 assert.equal(roll.rowTeamAllowed(row('u55','TOU','ARS')),false);
 assert.equal(roll.rowTeamAllowed(row('u55','CHE','ARS')),false);
 assert.equal(roll.rowTeamAllowed(row('o05','SGE','CHE')),true);
 assert.equal(roll.rowTeamAllowed(row('o05','BMU','CHE')),true);
 assert.equal(roll.rowTeamAllowed(row('o05','FRO','RAY')),false);
 assert.equal(roll.rowTeamAllowed(row('h35','AUX','CHE')),true);
 assert.equal(roll.rowTeamAllowed(row('h35','INT','CHE')),true);
 assert.equal(roll.rowTeamAllowed(row('h35','CHE','ARS')),false);
 assert.equal(roll.rowTeamAllowed(row('o15','MON','RAY')),false);
});

test('the one-year prior prices the best teams and can stand in when recent form is missing',()=>{
 const prior=require('../lib/vfTeamPrior');
 assert.ok(prior.rate('RAY','u45')>prior.rate('CHE','u45'));
 assert.equal(prior.best('CHE','o05'),true);
 assert.equal(prior.best('CHE','u45'),false);
 assert.equal(roll.rowTeamAllowed({field:'u45',home:'VCF',away:'CHE'}),true);
 assert.equal(roll.rowTeamAllowed({field:'o05',home:'CHE',away:'SUN'}),true);
 const now=Date.now();
 const ticket=roll.select([{fixture:{eventId:'sr:match:prior',home:'RAY',away:'VCF',league:'Spain',kickoffUtc:new Date(now+600000).toISOString()},rows:[{field:'u45',odds:1.2,home:'RAY',away:'VCF',eventId:'sr:match:prior'}]}],[],now);
 assert.ok(ticket);
 assert.ok(ticket.probability>0.9);
});

test('the virtual desk applies the probability floor and rejects an unknown market',()=>{
 const now=Date.now(), kick=new Date(now+600000).toISOString();
 const board=[{fixture:{eventId:'sr:match:desk',home:'RAY',away:'VCF',league:'Spain',kickoffUtc:kick},rows:[
  {field:'u45',odds:1.4,home:'RAY',away:'VCF',eventId:'sr:match:desk',pick:'Under 4.5'},
  {field:'o15',odds:1.4,home:'RAY',away:'VCF',eventId:'sr:match:desk',pick:'Over 1.5'}
 ]}];
 const lane={minOdds:1.2,maxOdds:2,maxLegs:2,marketFields:['u45','u55','o05','h35']};
 assert.equal(roll.select(board,[],now,new Set(),{...lane,minProbability:99}),null);
 const ticket=roll.select(board,[],now,new Set(),{...lane,minProbability:80});
 assert.equal(ticket.legs.length,1);assert.equal(ticket.legs[0].field,'u45');
 assert.deepEqual(roll.deskOptions({markets:['corners','u45'],minProbability:200,maxLegs:20}).markets,['u45']);
 assert.deepEqual(roll.deskOptions({markets:['o15','u45']}).markets,['o15','u45']);
 assert.equal(roll.deskOptions({minOdds:1.8,maxOdds:1.2}).maxOdds,1.8);
 assert.equal(roll.deskOptions({maxLegs:50}).maxLegs,50);
 assert.equal(roll.deskOptions({maxLegs:80}).maxLegs,50);
 const many=Array.from({length:50},(_,i)=>({fixture:{eventId:'sr:match:m'+i,home:'RAY',away:'VCF',league:'Spain',kickoffUtc:kick},rows:[{field:'u45',odds:1.02,home:'RAY',away:'VCF',eventId:'sr:match:m'+i,pick:'Under 4.5'}]}));
 const wide=roll.select(many,[],now,new Set(),{...lane,maxOdds:20,maxLegs:50,minProbability:80,stack:true});
 assert.equal(wide.legs.length,50);

 assert.equal(roll.rowTeamAllowed({field:'u45',home:'CHE',away:'ZZZ'}),false);
 const plain=[{fixture:{eventId:'sr:match:che',home:'CHE',away:'ZZZ',league:'England',kickoffUtc:kick},rows:[{field:'u45',odds:1.4,home:'CHE',away:'ZZZ',eventId:'sr:match:che',pick:'Under 4.5'}]}];
 assert.equal(roll.select(plain,[],now,new Set(),{...lane,stack:true,minProbability:85}),null);
 assert.equal(roll.select(plain,[],now,new Set(),{...lane,stack:true,minProbability:70}).legs[0].field,'u45');
});


test('the higher virtual session looks six hours ahead and leaves the rollover window at 30 minutes',()=>{
 assert.equal(roll.deskSession({}).horizonMs,30*60000);
 assert.equal(roll.deskSession({session:'higher'}).horizonMs,6*3600000);
 assert.equal(roll.deskSession({session:'higher'}).maxLegOdds,5);
 assert.equal(roll.deskSession({session:'next'}).maxLegOdds,null);
});

test('a high combined target uses the longer prices instead of the shortest ones',()=>{
 const now=Date.now(), kick=new Date(now+600000).toISOString();
 const board=[];
 for(let i=0;i<20;i++)board.push({fixture:{eventId:'sr:match:s'+i,home:'RAY',away:'VCF',league:'Spain',kickoffUtc:kick},rows:[{field:'u45',odds:1.08,home:'RAY',away:'VCF',eventId:'sr:match:s'+i,pick:'Under 4.5'}]});
 for(let i=0;i<20;i++)board.push({fixture:{eventId:'sr:match:l'+i,home:'MON',away:'NAP',league:'Italy',kickoffUtc:kick},rows:[{field:'u45',odds:1.35,home:'MON',away:'NAP',eventId:'sr:match:l'+i,pick:'Under 4.5'}]});
 const note={}, lane={minOdds:200,maxOdds:2000,maxLegs:20,minProbability:70,marketFields:['u45'],stack:true,maxLegOdds:5,note};
 const ticket=roll.select(board,[],now,new Set(),lane);
 assert.ok(ticket.odds>=200&&ticket.odds<=2000);
 assert.ok(ticket.legs.every(leg=>leg.odds===1.35));
 assert.equal(roll.deskOptions({minOdds:200,maxOdds:2000}).maxOdds,2000);
});

test('max payout under uses only the under markets and keeps the ticket even below a high target',()=>{
 assert.equal(roll.deskSession({session:'max-under'}).horizonMs,6*3600000);
 assert.equal(roll.deskSession({session:'max-under'}).maxUnder,true);
 const now=Date.now(), kick=new Date(now+600000).toISOString();
 const board=[
  {fixture:{eventId:'sr:match:over',home:'NFO',away:'SUN',league:'England',kickoffUtc:kick},rows:[{field:'o05',odds:4,home:'NFO',away:'SUN',eventId:'sr:match:over',pick:'Over 0.5'}]},
  {fixture:{eventId:'sr:match:short',home:'RAY',away:'VCF',league:'Spain',kickoffUtc:kick},rows:[{field:'u45',odds:1.08,home:'RAY',away:'VCF',eventId:'sr:match:short',pick:'Under 4.5'}]},
  {fixture:{eventId:'sr:match:long',home:'MON',away:'NAP',league:'Italy',kickoffUtc:kick},rows:[{field:'u55',odds:1.4,home:'MON',away:'NAP',eventId:'sr:match:long',pick:'Under 5.5'}]}
 ];
 const ticket=roll.select(board,[],now,new Set(),{minOdds:1.05,maxOdds:2000,maxLegs:20,minProbability:70,marketFields:['u45','u55','h35'],stack:true,maxLegOdds:5,preferLong:true});
 assert.deepEqual(ticket.legs.map(leg=>leg.field),['u55','u45']);
 assert.ok(ticket.odds<200);
});

test('website under tickets can price first-half under 2.5 and 1.5 for a trusted half team',()=>{
 assert.equal(roll.rowTeamAllowed({field:'h25',home:'RAY',away:'CHE'}),true);
 assert.equal(roll.rowTeamAllowed({field:'h15',home:'CHE',away:'ARS'}),false);
 const now=Date.now(), kick=new Date(now+600000).toISOString();
 const board=[{fixture:{eventId:'sr:match:half',home:'RAY',away:'MON',league:'Spain',kickoffUtc:kick},rows:[
  {field:'h15',odds:1.9,home:'RAY',away:'MON',eventId:'sr:match:half',pick:'1st Half Under 1.5'},
  {field:'h25',odds:1.35,home:'RAY',away:'MON',eventId:'sr:match:half',pick:'1st Half Under 2.5'}
 ]}];
 const ticket=roll.select(board,[],now,new Set(),{minOdds:1.05,maxOdds:20,maxLegs:2,minProbability:75,marketFields:['h15','h25'],stack:true,preferLong:true,maxLegOdds:5});
 assert.equal(ticket.legs.length,1);
 assert.equal(ticket.legs[0].field,'h25');
 assert.ok(ticket.legs[0].probability>=75);
});

test("kept virtual games can be booked again without the removed ones",()=>{const board=[{fixture:{eventId:"sr:match:1"},rows:[{eventId:"sr:match:1",marketId:"68",outcomeId:"13",specifier:"total=2.5",odds:1.4,home:"RAY",away:"MON",pick:"1st Half Under 2.5"}]},{fixture:{eventId:"sr:match:2"},rows:[{eventId:"sr:match:2",marketId:"18",outcomeId:"13",specifier:"total=4.5",odds:1.2,home:"NAP",away:"BFC",pick:"Under 4.5"}]}];const kept=roll.matchKept(board,[{eventId:"sr:match:1",marketId:"68",outcomeId:"13",specifier:"total=2.5",home:"RAY",away:"MON"}]);assert.equal(kept.legs[0].home,"RAY");assert.equal(roll.matchKept(board,[{eventId:"sr:match:9",marketId:"68",outcomeId:"13",specifier:"total=2.5",home:"CHE",away:"ARS"}]).missing[0].home,"CHE");});

test('the trusted toggle keeps whitelist or year top 20% teams only',()=>{
 const now=Date.now(), kick=new Date(now+600000).toISOString();
 const board=[
  {fixture:{eventId:'sr:match:ray',home:'RAY',away:'ZZZ',league:'Spain',kickoffUtc:kick},rows:[{field:'u45',odds:1.3,home:'RAY',away:'ZZZ',eventId:'sr:match:ray',pick:'Under 4.5'}]},
  {fixture:{eventId:'sr:match:che',home:'CHE',away:'ZZZ',league:'England',kickoffUtc:kick},rows:[{field:'u45',odds:1.8,home:'CHE',away:'ZZZ',eventId:'sr:match:che',pick:'Under 4.5'}]}
 ];
 const lane={minOdds:1.05,maxOdds:20,maxLegs:5,minProbability:50,marketFields:['u45'],stack:true};
 const open=roll.select(board,[],now,new Set(),lane);
 const closed=roll.select(board,[],now,new Set(),{...lane,trustedOnly:true});
 assert.ok(open.legs.some(leg=>leg.home==='CHE'));
 assert.deepEqual(closed.legs.map(leg=>leg.home),['RAY']);
});

test('the virtual builder can target 200 million combined odds',()=>{
 assert.equal(roll.deskOptions({minOdds:1.2,maxOdds:200000000}).maxOdds,200000000);
 assert.equal(roll.deskOptions({maxOdds:1e15}).maxOdds,1e12);
 assert.equal(roll.deskSession({session:'max-under'}).maxLegOdds,20);
});

test('bot mix can price the longer markets used on a high-odds slip',async()=>{
 const now=Date.now(), kick=now+600000;
 let requested='';
 const client={fetchPrematchPage:async(_sport,_page,_size,options)=>{requested=options.marketIds;return {data:{events:[{eventId:'sr:match:88001',homeTeamName:'SUN',awayTeamName:'EVE',tournamentId:'England',estimateStartTime:kick,sport:{id:'sr:sport:202120001'},markets:[
  {id:'68',desc:'1st Half - Over/Under',specifier:'total=0.5',status:0,outcomes:[{id:'12',desc:'Over 0.5',odds:1.67,isActive:1}]},
  {id:'18',desc:'Over/Under',specifier:'total=1.5',status:0,outcomes:[{id:'12',desc:'Over 1.5',odds:1.57,isActive:1}]},
  {id:'20',desc:'Away Total',specifier:'total=0.5',status:0,outcomes:[{id:'12',desc:'Over 0.5',odds:1.78,isActive:1}]},
  {id:'19',desc:'Home Total',specifier:'total=1.5',status:0,outcomes:[{id:'13',desc:'Under 1.5',odds:1.95,isActive:1}]}
 ]}]}};}};
 const board=await roll.fixtures(client,now,null,{marketFields:['h15','ho05','o15','t05','tu15'],maxOdds:1e12,maxLegOdds:20},6*3600000);
 assert.match(requested,/68/);assert.match(requested,/19/);assert.match(requested,/20/);
 assert.deepEqual(board[0].rows.map(row=>row.field).sort(),['ho05','o15','t05','tu15']);
 assert.equal(board[0].rows.find(row=>row.field==='t05').pick,'EVE Over 0.5');
 assert.equal(board[0].rows.find(row=>row.field==='tu15').pick,'SUN Under 1.5');
 const priced=roll.select(board,[],now,new Set(),{minOdds:1.05,maxOdds:1e12,maxLegs:20,minProbability:55,marketFields:['h15','ho05','o15','t05','tu15'],stack:true,preferLong:true,maxLegOdds:20});
 assert.equal(priced.legs.length,1);
 assert.ok(priced.legs[0].odds>=1.57);
 const outside=[{fixture:{eventId:'sr:match:88002',home:'STR',away:'NCE',league:'France',kickoffUtc:new Date(kick).toISOString()},rows:[{field:'h15',odds:1.99,home:'STR',away:'NCE',eventId:'sr:match:88002',pick:'1st Half Under 1.5'}]}];
 assert.equal(roll.select(outside,[],now,new Set(),{minOdds:1.05,maxOdds:1e12,maxLegs:5,minProbability:55,marketFields:['h15'],stack:true,preferLong:true,maxLegOdds:20}).legs.length,1);
 assert.equal(roll.select(outside,[],now,new Set(),{minOdds:1.05,maxOdds:1e12,maxLegs:5,minProbability:55,marketFields:['h15'],stack:true,trustedOnly:true,preferLong:true,maxLegOdds:20}),null);
});

test('one listed team keeps a game when either side is on any list and reads the extra bot markets',async()=>{
 const now=Date.now(), kick=now+600000;
 const lane={minOdds:1.05,maxOdds:1e12,maxLegs:5,minProbability:50,marketFields:['o15','u25','gg','tu25'],stack:true,preferLong:true,maxLegOdds:20,oneListed:true};
 const board=[
  {fixture:{eventId:'sr:match:ful',home:'SUN',away:'FUL',league:'England',kickoffUtc:new Date(kick).toISOString()},rows:[{field:'o15',odds:1.62,home:'SUN',away:'FUL',eventId:'sr:match:ful',pick:'Over 1.5'}]},
  {fixture:{eventId:'sr:match:bou',home:'SUN',away:'BOU',league:'England',kickoffUtc:new Date(kick).toISOString()},rows:[{field:'gg',odds:2.35,home:'SUN',away:'BOU',eventId:'sr:match:bou',pick:'GG Yes'}]}
 ];
 const ticket=roll.select(board,[],now,new Set(),lane);
 assert.deepEqual(ticket.legs.map(leg=>leg.away),['BOU']);
 const client={fetchPrematchPage:async(_sport,_page,_size,options)=>{
  assert.match(options.marketIds,/29/);
  return {data:{events:[{eventId:'sr:match:88011',homeTeamName:'ATM',awayTeamName:'ELC',tournamentId:'Spain',estimateStartTime:kick,sport:{id:'sr:sport:202120001'},markets:[
   {id:'18',desc:'Over/Under',specifier:'total=2.5',status:0,outcomes:[{id:'13',desc:'Under 2.5',odds:1.91,isActive:1}]},
   {id:'29',desc:'GG/NG',status:0,outcomes:[{id:'74',desc:'Yes',odds:1.7,isActive:1}]},
   {id:'19',desc:'Home Total',specifier:'total=2.5',status:0,outcomes:[{id:'13',desc:'Under 2.5',odds:1.57,isActive:1}]}
  ]}]}};
 }};
 const parsed=await roll.fixtures(client,now,null,{marketFields:['u25','gg','tu25'],maxOdds:1e12,maxLegOdds:20},6*3600000);
 assert.deepEqual(parsed[0].rows.map(row=>row.field).sort(),['gg','tu25','u25']);
 assert.equal(parsed[0].rows.find(row=>row.field==='tu25').pick,'ATM Under 2.5');
});

test('new markets use the strongest year teams because none were failure-free',()=>{
 assert.equal(roll.rowTeamAllowed({field:'h15',home:'VCF',away:'CHE'}),true);
 assert.equal(roll.rowTeamAllowed({field:'h25',home:'RSO',away:'SUN'}),true);
 assert.equal(roll.rowTeamAllowed({field:'ho05',home:'LIV',away:'RAY'}),true);
 assert.equal(roll.rowTeamAllowed({field:'o15',home:'CHE',away:'FUL'}),true);
 assert.equal(roll.rowTeamAllowed({field:'u25',home:'ALA',away:'NEW'}),true);
 assert.equal(roll.rowTeamAllowed({field:'gg',home:'NEW',away:'RAY'}),true);
 assert.equal(roll.rowTeamAllowed({field:'t05',home:'MCI',away:'GET'}),true);
 assert.equal(roll.rowTeamAllowed({field:'tu15',home:'ESP',away:'CHE'}),true);
 assert.equal(roll.rowTeamAllowed({field:'tu25',home:'LEC',away:'MUN'}),true);
 assert.equal(roll.rowTeamAllowed({field:'o15',home:'SUN',away:'FUL'}),false);
 assert.equal(roll.rowTeamAllowed({field:'h15',home:'MON',away:'FIO'}),true);
});

test('whitelist band uses the first seven markets and banks the stake after 20 wins',()=>{
 assert.equal(roll.BAND.opening,150000);
 assert.equal(roll.BAND.minOdds,1.12);
 assert.equal(roll.BAND.maxOdds,1.19);
 assert.equal(roll.BAND.maxLegs,2);
 assert.equal(roll.bandAllowed({field:'u55',country:'spain',home:'ESP',away:'RMA'}),true);
 assert.equal(roll.bandAllowed({field:'h35',country:'spain',home:'GET',away:'RMA'}),true);
 assert.equal(roll.bandAllowed({field:'u55',country:'italy',home:'FRO',away:'NAP'}),true);
 assert.equal(roll.bandAllowed({field:'h35',country:'italy',home:'LEC',away:'MIL'}),true);
 assert.equal(roll.bandAllowed({field:'o05',country:'england',home:'MCI',away:'FUL'}),true);
 assert.equal(roll.bandAllowed({field:'u45',country:'italy',home:'UDI',away:'NAP'}),true);
 assert.equal(roll.bandAllowed({field:'u55',country:'france',home:'ESP',away:'OLM'}),false);
 assert.equal(roll.bandAllowed({field:'u25',country:'spain',home:'RAY',away:'GET'}),false);
 const won=roll.settle({stake:150000,step:19,takeProfitWins:20,legs:[{field:'o05',odds:1.15}]},[{h:1,a:0}],150000);
 assert.equal(won.banked,true);
 assert.equal(won.nextBalance,150000);
 assert.equal(won.nextStep,0);
 const mid=roll.settle({stake:150000,step:2,takeProfitWins:20,legs:[{field:'o05',odds:1.15}]},[{h:1,a:0}],150000);
 assert.equal(mid.nextStep,3);
 assert.ok(mid.nextBalance>150000);
 const lost=roll.settle({stake:180000,step:4,takeProfitWins:20,legs:[{field:'u55',odds:1.08}]},[{h:3,a:3}],150000);
 assert.equal(lost.status,'Lost');
 assert.equal(lost.nextBalance,150000);
 assert.equal(lost.nextStep,0);
});
