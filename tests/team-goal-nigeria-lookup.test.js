'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getFootballMarket } = require('../lib/sportybet');
const { buildCandidates } = require('../lib/autoPicker');

const originalKey = process.env.PARSE_API_KEY;
const originalFetch = global.fetch;
const future = new Date(Date.now() + 86400000).toISOString();
const fixture = eventId => ({eventId,home:'Alpha FC',away:'Beta FC',kickoffUtc:future,homeO05:85,awayO05:80,homeU45:97,awayU45:95});
const marketRow = (eventId, marketId, marketDesc, outcomeId, outcomeDesc, specifier, odds=1.31) => ({
  eventId, marketId, marketDesc, outcomeId, outcomeDesc, specifier, odds,
  homeTeamName:'Alpha FC',awayTeamName:'Beta FC',estimateStartTime:Date.parse(future),
});
const response = data => ({ok:true,text:async()=>JSON.stringify({status:'success',data})});

// Node's test runner executes test files in separate processes. Keep each mock
// isolated within this file, avoiding actual paid Parse.bot API requests.
test('all four team-total markets reuse ONE Nigeria event call and preserve exact bookmaker IDs', async () => {
  process.env.PARSE_API_KEY='test-placeholder-not-real';
  const id='sr:match:99000111';
  const urls=[];
  global.fetch=async url => {
    urls.push(String(url));
    const u=new URL(url);
    assert.equal(u.pathname.split('/').pop(),'get_football_event_markets');
    assert.equal(u.searchParams.get('event_id'),id);
    assert.ok(u.pathname.includes('8e652912-d760-4522-85ce-071e539a9c12'));
    return response({outcomes:[
      marketRow(id,'701','Home Team Total Goals','12','Over','total=0.5'),
      marketRow(id,'701','Home Team Total Goals','13','Under','total=4.5'),
      marketRow(id,'702','Away Total','12','Over','total=0.5'),
      marketRow(id,'702','Away Total','13','Under','total=4.5'),
      marketRow(id,'18','Over/Under','12','Over','total=0.5'),
      marketRow(id,'999','1st Half Home Total','12','Over','total=0.5'),
      marketRow(id,'998','Home Total Corners','13','Under','total=4.5'),
    ]});
  };
  try {
    const kinds=['home_ou05','away_ou05','home_ou45','away_ou45'];
    const results=await Promise.all(kinds.map(k=>getFootballMarket(k,{hours:72,fixtures:[fixture(id)]})));
    assert.equal(urls.length,1,'one paid call must serve all four targets');
    assert.deepEqual(results.map(result=>result.rows.length),[1,1,1,1]);
    assert.deepEqual(results.map(result=>result.rows[0].marketId),['701','702','701','702']);
    assert.deepEqual(results.map(result=>result.rows[0].outcomeId),['12','12','13','13']);
    assert.ok(results.every(r=>r.teamGoalDiagnostics.status==='available'));
    const candidates=buildCandidates({
      predictions:{matches:[fixture(id)]},
      footballMarkets:Object.fromEntries(kinds.map((kind,i)=>[kind,results[i]])),
      betTypes:['home_over05','away_over05','home_under45','away_under45'],
      sportScope:'football',minProbability:0,minEdge:-25,
    });
    assert.deepEqual(new Set(candidates.map(c=>c.betType)),new Set(['home_over05','away_over05','home_under45','away_under45']));
  } finally {global.fetch=originalFetch; if(originalKey===undefined)delete process.env.PARSE_API_KEY;else process.env.PARSE_API_KEY=originalKey;}
});

test('if bookmaker has no exact 0.5/4.5 team totals, report unavailability without making up a booking selection',async()=>{
  process.env.PARSE_API_KEY='test-placeholder-not-real';
  const id='sr:match:99000222';
  let calls=0;
  global.fetch=async url=>{
    calls++;
    const u=new URL(url);
    assert.equal(u.pathname.split('/').pop(),'get_football_event_markets');
    return response({outcomes:[marketRow(id,'18','Over/Under','12','Over','total=0.5')]});
  };
  try {
    const got=await getFootballMarket('home_ou05',{hours:72,fixtures:[fixture(id)]});
    assert.equal(calls,1);
    assert.equal(got.rows.length,0);
    assert.equal(got.teamGoalDiagnostics.status,'no_exact_team_total_lines_in_scanned_events');
  } finally {global.fetch=originalFetch; if(originalKey===undefined)delete process.env.PARSE_API_KEY;else process.env.PARSE_API_KEY=originalKey;}
});

test('subscription errors are distinguished from bookmaker markets genuinely not being offered',async()=>{
  process.env.PARSE_API_KEY='test-placeholder-not-real';
  const id='sr:match:99000333';
  let calls=0;
  global.fetch=async()=>{calls++;return {ok:false,status:403,text:async()=>JSON.stringify({error:'subscription_required'})};};
  try {
    const got=await getFootballMarket('away_ou45',{hours:72,fixtures:[fixture(id)]});
    assert.equal(calls,1);
    assert.equal(got.rows.length,0);
    assert.equal(got.teamGoalDiagnostics.status,'event_market_endpoint_unavailable');
    assert.equal(got.teamGoalDiagnostics.failedEvents,1);
  } finally {global.fetch=originalFetch; if(originalKey===undefined)delete process.env.PARSE_API_KEY;else process.env.PARSE_API_KEY=originalKey;}
});
