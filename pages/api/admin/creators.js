import { getCreators } from '../../../lib/creators-store';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_UPLOAD_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const creators = await getCreators();
    return res.status(200).json({ creators });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
