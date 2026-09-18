import { useState, useEffect } from 'react';
import Head from 'next/head';
import { effectiveCreatorStatus } from '../../lib/creators-store';
import { FOUNDING_LIMIT, countFounding, isFoundingCreator } from '../../lib/founding';

export default function AdminPanel() {
  const [adminKey, setAdminKey] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [creators, setCreators] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState('creators');
  const [nextUploadIsAi, setNextUploadIsAi] = useState(false);

  const authHeaders = { 'x-admin-key': adminKey };

  // Live off the loaded roster, so the counter and the cap agree with what
  // the server will decide on save.
  const foundingCount = countFounding(creators);
  const foundingCapReached = foundingCount >= FOUNDING_LIMIT;

  const loadCreators = async (key) => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/creators', { headers: { 'x-admin-key': key ?? adminKey } });
      if (!res.ok) throw new Error('Bad admin key');
      const data = await res.json();
      setCreators(data.creators);
      return true;
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      return false;
    } finally {
      setLoading(false);
    }
  };

  const checkKey = async () => {
    if (!adminKey.trim()) return;
    const ok = await loadCreators(adminKey);
    if (ok) setUnlocked(true);
  };

  const selected = creators.find((c) => String(c.id) === String(selectedId));
  // A suspension lifts itself once suspendedUntil passes -- nothing rewrites
  // the stored `status` when it does, so every status shown here has to go
  // through effectiveCreatorStatus() or the panel keeps reporting someone as
  // suspended long after they're publicly visible again.
  const selectedStatus = selected ? effectiveCreatorStatus(selected) : null;

  useEffect(() => {
    if (selected) {
      setDraft({
        name: selected.name || '',
        handle: selected.handle || '',
        bio: selected.bio || '',
        price: selected.price || '',
        subs: selected.subs || '',
        posts: selected.posts ?? 0,
        likes: selected.likes || '',
        locked: !!selected.locked,
        trending: !!selected.trending,
        premium: !!selected.premium,
        founding: !!selected.founding,
        status: effectiveCreatorStatus(selected) || 'active',
        // Rides along with `status` on every save because the two are one
        // coupled decision -- see the comment in pages/api/admin/profile.js,
        // which is where the pair is actually settled. Sent verbatim so an
        // automatic suspension still inside its 30 days keeps its own clock
        // when the admin saves some unrelated field.
        suspendedUntil: selected.suspendedUntil || null,
        payoutMethod: selected.payoutMethod || 'onlyass',
        walletAddress: selected.walletAddress || '',
        socials: {
          twitter: selected.socials?.twitter || '',
          instagram: selected.socials?.instagram || '',
          tiktok: selected.socials?.tiktok || '',
          reddit: selected.socials?.reddit || '',
          website: selected.socials?.website || '',
        },
      });
    }
  }, [selectedId]);

  const saveProfile = async () => {
    setBusy(true);
    setStatus('Saving...');
    try {
      const res = await fetch('/api/admin/profile', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: selectedId, fields: { ...draft, img: selected.img } }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Save failed');
      setCreators((prev) => prev.map((c) => (String(c.id) === String(selectedId) ? data.creator : c)));
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
      const res = await fetch('/api/admin/avatar', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-creator-id': String(selectedId),
          'x-file-name': file.name,
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreators((prev) => prev.map((c) => (String(c.id) === String(selectedId) ? data.creator : c)));
      setStatus('Avatar updated.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadGalleryItem = async (file, aiGenerated) => {
    if (!file) return;
    setBusy(true);
    setStatus('Uploading content...');
    try {
      const res = await fetch('/api/admin/upload', {
        method: 'POST',
        headers: {
          ...authHeaders,
          'x-creator-id': String(selectedId),
          'x-file-name': file.name,
          'x-file-type': file.type.startsWith('video') ? 'video' : 'image',
          'x-current-gallery': JSON.stringify(selected.gallery || []),
          'x-ai-generated': aiGenerated ? 'true' : 'false',
          'Content-Type': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      setCreators((prev) => prev.map((c) => (String(c.id) === String(selectedId) ? data.creator : c)));
      setStatus('Content added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteGalleryItem = async (index) => {
    setBusy(true);
    setStatus('Removing...');
    try {
      const res = await fetch('/api/admin/gallery-delete', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: selectedId, index, knownGallery: selected.gallery || [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setCreators((prev) => prev.map((c) => (String(c.id) === String(selectedId) ? data.creator : c)));
      setStatus('Removed.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const addCreator = async () => {
    setBusy(true);
    setStatus('Creating model...');
    try {
      const res = await fetch('/api/admin/create', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Create failed');
      setCreators((prev) => [...prev, data.creator]);
      setSelectedId(data.creator.id);
      setStatus('Model created — edit their details below.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const removeCreator = async (id) => {
    if (!confirm('Delete this model entirely? This cannot be undone.')) return;
    setBusy(true);
    setStatus('Deleting model...');
    try {
      const res = await fetch('/api/admin/delete', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ creatorId: id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setCreators(data.creators);
      if (String(selectedId) === String(id)) setSelectedId(null);
      setStatus('Model deleted.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const removeAllCreators = async (includeSeed) => {
    const label = includeSeed ? 'ALL models, including the seed/demo ones,' : 'all REAL (non-seed) models';
    if (!confirm(`Delete ${label}? This cannot be undone.`)) return;
    setBusy(true);
    setStatus('Deleting...');
    try {
      const res = await fetch(`/api/admin/delete-all${includeSeed ? '?includeSeed=true' : ''}`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      setCreators(data.creators);
      setSelectedId(null);
      setStatus(includeSeed ? 'All models deleted, seed rows included.' : 'Real models deleted, seed/demo rows kept.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
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
          <button onClick={checkKey} disabled={loading} className="w-full premium-button disabled:opacity-50">
            {loading ? 'Checking...' : 'Unlock'}
          </button>
          {status && <p className="mt-4 text-sm text-red-400">{status}</p>}
        </div>
      </div>
    );
  }

  return (
    <>
      <Head><title>Admin Panel - Only Ass</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-3xl font-black premium-title">Model Admin Panel</h1>
            <div className="flex gap-3">
              {page === 'creators' && creators.length > 0 && (
                <>
                  <button
                    onClick={() => removeAllCreators(false)}
                    disabled={busy}
                    className="text-sm px-4 py-2 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  >
                    Delete Real Creators
                  </button>
                  <button
                    onClick={() => removeAllCreators(true)}
                    disabled={busy}
                    className="text-sm px-4 py-2 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  >
                    Delete All (incl. seed)
                  </button>
                </>
              )}
              {page === 'creators' && (
                <button onClick={addCreator} disabled={busy} className="premium-button disabled:opacity-50">
                  + Add Model
                </button>
              )}
            </div>
          </div>

          <div className="flex gap-6 border-b border-brand-gold/20 mb-6">
            <button
              onClick={() => setPage('creators')}
              className={`pb-3 font-bold text-sm ${page === 'creators' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              CREATORS
            </button>
            <button
              onClick={() => setPage('reports')}
              className={`pb-3 font-bold text-sm ${page === 'reports' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              REPORTS
            </button>
            <button
              onClick={() => setPage('violations')}
              className={`pb-3 font-bold text-sm ${page === 'violations' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              VIOLATIONS
            </button>
            <button
              onClick={() => setPage('takedowns')}
              className={`pb-3 font-bold text-sm ${page === 'takedowns' ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
            >
              TAKEDOWN REQUESTS
            </button>
          </div>

          {status && (
            <div className="mb-6 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-brand-secondary text-sm">
              {status}
            </div>
          )}

          {page === 'reports' ? (
            <ReportsPanel adminKey={adminKey} />
          ) : page === 'violations' ? (
            <ViolationsPanel adminKey={adminKey} />
          ) : page === 'takedowns' ? (
            <NciiReportsPanel adminKey={adminKey} creators={creators} />
          ) : (
          <div className="grid md:grid-cols-3 gap-6">
            {/* Model list */}
            <div className="md:col-span-1 space-y-3">
              {creators.map((c) => {
                // Effective, not stored -- an expired suspension reads as
                // active here the same way it does everywhere public.
                const cStatus = effectiveCreatorStatus(c);
                const flagged = cStatus === 'pending' || cStatus === 'suspended' || cStatus === 'banned';
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full text-left premium-card p-4 flex items-center gap-3 transition ${
                      String(selectedId) === String(c.id) ? 'border-brand-gold' : ''
                    }`}
                  >
                    <img src={c.img} alt={c.name} className="w-12 h-12 rounded-full object-cover object-top border border-brand-gold/40" />
                    <div className="min-w-0">
                      <p className="font-bold text-white truncate flex items-center gap-1">
                        {c.name}
                        {c.premium && <img src="/icons/check.png" alt="Premium" className="h-4 w-4 shrink-0" title="Premium" />}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{c.handle}</p>
                    </div>
                    {cStatus === 'pending' && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-bold">PENDING</span>
                    )}
                    {cStatus === 'suspended' && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-bold">SUSPENDED</span>
                    )}
                    {cStatus === 'banned' && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-bold">BANNED</span>
                    )}
                    {!flagged && isFoundingCreator(c) && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-brand-gold/20 text-brand-gold font-bold">★ FOUNDING</span>
                    )}
                    {!flagged && !isFoundingCreator(c) && c.trending && (
                      <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-brand-gold/20 text-brand-gold font-bold">HOT</span>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Editor */}
            <div className="md:col-span-2">
              {!selected ? (
                <div className="premium-card p-8 text-center text-gray-400">
                  Select a model on the left to edit their profile, pfp, and content.
                </div>
              ) : (
                <div className="premium-card p-6 space-y-6">
                  <div className="flex items-center gap-4">
                    <img src={selected.img} alt={selected.name} className="w-20 h-20 rounded-full object-cover object-top border-2 border-brand-gold" />
                    <div>
                      <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                        Change PFP
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          disabled={busy}
                          onChange={(e) => uploadAvatar(e.target.files[0])}
                        />
                      </label>
                    </div>
                    <button
                      onClick={() => removeCreator(selected.id)}
                      className="ml-auto text-xs px-3 py-2 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition"
                    >
                      Delete Model
                    </button>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                    <Field label="Handle" value={draft.handle} onChange={(v) => setDraft({ ...draft, handle: v })} />
                    <Field label="Price" value={draft.price} onChange={(v) => setDraft({ ...draft, price: v })} />
                    <Field label="Subscribers" value={draft.subs} onChange={(v) => setDraft({ ...draft, subs: v })} />
                    <Field label="Posts" value={draft.posts} onChange={(v) => setDraft({ ...draft, posts: v })} />
                    <Field label="Likes" value={draft.likes} onChange={(v) => setDraft({ ...draft, likes: v })} />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Bio</label>
                    <textarea
                      value={draft.bio}
                      onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
                      rows={3}
                      className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-400 mb-2">Socials</label>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <Field label="X / Twitter username" value={draft.socials?.twitter} onChange={(v) => setDraft({ ...draft, socials: { ...draft.socials, twitter: v } })} />
                      <Field label="Instagram username" value={draft.socials?.instagram} onChange={(v) => setDraft({ ...draft, socials: { ...draft.socials, instagram: v } })} />
                      <Field label="TikTok username" value={draft.socials?.tiktok} onChange={(v) => setDraft({ ...draft, socials: { ...draft.socials, tiktok: v } })} />
                      <Field label="Reddit username" value={draft.socials?.reddit} onChange={(v) => setDraft({ ...draft, socials: { ...draft.socials, reddit: v } })} />
                    </div>
                    <div className="mt-3">
                      <Field label="Website (https://...)" value={draft.socials?.website} onChange={(v) => setDraft({ ...draft, socials: { ...draft.socials, website: v } })} />
                    </div>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm text-gray-400 mb-2">Get Paid In</label>
                      <select
                        value={draft.payoutMethod}
                        onChange={(e) => setDraft({ ...draft, payoutMethod: e.target.value })}
                        className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                      >
                        <option value="onlyass">$ONLYASS</option>
                        <option value="eth">ETH</option>
                      </select>
                    </div>
                    <Field label="Payout Wallet Address" value={draft.walletAddress} onChange={(v) => setDraft({ ...draft, walletAddress: v })} />
                  </div>

                  {selectedStatus === 'pending' && (
                    <div className="px-4 py-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
                      This profile is pending review and hidden from the public platform. Set status to Active below to publish it.
                    </div>
                  )}

                  <div className="flex flex-wrap gap-6 items-center">
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.locked}
                        onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
                      />
                      Locked (requires token holding)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.trending}
                        onChange={(e) => setDraft({ ...draft, trending: e.target.checked })}
                      />
                      Trending
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.premium}
                        onChange={(e) => setDraft({ ...draft, premium: e.target.checked })}
                      />
                      Premium (gold check, 200 content slots)
                    </label>
                    {/* The 100-slot cap is enforced server-side in
                        /api/admin/profile -- this only stops the admin from
                        spending a click on a save that will come back 409.
                        An already-founding creator stays togglable so a
                        mis-grant can be taken back. */}
                    <label
                      className={`flex items-center gap-2 text-sm cursor-pointer ${
                        foundingCapReached && !draft.founding ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!!draft.founding}
                        disabled={foundingCapReached && !draft.founding}
                        onChange={(e) => setDraft({ ...draft, founding: e.target.checked })}
                      />
                      Founding Creator — {foundingCount} of {FOUNDING_LIMIT} taken
                      {foundingCapReached && !draft.founding && ' (full)'}
                    </label>
                    {draft.founding && selected.foundingSince && (
                      <p className="text-xs text-gray-500 -mt-1">
                        Founding since {new Date(selected.foundingSince).toLocaleDateString()} — granting again
                        does not restart the fee-free window.
                      </p>
                    )}
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      Status
                      <select
                        value={draft.status}
                        onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                        className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                      >
                        <option value="active">Active (public)</option>
                        <option value="pending">Pending (hidden)</option>
                        <option value="suspended">Suspended (hidden, 30 days)</option>
                        <option value="banned">Banned (hidden, permanent)</option>
                      </select>
                    </label>
                  </div>

                  {(selected.contentViolationCount > 0 || selectedStatus === 'suspended' || selectedStatus === 'banned') && (
                    <p className="text-xs text-red-400">
                      {selected.contentViolationCount || 0} confirmed content violation(s)
                      {selectedStatus === 'suspended' && selected.suspendedUntil && ` — suspended until ${new Date(selected.suspendedUntil).toLocaleDateString()}, lifts itself on that date`}
                      {selectedStatus === 'suspended' && !selected.suspendedUntil && ' — suspended with no end date on record (a save from here will set one)'}
                      {selectedStatus === 'active' && selected.status === 'suspended' && ' — suspension has since expired, account is active again'}
                      {selectedStatus === 'banned' && ' — permanently banned'}
                      . Manually changing Status above overrides this (e.g. to reinstate early), but won't reset the
                      violation count itself.
                    </p>
                  )}

                  <button onClick={saveProfile} disabled={busy} className="premium-button disabled:opacity-50">
                    Save Profile
                  </button>

                  <hr className="border-brand-purple/20" />

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-bold text-brand-gold">
                        Gallery ({selected.gallery?.length || 0}/{selected.premium ? 200 : 50})
                      </h3>
                      <label className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy ? 'opacity-50 pointer-events-none' : ''}`}>
                        {busy ? 'Uploading...' : 'Upload Content'}
                        <input
                          type="file"
                          accept="image/*,video/*"
                          className="hidden"
                          disabled={busy}
                          onChange={(e) => {
                            const file = e.target.files[0];
                            if (!file) return;
                            uploadGalleryItem(file, nextUploadIsAi);
                            setNextUploadIsAi(false);
                            e.target.value = '';
                          }}
                        />
                      </label>
                    </div>
                    {/* Same self-reported AI label creators get on their own uploads
                        (pages/dashboard.js) -- content uploaded on a creator's behalf
                        has to be able to carry it too, since the labeling requirement
                        is about what's published, not who pressed upload. */}
                    <label className="flex items-center gap-2 text-xs text-gray-400 mb-3 cursor-pointer">
                      <input type="checkbox" checked={nextUploadIsAi} onChange={(e) => setNextUploadIsAi(e.target.checked)} />
                      This upload is AI-generated or synthetic content (will be labeled "AI" on the profile)
                    </label>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {(selected.gallery || []).map((item, i) => (
                        <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                          {item.type === 'video' ? (
                            <video src={item.src} className="w-full h-full object-cover" muted />
                          ) : (
                            <img src={item.src} alt="" className="w-full h-full object-cover" />
                          )}
                          {item.aiGenerated && (
                            <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                          )}
                          <button
                            onClick={() => deleteGalleryItem(i)}
                            disabled={busy}
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 transition disabled:opacity-30"
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
          )}
        </div>
      </div>
    </>
  );
}

function Field({ label, value, onChange }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-2">{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
      />
    </div>
  );
}

function ReportsPanel({ adminKey }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async (status) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/reports?status=${status}`, { headers: { 'x-admin-key': adminKey } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load reports');
      setReports(data.reports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch('/api/admin/reports-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resolve report');
      setReports(reports.filter((r) => String(r.id) !== String(id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const targetLabel = (r) => (r.targetType === 'wall_post' ? 'Wall comment' : r.targetType === 'listing' ? 'Marketplace listing' : r.targetType);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        >
          <option value="open">Open</option>
          <option value="dismissed">Dismissed</option>
          <option value="actioned">Actioned</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-gray-500">No {statusFilter === 'all' ? '' : statusFilter} reports.</p>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => (
            <div key={r.id} className="premium-card border border-brand-purple/20 p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-brand-gold">{targetLabel(r)} #{r.targetId}</p>
                <p className="text-[10px] text-gray-600">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
              <p className="text-sm text-gray-300 mb-3">{r.reason}</p>
              {r.status === 'open' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve(r.id, 'dismiss')}
                    disabled={busyId === r.id}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => resolve(r.id, 'remove_content')}
                    disabled={busyId === r.id}
                    className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  >
                    Remove Content
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-500">{r.status} by {r.resolvedBy}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const CONTEXT_LABELS = {
  message: 'Direct message',
  wall_post: 'Wall comment',
  bio: 'Profile bio',
  name: 'Profile display name',
  handle: 'Profile handle',
  listing_title: 'Listing title',
  listing_description: 'Listing description',
};

/** Auto-flagged, blocked sends -- see lib/payment-circumvention-filter.js. The flagged message/post itself was never stored, only this record of who tried and why. */
function ViolationsPanel({ adminKey }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async (status) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/violations?status=${status}`, { headers: { 'x-admin-key': adminKey } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load violations');
      setViolations(data.violations);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch('/api/admin/violations-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ id, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resolve violation');
      setViolations(violations.filter((v) => String(v.id) !== String(id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Every surface the filter is wired into logs its own context string (see
  // the addViolation calls in pages/api/...). Anything unrecognized shows the
  // raw context rather than being mislabeled as a DM, which is what the old
  // two-branch ternary did to every profile-name, handle and listing flag.
  const contextLabel = (v) => CONTEXT_LABELS[v.context] || v.context;

  // Admin-path flags have no logged-in user behind them -- pages/api/admin/profile.js
  // records which creator record the text was headed for instead.
  const actorLabel = (v) => {
    const adminEdit = String(v.userId || '').match(/^admin-edit:creator:(.+)$/);
    return adminEdit ? `creator #${adminEdit[1]} (admin edit)` : `user #${v.userId}`;
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        >
          <option value="open">Open</option>
          <option value="dismiss">Dismissed</option>
          <option value="confirmed">Confirmed</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : violations.length === 0 ? (
        <p className="text-sm text-gray-500">No {statusFilter === 'all' ? '' : statusFilter} violations.</p>
      ) : (
        <div className="space-y-3">
          {violations.map((v) => (
            <div key={v.id} className="premium-card border border-brand-purple/20 p-4">
              <div className="flex items-center justify-between mb-1">
                <p className="text-xs font-bold text-brand-gold">{contextLabel(v)} -- {actorLabel(v)}</p>
                <p className="text-[10px] text-gray-600">{new Date(v.createdAt).toLocaleString()}</p>
              </div>
              <p className="text-xs text-gray-500 mb-1">Flagged: {v.reasons.join(', ')}</p>
              <p className="text-sm text-gray-300 mb-3 font-mono break-all">"{v.snippet}"</p>
              {v.status === 'open' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve(v.id, 'dismiss')}
                    disabled={busyId === v.id}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                  >
                    Dismiss (false positive)
                  </button>
                  <button
                    onClick={() => resolve(v.id, 'confirmed')}
                    disabled={busyId === v.id}
                    className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  >
                    Confirm violation
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-500">{v.status} by {v.resolvedBy}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Non-consensual intimate imagery (NCII) / deepfake takedown requests --
 * the notice-and-removal process required by the federal TAKE IT DOWN Act.
 * These carry a legal 48-hour handling clock, so they're sorted oldest
 * first and flag how much time has passed instead of just a timestamp.
 */
function NciiReportsPanel({ adminKey, creators }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [attributed, setAttributed] = useState({});

  const load = async (status) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/admin/ncii-reports?status=${status}`, { headers: { 'x-admin-key': adminKey } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load takedown requests');
      setReports(data.reports);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (id, action) => {
    const creatorId = attributed[id] || null;
    if (action === 'removed') {
      const violationNote = creatorId
        ? ' This will also count as a confirmed content violation against the selected creator (30-day suspension on the 1st, permanent ban on the 2nd).'
        : ' No creator selected -- this will be logged as removed without counting toward any account\'s violation record.';
      if (!confirm(`Confirm you have already removed the reported content before marking this resolved.${violationNote}`)) return;
    }
    setBusyId(id);
    setError('');
    try {
      const res = await fetch('/api/admin/ncii-reports-resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ id, action, creatorId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to resolve report');
      setReports(reports.filter((r) => String(r.id) !== String(id)));
      if (data.creator) {
        setError(
          data.creator.status === 'banned'
            ? `${data.creator.name} has been permanently banned (2nd confirmed violation).`
            : `${data.creator.name} suspended until ${new Date(data.creator.suspendedUntil).toLocaleDateString()} (1st confirmed violation).`
        );
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const hoursOpen = (r) => Math.floor((Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60));

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Filed via /report-content, no login required. Legally required to be reviewed and, if valid, the content
        removed within 48 hours of submission.
      </p>
      <div className="flex items-center gap-3 mb-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
        >
          <option value="open">Open</option>
          <option value="dismiss">Dismissed</option>
          <option value="removed">Removed</option>
          <option value="all">All</option>
        </select>
      </div>

      {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
      {loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : reports.length === 0 ? (
        <p className="text-sm text-gray-500">No {statusFilter === 'all' ? '' : statusFilter} takedown requests.</p>
      ) : (
        <div className="space-y-3">
          {reports.map((r) => {
            const hrs = hoursOpen(r);
            const overdue = r.status === 'open' && hrs >= 48;
            const dueSoon = r.status === 'open' && hrs >= 36 && hrs < 48;
            return (
              <div key={r.id} className={`premium-card border p-4 ${overdue ? 'border-red-500' : dueSoon ? 'border-yellow-500/60' : 'border-brand-purple/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-brand-gold">Report #{r.id} — {r.reporterName}</p>
                  <p className={`text-[10px] font-bold ${overdue ? 'text-red-400' : dueSoon ? 'text-yellow-400' : 'text-gray-600'}`}>
                    {r.status === 'open' ? `${hrs}h open${overdue ? ' — OVERDUE (48h)' : ''}` : `${r.status} by ${r.resolvedBy}`}
                  </p>
                </div>
                <p className="text-xs text-gray-500 mb-1">Contact: {r.reporterContact}</p>
                <p className="text-sm text-gray-300 mb-1"><span className="text-gray-500">Content:</span> {r.contentLocation}</p>
                {r.description && <p className="text-sm text-gray-400 mb-3">{r.description}</p>}
                {r.status === 'open' && (
                  <>
                    <div className="mb-2">
                      <label className="block text-[10px] text-gray-500 mb-1">
                        Which creator posted this? (attributing it applies the violation ladder on resolve)
                      </label>
                      <select
                        value={attributed[r.id] || ''}
                        onChange={(e) => setAttributed({ ...attributed, [r.id]: e.target.value })}
                        className="w-full px-2 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs"
                      >
                        <option value="">— Not attributed to a creator —</option>
                        {(creators || []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name} ({c.handle}){c.contentViolationCount ? ` — ${c.contentViolationCount} prior violation(s)` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => resolve(r.id, 'dismiss')}
                        disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                      >
                        Dismiss (invalid)
                      </button>
                      <button
                        onClick={() => resolve(r.id, 'removed')}
                        disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                      >
                        Mark Removed & Resolve
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
