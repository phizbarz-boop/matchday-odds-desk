'use strict';
// Independent Daily 5x ticket constructor. Does not alter any upstream probability model.
const {winningProbability,ticketSignature}=require('./telegramNext12h');
const {normalizedSport}=require('./telegramMixedSelector');
const WINNER_TYPES=new Set(['tennis_winner','handball_winner','volleyball_winner','hockey_winner']);
const WINNER_SPORTS=new Set(['tennis','handball','volleyball','hockey']);
function modeAllowed(c,mode){return mode!=='winners'||(WINNER_TYPES.has(c.betType)&&WINNER_SPORTS.has(normalizedSport(c)));}
const TARGET=5, FLOOR=70, MIN_ODDS=4.9, MAX_ODDS=5.5, MAX_LEGS=12;
function valid(c,now){const t=Date.parse(c.kickoffUtc||'');const p=winningProbability(c),o=Number(c.odds);
 return c.live!==true&&Number.isFinite(t)&&t>now.getTime()+60000&&Number.isFinite(p)&&p>=FLOOR&&p<=100&&Number.isFinite(o)&&o>1&&o<=MAX_ODDS&&c.h2hCheck?.allowed!==false;}
function metrics(legs){const odds=legs.reduce((v,c)=>v*Number(c.odds),1),probability=legs.reduce((v,c)=>v*winningProbability(c)/100,1);
 return {combinedOdds:odds,estimatedTicketProbability:probability*100,estimatedEV:odds*probability-1,breakEvenProbability:100/odds,independenceAssumption:true};}
function build(candidates,{now=new Date(),excludedTickets=new Set(),maxLegs=MAX_LEGS,mode="mixed"}={}){
 const rows=candidates.filter(c=>valid(c,now)&&modeAllowed(c,mode)&&!require('./isSimFixture').product(c)&&!require('./footballExtraMarkets').removedSelection(c))
  .sort((a,b)=>winningProbability(b)-winningProbability(a)||Number(a.odds)-Number(b.odds));
 const grouped=new Map();for(const c of rows){const k=String(c.eventId);if(!grouped.has(k))grouped.set(k,[]);if(grouped.get(k).length<4)grouped.get(k).push(c);}
 // Bounded beam search: one outcome per fixture; optimize probability then proximity to 5x.
 let beam=[{legs:[],odds:1,prob:1}],best=null;
 for(const options of grouped.values()){
  const next=beam.slice();
  for(const state of beam)for(const c of options){if(state.legs.length>=maxLegs)continue;
   const odds=state.odds*Number(c.odds);if(odds>MAX_ODDS+1e-9)continue;
   const node={legs:[...state.legs,c],odds,prob:state.prob*winningProbability(c)/100};
   if(odds>=MIN_ODDS&&odds>=TARGET-0.1&&!excludedTickets.has(ticketSignature(node.legs))){
    const m=metrics(node.legs);if(m.estimatedEV>0&&(!best||node.prob>best.prob+1e-12||(Math.abs(node.prob-best.prob)<1e-12&&Math.abs(odds-TARGET)<Math.abs(best.odds-TARGET))))best=node;
   }else if(odds<MIN_ODDS)next.push(node);
  }
  const bins=new Map();for(const n of next){const key=Math.floor(Math.log(n.odds)/0.025)+':'+n.legs.length;
   const old=bins.get(key);if(!old||n.prob>old.prob)bins.set(key,n);}
  beam=[...bins.values()].sort((a,b)=>b.prob-a.prob).slice(0,1200);
 }
 return best?{selections:best.legs,...metrics(best.legs),qualified:true}:{selections:[],qualified:false,reason:'no_positive_ev_5x_ticket_meeting_70pct_floor'};
}
function verify(selections,{now=new Date(),mode="mixed"}={}){
 if(!selections.length||selections.length>MAX_LEGS||new Set(selections.map(c=>String(c.eventId))).size!==selections.length||!selections.every(c=>valid(c,now)&&modeAllowed(c,mode)))return false;
 const m=metrics(selections);return m.combinedOdds>=MIN_ODDS&&m.combinedOdds<=MAX_ODDS&&m.estimatedEV>0;
}
module.exports={TARGET,FLOOR,MIN_ODDS,MAX_ODDS,MAX_LEGS,build,verify,metrics};
