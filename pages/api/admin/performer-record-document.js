import { requireAdminKey } from '../../../lib/admin-auth';
import {
  attachPerformerDocument,
  readPerformerDocument,
  MAX_DOCUMENT_BYTES,
  RecordsNotConfigured,
} from '../../../lib/performer-records-store';

// The exact, complete set of plain-Error messages attachPerformerDocument()
// throws (lib/performer-records-store.js) -- an exact-string allowlist
// rather than a regex, same reasoning as admin/performer-records.js's fix.
const SAFE_MESSAGES = new Set([
  'An ID document must be a JPEG, PNG, WebP, HEIC or PDF.',
  'No document was received.',
  'That document is too large (4MB maximum).',
  'Record not found',
]);

// Raw body, like every other upload route here -- base64 in JSON would
// inflate a 3MB ID photo past Vercel's request limit for no gain.
export const config = { api: { bodyParser: false } };

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_DOCUMENT_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The one door to a performer's ID document.
 *
 * GET streams the decrypted file; POST attaches one. Both are admin-key
 * only. Nothing about this file is ever reachable from a public URL -- that
 * is the entire reason these live in Postgres rather than in Vercel Blob
 * alongside the photos and video, which is world-readable by design.
 */
export default async function handler(req, res) {
  if (!requireAdminKey(req, res)) return;

  const id = req.query.id || req.headers['x-record-id'];
  if (!id) return res.status(400).json({ error: 'Missing record id' });

  try {
    if (req.method === 'GET') {
      const doc = await readPerformerDocument(id);
      if (!doc) return res.status(404).json({ error: 'No document on file for that record' });
      // no-store, and never a shared cache: a proxy holding a copy of a
      // government ID is exactly what this design is avoiding.
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      res.setHeader('Content-Type', doc.meta.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${(doc.meta.fileName || `record-${id}`).replace(/"/g, '')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(doc.buffer);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return res.status(413).json({ error: 'That document is too large (4MB maximum).' });
      const record = await attachPerformerDocument(id, body, req.headers['content-type'], req.headers['x-file-name']);
      return res.status(200).json({ ok: true, record });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    if (err instanceof RecordsNotConfigured) return res.status(503).json({ error: err.message });
    if (err instanceof Error && SAFE_MESSAGES.has(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    // A key-rotation/config problem, not a bad request -- the admin needs
    // this exact message to go fix it, same reasoning RecordsNotConfigured
    // gets its own real message above rather than the generic fallback.
    if (err instanceof Error && err.message === 'That document could not be decrypted (check RECORDS_ENCRYPTION_KEY).') {
      console.error('[performer-record-document] decrypt failure:', err);
      return res.status(500).json({ error: err.message });
    }
    console.error('[performer-record-document]', err);
    return res.status(500).json({ error: 'Could not handle that document.' });
  }
}
