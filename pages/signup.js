import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import SiteNav from '../components/SiteNav';
import { readReferralCookie } from '../lib/referral';
import SignupsClosed from '../components/SignupsClosed';
import { signupsOpen } from '../lib/signups';

export async function getServerSideProps() {
  // Read server-side rather than through a NEXT_PUBLIC_ flag, so opening or
  // closing signups takes effect on the next request instead of needing a
  // rebuild to re-inline the value into the client bundle.
  return { props: { open: signupsOpen() } };
}

export default function Signup({ open }) {
  const router = useRouter();
  const [role, setRole] = useState('fan');
  // /founding-creator and the creator-facing links send people here with
  // ?role=creator so they don't land on the fan form after clicking "become
  // a creator". Applied once, on the first render where the query is
  // actually populated -- after that the toggle is the user's to control.
  const rolePrefilled = useRef(false);
  useEffect(() => {
    if (rolePrefilled.current || !router.isReady) return;
    rolePrefilled.current = true;
    if (router.query.role === 'creator' || router.query.role === 'fan') {
      setRole(router.query.role);
    }
  }, [router.isReady, router.query.role]);
  const [form, setForm] = useState({ email: '', password: '', displayName: '', handle: '', bio: '' });
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!agreed) {
      setError('Please agree to the Terms of Service and Privacy Policy to continue.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, role, ref: readReferralCookie() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Signup failed');
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Below every hook on purpose: an early return above them would change
  // hook order on any render where `open` differs, which is the one way
  // this could crash a page instead of just closing a form.
  if (!open) {
    return <SignupsClosed title="Signups Open Soon — OnlyOne" source="signup-page" />;
  }

  return (
    <>
      <Head><title>Sign Up - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav />
        <div className="flex items-center justify-center px-6 py-16">
        <div className="max-w-md w-full premium-card p-8">
          <h1 className="text-3xl font-black premium-title mb-2">Create Account</h1>
          <p className="text-gray-400 text-sm mb-6">Join as a fan to unlock content, or as a creator to post your own.</p>

          <div className="flex gap-2 mb-6">
            <button
              type="button"
              onClick={() => setRole('fan')}
              className={`flex-1 py-2 rounded-md font-bold text-sm transition ${role === 'fan' ? 'bg-brand-gold text-black' : 'bg-white/10 text-gray-100 border border-brand-purple/50 hover:bg-white/15'}`}
            >
              I'm a Fan
            </button>
            <button
              type="button"
              onClick={() => setRole('creator')}
              className={`flex-1 py-2 rounded-md font-bold text-sm transition ${role === 'creator' ? 'bg-brand-gold text-black' : 'bg-white/10 text-gray-100 border border-brand-purple/50 hover:bg-white/15'}`}
            >
              I'm a Creator
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {role === 'fan' ? (
              <div>
                <label className="block text-sm text-gray-400 mb-2">Email or Username</label>
                <input
                  type="text"
                  required
                  minLength={3}
                  placeholder="Doesn't have to be a real email — pick a username if you'd rather"
                  value={form.email}
                  onChange={update('email')}
                  className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                />
                <p className="text-xs text-gray-500 mt-1.5">
                  We never require a real email for fan accounts — plenty of people would rather not have this show up in an inbox anyone else can see.
                </p>
              </div>
            ) : (
              <div>
                <label className="block text-sm text-gray-400 mb-2">Email</label>
                <input type="email" required value={form.email} onChange={update('email')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
              </div>
            )}
            <div>
              <label className="block text-sm text-gray-400 mb-2">Password</label>
              <input type="password" required minLength={6} value={form.password} onChange={update('password')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>

            {role === 'creator' && (
              <>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                  <input required value={form.displayName} onChange={update('displayName')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Handle</label>
                  <input required placeholder="@yourname" value={form.handle} onChange={update('handle')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Bio</label>
                  <textarea value={form.bio} onChange={update('bio')} rows={2} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <p className="text-xs text-gray-500">
                  You must be 18 or older to create a creator profile. Build it out now — our team reviews every profile before it appears on the platform.
                </p>
              </>
            )}

            <label className="flex items-start gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
              I'm 18 or older and I agree to the{' '}
              <a href="/terms" target="_blank" rel="noreferrer" className="text-brand-gold underline">Terms of Service</a>{' '}
              and{' '}
              <a href="/privacy" target="_blank" rel="noreferrer" className="text-brand-gold underline">Privacy Policy</a>.
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button type="submit" disabled={submitting || !agreed} className="w-full premium-button disabled:opacity-50">
              {submitting ? 'Creating...' : 'Create Account'}
            </button>
          </form>

          <p className="text-sm text-gray-400 mt-6 text-center">
            Already have an account? <a href="/login" className="text-brand-gold hover:underline">Log in</a>
          </p>
        </div>
        </div>
      </div>
    </>
  );
}
