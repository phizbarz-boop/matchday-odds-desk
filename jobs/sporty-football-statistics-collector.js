'use strict';
// Read the statistics panel on actual SportyBet match pages with the existing
// dummy session. The collector never stakes a bet or uses an outside provider.
const fs=require('fs');
const {chromium}=require('playwright');
const direct=require('../lib/sportybetDirect');
const {getFootballMarket,getLiveSportMarket}=require('../lib/sportybet');
const {parseDisplayedStats,sanitizeStats}=require('../lib/sportyFootballStats');
const {STATS_FILE}=require('../lib/sportyFootballModel');
async function main(){
  await direct.ensureSession();
  const browser=await chromium.launch({headless:true});
  try {
    const context=await browser.newContext({locale:'en-NG'});
    await context.addCookies([...direct._session.cookies].filter(([,v])=>!v.expiresAt || v.expiresAt>Date.now()).map(([name,v])=>({name,value:v.value,domain:'.sportybet.com',path:'/',secure:true,httpOnly:true})));
    const [prematch,live]=await Promise.allSettled([getFootballMarket('1x2',{hours:504,maxPages:10}),getLiveSportMarket('football','1x2',{maxPages:5})]);
    const fixtures=new Map([prematch,live].filter(x=>x.status==='fulfilled').flatMap(x=>x.value.rows||[]).map(x=>[String(x.eventId),x]));
    const page=await context.newPage(), links=new Map();
    // Only navigate match links exposed by the website; no fabricated route.
    for(const url of ['https://www.sportybet.com/ng/sport/football/','https://www.sportybet.com/ng/sport/live/']){
      await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
      await page.locator('a[href*="sr:match:"]').first().waitFor({timeout:20000}).catch(()=>{});
      for(let i=0;i<8;i++){
        const anchors=await page.locator('a[href*="sr:match:"]').evaluateAll(nodes=>nodes.map(n=>n.href));
        for(const href of anchors){const id=href.match(/sr:match:\d+/)?.[0];if(id && fixtures.has(id) && new URL(href).hostname.endsWith('.sportybet.com'))links.set(id,href);}
        await page.mouse.wheel(0,1400);await page.waitForTimeout(500);
      }
    }
    const max=Math.max(1,Math.min(1000,Number(process.env.SPORTYBET_STATS_MAX_EVENTS||200))),events=[];
    for(const [id,url] of [...links].slice(0,max)){
      try {
        await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
        await page.getByText('Head to head',{exact:true}).first().waitFor({timeout:2500}).catch(()=>{});
        if(!(await page.getByText('Head to head',{exact:true}).count())){
          // The stats toggle's icon was inspected on SportyBet's match page.
          await page.getByText('',{exact:true}).first().click({timeout:12000});
        }
        await page.getByText('Head to head',{exact:true}).first().click({timeout:15000});
        await page.getByText('PREVIOUS MEETINGS',{exact:true}).first().waitFor({timeout:15000});
        const stats=parseDisplayedStats(await page.locator('body').innerText());
        if(!Object.keys(stats).length)continue;
        const fixture=fixtures.get(id),row=sanitizeStats({eventId:id,home:fixture.home,away:fixture.away,capturedAt:new Date().toISOString(),...stats});
        if(row)events.push(row);
      }catch(error){console.warn(`[SportyBet statistics] ${id}: ${error.message.split('\n')[0]}`);}
    }
    if(!events.length)throw new Error('No readable SportyBet football statistics; previous snapshot preserved.');
    fs.mkdirSync(require('path').dirname(STATS_FILE),{recursive:true});
    const previous=fs.existsSync(STATS_FILE)?JSON.parse(fs.readFileSync(STATS_FILE,'utf8')).events||[]:[];
    const merged=new Map(previous.filter(x=>Date.now()-Date.parse(x.capturedAt)<172800000).map(x=>[x.eventId,x]));events.forEach(x=>merged.set(x.eventId,x));
    fs.writeFileSync(STATS_FILE,JSON.stringify({fetchedAt:new Date().toISOString(),events:[...merged.values()]}));
    if(process.env.MATCHDAY_BASE_URL){
      if(!process.env.TELEGRAM_JOB_SECRET)throw new Error('TELEGRAM_JOB_SECRET is required to publish statistics');
      const response=await fetch(`${process.env.MATCHDAY_BASE_URL.replace(/\/$/,'')}/api/internal/football/statistics`,{method:'POST',headers:{'Content-Type':'application/json','x-telegram-job-secret':process.env.TELEGRAM_JOB_SECRET},body:JSON.stringify({events}),signal:AbortSignal.timeout(60000)});
      if(!response.ok)throw new Error(`Statistics publish HTTP ${response.status}`);
    }
    console.log(`[SportyBet statistics] collected ${events.length}/${links.size} discovered match pages`);
  }finally{await browser.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main};
