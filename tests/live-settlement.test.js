'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {confirmedStatus,settleSelection,ticketSettlement,matchingLeg}=require('../lib/liveSettlement');
const base={sport:'Football',home:'Alpha',away:'Beta',marketId:'1',outcomeId:'1',outcomeDesc:'Home',marketDesc:'1X2',betType:'home_win',odds:1.8};
const final=(home,away,extra={})=>({matchStatus:'FT',setScore:`${home}:${away}`,...extra});
test('availability codes and live winning flags cannot count as settled wins',()=>{
  for(const v of [0,1,2,3,'winning','losing','live'])assert.equal(confirmedStatus(v),null);
  assert.equal(settleSelection(base,{matchStatus:'H2',setScore:'2:0'},{isWinning:true,status:0}).status,'pending');
  assert.equal(confirmedStatus({settlement:{status:'HALF_WON'}}),'half_won');
});
test('final winner, draw, double chance and DNB settle against the actual outcome',()=>{
  assert.equal(settleSelection(base,final(2,0)).status,'won');
  assert.equal(settleSelection({...base,outcomeDesc:'Away'},final(2,0)).status,'lost');
  assert.equal(settleSelection({...base,outcomeId:'2',outcomeDesc:'Draw',betType:'draw'},final(0,0)).status,'won');
  assert.equal(settleSelection({...base,marketDesc:'Double Chance',outcomeDesc:'Home or Draw',betType:'dc_1x'},final(0,0)).status,'won');
  assert.equal(settleSelection({...base,marketDesc:'Draw No Bet',betType:'dnb'},final(0,0)).returnMultiplier,1);
});
test('handicap quarter-lines pay half-win/half-loss correctly with home-oriented specifiers',()=>{
  const row={...base,marketDesc:'Asian Handicap',betType:'ah_plus025',specifier:'hcp=0.25'};
  assert.deepEqual([settleSelection(row,final(0,0)).status,settleSelection(row,final(0,0)).returnMultiplier],['half_won',1.4]);
  assert.equal(settleSelection({...row,specifier:'hcp=-0.25'},final(0,0)).returnMultiplier,.5);
  assert.equal(settleSelection({...row,outcomeDesc:'Away',outcomeId:'3'},final(0,0)).returnMultiplier,.5);
  assert.equal(settleSelection({...row,specifier:'hcp=1.5'},final(0,1)).status,'won');
});
test('totals push at integer lines and use actual team totals and final corners',()=>{
  const row={...base,marketDesc:'Over/Under',betType:'over15',outcomeDesc:'Over 2',specifier:'total=2'};
  assert.equal(settleSelection(row,final(1,1)).returnMultiplier,1);
  assert.equal(settleSelection({...row,outcomeDesc:'Over 2.25',specifier:'total=2.25'},final(1,1)).returnMultiplier,.5);
  assert.equal(settleSelection({...row,marketDesc:'Home Total Goals',betType:'home_over05',outcomeDesc:'Over 0.5',specifier:'total=0.5'},final(0,2)).status,'lost');
  const corner={...row,marketDesc:'Total Corners Over/Under',betType:'corners_over',outcomeDesc:'Over 8.5',specifier:'total=8.5'};
  assert.equal(settleSelection(corner,final(2,0)).status,'pending');
  assert.equal(settleSelection(corner,final(2,0,{cornerScore:'6:3'})).status,'won');
});
test('BTTS and correct score use final goals',()=>{
  assert.equal(settleSelection({...base,betType:'gg_yes',marketDesc:'Both Teams To Score',outcomeDesc:'Yes'},final(2,1)).status,'won');
  assert.equal(settleSelection({...base,betType:'correct_score',marketDesc:'Correct Score',outcomeDesc:'2:1'},final(2,1)).status,'won');
});
test('tennis totals require a complete final series while sets use the final set score',()=>{
  const row={...base,sport:'Tennis',marketDesc:'Total Games',outcomeDesc:'Over 25.5',specifier:'total=25.5',betType:'tennis_over'};
  const event=final(2,1,{gameScore:['6:4','4:6','6:2']});
  assert.equal(settleSelection(row,event).status,'won');
  assert.equal(settleSelection(row,final(2,1,{gameScore:['6:2']})).status,'pending');
  assert.equal(settleSelection({...row,sport:'Volleyball',marketDesc:'Total Sets',outcomeDesc:'Under 4.5',specifier:'total=4.5'},final(3,2)).status,'lost');
});
test('regulation markets require regulation scores when a final includes extra time',()=>{
  const extra=final(2,1,{matchStatus:'AET'});
  assert.equal(settleSelection(base,extra).status,'pending');
  assert.equal(settleSelection(base,{...extra,regulationScore:'1:1'}).status,'lost');
  assert.equal(settleSelection({...base,sport:'Ice Hockey',marketDesc:'Winner (incl. overtime)'},extra).status,'won');
});
test('cancelled games and period markets wait for official settlement',()=>{
  assert.equal(settleSelection(base,{matchStatus:'cancelled',setScore:'0:0'}).status,'pending');
  assert.equal(settleSelection({...base,marketDesc:'1st Half 1X2'},final(2,0)).status,'pending');
  assert.equal(settleSelection(base,null,{settlementStatus:'VOID'}).returnMultiplier,1);
});
test('void legs reduce an accumulator payout instead of multiplying by their original odds',()=>{
  const rows=[settleSelection(base,final(2,0)),settleSelection({...base,betType:'dnb',marketDesc:'Draw No Bet',odds:2},final(0,0))];
  const result=ticketSettlement({selections:[base,base]},rows,null);
  assert.equal(result.status,'won');assert.equal(result.returnMultiplier,1.8);
});
test('an authoritative overall win does not invent a payout from unknown or stale legs',()=>{
  const detail=ticketSettlement({selections:[base]},[{status:'lost',returnMultiplier:0}],{bookingSettlement:'WON'});
  assert.equal(detail.status,'won');assert.equal(detail.returnMultiplier,null);
  const unknown=ticketSettlement({selections:[base]},[{status:'pending',returnMultiplier:null}],{bookingSettlement:'WON'});
  assert.equal(unknown.status,'won');assert.equal(unknown.returnMultiplier,null);
});
test('a single confirmed lost leg establishes zero return while other legs stay pending',()=>{
  const result=ticketSettlement({selections:[base,base]},[{status:'lost',returnMultiplier:0},{status:'pending',returnMultiplier:null}],null);
  assert.equal(result.status,'lost');assert.equal(result.returnMultiplier,0);assert.equal(result.complete,false);
});
test('a partial settlement at break-even is distinct from an all-void ticket',()=>{
  const result=ticketSettlement({selections:[base,base]},[{status:'won',returnMultiplier:2},{status:'half_lost',returnMultiplier:.5}],null);
  assert.equal(result.status,'partial_return');assert.equal(result.returnMultiplier,1);
});
test('official outcome matching includes the exact market line',()=>{
  const s={eventId:'e',marketId:'18',outcomeId:'12',specifier:'total=2.5'};
  assert.equal(matchingLeg([{...s,specifier:'total=1.5',settlement:'WON'}],s),undefined);
  assert.equal(matchingLeg([{...s,settlement:'LOST'}],s).settlement,'LOST');
});
