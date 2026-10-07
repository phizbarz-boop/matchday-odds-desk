'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const {sportyRequest,withFreshSportyRequest,memoSportyRead}=require('../lib/sportyRequest');
const {direct,getFootballMarket}=require('../lib/sportybet');
const {enrichSportyFixtures}=require('../lib/sportyFootballModel');
const {market,outcome}=require('./fixtures/sportybet-live-format');
const response=data=>({ok:true,status:200,headers:{get:k=>k==='content-type'?'application/json':null,getSetCookie:()=>[]},text:async()=>JSON.stringify(data)});

test('current discovery follows totalNum and also paginates when the total is omitted',async()=>{
  for(const explicitTotal of [true,false]){
    const pages=[];
    direct.setFetchForTesting(async url=>{
      const page=Number(new URL(url).searchParams.get('pageNum'));pages.push(page);
      const events=Array.from({length:page===1?100:1},(_,i)=>({eventId:`sr:match:page-${page}-${i}`,homeTeamName:'Home '+page+' '+i,awayTeamName:'Away '+page+' '+i,
        estimateStartTime:Date.now()+3600000,markets:[market('1','1X2',[outcome('1','Home',1.2),outcome('2','Draw',7),outcome('3','Away',13)])]}));
      return response({data:{...(explicitTotal?{totalNum:101}:{}),tournaments:[{name:'Current League',events}]}});
    });
    try{
      const p=await withFreshSportyRequest(()=>getFootballMarket('1x2',{maxPages:2}));
      assert.deepEqual(pages,[1,2]);assert.equal(new Set(p.rows.map(r=>r.eventId)).size,101);
    }finally{direct.setFetchForTesting(null);}
  }
});

test('an unrequested default Asian handicap line does not hide offered zero lines',async()=>{
  let details=0;
  const e={eventId:'sr:match:current-ah',homeTeamName:'Home AH',awayTeamName:'Away AH',estimateStartTime:Date.now()+3600000};
  direct.setFetchForTesting(async url=>{
    const detail=new URL(url).searchParams.has('eventId');if(detail)details++;
    const event={...e,markets:[market('16','Asian Handicap '+(detail?'0':'-2.5'),[outcome('4','Home',2),outcome('5','Away',1.8)],{specifier:detail?'hcp=0':'hcp=-2.5'})]};
    return response({data:detail?event:{totalNum:1,tournaments:[{name:'Current League',events:[event]}]}});
  });
  try{
    const p=await withFreshSportyRequest(()=>getFootballMarket('ah',{maxPages:1}));
    assert.equal(details,1);assert.equal(p.rows.length,2);assert.ok(p.rows.every(r=>r.specifier==='hcp=0'));
  }finally{direct.setFetchForTesting(null);}
});

test('optional statistics failure does not block current market probability estimates',async()=>{
  const oldRedis=process.env.REDIS_URL,oldTimeout=process.env.SPORTYBET_STATS_READ_TIMEOUT_MS;
  process.env.REDIS_URL='redis://127.0.0.1:1';process.env.SPORTYBET_STATS_READ_TIMEOUT_MS='250';
  try{
    const rows=[['1','Home',1.1],['2','Draw',9],['3','Away',26]].map(([id,desc,odds])=>({sport:'Football',eventId:'sr:match:stats-offline',home:'Home Stats',away:'Away Stats',marketId:'1',marketDesc:'1X2',outcomeId:id,outcomeDesc:desc,odds}));
    const p=await withFreshSportyRequest(()=>enrichSportyFixtures(rows,{marketRows:rows}));
    assert.equal(p.length,1);assert.equal(p[0].goalModelAvailable,false);
    assert.ok(p[0].h>80&&p[0].h<100);assert.match(p[0].dataSource,/no-vig/);
  }finally{
    if(oldRedis==null)delete process.env.REDIS_URL;else process.env.REDIS_URL=oldRedis;
    if(oldTimeout==null)delete process.env.SPORTYBET_STATS_READ_TIMEOUT_MS;else process.env.SPORTYBET_STATS_READ_TIMEOUT_MS=oldTimeout;
  }
});

