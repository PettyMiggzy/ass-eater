/**
 * Suggested tags for a creator's profile, grouped for the dashboard's tag
 * picker.
 *
 * WHY THIS EXISTS: `sanitizeTags` (lib/creator-status.js) already accepts
 * any free text, and always has -- a creator could always type "feet". The
 * actual gap was that the dashboard offered nothing but a blank
 * comma-separated box, so search only ever surfaces whatever spelling a
 * creator happened to type. "feet", "foot", "footfetish" and "foot-fetish"
 * are four different strings to `/search?tag=`, and a fan clicking any one
 * of them finds only the creators who guessed the same way. A shared,
 * clickable vocabulary is what makes tagging (and therefore browsing)
 * actually work, not a bigger cap -- MAX_TAGS stays 8.
 *
 * This is real content taxonomy for an 18+ platform, not decoration --
 * explicit kink/fetish categories are listed plainly because a fan
 * searching for one is the exact discovery problem tagging exists to solve,
 * and euphemising the list would just recreate the spelling-fragmentation
 * problem one level up.
 *
 * Every value here is already in sanitizeTags' shape (lowercase, hyphenated,
 * <= 24 chars) so a click needs no further normalizing. This is a SUGGESTION
 * list, not a closed vocabulary -- the free-text box stays, so a creator
 * whose niche isn't listed can still type it, and existing tags on existing
 * profiles are never touched by adding to this file.
 */

export const TAG_GROUPS = [
  {
    label: 'Content type',
    tags: ['solo', 'boy-girl', 'girl-girl', 'boy-boy', 'group', 'couple', 'amateur', 'cosplay', 'roleplay', 'asmr', 'audio', 'gaming', 'fitness', 'lifestyle'],
  },
  {
    label: 'Who',
    tags: ['woman', 'man', 'trans', 'non-binary', 'mature', 'petite', 'curvy', 'bbw', 'muscular', 'tattooed', 'redhead', 'blonde', 'brunette'],
  },
  {
    label: 'Kink & fetish',
    tags: [
      'feet', 'findom', 'joi', 'bdsm', 'domination', 'submission', 'bondage', 'roleplay',
      'latex', 'leather', 'lingerie', 'stockings', 'heels', 'sph', 'cei', 'humiliation',
      'spanking', 'cuckold', 'voyeur', 'exhibitionist', 'anal', 'squirting', 'toys',
      'praise', 'aftercare', 'nylons', 'smoking', 'goth',
    ],
  },
  {
    label: 'Vibe',
    tags: ['girl-next-door', 'alt', 'glamour', 'gfe', 'dominant', 'submissive', 'sfw-teaser', 'artistic'],
  },
];

// Flat, deduped list -- used to render "already suggested" state so the same
// tag isn't offered twice if it appears in more than one group by accident,
// and so a search/filter over the picker has one list to check against.
export const ALL_SUGGESTED_TAGS = [...new Set(TAG_GROUPS.flatMap((g) => g.tags))];

/**
 * Suggested tags for a MARKETPLACE LISTING, not a creator profile.
 *
 * Reuses every group above -- a listing can honestly be "feet" or "latex"
 * content exactly the way a creator's profile can -- and adds one group
 * that only makes sense for a physical item someone ships: worn/used
 * goods, which is a real, common category on a platform like this (the
 * founder's own example), not a euphemism to build around.
 *
 * A LISTING_TAG_GROUPS constant separate from TAG_GROUPS, rather than one
 * list reused as-is, is what lets "Used/worn" show up on a listing's tag
 * picker without also showing up as a nonsensical suggestion on a
 * creator's own profile tags.
 */
export const LISTING_TAG_GROUPS = [
  ...TAG_GROUPS,
  {
    label: 'Physical goods',
    tags: ['used', 'worn', 'signed', 'handwritten-note', 'merch', 'packaging-included'],
  },
];

export const ALL_LISTING_SUGGESTED_TAGS = [...new Set(LISTING_TAG_GROUPS.flatMap((g) => g.tags))];

/**
 * The category links on the public landing page (pages/index.js).
 *
 * Each `tag` MUST be a value the profile tag picker above actually offers:
 * /search matches tags exactly, and these used to read 'men'/'women'/
 * 'couples' while the picker suggests 'man'/'woman'/'couple' -- so a creator
 * who tagged themselves exactly as suggested never appeared under the
 * homepage's own WOMEN link. lib/brand.test.mjs enforces this.
 *
 * Labels are plain words only; this list renders on the ungated landing
 * page, where nothing explicit may appear.
 */
export const LANDING_CATEGORIES = [
  { label: 'MEN', tag: 'man' },
  { label: 'WOMEN', tag: 'woman' },
  { label: 'COUPLES', tag: 'couple' },
  { label: 'TRANS', tag: 'trans' },
  { label: 'NON-BINARY', tag: 'non-binary' },
  { label: 'ALL CREATORS', tag: null },
];
