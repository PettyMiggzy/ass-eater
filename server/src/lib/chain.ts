import { createPublicClient, createWalletClient, http, toHex, erc20Abi, parseAbiItem, type Address, type PrivateKeyAccount, type WalletClient, type Chain, type Transport } from 'viem';
import { HDKey, mnemonicToAccount, privateKeyToAccount, publicKeyToAddress, english } from 'viem/accounts';
import { robinhood, robinhoodTestnet } from 'viem/chains';
import { ECDH, createHash } from 'crypto';

/**
 * A numeric env var, or `fallback` when it is unset, blank, not a finite
 * number, or outside [min, max]. A bad value must not become NaN: a NaN
 * interval makes setTimeout fire after ~1ms, which turns a poll loop into a
 * busy loop against the RPC.
 */
export function envInt(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`env ${name}=${JSON.stringify(raw)} is not a number in [${min}, ${max}]; using ${fallback}`);
    return fallback;
  }
  return n;
}

export const chain = process.env.CHAIN === 'robinhood-testnet' ? robinhoodTestnet : robinhood;
export const CHAIN_ID = chain.id;
export const CONFIRMATIONS = envInt('CONFIRMATIONS', 12, 1, 1000);

export const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });

/**
 * The treasury signer, built on first use rather than at import.
 *
 * The API process imports this file (wallet.ts, stake.ts, price.ts) but never
 * signs anything with the treasury key, so it must not hold it: building the
 * account at module load put the hot wallet's key in the memory of the one
 * process that faces the internet. Only the workers call these. The API unit's
 * EnvironmentFile no longer carries TREASURY_PRIVATE_KEY at all (deploy/).
 */
let _treasury: PrivateKeyAccount | undefined;
let _treasuryClient: WalletClient<Transport, Chain, PrivateKeyAccount> | undefined;
export function treasuryAccount(): PrivateKeyAccount {
  if (!_treasury) {
    const key = process.env.TREASURY_PRIVATE_KEY;
    if (!key) throw new Error('TREASURY_PRIVATE_KEY is not set in this process (it belongs in the workers-only env file)');
    _treasury = privateKeyToAccount(key as `0x${string}`);
  }
  return _treasury;
}
/**
 * The treasury's PUBLIC address, for processes that must recognise a
 * treasury transfer without holding the key (the API, which never signs):
 * TREASURY_ADDRESS when set, else derived from the key when this process has
 * it (the workers), else null.
 */
export function treasuryAddress(): Address | null {
  const a = process.env.TREASURY_ADDRESS?.trim();
  if (a && /^0x[0-9a-fA-F]{40}$/.test(a)) return a as Address;
  try { return treasuryAccount().address; } catch { return null; }
}
export function treasuryWallet(): WalletClient<Transport, Chain, PrivateKeyAccount> {
  if (!_treasuryClient) _treasuryClient = createWalletClient({ account: treasuryAccount(), chain, transport: http(process.env.RPC_URL) });
  return _treasuryClient;
}

/**
 * Every transaction the treasury key signs goes through here, one at a time.
 *
 * Payouts, deposit-sweep gas top-ups, the hedge and the burn all send from the
 * same key inside the one workers process. Letting them interleave means two
 * of them can be handed the same nonce, and the loser's failure is exactly the
 * ambiguous "did it go out or not" error the payout worker must not guess
 * about. A process-local queue is enough because only one workers process
 * exists (deploy/onlyone-workers.service).
 */
let treasuryQueue: Promise<unknown> = Promise.resolve();
export function withTreasuryLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = treasuryQueue.then(fn, fn);
  treasuryQueue = run.catch(() => undefined);
  return run;
}

