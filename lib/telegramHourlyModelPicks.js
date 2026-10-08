'use strict';
const {liveSelectionEligible}=require('./liveModel');
const {bestProbabilityTicket,winningProbability}=require('./telegramNext12h');
const {selectionKey,SPORTS}=require('./sportyPublicCache');
const {normalizedSport}=require('./telegramMixedSelector');
const STATE_PREFIX='telegram:hourly-model:v1:ticket:';
const number=(value,fallback,max)=>Number.isFinite(Number(value))&&value!=null&&String(value).trim()!==''?Math.max(0,Math.min(max,Number(value))):fallback;

function hourlyModelPlans(env=process.env){
  const cap=Math.max(1,Math.floor(number(env.TELEGRAM_HOURLY_MAX_SELECTIONS,40,40)));
  return [
    {id:'live_3',label:'LIVE · 3 ODDS',liveMode:'live',targetOdds:3,minProbability:80,maxSelections:cap,sports:SPORTS},
    {id:'qc_3',label:'QC · 3 ODDS',liveMode:'quick_cash',targetOdds:3,minProbability:80,maxSelections:cap,sports:SPORTS},
    {id:'live_1000',label:'LIVE · UP TO 1,000 ODDS',liveMode:'live',targetOdds:1000,allowLowerTarget:true,minProbability:80,maxSelections:cap,sports:SPORTS},
  ];
}
function eligible(row,plan){
  return row.live===true&&plan.sports.includes(normalizedSport(row))&&row.eventId&&row.marketId&&row.outcomeId&&
    Number.isFinite(Number(row.odds))&&Number(row.odds)>1&&Number(row.probability)>=plan.minProbability&&Number(row.probability)<=100&&winningProbability(row)>0&&winningProbability(row)<=100&&
    liveSelectionEligible(row,{quickCash:plan.liveMode==='quick_cash'});
}
function selectHourlyTicket(candidates,plan){
  const options={maxSelections:plan.maxSelections};
  const result=bestProbabilityTicket(candidates,plan.targetOdds,options);
  if(result.reachedTarget||!plan.allowLowerTarget||!result.selections.length)return result;
  // Discover the highest lower total on the bounded frontier, then rank
  // combinations by model chance at that achievable total.
  const lowerTarget=result.selections.reduce((n,c)=>n*Number(c.odds),1);
  return bestProbabilityTicket(candidates,lowerTarget,options);
}
function summary(selections,plan){
  const combinedOdds=selections.reduce((n,c)=>n*Number(c.odds),1);
  return {selections,combinedOdds,targetOdds:plan.targetOdds,reachedTarget:combinedOdds+1e-9>=plan.targetOdds,
    lowerTarget:plan.allowLowerTarget&&combinedOdds+1e-9<plan.targetOdds,
    estimatedWinningProbability:selections.reduce((n,c)=>n*winningProbability(c)/100,1)*100};
}
function hourlyTicketText(plan,result,booking,{hourKey,dateKey,slotTime,runMode}){
  const header=[`${plan.liveMode==='quick_cash'?'💵':'🔴'} PLOT207 SPORTS · HOURLY ${plan.label}`,
    `${dateKey} · ${runMode==='manual'?'MANUAL':slotTime||hourKey.slice(11)+':05'} WAT`,
    `SportyBet code: ${booking.shareCode}`,...(booking.shareURL?[booking.shareURL]:[]),
    `Target: ${plan.targetOdds.toLocaleString('en-US')} · Actual odds: ${result.combinedOdds.toFixed(2)} · ${result.selections.length} games`,
    `Estimated combined chance: ${result.estimatedWinningProbability.toPrecision(3)}% (independence assumption)`,
    `Ranked by combined model chance · minimum leg probability: ${plan.minProbability}%`,
    ...(result.lowerTarget?['Lower available target used; 1,000 odds was not reachable']:[]),
    plan.liveMode==='quick_cash'?'Late live matches · selection currently winning':'At least halfway · selection currently winning'];
  const chunks=[];let text=header.join('\n')+'\n';
  for(const [i,c] of result.selections.entries()){
    const line=`\n${i+1}. ${c.home} vs ${c.away}\n${c.sport} · ${c.outcomeDesc} · ${c.marketDesc} @ ${Number(c.odds).toFixed(2)} · Model ${Number(c.probability).toFixed(1)}%`;
    if(text.length+line.length>3800){chunks.push(text);text=header[0]+' · continued\nSportyBet code: '+booking.shareCode+'\n';}
    text+=line;
  }
  if(result.selections.some(c=>c.fullWinProbability==null&&/push|half|equivalent/i.test(c.settlementNote||'')))text+='\nPush/half-settlement markets use fair-price probability estimates.';
  const footer='\n\nAdded to 🎟 Today’s Codes.';
  if(text.length+footer.length>3800){chunks.push(text);text=header[0]+'\nSportyBet code: '+booking.shareCode;}
  chunks.push(text+footer);return chunks;
}

