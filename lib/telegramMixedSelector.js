'use strict';

const { selectAutoBet } = require('./autoPicker');

// Automatic Telegram tickets open one sport tier at a time. The algorithm
// considers lower-priority sports only when the earlier pool cannot reach
// the requested target under the leg cap and the caller's market/probability filters.
const SPORT_TIERS = Object.freeze([
  Object.freeze(['hockey', 'basketball']),
  Object.freeze(['handball']),
  Object.freeze(['volleyball']),
  Object.freeze(['tennis']),
  Object.freeze(['football']),
]);

function telegramSportTier(candidate) {
  const sport = String(candidate?.sport || '').toLowerCase();
  if (sport.includes('hockey') || sport.includes('basket')) return 0;
  if (sport.includes('handball')) return 1;
  if (sport.includes('volley')) return 2;
  if (sport.includes('tennis')) return 3;
  if (sport.includes('football') || sport.includes('soccer')) return 4;
  return -1;
}

function selectTelegramMixedWithSportPriority(plan, candidates, maxSelections, options = {}) {
  const qualified = (candidates || []).filter(c => telegramSportTier(c) >= 0 && Number(c.probability) >= Number(plan.minProbability || 0));
  const primaryCount = qualified.filter(c => telegramSportTier(c) === 0).length;
  const pickerOptions = {
    targetOdds: plan.targetOdds,
    maxSelections,
    // A pool can be searched up to five times per target. Bound the default
    // per-stage trial count to keep the 08:25 daily job practical; explicit
    // configured trial counts still take precedence.
    trials: options.trials ?? Number(process.env.TELEGRAM_MIXED_PICK_TRIALS || process.env.TELEGRAM_PICK_TRIALS || 500),
    minQualityScore: 0,
    requirePositiveEV: false,
    ...(options.rng ? { rng: options.rng } : {}),
  };
  let best = null;
  for (let tier = 0; tier < SPORT_TIERS.length; tier++) {
    const pool = qualified.filter(c => telegramSportTier(c) <= tier);
    if (!pool.length) continue;
    const result = selectAutoBet(pool, pickerOptions);
    if (!result.selections.length) continue;
    // The whole candidate pool expands in fixed priority order, so there are
    // no Handball/Volleyball/Tennis/Football fallbacks while a prior tier
    // can already build the target. Preserve closest-available behavior.
    best = {
      result,
      priorityOnly: result.selections.every(c => telegramSportTier(c) === 0),
      preferredCount: primaryCount,
      fallbackTier: tier,
    };
    if (result.reachedTarget) return best;
  }
  return best || {
    result: selectAutoBet([], pickerOptions),
    priorityOnly: false,
    preferredCount: primaryCount,
    fallbackTier: null,
  };
}

module.exports = { SPORT_TIERS, telegramSportTier, selectTelegramMixedWithSportPriority };
