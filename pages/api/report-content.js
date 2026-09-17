import { addNciiReport } from '../../lib/ncii-reports-store';

// Deliberately unauthenticated -- required by the federal TAKE IT DOWN Act's
// notice-and-removal process, which must be usable by anyone depicted in
// non-consensual content, whether or not they have (or want) an account
// here. Do not add a login requirement to this endpoint.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { reporterName, reporterContact, contentLocation, description, consentStatement } = req.body || {};

  if (!reporterName || !reporterName.trim()) {
    return res.status(400).json({ error: 'Your name is required' });
  }
  if (!reporterContact || !reporterContact.trim()) {
    return res.status(400).json({ error: 'A way to contact you is required' });
  }
  if (!contentLocation || !contentLocation.trim()) {
    return res.status(400).json({ error: 'Please describe or link the specific content' });
  }
  if (!consentStatement) {
    return res.status(400).json({ error: 'You must confirm the statement below to submit a report' });
  }

  try {
    const report = await addNciiReport({ reporterName, reporterContact, contentLocation, description, consentStatement });
    return res.status(200).json({ ok: true, report: { id: report.id } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
