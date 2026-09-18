import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma';
import { CHAIN_ID, depositAccount, TOKENS } from '../lib/chain';
import { getUsdPrice } from '../lib/price';

// Namespace for the Postgres advisory lock that serialises deposit-address
// allocation (see POST /deposit-address). Arbitrary -- it only has to not
// collide with another advisory lock this app takes, and it doesn't take any.
const ADDRESS_LOCK_NS = 84120;

export const wallet: FastifyPluginAsync = async (app) => {
  app.get('/balance', { preHandler: app.auth }, async (req) => {
    const a = await prisma.account.findUnique({ where: { userId: req.user.id } });
    // onlyAssCents is a separate pool, only funded by depositing $ONLYONE
    // directly. It is NOT spendable: the only thing it can do is a VIP burn
    // (core/vip.ts). Credits (balanceCents) are what pays for everything.
    // (was: a discount when spent from -- removed, the token is not money
    // on subscribe/tip/unlock/buy/join-live). See core/ledger.ts charge().
    return { balanceCents: Number(a?.balanceCents ?? 0), onlyAssCents: Number(a?.onlyAssCents ?? 0) };
  });

  app.get('/history', { preHandler: app.auth }, async (req: any) => {
    const rows = await prisma.ledgerEntry.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100, skip: Number(req.query.offset ?? 0) });
    return rows.map(r => ({ ...r, amountCents: Number(r.amountCents) }));
  });

  /** One address per user per chain, derived deterministically. Accepts any allowlisted dollar stablecoin, ETH and $ONLYONE on that address. */
  app.post('/deposit-address', { preHandler: app.auth }, async (req) => {
    const existing = await prisma.depositAddress.findUnique({ where: { userId_chainId: { userId: req.user.id, chainId: CHAIN_ID } } });
    if (existing) return existing;
    return prisma.$transaction(async (tx) => {
      // MAX+1 on its own is a read-then-write race: two allocations that read
      // the same MAX derive the *same* HD address and hand it to two different
      // users, so one user's incoming deposits get credited to the other. The
      // advisory lock is held until this transaction commits, so exactly one
      // allocation per chain is ever in flight. Re-reading the caller's own row
      // inside the lock also makes a double-clicked request return the address
      // the first one just created, instead of failing the (userId, chainId)
      // unique index.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADDRESS_LOCK_NS}::int, ${CHAIN_ID}::int)`;
      const mine = await tx.depositAddress.findUnique({ where: { userId_chainId: { userId: req.user.id, chainId: CHAIN_ID } } });
      if (mine) return mine;
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
    STABLE: 1, ETH: await getUsdPrice('ETH'), ONLYASS: await getUsdPrice('ONLYASS'),
    assDepositBonusBps: Number(process.env.ONLYASS_DEPOSIT_BONUS_BPS ?? 0),
  }));
};
