'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {bootstrapLine} = require('../jobs/sporty-session-bootstrap');

function response(payload, cookies = [], status = 200) {
  return {ok:status >= 200 && status < 300, status,
    headers:{get:name => name === 'content-type' ? 'application/json' : null, getSetCookie:() => cookies},
    text:async () => JSON.stringify(payload)};
}
function client(t, env = {}, saved) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sporty-session-test-'));
  const vars = {REDIS_URL:'', SPORTYBET_PHONE:'', SPORTYBET_PASSWORD:'', SPORTYBET_BOOTSTRAP_COOKIES:'',
    SPORTYBET_PROXY_URL:'', HTTPS_PROXY:'', SPORTYBET_LOGIN_METHOD:'api', SPORTYBET_LOGIN_EXTRA:'', SPORTYBET_ENDPOINT_LOGIN:'/patron/login',
    SPORTYBET_ENDPOINT_LOGIN_CANDIDATES:'', SPORTYBET_ENDPOINT_USERINFO:'',
    SPORTYBET_ENDPOINT_REFRESH:'/patron/refresh',
    SPORTYBET_SESSION_FILE:path.join(folder, 'session.json'), ...env};
  const prior = Object.fromEntries(Object.keys(vars).map(name => [name, process.env[name]]));
  Object.assign(process.env, vars);
  if (saved) fs.writeFileSync(vars.SPORTYBET_SESSION_FILE, JSON.stringify(saved));
  const filename = require.resolve('../lib/sportybetDirect');
  delete require.cache[filename];
  const direct = require(filename);
  t.after(() => {
    direct.setFetchForTesting(null);
    delete require.cache[filename];
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(folder, {recursive:true, force:true});
  });
  return {direct, filename, file:vars.SPORTYBET_SESSION_FILE};
}
const credentials = {SPORTYBET_PHONE:'2348000000000', SPORTYBET_PASSWORD:'mock-password-only'};
const jwt = exp => `header.${Buffer.from(JSON.stringify({exp})).toString('base64url')}.signature`;

