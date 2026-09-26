import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Lockup } from '../components/Brand';
import { safeRedirectPath } from '../lib/safe-redirect';

// AgeChecker.Net's client widget is documented for a checkout button, not a
// site-entry gate -- adapted here by pointing it at this page's own button.
// See lib/age-verification.js + pages/api/age-verify/confirm.js for why the
// client-side "accepted" callback alone isn't trusted to unlock the gate.
const API_KEY = process.env.NEXT_PUBLIC_AGECHECKER_KEY;
const POPUP_SRC = 'https://cdn.agechecker.net/static/popup/v1/popup.js';

// The minimum age the AgeChecker.Net account is configured to accept. It is
// set to 21+ in the account dashboard (stricter than the site's 18+ rule
// elsewhere -- see MEMORY.md, 2026-09-17), so an 18-20 year old is refused by
// the check even where they are a legal adult. The page states the bar the
// check actually applies. If the account setting changes, change this.
const VERIFIED_MIN_AGE = 21;

// Where to go once verified: back to the page the visitor was trying to open
// (/blocked-region passes it as ?next=), through safeRedirectPath so only a
// same-origin path is ever followed. Never back to a gate page (a loop).
// With no ?next= it falls back to /home, the browse page. next=/ IS honoured:
// /blocked-region only ever sends it from a host whose root proxy.js serves
// as a gated page (shoponeonly.com / onlyass.shop -> /marketplace), and going
// back to '/' there is going back to the shop.
function afterVerifyPath(search) {
  let next = null;
  try {
    next = new URLSearchParams(typeof search === 'string' ? search : '').get('next');
  } catch {
    next = null;
  }
  const path = safeRedirectPath(next, '/home');
  const pathname = path.split(/[?#]/)[0];
  if (pathname === '/blocked-region' || pathname === '/verify-age') return '/home';
  return path;
}

export default function VerifyAge() {
  const router = useRouter();
  const [status, setStatus] = useState('idle'); // idle | verifying | error
  const [error, setError] = useState('');
  // The Pages Router hands out a NEW router object on re-renders (e.g. the
  // query-hydration replace for /verify-age?next=...), so the widget setup
  // must not depend on it: it would tear down and inject popup.js a second
  // time (round-21 legal-journeys#0). The latest router lives in a ref, and
  // the uuid of the verification in progress in another, so one setup per
  // mount serves every render.
  const routerRef = useRef(router);
  routerRef.current = router;
  const verificationUuid = useRef(null);

  useEffect(() => {
    if (!API_KEY) return undefined;

    verificationUuid.current = null;

    window.AgeCheckerConfig = {
      element: '#verify-age-btn',
      key: API_KEY,
      oncreated: function (verification) {
        verificationUuid.current = verification?.uuid || null;
      },
      onclosed: function (done) {
        (async () => {
          // This fires on ANY close, including the visitor simply backing
          // out. With no verification started there is nothing to confirm,
          // and posting anyway showed them a red error for cancelling.
          if (!verificationUuid.current) {
            setStatus('idle');
            setError('');
            if (typeof done === 'function') done();
            return;
          }
          setStatus('verifying');
          setError('');
          try {
            const res = await fetch('/api/age-verify/confirm', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ uuid: verificationUuid.current }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
              const base = typeof data.error === 'string' && data.error ? data.error : 'Verification could not be confirmed.';
              // A denial ("not accepted") is most often the age bar itself;
              // say what it is. AgeChecker's own status/reason is never shown.
              const denied = data.code === 'not_accepted' || base === 'Age verification was not accepted.';
              throw new Error(denied
                ? `${base} This check requires you to be ${VERIFIED_MIN_AGE} or older.`
                : base);
            }
            const destination = afterVerifyPath(window.location.search);
            // A host root is whatever proxy.js rewrites it to on THIS host
            // (the marketplace on the shop domains), so load it as a real
            // request rather than a client-side transition to the index page.
            if (destination.split(/[?#]/)[0] === '/') window.location.assign(destination);
            else routerRef.current.push(destination);
          } catch (err) {
            setStatus('error');
            setError(err.message);
            // Cleared so backing out of a retry isn't confirmed against the
            // same spent uuid.
            verificationUuid.current = null;
          } finally {
            if (typeof done === 'function') done();
          }
        })();
      },
    };

    // Never a second copy: popup.js binds to #verify-age-btn when it runs,
    // and two copies would open two sessions for one click.
    if (document.querySelector(`script[src="${POPUP_SRC}"]`)) return undefined;
    const script = document.createElement('script');
    script.src = POPUP_SRC;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      window.location.href = 'https://agechecker.net/loaderror';
    };
    document.head.insertBefore(script, document.head.firstChild);

    return () => {
      script.remove();
    };
  }, []);

  return (
    <>
      <Head>
        <title>Verify Your Age — OnlyOne</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <noscript>
          <meta httpEquiv="refresh" content="0;url=https://agechecker.net/noscript" />
        </noscript>
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white flex flex-col items-center justify-center px-6 py-10">
        <div className="max-w-md w-full premium-card p-8 text-center">
          <Lockup className="h-12 justify-center mb-6" />
          <h1 className="text-2xl font-black premium-title mb-3">Verify Your Age</h1>

          {!API_KEY ? (
            <p className="text-gray-400 text-sm">
              Identity verification is still being set up for your location. Please check back soon.
            </p>
          ) : (
            <>
              <p className="text-gray-400 text-sm mb-6">
                Where you are requires real age verification before you can enter. This takes a minute —
                you'll be asked for your details (name, address and date of birth) or a photo ID. This check
                confirms you're {VERIFIED_MIN_AGE} or older.
              </p>
              {status === 'error' && <p className="text-sm text-red-400 mb-4">{error}</p>}
              <button id="verify-age-btn" className="premium-button inline-block w-full" disabled={status === 'verifying'}>
                {status === 'verifying' ? 'Confirming…' : 'Verify Age & Continue'}
              </button>
            </>
          )}
        </div>
        {/* The TAKE IT DOWN Act requires the removal process be clear and
            conspicuous; a victim sent a link to a gated creator page from a
            blocked state lands HERE, so the no-account report form (and the
            legal pages) must be reachable without verifying first. All four
            paths are exempt from the geoblock, the preview gate and the 18+
            notice. */}
        <footer className="mt-6 max-w-md w-full text-center">
          <a href="/report-content" className="inline-block text-sm text-red-400 hover:text-red-300 transition font-semibold mb-3">
            Report Non-Consensual Content
          </a>
          <p className="text-[11px] text-gray-500 mb-3">
            You appear in content here without your consent? Report it — no account or ID needed.
          </p>
          <div className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] text-gray-600">
            <a href="/terms" className="hover:text-brand-pink transition">Terms</a>
            <a href="/privacy" className="hover:text-brand-pink transition">Privacy</a>
            <a href="/2257" className="hover:text-brand-pink transition">18 U.S.C. §2257</a>
          </div>
        </footer>
      </div>
    </>
  );
}
