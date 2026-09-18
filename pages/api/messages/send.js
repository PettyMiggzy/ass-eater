import { getVerifiedSessionUserId } from '../../../lib/session';
import { sendMessage } from '../../../lib/messages-store';
import { detectPaymentCircumvention, PAYMENT_CIRCUMVENTION_MESSAGE } from '../../../lib/payment-circumvention-filter';
import { addViolation } from '../../../lib/violations-store';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const uid = await getVerifiedSessionUserId(req);
  if (!uid) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { toUserId, text } = req.body || {};
  if (!toUserId || !text) {
    return res.status(400).json({ error: 'Missing toUserId or text' });
  }

  const check = detectPaymentCircumvention(text);
  if (check.flagged) {
    await addViolation({ userId: uid, context: 'message', reasons: check.reasons, snippet: text });
    return res.status(400).json({ error: PAYMENT_CIRCUMVENTION_MESSAGE });
  }

  try {
    const conversation = await sendMessage(uid, toUserId, text);
    return res.status(200).json({ ok: true, conversation });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
}
