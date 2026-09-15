import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma';
import { CHAIN_ID, depositAccount, TOKENS } from '../lib/chain';
import { getUsdPrice } from '../lib/price';

export const wallet: FastifyPluginAsync = async (app) => {
  app.get('/balance', { preHandler: app.auth }, async (req) => {
    const a = await prisma.account.findUnique({ where: { userId: req.user.id } });
    return { balanceCents: Number(a?.balanceCents ?? 0) };
  });

  app.get('/history', { preHandler: app.auth }, async (req: any) => {
    const rows = await prisma.ledgerEntry.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100, skip: Number(req.query.offset ?? 0) });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents) }));
  });

  /** One address per user per chain, derived deterministically. Accepts USDC, ETH and $ONLYASS on that address. */
  app.post('/deposit-address', { preHandler: app.auth }, async (req) => {
    const existing = await prisma.depositAddress.findUnique({ where: { userId_chainId: { userId: req.user.id, chainId: CHAIN_ID } } });
    if (existing) return existing;
    return prisma.$transaction(async (tx) => {
      const [{ next }] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(MAX("derivationIndex"),0)+1 AS next FROM "DepositAddress" WHERE "chainId"=${CHAIN_ID}`;
      const address = depositAccount(Number(next)).address;
      return tx.depositAddress.create({ data: { userId: req.user.id, chainId: CHAIN_ID, address, derivationIndex: Number(next) } });
    });
  });

  app.get('/deposits', { preHandler: app.auth }, async (req) => {
    const rows = await prisma.deposit.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return rows.map(r => ({ ...r, usdCents: Number(r.usdCents) }));
  });

  app.get('/rates', async () => ({
    chainId: CHAIN_ID, tokens: TOKENS,
    USDC: 1, ETH: await getUsdPrice('ETH'), ONLYASS: await getUsdPrice('ONLYASS'),
    assDepositBonusBps: Number(process.env.ONLYASS_DEPOSIT_BONUS_BPS ?? 0),
  }));
};
