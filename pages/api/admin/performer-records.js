import { requireAdminKey } from '../../../lib/admin-auth';
import {
  getPerformerRecords,
  createPerformerRecord,
  updatePerformerRecord,
  archivePerformerRecord,
  searchPerformerRecords,
  RECORD_REQUIRED_BY_LIVE_CREATOR,
  RecordsNotConfigured,
  UnderagePerformerRecord,
} from '../../../lib/performer-records-store';
import { refuseMalformedText } from '../../../lib/field-validation';

// The exact, complete set of plain-Error messages
// lib/performer-records-store.js's create/update/archive paths throw --
// an exact-string allowlist rather than a regex, same fix already applied
// to credits/buy.js and admin/manual-credit.js's err.code checks: matching
// on curated words risked a real Postgres error someday coincidentally
// containing one of them and leaking past the generic fallback below.
const SAFE_MESSAGES = new Set([
  'A legal name is required.',
  'A date of birth is required.',
  'That date of birth or production date could not be read.',
  'The production date cannot be in the future.',
  'An archived record is read-only.',
  'Record not found',
]);

// 18 U.S.C. §2257 performer records. Admin-key only, and there is
// deliberately no public or creator-facing read of this data anywhere.
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (!requireAdminKey(req, res)) return;

  try {
    if (req.method === 'GET') {
      // ?q= searches server-side: aliases, legal name, recorded URLs, and a
      // pasted creator-page or media URL resolved to the records linked to
      // that creator plus the co-performers attested on that exact item.
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 500) : '';
      return res.status(200).json({ records: q.trim() ? await searchPerformerRecords(q) : await getPerformerRecords() });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      if (action === 'archive') {
        const { id, reason, confirmUnrecordedLiveCreator } = req.body || {};
        if (!id) return res.status(400).json({ error: 'Missing record id' });
        const record = await archivePerformerRecord(id, reason, { confirmUnrecordedLiveCreator: confirmUnrecordedLiveCreator === true });
        if (!record) return res.status(409).json({ error: 'That record is already archived.' });
        return res.status(200).json({ ok: true, record });
      }

      if (action === 'update') {
        const { id, fields, confirmUnrecordedLiveCreator } = req.body || {};
        if (!id) return res.status(400).json({ error: 'Missing record id' });
        if (fields !== undefined && (fields === null || typeof fields !== 'object' || Array.isArray(fields))) {
          return res.status(400).json({ error: 'Invalid fields' });
        }
        const record = await updatePerformerRecord(id, fields || {}, { confirmUnrecordedLiveCreator: confirmUnrecordedLiveCreator === true });
        return res.status(200).json({ ok: true, record });
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
    // Would leave a live creator with no §2257 record: the panel shows this
    // and can resend with confirmUnrecordedLiveCreator: true.
    if (err && err.code === RECORD_REQUIRED_BY_LIVE_CREATOR) {
      return res.status(409).json({ error: err.message, code: err.code, creatorId: err.creatorId });
    }
    if (err instanceof Error && SAFE_MESSAGES.has(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[performer-records]', err);
    return res.status(500).json({
      error: req.method === 'GET' ? 'Could not load records.' : 'Could not save that record.',
    });
  }
}
