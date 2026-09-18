import { put } from '@vercel/blob';
import { addPendingCreator } from '../../../lib/creators-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';
import { checkRateLimit, clientIp, recordFailure } from '../../../lib/rate-limit';

export const config = {
  api: {
    bodyParser: false,
  },
};

// This form is public and unauthenticated -- anyone on the internet can POST
// it -- so everything it accepts has to be bounded here rather than left open.
// The gallery cap matches the 50 free-tier content slots a logged-in creator
// gets in pages/api/me/upload.js; the byte cap bounds what a single submission
// can buffer in memory and push into blob storage (Vercel's own request-body
// limit is stricter still in production, this covers any other deployment).
const MAX_GALLERY_FILES = 50;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_NAME = 80;
const MAX_HANDLE = 40;
const MAX_BIO = 1000;
const MAX_EMAIL = 200;

// Every accepted submission writes blobs and appends to a shared manifest, and
// a rejected one can still append to the violations manifest, so this endpoint
// gets its own per-IP budget the way pages/api/auth/login.js does. See
// lib/rate-limit.js for what that does and does not guarantee on serverless --
// a speed bump against one host hammering it, not a hard lockout.
const SUBMIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_SUBMITS_PER_IP = 5;

// SVG is an image as far as Content-Type goes but can carry script, and
// everything uploaded here is served back from a public blob URL -- excluded
// from both the avatar and the gallery branch on purpose.
const SVG_TYPE = /^image\/svg/;

/** Returns null (rather than throwing) once the request body passes MAX_UPLOAD_BYTES. */
async function readMultipart(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const ipKey = `creator-application:ip:${clientIp(req)}`;
  const { limited, retryAfterSeconds } = checkRateLimit(ipKey, { limit: MAX_SUBMITS_PER_IP, windowMs: SUBMIT_WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'Too many applications from this address. Please wait a few minutes and try again.' });
  }
  // Recorded on every attempt, not just rejected ones -- what this bounds (blob
  // writes, and the violations-manifest append a flagged submission triggers)
  // is spent before we know whether the submission was any good.
  recordFailure(ipKey, { limit: MAX_SUBMITS_PER_IP, windowMs: SUBMIT_WINDOW_MS });

  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Expected multipart/form-data' });
    }

    const body = await readMultipart(req);
    if (!body) {
      return res.status(413).json({ error: `Submission is too large (limit ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB).` });
    }
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) return res.status(400).json({ error: 'No boundary found' });
    const boundary = '--' + boundaryMatch[1];

    const parts = body.toString('binary').split(boundary).slice(1, -1);
    const fields = {};
    const files = [];

    for (const part of parts) {
      const [rawHeaders, ...rest] = part.split('\r\n\r\n');
      const content = rest.join('\r\n\r\n').slice(0, -2);
      const nameMatch = rawHeaders.match(/name="([^"]+)"/);
      const filenameMatch = rawHeaders.match(/filename="([^"]+)"/);
      if (!nameMatch) continue;

      if (filenameMatch && filenameMatch[1]) {
        const fileTypeMatch = rawHeaders.match(/Content-Type: (.+)/);
        files.push({
          field: nameMatch[1],
          filename: filenameMatch[1],
          contentType: fileTypeMatch ? fileTypeMatch[1].trim() : 'application/octet-stream',
          buffer: Buffer.from(content, 'binary'),
        });
      } else {
        // The whole body was read as latin1 so file bytes survive the split
        // above -- text fields have to be decoded back to real UTF-8 here, or
        // any non-ASCII name/bio is stored mojibake'd ("Renée" -> "RenÃ©e").
        fields[nameMatch[1]] = Buffer.from(content, 'binary').toString('utf8');
      }
    }

    const name = (fields.name || '').trim();
    const handle = (fields.handle || '').trim();
    const bio = (fields.bio || '').trim();
    const email = (fields.email || '').trim();
    if (!name || !handle || !bio) {
      return res.status(400).json({ error: 'Missing required fields (name, handle, bio)' });
    }

    // The form's checkbox is not a gate on its own -- this endpoint is
    // reachable directly. Same 18+/Terms/Privacy acceptance pages/signup.js
    // requires before an account can be created.
    if (fields.agreed !== 'true') {
      return res.status(400).json({ error: 'You must confirm you are 18+ and agree to the Terms of Service and Privacy Policy.' });
    }

    if (name.length > MAX_NAME || handle.length > MAX_HANDLE || bio.length > MAX_BIO || email.length > MAX_EMAIL) {
      return res.status(400).json({ error: 'Name, handle, bio, or email is too long.' });
    }

    // Same check pages/api/me/profile.js runs on a logged-in creator's
    // name/handle/bio. This form is the easiest place on the site to plant a
    // Cash App handle -- it's public and needs no account at all. The contact
    // email field is deliberately not checked: it's asked for on purpose, and
    // the filter flags every email address by design.
    for (const [field, value] of [['name', name], ['handle', handle], ['bio', bio]]) {
      const check = detectPaymentCircumvention(value);
      if (check.flagged) {
        await addViolation({
          userId: `creator-application:${handle}`,
          context: `application_${field}`,
          reasons: check.reasons,
          snippet: value,
        });
        return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
      }
    }

    // Counted off the files actually parsed out of this request body, not off
    // anything the browser told us it was sending. EVERY part gets uploaded by
    // the loop below, so every part has to be counted here: capping only the
    // non-avatar ones left "name all 500 parts avatar" as an uncapped way to
    // make this public endpoint write an unbounded number of blobs.
    const avatarUploads = files.filter((f) => f.field === 'avatar');
    const galleryUploads = files.filter((f) => f.field !== 'avatar');
    if (avatarUploads.length > 1) {
      return res.status(400).json({ error: 'Only one profile photo can be submitted.' });
    }
    if (galleryUploads.length > MAX_GALLERY_FILES) {
      return res.status(400).json({ error: `You can submit up to ${MAX_GALLERY_FILES} gallery files.` });
    }
    for (const file of files) {
      const allowed = file.field === 'avatar' ? /^image\// : /^(image|video)\//;
      if (!allowed.test(file.contentType) || SVG_TYPE.test(file.contentType)) {
        return res.status(400).json({
          error: file.field === 'avatar' ? 'Profile photo must be an image.' : 'Only image and video uploads are accepted.',
        });
      }
    }

    let avatarUrl = null;
    const gallery = [];

    for (const file of files) {
      const blob = await put(`pending-creators/${Date.now()}-${file.filename}`, file.buffer, {
        access: 'public',
        contentType: file.contentType,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      if (file.field === 'avatar') {
        avatarUrl = blob.url;
      } else {
        gallery.push({ type: file.contentType.startsWith('video') ? 'video' : 'image', src: blob.url });
      }
    }

    // Price ends up as a display string on the public creator card, so it has
    // to be a number here -- an unauthenticated form must not be able to write
    // arbitrary text into a field shown site-wide. The form asks for millions
    // of $ONLYASS, which is the format data/creators.js already uses.
    const priceMillions = Number(fields.price);
    const price = Number.isFinite(priceMillions) && priceMillions > 0 ? `${priceMillions}M $ONLYASS` : '1M $ONLYASS';

    const creator = await addPendingCreator({
      name,
      handle: handle.startsWith('@') ? handle : `@${handle}`,
      bio,
      contactEmail: email || null,
      img: avatarUrl || '/images/mascot.png',
      video: null,
      price,
      gallery,
    });

    return res.status(200).json({ ok: true, creator });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
