import { useEffect, useRef, useState } from 'react';
import { formatCredits } from '../../lib/brand';
import { getJson, postJson } from './media-upload';
import { responseErrorMessage } from './helpers';
import ReportModal, { postReport } from '../public/ReportModal';

// The other side's avatar, falling back to the plain placeholder circle when
// there is none OR it fails to load: /api/media serves a creator's avatar to
// others only while that creator is publicly visible, so a suspended, banned
// or pending counterpart's img 404s and would otherwise render as a broken
// image. `failed` is reset when the src changes.
function ThreadAvatar({ src }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (!src || failed) return <div className="w-8 h-8 rounded-full bg-brand-purple/30 shrink-0" />;
  return <img src={src} alt="" onError={() => setFailed(true)} className="w-8 h-8 rounded-full object-cover object-top shrink-0" />;
}

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
/**
 * The thread's `other` from GET /api/messages/with/<userId> (same naming as
 * the conversation list: creator name, screened username, or a stable
 * 'Fan #XXXXXX' label -- never an email), falling back to what the list row
 * said. userId always stays the one the thread was opened for.
 */
function mergeOther(fallback, fromThread) {
  if (!fromThread || typeof fromThread !== 'object') return fallback;
  const pick = (k) => (typeof fromThread[k] === 'string' && fromThread[k] ? fromThread[k] : fallback?.[k] ?? null);
  return {
    ...fallback,
    name: pick('name'),
    handle: pick('handle'),
    img: pick('img'),
    isCreator: typeof fromThread.isCreator === 'boolean' ? fromThread.isCreator : fallback?.isCreator,
  };
}

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
  // Per-conversation block and per-message report (lib/messages-store.js
  // setConversationBlocked; /api/messages/report). A creator drowning in an
  // abusive fan's messages, or a fan being harassed, needs both.
  const [blockBusy, setBlockBusy] = useState(false);
  const [reportingMessage, setReportingMessage] = useState(null);
  // The thread on screen right now. The poll's interval closure and an
  // in-flight send() both outlive the render they were created in, so they
  // read this rather than their own stale copy of `open`.
  const openRef = useRef(null);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

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

  /**
   * Re-fetches the newest page of the thread that is open, so a reply that
   * arrives while it is on screen actually shows up (and the creator's price
   * and canSend stay current). Merged onto what is loaded; the draft, send
   * error and pending clientMessageId are left alone. A thread switch or a
   * load of older messages while this is in flight wins: the result is
   * dropped unless the same thread is still open and no other thread
   * request started meanwhile.
   */
  const refreshOpenThread = async () => {
    const current = openRef.current;
    if (!current?.other?.userId) return;
    const target = current.conversationId;
    const requestAtStart = threadRequest.current;
    try {
      const { res, data } = await getJson(`/api/messages/with/${encodeURIComponent(current.other.userId)}`);
      if (!res.ok) return;
      if (threadRequest.current !== requestAtStart || openRef.current?.conversationId !== target) return;
      const latest = Array.isArray(data?.conversation?.messages) ? data.conversation.messages : [];
      setOpen((prev) => {
        if (!prev || prev.conversationId !== target) return prev;
        const have = new Set(prev.messages.map((m) => String(m.id)));
        // More arrived than one page holds: merging would leave a silent gap
        // between what was loaded and this page, so show the newest page and
        // let "Load earlier messages" walk back from it.
        const gap = latest.length > 0 && prev.messages.length > 0 && !latest.some((m) => have.has(String(m.id))) && !!data?.conversation?.hasMore;
        return {
          ...prev,
          other: mergeOther(prev.other, data?.other),
          messages: gap ? mergeMessages(null, latest, null) : mergeMessages(null, prev.messages, latest),
          hasMore: gap ? true : prev.hasMore,
          dmPriceCents: Number.isInteger(data?.dmPriceCents) ? data.dmPriceCents : prev.dmPriceCents,
          canSend: data?.canSend !== false,
          cannotSendReason: typeof data?.cannotSendReason === 'string' ? data.cannotSendReason : null,
          blockedByMe: !!data?.conversation?.blockedByMe,
          blockedByThem: !!data?.conversation?.blockedByThem,
        };
      });
      // The GET just marked this thread read server-side.
      setConversations((list) => list.map((c) => (c.id === target ? { ...c, unreadCount: 0 } : c)));
    } catch {
      // Quiet: the next poll tries again.
    }
  };

  useEffect(() => {
    loadFirstPage();
    // New messages also bump the NotificationBell; this keeps the list itself
    // -- and the thread that is open -- current while the dashboard stays open.
    const timer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      // The thread first: its GET marks it read, so the list reloaded after it
      // does not badge the conversation being read as unread.
      await refreshOpenThread();
      loadFirstPage({ quiet: true });
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
      // it" any more. Show the newest page on its own -- replacing, not
      // merging: keeping the aged-out messages on top would make the next
      // "Load earlier messages" send the same aged-out id as `before` again,
      // forever. hasMore then walks back from a message that still exists.
      if (before && data?.conversation?.stale) {
        const again = await getJson(`/api/messages/with/${encodeURIComponent(other.userId)}`);
        if (threadRequest.current !== id) return;
        if (!again.res.ok) {
          setSendError(responseErrorMessage(again.res.status, again.data, 'Could not load earlier messages.'));
          return;
        }
        const latest = Array.isArray(again.data?.conversation?.messages) ? again.data.conversation.messages : [];
        setOpen((prev) => (prev && prev.conversationId === conversation.id
          ? { ...prev, messages: mergeMessages(null, latest, null), hasMore: !!again.data?.conversation?.hasMore }
          : prev));
        return;
      }
      const page = Array.isArray(data?.conversation?.messages) ? data.conversation.messages : [];
      setOpen((prev) => ({
        other: mergeOther(other, data?.other),
        conversationId: conversation.id,
        messages: before && prev ? mergeMessages(page, prev.messages, null) : mergeMessages(null, page, null),
        hasMore: !!data?.conversation?.hasMore,
        dmPriceCents: Number.isInteger(data?.dmPriceCents) ? data.dmPriceCents : 0,
        canSend: data?.canSend !== false,
        cannotSendReason: typeof data?.cannotSendReason === 'string' ? data.cannotSendReason : null,
        blockedByMe: !!data?.conversation?.blockedByMe,
        blockedByThem: !!data?.conversation?.blockedByThem,
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
    // The thread this message belongs to. The user can switch threads while
    // the request is in flight; everything below only touches the pane,
    // draft and errors if this thread is still the one on screen.
    const target = open.conversationId;
    const targetName = open.other?.name;
    const stillOpen = () => openRef.current?.conversationId === target;
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
      if (!stillOpen()) {
        // Sent (or refused) for a thread that is no longer on screen. Its
        // price, page and errors belong to that thread, not this one; the
        // list reload shows where it landed, and reopening it shows the rest.
        // The draft and clientMessageId now belong to the thread on screen,
        // which openThread() already reset.
        loadFirstPage({ quiet: true });
        return;
      }
      if (res.status === 409 && data?.code === 'dm_price_changed' && Number.isInteger(data?.currentPriceCents)) {
        // Nothing was charged. Show the new price; pressing Send again is the
        // confirmation (it now carries the new expectedPriceCents).
        const next = data.currentPriceCents;
        setOpen((prev) => (prev && prev.conversationId === target ? { ...prev, dmPriceCents: next } : prev));
        setSendError(
          next > 0
            ? `The price to message ${targetName || 'this creator'} is now ${formatCredits(next)}. Nothing was charged — press Send again to send at the new price.`
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
      if (page) setOpen((prev) => (prev && prev.conversationId === target ? { ...prev, messages: mergeMessages(null, prev.messages, page) } : prev));
      if (Number.isInteger(data?.chargedCents) && data.chargedCents > 0 && !data.duplicate) {
        setSendNote(`Sent — ${formatCredits(data.chargedCents)} charged.`);
      }
      loadFirstPage({ quiet: true });
    } catch {
      if (stillOpen()) setSendError('Could not reach the server. Your message may not have sent — press Send again to retry safely.');
    } finally {
      setSending(false);
    }
  };

  const toggleBlock = async () => {
    const current = openRef.current;
    if (!current?.other?.userId || blockBusy) return;
    const target = current.conversationId;
    const next = !current.blockedByMe;
    const name = current.other.name || 'this person';
    if (next && typeof window !== 'undefined' && !window.confirm(`Block ${name}? They won't be able to message you until you unblock them.`)) return;
    setBlockBusy(true);
    setSendError('');
    try {
      const { res, data } = await postJson('/api/messages/block', { userId: current.other.userId, blocked: next });
      if (!res.ok) {
        if (openRef.current?.conversationId === target) setSendError(responseErrorMessage(res.status, data, 'Could not update the block.'));
        return;
      }
      setOpen((prev) => (prev && prev.conversationId === target
        ? { ...prev, blockedByMe: !!data?.conversation?.blockedByMe, blockedByThem: !!data?.conversation?.blockedByThem }
        : prev));
      // The list row too: its "Blocked" label (a block-only row has no last
      // message to show instead) must not outlive the block.
      setConversations((list) => list.map((c) => (c.id === target
        ? { ...c, blockedByMe: !!data?.conversation?.blockedByMe, blockedByThem: !!data?.conversation?.blockedByThem }
        : c)));
      if (openRef.current?.conversationId === target) setSendNote(next ? `${name} is blocked.` : `${name} is unblocked.`);
      // canSend, cannotSendReason and the price were quoted while the old
      // block state applied (a blocked thread quotes { allowed: false,
      // priceCents: 0 }). Re-read them from the server now rather than leave
      // Send disabled with "You blocked this account" until the next poll.
      if (openRef.current?.conversationId === target) await refreshOpenThread();
    } catch {
      if (openRef.current?.conversationId === target) setSendError('Could not reach the server. Try again.');
    } finally {
      setBlockBusy(false);
    }
  };

  const submitMessageReport = async ({ reason, category }) => {
    const { other, message } = reportingMessage;
    await postReport('/api/messages/report', { withUserId: other.userId, messageId: String(message.id), reason, category });
    setReportingMessage(null);
    setSendNote('Thanks — an admin will review that message. You can also block this person.');
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
                <ThreadAvatar src={c.other?.img} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold text-white truncate">{c.other?.name || 'Unknown'}</p>
                  {/* A block-only row (a wall commenter blocked from the
                      wall, who never messaged) has no messages; it is
                      listed only to whoever made the block, so they can
                      lift it here. */}
                  <p className="text-xs text-gray-500 truncate">
                    {c.lastMessage?.text || (c.blockedByMe ? 'Blocked' : '')}
                  </p>
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
                {reportingMessage && (
                  <ReportModal
                    title="Report this message"
                    subject="this message"
                    onSubmit={submitMessageReport}
                    onClose={() => setReportingMessage(null)}
                    takedownContent={`Direct message ${reportingMessage.message.id} from user ${reportingMessage.other.userId} to user ${currentUserId}`}
                  />
                )}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <p className="text-sm font-bold text-white truncate">{open.other?.name || 'Conversation'}</p>
                  <button
                    type="button"
                    onClick={toggleBlock}
                    disabled={blockBusy}
                    className="shrink-0 text-[11px] px-2.5 py-1 rounded-full border border-brand-purple/30 text-gray-400 hover:text-white transition disabled:opacity-50"
                  >
                    {open.blockedByMe ? 'Unblock' : 'Block'}
                  </button>
                </div>
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
                  {!open.messages.length && !threadLoading && (
                    <p className="text-xs text-gray-500">No messages in this conversation yet.</p>
                  )}
                  {open.messages.map((m) => {
                    const mine = String(m.senderId) === String(currentUserId);
                    return (
                      <div key={m.id} className={`flex items-end gap-1 ${mine ? 'justify-end' : 'justify-start'}`}>
                        <div
                          className={`max-w-[80%] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words ${
                            mine ? 'bg-brand-gold text-black' : 'bg-black/40 text-gray-200'
                          }`}
                        >
                          {m.text}
                        </div>
                        {!mine && m.id != null && (
                          <button
                            type="button"
                            onClick={() => setReportingMessage({ other: open.other, message: m })}
                            title="Report this message"
                            aria-label="Report this message"
                            className="shrink-0 text-[10px] px-1 text-gray-600 hover:text-brand-pink transition"
                          >
                            Report
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                {open.blockedByMe ? (
                  <p className="text-xs text-gray-400 mb-2">You blocked {open.other?.name || 'this person'}. Unblock them to message each other again.</p>
                ) : open.canSend === false ? (
                  <p className="text-xs text-gray-400 mb-2">
                    {open.cannotSendReason || "You can't send messages in this conversation right now."}
                  </p>
                ) : null}
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
                  <button type="submit" disabled={sending || !text.trim() || open.canSend === false || open.blockedByMe || open.blockedByThem} className="premium-button py-2 px-4 text-sm disabled:opacity-50">
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
