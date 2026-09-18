import { NextResponse } from 'next/server';
import { AGE_VERIFIED_COOKIE_NAME, ageVerificationSecret, verifyAgeVerificationToken } from './lib/age-verification';

// Only Ass runs on one Vercel project behind several domains, each serving
// different content based on hostname:
//   onlyass.fun    -> the full platform (default, no rewrite)
//   onlyass.xyz    -> token-only landing page (crypto-native TLD, kept
//                     separate from adult content for exchange/listing sites)
//   onlyass.online -> SFW age-gate gateway that redirects into onlyass.fun
//   onlyass.shop   -> creator marketplace landing page
const HOST_ROUTES = {
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
const SFW_PATHS = new Set(['/', '/blocked-region', '/verify-age', '/gateway', '/token', '/report-content', '/founding-creator', '/images/logo-final.png']);

export async function proxy(request) {
  const host = request.headers.get('host') || '';
  const { pathname } = request.nextUrl;

  // Decide against the path that will ACTUALLY be served, not the one the
  // visitor typed. Some hosts rewrite their root to a different page, and
  // one of them (onlyass.shop -> /marketplace) rewrites to adult content:
  // exempting "/" by the requested path alone would hand that host an
  // ungated marketplace. Resolving the rewrite first means onlyass.fun/
  // gets the public landing and is exempt, onlyass.xyz/ gets /token and is
  // exempt, and onlyass.shop/ gets /marketplace and is checked like any
  // other page.
  const hostTarget = HOST_ROUTES[host];
  const servedPath = hostTarget && pathname === '/' ? hostTarget : pathname;

  if (!SFW_PATHS.has(servedPath)) {
    const country = request.headers.get('x-vercel-ip-country');
    const region = request.headers.get('x-vercel-ip-country-region');
    if (country === 'US' && BLOCKED_STATE_CODES.has(region)) {
      const token = request.cookies.get(AGE_VERIFIED_COOKIE_NAME)?.value;
      const verified = await verifyAgeVerificationToken(ageVerificationSecret(), token);
      if (!verified) {
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
// adult content) and must go through the age check -- only icons/favicon/
// framework assets (never content) and api/ (needs to stay reachable so the
// verify-age flow itself can complete from a blocked state) are exempt.
export const config = {
  matcher: ['/((?!api/|_next/|favicon|icons/).*)'],
};
