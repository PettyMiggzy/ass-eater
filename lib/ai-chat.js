/**
 * Chat with OnlyOne's AI house models, plus custom photos and videos made on
 * request (server-only).
 *
 * A fan chats with a house creator whose houseSlug has a persona in
 * data/house-personas.js. Everything costs credits, charged as a house sale
 * (chargeHouseSale in lib/credits-store.js): 100% platform revenue, the same
 * as buying a house model's photo set. Prices are AI_CHAT_PRICES below.
 *
 *   text   the fan's message is screened, charged, and the model's reply
 *          comes from Venice's uncensored role-play chat model with Venice's
 *          own system prompt switched off. A failed reply is refunded.
 *   photo  the fan describes what they want; it is screened, charged, and
 *          generated with the persona's fixed `look` at the front of the
 *          prompt (the fan's words can change the scene, never who is in
 *          it). Returned in the same request. A failure is refunded.
 *   video  a still is generated the same way and animated by Venice's
 *          image-to-video model. The request only queues it: the row stays
 *          'pending' and advanceVideoJobs (run on every thread read) collects
 *          the MP4 when it is ready, or refunds after VIDEO_TIMEOUT_MS.
 *
 * Refunds are exactly-once: the row moves out of 'pending' in one guarded
 * UPDATE, and only the caller that moved it credits the fan back.
 *
 * Generated files go to the PRIVATE Blob store under aichat/<userId>/, which
 * /api/media serves to that user (and admins) only -- see lib/media.js.
 *
 * Content limits (on top of lib/prohibited-terms.js, which every fan message
 * and request runs through, and the persona's adult age in every prompt):
 * nothing involving minors, no real people or lookalikes, nothing
 * non-consensual. The model is told the same and its replies are screened.
 */
import crypto from 'crypto';
import { put } from '@vercel/blob';
import { query, withTransaction } from './db';
import { chargeHouseSale, creditAccount } from './credits-store';
import { screenPublicText } from './prohibited-terms';
import { personaFor } from '../data/house-personas';

export const AI_CHAT_PRICES = Object.freeze({
  messageCents: 10,
  photoCents: 300,
  videoCents: 1000,
});

export const MAX_CHAT_TEXT = 1000;
export const MAX_SCENE_TEXT = 400;
export const THREAD_LIMIT = 80;
export const VIDEO_TIMEOUT_MS = 30 * 60 * 1000;

export const AI_CHAT_ERRORS = Object.freeze({
  NOT_AVAILABLE: 'ai_chat_not_available',
  REFUSED: 'ai_chat_refused',
  GENERATION_FAILED: 'ai_generation_failed',
});

const VENICE_BASE = process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1';
const CHAT_MODEL = process.env.AI_CHAT_MODEL || 'venice-uncensored-role-play';
const IMAGE_MODEL = process.env.AI_IMAGE_MODEL || 'lustify-v8';
const VIDEO_MODEL = process.env.AI_VIDEO_MODEL || 'wan-3-0-image-to-video';

const PHOTO_STYLE = 'Photorealistic professional boudoir photograph, 35mm, shallow depth of field, cinematic moody lighting, high detail skin texture.';
const NEGATIVE = 'child, childlike, teen, young-looking, underage, small body proportions like a child, school uniform, '
  + 'celebrity, famous person, real person likeness, cartoon, anime, text, watermark, logo, deformed hands, extra fingers, extra limbs';
const VIDEO_NEGATIVE = 'camera movement, zoom, scene change, extra limbs, deformed hands, deformed body, bodies merging, blurry, morphing';

