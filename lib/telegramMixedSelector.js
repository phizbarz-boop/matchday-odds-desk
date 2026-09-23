'use strict';

const { selectAutoBet } = require('./autoPicker');

// Default scheduled Telegram priority. Callers can override this per target.
const SPORT_TIERS = Object.freeze([
  Object.freeze(['hockey', 'basketball', 'tennis']),
  Object.freeze(['handball', 'volleyball']),
]);

function normalizedSport(candidate) {
  const sport = String(candidate?.sport || '').toLowerCase();
  if (sport.includes('hockey')) return 'hockey';
  if (sport.includes('basket')) return 'basketball';
  if (sport.includes('tennis')) return 'tennis';
  if (sport.includes('handball')) return 'handball';
  if (sport.includes('volley')) return 'volleyball';
  if (sport.includes('football') || sport.includes('soccer')) return 'football';
  return '';
}

function sportTierFor(candidate, tiers = SPORT_TIERS) {
  const sport = normalizedSport(candidate);
  return tiers.findIndex(group => group.includes(sport));
}

function telegramSportTier(candidate) {
  return sportTierFor(candidate, SPORT_TIERS);
}

function runPool(plan, pool, maxSelections, options) {
  return selectAutoBet(pool, {
    targetOdds: plan.targetOdds,
    maxSelections,
    trials: options.trials ?? Number(process.env.TELEGRAM_MIXED_PICK_TRIALS || process.env.TELEGRAM_PICK_TRIALS || 500),
    minQualityScore: 0,
    requirePositiveEV: false,
    ...(options.rng ? { rng: options.rng } : {}),
  });
}

// Winner-first + sport-priority selector.
// Phase 1: try winner markets only, expanding sports one priority tier at a time.
// Phase 2: only if winners cannot reach target, allow other supported markets,
//          again expanding sports one tier at a time.
function selectTelegramMixedWithSportPriority(plan, candidates, maxSelections, options = {}) {
  const tiers = Array.isArray(options.sportTiers) && options.sportTiers.length ? options.sportTiers : SPORT_TIERS;
  const isWinner = typeof options.isWinner === 'function' ? options.isWinner : (() => false);
  const qualified = (candidates || []).filter(c => sportTierFor(c, tiers) >= 0 && Number(c.probability) >= Number(plan.minProbability || 0));
  const primaryCount = qualified.filter(c => sportTierFor(c, tiers) === 0).length;
  let best = null;

  const phases = [
    { winnerOnly: true, filter: c => isWinner(c) },
    { winnerOnly: false, filter: () => true },
    // If the general picker still favors short-priced winners and misses the
    // target under the leg cap, explicitly try supplemental markets last.
    { winnerOnly: false, filter: c => !isWinner(c) },
  ];

  for (const phase of phases) {
    for (let tier = 0; tier < tiers.length; tier++) {
      const pool = qualified.filter(c => sportTierFor(c, tiers) <= tier && phase.filter(c));
      if (!pool.length) continue;
      const result = runPool(plan, pool, maxSelections, options);
      if (!result.selections.length) continue;
      best = {
        result,
        priorityOnly: result.selections.every(c => sportTierFor(c, tiers) === 0),
        preferredCount: primaryCount,
        fallbackTier: tier,
        winnerOnly: phase.winnerOnly,
      };
      if (result.reachedTarget) return best;
    }
  }

  return best || {
    result: runPool(plan, [], maxSelections, options),
    priorityOnly: false,
    preferredCount: primaryCount,
    fallbackTier: null,
    winnerOnly: false,
  };
}

module.exports = { SPORT_TIERS, telegramSportTier, selectTelegramMixedWithSportPriority, normalizedSport, sportTierFor };
