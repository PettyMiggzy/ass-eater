import { useState } from 'react';
import Head from 'next/head';

export default function BecomeCreator() {
  const [form, setForm] = useState({ name: '', handle: '', bio: '', email: '', price: '1' });
  const [avatar, setAvatar] = useState(null);
  const [galleryFiles, setGalleryFiles] = useState([]);
  const [status, setStatus] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const update = (field) => (e) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.handle || !form.bio) {
      setStatus('Name, handle, and bio are required.');
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

  if (done) {
    return (
      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <div className="premium-card p-10 max-w-md text-center">
          <h1 className="text-3xl font-black text-brand-gold mb-4">Submission Received</h1>
          <p className="text-gray-300 mb-6">
            Your profile is pending review. Real creators require identity and age verification before going live —
            we'll follow up at the email you provided with next steps.
          </p>
          <a href="/onlyass" className="premium-button inline-block">Back to Only Ass</a>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Become a Creator - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-xl mx-auto">
          <h1 className="text-4xl font-black premium-title mb-2">Become a Creator</h1>
          <p className="text-gray-400 mb-8">Submit your profile below. All submissions are reviewed before going live.</p>

          <div className="premium-card p-6 mb-8 border-2 border-brand-purple/30">
            <p className="text-sm text-brand-secondary font-bold mb-2">⚠️ Verification Required</p>
            <p className="text-sm text-gray-400">
              Real creators must be 18+ and pass identity verification before content goes live. This form collects
              your submission — our team will follow up with the verification process before anything is published.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm text-gray-400 mb-2">Display Name *</label>
              <input value={form.name} onChange={update('name')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Handle *</label>
              <input value={form.handle} onChange={update('handle')} placeholder="@yourname" className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Bio *</label>
              <textarea value={form.bio} onChange={update('bio')} rows={3} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Contact Email</label>
              <input type="email" value={form.email} onChange={update('email')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Subscription Price ($ASSEAT, millions)</label>
              <input type="number" value={form.price} onChange={update('price')} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Profile Photo</label>
              <input type="file" accept="image/*" onChange={(e) => setAvatar(e.target.files[0])} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-gold file:text-black file:font-bold" />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-2">Gallery Content (images/videos)</label>
              <input type="file" accept="image/*,video/*" multiple onChange={(e) => setGalleryFiles(Array.from(e.target.files))} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-gold file:text-black file:font-bold" />
            </div>

            <button type="submit" disabled={submitting} className="w-full premium-button disabled:opacity-50">
              {submitting ? 'Submitting...' : 'Submit for Review'}
            </button>
            {status && <p className="text-sm text-brand-secondary">{status}</p>}
          </form>
        </div>
      </div>
    </>
  );
}
