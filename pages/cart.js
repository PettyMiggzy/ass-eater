import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { Icons, SolidIcons } from '../components/Brand';
import { formatCredits } from '../lib/brand';
import { useCart } from '../lib/cart';

const MAIN_SITE = 'https://joinonlyone.com';
const ADDRESS_FIELDS = [
  { key: 'fullName', label: 'Full name' },
  { key: 'line1', label: 'Address line 1' },
  { key: 'line2', label: 'Address line 2 (optional)', optional: true },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'State / Region' },
  { key: 'postalCode', label: 'Postal code' },
  { key: 'country', label: 'Country' },
];

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  return { props: { sessionUser } };
}

// Checkout spends from the fan's credits balance -- no wallet, no on-chain
// step here at all. The only place a wallet is ever involved is /credits,
// converting real USDG into that balance once. See pages/credits.js.
function newIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// The in-flight checkout attempt is persisted next to the cart (localStorage),
// not only in React state. If the first POST commits but its response never
// arrives, a reload must RESEND the same key -- the server then answers
// DUPLICATE_CHECKOUT instead of placing (and charging for) a second order. A
// key minted fresh per page load is exactly how a lost response turned into a
// double charge for an unlimited physical listing.
//
// The attempt belongs to ONE account and ONE cart:
// - It is stored under a per-account storage key and carries the account id,
//   so a second person signing in on the same browser never sends (or is
//   answered about) someone else's attempt. The server scopes the claim to
//   the buyer as well (checkout_idempotency's key is (buyer_id, key)).
// - It carries a fingerprint of what is being bought. A changed cart is a
//   different agreement and gets a new key; the key is only ever SENT with
//   the cart it was minted for, so a DUPLICATE_CHECKOUT answer always refers
//   to the cart on screen.
//
// An attempt is `uncertain` from the moment a request under its key is SENT
// until a definitive answer comes back (200, DUPLICATE_CHECKOUT, or a refusal
// with no earlier request unaccounted for). It is written as uncertain BEFORE
// the fetch: a tab closed or reloaded mid-request may still commit, and an
// attempt stored as "not sent" would let an edited cart mint a new key and
// charge again. It stays uncertain after a network failure or a 5xx. While it
// is,
// the page asks GET /api/marketplace/orders/checkout-status whether that key
// was claimed -- on load, right after the failure, and from a "Check payment
// status" button that works whatever the balance now is (the first request
// may have spent it). Claimed -> the listings that attempt bought are taken
// out of the cart (compared against the cart as it is at that moment, not
// when Pay was pressed): if nothing else is left it is "Already paid",
// otherwise the fan is told the EARLIER checkout went through and that only
// what remains is unpaid. Leaving an already-bought item in a cart the page
// calls unpaid is how an unlimited physical listing got bought twice (a new
// key, since the cart changed). Not claimed -> the key stays pinned for
// that cart (a retry can't pay twice), and is only dropped for a different
// cart once enough time has passed that the old request can no longer
// commit. An uncertain attempt is never discarded on age alone -- a fan who
// comes back days later is still asked about it first.
const ATTEMPT_STORAGE_PREFIX = 'onlyone-checkout-attempt-v2:';
const LEGACY_ATTEMPT_STORAGE_KEY = 'onlyone-checkout-attempt-v1';
const ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Well above the longest a checkout request can run -- `config.maxDuration`
// (60s) in pages/api/marketplace/orders/create.js -- so an unclaimed key older
// than this can no longer commit. Raise both together, keeping this larger.
const UNCERTAIN_GRACE_MS = 5 * 60 * 1000;

