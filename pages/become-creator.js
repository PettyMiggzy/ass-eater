/**
 * Retired. This was a second, older creator-onboarding form whose API
 * (pages/api/creator/submit.js) created a pending creator profile with NO
 * login account behind it: once approved, the creator could never sign in,
 * edit, upload, message anyone or be paid, and the contact email was
 * optional, so often there was no way to reach them either. Creator signup
 * now has exactly one path -- /signup?role=creator -- which creates the
 * profile and the account that owns it together.
 *
 * Kept as a redirect rather than deleted so old links (and anything still
 * pointing here) land somewhere that works.
 */
export async function getServerSideProps() {
  return { redirect: { destination: '/signup?role=creator', permanent: false } };
}

export default function BecomeCreator() {
  return null;
}
