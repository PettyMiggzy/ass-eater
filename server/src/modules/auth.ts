import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import { prisma } from '../lib/prisma';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const age = (dob: Date) => Math.floor((Date.now() - dob.getTime()) / 31_557_600_000);

export const auth: FastifyPluginAsync = async (app) => {
  const issue = async (user: { id: string; role: any }) => {
    const access = app.jwt.sign({ id: user.id, role: user.role });
    const refresh = randomBytes(48).toString('base64url');
    await prisma.refreshToken.create({ data: { userId: user.id, tokenHash: sha(refresh), expiresAt: new Date(Date.now() + 30 * 864e5) } });
    return { access, refresh };
  };

  app.post('/register', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const b = z.object({
      email: z.string().email(), username: z.string().regex(/^[a-z0-9_]{3,24}$/),
      password: z.string().min(10), dob: z.coerce.date(),
      role: z.enum(['FAN', 'CREATOR']).default('FAN'), referralCode: z.string().optional(),
    }).parse(req.body);
    if (age(b.dob) < 18) return reply.code(403).send({ error: 'must_be_18' });

    const referredBy = b.referralCode ? await prisma.user.findUnique({ where: { username: b.referralCode }, select: { id: true } }) : null;
    const user = await prisma.user.create({
      data: {
        email: b.email.toLowerCase(), username: b.username, dob: b.dob, role: b.role,
        passwordHash: await argon2.hash(b.password), referredById: referredBy?.id,
        account: { create: {} },
        creator: b.role === 'CREATOR' ? { create: { displayName: b.username } } : undefined,
      },
    });
    return issue(user);
  });

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !(await argon2.verify(user.passwordHash, password))) return reply.code(401).send({ error: 'bad_credentials' });
    if (user.status === 'BANNED') return reply.code(403).send({ error: 'banned' });
    return issue(user);
  });

  app.post('/refresh', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { refresh } = z.object({ refresh: z.string() }).parse(req.body);
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha(refresh) }, include: { user: true } });
    if (!row || row.expiresAt < new Date()) return reply.code(401).send({ error: 'invalid_refresh' });
    await prisma.refreshToken.delete({ where: { id: row.id } });   // rotate
    return issue(row.user);
  });

  app.post('/logout', { preHandler: app.auth }, async (req) => {
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.id } });
    return { ok: true };
  });

  // Referral program: username doubles as the referral code (see /register).
  // Referrer earns FEES.REFERRAL_BPS of the platform's cut for FEES.REFERRAL_MONTHS
  // after a referred creator signs up -- see core/ledger.ts charge().
  app.get('/referral', { preHandler: app.auth }, async (req) => {
    const [me, referrals, earnings] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { id: req.user.id }, select: { username: true } }),
      prisma.user.count({ where: { referredById: req.user.id } }),
      prisma.ledgerEntry.aggregate({ where: { userId: req.user.id, type: 'REFERRAL' }, _sum: { amountCents: true } }),
    ]);
    return { code: me.username, referrals, earningsCents: Number(earnings._sum.amountCents ?? 0) };
  });
};
