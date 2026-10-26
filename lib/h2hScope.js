'use strict';
const enabled=c=>/^(football|soccer|basketball)$/i.test(String(c?.sport||c?.sportKey||'').trim());
const skipped=c=>({...c,h2hCheck:{status:'disabled_for_sport',allowed:true,verified:false,attempted:false,reason:'football_and_basketball_only'}});
module.exports={enabled,skipped};
