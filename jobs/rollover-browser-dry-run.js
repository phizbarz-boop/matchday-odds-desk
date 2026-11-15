'use strict';
// This worker navigates and reads only. It contains no click or submit action.
const {chromium}=require('playwright');
const token=process.env.ROLLOVER_WORKER_TOKEN;
const base=new URL(process.env.ROLLOVER_APP_URL||'https://matchday-odds-desk.onrender.com');
if(base.protocol!=='https:'||base.username||base.password)throw Error('Set ROLLOVER_APP_URL to your HTTPS application URL');
if(!token||token.length<32)throw Error('Set the same private ROLLOVER_WORKER_TOKEN on Render and the worker');
const max=Number(process.env.ROLLOVER_MAX_STAKE_KOBO);
if(!Number.isSafeInteger(max)||max<=0)throw Error('Set ROLLOVER_MAX_STAKE_KOBO to your test stake ceiling in kobo');
const url=new URL('/api/sportybet/virtual-rollover/worker',base);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let stopped=false,browser,last=null;
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{stopped=true;});
async function request(code){
 const u=new URL(url);
 if(code)u.searchParams.set('quote',code);
 const r=await fetch(u,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(r.status===401)throw Object.assign(Error('Worker token rejected'),{fatal:true});
 if(!r.ok)throw Error('App returned HTTP '+r.status);
 return r.json();
}
async function inspect(code){
 browser??=await chromium.launch({headless:true});
 const ctx=await browser.newContext();
 try{
  const page=await ctx.newPage();
  const link=new URL('https://www.sportybet.com/ng/');
  link.searchParams.set('shareCode',code);
  const response=await page.goto(link.href,{waitUntil:'domcontentloaded',timeout:20000});
  const host=new URL(page.url()).hostname;
  if(!response?.ok()||!['www.sportybet.com','sportybet.com'].includes(host))return 'browser_page_unavailable';
  return 'browser_page_loaded_slip_not_confirmed';
 }finally{await ctx.close();}
}
async function tick(){
 const ticket=await request();
 if(ticket.status!=='pending'||ticket.code===last)return;
 if(!/^[A-Z0-9]{4,32}$/i.test(ticket.code))throw Error('Unexpected booking code format');
 if(!Number.isSafeInteger(ticket.stakeKobo)||ticket.stakeKobo<=0||ticket.stakeKobo>max){
  console.log('DRY RUN: stake outside test ceiling',ticket.code);last=ticket.code;return;
 }
 const quote=await request(ticket.code);
 if(quote.status!=='quote_matches'){
  console.log('DRY RUN: skipped',ticket.code,quote.status);last=ticket.code;return;
 }
 const status=await inspect(ticket.code);
 console.log('DRY RUN:',ticket.code,quote.odds+'x','₦'+(ticket.stakeKobo/100).toFixed(2),status);
 last=ticket.code;
}
(async()=>{
 console.log('Roll Over dry run started. No wagers can be submitted.');
 try{
  while(!stopped){
   try{await tick();}catch(err){if(err.fatal)throw err;console.error('DRY RUN:',err.message);}
   if(!stopped)await delay(10000);
  }
 }finally{await browser?.close();}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
