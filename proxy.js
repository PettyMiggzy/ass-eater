import { NextResponse } from 'next/server';
import { AGE_VERIFIED_COOKIE_NAME, ageVerificationSecret, verifyAgeVerificationToken } from './lib/age-verification';

// One Vercel project behind several domains, each serving different content
// based on hostname.
//
// GOING FORWARD (decided 2026-09-19): joinonlyone.com is the primary domain
// and shoponeonly.com is the marketplace domain. Every earlier domain
// (onlyass.fun, onlyone1.fun, onlyass.xyz, onlyass.online, onlyass.shop) stays
// live and stays a MIRROR -- same routing as before, nothing removed. Nobody
// who already has one of the old links loses it; new marketing/signage points
// at the new ones.
//
//   joinonlyone.com  -> the full platform (default, no rewrite) [PRIMARY]
//   shoponeonly.com  -> creator marketplace landing page        [PRIMARY]
//   onlyass.fun      -> the full platform (default, no rewrite) [mirror]
//   onlyone1.fun     -> the full platform (default, no rewrite) [mirror]
//   onlyass.xyz      -> token-only landing page (crypto-native TLD, kept
//                       separate from adult content for exchange/listing
//                       sites)                                  [mirror]
//   onlyass.online   -> SFW age-gate gateway that redirects into the
//                       platform                                [mirror]
//   onlyass.shop     -> creator marketplace landing page        [mirror]
const HOST_ROUTES = {
  'shoponeonly.com': '/marketplace',
  'www.shoponeonly.com': '/marketplace',
  'onlyass.xyz': '/token',
  'www.onlyass.xyz': '/token',
  'onlyass.online': '/gateway',
  'www.onlyass.online': '/gateway',
  'onlyass.shop': '/marketplace',
  'www.onlyass.shop': '/marketplace',
};

// States with an enacted, currently-in-effect law requiring real age
// verification (not a self-attestation checkbox) to access adult content --
// 27 states as of September 2026, cross-checked against AVPA's tracker and
// none currently blocked by a court (Texas's was upheld by SCOTUS, June
// 2025). This is a stopgap: block these states outright until a real
// verification vendor (Yoti/VerifyMy/AgeChecker -- in progress) is wired up,
// then lift the block state-by-state as verification comes online for each
// one. This list will need periodic re-checking -- new states keep passing
// these laws.
const BLOCKED_STATE_CODES = new Set([
  'AL', 'AR', 'AZ', 'FL', 'GA', 'ID', 'IN', 'IA', 'KS', 'KY', 'LA', 'MS',
  'MO', 'MT', 'NE', 'NC', 'ND', 'OH', 'OK', 'SC', 'SD', 'TN', 'TX', 'UT',
  'VA', 'WV', 'WY',
]);

// Paths that never show adult content regardless of hostname -- the two gate
// pages (need to stay reachable so the block/verify flow itself can run),
// the two SFW landing pages (reachable directly by path, not just through
// the root rewrite below), and the shared brand logo those pages render.
// Deliberately NOT a blanket exemption for images/videos generally -- those
// hold real creator content and must go through the check.
// /report-content must stay reachable regardless of state or verification
// status -- it's the legally-required non-consensual-content takedown
// process (TAKE IT DOWN Act), and gating it behind age verification would
// undermine the "clearly and conspicuous, freely accessible" requirement
// that process has to meet.
//
// "/" is the public landing page (pages/index.js). It is exempt because it
// is deliberately typographic -- no creator photos, no content grid,
// nothing explicit -- which is the whole basis on which an unverified
// visitor is allowed to see it. If that page ever gains real content, this
// exemption has to go with it.
// /founding-creator is exempt for the same reason "/" is: it is a
// typographic recruitment page with no creator photos and nothing explicit
// on it, and a recruitment page that only verified adults in non-blocked
// states can open cannot recruit. Same hard rule applies -- if it ever
// gains real content, this exemption goes with it.
// /terms, /privacy and /2257 are exempt on the same basis as "/": they are
// pure text with no creator content on them at all. They also have to be
// readable by people who cannot enter the site -- a payment processor doing
// onboarding review, a regulator, or someone in a blocked state who wants to
// know what we do with their data before verifying.
const SFW_PATHS = new Set(['/', '/blocked-region', '/verify-age', '/gateway', '/token', '/report-content', '/founding-creator', '/terms', '/privacy', '/2257']);

