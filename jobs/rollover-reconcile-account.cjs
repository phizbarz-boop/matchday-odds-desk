'use strict';

const {decodeAccountSettlement}=require('./rollover-account-settlement.cjs');
const {settle}=require('./rollover-run-state.cjs');

// Call with the signed-in order detail and independently verified final
// scores. Only a recognized settlement can advance the rollover ledger.
function reconcileAccount(state,orderDetail,finalResults,now=Date.now()){
 const outcome=decodeAccountSettlement(orderDetail,state.pending,finalResults);
 if(outcome.state!=='settled')return {...outcome,stateAfter:state};
 return {...outcome,stateAfter:settle(state,outcome.settlement,now)};
}
module.exports={reconcileAccount};