test('public prematch, live, details and existing codes ignore saved and configured dummy credentials',async t=>{
  const saved={token:'private-saved-token',cookies:[['accessToken',{value:'private-saved-cookie',expiresAt:null}]]};
  const {direct,file}=client(t,credentials,saved),before=fs.readFileSync(file,'utf8');
  let reads=0;
  direct.setFetchForTesting(async(url,options)=>{
    assert.match(new URL(url).pathname,/\/(?:factsCenter\/|orders\/share)/);
    for(const name of Object.keys(options.headers))assert.doesNotMatch(name,/^(cookie|authorization|token|accessToken|refreshToken|device-?id|x-auth-token)$/i);
    reads++;return response({bizCode:10000,data:[]},['accessToken=unrelated-public-cookie; Max-Age=60']);
  });
  await Promise.all(Array.from({length:32},(_,i)=>direct.fetchPrematchPage('sr:sport:1',1,10,{marketIds:String(i)})));
  await direct.fetchLivePage('sr:sport:1',1,10);await direct.fetchEventDetail('fixture-event');await direct.lookupBooking('FIXTURE');
  await direct.sportyRequest('/factsCenter/pcUpcomingEvents',{auth:true,extraHeaders:{Cookie:'private',authorization:'private',token:'private',deviceId:'private','x-auth-token':'private'}});
  assert.equal(reads,36);assert.equal(direct._session.loaded,false);assert.equal(direct._session.cookies.size,0);
  assert.equal(direct._session.token,null);assert.equal(direct.sessionStatus().loginCount,0);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('a rejected public feed never falls back to dummy authentication',async t=>{
  const {direct}=client(t,credentials);let reads=0;
  direct.setFetchForTesting(async(url,options)=>{
    assert.match(new URL(url).pathname,/\/factsCenter\//);assert.equal(options.headers.Cookie,undefined);
    reads++;return response({bizCode:11000,message:'Public feed rejected'},[],401);
  });
  await assert.rejects(direct.fetchLivePage('sr:sport:1',1,10),e=>e.code==='SPORTYBET_HTTP'&&e.status===401);
  assert.equal(reads,1);assert.equal(direct._session.loaded,false);assert.equal(direct.sessionStatus().loginCount,0);
});

test('a lost booking response is marked uncertain and is never automatically posted a second time',async t=>{
  const {direct}=client(t);direct._session.loaded=true;
  direct._session.cookies.set('accessToken',{value:'accepted-fixture-session',expiresAt:null});
  let posts=0;
  direct.setFetchForTesting(async(url,options)=>{
    if(new URL(url).pathname.endsWith('/patron/account/info'))return response({bizCode:10000,data:{userId:'fixture'}});
    assert.equal(options.method,'POST');assert.match(new URL(url).pathname,/\/orders\/share$/);
    posts++;throw Error('Fixture connection lost after submitting booking');
  });
  await assert.rejects(direct.createBookingCode([{eventId:'fixture',marketId:'1',outcomeId:'1'}]),e=>e.code==='SPORTYBET_NETWORK'&&e.bookingOutcomeUnknown===true);
  assert.equal(posts,1);
});

test('HTTP 200 rejected login never becomes authenticated, even with an access cookie', async t => {
  const {direct} = client(t, credentials);
  let calls = 0;
  direct._session.cookies.set('deviceId', {value:'existing-browser-device', expiresAt:null});
  direct.setFetchForTesting(async (_url, options) => {
    calls++;
    assert.match(options.headers.Cookie, /deviceId=existing-browser-device/);
    return response({bizCode:12000, innerMsg:'failure', message:'Looks like we’re having trouble on our end. Please try again later.'}, ['accessToken=untrusted-cookie; Max-Age=3600']);
  });
  await assert.rejects(direct.login(), error => error.code === 'SPORTYBET_AUTH_FAILED' && error.bizCode === 12000 && /rejected.*login/.test(error.message));
  assert.equal(direct.hasAuthenticatedSession(), false);
  assert.equal(direct.sessionStatus().loginCount, 0);
  assert.ok(direct.sessionStatus().nextLoginRetryAt);
  await assert.rejects(direct.login({force:true}), /Next automatic login retry/);
  assert.equal(calls, 1);
});

test('32 concurrent booking requests share one failed login and create no codes', async t => {
  const {direct} = client(t, credentials);
  let logins = 0, boards = 0;
  direct.setFetchForTesting(async url => {
    if (new URL(url).pathname.endsWith('/patron/login')) { logins++; return response({bizCode:12000, message:'Login rejected'}); }
    boards++; throw new Error('A rejected session must not create a booking');
  });
  const results = await Promise.allSettled(Array.from({length:32}, () => direct.createBookingCode([{eventId:'e',marketId:'1',outcomeId:'1'}])));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'SPORTYBET_AUTH_FAILED'));
  assert.equal(logins, 1); assert.equal(boards, 0);
  await assert.rejects(direct.createBookingCode([{eventId:'e',marketId:'1',outcomeId:'1'}]), /Next automatic login retry/);
  assert.equal(logins, 1);
});

test('default login tries patron/accessToken before a persisted legacy users/login path', async t => {
  const {direct} = client(t, {...credentials, SPORTYBET_ENDPOINT_LOGIN:''}, {resolvedEndpoints:{login:'/users/login'}});
  const paths = [];
  direct.setFetchForTesting(async url => {
    const pathname = new URL(url).pathname; paths.push(pathname);
    if (pathname.endsWith('/patron/cipher')) return response({bizCode:10000, data:{password:Buffer.alloc(16, 1).toString('base64'), ursId:'mock-cipher-id'}});
    return response({bizCode:12000, message:'Rejected test ciphertext'});
  });
  // This proves ordering and strict rejection, not compatibility of the
  // unverified legacy cipher with a real SportyBet password login.
  await assert.rejects(direct.login(), /Rejected test ciphertext/);
  assert.deepEqual(paths, ['/api/ng/patron/cipher', '/api/ng/patron/accessToken']);
});

test('changed browser bootstrap replaces stale persisted cookies and bearer token', async t => {
  const {direct, file} = client(t, {SPORTYBET_BOOTSTRAP_COOKIES:'accessToken=fresh-browser-token; refreshToken=fresh-refresh; deviceId=browser-device'}, {
    token:'stale-bearer-token', cookies:[['accessToken', {value:'stale-cookie', expiresAt:null}], ['deviceId', {value:'old-device', expiresAt:null}]],
  });
  direct.setFetchForTesting(async (url, options) => {
    assert.ok(url.endsWith('/patron/account/info'));
    assert.match(options.headers.Cookie, /accessToken=fresh-browser-token/);
    assert.match(options.headers.Cookie, /deviceId=browser-device/);
    assert.equal(options.headers.authorization, undefined);
    return response({bizCode:10000, data:{userId:'mock-dummy'}});
  });
  await direct.ensureSession({validate:true});
  assert.ok(direct.sessionStatus().lastAuthenticatedAt);
  assert.equal(direct._session.token, null);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.bootstrapFingerprint);
  assert.equal(saved.cookies.find(([name]) => name === 'refreshToken')[1].value, 'fresh-refresh');
});

