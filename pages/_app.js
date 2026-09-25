import '../styles/globals.css';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { captureReferralFromQuery } from '../lib/referral';
import { Lockup } from '../components/Brand';
import { CartProvider } from '../lib/cart';

/**
 * Pages this 18+ notice must NOT cover.
 *
 * This gate is a localStorage self-attestation -- it is not the real age
 * check (that is AgeChecker, via proxy.js), it is the "this site contains
 * adult content" notice. It was previously applied to every route, which
 * had two real costs:
 *
 *  - It hid /report-content, the non-consensual-content takedown form,
 *    behind a click and rendered it as a blank page with JavaScript off.
 *    The TAKE IT DOWN Act requires that process be clearly available, and
 *    proxy.js already exempts the same path from the state block for
 *    exactly this reason -- the two exemptions have to agree.
 *  - It covered the public landing page, which exists so that someone who
 *    has not verified anything can see what this site is. A notice in
 *    front of a page that shows nothing explicit is a notice in front of
 *    nothing. /founding-creator is the same case: a recruitment page with
 *    no content on it, which also has to survive being pasted into a link
 *    preview -- and note that this gate returns null during the first
 *    render, so any page it covers serves an EMPTY document to anything
 *    that doesn't run JavaScript. For a page whose entire job is to be
 *    shared, that alone settles it.
 *
 * Everything else still gets it.
 */
//  - The legal pages (/terms, /privacy, /2257) are text and nothing else.
//    They carry the same "no content on them" property as "/" and they have
//    to be readable by people and tools that are NOT visitors: a payment
//    processor doing onboarding review, a regulator checking the §2257
//    statement, an archiver. proxy.js already exempts all three from the
//    state geoblock for exactly that reason, and leaving them behind this
//    notice undid it -- because of the return-null-on-first-render above,
//    /2257 and /terms were serving a 2.4KB EMPTY DOCUMENT to anything that
//    doesn't run JavaScript. The two exemptions have to agree, the same way
//    /report-content's already do.
// A page exempted from the state age gate in proxy.js MUST also be listed
// here, and vice versa. The notice below return-nulls on its first render,
// so a page exempted from one and not the other serves an EMPTY document --
// which looks like nothing is wrong. That has already happened once, to
// /terms and /2257, silently undoing an exemption they had been given hours
// earlier. Change the two lists together.
const NO_NOTICE_PATHS = new Set([
  '/', '/coming-soon', '/founding-creator', '/report-content', '/blocked-region', '/verify-age',
  '/terms', '/privacy', '/2257', '/owner',
  // /gateway (onlyass.online's SFW landing) and /token (onlyass.xyz's) are
  // both exempt from proxy.js's state geoblock (SFW_PATHS) specifically
  // because they show no adult content -- but they were never added here,
  // so every visitor got this generic 18+ modal in front of a page that was
  // built and exempted to NOT need one, and any non-JS client (a crawler, an
  // exchange-listing bot) got the blank document instead of the page at all.
  // Exactly the failure this comment already warns about, just in two spots
  // nobody had gotten to yet.
  '/gateway', '/token',
  // /get-crypto: the wallet setup guide /token links to. No creator content;
  // exempt in proxy.js SFW_PATHS and PREVIEW_PUBLIC_PATHS in the same change.
  '/get-crypto',
]);

function MyApp({ Component, pageProps }) {
  const router = useRouter();
  const [isVerified, setIsVerified] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // A creator's ?ref= is stashed on whatever page it arrives at, so it
  // survives someone browsing for a while before they sign up.
  useEffect(() => {
    captureReferralFromQuery(router.query);
  }, [router.query]);

  // Browser storage can throw (site data blocked, DOM storage disabled in a
  // webview, quota errors in private modes). An unguarded read here threw
  // during commit and replaced every page with Next's "Application error";
  // an unguarded write made "Enter" do nothing. A storage failure means "not
  // yet acknowledged" on read, and "acknowledged for this session" on write.
  // This is the 18+ content notice, not the real age gate (proxy.js).
  useEffect(() => {
    try {
      if (window.localStorage.getItem('onlyone-age-notice') === 'true') setIsVerified(true);
    } catch {
      // treat as not yet acknowledged
    }
    setIsLoading(false);
  }, []);

  if (NO_NOTICE_PATHS.has(router.pathname)) {
    return (
      <CartProvider>
        <Component {...pageProps} />
      </CartProvider>
    );
  }

  if (isLoading) return null;

  if (!isVerified) {
    return <AgeGate onVerify={() => {
      try {
        window.localStorage.setItem('onlyone-age-notice', 'true');
      } catch {
        // could not persist -- dismissed for this session only
      }
      setIsVerified(true);
    }} />;
  }

  return (
    <CartProvider>
      <Component {...pageProps} />
    </CartProvider>
  );
}

function AgeGate({ onVerify }) {
  const [accepted, setAccepted] = useState(false);

  return (
    <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
      <div className="max-w-md w-full premium-card p-8">
        <Lockup className="h-11 justify-center mb-6" />

        <h1 className="text-2xl font-black premium-title text-center mb-4">18+ Adult Content</h1>

        <div className="space-y-3 mb-6 text-center">
          <p className="text-gray-300 text-sm">
            OnlyOne is an adult creator platform. You must be at least 18 to continue.
          </p>
        </div>

        <ul className="text-sm text-gray-400 space-y-2 mb-6">
          {[
            'You are at least 18 years of age',
            'Adult content is legal where you are',
            'You accept responsibility for what you view',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2">
              <span className="text-brand-pink mt-0.5">&bull;</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <label className="flex items-center gap-3 cursor-pointer mb-4">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="w-4 h-4 accent-brand-pink"
          />
          <span className="text-sm text-gray-300">I am 18 years or older</span>
        </label>

        <button
          onClick={onVerify}
          disabled={!accepted}
          className="w-full premium-button disabled:opacity-40 disabled:cursor-not-allowed mb-3"
        >
          Enter OnlyOne
        </button>

        {/* Goes to the SFW landing page. This used to call window.close(),
            which does nothing in a normally-opened tab -- so the one control
            offered to someone who is NOT 18 was the one that did nothing. */}
        <a
          href="/"
          className="block w-full text-center py-3 rounded-full border border-white/15 text-gray-300 hover:border-white/40 transition text-sm font-semibold"
        >
          Leave
        </a>

        <p className="text-xs text-gray-600 text-center mt-6">
          This is a content notice, not identity verification. Where your state requires a real age
          check, you will be asked for one separately. Your answer here is stored in this browser
          only.
        </p>
      </div>
    </div>
  );
}

export default MyApp;
