import { NextResponse } from 'next/server';
import { AGE_VERIFIED_COOKIE_NAME, ageVerificationSecret, verifyAgeVerificationToken } from './lib/age-verification';
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_COOKIE_MAX_AGE,
  PREVIEW_QUERY_PARAM,
  createPreviewToken,
  previewAccessKey,
  previewKeyMatches,
  previewModeEnabled,
  previewSecret,
  verifyPreviewToken,
} from './lib/preview-access';

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
// /owner is the wallet sign-in for the site owner, who lives in one of the
// blocked states. Gating the page whose entire job is to get past the gate
// is the circular dead end /blocked-region and /report-content were each
// fixed for. It shows no content and does nothing without a signature from
// one specific private key, so exempting it gives away nothing.
// /coming-soon is the pre-launch preview page: wordmark, three lines of copy
// and the waitlist, no creator content -- the same basis as "/". It was
// already in PREVIEW_PUBLIC_PATHS and _app.js's NO_NOTICE_PATHS; leaving it
// out of this list broke the rule that the three move together.
const SFW_PATHS = new Set(['/', '/coming-soon', '/blocked-region', '/verify-age', '/owner', '/gateway', '/token', '/report-content', '/founding-creator', '/terms', '/privacy', '/2257']);

// Site plumbing files that are not pages and carry no content: the crawler
// directives, the sitemap, the PWA manifest (which references only
// favicon-*.png) and the iOS home-screen icon. _document.js links the last
// two from EVERY page, the exempt ones included, so gating them handed a
// blocked-state visitor the blocked-region HTML where JSON or a PNG belonged
// (a manifest syntax error on the page that tells them where they are), and
// handed a crawler geolocated to a blocked state an HTML robots.txt with none
// of its Disallow lines in it.
//
// Exact matches, deliberately not prefixes or a matcher lookahead, so no
// future path that merely starts with one of these names slips through.
// Exempt from BOTH gates -- listed in PREVIEW_PUBLIC_PATHS too.
const PUBLIC_STATIC_FILES = ['/robots.txt', '/sitemap.xml', '/manifest.json', '/apple-touch-icon.png'];
for (const p of PUBLIC_STATIC_FILES) SFW_PATHS.add(p);

// Brand art, and the ONLY files under /images/ that skip either gate.
//
// These are the social-card and structured-data images. They have to be
// fetchable with no cookie and from anywhere, because the thing that
// fetches them is Facebook's, X's, iMessage's or Slack's scraper -- not a
// person with a verified session -- and a scraper that gets the
// blocked-region HTML instead of a PNG renders no card at all. That failure
// is silent: the link just looks bare, with nothing logged anywhere.
//
// Exempting them costs nothing because they carry no creator content: they
// are the wordmark on black. That is the whole and only basis for this
// list, and it is the same rule as the pages above -- if either file ever
// becomes anything but brand art, it comes straight back out.
const BRAND_ART_PATHS = [
  '/images/og-onlyone.png',
  '/images/logo-onlyone.png',
  // The nav lockup. SiteNav renders on /2257, which is exempt from the age
  // gate so a regulator or a payment processor can read it -- without this
  // the logo would be the single broken image on that page.
  '/images/onlyone-lockup-nav.png',
  '/images/onlyone-lockup.png',
];

// Prefix exemptions, for assets an exempt page actually renders, plus the
// brand art above. Everything else under /images/ stays gated: those hold
// real creator content, and a blanket exemption there was an actual age
// bypass once already.
const SFW_PREFIXES = [...BRAND_ART_PATHS];

// The verify-age flow has to be able to complete from a blocked state, the
// takedown form is required by the TAKE IT DOWN Act to be freely reachable,
// and the pre-launch waitlist exists precisely to capture visitors this
// site cannot serve yet -- a blocked-state visitor has to be able to POST
// to it from /blocked-region, or the form on that page 451s and the page is
// a dead end again. Every other API route is gated like a page -- several
// of them return creator data, and an ungated /api/* is the same bypass
// shape as the /images/ one already fixed here.
//
// Anything added here must return NO creator data and require no account.
// These three qualify; almost nothing else will.
const SFW_API_PREFIXES = ['/api/age-verify/', '/api/report-content', '/api/waitlist'];

// ---------------------------------------------------------------------------
// PRE-LAUNCH PREVIEW GATE
// ---------------------------------------------------------------------------
// While PREVIEW_ACCESS_KEY is set, the real site is only served to visitors
// holding the invite link; everyone else gets /coming-soon and the waitlist.
// Delete that env var to launch.
//
// THIS IS A SEPARATE CHECK FROM THE AGE GATE AND DOES NOT REPLACE IT. An
// invite gets you to the real site; it does not get you past the 27-state
// verification, which still runs below on exactly the same paths as before.
// Both have to pass. Do not "simplify" these into one check.
//
// What stays public without an invite, and why each one has to be:
//   /coming-soon      the preview site itself
//   /founding-creator the creator recruitment pitch -- the point of being
//                     public pre-launch is recruiting, and it carries no
//                     creator content (same hard rule as "/")
//   /terms /privacy   a payment processor doing onboarding review and a
//   /2257             regulator reading the record-keeping statement both
//                     have to be able to read these without an invite
//   /report-content   required by the TAKE IT DOWN Act to be freely
//                     accessible -- an invite-only takedown form is not
//                     freely accessible
//   /blocked-region   the age-gate pages themselves, so that flow can still
//   /verify-age       complete for someone who DOES hold an invite
//
// "/" is deliberately NOT here: without an invite it serves /coming-soon,
// which is the whole feature. Anything added to these lists must carry no
// creator content and need no account.
// The brand art is listed here too, for the same reason it is exempt from
// the age gate: a preview site whose whole purpose is a link someone pastes
// somewhere cannot have the card image behind the invite. A page and the
// assets its card points at are exempted together or not at all.
const PREVIEW_PUBLIC_PATHS = new Set([
  '/coming-soon', '/founding-creator', '/terms', '/privacy', '/2257',
  '/report-content', '/blocked-region', '/verify-age', '/owner',
  // /gateway and /token are the two SFW mirror-domain landing pages
  // (onlyass.online, onlyass.xyz) and are already exempt from the state
  // geoblock via SFW_PATHS above -- they were missing here, which has no
  // live effect while PREVIEW_ACCESS_KEY is unset, but would have shown
  // "coming soon" to those two supposedly-always-public pages the moment
  // preview mode was ever re-armed. Same "exemption lists move together"
  // rule as everywhere else in this file.
  '/gateway', '/token',
  ...BRAND_ART_PATHS,
  ...PUBLIC_STATIC_FILES,
]);