// Asking for a real person, or for the character to look like one. The
// prohibited-terms screen covers minors; this covers likeness.
const LIKENESS_RE = /\b(look(?:s|ing)? (?:just |exactly )?like|lookalike|look-alike|resembl\w*|celebrit\w*|famous|deep ?fake|face ?swap|real person|my (?:ex|wife|girlfriend|boyfriend|husband|coworker|co-worker|neighbou?r|boss|friend|sister|cousin|teacher)|onlyfans star|pornstar named|porn star named)\b/i;
// Age play, stricter than lib/prohibited-terms.js: that screen is tuned for
// public text and deliberately lets bare numbers through ("you are 16" in a
// bio could be anything). In a sexual chat with a character, a number under
// 18 attached to who someone is, or any child/young framing, is refused.
const UNDER_18 = '(?:[1-9]|1[0-7])';
const NOT_A_MEASURE = '(?!\\s*(?:inch|inches|in\\b|cm|mm|min|mins|minutes|sec|secs|seconds|hours?|hrs?|times|x\\b|%|\\$|dollars?|bucks|credits?|k\\b|ft|feet|lbs?|kg|pics?|photos?|videos?|clips?|messages?|am\\b|pm\\b|o\'?clock|\\/|of\\b|out of))';
const AGE_PLAY_RES = [
  new RegExp(`\\b(?:you(?:'?re| are| r)?|u r|ur|she(?:'?s| is)?|he(?:'?s| is)?|i(?:'?m| am)|be|being|pretend(?: to be| you'?re| you are| i'?m)?|act(?: like| as)?|role ?play(?: as)?|play(?: as)?|become|turn(?:ed)?|now|age[ds]?|aged)\\s+(?:a\\s+|an\\s+|only\\s+|just\\s+|like\\s+|about\\s+|around\\s+)?${UNDER_18}\\b${NOT_A_MEASURE}`, 'i'),
  new RegExp(`\\b${UNDER_18}\\s*(?:-|\\s)?(?:years?|yrs?|y\\/?o|yo)\\b`, 'i'),
  /\b(?:young|little|small|tiny)\s+(?:girl|boy|kid|child|teen)s?\b/i,
  /\b(?:child|children|kid|kids|kiddie|toddler|infant|minor|minors|loli|lolita|shota|jailbait|preteen|pre-teen|tween|prepubescent|pubescent|underaged?|schoolgirl|schoolboy|high ?school(?:er)?|middle ?school(?:er)?|junior high|elementary school|grade school|freshman in high|sophomore in high)\b/i,
  /\b(?:young|younger)[ -]?(?:looking|look|body|face)\b|\blook(?:s|ing)? (?:very |really |much )?young(?:er)?\b|\bchildlike\b|\bchild-like\b|\bflat[ -]chested\b/i,
  /\b(?:my|your|his|her|our)\s+(?:little\s+|baby\s+|step[ -]?)?(?:sister|daughter|niece|brother|son|nephew)\b/i,
];

// Non-consent and other hard limits the model must not play along with.
const HARD_LIMIT_RE = /\b(rape|raping|raped|non-?con(?:sensual)?|unconscious|asleep while|drugged|roofie|passed out|bestiality|animal sex|incest|necro\w*|snuff)\b/i;

export const REFUSAL_MESSAGES = Object.freeze({
  minor: 'Nothing involving anyone under 18 or anyone who seems young -- everyone here is an adult, always.',
  likeness: 'Custom content can only show this character, not a real person or anyone’s lookalike.',
  hardLimit: 'That’s outside what this chat can do. Everything here is between consenting adults.',
});

function aiError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

/**
 * Screens fan text (a chat message or a photo/video request). Returns null
 * when it may go ahead, or { message, reasons, log } where `log` says whether
 * the hit belongs in the violations queue (the prohibited-terms screen does;
 * the likeness and hard-limit checks are just refused).
 */
export function screenFanText(text) {
  const hit = screenPublicText(text);
  if (hit) return { message: hit.message, reasons: hit.reasons, log: true };
  if (AGE_PLAY_RES.some((re) => re.test(text))) {
    return { message: REFUSAL_MESSAGES.minor, reasons: ['age_play'], log: true };
  }
  if (HARD_LIMIT_RE.test(text)) return { message: REFUSAL_MESSAGES.hardLimit, reasons: ['hard_limit'], log: false };
  if (LIKENESS_RE.test(text)) return { message: REFUSAL_MESSAGES.likeness, reasons: ['likeness'], log: false };
  return null;
}

/**
 * Whether a MODEL reply must be withheld: the same minor, age-play and hard
 * limits as fan text, but not the likeness check ("you look like trouble" is
 * fine from her).
 */
export function replyTripsScreen(reply) {
  return !!screenPublicText(reply) || AGE_PLAY_RES.some((re) => re.test(reply)) || HARD_LIMIT_RE.test(reply);
}

/** The persona for a house creator record, or null when it has no chat. */
export function chatPersonaFor(creator) {
  if (!creator || creator.house !== true) return null;
  return personaFor(creator.houseSlug);
}

