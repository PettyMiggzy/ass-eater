import { NextResponse } from 'next/server';

// Only Ass runs on one Vercel project behind three domains, each serving
// different content based on hostname:
//   onlyass.fun    -> the full platform (default, no rewrite)
//   onlyass.xyz    -> token-only landing page (crypto-native TLD, kept
//                     separate from adult content for exchange/listing sites)
//   onlyass.online -> SFW age-gate gateway that redirects into onlyass.fun
const HOST_ROUTES = {
  'onlyass.xyz': '/token',
  'www.onlyass.xyz': '/token',
  'onlyass.online': '/gateway',
  'www.onlyass.online': '/gateway',
};

export function proxy(request) {
  const host = request.headers.get('host') || '';
  const target = HOST_ROUTES[host];

  if (target && request.nextUrl.pathname === '/') {
    return NextResponse.rewrite(new URL(target, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/',
};
