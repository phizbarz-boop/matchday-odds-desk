'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rules=require('../jobs/rollover-run-state.cjs');

test('a restarted run drops the old stake and starts at ₦2,000',()=>{
 const saved={day:rules.initial().day,consecutiveLosses:0,wins:4,stakeKobo:900000,netKobo:700000,run:3,
  runOpeningStakeKobo:500000,awaitingReset:false,pending:{id:'OLD',stakeKobo:900000},lastSettled:null};
 const next=rules.beginRun(saved);
 assert.equal(next.stakeKobo,200000);
 assert.equal(next.runOpeningStakeKobo,200000);
 assert.equal(next.wins,0);
 assert.equal(next.pending,null);
 assert.equal(next.awaitingReset,false);
});

test('the whitelist band returns to ₦1,500 after a loss and after 20 wins',()=>{
 const ruleset=rules.BAND_RULES;
 const open=rules.initial(Date.now(),ruleset);
 assert.equal(open.stakeKobo,150000);
 const lost=rules.settle({...open,pending:{id:'B1',stakeKobo:150000}},{id:'B1',status:'lost',payoutKobo:0},Date.now(),ruleset);
 assert.equal(lost.stakeKobo,150000);
 assert.equal(lost.wins,0);
 assert.equal(lost.awaitingReset,false);
 let state={...open,wins:19,stakeKobo:400000,pending:{id:'B2',stakeKobo:400000},runOpeningStakeKobo:150000};
 state=rules.settle(state,{id:'B2',status:'won',payoutKobo:460000},Date.now(),ruleset);
 assert.equal(state.stakeKobo,150000);
 assert.equal(state.wins,0);
});