// The surrounding slot job owns a renewable Redis lease. Persist a known code
// before tracking/sending; reserve uncertain booking and delivery outcomes so
// retries cannot create a second code or resend a possibly delivered ticket.
async function runHourlyModelPicks(deps,context){
  const {redis,slotKey,dateKey,signal,shouldAbort=()=>false,assertLease=async()=>{}}=context;
  if(!redis)throw Object.assign(Error('REDIS_URL is required for hourly Telegram picks'),{code:'TELEGRAM_REDIS_REQUIRED'});
  const check=()=>{if(signal?.aborted||shouldAbort())throw Object.assign(Error('Hourly live picks cancelled'),{code:'TELEGRAM_CANCELLED_BEFORE_POST'});};
  const guard=async()=>{check();await assertLease();check();};
  const plans=hourlyModelPlans(deps.env),results=[];
  let poolPromise;
  const readPool=async()=>{poolPromise||=Promise.resolve().then(()=>deps.loadPool({signal}));const pool=await poolPromise;check();return pool;};
  for(const plan of plans){
    check();const key=STATE_PREFIX+slotKey+':'+plan.id;
    const raw=await redis.get(key);let prior=raw?JSON.parse(raw):null;
    const state=async(status,extra={})=>{
      const value={id:plan.id,status,updatedAt:deps.now().toISOString(),...extra};
      await redis.set(key,JSON.stringify(value),{EX:172800});prior=value;return value;
    };
    if(prior&&['completed','posting','delivery_unknown','booking_started','booking_unknown','no_eligible_games'].includes(prior.status)){
      results.push({id:plan.id,label:plan.label,skipped:true,sent:false,reason:prior.reason||prior.status,
        ...(prior.booking?.shareCode?{shareCode:prior.booking.shareCode}:{}),
        ...(['posting','delivery_unknown'].includes(prior.status)?{deliveryUnknown:true}:{}),
        ...(['booking_started','booking_unknown'].includes(prior.status)?{bookingOutcomeUnknown:true}:{})});continue;
    }
    let booking=prior?.status==='prepared'?prior.booking:null,prepared=Boolean(booking),bookingStarted=false,posting=false,delivered=false;
    const ticketId=`hourly-model:${slotKey}:${plan.id}`;
    let selections=prior?.selections||[],result;
    try{
      if(!booking){
        const board=await readPool();
        const candidates=board.candidates.filter(c=>eligible(c,plan)).map(c=>({...c,quickCash:plan.liveMode==='quick_cash'}));
        if(!candidates.length){
          const sourceErrors={...board.diagnostics?.sourceErrors,...board.diagnostics?.liveDiagnostics?.errors};
          if(Object.keys(sourceErrors).length)throw Object.assign(Error('Current public SportyBet live reads failed'),{code:'SPORTYBET_SOURCE_UNAVAILABLE',diagnostics:{sourceErrors}});
          await state('no_eligible_games',{reason:'no_eligible_live_games'});
          results.push({id:plan.id,label:plan.label,skipped:true,sent:false,reason:'no_eligible_live_games'});continue;
        }
        const selected=selectHourlyTicket(candidates,plan);check();
        if(!selected.reachedTarget||!selected.selections.length){
          await state('no_eligible_games',{reason:'target_unreachable',candidateCount:candidates.length});
          results.push({id:plan.id,label:plan.label,skipped:true,sent:false,reason:'target_unreachable',candidateCount:candidates.length});continue;
        }
        selections=selected.selections;
      }
      // This validation rebuilds probabilities from an independent current
      // live read, rather than attaching earlier probabilities to new prices.
      const current=await deps.validate(selections,plan,{signal});check();
      if(!booking&&Array.isArray(current.candidates)){
        const fresh=selectHourlyTicket(current.candidates.filter(c=>eligible(c,plan)).map(c=>({...c,quickCash:plan.liveMode==='quick_cash'})),plan);
        selections=fresh.reachedTarget?fresh.selections:[];
      }
      const offered=new Map((current.candidates||current.valid).map(c=>[selectionKey(c)+'|'+c.betType,{...c,quickCash:plan.liveMode==='quick_cash'}]));
      const originalCount=selections.length;
      selections=selections.map(c=>offered.get(selectionKey(c)+'|'+c.betType)).filter(c=>c&&eligible(c,plan));
      result=summary(selections,plan);
      if(!selections.length||(booking&&selections.length!==originalCount)||new Set(selections.map(c=>String(c.eventId))).size!==selections.length||selections.length>plan.maxSelections||(!result.reachedTarget&&!plan.allowLowerTarget)){
        await state('no_eligible_games',{reason:'live_markets_changed_or_target_not_reached',...(booking?{booking}: {})});
        results.push({id:plan.id,label:plan.label,sent:false,skipped:true,reason:'live_markets_changed_or_target_not_reached'});continue;
      }
      if(!booking){
        await deps.assertBookingReady();await guard();
        await state('booking_started');await guard();bookingStarted=true;
        booking=await deps.book(selections.map(c=>({eventId:c.eventId,marketId:c.marketId,outcomeId:c.outcomeId,...(c.specifier?{specifier:c.specifier}:{})})));
        if(!booking?.shareCode||booking.unavailableOutcomes?.length)throw Object.assign(Error('SportyBet did not return a complete hourly ticket'),{code:'SPORTYBET_BOOKING_INCOMPLETE'});
        await state('prepared',{booking,selections});prepared=true;
      }
      check();
      await deps.track(redis,{ticketId,label:plan.label,targetOdds:plan.targetOdds,combinedOdds:result.combinedOdds,
        selections,sportScope:'all',shareCode:booking.shareCode,shareURL:booking.shareURL,
        liveMode:plan.liveMode,minProbability:plan.minProbability,hourKey:context.hourKey||slotKey,delivery:'prepared'});
      await deps.saveCode(redis,dateKey,slotKey,plan,booking,result,context);await guard();
      await state('posting',{booking,selections});posting=true;
      for(const text of hourlyTicketText(plan,result,booking,context)){await guard();await deps.send(text,{signal});}
      delivered=true;
      await deps.updateTrack(redis,ticketId,{delivery:'posted',postedAt:deps.now().toISOString()});
      await state('completed',{booking,selections});
      results.push({id:plan.id,label:plan.label,sent:true,shareCode:booking.shareCode,combinedOdds:result.combinedOdds,
        selections:selections.length,estimatedWinningProbability:result.estimatedWinningProbability,minProbability:plan.minProbability,lowerTarget:Boolean(result.lowerTarget)});
    }catch(error){
      const unknownBooking=Boolean(bookingStarted&&!prepared&&(booking?.shareCode||error.bookingOutcomeUnknown));
      // A prepared code remains recoverable after a tracking/storage failure.
      // A POST with an uncertain result stays reserved; it is never re-booked.
      if(posting){
        await deps.updateTrack(redis,ticketId,{delivery:delivered?'posted':'unknown',...(delivered?{postedAt:deps.now().toISOString()}: {})}).catch(()=>{});
        await state(delivered?'completed':'delivery_unknown',{booking,selections,reason:delivered?'completed':'telegram_delivery_unknown'}).catch(()=>{});
      }else if(unknownBooking){
        await state('booking_unknown',{...(booking?.shareCode?{booking,selections}:{}),reason:'booking_outcome_unknown'}).catch(()=>{});
      }else if(!prepared){
        await state('failed_before_booking',{reason:error.code||'job_failed_before_post'}).catch(()=>{});
      }
      results.push({id:plan.id,label:plan.label,sent:delivered,error:String(error.message).slice(0,200),code:error.code||null,
        retryable:!posting&&!unknownBooking,deliveryUnknown:posting&&!delivered,bookingOutcomeUnknown:unknownBooking,
        reason:unknownBooking?'booking_outcome_unknown':posting&&!delivered?'telegram_delivery_unknown':error.code||'job_failed_before_post',
        ...(error.diagnostics?{diagnostics:error.diagnostics}:{})});
      if(signal?.aborted||shouldAbort())throw error;
    }
  }
  const omitted=results.filter(r=>r.reason&&['no_eligible_live_games','target_unreachable','live_markets_changed_or_target_not_reached'].includes(r.reason));
  let noticeUnknown=false;
  if(omitted.length){
    await guard();
    const noticeKey=`telegram:hourly-model:v1:notice:${slotKey}`;
    if(await redis.set(noticeKey,'posting',{NX:true,EX:172800})==='OK'){
      try{
        await deps.send(`PLOT207 SPORTS · HOURLY CHECK · ${dateKey} ${context.slotTime||'MANUAL'} WAT\n`+
          omitted.map(r=>`${r.label}: ${r.reason==='no_eligible_live_games'?'No ongoing games met the model/stage rules':r.reason==='target_unreachable'?'Available qualifying games could not reach 3 odds':'Markets changed before booking; no valid ticket'}`).join('\n'),{signal});
        await redis.set(noticeKey,'completed',{EX:172800});
      }catch{noticeUnknown=true;}
    }
  }
  return {sent:results.some(r=>r.sent),ticketsSent:results.filter(r=>r.sent).length,plans,results,
    retryable:results.some(r=>r.retryable),...(noticeUnknown?{noticeDeliveryUnknown:true}:{}),
    ...(omitted.length===plans.length?{reason:'no_eligible_hourly_target_tickets'}:{})};
}
module.exports={STATE_PREFIX,hourlyModelPlans,eligible,selectHourlyTicket,summary,hourlyTicketText,runHourlyModelPicks};
