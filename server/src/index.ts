import Fastify from 'fastify';
import { configureSes } from './lib/mail-ses.js';
import { warnLegacyEnv } from './lib/chain.js';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { authPlugin } from './plugins/auth.js';
import * as m from './modules/index.js';

// Never log a credential that arrives in a URL. The realtime sockets used to
// take the access JWT as ?token= (they now authenticate with their first
// message, see plugins/realtime.ts), and the default request serializer logs
// req.url verbatim -- so every connect wrote a live bearer token to journald.
// Redacted here too in case any client still sends one.
const SECRET_QUERY_PARAMS = /([?&](?:token|access|refresh|key)=)[^&#]*/gi;
const redactUrl = (url: string) => url.replace(SECRET_QUERY_PARAMS, '$1[redacted]');

const app = Fastify({
  logger: {
    serializers: {
      req: (req: any) => ({
        method: req.method,
        url: redactUrl(String(req.url ?? '')),
        hostname: req.hostname,
        remoteAddress: req.ip,
      }),
    },
  },
  bodyLimit: 1_000_000,
  // The API is only reachable through nginx on the same host (ufw allows
  // 22/80/443; Fastify listens on 4000 behind `proxy_pass http://127.0.0.1`).
  // Without trustProxy req.ip was the socket peer -- always 127.0.0.1 -- so
  // every rate limit was ONE bucket shared by the whole internet: ten bad
  // logins locked everyone out, 200 requests a minute 429'd every client.
  // Trust exactly the loopback hop, never `true`: nginx APPENDS the real peer
  // to X-Forwarded-For ($proxy_add_x_forwarded_for), and `true` would take
  // the left-most entry, which the client writes itself.
  trustProxy: 'loopback',
});
await app.register(cors, { origin: process.env.WEB_ORIGIN, credentials: true });
// ws defaults maxPayload to 100 MiB, and both realtime routes accept an
// anonymous upgrade (they authenticate with their first message, see
// plugins/realtime.ts), so twenty sockets each streaming one huge frame could
// hold ~2 GB of RAM on the droplet before any check ran. The only message
// either route ever reads is the ~1 KB auth message; ws closes an oversize
// frame with 1009 before buffering it.
await app.register(websocket, { options: { maxPayload: 16 * 1024 } });
await app.register(authPlugin);
await app.register(rateLimit, {
  max: 200,
  timeWindow: '1 minute',
  // Authenticated calls are counted per ACCOUNT, anonymous ones per client
  // IP. Every call the Next.js site makes on a user's behalf arrives from a
  // few shared Vercel egress IPs, so an IP key alone would throttle all of
  // the site's users together. The JWT is verified (HMAC, no DB) -- a forged
  // or expired one falls back to the IP key rather than choosing a bucket.
  keyGenerator: (req: any) => {
    const h = req.headers.authorization;
    if (typeof h === 'string' && h.startsWith('Bearer ')) {
      try { return `u:${(app.jwt.verify(h.slice(7)) as any).id}`; } catch { /* fall through */ }
    }
    return `ip:${req.ip}`;
  },
});

// Routes that may be called with no access token. Everything else needs a
// valid JWT before any handler runs -- and a JWT is only obtainable through
// POST /auth/bridge (direct /register and /login are off by default, see
// modules/auth.ts), i.e. by a logged-in user of the Next.js site, whose API
// routes sit behind its SIGNUPS gate, the 27-state geoblock and AgeChecker.
//
// Why: api.joinonlyone.com is a separate host that gets no Vercel geo
// headers and runs no age verification. Creator pages, PUBLIC posts and
// signed media URLs were served here to anonymous callers from any state --
// exactly the self-attestation-only exposure the site's geoblock exists to
// prevent. Until the API has its own geo + age checks, anonymous reads stay
// closed; API_ANONYMOUS_READS=true reopens them (an owner decision, not a
// default).
//
// Webhooks authenticate by signature; the two websockets authenticate with
// their first message (plugins/realtime.ts); the auth routes are the way in.
const ANONYMOUS_ROUTES = new Set([
  'GET /health',
  'POST /auth/bridge', 'POST /auth/bridge/status', 'POST /auth/register', 'POST /auth/login', 'POST /auth/refresh',
  'POST /webhooks/ses', 'POST /kyc/webhook', 'POST /live/webhook',
  'GET /messages/ws', 'GET /live/:id/events',
  // Opened from a confirmation email by whoever owns the address: the GET
  // only shows a Confirm button, the POST it sends confirms; the single-use
  // token is the proof (modules/notifications.ts).
  'GET /notifications/confirm-email', 'POST /notifications/confirm-email',
]);
const requireJwt = async (req: any, reply: any) => {
  if (req.method === 'OPTIONS') return;             // CORS preflight
  const route = req.routeOptions?.url;
  if (!route) return;                                // unmatched: let it 404
  if (ANONYMOUS_ROUTES.has(`${req.method} ${route}`)) return;
  if (process.env.API_ANONYMOUS_READS === 'true' && req.method === 'GET') return;
  try { await req.jwtVerify(); } catch { return reply.code(401).send({ error: 'unauthorized' }); }
};
// Attached per ROUTE, after @fastify/rate-limit's own onRoute hook (which is
// registered above and so runs first), so the gate lands AFTER the limiter in
// each route's onRequest chain. A root-level app.addHook('onRequest') would
// run before every route-level hook -- the limiter included -- so a flood of
// anonymous requests would each cost a JWT verify and be answered 401 without
// ever being counted. Unmatched URLs have no route and simply 404.
app.addHook('onRoute', (routeOptions: any) => {
  const cur = routeOptions.onRequest;
  routeOptions.onRequest = cur == null ? [requireJwt] : Array.isArray(cur) ? [...cur, requireJwt] : [cur, requireJwt];
});

app.get('/health', async () => ({ ok: true }));

// Guard rails in core/ that are thrown as bare Errors carrying a snake_case
// code rather than a statusCode (everywhere else the convention is
// Object.assign(new Error(code), { statusCode })). All three mean "the caller
// asked for something invalid", so they belong in the 400 class -- the
// fall-through below treats anything unlabelled as a server fault.
const CLIENT_ERRORS = new Set(['self_payment', 'invalid_amount', 'creator_unavailable']);

// Prisma's own errors carry a `code` but never a statusCode, so they used to
// fall all the way through to the 500 branch -- and since that branch redacts
// the body, a request naming an id that simply doesn't exist came back as an
// opaque { error: 'internal' }. Every code here describes the *request* being
// wrong, not the server: P2025 is raised by each findUniqueOrThrow that
// resolves a caller-supplied id (subscriptions, marketplace, posts, messages,
// admin), which zod happily passes as a well-formed uuid first.
const PRISMA_STATUS: Record<string, [number, string]> = {
  P2025: [404, 'not_found'],   // required record does not exist
  P2003: [400, 'bad_request'], // foreign key -- an id pointing at nothing
  P2002: [409, 'conflict'],    // unique violation -- usually a request racing itself
};

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
  // Prisma rejects a malformed query argument (NaN/negative skip or take from
  // a junk query string, an unknown enum value in ?status=) before it ever
  // reaches the database. Nearly always the request's fault, so a 400 -- but
  // still logged at error level, because a genuine server bug (a handler
  // passing a field the schema no longer has) raises the same class, and
  // that must not disappear into client-error noise.
  if (err instanceof Prisma.PrismaClientValidationError) {
    app.log.error(err);
    return reply.code(400).send({ error: 'bad_request' });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && PRISMA_STATUS[err.code]) {
    const [code, error] = PRISMA_STATUS[err.code];
    // A unique violation is normally a double-submit racing itself, which is
    // worth seeing in the logs even though the caller gets a 4xx for it.
    if (err.code === 'P2002') app.log.warn(err);
    return reply.code(code).send({ error });
  }
  // core/ledger.ts money() ran out of serialization retries under load. The
  // transaction rolled back, so repeating the request is safe -- say so.
  if (err.message === 'busy_retry' && err.statusCode === 503) {
    return reply.code(503).header('Retry-After', '1').send({ error: 'busy_retry' });
  }
  const status = err.statusCode ?? 500;
  if (status < 500) return reply.code(status).send({ error: err.message ?? 'bad_request' });
  // Genuine server faults: log the real error, but don't hand the raw message
  // to the client -- Prisma/driver/RPC errors quote table names, column names
  // and upstream URLs.
  app.log.error(err);
  return reply.code(status).send({ error: 'internal' });
});

