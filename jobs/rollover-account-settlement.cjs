'use strict';

const ORDER_DETAIL_PATH='/api/ng/realSportsGame/order';

function decimalKobo(value){
 if(typeof value!=='string'||!/^\d+\.\d{2}$/.test(value))return null;
 const parsed=Number(value.replace('.',''));
 return Number.isSafeInteger(parsed)?parsed:null;
}
function orderAmountKobo(value){
 // The captured NGN order uses 10,000 units per naira, not kobo.
 return Number.isSafeInteger(value)&&value>=0&&value%100===0?value/100:null;
}

// Decode only a response fetched by the signed-in browser for this exact
// order. Do not persist full account responses or replay HAR credentials.
function decodeAccountSettlement(body,pending,finalResults=[]){
 const result=(state,reason)=>({state,reason});
 if(typeof pending?.id!=='string'||!pending.id.trim()||
    !Number.isSafeInteger(pending.stakeKobo)||pending.stakeKobo<=0)
  return result('unverified','invalid_pending_order');
 if(body?.bizCode!==10000||!Array.isArray(body.data))
  return result('unverified','account_order_response_invalid');
 const orders=body.data.filter(row=>row?.orderId===pending.id);
 if(orders.length!==1)return result('unverified','account_order_not_unique');
 const order=orders[0];
 if(order.currency!=='NGN'||orderAmountKobo(order.stake)!==pending.stakeKobo)
  return result('unverified','account_stake_or_currency_mismatch');
 if(order.isSettled===0)return result('pending','account_order_unsettled');
 if(order.isSettled!==1||!Array.isArray(order.selections)||!order.selections.length)
  return result('unverified','account_settlement_flags_unverified');
 const payoutKobo=orderAmountKobo(order.winnings);
 const combo=Array.isArray(order.combinations)&&order.combinations.length===1?order.combinations[0]:null;
 if(!combo||decimalKobo(combo.stake)!==pending.stakeKobo||
    payoutKobo===null||decimalKobo(combo.winnings)!==payoutKobo)
  return result('unverified','account_payout_mismatch');
 // SportyBet can show the winning payout before every selection flag flips.
 // Waiting here misses the next ticket. A matched winning payout is enough.
 if(payoutKobo>pending.stakeKobo&&order.status===1&&combo.status===1&&
    order.isUseGift===false&&order.paymentType===0&&order.longTaxAmount===0&&
    decimalKobo(order.taxAmount)===0&&Array.isArray(order.cashOutHistorys)&&!order.cashOutHistorys.length)
  return {state:'settled',settlement:{id:pending.id,status:'won',payoutKobo}};
 if(payoutKobo!==0&&!order.selections.every(row=>row?.isSettled===1))
  return result('unverified','account_selection_settlement_flags_unverified');
 // Some zero-return tickets omit optional tax and cash-out fields.
 // Keep the strict checks for paid returns and reject explicit adjustments.
 const optionalZero=(value,isZero)=>value==null||isZero(value);
 const zeroReturnAdjustmentsOk=(order.isUseGift==null||order.isUseGift===false)&&order.paymentType===0&&
  optionalZero(order.longTaxAmount,v=>v===0||v==='0')&&
  optionalZero(order.taxAmount,v=>v===0||v==='0'||decimalKobo(v)===0)&&
  optionalZero(order.cashOutHistorys,v=>Array.isArray(v)&&v.length===0);
 if(payoutKobo===0?!zeroReturnAdjustmentsOk:
    (order.isUseGift!==false||order.paymentType!==0||order.longTaxAmount!==0||
     decimalKobo(order.taxAmount)!==0||!Array.isArray(order.cashOutHistorys)||order.cashOutHistorys.length))
  return result('unverified','gift_tax_or_cashout_requires_reconciliation');
 if(payoutKobo===0){
  // The whole order can settle as lost while other legs are still running.
  // Independent official results, keyed by event ID. A conflicting or
  // duplicate result is not evidence. Never infer a loss from odds alone.
  if(order.status===1||combo.status===1)
   return result('unverified','account_status_conflicts_with_zero_payout');
  if(!hasVerifiedLosingSelection(order.selections,finalResults))
   return result('unverified','zero_payout_without_verified_losing_selection');
  return {state:'settled',settlement:{id:pending.id,status:'lost',payoutKobo:0}};
 }
 // Only the winning status was captured. Leave other results unresolved.
 if(order.status!==1||combo.status!==1||payoutKobo<=pending.stakeKobo)
  return result('unverified','account_result_status_not_mapped');
 return {state:'settled',settlement:{id:pending.id,status:'won',payoutKobo}};
}
function hasVerifiedLosingSelection(selections,finalResults){
 if(!Array.isArray(finalResults))return false;
 return selections.some(leg=>{
  if(typeof leg?.eventId!=='string'||!leg.eventId.trim()||String(leg.marketId)!=='18')return false;
  const records=finalResults.filter(record=>record?.eventId===leg.eventId);
  if(records.length!==1)return false;
  const {status,homeGoals,awayGoals}=records[0];
  if(status!=='final'||![homeGoals,awayGoals].every(n=>Number.isSafeInteger(n)&&n>=0))return false;
  const total=homeGoals+awayGoals;
  if(!Number.isSafeInteger(total))return false;
  const key=leg.specifier+':'+leg.outcomeId;
  if(key==='total=0.5:12')return total===0;
  if(key==='total=1.5:12')return total<=1;
  if(key==='total=4.5:13')return total>=5;
  if(key==='total=5.5:13')return total>=6;
  return false;
 });
}
module.exports={ORDER_DETAIL_PATH,decodeAccountSettlement};
