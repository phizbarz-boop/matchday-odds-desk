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
      {eventId:'sr:match:live1',live:true,homeTeamName:'Live FC',awayTeamName:'Real Test',estimateStartTime:Date.now()-1800000,
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
      {eventId:'sr:match:live1',live:true,homeTeamName:'Live FC',awayTeamName:'Real Test',
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
  // Finished status overrides a stale explicit flag
  assert.equal(isLiveEvent({ live: true }), true);
  assert.equal(isLiveEvent({ live:true,status:'Finished' }),false);
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
  assert.equal(isLiveEvent({ estimateStartTime: now - 30 * 60000 }), false, 'kickoff alone does not prove ongoing play');
  assert.equal(isLiveEvent({ estimateStartTime: now + 3600000 }), false, 'future kickoff = prematch');
  assert.equal(isLiveEvent({ estimateStartTime: now - 20 * 3600000 }), false, 'started 20h ago = stale/finished');
  // No signal at all is excluded from ongoing-only mode
  assert.equal(isLiveEvent({ eventId: 'sr:match:x' }), false);
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
      {eventId:'sr:match:live1',live:true,homeTeamName:'Live BC',awayTeamName:'Real Test',estimateStartTime:now-2400000,
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
      {eventId:'sr:match:live1',live:true,homeTeamName:'Live FC',awayTeamName:'Real Test',estimateStartTime:now-1200000,
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

test('live scan retries without the marketId param when it hides embedded live markets', async () => {
  const now = Date.now();
  const seenMarketParam = [];
  // Hockey keeps this test on its own sportId cache key (the 15s live TTL
  // cache is shared across tests in this process).
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.hockey);
    const hasMarketParam = !!u.searchParams.get('marketId');
    seenMarketParam.push(hasMarketParam);
    if (hasMarketParam) {
      // Live feed embeds nothing when asked for the prematch market ids.
      return jsonResponse([
        {eventId:'sr:match:r1',live:true,homeTeamName:'Retry HC',awayTeamName:'Param United',estimateStartTime:now-1200000,
         tournament:'Live Hockey League',markets:[]},
      ]);
    }
    // The site's own live call shape (sportId only) returns default markets.
    return jsonResponse([
      {eventId:'sr:match:r1',live:true,homeTeamName:'Retry HC',awayTeamName:'Param United',estimateStartTime:now-1200000,
       tournament:'Live Hockey League',
       markets:[market('1','1X2',[outcome('1','Home',null,2.10),outcome('2','Draw',null,3.40)])]},
    ]);
  });
  try {
    const res = await getLiveSportMarket('hockey','winner',{maxPages:1});
    assert.equal(res.rows.length, 2, 'default live feed must supply the winner rows');
    assert.ok(res.rows.every(r => r.marketId === '1'));
    assert.ok(seenMarketParam.includes(true) && seenMarketParam.includes(false), 'must retry once without the marketId param');
    assert.ok(seenMarketParam.indexOf(true) < seenMarketParam.lastIndexOf(false), 'marketId request comes first, retry second');
  } finally { direct.setFetchForTesting(null); }
});

test('live scan does not retry when the sport simply has no live events', async () => {
  let calls = 0;
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    calls++;
    return jsonResponse([]); // empty board
  });
  try {
    const res = await getLiveSportMarket('volleyball','winner',{maxPages:1});
    assert.equal(res.rows.length, 0);
    assert.equal(res.scannedEvents, 0);
    assert.equal(calls, 1, 'no retry when nothing is live');
  } finally { direct.setFetchForTesting(null); }
});

