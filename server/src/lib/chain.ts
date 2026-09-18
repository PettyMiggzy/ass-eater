import { createPublicClient, createWalletClient, http, erc20Abi, parseAbiItem, type Address } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { robinhood, robinhoodTestnet } from 'viem/chains';

export const chain = process.env.CHAIN === 'robinhood-testnet' ? robinhoodTestnet : robinhood;
export const CHAIN_ID = chain.id;
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 12);

export const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });

export const treasury = privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as `0x${string}`);
export const treasuryClient = createWalletClient({ account: treasury, chain, transport: http(process.env.RPC_URL) });

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
  : [{ symbol: 'USDG', address: (process.env.USDG_ADDRESS as Address) ?? USDG_ADDRESS_MAINNET, decimals: Number(process.env.USDG_DECIMALS ?? 6) }];

/**
 * The stablecoin the treasury swaps into when it hedges token deposits.
 * First in the list, i.e. the chain's primary dollar -- there is no sense
 * hedging into whichever one happened to be configured last.
 */
export const HEDGE_STABLE: StableToken = STABLECOINS[0];

/** address -> stablecoin. The allowlist an incoming transfer is checked against. */
export const ACCEPTED_STABLES = new Map<string, StableToken>(
  STABLECOINS.map((s) => [s.address.toLowerCase(), s]));

export const TOKENS: Record<'ONLYASS', { address: Address; decimals: number }> = {
  ONLYASS:  { address: process.env.ONLYASS_TOKEN_ADDRESS as Address, decimals: Number(process.env.ONLYASS_DECIMALS ?? 18) },
};
export const DECIMALS = { ETH: 18, ONLYASS: TOKENS.ONLYASS.decimals } as const;

/** Every ERC-20 this platform watches: the accepted stablecoins plus the token. */
export const WATCHED_TOKENS: { symbol: string; address: Address; decimals: number }[] = [
  ...STABLECOINS,
  { symbol: 'ONLYASS', address: TOKENS.ONLYASS.address, decimals: TOKENS.ONLYASS.decimals },
];

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
    if (!token.address) throw new Error(`${symbol}: no contract address configured`);
    const onChain = await publicClient.readContract({ address: token.address, abi: erc20Abi, functionName: 'decimals' });
    if (Number(onChain) !== token.decimals) {
      throw new Error(`${symbol} at ${token.address} reports ${onChain} decimals, configured as ${token.decimals}. Refusing to price deposits against a wrong scale.`);
    }
  }
}
/** address -> ledger asset. Every accepted stablecoin maps to STABLE; the token to ONLYASS. */
export const ADDR_TO_ASSET = new Map<string, 'STABLE' | 'ONLYASS'>([
  ...STABLECOINS.map((s) => [s.address.toLowerCase(), 'STABLE' as const] as [string, 'STABLE']),
  [TOKENS.ONLYASS.address?.toLowerCase(), 'ONLYASS' as const] as [string, 'ONLYASS'],
].filter(([addr]) => !!addr));

export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export { erc20Abi };

/** Per-user deposit addresses derived from one HD mnemonic. Index stored in DepositAddress.derivationIndex. */
export const depositAccount = (index: number) =>
  mnemonicToAccount(process.env.DEPOSIT_MNEMONIC!, { addressIndex: index });

export const depositWalletClient = (index: number) =>
  createWalletClient({ account: depositAccount(index), chain, transport: http(process.env.RPC_URL) });
