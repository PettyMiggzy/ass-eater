import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Mirrors lib/reports-store.js (REPORT_CATEGORIES, the 500-character reason
// cap). Not imported: that module pulls in the Postgres driver, which must
// never reach a client bundle. The server validates both either way -- a
// longer reason is refused with 400 { field: 'reason', maxLength: 500 }, not
// cut -- this just keeps the form from offering what it will refuse.
export const REPORT_REASON_MAX = 500;
export const REPORT_CATEGORY_OPTIONS = [
  { value: 'other', label: 'Something else (spam, harassment, scams…)' },
  { value: 'minor', label: 'Someone in it may be under 18' },
  { value: 'non_consensual', label: 'Shared without consent / deepfake of a real person' },
];

/**
 * The one report form every surface uses (wall comments, marketplace
 * listings, direct messages): a category, a reason with a visible length
 * limit, and a pointer to the formal takedown form. `minor` and
 * `non_consensual` alert the operator and sort to the top of the admin queue,
 * so the choice is asked for explicitly rather than guessed from the text.
 *
 * `onSubmit({ reason, category })` must resolve on success and throw an
 * Error whose message is safe to show on failure.
 */
export default function ReportModal({ title, subject = 'this', onSubmit, onClose }) {
  const [reason, setReason] = useState('');
  const [category, setCategory] = useState('other');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = reason.trim();
    if (!trimmed || sending) return;
    if (trimmed.length > REPORT_REASON_MAX) {
      setError(`Keep the reason under ${REPORT_REASON_MAX} characters.`);
      return;
    }
    setSending(true);
    setError('');
    try {
      await onSubmit({ reason: trimmed, category });
    } catch (err) {
      setError(err?.message || 'Could not send the report. Please try again.');
      setSending(false);
    }
  };

  const serious = category === 'minor' || category === 'non_consensual';

  // Rendered into document.body through a portal: an ancestor with a
  // backdrop-filter/transform/filter (e.g. .premium-card) becomes the
  // containing block and stacking context for `fixed` descendants, which
  // would trap this overlay inside that card instead of covering the page.
  // The portal target only exists after mount (none during SSR).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[400] flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <form onSubmit={submit} className="rounded-xl border border-white/10 bg-brand-card w-full max-w-sm p-6">
        <p className="font-bold text-white mb-1">{title}</p>
        <p className="text-xs text-gray-400 mb-4">An admin will review {subject}.</p>
        <label className="block text-[11px] font-bold tracking-widest text-gray-400 mb-1" htmlFor="report-category">
          WHAT&apos;S WRONG
        </label>
        <select
          id="report-category"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full mb-3 px-3 py-2 rounded-md bg-black/40 border border-white/10 text-white text-sm"
        >
          {REPORT_CATEGORY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REPORT_REASON_MAX}
          rows={3}
          required
          placeholder="What's wrong?"
          className="w-full px-3 py-2 rounded-md bg-black/40 border border-white/10 text-white text-sm resize-none"
        />
        <p className="text-[11px] text-gray-500 text-right mb-2">{reason.length}/{REPORT_REASON_MAX}</p>
        <p className="text-[11px] text-gray-500 mb-4 leading-relaxed">
          {serious ? 'If this is you, or intimate content of you shared without consent, ' : 'Reporting intimate content of you shared without consent? '}
          use the{' '}
          <a href="/report-content" target="_blank" rel="noreferrer" className="text-brand-pink underline">
            takedown request form
          </a>{' '}
          — it starts a 48-hour removal clock and needs no account.
        </p>
        {error && <p className="text-xs text-red-400 mb-3">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={sending} className="flex-1 text-sm px-4 py-2 rounded-md border border-white/10 text-gray-300 hover:bg-white/5 transition disabled:opacity-50">
            Cancel
          </button>
          <button type="submit" disabled={sending || !reason.trim()} className="flex-1 px-6 py-2 rounded-full bg-brand-pink hover:bg-brand-pink-dark text-white font-bold transition text-sm disabled:opacity-50">
            {sending ? 'Sending…' : 'Report'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

/**
 * POSTs a report and turns the response into ReportModal's contract: resolves
 * on 200, throws a showable Error otherwise (the server's own validation
 * messages are safe; anything unexpected is generic).
 */
export async function postReport(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    if (res.status === 401) throw new Error('Log in to report this.');
    throw new Error((typeof data?.error === 'string' && data.error) || 'Could not send the report. Please try again.');
  }
  return data;
}
