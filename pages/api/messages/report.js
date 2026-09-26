import { getSessionUser } from '../../../lib/session';
import { userWriteRestriction } from '../../../lib/user-moderation';
import { findConversationMessage } from '../../../lib/messages-store';
import { addReport, validateReportInput, snapshotMessage, reporterView } from '../../../lib/reports-store';
import { sendReportAlert } from '../../../lib/alerts';
import { consumeAttempt } from '../../../lib/rate-limit';
import { refuseMalformedText } from '../../../lib/field-validation';

const MAX_REPORTS = 20;
const WINDOW_MS = 60 * 1000;

/**
 * POST /api/messages/report { withUserId, messageId, reason, category? }
 *   -> 200 { ok: true, report }
 *   -> 400 { error, field, maxLength? } | 404 no such message in your conversation
 *
 * Reports one direct message someone else sent the caller (threats,
 * extortion, anything suggesting a minor) to the admin REPORTS queue
 * (targetType 'message', with the conversation id). The caller must be a
 * participant -- the conversation id is derived from their own id -- and
 * cannot report their own message. category: 'minor' | 'non_consensual' |
 * 'other' (default); the first two alert the operator (no PII) and sort
 * first. An admin can remove the reported message (/api/admin/reports-resolve).
 * Blocking the sender is separate: /api/messages/block.
 */
export default async function handler(req, res) {
  // NUL / half-an-emoji anywhere in the request: 400, never a 500 from the
  // database (lib/field-validation.js refuseMalformedText).
  if (refuseMalformedText(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to report a message' });
  const restricted = userWriteRestriction(user);
  if (restricted) return res.status(403).json({ error: restricted });

  const { withUserId, messageId, reason, category } = req.body && typeof req.body === 'object' ? req.body : {};
  if ((typeof withUserId !== 'string' && typeof withUserId !== 'number') || !String(withUserId).trim() || String(withUserId).length > 100
    || typeof messageId !== 'string' || !messageId || messageId.length > 100) {
    return res.status(400).json({ error: 'Missing conversation or message id' });
  }
  const input = validateReportInput({ reason, category });
  if (input.error) return res.status(400).json(input);

  const { limited, retryAfterSeconds } = consumeAttempt(`message-report:user:${user.id}`, { limit: MAX_REPORTS, windowMs: WINDOW_MS });
  if (limited) {
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return res.status(429).json({ error: 'You are reporting too quickly. Give it a moment.' });
  }

  try {
    const found = await findConversationMessage(user.id, String(withUserId), messageId);
    if (!found || String(found.message.senderId) === String(user.id)) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const report = await addReport({
      targetType: 'message',
      targetId: messageId,
      conversationId: found.conversationId,
      reporterId: user.id,
      reason: input.reason,
      category: input.category,
      // A copy of the message as it stands now (text, sender, time): the
      // sender can delete their account, and the conversation keeps only its
      // newest 500 messages, so the reported one can be gone before anyone
      // looks.
      reportedContent: await snapshotMessage(found.message, { conversationId: found.conversationId, participantIds: found.participantIds }),
    });
    await sendReportAlert(report);
    return res.status(200).json({ ok: true, report: reporterView(report) });
  } catch (err) {
    console.error('[messages/report] unexpected error:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
