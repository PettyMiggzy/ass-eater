// Social + compliance flows against a real Postgres: paid DMs and who may
// message whom, conversation bounds, notification coalescing and scoped
// read-marking, the NCII resolve transaction, and report target handling.
//
// Run with:
//   DATABASE_URL=postgresql://... node --import ./test-register.mjs lib/social.test.mjs
//
// Truncates everything it touches, so it refuses anything but a local
// scratch database.

const url = process.env.DATABASE_URL || '';
if (!/localhost|127\.0\.0\.1/.test(url) || !/onlyone_site|_test/.test(url)) {
  console.error('Refusing to run: point DATABASE_URL at a local scratch database.');
  process.exit(2);
}

const { query, closePool } = await import('./db.js');
const msgs = await import('./messages-store.js');
const credits = await import('./credits-store.js');
const notes = await import('./notifications-store.js');
const ncii = await import('./ncii-reports-store.js');
const reports = await import('./reports-store.js');
const wall = await import('./wall-store.js');
const alerts = await import('./alerts.js');

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};
const section = (s) => console.log('\n' + s);

async function reset() {
  await query(`truncate users, creators, conversations, credit_balances, credit_ledger, notifications,
                        ncii_reports, reports, wall_posts, listings, orders restart identity`);
  // Keep the demo roster from being seeded into these tests' way.
  await query(`insert into app_meta (key, value) values ('creators_seeded', 'true'::jsonb) on conflict do nothing`).catch(() => {});
}

async function mkUser(id, role, creatorId = null) {
  await query('insert into users (id, data) values ($1, $2)', [id, { email: `${id}-name`, role, creatorId, sessionVersion: 0 }]);
  return { id, role, creatorId, email: `${id}-name` };
}
async function mkCreator(id, fields = {}) {
  await query('insert into creators (id, data) values ($1, $2)', [id, { name: `Creator ${id}`, handle: `@${id}`, status: 'active', ...fields }]);
}
async function balance(id) {
  return credits.getBalanceCents(id);
}
async function expectCode(fn, code) {
  try { await fn(); return 'no error'; } catch (e) { return e.code === code ? true : `${e.code}: ${e.message}`; }
}

await reset();

