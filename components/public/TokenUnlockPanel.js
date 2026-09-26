import { useState } from 'react';
import { useRouter } from 'next/router';
import { SolidIcons } from '../Brand';
import { hasInjectedWallet, signWithProvider } from '../../lib/wallet';

/**
 * The real way into a token-gated creator (lib/token-gate.js,
 * lib/holder-access.js, pages/api/token-gate/*):
 *
 *   GET  /api/token-gate/nonce   -> { message }   (one-time challenge)
 *   personal_sign(message)       -> the wallet proves it controls the address
 *   POST /api/token-gate/verify  -> server reads balanceOf on its own RPC and
 *                                   sets a signed, 1-hour oa_holder cookie
 *   reload                       -> getServerSideProps decides again, and only
 *                                   now sends media srcs if the balance is enough
 *
 * Nothing is spent or approved and no balance is ever reported by the
 * browser -- the server reads it. This component only runs the ceremony and
 * says, per `gate.reason`, why the viewer is or is not in.
 *
 * `gate` is the server's decision for THIS viewer: { allowed, reason,
 * required, held? } from holderGateState().
 */
export default function TokenUnlockPanel({ gate, gateLabel, tokenLive, compact = false }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reason = gate?.reason;
  const required = Number(gate?.required || 0);

  const readError = async (res) => {
    try {
      const data = await res.json();
      if (data && typeof data.error === 'string') return data.error;
    } catch {
      // not JSON -- fall through
    }
    if (res.status === 501 || res.status === 502) return 'Unlocking is temporarily unavailable. Please try again shortly.';
    if (res.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
    return 'Something went wrong. Please try again.';
  };

  const unlock = async () => {
    setError('');
    if (!hasInjectedWallet()) {
      setError('No wallet found. Open this page in a browser with a wallet extension (for example MetaMask) or in your wallet app’s browser.');
      return;
    }
    setBusy(true);
    try {
      const nonceRes = await fetch('/api/token-gate/nonce', { credentials: 'same-origin' });
      if (!nonceRes.ok) throw new Error(await readError(nonceRes));
      const { message } = await nonceRes.json();
      if (typeof message !== 'string' || !message) throw new Error('Something went wrong. Please try again.');

      let signed;
      try {
        signed = await signWithProvider(window.ethereum, message);
      } catch (err) {
        // 4001 = the person pressed Cancel in their wallet; not an error to shout about.
        if (err?.code === 4001 || /reject|denied/i.test(String(err?.message || ''))) {
          throw new Error('Signature cancelled. Nothing was signed.');
        }
        throw new Error('Your wallet could not sign the message. Please try again.');
      }

      const verifyRes = await fetch('/api/token-gate/verify', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: signed.address, signature: signed.signature }),
      });
      if (!verifyRes.ok) throw new Error(await readError(verifyRes));
      // The server decides again with the new pass; a balance below the bar
      // comes back as reason 'holds_too_few' in the reloaded props.
      await router.replace(router.asPath, undefined, { scroll: false });
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/token-gate/clear', { method: 'POST', credentials: 'same-origin' });
      // A non-2xx answer did not clear the holder cookie: not a success.
      if (!res.ok) throw new Error('clear_failed');
      await router.replace(router.asPath, undefined, { scroll: false });
    } catch {
      setError('Could not disconnect. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  let headline = `Hold ${gateLabel} to unlock`;
  let detail = 'Connect a wallet and sign a one-time message. Nothing is spent or approved — we only read your $ONLYONE balance.';
  let canTry = true;
  let showDisconnect = false;

  if (!tokenLive || reason === 'not_live') {
    detail = 'Unlocks when $ONLYONE launches.';
    canTry = false;
  } else if (reason === 'verifier_unavailable') {
    detail = 'Unlocking is temporarily unavailable. Please check back soon.';
    canTry = false;
  } else if (reason === 'holds_too_few') {
    // Fixed 'en-US' so the server render and the browser print the same
    // digits (a viewer's own locale here was a hydration mismatch).
    const held = gate?.held != null ? Number(gate.held).toLocaleString('en-US') : '0';
    headline = `You hold ${held} $ONLYONE`;
    detail = `This creator requires ${required.toLocaleString('en-US')} $ONLYONE. Top up that wallet, or verify a different one.`;
    showDisconnect = true;
  }

  return (
    <div id="unlock" className={`flex flex-col items-center justify-center gap-2 text-center ${compact ? '' : 'px-4'}`}>
      <span className="w-12 h-12 rounded-full bg-black/60 flex items-center justify-center text-white">
        <SolidIcons.lock className="h-5 w-5" />
      </span>
      <p className="font-semibold">{headline}</p>
      <p className="text-xs text-gray-300 max-w-sm">{detail}</p>
      {canTry && (
        <button
          onClick={unlock}
          disabled={busy}
          className="mt-1 px-5 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white text-sm font-bold transition disabled:opacity-50"
        >
          {busy ? 'Check your wallet…' : reason === 'holds_too_few' ? 'Verify another wallet' : 'Connect wallet & unlock'}
        </button>
      )}
      {showDisconnect && (
        <button onClick={disconnect} disabled={busy} className="text-xs text-gray-400 hover:text-white underline disabled:opacity-50">
          Disconnect wallet
        </button>
      )}
      {error && <p className="text-xs text-red-300 max-w-sm">{error}</p>}
    </div>
  );
}