// The waitlist is the entire job of the preview site, so its endpoint has to
// work without an invite -- exactly the same lesson as the age gate, where
// exempting the page and forgetting the API left a form that rendered and
// then refused on submit. A page and the endpoint it posts to are exempted
// together or not at all.
const PREVIEW_PUBLIC_API_PREFIXES = ['/api/waitlist', '/api/report-content', '/api/age-verify/'];

function isPreviewPublic(path) {
  if (PREVIEW_PUBLIC_PATHS.has(path)) return true;
  return PREVIEW_PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(p));
}

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

  if (previewModeEnabled()) {
    const secret = previewSecret();

    // The invite link is ?preview=<key> on ANY path, so one link works
    // whether it is pasted bare or pointed at a specific page. Redirect
    // rather than continue, so the key is stripped from the URL before the
    // page renders -- otherwise it ends up in the address bar, in a
    // screenshot, and in the Referer header of every outbound link.
    const offered = request.nextUrl.searchParams.get(PREVIEW_QUERY_PARAM);
    if (offered !== null) {
      const url = request.nextUrl.clone();
      url.searchParams.delete(PREVIEW_QUERY_PARAM);
      const response = NextResponse.redirect(url);
      if (await previewKeyMatches(offered, previewAccessKey())) {
        response.cookies.set(PREVIEW_COOKIE_NAME, await createPreviewToken(secret), {
          httpOnly: true,
          // Lax, not Strict: the whole point is that the link is followed
          // from somewhere else (a DM, a post, an email), and Strict would
          // withhold the cookie on exactly that first cross-site navigation.
          sameSite: 'lax',
          secure: request.nextUrl.protocol === 'https:',
          path: '/',
          maxAge: PREVIEW_COOKIE_MAX_AGE,
        });
      }
      // A wrong key redirects too, and lands on /coming-soon like anyone
      // else. Saying "wrong key" would confirm to a guesser that the
      // parameter is real and that they are close.
      return response;
    }

    if (!isPreviewPublic(servedPath)) {
      const hasInvite = await verifyPreviewToken(secret, request.cookies.get(PREVIEW_COOKIE_NAME)?.value);
      if (!hasInvite) {
        // Same reasoning as the age gate below: a fetch() or a props
        // request gets JSON, not a page of HTML that reads as a parse bug.
        const isDataRequest = request.headers.get('x-nextjs-data') === '1';
        if (isDataRequest || pathname.startsWith('/api/')) {
          return new NextResponse(JSON.stringify({ error: 'not_launched_yet' }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        // Rewrite, not redirect: the URL someone was sent stays in their
        // address bar, so it still works the moment they get an invite or
        // the site launches.
        return NextResponse.rewrite(new URL('/coming-soon', request.url));
      }
    }
  }

  if (!isExempt(servedPath)) {
    const country = request.headers.get('x-vercel-ip-country');
    const region = request.headers.get('x-vercel-ip-country-region');
    // Fails CLOSED for US traffic whose state Vercel could not resolve. The
    // region header is optional per IP -- some carrier, VPN and IPv6 ranges
    // geolocate to the country only -- and BLOCKED_STATE_CODES.has(null) is
    // false, so a visitor in Texas with no region header used to be served
    // the whole site with no check at all. An unknown state now gets the
    // same gate as a blocked one; /blocked-region sends them to /verify-age,
    // so this costs a real adult one verification, not access.
    //
    // A MISSING COUNTRY is deliberately not treated the same way: no geo
    // headers at all means the request did not come through Vercel's edge
    // (local dev, tests), and gating those would gate everything.
    if (country === 'US' && (!region || BLOCKED_STATE_CODES.has(region))) {
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
// framework assets (never content) are excluded outright. The other public
// plumbing files (robots.txt, sitemap.xml, manifest.json, apple-touch-icon)
// DO run through here and are exempted by exact path in PUBLIC_STATIC_FILES,
// not by widening this matcher. Media and token-gate APIs (/api/media/,
// /api/token-gate/) are deliberately NOT exempt: they serve creator content
// and stay behind the age gate like every other /api route. api/ and
// _next/data/ deliberately DO run through the proxy: both serve the same
// data the pages do, and the routes that must stay reachable from a blocked
// state are exempted by path above, not by skipping the check entirely.
export const config = {
  matcher: ['/((?!_next/(?!data/)|favicon|icons/).*)'],
};
