import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { Lockup } from '../components/Brand';
import { safeRedirectPath } from '../lib/safe-redirect';

// AgeChecker.Net's client widget is documented for a checkout button, not a
// site-entry gate -- adapted here by pointing it at this page's own button.
// See lib/age-verification.js + pages/api/age-verify/confirm.js for why the
// client-side "accepted" callback alone isn't trusted to unlock the gate.
const API_KEY = process.env.NEXT_PUBLIC_AGECHECKER_KEY;

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

  useEffect(() => {
    if (!API_KEY) return;

    let verificationUuid = null;

    window.AgeCheckerConfig = {
      element: '#verify-age-btn',
      key: API_KEY,
      oncreated: function (verification) {
        verificationUuid = verification.uuid;
      },
      onclosed: function (done) {
        (async () => {
          // This fires on ANY close, including the visitor simply backing
          // out. With no verification started there is nothing to confirm,
          // and posting anyway showed them a red error for cancelling.
          if (!verificationUuid) {
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
              body: JSON.stringify({ uuid: verificationUuid }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Verification could not be confirmed');
            const destination = afterVerifyPath(window.location.search);
            // A host root is whatever proxy.js rewrites it to on THIS host
            // (the marketplace on the shop domains), so load it as a real
            // request rather than a client-side transition to the index page.
            if (destination.split(/[?#]/)[0] === '/') window.location.assign(destination);
            else router.push(destination);
          } catch (err) {
            setStatus('error');
            setError(err.message);
            // Cleared so backing out of a retry isn't confirmed against the
            // same spent uuid.
            verificationUuid = null;
          } finally {
            if (typeof done === 'function') done();
          }
        })();
      },
    };

    const script = document.createElement('script');
    script.src = 'https://cdn.agechecker.net/static/popup/v1/popup.js';
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      window.location.href = 'https://agechecker.net/loaderror';
    };
    document.head.insertBefore(script, document.head.firstChild);

    return () => {
      script.remove();
    };
  }, [router]);

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
                you'll be asked for your name, address, and date of birth so we can confirm you're 18+.
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
