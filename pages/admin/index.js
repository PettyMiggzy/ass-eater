import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { effectiveCreatorStatus } from '../../lib/creator-status';
import { FOUNDING_LIMIT, countFounding, isFoundingCreator } from '../../lib/founding';
import { sanitizeGateTokens, tokenGateLive } from '../../lib/token-gate';
import { Icons, SolidIcons } from '../../components/Brand';
import { formatCredits, DM_PRICE_FLOOR_CENTS } from '../../lib/brand';
import {
  readJson,
  errorFrom,
  adminPost,
  adminGet,
  adminUploadMedia,
  dollars,
  describeObligation,
} from '../../components/admin/adminApi';
import { draftFrom, fieldsFromDraft, rebaseDraft, fieldName } from '../../components/admin/creatorDraft';

// The oa_admin_media cookie (POST /api/admin/media-session) lasts 2 hours;
// refreshed well inside that so a panel left open keeps loading private media.
const MEDIA_SESSION_REFRESH_MS = 100 * 60 * 1000;
// How often the takedown-request badge re-checks while the panel is open.
const NCII_POLL_MS = 5 * 60 * 1000;

const HEX_WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

export default function AdminPanel() {
  const [adminKey, setAdminKey] = useState('');
  const [unlocked, setUnlocked] = useState(false);
  const [creators, setCreators] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({});
  // What the open draft was built from (draftFrom of the server's record at
  // the time). Saves send only the fields that differ from it, after rebasing
  // onto a fresh read -- see saveProfile.
  const [baseline, setBaseline] = useState(null);
  const [othersAppear, setOthersAppear] = useState(null);
  const [coPerformerIds, setCoPerformerIds] = useState([]);
  const [recordOptions, setRecordOptions] = useState(null);
  const selectSeq = useRef(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState('creators');
  const [nextUploadIsAi, setNextUploadIsAi] = useState(false);
  const [mediaSessionOk, setMediaSessionOk] = useState(true);
  const [nciiSummary, setNciiSummary] = useState(null);

  // Live off the loaded roster, so the counter and the cap agree with what
  // the server will decide on save.
  const foundingCount = countFounding(creators);
  const foundingCapReached = foundingCount >= FOUNDING_LIMIT;

  const loadCreators = async (key) => {
    setLoading(true);
    try {
      const { res, data } = await adminGet(key ?? adminKey, '/api/admin/creators');
      if (!res.ok || !Array.isArray(data.creators)) {
        throw new Error(res.status === 401 || res.status === 403 ? 'Bad admin key' : errorFrom(res, data, 'Could not load creators'));
      }
      setCreators(data.creators);
      return true;
    } catch (err) {
      setStatus(`Error: ${err.message}`);
      return false;
    } finally {
      setLoading(false);
    }
  };

  // Private media (/api/media/...) is served to admins by a cookie, because an
  // <img> or <video> tag cannot send the x-admin-key header. Without it every
  // uploaded avatar and gallery item in this panel is a broken image.
  const startMediaSession = async (key) => {
    try {
      const res = await fetch('/api/admin/media-session', { method: 'POST', headers: { 'x-admin-key': key } });
      setMediaSessionOk(res.ok);
      return res.ok;
    } catch {
      setMediaSessionOk(false);
      return false;
    }
  };

  const loadNciiSummary = async (key) => {
    try {
      const { res, data } = await adminGet(key ?? adminKey, '/api/admin/ncii-reports?status=open');
      if (res.ok && data.summary) setNciiSummary(data.summary);
    } catch {
      // The badge is a convenience; the TAKEDOWN tab itself shows the real list.
    }
  };

  const checkKey = async () => {
    const key = adminKey.trim();
    if (!key) return;
    const ok = await loadCreators(key);
    if (!ok) return;
    await startMediaSession(key);
    loadNciiSummary(key);
    setStatus('');
    setUnlocked(true);
  };

  const lockPanel = async () => {
    try {
      await fetch('/api/admin/media-session', { method: 'DELETE' });
    } catch {
      // Best effort: the cookie also expires on its own within 2 hours.
    }
    setUnlocked(false);
    setAdminKey('');
    setCreators([]);
    setSelectedId(null);
    setDraft({});
    setBaseline(null);
    setStatus('');
  };

  useEffect(() => {
    if (!unlocked) return undefined;
    const media = setInterval(() => { startMediaSession(adminKey); }, MEDIA_SESSION_REFRESH_MS);
    const ncii = setInterval(() => { loadNciiSummary(adminKey); }, NCII_POLL_MS);
    return () => {
      clearInterval(media);
      clearInterval(ncii);
    };
  }, [unlocked, adminKey]);

  const selected = creators.find((c) => String(c.id) === String(selectedId));
  // A suspension lifts itself once suspendedUntil passes -- nothing rewrites
  // the stored `status` when it does, so every status shown here has to go
  // through effectiveCreatorStatus() or the panel keeps reporting someone as
  // suspended long after they're publicly visible again.
  const selectedStatus = selected ? effectiveCreatorStatus(selected) : null;
  // pages/api/admin/profile.js refuses pending -> suspended (a suspension
  // lapses into 'active' after 30 days, which would publish an applicant who
  // was never approved), so the option isn't offered for one.
  const selectedIsPending = !!selected && (selected.status === 'pending' || selectedStatus === 'pending');

  /** The roster as the server has it now, or null (status already set). */
  const fetchRoster = async () => {
    const { res, data } = await adminGet(adminKey, '/api/admin/creators');
    if (!res.ok || !Array.isArray(data.creators)) {
      setStatus(`Error: ${errorFrom(res, data, 'Could not load creators')}`);
      return null;
    }
    setCreators(data.creators);
    return data.creators;
  };

  // Selecting a creator re-reads them, rather than editing the roster
  // snapshot loaded at unlock: the creator may have changed their wallet, bio
  // or handle from their dashboard since, and a draft built from the old copy
  // is exactly what used to write those values back.
  const selectCreator = async (id) => {
    const seq = ++selectSeq.current;
    setSelectedId(id);
    const snap = creators.find((c) => String(c.id) === String(id));
    if (snap) { setDraft(draftFrom(snap)); setBaseline(draftFrom(snap)); }
    setOthersAppear(null);
    setCoPerformerIds([]);
    try {
      const roster = await fetchRoster();
      if (!roster || seq !== selectSeq.current) return;
      const fresh = roster.find((c) => String(c.id) === String(id));
      if (!fresh) { setSelectedId(null); setStatus('That creator no longer exists.'); return; }
      setDraft(draftFrom(fresh));
      setBaseline(draftFrom(fresh));
    } catch {
      if (seq === selectSeq.current) setStatus('Error: could not refresh this creator. Reload before saving.');
    }
  };

  /** Puts the server's copy of a creator into the roster (and the draft, if it's the one open). */
  const applyCreator = (creator, { resyncDraft = false } = {}) => {
    if (!creator || creator.id === undefined) return;
    setCreators((prev) => prev.map((c) => (String(c.id) === String(creator.id) ? creator : c)));
    if (resyncDraft && String(creator.id) === String(selectedId)) {
      setDraft(draftFrom(creator));
      setBaseline(draftFrom(creator));
    }
  };

  const saveProfile = async () => {
    if (!baseline) { setStatus('Error: this creator is still loading. Try again in a moment.'); return; }
    if (fieldsFromDraft(draft, baseline).error) { setStatus(`Error: ${fieldsFromDraft(draft, baseline).error}`); return; }
    setBusy(true);
    setStatus('Saving...');
    try {
      // Rebase onto the record as it is right now, so a change the creator
      // (or another admin tab) made since this draft was opened is never
      // overwritten by a value the admin didn't touch -- and one the admin
      // DID touch is stopped and shown instead of silently replaced.
      const roster = await fetchRoster();
      if (!roster) return;
      const current = roster.find((c) => String(c.id) === String(selectedId));
      if (!current) { setSelectedId(null); setStatus('Error: that creator no longer exists. Nothing was saved.'); return; }
      const rebased = rebaseDraft(draft, baseline, current);
      setBaseline(rebased.baseline);
      setDraft(rebased.draft);
      if (rebased.conflicts.length) {
        setStatus(
          `Nothing was saved -- the ${rebased.conflicts.map(fieldName).join(', ')} changed since you opened this creator `
          + '(they may have edited it themselves). The editor now shows the current value; check it and save again.',
        );
        return;
      }
      const built = fieldsFromDraft(rebased.draft, rebased.baseline);
      if (built.error) throw new Error(built.error);
      if (!Object.keys(built.fields).length) { setStatus('Nothing to save -- no field was changed.'); return; }
      const { res, data } = await adminPost(adminKey, '/api/admin/profile', { creatorId: selectedId, fields: built.fields });
      // A ban whose listing takedown failed comes back 500 WITH the saved
      // creator: the ban stands, so the roster and draft must show it.
      if (data.creator) applyCreator(data.creator, { resyncDraft: true });
      if (!res.ok) throw new Error(errorFrom(res, data, 'Save failed'));
      const was = current;
      const now = data.creator;
      const notes = [];
      if (now && !isFoundingCreator(was) && isFoundingCreator(now)) notes.push('Founding Creator granted.');
      if (now && effectiveCreatorStatus(now) === 'suspended' && now.suspendedUntil) {
        notes.push(`Suspended until ${new Date(now.suspendedUntil).toLocaleDateString()}.`);
      }
      setStatus(['Saved.', ...notes].join(' '));
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  const uploadAvatar = async (file) => {
    if (!file) return;
    const creatorId = selectedId;
    setBusy(true);
    setStatus('Uploading avatar...');
    try {
      const data = await adminUploadMedia({
        adminKey,
        creatorId,
        purpose: 'avatar',
        file,
        onProgress: (p) => setStatus(`Uploading avatar... ${Math.round(p)}%`),
      });
      applyCreator(data.creator);
      setStatus('Avatar updated.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Takes a reported or unwanted profile photo down: resets it to the
  // placeholder and deletes the file (pages/api/admin/avatar.js remove:true).
  const removeAvatar = async () => {
    if (!confirm("Remove this creator's profile photo? It is replaced with the neutral placeholder and the file is deleted from storage.")) return;
    setBusy(true);
    setStatus('Removing photo...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/avatar', { creatorId: String(selectedId), remove: true });
      if (!res.ok || !data.creator) throw new Error(errorFrom(res, data, 'Could not remove the photo'));
      applyCreator(data.creator);
      setStatus(data.removed ? 'Photo removed and the file deleted.' : 'Photo reset to the placeholder (there was no uploaded file to delete).');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // The §2257 records a co-performer can be picked from: non-archived, with an
  // ID attached or held offline (the same rule lib/performer-attestation.js
  // enforces on the finalize). Loaded when the admin says someone else appears.
  const loadRecordOptions = async () => {
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/performer-records');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not load §2257 records'));
      const usable = (Array.isArray(data.records) ? data.records : [])
        .filter((r) => r.status !== 'archived' && (r.document || r.documentLocation === 'offline'));
      setRecordOptions(usable);
    } catch (err) {
      setRecordOptions([]);
      setStatus(`Error: ${err.message}`);
    }
  };

  const uploadGalleryItem = async (file, aiGenerated) => {
    if (!file) return;
    const creatorId = selectedId;
    // §2257: every upload says whether anyone besides the creator appears,
    // and co-performer content names each other person's record.
    if (othersAppear === null) {
      setStatus('Error: answer "Does anyone besides this creator appear in it?" before uploading.');
      return;
    }
    if (othersAppear && !coPerformerIds.length) {
      setStatus('Error: pick the §2257 record of every other person who appears, or add their record in the Records tab first.');
      return;
    }
    setBusy(true);
    setStatus('Uploading content...');
    try {
      const data = await adminUploadMedia({
        adminKey,
        creatorId,
        purpose: 'gallery',
        file,
        aiGenerated,
        othersAppear,
        coPerformerRecordIds: othersAppear ? coPerformerIds : undefined,
        onProgress: (p) => setStatus(`Uploading content... ${Math.round(p)}%`),
      });
      applyCreator(data.creator);
      setOthersAppear(null);
      setCoPerformerIds([]);
      setStatus('Content added.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Deletes by src, with the index only as a hint: the roster here is loaded
  // once and goes stale while the creator keeps editing, and this is the path
  // used to take a reported photo down -- it must remove the item that was
  // clicked or nothing at all (409), never whatever now sits at that index.
  const deleteGalleryItem = async (item, index) => {
    if (!item || typeof item.src !== 'string') return;
    setBusy(true);
    setStatus('Removing...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/gallery-delete', {
        creatorId: selectedId,
        src: item.src,
        index,
      });
      if (res.status === 409) {
        await loadCreators();
        setStatus('That item had already changed or been removed -- the gallery has been refreshed. Check it and try again if needed.');
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Delete failed'));
      applyCreator(data.creator);
      setStatus('Removed (the file is deleted from storage too).');
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
      const { res, data } = await adminPost(adminKey, '/api/admin/create', {});
      if (!res.ok || !data.creator) throw new Error(errorFrom(res, data, 'Create failed'));
      setCreators((prev) => [...prev, data.creator]);
      selectSeq.current += 1;
      setSelectedId(data.creator.id);
      setDraft(draftFrom(data.creator));
      setBaseline(draftFrom(data.creator));
      setStatus('Model created as a hidden, pending draft. Fill in the details and a handle, add a §2257 record for them in the Records tab (ID attached or marked held offline), then set Status to Active.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // A creator with money or unshipped paid orders attached is refused (409)
  // with the exact obligations; deleting anyway needs a second, explicit
  // confirmation and is sent with force:true. Deleting removes their login,
  // so that balance / those orders become unreachable -- banning keeps them.
  const removeCreator = async (id) => {
    if (!confirm('Delete this model entirely, including their login? This cannot be undone.')) return;
    setBusy(true);
    setStatus('Deleting model...');
    try {
      let force = false;
      for (;;) {
        const { res, data } = await adminPost(adminKey, '/api/admin/delete', { creatorId: id, force });
        if (res.status === 409 && data.code === 'creator_has_obligations' && !force) {
          const lines = (Array.isArray(data.obligations) ? data.obligations : [])
            .map((o) => `• ${describeObligation(o, creators)}`)
            .join('\n');
          const ok = confirm(
            `${data.error || 'This creator still has money or orders attached.'}\n\n${lines}\n\n`
            + 'Deleting anyway removes their login and leaves all of this unreachable. Banning them instead keeps it '
            + 'recoverable.\n\nDelete anyway?',
          );
          if (!ok) { setStatus('Nothing was deleted.'); return; }
          force = true;
          continue;
        }
        if (!res.ok || !Array.isArray(data.creators)) throw new Error(errorFrom(res, data, 'Delete failed'));
        setCreators(data.creators);
        if (String(selectedId) === String(id)) setSelectedId(null);
        const stranded = Array.isArray(data.stranded) ? data.stranded : [];
        setStatus(
          stranded.length
            ? `Model deleted. Left behind: ${stranded.map((o) => describeObligation(o, creators)).join('; ')}.`
            : 'Model deleted.',
        );
        return;
      }
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Creators with money or unshipped orders attached are SKIPPED, not
  // deleted, and listed -- delete them one at a time (with the explicit
  // override) or ban them.
  const removeAllCreators = async (includeSeed) => {
    const label = includeSeed ? 'ALL models, including the seed/demo ones,' : 'all REAL (non-seed) models';
    if (!confirm(`Delete ${label} and their logins? Creators who still have a credit balance, a pending payout or an unshipped order are skipped. This cannot be undone.`)) return;
    setBusy(true);
    setStatus('Deleting...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/delete-all', { includeSeed: includeSeed === true });
      if (!res.ok || !Array.isArray(data.creators)) throw new Error(errorFrom(res, data, 'Delete failed'));
      setCreators(data.creators);
      setSelectedId(null);
      const skipped = Array.isArray(data.skipped) ? data.skipped : [];
      const stranded = Array.isArray(data.stranded) ? data.stranded : [];
      const parts = [includeSeed ? 'Models deleted, seed rows included.' : 'Real models deleted, seed/demo rows kept.'];
      if (skipped.length) {
        parts.push(`Skipped ${skipped.length} with money or orders attached (delete individually or ban): ${skipped.map((o) => describeObligation(o, creators)).join('; ')}.`);
      }
      if (stranded.length) parts.push(`Left behind: ${stranded.map((o) => describeObligation(o, creators)).join('; ')}.`);
      setStatus(parts.join(' '));
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Reaps uploads that were never finalized and retries failed deletions
  // (lib/media.js sweepOrphanedMedia). Runs in small batches on every upload
  // anyway; this runs it in full. Never touches a file a record references.
  const sweepMedia = async () => {
    setBusy(true);
    setStatus('Sweeping orphaned uploads...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/media-sweep', {});
      if (!res.ok) throw new Error(errorFrom(res, data, 'Sweep failed'));
      const n = (v) => Number(v) || 0;
      setStatus(`Sweep done: ${n(data.checked)} checked, ${n(data.deleted)} deleted, ${n(data.kept)} still in use, ${n(data.failed)} failed (retried next sweep).`);
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!unlocked) {
    return (
      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <Head><title>Admin Panel - OnlyOne</title></Head>
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

  const nciiOpen = Number(nciiSummary?.open) || 0;
  const nciiOldestHours = nciiSummary?.oldestOpenCreatedAt
    ? Math.floor((Date.now() - new Date(nciiSummary.oldestOpenCreatedAt).getTime()) / (1000 * 60 * 60))
    : null;
  const nciiUrgent = nciiOpen > 0 && nciiOldestHours !== null && nciiOldestHours >= 36;

  const tabs = [
    { key: 'creators', label: 'CREATORS' },
    { key: 'reports', label: 'REPORTS' },
    { key: 'violations', label: 'VIOLATIONS' },
    { key: 'takedowns', label: 'TAKEDOWN REQUESTS', badge: nciiOpen },
    { key: 'records', label: '§2257 RECORDS' },
    { key: 'waitlist', label: 'WAITLIST' },
    { key: 'payouts', label: 'PAYOUTS' },
  ];

  const gateLive = tokenGateLive();

  return (
    <>
      <Head><title>Admin Panel - OnlyOne</title></Head>
      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-10">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <h1 className="text-3xl font-black premium-title">Model Admin Panel</h1>
            <div className="flex flex-wrap gap-3">
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
                <button
                  onClick={sweepMedia}
                  disabled={busy}
                  title="Delete uploaded files that no profile or listing uses"
                  className="text-sm px-4 py-2 rounded-md border border-white/15 text-gray-400 hover:text-white transition disabled:opacity-50"
                >
                  Sweep orphaned uploads
                </button>
              )}
              {page === 'creators' && (
                <button onClick={addCreator} disabled={busy} className="premium-button disabled:opacity-50">
                  + Add Model
                </button>
              )}
              <button
                onClick={lockPanel}
                className="text-sm px-4 py-2 rounded-md border border-white/15 text-gray-400 hover:text-white transition"
              >
                Lock
              </button>
            </div>
          </div>

          {nciiOpen > 0 && (
            <button
              onClick={() => setPage('takedowns')}
              className={`w-full text-left mb-4 px-4 py-3 rounded-md border text-sm ${
                nciiUrgent ? 'bg-red-900/40 border-red-500 text-red-200' : 'bg-yellow-900/20 border-yellow-500/50 text-yellow-200'
              }`}
            >
              {nciiOpen} open TAKE IT DOWN request{nciiOpen === 1 ? '' : 's'}
              {nciiOldestHours !== null && ` -- oldest filed ${nciiOldestHours}h ago`}. Each must be reviewed and, if valid,
              removed within 48 hours of filing.{nciiOldestHours !== null && nciiOldestHours >= 48 ? ' OVERDUE.' : ''}
            </button>
          )}

          {!mediaSessionOk && (
            <div className="mb-4 px-4 py-3 rounded-md bg-yellow-900/20 border border-yellow-500/40 text-yellow-200 text-sm">
              Uploaded photos and videos may not display in this panel (the private-media session could not be started).
              <button onClick={() => startMediaSession(adminKey)} className="ml-2 underline">Retry</button>
            </div>
          )}

          <div className="flex flex-wrap gap-x-6 gap-y-2 border-b border-brand-gold/20 mb-6">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setPage(t.key)}
                className={`pb-3 font-bold text-sm ${page === t.key ? 'text-brand-gold border-b-2 border-brand-gold' : 'text-gray-500'}`}
              >
                {t.label}
                {t.badge > 0 && (
                  <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded-full text-white ${nciiUrgent ? 'bg-red-600' : 'bg-yellow-600'}`}>
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          {status && (
            <div className="mb-6 px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-brand-secondary text-sm whitespace-pre-line">
              {status}
            </div>
          )}

          {page === 'reports' ? (
            <ReportsPanel adminKey={adminKey} />
          ) : page === 'violations' ? (
            <ViolationsPanel adminKey={adminKey} />
          ) : page === 'takedowns' ? (
            <NciiReportsPanel
              adminKey={adminKey}
              creators={creators}
              onSummary={setNciiSummary}
              onCreatorChanged={(c) => applyCreator(c, { resyncDraft: true })}
            />
          ) : page === 'records' ? (
            <PerformerRecordsPanel adminKey={adminKey} creators={creators} />
          ) : page === 'waitlist' ? (
            <WaitlistPanel adminKey={adminKey} />
          ) : page === 'payouts' ? (
            <PayoutsPanel adminKey={adminKey} />
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
                    onClick={() => selectCreator(c.id)}
                    // Switching creators mid-save would resync the wrong
                    // draft; the list waits for the request to finish.
                    disabled={busy}
                    className={`w-full text-left premium-card p-4 flex items-center gap-3 transition disabled:opacity-70 ${
                      String(selectedId) === String(c.id) ? 'border-brand-gold' : ''
                    }`}
                  >
                    <img src={c.img} alt={c.name} className="w-12 h-12 rounded-full object-cover object-top border border-brand-gold/40" />
                    <div className="min-w-0">
                      <p className="font-bold text-white truncate flex items-center gap-1">
                        {c.name}
                        {c.premium && <SolidIcons.verified className="h-4 w-4 shrink-0 text-brand-pink" title="Premium" />}
                      </p>
                      <p className="text-xs text-gray-400 truncate">{c.handle || '(no handle yet)'}</p>
                      {(c.seed || c.demo) && <p className="text-[10px] text-gray-500">Demo — not for sale</p>}
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
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-brand-gold/20 text-brand-gold font-bold"><SolidIcons.star className="h-3 w-3" />FOUNDING</span>
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
                          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                          className="hidden"
                          disabled={busy}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            uploadAvatar(file);
                          }}
                        />
                      </label>
                      <p className="text-[10px] text-gray-500 mt-1">JPEG, PNG, WebP, GIF or AVIF, up to 10MB. The old photo is deleted.</p>
                      {typeof selected.img === 'string' && !selected.img.endsWith('/avatar-placeholder.png') && (
                        <button
                          onClick={removeAvatar}
                          disabled={busy}
                          className="mt-2 text-[11px] px-3 py-1 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                        >
                          Remove photo
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => removeCreator(selected.id)}
                      disabled={busy}
                      className="ml-auto text-xs px-3 py-2 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                    >
                      Delete Model
                    </button>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                    <Field label="Handle (required to go live)" value={draft.handle} onChange={(v) => setDraft({ ...draft, handle: v })} />
                    <Field label="Price" value={draft.price} onChange={(v) => setDraft({ ...draft, price: v })} />
                  </div>
                  {/* No Subscribers / Posts / Likes: the site has no such
                      counters. Posts shown publicly is the real gallery size;
                      the other two are not published. */}

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
                      <Field label="Payout Wallet Address (paid in USDG)" value={draft.walletAddress} onChange={(v) => setDraft({ ...draft, walletAddress: v })} />
                      {draft.walletAddress && !HEX_WALLET_RE.test(String(draft.walletAddress).trim()) && (
                        <p className="text-xs text-yellow-400/80 mt-1">Must be 0x followed by 40 hex characters, or blank.</p>
                      )}
                      <p className="text-[10px] text-gray-500 mt-1">
                        Payouts are USDG only, of earned credits only, and are sent by hand from the Payouts tab.
                      </p>
                    </div>
                    <div>
                      <Field
                        label={`Price for a fan to message them (USD, blank = $${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)} default)`}
                        value={draft.dmPrice}
                        onChange={(v) => setDraft({ ...draft, dmPrice: v })}
                      />
                      <p className="text-[10px] text-gray-500 mt-1">
                        Never less than ${(DM_PRICE_FLOOR_CENTS / 100).toFixed(2)}. Creators reply for free.
                      </p>
                    </div>
                  </div>

                  {selectedStatus === 'pending' && (
                    <div className="px-4 py-3 rounded-md bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-sm">
                      This profile is pending review and hidden from the public platform. To publish it: give it a handle,
                      add a §2257 performer record linked to this creator in the Records tab (with the photo ID attached, or
                      marked as held offline), then set Status to Active.
                      Every public field is screened again when it goes live.
                    </div>
                  )}

                  <div className="flex flex-wrap gap-6 items-center">
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!draft.locked}
                        onChange={(e) => setDraft({ ...draft, locked: e.target.checked })}
                      />
                      Token-gated (fans must hold $ONLYONE)
                    </label>
                    {/* The threshold has to be editable wherever the flag is.
                        Without it this panel could only produce the flag-with-
                        no-number state that lib/token-gate.js exists to
                        prevent -- which the creator can't see or fix from
                        their own dashboard. */}
                    {draft.locked && (
                      <label className="flex items-center gap-2 text-sm text-gray-300">
                        Amount
                        <input
                          type="number"
                          min="1"
                          step="1"
                          value={draft.gateTokens}
                          onChange={(e) => setDraft({ ...draft, gateTokens: e.target.value })}
                          placeholder="e.g. 2500000"
                          className="w-40 px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                        />
                        {!sanitizeGateTokens(draft.gateTokens) && (
                          <span className="text-xs text-yellow-400/80">Set an amount, or the gate does nothing.</span>
                        )}
                      </label>
                    )}
                    {draft.locked && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        {gateLive
                          ? 'Fans unlock the gallery by signing with a wallet that holds at least this many $ONLYONE -- the balance is read on-chain and nothing is spent. The creator always sees their own page. Admins see gated media in this panel, but see locked tiles on the public profile like any other visitor.'
                          : 'Token gating switches on once the $ONLYONE token contract is configured. Until then the flag is saved but nobody is gated.'}
                      </p>
                    )}
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!draft.trending}
                        onChange={(e) => setDraft({ ...draft, trending: e.target.checked })}
                      />
                      Trending
                    </label>
                    <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!draft.premium}
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
                        disabled={foundingCapReached && !draft.founding && !isFoundingCreator(selected)}
                        onChange={(e) => setDraft({ ...draft, founding: e.target.checked })}
                      />
                      Founding Creator — {foundingCount} of {FOUNDING_LIMIT} taken
                      {foundingCapReached && !draft.founding && ' (full)'}
                    </label>
                    {draft.founding && selected.foundingSince && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        Founding since {new Date(selected.foundingSince).toLocaleDateString()} — granting again
                        does not restart the fee-free window.
                      </p>
                    )}
                    {!draft.founding && isFoundingCreator(selected) && (
                      <p className="basis-full text-xs text-yellow-400/90 -mt-3">
                        Saving with this unticked REVOKES their Founding badge and ends their fee waiver. It is recorded as a
                        revocation, so approval will never auto-grant it back -- only ticking it again by hand re-grants it
                        (with a fresh fee window).
                      </p>
                    )}
                    {!draft.founding && !isFoundingCreator(selected) && selected.foundingRevokedAt && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        Founding was revoked on {new Date(selected.foundingRevokedAt).toLocaleDateString()}; it won't be
                        auto-granted again. Tick it to re-grant by hand.
                      </p>
                    )}
                    {draft.founding && !selected.foundingSince && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        {selectedStatus === 'active'
                          ? 'Slot held, but the fee-free window has not started yet -- it starts the next time they are approved or reinstated to Active.'
                          : 'Slot reserved; the 30-day fee-free window starts the day they are approved (set to Active).'}
                      </p>
                    )}
                    {selectedIsPending && !draft.founding && !selected.foundingRevokedAt && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        Approving (Pending → Active) grants Founding automatically if their profile is finished and a slot
                        is free. To approve without it, untick it on a second save afterwards.
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
                        {/* A suspension lifts itself into 'active' after 30
                            days, so for an applicant who was never approved it
                            would mean "publish in a month". The server refuses
                            it; the option isn't offered. */}
                        {!selectedIsPending && <option value="suspended">Suspended (hidden, 30 days)</option>}
                        <option value="banned">Banned (hidden, permanent)</option>
                      </select>
                    </label>
                  </div>

                  {draft.status === 'banned' && selectedStatus !== 'banned' && (
                    <p className="text-xs text-red-400">
                      Banning takes down every unsold listing, deletes its media and freezes their credit balance and any
                      pending payouts.
                    </p>
                  )}
                  {draft.status === 'active' && selectedStatus && selectedStatus !== 'active' && (
                    <p className="text-xs text-gray-400">
                      Making this creator live needs a handle and a non-archived §2257 record linked to them with the ID
                      attached or marked held offline, and re-screens
                      every public field. If any check fails nothing is saved and the reason is shown above.
                    </p>
                  )}

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
                        Gallery ({selected.gallery?.length || 0}/200)
                      </h3>
                      <label
                        className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy || othersAppear === null || (othersAppear && !coPerformerIds.length) ? 'opacity-50 pointer-events-none' : ''}`}
                        title={othersAppear === null ? 'Answer the question below first' : undefined}
                      >
                        {busy ? 'Working...' : 'Upload Content'}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif,image/avif,video/mp4,video/quicktime,video/webm"
                          className="hidden"
                          disabled={busy || othersAppear === null || (othersAppear && !coPerformerIds.length)}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (!file) return;
                            uploadGalleryItem(file, nextUploadIsAi);
                            setNextUploadIsAi(false);
                          }}
                        />
                      </label>
                    </div>
                    <p className="text-[10px] text-gray-500 mb-2">
                      Images (JPEG, PNG, WebP, GIF, AVIF -- not HEIC) up to 25MB, videos (MP4, MOV, WebM) up to 50MB. Admin uploads may use up to 200 slots; the
                      creator's own limit is {selected.premium ? 200 : 50}. Removing an item also deletes the file.
                    </p>
                    {/* Same self-reported AI label creators get on their own uploads
                        (pages/dashboard.js) -- content uploaded on a creator's behalf
                        has to be able to carry it too, since the labeling requirement
                        is about what's published, not who pressed upload. */}
                    <label className="flex items-center gap-2 text-xs text-gray-400 mb-3 cursor-pointer">
                      <input type="checkbox" checked={nextUploadIsAi} onChange={(e) => setNextUploadIsAi(e.target.checked)} />
                      This upload is AI-generated or synthetic content (will be labeled "AI" on the profile)
                    </label>
                    {/* §2257 attestation, required on every finalize
                        (lib/performer-attestation.js). Asked per upload and
                        reset after each one, never remembered. */}
                    <div className="mb-3 text-xs text-gray-300">
                      <p className="mb-1">Does anyone besides this creator appear in the next upload?</p>
                      <div className="flex gap-4">
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input type="radio" name="othersAppear" checked={othersAppear === false} onChange={() => { setOthersAppear(false); setCoPerformerIds([]); }} />
                          No, only them
                        </label>
                        <label className="flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            name="othersAppear"
                            checked={othersAppear === true}
                            onChange={() => { setOthersAppear(true); if (recordOptions === null) loadRecordOptions(); }}
                          />
                          Yes, someone else too
                        </label>
                      </div>
                      {othersAppear === true && (
                        <div className="mt-2">
                          <p className="text-[11px] text-gray-500 mb-1">
                            Tick the §2257 record of EVERY other person in the file. Only records with an ID attached or
                            held offline are listed; add a missing one in the Records tab first.
                          </p>
                          {recordOptions === null ? (
                            <p className="text-[11px] text-gray-500">Loading records…</p>
                          ) : recordOptions.length === 0 ? (
                            <p className="text-[11px] text-yellow-400/90">No usable §2257 records yet.</p>
                          ) : (
                            <div className="max-h-40 overflow-y-auto space-y-1">
                              {recordOptions.map((r) => (
                                <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={coPerformerIds.includes(String(r.id))}
                                    onChange={(e) => setCoPerformerIds((prev) => (e.target.checked
                                      ? [...new Set([...prev, String(r.id)])]
                                      : prev.filter((x) => x !== String(r.id))))}
                                  />
                                  #{String(r.id)} {r.unreadable ? '(unreadable record)' : String(r.legalName || '')}
                                  {Array.isArray(r.aliases) && r.aliases.length > 0 && <span className="text-gray-500">— {r.aliases.join(', ')}</span>}
                                </label>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
                      {(selected.gallery || []).map((item, i) => (
                        <div key={`${item.src}-${i}`} className="relative aspect-square rounded-md overflow-hidden border border-brand-purple/20 group">
                          {item.type === 'video' ? (
                            <video src={item.src} className="w-full h-full object-cover" muted preload="metadata" />
                          ) : (
                            <img src={item.src} alt="" className="w-full h-full object-cover" />
                          )}
                          {item.aiGenerated && (
                            <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                          )}
                          <button
                            onClick={() => deleteGalleryItem(item, i)}
                            disabled={busy}
                            title="Remove (also deletes the file)"
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs opacity-0 group-hover:opacity-100 focus:opacity-100 transition disabled:opacity-30"
                          >
                            <Icons.close className="h-3.5 w-3.5 mx-auto" />
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
      const { res, data } = await adminGet(adminKey, `/api/admin/reports?status=${encodeURIComponent(status)}`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load reports'));
      setReports(Array.isArray(data.reports) ? data.reports : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (r, action) => {
    if (action === 'remove_content') {
      const what = r.targetType === 'listing' ? 'take this listing down (and delete its media)' : 'delete this comment';
      if (!confirm(`Remove the reported content? This will ${what}.`)) return;
    }
    setBusyId(r.id);
    setError('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/reports-resolve', { id: r.id, action });
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to resolve report'));
      setReports((prev) => prev.filter((x) => String(x.id) !== String(r.id)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const targetLabel = (r) => (r.targetType === 'wall_post' ? 'Wall comment' : r.targetType === 'listing' ? 'Marketplace listing' : String(r.targetType ?? 'Unknown'));

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
                {/* String(): a stored targetId that isn't a plain value used to
                    crash the whole tab ("Objects are not valid as a React child"). */}
                <p className="text-xs font-bold text-brand-gold">{targetLabel(r)} #{String(r.targetId ?? '')}</p>
                <p className="text-[10px] text-gray-600">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</p>
              </div>
              <p className="text-sm text-gray-300 mb-3"><span className="text-gray-500">Reason:</span> {String(r.reason ?? '')}</p>
              <ReportTarget report={r} />
              {r.status === 'open' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve(r, 'dismiss')}
                    disabled={busyId === r.id}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                  <button
                    onClick={() => resolve(r, 'remove_content')}
                    disabled={busyId === r.id || r.target?.exists === false}
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

/**
 * What a report is actually about -- the comment text and whose wall, or the
 * listing's title, status and seller -- from the `target` the reports API
 * attaches (lib/reports-store.js attachReportTargets). Without it a moderator
 * pressed "Remove Content" on a bare "#123".
 */
function ReportTarget({ report }) {
  const t = report?.target;
  if (!t || t.exists === false) {
    return <p className="text-xs text-gray-500 mb-3">The reported item no longer exists (already deleted).</p>;
  }
  const seller = t.creatorName ? `${t.creatorName}${t.creatorHandle ? ` (${t.creatorHandle})` : ''}` : t.creatorId ? `creator #${t.creatorId}` : 'unknown creator';
  if (report.targetType === 'wall_post') {
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        <p className="text-gray-500 mb-1">
          Comment by {String(t.authorName ?? 'someone')}{t.authorId ? ` (user #${t.authorId})` : ''} on {seller}'s wall
          {t.createdAt ? `, ${new Date(t.createdAt).toLocaleString()}` : ''}:
        </p>
        <p className="whitespace-pre-wrap break-words">"{String(t.text ?? '')}"</p>
      </div>
    );
  }
  if (report.targetType === 'listing') {
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        <p className="font-bold text-white">{String(t.title ?? '(untitled)')}</p>
        <p className="text-gray-500 mb-1">
          by {seller} · {String(t.status ?? '')} · {String(t.kind ?? '')}
          {Number.isFinite(Number(t.priceCents)) ? ` · ${dollars(t.priceCents)}` : ''} · {Number(t.mediaCount) || 0} media item(s)
        </p>
        {t.description && <p className="whitespace-pre-wrap break-words">{String(t.description)}</p>}
        {/* The reported files themselves, so "Remove Content" is decided on
            what was actually uploaded, not the title. Private /api/media
            srcs load through the oa_admin_media cookie. Retained items are
            off the listing but still delivered to earlier buyers. */}
        {t.filesDeleted ? (
          <p className="mt-2 text-red-400">Files deleted (taken down).</p>
        ) : Array.isArray(t.media) && t.media.length > 0 ? (
          <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2">
            {t.media.map((m, i) => (
              <div key={`${String(m?.src)}-${i}`} className="relative aspect-square rounded overflow-hidden border border-white/10 bg-black/40">
                {m?.type === 'video' ? (
                  <video src={String(m.src)} className="w-full h-full object-cover" controls preload="metadata" />
                ) : (
                  <img src={String(m?.src || '')} alt="" className="w-full h-full object-cover" />
                )}
                {m?.retained && (
                  <span className="absolute top-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-yellow-300 font-bold">kept for buyers</span>
                )}
                {m?.aiGenerated && (
                  <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return null;
}

const CONTEXT_LABELS = {
  message: 'Direct message',
  wall_post: 'Wall comment',
  bio: 'Profile bio',
  name: 'Profile display name',
  handle: 'Profile handle',
  location: 'Profile location',
  price: 'Profile price',
  tag: 'Profile tag',
  tags: 'Profile tags',
  username: 'Fan username',
  listing_title: 'Listing title',
  listing_description: 'Listing description',
  listing_tags: 'Listing tags',
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
      const { res, data } = await adminGet(adminKey, `/api/admin/violations?status=${encodeURIComponent(status)}`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load violations'));
      setViolations(Array.isArray(data.violations) ? data.violations : []);
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
      const { res, data } = await adminPost(adminKey, '/api/admin/violations-resolve', { id, action });
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to resolve violation'));
      setViolations((prev) => prev.filter((v) => String(v.id) !== String(id)));
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
  const contextLabel = (v) => {
    const ctx = String(v.context ?? '');
    if (CONTEXT_LABELS[ctx]) return CONTEXT_LABELS[ctx];
    if (ctx.startsWith('social_')) return `Profile ${ctx.slice(7)} link`;
    return ctx || 'Unknown';
  };

  // Admin-path flags have no logged-in user behind them -- pages/api/admin/profile.js
  // records which creator record the text was headed for instead; a refused
  // signup has no account yet, only the IP it came from.
  const actorLabel = (v) => {
    const id = String(v.userId ?? '');
    const adminEdit = id.match(/^admin-edit:creator:(.+)$/);
    if (adminEdit) return `creator #${adminEdit[1]} (admin edit)`;
    const signup = id.match(/^signup:ip:(.+)$/);
    if (signup) return `signup attempt from ${signup[1]}`;
    return `user #${id}`;
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
              <p className="text-xs text-gray-500 mb-1">Flagged: {Array.isArray(v.reasons) ? v.reasons.join(', ') : String(v.reasons ?? '')}</p>
              <p className="text-sm text-gray-300 mb-3 font-mono break-all">"{String(v.snippet ?? '')}"</p>
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
function NciiReportsPanel({ adminKey, creators, onSummary, onCreatorChanged }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [reports, setReports] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attributed, setAttributed] = useState({});

  const load = async (status) => {
    setLoading(true);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/ncii-reports?status=${encodeURIComponent(status)}`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load takedown requests'));
      setReports(Array.isArray(data.reports) ? data.reports : []);
      if (data.summary) {
        setSummary(data.summary);
        if (onSummary) onSummary(data.summary);
      }
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
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/ncii-reports-resolve', { id, action, creatorId });
      if (res.status === 409) {
        // Someone else resolved it first -- re-read rather than keep a stale row.
        setNotice(errorFrom(res, data, 'That report was already resolved.'));
        await load(statusFilter);
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to resolve report'));
      const messages = [`Report #${id} resolved.`];
      if (data.creator) {
        if (onCreatorChanged) onCreatorChanged(data.creator);
        messages.push(
          data.creator.status === 'banned'
            ? `${data.creator.name} has been permanently banned (2nd confirmed violation).`
            : `${data.creator.name} suspended until ${data.creator.suspendedUntil ? new Date(data.creator.suspendedUntil).toLocaleDateString() : 'further notice'} (1st confirmed violation).`,
        );
      }
      setNotice(messages.join(' '));
      // The ban itself stands even when this is present; the takedown of the
      // creator's listings needs a retry (re-save the ban from their record).
      if (data.warning) setError(String(data.warning));
      await load(statusFilter);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const hoursOpen = (r) => Math.floor((Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60));
  const openCount = Number(summary?.open) || 0;
  const oldestHours = summary?.oldestOpenCreatedAt
    ? Math.floor((Date.now() - new Date(summary.oldestOpenCreatedAt).getTime()) / (1000 * 60 * 60))
    : null;

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Filed via /report-content, no login required. Legally required to be reviewed and, if valid, the content
        removed within 48 hours of submission.
      </p>
      {summary && (
        <p className={`text-sm font-bold mb-4 ${openCount === 0 ? 'text-gray-500' : oldestHours !== null && oldestHours >= 36 ? 'text-red-400' : 'text-yellow-400'}`}>
          {openCount === 0
            ? 'No open takedown requests.'
            : `${openCount} open${oldestHours !== null ? ` -- oldest filed ${oldestHours}h ago${oldestHours >= 48 ? ' (OVERDUE)' : ''}` : ''}.`}
        </p>
      )}
      {notice && <p className="text-sm text-green-400 mb-4">{notice}</p>}
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
                            {c.name} ({c.handle || `#${c.id}`}){c.contentViolationCount ? ` — ${c.contentViolationCount} prior violation(s)` : ''}
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

const BLANK_RECORD = {
  legalName: '', dateOfBirth: '', aliases: '', idType: 'Driver’s licence',
  idIssuer: '', idNumber: '', idExpiry: '', creatorId: '', producedAt: '',
  contentUrls: '', notes: '', documentLocation: '',
};

/**
 * 18 U.S.C. §2257 performer records.
 *
 * Everything shown here is legally sensitive and none of it exists anywhere
 * else in the product -- no public page, no creator dashboard, no API
 * outside the two admin-key routes behind this panel. The ID document is
 * never rendered inline from a URL anyone could share; opening one is an
 * authenticated fetch that becomes a blob URL in this tab and is revoked
 * when it closes.
 */
/**
 * Pre-launch notify-me list. Read-only apart from removing someone, which
 * is the point -- this is a marketing list of people who have no account
 * here, and "take me off it" has to be something a person can actually do.
 *
 * The export is the working tool: nothing on this stack sends email, so the
 * real workflow is exporting the CSV into whatever mail tool is used to
 * announce the launch.
 */
function WaitlistPanel({ adminKey }) {
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({ total: 0, fans: 0, creators: 0 });
  const [roleFilter, setRoleFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/waitlist');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load the waitlist'));
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setCounts(data.counts || { total: 0, fans: 0, creators: 0 });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Fetched rather than linked, so the admin key travels in a header
  // instead of a URL that lands in browser history and any proxy log
  // between here and Vercel.
  const exportCsv = async () => {
    setError('');
    try {
      const res = await fetch('/api/admin/waitlist?format=csv', { headers: { 'x-admin-key': adminKey } });
      if (!res.ok) throw new Error(errorFrom(res, await readJson(res), 'Export failed'));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `onlyone-waitlist-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id, email) => {
    if (!confirm(`Remove ${email} from the waitlist? They will not be notified at launch.`)) return;
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`/api/admin/waitlist?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-key': adminKey },
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to remove'));
      setEntries((prev) => prev.filter((e) => String(e.id) !== String(id)));
      setCounts((prev) => ({
        total: Math.max(0, prev.total - 1),
        fans: Math.max(0, prev.fans - 1),
        creators: Math.max(0, prev.creators - 1),
      }));
      // The optimistic count above cannot know which roles that row held,
      // so re-read the real figures rather than leave them wrong.
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const shown = roleFilter === 'all' ? entries : entries.filter((e) => (e.roles || []).includes(roleFilter));

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-6">
        {[
          { key: 'all', label: `ALL (${counts.total})` },
          { key: 'fan', label: `FANS (${counts.fans})` },
          { key: 'creator', label: `CREATORS (${counts.creators})` },
        ].map((f) => (
          <button
            key={f.key}
            onClick={() => setRoleFilter(f.key)}
            className={`px-4 py-2 rounded-md text-xs font-bold ${
              roleFilter === f.key ? 'bg-brand-gold text-black' : 'bg-black/40 text-gray-400 border border-brand-purple/30'
            }`}
          >
            {f.label}
          </button>
        ))}
        <div className="flex-1" />
        <button onClick={exportCsv} disabled={!entries.length} className="premium-button disabled:opacity-50">
          Export CSV
        </button>
      </div>

      <p className="text-[11px] text-gray-500 mb-4">
        The export is a list of people who signed up for an adult platform -- keep it off shared drives. Any cell that
        would start a spreadsheet formula (= + - @) is prefixed with an apostrophe so it opens as plain text.
      </p>

      {error && <div className="mb-4 px-4 py-3 rounded-md bg-red-900/30 border border-red-500/40 text-red-300 text-sm">{error}</div>}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : !shown.length ? (
        <p className="text-gray-500 text-sm">Nobody on the list yet.</p>
      ) : (
        <div className="space-y-2">
          {shown.map((e) => (
            <div key={e.id} className="premium-card p-4 flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-white break-all">{e.email}</span>
              <span className="flex gap-1">
                {(e.roles || []).map((r) => (
                  <span key={r} className="px-2 py-0.5 rounded-full bg-brand-gold/20 text-brand-gold text-[10px] font-bold uppercase">
                    {r}
                  </span>
                ))}
              </span>
              {e.state && <span className="text-[11px] text-gray-500">{e.state}{e.country ? `, ${e.country}` : ''}</span>}
              <span className="text-[11px] text-gray-600">via {e.source}</span>
              <div className="flex-1" />
              <span className="text-[11px] text-gray-600">
                {e.createdAt ? new Date(e.createdAt).toLocaleDateString() : ''}
              </span>
              <button
                onClick={() => remove(e.id, e.email)}
                disabled={busyId === e.id}
                className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50"
              >
                {busyId === e.id ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The credits were already reserved (taken off the creator's withdrawable
// balance) the moment the creator requested this -- see lib/credits-store.js
// requestPayout. Marking one "paid" here only RECORDS a payment: the admin
// sends the real USDG by hand FIRST, then enters the transaction hash, which
// the server checks on-chain before recording. Rejecting one returns the
// reserved credits to the creator's balance. There is no button anywhere that
// moves real money -- that's the point.
function PayoutAccount({ r }) {
  const a = r.account || {};
  const who = a.creatorName
    ? `${a.creatorName}${a.creatorHandle ? ` (${a.creatorHandle})` : ''}`
    : a.email || `user ${r.user_id}`;
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-white">{who}</span>
      <span className="text-[11px] text-gray-500">user {String(r.user_id)}</span>
      {a.status && (
        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${a.status === 'active' ? 'bg-green-500/15 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {a.status}
        </span>
      )}
      {!a.creatorId && <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400 font-bold">NO CREATOR PROFILE</span>}
      {a.seed && <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-500/30 text-gray-300 font-bold">DEMO</span>}
      {r.frozen && r.status === 'pending' && (
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-600 text-white font-bold" title="The account is no longer an active creator. Reject it (credits go back, still frozen) rather than pay it.">
          FROZEN
        </span>
      )}
    </span>
  );
}

function PayoutsPanel({ adminKey }) {
  const [requests, setRequests] = useState([]);
  const [paid, setPaid] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [txInputs, setTxInputs] = useState({});
  const [manual, setManual] = useState({ userId: '', txHash: '', fromAddress: '' });
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMsg, setManualMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/payouts');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load payout requests'));
      setRequests(Array.isArray(data.requests) ? data.requests : []);
      setPaid(Array.isArray(data.paid) ? data.paid : []);
      setRejected(Array.isArray(data.rejected) ? data.rejected : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Each escape hatch the server offers is its own explicit confirmation,
  // never a default:
  //  - 409 payout_frozen: the account is banned/suspended/no longer an active
  //    creator. Normal action is Reject; "pay anyway" re-posts override:true.
  //  - 501/502: the on-chain check couldn't run. "Record without checking"
  //    re-posts skipChainCheck:true.
  //  - 400 on-chain mismatch and 409 tx_hash_reused are shown as they are:
  //    the hash is wrong or already closes another request.
  const markPaid = async (r) => {
    const id = r.id;
    const txHash = (txInputs[id] || '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      setError('Enter the real transaction hash (0x + 64 hex characters) once the USDG has actually been sent.');
      return;
    }
    if (r.frozen && !confirm(
      'This account is FROZEN (no longer an active creator). Its payout normally gets Rejected, not paid. '
      + 'Continue to record it as paid anyway?',
    )) return;
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      const opts = { override: r.frozen === true, skipChainCheck: false };
      for (;;) {
        const { res, data } = await adminPost(adminKey, '/api/admin/payouts-mark-paid', { id, txHash, ...opts });
        if (res.ok) break;
        if (res.status === 409 && data.code === 'payout_frozen' && !opts.override) {
          if (!confirm(`${data.error || 'This payout is frozen.'}\n\nThe account is not an active creator in good standing. Pay anyway (override)?`)) {
            setNotice('Not recorded. Use Reject to return the credits instead.');
            return;
          }
          opts.override = true;
          continue;
        }
        if ((res.status === 502 || res.status === 501) && !opts.skipChainCheck) {
          if (!confirm(
            `${data.error || 'The transaction could not be checked on-chain.'}\n\n`
            + 'Record it as paid WITHOUT the on-chain check? Only do this if you have confirmed the transfer on a block explorer yourself.',
          )) {
            setNotice('Not recorded. Try again when the on-chain check is available.');
            return;
          }
          opts.skipChainCheck = true;
          continue;
        }
        if (res.status === 409 && data.code === 'tx_hash_reused') {
          throw new Error(`${data.error || 'That transaction hash already closes another payout.'} Each payout needs its own transaction.`);
        }
        throw new Error(errorFrom(res, data, 'Failed to mark paid'));
      }
      setTxInputs((prev) => ({ ...prev, [id]: '' }));
      setNotice(`Payout #${id} recorded as paid${opts.skipChainCheck ? ' (without the on-chain check)' : ' -- transfer verified on-chain'}.`);
      await load(); // re-fetch rather than splice locally -- the row now belongs in "paid"
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (r) => {
    const reason = window.prompt(
      `Reject payout #${r.id} of ${formatCredits(r.amount_cents)}? The credits go back to the creator's balance`
      + `${r.frozen ? ' (and stay frozen while the account is suspended or banned)' : ''}. `
      + 'The reason is shown to the creator:',
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('A reason is required to reject a payout.');
      return;
    }
    setBusyId(r.id);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/payouts-reject', { id: r.id, reason: reason.trim() });
      if (res.status === 409) {
        // Already paid or rejected elsewhere -- show where it went.
        setError(errorFrom(res, data, 'That payout is no longer pending.'));
        await load();
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to reject'));
      setNotice(`Payout #${r.id} rejected; ${formatCredits(r.amount_cents)} returned to the creator's balance.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Support fallback for a fan whose payment landed on-chain but the credit
  // call never ran (see pages/api/admin/manual-credit.js) -- fromAddress is
  // confirmed by the admin some other way (support conversation, screenshot);
  // the on-chain check still refuses unless a real matching transfer from
  // that exact address exists.
  const manualCredit = async () => {
    setManualMsg('');
    setManualBusy(true);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/manual-credit', manual);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not credit that payment'));
      setManualMsg(`Credited ${formatCredits(data.creditedCents)} to ${data.creditedUserEmail || `user ${manual.userId}`}.`);
      setManual({ userId: '', txHash: '', fromAddress: '' });
    } catch (err) {
      setManualMsg(err.message);
    } finally {
      setManualBusy(false);
    }
  };

  return (
    <div>
      <p className="text-sm text-gray-400 mb-2">
        Only credits a creator EARNED can be requested, and the amount is reserved from their balance the moment they
        ask. Send the real USDG to the wallet shown -- one transaction per request, since one hash can only close one
        payout -- THEN paste the transaction hash here. It is checked on-chain before it is recorded: the EXACT
        requested amount, to that wallet, sent after the request was made (an older transaction is refused).
      </p>
      <p className="text-xs text-gray-500 mb-4">
        FROZEN means the account is no longer an active creator (suspended, banned, pending or deleted). Don't pay those:
        Reject returns the credits to their balance, which stays frozen until they're reinstated.
      </p>

      {error && <div className="mb-4 px-4 py-3 rounded-md bg-red-900/30 border border-red-500/40 text-red-300 text-sm whitespace-pre-line">{error}</div>}
      {notice && <div className="mb-4 px-4 py-3 rounded-md bg-green-900/20 border border-green-500/30 text-green-300 text-sm">{notice}</div>}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : !requests.length ? (
        <p className="text-gray-500 text-sm mb-6">No pending payout requests.</p>
      ) : (
        <div className="space-y-2 mb-6">
          {requests.map((r) => (
            <div key={r.id} className={`premium-card p-4 space-y-2 ${r.frozen ? 'border border-red-500/60' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-bold text-white">{formatCredits(r.amount_cents)}</span>
                <PayoutAccount r={r} />
                <div className="flex-1" />
                <span className="text-[11px] text-gray-600">#{String(r.id)} · {r.created_at ? new Date(r.created_at).toLocaleString() : ''}</span>
              </div>
              <p className="font-mono text-[11px] text-gray-400 break-all">Send USDG to: {String(r.payout_wallet || '(no wallet)')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={txInputs[r.id] || ''}
                  onChange={(e) => setTxInputs((prev) => ({ ...prev, [r.id]: e.target.value }))}
                  placeholder="0x… tx hash"
                  className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white font-mono w-72 max-w-full"
                />
                <button
                  onClick={() => markPaid(r)}
                  disabled={busyId === r.id}
                  className="premium-button text-xs px-4 py-1.5 disabled:opacity-50"
                >
                  {busyId === r.id ? 'Working…' : 'Mark Paid'}
                </button>
                <button
                  onClick={() => reject(r)}
                  disabled={busyId === r.id}
                  className="text-xs px-4 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                >
                  Reject &amp; refund
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-4 mb-3">
        <button onClick={() => setShowHistory((v) => !v)} className="text-xs text-gray-400 hover:text-white transition">
          {showHistory ? 'Hide' : 'Show'} recently paid ({paid.length})
        </button>
        <button onClick={() => setShowRejected((v) => !v)} className="text-xs text-gray-400 hover:text-white transition">
          {showRejected ? 'Hide' : 'Show'} recently rejected ({rejected.length})
        </button>
      </div>
      {showHistory && (
        <div className="space-y-2 mb-6">
          {!paid.length ? (
            <p className="text-gray-500 text-sm">Nothing paid yet.</p>
          ) : (
            paid.map((r) => (
              <div key={r.id} className="premium-card p-4 flex flex-wrap items-center gap-3 opacity-75">
                <span className="font-bold text-white">{formatCredits(r.amount_cents)}</span>
                <PayoutAccount r={r} />
                <span className="font-mono text-[11px] text-gray-400 break-all">{String(r.tx_hash || '')}</span>
                <span className="text-[11px] text-gray-600">{r.paid_at ? new Date(r.paid_at).toLocaleString() : ''}</span>
              </div>
            ))
          )}
        </div>
      )}
      {showRejected && (
        <div className="space-y-2 mb-6">
          {!rejected.length ? (
            <p className="text-gray-500 text-sm">Nothing rejected.</p>
          ) : (
            rejected.map((r) => (
              <div key={r.id} className="premium-card p-4 flex flex-wrap items-center gap-3 opacity-75">
                <span className="font-bold text-white">{formatCredits(r.amount_cents)}</span>
                <PayoutAccount r={r} />
                <span className="text-[11px] text-gray-400">Reason: {String(r.reject_reason || '')}</span>
                <span className="text-[11px] text-gray-600">{r.rejected_at ? new Date(r.rejected_at).toLocaleString() : ''}</span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="premium-card p-4">
        <p className="text-xs font-bold tracking-widest text-gray-400 mb-2">MANUALLY CREDIT A STUCK DEPOSIT</p>
        <p className="text-xs text-gray-500 mb-3">
          For a fan whose payment confirmed on-chain but whose browser died before the credit call ran, and who couldn't
          self-recover it from the Credits page. Verifies the exact transaction really came from the address given
          before crediting anything. Deposited credits are spend-only -- they can never be cashed out.
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            value={manual.userId}
            onChange={(e) => setManual((m) => ({ ...m, userId: e.target.value }))}
            placeholder="User id"
            className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white w-32"
          />
          <input
            value={manual.txHash}
            onChange={(e) => setManual((m) => ({ ...m, txHash: e.target.value }))}
            placeholder="0x… tx hash"
            className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white font-mono w-64"
          />
          <input
            value={manual.fromAddress}
            onChange={(e) => setManual((m) => ({ ...m, fromAddress: e.target.value }))}
            placeholder="0x… sender wallet"
            className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white font-mono w-64"
          />
          <button
            onClick={manualCredit}
            disabled={manualBusy || !manual.userId || !manual.txHash || !manual.fromAddress}
            className="premium-button text-xs px-4 py-1.5 disabled:opacity-50"
          >
            {manualBusy ? 'Checking…' : 'Verify & Credit'}
          </button>
        </div>
        {manualMsg && <p className="text-xs text-gray-400">{manualMsg}</p>}
      </div>
    </div>
  );
}

function PerformerRecordsPanel({ adminKey, creators }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [form, setForm] = useState(BLANK_RECORD);
  const [file, setFile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // Per-record edit: { id, creatorId, aliases, contentUrls, notes } while open.
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/performer-records');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load records'));
      setRecords(Array.isArray(data.records) ? data.records : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // The raw ID file is the request body; its name travels URL-encoded in the
  // query string. Putting file.name in a header (as this used to) makes fetch
  // throw before sending on any name outside Latin-1 -- every macOS
  // screenshot -- which left a freshly created record with no ID attached.
  // `replace` keeps the previous document in the record's history.
  const uploadDocument = async (recordId, docFile, { replace = false } = {}) => {
    const params = new URLSearchParams({ id: String(recordId), fileName: docFile.name || 'id-document' });
    if (replace) params.set('replace', '1');
    const res = await fetch(`/api/admin/performer-record-document?${params.toString()}`, {
      method: 'POST',
      headers: { 'x-admin-key': adminKey, 'Content-Type': docFile.type || 'application/octet-stream' },
      body: docFile,
    });
    return { res, data: await readJson(res) };
  };

  // Attach an ID to an existing record, or replace the one on file. A 409 means
  // one is already there: replacing is its own explicit confirmation.
  const attachDocument = async (record, docFile) => {
    if (!docFile) return;
    const hasOne = !!record.document;
    if (hasOne && !confirm('Replace the ID document on file? The current one is kept in this record\'s history, not destroyed.')) return;
    setBusyId(record.id);
    setError('');
    setNotice('');
    try {
      let { res, data } = await uploadDocument(record.id, docFile, { replace: hasOne });
      if (res.status === 409 && !hasOne) {
        if (!confirm(`${data.error || 'A document is already on file.'}\n\nReplace it? The current one is kept in history.`)) return;
        ({ res, data } = await uploadDocument(record.id, docFile, { replace: true }));
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not attach that document'));
      setNotice(`ID document ${hasOne ? 'replaced' : 'attached'} on record #${record.id}.`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const update = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const startEdit = (r) => {
    setError('');
    setNotice('');
    setEditing({
      id: r.id,
      creatorId: r.creatorId ? String(r.creatorId) : '',
      aliases: (r.aliases || []).join(', '),
      contentUrls: (r.contentUrls || []).join('\n'),
      notes: r.notes || '',
    });
  };

  // POST { action:'update', id, fields } -- the only fields the API edits are
  // the link to a creator, aliases, content URLs, notes and documentLocation.
  // Identity (legal name, DOB, ID number) is never editable: a wrong one is
  // archived with a reason and re-entered, so the history shows it.
  const updateRecord = async (id, fields, doneMessage) => {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/performer-records', { action: 'update', id, fields });
      if (!res.ok || !data.record) throw new Error(errorFrom(res, data, 'Could not update that record'));
      setNotice(doneMessage);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const saveEdit = () => {
    if (!editing) return;
    updateRecord(editing.id, {
      creatorId: editing.creatorId || null,
      aliases: editing.aliases,
      contentUrls: editing.contentUrls,
      notes: editing.notes,
    }, `Record #${editing.id} updated.`);
  };

  // The go-live gate accepts a record whose ID copy is kept outside this app,
  // but only when that is recorded explicitly -- a blank "no document" does
  // not count (lib/performer-records-store.js performerRecordStatusForCreator).
  const markHeldOffline = (r) => {
    if (!confirm(
      `Record that the photo ID for record #${r.id} is kept OFFLINE (a physical or scanned copy stored outside this app)?\n\n`
      + 'Only do this if you actually hold that copy and can produce it for an inspection. This lets the linked creator go live.',
    )) return;
    updateRecord(r.id, { documentLocation: 'offline' }, `Record #${r.id} marked as ID held offline.`);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!form.legalName.trim()) { setError('A legal name is required.'); return; }
    if (!form.dateOfBirth) { setError('A date of birth is required.'); return; }
    setSaving(true);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/performer-records', form);
      if (!res.ok || !data.record) throw new Error(errorFrom(res, data, 'Could not save that record'));

      // The document is a second call on purpose: the record must exist
      // before an ID scan is attached to it, so a failed upload leaves a
      // record with no document rather than an orphaned document -- and the
      // form is cleared either way, because the record IS saved; the ID can
      // be attached to it from the list below.
      const savedName = (Array.isArray(data.record.aliases) && data.record.aliases[0]) || form.legalName;
      setForm(BLANK_RECORD);
      const docFile = file;
      setFile(null);
      if (docFile) {
        const up = await uploadDocument(data.record.id, docFile);
        if (!up.res.ok) {
          throw new Error(`Record #${data.record.id} saved, but the ID document did not attach: ${errorFrom(up.res, up.data, 'upload failed')}. Use "Attach ID" on the record below to try again.`);
        }
      }

      setNotice(`Record saved for ${savedName}.`);
      await load();
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const openDocument = async (id) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`/api/admin/performer-record-document?id=${encodeURIComponent(id)}`, { headers: { 'x-admin-key': adminKey } });
      if (!res.ok) {
        throw new Error(errorFrom(res, await readJson(res), 'Could not open that document'));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      // Revoked after the new tab has had a moment to read it, so the
      // object URL doesn't linger in this page for the rest of the session.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (id) => {
    const reason = window.prompt('Why is this record being archived? (kept on the record)');
    if (reason === null) return;
    setBusyId(id);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/performer-records', { action: 'archive', id, reason });
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not archive that record'));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const q = search.trim().toLowerCase();
  const visible = records
    .filter((r) => (showArchived ? r.status === 'archived' : r.status !== 'archived'))
    .filter((r) => !q
      || (r.aliases || []).some((a) => a.includes(q))
      || (r.contentUrls || []).some((u) => u.toLowerCase().includes(q))
      || String(r.legalName || '').toLowerCase().includes(q));

  return (
    <div className="space-y-8">
      <div className="premium-card p-5 text-sm text-gray-400 leading-relaxed">
        <p className="text-white font-bold mb-2">18 U.S.C. §2257 performer records</p>
        <p className="mb-2">
          One record per performer who appears in sexually explicit content on the platform: legal
          name, date of birth, every name they have worked under, a copy of their photo ID, when the
          content was produced and where it appears. Records are kept for seven years.
        </p>
        <p className="mb-2">
          Legal name, date of birth, ID number and the document itself are encrypted at rest with a
          key that is not the one used anywhere else on this site. Stage names and URLs are stored
          in the clear because they are already public and they are what the index has to be
          searchable by.
        </p>
        <p className="text-gray-500">
          Record-keeping, not legal advice. Have an attorney who works in this industry confirm your
          process before you rely on it.
        </p>
      </div>

      <form onSubmit={submit} className="premium-card p-6 space-y-4">
        <p className="font-bold text-white">Add a record</p>

        <div className="grid md:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Legal name *</span>
            <input value={form.legalName} onChange={update('legalName')} required
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Date of birth *</span>
            <input type="date" value={form.dateOfBirth} onChange={update('dateOfBirth')} required
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
        </div>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">
            Every name they work under, comma separated — stage names, handles, past names
          </span>
          <input value={form.aliases} onChange={update('aliases')} placeholder="luna, lunax, luna rae"
            className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
        </label>

        <div className="grid md:grid-cols-4 gap-4">
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">ID type</span>
            <input value={form.idType} onChange={update('idType')}
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Issued by</span>
            <input value={form.idIssuer} onChange={update('idIssuer')} placeholder="State of Indiana"
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">ID number</span>
            <input value={form.idNumber} onChange={update('idNumber')}
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">ID expires</span>
            <input type="date" value={form.idExpiry} onChange={update('idExpiry')}
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">
              Creator account -- a creator can't be made live without a record linked here
            </span>
            <select value={form.creatorId} onChange={update('creatorId')}
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm">
              <option value="">— not linked —</option>
              {creators.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.handle || `#${c.id}`})</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs text-gray-400 mb-1">Date the content was produced</span>
            <input type="date" value={form.producedAt} onChange={update('producedAt')}
              className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
          </label>
        </div>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">
            Where the content appears — URLs, one per line or comma separated
          </span>
          <textarea value={form.contentUrls} onChange={update('contentUrls')} rows={2}
            className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
        </label>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">
            Photo ID — JPEG, PNG, WebP, HEIC or PDF, under 4MB. Encrypted; never served publicly.
          </span>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="w-full text-sm text-gray-300 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border-0 file:bg-brand-pink file:text-white file:text-sm file:font-semibold" />
        </label>

        <label className="flex items-start gap-2 text-xs text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.documentLocation === 'offline'}
            onChange={(e) => setForm({ ...form, documentLocation: e.target.checked ? 'offline' : '' })}
          />
          <span>
            ID held offline -- I keep a physical or scanned copy of this person's photo ID outside this app and can
            produce it for an inspection. (Leave unticked if you are uploading the ID above; an uploaded ID replaces
            this.) A record with neither does not let a creator go live.
          </span>
        </label>

        <label className="block">
          <span className="block text-xs text-gray-400 mb-1">Notes</span>
          <textarea value={form.notes} onChange={update('notes')} rows={2}
            className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
        </label>

        {error && <p className="text-sm text-red-400">{error}</p>}
        {notice && <p className="text-sm text-green-400">{notice}</p>}

        <button type="submit" disabled={saving} className="premium-button text-sm disabled:opacity-50">
          {saving ? 'Saving…' : 'Save Record'}
        </button>
      </form>

      <div>
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by stage name, legal name or URL…"
            className="flex-1 min-w-[240px] px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
          />
          <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
            <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
          <span className="text-xs text-gray-500">{visible.length} record{visible.length === 1 ? '' : 's'}</span>
        </div>
        {/* Shown here too: record actions (attach, edit, archive) happen down
            in the list, far below the form's own message line. */}
        {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
        {notice && <p className="text-sm text-green-400 mb-3">{notice}</p>}

        {loading ? (
          <p className="text-gray-500 text-sm">Loading…</p>
        ) : visible.length === 0 ? (
          <p className="text-gray-500 text-sm">
            {records.length === 0 ? 'No records yet.' : 'Nothing matches that search.'}
          </p>
        ) : (
          <div className="space-y-3">
            {visible.map((r) => (
              <div key={r.id} className="premium-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3 mb-2">
                  <div>
                    <p className="font-bold text-white">
                      {r.unreadable ? <span className="text-red-400">Record #{r.id} cannot be decrypted</span> : r.legalName}
                      {r.aliases?.length > 0 && (
                        <span className="text-gray-400 font-normal"> — {r.aliases.join(', ')}</span>
                      )}
                    </p>
                    <p className="text-xs text-gray-500">
                      DOB {r.dateOfBirth} · {r.ageAtProduction} at production · produced {r.producedAt} ·
                      keep until {String(r.retainUntil).slice(0, 10)}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {r.document ? (
                      <button onClick={() => openDocument(r.id)} disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-full border border-brand-pink/50 text-brand-pink hover:bg-brand-pink/10 transition disabled:opacity-50">
                        {busyId === r.id ? 'Working…' : 'View ID'}
                      </button>
                    ) : (
                      <span className="text-xs px-3 py-1.5 rounded-full border border-yellow-500/40 text-yellow-400">
                        {r.documentLocation === 'offline' ? 'ID held offline' : 'No ID on file'}
                      </span>
                    )}
                    {r.status !== 'archived' && !r.unreadable && (
                      <label className={`text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:text-white transition cursor-pointer ${busyId === r.id ? 'opacity-50 pointer-events-none' : ''}`}>
                        {r.document ? 'Replace ID' : 'Attach ID'}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf"
                          className="hidden"
                          disabled={busyId === r.id}
                          onChange={(e) => {
                            const docFile = e.target.files?.[0] || null;
                            e.target.value = '';
                            attachDocument(r, docFile);
                          }}
                        />
                      </label>
                    )}
                    {r.status !== 'archived' && !r.document && r.documentLocation !== 'offline' && (
                      <button onClick={() => markHeldOffline(r)} disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50">
                        ID held offline
                      </button>
                    )}
                    {r.status !== 'archived' && (
                      <button onClick={() => (editing?.id === r.id ? setEditing(null) : startEdit(r))} disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50">
                        {editing?.id === r.id ? 'Cancel edit' : 'Edit / Link'}
                      </button>
                    )}
                    {r.status !== 'archived' && (
                      <button onClick={() => archive(r.id)} disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-full border border-white/15 text-gray-400 hover:text-white transition disabled:opacity-50">
                        Archive
                      </button>
                    )}
                  </div>
                </div>

                {(r.idType || r.idIssuer || r.idNumber) && (
                  <p className="text-xs text-gray-400">
                    {[r.idType, r.idIssuer, r.idNumber && `no. ${r.idNumber}`, r.idExpiry && `expires ${r.idExpiry}`]
                      .filter(Boolean).join(' · ')}
                  </p>
                )}
                {r.creatorId && (
                  <p className="text-xs text-gray-400 mt-1">
                    Linked creator: {(() => {
                      const c = creators.find((x) => String(x.id) === String(r.creatorId));
                      return c ? `${c.name} (${c.handle || `#${c.id}`})` : `#${r.creatorId} (no longer exists)`;
                    })()}
                  </p>
                )}
                {Array.isArray(r.documentHistory) && r.documentHistory.length > 0 && (
                  <p className="text-[11px] text-gray-500 mt-1">
                    {r.documentHistory.length} earlier ID document(s) kept in history.
                  </p>
                )}
                {r.contentUrls?.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1 break-all">{r.contentUrls.join('  ·  ')}</p>
                )}
                {r.unreadable && (
                  <p className="text-xs text-red-400 mt-2">
                    The encrypted fields on this record will not open with the current
                    RECORDS_ENCRYPTION_KEY ({r.unreadableReason}). The row is intact — this is a key
                    problem, not lost data. Do not delete it; restore the key that wrote it.
                  </p>
                )}
                {r.notes && <p className="text-xs text-gray-400 mt-2">{r.notes}</p>}
                {editing?.id === r.id && (
                  <div className="mt-3 p-3 rounded-md bg-black/30 border border-white/10 space-y-3">
                    <p className="text-[11px] text-gray-500">
                      Legal name, date of birth and ID number cannot be edited. If one is wrong, archive this record with
                      the reason and add a corrected one.
                    </p>
                    <label className="block">
                      <span className="block text-xs text-gray-400 mb-1">Linked creator account</span>
                      <select value={editing.creatorId} onChange={(e) => setEditing({ ...editing, creatorId: e.target.value })}
                        className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm">
                        <option value="">— not linked —</option>
                        {creators.map((c) => (
                          <option key={c.id} value={String(c.id)}>{c.name} ({c.handle || `#${c.id}`})</option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="block text-xs text-gray-400 mb-1">Names they work under, comma separated</span>
                      <input value={editing.aliases} onChange={(e) => setEditing({ ...editing, aliases: e.target.value })}
                        className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
                    </label>
                    <label className="block">
                      <span className="block text-xs text-gray-400 mb-1">Where the content appears — URLs</span>
                      <textarea value={editing.contentUrls} onChange={(e) => setEditing({ ...editing, contentUrls: e.target.value })} rows={2}
                        className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
                    </label>
                    <label className="block">
                      <span className="block text-xs text-gray-400 mb-1">Notes</span>
                      <textarea value={editing.notes} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} rows={2}
                        className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm" />
                    </label>
                    <button onClick={saveEdit} disabled={busyId === r.id} className="premium-button text-xs px-4 py-1.5 disabled:opacity-50">
                      {busyId === r.id ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                )}
                {r.status === 'archived' && (
                  <p className="text-xs text-yellow-400/80 mt-2">
                    Archived {String(r.archivedAt).slice(0, 10)}
                    {r.archiveReason ? ` — ${r.archiveReason}` : ''} (kept, not deleted)
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
