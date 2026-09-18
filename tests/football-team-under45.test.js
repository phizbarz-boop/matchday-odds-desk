'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { predictMatch, summarizeH2H, blendPredictionWithH2H } = require('../lib/model');
const { buildCandidates } = require('../lib/autoPicker');
const { FOOTBALL_MARKETS } = require('../lib/sportybet');
const { isTeamTotalSelection } = require('../lib/teamGoalMarket');
const { PLANS, PRO_BET_IDS, ALL_BET_IDS, parseNaturalRequest } = require('../lib/telegramAiBot');
const root = path.join(__dirname, '..');
const kickoffUtc = new Date(Date.now() + 86400000).toISOString();
const prediction = { home:'Alpha FC', away:'Beta FC', league:'Test League', kickoffUtc,
  h:50, d:25, a:25, btts:45, o05:94, o15:80, u45:78,
  homeO05:81, awayO05:72, homeU45:96, awayU45:91 };
const row = (side, { marketDesc, line='total=4.5', outcome='Under', outcomeId='13', odds=1.06 }={}) => ({
  eventId:'991002', marketId:`sporty-${side}-total`, outcomeId, marketDesc:marketDesc || `${side==='home'?'Home':'Away'} Total`, outcomeDesc:outcome,
  specifier:line, odds, home:'Alpha FC', away:'Beta FC', kickoffUtc,
});
const candidates = (p, home, away) => buildCandidates({
  predictions:{matches:[p]},
  footballMarkets:{home_ou45:{rows:home},away_ou45:{rows:away}},
  minProbability:0,minEdge:-25,sportScope:'football',betTypes:['home_under45','away_under45'],
});

test('Under 4.5 for a team means that team scores zero through four, not total match goals', () => {
  const base = predictMatch({attack:1.7,defense:1},{attack:0.8,defense:1},1.7,1.0);
  assert.ok(base.homeUnder45 < base.awayUnder45);
  assert.ok(base.homeUnder45 >= base.under45 && base.awayUnder45 >= base.under45);
  const h2h = summarizeH2H([
    {homeTeam:'Alpha FC',awayTeam:'Beta FC',homeGoals:5,awayGoals:2,utcDate:'2026-05-10'},
    {homeTeam:'Alpha FC',awayTeam:'Beta FC',homeGoals:1,awayGoals:5,utcDate:'2026-04-10'},
  ], 'Alpha FC','Beta FC');
  assert.ok(Math.abs(h2h.homeUnder45Rate + h2h.awayUnder45Rate - 1) < 1e-9);
  const blended = blendPredictionWithH2H(base,h2h);
  assert.ok(Number.isFinite(blended.homeUnder45) && Number.isFinite(blended.awayUnder45));
});

test('SportyBet row validator rejects wrong side, line, outcome and non-full-match markets', () => {
  const valid=row('home');
  assert.equal(isTeamTotalSelection(valid,'home','4.5','under'),true);
  assert.equal(isTeamTotalSelection(row('away'),'away','4.5','under'),true);
  assert.equal(isTeamTotalSelection(valid,'away','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{line:'total=3.5'}),'home','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{line:'total=4.5',outcome:'Over',outcomeId:'12'}),'home','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{marketDesc:'1st Half Home Total'}),'home','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{marketDesc:'Home Corners Total'}),'home','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{marketDesc:'Match Total'}),'home','4.5','under'),false);
  assert.equal(isTeamTotalSelection(row('home',{line:null,outcome:'Under 4.5'}),'home','4.5','under'),true);
  assert.equal(isTeamTotalSelection(row('home',{line:null,outcome:'Under 3.5'}),'home','4.5','under'),false);
});

test('website and Telegram auto candidate engine use separate model probabilities and real betting IDs', () => {
  const c=candidates(prediction,[row('home')],[row('away',{odds:1.09})]);
  assert.deepEqual(new Set(c.map(x=>x.betType)), new Set(['home_under45','away_under45']));
  assert.equal(c.find(x=>x.betType==='home_under45').probability,96);
  assert.equal(c.find(x=>x.betType==='away_under45').probability,91);
  assert.equal(c.find(x=>x.betType==='home_under45').marketId,'sporty-home-total');
  assert.equal(c.find(x=>x.betType==='home_under45').specifier,'total=4.5');
});

test('missing team probability never silently becomes full-match Under 4.5', () => {
  const {homeU45,awayU45,...oldPrediction}=prediction;
  assert.equal(candidates(oldPrediction,[row('home')],[row('away')]).length,0);
  assert.equal(candidates(prediction,[row('away')],[row('home')]).length,0);
});

test('separate markets are wired through website, Telegram, server and subscription without changing prices', () => {
  assert.equal(FOOTBALL_MARKETS.home_ou45.marketId,null);
  assert.equal(FOOTBALL_MARKETS.away_ou45.marketId,null);
  assert.equal(FOOTBALL_MARKETS.ou45.specifier,'total=4.5');
  assert.equal(PLANS.pro.priceNgn,5000);
  for(const id of ['home_under45','away_under45']) {
    assert.ok(PRO_BET_IDS.includes(id)); assert.ok(ALL_BET_IDS.includes(id));
    assert.ok(fs.readFileSync(path.join(root,'public/index.html'),'utf8').includes(`id:'${id}'`));
    assert.ok(fs.readFileSync(path.join(root,'server.js'),'utf8').includes(`'${id}'`));
  }
  const req=parseNaturalRequest('Build football home under 4.5 and away under 4.5');
  assert.ok(req.betTypes.includes('home_under45') && req.betTypes.includes('away_under45'));
  assert.ok(!req.betTypes.includes('home_win') && !req.betTypes.includes('away_win'));
  assert.ok(!req.betTypes.includes('under45'));
  const either=parseNaturalRequest('Build football home or away under 4.5');
  assert.ok(either.betTypes.includes('home_under45') && either.betTypes.includes('away_under45'));
  assert.ok(!either.betTypes.includes('home_win') && !either.betTypes.includes('away_win'));
});