section('who may message whom');
{
  await mkCreator('ca', { dmPriceCents: 300 });
  await mkCreator('cb');
  await mkCreator('cseed', { seed: true });
  await mkCreator('cpend', { status: 'pending' });
  await mkCreator('cban', { status: 'banned' });
  const fan = await mkUser('fan1', 'fan');
  const fan2 = await mkUser('fan2', 'fan');
  const ca = await mkUser('ua', 'creator', 'ca');
  const cb = await mkUser('ub', 'creator', 'cb');
  await mkUser('useed', 'creator', 'cseed');
  await mkUser('upend', 'creator', 'cpend');
  const banned = await mkUser('uban', 'creator', 'cban');
  await credits.creditAccount({ userId: 'fan1', cents: 1000, type: 'deposit' });

  check('fan -> fan is refused', await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'fan2', text: 'hi' }), msgs.DM_ERRORS.FAN_TO_FAN) === true);
  check('unknown recipient is refused', await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'nobody', text: 'hi' }), msgs.DM_ERRORS.RECIPIENT_NOT_FOUND) === true);
  check('creator -> fan cold message is refused',
    await expectCode(() => msgs.sendDirectMessage({ sender: ca, recipientId: 'fan2', text: 'hey' }), msgs.DM_ERRORS.NOT_ALLOWED) === true);
  check('a seed/demo creator cannot be paid a DM',
    await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'useed', text: 'hi' }), msgs.DM_ERRORS.RECIPIENT_UNAVAILABLE) === true);
  check('a pending creator cannot be paid a DM',
    await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'upend', text: 'hi' }), msgs.DM_ERRORS.RECIPIENT_UNAVAILABLE) === true);
  check('a pending creator account messaging a creator pays like a fan (no free creator<->creator)',
    await expectCode(() => msgs.sendDirectMessage({ sender: { id: 'upend', role: 'creator', creatorId: 'cpend' }, recipientId: 'ub', text: 'hi', expectedPriceCents: 99 }), credits.INSUFFICIENT_BALANCE) === true);
  check('a pending creator account cannot message a fan',
    await expectCode(() => msgs.sendDirectMessage({ sender: { id: 'upend', role: 'creator', creatorId: 'cpend' }, recipientId: 'fan2', text: 'hi' }), msgs.DM_ERRORS.NOT_ALLOWED) === true);
  check('a seed/demo creator account cannot message for free either',
    await expectCode(() => msgs.sendDirectMessage({ sender: { id: 'useed', role: 'creator', creatorId: 'cseed' }, recipientId: 'ub', text: 'hi', expectedPriceCents: 99 }), credits.INSUFFICIENT_BALANCE) === true);
  check('a pending creator account cannot reach a banned creator for free',
    await expectCode(() => msgs.sendDirectMessage({ sender: { id: 'upend', role: 'creator', creatorId: 'cpend' }, recipientId: 'uban', text: 'hi' }), msgs.DM_ERRORS.RECIPIENT_UNAVAILABLE) === true);
  check('a banned creator cannot send',
    await expectCode(() => msgs.sendDirectMessage({ sender: banned, recipientId: 'ub', text: 'hi' }), msgs.DM_ERRORS.SENDER_RESTRICTED) === true);
  check('over-long text is refused, not truncated',
    await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'x'.repeat(2001) }), msgs.DM_ERRORS.TOO_LONG) === true);
  check('nothing was charged by any refusal', (await balance('fan1')) === 1000, String(await balance('fan1')));

  const r1 = await msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'hello', clientMessageId: 'k1', expectedPriceCents: 300 });
  check('fan -> creator charges the creator price', r1.chargedCents === 300 && (await balance('fan1')) === 700, `${r1.chargedCents} ${await balance('fan1')}`);
  check('creator earns the price less 10%', (await balance('ua')) === 270, String(await balance('ua')));

  const again = await msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'hello', clientMessageId: 'k1', expectedPriceCents: 300 });
  check('a retry with the same clientMessageId is not charged twice', again.duplicate === true && (await balance('fan1')) === 700);
  const convo = await msgs.getConversationBetween('fan1', 'ua');
  check('...and not stored twice', convo.messages.length === 1, String(convo.messages.length));

  const reply = await msgs.sendDirectMessage({ sender: ca, recipientId: 'fan1', text: 'thanks!' });
  check('creator can reply for free to a fan who wrote', reply.chargedCents === 0 && (await balance('ua')) === 270);

  const cc = await msgs.sendDirectMessage({ sender: cb, recipientId: 'ua', text: 'collab?' });
  check('creator -> creator is free', cc.chargedCents === 0);

  // Floor: creator cb has no price set.
  const r2 = await msgs.sendDirectMessage({ sender: fan, recipientId: 'ub', text: 'hi b', expectedPriceCents: 99 });
  check('an unset price charges the 99-credit floor', r2.chargedCents === 99, String(r2.chargedCents));

  // Insufficient funds: nothing stored, nothing charged.
  await query(`update creators set data = data || '{"dmPriceCents": 50000}'::jsonb where id = 'ca'`);
  const before = (await msgs.getConversationBetween('fan1', 'ua')).messages.length;
  check('not enough credits is refused',
    await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'pricey', expectedPriceCents: 50000 }), credits.INSUFFICIENT_BALANCE) === true);
  const after = (await msgs.getConversationBetween('fan1', 'ua')).messages.length;
  check('...and the message was not stored', before === after, `${before} ${after}`);

  // Round-2 legal-journeys#1: the fan is charged the price they were shown, or nothing.
  await query(`update creators set data = data || '{"dmPriceCents": 300}'::jsonb where id = 'ca'`);
  await credits.creditAccount({ userId: 'fan1', cents: 1000, type: 'deposit' });
  const b0 = await balance('fan1');
  const changed = await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'shown 99', expectedPriceCents: 99 }), msgs.DM_ERRORS.PRICE_CHANGED);
  check('a raised price is refused with PRICE_CHANGED', changed === true, String(changed));
  check('a paid send with no expected price is refused', await expectCode(() => msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'no price' }), msgs.DM_ERRORS.PRICE_CHANGED) === true);
  try { await msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'x', expectedPriceCents: 1 }); } catch (e) {
    check('PRICE_CHANGED carries the current price', e.currentPriceCents === 300, String(e.currentPriceCents));
  }
  check('...and nothing was charged', (await balance('fan1')) === b0, String(await balance('fan1')));
  const confirmed = await msgs.sendDirectMessage({ sender: fan, recipientId: 'ua', text: 'ok 300', expectedPriceCents: 300 });
  check('the confirmed price is charged', confirmed.chargedCents === 300 && (await balance('fan1')) === b0 - 300);

  // Round-2 social#3: the quote uses the send's rules.
  check('quote: fan -> creator is the creator price', (await msgs.quoteDmPrice(fan, ca)).priceCents === 300);
  const pendQuote = await msgs.quoteDmPrice({ id: 'upend', role: 'creator', creatorId: 'cpend' }, cb);
  check('quote: a pending creator account pays like a fan', pendQuote.allowed && pendQuote.priceCents === 99, JSON.stringify(pendQuote));
  check('quote: creator -> creator is free', (await msgs.quoteDmPrice(ca, cb)).priceCents === 0);
  check('quote: an unavailable creator is not sendable', (await msgs.quoteDmPrice(fan, { id: 'upend', role: 'creator', creatorId: 'cpend' })).allowed === false);
  check('quote: fan -> fan is not sendable', (await msgs.quoteDmPrice(fan, fan2)).allowed === false);

  // Round-2 social#4: an approved creator cannot cold-message a creator-role
  // account that is not approved (pending, banned) -- that is a fan to them.
  check('active creator -> pending creator account is reply-only',
    await expectCode(() => msgs.sendDirectMessage({ sender: ca, recipientId: 'upend', text: 'cold' }), msgs.DM_ERRORS.NOT_ALLOWED) === true);
  check('active creator -> banned creator account is reply-only',
    await expectCode(() => msgs.sendDirectMessage({ sender: ca, recipientId: 'uban', text: 'cold' }), msgs.DM_ERRORS.NOT_ALLOWED) === true);

  // Creator may message a fan who bought from them, without a conversation.
  await query('insert into orders (data) values ($1)', [{ buyerId: 'fan2', creatorId: 'cb', kind: 'digital' }]);
  const toBuyer = await msgs.sendDirectMessage({ sender: cb, recipientId: 'fan2', text: 'thanks for buying' });
  check('creator -> fan who bought from them is allowed', toBuyer.chargedCents === 0);
}

