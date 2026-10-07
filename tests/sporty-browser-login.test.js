'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {browserLogin}=require('../lib/sportyBrowserLogin');
require('../lib/sportyBrowserRuntime').configureBrowserPath();
const {chromium}=require('playwright');
const testChromium={launch:options=>chromium.launch({...options,
  ...(process.env.PLOT207_TEST_BROWSER_EXECUTABLE?{executablePath:process.env.PLOT207_TEST_BROWSER_EXECUTABLE}:{})})};

async function fixture(t,{verification=false,rejected=false}={}) {
  let posts=0,accountChecks=0;
  const server=http.createServer(async(req,res)=>{
    if(req.url==='/api/ng/patron/account/info') {
      accountChecks++;res.setHeader('Content-Type','application/json');
      res.end(JSON.stringify({bizCode:req.headers.cookie?.includes('accessToken=fixture-access')?10000:11000,data:{userId:'fixture-only'}}));return;
    }
    if(req.method==='POST'&&req.url==='/fixture-login') {
      posts++;let text='';for await(const chunk of req)text+=chunk;
      const values=JSON.parse(text);assert.equal(values.phone,'8000000000');assert.equal(values.password,'fixture-password');
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({verification,rejected}));return;
    }
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><body>
      <div>+234<input name="phone" placeholder="Mobile Number"><input name="psd" type="password"><button>Login</button></div>
      <script>document.querySelector('button').onclick=async()=>{
        const result=await (await fetch('/fixture-login',{method:'POST',body:JSON.stringify({phone:document.querySelector('[name=phone]').value,password:document.querySelector('[name=psd]').value})})).json();
        if(result.verification){document.body.innerHTML='<input autocomplete="one-time-code">Enter verification code';return;}
        if(result.rejected){document.body.innerHTML='Incorrect password';return;}
        document.cookie='accessToken=fixture-access; path=/; max-age=3600';
        document.cookie='refreshToken=fixture-refresh; path=/; max-age=86400';
        document.cookie='device-id=fixture-device; path=/';document.body.innerHTML='Account signed in';
      };</script></body></html>`);
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
