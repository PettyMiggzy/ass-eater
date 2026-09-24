import Head from 'next/head';
import { Lockup } from '../components/Brand';
import WaitlistForm from '../components/WaitlistForm';

// Served by proxy.js's rewrite when a visitor's US state has an enacted
// age-verification law (see BLOCKED_STATE_CODES there), or when Vercel could
// not tell which state they are in (the gate fails closed). Real
// verification IS live -- the button below is the AgeChecker flow on
// /verify-age -- so this page says so plainly. It used to say verification
// "isn't live yet" directly above the button that is the verification,
// which sent verifiable adults away.
export default function BlockedRegion() {
  return (
    <>
      <Head>
        <title>Age Verification Required — OnlyOne</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <div className="max-w-md w-full premium-card p-8 text-center">
          <Lockup className="h-12 justify-center mb-6" />
          <h1 className="text-2xl font-black premium-title mb-3">Verify Your Age to Continue</h1>
          <p className="text-gray-400 text-sm mb-4">
            Your state requires identity-based age verification before an adult site can let you
            in — not just an age checkbox. (If we couldn&apos;t tell which state you&apos;re in, we
            ask for the same check, to be safe.)
          </p>
          <p className="text-gray-400 text-sm mb-6">
            Verify once — it takes about a minute — and you&apos;re in on this browser.
          </p>
          <a href="/verify-age" className="premium-button inline-block w-full mb-3">
            Verify Your Age
          </a>

          {/* Without this, a visitor from one of the 27 blocked states hits a
              wall and is gone. Their state is recorded with the signup (read
              server-side off Vercel's edge headers, not from the form), so
              when a state comes off BLOCKED_STATE_CODES in proxy.js the
              people it kept out are exactly who can be told first. */}
          <div className="mt-6 pt-6 border-t border-white/10 flex justify-center">
            <WaitlistForm
              source="blocked-region"
              title="NOT READY TO VERIFY?"
              blurb="Leave your email and we’ll keep you posted — including if your state’s rules change."
            />
          </div>
        </div>
      </div>
    </>
  );
}
