'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const sporty=require('../lib/sportybet');
const {sportyRequest,withPublicSportyRequest,withFreshSportyRequest,memoSportyRead}=require('../lib/sportyRequest');
const {SPORTS,CACHE_KEY,collectPublicCatalog,createPublicCache,publicCandidates,validatePublicSelections}=require('../lib/sportyPublicCache');
const {market,outcome}=require('./fixtures/sportybet-live-format');
const {fakeRedis}=require('./fixtures/fake-redis');
const clock=new Date('2026-10-07T05:30:00Z');
const names={football:['1','1X2'],basketball:['219','Winner (incl. overtime)'],hockey:['1','1X2'],handball:['1','1X2'],volleyball:['186','Winner'],tennis:['186','Winner']};
function event(sport,i=0){const [id,desc]=names[sport],three=['football','hockey','handball'].includes(sport);
  return {eventId:`sr:match:public-${sport}-${i}`,homeTeamName:'Public Home '+sport+i,awayTeamName:'Public Away '+sport+i,
    estimateStartTime:clock.getTime()+3600000,status:0,matchStatus:'Not start',markets:[market(id,desc,three?
      [outcome('1','Home',2),outcome('2','Draw',3),outcome('3','Away',4)]:[outcome('4','Home',2),outcome('5','Away',3)])]};}
const envelope=events=>({bizCode:10000,data:{totalNum:events.length,tournaments:[{name:'Public League',events}]}});
function client(extra={}){const calls=[];return {calls,
  async fetchPrematchPage(id,page){assert.equal(sportyRequest().anonymous,true);const sport=SPORTS.find(s=>sporty.SPORT_IDS[s]===id);calls.push(['list',sport,page]);return envelope([event(sport)]);},
  async fetchEventDetail(id){assert.equal(sportyRequest().anonymous,true);calls.push(['detail',id]);const sport=SPORTS.find(s=>id.includes('-'+s+'-'));return {data:event(sport)};},...extra};}
const collect=c=>collectPublicCatalog({client:c,now:()=>clock,pause:async()=>{},env:{}});
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>['accessToken=public-response-cookie; Max-Age=3600']},text:async()=>JSON.stringify(data)});

