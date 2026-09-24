// The demo/seed roster shown before any real creator has signed up.
// Deliberately just two profiles now (2026-09-19, founder's direct call --
// "just be one or two of those") rather than a full six-person cast: these
// are explicitly a free "how it works" example, not a simulated marketplace
// of fake creators. Photorealistic (generated with Venice, seedream-v5-pro),
// not the earlier illustrated/cartoon style -- the founder didn't like those.
//
// Every image here is AI-generated, so every gallery item carries
// aiGenerated: true -- Terms section 7 makes the label mandatory and the
// platform's own demo content must not be the one exception. Rows already
// seeded into a database before this flag existed are labelled anyway:
// toPublicCreator (lib/creator-status.js) marks every seed creator's gallery
// items aiGenerated at projection time.
export const creators = [
  {
    id: 1,
    seed: true,
    name: 'Ava — How It Works',
    handle: '@howitworks',
    img: '/images/demo_female_avatar.jpg',
    video: null,
    price: 'Free',
    locked: false,
    trending: true,
    bio: "This is a demo profile, not a real creator -- free to browse so you can see exactly what a page looks like before you sign up. Real creators set their own price, post their own content, and keep what they earn.",
    tags: ['demo', 'how-it-works'],
    gallery: [
      { type: 'image', src: '/images/demo_female_1.jpg', aiGenerated: true },
      { type: 'image', src: '/images/demo_female_2.jpg', aiGenerated: true },
    ],
  },
  {
    id: 2,
    seed: true,
    name: 'Jake — How It Works',
    handle: '@howitworks2',
    img: '/images/demo_male_avatar.jpg',
    video: null,
    price: 'Free',
    locked: false,
    trending: false,
    bio: "Another demo profile, same reason as Ava's -- free, not a real account, just here so you know what to expect. Creators of any gender are welcome here.",
    tags: ['demo', 'how-it-works'],
    gallery: [
      { type: 'image', src: '/images/demo_male_1.jpg', aiGenerated: true },
      { type: 'image', src: '/images/demo_male_2.jpg', aiGenerated: true },
    ],
  },
];
