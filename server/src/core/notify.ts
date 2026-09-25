import { prisma } from '../lib/prisma.js';
import { sendNotificationMail } from '../lib/mailer.js';

/**
 * Record that a creator should know about something, then try to email them.
 *
 * The ORDER is the design. The Notification row is written first and is the
 * source of truth; the email is a best-effort delivery on top of it that
 * may be off, may fail, or may be going through a provider that terminates
 * the account tomorrow. Recording first means the in-app inbox works with
 * no provider at all and nothing is lost while email is off.
 */
// One notification email per creator per window: a burst of DMs is one
// "you have new messages" nudge, not a mail per message.
export const NOTIFY_MAIL_COOLDOWN_MS = 15 * 60_000;

export async function notifyDmReceived(opts: {
  recipientId: string;
  actorId: string;
  messageId: string;
  siteUrl: string;
}) {
  const [recipient, actor] = await Promise.all([
    prisma.user.findUnique({
      where: { id: opts.recipientId },
      select: { creator: { select: { notifyEmail: true, notifyEmailVerifiedAt: true, notifyOnDm: true, displayName: true } } },
    }),
    prisma.user.findUnique({ where: { id: opts.actorId }, select: { username: true } }),
  ]);
  if (!recipient) return;

  const notification = await prisma.notification.create({
    data: { userId: opts.recipientId, kind: 'DM_RECEIVED', actorId: opts.actorId, refId: opts.messageId },
  });

  // Only creators get mailed, and only if they have not turned it off.
  // A fan's stored address is frequently not a real one by design -- fans
  // may sign up with a bare username specifically so nothing about this
  // platform reaches an inbox someone else can see. Mailing that field
  // would be both useless and, if it happened to be a real shared address,
  // exactly the harm the anonymous-signup option exists to prevent.
  const creator = recipient.creator;
  if (!creator || !creator.notifyOnDm) return;

  // Only a CONFIRMED notification address (modules/notifications.ts
  // double opt-in). Never the account email: neither stack verifies that
  // anyone owns it, and a bridged row's may be a *.invalid placeholder --
  // mailing an address a creator merely typed let them point adult-platform
  // mail at a third party, and every complaint counts against the SES
  // account.
  const to = creator.notifyEmailVerifiedAt && creator.notifyEmail ? creator.notifyEmail : null;
  if (!to || /\.invalid$/i.test(to)) return;

  // Per-recipient rate limit: at most one "you have a new message" email per
  // NOTIFY_MAIL_COOLDOWN_MS, claimed with a guarded UPDATE so concurrent DMs
  // can't each send one. The in-app rows carry every message either way.
  const since = new Date(Date.now() - NOTIFY_MAIL_COOLDOWN_MS);
  const claimed = await prisma.creatorProfile.updateMany({
    where: { userId: opts.recipientId, OR: [{ notifyMailedAt: null }, { notifyMailedAt: { lt: since } }] },
    data: { notifyMailedAt: new Date() },
  });
  if (!claimed.count) return;

  const result = await sendNotificationMail({
    to,
    kind: 'DM_RECEIVED',
    actorName: actor?.username,
    siteUrl: opts.siteUrl,
  });

  // Stamped only on a real success, never optimistically on an attempt --
  // otherwise a provider outage leaves rows that look delivered forever and
  // there is no way to find what was missed.
  if (result.sent) {
    await prisma.notification.update({ where: { id: notification.id }, data: { emailedAt: new Date() } });
  }
}
