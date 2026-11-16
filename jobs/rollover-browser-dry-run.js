'use strict';
// Default and profile review modes never submit. The explicitly armed test attempts one wager.
const {chromium}=require('playwright');
const {homedir}=require('node:os');
const {join}=require('node:path');
const {mkdir,open,access}=require('node:fs/promises');
const args=process.argv.slice(2);
const login=args.length===1&&args[0]==='--login';
const externalCode=args.length===2&&['--submit-one-ngn1000','--review-code'].includes(args[0])&&/^[A-Z0-9]{4,32}$/i.test(args[1])?args[1].toUpperCase():null;
const liveTest=args[0]==='--submit-one-ngn1000'&&(args.length===1||!!externalCode);
const review=liveTest||!!externalCode||args.length===1&&args[0]==='--review-profile';
if(args.length&&!login&&!review)throw Error('Use --login, --review-profile, --review-code CODE, --submit-one-ngn1000 [CODE], or no option');
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
if(!login&&!liveTest&&!externalCode&&(!Number.isSafeInteger(max)||max<=0))throw Error('Set ROLLOVER_MAX_STAKE_KOBO to your test stake ceiling in kobo');
const url=new URL('/api/sportybet/virtual-rollover/worker',base);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let stopped=false,browser,profileContext,last=null;
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{stopped=true;});
async function request(code){
 const u=new URL(url);
 if(externalCode)u.searchParams.set('external',externalCode);
 else if(code)u.searchParams.set('quote',code);
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
  const row=rows[i];
  if(row.match==='live '+match||row.match===match+' live')return 'browser_selection_displays_live_label';
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
async function waitForLiveReceipt(page,receipt,quote){
 const heading=page.getByText('About to pay',{exact:true}).filter({visible:true});
 const deadline=Date.now()+10000;
 let confirmedPayment=false;
 while(Date.now()<deadline&&!stopped){
  if(await receipt.first().isVisible())return;
  const dialogs=await heading.count();
  if(dialogs>1)throw Error('Ambiguous payment dialog');
  if(dialogs===1&&!confirmedPayment){
   const matched=await heading.evaluate(label=>{
    document.querySelectorAll('[data-matchday-pay-dialog]').forEach(el=>el.removeAttribute('data-matchday-pay-dialog'));
    const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible';
    const text=node=>node.textContent.replace(/\s+/g,' ').trim();
    for(let el=label.parentElement,i=0;el&&el!==document.body&&i<8;el=el.parentElement,i++){
     const labels=[...el.querySelectorAll('*')].filter(visible).map(text);
     if(labels.includes('Place Bet'))break;
     if(labels.includes('Confirm')&&labels.includes('Cancel')){
      if(!labels.some(value=>/^NGN\s+1,?000\.00$/i.test(value)))return false;
      el.setAttribute('data-matchday-pay-dialog','yes');
      return true;
     }
    }
    return false;
   },undefined,{timeout:2000});
   if(!matched||verifySlip(await readSlip(page),quote)!=='browser_slip_verified')throw Error('Payment amount or slip could not be verified');
   const confirm=page.locator('[data-matchday-pay-dialog="yes"]').getByText('Confirm',{exact:true}).filter({visible:true});
   if(await confirm.count()!==1||stopped)throw Error('Payment confirmation control could not be verified');
   confirmedPayment=true;
   await confirm.click({timeout:2000});
  }
  await delay(250);
 }
 throw Error('No verified receipt');
}
async function attemptLive(page,code,quote){
 const stop=reason=>{throw Error('No submission attempted: '+reason);};
 if(!(await page.getByText('My Account',{exact:true}).first().isVisible()))stop('sign in using --login');
 if(await page.getByText('Submission Successful',{exact:true}).first().isVisible())stop('a success dialog is already open');
 const slip=await readSlip(page,true);
 if(verifySlip(slip,quote)!=='browser_slip_verified')stop('slip could not be verified');
 const scope=page.locator('[data-matchday-test-slip="yes"]');
 const fieldStatus=await scope.evaluate(el=>{
  const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible';
  const fields=root=>[...root.querySelectorAll('input')].filter(input=>
   visible(input)&&!input.readOnly&&!input.matches(':disabled')&&['text','number','tel','search'].includes(input.type));
  const inputs=fields(el);
  const headers=[...el.querySelectorAll('*')].filter(node=>visible(node)&&
   /^stake\s*\(\s*ngn\s*\)$/i.test(node.innerText?.trim())&&
   ![...node.children].some(child=>/^stake\s*\(\s*ngn\s*\)$/i.test(child.innerText?.trim())));
  const candidates=new Set();
  for(const header of headers){
   for(let parent=header.parentElement;parent&&parent!==el;parent=parent.parentElement){
    const found=fields(parent);
    if(!found.length)continue;
    if(found.length===1)candidates.add(found[0]);
    break;
   }
  }
  for(const input of inputs)input.removeAttribute('data-matchday-stake');
  if(candidates.size===1)[...candidates][0].setAttribute('data-matchday-stake','yes');
  else if(!candidates.size&&inputs.length===1)inputs[0].setAttribute('data-matchday-stake','yes');
  return {inputs:inputs.length,headerMatches:headers.length};
 },undefined,{timeout:2000});
 const stake=scope.locator('input[data-matchday-stake="yes"]:visible');
 const roleButton=scope.getByRole('button',{name:'Place Bet',exact:true}).filter({visible:true});
 const textButton=scope.getByText('Place Bet',{exact:true}).filter({visible:true});
 const roleCount=await roleButton.count();
 const submit=roleCount===0?textButton:roleButton;
 const submitCount=await submit.count();
 if(await stake.count()!==1||submitCount!==1)
  stop('could not resolve controls (editable inputs: '+fieldStatus.inputs+', stake headers: '+fieldStatus.headerMatches+', Place Bet matches: '+submitCount+')');
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
  await waitForLiveReceipt(page,receipt,fresh);
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
async function confirmRemoveBetslip(page,deadline){
 const title=page.getByText('Remove Betslip',{exact:true}).filter({visible:true});
 const count=await title.count();
 if(!count)return 'absent';
 if(count!==1)return 'unverified';
 const matched=await title.evaluate(heading=>{
  document.querySelectorAll('[data-matchday-remove-dialog]').forEach(el=>el.removeAttribute('data-matchday-remove-dialog'));
  const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible';
  const text=node=>node.textContent.replace(/\s+/g,' ').trim();
  const contains=(scope,pattern)=>[...scope.querySelectorAll('*')].some(node=>visible(node)&&pattern.test(text(node)));
  // Match individual visible labels; innerText can concatenate inline controls.
  let el=heading.parentElement;
  for(let depth=0;el&&el!==document.body&&depth<8;depth++,el=el.parentElement){
   if(contains(el,/^Are you sure to remove all items\?$/i)&&contains(el,/^Later$/i)&&
      contains(el,/^OK$/i)&&!contains(el,/^Place Bet$/i)){
    el.setAttribute('data-matchday-remove-dialog','yes');
    return true;
   }
  }
  return false;
 },undefined,{timeout:Math.max(1,deadline-Date.now())});
 if(!matched)return 'unverified';
 const ok=page.locator('[data-matchday-remove-dialog="yes"]').getByText('OK',{exact:true}).filter({visible:true});
 if(await ok.count()!==1||stopped)return 'unverified';
 await ok.click({timeout:Math.max(1,deadline-Date.now())});
 return 'confirmed';
}
async function clearSavedBetslip(page){
 const response=await page.goto(sportyHome,{waitUntil:'domcontentloaded',timeout:20000});
 const url=new URL(page.url());
 if(!response?.ok()||url.protocol!=='https:'||!['www.sportybet.com','sportybet.com'].includes(url.hostname))return 'browser_cart_home_unavailable';
 const heading=page.getByText(/^Betslip(?:\s*\d+)?$/i).filter({visible:true});
 try{await heading.first().waitFor({state:'visible',timeout:5000});}
 catch(error){if(error.name==='TimeoutError')return 'browser_cart_heading_not_visible';throw error;}
 const remove=page.getByText('Remove All',{exact:true}).filter({visible:true});
 const loading=page.locator('.m-betslips-loading:visible');
 let clicked=false,confirmed=false,emptyReads=0;
 const deadline=Date.now()+15000;
 while(Date.now()<deadline){
  if(stopped)return 'browser_cart_check_stopped';
  if(clicked&&!confirmed){
   try{
    const result=await confirmRemoveBetslip(page,deadline);
    if(result==='unverified')return 'browser_cart_remove_dialog_unverified';
    if(result==='confirmed'){confirmed=true;emptyReads=0;await delay(500);continue;}
   }catch(error){if(error.name==='TimeoutError')return 'browser_cart_confirmation_blocked';throw error;}
  }
  if(await loading.count()){
   emptyReads=0;
   await delay(500);
   continue;
  }
  const count=await remove.count();
  if(count>1)return 'browser_cart_remove_button_ambiguous';
  if(count===1&&!clicked){
   // The overlay can reappear between the check and click. Let Playwright
   // wait for a normal, actionable click; never force it through.
   try{await remove.click({timeout:Math.max(1,deadline-Date.now())});}
   catch(error){if(error.name==='TimeoutError')return 'browser_cart_remove_button_blocked';throw error;}
   clicked=true;
   emptyReads=0;
  }else if(count===0&&!(await readSlip(page))&&!(await loading.count())){
   if(++emptyReads===4)return 'browser_cart_empty';
  }else emptyReads=0;
  await delay(500);
 }
 if(await loading.count())return 'browser_cart_loading_timeout';
 return confirmed?'browser_cart_still_full_after_confirmation':clicked?'browser_cart_remove_not_confirmed':'browser_cart_empty_not_verified';
}
async function inspect(code,quote){
 if(!review)browser??=await chromium.launch({headless:true});
 const ctx=review?profileContext:await browser.newContext();
 let page;
 try{
  page=await ctx.newPage();
  if(review){
   const cart=await clearSavedBetslip(page);
   if(cart!=='browser_cart_empty')return cart;
  }
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
 if(externalCode){
  const quote=await request(externalCode);
  if(quote.status!=='quote_matches'||quote.code!==externalCode||!(quote.odds>=1.30&&quote.odds<=1.50)){
   console.log('No submission attempted:',externalCode,quote.status);return;
  }
  const status=await inspect(externalCode,quote);
  if(liveTest)console.log('ONE-SHOT:',externalCode,quote.odds+'x','₦1,000',status);
  else console.log('REVIEW:',externalCode,quote.odds+'x',status);
  return;
 }
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
  if(liveTest||externalCode){await tick();return;}
  console.log(review?'Roll Over profile review started. No wagers can be submitted.':'Roll Over dry run started. No wagers can be submitted.');
  while(!stopped){
   try{await tick();}catch(err){if(err.fatal)throw err;console.error('DRY RUN:',err.message);}
   if(!stopped)await delay(10000);
  }
 }finally{await profileContext?.close();await browser?.close();}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
