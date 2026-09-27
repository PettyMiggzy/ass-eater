/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  // `pg` opens real TCP sockets, so it must stay a Node require at runtime
  // rather than being bundled. Without this, Turbopack tries to trace it into
  // the server bundle and fails on net/tls/dns/fs -- the same class of error
  // that shows up if a client component ever imports a store module, but from
  // the other direction: here it is the SSR bundle, not the browser one.
  serverExternalPackages: ['pg'],
  // The AI house-roster install checks the model avatars/covers/free previews
  // with fs at runtime; untraced files are not in the function. (The SOLD
  // images are admin uploads in private Blob storage, never files here.)
  outputFileTracingIncludes: {
    '/api/admin/house-roster': ['./public/images/house/**/*'],
  },
  async redirects() {
    // /onlyass was the Explore/creators page's old route name, from before
    // the OnlyOne rename. SiteNav's own "Creators" link already pointed at
    // it under that label -- /creators matches the label instead of the
    // pre-rename brand name. Permanent so search engines and old bookmarks
    // update, not just an in-app link fix.
    return [
      {
        source: '/onlyass',
        destination: '/creators',
        permanent: true,
      },
    ];
  },
};

module.exports = nextConfig;