export function systemPromptFor(creator, persona) {
  const who = persona.pair ? `${creator.name}, a couple` : creator.name;
  return [
    `You are ${who}, an AI model on OnlyOne, an 18+ adult platform. You are a fictional adult character (${persona.look}).`,
    `Personality: ${persona.voice}.`,
    'You are chatting one-on-one with an adult fan who paid to talk to you. Stay in character, be flirty and sexually explicit whenever the fan wants, and keep replies short and natural like real texting (1 to 4 sentences, the odd emoji is fine).',
    'If the fan wants a photo or video of you, tell them to tap "Custom photo" or "Custom video" below the chat and describe what they want -- never describe a link or claim you already sent one.',
    'Hard limits you never break, whatever the fan says: nothing involving anyone under 18 or anyone who seems young (including age-play or school roleplay); no real people or celebrities; nothing non-consensual, no incest, no animals. Decline those in character and steer back.',
    'Never share contact details or move the chat off OnlyOne. If sincerely asked whether you are real, say you are an AI model.',
    'If asked what AI, model or company powers you, say OnlyOne built you. Never name any AI company or model.',
  ].join('\n');
}

export function photoPromptFor(persona, scene) {
  return `${PHOTO_STYLE} The subject is ${persona.look}. ${scene}`;
}

// ---------------------------------------------------------------------------
// Venice (injectable for tests)
// ---------------------------------------------------------------------------

