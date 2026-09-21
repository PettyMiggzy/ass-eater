import { useEffect, useRef, useState } from 'react';
import { Icons } from './Brand';

// In-app only -- no email provider exists on this stack (see MEMORY.md's
// creator-inbox-notifications history). The unread count is fetched once on
// mount so the badge is right without opening the dropdown; the full list is
// fetched lazily on open, and opening marks everything read (there's no
// per-notification action to take, just acknowledging the list).
export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [unread, setUnread] = useState(0);
  const rootRef = useRef(null);

  useEffect(() => {
    fetch('/api/notifications')
      .then((r) => r.json())
      .then((d) => setUnread(d.unreadCount || 0))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [open]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) {
      const res = await fetch('/api/notifications');
      const data = await res.json();
      setItems(data.notifications || []);
      setUnread(0);
      fetch('/api/notifications/read', { method: 'POST' }).catch(() => {});
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
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-xl bg-brand-ink border border-white/10 shadow-xl z-50">
          <div className="px-4 py-3 border-b border-white/10 text-xs font-bold tracking-widest text-gray-400">
            NOTIFICATIONS
          </div>
          {items === null ? (
            <p className="px-4 py-6 text-sm text-gray-500">Loading…</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500">Nothing yet.</p>
          ) : (
            <div className="divide-y divide-white/5">
              {items.map((n) => (
                <div key={n.id} className="px-4 py-3">
                  <p className="text-sm text-gray-200">{n.message}</p>
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
