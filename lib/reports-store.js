import { query, rowToRecord, rowsToRecords } from './db';

/** Report target ids are bigint primary keys; anything else is refused before it reaches a cast. */
export const POSITIVE_INT_ID = /^[1-9]\d{0,17}$/;
export function normalizeTargetId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && POSITIVE_INT_ID.test(value.trim())) return value.trim();
  return null;
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
 * text and whose wall it is on, or the listing's title, status and seller.
 * Without this the admin panel showed only "Wall comment #41" and a
 * reporter's free-text reason, so content was removed (or left up) blind.
 *
 * `targetId` is always returned as a string, and a target that cannot be
 * resolved (deleted since, or a malformed id stored before ids were
 * validated) comes back as `{ exists: false }` rather than throwing -- one
 * bad row must not take down the whole moderation queue.
 */
export async function attachReportTargets(reports) {
  const wallIds = new Set();
  const listingIds = new Set();
  for (const r of reports) {
    const tid = normalizeTargetId(r.targetId);
    if (!tid) continue;
    if (r.targetType === 'wall_post') wallIds.add(tid);
    else if (r.targetType === 'listing') listingIds.add(tid);
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
        creatorId: row.data.creatorId != null ? String(row.data.creatorId) : null,
        creatorName: row.creator_name || null,
        creatorHandle: row.creator_handle || null,
      });
    }
  }

  return reports.map((r) => {
    const tid = normalizeTargetId(r.targetId);
    const target = (r.targetType === 'wall_post' ? posts : r.targetType === 'listing' ? listings : new Map()).get(tid)
      || { exists: false };
    return { ...r, targetId: tid || String(typeof r.targetId === 'object' ? JSON.stringify(r.targetId) : r.targetId ?? ''), target };
  });
}
