import { readJsonList, updateJsonList } from './blob-json-store';

const MANIFEST_PATH = 'data/messages.json';

function pairId(a, b) {
  return [String(a), String(b)].sort().join('__');
}

export async function getConversations() {
  return readJsonList(MANIFEST_PATH);
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

  return updateJsonList(MANIFEST_PATH, (conversations) => {
    const id = pairId(fromUserId, toUserId);
    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      senderId: String(fromUserId),
      text: trimmed.slice(0, 2000),
      createdAt: new Date().toISOString(),
    };

    const idx = conversations.findIndex((c) => c.id === id);
    let convo;
    let next;
    if (idx === -1) {
      convo = { id, participantIds: [String(fromUserId), String(toUserId)], messages: [message] };
      next = [...conversations, convo];
    } else {
      convo = { ...conversations[idx], messages: [...conversations[idx].messages, message] };
      next = [...conversations];
      next[idx] = convo;
    }
    return { next, result: convo };
  });
}
