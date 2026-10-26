'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {launchOptions,sourceFailure,widgetLoader}=require('../lib/h2hWorkerBrowser');
const loader='widgets.sir.sportradar.com/client/widgetloader';
test('worker uses full Chromium with normal headed mode only when a display is configured',()=>{
 assert.deepEqual(launchOptions({H2H_BROWSER_HEADED:'true'}),{channel:'chromium',headless:false});
 assert.deepEqual(launchOptions({}),{channel:'chromium',headless:true});
 assert.equal(launchOptions({}).args,undefined);
});
test('the supplied failure identifies the actual ORB-blocked loader, not advertising failures',()=>{
 const actual={type:'request_failed',endpoint:loader,error:'net::ERR_BLOCKED_BY_ORB'};
 assert.equal(sourceFailure([actual]).h2hReason,'h2h_widget_loader_blocked');
 assert.equal(sourceFailure([{...actual,endpoint:'analytics.google.com/g/collect'}]),null);
 assert.equal(sourceFailure([actual,{type:'widget_response',endpoint:loader,status:200}]),null);
 assert.equal(widgetLoader('https://widgets.sir.sportradar.com.evil.invalid/client/widgetloader'),false);
});
test('successful loader responses preserve MIME diagnostics without recording credentials or queries',()=>{
 const handlers={},events=require('../lib/h2hDebug').watch({on:(n,fn)=>handlers[n]=fn});
 handlers.response({url:()=>`https://${loader}?secret=hidden`,status:()=>200,headers:()=>({'content-type':'text/html','set-cookie':'private'})});
 assert.deepEqual(events,[{type:'widget_response',endpoint:loader,status:200,contentType:'text/html'}]);
 assert.ok(!JSON.stringify(events).includes('hidden'));
 assert.ok(!JSON.stringify(events).includes('private'));
});
test('a loader failure remains captured after unrelated network noise fills the bounded buffer',()=>{
 const handlers={},events=require('../lib/h2hDebug').watch({on:(n,fn)=>handlers[n]=fn});
 const request=url=>({url:()=>url,resourceType:()=> 'script',failure:()=>({errorText:'net::ERR_BLOCKED_BY_ORB'})});
 for(let i=0;i<40;i++)handlers.requestfailed(request('https://analytics.google.com/'+i));
 handlers.requestfailed(request('https://'+loader));
 assert.equal(events.length,30);assert.ok(sourceFailure(events));
});
