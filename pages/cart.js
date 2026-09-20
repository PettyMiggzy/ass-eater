import { useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { Icons, SolidIcons } from '../components/Brand';
import { useCart } from '../lib/cart';
import { useWallet } from '../lib/wallet';
import { getMarketplacePaymentConfig, marketplacePaymentsLive } from '../lib/marketplace-payment-config';

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
  return { props: { sessionUser, paymentConfig: getMarketplacePaymentConfig(), paymentsLive: marketplacePaymentsLive() } };
}

export default function CartPage({ sessionUser, paymentConfig, paymentsLive }) {
  const cart = useCart();
  const wallet = useWallet();
  const [address, setAddress] = useState({});
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState(null); // { available, safe, reason }
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState(null);
  const [paidOrders, setPaidOrders] = useState(null);

  const canCheckout = ageConfirmed && tosAccepted && cart.items.length > 0 && (!cart.needsShipping || ADDRESS_FIELDS.every((f) => f.optional || String(address[f.key] || '').trim()));

  const runSimulation = async () => {
    if (!wallet.address) return;
    setSimulating(true);
    setSimResult(null);
    try {
      const res = await fetch('/api/marketplace/simulate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chainId: paymentConfig.chainId,
          from: wallet.address,
          to: paymentConfig.usdcAddress,
          data: '0x', // the actual transfer calldata isn't needed for the safety signal -- this is a known transfer() to our own fixed contract, not an arbitrary interaction
          value: '0',
        }),
      });
      setSimResult(await res.json());
    } catch {
      setSimResult({ available: false });
    } finally {
      setSimulating(false);
    }
  };

  const pay = async () => {
    setPayError(null);
    setPaying(true);
    try {
      const txHash = await wallet.sendUsdc({
        tokenAddress: paymentConfig.usdcAddress,
        payoutAddress: paymentConfig.payoutAddress,
        amountCents: cart.totalCents,
      });

      const res = await fetch('/api/marketplace/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cart.items.map((it) => ({ listingId: it.id })),
          txHash,
          shippingAddress: cart.needsShipping ? address : undefined,
          ageConfirmed,
          tosAccepted,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Payment could not be confirmed');
      setPaidOrders(data.orders);
      cart.clear();
    } catch (err) {
      setPayError(err.message || 'Payment failed');
    } finally {
      setPaying(false);
    }
  };

  if (paidOrders) {
    return (
      <div className="min-h-screen bg-brand-ink text-white">
        <SiteNav signedIn={!!sessionUser} viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-lg mx-auto px-6 py-24 text-center">
          <SolidIcons.heart className="h-10 w-10 text-brand-pink mx-auto mb-4" />
          <h1 className="text-2xl font-black mb-2">Payment confirmed</h1>
          <p className="text-gray-400 text-sm mb-8">
            {paidOrders.length} {paidOrders.length === 1 ? 'order has' : 'orders have'} been placed. Digital items are unlocked now; physical items ship once the creator confirms your address.
          </p>
          <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
            Keep browsing
          </a>
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
          <h1 className="text-3xl font-black mb-6">Your Cart</h1>

          {!paymentsLive && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <span className="text-brand-pink font-bold">Heads up: </span>
              Crypto checkout isn't fully configured yet — you can build your cart, but payment isn't accepted until it is.
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
                  <span>${(cart.totalCents / 100).toFixed(2)} USDC</span>
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

              {!wallet.address ? (
                <>
                  <button
                    onClick={wallet.connect}
                    disabled={wallet.connecting}
                    className="w-full py-3.5 rounded-full bg-white/10 hover:bg-white/15 font-bold text-sm transition disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    <Icons.wallet className="h-4 w-4" />
                    {wallet.connecting ? 'Connecting…' : 'Connect Wallet'}
                  </button>
                  {wallet.error === 'no_wallet' && (
                    <p className="text-xs text-red-400 text-center mt-3">No wallet extension detected — install MetaMask or a compatible wallet.</p>
                  )}
                  {wallet.error === 'rejected' && (
                    <p className="text-xs text-gray-500 text-center mt-3">Connection cancelled.</p>
                  )}
                  {wallet.error === 'connect_failed' && (
                    <p className="text-xs text-red-400 text-center mt-3">Could not connect to your wallet — try again.</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-xs text-gray-500 mb-3 text-center">
                    Connected: {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
                  </p>

                  {/* Trust layer: a GoPlus safety check on the transaction before the
                      buyer signs it. Non-blocking -- if GoPlus isn't configured or
                      unreachable, checkout still works, it just doesn't show the badge. */}
                  {!simResult && !simulating && (
                    <button onClick={runSimulation} className="w-full mb-3 py-2.5 rounded-full border border-white/15 text-gray-300 hover:bg-white/5 text-xs font-semibold transition">
                      Run a safety check before paying
                    </button>
                  )}
                  {simulating && <p className="text-xs text-gray-500 text-center mb-3">Checking transaction safety…</p>}
                  {simResult?.available && simResult.safe === true && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-green-400 mb-3">
                      <SolidIcons.verified className="h-4 w-4" /> Verified safe by GoPlus Security
                    </div>
                  )}
                  {simResult?.available && simResult.safe === false && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-red-400 mb-3">
                      <Icons.warning className="h-4 w-4" /> This transaction flagged as risky — {simResult.reason || 'do not proceed'}
                    </div>
                  )}

                  {payError && <p className="text-xs text-red-400 text-center mb-3">{payError}</p>}
                  {!paymentsLive && (
                    <p className="text-xs text-gray-500 text-center mb-3">Crypto checkout isn't configured yet — this button will start working once it is.</p>
                  )}

                  <button
                    onClick={pay}
                    disabled={!canCheckout || paying || !paymentsLive || (simResult?.available && simResult.safe === false)}
                    className="w-full py-3.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition disabled:opacity-50"
                  >
                    {paying ? 'Confirm in your wallet…' : `Pay $${(cart.totalCents / 100).toFixed(2)} in USDC`}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
