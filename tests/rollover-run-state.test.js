'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rules=require('../jobs/rollover-run-state.cjs');

test('a restarted run drops the old stake and starts at ₦2,000',()=>{
 const saved={day:rules.initial().day,consecutiveLosses:0,wins:4,stakeKobo:900000,netKobo:700000,run:3,
  runOpeningStakeKobo:200000,awaitingReset:false,pending:{id:'OLD',stakeKobo:900000},lastSettled:null};
 const next=rules.beginRun(saved);
 assert.equal(next.stakeKobo,200000);
 assert.equal(next.runOpeningStakeKobo,200000);
 assert.equal(next.wins,0);
 assert.equal(next.pending,null);
 assert.equal(next.awaitingReset,false);
});

test('the whitelist band returns to ₦2,000 after a loss and after 5 wins',()=>{
 const ruleset=rules.BAND_RULES;
 const open=rules.initial(Date.now(),ruleset);
 assert.equal(open.stakeKobo,200000);
 const lost=rules.settle({...open,pending:{id:'B1',stakeKobo:200000}},{id:'B1',status:'lost',payoutKobo:0},Date.now(),ruleset);
 assert.equal(lost.stakeKobo,200000);
 assert.equal(lost.wins,0);
 assert.equal(lost.awaitingReset,false);
 const kept=rules.settle({...open,pending:{id:'B3',stakeKobo:200000}},{id:'B3',status:'won',payoutKobo:230000},Date.now(),ruleset);
 assert.equal(kept.stakeKobo,209000);
 assert.equal(kept.lastSettled.takenKobo,21000);
 assert.equal(kept.wins,1);
 let state={...open,wins:4,stakeKobo:209000,pending:{id:'B2',stakeKobo:209000},runOpeningStakeKobo:200000};
 state=rules.settle(state,{id:'B2',status:'won',payoutKobo:240000},Date.now(),ruleset);
 assert.equal(state.stakeKobo,200000);
 assert.equal(state.wins,0);
});
