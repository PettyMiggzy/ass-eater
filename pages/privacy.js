import Head from 'next/head';

// Bump on every material change -- Section 10 promises it. This policy has to
// describe what the code actually collects and sets; when a feature adds a
// field, a cookie, or a new recipient of someone's data, this file changes
// in the same release.
const LAST_UPDATED = 'September 26, 2026';

export default function Privacy() {
  return (
    <>
      <Head><title>Privacy Policy - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl font-black premium-title mb-2">Privacy Policy</h1>
          <p className="text-gray-500 text-sm mb-10">Last updated: {LAST_UPDATED}</p>

          <div className="premium-card p-8 space-y-8 text-sm text-gray-300 leading-relaxed">
            <Section title="1. What We Collect">
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong>Account info.</strong> A password, and either an email address or a username you
                  choose — see Section 2, Fan Anonymity.
                </li>
                <li>
                  <strong>Creator profile info.</strong> What a creator puts on their own profile —
                  display name, handle, bio, tags, age and location (if given), avatar, social links,
                  message price, and a payout wallet address.
                </li>
                <li id="performer-records">
                  <strong>Performer records (18 U.S.C. §2257).</strong> For every person who appears in
                  sexually explicit content on the Platform, we keep the records federal law requires
                  (18 U.S.C. §2257 and 28 C.F.R. Part 75): the performer&apos;s legal name, date of
                  birth, government ID number, a copy of their government-issued photo ID, every name
                  they have performed under, the date the content was produced, and where it appears on
                  the Platform. We collect these to confirm every performer was an adult and to meet our
                  record-keeping obligations — for no other purpose. The legal name, date of birth, ID
                  number, and ID image are encrypted at rest, and the records are accessible only to the
                  Platform&apos;s records custodian and administrators. See our{' '}
                  <a href="/2257" className="text-brand-gold underline">§2257 statement</a> and Section 7
                  for how long they are kept.
                </li>
                <li>
                  <strong>Fan age-verification info.</strong> Some states now require real age verification
                  (not just a checkbox) before an adult site can let a visitor in. Where that applies, we
                  use a third-party age-verification vendor to confirm you're of legal age — see Section 6.
                  That vendor handles whatever information their verification method requires (e.g., a
                  government-issued ID or a database match) under their own privacy terms; we retain only
                  what's needed to know your visit was verified.
                </li>
                <li>
                  <strong>Content.</strong> Anything you upload — creator posts and media, marketplace
                  listings, messages, wall comments.
                </li>
                <li>
                  <strong>Content filter records.</strong> Every message, wall comment, profile field (name,
                  handle, bio, tags, location, social links), listing, signup username, and the carrier and
                  tracking number a creator enters when shipping an order is checked by
                  automatic filters for payment details that route around the Platform (phone numbers, email
                  addresses, outside payment apps) and for prohibited content. When one refuses what you
                  wrote, the text is not sent or published, but we keep a moderation record of it for
                  administrators to review: up to 200 characters of the refused text, the reason it was
                  refused, when, and the account it came from — or, for a refused signup, the IP address it
                  came from, since there is no account yet. Only Platform administrators can see these
                  records. See Section 7 for how long they are kept.
                </li>
                <li>
                  <strong>Credits and payments.</strong> Your credit balance and a record of every credit
                  purchase, spend, sale, and payout on your account; for each credit purchase, the
                  transaction hash and the wallet address it was sent from; for each creator payout
                  request, the amount, the destination wallet address, its status, and — if the Platform
                  declines it — the reason given.
                </li>
                <li id="shipping">
                  <strong>Marketplace orders and shipping addresses.</strong> The items you buy and when.
                  If you buy a physical item, we collect the recipient&apos;s full name and shipping
                  address. That name and address are encrypted at rest and are{' '}
                  <strong>disclosed to the creator who sold you the item</strong> so they can ship it —
                  they are not shown to anyone else. When the creator ships it, the order also records the
                  carrier and tracking number they enter, which you see on your orders page; if the creator
                  corrects them later, each earlier carrier and tracking number is kept on the order too
                  (visible only to Platform administrators, for resolving delivery disputes). A tracking
                  number can be looked up with the carrier, which shows roughly where the parcel was
                  delivered, so we treat it like the address (Section 7). We also record your age
                  confirmation and acceptance of the Marketplace terms against each order.
                </li>
                <li>
                  <strong>Wallet addresses and on-chain activity.</strong> If you connect a wallet — to buy
                  credits, receive a payout, or prove you hold $ONLYONE to see a token-gated creator — we
                  see that wallet&apos;s address and, where relevant, its $ONLYONE balance and the
                  transactions it sends to or receives from the Platform. See Section 4 — this data is not
                  private in the way the rest of this policy describes.
                </li>
                <li>
                  <strong>Basic usage data.</strong> Standard technical logs (IP address, browser/device
                  info, timestamps) generated by using any website, kept for security and abuse prevention.
                </li>
                <li>
                  <strong>Launch notification signup.</strong> If you ask to be notified when we launch,
                  we store the email address you give us, whether you said you were joining as a fan or
                  a creator, which page you signed up from, and — only if you are in the US and we can
                  tell — the US state you were in, so we can tell you when your state opens, since some
                  states are currently blocked entirely. We do not record your country, or any region
                  outside the US. That list is used for nothing but telling you about the
                  launch. We never sell or share it, and you can be removed at any time by emailing{' '}
                  <a href="mailto:team@onlyone1.fun" className="text-brand-gold underline">team@onlyone1.fun</a>.
                  You do not need an account to sign up, and signing up does not create one.
                </li>
                <li>
                  <strong>Content-report info.</strong> If you submit our{' '}
                  <a href="/report-content" className="text-brand-gold underline">Report Non-Consensual Content</a>{' '}
                  form (no account needed to do so), we collect the name and contact info you provide,
                  whether you are reporting content of yourself, of someone else, or content you believe
                  shows a minor, which statement you confirmed, and what you tell us about the content,
                  solely to review and act on that report. Content that shows a minor is reported to the
                  National Center for Missing &amp; Exploited Children and law enforcement as the law
                  requires; your report may be included in that referral.
                </li>
              </ul>
            </Section>

            <Section title="2. Fan Anonymity — What We Deliberately Don't Require">
              <p>
                A Fan account never requires a real email address. You can sign up with a username instead
                — we understand plenty of people using this Platform would rather it never show up in an
                inbox someone else can see. If you do use a real email, we still never send marketing to it
                without your consent, and we never use it for anything other than identifying your own
                account.
              </p>
              <p className="mt-3">
                This is a deliberate design choice, not an oversight: the less real-world identifying
                information a Fan account requires, the less there is to ever be exposed, subpoenaed
                unnecessarily, or leaked. Two exceptions: buying a <strong>physical</strong> Marketplace
                item requires a real shipping name and address, which the selling creator sees (Section
                1); and fans in some states must pass age verification through our vendor (Section 6).
              </p>
              <p className="mt-3">
                Creators and the people who appear in their content are held to a different standard.
                Every creator profile is reviewed by our team, and we keep identity records for performers
                in sexually explicit content (Section 1, Performer records). Those exist to keep minors
                and non-consenting people off the Platform, which we treat as non-negotiable regardless of
                the privacy tradeoff.
              </p>
            </Section>

            <Section title="3. How We Use It">
              <ul className="list-disc pl-5 space-y-2">
                <li>To operate your account, log you in, and show you the content you&apos;ve bought or are entitled to see.</li>
                <li>To review a creator&apos;s profile before it goes public, and to keep the performer records described in Section 1.</li>
                <li>To credit your purchases, take fees, and send creator payouts.</li>
                <li>
                  To fulfil Marketplace orders — including sharing a physical order&apos;s shipping name and
                  address with the creator who sold it, and no one else.
                </li>
                <li>To detect and prevent fraud, abuse, and violations of our Terms of Service.</li>
                <li>To respond to a valid legal request (subpoena, court order) where we're required to.</li>
              </ul>
              <p className="mt-3">We do not sell your personal information to third parties, and we do not use your content or account data to train AI models.</p>
            </Section>

            <Section title="4. Credits, Payouts & Public On-Chain Data">
              <p>
                Fans buy credits by sending USDG from their own wallet to the Platform&apos;s wallet on
                Robinhood Chain, and creators are paid out by the Platform sending USDG to the wallet they
                give us (see the{' '}
                <a href="/terms#payments" className="text-brand-gold underline">Terms of Service</a>).
                Those two kinds of transfer happen on a public blockchain. Everything in between — your
                credit balance, what you spend credits on, and what a creator earns — is an internal
                record kept by the Platform, not an on-chain transaction.
              </p>
              <p className="mt-3">
                Blockchains are public ledgers by design: a wallet address and every transaction it sends or
                receives is visible to anyone who looks, forever, on the blockchain itself — not just to us.
                Anyone who knows the Platform&apos;s wallet can see that a given address sent it money. We
                cannot make on-chain data private, and we cannot delete, alter, or reverse anything once
                it&apos;s confirmed on-chain, even if you later delete your Platform account. If linking a
                wallet to your real identity is a concern, don&apos;t fund it from an address or exchange
                account that&apos;s already tied to your name.
              </p>
            </Section>

            <Section title="5. Cookies & Sessions" id="cookies">
              <p>
                We only set our own (first-party) cookies, each for a specific job:
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li><strong>Login session</strong> (<code>oa_session</code>) — keeps you logged in, up to 30 days.</li>
                <li>
                  <strong>Age verification</strong> (<code>oa_age_verified</code>) — records that this browser
                  passed age verification (or was let in by the site owner or an authorised reviewer), so you
                  aren&apos;t asked again; up to 180 days.
                </li>
                <li>
                  <strong>Referral</strong> (<code>oa_ref</code>) — set only when you arrive through a
                  creator&apos;s <code>?ref=</code> link, whether or not you have an account, so that creator
                  is credited if you sign up; 30 days.
                </li>
                <li>
                  <strong>Wallet sign-in challenges</strong> (<code>oa_wallet_nonce</code>,{' '}
                  <code>oa_deposit_nonce</code>, <code>oa_holder_nonce</code>) — a one-time value you sign to
                  prove you control a wallet; about 5 minutes.
                </li>
                <li>
                  <strong>Verified deposit wallet</strong> (<code>oa_deposit_wallet</code>) — after you prove you
                  control a wallet on the Credits page, records which wallet address that was for your account,
                  so a payment is only credited when it comes from that wallet; 2 hours.
                </li>
                <li>
                  <strong>Token holding</strong> (<code>oa_holder</code>) — if you prove you hold $ONLYONE to see
                  a token-gated creator, records that proof and the wallet address it was for, so you don&apos;t
                  have to sign again on every page; 1 hour. Your balance is re-read on-chain, not taken from the
                  cookie.
                </li>
                <li>
                  <strong>Preview invite</strong> (<code>oa_preview</code>) — only when the site is in
                  invite-only preview mode and you followed an invite link.
                </li>
                <li>
                  <strong>Administrator access</strong> (<code>oa_admin_media</code>) — used only by Platform
                  administrators, to view media in the admin panel; 2 hours.
                </li>
              </ul>
              <p className="mt-3">
                We also store three things in your browser&apos;s local storage, which never leave your device
                unless you check out: that you dismissed the 18+ notice; the contents of your Marketplace cart;
                and, while a Marketplace checkout is in progress, a record of that checkout attempt. The
                checkout record holds your account ID, a one-time checkout key and a fingerprint of the cart,
                and it is what stops a retried or interrupted checkout from charging you twice. It is removed
                when a checkout goes through. If a checkout is refused (for example, not enough credits), the
                record is kept for up to 24 hours so that retrying reuses the same key; after that it is no
                longer used, and it is deleted from the device the next time you open your cart there while
                signed in, or when a checkout completes. If the connection dropped before we could confirm
                whether a payment went through, it stays (including after you sign out) until the site can
                check that for you, so it may remain on a shared device until you sign back in there or clear
                the site&apos;s data.
              </p>
              <p className="mt-3">
                We don&apos;t run third-party advertising trackers or analytics cookies on the Platform.
              </p>
            </Section>

            <Section title="6. Third-Party Services">
              <p>
                We use infrastructure providers (web hosting, a database host, private file storage, a
                blockchain node provider used to check payments and token balances, and an
                age-verification vendor, AgeChecker.Net, for fans in states that require it) to run the
                Platform. Those providers can access the specific data needed to perform their function
                (e.g., storage providers hold uploaded files; AgeChecker.Net handles age-verification
                documents) under their own confidentiality and security obligations — we don&apos;t hand
                any of them more than what&apos;s needed for that purpose.
              </p>
              <p className="mt-3">
                Our pages load their typefaces from Google Fonts (fonts.googleapis.com and fonts.gstatic.com).
                When a page loads, your browser requests those font files from Google directly, so Google
                receives your IP address, browser details and the address of the page that asked for the font
                — this happens on every page, including creator pages. We send Google nothing else, and it is
                not used for advertising or analytics by us; Google handles it under its own privacy policy.
              </p>
              <p className="mt-3">
                Other users see only what the Platform shows them: a creator&apos;s public profile, what
                you post publicly, and messages you send them. The one case where another user receives
                your personal details is a physical Marketplace order, where the selling creator receives
                the shipping name and address (Section 1).
              </p>
              <p className="mt-3">
                Messages are private between the two people in the conversation, but not hidden from the
                Platform: administrators can look up a conversation or a wall comment and read it when
                acting on a report, a takedown request, or a suspected violation of our Terms, and can remove
                it. A removed item is copied into the moderation record first (Section 7).
              </p>
            </Section>

            <Section title="7. Data Retention & Deletion">
              <p>
                A fan can delete their own account from Settings, and anyone can request deletion of their
                account and associated off-chain data at any time by emailing team@onlyone1.fun from the address
                (or with the username) on the account. For a fan account we delete the login, your wall
                comments, the messages you sent, your favorites and your notifications, and sign you out
                everywhere; digital items you bought can only be viewed from your account, so they become
                unavailable to you once it is deleted. A creator account is deleted together with its profile
                and uploaded content, the comments and messages it sent, its favorites and its notifications,
                and its listings are taken down (a file a buyer already paid for stays available to that
                buyer). Notifications your account caused in other people&apos;s accounts (&ldquo;New message
                from …&rdquo;, &ldquo;… commented on your wall&rdquo;) stay in their history but are changed to
                read &ldquo;Someone&rdquo; instead of your name. Anything of yours that has been reported to us is copied into the moderation record
                before it is deleted, so a deletion does not erase a report&apos;s evidence. Any credit balance
                left on a deleted account is forfeited — credits are never refunded (Terms of Service) — so
                spend it, or confirm you want to go ahead anyway. Some limits on that:
              </p>
              <ul className="list-disc pl-5 space-y-2 mt-3">
                <li>On-chain transaction history cannot be deleted — see Section 4.</li>
                <li>
                  Performer records kept under 18 U.S.C. §2257 (Section 1) are retained for at least seven
                  years, including after the related account or content is deleted, because the law requires
                  it. They cannot be deleted on request during that period.
                </li>
                <li>
                  Credit, sale, order, and payout records are kept as financial records and are not deleted on
                  request while we are required to keep them; once the account is deleted they are no longer
                  linked to a login, email address or username (a physical order&apos;s shipping name and address
                  are handled separately, below). Reports and moderation records are different: they
                  keep a copy of the reported or removed content, including who wrote or sent it (the username or
                  login email that account had at the time), for as long as the report, a legal hold, or a legal
                  obligation requires — that copy is the evidence, so deleting the account does not remove it.
                  Files taken down after a report that they may show a minor are kept as evidence too: they are moved to
                  restricted evidence storage (never shown or delivered to other users) instead of being deleted, and
                  when the account that posted them is banned for it, every file that account still has on the Platform is kept
                  there too. These evidence files are not deleted on request or when the account is deleted. The
                  content filter records described in Section 1 are moderation records too: text a filter
                  refused stays in them, with the account (or signup IP address) it came from, after the
                  account is deleted. If
                  you have earnings waiting to be paid out, a pending payout, or a physical order that
                  hasn&apos;t shipped yet, we&apos;ll settle that with you before deleting the account — the
                  Settings page won&apos;t delete an account while one of its orders is still waiting to ship.
                  An account that is suspended or under review for a report is deleted only through support.
                </li>
                <li>
                  A physical order&apos;s shipping name and address stay with the order record so the creator
                  can fulfil it. Once the order has shipped — or has been closed because the seller could not
                  fulfil it — you can ask us to delete them (email team@onlyone1.fun with the order), unless we
                  need them for a dispute or legal claim already in progress; the order record itself stays,
                  without them. Deleting them also deletes the order&apos;s tracking number and every earlier
                  tracking number kept for it (the carrier name and dates stay), and the tracking can no longer
                  be changed after that. Deleting your account from the Settings page deletes the shipping
                  name and address, and the tracking numbers, from every one of your orders that has already
                  shipped or been closed, at the same time.
                </li>
                <li>We may retain limited data where necessary to investigate fraud, abuse, or a legal claim already in progress.</li>
              </ul>
            </Section>

            <Section title="8. Your Rights">
              <p>
                Depending on where you live, you may have rights to access, correct, or request deletion of
                your personal information, or to object to certain uses of it. Email team@onlyone1.fun to exercise
                any of these — we'll respond consistent with applicable law, subject to the retention limits
                in Section 7.
              </p>
            </Section>

            <Section title="9. Children's Privacy">
              <p>
                This Platform is strictly for adults 18 and older (see the Terms of Service, Section 1). We
                do not knowingly collect information from anyone under 18. If we learn an account belongs to
                a minor, it will be terminated immediately and any associated data handled as required by
                law.
              </p>
            </Section>

            <Section title="10. Changes to This Policy">
              <p>
                We may update this Privacy Policy from time to time. Continued use of the Platform after a
                change is posted constitutes acceptance of the revised policy. Material changes will be
                reflected by an updated "Last updated" date above.
              </p>
            </Section>

            <Section title="11. Contact">
              <p>
                Questions about this policy, or a data request under Section 7 or 8, can be sent to{' '}
                <a href="mailto:team@onlyone1.fun" className="text-brand-gold underline">team@onlyone1.fun</a>.
              </p>
            </Section>
          </div>

          <p className="text-xs text-gray-600 mt-8">
            This document is a general template and does not constitute legal advice. It should be
            reviewed by a licensed attorney familiar with adult content platforms, cryptocurrency
            regulations, and data privacy law (e.g. GDPR/CCPA) in your operating jurisdiction before public
            launch.
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
