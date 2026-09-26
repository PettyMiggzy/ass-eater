/**
 * The shape of a shipment's carrier and tracking number (pure: no database,
 * safe in the browser -- the dashboard's ship form uses the same list).
 *
 * The carrier and tracking number are shown to the buyer on /orders, so they
 * are creator-to-buyer text. Rounds 13 and 14 screened them as free text and
 * the screen kept missing handovers that fit a loose charset: "UPS" +
 * "whatsapp 44 7700 900123", "USPS" + "617 555 1234", "USPS" + "ig jessxo 1"
 * (round-15 money#0, public-pages#0, legal-journeys#1). So they are no longer
 * free text at all (round 15):
 *
 *   - the carrier is one of a fixed list (SHIPPING_CARRIERS);
 *   - the tracking number is compacted (spaces and "-" dropped, upper-cased)
 *     and must then be 8-35 letters and digits, with at least 6 digits, in
 *     that carrier's own structure, with its check digit where that is well
 *     known (each algorithm below was checked against real numbers):
 *       UPS    "1Z" + 6-character shipper + 10 digits, mod-10 check digit;
 *       USPS   20 digits, or 22 digits starting with 9 (IMpb, GS1 mod-10),
 *              or the S10 "EA123456785US" (UPU mod-11);
 *       FedEx  12 digits (Express, mod-11), 15, 20 or 22 digits;
 *       DHL    10-11 digits or "JD" + 18 digits;
 *       Other  digits only (10-35), an S10 number (check digit verified), or a
 *              known carrier prefix: Amazon "TBA"/"TBC"/"TBM" + 12, DHL
 *              eCommerce "GM" + 16-20, OnTrac "C"/"D" + 14, LaserShip "LX" + 8.
 *
 * Round-15 fix-up: the first version accepted "1Z" + ANY 16 characters and
 * "Other" with any four letters at each end, which left room for
 * "1ZWHATSAPP12345678", "1ZSNAPJESSXO123456", "JESS61755512340" and
 * "PAYP123456789", and it only looked for phone numbers under "Other". Now,
 * under every carrier:
 *   - a letter run holding a contact/payment app name or fragment ("SNAP",
 *     "CASH", "WHATS", "INSTA" ...), or a leading two-letter app code ("WA",
 *     "IG", "TG" -- after UPS's "1Z"), is refused as a suspected handover;
 *   - a bare phone number (except under DHL, whose real waybills are exactly
 *     10-11 digits, and as UPS's trailing 10 digits, which are structural and
 *     often phone-shaped) and a phone number padded out with one repeated digit
 *     ("6175551234" + "0000000000") are refused as suspected handovers;
 *   - under "Other", a short digits-only number (10-13 digits), or a value
 *     in none of the accepted shapes ("JESS61755512340"), with any
 *     phone-shaped 10/11-digit window in a run of up to 13 digits is refused
 *     too (the prefixed shapes are fixed-length carrier formats and are left
 *     to the checks above).
 *
 * Residual, stated plainly: a digits-only field can always carry a number the
 * two sides decode by agreement (a phone number with a computed check digit
 * appended). The structures and check digits make that deliberate work rather
 * than typing, and refusals that look like a handover are logged for review.
 */

export const SHIPPING_CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'];

const CARRIER_BY_KEY = new Map(SHIPPING_CARRIERS.map((c) => [c.toLowerCase(), c]));

// Format hints, one line per carrier, for the ship form and the error text.
export const TRACKING_FORMAT_HINTS = {
  USPS: '20 digits, 22 digits starting with 9, or 2 letters + 9 digits + "US"',
  UPS: '"1Z" + 6 letters/digits + 10 digits',
  FedEx: '12, 15, 20 or 22 digits',
  DHL: '10 or 11 digits, or "JD" + 18 digits',
  Other: '10-35 digits, an international "AB123456785CD" number, or a TBA / GM / C / D / LX number',
};

/** The canonical carrier name for `input` ("ups", " FedEx ") or null. */
export function normalizeCarrier(input) {
  if (typeof input !== 'string') return null;
  return CARRIER_BY_KEY.get(input.trim().toLowerCase()) || null;
}

