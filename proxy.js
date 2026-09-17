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

// Hosts that never serve adult content, so the state age-verification block
// below doesn't apply to them -- everything else (the main platform, the
// marketplace, preview/vercel.app URLs, custom domains not listed here) is
// treated as adult-content-serving by default (fail closed, not open).
const SFW_HOSTS = new Set(['onlyass.xyz', 'www.onlyass.xyz', 'onlyass.online', 'www.onlyass.online']);

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
const SFW_PATHS = new Set(['/blocked-region', '/verify-age', '/gateway', '/token', '/images/logo-final.png']);

export async function proxy(request) {
  const host = request.headers.get('host') || '';
  const { pathname } = request.nextUrl;

  // SFW_HOSTS only ever serve real content at the root path (rewritten to
  // /gateway or /token below) -- any other path on those hosts still
  // resolves to the actual platform (same Next.js app, routed by pathname
  // regardless of hostname), so only root is exempt from the check.
  const isSfwRoot = pathname === '/' && SFW_HOSTS.has(host);

  if (!SFW_PATHS.has(pathname) && !isSfwRoot) {
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

  const target = HOST_ROUTES[host];
  if (target && pathname === '/') {
    return NextResponse.rewrite(new URL(target, request.url));
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
