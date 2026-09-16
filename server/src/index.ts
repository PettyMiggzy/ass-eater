import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { authPlugin } from './plugins/auth';
import * as m from './modules';

const app = Fastify({ logger: true, bodyLimit: 1_000_000 });
await app.register(cors, { origin: process.env.WEB_ORIGIN, credentials: true });
await app.register(websocket);
await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
await app.register(authPlugin);

app.get('/health', async () => ({ ok: true }));

app.setErrorHandler((err: any, _req, reply) => {
  if (err.message === 'insufficient_funds') return reply.code(402).send({ error: 'insufficient_funds' });
  if (err.validation) return reply.code(400).send({ error: 'bad_request', details: err.validation });
  app.log.error(err);
  reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'internal' });
});

for (const [prefix, routes] of Object.entries({
  '/auth': m.auth, '/creators': m.creators, '/subscriptions': m.subscriptions,
  '/posts': m.posts, '/media': m.media, '/messages': m.messages, '/tips': m.tips,
  '/wallet': m.wallet, '/payouts': m.payouts, '/live': m.live, '/kyc': m.kyc, '/admin': m.admin, '/stake': m.stake,
  '/marketplace': m.marketplace, '/vip': m.vip,
})) await app.register(routes, { prefix });

await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
