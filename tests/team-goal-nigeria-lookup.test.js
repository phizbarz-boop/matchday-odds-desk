'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { getFootballMarket, direct } = require('../lib/sportybet');
const { buildCandidates } = require('../lib/autoPicker');

const future = new Date(Date.now() + 86400000).toISOString();
const fixture = eventId => ({eventId,home:'Alpha FC',away:'Beta FC',kickoffUtc:future,homeO05:85,awayO05:80,homeU45:97,awayU45:95});

// SportyBet's direct event-detail shape: markets embedded in the event payload.
const market = (id, desc, outcomes) => ({id, desc, outcomes});
const outcome = (id, desc, specifier, odds=1.31) => ({id, desc, odds, specifier});

const headers = { get: k => (k === 'content-type' ? 'application/json' : null), getSetCookie: () => [] };
const jsonResponse = (data, {ok=true, status=200} = {}) => ({
  ok, status, headers,
  text: async () => JSON.stringify(ok ? {status:'success',data} : data),
});

// Node's test runner executes test files in separate processes. The fetch hook
// is injected into the direct client, so no real SportyBet request is made.
test('all four team-total markets reuse ONE event call and preserve exact bookmaker IDs', async () => {
  const id='sr:match:99000111';
  const urls=[];
  direct.setFetchForTesting(async url => {
    urls.push(String(url));
    const u=new URL(url);
    // First event-detail candidate is /factsCenter/eventDetail; the resolver may
    // pick any factsCenter path, but the event id param name must be eventId.
    assert.ok(u.pathname.includes('/factsCenter/'));
    assert.equal(u.searchParams.get('eventId'),id);
    return jsonResponse({eventId:id,markets:[
      market('701','Home Team Total Goals',[outcome('12','Over','total=0.5'),outcome('13','Under','total=4.5')]),
      market('702','Away Total',[outcome('12','Over','total=0.5'),outcome('13','Under','total=4.5')]),
      market('18','Over/Under',[outcome('12','Over','total=0.5')]),
      market('999','1st Half Home Total',[outcome('12','Over','total=0.5')]),
      market('998','Home Total Corners',[outcome('13','Under','total=4.5')]),
    ]});
  });
  try {
    const kinds=['home_ou05','away_ou05','home_ou45','away_ou45'];
    const results=await Promise.all(kinds.map(k=>getFootballMarket(k,{hours:72,fixtures:[fixture(id)]})));
    assert.equal(urls.length,1,'one upstream call must serve all four targets');
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
  } finally {direct.setFetchForTesting(null);}
});

test('if bookmaker has no exact 0.5/4.5 team totals, report unavailability without making up a booking selection',async()=>{
  const id='sr:match:99000222';
  let calls=0;
  direct.setFetchForTesting(async ()=>{
    calls++;
    return jsonResponse({eventId:id,markets:[
      market('18','Over/Under',[outcome('12','Over','total=0.5')]),
    ]});
  });
  try {
    const got=await getFootballMarket('home_ou05',{hours:72,fixtures:[fixture(id)]});
    assert.equal(calls,1);
    assert.equal(got.rows.length,0);
    assert.equal(got.teamGoalDiagnostics.status,'no_exact_team_total_lines_in_scanned_events');
  } finally {direct.setFetchForTesting(null);}
});

test('upstream errors are distinguished from bookmaker markets genuinely not being offered',async()=>{
  const id='sr:match:99000333';
  let calls=0;
  direct.setFetchForTesting(async ()=>{
    calls++;
    return jsonResponse({error:'forbidden'},{ok:false,status:403});
  });
  try {
    const got=await getFootballMarket('away_ou45',{hours:72,fixtures:[fixture(id)]});
    assert.equal(calls,1);
    assert.equal(got.rows.length,0);
    assert.equal(got.teamGoalDiagnostics.status,'event_market_endpoint_unavailable');
    assert.equal(got.teamGoalDiagnostics.failedEvents,1);
  } finally {direct.setFetchForTesting(null);}
});

test('football 1X2 rows are flattened from prematch pages embedded markets',async()=>{
  let pages=0;
  direct.setFetchForTesting(async url=>{
    const u=new URL(url);
    // Prematch list default is pcUpcomingEvents with sportId + marketId params.
    assert.ok(u.pathname.endsWith('/factsCenter/pcUpcomingEvents'));
    assert.equal(u.searchParams.get('sportId'),'sr:sport:1');
    assert.ok((u.searchParams.get('marketId')||'').split(',').includes('1'),'marketId CSV must include 1X2 id');
    pages++;
    return jsonResponse([
      {eventId:'sr:match:1',homeTeamName:'Alpha FC',awayTeamName:'Beta FC',estimateStartTime:Date.parse(future),
       tournament:'Test League',
       markets:[market('1','1X2',[outcome('1','Home',null,1.8),outcome('2','Draw',null,3.4),outcome('3','Away',null,4.2)]),
                market('29','GG/NG',[outcome('1','GG',null,1.9)])]},
    ]);
  });
  try {
    const res=await getFootballMarket('1x2',{hours:72,maxPages:1});
    assert.equal(pages,1);
    assert.equal(res.rows.length,3);
    assert.equal(res.rows[0].home,'Alpha FC');
    assert.equal(res.rows[0].marketId,'1');
    assert.equal(res.rows[0].kickoffUtc,new Date(Date.parse(future)).toISOString());
  } finally {direct.setFetchForTesting(null);}
});
