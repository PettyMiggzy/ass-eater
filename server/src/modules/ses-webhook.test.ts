import { beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { handleSesEvent } from './ses-webhook';

/**
 * PERMANENT vs TRANSIENT is the one distinction that actually matters here
 * (see the comment on the Suppression model): getting it backwards either
 * stops mailing a creator forever over a full mailbox, or keeps retrying a
 * genuinely dead address until it drags the whole SES account's bounce rate
 * over the line that gets it suspended -- the exact failure mode AWS's own
 * production-access question is checking for.
 */

const prisma = new PrismaClient();
const log = { warn: () => {} };

beforeEach(async () => {
  await prisma.suppression.deleteMany();
});

function bounceEvent(bounceType: 'Permanent' | 'Transient', emails: string[]) {
  return JSON.stringify({
    eventType: 'Bounce',
    bounce: { bounceType, bounceSubType: 'General', bouncedRecipients: emails.map((emailAddress) => ({ emailAddress })) },
  });
}

function complaintEvent(emails: string[]) {
  return JSON.stringify({
    eventType: 'Complaint',
    complaint: { complaintFeedbackType: 'abuse', complainedRecipients: emails.map((emailAddress) => ({ emailAddress })) },
  });
}

describe('handleSesEvent', () => {
  it('suppresses on a permanent bounce', async () => {
    await handleSesEvent(log, bounceEvent('Permanent', ['dead@test.local']));
    const row = await prisma.suppression.findUnique({ where: { email: 'dead@test.local' } });
    expect(row?.reason).toBe('bounce');
  });

  it('does NOT suppress on a transient bounce -- a full mailbox is not a dead address', async () => {
    await handleSesEvent(log, bounceEvent('Transient', ['fullinbox@test.local']));
    const row = await prisma.suppression.findUnique({ where: { email: 'fullinbox@test.local' } });
    expect(row).toBeNull();
  });

  it('suppresses on the first complaint, no threshold', async () => {
    await handleSesEvent(log, complaintEvent(['angry@test.local']));
    const row = await prisma.suppression.findUnique({ where: { email: 'angry@test.local' } });
    expect(row?.reason).toBe('complaint');
  });

  it('is idempotent -- the same bounce delivered twice by SNS at-least-once delivery does not throw', async () => {
    await handleSesEvent(log, bounceEvent('Permanent', ['dupe@test.local']));
    await expect(handleSesEvent(log, bounceEvent('Permanent', ['dupe@test.local']))).resolves.not.toThrow();
  });

  it('lowercases the stored address so a later lookup by a lowercased "to" still matches', async () => {
    await handleSesEvent(log, bounceEvent('Permanent', ['Mixed.Case@Test.Local']));
    const row = await prisma.suppression.findUnique({ where: { email: 'mixed.case@test.local' } });
    expect(row).not.toBeNull();
  });

  it('ignores an unparseable message body rather than throwing', async () => {
    await expect(handleSesEvent(log, 'not json')).resolves.not.toThrow();
  });

  it('ignores event types it has no action for, e.g. Delivery', async () => {
    await expect(handleSesEvent(log, JSON.stringify({ eventType: 'Delivery' }))).resolves.not.toThrow();
  });
});