function cartFingerprint(items) {
  return JSON.stringify(
    items
      .map((it) => [String(it.id), it.priceCents, it.kind === 'physical' ? it.shippingCents || 0 : 0])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

// The listing ids an attempt was for, read back out of its fingerprint (so
// attempts stored before this existed carry them too). Quantity is always 1.
function attemptListingIds(attempt) {
  try {
    const rows = JSON.parse(attempt.fp);
    return Array.isArray(rows) ? rows.map((r) => String(Array.isArray(r) ? r[0] : '')).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function validAttempt(rec, uid) {
  if (!rec || typeof rec.key !== 'string' || typeof rec.fp !== 'string') return null;
  if (!Number.isFinite(rec.at)) return null;
  // Only a settled attempt (nothing in flight under its key) may age out.
  // An uncertain one is kept until checkout-status says it was never claimed
  // and the grace period has passed -- see resolveStored on load.
  if (!rec.uncertain && Date.now() - rec.at > ATTEMPT_MAX_AGE_MS) return null;
  if (String(rec.uid) !== String(uid)) return null;
  return rec;
}

function readAttempt(uid) {
  if (!uid) return null;
  try {
    const storageKey = ATTEMPT_STORAGE_PREFIX + uid;
    const raw = localStorage.getItem(storageKey);
    let stored = null;
    try { stored = JSON.parse(raw || 'null'); } catch { stored = null; }
    const rec = validAttempt(stored, uid);
    if (rec) return rec;
    // A record validAttempt rejects -- a settled attempt past
    // ATTEMPT_MAX_AGE_MS, or one that is malformed -- is deleted, not just
    // ignored: Privacy section 5 says a refused checkout's record is kept
    // for up to 24 hours, and ignoring it left it on the device (keyed by
    // this account's id) indefinitely. An uncertain record never gets here
    // on age alone (validAttempt keeps it until the server has answered).
    if (raw !== null) localStorage.removeItem(storageKey);
    // An attempt stored before attempts were per-account has no owner. Adopt
    // it for whoever is signed in now: the server only ever answers about the
    // caller's own keys, so the worst case is it reads "not claimed" and ages
    // out. Removed either way so it can't be adopted twice.
    const legacy = JSON.parse(localStorage.getItem(LEGACY_ATTEMPT_STORAGE_KEY) || 'null');
    localStorage.removeItem(LEGACY_ATTEMPT_STORAGE_KEY);
    if (legacy && typeof legacy === 'object') {
      const adopted = validAttempt({ ...legacy, uid: String(uid) }, uid);
      if (adopted) {
        localStorage.setItem(ATTEMPT_STORAGE_PREFIX + uid, JSON.stringify(adopted));
        return adopted;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function writeAttempt(uid, rec) {
  try { localStorage.setItem(ATTEMPT_STORAGE_PREFIX + uid, JSON.stringify(rec)); } catch { /* storage unavailable: in-memory only */ }
}

function clearAttempt(uid) {
  try { localStorage.removeItem(ATTEMPT_STORAGE_PREFIX + uid); } catch { /* ignore */ }
}

// true / false, or throws when the answer couldn't be fetched.
async function fetchKeyClaimed(key) {
  const res = await fetch(`/api/marketplace/orders/checkout-status?key=${encodeURIComponent(key)}`, { cache: 'no-store' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || typeof data.claimed !== 'boolean') throw new Error('status unavailable');
  return data.claimed;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reload so the page is rendered for the account signed in now. At most once
// every 10 seconds per tab: if the page's session and the cart's re-check ever
// disagreed persistently, this must not become a reload loop.
const SESSION_RELOAD_KEY = 'onlyone-cart-session-reload';
function reloadForSession() {
  try {
    const last = Number(sessionStorage.getItem(SESSION_RELOAD_KEY) || 0);
    if (Date.now() - last < 10_000) return false;
    sessionStorage.setItem(SESSION_RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage unavailable: reload anyway (the server check still holds)
  }
  window.location.reload();
  return true;
}

export default function CartPage({ sessionUser }) {
  const cart = useCart();
  const uid = sessionUser ? String(sessionUser.id) : null;
  const [balanceCents, setBalanceCents] = useState(null);
  // A suspended or banned account's credits are frozen (/api/credits/balance
  // says so): the server refuses checkout, so the page says it up front
  // instead of offering Pay or a "buy credits" prompt.
  const [frozen, setFrozen] = useState(false);
  // The last balance load failed (non-OK, unparseable, or no network). Only
  // shown while no balance is known yet: Pay is disabled then, and without
  // this the page said "Balance: …" forever with no reason and no retry
  // (round-15 money#2; /credits got the same state in round 14).
  const [balanceError, setBalanceError] = useState(false);
  // One key per checkout ATTEMPT, reused across retries of the same
  // submission (a network drop, a lost response, a reload) so the server can
  // tell "resending the same attempt" apart from "starting a new one". Held
  // in memory too, for when localStorage is unavailable, and mirrored here so
  // the page knows when an attempt is `uncertain`. See the note above
  // readAttempt/writeAttempt.
  const [memAttempt, setMemAttempt] = useState(null);
  const [address, setAddress] = useState({});
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [paying, setPaying] = useState(false);
  const [checking, setChecking] = useState(false);
  const [payError, setPayError] = useState(null);
  // Set with payError when the refusal is "you already own this": the fix is
  // in /orders, so the message links there.
  const [payErrorOwned, setPayErrorOwned] = useState(false);
  const [paidOrders, setPaidOrders] = useState(null);
  // How many items were still in the cart after a successful checkout took
  // out what it paid for (added in another tab while the request ran). They
  // were NOT bought; the confirmation says so and links back to them.
  const [unpaidLeft, setUnpaidLeft] = useState(0);
  // Set when the server says this exact checkout already went through (the
  // first response was lost): the fan has paid, so show that, not an error.
  const [alreadyProcessed, setAlreadyProcessed] = useState(false);
  // Set when an EARLIER checkout (for a cart that differs from the one on
  // screen) turns out to have gone through. The current cart was not bought
  // and is left as it is; the fan is pointed at /orders to see what was.
  const [earlierPaid, setEarlierPaid] = useState(false);
  const loadCheckDone = useRef(false);
  // The cart as it is right now, for code that resumes after an await (the
  // fan can edit the cart while a request or a status check is in flight).
  const cartItemsRef = useRef(cart.items);
  cartItemsRef.current = cart.items;

  const viewerConfirmed = useRef(false);
  // This page knows the signed-in account from its own session: hand it to
  // the cart so a cart built by a different account on this browser is
  // discarded (lib/cart.js resolveCartOwnership) before anything renders or
  // is paid for, without waiting on the cart's own /api/auth/me check.
  useEffect(() => {
    viewerConfirmed.current = false; // re-confirmed for this uid below
    cart.setViewer(uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // This page's `uid`, balance and checkout attempt all belong to the account
  // it was rendered for. When the cart's own re-check (on focus, on a return
  // to the tab, on another tab changing the cart -- lib/cart.js) finds a
  // different account signed in, or nobody, reload so all of them belong to
  // whoever is signed in now instead of offering the previous account's cart
  // to the next one. Only a change AFTER the cart has confirmed this page's
  // account counts: a value left over from the page before this one is
  // replaced by setViewer above. The server refuses a mismatched checkout on
  // its own too (expectedBuyerId below); this keeps the page honest.
  useEffect(() => {
    if (cart.viewer === undefined) return;
    const current = cart.viewer === null ? null : String(cart.viewer);
    if (current === uid) {
      viewerConfirmed.current = true;
      return;
    }
    if (viewerConfirmed.current) reloadForSession();
  }, [cart.viewer, uid]);

  // Only a real balance is ever shown. A 401 means this tab's session ended
  // (logged out elsewhere, revoked): re-render for whoever is signed in now
  // rather than show "0 credits, you're short". Any other failure keeps the
  // last known balance -- writing 0 pushed fans to buy credits they had --
  // and flags balanceError so a page with no balance yet says so and offers
  // a retry.
  const refreshBalance = () => {
    setBalanceError(false);
    return fetch('/api/credits/balance', { cache: 'no-store' })
      .then(async (r) => {
        if (r.status === 401) {
          reloadForSession();
          return;
        }
        if (!r.ok) {
          setBalanceError(true);
          return;
        }
        const d = await r.json().catch(() => null);
        if (!d || !Number.isFinite(d.balanceCents)) {
          setBalanceError(true);
          return;
        }
        setBalanceCents(d.balanceCents);
        if (typeof d.frozen === 'boolean') setFrozen(d.frozen);
      })
      .catch(() => { setBalanceError(true); });
  };

  useEffect(() => {
    if (!sessionUser) return;
    refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser]);

  const currentAttempt = () => readAttempt(uid) || (memAttempt && String(memAttempt.uid) === uid ? memAttempt : null);

  // Forget the current attempt: the next Pay starts a new agreement.
  const endAttempt = () => {
    if (uid) clearAttempt(uid);
    setMemAttempt(null);
  };

  // An attempt is known to have committed: take what it bought out of the
  // cart as it is NOW. Nothing else left -> "Already paid"; anything else
  // left (added or kept since) -> the earlier-checkout notice, which says
  // only what remains is unpaid. Never leaves a bought item in the cart.
  const settleClaimed = (attempt) => {
    endAttempt();
    refreshBalance();
    const paid = new Set(attemptListingIds(attempt));
    const live = cartItemsRef.current;
    const remaining = live.filter((it) => !paid.has(String(it.id)));
    if (remaining.length === 0 || cartFingerprint(live) === attempt.fp) {
      cart.clear();
      setAlreadyProcessed(true);
    } else {
      for (const it of live) if (paid.has(String(it.id))) cart.remove(it.id);
      setEarlierPaid(true);
    }
  };

  // Ask the server whether an uncertain attempt committed, and act on the
  // answer. Returns 'claimed' | 'unclaimed'; throws when the lookup itself
  // failed.
  const resolveUncertain = async (attempt) => {
    const claimed = await fetchKeyClaimed(attempt.key);
    if (!claimed) return 'unclaimed';
    settleClaimed(attempt);
    return 'claimed';
  };

  // On load: pick up this account's stored attempt and ask the server about
  // it, whatever it is marked -- a request can commit after the page that
  // sent it is gone. Claimed -> settled (bought items leave the cart).
  // Unclaimed and uncertain past the grace period -> it can no longer
  // commit, so it is dropped; within the grace period it stays pinned and
  // the banner offers a re-check. A failed lookup keeps everything as is.
  useEffect(() => {
    if (!uid || !cart.hydrated || loadCheckDone.current) return;
    loadCheckDone.current = true;
    const stored = readAttempt(uid);
    setMemAttempt(stored);
    if (stored) {
      resolveUncertain(stored)
        .then((outcome) => {
          if (
            outcome === 'unclaimed' &&
            stored.uncertain &&
            Date.now() - (stored.uncertainAt || stored.at) >= UNCERTAIN_GRACE_MS
          ) {
            endAttempt();
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, cart.hydrated]);

  // The stored attempt is marked uncertain while its own request is in
  // flight too; the "couldn't confirm" banner is only for an outcome that
  // is actually unknown, not for the request this page is waiting on.
  const uncertainAttempt = memAttempt && memAttempt.uncertain && !paying ? memAttempt : null;

  const hasEnough = balanceCents !== null && balanceCents >= cart.totalCents;
  // The cart has seen a different account signed in: the reload above is
  // on its way (and the server would refuse anyway), so don't offer Pay.
  const viewerMismatch = cart.viewer !== undefined && (cart.viewer === null ? null : String(cart.viewer)) !== uid;
  const canCheckout =
    !!sessionUser &&
    !viewerMismatch &&
    !frozen &&
    hasEnough &&
    ageConfirmed &&
    tosAccepted &&
    cart.items.length > 0 &&
    (!cart.needsShipping || ADDRESS_FIELDS.every((f) => f.optional || String(address[f.key] || '').trim()));

  // "Check payment status": resolves an uncertain attempt whatever the
  // balance is now (the attempt may already have spent it).
  const checkStatus = async () => {
    const attempt = currentAttempt();
    setPayError(null);
    setPayErrorOwned(false);
    if (!attempt || !attempt.uncertain) {
      setMemAttempt(attempt);
      return;
    }
    setChecking(true);
    try {
      const outcome = await resolveUncertain(attempt);
      if (outcome === 'unclaimed') {
        if (Date.now() - (attempt.uncertainAt || attempt.at) >= UNCERTAIN_GRACE_MS) {
          // Old enough that the request can no longer commit: it never went
          // through, and nothing was charged for it.
          endAttempt();
          refreshBalance();
          setPayError('That earlier payment attempt did not go through, and nothing was charged for it. You can pay for your cart now.');
        } else {
          setPayError("That payment hasn't gone through yet. It may still be processing -- check again in a minute. Pressing Pay again for this same cart is safe and won't charge you twice.");
        }
      }
    } catch {
      setPayError("We couldn't check that payment right now. Try again in a moment, or look in your order history.");
    } finally {
      setChecking(false);
    }
  };

  const pay = async () => {
    if (!uid) return;
    setPayError(null);
    setPayErrorOwned(false);
    setEarlierPaid(false);
    setPaying(true);
    try {
      const fp = cartFingerprint(cart.items);
      let stored = currentAttempt();
      if (stored && stored.uncertain && stored.fp !== fp) {
        // An earlier attempt whose outcome is unknown was for a DIFFERENT
        // cart. Its key is never sent with this one: find out what happened
        // to it first.
        let outcome;
        try {
          outcome = await resolveUncertain(stored);
        } catch {
          throw new Error("We couldn't check on your earlier payment attempt. Try again in a moment, or look in your order history.");
        }
        if (outcome === 'claimed') return; // the notice above the cart explains it
        const waitMs = UNCERTAIN_GRACE_MS - (Date.now() - (stored.uncertainAt || stored.at));
        if (waitMs > 0) {
          const mins = Math.ceil(waitMs / 60000);
          throw new Error(
            `Your earlier payment attempt is still being confirmed. Wait ${mins <= 1 ? 'about a minute' : `about ${mins} minutes`} and check your order history before paying for this cart.`
          );
        }
        endAttempt(); // it can no longer commit: start fresh for this cart
        stored = null;
      }
      const base =
        stored && stored.fp === fp
          ? stored
          : { key: newIdempotencyKey(), fp, uid, at: Date.now(), uncertain: false };
      // A refusal is only proof that nothing was charged when no earlier request
      // under this key is unaccounted for. Read before the attempt is marked
      // in flight below.
      const priorUncertain = !!base.uncertain;
      // Stored as uncertain BEFORE the request goes out: if the tab is closed
      // or reloaded while it runs, it may still commit, and the next load must
      // ask about it rather than treat it as never sent. The stamp is this
      // send's time, so a request whose response (or tab) is lost gets the
      // full grace from its own send; restoreEarlierUncertain below puts the
      // earlier stamp back once this request is definitively answered.
      const attempt = { ...base, uncertain: true, uncertainAt: Date.now() };
      writeAttempt(uid, attempt);
      setMemAttempt(attempt);
      const idempotencyKey = attempt.key;
      // Exactly what this request is for. On success only these leave the
      // cart: anything added meanwhile (another tab, via lib/cart.js's
      // storage listener) was not in the request and was not bought.
      const sentIds = cart.items.map((it) => String(it.id));
      // A definitive refusal of THIS request with nothing earlier unaccounted
      // for: the key stays (reusing an unclaimed key is harmless) but the
      // attempt is no longer in doubt.
      const markSettled = () => {
        const { uncertainAt, ...rest } = attempt; // eslint-disable-line no-unused-vars
        const rec = { ...rest, uncertain: false };
        writeAttempt(uid, rec);
        setMemAttempt(rec);
      };
      // The outcome of this request is unknown (lost response / 5xx): keep the
      // key pinned so no later refusal can rotate it. See the note at the top.
      const markUncertain = () => {
        const rec = { ...attempt, uncertain: true, uncertainAt: Date.now() };
        writeAttempt(uid, rec);
        setMemAttempt(rec);
        return rec;
      };
      // Right after an unknown outcome, ask whether it committed so the fan
      // doesn't have to press Pay again (which a spent balance may block).
      // A short pause first gives a request still in flight time to finish.
      const confirmAfterUnknown = async (rec) => {
        await sleep(2000);
        try {
          return (await resolveUncertain(rec)) === 'claimed';
        } catch {
          return false;
        }
      };
      // A definitive refusal of THIS request while an EARLIER one under the
      // key is still unaccounted for: this request can no longer commit, so
      // the grace is measured from the earlier one again, not from this
      // press. Leaving this press's stamp in place pushed the "wait a minute"
      // block out by the full grace period on every retry.
      const restoreEarlierUncertain = () => {
        const rec = { ...attempt, uncertain: true, uncertainAt: base.uncertainAt || base.at };
        writeAttempt(uid, rec);
        setMemAttempt(rec);
      };
      const UNCERTAIN_NOTE =
        ' An earlier payment attempt for this cart may already have gone through -- use "Check payment status" or look in your order history before paying again. Pressing Pay again is safe and won\'t charge you twice for that attempt.';
      // Forget the attempt after a definitive refusal -- unless an earlier
      // request under this key is unaccounted for, in which case keep it
      // pinned and uncertain (timed from that earlier request).
      const endIfCertain = () => {
        if (!priorUncertain) endAttempt();
        else restoreEarlierUncertain();
      };
      let res;
      try {
        res = await fetch('/api/marketplace/orders/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // The price the fan is looking at goes with each item: the server
            // charges it only if it still matches the live listing.
            items: cart.items.map((it) => ({
              listingId: it.id,
              expectedPriceCents: it.priceCents,
              expectedShippingCents: it.kind === 'physical' ? it.shippingCents || 0 : 0,
              expectedKind: it.kind === 'physical' ? 'physical' : 'digital',
            })),
            shippingAddress: cart.needsShipping ? address : undefined,
            ageConfirmed,
            tosAccepted,
            idempotencyKey,
            // The account this page was rendered for. If the browser has
            // since signed in as someone else, the server refuses with
            // SESSION_CHANGED rather than charge them for this cart.
            expectedBuyerId: uid,
          }),
        });
      } catch {
        // The request may or may not have reached the server. The attempt
        // (and its key) is kept and pinned, so pressing Pay again -- even
        // after a reload, a price change or a top-up -- can't place a second
        // order. Refresh the balance so a debit that did happen shows.
        const rec = markUncertain();
        refreshBalance();
        if (await confirmAfterUnknown(rec)) return;
        throw new Error("We couldn't confirm whether your payment went through. Use \"Check payment status\" or look in your order history -- pressing Pay again is safe and won't charge you twice.");
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === 'DUPLICATE_CHECKOUT') {
        // This exact checkout already went through; only its response was
        // lost. The key is only ever sent with the cart it was minted for;
        // settleClaimed removes what it bought from the cart as it is now
        // (the fan may have edited it while the request was in flight) and
        // points at the orders -- never leaves paid items sitting in the cart.
        settleClaimed(attempt);
        return;
      }
      if (res.status === 409 && data.code === 'SESSION_CHANGED') {
        // A different account (or nobody) is signed in now. Nothing was
        // charged, to anyone; this attempt was never the new account's.
        endIfCertain();
        if (reloadForSession()) return;
        throw new Error(data.error || 'You signed in or out in another tab. Reload the page before paying.');
      }
      if (res.status === 409 && data.code === 'PRICE_CHANGED') {
        // Nothing was charged. Show the new prices and make the fan confirm
        // again -- with a fresh key, since this is a different agreement.
        if (Array.isArray(data.items)) cart.applyChanges(data.items);
        endIfCertain();
        throw new Error((data.error || 'Something in your cart changed. Review the new total and confirm again.') + (priorUncertain ? UNCERTAIN_NOTE : ''));
      }
      if (res.status === 409 && data.code === 'ALREADY_OWNED') {
        // A digital item this account already bought. Nothing was charged;
        // take it out of the cart and point at where the fan already has it.
        if (data.listingId != null) cart.remove(data.listingId);
        endIfCertain();
        setPayErrorOwned(true);
        throw new Error(
          priorUncertain
            ? 'You already own one of these items, so it was taken out of your cart.' + UNCERTAIN_NOTE
            : 'You already own one of these items, so it was taken out of your cart. Nothing was charged.'
        );
      }
      if (res.status === 429) {
        // Rate-limited before anything was claimed or charged. The wait comes
        // from Retry-After when the server sent one.
        if (!priorUncertain) markSettled();
        else restoreEarlierUncertain();
        const secs = Number(res.headers.get('Retry-After'));
        const wait = Number.isFinite(secs) && secs > 0
          ? ` Try again in ${secs < 60 ? `${Math.ceil(secs)} seconds` : `about ${Math.ceil(secs / 60)} minute${Math.ceil(secs / 60) === 1 ? '' : 's'}`}.`
          : ' Try again in a moment.';
        throw new Error('Too many checkout attempts.' + wait + (priorUncertain ? UNCERTAIN_NOTE : ' Nothing was charged.'));
      }
      if ((res.status === 404 || res.status === 409) && data.listingId) {
        // That listing is gone (sold, removed, or its creator can't sell
        // right now). Nothing was charged; take it out of the cart.
        cart.remove(data.listingId);
        endIfCertain();
        throw new Error(
          `${data.error || 'An item is no longer available'} -- it has been removed from your cart.` +
            (priorUncertain ? UNCERTAIN_NOTE : ' Nothing was charged.')
        );
      }
      if (!res.ok) {
        // A 5xx may have committed first: pin the key so a retry is answered
        // DUPLICATE_CHECKOUT, not re-run, and ask straight away whether it
        // did. Any other refusal (402 not enough credits, 400, ...) keeps the
        // key too: the server claims a key only on commit, so reusing an
        // unclaimed one is harmless, and a changed cart rotates it through
        // the fingerprint anyway. Dropping it here is how a retry of a
        // committed checkout that hit 402 (the balance was already debited)
        // turned into a second charge after a top-up.
        if (res.status >= 500) {
          const rec = markUncertain();
          refreshBalance();
          if (await confirmAfterUnknown(rec)) return;
        } else if (!priorUncertain) {
          markSettled();
        } else {
          restoreEarlierUncertain();
        }
        throw new Error((data.error || 'Payment could not be confirmed') + (priorUncertain || res.status >= 500 ? UNCERTAIN_NOTE : ''));
      }
      endAttempt();
      const placed = Array.isArray(data.orders) ? data.orders : [];
      // A 200 is all-or-nothing: every listing sent was bought. Take out only
      // those (plus any the server names), never the whole cart as it is now.
      const paid = new Set(sentIds);
      for (const o of placed) if (o && o.listingId != null) paid.add(String(o.listingId));
      const live = cartItemsRef.current;
      const remaining = live.filter((it) => !paid.has(String(it.id)));
      if (remaining.length === 0) cart.clear();
      else for (const it of live) if (paid.has(String(it.id))) cart.remove(it.id);
      setUnpaidLeft(remaining.length);
      setPaidOrders(placed);
      if (Number.isFinite(data.balanceCents)) setBalanceCents(data.balanceCents);
      else refreshBalance();
    } catch (err) {
      setPayError(err.message || 'Payment failed');
    } finally {
      setPaying(false);
    }
  };

  if (alreadyProcessed) {
    return (
      <div className="min-h-screen bg-brand-ink text-white">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-lg mx-auto px-6 py-24 text-center">
          <SolidIcons.heart className="h-10 w-10 text-brand-pink mx-auto mb-4" />
          <h1 className="text-2xl font-black mb-2">Already paid</h1>
          <p className="text-gray-400 text-sm mb-8">
            This checkout already went through — the confirmation just didn&apos;t reach you. You weren&apos;t charged
            again. Your order is in your order history{balanceCents !== null ? `, and your balance is now ${formatCredits(balanceCents)}` : ''}.
          </p>
          <a href="/orders" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
            View orders
          </a>
        </div>
      </div>
    );
  }

  if (paidOrders) {
    return (
      <div className="min-h-screen bg-brand-ink text-white">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-lg mx-auto px-6 py-24 text-center">
          <SolidIcons.heart className="h-10 w-10 text-brand-pink mx-auto mb-4" />
          <h1 className="text-2xl font-black mb-2">Payment confirmed</h1>
          <p className="text-gray-400 text-sm mb-8">
            {paidOrders.length} {paidOrders.length === 1 ? 'order has' : 'orders have'} been placed. Find your digital
            items in your order history; physical items ship once the creator confirms your address.
          </p>
          {unpaidLeft > 0 && (
            <p className="text-xs text-gray-300 mb-8 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5">
              {unpaidLeft === 1 ? '1 item' : `${unpaidLeft} items`} you added while this payment was going through{' '}
              {unpaidLeft === 1 ? 'is' : 'are'} still in your cart and {unpaidLeft === 1 ? 'was' : 'were'} not
              purchased.{' '}
              <button
                type="button"
                onClick={() => { setPaidOrders(null); setUnpaidLeft(0); }}
                className="text-brand-pink underline font-bold"
              >
                Back to your cart
              </button>
            </p>
          )}
          <div className="flex items-center justify-center gap-3">
            <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
              Keep browsing
            </a>
            <a href="/orders" className="inline-block px-6 py-3 rounded-full border border-white/15 hover:bg-white/5 font-bold text-sm transition">
              View orders
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head>
        <title>Cart — OnlyOne</title>
      </Head>
      <div className="min-h-screen bg-brand-ink text-white pb-24">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-3xl mx-auto px-6 py-10">
          <div className="flex items-center justify-between mb-6">
            <h1 className="text-3xl font-black">Your Cart</h1>
            {sessionUser && (
              <div className="flex items-center gap-4">
                <a href="/orders" className="text-xs text-gray-400 hover:text-brand-pink transition">Order history</a>
                <a href="/credits" className="text-xs text-gray-400 hover:text-brand-pink transition">
                  Balance: <span className="font-bold text-white">{balanceCents === null ? (balanceError ? 'Unavailable' : '…') : formatCredits(balanceCents)}</span>
                </a>
              </div>
            )}
          </div>

          {!sessionUser && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <a href="/login?next=/cart" className="text-brand-pink underline font-bold">Log in</a> to check out.
            </div>
          )}

          {earlierPaid && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-green-500/30 bg-green-500/5 text-xs text-gray-300">
              Your earlier checkout went through -- the confirmation just didn&apos;t reach you, and you weren&apos;t
              charged twice.{' '}
              <a href="/orders" className="text-brand-pink underline font-bold">See it in your orders</a>. The items from
              that checkout were taken out of your cart
              {cart.items.length ? '; anything still below has not been paid for -- review it before paying' : ''}.
            </div>
          )}

          {sessionUser && uncertainAttempt && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300 flex items-center justify-between gap-3">
              <span>
                We couldn&apos;t confirm whether your last payment went through. Check before paying again -- or see your{' '}
                <a href="/orders" className="text-brand-pink underline">order history</a>.
              </span>
              <button
                onClick={checkStatus}
                disabled={checking || paying}
                className="shrink-0 px-3 py-1.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-white transition disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check payment status'}
              </button>
            </div>
          )}

          {cart.items.length === 0 ? (
            <div className="text-center py-20">
              <p className="text-gray-400 mb-5">Your cart is empty.</p>
              <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                Browse the marketplace
              </a>
            </div>
          ) : (
            <>
              <div className="space-y-3 mb-8">
                {cart.items.map((it) => (
                  <div key={it.id} className="flex items-center gap-3 p-3 rounded-xl bg-white/5 border border-white/5">
                    <div className="w-14 h-14 rounded-lg bg-black/40 shrink-0 overflow-hidden">
                      {it.img && <img src={it.img} alt="" className="w-full h-full object-cover blur-md" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate">{it.title}</p>
                      <p className="text-xs text-gray-500 truncate">{it.creatorName}{it.kind === 'physical' ? ' · ships' : ''}</p>
                    </div>
                    <p className="text-sm font-bold shrink-0">${(it.priceCents / 100).toFixed(2)}</p>
                    <button onClick={() => cart.remove(it.id)} className="shrink-0 text-gray-500 hover:text-red-400 transition p-1" title="Remove">
                      <Icons.close className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>

              <div className="rounded-xl bg-white/5 border border-white/5 p-4 mb-8 text-sm">
                <div className="flex justify-between text-gray-400 mb-1">
                  <span>Subtotal</span>
                  <span>${(cart.subtotalCents / 100).toFixed(2)}</span>
                </div>
                {cart.shippingCents > 0 && (
                  <div className="flex justify-between text-gray-400 mb-1">
                    <span>Shipping</span>
                    <span>${(cart.shippingCents / 100).toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-white pt-2 mt-2 border-t border-white/10">
                  <span>Total</span>
                  <span>{formatCredits(cart.totalCents)}</span>
                </div>
              </div>

              {cart.needsShipping && (
                <div className="mb-8">
                  <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">SHIPPING ADDRESS</p>
                  <div className="grid sm:grid-cols-2 gap-3">
                    {ADDRESS_FIELDS.map((f) => (
                      <input
                        key={f.key}
                        value={address[f.key] || ''}
                        onChange={(e) => setAddress((a) => ({ ...a, [f.key]: e.target.value }))}
                        placeholder={f.label}
                        className="px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60"
                      />
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-500 mt-3 leading-relaxed">
                    Your name and address are shared only with the creator who sells you this item, so they can
                    ship it. See our{' '}
                    <a href={`${MAIN_SITE}/privacy#shipping`} target="_blank" rel="noreferrer" className="text-brand-pink underline">
                      Privacy Policy
                    </a>
                    .
                  </p>
                </div>
              )}

              <div className="space-y-3 mb-8">
                <label className="flex items-start gap-2 text-xs text-gray-400">
                  <input type="checkbox" checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} className="mt-0.5" />
                  I am 18 years of age or older (or the age of majority in my jurisdiction, whichever is higher).
                </label>
                <label className="flex items-start gap-2 text-xs text-gray-400">
                  <input type="checkbox" checked={tosAccepted} onChange={(e) => setTosAccepted(e.target.checked)} className="mt-0.5" />
                  I've read and agree to the{' '}
                  <a href={`${MAIN_SITE}/terms#marketplace`} target="_blank" rel="noreferrer" className="text-brand-pink underline">
                    Marketplace Terms
                  </a>{' '}
                  — each purchase is an agreement directly between me and the creator; OnlyOne is not a party to
                  the sale, does not hold funds in escrow, and is not responsible for shipping, delivery, item
                  condition, or resolving disputes between us.
                </label>
              </div>

              {/* While an earlier payment's outcome is unknown, "you're short, buy
                  credits" is the wrong prompt: the shortfall may be that payment.
                  The banner above resolves it instead. */}
              {sessionUser && frozen && (
                <div className="mb-4 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/5 text-xs text-gray-300">
                  Your account&apos;s credits are frozen while it is suspended or banned, so checkout isn&apos;t
                  available. Contact{' '}
                  <a href="mailto:team@onlyone1.fun" className="text-brand-pink underline">team@onlyone1.fun</a> if you
                  think this is a mistake.
                </div>
              )}

              {sessionUser && !frozen && balanceCents !== null && !hasEnough && !uncertainAttempt && (
                <div className="mb-4 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300 flex items-center justify-between gap-3">
                  <span>You're short {formatCredits(cart.totalCents - balanceCents)}.</span>
                  <a href="/credits" className="shrink-0 px-3 py-1.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-white transition">
                    Buy credits
                  </a>
                </div>
              )}

              {sessionUser && !frozen && balanceCents === null && balanceError && (
                <p role="alert" className="text-xs text-red-400 text-center mb-3">
                  Couldn&apos;t load your balance, so Pay is unavailable for now.{' '}
                  <button type="button" onClick={refreshBalance} className="underline text-gray-300">Try again</button>
                </p>
              )}

              {payError && (
                <p className="text-xs text-red-400 text-center mb-3">
                  {payError}
                  {payErrorOwned && (
                    <> <a href="/orders" className="underline text-brand-pink">Find it in your orders</a></>
                  )}
                </p>
              )}

              {!frozen && (
                <button
                  onClick={pay}
                  disabled={!canCheckout || paying || checking}
                  className="w-full py-3.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition disabled:opacity-50"
                >
                  {paying ? 'Processing…' : `Pay ${formatCredits(cart.totalCents)}`}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