section('concurrent paid sends');
{
  await reset();
  await mkCreator('cz', { dmPriceCents: 300 });
  await mkUser('uz', 'creator', 'cz');
  const fz = await mkUser('fz', 'fan');
  await credits.creditAccount({ userId: 'fz', cents: 1000, type: 'deposit' });
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    msgs.sendDirectMessage({ sender: fz, recipientId: 'uz', text: `m${i}`, expectedPriceCents: 300 })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const convo = await msgs.getConversationBetween('fz', 'uz');
  check('only affordable sends succeed', ok === 3, String(ok));
  check('every stored message was paid for', convo.messages.length === 3 && (await balance('fz')) === 100, `${convo.messages.length} ${await balance('fz')}`);
  check('the rest failed as insufficient balance',
    results.filter((r) => r.status === 'rejected').every((r) => r.reason.code === credits.INSUFFICIENT_BALANCE));
}

section('conversation bounds and projection');
{
  await reset();
  await mkCreator('cx');
  await mkUser('ux', 'creator', 'cx');
  await mkUser('ux2', 'creator', 'cy');
  await mkCreator('cy');
  const sender = { id: 'ux2', role: 'creator', creatorId: 'cy' };
  // Cheaper to seed a near-full row than send 500 messages.
  const id = ['ux', 'ux2'].sort().join('__');
  const seeded = Array.from({ length: msgs.MAX_STORED_MESSAGES }, (_, i) => ({ id: `m${i}`, senderId: 'ux', text: `old ${i}`, createdAt: new Date(Date.now() - 100000 + i).toISOString() }));
  await query('insert into conversations (id, data) values ($1, $2)', [id, { id, participantIds: ['ux', 'ux2'], messages: seeded, senders: ['ux'] }]);
  const res = await msgs.sendDirectMessage({ sender, recipientId: 'ux', text: 'newest' });
  check('stored history is capped', res.conversation.messages.length === msgs.MAX_STORED_MESSAGES, String(res.conversation.messages.length));
  check('the oldest message is the one dropped', res.conversation.messages[0].id === 'm1' && res.conversation.messages.at(-1).text === 'newest');

  const page = msgs.projectConversation(res.conversation, 'ux');
  check('a thread page is bounded', page.messages.length === msgs.THREAD_PAGE_SIZE && page.hasMore === true);
  check('unread count is for the viewer', page.unreadCount === 1, String(page.unreadCount));
  const older = msgs.projectConversation(res.conversation, 'ux', { before: page.messages[0].id });
  check('before-cursor pages backwards', older.messages.at(-1).id !== page.messages[0].id && older.messages.length === msgs.THREAD_PAGE_SIZE);
  // Round-2 social#5: a `before` id no longer stored returns an empty, stale page.
  const gone = msgs.projectConversation(res.conversation, 'ux', { before: 'm0' });
  check('a trimmed before-id returns an empty stale page, not the newest page again',
    gone.messages.length === 0 && gone.hasMore === false && gone.stale === true, JSON.stringify({ n: gone.messages.length, h: gone.hasMore }));
  await msgs.markConversationRead('ux', 'ux2');
  const reread = await msgs.getConversationBetween('ux', 'ux2');
  check('marking read clears unread', msgs.projectConversation(reread, 'ux').unreadCount === 0);

  // Inbox paging must not skip rows that share a timestamp (or differ only
  // below a millisecond).
  for (const other of ['p1', 'p2', 'p3', 'p4']) {
    const cid = ['ux', other].sort().join('__');
    await query('insert into conversations (id, data, updated_at) values ($1, $2, $3)',
      [cid, { id: cid, participantIds: ['ux', other], messages: [] }, other === 'p4' ? '2026-01-01T00:00:00.000400Z' : '2026-01-01T00:00:00.000100Z']);
  }
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i += 1) {
    const pageRows = await msgs.getConversationsForUser('ux', { limit: 1, before: cursor });
    if (!pageRows.length) break;
    seen.push(pageRows[0].id);
    cursor = msgs.encodeConversationCursor(pageRows[0]);
  }
  check('inbox paging visits every conversation exactly once', seen.length === 5 && new Set(seen).size === 5, JSON.stringify(seen));
  check('a garbage cursor starts from the top rather than throwing',
    (await msgs.getConversationsForUser('ux', { limit: 1, before: 'not-a-cursor' })).length === 1);
}

