import { afterAll, describe, expect, it } from 'vitest';
import crypto, { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PLATFORM_ID } from '../core/ledger';

// lib/bridge.ts reads BRIDGE_SECRET at import time.
process.env.BRIDGE_SECRET = 'test-bridge-secret-' + randomUUID();
const { verifyBridgeToken, resolveBridgedUser, syntheticBridgeEmail } = await import('./bridge');
type Claims = NonNullable<ReturnType<typeof verifyBridgeToken>>;

const prisma = new PrismaClient();
afterAll(() => prisma.$disconnect());

function mint(payload: Record<string, unknown>) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.BRIDGE_SECRET!).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}
function claims(over: Partial<Claims> = {}): Claims {
  const uid = over.uid ?? randomUUID();
  return {
    typ: 'bridge', uid, email: `${uid}@site.test`, username: `u_${uid.replace(/-/g, '').slice(0, 12)}`,
    role: 'FAN', creatorStatus: null, jti: randomUUID(), exp: Date.now() + 60_000, ...over,
  };
}

describe('verifyBridgeToken', () => {
  it('accepts a well-formed token and requires a jti', () => {
    const c = claims();
    expect(verifyBridgeToken(mint(c))?.uid).toBe(c.uid);
    const { jti, ...noJti } = c;
    void jti;
    expect(verifyBridgeToken(mint(noJti))).toBeNull();
  });
  it('rejects an unknown creatorStatus and defaults a missing one to null', () => {
    expect(verifyBridgeToken(mint(claims({ creatorStatus: 'root' as any })))).toBeNull();
    const { creatorStatus, ...legacy } = claims();
    void creatorStatus;
    expect(verifyBridgeToken(mint(legacy))?.creatorStatus).toBeNull();
  });
  it('fails closed on a CREATOR with no creatorStatus, and on a FAN carrying one', () => {
    expect(verifyBridgeToken(mint(claims({ role: 'CREATOR', creatorStatus: null })))).toBeNull();
    const { creatorStatus, ...noStatus } = claims({ role: 'CREATOR' });
    void creatorStatus;
    expect(verifyBridgeToken(mint(noStatus))).toBeNull();
    expect(verifyBridgeToken(mint(claims({ role: 'FAN', creatorStatus: 'active' })))).toBeNull();
    expect(verifyBridgeToken(mint(claims({ role: 'CREATOR', creatorStatus: 'active' })))?.creatorStatus).toBe('active');
  });
  it('rejects a bad signature and an expired token', () => {
    const t = mint(claims());
    expect(verifyBridgeToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(verifyBridgeToken(mint(claims({ exp: Date.now() - 1 })))).toBeNull();
  });
});

describe('resolveBridgedUser -- joined on the site uid, never on email', () => {
  it('does NOT adopt a pre-registered native account holding the same email (pre-hijack)', async () => {
    const email = `victim-${randomUUID()}@example.com`;
    const attacker = await prisma.user.create({
      data: { email, username: `att_${randomUUID().slice(0, 8)}`, passwordHash: 'attacker-known', dob: new Date('1990-01-01') },
    });
    const r = await resolveBridgedUser(claims({ email }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.id).not.toBe(attacker.id);
    expect(r.user.email).not.toBe(email);                      // clash -> namespaced address
    expect(r.user.email).toBe(syntheticBridgeEmail(r.user.siteUid!));
  });

  it("a site fan named 'treasury@internal' is never bridged into the platform account", async () => {
    await prisma.user.upsert({
      where: { id: PLATFORM_ID },
      create: { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__', passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
      update: {},
    });
    const platform = await prisma.user.findUniqueOrThrow({ where: { id: PLATFORM_ID } });
    const r = await resolveBridgedUser(claims({ email: platform.email }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.user.id).not.toBe(PLATFORM_ID);
    expect(r.user.role).toBe('FAN');
  });

  it('returns the same row for the same site uid, and a new row for a different uid with the same email', async () => {
    const c = claims({ email: `shared-${randomUUID()}@example.com` });
    const a = await resolveBridgedUser(c);
    const b = await resolveBridgedUser({ ...c, jti: randomUUID() });
    const other = await resolveBridgedUser(claims({ email: c.email }));
    expect(a.ok && b.ok && other.ok).toBe(true);
    if (!a.ok || !b.ok || !other.ok) return;
    expect(b.user.id).toBe(a.user.id);
    expect(a.user.email).toBe(c.email);                        // free address kept as an attribute
    expect(other.user.id).not.toBe(a.user.id);
  });

  it('stores a non-email site identifier as a namespaced address, not verbatim', async () => {
    const r = await resolveBridgedUser(claims({ email: 'just_a_username' }));
    expect(r.ok && r.user.email.endsWith('@bridge.invalid')).toBe(true);
  });

  it('upgrades FAN -> CREATOR with a profile, and never downgrades', async () => {
    const c = claims();
    const fan = await resolveBridgedUser(c);
    const creator = await resolveBridgedUser({ ...c, role: 'CREATOR', creatorStatus: 'pending' });
    expect(fan.ok && creator.ok).toBe(true);
    if (!creator.ok) return;
    expect(creator.user.role).toBe('CREATOR');
    expect(await prisma.creatorProfile.findUnique({ where: { userId: creator.user.id } })).not.toBeNull();
    const again = await resolveBridgedUser({ ...c, role: 'FAN' });
    expect(again.ok && again.user.role).toBe('CREATOR');
  });

  it('refuses a CREATOR claim with no status even if handed in directly', async () => {
    expect(await resolveBridgedUser(claims({ role: 'CREATOR', creatorStatus: null }))).toMatchObject({ ok: false, status: 403, error: 'banned' });
  });

  it('refuses a banned or suspended site creator', async () => {
    expect(await resolveBridgedUser(claims({ role: 'CREATOR', creatorStatus: 'banned' }))).toMatchObject({ ok: false, status: 403, error: 'banned' });
    expect(await resolveBridgedUser(claims({ role: 'CREATOR', creatorStatus: 'suspended' }))).toMatchObject({ ok: false, status: 403, error: 'suspended' });
  });

  it('refuses an ADMIN row even when it carries the site uid, and a non-active row', async () => {
    const c = claims();
    const r = await resolveBridgedUser(c);
    if (!r.ok) throw new Error('setup');
    await prisma.user.update({ where: { id: r.user.id }, data: { role: 'ADMIN' } });
    expect(await resolveBridgedUser(c)).toMatchObject({ ok: false, error: 'forbidden' });
    await prisma.user.update({ where: { id: r.user.id }, data: { role: 'FAN', status: 'SUSPENDED' } });
    expect(await resolveBridgedUser(c)).toMatchObject({ ok: false, error: 'account_suspended' });
  });

  it('concurrent first exchanges for one site user create exactly one row', async () => {
    const c = claims();
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveBridgedUser({ ...c, jti: randomUUID() })));
    const ids = new Set(results.map((r) => (r.ok ? r.user.id : 'fail')));
    expect(ids.size).toBe(1);
    expect(ids.has('fail')).toBe(false);
    expect(await prisma.user.count({ where: { siteUid: c.uid } })).toBe(1);
  });
});
