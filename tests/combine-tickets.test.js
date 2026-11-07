'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('../lib/combineTickets');
const leg=(id,extra={})=>({eventId:id,marketId:'17',outcomeId:'away',specifier:'total=0.5|player=7',marketDesc:'Player Goals',outcomeDesc:'Under 0.5',home:'A',away:'B',odds:1.4,...extra});
const normalize=c=>({...c});
const load=tickets=>({getBooking:async code=>tickets[code],normalize});
test('two or three tickets preserve exact market, player and line; duplicates count once',async()=>{
 const result=await C.preview('aaa1 bbb2 ccc3',load({AAA1:{selections:[leg('1'),leg('2')]},BBB2:{selections:[leg('1',{specifier:'player=7|total=0.5'}),leg('3')]},CCC3:{selections:[leg('4')]}}));
 assert.equal(result.selections.length,4);
 assert.equal(result.duplicatesRemoved,1);
 assert.equal(result.selections[0].marketId,'17');
 assert.equal(result.selections[0].specifier,'player=7|total=0.5');
 assert.equal(result.selections[0].outcomeId,'away');
 assert.ok(Math.abs(result.combinedOdds-1.4**4)<1e-10);
});
test('same fixture with another outcome, market or player is rejected instead of silently replaced',async()=>{
 for(const extra of [{outcomeId:'over'},{marketId:'18'},{specifier:'player=8|total=0.5'}]){
  await assert.rejects(C.preview(['AAA1','BBB2'],load({AAA1:{selections:[leg('1')]},BBB2:{selections:[leg('1',extra)]}})),/same match has different selections/);
 }
});
test('50 games are allowed; 51 and unreadable identities are rejected',async()=>{
 const rows=Array.from({length:50},(_,i)=>leg(String(i)));
 assert.equal((await C.preview(['AAA1','BBB2'],load({AAA1:{selections:rows.slice(0,25)},BBB2:{selections:rows.slice(25)}}))).selections.length,50);
 await assert.rejects(C.preview(['AAA1','BBB2'],load({AAA1:{selections:rows},BBB2:{selections:[leg('51')]}})),/at most 50/);
 await assert.rejects(C.preview(['AAA1','BBB2'],load({AAA1:{selections:[leg('1')]},BBB2:{selections:[leg('2',{outcomeId:''})]}})),/incomplete/);
});
test('source failures and empty tickets never produce a partial merge',async()=>{
 await assert.rejects(C.preview(['AAA1','BBB2'],{normalize,getBooking:async code=>{if(code==='BBB2')throw Error('source unavailable');return {selections:[leg('1')]};}}),/source unavailable/);
 await assert.rejects(C.preview(['AAA1','BBB2'],load({AAA1:{selections:[leg('1')]},BBB2:{selections:[]}})),/could not read/);
});
test('input validation rejects duplicate codes and supports an unknown price without inventing odds',async()=>{
 assert.throws(()=>C.codes('AAA1'),/two or three/);
 assert.throws(()=>C.codes('AAA1 aaa1'),/different/);
 assert.throws(()=>C.codes('AAA1 BBB2 CCC3 DDD4'),/two or three/);
 const result=await C.preview(['AAA1','BBB2'],load({AAA1:{selections:[leg('1')]},BBB2:{selections:[leg('2',{odds:null})]}}));
 assert.equal(result.combinedOdds,null);
});