test('current-source requests reuse only their own completed reads',async()=>{
  let reads=0;
  const source=()=>Promise.resolve(++reads);
  const first=await withFreshSportyRequest(async()=>{
    assert.ok(sportyRequest());
    return [await memoSportyRead('test-request',source),await memoSportyRead('test-request',source)];
  });
  assert.deepEqual(first,[1,1]);assert.equal(sportyRequest(),null);
  assert.equal(await withFreshSportyRequest(()=>memoSportyRead('test-request',source)),2);
});

test('overlapping users share an unfinished read and retry after an upstream failure',async()=>{
  let resolve,reads=0;
  const source=()=>{reads++;return new Promise(r=>{resolve=r;});};
  const a=withFreshSportyRequest(()=>memoSportyRead('test-overlap',source));
  const b=withFreshSportyRequest(()=>memoSportyRead('test-overlap',source));
  await new Promise(r=>setImmediate(r));assert.equal(reads,1);resolve('current');
  assert.deepEqual(await Promise.all([a,b]),['current','current']);
  await assert.rejects(withFreshSportyRequest(()=>memoSportyRead('test-failure',()=>Promise.reject(new Error('offline')))),/offline/);
  assert.equal(await withFreshSportyRequest(()=>memoSportyRead('test-failure',()=>Promise.resolve('recovered'))),'recovered');
});

