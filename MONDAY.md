# Monday pickup — Only One LLC, business/legal setup

Written 2026-09-19 (Saturday). Everything below is the state of the
**business** side, not the code. Code status lives in `MEMORY.md`.

**The EIN, the registered-agent street address, and the founder's legal name
are deliberately NOT in this file.** This repo is on GitHub. Both numbers are
already on documents the founder holds — the IRS CP 575 G notice (EIN) and
the Indiana SOS filing (address). Do not copy them in here "for convenience";
that is the one change that cannot be undone once pushed.

---

## Where it actually stands

| Item | Status |
|---|---|
| **Articles of Organization**, Only One LLC | **APPROVED 2026-09-22.** Indiana SOS confirmation received (signed by Secretary of State Diego Morales). Only One LLC is now a real, registered Indiana entity. |
| Entity type | Single-member Indiana LLC, member-managed |
| Registered agent | The founder, at the principal office address (on the filing) |
| **EIN** | **Issued** (CP 575 G, dated 2026-09-18). Entity name on the IRS line is `ONLY ONE` — two words, no "LLC". Banks and processors match that string exactly; "OnlyOne" or "OnlyOne LLC" is a different name and causes verification mismatches. |
| **Operating Agreement** | Drafted, delivered as .docx. **Not filed anywhere** — sign it, date it, keep it. The bank will ask for it. |
| Age verification | AgeChecker.Net live in production |
| §2257 record system | Built and live in the admin panel; `RECORDS_ENCRYPTION_KEY` set |

---

## Unblocked now that SOS approval landed

1. **Indiana DOR tax registration (BT-1)** — was waiting on the approved SOS
   Business ID; that ID now exists (see the SOS confirmation received
   2026-09-22). This is what issues the Retail Merchant Certificate for
   marketplace sales tax. Register at in.gov/dor.
2. **Business bank account** — bring the EIN letter + the now-*approved*
   Articles. Tell the bank what the business actually is, upfront. A bank
   that finds out later freezes the account; that pattern is already
   recorded in `MEMORY.md` and applies to processors too.
3. The SOS confirmation itself flags a real, recurring obligation worth not
   losing track of: **the first Business Entity Report is due 2 years after
   registration, then every other year after that** — missing it risks
   administrative dissolution/revocation. Not urgent now, but real.

Sequence: BT-1 at in.gov/dor → bank.

---

## Corrections to the checklist in the handoff

The generic Indiana checklist it came with is fine, but two lines of it are
already behind where this actually is:

- **"Get a Federal EIN" is done.** Issued 2026-09-18.
- **"Fastest path: Sole proprietor + EIN…" no longer applies.** The LLC is
  already filed. Reverting to sole proprietor would mean giving up the
  liability shield — which is the entire reason to have the LLC on a platform
  like this. Do not take that path.
- **Sales tax / Retail Merchant Certificate is a real requirement here**, not
  an optional one, because the marketplace sells physical goods. Subscriptions
  and digital content are a separate question worth asking the DOR or a CPA
  directly rather than assuming.
- **Local permit**: Indianapolis/Marion County. Worth a phone call rather than
  a guess — an online platform operating from a home office often has minimal
  local requirements, but "often" is not "confirmed".

---

## Socials this weekend: yes to claiming, no to launching

**Go claim the handles now.** That is the actual fix for being front-run on
the name, it needs no approved LLC, and a parked handle costs nothing.

**What is safe to point people at today**, and this matters because most of
the site is not:

- `https://www.joinonlyone.com/` — the landing page. Ungated, no creator
  photos, no content, and it now carries the **waitlist signup (fan or
  creator)** shipped 2026-09-19. It is also the only page with a social share
  card, deliberately text-only with no image.
- `https://www.joinonlyone.com/founding-creator` — creator recruitment, same
  rules.
- Both work from all 27 geoblocked states. Everything else on the site does
  not, so a link to any other page is a dead end for a chunk of the audience.

**Hold off on:** taking any money, and announcing a live date as a business.
Until the SOS approves, there is no liability shield — anything that happens
in the gap lands on the founder personally, not the LLC.

### One conflict to be aware of, not silently resolved

The handoff advice says hold off on "onboarding creators" until the LLC
clears. **Creator signup and the Founding Creator programme are already live
on the site right now** (`/signup`, `/founding-creator`, the first-100 cap,
the fee waiver). Nobody can be charged and nobody can be paid — there is no
payment processing at all — so no money is moving through an unformed entity.
But creators *can* sign up and submit profiles today.

That is a founder decision, not a bug: either it is fine (nothing financial is
happening) or recruitment pauses until Monday. **Not changed unilaterally.**

---

## The trademark flag, which is the biggest item on this page

"OnlyOne" is close to "OnlyFans" and it is the *same product category* —
creator subscriptions and content sales. That combination (similar mark +
identical goods/services) is exactly what a trademark claim is built on, and
Fenix International has gone after similarly-named platforms before.

Why this is worth real attention right now rather than later:

- The whole rename from "Only Ass" to "OnlyOne" completed this week. The
  domains (`joinonlyone.com`, `shoponeonly.com`, `onlyone1.fun`), the token
  ticker `$ONLYONE`, the LLC name `ONLY ONE`, the contract names and every
  page of copy are all built on it.
- **Cost of changing it scales with followers and time.** Today it is a find-
  and-replace plus new domains. After a launch and an audience it is a brand
  rebuild, and after a cease-and-desist it is a rebuild on someone else's
  schedule.
- A trademark attorney doing a clearance search on this is a few hundred
  dollars and a few days — cheap next to the alternative, and a real answer
  instead of a guess. **This is not a question code or an AI can settle.**

Nothing has been changed over this. Recording it so the decision is made
deliberately instead of discovered.

---

## Still open, no SOS dependency

- **Payment processor.** Must support adult content AND split payouts to
  creators. The research already in `MEMORY.md` stands: Epoch is the lowest
  barrier, CCBill the most established and most expensive, Segpay and Vendo
  in between; all four need a live working site with ToS, privacy policy,
  age verification and contact info in place first — which now exists.
  Stripe is a firm no under any structure, DBA included.
- **The money-transmission question.** Still the largest legal item on the
  whole project, above §2257: credits make the platform custodial — it holds
  fan money and remits to creators. Get this in front of an attorney before
  the first dollar. Code cannot settle it.
- **Creator KYC / §2257 at onboarding.** The record *store* is built; the
  requirement that a creator provide ID and a signed record *before* they can
  post is not enforced in code yet.
