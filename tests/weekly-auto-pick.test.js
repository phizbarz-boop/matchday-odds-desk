'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {selectAutoBet}=require('../lib/autoPicker');
const {ticketSignature}=require('../lib/ticketVariation');
const days=Array.from({length:7},(_,i)=>'2026-11-'+(10+i));
const legs=days.map((ticketDay,i)=>({ticketDay,eventId:String(i),marketId:'1',outcomeId:'1',odds:1.35,probability:78,edge:2,qualityScore:81}));
test('weekly target cannot stop the slip before it covers all seven dates',()=>{
 const outside={...legs[0],eventId:'99',ticketDay:'2026-11-17',odds:9,probability:95};
 const r=selectAutoBet([outside,...legs],{requiredDays:days,targetOdds:1.05,maxSelections:7,trials:50});
 assert.deepEqual(r.selections.map(x=>x.ticketDay).sort(),days);
 assert.equal(new Set(r.selections.map(x=>x.eventId)).size,7);
 assert.equal(r.reachedTarget,true);
});
test('weekly mode rejects missing dates, insufficient leg limits and repeated matches',()=>{
 const picks=(rows,maxSelections)=>selectAutoBet(rows,{requiredDays:days,maxSelections,trials:50}).selections;
 assert.deepEqual(picks(legs.slice(1),7),[]);
 assert.deepEqual(picks(legs,6),[]);
 assert.deepEqual(picks(legs.map((x,i)=>i===6?{...x,eventId:legs[0].eventId}:x),7),[]);
});
test('weekly below-target fallback and regeneration still cover every date',()=>{
 const alternate={...legs[0],eventId:'new',odds:1.45};
 const r=selectAutoBet([...legs,alternate],{requiredDays:days,targetOdds:1000,maxSelections:7,trials:50,excludedTickets:new Set([ticketSignature(legs)])});
 assert.equal(r.reachedTarget,false);
 assert.ok(r.selections.includes(alternate));
 assert.equal(new Set(r.selections.map(x=>x.ticketDay)).size,7);
});

test('highest odds fills the selection limit with the best prices from different matches',()=>{
 const rows=[{...legs[0],odds:4,probability:55},{...legs[0],odds:3.9,probability:56,outcomeId:'2'},{...legs[1],odds:3,probability:60},{...legs[2],odds:1.1,probability:95}];
 const r=selectAutoBet(rows,{highestOdds:true,targetOdds:2,maxSelections:2});
 assert.deepEqual(r.selections.map(x=>x.odds),[4,3]);
 assert.equal(r.combinedOdds,12);
});
test('highest odds still covers every requested date and rejects previously used slips',()=>{
 const stronger={...legs[0],eventId:'new',odds:3};
 const settings={highestOdds:true,requiredDays:days,maxSelections:7,targetOdds:2,trials:50};
 const first=selectAutoBet([...legs,stronger],settings);
 assert.ok(first.selections.includes(stronger));
 const next=selectAutoBet([...legs,stronger],{...settings,excludedTickets:new Set([ticketSignature(first.selections)])});
 assert.equal(next.selections.length,7);
 assert.ok(!next.selections.includes(stronger));
});
