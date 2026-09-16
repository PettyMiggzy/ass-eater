# Creator profile walls (comments)

The "talk to people, not just buy from them" feature — a public,
MySpace-style guestbook on each creator's profile, plus the plumbing to
extend it to post-level comments later if it's worth building further.

## What's built

- **`lib/wall-store.js`**: Blob-based store for wall comments (text only —
  images are intentionally deferred, see below).
- **New "WALL" tab** on `pages/creator/[id].js`, alongside the existing
  Posts/Media tabs (which — pre-existing, not something this touched —
  don't actually filter content differently; Wall is the first of the three
  that does).
- **Posting**: any logged-in user (fan or creator) can post on a creator's
  wall. Not logged in → routed to `/login`, same pattern as the inbox.
- **Moderation, two layers**:
  - **Self-service**: a comment's own author can delete it; the creator
    whose wall it's on can delete *any* comment on their own wall — same as
    an Instagram/Facebook page owner moderating their own comments, so most
    moderation never needs to reach the platform.
  - **Report**: a flag button on every comment (not shown on your own) files
    a report via the existing `lib/reports-store.js` (`targetType:
    'wall_post'`) — the same mechanism the marketplace's listing-report
    button already uses.
- **Display names for fans**: fans previously had no username/handle at
  all — `lib/users-store.js`'s new `displayNameFor()` falls back to the
  local-part of their email so a comment shows a name, not a raw ID or
  "Someone" for everyone.

## Known gap: reports aren't reviewable yet

`addReport()` writes a report; nothing reads it back. Neither the
marketplace's listing-report button nor this wall's comment-report button
had an admin review UI before this, and this didn't add one — reports
currently just accumulate in Blob storage with no dashboard to work
through them. Worth building before this ships at any real volume: a public
comment surface without a working report queue behind it is worse than not
having reports at all, since it implies a safety net that isn't actually
there yet.

## Why images are last on the roadmap, not in this pass

Public, fan-generated text is a moderation step up from what existed before
(private DMs and creator-uploaded content only) — public, fan-generated
*images* on an adult platform is a much bigger one: no way to pre-screen
what a stranger uploads before it's publicly visible, and that's real legal
exposure, not just a UX concern, until there's real moderation tooling
(automated scanning, a working report-review queue per above, rate limits)
in front of it. Ship text, see how much moderation load it actually creates,
build images once there's a working review process to catch problems before
they're issues.
