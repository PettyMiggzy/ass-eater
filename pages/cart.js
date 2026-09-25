import { useEffect, useState } from 'react';
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
// The key is bound to a fingerprint of what is being bought: a changed cart is
// a different agreement and gets a new key (reusing the old one would make the
// server report the new cart as "already processed" when it never was) --
// EXCEPT while the attempt is `uncertain` (a request whose outcome we never
// learned: network failure or 5xx). An uncertain attempt may already have
// committed, and the server's price/balance/availability prechecks run before
// it looks at the key, so a retry can come back 402 / PRICE_CHANGED /
// ALREADY_OWNED / unavailable for a checkout that DID go through. Rotating the
// key on any of those would let the fan pay a second time. So an uncertain
// key is kept (whatever the cart now looks like) until a definitive answer --
// success or DUPLICATE_CHECKOUT -- arrives. Reusing it is harmless if the
// first request never committed: the server only claims a key on commit.
const ATTEMPT_STORAGE_KEY = 'onlyone-checkout-attempt-v1';
const ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function cartFingerprint(items) {
  return JSON.stringify(
    items
      .map((it) => [String(it.id), it.priceCents, it.kind === 'physical' ? it.shippingCents || 0 : 0])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  );
}

function readAttempt() {
  try {
    const rec = JSON.parse(localStorage.getItem(ATTEMPT_STORAGE_KEY) || 'null');
    if (!rec || typeof rec.key !== 'string' || typeof rec.fp !== 'string') return null;
    if (!Number.isFinite(rec.at) || Date.now() - rec.at > ATTEMPT_MAX_AGE_MS) return null;
    return rec;
  } catch {
    return null;
  }
}

function writeAttempt(rec) {
  try { localStorage.setItem(ATTEMPT_STORAGE_KEY, JSON.stringify(rec)); } catch { /* storage unavailable: in-memory only */ }
}

function clearAttempt() {
  try { localStorage.removeItem(ATTEMPT_STORAGE_KEY); } catch { /* ignore */ }
}

