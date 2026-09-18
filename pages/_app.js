import '../styles/globals.css';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { captureReferralFromQuery } from '../lib/referral';

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
const NO_NOTICE_PATHS = new Set(['/', '/founding-creator', '/report-content', '/blocked-region', '/verify-age']);

function MyApp({ Component, pageProps }) {
  const router = useRouter();
  const [isVerified, setIsVerified] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  // A creator's ?ref= is stashed on whatever page it arrives at, so it
  // survives someone browsing for a while before they sign up.
  useEffect(() => {
    captureReferralFromQuery(router.query);
  }, [router.query]);

  useEffect(() => {
    const verified = localStorage.getItem('ass-eater-verified');
    if (verified === 'true') {
      setIsVerified(true);
    }
    setIsLoading(false);
  }, []);

  if (NO_NOTICE_PATHS.has(router.pathname)) {
    return <Component {...pageProps} />;
  }

  if (isLoading) return null;

  if (!isVerified) {
    return <AgeGate onVerify={() => {
      localStorage.setItem('ass-eater-verified', 'true');
      setIsVerified(true);
    }} />;
  }

  return <Component {...pageProps} />;
}

function AgeGate({ onVerify }) {
  const [accepted, setAccepted] = useState(false);

  return (
    <div className="min-h-screen bg-brand-dark flex items-center justify-center">
      <div className="max-w-md w-full bg-gray-900 rounded-lg p-8 border border-brand-primary">
        <h1 className="text-3xl font-bold text-brand-primary mb-6 text-center">
          ⚠️ Content Warning
        </h1>

        <div className="space-y-4 mb-8">
          <p className="text-gray-300">
            This website contains adult content (NSFW). You must be at least 18 years old to proceed.
          </p>
          <p className="text-sm text-gray-400">
            By clicking "I'm 18+", you confirm that:
          </p>
          <ul className="text-sm text-gray-400 list-disc list-inside space-y-2">
            <li>You are at least 18 years of age</li>
            <li>This content is legal in your jurisdiction</li>
            <li>You accept responsibility for your viewing</li>
          </ul>
        </div>

        <div className="space-y-3">
          <label className="flex items-center space-x-3 cursor-pointer">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="w-4 h-4"
            />
            <span className="text-sm text-gray-300">I am 18 years or older</span>
          </label>

          <button
            onClick={onVerify}
            disabled={!accepted}
            className="w-full bg-brand-primary hover:bg-brand-secondary disabled:bg-gray-600 disabled:cursor-not-allowed text-black font-bold py-3 px-4 rounded-lg transition"
          >
            I'm 18+ - Continue
          </button>

          <button
            onClick={() => window.close()}
            className="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-4 rounded-lg transition"
          >
            Exit
          </button>
        </div>

        <p className="text-xs text-gray-500 text-center mt-6">
          This verification is stored locally and can be cleared by deleting browser data.
        </p>
      </div>
    </div>
  );
}

export default MyApp;