test('unchanged bootstrap preserves a newer rotated persisted session after restart', async t => {
  const raw = 'accessToken=older-bootstrap; refreshToken=older-refresh; deviceId=browser-device';
  const {direct} = client(t, {SPORTYBET_BOOTSTRAP_COOKIES:raw}, {
    bootstrapFingerprint:crypto.createHash('sha256').update(raw).digest('hex'), token:'rotated-token',
    cookies:[['accessToken', {value:'rotated-token', expiresAt:Date.now()+60000}], ['refreshToken', {value:'rotated-refresh', expiresAt:null}]],
  });
  direct.setFetchForTesting(async (_url, options) => {
    assert.match(options.headers.Cookie, /accessToken=rotated-token/);
    assert.doesNotMatch(options.headers.Cookie, /older-bootstrap/);
    return response({bizCode:10000, data:{userId:'mock'}});
  });
  await direct.ensureSession({validate:true});
  assert.equal(direct._session.token, 'rotated-token');
});

test('expired JWT credentials refresh once for concurrent requests without a password login', async t => {
  const expired = jwt(Math.floor(Date.now()/1000)-60);
  const {direct} = client(t, {}, {token:expired, cookies:[['accessToken', {value:expired, expiresAt:null}], ['refreshToken', {value:'working-refresh', expiresAt:null}]]});
  let refreshes = 0, checks = 0;
  direct.setFetchForTesting(async url => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=rotated-token; Max-Age=3600']); }
    assert.ok(url.endsWith('/patron/account/info')); checks++;
    return response({bizCode:10000, data:{userId:'mock'}});
  });
  await Promise.all(Array.from({length:20}, () => direct.ensureSession({validate:true})));
  assert.equal(refreshes, 1); assert.equal(checks, 1);
  assert.equal(direct._session.token, 'rotated-token');
});

test('authenticated GET retries inside the original promise after a 401', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'expired-server-side', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'working-refresh', expiresAt:null});
  let reads = 0, refreshes = 0;
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=rotated-token; Max-Age=60']); }
    reads++;
    if (reads === 1) return response({message:'Unauthorized'}, [], 401);
    assert.match(options.headers.Cookie, /accessToken=rotated-token/);
    return response({bizCode:10000, data:{ready:true}});
  });
  const result = await direct.sportyRequest('/patron/account/info', {auth:true});
  assert.equal(result.data.ready, true); assert.equal(reads, 2); assert.equal(refreshes, 1);
});

test('HTTP 200 expired-session business errors renew and retry once', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  let reads = 0;
  direct.setFetchForTesting(async url => {
    if (url.endsWith('/patron/refresh')) return response({bizCode:10000, data:{accessToken:'new-rotated-token'}});
    return ++reads === 1 ? response({bizCode:11000, message:'Access token expired'}) : response({bizCode:10000, data:['current']});
  });
  const result = await direct.sportyRequest('/patron/account/info', {auth:true});
  assert.deepEqual(result.data, ['current']); assert.equal(reads, 2);
});

test('different concurrent authenticated GETs share one token renewal', {timeout:2000}, async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  let refreshes = 0, oldReads = 0;
  let release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) { refreshes++; return response({bizCode:10000}, ['accessToken=new-token; Max-Age=60']); }
    if (options.headers.Cookie.includes('accessToken=old-token')) {
      if (++oldReads === 2) release(); await bothStarted;
      return response({message:'Unauthorized'}, [], 401);
    }
    return response({bizCode:10000, data:{ready:true}});
  });
  const results = await Promise.all([1, 2].map(i => direct.sportyRequest('/patron/account/info', {auth:true, params:{request:i}})));
  assert.ok(results.every(r => r.data.ready)); assert.equal(refreshes, 1);
});

