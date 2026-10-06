'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {liveState,halfwayPlayed,lateStage,selectionWinningNow,liveSelectionEligible}=require('../lib/liveModel');
const fixture=(extra={})=>({live:true,sport:'Football',home:'Alpha',away:'Beta',marketId:'1',outcomeId:'1',
  marketDesc:'1X2',outcomeDesc:'Home',matchStatus:'H2',playedSeconds:'63:00',setScore:'2:0',...extra});

test('live eligibility proves halfway for each timed sport and excludes missing progress',()=>{
  for(const [sport,early,half,clock] of [
    ['Football','H1','H2','45:00'],['Basketball','Q2','Q3',undefined],
    ['Ice Hockey','P1','P2','30:00'],['Handball','H1','H2','30:00'],
  ]) {
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:early,playedSeconds:'10:00'})),false,sport+' early');
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:half,playedSeconds:clock})),true,sport+' halfway');
  }
  assert.equal(halfwayPlayed(fixture({matchStatus:'Live',playedSeconds:undefined})),false);
  assert.equal(halfwayPlayed(fixture({matchStatus:'FT'})),false);
  assert.equal(halfwayPlayed(fixture({banned:true})),false);
});
test('set sports require completed sets and do not guess a final set from its number',()=>{
  for(const sport of ['Tennis','Volleyball']) {
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:'S2',playedSeconds:undefined,setScore:'1:0',bestOf:3})),false);
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:'S3',playedSeconds:undefined,setScore:'1:1',bestOf:3})),true);
    assert.equal(lateStage(fixture({sport,matchStatus:'S3',playedSeconds:undefined,setScore:'1:1'})),false,'unknown format');
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:'S4',playedSeconds:undefined,setScore:'2:1'})),true);
    assert.equal(lateStage(fixture({sport,matchStatus:'S5',playedSeconds:undefined,setScore:'2:2'})),true);
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:'S1',playedSeconds:undefined,setScore:undefined,score:'20:10'})),false,'point score is not a set count');
    assert.equal(halfwayPlayed(fixture({sport,matchStatus:'S3',playedSeconds:undefined,setScore:'2:0',bestOf:3})),false,'format proves the match has finished');
  }
});
test('SportyBet match-score outcomes can prove the set format without a format field',()=>{
  const market=(desc,pairs)=>({desc,outcomes:pairs.map(score=>({desc:score}))});
  const tennis=fixture({sport:'Tennis',matchStatus:'S3',playedSeconds:undefined,setScore:'1:1',gameScore:['6:4','4:6','3:1'],marketId:'186',marketDesc:'Winner',
    markets:[market('Correct Score',['2:0','2:1','0:2','1:2'])]});
  assert.equal(liveState(tennis).bestOf,3);assert.equal(liveSelectionEligible(tennis,{quickCash:true}),true);
  assert.equal(liveState({...tennis,markets:[market('1st set - Correct Score',['2:0','0:2'])]}).bestOf,null);
  assert.equal(liveState({...tennis,markets:[market('Correct Score',['2:0'])]}).bestOf,null);
  assert.equal(liveState({...tennis,markets:[market('Correct Score',['2:0','0:2','Other'])]}).bestOf,null);
  assert.equal(liveState({...tennis,sport:'Football'}).bestOf,null);
  assert.equal(liveState({...tennis,markets:[market('Match Score',['3:0','3:1','3:2','0:3','1:3','2:3'])]}).bestOf,5);
});
test('winners, draw, double chance and DNB use the actual score and selected outcome',()=>{
  assert.equal(liveSelectionEligible(fixture()),true);
  assert.equal(liveSelectionEligible(fixture({outcomeId:'3',outcomeDesc:'Away',betType:'away_win'})),false);
  assert.equal(selectionWinningNow(fixture({outcomeId:'3',outcomeDesc:'Away',betType:'home_win'})),false,'client betType cannot change the offered side');
  assert.equal(selectionWinningNow(fixture({setScore:'1:1',outcomeId:'2',outcomeDesc:'Draw'})),true);
  assert.equal(selectionWinningNow(fixture({setScore:'1:1',marketDesc:'Draw No Bet'})),false,'a push is not a win');
  assert.equal(selectionWinningNow(fixture({setScore:'1:1',marketDesc:'Double Chance',outcomeDesc:'Home or Draw'})),true);
  assert.equal(selectionWinningNow(fixture({marketDesc:'Double Chance',outcomeDesc:'Draw or Away'})),false);
});
test('handicap selection must cover its current line, including away orientation and pushes',()=>{
  const handicap=fixture({marketId:'16',marketDesc:'Asian Handicap',outcomeDesc:'Home',specifier:'hcp=-2.5'});
  assert.equal(selectionWinningNow(handicap),false,'leading by two does not cover -2.5');
  assert.equal(selectionWinningNow({...handicap,specifier:'hcp=-1.5'}),true);
  assert.equal(selectionWinningNow({...handicap,specifier:'hcp=-2'}),false,'equal line is a push');
  assert.equal(selectionWinningNow({...handicap,outcomeDesc:'Away',specifier:'hcp=-2.5'}),true,'away +2.5 covers a two-goal deficit');
  assert.equal(selectionWinningNow({...handicap,specifier:null}),false);
});
test('totals, team goals and BTTS are evaluated against currently observed goals',()=>{
  const total=fixture({marketDesc:'Over/Under',outcomeDesc:'Over 2.5',specifier:'total=2.5'});
  assert.equal(selectionWinningNow(total),false);
  assert.equal(selectionWinningNow({...total,outcomeDesc:'Under 2.5'}),true);
  assert.equal(selectionWinningNow({...total,setScore:'2:1'}),true);
  assert.equal(selectionWinningNow({...total,setScore:'2:1',outcomeDesc:'Under 2.5'}),false);
  assert.equal(selectionWinningNow({...total,marketDesc:'Away Total',betType:'away_over05',outcomeDesc:'Over 0.5',specifier:'total=0.5'}),false);
  assert.equal(selectionWinningNow({...total,marketDesc:'Home Total',betType:'home_over05',outcomeDesc:'Over 0.5',specifier:'total=0.5'}),true);
  assert.equal(selectionWinningNow(fixture({marketDesc:'Both Teams To Score',outcomeDesc:'Yes',betType:'gg_yes'})),false);
  assert.equal(selectionWinningNow(fixture({marketDesc:'Both Teams To Score',outcomeDesc:'No',betType:'ng_no'})),true);
});
test('corner selections require corner counts and never borrow the football goal score',()=>{
  const corner=fixture({marketDesc:'Corners Over/Under',outcomeDesc:'Over 8.5',specifier:'total=8.5'});
  assert.equal(selectionWinningNow(corner),false);
  assert.equal(selectionWinningNow({...corner,cornerScore:'6:3'}),true);
  assert.equal(selectionWinningNow({...corner,cornerScore:'6:3',outcomeDesc:'Under 8.5'}),false);
});
test('set-sport winners and totals use sets, games or points for the correct market',()=>{
  const tennis=fixture({sport:'Tennis',matchStatus:'S3',playedSeconds:undefined,setScore:'1:1',bestOf:3,gameScore:['6:4','4:6','4:2'],marketId:'186',marketDesc:'Winner'});
  assert.equal(liveSelectionEligible(tennis,{quickCash:true}),true,'current deciding-set game lead');
  assert.equal(selectionWinningNow({...tennis,marketDesc:'Total games',outcomeDesc:'Over 25.5',specifier:'total=25.5'}),true);
  assert.equal(selectionWinningNow({...tennis,marketDesc:'Game Handicap',specifier:'hcp=-10'}),false);
  const volley=fixture({sport:'Volleyball',matchStatus:'S5',playedSeconds:undefined,setScore:'2:2',gameScore:['25:20','20:25','25:20','20:25','10:8'],marketDesc:'Winner',marketId:'186'});
  assert.equal(liveSelectionEligible(volley,{quickCash:true}),true);
  assert.equal(selectionWinningNow({...volley,marketDesc:'Total Sets',outcomeDesc:'Under 4.5',specifier:'total=4.5'}),false,'the fifth set already counts toward total sets');
  assert.equal(selectionWinningNow({...volley,marketDesc:'Total Sets',outcomeDesc:'Over 4.5',specifier:'total=4.5'}),true);
  assert.equal(selectionWinningNow({...volley,marketDesc:'Total points',outcomeDesc:'Over 190.5',specifier:'total=190.5'}),true);
  assert.equal(liveState(volley).homeGames,100);
  assert.equal(selectionWinningNow({...tennis,gameScore:['4:2'],marketDesc:'Total games',outcomeDesc:'Under 25.5',specifier:'total=25.5'}),false,'missing earlier sets cannot approve an under');
  assert.equal(selectionWinningNow({...tennis,gameScore:['6:4',null,'4:2'],marketDesc:'Total games',outcomeDesc:'Under 25.5',specifier:'total=25.5'}),false,'malformed earlier score excludes totals');
});
test('full-match scores do not approve quarter, half or combined selections',()=>{
  for(const marketDesc of ['1st half - Winner','4th quarter - Total','1X2 & Over/Under'])assert.equal(selectionWinningNow(fixture({marketDesc})),false);
  assert.equal(selectionWinningNow(fixture({sport:'Basketball',marketDesc:'Winner (incl. overtime)',setScore:'84:70'})),true);
});