/**
 * Every dollar stablecoin this platform will accept as payment.
 *
 * Not one hardcoded ticker, because which dollar token a chain has is not
 * stable information: Robinhood Chain's is USDG (Global Dollar, Paxos) and
 * has no USDC contract at all, while a fan bridging USDC in receives USDG on
 * arrival and USDG bridged out comes back as USDC elsewhere. Each of these
 * is worth one dollar, so the ledger books cents and does not care which
 * arrived -- adding another one is a line of config, not a code change.
 *
 * The USDG address is the canonical one from Robinhood's own on-chain
 * registry (docs.robinhood.com/chain/contracts). A token with a matching
 * ticker and a different address is not it, which is exactly the trick worth
 * one wrong entry in this list -- so ACCEPTED_STABLES is an explicit
 * allowlist of contracts and never a ticker match.
 *
 * Configure extras as STABLECOINS="SYM:0xaddr:decimals,SYM2:0xaddr2:6".
 */
export const USDG_ADDRESS_MAINNET = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as Address;

export type StableToken = { symbol: string; address: Address; decimals: number };

function parseStableEnv(raw: string | undefined): StableToken[] {
  if (!raw) return [];
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [symbol, address, decimals] = entry.split(':').map((x) => x?.trim());
    if (!symbol || !address?.startsWith('0x')) throw new Error(`STABLECOINS: bad entry "${entry}" (want SYM:0xaddr:decimals)`);
    return { symbol: symbol.toUpperCase(), address: address as Address, decimals: Number(decimals ?? 6) };
  });
}

export const STABLECOINS: StableToken[] = parseStableEnv(process.env.STABLECOINS).length
  ? parseStableEnv(process.env.STABLECOINS)
  // `||`, not `??`: a template line left as `USDG_ADDRESS=` is an empty
  // string, which must fall back to the canonical address rather than become
  // a contract address of "".
  : [{ symbol: 'USDG', address: ((process.env.USDG_ADDRESS || USDG_ADDRESS_MAINNET) as Address), decimals: envInt('USDG_DECIMALS', 6, 0, 36) }];

/**
 * The stablecoin the treasury swaps into when it hedges token deposits.
 * First in the list, i.e. the chain's primary dollar -- there is no sense
 * hedging into whichever one happened to be configured last.
 */
export const HEDGE_STABLE: StableToken = STABLECOINS[0];

/** address -> stablecoin. The allowlist an incoming transfer is checked against. */
export const ACCEPTED_STABLES = new Map<string, StableToken>(
  STABLECOINS.map((s) => [s.address.toLowerCase(), s]));

export const TOKENS: Record<'ONLYONE', { address: Address; decimals: number }> = {
  ONLYONE:  { address: (process.env.ONLYONE_TOKEN_ADDRESS || undefined) as Address, decimals: envInt('ONLYONE_DECIMALS', 18, 0, 36) },
};
export const DECIMALS = { ETH: 18, ONLYONE: TOKENS.ONLYONE.decimals } as const;

/**
 * Whether the deposit indexer credits $ONLYONE transfers at all.
 *
 * Off unless INDEX_ONLYONE_DEPOSITS=true, independently of whether
 * ONLYONE_TOKEN_ADDRESS is set. The address is needed for other things (the
 * price oracle, the hedge, the burn), but a token deposit has to be priced
 * before it can be credited, and nothing in the ledger spends an $ONLYONE
 * balance (MEMORY.md, "the $ONLYONE deposit balance now has no consumer").
 * Watching it merely because the address got filled in handed anyone with
 * 1 wei of the live token a way to exercise the unpriced-deposit path.
 */
export const INDEX_ONLYONE_DEPOSITS = process.env.INDEX_ONLYONE_DEPOSITS === 'true' && !!TOKENS.ONLYONE.address;

/**
 * Every ERC-20 the deposit indexer watches: the accepted stablecoins, plus the
 * token only when INDEX_ONLYONE_DEPOSITS is on. Pre-launch the token address
 * was unset and including it made assertTokenDecimals() throw at every worker
 * boot; the flag keeps stablecoin deposits (real money, live today) working
 * whatever the token's configuration is.
 */
