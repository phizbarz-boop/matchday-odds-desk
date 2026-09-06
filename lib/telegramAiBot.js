const memoryUsers = new Map();

const PLANS = {
  free: {
    id: 'free', name: 'Free', priceNgn: 0,
    dailyTickets: 2, dailyAnalyzes: 0, maxTargetOdds: 10, maxSelections: 12,
    sports: ['football'], copyHub: false, savedPreferences: false,
    description: 'Try Matchday AI with football-only tickets up to 10x.'
  },
  pro: {
    id: 'pro', name: 'Pro', priceNgn: 5000,
    dailyTickets: 10, dailyAnalyzes: 5, maxTargetOdds: 100, maxSelections: 30,
    sports: ['football', 'basketball', 'hockey', 'all'], copyHub: false, savedPreferences: true,
    description: 'Full multi-sport AI builder, code analyzer and saved preferences.'
  },
  elite: {
    id: 'elite', name: 'Elite', priceNgn: 20000,
    dailyTickets: 40, dailyAnalyzes: 30, maxTargetOdds: 1000, maxSelections: 40,
    sports: ['football', 'basketball', 'hockey', 'all'], copyHub: true, savedPreferences: true,
    description: 'Highest limits, advanced analyzer access and Copy Hub rankings.'
  }
};

function dayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function userKey(id) { return `telegram:ai:user:${String(id)}`; }

