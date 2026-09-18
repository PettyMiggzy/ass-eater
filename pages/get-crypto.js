import { useState } from 'react';
import Head from 'next/head';

const ROBINHOOD_CHAIN = {
  chainId: '0x1237', // 4663 in hex
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
  blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
};

export default function GetCrypto() {
  const [status, setStatus] = useState('');

  const addNetwork = async () => {
    if (!window.ethereum) {
      setStatus('No wallet found — install MetaMask first (Step 1 below), then come back and click this.');
      return;
    }
    try {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [ROBINHOOD_CHAIN],
      });
      setStatus('Robinhood Chain added to your wallet.');
    } catch (err) {
      setStatus(err.message || 'Could not add the network — try adding it manually below.');
    }
  };

  return (
    <>
      <Head>
        <title>New to Crypto? - OnlyOne</title>
        <meta name="description" content="A step-by-step guide to getting a wallet and USDC so you can buy credits on OnlyOne." />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white px-6 py-12">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-4xl font-black premium-title mb-3 text-center">New to Crypto?</h1>
          <p className="text-gray-400 text-center mb-12">
            Four steps to go from "never touched crypto" to spending on OnlyOne. Takes about 10 minutes.
          </p>

          <div className="space-y-6">
            {/* Step 1 */}
            <div className="premium-card p-6">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-8 h-8 rounded-full bg-brand-gold text-black font-black flex items-center justify-center shrink-0">1</span>
                <h2 className="font-black text-lg">Get a wallet (MetaMask)</h2>
              </div>
              <p className="text-gray-300 text-sm mb-3">
                A wallet is an app that holds your crypto — it's yours, not the platform's. MetaMask is the most
                widely used one, free, and works as a browser extension or a phone app.
              </p>
              <a
                href="https://metamask.io/download/"
                target="_blank"
                rel="noopener noreferrer"
                className="premium-button inline-block text-sm"
              >
                Download MetaMask
              </a>
              <p className="text-xs text-gray-500 mt-3">
                Only download it from metamask.io — fake MetaMask apps and browser extensions exist specifically to
                steal your funds. When you set it up, write down the 12-word "secret recovery phrase" on paper, not
                a screenshot, and never type it into any website. Anyone who has it can take everything in the wallet.
              </p>
            </div>

            {/* Step 2 */}
            <div className="premium-card p-6">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-8 h-8 rounded-full bg-brand-gold text-black font-black flex items-center justify-center shrink-0">2</span>
                <h2 className="font-black text-lg">Add Robinhood Chain</h2>
              </div>
              <p className="text-gray-300 text-sm mb-3">
                OnlyOne settles on Robinhood Chain, a network your wallet doesn't know about by default. Click
                below to add it automatically (MetaMask will ask you to confirm).
              </p>
              <button onClick={addNetwork} className="premium-button text-sm">
                Add Robinhood Chain to MetaMask
              </button>
              {status && <p className="text-xs text-brand-secondary mt-3">{status}</p>}
              <details className="mt-4">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">
                  Prefer to add it by hand?
                </summary>
                <div className="mt-3 text-xs text-gray-400 space-y-1 font-mono bg-black/30 rounded-md p-3">
                  <p>Network name: Robinhood Chain</p>
                  <p>RPC URL: https://rpc.mainnet.chain.robinhood.com</p>
                  <p>Chain ID: 4663</p>
                  <p>Currency symbol: ETH</p>
                  <p>Block explorer: https://robinhoodchain.blockscout.com</p>
                </div>
              </details>
            </div>

            {/* Step 3 */}
            <div className="premium-card p-6">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-8 h-8 rounded-full bg-brand-gold text-black font-black flex items-center justify-center shrink-0">3</span>
                <h2 className="font-black text-lg">Get USDC (and a little ETH)</h2>
              </div>
              <p className="text-gray-300 text-sm mb-2">
                Credits on OnlyOne are bought with <strong>USDC</strong>, a dollar-pegged stablecoin — one USDC is
                one dollar, so what you spend is what you meant to spend. You also need a small amount of ETH on
                Robinhood Chain to cover network fees. The easiest path:
              </p>
              <ol className="text-gray-300 text-sm list-decimal list-inside space-y-1 mb-3">
                <li>Open MetaMask and tap <strong>Buy</strong> — it lets you buy USDC or ETH with a card directly into your wallet, no separate exchange signup needed</li>
                <li>Bridge to Robinhood Chain — <a href="https://across.to" target="_blank" rel="noopener noreferrer" className="text-brand-gold hover:underline">Across</a> supports this from Ethereum, Base, Arbitrum, and others</li>
                <li>Keep a little ETH for fees; the rest in USDC is what buys credits</li>
              </ol>
              <p className="text-xs text-gray-500 mb-3">
                (MetaMask's Buy button uses its own on-ramp partners behind the scenes — that's between you and
                MetaMask, not something we run or integrate with.)
              </p>
              <p className="text-xs text-gray-500">
                You do <strong>not</strong> need $ONLYONE to use OnlyOne. That token is a separate, optional thing
                — access and VIP status, never a way to pay. See the <a href="/token" className="underline">token page</a>.
              </p>
            </div>

            {/* Step 4 */}
            <div className="premium-card p-6 opacity-75">
              <div className="flex items-center gap-3 mb-3">
                <span className="w-8 h-8 rounded-full bg-brand-purple/40 text-white font-black flex items-center justify-center shrink-0">4</span>
                <h2 className="font-black text-lg">Buy credits on OnlyOne</h2>
              </div>
              <p className="text-gray-300 text-sm">
                Once payments are live, your dashboard will show a unique deposit address — send USDC there from
                your wallet and it becomes credits, ready to subscribe, tip, and unlock. One credit is one USDC.
                This step launches with the platform's payment system — not live yet.
              </p>
            </div>
          </div>

          <div className="text-center mt-12">
            <a href="/" className="premium-button inline-block">Back to OnlyOne</a>
          </div>
        </div>
      </div>
    </>
  );
}
