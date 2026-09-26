import { useEffect, useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { formatCredits } from '../lib/brand';
import { Icons, SolidIcons } from '../components/Brand';
import { useWallet } from '../lib/wallet';
import {
  getMarketplacePaymentConfig,
  getMarketplaceVerificationConfig,
  marketplaceVerificationLive,
  safetyCheckAvailable,
} from '../lib/marketplace-payment-config';
import { FEES, MIN_DEPOSIT_CENTS } from '../lib/fees';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  if (!sessionUser) {
    return { redirect: { destination: '/login?next=/credits', permanent: false } };
  }
  // marketplaceVerificationLive() (payoutAddress + usdcAddress + chainId +
  // MARKETPLACE_RPC_URL), not the narrower marketplacePaymentsLive() -- this
  // page's Buy/recovery buttons must be disabled in EXACTLY the case where
  // the server-side pages/api/credits/buy.js would 501. Using the narrower
  // check let a config missing only the server-only RPC URL render both
  // buttons as enabled right up until the click failed.
  return {
    props: {
      sessionUser,
      paymentConfig: getMarketplacePaymentConfig(),
      paymentsLive: marketplaceVerificationLive(getMarketplaceVerificationConfig()),
    },
  };
}

const PRESETS = [1000, 2500, 5000, 10000]; // cents

