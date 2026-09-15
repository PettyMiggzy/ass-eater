import Head from 'next/head';

export default function Marketplace() {
  return (
    <>
      <Head>
        <title>Marketplace - Only Ass</title>
        <meta name="description" content="Only Ass Marketplace — creators list items for sale. Launching soon." />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white flex flex-col items-center justify-center px-6 text-center">
        <img src="/images/marketplace-header.png" alt="Only Ass Marketplace" className="w-full max-w-xl h-auto mb-8" />
        <p className="text-gray-300 max-w-lg mb-8">
          Creators will be able to list items for sale here — merch, digital goods, whatever they want to sell.
          18+ and subject to our marketplace terms. We're building it now — not live yet.
        </p>
        <a href="/" className="premium-button inline-block">Back to Only Ass</a>
      </div>
    </>
  );
}
