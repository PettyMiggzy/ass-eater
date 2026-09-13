import { Html, Head, Main, NextScript } from 'next/document';

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta charSet="utf-8" />
        <meta name="theme-color" content="#0f0f0f" />
      </Head>
      <body className="bg-brand-dark text-white">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
