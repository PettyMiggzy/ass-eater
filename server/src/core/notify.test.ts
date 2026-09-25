import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { notifyDmReceived } from './notify';
import { clearMailTransport, registerMailTransport, sendNotificationMail } from '../lib/mailer';

/**
 * What matters here is the SEPARATION, not the sending.
 *
 * This platform sits in a category most mainstream email providers refuse
 * (Resend's AUP names "Pornography/sexually explicit content" outright), so
 * the provider is the piece most likely to be absent, swapped, or pulled
 * with no notice. Everything below asserts that the notification survives
 * all three: the row is written whether or not mail works, and no message
 * content can reach a provider even when one is connected.
 */

const prisma = new PrismaClient();

async function makeUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: { id, email: `${id}@test.local`, username: `u_${id.slice(0, 8)}`, passwordHash: 'x', dob: new Date('2000-01-01') },
  });
  return id;
}

async function makeCreator(opts: { notifyOnDm?: boolean; notifyEmail?: string } = {}) {
  const userId = await makeUser();
  await prisma.user.update({ where: { id: userId }, data: { role: 'CREATOR', kycStatus: 'APPROVED' } });
  await prisma.creatorProfile.create({
    data: {
      userId,
      displayName: 'Test Creator',
      payoutAsset: 'STABLE',
      notifyOnDm: opts.notifyOnDm ?? true,
      notifyEmail: opts.notifyEmail,
    },
  });
  return userId;
}

let sent: { to: string; subject: string; text: string }[] = [];

beforeEach(() => {
  sent = [];
  registerMailTransport(async (msg) => { sent.push(msg); });
});

afterAll(async () => { await prisma.$disconnect(); });

describe('DM notifications', () => {
  it('records the notification and emails the creator', async () => {
    const creator = await makeCreator();
    const fan = await makeUser();
    const messageId = randomUUID();

    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId, siteUrl: 'https://example.test' });

    const rows = await prisma.notification.findMany({ where: { userId: creator } });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('DM_RECEIVED');
    expect(rows[0].refId).toBe(messageId);
    expect(rows[0].emailedAt).not.toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('still records the notification when NO mail provider is connected', async () => {
    // The case that actually matters: email is off, or the provider dropped
    // us. The creator must still see this in their inbox.
    clearMailTransport();

    const creator = await makeCreator();
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });

    const rows = await prisma.notification.findMany({ where: { userId: creator } });
    expect(rows).toHaveLength(1);
    // Not stamped: nothing was delivered, and pretending otherwise would
    // hide exactly what needs finding after a provider outage.
    expect(rows[0].emailedAt).toBeNull();
  });

  it('records but does not email a creator who turned notifications off', async () => {
    const creator = await makeCreator({ notifyOnDm: false });
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });

    expect(await prisma.notification.count({ where: { userId: creator } })).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('uses the forwarding address when the creator set one', async () => {
    const creator = await makeCreator({ notifyEmail: 'work@example.test' });
    const fan = await makeUser();
    await notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' });
    expect(sent[0].to).toBe('work@example.test');
  });

  it('never emails a FAN, even one messaged by a creator', async () => {
    // A fan's stored address is often deliberately not a real one -- fans
    // can sign up with a bare username precisely so nothing about this
    // platform reaches an inbox somebody else can see.
    const fan = await makeUser();
    const creator = await makeCreator();
    await notifyDmReceived({ recipientId: fan, actorId: creator, messageId: randomUUID(), siteUrl: 'https://example.test' });

    expect(await prisma.notification.count({ where: { userId: fan } })).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it('a provider that throws does not lose the notification', async () => {
    registerMailTransport(async () => { throw new Error('provider exploded'); });
    const creator = await makeCreator();
    const fan = await makeUser();

    await expect(
      notifyDmReceived({ recipientId: creator, actorId: fan, messageId: randomUUID(), siteUrl: 'https://example.test' }),
    ).resolves.not.toThrow();

    const rows = await prisma.notification.findMany({ where: { userId: creator } });
    expect(rows).toHaveLength(1);
    expect(rows[0].emailedAt).toBeNull();
  });

  it('puts NO message content in the email it sends', async () => {
    // The guarantee is structural -- sendNotificationMail has no parameter
    // that message text could be passed through -- but assert the rendered
    // body too, because that is the thing a future edit would break.
    await sendNotificationMail({ to: 'x@example.test', kind: 'DM_RECEIVED', actorName: 'somefan', siteUrl: 'https://example.test' });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('somefan');
    expect(sent[0].text).toMatch(/never include message contents/i);
    expect(sent[0].subject).toBe('You have a new message');
  });
});
