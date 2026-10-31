'use strict';
const key=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
function insights(slips){
 const unique=new Map(),types=new Map(),bands=new Map(),tickets=new Map();
 const add=(map,name,status)=>{const r=map.get(name)||{name,won:0,lost:0,half_won:0,half_lost:0,push:0,pending:0};r[status in r?status:'pending']++;map.set(name,r);};
 for(const s of slips){add(tickets,s.label||'Unknown ticket type',s.status);for(const l of s.lastStatusDetail?.legDetails||[]){const old=unique.get(key(l));if(!old||old.status==='pending'||l.status!=='pending')unique.set(key(l),l);}}
 for(const l of unique.values()){
  add(types,(l.sport||'Unknown sport')+' · '+(l.betType||l.marketDesc||'Unknown market'),l.status);
  const p=Number(l.probability),band=l.probability==null||!Number.isFinite(p)?'Probability not recorded':p<70?'<70%':p<80?'70–79%':p<90?'80–89%':'90–100%';add(bands,band,l.status);
 }
 const finish=m=>[...m.values()].map(r=>({...r,decisive:r.won+r.lost,winRate:r.won+r.lost?r.won/(r.won+r.lost)*100:null})).sort((a,b)=>b.decisive-a.decisive||a.name.localeCompare(b.name));
 return {betTypes:finish(types),probabilityBands:finish(bands),ticketTypes:finish(tickets),uniqueSelections:unique.size};
}
function insightText(data){
 const lines=['','📚 PERFORMANCE BY MARKET / PROBABILITY / TICKET','Selection statistics count each exact selection once across repeated tickets; ticket results count each sent ticket. Half results, voids and pending are separate.'];
 for(const [title,rows] of [['Bet types',data.betTypes],['Probability bands',data.probabilityBands],['Ticket types',data.ticketTypes]]){lines.push(title);for(const r of rows)lines.push(`${r.name}: ${r.won} W / ${r.lost} L / ${r.push} void / ${r.pending} pending / ${r.half_won} half W / ${r.half_lost} half L · ${r.winRate==null?'no decisive results':r.winRate.toFixed(1)+'% W ('+r.decisive+' decisive)'}`);}
 const enough=data.betTypes.filter(r=>r.decisive>=20),sorted=[...enough].sort((a,b)=>b.winRate-a.winRate);
 lines.push('','🔎 WHAT TO REVIEW');
 if(!sorted.length)lines.push('Insufficient evidence to recommend a market: collect at least 20 decisive unique selections per type.');
 else{lines.push(`Strongest observed market: ${sorted[0].name} (${sorted[0].winRate.toFixed(1)}% wins, n=${sorted[0].decisive}). Review it first; win rate alone does not establish profitability.`);const worst=sorted.at(-1);if(worst!==sorted[0])lines.push(`Weakest observed market: ${worst.name} (${worst.winRate.toFixed(1)}% wins, n=${worst.decisive}). Review its prices and model estimates before increasing exposure.`);}
 const qualified=data.probabilityBands.filter(r=>r.decisive>=20&&r.name!=='Probability not recorded');if(qualified.length>=2){qualified.sort((a,b)=>b.winRate-a.winRate);lines.push(`Best observed probability band: ${qualified[0].name}; compare the sample sizes above before changing your floor. These are observational results, not proof that a floor causes losses.`);}else lines.push('Not enough recorded probabilities to recommend changing the floor. Older tickets may not contain probability data.');
 lines.push('A losing accumulator does not make every leg a loss. Review losing legs below; pending legs remain unresolved. Longer tickets can lose frequently despite a strong individual-leg win rate.');
 return lines.join('\n');
}
module.exports={insights,insightText};
