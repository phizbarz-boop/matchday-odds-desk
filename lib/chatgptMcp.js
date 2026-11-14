'use strict';

const express = require('express');
const crypto = require('crypto');
const { decodeBookingSelections } = require('./bookingDecoder');

const asText = value => {
  if (value == null) return '';
  if (typeof value === 'object') return String(value.desc ?? value.name ?? value.label ?? '');
  return String(value);
};
const firstText = (...values) => {
  for (const value of values) {
    const result = asText(value).trim();
    if (result) return result;
  }
  return null;
};
const kickoffIso = row => {
  const raw = row.kickoffUtc ?? row.estimateStartTime ?? row.startTime;
  if (raw == null || raw === '') return null;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 1e11 ? numeric * 1000 : numeric)
    : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function createChatgptMcpRouter({ getBooking, bookBet, publicAccess = false }) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  // Anonymous share-code creation is more expensive than ticket reading.
  // A source booking code and explicit selection positions are mandatory.
  const bookingHits = new Map();
  const recentBookingRequests = new Map();
  function allowBooking(ip, key) {
    const now = Date.now();
    for (const [k,v] of bookingHits) if (v.until <= now) bookingHits.delete(k);
    for (const [k,v] of recentBookingRequests) if (v.until <= now) recentBookingRequests.delete(k);
    if (bookingHits.size > 2000 || recentBookingRequests.size > 2000) return false;
    if (recentBookingRequests.has(key)) return false;
    const k = ip || 'unknown';
    const record = bookingHits.get(k) || { count: 0, until: now + 60000 };
    if (record.count >= 2) return false;
    record.count++;
    bookingHits.set(k, record);
    recentBookingRequests.set(key, { until: now + 120000 });
    return true;
  }


  if (publicAccess) {
    // In-memory per-IP rate limit; each Render instance has its own counters.
    const hits = new Map();
    const windowMs = 60_000;
    const maxRequests = 20;
    router.use((req, res, next) => {
      res.set('Cache-Control', 'no-store');
      const now = Date.now();
      const key = req.ip || 'unknown';
      let entry = hits.get(key);
      if (!entry || now >= entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      if (++entry.count > maxRequests) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
        return res.status(429).json({ error: 'Rate limit exceeded' });
      }
      if (hits.size > 2000) {
        for (const [ip, record] of hits) {
          if (now >= record.resetAt) hits.delete(ip);
        }
      }
      next();
    });
  }

  if (!publicAccess) router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');

    const secret = process.env.MATCHDAY_MCP_TOKEN || '';
    const supplied = (req.get('authorization') || '')
      .replace(/^Bearer\s+/i, '');

    const a = Buffer.from(secret);
    const b = Buffer.from(supplied);

    if (a.length < 32)
      return res.status(503).json({ error: 'MCP not configured' });

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b))
      return res.status(401).json({ error: 'Unauthorized' });

    next();
  });

  router.post('/', async (req, res) => {
    const { id, method, params = {} } = req.body || {};

    const reply = result => res.json({
      jsonrpc: '2.0', id, result
    });

    if (id === undefined) return res.status(202).end();

    if (method === 'initialize') {
      return reply({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: {
          name: 'matchday-ticket-reader',
          version: '1.0.0'
        }
      });
    }

    if (method === 'ping') return reply({});

    if (method === 'tools/list') {
      return reply({
        tools: [{
          name: 'get_sportybet_ticket',
          description: 'Retrieve SportyBet ticket selections by booking code. Read-only.',
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string' }
            },
            required: ['code'],
            additionalProperties: false
          }
        }, {
          name: 'create_sportybet_booking_code',
          description: 'Create a SportyBet share/booking code for explicitly selected 1-based positions from an existing ticket. Does not place a wager or stake money. Only use after the user requests a code.',
          inputSchema: {
            type: 'object',
            properties: {
              sourceCode: { type: 'string', description: 'Existing SportyBet booking code' },
              selectionNumbers: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 30, description: '1-based selection positions from the source ticket, in original order' }
            },
            required: ['sourceCode', 'selectionNumbers'],
            additionalProperties: false
          }
        }]
      });
    }

    if (method === 'tools/call') {
      if (params.name === 'create_sportybet_booking_code') {
        const sourceCode = String(params.arguments?.sourceCode || '').trim().toUpperCase();
        const numbers = params.arguments?.selectionNumbers;
        const fail = message => reply({ content: [{ type: 'text', text: message }], isError: true });
        if (!/^[A-Z0-9_-]{4,24}$/.test(sourceCode) ||
            !Array.isArray(numbers) || numbers.length < 1 || numbers.length > 30 ||
            numbers.some(n => !Number.isSafeInteger(n) || n < 1) ||
            new Set(numbers).size !== numbers.length) {
          return fail('Provide a valid sourceCode and 1-30 unique, 1-based selectionNumbers.');
        }
        if (typeof bookBet !== 'function') return fail('Booking service unavailable.');
        const requestKey = crypto.createHash('sha256')
          .update(JSON.stringify([sourceCode, [...numbers].sort((a,b)=>a-b)])).digest('hex');
        if (!allowBooking(req.ip, requestKey)) return fail('Booking creation rate-limited or duplicate request. Retry later.');
        try {
          const source = await getBooking(sourceCode, { fresh: true });
          const rows = decodeBookingSelections(source);
          if (!rows.length || numbers.some(n => n > rows.length)) return fail('Source ticket or selection positions unavailable.');
          const now = Date.now();
          const chosen = numbers.map(n => rows[n-1]);
          if (chosen.some(r => !r.eventId || !r.marketId || !r.outcomeId ||
              !kickoffIso(r) || Date.parse(kickoffIso(r)) <= now + 5*60000)) {
            return fail('One or more selected events have started, expired, or lack complete booking identifiers.');
          }
          if (new Set(chosen.map(r => String(r.eventId))).size !== chosen.length)
            return fail('Only one selection per event is allowed.');
          const legs = chosen.map(r => ({
            eventId: String(r.eventId), marketId: String(r.marketId),
            outcomeId: String(r.outcomeId),
            ...(r.specifier != null && String(r.specifier) !== '' ? { specifier: String(r.specifier) } : {})
          }));
          const result = await bookBet(legs);
          if (!result?.shareCode) return fail('SportyBet did not confirm a booking code.');
          const payload = { shareCode: result.shareCode, sourceCode,
            selectionNumbers: numbers, selectionCount: legs.length,
            shareURL: result.shareURL || null,
            unavailableOutcomes: result.unavailableOutcomes || [] };
          return reply({ content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload, isError: false });
        } catch (err) {
          console.error('[MCP booking]', err.code || err.message);
          return fail('SportyBet could not confirm the share code. Do not assume a code was created.');
        }
      }
      if (params.name !== 'get_sportybet_ticket') {
        return res.json({
          jsonrpc: '2.0', id,
          error: { code: -32602, message: 'Unknown tool' }
        });
      }

      const code = String(params.arguments?.code || '')
        .trim().toUpperCase();

      if (!/^[A-Z0-9_-]{4,24}$/.test(code)) {
        return res.json({
          jsonrpc: '2.0', id,
          error: { code: -32602, message: 'Invalid booking code' }
        });
      }

      try {
        const booking = await getBooking(code, { fresh: true });
        const selections = decodeBookingSelections(booking);

        const ticket = {
          code,
          selectionCount: selections.length,
          selections: selections.map(row => {
            // The decoder resolves chosen outcomes as outcomeDesc.
            const selection = firstText(
              row.selectedOutcome,
              row.selected_outcome,
              row.outcomeDesc,
              row.outcome_name,
              row.outcome
            );
            const oddsValue = Number(row.odds ?? row.price);
            return {
              sport: firstText(row.sport, row.sport_name),
              eventId: firstText(row.eventId, row.event_id),
              home: firstText(row.homeTeamName, row.home_team, row.homeTeam, row.home),
              away: firstText(row.awayTeamName, row.away_team, row.awayTeam, row.away),
              tournament: firstText(row.tournament, row.tournament_name, row.league),
              kickoffUtc: kickoffIso(row),
              marketId: firstText(row.marketId, row.market_id),
              market: firstText(row.marketDesc, row.market_name, row.market),
              outcomeId: firstText(row.outcomeId, row.outcome_id),
              selection,
              selectionResolved: selection !== null,
              odds: Number.isFinite(oddsValue) && oddsValue > 0 ? oddsValue : null,
              specifier: row.specifier ?? row.specifiers ?? null
            };
          })
        };

        return reply({
          content: [{
            type: 'text',
            text: JSON.stringify(ticket)
          }],
          structuredContent: ticket,
          isError: false
        });
      } catch (err) {
        console.error('[MCP]', err.message);
        return reply({
          content: [{
            type: 'text',
            text: 'Ticket lookup unavailable'
          }],
          isError: true
        });
      }
    }

    return res.json({
      jsonrpc: '2.0', id,
      error: { code: -32601, message: 'Method not found' }
    });
  });

  return router;
}

module.exports = { createChatgptMcpRouter };
