// Blocks messages/posts that look like an attempt to move a payment off-platform
// (Cash App, Venmo, Zelle, a phone number, an email address, ...) so creators
// can't route fans around the platform's fee. Applies to everyone, no bypass --
// a paid way around this would just be a paid way to dodge the fee it protects.
//
// Deliberately does NOT flag crypto wallet addresses (0x..., bc1..., etc.) --
// this platform's own tipping/payments are denominated in $ONLYASS, so those
// show up in completely legitimate on-platform conversations here, unlike a
// typical fiat-only OnlyFans clone.

const PAYMENT_KEYWORDS = [
  'cashapp', 'cash app', 'venmo', 'zelle', 'paypal', 'apple pay', 'applepay',
  'google pay', 'chime', 'western union', 'moneygram',
];

const CASHTAG_RE = /\$[A-Za-z][A-Za-z0-9_]{1,20}\b/;
const PHONE_RE = /(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

export function detectPaymentCircumvention(text) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const reasons = [];

  for (const keyword of PAYMENT_KEYWORDS) {
    if (lower.includes(keyword)) reasons.push(`mentions "${keyword}"`);
  }
  if (CASHTAG_RE.test(raw)) reasons.push('looks like a Cash App cashtag');
  if (PHONE_RE.test(raw)) reasons.push('looks like a phone number');
  if (EMAIL_RE.test(raw)) reasons.push('looks like an email address');

  return { flagged: reasons.length > 0, reasons };
}

export const PAYMENT_CIRCUMVENTION_MESSAGE =
  "That message wasn't sent -- it looks like it's trying to move a payment off-platform (Cash App, a phone number, an email, etc.), which isn't allowed here.";