// Email is off unless a provider is explicitly configured. Nothing breaks
// when it is off -- notifications are recorded either way (core/notify.ts),
// so the in-app inbox is complete on its own and email is a second channel.
// Awaited: switched on, it refuses to start without credentials that resolve.
await configureSes(app.log);
// Values set under the pre-rename ONLYASS_*/USDC_ADDRESS names do nothing.
warnLegacyEnv((msg) => app.log.warn(msg));

for (const [prefix, routes] of Object.entries({
  '/auth': m.auth, '/creators': m.creators, '/subscriptions': m.subscriptions,
  '/posts': m.posts, '/media': m.media, '/messages': m.messages, '/tips': m.tips,
  '/wallet': m.wallet, '/payouts': m.payouts, '/live': m.live, '/kyc': m.kyc, '/admin': m.admin, '/stake': m.stake,
  '/marketplace': m.marketplace, '/vip': m.vip, '/notifications': m.notifications,
  // No auth prefix guard applies here on purpose -- SNS cannot carry a
  // bearer token, so this route is unauthenticated by necessity and relies
  // on the topic allowlist + signature + freshness checks in
  // modules/ses-webhook.ts (lib/sns-verify.ts) for authenticity.
  '/webhooks': m.sesWebhook,
})) await app.register(routes, { prefix });

await app.listen({ port: Number(process.env.PORT ?? 4000), host: '0.0.0.0' });
