'use strict';
const TYPES=[
 ['goalkicks_under155','Goal Kicks Under 15.5'],
 ['goalkicks_under165','Goal Kicks Under 16.5'],
 ['first_half_goalkicks_under75','1st Half Goal Kicks Under 7.5'],
 ['first_half_goalkicks_under85','1st Half Goal Kicks Under 8.5']
];
const IDS=TYPES.map(x=>x[0]);
function betTypeFor(row){
 if(row.live||!/football|soccer/i.test(row.sport||''))return null;
 const name=String(row.marketDesc||'').trim().toLowerCase().replace(/[–—-]/g,' ').replace(/\s+/g,' ');
 const first=/^(?:1st|first) half goal kicks? over\s*\/\s*under$/.test(name),full=/^goal kicks? over\s*\/\s*under$/.test(name);if(!first&&!full)return null;
 const label=String(row.outcomeDesc||'').trim(),m=label.match(/^under(?:\s+([0-9]+(?:\.[0-9]+)?))?$/i);if(!m)return null;
 const spec=String(row.specifier||'').match(/(?:^|[|;&])total=([0-9]+(?:\.[0-9]+)?)(?:$|[|;&])/i);
 const line=spec?Number(spec[1]):m[1]?Number(m[1]):NaN;if(!Number.isFinite(line)||m[1]&&Math.abs(Number(m[1])-line)>1e-9)return null;
 return first?(line===7.5?'first_half_goalkicks_under75':line===8.5?'first_half_goalkicks_under85':null):(line===15.5?'goalkicks_under155':line===16.5?'goalkicks_under165':null);
}
module.exports={IDS,TYPES,betTypeFor};
