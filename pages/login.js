import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Login failed');
      router.push('/dashboard');
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Head><title>Log In - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6 py-16">
        <div className="max-w-md w-full premium-card p-8">
          <h1 className="text-3xl font-black premium-title mb-6">Log In</h1>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Email</label>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Password</label>
              <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button type="submit" disabled={submitting} className="w-full premium-button disabled:opacity-50">
              {submitting ? 'Logging in...' : 'Log In'}
            </button>
          </form>
          <p className="text-sm text-gray-400 mt-6 text-center">
            No account yet? <a href="/signup" className="text-brand-gold hover:underline">Sign up</a>
          </p>
        </div>
      </div>
    </>
  );
}
