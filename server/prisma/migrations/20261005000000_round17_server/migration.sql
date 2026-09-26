-- Round 17 server fixes: a post the CREATOR deleted is told apart from a
-- moderation takedown. A creator's self-delete of a PPV post keeps it
-- viewable to fans who already paid for it (core/access.ts canViewPost),
-- as a marketplace listing's buyers keep theirs; a takedown hides it from
-- everyone. Existing removed posts cannot be told apart after the fact, so
-- they stay as takedowns (false) -- the safe reading.

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "removedByCreator" BOOLEAN NOT NULL DEFAULT false;