section('notifications: coalescing and scoped read');
{
  await reset();
  // Notifications are only recorded for an account that exists (round-15
  // legal-journeys#2).
  await query(`insert into users (id, data) values ('r1', $1) on conflict (id) do nothing`, [JSON.stringify({ email: 'r1@social.test', role: 'fan' })]);
  for (let i = 0; i < 5; i++) {
    await notes.createNotification({ userId: 'r1', type: 'message', message: 'New message from A', meta: { fromUserId: 'a' }, coalesceKey: 'fromUserId' });
  }
  await notes.createNotification({ userId: 'r1', type: 'message', message: 'New message from B', meta: { fromUserId: 'b' }, coalesceKey: 'fromUserId' });
  check('a burst from one sender is one unread row', (await notes.getUnreadCount('r1')) === 2, String(await notes.getUnreadCount('r1')));
  const shown = await notes.getNotificationsForUser('r1');
  const maxShown = Math.max(...shown.map((n) => Number(n.id)));
  const minShown = Math.min(...shown.map((n) => Number(n.id)));
  await notes.createNotification({ userId: 'r1', type: 'sale', message: 'arrived after the fetch' });
  await notes.markReadUpTo('r1', maxShown, minShown);
  check('only what was shown is marked read', (await notes.getUnreadCount('r1')) === 1, String(await notes.getUnreadCount('r1')));
  await notes.createNotification({ userId: 'r1', type: 'message', message: 'New message from A', meta: { fromUserId: 'a' }, coalesceKey: 'fromUserId' });
  check('once read, a new message from the same sender notifies again', (await notes.getUnreadCount('r1')) === 2);
  check('markReadUpTo without an id marks nothing', (await notes.markReadUpTo('r1', undefined)) === 0);
}