/** Spaces and "-" dropped, upper-cased ("1z 999-aa1" -> "1Z999AA1"). Non-strings -> ''. */
export function compactTrackingNumber(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

const S10_RE = /^[A-Z]{2}[0-9]{9}[A-Z]{2}$/;
const FORMATS = {
  UPS: [/^1Z[0-9A-Z]{6}[0-9]{10}$/],
  USPS: [/^[0-9]{20}$/, /^9[0-9]{21}$/, /^[A-Z]{2}[0-9]{9}US$/],
  FedEx: [/^(?:[0-9]{12}|[0-9]{15}|[0-9]{20}|[0-9]{22})$/],
  DHL: [/^[0-9]{10,11}$/, /^JD[0-9]{18}$/],
  // Digits only, an S10 number, or a known carrier prefix: no free letters.
  Other: [/^[0-9]{10,35}$/, S10_RE, /^TB[ACM][0-9]{12}$/, /^GM[0-9]{16,20}$/, /^[CD][0-9]{14}$/, /^LX[0-9]{8}$/],
};

// ---- check digits ---------------------------------------------------------
// UPS: the 15 characters after "1Z" (letters as (code - 63) mod 10), the
// even positions (1-based) doubled; check = (10 - sum mod 10) mod 10.
const upsCharValue = (c) => (/[0-9]/.test(c) ? Number(c) : (c.charCodeAt(0) - 63) % 10);
function upsCheckOk(v) {
  let t = 0;
  for (let i = 0; i < 15; i++) t += upsCharValue(v[2 + i]) * (i % 2 ? 2 : 1);
  return (10 - (t % 10)) % 10 === Number(v[17]);
}
// GS1 mod-10 (USPS IMpb): weights 3,1,3,... from the right of the digits
// before the check digit.
function mod10Weights31Ok(v) {
  const d = [...v].map(Number);
  const check = d.pop();
  let t = 0;
  d.reverse().forEach((x, i) => { t += x * (i % 2 ? 1 : 3); });
  return (10 - (t % 10)) % 10 === check;
}
// FedEx Express 12-digit: weights 1,3,7 from the right, mod 11, mod 10.
function fedex12CheckOk(v) {
  const d = [...v].map(Number);
  const check = d.pop();
  const w = [1, 3, 7];
  let t = 0;
  d.reverse().forEach((x, i) => { t += x * w[i % 3]; });
  return (t % 11) % 10 === check;
}
// UPU S10: weights 8,6,4,2,3,5,9,7 over the 8 serial digits, 11 - sum mod 11
// (10 -> 0, 11 -> 5).
function s10CheckOk(v) {
  const w = [8, 6, 4, 2, 3, 5, 9, 7];
  let t = 0;
  for (let i = 0; i < 8; i++) t += Number(v[2 + i]) * w[i];
  let c = 11 - (t % 11);
  if (c === 10) c = 0;
  if (c === 11) c = 5;
  return c === Number(v[10]);
}
function checkDigitOk(name, v) {
  if (name === 'UPS') return upsCheckOk(v);
  if (S10_RE.test(v)) return s10CheckOk(v);
  if (name === 'USPS') return mod10Weights31Ok(v);
  if (name === 'FedEx' && v.length === 12) return fedex12CheckOk(v);
  return true;
}

// ---- handover shapes ------------------------------------------------------
// Short contact-app codes: refused when they are the WHOLE leading letter run
// (after UPS's "1Z"), or a trailing run of three or more (a two-letter
// trailing run is an S10 country code: "SC" Seychelles, "TG" Togo).
const CONTACT_APP_RUNS = new Set(['SNAP', 'INSTA', 'SC', 'TG', 'WA', 'IG', 'KIK', 'LINE', 'X', 'FB', 'CASH', 'MAIL', 'TEXT',
  'SMS', 'CALL', 'DM', 'DMS', 'TEL', 'CELL', 'MOB', 'ZAP', 'VEN', 'TT']);
// Contact / payment app fragments refused ANYWHERE inside one letter run (a
// UPS shipper segment holds up to six letters: "SNAPJE", "CASHAP", "WHATSA").
// Four letters or more, or a name no carrier prefix spells, so a real S10
// service code + country code or a random UPS shipper cannot trip it.
const CONTACT_APP_FRAGMENTS = ['SNAP', 'INSTA', 'WHATS', 'CASH', 'KIK', 'TELEG', 'ONLYF', 'FANS', 'PAYP', 'VENMO', 'ZELLE',
  'SKYPE', 'GMAIL', 'EMAIL', 'PHONE', 'TEXT', 'CALL', 'SIGNAL', 'WECHAT', 'VIBER', 'WICKR', 'TIKTOK', 'CHIME', 'DISCORD'];

// A refused carrier that names a contact or payment app ("Snap", "Cash App",
// "WhatsApp", "text") is logged as a handover attempt rather than read as a
// typo. Compared on the letters only; the long names anywhere, the short ones
// only as the whole value.
const CONTACT_APP_CARRIER_ANYWHERE = [
  'snapchat', 'telegram', 'whatsapp', 'instagram', 'signal', 'discord', 'wickr', 'skype', 'wechat', 'viber',
  'messenger', 'facebook', 'twitter', 'tiktok', 'onlyfans', 'fansly', 'cashapp', 'venmo', 'zelle', 'paypal', 'applepay',
  'googlepay', 'chime', 'westernunion', 'moneygram', 'gmail', 'hotmail', 'outlook', 'icloud', 'protonmail',
];
const CONTACT_APP_CARRIER_EXACT = ['snap', 'insta', 'sc', 'tg', 'wa', 'ig', 'kik', 'line', 'x', 'fb', 'cash', 'email', 'mail', 'phone',
  'text', 'sms', 'call', 'dm', 'dms'];
export function carrierNamesContactApp(carrier) {
  const letters = String(carrier || '').toLowerCase().replace(/[^a-z]/g, '');
  return CONTACT_APP_CARRIER_EXACT.includes(letters) || CONTACT_APP_CARRIER_ANYWHERE.some((w) => letters.includes(w));
}

// A phone number hiding in the digits: a 10-digit North American number
// (area and exchange codes start 2-9), the same with a leading 1, or a UK
// mobile ("07" + 9 digits / "447" + 9 digits).
function looksLikePhone(digits) {
  return /^1?[2-9][0-9]{2}[2-9][0-9]{6}$/.test(digits) || /^(?:07|447)[0-9]{9}$/.test(digits);
}
// What is left of a digit run around each phone-shaped 10/11-digit window.
function phoneWindowRests(run) {
  const rests = [];
  for (const len of [10, 11]) {
    for (let i = 0; i + len <= run.length; i++) {
      if (looksLikePhone(run.slice(i, i + len))) rests.push(run.slice(0, i) + run.slice(i + len));
    }
  }
  return rests;
}
// A phone number padded out to a tracking length with one repeated digit
// ("61755512340000000000", "0006175551234000"). Real numbers essentially
// never leave three or more identical digits around a phone-shaped window.
function paddedPhone(run) {
  return phoneWindowRests(run).some((rest) => rest.length >= 3 && /^([0-9])\1*$/.test(rest));
}

/**
 * null when `{ carrier, trackingNumber }` are acceptable, otherwise
 * `{ field: 'carrier' | 'trackingNumber', message, suspicious? }`.
 * `suspicious` marks a value refused because it looks like a contact
 * handover (a phone number, an app name) rather than a typo -- the ship route
 * logs those to the violations queue. Callers store normalizeTracking()'s
 * output, never the raw input.
 */
export function trackingFieldsError({ carrier, trackingNumber } = {}) {
  const name = normalizeCarrier(carrier);
  if (!name) {
    if (carrierNamesContactApp(carrier)) {
      return { field: 'carrier', message: 'Carrier: choose the shipping company (USPS, UPS, FedEx, DHL or Other), not an app or contact.', suspicious: true };
    }
    return { field: 'carrier', message: `Carrier: choose one of ${SHIPPING_CARRIERS.join(', ')}.` };
  }
  const value = compactTrackingNumber(trackingNumber);
  const hint = `Tracking number for ${name}: ${TRACKING_FORMAT_HINTS[name]}.`;
  if (!/^[A-Z0-9]{8,35}$/.test(value)) {
    return { field: 'trackingNumber', message: `${hint} Letters and numbers only.` };
  }
  if ((value.match(/[0-9]/g) || []).length < 6) return { field: 'trackingNumber', message: hint };

  // Handover shapes first, under every carrier, so they are logged rather
  // than answered as a mere format error.
  const body = name === 'UPS' && value.startsWith('1Z') ? value.slice(2) : value;
  const runs = body.match(/[A-Z]+/g) || [];
  const lead = (body.match(/^[A-Z]+/) || [''])[0];
  const tail = (body.match(/[A-Z]+$/) || [''])[0];
  if (CONTACT_APP_RUNS.has(lead) || (tail.length >= 3 && CONTACT_APP_RUNS.has(tail))
    || runs.some((r) => CONTACT_APP_FRAGMENTS.some((f) => r.includes(f)))) {
    return { field: 'trackingNumber', message: 'Enter the carrier\'s tracking number, not an app or contact.', suspicious: true };
  }
  const digitRuns = value.match(/[0-9]+/g) || [];
  if ((name !== 'DHL' && name !== 'UPS' && digitRuns.some(looksLikePhone)) || digitRuns.some(paddedPhone)
    || (name === 'Other' && (/^[0-9]{10,13}$/.test(value) || !FORMATS.Other.some((re) => re.test(value)))
      && digitRuns.some((r) => r.length <= 13 && phoneWindowRests(r).length > 0))) {
    return { field: 'trackingNumber', message: 'That looks like a phone number, not a tracking number. If it is one, pick the carrier it belongs to.', suspicious: true };
  }

  if (!FORMATS[name].some((re) => re.test(value))) return { field: 'trackingNumber', message: hint };
  if (!checkDigitOk(name, value)) {
    return { field: 'trackingNumber', message: `${hint} Check the number: its check digit does not match.` };
  }
  return null;
}

/** The values to store: `{ carrier, trackingNumber }` in canonical form (only after trackingFieldsError passed). */
export function normalizeTracking({ carrier, trackingNumber } = {}) {
  return { carrier: normalizeCarrier(carrier), trackingNumber: compactTrackingNumber(trackingNumber) };
}
