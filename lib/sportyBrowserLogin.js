'use strict';

function failure(message,reason,requiresUserAction=false) {
  return Object.assign(new Error(message),{code:'SPORTYBET_AUTH_FAILED',reason,requiresUserAction});
}
function currentAuthCookie(cookies,now=Date.now()) {
  return cookies.some(cookie=>cookie.name==='accessToken'&&cookie.value&&(!cookie.expires||cookie.expires<0||cookie.expires*1000>now));
}
async function blockingStep(page) {
  const otp=page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="verification" i]');
  for(let i=0;i<await otp.count();i++)if(await otp.nth(i).isVisible()) {
    throw failure('SportyBet requires a verification code before automatic sign-in can continue.','verification_required',true);
  }
  const text=await page.locator('body').innerText({timeout:3000});
  if(/verify you are human|checking your browser|unusual traffic|robot verification|captcha|access denied.*(?:security|automated)/i.test(text)) {
    throw failure('SportyBet requires browser verification; automatic sign-in has stopped.','browser_verification_required',true);
  }
  if(/incorrect password|invalid password|wrong password|account.*(?:locked|suspended)|too many.*(?:login|sign.in)|looks like we.re having trouble|something went wrong/i.test(text)) {
    throw failure('SportyBet rejected browser sign-in. Check the dummy account or complete its verification.','sign_in_rejected',true);
  }
}

// Uses the site's own observed form and JavaScript encryption. It never
// guesses ciphertext or solves verification, and never visits betting flows.
async function browserLogin({siteOrigin,baseUrl,userInfo,phone,password,cookies=[],timeoutMs=90000},deps={}) {
  const site=new URL(siteOrigin),account=new URL(baseUrl+userInfo);
  const trusted=url=>url.protocol==='https:'&&['sportybet.com','www.sportybet.com','sportybet.com.ng','www.sportybet.com.ng'].includes(url.hostname);
  if(!(trusted(site)&&trusted(account))&&!deps.allowTestOrigin)throw failure('Browser sign-in requires the official SportyBet HTTPS origin.','invalid_login_origin',true);
  if(!phone||!password)throw failure('Set SPORTYBET_PHONE and SPORTYBET_PASSWORD for automatic dummy-account sign-in.','credentials_required',true);
  let chromium=deps.chromium;
  if(!chromium)try{({chromium}=require('playwright'));}catch{
    throw failure('Install browser recovery with npm ci and npm run browser:install on the server.','browser_not_installed',true);
  }
  let browser,timer,timedOut=false;
  try {
    browser=await chromium.launch({headless:true,timeout:Math.min(timeoutMs,30000)});
    timer=setTimeout(()=>{timedOut=true;void browser.close().catch(()=>{});},timeoutMs);
    timer.unref?.();
    const context=await browser.newContext({locale:'en-NG'});
    const seed=cookies.filter(c=>c.value&&(!c.expiresAt||c.expiresAt>Date.now())).map(c=>({name:c.name,value:c.value,url:site.origin,
      ...(c.expiresAt?{expires:Math.floor(c.expiresAt/1000)}:{})}));
    if(seed.length)await context.addCookies(seed);
    const page=await context.newPage();page.setDefaultTimeout(10000);
    await page.goto(site.origin+'/ng/',{waitUntil:'domcontentloaded',timeout:30000});
    if(new URL(page.url()).origin!==site.origin)throw failure('SportyBet sign-in redirected to a different origin; credentials were not entered.','unexpected_login_origin',true);
    await blockingStep(page);
    const verify=async()=>{
      const current=await context.cookies(site.origin);
      if(!currentAuthCookie(current))return null;
      const response=await context.request.get(account.href,{headers:{clientid:'web',operid:'2',platform:'web',Referer:site.origin+'/ng/'},timeout:10000});
      let payload;try{payload=await response.json();}catch{return null;}
      return response.ok()&&Number(payload?.bizCode)===10000?await context.cookies(site.origin):null;
    };
    let verified=await verify();
    if(!verified) {
      const phoneField=page.locator('input[name="phone"]:visible');
      const passwordField=page.locator('input[name="psd"][type="password"]:visible');
      const submit=page.getByRole('button',{name:'Login',exact:true});
      if(await phoneField.count()!==1||await passwordField.count()!==1||await submit.count()!==1) {
        throw failure('SportyBet sign-in form changed; the browser adapter needs an update.','login_form_changed',true);
      }
      // The observed Nigeria form already supplies +234 separately.
      const localPhone=String(phone).replace(/\D/g,'').replace(/^234(?=\d{10}$)/,'').replace(/^0(?=\d{10}$)/,'');
      await phoneField.fill(localPhone);await passwordField.fill(String(password));await submit.click();
      const until=Date.now()+timeoutMs;
      while(!verified&&Date.now()<until&&!timedOut) {
        await blockingStep(page);
        if(new URL(page.url()).origin!==site.origin)throw failure('SportyBet sign-in moved to another origin.','unexpected_login_origin',true);
        verified=await verify();
        if(!verified)await page.waitForTimeout(1000);
      }
    }
    if(!verified)throw failure('SportyBet did not verify automatic browser sign-in before the time limit.','browser_login_timeout');
    // Export only first-party cookies; no screenshots, traces, HTML or token
    // values appear in logs or public responses.
    return {cookies:verified.map(c=>({name:c.name,value:c.value,expiresAt:c.expires>0?c.expires*1000:null})),verifiedAt:Date.now()};
  }catch(err){
    if(err.code==='SPORTYBET_AUTH_FAILED')throw err;
    if(timedOut)throw failure('Automatic SportyBet browser sign-in timed out.','browser_login_timeout');
    // Playwright call logs can contain filled values. Never surface them.
    if(browser)throw failure('Automatic browser sign-in failed; recovery will retry after its cooldown.','browser_login_error');
    throw failure('Chromium could not start. Run npm run browser:install and use a host with browser dependencies.','browser_unavailable',true);
  }finally{
    clearTimeout(timer);if(browser)await browser.close().catch(()=>{});
  }
}
module.exports={browserLogin,currentAuthCookie};