section('NCII resolve is one transaction');
{
  await reset();
  await mkCreator('cv');
  const r = await ncii.addNciiReport({ reporterName: 'V', reporterContact: 'v@x.co', contentLocation: 'x', consentStatement: true });
  let threw = null;
  try { await ncii.resolveNciiReport(r.id, 'removed', { creatorId: 'gone' }); } catch (e) { threw = e; }
  check('attributing a missing creator is refused', threw?.code === ncii.NCII_CREATOR_NOT_FOUND);
  const stillOpen = (await ncii.getNciiReports())[0];
  check('...and the report is still open to retry', stillOpen.status === 'open', stillOpen.status);

  const results = await Promise.allSettled([
    ncii.resolveNciiReport(r.id, 'removed', { creatorId: 'cv' }),
    ncii.resolveNciiReport(r.id, 'removed', { creatorId: 'cv' }),
  ]);
  const ok = results.filter((x) => x.status === 'fulfilled');
  check('exactly one concurrent resolve wins', ok.length === 1, JSON.stringify(results.map((x) => x.status)));
  check('the loser is told it was already resolved',
    results.some((x) => x.status === 'rejected' && x.reason.code === ncii.NCII_ALREADY_RESOLVED));
  const { rows } = await query(`select data from creators where id = 'cv'`);
  check('the ladder ran exactly once', rows[0].data.contentViolationCount === 1 && rows[0].data.status === 'suspended', JSON.stringify(rows[0].data));
  const resolved = (await ncii.getNciiReports())[0];
  check('the report records who it was attributed to', resolved.attributedCreatorId === 'cv');
  const summary = await ncii.getOpenNciiSummary();
  check('open summary counts only open reports', summary.open === 0);

  // The outer COMMIT failing AFTER the ladder ran must roll the ladder back
  // too, so the admin's retry counts it once, not twice. A deferred
  // constraint trigger fails the transaction at COMMIT time -- after both the
  // report update and the ladder UPDATE have succeeded.
  const r2 = await ncii.addNciiReport({ reporterName: 'W', reporterContact: 'w@x.co', contentLocation: 'y', consentStatement: true });
  await query(`create or replace function ncii_fail_commit() returns trigger language plpgsql as $$
    begin raise exception 'simulated commit failure'; end $$`);
  await query(`create constraint trigger ncii_fail_commit after update on creators
    deferrable initially deferred for each row execute function ncii_fail_commit()`);
  let failed = null;
  try { await ncii.resolveNciiReport(r2.id, 'removed', { creatorId: 'cv' }); } catch (e) { failed = e; } finally {
    await query('drop trigger ncii_fail_commit on creators');
  }
  const mid = (await query(`select data from creators where id = 'cv'`)).rows[0].data;
  check('a failed commit after the ladder rolls the ladder back', !!failed && mid.contentViolationCount === 1, JSON.stringify(mid));
  const stillOpen2 = (await ncii.getNciiReports()).find((x) => String(x.id) === String(r2.id));
  check('...and leaves that report open', stillOpen2.status === 'open', stillOpen2.status);
  const retried = await ncii.resolveNciiReport(r2.id, 'removed', { creatorId: 'cv' });
  check('the retry counts it exactly once (second offence = ban)',
    retried.creator.contentViolationCount === 2 && retried.creator.status === 'banned', JSON.stringify(retried.creator));
  check('the creator records which reports counted',
    JSON.stringify(retried.creator.appliedNciiReportIds) === JSON.stringify([String(r.id), String(r2.id)]), JSON.stringify(retried.creator.appliedNciiReportIds));
}

