'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const {mkdtempSync,rmSync,readFileSync}=require('node:fs');
const {tmpdir}=require('node:os');
const path=require('node:path');
const vm=require('node:vm');

test('Auto Analyser HTTP flow builds live and Quick Cash slips from the website feed',async t=>{
  const scratch=mkdtempSync(path.join(tmpdir(),'sporty-live-api-'));
  const child=fork(path.join(__dirname,'fixtures/live-api-server.js'),[],{
    cwd:path.join(__dirname,'..'),silent:true,
    env:{...process.env,PORT:'0',REDIS_URL:'',SPORTYBET_PHONE:'',SPORTYBET_PASSWORD:'',SPORTYBET_PROXY_URL:'',
      SPORTYBET_BOOTSTRAP_COOKIES:'',SPORTYBET_SESSION_FILE:path.join(scratch,'session.json'),SPORTYBET_LIVE_MAX_PAGES:'1'},
  });
  let logs='';child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
  t.after(()=>{child.kill();rmSync(scratch,{recursive:true,force:true});});
  const port=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server did not start: '+logs)),10000);
    child.once('message',m=>{clearTimeout(timer);resolve(m.port);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+logs));});
  });
  const post=async(route,body)=>{
    const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const pick=body=>post('/api/sportybet/auto-pick',{sports:['football'],liveMode:'live',targetOdds:1.05,maxSelections:1,
    minProbability:80,minEdge:0,leagues:null,betTypes:['home_win'],...body});

  await t.test('live-only selection passes the chosen probability and generates a share code',async()=>{
    const picked=await pick({});
    assert.equal(picked.status,200,JSON.stringify(picked.body));
    assert.ok(picked.body.selections.length>0);
    assert.ok(picked.body.selections.every(s=>s.live&&s.probability>=80&&s.marketId==='1'));
    const booked=await post('/api/sportybet/book',{selections:picked.body.selections});
    assert.equal(booked.status,200,JSON.stringify(booked.body));
    assert.equal(booked.body.shareCode,'TEST-LIVE-CODE');
  });
  await t.test('zero minimum probability is preserved through the website endpoint',async()=>{
    const picked=await pick({minProbability:0,betTypes:['draw'],targetOdds:2.5});
    assert.equal(picked.status,200,JSON.stringify(picked.body));assert.equal(picked.body.minProbability,0);
    assert.ok(picked.body.selections.every(s=>s.betType==='draw'&&s.probability<55));
  });
  await t.test('Quick Cash picks the late leader and accepts Q4/overtime winner markets',async()=>{
    const football=await pick({liveMode:'quick_cash'});
    assert.equal(football.status,200,JSON.stringify(football.body));
    assert.equal(football.body.selections[0].eventId,'sr:match:live-format-late');
    assert.equal(football.body.selections[0].quickCash,true);
    const basketball=await pick({sports:['basketball'],liveMode:'quick_cash',betTypes:['basketball_winner']});
    assert.equal(basketball.status,200,JSON.stringify(basketball.body));
    assert.equal(basketball.body.selections[0].eventId,'sr:match:live-format-q4');
    assert.equal(basketball.body.selections[0].marketId,'219');
  });
  await t.test('offered live corners work without a historical corner model',async()=>{
    const picked=await pick({betTypes:['corners_over'],minProbability:75,targetOdds:1.2});
    assert.equal(picked.status,200,JSON.stringify(picked.body));
    assert.equal(picked.body.selections[0].marketId,'166');
    assert.equal(picked.body.selections[0].specifier,'total=8.5');
  });
  await t.test('probability-filtered live board explains the actual cause with corner diagnostics',async()=>{
    const picked=await pick({betTypes:['home_win','corners_over'],minProbability:95});
    assert.equal(picked.status,404,JSON.stringify(picked.body));
    assert.ok(picked.body.liveDiagnostics.totalRows>0);
    assert.equal(picked.body.liveDiagnostics.feeds['football/1x2'].ongoingEvents,3);
    assert.equal(picked.body.cornerDiagnostics.historicalCornerModelRequired,false);
    assert.equal(picked.body.cornerDiagnostics.sportyCornerRows,2);
    assert.ok(picked.body.cornerDiagnostics.playableCornerSelections>0);
    assert.match(picked.body.hint,/probability/);
    assert.doesNotMatch(picked.body.hint,/matchesWithCornerModel must/);
  });
  await t.test('empty live board reports zero games separately from filtering',async()=>{
    const picked=await pick({sports:['handball'],betTypes:['handball_winner']});
    assert.equal(picked.status,404,JSON.stringify(picked.body));
    assert.equal(picked.body.liveDiagnostics.totalRows,0);
    assert.equal(picked.body.liveDiagnostics.feeds['handball/winner'].ongoingEvents,0);
    assert.match(picked.body.hint,/No playable live markets/);
  });
});

test('all league chips selected leaves the live analyser open to other SportyBet leagues',()=>{
  const html=readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const source=html.match(/function autoLeagueFilter\(\)\{[^\n]+\}/)?.[0];
  assert.ok(source);
  const context={LEAGUES:['League A','League B'],state:{leagues:new Set(['League A','League B'])}};
  vm.createContext(context);vm.runInContext(source,context);
  assert.equal(vm.runInContext('autoLeagueFilter()',context),null);
  context.state.leagues.delete('League B');
  assert.deepEqual(Array.from(vm.runInContext('autoLeagueFilter()',context)),['League A']);
});
