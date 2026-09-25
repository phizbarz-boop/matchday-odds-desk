const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render forwards the real client IP.
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');
const { getFootballMarket, getSportMarket, getBooking, bookBet, SPORT_CONFIG } = require('./lib/sportybet');
const { buildCandidates, selectAutoBet, passesRedFlagFilter, normalMetrics } = require('./lib/autoPicker');
const { sendTelegramMessage, sendTelegramMessageTo, telegramRequest, sendTelegramAiMessageTo, telegramAiRequest } = require('./lib/telegram');
const { PLANS: TELEGRAM_AI_PLANS, ALL_BET_IDS: TELEGRAM_AI_ALL_BET_IDS, allowedBetIdsForPlan: telegramAiAllowedBetIdsForPlan, getUser: getTelegramAiUser, saveUser: saveTelegramAiUser, getPlan: getTelegramAiPlan, consume: consumeTelegramAiUsage, activatePlan: activateTelegramAiPlan, addExtraTickets: addTelegramAiExtraTickets, hasTicketCredit: telegramAiHasTicketCredit, parseNaturalRequest: parseTelegramAiRequest, planKeyboard: telegramAiPlanKeyboard, ticketLimitKeyboard: telegramAiTicketLimitKeyboard, mainKeyboard: telegramAiMainKeyboard, builderSummary: telegramAiBuilderSummary, builderKeyboard: telegramAiBuilderKeyboard, sportKeyboard: telegramAiSportKeyboard, targetKeyboard: telegramAiTargetKeyboard, probabilityKeyboard: telegramAiProbabilityKeyboard, maxOddKeyboard: telegramAiMaxOddKeyboard, edgeKeyboard: telegramAiEdgeKeyboard, maxGamesKeyboard: telegramAiMaxGamesKeyboard, marketsKeyboard: telegramAiMarketsKeyboard, analyzerSummary: telegramAiAnalyzerSummary, analyzerKeyboard: telegramAiAnalyzerKeyboard, analyzerAnalysisKeyboard: telegramAiAnalyzerAnalysisKeyboard, analyzerProbKeyboard: telegramAiAnalyzerProbKeyboard, analyzerHorizonKeyboard: telegramAiAnalyzerHorizonKeyboard, resultKeyboard: telegramAiResultKeyboard, plansText: telegramAiPlansText } = require('./lib/telegramAiBot');
const { trackTelegramSlip, evaluateBooking } = require('./lib/slipTracker');
const { watDateKey } = require('./lib/dailyScheduleGuard');
const { SPORT_TIERS: TELEGRAM_SPORT_TIERS, selectTelegramMixedWithSportPriority } = require('./lib/telegramMixedSelector');
const { apiFetch, enrichSportyFixtures } = require('./lib/apiFootball');
const { matchSnapshot: matchHandballApiSportsSnapshot, apiKey: handballApiSportsKey } = require('./lib/apiSportsHandball');
const { matchSnapshot: matchVolleyballApiSportsSnapshot, apiKey: volleyballApiSportsKey } = require('./lib/apiSportsVolleyball');
const { addObservedCode, importSportySocialBatch, buildLeaderboard, readStore: readCopyHubStore, scanXRecent, settlePending: settleCopyHubPending, getPunterProfile } = require('./lib/copyHub');

let redisClient = null;
async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (e) => console.error('Redis error', e.message));
  await redisClient.connect();
  return redisClient;
}

function copyHubEnabled() {
  return String(process.env.COPY_HUB_ENABLED || '').toLowerCase() === 'true';
}

function authorizeCopyHub(req) {
  const secret = process.env.COPY_HUB_SECRET || '';
  return !!secret && req.headers['x-copy-hub-secret'] === secret;
}


function authorizeTelegramJob(req) {
  const secret = process.env.TELEGRAM_JOB_SECRET || '';
  return !!secret && req.headers['x-telegram-job-secret'] === secret;
}

function authorizeHandballCollector(req) {
  const secret = process.env.TELEGRAM_JOB_SECRET || '';
  return !!secret && req.headers['x-telegram-job-secret'] === secret;
}

function validFutureKickoff(value) {
  const ms = new Date(value || '').getTime();
  const buffer = Math.max(0, parseInt(process.env.SPORTYBET_KICKOFF_BUFFER_SECONDS || '60', 10))*1000;
  return Number.isFinite(ms) && ms > Date.now() + buffer;
}

function flattenHandballEvents(events, kind='winner') {
  const rows=[];
  for(const e of Array.isArray(events)?events:[]) {
    if(!e?.eventId || !e?.homeTeamName || !e?.awayTeamName || !validFutureKickoff(e?.kickoffTime)) continue;
    const markets=Array.isArray(e.markets)?e.markets:[];
    for(const m of markets) {
      const mid=String(m?.marketId||'');
      const desc=String(m?.marketDesc||'');
      const isWinner = kind==='winner' && (mid==='1' || /1x2|winner/i.test(desc));
      const isTotals = kind==='totals' && (mid==='18' || /total goals|over\/under|total/i.test(desc));
      if(!isWinner && !isTotals) continue;
      for(const o of Array.isArray(m?.outcomes)?m.outcomes:[]) {
        const odds=Number(o?.odds);
        if(!Number.isFinite(odds)||odds<=1) continue;
        rows.push({
          sport:'Handball',
          sportId:String(e.sportId||'sr:sport:6'),
          eventId:String(e.eventId),
          gameId:e.gameId!=null?String(e.gameId):null,
          home:e.homeTeamName,
          away:e.awayTeamName,
          tournament:e.tournament||'',
          kickoffUtc:e.kickoffTime,
          marketId:mid,
          marketDesc:desc,
          specifier:m?.specifier ?? o?.specifier ?? null,
          outcomeId:String(o?.outcomeId||''),
          outcomeDesc:String(o?.outcomeDesc||''),
          odds,
          apiSportsMatched:!!e.apiSportsMatched,
          apiSportsGameId:e.apiSportsGameId||null,
          apiSportsMatchScore:e.apiSportsMatchScore||null,
        });
      }
    }
  }
  return rows;
}

async function saveHandballSnapshot(snapshot) {
  handballSnapshotMemory=snapshot;
  const client=await getRedis();
  if(client) await client.set(HANDBALL_SNAPSHOT_REDIS_KEY,JSON.stringify(snapshot),{EX:Math.max(3600,parseInt(process.env.HANDBALL_SNAPSHOT_TTL_SECONDS||'46800',10))});
}

async function loadHandballSnapshot() {
  const client=await getRedis();
  if(client) {
    const raw=await client.get(HANDBALL_SNAPSHOT_REDIS_KEY);
    if(raw) {
      try { return JSON.parse(raw); } catch {}
    }
  }
  return handballSnapshotMemory || {fetchedAt:null,events:[]};
}

async function loadHandballMarket(kind='winner') {
  const snap=await loadHandballSnapshot();
  const rows=flattenHandballEvents(snap?.events||[],kind);
  return {
    sport:'handball',
    market:kind,
    marketLabel:kind==='winner'?'1X2 / Match Winner':'Total Goals',
    fetchedAt:snap?.fetchedAt||null,
    collectorVersion:snap?.collectorVersion||'V4',
    apiSportsMatched:Number(snap?.apiSportsMatched||0),
    apiSportsTotal:Number(snap?.apiSportsTotal||0),
    totalReturned:rows.length,
    rows,
  };
}


function flattenVolleyballEvents(events, kind='winner') {
  const rows=[];
  for(const e of Array.isArray(events)?events:[]) {
    if(!e?.eventId || !e?.homeTeamName || !e?.awayTeamName || !validFutureKickoff(e?.kickoffTime)) continue;
    const markets=Array.isArray(e.markets)?e.markets:[];
    for(const m of markets) {
      const mid=String(m?.marketId||'');
      const desc=String(m?.marketDesc||'');
      // Winner includes SportyBet match winner / 1X2-style rows. Volleyball normally has no draw,
      // but groupMarkets handles any 2-way or 3-way market consistently.
      const isWinner = kind==='winner' && (
        mid==='1' || /1x2|match winner|winner|moneyline/i.test(desc)
      );
      // Total Points/Total markets only. Set handicaps are intentionally not enabled yet.
      const isTotals = kind==='totals' && (
        /total points|points total/i.test(desc)
      );
      const isSets = kind==='sets' && (
        /total sets|sets total/i.test(desc)
      );
      if(!isWinner && !isTotals && !isSets) continue;
      for(const o of Array.isArray(m?.outcomes)?m.outcomes:[]) {
        const odds=Number(o?.odds);
        if(!Number.isFinite(odds)||odds<=1) continue;
        rows.push({
          sport:'Volleyball',
          sportId:String(e.sportId||''),
          eventId:String(e.eventId),
          gameId:e.gameId!=null?String(e.gameId):null,
          home:e.homeTeamName,
          away:e.awayTeamName,
          tournament:e.tournament||'',
          kickoffUtc:e.kickoffTime,
          marketId:mid,
          marketDesc:desc,
          specifier:m?.specifier ?? o?.specifier ?? null,
          outcomeId:String(o?.outcomeId||''),
          outcomeDesc:String(o?.outcomeDesc||''),
          odds,
          apiSportsMatched:!!e.apiSportsMatched,
          apiSportsGameId:e.apiSportsGameId||null,
          apiSportsMatchScore:e.apiSportsMatchScore||null,
        });
      }
    }
  }
  return rows;
}

async function saveVolleyballSnapshot(snapshot) {
  volleyballSnapshotMemory=snapshot;
  const client=await getRedis();
  if(client) await client.set(
    VOLLEYBALL_SNAPSHOT_REDIS_KEY,
    JSON.stringify(snapshot),
    {EX:Math.max(3600,parseInt(process.env.VOLLEYBALL_SNAPSHOT_TTL_SECONDS||'46800',10))}
  );
}

async function loadVolleyballSnapshot() {
  const client=await getRedis();
  if(client) {
    const raw=await client.get(VOLLEYBALL_SNAPSHOT_REDIS_KEY);
    if(raw) {
      try { return JSON.parse(raw); } catch {}
    }
  }
  return volleyballSnapshotMemory || {fetchedAt:null,events:[]};
}

async function loadVolleyballMarket(kind='winner') {
  const snap=await loadVolleyballSnapshot();
  const rows=flattenVolleyballEvents(snap?.events||[],kind);
  return {
    sport:'volleyball',
    market:kind,
    marketLabel:kind==='winner'?'Match Winner':(kind==='sets'?'Total Sets':'Total Points'),
    fetchedAt:snap?.fetchedAt||null,
    collectorVersion:snap?.collectorVersion||'V3',
    apiSportsMatched:Number(snap?.apiSportsMatched||0),
    apiSportsTotal:Number(snap?.apiSportsTotal||0),
    totalReturned:rows.length,
    rows,
  };
}


function flattenTennisEvents(events, kind='winner') {
  const rows=[];
  for(const e of Array.isArray(events)?events:[]) {
    if(!e?.eventId || !e?.homeTeamName || !e?.awayTeamName || !validFutureKickoff(e?.kickoffTime)) continue;
    for(const m of Array.isArray(e.markets)?e.markets:[]) {
      const desc=String(m?.marketDesc||'');
      const mid=String(m?.marketId||'');
      const isWinner = kind==='winner' && /winner|moneyline|match winner|1x2/i.test(desc);
      const isTotals = kind==='totals' && /total games|games total|total/i.test(desc) && !/sets?|handicap/i.test(desc);
      const isHandicap = kind==='handicap' && (/set handicap/i.test(desc) || mid==='188');
      if(!isWinner && !isTotals && !isHandicap) continue;
      for(const o of Array.isArray(m?.outcomes)?m.outcomes:[]) {
        const odds=Number(o?.odds);
        if(!Number.isFinite(odds)||odds<=1) continue;
        rows.push({
          sport:'Tennis',
          sportId:String(e.sportId||''),
          eventId:String(e.eventId),
          gameId:e.gameId!=null?String(e.gameId):null,
          home:e.homeTeamName,
          away:e.awayTeamName,
          tournament:e.tournament||'',
          kickoffUtc:e.kickoffTime,
          marketId:mid,
          marketDesc:desc,
          specifier:m?.specifier ?? o?.specifier ?? null,
          outcomeId:String(o?.outcomeId||''),
          outcomeDesc:String(o?.outcomeDesc||''),
          odds
        });
      }
    }
  }
  return rows;
}

async function saveTennisSnapshot(snapshot) {
  tennisSnapshotMemory=snapshot;
  const client=await getRedis();
  if(client) await client.set(TENNIS_SNAPSHOT_REDIS_KEY,JSON.stringify(snapshot),{
    EX:Math.max(3600,parseInt(process.env.TENNIS_SNAPSHOT_TTL_SECONDS||'46800',10))
  });
}

async function loadTennisSnapshot() {
  const client=await getRedis();
  if(client) {
    const raw=await client.get(TENNIS_SNAPSHOT_REDIS_KEY);
    if(raw) { try{return JSON.parse(raw)}catch{} }
  }
  return tennisSnapshotMemory || {fetchedAt:null,events:[]};
}

async function loadTennisMarket(kind='winner') {
  const snap=await loadTennisSnapshot();
  const rows=flattenTennisEvents(snap?.events||[],kind);
  return {
    sport:'tennis',
    market:kind,
    marketLabel:kind==='winner'?'Match Winner':(kind==='handicap'?'Set Handicap':'Total Games'),
    fetchedAt:snap?.fetchedAt||null,
    collectorVersion:snap?.collectorVersion||'V3',
    totalReturned:rows.length,
    rows
  };
}


const sportyMemoryCache = new Map();
const sportyMarketInFlight = new Map();
const bookingMemoryRate = new Map();
const telegramSendMemory = new Map();
const telegramDailyCodesMemory = new Map();
let handballSnapshotMemory = null;
const HANDBALL_SNAPSHOT_REDIS_KEY = 'sportybet:handball:v4:snapshot';
let volleyballSnapshotMemory = null;
const VOLLEYBALL_SNAPSHOT_REDIS_KEY = 'sportybet:volleyball:v1:snapshot';
let tennisSnapshotMemory = null;
const TENNIS_SNAPSHOT_REDIS_KEY = 'sportybet:tennis:v1:snapshot';


function telegramDailyCodeVisibleForPlan(planId, label) {
  const plan = String(planId || 'free').toLowerCase();
  if (plan !== 'free') return true;
  const key = String(label || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return key.includes('safe') || key === '2';
}


function plot207TelegramHelpText(plan = null) {
  const planName = plan?.name || 'your current plan';
  return [
    '❓ PLOT207 SPORTS BOT — HOW TO USE',
    '',
    `Your plan: ${planName}`,
    '',
    '🏠 MAIN MENU',
    'Use the buttons under every message. You can always type /start to return to the main menu or /help to reopen this guide.',
    '',
    '🎯 AUTO BUILDER',
    'Use this when you want Plot207 to create a new SportyBet ticket for you.',
    '1. Tap 🎯 Auto Builder.',
    '2. Tap 🏟 Sport and choose the sport or sports you want.',
    '3. Tap 🎯 Target and choose your desired combined odds.',
    '4. Set 📈 Min Probability. Higher values mean stricter selections and usually fewer available games.',
    '5. Set 💰 Max Odd/Match if you do not want high individual odds.',
    '6. Set 📊 Min Edge to control how much model advantage is required.',
    '7. Set 🔢 Max Games to limit how many selections can be used.',
    '8. Turn ✅ Today Only on if every selected game must play today in WAT.',
    '9. Tap 🎲 Bet Types to choose the markets the builder may use.',
    '10. Tap 🚀 BUILD TICKET.',
    '',
    '⭐ BEST PICKS / SAFE',
    'Tap ⭐ Best Picks when you want the dedicated SAFE ticket.',
    'SAFE prioritizes Tennis + Volleyball + Ice Hockey + Handball + Basketball, requires at least 90% probability per selected leg, applies red-flag protection, and aims for combined odds between 1.30 and 5.00.',
    'A SAFE pick is still a prediction, not a guaranteed win.',
    '',
    '🎟 TODAY’S CODES',
    'This shows only the SportyBet booking codes created by the scheduled Daily Auto Picks. It does not show the games.',
    '• Free: SAFE and 2x daily codes.',
    '• Pro: all available daily codes.',
    '• Elite: all available daily codes.',
    'The list refreshes when the day’s automated picks are generated.',
    '',
    '🔎 ANALYZE CODE',
    'Use this to check an existing SportyBet booking code.',
    '1. Tap 🔎 Analyze Code.',
    '2. Choose the minimum probability you want to KEEP.',
    '3. Choose the fixture search horizon.',
    '4. Tap ⌨️ Enter Code and send the SportyBet booking code.',
    '5. Plot207 shows which selections meet the model threshold.',
    'If unsupported selections are found, use ♻️ Replace Unsupported. Replacements are searched from saved/cached markets on the same fixture and are not automatic.',
    '',
    '📋 MY ACCOUNT',
    'Shows your current plan, remaining daily ticket/analysis allowance, and other account limits.',
    '',
    '👑 PLANS',
    'Shows Free, Pro and Elite features and lets you start an upgrade request.',
    '',
    '🏆 COPY RANKINGS',
    'Shows tracked Copy Hub rankings when your plan includes access and settled results are available.',
    '',
    '💬 YOU CAN ALSO TYPE REQUESTS',
    'Examples:',
    '• Build football 20x today only',
    '• Build football and basketball 10x, minimum 75%',
    '• Safe ticket',
    '• Analyze ABC123',
    '',
    '📌 QUICK TIPS',
    '• Higher minimum probability = stricter filtering, but fewer candidates.',
    '• Lower maximum odd per match = generally more conservative individual selections.',
    '• Today Only means kickoff must fall on today’s WAT calendar date.',
    '• Booking codes can only be created from markets where valid SportyBet event/market/outcome IDs are available.',
    '• If no ticket is produced, loosen one setting at a time: probability, max odd, market selection, target odds, or Today Only.',
    '',
    '⚠️ IMPORTANT',
    'Plot207 probabilities, edges and quality scores are model estimates. They do not guarantee a result. Bet responsibly and only with money you can afford to lose.',
    '',
    'Tap 🏠 Home or type /start when you are ready.'
  ].join('\n');
}

function telegramDailyCodesKey(dateKey) { return `telegram:daily-codes:${dateKey}`; }

async function saveTelegramDailyCodes(redis, dateKey, payload) {
  const safePayload = {
    date: dateKey,
    generatedAt: payload?.generatedAt || new Date().toISOString(),
    codes: Array.isArray(payload?.codes) ? payload.codes.map(x => ({
      targetOdds: String(x?.targetOdds || ''),
      combinedOdds: Number(x?.combinedOdds || 0),
      shareCode: String(x?.shareCode || ''),
    })).filter(x => x.targetOdds && x.shareCode) : [],
  };
  telegramDailyCodesMemory.set(dateKey, safePayload);
  if (redis) await redis.set(telegramDailyCodesKey(dateKey), JSON.stringify(safePayload), { EX: 172800 });
  return safePayload;
}

async function loadTelegramDailyCodes(redis, dateKey) {
  if (redis) {
    try {
      const raw = await redis.get(telegramDailyCodesKey(dateKey));
      if (raw) return JSON.parse(raw);
    } catch (e) { console.warn('Daily codes Redis read failed:', e.message); }
  }
  return telegramDailyCodesMemory.get(dateKey) || { date: dateKey, generatedAt: null, codes: [] };
}

function telegramDailyCodesText(snapshot, plan) {
  const codes = Array.isArray(snapshot?.codes) ? snapshot.codes : [];
  const isFree = plan?.id === 'free';
  const order = ['1.30–5.00 SAFE','2','3'];
  const byTarget = new Map(codes.map(x => [String(x.targetOdds), x]));
  const lines = ['🎟 TODAY’S AUTO-PICK CODES', '', `Date: ${snapshot?.date || fixtureDateKeyInTimeZone(new Date(), 'Africa/Lagos')} (WAT)`, ''];
  if (!codes.some(x => order.includes(String(x.targetOdds)))) {
    lines.push('No current SAFE, 2x or 3x Auto Pick codes have been generated yet today.');
  } else {
    for (const target of order) {
      const row = byTarget.get(target);
      if (!row) continue;
      const isSafe = target.includes('SAFE');
      const freeAllowed = telegramDailyCodeVisibleForPlan('free', target);
      if (isFree && !freeAllowed) {
        lines.push(`🔒 ${isSafe ? 'SAFE' : target + 'x'} — Pro/Elite only`);
      } else {
        const label = isSafe ? 'SAFE 1.30–5.00' : `${target}x`;
        lines.push(`${label}: ${row.shareCode}`);
      }
    }
  }
  lines.push('', 'Codes only — game selections are not shown here.');
  if (isFree) lines.push('Free access: SAFE + 2x only. Upgrade to Pro or Elite to reveal 3x.');
  return lines.join('\n');
}



function sanitizeTelegramSlip(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 40).map(x => ({
    sport: String(x?.sport || '').slice(0, 30),
    home: String(x?.home || '').slice(0, 120),
    away: String(x?.away || '').slice(0, 120),
    tournament: String(x?.tournament || '').slice(0, 120),
    marketDesc: String(x?.marketDesc || '').slice(0, 120),
    outcomeDesc: String(x?.outcomeDesc || '').slice(0, 120),
    odds: Number(x?.odds) || null,
    probability: Number(x?.probability) || null,
    impliedProbability: Number(x?.impliedProbability) || null,
    edge: Number(x?.edge) || 0,
    expectedValuePct: Number(x?.expectedValuePct) || 0,
    marketReliability: Number(x?.marketReliability) || null,
    qualityScore: Number(x?.qualityScore) || null,
    edgeType: String(x?.edgeType || '').slice(0, 40),
    fairOdds: Number(x?.fairOdds) || null,
    fullWinProbability: Number(x?.fullWinProbability) || null,
    nonLossProbability: Number(x?.nonLossProbability) || null,
    settlementNote: String(x?.settlementNote || '').slice(0, 100),
    specifier: x?.specifier ? String(x.specifier).slice(0, 120) : null,
  }));
}

async function createTelegramSendToken(payload) {
  const token = crypto.randomBytes(24).toString('hex');
  const key = `telegram:websend:${token}`;
  const client = await getRedis();
  const ttl = 600;
  if (client) {
    await client.set(key, JSON.stringify(payload), { EX: ttl });
  } else {
    telegramSendMemory.set(key, { payload, expiresAt: Date.now() + ttl * 1000 });
  }
  return token;
}

async function consumeTelegramSendToken(token) {
  if (!token) return null;
  const key = `telegram:websend:${String(token)}`;
  const client = await getRedis();
  if (client) {
    const raw = await client.get(key);
    if (!raw) return null;
    await client.del(key);
    return JSON.parse(raw);
  }
  const hit = telegramSendMemory.get(key);
  if (!hit) return null;
  telegramSendMemory.delete(key);
  if (hit.expiresAt < Date.now()) return null;
  return hit.payload;
}

function telegramManualSlipText(payload) {
  const slip = Array.isArray(payload?.slip) ? payload.slip : [];
  const combined = slip.reduce((p, x) => p * (Number(x.odds) || 1), 1);
  const probs = slip.map(x => Number(x.probability)).filter(Number.isFinite);
  const avg = probs.length ? probs.reduce((a,b)=>a+b,0)/probs.length : null;
  const slipProb = probs.length === slip.length && slip.length ? probs.reduce((p,x)=>p*(x/100),1)*100 : null;
  const avgEdge = slip.length ? slip.reduce((a,x)=>a+(Number(x.edge)||0),0)/slip.length : null;
  const avgQuality = slip.map(x=>Number(x.qualityScore)).filter(Number.isFinite);
  const avgQ = avgQuality.length ? avgQuality.reduce((a,b)=>a+b,0)/avgQuality.length : null;
  const lines = [
    '📲 MATCHDAY ODDS DESK — MANUAL SHARE',
    `SportyBet code: ${payload?.shareCode || 'N/A'}`,
    `Combined odds: ${combined.toFixed(2)}`,
    `Selections: ${slip.length}`,
    ...(avg !== null ? [`Average leg probability: ${avg.toFixed(1)}%`] : []),
    ...(slipProb !== null ? [`Estimated slip fair-price probability: ${slipProb.toFixed(3)}%`] : []),
    ...(avgEdge !== null ? [`Average probability edge: ${avgEdge.toFixed(1)} pts`] : []),
    ...(avgQ !== null ? [`Average quality score: ${avgQ.toFixed(1)}/100`] : []),
    '',
  ];
  slip.forEach((x, i) => {
    lines.push(`${i + 1}. [${x.sport || 'Sport'}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc || 'Selection'} @ ${Number(x.odds || 0).toFixed(2)}${Number.isFinite(Number(x.probability)) ? ` | model/fair ${Number(x.probability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.impliedProbability)) ? ` | implied ${Number(x.impliedProbability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.edge)) ? ` | edge ${Number(x.edge).toFixed(1)}` : ''}${Number.isFinite(Number(x.qualityScore)) ? ` | Q ${Number(x.qualityScore).toFixed(1)}` : ''}`);
    if (x.settlementNote && x.settlementNote !== 'Win/lose market') lines.push(`   Settlement: ${x.settlementNote}${Number.isFinite(Number(x.fullWinProbability)) ? ` | full-win ${Number(x.fullWinProbability).toFixed(1)}%` : ''}${Number.isFinite(Number(x.nonLossProbability)) ? ` | non-loss ${Number(x.nonLossProbability).toFixed(1)}%` : ''}`);
  });
  if (payload?.shareURL) lines.push('', `SportyBet link: ${payload.shareURL}`);
  return lines.join('\n');
}

