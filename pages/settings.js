import { useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import { useCart } from '../lib/cart';
import { getSessionUser } from '../lib/session';
import { publicUser } from '../lib/users-store';
import { formatCredits } from '../lib/brand';

export async function getServerSideProps({ req }) {
  const sessionUser = publicUser(await getSessionUser(req));
  if (!sessionUser) {
    return { redirect: { destination: '/login?next=/settings', permanent: false } };
  }
  return { props: { sessionUser } };
}

// Mirrors PASSWORD_MIN_LENGTH in lib/users-store.js (not imported: that module
// pulls in the Postgres driver). The server enforces the rule either way.
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_MAX_LENGTH = 200;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { res, data };
}

/**
 * Change password: POST /api/auth/change-password. Every OTHER session is
 * signed out by the server (the session epoch is bumped); this browser gets a
 * fresh cookie and stays signed in.
 */
function ChangePassword() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    setDone(false);
    if (next.length < PASSWORD_MIN_LENGTH || next.length > PASSWORD_MAX_LENGTH) {
      setError(`Pick a new password of ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`);
      return;
    }
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      const { res, data } = await postJson('/api/auth/change-password', { currentPassword: current, newPassword: next });
      if (!res.ok) throw new Error(data.error || 'Could not change your password.');
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err instanceof TypeError ? 'Could not reach the server. Check your connection.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  const input = 'w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-brand-pink/60';
  return (
    <form onSubmit={submit} className="rounded-xl bg-white/5 border border-white/5 p-5 mb-8 space-y-3">
      <h2 className="font-bold">Change password</h2>
      <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" className={input} />
      <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password" maxLength={PASSWORD_MAX_LENGTH} className={input} />
      <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Confirm new password" maxLength={PASSWORD_MAX_LENGTH} className={input} />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {done && <p className="text-xs text-green-400">Password changed. You&apos;ve been signed out everywhere else.</p>}
      <button type="submit" disabled={busy || !current || !next || !confirm} className="px-6 py-2.5 rounded-full bg-brand-pink hover:bg-brand-pink-dark font-bold text-sm transition disabled:opacity-50">
        {busy ? 'Saving…' : 'Change password'}
      </button>
      <p className="text-[11px] text-gray-500">
        Forgot your current password? There&apos;s no email reset yet — contact{' '}
        <a href="mailto:team@onlyone1.fun" className="underline">team@onlyone1.fun</a>.
      </p>
    </form>
  );
}

/**
 * Delete account (fans only): POST /api/auth/delete-account { password,
 * acknowledgeForfeit?, expectedForfeitCents?, expectedDigitalPurchases? }.
 * The confirmation is bound to the amounts it showed. Credits are closed-loop and never refunded, and the
 * digital items a fan bought stop being viewable once the account is gone,
 * so either comes back as 409 BALANCE_FORFEIT ({ balanceCents,
 * digitalPurchases }) and needs an explicit second confirmation naming both
 * before anything is deleted. A physical order that hasn't shipped is a
 * refusal (409 unshipped_orders), shown as the server words it.
 * Creators are deleted by support (their profile, listings and money go
 * through the admin path), and the server refuses them here too.
 */
