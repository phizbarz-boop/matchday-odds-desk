'use strict';

const express = require('express');
const crypto = require('crypto');
const { decodeBookingSelections } = require('./bookingDecoder');

function createChatgptMcpRouter({ getBooking }) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }));

  router.use((req, res, next) => {
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
          selections: selections.map(row => ({
            sport: row.sport,
            eventId: row.eventId,
            home: row.homeTeamName,
            away: row.awayTeamName,
            tournament: row.tournament,
            market: row.marketDesc,
            selection: row.selectedOutcome,
            odds: row.odds,
            kickoffUtc: row.kickoffUtc,
            specifier: row.specifier
          }))
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
