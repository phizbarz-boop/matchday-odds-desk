'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {browserLogin}=require('../lib/sportyBrowserLogin');
require('../lib/sportyBrowserRuntime').configureBrowserPath();
const {chromium}=require('playwright');
const testChromium={launch:options=>chromium.launch({...options,
  ...(process.env.PLOT207_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.PLOT207_TEST_BROWSER_EXECUTABLE}:{})})};
function instrumentedChromium(instrument){
  return {launch:async options=>{
    const browser=await testChromium.launch(options),createContext=browser.newContext.bind(browser);
    browser.newContext=async options=>{
      const context=await createContext(options),createPage=context.newPage.bind(context);
      context.newPage=async()=>{const page=await createPage();instrument(page);return page;};
      return context;
    };return browser;
  }};
}

async function fixture(t,{verification=false,rejected=false,formDelay=0,accountFailures=0,pageStatus=200,accountStatus=200,
  bodyDelay=0,challenge=false,challengeDelay=0,hiddenWarnings=false,initialVerification=false,oddsRows=0}={}) {
  let posts=0,accountChecks=0,failuresLeft=accountFailures;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/api/ng/patron/account/info') {
      accountChecks++;res.setHeader('Content-Type','application/json');
      if(failuresLeft>0){failuresLeft--;res.statusCode=503;res.end(JSON.stringify({message:'Fixture temporary outage'}));return;}
      res.statusCode=accountStatus;
      res.end(JSON.stringify({bizCode:req.headers.cookie?.includes('accessToken=fixture-access')?10000:11000,data:{userId:'fixture-only'}}));return;
    }
    if(req.method==='POST'&&req.url==='/fixture-login') {
      posts++;let text='';for await(const chunk of req)text+=chunk;
      const values=JSON.parse(text);assert.equal(values.phone,'8000000000');assert.equal(values.password,'fixture-password');assert.equal(values.remember,true);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({verification,rejected}));return;
    }
    res.statusCode=pageStatus;res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body>
      <div id="fixture-form" ${formDelay?'style="display:none"':''}>+234<input name="phone" placeholder="Mobile Number"><input name="psd" type="password"><input name="keepSignedIn" type="checkbox"><button>Login</button></div>
      ${challenge?'<p>Checking your browser</p>':''}
      ${initialVerification?'<input autocomplete="one-time-code">':''}
      ${hiddenWarnings?'<p style="display:none">Incorrect password</p><p style="visibility:hidden">Checking your browser</p>':''}
      ${'<div>Fixture Team A v Team B — 1.25 3.50 4.00</div>'.repeat(oddsRows)}
      <script>${formDelay?`setTimeout(()=>document.querySelector('#fixture-form').style.display='',${formDelay});`:''}
      ${challengeDelay?`setTimeout(()=>{const message=document.createElement('p');message.textContent='Checking your browser';document.body.appendChild(message);},${challengeDelay});`:''}
      document.querySelector('button').onclick=async()=>{
        const result=await (await fetch('/fixture-login',{method:'POST',body:JSON.stringify({phone:document.querySelector('[name=phone]').value,password:document.querySelector('[name=psd]').value,remember:document.querySelector('[name=keepSignedIn]').checked})})).json();
        if(result.verification){document.body.innerHTML='<input autocomplete="one-time-code">Enter verification code';return;}
        if(result.rejected){document.body.innerHTML='<p>Incorrect <span>password</span></p>';return;}
        document.cookie='accessToken=fixture-access; path=/; max-age=3600';
        document.cookie='refreshToken=fixture-refresh; path=/; max-age=86400';
        document.cookie='device-id=fixture-device; path=/';document.body.innerHTML='Account signed in';
      };
      ${bodyDelay?`const fixtureBody=document.body;fixtureBody.remove();setTimeout(()=>document.documentElement.appendChild(fixtureBody),${bodyDelay});`:''}
      </script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {options:{siteOrigin:origin,baseUrl:origin+'/api/ng',userInfo:'/patron/account/info',
    phone:'2348000000000',password:'fixture-password',timeoutMs:12000},state:()=>({posts,accountChecks})};
}
test('real Chromium signs into a local form and exports only an authenticated current session',async t=>{
  const f=await fixture(t);const result=await browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true});
  assert.equal(f.state().posts,1);assert.equal(f.state().accountChecks,1);assert.ok(result.verifiedAt);
  assert.equal(result.cookies.find(c=>c.name==='accessToken').value,'fixture-access');
  assert.equal(result.cookies.find(c=>c.name==='refreshToken').value,'fixture-refresh');
  assert.equal(result.cookies.find(c=>c.name==='device-id').value,'fixture-device');
});
test('real Chromium stops at an OTP prompt without trying to solve it',async t=>{
  const f=await fixture(t,{verification:true});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),err=>err.requiresUserAction&&err.reason==='verification_required');
  assert.equal(f.state().posts,1);
});
test('rejected browser credentials are reported without the password or repeated form submits',async t=>{
  const f=await fixture(t,{rejected:true});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),err=>{
    assert.doesNotMatch(err.message,/fixture-password|234800/);return err.requiresUserAction&&err.reason==='sign_in_rejected';
  });assert.equal(f.state().posts,1);
});
test('browser sign-in rejects an untrusted origin before launching or entering credentials',async()=>{
  let launches=0;
  await assert.rejects(browserLogin({siteOrigin:'https://example.com',baseUrl:'https://example.com/api',userInfo:'/info',phone:'mock',password:'mock'},
    {chromium:{launch:async()=>{launches++;}}}),err=>err.reason==='invalid_login_origin');
  assert.equal(launches,0);
});
test('a delayed form and one failed account check recover without a second password submission',async t=>{
  const f=await fixture(t,{formDelay:350,accountFailures:1});
  const result=await browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true});
  assert.equal(f.state().posts,1);assert.equal(f.state().accountChecks,2);
  assert.ok(result.cookies.some(c=>c.name==='accessToken'));
});
test('a denied login page records HTTP 403 without inferring a bot challenge or entering credentials',async t=>{
  const f=await fixture(t,{pageStatus:403});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),e=>{
    assert.equal(e.diagnostics.httpStatus,403);assert.equal(e.diagnostics.stage,'page_check');return e.reason==='browser_login_http_error';
  });assert.equal(f.state().posts,0);
});
test('fresh cookies are not exported when the account verification route is missing',async t=>{
  const f=await fixture(t,{accountStatus:404});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),e=>{
    assert.equal(e.diagnostics.httpStatus,404);assert.equal(e.diagnostics.stage,'account_check');return e.reason==='browser_account_http_error'&&e.requiresUserAction;
  });assert.equal(f.state().posts,1);assert.equal(f.state().accountChecks,1);
});

