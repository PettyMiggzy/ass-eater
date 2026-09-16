import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { money } from '../core/ledger';
import { burnTokens, getVipStatus } from '../core/vip';

// "Burn $ONLYASS for VIP" -- a fan permanently gives up tokens (from their
// $ONLYASS-funded balance) for a platform-wide discount on everything, once
// their cumulative burn crosses the current threshold. See core/vip.ts's
// header for exactly what "burn" means here (ledger-side, not yet an
// on-chain burn transaction) and MEMORY.md's "Fee structure & discounts"
// section for why this replaced the earlier "stake for a month" idea.
export const vip: FastifyPluginAsync = async (app) => {
  app.get('/status', { preHandler: app.auth }, async (req) => money(prisma, (tx) => getVipStatus(tx, req.user.id)));

  app.post('/burn', { preHandler: app.auth }, async (req) => {
    const { tokens } = z.object({ tokens: z.number().positive().max(1_000_000_000) }).parse(req.body);
    return money(prisma, (tx) => burnTokens(tx, req.user.id, tokens));
  });
};
