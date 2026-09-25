import { query, rowToRecord, rowsToRecords } from './db';

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

export async function addReport(report) {
  // `...report` last, matching the previous behaviour: a caller may override
  // the defaults above it (a backfill supplying its own createdAt/status).
  const entry = { createdAt: new Date().toISOString(), status: 'open', ...report };
  delete entry.id; // the column is the id; a caller-supplied one would be ignored anyway
  const { rows } = await query('insert into reports (data) values ($1) returning id, data', [entry]);
  return rowToRecord(rows[0]);
}

export async function updateReportStatus(id, status, resolvedBy) {
  const { rows } = await query(
    `update reports
        set data = data || jsonb_build_object('status', $2::text, 'resolvedBy', $3::text, 'resolvedAt', $4::text)
      where id = $1
      returning id, data`,
    [id, status, resolvedBy ?? null, new Date().toISOString()],
  );
  if (!rows.length) throw new Error('Report not found');
  return rowToRecord(rows[0]);
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
  for (const r of reports) {
    const tid = normalizeTargetId(r.targetId);
    if (!tid) continue;
    if (r.targetType === 'wall_post') wallIds.add(tid);
    else if (r.targetType === 'listing') listingIds.add(tid);
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
        description: typeof row.data.description === 'string' ? row.data.description.slice(0, 500) : '',
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

  return reports.map((r) => {
    if (r.targetType === 'message') {
      const target = messages.get(`${r.conversationId}|${r.targetId}`) || { exists: false };
      return { ...r, targetId: String(r.targetId ?? ''), target };
    }
    const tid = normalizeTargetId(r.targetId);
    const target = (r.targetType === 'wall_post' ? posts : r.targetType === 'listing' ? listings : new Map()).get(tid)
      || { exists: false };
    return { ...r, targetId: tid || String(typeof r.targetId === 'object' ? JSON.stringify(r.targetId) : r.targetId ?? ''), target };
  });
}
