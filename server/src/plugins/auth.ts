import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

declare module '@fastify/jwt' { interface FastifyJWT { user: { id: string; role: Role } } }
declare module 'fastify' {
  interface FastifyInstance {
    auth: (req: any, reply: any) => Promise<void>;
    role: (...roles: Role[]) => (req: any, reply: any) => Promise<void>;
    creatorOk: (req: any, reply: any) => Promise<void>;
  }
}

export const authPlugin = fp(async (app) => {
  await app.register(jwt, { secret: process.env.JWT_SECRET!, sign: { expiresIn: '15m' } });

  app.decorate('auth', async (req, reply) => {
    try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
    const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { status: true } });
    if (!u || u.status !== 'ACTIVE') return reply.code(403).send({ error: 'account_' + (u?.status ?? 'missing').toLowerCase() });
  });

  app.decorate('role', (...roles: Role[]) => async (req: any, reply: any) => {
    await app.auth(req, reply);
    if (reply.sent) return;
    if (!roles.includes(req.user.role)) return reply.code(403).send({ error: 'forbidden' });
  });

  // creator must be KYC-approved to publish/sell/withdraw
  app.decorate('creatorOk', async (req: any, reply: any) => {
    await app.auth(req, reply);
    if (reply.sent) return;
    const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, kycStatus: true } });
    if (u?.role !== 'CREATOR' && u?.role !== 'ADMIN') return reply.code(403).send({ error: 'not_creator' });
    if (u.kycStatus !== 'APPROVED') return reply.code(403).send({ error: 'kyc_required' });
  });
});
