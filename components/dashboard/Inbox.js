import { useEffect, useRef, useState } from 'react';
import { formatCredits } from '../../lib/brand';
import { getJson, postJson } from './media-upload';
import { responseErrorMessage } from './helpers';

// Mirrors MAX_MESSAGE_LENGTH in lib/messages-store.js (not imported: that
// module pulls in the Postgres driver, which must never reach a client
// bundle). The server enforces the limit either way; this just stops the
// box accepting a message the server will refuse.
const MAX_MESSAGE_LENGTH = 2000;
const PAGE_SIZE = 20;
const POLL_MS = 60 * 1000;

function newClientMessageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One thread's messages, oldest first, with no id twice. `older` is a page
 * loaded above what is on screen, `newer` the latest page (after a send or a
 * reload); anything already shown keeps its place. Deduping by id matters:
 * a message can arrive in two overlapping pages, and a duplicate key both
 * doubles the bubble and confuses React's reconciliation.
 */
function mergeMessages(older, current, newer) {
  const seen = new Set();
  const out = [];
  for (const m of [...(older || []), ...(current || []), ...(newer || [])]) {
    if (!m || m.id == null || seen.has(String(m.id))) continue;
    seen.add(String(m.id));
    out.push(m);
  }
  return out;
}

/** Newer page first; conversations already loaded further down keep their place. */
function mergeConversations(firstPage, current) {
  const ids = new Set(firstPage.map((c) => c.id));
  return [...firstPage, ...current.filter((c) => !ids.has(c.id))];
}

/**
 * The dashboard inbox, on the paginated messaging API:
 *   GET /api/messages/conversations?limit&before=<opaque nextBefore>
 *   GET /api/messages/with/<userId>?before=<messageId>  (marks the thread read)
 *   POST /api/messages/send { toUserId, text, clientMessageId, expectedPriceCents }
 *
 * A clientMessageId is minted once per message and reused if the same message
 * is retried after a failure, so a retry after a dropped response can never
 * send (or charge for) the message twice. It is replaced once the message is
 * delivered or the text is edited.
 *
 * expectedPriceCents is the price the thread endpoint quoted (dmPriceCents).
 * A paid send without it -- or with a price the creator has since changed --
 * is refused with 409 dm_price_changed and nothing is charged; the new price
 * is then shown and the next Send is the confirmation.
 */
