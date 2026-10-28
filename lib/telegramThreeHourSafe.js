'use strict';
const {watParts}=require('./watScheduler'),{normalizedSport}=require('./telegramMixedSelector'),{bestProbabilityTicket,ticketSignature}=require('./telegramNext12h');
const TIMES=Array.from({length:8},(_,i)=>String(i*3).padStart(2,'0')+':00');
const PLANS=Array.from({length:4},(_,i)=>({id:'safe3'+String.fromCharCode(97+i),label:'EVERY 3H · 3 ODDS '+String.fromCharCode(65+i),floor:70,minGames:6,maxGames:10,targetOdds:3,finishWithinHours:3}));
function finishesInWindow(c,now,plan={finishWithinHours:3}){
 const start=Date.parse(c.kickoffUtc||''),limit=Date.parse(plan.windowEndsAt||'')||+now+plan.finishWithinHours*3600000;if(c.live||!Number.isFinite(start)||start<=+now+60000||start>=limit)return false;
 const explicit=c.endTimeUtc||c.finishUtc||c.scheduledEndUtc;const duration={football:135,basketball:150,hockey:180,handball:120,volleyball:180}[normalizedSport(c)];
 const end=explicit?Date.parse(explicit):duration?start+duration*60000:NaN;
 return Number.isFinite(end)&&end>start&&end<=limit;
}
function buildPack(pool,{now=new Date(),dateKey=watParts(now).date}={}){const {eligible}=require('./telegramFloorPicks'),excludedTickets=new Set(),end=new Date(+now+3*3600000).toISOString(),plans=[];
 for(const template of PLANS){const plan={...template,windowEndsAt:end},available=pool.filter(c=>eligible(c,plan,now,dateKey,new Set()));const pick=bestProbabilityTicket(available,3,{minSelections:6,maxSelections:10,excludedTickets});const selections=pick.reachedTarget?pick.selections:[];if(selections.length)excludedTickets.add(ticketSignature(selections));plans.push({...plan,selections,alternatives:[],combinedOdds:pick.combinedOdds});}return {dateKey,plans};}
function resolveSlot(headers,now=new Date()){const p=watParts(now),manualTest=headers['x-matchday-run-mode']==='manual';if(manualTest){const id=String(headers['x-matchday-run-id']||'');if(!/^[a-zA-Z0-9_-]{1,160}$/.test(id))throw Error('A valid manual run ID is required');return {dateKey:p.date,slotKey:p.date+'Tmanual-'+id,slotTime:String(Math.floor(p.minute/60)).padStart(2,'0')+':'+String(p.minute%60).padStart(2,'0'),manualTest:true};}const slotTime=TIMES[Math.floor(p.minute/180)];return {dateKey:p.date,slotKey:p.date+'T'+slotTime,slotTime,manualTest:false};}
module.exports={TIMES,PLANS,finishesInWindow,buildPack,resolveSlot};
