'use strict';
const { liveState, scorePair, scoreSeries, selectionSide } = require('./liveModel');
const number = x => x === null || x === undefined || x === '' ? null : Number.isFinite(Number(x)) ? Number(x) : null;

// Availability status numbers and a live "winning" flag are not settlements.
// Numeric provider codes stay unresolved until their meaning is established.
function confirmedStatus(value) {
  if (value && typeof value === 'object') {
    for (const key of ['settlement','settlementStatus','result','status','name','value']) {
      const found = confirmedStatus(value[key]);
      if (found) return found;
    }
    return null;
  }
  const s = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g,' ').replace(/\s+/g,' ');
  if (/^(?:settled )?(?:won|win|winner|paid)$/.test(s)) return 'won';
  if (/^(?:settled )?(?:lost|loss|lose|loser)$/.test(s)) return 'lost';
  if (/^(?:settled )?(?:void|voided|push|pushed|refund|refunded)$/.test(s)) return 'push';
  if (/^(?:half won|half win|won half)$/.test(s)) return 'half_won';
  if (/^(?:half lost|half loss|lost half)$/.test(s)) return 'half_lost';
  return null;
}
function officialStatus(obj, overall = false) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = overall ? ['bookingSettlement','booking_settlement','overallSettlement','overall_settlement','settlementStatus','settlement_status','betResult','bet_result']
    : ['selectionSettlement','selection_settlement','settlement','settlementStatus','settlement_status','betResult','bet_result','result','outcomeStatus','outcome_status'];
  for (const key of [...keys,'status']) {
    const status = confirmedStatus(obj[key]);
    if (status) return status;
  }
  if (overall) for (const key of ['data','booking','betSlip','betslip','payload','result']) {
    const status = officialStatus(obj[key], true);
    if (status) return status;
  }
  return null;
}
function result(status, odds, extra = {}) {
  const price = number(odds);
  const returnMultiplier = status === 'lost' ? 0 : status === 'push' ? 1 : status === 'half_lost' ? .5
    : price != null && price > 1 ? status === 'won' ? price : status === 'half_won' ? (price+1)/2 : null : null;
  return {status,returnMultiplier,...extra};
}
function lineResult(margin, odds) { return result(margin > 1e-8 ? 'won' : margin < -1e-8 ? 'lost' : 'push', odds); }
function asianResult(margin, line, odds) {
  const scaled = Math.round(line*4);
  if (Math.abs(line*4-scaled)>1e-6) return result('pending', odds, {reason:'unsupported_line'});
  if (Math.abs(scaled)%2 !== 1) return lineResult(margin+line, odds);
  const low = Math.floor(line*2)/2, high = Math.ceil(line*2)/2;
  const parts = [lineResult(margin+low,odds),lineResult(margin+high,odds)];
  const statuses = parts.map(r=>r.status);
  if (statuses.every(s=>s==='won')) return result('won',odds);
  if (statuses.every(s=>s==='lost')) return result('lost',odds);
  if (statuses.includes('won') && statuses.includes('push')) return result('half_won',odds);
  if (statuses.includes('lost') && statuses.includes('push')) return result('half_lost',odds);
  return result('pending',odds);
}
function finalEvent(payload, eventId) {
  function visit(node, depth=0) {
    if (!node || typeof node!=='object' || depth>12) return null;
    if (String(node.eventId ?? node.event_id ?? node.id ?? '') === String(eventId)) return node;
    for (const value of Object.values(node)) {
      if (!value || typeof value!=='object') continue;
      const hit = visit(value,depth+1);
      if (hit) return hit;
    }
    return null;
  }
  return visit(payload);
}
function bookingLegs(booking) {
  if (!booking || typeof booking!=='object') return [];
  for (const key of ['outcomes','selections','bets','items']) if (Array.isArray(booking[key])) return booking[key];
  for (const key of ['data','booking','betSlip','betslip','payload']) {
    const rows = bookingLegs(booking[key]);
    if (rows.length) return rows;
  }
  return [];
}
function matchingLeg(rows, selection) {
  return rows.find(row => String(row.eventId ?? row.event_id ?? '') === String(selection.eventId) &&
    String(row.marketId ?? row.market_id ?? '') === String(selection.marketId) &&
    String(row.outcomeId ?? row.outcome_id ?? '') === String(selection.outcomeId) &&
    String(row.specifier ?? '').replace(/\s/g,'') === String(selection.specifier ?? '').replace(/\s/g,''));
}

