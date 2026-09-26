import Head from 'next/head';
import SiteNav from '../components/SiteNav';

/**
 * 18 U.S.C. §2257 / §2257A statement.
 *
 * The custodian's name and a physical business address are what the
 * regulation actually requires be posted, and they are real-world facts
 * about the operating entity rather than something this file can invent.
 * They come from env so they can be filled in the moment the LLC exists,
 * with no code change:
 *
 *   RECORDS_CUSTODIAN_NAME     e.g. "Jane Doe, Custodian of Records"
 *   RECORDS_CUSTODIAN_ADDRESS  the registered business address, one line
 *                              per line break
 *
 * Until both are set the page says plainly that the designation is being
 * completed, rather than printing a half-statement that reads as compliant
 * and is not. Same pattern as AgeChecker before its credentials existed.
 *
 * The records themselves live in the admin panel -- see
 * lib/performer-records-store.js.
 *
 * The creator record-keeping obligation cited below is Terms Section 4
 * (id="records" in pages/terms.js). It did not exist when this page first
 * cited it; if that clause moves or is reworded, this link has to follow.
 */
const CUSTODIAN_NAME = process.env.NEXT_PUBLIC_RECORDS_CUSTODIAN_NAME || '';
const CUSTODIAN_ADDRESS = process.env.NEXT_PUBLIC_RECORDS_CUSTODIAN_ADDRESS || '';

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
          <p className="text-xs text-gray-500 mb-8">Last updated 2026-09-25</p>

          <div className="space-y-6 text-sm text-gray-300 leading-relaxed">
            <p>
              All models, actors, actresses and other persons appearing in any visual depiction of
              actual or simulated sexually explicit conduct on this Platform were over the age of
              eighteen (18) years at the time the depiction was created.
            </p>

            <p>
              Content on this Platform is uploaded by its creators, and each creator is the producer
              of their own content. Section 4 of our{' '}
              <a href="/terms#records" className="text-brand-pink hover:underline">Terms of Service</a>{' '}
              requires every creator to create and keep the records §2257 asks of a producer and to
              produce them on request.
            </p>
            <p>
              In addition, and regardless of how that obligation is allocated, OnlyOne keeps its own
              record for each creator — legal name, date of birth, every name they have worked under,
              a copy of a government-issued photo identification (stored with the record, or held by
              the custodian outside the Platform), and where their content appears. A creator account
              cannot be approved until that record exists with the ID copy on file.
            </p>
            <p>
              Every upload asks whether anyone besides the creator appears in it. Creators cannot
              publish content showing another person themselves: such content is added only by our
              team, and only after a record of the same kind exists for every other person shown.
            </p>
            <p>
              These records are kept for at least seven years from when each record was created or last
              amended, and are indexed so that a record can be found from any name the performer uses
              or any URL on which the content appears. The performer&apos;s legal name, date of birth,
              ID number and ID copy are encrypted at rest; the stage names and content URLs the index is
              searched by are not. The records are accessible only to the records custodian and
              authorized administrators of the Platform.
            </p>

            <p>
              Creators must be 18 or older to hold a creator account, and every creator profile is
              reviewed by our team before it is published. Fans in US states with an enacted
              age-verification law must pass identity-based age verification before they can enter
              the Platform.
            </p>

            <h2 className="text-lg font-bold text-white pt-4">Records Custodian</h2>
            {CUSTODIAN_NAME && CUSTODIAN_ADDRESS ? (
              <>
                <p>
                  The records required by 18 U.S.C. §2257 and 28 C.F.R. §75 for content appearing on
                  this Platform are kept by the Custodian of Records at the address below, and are
                  available for inspection as the regulations provide.
                </p>
                <p className="whitespace-pre-line rounded-lg border border-white/10 bg-black/30 p-4 not-italic">
                  {CUSTODIAN_NAME}
                  {'\n'}
                  {CUSTODIAN_ADDRESS}
                </p>
              </>
            ) : (
              <p>
                The Custodian of Records designation for this Platform is being completed. Until it
                is posted here, requests relating to records maintained under 18 U.S.C. §2257 should
                be directed in writing to{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-pink hover:underline">team@onlyone1.fun</a>.
              </p>
            )}

            <h2 className="text-lg font-bold text-white pt-4">Reporting</h2>
            <p>
              If you believe any content on this Platform depicts a minor, or depicts anyone who did
              not consent to it, report it immediately using our{' '}
              <a href="/report-content" className="text-red-400 hover:underline font-semibold">takedown form</a>.
              You do not need an account, and you do not need to be the person shown: choose
              &quot;I believe this content shows someone under 18&quot; (or the option for reporting
              someone else) and you are asked only for a good-faith statement. Reports of a possible
              minor are reviewed ahead of everything else; confirmed content is removed, the account is
              banned, and it is reported to the National Center for Missing &amp; Exploited Children.
              If a child is in immediate danger, contact law enforcement; you can also report directly
              to the NCMEC CyberTipline at{' '}
              <a href="https://report.cybertip.org" className="text-red-400 hover:underline" rel="noopener noreferrer" target="_blank">report.cybertip.org</a>.
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
