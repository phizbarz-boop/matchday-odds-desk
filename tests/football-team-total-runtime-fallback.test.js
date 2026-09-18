'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const sporty=fs.readFileSync(path.join(__dirname,'../lib/sportybet.js'),'utf8');

test('team-total kinds are eligible for full-event fallback',()=>{
  assert.match(sporty,/\['home_ou05', 'away_ou05', 'home_ou45', 'away_ou45'\]\.includes\(kind\)/);
  assert.match(sporty,/getDetailedFootballMarket\(kind, \{ hours, maxPages \}\)/);
});

test('detailed-market matcher delegates team totals to strict side-specific selector',()=>{
  assert.match(sporty,/return isTeamTotalSelection\(row, side, under45 \? '4\.5' : '0\.5', under45 \? 'under' : 'over'\)/);
});