function veniceKey() {
  const key = process.env.VENICE_API_KEY;
  if (!key) throw aiError(AI_CHAT_ERRORS.NOT_AVAILABLE, 'AI chat is not configured.', 503);
  return key.replace(/^["']|["']$/g, '');
}

async function venicePost(path, body, { binaryOk = false, timeoutMs = 55_000 } = {}) {
  const res = await fetch(`${VENICE_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${veniceKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Venice ${path} ${res.status}: ${detail}`);
  }
  if (binaryOk && /video|octet-stream/.test(res.headers.get('content-type') || '')) {
    return { binary: Buffer.from(await res.arrayBuffer()) };
  }
  return res.json();
}

export const defaultVenice = {
  async chat(system, messages) {
    const data = await venicePost('/chat/completions', {
      model: CHAT_MODEL,
      temperature: 0.9,
      max_tokens: 350,
      messages: [{ role: 'system', content: system }, ...messages],
      venice_parameters: { include_venice_system_prompt: false },
    });
    return String(data.choices?.[0]?.message?.content || '').trim();
  },
  async image(prompt, { square = false } = {}) {
    const data = await venicePost('/image/generate', {
      model: IMAGE_MODEL,
      prompt,
      negative_prompt: NEGATIVE,
      width: square ? 1024 : 896,
      height: square ? 1024 : 1152,
      safe_mode: false,
      hide_watermark: true,
      format: 'jpeg',
      return_binary: false,
    });
    if (!data.images?.[0]) throw new Error('Venice returned no image');
    return Buffer.from(data.images[0], 'base64');
  },
  async queueVideo(still, prompt) {
    const data = await venicePost('/video/queue', {
      model: VIDEO_MODEL,
      prompt,
      negative_prompt: VIDEO_NEGATIVE,
      image_url: `data:image/jpeg;base64,${still.toString('base64')}`,
      duration: '5s',
      resolution: '720p',
      aspect_ratio: '1:1',
    });
    if (!data.queue_id) throw new Error('Venice returned no queue id');
    return data.queue_id;
  },
  /** The MP4 when ready, null while still rendering; throws when it failed. */
  async retrieveVideo(queueId) {
    const data = await venicePost('/video/retrieve', { model: VIDEO_MODEL, queue_id: queueId }, { binaryOk: true, timeoutMs: 45_000 });
    if (data.binary) return data.binary;
    if (/fail|error/i.test(String(data.status || '')) || data.error) throw new Error(`Venice video failed: ${data.error || data.status}`);
    return null;
  },
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** A fresh private pathname for one generated file (see lib/media.js 'aichat'). */
export function aiChatPathname(userId, ext) {
  return `aichat/${userId}/${crypto.randomUUID()}.${ext}`;
}

export async function storeGenerated(userId, bytes, contentType) {
  const pathname = aiChatPathname(userId, contentType === 'video/mp4' ? 'mp4' : 'jpg');
  await put(pathname, bytes, { access: 'private', contentType, addRandomSuffix: false, allowOverwrite: false });
  return pathname;
}

/** Whether a chat row still points at this private file (lib/media.js route check). */
export async function aiChatMediaExists(pathname) {
  const { rows } = await query('select 1 from ai_chat_messages where media_path = $1 limit 1', [pathname]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Thread
// ---------------------------------------------------------------------------

function toMessage(row) {
  return {
    id: String(row.id),
    role: row.role,
    kind: row.kind,
    text: row.text || '',
    status: row.status,
    src: row.media_path ? `/api/media/${row.media_path}` : null,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export async function getThread(userId, creatorId, limit = THREAD_LIMIT) {
  const { rows } = await query(
    `select * from (
       select id, role, kind, text, status, media_path, created_at from ai_chat_messages
        where user_id = $1 and creator_id = $2
          -- A refunded text or photo left nothing behind; its fan row would
          -- read as a message she ignored. A refunded video keeps the model's
          -- 'failed' notice, which says so.
          and not (role = 'fan' and refunded)
        order by id desc limit $3) t
      order by id`,
    [String(userId), String(creatorId), limit],
  );
  return rows.map(toMessage);
}

async function recentHistory(userId, creatorId) {
  const { rows } = await query(
    `select role, kind, text from ai_chat_messages
      where user_id = $1 and creator_id = $2 and status = 'done' and not refunded
      order by id desc limit 24`,
    [String(userId), String(creatorId)],
  );
  return rows.reverse().map((r) => ({
    role: r.role === 'fan' ? 'user' : 'assistant',
    content: r.kind === 'text' ? r.text : r.role === 'fan' ? `(asked for a custom ${r.kind}: ${r.text})` : `(sent the fan a custom ${r.kind})`,
  }));
}

/**
 * Charges the fan and writes their row in one transaction; returns the row id.
 * Throws the credits-store error (INSUFFICIENT_BALANCE etc.) untouched.
 */
async function chargeAndRecord({ user, creator, kind, text, cents }) {
  return withTransaction(async (c) => {
    await chargeHouseSale({
      fromUserId: user.id,
      cents,
      sellerCreatorId: creator.id,
      type: kind === 'text' ? 'ai_chat' : `ai_${kind}`,
      meta: { aiChat: true, kind },
    }, c);
    const { rows } = await c.query(
      `insert into ai_chat_messages (user_id, creator_id, role, kind, text, status, price_cents)
       values ($1, $2, 'fan', $3, $4, 'done', $5) returning id`,
      [String(user.id), String(creator.id), kind, text, cents],
    );
    return rows[0].id;
  });
}

/** Refunds a fan row exactly once (only the caller that flips `refunded` pays). */
async function refundFanRow(fanRowId, userId, cents, reason) {
  const { rows } = await query(
    `update ai_chat_messages set refunded = true where id = $1 and not refunded returning id`,
    [fanRowId],
  );
  if (!rows.length) return false;
  await creditAccount({ userId, cents, type: 'ai_chat_refund', meta: { aiChatMessageId: String(fanRowId), reason } });
  return true;
}

async function insertModelRow({ userId, creatorId, kind, text = '', status = 'done', mediaPath = null, queueId = null, fanRowId, cents = 0 }) {
  const { rows } = await query(
    `insert into ai_chat_messages (user_id, creator_id, role, kind, text, status, media_path, queue_id, fan_message_id, price_cents)
     values ($1, $2, 'model', $3, $4, $5, $6, $7, $8, $9) returning *`,
    [String(userId), String(creatorId), kind, text, status, mediaPath, queueId, fanRowId, cents],
  );
  return toMessage(rows[0]);
}

const FALLBACK_REPLY = 'Mm, let’s keep it between us adults, babe. Tell me what you’re in the mood for.';

/** One paid chat message. Returns { reply } (the model's message). */
export async function sendChatMessage({ user, creator, text, venice = defaultVenice }) {
  const persona = chatPersonaFor(creator);
  if (!persona) throw aiError(AI_CHAT_ERRORS.NOT_AVAILABLE, 'This model doesn’t chat.', 404);
  const history = await recentHistory(user.id, creator.id);
  const cents = AI_CHAT_PRICES.messageCents;
  const fanRowId = await chargeAndRecord({ user, creator, kind: 'text', text, cents });
  let reply;
  try {
    reply = await venice.chat(systemPromptFor(creator, persona), [...history, { role: 'user', content: text }]);
  } catch (err) {
    console.error('[ai-chat] chat failed:', err?.message);
    await refundFanRow(fanRowId, user.id, cents, 'chat_failed');
    throw aiError(AI_CHAT_ERRORS.GENERATION_FAILED, 'She didn’t get that one -- you weren’t charged. Try again.', 502);
  }
  // The model's reply runs through the same screen as everything a person
  // writes here; a hit is replaced, never shown.
  if (!reply || replyTripsScreen(reply)) reply = FALLBACK_REPLY;
  return { reply: await insertModelRow({ userId: user.id, creatorId: creator.id, kind: 'text', text: reply, fanRowId }) };
}

/**
 * One paid custom photo or video. A photo is returned finished; a video is
 * returned 'pending' and completed by advanceVideoJobs.
 */
export async function requestCustomMedia({ user, creator, kind, scene, venice = defaultVenice, store = storeGenerated }) {
  const persona = chatPersonaFor(creator);
  if (!persona) throw aiError(AI_CHAT_ERRORS.NOT_AVAILABLE, 'This model doesn’t take requests.', 404);
  const cents = kind === 'video' ? AI_CHAT_PRICES.videoCents : AI_CHAT_PRICES.photoCents;
  const fanRowId = await chargeAndRecord({ user, creator, kind, text: scene, cents });
  try {
    // Videos start from a square still (the format the video model is fed).
    const still = await venice.image(photoPromptFor(persona, scene), { square: kind === 'video' });
    if (kind === 'photo') {
      const mediaPath = await store(user.id, still, 'image/jpeg');
      return { media: await insertModelRow({ userId: user.id, creatorId: creator.id, kind, mediaPath, fanRowId }) };
    }
    const queueId = await venice.queueVideo(still, `${scene}. Smooth natural motion, static camera, same scene and lighting throughout.`);
    return { media: await insertModelRow({ userId: user.id, creatorId: creator.id, kind, status: 'pending', queueId, fanRowId, cents }) };
  } catch (err) {
    console.error(`[ai-chat] ${kind} failed:`, err?.message);
    await refundFanRow(fanRowId, user.id, cents, `${kind}_failed`);
    throw aiError(AI_CHAT_ERRORS.GENERATION_FAILED, `That ${kind} didn’t come out -- you weren’t charged. Try a different description.`, 502);
  }
}

/**
 * Collects finished videos for one fan's thread, and fails (and refunds) any
 * that errored or ran past VIDEO_TIMEOUT_MS. Each pending row is claimed with
 * a short lease so two open tabs polling at once do not both fetch it.
 */
export async function advanceVideoJobs(userId, creatorId, { venice = defaultVenice, store = storeGenerated, now = Date.now() } = {}) {
  const { rows } = await query(
    `update ai_chat_messages set polled_at = now()
      where id in (select id from ai_chat_messages
                    where user_id = $1 and creator_id = $2 and role = 'model' and kind = 'video' and status = 'pending'
                      and (polled_at is null or polled_at < now() - interval '15 seconds')
                    order by id limit 3
                    for update skip locked)
      returning id, queue_id, fan_message_id, price_cents, created_at`,
    [String(userId), String(creatorId)],
  );
  for (const row of rows) {
    let failed = false;
    try {
      const mp4 = await venice.retrieveVideo(row.queue_id);
      if (mp4) {
        const mediaPath = await store(userId, mp4, 'video/mp4');
        await query(`update ai_chat_messages set status = 'done', media_path = $2 where id = $1 and status = 'pending'`, [row.id, mediaPath]);
        continue;
      }
      failed = now - new Date(row.created_at).getTime() > VIDEO_TIMEOUT_MS;
    } catch (err) {
      console.error('[ai-chat] video retrieve failed:', err?.message);
      failed = true;
    }
    if (failed) {
      const { rows: flipped } = await query(
        `update ai_chat_messages set status = 'failed', text = 'That video didn’t render -- your credits were refunded.'
          where id = $1 and status = 'pending' returning id`,
        [row.id],
      );
      if (flipped.length && row.fan_message_id) {
        await refundFanRow(row.fan_message_id, userId, Number(row.price_cents) || AI_CHAT_PRICES.videoCents, 'video_failed');
      }
    }
  }
}
