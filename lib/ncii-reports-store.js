import { put, head } from '@vercel/blob';

// Non-consensual intimate imagery (NCII) / deepfake takedown requests --
// the notice-and-removal process required by the federal TAKE IT DOWN Act.
// Deliberately separate from lib/reports-store.js (which requires a login
// and targets a specific wall post/listing already on the platform) --
// anyone, logged in or not, needs to be able to file one of these against
// any piece of content, and they get a 48-hour handling clock the general
// report queue doesn't have.

const MANIFEST_PATH = 'data/ncii-reports.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getNciiReports() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function saveNciiReports(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function addNciiReport({ reporterName, reporterContact, contentLocation, description, consentStatement }) {
  const list = await getNciiReports();
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
  await saveNciiReports([...list, entry]);
  return entry;
}

export async function updateNciiReportStatus(id, status, resolvedBy) {
  const list = await getNciiReports();
  const idx = list.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) throw new Error('Report not found');
  const updated = [...list];
  updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
  await saveNciiReports(updated);
  return updated[idx];
}
