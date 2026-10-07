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
const automated=process.env.SESSION_TEST_MODE==='automated';
const pageCheckFailure=process.env.SESSION_TEST_MODE==='page-check-failure';
const browserFailure=process.env.SESSION_TEST_MODE==='browser-failure'||pageCheckFailure;
const successful = process.env.SESSION_TEST_MODE === 'browser'||automated;
if(automated) {
  state.browserLogins=0;
  direct.setBrowserLoginForTesting(async()=>{state.browserLogins++;return {verifiedAt:0,cookies:[
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
const response = payload => ({ok:true, status:200,
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
  if(endpoint.includes('/factsCenter/') || endpoint.endsWith('/orders/share') && options.method==='GET'){
    for(const key of Object.keys(options.headers))assert.doesNotMatch(key,/^(cookie|authorization|token|accessToken|refreshToken|device-id)$/i);
    if(endpoint.endsWith('/orders/share')) {
      state.lookupReads++;
      const event=extractUpcomingEvents(fixture.football).events[0];
      return response({bizCode:10000,data:{outcomes:[{sport:'Football',eventId:event.eventId,marketId:'1',marketDesc:'1X2',outcomeId:'1',outcomeDesc:'Home',odds:1.05}]}});
    }
    state.marketReads++;
    const id=parsed.searchParams.get('eventId');
    if(id)return response({bizCode:10000,data:Object.values(fixture).flatMap(payload=>extractUpcomingEvents(payload).events).find(event=>event.eventId===id)||{}});
    return response(bySportId.get(parsed.searchParams.get('sportId'))||fixture.football);
  }
  assert.equal(successful, true, 'Only successful dummy authentication can create a booking');
  assert.match(options.headers.Cookie, /accessToken=fresh-browser-token/);
  assert.match(options.headers.Cookie, /deviceId=fresh-device/);
  assert.equal(options.headers.authorization, undefined, 'A stale persisted bearer token must be removed');
  if (endpoint.endsWith('/patron/account/info')) {
    state.accountChecks++; return response({bizCode:10000, data:{userId:'dummy-test-user'}});
  }
  if (endpoint.endsWith('/orders/share')) {
    state.bookings++; return response({bizCode:10000, data:{shareCode:'SESSION-TEST-CODE'}});
  }
  assert.fail('Unexpected private endpoint: '+endpoint);
});
const listen = express.application.listen;
express.application.listen = function (...args) {
  const server = listen.apply(this, args);
  server.on('listening', () => process.send({port:server.address().port}));
  return server;
};
process.on('message', message => { if (message.type === 'state') process.send({id:message.id, state}); });
require('../../server');
