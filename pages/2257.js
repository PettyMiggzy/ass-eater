import Head from 'next/head';
import SiteNav from '../components/SiteNav';

/**
 * 18 U.S.C. §2257 / §2257A statement.
 *
 * This page exists because the footer linked one and there was none -- the
 * link pointed at /terms, which has no such section. A missing statement and
 * a link that lies about having one are both problems; this fixes the second
 * and gives the first somewhere real to live.
 *
 * INCOMPLETE UNTIL THE CUSTODIAN BLOCK IS FILLED IN. The regulation requires
 * the records custodian's name and a physical business address to be posted.
 * That is a real-world fact about the operating entity, not something that
 * can be written here, so it is stated as a request contact and flagged to
 * the operator. Processors (CCBill, Segpay, Epoch, Vendo) check for this page
 * during onboarding.
 */
export default function Statement2257() {
  return (
    <>
      <Head>
        <title>18 U.S.C. §2257 Statement — OnlyOne</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav />
        <div className="max-w-3xl mx-auto px-6 py-14">
          <h1 className="text-3xl font-black premium-title mb-2">18 U.S.C. §2257 Statement</h1>
          <p className="text-xs text-gray-500 mb-8">Last updated 2026-09-19</p>

          <div className="space-y-6 text-sm text-gray-300 leading-relaxed">
            <p>
              All models, actors, actresses and other persons appearing in any visual depiction of
              actual or simulated sexually explicit conduct on this Platform were over the age of
              eighteen (18) years at the time the depiction was created.
            </p>

            <p>
              OnlyOne is an online service provider as described in 47 U.S.C. §230(c). Content on
              this Platform is uploaded by its users. With respect to that content, OnlyOne acts as
              a provider of a computer service and not as a producer as defined in 18 U.S.C. §2257
              and 28 C.F.R. §75. Each creator who uploads content to this Platform is the producer
              of that content and is required, by our{' '}
              <a href="/terms" className="text-brand-pink hover:underline">Terms of Service</a>, to
              create and keep the records that §2257 requires of a producer, and to be able to
              produce them on request.
            </p>

            <p>
              Creators must be 18 or older to hold a creator account, and every creator profile is
              reviewed by our team before it is published. Fans in US states with an enacted
              age-verification law must pass identity-based age verification before they can enter
              the Platform.
            </p>

            <h2 className="text-lg font-bold text-white pt-4">Records Custodian</h2>
            <p>
              Requests relating to records maintained under 18 U.S.C. §2257 for content on this
              Platform should be directed in writing to{' '}
              <a href="mailto:team@onlyone1.fun" className="text-brand-pink hover:underline">team@onlyone1.fun</a>,
              which will provide the custodian of records&apos; name and the physical address at
              which those records are maintained.
            </p>

            <h2 className="text-lg font-bold text-white pt-4">Reporting</h2>
            <p>
              If you believe any content on this Platform depicts a minor, or depicts anyone who did
              not consent to it, report it immediately using our{' '}
              <a href="/report-content" className="text-red-400 hover:underline font-semibold">takedown form</a>.
              You do not need an account to file a report, and reports of this kind are reviewed
              ahead of everything else.
            </p>
          </div>

          <p className="text-xs text-gray-600 mt-10">
            This document is a general template and does not constitute legal advice. It should be
            reviewed by a licensed attorney familiar with adult content platforms before public
            launch, and the records-custodian designation above must be completed with the
            operating entity&apos;s name and physical business address.
          </p>
        </div>
      </div>
    </>
  );
}
