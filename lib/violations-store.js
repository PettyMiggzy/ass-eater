import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/violations.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getViolations() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function saveViolations(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

/** Logs a blocked send for admin visibility -- the message/post itself was never stored, only this record of who tried and why it was flagged. */
export async function addViolation({ userId, context, reasons, snippet }) {
  const list = await getViolations();
  const nextId = Math.max(0, ...list.map((v) => Number(v.id) || 0)) + 1;
  const entry = {
    id: nextId,
    userId,
    context, // 'message' | 'wall_post'
    reasons,
    snippet: String(snippet || '').slice(0, 200),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  await saveViolations([...list, entry]);
  return entry;
}

export async function updateViolationStatus(id, status, resolvedBy) {
  const list = await getViolations();
  const idx = list.findIndex((v) => String(v.id) === String(id));
  if (idx === -1) throw new Error('Violation not found');
  const updated = [...list];
  updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
  await saveViolations(updated);
  return updated[idx];
}

export async function countOpenViolationsForUser(userId) {
  const list = await getViolations();
  return list.filter((v) => String(v.userId) === String(userId) && v.status === 'open').length;
}
