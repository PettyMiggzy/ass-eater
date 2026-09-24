import Head from 'next/head';
import {
  PLATFORM_FEE_PCT,
  MARKETPLACE_FEE_PCT,
  LISTING_FEE_PCT,
  CREDIT_PURCHASE_FEE_PCT,
  DM_PRICE_FLOOR_CENTS,
} from '../lib/brand';
import { FEE_WAIVER_DAYS } from '../lib/founding';
import { MIN_PAYOUT_CENTS } from '../lib/fees';

// Bump this on every material change -- Section 11 promises it. Fee figures
// below are interpolated from lib/brand.js (derived from lib/fees.js) so the
// Terms can never quote a rate the code does not charge.
//
// Section 6 is the Marketplace terms a buyer accepts at checkout
// (CURRENT_TOS_VERSION in lib/orders-store.js); a material change to it
// should bump that version too.
const LAST_UPDATED = 'September 24, 2026';
const DM_FLOOR = `$${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)}`;
const MIN_PAYOUT = `$${(MIN_PAYOUT_CENTS / 100).toFixed(2)}`;

export default function Terms() {
  return (
    <>
      <Head><title>Terms of Service - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl font-black premium-title mb-2">Terms of Service & User Agreement</h1>
          <p className="text-gray-500 text-sm mb-10">Last updated: {LAST_UPDATED}</p>

          <div className="premium-card p-8 space-y-8 text-sm text-gray-300 leading-relaxed">
            <Section title="1. Age & Eligibility">
              <p>
                OnlyOne ("the Platform") is strictly for adults. By creating an account you represent and
                warrant that you are at least 18 years old (or the age of majority in your jurisdiction,
                whichever is higher), and that you have the legal capacity to enter into this agreement.
                We do not knowingly permit anyone under 18 to register, and any account found to belong to
                a minor will be terminated immediately and reported as required by law.
              </p>
            </Section>

            <Section title="2. Nature of the Platform">
              <p>
                The Platform hosts adult content created and uploaded by independent creators. By
                using the Platform you acknowledge you
                will encounter sexually explicit and mature content, and that such content is intended
                solely for consenting adults.
              </p>
            </Section>

            <Section title="3. Accounts">
              <p>
                You may register as a <strong>Fan</strong> (to browse creators, message them, and buy
                from the Marketplace) or a <strong>Creator</strong> (to publish and sell your own
                content). Creator accounts are
                reviewed before becoming publicly visible; we may require identity and age verification
                before approving a creator profile. You are responsible for maintaining the confidentiality
                of your login credentials and for all activity under your account.
              </p>
            </Section>

            <Section title="4. Creator Content & Licensing" id="creator-content">
              <ul className="list-disc pl-5 space-y-2">
                <li>Creators retain ownership of the content they upload.</li>
                <li>
                  By uploading content, a Creator grants the Platform a non-exclusive, worldwide license to
                  host, display, and distribute that content to users of the Platform as the Creator makes
                  it available, including to Fans who buy it.
                </li>
                <li>
                  Creators represent and warrant that they own or have all necessary rights to the content
                  they upload, and that everyone depicted is a consenting adult who has authorized its
                  publication.
                </li>
                <li id="records">
                  <strong>18 U.S.C. §2257 records.</strong> A Creator is the producer of the content they
                  upload. For every person appearing in any visual depiction of actual or simulated
                  sexually explicit conduct in that content, the Creator must create and keep the records
                  required of a producer by 18 U.S.C. §2257 and 28 C.F.R. Part 75 (including proof of
                  each performer&apos;s identity and that they were 18 or older when the content was
                  made), and must produce those records to the Platform or its Custodian of Records
                  promptly on request. The Platform also keeps its own records for performers (see our{' '}
                  <a href="/2257" className="text-brand-gold underline">§2257 statement</a>) and may
                  require a Creator to supply a performer&apos;s legal name, date of birth, and
                  government-issued photo ID before content is published or approved. Content for which
                  records are not provided may be removed.
                </li>
                <li>
                  <strong>Zero tolerance:</strong> content depicting minors, non-consensual acts, or any
                  illegal activity is strictly prohibited and will result in immediate account termination
                  and referral to law enforcement.
                </li>
                <li>
                  <strong>AI-generated content must be labeled.</strong> If a photo or video was created or
                  substantially altered using AI (including face-swap or "deepfake" tools), it must be clearly
                  marked as AI-generated when posted.
                </li>
                <li>
                  <strong>Non-consensual AI content is prohibited.</strong> Posting an AI-generated, deepfaked,
                  or face-swapped image or video of a real person who has not consented to it is strictly
                  prohibited, whether or not the underlying image was itself AI-generated. See Section 8 for
                  how to report this kind of content.
                </li>
              </ul>
            </Section>

            <Section title="5. Credits, Fees & Payouts" id="payments">
              <p>
                Fans buy <strong>credits</strong> with a dollar-pegged stablecoin (USDG on Robinhood
                Chain; USDC bridged in converts to USDG automatically), sent from the Fan&apos;s own
                wallet to the Platform&apos;s wallet. One credit is one US dollar, less a{' '}
                <strong>{CREDIT_PURCHASE_FEE_PCT}% purchase fee</strong> — $100 buys 98 credits. Credits are
                a balance the Platform holds and records for you; they are not money, not a
                cryptocurrency, and not an investment.
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>
                  <strong>What credits buy today.</strong> Credits can currently be spent on Marketplace
                  purchases (Section 6) and on paid messages to Creators. Tips and subscriptions are not
                  available yet; do not buy credits expecting to use them for those.
                </li>
                <li>
                  <strong>Paid messages.</strong> A message from a Fan to a Creator costs at least{' '}
                  {DM_FLOOR} in credits; a Creator may set a higher price, which is shown before you send.
                  The charge is taken when the message is sent. Creators can message, free of charge,
                  Fans who have messaged them or bought from them; Fans cannot message other Fans.
                </li>
                <li>
                  <strong>Credits are closed-loop.</strong> Credits you buy can only be spent on this
                  Platform. They cannot be transferred to another person, refunded, or cashed back out —
                  not on request and not when an account closes. Credit purchases are final, and so are
                  purchases made with credits.
                </li>
                <li>
                  Credits do not expire, have no cash value, and confer no ownership, equity, or claim
                  against the Platform other than the right to spend them here.
                </li>
                <li>
                  <strong>Platform fees.</strong> On each sale to a Fan, the Platform keeps a{' '}
                  {PLATFORM_FEE_PCT}% platform fee and credits the rest to the Creator. Marketplace sales
                  carry an additional {LISTING_FEE_PCT}% listing fee, so the Platform keeps{' '}
                  {MARKETPLACE_FEE_PCT}% of a Marketplace sale in total. Creators accepted into the{' '}
                  <a href="/founding-creator" className="text-brand-gold underline">Founding Creator programme</a>{' '}
                  pay no platform fee and no listing fee on what Fans spend with them (Marketplace sales and
                  paid messages) for {FEE_WAIVER_DAYS} days, counted from the later of the day they were
                  accepted into the programme and the day payments went live on the Platform. The{' '}
                  {CREDIT_PURCHASE_FEE_PCT}% credit purchase fee is paid by the Fan and is not part of that
                  waiver.
                </li>
                <li>
                  <strong>Creator payouts.</strong> What a Creator earns from other people&apos;s
                  purchases is credited to the Creator&apos;s balance on the Platform, which the Platform
                  holds until the Creator requests a payout. Only earned credits can be paid out — credits
                  a Creator bought themselves can only be spent here. Payouts are sent only in USDG, to a
                  valid wallet address the Creator provides, with a minimum of {MIN_PAYOUT} per request;
                  every request is reviewed and sent manually by the Platform, so a payout is not
                  instant. Only Creators whose accounts are approved, active and in good standing can
                  request a payout. While an account is suspended or banned its credit balance is
                  frozen — it cannot be spent, sent, or cashed out — and its pending payout requests are
                  frozen too; the Platform may decline a frozen request, which returns the amount to the
                  (still frozen) balance (see Section 7). The Platform is not responsible for funds sent
                  to a wallet address a Creator entered incorrectly.
                </li>
                <li>
                  <strong>$ONLYONE is not a payment method.</strong> It cannot be used to buy credits,
                  pay for anything, or be paid out. It is a separate token offering access and status
                  features only, and the Platform makes no representation about its value, liquidity, or
                  future price.
                </li>
                <li>
                  You are responsible for the security of your own wallet and private keys, for any
                  network/gas fees, and for complying with tax obligations arising from your transactions.
                  On-chain transfers (your credit purchases and Creator payouts) cannot be reversed once
                  confirmed.
                </li>
              </ul>
            </Section>

            <Section title="6. Marketplace Purchases" id="marketplace">
              <p>
                The Platform&apos;s Marketplace lets Creators list and sell their own digital content and
                physical merchandise to Fans, at whatever price the Creator sets, paid for in credits. A
                Marketplace purchase is an agreement <strong>directly between the buying Fan and the
                selling Creator</strong>. The Platform is not a party to that sale and does not
                manufacture, own, warehouse, inspect, or take possession of anything sold; it provides
                the listing and the credits payment, and keeps its fees (Section 5).
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>
                  The Creator is solely responsible for the accuracy of their listing, the condition,
                  authenticity, and legality of what they sell, and — for physical items — for packaging,
                  choice of carrier, shipping cost, delivery timeline, and any tracking or signature
                  confirmation. The Platform has no role in shipping and does not verify that any item was
                  shipped, described accurately, or delivered.
                </li>
                <li>
                  For a physical item, the Fan must give a shipping name and address. That name and
                  address are shared with the selling Creator so they can ship the order (see the{' '}
                  <a href="/privacy" className="text-brand-gold underline">Privacy Policy</a>).
                </li>
                <li>
                  When a purchase completes, its price in credits is taken from the Fan&apos;s balance and
                  the Creator&apos;s share (the price less the fees in Section 5) is credited to the
                  Creator&apos;s Platform balance at that moment, to be paid out on request as Section 5
                  describes. Purchases are final. The Platform does not hold the purchase price pending
                  delivery, does not guarantee delivery, and has no obligation to investigate, mediate,
                  arbitrate, or resolve a dispute between a Fan and a Creator, or to issue a refund on a
                  Creator&apos;s behalf.
                </li>
                <li>
                  Any disagreement about a Marketplace order — including a claim that an item never
                  arrived, arrived damaged, or was not as described — is between the Fan and the Creator to
                  resolve directly. The Platform may, at its sole discretion, suspend or terminate an
                  account for fraud or abuse of the Marketplace (see Section 9, Termination), but doing so
                  is a platform-integrity action, not a dispute resolution service, and creates no
                  entitlement to a refund from the Platform.
                </li>
                <li>
                  Before completing a Marketplace purchase, a Fan must separately confirm they are 18 or
                  older and affirmatively accept this Section — that confirmation is recorded against the
                  specific order.
                </li>
              </ul>
            </Section>

            <Section title="7. Prohibited Conduct" id="prohibited">
              <ul className="list-disc pl-5 space-y-2">
                <li>Uploading illegal content, or content involving minors or non-consenting individuals.</li>
                <li>Harassment, threats, or impersonation of another person or creator.</li>
                <li>Attempting to defraud the Platform or another user, or to reverse a completed payment or purchase.</li>
                <li>Scraping, redistributing, or reselling content without the creator's authorization.</li>
                <li>Circumventing the Platform's payment or age-verification systems.</li>
                <li>Posting AI-generated or synthetic content without labeling it as such.</li>
                <li>Posting a non-consensual deepfake, face-swap, or other AI-altered depiction of a real person.</li>
              </ul>
              <p className="mt-3 text-gray-400">
                Violating any of the above is handled at the Platform's discretion based on the severity and
                nature of the violation, which may include content removal, account suspension or termination,
                forfeiting money owed to you, and cooperating with law enforcement.
              </p>
              <p className="mt-3 text-gray-400">
                For a confirmed violation of the AI-labeling requirement or the non-consensual-content ban
                specifically: a first confirmed violation results in a 30-day account suspension (your profile is
                hidden and you can't post or edit content during that time); a second confirmed violation results
                in a permanent ban. While an account is suspended, its credit balance and pending payout
                requests are frozen: nothing can be spent, sent, or cashed out until the suspension ends. A
                ban freezes them permanently: any earned balance the Platform holds for you that
                hasn&apos;t already been paid out is forfeited, and pending payout requests are not paid.
              </p>
            </Section>

            <Section title="8. Content Removal, DMCA & Non-Consensual Content" id="content-removal">
              <p>
                <strong>Copyright (DMCA) notices.</strong> If you believe content on the Platform infringes
                your copyright, send a written notice to{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-gold underline">team@onlyone1.fun</a>{' '}
                with the subject line &quot;DMCA Notice&quot;. Under 17 U.S.C. §512(c)(3) the notice must include:
              </p>
              <ul className="list-disc pl-5 space-y-1 mt-2">
                <li>your physical or electronic signature (as the owner or someone authorized to act for the owner);</li>
                <li>identification of the copyrighted work you claim is infringed;</li>
                <li>
                  identification of the infringing material and where it is on the Platform (the link to the
                  creator profile or listing is enough);
                </li>
                <li>your name, address, telephone number and email address;</li>
                <li>
                  a statement that you have a good-faith belief the use is not authorized by the copyright owner,
                  its agent, or the law; and
                </li>
                <li>
                  a statement that the information in the notice is accurate and, under penalty of perjury, that
                  you are the owner or authorized to act on the owner&apos;s behalf.
                </li>
              </ul>
              <p className="mt-3">
                We review valid notices, remove or disable access to the material where warranted, and notify the
                person who posted it, who may send a counter-notice to the same address. Accounts that repeatedly
                infringe are terminated. If the content shows <em>you</em> and you did not consent to it, use the
                faster process below instead -- it does not require a copyright claim.
              </p>
              <p className="mt-3">
                <strong>If you appear in content on the Platform that you did not consent to</strong> —
                including a real photo/video of you, or an AI-generated, deepfaked, or face-swapped depiction
                of you — you can report it through our{' '}
                <a href="/report-content" className="text-brand-gold underline">Report Non-Consensual Content</a>{' '}
                form. No account is required to submit a report. We review every report and, where the report
                is valid, remove the content within 48 hours, consistent with the federal TAKE IT DOWN Act. We
                also make reasonable efforts to locate and remove additional known copies of reported content
                on the Platform.
              </p>
            </Section>

            <Section title="9. Termination">
              <p>
                We may suspend or terminate any account, at any time, for violating these Terms, engaging
                in illegal activity, or for any other reason at our discretion. You may close your account
                at any time. Closing an account does not reverse completed transactions and does not turn
                unspent credits into money (Section 5); a Creator in good standing may request a payout of
                their earned balance before closing.
              </p>
            </Section>

            <Section title="10. Disclaimers & Limitation of Liability">
              <p>
                The Platform is provided "as is" without warranties of any kind. To the maximum extent
                permitted by law, the Platform and its operators are not liable for any indirect,
                incidental, or consequential damages, including loss of funds due to user error, wallet
                compromise, smart contract risk, or third-party actions, arising from your use of the
                Platform.
              </p>
            </Section>

            <Section title="11. Changes to These Terms">
              <p>
                We may update these Terms from time to time. Continued use of the Platform after changes
                are posted constitutes acceptance of the revised Terms. Material changes will be reflected
                by an updated "Last updated" date above.
              </p>
            </Section>

            <Section title="12. Contact">
              <p>
                Questions about these Terms can be directed to{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-pink hover:underline">team@onlyone1.fun</a>.
              </p>
            </Section>

            <Section title="13. Complaints" id="complaints">
              <p>
                If you have a complaint about content on the Platform, about a creator, or about how
                we have handled something, email{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-pink hover:underline">team@onlyone1.fun</a>{' '}
                with enough detail to identify what you are referring to — a link, a username, or a
                description. We aim to acknowledge every complaint within 7 days and to tell you the
                outcome once it has been reviewed.
              </p>
              <p className="mt-3">
                Two kinds of complaint have their own faster route and should use it instead:
                content you appear in that you did not consent to goes through{' '}
                <a href="/report-content" className="text-brand-pink hover:underline">our takedown form</a>,
                which carries a 48-hour deadline under the federal TAKE IT DOWN Act; copyright
                complaints are covered in Section 8.
              </p>
            </Section>
          </div>

          <p className="text-xs text-gray-600 mt-8">
            This document is a general template and does not constitute legal advice. It should be
            reviewed by a licensed attorney familiar with adult content platforms and cryptocurrency
            regulations in your operating jurisdiction before public launch.
          </p>
        </div>
      </div>
    </>
  );
}

function Section({ title, id, children }) {
  return (
    <section id={id}>
      <h2 className="text-lg font-bold text-brand-gold mb-2">{title}</h2>
      {children}
    </section>
  );
}
