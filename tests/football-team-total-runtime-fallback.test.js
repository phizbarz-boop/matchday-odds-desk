'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const sporty=fs.readFileSync(path.join(__dirname,'../lib/sportybet.js'),'utf8');

test('team-total kinds use direct SportyBet per-event markets, with Parse.bot fully removed',()=>{
  assert.match(sporty,/TEAM_GOAL_KINDS\.includes\(kind\)/);
  assert.match(sporty,/fetchEventMarketsFlattened\(fixture\.eventId, fixture\)/);
  assert.doesNotMatch(sporty,/api\.parse\.bot|parseFetch\(|PARSE_API_KEY|PARSE_SCRAPER_ID/);
});

test('detailed-market matcher delegates team totals to strict side-specific selector',()=>{
  assert.match(sporty,/return isTeamTotalSelection\(row, side, under45 \? '4\.5' : '0\.5', under45 \? 'under' : 'over'\)/);
});