export const WATCHED_TOKENS: { symbol: string; address: Address; decimals: number }[] = [
  ...STABLECOINS,
  ...(INDEX_ONLYONE_DEPOSITS ? [{ symbol: 'ONLYONE', address: TOKENS.ONLYONE.address, decimals: TOKENS.ONLYONE.decimals }] : []),
];

/** A configured token whose on-chain decimals disagree with the config. Not transient: retrying will not fix it. */
export class TokenDecimalsMismatchError extends Error {}

/**
 * Confirms every configured token's decimals against the contract itself.
 *
 * This is the one configuration mistake in here that is silent and total: a
 * token with 6 decimals read as 18 misprices every single deposit by a factor
 * of a trillion, in the direction that credits a fan a fortune for a dollar.
 * Nothing downstream would notice -- the arithmetic is all internally
 * consistent. So it is checked against the chain at worker startup rather
 * than trusted to an env var, and it throws rather than warning.
 */
export async function assertTokenDecimals() {
  for (const token of WATCHED_TOKENS) {
    const symbol = token.symbol;
    if (!token.address) throw new TokenDecimalsMismatchError(`${symbol}: no contract address configured`);
    const onChain = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' });
    if (Number(onChain) !== token.decimals) {
      throw new TokenDecimalsMismatchError(`${symbol} at ${token.address} reports ${onChain} decimals, configured as ${token.decimals}. Refusing to price deposits against a wrong scale.`);
    }
  }
}
/** address -> ledger asset. Every accepted stablecoin maps to STABLE; the token to ONLYONE. */
export const ADDR_TO_ASSET = new Map<string, 'STABLE' | 'ONLYONE'>([
  ...STABLECOINS.map((s) => [s.address.toLowerCase(), 'STABLE' as const] as [string, 'STABLE']),
  [INDEX_ONLYONE_DEPOSITS ? TOKENS.ONLYONE.address.toLowerCase() : '', 'ONLYONE' as const] as [string, 'ONLYONE'],
].filter(([addr]) => !!addr));

export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export { erc20Abi };

/**
 * Per-user deposit addresses, one HD tree, index stored in
 * DepositAddress.derivationIndex. Path m/44'/60'/0'/0/<index>, the same one
 * viem's mnemonicToAccount uses.
 *
 * The API only ever needs the ADDRESS for an index, so it derives it from
 * DEPOSIT_XPUB (the extended public key of m/44'/60'/0'/0) when that is set
 * and never has to hold the mnemonic. Only the sweep worker, which signs
 * with a deposit key, needs DEPOSIT_MNEMONIC. `scripts/derive-deposit-xpub`
 * prints the xpub for a mnemonic. lib/chain.test.ts pins that both routes
 * produce identical addresses.
 */
export const DEPOSIT_XPUB_PATH = "m/44'/60'/0'/0";

export function depositAddressAt(index: number): Address {
  const xpub = process.env.DEPOSIT_XPUB;
  if (xpub) {
    const child = HDKey.fromExtendedKey(xpub).deriveChild(index);
    if (!child.publicKey) throw new Error('DEPOSIT_XPUB: could not derive a public key');
    // HDKey hands back the 33-byte COMPRESSED key; an Ethereum address is the
    // keccak of the 64-byte uncompressed point, so decompress first (Node's
    // own secp256k1, no extra dependency).
    const uncompressed = ECDH.convertKey(Buffer.from(child.publicKey), 'secp256k1', undefined, undefined, 'uncompressed') as Buffer;
    return publicKeyToAddress(toHex(uncompressed));
  }
  return depositAccount(index).address;
}

/**
 * Full BIP-39 check: every word on the English list AND the checksum right.
 *
 * viem's mnemonicToAccount only checks the word count, so one typo in one of
 * the two separately-typed copies (the one fed to derive-deposit-xpub for
 * DEPOSIT_XPUB, the one in DEPOSIT_MNEMONIC) was accepted silently and
 * derived a different, perfectly valid wallet: fans deposited to addresses
 * whose key nobody held, and every sweep "succeeded" against an empty
 * address. A typo almost always breaks the checksum, so it is refused here.
 */
