'use strict';
const crypto = require('node:crypto');
const { quickCashConfig } = require('./telegramQuickCash');
const { liveSelectionEligible } = require('./liveModel');
const { normalizedSport } = require('./telegramMixedSelector');

const ALL_SPORTS = ['football','basketball','hockey','handball','volleyball','tennis'];
function hourlyPlans(env = process.env) {
  const qc = quickCashConfig(env);
  const plan = (id, label, sports) => ({ ...qc, id, label, sports });
  return [
    plan('qc_hockey', 'QC ICE HOCKEY', ['hockey']),
    plan('qc_basketball', 'QC BASKETBALL', ['basketball']),
    plan('qc_handball_volleyball', 'QC HANDBALL + VOLLEYBALL', ['handball','volleyball']),
    plan('qc_football', 'QC FOOTBALL', ['football']),
    { ...qc, id:'live_85', label:'LIVE ALL SPORTS 85%', sports:ALL_SPORTS,
      liveMode:'live', minProbability:85,
      targetOdds:Math.max(1.05, Math.min(100000, Number(env.TELEGRAM_LIVE_TARGET_ODDS) || 2)),
      maxSelections:Math.max(1, Math.min(40, Number(env.TELEGRAM_LIVE_MAX_SELECTIONS) || 15)) },
  ];
}

// Individual ticket locks let a partial batch retry unsent plans while keeping
// delivered/ambiguous plans protected from duplicate Telegram posts.
async function runHourlyPicks(deps, { redis, hourKey, dateKey, onPostingStart, shouldAbort }) {
  const check = () => {
    if (shouldAbort()) throw Object.assign(new Error('Hourly picks cancelled before posting'), {code:'TELEGRAM_CANCELLED_BEFORE_POST'});
  };
  check();
  await deps.assertSession();
  const prepared = await deps.loadPool();
  check();
  const plans = hourlyPlans(deps.env), results = [];
  for (const plan of plans) {
    check();
    const lockKey = `telegram:hourly-pick:once:${hourKey}:${plan.id}`;
    const statusKey = `telegram:hourly-pick:status:${hourKey}:${plan.id}`;
    const token = crypto.randomUUID();
    if (await redis.set(lockKey, token, {NX:true, EX:172800}) !== 'OK') {
      results.push({id:plan.id,label:plan.label,sent:false,skipped:true,reason:'already_processed_this_hour'});
      continue;
    }
    let posting = false, delivered = false, tracked;
    const state = (status, extra={}) => redis.set(statusKey, JSON.stringify({status,hourKey,planId:plan.id,...extra}), {EX:172800});
    try {
      await state('preparing');
      const pool = prepared.candidates.filter(c => c.live === true && plan.sports.includes(normalizedSport(c)) &&
        Number(c.probability) >= plan.minProbability && liveSelectionEligible(c,{quickCash:plan.liveMode === 'quick_cash'}))
        .map(c => ({...c,quickCash:plan.liveMode === 'quick_cash'}));
      if (!pool.length) {
        const errors = {...prepared.diagnostics?.sourceErrors,...prepared.diagnostics?.liveDiagnostics?.errors};
        if (Object.keys(errors).some(key => plan.sports.some(sport => key.toLowerCase().includes(sport)))) {
          throw new Error('Current SportyBet reads failed for '+plan.label);
        }
        await state('no_eligible_games');
        results.push({id:plan.id,label:plan.label,sent:false,skipped:true,reason:'no_eligible_live_games'});
        continue;
      }
      const selected = deps.select(pool, plan);
      const current = await deps.validate(selected.selections, plan);
      check();
      const valid = current.valid.filter(c => Number(c.probability) >= plan.minProbability &&
        plan.sports.includes(normalizedSport(c)) && liveSelectionEligible(c,{quickCash:plan.liveMode === 'quick_cash'}));
      if (!valid.length) {
        await state('no_eligible_games');
        results.push({id:plan.id,label:plan.label,sent:false,skipped:true,reason:'live_selections_changed_before_booking'});
        continue;
      }
      const result = deps.combine(valid, plan.targetOdds, pool.length);
      const booking = await deps.book(valid.map(s => ({eventId:s.eventId,marketId:s.marketId,outcomeId:s.outcomeId,
        ...(s.specifier ? {specifier:s.specifier} : {})})));
      if (!booking?.shareCode || booking.unavailableOutcomes?.length) throw new Error('SportyBet did not return a complete current '+plan.label+' booking');
      check();
      const ticketId = `${hourKey}:${plan.id}`;
      tracked = await deps.track(redis, {ticketId,label:plan.label,shareCode:booking.shareCode,shareURL:booking.shareURL,
        targetOdds:plan.label,combinedOdds:result.combinedOdds,sportScope:plan.sports.join('+'),selections:valid,
        hourKey,liveMode:plan.liveMode,minProbability:plan.minProbability,delivery:'prepared'});
      await deps.saveCode(redis, dateKey, hourKey, booking, result, plan);
      check();
      await onPostingStart();
      await state('posting', {shareCode:booking.shareCode});
      posting = true;
      const lines = [`${plan.liveMode === 'quick_cash' ? '💵' : '🔴'} PLOT207 SPORTS • ${plan.label}`,
        `${dateKey} · ${hourKey.slice(11)}:00 WAT`, `Minimum probability: ${plan.minProbability}%`,
        plan.liveMode === 'quick_cash' ? 'Late live matches · selection currently winning' : 'At least halfway · selection currently winning',
        `Games: ${valid.length} · Combined odds: ${result.combinedOdds.toFixed(2)}`, ''];
      valid.forEach((s,i) => lines.push(`${i+1}. ${s.home} vs ${s.away}\n   ${s.outcomeDesc} — ${s.marketDesc} @ ${Number(s.odds).toFixed(2)} · ${Number(s.probability).toFixed(1)}%`));
      lines.push('', `SportyBet code: ${booking.shareCode}`, ...(booking.shareURL ? [booking.shareURL] : []), 'Added to 🎟 Today’s Codes.');
      await deps.send(lines.join('\n'));
      delivered = true;
      await deps.updateTrack(redis, ticketId, {delivery:'posted',postedAt:new Date().toISOString()});
      await state('completed', {shareCode:booking.shareCode});
      results.push({id:plan.id,label:plan.label,sent:true,shareCode:booking.shareCode,liveMode:plan.liveMode,
        minProbability:plan.minProbability,combinedOdds:result.combinedOdds,selections:valid.length,reachedTarget:result.reachedTarget});
    } catch (err) {
      if (posting && tracked) await deps.updateTrack(redis, tracked.ticketId, {delivery:delivered?'posted':'unknown',
        ...(delivered?{postedAt:new Date().toISOString()}:{}),lastDeliveryError:String(err.message).slice(0,200)}).catch(()=>{});
      await state(posting ? 'partial_or_unknown' : 'failed_before_post', {detail:String(err.message).slice(0,200)}).catch(()=>{});
      if (!posting) await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end', {keys:[lockKey],arguments:[token]});
      results.push({id:plan.id,label:plan.label,sent:delivered,error:String(err.message).slice(0,200),deliveryUnknown:posting&&!delivered});
      if (shouldAbort()) throw err;
    }
  }
  return {sent:results.some(r=>r.sent),ticketsSent:results.filter(r=>r.sent).length,plans,results,
    retryable:results.some(r=>r.error),skipped:results.every(r=>r.skipped),
    ...(results.every(r=>r.reason === 'no_eligible_live_games') ? {reason:'no_eligible_live_games'} : {})};
}
module.exports = { hourlyPlans, runHourlyPicks };