export default function Inbox({ currentUserId, isCreator }) {
  const [conversations, setConversations] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  // { other, conversationId, messages, hasMore, dmPriceCents, canSend, cannotSendReason }
  const [open, setOpen] = useState(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [sendNote, setSendNote] = useState('');
  const pendingIdRef = useRef(null);
  const threadRequest = useRef(0);

  const loadFirstPage = async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    try {
      const { res, data } = await getJson(`/api/messages/conversations?limit=${PAGE_SIZE}`);
      if (!res.ok) {
        if (!quiet) setLoadError(responseErrorMessage(res.status, data, 'Could not load your messages.'));
        return;
      }
      setLoadError('');
      const page = Array.isArray(data?.conversations) ? data.conversations : [];
      setConversations((current) => (quiet ? mergeConversations(page, current) : page));
      if (!quiet) setNextBefore(typeof data?.nextBefore === 'string' ? data.nextBefore : null);
    } catch {
      if (!quiet) setLoadError('Could not load your messages. Check your connection.');
    } finally {
      if (!quiet) setLoading(false);
    }
  };

  useEffect(() => {
    loadFirstPage();
    // New messages also bump the NotificationBell; this keeps the list itself
    // current while the dashboard stays open.
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') loadFirstPage({ quiet: true });
    }, POLL_MS);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadMore = async () => {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      // The cursor is opaque: passed back exactly as received.
      const { res, data } = await getJson(`/api/messages/conversations?limit=${PAGE_SIZE}&before=${encodeURIComponent(nextBefore)}`);
      if (!res.ok) {
        setLoadError(responseErrorMessage(res.status, data, 'Could not load older conversations.'));
        return;
      }
      const page = Array.isArray(data?.conversations) ? data.conversations : [];
      setConversations((current) => {
        const ids = new Set(current.map((c) => c.id));
        return [...current, ...page.filter((c) => !ids.has(c.id))];
      });
      setNextBefore(typeof data?.nextBefore === 'string' ? data.nextBefore : null);
    } catch {
      setLoadError('Could not load older conversations. Check your connection.');
    } finally {
      setLoadingMore(false);
    }
  };

  const openThread = async (conversation, { before = null } = {}) => {
    const other = conversation.other;
    if (!other?.userId) return;
    const id = ++threadRequest.current;
    setThreadLoading(true);
    if (!before) {
      setSendError('');
      setSendNote('');
      setText('');
      pendingIdRef.current = null;
    }
    try {
      const qs = before ? `?before=${encodeURIComponent(before)}` : '';
      const { res, data } = await getJson(`/api/messages/with/${encodeURIComponent(other.userId)}${qs}`);
      if (threadRequest.current !== id) return;
      if (!res.ok) {
        setSendError(responseErrorMessage(res.status, data, 'Could not open that conversation.'));
        return;
      }
      // The `before` message aged out of storage, so there is no "older than
      // it" any more: reload from the newest page and merge, rather than
      // prepending an empty page and leaving a gap.
      if (before && data?.conversation?.stale) {
        const again = await getJson(`/api/messages/with/${encodeURIComponent(other.userId)}`);
        if (threadRequest.current !== id) return;
        if (!again.res.ok) {
          setSendError(responseErrorMessage(again.res.status, again.data, 'Could not load earlier messages.'));
          return;
        }
        const latest = Array.isArray(again.data?.conversation?.messages) ? again.data.conversation.messages : [];
        setOpen((prev) => (prev ? { ...prev, messages: mergeMessages(null, prev.messages, latest), hasMore: !!again.data?.conversation?.hasMore } : prev));
        return;
      }
      const page = Array.isArray(data?.conversation?.messages) ? data.conversation.messages : [];
      setOpen((prev) => ({
        other,
        conversationId: conversation.id,
        messages: before && prev ? mergeMessages(page, prev.messages, null) : mergeMessages(null, page, null),
        hasMore: !!data?.conversation?.hasMore,
        dmPriceCents: Number.isInteger(data?.dmPriceCents) ? data.dmPriceCents : 0,
        canSend: data?.canSend !== false,
        cannotSendReason: typeof data?.cannotSendReason === 'string' ? data.cannotSendReason : null,
      }));
      if (!before) {
        // Opening the thread marked it read server-side.
        setConversations((list) => list.map((c) => (c.id === conversation.id ? { ...c, unreadCount: 0 } : c)));
      }
    } catch {
      if (threadRequest.current === id) setSendError('Could not open that conversation. Check your connection.');
    } finally {
      if (threadRequest.current === id) setThreadLoading(false);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || !open || sending) return;
    if (body.length > MAX_MESSAGE_LENGTH) {
      setSendError(`That message is too long (${MAX_MESSAGE_LENGTH} characters maximum).`);
      return;
    }
    if (!pendingIdRef.current) pendingIdRef.current = newClientMessageId();
    setSending(true);
    setSendError('');
    setSendNote('');
    try {
      const { res, data } = await postJson('/api/messages/send', {
        toUserId: open.other.userId,
        text: body,
        clientMessageId: pendingIdRef.current,
        // The price this person was shown. A paid send is refused (409, nothing
        // charged) if it is missing or the creator's price has changed.
        expectedPriceCents: open.dmPriceCents,
      });
      if (res.status === 409 && data?.code === 'dm_price_changed' && Number.isInteger(data?.currentPriceCents)) {
        // Nothing was charged. Show the new price; pressing Send again is the
        // confirmation (it now carries the new expectedPriceCents).
        const next = data.currentPriceCents;
        setOpen((prev) => (prev ? { ...prev, dmPriceCents: next } : prev));
        setSendError(
          next > 0
            ? `The price to message ${open.other?.name || 'this creator'} is now ${formatCredits(next)}. Nothing was charged — press Send again to send at the new price.`
            : 'This message is now free to send. Nothing was charged — press Send again.',
        );
        return;
      }
      if (!res.ok) {
        // 402 insufficient_balance, 403 (not allowed / restricted / frozen /
        // pending creator messaging a fan), 409 recipient unavailable: the
        // server's own message says which. Keep the same clientMessageId so a
        // retry of this exact message stays idempotent.
        setSendError(responseErrorMessage(res.status, data, 'Failed to send.'));
        if (res.status === 402) setSendNote('insufficient');
        return;
      }
      pendingIdRef.current = null;
      setText('');
      // Merged, not replaced: the send answers with the LATEST page, and
      // replacing dropped every earlier message the user had loaded.
      const page = Array.isArray(data?.conversation?.messages) ? data.conversation.messages : null;
      if (page) setOpen((prev) => (prev ? { ...prev, messages: mergeMessages(null, prev.messages, page) } : prev));
      if (Number.isInteger(data?.chargedCents) && data.chargedCents > 0 && !data.duplicate) {
        setSendNote(`Sent — ${formatCredits(data.chargedCents)} charged.`);
      }
      loadFirstPage({ quiet: true });
    } catch {
      setSendError('Could not reach the server. Your message may not have sent — press Send again to retry safely.');
    } finally {
      setSending(false);
    }
  };

  if (loading) return null;
  // A fan with no conversations has nothing to reply to here -- they start one
  // from a creator's profile. A creator always sees the panel, so they know
  // where fan messages will land.
  if (!conversations.length && !loadError && !isCreator) return null;

  return (
    <div className="premium-card p-6 mb-6">
      <h3 className="font-bold text-brand-gold mb-4">Messages</h3>
      {loadError && <p className="text-xs text-red-400 mb-3">{loadError}</p>}
      {!conversations.length ? (
        <p className="text-sm text-gray-500">
          No messages yet. Once your profile is live, fans pay to message you (you set the price below) and your replies are free.
        </p>
      ) : (
        <div className="grid sm:grid-cols-3 gap-4">
          <div className="space-y-2 sm:border-r border-brand-purple/20 sm:pr-4 max-h-80 overflow-y-auto">
            {conversations.map((c) => (
              <button
                key={c.id}
                onClick={() => openThread(c)}
                className={`w-full flex items-center gap-2 p-2 rounded-md text-left transition ${
                  open?.conversationId === c.id ? 'bg-brand-purple/20' : 'hover:bg-white/5'
                }`}
              >
                {c.other?.img ? (
                  <img src={c.other.img} alt="" className="w-8 h-8 rounded-full object-cover object-top" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-brand-purple/30" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">{c.other?.name || 'Unknown'}</p>
                  <p className="text-xs text-gray-500 truncate">{c.lastMessage?.text || ''}</p>
                </div>
                {c.unreadCount > 0 && (
                  <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-pink text-white text-[10px] font-bold flex items-center justify-center">
                    {c.unreadCount}
                  </span>
                )}
              </button>
            ))}
            {nextBefore && (
              <button onClick={loadMore} disabled={loadingMore} className="w-full text-xs text-brand-pink hover:underline py-2 disabled:opacity-50">
                {loadingMore ? 'Loading…' : 'Load older conversations'}
              </button>
            )}
          </div>

          <div className="sm:col-span-2">
            {!open ? (
              <p className="text-gray-500 text-sm">{threadLoading ? 'Loading…' : 'Select a conversation.'}</p>
            ) : (
              <div className="flex flex-col h-80">
                <div className="flex-1 overflow-y-auto space-y-2 mb-3 pr-1">
                  {open.hasMore && (
                    <button
                      onClick={() => openThread({ id: open.conversationId, other: open.other }, { before: open.messages[0]?.id })}
                      disabled={threadLoading}
                      className="block mx-auto text-xs text-brand-pink hover:underline disabled:opacity-50"
                    >
                      {threadLoading ? 'Loading…' : 'Load earlier messages'}
                    </button>
                  )}
                  {open.messages.map((m) => (
                    <div
                      key={m.id}
                      className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                        String(m.senderId) === String(currentUserId)
                          ? 'bg-brand-gold text-black ml-auto'
                          : 'bg-black/40 text-gray-200 mr-auto'
                      }`}
                    >
                      {m.text}
                    </div>
                  ))}
                </div>
                {open.canSend === false && (
                  <p className="text-xs text-gray-400 mb-2">
                    {open.cannotSendReason || "You can't send messages in this conversation right now."}
                  </p>
                )}
                {open.dmPriceCents > 0 && (
                  <p className="text-xs text-gray-400 mb-2">
                    Each message to {open.other?.name || 'this creator'} costs {formatCredits(open.dmPriceCents)}, paid from your credits.
                  </p>
                )}
                {sendError && (
                  <p className="text-xs text-red-400 mb-2">
                    {sendError}
                    {sendNote === 'insufficient' && (
                      <> <a href="/credits" className="underline text-brand-pink">Buy credits</a></>
                    )}
                  </p>
                )}
                {sendNote && sendNote !== 'insufficient' && <p className="text-xs text-gray-400 mb-2">{sendNote}</p>}
                <form onSubmit={send} className="flex gap-2 items-end">
                  <textarea
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      pendingIdRef.current = null; // an edited message is a new message
                    }}
                    maxLength={MAX_MESSAGE_LENGTH}
                    rows={2}
                    placeholder="Reply..."
                    className="flex-1 px-3 py-2 rounded-md bg-black/40 border border-brand-purple/30 text-white text-sm resize-none"
                  />
                  <button type="submit" disabled={sending || !text.trim() || open.canSend === false} className="premium-button py-2 px-4 text-sm disabled:opacity-50">
                    {sending ? 'Sending…' : open.dmPriceCents > 0 ? `Send · $${(open.dmPriceCents / 100).toFixed(2)}` : 'Send'}
                  </button>
                </form>
                {text.length > MAX_MESSAGE_LENGTH - 200 && (
                  <p className="text-[11px] text-gray-500 mt-1 text-right">{text.length}/{MAX_MESSAGE_LENGTH}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
