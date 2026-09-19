import Head from 'next/head';

// Served by proxy.js's rewrite when a visitor's US state has an enacted
// age-verification law (see BLOCKED_STATE_CODES there) -- a stopgap until a
// real verification vendor is wired up, at which point this state gets
// removed from the block list rather than this page being deleted.
export default function BlockedRegion() {
  return (
    <>
      <Head>
        <title>Not Yet Available In Your State — OnlyOne</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <div className="max-w-md w-full premium-card p-8 text-center">
          <img src="/images/logo-final.png" alt="OnlyOne" className="h-16 w-auto mx-auto mb-6" />
          <h1 className="text-2xl font-black premium-title mb-3">Not Yet Available In Your State</h1>
          <p className="text-gray-400 text-sm mb-4">
            Your state now requires real identity verification before an adult site can let you in —
            not just an age checkbox. We don't have that live yet, so out of caution we're not
            serving this site to your state until we do.
          </p>
          <p className="text-gray-400 text-sm mb-6">
            We're actively working on adding identity verification and expect to open this back up
            for your state soon.
          </p>
          <a href="/verify-age" className="premium-button inline-block w-full mb-3">
            Verify Your Age
          </a>
        </div>
      </div>
    </>
  );
}