test('a successful refresh response without credentials cannot authenticate a visitor', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('deviceId', {value:'visitor', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  direct.setFetchForTesting(async () => response({bizCode:10000, data:{}}));
  assert.equal(await direct.refreshSession(), false);
  assert.equal(direct.hasAuthenticatedSession(), false);
});

test('business errors cannot be mistaken for empty market data', async t => {
  const {direct} = client(t);
  direct.setFetchForTesting(async () => response({bizCode:12000, message:'Service unavailable'}));
  await assert.rejects(direct.sportyRequest('/factsCenter/pcUpcomingEvents'), error => error.code === 'SPORTYBET_API' && error.bizCode === 12000);
});

test('signed-out Set-Cookie deletes the credential, including combined headers with Expires commas', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.token = 'old-token';
  direct._session.cookies.set('accessToken', {value:'old-token', expiresAt:null});
  direct.setFetchForTesting(async () => ({ok:true, status:200,
    headers:{get:name => name === 'content-type' ? 'application/json' : name === 'set-cookie'
      ? 'accessToken=old-token; Max-Age=-1, deviceId=kept; Expires=Wed, 21 Oct 2037 07:28:00 GMT, refreshToken=fresh; Max-Age=60' : null},
    text:async () => JSON.stringify({bizCode:10000})}));
  await direct.sportyRequest('/patron/account/info');
  assert.equal(direct.hasAuthenticatedSession(), false);
  assert.equal(direct._session.cookies.get('deviceId').value, 'kept');
  assert.equal(direct._session.cookies.get('refreshToken').value, 'fresh');
});

test('refresh replaces a stale cookie when new credentials arrive only in the response body', async t => {
  const {direct} = client(t);
  direct._session.loaded = true;
  direct._session.cookies.set('accessToken', {value:'expired-on-server', expiresAt:null});
  direct._session.cookies.set('refreshToken', {value:'refresh', expiresAt:null});
  direct.setFetchForTesting(async (url, options) => {
    if (url.endsWith('/patron/refresh')) return response({bizCode:10000, data:{accessToken:'new-response-token'}});
    assert.match(options.headers.Cookie, /accessToken=new-response-token/);
    assert.doesNotMatch(options.headers.Cookie, /expired-on-server/);
    return response({bizCode:10000, data:['current']});
  });
  assert.equal(await direct.refreshSession(), true);
  await direct.sportyRequest('/patron/account/info', {auth:true});
  assert.equal(direct._session.token, 'new-response-token');
});

test('local session export accepts only current SportyBet auth cookies', () => {
  const cookies = [
    {domain:'.sportybet.com', name:'accessToken', value:'current-access', expires:-1},
    {domain:'.sportybet.com', name:'refreshToken', value:'current-refresh', expires:-1},
    {domain:'.sportybet.com', name:'deviceId', value:'device', expires:-1},
    {domain:'.example.com', name:'accessToken', value:'wrong-site', expires:-1},
    {domain:'.sportybet.com', name:'analytics', value:'ignored', expires:-1},
  ];
  assert.equal(bootstrapLine(cookies), 'SPORTYBET_BOOTSTRAP_COOKIES=accessToken=current-access; refreshToken=current-refresh; deviceId=device');
  assert.throws(() => bootstrapLine(cookies.map(c => c.name === 'accessToken' ? {...c, expires:1} : c)), /no usable/);
  assert.throws(() => bootstrapLine(cookies.map(c => c.name === 'refreshToken' ? {...c, value:'bad\nvalue'} : c)), /no usable/);
});

