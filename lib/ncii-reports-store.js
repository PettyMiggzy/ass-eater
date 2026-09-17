import { readJsonList, updateJsonList } from './blob-json-store';

// Non-consensual intimate imagery (NCII) / deepfake takedown requests --
// the notice-and-removal process required by the federal TAKE IT DOWN Act.
// Deliberately separate from lib/reports-store.js (which requires a login
// and targets a specific wall post/listing already on the platform) --
// anyone, logged in or not, needs to be able to file one of these against
// any piece of content, and they get a 48-hour handling clock the general
// report queue doesn't have.
//
// Writes go through blob-json-store's ETag-guarded read-modify-write --
// these are the reports filed under a federal 48-hour legal deadline, so
// two filed or resolved close together must never let one silently
// overwrite/erase the other, which a plain read-then-put would allow.

const MANIFEST_PATH = 'data/ncii-reports.json';

export async function getNciiReports() {
  return readJsonList(MANIFEST_PATH);
}

export async function addNciiReport({ reporterName, reporterContact, contentLocation, description, consentStatement }) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const nextId = Math.max(0, ...list.map((r) => Number(r.id) || 0)) + 1;
    const entry = {
      id: nextId,
      reporterName: String(reporterName || '').slice(0, 200),
      reporterContact: String(reporterContact || '').slice(0, 200),
      contentLocation: String(contentLocation || '').slice(0, 500),
      description: String(description || '').slice(0, 1000),
      consentStatement: !!consentStatement,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    return { next: [...list, entry], result: entry };
  });
}

export async function updateNciiReportStatus(id, status, resolvedBy) {
  return updateJsonList(MANIFEST_PATH, (list) => {
    const idx = list.findIndex((r) => String(r.id) === String(id));
    if (idx === -1) throw new Error('Report not found');
    const updated = [...list];
    updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
    return { next: updated, result: updated[idx] };
  });
}
