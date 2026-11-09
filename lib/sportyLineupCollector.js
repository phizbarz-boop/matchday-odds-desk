'use strict';
const S=require('./sportyLineups');
// The public widget can change locale and time zone without changing the match.
const widgetPath=/^\/common\/[^/]+\/[^/]+\/gismo\/(match_timelinedelta|stats_team_usuallineup)\/(\d+)(?:\/(\d+))?$/;
const widgetUrl=url=>{try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='lmt.fn.sportradar.com'&&widgetPath.test(decodeURIComponent(u.pathname))?u:null;}catch{return null;}};
async function openDesktopStats(page){
 const items=page.locator('#j_title').locator('button,a,i,span,[role="button"],[title],[aria-label]');
 for(const item of await items.all()){
  try{
   if(!await item.isVisible())continue;
   const stats=await item.evaluate(el=>/^(?:match )?(?:stats|statistics)$/i.test((el.getAttribute('title')||el.getAttribute('aria-label')||el.textContent||'').trim())||
    [el.textContent,getComputedStyle(el,'::before').content,getComputedStyle(el,'::after').content].some(v=>v?.includes('\ue61d')));
   if(stats){await item.click({timeout:1500});return true;}
  }catch{}
 }
 return false;
}
async function collectPage(page,c,{signal,timeoutMs=35000}={}){
 const docs=new Map(),pending=new Set(),diagnostics={statsOpened:false,lineupsOpened:false,widgetResponses:0,timelineResponses:0,timelineJson:false,widgetHttpStatuses:[],widgetFailures:0};
 let signed=null,identity=null;
 const id=String(c.eventId).replace(/^sr:match:/,'');
 const capture=async response=>{
  const url=widgetUrl(response.url());
  if(!url){
   if(require('./h2hWorkerBrowser').widgetLoader(response.url()))diagnostics.widgetLoaderStatus=response.status();
   return;
  }
  diagnostics.widgetResponses++;
  const route=decodeURIComponent(url.pathname).match(widgetPath),isTimeline=route[1]==='match_timelinedelta'&&route[2]===id;
  if(isTimeline)diagnostics.timelineResponses++;
  if(!diagnostics.widgetHttpStatuses.includes(response.status()))diagnostics.widgetHttpStatuses.push(response.status());
  if(response.status()!==200||Number(response.headers()['content-length'])>2000000)return;
  try{
   const json=await response.json();
   if(isTimeline){
    diagnostics.timelineJson=true;identity=S.timelineIdentity(json,c);
    if(identity&&url.searchParams.has('T'))signed=url;
    if(!identity){
     const m=Array.isArray(json?.doc)?json.doc.find(d=>d?.event==='match_timelinedelta')?.data?.match:null;
     const name=v=>typeof v==='string'?v.slice(0,100):null;
     diagnostics.expected={home:name(c.home),away:name(c.away),kickoffUtc:name(c.kickoffUtc)};
     diagnostics.received={home:name(m?.teams?.home?.mediumname||m?.teams?.home?.name),away:name(m?.teams?.away?.mediumname||m?.teams?.away?.name),kickoffEpochSeconds:Number.isFinite(m?._dt?.uts)?m._dt.uts:null};
    }
   }else if(route[1]==='stats_team_usuallineup'&&/^stats_team_usuallineup\/\d+\/\d+$/.test(json.queryUrl||''))docs.set(json.queryUrl,json);
  }catch{}
 };
 const onResponse=response=>{const p=capture(response);pending.add(p);p.finally(()=>pending.delete(p));};
 const context=page.context();context.on('response',onResponse);const onFailed=request=>{if(widgetUrl(request.url())||require('./h2hWorkerBrowser').widgetLoader(request.url()))diagnostics.widgetFailures++;};context.on('requestfailed',onFailed);const abort=()=>{void page.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 const deadline=Date.now()+timeoutMs;
 try{
  const response=await page.goto(require('./sportyH2h').urlFor(c).replace('/ng/m/sport/','/ng/sport/'),{waitUntil:'domcontentloaded',timeout:20000});
  if(response&&response.status()>=400)throw Error('SPORTYBET_LINEUP_PAGE_UNAVAILABLE');

  let clicked=false;
  while(Date.now()<deadline&&!signal?.aborted){
   if(!diagnostics.statsOpened&&!identity)diagnostics.statsOpened=await openDesktopStats(page);
   for(const tab of context.pages())for(const frame of tab.frames())try{const choices=await frame.getByText(/^Lineups$/i).all();for(const choice of choices)if(!clicked&&await choice.isVisible()){await choice.click({timeout:1000});clicked=true;diagnostics.lineupsOpened=true;break;}}catch{}
   if(identity&&identity.teams.every(teamId=>docs.has(`stats_team_usuallineup/${teamId}/${identity.seasonId}`)))break;
   if(identity&&signed&&deadline-Date.now()<9000)break;
   await new Promise(r=>setTimeout(r,150));
  }
  await Promise.allSettled([...pending]);
  if(!identity)throw Error(diagnostics.timelineJson?'SPORTYBET_LINEUP_MATCH_IDENTITY_UNVERIFIED':diagnostics.timelineResponses?'SPORTYBET_LINEUP_TIMELINE_UNAVAILABLE':'SPORTYBET_LINEUP_TIMELINE_NOT_RECEIVED');
  const players=[];
  for(const teamId of identity.teams){
   const query=`stats_team_usuallineup/${teamId}/${identity.seasonId}`;let json=docs.get(query);
   if(!json&&signed){
    // Use only the current widget's own origin-scoped signature, never persist it.
    const u=new URL(signed);u.pathname=u.pathname.replace(/match_timelinedelta\/\d+$/,query);
    const result=await context.request.get(u.href,{headers:{Origin:'https://www.sportybet.com',Referer:'https://www.sportybet.com/'},timeout:Math.max(1,Math.min(8000,deadline-Date.now()))});
    if(result.ok())json=await result.json();
   }
   const parsed=S.parseUsual(json,{teamId,seasonId:identity.seasonId});if(!parsed)throw Error('SPORTYBET_USUAL_LINEUP_UNAVAILABLE');players.push(...parsed);
  }
  return {eventId:String(c.eventId),home:c.home,away:c.away,kickoffUtc:c.kickoffUtc,capturedAt:new Date().toISOString(),basis:'usual',provider:'sportybet',startingLineupConfirmed:false,players};
 }catch(error){error.lineupDiagnostics=diagnostics;throw error;}finally{context.off('requestfailed',onFailed);context.off('response',onResponse);signal?.removeEventListener('abort',abort);}
}
module.exports={collectPage,widgetUrl};
