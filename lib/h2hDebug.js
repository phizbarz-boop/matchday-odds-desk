'use strict';
const fs=require('node:fs'),path=require('node:path');
function endpoint(url){try{const u=new URL(url);return u.protocol==='https:'||u.protocol==='http:'?u.hostname+u.pathname:'non-http';}catch{return 'invalid-url';}}
function watch(page){const events=[];const isLoader=require('./h2hWorkerBrowser').widgetLoader;const add=e=>{if(events.length>=30){if(!isLoader('https://'+e.endpoint))return;events.shift();}events.push(e);};page.on('requestfailed',r=>add({type:'request_failed',endpoint:endpoint(r.url()),resource:r.resourceType(),error:String(r.failure()?.errorText||'failed').slice(0,100)}));page.on('response',r=>{const loader=isLoader(r.url());if(r.status()>=400||loader)add({type:loader?'widget_response':'http_error',endpoint:endpoint(r.url()),status:r.status(),...(loader?{contentType:String(r.headers()['content-type']||'').slice(0,100)}:{})});});return events;}
let saved=0;
async function capture(page,{eventId,stage,error,events=[],directory=process.env.H2H_DEBUG_DIR,limit=3}={}){
 if(!directory||saved>=limit||!/^sr:match:\d+$/.test(String(eventId)))return false;saved++;
 const basename=String(eventId).replace(/:/g,'-'),folder=path.resolve(directory);fs.mkdirSync(folder,{recursive:true});
 let text='';try{text=(await page.locator('body').innerText({timeout:1000})).slice(0,16000);}catch{}
 const report={eventId,stage,reason:error.h2hReason||'h2h_read_failed',diagnostics:error.h2hDiagnostics||{},views:error.h2hPanelDebug||{},identity:error.h2hIdentityDebug||{},endpoint:endpoint(page.url()),text,network:events};
 fs.writeFileSync(path.join(folder,basename+'.json'),JSON.stringify(report,null,2));
 try{await page.screenshot({path:path.join(folder,basename+'.png'),fullPage:false,timeout:3000});}catch{}
 return true;
}
module.exports={endpoint,watch,capture};
