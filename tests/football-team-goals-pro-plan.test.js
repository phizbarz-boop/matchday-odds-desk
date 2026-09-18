'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { predictMatch, blendPredictionWithH2H, summarizeH2H } = require('../lib/model');
const { buildCandidates } = require('../lib/autoPicker');
const { FOOTBALL_MARKETS } = require('../lib/sportybet');
const { PLANS, PRO_BET_IDS, FREE_BET_IDS, ALL_BET_IDS, plansText, planKeyboard, parseNaturalRequest } = require('../lib/telegramAiBot');

const kickoffUtc = new Date(Date.now() + 86400000).toISOString();
const prediction = { home:'Home FC', away:'Away FC', league:'Test League', kickoffUtc,
  h:50,d:25,a:25,btts:45,o05:92,o15:77,u45:88,homeO05:83,awayO05:61 };
const marketRow = (marketDesc, side, odds = 1.35, specifier = 'total=0.5') => ({
  eventId:'112233',home:'Home FC',away:'Away FC',kickoffUtc,marketDesc,
  marketId:side==='home'?'real-home-market':'real-away-market',outcomeId:'12',
  outcomeDesc:'Over',specifier,odds,
});
const pool = (p, homeRows, awayRows, betTypes = ['home_over05','away_over05','under45']) => buildCandidates({
  predictions:{matches:[p]},footballMarkets:{home_ou05:{rows:homeRows},away_ou05:{rows:awayRows},ou45:{rows:[{...marketRow('Over/Under','home',1.30,'total=4.5'),marketId:'18',outcomeId:'13',outcomeDesc:'Under'}]}},
  minProbability:0,minEdge:-25,sportScope:'football',betTypes,
});

test('team over 0.5 model is distinct from match over 0.5 and has direction-specific H2H', () => {
  const base = predictMatch({attack:1.5,defense:1},{attack:0.7,defense:1},1.35,1.35);
  assert.ok(base.homeOver05 > base.awayOver05);
  assert.ok(base.over05 >= base.homeOver05 && base.over05 >= base.awayOver05);
  const history = summarizeH2H([{homeTeam:'Home FC',awayTeam:'Away FC',homeGoals:2,awayGoals:0,utcDate:'2026-01-01'}],'Home FC','Away FC');
  assert.equal(history.homeOver05Rate,1);
  assert.equal(history.awayOver05Rate,0);
  const blended=blendPredictionWithH2H(base,history);
  assert.ok(blended.homeOver05>0 && blended.awayOver05>=0);
});

test('website/Telegram Auto candidate engine keeps real IDs, separate team probability and existing Under 4.5', () => {
  const found = pool(prediction,[marketRow('Home Team Total Goals','home')],[marketRow('Away Total','away',1.5)]);
  assert.deepEqual(new Set(found.map(x=>x.betType)), new Set(['home_over05','away_over05','under45']));
  const home=found.find(x=>x.betType==='home_over05');
  const away=found.find(x=>x.betType==='away_over05');
  assert.equal(home.probability,83);
  assert.equal(away.probability,61);
  assert.equal(home.marketId,'real-home-market');
  assert.equal(away.marketId,'real-away-market');
  assert.equal(home.specifier,'total=0.5');
});

test('wrong-side, corner and half-time rows are not mislabelled as team goals', () => {
  const invalid=[marketRow('Away Total','home'),marketRow('1st Half Home Total','home'),marketRow('Home Total Corners','home')];
  const found=pool(prediction,invalid,[],['home_over05']);
  assert.equal(found.length,0);
});

test('old saved predictions missing per-team goal probabilities cannot use new markets', () => {
  const {homeO05,awayO05,...old} = prediction;
  const found=pool(old,[marketRow('Home Total','home')],[marketRow('Away Total','away')],['home_over05','away_over05']);
  assert.equal(found.length,0);
});

test('bookmaker team markets do not hardcode outcome identifiers', () => {
  assert.equal(FOOTBALL_MARKETS.home_ou05.marketId,null);
  assert.equal(FOOTBALL_MARKETS.away_ou05.marketId,null);
  assert.equal(FOOTBALL_MARKETS.ou45.specifier,'total=4.5');
});

test('Pro is priced consistently at ₦5,000; Free remains restricted; Elite unchanged', () => {
  assert.equal(PLANS.pro.priceNgn,5000);
  assert.equal(PLANS.elite.priceNgn,20000);
  assert.equal(PLANS.pro.dailyTickets,5);
  assert.match(plansText(),/PRO — ₦5,000\/month/);
  assert.match(planKeyboard().inline_keyboard[0][0].text,/₦5,000/);
  assert.ok(PRO_BET_IDS.includes('home_over05') && PRO_BET_IDS.includes('away_over05') && PRO_BET_IDS.includes('under45'));
  assert.ok(ALL_BET_IDS.includes('home_over05') && ALL_BET_IDS.includes('away_over05'));
  assert.ok(!FREE_BET_IDS.includes('home_over05'));
});

test('Telegram plain-language request recognizes team goals instead of accidental match wins', () => {
  const request = parseNaturalRequest('Build 10 odds football home over 0.5 and away over 0.5 under 4.5');
  assert.ok(request.betTypes.includes('home_over05'));
  assert.ok(request.betTypes.includes('away_over05'));
  assert.ok(request.betTypes.includes('under45'));
  assert.ok(!request.betTypes.includes('home_win') && !request.betTypes.includes('away_win'));
});

test('web market tabs, betting type checkboxes, server endpoint, Telegram auto targets wired', () => {
  const ui=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
  for(const kind of ['home_over05','away_over05']){
    assert.ok(ui.includes(`id:'${kind}'`));
    assert.ok(server.includes(`'${kind}'`));
    assert.ok(server.includes(`'${kind==='home_over05'?'home_ou05':'away_ou05'}', 'football', autoMarketOptions`));
  }
  assert.match(ui,/id:'under45',label:'Under 4\.5 Goals'/);
  assert.match(server,/const TELEGRAM_FALLBACK_BET_TYPES = \[[\s\S]*?'home_over05', 'away_over05'/);
});
