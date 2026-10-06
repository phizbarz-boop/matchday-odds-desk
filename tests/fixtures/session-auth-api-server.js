'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const {direct, SPORT_IDS, extractUpcomingEvents} = require('../../lib/sportybet');
const {boards} = require('./sportybet-live-format');
const fixture = boards();
const state = {logins:0, ciphers:0, accountChecks:0, marketReads:0, bookings:0};
const successful = process.env.SESSION_TEST_MODE === 'browser';
const bySportId = new Map(Object.entries(SPORT_IDS).map(([sport, id]) => [id, fixture[sport]]));
const response = payload => ({ok:true, status:200,
  headers:{get:name => name === 'content-type' ? 'application/json' : null, getSetCookie:() => []},
  text:async () => JSON.stringify(payload)});
direct.setFetchForTesting(async (url, options) => {
  const parsed = new URL(url), endpoint = parsed.pathname;
  if (endpoint.endsWith('/patron/cipher')) {
    state.ciphers++;
    return response({bizCode:10000, data:{password:Buffer.alloc(16, 1).toString('base64'), ursId:'mock-cipher'}});
  }
  if (endpoint.endsWith('/patron/accessToken')) {
    state.logins++;
    return response({bizCode:12000, innerMsg:'Mock failure', message:'Looks like we’re having trouble on our end. Please try again later.'});
  }
  assert.equal(successful, true, 'A rejected login must stop the market scan');
  assert.match(options.headers.Cookie, /accessToken=fresh-browser-token/);
  assert.match(options.headers.Cookie, /deviceId=fresh-device/);
  assert.equal(options.headers.authorization, undefined, 'A stale persisted bearer token must be removed');
  if (endpoint.endsWith('/patron/account/info')) {
    state.accountChecks++; return response({bizCode:10000, data:{userId:'dummy-test-user'}});
  }
  if (endpoint.endsWith('/orders/share')) {
    state.bookings++; return response({bizCode:10000, data:{shareCode:'SESSION-TEST-CODE'}});
  }
  assert.ok(endpoint.includes('/factsCenter/'));
  state.marketReads++;
  const id = parsed.searchParams.get('eventId');
  if (id) {
    const event = Object.values(fixture).flatMap(payload => extractUpcomingEvents(payload)).find(e => e.eventId === id);
    return response({bizCode:10000, data:event || {}});
  }
  return response(bySportId.get(parsed.searchParams.get('sportId')) || {bizCode:10000, data:[]});
});
const listen = express.application.listen;
express.application.listen = function (...args) {
  const server = listen.apply(this, args);
  server.on('listening', () => process.send({port:server.address().port}));
  return server;
};
process.on('message', message => { if (message.type === 'state') process.send({id:message.id, state}); });
require('../../server');
