import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { CHAIN_ID, depositAddressAt, TOKENS, publicClient } from '../lib/chain.js';
import { getUsdPrice } from '../lib/price.js';
import { page } from '../plugins/pagination.js';

// Namespace for the Postgres advisory lock that serialises deposit-address
// allocation (see POST /deposit-address). Arbitrary -- it only has to not
// collide with another advisory lock this app takes, and it doesn't take any.
const ADDRESS_LOCK_NS = 84120;

// issuedBlock is a BigInt, which JSON.stringify refuses; returned as a string.
const publicAddr = <T extends { issuedBlock: bigint | null }>(a: T) => ({ ...a, issuedBlock: a.issuedBlock?.toString() ?? null });

/**
 * Ledger meta as the account holder may see it. Auction rows once carried
 * the id of the bidder who outbid this fan (`outbidBy`); the release now
 * records only {reason:'outbid'} (core/auctions.ts) and the migration
 * stripped old rows, but no other bidder's identity is ever returned from
 * an auction row whatever is stored, so the bid history's anonymity cannot
 * be undone through the fan's own wallet.
 */
export function fanSafeMeta(type: string, meta: unknown): unknown {
  if (!type.startsWith('AUCTION_BID_') || !meta || typeof meta !== 'object' || Array.isArray(meta)) return meta;
  const { outbidBy, bidderId, winnerId, ...rest } = meta as Record<string, unknown>;
  void outbidBy; void bidderId; void winnerId;
  return 'outbidBy' in (meta as object) && !('reason' in rest) ? { ...rest, reason: 'outbid' } : rest;
}

export const wallet: FastifyPluginAsync = async (app) => {
  app.get('/balance', { preHandler: app.auth }, async (req) => {
    const a = await prisma.account.findUnique({ where: { userId: req.user.id } });
    // onlyOneCents is a separate pool, only funded by depositing $ONLYONE
    // directly. It is NOT spendable: the only thing it can do is a VIP burn
    // (core/vip.ts). Credits (balanceCents) are what pays for everything.
    // (was: a discount when spent from -- removed, the token is not money
    // on subscribe/tip/unlock/buy/join-live). See core/ledger.ts charge().
    // withdrawableCents: the earned part of balanceCents -- the most a
    // payout (POST /payouts) can take. Deposited credits never are.
    return { balanceCents: Number(a?.balanceCents ?? 0), withdrawableCents: Number(a?.withdrawableCents ?? 0), onlyOneCents: Number(a?.onlyOneCents ?? 0) };
  });

  app.get('/history', { preHandler: app.auth }, async (req: any) => {
    const rows = await prisma.ledgerEntry.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 100, skip: page(req.query).offset });
    return rows.map(r => ({ ...r, meta: fanSafeMeta(r.type, r.meta), amountCents: Number(r.amountCents) }));
  });

  /** One address per user per chain, derived deterministically. Accepts any allowlisted dollar stablecoin, ETH and $ONLYONE on that address. */
  app.post('/deposit-address', { preHandler: app.auth }, async (req) => {
    const existing = await prisma.depositAddress.findUnique({ where: { userId_chainId: { userId: req.user.id, chainId: CHAIN_ID } } });
    if (existing) return publicAddr(existing);
    // The block this address is issued at, so the deposit indexer's first run
    // starts no later than it (workers/deposit-cursor.ts). Best effort and
    // bounded: an unreachable RPC stores null (the indexer then needs
    // DEPOSIT_START_BLOCK) rather than blocking a fan from getting an address.
    const issuedBlock = await Promise.race([
      publicClient.getBlockNumber().catch(() => null),
      new Promise<null>((r) => { setTimeout(() => r(null), 3000).unref(); }),
    ]);
    return publicAddr(await prisma.$transaction(async (tx) => {
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
      const address = depositAddressAt(Number(next));
      return tx.depositAddress.create({ data: { userId: req.user.id, chainId: CHAIN_ID, address, derivationIndex: Number(next), issuedBlock } });
    }));
  });

  app.get('/deposits', { preHandler: app.auth }, async (req) => {
    const rows = await prisma.deposit.findMany({ where: { userId: req.user.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    // Both money columns are BigInt: feeCents (the 2% buy-credits fee) was
    // once left raw and 500'd this route for every fan with a deposit.
    return rows.map(r => ({ ...r, usdCents: Number(r.usdCents), feeCents: Number(r.feeCents) }));
  });

  // Each price resolves on its own and is null when its oracle isn't
  // configured or fails -- an unset CHAINLINK_ETH_USD used to 500 the whole
  // response, taking the stablecoin rate (always 1) down with it.
  app.get('/rates', async (req) => {
    const [eth, onlyOne] = await Promise.allSettled([getUsdPrice('ETH'), getUsdPrice('ONLYONE')]);
    const val = (r: PromiseSettledResult<number>, name: string) => {
      if (r.status === 'fulfilled' && Number.isFinite(r.value)) return r.value;
      if (r.status === 'rejected') req.log.warn({ err: r.reason }, `rates: ${name} price unavailable`);
      return null;
    };
    return {
      chainId: CHAIN_ID, tokens: TOKENS,
      STABLE: 1, ETH: val(eth, 'ETH'), ONLYONE: val(onlyOne, 'ONLYONE'),
      assDepositBonusBps: Number(process.env.ONLYONE_DEPOSIT_BONUS_BPS ?? 0),
    };
  });
};
