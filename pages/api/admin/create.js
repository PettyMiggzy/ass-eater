import { createCreator } from '../../../lib/creators-store';
import { requireAdminKey } from '../../../lib/admin-auth';
import { validateTextFields, normalizeHandle, isAllowedAvatarSrc } from '../../../lib/field-validation';
import { screenPublicText, publicProfileTextEntries } from '../../../lib/prohibited-terms';
import { isHandleConflict, HANDLE_TAKEN_MESSAGE } from '../../../lib/users-store';
import { parseCategoriesInput } from '../../../lib/categories';

// The only fields "+ Add Model" may set. Everything else -- founding,
// foundingSince, status, seed, contentViolationCount, id -- is the
// platform's to decide: spreading the body straight into the record let a
// caller skip the 100-slot Founding cap and the "window cannot be set by
// hand" rule that pages/api/admin/profile.js enforces, publish a model with
// no review, or mark a real one as seed data. `categories` is accepted too,
// but parsed separately below (a list of keys, not text).
const CREATE_FIELDS = ['name', 'handle', 'bio', 'price', 'img'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!requireAdminKey(req, res)) return;

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const profile = {};
  for (const key of CREATE_FIELDS) {
    if (key in body) profile[key] = body[key];
  }

  // Same crash class as pages/api/admin/profile.js -- this writes a brand
  // new creator's name/handle/bio straight through, and a non-string value
  // here 500s /search and /creators the moment this creator is publicly
  // visible.
  const invalid = validateTextFields(profile, ['name', 'handle', 'bio', 'price', 'img']);
  if (invalid) return res.status(400).json({ error: invalid });
  // Trimmed like every other write path; a blank name falls back to the
  // store's placeholder rather than being stored as whitespace.
  if (typeof profile.name === 'string') {
    profile.name = profile.name.trim();
    if (!profile.name) delete profile.name;
  }

  // No handle yet is the normal case: the panel posts an empty body. It used
  // to default to '@newmodel', which the unique index then refused for every
  // second click of "+ Add Model" until the first model was renamed. A blank
  // handle is excluded from the index, and the model can't go live without
  // one being set (pages/api/admin/profile.js).
  const { handle, error: handleError } = normalizeHandle(profile.handle ?? '', { allowBlank: true });
  if (handleError) return res.status(400).json({ error: handleError });
  profile.handle = handle;

  // Browse categories (lib/categories.js): known keys only, at most three.
  if ('categories' in body) {
    const { value, error } = parseCategoriesInput(body.categories);
    if (error) return res.status(400).json({ error: `Nothing was created -- ${error}` });
    profile.categories = value;
  }

  // No id exists yet, so only a site image is acceptable; an uploaded avatar
  // is set afterwards through the avatar upload.
  if ('img' in profile && profile.img && !isAllowedAvatarSrc(profile.img, null)) {
    return res.status(400).json({ error: 'The avatar must be a site image under /images/ -- upload a real one after creating the model.' });
  }

  for (const [context, value] of publicProfileTextEntries(profile)) {
    const hit = screenPublicText(value);
    if (hit) {
      return res.status(400).json({ error: `Nothing was created -- the ${context} field was refused (flagged: ${hit.reasons.join(', ')}).` });
    }
  }

  try {
    // Always pending: a new model is a draft the admin fills in and then
    // approves through the normal pending -> active path (which is also
    // where the §2257 record check and the Founding auto-grant live). It
    // used to be created with no status, which isPubliclyVisible() reads as
    // live -- a placeholder "New Model" on /creators the moment it existed.
    const creator = await createCreator({ ...profile, status: 'pending' });
    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    // Only the handle-uniqueness indexes mean "handle taken". Anything else
    // (e.g. a creator-id sequence collision) is a server problem and must not
    // be reported as a naming one.
    if (isHandleConflict(err)) {
      return res.status(409).json({ error: HANDLE_TAKEN_MESSAGE });
    }
    console.error('[admin/create] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
