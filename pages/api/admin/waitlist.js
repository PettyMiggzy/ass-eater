import { getWaitlist, getWaitlistCounts, removeFromWaitlist, csvSafeCell } from '../../../lib/waitlist-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { refuseMalformedText } from '../../../lib/field-validation';

function toCsv(entries) {
  const header = ['email', 'roles', 'source', 'state', 'country', 'signed_up'];
  const rows = entries.map((e) => [
    e.email || '',
    (e.roles || []).join('|'),
    e.source || '',
    e.state || '',
    e.country || '',
    e.createdAt || '',
  ]);
  // Quote every field and double any embedded quote. Email addresses and a
  // source string should never contain a comma, but a list that silently
  // shifts a column when one does is worse than a slightly noisier file.
  //
  // csvSafeCell() first: quoting does NOT stop a spreadsheet evaluating a
  // cell that starts with = + - @. Both the email (the regex is deliberately
  // loose) and older `source` values come from a public form, so every cell
  // is neutralised, not just the ones that look suspicious.
  const escape = (v) => `"${csvSafeCell(v).replace(/"/g, '""')}"`;
  return [header, ...rows].map((r) => r.map(escape).join(',')).join('\r\n');
}

export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (!requireAdminKey(req, res)) return;

  if (req.method === 'GET') {
    const entries = await getWaitlist();

    if (req.query.format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="onlyone-waitlist.csv"');
      // A list of people who signed up to an adult platform is not something
      // a shared cache or a proxy should hold a copy of.
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      return res.status(200).send(toCsv(entries));
    }

    const counts = await getWaitlistCounts();
    return res.status(200).json({ entries, counts });
  }

  if (req.method === 'DELETE') {
    const id = req.query.id || (req.body || {}).id;
    if (!id) return res.status(400).json({ error: 'id is required' });
    try {
      await removeFromWaitlist(id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (err.message === 'Not on the list') return res.status(404).json({ error: err.message });
      console.error('[admin/waitlist] unexpected error:', err);
      return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
