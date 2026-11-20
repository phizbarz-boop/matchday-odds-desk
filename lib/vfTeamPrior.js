'use strict';
const prior=require('./vfTeamPrior.json');
const TEAMS=prior.teams;
function record(name){
 const tokens=String(name||'').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
 for(const token of tokens)if(TEAMS[token])return TEAMS[token];
 return null;
}
function rate(name,field){
 const value=record(name)?.[field];
 return Number.isFinite(value)?value:null;
}
function best(name,field){
 return record(name)?.best?.includes(field)===true;
}
function matchRate(home,away,field){
 const values=[rate(home,field),rate(away,field)].filter(value=>Number.isFinite(value));
 if(!values.length)return null;
 return Math.round(values.reduce((sum,value)=>sum+value,0)/values.length*10)/10;
}
module.exports={rate,best,matchRate,trained:prior};