function freshUser(id, from = {}) {
  return {
    telegramId: String(id),
    username: from.username || '', firstName: from.first_name || '',
    plan: 'free', planExpiresAt: null,
    usageDay: dayKey(), ticketsUsed: 0, analyzesUsed: 0,
    preferences: { sport: 'football', maxMatchOdds: null, minProbability: 70 },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
}

function normalizeUser(u, id, from = {}) {
  const base = freshUser(id, from);
  const out = { ...base, ...(u || {}), preferences: { ...base.preferences, ...(u?.preferences || {}) } };
  if (!PLANS[out.plan]) out.plan = 'free';
  if (out.plan !== 'free' && out.planExpiresAt && Date.parse(out.planExpiresAt) <= Date.now()) {
    out.plan = 'free'; out.planExpiresAt = null;
  }
  if (out.usageDay !== dayKey()) {
    out.usageDay = dayKey(); out.ticketsUsed = 0; out.analyzesUsed = 0;
  }
  if (from.username) out.username = from.username;
  if (from.first_name) out.firstName = from.first_name;
  out.updatedAt = new Date().toISOString();
  return out;
}

async function getUser(redis, id, from = {}) {
  let raw = null;
  if (redis) raw = await redis.get(userKey(id));
  else raw = memoryUsers.get(userKey(id)) || null;
  let parsed = null;
  try { parsed = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null; } catch {}
  const user = normalizeUser(parsed, id, from);
  await saveUser(redis, user);
  return user;
}

async function saveUser(redis, user) {
  const value = JSON.stringify(user);
  if (redis) await redis.set(userKey(user.telegramId), value);
  else memoryUsers.set(userKey(user.telegramId), value);
  return user;
}

function getPlan(user) { return PLANS[user?.plan] || PLANS.free; }

async function consume(redis, user, kind) {
  const normalized = normalizeUser(user, user.telegramId);
  const plan = getPlan(normalized);
  if (kind === 'ticket') {
    if (normalized.ticketsUsed >= plan.dailyTickets) return { ok: false, user: normalized, plan, reason: 'daily_ticket_limit' };
    normalized.ticketsUsed += 1;
  } else if (kind === 'analyze') {
    if (normalized.analyzesUsed >= plan.dailyAnalyzes) return { ok: false, user: normalized, plan, reason: 'daily_analyzer_limit' };
    normalized.analyzesUsed += 1;
  }
  await saveUser(redis, normalized);
  return { ok: true, user: normalized, plan };
}

async function activatePlan(redis, telegramId, planId, days = 30) {
  if (!PLANS[planId] || planId === 'free') throw new Error('plan must be pro or elite');
  const user = await getUser(redis, telegramId);
  user.plan = planId;
  user.planExpiresAt = new Date(Date.now() + Math.max(1, Number(days) || 30) * 86400000).toISOString();
  await saveUser(redis, user);
  return user;
}

function parseNaturalRequest(text) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  if (!raw) return { intent: 'menu' };
  if (/^\/start\b|^start$|\bmenu\b|^home$/.test(t)) return { intent: 'menu' };
  if (/^\/help\b|\bhelp\b|how (do|can) i/.test(t)) return { intent: 'help' };
  if (/^\/plans\b|\bpricing\b|\bplans?\b|\bupgrade\b|subscription/.test(t)) return { intent: 'plans' };
  if (/^\/account\b|my plan|my account|usage/.test(t)) return { intent: 'account' };
  if (/leaderboard|rankings?|top punter|copy hub|copy bet/.test(t)) return { intent: 'copy' };

  const codeMatch = raw.toUpperCase().match(/(?:ANALY[ZS]E|ANALY[ZS]E CODE|CHECK CODE|CODE)\s*[:#-]?\s*([A-Z0-9_-]{4,24})/i);
  if (codeMatch || (/^[A-Z0-9_-]{4,24}$/.test(raw.toUpperCase()) && /[A-Z]/.test(raw))) {
    return { intent: 'analyze', bookingCode: (codeMatch?.[1] || raw).toUpperCase() };
  }

  const isTicket = /ticket|slip|odds|acca|accumulator|build|give me|safe|pick/.test(t) || /^\d+(?:\.\d+)?x?$/.test(t);
  if (isTicket) {
    let targetOdds = null;
    const oddsMatch = t.match(/(?:target|build|give me|make|at|for)?\s*(\d+(?:\.\d+)?)\s*(?:x|odds?)\b/);
    if (oddsMatch) targetOdds = Number(oddsMatch[1]);
    if (!targetOdds) {
      const standalone = t.match(/\b(1\.3(?:0|5)?|5|10|20|50|100|250|500|750|1000)\b/);
      if (standalone) targetOdds = Number(standalone[1]);
    }
    const safe = /\bsafe\b|safest|low risk/.test(t);
    if (safe && !targetOdds) targetOdds = 1.325;
    if (!targetOdds) targetOdds = 10;
    let sport = null;
    if (/all sports|all sport/.test(t)) sport = 'all';
    else if (/football|soccer/.test(t)) sport = 'football';
    else if (/basketball|basket ball/.test(t)) sport = 'basketball';
    else if (/hockey|ice hockey/.test(t)) sport = 'hockey';
    const maxOddsMatch = t.match(/(?:max(?:imum)?\s*(?:odd|odds)|nothing above|under)\s*(?:per match\s*)?([1-9]\d*(?:\.\d+)?)/);
    const minProbMatch = t.match(/(?:min(?:imum)?\s*(?:probability|prob)|at least)\s*(\d{2})(?:\s*%)?/);
    let betTypes = null;
    if (/over\s*0\.5|o0\.5/.test(t)) betTypes = ['ou05'];
    else if (/over\s*1\.5|o1\.5/.test(t)) betTypes = ['ou15'];
    else if (/under\s*4\.5|u4\.5/.test(t)) betTypes = ['ou45'];
    else if (/double chance/.test(t)) betTypes = ['dc'];
    else if (/draw no bet|\bdnb\b/.test(t)) betTypes = ['dnb'];
    else if (/\b1up\b|1 up/.test(t)) betTypes = ['oneup'];
    return {
      intent: 'ticket', targetOdds, safe, sport,
      maxMatchOdds: maxOddsMatch ? Number(maxOddsMatch[1]) : null,
      minProbability: minProbMatch ? Number(minProbMatch[1]) : (safe ? 80 : 70),
      betTypes
    };
  }
  return { intent: 'chat', text: raw };
}

function planKeyboard() {
  const rows = [];
  if (process.env.PRO_PAYMENT_URL) rows.push([{ text: '⭐ Get Pro — ₦5,000', url: process.env.PRO_PAYMENT_URL }]);
  else rows.push([{ text: '⭐ Pro — ₦5,000', callback_data: 'plan:pro' }]);
  if (process.env.ELITE_PAYMENT_URL) rows.push([{ text: '👑 Get Elite — ₦20,000', url: process.env.ELITE_PAYMENT_URL }]);
  else rows.push([{ text: '👑 Elite — ₦20,000', callback_data: 'plan:elite' }]);
  return { inline_keyboard: rows };
}

function mainKeyboard() {
  return { inline_keyboard: [
    [{ text: '🛡 Safe', callback_data: 'ticket:safe' }, { text: '🎯 10x', callback_data: 'ticket:10' }, { text: '🔥 50x', callback_data: 'ticket:50' }],
    [{ text: '🔎 Analyze Code', callback_data: 'action:analyze' }, { text: '💎 Plans', callback_data: 'action:plans' }],
    [{ text: '👤 My Account', callback_data: 'action:account' }, { text: '🏆 Copy Rankings', callback_data: 'action:copy' }]
  ] };
}

function plansText() {
  return [
    '💎 MATCHDAY AI PLANS', '',
    '🆓 FREE — ₦0',
    '• 2 AI tickets/day', '• Football only', '• Up to 10x target', '• Max 12 selections', '• No code analyzer / Copy Hub', '',
    '⭐ PRO — ₦5,000/month',
    '• 10 AI tickets/day', '• Football + Basketball + Ice Hockey', '• Up to 100x target', '• Max 30 selections', '• 5 SportyBet code analyses/day', '• Saved preferences', '',
    '👑 ELITE — ₦20,000/month',
    '• 40 AI tickets/day', '• All supported sports', '• Up to 1000x target', '• Max 40 selections', '• 30 code analyses/day', '• Copy Hub / punter rankings', '• Highest access limits', '',
    'All model probabilities are estimates, not guarantees.'
  ].join('\n');
}

module.exports = { PLANS, getUser, saveUser, getPlan, consume, activatePlan, parseNaturalRequest, planKeyboard, mainKeyboard, plansText };
