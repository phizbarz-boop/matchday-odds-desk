'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sporty=require('./sportybet');
const {withPublicSportyRequest}=require('./sportyRequest');
const {buildCandidates}=require('./autoPicker');
const {enrichSportyFixtures}=require('./sportyFootballModel');
const {isTeamTotalSelection}=require('./teamGoalMarket');
const CACHE_KEY='sportybet:public-catalog:v1';
const CACHE_FILE=process.env.SPORTYBET_PUBLIC_CACHE_FILE||path.join(__dirname,'..','data','sportybet-public-cache.json');
const SPORTS=Object.keys(sporty.SPORT_IDS);
const selectionKey=row=>[row.eventId,row.marketId,row.outcomeId,row.specifier||''].join('|');
const abort=signal=>{if(signal?.aborted)throw Object.assign(new Error('Public SportyBet collection cancelled'),{code:'SPORTYBET_COLLECTION_CANCELLED'});};
const blocked=err=>['SPORTYBET_GEO_BLOCKED','SPORTYBET_BOT_CHALLENGE'].includes(err.code)||[403,429].includes(Number(err.status));

async function collectPublicCatalog({previous=null,env=process.env,signal,now=()=>new Date(),client=sporty.direct,pause=ms=>new Promise(r=>setTimeout(r,ms)),selectedSports=SPORTS,horizonHours=null}={}) {
  return withPublicSportyRequest(async()=>{
    const maxPages=Math.max(1,Math.min(100,Number(env.SPORTYBET_PUBLIC_MAX_PAGES)||50));
    const pageSize=100,generatedAt=now().toISOString(),sports={},errors={};
    // One sport at a time and two event details at a time keep a large refresh
    // bounded. All returned market types are retained, even if unmodelled.
    for(const sport of selectedSports.filter(s=>SPORTS.includes(s))){
      abort(signal);
      try{
        const events=new Map();let pages=0,total=null,complete=false;
        for(let page=1;page<=maxPages;page++){
          abort(signal);
          const response=await client.fetchPrematchPage(sporty.SPORT_IDS[sport],page,pageSize,{marketIds:sporty.marketIdsForSport(sport)});
          const parsed=sporty.extractUpcomingEvents(response);pages++;total=parsed.total??total;
          let added=0;
          for(const event of parsed.events){const id=String(event.eventId??event.event_id??'');if(id&&!events.has(id)){events.set(id,event);added++;}}
          if(!parsed.events.length){complete=!total||events.size>=total;break;}
          if(total?events.size>=total:parsed.events.length<pageSize){complete=true;break;}
          if(!added){complete=Boolean(total&&events.size>=total);break;}
        }
        const fixtures=[],rows=new Map();let details=0,detailErrors=0;
        const discoveredFixtures=events.size,upcoming=[];
        for(const event of events.values()){
          if(sporty.isLiveEvent(event)||event.banned===true)continue;
          const context=sporty.fixtureContext(event,sporty.SPORT_LABELS[sport]);
          const kickoffMs=Date.parse(sporty.normalizeOutcome({...event,estimateStartTime:context.estimateStartTime??event.kickoffUtc??event.kickoffTime}).kickoffUtc||'');
          if(!Number.isFinite(kickoffMs)||kickoffMs<=now().getTime()||horizonHours&&kickoffMs>now().getTime()+horizonHours*3600000)continue;
          fixtures.push({...context,sportKey:sport,kickoffUtc:new Date(kickoffMs).toISOString()});
          for(const row of sporty.flattenDetailedMarkets(event,context))rows.set(selectionKey(row),row);
          upcoming.push(context);
        }
        // Detail collection only needs identities, not every raw list-market tree.
        events.clear();
        for(let i=0;i<upcoming.length;i+=2){
          abort(signal);
          const results=await Promise.allSettled(upcoming.slice(i,i+2).map(async event=>{
            const context=sporty.fixtureContext(event,sporty.SPORT_LABELS[sport]);
            const payload=await client.fetchEventDetail(context.eventId);
            const freshEvent=sporty.extractUpcomingEvents(payload).events.find(e=>String(e.eventId??e.event_id)===context.eventId);
            const freshRows=freshEvent&&(freshEvent.banned===true||sporty.isLiveEvent(freshEvent))?[]:sporty.flattenDetailedMarkets(payload,context);
            return {eventId:context.eventId,rows:freshRows};
          }));
          for(const result of results){
            if(result.status==='fulfilled'){
              details++;
              // A full detail response replaces the embedded list markets,
              // including when every formerly offered market is suspended.
              for(const [key,row] of rows)if(row.eventId===result.value.eventId)rows.delete(key);
              result.value.rows.forEach(row=>rows.set(selectionKey(row),row));
              const fresh=result.value.rows[0],fixture=fixtures.find(f=>f.eventId===result.value.eventId);
              if(fresh&&fixture)Object.assign(fixture,{home:fresh.home,away:fresh.away,kickoffUtc:fresh.kickoffUtc});
            }
            else{if(blocked(result.reason))throw result.reason;detailErrors++;}
          }
          if(i+2<upcoming.length)await pause(Math.max(0,Number(env.SPORTYBET_PUBLIC_DETAIL_DELAY_MS??250)||0));
        }
        sports[sport]={fetchedAt:now().toISOString(),fixtures,rows:[...rows.values()],coverage:{pages,upstreamTotal:total,
          discoveredFixtures,upcomingFixtures:fixtures.length,detailReads:details,detailErrors,
          complete:complete&&detailErrors===0,paginationComplete:complete}};
      }catch(err){
        abort(signal);if(blocked(err))throw err;
        errors[sport]=String(err.message).slice(0,180);
        if(previous?.sports?.[sport])sports[sport]={...previous.sports[sport],carriedForward:true,lastCollectionError:errors[sport]};
      }
    }
    if(Object.keys(errors).length===selectedSports.length)throw new Error('All public SportyBet sport reads failed; previous cache retained');
    return {schemaVersion:1,source:'SportyBet public website feeds',loginRequired:false,generatedAt,sports,errors};
  },{signal});
}

