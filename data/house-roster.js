// The AI "house" model roster: fictional adult characters whose photo sets
// OnlyOne itself sells in the marketplace (owner decision, 2026-09-27: "fill
// it up with models and chargeable content"). Installed and kept in sync by
// POST /api/admin/house-roster (lib/house-roster.js); nothing here reaches the
// database on its own.
//
// Rules this file is held to (lib/b1roster.test.mjs checks the text):
//  - Every model is plainly an AI character and says so in its bio. Every
//    surface labels them "AI MODEL" (components/public/cards.js).
//  - Every model is a clearly adult character (late 20s to 30s look).
//  - No invented activity: no follower, sale, view or rating numbers anywhere.
//  - Every image is clearly adult and viewed by a person before it is used.
//    The PUBLIC images -- avatars, covers and the two free profile previews
//    (free-1/free-2) under public/images/house/<slug>/, behind the age gate
//    like every /images/ file -- are clothed. What is SOLD may be explicit
//    (owner decision, 2026-09-27: see-through lingerie to nude photo sets and
//    explicit video clips): six photos and three clips per model, made by the
//    owner and uploaded through /admin straight to the private Blob store
//    (POST /api/admin/house-sale-image); never committed to git or put under
//    public/. The install copies them into each listing, where /api/media
//    only serves them to buyers.
//  - All text passes lib/prohibited-terms.js and
//    lib/payment-circumvention-filter.js.
//
// Sale slots: 1-6 are the photos, 7-9 the video clips (MP4). A model goes on
// sale once its six photos are uploaded; each video listing goes on sale once
// the clips it holds are uploaded too.
//
// Video listings: each clip on its own ($8) and all three together ($20).
//
// Photo listing plan, the same for every model (6 sale images, 5 listings):
//   Set I (photos 1-2), Set II (3-4), Set III (5-6), a Sets I + II bundle
//   (photos 1-4) and the complete 3-set bundle (all 6). Each description says
//   which photos it holds and that bundles repeat photos from the sets, so
//   nobody pays twice for the same image without being told.
//   Prices (deliberate, 2026-09-27): sets $5/$7/$9, the 4-photo bundle $12,
//   the complete 3-set bundle $15. The brief also named a "full 6-pack $25",
//   but with six photos the 3-set bundle IS all six, so a $25 listing would
//   charge more for the identical photos; it was left out rather than sold.

export const HOUSE_BIO_SUFFIX = 'AI model by OnlyOne: a fictional adult character, not a real person.';

