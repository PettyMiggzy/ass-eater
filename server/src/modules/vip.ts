import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma';
import { money } from '../core/ledger';
import { subscribeVip, getVipStatus } from '../core/vip';

/**
 * VIP: $20/month for the badge and a 10% discount on everything.
 *
 * Paid in credits like everything else -- the fan never touches a token or a
 * wallet. The revenue is what buys $ONLYONE on the open market and burns it
 * (workers/token-burn.ts). Replaced the earlier "burn tokens yourself for
 * permanent VIP" design on 2026-09-18; see core/vip.ts for why.
 */
export const vip: FastifyPluginAsync = async (app) => {
  app.get('/status', { preHandler: app.auth }, async (req) => money(prisma, (tx) => getVipStatus(tx, req.user.id)));

  // No body: there is one price and one period. Extends from the current
  // expiry when there is one, so paying early never burns the remainder.
  app.post('/subscribe', { preHandler: app.auth }, async (req) =>
    money(prisma, (tx) => subscribeVip(tx, req.user.id)));
};
