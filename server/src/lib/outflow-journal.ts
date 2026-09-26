import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable record of what the treasury key has SIGNED, kept where the
 * database cannot reach it.
 *
 * Every automatic treasury outflow (a creator payout, an automatic token-burn
 * swap, a treasury-hedge sale, a deposit sweep's gas top-up) is driven by
 * rows in Postgres (or, for the sweep, jobs in a localhost Redis), and Postgres is
 * writable by every process that loads .env -- including the media workers,
 * which run ffmpeg/libvips over untrusted uploads. The outflow caps in
 * workers/payout-worker.ts, workers/token-burn.ts and
 * workers/treasury-hedge.ts therefore cannot be computed from the database
 * alone (workers/sweep-gas.ts for the gas top-ups): a DB writer can null out `signedAt`, mark its payouts REFUNDED, or
 * delete rows, and make the recorded 24h total as small as it likes.
 *
 * They used to fall back to an in-memory list, which every restart of the
 * workers emptied -- and restarts are routine (every redeploy) or forceable
 * (a crash loop). This journal survives restarts: an append-only JSON-lines
 * file in the workers unit's own systemd StateDirectory
 * (deploy/onlyone-workers.service: /var/lib/onlyone-workers, mode 0700, owned
 * by the key-holding user), which no other user on the box can write. Each
 * outflow is appended and fsync'd BEFORE its transaction is broadcast, so an
 * outflow can never happen without being counted; one recorded and then not
 * broadcast (a crash, a signing error, a reverted swap) is over-counted,
 * which is the safe direction.
 *
 * Fail-closed: if the journal is not configured (no STATE_DIRECTORY /
 * OUTFLOW_JOURNAL_DIR outside the test runner) or cannot be read or written,
 * every use throws OutflowJournalUnavailable and callers refuse to sign.
 */

export type OutflowKind = 'payout' | 'burn' | 'hedge' | 'hedge_tokens' | 'gas';
const KINDS: readonly OutflowKind[] = ['payout', 'burn', 'hedge', 'hedge_tokens', 'gas'];

// `cents` is the amount in the kind's own unit: US cents for payout, burn and
// hedge (the stablecoin side), and WHOLE $ONLYONE tokens (rounded up) for
// hedge_tokens -- what a hedge sale takes out of the treasury, capped
// separately because its dollar value comes from the very pool it sells into.
// For 'gas' (a deposit sweep's ETH top-up, workers/sweep-gas.ts) it is GWEI.
export type OutflowEntry = { at: number; kind: OutflowKind; cents: number; ref: string };

export class OutflowJournalUnavailable extends Error {}

const FILE = 'treasury-outflow.jsonl';
const DAY_MS = 24 * 60 * 60_000;
// Entries older than this are dropped when the file is compacted at load:
// nothing reads further back than one rolling 24h window.
const KEEP_MS = 2 * DAY_MS;

export type JournalMode = { kind: 'file'; dir: string } | { kind: 'memory' } | { kind: 'missing' };

function parseEntry(line: string): OutflowEntry | null {
  let v: any;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  if (!Number.isFinite(v.at) || !KINDS.includes(v.kind) || !Number.isSafeInteger(v.cents) || v.cents < 0 || typeof v.ref !== 'string') return null;
  return { at: v.at, kind: v.kind, cents: v.cents, ref: v.ref };
}

export class OutflowJournal {
  private entries: OutflowEntry[] | null = null;

  constructor(private readonly mode: JournalMode, private readonly now: () => number = Date.now) {}

  private get file(): string | null {
    return this.mode.kind === 'file' ? path.join(this.mode.dir, FILE) : null;
  }

  /** Loads (once per process) and compacts the journal. Throws OutflowJournalUnavailable on anything doubtful. */
  private load(): OutflowEntry[] {
    if (this.entries) return this.entries;
    if (this.mode.kind === 'missing') {
      throw new OutflowJournalUnavailable('outflow journal not configured (STATE_DIRECTORY / OUTFLOW_JOURNAL_DIR unset)');
    }
    if (this.mode.kind === 'memory') { this.entries = []; return this.entries; }
    const file = this.file!;
    let text = '';
    try {
      fs.mkdirSync(this.mode.dir, { recursive: true, mode: 0o700 });
      text = fs.readFileSync(file, 'utf8');
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw new OutflowJournalUnavailable(`outflow journal unreadable: ${e?.code ?? e}`);
    }
    const lines = text.split('\n');
    const entries: OutflowEntry[] = [];
    let dirty = false;
    lines.forEach((line, i) => {
      if (!line) return;
      const e = parseEntry(line);
      if (e) { entries.push(e); return; }
      // A torn final line (the process died mid-append) is the only damage
      // that is expected. It cannot stand for money that moved: the append
      // is completed and fsync'd before the transaction is broadcast. It is
      // dropped by the compaction below so the next append does not land on
      // the end of it. Damage anywhere else is not explainable -- refuse.
      const isTornTail = i === lines.length - 1 && !text.endsWith('\n');
      if (!isTornTail) throw new OutflowJournalUnavailable(`outflow journal corrupt at line ${i + 1}`);
      dirty = true;
    });
    // A last line with no newline -- torn and dropped above, or a COMPLETE
    // entry whose '\n' never landed (a short write, a crash between the two)
    // -- is re-terminated by the rewrite. Kept as it was, the next append
    // landed on the same line ({A}{B}), which still worked in that process
    // and then made every later load refuse "corrupt" -- every automatic
    // payout HELD from the next restart on.
    if (text && !text.endsWith('\n')) dirty = true;
    if (this.clampFuture(entries)) dirty = true;
    const cutoff = this.now() - KEEP_MS;
    const kept = entries.filter((e) => e.at >= cutoff);
    if (kept.length !== entries.length) dirty = true;
    if (dirty) this.rewrite(kept);
    this.entries = kept;
    return kept;
  }

  /**
   * Entries stamped in the future (the wall clock was set ahead when they
   * were written, then corrected) are pulled back to now. Left as they were,
   * each counted against the rolling window for as long as the clock jump --
   * a month-fast clock held every automatic payout for a month, with nothing
   * pointing at the clock. Clamped, each still counts for one full window
   * from now: the safe direction, but bounded. Returns whether any moved.
   */
  private clampFuture(entries: OutflowEntry[]): boolean {
    const now = this.now();
    let moved = 0, maxAheadMs = 0;
    for (const e of entries) {
      if (e.at > now) { maxAheadMs = Math.max(maxAheadMs, e.at - now); e.at = now; moved++; }
    }
    if (moved) {
      console.error(`OUTFLOW JOURNAL: ${moved} entr${moved === 1 ? 'y' : 'ies'} dated up to ${Math.round(maxAheadMs / 1000)}s in the FUTURE -- the system clock was ahead when they were written. Counted as of now (they hold outflow room for one full window). Check NTP / the droplet clock.`);
    }
    return moved > 0;
  }

  /** Atomic replace: write a temp file, fsync it, rename over, fsync the directory. */
  private rewrite(entries: OutflowEntry[]) {
    const file = this.file!;
    const tmp = `${file}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, entries.map((e) => JSON.stringify(e) + '\n').join(''));
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      const dfd = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch (e: any) {
      throw new OutflowJournalUnavailable(`outflow journal could not be compacted: ${e?.code ?? e}`);
    }
  }

  /** Throws unless the journal can be used (loaded and, for a file, writable). */
  assertUsable() { this.load(); }

  /**
   * `kind` outflow (in that kind's unit, see OutflowEntry) signed in the
   * rolling window ending now -- only entries recorded under `ref` when one
   * is given (a per-deposit-address gas limit, workers/sweep-gas.ts).
   */
  sumSince(kind: OutflowKind, windowMs = DAY_MS, ref?: string): number {
    const entries = this.load();
    // The clock can also step BACK while this process runs, after entries
    // were recorded (loaded ones were clamped at load); same treatment --
    // and persisted, as load() does. Clamped only in memory, the file kept
    // the future stamps, so the next restart (a routine redeploy) clamped
    // them again to the RESTART time and a correction held payouts for up
    // to ~48h instead of the one 24h window the runbook promises. A failed
    // rewrite throws OutflowJournalUnavailable: callers refuse to sign.
    if (this.clampFuture(entries) && this.mode.kind === 'file') this.rewrite(entries);
    const since = this.now() - windowMs;
    return entries.filter((e) => e.kind === kind && e.at >= since && (ref === undefined || e.ref === ref)).reduce((a, e) => a + e.cents, 0);
  }

  /**
   * Appends one outflow, durably, BEFORE it is broadcast. Throws
   * OutflowJournalUnavailable if it cannot be written -- the caller must then
   * not broadcast.
   */
  record(kind: OutflowKind, cents: number, ref: string) {
    if (!KINDS.includes(kind) || !Number.isSafeInteger(cents) || cents < 0) throw new OutflowJournalUnavailable('bad outflow entry');
    const entries = this.load();
    const entry: OutflowEntry = { at: this.now(), kind, cents, ref: String(ref).slice(0, 200) };
    if (this.mode.kind === 'file') {
      try {
        const fd = fs.openSync(this.file!, 'a', 0o600);
        try {
          // writeSync may write only part of the buffer (ENOSPC partway, a
          // signal): its return value was ignored, so a torn line counted as
          // a success. Loop until every byte is down; no progress is a failure.
          const buf = Buffer.from(JSON.stringify(entry) + '\n', 'utf8');
          let off = 0;
          while (off < buf.length) {
            const n = fs.writeSync(fd, buf, off, buf.length - off);
            if (!(n > 0)) throw Object.assign(new Error('short write'), { code: 'ESHORTWRITE' });
            off += n;
          }
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
      } catch (e: any) {
        // A partial write may have left a torn line: reload (and compact it
        // away) before anything is appended after it.
        this.entries = null;
        throw new OutflowJournalUnavailable(`outflow journal not writable: ${e?.code ?? e}`);
      }
    }
    entries.push(entry);
  }
}

/**
 * The process-wide journal. systemd sets STATE_DIRECTORY for a unit with
 * StateDirectory= (deploy/onlyone-workers.service); OUTFLOW_JOURNAL_DIR is
 * for running the workers by hand in development. Under the test runner with
 * neither set it is memory-only; anywhere else with neither set it refuses.
 */
export function journalModeFromEnv(env: NodeJS.ProcessEnv = process.env): JournalMode {
  const dir = (env.STATE_DIRECTORY || '').split(':')[0].trim() || (env.OUTFLOW_JOURNAL_DIR || '').trim();
  if (dir) return { kind: 'file', dir };
  return env.NODE_ENV === 'test' ? { kind: 'memory' } : { kind: 'missing' };
}

export const treasuryOutflow = new OutflowJournal(journalModeFromEnv());
