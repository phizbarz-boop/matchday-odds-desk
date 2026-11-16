'use strict';
// Default and profile review modes never submit. The explicitly armed test attempts one wager.
const {chromium}=require('playwright');
const {homedir}=require('node:os');
const {join}=require('node:path');
const {mkdir,open,access}=require('node:fs/promises');
const args=process.argv.slice(2);
const login=args.length===1&&args[0]==='--login';
const liveTest=args.length===1&&args[0]==='--submit-one-ngn1000';
const review=liveTest||args.length===1&&args[0]==='--review-profile';
if(args.length&&!login&&!review)throw Error('Use --login, --review-profile, --submit-one-ngn1000, or no option for signed-out dry run');
const profile=join(process.platform==='win32'&&process.env.LOCALAPPDATA||homedir(),'MatchdayOddsDesk','SportyBetReview');
const sportyHome='https://www.sportybet.com/ng/';
async function openProfile(){
 await mkdir(profile,{recursive:true,mode:0o700});
 return chromium.launchPersistentContext(profile,{headless:false,acceptDownloads:false});
}
async function signIn(){
 const ctx=await openProfile();
 const closed=new Promise(resolve=>ctx.once('close',resolve));
 try{
  const page=ctx.pages()[0]??await ctx.newPage();
  await page.goto(sportyHome,{waitUntil:'domcontentloaded',timeout:20000});
  console.log('Sign in yourself in the dedicated browser, then close its window. Do not place a bet.');
  await closed;
 }finally{await ctx.close().catch(()=>{});}
}
const token=process.env.ROLLOVER_WORKER_TOKEN;
const base=new URL(!login&&process.env.ROLLOVER_APP_URL||'https://matchday-odds-desk.onrender.com');
if(base.protocol!=='https:'||base.username||base.password)throw Error('Set ROLLOVER_APP_URL to your HTTPS application URL');
if(!login&&(!token||token.length<32))throw Error('Set the same private ROLLOVER_WORKER_TOKEN on Render and the worker');
const max=Number(process.env.ROLLOVER_MAX_STAKE_KOBO);
if(!login&&!liveTest&&(!Number.isSafeInteger(max)||max<=0))throw Error('Set ROLLOVER_MAX_STAKE_KOBO to your test stake ceiling in kobo');
const url=new URL('/api/sportybet/virtual-rollover/worker',base);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let stopped=false,browser,profileContext,last=null;
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{stopped=true;});
async function request(code){
 const u=new URL(url);
 if(code)u.searchParams.set('quote',code);
 const r=await fetch(u,{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(r.status===401)throw Object.assign(Error('Worker token rejected'),{fatal:true});
 if(!r.ok)throw Error('App returned HTTP '+r.status);
 return r.json();
}
function verifySlip(text,quote,now=Date.now()){
 const normalized=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
 const slip=normalized(text);
 const block=slip.match(/\bremove all\b(.*?)\btype\s+no\./)?.[1];
 const displayed=slip.match(/\bodds\s+(\d+\.\d+)\s+total stake\b/)?.[1];
 if(!block||!displayed)return 'browser_slip_not_confirmed';
 if(/\blive\b/.test(block))return 'browser_slip_has_live_games';
 if(!Array.isArray(quote.legs)||quote.legs.length<1||quote.legs.length>4||
    !quote.legs.every(leg=>Date.parse(leg.kickoffUtc)>now+20000))return 'browser_slip_closed_or_near_kickoff';
 const rows=[...block.matchAll(/\b(over|under)\s+(\d+\.\d+)\b(.*?)\bo\s*\/\s*u\b/g)].map(m=>({
  pick:m[1]+' '+m[2],match:normalized(m[3]).replace(/\s+(?:vs?\.?|–|—)\s+/g,' v ')
 }));
 if(rows.length!==quote.legs.length)return 'browser_slip_selection_mismatch';
 for(const leg of quote.legs){
  const pick=normalized(leg.pick).replace(/ goals$/,'');
  const match=normalized(leg.home)+' v '+normalized(leg.away);
  const i=rows.findIndex(row=>row.pick===pick&&(' '+row.match+' ').includes(' '+match+' '));
  if(i<0)return 'browser_slip_selection_mismatch';
  rows.splice(i,1);
 }
 const scale=10**displayed.split('.')[1].length;
 const odds=Number(displayed)*scale;
 if(!Number.isFinite(quote.odds)||![Math.round(quote.odds*scale),Math.floor(quote.odds*scale+1e-8)].some(n=>Math.abs(n-odds)<1e-8))
  return 'browser_slip_odds_changed';
 return 'browser_slip_verified';
}
async function readSlip(page,mark=false){
 return page.getByText('Total Stake',{exact:true}).evaluateAll((labels,mark)=>{
  const matches=new Set();
  for(const label of labels){
   if(!label.getClientRects().length)continue;
   for(let el=label.parentElement;el&&el!==document.body;el=el.parentElement){
    const text=el.innerText;
    if(text?.length>3500)break;
    if(/Remove All/i.test(text)&&/Potential Win/i.test(text)&&(!mark||/Place Bet/i.test(text))){
     matches.add(el);break;
    }
   }
  }
  if(matches.size!==1)return '';
  const slip=[...matches][0];
  if(mark)slip.setAttribute('data-matchday-test-slip','yes');
  return slip.innerText;
 },mark);
}
const testLock=join(profile,'one-live-test-ngn1000.attempted');
async function attemptLive(page,code,quote){
 const stop=reason=>{throw Error('No submission attempted: '+reason);};
 if(!(await page.getByText('My Account',{exact:true}).first().isVisible()))stop('sign in using --login');
 if(await page.getByText('Submission Successful',{exact:true}).first().isVisible())stop('a success dialog is already open');
 const slip=await readSlip(page,true);
 if(verifySlip(slip,quote)!=='browser_slip_verified')stop('slip could not be verified');
 const scope=page.locator('[data-matchday-test-slip="yes"]');
 const stake=scope.locator('input:visible:not([readonly]):not([disabled]):is(:not([type]),[type="text"],[type="number"],[type="tel"])');
 const submit=scope.getByRole('button',{name:'Place Bet',exact:true});
 if(await stake.count()!==1||await submit.count()!==1)stop('stake input or Place Bet button is missing or ambiguous');
 await stake.fill('1000',{timeout:2000});
 await stake.press('Tab',{timeout:2000});
 await submit.click({trial:true,timeout:2000});
 const fresh=await request(code);
 if(fresh.status!=='quote_matches'||fresh.code!==code||fresh.odds!==quote.odds||
    JSON.stringify(fresh.legs)!==JSON.stringify(quote.legs))stop('server quote changed');
 const updated=await readSlip(page,true);
 if(stopped||verifySlip(updated,fresh)!=='browser_slip_verified'||
    !/\btotal stake\s+(?:1,000|1000)(?:\.00)?(?=\s|$)/i.test(updated)||
    Number((await stake.inputValue({timeout:2000})).replace(/,/g,''))!==1000)stop('slip or total stake changed');
 const lock=await open(testLock,'wx');
 try{await lock.writeFile(JSON.stringify({code,stakeNGN:1000,odds:fresh.odds,time:new Date().toISOString()}));await lock.sync();}
 finally{await lock.close();}
 try{
  await submit.click({timeout:2000});
  const receipt=page.getByText('Submission Successful',{exact:true});
  await receipt.waitFor({state:'visible',timeout:8000});
  const confirmed=await receipt.evaluate(label=>{
   for(let el=label.parentElement;el&&el!==document.body;el=el.parentElement){
    const text=el.innerText;
    if(text.length>1600)break;
    if(/Check Bet History/i.test(text)&&/\bTotal Stake\s+(?:1,000|1000)(?:\.00)?(?=\s|$)/i.test(text))return true;
   }
   return false;
  });
  if(!confirmed)throw Error('Receipt not verified');
  return 'submission_success_shown';
 }catch{
  throw Error('Submission outcome unknown. Check SportyBet Bet History. Do not retry.');
 }
}
async function inspect(code,quote){
 if(!review)browser??=await chromium.launch({headless:true});
 const ctx=review?profileContext:await browser.newContext();
 let page;
 try{
  page=await ctx.newPage();
  const link=new URL(sportyHome);
  link.searchParams.set('shareCode',code);
  const response=await page.goto(link.href,{waitUntil:'domcontentloaded',timeout:20000});
  const host=new URL(page.url()).hostname;
  if(!response?.ok()||!['www.sportybet.com','sportybet.com'].includes(host))return 'browser_page_unavailable';
  for(let i=0;i<8;i++){
   const status=verifySlip(await readSlip(page),quote);
   if(status==='browser_slip_verified'&&liveTest)return await attemptLive(page,code,quote);
   if(status!=='browser_slip_not_confirmed')return status;
   await delay(750);
  }
  return 'browser_slip_not_confirmed';
 }finally{if(review)await page?.close();else await ctx.close();}
}
async function tick(){
 const ticket=await request();
 if(ticket.status!=='pending'||ticket.code===last){if(liveTest)console.log('No current pending ticket; nothing submitted.');return;}
 if(!/^[A-Z0-9]{4,32}$/i.test(ticket.code))throw Error('Unexpected booking code format');
 if(!liveTest&&(!Number.isSafeInteger(ticket.stakeKobo)||ticket.stakeKobo<=0||ticket.stakeKobo>max)){
  console.log('DRY RUN: stake outside test ceiling',ticket.code);last=ticket.code;return;
 }
 const quote=await request(ticket.code);
 if(quote.status!=='quote_matches'){
  console.log('DRY RUN: skipped',ticket.code,quote.status);last=ticket.code;return;
 }
 if(liveTest&&(quote.code!==ticket.code||!(quote.odds>=1.30&&quote.odds<=1.50)))throw Error('No submission attempted: invalid RDP quote');
 const status=await inspect(ticket.code,quote);
 if(liveTest){console.log('ONE-SHOT:',ticket.code,quote.odds+'x','₦1,000',status);return;}
 console.log('DRY RUN:',ticket.code,quote.odds+'x','₦'+(ticket.stakeKobo/100).toFixed(2),status);
 last=ticket.code;
}
(async()=>{
 if(login)return signIn();
 try{
  if(liveTest){
   const attempted=await access(testLock).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
   if(attempted)throw Error('Test already attempted on this profile. Check SportyBet Bet History; no second attempt is allowed.');
  }
  if(review){
   profileContext=await openProfile();
   profileContext.once('close',()=>{stopped=true;});
  }
  if(liveTest){await tick();return;}
  console.log(review?'Roll Over profile review started. No wagers can be submitted.':'Roll Over dry run started. No wagers can be submitted.');
  while(!stopped){
   try{await tick();}catch(err){if(err.fatal)throw err;console.error('DRY RUN:',err.message);}
   if(!stopped)await delay(10000);
  }
 }finally{await profileContext?.close();await browser?.close();}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
