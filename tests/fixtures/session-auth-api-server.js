'use strict';
// Each fixture enables only the automation it exercises.
process.env.SPORTYBET_PUBLIC_CACHE_ENABLED='false';
process.env.TELEGRAM_NEXT12H_ENABLED='false';
const assert = require('node:assert/strict');
const express = require('express');
const {direct, SPORT_IDS, extractUpcomingEvents} = require('../../lib/sportybet');
const {boards} = require('./sportybet-live-format');
const fixture = boards();
const state = {logins:0, ciphers:0, accountChecks:0, marketReads:0, bookings:0, lookupReads:0};
const delayed=process.env.SESSION_TEST_MODE==='delayed-booking';
const publicBooking=process.env.SESSION_TEST_MODE.startsWith('public');
const publicDelayed=process.env.SESSION_TEST_MODE==='public-delayed';
const automated=process.env.SESSION_TEST_MODE==='automated'||delayed;
let releaseLogin,releaseBooking;
const pageCheckFailure=process.env.SESSION_TEST_MODE==='page-check-failure';
const browserFailure=process.env.SESSION_TEST_MODE==='browser-failure'||pageCheckFailure;
const successful = process.env.SESSION_TEST_MODE === 'browser'||automated;
if(publicBooking){state.browserLogins=0;direct.setBrowserLoginForTesting(async()=>{state.browserLogins++;assert.fail('Anonymous booking must never open a login browser');});}
if(automated) {
  state.browserLogins=0;
  direct.setBrowserLoginForTesting(async()=>{state.browserLogins++;if(delayed)await new Promise(resolve=>{releaseLogin=resolve;});return {verifiedAt:0,cookies:[
    {name:'accessToken',value:'fresh-browser-token',expiresAt:Date.now()+3600000},
    {name:'refreshToken',value:'fresh-refresh',expiresAt:Date.now()+86400000},
    {name:'deviceId',value:'fresh-device',expiresAt:null},
  ]};});
}
if(browserFailure){
  state.browserLogins=0;
  direct.setBrowserLoginForTesting(async()=>{state.browserLogins++;throw Object.assign(Error('Fixture browser step timed out'),
    {code:'SPORTYBET_AUTH_FAILED',reason:pageCheckFailure?'browser_page_timeout':'browser_navigation_timeout',
      diagnostics:pageCheckFailure?{reason:'browser_page_timeout',stage:'page_check',pageCheck:'body_ready',pageCheckAttempt:2,httpStatus:200,
        proxyConfigured:false,raw:'fixture-private-call-log'}:{reason:'browser_navigation_timeout',stage:'navigation',proxyConfigured:false}});});
}
const bySportId = new Map(Object.entries(SPORT_IDS).map(([sport, id]) => [id, fixture[sport]]));
const response = (payload,status=200) => ({ok:status>=200&&status<300, status,
  headers:{get:name => name === 'content-type' ? 'application/json' : null, getSetCookie:() => []},
  text:async () => JSON.stringify(payload)});
direct.setFetchForTesting(async (url, options) => {
  const parsed = new URL(url), endpoint = parsed.pathname;
  if(automated&&endpoint.endsWith('/patron/refresh'))return response({bizCode:11000,message:'Refresh token expired'});
  if (endpoint.endsWith('/patron/cipher')) {
    state.ciphers++;
    return response({bizCode:10000, data:{password:Buffer.alloc(16, 1).toString('base64'), ursId:'mock-cipher'}});
  }
  if (endpoint.endsWith('/patron/accessToken')) {
    state.logins++;
    return response({bizCode:12000, innerMsg:'Mock failure', message:'Looks like we’re having trouble on our end. Please try again later.'});
  }
  if(endpoint.includes('/factsCenter/') || endpoint.includes('/orders/share') && options.method==='GET'){
    for(const key of Object.keys(options.headers))assert.doesNotMatch(key,/^(cookie|authorization|token|accessToken|refreshToken|device-id)$/i);
    if(endpoint.includes('/orders/share')) {
      state.lookupReads++;
      const event=extractUpcomingEvents(fixture.football).events[0];
      return response({bizCode:10000,data:{outcomes:[{sport:'Football',eventId:event.eventId,marketId:'1',marketDesc:'1X2',outcomeId:'1',outcomeDesc:'Home',odds:1.05}]}});
    }
    state.marketReads++;
    const id=parsed.searchParams.get('eventId');
    if(id)return response({bizCode:10000,data:Object.values(fixture).flatMap(payload=>extractUpcomingEvents(payload).events).find(event=>event.eventId===id)||{}});
    return response(bySportId.get(parsed.searchParams.get('sportId'))||fixture.football);
  }
  if(publicBooking&&endpoint.endsWith('/orders/share')&&options.method==='POST'){
    for(const key of Object.keys(options.headers))assert.doesNotMatch(key,/^(cookie|authorization|token|accessToken|refreshToken|device-?id)$/i);
    assert.equal(options.headers['Current-Country'],'NG');assert.equal(options.headers['Content-Type'],'application/json;charset=UTF-8');
    const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body),['selections']);
    assert.ok(body.selections.every(s=>Object.keys(s).sort().join(',')==='eventId,marketId,outcomeId,specifier'));
    state.bookings++;if(publicDelayed)await new Promise(resolve=>{releaseBooking=resolve;});
    return process.env.SESSION_TEST_MODE==='public-rejected'?response({bizCode:11000,message:'Login required'},401):response({bizCode:10000,data:{shareCode:'ANONYMOUS-TEST-CODE'}});
  }
  assert.equal(successful, true, 'Only explicit session mode can contact private account endpoints');
  assert.match(options.headers.Cookie, /accessToken=fresh-browser-token/);
  assert.match(options.headers.Cookie, /deviceId=fresh-device/);
  assert.equal(options.headers.authorization, undefined, 'A stale persisted bearer token must be removed');
  if (endpoint.endsWith('/patron/account/info')) {
    state.accountChecks++; return response({bizCode:10000, data:{userId:'dummy-test-user'}});
  }
  if (endpoint.endsWith('/orders/share')) {
    state.bookings++;if(delayed)await new Promise(resolve=>{releaseBooking=resolve;});
    return response({bizCode:10000, data:{shareCode:'SESSION-TEST-CODE'}});
  }
  assert.fail('Unexpected private endpoint: '+endpoint);
});
const listen = express.application.listen;
express.application.listen = function (...args) {
  const server = listen.apply(this, args);
  server.on('listening', () => process.send({port:server.address().port}));
  return server;
};
process.on('message', message => {
  if(message.type==='release_login')releaseLogin?.();
  if(message.type==='release_booking')releaseBooking?.();
  if(['state','release_login','release_booking'].includes(message.type))process.send({id:message.id,state});
});
require('../../server');
