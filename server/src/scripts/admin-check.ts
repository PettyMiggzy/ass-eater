import { prisma } from '../lib/prisma.js';

// Run by deploy/app-setup.sh after every deploy. Prints a loud reminder when
// no operator ADMIN account exists yet: there is no HTTP way to make one
// (scripts/create-admin.ts is the only way), and everything the payout
// worker cannot settle on its own -- FAILED and HELD payouts, manual token
// burn records -- waits on an admin (/admin/*). Never fails the deploy.
async function main() {
  const admins = await prisma.user.count({ where: { role: 'ADMIN', siteUid: null, status: 'ACTIVE' } });
  if (admins > 0) { console.log(`    ${admins} active admin account(s) present.`); return; }
  console.warn([
    '',
    '    WARNING: no ADMIN account exists. Nobody can resolve a FAILED/HELD payout or record a token burn.',
    '    Create one now (password is read from the terminal, 16+ chars, re-runnable to rotate):',
    "      sudo -u onlyone sh -c 'cd /opt/onlyone/server && node dist/scripts/create-admin.js <email> <username>'",
    '',
  ].join('\n'));
}

main()
  .catch((err) => { console.warn('    (admin check skipped:', err instanceof Error ? err.message : err, ')'); })
  .finally(() => prisma.$disconnect());