test('a slow page body reproduces the old three-second timeout and now signs in once',async t=>{
  const f=await fixture(t,{bodyDelay:3500});
  const browser=await testChromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.goto(f.options.siteOrigin+'/ng/',{waitUntil:'domcontentloaded'});
    await assert.rejects(page.locator('body').innerText({timeout:3000}),error=>error.name==='TimeoutError');
  }finally{await browser.close();}
  assert.equal(f.state().posts,0);
  const result=await browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true});
  assert.ok(result.verifiedAt);assert.equal(f.state().posts,1);assert.equal(f.state().accountChecks,1);
});
test('a large odds board with hidden warnings does not require a full-body text read',async t=>{
  const f=await fixture(t,{hiddenWarnings:true,oddsRows:3000});let fullBodyReads=0;
  const wrapped=instrumentedChromium(page=>{
    const locate=page.locator.bind(page);
    page.locator=(selector,...args)=>{
      const locator=locate(selector,...args);
      if(selector==='body')locator.innerText=async()=>{fullBodyReads++;throw Object.assign(Error('Fixture old page-check timeout'),{name:'TimeoutError'});};
      return locator;
    };
  });
  const result=await browserLogin(f.options,{chromium:wrapped,allowTestOrigin:true});
  assert.ok(result.verifiedAt);assert.equal(fullBodyReads,0);assert.equal(f.state().posts,1);
});
test('a visible browser challenge stops before the dummy credentials are filled',async t=>{
  const f=await fixture(t,{challenge:true});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),error=>{
    assert.equal(error.diagnostics.pageCheck,'verification_messages');return error.reason==='browser_verification_required'&&error.requiresUserAction;
  });assert.equal(f.state().posts,0);
});
test('an OTP already on the page stops before any password submission',async t=>{
  const f=await fixture(t,{initialVerification:true});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),error=>{
    assert.equal(error.diagnostics.pageCheck,'verification_inputs');return error.reason==='verification_required'&&error.requiresUserAction;
  });assert.equal(f.state().posts,0);
});
test('a challenge appearing during form loading is rechecked before credentials are entered',async t=>{
  const f=await fixture(t,{formDelay:500,challengeDelay:250});
  await assert.rejects(browserLogin(f.options,{chromium:testChromium,allowTestOrigin:true}),error=>error.reason==='browser_verification_required');
  assert.equal(f.state().posts,0);
});
test('one temporary page-check timeout recovers before the only password submission',async t=>{
  const f=await fixture(t);let bodyChecks=0;
  const wrapped=instrumentedChromium(page=>{
    const locate=page.locator.bind(page);
    page.locator=(selector,...args)=>{
      const locator=locate(selector,...args);
      if(selector==='body'){
        const wait=locator.waitFor.bind(locator);
        locator.waitFor=async options=>{
          bodyChecks++;assert.equal(options.state,'attached');
          if(bodyChecks===1)throw Object.assign(Error('Fixture page busy'),{name:'TimeoutError'});
          return wait(options);
        };
      }
      if(selector==='input[name="phone"]:visible'){
        const fill=locator.fill.bind(locator);
        locator.fill=async value=>{assert.ok(bodyChecks>=2);return fill(value);};
      }
      return locator;
    };
  });
  const result=await browserLogin(f.options,{chromium:wrapped,allowTestOrigin:true});
  assert.ok(result.verifiedAt);assert.equal(f.state().posts,1);assert.equal(f.state().accountChecks,1);
});
test('a persistent page-check timeout stops after two checks with safe substep diagnostics',async t=>{
  const f=await fixture(t);let bodyChecks=0;
  const wrapped=instrumentedChromium(page=>{
    const locate=page.locator.bind(page);
    page.locator=(selector,...args)=>{
      const locator=locate(selector,...args);
      if(selector==='body')locator.waitFor=async()=>{bodyChecks++;throw Object.assign(Error('Call log: fixture-password fixture-private-token'),{name:'TimeoutError'});};
      return locator;
    };
  });
  await assert.rejects(browserLogin(f.options,{chromium:wrapped,allowTestOrigin:true}),error=>{
    assert.equal(error.reason,'browser_page_timeout');assert.equal(error.diagnostics.stage,'page_check');
    assert.equal(error.diagnostics.pageCheck,'body_ready');assert.equal(error.diagnostics.pageCheckAttempt,2);
    assert.match(error.message,/pageCheck=body_ready/);assert.doesNotMatch(error.message,/fixture-password|fixture-private-token/);
    return !error.requiresUserAction;
  });assert.equal(bodyChecks,2);assert.equal(f.state().posts,0);assert.equal(f.state().accountChecks,0);
});
test('retrying a slow page check still stops at a verification prompt',async t=>{
  const f=await fixture(t,{challengeDelay:100});let bodyChecks=0;
  const wrapped=instrumentedChromium(page=>{
    const locate=page.locator.bind(page);
    page.locator=(selector,...args)=>{
      const locator=locate(selector,...args);
      if(selector==='body'){
        const wait=locator.waitFor.bind(locator);
        locator.waitFor=async options=>{
          if(++bodyChecks===1)throw Object.assign(Error('Fixture page busy'),{name:'TimeoutError'});
          return wait(options);
        };
      }return locator;
    };
  });
  await assert.rejects(browserLogin(f.options,{chromium:wrapped,allowTestOrigin:true}),error=>{
    assert.equal(error.diagnostics.pageCheckAttempt,2);return error.reason==='browser_verification_required';
  });assert.equal(bodyChecks,2);assert.equal(f.state().posts,0);
});

