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
 *     and must be 6-35 letters and digits. There is NO digit minimum (round
 *     19 money#0, DECIDED): GLS prints an 8-character TrackID with 1-4 digits
 *     ("ZF8YY6HP", "ZFXYAB6H"), Sendle references are 7-8 characters with few
 *     digits, and round 18's 2-digit floor still refused the one-digit GLS
 *     IDs. Fewer than 6 digits only gets the non-blocking warning;
 *   - UPS: a number starting "1Z" must be "1Z" + 16 letters/digits (any other
 *     UPS number, e.g. Mail Innovations or freight, is taken as it is);
 *   - refused, and logged as a suspected handover (`suspicious`): a letter run
 *     holding a whole contact/payment app name (WHATSAPP, VENMO ...; the short
 *     SNAP/INSTA only when they are the whole run or sit in a run of six or
 *     more letters, the three-letter KIK only as a run that OPENS the number
 *     -- a three-letter merchant code inside one, e.g. Australia Post "33" +
 *     "KIK" + digits, is a real format; round-18 money#0). Inside a
 *     well-formed UPS "1Z" number the short-name rules skip a letter run
 *     that ends within the shipper + service segment (the first 8
 *     characters after "1Z"), which can be a real shipper ("1ZSNAP12...");
 *     the whole long names (VENMO, WHATSAPP ...) are refused there too;
 *   - refused as a plain typo (never logged): an "@" (an email address);
 *   - letter runs are NOT refused (round 17 money#0, dashboard#1): real
 *     carrier numbers hold them -- DHL Parcel "JVGL" + digits, PostNL "3S" +
 *     a four-letter customer code + digits, UPS shippers. A run of four or
 *     more letters only gets the non-blocking warning below;
 *   - no check digits and no phone-number heuristic are ENFORCED. A number
 *     that does not look like the carrier's usual format only gets a
 *     non-blocking warning (trackingFormatWarning) for the form to show.
 *
 * Residual, stated plainly: a digits-only field can carry a phone number, and
 * a bare word or handle ("JESSXO", "JESSXO1") is accepted as a tracking
 * number when it names no contact or payment app. That is the accepted
 * trade-off -- every digit floor refused real tracking numbers -- backed by
 * human review, buyer reports and the non-blocking format warning.
 */

export const SHIPPING_CARRIERS = ['USPS', 'UPS', 'FedEx', 'DHL', 'Other'];

const CARRIER_BY_KEY = new Map(SHIPPING_CARRIERS.map((c) => [c.toLowerCase(), c]));

// Format hints, one line per carrier, for the ship form and the error text.
// They describe the usual shapes; the rule actually enforced is the generic
// one in the header (6-35 letters/digits, no digit minimum).
export const TRACKING_FORMAT_HINTS = {
  USPS: 'usually 20-22 digits, or 2 letters + 9 digits + "US"',
  UPS: 'usually "1Z" + 16 letters/digits',
  FedEx: 'usually 12, 15, 20 or 22 digits',
  DHL: 'usually 10 or 11 digits, "JD" + 18 digits, or "JVGL" + digits (DHL eCommerce "GM..." numbers: choose Other)',
  Other: 'the number your carrier gave you: 6-35 letters and digits',
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
// Real formats with a run of four letters, for the non-blocking letter-run note.
const KNOWN_LETTER_SHAPES = [/^JVGL[0-9]{6,31}$/, /^3S[A-Z]{4}[0-9]{6,29}$/];
// The USUAL shapes, for the non-blocking warning only -- never enforced.
const FORMATS = {
  UPS: [/^1Z[0-9A-Z]{15}[0-9]$/],
  USPS: [/^[0-9]{20}$/, /^9[0-9]{21}$/, /^[A-Z]{2}[0-9]{9}US$/],
  FedEx: [/^(?:[0-9]{12}|[0-9]{15}|[0-9]{20}|[0-9]{22})$/],
  DHL: [/^[0-9]{10,11}$/, /^JD[0-9]{18}$/, /^JVGL[0-9]{6,31}$/],
  Other: [/^[A-Z0-9]{6,35}$/],
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
// Whole contact / payment app names refused inside one letter run -- the only
// tracking-number refusal that is logged as a suspected handover. The long
// names (every name in CONTACT_APP_NAMES) anywhere in ANY run, 1Z shipper
// included: no real shipper or service code spells VENMO, ZELLE, PAYPAL or a
// longer app name, and a 1Z body that does ("1ZVENMO05551234567") is a
// handle plus a phone number. The short ones can sit inside a real carrier
// code (a PostNL "3S" + four-letter customer code is a five-letter run, a UPS
// shipper six), so SNAP/INSTA count only as the whole run or inside a run of
// six letters or more, and KIK only as a whole run that opens the number
// ("KIK12345678") -- "33KIK1234567890" is an Australia Post merchant code
// (round-18 money#0) -- and neither short rule looks inside a 1Z shipper +
// service segment (namesContactApp).
// Round 19 (money#0): with no digit floor left, the app-name check is the one
// handover refusal, so it names every contact / payment app the carrier check
// does (discord, wickr, skype...), not only the nine it started with.
const CONTACT_APP_NAMES = ['SNAPCHAT', 'WHATSAPP', 'TELEGRAM', 'CASHAPP', 'VENMO', 'PAYPAL', 'ZELLE', 'INSTAGRAM', 'ONLYFANS',
  'DISCORD', 'WICKR', 'SKYPE', 'WECHAT', 'VIBER', 'SIGNAL', 'TIKTOK', 'FANSLY', 'TWITTER', 'FACEBOOK', 'MESSENGER', 'APPLEPAY',
  'GOOGLEPAY', 'WESTERNUNION', 'MONEYGRAM', 'GMAIL', 'HOTMAIL', 'ICLOUD', 'PROTONMAIL'];
const SHORT_APP_NAMES = ['SNAP', 'INSTA'];
const runHasLongAppName = (run) => CONTACT_APP_NAMES.some((n) => run.includes(n));
function runHasShortAppName(run, atStart) {
  if (run === 'KIK') return atStart;
  return SHORT_APP_NAMES.some((n) => run === n || (run.length >= 6 && run.includes(n)));
}
// True when a letter run of `value` names a contact / payment app. In a
// well-formed UPS 1Z number ("1Z" + 6 shipper + 2 service + 8 package digits)
// a run that ends within the shipper + service segment (the first 8 body
// characters) is checked for the long names only: those 8 can spell a short
// word a real shipper might ("1ZSNAP12...", "1Z12KIK3A1..."), never a whole
// app name. A run reaching past them gets both checks.
function namesContactApp(name, value) {
  const oneZ = UPS_ONE_Z.test(value) && isUpsOneZ(name, value);
  const body = isUpsOneZ(name, value) ? value.slice(2) : value;
  for (const m of body.matchAll(/[A-Z]+/g)) {
    const run = m[0];
    if (runHasLongAppName(run)) return true;
    if (oneZ && m.index + run.length <= 8) continue;
    if (runHasShortAppName(run, m.index === 0)) return true;
  }
  return false;
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
  if (namesContactApp(name, value)) {
    return { field: 'trackingNumber', message: 'Enter the carrier\'s tracking number, not an app or contact.', suspicious: true };
  }
  if (!/^[A-Z0-9]{6,35}$/.test(value)) {
    return { field: 'trackingNumber', message: `${hint} Letters and numbers only, 6-35 of them.` };
  }
  if (isUpsOneZ(name, value) && !UPS_ONE_Z.test(value)) {
    return { field: 'trackingNumber', message: 'Tracking number for UPS: a "1Z" number is "1Z" + 16 letters/digits.' };
  }
  // No letter-run refusal (round 17 money#0, dashboard#1): real numbers hold
  // runs of four or more letters (DHL Parcel "JVGL...", PostNL "3SABCD...").
  // trackingFormatWarning notes an unusual one without blocking it.
  return null;
}

/**
 * A NON-BLOCKING note for the ship form (null when nothing looks off): the
 * number does not match the carrier's usual format, or a check digit the
 * format carries does not match. Never a reason to refuse -- carriers use
 * more formats than any list here (round-16 money#0/#1, dashboard#0/#1).
 * Only meaningful for a number trackingFieldsError already accepted.
 *
 * `{ saved: true }` is the wording for AFTER the number was stored (the
 * dashboard's post-save banner, round-18 dashboard#0): it never says "before
 * saving", since there is nothing left to save. The caller adds what to do
 * next (Edit tracking, which uses up one of the order's limited corrections).
 */
export function trackingFormatWarning({ carrier, trackingNumber } = {}, { saved = false } = {}) {
  const name = normalizeCarrier(carrier);
  if (!name) return null;
  const value = compactTrackingNumber(trackingNumber);
  if (name !== 'Other' && !FORMATS[name].some((re) => re.test(value))) {
    return `This doesn't look like a usual ${name} number (${TRACKING_FORMAT_HINTS[name]}).${saved ? '' : ' Double-check it before saving.'}`;
  }
  if (!checkDigitOk(name, value)) return 'Double-check this number: its check digit does not match the usual one.';
  // Short or low-digit references are real (GLS TrackIDs, Sendle) but
  // unusual: noted, never refused (round-18 money#0).
  if ((value.match(/[0-9]/g) || []).length < 6) {
    return 'Double-check this number: most tracking numbers have more digits than this.';
  }
  // A run of four or more letters outside a known shape (UPS 1Z, DHL JVGL,
  // PostNL 3S + customer code) is unusual but never refused.
  if (!isUpsOneZ(name, value) && !KNOWN_LETTER_SHAPES.some((re) => re.test(value)) && /[A-Z]{4}/.test(value)) {
    return 'Double-check this number: tracking numbers rarely have a word in them.';
  }
  return null;
}

/** The values to store: `{ carrier, trackingNumber }` in canonical form (only after trackingFieldsError passed). */
export function normalizeTracking({ carrier, trackingNumber } = {}) {
  return { carrier: normalizeCarrier(carrier), trackingNumber: compactTrackingNumber(trackingNumber) };
}