export default function CreditsPage({ sessionUser, paymentConfig, paymentsLive }) {
  const wallet = useWallet();
  const [balanceCents, setBalanceCents] = useState(null);
  const [amountCents, setAmountCents] = useState(2500);
  const [customAmount, setCustomAmount] = useState('');
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [simulating, setSimulating] = useState(false);
  const [simResult, setSimResult] = useState(null);
  const [showRecovery, setShowRecovery] = useState(false);
  const [recoverHash, setRecoverHash] = useState('');
  const [recovering, setRecovering] = useState(false);
  const [recoverError, setRecoverError] = useState(null);
  // A suspended or banned creator account's credits are frozen: the server
  // refuses the nonce, the wallet proof and the buy (403 ACCOUNT_FROZEN), so
  // the page says so up front instead of offering a Pay button that can only
  // fail -- or, worse, fail AFTER the wallet has been asked to sign.
  const [frozen, setFrozen] = useState(false);
  // This is the one page where a fan pays real money, and credit purchases
  // are final (Terms §5). The terms have to be in front of them at the moment
  // of payment -- not only on /terms and /get-crypto, which a buyer arriving
  // from the cart never passes through -- so Pay stays disabled until they
  // tick that they've read it.
  const [finalityAck, setFinalityAck] = useState(false);

  const loadBalance = () => {
    fetch('/api/credits/balance')
      .then((r) => r.json())
      .then((d) => {
        setBalanceCents(d.balanceCents ?? 0);
        setFrozen(d.frozen === true);
      })
      .catch(() => {});
  };

  // Every credits endpoint answers a frozen account with 403 code
  // ACCOUNT_FROZEN; latch the page into the frozen state when one does.
  const frozenError = (res, data, fallback) => {
    if (res.status === 403 && data?.code === 'ACCOUNT_FROZEN') setFrozen(true);
    return new Error(data?.error || fallback);
  };
  useEffect(loadBalance, []);

  const feeCents = Math.floor((amountCents * FEES.DEPOSIT_BPS) / 10_000);
  const netCents = amountCents - feeCents;
  // Refused BEFORE anything is sent: the server won't credit a transfer
  // under the minimum, and a transaction's amount can never be changed
  // afterwards, so sending one would simply lose the money.
  const belowMinimum = !Number.isInteger(amountCents) || amountCents < MIN_DEPOSIT_CENTS;
  const canSimulate = safetyCheckAvailable(paymentConfig.chainId);

  const runSimulation = async () => {
    if (!wallet.address || belowMinimum) return;
    setSimulating(true);
    setSimResult(null);
    try {
      // The server builds the real transfer(payout, amount) itself from its
      // own config; the page only says who is paying and how much.
      const res = await fetch('/api/marketplace/simulate-tx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: wallet.address, amountCents }),
      });
      setSimResult(res.ok ? await res.json() : { available: true, safe: null, reason: 'Safety check failed to run' });
    } catch {
      setSimResult({ available: true, safe: null, reason: 'Could not reach the safety check' });
    } finally {
      setSimulating(false);
    }
  };

  // Proves the connected wallet is yours BEFORE anything is sent: the
  // server checks the signature now (and remembers the proven address for
  // two hours in an httpOnly cookie), so an expired challenge or a wallet
  // whose signature doesn't verify is caught while nothing has moved.
  // Returns the proven address.
  const proveWallet = async () => {
    if (!wallet.address) {
      const acct = await wallet.connect();
      if (!acct) throw new Error(wallet.error === 'no_wallet' ? 'No wallet extension detected' : 'Could not connect wallet');
    }
    const nonceRes = await fetch('/api/credits/wallet-nonce');
    const nonceData = await nonceRes.json().catch(() => ({}));
    if (!nonceRes.ok) throw frozenError(nonceRes, nonceData, 'Could not start wallet verification');
    const { address, signature } = await wallet.signMessageWithAddress(nonceData.message);
    const res = await fetch('/api/credits/verify-wallet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, signature }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw frozenError(res, data, 'Could not verify your wallet');
    return data.address;
  };

  const submitPayment = async (txHash) => {
    const res = await fetch('/api/credits/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = frozenError(res, data, 'Could not confirm payment');
      err.code = typeof data?.code === 'string' ? data.code : null;
      throw err;
    }
    return data;
  };

  const buy = async () => {
    setError(null);
    if (frozen) return;
    if (!finalityAck) {
      setError('Confirm you understand credit purchases are final first.');
      return;
    }
    if (belowMinimum) {
      setError(`The minimum is $${(MIN_DEPOSIT_CENTS / 100).toFixed(2)}.`);
      return;
    }
    setBuying(true);
    let sentHash = null;
    try {
      const proven = await proveWallet();
      sentHash = await wallet.sendUsdc({
        tokenAddress: paymentConfig.usdcAddress,
        payoutAddress: paymentConfig.payoutAddress,
        amountCents,
        decimals: paymentConfig.usdcDecimals,
        chainId: paymentConfig.chainId,
        chainName: paymentConfig.chainName,
        rpcUrl: paymentConfig.publicRpcUrl,
        nativeSymbol: paymentConfig.nativeSymbol,
        expectedFrom: proven,
      });
      const data = await submitPayment(sentHash);
      if (Number.isFinite(data.balanceCents)) setBalanceCents(data.balanceCents);
      if (data.alreadyCredited) loadBalance();
      setResult(data);
    } catch (err) {
      if (sentHash) {
        // The USDG has already left the wallet. Never say "try again" here
        // -- pressing Pay again sends a second payment. Hand the hash to
        // the recovery box instead, which credits THIS transaction.
        setRecoverHash(sentHash);
        setShowRecovery(true);
        setError(`Your payment was sent but isn’t credited yet (${err.message || 'confirmation failed'}). Don’t pay again -- use “Verify this transaction” below.`);
      } else {
        setError(err.message || 'Something went wrong');
      }
    } finally {
      setBuying(false);
    }
  };

  // Recovery path: the payment already went out on-chain (tab closed,
  // wallet crashed, network dropped right after broadcasting, or the
  // confirmation above failed) but the credit call never succeeded.
  // /api/credits/buy is safe to call again for a real, unclaimed txHash --
  // this retries it without re-sending money.
  const recover = async () => {
    setRecoverError(null);
    setRecovering(true);
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(recoverHash.trim())) {
        throw new Error('That doesn’t look like a transaction hash (should start with 0x, 66 characters total)');
      }
      // Asked WITHOUT a fresh wallet proof first: /api/credits/buy answers a
      // hash already credited to this account (alreadyCredited, plus frozen
      // and a note for a frozen account) before it asks for any proof, and a
      // still-valid proof from earlier is read from its cookie. So a fan
      // whose payment was in fact credited -- or whose wallet is no longer to
      // hand -- is not made to connect and sign just to hear that. Only a
      // PROOF_REQUIRED answer (nothing credited, no valid proof) leads to the
      // wallet signature and one retry. So does SENDER_MISMATCH: a proof from
      // earlier (the cookie lasts 2h) may be for a different wallet than the
      // one this payment was sent from, and re-proving with the wallet now
      // connected replaces it. A frozen account can't prove a wallet (the
      // nonce is refused) and is never asked to.
      const hash = recoverHash.trim();
      let data;
      try {
        data = await submitPayment(hash);
      } catch (err) {
        if (frozen || (err.code !== 'PROOF_REQUIRED' && err.code !== 'SENDER_MISMATCH')) throw err;
        await proveWallet();
        data = await submitPayment(hash);
      }
      // alreadyCredited: this hash was credited to this account before (a
      // retry after a lost response). That is a success -- show it as one
      // and re-read the balance, which may have moved since.
      if (Number.isFinite(data.balanceCents)) setBalanceCents(data.balanceCents);
      if (data.alreadyCredited) loadBalance();
      setResult(data);
      setShowRecovery(false);
    } catch (err) {
      setRecoverError(err.message || 'Could not recover that payment');
    } finally {
      setRecovering(false);
    }
  };

  return (
    <>
      <Head>
        <title>Buy Credits — OnlyOne</title>
      </Head>
      <div className="min-h-screen bg-brand-ink text-white pb-24">
        <SiteNav signedIn viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-lg mx-auto px-6 py-10">
          <h1 className="text-3xl font-black mb-2">Buy Credits</h1>
          <p className="text-sm text-gray-400 mb-6">
            1 credit = $1. Buy once with a crypto wallet, then spend credits on Marketplace items and messages to
            creators with no wallet needed. Tips and subscriptions aren&apos;t available yet.
          </p>

          <div className="rounded-xl bg-white/5 border border-white/5 p-4 mb-6 flex items-center justify-between">
            <span className="text-sm text-gray-400">Your balance</span>
            <span className="font-bold">{balanceCents === null ? '…' : formatCredits(balanceCents)}</span>
          </div>

          {frozen && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-red-500/30 bg-red-500/10 text-xs text-red-300">
              This account is suspended or banned, so its credits are frozen and buying credits is closed for it. Don&apos;t
              send a payment — it can&apos;t be credited. Email{' '}
              <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a> if you think this is a mistake.
            </div>
          )}

          {!paymentsLive && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <span className="text-brand-pink font-bold">Heads up: </span>
              Buying credits isn't configured yet.
            </div>
          )}

          {result ? (
            <div className="text-center py-10">
              <p className="text-lg font-bold mb-2">
                {result.alreadyCredited ? 'Already credited: ' : 'Credited '}
                {formatCredits(Number(result.creditedCents) || 0)}
              </p>
              {result.alreadyCredited && (
                <p className="text-xs text-gray-400 mb-2">
                  This payment was added to your account earlier, so nothing more was added now. Your balance has been refreshed.
                </p>
              )}
              {result.frozen && (
                <p className="text-xs text-red-300 mb-2">
                  {typeof result.note === 'string' && result.note
                    ? result.note
                    : 'Your balance is frozen while the account is suspended or banned.'}
                </p>
              )}
              <p className="text-xs text-gray-500 mb-2">(${((Number(result.feeCents) || 0) / 100).toFixed(2)} kept as the {FEES.DEPOSIT_BPS / 100}% deposit fee)</p>
              <p className="text-xs text-gray-500 mb-6">
                Credits are final: they don&apos;t expire, and they can&apos;t be refunded or cashed out.
              </p>
              {!result.frozen && (
                <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                  Start spending
                </a>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">AMOUNT</p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => { setAmountCents(p); setCustomAmount(''); setSimResult(null); }}
                    className={`py-2.5 rounded-lg text-sm font-bold border transition ${
                      amountCents === p && !customAmount ? 'bg-brand-pink border-brand-pink text-white' : 'border-white/15 text-gray-300 hover:bg-white/5'
                    }`}
                  >
                    ${(p / 100).toFixed(0)}
                  </button>
                ))}
              </div>
              <input
                value={customAmount}
                onChange={(e) => {
                  setCustomAmount(e.target.value);
                  setSimResult(null); // a check for a different amount says nothing about this one
                  const n = Math.round(Number(e.target.value) * 100);
                  // Kept even when under the minimum, so the page can SAY so
                  // and keep Pay disabled -- silently leaving the previous
                  // preset selected would pay an amount nobody typed.
                  setAmountCents(Number.isSafeInteger(n) && n > 0 ? n : 0);
                }}
                placeholder="Or enter a custom amount ($)"
                className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60 mb-6"
              />

              <div className="rounded-xl bg-white/5 border border-white/5 p-4 mb-6 text-sm">
                <div className="flex justify-between text-gray-400 mb-1">
                  <span>You pay</span>
                  <span>${(amountCents / 100).toFixed(2)} {paymentConfig.stableSymbol}</span>
                </div>
                <div className="flex justify-between text-gray-400 mb-1">
                  <span>Deposit fee ({FEES.DEPOSIT_BPS / 100}%)</span>
                  <span>-${(feeCents / 100).toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-bold text-white pt-2 mt-2 border-t border-white/10">
                  <span>You get</span>
                  <span>{formatCredits(netCents)}</span>
                </div>
              </div>

              {belowMinimum && (
                <p className="text-xs text-red-400 text-center mb-3">
                  The minimum is ${(MIN_DEPOSIT_CENTS / 100).toFixed(2)} -- smaller payments can’t be credited.
                </p>
              )}

              {/* The safety check only exists on networks GoPlus can simulate.
                  On any other network it says so, rather than offering a
                  button that quietly does nothing and reads as a pass. */}
              {wallet.address && !canSimulate && (
                <p className="text-[11px] text-gray-500 text-center mb-3">
                  An independent transaction safety check isn’t available on {paymentConfig.chainName || 'this network'}.
                </p>
              )}
              {wallet.address && canSimulate && (
                <>
                  {!simResult && !simulating && (
                    <button onClick={runSimulation} disabled={belowMinimum} className="w-full mb-3 py-2.5 rounded-full border border-white/15 text-gray-300 hover:bg-white/5 text-xs font-semibold transition disabled:opacity-50">
                      Run a safety check before paying
                    </button>
                  )}
                  {simulating && <p className="text-xs text-gray-500 text-center mb-3">Checking transaction safety…</p>}
                  {simResult && !simResult.available && (
                    <p className="text-xs text-gray-400 text-center mb-3">Safety check unavailable on this network.</p>
                  )}
                  {simResult?.available && simResult.safe === true && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-green-400 mb-3">
                      <SolidIcons.verified className="h-4 w-4" /> Verified safe by GoPlus Security
                    </div>
                  )}
                  {simResult?.available && simResult.safe === null && (
                    <p className="text-xs text-gray-400 text-center mb-3">
                      Safety check inconclusive{simResult.reason ? ` — ${simResult.reason}` : ''}. This is not a pass.
                    </p>
                  )}
                  {simResult?.available && simResult.safe === false && (
                    <div className="flex items-center justify-center gap-1.5 text-xs text-red-400 mb-3">
                      <Icons.warning className="h-4 w-4" /> This transaction flagged as risky — {simResult.reason || 'do not proceed'}
                    </div>
                  )}
                </>
              )}

              {error && <p className="text-xs text-red-400 text-center mb-3">{error}</p>}
              {wallet.error === 'no_wallet' && (
                <p className="text-xs text-red-400 text-center mb-3">No wallet extension detected — install MetaMask or a compatible wallet.</p>
              )}

              <div className="mb-4 px-4 py-3 rounded-xl border border-white/10 bg-white/5 text-xs text-gray-300 leading-relaxed">
                <p className="mb-2">
                  <span className="font-bold text-white">Credits are final.</span> They&apos;re non-refundable, can&apos;t be
                  cashed back out or transferred to anyone, and never expire. Right now they can be spent on Marketplace
                  items and messages to creators only. See{' '}
                  <a href="/terms#payments" target="_blank" rel="noreferrer" className="text-brand-pink underline">
                    Terms §5
                  </a>
                  .
                </p>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={finalityAck}
                    onChange={(e) => setFinalityAck(e.target.checked)}
                    className="mt-0.5"
                  />
                  I understand credit purchases are final and non-refundable, and that credits can&apos;t be cashed out.
                </label>
              </div>

              <button
                onClick={buy}
                disabled={buying || frozen || !paymentsLive || belowMinimum || !finalityAck || (simResult?.available && simResult.safe === false)}
                className="w-full py-3.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Icons.wallet className="h-4 w-4" />
                {buying ? 'Confirm in your wallet…' : wallet.address ? `Pay $${(amountCents / 100).toFixed(2)}` : 'Connect Wallet & Pay'}
              </button>

              <div className="mt-6 pt-5 border-t border-white/10">
                {!showRecovery ? (
                  <button onClick={() => setShowRecovery(true)} className="w-full text-xs text-gray-500 hover:text-gray-300 transition">
                    Already paid but didn't get credited?
                  </button>
                ) : (
                  <div>
                    <p className="text-xs text-gray-400 mb-2">
                      If USDG already left your wallet but the page closed before it confirmed, paste that transaction's hash below and we'll check the chain again — nothing is charged twice.
                    </p>
                    {frozen && (
                      <p className="text-xs text-gray-400 mb-2">
                        While this account is frozen nothing new can be credited; this only checks whether a payment was already added to your balance.
                      </p>
                    )}
                    <input
                      value={recoverHash}
                      onChange={(e) => setRecoverHash(e.target.value)}
                      placeholder="0x…"
                      className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60 mb-2"
                    />
                    {recoverError && <p className="text-xs text-red-400 mb-2">{recoverError}</p>}
                    <button
                      onClick={recover}
                      disabled={recovering || !recoverHash.trim() || !paymentsLive}
                      className="w-full py-2.5 rounded-full border border-white/15 text-gray-300 hover:bg-white/5 text-xs font-semibold transition disabled:opacity-50"
                    >
                      {recovering ? 'Checking…' : 'Verify this transaction'}
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
