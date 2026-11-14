'use strict';
const express = require('express');
const { decodeBookingSelections } = require('./bookingDecoder');

function createPublicTicketRouter({ getBooking }) {
  const router = express.Router();
  const attempts = new Map();
  router.get('/:code', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9_-]{4,24}$/.test(code)) return res.status(400).json({ error: 'Invalid booking code' });
    const now = Date.now();
    if (attempts.size > 2000) {
      for (const [key, value] of attempts) if (value.expires <= now) attempts.delete(key);
    }
    const key = String(req.ip || 'unknown');
    let entry = attempts.get(key);
    if (!entry || entry.expires <= now) entry = { expires: now + 60000, count: 0 };
    if (entry.count >= 12) return res.status(429).json({ error: 'Rate limit exceeded' });
    entry.count++;
    attempts.set(key, entry);
    try {
      const booking = await getBooking(code, { fresh: true });
      const text = value => value && typeof value === 'object'
        ? String(value.desc ?? value.name ?? value.label ?? '')
        : String(value ?? '');
      const selections = decodeBookingSelections(booking).map(row => {
        const timestamp = Number(row.estimateStartTime);
        return {
          sport: text(row.sport ?? row.sport_name),
          eventId: String(row.eventId ?? row.event_id ?? ''),
          home: text(row.homeTeamName ?? row.home_team ?? row.homeTeam ?? row.home),
          away: text(row.awayTeamName ?? row.away_team ?? row.awayTeam ?? row.away),
          tournament: text(row.tournament ?? row.tournament_name ?? row.league),
          kickoffUtc: row.kickoffUtc ?? (Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : null),
          marketId: String(row.marketId ?? row.market_id ?? ''),
          market: text(row.marketDesc ?? row.market_name ?? row.market),
          outcomeId: String(row.outcomeId ?? row.outcome_id ?? ''),
          selection: text(row.selectedOutcome ?? row.selected_outcome ?? row.outcomeDesc ?? row.outcome_name ?? row.outcome),
          odds: Number(row.odds ?? row.price) || null,
          specifier: row.specifier ?? row.specifiers ?? null,
        };
      });
      if (!selections.length) return res.status(404).json({ error: 'No selections found for this code' });
      res.json({ code, selectionCount: selections.length, selections });
    } catch (error) {
      console.error('[Public ticket lookup]', error.code || error.message);
      res.status(502).json({ error: 'Ticket lookup unavailable' });
    }
  });
  return router;
}
module.exports = { createPublicTicketRouter };
