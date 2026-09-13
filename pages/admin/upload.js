import { useState } from 'react';
import Head from 'next/head';
import { creators as seedCreators } from '../../data/creators';

export default function AdminUpload() {
  const [adminKey, setAdminKey] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [creatorId, setCreatorId] = useState(seedCreators[0]?.id || '');
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState('');
  const [uploading, setUploading] = useState(false);

  const checkKey = () => {
    if (adminKey.trim()) setUnlocked(true);
  };

  const handleUpload = async () => {
    if (!file || !creatorId) {
      setStatus('Pick a creator and a file first.');
      return;
    }
    setUploading(true);
    setStatus('Uploading...');
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: {
          'x-admin-key': adminKey,
          'x-creator-id': String(creatorId),
          'x-file-name': file.name,
          'x-file-type': file.type.startsWith('video') ? 'video' : 'image',
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setStatus(`Uploaded! Added to ${data.creator.name}'s gallery.`);
      setFile(null);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setUploading(false);
    }
  };

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <div className="premium-card p-8 max-w-sm w-full">
          <h1 className="text-2xl font-black text-brand-gold mb-4">Admin Access</h1>
          <input
            type="password"
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && checkKey()}
            placeholder="Admin key"
            className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white mb-4"
          />
          <button onClick={checkKey} className="w-full premium-button">Unlock</button>
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Admin Upload - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-16">
        <div className="max-w-lg mx-auto premium-card p-8">
          <h1 className="text-2xl font-black text-brand-gold mb-6">Add Content to a Model</h1>

          <label className="block text-sm text-gray-400 mb-2">Creator</label>
          <select
            value={creatorId}
            onChange={(e) => setCreatorId(e.target.value)}
            className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white mb-4"
          >
            {seedCreators.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <label className="block text-sm text-gray-400 mb-2">File (image or video)</label>
          <input
            type="file"
            accept="image/*,video/*"
            onChange={(e) => setFile(e.target.files[0])}
            className="w-full text-sm text-gray-300 mb-6 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:bg-brand-gold file:text-black file:font-bold"
          />

          <button onClick={handleUpload} disabled={uploading} className="w-full premium-button disabled:opacity-50">
            {uploading ? 'Uploading...' : 'Upload'}
          </button>

          {status && <p className="mt-4 text-sm text-brand-secondary">{status}</p>}

          <p className="mt-8 text-xs text-gray-500">
            Uploaded content is stored in Vercel Blob and appended to the selected creator's gallery immediately.
          </p>
        </div>
      </div>
    </>
  );
}
