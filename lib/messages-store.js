import { put, head } from '@vercel/blob';

const MANIFEST_PATH = 'data/messages.json';

function pairId(a, b) {
  return [String(a), String(b)].sort().join('__');
}

async function fetchManifestUrl() {
  try {
    const info = await head(MANIFEST_PATH);
    return info.url;
  } catch {
    return null;
  }
}

export async function getConversations() {
  const url = await fetchManifestUrl();
  if (!url) return [];
  const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return [];
  return res.json();
}

export async function saveConversations(conversations) {
  return put(MANIFEST_PATH, JSON.stringify(conversations, null, 2), {
    access: 'public',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

export async function getConversationBetween(userA, userB) {
  const conversations = await getConversations();
  const id = pairId(userA, userB);
  return conversations.find((c) => c.id === id) || null;
}

export async function getConversationsForUser(userId) {
  const conversations = await getConversations();
  return conversations
    .filter((c) => c.participantIds.map(String).includes(String(userId)))
    .sort((a, b) => {
      const aLast = a.messages[a.messages.length - 1]?.createdAt || a.id;
      const bLast = b.messages[b.messages.length - 1]?.createdAt || b.id;
      return new Date(bLast) - new Date(aLast);
    });
}

export async function sendMessage(fromUserId, toUserId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Message cannot be empty');
  if (String(fromUserId) === String(toUserId)) throw new Error('Cannot message yourself');

  const conversations = await getConversations();
  const id = pairId(fromUserId, toUserId);
  let convo = conversations.find((c) => c.id === id);

  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: String(fromUserId),
    text: trimmed.slice(0, 2000),
    createdAt: new Date().toISOString(),
  };

  if (!convo) {
    convo = { id, participantIds: [String(fromUserId), String(toUserId)], messages: [message] };
    conversations.push(convo);
  } else {
    convo.messages.push(message);
  }

  await saveConversations(conversations);
  return convo;
}
