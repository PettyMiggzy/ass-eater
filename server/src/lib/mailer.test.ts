import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { clearMailTransport, registerMailTransport, sendNotificationMail } from './mailer';

/**
 * The suppression check is the actual answer to AWS's own production-access
 * question ("how do you manage bounces and complaints") -- so what matters
 * here is that a suppressed address gets NO further send attempt at all,
 * not just a failed one. A caller that retries a bounced address anyway is
 * exactly what pushes an SES account's bounce rate over the line that gets
 * it suspended.
 */

const prisma = new PrismaClient();

beforeEach(async () => {
  await prisma.suppression.deleteMany();
});

afterEach(() => {
  clearMailTransport();
});

describe('sendNotificationMail suppression', () => {
  it('sends normally to an address with no suppression record', async () => {
    let sent = false;
    registerMailTransport(async () => {
      sent = true;
    });
    const result = await sendNotificationMail({ to: 'creator@test.local', kind: 'DM_RECEIVED', siteUrl: 'https://x' });
    expect(result.sent).toBe(true);
    expect(sent).toBe(true);
  });

  it('never calls the transport for a permanently bounced address', async () => {
    await prisma.suppression.create({ data: { email: 'dead@test.local', reason: 'bounce', detail: 'Permanent' } });
    let called = false;
    registerMailTransport(async () => {
      called = true;
    });
    const result = await sendNotificationMail({ to: 'dead@test.local', kind: 'DM_RECEIVED', siteUrl: 'https://x' });
    expect(result).toEqual({ sent: false, reason: 'suppressed', detail: 'bounce' });
    expect(called).toBe(false);
  });

  it('never calls the transport for an address that complained', async () => {
    await prisma.suppression.create({ data: { email: 'angry@test.local', reason: 'complaint', detail: 'abuse' } });
    let called = false;
    registerMailTransport(async () => {
      called = true;
    });
    const result = await sendNotificationMail({ to: 'angry@test.local', kind: 'DM_RECEIVED', siteUrl: 'https://x' });
    expect(result).toEqual({ sent: false, reason: 'suppressed', detail: 'complaint' });
    expect(called).toBe(false);
  });

  it('matches a suppression case-insensitively, since email addresses are not case-sensitive in practice', async () => {
    await prisma.suppression.create({ data: { email: 'mixed@test.local', reason: 'bounce' } });
    let called = false;
    registerMailTransport(async () => {
      called = true;
    });
    const result = await sendNotificationMail({ to: 'Mixed@Test.Local', kind: 'DM_RECEIVED', siteUrl: 'https://x' });
    expect(result.sent).toBe(false);
    expect(called).toBe(false);
  });
});
