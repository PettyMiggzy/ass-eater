// Regression tests for the Buy Credits wallet path, against a mock EIP-1193
// provider -- no network, no browser, no database.
//
//   node --import ./test-register.mjs lib/wallet.test.mjs
//
// The bug these guard: sendUsdc built a wallet client with no chain, and
// viem's sendTransaction then threw "No chain was provided to the request"
// before eth_sendTransaction was ever reached -- every Buy click failed.

const wallet = await import('./wallet.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log('  PASS', name);
  } else {
    fail++;
    console.log('  FAIL', name, extra);
  }
};

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const PAYOUT = '0x3333333333333333333333333333333333333333';
const TX = '0x' + 'ab'.repeat(32);

function mockProvider({ chainHex = '0x1237', account = ACCOUNT, knowsChain = true } = {}) {
  const calls = [];
  let current = chainHex;
  let known = knowsChain;
  return {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      switch (method) {
        case 'eth_requestAccounts':
        case 'eth_accounts':
          return [account];
        case 'eth_chainId':
          return current;
        case 'wallet_switchEthereumChain':
          if (!known) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
          current = params[0].chainId;
          return null;
        case 'wallet_addEthereumChain':
          known = true;
          return null;
        case 'eth_sendTransaction':
          return TX;
        default:
          throw Object.assign(new Error(`unexpected ${method}`), { code: 4200 });
      }
    },
  };
}

const base = { tokenAddress: TOKEN, payoutAddress: PAYOUT, amountCents: 2500, decimals: 6, chainId: '4663', chainName: 'Robinhood Chain', rpcUrl: 'https://rpc.example', nativeSymbol: 'ETH' };

console.log('\nsendStablecoinTransfer');
{
  const p = mockProvider({ chainHex: '0x1' });
  let hash = null;
  let err = null;
  try {
    hash = await wallet.sendStablecoinTransfer(p, base);
  } catch (e) {
    err = e;
  }
  check('returns the transaction hash (no "No chain was provided" throw)', hash === TX, err?.message);
  const sent = p.calls.find((c) => c.method === 'eth_sendTransaction');
  check('eth_sendTransaction is actually reached', !!sent);
  check('switches to chain 4663 first', p.calls.some((c) => c.method === 'wallet_switchEthereumChain' && c.params[0].chainId === '0x1237'));
  check('sends to the token contract', sent && sent.params[0].to.toLowerCase() === TOKEN.toLowerCase());
  check('transfer calldata encodes 25.00 at 6 decimals', sent && sent.params[0].data.endsWith((25_000_000n).toString(16).padStart(64, '0')));
}
{
  const p = mockProvider({ knowsChain: false, chainHex: '0x1' });
  const hash = await wallet.sendStablecoinTransfer(p, base).catch((e) => e);
  check('adds an unknown chain, then switches, then sends', hash === TX && p.calls.some((c) => c.method === 'wallet_addEthereumChain'));
}
{
  const p = mockProvider({ account: OTHER });
  const r = await wallet.sendStablecoinTransfer(p, { ...base, expectedFrom: ACCOUNT }).catch((e) => e);
  check('refuses to send from an account other than the proven one', r instanceof Error && !p.calls.some((c) => c.method === 'eth_sendTransaction'));
}
{
  const p = mockProvider();
  const r = await wallet.sendStablecoinTransfer(p, { ...base, amountCents: 0 }).catch((e) => e);
  check('refuses a zero amount before touching the wallet', r instanceof Error && p.calls.length === 0);
}

console.log('\ncentsToTokenUnits');
check('$25.99 at 6 decimals', wallet.centsToTokenUnits(2599, 6) === 25_990_000n);
check('$1.00 at 18 decimals', wallet.centsToTokenUnits(100, 18) === 10n ** 18n);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