function DeleteAccount({ isCreator }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // null = no confirmation pending; else { cents, purchases, changed } from the 409.
  const [forfeit, setForfeit] = useState(null);
  const [deleted, setDeleted] = useState(false);
  const cart = useCart();

  if (isCreator) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
        <h2 className="font-bold mb-2">Delete account</h2>
        <p className="text-sm text-gray-400">
          Creator accounts are closed by support, because your profile, listings, orders and any earnings have to be
          settled first. Email <a href="mailto:team@onlyone1.fun" className="underline text-brand-pink">team@onlyone1.fun</a>{' '}
          from your account&apos;s address.
        </p>
      </div>
    );
  }

  const run = async (acknowledgeForfeit) => {
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      // The confirmation names the exact amounts it was shown for: the server
      // refuses (and re-prompts) if the balance or purchases changed since.
      const body =
        acknowledgeForfeit === true && forfeit
          ? { password, acknowledgeForfeit: true, expectedForfeitCents: forfeit.cents, expectedDigitalPurchases: forfeit.purchases }
          : { password };
      const { res, data } = await postJson('/api/auth/delete-account', body);
      if (res.status === 409 && data.code === 'BALANCE_FORFEIT') {
        setForfeit({
          cents: Number.isFinite(data.balanceCents) ? data.balanceCents : 0,
          purchases: Number.isFinite(data.digitalPurchases) ? data.digitalPurchases : 0,
          changed: data.changed === true,
        });
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Could not delete your account.');
      setPassword('');
      // Signed out: this account's cart must not carry over to whoever uses
      // this browser next (lib/cart.js).
      cart.setViewer(null);
      setDeleted(true);
    } catch (err) {
      setForfeit(null);
      setError(err instanceof TypeError ? 'Could not reach the server. Nothing was deleted — check your connection.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  if (deleted) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 p-5 text-center">
        <h2 className="font-bold mb-2">Your account has been deleted</h2>
        <p className="text-sm text-gray-400 mb-4">You&apos;ve been signed out.</p>
        <a href="/" className="inline-block px-6 py-2.5 rounded-full border border-white/15 hover:bg-white/5 font-bold text-sm transition">Go home</a>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); run(false); }}
      className="rounded-xl border border-red-500/20 bg-red-500/5 p-5 space-y-3"
    >
      <h2 className="font-bold">Delete account</h2>
      <p className="text-sm text-gray-400">
        This removes your login, your wall comments, the messages you sent, your saved creators and your notifications.
        It can&apos;t be undone. Digital items you bought can only be viewed while signed in, so they become unavailable
        once the account is gone. Records of purchases and moderation are kept as our{' '}
        <a href="/privacy" className="underline text-brand-pink">Privacy Policy</a> describes. Credits are never refunded,
        so any balance left is lost. If a physical order hasn&apos;t shipped yet, you can delete the account once it has.
      </p>
      <input
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => { setPassword(e.target.value); setForfeit(null); }}
        placeholder="Your password"
        className="w-full px-4 py-2.5 rounded-lg bg-white/5 border border-white/10 text-sm text-white placeholder:text-gray-500 focus:outline-none focus:border-red-400/60"
      />
      {error && <p className="text-xs text-red-400">{error}</p>}
      {forfeit !== null ? (
        <div className="rounded-lg border border-red-500/30 bg-black/30 p-3 space-y-3">
          {forfeit.changed && (
            <p className="text-sm text-yellow-300">
              Your balance or purchases changed since you last confirmed, so nothing was deleted. Check the amounts below.
            </p>
          )}
          {forfeit.cents > 0 && (
            <p className="text-sm text-red-300">
              You still have {formatCredits(forfeit.cents)}. Deleting your account loses them for good — credits are never
              refunded or cashed out.
            </p>
          )}
          {forfeit.purchases > 0 && (
            <p className="text-sm text-red-300">
              You will lose access to the {forfeit.purchases} digital item{forfeit.purchases === 1 ? '' : 's'} you bought —
              they can only be viewed from your account.
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => setForfeit(null)} disabled={busy} className="flex-1 px-4 py-2 rounded-full border border-white/15 text-sm text-gray-300 hover:bg-white/5 transition disabled:opacity-50">
              Keep my account
            </button>
            <button type="button" onClick={() => run(true)} disabled={busy} className="flex-1 px-4 py-2 rounded-full bg-red-600 hover:bg-red-700 text-sm font-bold transition disabled:opacity-50">
              {busy ? 'Deleting…' : forfeit.cents > 0 ? 'Lose credits & delete' : 'Delete anyway'}
            </button>
          </div>
        </div>
      ) : (
        <button type="submit" disabled={busy || !password} className="px-6 py-2.5 rounded-full bg-red-600 hover:bg-red-700 font-bold text-sm transition disabled:opacity-50">
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
      )}
    </form>
  );
}

export default function SettingsPage({ sessionUser }) {
  return (
    <>
      <Head>
        <title>Settings — OnlyOne</title>
      </Head>
      <div className="min-h-screen bg-brand-ink text-white pb-24">
        <SiteNav signedIn viewerAvatar={sessionUser?.img || null} />
        <div className="max-w-lg mx-auto px-6 py-10">
          <h1 className="text-3xl font-black mb-6">Account settings</h1>
          <ChangePassword />
          <DeleteAccount isCreator={sessionUser.role === 'creator'} />
        </div>
      </div>
    </>
  );
}
