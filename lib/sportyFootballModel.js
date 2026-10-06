'use strict';

const fs = require('fs');
const path = require('path');
const { scoreMatrix, outcomeProbs } = require('./model');
const { sanitizeStats } = require('./sportyFootballStats');
const STATS_KEY = 'sportybet:football:statistics:v1';
const STATS_FILE = path.join(__dirname, '..', 'data', 'sporty-football-statistics.json');
const MODEL_VERSION = 'sportybet-football-v1';
const pct = p => Math.round(p * 1000) / 10;

function selectionKey(r) { return [r.eventId,r.marketId,r.specifier || '',r.outcomeId].join('|'); }
function totalLine(r) {
  const m = String(r.specifier || '').match(/(?:^|[|;&])total\s*=\s*(\d+(?:\.\d+)?)/i) ||
    String(r.outcomeDesc || '').match(/(?:over|under)\s+(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}
function isFullMatchCorners(r) {
  const name = String(r.marketDesc || '').toLowerCase();
  return /corner/.test(name) && /over.?under|\bo\/u\b|total/.test(name) &&
    !/half|\b1h\b|\b2h\b|team|home|away|handicap|race|first|last|minute|extra/.test(name);
}

// A complete, mutually exclusive price set is mandatory. Incomplete pairs
// cannot be normalized to 100%, and different lines/events never share a group.
function noVigProbabilities(rows, kind) {
  const groups = new Map(), out = new Map();
  for (const r of rows || []) {
    if (!r.eventId || !r.marketId || !r.outcomeId || !(Number(r.odds) > 1)) continue;
    if (kind === 'corners' && !isFullMatchCorners(r)) continue;
    const line = totalLine(r);
    const key = [r.eventId,r.marketId,r.specifier || '',line ?? '',!!r.live].join('|');
    if (!groups.has(key)) groups.set(key,new Map());
    groups.get(key).set(String(r.outcomeId),r);
  }
  for (const group of groups.values()) {
    const g = [...group.values()];
    const desc = r => String(r.outcomeDesc || '').toLowerCase().trim();
    let valid = false;
    if (kind === '1x2') valid = g.length === 3 && ['1','2','3'].every(id => group.has(id));
    else if (kind === 'gg') valid = g.length === 2 && g.some(r => /^(yes|gg)$/.test(desc(r))) && g.some(r => /^(no|ng)$/.test(desc(r)));
    else if (kind === 'dnb' || kind === 'ah') valid = g.length === 2 && g.some(r => /\bhome\b/.test(desc(r)) || desc(r) === String(r.home).toLowerCase()) && g.some(r => /\baway\b/.test(desc(r)) || desc(r) === String(r.away).toLowerCase());
    else valid = g.length === 2 && g.some(r => /\bover\b/.test(desc(r)) || String(r.outcomeId) === '12') && g.some(r => /\bunder\b/.test(desc(r)) || String(r.outcomeId) === '13') && lineIsHalf(totalLine(g[0]));
    if (!valid) continue;
    const sum = g.reduce((n,r) => n + 1 / Number(r.odds),0);
    for (const r of g) out.set(selectionKey(r), 100 / Number(r.odds) / sum);
  }
  return out;
}
function lineIsHalf(line) { return Number.isFinite(line) && Math.abs(line % 1 - 0.5) < 0.001; }

function modelFromStats(fixture, input) {
  const s = sanitizeStats(input);
  if (!s || s.eventId !== String(fixture.eventId) || s.home !== fixture.home || s.away !== fixture.away) return null;
  const maxAge = Math.max(3600, Number(process.env.SPORTYBET_STATS_MAX_AGE_SECONDS || 172800));
  if (Date.now() - Date.parse(s.capturedAt) > maxAge * 1000) return null;
  const model = { ...fixture, league:fixture.tournament || fixture.league || '', leagueCode:'sportybet', sportyEventId:String(fixture.eventId), modelVersion:MODEL_VERSION,
    h:null,d:null,a:null,btts:null,o05:null,o15:null,o25:null,u45:null,homeO05:null,awayO05:null,homeU45:null,awayU45:null,
    pickProb:0, pick:'', score:'', scoreP:null, goalModelAvailable:false, dataSource:'SportyBet statistics (corners only)', statsCapturedAt:s.capturedAt };
  const fields = ['homeGoalsFor','homeGoalsAgainst','awayGoalsFor','awayGoalsAgainst'];
  if (fields.every(f => s[f] != null)) {
    const lh = Math.max(0.05, Math.min(6,(s.homeGoalsFor+s.awayGoalsAgainst)/2));
    const la = Math.max(0.05, Math.min(6,(s.awayGoalsFor+s.homeGoalsAgainst)/2));
    const matrix = scoreMatrix(lh,la,18), p = outcomeProbs(matrix);
    const total = p.homeWin+p.draw+p.awayWin;
    let h = p.homeWin/total, d = p.draw/total, a = p.awayWin/total;
    const meetings = ['h2hHomeWins','h2hDraws','h2hAwayWins'].every(f=>s[f]!=null) ? s.h2hHomeWins+s.h2hDraws+s.h2hAwayWins : 0;
    const weight = Math.min(0.35,Math.max(0,Number(process.env.H2H_MAX_WEIGHT || 0.18)),meetings*0.03);
    if (meetings > 0) {
      h = h*(1-weight)+s.h2hHomeWins/meetings*weight;
      d = d*(1-weight)+s.h2hDraws/meetings*weight;
      a = a*(1-weight)+s.h2hAwayWins/meetings*weight;
    }
    Object.assign(model,{h:pct(h),d:pct(d),a:pct(a),btts:pct(p.bttsYes/total),o05:pct(p.over05/total),o15:pct(p.over15/total),o25:pct(p.over25/total),u45:pct(p.under45/total),
      homeO05:pct(p.homeOver05/total),awayO05:pct(p.awayOver05/total),homeU45:pct(p.homeUnder45/total),awayU45:pct(p.awayUnder45/total),
      goalLambdaHome:lh,goalLambdaAway:la,score:`${p.topScore.h}-${p.topScore.a}`,scoreP:pct(p.topScore.p/total),
      pick:['Home Win','Draw','Away Win'][[h,d,a].indexOf(Math.max(h,d,a))],pickProb:pct(Math.max(h,d,a)),
      goalModelAvailable:true,dataSource:'SportyBet displayed goal averages + Poisson + H2H',
      h2h:{meetings,influencePct:pct(weight),homeWinPct:meetings?pct(s.h2hHomeWins/meetings):null,drawPct:meetings?pct(s.h2hDraws/meetings):null,awayWinPct:meetings?pct(s.h2hAwayWins/meetings):null,recent:[]},
      form:{homeGoalsFor:s.homeGoalsFor,homeGoalsAgainst:s.homeGoalsAgainst,awayGoalsFor:s.awayGoalsFor,awayGoalsAgainst:s.awayGoalsAgainst,sampleCount:null}});
  }
  const hp=s.homeCornerProfile, ap=s.awayCornerProfile;
  if (hp && ap) model.corners = { homeLambda:(hp.cornersFor+ap.cornersAgainst)/2,awayLambda:(ap.cornersFor+hp.cornersAgainst)/2,
    totalLambda:(hp.cornersFor+ap.cornersAgainst+ap.cornersFor+hp.cornersAgainst)/2,
    samplesHome:hp.samples,samplesAway:ap.samples,source:'SportyBet recent corner statistics' };
  return model.goalModelAvailable || model.corners ? model : null;
}

async function readStatsSnapshot() {
  if (process.env.REDIS_URL) {
    const client = require('redis').createClient({url:process.env.REDIS_URL});
    client.on('error', () => {});
    try { await client.connect(); const raw = await client.get(STATS_KEY); return raw ? JSON.parse(raw) : {events:[]}; }
    finally { if (client.isOpen) await client.quit(); }
  }
  return fs.existsSync(STATS_FILE) ? JSON.parse(fs.readFileSync(STATS_FILE,'utf8')) : {events:[]};
}

async function enrichSportyFixtures(events, { maxFixtures=1000, marketRows=null, statsRows=null } = {}) {
  const stats = statsRows || (await readStatsSnapshot()).events || [];
  const byStats = new Map(stats.map(x=>[String(x.eventId),x]));
  const groups = new Map();
  for (const e of events || []) if (e.eventId && e.home && e.away && !groups.has(String(e.eventId))) groups.set(String(e.eventId),e);
  const rows = marketRows || events || [];
  const oneXtwo = noVigProbabilities(rows.filter(r=>String(r.marketId)==='1'),'1x2');
  return [...groups.values()].slice(0,maxFixtures).map(e => {
    const model = modelFromStats(e,byStats.get(String(e.eventId)));
    if (model) return model;
    const result = {eventId:String(e.eventId),sportyEventId:String(e.eventId),home:e.home,away:e.away,league:e.tournament || e.league || '',leagueCode:'sportybet',kickoffUtc:e.kickoffUtc,
      modelVersion:MODEL_VERSION,goalModelAvailable:false,marketModel:true,dataSource:'SportyBet no-vig market estimates',
      h:null,d:null,a:null,btts:null,o05:null,o15:null,o25:null,u45:null,homeO05:null,awayO05:null,homeU45:null,awayU45:null,score:'',scoreP:null,pickProb:0,pick:''};
    for (const [id,field] of [['1','h'],['2','d'],['3','a']]) {
      const row=rows.find(r=>String(r.eventId)===String(e.eventId) && String(r.marketId)==='1' && String(r.outcomeId)===id);
      if (row && oneXtwo.has(selectionKey(row))) result[field]=Math.round(oneXtwo.get(selectionKey(row))*10)/10;
    }
    if (result.h != null) { result.pickProb=Math.max(result.h,result.d,result.a); result.pick=['Home Win','Draw','Away Win'][[result.h,result.d,result.a].indexOf(result.pickProb)]; }
    return result;
  });
}

function cleanPredictions(payload) {
  // A provider migration must never reuse retired provider models from disk/Redis.
  return {...(payload || {}),matches:(payload?.matches || []).filter(r=>r.modelVersion===MODEL_VERSION)};
}
module.exports = { STATS_KEY,STATS_FILE,MODEL_VERSION,parseDisplayedStats:require('./sportyFootballStats').parseDisplayedStats,
  selectionKey,totalLine,lineIsHalf,isFullMatchCorners,noVigProbabilities,modelFromStats,enrichSportyFixtures,readStatsSnapshot,cleanPredictions };
