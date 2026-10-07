'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {fork} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomUUID}=require('node:crypto');

async function server(t, mode) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sporty-session-api-'));
  const sessionFile = path.join(folder, 'session.json');
  if (mode === 'browser') fs.writeFileSync(sessionFile, JSON.stringify({token:'stale-persisted-bearer',
    cookies:[['accessToken', {value:'stale-persisted-cookie', expiresAt:null}]]}));
  if(['automated','delayed-booking'].includes(mode))fs.writeFileSync(sessionFile,JSON.stringify({token:'expired-bearer',tokenExpiresAt:1,
    cookies:[['refreshToken',{value:'revoked-refresh',expiresAt:null}]]}));
  const child = fork(path.join(__dirname, 'fixtures/session-auth-api-server.js'), [], {cwd:path.join(__dirname, '..'), silent:true,
    env:{...process.env, NODE_ENV:'production', PORT:'0', REDIS_URL:'', HTTPS_PROXY:'', SPORTYBET_PROXY_URL:'',
      SPORTYBET_SESSION_FILE:sessionFile, SPORTYBET_ENDPOINT_LOGIN:'', SPORTYBET_ENDPOINT_LOGIN_CANDIDATES:'',
      SPORTYBET_PHONE:'2348000000000', SPORTYBET_PASSWORD:'mock-test-password',SPORTYBET_LOGIN_METHOD:['automated','browser-failure','page-check-failure','delayed-booking'].includes(mode)?'browser':'api',
      SPORTYBET_BOOTSTRAP_COOKIES:mode === 'browser' ? 'accessToken=fresh-browser-token; refreshToken=fresh-refresh; deviceId=fresh-device' : '',
      SPORTYBET_LIVE_MAX_PAGES:'1', SESSION_TEST_MODE:mode, WEBSITE_ACCESS_CODE:''}});
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; }); child.stderr.on('data', chunk => { logs += chunk; });
  t.after(() => { child.kill(); fs.rmSync(folder, {recursive:true, force:true}); });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start: ' + logs)), 10000);
    child.once('message', message => { clearTimeout(timer); resolve(message.port); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Test server exited ' + code + ': ' + logs)); });
  });
  const post = async (route, body,headers={}) => {
    const result = await fetch(`http://127.0.0.1:${port}${route}`, {method:'POST', headers:{'Content-Type':'application/json',...headers}, body:JSON.stringify(body)});
    return {status:result.status, body:await result.json()};
  };
  const state = (type='state') => new Promise(resolve => {
    const id = 'session-state';
    const handler = message => { if (message.id === id) { child.off('message', handler); resolve(message.state); } };
    child.on('message', handler); child.send({type, id});
  });
  const get=async route=>{const result=await fetch(`http://127.0.0.1:${port}${route}`);return {status:result.status,body:await result.json()};};
  return {post,get,state};
}
const request = {sports:['football'], liveMode:'quick_cash', minProbability:0, targetOdds:1.05, maxSelections:1, betTypes:['home_win']};

function assertPublicOnly(state) {
  assert.equal(state.logins,0);assert.equal(state.ciphers,0);assert.equal(state.accountChecks,0);assert.equal(state.bookings,0);
  assert.ok(state.marketReads>0);if('browserLogins' in state)assert.equal(state.browserLogins,0);
}

test('public Auto Analyser works before and during a failed dummy booking login',async t=>{
  const api=await server(t,'rejected');
  const result=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.selections.length);
  assertPublicOnly(await api.state());
  const booking=await api.post('/api/sportybet/book',{selections:result.body.selections});
  assert.equal(booking.status,503,JSON.stringify(booking.body));assert.equal(booking.body.bookingErrorCode,'SPORTYBET_AUTH_FAILED');
  assert.equal(booking.body.authFailure.code,'SPORTYBET_AUTH_FAILED');
  const retry=await api.post('/api/sportybet/book',{selections:result.body.selections});
  assert.equal(retry.status,503);assert.ok(retry.body.retryAt);
  const publicRetry=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(publicRetry.status,200,JSON.stringify(publicRetry.body));assert.ok(publicRetry.body.selections.length);
  const diagnostics=await api.get('/api/sportybet/diagnostics');
  assert.equal(diagnostics.body.publicDataProbe.ok,true);assert.equal(diagnostics.body.session.keepAliveRunning,false);
  assert.equal(diagnostics.body.session.authenticationScope,'booking');assert.equal(diagnostics.body.session.dataReadAccess,'public');
  const state=await api.state();assert.equal(state.logins,1);assert.equal(state.ciphers,1);assert.equal(state.accountChecks,0);assert.equal(state.bookings,0);
  assert.doesNotMatch(JSON.stringify([booking.body,retry.body,publicRetry.body,diagnostics.body]),/mock-test-password|2348000000000/);
});

test('browser bootstrap is used only after public analysis requests a booking code',async t=>{
  const api=await server(t,'browser');
  const result=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.selections.every(s=>s.live&&s.quickCash));
  assertPublicOnly(await api.state());
  const booking=await api.post('/api/sportybet/book',{selections:result.body.selections});
  assert.equal(booking.status,200,JSON.stringify(booking.body));assert.equal(booking.body.shareCode,'SESSION-TEST-CODE');
  const state=await api.state();assert.equal(state.logins,0);assert.equal(state.accountChecks,1);assert.equal(state.bookings,1);
  const next=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(next.status,200);assert.equal((await api.state()).accountChecks,1);
});

