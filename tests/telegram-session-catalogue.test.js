'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {PLANS,eligible,buildPack}=require('../lib/telegramFloorPicks');
const {currentCodes,sessionStart}=require('../lib/telegramCodeSession');
const now=new Date('2026-10-31T08:00:00Z');
const base={eventId:'e',sport:'football',kickoffUtc:'2026-11-01T12:00:00Z',odds:1.3,probability:80,outcomeId:'1'};
test('long shots exclude totals, corners, shots and handicaps at fresh validation',()=>{
 for(const p of PLANS.filter(p=>p.longShot))for(const c of [{betType:'over25'},{betType:'basketball_under'},{betType:'offered:18',marketDesc:'1st Half - Over/Under'},{betType:'offered:19',specifier:'total=12.5'},{betType:'corners_under125'},{betType:'shots_target_under135'},{betType:'ah_0'}])assert.equal(eligible({...base,...c},p,now,'2026-10-31',new Set()),false);
 assert.ok(!PLANS.some(p=>p.sport==='tennis'||p.sport==='hockey'&&!p.hockeyHighestUnder));
});
test('combo tickets preserve exact type, 60 floor, three odds and at most six games',()=>{
 for(const type of ['dc_under45','home_away_under45']){
 const rows=Array.from({length:15},(_,i)=>({...base,eventId:type+i,marketId:type,betType:type,probability:i===0?59:65}));
 const p=buildPack(rows,{now}).plans.find(p=>p.betTypes?.[0]===type);
 assert.ok(p.selections.length>0&&p.selections.length<=6);assert.ok(p.selections.reduce((n,c)=>n*c.odds,1)>=3);assert.ok(p.selections.every(c=>c.betType===type&&c.probability>=60));
 }
});
test('1UP long shot excludes the ordinary draw selection',()=>{const p=PLANS.find(p=>p.id==='oneup70long');assert.equal(eligible({...base,betType:'oneup'},p,now,'2026-10-31',new Set()),true);assert.equal(eligible({...base,betType:'oneup_extended',outcomeId:'2'},p,now,'2026-10-31',new Set()),false);});
test('morning includes 06 WAT codes; 18 WAT replaces morning and keeps later three-hour codes',()=>{
 const codes=['04:59','05:00','06:00','17:00','20:00'].map((t,i)=>({shareCode:String(i),generatedAt:'2026-10-31T'+t+':00Z'}));
 assert.deepEqual(currentCodes(codes,new Date('2026-10-31T06:30:00Z')).map(c=>c.shareCode),['1','2']);
 assert.deepEqual(currentCodes(codes,new Date('2026-10-31T20:01:00Z')).map(c=>c.shareCode),['3','4']);
 assert.equal(new Date(sessionStart(new Date('2026-11-01T01:00:00Z'))).toISOString(),'2026-10-31T17:00:00.000Z');
 assert.equal(currentCodes([{shareCode:'legacy'}],now).length,0);
});
