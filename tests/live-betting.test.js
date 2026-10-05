'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getSportMarket, getLiveSportMarket, validateLiveSelections, isLiveEvent, direct, SPORT_CONFIG, SPORT_IDS } = require('../lib/sportybet');

const headers = { get: k => (k === 'content-type' ? 'application/json' : null), getSetCookie: () => [] };
const jsonResponse = (data, {ok=true, status=200} = {}) => ({
  ok, status, headers,
  text: async () => JSON.stringify(ok ? {status:'success',data} : data),
});

const market = (id, desc, outcomes) => ({id, desc, outcomes});
const outcome = (id, desc, specifier, odds) => ({id, desc, odds, specifier});
const LIVE_PATHS = ['/factsCenter/liveOrPrematchEvents','/factsCenter/pcLiveEvents','/factsCenter/liveEvents','/factsCenter/liveSportEvents','/factsCenter/inplayEvents','/factsCenter/inPlayEvents','/factsCenter/pcLiveSportEvents'];

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
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
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
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
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

test('live candidate list leads with the observed liveOrPrematchEvents path', () => {
  const candidates = direct.ENDPOINT_CANDIDATES.live;
  assert.ok(candidates.includes('/factsCenter/liveOrPrematchEvents'), 'observed live path must be probed');
  assert.equal(candidates[0], '/factsCenter/liveOrPrematchEvents');
});

test('isLiveEvent separates in-play events from prematch and finished ones', () => {
  const now = Date.now();
  // Explicit flags win
  assert.equal(isLiveEvent({ live: true }), true);
  assert.equal(isLiveEvent({ inPlay: 1 }), true);
  assert.equal(isLiveEvent({ live: false, estimateStartTime: now - 60000 }), false);
  assert.equal(isLiveEvent({ live: '0', estimateStartTime: now - 60000 }), false);
  // Status text
  assert.equal(isLiveEvent({ liveStatus: '1st half' }), true);
  assert.equal(isLiveEvent({ matchStatus: 'In play' }), true);
  assert.equal(isLiveEvent({ status: 'Not started', estimateStartTime: now - 60000 }), false);
  assert.equal(isLiveEvent({ status: 'Ended', estimateStartTime: now - 60000 }), false);
  assert.equal(isLiveEvent({ sportEventStatus: { status: 'Halftime' } }), true);
  // Kickoff fallback when no flag/status exists
  assert.equal(isLiveEvent({ estimateStartTime: now - 30 * 60000 }), true, 'started 30 min ago = live');
  assert.equal(isLiveEvent({ estimateStartTime: now + 3600000 }), false, 'future kickoff = prematch');
  assert.equal(isLiveEvent({ estimateStartTime: now - 20 * 3600000 }), false, 'started 20h ago = stale/finished');
  // No signal at all stays permissive (a live-only endpoint is unaffected)
  assert.equal(isLiveEvent({ eventId: 'sr:match:x' }), true);
});

test('mixed liveOrPrematch feed keeps only in-play events for live mode', async () => {
  const now = Date.now();
  // Basketball keeps this test on its own sportId cache key (the 15s live TTL
  // cache in lib/sportybet.js is shared across tests in this process).
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.basketball);
    return jsonResponse([
      // In-play: started 40 minutes ago
      {eventId:'sr:match:live1',homeTeamName:'Live BC',awayTeamName:'Real Test',estimateStartTime:now-2400000,
       tournament:'Live League',
       markets:[market('1','1X2',[outcome('1','Home',null,2.10)])]},
      // In-play via explicit status, no kickoff time
      {eventId:'sr:match:live2',homeTeamName:'Status Utd',awayTeamName:'Phase City',liveStatus:'3rd quarter',
       tournament:'Live League',
       markets:[market('1','1X2',[outcome('1','Home',null,3.10)])]},
      // Prematch: tips off tomorrow — must NOT appear as a live row
      {eventId:'sr:match:pre1',homeTeamName:'Future BC',awayTeamName:'Later Town',estimateStartTime:now+86400000,
       tournament:'Prematch League',
       markets:[market('1','1X2',[outcome('1','Home',null,1.50)])]},
      // Finished: past kickoff but explicitly ended
      {eventId:'sr:match:done1',homeTeamName:'Done BC',awayTeamName:'Over United',estimateStartTime:now-7200000,status:'Ended',
       tournament:'Live League',
       markets:[market('1','1X2',[outcome('1','Home',null,1.10)])]},
    ]);
  });
  try {
    const all = await getLiveSportMarket('basketball','all',{maxPages:1});
    const eventIds = [...new Set(all.rows.map(r => r.eventId))].sort();
    assert.deepEqual(eventIds, ['sr:match:live1','sr:match:live2']);
    assert.equal(all.rows.length, 2);
    assert.ok(all.rows.every(r => r.home && r.outcomeId && r.odds > 1));
  } finally { direct.setFetchForTesting(null); }
});

test('live booking validation drops legs whose match left the in-play board', async () => {
  const now = Date.now();
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    return jsonResponse([
      // Same event id, but now back on the board as a not-started (prematch) row
      {eventId:'sr:match:flip',homeTeamName:'Flip FC',awayTeamName:'Flop United',estimateStartTime:now+3600000,
       markets:[market('1','1X2',[outcome('1','Home',null,2.00)])]},
      {eventId:'sr:match:live1',homeTeamName:'Live FC',awayTeamName:'Real Test',estimateStartTime:now-1200000,
       markets:[market('1','1X2',[outcome('1','Home',null,2.35)])]},
    ]);
  });
  try {
    const { valid, dropped } = await validateLiveSelections([
      {sport:'football',eventId:'sr:match:live1',marketId:'1',outcomeId:'1'},
      {sport:'football',eventId:'sr:match:flip',marketId:'1',outcomeId:'1'},
    ], {maxPages:1});
    assert.equal(valid.length, 1);
    assert.equal(valid[0].eventId, 'sr:match:live1');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].eventId, 'sr:match:flip', 'prematch row on the mixed feed must not validate as live');
  } finally { direct.setFetchForTesting(null); }
});