function settleSelection(selection, event, official) {
  const odds = selection.odds, direct = officialStatus(official);
  if (direct) return result(direct,odds,{source:'SportyBet settlement'});
  const pending = reason => result('pending',odds,{reason});
  if (!event) return pending('result_unavailable');
  // Never reuse the live score saved at booking as a final score.
  const fresh = {...event,sport:selection.sport}; delete fresh.liveState;
  const s = liveState(fresh), phase = s.phase.toLowerCase();
  if (/abandoned|postponed|cancelled|canceled|interrupted/.test(phase)) return pending('official_settlement_required');
  if (!/\bft\b|finished|ended|full[- ]?time|match over|after extra|\baet\b|after penalties/.test(phase)) return pending('match_not_finished');
  const market = String(selection.marketDesc||''), t = String(selection.betType||''), d = String(selection.outcomeDesc||'').toLowerCase();
  if (/(?:1st|2nd|3rd|4th|first|second|third|fourth)\s*(?:half|quarter|period|set)|\b(?:race|first goal|last goal)\b|&/i.test(market)) return pending('unsupported_market_scope');
  let home = s.homeScore, away = s.awayScore;
  const setSport = /tennis|volleyball/i.test(selection.sport||'');
  if (/extra|overtime|penalt|\baet\b/.test(phase) || event.overtimeScore != null || event.penaltyScore != null) {
    if (!/incl.*(?:overtime|extra|penalt)/i.test(market) && !setSport) {
      const regulation = scorePair(event.regulationScore ?? event.regularTimeScore ?? event.fullTimeScore);
      if (!regulation) return pending('regulation_result_unavailable');
      home=regulation.home; away=regulation.away;
    } else if (/penalt/.test(phase) && /incl.*penalt/i.test(market) && home===away) {
      const penalties=scorePair(event.penaltyScore);
      if (!penalties || penalties.home===penalties.away) return pending('shootout_result_unavailable');
      // Shootout decides a winner; it is not added to a totals/handicap score.
      if (!/winner/i.test(market)) return pending('shootout_market_requires_settlement');
      home=penalties.home; away=penalties.away;
    }
  }
  if (/corners/i.test(market) || t.startsWith('corners_')) { home=s.homeCorners; away=s.awayCorners; }
  else if (setSport) {
    if(!/winner|correct score|total sets|set handicap|total games|games total|game handicap|total points|points total|point handicap/i.test(market)) return pending('match_metric_unavailable');
    home=s.homeSets ?? home; away=s.awaySets ?? away;
    if (/total games|games total|game handicap|total points|points total|point handicap/i.test(market)) {
      const series = scoreSeries(/point/i.test(market) ? event.pointScore ?? event.gameScore : event.gameScore);
      if (home==null || away==null || series.length!==home+away) return pending('complete_match_totals_unavailable');
      home=series.reduce((n,p)=>n+p.home,0); away=series.reduce((n,p)=>n+p.away,0);
    }
  }
  if (home==null || away==null || home<0 || away<0) return pending('final_metric_unavailable');
  const extra={source:'SportyBet final score',score:`${home}:${away}`};
  let settled;
  if (t==='gg_yes' || t==='ng_no' || /both teams.*score/i.test(market)) {
    const both=home>0&&away>0;
    settled=/^(yes|gg)$/.test(d) ? result(both?'won':'lost',odds) : /^(no|ng)$/.test(d) ? result(!both?'won':'lost',odds) : pending('unknown_outcome');
  } else if (t==='correct_score' || /correct score/i.test(market)) {
    const exact=scorePair(selection.outcomeDesc);
    settled=exact?result(home===exact.home&&away===exact.away?'won':'lost',odds):pending('unknown_outcome');
  } else if (/\b(?:over|under|total)\b/i.test(market) || /(?:^|_)over|(?:^|_)under/.test(t)) {
    const line=number(String(selection.specifier||'').match(/total\s*=\s*([+-]?\d+(?:\.\d+)?)/i)?.[1] ?? d.match(/(?:over|under)\s*([+-]?\d+(?:\.\d+)?)/i)?.[1]);
    const value=/^home\b/i.test(market)?home:/^away\b/i.test(market)?away:/^home_/.test(t)?home:/^away_/.test(t)?away:home+away;
    settled=line==null?pending('market_line_unavailable'):/\bover\b/.test(d)?asianResult(value,-line,odds):/\bunder\b/.test(d)?asianResult(-value,line,odds):pending('unknown_outcome');
  } else if (t==='dc_1x' || t==='dc_x2' || /double chance/i.test(market)) {
    const win=/1x|home or draw|home\/draw/.test(d)?home>=away:/x2|draw or away|draw\/away/.test(d)?away>=home:null;
    settled=win==null?pending('unknown_outcome'):result(win?'won':'lost',odds);
  } else if (/handicap/i.test(market) || /^ah_/.test(t)) {
    const line=number(String(selection.specifier||'').match(/hcp\s*=\s*([+-]?\d+(?:\.\d+)?)/i)?.[1]), side=selectionSide(selection);
    settled=line==null?pending('market_line_unavailable'):side==='home'?asianResult(home-away,line,odds):side==='away'?asianResult(away-home,-line,odds):pending('unknown_outcome');
  } else if (/winner|1x2|draw no bet/i.test(market) || ['home_win','away_win','draw','dnb'].includes(t)) {
    const side=selectionSide(selection), dnb=t==='dnb'||/draw no bet/i.test(market);
    // Two-way set winners cannot be inferred from an incomplete tied score.
    settled=side==='draw'?result(home===away?'won':'lost',odds):home===away&&dnb?result('push',odds):
      home===away&&setSport?pending('incomplete_set_result'):
      ['home','away'].includes(side)?result((side==='home'?home>away:away>home)?'won':'lost',odds):pending('unknown_outcome');
  } else settled=pending('unsupported_market');
  return {...settled,...extra};
}

