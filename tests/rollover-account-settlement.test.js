'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {decodeAccountSettlement}=require('../jobs/rollover-account-settlement.cjs');

function body(selectionSettled){
 return {bizCode:10000,data:[{orderId:'ORD1',currency:'NGN',stake:20000000,isSettled:1,winnings:0,status:0,
  isUseGift:false,paymentType:0,longTaxAmount:0,taxAmount:'0.00',cashOutHistorys:[],
  selections:[{eventId:'sr:match:1',marketId:'18',outcomeId:'13',specifier:'total=4.5',isSettled:selectionSettled}],
  combinations:[{status:0,winnings:0}]}]};
}
const pending={id:'ORD1',stakeKobo:200000};

test('a finished zero payout is a loss even without a separate score',()=>{
 const settled=decodeAccountSettlement(body(0),pending,[]);
 assert.equal(settled.state,'settled');
 assert.equal(settled.settlement.status,'lost');
 assert.equal(settled.settlement.payoutKobo,0);
});

test('an open order is not called a loss',()=>{
 const open=body(0);
 open.data[0].isSettled=0;
 assert.equal(decodeAccountSettlement(open,pending,[]).state,'pending');
});
