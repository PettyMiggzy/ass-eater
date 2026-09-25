/**
 * Prints the DEPOSIT_XPUB for the deposit mnemonic, so the API process can
 * derive deposit addresses without holding the mnemonic (lib/chain.ts).
 *
 * Usage, on the droplet (the mnemonic is read from stdin, never argv, so it
 * stays out of shell history and the process list):
 *
 *   sudo -u onlyone node dist/scripts/derive-deposit-xpub.js < /dev/tty
 *
 * Paste the mnemonic (it is not echoed), press Enter. Put the printed xpub in the API's .env as
 * DEPOSIT_XPUB. An xpub reveals every deposit address (and so every deposit
 * amount) but cannot spend anything.
 */
import { xpubFromMnemonic, depositAddressAt } from '../lib/chain.js';
import { readSecret } from './read-secret.js';

// Read with echo OFF (scripts/read-secret.ts): this mnemonic controls every
// fan's deposit address, and a line-reader on a terminal printed it in full
// into scrollback, tmux buffers and any recorded session. Only the xpub and
// the sanity-check address are ever printed.
readSecret('Deposit mnemonic').then((line) => {
  let xpub: string;
  try {
    xpub = xpubFromMnemonic(line);
  } catch (e) {
    // A typo is refused (BIP-39 checksum) rather than silently deriving an
    // unrelated wallet -- see lib/chain.ts isValidMnemonic. The message
    // never quotes the input.
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  process.env.DEPOSIT_XPUB = xpub;
  process.stdout.write(`DEPOSIT_XPUB=${xpub}\n`);
  // Index 1 as a sanity check the operator can compare against an existing
  // DepositAddress row (derivation starts at 1).
  process.stderr.write(`address #1 from this xpub: ${depositAddressAt(1)}\n`);
  process.exit(0);
}).catch((e) => { process.stderr.write(`${(e as Error).message}\n`); process.exit(1); });
