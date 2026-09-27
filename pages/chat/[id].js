import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import Link from 'next/link';
import SiteNav from '../../components/SiteNav';
import { AiModelBadge } from '../../components/public/DemoBadge';
import { getVerifiedSessionUserId } from '../../lib/session';
import { getCreatorById } from '../../lib/creators-store';
import { canSellAsHouse } from '../../lib/credits-store';
import { chatPersonaFor, AI_CHAT_PRICES } from '../../lib/ai-chat';
import { formatCredits } from '../../lib/brand';

// Chat with one of OnlyOne's AI house models (lib/ai-chat.js). Messages and
// custom photos/videos are paid in credits; everything generated here is
// private to the fan who asked for it.
export async function getServerSideProps({ req, params }) {
  const id = String(params.id || '');
  const uid = await getVerifiedSessionUserId(req);
  if (!uid) return { redirect: { destination: `/login?next=${encodeURIComponent(`/chat/${id}`)}`, permanent: false } };
  const creator = /^[0-9A-Za-z_-]{1,64}$/.test(id) ? await getCreatorById(id) : null;
  if (!creator || !chatPersonaFor(creator) || !canSellAsHouse(creator)) return { notFound: true };
  return {
    props: {
      model: { id: String(creator.id), name: creator.name || '', handle: creator.handle || '', img: creator.img || null },
      prices: AI_CHAT_PRICES,
    },
  };
}

const POLL_MS = 8000;