test('public website reads never log in or attach/change the configured dummy session',async t=>{
  const direct=sporty.direct,prior=Object.fromEntries(['SPORTYBET_PHONE','SPORTYBET_PASSWORD'].map(k=>[k,process.env[k]]));
  const token=direct._session.token,cookies=new Map(direct._session.cookies);
  process.env.SPORTYBET_PHONE='2348000000000';process.env.SPORTYBET_PASSWORD='fixture-password';
  direct._session.token='private-fixture-token';direct._session.cookies.set('accessToken',{value:'private-fixture-cookie',expiresAt:null});
  t.after(()=>{direct.setFetchForTesting(null);direct._session.token=token;direct._session.cookies.clear();for(const [k,v] of cookies)direct._session.cookies.set(k,v);for(const [k,v] of Object.entries(prior))if(v==null)delete process.env[k];else process.env[k]=v;});
  const calls=[];direct.setFetchForTesting(async(url,options)=>{
    assert.match(new URL(url).pathname,/\/(?:factsCenter\/|orders\/share)/);
    for(const key of Object.keys(options.headers))assert.doesNotMatch(key,/^(cookie|authorization|token|accessToken|refreshToken)$/i);
    calls.push(url);return response(envelope([event('football')]));
  });
  await withPublicSportyRequest(async()=>{
    await direct.fetchPrematchPage(sporty.SPORT_IDS.football,1,100);await direct.fetchEventDetail('sr:match:public-football-0');
    await assert.rejects(direct.createBookingCode([]),e=>e.code==='SPORTYBET_PUBLIC_READ_ONLY');
    await direct.lookupBooking('FIXTURE');
    await assert.rejects(direct.sportyRequest('/patron/account/info',{auth:true}),e=>e.code==='SPORTYBET_PUBLIC_READ_ONLY');
  });
  assert.equal(calls.length,3);assert.equal(direct._session.token,'private-fixture-token');
  assert.equal(direct._session.cookies.get('accessToken').value,'private-fixture-cookie');
});
test('overlapping collection and ordinary request scopes retain separate read caches',async()=>{
  let reads=0,release;const gate=new Promise(r=>{release=r;});
  const read=async()=>{reads++;await gate;return sportyRequest().anonymous?'public':'account';};
  const a=withPublicSportyRequest(()=>memoSportyRead('same',read));
  const b=withFreshSportyRequest(()=>memoSportyRead('same',read));release();
  assert.deepEqual(await Promise.all([a,b]),['public','account']);assert.equal(reads,2);
});
test('the catalogue retains all returned market types across six sports but only models supported selections',async()=>{
  const c=client({async fetchEventDetail(id){const sport=SPORTS.find(s=>id.includes('-'+s+'-')),e=event(sport);
    e.markets.push(market('unsupported-'+sport,'Unmodelled special market',[outcome('special','Special selection',2)]));return {data:e};}});
  const catalog=await collect(c);assert.deepEqual(Object.keys(catalog.sports),SPORTS);assert.equal(catalog.loginRequired,false);
  for(const data of Object.values(catalog.sports)){assert.equal(data.fixtures.length,1);assert.ok(data.rows.some(r=>r.marketDesc==='Unmodelled special market'));assert.equal(data.coverage.complete,true);}
  const candidates=await publicCandidates(catalog);
  for(const label of Object.values(sporty.SPORT_LABELS))assert.ok(candidates.some(c=>c.sport===label),'missing '+label);
  assert.ok(candidates.every(c=>c.probability>0&&c.probability<=100&&c.eventId&&c.marketId&&c.outcomeId));
  assert.ok(candidates.every(c=>!c.marketId.startsWith('unsupported')));
});
test('public corners and team-goal markets retain complete probability pairs without statistics',async()=>{
  const catalog=await collect(client({async fetchEventDetail(id){const sport=SPORTS.find(s=>id.includes('-'+s+'-')),e=event(sport);
    if(sport==='football')e.markets.push(
      market('166','Total Corners Over/Under',[outcome('12','Over 8.5',1.2),outcome('13','Under 8.5',5)],{specifier:'total=8.5'}),
      market('19','Home Total Goals - Over/Under',[outcome('12','Over 0.5',1.2),outcome('13','Under 0.5',5)],{specifier:'total=0.5'}));
    return {data:e};}}));
  const candidates=await publicCandidates(catalog);
  for(const type of ['corners_over','corners_under','home_over05'])assert.ok(candidates.some(c=>c.betType===type),'missing '+type);
  const home=candidates.find(c=>c.betType==='home_over05');assert.equal(home.probability,Number((100*(1/1.2)/(1/1.2+1/5)).toFixed(1)));
});
test('a blocked public source aborts collection without substituting an account read',async()=>{
  let reads=0;const c=client({async fetchPrematchPage(){reads++;assert.equal(sportyRequest().anonymous,true);throw Object.assign(new Error('Forbidden public feed'),{status:403});}});
  await assert.rejects(collect(c),/Forbidden public feed/);assert.equal(reads,1);
});
test('full event reads replace suspended or removed embedded markets',async()=>{
  const catalog=await collect(client({async fetchEventDetail(id){const sport=SPORTS.find(s=>id.includes('-'+s+'-')),e=event(sport);e.markets[0].status=3;return {data:e};}}));
  assert.ok(Object.values(catalog.sports).every(data=>data.rows.length===0));
});
test('discovery paginates to totalNum and excludes started/live fixtures',async()=>{
  const pages=[];
  const c=client({async fetchPrematchPage(id,page){const sport=SPORTS.find(s=>sporty.SPORT_IDS[s]===id);pages.push([sport,page]);
    if(sport!=='football')return envelope([]);
    const events=Array.from({length:page===1?100:3},(_,i)=>event(sport,page*100+i));
    if(page===2){events[1].status=1;events[1].matchStatus='H2';events[2].estimateStartTime=clock.getTime()-1000;}
    return {data:{totalNum:103,tournaments:[{events}]}};
  },async fetchEventDetail(id){const i=Number(id.split('-').at(-1));return {data:event('football',i)};}});
  const catalog=await collect(c);assert.deepEqual(pages.filter(p=>p[0]==='football').map(p=>p[1]),[1,2]);
  assert.equal(catalog.sports.football.fixtures.length,101);assert.equal(catalog.sports.football.coverage.paginationComplete,true);
});
test('public collection reports a pagination cap and carries previous sports only on partial failures',async()=>{
  const previous=await collect(client());
  const c=client({async fetchPrematchPage(id){const sport=SPORTS.find(s=>sporty.SPORT_IDS[s]===id);
    if(sport==='hockey')throw new Error('temporary public read failure');
    return {data:{totalNum:200,events:Array.from({length:100},(_,i)=>event(sport,i))}};}});
  const result=await collectPublicCatalog({client:c,previous,now:()=>clock,env:{SPORTYBET_PUBLIC_MAX_PAGES:'1'},pause:async()=>{}});
  assert.equal(result.sports.football.coverage.complete,false);assert.equal(result.sports.hockey.carriedForward,true);
  await assert.rejects(collectPublicCatalog({client:client({async fetchPrematchPage(){throw new Error('offline');}}),previous,now:()=>clock}),/previous cache retained/);
});
test('an explicit upstream total takes priority when pages are smaller than requested',async()=>{
  const pages=[];const c=client({async fetchPrematchPage(id,page){const sport=SPORTS.find(s=>sporty.SPORT_IDS[s]===id);
    if(sport!=='football')return envelope([]);pages.push(page);const events=[event(sport,(page-1)*2),event(sport,(page-1)*2+1)];
    return {data:{totalNum:6,events}};
  },async fetchEventDetail(id){return {data:event('football',Number(id.split('-').at(-1)))};}});
  const catalog=await collect(c);assert.deepEqual(pages,[1,2,3]);assert.equal(catalog.sports.football.fixtures.length,6);assert.equal(catalog.sports.football.coverage.complete,true);
});
test('disk and Redis cache survive restart; blocked refreshes preserve the previous snapshot',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-catalog-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'catalog.json'),redis=fakeRedis(),catalog=await collect(client());
  const cache=createPublicCache({getRedis:async()=>redis,file,now:()=>clock,collect:async()=>catalog});
  await cache.refresh();assert.equal(JSON.parse(await redis.get(CACHE_KEY)).loginRequired,false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(directory,'predictions.json'),'utf8')).matches.length,1);
  const restarted=createPublicCache({getRedis:async()=>redis,file});assert.equal((await restarted.read()).generatedAt,catalog.generatedAt);
  const diskOnly=createPublicCache({file});assert.equal((await diskOnly.read()).sports.football.rows.length,3);
  const blocked=createPublicCache({getRedis:async()=>redis,file,collect:async()=>{throw Object.assign(new Error('Access blocked'),{status:403});}});
  await assert.rejects(blocked.refresh(),/Access blocked/);assert.equal((await cache.read()).generatedAt,catalog.generatedAt);
});
test('fresh public validation updates prices/probabilities and rejects a now-live selection',async()=>{
  const catalog=await collect(client()),original=(await publicCandidates(catalog)).find(c=>c.betType==='home_win');
  const fresh=event('football');fresh.markets[0].outcomes[0].odds='2.5';
  const c=client({async fetchEventDetail(){return {data:fresh};}});
  const valid=await validatePublicSelections([original],{client:c,now:()=>clock});assert.equal(valid.length,1);assert.equal(valid[0].odds,2.5);assert.ok(valid[0].probability<original.probability);
  fresh.status=1;fresh.matchStatus='H1';assert.deepEqual(await validatePublicSelections([original],{client:c,now:()=>clock}),[]);
});
test('a damaged cache can be rebuilt instead of breaking every later refresh',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'damaged-public-catalog-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'catalog.json'),redis=fakeRedis(),catalog=await collect(client());
  fs.writeFileSync(file,'invalid local JSON');await redis.set(CACHE_KEY,'invalid Redis JSON');
  const cache=createPublicCache({getRedis:async()=>redis,file,collect:async()=>catalog,logger:{warn(){}}});
  assert.equal(await cache.read(),null);await cache.refresh();assert.equal((await cache.read()).schemaVersion,1);
});
test('an active cache lease renews, a stopped worker expires within 15 minutes, and a stale worker cannot overwrite the new snapshot',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'public-lease-test-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'catalog.json'),redis=fakeRedis(),expires=new Map();let seconds=0;
  const get=redis.get.bind(redis),set=redis.set.bind(redis);
  redis.get=async key=>{if(expires.has(key)&&expires.get(key)<=seconds){redis.data.delete(key);expires.delete(key);}return get(key);};
  redis.set=async(key,value,options={})=>{await redis.get(key);const result=await set(key,value,options);if(result==='OK'&&options.EX)expires.set(key,seconds+options.EX);return result;};
  redis.eval=async(script,{keys,arguments:args})=>{
    if(await redis.get(keys[0])!==args[0])return 0;
    if(script.includes('"EXPIRE"')){expires.set(keys[0],seconds+900);return 1;}
    redis.data.delete(keys[0]);expires.delete(keys[0]);return 1;
  };
  let heartbeat;const timers={setInterval(fn){heartbeat=fn;return {unref(){}};},clearInterval(){}};
  const previous=await collect(client()),fresh={...previous,generatedAt:'2026-10-07T06:00:00.000Z'};
  await redis.set(CACHE_KEY,JSON.stringify(previous));
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),waiting=new Promise(resolve=>{release=resolve;});
  const old=createPublicCache({getRedis:async()=>redis,file,timers,collect:async()=>{entered();await waiting;return previous;}});
  const oldRun=old.refresh();await started;
  seconds=400;heartbeat();await new Promise(setImmediate);
  const replacement=createPublicCache({getRedis:async()=>redis,file,timers,collect:async()=>fresh});
  seconds=1299;assert.equal((await replacement.refresh()).reason,'public_refresh_in_progress');
  assert.equal(replacement.status().lastRun.status,'waiting');
  seconds=1300;assert.equal((await replacement.refresh()).catalog.generatedAt,fresh.generatedAt);
  const rejected=assert.rejects(oldRun,/lease was lost/);release();await rejected;
  assert.equal(JSON.parse(await redis.get(CACHE_KEY)).generatedAt,fresh.generatedAt);
});
