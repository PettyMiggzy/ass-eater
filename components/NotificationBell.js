import { useEffect, useRef, useState } from 'react';
import { Icons } from './Brand';

// In-app only -- no email provider exists on this stack (see MEMORY.md's
// creator-inbox-notifications history). The unread count is fetched on
// mount (and refreshed every minute while the page is open) so the badge is
// right without opening the dropdown; the full list is fetched lazily on
// open. The list holds every unread row (up to 200) plus the newest read
// ones, and exactly the ids DISPLAYED are marked read -- never a range, which
// could sweep in a row the user never saw, and never if the panel was closed
// before the list arrived (round-19 public-pages#0). "Mark all as read"
// clears everything, so a stale badge can always be cleared.
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  // Total unread at the moment the list was fetched (the badge drops as the
  // displayed rows are marked read; this keeps the whole count visible).
  const [listUnread, setListUnread] = useState(0);
  const rootRef = useRef(null);
  // Guards against a slow fetch from an earlier open/close resolving after
  // a later one and overwriting it with stale data.
  const requestId = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch('/api/notifications')
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => { if (!cancelled) setUnread(d.unreadCount || 0); })
        .catch(() => {});
    };
    refresh();
    // New DMs and wall comments land here now, so the badge has to notice
    // them without a page reload.
    const timer = setInterval(refresh, 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        // Closing supersedes any in-flight load, so a list that arrives
        // after the panel is gone is never marked read.
        requestId.current += 1;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) {
      requestId.current += 1; // see onClickOutside above
      return;
    }
    const id = ++requestId.current;
    setError(false);
    try {
      const res = await fetch('/api/notifications');
      if (!res.ok) throw new Error('bad response');
      const data = await res.json();
      if (id !== requestId.current) return; // a later open/close already superseded this
      const shown = data.notifications || [];
      setItems(shown);
      setListUnread(Math.max(0, Number(data.unreadCount) || 0));
      const shownUnreadIds = shown
        .filter((n) => !n.read)
        .map((n) => Number(n.id))
        .filter((n) => Number.isSafeInteger(n) && n > 0);
      setUnread(Math.max(0, (data.unreadCount || 0) - shownUnreadIds.length));
      if (shownUnreadIds.length > 0) {
        // Only the unread rows that were displayed (at most 200 + 30 < 500).
        const r = await fetch('/api/notifications/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: shownUnreadIds.slice(0, 500) }),
        }).catch(() => null);
        const d = r && r.ok ? await r.json().catch(() => null) : null;
        if (id === requestId.current && d && Number.isFinite(d.unreadCount)) setUnread(d.unreadCount);
      }
    } catch {
      if (id !== requestId.current) return;
      setError(true);
    }
  };

  const markAll = async () => {
    if (markingAll) return;
    setMarkingAll(true);
    try {
      const r = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      if (!r.ok) throw new Error('bad response');
      const d = await r.json();
      setUnread(Number.isFinite(d.unreadCount) ? d.unreadCount : 0);
      setListUnread(0);
      setItems((prev) => (Array.isArray(prev) ? prev.map((n) => ({ ...n, read: true })) : prev));
    } catch {
      setError(true);
    } finally {
      setMarkingAll(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        onClick={toggle}
        title="Notifications"
        className="relative w-9 h-9 rounded-full border border-white/10 flex items-center justify-center text-gray-300 hover:text-brand-pink hover:border-brand-pink/50 transition"
      >
        <Icons.bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand-pink text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl bg-brand-ink border border-white/10 shadow-xl z-50">
          <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between gap-2">
            <span className="text-xs font-bold tracking-widest text-gray-400">
              NOTIFICATIONS{listUnread > 0 ? ` · ${listUnread} UNREAD` : ''}
            </span>
            <button
              onClick={markAll}
              disabled={markingAll}
              className="text-[11px] font-semibold text-brand-pink hover:underline disabled:opacity-50"
            >
              Mark all as read
            </button>
          </div>
          {error ? (
            <p className="px-4 py-6 text-sm text-gray-500">Couldn't load notifications. Try again in a moment.</p>
          ) : items === null ? (
            <p className="px-4 py-6 text-sm text-gray-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500">Nothing yet.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {items.map((n) => (
                <div key={n.id} className="px-4 py-3">
                  <p className={`text-sm ${n.read ? 'text-gray-400' : 'text-gray-100 font-semibold'}`}>{n.message}</p>
                  <p className="text-[11px] text-gray-500 mt-1">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
