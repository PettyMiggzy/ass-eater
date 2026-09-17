import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/reports.json';

export async function getReports() {
  return readJsonList(MANIFEST_PATH);
}

export async function addReport(report) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const nextId = Math.max(0, ...list.map((r) => Number(r.id) || 0)) + 1;
    const entry = { id: nextId, createdAt: new Date().toISOString(), status: 'open', ...report };
    return { next: [...list, entry], result: entry };
  });
}

export async function updateReportStatus(id, status, resolvedBy) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((r) => String(r.id) === String(id));
    if (idx === -1) throw new Error('Report not found');
    const updated = [...list];
    updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
    return { next: updated, result: updated[idx] };
  });
}
