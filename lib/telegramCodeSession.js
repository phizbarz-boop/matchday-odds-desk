'use strict';
// A display window only: the durable code archive and settlement history remain.
function sessionStart(now=new Date()){
 const local=new Date(+now+3600000),date=local.toISOString().slice(0,10),hour=local.getUTCHours();
 const start=Date.parse(date+(hour>=18?'T17:00:00Z':'T05:00:00Z'));
 return hour<6?start-12*3600000:start;
}
function currentCodes(codes,now=new Date()){
 const start=sessionStart(now);
 const midnight=Math.floor((+now+3600000)/86400000)*86400000-3600000;
 return codes.filter(c=>{const time=Date.parse(c.generatedAt||'');return Number.isFinite(time)&&time>=(String(c.targetOdds||'').startsWith('MODEL FLOOR · TODAY 10,000+')?midnight:start)&&time<=+now;});
}
module.exports={sessionStart,currentCodes};
