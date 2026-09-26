/**
 * The shape of a shipment's carrier and tracking number (pure: no database,
 * safe in the browser -- the dashboard's ship form uses the same list).
 *
 * The carrier and tracking number are shown to the buyer on /orders, so they
 * are creator-to-buyer text. Round 15 stopped treating them as free text
 * (a fixed carrier list and a compacted tracking number), and also added
 * per-carrier formats, check digits, phone-number and app-fragment heuristics.
 * Those heuristics refused real numbers (round-16 money#0/#1, dashboard#0/#1):
 * UPS shippers starting with X/WA/IG..., UPS service codes with letters, and
 * nearly every 10-13 digit number under "Other" (read as a phone number) --
 * and logged the creator as a suspected fee-dodger each time, while the paid
 * order could never be marked shipped. So, round 16:
 *
 *   NEVER refuse something that can be a real tracking number. A residual
 *   miss is acceptable (every refusal and every shipment is backed by human
 *   review and buyer reports); a false refusal is not.
 *
 * The rules now:
 *   - the carrier is one of a fixed list (SHIPPING_CARRIERS);
 *   - the tracking number is compacted (spaces and "-" dropped, upper-cased)
 *     and must be 8-35 letters and digits with at least 6 digits;
 *   - UPS: a number starting "1Z" must be "1Z" + 16 letters/digits (any other
 *     UPS number, e.g. Mail Innovations or freight, is taken as it is);
 *   - refused, and logged as a suspected handover (`suspicious`): a letter run
 *     holding a whole contact/payment app name (SNAP, WHATSAPP, VENMO ...; the
 *     three-letter KIK only when it is the entire letter run);
 *   - refused as a plain typo (never logged): an "@" (an email address), or a
 *     letter run of four or more letters anywhere except inside a UPS "1Z"
 *     number (no carrier format has one; UPS shippers and service codes do);
 *   - no check digits and no phone-number heuristic are ENFORCED. A number
 *     that does not look like the carrier's usual format only gets a
 *     non-blocking warning (trackingFormatWarning) for the form to show.
 *
 * Residual, stated plainly: a digits-only field can carry a phone number.
 * That is the accepted trade-off -- the alternative refused most real
 * 10-13 digit tracking numbers.
 */

export const SHIPPING_CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'];

const CARRIER_BY_KEY = new Map(SHIPPING_CARRIERS.map((c) => [c.toLowerCase(), c]));

