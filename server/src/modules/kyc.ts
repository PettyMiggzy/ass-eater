import { FastifyPluginAsync } from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { prisma } from '../lib/prisma.js';
import { applyKycEvent } from '../core/kyc-events.js';

const SS = { base: process.env.SUMSUB_BASE_URL!, token: process.env.SUMSUB_APP_TOKEN!, secret: process.env.SUMSUB_SECRET_KEY!, level: process.env.SUMSUB_LEVEL ?? 'creator-kyc', webhook: process.env.SUMSUB_WEBHOOK_SECRET! };

async function sumsub(method: 'GET' | 'POST', path: string, body?: object) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = body ? JSON.stringify(body) : '';
  const sig = createHmac('sha256', SS.secret).update(ts + method + path + payload).digest('hex');
  const res = await fetch(SS.base + path, { method, body: payload || undefined, headers: { 'Content-Type': 'application/json', 'X-App-Token': SS.token, 'X-App-Access-Sig': sig, 'X-App-Access-Ts': ts } });
  if (!res.ok) throw new SumsubError(res.status, await res.text().catch(() => ''));
  return res.json() as Promise<any>;
}

/**
 * A failed Sumsub call. It answers the client 502 with a fixed message (the
 * global handler exposes `.message` for 4xx only, so give this a message that
 * is safe either way); Sumsub's own response body stays in `.detail` for the
 * server log and never reaches the client. `upstreamStatus` is what callers
 * branch on (e.g. 409 on an applicant that already exists).
 */
export class SumsubError extends Error {
  readonly statusCode = 502;
  constructor(readonly upstreamStatus: number, readonly detail: string) {
    super('kyc_provider_unavailable');
  }
}

/**
 * The Sumsub applicant for platform user `userId`, creating it if needed.
 *
 * Sumsub refuses a second applicant with the same externalUserId (409). The
 * applicant id is saved in a separate write after the create, so a crash, a
 * dropped DB connection or a double tap between the two left kycRef null for
 * an applicant that exists -- and every later /kyc/session retried the
 * create, got 409, and failed forever. On 409 the existing applicant is
 * looked up by externalUserId and adopted instead.
 */
export async function ensureApplicant(
  userId: string, email: string | null,
  call: typeof sumsub = sumsub,
): Promise<string> {
  try {
    const a = await call('POST', `/resources/applicants?levelName=${encodeURIComponent(SS.level)}`, { externalUserId: userId, email });
    return String(a.id);
  } catch (e) {
    if (!(e instanceof SumsubError) || e.upstreamStatus !== 409) throw e;
    const existing = await call('GET', `/resources/applicants/-;externalUserId=${encodeURIComponent(userId)}/one`);
    if (!existing?.id) throw e;
    return String(existing.id);
  }
}

export const kyc: FastifyPluginAsync = async (app) => {
  /** Returns a WebSDK access token; front end mounts Sumsub SDK with it. */
  app.post('/session', { preHandler: app.role('CREATOR') }, async (req) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    if (u.kycStatus === 'APPROVED') return { status: 'APPROVED' };
    if (!u.kycRef) {
      const applicantId = await ensureApplicant(u.id, u.email);
      // Only fill a still-empty kycRef: a concurrent request (or the webhook)
      // may have saved it in the meantime, and it names the same applicant.
      await prisma.user.updateMany({ where: { id: u.id, kycRef: null }, data: { kycRef: applicantId, kycStatus: 'PENDING' } });
    }
    const t = await sumsub('POST', `/resources/accessTokens?userId=${encodeURIComponent(u.id)}&levelName=${encodeURIComponent(SS.level)}&ttlInSecs=1200`);
    return { status: 'PENDING', token: t.token };
  });

  app.get('/status', { preHandler: app.auth }, async (req) =>
    prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { kycStatus: true } }));

  // Webhook — raw body required for HMAC verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_r, body, done) => done(null, body));
  app.post('/webhook', async (req: any, reply) => {
    const raw: Buffer = req.body;
    const expected = createHmac('sha256', SS.webhook).update(raw).digest();
    // Constant-time: a plain !== on the hex string bails at the first differing
    // character, and that timing difference is enough to walk a forged digest
    // out one byte at a time. Anything that isn't valid hex decodes short, so a
    // junk (or repeated, hence array-valued) header fails the length check.
    const sent = Buffer.from(String(req.headers['x-payload-digest'] ?? ''), 'hex');
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) return reply.code(401).send();

    const evt = JSON.parse(raw.toString());
    // Prisma reads an undefined filter as "no filter": an event that arrived
    // without an externalUserId would make the update unscoped and rewrite
    // kycStatus for every user on the platform. Event types we don't act on
    // are still acked, so Sumsub doesn't retry them forever.
    const acted = evt.type === 'applicantReviewed' || evt.type === 'applicantWorkflowCompleted' || evt.type === 'applicantReset';
    if (acted && typeof evt.externalUserId !== 'string') return reply.code(400).send({ error: 'missing_external_user_id' });
    // Ordered by the event's own time and scoped to the stored applicant
    // (core/kyc-events.ts): a delayed or retried older event is acked (200)
    // but changes nothing, so it can't undo a newer review or an admin
    // override.
    if (acted) {
      const r = await applyKycEvent(evt, req.log);
      if (r === 'stale') req.log.info({ type: evt.type }, 'kyc webhook: stale or foreign-applicant event ignored');
    }
    return { ok: true };
  });
};