function filterUpcomingSportyPayload(payload, { nowMs = Date.now(), kickoffBufferSeconds = 60 } = {}) {
  if (!payload || !Array.isArray(payload.rows)) return payload;
  const cutoff = nowMs + Math.max(0, Number(kickoffBufferSeconds) || 0) * 1000;
  let validKickoff = 0, missingOrInvalidKickoff = 0, pastOrStarted = 0;
  const rows = payload.rows.filter(row => {
    const kickoffMs = Date.parse(row?.kickoffUtc || '');
    // Important: the managed SportyBet market endpoint often omits kickoff time.
    // Missing/invalid kickoff must NOT cause a valid current selection to be discarded.
    // We only remove a row when a valid timestamp explicitly proves it has started/expired.
    if (!Number.isFinite(kickoffMs)) {
      missingOrInvalidKickoff++;
      return true;
    }
    validKickoff++;
    if (kickoffMs <= cutoff) {
      pastOrStarted++;
      return false;
    }
    return true;
  });
  console.log(`[SportyBet filter] raw=${payload.rows.length} validKickoff=${validKickoff} missingKickoffKept=${missingOrInvalidKickoff} pastOrStartedRemoved=${pastOrStarted} returned=${rows.length}`);
  return {
    ...payload,
    rows,
    totalReturned: rows.length,
    staleRowsRemoved: pastOrStarted,
    missingKickoffKept: missingOrInvalidKickoff,
    upcomingFilteredAt: new Date(nowMs).toISOString(),
  };
}

function sportyPayloadAgeSeconds(payload, nowMs = Date.now()) {
  const fetchedMs = Date.parse(payload?.fetchedAt || '');
  return Number.isFinite(fetchedMs) ? Math.max(0, (nowMs - fetchedMs) / 1000) : Infinity;
}

function filterSportyPayloadToHours(payload, hours, nowMs = Date.now()) {
  if (!payload || !Array.isArray(payload.rows)) return payload;
  const upper = nowMs + Math.max(1, Number(hours) || 1) * 3600 * 1000;
  const rows = payload.rows.filter(row => {
    const t = Date.parse(row?.kickoffUtc || '');
    return !Number.isFinite(t) || t <= upper;
  });
  return { ...payload, rows, totalReturned: rows.length };
}

function sportySnapshotKey(sport, kind) {
  const teamGoal = sport === 'football' && ['home_ou05','away_ou05','home_ou45','away_ou45'].includes(kind);
  const v = String(process.env.SPORTYBET_CACHE_VERSION || '9') + (teamGoal ? '-ng-team-v2' : '');
  return `sportybet:snapshot:v${v}:${sport}:${kind}`;
}

async function readSportySnapshot(client, sport, kind, hours, nowMs, kickoffBufferSeconds) {
  const key = sportySnapshotKey(sport, kind);
  let snapshot = null;
  if (client) {
    try { const raw = await client.get(key); if (raw) snapshot = JSON.parse(raw); } catch {}
  } else {
    const hit = sportyMemoryCache.get(key);
    if (hit && hit.expiresAt > nowMs) snapshot = hit.payload;
  }
  if (!snapshot || Number(snapshot.snapshotHours || 0) < Number(hours || 0)) return null;
  const maxAge = Math.max(300, parseInt(process.env.SPORTYBET_DAILY_SNAPSHOT_MAX_AGE_SECONDS || '90000', 10));
  if (sportyPayloadAgeSeconds(snapshot, nowMs) > maxAge) return null;
  let filtered = filterUpcomingSportyPayload(snapshot, { nowMs, kickoffBufferSeconds });
  filtered = filterSportyPayloadToHours(filtered, hours, nowMs);
  return Array.isArray(filtered?.rows) && filtered.rows.length ? filtered : null;
}

async function writeSportySnapshot(client, sport, kind, payload, hours) {
  if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) return;
  const key = sportySnapshotKey(sport, kind);
  const ttl = Math.max(3600, parseInt(process.env.SPORTYBET_DAILY_SNAPSHOT_SECONDS || '93600', 10));
  const snapshot = { ...payload, snapshotHours: Number(hours) || 0, snapshotSavedAt: new Date().toISOString() };
  if (client) await client.set(key, JSON.stringify(snapshot), { EX: ttl }).catch(()=>{});
  else sportyMemoryCache.set(key, { expiresAt: Date.now() + ttl * 1000, payload: snapshot });
}

async function loadSportyBetMarket(kind, sport = 'football', options = {}) {
  const ttlSeconds = Math.max(60, parseInt(process.env.SPORTYBET_CACHE_SECONDS || '43200', 10));
  const normalHours = Math.max(1, parseInt(process.env.SPORTYBET_HOURS || String((parseInt(process.env.DAYS_AHEAD || '4', 10) + 1) * 24), 10));
  const hours = Math.max(1, Math.min(24 * 21, parseInt(options.hours || normalHours, 10)));
  const maxPages = Math.max(1, Math.min(20, parseInt(options.maxPages || process.env.SPORTYBET_MAX_PAGES || '5', 10)));
  const maxCacheAgeSeconds = Number.isFinite(Number(options.maxCacheAgeSeconds))
    ? Math.max(0, Number(options.maxCacheAgeSeconds))
    : null;
  const kickoffBufferSeconds = Math.max(0, Number(options.kickoffBufferSeconds ?? process.env.SPORTYBET_KICKOFF_BUFFER_SECONDS ?? 60) || 0);
  const forceRefresh = options.forceRefresh === true;
  // Keep Analyzer's 14/21-day cache completely separate from the normal Auto Builder cache.
  // Versioned cache key: bumping this invalidates stale/empty market caches after parser changes.
  // Team-goal markets changed to the Nigeria full-event endpoint; do not
  // reuse rows (or empty results) cached by the previous .com-only fallback.
  const isTeamGoalKind = sport === 'football' && ['home_ou05','away_ou05','home_ou45','away_ou45'].includes(kind);
  const cacheVersion = String(process.env.SPORTYBET_CACHE_VERSION || '9') + (isTeamGoalKind ? '-ng-team-v2' : '');
  const cacheKey = `sportybet:v${cacheVersion}:${sport}:${kind}:h${hours}:p${maxPages}`;
  const client = await getRedis();
  const nowMs = Date.now();

  // Shared daily snapshot is independent of request horizon/page count. A 7/14-day
  // Analyzer request can therefore reuse a 21-day Daily Refresh snapshot instead of
  // purchasing the same SportyBet rows again.
  if (!forceRefresh) {
    const snapshot = await readSportySnapshot(client, sport, kind, hours, nowMs, kickoffBufferSeconds);
    if (snapshot) {
      console.log(`[SportyBet snapshot] HIT ${sport}/${kind} requested=${hours}h snapshot=${snapshot.snapshotHours}h rows=${snapshot.rows.length}`);
      return snapshot;
    }
  }

  let cached = null;
  if (client) {
    const raw = await client.get(cacheKey);
    if (raw) cached = JSON.parse(raw);
  } else {
    const hit = sportyMemoryCache.get(cacheKey);
    if (hit && hit.expiresAt > nowMs) cached = hit.payload;
  }

  if (!forceRefresh && cached && (maxCacheAgeSeconds == null || sportyPayloadAgeSeconds(cached, nowMs) <= maxCacheAgeSeconds)) {
    const filteredCached = filterUpcomingSportyPayload(cached, { nowMs, kickoffBufferSeconds });
    // Never let an empty cache (or a cache whose fixtures have all kicked off)
    // block discovery of newly-added SportyBet fixtures. Refresh immediately.
    if (Array.isArray(filteredCached?.rows) && filteredCached.rows.length > 0) {
      return filteredCached;
    }
    // A recently fetched empty result is a short negative cache. Serve it quickly
    // until SPORTYBET_EMPTY_CACHE_SECONDS expires instead of hammering the upstream API.
    const age = sportyPayloadAgeSeconds(cached, nowMs);
    const emptyTtl = Math.max(15, Math.min(300, parseInt(process.env.SPORTYBET_EMPTY_CACHE_SECONDS || '60', 10)));
    if (age <= emptyTtl) return filteredCached;
    if (client) await client.del(cacheKey).catch(()=>{});
    else sportyMemoryCache.delete(cacheKey);
  }

  // Analyzer replacement can be configured to use only data already saved by the Daily Refresh.
  // When cacheOnly is true, never purchase a fresh Parse.bot market call here.
  if (options.cacheOnly) {
    console.log(`[SportyBet cache-only] MISS ${sport}/${kind} requested=${hours}h`);
    return { rows: [], cacheOnly: true, fetchedAt: null };
  }

  // Collapse concurrent requests for the same sport/market/window into one upstream call.
  // This is important because the Auto Builder and Analyzer can ask for overlapping markets.
  const inFlightKey = forceRefresh ? `${cacheKey}:force-refresh` : cacheKey;
  let refreshPromise = sportyMarketInFlight.get(inFlightKey);
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const payload = sport === 'football'
        ? await getFootballMarket(kind, { hours, maxPages, fixtures: options.fixtures })
        : await getSportMarket(sport, kind, { hours, maxPages });

      const filteredPayload = filterUpcomingSportyPayload(payload, { nowMs: Date.now(), kickoffBufferSeconds });
      if (Array.isArray(filteredPayload?.rows) && filteredPayload.rows.length > 0) {
        if (client) await client.set(cacheKey, JSON.stringify(payload), { EX: ttlSeconds });
        else sportyMemoryCache.set(cacheKey, { expiresAt: Date.now() + ttlSeconds * 1000, payload });
        await writeSportySnapshot(client, sport, kind, payload, hours);
      } else {
        // Short negative cache: prevents every page click from making another slow Parse call,
        // while still retrying quickly enough to discover newly-added SportyBet fixtures.
        const emptyTtl = Math.max(15, Math.min(300, parseInt(process.env.SPORTYBET_EMPTY_CACHE_SECONDS || '60', 10)));
        const emptyPayload = { ...(payload || {}), rows: [], fetchedAt: new Date().toISOString() };
        if (client) await client.set(cacheKey, JSON.stringify(emptyPayload), { EX: emptyTtl });
        else sportyMemoryCache.set(cacheKey, { expiresAt: Date.now() + emptyTtl * 1000, payload: emptyPayload });
        console.warn(`[SportyBet] ${sport}/${kind}: 0 upcoming outcomes; retry cache ${emptyTtl}s.`);
      }
      return filteredPayload;
    })();
    sportyMarketInFlight.set(inFlightKey, refreshPromise);
    refreshPromise.finally(() => sportyMarketInFlight.delete(inFlightKey)).catch(()=>{});
  }
  return await refreshPromise;
}

async function allowBookingRequest(req) {
  const maxPerMinute = Math.max(1, parseInt(process.env.SPORTYBET_BOOKINGS_PER_MINUTE || '5', 10));
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const bucket = Math.floor(Date.now() / 60000);
  const key = `sportybet:bookrate:${ip}:${bucket}`;
  const client = await getRedis();

  if (client) {
    const count = await client.incr(key);
    if (count === 1) await client.expire(key, 70);
    return count <= maxPerMinute;
  }

  const old = bookingMemoryRate.get(key) || 0;
  const next = old + 1;
  bookingMemoryRate.set(key, next);
  if (bookingMemoryRate.size > 1000) {
    for (const k of bookingMemoryRate.keys()) {
      const parts = k.split(':');
      const b = Number(parts[parts.length - 1]);
      if (b < bucket - 1) bookingMemoryRate.delete(k);
    }
  }
  return next <= maxPerMinute;
}

async function loadPredictions() {
  const client = await getRedis();
  if (client) {
    const raw = await client.get('predictions:latest');
    if (raw) return JSON.parse(raw);
    return { generatedAt: null, matches: [] };
  }
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { generatedAt: null, matches: [] };
}


// -----------------------------------------------------------------------------
// Website access-code gate
// -----------------------------------------------------------------------------
// This protects the browser UI without interfering with GitHub/Telegram job APIs.
// Configure WEBSITE_ACCESS_CODE in Render. Do not hard-code the code in public files.
const WEBSITE_ACCESS_COOKIE = 'matchday_access';
const WEBSITE_ACCESS_MAX_AGE_SECONDS = Math.max(
  300,
  parseInt(process.env.WEBSITE_ACCESS_MAX_AGE_SECONDS || String(7 * 24 * 60 * 60), 10) || (7 * 24 * 60 * 60)
);

function websiteAccessCode() {
  return String(process.env.WEBSITE_ACCESS_CODE || '');
}

function websiteAccessToken() {
  const code = websiteAccessCode();
  if (!code) return '';
  const secret = String(process.env.WEBSITE_ACCESS_SESSION_SECRET || code);
  return crypto.createHmac('sha256', secret).update(`matchday-access-v1:${code}`).digest('hex');
}

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  });
  return out;
}

