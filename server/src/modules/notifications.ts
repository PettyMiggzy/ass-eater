import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import crypto from 'crypto';
import { mailConfigured, sendNotificationMail } from '../lib/mailer.js';
import { creatorMayOperate } from '../core/access.js';

/**
 * The creator's notification inbox.
 *
 * Works with no email provider configured at all -- the Notification rows
 * are written regardless, so this is a complete feature on its own and
 * email is an optional second delivery channel on top. See lib/mailer.ts
 * for why that separation is not incidental.
 */
export const notifications: FastifyPluginAsync = async (app) => {
  // The confirm page's plain HTML form posts urlencoded. Registered inside
  // this plugin only (encapsulated), so no other route accepts form bodies.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 4096 }, (_req, body, done) => {
    try { done(null, Object.fromEntries(new URLSearchParams(String(body)))); } catch (err) { done(err as Error, undefined); }
  });

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
  //
  // A new notifyEmail is NOT used until its owner confirms it: it is stored
  // as pending and a single-use link is mailed to it (double opt-in).
  // Saving it straight away let a creator point "someone messaged you on
  // OnlyOne" mail at a coworker or an ex, and every resulting complaint
  // counts against the SES account. The confirmed address stays in use
  // until the new one is confirmed.
  //
  // Gated on the creator ROLE, not creatorOk: every notification mail says it
  // can be turned off any time, and a creator whose KYC was reset or whose
  // site approval lapsed used to get 403 here while the mail kept coming.
  // Opting OUT (notifyOnDm=false, clearing the address) is always allowed;
  // turning mail back ON or naming a new address still needs an operating
  // creator (creatorMayOperate) -- core/notify.ts does not mail anyone else.
  // A SUSPENDED or BANNED account cannot reach this at all (app.auth, and its
  // refresh tokens are revoked), so core/notify.ts never mails one either.
  app.patch('/settings', {
    preHandler: app.role('CREATOR', 'ADMIN'),
    config: { rateLimit: { max: 20, timeWindow: '10 minutes' } },
  }, async (req: any, reply) => {
    const b = z.object({
      // Empty string clears the address (and any pending one); null would be
      // indistinguishable from "field not sent".
      notifyEmail: z.string().trim().toLowerCase().email().max(200).or(z.literal('')).optional(),
      notifyOnDm: z.boolean().optional(),
    }).parse(req.body);
    if (b.notifyEmail === undefined && b.notifyOnDm === undefined) return reply.code(400).send({ error: 'nothing_to_update' });

    const optsIn = b.notifyOnDm === true || (b.notifyEmail !== undefined && b.notifyEmail !== '');
    if (optsIn) {
      const u = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, kycStatus: true, siteUid: true, siteCreatorStatus: true } });
      if (u?.kycStatus !== 'APPROVED') return reply.code(403).send({ error: 'kyc_required' });
      if (!creatorMayOperate(u)) return reply.code(403).send({ error: 'creator_not_approved' });
    }

    const cur = await prisma.creatorProfile.findUnique({
      where: { userId: req.user.id },
      select: { notifyEmail: true, notifyConfirmSentAt: true },
    });
    if (!cur) return reply.code(403).send({ error: 'not_creator' });
    const data: Record<string, unknown> = {};
    if (b.notifyOnDm !== undefined) data.notifyOnDm = b.notifyOnDm;
    let confirmationSent = false;
    let token: string | null = null;
    if (b.notifyEmail === '') {
      Object.assign(data, { notifyEmail: null, notifyEmailVerifiedAt: null, ...CLEAR_PENDING });
    } else if (b.notifyEmail !== undefined && b.notifyEmail !== cur.notifyEmail) {
      // Resend cooldown: a confirmation mail is still mail to an address the
      // creator merely typed, so it can't be fired at someone on a loop.
      if (cur.notifyConfirmSentAt && Date.now() - cur.notifyConfirmSentAt.getTime() < CONFIRM_RESEND_MS) {
        return reply.code(429).send({ error: 'confirmation_recently_sent' });
      }
      token = crypto.randomBytes(32).toString('base64url');
      Object.assign(data, {
        notifyEmailPending: b.notifyEmail,
        notifyEmailTokenHash: sha(token),
        notifyEmailTokenExpiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
        notifyConfirmSentAt: new Date(),
      });
    }

    const updated = await prisma.creatorProfile.update({
      where: { userId: req.user.id },
      data,
      select: SETTINGS_SELECT,
    });
    if (token && b.notifyEmail) {
      const r = await sendNotificationMail({ to: b.notifyEmail, kind: 'CONFIRM_NOTIFY_EMAIL', confirmUrl: confirmUrl(token) });
      confirmationSent = r.sent;
    }
    return { ...updated, confirmationSent, emailDelivery: mailConfigured() };
  });

  // Same weaker gate as PATCH, so the opt-out UI loads for a creator whose
  // approval lapsed.
  app.get('/settings', { preHandler: app.role('CREATOR', 'ADMIN') }, async (req: any, reply) => {
    const row = await prisma.creatorProfile.findUnique({ where: { userId: req.user.id }, select: SETTINGS_SELECT });
    if (!row) return reply.code(403).send({ error: 'not_creator' });
    return { ...row, emailDelivery: mailConfigured() };
  });

  // The link in the confirmation mail. Public (the person opening it may not
  // be logged in anywhere); the token is the proof. Single use.
  //
  // Two steps on purpose: the GET only shows a page with a Confirm button,
  // and the address is promoted by the POST that button sends. Mail security
  // scanners and link prefetchers (Safe Links and the like) GET every URL in
  // an inbound mail on their own, so a GET that confirmed would confirm an
  // address nobody at it ever agreed to -- defeating the double opt-in.
  app.get('/confirm-email', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (req: any, reply) => {
    const q = TOKEN.safeParse((req.query ?? {}).token);
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').type('text/html; charset=utf-8');
    if (!q.success) return reply.code(400).send(page('This confirmation link is not valid.'));
    // No lookup here: the page says nothing about whether the token is live.
    return page(
      'Confirm that OnlyOne may send creator notification emails to this address.',
      `<form method="post" action="confirm-email"><input type="hidden" name="token" value="${q.data}"><button type="submit">Confirm this address</button></form>`,
    );
  });

  app.post('/confirm-email', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (req: any, reply) => {
    const form = isForm(req);
    const t = TOKEN.safeParse((req.body ?? {}).token);
    const fail = () => form
      ? reply.code(400).type('text/html; charset=utf-8').send(page('This confirmation link is invalid or has expired.'))
      : reply.code(400).send({ error: 'invalid_or_expired_token' });
    if (!t.success) return fail();
    const hash = sha(t.data);
    const row = await prisma.creatorProfile.findUnique({
      where: { notifyEmailTokenHash: hash },
      select: { userId: true, notifyEmailPending: true, notifyEmailTokenExpiresAt: true },
    });
    if (!row || !row.notifyEmailPending || !row.notifyEmailTokenExpiresAt || row.notifyEmailTokenExpiresAt < new Date()) return fail();
    // Guarded on the same token hash, so a link superseded by a newer
    // request (or already used) confirms nothing.
    const r = await prisma.creatorProfile.updateMany({
      where: { userId: row.userId, notifyEmailTokenHash: hash, notifyEmailPending: row.notifyEmailPending },
      data: { notifyEmail: row.notifyEmailPending, notifyEmailVerifiedAt: new Date(), ...CLEAR_PENDING },
    });
    if (!r.count) return fail();
    if (form) return reply.header('Cache-Control', 'no-store').type('text/html; charset=utf-8').send(page('Confirmed. Notifications will be sent to this address.'));
    return { ok: true, confirmed: true };
  });
};

const CONFIRM_TTL_MS = 24 * 3600_000;
const CONFIRM_RESEND_MS = 10 * 60_000;
const CLEAR_PENDING = { notifyEmailPending: null, notifyEmailTokenHash: null, notifyEmailTokenExpiresAt: null };
const SETTINGS_SELECT = { notifyEmail: true, notifyEmailVerifiedAt: true, notifyEmailPending: true, notifyOnDm: true } as const;
// The raw token is 32 random bytes, base64url -- nothing else is accepted,
// which also makes it safe to echo into the confirm page's HTML.
const TOKEN = z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/);
const isForm = (req: any) => String(req.headers?.['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
// Fixed strings only; the one dynamic value (the token) is regex-checked above.
const page = (message: string, body = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>OnlyOne</title></head>`
  + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem"><p>${message}</p>${body}</body></html>`;
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
// Opened by whoever owns the address, so it points at this API directly.
const confirmUrl = (token: string) =>
  `${(process.env.PUBLIC_API_URL || 'https://api.joinonlyone.com').replace(/\/+$/, '')}/notifications/confirm-email?token=${encodeURIComponent(token)}`;
