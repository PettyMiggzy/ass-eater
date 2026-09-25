import test from 'node:test';
import assert from 'node:assert/strict';
import { foundingAutoGrantEligible, profileQualifiesForFounding } from './founding.js';
import { effectiveUserStatus } from './user-moderation.js';

/**
 * dashboard#0: the share kit only promises "finish your profile and approval
 * grants Founding Creator" to creators pages/api/admin/profile.js would still
 * auto-grant it to. Both sides now read foundingAutoGrantEligible.
 */
const finished = {
  name: 'A',
  handle: '@a',
  bio: 'x'.repeat(45),
  img: '/api/media/avatars/1/a.jpg',
  tags: ['t'],
  gallery: [{ src: '1' }, { src: '2' }, { src: '3' }],
};

test('a pending, never-approved creator is eligible for the automatic grant', () => {
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending' }), true);
  assert.equal(profileQualifiesForFounding(finished), true);
});

test('an already-approved creator is never auto-granted, even with a finished profile', () => {
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'active', approvedAt: '2026-09-20T00:00:00Z' }), false);
  // Moved back to pending after an earlier approval: approvedAt is never cleared.
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending', approvedAt: '2026-09-20T00:00:00Z' }), false);
});

test('revoked, banned, violating or already-founding creators are not eligible', () => {
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending', foundingRevokedAt: '2026-09-21T00:00:00Z' }), false);
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending', bannedAt: '2026-09-21T00:00:00Z' }), false);
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending', contentViolationCount: 1 }), false);
  assert.equal(foundingAutoGrantEligible({ ...finished, status: 'pending', founding: true }), false);
  assert.equal(foundingAutoGrantEligible(null), false);
  // A seed record with no status at all is not a pending application.
  assert.equal(foundingAutoGrantEligible({ ...finished }), false);
});

/**
 * dashboard#4: the dashboard reads account-level moderation through the same
 * pure helper the write routes use (lib/user-moderation.js imports nothing,
 * so it is safe in the client bundle).
 */
test('effectiveUserStatus: suspension lapses on its date, ban does not', () => {
  const now = Date.parse('2026-09-25T00:00:00Z');
  assert.equal(effectiveUserStatus({ moderationStatus: 'suspended', moderationUntil: '2026-10-01T00:00:00Z' }, now), 'suspended');
  assert.equal(effectiveUserStatus({ moderationStatus: 'suspended', moderationUntil: '2026-09-01T00:00:00Z' }, now), 'active');
  assert.equal(effectiveUserStatus({ moderationStatus: 'banned' }, now), 'banned');
  assert.equal(effectiveUserStatus({}, now), 'active');
});
