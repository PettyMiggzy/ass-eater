// The client-side AgeChecker popup (pages/verify-age.js) reports "accepted"
// via a JS callback, but that alone is bypassable -- anyone can fake the
// callback firing from devtools. This endpoint is meant to be the real gate:
// it should call AgeChecker's Server API with the verification UUID and our
// secret key to confirm the status server-side, and only then set
// lib/age-verification.js's signed cookie. NOT WIRED UP YET -- waiting on
// the Server API doc pages (endpoint URL, auth header shape, response
// format) before writing that call for real rather than guessing at it.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { uuid } = req.body || {};
  if (!uuid) {
    return res.status(400).json({ error: 'Missing verification uuid' });
  }

  return res.status(501).json({ error: 'Server-side verification confirmation is not wired up yet.' });
}
