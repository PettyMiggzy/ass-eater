import { useState } from 'react';

/**
 * Pre-launch "tell me when this opens" signup, fan or creator.
 *
 * Lives on the three pages that work WITHOUT age verification -- the
 * landing page, the creator recruitment page, and /blocked-region -- so it
 * has to keep the same rule those pages keep: nothing explicit, no creator
 * photography, no content. It is a text field and two buttons, which is
 * also why it is safe to paste into a social post.
 *
 * `source` is recorded with the signup so it is possible to tell which
 * page actually convinced someone.
 */
export default function WaitlistForm({
  source,
  defaultRole = 'fan',
  title = 'Get notified when we launch',
  blurb = 'Drop your email and we’ll tell you the moment OnlyOne opens. Nothing else, ever.',
  className = '',
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState(defaultRole);
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role, source, website }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || 'Something went wrong. Try again in a moment.');
        setStatus('idle');
        return;
      }
      setStatus('done');
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
      setStatus('idle');
    }
  }

  if (status === 'done') {
    return (
      <div className={`w-full max-w-md text-center ${className}`}>
        <p className="text-brand-pink font-bold tracking-wide">You’re on the list.</p>
        <p className="mt-2 text-sm text-gray-400">
          We’ll email <span className="text-gray-200">{email}</span> when we open
          {role === 'creator' ? ' creator signups' : ''}. Nothing else.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className={`w-full max-w-md text-center ${className}`}>
      <p className="text-sm font-bold tracking-[0.15em] text-gray-200">{title}</p>
      {blurb && <p className="mt-2 text-xs text-gray-500 leading-relaxed">{blurb}</p>}

      <div className="mt-4 flex justify-center gap-2" role="group" aria-label="I'm joining as">
        {[
          { value: 'fan', label: "I'M A FAN" },
          { value: 'creator', label: "I'M A CREATOR" },
        ].map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setRole(option.value)}
            aria-pressed={role === option.value}
            className={`px-4 py-2 rounded-full text-[10px] font-bold tracking-[0.15em] transition border ${
              role === option.value
                ? 'bg-brand-pink border-brand-pink text-white'
                : 'bg-transparent border-white/15 text-gray-400 hover:text-white hover:border-white/30'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex flex-col sm:flex-row gap-2">
        <label htmlFor="waitlist-email" className="sr-only">Email address</label>
        <input
          id="waitlist-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 px-4 py-3 rounded-full bg-black/40 border border-white/15 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-brand-pink transition"
        />
        <button
          type="submit"
          disabled={status === 'sending'}
          className="px-6 py-3 rounded-full bg-brand-pink hover:bg-brand-pink-dark disabled:opacity-50 text-sm font-black tracking-wide transition"
        >
          {status === 'sending' ? 'SENDING…' : 'NOTIFY ME'}
        </button>
      </div>

      {/* Honeypot. Hidden from people, filled in by bots -- see the handler. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        className="hidden"
      />

      {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

      <p className="mt-3 text-[10px] text-gray-600 leading-relaxed">
        Only used to tell you about the launch. Never sold or shared, and you can ask us to take
        you off at any time — <a href="mailto:team@onlyone1.fun" className="underline hover:text-brand-pink">team@onlyone1.fun</a>.
        See our <a href="/privacy" className="underline hover:text-brand-pink">Privacy Policy</a>.
      </p>
    </form>
  );
}
