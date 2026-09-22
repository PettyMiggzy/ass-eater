/**
 * Transactional email, provider-agnostic on purpose.
 *
 * WHY THIS IS AN INTERFACE AND NOT JUST AN SDK CALL
 *
 * This platform is in a category most mainstream email providers refuse to
 * serve. Resend's Acceptable Use Policy names "Pornography/sexually explicit
 * content" and "Escort services" in its prohibited list, which is the same
 * answer Stripe, Transak and Circle Mint gave on payments. So the provider
 * here is the component most likely to be missing today, swapped tomorrow,
 * or to terminate the account with no notice. Everything above this file is
 * written so that none of those events touch it.
 *
 * TWO RULES THAT ARE NOT NEGOTIABLE
 *
 * 1. NO MESSAGE CONTENT EVER LEAVES HERE BY EMAIL. A notification says
 *    "someone messaged you" and nothing more. Two independent reasons, and
 *    either alone is sufficient: the message may be one the fan PAID to
 *    send and the creator has not opened, so mailing the text hands it over
 *    outside the product; and piping adult-platform message bodies through
 *    a third party's content scanners is the fastest way to get an account
 *    terminated by the provider whose policy already disallows the
 *    category. Subject and body are generic by construction below -- there
 *    is no parameter to pass content through.
 *
 * 2. A FAILED SEND IS NEVER AN ERROR THE CALLER HAS TO HANDLE. This returns
 *    a result, never throws. A message that was delivered in-app must not
 *    be rolled back because a mail API was down, and a creator must not see
 *    a 500 because of it.
 *
 * PROVIDER CHOICE, when one is wired: Amazon SES. Its Acceptable Use Policy
 * (read directly, 2026-09-20) prohibits illegal activity, violence,
 * child sexual exploitation, security violations and spam -- and does NOT
 * name adult content anywhere. That is a real difference from Resend rather
 * than an assumption. Caveat worth keeping: leaving SES's sandbox requires
 * a human use-case review that can still be declined, so even the chosen
 * provider is not a guarantee, which is the whole reason for this seam.
 */

import { prisma } from './prisma.js';

export type MailResult =
  | { sent: true; provider: string }
  | { sent: false; reason: 'not_configured' | 'no_address' | 'suppressed' | 'provider_error'; detail?: string };

export function mailProvider(): string {
  return process.env.EMAIL_PROVIDER || '';
}

/**
 * The only shape a notification email can take.
 *
 * Callers pass WHO and WHAT KIND, never any content -- see rule 1 above.
 * Making that a type-level fact rather than a code-review convention is the
 * point: there is no field here that message text could be put into.
 */
export type NotificationMail = {
  to: string;
  kind: 'DM_RECEIVED';
  actorName?: string;
  siteUrl: string;
};

function render(mail: NotificationMail): { subject: string; text: string } {
  const who = mail.actorName ? `${mail.actorName}` : 'Someone';
  switch (mail.kind) {
    case 'DM_RECEIVED':
      return {
        subject: 'You have a new message',
        text:
          `${who} sent you a message on OnlyOne.\n\n` +
          `Open your inbox to read and reply: ${mail.siteUrl}/dashboard\n\n` +
          `We never include message contents in email.\n` +
          `Turn these off any time in your dashboard settings.`,
      };
  }
}

/**
 * The transport seam.
 *
 * Deliberately EMPTY until a provider is actually chosen. No SDK is
 * imported and no dependency is added on a guess -- SES is the
 * recommendation above, not a decision that has been made, and adding a
 * large AWS client to the server for a feature that is off would be
 * choosing on the founder's behalf.
 *
 * To wire one up: install its SDK, write a function of this shape, and call
 * registerMailTransport() once at startup (src/index.ts). Nothing else in
 * the codebase changes, which is the entire point of this file.
 */
export type MailTransport = (msg: { to: string; subject: string; text: string }) => Promise<void>;

let transport: MailTransport | null = null;

export function registerMailTransport(t: MailTransport) {
  transport = t;
}

/** Disconnect the transport. Exists so tests can assert the "no provider"
 *  path, which is the one most likely to be real in production. */
export function clearMailTransport() {
  transport = null;
}

export function mailConfigured(): boolean {
  return transport !== null;
}

export async function sendNotificationMail(mail: NotificationMail): Promise<MailResult> {
  if (!mail.to) return { sent: false, reason: 'no_address' };

  // Checked before the transport, not after a failed send -- an address
  // that bounced or complained gets no further attempts at all, which is
  // what keeps this account's bounce/complaint RATE (what SES actually
  // measures) from climbing every time a caller tries the same dead
  // address again. lib/prisma is imported here, not deferred, because this
  // check has to run before every send regardless of which caller forgot
  // to check it themselves -- see the no-content rule above for the same
  // reasoning applied to a different guarantee.
  const suppressed = await prisma.suppression.findUnique({ where: { email: mail.to.toLowerCase() } });
  if (suppressed) return { sent: false, reason: 'suppressed', detail: suppressed.reason };

  if (!transport) {
    // Deliberately not an error and deliberately not silent. The same
    // honest-stub pattern used for AgeChecker and token-gating before their
    // credentials existed: the feature reports that it is off rather than
    // pretending to work or crashing the path it sits on. The Notification
    // row is already written by the caller, so nothing is lost -- turning a
    // provider on later needs no backfill.
    return { sent: false, reason: 'not_configured' };
  }

  const { subject, text } = render(mail);

  try {
    await transport({ to: mail.to, subject, text });
    return { sent: true, provider: mailProvider() || 'custom' };
  } catch (e) {
    // Never rethrown. A message that was delivered in-app must not be rolled
    // back because a mail API was down.
    return { sent: false, reason: 'provider_error', detail: (e as Error).message };
  }
}
