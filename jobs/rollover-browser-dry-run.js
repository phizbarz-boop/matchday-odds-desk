'use strict';
// Default and profile review modes never submit. The explicitly armed test attempts one wager.
const {chromium}=require('playwright');
const {RULES}=require('./rollover-run-state.cjs');
const validRolloverOdds=odds=>Number.isFinite(odds)&&odds>=RULES.minOdds-1e-9&&odds<=RULES.maxOdds+1e-9;
const {homedir}=require('node:os');
const {join}=require('node:path');
const {mkdir,open,access,readFile,rename,stat}=require('node:fs/promises');
const args=process.argv.slice(2);
const login=args.length===1&&args[0]==='--login';
const externalCode=args.length===2&&['--submit-one-ngn1000','--review-code'].includes(args[0])&&/^[A-Z0-9]{4,32}$/i.test(args[1])?args[1].toUpperCase():null;
const liveTest=args[0]==='--submit-one-ngn1000'&&(args.length===1||!!externalCode);
const auto=args.length===1&&args[0]==='--auto-rollover';
const review=auto||liveTest||!!externalCode||args.length===1&&args[0]==='--review-profile';
if(args.length&&!login&&!review)throw Error('Use --login, --auto-rollover, --review-profile, --review-code CODE, --submit-one-ngn1000 [CODE], or no option');
const profile=join(process.platform==='win32'&&process.env.LOCALAPPDATA||homedir(),'MatchdayOddsDesk','SportyBetReview');
const sportyHome='https://www.sportybet.com/ng/';
async function openProfile(){
 await mkdir(profile,{recursive:true,mode:0o700});
 return chromium.launchPersistentContext(profile,{headless:false,acceptDownloads:false});
}
const autoPhone=auto?process.env.ROLLOVER_SPORTY_PHONE:null;
const autoPassword=auto?process.env.ROLLOVER_SPORTY_PASSWORD:null;
delete process.env.ROLLOVER_SPORTY_PHONE;
delete process.env.ROLLOVER_SPORTY_PASSWORD;
let lastSignIn=0;
const loginStop=message=>Object.assign(Error(message),{fatal:true});
function sportyOrigin(page){
 return /^https:\/\/(?:www\.)?sportybet\.com$/.test(new URL(page.url()).origin);
}
async function ensureAutoSession(page){
 if(!auto)return;
 const account=page.getByText('My Account',{exact:true}).first();
 if(!sportyOrigin(page))throw loginStop('Automatic sign-in stopped: unexpected website.');
 if(await account.isVisible()){console.log('AUTO: already logged in');return false;}
 try{await account.waitFor({state:'visible',timeout:1500});console.log('AUTO: already logged in');return false;}
 catch(error){if(error.name!=='TimeoutError')throw error;}
 console.log('AUTO: SportyBet is signed out; logging in');
 const phone=(autoPhone??'').replace(/\D/g,'').replace(/^(?:234|0)(?=\d{10}$)/,'');
 if(!/^\d{10}$/.test(phone)||!autoPassword)
  throw loginStop('SportyBet signed out. Set ROLLOVER_SPORTY_PHONE and ROLLOVER_SPORTY_PASSWORD locally or run --login.');
 if(Date.now()-lastSignIn<60000)
  throw loginStop('SportyBet signed out again immediately. Check the session manually with --login.');
 lastSignIn=Date.now();
 const check=async()=>{
  if(stopped||!sportyOrigin(page))throw loginStop('Automatic sign-in stopped before verification.');
  if(await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="verification" i], iframe[src*="captcha" i]').filter({visible:true}).count()||
     await page.getByText(/verify you are human|unusual traffic|robot verification|captcha|enter (?:the |your )?(?:otp|verification code)/i).filter({visible:true}).count())
   throw loginStop('SportyBet requires verification. Open --login to complete it manually.');
 };
 try{
  await check();
  const phoneField=page.locator('input[name="phone"]:visible');
  const passwordField=page.locator('input[name="psd"][type="password"]:visible');
  if(!await passwordField.count()){
   const launcher=page.getByText(/^Log\s*in$/i,{exact:true}).filter({visible:true});
   if(!await launcher.count())throw loginStop('SportyBet login control could not be verified. Use --login.');
   await launcher.first().click({timeout:5000});
  }
  await passwordField.waitFor({state:'visible',timeout:8000});
  const matches=page.getByRole('button',{name:/^Log\s*in$/i}).filter({visible:true});
  if(await phoneField.count()!==1||await passwordField.count()!==1||await matches.count()!==1)
   throw loginStop('SportyBet login form could not be verified. Use --login.');
  await check();
  await phoneField.fill(phone,{timeout:3000});
  await passwordField.fill(autoPassword,{timeout:3000});
  await check();
  await matches.click({timeout:4000});
  const deadline=Date.now()+12000;
  while(Date.now()<deadline){
   await check();
   if(await account.isVisible()){console.log('AUTO: SportyBet session restored');return true;}
   if(await page.getByText(/incorrect password|invalid password|wrong password|too many (?:attempts|logins)|account (?:locked|suspended)/i).filter({visible:true}).count())
    throw loginStop('SportyBet rejected automatic sign-in. Use --login to check the account.');
   await delay(500);
  }
  throw loginStop('SportyBet did not confirm sign-in. Use --login to check the account.');
 }catch(error){
  if(error?.fatal)throw error;
  // Do not expose raw automation call logs while credentials are in the form.
  throw loginStop('Automatic SportyBet sign-in could not finish. Use --login to check the account.');
 }
}
async function restoreSessionFromHome(page){
 if(!auto)return;
 await page.goto(sportyHome,{waitUntil:'domcontentloaded',timeout:20000});
 await ensureAutoSession(page);
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
if(!login&&!auto&&!liveTest&&!externalCode&&(!Number.isSafeInteger(max)||max<=0))throw Error('Set ROLLOVER_MAX_STAKE_KOBO to your test stake ceiling in kobo');
const url=new URL('/api/sportybet/virtual-rollover/worker',base);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let stopped=false,browser,profileContext,last=null;
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>{stopped=true;});
async function request(code,results=false,lossReset=false){
 const readStep=lossReset?'loss code allowance reset':results?'final-score lookup':externalCode?'external-code verification':code?'latest-code quote verification':'latest-code lookup';
 const u=new URL(url);
 if(lossReset)u.pathname+='/loss-reset';
 else if(results)u.pathname+='/scores';
 else if(externalCode)u.searchParams.set('external',externalCode);
 else if(code)u.searchParams.set('quote',code);
 const signal=AbortSignal.timeout(20000);
 try{
  const r=await fetch(u,{...(results||lossReset?{method:'POST',body:JSON.stringify(lossReset?code:{legs:code})}:{}),
   headers:{Authorization:'Bearer '+token,...(results||lossReset?{'Content-Type':'application/json'}:{})},redirect:'error',signal});
  if(r.status===401)throw Object.assign(Error('Worker token rejected'),{fatal:true});
  if(!r.ok){
   let source='';
   if([502,503,504].includes(r.status)){
    if(r.headers.get('content-type')?.includes('application/json')){
     const body=await r.json().catch(()=>null);
     if(body?.error==='Roll Over quote unavailable')source='; server could not complete the rollover lookup';
     else if(body?.status==='results_unavailable')source='; server could not retrieve final scores';
     else if(body?.error==='storage unavailable')source='; server reported storage unavailable';
    }else if(r.headers.get('content-type')?.includes('text/html'))source='; gateway returned an HTML error page';
   }
   throw Object.assign(Error('App returned HTTP '+r.status+source),{rolloverReadStatus:r.status,rolloverReadStep:readStep});
  }
  return await r.json();
 }catch(error){
  if(signal.aborted&&signal.reason?.name==='TimeoutError')
   throw Object.assign(Error('App read timed out after 20 seconds'),{rolloverReadTimeout:true,rolloverReadStep:readStep,cause:error});
  throw error;
 }
}
function verifySlip(text,quote,now=Date.now()){
 const normalized=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
 const slip=normalized(text);
 const block=slip.match(/\bremove all\b(.*?)\btype\s+no\./)?.[1];
 const displayed=slip.match(/\bodds\s+(\d+\.\d+)\s+total stake\b/)?.[1];
 if(!block||!displayed)return 'browser_slip_not_confirmed';
 if(!Array.isArray(quote.legs)||quote.legs.length<1||quote.legs.length>RULES.maxLegs||
    !quote.legs.every(leg=>Date.parse(leg.kickoffUtc)>now+20000))return 'browser_slip_closed_or_near_kickoff';
 const rows=[...block.matchAll(/\b(over|under)\s+(\d+\.\d+)\b(.*?)\bo\s*\/\s*u\b/g)].map(m=>({
  pick:m[1]+' '+m[2],match:normalized(m[3]).replace(/\s+(?:vs?\.?|–|—)\s+/g,' v ')
 }));
 if(rows.length!==quote.legs.length)return 'browser_slip_selection_mismatch';
 for(const leg of quote.legs){
  const pick=normalized(leg.pick).replace(/ goals$/,'');
  if(!RULES.markets.some(m=>normalized(m)===pick))return 'browser_rollover_market_not_allowed';
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
    if(text?.length>12000)break;
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
const decimal=kobo=>(kobo/100).toFixed(2);
function amountPattern(kobo){
 const [whole,fraction]=decimal(kobo).split('.');
 const grouped=whole.replace(/\B(?=(\d{3})+(?!\d))/g,',');
 return '(?:'+whole+'|'+grouped+')(?:\\.'+fraction+')'+(fraction==='00'?'?':'');
}
async function waitForLiveReceipt(page,receipt,quote,kobo){
 const heading=page.getByText('About to pay',{exact:true}).filter({visible:true});
 const deadline=Date.now()+10000;
 let confirmedPayment=false;
 while(Date.now()<deadline&&!stopped){
  if(await receipt.first().isVisible())return;
  const dialogs=await heading.count();
  if(dialogs>1)throw Error('Ambiguous payment dialog');
  if(dialogs===1&&!confirmedPayment){
   const matched=await heading.evaluate((label,amount)=>{
    document.querySelectorAll('[data-matchday-pay-dialog]').forEach(el=>el.removeAttribute('data-matchday-pay-dialog'));
    const visible=node=>node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible';
    const text=node=>node.textContent.replace(/\s+/g,' ').trim();
    for(let el=label.parentElement,i=0;el&&el!==document.body&&i<8;el=el.parentElement,i++){
     const labels=[...el.querySelectorAll('*')].filter(visible).map(text);
     if(labels.includes('Place Bet'))break;
     if(labels.includes('Confirm')&&labels.includes('Cancel')){
      if(!labels.some(value=>new RegExp('^NGN\\s+'+amount+'$','i').test(value)))return false;
      el.setAttribute('data-matchday-pay-dialog','yes');
      return true;
     }
    }
    return false;
   },amountPattern(kobo),{timeout:2000});
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
async function attemptLive(page,code,quote,kobo=100000,beforeClick=null){
 const stop=reason=>{throw Error('No submission attempted: '+reason);};
 if(auto)await ensureAutoSession(page);
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
 await stake.fill(String(kobo/100),{timeout:2000});
 await stake.press('Tab',{timeout:2000});
 await submit.click({trial:true,timeout:2000});
 const fresh=await request(code);
 if(fresh.status!=='quote_matches'||fresh.code!==code||fresh.odds!==quote.odds||
    JSON.stringify(fresh.legs)!==JSON.stringify(quote.legs))stop('server quote changed');
 const updated=await readSlip(page,true);
 if(stopped||verifySlip(updated,fresh)!=='browser_slip_verified'||
    !new RegExp('\\btotal stake\\s+'+amountPattern(kobo)+'(?=\\s|$)','i').test(updated)||
    Number((await stake.inputValue({timeout:2000})).replace(/,/g,''))!==kobo/100)stop('slip or total stake changed');
 if(beforeClick)await beforeClick();
 else {
 const lock=await open(testLock,'wx');
 try{await lock.writeFile(JSON.stringify({code,stakeNGN:1000,odds:fresh.odds,time:new Date().toISOString()}));await lock.sync();}
 finally{await lock.close();}
 }
 const orderIds=new Set(),reads=[];
 const capture=response=>{
  const u=new URL(response.url());
  if(!auto||u.origin!=='https://www.sportybet.com'&&u.origin!=='https://sportybet.com'||response.request().method()!=='POST'||!/^\/api\/ng\/(?:realSportsGame\/order|orders\/(?:order|bet|placeBet))$/i.test(u.pathname))return;
  reads.push(response.json().then(body=>{
   if(body?.bizCode!==10000)return;
   for(const row of [body.data,...(Array.isArray(body.data)?body.data:[]),body.data?.order]){
    if(typeof row?.orderId==='string'&&/^\d+ord\d+$/i.test(row.orderId))orderIds.add(row.orderId);
   }
  }).catch(()=>{}));
 };
 if(auto)page.on('response',capture);
 try{
  await submit.click({timeout:2000});
  const receipt=page.getByText('Submission Successful',{exact:true});
  await waitForLiveReceipt(page,receipt,fresh,kobo);
  const confirmed=await receipt.evaluate((label,amount)=>{
   for(let el=label.parentElement;el&&el!==document.body;el=el.parentElement){
    const text=el.innerText;
    if(text.length>1600)break;
    if(/Check Bet History/i.test(text)&&new RegExp('\\bTotal Stake\\s+'+amount+'(?=\\s|$)','i').test(text))return true;
   }
   return false;
  },amountPattern(kobo));
  if(!confirmed)throw Error('Receipt not verified');
  if(auto){
   await Promise.race([Promise.allSettled(reads),delay(2000)]);
   if(orderIds.size!==1)throw Error('Exact order ID unavailable');
   return {id:[...orderIds][0],stakeKobo:kobo};
  }
  return 'submission_success_shown';
 }catch{
  throw Error('Submission outcome unknown. Check SportyBet Bet History. Do not retry.');
 }finally{if(auto)page.off('response',capture);}
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
async function emptyBetslipEvidence(page){
 return page.evaluate(()=>{
  const visible=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility==='visible';
  const text=el=>el.innerText?.replace(/\s+/g,' ').trim()||'';
  const inputs=[...document.querySelectorAll('input')].filter(el=>visible(el)&&
   /^booking\s*code$/i.test(el.placeholder.trim())&&!el.value.trim());
  const panels=new Set();
  for(const input of inputs){
   for(let el=input.parentElement,depth=0;el&&el!==document.body&&depth<12;el=el.parentElement,depth++){
    const value=text(el);
    if(value.length>1600)break;
    const headings=[...el.querySelectorAll('*')].filter(node=>visible(node)&&/^betslip(?:\s*\d+)?$/i.test(text(node)));
    const hasLoad=[...el.querySelectorAll('*')].some(node=>visible(node)&&/^load$/i.test(text(node)));
    if(!headings.length||!hasLoad)continue;
    if(headings.some(node=>/^betslip\s*[1-9]\d*$/i.test(text(node)))||
       /\b(?:remove all|accept changes|total stake|potential win|place bet|unavailable)\b/i.test(value)||
       /\bo\s*\/\s*u\b/i.test(value))break;
    panels.add(el);break;
   }
  }
  return {bookingInputs:inputs.length,emptyPanels:panels.size};
 });
}
async function clearSavedBetslip(page){
 const response=await page.goto(sportyHome,{waitUntil:'domcontentloaded',timeout:20000});
 const url=new URL(page.url());
 if(!response?.ok()||url.protocol!=='https:'||!['www.sportybet.com','sportybet.com'].includes(url.hostname))return 'browser_cart_home_unavailable';
 await ensureAutoSession(page);
 const heading=page.getByText(/^Betslip(?:\s*\d+)?$/i).filter({visible:true});
 try{await heading.first().waitFor({state:'visible',timeout:5000});}
 catch(error){if(error.name==='TimeoutError')return 'browser_cart_heading_not_visible';throw error;}
 const remove=page.getByText('Remove All',{exact:true}).filter({visible:true});
 const loading=page.locator('.m-betslips-loading:visible');

 const rows=page.locator('.m-betslips .m-list .m-item:visible');
 const rowRemove=page.locator('.m-betslips .m-list .m-item .m-item-play i.m-icon-delete:visible');
 let clicked=false,confirmed=false,emptyReads=0,rowRemovalPending=null;
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
  const rowCount=await rows.count();
  if(rowRemovalPending!==null){
   if(rowCount>=rowRemovalPending){await delay(500);continue;}
   rowRemovalPending=null;
  }
  if(count===1&&!clicked){
   if(auto)console.log('AUTO: removing the old betslip selection');
   // The overlay can reappear between the check and click. Let Playwright
   // wait for a normal, actionable click; never force it through.
   try{await remove.click({timeout:Math.max(1,deadline-Date.now())});}
   catch(error){if(error.name==='TimeoutError')return 'browser_cart_remove_button_blocked';throw error;}
   clicked=true;
   emptyReads=0;
  }else if(count===0&&rowCount>0&&(!clicked||confirmed)){
   // SportyBet hides Remove All for a single stale selection.
   const first=rows.first().locator('.m-item-play i.m-icon-delete:visible');
   if(await rowRemove.count()!==rowCount||await first.count()!==1)
    return 'browser_cart_row_remove_unverified';
   if(stopped)return 'browser_cart_check_stopped';
   if(auto)console.log('AUTO: removing the old betslip selection');
   try{await first.click({timeout:Math.max(1,deadline-Date.now())});}
   catch(error){if(error.name==='TimeoutError')return 'browser_cart_row_remove_blocked';throw error;}
   rowRemovalPending=rowCount;
   emptyReads=0;
  }else if(count===0&&rowCount===0&&!(await loading.count())){
   const evidence=await emptyBetslipEvidence(page);
   if(evidence.bookingInputs===1&&evidence.emptyPanels===1){
    if(++emptyReads===4)return 'browser_cart_empty';
   }else emptyReads=0;
  }else emptyReads=0;
  await delay(500);
 }
 if(await loading.count())return 'browser_cart_loading_timeout';
 if(rowRemovalPending!==null)return 'browser_cart_row_removal_not_confirmed';
 const {bookingInputs,emptyPanels}=await emptyBetslipEvidence(page);
 return (confirmed?'browser_cart_still_full_after_confirmation':clicked?'browser_cart_remove_not_confirmed':'browser_cart_empty_not_verified')+
  ' (booking fields: '+bookingInputs+', empty panels: '+emptyPanels+')';
}
async function inspect(code,quote,kobo,beforeClick){
 if(!review)browser??=await chromium.launch({headless:true});
 const ctx=review?profileContext:await browser.newContext();
 let page;
 try{
  page=await ctx.newPage();
  if(auto)console.log('AUTO: checking login and clearing the cart before',code);
  if(review){
   const cart=await clearSavedBetslip(page);
   if(cart!=='browser_cart_empty')return cart;
   if(auto&&!(await page.getByText('My Account',{exact:true}).first().isVisible()))return 'browser_not_logged_in';
   if(auto)console.log('AUTO: logged in and the cart is empty');
  }
  const link=new URL(sportyHome);
  link.searchParams.set('shareCode',code);
  const openTicket=async()=>{
   const response=await page.goto(link.href,{waitUntil:'domcontentloaded',timeout:20000});
   const host=new URL(page.url()).hostname;
   return Boolean(response?.ok()&&['www.sportybet.com','sportybet.com'].includes(host));
  };
  if(!await openTicket())return 'browser_page_unavailable';
  if(auto&&await ensureAutoSession(page)){
   console.log('AUTO: signed in on the ticket page; reloading',code);
   if(!await openTicket())return 'browser_page_unavailable';
  }
  if(auto&&!(await page.getByText('My Account',{exact:true}).first().isVisible()))return 'browser_not_logged_in';
  const slipDeadline=Date.now()+45000;
  const changed=page.getByText('Accept Changes',{exact:true}).filter({visible:true});
  while(!stopped&&Date.now()<slipDeadline){
   if(await changed.count())return 'browser_slip_requires_accept_changes';
   const status=verifySlip(await readSlip(page),quote);
   if(status==='browser_slip_verified'&&(liveTest||auto))return await attemptLive(page,code,quote,kobo,beforeClick);
   if(status!=='browser_slip_not_confirmed')return status;
   await delay(750);
  }
  return 'browser_slip_not_confirmed';
 }finally{if(review)await page?.close();else await ctx.close();}
}
async function tick(){
 if(externalCode){
  const quote=await request(externalCode);
  if(quote.status!=='quote_matches'||quote.code!==externalCode||!validRolloverOdds(quote.odds)){
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
 if(liveTest&&(quote.code!==ticket.code||!validRolloverOdds(quote.odds)))throw Error('No submission attempted: invalid RDP quote');
 const status=await inspect(ticket.code,quote);
 if(liveTest){console.log('ONE-SHOT:',ticket.code,quote.odds+'x','₦1,000',status);return;}
 console.log('DRY RUN:',ticket.code,quote.odds+'x','₦'+(ticket.stakeKobo/100).toFixed(2),status);
 last=ticket.code;
}
const ledgerPath=join(profile,'live-rollover-state-v1.json');
async function saveLedger(value){
 const temp=ledgerPath+'.new';
 const file=await open(temp,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value));await file.sync();}
 finally{await file.close();}
 await rename(temp,ledgerPath);
}
async function accountOrder(id){
 const page=await profileContext.newPage();
 try{
  const response=page.waitForResponse(r=>{
   const u=new URL(r.url());
   return /^https:\/\/(?:www\.)?sportybet\.com$/.test(u.origin)&&u.pathname==='/api/ng/realSportsGame/order'&&
    u.searchParams.get('orderId')===id&&r.request().method()==='GET'&&r.ok();
  },{timeout:15000}).catch(()=>null);
  await page.goto(new URL('m/my_accounts/open_bets/bet_history/detail/'+encodeURIComponent(id)+'/bet_detail',sportyHome).href,
    {waitUntil:'domcontentloaded',timeout:15000});
  const hit=await response;
  if(!hit){await restoreSessionFromHome(page);return null;}
  return await hit.json();
 }finally{await page.close();}
}
function historyStakeKobo(value){
 if(typeof value!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(value))return null;
 const [whole,fraction='']=value.split('.');
 const kobo=Number(whole+fraction.padEnd(2,'0'));
 return Number.isSafeInteger(kobo)?kobo:null;
}
function matchHistoryOrder(body,attempt,time){
 if(body?.bizCode!==10000||!Array.isArray(body.data?.entityList)||
    !Number.isFinite(time)||!Array.isArray(attempt?.legs)||!attempt.legs.length||
    !Number.isSafeInteger(attempt.stakeKobo)||attempt.stakeKobo<=0)return null;
 const key=leg=>JSON.stringify([leg.eventId,String(leg.marketId),String(leg.outcomeId),leg.specifier]);
 const expected=JSON.stringify(attempt.legs.map(key).sort());
 const matches=body.data.entityList.filter(row=>{
  if(typeof row?.orderId!=='string'||!/^\d+ord\d+$/i.test(row.orderId)||
     row.currency!=='NGN'||row.paymentType!==0||row.isPaymentInProgress!==false||
     !Number.isSafeInteger(row.createTime)||row.createTime<time-30000||row.createTime>time+120000||
     historyStakeKobo(row.totalStake)!==attempt.stakeKobo||!Array.isArray(row.selections))return false;
  if(Number.isFinite(attempt.odds)){
   const actualOdds=row.selections.reduce((n,leg)=>n*Number(leg.odds),1);
   if(!Number.isFinite(actualOdds)||Math.abs(actualOdds-attempt.odds)>0.005)return false;
  }
  return JSON.stringify(row.selections.map(key).sort())===expected;
 });
 return matches.length===1?{id:matches[0].orderId,stakeKobo:attempt.stakeKobo}:null;
}
async function recoverFromBetHistory(ledger,rules){
 const when=ledger.attempt.startedAt??(await stat(ledgerPath)).mtimeMs;
 const page=await profileContext.newPage();
 try{
  const response=page.waitForResponse(r=>{
   const u=new URL(r.url());
   return /^https:\/\/(?:www\.)?sportybet\.com$/.test(u.origin)&&u.pathname==='/api/ng/orders/order/v2/realbetlist'&&
    r.request().method()==='GET'&&r.ok();
  },{timeout:15000}).catch(()=>null);
  await page.goto(new URL('my_accounts/bet_history/sport_bets',sportyHome).href,
    {waitUntil:'domcontentloaded',timeout:15000});
  const hit=await response;
  if(!hit){await restoreSessionFromHome(page);return false;}
  const first=await hit.json();
  let receipt=matchHistoryOrder(first,ledger.attempt,when);
  // Use the captured All and Settled filters; either view can contain
  // the exact order while a wager transitions out of Running.
  if(!receipt){
   const other=new URL(hit.url());
   const filter=other.searchParams.get('isSettled');
   if(filter==='10'||filter==='1'){
    other.searchParams.set('isSettled',filter==='10'?'1':'10');
    other.searchParams.set('_t',String(Date.now()));
    const body=await page.evaluate(async url=>{
     const res=await fetch(url,{credentials:'same-origin',redirect:'error'});
     return res.ok?res.json():null;
    },other.href).catch(()=>null);
    receipt=matchHistoryOrder(body,ledger.attempt,when);
   }
  }
  if(!receipt)return false;
  ledger.state=rules.acceptReceipt(ledger.state,receipt);
  await saveLedger(ledger);
  console.log('AUTO: recovered existing bet',ledger.attempt.code,'₦'+decimal(receipt.stakeKobo),'; waiting for settlement');
  return true;
 }finally{await page.close();}
}
const retryableAppRead=error=>error?.rolloverReadTimeout===true||[502,503,504].includes(error?.rolloverReadStatus);
async function autoLoop(){
 const rules=require('./rollover-run-state.cjs');
 const {reconcileAccount}=require('./rollover-reconcile-account.cjs');
 let ledger;
 try{ledger=JSON.parse(await readFile(ledgerPath,'utf8'));}
 catch(error){if(error.code!=='ENOENT')throw error;ledger={state:rules.initial(),attempt:null,lastCode:null,usedCodes:[]};}
 if(!ledger.attempt&&!ledger.state.pending&&!ledger.state.awaitingReset&&
    ledger.state.wins===0&&((ledger.state.runOpeningStakeKobo==null&&ledger.state.stakeKobo===200000)||
    (ledger.state.runOpeningStakeKobo===500000&&ledger.state.stakeKobo===500000))){
  ledger.state.stakeKobo=RULES.openingStakeKobo;
  ledger.state.runOpeningStakeKobo=RULES.openingStakeKobo;
  await saveLedger(ledger);
 }
 console.log(`Automatic rollover armed · ₦${(RULES.openingStakeKobo/100).toLocaleString('en-NG')} start · ${RULES.targetTicketWins} ticket wins · pause after ${RULES.maxConsecutiveLosses} consecutive losses. Real wagers enabled.`);
 console.log('AUTO: opening SportyBet to check login');
 const home=profileContext.pages()[0]??await profileContext.newPage();
 await restoreSessionFromHome(home);
 let lastWait='';
 const reportWait=message=>{if(message!==lastWait){lastWait=message;console.log('AUTO: '+message);}};
 while(!stopped){
  try{
  const previousState=ledger.state;
  ledger.state=rules.refresh(previousState);
  if(ledger.state.day!==previousState.day||ledger.state.consecutiveLosses!==previousState.consecutiveLosses||
     ledger.state.awaitingReset!==previousState.awaitingReset){await saveLedger(ledger);lastWait='';}
  if(ledger.attempt&&!ledger.state.pending){
   let recovered=false;
   try{recovered=await recoverFromBetHistory(ledger,rules);}
   catch(error){if(error.fatal||ledger.state.pending)throw error;}
   if(!recovered)console.log('AUTO: waiting for the existing order to appear in Bet History; new bets paused.');
  }else if(ledger.state.pending){
   const detail=await accountOrder(ledger.state.pending.id);
   let result=reconcileAccount(ledger.state,detail,[]);
   if(result.reason==='zero_payout_without_verified_losing_selection'){
    const final=await request(ledger.attempt.legs,true);
    result=reconcileAccount(ledger.state,detail,final.status==='verified_results'?final.results:[]);
   }
   if(result.state==='settled'){
    ledger.state=result.stateAfter;
    ledger.attempt=null;
    lastWait='';
    await saveLedger(ledger);
    console.log(result.settlement.status.toUpperCase(),'return ₦'+decimal(result.settlement.payoutKobo),
      ledger.state.awaitingReset?'next run at 00:00 WAT':'next ₦'+decimal(ledger.state.stakeKobo),
      ledger.state.wins+'/'+RULES.targetTicketWins+' wins',ledger.state.consecutiveLosses+'/'+RULES.maxConsecutiveLosses+' consecutive losses');
    if(!stopped&&!ledger.state.awaitingReset)continue;
   }else if(result.state!=='pending'){
    reportWait('waiting for verified account settlement: '+result.reason);
   }else reportWait('the existing bet is still unsettled in Bet History.');
  }else if(ledger.state.awaitingReset){
   reportWait('four consecutive losses; next run starts at 00:00 WAT.');
  }else{
   const ticket=await request();
   if(ticket.status!=='pending')reportWait('waiting for a new ticket: '+ticket.status);
   else if((ledger.usedCodes||[]).includes(ticket.code))reportWait('waiting for a new code; '+ticket.code+' was already used.');
   if(ticket.status==='pending'&&/^[A-Z0-9]{4,32}$/i.test(ticket.code)&&!(ledger.usedCodes||[]).includes(ticket.code)&&ticket.code!==last){
    const quote=await request(ticket.code);
    if(quote.status==='quote_matches'&&quote.code===ticket.code&&validRolloverOdds(quote.odds)&&
       quote.legs.every(leg=>typeof leg.eventId==='string'&&leg.marketId==='18'&&typeof leg.specifier==='string')){
     const kobo=ledger.state.stakeKobo;
     let receipt;
     try{
      receipt=await inspect(ticket.code,quote,kobo,async()=>{
       ledger.attempt={code:ticket.code,stakeKobo:kobo,legs:quote.legs,odds:quote.odds,startedAt:Date.now()};
       ledger.lastCode=ticket.code;
       ledger.usedCodes=[...(ledger.usedCodes||[]),ticket.code];
       await saveLedger(ledger);
      });
     }catch(error){
      if(ledger.attempt){
       console.log('AUTO: submission needs Bet History verification; new bets paused.');
       if(!stopped)await delay(10000);
       continue;
      }
      if(error.fatal||retryableAppRead(error))throw error;
      console.log('AUTO: skipped before submission:',error.message.split('\n')[0]);
     }
     if(receipt&&typeof receipt==='object'){
      const detail=await accountOrder(receipt.id);
      const rows=detail?.bizCode===10000&&Array.isArray(detail.data)?detail.data.filter(row=>row.orderId===receipt.id):[];
      const key=leg=>JSON.stringify([leg.eventId,String(leg.marketId),String(leg.outcomeId),leg.specifier]);
      const actual=rows[0]?.selections?.map(key).sort();
      const expected=quote.legs.map(key).sort();
      if(rows.length!==1||rows[0].currency!=='NGN'||rows[0].stake!==kobo*100||Math.abs(Number(rows[0].totalOdds)-quote.odds)>0.005||!Number.isFinite(Number(rows[0].totalOdds))||
         !actual||JSON.stringify(actual)!==JSON.stringify(expected))
       throw Error('Order receipt could not be matched to the exact slip. Check Bet History; do not retry.');
      ledger.state=rules.acceptReceipt(ledger.state,receipt);
      await saveLedger(ledger);
      console.log('AUTO: placed',ticket.code,'₦'+decimal(kobo),quote.odds+'x');
     }else if(receipt){
      // The share page was slow or still drawing. Keep this code until it is
      // placed or the server withdraws it. Do not burn it on the first miss.
      if(receipt==='browser_slip_not_confirmed'||receipt==='browser_page_unavailable'||receipt==='browser_not_logged_in'||String(receipt).startsWith('browser_cart_')){
       console.log('AUTO: slip not ready for',ticket.code,receipt+'; retrying this same ticket.');
      }else{
       last=ticket.code;
       console.log('AUTO: skipped',ticket.code,receipt);
      }
     }
    }
   }
  }
  }catch(error){
   if(!retryableAppRead(error))throw error;
   console.warn('AUTO: '+(error.rolloverReadStep??'server read')+' failed: '+error.message+'; waiting for the next check.');
  }
  if(!stopped)await delay(10000);
 }
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
  if(auto){await autoLoop();return;}
  if(liveTest||externalCode){await tick();return;}
  console.log(review?'Roll Over profile review started. No wagers can be submitted.':'Roll Over dry run started. No wagers can be submitted.');
  while(!stopped){
   try{await tick();}catch(err){if(err.fatal)throw err;console.error('DRY RUN:',err.message);}
   if(!stopped)await delay(10000);
  }
 }finally{await profileContext?.close();await browser?.close();}
})().catch(err=>{console.error(err.message);process.exitCode=1;});
