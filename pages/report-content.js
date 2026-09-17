import { useState } from 'react';
import Head from 'next/head';

// Public, unauthenticated notice-and-removal form -- required by the
// federal TAKE IT DOWN Act to be "clearly and conspicuous" and usable by
// anyone, whether or not they have an account here. Content reported
// through this form is reviewed and, if valid, removed within 48 hours.
export default function ReportContent() {
  const [form, setForm] = useState({
    reporterName: '',
    reporterContact: '',
    contentLocation: '',
    description: '',
    consentStatement: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/report-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit report');
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <>
        <Head><title>Report Submitted - Only Ass</title></Head>
        <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16 flex items-center justify-center">
          <div className="premium-card p-8 max-w-lg text-center">
            <p className="text-2xl font-black text-brand-gold mb-4">Report received.</p>
            <p className="text-gray-300 mb-2">
              We'll review this and, if it's confirmed to be non-consensual content, remove it within 48 hours.
            </p>
            <p className="text-gray-500 text-sm">
              If you gave contact information, we may reach out if we need more detail to locate the content.
            </p>
            <a href="/" className="premium-button inline-block mt-6">Back to Home</a>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <Head><title>Report Non-Consensual Content - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-black premium-title mb-2">Report Non-Consensual Content</h1>
          <p className="text-gray-400 text-sm mb-8">
            Use this form if you appear in a photo or video on this platform and did not consent to it being
            posted here -- including an AI-generated, deepfaked, or face-swapped image or video of you. You do
            not need an account to submit this. Confirmed reports are removed within 48 hours.
          </p>

          <form onSubmit={submit} className="premium-card p-6 space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Your name</label>
              <input
                value={form.reporterName}
                onChange={(e) => setForm({ ...form, reporterName: e.target.value })}
                className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Email or phone number, so we can reach you if needed</label>
              <input
                value={form.reporterContact}
                onChange={(e) => setForm({ ...form, reporterContact: e.target.value })}
                className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">
                Where is the content? (a link to the page, creator's name/handle, or as specific a description as you can give)
              </label>
              <textarea
                value={form.contentLocation}
                onChange={(e) => setForm({ ...form, contentLocation: e.target.value })}
                rows={3}
                className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Anything else that would help us find and review it (optional)</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
              />
            </div>
            <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={form.consentStatement}
                onChange={(e) => setForm({ ...form, consentStatement: e.target.checked })}
                className="mt-1"
                required
              />
              <span>
                I am the person who appears in this content (or I am authorized to act on that person's behalf),
                and this content was posted without that person's consent. I understand submitting a knowingly
                false report may have legal consequences.
              </span>
            </label>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button type="submit" disabled={submitting} className="premium-button disabled:opacity-50">
              {submitting ? 'Submitting...' : 'Submit Report'}
            </button>
          </form>

          <p className="text-xs text-gray-600 mt-6">
            This form exists to comply with the federal TAKE IT DOWN Act's notice-and-removal requirement. For a
            copyright (DMCA) claim instead, see our{' '}
            <a href="/terms#content-removal" className="text-brand-gold underline">Terms of Service</a>.
          </p>
        </div>
      </div>
    </>
  );
}