// Format hints, one line per carrier, for the ship form and the error text.
// They describe the usual shapes; the rule actually enforced is the generic
// one in the header (8-35 letters/digits, at least 6 digits).
export const TRACKING_FORMAT_HINTS = {
  USPS: 'usually 20-22 digits, or 2 letters + 9 digits + "US"',
  UPS: 'usually "1Z" + 16 letters/digits',
  FedEx: 'usually 12, 15, 20 or 22 digits',
  DHL: 'usually 10 or 11 digits, or "JD" + 18 digits (DHL eCommerce "GM..." numbers: choose Other)',
  Other: 'the number your carrier gave you: 8-35 letters and digits, at least 6 of them digits',
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
// The USUAL shapes, for the non-blocking warning only -- never enforced.
const FORMATS = {
  UPS: [/^1Z[0-9A-Z]{15}[0-9]$/],
  USPS: [/^[0-9]{20}$/, /^9[0-9]{21}$/, /^[A-Z]{2}[0-9]{9}US$/],
  FedEx: [/^(?:[0-9]{12}|[0-9]{15}|[0-9]{20}|[0-9]{22})$/],
  DHL: [/^[0-9]{10,11}$/, /^JD[0-9]{18}$/],
  Other: [/^[A-Z0-9]{8,35}$/],
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
// Whole contact / payment app names (four letters or more) refused anywhere
// inside one letter run -- the only tracking-number refusal that is logged as
// a suspected handover. KIK (three letters, which real shippers and codes can
// hold) only when it is the ENTIRE letter run.
const CONTACT_APP_NAMES = ['SNAPCHAT', 'SNAP', 'WHATSAPP', 'TELEGRAM', 'CASHAPP', 'VENMO', 'PAYPAL', 'ZELLE', 'INSTAGRAM',
  'INSTA', 'ONLYFANS'];
function runNamesContactApp(run) {
  return run === 'KIK' || CONTACT_APP_NAMES.some((n) => run.includes(n));
}

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

// A UPS "1Z" number: under UPS, anything starting "1Z" is held to this shape;
// under any other carrier a value that already has exactly this shape (a
// UPS number filed under "Other") is read the same way.
const UPS_ONE_Z = /^1Z[0-9A-Z]{16}$/;
const isUpsOneZ = (name, value) => (name === 'UPS' && value.startsWith('1Z')) || UPS_ONE_Z.test(value);

/**
 * null when `{ carrier, trackingNumber }` are acceptable, otherwise
 * `{ field: 'carrier' | 'trackingNumber', message, suspicious? }`.
 * `suspicious` is set ONLY for an app named as the carrier or inside the
 * tracking number -- the ship route logs those to the violations queue; every
 * other refusal is a plain typo and logs nothing. Callers store
 * normalizeTracking()'s output, never the raw input.
 */
export function trackingFieldsError({ carrier, trackingNumber } = {}) {
  const name = normalizeCarrier(carrier);
  if (!name) {
    if (carrierNamesContactApp(carrier)) {
      return { field: 'carrier', message: 'Carrier: choose the shipping company (USPS, UPS, FedEx, DHL or Other), not an app or contact.', suspicious: true };
    }
    return { field: 'carrier', message: `Carrier: choose one of ${SHIPPING_CARRIERS.join(', ')}.` };
  }
  const hint = `Tracking number for ${name}: ${TRACKING_FORMAT_HINTS[name]}.`;
  if (typeof trackingNumber === 'string' && trackingNumber.includes('@')) {
    return { field: 'trackingNumber', message: 'Enter the carrier\'s tracking number, not an email address.' };
  }
  const value = compactTrackingNumber(trackingNumber);
  // The app check runs on the letters before any format check, so a handover
  // that is also malformed is still logged.
  const body = isUpsOneZ(name, value) ? value.slice(2) : value;
  const runs = body.match(/[A-Z]+/g) || [];
  if (runs.some(runNamesContactApp)) {
    return { field: 'trackingNumber', message: 'Enter the carrier\'s tracking number, not an app or contact.', suspicious: true };
  }
  if (!/^[A-Z0-9]{8,35}$/.test(value)) {
    return { field: 'trackingNumber', message: `${hint} Letters and numbers only, 8-35 of them.` };
  }
  if ((value.match(/[0-9]/g) || []).length < 6) {
    return { field: 'trackingNumber', message: `${hint} It needs at least 6 digits.` };
  }
  if (isUpsOneZ(name, value)) {
    if (!UPS_ONE_Z.test(value)) {
      return { field: 'trackingNumber', message: 'Tracking number for UPS: a "1Z" number is "1Z" + 16 letters/digits.' };
    }
  } else if (runs.some((r) => r.length >= 4)) {
    // No carrier's number has four letters in a row (UPS "1Z" numbers are
    // handled above); a word is a typo or a note, not a tracking number.
    return { field: 'trackingNumber', message: `${hint} A tracking number has no words in it.` };
  }
  return null;
}

/**
 * A NON-BLOCKING note for the ship form (null when nothing looks off): the
 * number does not match the carrier's usual format, or a check digit the
 * format carries does not match. Never a reason to refuse -- carriers use
 * more formats than any list here (round-16 money#0/#1, dashboard#0/#1).
 * Only meaningful for a number trackingFieldsError already accepted.
 */
export function trackingFormatWarning({ carrier, trackingNumber } = {}) {
  const name = normalizeCarrier(carrier);
  if (!name) return null;
  const value = compactTrackingNumber(trackingNumber);
  if (name !== 'Other' && !FORMATS[name].some((re) => re.test(value))) {
    return `This doesn't look like a usual ${name} number (${TRACKING_FORMAT_HINTS[name]}). Double-check it before saving.`;
  }
  if (!checkDigitOk(name, value)) return 'Double-check this number: its check digit does not match the usual one.';
  return null;
}

/** The values to store: `{ carrier, trackingNumber }` in canonical form (only after trackingFieldsError passed). */
export function normalizeTracking({ carrier, trackingNumber } = {}) {
  return { carrier: normalizeCarrier(carrier), trackingNumber: compactTrackingNumber(trackingNumber) };
}
