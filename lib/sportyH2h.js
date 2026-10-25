'use strict';
const fs=require('node:fs'),path=require('node:path');
const {combine,assess}=require('./h2hEvidence');
const {failure}=require('./h2hFailure');
const FILE=process.env.SPORTYBET_H2H_FILE||path.join(__dirname,'..','data','sporty-h2h.json');
let browserPromise;const cache=new Map(),pending=new Map();let loaded=false;
function urlFor(c){
 const sport=/hockey/i.test(c.sport)?'iceHockey':String(c.sport||'football').toLowerCase();
 if(!['football','basketball','tennis','handball','iceHockey','volleyball'].includes(sport)||!/^sr:match:\d+$/.test(String(c.eventId)))throw Error('Unsupported H2H fixture');
 const slug=v=>encodeURIComponent(String(v||'Match').replace(/\s+/g,'_'));
 return `https://www.sportybet.com/ng/m/sport/${sport}/${slug(c.category||c.country||'International')}/${slug(c.tournament||'Match')}/${slug(c.home)}_vs_${slug(c.away)}/${c.eventId}`;
}
async function panelText(page,pattern,{timeoutMs=12000,signal}={}){
 const deadline=Date.now()+timeoutMs;
 do{for(const frame of page.frames()){
  if(signal?.aborted)throw Object.assign(Error('H2H collection cancelled'),{h2hReason:'collection_cancelled'});
  try{if(frame!==page.mainFrame()&&!await (await frame.frameElement()).isVisible())continue;const text=await frame.locator('body').innerText({timeout:500});if(pattern.test(text))return text;}catch{}
 }if(Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,200));}while(Date.now()<deadline);
 throw Object.assign(Error('H2H panel content unavailable'),{h2hReason:'h2h_panels_unavailable'});
}
async function collect(c,{signal}={}){
 let stage='browser_launch';
 try{
 if(!browserPromise){require('./sportyBrowserRuntime').configureBrowserPath();browserPromise=require('playwright').chromium.launch({headless:true}).catch(e=>{browserPromise=null;throw e;});}
 const browser=await browserPromise,context=await browser.newContext({locale:'en-NG'}),page=await context.newPage();
 const abort=()=>{void context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{
  stage='page_load';const response=await page.goto(urlFor(c),{waitUntil:'domcontentloaded',timeout:20000});
  if(response&&response.status()>=400)throw Object.assign(Error('H2H page HTTP error'),{h2hReason:'page_http_error'});
  stage='stats_tab';
  await page.getByText('Stats',{exact:true}).first().click({timeout:12000});
  stage='h2h_panels';let oldText='',newText='';for(const [label,which] of [['H2H','old'],['H2H(New)','new']]){
   try{await page.getByText(label,{exact:true}).click({timeout:8000});
   const text=await panelText(page,which==='new'?/Head to Head Team Averages|Season Statistics|Surface Win Rate/i:/Previous meetings|Last 5 Matches/i,{signal});if(which==='old')oldText=text;else newText=text;}catch{if(signal?.aborted)throw Error('H2H collection cancelled');}
  }
  if(!oldText&&!newText)throw Object.assign(Error('No readable H2H panel'),{h2hReason:'h2h_panels_unavailable'});
  stage='team_identity';
  // The route's slug is descriptive; verify the actual displayed match identity.
  const identityText=(await page.locator('body').innerText())+'\n'+oldText+'\n'+newText;
  for(const team of [c.home,c.away])if(!identityText.toLowerCase().includes(String(team).toLowerCase()))throw Object.assign(Error('H2H team identity could not be verified'),{h2hReason:'team_identity_unverified'});
  return combine(oldText,newText,c);
 }finally{signal?.removeEventListener('abort',abort);await context.close().catch(()=>{});}
 }catch(error){const detail=failure(error,stage);throw Object.assign(error,{h2hReason:detail.reason,h2hStage:detail.stage});}
}
async function read(c,options){
 if(!loaded){loaded=true;try{for(const e of JSON.parse(fs.readFileSync(FILE,'utf8')).events||[])cache.set(e.eventId,e);}catch{}}
 const old=cache.get(String(c.eventId));if(old&&Date.now()-Date.parse(old.capturedAt)<900000)return old;
 if(!pending.has(String(c.eventId)))pending.set(String(c.eventId),collect(c,options).then(e=>{cache.set(e.eventId,e);fs.mkdirSync(path.dirname(FILE),{recursive:true});const temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({events:[...cache.values()].filter(x=>Date.now()-Date.parse(x.capturedAt)<900000)}));fs.renameSync(temp,FILE);return e;}).finally(()=>pending.delete(String(c.eventId))));
 return pending.get(String(c.eventId));
}
async function checkCandidates(rows,{signal,maxFixtures=Number(process.env.SPORTYBET_H2H_MAX_FIXTURES)||40,budgetMs=90000,collectEvidence=read,now=()=>new Date(),logger=console}={}){
 if(process.env.SPORTYBET_H2H_ENABLED==='false')return rows;
 const deadline=Date.now()+budgetMs,groups=new Map(),unique=new Map();
 for(const c of [...rows].sort((a,b)=>Number(b.probability)-Number(a.probability)))if(!unique.has(String(c.eventId)))unique.set(String(c.eventId),c);
 for(const c of unique.values()){const sport=require('./telegramMixedSelector').normalizedSport(c)||'unknown';if(!groups.has(sport))groups.set(sport,[]);groups.get(sport).push(c);}
 const fixtures=[];while(fixtures.length<maxFixtures&&[...groups.values()].some(a=>a.length))for(const group of groups.values())if(group.length&&fixtures.length<maxFixtures)fixtures.push(group.shift());
 const evidence=new Map(),failures=new Map();let index=0;
 await Promise.all([0,1].map(async()=>{while(index<fixtures.length&&Date.now()<deadline&&!signal?.aborted){const c=fixtures[index++];try{evidence.set(String(c.eventId),await collectEvidence(c,{signal}));}catch(error){const detail=failure(error);failures.set(String(c.eventId),detail);evidence.set(String(c.eventId),null);}}}));
 const result=rows.map(c=>{const attempted=evidence.has(String(c.eventId)),r=assess(c,evidence.get(String(c.eventId)),now());r.h2hCheck.attempted=attempted;const failed=failures.get(String(c.eventId));if(failed){r.h2hCheck.reason=failed.reason;r.h2hCheck.failureMessage=failed.message;r.h2hCheck.stage=failed.stage;}if(!attempted){r.h2hCheck.status='not_checked';r.h2hCheck.reason=signal?.aborted?'request_cancelled':'check_limit_or_time_budget';}return r;});
 for(const key of Object.keys(rows))if(!/^\d+$/.test(key))result[key]=rows[key];
 const failureCounts={};for(const f of failures.values())failureCounts[f.reason]=(failureCounts[f.reason]||0)+1;if(failures.size)logger.warn?.('[SportyBet H2H] '+JSON.stringify({attempted:evidence.size,failed:failures.size,reasons:failureCounts}));
 result.h2hCoverage={failures:failureCounts,fixturesRequested:new Set(rows.map(c=>c.eventId)).size,fixturesChecked:evidence.size,verified:result.filter(c=>c.h2hCheck.verified!==false).length,unverified:result.filter(c=>c.h2hCheck.verified===false).length,blocked:result.filter(c=>!c.h2hCheck.allowed).length};return result;
}
module.exports={checkCandidates,urlFor,collect,panelText};
