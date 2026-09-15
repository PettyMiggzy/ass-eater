import { FastifyPluginAsync } from 'fastify';
import { createHmac } from 'crypto';
import { prisma } from '../lib/prisma';

const SS = { base: process.env.SUMSUB_BASE_URL!, token: process.env.SUMSUB_APP_TOKEN!, secret: process.env.SUMSUB_SECRET_KEY!, level: process.env.SUMSUB_LEVEL ?? 'creator-kyc', webhook: process.env.SUMSUB_WEBHOOK_SECRET! };

async function sumsub(method: 'GET' | 'POST', path: string, body?: object) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const payload = body ? JSON.stringify(body) : '';
  const sig = createHmac('sha256', SS.secret).update(ts + method + path + payload).digest('hex');
  const res = await fetch(SS.base + path, { method, body: payload || undefined, headers: { 'Content-Type': 'application/json', 'X-App-Token': SS.token, 'X-App-Access-Sig': sig, 'X-App-Access-Ts': ts } });
  if (!res.ok) throw new Error(`sumsub_${res.status}: ${await res.text()}`);
  return res.json() as Promise<any>;
}

export const kyc: FastifyPluginAsync = async (app) => {
  /** Returns a WebSDK access token; front end mounts Sumsub SDK with it. */
  app.post('/session', { preHandler: app.role('CREATOR') }, async (req) => {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
    if (u.kycStatus === 'APPROVED') return { status: 'APPROVED' };
    if (!u.kycRef) {
      const a = await sumsub('POST', `/resources/applicants?levelName=${encodeURIComponent(SS.level)}`, { externalUserId: u.id, email: u.email });
      await prisma.user.update({ where: { id: u.id }, data: { kycRef: a.id, kycStatus: 'PENDING' } });
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
    const expected = createHmac('sha256', SS.webhook).update(raw).digest('hex');
    if (req.headers['x-payload-digest'] !== expected) return reply.code(401).send();
    const evt = JSON.parse(raw.toString());
    if (evt.type === 'applicantReviewed' || evt.type === 'applicantWorkflowCompleted') {
      const ok = evt.reviewResult?.reviewAnswer === 'GREEN';
      await prisma.user.updateMany({ where: { id: evt.externalUserId }, data: { kycStatus: ok ? 'APPROVED' : 'REJECTED', kycRef: evt.applicantId } });
    }
    if (evt.type === 'applicantReset') await prisma.user.updateMany({ where: { id: evt.externalUserId }, data: { kycStatus: 'PENDING' } });
    return { ok: true };
  });
};
