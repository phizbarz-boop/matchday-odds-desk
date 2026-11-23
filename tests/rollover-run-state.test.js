'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rules=require('../jobs/rollover-run-state.cjs');

test('a restarted run drops the old stake and starts at ₦5,000',()=>{
 const saved={day:rules.initial().day,consecutiveLosses:0,wins:4,stakeKobo:900000,netKobo:700000,run:3,
  runOpeningStakeKobo:500000,awaitingReset:false,pending:{id:'OLD',stakeKobo:900000},lastSettled:null};
 const next=rules.beginRun(saved);
 assert.equal(next.stakeKobo,500000);
 assert.equal(next.runOpeningStakeKobo,500000);
 assert.equal(next.wins,0);
 assert.equal(next.pending,null);
 assert.equal(next.awaitingReset,false);
});

test('the whitelist band returns to ₦5,000 after a loss and after 20 wins',()=>{
 const ruleset=rules.BAND_RULES;
 const open=rules.initial(Date.now(),ruleset);
 assert.equal(open.stakeKobo,500000);
 const lost=rules.settle({...open,pending:{id:'B1',stakeKobo:500000}},{id:'B1',status:'lost',payoutKobo:0},Date.now(),ruleset);
 assert.equal(lost.stakeKobo,500000);
 assert.equal(lost.wins,0);
 assert.equal(lost.awaitingReset,false);
 const kept=rules.settle({...open,pending:{id:'B3',stakeKobo:500000}},{id:'B3',status:'won',payoutKobo:575000},Date.now(),ruleset);
 assert.equal(kept.stakeKobo,522500);
 assert.equal(kept.lastSettled.takenKobo,52500);
 assert.equal(kept.wins,1);
 let state={...open,wins:19,stakeKobo:400000,pending:{id:'B2',stakeKobo:400000},runOpeningStakeKobo:500000};
 state=rules.settle(state,{id:'B2',status:'won',payoutKobo:460000},Date.now(),ruleset);
 assert.equal(state.stakeKobo,500000);
 assert.equal(state.wins,0);
});
