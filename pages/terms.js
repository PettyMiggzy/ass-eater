import Head from 'next/head';

const LAST_UPDATED = 'September 15, 2026';

export default function Terms() {
  return (
    <>
      <Head><title>Terms of Service - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl font-black premium-title mb-2">Terms of Service & User Agreement</h1>
          <p className="text-gray-500 text-sm mb-10">Last updated: {LAST_UPDATED}</p>

          <div className="premium-card p-8 space-y-8 text-sm text-gray-300 leading-relaxed">
            <Section title="1. Age & Eligibility">
              <p>
                Only Ass ("the Platform") is strictly for adults. By creating an account you represent and
                warrant that you are at least 18 years old (or the age of majority in your jurisdiction,
                whichever is higher), and that you have the legal capacity to enter into this agreement.
                We do not knowingly permit anyone under 18 to register, and any account found to belong to
                a minor will be terminated immediately and reported as required by law.
              </p>
            </Section>

            <Section title="2. Nature of the Platform">
              <p>
                The Platform hosts adult content created and uploaded by independent creators, and is
                token-gated using the $ONLYASS cryptocurrency. By using the Platform you acknowledge you
                will encounter sexually explicit and mature content, and that such content is intended
                solely for consenting adults.
              </p>
            </Section>

            <Section title="3. Accounts">
              <p>
                You may register as a <strong>Fan</strong> (to browse and unlock creator content) or a{' '}
                <strong>Creator</strong> (to publish and sell your own content). Creator accounts are
                reviewed before becoming publicly visible; we may require identity and age verification
                before approving a creator profile. You are responsible for maintaining the confidentiality
                of your login credentials and for all activity under your account.
              </p>
            </Section>

            <Section title="4. Creator Content & Licensing">
              <ul className="list-disc pl-5 space-y-2">
                <li>Creators retain ownership of the content they upload.</li>
                <li>
                  By uploading content, a Creator grants the Platform a non-exclusive, worldwide license to
                  host, display, and distribute that content to Fans who have paid to unlock it.
                </li>
                <li>
                  Creators represent and warrant that they own or have all necessary rights to the content
                  they upload, and that everyone depicted is a consenting adult who has authorized its
                  publication.
                </li>
                <li>
                  <strong>Zero tolerance:</strong> content depicting minors, non-consensual acts, or any
                  illegal activity is strictly prohibited and will result in immediate account termination
                  and referral to law enforcement.
                </li>
              </ul>
            </Section>

            <Section title="5. Payments">
              <p>
                Content on the Platform is unlocked using cryptocurrency payments (ETH or $ONLYASS), sent
                directly from a Fan's wallet to a Creator's wallet, with a platform fee (currently 10%) sent
                separately to the Platform's wallet. These are peer-to-peer blockchain transactions — the
                Platform does not hold, custody, or have the ability to reverse funds once a transaction is
                confirmed on-chain.
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>All payments are final. There are no refunds for completed on-chain transactions.</li>
                <li>
                  You are solely responsible for the security of your own wallet, private keys, and seed
                  phrases. The Platform never has access to your private keys and cannot recover lost or
                  stolen funds.
                </li>
                <li>
                  Cryptocurrency values are volatile. The Platform makes no representation about the value,
                  liquidity, or future price of $ONLYASS or any other token.
                </li>
                <li>
                  You are responsible for any network/gas fees and for complying with tax obligations
                  arising from your transactions.
                </li>
              </ul>
            </Section>

            <Section title="6. Marketplace Purchases" id="marketplace">
              <p>
                The Platform's Marketplace lets Creators list and sell their own digital content and
                physical merchandise directly to Fans, at whatever price the Creator sets. A Marketplace
                purchase is an agreement <strong>directly between the buying Fan and the selling Creator</strong>.
                The Platform is not a party to that sale, does not manufacture, own, warehouse, inspect, or
                take possession of anything sold, and acts solely as a payment processor collecting its
                listing/commission fees.
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
                  Marketplace purchases are paid to the Creator at the time of sale and are final. The
                  Platform does not hold funds in escrow, does not guarantee delivery, and has no
                  obligation to investigate, mediate, arbitrate, or resolve a dispute between a Fan and a
                  Creator, or to issue a refund on a Creator's behalf.
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

            <Section title="7. Prohibited Conduct">
              <ul className="list-disc pl-5 space-y-2">
                <li>Uploading illegal content, or content involving minors or non-consenting individuals.</li>
                <li>Harassment, threats, or impersonation of another person or creator.</li>
                <li>Attempting to defraud, chargeback, or reverse a completed on-chain payment.</li>
                <li>Scraping, redistributing, or reselling content without the creator's authorization.</li>
                <li>Circumventing the Platform's payment or age-verification systems.</li>
              </ul>
            </Section>

            <Section title="8. Content Removal & DMCA">
              <p>
                If you believe content on the Platform infringes your copyright, contact us with the
                details of the material and your ownership claim, and we will investigate and remove
                infringing content where warranted.
              </p>
            </Section>

            <Section title="9. Termination">
              <p>
                We may suspend or terminate any account, at any time, for violating these Terms, engaging
                in illegal activity, or for any other reason at our discretion. You may close your account
                at any time; outstanding on-chain transactions cannot be reversed by account closure.
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
              <p>Questions about these Terms can be directed to the Platform's support contact.</p>
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
