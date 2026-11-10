'use strict';
// Automatic Telegram packs must exclude both named and generic/imported handicaps.
function isHandicap(c){
 const type=String(c.betType||'');
 return /^(?:ah)(?:_|$)|handicap|spread/i.test(type)||/handicap|\bspread\b|\bpuck line\b|\brun line\b/i.test(String(c.marketDesc||''))||/(?:^|[|;&])hcp\s*=/i.test(String(c.specifier||''))||(/football|soccer/i.test(c.sport||'')&&String(c.marketId)==='16')||(/basketball/i.test(c.sport||'')&&String(c.marketId)==='223');
}
module.exports={isHandicap};