const inputIndexes=new WeakMap();
function marketInputs(catalog){
  if(inputIndexes.has(catalog))return inputIndexes.get(catalog);
  const fields={footballMarkets:{}};
  const payload=(rows,kind)=>({rows,probabilityRows:rows,fetchedAt:catalog.generatedAt,source:catalog.source,market:kind});
  const football=catalog.sports?.football?.rows||[];
  for(const [kind,cfg] of Object.entries(sporty.FOOTBALL_MARKETS)){
    if(['first_half_team_corners','oneup'].includes(kind))continue;
    const filtered=football.filter(row=>sporty.rowMatchesConfiguredMarket(row,cfg)||sporty.isDetailedMarketRow(row,kind));
    fields.footballMarkets[kind]={...payload(filtered,kind),probabilityRows:football};
  }
  // isDetailedMarketRow selects the requested side of a team total; retain the
  // opposite outcome too for its complete no-vig probability pair.
  for(const kind of ['home_ou05','away_ou05','home_ou45','away_ou45']){
    const side=kind.startsWith('home_')?'home':'away',line=kind.endsWith('05')?'0.5':'4.5';
    fields.footballMarkets[kind].probabilityRows=football.filter(row=>isTeamTotalSelection(row,side,line,'over')||isTeamTotalSelection(row,side,line,'under'));
  }
  for(const [sport,cfg] of Object.entries(sporty.SPORT_CONFIG)){
    const rows=catalog.sports?.[sport]?.rows||[];
    for(const [kind,market] of Object.entries(cfg.markets)){
      const suffix={winner:'Winner',totals:'Totals',handicap:'Handicap',sets:'Sets'}[kind];
      fields[sport+suffix]=payload(rows.filter(row=>sporty.rowMatchesConfiguredMarket(row,market)),kind);
    }
  }
  inputIndexes.set(catalog,fields);return fields;
}
async function publicPredictions(catalog){
  const rows=catalog.sports?.football?.rows||[];
  const fixtures=catalog.sports?.football?.fixtures||[];
  return {generatedAt:catalog.sports?.football?.fetchedAt||catalog.generatedAt,source:catalog.source,readMode:'public-cache',
    model:{version:require('./sportyFootballModel').MODEL_VERSION},matches:await enrichSportyFixtures(fixtures,{maxFixtures:fixtures.length||1,marketRows:rows})};
}
async function publicCandidates(catalog){
  const predictions=await publicPredictions(catalog);
  const known=buildCandidates({...marketInputs(catalog),predictions,minProbability:0,minEdge:-100,sportScope:'all'});const expanded=require('./offeredMarketModel').modelOfferedMarkets(Object.values(catalog.sports||{}).flatMap(s=>s.rows||[]),{known,predictions});return require('./telegramSmallGap').annotateSmallGap([...known,...expanded.candidates],catalog.sports?.football?.rows||[]);
}
// A missing detail route must not make an otherwise current public list
// unusable. Only fresh list rows are accepted; saved ticket prices are never
// used as proof that an outcome remains offered.
async function validatePublicSelections(selections,{signal,client=sporty.direct,now=()=>new Date(),maxPages=50}={}){
  return withPublicSportyRequest(async()=>{
    const catalog={source:'SportyBet current public event markets',generatedAt:now().toISOString(),sports:{}};
    const events=new Map(selections.map(row=>[String(row.eventId),row])),list=[...events.values()],fallback=new Map();
    const add=(row,rows)=>{const sport=require('./telegramMixedSelector').normalizedSport(row);if(!sport)return;catalog.sports[sport]||={fixtures:[],rows:[],fetchedAt:catalog.generatedAt};catalog.sports[sport].rows.push(...rows);if(rows[0])catalog.sports[sport].fixtures.push(rows[0]);};
    for(let i=0;i<list.length;i+=2){
      abort(signal);
      const batch=list.slice(i,i+2),results=await Promise.allSettled(batch.map(async row=>{
        const payload=await client.fetchEventDetail(row.eventId);
        const parsed=sporty.extractUpcomingEvents(payload).events.find(event=>String(event.eventId??event.event_id)===String(row.eventId));
        if(parsed&&(parsed.banned===true||sporty.isLiveEvent(parsed)))return [];
        return sporty.flattenDetailedMarkets(payload,{...row,sport:row.sport,live:false});
      }));
      for(let j=0;j<results.length;j++){
        const result=results[j],row=batch[j];
        if(result.status==='fulfilled'){add(row,result.value);continue;}
        const error=result.reason;if(blocked(error)||!(['SPORTYBET_ENDPOINT_UNKNOWN','SPORTYBET_NON_JSON'].includes(error.code)||Number(error.status)===404))throw error;
        const sport=require('./telegramMixedSelector').normalizedSport(row);if(!sport)continue;
        if(!fallback.has(sport))fallback.set(sport,[]);fallback.get(sport).push(row);
      }
    }
    // Fresh public fixture pages embed active market/outcome IDs and complete
    // price partitions. Paginate once per affected sport, not once per leg.
    for(const [sport,requested] of fallback){
      const remaining=new Map(requested.map(row=>[String(row.eventId),row]));
      const marketIds=[...new Set([...String(sporty.marketIdsForSport(sport)).split(',').filter(Boolean),...selections.filter(row=>require('./telegramMixedSelector').normalizedSport(row)===sport).map(row=>String(row.marketId))])];
      const seen=new Set();
      for(let page=1;page<=Math.max(1,Math.min(100,maxPages))&&remaining.size;page++){
        abort(signal);
        const payload=await client.fetchPrematchPage(sporty.SPORT_IDS[sport],page,100,{marketIds});
        const parsed=sporty.extractUpcomingEvents(payload);let added=0;
        for(const event of parsed.events){
          const id=String(event.eventId??event.event_id??'');if(!seen.has(id)){seen.add(id);added++;}
          if(!remaining.has(id))continue;remaining.delete(id);
          if(event.banned===true||sporty.isLiveEvent(event))continue;
          const context=sporty.fixtureContext(event,sporty.SPORT_LABELS[sport]);
          // Keep the newly returned kickoff; an old ticket cannot turn an
          // already-started event back into an upcoming match.
          const rows=sporty.flattenDetailedMarkets(event,context).filter(row=>Number.isFinite(Date.parse(row.kickoffUtc||''))&&Date.parse(row.kickoffUtc)>now().getTime()+60000);
          add(context,rows);
        }
        if(!parsed.events.length||!added||(parsed.total!=null&&seen.size>=parsed.total)||parsed.total==null&&parsed.events.length<100)break;
      }
    }
    const candidates=await publicCandidates(catalog),offered=new Map(candidates.map(row=>[selectionKey(row)+'|'+row.betType,row]));
    return selections.map(row=>offered.get(selectionKey(row)+'|'+row.betType)).filter(Boolean);
  },{signal});
}

