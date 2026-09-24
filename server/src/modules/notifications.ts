import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { mailConfigured } from '../lib/mailer.js';

/**
 * The creator's notification inbox.
 *
 * Works with no email provider configured at all -- the Notification rows
 * are written regardless, so this is a complete feature on its own and
 * email is an optional second delivery channel on top. See lib/mailer.ts
 * for why that separation is not incidental.
 */
export const notifications: FastifyPluginAsync = async (app) => {
  app.get('/', { preHandler: app.auth }, async (req: any) => {
    // Not z.coerce.boolean(): that is Boolean(value), so the query strings
    // 'false' and '0' both came out true and ?unreadOnly=false returned only
    // unread items.
    const q = z.object({
      unreadOnly: z.enum(['true', 'false', '1', '0']).optional().transform((v) => v === 'true' || v === '1'),
    }).parse(req.query ?? {});
    const [items, unread] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id, ...(q.unreadOnly ? { readAt: null } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.notification.count({ where: { userId: req.user.id, readAt: null } }),
    ]);
    return { items, unread, emailDelivery: mailConfigured() };
  });

  app.post('/read', { preHandler: app.auth }, async (req: any) => {
    const b = z.object({ ids: z.array(z.string().uuid()).max(200).optional() }).parse(req.body ?? {});
    // Scoped to the caller's own rows in the WHERE, not checked beforehand:
    // an id belonging to someone else simply matches nothing rather than
    // needing a separate ownership read that could go stale between the two.
    const { count } = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null, ...(b.ids ? { id: { in: b.ids } } : {}) },
      data: { readAt: new Date() },
    });
    return { ok: true, marked: count };
  });

  // Creator-side settings for where notifications go and whether they send.
  app.patch('/settings', { preHandler: app.creatorOk }, async (req: any, reply) => {
    const b = z.object({
      // Empty string clears the override and falls back to the account
      // email; null would be indistinguishable from "field not sent".
      notifyEmail: z.string().email().max(200).or(z.literal('')).optional(),
      notifyOnDm: z.boolean().optional(),
    }).parse(req.body);

    const data: Record<string, unknown> = {};
    if (b.notifyEmail !== undefined) data.notifyEmail = b.notifyEmail === '' ? null : b.notifyEmail;
    if (b.notifyOnDm !== undefined) data.notifyOnDm = b.notifyOnDm;
    if (!Object.keys(data).length) return reply.code(400).send({ error: 'nothing_to_update' });

    const updated = await prisma.creatorProfile.update({
      where: { userId: req.user.id },
      data,
      select: { notifyEmail: true, notifyOnDm: true },
    });
    return { ...updated, emailDelivery: mailConfigured() };
  });
};