test('website requests follow current SportyBet data independently of Daily Prediction Refresh',async t=>{
  const scratch=mkdtempSync(path.join(tmpdir(),'sporty-current-api-'));
  const child=fork(path.join(__dirname,'fixtures/on-demand-api-server.js'),[],{cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'',SPORTYBET_PHONE:'2348000000000',SPORTYBET_PASSWORD:'unavailable-fixture-password',SPORTYBET_PROXY_URL:'',
      SPORTYBET_BOOTSTRAP_COOKIES:'accessToken=unused-private-cookie',SPORTYBET_SESSION_FILE:path.join(scratch,'session.json'),SPORTYBET_MAX_PAGES:'1',SPORTYBET_LIVE_MAX_PAGES:'1'}});
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();rmSync(scratch,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server start timed out: '+logs)),10000);
    child.once('message',m=>{clearTimeout(timer);resolve(m.port);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs));});
  });
  let id=0;
  const configure=change=>new Promise(resolve=>{
    const key=++id,listener=m=>{if(m.id===key){child.off('message',listener);resolve(m.state);}};
    child.on('message',listener);child.send({id:key,type:'state',change});
  });
  const request=async(route,body)=>{
    const r=await fetch(`http://127.0.0.1:${port}${route}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
    return {status:r.status,headers:r.headers,body:await r.json()};
  };
  const pick=body=>request('/api/sportybet/auto-pick',{sports:['football'],liveMode:'prematch',targetOdds:1.05,maxSelections:1,minProbability:70,minEdge:0,leagues:null,betTypes:['home_win'],...body});

  await t.test('prematch auto request ignores a valid old daily prediction and market snapshot',async()=>{
    const picked=await pick();assert.equal(picked.status,200,JSON.stringify(picked.body));
    assert.equal(picked.headers.get('cache-control'),'no-store');
    assert.equal(picked.body.selections[0].eventId,'sr:match:on-demand-football-1');
    assert.equal(picked.body.selections[0].odds,1.10);
    assert.equal(picked.body.dataSource,'SportyBet direct');assert.ok(picked.body.dataFetchedAt);
  });
  await t.test('a second user immediately sees changed odds and newly added fixtures',async()=>{
    await configure({version:2,homeOdds:1.25});
    const picked=await pick();assert.equal(picked.status,200,JSON.stringify(picked.body));
    assert.equal(picked.body.selections[0].eventId,'sr:match:on-demand-football-2');
    assert.equal(picked.body.selections[0].odds,1.25);
  });
  await t.test('all six sports discover current prematch games without collector snapshots',async()=>{
    for(const sport of ['football','basketball','hockey','handball','volleyball','tennis']){
      const picked=await pick({sports:[sport],betTypes:[sport==='football'?'home_win':sport+'_winner']});
      assert.equal(picked.status,200,sport+': '+JSON.stringify(picked.body));
      assert.equal(picked.body.selections[0].eventId,`sr:match:on-demand-${sport}-2`);
    }
    const sets=await pick({sports:['volleyball'],betTypes:['volleyball_sets_over']});
    assert.equal(sets.status,200,JSON.stringify(sets.body));assert.equal(sets.body.selections[0].marketId,'900450');
    for(const sport of ['tennis','volleyball']){
      const totals=await pick({sports:[sport],betTypes:[sport+'_over']});
      assert.equal(totals.status,200,JSON.stringify(totals.body));
      assert.equal(totals.body.selections[0].marketId,sport==='tennis'?'189':'238');
    }
  });
  await t.test('team-goal details are refreshed after the earlier request completes',async()=>{
    const first=await pick({betTypes:['home_over05']});assert.equal(first.status,200,JSON.stringify(first.body));
    await configure({version:3});
    const second=await pick({betTypes:['home_over05']});assert.equal(second.status,200,JSON.stringify(second.body));
    assert.equal(second.body.selections[0].eventId,'sr:match:on-demand-football-3');
  });
  await t.test('booking-code analysis stops qualifying a newly suspended market',async()=>{
    const body={bookingCode:'TESTCODE',minProbability:70,horizonDays:14};
    const first=await request('/api/sportybet/analyze-code',body);
    assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(first.body.supportedCount,1);
    await configure({suspendTotals:true});
    const second=await request('/api/sportybet/analyze-code',body);
    assert.equal(second.status,200,JSON.stringify(second.body));assert.equal(second.body.supportedCount,0);
    assert.equal(second.body.qualifiedCount,0);await configure({suspendTotals:false});
  });
  await t.test('imported codes read their exact events even outside the first list page',async()=>{
    await configure({listEmpty:true});
    const analysis=await request('/api/sportybet/analyze-code',{bookingCode:'TESTCODE',minProbability:70,horizonDays:21});
    assert.equal(analysis.status,200,JSON.stringify(analysis.body));assert.equal(analysis.body.supportedCount,1);
    assert.equal(analysis.body.qualifiedSelections[0].eventId,'sr:match:on-demand-football-3');
    await configure({listEmpty:false});
  });
  await t.test('removed fixtures cannot be recovered from an older snapshot',async()=>{
    await configure({empty:true});
    const picked=await pick();assert.equal(picked.status,404,JSON.stringify(picked.body));
    assert.equal(picked.body.candidateCount,0);await configure({empty:false});
  });
  await t.test('current dashboard is separate from persisted daily job verification',async()=>{
    const current=await request('/api/predictions?source=current');
    assert.equal(current.status,200);assert.equal(current.body.readMode,'direct');
    assert.equal(current.body.matches[0].eventId,'sr:match:on-demand-football-3');
    const daily=await request('/api/predictions');assert.equal(daily.status,200);
    assert.equal(daily.body.generatedAt,'2026-01-01T00:00:00.000Z');assert.equal(daily.body.matches[0].eventId,'sr:match:old-only');
  });
  await t.test('direct odds endpoints refresh instead of allowing browser price caches',async()=>{
    const first=await request('/api/sportybet/sport/tennis?market=winner');
    assert.equal(first.status,200);assert.equal(first.headers.get('cache-control'),'no-store');
    await configure({version:4});
    const second=await request('/api/sportybet/sport/tennis?market=winner');
    assert.equal(second.body.rows[0].eventId,'sr:match:on-demand-tennis-4');
  });
  await t.test('upstream failure is reported instead of returning the earlier snapshot',async()=>{
    await configure({fail:true});
    const picked=await pick();assert.equal(picked.status,404,JSON.stringify(picked.body));
    assert.equal(picked.body.candidateCount,0);
    assert.match(picked.body.sourceErrors['football 1X2'],/source unavailable/);
    assert.match(picked.body.hint,/reads failed/);
  });
  await t.test('all user reads leave dummy credentials unloaded and background login stopped',async()=>{
    await configure({fail:false});
    const live=await request('/api/sportybet/live/odds?sport=basketball&market=all');assert.equal(live.status,200);
    const diagnostics=await request('/api/sportybet/diagnostics');assert.equal(diagnostics.body.publicDataProbe.ok,true);
    assert.equal(diagnostics.body.session.keepAliveRunning,false);assert.equal(diagnostics.body.session.loginCount,0);
    assert.equal((await configure()).sessionLoaded,false);
  });
});