test('live scan retries without marketId even when the param empties the whole board', async () => {
  // Regression: on Render every live kind returned totalRows=0 with NO
  // "N live events scanned" line — i.e. scannedEvents === 0. The site's own
  // live call sends only sportId, so the marketId/page params are the prime
  // suspect; the old retry required scannedEvents > 0 and could never fire.
  // Handball keeps this on its own sportId cache key; the env override gives
  // it a marketId so the retry path is exercised.
  process.env.SPORTYBET_MARKET_IDS_HANDBALL = '1';
  const seenMarketParam = [];
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.handball);
    const hasMarketParam = !!u.searchParams.get('marketId');
    seenMarketParam.push(hasMarketParam);
    if (hasMarketParam) return jsonResponse([]); // param empties the board entirely
    return jsonResponse([
      {eventId:'sr:match:hb1',live:true,homeTeamName:'Hand A',awayTeamName:'Hand B',estimateStartTime:Date.now()-1200000,
       tournament:'Live Handball',
       markets:[market('1','1X2',[outcome('1','Home',null,1.80),outcome('2','Draw',null,3.40)])]},
    ]);
  });
  try {
    const res = await getLiveSportMarket('handball','winner',{maxPages:1});
    assert.equal(res.rows.length, 2, 'default live feed must supply rows even when the marketId page was empty');
    assert.ok(seenMarketParam.includes(true) && seenMarketParam.includes(false), 'must retry once without the marketId param');
    assert.ok(seenMarketParam.indexOf(true) < seenMarketParam.lastIndexOf(false), 'marketId request comes first, retry second');
  } finally {
    delete process.env.SPORTYBET_MARKET_IDS_HANDBALL;
    direct.setFetchForTesting(null);
  }
});

test('live booking validation falls back to the default live feed when marketId empties the board', async () => {
  // Same failure mode at booking time: without the fallback every live leg
  // would be dropped as "no longer offered" even though it is still offered.
  process.env.SPORTYBET_MARKET_IDS_HANDBALL = '1';
  const now = Date.now();
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.handball);
    if (u.searchParams.get('marketId')) return jsonResponse([]);
    return jsonResponse([
      {eventId:'sr:match:hbv',live:true,homeTeamName:'Val A',awayTeamName:'Val B',estimateStartTime:now-900000,
       tournament:'Live Handball',
       markets:[market('1','1X2',[outcome('1','Home',null,2.05)])]},
    ]);
  });
  try {
    const { valid, dropped } = await validateLiveSelections([
      {sport:'handball',eventId:'sr:match:hbv',marketId:'1',outcomeId:'1'},
    ], {maxPages:1});
    assert.equal(valid.length, 1, 'leg validated via the default live feed');
    assert.equal(valid[0].odds, 2.05, 'kept leg carries the current live price');
    assert.equal(dropped.length, 0);
  } finally {
    delete process.env.SPORTYBET_MARKET_IDS_HANDBALL;
    direct.setFetchForTesting(null);
  }
});

test('live zero-event pages log the payload shape so the cause is visible in Render logs', async () => {
  // Tennis keeps this on an unused live cache key in this process. The mock
  // returns a business-error envelope wrapped in a 200/success HTTP body —
  // exactly the silent-empty case that produced totalRows=0 with no clues.
  direct.setFetchForTesting(async url => {
    const u = new URL(url);
    assert.ok(LIVE_PATHS.some(p => u.pathname.endsWith(p)), `unexpected live path ${u.pathname}`);
    assert.equal(u.searchParams.get('sportId'), SPORT_IDS.tennis);
    return jsonResponse({ bizCode: 19000, message: 'Invalid', data: {} });
  });
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(' ')); };
  try {
    const res = await getLiveSportMarket('tennis','winner',{maxPages:1});
    assert.equal(res.rows.length, 0);
    assert.equal(res.scannedEvents, 0);
    const line = logs.find(l => l.includes('[SportyBet live]') && l.includes('0 events extracted'));
    assert.ok(line, 'zero-event pages must log the payload shape');
    assert.ok(line.includes('sr:sport:5'), 'diagnostic names the sport id');
    assert.ok(line.includes('bizCode=19000') || line.includes('Invalid'), 'diagnostic surfaces the error envelope');
  } finally {
    console.log = origLog;
    direct.setFetchForTesting(null);
  }
});
