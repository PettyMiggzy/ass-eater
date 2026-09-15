import { useEffect } from 'react';
import Head from 'next/head';

const MAIN_SITE = 'https://onlyass.fun';

export default function Gateway() {
  useEffect(() => {
    const t = setTimeout(() => {
      window.location.href = MAIN_SITE;
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <>
      <Head>
        <title>Only Ass</title>
        <meta name="description" content="Only Ass — an 18+ creator platform and token. Adult content, entry by age verification only." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      <div className="min-h-screen bg-gradient-luxury text-white flex items-center justify-center px-6">
        <div className="max-w-md w-full premium-card p-8 text-center">
          <img src="/images/logo-final.png" alt="Only Ass" className="h-16 w-auto mx-auto mb-6" />
          <h1 className="text-2xl font-black premium-title mb-3">18+ Adult Content</h1>
          <p className="text-gray-400 text-sm mb-8">
            Only Ass is an adult creator platform. You must be 18 or older to enter. You'll be
            redirected to the platform in a few seconds.
          </p>
          <a href={MAIN_SITE} className="premium-button inline-block w-full">
            Enter Only Ass →
          </a>
        </div>
      </div>
    </>
  );
}
