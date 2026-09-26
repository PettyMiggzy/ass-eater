import { query, rowToRecord, rowsToRecords, withTransaction } from './db';
import { holdMediaForReport, releaseHoldsForReport, reportRef } from './media-preservation';
import { sliceText } from './unicode-text';

/** Report target ids are bigint primary keys; anything else is refused before it reaches a cast. */
export const POSITIVE_INT_ID = /^[1-9]\d{0,17}$/;
export function normalizeTargetId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && POSITIVE_INT_ID.test(value.trim())) return value.trim();
  return null;
}

/**
 * What a report is about, chosen by the reporter from a fixed list. 'minor'
 * (someone who may be under 18) and 'non_consensual' (someone who didn't
 * agree to be shown) fire the no-PII operator alert (lib/alerts.js
 * sendReportAlert) and sort to the top of the admin queue; they never
 * trigger an automatic ban -- the admin decides. A report with no category
 * (an older client) is 'other'; an unknown value is refused.
 */
export const REPORT_CATEGORIES = ['minor', 'non_consensual', 'other'];
export const REPORT_REASON_MAX = 500;

/** Priority for the admin queue: minor first, then non-consensual, then the rest. */
export function reportPriority(report) {
  return report?.category === 'minor' ? 0 : report?.category === 'non_consensual' ? 1 : 2;
}

/**
 * Validates the reporter's free text and category. Returns
 * { reason, category } or { error, field, maxLength? } for a 400. A reason
 * over REPORT_REASON_MAX is refused, never cut: it used to be sliced to 500
 * characters with a 200, so the identifying detail at the end of a long
 * report was lost without anyone knowing.
 */
export function validateReportInput({ reason, category } = {}) {
  if (typeof reason !== 'string' || !reason.trim()) return { error: 'Tell us what is wrong.', field: 'reason' };
  const text = reason.trim();
  if (text.length > REPORT_REASON_MAX) {
    return { error: `Keep the reason to ${REPORT_REASON_MAX} characters or fewer.`, field: 'reason', maxLength: REPORT_REASON_MAX };
  }
  if (category !== undefined && category !== null && category !== '' && !REPORT_CATEGORIES.includes(category)) {
    return { error: 'Unknown report category.', field: 'category' };
  }
  return { reason: text, category: REPORT_CATEGORIES.includes(category) ? category : 'other' };
}

export async function getReports() {
  const { rows } = await query('select id, data from reports order by id');
  return rowsToRecords(rows);
}

