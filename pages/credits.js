import { useEffect, useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { formatCredits } from '../lib/brand';
import { Icons, SolidIcons } from '../components/Brand';
import { useWallet } from '../lib/wallet';
import { getMarketplacePaymentConfig, marketplacePaymentsLive } from '../lib/marketplace-payment-config';
import { FEES } from '../lib/fees';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  if (!sessionUser) {
    return { redirect: { destination: '/login?next=/credits', permanent: false } };
  }
  return { props: { sessionUser, paymentConfig: getMarketplacePaymentConfig(), paymentsLive: marketplacePaymentsLive() } };
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

  const loadBalance = () => {
    fetch('/api/credits/balance')
      .then((r) => r.json())
      .then((d) => setBalanceCents(d.balanceCents ?? 0))
      .catch(() => {});
  };
  useEffect(loadBalance, []);

  const feeCents = Math.floor((amountCents * FEES.DEPOSIT_BPS) / 10_000);
  const netCents = amountCents - feeCents;

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
          data: '0x', // the safety signal covers a known transfer() to our own fixed address, not an arbitrary contract interaction
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

  // Proves the connected wallet is the one about to pay (or that already
  // paid, for recovery) before the server will trust a txHash's sender.
  // Two wallet prompts by design: sign, then send -- see lib/wallet-auth.js.
  const signDepositProof = async () => {
    const nonceRes = await fetch('/api/credits/wallet-nonce');
    const nonceData = await nonceRes.json();
    if (!nonceRes.ok) throw new Error(nonceData.error || 'Could not start wallet verification');
    return wallet.signMessage(nonceData.message);
  };

  const submitPayment = async (txHash, signature) => {
    const res = await fetch('/api/credits/buy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ txHash, signature }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not confirm payment');
    return data;
  };

  const buy = async () => {
    setError(null);
    setBuying(true);
    try {
      if (!wallet.address) {
        const acct = await wallet.connect();
        if (!acct) throw new Error(wallet.error === 'no_wallet' ? 'No wallet extension detected' : 'Could not connect wallet');
      }
      const signature = await signDepositProof();
      const txHash = await wallet.sendUsdc({
        tokenAddress: paymentConfig.usdcAddress,
        payoutAddress: paymentConfig.payoutAddress,
        amountCents,
        decimals: paymentConfig.usdcDecimals,
        chainId: paymentConfig.chainId,
        chainName: paymentConfig.chainName,
        rpcUrl: paymentConfig.publicRpcUrl,
        nativeSymbol: paymentConfig.nativeSymbol,
      });
      const data = await submitPayment(txHash, signature);
      setBalanceCents(data.balanceCents);
      setResult(data);
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBuying(false);
    }
  };

  // Recovery path: the payment already went out on-chain (tab closed,
  // wallet crashed, network dropped right after broadcasting) but the
  // credit call never ran. /api/credits/buy is safe to call again for a
  // real, unclaimed txHash -- this just gives a fan a way to retry it
  // without re-sending money.
  const recover = async () => {
    setRecoverError(null);
    setRecovering(true);
    try {
      if (!/^0x[0-9a-fA-F]{64}$/.test(recoverHash.trim())) {
        throw new Error('That doesn’t look like a transaction hash (should start with 0x, 66 characters total)');
      }
      if (!wallet.address) {
        const acct = await wallet.connect();
        if (!acct) throw new Error(wallet.error === 'no_wallet' ? 'No wallet extension detected' : 'Could not connect wallet');
      }
      const signature = await signDepositProof();
      const data = await submitPayment(recoverHash.trim(), signature);
      setBalanceCents(data.balanceCents);
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
            1 credit = $1. Buy once with a crypto wallet, then spend anywhere on OnlyOne with no wallet needed.
          </p>

          <div className="rounded-xl bg-white/5 border border-white/5 p-4 mb-6 flex items-center justify-between">
            <span className="text-sm text-gray-400">Your balance</span>
            <span className="font-bold">{balanceCents === null ? '…' : formatCredits(balanceCents)}</span>
          </div>

          {!paymentsLive && (
            <div className="mb-6 px-4 py-3 rounded-xl border border-brand-pink/25 bg-brand-pink/5 text-xs text-gray-300">
              <span className="text-brand-pink font-bold">Heads up: </span>
              Buying credits isn't configured yet.
            </div>
          )}

          {result ? (
            <div className="text-center py-10">
              <p className="text-lg font-bold mb-2">Credited {formatCredits(result.creditedCents)}</p>
              <p className="text-xs text-gray-500 mb-6">(${(result.feeCents / 100).toFixed(2)} kept as the {FEES.DEPOSIT_BPS / 100}% deposit fee)</p>
              <a href="/marketplace" className="inline-block px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition">
                Start spending
              </a>
            </div>
          ) : (
            <>
              <p className="text-xs font-bold tracking-widest text-gray-400 mb-3">AMOUNT</p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    onClick={() => { setAmountCents(p); setCustomAmount(''); }}
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
                  const n = Math.round(Number(e.target.value) * 100);
                  if (Number.isFinite(n) && n > 0) setAmountCents(n);
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

              {wallet.address && (
                <>
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
                </>
              )}

              {error && <p className="text-xs text-red-400 text-center mb-3">{error}</p>}
              {wallet.error === 'no_wallet' && (
                <p className="text-xs text-red-400 text-center mb-3">No wallet extension detected — install MetaMask or a compatible wallet.</p>
              )}

              <button
                onClick={buy}
                disabled={buying || !paymentsLive || amountCents <= 0 || (simResult?.available && simResult.safe === false)}
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
                    <input
                      value={recoverHash}
                      onChange={(e) => setRecoverHash(e.target.value)}
                      placeholder="0x…"
                      className="w-full px-4 py-2.5 rounded-full bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60 mb-2"
                    />
                    {recoverError && <p className="text-xs text-red-400 mb-2">{recoverError}</p>}
                    <button
                      onClick={recover}
                      disabled={recovering || !recoverHash.trim()}
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
