'use strict';
const fs=require('node:fs'),path=require('node:path');
const {combine,assess}=require('./h2hEvidence');
const FILE=process.env.SPORTYBET_H2H_FILE||path.join(__dirname,'..','data','sporty-h2h.json');
let browserPromise;const cache=new Map(),pending=new Map();let loaded=false;
function urlFor(c){
 const sport=/hockey/i.test(c.sport)?'iceHockey':String(c.sport||'football').toLowerCase();
 if(!['football','basketball','tennis','handball','iceHockey','volleyball'].includes(sport)||!/^sr:match:\d+$/.test(String(c.eventId)))throw Error('Unsupported H2H fixture');
 const slug=v=>encodeURIComponent(String(v||'Match').replace(/\s+/g,'_'));
 return `https://www.sportybet.com/ng/m/sport/${sport}/${slug(c.category||c.country||'International')}/${slug(c.tournament||'Match')}/${slug(c.home)}_vs_${slug(c.away)}/${c.eventId}`;
}
async function collect(c,{signal}={}){
 if(!browserPromise){require('./sportyBrowserRuntime').configureBrowserPath();browserPromise=require('playwright').chromium.launch({headless:true}).catch(e=>{browserPromise=null;throw e;});}
 const browser=await browserPromise,context=await browser.newContext({locale:'en-NG'}),page=await context.newPage();
 const abort=()=>{void context.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 try{
  await page.goto(urlFor(c),{waitUntil:'domcontentloaded',timeout:20000});
  await page.getByText('Stats',{exact:true}).first().click({timeout:12000});
  let oldText='',newText='';for(const [label,which] of [['H2H','old'],['H2H(New)','new']]){
   try{await page.getByText(label,{exact:true}).click({timeout:8000});
   await page.getByText(which==='new'?/Head to Head Team Averages|Season Statistics|Surface Win Rate/i:/Previous meetings|Last 5 Matches/i).first().waitFor({timeout:12000});
   const text=await page.locator('body').innerText();if(which==='old')oldText=text;else newText=text;}catch{if(signal?.aborted)throw Error('H2H collection cancelled');}
  }
  // The route's slug is descriptive; verify the actual displayed match identity.
  for(const team of [c.home,c.away])if(!(newText||oldText).toLowerCase().includes(String(team).toLowerCase()))throw Error('H2H team identity could not be verified');
  return combine(oldText,newText,c);
 }finally{signal?.removeEventListener('abort',abort);await context.close().catch(()=>{});}
}
async function read(c,options){
 if(!loaded){loaded=true;try{for(const e of JSON.parse(fs.readFileSync(FILE,'utf8')).events||[])cache.set(e.eventId,e);}catch{}}
 const old=cache.get(String(c.eventId));if(old&&Date.now()-Date.parse(old.capturedAt)<900000)return old;
 if(!pending.has(String(c.eventId)))pending.set(String(c.eventId),collect(c,options).then(e=>{cache.set(e.eventId,e);fs.mkdirSync(path.dirname(FILE),{recursive:true});const temp=FILE+'.tmp';fs.writeFileSync(temp,JSON.stringify({events:[...cache.values()].filter(x=>Date.now()-Date.parse(x.capturedAt)<900000)}));fs.renameSync(temp,FILE);return e;}).finally(()=>pending.delete(String(c.eventId))));
 return pending.get(String(c.eventId));
}
async function checkCandidates(rows,{signal,maxFixtures=Number(process.env.SPORTYBET_H2H_MAX_FIXTURES)||40,budgetMs=90000,collectEvidence=read,now=()=>new Date()}={}){
 if(process.env.SPORTYBET_H2H_ENABLED==='false')return rows;
 const deadline=Date.now()+budgetMs,groups=new Map(),unique=new Map();
 for(const c of [...rows].sort((a,b)=>Number(b.probability)-Number(a.probability)))if(!unique.has(String(c.eventId)))unique.set(String(c.eventId),c);
 for(const c of unique.values()){const sport=require('./telegramMixedSelector').normalizedSport(c)||'unknown';if(!groups.has(sport))groups.set(sport,[]);groups.get(sport).push(c);}
 const fixtures=[];while(fixtures.length<maxFixtures&&[...groups.values()].some(a=>a.length))for(const group of groups.values())if(group.length&&fixtures.length<maxFixtures)fixtures.push(group.shift());
 const evidence=new Map();let index=0;
 await Promise.all([0,1].map(async()=>{while(index<fixtures.length&&Date.now()<deadline&&!signal?.aborted){const c=fixtures[index++];try{evidence.set(String(c.eventId),await collectEvidence(c,{signal}));}catch{evidence.set(String(c.eventId),null);}}}));
 const result=rows.map(c=>assess(c,evidence.get(String(c.eventId)),now()));
 for(const key of Object.keys(rows))if(!/^\d+$/.test(key))result[key]=rows[key];
 result.h2hCoverage={fixturesRequested:new Set(rows.map(c=>c.eventId)).size,fixturesChecked:evidence.size,verified:result.filter(c=>c.h2hCheck.verified!==false).length,unverified:result.filter(c=>c.h2hCheck.verified===false).length,blocked:result.filter(c=>!c.h2hCheck.allowed).length};return result;
}
module.exports={checkCandidates,urlFor,collect};
