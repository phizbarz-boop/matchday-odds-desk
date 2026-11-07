'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const M=require('../lib/footballExtraMarkets'),bot=require('../lib/telegramAiBot');
const row=(name,line,side='Under')=>({sport:'Football',eventId:'e',marketId:'m',marketDesc:name,outcomeId:side,specifier:'total='+line,outcomeDesc:side+' '+line,odds:side==='Under'?1.5:2.8});
test('first-half bookings exact lines, scopes and two-sided model',()=>{
 for(const line of [2.5,3.5]){const id=line===2.5?'first_half_bookings_under25':'first_half_bookings_under35';
 for(const name of ['1st Half - Total Bookings Over/Under','First Half Bookings']){assert.equal(M.betTypeFor(row(name,line)),id);const out=require('../lib/offeredMarketModel').modelOfferedMarkets([row(name,line),row(name,line,'Over')],{minEdge:-100}).candidates;assert.ok(out.some(c=>c.betType===id&&c.probability>0));}
 assert.equal(M.betTypeFor(row('Total Bookings',line)),null);assert.equal(M.betTypeFor(row('1st Half Home Team Bookings',line)),null);assert.equal(M.betTypeFor(row('1st Half Bookings',line,'Over')),null);
 assert.ok(bot.allowedBetIdsForPlan('pro').includes(id));assert.deepEqual(bot.parseNaturalRequest('build football first half bookings under '+line).betTypes,[id]);
 }
 assert.equal(M.betTypeFor(row('1st Half Bookings',4.5)),null);
});
test('removed options are absent from website menus and bot entitlements',()=>{const s=require('node:fs').readFileSync(require.resolve('../public/index.html'),'utf8');for(const id of M.REMOVED_IDS){assert.ok(!s.includes("{id:'"+id+"'"));assert.ok(!bot.allowedBetIdsForPlan('elite').includes(id));assert.equal(require('../lib/streakGoalModel').expandedSelectionAllowed({betType:id},[id],true),false);}assert.ok(!require('../lib/telegramFloorPicks').PLANS.some(p=>p.betTypes?.some(id=>M.REMOVED_IDS.includes(id))));assert.ok(!require('../lib/multiPick').matches({sport:'Football',betType:'first5_goals_under05'},.1));});
test('generic extra markets cannot reintroduce removed under lines and correct scores',()=>{for(const c of [row('Total Offsides Over/Under',4.5),row('Total Offsides Over/Under',5.5),row('Total Goals Over/Under - 1-5 Minutes',.5),row('Total Goals, Minutes 1-10',.5),row('Total Goals, Minutes 1-20',.5),row('Correct Score',.5)])assert.equal(M.removedSelection(c),true);assert.equal(M.removedSelection(row('Away Team Offsides',.5,'Over')),false);});