export function isValidMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().normalize('NFKD').split(/\s+/);
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  const index = new Map(english.map((w, i) => [w, i]));
  let bits = '';
  for (const w of words) {
    const i = index.get(w);
    if (i === undefined) return false;
    bits += i.toString(2).padStart(11, '0');
  }
  const csLen = words.length / 3;                 // checksum bits = entropy bits / 32
  const entropyBits = bits.slice(0, bits.length - csLen);
  const entropy = Buffer.from(entropyBits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const hash = createHash('sha256').update(entropy).digest();
  const expected = [...hash].map((b) => b.toString(2).padStart(8, '0')).join('').slice(0, csLen);
  return expected === bits.slice(bits.length - csLen);
}

function checkedMnemonic(mnemonic: string, what: string): string {
  const m = mnemonic.trim().normalize('NFKD').split(/\s+/).join(' ');
  if (!isValidMnemonic(m)) throw new Error(`${what} is not a valid BIP-39 mnemonic (a word is misspelled or the checksum is wrong) -- refusing to derive deposit keys from it`);
  return m;
}

/** The DEPOSIT_XPUB for a mnemonic (used by scripts/derive-deposit-xpub). */
export function xpubFromMnemonic(mnemonic: string): string {
  return mnemonicToAccount(checkedMnemonic(mnemonic, 'the mnemonic'), { path: DEPOSIT_XPUB_PATH as `m/44'/60'/${string}` }).getHdKey().publicExtendedKey;
}

/** The signing account for a deposit address. Workers only (needs DEPOSIT_MNEMONIC). */
export const depositAccount = (index: number) => {
  if (!process.env.DEPOSIT_MNEMONIC) throw new Error('DEPOSIT_MNEMONIC is not set in this process (it belongs in the workers-only env file)');
  return mnemonicToAccount(checkedMnemonic(process.env.DEPOSIT_MNEMONIC, 'DEPOSIT_MNEMONIC'), { addressIndex: index });
};

export const depositWalletClient = (index: number) =>
  createWalletClient({ account: depositAccount(index), chain, transport: http(process.env.RPC_URL) });

/**
 * Names the deploy template used before the $ONLYASS -> $ONLYONE rename and
 * the USDC -> USDG switch. Nothing reads them, so a value set under one of
 * them is silently ignored -- say so loudly at boot instead.
 */
export function warnLegacyEnv(log: (msg: string) => void = console.warn) {
  const legacy = Object.keys(process.env).filter((k) => k.startsWith('ONLYASS_') || k === 'USDC_ADDRESS');
  if (legacy.length) {
    log(`IGNORED legacy env vars: ${legacy.join(', ')}. Rename ONLYASS_* to ONLYONE_* and USDC_ADDRESS to USDG_ADDRESS (see server/.env.example).`);
  }
  // systemd's EnvironmentFile= keeps a trailing '# comment' as part of the
  // value. Only names this template defines are checked, so a secret that
  // legitimately contains ' #' is never echoed.
  const commented = Object.keys(process.env).filter((k) => /^(ONLYONE_|USDG_|STABLECOINS$|CHAIN|RPC_URL$|CONFIRMATIONS$|INDEXER_|SWEEP_|TRACK_NATIVE_ETH$|INDEX_ONLYONE_DEPOSITS$|CHAINLINK_|UNISWAP_|TREASURY_HEDGE_|TOKEN_BURN_|PAYOUT_|AUCTION_|LIVE_SWEEP_)/.test(k) && /\s#/.test(process.env[k] ?? ''));
  if (commented.length) {
    log(`env vars with an inline '# comment' in their value (systemd keeps it as part of the value -- move the comment to its own line): ${commented.join(', ')}`);
  }
}