function createPublicCache({getRedis=async()=>null,file=CACHE_FILE,env=process.env,now=()=>new Date(),collect=collectPublicCatalog,logger=console,
  timers={setInterval,clearInterval}}={}){
  let memory=null,pending=null,lastRun=null,readPending=null,lastReadAt=-Infinity;
  async function read(){
    // Concurrent market families must not parse independent copies of the entire catalog.
    if(memory&&now().getTime()-lastReadAt<5000)return memory;
    if(readPending)return readPending;
    readPending=readStored();
    try{return await readPending;}finally{readPending=null;}
  }
  async function readStored(){
    const redis=await getRedis();
    if(!redis&&memory)return memory;
    const decode=raw=>{
      if(!raw)return null;
      try{const value=JSON.parse(raw);return value.schemaVersion===1&&value.loginRequired===false&&value.sports&&typeof value.sports==='object'?value:null;}
      catch{logger.warn?.('Public SportyBet cache contains invalid JSON; using the last readable snapshot');return null;}
    };
    const raw=redis?await redis.get(CACHE_KEY):null;
    let saved=decode(raw);
    if(!saved&&fs.existsSync(file))saved=decode(fs.readFileSync(file,'utf8'));
    if(saved)memory=saved;
    lastReadAt=now().getTime();return memory;
  }
  async function refresh({signal}={}){
    if(pending)return pending;
    pending=(async()=>{
      const redis=await getRedis(),token=crypto.randomUUID(),lock=CACHE_KEY+':refresh';let locked=false,heartbeat,leaseLost=false;
      if(redis){
        // Renew a short lease while collecting. A stopped process no longer
        // leaves future deploys waiting for a fixed one-hour cache lock.
        locked=await redis.set(lock,token,{NX:true,EX:900})==='OK';
        if(!locked){lastRun={status:'waiting',reason:'public_refresh_in_progress',startedAt:now().toISOString()};
          return {skipped:true,reason:'public_refresh_in_progress',catalog:await read()};}
        heartbeat=timers.setInterval(()=>{void redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], 900) else return 0 end',
          {keys:[lock],arguments:[token]}).then(result=>{if(!result)leaseLost=true;}).catch(()=>{});},45000);
        heartbeat?.unref?.();
      }
      lastRun={status:'collecting',startedAt:now().toISOString()};
      try{
        const previous=await read(),catalog=await collect({previous,env,signal,now});abort(signal);
        const predictions=await publicPredictions(catalog);abort(signal);
        if(redis&&(leaseLost||await redis.get(lock)!==token))throw new Error('Public SportyBet refresh lease was lost; previous cache retained');
        if(redis){await redis.set(CACHE_KEY,JSON.stringify(catalog));await redis.set('predictions:latest',JSON.stringify(predictions));}
        fs.mkdirSync(path.dirname(file),{recursive:true});
        const temporary=file+'.'+process.pid+'.tmp';fs.writeFileSync(temporary,JSON.stringify(catalog));fs.renameSync(temporary,file);
        const predictionFile=path.join(path.dirname(file),'predictions.json');fs.writeFileSync(predictionFile+'.tmp',JSON.stringify(predictions));fs.renameSync(predictionFile+'.tmp',predictionFile);
        memory=catalog;lastReadAt=now().getTime();lastRun={...lastRun,status:'completed',finishedAt:now().toISOString(),errors:catalog.errors};
        return {catalog,predictions};
      }catch(err){lastRun={...lastRun,status:'failed',finishedAt:now().toISOString(),reason:String(err.message).slice(0,200)};throw err;}
      finally{if(heartbeat)timers.clearInterval(heartbeat);if(locked)await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',{keys:[lock],arguments:[token]}).catch(()=>{});}
    })();
    try{return await pending;}finally{pending=null;}
  }
  async function usable({signal}={}){
    let catalog=await read();
    if(!catalog||now().getTime()-Date.parse(catalog.generatedAt)>18*3600000){const result=await refresh({signal});catalog=result.catalog;}
    if(!catalog)throw new Error('Public SportyBet cache is not ready');return catalog;
  }
  function status(){return {source:'SportyBet public website feeds',loginRequired:false,file:path.basename(file),lastRun,
    generatedAt:memory?.generatedAt||null,sports:memory?Object.fromEntries(Object.entries(memory.sports||{}).map(([sport,data])=>[sport,
      {fixtures:data.fixtures.length,rows:data.rows.length,fetchedAt:data.fetchedAt,coverage:data.coverage,carriedForward:Boolean(data.carriedForward)}])):{}};}
  return {read,refresh,usable,status};
}
module.exports={CACHE_KEY,CACHE_FILE,SPORTS,selectionKey,collectPublicCatalog,marketInputs,publicPredictions,publicCandidates,validatePublicSelections,createPublicCache};
