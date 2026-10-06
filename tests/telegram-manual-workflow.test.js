'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const vm=require('node:vm');

function workflow(name) {
  const text=fs.readFileSync(path.join(__dirname,'../.github/workflows',name),'utf8');
  return {text,steps:text.split(/^      - name: /m).slice(1).map(block=>{
    const script=block.match(/\n        run: \|\n([\s\S]*)/)?.[1];
    assert.ok(script,'workflow step must have an executable run block');
    return {condition:block.match(/\n        if: \$\{\{\s*(.*?)\s*\}\}/)?.[1],
      script:script.split('\n').map(line=>line.startsWith('          ')?line.slice(10):line).join('\n')};
  })};
}
async function harness(t,failSafe=false) {
  const calls=[];
  const server=http.createServer((req,res)=>{
    assert.equal(req.method,'POST');assert.equal(req.headers['x-telegram-job-secret'],'test-workflow-secret');
    calls.push({path:req.url,mode:req.headers['x-matchday-run-mode'],id:req.headers['x-matchday-run-id']});
    req.resume();res.setHeader('Content-Type','application/json');res.setHeader('Connection','close');
    if(failSafe&&req.url.endsWith('/daily-picks')){res.statusCode=502;res.end(JSON.stringify({error:'Mock SAFE source failure'}));}
    else res.end(JSON.stringify({ok:true,sent:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const execute=(script,event)=>new Promise((resolve,reject)=>{
    const child=spawn('bash',['-e','-c',script],{env:{...process.env,
      TELEGRAM_JOB_SECRET:'test-workflow-secret',MATCHDAY_BASE_URL:`http://127.0.0.1:${server.address().port}`,
      GH_EVENT_NAME:event,GITHUB_RUN_ID:'12345',GITHUB_RUN_ATTEMPT:'2'}});
    let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
    child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
  });
  return {calls,execute};
}
async function dispatch(steps,h,event,{cancelled=false}={}) {
  let failed=false;const executed=[];
  for(const step of steps) {
    const selected=vm.runInNewContext(step.condition||'success()',{
      github:{event_name:event},success:()=>!failed,cancelled:()=>cancelled,
    });
    if(!selected)continue;
    const result=await h.execute(step.script,event);executed.push(result);failed ||= result.code!==0;
  }
  return executed;
}

test('manual daily workflow calls SAFE and the hourly live endpoint even when SAFE fails',async t=>{
  const {steps,text}=workflow('telegram-picks.yml'),h=await harness(t,true);
  assert.match(steps[1].condition,/workflow_dispatch/);assert.match(steps[1].condition,/!cancelled\(\)/);
  assert.match(text,/timeout-minutes: 35/);
  const results=await dispatch(steps,h,'workflow_dispatch');
  assert.equal(results.length,2);assert.notEqual(results[0].code,0);assert.equal(results[1].code,0,results[1].stderr);
  assert.deepEqual(h.calls,[{path:'/api/telegram/daily-picks',mode:'manual',id:undefined},
    {path:'/api/telegram/quick-cash',mode:'manual',id:'12345-2'}]);
});

test('daily cron calls only SAFE; cancelling skips the manual live step',async t=>{
  const {steps}=workflow('telegram-picks.yml'),h=await harness(t);
  const results=await dispatch(steps,h,'schedule');assert.equal(results.length,1);assert.equal(results[0].code,0);
  assert.deepEqual(h.calls,[{path:'/api/telegram/daily-picks',mode:'scheduled',id:undefined}]);
  assert.equal(vm.runInNewContext(steps[1].condition,{github:{event_name:'workflow_dispatch'},cancelled:()=>true}),false);
});

test('hourly workflow is manual-only and requests a fresh protected batch',async t=>{
  const {steps,text}=workflow('telegram-quick-cash.yml'),h=await harness(t);
  assert.doesNotMatch(text,/\bschedule:|\bcron:/);
  const results=await dispatch(steps,h,'workflow_dispatch');
  assert.equal(results.length,1);assert.equal(results[0].code,0,results[0].stderr);
  assert.deepEqual(h.calls,[{path:'/api/telegram/quick-cash',mode:'manual',id:'12345-2'}]);
});
