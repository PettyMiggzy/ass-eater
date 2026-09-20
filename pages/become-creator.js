import { useState } from 'react';
import Head from 'next/head';
import SiteNav from '../components/SiteNav';
import SignupsClosed from '../components/SignupsClosed';
import { signupsOpen } from '../lib/signups';

// Mirrors the caps pages/api/creator/submit.js enforces server-side (the
// server is the actual gate -- these just keep the form from letting someone
// build a submission it's going to reject).
const MAX_GALLERY_FILES = 50;
const MAX_NAME = 80;
const MAX_HANDLE = 40;
const MAX_BIO = 1000;

export async function getServerSideProps() {
  return { props: { open: signupsOpen() } };
}

export default function BecomeCreator({ open }) {
  const [form, setForm] = useState({ name: '', handle: '', bio: '', email: '', price: '9.99' });
  const [avatar, setAvatar] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [agreed, setAgreed] = useState(false);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const pickGallery = (e) => {
    const picked = Array.from(e.target.files);
    if (picked.length > MAX_GALLERY_FILES) {
      setStatus(`You can attach up to ${MAX_GALLERY_FILES} gallery files — only the first ${MAX_GALLERY_FILES} were kept.`);
    }
    setGalleryFiles(picked.slice(0, MAX_GALLERY_FILES));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.handle || !form.bio) {
      setStatus('Name, handle, and bio are required.');
      return;
    }
    if (!agreed) {
      setStatus('Please agree to the Terms of Service and Privacy Policy to continue.');
      return;
    }
    setSubmitting(true);
    setStatus('Submitting...');

    const fd = new FormData();
    fd.append('name', form.name);
    fd.append('handle', form.handle);
    fd.append('bio', form.bio);
    fd.append('email', form.email);
    fd.append('price', form.price);
    fd.append('agreed', 'true');
    if (avatar) fd.append('avatar', avatar);
    galleryFiles.forEach((f) => fd.append('gallery', f));

    try {
      const res = await fetch('/api/creator/submit', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Submission failed');
      setDone(true);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  // Below every hook on purpose -- see the same note in pages/signup.js.
  if (!open) {
    return (
      <SignupsClosed
        title="Creator Applications Open Soon — OnlyOne"
        heading="Creator applications aren’t open yet"
        body="OnlyOne is live to browse, but we’re not taking creator applications just yet. Leave your email and you’ll be first to know — founding spots are still unclaimed."
        defaultRole="creator"
        source="become-creator-page"
      />
    );
  }

  if (done) {
    return (
      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav />
        <div className="flex items-center justify-center px-6 py-16">
          <div className="premium-card p-10 max-w-md text-center">
            <h1 className="text-3xl font-black text-brand-gold mb-4">Submission Received</h1>
            <p className="text-gray-300 mb-6">
              Your profile is pending review. Every creator profile is reviewed by our team before it goes
              live — we'll follow up at the email you provided with next steps.
            </p>
            <a href="/creators" className="premium-button inline-block">Back to OnlyOne</a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Become a Creator - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white">
        <SiteNav />
        <div className="max-w-xl mx-auto px-6 py-16">
          <h1 className="text-4xl font-black premium-title mb-2">Become a Creator</h1>
          <p className="text-gray-400 mb-8">Submit your profile below. All submissions are reviewed before going live.</p>

          <div className="premium-card p-6 mb-8 border-2 border-brand-purple/30">
            <p className="text-sm text-brand-secondary font-bold mb-2">⚠️ Verification Required</p>
            <p className="text-sm text-gray-400">
              Creators must be 18+, and every profile is reviewed by our team before content goes live. This form collects
              your submission — our team will follow up with the verification process before anything is published.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Display Name *</label>
              <input value={form.name} onChange={update('name')} maxLength={MAX_NAME} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Handle *</label>
              <input value={form.handle} onChange={update('handle')} maxLength={MAX_HANDLE} placeholder="@yourname" className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Bio *</label>
              <textarea value={form.bio} onChange={update('bio')} maxLength={MAX_BIO} rows={3} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Contact Email</label>
              <input type="email" value={form.email} onChange={update('email')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Subscription Price (USD per month)</label>
              <input type="number" min="0" step="0.01" value={form.price} onChange={update('price')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Profile Photo</label>
              <input type="file" accept="image/*" onChange={(e) => setAvatar(e.target.files[0])} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-gold file:text-black file:font-bold" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Gallery Content (images/videos, up to {MAX_GALLERY_FILES})</label>
              <input type="file" accept="image/*,video/*" multiple onChange={pickGallery} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-gold file:text-black file:font-bold" />
            </div>

            <label className="flex items-start gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5" />
              I'm 18 or older and I agree to the{' '}
              <a href="/terms" target="_blank" rel="noreferrer" className="text-brand-gold underline">Terms of Service</a>{' '}
              and{' '}
              <a href="/privacy" target="_blank" rel="noreferrer" className="text-brand-gold underline">Privacy Policy</a>.
            </label>

            <button type="submit" disabled={submitting || !agreed} className="w-full premium-button disabled:opacity-50">
              {submitting ? 'Submitting...' : 'Submit for Review'}
            </button>
            {status && <p className="text-sm text-brand-secondary">{status}</p>}
          </form>
        </div>
      </div>
    </>
  );
}