function safeEqualString(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function hasWebsiteAccess(req) {
  const expected = websiteAccessToken();
  if (!expected) return false;
  const cookies = parseCookieHeader(req.headers.cookie);
  return safeEqualString(cookies[WEBSITE_ACCESS_COOKIE], expected);
}

function accessPage(message = '') {
  const error = message ? `<div class="error">${String(message).replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]))}</div>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Matchday Odds Desk — Access</title>
<style>
  *{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070b09;color:#f3f7f4;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
  .card{width:min(430px,100%);background:linear-gradient(180deg,#111814,#0c110e);border:1px solid #26352c;border-radius:20px;padding:30px;box-shadow:0 24px 70px rgba(0,0,0,.5)}
  .brand{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#58df84;font-weight:800;margin-bottom:10px}.title{font-size:28px;font-weight:850;margin:0 0 8px}.sub{color:#9eaaa2;line-height:1.55;margin:0 0 24px}
  label{display:block;font-size:13px;font-weight:700;margin-bottom:8px;color:#cbd5ce} input{width:100%;border:1px solid #34463a;background:#070a08;color:#fff;border-radius:12px;padding:14px 15px;font-size:17px;outline:none} input:focus{border-color:#36cf6a;box-shadow:0 0 0 3px rgba(54,207,106,.12)}
  button{width:100%;margin-top:14px;border:0;border-radius:12px;padding:14px 16px;font-size:15px;font-weight:850;background:#27c45b;color:#031006;cursor:pointer} button:hover{filter:brightness(1.06)}
  .error{margin:0 0 16px;padding:11px 13px;border:1px solid #6b2929;background:#2a1111;color:#ffb6b6;border-radius:10px;font-size:13px}.foot{margin-top:18px;text-align:center;font-size:11px;color:#68746c}
</style>
</head>
<body><main class="card"><div class="brand">PLOT207 SPORTS</div><h1 class="title">Access required</h1><p class="sub">Enter the website access code to continue to Matchday Odds Desk.</p>${error}<form method="post" action="/access"><label for="code">Access code</label><input id="code" name="code" type="password" autocomplete="current-password" required autofocus><button type="submit">Unlock Website</button></form><div class="foot">Authorized access only</div></main></body></html>`;
}

app.get('/access', (req, res) => {
  if (hasWebsiteAccess(req)) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  if (!websiteAccessCode()) return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  res.status(200).send(accessPage(''));
});

app.post('/access', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  res.set('Cache-Control', 'no-store');
  const expected = websiteAccessCode();
  if (!expected) return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  const supplied = String(req.body?.code || '');
  if (!safeEqualString(supplied, expected)) return res.status(401).send(accessPage('Incorrect access code.'));

  const cookie = [
    `${WEBSITE_ACCESS_COOKIE}=${encodeURIComponent(websiteAccessToken())}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${WEBSITE_ACCESS_MAX_AGE_SECONDS}`
  ].join('; ');
  res.setHeader('Set-Cookie', cookie);
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${WEBSITE_ACCESS_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  res.redirect('/access');
});

// Protect browser/static website requests. API routes keep their existing own secrets/auth
// so scheduled GitHub workflows and Telegram integrations are not broken by this gate.
app.use((req, res, next) => {
  if (req.path === '/access' || req.path === '/logout' || req.path.startsWith('/api/')) return next();
  if (!websiteAccessCode()) {
    res.set('Cache-Control', 'no-store');
    return res.status(503).send(accessPage('Website access is not configured yet. Set WEBSITE_ACCESS_CODE in Render.'));
  }
  if (!hasWebsiteAccess(req)) return res.redirect('/access');
  return next();
});

app.use(express.static(path.join(__dirname, 'public')));


app.get('/api/predictions', async (req, res) => {
  try {
    const payload = await loadPredictions();
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load predictions' });
  }
});



app.get('/api/corners/test-live', async (req, res) => {
  try{
    if(!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY)){
      return res.status(503).json({apiFootballConfigured:false,called:false,error:'API_FOOTBALL_KEY is not configured'});
    }

    const [c,h]=await Promise.all([
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);

    const source=[...(c?.rows||[]),...(h?.rows||[])];
    const seen=new Set();
    const fixtures=source.filter(x=>{
      const k=String(x.eventId||'') || `${x.home}|${x.away}|${x.kickoffUtc}`;
      if(!k||seen.has(k)) return false;
      seen.add(k);
      return !!(x.home&&x.away&&x.kickoffUtc);
    }).slice(0,1);

    if(!fixtures.length){
      return res.status(422).json({
        apiFootballConfigured:true,
        called:false,
        sportyCornerRows:(c?.rows||[]).length,
        sportyFirstHalfCornerRows:(h?.rows||[]).length,
        error:'No usable SportyBet corner fixture contained home, away and kickoffUtc'
      });
    }

    const f=fixtures[0];
    const rows=await enrichSportyFixtures(fixtures,{
      daysAhead:3,
      maxFixtures:1,
      cornerEventIds:new Set([String(f.eventId||'')])
    });
    const r=rows[0]||null;

    res.json({
      apiFootballConfigured:true,
      called:true,
      sportyFixture:{eventId:f.eventId,home:f.home,away:f.away,kickoffUtc:f.kickoffUtc},
      apiFootballMatched:!!r,
      apiFootballFixtureId:r?.apiFootballFixtureId||null,
      matchConfidence:r?.apiFootballMatchConfidence||null,
      cornerModel:r?.corners||null,
      success:!!r?.corners,
      message:r?.corners
        ? 'Live API-Football corner model built successfully.'
        : 'API-Football was called, but no corner model was produced. Render logs now show the exact failed stage.'
    });
  }catch(err){
    res.status(500).json({
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
      called:true,
      error:'Live corner test failed',
      detail:String(err.message||err).slice(0,800)
    });
  }
});

app.get('/api/corners/diagnostics', async (req, res) => {
  try{
    const [pred,c,h]=await Promise.all([
      loadPredictions(),
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);
    const matches=Array.isArray(pred?.matches)?pred.matches:[];
    const modeled=matches.filter(x=>Number(x?.corners?.totalLambda||0)>0);
    res.json({
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
      predictionMatches:matches.length,
      matchesWithCornerModel:modeled.length,
      sportyCornerRows:Array.isArray(c?.rows)?c.rows.length:0,
      sportyFirstHalfCornerRows:Array.isArray(h?.rows)?h.rows.length:0,
      sampleCornerModels:modeled.slice(0,5).map(x=>({
        eventId:x.eventId||x.sportyEventId||null,
        home:x.home,away:x.away,
        totalLambda:x.corners?.totalLambda,
        firstHalfHomeLambda:x.corners?.firstHalfHomeLambda,
        firstHalfAwayLambda:x.corners?.firstHalfAwayLambda
      }))
    });
  }catch(err){
    res.status(500).json({error:'Corner diagnostics failed',detail:String(err.message||err).slice(0,500)});
  }
});

app.get('/api/api-football/diagnostics', async (req, res) => {
  const configured=!!(process.env.API_FOOTBALL_KEY || process.env.API_FOOTBALL_API_KEY);
  if(!configured) return res.status(503).json({configured:false,called:false,error:'API_FOOTBALL_KEY is not configured on this Render service'});
  try{
    const date=new Date().toISOString().slice(0,10);
    const payload=await apiFetch('/fixtures',{date});
    res.json({configured:true,called:true,endpoint:'/fixtures',date,results:Number(payload?.results||0),errors:payload?.errors||[],message:'API-Football call succeeded. This request should appear in your API-Football dashboard.'});
  }catch(err){
    res.status(502).json({configured:true,called:true,error:'API-Football call failed',detail:String(err.message||err).slice(0,500)});
  }
});


// Live-ish SportyBet price layer. The Parse API key never reaches the browser.
// Supported football values: 1x2, gg, dc, dnb, ou05, ou15, ou45, ah, oneup. O/U 2.5 is intentionally not used by the Auto Builder.
app.get('/api/sportybet/odds', async (req, res) => {
  try {
    const kind = String(req.query.market || '1x2').toLowerCase();
    if (!['1x2', 'gg', 'dc', 'dnb', 'ou05', 'home_ou05', 'away_ou05', 'home_ou45', 'away_ou45', 'ou15', 'ou45', 'ah', 'oneup', 'corners', 'first_half_team_corners'].includes(kind)) {
      return res.status(400).json({ error: 'market must be one of: 1x2, gg, dc, dnb, ou05, home_ou05, away_ou05, home_ou45, away_ou45, ou15, ou45, ah, oneup, corners, first_half_team_corners' });
    }
    const isTeamGoal = ['home_ou05','away_ou05','home_ou45','away_ou45'].includes(kind);
    // Use the same saved fixture IDs as the Auto Builder and Telegram bot;
    // taking the bookmaker's arbitrary first 12 events instead can display
    // zero rows even while the model has usable fixtures elsewhere.
    const opts = isTeamGoal ? { fixtures:(await loadPredictions()).matches || [] } : {};
    const payload = await loadSportyBetMarket(kind, 'football', opts);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    console.error('SportyBet odds error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : (err.code === 'SPORTYBET_BOOKING_TIMEOUT' ? 504 : 502);
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to load SportyBet odds',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});




app.post('/api/internal/handball/snapshot', express.json({limit:'5mb'}), async (req,res)=>{
  if(!authorizeHandballCollector(req)) return res.status(401).json({error:'unauthorized'});
  try{
    const raw=Array.isArray(req.body?.events)?req.body.events:[];
    if(!raw.length) return res.status(400).json({error:'events must be a non-empty array'});
    let events=raw;
    let matchInfo={matched:0,total:raw.length,datesQueried:[]};

    // API-SPORTS is a matching/validation layer only. Handball probability remains
    // the same no-vig SportyBet market model used by Basketball and Ice Hockey.
    if(handballApiSportsKey()){
      try{
        const matched=await matchHandballApiSportsSnapshot(raw,{maxDates:5});
        events=matched.events;
        matchInfo={matched:matched.matched,total:matched.total,datesQueried:matched.datesQueried};
      }catch(err){
        console.warn('[Handball snapshot] API-SPORTS matching failed:',err.message);
      }
    }

    const snapshot={
      collectorVersion:'V4',
      fetchedAt:new Date().toISOString(),
      events,
      apiSportsMatched:matchInfo.matched,
      apiSportsTotal:matchInfo.total,
      apiSportsDatesQueried:matchInfo.datesQueried,
    };
    await saveHandballSnapshot(snapshot);
    const winnerRows=flattenHandballEvents(events,'winner').length;
    const totalRows=flattenHandballEvents(events,'totals').length;
    res.json({ok:true,events:events.length,winnerRows,totalRows,...matchInfo,probabilityModel:'no-vig SportyBet market probability (same as Basketball/Ice Hockey)'});
  }catch(err){
    console.error('[Handball snapshot] failed:',err);
    res.status(500).json({error:'failed to save handball snapshot',detail:process.env.NODE_ENV==='production'?undefined:err.message});
  }
});



app.post('/api/internal/tennis/snapshot', express.json({limit:'5mb'}), async (req,res)=>{
  if(!authorizeHandballCollector(req)) return res.status(401).json({error:'unauthorized'});
  try{
    const events=Array.isArray(req.body?.events)?req.body.events:[];
    if(!events.length) return res.status(400).json({error:'events must be a non-empty array'});
    const snapshot={collectorVersion:'V3',fetchedAt:new Date().toISOString(),events};
    await saveTennisSnapshot(snapshot);
    const winnerRows=flattenTennisEvents(events,'winner').length;
    const totalRows=flattenTennisEvents(events,'totals').length;
    const handicapRows=flattenTennisEvents(events,'handicap').length;
    res.json({
      ok:true,events:events.length,winnerRows,totalRows,handicapRows,
      probabilityModel:'no-vig SportyBet market probability (same non-football market model)'
    });
  }catch(err){
    console.error('[Tennis snapshot] failed:',err);
    res.status(500).json({error:'failed to save tennis snapshot',detail:process.env.NODE_ENV==='production'?undefined:err.message});
  }
});

app.get('/api/tennis/status', async (req,res)=>{
  try{
    const snap=await loadTennisSnapshot();
    const winner=await loadTennisMarket('winner');
    const totals=await loadTennisMarket('totals');
    const handicap=await loadTennisMarket('handicap');
    res.json({
      collectorVersion:snap?.collectorVersion||null,
      fetchedAt:snap?.fetchedAt||null,
      fixtures:Array.isArray(snap?.events)?snap.events.length:0,
      winnerRows:winner.rows.length,
      totalsRows:totals.rows.length,
      handicapRows:handicap.rows.length,
      probabilityModel:'No-vig/de-margined SportyBet market probability'
    });
  }catch(err){res.status(500).json({error:'tennis status failed',detail:String(err.message||err)});}
});

app.post('/api/internal/volleyball/snapshot', express.json({limit:'5mb'}), async (req,res)=>{
  if(!authorizeHandballCollector(req)) return res.status(401).json({error:'unauthorized'});
  try{
    const raw=Array.isArray(req.body?.events)?req.body.events:[];
    if(!raw.length) return res.status(400).json({error:'events must be a non-empty array'});

    let events=raw;
    let matchInfo={matched:0,total:raw.length,datesQueried:[]};

    // Volleyball uses API-SPORTS only for fixture matching/validation.
    // Probability is the same no-vig SportyBet model as Basketball, Hockey and Handball.
    if(volleyballApiSportsKey()){
      try{
        const matched=await matchVolleyballApiSportsSnapshot(raw,{maxDates:8});
        events=matched.events;
        matchInfo={matched:matched.matched,total:matched.total,datesQueried:matched.datesQueried};
      }catch(err){
        console.warn('[Volleyball snapshot] API-SPORTS matching failed:',err.message);
      }
    }

    const snapshot={
      collectorVersion:'V3',
      fetchedAt:new Date().toISOString(),
      events,
      apiSportsMatched:matchInfo.matched,
      apiSportsTotal:matchInfo.total,
      apiSportsDatesQueried:matchInfo.datesQueried,
    };
    await saveVolleyballSnapshot(snapshot);

    const winnerRows=flattenVolleyballEvents(events,'winner').length;
    const totalRows=flattenVolleyballEvents(events,'totals').length;
    const setRows=flattenVolleyballEvents(events,'sets').length;
    res.json({
      ok:true,events:events.length,winnerRows,totalRows,setRows,...matchInfo,
      probabilityModel:'no-vig SportyBet market probability (same as Basketball/Ice Hockey/Handball)'
    });
  }catch(err){
    console.error('[Volleyball snapshot] failed:',err);
    res.status(500).json({
      error:'failed to save volleyball snapshot',
      detail:process.env.NODE_ENV==='production'?undefined:err.message
    });
  }
});

app.get('/api/volleyball/status', async (req,res)=>{
  try{
    const snap=await loadVolleyballSnapshot();
    const winner=await loadVolleyballMarket('winner');
    const totals=await loadVolleyballMarket('totals');
    const sets=await loadVolleyballMarket('sets');
    res.json({
      collectorVersion:snap?.collectorVersion||null,
      fetchedAt:snap?.fetchedAt||null,
      fixtures:Array.isArray(snap?.events)?snap.events.length:0,
      winnerRows:winner.rows.length,
      totalsRows:totals.rows.length,
      setRows:sets.rows.length,
      apiSportsConfigured:!!volleyballApiSportsKey(),
      apiSportsMatched:Number(snap?.apiSportsMatched||0),
      apiSportsTotal:Number(snap?.apiSportsTotal||0),
      probabilityModel:'No-vig/de-margined SportyBet market probability — same as Basketball, Ice Hockey and Handball',
    });
  }catch(err){
    res.status(500).json({error:'volleyball status failed',detail:String(err.message||err)});
  }
});

app.get('/api/handball/status', async (req,res)=>{
  try{
    const snap=await loadHandballSnapshot();
    const winner=await loadHandballMarket('winner');
    const totals=await loadHandballMarket('totals');
    res.json({
      collectorVersion:snap?.collectorVersion||null,
      fetchedAt:snap?.fetchedAt||null,
      fixtures:Array.isArray(snap?.events)?snap.events.length:0,
      winnerRows:winner.rows.length,
      totalsRows:totals.rows.length,
      apiSportsConfigured:!!handballApiSportsKey(),
      apiSportsMatched:Number(snap?.apiSportsMatched||0),
      apiSportsTotal:Number(snap?.apiSportsTotal||0),
      probabilityModel:'No-vig/de-margined SportyBet market probability — same as Basketball and Ice Hockey',
    });
  }catch(err){res.status(500).json({error:'handball status failed',detail:String(err.message||err)});}
});

// Basketball and ice hockey odds. Parse currently exposes pre-match data for these
// sports; this route is generic so more supported sports can be added later.
app.get('/api/sportybet/sport/:sport', async (req, res) => {
  try {
    const sport = String(req.params.sport || '').toLowerCase();
    if (sport === 'tennis') {
      const kind = String(req.query.market || 'winner').toLowerCase();
      if (!['winner','totals','handicap'].includes(kind)) {
        return res.status(400).json({ error: 'tennis market must be one of: winner, totals, handicap' });
      }
      const payload = await loadTennisMarket(kind);
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(payload);
    }
    if (sport === 'handball') {
      const kind = String(req.query.market || 'winner').toLowerCase();
      if (!['winner','totals'].includes(kind)) {
        return res.status(400).json({ error: 'handball market must be one of: winner, totals' });
      }
      const payload = await loadHandballMarket(kind);
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(payload);
    }
    if (sport === 'volleyball') {
      const kind = String(req.query.market || 'winner').toLowerCase();
      if (!['winner','totals','sets'].includes(kind)) {
        return res.status(400).json({ error: 'volleyball market must be one of: winner, totals, sets' });
      }
      const payload = await loadVolleyballMarket(kind);
      res.set('Cache-Control', 'public, max-age=60');
      return res.json(payload);
    }
    const cfg = SPORT_CONFIG[sport];
    if (!cfg) {
      return res.status(400).json({ error: `sport must be one of: ${[...Object.keys(SPORT_CONFIG),'handball'].join(', ')}` });
    }
    const kind = String(req.query.market || cfg.defaultMarket).toLowerCase();
    if (!cfg.markets[kind]) {
      return res.status(400).json({ error: `market must be one of: ${Object.keys(cfg.markets).join(', ')}` });
    }
    const payload = await loadSportyBetMarket(kind, sport);
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload);
  } catch (err) {
    console.error('SportyBet sport odds error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to load SportyBet sport odds',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

// Automatic slip builder. It can scan one sport only or all supported sports.
// Football uses Poisson + H2H probability; basketball/hockey use no-vig market probability.
function normalizeSportScope(value) {
  const v = String(value || 'all').toLowerCase().replace(/\s+/g, '');
  if (v === 'icehockey' || v === 'ice-hockey') return 'hockey';
  return ['all', 'football', 'basketball', 'hockey', 'handball', 'volleyball', 'tennis'].includes(v) ? v : 'all';
}

function normalizeSportScopes(value) {
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    const v = String(item || '').toLowerCase().replace(/\s+/g, '');
    const n = (v === 'icehockey' || v === 'ice-hockey') ? 'hockey' : v;
    if (n === 'all') return ['football','basketball','hockey','handball','volleyball','tennis'];
    if (['football','basketball','hockey','handball','volleyball','tennis'].includes(n) && !out.includes(n)) out.push(n);
  }
  return out.length ? out : ['football','basketball','hockey','handball','volleyball','tennis'];
}


function cornerBetRequested(betTypes) {
  return Array.isArray(betTypes) && betTypes.some(x => {
    const t=String(x || '');
    return ['corners_over','corners_under','first_half_home_team_corners','first_half_away_team_corners'].includes(t)
      || t.startsWith('first_half_home_corners_') || t.startsWith('first_half_away_corners_');
  });
}

function fixtureKey(r) {
  const n=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
    .replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g,'').replace(/[^a-z0-9]+/g,'');
  return `${n(r?.home)}|${n(r?.away)}|${String(r?.kickoffUtc||'').slice(0,10)}`;
}

async function addOnDemandCornerModels(predictions, f1x2, fcorners, f1hteamcorners, hours) {
  if (!process.env.API_FOOTBALL_KEY && !process.env.API_FOOTBALL_API_KEY) {
    console.warn('[API-Football] corner request skipped: API_FOOTBALL_KEY is not configured');
    return predictions;
  }

  const matches=Array.isArray(predictions?.matches)?predictions.matches:[];
  // Match API-Football from the ACTUAL SportyBet corner feeds.
  // Do not intersect with the separate 1X2 feed first: different SportyBet scraper
  // endpoints can expose different event-id namespaces even for the same fixture.
  let sporty=[...(fcorners?.rows||[]),...(f1hteamcorners?.rows||[])];
  if(!sporty.length) sporty=[...(f1x2?.rows||[])];

  const seen=new Set();
  sporty=sporty.filter(x=>{
    const eventId=String(x.eventId||'');
    const key=eventId || `${String(x.home||'')}|${String(x.away||'')}|${String(x.kickoffUtc||'')}`;
    if(!key || seen.has(key)) return false;
    seen.add(key);
    return !!(x.home && x.away && x.kickoffUtc);
  }).slice(0,Math.max(1,Math.min(50,parseInt(process.env.API_FOOTBALL_ON_DEMAND_CORNER_FIXTURES||'20',10))));

  if(!sporty.length){
    console.warn('[API-Football] corner request skipped: no usable SportyBet corner fixtures with home/away/kickoff');
    return predictions;
  }

  console.log(`[API-Football] on-demand corner enrichment starting for ${sporty.length} SportyBet fixtures`);
  const apiRows=await enrichSportyFixtures(sporty,{
    daysAhead:Math.max(1,Math.ceil(Number(hours||120)/24)),
    maxFixtures:sporty.length,
    cornerEventIds:new Set(sporty.map(x=>String(x.eventId||'')))
  });

  const byKey=new Map(apiRows.filter(x=>x?.corners).map(x=>[fixtureKey(x),x]));
  let attached=0;
  for(const old of matches){
    if(Number(old?.corners?.totalLambda||0)>0) continue;
    const hit=byKey.get(fixtureKey(old));
    if(hit?.corners){old.corners=hit.corners;old.apiFootballFixtureId=hit.apiFootballFixtureId;attached++;}
  }
  const existing=new Set(matches.map(fixtureKey));
  let added=0;
  for(const r of apiRows){
    const k=fixtureKey(r);
    if(!existing.has(k)){existing.add(k);matches.push(r);added++;}
  }
  console.log(`[API-Football] on-demand corner enrichment complete: matched=${apiRows.length}, attached=${attached}, added=${added}`);
  return {...predictions,matches};
}


const AUTO_BET_TYPES_BY_SPORT = {
  football: ['home_win','draw','away_win','home_over05','away_over05','home_under45','away_under45','dc_1x','dc_x2','dnb','over05','over15','under45','gg_yes','ng_no','ah_0','ah_plus025','ah_minus025','corners_over','corners_under'],
  basketball: ['basketball_winner','basketball_over','basketball_under'],
  hockey: ['hockey_winner','hockey_over','hockey_under'],
  handball: ['handball_winner','handball_over','handball_under'],
  volleyball: ['volleyball_winner','volleyball_over','volleyball_under','volleyball_sets_over','volleyball_sets_under'],
  tennis: ['tennis_winner','tennis_over','tennis_under','tennis_handicap_home','tennis_handicap_away'],
};

function normalizeAutoBetTypesForSports(sports, betTypes) {
  const selected = Array.isArray(sports) ? sports : normalizeSportScopes(sports);
  const compatible = new Set(selected.flatMap(s => AUTO_BET_TYPES_BY_SPORT[s] || []));
  const incoming = Array.isArray(betTypes) ? betTypes.map(String) : [];

  // Critical compatibility behavior:
  // old browsers may have localStorage saved before Handball/Volleyball existed.
  // If none of the stored bet types belongs to the currently selected sports,
  // automatically enable every supported market for those sports instead of
  // returning an empty candidate pool.
  const filtered = incoming.filter(id => compatible.has(id));
  if (filtered.length) return filtered;
  return [...compatible];
}

async function loadAutoCandidates({ sportScope = 'all', sports = null, minProbability = 55, minEdge = 0, leagues = null, betTypes = null, marketHours = null, marketMaxPages = null, marketCacheOnly = false } = {}) {
  const selectedSports = normalizeSportScopes(Array.isArray(sports) && sports.length ? sports : sportScope);
  const selectedSet = new Set(selectedSports);
  const wantsFootball = selectedSet.has('football');
  const wantsBasketball = selectedSet.has('basketball');
  const wantsHockey = selectedSet.has('hockey');
  const wantsHandball = selectedSet.has('handball');
  const wantsVolleyball = selectedSet.has('volleyball');
  const wantsTennis = selectedSet.has('tennis');

  // Fetch only the market families actually requested. Previously, even a one-market
  // Analyzer request could fan out to every football/basketball/hockey market.
  const effectiveBetTypes = normalizeAutoBetTypesForSports(selectedSports, betTypes);
  const requestedBetTypes = effectiveBetTypes.length ? new Set(effectiveBetTypes) : null;
  const wantsAny = ids => !requestedBetTypes || ids.some(id => requestedBetTypes.has(id));
  const needF1x2 = wantsFootball && wantsAny(['home_win','draw','away_win']);
  const needFGg = wantsFootball && wantsAny(['gg_yes','ng_no']);
  const needFDc = wantsFootball && wantsAny(['dc_1x','dc_x2']);
  const needFDnb = wantsFootball && wantsAny(['dnb']);
  const needFOu05 = wantsFootball && wantsAny(['over05']);
  const needFHomeOu05 = wantsFootball && wantsAny(['home_over05']);
  const needFAwayOu05 = wantsFootball && wantsAny(['away_over05']);
  const needFHomeOu45 = wantsFootball && wantsAny(['home_under45']);
  const needFAwayOu45 = wantsFootball && wantsAny(['away_under45']);
  const needFOu15 = wantsFootball && wantsAny(['over15']);
  const needFOu45 = wantsFootball && wantsAny(['under45']);
  const needFAh = wantsFootball && wantsAny(['ah_0','ah_plus025','ah_minus025']);
  const needFCorners = wantsFootball && wantsAny(['corners_over','corners_under']);
  const needF1hCorners = false;
  const needFOneup = false;
  const needBasketballWinner = wantsBasketball && wantsAny(['basketball_winner']);
  const needBasketballTotals = wantsBasketball && wantsAny(['basketball_over','basketball_under']);
  const needHockeyWinner = wantsHockey && wantsAny(['hockey_winner']);
  const needHockeyTotals = wantsHockey && wantsAny(['hockey_over','hockey_under']);
  const needHandballWinner = wantsHandball && wantsAny(['handball_winner']);
  const needHandballTotals = wantsHandball && wantsAny(['handball_over','handball_under']);
  const needVolleyballWinner = wantsVolleyball && wantsAny(['volleyball_winner']);
  const needVolleyballTotals = wantsVolleyball && wantsAny(['volleyball_over','volleyball_under']);
  const needVolleyballSets = wantsVolleyball && wantsAny(['volleyball_sets_over','volleyball_sets_under']);
  const needTennisWinner = wantsTennis && wantsAny(['tennis_winner']);
  const needTennisTotals = wantsTennis && wantsAny(['tennis_over','tennis_under']);
  const needTennisHandicap = wantsTennis && wantsAny(['tennis_handicap_home','tennis_handicap_away']);

  // The general sportsbook cache may live for hours to save API credits, but the Auto Builder
  // needs much fresher availability data so expired events cannot remain eligible.
  const autoMaxCacheAgeSeconds = Math.max(0, parseInt(process.env.AUTO_SPORTYBET_MAX_CACHE_AGE_SECONDS || '43200', 10));
  const autoMarketOptions = {
    hours: marketHours || undefined,
    maxPages: marketMaxPages || undefined,
    maxCacheAgeSeconds: autoMaxCacheAgeSeconds,
    kickoffBufferSeconds: Math.max(0, parseInt(process.env.SPORTYBET_KICKOFF_BUFFER_SECONDS || '60', 10)),
    cacheOnly: !!marketCacheOnly,
  };

  // Do not let one unavailable Parse.bot market family kill the complete Auto/Telegram pool.
  // This is particularly important for corners: the managed NG API may return zero corner rows
  // and older code then falls back to full-market endpoints that may not exist on the current
  // single Parse API subscription.
  const safeMarket = async (label, enabled, fn, emptyValue = { rows: [] }) => {
    if (!enabled) return emptyValue;
    try {
      return await fn();
    } catch (err) {
      console.error(`[Auto candidates] ${label} unavailable: ${err.message}`);
      return { ...emptyValue, rows: Array.isArray(emptyValue.rows) ? emptyValue.rows : [], error: err.message };
    }
  };

  // Read the existing prediction cache first. Its SportyBet event IDs let us
  // inspect exactly the fixtures the model knows about, avoiding a costly and
  // largely irrelevant sweep through the first games on the bookmaker site.
  let predictions = await safeMarket('football predictions', wantsFootball, () => loadPredictions(), { matches: [] });
  autoMarketOptions.fixtures = Array.isArray(predictions?.matches) ? predictions.matches : [];
  let [f1x2, fgg, fdc, fdnb, fou05, fhomeou05, fawayou05, fhomeou45, fawayou45, fou15, fou45, fah, fcorners, f1hteamcorners, foneup, basketballWinner, basketballTotals, hockeyWinner, hockeyTotals, handballWinner, handballTotals, volleyballWinner, volleyballTotals, volleyballSets, tennisWinner, tennisTotals, tennisHandicap] = await Promise.all([
    safeMarket('football 1X2', needF1x2, () => loadSportyBetMarket('1x2', 'football', autoMarketOptions)),
    safeMarket('football GG/NG', needFGg, () => loadSportyBetMarket('gg', 'football', autoMarketOptions)),
    safeMarket('football Double Chance', needFDc, () => loadSportyBetMarket('dc', 'football', autoMarketOptions)),
    safeMarket('football Draw No Bet', needFDnb, () => loadSportyBetMarket('dnb', 'football', autoMarketOptions)),
    safeMarket('football Over 0.5', needFOu05, () => loadSportyBetMarket('ou05', 'football', autoMarketOptions)),
    safeMarket('football Home Over 0.5', needFHomeOu05, () => loadSportyBetMarket('home_ou05', 'football', autoMarketOptions)),
    safeMarket('football Away Over 0.5', needFAwayOu05, () => loadSportyBetMarket('away_ou05', 'football', autoMarketOptions)),
    safeMarket('football Home Under 4.5', needFHomeOu45, () => loadSportyBetMarket('home_ou45', 'football', autoMarketOptions)),
    safeMarket('football Away Under 4.5', needFAwayOu45, () => loadSportyBetMarket('away_ou45', 'football', autoMarketOptions)),
    safeMarket('football Over 1.5', needFOu15, () => loadSportyBetMarket('ou15', 'football', autoMarketOptions)),
    safeMarket('football Under 4.5', needFOu45, () => loadSportyBetMarket('ou45', 'football', autoMarketOptions)),
    safeMarket('football Asian Handicap', needFAh, () => loadSportyBetMarket('ah', 'football', autoMarketOptions)),
    safeMarket('football Corners', needFCorners, () => loadSportyBetMarket('corners', 'football', autoMarketOptions)),
    safeMarket('football 1H team corners', needF1hCorners, () => loadSportyBetMarket('first_half_team_corners', 'football', autoMarketOptions)),
    safeMarket('football 1UP', needFOneup, () => loadSportyBetMarket('oneup', 'football', autoMarketOptions)),
    safeMarket('basketball winner', needBasketballWinner, () => loadSportyBetMarket('winner', 'basketball', autoMarketOptions)),
    safeMarket('basketball totals', needBasketballTotals, () => loadSportyBetMarket('totals', 'basketball', autoMarketOptions)),
    safeMarket('hockey winner', needHockeyWinner, () => loadSportyBetMarket('winner', 'hockey', autoMarketOptions)),
    safeMarket('hockey totals', needHockeyTotals, () => loadSportyBetMarket('totals', 'hockey', autoMarketOptions)),
    safeMarket('handball winner', needHandballWinner, () => loadHandballMarket('winner')),
    safeMarket('handball totals', needHandballTotals, () => loadHandballMarket('totals')),
    safeMarket('volleyball winner', needVolleyballWinner, () => loadVolleyballMarket('winner')),
    safeMarket('volleyball totals', needVolleyballTotals, () => loadVolleyballMarket('totals')),
    safeMarket('volleyball total sets', needVolleyballSets, () => loadVolleyballMarket('sets')),
    safeMarket('tennis winner', needTennisWinner, () => loadTennisMarket('winner')),
    safeMarket('tennis totals', needTennisTotals, () => loadTennisMarket('totals')),
    safeMarket('tennis handicap', needTennisHandicap, () => loadTennisMarket('handicap')),
  ]);

  if (wantsFootball && cornerBetRequested(betTypes)) {
    try {
      predictions = await addOnDemandCornerModels(predictions, f1x2, fcorners, f1hteamcorners, marketHours);
    } catch (err) {
      console.error('[API-Football] on-demand corner enrichment failed:', err.message);
    }
  }

  const teamGoalAvailability = Object.fromEntries([
    ['home_ou05',fhomeou05],['away_ou05',fawayou05],
    ['home_ou45',fhomeou45],['away_ou45',fawayou45],
  ].filter(([,payload]) => payload?.teamGoalDiagnostics || payload?.error)
    .map(([kind,payload]) => [kind, {
      rows:payload?.rows?.length || 0,
      status:payload?.teamGoalDiagnostics?.status || 'fetch_error',
      scannedEvents:payload?.teamGoalDiagnostics?.scannedEvents || 0,
      eligibleFixtures:payload?.teamGoalDiagnostics?.eligibleFixtures || 0,
      modeledFixtures:(predictions?.matches || []).filter(r => {
        const field={home_ou05:'homeO05',away_ou05:'awayO05',home_ou45:'homeU45',away_ou45:'awayU45'}[kind];
        return r?.[field] != null && Number.isFinite(Number(r[field]));
      }).length,
      detail:payload?.error || payload?.teamGoalDiagnostics?.errors?.[0] || null,
    }]));

  const candidates = buildCandidates({
    predictions,
    footballMarkets: { '1x2': f1x2, gg: fgg, dc: fdc, dnb: fdnb, ou05: fou05, home_ou05: fhomeou05, away_ou05: fawayou05, home_ou45: fhomeou45, away_ou45: fawayou45, ou15: fou15, ou45: fou45, ah: fah, corners: fcorners, first_half_team_corners: f1hteamcorners, oneup: foneup },
    basketballWinner,
    basketballTotals,
    hockeyWinner,
    hockeyTotals,
    handballWinner,
    handballTotals,
    volleyballWinner,
    volleyballTotals,
    volleyballSets,
    tennisWinner,
    tennisTotals,
    tennisHandicap,
    minProbability,
    minEdge,
    leagues,
    sportScope: 'all',
    betTypes: effectiveBetTypes,
  }).filter(c => {
    const sportName = String(c?.sport || '').toLowerCase();
    if (sportName.includes('football') || sportName.includes('soccer')) return selectedSet.has('football');
    if (sportName.includes('basket')) return selectedSet.has('basketball');
    if (sportName.includes('hockey')) return selectedSet.has('hockey');
    if (sportName.includes('handball')) return selectedSet.has('handball');
    if (sportName.includes('volleyball')) return selectedSet.has('volleyball');
    if (sportName.includes('tennis')) return selectedSet.has('tennis');
    return false;
  });
  // Preserve source diagnostics through the shared Website/Telegram pipeline.
  // No API credentials or raw bookmaker payloads are returned to the browser.
  candidates.teamGoalAvailability = teamGoalAvailability;
  return candidates;
}



function fixtureDateKeyInTimeZone(value, timeZone = 'Africa/Lagos') {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = type => parts.find(x => x.type === type)?.value || '';
  const y=get('year'), m=get('month'), day=get('day');
  return y && m && day ? `${y}-${m}-${day}` : null;
}

function isCandidateToday(candidate, { now = new Date(), timeZone = 'Africa/Lagos' } = {}) {
  const kickoffKey = fixtureDateKeyInTimeZone(candidate?.kickoffUtc, timeZone);
  const todayKey = fixtureDateKeyInTimeZone(now, timeZone);
  return !!kickoffKey && kickoffKey === todayKey;
}

async function prepareAutoCandidatePool({
  sportScope='all',
  minProbability=0,
  minEdge=0,
  leagues=null,
  betTypes=null,
  maxMatchOdds=null,
  marketHours=null,
  marketMaxPages=null,
  todayOnly=false,
} = {}) {
  // Single source of truth for Website + Telegram AI candidate eligibility.
  // Keeping the complete filtering path here prevents one surface from finding
  // selections while another reports zero for the same settings.
  const selectedSports = normalizeSportScopes(sportScope);
  const sport = selectedSports.length === 6 ? 'all' : (selectedSports.length === 1 ? selectedSports[0] : 'multi');
  const probabilityFloor = Math.min(95, Math.max(0, Number(minProbability) || 0));
  const edgeFloor = Math.min(50, Math.max(-25, Number(minEdge) || 0));

  const rawCandidates = await loadAutoCandidates({
    sportScope: selectedSports,
    sports: selectedSports,
    minProbability: probabilityFloor,
    minEdge: edgeFloor,
    leagues,
    betTypes,
    marketHours,
    marketMaxPages,
  });

  const todayFiltered = todayOnly
    ? rawCandidates.filter(c => isCandidateToday(c, { timeZone: 'Africa/Lagos' }))
    : rawCandidates;
  const redFlagSafe = todayFiltered.filter(passesRedFlagFilter);
  const maxOdd = Number(maxMatchOdds);
  const oddsSafe = Number.isFinite(maxOdd) && maxOdd > 1
    ? redFlagSafe.filter(c => Number.isFinite(Number(c.odds)) && Number(c.odds) <= maxOdd)
    : redFlagSafe;

  return {
    sport,
    sports: selectedSports,
    candidates: oddsSafe,
    diagnostics: {
      sports: selectedSports,
      rawCandidates: rawCandidates.length,
      afterTodayFilter: todayFiltered.length,
      todayOnly: !!todayOnly,
      redFlagRejected: todayFiltered.length - redFlagSafe.length,
      afterRedFlag: redFlagSafe.length,
      afterMaxOdds: oddsSafe.length,
      minProbability: probabilityFloor,
      minEdge: edgeFloor,
      maxMatchOdds: Number.isFinite(maxOdd) && maxOdd > 1 ? maxOdd : null,
      betTypes: Array.isArray(betTypes) ? betTypes.map(String) : null,
      teamGoalAvailability: rawCandidates.teamGoalAvailability || {},
    },
  };
}


function analyzerNormText(v) {
  return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function analyzerNormTeam(v) {
  return analyzerNormText(v).replace(/\b(fc|cf|afc|sc|ssc|club|football|futbol|calcio)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

function analyzerTeamMatch(a, b) {
  const x = analyzerNormTeam(a), y = analyzerNormTeam(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 6 && (x.includes(y) || y.includes(x)));
}


function findSavedPredictionForAnalyzerLeg(leg, predictions) {
  const rows=Array.isArray(predictions?.matches)?predictions.matches:[];
  if(leg?.eventId){
    const exact=rows.find(r=>String(r?.sportyEventId||r?.eventId||'')===String(leg.eventId));
    if(exact) return exact;
  }
  return rows.find(r=>analyzerTeamMatch(leg?.home,r?.home)&&analyzerTeamMatch(leg?.away,r?.away)) || null;
}

function directSavedFootballAnalyzerCandidate(leg, prediction) {
  if(!prediction || !Number.isFinite(Number(leg?.odds)) || Number(leg.odds)<=1) return null;
  const text=analyzerNormText(`${leg.marketDesc||''} ${leg.outcomeDesc||''} ${leg.specifier||''}`);
  let probability=null, betType=null, probabilitySource=null;

  if(/over 0 5/.test(text) || /total 0 5/.test(text) && /over/.test(text)){
    const market=analyzerNormText(leg.marketDesc||'');
    const side=/\bhome\b/.test(market)?'home':/\baway\b/.test(market)?'away':null;
    probability=side==='home'?Number(prediction.homeO05):side==='away'?Number(prediction.awayO05):Number(prediction.o05);
    betType=side==='home'?'home_over05':side==='away'?'away_over05':'over05';
    // Do not treat a missing saved team-goals model as a zero/guessed probability.
    if(side && prediction[side==='home'?'homeO05':'awayO05']==null)return null;
  } else if(/over 1 5/.test(text) || /total 1 5/.test(text) && /over/.test(text)){
    probability=Number(prediction.o15); betType='over15';
  } else if(/under 4 5/.test(text) || /total 4 5/.test(text) && /under/.test(text)){
    const market=analyzerNormText(leg.marketDesc||'');
    const side=/\bhome\b/.test(market)?'home':/\baway\b/.test(market)?'away':null;
    if(side && prediction[side==='home'?'homeU45':'awayU45']==null)return null;
    probability=side==='home'?Number(prediction.homeU45):side==='away'?Number(prediction.awayU45):Number(prediction.u45);
    betType=side==='home'?'home_under45':side==='away'?'away_under45':'under45';
  }

  if(!betType || !Number.isFinite(probability) || probability<=0) return null;
  probabilitySource=String(prediction.dataSource||prediction.source||'Saved daily prediction');
  const metrics=normalMetrics(Number(leg.odds),probability);
  const edgeScore=Math.max(0,Math.min(100,50+Number(metrics.edge||0)*4));
  const qualityScore=Math.round((Math.max(0,Math.min(100,probability))*0.55 + edgeScore*0.25 + 92*0.20)*10)/10;
  return {
    ...leg,
    eventId:String(leg.eventId||prediction.sportyEventId||prediction.eventId||''),
    sport:leg.sport||'Football',
    home:leg.home||prediction.home,
    away:leg.away||prediction.away,
    tournament:leg.tournament||prediction.league||'',
    kickoffUtc:prediction.kickoffUtc||null,
    betType,
    probabilitySource:`${probabilitySource} · daily cache`,
    ...metrics,
    qualityScore,
    marketReliability:92,
    supported:true,
  };
}

function extractBookingOutcomes(booking) {
  if (!booking || typeof booking !== 'object') return [];
  for (const key of ['outcomes', 'selections', 'bets', 'items']) {
    if (Array.isArray(booking[key])) return booking[key];
  }
  if (booking.data && typeof booking.data === 'object') return extractBookingOutcomes(booking.data);
  return [];
}

function normalizeBookingLeg(row) {
  const home = row.homeTeamName ?? row.home_team ?? row.homeTeam ?? row.home ?? '';
  const away = row.awayTeamName ?? row.away_team ?? row.awayTeam ?? row.away ?? '';
  return {
    sport: String(row.sport ?? row.sport_name ?? ''),
    eventId: String(row.eventId ?? row.event_id ?? row.matchId ?? row.match_id ?? ''),
    home: String(home),
    away: String(away),
    tournament: String(row.tournament ?? row.tournament_name ?? row.league ?? ''),
    marketId: String(row.marketId ?? row.market_id ?? ''),
    marketDesc: String(row.marketDesc ?? row.market_name ?? row.market ?? row.bet_market ?? ''),
    outcomeId: String(row.outcomeId ?? row.outcome_id ?? ''),
    outcomeDesc: String(row.selectedOutcome ?? row.selected_outcome ?? row.outcomeDesc ?? row.outcome_name ?? row.outcome ?? row.pick ?? ''),
    odds: Number(row.odds ?? row.price ?? row.selection_odds) || null,
    specifier: row.specifier ?? row.market_specifier ?? null,
  };
}

function analyzerCandidateScore(leg, c) {
  let score = 0;
  if (leg.eventId && c.eventId && leg.eventId === String(c.eventId)) score += 60;
  if (leg.marketId && c.marketId && leg.marketId === String(c.marketId)) score += 18;
  if (leg.outcomeId && c.outcomeId && leg.outcomeId === String(c.outcomeId)) score += 18;
  if (leg.specifier && c.specifier && analyzerNormText(leg.specifier) === analyzerNormText(c.specifier)) score += 10;
  if (analyzerTeamMatch(leg.home, c.home) && analyzerTeamMatch(leg.away, c.away)) score += 28;
  if (analyzerNormText(leg.marketDesc) && analyzerNormText(c.marketDesc).includes(analyzerNormText(leg.marketDesc))) score += 8;
  const lo = analyzerNormText(leg.outcomeDesc), co = analyzerNormText(c.outcomeDesc);
  if (lo && co && (lo === co || lo.includes(co) || co.includes(lo))) score += 14;
  const legOdds = Number(leg.odds), candOdds = Number(c.odds);
  if (Number.isFinite(legOdds) && Number.isFinite(candOdds)) {
    const diff = Math.abs(legOdds - candOdds);
    if (diff <= 0.005) score += 24;
    else if (diff <= 0.02) score += 18;
    else if (diff <= 0.05) score += 10;
  }
  return score;
}

function isGenericAnalyzerSelection(v) {
  const n = analyzerNormText(v);
  return !n || n === 'selection' || n === 'pick' || n === 'outcome';
}

function isAnalyzerOverUnderMarket(v) {
  const n = analyzerNormText(v);
  return n.includes('over under') || n === 'ou' || n.includes('total goals');
}

// Some get_booking payloads identify the event/market correctly but return only
// the generic word "Selection" for the chosen O/U outcome. Resolve those rows
// against SportyBet's actual Over 1.5 market before the probability-model match.
function resolveGenericOver15Leg(leg, over15Rows) {
  if (!isAnalyzerOverUnderMarket(leg.marketDesc) || !isGenericAnalyzerSelection(leg.outcomeDesc)) {
    return { ...leg, analyzerResolved: false };
  }

  const rows = Array.isArray(over15Rows) ? over15Rows : [];
  let pool = [];
  if (leg.eventId) pool = rows.filter(r => String(r.eventId || '') === String(leg.eventId));
  if (!pool.length) {
    pool = rows.filter(r => analyzerTeamMatch(leg.home, r.home) && analyzerTeamMatch(leg.away, r.away));
  }
  pool = pool.filter(r => {
    const out = analyzerNormText(r.outcomeDesc);
    const spec = analyzerNormText(r.specifier);
    return out.includes('over') && (out.includes('1 5') || spec.includes('total 1 5'));
  });
  if (!pool.length) return { ...leg, analyzerResolved: false };

  const targetOdds = Number(leg.odds);
  pool.sort((a, b) => {
    if (!Number.isFinite(targetOdds)) return 0;
    return Math.abs(Number(a.odds) - targetOdds) - Math.abs(Number(b.odds) - targetOdds);
  });
  const hit = pool[0];
  return {
    ...leg,
    eventId: String(hit.eventId || leg.eventId || ''),
    marketId: String(hit.marketId || leg.marketId || ''),
    outcomeId: String(hit.outcomeId || leg.outcomeId || ''),
    specifier: hit.specifier || 'total=1.5',
    marketDesc: hit.marketDesc || leg.marketDesc || 'Over/Under',
    outcomeDesc: 'Over 1.5',
    // Keep the booked ticket price on screen; current market identifiers are used for matching/re-booking.
    odds: Number(leg.odds) || Number(hit.odds) || null,
    analyzerResolved: true,
    analyzerResolution: 'Resolved generic SportyBet O/U selection as Over 1.5 from the event market',
  };
}

function bookingMetaNumber(booking, keys) {
  for (const k of keys) {
    const n = Number(booking?.[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function analyzerBetTypesFromBooking(rows, sportScope) {
  const set = new Set();
  let uncertain = false;
  for (const leg of rows || []) {
    const text = analyzerNormText(`${leg.marketDesc || ''} ${leg.outcomeDesc || ''} ${leg.specifier || ''}`);
    if (sportScope === 'basketball') {
      if (/over/.test(text)) set.add('basketball_over');
      else if (/under/.test(text)) set.add('basketball_under');
      else if (/winner|moneyline|money line|match winner|home|away/.test(text)) set.add('basketball_winner');
      else uncertain = true;
      continue;
    }
    if (sportScope === 'hockey') {
      if (/over/.test(text)) set.add('hockey_over');
      else if (/under/.test(text)) set.add('hockey_under');
      else if (/winner|moneyline|money line|match winner|home|away/.test(text)) set.add('hockey_winner');
      else uncertain = true;
      continue;
    }
    if (sportScope === 'football') {
      if (/corner/.test(text)) {
        if (/1st half|first half|1h/.test(text)) {
          set.add('corners_over'); set.add('corners_under');
        } else { set.add('corners_over'); set.add('corners_under'); }
      } else if (/over 0 5/.test(text)) {
        if (/\bhome\b/.test(analyzerNormText(leg.marketDesc))) set.add('home_over05');
        else if (/\baway\b/.test(analyzerNormText(leg.marketDesc))) set.add('away_over05');
        else set.add('over05');
      }
      else if (/over 1 5/.test(text)) set.add('over15');
      else if (/under 4 5/.test(text)) {
        const market=analyzerNormText(leg.marketDesc);
        if (/\bhome\b/.test(market)) set.add('home_under45');
        else if (/\baway\b/.test(market)) set.add('away_under45');
        else set.add('under45');
      }
      else if (/both teams to score|btts| gg /.test(` ${text} `)) { set.add('gg_yes'); set.add('ng_no'); }
      else if (/double chance|1x|x2/.test(text)) { set.add('dc_1x'); set.add('dc_x2'); }
      else if (/draw no bet|dnb/.test(text)) set.add('dnb');
      else if (/asian handicap|handicap/.test(text)) { set.add('ah_0'); set.add('ah_plus025'); set.add('ah_minus025'); }
      else if (/1x2|match result|home win|away win|draw/.test(text)) { set.add('home_win'); set.add('draw'); set.add('away_win'); }
      else if (isAnalyzerOverUnderMarket(leg.marketDesc) && isGenericAnalyzerSelection(leg.outcomeDesc)) {
        set.add('over15'); // known SportyBet get_booking repair path
      } else uncertain = true;
    } else {
      uncertain = true;
    }
  }
  // If any leg is ambiguous, use the full sport set for correctness rather than guessing.
  if (uncertain || !set.size) return null;
  return [...set];
}

app.post('/api/sportybet/replace-unsupported', express.json(), async (req, res) => {
  try {
    const minProbability = Math.min(95, Math.max(0, Number(req.body?.minProbability) || 55));
    const horizonDays = [7, 14, 21].includes(Number(req.body?.horizonDays)) ? Number(req.body.horizonDays) : 14;
    const analyzerHours = horizonDays * 24;
    const analyzedInput = Array.isArray(req.body?.analyzed) ? req.body.analyzed.slice(0, 50) : [];
    if (!analyzedInput.length) return res.status(400).json({ error: 'Run the booking-code analysis first' });

    const decodedSports = analyzedInput.map(x => analyzerNormText(x.sport)).filter(Boolean);
    let sportScope = 'all';
    if (decodedSports.length && decodedSports.every(x => x.includes('football') || x.includes('soccer'))) sportScope = 'football';
    else if (decodedSports.length && decodedSports.every(x => x.includes('basket'))) sportScope = 'basketball';
    else if (decodedSports.length && decodedSports.every(x => x.includes('hockey') || x.includes('ice hockey'))) sportScope = 'hockey';

    // IMPORTANT: replacement is cache-only. It must never buy fresh Parse.bot market pages.
    // We need real cached SportyBet market/outcome IDs so a replacement can later be booked.
    const candidates = await loadAutoCandidates({
      sportScope,
      minProbability: 0,
      minEdge: -25,
      leagues: null,
      betTypes: null,
      marketHours: analyzerHours,
      marketMaxPages: 2,
      marketCacheOnly: true,
    });

    let replacedCount = 0;
    const analyzed = analyzedInput.map((leg, index) => {
      if (leg?.supported) return { ...leg, index };
      const replacement = telegramAnalyzerReplacementFor(leg, candidates, minProbability);
      if (!replacement) return { ...leg, index, replaced: false };
      replacedCount++;
      return {
        ...leg,
        index,
        supported: true,
        qualified: true,
        replaced: true,
        originalMarketDesc: leg.marketDesc || '',
        originalOutcomeDesc: leg.outcomeDesc || '',
        originalOdds: Number(leg.odds) || null,
        eventId: String(replacement.eventId || leg.eventId || ''),
        marketId: String(replacement.marketId || ''),
        outcomeId: String(replacement.outcomeId || ''),
        specifier: replacement.specifier || null,
        sport: replacement.sport || leg.sport || '',
        home: replacement.home || leg.home || '',
        away: replacement.away || leg.away || '',
        tournament: replacement.tournament || leg.tournament || '',
        marketDesc: replacement.marketDesc || '',
        outcomeDesc: replacement.outcomeDesc || '',
        odds: Number(replacement.odds) || null,
        probability: Number(replacement.probability) || 0,
        probabilitySource: replacement.probabilitySource || '',
        impliedProbability: Number(replacement.impliedProbability) || null,
        edge: Number(replacement.edge) || 0,
        expectedValuePct: Number(replacement.expectedValuePct) || 0,
        qualityScore: Number(replacement.qualityScore) || null,
        fairOdds: Number(replacement.fairOdds) || null,
        fullWinProbability: Number(replacement.fullWinProbability) || null,
        nonLossProbability: Number(replacement.nonLossProbability) || null,
        settlementNote: replacement.settlementNote || '',
        reason: `Replaced unsupported selection from saved/cached data on the same fixture; meets ${minProbability}% minimum`,
        replacementReason: 'Same-fixture cached replacement',
      };
    });

    const qualifiedSelections = analyzed.filter(x => x.supported && x.qualified);
    const filteredOdds = qualifiedSelections.reduce((p, x) => p * (Number(x.odds) || 1), 1);
    return res.json({
      ...req.body,
      minProbability,
      horizonDays,
      analyzed,
      supportedCount: analyzed.filter(x => x.supported).length,
      qualifiedCount: qualifiedSelections.length,
      qualifiedSelections,
      filteredCombinedOdds: Math.round(filteredOdds * 100) / 100,
      replacedCount,
      unsupportedCount: analyzed.filter(x => !x.supported).length,
      replacementCacheOnly: true,
      replacementNote: replacedCount
        ? `${replacedCount} unsupported selection${replacedCount === 1 ? '' : 's'} replaced from saved data on the same fixture.`
        : 'No safe same-fixture cached replacement met the current probability/red-flag rules.',
    });
  } catch (err) {
    console.error('Website analyzer replacement error:', err.code || '', err.message);
    return res.status(500).json({ error: 'Could not replace unsupported selections', detail: err.message });
  }
});

app.post('/api/sportybet/analyze-code', express.json(), async (req, res) => {
  try {
    const bookingCode = String(req.body?.bookingCode || '').trim().toUpperCase();
    const minProbability = Math.min(95, Math.max(0, Number(req.body?.minProbability) || 55));
    const horizonDays = [7, 14, 21].includes(Number(req.body?.horizonDays)) ? Number(req.body.horizonDays) : Math.max(7, Math.min(21, parseInt(process.env.ANALYZER_DAYS || '14', 10)));
    const analyzerHours = horizonDays * 24;
    const analyzerMaxPages = Math.max(1, Math.min(4, parseInt(process.env.ANALYZER_MAX_PAGES || '2', 10)));
    if (!bookingCode) return res.status(400).json({ error: 'Enter a SportyBet booking code' });

    const startedAt = Date.now();
    console.log(`[Analyzer] start code=${bookingCode} horizon=${horizonDays}d`);
    const booking = await getBooking(bookingCode);
    console.log(`[Analyzer] booking loaded in ${Date.now()-startedAt}ms`);
    const decodedRows = extractBookingOutcomes(booking).map(normalizeBookingLeg).filter(x => x.home || x.away || x.eventId);
    if (!decodedRows.length) return res.status(404).json({ error: 'The booking code was found, but no selections could be read from it' });

    // Determine sport BEFORE loading extra markets. The old path always loaded football
    // Over 1.5 even for Basketball/Hockey codes, adding unnecessary latency/failure risk.
    const decodedSports = decodedRows.map(x => analyzerNormText(x.sport)).filter(Boolean);
    let analyzerSportScope = 'all';
    if (decodedSports.length && decodedSports.every(x => x.includes('football') || x.includes('soccer'))) analyzerSportScope = 'football';
    else if (decodedSports.length && decodedSports.every(x => x.includes('basket'))) analyzerSportScope = 'basketball';
    else if (decodedSports.length && decodedSports.every(x => x.includes('hockey') || x.includes('ice hockey'))) analyzerSportScope = 'hockey';

    const needsOver15Repair = analyzerSportScope === 'football' && decodedRows.some(
      leg => isAnalyzerOverUnderMarket(leg.marketDesc) && isGenericAnalyzerSelection(leg.outcomeDesc)
    );
    const analyzerOver15 = needsOver15Repair
      ? await loadSportyBetMarket('ou15', 'football', { hours: analyzerHours, maxPages: analyzerMaxPages })
      : { rows: [] };
    let sourceRows = decodedRows.map(leg => resolveGenericOver15Leg(leg, analyzerOver15?.rows));

    // Secondary repair for a known get_booking quirk: some legs on the same ticket expose
    // "Over 1.5" while others expose only "Selection". If every explicit O/U pick on this
    // booking is Over 1.5 and there are no conflicting O/U outcomes, classify the remaining
    // generic O/U legs as Over 1.5 for model matching. Re-booking identifiers still come only
    // from a real matched SportyBet candidate below, never from this inference alone.
    const explicitOu = decodedRows
      .filter(x => isAnalyzerOverUnderMarket(x.marketDesc) && !isGenericAnalyzerSelection(x.outcomeDesc))
      .map(x => analyzerNormText(x.outcomeDesc));
    const consistentOver15 = explicitOu.length > 0 && explicitOu.every(x => x.includes('over') && x.includes('1 5'));
    if (consistentOver15) {
      sourceRows = sourceRows.map(leg => {
        if (!isAnalyzerOverUnderMarket(leg.marketDesc) || !isGenericAnalyzerSelection(leg.outcomeDesc) || leg.analyzerResolved) return leg;
        return {
          ...leg,
          marketId: leg.marketId || '18',
          specifier: leg.specifier || 'total=1.5',
          outcomeDesc: 'Over 1.5',
          analyzerResolved: true,
          analyzerResolution: 'Resolved as Over 1.5 from the consistent Over 1.5 pattern in this booking code',
        };
      });
    }

    // Build the complete supported candidate universe with filtering disabled. The Analyzer
    // then applies the user's chosen probability threshold to the exact imported selections.
    // Do not fan out to every sport when the imported booking clearly identifies one sport.
    // On Render, loading football + basketball + hockey across a 14/21-day analyzer horizon
    // can create many simultaneous upstream requests and the proxy may close the connection,
    // which the browser reports only as "NetworkError when attempting to fetch resource".
    const analyzerBetTypes = analyzerBetTypesFromBooking(sourceRows, analyzerSportScope);
    console.log(`[Analyzer] scope=${analyzerSportScope} legs=${sourceRows.length} betTypes=${analyzerBetTypes ? analyzerBetTypes.join(',') : 'all-supported'}`);

    // First score common football goal lines directly from the Daily Predictions cache.
    // This avoids repurchasing SportyBet market pages simply to score a booked Over 0.5/
    // Over 1.5/Under 4.5 selection. Imported booking identifiers remain untouched.
    const savedPredictions = analyzerSportScope === 'football' || analyzerSportScope === 'all'
      ? await loadPredictions()
      : { matches: [] };
    const directSaved = sourceRows.map(leg => {
      if(analyzerSportScope!=='football' && analyzerSportScope!=='all') return null;
      const p=findSavedPredictionForAnalyzerLeg(leg,savedPredictions);
      return directSavedFootballAnalyzerCandidate(leg,p);
    });
    const needsCandidateLookup = directSaved.some(x=>!x);

    const candidateStartedAt = Date.now();
    const candidates = needsCandidateLookup ? await loadAutoCandidates({
      sportScope: analyzerSportScope,
      minProbability: 0,
      minEdge: -25,
      leagues: null,
      betTypes: analyzerBetTypes,
      marketHours: analyzerHours,
      marketMaxPages: analyzerMaxPages
    }) : [];
    console.log(`[Analyzer] direct-cache=${directSaved.filter(Boolean).length}/${sourceRows.length} candidates=${candidates.length} loaded in ${Date.now()-candidateStartedAt}ms total=${Date.now()-startedAt}ms`);
    const analyzed = sourceRows.map((leg, index) => {
      const direct=directSaved[index];
      if(direct){
        const probability=Number(direct.probability)||0;
        const qualified=probability>=minProbability;
        return {
          index,
          ...direct,
          qualified,
          reason: qualified ? `Meets ${minProbability}% minimum (saved Daily Prediction)` : `Below ${minProbability}% minimum (saved Daily Prediction)`,
        };
      }
      let best = null, bestScore = -1;
      // Exact SportyBet event ID is the strongest signal. Only fall back to team-name
      // matching when the imported booking does not provide a usable event ID.
      const exactEventCandidates = leg.eventId ? candidates.filter(c => String(c.eventId || '') === leg.eventId) : [];
      const pool = exactEventCandidates.length ? exactEventCandidates : candidates;
      for (const c of pool) {
        const sc = analyzerCandidateScore(leg, c);
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      const supported = !!best && bestScore >= 60;
      if (!supported) {
        const reason = leg.analyzerResolved
          ? 'Over 1.5 resolved correctly, but no current football probability-model prediction matched this fixture/competition'
          : 'Could not resolve this imported selection to a market supported by the current probability model';
        return { index, ...leg, supported: false, qualified: false, reason };
      }
      const probability = Number(best.probability) || 0;
      const qualified = probability >= minProbability;
      return {
        index,
        ...leg,
        // Use current SportyBet identifiers/odds from the matched market candidate for re-booking.
        eventId: String(best.eventId), marketId: String(best.marketId), outcomeId: String(best.outcomeId), specifier: best.specifier || null,
        sport: best.sport || leg.sport, home: best.home || leg.home, away: best.away || leg.away, tournament: best.tournament || leg.tournament,
        marketDesc: best.marketDesc || leg.marketDesc, outcomeDesc: best.outcomeDesc || leg.outcomeDesc, odds: Number(best.odds) || leg.odds,
        supported: true, qualified,
        probability,
        probabilitySource: best.probabilitySource || '',
        impliedProbability: Number(best.impliedProbability) || null,
        edge: Number(best.edge) || 0,
        expectedValuePct: Number(best.expectedValuePct) || 0,
        qualityScore: Number(best.qualityScore) || null,
        fairOdds: Number(best.fairOdds) || null,
        settlementNote: best.settlementNote || '',
        fullWinProbability: Number(best.fullWinProbability) || null,
        nonLossProbability: Number(best.nonLossProbability) || null,
        reason: qualified ? `Meets ${minProbability}% minimum` : `Below ${minProbability}% minimum`,
      };
    });

    const qualifiedSelections = analyzed.filter(x => x.supported && x.qualified);
    const originalOdds = bookingMetaNumber(booking, ['total_odds','totalOdds','combined_odds','combinedOdds']) || sourceRows.reduce((p,x)=>p*(Number(x.odds)||1),1);
    const filteredOdds = qualifiedSelections.reduce((p,x)=>p*(Number(x.odds)||1),1);
    res.json({
      bookingCode,
      minProbability,
      horizonDays,
      analyzerHours,
      originalSelectionCount: sourceRows.length,
      supportedCount: analyzed.filter(x=>x.supported).length,
      qualifiedCount: qualifiedSelections.length,
      originalCombinedOdds: Math.round(originalOdds*100)/100,
      filteredCombinedOdds: Math.round(filteredOdds*100)/100,
      analyzed,
      qualifiedSelections,
      generatedAt: new Date().toISOString(),
      note: `Analyzer searched up to ${horizonDays} days ahead. Only markets supported by the current Matchday probability engine are scored. Unsupported selections are never assigned a guessed probability.`,
    });
  } catch (err) {
    console.error('SportyBet analyzer error:', err.code || '', err.message);
    const status = err.code === 'INVALID_BOOKING_CODE' ? 400
      : err.code === 'PARSE_API_KEY_MISSING' ? 503
      : (err.code === 'PARSE_TIMEOUT' || err.name === 'AbortError') ? 504
      : 502;
    const publicReason = err.code === 'PARSE_TIMEOUT'
      ? 'SportyBet/Parse timed out while loading the booking or its markets'
      : err.status
        ? `SportyBet/Parse returned HTTP ${err.status}`
        : 'The analyzer could not finish loading the required SportyBet markets';
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING' ? 'SportyBet integration is not configured yet' : 'Could not analyze this booking code',
      reason: publicReason,
      code: err.code || 'ANALYZER_UPSTREAM_FAILURE',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});


async function autoCornerDiagnostics(betTypes) {
  const wantsCorners=Array.isArray(betTypes) && betTypes.some(x=>String(x).includes('corner'));
  if(!wantsCorners) return null;
  try{
    const [pred, c, h] = await Promise.all([
      loadPredictions(),
      loadSportyBetMarket('corners'),
      loadSportyBetMarket('first_half_team_corners')
    ]);
    const matches=Array.isArray(pred?.matches)?pred.matches:[];
    return {
      predictionMatches:matches.length,
      matchesWithCornerModel:matches.filter(x=>Number(x?.corners?.totalLambda||0)>0).length,
      sportyCornerRows:Array.isArray(c?.rows)?c.rows.length:0,
      sportyFirstHalfCornerRows:Array.isArray(h?.rows)?h.rows.length:0,
      apiFootballConfigured:!!(process.env.API_FOOTBALL_KEY||process.env.API_FOOTBALL_API_KEY),
    };
  }catch(e){
    return {diagnosticError:String(e.message||e).slice(0,300)};
  }
}

app.post('/api/sportybet/auto-pick', express.json(), async (req, res) => {
  try {
    const body = req.body || {};
    const targetOdds = Math.min(100000, Math.max(1.05, Number(body.targetOdds) || 5));
    // Website Auto Builder probability is user-adjustable.
    const minProbability = Math.min(95, Math.max(0, Number(body.minProbability) || 55));
    const maxSelections = Math.min(50, Math.max(1, parseInt(body.maxSelections || '8', 10)));
    const minEdge = Math.min(50, Math.max(-25, Number(body.minEdge) || 0));
    // Optional website-only ceiling for the bookmaker odds of each individual selection.
    // Null/blank means no per-match odds ceiling.
    const rawMaxMatchOdds = Number(body.maxMatchOdds);
    const maxMatchOdds = Number.isFinite(rawMaxMatchOdds) && rawMaxMatchOdds > 1
      ? Math.min(1000, Math.max(1.01, rawMaxMatchOdds))
      : null;
    const leagues = Array.isArray(body.leagues) ? body.leagues.map(String) : null;
    const selectedSports = normalizeSportScopes(Array.isArray(body.sports) && body.sports.length ? body.sports : body.sportScope);
    const sportScope = selectedSports.length === 6 ? 'all' : (selectedSports.length === 1 ? selectedSports[0] : 'multi');
    const betTypes = normalizeAutoBetTypesForSports(selectedSports, Array.isArray(body.betTypes) ? body.betTypes.map(String) : null);
    const todayOnly = body.todayOnly === true || String(body.todayOnly || '').toLowerCase() === 'true';

    const prepared = await prepareAutoCandidatePool({ sportScope: selectedSports, minProbability, minEdge, leagues, betTypes, maxMatchOdds, todayOnly });
    const oddsFilteredCandidates = prepared.candidates;
    const redFlagSafeCandidatesCount = prepared.diagnostics.afterRedFlag;
    const rawCandidatesCount = prepared.diagnostics.rawCandidates;
    const redFlagRejected = prepared.diagnostics.redFlagRejected;
    const result = selectAutoBet(oddsFilteredCandidates, { targetOdds, maxSelections });
    if (!result.selections.length) {
      const cornerDiagnostics=await autoCornerDiagnostics(betTypes);
      return res.status(404).json({
        error: 'No eligible SportyBet selections matched the requested sport and minimum probability',
        targetOdds,
        minProbability,
        minEdge,
        sportScope,
        sports: selectedSports,
        requestedBetTypes: betTypes,
        autoBetTypeFallbackApplied: Array.isArray(body.betTypes) && body.betTypes.length > 0 && !body.betTypes.some(id => betTypes.includes(String(id))),
        candidateCount: oddsFilteredCandidates.length,
        candidatesBeforeMaxOddsFilter: redFlagSafeCandidatesCount,
        candidatesBeforeRedFlagFilter: rawCandidatesCount,
        redFlagRejected,
        maxMatchOdds,
        todayOnly,
        todayCandidateCount: prepared.diagnostics.afterTodayFilter,
        teamGoalAvailability: prepared.diagnostics.teamGoalAvailability,
        cornerDiagnostics,
        hint: Object.keys(prepared.diagnostics.teamGoalAvailability || {}).length
          ? 'Team totals: check teamGoalAvailability. An unavailable bookmaker line or missing saved team model cannot be turned into a valid selection; increase SPORTYBET_TEAM_GOAL_MAX_EVENTS only if you accept more Parse credits.'
          : cornerDiagnostics
            ? 'Corner diagnostics included. matchesWithCornerModel must be > 0 and SportyBet corner rows must be > 0.'
            : undefined,
      });
    }

    res.json({
      ...result,
      sportScope,
      sports: selectedSports,
      minProbability,
      minEdge,
      maxSelections,
      maxMatchOdds,
      todayOnly,
      todayCandidateCount: prepared.diagnostics.afterTodayFilter,
      candidatesBeforeMaxOddsFilter: redFlagSafeCandidatesCount,
      candidatesBeforeRedFlagFilter: rawCandidatesCount,
      redFlagRejected,
      betTypes,
      generatedAt: new Date().toISOString(),
      note: 'Value engine: football uses 1X2, Corners O/U, GG/NG, Double Chance, Draw No Bet, Over 1.5, Under 4.5 and Asian Handicap +0/+0.25/-0.25. O/U 2.5 is excluded. DNB/AH use settlement-aware fair odds and EV; basketball/hockey remain no-vig market estimates.',
    });
  } catch (err) {
    console.error('SportyBet auto-pick error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to build automatic SportyBet slip',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

function parseTargetList(value) {
  const defaults = [1000, 750, 250, 100, 50, 20];
  const list = String(value || defaults.join(','))
    .split(',')
    .map(x => Number(x.trim()))
    .filter(x => Number.isFinite(x) && x >= 1.05 && x <= 2000);
  return list.length ? [...new Set(list)] : defaults;
}

function telegramSlipText(target, result, booking, sportScope) {
  const status = result.reachedTarget ? 'TARGET REACHED' : 'CLOSEST AVAILABLE';
  const lines = [
    `🎯 MATCHDAY AUTO CODE — ${target} ODDS`,
    `${status} | ${sportScope.toUpperCase()}`,
    `Actual odds: ${Number(result.combinedOdds || 1).toFixed(2)}`,
    `Average leg probability: ${Number(result.averageProbability || 0).toFixed(1)}%`,
    `Minimum leg probability: ${Number(result.minimumProbability || 0).toFixed(1)}%`,
    `Estimated slip fair-price probability: ${Number(result.estimatedSlipProbability || 0).toFixed(3)}%`,
    `Average probability edge: ${Number(result.averageEdge || 0).toFixed(1)} pts`,
    `Average quality score: ${Number(result.averageQualityScore || 0).toFixed(1)}/100`,
    `Estimated slip EV: ${Number(result.estimatedSlipEVPct || 0).toFixed(1)}%`,
    `Selections: ${result.selections.length}`,
    `SportyBet code: ${booking?.shareCode || 'NO CODE RETURNED'}`,
    '',
  ];
  result.selections.forEach((x, i) => {
    lines.push(`${i + 1}. [${x.sport}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc} @ ${Number(x.odds).toFixed(2)} | model/fair ${Number(x.probability).toFixed(1)}% | implied ${Number(x.impliedProbability || 0).toFixed(1)}% | edge ${Number(x.edge || 0).toFixed(1)} | Q ${Number(x.qualityScore || 0).toFixed(1)}`);
    if (x.settlementNote && x.settlementNote !== 'Win/lose market') lines.push(`   Settlement: ${x.settlementNote} | full-win ${Number(x.fullWinProbability || 0).toFixed(1)}% | non-loss ${Number(x.nonLossProbability || 0).toFixed(1)}% | fair odds ${Number(x.fairOdds || 0).toFixed(2)}`);
  });
  if (booking?.shareURL) lines.push('', `SportyBet link: ${booking.shareURL}`);
  if (Array.isArray(booking?.unavailableOutcomes) && booking.unavailableOutcomes.length) {
    lines.push('', `⚠️ ${booking.unavailableOutcomes.length} outcome(s) were unavailable when the code was created.`);
  }
  return lines.join('\n');
}


// Scheduled 1.30 ticket: Ice Hockey + Basketball first. If winners from those
// two sports cannot complete the target, add Tennis, then Handball + Volleyball.
// Winner markets are always tried before any totals/handicap/other market.
const TELEGRAM_SAFE_SPORT_TIERS = [
  ['hockey','basketball'],
  ['tennis'],
  ['handball','volleyball'],
];

// Scheduled 2x/3x tickets: Ice Hockey + Basketball + Tennis first; only add
// Handball + Volleyball if the preferred group cannot complete the target.
const TELEGRAM_2X3X_SPORT_TIERS = [
  ['hockey','basketball','tennis'],
  ['handball','volleyball'],
];

// Additional high-odds scheduled tickets. These are strict sport pools with a
// 1000x goal, but 1000x is NOT a hard publish requirement: when today's >=80%
// pool cannot reach 1000 within 15 unique fixtures, publish the best available
// combination instead. Winner markets are still tried first.
const TELEGRAM_HOCKEY_ONLY_SPORT_TIERS = [['hockey']];
const TELEGRAM_BASKETBALL_ONLY_SPORT_TIERS = [['basketball']];
const TELEGRAM_HANDBALL_VOLLEYBALL_SPORT_TIERS = [['handball','volleyball']];

function selectTelegramSafeWithPriority(plan, candidates, maxSelections) {
  const targetPlan = { ...plan, targetOdds: plan.minOdds };
  const picked = selectTelegramMixedWithSportPriority(targetPlan, candidates, maxSelections, {
    trials: Number(process.env.TELEGRAM_PICK_TRIALS || 2200),
    sportTiers: TELEGRAM_SAFE_SPORT_TIERS,
    isWinner: isTelegramWinnerSelection,
  });
  const result = picked.result;
  const inRange = result?.selections?.length &&
    Number(result.combinedOdds) >= plan.minOdds &&
    Number(result.combinedOdds) <= plan.maxOdds;
  if (inRange) return picked;
  return picked;
}

// Match-winner classification is retained for diagnostics. SAFE, 2x and 3x
// are all eligible for the supported markets below.
// The website and interactive Telegram AI Builder remain unchanged.
const TELEGRAM_WINNER_BET_TYPES = [
  'home_win', 'away_win',
  'basketball_winner', 'hockey_winner', 'handball_winner',
  'volleyball_winner', 'tennis_winner',
];
const TELEGRAM_WINNER_BET_TYPE_SET = new Set(TELEGRAM_WINNER_BET_TYPES);
function isTelegramWinnerSelection(candidate) {
  if (!TELEGRAM_WINNER_BET_TYPE_SET.has(String(candidate?.betType || ''))) return false;
  return !/^(draw|tie|x)$/i.test(String(candidate?.outcomeDesc || '').trim());
}

// Existing supported markets are eligible for SAFE, 2x and 3x.
// Scheduled thresholds: 1.30 SAFE >=85%; 2x/3x >=80%. Red-flag protection remains enabled.
const TELEGRAM_FALLBACK_BET_TYPES = [
  'draw', 'dc_1x', 'dc_x2', 'dnb', 'over05', 'home_over05', 'away_over05', 'home_under45', 'away_under45', 'over15', 'under45',
  'gg_yes', 'ng_no', 'ah_0', 'ah_plus025', 'ah_minus025',
  'corners_over', 'corners_under',
  'basketball_over', 'basketball_under', 'hockey_over', 'hockey_under',
  'handball_over', 'handball_under', 'volleyball_over', 'volleyball_under',
  'volleyball_sets_over', 'volleyball_sets_under',
  'tennis_over', 'tennis_under', 'tennis_handicap_home', 'tennis_handicap_away',
];
const TELEGRAM_HIGH_ODDS_BET_TYPES = [...TELEGRAM_WINNER_BET_TYPES, ...TELEGRAM_FALLBACK_BET_TYPES];
const TELEGRAM_HIGH_ODDS_BET_TYPE_SET = new Set(TELEGRAM_HIGH_ODDS_BET_TYPES);

function telegramCombinedResult(selections, targetOdds, candidateCount) {
  if (!selections.length) return { selections: [], targetOdds, combinedOdds: 1, reachedTarget: false, candidateCount };
  const n = selections.length;
  const odds = selections.reduce((v, c) => v * Number(c.odds), 1);
  const round = (v, digits) => Number(v.toFixed(digits));
  const avg = key => selections.reduce((v,c) => v + (Number(c[key]) || 0), 0) / n;
  const probability = selections.reduce((v,c) => v * Math.max(0, Math.min(1, Number(c.probability)/100)), 1) * 100;
  return {
    selections, targetOdds, combinedOdds: round(odds, 2), reachedTarget: odds >= targetOdds,
    candidateCount, averageProbability: round(avg('probability'), 1),
    minimumProbability: round(Math.min(...selections.map(c => Number(c.probability))), 1),
    averageEdge: round(avg('edge'), 1), averageQualityScore: round(avg('qualityScore'), 1),
    estimatedSlipProbability: round(probability, 3),
    fairSlipOdds: probability > 0 ? round(100/probability, 2) : null,
    estimatedSlipEVPct: round((selections.reduce((v,c) => v * (Number(c.expectedReturnMultiplier) || 1), 1)-1)*100, 1),
  };
}

async function runTelegramDailyPicks({ onPostingStart = () => {}, shouldAbort = () => false } = {}) {
  // A cancelled GitHub Actions curl does not automatically stop this Express
  // handler. Check before the *first* Telegram send so a cancelled build cannot
  // publish after its daily Redis lock has been released for a retry.
  const assertNotCancelled = () => {
    if (!shouldAbort()) return;
    const err = new Error('Telegram run cancelled before posting; safe to retry');
    err.code = 'TELEGRAM_CANCELLED_BEFORE_POST';
    throw err;
  };
  assertNotCancelled();
  // SAFE, 2x and 3x use all six sports with hockey/basketball first.
  const sportScope = 'all';
  const maxSelections = Math.min(40, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '40', 10)));
  const leagues = process.env.TELEGRAM_FOOTBALL_LEAGUES
    ? process.env.TELEGRAM_FOOTBALL_LEAGUES.split(',').map(x => x.trim()).filter(Boolean)
    : null;

  // Scheduled Telegram plans only. Interactive AI Builder and website retain
  // their independent, user-selected odds choices. Scheduled probability floors are
  // 85% for 1.30 SAFE and 80% for every other scheduled ticket.
  const plans = [
    { label: '1.30–5.00 SAFE', targetOdds: 1.30, minProbability: 85, minOdds: 1.30, maxOdds: 5.00, maxSelections: 15 },
    { label: '2', targetOdds: 2, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 20 },
    { label: '3', targetOdds: 3, minProbability: 80, mixedMarkets: true, allSports: true, maxSelections: 20 },
    { label: '1000 ICE HOCKEY', targetOdds: 1000, minProbability: 80, maxSelections: 15, flexibleTarget: true, sportScopeLabel: 'ice hockey', sportTiers: TELEGRAM_HOCKEY_ONLY_SPORT_TIERS },
    { label: '1000 BASKETBALL', targetOdds: 1000, minProbability: 80, maxSelections: 15, flexibleTarget: true, sportScopeLabel: 'basketball', sportTiers: TELEGRAM_BASKETBALL_ONLY_SPORT_TIERS },
    { label: '1000 HANDBALL + VOLLEYBALL', targetOdds: 1000, minProbability: 80, maxSelections: 15, flexibleTarget: true, sportScopeLabel: 'handball + volleyball', sportTiers: TELEGRAM_HANDBALL_VOLLEYBALL_SPORT_TIERS },
  ];

  // One market fetch covers all six sports for every target. Saved market caching
  // remains enabled; missing market data may still be fetched as requested.
  // Removed 1UP and first-half team-corner markets are never reintroduced.
  const globalCandidates = await loadAutoCandidates({
    sportScope: 'all', minProbability: 0, minEdge: -25, leagues,
    betTypes: TELEGRAM_HIGH_ODDS_BET_TYPES,
  });
  assertNotCancelled();
  const allCandidates = globalCandidates;

  // SAFE considers all supported markets, with hockey/basketball priority.
  const todayCandidates = allCandidates.filter(c => isCandidateToday(c, { timeZone: 'Africa/Lagos' }));
  const saneCandidates = todayCandidates.filter(passesRedFlagFilter);
  const globalTodayCandidates = globalCandidates
    .filter(c => isCandidateToday(c, { timeZone: 'Africa/Lagos' }))
    .filter(passesRedFlagFilter);
  const safeTodayCandidates = globalTodayCandidates
    .filter(c => TELEGRAM_HIGH_ODDS_BET_TYPE_SET.has(String(c.betType || '')));
  const dateRejected = allCandidates.length - todayCandidates.length;
  const redFlagRejected = todayCandidates.length - saneCandidates.length;
  if (!saneCandidates.length && !safeTodayCandidates.length && !globalTodayCandidates.length) {
    throw new Error('No eligible same-day (WAT) candidates remain after Telegram daily-picks filters');
  }

  const watToday = fixtureDateKeyInTimeZone(new Date(), 'Africa/Lagos');
  const redis = await getRedis();
  const dailyCodes = [];
  assertNotCancelled();
  await saveTelegramDailyCodes(redis, watToday, { generatedAt: new Date().toISOString(), codes: dailyCodes });
  assertNotCancelled();
  // Once Telegram sending begins, never automatically clear the daily lock:
  // a timed-out request might have delivered the message despite an error.
  await onPostingStart();
  await sendTelegramMessage([
    '🤖 PLOT207 SPORTS • DAILY PICKS',
    `📅 ${watToday} (WAT)`,
    '🎯 SAFE • 2x • 3x',
    '🚀 1000 target • Ice Hockey • Basketball • Handball + Volleyball',
    'Probabilities are estimates, not guarantees.',
  ].join('\n'));

  const output = [];
  for (const plan of plans) {
    // Per-target ceiling; the global env setting may only lower it, not bypass it.
    const planMaxSelections = Math.min(maxSelections, plan.maxSelections || maxSelections);
    const isSafePlan = plan.minOdds != null && plan.maxOdds != null;
    const baseCandidates = isSafePlan ? safeTodayCandidates : globalTodayCandidates;
    const planCandidates = baseCandidates
      .filter(c => Number(c.probability || 0) >= plan.minProbability)
      .filter(c => TELEGRAM_HIGH_ODDS_BET_TYPE_SET.has(String(c.betType || '')));

    if (!planCandidates.length) {
      output.push({ targetOdds: plan.label, error: `No selections met the ${plan.minProbability}% probability minimum` });
      await sendTelegramMessage(`⚠️ ${plan.label} odds set NOT GENERATED — no selections met the ${plan.minProbability}% probability minimum.`);
      continue;
    }

    const picked = isSafePlan
      ? selectTelegramSafeWithPriority(plan, planCandidates, planMaxSelections)
      : selectTelegramMixedWithSportPriority(plan, planCandidates, planMaxSelections, {
          sportTiers: plan.sportTiers || TELEGRAM_2X3X_SPORT_TIERS,
          isWinner: isTelegramWinnerSelection,
        });
    const result = picked.result;

    if (!result.selections.length) {
      output.push({ targetOdds: plan.label, error: 'No eligible combination found' });
      await sendTelegramMessage(`⚠️ Could not build the ${plan.label} odds slip from the qualifying selections.`);
      continue;
    }

    // 2x/3x remain hard targets. The three sport-specific 1000x plans are
    // flexible: if today's >=80% pool cannot reach 1000x within 15 legs, send
    // the best available combination and clearly show its actual combined odds.
    if (!isSafePlan && !plan.flexibleTarget && (!result.reachedTarget || !Number.isFinite(Number(result.combinedOdds)) ||
        Number(result.combinedOdds) < plan.targetOdds)) {
      output.push({ targetOdds: plan.label, combinedOdds: result.combinedOdds,
        error: `No qualifying combination reached ${plan.label}x` });
      await sendTelegramMessage(`⚠️ ${plan.label}x set NOT GENERATED — no qualifying combination reached ${plan.label}x.`);
      continue;
    }

    // SAFE must actually land inside 1.30–5.00. Do not send a closest-outside-range slip.
    if (plan.minOdds != null && plan.maxOdds != null &&
        (Number(result.combinedOdds) < plan.minOdds || Number(result.combinedOdds) > plan.maxOdds)) {
      output.push({
        targetOdds: plan.label,
        combinedOdds: result.combinedOdds,
        error: 'No qualifying combination landed inside 1.30–5.00'
      });
      await sendTelegramMessage(`⚠️ ${plan.label} set NOT GENERATED — no qualifying combination landed inside 1.30–5.00.`);
      continue;
    }

    // Final safety check: every target may use only supported markets.
    // No more than one selection per fixture and no more than 40 legs per ticket.
    const uniqueEvents = new Set(result.selections.map(c => String(c.eventId)));
    if (result.selections.length > planMaxSelections || uniqueEvents.size !== result.selections.length ||
        result.selections.some(c => Number(c.probability) < plan.minProbability ||
          !TELEGRAM_HIGH_ODDS_BET_TYPE_SET.has(String(c.betType || '')))) {
      output.push({ targetOdds: plan.label, error: 'Market / probability / fixture validation failed' });
      await sendTelegramMessage(`⚠️ ${plan.label} odds set NOT GENERATED — market / probability / fixture validation failed.`);
      continue;
    }

    try {
      const booking = await bookBet(result.selections.map(x => ({
        eventId: x.eventId,
        marketId: x.marketId,
        outcomeId: x.outcomeId,
        ...(x.specifier ? { specifier: x.specifier } : {}),
      })));
      const planSportScope = plan.sportScopeLabel || (plan.allSports ? 'all' : sportScope);
      await sendTelegramMessage(telegramSlipText(plan.label, result, booking, planSportScope));

      await trackTelegramSlip(redis, {
        shareCode: booking?.shareCode,
        shareURL: booking?.shareURL,
        targetOdds: plan.label,
        combinedOdds: result.combinedOdds,
        sportScope: planSportScope,
        selections: result.selections,
      });

      if (booking?.shareCode) {
        dailyCodes.push({ targetOdds: plan.label, combinedOdds: result.combinedOdds, shareCode: booking.shareCode });
        await saveTelegramDailyCodes(redis, watToday, { generatedAt: new Date().toISOString(), codes: dailyCodes });
      }

      output.push({
        targetOdds: plan.label,
        combinedOdds: result.combinedOdds,
        averageProbability: result.averageProbability,
        estimatedSlipProbability: result.estimatedSlipProbability,
        averageEdge: result.averageEdge,
        averageQualityScore: result.averageQualityScore,
        estimatedSlipEVPct: result.estimatedSlipEVPct,
        selections: result.selections.length,
        maxSelections: planMaxSelections,
        shareCode: booking?.shareCode || null,
        unavailable: Array.isArray(booking?.unavailableOutcomes) ? booking.unavailableOutcomes.length : 0,
        prioritySportsOnly: !!picked.priorityOnly,
        preferredCandidateCount: Number(picked.preferredCount || 0),
        winnerSelections: result.selections.filter(isTelegramWinnerSelection).length,
        supplementalSelections: result.selections.filter(c => !isTelegramWinnerSelection(c)).length,
        allSportsScope: !!plan.allSports,
        flexibleTarget: !!plan.flexibleTarget,
        reachedTarget: !!result.reachedTarget,
        sportScope: plan.sportScopeLabel || (plan.allSports ? 'all' : sportScope),
      });
    } catch (err) {
      output.push({ targetOdds: plan.label, combinedOdds: result.combinedOdds, error: err.message });
      await sendTelegramMessage(`⚠️ ${plan.label} odds slip was built at ${result.combinedOdds}, but SportyBet code generation failed: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, 750));
  }

  return {
    sportScope,
    plans: plans.map(p => ({
      target: p.label,
      minProbability: p.minProbability,
      maxSelections: Math.min(maxSelections, p.maxSelections || maxSelections),
      ...(p.minOdds != null ? { combinedOddsRange: `${p.minOdds.toFixed(2)}-${p.maxOdds.toFixed(2)}` } : {}),
      ...(p.flexibleTarget ? { flexibleTarget: true, sportScope: p.sportScopeLabel } : {})
    })),
    positiveEdgeRequired: false,
    redFlagProtection: true,
    redFlagRejected,
    maxSelections,
    candidateCount: saneCandidates.length,
    results: output
  };
}



// Copy Hub is isolated from the Auto Builder and disabled by default.
// It only reads public source data + existing booking-code data and stores its own leaderboard state.
app.get('/api/copy/status', async (req, res) => {
  try {
    const redis = await getRedis();
    res.json({
      enabled: copyHubEnabled(),
      persistentStorage: !!redis,
      xConfigured: !!process.env.X_BEARER_TOKEN,
      xDiscoveryMode: 'broad-sportybet-plus-boom',
      xAutomationWorkflowIncluded: true,
      globalCodeOwnership: true,
      sportySocialBatchImport: true,
      rankingWindowDays: Math.max(1, Math.min(365, parseInt(process.env.COPY_HUB_RANKING_DAYS || '30', 10))),
      note: copyHubEnabled()
        ? 'Copy Hub is read-only toward public sources and SportyBet booking data.'
        : 'Copy Hub is installed but disabled. Set COPY_HUB_ENABLED=true when ready.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Copy Hub status unavailable' });
  }
});

app.get('/api/copy/leaderboard', async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    const redis = await getRedis();
    const days = Math.max(1, Math.min(365, Number(req.query.days) || Number(process.env.COPY_HUB_RANKING_DAYS) || 30));
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 30));
    const source = ['all','x','sportysocial','telegram','manual'].includes(String(req.query.source || '').toLowerCase())
      ? String(req.query.source).toLowerCase() : 'all';
    const store = await readCopyHubStore(redis);
    const trackedRows = buildLeaderboard(store, { days, limit: 100, source, settledOnly: false });
    const leaderboard = buildLeaderboard(store, { days, limit, source, settledOnly: true });
    const trackedPunterCount = trackedRows.length;
    const trackedCodeCount = trackedRows.reduce((n,x)=>n+Number(x.codes||0),0);
    const pendingCodeCount = trackedRows.reduce((n,x)=>n+Number(x.pending||0),0);
    const settledCodeCount = trackedRows.reduce((n,x)=>n+Number(x.settled||0),0);
    res.json({ days, source, count: leaderboard.length, trackedPunterCount, trackedCodeCount, pendingCodeCount, settledCodeCount, leaderboard });
  } catch (err) {
    console.error('Copy Hub leaderboard error:', err.message);
    res.status(500).json({ error: 'Could not load Copy Hub leaderboard' });
  }
});

app.get('/api/copy/punter/:id', async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    const redis = await getRedis();
    const profile = await getPunterProfile(redis, String(req.params.id || ''), Number(req.query.days) || 90);
    if (!profile) return res.status(404).json({ error: 'Punter not found' });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: 'Could not load punter profile' });
  }
});

// Protected manual importer. Useful for SportySocial/Telegram seeds before automatic collectors are enabled.
app.post('/api/copy/import-code', express.json({ limit: '20kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const bookingCode = String(req.body?.bookingCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,24}$/.test(bookingCode)) return res.status(400).json({ error: 'Invalid booking code' });
    const booking = await getBooking(bookingCode); // validates through the existing SportyBet adapter
    const redis = await getRedis();
    const result = await addObservedCode(redis, {
      punter: {
        source: req.body?.source,
        username: req.body?.username,
        displayName: req.body?.displayName,
        profileUrl: req.body?.profileUrl,
        sourceUserId: req.body?.sourceUserId,
      },
      bookingCode,
      booking,
      sourcePostId: req.body?.sourcePostId,
      sourceUrl: req.body?.sourceUrl,
      publishedAt: req.body?.publishedAt,
      sourceText: req.body?.sourceText,
    });
    res.json({ ok: true, created: result.created, entry: result.entry });
  } catch (err) {
    console.error('Copy Hub import error:', err.message);
    res.status(400).json({ error: 'Could not import booking code', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});


// Protected endpoint used by the twice-daily GitHub Playwright collector.
// It accepts only sanitized SportySocial feed records; credentials/cookies never reach Render.
app.post('/api/copy/sportysocial/import-batch', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'No SportySocial items supplied' });
    const result = await importSportySocialBatch(redis, items);
    res.json({ ok: true, source: 'sportysocial', ...result });
  } catch (err) {
    console.error('Copy Hub SportySocial import error:', err.message);
    res.status(400).json({ error: 'Could not import SportySocial batch', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});

// Official X API only: no cookie scraping, passwords, browser sessions, or account automation.
app.post('/api/copy/x/scan', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    const result = await scanXRecent({
      redis,
      getBooking,
      query: req.body?.queries || req.body?.query,
      maxResults: req.body?.maxResults || process.env.X_COPY_MAX_RESULTS || 25,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Copy Hub X scan error:', err.message);
    const status = err.code === 'X_NOT_CONFIGURED' ? 503 : (err.status === 429 ? 429 : 502);
    res.status(status).json({ error: err.code === 'X_NOT_CONFIGURED' ? 'X API is not configured' : 'X scan failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});

app.post('/api/copy/check-settlements', express.json({ limit: '4kb' }), async (req, res) => {
  try {
    if (!copyHubEnabled()) return res.status(404).json({ error: 'Copy Hub is disabled' });
    if (!authorizeCopyHub(req)) return res.status(401).json({ error: 'unauthorized' });
    const redis = await getRedis();
    if (typeof evaluateBooking !== 'function') {
      const err = new Error('COPY_HUB_EVALUATOR_UNAVAILABLE');
      err.code = 'COPY_HUB_EVALUATOR_UNAVAILABLE';
      throw err;
    }
    const result = await settleCopyHubPending({
      redis,
      getBooking,
      evaluateBooking,
      maxChecks: req.body?.maxChecks || process.env.COPY_HUB_MAX_SETTLEMENT_CHECKS || 20,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Copy Hub settlement error:', err.message);
    res.status(502).json({ error: 'Copy Hub settlement check failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});




function telegramAiAdminIds() {
  return new Set(String(process.env.TELEGRAM_ADMIN_IDS || process.env.TELEGRAM_ADMIN_ID || '')
    .split(',').map(x => x.trim()).filter(Boolean));
}

function telegramAiIsAdmin(id) { return telegramAiAdminIds().has(String(id)); }

function telegramAiUpgradeText(plan, feature) {
  const label = plan.id === 'free' ? 'Pro or Elite' : 'Elite';
  return `🔒 ${feature} is not included in your ${plan.name} plan.\n\nUpgrade to ${label} to unlock higher limits and more Matchday AI tools.`;
}

function telegramAiAccountText(user) {
  const plan = getTelegramAiPlan(user);
  const expiry = user.planExpiresAt ? new Date(user.planExpiresAt).toISOString().slice(0,10) : 'No expiry';
  return [
    '👤 MY MATCHDAY AI ACCOUNT', '',
    `Plan: ${plan.name}${plan.priceNgn ? ` — ₦${plan.priceNgn.toLocaleString()}/month` : ''}`,
    ...(user.plan !== 'free' ? [`Renews/expires: ${expiry}`] : []),
    `Tickets today: ${user.ticketsUsed}/${plan.dailyTickets}`,
    `Purchased extra tickets: ${Number(user.extraTickets||0)}`,
    `Code analyses today: ${user.analyzesUsed}/${plan.dailyAnalyzes}`,
    `AI chat messages today: ${Number(user.llmMessagesUsed||0)}/${plan.dailyLlmMessages}`,
    `Maximum target odds: ${plan.maxTargetOdds}x`,
    `Maximum selections: ${plan.maxSelections}`,
    `Sports: ${plan.sports.map(x => x === 'hockey' ? 'Ice Hockey' : x[0].toUpperCase()+x.slice(1)).join(', ')}`,
  ].join('\n');
}

function telegramAiTicketText(result, booking, request, plan) {
  const lines = [
    `🤖 MATCHDAY AI — ${request.safe ? 'SAFE' : `${Number(request.targetOdds).toFixed(request.targetOdds < 2 ? 2 : 0)}x`} TICKET`,
    `${result.reachedTarget ? '✅ TARGET REACHED' : '🟡 CLOSEST AVAILABLE'} | ${String(request.sport || 'all').toUpperCase()}`,
    `Plan: ${plan.name}`,
    `Actual odds: ${Number(result.combinedOdds || 1).toFixed(2)}`,
    `Selections: ${result.selections.length}`,
    `Average leg probability: ${Number(result.averageProbability || 0).toFixed(1)}%`,
    `Minimum leg probability: ${Number(result.minimumProbability || 0).toFixed(1)}%`,
    `Average quality: ${Number(result.averageQualityScore || 0).toFixed(1)}/100`,
    `SportyBet code: ${booking?.shareCode || 'Code generation unavailable'}`,
    ''
  ];
  result.selections.forEach((x, i) => {
    lines.push(`${i+1}. [${x.sport}] ${x.home} vs ${x.away}`);
    lines.push(`   ${x.outcomeDesc || x.marketDesc} @ ${Number(x.odds).toFixed(2)} | ${Number(x.probability||0).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`);
  });
  if (booking?.shareURL) lines.push('', `SportyBet link: ${booking.shareURL}`);
  lines.push('', 'Probabilities are model estimates, not guarantees.');
  return lines.join('\n');
}

function telegramAiBetTypesForSport(planId, sport) {
  const allowed = new Set(telegramAiAllowedBetIdsForPlan(planId));
  const bySport = {
    football: ['home_win','draw','away_win','home_over05','away_over05','home_under45','away_under45','corners_over','corners_under','dc_1x','dc_x2','dnb','over05','over15','under45','gg_yes','ng_no','ah_0','ah_plus025','ah_minus025'],
    basketball: ['basketball_winner','basketball_over','basketball_under'],
    hockey: ['hockey_winner','hockey_over','hockey_under'],
    handball: ['handball_winner','handball_over','handball_under'],
    volleyball: ['volleyball_winner','volleyball_over','volleyball_under','volleyball_sets_over','volleyball_sets_under'],
    tennis: ['tennis_winner','tennis_over','tennis_under','tennis_handicap_home','tennis_handicap_away'],
  };
  if (sport === 'all') return [...allowed];
  return (bySport[sport] || []).filter(id => allowed.has(id));
}

function telegramAiMergeTicketRequest(user, incoming) {
  const saved = user?.preferences?.builder || {};
  const inc = incoming || {};
  const merged = { ...saved, ...inc };
  const plan = getTelegramAiPlan(user);
  const requestedSports = normalizeSportScopes(Array.isArray(inc.sports)&&inc.sports.length?inc.sports:(inc.sport||merged.sports||merged.sport||'football'));
  const requestedSport=requestedSports.length===3?'all':(requestedSports.length===1?requestedSports[0]:'multi');
  merged.sports=requestedSports;merged.sport=requestedSport;
  const explicitBetTypes = Array.isArray(inc.betTypes) && inc.betTypes.length > 0;

  if (explicitBetTypes) {
    merged.betTypes = inc.betTypes;
  } else if (inc.sport) {
    // A fresh natural-language sport request must not inherit incompatible markets
    // from the previous ticket (e.g. football corners -> hockey).
    merged.betTypes=[...new Set(requestedSports.flatMap(sp=>telegramAiBetTypesForSport(plan.id,sp)))];
  } else if (!Array.isArray(merged.betTypes) || !merged.betTypes.length) {
    merged.betTypes=[...new Set(requestedSports.flatMap(sp=>telegramAiBetTypesForSport(plan.id,sp)))];
  }
  return merged;
}

async function buildTelegramAiTicket(user, request) {
  const plan = getTelegramAiPlan(user);
  const saved = user?.preferences?.builder || {};
  const merged = { ...saved, ...(request || {}) };
  // SAFE is a curated system ticket: prioritize Volleyball + Ice Hockey + Handball + Basketball,
  // regardless of the user's last Builder sport selection. It remains accessible
  // from the Best Picks button even on Free, while normal Builder sport limits stay unchanged.
  let sports = merged.safe
    ? ['tennis','volleyball','hockey','handball','basketball']
    : normalizeSportScopes(Array.isArray(merged.sports)&&merged.sports.length?merged.sports:(merged.sport||(plan.id==='free'?'football':'all')));
  if (!merged.safe) {
    const unavailable=sports.filter(sp=>!(plan.sports.includes(sp)||plan.sports.includes('all')));
    if(unavailable.length)return{locked:true,message:telegramAiUpgradeText(plan,`${unavailable.join(' + ')} tickets`)};
  }
  const sport=sports.length===5?'all':(sports.length===1?sports[0]:'multi');
  const targetOdds = merged.safe ? 5.00 : Number(merged.targetOdds || 10);
  if (!merged.safe && targetOdds > plan.maxTargetOdds) {
    return { locked: true, message: `${telegramAiUpgradeText(plan, `${targetOdds}x ticket building`)}\n\nYour current maximum target is ${plan.maxTargetOdds}x.` };
  }
  const minProbability = Math.min(95, Math.max(merged.safe ? 90 : 0, Number(merged.minProbability ?? (merged.safe ? 90 : 70))));
  const minEdge = Math.min(25, Math.max(-10, Number(merged.minEdge ?? 0)));
  const maxSelections = Math.min(plan.maxSelections, Math.max(1, Number(merged.maxSelections || plan.maxSelections)));
  const safeBetTypes = [
    'tennis_winner','tennis_over','tennis_under','tennis_handicap_home','tennis_handicap_away',
    'volleyball_winner','volleyball_over','volleyball_under','volleyball_sets_over','volleyball_sets_under',
    'hockey_winner','hockey_over','hockey_under',
    'handball_winner','handball_over','handball_under',
    'basketball_winner','basketball_over','basketball_under'
  ];
  const allowedBetTypes = new Set(merged.safe ? safeBetTypes : telegramAiAllowedBetIdsForPlan(plan.id));
  const sportBetTypes = new Set(merged.safe ? safeBetTypes : sports.flatMap(sp=>telegramAiBetTypesForSport(plan.id,sp)));
  let requestedBetTypes = merged.safe ? safeBetTypes : (Array.isArray(merged.betTypes)&&merged.betTypes.length?merged.betTypes.map(String):[...sportBetTypes]);
  let betTypes=requestedBetTypes.filter(id=>allowedBetTypes.has(id)&&sportBetTypes.has(id));
  // Basketball/Hockey only have three supported families. Old saved preferences could
  // contain a partial/corrupted list even though the Builder displayed “(3)”.
  // When all selected IDs are sport-compatible, normalize them to the canonical IDs.
  if (sports.length===1 && sport === 'basketball' && betTypes.length && betTypes.every(id => id.startsWith('basketball_'))) {
    betTypes = telegramAiBetTypesForSport(plan.id, 'basketball');
  }
  if (sports.length===1 && sport === 'hockey' && betTypes.length && betTypes.every(id => id.startsWith('hockey_'))) {
    betTypes = telegramAiBetTypesForSport(plan.id, 'hockey');
  }
  if (!betTypes.length) {
    return { error: `None of the selected bet types are compatible with ${sport === 'hockey' ? 'Ice Hockey' : sport}. Choose a compatible market or ask for the sport without specifying a bet type.` };
  }
  const prepared = await prepareAutoCandidatePool({
    sportScope: sports,
    minProbability,
    minEdge,
    leagues: null,
    betTypes,
    maxMatchOdds: merged.maxMatchOdds,
    todayOnly: !!merged.todayOnly,
  });
  const pool = prepared.candidates;
  if (!pool.length) {
    const d = prepared.diagnostics;
    console.warn(`[Telegram AI pool] sport=${sport} raw=${d.rawCandidates} afterToday=${d.afterTodayFilter} todayOnly=${!!merged.todayOnly} afterRedFlag=${d.afterRedFlag} afterMaxOdds=${d.afterMaxOdds} minProb=${minProbability} minEdge=${minEdge} betTypes=${betTypes.join(',')}`);
    const todayPart = merged.todayOnly ? `, ${d.afterTodayFilter} playing today (WAT)` : '';
    return { error: `No current SportyBet selections passed your ${minProbability}% probability rule, ${minEdge} edge setting and red-flag protection. (Candidates: ${d.rawCandidates} raw${todayPart}, ${d.afterRedFlag} after red flags, ${d.afterMaxOdds} after max-odd filter.)` };
  }
  const result = selectAutoBet(pool, {
    targetOdds: merged.safe ? 5.00 : targetOdds,
    maxSelections,
    trials: Number(process.env.TELEGRAM_AI_PICK_TRIALS || 1800),
    minQualityScore: 0,
    requirePositiveEV: false,
  });
  if (!result?.selections?.length) return { error: 'I could not find a qualifying combination from the current SportyBet fixtures.' };
  if (merged.safe && (Number(result.combinedOdds) < 1.30 || Number(result.combinedOdds) > 5.00)) {
    return { error: 'No SAFE combination currently lands inside 1.30–5.00 while keeping every leg at 90%+.' };
  }
  const booking = await bookBet(result.selections.map(x => ({ eventId:x.eventId, marketId:x.marketId, outcomeId:x.outcomeId, ...(x.specifier ? {specifier:x.specifier}: {}) })));
  return { result, booking, plan, request: { ...merged, sport, sports, targetOdds, minProbability, minEdge, maxSelections, betTypes } };
}

function telegramAnalyzerSameFixture(leg, c) {
  if (leg.eventId && c.eventId) return String(leg.eventId) === String(c.eventId);
  const direct = analyzerTeamMatch(leg.home, c.home) && analyzerTeamMatch(leg.away, c.away);
  const reverse = analyzerTeamMatch(leg.home, c.away) && analyzerTeamMatch(leg.away, c.home);
  return direct || reverse;
}

function telegramAnalyzerReplacementFor(leg, candidates, minProbability) {
  return candidates
    .filter(c => telegramAnalyzerSameFixture(leg, c))
    .filter(c => Number(c.probability || 0) >= Number(minProbability || 0))
    .filter(passesRedFlagFilter)
    .sort((a,b) => {
      const p = Number(b.probability||0) - Number(a.probability||0); if (p) return p;
      const q = Number(b.qualityScore||0) - Number(a.qualityScore||0); if (q) return q;
      const e = Number(b.edge||0) - Number(a.edge||0); if (e) return e;
      return Number(a.odds||99) - Number(b.odds||99);
    })[0] || null;
}

async function analyzeTelegramAiCode(bookingCode, minProbability = 70, horizonDays = 14, replaceUnsupported = false) {
  horizonDays = Math.min(21, Math.max(7, Number(horizonDays) || 14));
  const analyzerHours = horizonDays * 24;
  const booking = await getBooking(bookingCode);
  const decodedRows = extractBookingOutcomes(booking).map(normalizeBookingLeg).filter(x => x.home || x.away || x.eventId);
  if (!decodedRows.length) throw new Error('The SportyBet code was found, but no selections could be read from it.');

  const decodedSports = decodedRows.map(x => analyzerNormText(x.sport)).filter(Boolean);
  let sportScope = 'all';
  if (decodedSports.length && decodedSports.every(x => x.includes('football') || x.includes('soccer'))) sportScope = 'football';
  else if (decodedSports.length && decodedSports.every(x => x.includes('basket'))) sportScope = 'basketball';
  else if (decodedSports.length && decodedSports.every(x => x.includes('hockey') || x.includes('ice hockey'))) sportScope = 'hockey';

  // Only use the Daily Refresh/shared cache for market matching and replacement. get_booking
  // remains the one live lookup needed to decode the submitted code.
  const analyzerOver15 = sportScope === 'football'
    ? await loadSportyBetMarket('ou15', 'football', { hours: analyzerHours, maxPages: 2, cacheOnly: true })
    : { rows: [] };
  const sourceRows = decodedRows.map(leg => resolveGenericOver15Leg(leg, analyzerOver15?.rows));

  // Load the full supported market universe for the booking's sport from cache only.
  // This lets an unsupported imported market be replaced by another supported saved
  // market on the exact same fixture without spending new Parse.bot market credits.
  const candidates = await loadAutoCandidates({
    sportScope, minProbability:0, minEdge:-25, leagues:null, betTypes:null,
    marketHours:analyzerHours, marketMaxPages:2, marketCacheOnly:true
  });

  const analyzed = sourceRows.map((leg, index) => {
    let best=null, bestScore=-1;
    const exact = leg.eventId ? candidates.filter(c => String(c.eventId||'') === String(leg.eventId)) : [];
    for (const c of (exact.length ? exact : candidates)) {
      const score=analyzerCandidateScore(leg,c); if(score>bestScore){bestScore=score;best=c;}
    }
    if (!best || bestScore < 60) {
      if (replaceUnsupported) {
        const replacement = telegramAnalyzerReplacementFor(leg, candidates, minProbability);
        if (replacement) {
          return {
            index, ...leg, supported:true, qualified:true, replaced:true,
            originalMarketDesc: leg.marketDesc, originalOutcomeDesc: leg.outcomeDesc, originalOdds: leg.odds,
            eventId:String(replacement.eventId||leg.eventId||''), marketId:String(replacement.marketId||''), outcomeId:String(replacement.outcomeId||''), specifier:replacement.specifier||null,
            sport:replacement.sport||leg.sport, home:replacement.home||leg.home, away:replacement.away||leg.away,
            outcomeDesc:replacement.outcomeDesc, marketDesc:replacement.marketDesc, odds:Number(replacement.odds||0),
            probability:Number(replacement.probability||0), edge:Number(replacement.edge||0), qualityScore:Number(replacement.qualityScore||0),
            replacementReason:'Unsupported imported market replaced from saved/cached data on the same fixture'
          };
        }
      }
      return { index, ...leg, supported:false, qualified:false, replaced:false };
    }
    return { index, ...leg, supported:true, qualified:Number(best.probability||0)>=minProbability, replaced:false, probability:Number(best.probability||0), edge:Number(best.edge||0), qualityScore:Number(best.qualityScore||0), sport:best.sport, home:best.home, away:best.away, outcomeDesc:best.outcomeDesc, marketDesc:best.marketDesc, odds:Number(best.odds||leg.odds||0) };
  });
  return { bookingCode, analyzed, supported: analyzed.filter(x=>x.supported).length, qualified: analyzed.filter(x=>x.qualified).length, replaced: analyzed.filter(x=>x.replaced).length, unsupported: analyzed.filter(x=>!x.supported).length, total: analyzed.length, minProbability, replaceUnsupported:!!replaceUnsupported, cacheOnlyMarkets:true };
}

function telegramAiAnalysisText(a) {
  const lines=[`🔎 MATCHDAY AI CODE ANALYSIS — ${a.bookingCode}`, `Scored: ${a.supported}/${a.total}`, `Qualified ≥ ${a.minProbability}%: ${a.qualified}/${a.total}`, ...(a.replaceUnsupported?[`Replaced from saved data: ${a.replaced||0}`]:[]), ''];
  a.analyzed.forEach((x,i)=>{
    const icon=x.replaced?'♻️':!x.supported?'⚪':x.qualified?'✅':'❌';
    lines.push(`${icon} ${i+1}. ${x.home||'Unknown'} vs ${x.away||'Unknown'}`);
    if (x.replaced) {
      lines.push(`   ORIGINAL: ${x.originalOutcomeDesc||x.originalMarketDesc||'Unsupported selection'}${x.originalOdds?` @ ${Number(x.originalOdds).toFixed(2)}`:''}`);
      lines.push(`   REPLACED → ${x.outcomeDesc||x.marketDesc||'Selection'}${x.odds?` @ ${Number(x.odds).toFixed(2)}`:''} | ${Number(x.probability).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`);
    } else {
      lines.push(`   ${x.outcomeDesc||x.marketDesc||'Selection'}${x.odds?` @ ${Number(x.odds).toFixed(2)}`:''}${x.supported?` | ${Number(x.probability).toFixed(1)}% | Q ${Number(x.qualityScore||0).toFixed(1)}`:' | NOT SCORED'}`);
    }
  });
  lines.push('', '✅ = keep · ❌ = below threshold · ♻️ = same-fixture cached replacement · ⚪ = unsupported/unresolved');
  lines.push('Cached replacement never switches to a different fixture and does not make a fresh Parse market call.');
  return lines.join('\n');
}

async function sendTelegramAiLongMessage(chatId, text, options = {}) {
  const raw = String(text || '');
  if (raw.length <= 3900) return sendTelegramAiMessageTo(chatId, raw, options);
  const lines = raw.split('\n');
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 3900 && current) { chunks.push(current); current = line; }
    else current = next;
  }
  if (current) chunks.push(current);
  for (let i = 0; i < chunks.length; i++) {
    const opts = i === chunks.length - 1 ? options : {};
    await sendTelegramAiMessageTo(chatId, chunks[i], opts);
  }
}


async function matchdayLlmInterpret(user, message) {
  const apiKey=String(process.env.OPENAI_API_KEY||'').trim();
  if(!apiKey) return null;
  const model=String(process.env.OPENAI_MODEL||'gpt-5.6-luna').trim();
  const plan=getTelegramAiPlan(user);
  const llmLimit=Number(plan.dailyLlmMessages||0);
  const llmUsed=Number(user.llmMessagesUsed||0);
  if(llmLimit>0 && llmUsed>=llmLimit) return {quotaExceeded:true, limit:llmLimit, action:'chat', reply:''};
  user.llmMessagesUsed=llmUsed+1;
  const b=user.preferences?.builder||{};
  const allowed=telegramAiAllowedBetIdsForPlan(plan.id);
  const history=Array.isArray(user.llmHistory)?user.llmHistory.slice(-8):[];
  const instructions=`You are Matchday AI, a concise conversational assistant inside a Telegram sports analytics app.
Never invent fixtures, odds, booking codes, probabilities, results, or model data. The application engine—not you—retrieves and calculates those.
Interpret normal conversation into either a reply or an app action.
Current subscription: ${plan.name}. Allowed sports: ${plan.sports.join(', ')}. Allowed bet type IDs: ${allowed.join(', ')}.
Current builder settings: ${JSON.stringify(b)}.
Valid action values: chat, ticket, builder, plans, account, analyze.
For ticket actions, only set fields the user clearly requested; the app merges them with current settings.
Sport values: football, basketball, hockey, all. Do not bypass subscription restrictions.
Bet IDs: home_win, draw, away_win, oneup, corners_over, corners_under, first_half_home_team_corners, first_half_away_team_corners, dc_1x, dc_x2, dnb, over05, home_over05, away_over05, home_under45, away_under45, over15, under45, gg_yes, ng_no, ah_0, ah_plus025, ah_minus025, basketball_winner, basketball_over, basketball_under, hockey_winner, hockey_over, hockey_under.
If the user asks to build/rebuild/replace/remove selections but the requested transformation cannot be safely represented by these parameters, explain what can be changed and ask one concise question instead of pretending it was done.
If discussing betting, do not promise wins or guaranteed profit.`;
  const input=[
    ...history.map(x=>({role:x.role==='assistant'?'assistant':'user',content:String(x.content||'')})),
    {role:'user',content:String(message)}
  ];
  const body={
    model,
    instructions,
    input,
    store:false,
    max_output_tokens:500,
    text:{format:{
      type:'json_schema',
      name:'matchday_router',
      strict:true,
      schema:{
        type:'object',
        additionalProperties:false,
        properties:{
          action:{type:'string',enum:['chat','ticket','builder','plans','account','analyze']},
          reply:{type:'string'},
          targetOdds:{type:['number','null']},
          sport:{type:['string','null'],enum:['football','basketball','hockey','all',null]},
          minProbability:{type:['number','null'],minimum:0,maximum:100},
          maxMatchOdds:{type:['number','null']},
          minEdge:{type:['number','null']},
          maxSelections:{type:['integer','null']},
          safe:{type:['boolean','null']},
          todayOnly:{type:['boolean','null']},
          betTypes:{type:['array','null'],items:{type:'string'}},
          bookingCode:{type:['string','null']}
        },
        required:['action','reply','targetOdds','sport','minProbability','maxMatchOdds','minEdge','maxSelections','safe','todayOnly','betTypes','bookingCode']
      }
    }}
  };
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${apiKey}`},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(20000)
    });
    if(!r.ok){const t=await r.text();throw new Error(`OpenAI ${r.status}: ${t.slice(0,180)}`)}
    const data=await r.json();
    let outText=data.output_text;
    if(!outText){
      for(const item of data.output||[]) for(const c of item.content||[]) if(c.type==='output_text'&&c.text){outText=c.text;break}
    }
    const parsed=JSON.parse(outText||'{}');
    user.llmHistory=[...history,{role:'user',content:String(message)},{role:'assistant',content:String(parsed.reply||'')}].slice(-10);
    return parsed;
  }catch(e){
    console.error('Matchday LLM error:',e.message);
    return null;
  }
}

function llmTicketIntent(x){
  const out={intent:'ticket'};
  for(const k of ['targetOdds','sport','sports','minProbability','maxMatchOdds','minEdge','maxSelections','safe','betTypes','todayOnly']){
    if(x[k]!==null&&x[k]!==undefined) out[k]=x[k];
  }
  return out;
}

async function handleTelegramAiUpdate(update) {
  const callback = update?.callback_query;
  const msg = callback?.message || update?.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;
  const from = callback?.from || msg.from || {};
  const redis = await getRedis();
  let user = await getTelegramAiUser(redis, from.id || chatId, from);
  let text = String(msg.text || '').trim();
  let callbackAction = null;

  if (callback) {
    await telegramAiRequest('answerCallbackQuery', { callback_query_id: callback.id }).catch(()=>{});
    const d = String(callback.data || '');

    if (d === 'action:home') text = '/start';
    else if (d === 'action:builder') {
      return sendTelegramAiMessageTo(chatId, telegramAiBuilderSummary(user), { reply_markup: telegramAiBuilderKeyboard(user) });
    }
    else if (d === 'builder:sport') return sendTelegramAiMessageTo(chatId, '🏟 Select any 1, 2 or 3 sports for this ticket. Tap each sport to toggle it, then tap Done:', { reply_markup: telegramAiSportKeyboard(user) });
    else if (d === 'builder:target') return sendTelegramAiMessageTo(chatId, `🎯 Select target combined odds.\nYour ${getTelegramAiPlan(user).name} maximum is ${getTelegramAiPlan(user).maxTargetOdds}x.`, { reply_markup: telegramAiTargetKeyboard(user) });
    else if (d === 'builder:prob') return sendTelegramAiMessageTo(chatId, '📈 Select the minimum model/fair probability required for every leg:', { reply_markup: telegramAiProbabilityKeyboard() });
    else if (d === 'builder:maxodd') return sendTelegramAiMessageTo(chatId, '💰 Select the maximum SportyBet odd allowed for any individual match:', { reply_markup: telegramAiMaxOddKeyboard() });
    else if (d === 'builder:edge') return sendTelegramAiMessageTo(chatId, '📊 Select the minimum football probability edge. Negative values allow more candidates; positive values demand model value over price:', { reply_markup: telegramAiEdgeKeyboard() });
    else if (d === 'builder:maxgames') return sendTelegramAiMessageTo(chatId, '🔢 Select the maximum number of games the builder can use:', { reply_markup: telegramAiMaxGamesKeyboard(user) });
    else if (d === 'builder:today') { user.preferences.builder.todayOnly=!user.preferences.builder.todayOnly; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d === 'builder:markets') return sendTelegramAiMessageTo(chatId, '🎲 Select the exact bet types the Auto Builder may use. Tap a market to toggle it:', { reply_markup: telegramAiMarketsKeyboard(user) });
    else if (d === 'builder:build') callbackAction = 'build';
    else if (d === 'builder:safe' || d === 'ticket:safe') callbackAction = 'safe';
    else if (d.startsWith('ticket:')) { user.preferences.builder.targetOdds = Number(d.split(':')[1]) || 10; await saveTelegramAiUser(redis,user); callbackAction='build'; }
    else if (d === 'action:plans') text = '/plans';
    else if (d === 'action:account') text = '/account';
    else if (d === 'action:help') {
      return sendTelegramAiLongMessage(chatId, plot207TelegramHelpText(getTelegramAiPlan(user)), { reply_markup: telegramAiMainKeyboard() });
    }
    else if (d === 'action:dailycodes') {
      const plan = getTelegramAiPlan(user);
      const dateKey = fixtureDateKeyInTimeZone(new Date(), 'Africa/Lagos');
      const snapshot = await loadTelegramDailyCodes(redis, dateKey);
      return sendTelegramAiMessageTo(chatId, telegramDailyCodesText(snapshot, plan), { reply_markup: telegramAiMainKeyboard() });
    }
    else if (d === 'action:copy') text = 'copy rankings';
    else if (d === 'action:analyze') {
      const plan = getTelegramAiPlan(user);
      if (plan.dailyAnalyzes <= 0) return sendTelegramAiMessageTo(chatId, telegramAiUpgradeText(plan,'SportyBet code analysis'), { reply_markup: telegramAiPlanKeyboard() });
      return sendTelegramAiMessageTo(chatId, telegramAiAnalyzerSummary(user), { reply_markup: telegramAiAnalyzerKeyboard(user) });
    }
    else if (d === 'analyzer:prob') return sendTelegramAiMessageTo(chatId, '📈 Choose the probability threshold used to KEEP selections:', { reply_markup: telegramAiAnalyzerProbKeyboard() });
    else if (d === 'analyzer:horizon') return sendTelegramAiMessageTo(chatId, '📅 How far ahead should Matchday search for fixtures in the imported code?', { reply_markup: telegramAiAnalyzerHorizonKeyboard() });
    else if (d === 'analyzer:replace:last') {
      const last=user.lastAnalyzerRequest;
      if(!last?.bookingCode)return sendTelegramAiMessageTo(chatId,'There is no recent analysis to repair. Analyze a booking code first.',{reply_markup:telegramAiAnalyzerKeyboard(user)});
      await sendTelegramAiMessageTo(chatId,`♻️ Checking saved markets for safe same-fixture replacements in ${last.bookingCode}…`);
      try{
        const repaired=await analyzeTelegramAiCode(last.bookingCode,last.minProbability,last.horizonDays,true);
        user.lastAnalyzerRequest={...last,repairedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);
        return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(repaired),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(false)});
      }catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not replace the unsupported selections: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
    }
    else if (d === 'analyzer:enter') return sendTelegramAiMessageTo(chatId, `⌨️ Send the SportyBet booking code now.\n\nCurrent analyzer: ≥ ${user.preferences.analyzer.minProbability}% · ${user.preferences.analyzer.horizonDays} days\n\nUnsupported selections will be shown first. Nothing is replaced unless you tap ♻️ Replace Unsupported after the analysis.\nExample: RKT1JT`);
    else if (d.startsWith('sporttoggle:')) {
      const id=d.split(':')[1];
      const plan=getTelegramAiPlan(user);
      const allSports=['football','basketball','hockey','handball','volleyball','tennis'];
      const unlocked=allSports.filter(sp=>plan.sports.includes(sp)||plan.sports.includes('all'));
      const selected=new Set(Array.isArray(user.preferences.builder.sports)?user.preferences.builder.sports:['football']);

      if(id==='all'){
        const allSelected=unlocked.length>0&&unlocked.every(sp=>selected.has(sp));
        selected.clear();
        if(allSelected) selected.add(unlocked[0]||'football');
        else unlocked.forEach(sp=>selected.add(sp));
      } else {
        if(!unlocked.includes(id)) return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(plan,`${id} tickets`),{reply_markup:telegramAiPlanKeyboard()});
        if(selected.has(id)){if(selected.size>1)selected.delete(id);}else selected.add(id);
      }

      user.preferences.builder.sports=[...selected];
      user.preferences.builder.sport=user.preferences.builder.sports.length===allSports.length?'all':(user.preferences.builder.sports.length===1?user.preferences.builder.sports[0]:'multi');
      const compatible=[...new Set(user.preferences.builder.sports.flatMap(sp=>telegramAiBetTypesForSport(plan.id,sp)))];
      const current=(user.preferences.builder.betTypes||[]).filter(x=>compatible.includes(x));
      user.preferences.builder.betTypes=current.length?current:compatible;
      await saveTelegramAiUser(redis,user);
      return sendTelegramAiMessageTo(chatId,'🏟 Select one or more unlocked sports, or use Select All:',{reply_markup:telegramAiSportKeyboard(user)});
    }
    else if (d.startsWith('set:sport:')) {
      const nextSport=d.split(':')[2];
      const plan=getTelegramAiPlan(user);
      const allSports=['football','basketball','hockey','handball','volleyball','tennis'];
      const unlocked=allSports.filter(sp=>plan.sports.includes(sp)||plan.sports.includes('all'));
      user.preferences.builder.sport=nextSport;
      user.preferences.builder.sports=nextSport==='all'?unlocked:[nextSport];
      const compatible=telegramAiBetTypesForSport(plan.id,nextSport);
      const current=(user.preferences.builder.betTypes||[]).filter(id=>compatible.includes(id));
      if(!current.length) user.preferences.builder.betTypes=compatible;
      await saveTelegramAiUser(redis,user);
      return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
    }
    else if (d.startsWith('set:target:')) { user.preferences.builder.targetOdds=Number(d.split(':')[2]); user.preferences.builder.safe=false; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:prob:')) { user.preferences.builder.minProbability=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:maxodd:')) { const v=d.split(':')[2]; user.preferences.builder.maxMatchOdds=v==='none'?null:Number(v); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:edge:')) { user.preferences.builder.minEdge=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:maxgames:')) { user.preferences.builder.maxSelections=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)}); }
    else if (d.startsWith('set:anprob:')) { user.preferences.analyzer.minProbability=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiAnalyzerSummary(user),{reply_markup:telegramAiAnalyzerKeyboard(user)}); }
    else if (d.startsWith('set:horizon:')) { user.preferences.analyzer.horizonDays=Number(d.split(':')[2]); await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,telegramAiAnalyzerSummary(user),{reply_markup:telegramAiAnalyzerKeyboard(user)}); }
    else if (d.startsWith('market:')) {
      const id=d.slice('market:'.length);
      const allowed=new Set(telegramAiAllowedBetIdsForPlan(getTelegramAiPlan(user).id));
      if(!allowed.has(id)) return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(getTelegramAiPlan(user),'this bet type'),{reply_markup:telegramAiPlanKeyboard()});
      const set=new Set((user.preferences.builder.betTypes||[]).filter(x=>allowed.has(x)));
      if(set.has(id))set.delete(id);else set.add(id); user.preferences.builder.betTypes=[...set]; await saveTelegramAiUser(redis,user);
      return sendTelegramAiMessageTo(chatId,'🎲 Bet types updated. Continue selecting or tap Done.',{reply_markup:telegramAiMarketsKeyboard(user)});
    }
    else if (d === 'markets:all') { user.preferences.builder.betTypes=[...telegramAiAllowedBetIdsForPlan(getTelegramAiPlan(user).id)]; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,'✅ All bet types available on your plan selected.',{reply_markup:telegramAiMarketsKeyboard(user)}); }
    else if (d === 'markets:clear') { user.preferences.builder.betTypes=[]; await saveTelegramAiUser(redis,user); return sendTelegramAiMessageTo(chatId,'🧹 All markets cleared. Select at least one market before building.',{reply_markup:telegramAiMarketsKeyboard(user)}); }
    else if (d === 'result:rebuild') callbackAction='rebuild';
    else if (d === 'result:safer') callbackAction='safer';
    else if (d.startsWith('locked:')) return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(getTelegramAiPlan(user),'this Auto Builder option'),{reply_markup:telegramAiPlanKeyboard()});
    else if (d.startsWith('extra:')) {
      const packPlan=d.split(':')[1],current=getTelegramAiPlan(user);
      if(current.id!==packPlan||!['pro','elite'].includes(packPlan))return sendTelegramAiMessageTo(chatId,'Extra ticket packs require an active matching Pro or Elite subscription.',{reply_markup:telegramAiPlanKeyboard(user)});
      const pack=packPlan==='elite'?{count:75,price:'₦10,000'}:{count:25,price:'₦2,500'};
      const admins=[...telegramAiAdminIds()];
      if(!admins.length)return sendTelegramAiMessageTo(chatId,'⚠️ Payment contact is temporarily unavailable. Please try again later.');
      const msg=['🎟️ EXTRA AI TICKET REQUEST','',`Plan: ${current.name}`,`Pack: +${pack.count} tickets`,`Amount: ${pack.price}`,`Customer: ${from.first_name||user.firstName||'Customer'}`,`Username: ${from.username?'@'+from.username:'No username'}`,`Telegram ID: ${from.id}`,'','Confirm payment, then press the button below or use:',`/addtickets ${from.id} ${pack.count}`].join('\n');
      let delivered=0;for(const aid of admins){try{await sendTelegramAiMessageTo(aid,msg,{reply_markup:{inline_keyboard:[[{text:`✅ Add +${pack.count} Tickets`,callback_data:`adminaddtickets:${from.id}:${pack.count}`}]]}});delivered++}catch(e){console.error('Extra-ticket admin notification:',e.message)}}
      if(!delivered)return sendTelegramAiMessageTo(chatId,'⚠️ I could not reach the payment administrator. Please try again shortly.');
      return sendTelegramAiMessageTo(chatId,`✅ Request sent. ${pack.price} for +${pack.count} AI tickets. Tickets are added after payment confirmation and expire with your current subscription.`,{reply_markup:telegramAiMainKeyboard()});
    }
    else if (d.startsWith('plan:')) {
      const chosen=d.split(':')[1];
      if(!['pro','elite'].includes(chosen)) return sendTelegramAiMessageTo(chatId,'Unknown subscription plan.',{reply_markup:telegramAiPlanKeyboard()});
      const planName=chosen==='elite'?'ELITE':'PRO';
      const price=chosen==='elite'?'₦20,000':'₦5,000';
      const username=from.username?`@${from.username}`:'No Telegram username';
      const firstName=from.first_name||user.firstName||'Customer';
      const admins=[...telegramAiAdminIds()];
      if(!admins.length) {
        return sendTelegramAiMessageTo(chatId,'⚠️ Payment contact is temporarily unavailable. Please try again later.',{reply_markup:telegramAiPlanKeyboard()});
      }
      const adminMessage=[
        '💳 NEW MATCHDAY AI PAYMENT REQUEST','',
        `Plan: ${planName}`,
        `Amount: ${price}`,
        `Customer: ${firstName}`,
        `Username: ${username}`,
        `Telegram ID: ${from.id}`,'',
        'The customer selected this plan and is waiting for bank account/payment instructions.','',
        `After confirming payment, activate with:`,
        `/activate ${from.id} ${chosen} 30`
      ].join('\n');
      let delivered=0;
      for(const adminId of admins){
        try{
          await sendTelegramAiMessageTo(adminId,adminMessage,{
            reply_markup:{inline_keyboard:[
              [{text:'💬 Open Customer Chat',url:`tg://user?id=${from.id}`}],
              [{text:`✅ Activate ${planName} 30 Days`,callback_data:`adminactivate:${from.id}:${chosen}:30`}]
            ]}
          });
          delivered++;
        }catch(e){ console.error('Telegram AI payment admin notification failed:',adminId,e.message); }
      }
      if(!delivered) return sendTelegramAiMessageTo(chatId,'⚠️ I could not reach the payment administrator. Please try again shortly.',{reply_markup:telegramAiPlanKeyboard()});
      return sendTelegramAiMessageTo(chatId,[
        `✅ ${planName} payment request sent to the administrator.`,
        '',
        `Plan: ${planName}`,
        `Amount: ${price}`,
        `Your Telegram ID: ${from.id}`,
        '',
        'The administrator will contact you in Telegram with the account/payment details. Do not send payment to account details from anyone else claiming to be Matchday AI.'
      ].join('\n'),{reply_markup:{inline_keyboard:[[{text:'⬅️ Plans',callback_data:'action:plans'}],[{text:'🏠 Home',callback_data:'action:home'}]]}});
    }
    else if (d.startsWith('adminaddtickets:')) {
      if(!telegramAiIsAdmin(from.id))return sendTelegramAiMessageTo(chatId,'Unauthorized.');
      const [,target,countRaw]=d.split(':'),count=Math.max(1,parseInt(countRaw,10)||0);
      const u=await addTelegramAiExtraTickets(redis,target,count);
      await sendTelegramAiMessageTo(chatId,`✅ Added +${count} AI tickets to ${target}. Balance: ${Number(u.extraTickets||0)}.`);
      try{await sendTelegramAiMessageTo(target,`🎟️ Payment confirmed. +${count} extra AI tickets added.\nBalance: ${Number(u.extraTickets||0)}.`,{reply_markup:telegramAiMainKeyboard()})}catch{}
      return;
    }
    else if (d.startsWith('adminactivate:')) {
      if(!telegramAiIsAdmin(from.id)) return sendTelegramAiMessageTo(chatId,'⛔ Admin only.');
      const parts=d.split(':'),target=parts[1],planId=parts[2],days=Math.max(1,Math.min(365,Number(parts[3]||30)));
      if(!/^\d+$/.test(target)||!['pro','elite'].includes(planId)) return sendTelegramAiMessageTo(chatId,'⚠️ Invalid activation request.');
      await activateTelegramAiPlan(redis,target,planId,days);
      await sendTelegramAiMessageTo(chatId,`✅ Activated ${planId.toUpperCase()} for Telegram user ${target} for ${days} days.`);
      await sendTelegramAiMessageTo(target,`🎉 Payment confirmed. Your Matchday AI account is now ${planId.toUpperCase()} for ${days} days.`,{reply_markup:telegramAiMainKeyboard()}).catch(()=>{});
      return;
    }
  }

  const addTicketsCmd=text.match(/^\/addtickets\s+(\d+)\s+(\d+)$/i);
  if(addTicketsCmd&&telegramAiIsAdmin(from.id)){const target=addTicketsCmd[1],count=Math.max(1,parseInt(addTicketsCmd[2],10)||0),u=await addTelegramAiExtraTickets(redis,target,count);await sendTelegramAiMessageTo(chatId,`✅ Added +${count} AI tickets to ${target}. Balance: ${Number(u.extraTickets||0)}.`);try{await sendTelegramAiMessageTo(target,`🎟️ +${count} extra AI tickets have been added. Balance: ${Number(u.extraTickets||0)}.`,{reply_markup:telegramAiMainKeyboard()})}catch{}return}
  const admin=text.match(/^\/activate\s+(\d+)\s+(pro|elite)(?:\s+(\d+))?$/i);
  if(admin&&telegramAiIsAdmin(from.id)){
    const target=admin[1],planId=admin[2].toLowerCase(),days=Math.max(1,Math.min(365,Number(admin[3]||30)));
    await activateTelegramAiPlan(redis,target,planId,days);
    await sendTelegramAiMessageTo(chatId,`✅ Activated ${planId.toUpperCase()} for Telegram user ${target} for ${days} days.`);
    await sendTelegramAiMessageTo(target,`🎉 Your Matchday AI account is now ${planId.toUpperCase()} for ${days} days.`,{reply_markup:telegramAiMainKeyboard()}).catch(()=>{});return;
  }

  if (callbackAction) {
    const plan=getTelegramAiPlan(user);
    if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
    let req={...(user.preferences.builder||{})};
    if(!Array.isArray(req.betTypes)||!req.betTypes.length)return sendTelegramAiMessageTo(chatId,'⚠️ Select at least one Bet Type before building.',{reply_markup:telegramAiBuilderKeyboard(user)});
    if(callbackAction==='safe'||callbackAction==='safer'){req.safe=true;req.targetOdds=5.00;req.minProbability=Math.max(90,Number(req.minProbability||0));req.maxMatchOdds=null;}
    if(callbackAction==='rebuild'&&user.lastBuilderRequest)req={...user.lastBuilderRequest,safe:false};
    await sendTelegramAiMessageTo(chatId,`⏳ Scanning current SportyBet fixtures and applying your settings…\n${req.sport||'all'} · target ${req.safe?'SAFE 1.30–5.00':req.targetOdds+'x'} · ≥${req.minProbability}% · max ${req.maxMatchOdds||'no limit'} per match`);
    const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));
    if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});
    if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiBuilderKeyboard(user)});
    const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);
    return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
  }

  const intent=parseTelegramAiRequest(text);
  if(intent.intent==='menu'){
    const plan=getTelegramAiPlan(user);
    return sendTelegramAiMessageTo(chatId,[`🟢 Welcome${user.firstName?`, ${user.firstName}`:''} — PLOT207 SPORTS BOT`,`Plan: ${plan.name}`,'','Choose an option below to build or analyze a ticket. New here? Tap ❓ Help / How to Use for a complete step-by-step guide.','','Quick examples:','• Build football 20x today only','• Safe ticket','• Analyze RKT1JT'].join('\n'),{reply_markup:telegramAiMainKeyboard()});
  }
  if(intent.intent==='builder')return sendTelegramAiMessageTo(chatId,telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
  if(intent.intent==='help')return sendTelegramAiLongMessage(chatId,plot207TelegramHelpText(getTelegramAiPlan(user)),{reply_markup:telegramAiMainKeyboard()});
  if(intent.intent==='plans')return sendTelegramAiMessageTo(chatId,telegramAiPlansText(),{reply_markup:telegramAiPlanKeyboard()});
  if(intent.intent==='account')return sendTelegramAiMessageTo(chatId,telegramAiAccountText(user),{reply_markup:telegramAiMainKeyboard()});
  if(intent.intent==='copy'){
    const plan=getTelegramAiPlan(user);if(!plan.copyHub)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(plan,'Copy Hub punter rankings'),{reply_markup:telegramAiPlanKeyboard()});
    if(!copyHubEnabled())return sendTelegramAiMessageTo(chatId,'🏆 Copy Hub is currently disabled by the administrator.');
    const copyStore=await readCopyHubStore(redis);
    const trackedBoard=buildLeaderboard(copyStore,{days:30,limit:100,source:'all',settledOnly:false});
    const board=buildLeaderboard(copyStore,{days:30,limit:10,source:'all',settledOnly:true});
    if(!board.length){
      const pending=trackedBoard.reduce((n,x)=>n+Number(x.pending||0),0);
      const tracked=trackedBoard.reduce((n,x)=>n+Number(x.codes||0),0);
      return sendTelegramAiMessageTo(chatId,`🏆 No settled Copy Hub rankings yet.\n\n${tracked} tracked code${tracked===1?'':'s'} · ${pending} still pending. Rankings appear after at least one tracked code settles as WON, LOST or PUSH.`,{reply_markup:telegramAiMainKeyboard()});
    }
    const lines=['🏆 MATCHDAY COPY RANKINGS — 30 DAYS',''];board.slice(0,10).forEach((x,i)=>{
      const handle=x?.punter?.username ? `@${x.punter.username}` : (x?.punter?.displayName||x?.punter?.id||'Punter');
      lines.push(`${i+1}. ${handle} — Score ${Number(x.copyScore||0).toFixed(1)} · ${Number(x.winRate||0).toFixed(1)}% win rate · ${Number(x.settled||0)} settled`);
    });return sendTelegramAiMessageTo(chatId,lines.join('\n'),{reply_markup:telegramAiMainKeyboard()});
  }
  if(intent.intent==='analyze'){
    const plan=getTelegramAiPlan(user);if(plan.dailyAnalyzes<=0)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(plan,'SportyBet code analysis'),{reply_markup:telegramAiPlanKeyboard()});
    if(user.analyzesUsed>=plan.dailyAnalyzes)return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyAnalyzes} code analyses. Your daily allowance resets tomorrow.`,{reply_markup:telegramAiPlanKeyboard()});
    const cfg=user.preferences.analyzer||{minProbability:70,horizonDays:14};await sendTelegramAiMessageTo(chatId,`🔎 Analyzing ${intent.bookingCode} · keep ≥${cfg.minProbability}% · search ${cfg.horizonDays} days…`);
    try{const analysis=await analyzeTelegramAiCode(intent.bookingCode,cfg.minProbability,cfg.horizonDays,false);const use=await consumeTelegramAiUsage(redis,user,'analyze');user=use.user;user.lastAnalyzerRequest={bookingCode:intent.bookingCode,minProbability:cfg.minProbability,horizonDays:cfg.horizonDays,analyzedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(analysis),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(Number(analysis.unsupported||0)>0)})}catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not analyze that code: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
  }
  if(intent.intent==='ticket'){
    const plan=getTelegramAiPlan(user);if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${plan.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
    const req=telegramAiMergeTicketRequest(user,intent);
    const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiMainKeyboard()});
    const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
  }
  const llm=await matchdayLlmInterpret(user,text);
  if(llm?.quotaExceeded){
    await saveTelegramAiUser(redis,user);
    return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${llm.limit} conversational AI messages. Your AI chat allowance resets tomorrow. Buttons and supported direct commands are still available.`,{reply_markup:telegramAiMainKeyboard()});
  }
  if(llm){
    await saveTelegramAiUser(redis,user);
    if(llm.action==='builder') return sendTelegramAiMessageTo(chatId,llm.reply||telegramAiBuilderSummary(user),{reply_markup:telegramAiBuilderKeyboard(user)});
    if(llm.action==='plans') return sendTelegramAiMessageTo(chatId,llm.reply||telegramAiPlansText(),{reply_markup:telegramAiPlanKeyboard()});
    if(llm.action==='account') return sendTelegramAiMessageTo(chatId,`${llm.reply?llm.reply+'\n\n':''}${telegramAiAccountText(user)}`,{reply_markup:telegramAiMainKeyboard()});
    if(llm.action==='analyze'&&llm.bookingCode){
      const p=getTelegramAiPlan(user);
      if(p.dailyAnalyzes<=0)return sendTelegramAiMessageTo(chatId,telegramAiUpgradeText(p,'SportyBet code analysis'),{reply_markup:telegramAiPlanKeyboard()});
      if(user.analyzesUsed>=p.dailyAnalyzes)return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${p.dailyAnalyzes} code analyses.`,{reply_markup:telegramAiPlanKeyboard()});
      const cfg=user.preferences.analyzer||{minProbability:70,horizonDays:14};
      try{const analysis=await analyzeTelegramAiCode(llm.bookingCode,cfg.minProbability,cfg.horizonDays,false);const use=await consumeTelegramAiUsage(redis,user,'analyze');user=use.user;user.lastAnalyzerRequest={bookingCode:llm.bookingCode,minProbability:cfg.minProbability,horizonDays:cfg.horizonDays,analyzedAt:new Date().toISOString()};await saveTelegramAiUser(redis,user);return sendTelegramAiLongMessage(chatId,telegramAiAnalysisText(analysis),{reply_markup:telegramAiAnalyzerAnalysisKeyboard(Number(analysis.unsupported||0)>0)})}catch(e){return sendTelegramAiMessageTo(chatId,`⚠️ I could not analyze that code: ${e.message}`,{reply_markup:telegramAiAnalyzerKeyboard(user)})}
    }
    if(llm.action==='ticket'){
      const p=getTelegramAiPlan(user);
      if(!telegramAiHasTicketCredit(user))return sendTelegramAiMessageTo(chatId,`⛔ You have used today's ${p.dailyTickets} AI tickets and have no extra tickets left. Your daily allowance resets tomorrow, or you can buy an extra pack now.`,{reply_markup:telegramAiTicketLimitKeyboard(user)});
      const li=llmTicketIntent(llm),req=telegramAiMergeTicketRequest(user,li);
      const built=await buildTelegramAiTicket(user,req).catch(e=>({error:e.message}));
      if(built.locked)return sendTelegramAiMessageTo(chatId,built.message,{reply_markup:telegramAiPlanKeyboard()});
      if(built.error)return sendTelegramAiMessageTo(chatId,`⚠️ ${built.error}`,{reply_markup:telegramAiMainKeyboard()});
      const use=await consumeTelegramAiUsage(redis,user,'ticket');user=use.user;user.lastBuilderRequest=built.request;user.lastBookingCode=built.booking?.shareCode||null;await saveTelegramAiUser(redis,user);
      return sendTelegramAiLongMessage(chatId,telegramAiTicketText(built.result,built.booking,built.request,built.plan),{reply_markup:telegramAiResultKeyboard()});
    }
    return sendTelegramAiMessageTo(chatId,llm.reply||'How can I help with your Matchday ticket?',{reply_markup:telegramAiMainKeyboard()});
  }
  return sendTelegramAiMessageTo(chatId,'I can understand structured Matchday commands, but conversational AI is temporarily unavailable. Try “Build a football 10x ticket”.',{reply_markup:telegramAiMainKeyboard()});
}


