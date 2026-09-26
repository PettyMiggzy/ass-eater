-- Round 9 server fixes: indexes for the paged report queue (every branch of
-- its contentRemoved flag becomes an index probe), and at most one LIVE
-- stream per creator.

-- CreateIndex
CREATE INDEX "Media_messageId_idx" ON "Media"("messageId");

-- CreateIndex
CREATE INDEX "Message_senderId_broadcastId_idx" ON "Message"("senderId", "broadcastId");

-- CreateIndex
CREATE INDEX "Report_targetType_targetId_status_idx" ON "Report"("targetType", "targetId", "status");

-- CreateIndex
CREATE INDEX "LiveStream_creatorId_status_idx" ON "LiveStream"("creatorId", "status");

-- Before the unique index can exist, end every LIVE stream of a creator but
-- their newest (a double-tapped "Go Live" before this fix could leave two).
UPDATE "LiveStream" ls SET "status" = 'ENDED', "endedAt" = CURRENT_TIMESTAMP
WHERE ls."status" = 'LIVE' AND EXISTS (
  SELECT 1 FROM "LiveStream" newer
  WHERE newer."creatorId" = ls."creatorId" AND newer."status" = 'LIVE'
    AND (newer."startedAt" > ls."startedAt" OR (newer."startedAt" = ls."startedAt" AND newer.id > ls.id))
);

-- At most one LIVE stream per creator (Prisma can't express WHERE; see
-- schema.prisma LiveStream and core/live-sweep.ts startLiveStream).
CREATE UNIQUE INDEX "LiveStream_one_live_per_creator" ON "LiveStream"("creatorId") WHERE "status" = 'LIVE';
