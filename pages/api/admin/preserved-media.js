import { requireAdminKey } from '../../../lib/admin-auth';
import { listPreservedMedia, sendPreservedMedia } from '../../../lib/media-preservation';
import { preserveMediaForReport, NCII_REPORT_NOT_FOUND } from '../../../lib/ncii-reports-store';
import { getCreatorById } from '../../../lib/creators-store';
import { query } from '../../../lib/db';

/**
 * Preserved evidence (lib/media-preservation.js). Admin key header ONLY --
 * the admin media cookie that lets the panel's <img> tags load /api/media
 * deliberately does not work here, so nothing preserved can be embedded or
 * opened by a stray page load.
 *
 * GET  ?report=ncii:12          -> 200 { ok, items: [{ pathname, reportId, reason, preservedBy,
 *                                    preservedAt, retainUntil, evidencePathname, movedAt,
 *                                    missingAt, lastExportedAt, exportCount }] }
 *      (report optional; 'ncii:<id>' or 'report:<id>')
 * GET  ?pathname=<original pathname>&download=1
 *                               -> the file, as an attachment (every export is counted on its row)
 * POST { nciiReportId, srcs?: string[], creatorId? }
 *                               -> 200 { ok, reportId, preserved: pathname[] }
 *      Quarantines specific items (srcs) and/or every file of a creator
 *      (creatorId) for a takedown request, BEFORE removing them -- for
 *      content reported as showing a minor that resolving the report against
 *      a creator does not cover. Preserved files are never deleted and never
 *      served by /api/media.
 */
const MAX_SRCS = 500;

export default async function handler(req, res) {
  if (!requireAdminKey(req, res)) return;
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method === 'GET') {
    try {
      if (typeof req.query.pathname === 'string' && req.query.pathname) {
        if (req.query.pathname.length > 512) return res.status(400).json({ error: 'Invalid pathname' });
        return await sendPreservedMedia(res, req.query.pathname);
      }
      const report = typeof req.query.report === 'string' && /^(ncii|report):[0-9]{1,18}$/.test(req.query.report) ? req.query.report : null;
      return res.status(200).json({ ok: true, items: await listPreservedMedia({ reportId: report }) });
    } catch (err) {
      console.error('[admin/preserved-media] read failed:', err);
      if (!res.headersSent) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
      return undefined;
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const reportId = String(body.nciiReportId ?? '');
  if (!/^[1-9][0-9]{0,17}$/.test(reportId)) return res.status(400).json({ error: 'Missing takedown report id' });
  const srcs = body.srcs === undefined ? [] : body.srcs;
  if (!Array.isArray(srcs) || srcs.length > MAX_SRCS || srcs.some((s) => typeof s !== 'string' || s.length > 2048)) {
    return res.status(400).json({ error: 'Invalid list of items' });
  }
  const creatorId = body.creatorId;
  if (creatorId !== undefined && creatorId !== null && creatorId !== '' && typeof creatorId !== 'string' && typeof creatorId !== 'number') {
    return res.status(400).json({ error: 'Invalid creator id' });
  }

  try {
    const items = [...srcs];
    if (creatorId !== undefined && creatorId !== null && creatorId !== '') {
      const creator = await getCreatorById(String(creatorId));
      if (!creator) return res.status(404).json({ error: 'Creator not found' });
      items.push(creator.img, creator.video, ...(Array.isArray(creator.gallery) ? creator.gallery : []));
      const { rows } = await query(`select data from listings where data->>'creatorId' = $1`, [String(creator.id)]);
      for (const r of rows) {
        items.push(...(Array.isArray(r.data?.media) ? r.data.media : []), ...(Array.isArray(r.data?.retainedMedia) ? r.data.retainedMedia : []));
      }
    }
    if (!items.length) return res.status(400).json({ error: 'Nothing to preserve' });
    const out = await preserveMediaForReport(reportId, items);
    return res.status(200).json({ ok: true, ...out });
  } catch (err) {
    if (err.code === NCII_REPORT_NOT_FOUND) return res.status(404).json({ error: 'Report not found' });
    console.error('[admin/preserved-media] preserve failed:', err);
    return res.status(500).json({ error: 'Something went wrong. Nothing was removed -- please try again.' });
  }
}
