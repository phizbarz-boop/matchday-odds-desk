'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const sporty=fs.readFileSync(path.join(__dirname,'../lib/sportybet.js'),'utf8');

test('team-total kinds use the subscribed Nigeria event-market API, not the separate .com fallback',()=>{
  assert.match(sporty,/TEAM_GOAL_KINDS\.includes\(kind\)/);
  assert.match(sporty,/get_football_event_markets/);
  assert.match(sporty,/params:\{event_id:fixture\.eventId\}, base:BASE/);
});

test('detailed-market matcher delegates team totals to strict side-specific selector',()=>{
  assert.match(sporty,/return isTeamTotalSelection\(row, side, under45 \? '4\.5' : '0\.5', under45 \? 'under' : 'over'\)/);
});