export default function ModelChat({ model, prices }) {
  const [messages, setMessages] = useState([]);
  const [balanceCents, setBalanceCents] = useState(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState(null); // null | 'photo' | 'video'
  const [scene, setScene] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/ai-chat/thread?creatorId=${encodeURIComponent(model.id)}`);
    if (!res.ok) return;
    const data = await res.json();
    setMessages(data.messages || []);
    setBalanceCents(data.balanceCents);
  }, [model.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while a custom video is rendering.
  const pending = messages.some((m) => m.status === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [pending, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, busy]);

  const post = async (url, body, optimistic) => {
    setBusy(true);
    setError(null);
    if (optimistic) setMessages((prev) => [...prev, optimistic]);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(res.status === 402 ? 'not_enough' : data.error || 'Something went wrong.');
        await load();
        return false;
      }
      await load();
      return true;
    } finally {
      setBusy(false);
    }
  };

  const send = async (e) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setText('');
    const ok = await post('/api/ai-chat/send', { creatorId: model.id, text: body },
      { id: `tmp-${Date.now()}`, role: 'fan', kind: 'text', text: body, status: 'done' });
    if (!ok) setText(body);
  };

  const request = async (e) => {
    e.preventDefault();
    const body = scene.trim();
    if (!body || busy || !mode) return;
    const ok = await post('/api/ai-chat/request', { creatorId: model.id, kind: mode, scene: body },
      { id: `tmp-${Date.now()}`, role: 'fan', kind: mode, text: body, status: 'done' });
    if (ok) {
      setScene('');
      setMode(null);
    }
  };

  const price = mode === 'video' ? prices.videoCents : prices.photoCents;

  return (
    <>
      <Head>
        <title>{`Chat with ${model.name} - OnlyOne`}</title>
        <meta name="robots" content="noindex" />
      </Head>
      <div className="min-h-screen text-white flex flex-col">
        <SiteNav signedIn />
        <div className="max-w-3xl w-full mx-auto px-4 pt-6 flex-1 flex flex-col">
          <header className="flex items-center gap-3 pb-4 border-b border-white/10">
            <Link href={`/creator/${model.id}`} className="shrink-0">
              {model.img
                ? <img src={model.img} alt="" className="w-12 h-12 rounded-full object-cover" />
                : <div className="w-12 h-12 rounded-full bg-white/10" />}
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="font-black text-lg flex items-center gap-2">{model.name} <AiModelBadge /></h1>
              <p className="text-xs text-gray-400">AI model: a fictional adult character, not a real person.</p>
            </div>
            <div className="text-right text-xs text-gray-400">
              <p>Balance</p>
              <p className="font-bold text-white">{balanceCents === null ? '…' : formatCredits(balanceCents)}</p>
            </div>
          </header>

          <div className="flex-1 overflow-y-auto py-4 space-y-3 min-h-[40vh]">
            {messages.length === 0 && (
              <p className="text-center text-gray-500 text-sm py-10">
                Say hi to {model.name}. Each message is {formatCredits(prices.messageCents)}.
              </p>
            )}
            {messages.map((m) => <Bubble key={m.id} m={m} name={model.name} />)}
            {busy && <p className="text-xs text-gray-500 italic">{model.name} is {mode ? 'getting ready…' : 'typing…'}</p>}
            <div ref={endRef} />
          </div>

          {error && (
            <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-200">
              {error === 'not_enough'
                ? <>Not enough credits. <Link href="/credits" className="underline font-bold">Add credits</Link></>
                : error}
            </div>
          )}

          {mode ? (
            <form onSubmit={request} className="mb-4 rounded-2xl border border-brand-pink/40 bg-white/5 p-3 space-y-2">
              <p className="text-sm font-bold">
                Custom {mode} from {model.name} · {formatCredits(price)}
                {mode === 'video' && <span className="font-normal text-gray-400"> · 5 seconds, ready in a few minutes</span>}
              </p>
              <textarea
                value={scene}
                onChange={(e) => setScene(e.target.value)}
                maxLength={400}
                rows={3}
                placeholder={mode === 'video'
                  ? 'Describe the video: what she’s wearing (or not), where, and what she’s doing…'
                  : 'Describe the photo: outfit or nude, pose, setting…'}
                className="w-full rounded-lg bg-black/40 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand-pink"
              />
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setMode(null)} className="px-4 h-9 rounded-full border border-white/15 text-sm">Cancel</button>
                <button type="submit" disabled={busy || scene.trim().length < 3}
                  className="px-5 h-9 rounded-full bg-brand-pink text-white font-bold text-sm disabled:opacity-40">
                  Pay &amp; create
                </button>
              </div>
            </form>
          ) : (
            <div className="flex gap-2 mb-2">
              <button onClick={() => setMode('photo')} disabled={busy}
                className="px-4 h-9 rounded-full border border-brand-pink/50 text-brand-pink text-sm font-bold disabled:opacity-40">
                Custom photo · {formatCredits(prices.photoCents)}
              </button>
              <button onClick={() => setMode('video')} disabled={busy}
                className="px-4 h-9 rounded-full border border-brand-pink/50 text-brand-pink text-sm font-bold disabled:opacity-40">
                Custom video · {formatCredits(prices.videoCents)}
              </button>
            </div>
          )}

          <form onSubmit={send} className="flex gap-2 pb-6">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={1000}
              placeholder={`Message ${model.name}…`}
              className="flex-1 rounded-full bg-white/5 px-4 h-11 text-sm focus:outline-none focus:ring-1 focus:ring-brand-pink"
            />
            <button type="submit" disabled={busy || !text.trim()}
              className="px-5 h-11 rounded-full bg-brand-pink text-white font-bold text-sm disabled:opacity-40">
              Send
            </button>
          </form>
        </div>
      </div>
    </>
  );
}

function Bubble({ m, name }) {
  const mine = m.role === 'fan';
  const shell = `max-w-[80%] rounded-2xl px-4 py-2 text-sm ${mine ? 'ml-auto bg-brand-pink text-white' : 'bg-white/10 text-white'}`;
  if (mine && m.kind !== 'text') {
    return <div className={shell}><span className="opacity-80">Custom {m.kind}:</span> {m.text}</div>;
  }
  if (m.kind === 'text') return <div className={shell}>{m.text}</div>;
  if (m.status === 'pending') return <div className={shell}>🎬 {name} is making your video… it’ll show up here in a few minutes.</div>;
  if (m.status === 'failed') return <div className={shell}>{m.text}</div>;
  if (!m.src) return null;
  return (
    <div className="max-w-[80%]">
      {m.kind === 'video'
        ? <video src={m.src} controls playsInline loop className="rounded-2xl w-full" />
        : <a href={m.src} target="_blank" rel="noopener noreferrer"><img src={m.src} alt={`Custom photo from ${name}`} className="rounded-2xl w-full" /></a>}
    </div>
  );
}
