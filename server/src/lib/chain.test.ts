import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateMnemonic, english, mnemonicToAccount } from 'viem/accounts';

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function freshChain() {
  vi.resetModules();
  return import('./chain.js');
}

describe('deposit address derivation', () => {
  it('derives identical addresses from DEPOSIT_XPUB and from the mnemonic', async () => {
    // The API derives from the xpub and never holds the mnemonic; the sweep
    // worker signs with the mnemonic. If these ever disagreed, fans would be
    // shown an address whose key nobody holds.
    const mnemonic = generateMnemonic(english);
    const { xpubFromMnemonic } = await freshChain();
    const xpub = xpubFromMnemonic(mnemonic);
    expect(xpub.startsWith('xpub')).toBe(true);

    delete process.env.DEPOSIT_MNEMONIC;
    process.env.DEPOSIT_XPUB = xpub;
    const { depositAddressAt, DEPOSIT_XPUB_PATH } = await freshChain();
    expect(DEPOSIT_XPUB_PATH).toBe("m/44'/60'/0'/0");
    for (const i of [1, 2, 7, 1000]) {
      expect(depositAddressAt(i).toLowerCase()).toBe(mnemonicToAccount(mnemonic, { addressIndex: i }).address.toLowerCase());
    }
  });

  it('refuses to sign for a deposit address without the mnemonic (API process)', async () => {
    delete process.env.DEPOSIT_MNEMONIC;
    const { depositAccount } = await freshChain();
    expect(() => depositAccount(1)).toThrow(/DEPOSIT_MNEMONIC/);
  });
});

describe('treasury key', () => {
  it('is not read at import, only on first use', async () => {
    delete process.env.TREASURY_PRIVATE_KEY;
    const chain = await freshChain();   // importing must not throw or need the key
    expect(() => chain.treasuryAccount()).toThrow(/TREASURY_PRIVATE_KEY/);
  });

  it('serializes treasury sends, and one failure does not jam the queue', async () => {
    const { withTreasuryLock } = await freshChain();
    const order: string[] = [];
    const slow = withTreasuryLock(async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 30)); order.push('a-end'); });
    const failing = withTreasuryLock(async () => { order.push('b'); throw new Error('boom'); });
    const after = withTreasuryLock(async () => { order.push('c'); return 42; });
    await slow; await expect(failing).rejects.toThrow('boom');
    expect(await after).toBe(42);
    expect(order).toEqual(['a-start', 'a-end', 'b', 'c']);
  });
});

describe('env handling', () => {
  it('falls back to the canonical USDG address when USDG_ADDRESS is blank', async () => {
    process.env.USDG_ADDRESS = '';
    process.env.USDG_DECIMALS = '';
    delete process.env.STABLECOINS;
    const { STABLECOINS, USDG_ADDRESS_MAINNET } = await freshChain();
    expect(STABLECOINS[0].address).toBe(USDG_ADDRESS_MAINNET);
    expect(STABLECOINS[0].decimals).toBe(6);
  });

  it('does not index $ONLYONE deposits just because the token address is set', async () => {
    process.env.ONLYONE_TOKEN_ADDRESS = '0x2c34ED86552076715272056D021cEab6080F1Ab5';
    delete process.env.INDEX_ONLYONE_DEPOSITS;
    let c = await freshChain();
    expect(c.WATCHED_TOKENS.map(t => t.symbol)).not.toContain('ONLYONE');
    expect(c.ADDR_TO_ASSET.has('0x2c34ed86552076715272056d021ceab6080f1ab5')).toBe(false);

    process.env.INDEX_ONLYONE_DEPOSITS = 'true';
    c = await freshChain();
    expect(c.WATCHED_TOKENS.map(t => t.symbol)).toContain('ONLYONE');
    expect(c.ADDR_TO_ASSET.get('0x2c34ed86552076715272056d021ceab6080f1ab5')).toBe('ONLYONE');
  });

  it('warns about the pre-rename variable names nothing reads', async () => {
    process.env.ONLYASS_PRICE_OVERRIDE = '0.01';
    process.env.USDC_ADDRESS = '0x0';
    const { warnLegacyEnv } = await freshChain();
    const msgs: string[] = [];
    warnLegacyEnv((m) => msgs.push(m));
    expect(msgs.join()).toMatch(/ONLYASS_PRICE_OVERRIDE/);
    expect(msgs.join()).toMatch(/USDC_ADDRESS/);
  });

  it('envInt never returns NaN: junk, a systemd-kept inline comment and out-of-range values fall back', async () => {
    const { envInt } = await freshChain();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.X_MS = '3600000   # re-queue sweeps';
    expect(envInt('X_MS', 42, 60_000)).toBe(42);
    process.env.X_MS = '10';
    expect(envInt('X_MS', 42, 60_000)).toBe(42);
    process.env.X_MS = '';
    expect(envInt('X_MS', 42)).toBe(42);
    process.env.X_MS = '120000';
    expect(envInt('X_MS', 42, 60_000)).toBe(120_000);
    warn.mockRestore();
  });

  it('warns (by name only) about an inline comment kept in a value', async () => {
    process.env.SWEEP_RECONCILE_INTERVAL_MS = '3600000   # re-queue';
    const { warnLegacyEnv } = await freshChain();
    const msgs: string[] = [];
    warnLegacyEnv((m) => msgs.push(m));
    expect(msgs.join()).toMatch(/SWEEP_RECONCILE_INTERVAL_MS/);
    expect(msgs.join()).not.toMatch(/3600000/);
  });
});