app.post('/api/telegram/bot/webhook', express.json({ limit: '1mb' }), async (req, res) => {
  if(String(process.env.TELEGRAM_AI_ENABLED || 'true').toLowerCase()==='false') return res.status(404).json({error:'Telegram AI bot disabled'});
  const expected=String(process.env.TELEGRAM_WEBHOOK_SECRET || '');
  const supplied=String(req.headers['x-telegram-bot-api-secret-token'] || '');
  if(!expected) return res.status(503).json({error:'TELEGRAM_WEBHOOK_SECRET is not configured'});
  if(supplied !== expected) return res.status(401).json({error:'unauthorized'});
  res.json({ok:true});
  handleTelegramAiUpdate(req.body).catch(err=>console.error('Telegram AI webhook error:',err.message));
});

app.post('/api/telegram/bot/setup', express.json(), async (req, res) => {
  try {
    if(!process.env.TELEGRAM_AI_BOT_TOKEN) return res.status(400).json({error:'Set TELEGRAM_AI_BOT_TOKEN first'});
    const secret=process.env.TELEGRAM_JOB_SECRET;
    if(!secret || req.headers['x-telegram-job-secret']!==secret) return res.status(401).json({error:'unauthorized'});
    const base=String(process.env.MATCHDAY_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/,'');
    if(!/^https:\/\//i.test(base)) return res.status(400).json({error:'Set MATCHDAY_BASE_URL to the public HTTPS Render URL first'});
    const webhookSecret=String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if(!webhookSecret) return res.status(400).json({error:'Set TELEGRAM_WEBHOOK_SECRET first'});
    const webhook=await telegramAiRequest('setWebhook',{url:`${base}/api/telegram/bot/webhook`,secret_token:webhookSecret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
    await telegramAiRequest('setMyCommands',{commands:[{command:'start',description:'Open Plot207 Sports Bot'},{command:'plans',description:'View Free, Pro and Elite plans'},{command:'account',description:'View plan and daily usage'},{command:'help',description:'How to use Plot207 Sports Bot'}]});
    res.json({ok:true,webhook,webhookUrl:`${base}/api/telegram/bot/webhook`});
  } catch(err){ res.status(502).json({error:'Telegram AI setup failed',detail:process.env.NODE_ENV==='production'?undefined:err.message}); }
});

app.get('/api/telegram/status', (req, res) => {
  res.json({
    configured: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID && process.env.TELEGRAM_JOB_SECRET),
    targets: ['1.30-5.00 SAFE', 2, 3, '1000 ICE HOCKEY', '1000 BASKETBALL', '1000 HANDBALL + VOLLEYBALL'],
    sportScope: 'all',
    rules: {
      regular: { minProbabilityByTarget: { '2':80, '3':80 }, winnerOnly: false, targets: [2,3], selectionCaps: { '2':20, '3':20 }, supportedMarkets: TELEGRAM_HIGH_ODDS_BET_TYPES, prioritySports: TELEGRAM_2X3X_SPORT_TIERS, primaryPrioritySports: ['hockey','basketball','tennis'], allSixSports: false, positiveEdgeRequired: false, redFlagProtection: true },
      safe: { minProbability: 85, winnerOnly: false, supportedMarkets: TELEGRAM_HIGH_ODDS_BET_TYPES, prioritySports: TELEGRAM_SAFE_SPORT_TIERS, primaryPrioritySports: ['hockey','basketball'], combinedOddsMin: 1.30, combinedOddsMax: 5.00, selectionCap: 15, positiveEdgeRequired: false, redFlagProtection: true },
      sport1000: { targetOdds: 1000, hardTarget: false, minProbability: 80, maxSelections: 15, winnerFirst: true, pools: { iceHockey: ['hockey'], basketball: ['basketball'], handballVolleyball: ['handball','volleyball'] }, supportedMarkets: TELEGRAM_HIGH_ODDS_BET_TYPES, positiveEdgeRequired: false, redFlagProtection: true },
    },
    maxSelections: Math.min(40, Math.max(1, parseInt(process.env.TELEGRAM_MAX_SELECTIONS || '40', 10))),
    scheduler: 'GitHub Actions',
    aiBot: {
      enabled: String(process.env.TELEGRAM_AI_ENABLED || 'true').toLowerCase() !== 'false',
      tokenConfigured: Boolean(process.env.TELEGRAM_AI_BOT_TOKEN),
      webhookConfigured: Boolean(process.env.TELEGRAM_WEBHOOK_SECRET),
      plans: { free: 0, pro: 5000, elite: 20000 },
    },
  });
});

// Protected endpoint intended for GitHub Actions / Render Cron. It builds all
// configured target slips, creates SportyBet booking codes, and sends them to Telegram.
// Read-only diagnosis of today's lock. Does not expose the Redis token and
// deliberately offers no force-unlock action that might duplicate live picks.
app.get('/api/telegram/daily-picks/run-status', async (req, res) => {
  if (!authorizeTelegramJob(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const redis = await getRedis();
    if (!redis) return res.status(503).json({ error: 'REDIS_URL not configured' });
    const date = watDateKey();
    const [locked, raw] = await Promise.all([
      redis.exists(`telegram:daily-picks:once:${date}`),
      redis.get(`telegram:daily-picks:status:${date}`),
    ]);
    let lastRun = null;
    try { lastRun = raw ? JSON.parse(raw) : null; } catch (_) {}
    return res.json({ date, locked: !!locked, lastRun,
      note: 'If locked, do not reset without verifying that no Telegram message was sent and the original server job has stopped.' });
  } catch (err) {
    console.error('Telegram run status check failed:', err.message);
    return res.status(502).json({ error: 'Telegram run status unavailable' });
  }
});

app.post('/api/telegram/daily-picks', express.json(), async (req, res) => {
  const secret = process.env.TELEGRAM_JOB_SECRET;
  if (!secret || req.headers['x-telegram-job-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const manual = req.headers['x-matchday-run-mode'] === 'manual';
  const today = watDateKey();
  // Scheduled runs remain protected by a per-WAT-date Redis lock. Manual
  // workflow_dispatch runs intentionally bypass that daily lock and may repeat.
  let redis;
  let token;
  let lockKey;
  let postingStarted = false;
  let cancelledBeforePosting = false;
  let lockAcquired = false;
  let releasePromise = null;
  let statusKey = `telegram:daily-picks:status:${today}`;
  const writeRunStatus = async (status, extra = {}) => {
    if (!redis) return;
    await redis.set(statusKey, JSON.stringify({ status, at: new Date().toISOString(), ...extra }), { EX: 3 * 86400 });
  };
  const releaseIfUnsent = (status, detail) => {
    if (!redis || postingStarted) return Promise.resolve();
    if (releasePromise) return releasePromise;
    releasePromise = (async () => {
      // Record cancellation/failure for both scheduled and manual runs. Only
      // scheduled runs own the once-per-day lock, so only they need unlocking.
      try { await writeRunStatus(status, { detail, mode: manual ? 'manual' : 'scheduled' }); }
      catch (statusErr) { console.error('Telegram cancellation status write failed:', statusErr.message); }
      if (!lockAcquired || !lockKey) return;
      try {
        await redis.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
          { keys: [lockKey], arguments: [token] });
      } catch (unlockErr) { console.error('Telegram unsent lock release failed:', unlockErr.message); }
    })();
    return releasePromise;
  };
  // Canceling the GitHub workflow closes its curl connection. The server can
  // otherwise keep fetching candidates and later publish despite cancellation.
  // Only abort/unlock if NO Telegram message has been attempted yet.
  res.once('close', () => {
    if (res.writableEnded || postingStarted) return;
    cancelledBeforePosting = true;
    console.warn(`[Telegram] Client disconnected before posting for ${today}; cancelling unsent run`);
    void releaseIfUnsent('cancelled_before_post', 'Workflow disconnected before the first Telegram message');
  });
  try {
    redis = await getRedis();
    // A process-local flag cannot guarantee one Telegram announcement after
    // a Render restart or across instances. Do not send without shared Redis.
    if (!redis) return res.status(503).json({ error: 'REDIS_URL required for Telegram run state and scheduled deduplication', code: 'TELEGRAM_REDIS_REQUIRED' });
    token = crypto.randomUUID();
    if (manual) {
      // workflow_dispatch is intentionally repeatable. A manual run never
      // consumes or checks the scheduled once-per-WAT-date lock.
      statusKey = `telegram:daily-picks:manual-status:${today}:${token}`;
      console.log(`[Telegram manual] Bypassing daily send lock for ${today}`);
    } else {
      lockKey = `telegram:daily-picks:once:${today}`;
      const acquired = await redis.set(lockKey, token, { NX: true, EX: 3 * 86400 });
      if (acquired !== 'OK') {
        console.log(`[Telegram schedule guard] Skipped duplicate scheduled request for ${today}`);
        const priorStatus = await redis.get(statusKey).catch(() => null);
        let runStatus = 'unknown_or_in_progress';
        if (priorStatus) {
          try { runStatus = JSON.parse(priorStatus).status || runStatus; } catch (_) {}
        }
        // Only scheduled duplicates are blocked. Manual GitHub runs can be
        // triggered at any time and intentionally bypass this daily lock.
        return res.status(409).json({ ok: false, skipped: true,
          code: 'TELEGRAM_ALREADY_STARTED_OR_SENT', reason: 'already_started_or_sent_today',
          date: today, runStatus,
          note: 'Scheduled auto-picks already started or sent today. Use the manual GitHub workflow if you intentionally want another run.' });
      }
      lockAcquired = true;
    }
    if (cancelledBeforePosting) {
      await releaseIfUnsent('cancelled_before_post', 'Workflow disconnected before generating picks');
      return;
    }
    await writeRunStatus('preparing', { mode: manual ? 'manual' : 'scheduled' });
    const result = await runTelegramDailyPicks({
      shouldAbort: () => cancelledBeforePosting,
      onPostingStart: async () => {
        postingStarted = true;
        // Sending can be ambiguous if the request fails after reaching Telegram.
        // Preserve the once-per-day lock as soon as the FIRST send is attempted.
        try { await writeRunStatus('posting', { mode: manual ? 'manual' : 'scheduled' }); }
        catch (statusErr) { console.error('Telegram posting status write failed:', statusErr.message); }
      },
    });
    try {
      await writeRunStatus('completed', { completedAt: new Date().toISOString(), mode: manual ? 'manual' : 'scheduled' });
    } catch (statusError) { console.error('Telegram daily-picks status write failed:', statusError.message); }
    if (!res.destroyed) return res.json({ ok: true, runMode: manual ? 'manual' : 'scheduled', generatedAt: new Date().toISOString(), ...result });
  } catch (err) {
    if (redis) {
      if (!postingStarted) {
        // No Telegram message was attempted: a cancelled/failed pre-post run
        // should NOT block a subsequent manual retry for the entire WAT day.
        await releaseIfUnsent(err.code === 'TELEGRAM_CANCELLED_BEFORE_POST' ? 'cancelled_before_post' : 'failed_before_post', String(err.message).slice(0, 250));
      } else {
        // Unknown/partial send: keep lock to avoid duplicating messages.
        try {
          await writeRunStatus('partial_or_unknown', { detail: String(err.message).slice(0, 250) });
        } catch (statusError) { console.error('Telegram partial status write failed:', statusError.message); }
      }
    }
    console.error('Telegram daily picks error:', err.message);
    if (res.destroyed) return;
    return res.status(err.code === 'TELEGRAM_CONFIG_MISSING' ? 503 : 502).json({
      error: err.code === 'TELEGRAM_CONFIG_MISSING' ? 'Telegram integration is not configured yet' : 'Telegram picks job failed',
      code: err.code || null,
      detail: String(err.message || 'Unknown Telegram picks error').slice(0, 500),
    });
  }
});

app.post('/api/telegram/test', express.json(), async (req, res) => {
  try {
    const secret = process.env.TELEGRAM_JOB_SECRET;
    if (!secret || req.headers['x-telegram-job-secret'] !== secret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    await sendTelegramMessage('✅ Matchday Odds Desk Telegram integration is connected.');
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram test error:', err.message);
    res.status(502).json({ error: 'Telegram test failed', detail: process.env.NODE_ENV === 'production' ? undefined : err.message });
  }
});



// One-click website share. The browser receives a short-lived one-time token only;
// Telegram credentials and the job secret never leave Render.
app.post('/api/telegram/send-slip', express.json(), async (req, res) => {
  try {
    const payload = await consumeTelegramSendToken(req.body && req.body.token);
    if (!payload) return res.status(400).json({ error: 'Send token is invalid, expired, or already used. Generate the SportyBet code again.' });
    if (!payload.shareCode) return res.status(400).json({ error: 'No SportyBet code is attached to this send token' });
    await sendTelegramMessage(telegramManualSlipText(payload));
    res.json({ ok: true });
  } catch (err) {
    console.error('Telegram manual slip error:', err.message);
    res.status(err.code === 'TELEGRAM_CONFIG_MISSING' ? 503 : 502).json({
      error: err.code === 'TELEGRAM_CONFIG_MISSING' ? 'Telegram integration is not configured yet' : 'Failed to send slip to Telegram',
      detail: process.env.NODE_ENV === 'production' ? undefined : err.message,
    });
  }
});

app.post('/api/sportybet/book', express.json(), async (req, res) => {
  try {
    if (!(await allowBookingRequest(req))) {
      return res.status(429).json({ error: 'Too many booking requests; try again in a minute' });
    }
    const selections = req.body && req.body.selections;
    if (!Array.isArray(selections) || selections.length === 0 || selections.length > 100) {
      return res.status(400).json({ error: 'selections must be an array containing 1-100 selections' });
    }
    const context = Array.isArray(req.body && req.body.telegramContext)
      ? req.body.telegramContext
      : [];
    const preferFullMarket = context.some(x => {
      const text = `${x?.marketDesc || ''} ${x?.outcomeDesc || ''} ${x?.betType || ''}`.toLowerCase();
      return text.includes('corner') || text.includes('1up') || text.includes('1 up') || text.includes('1-up');
    });
    const result = await bookBet(selections, { preferFullMarket });
    const slip = sanitizeTelegramSlip(req.body && req.body.telegramContext);
    const telegramSendToken = await createTelegramSendToken({
      shareCode: result?.shareCode || null,
      shareURL: result?.shareURL || null,
      slip,
      createdAt: new Date().toISOString(),
    });
    res.json({ ...result, telegramSendToken });
  } catch (err) {
    console.error('SportyBet booking error:', err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    res.status(status).json({
      error: err.code === 'PARSE_API_KEY_MISSING'
        ? 'SportyBet integration is not configured yet'
        : 'Failed to create SportyBet booking code',
      bookingErrorCode: err.code || null,
      detail: err.code === 'SPORTYBET_BOOKING_FAILED'
        ? err.message
        : (process.env.NODE_ENV === 'production' ? undefined : err.message),
    });
  }
});

// Manual/scheduled trigger to run the refresh job (protected by a shared secret).
// Pulling every league while respecting football-data.org's rate limit can take
// a couple of minutes, so this kicks the job off in the background and returns
// immediately rather than holding the HTTP request open the whole time.
app.post('/api/refresh/sport/:sport', express.json(), async (req, res) => {
  if (!process.env.REFRESH_SECRET || req.headers['x-refresh-secret'] !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const sport = String(req.params.sport || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!['basketball', 'hockey'].includes(sport)) {
    return res.status(400).json({ error: 'sport must be one of: basketball, hockey' });
  }

  const manual = req.headers['x-matchday-run-mode'] === 'manual';
  const days = Math.max(7, Math.min(21, parseInt(process.env.PREDICTION_DAYS_AHEAD || '21', 10) || 21));
  const hours = days * 24;
  const maxPages = Math.max(1, Math.min(20, parseInt(process.env.DAILY_SPORT_REFRESH_MAX_PAGES || process.env.ANALYZER_MAX_PAGES || '12', 10) || 12));
  const markets = ['winner', 'totals'];
  const results = {};

  try {
    for (const market of markets) {
      const payload = await loadSportyBetMarket(market, sport, {
        hours,
        maxPages,
        forceRefresh: true,
      });
      results[market] = {
        rows: Array.isArray(payload?.rows) ? payload.rows.length : 0,
        fetchedAt: payload?.fetchedAt || null,
      };
    }

    const totalRows = Object.values(results).reduce((sum, row) => sum + Number(row.rows || 0), 0);
    return res.json({
      ok: true,
      sport,
      mode: manual ? 'manual' : 'scheduled',
      refreshedAt: new Date().toISOString(),
      horizonHours: hours,
      maxPages,
      totalRows,
      markets: results,
      warning: totalRows === 0 ? 'No upcoming SportyBet rows were returned for this sport.' : null,
      probabilityModel: 'No-vig/de-margined SportyBet market probability',
    });
  } catch (err) {
    console.error(`[Daily ${sport} refresh] failed:`, err.message);
    const status = err.code === 'PARSE_API_KEY_MISSING' ? 503 : 502;
    return res.status(status).json({
      error: `Failed to refresh ${sport} daily markets`,
      detail: process.env.NODE_ENV === 'production' ? undefined : String(err.message || err),
    });
  }
});

app.post('/api/refresh', express.json(), (req, res) => {
  if (!process.env.REFRESH_SECRET || req.headers['x-refresh-secret'] !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const manual = req.headers['x-matchday-run-mode'] === 'manual';
  // Accept authenticated refresh requests even when GitHub starts late.
  // GitHub cron schedules the requested time; server authentication remains mandatory.
  // Manual requests are explicitly permitted for recovery if scheduled refresh failed.
  const { spawn } = require('child_process');
  const child = spawn('node', [path.join(__dirname, 'jobs', 'refresh.js')], {
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => console.log(d.toString().trim()));
  child.stderr.on('data', d => console.error(d.toString().trim()));
  child.on('error', error => console.error('Refresh process failed to spawn:', error.message));
  child.on('exit', code => console.log(`refresh job exited with code ${code}`));
  child.unref();
  return res.json({ ok: true, started: true, mode: manual ? 'manual' : 'scheduled', message: 'Refresh started in the background; GitHub Actions checks /api/predictions for completion.' });
});

app.listen(PORT, () => console.log(`Matchday site listening on :${PORT}`));
