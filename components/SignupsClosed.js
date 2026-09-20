import Head from 'next/head';
import SiteNav from './SiteNav';
import { Mark } from './Brand';
import WaitlistForm from './WaitlistForm';

/**
 * Shown in place of the signup and become-a-creator forms while
 * SIGNUPS_OPEN is not set (see lib/signups.js).
 *
 * It says plainly that signups are not open and offers the waitlist, rather
 * than hiding the page or 404ing it. Two reasons: someone who followed a
 * link here wanted an account, so the useful thing is to capture them; and
 * a visible closed state is what makes it safe for lib/signups.js to
 * default to closed -- a misconfiguration shows up as this page rather than
 * as a form that silently rejects everyone.
 */
export default function SignupsClosed({
  title = 'Signups Open Soon — OnlyOne',
  heading = 'Signups aren’t open yet',
  body = 'OnlyOne is live to browse, but we’re not taking new accounts just yet. Leave your email and we’ll tell you the moment we are.',
  defaultRole = 'fan',
  source = 'signups-closed',
}) {
  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Nothing to index while it says this. */}
        <meta name="robots" content="noindex" />
      </Head>

      <div className="min-h-screen bg-brand-ink text-white flex flex-col">
        <SiteNav />

        <main className="flex-1 flex flex-col items-center justify-center text-center px-6 py-16">
          <Mark className="h-14 w-auto text-brand-pink mb-6 drop-shadow-[0_0_28px_rgba(255,45,120,0.35)]" />
          <h1 className="text-2xl sm:text-3xl font-black premium-title">{heading}</h1>
          <p className="mt-4 max-w-md text-sm text-gray-400 leading-relaxed">{body}</p>

          <div className="mt-10 w-full flex justify-center">
            <WaitlistForm
              source={source}
              defaultRole={defaultRole}
              title="TELL ME WHEN SIGNUPS OPEN"
              blurb="One email, when accounts go live. Nothing else."
            />
          </div>

          <div className="mt-10 flex flex-wrap justify-center gap-x-5 gap-y-2 text-[11px] tracking-[0.2em] text-gray-500">
            <a href="/home" className="hover:text-brand-pink transition">BROWSE CREATORS</a>
            <a href="/founding-creator" className="hover:text-brand-pink transition">CREATOR PROGRAMME</a>
            {/* Login stays open -- anyone who already has an account keeps it. */}
            <a href="/login" className="hover:text-brand-pink transition">ALREADY HAVE AN ACCOUNT?</a>
          </div>
        </main>
      </div>
    </>
  );
}
