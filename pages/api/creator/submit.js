// Retired: 410 Gone. See pages/become-creator.js for why -- this endpoint
// created a pending creator profile with no login account, so an approved
// applicant could never use it. Creator signup is /api/auth/signup with
// role "creator" now, which creates the profile and its account in one
// transaction.
//
// The body parser stays off so a retired endpoint never buffers an upload
// it is going to refuse anyway.
export const config = {
  api: {
    bodyParser: false,
  },
};

export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(410).json({
    error: 'This application form has been retired. Create a creator account at /signup?role=creator instead.',
  });
}
