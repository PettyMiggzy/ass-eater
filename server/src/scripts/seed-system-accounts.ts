import { prisma } from '../lib/prisma';
import { PLATFORM_ID, ESCROW_ID } from '../core/ledger';

// The ledger posts fees/escrow to these two pseudo-users as ordinary
// Account rows -- they need a real User row to hang off of first. Idempotent,
// safe to run on every deploy (upsert, not create). Previously undocumented
// for PLATFORM_ID -- tests created it ad hoc in beforeEach, production never
// had an equivalent step. Run once after `prisma migrate deploy`:
//   node dist/scripts/seed-system-accounts.js

const SYSTEM_ACCOUNTS = [
  { id: PLATFORM_ID, email: 'treasury@internal', username: '__platform__' },
  { id: ESCROW_ID, email: 'escrow@internal', username: '__escrow__' },
];

async function main() {
  for (const acct of SYSTEM_ACCOUNTS) {
    await prisma.user.upsert({
      where: { id: acct.id },
      create: { id: acct.id, email: acct.email, username: acct.username, passwordHash: 'x', role: 'ADMIN', dob: new Date('1970-01-01') },
      update: {},
    });
    console.log(`ok: ${acct.username} (${acct.id})`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
