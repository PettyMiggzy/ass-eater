import argon2 from 'argon2';
import { prisma } from '../lib/prisma.js';
import { PLATFORM_ID, BURNED_ID } from '../core/ledger.js';
import { readSecret } from './read-secret.js';

// Creates (or re-passwords) the operator account that signs in to /admin.
//
// There is deliberately no HTTP way to make an ADMIN: /auth/register is
// closed by default and never accepted ADMIN anyway, and the bridge refuses
// ADMIN rows outright (lib/bridge.ts). POST /auth/login answers for ADMIN
// rows only while DIRECT_AUTH_ENABLED is off (modules/auth.ts), so this
// script, run on the droplet, is how the first one exists:
//
//   sudo -u onlyone sh -c 'cd /opt/onlyone/server && \
//     node dist/scripts/create-admin.js you@example.com youradmin'
//
// The password is read from stdin (typed with echo off when run in a
// terminal) -- never an argument, which would land in shell history and in
// `ps` output. At least 16 characters.
//
// Safe to re-run: an existing ADMIN row with that email just gets the new
// password and its refresh tokens revoked. It refuses to promote any other
// existing row -- a bridged site account or a native fan is a person with
// their own identity, not a login to hand admin rights to.

const readPassword = () => readSecret('Admin password', process.stdout);

async function main() {
  const [emailArg, usernameArg] = process.argv.slice(2);
  if (!emailArg || !usernameArg) {
    console.error('usage: node dist/scripts/create-admin.js <email> <username>   (password on stdin)');
    process.exitCode = 2;
    return;
  }
  const email = emailArg.trim().toLowerCase();
  const username = usernameArg.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.endsWith('.invalid')) throw new Error('invalid email');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new Error('username must match ^[a-z0-9_]{3,24}$');

  const password = await readPassword();
  if (password.length < 16) throw new Error('password must be at least 16 characters');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    if (existing.role !== 'ADMIN' || existing.siteUid || existing.id === PLATFORM_ID || existing.id === BURNED_ID) {
      throw new Error(`refusing: ${email} already belongs to a non-admin account; pick a different email`);
    }
    await prisma.$transaction([
      prisma.user.update({ where: { id: existing.id }, data: { passwordHash, status: 'ACTIVE' } }),
      prisma.refreshToken.deleteMany({ where: { userId: existing.id } }),
    ]);
    console.log(`ok: password reset for admin ${existing.username} (${existing.id})`);
    return;
  }

  const user = await prisma.user.create({
    data: { email, username, passwordHash, role: 'ADMIN', status: 'ACTIVE', account: { create: {} } },
  });
  console.log(`ok: created admin ${user.username} (${user.id})`);
}

main()
  .catch((err) => { console.error(err instanceof Error ? err.message : err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
