/**
 * Out-of-band operator alerts.
 *
 * Nothing on this stack sends email (see MEMORY.md), so the one alert that
 * cannot wait for someone to happen to open /admin -- a new TAKE IT DOWN Act
 * takedown request, which starts a federal 48-hour clock -- goes to a
 * webhook instead: `NCII_ALERT_WEBHOOK_URL`, any endpoint that accepts a
 * Slack-style `{ "text": "..." }` JSON body (Slack, Discord's /slack
 * compatibility path, a Telegram relay, an SMS gateway).
 *
 * Rules this file keeps, and why:
 *   - The payload carries the report id and the filing time, nothing else.
 *     A takedown request holds a victim's name and contact details; those
 *     never leave the database through a third-party chat service.
 *   - It never throws and never blocks the filing. A report that fails to
 *     save because a chat webhook was down would be the worst possible
 *     trade. Failures are logged loudly instead.
 *   - It has a hard timeout. The caller awaits this (a fire-and-forget
 *     promise can be frozen the moment a serverless function responds), so a
 *     hung webhook must not hold the reporter's request open.
 */

const WEBHOOK_TIMEOUT_MS = 5000;

export function nciiAlertText(report) {
  const filedAt = report?.createdAt ? new Date(report.createdAt) : new Date();
  const iso = Number.isNaN(filedAt.getTime()) ? new Date().toISOString() : filedAt.toISOString();
  return `New TAKE IT DOWN request #${report?.id} filed ${iso} — 48h clock running. Review in /admin.`;
}

/**
 * Returns `{ sent: boolean, reason?: string }`. Never throws.
 */
export async function sendNciiAlert(report, { fetchImpl = globalThis.fetch } = {}) {
  const url = process.env.NCII_ALERT_WEBHOOK_URL;
  if (!url) {
    // Not an error state worth an exception, but not one worth being quiet
    // about either: without a webhook the only way to learn of a filing is
    // opening the admin panel.
    console.warn(`[alerts] NCII report #${report?.id} filed but NCII_ALERT_WEBHOOK_URL is not set -- nobody was alerted.`);
    return { sent: false, reason: 'not_configured' };
  }

  let timer;
  try {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: nciiAlertText(report) }),
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      console.error(`[alerts] NCII alert for report #${report?.id} FAILED: webhook answered ${res?.status}. Check /admin now.`);
      return { sent: false, reason: `http_${res?.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error(`[alerts] NCII alert for report #${report?.id} FAILED: ${err?.name || 'Error'}. Check /admin now.`);
    return { sent: false, reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}
