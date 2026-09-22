import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { registerMailTransport } from './mailer.js';

/**
 * Amazon SES transport.
 *
 * WHY SES AND NOT THE OBVIOUS ONES: read directly, 2026-09-20, Resend's
 * Acceptable Use Policy names "Pornography/sexually explicit content" and
 * "Escort services" in its prohibited list. AWS's Acceptable Use Policy
 * prohibits illegal activity, violating others' rights, violence and
 * terrorism, child sexual exploitation, security violations and spam -- and
 * does NOT name adult content anywhere. That is a real difference in the
 * published policies rather than an assumption about how each is enforced.
 *
 * HONEST CAVEAT, do not let this get lost: leaving SES's sandbox requires a
 * human use-case review that AWS can decline, and an account can be
 * suspended later. That is exactly why this file is a swappable transport
 * behind mailer.ts rather than an SDK call sprinkled through the codebase --
 * replacing it should be writing one function, not an audit.
 */

export function configureSes(log: { info: (o: unknown, m: string) => void }) {
  if (process.env.EMAIL_PROVIDER !== 'ses') return false;

  const from = process.env.EMAIL_FROM;
  if (!from) {
    // Fail loudly at startup rather than quietly at every send. A provider
    // that is switched on but misconfigured would otherwise look identical
    // to one that is switched off, and the difference only surfaces as
    // creators not hearing about messages -- the failure nobody reports
    // because it looks like nothing happened.
    throw new Error('EMAIL_PROVIDER=ses requires EMAIL_FROM (a verified SES identity, e.g. "OnlyOne <team@onlyone1.fun>")');
  }

  // Credentials come from the standard AWS chain -- env vars, or an IAM role
  // if this ever runs on AWS. Deliberately not read or logged here: this
  // file should never be the place a key ends up in a stack trace.
  const client = new SESv2Client({ region: process.env.AWS_REGION || 'us-east-1' });

  registerMailTransport(async ({ to, subject, text }) => {
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        // Text only, deliberately. An HTML notification buys nothing here
        // (the body is one sentence and a link by design -- see mailer.ts on
        // why no content travels) and plain text avoids the whole class of
        // rendering and tracking-pixel problems on a platform where a
        // recipient's privacy is part of the product.
        Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: text } } } },
      }),
    );
  });

  log.info({ region: process.env.AWS_REGION || 'us-east-1' }, 'email: SES transport registered');
  return true;
}
