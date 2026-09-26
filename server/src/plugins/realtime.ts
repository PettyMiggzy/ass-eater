import type { FastifyInstance } from 'fastify';
import type { Role } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { subscribeChannel } from '../lib/redis.js';

/**
 * Shared plumbing for the realtime websockets (/messages/ws and
 * /live/:id/events).
 *
 * Authentication is the FIRST MESSAGE, not the URL. Browsers cannot set an
 * Authorization header on a WebSocket, so these routes used to take the
 * access JWT as `?token=` -- which put a live bearer token into the Fastify
 * request log and nginx's access log on every connect. The client now opens
 * the socket bare and sends, within AUTH_TIMEOUT_MS:
 *
 *   {"type":"auth","token":"<access jwt>"}
 *
 * The server answers {"type":"ready"} once subscribed, then relays events.
 * Close codes: 4001 unauthorized / auth timeout / token expired,
 * 4003 account not active or entitlement lapsed (access_expired),
 * 4004 nothing to subscribe to.
 *
 * Keepalive: a protocol ping every PING_MS. nginx drops an upgraded
 * connection after proxy_read_timeout (75s) of silence, and browsers cannot
 * send ping frames themselves, so without this every quiet inbox was cut at
 * 75 seconds and missed whatever arrived next.
 *
 * The socket is closed when the access token expires, so a banned or
 * suspended user cannot keep receiving events on a socket they opened before
 * it happened; the client reconnects with a fresh token.
 */
const AUTH_TIMEOUT_MS = 5_000;
const PING_MS = 30_000;

type SocketUser = { id: string; role: Role; exp?: number };
/**
 * A channel name, null (refused), or a channel with an entitlement expiry:
 * the socket is closed at the EARLIER of the access token's expiry and
 * `expiresAt` (e.g. a per-minute live viewer's paid time), so access that
 * lapses mid-connection ends the feed rather than lasting until the JWT
 * does. The client reconnects and the grant is decided afresh.
 */
type ChannelGrant = string | null | { channel: string; expiresAt: Date | null };

export function serveRealtimeChannel(
  app: FastifyInstance,
  socket: any,
  channelFor: (user: SocketUser) => ChannelGrant | Promise<ChannelGrant>,
) {
  let closed = false;
  let release: (() => Promise<void>) | null = null;
  let expiryTimer: NodeJS.Timeout | null = null;

  // terminate(), not close(): a close handshake keeps reading from the peer
  // until ws's 30 s close timeout, so a client that never authenticates could
  // hold the connection (and keep sending) well past AUTH_TIMEOUT_MS.
  const authTimer = setTimeout(() => {
    try { socket.terminate(); } catch { /* already gone */ }
  }, AUTH_TIMEOUT_MS);
  const pingTimer = setInterval(() => { try { socket.ping(); } catch { /* closing */ } }, PING_MS);

  socket.on('close', () => {
    closed = true;
    clearTimeout(authTimer);
    clearInterval(pingTimer);
    if (expiryTimer) clearTimeout(expiryTimer);
    if (release) release().catch((err) => app.log.warn(err, 'realtime: unsubscribe failed'));
    release = null;
  });

  socket.once('message', async (raw: unknown) => {
    clearTimeout(authTimer);
    let token: string | null = null;
    try {
      const m = JSON.parse(String(raw));
      if (m && m.type === 'auth' && typeof m.token === 'string') token = m.token;
    } catch { /* not JSON */ }
    if (!token) return socket.close(4001, 'unauthorized');

    let user: SocketUser;
    try { user = app.jwt.verify<SocketUser>(token); } catch { return socket.close(4001, 'unauthorized'); }

    try {
      const row = await prisma.user.findUnique({ where: { id: user.id }, select: { status: true } });
      if (row?.status !== 'ACTIVE') return socket.close(4003, 'forbidden');
      const grant = await channelFor(user);
      if (!grant) return socket.close(4004, 'not_found');
      const channel = typeof grant === 'string' ? grant : grant.channel;
      const grantEnds = typeof grant === 'string' ? null : grant.expiresAt;
      if (grantEnds && grantEnds.getTime() <= Date.now()) return socket.close(4003, 'access_expired');
      if (closed) return;

      const unsubscribe = await subscribeChannel(channel, (msg) => {
        if (socket.readyState === 1) socket.send(msg);
      });
      // The socket may have closed while SUBSCRIBE was in flight.
      if (closed) { await unsubscribe(); return; }
      release = unsubscribe;

      const tokenMs = typeof user.exp === 'number' ? user.exp * 1000 - Date.now() : Infinity;
      const grantMs = grantEnds ? grantEnds.getTime() - Date.now() : Infinity;
      if (Number.isFinite(tokenMs) || Number.isFinite(grantMs)) {
        const lapsed = grantMs < tokenMs;
        expiryTimer = setTimeout(
          () => socket.close(lapsed ? 4003 : 4001, lapsed ? 'access_expired' : 'token_expired'),
          Math.max(0, Math.min(tokenMs, grantMs)),
        );
      }
      socket.send(JSON.stringify({ type: 'ready' }));
    } catch (err) {
      app.log.error(err, 'realtime: failed to open channel');
      if (!closed) socket.close(1011, 'internal');
    }
  });
}
