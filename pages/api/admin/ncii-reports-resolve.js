import { updateNciiReportStatus } from '../../../lib/ncii-reports-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { id, action } = req.body || {};
  if (!id || !['dismiss', 'removed'].includes(action)) {
    return res.status(400).json({ error: 'Missing report id or invalid action (dismiss | removed)' });
  }

  try {
    const updated = await updateNciiReportStatus(id, action, 'admin');
    return res.status(200).json({ ok: true, report: updated });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
