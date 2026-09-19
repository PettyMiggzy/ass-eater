import { requireAdminKey } from '../../../lib/admin-auth';
import {
  getPerformerRecords,
  createPerformerRecord,
  updatePerformerRecord,
  archivePerformerRecord,
  RecordsNotConfigured,
  UnderagePerformerRecord,
} from '../../../lib/performer-records-store';

// 18 U.S.C. §2257 performer records. Admin-key only, and there is
// deliberately no public or creator-facing read of this data anywhere.
export default async function handler(req, res) {
  if (!requireAdminKey(req, res)) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ records: await getPerformerRecords() });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      if (action === 'archive') {
        const { id, reason } = req.body || {};
        if (!id) return res.status(400).json({ error: 'Missing record id' });
        const record = await archivePerformerRecord(id, reason);
        if (!record) return res.status(409).json({ error: 'That record is already archived.' });
        return res.status(200).json({ ok: true, record });
      }

      if (action === 'update') {
        const { id, fields } = req.body || {};
        if (!id) return res.status(400).json({ error: 'Missing record id' });
        return res.status(200).json({ ok: true, record: await updatePerformerRecord(id, fields || {}) });
      }

      return res.status(200).json({ ok: true, record: await createPerformerRecord(req.body || {}) });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    // Configuration and validation failures are the admin's to act on, so
    // they get a real message. Anything else does not -- these handlers sit
    // over a table of government IDs and a raw driver error is the wrong
    // thing to hand back.
    if (err instanceof RecordsNotConfigured) return res.status(503).json({ error: err.message });
    if (err instanceof UnderagePerformerRecord) return res.status(400).json({ error: err.message });
    if (err instanceof Error && /required|not found|could not be read|too large|must be a/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[performer-records]', err);
    return res.status(500).json({
      error: req.method === 'GET' ? 'Could not load records.' : 'Could not save that record.',
    });
  }
}
