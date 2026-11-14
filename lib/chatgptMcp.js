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

function createChatgptMcpRouter({ getBooking, publicAccess = false }) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

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
        }]
      });
    }

    if (method === 'tools/call') {
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