// Prefix exemptions, for assets an exempt page actually renders. Without
// this, /founding-creator serves to a blocked-state visitor with its hero
// badge broken -- the image request is a separate trip through this proxy
// and would be rewritten to /blocked-region HTML. Only brand/badge art
// lives here; creator content never does.
const SFW_PREFIXES = ['/images/badges/'];

// The verify-age flow has to be able to complete from a blocked state, and
// the takedown form is required by the TAKE IT DOWN Act to be freely
// reachable. Every other API route is gated like a page -- several of them
// return creator data, and an ungated /api/* is the same bypass shape as
// the /images/ one already fixed here.
const SFW_API_PREFIXES = ['/api/age-verify/', '/api/report-content'];

// Pages Router serves every getServerSideProps payload at
// /_next/data/<buildId>/<page>.json. The matcher used to exclude _next/
// wholesale, so those never reached this proxy at all: a blocked-state
// visitor could read buildId out of any exempt page's __NEXT_DATA__ and then
// fetch /_next/data/<id>/creators.json for the full props of a gated page.
//
// Next normalises nextUrl.pathname back to the page for a data request, so
// this mapping is usually a no-op -- it is kept as the belt to that braces,
// because the whole gate rests on the pathname being the page's.
function servedPageFor(pathname) {
  const m = /^\/_next\/data\/[^/]+\/(.*)\.json$/.exec(pathname);
  if (!m) return pathname;
  return m[1] === 'index' ? '/' : `/${m[1]}`;
}

function isExempt(path) {
  if (SFW_PATHS.has(path)) return true;
  if (SFW_PREFIXES.some((p) => path.startsWith(p))) return true;
  if (SFW_API_PREFIXES.some((p) => path === p || path.startsWith(p))) return true;
  return false;
}

export async function proxy(request) {
  const host = request.headers.get('host') || '';
  const { pathname } = request.nextUrl;

  // Decide against the path that will ACTUALLY be served, not the one the
  // visitor typed. Some hosts rewrite their root to a different page, and
  // one of them (onlyass.shop -> /marketplace) rewrites to adult content:
  // exempting "/" by the requested path alone would hand that host an
  // ungated marketplace. Resolving the rewrite first means joinonlyone.com/
  // (and onlyass.fun/, onlyone1.fun/) get the public landing and are
  // exempt, onlyass.xyz/ gets /token and is exempt, and shoponeonly.com/
  // (and onlyass.shop/) get /marketplace and are checked like any other
  // page.
  const hostTarget = HOST_ROUTES[host];
  const requested = servedPageFor(pathname);
  const servedPath = hostTarget && requested === '/' ? hostTarget : requested;

  if (!isExempt(servedPath)) {
    const country = request.headers.get('x-vercel-ip-country');
    const region = request.headers.get('x-vercel-ip-country-region');
    if (country === 'US' && BLOCKED_STATE_CODES.has(region)) {
      const token = request.cookies.get(AGE_VERIFIED_COOKIE_NAME)?.value;
      const verified = await verifyAgeVerificationToken(ageVerificationSecret(), token);
      if (!verified) {
        // An API caller gets JSON. Rewriting it to the blocked-region page
        // would hand a fetch() a 200 full of HTML, which reads as a parse
        // bug rather than a refusal.
        // Same for a /_next/data/ props request: handing a .json fetch a
        // page of HTML makes the client router look broken. A non-2xx makes
        // it fall back to a full navigation, which lands on the gate.
        // Detected by header, not path: Next normalises nextUrl.pathname for
        // a data request back to the page it belongs to, so by here it reads
        // "/creators", not "/_next/data/<id>/creators.json".
        const isDataRequest = request.headers.get('x-nextjs-data') === '1';
        if (isDataRequest || pathname.startsWith('/api/')) {
          return new NextResponse(JSON.stringify({ error: 'age_verification_required' }), {
            status: 451,
            headers: { 'content-type': 'application/json' },
          });
        }
        return NextResponse.rewrite(new URL('/blocked-region', request.url));
      }
    }
  }

  if (hostTarget && pathname === '/') {
    return NextResponse.rewrite(new URL(hostTarget, request.url));
  }

  return NextResponse.next();
}

// images/ and videos/ hold real creator content (seed demo photos/videos are
// adult content) and must go through the age check -- only icons/favicon and
// framework assets (never content) are excluded outright. api/ and
// _next/data/ deliberately DO run through the proxy: both serve the same
// data the pages do, and the routes that must stay reachable from a blocked
// state are exempted by path above, not by skipping the check entirely.
export const config = {
  matcher: ['/((?!_next/(?!data/)|favicon|icons/).*)'],
};
