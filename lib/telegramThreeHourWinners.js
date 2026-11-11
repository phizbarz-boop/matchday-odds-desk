'use strict';
const {watParts}=require('./watScheduler');
const {WINNERS}=require('./telegramFloorPicks');
const TIMES=Array.from({length:4},(_,i)=>String(i*6).padStart(2,'0')+':00');
const NAMESPACE='telegram:six-hour-winners:v1';
const PLANS=[{id:'sixHourWinners70',label:'EVERY 6H · 3.00x TARGET · ALL SPORTS WINNERS · 70% · HIGHEST ODDS · UP TO 10',betTypes:WINNERS,highestOdds:true,floor:70,targetOdds:3,maxGames:10,kickoffByTomorrow:true}];
function resolveSlot(headers,now=new Date()){
 if(headers['x-matchday-run-mode']==='manual')return require('./telegramThreeHourSafe').resolveSlot(headers,now);
 const {date,minute}=watParts(now),slotTime=TIMES[Math.floor(minute/360)];
 return {dateKey:date,slotKey:date+'T'+slotTime,slotTime,manualTest:false};
}
module.exports={TIMES,NAMESPACE,PLANS,resolveSlot};
