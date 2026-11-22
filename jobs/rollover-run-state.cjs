'use strict';

// State transitions only. The caller must persist state and supply verified
// SportyBet receipts and actual credited payouts, never estimated returns.
const RULES=Object.freeze({openingStakeKobo:200000,targetTicketWins:5,maxConsecutiveLosses:4,minOdds:1.15,maxOdds:1.55,maxLegs:2,
 markets:Object.freeze(['Over 0.5','Under 4.5','Under 5.5','1st Half Under 3.5','Halftime Under 3.5']),timeZone:'Africa/Lagos'});
const BAND_RULES=Object.freeze({openingStakeKobo:150000,targetTicketWins:20,maxConsecutiveLosses:1,resetEveryLoss:true,minOdds:1.12,maxOdds:1.19,maxLegs:2,
 markets:RULES.markets,timeZone:RULES.timeZone});
const dateFormat=new Intl.DateTimeFormat('en-CA',{timeZone:RULES.timeZone,year:'numeric',month:'2-digit',day:'2-digit'});
const dayOf=now=>dateFormat.format(new Date(now));
const money=value=>Number.isSafeInteger(value)&&value>=0;
function beginRun(state,now=Date.now()){
 const next=refresh({...state,pending:null,awaitingReset:false},now);
 return {...next,consecutiveLosses:0,wins:0,stakeKobo:RULES.openingStakeKobo,
  runOpeningStakeKobo:RULES.openingStakeKobo,awaitingReset:false,pending:null,run:(Number(next.run)||0)+1};
}
function initial(now=Date.now(),rules=RULES){
 return {day:dayOf(now),consecutiveLosses:0,wins:0,stakeKobo:rules.openingStakeKobo,netKobo:0,
  run:1,runOpeningStakeKobo:rules.openingStakeKobo,awaitingReset:false,pending:null,lastSettled:null};
}
function refresh(state,now=Date.now(),rules=RULES){
 const day=dayOf(now);
 const next={...state};
 const newDay=next.day!==day;
 const legacy=!Number.isSafeInteger(next.consecutiveLosses);
 if(legacy)next.consecutiveLosses=next.lastSettled?.status==='lost'?1:0;
 if(newDay)Object.assign(next,{day,consecutiveLosses:0,netKobo:0});
 if(next.awaitingReset&&!next.pending&&(newDay||legacy))Object.assign(next,{awaitingReset:false,
  wins:0,stakeKobo:rules.openingStakeKobo,runOpeningStakeKobo:rules.openingStakeKobo,run:next.run+1});
 if(!next.pending&&!next.awaitingReset&&next.wins>=rules.targetTicketWins)
  Object.assign(next,{wins:0,stakeKobo:rules.openingStakeKobo,runOpeningStakeKobo:rules.openingStakeKobo,run:next.run+1});
 return next;
}
function acceptReceipt(state,ticket,now=Date.now(),rules=RULES){
 const next=refresh(state,now,rules);
 if(next.pending||next.awaitingReset)throw Error('Rollover is waiting for settlement or a new day');
 if(typeof ticket?.id!=='string'||!ticket.id.trim()||ticket.id===next.lastSettled?.id||
    ticket.stakeKobo!==next.stakeKobo)throw Error('Receipt does not match the next rollover stake');
 return {...next,pending:{id:ticket.id,stakeKobo:ticket.stakeKobo}};
}
function settle(state,result,now=Date.now(),rules=RULES){
 const next=refresh(state,now,rules);
 if(!next.pending||next.pending.id!==result?.id)throw Error('Settlement does not match the pending ticket');
 const {status,payoutKobo}=result,{stakeKobo}=next.pending;
 const partial=status==='partial'&&payoutKobo>0&&payoutKobo<stakeKobo;
 if(!money(payoutKobo)||!(
   (status==='lost'&&payoutKobo===0)||
   (status==='won'&&payoutKobo>stakeKobo)||
   (status==='void'&&payoutKobo===stakeKobo)||partial))throw Error('Settlement or credited payout is not verified');
 const profitKobo=payoutKobo-stakeKobo;
 next.netKobo+=profitKobo;
 next.pending=null;
 if(status==='won'){next.wins++;next.consecutiveLosses=0;}
 else if(status==='lost')next.consecutiveLosses++;
 const completed=status==='won'&&next.wins>=rules.targetTicketWins;
 const runEnded=completed||status==='lost';
 next.lastSettled={id:result.id,status,stakeKobo,payoutKobo,profitKobo,ticketWins:next.wins,run:next.run,
  runNetKobo:runEnded?payoutKobo-(next.runOpeningStakeKobo??rules.openingStakeKobo):null,endReason:completed?'target_reached':status==='lost'?'lost':null};
 next.stakeKobo=payoutKobo;
 if(runEnded){
  if(!rules.resetEveryLoss&&next.consecutiveLosses>=rules.maxConsecutiveLosses)next.awaitingReset=true;
  else Object.assign(next,{wins:0,run:next.run+1,stakeKobo:rules.openingStakeKobo,runOpeningStakeKobo:rules.openingStakeKobo});
 }
 return next;
}
module.exports={RULES,BAND_RULES,initial,refresh,acceptReceipt,settle,beginRun};
