import { createPublicClient, createWalletClient, http, erc20Abi, parseAbiItem, type Address } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';

export const chain = process.env.CHAIN === 'base-sepolia' ? baseSepolia : base;
export const CHAIN_ID = chain.id;
export const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? 12);

export const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });

export const treasury = privateKeyToAccount(process.env.TREASURY_PRIVATE_KEY as `0x${string}`);
export const treasuryClient = createWalletClient({ account: treasury, chain, transport: http(process.env.RPC_URL) });

export const TOKENS: Record<'USDC' | 'ASS', { address: Address; decimals: number }> = {
  USDC: { address: process.env.USDC_ADDRESS as Address, decimals: 6 },
  ASS:  { address: process.env.ASS_TOKEN_ADDRESS as Address, decimals: Number(process.env.ASS_DECIMALS ?? 18) },
};
export const DECIMALS = { USDC: 6, ETH: 18, ASS: TOKENS.ASS.decimals } as const;
export const ADDR_TO_ASSET = new Map<string, 'USDC' | 'ASS'>(
  Object.entries(TOKENS).map(([k, v]) => [v.address.toLowerCase(), k as 'USDC' | 'ASS']));

export const TRANSFER_EVENT = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export { erc20Abi };

/** Per-user deposit addresses derived from one HD mnemonic. Index stored in DepositAddress.derivationIndex. */
export const depositAccount = (index: number) =>
  mnemonicToAccount(process.env.DEPOSIT_MNEMONIC!, { addressIndex: index });

export const depositWalletClient = (index: number) =>
  createWalletClient({ account: depositAccount(index), chain, transport: http(process.env.RPC_URL) });
