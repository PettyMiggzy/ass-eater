import { useEffect, useState } from 'react';
import Head from 'next/head';

// Mirrors NCII_FIELD_LIMITS in lib/ncii-reports-store.js (not imported: that
// module pulls in the database driver). The API refuses anything longer with
// a 400 { field, maxLength } rather than cutting it.
const LIMITS = { reporterName: 200, reporterContact: 200, contentLocation: 4000, description: 4000 };

const CATEGORY_OPTIONS = [
  { value: 'self', label: 'I appear in this content (or I am authorized to act for the person who does)' },
  { value: 'third_party', label: "I'm reporting non-consensual content about someone else" },
  { value: 'minor', label: 'I believe this content shows someone under 18' },
];

// Public, unauthenticated notice-and-removal form -- required by the
// federal TAKE IT DOWN Act to be "clearly and conspicuous" and usable by
// anyone, whether or not they have an account here. Content reported
// through this form is reviewed and, if valid, removed within 48 hours.
//
// It is also the site's report path for content that may show a minor, which
// anyone -- not only the person shown -- must be able to file without signing
// a statement they know is false. So the reporter says who they are first, and
// only a self-report signs the self-attestation.
export default function ReportContent() {
  const [form, setForm] = useState({
    category: '',
    reporterName: '',
    reporterContact: '',
    contentLocation: '',
    description: '',
    consentStatement: false,
    goodFaithStatement: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [errorField, setErrorField] = useState('');
  const [done, setDone] = useState(false);

  // Links from a report button elsewhere on the site can prefill the form:
  // ?category=<self|third_party|minor> and ?content=<what is being reported>.
  // Read after mount (the page has no server props), only into empty fields,
  // and only a known category -- nothing here is trusted beyond being text
  // the reporter can still edit before sending.
  useEffect(() => {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const category = params.get('category');
    const content = params.get('content');
    setForm((f) => ({
      ...f,
      category: !f.category && CATEGORY_OPTIONS.some((o) => o.value === category) ? category : f.category,
      contentLocation: !f.contentLocation && content ? content.slice(0, LIMITS.contentLocation) : f.contentLocation,
    }));
  }, []);

  const selfReport = form.category === 'self';
  const minorReport = form.category === 'minor';

  // Counters, not a maxLength attribute: a browser silently cuts a paste at
  // maxLength, which is the very truncation the API stopped doing (a victim's
  // tenth link dropped without a word). Over the limit is shown and refused
  // before sending instead.
  const counter = (key) => (
    <p className={`text-[11px] mt-1 text-right ${form[key].length > LIMITS[key] ? 'text-red-400 font-bold' : 'text-gray-600'}`}>
      {form[key].length} / {LIMITS[key]}
      {form[key].length > LIMITS[key] && ' — too long; shorten it or split it into a second report'}
    </p>
  );
  const fieldClass = (key) => `w-full px-4 py-3 rounded-md bg-black/40 border text-white text-sm ${errorField === key ? 'border-red-500' : 'border-brand-purple/30'}`;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setErrorField('');
    if (!form.category) {
      setError('Choose who is making this report.');
      return;
    }
    const tooLong = Object.keys(LIMITS).find((k) => form[k].length > LIMITS[k]);
    if (tooLong) {
      setErrorField(tooLong);
      setError(`That field is too long (${form[tooLong].length} of ${LIMITS[tooLong]} characters). Shorten it, or file the rest as a second report.`);
      return;
    }
    setSubmitting(true);
    try {
      // Only the statement that matches the category is sent as signed.
      const body = {
        ...form,
        consentStatement: selfReport && form.consentStatement,
        goodFaithStatement: !selfReport && form.goodFaithStatement,
      };
      const res = await fetch('/api/report-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let data = {};
      try { data = await res.json(); } catch { data = {}; }
      if (!res.ok) {
        if (typeof data.field === 'string') setErrorField(data.field);
        throw new Error(data.error || 'Failed to submit report. If this keeps happening, email team@onlyone1.fun.');
      }
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
        <Head><title>Report Submitted - OnlyOne</title></Head>
        <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16 flex items-center justify-center">
          <div className="premium-card p-8 max-w-lg text-center">
            <p className="text-2xl font-black text-brand-gold mb-4">Report received.</p>
            <p className="text-gray-300 mb-2">
              {minorReport
                ? "We'll review this as a priority. Content that shows a minor is removed, the account is banned, and it is reported to the authorities."
                : "We'll review this and, if it's confirmed to be non-consensual content, remove it within 48 hours."}
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
      <Head><title>Report Non-Consensual Content - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-3xl font-black premium-title mb-2">Report Non-Consensual Content</h1>
          <p className="text-gray-400 text-sm mb-4">
            Use this form if you appear in a photo or video on this platform and did not consent to it being
            posted here -- including an AI-generated, deepfaked, or face-swapped image or video of you. You do
            not need an account to submit this. Confirmed reports are removed within 48 hours.
          </p>
          <p className="text-gray-400 text-sm mb-8">
            Use it too if you believe content here shows someone under 18, or shows someone else who did not
            consent -- you don't have to be the person in it. If you believe a child is in immediate danger,
            contact local law enforcement, and you can also report to the NCMEC CyberTipline at{' '}
            <a href="https://report.cybertip.org" className="text-brand-gold underline" rel="noopener noreferrer" target="_blank">report.cybertip.org</a>.
          </p>

          <form onSubmit={submit} className="premium-card p-6 space-y-4">
            <fieldset>
              <legend className="block text-sm text-gray-400 mb-2">Who is making this report?</legend>
              <div className="space-y-2">
                {CATEGORY_OPTIONS.map((o) => (
                  <label key={o.value} className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="radio"
                      name="category"
                      value={o.value}
                      checked={form.category === o.value}
                      onChange={() => setForm({ ...form, category: o.value })}
                      className="mt-1"
                      required
                    />
                    <span>{o.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Your name</label>
              <input
                value={form.reporterName}
                onChange={(e) => setForm({ ...form, reporterName: e.target.value })}
                className={fieldClass('reporterName')}
                required
              />
              {counter('reporterName')}
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Email or phone number, so we can reach you if needed</label>
              <input
                value={form.reporterContact}
                onChange={(e) => setForm({ ...form, reporterContact: e.target.value })}
                className={fieldClass('reporterContact')}
                required
              />
              {counter('reporterContact')}
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">
                Where is the content? (a link to the page, creator's name/handle, or as specific a description as you can give)
              </label>
              <textarea
                value={form.contentLocation}
                onChange={(e) => setForm({ ...form, contentLocation: e.target.value })}
                rows={3}
                className={fieldClass('contentLocation')}
                required
              />
              {counter('contentLocation')}
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Anything else that would help us find and review it (optional)</label>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={3}
                className={fieldClass('description')}
              />
              {counter('description')}
            </div>
            {selfReport ? (
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
            ) : form.category ? (
              <label className="flex items-start gap-3 text-sm text-gray-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.goodFaithStatement}
                  onChange={(e) => setForm({ ...form, goodFaithStatement: e.target.checked })}
                  className="mt-1"
                  required
                />
                <span>
                  I believe in good faith that this content {minorReport ? 'shows a person under 18' : 'was posted without the consent of the person who appears in it'},
                  and the information in this report is accurate to the best of my knowledge.
                </span>
              </label>
            ) : null}

            {error && <p className="text-sm text-red-400">{error}</p>}

            <button type="submit" disabled={submitting} className="premium-button disabled:opacity-50">
              {submitting ? 'Submitting...' : 'Submit Report'}
            </button>
          </form>

          <p className="text-xs text-gray-600 mt-6">
            This form exists to comply with the federal TAKE IT DOWN Act's notice-and-removal requirement. For a
            copyright (DMCA) claim instead, see our{' '}
            <a href="/terms#content-removal" className="text-brand-gold underline">Terms of Service</a>.
            What you submit here is used only to review and act on this report — see our{' '}
            <a href="/privacy" className="text-brand-gold underline">Privacy Policy</a>.
          </p>
        </div>
      </div>
    </>
  );
}
