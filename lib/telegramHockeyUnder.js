'use strict';
const key=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
function describe(c){
 if(c.live===true||!/hockey/i.test(String(c.sport||''))||c.active===false||c.suspended||!(Number(c.odds)>1))return null;
 const name=String(c.marketDesc||'').toLowerCase().trim();
 // Match goals only: player/team totals, periods, shots and handicaps are different markets.
 if(!/^(?:over\s*\/\s*under(?: goals)?|total goals)(?:\s*\((?:incl\.?|including)\s*(?:ot|overtime)(?:\s*(?:and|&)\s*(?:penalties|shootout))?\))?$/.test(name))return null;
 const side=String(c.outcomeDesc||'').trim().match(/^under(?:\s+(\d+(?:\.\d+)?))?$/i);if(!side)return null;
 const parts=String(c.specifier||'').split(/[|;&]/).filter(Boolean),raw=parts.find(s=>/^total=/.test(s));
 const line=Number(raw?raw.slice(6):side[1]);if(!Number.isFinite(line)||side[1]&&Number(side[1])!==line)return null;
 return {line,group:JSON.stringify([String(c.eventId),String(c.marketId),name,parts.filter(s=>!/^total=/.test(s)).sort()])};
}
function annotate(candidates,offered){
 const maxima=new Map();for(const row of offered){const d=describe(row);if(d)maxima.set(d.group,Math.max(maxima.get(d.group)||0,d.line));}
 const allowed=new Set();for(const row of offered){const d=describe(row);if(d&&maxima.get(d.group)===d.line&&[6.5,7.5,8.5].includes(d.line))allowed.add(key(row));}
 return candidates.map(c=>({...c,hockeyHighestUnderQualified:allowed.has(key(c))}));
}
module.exports={describe,annotate};