function ticketSettlement(slip, legs, booking) {
  const top=officialStatus(booking,true);
  const counts={won:0,lost:0,push:0,half_won:0,half_lost:0,pending:0};
  for (const leg of legs) counts[leg.status in counts?leg.status:'pending']++;
  const complete=legs.length===slip.selections.length && legs.length>0 && counts.pending===0;
  let returnMultiplier=null, status='pending';
  if (top==='lost' || counts.lost>0) {status='lost';returnMultiplier=0;}
  if (complete && !counts.lost) {
    returnMultiplier=legs.every(l=>l.returnMultiplier!=null)?legs.reduce((p,l)=>p*l.returnMultiplier,1):null;
    status=returnMultiplier==null?'won':returnMultiplier>1+1e-8?'won':returnMultiplier<1-1e-8?'partial_loss':counts.push===legs.length?'push':'partial_return';
  }
  // Official overall settlement overrides stale leg classifications, but a
  // WON booking alone cannot prove a payout if void/half-settled legs are absent.
  if (top==='lost') {status='lost';returnMultiplier=0;}
  if (top==='push') {status='push';returnMultiplier=1;}
  if (top==='won') {status='won';if(!complete||counts.lost>0)returnMultiplier=null;}
  return {status,returnMultiplier,counts,totalLegs:legs.length,complete,legDetails:legs};
}
module.exports={confirmedStatus,officialStatus,finalEvent,bookingLegs,matchingLeg,settleSelection,ticketSettlement};
