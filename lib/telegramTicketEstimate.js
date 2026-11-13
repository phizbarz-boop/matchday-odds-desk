'use strict';

const {winningProbability}=require('./telegramNext12h');

function estimateLine(selections){
 let chance=1,expectedReturn=1,knownChance=true,knownEV=true;
 for(const leg of selections){
  const p=winningProbability(leg)/100;
  const unknownSettlement=leg.fullWinProbability===null&&leg.expectedReturnMultiplier===null;
  if(unknownSettlement||(leg.fullWinProbability??leg.probability)==null||!Number.isFinite(p)||p<0||p>1){
   knownChance=false;knownEV=false;continue;
  }
  chance*=p;
  const multiplier=leg.expectedReturnMultiplier??p*Number(leg.odds);
  if(!Number.isFinite(multiplier)||multiplier<0)knownEV=false;
  else expectedReturn*=multiplier;
 }
 const pct=chance*100,ev=(expectedReturn-1)*100;
 const probability=knownChance?(pct>0&&pct<0.01?'<0.01%':pct.toFixed(2)+'%'):'unavailable';
 const value=knownEV?(ev>0?'+':'')+ev.toFixed(2)+'%':'unavailable';
 return `Est. win chance: ${probability} · Est. ticket EV: ${value} (assuming independent results)`;
}
module.exports={estimateLine};