export const HOUSE_MODELS = [
  {
    slug: 'nova-reyes',
    name: 'Nova Reyes',
    handle: '@novareyes_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'latina', 'brunette', 'satin', 'glamour'],
    collection: 'Neon Satin',
    bio: 'Nova loves late nights, black satin and a pink neon glow. Warm, playful and camera-confident.',
  },
  {
    slug: 'sienna-blake',
    name: 'Sienna Blake',
    handle: '@siennablake_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'redhead', 'freckles', 'glamour', 'velvet'],
    collection: 'Copper and Velvet',
    bio: 'Sienna is all copper hair, freckles and slow smiles. Classic glamour with a little mischief.',
  },
  {
    slug: 'kira-sato',
    name: 'Kira Sato',
    handle: '@kirasato_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'asian', 'bob haircut', 'red lips', 'editorial'],
    collection: 'Red Lip Nights',
    bio: 'Kira is sharp lines, a sleek black bob and red lipstick. Editorial style after dark.',
  },
  {
    slug: 'amara-cole',
    name: 'Amara Cole',
    handle: '@amaracole_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'curly hair', 'gold hoops', 'glamour', 'black dress'],
    collection: 'Gold and Shadow',
    bio: 'Amara brings big curls, gold hoops and total confidence. Soft light, bold looks.',
  },
  {
    slug: 'dante-cruz',
    name: 'Dante Cruz',
    handle: '@dantecruz_ai',
    categories: ['men', 'ai'],
    tags: ['ai model', 'bearded', 'athletic', 'dark and moody', 'menswear'],
    collection: 'After Hours',
    bio: 'Dante is a trimmed beard, an open collar and a low voice you can almost hear. Moody and relaxed.',
  },
  {
    slug: 'rhys-halden',
    name: 'Rhys Halden',
    handle: '@rhyshalden_ai',
    categories: ['men', 'ai'],
    tags: ['ai model', 'blond', 'muscular', 'fitness', 'menswear'],
    collection: 'Blue Hour',
    bio: 'Rhys is blond, blue-eyed and built like he never skips a workout. Easy smile, strong looks.',
  },
  {
    slug: 'mila-and-jax',
    name: 'Mila and Jax',
    handle: '@milaandjax_ai',
    categories: ['couples', 'ai'],
    tags: ['ai model', 'couple', 'romantic', 'date night', 'glamour'],
    collection: 'Date Night',
    bio: 'Mila and Jax are a couple who dress up for each other. Romantic, close and a little cheeky.',
  },
  {
    slug: 'valentina-rose',
    name: 'Valentina Rose',
    handle: '@valentinarose_ai',
    categories: ['trans', 'ai'],
    tags: ['ai model', 'trans', 'platinum blonde', 'glamour', 'elegant'],
    collection: 'Platinum Glow',
    bio: 'Valentina is platinum hair, soft glam and tall, elegant poses. Old Hollywood with a neon twist.',
  },
  {
    slug: 'luna-vega',
    name: 'Luna Vega',
    handle: '@lunavega_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'brunette', 'curvy', 'lingerie', 'glamour'],
    collection: 'Come In',
    bio: 'Luna is the girl from the door: caramel waves, a heart tattoo and an invitation you should accept.',
  },
  {
    slug: 'raven-black',
    name: 'Raven Black',
    handle: '@ravenblack_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'goth', 'emo', 'piercings', 'alternative'],
    collection: 'Black Velvet',
    bio: 'Raven is black bangs, heavy eyeliner and a sharp tongue. Moody on the outside, needy on the inside.',
  },
  {
    slug: 'vanessa-lane',
    name: 'Vanessa Lane',
    handle: '@vanessalane_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'milf', 'blonde', 'mature', 'glamour'],
    collection: 'After Dark',
    bio: 'Vanessa is honey blonde, polished and completely in charge. Experienced, elegant and never in a hurry.',
  },
  {
    slug: 'brooke-hayes',
    name: 'Brooke Hayes',
    handle: '@brookehayes_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'pawg', 'blonde', 'curvy', 'booty'],
    collection: 'Peach Season',
    bio: 'Brooke is blonde, bubbly and very proud of her curves. Tiny waist, big smile, bigger everything else.',
  },
  {
    slug: 'daisy-monroe',
    name: 'Daisy Monroe',
    handle: '@daisymonroe_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'bbw', 'curvy', 'redhead', 'plus size'],
    collection: 'Soft Glow',
    bio: 'Daisy is auburn hair, soft curves and total body confidence. Sweet, warm and a little cheeky.',
  },
  {
    slug: 'nia-james',
    name: 'Nia James',
    handle: '@niajames_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'ebony', 'braids', 'curvy', 'glamour'],
    collection: 'Midnight Gold',
    bio: 'Nia is long braids, a big laugh and a bossy streak. Thick curves and all the confidence in the room.',
  },
  {
    slug: 'camila-ortiz',
    name: 'Camila Ortiz',
    handle: '@camilaortiz_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'latina', 'curly hair', 'curvy', 'hourglass'],
    collection: 'Fuego',
    bio: 'Camila is dark curls, sun-warm skin and a fiery heart. Passionate, affectionate and never shy.',
  },
  {
    slug: 'tiffany-blaze',
    name: 'Tiffany Blaze',
    handle: '@tiffanyblaze_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'blonde', 'busty', 'bimbo', 'glam'],
    collection: 'Pink Diamond',
    bio: 'Tiffany is platinum hair, glossy pink lips and a giggle you can hear. She loves attention and pink everything.',
  },
  {
    slug: 'jade-voss',
    name: 'Jade Voss',
    handle: '@jadevoss_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'tattooed', 'alt girl', 'pink hair', 'piercings'],
    collection: 'Ink and Neon',
    bio: 'Jade is pastel pink hair, full sleeves and a septum ring. Laid-back, witty and a little kinky.',
  },
  {
    slug: 'skye-rivers',
    name: 'Skye Rivers',
    handle: '@skyerivers_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'fitness', 'athletic', 'muscular', 'abs'],
    collection: 'Pump Hour',
    bio: 'Skye is a ponytail, sculpted abs and a competitive streak. High energy from warm-up to cool-down.',
  },
  {
    slug: 'scarlett-vane',
    name: 'Scarlett Vane',
    handle: '@scarlettvane_ai',
    categories: ['women', 'ai'],
    tags: ['ai model', 'bondage', 'bdsm', 'redhead', 'leather'],
    collection: 'Leather and Lace',
    bio: 'Scarlett is red hair, red lips and a leather collar. Commanding, teasing and all about consensual power play.',
  },
];

/**
 * The listings every model gets. `images` are sale slot numbers: 1-6 photos,
 * 7-9 video clips (`clip: true` plans hold only clips).
 */