const browserCredentials={...credentials,SPORTYBET_LOGIN_METHOD:'browser'};
const browserResult=()=>({verifiedAt:Date.now(),cookies:[
  {name:'accessToken',value:'automatic-browser-access',expiresAt:Date.now()+3600000},
  {name:'refreshToken',value:'automatic-browser-refresh',expiresAt:Date.now()+86400000},
  {name:'device-id',value:'browser-device',expiresAt:null},
]});
test('automatic browser sign-in is the default and 32 requests share one login',async t=>{
  const {direct,file}=client(t,{...credentials,SPORTYBET_LOGIN_METHOD:''});let logins=0;
  direct.setFetchForTesting(async()=>{throw Error('No guessed API login or extra account request should run');});
  direct.setBrowserLoginForTesting(async options=>{logins++;assert.equal(options.phone,credentials.SPORTYBET_PHONE);return browserResult();});
  await Promise.all(Array.from({length:32},()=>direct.ensureSession({validate:true})));
  assert.equal(logins,1);assert.equal(direct.sessionStatus().automaticLoginMethod,'browser');
  assert.equal(direct.sessionStatus().lastLoginMethod,'browser');assert.equal(direct.hasAuthenticatedSession(),true);
  assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).loginMethod,'browser');
  assert.equal(fs.statSync(file).mode&0o777,0o600);
  assert.doesNotMatch(JSON.stringify(direct.sessionStatus()),/mock-password|automatic-browser-access|automatic-browser-refresh/);
});
test('an expired session with a revoked refresh token signs in automatically through the browser',async t=>{
  const expired=jwt(Math.floor(Date.now()/1000)-60);
  const {direct}=client(t,browserCredentials,{token:expired,cookies:[['accessToken',{value:expired,expiresAt:null}],['refreshToken',{value:'revoked',expiresAt:null}]]});
  let refreshes=0,logins=0;
  direct.setFetchForTesting(async url=>{assert.ok(url.endsWith('/patron/refresh'));refreshes++;return response({message:'Unauthorized'},[],401);});
  direct.setBrowserLoginForTesting(async()=>{logins++;return browserResult();});
  await direct.ensureSession({validate:true});assert.equal(refreshes,1);assert.equal(logins,1);
  assert.equal(direct.sessionStatus().requiresUserAction,false);assert.equal(direct.hasAuthenticatedSession(),true);
});
test('maintenance proactively refreshes opaque tokens and persists body-rotated refresh credentials',async t=>{
  const last=new Date(Date.now()-21*60000).toISOString();
  const {direct,file}=client(t,browserCredentials,{lastRefreshAt:last,loggedInAt:last,cookies:[
    ['accessToken',{value:'opaque-old',expiresAt:Date.now()+3600000}],['refreshToken',{value:'old-refresh',expiresAt:null}],['device-id',{value:'real-device',expiresAt:null}],
  ]});let refreshes=0,checks=0;
  direct.setBrowserLoginForTesting(async()=>{throw Error('Accepted refresh must avoid browser login');});
  direct.setFetchForTesting(async(url,options)=>{
    assert.match(options.headers.Cookie,/device-id=real-device/);assert.doesNotMatch(options.headers.Cookie,/(?:^|; )deviceId=/);
    if(url.endsWith('/patron/refresh')){refreshes++;return response({bizCode:10000,data:{accessToken:'rotated-access',refreshToken:'rotated-refresh'}});}
    checks++;assert.match(options.headers.Cookie,/refreshToken=rotated-refresh/);assert.match(options.headers.Cookie,/accessToken=rotated-access/);
    return response({bizCode:10000,data:{userId:'dummy'}});
  });
  await Promise.all(Array.from({length:20},()=>direct.maintainSession()));
  assert.equal(refreshes,1);assert.equal(checks,1);assert.equal(direct.sessionStatus().lastKeepAliveOk,true);
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(saved.cookies.find(([name])=>name==='refreshToken')[1].value,'rotated-refresh');
  assert.ok(saved.lastRefreshAt);await direct.maintainSession();assert.equal(refreshes,1);
});
test('known expiry triggers renewal before an otherwise valid access token expires',async t=>{
  const almost=jwt(Math.floor(Date.now()/1000)+120);
  const {direct}=client(t,{}, {token:almost,lastRefreshAt:new Date().toISOString(),cookies:[
    ['accessToken',{value:almost,expiresAt:null}],['refreshToken',{value:'refresh',expiresAt:null}],
  ]});let refreshes=0;
  direct.setFetchForTesting(async url=>url.endsWith('/patron/refresh')?(refreshes++,response({bizCode:10000,data:{accessToken:'early-renewal'}})):
    response({bizCode:10000,data:{userId:'dummy'}}));
  await direct.ensureSession({validate:true});assert.equal(refreshes,1);assert.equal(direct._session.token,'early-renewal');
});
test('a transient proactive refresh failure preserves a still-accepted session and backs off refresh',async t=>{
  const {direct}=client(t,browserCredentials,{loggedInAt:new Date(Date.now()-3600000).toISOString(),cookies:[
    ['accessToken',{value:'still-current',expiresAt:Date.now()+3600000}],['refreshToken',{value:'refresh',expiresAt:null}],
  ]});let refreshes=0;
  direct.setBrowserLoginForTesting(async()=>{throw Error('Healthy session should not trigger password login');});
  direct.setFetchForTesting(async url=>url.endsWith('/patron/refresh')?(refreshes++,response({bizCode:12000,message:'Service temporarily unavailable'})):
    response({bizCode:10000,data:{userId:'dummy'}}));
  await direct.maintainSession();await direct.maintainSession();
  assert.equal(refreshes,1);assert.equal(direct.hasAuthenticatedSession(),true);assert.equal(direct.sessionStatus().lastKeepAliveOk,true);
  assert.match(direct.sessionStatus().lastRefreshError,/Service temporarily unavailable/);
});
for (const status of [404,405]) test(`an unavailable refresh route (${status}) is attempted once while a working session is retained`,async t=>{
  const {direct}=client(t,browserCredentials,{loggedInAt:new Date(Date.now()-3600000).toISOString(),cookies:[
    ['accessToken',{value:'accepted-current-session',expiresAt:Date.now()+3600000}],['refreshToken',{value:'refresh',expiresAt:null}],
  ]});let refreshes=0,logins=0,checks=0;
  direct.setBrowserLoginForTesting(async()=>{logins++;return browserResult();});
  direct.setFetchForTesting(async url=>{
    if (url.endsWith('/patron/refresh')) {refreshes++;return response({status,error:'Not Found',path:'/refresh'},[],status);}
    checks++;return response({bizCode:10000,data:{userId:'dummy'}});
  });
  await direct.maintainSession();
  await Promise.all(Array.from({length:32},()=>direct.refreshSession()));
  await direct.maintainSession();
  assert.equal(refreshes,1);assert.equal(logins,0);assert.equal(checks,1);
  assert.equal(direct.hasAuthenticatedSession(),true);assert.equal(direct.sessionStatus().lastKeepAliveOk,true);
  assert.equal(direct.sessionStatus().refreshEndpointUnavailable,true);
  assert.equal(direct.refreshDue(Date.now()+86400000),false);
  assert.doesNotMatch(JSON.stringify(direct.sessionStatus()),/accepted-current-session|mock-password/);
});
test('32 requests share browser recovery when an expired session has a missing refresh endpoint',async t=>{
  const expired=jwt(Math.floor(Date.now()/1000)-60);
  const {direct}=client(t,browserCredentials,{token:expired,cookies:[
    ['accessToken',{value:expired,expiresAt:null}],['refreshToken',{value:'refresh',expiresAt:null}],
  ]});let refreshes=0,logins=0;
  direct.setFetchForTesting(async url=>{assert.ok(url.endsWith('/patron/refresh'));refreshes++;return response({status:404,path:'/refresh'},[],404);});
  direct.setBrowserLoginForTesting(async()=>{logins++;return browserResult();});
  await Promise.all(Array.from({length:32},()=>direct.ensureSession({validate:true})));
  assert.equal(refreshes,1);assert.equal(logins,1);assert.equal(direct.hasAuthenticatedSession(),true);
  assert.equal(direct.sessionStatus().refreshEndpointUnavailable,true);assert.equal(direct.sessionStatus().lastLoginMethod,'browser');
});
test('account rejection recovers through the browser after a proactive refresh route was disabled',async t=>{
  const {direct}=client(t,browserCredentials,{loggedInAt:new Date(Date.now()-3600000).toISOString(),cookies:[
    ['accessToken',{value:'rejected-old-session',expiresAt:Date.now()+3600000}],['refreshToken',{value:'refresh',expiresAt:null}],
  ]});let refreshes=0,logins=0,checks=0;
  direct.setBrowserLoginForTesting(async()=>{logins++;return browserResult();});
  direct.setFetchForTesting(async(url,options)=>{
    if(url.endsWith('/patron/refresh')){refreshes++;return response({status:404,path:'/refresh'},[],404);}
    checks++;
    return options.headers.Cookie.includes('accessToken=rejected-old-session')?response({message:'Unauthorized'},[],401):
      response({bizCode:10000,data:{userId:'dummy'}});
  });
  await direct.maintainSession();
  assert.equal(refreshes,1);assert.equal(logins,1);assert.equal(checks,2);
  assert.equal(direct.sessionStatus().lastKeepAliveOk,true);assert.equal(direct.hasAuthenticatedSession(),true);
});
test('a temporary 500 refresh failure remains retryable and does not disable the route',async t=>{
  const {direct}=client(t,{}, {cookies:[['accessToken',{value:'current',expiresAt:Date.now()+3600000}],['refreshToken',{value:'refresh',expiresAt:null}]]});
  let refreshes=0;
  direct.setFetchForTesting(async()=>++refreshes===1?response({message:'Temporary failure'},[],500):
    response({bizCode:10000,data:{accessToken:'recovered-token'}}));
  assert.equal(await direct.refreshSession(),false);assert.equal(direct.sessionStatus().refreshEndpointUnavailable,false);
  assert.equal(direct.refreshDue(Date.now()+86400000),true);
  assert.equal(await direct.refreshSession(),true);assert.equal(refreshes,2);assert.equal(direct.hasAuthenticatedSession(),true);
});
test('browser verification stops automatic sign-in and prevents repeated password attempts',async t=>{
  const {direct}=client(t,browserCredentials);let attempts=0;
  direct.setBrowserLoginForTesting(async()=>{attempts++;throw Object.assign(Error('SportyBet requires verification'),
    {code:'SPORTYBET_AUTH_FAILED',requiresUserAction:true,reason:'verification_required'});});
  await assert.rejects(direct.ensureSession({validate:true}),e=>Boolean(e.requiresUserAction&&e.retryAt));
  await assert.rejects(direct.ensureSession({validate:true}),e=>e.requiresUserAction&&e.reason==='verification_required');
  await direct.maintainSession();assert.equal(attempts,1);assert.equal(direct.hasAuthenticatedSession(),false);
  assert.equal(direct.sessionStatus().requiresUserAction,true);assert.equal(direct.sessionStatus().lastKeepAliveOk,false);
});
test('a browser result containing only device cookies cannot authenticate the dummy account',async t=>{
  const {direct}=client(t,browserCredentials);
  direct.setBrowserLoginForTesting(async()=>({verifiedAt:Date.now(),cookies:[{name:'device-id',value:'visitor'}]}));
  await assert.rejects(direct.ensureSession(),/no authenticated/);assert.equal(direct.hasAuthenticatedSession(),false);
});
test('a browser-recovered session survives restart with no bootstrap cookie recopy',async t=>{
  const first=client(t,browserCredentials);first.direct.setBrowserLoginForTesting(async()=>browserResult());
  await first.direct.ensureSession({validate:true});const saved=JSON.parse(fs.readFileSync(first.file,'utf8'));
  const second=client(t,browserCredentials,saved);let checks=0;
  second.direct.setBrowserLoginForTesting(async()=>{throw Error('Restart should restore saved current session');});
  second.direct.setFetchForTesting(async(_url,options)=>{checks++;assert.match(options.headers.Cookie,/automatic-browser-access/);return response({bizCode:10000,data:{userId:'dummy'}});});
  await second.direct.ensureSession({validate:true});assert.equal(checks,1);assert.equal(second.direct.sessionStatus().lastLoginMethod,'browser');
});
test('the direct client passes its configured proxy into browser recovery and preserves safe failures during backoff',async t=>{
  const proxy='http://fixture-proxy-user:fixture-proxy-password@localhost:8080';
  const {direct}=client(t,{...browserCredentials,SPORTYBET_PROXY_URL:proxy});let logins=0;
  direct.setBrowserLoginForTesting(async options=>{
    logins++;assert.equal(options.proxyUrl,proxy);
    throw Object.assign(Error('Fixture navigation timed out'),{code:'SPORTYBET_AUTH_FAILED',reason:'browser_navigation_timeout',
      diagnostics:{stage:'navigation',reason:'browser_navigation_timeout',proxyConfigured:true,proxyUrl:proxy,password:'fixture-private-password'}});
  });
  await assert.rejects(direct.ensureSession(),e=>e.reason==='browser_navigation_timeout');
  const failure=direct.sessionStatus().lastLoginFailure;
  assert.equal(failure.stage,'navigation');assert.equal(failure.proxyConfigured,true);
  assert.doesNotMatch(JSON.stringify(failure),/fixture-proxy|fixture-private-password|localhost/);
  await assert.rejects(direct.ensureSession(),e=>e.diagnostics.stage==='navigation');assert.equal(logins,1);
});
test('local export preserves the observed hyphenated device cookie',()=>{
  assert.equal(bootstrapLine([{domain:'.sportybet.com',name:'accessToken',value:'access',expires:-1},
    {domain:'.sportybet.com',name:'refreshToken',value:'refresh',expires:-1},
    {domain:'.sportybet.com',name:'device-id',value:'device',expires:-1}]),
    'SPORTYBET_BOOTSTRAP_COOKIES=accessToken=access; refreshToken=refresh; device-id=device');
});
