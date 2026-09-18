import { query, rowToRecord, rowsToRecords, withTransaction } from './db';

function pairId(a, b) {
  return [String(a), String(b)].sort().join('__');
}

export async function getConversations() {
  const { rows } = await query('select id, data from conversations order by id');
  return rowsToRecords(rows);
}

export async function getConversationBetween(userA, userB) {
  const { rows } = await query('select id, data from conversations where id = $1', [pairId(userA, userB)]);
  return rows.length ? rowToRecord(rows[0]) : null;
}

export async function getConversationsForUser(userId) {
  const { rows } = await query(
    `select id, data from conversations
      where data->'participantIds' ? $1
      order by updated_at desc`,
    [String(userId)],
  );
  return rowsToRecords(rows);
}

/**
 * Appends a message to the pair's conversation, creating it if this is the
 * first one.
 *
 * The append happens inside the database with jsonb concatenation rather
 * than by reading the conversation, pushing onto the array in JavaScript and
 * writing the whole thing back. That read-modify-write is exactly how two
 * people messaging each other at the same moment used to lose one of the two
 * messages, silently and with a success response to both.
 */
export async function sendMessage(fromUserId, toUserId, text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('Message cannot be empty');
  if (String(fromUserId) === String(toUserId)) throw new Error('Cannot message yourself');

  const id = pairId(fromUserId, toUserId);
  const message = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: String(fromUserId),
    text: trimmed.slice(0, 2000),
    createdAt: new Date().toISOString(),
  };

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into conversations (id, data)
            values ($1, $2)
       on conflict (id) do update
              set data = jsonb_set(
                    conversations.data,
                    '{messages}',
                    coalesce(conversations.data->'messages', '[]'::jsonb) || $3::jsonb
                  ),
                  updated_at = now()
        returning id, data`,
      [
        id,
        { id, participantIds: [String(fromUserId), String(toUserId)], messages: [message] },
        JSON.stringify([message]),
      ],
    );
    return rowToRecord(rows[0]);
  });
}
