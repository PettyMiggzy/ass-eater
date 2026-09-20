import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta name="theme-color" content="#0f0f0f" />
        <meta name="rating" content="RTA-5042-1996-1400-1577-RTA" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
        <link rel="icon" type="image/png" sizes="48x48" href="/favicon-48.png" />
        <link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Dancing Script is the one script/cursive face on the site --
            reserved for the <Tagline> accent (components/Brand.js) that
            sits on a creator's cover photo and the marketplace hero.
            Everything else stays Bebas Neue / Playfair Display / Inter;
            mixing in a handwritten face for body text or buttons would
            fight the site's otherwise blocky, confident type. */}
        <link
          href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Dancing+Script:wght@600;700&family=Playfair+Display:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </Head>
      <body className="bg-brand-dark text-white">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
