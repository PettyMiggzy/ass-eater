import { useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { getSessionUserId } from '../lib/session';
import { findUserById, publicUser } from '../lib/users-store';
import { getCreators } from '../lib/creators-store';

export async function getServerSideProps({ req }) {
  const uid = getSessionUserId(req);
  if (!uid) {
    return { redirect: { destination: '/login', permanent: false } };
  }
  const user = await findUserById(uid);
  if (!user) {
    return { redirect: { destination: '/login', permanent: false } };
  }

  let creator = null;
  if (user.role === 'creator' && user.creatorId) {
    const creators = await getCreators();
    creator = creators.find((c) => String(c.id) === String(user.creatorId)) || null;
  }

  return { props: { user: publicUser(user), creator } };
}

export default function Dashboard({ user, creator: initialCreator }) {
  const router = useRouter();
  const [creator, setCreator] = useState(initialCreator);
  const [draft, setDraft] = useState({
    name: initialCreator?.name || '',
    handle: initialCreator?.handle || '',
    bio: initialCreator?.bio || '',
    price: initialCreator?.price || '',
  });
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
  };

  const saveProfile = async () => {
    setBusy(true);
    setStatus('Saving...');
    try {
      const res = await fetch('/api/me/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: draft }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setCreator(data.creator);
      setStatus('Saved.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading avatar...');
    try {
      const res = await fetch('/api/me/avatar', {
        method: 'POST',
        headers: { 'x-file-name': file.name, 'Content-Type': file.type || 'application/octet-stream' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreator(data.creator);
      setStatus('Avatar updated.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadContent = async (file) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading content...');
    try {
      const res = await fetch('/api/me/upload', {
        method: 'POST',
        headers: {
          'x-file-name': file.name,
          'x-file-type': file.type.startsWith('video') ? 'video' : 'image',
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreator(data.creator);
      setStatus('Content added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteItem = async (index) => {
    setBusy(true);
    setStatus('Removing...');
    try {
      const res = await fetch('/api/me/gallery-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setCreator(data.creator);
      setStatus('Removed.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Head><title>Dashboard - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center justify-between mb-8">
            <h1 className="text-3xl font-black premium-title">
              {user.role === 'creator' ? 'Creator Dashboard' : 'Your Account'}
            </h1>
            <button onClick={logout} className="text-sm px-4 py-2 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition">
              Log Out
            </button>
          </div>

          {status && (
            <div className="mb-6 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-brand-secondary text-sm">
              {status}
            </div>
          )}

          {user.role !== 'creator' && (
            <div className="premium-card p-8">
              <p className="text-gray-300 mb-2">Logged in as <span className="text-brand-gold font-bold">{user.email}</span></p>
              <p className="text-gray-400 text-sm mb-6">
                You're set up as a fan. Head to the platform to browse creators and unlock content with $ASSEAT.
              </p>
              <a href="/onlyass" className="premium-button inline-block">Browse Creators</a>
            </div>
          )}

          {user.role === 'creator' && creator && (
            <div className="premium-card p-6 space-y-6">
              {creator.status === 'pending' && (
                <div className="px-4 py-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
                  Your profile is pending review and not yet visible on the platform. Build it out below — our team will verify and publish it soon.
                </div>
              )}

              <div className="flex items-center gap-4">
                <img src={creator.img} alt={creator.name} className="w-20 h-20 rounded-full object-cover object-top border-2 border-brand-gold" />
                <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                  Change PFP
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => uploadAvatar(e.target.files[0])} />
                </label>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Display Name</label>
                  <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Handle</label>
                  <input value={draft.handle} onChange={(e) => setDraft({ ...draft, handle: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
                <div>
                  <label className="block text-sm text-gray-400 mb-2">Subscription Price</label>
                  <input value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
                </div>
              </div>

              <div>
                <label className="block text-sm text-gray-400 mb-2">Bio</label>
                <textarea value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} rows={3} className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white" />
              </div>

              <button onClick={saveProfile} disabled={busy} className="premium-button disabled:opacity-50">
                Save Profile
              </button>

              <hr className="border-brand-purple/20" />

              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-bold text-brand-gold">Your Content ({creator.gallery?.length || 0})</h3>
                  <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                    Upload
                    <input type="file" accept="image/*,video/*" className="hidden" onChange={(e) => uploadContent(e.target.files[0])} />
                  </label>
                </div>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                  {(creator.gallery || []).map((item, i) => (
                    <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                      {item.type === 'video' ? (
                        <video src={item.src} className="w-full h-full object-cover" muted />
                      ) : (
                        <img src={item.src} alt="" className="w-full h-full object-cover" />
                      )}
                      <button
                        onClick={() => deleteItem(i)}
                        className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
