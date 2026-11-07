'use strict';
const S=require('./sportyLineups');
const widgetUrl=url=>{try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='lmt.fn.sportradar.com'&&/^\/common\/en\/Etc:UTC\/gismo\/(?:match_timelinedelta|stats_team_usuallineup)\//.test(u.pathname)?u:null;}catch{return null;}};
async function collectPage(page,c,{signal,timeoutMs=35000}={}){
 const docs=new Map(),pending=new Set();let signed=null,identity=null;
 const capture=async response=>{const url=widgetUrl(response.url());if(!url||response.status()!==200)return;
  if(Number(response.headers()['content-length'])>2000000)return;
  try{const json=await response.json();if(url.searchParams.has('T'))signed=url;
   if(json.queryUrl==='match_timelinedelta/'+String(c.eventId).replace(/^sr:match:/,''))identity=S.timelineIdentity(json,c);
   else if(/^stats_team_usuallineup\/\d+\/\d+$/.test(json.queryUrl||''))docs.set(json.queryUrl,json);
  }catch{}
 };
 const onResponse=response=>{const p=capture(response);pending.add(p);p.finally(()=>pending.delete(p));};
 const context=page.context();context.on('response',onResponse);const abort=()=>{void page.close().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
 const deadline=Date.now()+timeoutMs;
 try{
  const response=await page.goto(require('./sportyH2h').urlFor(c),{waitUntil:'domcontentloaded',timeout:20000});
  if(response&&response.status()>=400)throw Error('SPORTYBET_LINEUP_PAGE_UNAVAILABLE');
  await require('./h2hPanels').clickTab(page,'stats',{signal,timeoutMs:5000});
  let clicked=false;
  while(Date.now()<deadline&&!signal?.aborted){
   for(const frame of page.frames())try{const choices=await frame.getByText(/^Lineups$/i).all();for(const choice of choices)if(!clicked&&await choice.isVisible()){await choice.click({timeout:1000});clicked=true;break;}}catch{}
   if(identity&&signed)break;
   await new Promise(r=>setTimeout(r,150));
  }
  await Promise.allSettled([...pending]);
  if(!identity)throw Error('SPORTYBET_LINEUP_MATCH_IDENTITY_UNVERIFIED');
  const players=[];
  for(const teamId of identity.teams){
   const query=`stats_team_usuallineup/${teamId}/${identity.seasonId}`;let json=docs.get(query);
   if(!json&&signed){
    // Use only the current widget's own origin-scoped signature, never persist it.
    const u=new URL(signed);u.pathname='/common/en/Etc:UTC/gismo/'+query;
    const result=await context.request.get(u.href,{headers:{Origin:'https://www.sportybet.com',Referer:'https://www.sportybet.com/'},timeout:Math.max(1,Math.min(8000,deadline-Date.now()))});
    if(result.ok())json=await result.json();
   }
   const parsed=S.parseUsual(json,{teamId,seasonId:identity.seasonId});if(!parsed)throw Error('SPORTYBET_USUAL_LINEUP_UNAVAILABLE');players.push(...parsed);
  }
  return {eventId:String(c.eventId),home:c.home,away:c.away,kickoffUtc:c.kickoffUtc,capturedAt:new Date().toISOString(),basis:'usual',provider:'sportybet',startingLineupConfirmed:false,players};
 }finally{context.off('response',onResponse);signal?.removeEventListener('abort',abort);}
}
module.exports={collectPage,widgetUrl};
