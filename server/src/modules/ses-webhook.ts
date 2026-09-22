import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { verifySnsMessage, SnsMessage } from '../lib/sns-verify.js';

/**
 * Where SES's bounce and complaint notifications actually land.
 *
 * This is the answer to AWS's own production-access question -- "how do you
 * manage bounces, complaints, and unsubscribe requests" -- and until this
 * file existed, the honest answer was "we don't yet." Wire this in Amazon
 * SES (Configuration → your identity → Notifications → create/attach an SNS
 * topic for Bounce and Complaint, HTTPS subscription pointed at
 * POST /webhooks/ses) once the server has a public URL.
 *
 * Deliberately unauthenticated -- SNS cannot carry a bearer token -- so
 * every message is cryptographically verified instead (see sns-verify.ts).
 * That verification is the actual access control here, not obscurity.
 *
 * SNS delivers as Content-Type: text/plain, not application/json, so this
 * plugin registers its own parser for that -- scoped to this plugin only via
 * Fastify's encapsulation, so it can't change how any other route reads a
 * text/plain body.
 */
export const sesWebhook: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.post('/ses', async (req, reply) => {
    const msg = req.body as SnsMessage;

    if (!msg || typeof msg.Type !== 'string') return reply.code(400).send();

    const ok = await verifySnsMessage(msg);
    if (!ok) {
      // Logged, not thrown -- SNS retries a non-2xx, and retrying a forged
      // message changes nothing. A 200 here just means "handled", not
      // "trusted"; nothing below this line runs when ok is false.
      app.log.warn({ type: msg.Type }, 'ses-webhook: rejected message with invalid SNS signature');
      return reply.code(200).send();
    }

    if (msg.Type === 'SubscriptionConfirmation') {
      // The handshake AWS requires before a topic will actually deliver to
      // this URL. Only followed after the signature check above -- an
      // unverified SubscriptionConfirmation could otherwise be used to make
      // this server call out to an arbitrary URL of an attacker's choosing.
      if (msg.SubscribeURL) {
        try {
          await fetch(msg.SubscribeURL);
          app.log.info('ses-webhook: confirmed SNS subscription');
        } catch (err) {
          app.log.error(err, 'ses-webhook: failed to confirm SNS subscription');
        }
      }
      return reply.code(200).send();
    }

    if (msg.Type === 'Notification') {
      await handleSesEvent(app.log, msg.Message);
    }

    return reply.code(200).send();
  });
};

export async function handleSesEvent(log: { warn: (o: unknown, m: string) => void }, rawMessage: string) {
  let event: any;
  try {
    event = JSON.parse(rawMessage);
  } catch {
    return; // not a parseable SES event; nothing to record
  }

  if (event.eventType === 'Bounce' || event.notificationType === 'Bounce') {
    const bounce = event.bounce;
    // Only a PERMANENT bounce suppresses. A transient one (mailbox full,
    // greylisted, temporary DNS failure) is normal mail-server behaviour,
    // not proof the address is dead -- suppressing on the first transient
    // bounce would silently and permanently stop notifying a creator over
    // something that resolves itself by tomorrow.
    if (bounce?.bounceType !== 'Permanent') return;
    const recipients: Array<{ emailAddress: string }> = bounce?.bouncedRecipients ?? [];
    await Promise.all(
      recipients.map((r) =>
        prisma.suppression.upsert({
          where: { email: r.emailAddress.toLowerCase() },
          create: { email: r.emailAddress.toLowerCase(), reason: 'bounce', detail: bounce.bounceSubType },
          update: {},
        }),
      ),
    );
    return;
  }

  if (event.eventType === 'Complaint' || event.notificationType === 'Complaint') {
    // Any complaint suppresses immediately, no threshold. A complaint means
    // a real person marked this as spam or abuse -- there is no "first one
    // doesn't count" here, and sending again is the single fastest way to
    // make a future production-access review go worse.
    const complaint = event.complaint;
    const recipients: Array<{ emailAddress: string }> = complaint?.complainedRecipients ?? [];
    await Promise.all(
      recipients.map((r) =>
        prisma.suppression.upsert({
          where: { email: r.emailAddress.toLowerCase() },
          create: { email: r.emailAddress.toLowerCase(), reason: 'complaint', detail: complaint.complaintFeedbackType },
          update: {},
        }),
      ),
    );
    return;
  }

  // Delivery/Send/Open/Click events also arrive on this topic if configured
  // for them; nothing here needs to act on those, so they're silently
  // ignored rather than logged as unhandled noise on every successful send.
  void log;
}
