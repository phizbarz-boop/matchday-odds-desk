'use strict';
const TYPES=[['throwins_highest_under','Throw-ins · Highest available Under'],['basketball_rebounds_highest_under','Player rebounds · Highest available Under'],['hockey_shots_highest_under','Player shots on goal · Highest available Under']];
const IDS=TYPES.map(x=>x[0]);
const BY_SPORT={football:[IDS[0]],basketball:[IDS[1]],hockey:[IDS[2]]};
const MARKET_IDS={football:['900769'],basketball:['923'],hockey:['777']}; // Observed public feed IDs; booking uses returned outcomes.
const selectionKey=c=>[c.eventId,c.marketId,c.outcomeId,c.specifier||''].join('|');
const clean=x=>String(x||'').toLowerCase().replace(/\s+/g,' ').trim();
function describe(c){
 if(c.live)return null;const name=clean(c.marketDesc),sport=clean(c.sport),spec=String(c.specifier||'');if(/\b(?:half|quarter|period|set)\b|[&+]/.test(name))return null;let type,player='';
 if(/football|soccer/.test(sport)&&/^throw[ -]?ins over\s*\/\s*under$/.test(name))type=IDS[0];
 else if(/basket/.test(sport)){
  const match=name.match(/^(.+?) total rebounds(?:\s*\(incl\.? overtime\))?$/);if(!match)return null;
  player=match[1];if(/^(?:home|away)(?: team)?$|^match$|^team$/.test(player)||player===clean(c.home)||player===clean(c.away))return null;type=IDS[1];
 }else if(/hockey/.test(sport)){
  const match=name.match(/^(player|.+?) (?:total )?shots on goal(?:\s*\(incl\.? overtime\))?$/);if(!match)return null;player=match[1];type=IDS[2];
 }else return null;
 const parts=spec.split(/[|;&]/).filter(Boolean),playerSpec=parts.find(s=>/^player=/.test(s));
 if(playerSpec)player=playerSpec;else if(player==='player'){player=parts.find(s=>/^variant=/.test(s))||String(c.playerId||'');if(!player)return null;}
 const side=String(c.outcomeDesc||'').trim().match(/\b(under|over)(?:\s+([0-9]+(?:\.[0-9]+)?))?$/i);
 const total=parts.find(s=>/^total=/.test(s)),line=total?Number(total.slice(6)):side?.[2]?Number(side[2]):NaN;
 if(!side||!Number.isFinite(line)||line<0||side[2]&&Number(side[2])!==line)return null;
 const scope=/incl\.? overtime/.test(name)?'including_overtime':'regulation';
 const identity=parts.filter(s=>!/^total=/.test(s)&&!(playerSpec&&/^variant=/.test(s))).sort().join('|');
 return {type,line,under:side[1].toLowerCase()==='under',player,scope,group:JSON.stringify([String(c.eventId),type,player,scope,identity])};
}
function highestKeys(rows){const groups=new Map();for(const c of rows){const info=describe(c);if(!info?.under||!(Number(c.odds)>1)||c.active===false||c.suspended)continue;const previous=groups.get(info.group);if(!previous||info.line>previous.line)groups.set(info.group,{line:info.line,key:selectionKey(c)});}return new Set([...groups.values()].map(x=>x.key));}
function annotations(c,highest){const info=describe(c);if(!info)return {};const chosen=info.under&&highest.has(selectionKey(c));return {specialtyUnderKind:info.type,highestAvailableUnder:chosen,highestUnderLine:chosen?info.line:null,...(chosen?{betType:info.type}:{} )};}
function builderAllowed(c){return !c.specialtyUnderKind||c.highestAvailableUnder===true;}
module.exports={TYPES,IDS,BY_SPORT,MARKET_IDS,describe,highestKeys,annotations,builderAllowed};
