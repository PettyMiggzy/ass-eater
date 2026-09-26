import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { effectiveCreatorStatus, MAX_LOCATION_LENGTH } from '../../lib/creator-status';
import { FOUNDING_LIMIT, countFounding, isFoundingCreator, foundingAutoGrantEligible } from '../../lib/founding';
import { sanitizeGateTokens, tokenGateLive } from '../../lib/token-gate';
import { Icons, SolidIcons } from '../../components/Brand';
import { formatCredits, DM_PRICE_FLOOR_CENTS } from '../../lib/brand';
import {
  readJson,
  errorFrom,
  adminPost,
  adminGet,
  adminKeyHeader,
  adminUploadMedia,
  dollars,
  describeObligation,
} from '../../components/admin/adminApi';
import { draftFrom, fieldsFromDraft, rebaseDraft, fieldName, changedFrom, EDITABLE_KEYS, foundingWindowOutcome } from '../../components/admin/creatorDraft';
import { CATEGORIES, MAX_CATEGORIES } from '../../lib/categories';
import { getMarketplacePaymentConfig } from '../../lib/marketplace-payment-config';

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
  // creatorId -> the login account that owns it ({ userId, login, createdAt,
  // tosVersion }) from /api/admin/creators. Kept apart from the creator
  // records so a save response (which has no account) never erases it. A
  // creator with no entry has no login at all.
  const [accounts, setAccounts] = useState({});
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState({});
  // What the open draft was built from (draftFrom of the server's record at
  // the time). Saves send only the fields that differ from it, after rebasing
  // onto a fresh read -- see saveProfile.
  const [baseline, setBaseline] = useState(null);
  const [othersAppear, setOthersAppear] = useState(null);
  const [coPerformerIds, setCoPerformerIds] = useState([]);
  // The same §2257 answer for the profile photo, asked separately from the
  // gallery's: /api/admin/avatar refuses a finalize without it.
  const [avatarOthersAppear, setAvatarOthersAppear] = useState(null);
  const [avatarCoPerformerIds, setAvatarCoPerformerIds] = useState([]);
  const [recordOptions, setRecordOptions] = useState(null);
  const [recordOptionsLoading, setRecordOptionsLoading] = useState(false);
  const [alertsStatus, setAlertsStatus] = useState(null);
  const selectSeq = useRef(0);
  // The draft and baseline as they are NOW, for code that resumes after an
  // await (selectCreator's re-read) and must not act on the values its
  // closure captured before the admin typed anything.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;
  // The creator open in the editor RIGHT NOW. A save's response compares
  // against this, never against the `selectedId` captured when the save
  // started: the Accounts tab's "Open creator record" can switch creators
  // mid-save, and a stale comparison loaded A's fields into B's editor.
  const selectedIdRef = useRef(null);
  const openCreator = (id) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  };
  const isOpen = (id) => selectedIdRef.current !== null && String(selectedIdRef.current) === String(id);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState('creators');
  const [nextUploadIsAi, setNextUploadIsAi] = useState(false);
  const [mediaSessionOk, setMediaSessionOk] = useState(true);
  const [nciiSummary, setNciiSummary] = useState(null);
  // A takedown request the next gallery/avatar removals are recorded against
  // (so the request can be resolved as removed), and whether they are
  // QUARANTINED for it instead of deleted (content reported as possibly
  // showing a minor: 18 U.S.C. 2258A needs it preserved). The server also
  // quarantines on its own for a request filed as a possible minor. Blank = a
  // normal removal that deletes the file.
  const [preserveReportId, setPreserveReportId] = useState('');
  const [quarantineRemovals, setQuarantineRemovals] = useState(false);

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
      setAccounts(data.accounts && typeof data.accounts === 'object' ? data.accounts : {});
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
      const res = await fetch('/api/admin/media-session', { method: 'POST', headers: { 'x-admin-key': adminKeyHeader(key) } });
      setMediaSessionOk(res.ok);
      return res.ok;
    } catch {
      setMediaSessionOk(false);
      return false;
    }
  };

  const loadNciiSummary = async (key) => {
    try {
      // Its own small query (never the list): a flood of filings that makes
      // the list slow or fail must not take the 48-hour badge down with it.
      const { res, data } = await adminGet(key ?? adminKey, '/api/admin/ncii-summary');
      if (res.ok && data.summary) setNciiSummary(data.summary);
    } catch {
      // The badge is a convenience; the TAKEDOWN tab itself shows the real list.
    }
  };

  // Whether a new takedown filing alerts anyone out of band
  // (NCII_ALERT_WEBHOOK_URL). Shown as a banner until it is configured.
  const loadAlertsStatus = async (key) => {
    try {
      const { res, data } = await adminGet(key ?? adminKey, '/api/admin/alerts-status');
      if (res.ok) setAlertsStatus(data);
    } catch {
      // Unknown is shown as nothing, not as a false "configured".
    }
  };

  const checkKey = async () => {
    const key = adminKey.trim();
    if (!key) return;
    const ok = await loadCreators(key);
    if (!ok) return;
    await startMediaSession(key);
    loadNciiSummary(key);
    loadAlertsStatus(key);
    // Keep the key that passed the check: every later request (saves, the
    // tab panels, the media-session refresh, the takedown poll) reads
    // `adminKey`, and the untrimmed value would be refused by the server.
    setAdminKey(key);
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
    setAccounts({});
    clearSelection();
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

  // What saving does to a Founding creator whose 30-day fee-free window has
  // not started -- foundingWindowOutcome() mirrors the server's stamping
  // rules. Null when the window already started.
  const foundingWindowHint = (() => {
    if (!selected) return null;
    const o = foundingWindowOutcome(selected, draft.status || selectedStatus);
    if (o.kind === 'started') return null;
    if (o.kind === 'revoked') return 'Saving as Banned revokes Founding and frees the slot, whatever this box says.';
    if (o.kind === 'approval') return 'Slot reserved; the 30-day fee-free window starts the day they are approved (set to Active).';
    if (o.kind === 'at') {
      return `The 30-day fee-free window starts when the suspension ends (${new Date(o.at).toLocaleDateString()}${o.fresh ? ', 30 days after this save' : ''}).`;
    }
    return 'Saving starts their 30-day fee-free window now.';
  })();

  /** The roster as the server has it now, or null (status already set). */
  const fetchRoster = async () => {
    const { res, data } = await adminGet(adminKey, '/api/admin/creators');
    if (!res.ok || !Array.isArray(data.creators)) {
      setStatus(`Error: ${errorFrom(res, data, 'Could not load creators')}`);
      return null;
    }
    setCreators(data.creators);
    setAccounts(data.accounts && typeof data.accounts === 'object' ? data.accounts : {});
    return data.creators;
  };

  // The §2257 co-performer answers and the AI label belong to ONE upload for
  // ONE creator: "asked per upload and reset after each one, never
  // remembered". Every path that changes which creator is open calls this --
  // an answer given for creator A (with A's co-performer records ticked) must
  // never be carried into the next creator's upload. The TAKE IT DOWN
  // request number and the possible-minor quarantine tick are per-creator the
  // same way: they decide which request the next gallery / profile-photo
  // removal is recorded against, so '+ Add Model' or closing the editor must
  // not carry request #N over to an unrelated model's removals.
  const resetUploadAttestations = () => {
    setOthersAppear(null);
    setCoPerformerIds([]);
    setAvatarOthersAppear(null);
    setAvatarCoPerformerIds([]);
    setNextUploadIsAi(false);
    setPreserveReportId('');
    setQuarantineRemovals(false);
  };

  /** Closes the editor (the creator is gone or the panel is locking). */
  const clearSelection = () => {
    selectSeq.current += 1;
    openCreator(null);
    setDraft({});
    setBaseline(null);
    resetUploadAttestations();
  };

  // Selecting a creator re-reads them, rather than editing the roster
  // snapshot loaded at unlock: the creator may have changed their wallet, bio
  // or handle from their dashboard since, and a draft built from the old copy
  // is exactly what used to write those values back.
  const selectCreator = async (id) => {
    const seq = ++selectSeq.current;
    openCreator(id);
    const snap = creators.find((c) => String(c.id) === String(id));
    const snapBaseline = snap ? draftFrom(snap) : null;
    if (snap) {
      setDraft(draftFrom(snap));
      setBaseline(snapBaseline);
      draftRef.current = draftFrom(snap);
      baselineRef.current = snapBaseline;
    } else {
      // Nothing to show until the re-read lands -- and nothing of the
      // previously open creator's draft may be rebased onto this one.
      setDraft({});
      setBaseline(null);
      draftRef.current = {};
      baselineRef.current = null;
    }
    resetUploadAttestations();
    try {
      const roster = await fetchRoster();
      if (!roster || seq !== selectSeq.current) return;
      const fresh = roster.find((c) => String(c.id) === String(id));
      if (!fresh) { clearSelection(); setStatus('That creator no longer exists.'); return; }
      // The editor is usable from the snapshot while this re-read is in
      // flight. Anything typed meanwhile is rebased onto the fresh copy
      // (kept unless the stored value also moved), never discarded.
      const current = draftRef.current;
      const base = baselineRef.current;
      const dirty = !!base && EDITABLE_KEYS.some((k) => changedFrom(current, base, k));
      if (!dirty) {
        setDraft(draftFrom(fresh));
        setBaseline(draftFrom(fresh));
        return;
      }
      const rebased = rebaseDraft(current, base, fresh);
      setDraft(rebased.draft);
      setBaseline(rebased.baseline);
      if (rebased.conflicts.length) {
        setStatus(
          `The ${rebased.conflicts.map(fieldName).join(', ')} changed on the server while this creator was loading; `
          + 'the editor now shows the current value in place of what you typed. Check it before saving.',
        );
      }
    } catch {
      if (seq === selectSeq.current) setStatus('Error: could not refresh this creator. Reload before saving.');
    }
  };

  /** Puts the server's copy of a creator into the roster (and the draft, if it's the one open). */
  const applyCreator = (creator, { resyncDraft = false } = {}) => {
    if (!creator || creator.id === undefined) return;
    setCreators((prev) => prev.map((c) => (String(c.id) === String(creator.id) ? creator : c)));
    if (resyncDraft && isOpen(creator.id)) {
      setDraft(draftFrom(creator));
      setBaseline(draftFrom(creator));
    }
  };

  // A creator changed by ANOTHER tab of this panel (a takedown request's
  // enforcement suspending or banning them). The roster always takes the new
  // copy; the open editor only when it holds no unsaved edits. Overwriting
  // the draft used to throw away a half-typed bio or payout wallet with no
  // message. With edits pending, the draft is left alone and saveProfile's
  // rebase onto a fresh read keeps the edits and stops on any real conflict.
  const applyCreatorFromElsewhere = (creator) => {
    if (!creator || creator.id === undefined) return;
    const dirty = isOpen(creator.id) && !!baseline && EDITABLE_KEYS.some((k) => changedFrom(draft, baseline, k));
    applyCreator(creator, { resyncDraft: !dirty });
    if (dirty) {
      setStatus(
        `${creator.name || 'This creator'} was changed by that action (now ${effectiveCreatorStatus(creator) || 'active'}). `
        + 'Your unsaved edits in the creator editor were kept; saving will apply them on top of the current record.',
      );
    }
  };

  const saveProfile = async () => {
    if (!baseline) { setStatus('Error: this creator is still loading. Try again in a moment.'); return; }
    if (fieldsFromDraft(draft, baseline).error) { setStatus(`Error: ${fieldsFromDraft(draft, baseline).error}`); return; }
    const savingId = selectedId;
    setBusy(true);
    setStatus('Saving...');
    try {
      // Rebase onto the record as it is right now, so a change the creator
      // (or another admin tab) made since this draft was opened is never
      // overwritten by a value the admin didn't touch -- and one the admin
      // DID touch is stopped and shown instead of silently replaced.
      const roster = await fetchRoster();
      if (!roster) return;
      // Another creator was opened while the roster loaded: this draft is no
      // longer the one on screen, so nothing is rebased into it or sent.
      if (!isOpen(savingId)) { setStatus('Nothing was saved -- another creator was opened before the save went out.'); return; }
      const current = roster.find((c) => String(c.id) === String(savingId));
      if (!current) { clearSelection(); setStatus('Error: that creator no longer exists. Nothing was saved.'); return; }
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
      // A ban is the one irreversible choice this form makes, and the Status
      // dropdown puts it right next to "Pending": confirm it like every other
      // destructive action in this panel. Asked only on the transition into
      // 'banned' (the panel re-posts status on every save), against the
      // CURRENT record, so re-saving an already-banned creator isn't nagged.
      const becomingBanned = built.fields.status === 'banned' && effectiveCreatorStatus(current) !== 'banned';
      if (becomingBanned && !confirm(
        `Ban ${current.name || 'this creator'} permanently?\n\n`
        + '- Every listing that has not sold comes off sale for good and can never be relisted -- including ones buyers have already paid for.\n'
        + '- Photos/videos are DELETED for good, except on listings buyers hold paid digital orders for (those buyers keep access). '
        + 'Sold physical listings lose their photos too.\n'
        + (isFoundingCreator(current) ? '- Their Founding Creator slot is revoked.\n' : '')
        + '- Their credit balance and pending payouts are frozen while the ban stands.\n\n'
        + 'Setting them back to Active later lifts the credit/payout freeze, but the listings, the deleted files'
        + (isFoundingCreator(current) ? ' and the Founding slot' : '') + ' do not come back.',
      )) { setStatus('Nothing was saved.'); return; }
      // Unticking Founding is also permanent (foundingRevokedAt stops any
      // later auto-grant), so it gets the same prompt when it isn't already
      // covered by the ban confirmation above.
      if (!becomingBanned && built.fields.founding === false && isFoundingCreator(current) && !confirm(
        `Revoke ${current.name || 'this creator'}'s Founding Creator status?\n\n`
        + 'This is permanent: they will not be granted Founding again automatically, and their fee waiver ends.',
      )) { setStatus('Nothing was saved.'); return; }
      const { res, data } = await adminPost(adminKey, '/api/admin/profile', { creatorId: savingId, fields: built.fields });
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
      if (built.fields.status === 'banned') {
        notes.push('Their unsold listings are taken down. Any paid order they had not shipped is listed under "Their orders" below -- close each one so its buyer is told.');
      }
      setStatus(['Saved.', ...notes].join(' '));
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Answer-first, like the gallery: §2257 applies to the profile photo too
  // (it is the most public image on the site), and /api/admin/avatar refuses
  // and deletes an upload finalized without the answer.
  const uploadAvatar = async (file) => {
    if (!file) return;
    const creatorId = selectedId;
    if (avatarOthersAppear === null) {
      setStatus('Error: answer "Does anyone besides this creator appear in the photo?" before uploading.');
      return;
    }
    if (avatarOthersAppear && !avatarCoPerformerIds.length) {
      setStatus('Error: pick the §2257 record of every other person in the photo, or add their record in the Records tab first.');
      return;
    }
    setBusy(true);
    setStatus('Uploading avatar...');
    try {
      const data = await adminUploadMedia({
        adminKey,
        creatorId,
        purpose: 'avatar',
        file,
        othersAppear: avatarOthersAppear,
        coPerformerRecordIds: avatarOthersAppear ? avatarCoPerformerIds : undefined,
        onProgress: (p) => setStatus(`Uploading avatar... ${Math.round(p)}%`),
      });
      applyCreator(data.creator);
      setAvatarOthersAppear(null);
      setAvatarCoPerformerIds([]);
      setStatus('Avatar updated.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Re-runs a banned creator's listing takedown on its own: posts just
  // { status: 'banned' }, which /api/admin/profile answers by taking every
  // listing down again (already-removed ones are skipped). For a ban whose
  // takedown failed part-way -- by hand or from the takedown-request ladder --
  // without touching any other field. Re-reads the creator first and refuses
  // unless they are STILL banned, so a stale panel cannot re-ban someone
  // another admin has since reinstated.
  const retryTakedown = async () => {
    if (!selected || selectedStatus !== 'banned') return;
    setBusy(true);
    setStatus('Retrying listing takedown...');
    try {
      const roster = await fetchRoster();
      if (!roster) return;
      const current = roster.find((c) => String(c.id) === String(selectedId));
      if (!current || effectiveCreatorStatus(current) !== 'banned') {
        if (current) applyCreator(current, { resyncDraft: true });
        setStatus('Nothing was done -- this creator is no longer banned (the editor now shows their current status).');
        return;
      }
      const { res, data } = await adminPost(adminKey, '/api/admin/profile', {
        creatorId: selectedId,
        fields: { status: 'banned', suspendedUntil: null },
      });
      if (data.creator) applyCreator(data.creator, { resyncDraft: true });
      if (!res.ok) throw new Error(errorFrom(res, data, 'The takedown failed'));
      setStatus('Listing takedown done: every listing of this banned creator is off sale.');
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // Takes a reported or unwanted profile photo down: resets it to the
  // placeholder and deletes the file (pages/api/admin/avatar.js remove:true).
  const removeAvatar = async () => {
    const requestId = preserveReportId.trim();
    if (requestId && !/^[1-9][0-9]{0,17}$/.test(requestId)) {
      setStatus('Error: the takedown request number must be a plain number like 12 (or leave it blank).');
      return;
    }
    const preserveFor = requestId && quarantineRemovals ? requestId : '';
    if (!confirm(preserveFor
      ? `Remove this creator's profile photo and QUARANTINE it as evidence for takedown request #${preserveFor}? It is replaced with the placeholder, never served again, and kept (not deleted) for the NCMEC report.`
      : requestId
        ? `Remove this creator's profile photo for takedown request #${requestId}? It is replaced with the placeholder and the file is deleted (quarantined instead if that request was filed as a possible minor). The removal is recorded on the request.`
        : "Remove this creator's profile photo? It is replaced with the neutral placeholder and the file is deleted from storage.")) return;
    setBusy(true);
    setStatus('Removing photo...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/avatar', {
        creatorId: String(selectedId),
        remove: true,
        ...(preserveFor ? { preserveForNciiReportId: preserveFor } : requestId ? { nciiReportId: requestId } : {}),
      });
      if (!res.ok || !data.creator) throw new Error(errorFrom(res, data, 'Could not remove the photo'));
      applyCreator(data.creator);
      const recorded = requestId ? ` Recorded on takedown request #${requestId}.` : '';
      setStatus(
        (data.preserved
          ? `Photo removed and quarantined as evidence for takedown request #${requestId} (Evidence tab).`
          : data.removed
            ? 'Photo removed and the file deleted.'
            : 'Photo reset to the placeholder (there was no uploaded file to delete).') + (data.preserved ? '' : recorded),
      );
    } catch (err) {
      setStatus(`Error: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  // The §2257 records a co-performer can be picked from: non-archived, with an
  // ID attached or held offline (the same rule lib/performer-attestation.js
  // enforces on the finalize). Loaded when the admin says someone else appears.
  // Re-read every time someone answers "yes" (and on Refresh): the panel
  // tells the admin to add a missing record in the Records tab, so a list
  // cached from the first answer would never show it.
  const loadRecordOptions = async () => {
    setRecordOptionsLoading(true);
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/performer-records');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not load §2257 records'));
      const usable = (Array.isArray(data.records) ? data.records : [])
        .filter((r) => r.status !== 'archived' && (r.document || r.documentLocation === 'offline'));
      setRecordOptions(usable);
    } catch (err) {
      setRecordOptions((prev) => prev ?? []);
      setStatus(`Error: ${err.message}`);
    } finally {
      setRecordOptionsLoading(false);
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
      setNextUploadIsAi(false);
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
    const requestId = preserveReportId.trim();
    if (requestId && !/^[1-9][0-9]{0,17}$/.test(requestId)) {
      setStatus('Error: the takedown request number must be a plain number like 12 (or leave it blank).');
      return;
    }
    const preserveFor = requestId && quarantineRemovals ? requestId : '';
    if (preserveFor && !confirm(
      `Remove this item and QUARANTINE it as evidence for takedown request #${preserveFor}? It is never served again and is kept (not deleted) for the NCMEC report.`,
    )) return;
    if (!preserveFor && requestId && !confirm(
      `Remove this item for takedown request #${requestId}? The file is deleted (quarantined instead if that request was filed as a possible minor), and the removal is recorded on the request.`,
    )) return;
    // An ordinary removal confirms too (as removeAvatar does): it deletes the
    // file from storage and nothing can undo it.
    if (!requestId && !confirm(
      'Remove this item from the creator\'s gallery? The file is deleted from storage and this cannot be undone.',
    )) return;
    setBusy(true);
    setStatus('Removing...');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/gallery-delete', {
        creatorId: selectedId,
        src: item.src,
        index,
        ...(preserveFor ? { preserveForNciiReportId: preserveFor } : requestId ? { nciiReportId: requestId } : {}),
      });
      if (res.status === 409) {
        await loadCreators();
        setStatus('That item had already changed or been removed -- the gallery has been refreshed. Check it and try again if needed.');
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Delete failed'));
      applyCreator(data.creator);
      setStatus(data.preserved
        ? `Removed and quarantined as evidence for takedown request #${requestId} (Evidence tab).`
        : `Removed (the file is deleted from storage too).${requestId ? ` Recorded on takedown request #${requestId}.` : ''}`);
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
      resetUploadAttestations();
      openCreator(data.creator.id);
      setDraft(draftFrom(data.creator));
      setBaseline(draftFrom(data.creator));
      setStatus(
        'Model created as a hidden, pending draft with NO LOGIN: nobody can sign in to this profile, so it cannot '
        + 'reply to or receive paid messages, create listings, or request payouts, and if the real person later signs '
        + 'up themselves that creates a second, separate profile. Use it only for a managed profile. To publish it: '
        + 'fill in the details and a handle, add a §2257 record for them in the Records tab (ID attached or marked held '
        + 'offline), then set Status to Active.',
      );
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
        if (isOpen(id)) clearSelection();
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
      clearSelection();
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
  // and from the daily cron anyway; this runs it now. Never touches a file a
  // record references or a file preserved as evidence.
  //
  // One call stops at a time budget and reports `remaining` (rows it claimed
  // but handed back unprocessed) -- so it is called again while that is above
  // 0, up to SWEEP_MAX_ROUNDS times, and the totals are added up. It used to
  // report "Sweep done" after the first batch, so a ban that queued 600 files
  // read as finished with 400 still in storage.
  const sweepMedia = async () => {
    const SWEEP_MAX_ROUNDS = 10;
    const SWEEP_LIMIT = 200;
    setBusy(true);
    setStatus('Sweeping orphaned uploads...');
    const n = (v) => Number(v) || 0;
    const total = { checked: 0, deleted: 0, kept: 0, failed: 0 };
    let remaining = 0;
    let rounds = 0;
    let stoppedEarly = false;
    let outstanding = null;
    try {
      for (;;) {
        rounds += 1;
        const { res, data } = await adminPost(adminKey, '/api/admin/media-sweep', { limit: SWEEP_LIMIT });
        if (!res.ok) throw new Error(errorFrom(res, data, 'Sweep failed'));
        for (const k of Object.keys(total)) total[k] += n(data[k]);
        remaining = n(data.remaining);
        outstanding = data.outstanding && typeof data.outstanding === 'object' ? data.outstanding : outstanding;
        const more = remaining > 0 || n(data.checked) >= SWEEP_LIMIT;
        if (!more) break;
        if (rounds >= SWEEP_MAX_ROUNDS) { stoppedEarly = true; break; }
        setStatus(`Sweeping orphaned uploads... round ${rounds + 1} (${total.deleted} deleted so far)`);
      }
      const lines = [
        `${stoppedEarly ? `Sweep stopped after ${rounds} rounds` : 'Sweep done'}: `
          + `${total.checked} checked, ${total.deleted} deleted, ${total.kept} still in use, ${total.failed} failed (retried next sweep).`,
      ];
      if (stoppedEarly) {
        lines.push(`More may remain${remaining > 0 ? ` (at least ${remaining} not reached)` : ''} -- press Sweep again.`);
      }
      if (outstanding) {
        const waiting = n(outstanding.deletePending) + n(outstanding.deleteFailed);
        lines.push(
          waiting > 0
            ? `Still waiting to be deleted: ${n(outstanding.deletePending)} queued, ${n(outstanding.deleteFailed)} failed`
              + `${outstanding.oldestAt ? ` (oldest since ${new Date(outstanding.oldestAt).toLocaleString()})` : ''}.`
              + ' A takedown file that keeps failing to delete stays here until it succeeds.'
            : 'Nothing is waiting to be deleted.',
        );
      }
      setStatus(lines.join('\n'));
    } catch (err) {
      setStatus(total.checked ? `Error after ${total.deleted} deleted: ${err.message}` : `Error: ${err.message}`);
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
  const nciiOpenMinor = Number(nciiSummary?.openMinor) || 0;
  const nciiUrgent = nciiOpenMinor > 0 || (nciiOpen > 0 && nciiOldestHours !== null && nciiOldestHours >= 36);

  const tabs = [
    { key: 'creators', label: 'CREATORS' },
    { key: 'reports', label: 'REPORTS' },
    { key: 'violations', label: 'VIOLATIONS' },
    { key: 'takedowns', label: 'TAKEDOWN REQUESTS', badge: nciiOpen },
    { key: 'records', label: '§2257 RECORDS' },
    { key: 'evidence', label: 'EVIDENCE' },
    { key: 'waitlist', label: 'WAITLIST' },
    { key: 'payouts', label: 'PAYOUTS' },
    { key: 'accounts', label: 'ACCOUNTS' },
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
              {nciiOpenMinor > 0 && `, ${nciiOpenMinor} filed as a POSSIBLE MINOR`}
              {nciiOldestHours !== null && ` -- oldest filed ${nciiOldestHours}h ago`}. Each must be reviewed and, if valid,
              removed within 48 hours of filing.{nciiOldestHours !== null && nciiOldestHours >= 48 ? ' OVERDUE.' : ''}
            </button>
          )}

          {alertsStatus && alertsStatus.nciiWebhookConfigured === false && (
            <div className="mb-4 px-4 py-3 rounded-md bg-red-900/30 border border-red-500/50 text-red-200 text-sm">
              Takedown alerts are NOT configured: a new TAKE IT DOWN request alerts nobody -- it only shows up here, while
              its 48-hour legal clock runs. Set NCII_ALERT_WEBHOOK_URL (a Slack, Discord or relay webhook) in the
              production environment and redeploy.
            </div>
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
            <ReportsPanel
              adminKey={adminKey}
              onCreatorBanned={async (creatorId) => {
                // The ban ran server-side in the resolve's own transaction;
                // re-read so the roster (and an open, unedited editor) shows it.
                const roster = await fetchRoster();
                const banned = roster && roster.find((c) => String(c.id) === String(creatorId));
                if (banned) applyCreatorFromElsewhere(banned);
              }}
            />
          ) : page === 'violations' ? (
            <ViolationsPanel adminKey={adminKey} />
          ) : page === 'takedowns' ? (
            <NciiReportsPanel
              adminKey={adminKey}
              creators={creators}
              onSummary={setNciiSummary}
              onCreatorChanged={applyCreatorFromElsewhere}
              alertsConfigured={alertsStatus ? alertsStatus.nciiWebhookConfigured : null}
            />
          ) : page === 'records' ? (
            <PerformerRecordsPanel adminKey={adminKey} creators={creators} />
          ) : page === 'evidence' ? (
            <EvidencePanel adminKey={adminKey} />
          ) : page === 'waitlist' ? (
            <WaitlistPanel adminKey={adminKey} />
          ) : page === 'payouts' ? (
            <PayoutsPanel adminKey={adminKey} />
          ) : page === 'accounts' ? (
            <AccountsPanel adminKey={adminKey} creators={creators} onOpenCreator={(id) => { setPage('creators'); selectCreator(id); }} />
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
                      {!c.seed && !c.demo && !accounts[String(c.id)] && (
                        <p className="text-[10px] text-yellow-400/80" title="Created from this panel: nobody can sign in to this profile">No login (managed)</p>
                      )}
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
                      <label
                        className={`premium-button inline-block cursor-pointer text-sm py-2 px-4 ${busy || avatarOthersAppear === null || (avatarOthersAppear && !avatarCoPerformerIds.length) ? 'opacity-50 pointer-events-none' : ''}`}
                        title={avatarOthersAppear === null ? 'Answer the question below first' : undefined}
                      >
                        Change PFP
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                          className="hidden"
                          disabled={busy || avatarOthersAppear === null || (avatarOthersAppear && !avatarCoPerformerIds.length)}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            uploadAvatar(file);
                          }}
                        />
                      </label>
                      <p className="text-[10px] text-gray-500 mt-1">JPEG, PNG, WebP, GIF or AVIF, up to 10MB. The old photo is deleted.</p>
                      <PerformerAttestation
                        name="avatarOthersAppear"
                        question="Does anyone besides this creator appear in the new photo?"
                        value={avatarOthersAppear}
                        onChange={(v) => { setAvatarOthersAppear(v); setAvatarCoPerformerIds([]); if (v) loadRecordOptions(); }}
                        ids={avatarCoPerformerIds}
                        onIds={setAvatarCoPerformerIds}
                        recordOptions={recordOptions}
                        excludeCreatorId={selected.id}
                        loading={recordOptionsLoading}
                        onRefresh={loadRecordOptions}
                      />
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

                  <CreatorAccountInfo creator={selected} account={accounts[String(selected.id)]} />

                  <div className="grid sm:grid-cols-2 gap-4">
                    <Field label="Name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} />
                    <Field label="Handle (required to go live)" value={draft.handle} onChange={(v) => setDraft({ ...draft, handle: v })} />
                    <Field label="Price" value={draft.price} onChange={(v) => setDraft({ ...draft, price: v })} />
                    <Field label="Location (optional)" value={draft.location} maxLength={MAX_LOCATION_LENGTH} onChange={(v) => setDraft({ ...draft, location: v })} />
                    <Field label="Age (optional, 18+)" value={draft.age} onChange={(v) => setDraft({ ...draft, age: v })} />
                  </div>
                  {/* Tags, location and age are public and are re-screened when a
                      creator goes live; a refusal names the field, so the
                      field has to be here for the admin to clear it. */}
                  <div>
                    <Field
                      label="Tags (comma-separated, up to 8 -- shown as #chips and in search)"
                      value={draft.tags}
                      onChange={(v) => setDraft({ ...draft, tags: v })}
                    />
                    <p className="text-[10px] text-gray-500 mt-1">
                      Letters, numbers, spaces and hyphens only. Clearing this removes every tag.
                    </p>
                  </div>
                  {/* Browse categories (lib/categories.js): the Categories
                      sidebar on /creators and /marketplace. Same chips and
                      the same cap as the creator's own dashboard. */}
                  <div>
                    <label className="block text-sm text-gray-400 mb-2">
                      Categories (up to {MAX_CATEGORIES} -- the browse sidebar on Explore and Marketplace)
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {CATEGORIES.map((c) => {
                        const current = Array.isArray(draft.categories) ? draft.categories : [];
                        const active = current.includes(c.key);
                        const full = !active && current.length >= MAX_CATEGORIES;
                        return (
                          <button
                            type="button"
                            key={c.key}
                            aria-pressed={active}
                            disabled={full}
                            onClick={() =>
                              setDraft({
                                ...draft,
                                categories: active ? current.filter((k) => k !== c.key) : [...current, c.key],
                              })
                            }
                            className={`text-xs px-3 py-1.5 rounded-full border transition disabled:opacity-40 disabled:cursor-not-allowed ${
                              active
                                ? 'bg-brand-pink border-brand-pink text-white font-bold'
                                : 'border-white/15 text-gray-300 hover:border-brand-pink/50 hover:text-white'
                            }`}
                          >
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
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
                      {accounts[String(selected.id)]?.login
                        ? ` If you don't have their legal name, date of birth and photo ID yet, ask for them at their login address above (${accounts[String(selected.id)].login}).`
                        : ' This profile has no login, so there is nobody to ask through the platform -- get the performer\'s ID directly.'}
                      {' '}Every public field -- tags, location and socials included -- is screened again when it goes live.
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
                    {draft.founding && selected.foundingSince && Date.parse(selected.foundingSince) <= Date.now() && (
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
                    {draft.founding && foundingWindowHint && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">{foundingWindowHint}</p>
                    )}
                    {/* Decided from the STORED record through the same
                        foundingAutoGrantEligible() pages/api/admin/profile.js
                        runs on `existing`, so the hint can't promise a badge the
                        save won't give (a reinstated, once-banned or violating
                        applicant is never auto-granted). */}
                    {selectedIsPending && !draft.founding && !selected.foundingRevokedAt && foundingAutoGrantEligible(selected) && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        Approving (Pending → Active) grants Founding automatically if their profile is finished and a slot
                        is free. To approve without it, untick it on a second save afterwards.
                      </p>
                    )}
                    {selectedIsPending && !draft.founding && !selected.foundingRevokedAt && !isFoundingCreator(selected) && !foundingAutoGrantEligible(selected) && (
                      <p className="basis-full text-xs text-gray-500 -mt-3">
                        Approving won't grant Founding automatically -- this creator was approved or banned before, or
                        has a confirmed content violation. Tick it to grant it by hand.
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

                  {selectedStatus === 'banned' && (
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        onClick={retryTakedown}
                        disabled={busy}
                        className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                      >
                        Retry listing takedown
                      </button>
                      <span className="text-[11px] text-gray-500">
                        Use this if a ban reported that taking their listings down failed. Saving this banned
                        creator also retries it.
                      </span>
                    </div>
                  )}
                  {draft.status === 'banned' && selectedStatus !== 'banned' && (
                    <p className="text-xs text-red-400">
                      Banning takes every listing that has not sold off sale for good (paid-for ones included; none can be
                      relisted) and deletes listing photos and videos, except on listings buyers hold paid digital orders
                      for. Sold physical listings lose their photos too. Their credit balance and pending payouts are frozen
                      while the ban stands; setting them back to Active lifts that freeze, but not the listings or files.
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
                            // The AI label is cleared by uploadGalleryItem only
                            // after a successful finalize, like the §2257
                            // answer: a failed upload keeps it for the retry.
                            uploadGalleryItem(file, nextUploadIsAi);
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
                    <PerformerAttestation
                      name="othersAppear"
                      question="Does anyone besides this creator appear in the next upload?"
                      value={othersAppear}
                      onChange={(v) => { setOthersAppear(v); setCoPerformerIds([]); if (v) loadRecordOptions(); }}
                      ids={coPerformerIds}
                      onIds={setCoPerformerIds}
                      recordOptions={recordOptions}
                      excludeCreatorId={selected.id}
                      loading={recordOptionsLoading}
                      onRefresh={loadRecordOptions}
                    />
                    <div className="mb-3 px-3 py-2 rounded-md bg-red-900/10 border border-red-500/30 text-xs text-gray-300">
                      <label className="flex flex-wrap items-center gap-2">
                        Removing content for a TAKE IT DOWN request? Request #
                        <input
                          value={preserveReportId}
                          onChange={(e) => {
                            const next = e.target.value.replace(/[^0-9]/g, '').slice(0, 18);
                            // The quarantine answer belongs to one request: a
                            // different (or cleared) number has to be decided again.
                            if (next !== preserveReportId) setQuarantineRemovals(false);
                            setPreserveReportId(next);
                          }}
                          placeholder="e.g. 12"
                          inputMode="numeric"
                          className="w-24 px-2 py-1 rounded-md bg-black/40 border border-red-500/40 text-white text-xs"
                        />
                      </label>
                      <label className="flex items-center gap-2 mt-1">
                        <input
                          type="checkbox"
                          checked={quarantineRemovals}
                          disabled={!preserveReportId}
                          onChange={(e) => setQuarantineRemovals(e.target.checked)}
                        />
                        Possibly shows a MINOR: quarantine as evidence instead of deleting
                      </label>
                      <p className="text-[10px] text-gray-500 mt-1">
                        With a request number, the next removals here (gallery items and the profile photo) are recorded
                        on that request, so it can be resolved as removed. Quarantined files are kept as evidence instead
                        of deleted -- never served, listed in the Evidence tab -- as 18 U.S.C. 2258A requires; a request
                        filed as a possible minor is always quarantined. Leave blank for an ordinary removal, which
                        deletes the file.
                      </p>
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
                            // Always visible on devices without hover: an
                            // opacity-0 button still takes taps, and a phone
                            // tap near a thumbnail's corner used to delete it
                            // unseen. deleteGalleryItem also always confirms.
                            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-black/70 text-white text-xs [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 focus:opacity-100 transition disabled:opacity-30"
                          >
                            <Icons.close className="h-3.5 w-3.5 mx-auto" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* This creator's orders and listings, found by id rather
                      than typed in: a ban or delete only reports how MANY
                      paid orders are unshipped, and a listing an admin finds
                      themselves had no takedown button short of a ban. */}
                  <OrdersPanel
                    key={`orders-${selected.id}`}
                    adminKey={adminKey}
                    creators={creators}
                    fixedCreatorId={String(selected.id)}
                    title="Their orders"
                  />
                  <details className="premium-card p-4">
                    <summary className="cursor-pointer text-sm font-bold text-white">Take down one of their listings, wall comments or messages</summary>
                    <div className="mt-3">
                      <TakedownControl
                        key={`takedown-${selected.id}`}
                        adminKey={adminKey}
                        creators={creators}
                        initialCreatorId={String(selected.id)}
                        disabled={busy}
                        onDone={async (msg) => { setStatus(msg); }}
                        onError={(msg) => setStatus(`Error: ${msg}`)}
                      />
                    </div>
                  </details>
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

/**
 * Who owns this creator profile: the login account (id + the identifier they
 * signed up with) from /api/admin/creators `accounts`. Admin-only -- the
 * login never reaches a public page. A profile made with "+ Add Model" has
 * no login at all, and the panel says so plainly, because it can't reply to
 * messages, sell, or be paid.
 */
function CreatorAccountInfo({ creator, account }) {
  if (creator?.seed || creator?.demo) {
    return <p className="text-xs text-gray-500">Demo / seed profile -- no login, not for sale.</p>;
  }
  if (!account) {
    return (
      <div className="px-3 py-2 rounded-md bg-yellow-900/20 border border-yellow-500/40 text-xs text-yellow-200">
        No login (managed): nobody can sign in to this profile. It can't reply to or receive paid messages, create
        listings, or request payouts, and if the real person signs up later that creates a separate second profile.
      </div>
    );
  }
  return (
    <div className="text-xs text-gray-400">
      Login account: <span className="font-mono text-white break-all">{String(account.login || '(no identifier)')}</span>
      {' '}· user <span className="font-mono">{String(account.userId)}</span>
      {account.createdAt ? ` · signed up ${new Date(account.createdAt).toLocaleDateString()}` : ''}
      {account.tosVersion ? ` · accepted Terms ${String(account.tosVersion)}` : ''}
      <span className="block text-[10px] text-gray-500 mt-0.5">
        Creators must sign up with a real email address -- use it to reach them (for example, to ask for the photo ID
        their §2257 record needs). Admin-only; never shown publicly.
      </span>
    </div>
  );
}

function Field({ label, value, onChange, maxLength }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-2">{label}</label>
      <input
        type="text"
        value={value}
        maxLength={maxLength}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 rounded-md bg-black/40 border border-brand-purple/30 text-white"
      />
    </div>
  );
}

/**
 * The §2257 answer every admin upload carries (lib/performer-attestation.js):
 * does anyone besides the creator appear, and if so, the record of every
 * other person. Asked per upload and reset after each one, never remembered.
 * The record list is re-read each time "yes" is picked and on Refresh -- the
 * admin is told to add a missing record in the Records tab, so a list cached
 * from the first answer would never show it.
 */
function PerformerAttestation({ name, question, value, onChange, ids, onIds, recordOptions: allOptions, loading, onRefresh, excludeCreatorId }) {
  // The creator's OWN §2257 record is never a co-performer: the server
  // refuses it (lib/performer-attestation.js, 409), so it isn't offered.
  const recordOptions = Array.isArray(allOptions) && excludeCreatorId !== undefined && excludeCreatorId !== null
    ? allOptions.filter((r) => String(r.creatorId ?? '') !== String(excludeCreatorId))
    : allOptions;
  return (
    <div className="mt-3 mb-3 text-xs text-gray-300">
      <p className="mb-1">{question}</p>
      <div className="flex gap-4">
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" name={name} checked={value === false} onChange={() => onChange(false)} />
          No, only them
        </label>
        <label className="flex items-center gap-1 cursor-pointer">
          <input type="radio" name={name} checked={value === true} onChange={() => onChange(true)} />
          Yes, someone else too
        </label>
      </div>
      {value === true && (
        <div className="mt-2">
          <p className="text-[11px] text-gray-500 mb-1">
            Tick the §2257 record of EVERY other person in the file. Only records with an ID attached or
            held offline are listed; add a missing one in the Records tab first, then{' '}
            <button type="button" onClick={onRefresh} disabled={loading} className="underline text-gray-300 disabled:opacity-50">
              refresh this list
            </button>
            .
          </p>
          {recordOptions === null || (loading && !recordOptions.length) ? (
            <p className="text-[11px] text-gray-500">Loading records…</p>
          ) : recordOptions.length === 0 ? (
            <p className="text-[11px] text-yellow-400/90">No usable §2257 records yet.</p>
          ) : (
            <div className="max-h-40 overflow-y-auto space-y-1">
              {recordOptions.map((r) => (
                <label key={r.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ids.includes(String(r.id))}
                    onChange={(e) => onIds((prev) => (e.target.checked
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
  );
}

function ReportsPanel({ adminKey, onCreatorBanned }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // The list is paged by the server (possible minor, then non-consensual,
  // then the rest, newest first within each); "Load more" follows nextCursor.
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Only the latest load may write the list: switching the filter quickly
  // (Open -> Dismissed -> Open) used to let a slower earlier response land
  // last and show one status's rows under another status's label.
  const loadSeq = useRef(0);
  const load = async (status) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/reports?status=${encodeURIComponent(status)}`);
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load reports'));
      setReports(Array.isArray(data.reports) ? data.reports : []);
      setHasMore(!!data.hasMore && typeof data.nextCursor === 'string');
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    setError('');
    try {
      const { res, data } = await adminGet(
        adminKey,
        `/api/admin/reports?status=${encodeURIComponent(statusFilter)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      // The filter changed (or the list reloaded) meanwhile: drop this page.
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load more reports'));
      const more = Array.isArray(data.reports) ? data.reports : [];
      setReports((prev) => {
        const seen = new Set(prev.map((x) => String(x.id)));
        return [...prev, ...more.filter((x) => !seen.has(String(x.id)))];
      });
      setHasMore(!!data.hasMore && typeof data.nextCursor === 'string');
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoadingMore(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (r, action) => {
    const minorReport = r.category === 'minor';
    const serious = minorReport || r.category === 'non_consensual';
    let reason = null;
    if (action === 'remove_content') {
      const what = r.targetType === 'listing'
        ? (minorReport ? 'take this listing down and QUARANTINE its media as evidence (kept, never served)' : 'take this listing down (and delete its media, including files buyers paid for)')
        : r.targetType === 'message' ? 'delete this direct message'
          : r.targetType === 'gallery_item'
            ? (minorReport ? "remove this gallery item from the creator's profile and QUARANTINE the file as evidence (kept, never served)" : "remove this gallery item from the creator's profile and delete the file")
            : r.targetType === 'avatar'
              ? (minorReport ? "reset this creator's profile photo to the placeholder and QUARANTINE the file as evidence (kept, never served)" : "reset this creator's profile photo to the placeholder and delete the file")
              : 'delete this comment';
      const profileMedia = r.targetType === 'gallery_item' || r.targetType === 'avatar';
      const keep = serious && !profileMedia ? ' A copy of the text is kept on the report as evidence.' : '';
      const gone = r.target?.exists === false ? ' (It already looks deleted -- this records the report as actioned.)' : '';
      if (!confirm(`Remove the reported content? This will ${what}.${keep}${gone}`)) return;
    } else if (action === 'remove_and_ban') {
      // The possible-minor outcome Terms section 8 promises: the reported item
      // comes down AND the creator who posted it is banned permanently, every
      // file they have is quarantined as evidence, and ALL their listings come
      // down -- including files earlier buyers paid for. Irreversible here, so
      // asked twice. The server decides who the creator is from the stored
      // report (never this panel) and refuses with no_creator when a fan wrote it.
      if (!confirm(
        `Remove the reported content AND PERMANENTLY BAN the creator who posted it?\n\n`
        + 'Every file they have is quarantined as evidence (kept, never served), and ALL their listings are taken down, '
        + 'including files earlier buyers paid for. Only do this once you have checked the content.',
      )) return;
      if (!confirm(`Last check: ban the creator behind report #${r.id} permanently?`)) return;
    } else if (action === 'dismiss' && serious) {
      // The server refuses to dismiss these without a reason (400
      // reason_required); it is kept on the report and in its history.
      reason = window.prompt(
        `Dismiss this report filed as ${minorReport ? 'showing a POSSIBLE MINOR' : 'NON-CONSENSUAL content'}? The content stays up.\n\nWhy is it invalid? (kept on the report)`,
      );
      if (reason === null) return;
      if (!reason.trim()) {
        setError('A reason is required to dismiss this report. Nothing was changed.');
        return;
      }
    } else if (action === 'reopen') {
      reason = window.prompt(`Reopen report #${r.id}? It goes back into the open queue.\n\nWhy is it being reopened? (kept on the report)`);
      if (reason === null) return;
      if (!reason.trim()) {
        setError('A reason is required to reopen a report. Nothing was changed.');
        return;
      }
    }
    setBusyId(r.id);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/reports-resolve', {
        id: r.id,
        action,
        ...(reason !== null ? { reason: reason.trim() } : {}),
      });
      if (res.status === 400 && (data?.code === 'not_minor' || data?.code === 'no_creator')) {
        // Refused before anything was claimed or removed: the report is
        // untouched and still open.
        setError(`${errorFrom(res, data, 'That report cannot lead to a ban.')} Nothing was changed.`);
        return;
      }
      if (res.status === 409 && data?.code === 'no_creator') {
        setError(errorFrom(res, data, 'That creator account no longer exists -- the report is still open.'));
        await load(statusFilter);
        return;
      }
      if (res.status === 409 && data?.code === 'content_removed') {
        // An earlier Remove Content attempt already took the gallery item or
        // photo down (and stamped the report) but did not finish recording
        // it; the report is still open and cannot be dismissed as invalid.
        setError(`Report #${r.id} is still open: its content was already taken down by an earlier attempt, so it cannot be dismissed. Press "Remove Content" to finish recording it.`);
        await load(statusFilter);
        return;
      }
      if (res.status >= 500) {
        // Nothing was recorded as resolved; the report is still open and a
        // retry is safe. Re-read so the row shows anything an earlier part of
        // the attempt did take down (contentRemovedAt).
        setError(`${errorFrom(res, data, 'Something went wrong -- the report is still open.')} Retry when ready; it is safe to press the button again.`);
        await load(statusFilter);
        return;
      }
      if (res.status === 409) {
        // already_resolved: someone else (or another tab) resolved it first;
        // not_reopenable: it is no longer dismissed. Either way nothing was
        // changed -- re-read rather than keep a stale row.
        setError(errorFrom(res, data, 'That report was already resolved.'));
        await load(statusFilter);
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, action === 'reopen' ? 'Could not reopen that report' : 'Failed to resolve report'));
      if (action === 'reopen') {
        setNotice(`Report #${r.id} reopened and back in the open queue.`);
      } else if (action === 'remove_and_ban') {
        const n = Number(data.preserved) || 0;
        setNotice(
          `Report #${r.id} actioned -- ${data.content === 'already_gone' ? 'the reported item was already gone' : 'the content was removed'}, `
          + `creator #${String(data.bannedCreatorId ?? '?')} was banned permanently and their listings taken down`
          + `${n ? `, and ${n} file(s) quarantined as evidence (Evidence tab)` : ''}. `
          + 'Remember: report it to the NCMEC CyberTipline (report.cybertip.org), using the quarantined copy.',
        );
        if (data.bannedCreatorId != null && onCreatorBanned) {
          try { await onCreatorBanned(String(data.bannedCreatorId)); } catch { /* the roster refreshes on the next load */ }
        }
      } else if (action === 'remove_content') {
        setNotice(data.content === 'already_gone'
          ? `Report #${r.id} actioned -- the item was already gone.`
          : `Report #${r.id} actioned -- the content was removed${data.preserved ? ` and ${data.preserved} file(s) quarantined as evidence (Evidence tab)` : ''}.`);
      } else {
        setNotice(`Report #${r.id} dismissed.${reason !== null ? ' Reason recorded; it can be reopened from the Dismissed list.' : ''}`);
      }
      // Out of the Open list at once; any other view is re-read so the row
      // shows its new status and history.
      if (statusFilter === 'open') setReports((prev) => prev.filter((x) => String(x.id) !== String(r.id)));
      else await load(statusFilter);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const targetLabel = (r) => (r.targetType === 'wall_post' ? 'Wall comment'
    : r.targetType === 'listing' ? 'Marketplace listing'
      : r.targetType === 'message' ? 'Direct message'
        // targetId is the CREATOR id for these two (the item is named by src).
        : r.targetType === 'gallery_item' ? 'Gallery item on creator'
          : r.targetType === 'avatar' ? 'Profile photo of creator'
            : String(r.targetType ?? 'Unknown'));

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

      {notice && <p className="text-sm text-green-400 mb-4">{notice}</p>}
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
                <p className="text-xs font-bold text-brand-gold">
                  {targetLabel(r)} #{String(r.targetId ?? '')}
                  {REPORT_CATEGORY_LABELS[r.category] && (
                    <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full font-bold ${r.category === 'minor' ? 'bg-red-600 text-white' : r.category === 'non_consensual' ? 'bg-red-500/30 text-red-200' : 'bg-white/10 text-gray-300'}`}>
                      {REPORT_CATEGORY_LABELS[r.category]}
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-gray-600">{r.createdAt ? new Date(r.createdAt).toLocaleString() : ''}</p>
              </div>
              <p className="text-sm text-gray-300 mb-3"><span className="text-gray-500">Reason:</span> {String(r.reason ?? '')}</p>
              <ReportTarget report={r} />
              {r.removedContent && typeof r.removedContent === 'object' && (
                <div className="mb-3 px-3 py-2 rounded-md bg-red-900/10 border border-red-500/30 text-xs text-gray-300">
                  <p className="text-red-300 mb-1">
                    Evidence copy of the removed {r.removedContent.type === 'message' ? 'message' : 'comment'}
                    {r.removedContent.senderId || r.removedContent.authorId ? ` (by user #${String(r.removedContent.senderId || r.removedContent.authorId)})` : ''}
                    {r.removedContent.createdAt ? `, ${new Date(r.removedContent.createdAt).toLocaleString()}` : ''}:
                  </p>
                  <p className="whitespace-pre-wrap break-words">"{String(r.removedContent.text ?? '')}"</p>
                </div>
              )}
              {r.dismissReason && (
                <p className="text-xs text-gray-400 mb-2">Dismissal reason: {String(r.dismissReason)}</p>
              )}
              {Array.isArray(r.history) && r.history.length > 0 && (
                <ul className="mb-2 text-[11px] text-gray-500 space-y-0.5">
                  {r.history.map((h, i) => (
                    <li key={i}>
                      {h?.at ? new Date(h.at).toLocaleString() : ''} — {String(h?.action ?? '')} by {String(h?.by ?? 'admin')}
                      {h?.reason ? `: ${String(h.reason)}` : ''}
                    </li>
                  ))}
                </ul>
              )}
              {r.status === 'open' && r.contentRemovedAt && (
                <p className="text-[11px] text-yellow-300 mb-2">
                  The reported item was already taken down ({new Date(r.contentRemovedAt).toLocaleString()}{r.contentRemovedBy ? ` by ${String(r.contentRemovedBy)}` : ''}) but the report was not finished. Press "Remove Content" to record it; it can no longer be dismissed.
                </p>
              )}
              {r.status === 'open' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => resolve(r, 'dismiss')}
                    disabled={busyId === r.id || !!r.contentRemovedAt}
                    className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                  >
                    {r.category === 'minor' || r.category === 'non_consensual' ? 'Dismiss…' : 'Dismiss'}
                  </button>
                  {/* Enabled while the live item still exists OR a copy of it
                      was kept: a snapshot means the report is about something
                      real, and the server answers already_gone for the live
                      target and records the report as actioned. */}
                  <button
                    onClick={() => resolve(r, 'remove_content')}
                    disabled={busyId === r.id || (r.target?.exists === false && !r.target?.fromSnapshot)}
                    className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                  >
                    Remove Content
                  </button>
                  {/* Possible-minor reports only (the server refuses any
                      other with not_minor). It also answers no_creator when a
                      fan, not a creator, posted the comment or message. */}
                  {r.category === 'minor' && (
                    <button
                      onClick={() => resolve(r, 'remove_and_ban')}
                      disabled={busyId === r.id}
                      className="text-xs px-3 py-1.5 rounded-md border border-red-600 bg-red-600/20 text-red-200 font-bold hover:bg-red-600/40 transition disabled:opacity-50"
                    >
                      Remove &amp; ban creator…
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-3">
                  <p className="text-xs text-gray-500">
                    {String(r.status ?? '')} by {String(r.resolvedBy ?? 'admin')}
                    {r.resolvedAt ? `, ${new Date(r.resolvedAt).toLocaleString()}` : ''}
                    {r.contentOutcome ? ` (${r.contentOutcome === 'already_gone' ? 'item was already gone' : 'content removed'})` : ''}
                    {r.bannedCreatorId != null ? ` · creator #${String(r.bannedCreatorId)} banned` : ''}
                  </p>
                  {r.status === 'dismissed' && (
                    <button
                      onClick={() => resolve(r, 'reopen')}
                      disabled={busyId === r.id}
                      className="text-xs px-3 py-1.5 rounded-md border border-yellow-500/50 text-yellow-300 hover:bg-yellow-500/10 transition disabled:opacity-50"
                    >
                      Reopen
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!loading && hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-4 text-sm px-4 py-2 rounded-md border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50"
        >
          {loadingMore ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

// lib/reports-store.js REPORT_CATEGORIES. 'other' is shown without a badge.
const REPORT_CATEGORY_LABELS = {
  minor: 'POSSIBLE MINOR',
  non_consensual: 'NON-CONSENSUAL',
};

/**
 * What a report is actually about -- the comment text and whose wall, or the
 * listing's title, status and seller -- from the `target` the reports API
 * attaches (lib/reports-store.js attachReportTargets). Without it a moderator
 * pressed "Remove Content" on a bare "#123".
 */
function ReportTarget({ report }) {
  const t = report?.target;
  if (!t || (t.exists === false && !t.fromSnapshot)) {
    return <p className="text-xs text-gray-500 mb-3">The reported item no longer exists (already deleted), and no copy of it was kept.</p>;
  }
  // The live item is gone (its author deleted it, an account deletion, a
  // takedown) but the report carries the copy taken when it was filed.
  const snapNote = t.fromSnapshot ? (
    <p className="text-[10px] text-yellow-300 mb-1">
      The item itself no longer exists -- this is the copy kept on the report{report?.reportedContent ? ' when it was filed' : ''}.
    </p>
  ) : null;
  const seller = t.creatorName ? `${t.creatorName}${t.creatorHandle ? ` (${t.creatorHandle})` : ''}` : t.creatorId ? `creator #${t.creatorId}` : 'unknown creator';
  if (report.targetType === 'wall_post') {
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        {snapNote}
        <p className="text-gray-500 mb-1">
          Comment by {String(t.authorName ?? 'someone')}{t.authorId ? ` (user #${t.authorId}${t.authorLogin ? `, ${String(t.authorLogin)}` : ''})` : ''} on {seller}'s wall
          {t.createdAt ? `, ${new Date(t.createdAt).toLocaleString()}` : ''}:
        </p>
        <p className="whitespace-pre-wrap break-words">"{String(t.text ?? '')}"</p>
      </div>
    );
  }
  if (report.targetType === 'message') {
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        {snapNote}
        <p className="text-gray-500 mb-1">
          Direct message from user #{String(t.senderId ?? '?')}
          {t.senderLogin ? ` (${String(t.senderLogin)}${t.senderRole ? `, ${String(t.senderRole)}` : ''})` : ''}
          {t.createdAt ? `, ${new Date(t.createdAt).toLocaleString()}` : ''}
          {Array.isArray(t.participantIds) && t.participantIds.length ? ` · conversation between users ${t.participantIds.map(String).join(' and ')}` : ''}:
        </p>
        <p className="whitespace-pre-wrap break-words">"{String(t.text ?? '')}"</p>
      </div>
    );
  }
  if (report.targetType === 'gallery_item' || report.targetType === 'avatar') {
    // A reported photo/video on a creator's public profile. `target.media` is
    // the one item as it stands now (or the filing-time copy); for a
    // POSSIBLE MINOR report the file has been on hold since filing, and
    // "Remove Content" quarantines it rather than deleting it.
    const items = Array.isArray(t.media) ? t.media : [];
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        {snapNote}
        <p className="text-gray-500 mb-1">
          {report.targetType === 'avatar' ? 'Profile photo' : 'Gallery item'} on {seller}'s profile
          {report.src ? <span className="block font-mono text-[10px] text-gray-600 break-all">{String(report.src)}</span> : null}
        </p>
        {items.length > 0 ? (
          <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 gap-2">
            {items.map((m, i) => (
              <div key={`${String(m?.src)}-${i}`} className="relative aspect-square rounded overflow-hidden border border-white/10 bg-black/40">
                {m?.type === 'video' ? (
                  <video src={String(m.src)} className="w-full h-full object-cover" controls preload="metadata" />
                ) : (
                  <img src={String(m?.src || '')} alt="" className="w-full h-full object-cover" />
                )}
                {m?.aiGenerated && (
                  <span className="absolute bottom-1 left-1 text-[9px] px-1.5 py-0.5 rounded bg-black/70 text-brand-gold font-bold">AI</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-500">No copy of the file is available.</p>
        )}
      </div>
    );
  }
  if (report.targetType === 'listing') {
    return (
      <div className="mb-3 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-xs text-gray-300">
        {snapNote}
        <p className="font-bold text-white">{String(t.title ?? '(untitled)')}</p>
        <p className="text-gray-500 mb-1">
          by {seller} · {String(t.status ?? '')} · {String(t.kind ?? '')}
          {Number.isFinite(Number(t.priceCents)) ? ` · ${dollars(t.priceCents)}` : ''} · {Number(t.mediaCount) || (Array.isArray(t.media) ? t.media.length : 0)} media item(s)
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
  // Order shipping fields (pages/api/marketplace/orders/ship.js): an app named
  // as the carrier, or a tracking number shaped like a phone number / handle.
  order_carrier: 'Order carrier',
  order_tracking_shape: 'Order tracking number (phone/handle shape)',
  // Logged by the round-14 free-text screening, before the fixed carrier list.
  order_tracking_number: 'Order tracking number',
  order_tracking: 'Order tracking details',
};

/** Auto-flagged, blocked sends -- see lib/payment-circumvention-filter.js. The flagged message/post itself was never stored, only this record of who tried and why. */
function ViolationsPanel({ adminKey }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  // Only the latest load may write the list: switching the filter quickly
  // (Open -> Dismissed -> Open) used to let a slower earlier response land
  // last and show one status's rows under another status's label.
  const loadSeq = useRef(0);
  const load = async (status) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/violations?status=${encodeURIComponent(status)}`);
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load violations'));
      setViolations(Array.isArray(data.violations) ? data.violations : []);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  const resolve = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/violations-resolve', { id, action });
      if (res.status === 409) {
        // Someone else resolved it first; the first decision stands. Re-read
        // rather than keep a stale row that looks still open.
        setError(errorFrom(res, data, 'That violation was already resolved.'));
        await load(statusFilter);
        return;
      }
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
const NCII_CATEGORY_LABELS = {
  self: 'Filed by the person shown',
  third_party: 'Filed by someone else',
  minor: 'POSSIBLE MINOR',
};

/**
 * What the enforcement ladder actually did, read from the creator record the
 * resolve returned (lib/creators-store.js applyContentViolation) and the
 * roster copy from before it -- never assumed. A pending applicant stays
 * pending (never suspended), a creator already banned stays banned, and the
 * count is the real one, not "1st"/"2nd" inferred from the status.
 */
function ladderOutcome(after, before) {
  const n = Number(after?.contentViolationCount) || 0;
  const name = after?.name || `Creator #${after?.id}`;
  const status = effectiveCreatorStatus(after);
  const wasBanned = !!before && effectiveCreatorStatus(before) === 'banned';
  const count = `${n} confirmed violation${n === 1 ? '' : 's'} on record`;
  if (status === 'pending') {
    return `Violation recorded against ${name} (${count}). They remain a PENDING applicant -- not suspended -- and must not be approved without review.`;
  }
  if (status === 'suspended') {
    const until = after.suspendedUntil ? new Date(after.suspendedUntil).toLocaleDateString() : 'further notice';
    return `${name} suspended until ${until} (${count}).`;
  }
  if (status === 'banned') {
    return wasBanned
      ? `${name} was already banned; the violation is recorded (${count}).`
      : `${name} has been permanently banned (${count}).`;
  }
  return `Violation recorded against ${name} (${count}); account status is now ${status || 'unknown'}.`;
}

function NciiReportsPanel({ adminKey, creators, onSummary, onCreatorChanged, alertsConfigured }) {
  const [statusFilter, setStatusFilter] = useState('open');
  const [reports, setReports] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [attributed, setAttributed] = useState({});
  // Per request: the admin's explicit "the content is already gone / was
  // removed elsewhere" acknowledgement (sent as contentGone).
  const [goneAck, setGoneAck] = useState({});

  // Only the latest load may write the list: switching the filter quickly
  // (Open -> Dismissed -> Open) used to let a slower earlier response land
  // last and show one status's rows under another status's label.
  const loadSeq = useRef(0);
  // Which filter the rows in `reports` belong to (null before the first load
  // lands). Set wherever the list is written. The filter VALUE alone is not
  // enough (round-16 admin-ui#0): after Open -> Dismissed -> Open, `reports`
  // still holds the Dismissed rows until the new Open load lands.
  const rowsFilterRef = useRef(null);
  // The list is paged by the server (possible-minor first, then oldest
  // first); "Load more" follows nextCursor.
  const [nextCursor, setNextCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const load = async (status) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadingMore(false);
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/ncii-reports?status=${encodeURIComponent(status)}`);
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load takedown requests'));
      rowsFilterRef.current = status;
      setReports(Array.isArray(data.reports) ? data.reports : []);
      setHasMore(!!data.hasMore && typeof data.nextCursor === 'string');
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      if (data.summary) {
        setSummary(data.summary);
        if (onSummary) onSummary(data.summary);
      }
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    const seq = loadSeq.current;
    setLoadingMore(true);
    setError('');
    try {
      const { res, data } = await adminGet(
        adminKey,
        `/api/admin/ncii-reports?status=${encodeURIComponent(statusFilter)}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      // The filter changed (or the list reloaded) meanwhile: this page
      // belongs to a list that is no longer on screen.
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to load more takedown requests'));
      const more = Array.isArray(data.reports) ? data.reports : [];
      rowsFilterRef.current = statusFilter;
      setReports((prev) => {
        const seen = new Set(prev.map((x) => String(x.id)));
        return [...prev, ...more.filter((x) => !seen.has(String(x.id)))];
      });
      setHasMore(!!data.hasMore && typeof data.nextCursor === 'string');
      setNextCursor(typeof data.nextCursor === 'string' ? data.nextCursor : null);
      if (data.summary) {
        setSummary(data.summary);
        if (onSummary) onSummary(data.summary);
      }
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoadingMore(false);
    }
  };

  useEffect(() => { load(statusFilter); }, [statusFilter]);

  // After a takedown, resolve or reopen, only the affected request changes.
  // Reloading page 1 (what every action used to do) dropped any request the
  // admin had reached with "Load more" -- and unmounted its "Take down
  // content" control, losing the opened thread -- mid-work, with the 48-hour
  // clock running (round-14 admin-ui#1). These keep the loaded depth instead.
  const reportsRef = useRef(reports);
  reportsRef.current = reports;
  // The filter on screen NOW. An action's refresh/patch runs from the render
  // in which it was clicked, so its own `statusFilter` is the filter it
  // started under; if the admin has switched filters since, load() for the new
  // filter owns the list and the action must not touch it (round-15
  // admin-ui#0: it used to void that load -- leaving 'Loading...' forever --
  // or show the old filter's rows under the new filter's label). Also set in
  // the <select>'s onChange so it is current before the next render.
  const statusFilterRef = useRef(statusFilter);
  statusFilterRef.current = statusFilter;
  const refreshSummary = async () => {
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/ncii-summary');
      if (res.ok && data?.summary) {
        setSummary(data.summary);
        if (onSummary) onSummary(data.summary);
      }
    } catch { /* the badge's own poll catches up */ }
  };
  // Re-read the queue from the top down until every request on screen now is
  // back in the list, without the Loading state (which would unmount every
  // row's takedown control). Rows keep their keys, so their controls stay
  // mounted. Depth is kept by ID, not by row count (round-15 admin-ui#1): a
  // new possible-minor filing sorts to the top and pushes every row down one,
  // so "as many rows as before" could stop one short and drop the request
  // being worked on. A request that has left the filter (resolved elsewhere,
  // or `dropId`) never comes back, so the loop still ends on the last page or
  // the page cap.
  //
  // While a refresh runs, `refreshingSeq` holds its sequence number, so a
  // patchReport that has to void it (to keep a stale refresh from overwriting
  // its patch) knows to run it again rather than drop it (round-16
  // admin-ui#1: a takedown's refresh used to be discarded by another row's
  // dismiss, leaving the taken-down row without its recorded takedown).
  const refreshingSeq = useRef(null);
  const refreshKeepingDepth = async ({ dropId = null } = {}) => {
    const status = statusFilter;
    if (status !== statusFilterRef.current) { await refreshSummary(); return; }
    if (rowsFilterRef.current !== status) {
      // The filter was switched away and back: the rows on screen belong to
      // another filter (or to none yet) and this filter's own load is still
      // pending (round-16 admin-ui#0). Their ids say nothing about this
      // filter's depth, so do not page for them or show them under this
      // label; re-issue this filter's load instead -- the one in flight may
      // have been answered before this action committed.
      await load(status);
      return;
    }
    const seq = ++loadSeq.current;
    refreshingSeq.current = seq;
    // Taking the sequence voids any load in flight, whose finally will then
    // not clear the Loading state: this refresh owns it now.
    setLoading(false);
    setLoadingMore(false);
    const want = new Set(reportsRef.current.map((r) => String(r.id)));
    if (dropId !== null && dropId !== undefined) want.delete(String(dropId));
    try {
      const rows = [];
      const seen = new Set();
      let cursor = null;
      let more = false;
      let summaryOut = null;
      for (let i = 0; i < 40; i += 1) {
        const { res, data } = await adminGet(
          adminKey,
          `/api/admin/ncii-reports?status=${encodeURIComponent(status)}&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        if (seq !== loadSeq.current) return;
        if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to refresh takedown requests'));
        for (const r of Array.isArray(data.reports) ? data.reports : []) {
          if (!seen.has(String(r.id))) { seen.add(String(r.id)); rows.push(r); }
          want.delete(String(r.id));
        }
        if (data.summary) summaryOut = data.summary;
        more = !!data.hasMore && typeof data.nextCursor === 'string';
        cursor = more ? data.nextCursor : null;
        if (!more || want.size === 0) break;
      }
      setReports(rows);
      setHasMore(more);
      setNextCursor(cursor);
      if (summaryOut) {
        setSummary(summaryOut);
        if (onSummary) onSummary(summaryOut);
      }
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (refreshingSeq.current === seq) refreshingSeq.current = null;
    }
  };
  // Patch one request in place from the server's copy (the resolve/reopen
  // response): kept if it still matches the filter, dropped if it no longer
  // does. Any list load still in flight is voided so it cannot overwrite this;
  // a refreshKeepingDepth voided that way is run again afterwards, since it
  // was carrying another action's result (round-16 admin-ui#1).
  const patchReport = async (fresh) => {
    // Started under another filter than the one on screen: the new filter's
    // own load owns the list (admin-ui#0). Only the summary is refreshed.
    if (statusFilter !== statusFilterRef.current) { await refreshSummary(); return; }
    // The rows on screen belong to another filter (switched away and back
    // while this filter's load is pending): re-issue that load rather than
    // patch foreign rows (round-16 admin-ui#0).
    if (rowsFilterRef.current !== statusFilter) { await load(statusFilter); return; }
    if (!fresh || fresh.id === undefined || fresh.id === null) { await refreshKeepingDepth(); return; }
    const refreshWasRunning = refreshingSeq.current !== null;
    refreshingSeq.current = null;
    loadSeq.current += 1;
    setLoading(false);
    setLoadingMore(false);
    const keep = statusFilter === 'all' || fresh.status === statusFilter;
    setReports((prev) => (keep
      ? prev.map((x) => (String(x.id) === String(fresh.id) ? { ...x, ...fresh } : x))
      : prev.filter((x) => String(x.id) !== String(fresh.id))));
    if (refreshWasRunning) {
      // reportsRef has not seen the patch yet (no render in between), so a
      // request this patch dropped is excluded from the depth explicitly.
      await refreshKeepingDepth(keep ? {} : { dropId: fresh.id });
      return;
    }
    await refreshSummary();
  };

  // action 'removed_ban' (possible-minor reports) is sent as 'removed'. The
  // server reads the report's stored category and, for a POSSIBLE MINOR
  // report attributed to a creator, bans them outright in the resolve's own
  // transaction and takes down ALL their listings, paid ones included
  // (lib/ncii-reports-store.js resolveNciiReport). One request: there is no
  // second ban call from here that could half-fail.
  const resolve = async (id, action) => {
    const creatorId = attributed[id] || null;
    const banAfter = action === 'removed_ban';
    const apiAction = banAfter ? 'removed' : action;
    const before = creatorId ? (creators || []).find((c) => String(c.id) === String(creatorId)) : null;
    let reason = null;
    const report = reports.find((x) => String(x.id) === String(id));
    if (action === 'dismiss') {
      // Dismissing takes a legally clocked request out of the open queue, and
      // it sits one tap from the removal buttons: confirm it (more strongly
      // for a possible minor) and require a reason, which is kept on the
      // report. A mistaken dismissal can be reopened from the Dismissed list.
      const minorReport = report?.category === 'minor';
      reason = window.prompt(
        minorReport
          ? `DISMISS report #${id}, which was filed as showing a POSSIBLE MINOR?\n\nOnly do this if you have checked the content and it does not show a minor (or does not exist here). The content stays up and nobody is banned.\n\nWhy is it invalid? (kept on the report)`
          : `Dismiss takedown request #${id} as invalid? The content stays up.\n\nWhy is it invalid? (kept on the report)`,
      );
      if (reason === null) return;
      if (!reason.trim()) {
        setError('A reason is required to dismiss a takedown request. Nothing was changed.');
        return;
      }
      if (minorReport && !confirm(`Last check: dismiss the POSSIBLE MINOR report #${id} with the reason "${reason.trim()}"?`)) return;
    }
    // 'removed' is only recorded when the removal is on file: a takedown
    // recorded against this request (the "Take down content" control, or a
    // gallery/avatar removal attributed to it), the attributed creator being
    // banned by this resolve, or the admin ticking "already gone / removed
    // elsewhere" -- the server refuses otherwise (409 takedown_required).
    // Only takedowns that actually removed something count: an entry whose
    // result is 'already_gone' (e.g. a mistyped id that found nothing) says
    // nothing about the reported content, and the server ignores it too.
    const takedownCount = removedTakedownCount(report);
    const contentGone = !!goneAck[id];
    const basisNote = takedownCount
      ? ` ${takedownCount} takedown(s) that removed content are recorded on this request.`
      : contentGone
        ? ' You confirmed the content is already gone or was removed elsewhere; that is recorded on the request.'
        : '';
    if (banAfter) {
      const banNote = creatorId
        ? ' The selected creator will be PERMANENTLY BANNED and all their listings taken down, including files earlier buyers paid for (their files are quarantined as evidence).'
        : ' No creator selected -- nobody is banned. If a creator posted it, pick them first.';
      if (!confirm(
        `Resolve request #${id} as removed?${basisNote}${banNote}\n\n`
        + 'Content that shows a minor must also be reported to the NCMEC CyberTipline (report.cybertip.org). '
        + 'Use the quarantined copy (Evidence tab) for that report; do not share it.',
      )) return;
    } else if (action === 'removed') {
      const violationNote = creatorId
        ? ' This will also count as a confirmed content violation against the selected creator (30-day suspension on the 1st, permanent ban on the 2nd; a pending applicant stays pending).'
        : ' No creator selected -- this will be logged as removed without counting toward any account\'s violation record.';
      if (!confirm(`Resolve request #${id} as removed?${basisNote}${violationNote}`)) return;
    }
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/ncii-reports-resolve', {
        id,
        action: apiAction,
        creatorId: apiAction === 'removed' ? creatorId : null,
        ...(apiAction === 'removed' && contentGone ? { contentGone: true } : {}),
        ...(reason !== null ? { reason: reason.trim() } : {}),
      });
      if (res.status === 409 && data?.code === 'takedown_required') {
        // Nothing was changed: no removal is on file for this request.
        setError(`Request #${id} is still open: nothing records the content as removed. Take it down with "Take down content" below, remove the gallery item or photo from the creator's record with this request number, or tick "already gone / removed elsewhere" if it really is.`);
        return;
      }
      if (res.status === 409) {
        // Someone else resolved it first -- re-read rather than keep a stale row.
        setNotice(errorFrom(res, data, 'That report was already resolved.'));
        await refreshKeepingDepth({ dropId: id });
        return;
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Failed to resolve report'));
      const basis = { takedown: 'a recorded takedown', ban: 'the creator\'s ban', acknowledged: 'your confirmation that it was already gone' }[data.report?.removalBasis];
      const messages = [action === 'dismiss'
        ? `Report #${id} dismissed (reason recorded). It can be reopened from the Dismissed list.`
        : `Report #${id} resolved as removed${basis ? `, on the basis of ${basis}` : ''}.`];
      const creator = data.creator || null;
      if (creator) {
        if (onCreatorChanged) onCreatorChanged(creator);
        messages.push(ladderOutcome(creator, before));
      }
      if (banAfter && creator && !data.outrightBan && effectiveCreatorStatus(creator) !== 'banned') {
        // Only reachable if the stored report is not a possible-minor filing
        // (the button is shown for those only) -- say so rather than imply a ban.
        setError('The report is resolved, but the server did not treat it as a possible-minor report, so no outright ban was applied. Ban the creator from their record in the Creators tab if needed.');
      }
      if (banAfter) messages.push('Remember: report it to the NCMEC CyberTipline (report.cybertip.org).');
      setNotice(messages.join(' '));
      // A ban (ladder or possible-minor) and its listing takedown run inside
      // the resolve's own transaction (lib/ncii-reports-store.js
      // resolveNciiReport); a failure rolls the whole resolve back and the
      // report stays open to retry. There is no after-commit takedown warning.
      await patchReport(data.report);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // A dismissed request back into the open queue (a mistaken dismissal). Its
  // 48-hour clock still counts from the original filing.
  const reopen = async (r) => {
    const reason = window.prompt(`Reopen takedown request #${r.id}? It goes back into the open queue; its 48-hour clock still counts from when it was filed.\n\nWhy is it being reopened? (kept on the report)`);
    if (reason === null) return;
    if (!reason.trim()) { setError('A reason is required to reopen a request.'); return; }
    setBusyId(r.id);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/ncii-reports-resolve', { id: r.id, action: 'reopen', reason: reason.trim() });
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not reopen that request'));
      setNotice(`Report #${r.id} reopened and back in the open queue.`);
      await patchReport(data.report);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const hoursOpen = (r) => Math.floor((Date.now() - new Date(r.createdAt).getTime()) / (1000 * 60 * 60));
  // Possible-minor reports first; otherwise the server's oldest-first order.
  const ordered = [...reports].sort((a, b) => (b.category === 'minor') - (a.category === 'minor'));
  const openCount = Number(summary?.open) || 0;
  const oldestHours = summary?.oldestOpenCreatedAt
    ? Math.floor((Date.now() - new Date(summary.oldestOpenCreatedAt).getTime()) / (1000 * 60 * 60))
    : null;

  return (
    <div>
      <p className="text-xs text-gray-500 mb-4">
        Filed via /report-content, no login required. Legally required to be reviewed and, if valid, the content
        removed within 48 hours of submission. Reports of a POSSIBLE MINOR are listed first: confirmed ones are
        removed, the creator is banned outright (not the 30-day ladder), and the content is reported to the NCMEC
        CyberTipline.
      </p>
      {alertsConfigured === false && (
        <p className="text-xs text-red-300 mb-4">
          New filings alert nobody: NCII_ALERT_WEBHOOK_URL is not set in production. Until it is, check this tab at
          least daily.
        </p>
      )}
      {summary && (
        <p className={`text-sm font-bold mb-4 ${openCount === 0 ? 'text-gray-500' : oldestHours !== null && oldestHours >= 36 ? 'text-red-400' : 'text-yellow-400'}`}>
          {openCount === 0
            ? 'No open takedown requests.'
            : `${openCount} open${Number(summary.openMinor) > 0 ? ` (${Number(summary.openMinor)} possible minor)` : ''}${oldestHours !== null ? ` -- oldest filed ${oldestHours}h ago${oldestHours >= 48 ? ' (OVERDUE)' : ''}` : ''}.`}
        </p>
      )}
      {notice && <p className="text-sm text-green-400 mb-4">{notice}</p>}
      <div className="flex items-center gap-3 mb-4">
        {/* Not while a resolve/reopen is in flight (its result belongs to this
            filter's list); a takedown in flight is covered by the
            statusFilterRef check instead. */}
        <select
          value={statusFilter}
          onChange={(e) => { statusFilterRef.current = e.target.value; setStatusFilter(e.target.value); }}
          disabled={busyId !== null}
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm disabled:opacity-50"
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
          {ordered.map((r) => {
            const hrs = hoursOpen(r);
            const minor = r.category === 'minor';
            const overdue = r.status === 'open' && hrs >= 48;
            const dueSoon = r.status === 'open' && hrs >= 36 && hrs < 48;
            return (
              <div key={r.id} className={`premium-card border p-4 ${overdue || (minor && r.status === 'open') ? 'border-red-500' : dueSoon ? 'border-yellow-500/60' : 'border-brand-purple/20'}`}>
                <div className="flex items-center justify-between mb-1">
                  <p className="text-xs font-bold text-brand-gold">
                    Report #{String(r.id)} — {String(r.reporterName ?? '')}
                    <span className={`ml-2 text-[10px] px-2 py-0.5 rounded-full font-bold ${minor ? 'bg-red-600 text-white' : 'bg-white/10 text-gray-300'}`}>
                      {NCII_CATEGORY_LABELS[r.category] || NCII_CATEGORY_LABELS.self}
                    </span>
                  </p>
                  <p className={`text-[10px] font-bold ${overdue ? 'text-red-400' : dueSoon ? 'text-yellow-400' : 'text-gray-600'}`}>
                    {r.status === 'open' ? `${hrs}h open${overdue ? ' — OVERDUE (48h)' : ''}` : `${r.status} by ${r.resolvedBy}`}
                  </p>
                </div>
                <p className="text-xs text-gray-500 mb-1">Contact: {String(r.reporterContact ?? '')}</p>
                <p className="text-sm text-gray-300 mb-1 whitespace-pre-wrap break-words"><span className="text-gray-500">Content:</span> {String(r.contentLocation ?? '')}</p>
                {r.description && <p className="text-sm text-gray-400 mb-3 whitespace-pre-wrap break-words">{String(r.description)}</p>}
                {r.status === 'dismiss' && (
                  <div className="mb-2 flex flex-wrap items-center gap-3">
                    <p className="text-xs text-gray-400">
                      Dismissed{r.resolvedAt ? ` ${new Date(r.resolvedAt).toLocaleString()}` : ''}
                      {r.dismissReason ? ` — reason: ${String(r.dismissReason)}` : ' — no reason was recorded'}
                    </p>
                    <button
                      onClick={() => reopen(r)}
                      disabled={busyId === r.id}
                      className="text-xs px-3 py-1.5 rounded-md border border-yellow-500/50 text-yellow-300 hover:bg-yellow-500/10 transition disabled:opacity-50"
                    >
                      Reopen
                    </button>
                  </div>
                )}
                {Array.isArray(r.history) && r.history.length > 0 && (
                  <ul className="mb-2 text-[11px] text-gray-500 space-y-0.5">
                    {r.history.map((h, i) => (
                      <li key={i}>
                        {h?.at ? new Date(h.at).toLocaleString() : ''} — {String(h?.action ?? '')} by {String(h?.by ?? 'admin')}
                        {h?.reason ? `: ${String(h.reason)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
                {Array.isArray(r.preservedMedia) && r.preservedMedia.length > 0 && (
                  <p className="mb-2 text-[11px] text-red-300">{r.preservedMedia.length} file(s) quarantined as evidence for this report (Evidence tab).</p>
                )}
                <TakedownList report={r} />
                {r.status === 'removed' && r.removalBasis && (
                  <p className="mb-2 text-[11px] text-gray-400">
                    Recorded as removed on the basis of {r.removalBasis === 'takedown' ? 'a recorded takedown' : r.removalBasis === 'ban' ? 'the creator\'s ban' : r.removalBasis === 'acknowledged' ? 'the admin\'s confirmation that it was already gone or removed elsewhere' : String(r.removalBasis)}.
                  </p>
                )}
                {r.status === 'open' && (
                  <>
                    <TakedownControl
                      adminKey={adminKey}
                      creators={creators}
                      report={r}
                      disabled={busyId === r.id}
                      onDone={async (msg) => { setError(''); setNotice(msg); await refreshKeepingDepth(); }}
                      onError={(msg) => { setNotice(''); setError(msg); }}
                    />
                    <div className="mb-2">
                      <label className="block text-[10px] text-gray-500 mb-1">
                        {minor
                          ? 'Which creator posted this? (attributing it bans them outright on "Remove & ban")'
                          : 'Which creator posted this? (attributing it applies the violation ladder on resolve)'}
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
                    {!removedTakedownCount(r) && (
                      <label className="flex items-start gap-2 text-[11px] text-gray-400 mt-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!goneAck[r.id]}
                          onChange={(e) => setGoneAck({ ...goneAck, [r.id]: e.target.checked })}
                          className="mt-0.5"
                        />
                        <span>
                          The content is already gone, or was removed some other way (it is not on this site any more).
                          Only tick this after checking -- it is recorded on the request as the basis for "removed".
                        </span>
                      </label>
                    )}
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={() => resolve(r.id, 'dismiss')}
                        disabled={busyId === r.id}
                        className="text-xs px-3 py-1.5 rounded-md border border-brand-purple/30 text-gray-300 hover:bg-white/5 transition disabled:opacity-50"
                      >
                        Dismiss (invalid)…
                      </button>
                      {minor ? (
                        <button
                          onClick={() => resolve(r.id, 'removed_ban')}
                          disabled={busyId === r.id}
                          className="text-xs px-3 py-1.5 rounded-md border border-red-500 bg-red-600/20 text-red-300 hover:bg-red-600/30 transition disabled:opacity-50"
                        >
                          Remove &amp; ban creator
                        </button>
                      ) : (
                        <button
                          onClick={() => resolve(r.id, 'removed')}
                          disabled={busyId === r.id}
                          className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50"
                        >
                          Mark Removed & Resolve
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!loading && hasMore && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="mt-4 text-sm px-4 py-2 rounded-md border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50"
        >
          {loadingMore ? 'Loading...' : 'Load more'}
        </button>
      )}
    </div>
  );
}

const TAKEDOWN_TYPE_LABELS = {
  listing: 'Marketplace listing',
  message: 'Direct message',
  wall_post: 'Wall comment',
  gallery_item: 'Gallery item',
  avatar: 'Profile photo',
};

// Takedowns on a request that actually removed something (result 'removed').
// Mirrors lib/ncii-reports-store.js resolveNciiReport: only these count as the
// basis for resolving a request as 'removed'.
function removedTakedownCount(report) {
  const list = Array.isArray(report?.takedowns) ? report.takedowns : [];
  return list.filter((t) => t && t.result === 'removed').length;
}

function takedownTargetText(t) {
  const target = t?.target && typeof t.target === 'object' ? t.target : {};
  if (t?.type === 'listing') return `listing #${String(target.listingId ?? '?')}`;
  if (t?.type === 'wall_post') return `comment #${String(target.postId ?? '?')}`;
  if (t?.type === 'message') return `message ${String(target.messageId ?? '?')} in conversation ${String(target.conversationId ?? '?')}`;
  if (t?.type === 'gallery_item' || t?.type === 'avatar') return `creator #${String(target.creatorId ?? '?')}`;
  return '';
}

/**
 * The specific items taken down against a takedown request (report.takedowns,
 * written by /api/admin/content-takedown and by gallery/avatar removals
 * attributed to the request), with the copy kept of each text item.
 */
function TakedownList({ report }) {
  const list = Array.isArray(report?.takedowns) ? report.takedowns : [];
  if (!list.length) return null;
  return (
    <div className="mb-2 px-3 py-2 rounded-md bg-black/30 border border-white/10 text-[11px] text-gray-300">
      <p className="text-gray-400 mb-1">Taken down for this request:</p>
      <ul className="space-y-1">
        {list.map((t, i) => {
          const snap = t?.snapshot && typeof t.snapshot === 'object' ? t.snapshot : null;
          return (
            <li key={i}>
              {t?.at ? `${new Date(t.at).toLocaleString()} — ` : ''}
              {TAKEDOWN_TYPE_LABELS[t?.type] || String(t?.type ?? 'item')} {takedownTargetText(t)}:{' '}
              <span className={t?.result === 'removed' ? 'text-red-300' : 'text-gray-500'}>
                {t?.result === 'removed' ? 'removed' : t?.result === 'already_gone' ? 'was already gone' : String(t?.result ?? '')}
              </span>
              {Number(t?.preserved) > 0 ? ` · ${Number(t.preserved)} file(s) quarantined` : ''}
              {snap && (snap.text || snap.title) ? (
                <span className="block text-gray-500 whitespace-pre-wrap break-words">
                  Copy kept: "{String(snap.title ?? snap.text ?? '')}"
                  {snap.senderLogin || snap.authorLogin ? ` (by ${String(snap.senderLogin || snap.authorLogin)})` : ''}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const TAKEDOWN_ID_RE = /^[1-9][0-9]{0,17}$/;

// How the content lookup (GET /api/admin/content-lookup) names an account.
function lookupAccountLabel(a) {
  if (!a) return 'unknown account';
  if (a.deleted) return `deleted account ${String(a.userId)}`;
  const creator = a.creatorName ? `${String(a.creatorName)}${a.creatorHandle ? ` (${String(a.creatorHandle)})` : ''} — ` : '';
  return `${creator}${a.login ? String(a.login) : '(no login)'} · user ${String(a.userId)}${a.role ? ` · ${String(a.role)}` : ''}`;
}

/**
 * "Take down content": removes one listing, direct message or wall comment
 * (POST /api/admin/content-takedown). Inside an open TAKE IT DOWN request it
 * is recorded against that request (nciiReportId) so the request can be
 * resolved as removed. With no `report` (the standalone section in ACCOUNTS
 * and the creator editor) it takes down something an admin found themselves
 * -- no report or takedown request needed, and none is invented: the item is
 * still copied and the takedown written to the audit trail. A listing comes down
 * WITH the files buyers paid for. For a POSSIBLE MINOR request the files are
 * always quarantined as evidence first (the server forces it too); for any
 * other request the admin may choose to. Gallery items and profile photos are
 * removed from the creator's record (Creators tab) with this request number.
 *
 * A DM or wall comment is FOUND here rather than typed in: message ids exist
 * only in the two participants' inboxes and comment ids are shown nowhere, so
 * the control lists a creator's wall comments, or an account's conversations
 * and then a thread's messages (GET /api/admin/content-lookup), each with its
 * own Take down button. A creator's marketplace listings are listed the same
 * way (kind=listings). The raw-id inputs stay as a fallback.
 */
function TakedownControl({ adminKey, creators, report = null, initialCreatorId = '', disabled, onDone, onError }) {
  const minor = report?.category === 'minor';
  // Every string that names the request; empty in standalone mode.
  const forReq = report ? ` for request #${String(report.id)}` : '';
  const [type, setType] = useState('listing');
  // Listing lookup: a creator's listings, each with its own Take down.
  const [listingCreatorId, setListingCreatorId] = useState(initialCreatorId ? String(initialCreatorId) : '');
  const [listings, setListings] = useState(null); // { creatorId, listings }
  const [listingId, setListingId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [messageId, setMessageId] = useState('');
  const [postId, setPostId] = useState('');
  const [preserve, setPreserve] = useState(false);
  const [busy, setBusy] = useState(false);

  // Wall-comment lookup.
  const [wallCreatorId, setWallCreatorId] = useState(initialCreatorId ? String(initialCreatorId) : '');
  const [wall, setWall] = useState(null); // { creatorId, posts, nextBefore }
  // DM lookup: by email/username, user id or creator -> conversations -> thread.
  const [dmBy, setDmBy] = useState('login');
  const [dmWho, setDmWho] = useState('');
  const [dmCreatorId, setDmCreatorId] = useState(initialCreatorId ? String(initialCreatorId) : '');
  const [convos, setConvos] = useState(null); // { params, account, conversations, nextCursor }
  const [thread, setThread] = useState(null); // { id, participants, messages }
  const [lookupBusy, setLookupBusy] = useState(false);

  const lookup = async (params) => {
    const qs = new URLSearchParams(params).toString();
    const { res, data } = await adminGet(adminKey, `/api/admin/content-lookup?${qs}`);
    if (!res.ok) throw new Error(errorFrom(res, data, 'Lookup failed'));
    return data;
  };

  const loadWall = async (more = false) => {
    const cid = more ? wall?.creatorId : wallCreatorId;
    if (!cid) { onError('Pick the creator whose wall the comment is on.'); return; }
    setLookupBusy(true);
    try {
      const data = await lookup({ kind: 'wall', creatorId: String(cid), ...(more && wall?.nextBefore ? { before: wall.nextBefore } : {}) });
      const posts = Array.isArray(data.posts) ? data.posts : [];
      setWall({ creatorId: String(cid), posts: more ? [...(wall?.posts || []), ...posts] : posts, nextBefore: data.nextBefore || null });
    } catch (err) {
      onError(err.message);
    } finally {
      setLookupBusy(false);
    }
  };

  const loadListings = async () => {
    const cid = listingCreatorId;
    if (!cid) { onError('Pick the creator whose listing it is.'); return; }
    setLookupBusy(true);
    try {
      const data = await lookup({ kind: 'listings', creatorId: String(cid) });
      setListings({ creatorId: String(cid), listings: Array.isArray(data.listings) ? data.listings : [] });
    } catch (err) {
      onError(err.message);
    } finally {
      setLookupBusy(false);
    }
  };

  const loadConvos = async (more = false) => {
    let params;
    if (more) params = convos?.params;
    else if (dmBy === 'creator') params = dmCreatorId ? { creatorId: dmCreatorId } : null;
    else if (dmWho.trim()) params = dmBy === 'id' ? { userId: dmWho.trim() } : { login: dmWho.trim() };
    if (!params) { onError(dmBy === 'creator' ? 'Pick the creator.' : 'Enter the email / username or user id of one side of the conversation.'); return; }
    setLookupBusy(true);
    try {
      // Keyset-paged (round-14 social#1): OFFSET paging over updated_at
      // repeated a row and skipped the conversation that just got a new
      // message whenever someone wrote while the admin paged. Appends are
      // de-duplicated by id as well. A conversation that moved to the top
      // after page 1 loaded still needs "Find conversations" again, which
      // the list says.
      const data = await lookup({ kind: 'conversations', ...params, ...(more && convos?.nextCursor ? { cursor: String(convos.nextCursor) } : {}) });
      const list = Array.isArray(data.conversations) ? data.conversations : [];
      const merged = more ? [...(convos?.conversations || [])] : [];
      const seen = new Set(merged.map((c) => String(c.id)));
      for (const c of list) {
        if (!seen.has(String(c.id))) { seen.add(String(c.id)); merged.push(c); }
      }
      setConvos({ params, account: data.account || null, conversations: merged, nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null });
      if (!more) setThread(null);
    } catch (err) {
      onError(err.message);
    } finally {
      setLookupBusy(false);
    }
  };

  // A thread comes back a page at a time (newest page first, each page in
  // chronological order): "Show older messages" asks for the page before
  // nextBefore and prepends it, so the thread stays oldest-to-newest.
  const openThread = async (id, older = false) => {
    if (older && !thread?.nextBefore) return;
    setLookupBusy(true);
    try {
      const qs = new URLSearchParams({
        kind: 'messages',
        conversationId: String(id),
        ...(older ? { before: String(thread.nextBefore) } : {}),
      }).toString();
      let { res, data } = await adminGet(adminKey, `/api/admin/content-lookup?${qs}`);
      if (older && res.status === 409 && data?.code === 'stale_cursor') {
        // The oldest message on screen (the paging anchor) is gone -- taken
        // down, or aged out of the stored window. An empty "nothing older"
        // page here used to hide the button for good while older messages
        // still existed (round-14 admin-ui#0). Reload from the newest page.
        ({ res, data } = await adminGet(adminKey, `/api/admin/content-lookup?${new URLSearchParams({ kind: 'messages', conversationId: String(id) }).toString()}`));
        if (!res.ok) throw new Error(errorFrom(res, data, 'Lookup failed'));
        onError('The thread changed while you were paging, so it was reloaded from the newest messages. Use "Show older messages" to page back again.');
        older = false;
      } else if (!res.ok) {
        throw new Error(errorFrom(res, data, 'Lookup failed'));
      }
      const conv = data.conversation || null;
      if (!conv) { if (!older) setThread(null); return; }
      const page = Array.isArray(conv.messages) ? conv.messages : [];
      const next = { ...conv, messages: page, hasMore: !!conv.hasMore && conv.nextBefore != null, nextBefore: conv.nextBefore ?? null };
      setThread((t) => {
        if (!older || !t || String(t.id) !== String(conv.id)) return next;
        const seen = new Set(t.messages.map((m) => String(m.id)));
        return { ...next, messages: [...page.filter((m) => !seen.has(String(m.id))), ...t.messages] };
      });
    } catch (err) {
      onError(err.message);
    } finally {
      setLookupBusy(false);
    }
  };

  const submit = async (picked = null) => {
    let target;
    let what;
    const kind = picked?.type || type;
    if (kind === 'listing') {
      const idv = String(picked?.listingId ?? listingId).trim();
      if (!TAKEDOWN_ID_RE.test(idv)) { onError('Enter the listing number (e.g. 12 from /marketplace?listing=12).'); return; }
      target = { type: kind, listingId: idv };
      what = `marketplace listing #${idv}${picked?.label ? ` (${picked.label})` : ''}, INCLUDING the files buyers paid for (they stop receiving it)`;
    } else if (kind === 'wall_post') {
      const idv = String(picked?.postId ?? postId).trim();
      if (!TAKEDOWN_ID_RE.test(idv)) { onError('Enter the wall comment number, or find it with "Show comments".'); return; }
      target = { type: kind, postId: idv };
      what = `wall comment #${idv}${picked?.label ? ` (${picked.label})` : ''}`;
    } else {
      const c = String(picked?.conversationId ?? conversationId).trim();
      const m = String(picked?.messageId ?? messageId).trim();
      if (!c || !m || c.length > 300 || m.length > 100) { onError('Find the message with "Find conversations", or enter both the conversation id and the message id.'); return; }
      target = { type: kind, conversationId: c, messageId: m };
      what = `message ${m}${picked?.label ? ` (${picked.label})` : ''} in conversation ${c}`;
    }
    const quarantine = minor || preserve;
    if (!confirm(
      `Take down ${what}${forReq}?`
      + (quarantine ? ' Its files are QUARANTINED as evidence first (kept, never served, listed in the Evidence tab).' : ' Its files are deleted.')
      + (report ? ' A copy of the item is kept on the request and in the audit trail.' : ' A copy of the item is kept in the audit trail. No report or takedown request is attached.'),
    )) return;
    setBusy(true);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/content-takedown', {
        ...target,
        ...(report ? { nciiReportId: String(report.id) } : {}),
        ...(quarantine ? { preserve: true } : {}),
      });
      if (!res.ok) throw new Error(errorFrom(res, data, 'The takedown failed'));
      const short = what.split(',')[0];
      await onDone(data.result === 'removed'
        ? `Took down ${short}${forReq}${data.preserved ? `; ${data.preserved} file(s) quarantined as evidence` : ''}.`
          + (report ? ' It is recorded on the request -- you can now resolve it as removed.' : ' It is recorded in the audit trail.')
        : report
          ? `Nothing to take down: ${short} was already gone (or that id is wrong). That does NOT count as a removal: check the id and the content location, then take down the right item, or tick "already gone / removed elsewhere" if it really is.`
          : `Nothing to take down: ${short} was already gone (or that id is wrong).`);
      setListingId(''); setConversationId(''); setMessageId(''); setPostId('');
      // The item is gone either way: drop it from the lookup lists.
      if (target.type === 'listing') {
        if (data.result === 'removed') {
          setListings((l) => (l ? { ...l, listings: l.listings.map((x) => (String(x.id) === target.listingId ? { ...x, status: 'removed' } : x)) } : l));
        }
      } else if (target.type === 'wall_post') {
        setWall((w) => (w ? { ...w, posts: w.posts.filter((p) => String(p.id) !== target.postId) } : w));
      } else if (target.type === 'message') {
        setThread((t) => {
          if (!t || String(t.id) !== String(target.conversationId)) return t;
          const messages = t.messages.filter((x) => String(x.id) !== String(target.messageId));
          const removed = t.messages.length - messages.length;
          const count = Number(t.messageCount);
          // nextBefore is the id of the oldest message on screen. If that one
          // was just taken down, page from the new oldest instead: the removed
          // id no longer exists and would page nowhere (round-14 admin-ui#0).
          // With nothing left on screen the old anchor stays; the server then
          // answers stale_cursor and openThread reloads from the newest page.
          const anchorGone = t.nextBefore != null && String(t.nextBefore) === String(target.messageId);
          const nextBefore = anchorGone && messages.length ? String(messages[0].id) : t.nextBefore;
          return { ...t, messages, nextBefore, ...(Number.isFinite(count) ? { messageCount: Math.max(0, count - removed) } : {}) };
        });
      }
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'px-2 py-1 rounded-md bg-black/40 border border-red-500/40 text-white text-xs';
  const off = disabled || busy;
  const lookOff = off || lookupBusy;
  const smallBtn = 'text-[11px] px-2 py-0.5 rounded-md border border-red-500 bg-red-600/20 text-red-300 hover:bg-red-600/30 transition disabled:opacity-50 shrink-0';
  const linkBtn = 'text-[11px] px-2 py-1 rounded-md border border-white/20 text-gray-300 hover:text-white transition disabled:opacity-50';
  const creatorOptions = (Array.isArray(creators) ? creators : []).map((c) => (
    <option key={c.id} value={String(c.id)}>{String(c.name || 'Unnamed')} {c.handle ? `(${String(c.handle)})` : ''} · #{String(c.id)}</option>
  ));
  const participantById = (id) => (thread?.participants || []).find((p) => String(p.userId) === String(id));

  return (
    <div className="mb-2 px-3 py-2 rounded-md bg-red-900/10 border border-red-500/30 text-xs text-gray-300">
      <p className="text-red-300 font-bold mb-1">Take down content</p>
      <div className="flex flex-wrap items-center gap-2">
        <select value={type} onChange={(e) => setType(e.target.value)} disabled={off} className={inputCls}>
          <option value="listing">Marketplace listing</option>
          <option value="message">Direct message</option>
          <option value="wall_post">Wall comment</option>
        </select>
        {type === 'listing' && (
          <input value={listingId} onChange={(e) => setListingId(e.target.value.replace(/[^0-9]/g, '').slice(0, 18))} placeholder="Listing #" inputMode="numeric" disabled={off} className={`${inputCls} w-28`} />
        )}
        {type === 'wall_post' && (
          <input value={postId} onChange={(e) => setPostId(e.target.value.replace(/[^0-9]/g, '').slice(0, 18))} placeholder="Comment # (or find below)" inputMode="numeric" disabled={off} className={`${inputCls} w-44`} />
        )}
        {type === 'message' && (
          <>
            <input value={conversationId} onChange={(e) => setConversationId(e.target.value.slice(0, 300))} placeholder="Conversation id (or find below)" disabled={off} className={`${inputCls} w-52`} />
            <input value={messageId} onChange={(e) => setMessageId(e.target.value.slice(0, 100))} placeholder="Message id" disabled={off} className={`${inputCls} w-36`} />
          </>
        )}
        <button
          onClick={() => submit()}
          disabled={off}
          className="text-xs px-3 py-1 rounded-md border border-red-500 bg-red-600/20 text-red-300 hover:bg-red-600/30 transition disabled:opacity-50"
        >
          {busy ? 'Taking down…' : 'Take down'}
        </button>
      </div>

      {type === 'listing' && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select value={listingCreatorId} onChange={(e) => setListingCreatorId(e.target.value)} disabled={lookOff} className={inputCls}>
              <option value="">Whose listing?</option>
              {creatorOptions}
            </select>
            <button onClick={loadListings} disabled={lookOff || !listingCreatorId} className={linkBtn}>
              {lookupBusy ? 'Loading…' : 'Show listings'}
            </button>
          </div>
          {listings && (
            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {!listings.listings.length ? <p className="text-gray-500">That creator has no listings.</p> : listings.listings.map((l) => {
                const gone = l.status === 'removed';
                return (
                  <div key={l.id} className="flex items-start gap-2 px-2 py-1 rounded bg-black/30 border border-white/5">
                    <div className="flex-1 min-w-0">
                      <p className="text-[10px] text-gray-500">
                        #{String(l.id)} · {String(l.status || 'active')} · {l.kind === 'physical' ? 'physical' : 'digital'}
                        {l.priceCents != null && Number.isFinite(Number(l.priceCents)) ? ` · ${dollars(l.priceCents)}` : ''}
                        {l.createdAt ? ` · ${new Date(l.createdAt).toLocaleDateString()}` : ''} · {Number(l.mediaCount) || 0} file(s)
                      </p>
                      <p className="text-gray-200 break-words">{String(l.title || '(untitled)')}</p>
                    </div>
                    <button
                      onClick={() => submit({ type: 'listing', listingId: String(l.id), label: String(l.title || '').slice(0, 60) })}
                      disabled={off || gone}
                      className={smallBtn}
                    >
                      {gone ? 'Removed' : report ? `Take down for #${String(report.id)}` : 'Take down'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {type === 'wall_post' && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select value={wallCreatorId} onChange={(e) => setWallCreatorId(e.target.value)} disabled={lookOff} className={inputCls}>
              <option value="">Whose wall?</option>
              {creatorOptions}
            </select>
            <button onClick={() => loadWall(false)} disabled={lookOff || !wallCreatorId} className={linkBtn}>
              {lookupBusy ? 'Loading…' : 'Show comments'}
            </button>
          </div>
          {wall && (
            <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
              {!wall.posts.length ? <p className="text-gray-500">No comments on that wall.</p> : wall.posts.map((p) => (
                <div key={p.id} className="flex items-start gap-2 px-2 py-1 rounded bg-black/30 border border-white/5">
                  <div className="flex-1 min-w-0">
                    <p className="text-[10px] text-gray-500">
                      #{String(p.id)} · {p.createdAt ? new Date(p.createdAt).toLocaleString() : ''} · {String(p.authorName || '')} — {lookupAccountLabel(p.author)}
                    </p>
                    <p className="text-gray-200 whitespace-pre-wrap break-words">{String(p.text)}</p>
                  </div>
                  <button
                    onClick={() => submit({ type: 'wall_post', postId: String(p.id), label: `by ${p.author?.login || p.authorName || 'unknown'}` })}
                    disabled={off}
                    className={smallBtn}
                  >
                    {report ? `Take down for #${String(report.id)}` : 'Take down'}
                  </button>
                </div>
              ))}
              {wall.nextBefore && (
                <button onClick={() => loadWall(true)} disabled={lookOff} className={linkBtn}>Load older</button>
              )}
            </div>
          )}
        </div>
      )}

      {type === 'message' && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <select value={dmBy} onChange={(e) => setDmBy(['login', 'id', 'creator'].includes(e.target.value) ? e.target.value : 'login')} disabled={lookOff} className={inputCls}>
              <option value="login">One side's email / username</option>
              <option value="id">One side's user id</option>
              <option value="creator">A creator</option>
            </select>
            {dmBy === 'creator' ? (
              <select value={dmCreatorId} onChange={(e) => setDmCreatorId(e.target.value)} disabled={lookOff} className={inputCls}>
                <option value="">Which creator?</option>
                {creatorOptions}
              </select>
            ) : (
              <input
                value={dmWho}
                onChange={(e) => setDmWho(e.target.value.slice(0, 320))}
                onKeyDown={(e) => e.key === 'Enter' && loadConvos(false)}
                placeholder={dmBy === 'id' ? 'User id' : 'Email or username'}
                disabled={lookOff}
                className={`${inputCls} w-52`}
              />
            )}
            <button onClick={() => loadConvos(false)} disabled={lookOff} className={linkBtn}>
              {lookupBusy ? 'Loading…' : 'Find conversations'}
            </button>
          </div>
          {convos && (
            <div className="space-y-1">
              <p className="text-[10px] text-gray-500">Conversations of {lookupAccountLabel(convos.account)}:</p>
              <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
                {!convos.conversations.length ? <p className="text-gray-500">No conversations.</p> : convos.conversations.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => openThread(c.id)}
                    disabled={lookOff}
                    className={`block w-full text-left px-2 py-1 rounded border ${thread?.id === c.id ? 'border-red-500/60 bg-red-900/20' : 'border-white/5 bg-black/30'} hover:border-white/20 disabled:opacity-50`}
                  >
                    <span className="text-gray-200">with {lookupAccountLabel(c.other)}</span>
                    <span className="text-[10px] text-gray-500"> · {Number(c.messageCount) || 0} message(s){c.updatedAt ? ` · last ${new Date(c.updatedAt).toLocaleString()}` : ''}</span>
                    {c.lastMessage?.text ? <span className="block text-[10px] text-gray-500 truncate">"{String(c.lastMessage.text)}"</span> : null}
                  </button>
                ))}
                {convos.nextCursor && (
                  <button onClick={() => loadConvos(true)} disabled={lookOff} className={linkBtn}>More conversations</button>
                )}
              </div>
              <p className="text-[10px] text-gray-600">
                Newest activity first. A conversation that gets a new message after this list loaded moves to the top
                and is not added by "More conversations" -- press "Find conversations" again to see it.
              </p>
            </div>
          )}
          {thread && (
            <div className="space-y-1">
              <p className="text-[10px] text-gray-500">
                Thread {String(thread.id)} between {(thread.participants || []).map(lookupAccountLabel).join(' and ')}
                {Number.isFinite(Number(thread.messageCount)) ? ` -- showing ${thread.messages.length} of ${Number(thread.messageCount)} message(s)` : ''}:
              </p>
              <div className="max-h-72 overflow-y-auto space-y-1 pr-1">
                {thread.hasMore && (
                  <button onClick={() => openThread(thread.id, true)} disabled={lookupBusy || off} className={smallBtn}>
                    {lookupBusy ? 'Loading…' : 'Show older messages'}
                  </button>
                )}
                {!thread.messages.length ? <p className="text-gray-500">No stored messages.</p> : thread.messages.map((m) => {
                  const sender = participantById(m.senderId);
                  return (
                    <div key={m.id} className="flex items-start gap-2 px-2 py-1 rounded bg-black/30 border border-white/5">
                      <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-gray-500">
                          {m.createdAt ? new Date(m.createdAt).toLocaleString() : ''} · from {sender ? lookupAccountLabel(sender) : `user ${String(m.senderId)}`}
                          {m.priceCents ? ` · paid ${formatCredits(m.priceCents)}` : ''} · id {String(m.id)}
                        </p>
                        <p className="text-gray-200 whitespace-pre-wrap break-words">{String(m.text)}</p>
                      </div>
                      <button
                        onClick={() => submit({ type: 'message', conversationId: String(thread.id), messageId: String(m.id), label: `from ${sender?.login || `user ${String(m.senderId)}`}` })}
                        disabled={off}
                        className={smallBtn}
                      >
                        {report ? `Take down for #${String(report.id)}` : 'Take down'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <label className="flex items-center gap-2 mt-2 text-[11px] text-gray-400">
        <input type="checkbox" checked={minor || preserve} disabled={minor || off} onChange={(e) => setPreserve(e.target.checked)} />
        {minor
          ? 'Files are quarantined as evidence (always, for a possible-minor request).'
          : 'Quarantine the files as evidence instead of deleting them.'}
      </label>
      <p className="text-[10px] text-gray-500 mt-1">
        {report
          ? `A gallery item or profile photo is removed from the creator's record in the Creators tab -- enter this request's number (#${String(report.id)}) there so the removal is recorded here.`
          : "A gallery item or profile photo is removed from the creator's record in the Creators tab. Use this for content you found yourself; for a TAKE IT DOWN request, take it down from that request instead so it can be resolved."}
      </p>
    </div>
  );
}

// lib/performer-records-store.js RECORD_REQUIRED_BY_LIVE_CREATOR (not
// imported: that module pulls in the database driver and encryption).
const RECORD_REQUIRED_CODE = 'record_required_by_live_creator';

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
      const res = await fetch('/api/admin/waitlist?format=csv', { headers: { 'x-admin-key': adminKeyHeader(adminKey) } });
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
        headers: { 'x-admin-key': adminKeyHeader(adminKey) },
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

// Where a payout has to be sent for Mark Paid to verify it: the on-chain
// check (pages/api/admin/payouts-mark-paid.js) looks ONLY at the configured
// marketplace chain and token contract. USDG exists on other networks and the
// same 0x address receives on any of them, so a transfer sent on the wrong
// one (an exchange's default network, say) reaches the creator but can never
// be recorded here -- the row stays pending with its credits reserved.
function payoutNetwork() {
  const c = getMarketplacePaymentConfig();
  const symbol = c.stableSymbol || 'USDG';
  const chain = c.chainName
    ? `${c.chainName}${c.chainId ? ` (chain id ${c.chainId})` : ''}`
    : c.chainId ? `chain id ${c.chainId}` : '';
  return { symbol, chain, token: c.usdcAddress || '' };
}

function PayoutNetworkLine({ net }) {
  return (
    <>
      {net.symbol} on <span className="text-white font-bold">{net.chain || '(payment network not configured)'}</span>
      {net.token ? <>, token contract <span className="font-mono">{net.token}</span></> : null}
    </>
  );
}

function PayoutsPanel({ adminKey }) {
  const net = payoutNetwork();
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
  const [manual, setManual] = useState({ account: '', txHash: '', fromAddress: '' });
  const [manualBy, setManualBy] = useState('login');
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
  //  - 501/502, or 503 chain_check_unavailable (PAYOUT_SENDER_ADDRESS is
  //    misconfigured): the on-chain check couldn't run. "Record without
  //    checking" re-posts skipChainCheck:true. A plain 500 never offers it.
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
        const checkUnavailable = res.status === 502 || res.status === 501
          || (res.status === 503 && data?.code === 'chain_check_unavailable');
        if (checkUnavailable && !opts.skipChainCheck) {
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
    const who = manual.account.trim();
    const txHash = manual.txHash.trim();
    const fromAddress = manual.fromAddress.trim();
    if (!who || !txHash || !fromAddress) return;
    setManualBusy(true);
    try {
      // A manual credit is irreversible: the transaction hash is claimed for
      // good the moment it succeeds, so a typo'd id would credit a DIFFERENT
      // real account with no way back. Resolve the account first and have the
      // admin confirm who it is; the server then refuses unless expectedLogin
      // matches that user id (400 CONFIRM_ACCOUNT / 409 ACCOUNT_MISMATCH), so
      // a stale panel cannot skip the check either.
      const param = manualBy === 'login' ? `login=${encodeURIComponent(who)}` : `userId=${encodeURIComponent(who)}`;
      const lookup = await adminGet(adminKey, `/api/admin/user-moderation?${param}`);
      if (lookup.res.status === 404) {
        throw new Error(manualBy === 'login' ? `No account signs in as "${who}". Nothing was credited.` : `No account with user id "${who}". Nothing was credited.`);
      }
      if (!lookup.res.ok || !lookup.data.user) throw new Error(errorFrom(lookup.res, lookup.data, 'Could not look up that account'));
      const acct = lookup.data.user;
      if (!acct.login) throw new Error(`User ${acct.userId} has no login on record, so it cannot be confirmed. Nothing was credited.`);
      if (!confirm(
        `Credit the deposit in ${txHash} (sent from ${fromAddress}) to:\n\n`
        + `  ${acct.login}\n  user ${acct.userId}${acct.role ? ` · ${acct.role}` : ''}${acct.status && acct.status !== 'active' ? ` · ${String(acct.status).toUpperCase()}` : ''}\n\n`
        + 'This cannot be undone: the transaction is claimed permanently and can never be credited to anyone else.',
      )) {
        setManualMsg('Nothing was credited.');
        return;
      }
      const body = { userId: acct.userId, expectedLogin: acct.login, txHash, fromAddress };
      let { res, data } = await adminPost(adminKey, '/api/admin/manual-credit', body);
      // A suspended or banned account's credits are frozen: crediting it
      // claims the transaction for good with nothing spendable. The server
      // refuses unless that is an explicit decision (creditFrozen: true).
      if (res.status === 409 && data.code === 'ACCOUNT_FROZEN') {
        if (!confirm(
          `${data.error || 'That account is suspended or banned, so its credits are frozen.'}\n\n`
          + 'Credit it anyway? The transaction is claimed permanently and the credits stay frozen until the account is reinstated.',
        )) {
          setManualMsg('Nothing was credited.');
          return;
        }
        ({ res, data } = await adminPost(adminKey, '/api/admin/manual-credit', { ...body, creditFrozen: true }));
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not credit that payment'));
      // A hash already credited to this same account is answered 200 with
      // alreadyCredited and a plain message: nothing new was added, so it must
      // not read as "Credited N" (that looked like a second credit).
      if (data.alreadyCredited) {
        setManualMsg(
          (typeof data.message === 'string' && data.message
            ? data.message
            : `This transaction was already credited to ${acct.login} earlier; nothing new was added.`)
          + (Number(data.creditedCents) > 0 ? ` (It was ${formatCredits(data.creditedCents)}.)` : '')
          + (data.frozen ? ' The account is suspended or banned, so those credits are frozen until it is reinstated.' : ''),
        );
        setManual({ account: '', txHash: '', fromAddress: '' });
        return;
      }
      setManualMsg(
        `Credited ${formatCredits(data.creditedCents)} to ${data.creditedUserEmail || acct.login} (user ${acct.userId}).`
        + (data.frozen ? ' The account is suspended or banned, so these credits are frozen until it is reinstated.' : ''),
      );
      setManual({ account: '', txHash: '', fromAddress: '' });
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
      <p className="text-sm text-yellow-300/90 mb-2">
        Send <PayoutNetworkLine net={net} /> only. The check looks at that network and that token and nothing else: USDG
        sent on any other network (an exchange's default withdrawal network, for example) still reaches the wallet but
        can never be recorded here.
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
              <p className="text-[11px] text-gray-400 break-all">
                Send <PayoutNetworkLine net={net} /> to:{' '}
                <span className="font-mono">{String(r.payout_wallet || '(no wallet)')}</span>
              </p>
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
          before crediting anything. Deposited credits are spend-only -- they can never be cashed out. The account is
          looked up and shown for you to confirm before anything is credited, because a credit can never be undone.
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <select
            value={manualBy}
            onChange={(e) => setManualBy(e.target.value === 'id' ? 'id' : 'login')}
            className="px-2 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white"
          >
            <option value="login">Email / username</option>
            <option value="id">User id</option>
          </select>
          <input
            value={manual.account}
            onChange={(e) => setManual((m) => ({ ...m, account: e.target.value.slice(0, 320) }))}
            placeholder={manualBy === 'login' ? 'Email or username' : 'User id'}
            className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-xs text-white w-48"
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
            disabled={manualBusy || !manual.account.trim() || !manual.txHash.trim() || !manual.fromAddress.trim()}
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
  // Bumped whenever the form clears, and used as the file input's key so the
  // browser forgets the previous selection too. Clearing only `file` left the
  // input still showing the last ID's name while the next save sent nothing.
  const [fileInputKey, setFileInputKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  // { id, url } for an ID document whose new tab could not be opened (a popup
  // blocker): shown as a plain link so the admin can still open or save it.
  const [docLink, setDocLink] = useState(null);
  const docLinkRef = useRef(null);
  useEffect(() => () => { if (docLinkRef.current) URL.revokeObjectURL(docLinkRef.current.url); }, []);
  const showDocLink = (next) => {
    if (docLinkRef.current) URL.revokeObjectURL(docLinkRef.current.url);
    docLinkRef.current = next;
    setDocLink(next);
  };
  // Per-record edit: { id, creatorId, aliases, contentUrls, notes } while open.
  const [editing, setEditing] = useState(null);
  // Ids the server matched for a URL search (see urlSearch below).
  const [serverMatches, setServerMatches] = useState(null);

  useEffect(() => {
    const term = search.trim();
    if (!/\/creator\/|\/api\/media\//i.test(term)) { setServerMatches(null); return undefined; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { res, data } = await adminGet(adminKey, `/api/admin/performer-records?q=${encodeURIComponent(term.slice(0, 500))}`);
        if (!cancelled && res.ok) setServerMatches(new Set((Array.isArray(data.records) ? data.records : []).map((r) => String(r.id))));
      } catch {
        if (!cancelled) setServerMatches(null);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [search, adminKey]);

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
      headers: { 'x-admin-key': adminKeyHeader(adminKey), 'Content-Type': docFile.type || 'application/octet-stream' },
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
  // Unlinking (or archiving) the only usable record of a creator who is live
  // would leave them live with no §2257 record. The API refuses that with 409
  // RECORD_REQUIRED_BY_LIVE_CREATOR; going ahead anyway is its own explicit
  // confirmation, resent with confirmUnrecordedLiveCreator: true.
  const confirmUnrecorded = (data) => confirm(
    `${data.error || 'This is the only usable §2257 record of a creator who is live.'}\n\n`
    + 'The right way to correct a record: add the corrected record first, then archive the old one -- the creator '
    + 'stays covered throughout.\n\nGo ahead anyway and leave that creator live WITHOUT a usable record?',
  );

  const updateRecord = async (id, fields, doneMessage) => {
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      let { res, data } = await adminPost(adminKey, '/api/admin/performer-records', { action: 'update', id, fields });
      if (res.status === 409 && data.code === RECORD_REQUIRED_CODE) {
        if (!confirmUnrecorded(data)) { setNotice('Nothing was changed.'); return; }
        ({ res, data } = await adminPost(adminKey, '/api/admin/performer-records', {
          action: 'update', id, fields, confirmUnrecordedLiveCreator: true,
        }));
      }
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
      setFileInputKey((k) => k + 1);
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
    // The tab is opened HERE, synchronously inside the click, before any
    // await: by the time a multi-MB ID has downloaded the click's user
    // activation is gone and Safari (and others, on a slow download) block
    // the popup. It was also opened with 'noopener', which makes
    // window.open return null whether or not it worked, so a blocked popup
    // failed silently. Now a null window is detected and the document is
    // offered as a link instead.
    let win = null;
    try { win = window.open('', '_blank'); } catch { win = null; }
    if (win) {
      try {
        win.opener = null;
        win.document.title = 'Loading ID document…';
      } catch { /* cross-origin or already navigated: harmless */ }
    }
    setBusyId(id);
    setError('');
    try {
      const res = await fetch(`/api/admin/performer-record-document?id=${encodeURIComponent(id)}`, { headers: { 'x-admin-key': adminKeyHeader(adminKey) } });
      if (!res.ok) {
        throw new Error(errorFrom(res, await readJson(res), 'Could not open that document'));
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (win && !win.closed) {
        win.location.href = url;
        // Revoked after the new tab has had a moment to read it, so the
        // object URL doesn't linger in this page for the rest of the session.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } else {
        // Blocked, or the admin closed the blank tab: the link below stays
        // until another document replaces it or the panel unmounts.
        showDocLink({ id, url });
      }
    } catch (err) {
      if (win && !win.closed) win.close();
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const archive = async (id) => {
    const reason = window.prompt('Why is this record being archived? (kept on the record)\n\nCorrecting a record? Add the corrected record first, then archive the old one.');
    if (reason === null) return;
    setBusyId(id);
    setError('');
    setNotice('');
    try {
      let { res, data } = await adminPost(adminKey, '/api/admin/performer-records', { action: 'archive', id, reason });
      if (res.status === 409 && data.code === RECORD_REQUIRED_CODE) {
        if (!confirmUnrecorded(data)) { setNotice('Nothing was archived.'); return; }
        ({ res, data } = await adminPost(adminKey, '/api/admin/performer-records', {
          action: 'archive', id, reason, confirmUnrecordedLiveCreator: true,
        }));
      }
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not archive that record'));
      setNotice(`Record #${id} archived (kept, not deleted).`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const q = search.trim().toLowerCase();
  // A pasted creator-page or media URL is resolved by the server (?q=) to the
  // records linked to that creator plus the co-performers attested on that
  // exact item -- a plain text match against contentUrls would miss both.
  const urlSearch = /\/creator\/|\/api\/media\//.test(q);
  const visible = records
    .filter((r) => (showArchived ? r.status === 'archived' : r.status !== 'archived'))
    .filter((r) => !q
      || (urlSearch && serverMatches && serverMatches.has(String(r.id)))
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
          <input key={fileInputKey} type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] || null)}
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
            placeholder="Search by stage name, legal name or URL (/creator/<id> and /api/media/… links work)…"
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
        {docLink && (
          <p className="text-sm text-yellow-300 mb-3">
            Your browser blocked the new tab for record #{docLink.id}&apos;s ID document.{' '}
            <a href={docLink.url} target="_blank" rel="noopener noreferrer" className="underline text-brand-pink">Open it</a>
            {' or '}
            <a href={docLink.url} download={`performer-record-${docLink.id}-id`} className="underline text-brand-pink">save it</a>.{' '}
            <button type="button" onClick={() => showDocLink(null)} className="underline text-gray-400">Dismiss</button>
          </p>
        )}

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
                      Legal name, date of birth and ID number cannot be edited. If one is wrong, add the corrected record
                      first (linked to the same creator), then archive this one with the reason.
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

/**
 * Account tools that don't belong to one creator record:
 *  - Find the account a leaked screenshot came off, from the viewer mark tiled
 *    over private media (POST /api/admin/viewer-mark; lib/viewer-mark.js).
 *  - Suspend, ban or clear an account (GET/POST /api/admin/user-moderation):
 *    any fan, and a creator account whose profile is not approved. An
 *    APPROVED creator is suspended or banned from their creator record; the
 *    API refuses suspend/ban for one (400) but 'clear' works on every account.
 *  - Delete a fan account on request (POST /api/admin/delete-user; Privacy
 *    Policy section 7).
 *  - Erase a shipped order's shipping address on request (Privacy Policy
 *    section 7; /api/admin/order-address-erase).
 *  - Undelivered standing messages to server/ (/api/admin/standing-pushes).
 */
function AccountsPanel({ adminKey, creators, onOpenCreator }) {
  const [mark, setMark] = useState('');
  const [markBusy, setMarkBusy] = useState(false);
  const [markResult, setMarkResult] = useState(null);
  const [markError, setMarkError] = useState('');

  const [userId, setUserId] = useState('');
  const [login, setLogin] = useState('');
  const [account, setAccount] = useState(null);
  const [days, setDays] = useState('30');
  const [reason, setReason] = useState('');
  const [modBusy, setModBusy] = useState(false);
  const [modError, setModError] = useState('');
  const [modNotice, setModNotice] = useState('');

  const lookupMark = async () => {
    setMarkBusy(true);
    setMarkError('');
    setMarkResult(null);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/viewer-mark', { code: mark });
      if (res.status === 404) { setMarkError(data.error || 'No account produces that mark.'); return; }
      if (!res.ok || !data.match) throw new Error(errorFrom(res, data, 'Lookup failed'));
      setMarkResult(data.match);
    } catch (err) {
      setMarkError(err.message);
    } finally {
      setMarkBusy(false);
    }
  };

  // By internal user id, or -- `byLogin` -- by the email / username the
  // account signs in with. Fans never see their user id, so a deletion or
  // support request emailed to team@ names the account by its login (Privacy
  // Policy section 7); the server matches it the way sign-in does.
  const loadAccount = async (id, { byLogin = false } = {}) => {
    const target = String(id ?? (byLogin ? login : userId)).trim();
    if (!target) return;
    setModBusy(true);
    setModError('');
    setModNotice('');
    setAccount(null);
    try {
      const param = byLogin ? `login=${encodeURIComponent(target)}` : `userId=${encodeURIComponent(target)}`;
      const { res, data } = await adminGet(adminKey, `/api/admin/user-moderation?${param}`);
      if (res.status === 404) throw new Error(byLogin ? `No account signs in as "${target}".` : `No account with user id "${target}".`);
      if (!res.ok || !data.user) throw new Error(errorFrom(res, data, 'Could not load that account'));
      setUserId(String(data.user.userId));
      setAccount(data.user);
    } catch (err) {
      setModError(err.message);
    } finally {
      setModBusy(false);
    }
  };

  const moderate = async (action) => {
    if (!account) return;
    const n = Number(days);
    if (action === 'suspend' && (!Number.isInteger(n) || n < 1 || n > 365)) {
      setModError('Days must be a whole number from 1 to 365.');
      return;
    }
    const verb = action === 'ban' ? 'BAN (signs them out everywhere, refuses every future sign-in)'
      : action === 'suspend' ? `suspend for ${n} day(s) (read-only: no posts, messages, reports, purchases)`
        : 'clear any suspension or ban on';
    const who = `account ${account.userId}${account.login ? ` (${account.login})` : ''}`;
    if (!confirm(`${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${who}?`)) return;
    setModBusy(true);
    setModError('');
    setModNotice('');
    try {
      const body = { userId: account.userId, action, ...(action === 'suspend' ? { days: n } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) };
      const { res, data } = await adminPost(adminKey, '/api/admin/user-moderation', body);
      if (!res.ok || !data.user) throw new Error(errorFrom(res, data, 'Could not change that account'));
      setAccount(data.user);
      setModNotice(`Account ${data.user.userId} is now ${data.user.status || 'in good standing'}.`);
    } catch (err) {
      setModError(err.message);
    } finally {
      setModBusy(false);
    }
  };

  // Privacy Policy section 7: a fan's deletion request. The server refuses
  // (409) while the account has a credit balance, earnings, a pending payout
  // or an unshipped order -- each listed -- and deleting anyway is its own
  // explicit confirmation (force). A creator account is deleted from its
  // creator record instead (Delete Model), which also handles their listings.
  const deleteAccount = async () => {
    if (!account) return;
    if (!confirm(
      `Delete account ${account.userId}${account.login ? ` (${account.login})` : ''} on request?\n\nRemoves the login, their wall comments, the messages they sent, `
      + 'favorites and notifications, and signs them out everywhere. Credit, order and payout records are kept (without '
      + 'the login); reports and moderation records keep their copy of reported content, including who wrote it; and '
      + '§2257 records are never deleted. This cannot be undone.',
    )) return;
    setModBusy(true);
    setModError('');
    setModNotice('');
    try {
      let force = false;
      for (;;) {
        const { res, data } = await adminPost(adminKey, '/api/admin/delete-user', { userId: account.userId, force });
        if (res.status === 409 && data.code === 'account_has_obligations' && !force) {
          const o = data.obligations || {};
          const lines = [];
          if (Number(o.balanceCents) > 0) lines.push(`• ${formatCredits(o.balanceCents)} credit balance (forfeited -- credits are never refunded)`);
          if (Number(o.withdrawableCents) > 0) lines.push(`• of which ${formatCredits(o.withdrawableCents)} is withdrawable earnings`);
          if (Number(o.pendingPayouts) > 0) lines.push(`• ${o.pendingPayouts} pending payout(s) totalling ${formatCredits(o.pendingPayoutCents)}`);
          if (Number(o.unshippedOrders) > 0) lines.push(`• ${o.unshippedOrders} physical order(s) they bought that have not shipped yet`);
          if (!confirm(`${data.error || 'This account still has money or orders attached.'}\n\n${lines.join('\n')}\n\nDelete anyway?`)) {
            setModNotice('Nothing was deleted.');
            return;
          }
          force = true;
          continue;
        }
        if (res.status === 409 && data.code === 'account_is_creator') {
          throw new Error(`${data.error || 'That is a creator account.'} Open it from the Creators tab and use Delete Model.`);
        }
        if (!res.ok) throw new Error(errorFrom(res, data, 'Could not delete that account'));
        setAccount(null);
        setUserId('');
        setLogin('');
        setModNotice(
          `Account ${data.deletedUserId} deleted.`
          + (Number(data.forfeitedCents) > 0 ? ` ${formatCredits(data.forfeitedCents)} of credits were forfeited.` : ''),
        );
        return;
      }
    } catch (err) {
      setModError(err.message);
    } finally {
      setModBusy(false);
    }
  };

  const creatorFor = (id) => (creators || []).find((c) => String(c.id) === String(id));

  return (
    <div className="space-y-8">
      <div className="premium-card p-5">
        <p className="font-bold text-white mb-1">Find an account by viewer mark</p>
        <p className="text-xs text-gray-500 mb-3">
          Private media carries a mark (like A3F9-21C4) tied to the signed-in viewer. Type the one from a leaked
          screenshot to find the account it came from. Lookups are rate-limited and logged.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            value={mark}
            onChange={(e) => setMark(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && mark.trim() && lookupMark()}
            placeholder="A3F9-21C4"
            className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm font-mono w-48"
          />
          <button onClick={lookupMark} disabled={markBusy || !mark.trim()} className="premium-button text-sm disabled:opacity-50">
            {markBusy ? 'Searching…' : 'Look up'}
          </button>
        </div>
        {markError && <p className="text-sm text-red-400 mt-3">{markError}</p>}
        {markResult && (
          <div className="mt-3 text-sm text-gray-300 space-y-1">
            <p>
              Account <span className="font-mono text-white">{String(markResult.userId)}</span>
              {markResult.role ? ` (${String(markResult.role)})` : ''}
              {markResult.creatorId && (() => {
                const c = creatorFor(markResult.creatorId);
                return ` — creator ${c ? `${c.name} (${c.handle || `#${c.id}`})` : `#${String(markResult.creatorId)}`}`;
              })()}
            </p>
            <div className="flex gap-3">
              {markResult.creatorId ? (
                <button onClick={() => onOpenCreator(String(markResult.creatorId))} className="text-xs underline text-brand-gold">
                  Open creator record
                </button>
              ) : (
                <button onClick={() => loadAccount(markResult.userId)} className="text-xs underline text-brand-gold">
                  Moderate this account
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="premium-card p-5">
        <p className="font-bold text-white mb-1">Account moderation and deletion</p>
        <p className="text-xs text-gray-500 mb-3">
          By the email or username the account signs in with (what a support or deletion email names), or by user
          id (shown on reports, violations and each creator's login line). A suspension makes the account
          read-only until it lapses; a ban signs it out everywhere and refuses every future sign-in. An approved
          creator is suspended or banned from their creator record instead, but Clear works on any account (for
          example, a pending applicant who was banned here and has since been approved). Delete honours a fan&apos;s
          deletion request (Privacy Policy section 7).
        </p>
        <div className="flex flex-wrap gap-2 mb-2">
          <input
            value={login}
            onChange={(e) => setLogin(e.target.value.slice(0, 320))}
            onKeyDown={(e) => e.key === 'Enter' && login.trim() && loadAccount(undefined, { byLogin: true })}
            placeholder="Email or username"
            className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm w-72 max-w-full"
          />
          <button onClick={() => loadAccount(undefined, { byLogin: true })} disabled={modBusy || !login.trim()} className="premium-button text-sm disabled:opacity-50">
            Find by email / username
          </button>
        </div>
        <div className="flex flex-wrap gap-2 mb-3">
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && userId.trim() && loadAccount()}
            placeholder="User id"
            className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm font-mono w-72 max-w-full"
          />
          <button onClick={() => loadAccount()} disabled={modBusy || !userId.trim()} className="premium-button text-sm disabled:opacity-50">
            Load by id
          </button>
        </div>
        {modError && <p className="text-sm text-red-400 mb-3">{modError}</p>}
        {modNotice && <p className="text-sm text-green-400 mb-3">{modNotice}</p>}
        {account && (
          <div className="space-y-3 text-sm text-gray-300">
            <p>
              Account <span className="font-mono text-white">{String(account.userId)}</span>
              {account.login ? <> — signs in as <span className="text-white">{String(account.login)}</span></> : null}
              {account.role ? ` (${String(account.role)})` : ''} — status:{' '}
              <span className={account.status && account.status !== 'active' ? 'text-red-400 font-bold' : 'text-green-400'}>
                {String(account.status || 'active')}
              </span>
              {account.moderationUntil && ` until ${new Date(account.moderationUntil).toLocaleString()}`}
              {account.moderationReason && ` — ${String(account.moderationReason)}`}
            </p>
            {account.role === 'creator' && (
              <p className="text-xs text-yellow-400/90">
                Creator account. If their profile is approved, suspend or ban them from the creator record (Status);
                Suspend and Ban here only work while the profile is not approved. Clear always works.
              </p>
            )}
            <>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Reason (kept on the account)"
                    className="px-3 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs w-72 max-w-full"
                  />
                  <label className="flex items-center gap-1 text-xs text-gray-400">
                    Days
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={days}
                      onChange={(e) => setDays(e.target.value)}
                      className="w-20 px-2 py-1.5 rounded-md bg-black/40 border border-brand-purple/30 text-white text-xs"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => moderate('suspend')} disabled={modBusy} className="text-xs px-3 py-1.5 rounded-md border border-yellow-500/50 text-yellow-300 hover:bg-yellow-500/10 transition disabled:opacity-50">
                    Suspend
                  </button>
                  <button onClick={() => moderate('ban')} disabled={modBusy} className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 transition disabled:opacity-50">
                    Ban
                  </button>
                  <button onClick={() => moderate('clear')} disabled={modBusy} className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50">
                    Clear
                  </button>
                  {account.role !== 'creator' && (
                    <button onClick={deleteAccount} disabled={modBusy} className="ml-auto text-xs px-3 py-1.5 rounded-md border border-red-500/60 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50">
                      Delete account…
                    </button>
                  )}
                </div>
                {/* Their purchases: an unshipped paid order blocks deleting
                    this account, and this is where its number is found. */}
                <div className="mt-3">
                  <OrdersPanel
                    key={`buyer-orders-${account.userId}`}
                    adminKey={adminKey}
                    creators={creators}
                    fixedBuyerId={String(account.userId)}
                    title="Their purchases"
                  />
                </div>
            </>
          </div>
        )}
      </div>

      <OrdersPanel adminKey={adminKey} creators={creators} />

      <StandaloneTakedownPanel adminKey={adminKey} creators={creators} />

      <OrderAddressErasePanel adminKey={adminKey} />

      <StandingPushesPanel adminKey={adminKey} />
    </div>
  );
}

/**
 * Finding and closing orders (round-9 admin-ui#0). A paid physical order
 * whose seller was banned or deleted can never ship, and while it sits in
 * 'pending_shipment' its shipping address can't be erased and its buyer can't
 * delete their account. Nothing in this panel used to show an order number --
 * a ban or delete only reported "N paid order(s) not yet shipped" -- so the
 * close tool could not be used without the buyer emailing the number in.
 *
 * GET /api/admin/orders lists orders by seller, buyer or number (never an
 * address: `hasAddress` only says one is still stored), each with the
 * seller's standing. POST /api/admin/order-close { orderId, reason,
 * eraseAddress?, force? } moves one to 'closed_unfulfilled' (only from
 * pending_shipment; 409 ORDER_NOT_CLOSABLE otherwise), keeps the reason on the
 * order and notifies the buyer. A seller who is NOT banned or deleted could
 * still ship it, so the server refuses (409 ORDER_SELLER_ACTIVE, with the
 * seller) unless the admin explicitly forces it -- recorded on the order. No
 * credits move: re-crediting the buyer is a separate owner decision.
 *
 * `fixedCreatorId` / `fixedBuyerId` pin the list to one seller or buyer (the
 * creator editor, an account in ACCOUNTS) and load it straight away.
 */
const MAX_CLOSE_REASON_CHARS = 500;
const ORDER_STATUS_LABEL = {
  pending_shipment: 'waiting to ship',
  shipped: 'shipped',
  fulfilled: 'fulfilled',
  delivered: 'delivered',
  closed_unfulfilled: 'closed, not fulfilled',
};

function sellerLabel(seller) {
  if (!seller) return 'unknown seller';
  const who = seller.name ? `${String(seller.name)}${seller.handle ? ` (${String(seller.handle)})` : ''}` : `creator #${String(seller.creatorId ?? '?')}`;
  const standing = seller.status === 'deleted' ? 'DELETED'
    : seller.status === 'no_login' ? 'NO LOGIN'
      : String(seller.status || 'unknown').toUpperCase();
  return `${who} · ${standing}`;
}

function OrdersPanel({ adminKey, creators, fixedCreatorId = null, fixedBuyerId = null, title }) {
  const fixed = fixedCreatorId != null || fixedBuyerId != null;
  const [by, setBy] = useState('creator');
  const [creatorId, setCreatorId] = useState('');
  const [who, setWho] = useState('');
  const [statusFilter, setStatusFilter] = useState('pending_shipment');
  const [orders, setOrders] = useState(null);
  const [loading, setLoading] = useState(false);
  // The order whose close form is open, and that form's fields.
  const [closing, setClosing] = useState(null);
  const [reason, setReason] = useState('');
  const [eraseAddress, setEraseAddress] = useState(false);
  // ORDER_SELLER_ACTIVE: the seller could still ship; a close now needs force.
  const [needsForce, setNeedsForce] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const query = () => {
    const params = {};
    if (fixedCreatorId != null) params.creatorId = String(fixedCreatorId);
    else if (fixedBuyerId != null) params.buyerId = String(fixedBuyerId);
    else if (by === 'creator') {
      if (!creatorId) return { error: 'Pick the seller.' };
      params.creatorId = creatorId;
    } else {
      const v = who.trim();
      if (by === 'order') {
        if (!/^[1-9][0-9]{0,17}$/.test(v)) return { error: 'Enter the order number, a plain number like 42.' };
        params.orderId = v;
      } else if (by === 'sellerId') {
        // A DELETED seller is no longer in the creator list above, but their
        // orders keep the id (a delete's "left behind" message names it).
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return { error: 'Enter the seller\'s creator number.' };
        params.creatorId = v;
      } else {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(v)) return { error: "Enter the buyer's user id (ACCOUNTS shows it)." };
        params.buyerId = v;
      }
    }
    // An order number is looked up whatever its status.
    if (statusFilter && !params.orderId) params.status = statusFilter;
    return { params };
  };

  // Only the newest load may write: switching the status filter (or a
  // close/erase reload overlapping one) fires overlapping requests, and a
  // slower earlier one landing last would list one status's orders under
  // another's label. Same guard as ReportsPanel.
  const loadSeq = useRef(0);
  const load = async ({ keepNotice = false } = {}) => {
    const seq = ++loadSeq.current;
    const q = query();
    setError('');
    if (!keepNotice) setNotice('');
    if (q.error) { setLoading(false); setError(q.error); return; }
    setLoading(true);
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/orders?${new URLSearchParams(q.params).toString()}`);
      if (seq !== loadSeq.current) return;
      if (!res.ok || !Array.isArray(data.orders)) throw new Error(errorFrom(res, data, 'Could not load orders'));
      setOrders(data.orders);
    } catch (err) {
      if (seq === loadSeq.current) setError(err.message);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  };

  // A pinned list (one creator / one buyer) loads by itself, and again when
  // the pinned id or the status filter changes.
  useEffect(() => {
    if (!fixed) return;
    setOrders(null);
    setClosing(null);
    setNeedsForce(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedCreatorId, fixedBuyerId, statusFilter]);

  // The unpinned panel only loads on "Find orders", so changing what it is
  // looking for (seller, search mode, the typed id, the status filter) must
  // drop the list on screen: it answered the OLD question, and left in place
  // it showed one seller's waiting orders, with live "Close order" buttons,
  // under another seller's or another status's label. The load counter is
  // bumped too so a request already in flight for the old question can't
  // repopulate the list after it was cleared.
  useEffect(() => {
    if (fixed) return;
    loadSeq.current += 1;
    setLoading(false);
    setOrders(null);
    setClosing(null);
    setNeedsForce(null);
    setReason('');
    setEraseAddress(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [by, creatorId, who, statusFilter]);

  const startClose = (o) => {
    setClosing(o);
    setReason('');
    setEraseAddress(false);
    setNeedsForce(null);
    setError('');
    setNotice('');
  };

  const close = async (force = false) => {
    if (!closing) return;
    const id = String(closing.id);
    const why = reason.trim();
    setError('');
    setNotice('');
    if (!why) { setError('Give a reason for closing the order. It is kept on the order.'); return; }
    if (reason.length > MAX_CLOSE_REASON_CHARS) { setError(`Keep the reason under ${MAX_CLOSE_REASON_CHARS} characters.`); return; }
    const seller = needsForce || closing.seller;
    if (!confirm(
      `Close order #${id} ("${String(closing.title || 'untitled')}") as not fulfilled?\n\n`
      + `Seller: ${sellerLabel(seller)}\nBuyer: user ${String(closing.buyerId ?? '?')}\n\n`
      + (force
        ? 'This seller is NOT banned or deleted and could still ship it. Closing anyway is recorded on the order as forced.\n\n'
        : '')
      + 'The buyer is notified and the seller can no longer ship it. No credits are returned by this action.'
      + (eraseAddress ? ' The shipping name and address are also erased, permanently.' : ''),
    )) return;
    setBusy(true);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/order-close', {
        orderId: id,
        reason: why,
        eraseAddress,
        ...(force ? { force: true } : {}),
      });
      if (res.status === 404) throw new Error(`There is no order #${id}.`);
      if (res.status === 409 && data.code === 'ORDER_SELLER_ACTIVE' && !force) {
        setNeedsForce(data.seller || closing.seller || null);
        setError(`${data.error || 'The seller can still ship this order.'} Nothing was closed.`);
        return;
      }
      if (res.status === 409) throw new Error(errorFrom(res, data, `Order #${id} is not a physical order waiting to ship, so it was not closed.`));
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not close the order'));
      const at = data.closedAt ? ` (${new Date(data.closedAt).toLocaleString()})` : '';
      setNotice(`Order #${id} closed as not fulfilled${at}${data.forced ? ', recorded as forced' : ''}.${data.erased ? ' Its shipping address was erased.' : ''}`);
      setClosing(null);
      setNeedsForce(null);
      setReason('');
      setEraseAddress(false);
      await load({ keepNotice: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const eraseAddr = async (o) => {
    const id = String(o.id);
    if (!confirm(
      `Erase the shipping name and address, and the tracking numbers, on order #${id}? This cannot be undone, and the seller can no longer change the tracking afterwards. Only do it when no dispute or `
      + 'legal claim about this order is in progress.',
    )) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/order-address-erase', { orderId: id });
      if (res.status === 404) throw new Error(`There is no order #${id}.`);
      if (res.status === 409) throw new Error(`Order #${id} is still waiting to ship, so its address is still needed and was not erased. If it can never ship, close it first.`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not erase the address'));
      setNotice(data.erased ? `Shipping name, address and tracking numbers erased from order #${id}.` : `Order #${id} has no shipping address or tracking number left to erase.`);
      await load({ keepNotice: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm';
  const list = Array.isArray(orders) ? orders : null;

  return (
    <div className="premium-card p-5">
      <p className="font-bold text-white mb-1">{title || 'Orders: find, close, erase an address'}</p>
      <p className="text-xs text-gray-500 mb-3">
        Close a paid physical order that can never ship (its seller was banned or deleted). Only an order still waiting
        to ship can be closed; the buyer gets a notice and no credits are returned by this action. Shipping addresses are
        never shown here.
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {!fixed && (
          <>
            <select value={by} onChange={(e) => { setBy(['creator', 'sellerId', 'buyer', 'order'].includes(e.target.value) ? e.target.value : 'creator'); setWho(''); }} className={inputCls}>
              <option value="creator">By seller</option>
              <option value="sellerId">By seller number (deleted sellers)</option>
              <option value="buyer">By buyer user id</option>
              <option value="order">By order number</option>
            </select>
            {by === 'creator' ? (
              <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)} className={inputCls}>
                <option value="">Which seller?</option>
                {(Array.isArray(creators) ? creators : []).map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {String(c.name || 'Unnamed')} {c.handle ? `(${String(c.handle)})` : ''} · #{String(c.id)} · {effectiveCreatorStatus(c) || 'active'}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={who}
                onChange={(e) => setWho(e.target.value.slice(0, 64))}
                onKeyDown={(e) => e.key === 'Enter' && !loading && load()}
                inputMode={by === 'order' ? 'numeric' : undefined}
                placeholder={by === 'order' ? 'Order number' : by === 'sellerId' ? 'Creator number' : 'Buyer user id'}
                className={`${inputCls} w-44`}
              />
            )}
          </>
        )}
        {!(by === 'order' && !fixed) && (
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className={inputCls}>
            <option value="pending_shipment">Waiting to ship</option>
            <option value="">Any status</option>
            <option value="shipped">Shipped</option>
            <option value="closed_unfulfilled">Closed, not fulfilled</option>
          </select>
        )}
        <button onClick={() => load()} disabled={loading || busy} className="text-xs px-3 py-2 rounded-md border border-white/20 text-gray-300 hover:text-white transition disabled:opacity-50">
          {loading ? 'Loading…' : fixed ? 'Refresh' : 'Find orders'}
        </button>
      </div>

      {list && (
        !list.length ? (
          <p className="text-xs text-gray-500">No matching orders.</p>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
            {list.map((o) => {
              const closable = o.kind === 'physical' && o.status === 'pending_shipment';
              // Also an order whose address went before tracking numbers were
              // erased with it (lib/orders-store.js ERASABLE_SHIPPING_WHERE_SQL).
              const hasTrackingNumbers = (typeof o.trackingNumber === 'string' && o.trackingNumber !== '')
                || (Array.isArray(o.trackingHistory) && o.trackingHistory.some((h) => h && h.trackingNumber));
              const erasable = (o.hasAddress || hasTrackingNumbers) && o.status !== 'pending_shipment';
              const open = closing && String(closing.id) === String(o.id);
              return (
                <div key={o.id} className={`px-3 py-2 rounded-md bg-black/30 border ${open ? 'border-red-500/50' : 'border-white/5'} text-xs`}>
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-white font-bold break-words">
                        Order #{String(o.id)} · {String(o.title || '(untitled)')}
                      </p>
                      <p className="text-gray-400">
                        {o.kind === 'physical' ? 'physical' : 'digital'} · {ORDER_STATUS_LABEL[o.status] || String(o.status || 'unknown')}
                        {' · '}{dollars(Number(o.priceCents || 0) + Number(o.shippingCents || 0))}
                        {o.createdAt ? ` · ordered ${new Date(o.createdAt).toLocaleDateString()}` : ''}
                        {o.closedAt ? ` · closed ${new Date(o.closedAt).toLocaleDateString()}${o.closeForced ? ' (forced)' : ''}` : ''}
                      </p>
                      <p className="text-gray-500">
                        Seller: <span className={o.seller?.unableToFulfil ? 'text-red-300' : 'text-gray-300'}>{sellerLabel(o.seller)}</span>
                        {' · '}Buyer: user {String(o.buyerId ?? '?')}
                        {' · '}{o.hasAddress ? 'address stored' : o.addressErasedAt ? 'address erased' : 'no address'}
                        {o.trackingErasedAt ? ' · tracking numbers erased' : ''}
                      </p>
                      {o.closeReason && <p className="text-gray-500 break-words">Close reason: {String(o.closeReason)}</p>}
                      {(typeof o.trackingNumber === 'string' && o.trackingNumber) && (
                        <p className="text-gray-500 break-words">
                          Tracking: {String(o.carrier || '')} {String(o.trackingNumber)}
                          {o.trackingUpdatedAt ? ` · set ${new Date(o.trackingUpdatedAt).toLocaleString()}` : ''}
                        </p>
                      )}
                      {/* Earlier tracking the seller replaced (never shown to buyer or seller). */}
                      {Array.isArray(o.trackingHistory) && o.trackingHistory.length > 0 && (
                        <ul className="text-[11px] text-gray-600 break-words">
                          {o.trackingHistory.map((h, i) => (
                            <li key={i}>
                              Replaced: {String(h?.carrier || '')} {h?.trackingNumber ? String(h.trackingNumber) : o.trackingErasedAt ? '(number erased)' : ''}
                              {h?.replacedAt ? ` · ${new Date(h.replacedAt).toLocaleString()}` : ''}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {closable && !open && (
                        <button onClick={() => startClose(o)} disabled={busy} className="text-[11px] px-2 py-1 rounded-md border border-red-500/60 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50">
                          Close order…
                        </button>
                      )}
                      {erasable && (
                        <button onClick={() => eraseAddr(o)} disabled={busy} className="text-[11px] px-2 py-1 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50">
                          {o.hasAddress ? 'Erase address…' : 'Erase tracking…'}
                        </button>
                      )}
                    </div>
                  </div>
                  {open && (
                    <div className="mt-2 space-y-2">
                      {!o.seller?.unableToFulfil && !needsForce && (
                        <p className="text-yellow-300/90">
                          This seller is {String(o.seller?.status || 'not banned')} and could still ship it: closing is only
                          meant for a banned or deleted seller. The server will ask you to confirm a forced close.
                        </p>
                      )}
                      <textarea
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={MAX_CLOSE_REASON_CHARS}
                        rows={2}
                        placeholder="Reason (kept on the order, never shown to the buyer or seller)"
                        className="w-full px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm"
                      />
                      <label className="flex items-center gap-2 text-gray-300 cursor-pointer">
                        <input type="checkbox" checked={eraseAddress} onChange={(e) => setEraseAddress(e.target.checked)} />
                        Also erase the shipping name and address (permanent)
                      </label>
                      {needsForce && (
                        <p className="text-red-300">
                          Refused: the seller ({sellerLabel(needsForce)}) is not banned or deleted and could still ship this
                          order. Only force it if they can&apos;t (unreachable, a long suspension).
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {!needsForce ? (
                          <button onClick={() => close(false)} disabled={busy || !reason.trim()} className="text-xs px-3 py-1.5 rounded-md border border-red-500/60 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50">
                            {busy ? 'Closing…' : 'Close order…'}
                          </button>
                        ) : (
                          <button onClick={() => close(true)} disabled={busy || !reason.trim()} className="text-xs px-3 py-1.5 rounded-md border border-red-500 bg-red-600/20 text-red-200 hover:bg-red-600/30 transition disabled:opacity-50">
                            {busy ? 'Closing…' : 'Force close anyway…'}
                          </button>
                        )}
                        <button onClick={() => { setClosing(null); setNeedsForce(null); }} disabled={busy} className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-gray-400 hover:text-white transition disabled:opacity-50">
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {list.length >= 200 && <p className="text-[10px] text-gray-500">Showing the newest 200. Narrow the filter to see older ones.</p>}
          </div>
        )
      )}
      {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      {notice && <p className="text-sm text-green-400 mt-2">{notice}</p>}
    </div>
  );
}

/**
 * Takes down one listing, DM or wall comment an admin found themselves --
 * no user report or TAKE IT DOWN request has to exist first (round-9
 * admin-ui#1). The same control the takedown requests use, without a
 * request: POST /api/admin/content-takedown with no nciiReportId, which
 * still snapshots the item and writes the audit trail. For content named in
 * a TAKE IT DOWN request, take it down from that request instead, so the
 * request can be resolved as removed.
 */
function StandaloneTakedownPanel({ adminKey, creators }) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  return (
    <div className="premium-card p-5">
      <p className="font-bold text-white mb-1">Take down content (no report needed)</p>
      <p className="text-xs text-gray-500 mb-3">
        For a listing, message or wall comment you found yourself. Only that item is removed -- the creator is not banned.
      </p>
      <TakedownControl
        adminKey={adminKey}
        creators={creators}
        onDone={async (msg) => { setError(''); setNotice(msg); }}
        onError={(msg) => { setNotice(''); setError(msg); }}
      />
      {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      {notice && <p className="text-sm text-green-400 mt-2">{notice}</p>}
    </div>
  );
}

/**
 * Privacy Policy section 7: once a physical order has shipped, the buyer can
 * ask for its shipping name and address to be deleted
 * (POST /api/admin/order-address-erase { orderId }). The order record stays;
 * only the address goes, and it cannot be undone. The server refuses (409) an
 * order still waiting to ship -- the creator needs the address to send it
 * (close it first with OrdersPanel if it never will) -- and answers
 * erased:false when there is nothing left to erase. A closed order counts as
 * settled. A fan who deletes their own account has this done for every
 * shipped or closed order already.
 */
function OrderAddressErasePanel({ adminKey }) {
  const [orderId, setOrderId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const erase = async () => {
    const id = orderId.trim();
    setError('');
    setNotice('');
    if (!/^[1-9][0-9]{0,17}$/.test(id)) { setError('Enter the order number, a plain number like 42.'); return; }
    if (!confirm(
      `Erase the shipping name and address, and the tracking numbers, on order #${id}? This cannot be undone, and the seller can no longer change the tracking afterwards. Only do it when no dispute or `
      + 'legal claim about this order is in progress.',
    )) return;
    setBusy(true);
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/order-address-erase', { orderId: id });
      if (res.status === 404) throw new Error(`There is no order #${id}.`);
      if (res.status === 409) throw new Error(`Order #${id} is still waiting to ship, so its address is still needed and was not erased. If it can never ship, close it first.`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not erase the address'));
      const at = data.addressErasedAt ? ` (erased ${new Date(data.addressErasedAt).toLocaleString()})` : '';
      setNotice(data.erased
        ? `Shipping name, address and tracking numbers erased from order #${id}${at}.`
        : `Order #${id} has no shipping address or tracking number left to erase${at}.`);
      setOrderId('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="premium-card p-5">
      <p className="font-bold text-white mb-1">Erase a shipped order&apos;s shipping address</p>
      <p className="text-xs text-gray-500 mb-3">
        For a buyer&apos;s request under Privacy Policy section 7. Works only on an order that has already shipped or
        was closed as not fulfilled; the order itself is kept. Permanent.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && erase()}
          inputMode="numeric"
          placeholder="Order number"
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm w-40"
        />
        <button
          onClick={erase}
          disabled={busy || !orderId.trim()}
          className="text-xs px-3 py-2 rounded-md border border-red-500/60 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50"
        >
          {busy ? 'Erasing…' : 'Erase address…'}
        </button>
      </div>
      {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
      {notice && <p className="text-sm text-green-400 mt-2">{notice}</p>}
    </div>
  );
}

// Panel state from a GET/POST /api/admin/standing-pushes body. needsServerAdmin
// is kept per row: it is what tells a refused reinstatement apart from an
// ordinary delivery failure.
function standingState(data) {
  const pending = Array.isArray(data?.pending) ? data.pending : [];
  return {
    configured: data?.configured !== false,
    pending: pending.map((p) => ({ ...p, needsServerAdmin: p?.needsServerAdmin === true })),
  };
}

/**
 * Bans, suspensions, reinstatements and deletions server/ has not confirmed
 * yet (lib/standing-outbox.js via /api/admin/standing-pushes). Each row is
 * an account that may still be renewing subscriptions or taking payouts on
 * server/. Ordinary failures retry by themselves; "Retry now" delivers every
 * one at once. A needsServerAdmin row is a reinstatement server/ refused
 * because a server/ admin applied the ban or suspension: no retry clears it
 * until an operator ADMIN resolves the site uid to its server/ id with
 * GET /admin/users/by-site-uid/:siteUid and then runs
 * POST /admin/users/:id/status on server/, so the panel flags it and says
 * exactly that (round-14 srv-auth-core#0: nothing used to map one id to the
 * other, and pasting the site uid got a silent {ok:true}; it is a 404 now).
 */
function StandingPushesPanel({ adminKey }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    setError('');
    try {
      const { res, data } = await adminGet(adminKey, '/api/admin/standing-pushes');
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not load the server/ sync queue'));
      setState(standingState(data));
    } catch (err) {
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  const retry = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { res, data } = await adminPost(adminKey, '/api/admin/standing-pushes', {});
      if (!res.ok) throw new Error(errorFrom(res, data, 'Retry failed'));
      setState(standingState(data));
      const stuck = Number(data.needsServerAdmin) || 0;
      setNotice(`Delivered ${Number(data.sent) || 0}, failed ${Number(data.failed) || 0}.`
        + (stuck ? ` ${stuck} of those failures ${stuck === 1 ? 'is a reinstatement' : 'are reinstatements'} the backend refused because a server/ admin applied the ban or suspension -- retrying will not clear ${stuck === 1 ? 'it' : 'them'}; see the red rows below.` : ''));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const pending = state?.pending || [];
  const stuckCount = pending.filter((p) => p.needsServerAdmin).length;
  return (
    <div className="premium-card p-5">
      <div className="flex flex-wrap items-center gap-3 mb-1">
        <p className="font-bold text-white">Account standing not yet synced to server/</p>
        <div className="flex-1" />
        <button onClick={load} disabled={busy} className="text-xs px-3 py-1.5 rounded-md border border-white/15 text-gray-300 hover:text-white transition disabled:opacity-50">
          Refresh
        </button>
        <button onClick={retry} disabled={busy || !pending.length} className="premium-button text-xs px-4 py-1.5 disabled:opacity-50">
          {busy ? 'Retrying…' : 'Retry now'}
        </button>
      </div>
      <p className="text-xs text-gray-500 mb-3">
        A ban, suspension, reinstatement or deletion made on this site that the payments backend has not confirmed yet
        -- that account may still be renewing subscriptions or taking payouts there. Ordinary delivery failures retry on
        their own (backing off up to 6 hours, plus the daily maintenance run); a row stuck on http_404 usually means the
        backend needs a redeploy. Rows marked NEEDS SERVER/ ADMIN are different: they never clear by retrying (see below).
      </p>
      {stuckCount > 0 && (
        <div className="text-xs text-red-200 mb-3 px-3 py-2 rounded-md border border-red-500/50 bg-red-900/20 space-y-1">
          <p className="font-bold">
            {stuckCount} reinstatement{stuckCount === 1 ? '' : 's'} refused by the backend -- the account is STILL restricted on server/.
          </p>
          <p>
            A server/ admin applied that ban or suspension, and the site is only allowed to lift restrictions the site
            applied. Until an operator ADMIN lifts it on server/, the account stays restricted there (payouts frozen;
            after a ban, subscribers cut off and listings down). Retrying from here will not change that.
          </p>
          <p>
            To fix, logged in to server/ as an operator ADMIN: first call{' '}
            <span className="font-mono">GET /admin/users/by-site-uid/&lt;site user id shown&gt;</span>, which returns that
            account's server/ <span className="font-mono">id</span> (the site user id is NOT the server/ id -- using it
            answers 404 not_found and changes nothing). Then call{' '}
            <span className="font-mono">POST /admin/users/&lt;that id&gt;/status {'{"status":"ACTIVE"}'}</span>; it answers{' '}
            <span className="font-mono">{'{"ok":true}'}</span> only when the change was applied. After that, press Retry now
            (or wait for the next retry) and the row clears.
          </p>
        </div>
      )}
      {state && !state.configured && (
        <p className="text-xs text-yellow-300 mb-2">The link to the backend is not configured, so nothing can be delivered.</p>
      )}
      {error && <p className="text-sm text-red-400 mb-2">{error}</p>}
      {notice && <p className="text-sm text-green-400 mb-2">{notice}</p>}
      {!state ? (
        <p className="text-xs text-gray-500">{error ? '' : 'Loading…'}</p>
      ) : !pending.length ? (
        <p className="text-xs text-gray-500">Nothing waiting -- every change has been delivered.</p>
      ) : (
        <div className="space-y-1 text-xs text-gray-300">
          {pending.map((p) => (
            <div key={String(p.uid)} className={`flex flex-wrap gap-x-3 gap-y-0.5 px-3 py-2 rounded-md bg-black/30 border ${p.needsServerAdmin ? 'border-red-500/60' : 'border-white/10'}`}>
              {p.needsServerAdmin && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-red-600/30 text-red-200 border border-red-500/60">NEEDS SERVER/ ADMIN</span>
              )}
              <span className="font-mono text-white">user {String(p.uid)}</span>
              <span className="uppercase font-bold">{String(p.status ?? '')}</span>
              {p.role && <span className="text-gray-500">{String(p.role)}</span>}
              {p.suspendedUntil && <span className="text-gray-500">until {new Date(p.suspendedUntil).toLocaleString()}</span>}
              <span className="text-gray-500">{Number(p.attempts) || 0} attempt(s)</span>
              {p.nextAttemptAt && <span className="text-gray-500">next {new Date(p.nextAttemptAt).toLocaleString()}</span>}
              {p.lastError && <span className="text-red-300">last error: {String(p.lastError)}</span>}
              {p.needsServerAdmin && (
                <span className="basis-full text-red-200">
                  {String(p.lastError) === 'suspension_needs_server_admin' ? 'Suspended' : 'Banned'} by a server/ admin -- still
                  restricted there. Retries will not clear this: an operator ADMIN must run{' '}
                  <span className="font-mono">GET /admin/users/by-site-uid/{String(p.uid)}</span> on server/ to get its server/ id,
                  then <span className="font-mono">POST /admin/users/&lt;that id&gt;/status {'{"status":"ACTIVE"}'}</span>, then
                  Retry now.
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Files QUARANTINED as evidence (lib/media-preservation.js) -- content
 * removed over a report of a possible minor, kept (never served, never
 * deleted) because 18 U.S.C. 2258A requires it to be preserved for a year
 * after the CyberTipline report. Listing and download go through
 * /api/admin/preserved-media with the admin key header only (never a URL a
 * page could embed); every download is counted on the row. Nothing here is
 * rendered inline.
 */
function EvidencePanel({ adminKey }) {
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState('');
  const [busyPath, setBusyPath] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    const f = filter.trim();
    const report = /^[1-9][0-9]{0,17}$/.test(f) ? `ncii:${f}` : /^(ncii|report):[1-9][0-9]{0,17}$/.test(f) ? f : '';
    if (f && !report) { setError('Filter by a takedown request number (12), or ncii:12 / report:34.'); return; }
    try {
      const { res, data } = await adminGet(adminKey, `/api/admin/preserved-media${report ? `?report=${encodeURIComponent(report)}` : ''}`);
      if (!res.ok) throw new Error(errorFrom(res, data, 'Could not load preserved evidence'));
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (err) {
      setItems((prev) => prev ?? []);
      setError(err.message);
    }
  };

  useEffect(() => { load(); }, []);

  const download = async (item) => {
    if (!confirm(
      'Download this preserved file? It was removed over a report of a POSSIBLE MINOR. Download it only to make or '
      + 'support a report to the NCMEC CyberTipline or to answer law enforcement -- never share it otherwise. Every '
      + 'download is recorded.',
    )) return;
    setBusyPath(item.pathname);
    setError('');
    try {
      const res = await fetch(`/api/admin/preserved-media?pathname=${encodeURIComponent(item.pathname)}&download=1`, {
        headers: { 'x-admin-key': adminKeyHeader(adminKey) },
      });
      if (!res.ok) throw new Error(errorFrom(res, await readJson(res), 'Could not download that file'));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = String(item.pathname).split('/').pop() || 'evidence';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyPath(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="premium-card p-5 text-sm text-gray-400">
        <p className="text-white font-bold mb-1">Preserved evidence</p>
        <p className="text-xs">
          Files removed over a report of a possible minor are quarantined here: never deleted and never served to
          anyone. Federal law (18 U.S.C. 2258A) requires reporting apparent child sexual abuse material to the NCMEC
          CyberTipline (report.cybertip.org) and preserving it for one year after the report. The report itself is
          filed outside this panel. Nothing here is deleted automatically after the retention date; that decision
          belongs to the owner and counsel.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && load()}
          placeholder="Takedown request # (or report:34)"
          className="px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm w-64"
        />
        <button onClick={load} className="premium-button text-sm">Show</button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {items === null ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : !items.length ? (
        <p className="text-sm text-gray-500">Nothing preserved{filter.trim() ? ' for that report' : ''}.</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={String(it.pathname)} className="premium-card p-3 text-xs text-gray-300 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-white break-all">{String(it.pathname)}</span>
              <span className="text-gray-500">{String(it.reportId ?? '')}</span>
              {it.preservedAt && <span className="text-gray-500">preserved {new Date(it.preservedAt).toLocaleString()}</span>}
              {it.retainUntil && <span className="text-gray-500">keep until {String(it.retainUntil).slice(0, 10)}</span>}
              {it.missingAt && <span className="text-red-400 font-bold">FILE MISSING (since {new Date(it.missingAt).toLocaleString()})</span>}
              {!it.missingAt && !it.movedAt && <span className="text-yellow-300">not yet moved to evidence storage</span>}
              <span className="text-gray-500">{Number(it.exportCount) || 0} download(s)</span>
              {it.reason && <span className="basis-full text-gray-500">{String(it.reason)}</span>}
              <div className="flex-1" />
              {!it.missingAt && (
                <button
                  onClick={() => download(it)}
                  disabled={busyPath === it.pathname}
                  className="text-xs px-3 py-1.5 rounded-md border border-red-500/40 text-red-300 hover:bg-red-500/10 transition disabled:opacity-50"
                >
                  {busyPath === it.pathname ? 'Downloading…' : 'Download'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
