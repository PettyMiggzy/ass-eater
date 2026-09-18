import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/violations.json';

export async function getViolations() {
  return readJsonList(MANIFEST_PATH);
}

/** Logs a blocked send for admin visibility -- the message/post itself was never stored, only this record of who tried and why it was flagged. */
export async function addViolation({ userId, context, reasons, snippet }) {
  return updateJsonList(MANIFEST_PATH, (list) => {
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
    return { next: [...list, entry], result: entry };
  });
}

export async function updateViolationStatus(id, status, resolvedBy) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((v) => String(v.id) === String(id));
    if (idx === -1) throw new Error('Violation not found');
    const updated = [...list];
    updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
    return { next: updated, result: updated[idx] };
  });
}

export async function countOpenViolationsForUser(userId) {
  const list = await getViolations();
  return list.filter((v) => String(v.userId) === String(userId) && v.status === 'open').length;
}
