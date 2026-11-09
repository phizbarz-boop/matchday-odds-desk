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
async function collectPage(page,c,{signal,timeoutMs=20000}={}){
 const docs=new Map(),diagnostics={statsOpened:false,lineupsOpened:false,widgetResponses:0,timelineResponses:0,timelineJson:false,widgetHttpStatuses:[],widgetFailures:0,usualLineups:[]};
 let signed=null,identity=null,lookup=null;
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
    diagnostics.timelineJson=true;const verified=S.timelineIdentity(json,c);
    if(!identity&&verified)identity=verified;
    if(verified&&identity.seasonId===verified.seasonId&&identity.teams.every((team,i)=>team===verified.teams[i])&&url.searchParams.has('T'))signed=url;
    if(!identity){
     const m=Array.isArray(json?.doc)?json.doc.find(d=>d?.event==='match_timelinedelta')?.data?.match:null;
     const name=v=>typeof v==='string'?v.slice(0,100):null;
     diagnostics.expected={home:name(c.home),away:name(c.away),kickoffUtc:name(c.kickoffUtc)};
     diagnostics.received={home:name(m?.teams?.home?.mediumname||m?.teams?.home?.name),away:name(m?.teams?.away?.mediumname||m?.teams?.away?.name),kickoffEpochSeconds:Number.isFinite(m?._dt?.uts)?m._dt.uts:null};
    }
   }else if(route[1]==='stats_team_usuallineup'&&/^stats_team_usuallineup\/\d+\/\d+$/.test(json.queryUrl||''))docs.set(json.queryUrl,json);
  }catch{}
 };
 const onResponse=response=>{void capture(response).catch(()=>{});};
 const context=page.context();context.on('response',onResponse);const onFailed=request=>{if(widgetUrl(request.url())||require('./h2hWorkerBrowser').widgetLoader(request.url()))diagnostics.widgetFailures++;};context.on('requestfailed',onFailed);const abort=()=>{void page.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 const deadline=Date.now()+timeoutMs;
 try{
  const response=await page.goto(require('./sportyH2h').urlFor(c).replace('/ng/m/sport/','/ng/sport/'),{waitUntil:'domcontentloaded',timeout:Math.max(1,Math.min(12000,deadline-Date.now()))});
  if(response&&response.status()>=400)throw Error('SPORTYBET_LINEUP_PAGE_UNAVAILABLE');

  let clicked=false;
  const readUsual=async (teamId,seasonId,signature)=>{
   const query=`stats_team_usuallineup/${teamId}/${seasonId}`;
   const cached=S.parseUsual(docs.get(query),{teamId,seasonId});
   if(cached)return cached;
   const note={teamId};diagnostics.usualLineups.push(note);
   const u=new URL(signature);u.pathname=u.pathname.replace(/match_timelinedelta\/\d+$/,query);
   let result;
   try{
    result=await context.request.get(u.href,{headers:{Origin:'https://www.sportybet.com',Referer:'https://www.sportybet.com/'},timeout:Math.max(1,Math.min(5000,deadline-Date.now())),maxRedirects:0});
    note.httpStatus=result.status();
    if(!result.ok()){note.outcome='http_error';return null;}
    const json=await result.json();
    const rows=S.parseUsual(json,{teamId,seasonId});
    const offered=Array.isArray(json?.doc)?json.doc.find(d=>d?.event==='stats_team_usuallineup')?.data?.players:null;
    note.playerCount=Array.isArray(offered)?offered.length:null;
    note.outcome=rows?'usable':json?.queryUrl!==query?'unexpected_payload':'unusable_player_list';
    return rows;
   }catch{note.outcome='request_failed';return null;}
   finally{await result?.dispose?.().catch(()=>{});}
  };
  let directRows=null;
  while(Date.now()<deadline&&!signal?.aborted){
   if(!diagnostics.statsOpened&&!identity)diagnostics.statsOpened=await openDesktopStats(page);
   if(identity&&signed&&!lookup){
    const current=identity;
    lookup=Promise.all(current.teams.map(teamId=>readUsual(teamId,current.seasonId,signed))).then(rows=>{directRows=rows;});
   }
   if(!clicked)for(const tab of context.pages())for(const frame of tab.frames())try{const choices=await frame.getByText(/^Line[- ]?ups$/i).all();for(const choice of choices)if(!clicked&&await choice.isVisible()){await choice.click({timeout:Math.max(1,Math.min(1000,deadline-Date.now()))});clicked=true;diagnostics.lineupsOpened=true;break;}}catch{}
   if(identity&&identity.teams.every((teamId,i)=>directRows?.[i]||S.parseUsual(docs.get(`stats_team_usuallineup/${teamId}/${identity.seasonId}`),{teamId,seasonId:identity.seasonId})))break;
   // A rejected or empty direct read has already supplied a useful diagnostic.
   // If there is no visible lineup tab, don't idle for the rest of the fixture budget.
   if(directRows&&!clicked)break;
   if(Date.now()<deadline)await new Promise(r=>setTimeout(r,Math.min(150,deadline-Date.now())));
  }
  if(!identity)throw Error(diagnostics.timelineJson?'SPORTYBET_LINEUP_MATCH_IDENTITY_UNVERIFIED':diagnostics.timelineResponses?'SPORTYBET_LINEUP_TIMELINE_UNAVAILABLE':'SPORTYBET_LINEUP_TIMELINE_NOT_RECEIVED');
  const players=[];
  for(const [i,teamId] of identity.teams.entries()){
   const query=`stats_team_usuallineup/${teamId}/${identity.seasonId}`;
   const parsed=S.parseUsual(docs.get(query),{teamId,seasonId:identity.seasonId})||directRows?.[i];
   if(!parsed)throw Error('SPORTYBET_USUAL_LINEUP_UNAVAILABLE');
   players.push(...parsed);
  }
  return {eventId:String(c.eventId),home:c.home,away:c.away,kickoffUtc:c.kickoffUtc,capturedAt:new Date().toISOString(),basis:'usual',provider:'sportybet',startingLineupConfirmed:false,players};
 }catch(error){error.lineupDiagnostics=diagnostics;throw error;}finally{context.off('requestfailed',onFailed);context.off('response',onResponse);signal?.removeEventListener('abort',abort);}
}
module.exports={collectPage,widgetUrl};
