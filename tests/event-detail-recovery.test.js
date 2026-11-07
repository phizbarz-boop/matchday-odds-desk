'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createEventDetailReader}=require('../lib/eventDetailRecovery');
const unknown=()=>Object.assign(Error('routes unavailable'),{code:'SPORTYBET_ENDPOINT_UNKNOWN'});
test('public detail read recovers GET-to-POST and remembers a working method',async()=>{
 const calls=[],read=createEventDetailReader({stamp:()=>123,read:async options=>{calls.push(options);if(options.method==='GET')throw unknown();return {data:{eventId:options.body.eventId}};}});
 await read('a');await read('b');assert.deepEqual(calls.map(x=>x.method),['GET','POST','POST']);assert.equal(calls[0].params.eventId,'a');assert.equal(calls[0].params._t,123);assert.deepEqual(calls[1].body,{eventId:'a'});assert.ok(calls.every(x=>x.publicRead===true));
});
test('configured POST supports GET recovery and does not confuse fixtures',async()=>{
 const calls=[],read=createEventDetailReader({method:'POST',paramName:'matchId',read:async options=>{calls.push(options);if(options.method==='POST')throw unknown();return {data:{event:{eventId:options.params.matchId}}};}});
 await read('e');assert.deepEqual(calls.map(x=>x.method),['POST','GET']);assert.equal(calls[1].params.matchId,'e');
 const wrong=createEventDetailReader({read:async()=>({data:{eventId:'another'}})});await assert.rejects(wrong('e'),{code:'SPORTYBET_EVENT_MISMATCH'});
});
test('no method fanout on rate limits, challenge, network error or timeout',async()=>{
 for(const code of ['SPORTYBET_TIMEOUT','SPORTYBET_NETWORK','SPORTYBET_GEO_BLOCKED','SPORTYBET_BOT_CHALLENGE']){let calls=0;const read=createEventDetailReader({read:async()=>{calls++;throw Object.assign(Error(code),{code});}});await assert.rejects(read('e'),{code});assert.equal(calls,1);}
});
test('both failed methods report unavailable and next fixture can still succeed',async()=>{
 let broken=true;const calls=[],read=createEventDetailReader({read:async o=>{calls.push(o);if(broken)throw unknown();return {data:{eventId:o.params.eventId}};}});
 await assert.rejects(read('old'),{code:'SPORTYBET_ENDPOINT_UNKNOWN'});broken=false;await read('next');assert.equal(calls.length,3);
});
test('current listing outcomes survive a failed detail scan without reusing stale prices',async()=>{
 const sporty=require('../lib/sportybet'),scan=require('../lib/expandedMarketScan'),oldBase=sporty.getFootballMarket,oldScan=scan.scanExpandedMarkets;
 const kickoffUtc=new Date(Date.now()+3600000).toISOString(),base={sport:'Football',eventId:'e',home:'Home',away:'Away',marketId:'m',marketDesc:'1st Half Bookings',specifier:'total=2.5',kickoffUtc};
 sporty.getFootballMarket=async()=>({rows:[{...base,outcomeId:'under',outcomeDesc:'Under 2.5',odds:1.5},{...base,outcomeId:'over',outcomeDesc:'Over 2.5',odds:2.8}]});
 scan.scanExpandedMarkets=async()=>({rows:[],errors:{e:'SPORTYBET_ENDPOINT_UNKNOWN'},coverage:{detailReads:0,partial:true}});
 try{const rows=await require('../lib/footballExtraMarkets').collect({betTypes:['first_half_bookings_under25'],minEdge:-100});assert.equal(rows.length,1);assert.equal(rows[0].odds,1.5);assert.equal(rows.sourceErrors.e,'SPORTYBET_ENDPOINT_UNKNOWN');}finally{sporty.getFootballMarket=oldBase;scan.scanExpandedMarkets=oldScan;}
});