const mockOptions={siteOrigin:'https://www.sportybet.com',baseUrl:'https://www.sportybet.com/api/ng',userInfo:'/patron/account/info',
  phone:'2348000000000',password:'fixture-secret-password'};
function failedPage({gotoError,cookieError,launchOptions}={}) {
  let closes=0;
  return {state:()=>({closes}),chromium:{launch:async options=>{
    launchOptions?.(options);
    return {close:async()=>{closes++;},newContext:async()=>({
      addCookies:async()=>{if(cookieError)throw cookieError;},
      newPage:async()=>({setDefaultTimeout(){},goto:async()=>{throw gotoError||Error('Fixture navigation failure');}}),
    })};
  }}};
}
test('a navigation timeout identifies the failing step without exposing Playwright call logs',async()=>{
  const error=Object.assign(Error('Call log: fixture-secret-password at https://www.sportybet.com/ng/?accessToken=fixture-token'),{name:'TimeoutError'});
  const f=failedPage({gotoError:error});
  await assert.rejects(browserLogin(mockOptions,f),e=>{
    assert.equal(e.reason,'browser_navigation_timeout');assert.equal(e.diagnostics.stage,'navigation');
    assert.doesNotMatch(JSON.stringify({message:e.message,...e.diagnostics}),/fixture-secret|fixture-token|sportybet\.com|234800/);
    return !e.requiresUserAction;
  });assert.equal(f.state().closes,1);
});
test('the browser uses the configured authenticated proxy and reports only a fixed network code',async()=>{
  const f=failedPage({gotoError:Error('net::ERR_PROXY_CONNECTION_FAILED http://fixture-user:fixture-proxy-password@localhost:8080'),
    launchOptions:options=>assert.deepEqual(options.proxy,{server:'http://localhost:8080',username:'fixture-user',password:'fixture-proxy-password'})});
  await assert.rejects(browserLogin({...mockOptions,proxyUrl:'http://fixture-user:fixture-proxy-password@localhost:8080'},f),e=>{
    assert.equal(e.diagnostics.networkCode,'ERR_PROXY_CONNECTION_FAILED');assert.equal(e.diagnostics.proxyConfigured,true);
    assert.equal(e.diagnostics.stage,'navigation');assert.doesNotMatch(e.message,/fixture-user|fixture-proxy-password|localhost/);
    return e.reason==='browser_network_error';
  });
});
test('cookie-seeding failures retain the step while concealing cookie values',async()=>{
  const f=failedPage({cookieError:Error('Invalid cookie fixture-private-cookie')});
  await assert.rejects(browserLogin({...mockOptions,cookies:[{name:'device-id',value:'fixture-private-cookie'}]},f),e=>{
    assert.equal(e.diagnostics.stage,'cookies');assert.doesNotMatch(e.message,/fixture-private-cookie/);return e.reason==='browser_cookie_seed_failed';
  });
});
test('an invalid proxy is rejected safely before a browser is started',async()=>{
  let launches=0;
  await assert.rejects(browserLogin({...mockOptions,proxyUrl:'fixture-invalid-proxy-secret'},
    {chromium:{launch:async()=>{launches++;}}}),e=>{
    assert.doesNotMatch(e.message,/fixture-invalid-proxy-secret/);return e.reason==='browser_proxy_invalid'&&e.diagnostics.stage==='configuration';
  });assert.equal(launches,0);
});
