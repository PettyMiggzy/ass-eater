import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { serializeReply } from '../lib/json-reply';
import * as chain from '../lib/chain';
import { assertSweepsUnpaused, SweepGasDeferred } from '../workers/sweep-gas';

// Round-15 server regression tests: BigInt money columns never 500 a reply
// (one global serializer plus the two routes that returned them raw), the
// admin KYC override never returns a password hash, and TREASURY_SETTLE_ONLY
// is parsed leniently, fails closed on nonsense and pauses deposit sweeps.

const prisma = new PrismaClient();
afterAll(async () => { await prisma.$disconnect(); });
afterEach(() => { delete process.env.TREASURY_SETTLE_ONLY; });

async function makeUser(extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  await prisma.user.create({ data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: '$argon2id$secret', dob: new Date('2000-01-01'), ...extra } });
  return id;
}

/** A bare Fastify app with `as` as the authenticated user; `globalSerializer` mirrors index.ts. */
async function appWith(plugin: any, prefix: string, as: string, globalSerializer: boolean) {
  const Fastify = (await import('fastify')).default;
  const app = Fastify();
  if (globalSerializer) app.setReplySerializer(serializeReply);
  const hook = async (req: any) => { req.user = { id: as, role: 'CREATOR' }; };
  app.decorate('auth', hook);
  app.decorate('creatorOk', hook);
  app.decorate('role', () => hook);
  await app.register(plugin, { prefix });
  return app;
}

describe('BigInt-safe replies', () => {
  it('the global serializer turns a safe BigInt into a number and a huge one into a string', async () => {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.setReplySerializer(serializeReply);
    app.get('/x', async () => ({ cents: 450n, huge: 2n ** 60n, nested: [{ v: -3n }] }));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ cents: 450, huge: (2n ** 60n).toString(), nested: [{ v: -3 }] });
    await app.close();
  });

  it('without it, a raw BigInt is a 500 (the failure the serializer exists for)', async () => {
    const Fastify = (await import('fastify')).default;
    const app = Fastify();
    app.get('/x', async () => ({ cents: 1n }));
    expect((await app.inject({ method: 'GET', url: '/x' })).statusCode).toBe(500);
    await app.close();
  });

  it('GET /wallet/deposits answers 200 for a fan with a deposit (feeCents is BigInt)', async () => {
    const { wallet } = await import('../modules/wallet');
    const fan = await makeUser();
    await prisma.deposit.create({ data: { userId: fan, chainId: 4663, txHash: `0x${randomUUID().replace(/-/g, '')}`, logIndex: 0, asset: 'STABLE', stableSymbol: 'USDG', rawAmount: '10000000', usdCents: 1000n, feeCents: 20n, priceUsed: 1 } });
    for (const g of [false, true]) {   // the route itself maps; the global serializer is a second net
      const app = await appWith(wallet, '/wallet', fan, g);
      const res = await app.inject({ method: 'GET', url: '/wallet/deposits' });
      expect(res.statusCode).toBe(200);
      expect(res.json()[0]).toMatchObject({ usdCents: 1000, feeCents: 20 });
      await app.close();
    }
  });

  it('GET /tips/received answers 200 for a creator who has been tipped', async () => {
    const { tips } = await import('../modules/tips');
    const creator = await makeUser({ role: 'CREATOR', kycStatus: 'APPROVED' });
    await prisma.ledgerEntry.create({ data: { userId: creator, amountCents: 450n, type: 'TIP' } });
    await prisma.ledgerEntry.create({ data: { userId: creator, amountCents: 800n, type: 'LIVE_TIP' } });
    for (const g of [false, true]) {
      const app = await appWith(tips, '/tips', creator, g);
      const res = await app.inject({ method: 'GET', url: '/tips/received' });
      expect(res.statusCode).toBe(200);
      expect(res.json().map((r: any) => r.amountCents).sort()).toEqual([450, 800]);
      await app.close();
    }
  });
});

describe('POST /admin/users/:id/kyc', () => {
  it('returns only safe fields -- never the password hash or email -- and 404s an unknown id', async () => {
    const { admin } = await import('../modules/admin');
    const adminId = await makeUser({ role: 'ADMIN' });
    const target = await makeUser({ role: 'ADMIN' });
    const app = await appWith(admin, '/admin', adminId, true);
    const res = await app.inject({ method: 'POST', url: `/admin/users/${target}/kyc`, payload: { status: 'APPROVED' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ id: target, username: expect.any(String), role: 'ADMIN', status: 'ACTIVE', kycStatus: 'APPROVED' });
    expect(res.body).not.toContain('argon2');
    expect(res.body).not.toContain('@test.local');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target } })).kycStatus).toBe('APPROVED');
    expect((await app.inject({ method: 'POST', url: `/admin/users/${randomUUID()}/kyc`, payload: { status: 'APPROVED' } })).statusCode).toBe(404);
    await app.close();
  });
});

describe('TREASURY_SETTLE_ONLY', () => {
  it('accepts true/1/yes case-insensitively, tolerates an inline comment or quotes, and calls nonsense invalid', () => {
    for (const v of ['true', 'TRUE', ' True ', '1', 'yes', 'YES', 'true # key rotation 2026-10', '"true"']) {
      expect(chain.settleOnlyMode(v), v).toBe('on');
    }
    for (const v of [undefined, '', 'false', 'FALSE', '0', 'no', 'false # done']) {
      expect(chain.settleOnlyMode(v), String(v)).toBe('off');
    }
    for (const v of ['ture', 'on', 'enabled', '2']) expect(chain.settleOnlyMode(v), v).toBe('invalid');
  });

  it('an unrecognised value fails closed: treasury signing counts as paused', async () => {
    process.env.TREASURY_SETTLE_ONLY = 'ture';
    expect(chain.treasurySigningPaused()).toMatch(/unrecognised/);
    await expect(chain.withTreasuryLock(async () => 'signed')).rejects.toBeInstanceOf(chain.TreasurySigningPausedError);
    process.env.TREASURY_SETTLE_ONLY = 'TRUE # rotation';
    expect(chain.treasurySigningPaused()).toMatch(/TREASURY_SETTLE_ONLY/);
    process.env.TREASURY_SETTLE_ONLY = 'false';
    expect(chain.treasurySigningPaused()).toBeNull();
  });

  it('pauses every deposit sweep, not just the gas top-up', () => {
    expect(() => assertSweepsUnpaused()).not.toThrow();
    process.env.TREASURY_SETTLE_ONLY = '1';
    expect(() => assertSweepsUnpaused()).toThrow(SweepGasDeferred);
  });

  it('warnLegacyEnv flags an inline comment in TREASURY_SETTLE_ONLY', () => {
    process.env.TREASURY_SETTLE_ONLY = 'true # rotation';
    const msgs: string[] = [];
    chain.warnLegacyEnv((m) => msgs.push(m));
    expect(msgs.join('\n')).toMatch(/TREASURY_SETTLE_ONLY/);
  });
});
