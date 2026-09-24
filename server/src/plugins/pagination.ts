import { z } from 'zod';

/**
 * Shared parser for `?offset=&limit=` on list routes.
 *
 * The routes used to do `skip: Number(req.query.offset ?? 0)` and
 * `take: Math.min(Number(req.query.limit ?? 30), 100)`, which hands Prisma
 * NaN for `?offset=abc` and a negative number for `?limit=-5`. Prisma throws a
 * PrismaClientValidationError for both, which the error handler reported as a
 * 500 server fault -- so any scanner could fill the error log with junk
 * query strings. Parsing here turns them into a 400 (ZodError) instead.
 *
 * Usage: `const { offset, limit } = page(req.query);` or
 * `page(req.query, { limit: 10, max: 50 })`.
 */
export function page(query: unknown, opts: { limit?: number; max?: number; maxOffset?: number } = {}) {
  const max = opts.max ?? 100;
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  return z.object({
    offset: z.coerce.number().int().min(0).max(opts.maxOffset ?? 10_000).default(0),
    // An over-large limit is clamped, as before, rather than refused.
    limit: z.coerce.number().int().min(1).default(Math.min(opts.limit ?? 30, max)).transform((v) => Math.min(v, max)),
  }).parse({ offset: q.offset, limit: q.limit });
}
