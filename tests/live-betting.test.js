'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSportMarket, getLiveSportMarket, validateLiveSelections, direct, SPORT_CONFIG, SPORT_IDS } = require('../lib/sportybet');

const headers = { get: k => (k === 'content-type' ? 'application/json' : null), getSetCookie: () => [] };
const jsonResponse = (data, {ok=true, status=200} = {}) => ({
  ok, status, headers,
  text: async () => JSON.stringify(ok ? {status:'success',data} : data),
});

const market = (id, desc, outcomes) => ({id, desc, outcomes});
const outcome = (id, desc, specifier, odds) => ({id, desc, odds, specifier});

test('all six sports are configured with SportyBet sport ids', () => {
  for (const s of ['football','basketball','tennis','hockey','volleyball','handball']) {
    assert.ok(SPORT_IDS[s], `missing sport id for ${s}`);
  }
  for (const s of ['basketball','tennis','hockey','volleyball','handball']) {
    assert.ok(SPORT_CONFIG[s]?.markets?.winner, `missing winner market for ${s}`);
  }
});

test('tennis prematch rows are scraped directly from SportyBet pages', async () => {
  const future = Date.now() + 86400000;
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    // First prematch candidate is pcUpcomingEvents; any factsCenter path the
    // resolver picks is acceptable, but the params must use sportId naming.
    assert.ok(u.pathname.includes('/factsCenter/'));
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.tennis);
    return jsonResponse([
      {eventId:'sr:match:t1',homeTeamName:'Player A',awayTeamName:'Player B',estimateStartTime:future,
       tournament:'ATP Test Open',
       markets:[market('177','Winner',[outcome('1','Player A',null,1.65),outcome('2','Player B',null,2.25)]),
                market('186','Over/Under',[outcome('12','Over','total=22.5',1.9)])]},
    ]);
  });
  try {
    const res = await getSportMarket('tennis','winner',{hours:72,maxPages:1});
    assert.equal(res.rows.length,2);
    assert.equal(res.rows[0].sport,'Tennis');
    assert.equal(res.rows[0].tournament,'ATP Test Open');
    assert.equal(res.rows[0].marketDesc,'Winner');
  } finally { direct.setFetchForTesting(null); }
});

test('live board scrape returns all bet types with live flag and real ids', async () => {
  const livePaths = ['/factsCenter/pcLiveEvents','/factsCenter/liveEvents','/factsCenter/liveSportEvents','/factsCenter/inplayEvents','/factsCenter/inPlayEvents','/factsCenter/pcLiveSportEvents'];
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(livePaths.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.football);
    return jsonResponse([
      {eventId:'sr:match:live1',homeTeamName:'Live FC',awayTeamName:'Real Test',estimateStartTime:Date.now()-1800000,
       tournament:'Live League',
       markets:[market('1','1X2',[outcome('1','Home',null,2.10),outcome('2','Draw',null,2.90)]),
                market('29','GG/NG',[outcome('1','GG',null,2.40)])]},
    ]);
  });
  try {
    const all = await getLiveSportMarket('football','all',{maxPages:1});
    assert.equal(all.live,true);
    assert.equal(all.rows.length,3);
    const only1x2 = await getLiveSportMarket('football','1x2',{maxPages:1});
    assert.equal(only1x2.rows.length,2);
    assert.ok(only1x2.rows.every(r=>r.marketId==='1'));
    assert.ok(all.rows.every(r=>r.eventId==='sr:match:live1'&&r.outcomeId));
  } finally { direct.setFetchForTesting(null); }
});

test('live booking validation drops suspended legs and keeps offered ones with fresh odds', async () => {
  const livePaths = ['/factsCenter/pcLiveEvents','/factsCenter/liveEvents','/factsCenter/liveSportEvents','/factsCenter/inplayEvents','/factsCenter/inPlayEvents','/factsCenter/pcLiveSportEvents'];
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(livePaths.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    return jsonResponse([
      {eventId:'sr:match:live1',homeTeamName:'Live FC',awayTeamName:'Real Test',
       markets:[market('1','1X2',[outcome('1','Home',null,2.35)])]}, // away outcome suspended; odds moved 2.10 -> 2.35
    ]);
  });
  try {
    const { valid, dropped } = await validateLiveSelections([
      {sport:'football',eventId:'sr:match:live1',marketId:'1',outcomeId:'1'},
      {sport:'football',eventId:'sr:match:live1',marketId:'1',outcomeId:'3'},
      {sport:'football',eventId:'sr:match:gone',marketId:'1',outcomeId:'1'},
    ], {maxPages:1});
    assert.equal(valid.length,1);
    assert.equal(valid[0].odds,2.35,'kept leg carries the current live price');
    assert.equal(dropped.length,2);
    assert.ok(dropped.every(d=>d.dropReason));
  } finally { direct.setFetchForTesting(null); }
});
