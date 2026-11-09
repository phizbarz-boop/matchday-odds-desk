'use strict';
const S=require('../lib/sportyLineups');
async function run({redis,collect,discover,close=async()=>{},now=Date.now,budgetMs=900000,maxFixtures=100,logger=console}){
 const started=now(),summary={checked:0,saved:0,skippedFresh:0,failed:0,source:'SportyBet usual lineups',startingLineupConfirmed:false};
 const fixtures=new Map();
 for(const id of (await redis.sMembers(S.QUEUE)).slice(0,1000)){const c=S.decode(await redis.get(S.fixtureKey({eventId:id})));if(c)fixtures.set(String(c.eventId),c);}
 try{for(const c of await discover())if(!fixtures.has(String(c.eventId)))fixtures.set(String(c.eventId),c);}catch{summary.discoveryUnavailable=true;}
 const normalized=[...fixtures.values()].map(c=>({...c,kickoffUtc:c.kickoffUtc||require('../lib/sportybet').normalizeOutcome(c).kickoffUtc}));
 summary.discoveredFixtures=normalized.length;summary.missingKickoff=normalized.filter(c=>!Number.isFinite(Date.parse(c.kickoffUtc))).length;
 const queue=normalized.filter(c=>/^sr:match:\d+$/.test(String(c.eventId))&&!c.live&&Date.parse(c.kickoffUtc)>now()&&Date.parse(c.kickoffUtc)<now()+48*3600000).sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
 summary.eligibleFixtures=queue.length;

 try{for(const c of queue){
  if(now()-started>=budgetMs||summary.checked>=maxFixtures)break;
  const old=S.decode(await redis.get(S.dataKey(c)));if(S.usable(old,c,now())){summary.skippedFresh++;await redis.sRem(S.QUEUE,String(c.eventId));continue;}
  if(await redis.get(S.PREFIX+'retry:desktop:'+c.eventId)){summary.retriesDeferred=(summary.retriesDeferred||0)+1;continue;}
  summary.checked++;
  try{const e=await collect(c);if(!S.usable(e,c,now()))throw Error('SPORTYBET_USUAL_LINEUP_INVALID');await redis.set(S.dataKey(c),JSON.stringify(e),{EX:21600});await redis.sRem(S.QUEUE,String(c.eventId));summary.saved++;logger.info('[SportyBet usual lineup] '+JSON.stringify({eventId:c.eventId,players:e.players.length,confirmed:false}));}
  catch(error){summary.failed++;await redis.set(S.PREFIX+'retry:desktop:'+c.eventId,'1',{EX:3600});const reason=/^SPORTYBET_[A-Z_]+$/.test(error.message||'')?error.message:'SPORTYBET_LINEUP_READ_FAILED';logger.warn('[SportyBet usual lineup] '+JSON.stringify({eventId:c.eventId,reason,...(error.lineupDiagnostics?{diagnostics:error.lineupDiagnostics}:{})}));}
 }}finally{await close();}
 summary.status=summary.failed&&!summary.saved?'failed':!queue.length?(summary.missingKickoff===normalized.length&&normalized.length?'invalid_fixture_times':'no_eligible_fixtures'):summary.saved||summary.skippedFresh?'completed':'deferred';
 summary.finishedAt=new Date(now()).toISOString();await redis.set(S.PREFIX+'status',JSON.stringify(summary),{EX:86400});logger.info('[SportyBet lineup worker] '+JSON.stringify(summary));return summary;
}
async function main(){
 if(!process.env.REDIS_URL)throw Error('Set REDIS_URL to the same Redis used by Render');
 const redis=require('redis').createClient({url:process.env.REDIS_URL,socket:{connectTimeout:10000,reconnectStrategy:()=>false}});redis.on('error',()=>console.error('Lineup Redis unavailable'));
 const pool=require('../lib/h2hBrowserPool').createH2hBrowserPool({launch:()=>{require('../lib/sportyBrowserRuntime').configureBrowserPath();return require('playwright').chromium.launch(require('../lib/h2hWorkerBrowser').launchOptions());}});
 try{await redis.connect();const result=await run({redis,collect:c=>pool.run(page=>require('../lib/sportyLineupCollector').collectPage(page,c)),close:()=>pool.closeIdle(),discover:async()=>require('../lib/sportyRequest').withPublicSportyRequest(async()=>{const result=await require('../lib/sportybet').listPrematchFixtures('football');return result.fixtures||[];})});if(['failed','invalid_fixture_times'].includes(result.status))process.exitCode=1;}finally{if(redis.isOpen)await redis.quit().catch(()=>redis.disconnect());}
}
if(require.main===module)main().catch(()=>{console.error('SportyBet lineup worker failed. Check the shared Redis configuration and worker source logs.');process.exitCode=1;});
module.exports={run};
