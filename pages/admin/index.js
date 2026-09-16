import { useState, useEffect } from 'react';
import Head from 'next/head';

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

  const authHeaders = { 'x-admin-key': adminKey };

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
        status: selected.status || 'active',
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

  const uploadGalleryItem = async (file) => {
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
          ) : (
          <div className="grid md:grid-cols-3 gap-6">
            {/* Model list */}
            <div className="md:col-span-1 space-y-3">
              {creators.map((c) => (
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
                  {c.status === 'pending' && (
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 font-bold">PENDING</span>
                  )}
                  {c.status !== 'pending' && c.trending && (
                    <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-brand-gold/20 text-brand-gold font-bold">HOT</span>
                  )}
                </button>
              ))}
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
                      <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                        Change PFP
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
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

                  {selected.status === 'pending' && (
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
                      Premium (gold check, 10 content slots)
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300">
                      Status
                      <select
                        value={draft.status}
                        onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                        className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white"
                      >
                        <option value="active">Active (public)</option>
                        <option value="pending">Pending (hidden)</option>
                      </select>
                    </label>
                  </div>

                  <button onClick={saveProfile} disabled={busy} className="premium-button disabled:opacity-50">
                    Save Profile
                  </button>

                  <hr className="border-brand-purple/20" />

                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="font-bold text-brand-gold">
                        Gallery ({selected.gallery?.length || 0}/{selected.premium ? 10 : 4})
                      </h3>
                      <label className="premium-button inline-block cursor-pointer text-sm py-2 px-4">
                        Upload Content
                        <input
                          type="file"
                          accept="image/*,video/*"
                          className="hidden"
                          onChange={(e) => uploadGalleryItem(e.target.files[0])}
                        />
                      </label>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {(selected.gallery || []).map((item, i) => (
                        <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                          {item.type === 'video' ? (
                            <video src={item.src} className="w-full h-full object-cover" muted />
                          ) : (
                            <img src={item.src} alt="" className="w-full h-full object-cover" />
                          )}
                          <button
                            onClick={() => deleteGalleryItem(i)}
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

  const contextLabel = (v) => (v.context === 'wall_post' ? 'Wall comment' : v.context === 'bio' ? 'Profile bio' : 'Direct message');

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
                <p className="text-xs font-bold text-brand-gold">{contextLabel(v)} -- user #{v.userId}</p>
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
