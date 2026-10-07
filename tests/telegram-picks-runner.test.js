'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path');
const {spawn}=require('node:child_process');
async function run(t,mode,{endpoint='daily-picks',event='workflow_dispatch'}={}) {
  const calls=[];let gets=0;
  const server=http.createServer((req,res)=>{
    req.resume();calls.push({method:req.method,url:req.url,prefer:req.headers.prefer,id:req.headers['x-matchday-run-id'],mode:req.headers['x-matchday-run-mode']});
    assert.equal(req.headers['x-telegram-job-secret'],'runner-private-secret');
    res.setHeader('Content-Type','application/json');res.setHeader('Connection','close');
    const reply=(code,body)=>{res.statusCode=code;res.end(JSON.stringify(body));};
    if(req.method==='POST') {
      if(mode==='lost-submission')return res.destroy();
      if(mode==='missing-config')return reply(503,{code:'TELEGRAM_CONFIG_MISSING',missingSettings:['TELEGRAM_CHAT_ID']});
      if(mode==='redirect'){res.statusCode=302;res.setHeader('Location','/must-not-receive-the-secret');return res.end();}
      if(mode==='not-queued'){res.statusCode=502;return res.end('Bad Gateway');}
      return reply(202,{runId:'gh987',runRequestStatus:'pending',stage:'queued'});
    }
    gets++;
    if(mode==='failed')return reply(502,{runId:'gh987',runRequestStatus:'failed',code:'SPORTYBET_SOURCE_UNAVAILABLE',detail:'SportyBet football feed returned 403'});
    if(mode==='unknown')return reply(409,{runId:'gh987',runRequestStatus:'unknown',code:'TELEGRAM_RUN_OUTCOME_UNKNOWN'});
    if(mode==='not-queued')return reply(404,{code:'TELEGRAM_RUN_NOT_FOUND'});
    if(mode==='transient-status'&&gets===1){res.statusCode=502;return res.end('Gateway temporarily unavailable');}
    if(gets<=2)return reply(202,{runId:'gh987',runRequestStatus:'pending',stage:'scanning_sportybet'});
    return reply(200,{ok:true,runId:'gh987',runRequestStatus:'completed',ticketsSent:mode==='empty'?0:1,
      reason:mode==='empty'?'no_eligible_safe_games':'tickets_sent',results:mode==='empty'?[]:[{shareCode:'FIXTURE-ONE'}]});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await new Promise((resolve,reject)=>{
    const child=spawn('python3',[path.join(__dirname,'../jobs/telegram-picks-runner.py'),'--endpoint',endpoint],{env:{...process.env,
      TELEGRAM_JOB_SECRET:'runner-private-secret',MATCHDAY_BASE_URL:`http://127.0.0.1:${server.address().port}`,MATCHDAY_RUN_ID:'gh987',GH_EVENT_NAME:event,
      TELEGRAM_REQUEST_TIMEOUT_SECONDS:'1',TELEGRAM_POLL_SECONDS:'0.01',TELEGRAM_POLL_MAX_SECONDS:'3'}});
    let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  assert.doesNotMatch(result.stdout+result.stderr,/runner-private-secret/);
  assert.equal(calls.filter(call=>call.method==='POST').length,1,'polling must never submit a second batch');
  return {calls,...result};
}

test('workflow waits for a slow batch through short status requests',async t=>{
  const result=await run(t,'pending');assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/scanning_sportybet/);assert.match(result.stdout,/FIXTURE-ONE/);
  assert.equal(result.calls[0].prefer,'respond-async');assert.equal(result.calls[0].id,'gh987');assert.equal(result.calls[0].mode,'manual');
});
test('a lost submission response is recovered by status without posting another batch',async t=>{
  const result=await run(t,'lost-submission');assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/no second POST/);
});
test('gateway errors during polling do not duplicate the job',async t=>{
  const result=await run(t,'transient-status');assert.equal(result.code,0);assert.match(result.stdout,/temporarily unavailable \(HTTP 502\)/);
});
test('source failure details appear in the workflow log',async t=>{
  const result=await run(t,'failed');assert.equal(result.code,22);assert.match(result.stdout,/SportyBet football feed returned 403/);
});
test('missing Render chat configuration is shown before polling',async t=>{
  const result=await run(t,'missing-config');assert.equal(result.code,22);assert.match(result.stdout,/TELEGRAM_CHAT_ID/);assert.equal(result.calls.length,1);
});
test('an empty SAFE slate is reported without a false server failure',async t=>{
  const result=await run(t,'empty',{event:'schedule'});assert.equal(result.code,0);assert.match(result.stdout,/No SAFE ticket qualified/);assert.equal(result.calls[0].mode,'scheduled');
});
test('next-12-hours manual workflow uses the same polling and one run ID',async t=>{
  const result=await run(t,'pending',{endpoint:'next-12h-picks'});assert.equal(result.code,0);assert.equal(result.calls[0].url,'/api/telegram/next-12h-picks');assert.equal(result.calls[0].mode,'manual');
});
test('unknown and missing jobs do not restart an unconfirmed send',async t=>{
  for(const mode of ['unknown','not-queued']){const result=await run(t,mode);assert.equal(result.code,22);assert.equal(result.calls.length,2);}
});
test('the workflow never forwards its job secret through a redirect',async t=>{
  const result=await run(t,'redirect');assert.equal(result.code,22);assert.equal(result.calls.length,1);
});
