import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { encodeAbiParameters, encodeEventTopics, TransactionNotFoundError, TransactionReceiptNotFoundError } from 'viem';
import { money, post, PLATFORM_ID } from './ledger';
import { placeBid, closeAuction, dropLead, relistAuction, cancelAuction } from './auctions';
import { payoutTransferSenders } from './payouts';
import { adminResolveInFlight } from './treasury-inflight';
import { fanSafeMeta } from '../modules/wallet';
import * as chain from '../lib/chain';

// Round-14 server regression tests: the public bid history shows only the
// current run's bids (a relist or a dropped banned lead voids the rest); an
// outbid release no longer names who outbid the fan; the admin status route
// answers 404 for an unknown id and a site uid resolves to its server id;
// mark_sent accepts a payout's own transfer from its recorded (rotated-out)
// signer; an old-key in-flight burn / hedge can be closed by an admin; and
// TREASURY_SETTLE_ONLY stops every treasury signature.

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
afterEach(() => { vi.restoreAllMocks(); delete process.env.TREASURY_SETTLE_ONLY; });
beforeEach(async () => {
  await prisma.user.upsert({
    where: { id: PLATFORM_ID },
    create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
    update: {},
  });
  await prisma.account.upsert({ where: { userId: PLATFORM_ID }, create: { userId: PLATFORM_ID }, update: {} });
});

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01'), ...extra } });
  return id;
}
async function makeCreator() {
  const userId = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
  await prisma.creatorProfile.create({ data: { userId, displayName: 'C', payoutAsset: 'STABLE' } });
  return userId;
}
const fund = (u: string, c: number) => money(prisma, (tx) => post(tx, u, c, 'ADJUSTMENT'));
async function auction(creatorId: string, opts: { reserveCents?: number; endsInMs?: number } = {}) {
  return prisma.listing.create({
    data: {
      creatorId, title: 'poster', unlimited: false, kind: 'DIGITAL', saleType: 'AUCTION', priceCents: 1000,
      auctionEndsAt: new Date(Date.now() + (opts.endsInMs ?? 3_600_000)), reserveCents: opts.reserveCents,
      media: { create: { ownerId: creatorId, key: `raw/${creatorId}/${randomUUID()}`, mime: 'image/jpeg', status: 'READY' } },
    },
  });
}
async function marketplaceApp(as: () => string | null) {
  const Fastify = (await import('fastify')).default;
  const { marketplace } = await import('../modules/marketplace');
  const app = Fastify();
  const hook = async (req: any) => { req.user = { id: as(), role: 'FAN' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  app.decorateRequest('jwtVerify', async function (this: any) {
    const id = as();
    if (!id) throw new Error('no token');
    this.user = { id, role: 'FAN' };
  });
  await app.register(marketplace, { prefix: '/marketplace' });
  return app;
}
async function adminApp() {
  const Fastify = (await import('fastify')).default;
  const { admin } = await import('../modules/admin');
  const app = Fastify();
  const adminId = await makeUser({ role: 'ADMIN' });
  app.decorate('role', () => async (req: any) => { req.user = { id: adminId, role: 'ADMIN' }; });
  await app.register(admin, { prefix: '/admin' });
  return app;
}

describe('bid history shows only the current run', () => {
  it('a relisted auction starts with an empty history; the new run shows its own bids, outbid ones included', async () => {
    const creator = await makeCreator();
    const a = await makeUser(), b = await makeUser(), c = await makeUser();
    for (const u of [a, b, c]) await fund(u, 100_000);
    const l = await auction(creator, { reserveCents: 10_000, endsInMs: 60_000 });
    await money(prisma, (tx) => placeBid(tx, l.id, a, 9000));
    // Ends with the reserve not met: no sale, the lead is released.
    expect((await money(prisma, (tx) => closeAuction(tx, l.id, new Date(Date.now() + 3_600_000)))).sold).toBe(false);
    await money(prisma, (tx) => relistAuction(tx, l.id, creator, { auctionDurationHours: 24 }));

    let viewer: string | null = a;
    const app = await marketplaceApp(() => viewer);
    const bids = async () => (await app.inject({ method: 'GET', url: `/marketplace/listings/${l.id}/bids` })).json();
    expect(await bids()).toEqual([]);

    await money(prisma, (tx) => placeBid(tx, l.id, b, 1000));
    await money(prisma, (tx) => placeBid(tx, l.id, c, 2000));
    viewer = b;
    const now = await bids();
    expect(now.map((x: any) => x.amountCents)).toEqual([2000, 1000]); // the outbid bid of THIS run stays
    expect(now.map((x: any) => x.bidder)).toEqual(['Bidder 2', 'Bidder 1']); // numbered over the live run
    expect(now.find((x: any) => x.amountCents === 1000).isYou).toBe(true);
    viewer = a;
    expect((await bids()).some((x: any) => x.isYou)).toBe(false); // the released $90 bid is gone
    await app.close();
  });

  it('a dropped (banned) lead and every bid below it leave the history; a cancel voids the rest', async () => {
    const creator = await makeCreator();
    const a = await makeUser(), b = await makeUser(), c = await makeUser();
    for (const u of [a, b, c]) await fund(u, 100_000);
    const l = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1000));
    await money(prisma, (tx) => placeBid(tx, l.id, b, 5000));
    await money(prisma, (tx) => dropLead(tx, l.id, b, 'bidder_banned'));
    const app = await marketplaceApp(() => null);
    const bids = async () => (await app.inject({ method: 'GET', url: `/marketplace/listings/${l.id}/bids` })).json();
    expect(await bids()).toEqual([]);
    // The auction restarts from the starting price, and the history with it.
    await money(prisma, (tx) => placeBid(tx, l.id, c, 1000));
    expect((await bids()).map((x: any) => x.amountCents)).toEqual([1000]);
    await money(prisma, (tx) => cancelAuction(tx, l.id, 'removed_by_creator'));
    expect(await prisma.bid.count({ where: { listingId: l.id, voidedAt: null } })).toBe(0);
    await app.close();
  });

  it('a sale keeps its bids, and the winning bid is still found for the order', async () => {
    const creator = await makeCreator();
    const a = await makeUser(), b = await makeUser();
    for (const u of [a, b]) await fund(u, 100_000);
    const l = await auction(creator, { endsInMs: 60_000 });
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1000));
    await money(prisma, (tx) => placeBid(tx, l.id, b, 2000));
    const r = await money(prisma, (tx) => closeAuction(tx, l.id, new Date(Date.now() + 3_600_000)));
    expect(r.sold).toBe(true);
    expect(await prisma.bid.count({ where: { listingId: l.id, voidedAt: null } })).toBe(2);
  });
});

