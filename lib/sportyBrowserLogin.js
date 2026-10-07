'use strict';
const {configureBrowserPath} = require('./sportyBrowserRuntime');
const {safeAuthDiagnostics,networkCode} = require('./sportyAuthDiagnostics');

function failure(message,reason,requiresUserAction=false,details={}) {
  const error=Object.assign(new Error(message),{code:'SPORTYBET_AUTH_FAILED',reason,requiresUserAction,...details});
  error.diagnostics=safeAuthDiagnostics(error);
  const fields=['stage','pageCheck','pageCheckAttempt','networkCode','httpStatus','bizCode'].filter(key=>error.diagnostics[key]!==undefined);
  if(fields.length)error.message+=' ('+fields.map(key=>key+'='+error.diagnostics[key]).join(', ')+')';
  return error;
}
function browserProxy(value) {
  if(!value)return null;
  try {
    const url=new URL(value);
    if(!['http:','https:','socks5:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)throw Error('invalid');
    if(url.protocol==='socks5:'&&(url.username||url.password))throw failure('Chromium does not support authentication for this SOCKS proxy configuration.','browser_proxy_auth_unsupported',true,{stage:'configuration',proxyConfigured:true});
    return {server:url.protocol+'//'+url.host,
      ...(url.username?{username:decodeURIComponent(url.username)}:{}),...(url.password?{password:decodeURIComponent(url.password)}:{})};
  }catch(error){
    if(error.code==='SPORTYBET_AUTH_FAILED')throw error;
    throw failure('The configured SportyBet browser proxy is invalid. Check SPORTYBET_PROXY_URL.','browser_proxy_invalid',true,{stage:'configuration',proxyConfigured:true});
  }
}
function currentAuthCookie(cookies,now=Date.now()) {
  return cookies.some(cookie=>cookie.name==='accessToken'&&cookie.value&&(!cookie.expires||cookie.expires<0||cookie.expires*1000>now));
}
async function blockingStep(page,{onCheck=()=>{}}={}) {
  // A full-body innerText read requires rendered text for the whole odds board.
  // Check only visible verification controls and messages. A transient page
  // timeout must finish a complete check before credentials can be entered.
  for(let attempt=1;attempt<=2;attempt++)try{
    onCheck('body_ready',attempt);
    await page.locator('body').waitFor({state:'attached',timeout:15000});
    onCheck('verification_inputs',attempt);
    if(await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="verification" i]').filter({visible:true}).count()) {
      throw failure('SportyBet requires a verification code before automatic sign-in can continue.','verification_required',true);
    }
    onCheck('verification_messages',attempt);
    if(await page.getByText(/verify you are human|checking your browser|unusual traffic|robot verification|captcha|access denied.*(?:security|automated)/i).filter({visible:true}).count()) {
      throw failure('SportyBet requires browser verification; automatic sign-in has stopped.','browser_verification_required',true);
    }
    onCheck('rejection_messages',attempt);
    if(await page.getByText(/incorrect password|invalid password|wrong password|account.*(?:locked|suspended)|too many.*(?:login|sign.in)|looks like we.re having trouble|something went wrong/i).filter({visible:true}).count()) {
      throw failure('SportyBet rejected browser sign-in. Check the dummy account or complete its verification.','sign_in_rejected',true);
    }
    return;
  }catch(error){
    if(error.name!=='TimeoutError'||attempt===2)throw error;
    await page.waitForTimeout(250);
  }
}

// Uses the site's own observed form and JavaScript encryption. It never
// guesses ciphertext or solves verification, and never visits betting flows.
async function browserLogin({siteOrigin,baseUrl,userInfo,phone,password,cookies=[],proxyUrl='',timeoutMs=90000},deps={}) {
  const site=new URL(siteOrigin),account=new URL(baseUrl+userInfo);
  const trusted=url=>url.protocol==='https:'&&['sportybet.com','www.sportybet.com','sportybet.com.ng','www.sportybet.com.ng'].includes(url.hostname);
  if(!(trusted(site)&&trusted(account))&&!deps.allowTestOrigin)throw failure('Browser sign-in requires the official SportyBet HTTPS origin.','invalid_login_origin',true);
  if(!phone||!password)throw failure('Set SPORTYBET_PHONE and SPORTYBET_PASSWORD for automatic dummy-account sign-in.','credentials_required',true);
  const proxy=browserProxy(proxyUrl);
  configureBrowserPath();
  let chromium=deps.chromium;
  if(!chromium)try{({chromium}=require('playwright'));}catch{
    throw failure('Install the project with npm ci or npm install, then redeploy for automatic browser recovery.','browser_not_installed',true);
  }
  let browser,timer,timedOut=false,stage='launch',httpStatus=null,bizCode=null,pageCheck=null,pageCheckAttempt=null;
  const details=()=>({stage,proxyConfigured:Boolean(proxy),...(httpStatus?{httpStatus}:{}),...(bizCode?{bizCode}:{}),
    ...(['page_check','verification'].includes(stage)&&pageCheck?{pageCheck,pageCheckAttempt}:{})});
  const checkPage=page=>blockingStep(page,{onCheck:(check,attempt)=>{pageCheck=check;pageCheckAttempt=attempt;}});
  try {
    browser=await chromium.launch({headless:true,timeout:Math.min(timeoutMs,30000),...(proxy?{proxy}:{})});
    timer=setTimeout(()=>{timedOut=true;void browser.close().catch(()=>{});},timeoutMs);
    timer.unref?.();
    stage='context';
    const context=await browser.newContext({locale:'en-NG'});
    stage='cookies';
    const seed=cookies.filter(c=>c.value&&(!c.expiresAt||c.expiresAt>Date.now())).map(c=>({name:c.name,value:c.value,url:site.origin,
      ...(c.expiresAt?{expires:Math.floor(c.expiresAt/1000)}:{})}));
    if(seed.length)await context.addCookies(seed);
    stage='context';
    const page=await context.newPage();page.setDefaultTimeout(10000);
    stage='navigation';
    const navigation=await page.goto(site.origin+'/ng/',{waitUntil:'domcontentloaded',timeout:30000});
    httpStatus=navigation?.status()||null;
    if(new URL(page.url()).origin!==site.origin)throw failure('SportyBet sign-in redirected to a different origin; credentials were not entered.','unexpected_login_origin',true);
    stage='page_check';
    await checkPage(page);
    if(httpStatus>=400)throw failure('SportyBet returned an error for the login page.','browser_login_http_error',[401,403,429].includes(httpStatus),details());
    const verify=async()=>{
      stage='account_check';
      httpStatus=bizCode=null;
      const current=await context.cookies(site.origin);
      if(!currentAuthCookie(current))return null;
      // One transient verification failure may recover without submitting
      // the password again. Never export a session that was not verified.
      for(let attempt=0;attempt<2;attempt++){
        let response;
        try{response=await context.request.get(account.href,{headers:{clientid:'web',operid:'2',platform:'web',Referer:site.origin+'/ng/'},timeout:10000});}
        catch(error){if(attempt===0&&(networkCode(error)||error.name==='TimeoutError'))continue;throw error;}
        httpStatus=response.status();
        if(httpStatus>=500&&attempt===0)continue;
        if(httpStatus>=400&&httpStatus!==401)throw failure('SportyBet account verification returned an HTTP error.','browser_account_http_error',[403,404,405,429].includes(httpStatus),details());
        if(httpStatus===401)return null;
        let payload;
        try{payload=await response.json();}catch{throw failure('SportyBet account verification did not return usable JSON.','browser_account_response_error',false,details());}
        bizCode=Number.isInteger(Number(payload?.bizCode))?Number(payload.bizCode):null;
        return response.ok()&&bizCode===10000?await context.cookies(site.origin):null;
      }
      return null;
    };
    let verified=await verify();
    if(!verified) {
      const phoneField=page.locator('input[name="phone"]:visible');
      const passwordField=page.locator('input[name="psd"][type="password"]:visible');
      const submit=page.getByRole('button',{name:'Login',exact:true});
      stage='form_ready';
      // DOMContentLoaded can precede the site's form hydration.
      await Promise.all([phoneField.waitFor({state:'visible',timeout:10000}),passwordField.waitFor({state:'visible',timeout:10000}),submit.waitFor({state:'visible',timeout:10000})]);
      if(await phoneField.count()!==1||await passwordField.count()!==1||await submit.count()!==1) {
        throw failure('SportyBet sign-in form changed; the browser adapter needs an update.','login_form_changed',true);
      }
      // Verification can appear while the page hydrates. Complete the same
      // checks again immediately before entering the dummy credentials.
      stage='page_check';await checkPage(page);
      if(new URL(page.url()).origin!==site.origin)throw failure('SportyBet sign-in moved to another origin.','unexpected_login_origin',true);
      // The observed Nigeria form already supplies +234 separately.
      const localPhone=String(phone).replace(/\D/g,'').replace(/^234(?=\d{10}$)/,'').replace(/^0(?=\d{10}$)/,'');
      stage='phone_entry';await phoneField.fill(localPhone);
      stage='password_entry';await passwordField.fill(String(password));
      const remember=page.locator('input[name="keepSignedIn"][type="checkbox"]:visible');
      if(await remember.count()===1){stage='remember_session';await remember.check();}
      stage='submit';await submit.click();
      const until=Date.now()+timeoutMs;
      while(!verified&&Date.now()<until&&!timedOut) {
        stage='verification';
        await checkPage(page);
        if(new URL(page.url()).origin!==site.origin)throw failure('SportyBet sign-in moved to another origin.','unexpected_login_origin',true);
        verified=await verify();
        if(!verified)await page.waitForTimeout(1000);
      }
    }
    if(!verified)throw failure('SportyBet did not verify automatic browser sign-in before the time limit.','browser_login_timeout',false,details());
    // Export only first-party cookies; no screenshots, traces, HTML or token
    // values appear in logs or public responses.
    return {cookies:verified.map(c=>({name:c.name,value:c.value,expiresAt:c.expires>0?c.expires*1000:null})),verifiedAt:Date.now()};
  }catch(err){
    if(err.code==='SPORTYBET_AUTH_FAILED'){
      if(!err.diagnostics?.stage)throw failure(err.message,err.reason,err.requiresUserAction,details());
      throw err;
    }
    if(timedOut)throw failure('Automatic SportyBet browser sign-in timed out.','browser_login_timeout',false,details());
    // Playwright call logs can contain filled values. Never surface them.
    const network=networkCode(err);
    if(network)throw failure('SportyBet browser networking failed; recovery will retry after its cooldown.','browser_network_error',false,{...details(),networkCode:network});
    if(err.name==='TimeoutError')throw failure(stage==='navigation'?'SportyBet login page navigation timed out.':stage==='form_ready'?'SportyBet login controls did not become ready.':'A SportyBet browser step timed out.',
      stage==='navigation'?'browser_navigation_timeout':stage==='form_ready'?'browser_form_timeout':'browser_page_timeout',false,details());
    if(browser?.isConnected&&!browser.isConnected())throw failure('The SportyBet browser closed before sign-in could be verified.','browser_closed',false,details());
    if(browser)throw failure('Automatic browser sign-in failed; recovery will retry after its cooldown.',stage==='cookies'?'browser_cookie_seed_failed':stage==='context'?'browser_context_failed':'browser_login_error',false,details());
    throw failure('Chromium could not start. Run npm run browser:install and use a host with browser dependencies.','browser_unavailable',true,details());
  }finally{
    clearTimeout(timer);if(browser)await browser.close().catch(()=>{});
  }
}
module.exports={browserLogin,currentAuthCookie};
