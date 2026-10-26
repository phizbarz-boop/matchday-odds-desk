'use strict';
// One browser context across all simultaneous website and Telegram H2H batches.
function createH2hBrowserPool({launch,beforeLaunch=()=>{}}){
 let browser=null,tail=Promise.resolve(),queued=0;
 function run(task,{signal}={}){
  queued++;
  const job=tail.then(async()=>{
   if(signal?.aborted)throw Object.assign(Error('H2H cancelled'),{h2hReason:'collection_cancelled'});
   if(!browser){beforeLaunch();const opened=await launch();browser=opened;opened.once?.('disconnected',()=>{if(browser===opened)browser=null;});}
   const context=await browser.newContext({locale:'en-NG'});const abort=()=>{void context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
   try{if(signal?.aborted)throw Object.assign(Error('H2H cancelled'),{h2hReason:'collection_cancelled'});return await task(await context.newPage());}
   finally{signal?.removeEventListener('abort',abort);await context.close().catch(()=>{});}
  });
  const result=job.finally(()=>{queued--;});tail=result.catch(()=>{});return result;
 }
 async function closeIdle(){if(queued)return false;const closing=browser;browser=null;if(closing)await closing.close().catch(()=>{});return true;}
 return{run,closeIdle};
}
module.exports={createH2hBrowserPool};