describe('an outbid release does not name the other bidder', () => {
  it('records {reason:"outbid"}, and wallet history strips outbidBy from older rows', async () => {
    const creator = await makeCreator();
    const a = await makeUser(), b = await makeUser();
    for (const u of [a, b]) await fund(u, 100_000);
    const l = await auction(creator);
    await money(prisma, (tx) => placeBid(tx, l.id, a, 1000));
    await money(prisma, (tx) => placeBid(tx, l.id, b, 2000));
    const rel = await prisma.ledgerEntry.findFirstOrThrow({ where: { userId: a, type: 'AUCTION_BID_RELEASE', refId: l.id } });
    expect(rel.meta).toEqual({ reason: 'outbid' });
    expect(JSON.stringify(rel.meta)).not.toContain(b);

    expect(fanSafeMeta('AUCTION_BID_RELEASE', { outbidBy: b })).toEqual({ reason: 'outbid' });
    expect(fanSafeMeta('AUCTION_BID_RELEASE', { reason: 'bidder_banned' })).toEqual({ reason: 'bidder_banned' });
    expect(fanSafeMeta('TIP', { outbidBy: 'kept-not-auction' })).toEqual({ outbidBy: 'kept-not-auction' });
    expect(fanSafeMeta('AUCTION_BID_RELEASE', null)).toBeNull();
  });
});

describe('admin user status by server id, and the site-uid lookup', () => {
  it('404s an unknown id instead of answering ok, and resolves a site uid', async () => {
    const app = await adminApp();
    const siteUid = `site-${randomUUID()}`;
    const fan = await makeUser({ siteUid, status: 'SUSPENDED', statusBySite: false });

    // The operator pastes the SITE uid: nothing matches, and it says so.
    const wrong = await app.inject({ method: 'POST', url: `/admin/users/${siteUid}/status`, payload: { status: 'ACTIVE' } });
    expect(wrong.statusCode).toBe(404);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fan } })).status).toBe('SUSPENDED');

    const look = await app.inject({ method: 'GET', url: `/admin/users/by-site-uid/${siteUid}` });
    expect(look.statusCode).toBe(200);
    expect(look.json()).toMatchObject({ id: fan, role: 'FAN', status: 'SUSPENDED', statusBySite: false });
    expect((await app.inject({ method: 'GET', url: `/admin/users/by-site-uid/nope-${randomUUID()}` })).statusCode).toBe(404);

    const ok = await app.inject({ method: 'POST', url: `/admin/users/${look.json().id}/status`, payload: { status: 'ACTIVE' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: fan } })).status).toBe('ACTIVE');
    // ACTIVE over ACTIVE is still a match, not a refusal.
    expect((await app.inject({ method: 'POST', url: `/admin/users/${fan}/status`, payload: { status: 'ACTIVE' } })).statusCode).toBe(200);
    await app.close();
  });
});

