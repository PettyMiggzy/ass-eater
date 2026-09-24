import { useState } from 'react';
import Head from 'next/head';
import { Lockup } from '../components/Brand';
import { ownerWalletAddress } from '../lib/wallet-auth';
import { safeRedirectPath } from '../lib/safe-redirect';

/**
 * Owner sign-in by wallet.
 *
 * Exists because the owner lives in one of the 27 states this site blocks,
 * so every fresh browser, private window and domain otherwise needs another
 * way in. This is a door for the person who holds the owner wallet.
 *
 * The page must not advertise any OTHER way past the gate. The bypass
 * endpoints answer 404 to every failure precisely so they don't confirm a
 * bypass exists, and this page is public -- so it never mentions one, and
 * when no owner wallet is configured it is a 404 itself rather than a page
 * saying what to use instead.
 *
 * MUST stay exempt from the age gate in proxy.js and from the 18+ notice in
 * _app.js, together. Gating the page that exists to get past the gate is the
 * same circular dead end /blocked-region and /report-content were each fixed
 * for, and exempting a page from one list but not the other serves a blank
 * document, which reads as a broken site rather than a locked one.
 *
 * There is nothing sensitive on this page: it shows no content, and without
 * a signature from one specific private key it does nothing at all.
 */
export async function getServerSideProps() {
  // Whether a wallet login exists at all is decided server-side. With none
  // configured there is nothing here for anyone, so the page does not exist
  // (it used to render "not set up yet -- use your key link instead" to every
  // visitor, which told the world a key-link bypass exists).
  if (!ownerWalletAddress()) return { notFound: true };
  return { props: { configured: true } };
}

const STATUS_IDLE = '';

export default function Owner({ configured }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(STATUS_IDLE);

  async function signIn() {
    setError(STATUS_IDLE);

    const eth = typeof window !== 'undefined' ? window.ethereum : null;
    if (!eth) {
      setError(
        'No wallet found in this browser. Open this page inside your wallet app’s browser, or install a wallet extension.',
      );
      return;
    }

    setBusy(true);
    try {
      const accounts = await eth.request({ method: 'eth_requestAccounts' });
      const address = Array.isArray(accounts) ? accounts[0] : null;
      if (!address) throw new Error('No account was shared by the wallet.');

      const res = await fetch('/api/age-verify/wallet-nonce');
      if (!res.ok) throw new Error('Wallet sign-in is not available on this site.');
      const { message } = await res.json();

      // personal_sign takes (message, address) in that order. Wallets show
      // the text verbatim, which is why walletSignInMessage() spells out
      // that nothing moves.
      const signature = await eth.request({ method: 'personal_sign', params: [message, address] });

      const verify = await fetch('/api/age-verify/wallet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ signature }),
      });
      if (!verify.ok) throw new Error('That wallet is not the owner wallet for this site.');
      const { next } = await verify.json();
      window.location.href = safeRedirectPath(next, '/home');
    } catch (err) {
      // 4001 is the wallet's own "user rejected" code. Reporting it as a
      // failure would read as a bug when it was a deliberate cancel.
      setError(err?.code === 4001 ? 'Sign-in cancelled.' : err?.message || 'Could not sign in with that wallet.');
      setBusy(false);
    }
  }

  return (
    <>
      <Head>
        <title>Owner sign-in — OnlyOne</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div className="min-h-screen bg-brand-ink text-white flex items-center justify-center px-6">
        <div className="w-full max-w-md text-center">
          <Lockup className="h-10 mx-auto mb-8" />

          <h1 className="text-2xl font-black tracking-tight mb-3">Owner sign-in</h1>

          {configured ? (
            <>
              <p className="text-sm text-gray-400 leading-relaxed mb-8">
                Connect the owner wallet and sign one message. Nothing moves, nothing is
                approved — the signature just proves the wallet is yours.
              </p>

              <button
                onClick={signIn}
                disabled={busy}
                className="w-full premium-button disabled:opacity-50"
              >
                {busy ? 'Waiting for your wallet…' : 'Connect wallet & sign in'}
              </button>

              {error ? (
                <p className="text-sm text-brand-pink mt-6 leading-relaxed">{error}</p>
              ) : null}

              <p className="text-xs text-gray-600 mt-10 leading-relaxed">
                Cookies are per-domain, so this is once per site you use — and it lasts
                180 days.
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-400 leading-relaxed">Not available.</p>
          )}
        </div>
      </div>
    </>
  );
}
