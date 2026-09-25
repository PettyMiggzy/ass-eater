import { getReportById, updateReportStatus, normalizeTargetId } from '../../../lib/reports-store';
import { markListingRemoved, getListingById } from '../../../lib/listings-store';
import { deleteWallPost } from '../../../lib/wall-store';
import { removeConversationMessage } from '../../../lib/messages-store';
import { preserveMedia, movePreservedToEvidence, reportRef } from '../../../lib/media-preservation';
import { requireAdminKey } from '../../../lib/admin-auth';
import { query, withTransaction } from '../../../lib/db';

/**
 * POST /api/admin/reports-resolve { id, action: 'dismiss' | 'remove_content' }
 *   -> 200 { ok, report, content: 'removed' | 'already_gone' | null, preserved?: number }
 *
 * remove_content takes the reported thing down: a listing (files deleted), a
 * wall comment, or a direct message (removed from the conversation).
 *
 * A report filed under category 'minor' is evidence as well as a takedown
 * (18 U.S.C. 2258A): a listing's files are QUARANTINED for the report first
 * (lib/media-preservation.js -- kept, never served, never deleted) and then
 * the listing comes down; a text target (comment, message) has its text,
 * author and time copied onto the report (`removedContent`) before it is
 * deleted. Non-consensual reports get the text copy too. Nothing here bans
 * anyone automatically -- that stays the admin's call.
 */
async function snapshot(reportId, content, client = null) {
  await (client ? client.query.bind(client) : query)(
    `update reports set data = data || jsonb_build_object('removedContent', $2::jsonb) where id = $1`,
    [String(reportId), JSON.stringify(content)],
  );
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const { id, action } = req.body || {};
  if (!normalizeTargetId(id) || !['dismiss', 'remove_content'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | remove_content)' });
  }

  try {
    const report = await getReportById(String(id));
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const keepText = report.category === 'minor' || report.category === 'non_consensual';

    let contentNote = null;
    let preserved = 0;
    if (action === 'remove_content') {
      if (report.targetType === 'message') {
        if (typeof report.conversationId !== 'string' || typeof report.targetId !== 'string') {
          contentNote = 'already_gone';
        } else {
          // The evidence copy is written in the removal's own transaction,
          // before the message is dropped: a failed copy leaves the message
          // in place (and the report open) instead of losing the only record.
          const gone = await removeConversationMessage(report.conversationId, report.targetId, {
            beforeRemove: keepText
              ? (client, m) => snapshot(report.id, { type: 'message', text: m.text, senderId: String(m.senderId), createdAt: m.createdAt }, client)
              : undefined,
          });
          contentNote = gone ? 'removed' : 'already_gone';
        }
      } else if (report.targetType === 'listing') {
        const targetId = normalizeTargetId(report.targetId);
        if (targetId && report.category === 'minor') {
          const listing = await getListingById(targetId);
          if (listing) {
            const files = [...(Array.isArray(listing.media) ? listing.media : []), ...(Array.isArray(listing.retainedMedia) ? listing.retainedMedia : [])];
            preserved = (await withTransaction((client) =>
              preserveMedia(files, { reportId: reportRef('report', report.id), reason: `possible minor report (in-product) #${report.id}: listing ${targetId}`, client }),
            )).length;
          }
        }
        if (targetId && await markListingRemoved(targetId)) {
          contentNote = 'removed';
        } else {
          contentNote = 'already_gone';
        }
        if (preserved) await movePreservedToEvidence({ limit: preserved });
      } else if (report.targetType === 'wall_post') {
        const targetId = normalizeTargetId(report.targetId);
        if (!targetId) {
          contentNote = 'already_gone';
        } else {
          if (keepText) {
            const { rows } = await query('select data from wall_posts where id = $1', [targetId]);
            if (rows.length) {
              await snapshot(report.id, { type: 'wall_post', text: rows[0].data.text, authorId: String(rows[0].data.authorId ?? ''), createdAt: rows[0].data.createdAt });
            }
          }
          try {
            await deleteWallPost(targetId, 'admin', { isWallOwner: true });
            contentNote = 'removed';
          } catch (err) {
            // Only "it's already gone" is fine to treat as done. Anything
            // else (a DB error) must NOT be recorded as actioned -- the
            // content would stay live while the queue says it was removed.
            if (err.message !== 'Comment not found') throw err;
            contentNote = 'already_gone';
          }
        }
      } else {
        // An unrecognised target type cannot be acted on here, so it is not
        // marked actioned as though it had been.
        return res.status(400).json({ error: 'This report type cannot be actioned automatically. Dismiss it or handle it by hand.' });
      }
    }

    const updated = await updateReportStatus(report.id, action === 'dismiss' ? 'dismissed' : 'actioned', 'admin');
    return res.status(200).json({ ok: true, report: updated, content: contentNote, ...(preserved ? { preserved } : {}) });
  } catch (err) {
    console.error('[admin/reports-resolve] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong -- the report is still open. Please try again.' });
  }
}