export async function getReportById(id) {
  if (!normalizeTargetId(id)) return null;
  const { rows } = await query('select id, data from reports where id = $1', [String(id)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

/**
 * Files a report. `reportedContent` (built by the filing route from the
 * target as it stands right now -- see snapshotWallPost / snapshotMessage /
 * snapshotListing) is stored ON the report, so the evidence survives whatever
 * happens to the target next: the author deleting the comment, the sender
 * deleting their account, 500 newer messages pushing a DM out of storage, the
 * seller removing listing media. Reports used to hold only a pointer, and a
 * target gone before an admin looked left a possible-minor report with no
 * text, no author and nothing to preserve.
 *
 * `holdMedia` (a possible-minor listing report): those files are put on a
 * report hold in the SAME transaction as the report (lib/media-preservation.js
 * holdMediaForReport) -- nothing can delete them until the report is resolved,
 * but they keep being served.
 */
export async function addReport(report, { holdMedia = null } = {}) {
  // `...report` last, matching the previous behaviour: a caller may override
  // the defaults above it (a backfill supplying its own createdAt/status).
  const entry = { createdAt: new Date().toISOString(), status: 'open', ...report };
  delete entry.id; // the column is the id; a caller-supplied one would be ignored anyway
  return withTransaction(async (client) => {
    const { rows } = await client.query('insert into reports (data) values ($1) returning id, data', [entry]);
    const record = rowToRecord(rows[0]);
    if (holdMedia && holdMedia.length) {
      const held = await holdMediaForReport(holdMedia, reportRef('report', record.id), client);
      if (held.length) {
        const { rows: marked } = await client.query(
          `update reports set data = data || jsonb_build_object('heldMedia', $2::jsonb) where id = $1 returning id, data`,
          [record.id, JSON.stringify(held)],
        );
        return rowToRecord(marked[0]);
      }
    }
    return record;
  });
}

/**
 * The report as its REPORTER may see it (the filing response): without the
 * stored copy of the content or the held file list, which are admin evidence.
 */
export function reporterView(report) {
  if (!report) return report;
  const { reportedContent, heldMedia, ...rest } = report;
  return rest;
}

const SNAPSHOT_TEXT_MAX = 4000;
const cut = (v) => (typeof v === 'string' ? sliceText(v, SNAPSHOT_TEXT_MAX) : null);

// Who a user id is, at filing time, for the admin view (the account may be
// gone by the time anyone looks).
async function loginFor(userId, client = null) {
  if (userId === null || userId === undefined || userId === '') return null;
  const { rows } = await (client || { query }).query(
    `select data->>'email' as login, data->>'role' as role, data->>'creatorId' as creator_id from users where id = $1`,
    [String(userId)],
  );
  return rows[0] ? { login: rows[0].login || null, role: rows[0].role || null, creatorId: rows[0].creator_id || null } : null;
}

/** Filing-time copy of a wall comment (a wall_posts row's data). */
export async function snapshotWallPost(post, client = null) {
  const who = await loginFor(post?.authorId, client);
  return {
    type: 'wall_post',
    text: cut(post?.text),
    authorId: post?.authorId != null ? String(post.authorId) : null,
    authorName: cut(post?.authorName),
    authorLogin: who?.login || null,
    creatorId: post?.creatorId != null ? String(post.creatorId) : null,
    createdAt: post?.createdAt || null,
    capturedAt: new Date().toISOString(),
  };
}

/** Filing-time copy of one direct message. */
export async function snapshotMessage(message, { conversationId, participantIds } = {}, client = null) {
  const who = await loginFor(message?.senderId, client);
  return {
    type: 'message',
    text: cut(message?.text),
    senderId: message?.senderId != null ? String(message.senderId) : null,
    senderLogin: who?.login || null,
    senderRole: who?.role || null,
    senderCreatorId: who?.creatorId || null,
    priceCents: Number.isInteger(message?.priceCents) ? message.priceCents : null,
    createdAt: message?.createdAt || null,
    conversationId: conversationId || null,
    participantIds: Array.isArray(participantIds) ? participantIds.map(String) : [],
    capturedAt: new Date().toISOString(),
  };
}

/** Filing-time copy of a listing: its text and the srcs of every file. */
export function snapshotListing(listing) {
  const files = [
    ...(Array.isArray(listing?.media) ? listing.media : []),
    ...(Array.isArray(listing?.retainedMedia) ? listing.retainedMedia : []),
  ];
  return {
    type: 'listing',
    title: cut(listing?.title),
    description: cut(listing?.description),
    creatorId: listing?.creatorId != null ? String(listing.creatorId) : null,
    status: listing?.status || null,
    kind: listing?.kind || null,
    priceCents: Number.isInteger(listing?.priceCents) ? listing.priceCents : null,
    media: files
      .filter((m) => m && typeof m.src === 'string' && m.src)
      .map((m) => ({ type: m.type === 'video' ? 'video' : 'image', src: m.src })),
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Profile media a report can point at: one gallery item, or the avatar. The
 * report's targetId is the CREATOR's id and `src` names the item.
 */
export const PROFILE_MEDIA_TARGETS = ['gallery_item', 'avatar'];

/**
 * The profile item `src` names on `creator`, as it stands now, or null when it
 * is not (or no longer) there -- a gallery item by src, or the avatar when
 * `creator.img` is that src. Validated server-side: the reporter only names it.
 */
export function findProfileMediaItem(creator, targetType, src) {
  if (!creator || typeof src !== 'string' || !src) return null;
  if (targetType === 'avatar') {
    return creator.img === src ? { type: 'image', src, performers: creator.avatarPerformers || null } : null;
  }
  if (targetType === 'gallery_item') {
    const item = (Array.isArray(creator.gallery) ? creator.gallery : []).find((g) => g && g.src === src);
    return item ? { type: item.type === 'video' ? 'video' : 'image', src, performers: item.performers || null, aiGenerated: !!item.aiGenerated } : null;
  }
  return null;
}

/** Filing-time copy of a reported gallery item or avatar. */
export function snapshotProfileMedia(creator, targetType, item) {
  return {
    type: targetType,
    creatorId: creator?.id != null ? String(creator.id) : null,
    creatorName: cut(creator?.name),
    creatorHandle: cut(creator?.handle),
    media: item ? [{ type: item.type === 'video' ? 'video' : 'image', src: item.src }] : [],
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Before a user's wall comments or sent messages are deleted (account
 * deletion, a creator deleted by admin, a comment deleted by its author or the
 * wall owner), copies each one that a report points at onto that report --
 * for reports filed before filing-time snapshots existed, which only hold a
 * pointer. Reports that already carry `reportedContent` are left as filed.
 * Runs on the deleting transaction's `client`.
 *
 * `authorId`: comments written by / messages sent by this user.
 * `wallCreatorId`: every comment on this creator's wall.
 * `postId`: one comment.
 */
export async function snapshotReportedContentBeforeDelete(client, { authorId = null, wallCreatorId = null, postId = null } = {}) {
  const at = new Date().toISOString();
  if (authorId !== null || wallCreatorId !== null || postId !== null) {
    await client.query(
      `update reports r
          set data = r.data || jsonb_build_object('reportedContent', jsonb_build_object(
                'type', 'wall_post', 'text', w.data->'text', 'authorId', w.data->'authorId',
                'authorName', w.data->'authorName', 'creatorId', w.data->'creatorId',
                'createdAt', w.data->'createdAt', 'capturedAt', $4::text, 'capturedOn', 'deletion'))
         from wall_posts w
        where r.data->>'targetType' = 'wall_post'
          and r.data->>'targetId' = w.id::text
          and not (r.data ? 'reportedContent')
          and (($1::text is not null and w.data->>'authorId' = $1::text)
            or ($2::text is not null and w.data->>'creatorId' = $2::text)
            or ($3::text is not null and w.id::text = $3::text))`,
      [authorId === null ? null : String(authorId), wallCreatorId === null ? null : String(wallCreatorId), postId === null ? null : String(postId), at],
    );
  }
  if (authorId !== null) {
    await client.query(
      `update reports r
          set data = r.data || jsonb_build_object('reportedContent', jsonb_build_object(
                'type', 'message', 'text', m->'text', 'senderId', m->'senderId', 'priceCents', m->'priceCents',
                'createdAt', m->'createdAt', 'conversationId', c.id, 'participantIds', c.data->'participantIds',
                'capturedAt', $2::text, 'capturedOn', 'deletion'))
         from conversations c
              cross join lateral jsonb_array_elements(coalesce(c.data->'messages', '[]'::jsonb)) as m
        where r.data->>'targetType' = 'message'
          and r.data->>'conversationId' = c.id
          and m->>'id' = r.data->>'targetId'
          and m->>'senderId' = $1::text
          and not (r.data ? 'reportedContent')`,
      [String(authorId), at],
    );
  }
}

/**
 * Open reports in the two serious categories that point at content this
 * user wrote -- a comment they authored or a message they sent. Self-service
 * account deletion is refused while there is one (lib/users-store.js).
 */
export async function countOpenSeriousReportsAgainstUser(userId, client = null) {
  const { rows } = await (client || { query }).query(
    `select count(*)::int as n from reports r
      where r.data->>'status' = 'open'
        and r.data->>'category' in ('minor', 'non_consensual')
        and (
          (r.data->>'targetType' = 'wall_post' and (
             r.data->'reportedContent'->>'authorId' = $1
             or exists (select 1 from wall_posts w where w.id::text = r.data->>'targetId' and w.data->>'authorId' = $1)))
          or (r.data->>'targetType' = 'message' and (
             r.data->'reportedContent'->>'senderId' = $1
             or exists (select 1 from conversations c
                          cross join lateral jsonb_array_elements(coalesce(c.data->'messages', '[]'::jsonb)) as m
                         where c.id = r.data->>'conversationId' and m->>'id' = r.data->>'targetId' and m->>'senderId' = $1)))
        )`,
    [String(userId)],
  );
  return rows[0]?.n || 0;
}

export const REPORT_NOT_OPEN = 'report_not_open';
export const REPORT_NOT_FOUND = 'report_not_found';
export const REPORT_REASON_REQUIRED = 'report_reason_required';
export const REPORT_NOT_REOPENABLE = 'report_not_reopenable';
export const REPORT_NOTE_MAX = 1000;

function normalizeNote(note) {
  if (typeof note !== 'string') return null;
  const text = note.replace(/\s+/g, ' ').trim();
  return text ? sliceText(text, REPORT_NOTE_MAX) : null;
}

/** A dismissal of these categories takes a safety report off the queue, so it must say why. */
export function dismissNeedsReason(report) {
  return report?.category === 'minor' || report?.category === 'non_consensual';
}

/**
 * Moves an OPEN report to `status` ('actioned' | 'dismissed'), guarded on it
 * still being open inside the UPDATE, and appends to its `history`. Returns
 * the updated report, or null when it exists but is no longer open (a second
 * moderator, a stale tab) -- the caller answers 409 and must not overwrite the
 * first resolution. Throws REPORT_NOT_FOUND for no such report.
 *
 * A dismissal of a 'minor' / 'non_consensual' report requires `reason`
 * (REPORT_REASON_REQUIRED), stored as dismissReason and in history.
 */
export async function updateReportStatus(id, status, resolvedBy, { reason = null, client = null, extra = null } = {}) {
  const runner = client || { query };
  const note = normalizeNote(reason);
  const at = new Date().toISOString();
  const { rows } = await runner.query(
    `update reports
        set data = data || jsonb_build_object(
              'status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text,
              'dismissReason', case when $2::text = 'dismissed' then to_jsonb($5::text) else 'null'::jsonb end,
              'history', coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'action', $2::text, 'by', $3::text, 'at', $4::text, 'reason', $5::text))))
                   || coalesce($6::jsonb, '{}'::jsonb)
      where id = $1
        and data->>'status' = 'open'
      returning id, data`,
    [String(id), status, resolvedBy ?? null, at, note, extra ? JSON.stringify(extra) : null],
  );
  if (rows.length) return rowToRecord(rows[0]);
  const { rows: exists } = await runner.query('select 1 from reports where id = $1', [String(id)]);
  if (!exists.length) throw Object.assign(new Error('Report not found'), { code: REPORT_NOT_FOUND });
  return null;
}

/**
 * Puts a DISMISSED in-product report back in the open queue (a misclicked
 * dismissal of a possible-minor report used to be final). Reason required;
 * the dismissal and the reopening both stay in `history`. An 'actioned'
 * report cannot be reopened (its content is already down). A possible-minor
 * listing or profile-media report's files are put back on hold. Throws REPORT_NOT_FOUND /
 * REPORT_NOT_REOPENABLE / REPORT_REASON_REQUIRED.
 */
export async function reopenReport(id, { reason, by = 'admin' } = {}) {
  const note = normalizeNote(reason);
  if (!note) throw Object.assign(new Error('A reason is required to reopen a report.'), { code: REPORT_REASON_REQUIRED });
  const at = new Date().toISOString();
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `update reports
          set data = (data - 'resolvedBy' - 'resolvedAt' - 'dismissReason')
                     || jsonb_build_object(
                          'status', 'open', 'reopenedAt', $2::text, 'reopenedBy', $3::text,
                          'history', coalesce(data->'history', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
                            'action', 'reopened', 'by', $3::text, 'at', $2::text, 'reason', $4::text,
                            'previousReason', data->'dismissReason', 'previousResolvedAt', data->'resolvedAt')))
        where id = $1
          and data->>'status' = 'dismissed'
        returning id, data`,
      [String(id), at, by, note],
    );
    if (!rows.length) {
      const { rows: exists } = await client.query('select 1 from reports where id = $1', [String(id)]);
      if (!exists.length) throw Object.assign(new Error('Report not found'), { code: REPORT_NOT_FOUND });
      throw Object.assign(new Error('Only a dismissed report can be reopened.'), { code: REPORT_NOT_REOPENABLE });
    }
    const report = rowToRecord(rows[0]);
    if (report.category === 'minor' && (report.targetType === 'listing' || PROFILE_MEDIA_TARGETS.includes(report.targetType))) {
      const srcs = (report.reportedContent?.media || []).map((m) => m && m.src).filter(Boolean);
      if (srcs.length) await holdMediaForReport(srcs, reportRef('report', report.id), client);
    }
    return report;
  });
}

/** Releases a report's file holds (dismissal, or once its content is preserved/removed). */
export async function releaseReportHolds(id, client = null) {
  return releaseHoldsForReport(reportRef('report', id), client);
}

/**
 * What a moderator needs to see to act on a report: the reported comment's
 * text and whose wall it is on, the listing's title, status and seller, or a
 * reported direct message's text and sender.
 * Without this the admin panel showed only "Wall comment #41" and a
 * reporter's free-text reason, so content was removed (or left up) blind.
 *
 * `targetId` is always returned as a string, and a target that cannot be
 * resolved (deleted since, or a malformed id stored before ids were
 * validated) comes back as `{ exists: false }` rather than throwing -- one
 * bad row must not take down the whole moderation queue.
 */
function reportMediaItem(m, retained) {
  if (!m || typeof m !== 'object' || typeof m.src !== 'string' || !m.src) return null;
  return { type: m.type === 'video' ? 'video' : 'image', src: m.src, aiGenerated: !!m.aiGenerated, retained };
}

export async function attachReportTargets(reports) {
  const wallIds = new Set();
  const listingIds = new Set();
  const profileCreatorIds = new Set();
  for (const r of reports) {
    const tid = normalizeTargetId(r.targetId);
    if (!tid) continue;
    if (r.targetType === 'wall_post') wallIds.add(tid);
    else if (r.targetType === 'listing') listingIds.add(tid);
    else if (PROFILE_MEDIA_TARGETS.includes(r.targetType)) profileCreatorIds.add(tid);
  }

  // Gallery-item / avatar reports: the creator as it stands now, so the
  // moderator sees whether the reported item is still up.
  const profileCreators = new Map();
  if (profileCreatorIds.size) {
    const { rows } = await query('select id, data from creators where id = any($1::text[])', [[...profileCreatorIds]]);
    for (const row of rows) profileCreators.set(String(row.id), { ...row.data, id: row.id });
  }

  const messages = new Map();
  const messageReports = reports.filter((r) => r.targetType === 'message' && typeof r.conversationId === 'string');
  if (messageReports.length) {
    const { rows } = await query(
      `select id, data from conversations where id = any($1::text[])`,
      [[...new Set(messageReports.map((r) => r.conversationId))]],
    );
    const byId = new Map(rows.map((row) => [row.id, row.data]));
    const senderIds = new Set();
    for (const r of messageReports) {
      const convo = byId.get(r.conversationId);
      const m = (Array.isArray(convo?.messages) ? convo.messages : []).find((x) => x && x.id === r.targetId);
      if (m) senderIds.add(String(m.senderId));
    }
    const { rows: senders } = senderIds.size
      ? await query(`select id, data->>'email' as login, data->>'role' as role, data->>'creatorId' as creator_id from users where id = any($1::text[])`, [[...senderIds]])
      : { rows: [] };
    const senderById = new Map(senders.map((u) => [String(u.id), u]));
    for (const r of messageReports) {
      const convo = byId.get(r.conversationId);
      const m = (Array.isArray(convo?.messages) ? convo.messages : []).find((x) => x && x.id === r.targetId);
      if (!m) continue;
      const sender = senderById.get(String(m.senderId));
      messages.set(`${r.conversationId}|${r.targetId}`, {
        exists: true,
        text: m.text,
        senderId: String(m.senderId),
        senderLogin: sender?.login || null,
        senderRole: sender?.role || null,
        senderCreatorId: sender?.creator_id || null,
        participantIds: Array.isArray(convo?.participantIds) ? convo.participantIds.map(String) : [],
        createdAt: m.createdAt,
      });
    }
  }

  const posts = new Map();
  if (wallIds.size) {
    const { rows } = await query(
      `select w.id, w.data, c.data->>'name' as creator_name, c.data->>'handle' as creator_handle
         from wall_posts w
         left join creators c on c.id = w.data->>'creatorId'
        where w.id = any($1::bigint[])`,
      [[...wallIds]],
    );
    for (const row of rows) {
      posts.set(String(row.id), {
        exists: true,
        text: row.data.text,
        authorName: row.data.authorName,
        authorId: row.data.authorId != null ? String(row.data.authorId) : null,
        creatorId: row.data.creatorId != null ? String(row.data.creatorId) : null,
        creatorName: row.creator_name || null,
        creatorHandle: row.creator_handle || null,
        createdAt: row.data.createdAt,
      });
    }
  }

  const listings = new Map();
  if (listingIds.size) {
    const { rows } = await query(
      `select l.id, l.data, c.data->>'name' as creator_name, c.data->>'handle' as creator_handle
         from listings l
         left join creators c on c.id = l.data->>'creatorId'
        where l.id = any($1::bigint[])`,
      [[...listingIds]],
    );
    for (const row of rows) {
      listings.set(String(row.id), {
        exists: true,
        title: row.data.title,
        description: typeof row.data.description === 'string' ? sliceText(row.data.description, 500) : '',
        status: row.data.status,
        kind: row.data.kind,
        priceCents: row.data.priceCents,
        mediaCount: Array.isArray(row.data.media) ? row.data.media.length : 0,
        // The files themselves, so a moderator can SEE what was reported
        // before choosing Remove or Dismiss -- most listing reports are about
        // the media, not the title. ADMIN-ONLY: this function is served only
        // through the admin-key-gated /api/admin/reports, and each src is an
        // /api/media/... path that the admin media cookie authorises. Items
        // the creator removed from sale but kept for past buyers are included
        // too (retained: true) -- they are still being delivered.
        media: [
          ...(Array.isArray(row.data.media) ? row.data.media : []).map((m) => reportMediaItem(m, false)),
          ...(Array.isArray(row.data.retainedMedia) ? row.data.retainedMedia : []).map((m) => reportMediaItem(m, true)),
        ].filter(Boolean),
        filesDeleted: !!row.data.mediaDeletedAt,
        creatorId: row.data.creatorId != null ? String(row.data.creatorId) : null,
        creatorName: row.creator_name || null,
        creatorHandle: row.creator_handle || null,
      });
    }
  }

  // A target that is gone (deleted by its author, an account deletion, pushed
  // out of a conversation) falls back to the copy stored on the report at
  // filing time -- or, for older reports, the copy written when it was
  // deleted or removed -- flagged `fromSnapshot`, so a moderator still sees
  // what was reported and who wrote it instead of "no longer exists".
  const gone = (r) => {
    const snap = r.reportedContent || r.removedContent || null;
    if (!snap || typeof snap !== 'object') return { exists: false };
    const media = Array.isArray(snap.media) ? snap.media.map((m) => reportMediaItem(m, false)).filter(Boolean) : undefined;
    return { exists: false, fromSnapshot: true, ...snap, ...(media ? { media } : {}) };
  };
  return reports.map((r) => {
    if (PROFILE_MEDIA_TARGETS.includes(r.targetType)) {
      const tid = normalizeTargetId(r.targetId);
      const creator = tid ? profileCreators.get(tid) : null;
      const item = findProfileMediaItem(creator, r.targetType, r.src);
      const target = item
        ? {
          exists: true,
          creatorId: String(creator.id),
          creatorName: creator.name || null,
          creatorHandle: creator.handle || null,
          media: [reportMediaItem(item, false)].filter(Boolean),
        }
        : gone(r);
      return { ...r, targetId: tid || String(r.targetId ?? ''), target };
    }
    if (r.targetType === 'message') {
      const target = messages.get(`${r.conversationId}|${r.targetId}`) || gone(r);
      return { ...r, targetId: String(r.targetId ?? ''), target };
    }
    const tid = normalizeTargetId(r.targetId);
    const target = (r.targetType === 'wall_post' ? posts : r.targetType === 'listing' ? listings : new Map()).get(tid)
      || gone(r);
    return { ...r, targetId: tid || String(typeof r.targetId === 'object' ? JSON.stringify(r.targetId) : r.targetId ?? ''), target };
  });
}
