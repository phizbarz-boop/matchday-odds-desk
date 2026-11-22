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