section('NCII alert payload');
{
  delete process.env.NCII_ALERT_WEBHOOK_URL;
  check('no webhook configured is reported, not thrown', (await alerts.sendNciiAlert({ id: 1 })).sent === false);
  process.env.NCII_ALERT_WEBHOOK_URL = 'https://example.invalid/hook';
  let body = null;
  const okRes = await alerts.sendNciiAlert(
    { id: 7, createdAt: '2026-09-24T10:00:00.000Z', reporterName: 'Secret Name', reporterContact: 'secret@x.co' },
    { fetchImpl: async (_u, opts) => { body = JSON.parse(opts.body); return { ok: true, status: 200 }; } },
  );
  check('alert is sent', okRes.sent === true);
  check('alert text matches the agreed format',
    body?.text === 'New TAKE IT DOWN request #7 filed 2026-09-24T10:00:00.000Z — 48h clock running. Review in /admin.', body?.text);
  check('no reporter PII in the alert', !JSON.stringify(body).includes('Secret') && !JSON.stringify(body).includes('secret@'));
  const failRes = await alerts.sendNciiAlert({ id: 8 }, { fetchImpl: async () => { throw new Error('down'); } });
  check('a failing webhook never throws', failRes.sent === false);
  delete process.env.NCII_ALERT_WEBHOOK_URL;
}

section('report targets');
{
  await reset();
  const post = await wall.addWallPost({ creatorId: 'c1', authorId: 'u1', authorName: 'Ann', text: 'reported text' });
  await reports.addReport({ targetType: 'wall_post', targetId: String(post.id), reporterId: 'u2', reason: 'spam' });
  await reports.addReport({ targetType: 'listing', targetId: { x: 1 }, reporterId: 'u2', reason: 'bad row from before validation' });
  const withTargets = await reports.attachReportTargets(await reports.getReports());
  const wallRep = withTargets.find((r) => r.targetType === 'wall_post');
  check('a wall report carries the comment text', wallRep.target.exists && wallRep.target.text === 'reported text');
  const bad = withTargets.find((r) => r.targetType === 'listing');
  check('a malformed stored target does not throw and renders as a string', typeof bad.targetId === 'string' && bad.target.exists === false);
  check('normalizeTargetId rejects objects and non-numeric strings',
    reports.normalizeTargetId({ x: 1 }) === null && reports.normalizeTargetId('abc') === null && reports.normalizeTargetId('12') === '12' && reports.normalizeTargetId(5) === '5');
  const pub = wall.toPublicWallPost(post, 'u1');
  check('the author sees their own comment as mine, with only their own id', pub.mine === true && pub.authorId === 'u1');
  const other = wall.toPublicWallPost(post, 'u9');
  check("nobody else's comment carries an author id", !('authorId' in other) && other.mine === false);
  const anon = wall.toPublicWallPost(post, null);
  check('logged-out viewers get no author id', !('authorId' in anon) && anon.mine === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
await closePool();
process.exit(fail ? 1 : 0);