export const HOUSE_LISTINGS = [
  { key: 'set-1', label: 'Set I', images: [1, 2], priceCents: 500 },
  { key: 'set-2', label: 'Set II', images: [3, 4], priceCents: 700 },
  { key: 'set-3', label: 'Set III', images: [5, 6], priceCents: 900 },
  { key: 'bundle-1-2', label: 'Sets I + II bundle', images: [1, 2, 3, 4], priceCents: 1200 },
  { key: 'bundle-all', label: 'Complete 3-set bundle', images: [1, 2, 3, 4, 5, 6], priceCents: 1500 },
  { key: 'clip-1', label: 'Video 1', images: [7], priceCents: 800, clip: true },
  { key: 'clip-2', label: 'Video 2', images: [8], priceCents: 800, clip: true },
  { key: 'clip-3', label: 'Video 3', images: [9], priceCents: 800, clip: true },
  { key: 'clips-all', label: 'All 3 videos', images: [7, 8, 9], priceCents: 2000, clip: true },
];

/** Photo slots are 1..HOUSE_SALE_IMAGE_COUNT. */
export const HOUSE_SALE_IMAGE_COUNT = 6;
/** Video clip slots follow the photos: 7..9. */
export const HOUSE_SALE_CLIP_COUNT = 3;
export const HOUSE_SALE_SLOT_COUNT = HOUSE_SALE_IMAGE_COUNT + HOUSE_SALE_CLIP_COUNT;

/** Whether sale slot `n` is a video clip (7-9) rather than a photo. */
export function isHouseClipSlot(n) {
  return Number.isInteger(n) && n > HOUSE_SALE_IMAGE_COUNT && n <= HOUSE_SALE_SLOT_COUNT;
}

export function houseBio(model) {
  return `${model.bio} ${HOUSE_BIO_SUFFIX}`;
}

export function houseListingTitle(model, plan) {
  if (plan.clip) {
    return plan.images.length === 1
      ? `${model.collection}: ${plan.label} (video clip)`
      : `${model.collection}: ${plan.label} (${plan.images.length} video clips)`;
  }
  return `${model.collection}: ${plan.label} (${plan.images.length} photos)`;
}

export function houseListingDescription(model, plan) {
  if (plan.clip) {
    const which = plan.images.length === 1
      ? `video ${plan.images[0] - HOUSE_SALE_IMAGE_COUNT} of 3`
      : 'all 3 videos';
    const overlap = plan.images.length > 1
      ? ' This bundle repeats the videos sold one at a time, so skip it if you already own them.'
      : ' The same video is also part of the 3-video bundle.';
    return `An explicit AI-generated video of ${model.name}, a fictional adult character: ${which} from the ${model.collection} collection. Digital item, available in your order history right after purchase.${overlap} Sold by OnlyOne. No real person is depicted.`
      .replace('An explicit AI-generated video', plan.images.length > 1 ? `${plan.images.length} explicit AI-generated videos` : 'An explicit AI-generated video');
  }
  const which = plan.images.length === HOUSE_SALE_IMAGE_COUNT
    ? 'all 6 photos from Sets I, II and III'
    : `photos ${plan.images.join(', ')} of the ${model.collection} collection`;
  const overlap = plan.images.length > 2
    ? ' This bundle repeats the photos sold in the single sets, so skip it if you already own those sets.'
    : ' The same photos are also part of the bundles.';
  return `${plan.images.length} high-resolution AI-generated photos of ${model.name}, a fictional adult character: ${which}. Digital item, available in your order history right after purchase.${overlap} Sold by OnlyOne. No real person is depicted.`;
}

export function houseAvatarSrc(slug) {
  return `/images/house/${slug}/avatar.jpg`;
}

export function houseCoverSrc(slug) {
  return `/images/house/${slug}/cover.jpg`;
}

// Owner decision (2026-09-27): the avatar and cover -- what people see first --
// stay tasteful and clothed; a visitor who opens a profile gets a couple of
// free, flirtier (still clothed) previews; the lingerie sets are the paid ones.
export const HOUSE_FREE_IMAGE_COUNT = 2;

/** The n-th (1-based) free profile preview, public/images/house/<slug>/free-<n>.jpg. */
export function houseFreeSrc(slug, n) {
  return `/images/house/${slug}/free-${n}.jpg`;
}

/** Every public image path of one model: avatar, cover and the free previews. */
export function housePublicImageSrcs(slug) {
  const out = [houseAvatarSrc(slug), houseCoverSrc(slug)];
  for (let n = 1; n <= HOUSE_FREE_IMAGE_COUNT; n += 1) out.push(houseFreeSrc(slug, n));
  return out;
}

/** The public profile gallery: the cover, then the free previews. All AI-generated. */
export function houseGallery(slug) {
  const srcs = [houseCoverSrc(slug)];
  for (let n = 1; n <= HOUSE_FREE_IMAGE_COUNT; n += 1) srcs.push(houseFreeSrc(slug, n));
  return srcs.map((src) => ({ type: 'image', src, aiGenerated: true }));
}
