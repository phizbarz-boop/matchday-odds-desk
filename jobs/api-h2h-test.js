'use strict';
const {createApiH2h}=require('../lib/apiSportsH2h'),{SPORT_HOSTS}=require('../lib/apiSportsH2hData');
async function run({env=process.env,logger=console,client=null}={}){
 if(!env.APISPORTS_KEY)throw Error('Add GitHub repository secret APISPORTS_KEY.');
 const api=client||createApiH2h({env:{...env,APISPORTS_H2H_ENABLED:'true',APISPORTS_H2H_DAILY_LIMIT:'25',APISPORTS_H2H_MINUTE_LIMIT:'10'}}),plans=[];
 for(const sport of Object.keys(SPORT_HOSTS)){try{plans.push(await api.status(sport));}catch(error){plans.push({sport,error:error.code||'API_STATUS_UNAVAILABLE'});}}
 logger.info(JSON.stringify({apiPlans:plans,tennis:'SportyBet source; no API-Sports tennis product is configured'},null,2));
 if(!plans.some(p=>p.active))throw Object.assign(Error('API_ACCOUNT_UNAVAILABLE'),{code:'API_ACCOUNT_UNAVAILABLE'});
 const id=String(env.API_H2H_TEST_EVENT_ID||'').trim();if(!id)return{plans};if(!/^sr:match:\d+$/.test(id))throw Error('Use an exact SportyBet event ID, e.g. sr:match:123.');
 if(!env.REDIS_URL)throw Error('The optional fixture test requires the existing REDIS_URL secret.');
 const redis=require('redis').createClient({url:env.REDIS_URL,socket:{connectTimeout:10000,reconnectStrategy:()=>false}});redis.on('error',()=>{});
 try{await redis.connect();const c=await require('../lib/h2hCache').createH2hCache({getRedis:async()=>redis}).fixture(id);if(!c)throw Error('Fixture identity is not cached. Run a website analysis for this upcoming fixture first.');
 const evidence=await api.collect(c,{signal:AbortSignal.timeout(55000)});const result={eventId:id,sport:c.sport,provider:evidence.provider,providerFixtureId:evidence.providerFixtureId,historyBasis:evidence.historyBasis,metrics:evidence.metrics,metricSamples:evidence.metricSamples,games:evidence.games};logger.info(JSON.stringify(result,null,2));return{plans,result};
 }finally{if(redis.isOpen)await redis.quit().catch(()=>redis.disconnect());}
}
if(require.main===module)run().catch(error=>{console.error(/^API_[A-Z_]+$/.test(String(error.code||''))?error.code:error.message.startsWith('Add GitHub')||error.message.startsWith('Use an exact')||error.message.startsWith('The optional')||error.message.startsWith('Fixture identity')?error.message:'API H2H test could not complete. Check the plan/status report; credentials were not printed.');process.exitCode=1;});
module.exports={run};
