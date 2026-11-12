'use strict';
const VIRTUAL_SPORT='sr:sport:202120001';
function product(c){
 const labels=[c.tournament_name,c.tournament?.name,c.tournament,c.category?.name,c.category,c.sport?.name,c.sport,c.home,c.away,c.homeTeamName,c.awayTeamName].filter(x=>typeof x==='string');
 if(labels.some(x=>/\bsrl\b|simulated reality league/i.test(x)))return 'srl';
 if(String(c.sport?.id??c.sportId??'')===VIRTUAL_SPORT||labels.some(x=>/\b(?:vfootball|virtual)\b/i.test(x)))return 'virtual';
 return null;
}
module.exports={product};
