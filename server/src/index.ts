import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { authPlugin } from './plugins/auth';
import * as m from './modules';

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
await app.register(cors, { origin: process.env.WEB_ORIGIN, credentials: true });
await app.register(websocket);
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
await app.register(authPlugin);

app.get('/health', async () => ({ ok: true }));

// Guard rails in core/ that are thrown as bare Errors carrying a snake_case
// code rather than a statusCode (everywhere else the convention is
// Object.assign(new Error(code), { statusCode })). All three mean "the caller
// asked for something invalid", so they belong in the 400 class -- the
// fall-through below treats anything unlabelled as a server fault.
const CLIENT_ERRORS = new Set(['self_payment', 'invalid_amount', 'creator_unavailable']);

app.setErrorHandler((err: any, _req, reply) => {
  if (err.message === 'insufficient_funds') return reply.code(402).send({ error: 'insufficient_funds' });
  if (err.validation) return reply.code(400).send({ error: 'bad_request', details: err.validation });
  // Handlers validate their input with zod (z.object(...).parse(req.body)),
  // which throws a ZodError. Fastify only sets err.validation for its own
  // JSON-schema checks, so without this branch every bad client body -- a
  // negative amount, a missing field, a malformed uuid -- fell through and was
  // reported as a 500 server fault.
  if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', details: err.issues });
  if (CLIENT_ERRORS.has(err.message)) return reply.code(400).send({ error: err.message });
  const status = err.statusCode ?? 500;
  if (status < 500) return reply.code(status).send({ error: err.message ?? 'bad_request' });
  // Genuine server faults: log the real error, but don't hand the raw message
  // to the client -- Prisma/driver/RPC errors quote table names, column names
  // and upstream URLs.
  app.log.error(err);
  return reply.code(status).send({ error: 'internal' });
});

for (const [prefix, routes] of Object.entries({
  '/auth': m.auth, '/creators': m.creators, '/subscriptions': m.subscriptions,
  '/posts': m.posts, '/media': m.media, '/messages': m.messages, '/tips': m.tips,
  '/wallet': m.wallet, '/payouts': m.payouts, '/live': m.live, '/kyc': m.kyc, '/admin': m.admin, '/stake': m.stake,
  '/marketplace': m.marketplace, '/vip': m.vip,
})) await app.register(routes, { prefix });

await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