export default function CartPage({ sessionUser }) {
  const cart = useCart();
  const [balanceCents, setBalanceCents] = useState(null);
  // One key per checkout ATTEMPT, reused across retries of the same
  // submission (a network drop, a lost response, a reload) so the server can
  // tell "resending the same attempt" apart from "starting a new one". Held in
  // a ref-like in-memory copy too, for when localStorage is unavailable. It is
  // dropped (and a new one minted next time) only after success, a
  // DUPLICATE_CHECKOUT answer, or a refusal that proves nothing was charged
  // while no earlier request is unaccounted for -- see the note above
  // readAttempt/writeAttempt.
  const [memAttempt, setMemAttempt] = useState(null);
  const [address, setAddress] = useState({});
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);
  // Set with payError when the refusal is "you already own this": the fix is
  // in /orders, so the message links there.
  const [payErrorOwned, setPayErrorOwned] = useState(false);
  const [paidOrders, setPaidOrders] = useState(null);
  // Set when the server says this exact checkout already went through (the
  // first response was lost): the fan has paid, so show that, not an error.
  const [alreadyProcessed, setAlreadyProcessed] = useState(false);

  const refreshBalance = () =>
    fetch('/api/credits/balance')
      .then((r) => r.json())
      .then((d) => setBalanceCents(d.balanceCents ?? 0))
      .catch(() => {});

  useEffect(() => {
    if (!sessionUser) return;
    refreshBalance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser]);

  const hasEnough = balanceCents !== null && balanceCents >= cart.totalCents;
  const canCheckout =
    !!sessionUser &&
    hasEnough &&
    ageConfirmed &&
    tosAccepted &&
    cart.items.length > 0 &&
    (!cart.needsShipping || ADDRESS_FIELDS.every((f) => f.optional || String(address[f.key] || '').trim()));

  // Forget the current attempt: the next Pay starts a new agreement.
  const endAttempt = () => {
    clearAttempt();
    setMemAttempt(null);
  };

  const pay = async () => {
    setPayError(null);
    setPayErrorOwned(false);
    setPaying(true);
    const fp = cartFingerprint(cart.items);
    const stored = readAttempt() || memAttempt;
    const attempt =
      stored && (stored.fp === fp || stored.uncertain)
        ? stored
        : { key: newIdempotencyKey(), fp, at: Date.now(), uncertain: false };
    writeAttempt(attempt);
    setMemAttempt(attempt);
    const idempotencyKey = attempt.key;
    // The outcome of this request may be unknown (lost response / 5xx): pin
    // the key so no later refusal can rotate it. See the note at the top.
    const markUncertain = () => {
      const rec = { ...attempt, uncertain: true };
      writeAttempt(rec);
      setMemAttempt(rec);
    };
    // A refusal is only proof that nothing was charged when no earlier request
    // under this key is unaccounted for.
    const priorUncertain = !!attempt.uncertain;
    const UNCERTAIN_NOTE =
      ' An earlier payment attempt for this cart may already have gone through -- check your order history before paying again. Pressing Pay again is safe and won\'t charge you twice for that attempt.';
    // Forget the attempt after a definitive refusal -- unless an earlier
    // request under this key is unaccounted for, in which case keep it.
    const endIfCertain = () => {
      if (!priorUncertain) endAttempt();
    };
    try {
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
          }),
        });
      } catch {
        // The request may or may not have reached the server. The attempt
        // (and its key) is kept and pinned, so pressing Pay again -- even
        // after a reload, a price change or a top-up -- can't place a second
        // order. Refresh the balance so a debit that did happen shows.
        markUncertain();
        refreshBalance();
        throw new Error("We couldn't confirm whether your payment went through. Check your order history — pressing Pay again is safe and won't charge you twice.");
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === 'DUPLICATE_CHECKOUT') {
        // This exact checkout already went through; only its response was
        // lost. The fan has paid: clear the cart, refresh the balance, and
        // point at the orders -- never leave paid items sitting in the cart.
        endAttempt();
        cart.clear();
        refreshBalance();
        setAlreadyProcessed(true);
        return;
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
        // DUPLICATE_CHECKOUT, not re-run. Any other refusal (402 not enough
        // credits, 400, ...) keeps the key too: the server claims a key only on
        // commit, so reusing an unclaimed one is harmless, and a changed cart
        // rotates it through the fingerprint anyway. Dropping it here is how a
        // retry of a committed checkout that hit 402 (the balance was already
        // debited) turned into a second charge after a top-up.
        if (res.status >= 500) {
          markUncertain();
          refreshBalance();
        }
        throw new Error((data.error || 'Payment could not be confirmed') + (priorUncertain ? UNCERTAIN_NOTE : ''));
      }
      endAttempt();
      setPaidOrders(Array.isArray(data.orders) ? data.orders : []);
      setBalanceCents(data.balanceCents);
      cart.clear();
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
                  Balance: <span className="font-bold text-white">{balanceCents === null ? '…' : formatCredits(balanceCents)}</span>
                </a>
              </div>
            )}
          </div>

          {!sessionUser && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <a href="/login?next=/cart" className="text-brand-pink underline font-bold">Log in</a> to check out.
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

              {sessionUser && balanceCents !== null && !hasEnough && (
                <div className="mb-4 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300 flex items-center justify-between gap-3">
                  <span>You're short {formatCredits(cart.totalCents - balanceCents)}.</span>
                  <a href="/credits" className="shrink-0 px-3 py-1.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-white transition">
                    Buy credits
                  </a>
                </div>
              )}

              {payError && (
                <p className="text-xs text-red-400 text-center mb-3">
                  {payError}
                  {payErrorOwned && (
                    <> <a href="/orders" className="underline text-brand-pink">Find it in your orders</a></>
                  )}
                </p>
              )}

              <button
                onClick={pay}
                disabled={!canCheckout || paying}
                className="w-full py-3.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition disabled:opacity-50"
              >
                {paying ? 'Processing…' : `Pay ${formatCredits(cart.totalCents)}`}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
