/**
 * Admin takedown of ONE specific item -- a marketplace listing, a direct
 * message, or a wall comment -- optionally attributed to a TAKE IT DOWN
 * request (server-only).
 *
 * The takedown tab used to only record a resolution ("confirm you have
 * already removed it") while giving the admin no way to remove a listing, a
 * DM or a comment: the only per-item removal went through an in-product
 * report, which needs a logged-in reporter (and signups are closed), and a
 * manual ban keeps a sold listing's files serving to its buyers. This is the
 * missing control:
 *
 *   - listing: taken down with markListingRemoved -- WITHOUT keepPaid, so a
 *     paid listing's files come down too (mediaDeletedAt; delivery and
 *     /api/media stop serving them). This is a takedown of the content.
 *   - message: removed from its conversation (removeConversationMessage).
 *   - wall comment: deleted (deleteWallPost, as admin).
 *
 * Before anything is removed, a copy of the item (text, author/sender, time;
 * a listing's text and file list) is taken, and for a POSSIBLE MINOR request
 * -- or when the admin asks for it -- the listing's files are QUARANTINED
 * first (lib/media-preservation.js: kept, never served, never deleted) and
 * then moved to evidence/. Every takedown is written to moderation_actions
 * (the audit trail) and, when attributed, onto the request itself
 * (`takedowns` + `history`), which is what lets that request be resolved as
 * 'removed' (lib/ncii-reports-store.js resolveNciiReport requireTakedown).
 */
import { query, withTransaction } from './db';
import { getListingById, markListingRemoved } from './listings-store';
import { removeConversationMessage } from './messages-store';
import { deleteWallPost } from './wall-store';
import { preserveMedia, movePreservedToEvidence, reportRef } from './media-preservation';
import { snapshotListing, snapshotMessage, snapshotWallPost } from './reports-store';
import {
  recordNciiTakedown,
  preserveMediaForReportTx,
  NCII_REPORT_NOT_FOUND,
  normalizeNciiCategory,
} from './ncii-reports-store';

export const TAKEDOWN_TYPES = ['listing', 'message', 'wall_post'];
export const TAKEDOWN_INVALID = 'takedown_invalid';

const POSITIVE_INT = /^[1-9][0-9]{0,17}$/;

/**
 * Validates the request body into a target, or returns { error }.
 * { type: 'listing', listingId } | { type: 'message', conversationId, messageId }
 * | { type: 'wall_post', postId }
 */
export function parseTakedownTarget(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!TAKEDOWN_TYPES.includes(b.type)) return { error: 'type must be listing, message or wall_post' };
  if (b.type === 'listing') {
    const id = String(b.listingId ?? '').trim();
    if (!POSITIVE_INT.test(id)) return { error: 'Missing listing id' };
    return { target: { type: 'listing', listingId: id } };
  }
  if (b.type === 'wall_post') {
    const id = String(b.postId ?? '').trim();
    if (!POSITIVE_INT.test(id)) return { error: 'Missing comment id' };
    return { target: { type: 'wall_post', postId: id } };
  }
  const { conversationId, messageId } = b;
  if (typeof conversationId !== 'string' || !conversationId || conversationId.length > 300
    || typeof messageId !== 'string' || !messageId || messageId.length > 100) {
    return { error: 'Missing conversation id or message id' };
  }
  return { target: { type: 'message', conversationId, messageId } };
}

/**
 * Takes the target down. `nciiReportId` (optional) must name an existing
 * takedown request; a 'minor' one always quarantines the listing's files, and
 * `preserve: true` does so for any request. Throws NCII_REPORT_NOT_FOUND.
 * Returns { result: 'removed' | 'already_gone', preserved, snapshot, actionId }.
 */
export async function takeDownContent(target, { nciiReportId = null, preserve = false, by = 'admin' } = {}) {
  let ncii = null;
  if (nciiReportId !== null && nciiReportId !== undefined && nciiReportId !== '') {
    const { rows } = await query('select id, data from ncii_reports where id = $1', [String(nciiReportId)]);
    if (!rows.length) throw Object.assign(new Error('Report not found'), { code: NCII_REPORT_NOT_FOUND });
    ncii = { id: String(rows[0].id), category: normalizeNciiCategory(rows[0].data?.category) };
  }
  const quarantine = !!preserve || ncii?.category === 'minor';

  let result = 'already_gone';
  let snapshot = null;
  let preserved = [];

  if (target.type === 'listing') {
    const listing = await getListingById(target.listingId);
    if (listing) {
      snapshot = snapshotListing(listing);
      const files = [
        ...(Array.isArray(listing.media) ? listing.media : []),
        ...(Array.isArray(listing.retainedMedia) ? listing.retainedMedia : []),
      ];
      if (quarantine && files.length) {
        // Committed BEFORE the takedown deletes anything: markListingRemoved's
        // deletion re-checks preservation and skips these files.
        preserved = await withTransaction((client) => (ncii
          ? preserveMediaForReportTx(client, ncii.id, files, { reason: `takedown #${ncii.id}: listing ${target.listingId}` })
          : preserveMedia(files, { reportId: null, reason: `admin takedown: listing ${target.listingId}`, preservedBy: by, client })));
      }
      if (await markListingRemoved(target.listingId)) result = 'removed';
    }
  } else if (target.type === 'message') {
    const gone = await removeConversationMessage(target.conversationId, target.messageId, {
      // Copied inside the removal's own transaction, before the message is
      // dropped: a failed copy leaves the message in place.
      beforeRemove: async (client, m) => {
        const { rows } = await client.query('select data from conversations where id = $1', [target.conversationId]);
        snapshot = await snapshotMessage(m, { conversationId: target.conversationId, participantIds: rows[0]?.data?.participantIds }, client);
      },
    });
    if (gone) result = 'removed';
  } else if (target.type === 'wall_post') {
    const { rows } = await query('select data from wall_posts where id = $1', [target.postId]);
    if (rows.length) {
      snapshot = await snapshotWallPost(rows[0].data);
      try {
        await deleteWallPost(target.postId, 'admin', { isWallOwner: true });
        result = 'removed';
      } catch (err) {
        if (err.message !== 'Comment not found') throw err;
      }
    }
  } else {
    throw Object.assign(new Error('Unknown target type'), { code: TAKEDOWN_INVALID });
  }

  const entry = {
    type: target.type,
    target,
    result,
    preserved: preserved.length,
    snapshot,
    by,
  };
  const actionId = await withTransaction(async (client) => {
    const { rows } = await client.query(
      'insert into moderation_actions (data) values ($1) returning id',
      [{ action: 'content_takedown', ...entry, nciiReportId: ncii?.id || null, at: new Date().toISOString() }],
    );
    if (ncii) await recordNciiTakedown(ncii.id, { ...entry, actionId: String(rows[0].id) }, client);
    return String(rows[0].id);
  });
  if (preserved.length) await movePreservedToEvidence({ limit: Math.min(preserved.length, 200) });
  return { result, preserved: preserved.length, snapshot, actionId, reportRef: ncii ? reportRef('ncii', ncii.id) : null };
}

/** The audit trail, newest first (admin only). */
export async function listModerationActions({ nciiReportId = null, limit = 200 } = {}) {
  const { rows } = await query(
    `select id, data, created_at from moderation_actions
      where ($1::text is null or data->>'nciiReportId' = $1::text)
      order by id desc limit $2`,
    [nciiReportId === null || nciiReportId === undefined ? null : String(nciiReportId), Math.max(1, Math.min(Number(limit) || 200, 1000))],
  );
  return rows.map((r) => ({ id: String(r.id), ...r.data, createdAt: r.created_at }));
}