test('an expired saved session recovers automatically at booking without blocking public analysis',async t=>{
  const api=await server(t,'automated');
  const result=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.selections.length);
  assertPublicOnly(await api.state());
  const booking=await api.post('/api/sportybet/book',{selections:result.body.selections});
  assert.equal(booking.status,200,JSON.stringify(booking.body));assert.equal(booking.body.shareCode,'SESSION-TEST-CODE');
  const state=await api.state();assert.equal(state.browserLogins,1);assert.equal(state.accountChecks,1);
  assert.equal(state.logins,0);assert.equal(state.ciphers,0);assert.equal(state.bookings,1);
});

test('public diagnostics and live analysis work when booking browser sign-in fails',async t=>{
  const api=await server(t,'browser-failure');
  const result=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(result.status,200);assertPublicOnly(await api.state());
  const booking=await api.post('/api/sportybet/book',{selections:result.body.selections});
  assert.equal(booking.status,503);assert.equal(booking.body.authFailure.stage,'navigation');
  const diagnostics=await api.get('/api/sportybet/diagnostics');
  assert.equal(diagnostics.status,200);assert.equal(diagnostics.body.publicDataProbe.ok,true);
  assert.equal(diagnostics.body.session.lastLoginFailure.reason,'browser_navigation_timeout');
  const retry=await api.post('/api/sportybet/auto-pick',request);assert.equal(retry.status,200);
  const state=await api.state();assert.equal(state.browserLogins,1);assert.equal(state.bookings,0);assert.ok(state.marketReads>0);
});

test('booking and session diagnostics preserve page-check failures while data requests stay public',async t=>{
  const api=await server(t,'page-check-failure');
  const result=await api.post('/api/sportybet/auto-pick',request);
  assert.equal(result.status,200);assertPublicOnly(await api.state());
  const body={selections:result.body.selections};
  const booking=await api.post('/api/sportybet/book',body);
  assert.equal(booking.status,503);assert.equal(booking.body.authFailure.reason,'browser_page_timeout');
  assert.equal(booking.body.authFailure.pageCheck,'body_ready');assert.equal(booking.body.authFailure.pageCheckAttempt,2);
  const retry=await api.post('/api/sportybet/book',body);
  assert.equal(retry.body.authFailure.pageCheck,'body_ready');assert.ok(retry.body.retryAt);
  const diagnostics=await api.get('/api/sportybet/diagnostics');
  assert.equal(diagnostics.body.session.lastLoginFailure.pageCheck,'body_ready');assert.equal(diagnostics.body.publicDataProbe.ok,true);
  const live=await api.get('/api/sportybet/live/odds?sport=football&market=all');assert.equal(live.status,200);
  assert.doesNotMatch(JSON.stringify([booking.body,retry.body,diagnostics.body]),/fixture-private-call-log|mock-test-password/);
  assert.equal((await api.state()).browserLogins,1);
});

test('the HTTP booking job returns before slow login, survives connection close and recovers one completed code',async t=>{
  const api=await server(t,'delayed-booking');
  const picked=await api.post('/api/sportybet/auto-pick',request);assert.equal(picked.status,200);assertPublicOnly(await api.state());
  const body={requestId:randomUUID(),selections:picked.body.selections},headers={Prefer:'respond-async',Connection:'close'};
  const first=await api.post('/api/sportybet/book',body,headers);
  assert.equal(first.status,202,JSON.stringify(first.body));assert.equal(first.body.requestId,body.requestId);
  const until=async check=>{for(let i=0;i<100;i++){const state=await api.state();if(check(state))return state;await new Promise(resolve=>setTimeout(resolve,10));}assert.fail('Booking stage did not advance');};
  await until(state=>state.browserLogins===1);
  const retry=await api.post('/api/sportybet/book',body,headers);assert.equal(retry.status,202);
  const publicWhileLogin=await api.post('/api/sportybet/auto-pick',request);assert.equal(publicWhileLogin.status,200);
  assert.equal((await api.get(first.body.statusUrl)).status,202);
  await api.state('release_login');await until(state=>state.bookings===1);
  assert.equal((await api.get(first.body.statusUrl)).status,202);
  await api.state('release_booking');
  let finished;
  for(let i=0;i<100;i++){finished=await api.get(first.body.statusUrl);if(finished.status!==202)break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(finished.status,200,JSON.stringify(finished.body));assert.equal(finished.body.shareCode,'SESSION-TEST-CODE');assert.ok(finished.body.telegramSendToken);
  const completed=await api.post('/api/sportybet/book',body,headers);assert.equal(completed.body.shareCode,finished.body.shareCode);
  assert.equal(completed.body.telegramSendToken,finished.body.telegramSendToken);
  const state=await api.state();assert.equal(state.browserLogins,1);assert.equal(state.bookings,1);
  assert.doesNotMatch(JSON.stringify(finished.body),/fresh-browser-token|fresh-refresh|mock-test-password/);
});
