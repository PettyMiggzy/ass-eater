import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/reports.json';

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getReports() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

async function saveReports(list) {
  return put(MANIFEST_PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function addReport(report) {
  const list = await getReports();
  const nextId = Math.max(0, ...list.map((r) => Number(r.id) || 0)) + 1;
  const entry = { id: nextId, createdAt: new Date().toISOString(), status: 'open', ...report };
  await saveReports([...list, entry]);
  return entry;
}

export async function updateReportStatus(id, status, resolvedBy) {
  const list = await getReports();
  const idx = list.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) throw new Error('Report not found');
  const updated = [...list];
  updated[idx] = { ...updated[idx], status, resolvedBy, resolvedAt: new Date().toISOString() };
  await saveReports(updated);
  return updated[idx];
}
