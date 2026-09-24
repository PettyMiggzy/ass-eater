import { prisma } from '../lib/prisma.js';
import { PLATFORM_ID } from '../core/ledger.js';

// The ledger posts platform fees to PLATFORM_ID as an ordinary Account row --
// it needs a real User row to hang off of first. Idempotent, safe to run on
// every deploy (upsert, not create). Previously undocumented -- tests
// created it ad hoc in beforeEach, production never had an equivalent step.
// Run once after `prisma migrate deploy`:
//   node dist/scripts/seed-system-accounts.js
//
// A system account is a bookkeeping row, never a person, so it is seeded as
// something nobody can act as:
//   - email on the reserved `.invalid` TLD, so no real sign-up identifier
//     can ever equal it (it used to be 'treasury@internal', which a site fan
//     could simply type as their login and be bridged into);
//   - role FAN, not ADMIN -- nothing needs the ledger's fee account to pass
//     admin checks, and an ADMIN JWT for it would hold the whole treasury;
//   - status SUSPENDED, which app.auth refuses outright, and a passwordHash
//     that is not a valid argon2 hash, so /login can never match it.
// The `update` branch enforces the same values on an already-seeded row: a
// droplet that ran the old seed gets corrected on its next deploy (the
// 20260924000000_bridge_site_uid migration does the same thing in SQL).

const SYSTEM_ACCOUNTS = [
  { id: PLATFORM_ID, email: 'platform@system.invalid', username: '__platform__' },
];

async function main() {
  for (const acct of SYSTEM_ACCOUNTS) {
    const locked = { email: acct.email, role: 'FAN' as const, status: 'SUSPENDED' as const, passwordHash: 'x', siteUid: null };
    await prisma.user.upsert({
      where: { id: acct.id },
      create: { id: acct.id, username: acct.username, dob: new Date('1970-01-01'), ...locked },
      update: locked,
    });
    console.log(`ok: ${acct.username} (${acct.id})`);
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
