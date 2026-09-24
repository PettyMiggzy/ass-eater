/**
 * Prints the DEPOSIT_XPUB for the deposit mnemonic, so the API process can
 * derive deposit addresses without holding the mnemonic (lib/chain.ts).
 *
 * Usage, on the droplet (the mnemonic is read from stdin, never argv, so it
 * stays out of shell history and the process list):
 *
 *   sudo -u onlyone node dist/scripts/derive-deposit-xpub.js < /dev/tty
 *
 * Paste the mnemonic, press Enter. Put the printed xpub in the API's .env as
 * DEPOSIT_XPUB. An xpub reveals every deposit address (and so every deposit
 * amount) but cannot spend anything.
 */
import { createInterface } from 'readline';
import { xpubFromMnemonic, depositAddressAt } from '../lib/chain.js';

const rl = createInterface({ input: process.stdin, terminal: false });
process.stderr.write('Deposit mnemonic: ');
rl.once('line', (line) => {
  rl.close();
  const xpub = xpubFromMnemonic(line);
  process.env.DEPOSIT_XPUB = xpub;
  process.stdout.write(`DEPOSIT_XPUB=${xpub}\n`);
  // Index 1 as a sanity check the operator can compare against an existing
  // DepositAddress row (derivation starts at 1).
  process.stderr.write(`address #1 from this xpub: ${depositAddressAt(1)}\n`);
});