describe('mark_sent accepts a payout\'s own transfer from its recorded signer', () => {
  it('payoutTransferSenders widens only for the payout\'s own hash with a valid signer', () => {
    const t = '0x1111111111111111111111111111111111111111';
    const old = '0x2222222222222222222222222222222222222222';
    expect(payoutTransferSenders({ ownTx: true, signerAddress: old }, t)).toEqual([t, old]);
    expect(payoutTransferSenders({ ownTx: false, signerAddress: old }, t)).toEqual([t]);
    expect(payoutTransferSenders({ ownTx: true, signerAddress: null }, t)).toEqual([t]);
    expect(payoutTransferSenders({ ownTx: true, signerAddress: 'junk' }, t)).toEqual([t]);
    expect(payoutTransferSenders({ ownTx: true, signerAddress: old }, null)).toEqual([old]);
  });

  it('a HELD old-key payout whose own transfer landed can be closed; a hand-sent transfer from the old key cannot', async () => {
    const creator = await makeCreator();
    const oldKey = `0x${randomBytes(20).toString('hex')}`;
    const to = `0x${randomBytes(20).toString('hex')}`;
    const own = `0x${randomBytes(32).toString('hex')}`;
    const manual = `0x${randomBytes(32).toString('hex')}`;
    const amountRaw = 5_000_000n;
    const p = await prisma.payout.create({ data: {
      creatorId: creator, asset: 'STABLE', address: to, amountCents: 500n, feeCents: 0n, status: 'HELD',
      txHash: own, nonce: 4, signerAddress: oldKey, assetAmount: amountRaw.toString(),
    } });
    const transferLog = (from: string) => ({
      address: chain.HEDGE_STABLE.address,
      topics: encodeEventTopics({ abi: [chain.TRANSFER_EVENT], eventName: 'Transfer', args: { from: from as `0x${string}`, to: to as `0x${string}` } }),
      data: encodeAbiParameters([{ type: 'uint256' }], [amountRaw]),
    });
    // Every hash "landed" with a transfer from the OLD key.
    vi.spyOn(chain.publicClient, 'getTransactionReceipt').mockImplementation(async () => ({ status: 'success', logs: [transferLog(oldKey)] }) as any);
    const app = await adminApp();

    // A hand-sent settlement (not the payout's recorded hash) from the OLD
    // key is refused: only the payout's own transaction may come from its
    // signer. (A payout HELD before signing, with a signer on record.)
    const q = await prisma.payout.create({ data: {
      creatorId: creator, asset: 'STABLE', address: to, amountCents: 500n, feeCents: 0n, status: 'HELD',
      signerAddress: oldKey, assetAmount: amountRaw.toString(),
    } });
    const bad = await app.inject({ method: 'POST', url: `/admin/payouts/${q.id}/resolve`, payload: { action: 'mark_sent', txHash: manual } });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error).toBe('tx_does_not_pay_this_payout');

    const res = await app.inject({ method: 'POST', url: `/admin/payouts/${p.id}/resolve`, payload: { action: 'mark_sent', txHash: own } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'SENT' });
    expect((await prisma.payout.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('SENT');
    await app.close();
  });
});

describe('an admin can close an old-key in-flight burn or hedge', () => {
  const hash = () => `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  function client(o: { receipts?: Record<string, any>; known?: string[]; nonces?: Record<string, number> }) {
    return {
      getTransactionReceipt: async ({ hash: h }: { hash: string }) => {
        if (o.receipts?.[h]) return o.receipts[h];
        throw new TransactionReceiptNotFoundError({ hash: h as `0x${string}` });
      },
      getTransaction: async ({ hash: h }: { hash: string }) => {
        if (o.known?.includes(h)) return {};
        throw new TransactionNotFoundError({ hash: h as `0x${string}` });
      },
      getTransactionCount: async ({ address }: { address: string }) => o.nonces?.[address.toLowerCase()] ?? 0,
    } as any;
  }
  const oldKey = '0x9999999999999999999999999999999999999999';

  it('burn: judged by the SIGNER\'s nonce; undecided needs an explicit acknowledgement', async () => {
    const h = hash();
    const row = await prisma.tokenBurn.create({ data: { usdCents: 5000n, reason: 'test', pendingTxHash: h, pendingNonce: 7, pendingSince: new Date(), pendingSigner: oldKey } });
    // The old key's nonce has not moved past it: still undecided.
    const pending = await adminResolveInFlight('burn', h, {}, client({ nonces: { [oldKey]: 7 } }));
    expect(pending).toMatchObject({ ok: false, status: 409, error: 'still_unknown_check_explorer' });
    expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } })).pendingTxHash).toBe(h);
    // It has: the tx can never land, the obligation is owed again.
    const dropped = await adminResolveInFlight('burn', h, {}, client({ nonces: { [oldKey]: 8 } }));
    expect(dropped).toMatchObject({ ok: true, outcome: 'released', state: 'dropped', rows: 1 });
    const after = await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.pendingTxHash).toBeNull();
    expect(after.executedAt).toBeNull();
    expect((await adminResolveInFlight('burn', h, {}, client({}))).ok).toBe(false); // nothing in flight any more
  });

  it('burn with no recorded signer: only a receipt or an explicit acknowledgement closes it', async () => {
    const h = hash();
    const row = await prisma.tokenBurn.create({ data: { usdCents: 5000n, reason: 'test', pendingTxHash: h, pendingNonce: 7, pendingSince: new Date(), pendingSigner: null } });
    expect((await adminResolveInFlight('burn', h, {}, client({ nonces: {} }))).ok).toBe(false);
    const forced = await adminResolveInFlight('burn', h, { acknowledgeNeverLands: true }, client({}));
    expect(forced).toMatchObject({ ok: true, outcome: 'released', state: 'acknowledged_never_lands' });
    expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: row.id } })).pendingTxHash).toBeNull();
  });

  it('burn that landed is executed; hedge that landed is applied once, one that was dropped is FAILED', async () => {
    const hb = hash();
    const burn = await prisma.tokenBurn.create({ data: { usdCents: 5000n, reason: 'test', pendingTxHash: hb, pendingNonce: 7, pendingSince: new Date(), pendingSigner: oldKey } });
    const ok = await adminResolveInFlight('burn', hb.toUpperCase().replace('0X', '0x'), {}, client({ receipts: { [hb]: { status: 'success', logs: [] } } }));
    expect(ok).toMatchObject({ ok: true, outcome: 'executed' });
    expect((await prisma.tokenBurn.findUniqueOrThrow({ where: { id: burn.id } })).executedAt).not.toBeNull();

    await prisma.treasuryHedgeBatch.updateMany({ where: { status: 'PENDING' }, data: { status: 'FAILED' } });
    const h1 = hash(), h2 = hash();
    const b1 = await prisma.treasuryHedgeBatch.create({ data: { depositCount: 0, onlyOneRawIn: '1', usdcRawOut: '1', priceImpactBps: 0, txHash: h1, nonce: 3, status: 'PENDING', signerAddress: oldKey } });
    expect(await adminResolveInFlight('hedge', b1.id, {}, client({ receipts: { [h1]: { status: 'success', logs: [] } } }))).toMatchObject({ ok: true, outcome: 'executed' });
    expect((await prisma.treasuryHedgeBatch.findUniqueOrThrow({ where: { id: b1.id } })).status).toBe('DONE');
    expect(await adminResolveInFlight('hedge', b1.id, {}, client({}))).toMatchObject({ ok: false, error: 'not_in_flight' });
    const b2 = await prisma.treasuryHedgeBatch.create({ data: { depositCount: 0, onlyOneRawIn: '1', usdcRawOut: '1', priceImpactBps: 0, txHash: h2, nonce: 3, status: 'PENDING', signerAddress: oldKey } });
    expect(await adminResolveInFlight('hedge', b2.id, {}, client({ nonces: { [oldKey]: 9 } }))).toMatchObject({ ok: true, outcome: 'released', state: 'dropped' });
    expect((await prisma.treasuryHedgeBatch.findUniqueOrThrow({ where: { id: b2.id } })).status).toBe('FAILED');
  });

  it('the admin route refuses an unknown kind and a malformed hash', async () => {
    const app = await adminApp();
    expect((await app.inject({ method: 'POST', url: '/admin/treasury-tx/payout/x/resolve', payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/admin/treasury-tx/burn/0x12/resolve', payload: {} })).statusCode).toBe(400);
    await app.close();
  });
});

describe('TREASURY_SETTLE_ONLY', () => {
  it('refuses every treasury signature queued behind the lock, and nothing else', async () => {
    expect(chain.treasurySigningPaused()).toBeNull();
    await expect(chain.withTreasuryLock(async () => 'signed')).resolves.toBe('signed');
    process.env.TREASURY_SETTLE_ONLY = 'true';
    expect(chain.treasurySigningPaused()).toMatch(/TREASURY_SETTLE_ONLY/);
    let ran = false;
    await expect(chain.withTreasuryLock(async () => { ran = true; })).rejects.toBeInstanceOf(chain.TreasurySigningPausedError);
    expect(ran).toBe(false);
    delete process.env.TREASURY_SETTLE_ONLY;
    await expect(chain.withTreasuryLock(async () => 'again')).resolves.toBe('again');
  });
});
