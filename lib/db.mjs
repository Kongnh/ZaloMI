// Private SQLite database for Zalo MI (spec section 7): schema, idempotent upserts, full-text search.
//
// Conventions
// - Upsert objects use the spec's snake_case column names. Unknown keys are ignored, a key that is
//   absent (or undefined) is left alone on update and NULL on insert, an explicit null overwrites.
//   So a re-run never duplicates, and a partial update (say, only stored_path) never wipes the rest.
// - Times are millisecond integers. messages.ingested_at is set on first insert, updated_at on every upsert.
// - messages_fts is a projection of messages (+ images.ocr_text), kept in sync from JS inside the same
//   transaction: one row per message. It is located through messages.fts_rowid, because looking a row up
//   by an UNINDEXED column would scan the whole FTS table on every upsert.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS "groups" (
  conv_id TEXT PRIMARY KEY,
  name TEXT, description TEXT, total_member INTEGER,
  tracked INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER, last_synced_at INTEGER, last_msg_ts INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  msg_id TEXT PRIMARY KEY,
  conv_id TEXT, cli_msg_id TEXT, ts INTEGER, from_uid TEXT, sender_name TEXT, msg_type TEXT, kind TEXT,
  text TEXT, title TEXT, description TEXT, url TEXT, quote_msg_id TEXT, quote_text TEXT,
  mentions_json TEXT, raw_json TEXT,
  ingested_at INTEGER, updated_at INTEGER,
  fts_rowid INTEGER
);
CREATE INDEX IF NOT EXISTS messages_conv_ts ON messages (conv_id, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  msg_id UNINDEXED, conv_id UNINDEXED, ts UNINDEXED,
  text, title, description, ocr_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS links (
  msg_id TEXT PRIMARY KEY,
  conv_id TEXT, ts INTEGER, url TEXT, domain TEXT, title TEXT, description TEXT
);
CREATE INDEX IF NOT EXISTS links_conv_ts ON links (conv_id, ts);

CREATE TABLE IF NOT EXISTS files (
  msg_id TEXT PRIMARY KEY,
  conv_id TEXT, ts INTEGER, sender_name TEXT, file_name TEXT, ext TEXT, size INTEGER, checksum TEXT,
  remote_url TEXT, stored_path TEXT, status TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS files_conv_ts ON files (conv_id, ts);

CREATE TABLE IF NOT EXISTS images (
  msg_id TEXT PRIMARY KEY,
  conv_id TEXT, ts INTEGER, sender_name TEXT, caption TEXT, width INTEGER, height INTEGER,
  remote_url TEXT, cache_path TEXT, stored_path TEXT, shape_class TEXT, text_score REAL,
  ocr_text TEXT, has_text INTEGER, scanned_at INTEGER, status TEXT
);
CREATE INDEX IF NOT EXISTS images_conv_ts ON images (conv_id, ts);

CREATE TABLE IF NOT EXISTS member_events (
  msg_id TEXT PRIMARY KEY,
  conv_id TEXT, ts INTEGER, event TEXT, member_uids_json TEXT, member_name TEXT, actor_name TEXT, text TEXT
);
CREATE INDEX IF NOT EXISTS member_events_conv_ts ON member_events (conv_id, ts);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER, finished_at INTEGER, "groups" INTEGER,
  new_messages INTEGER, updated_messages INTEGER, errors_json TEXT
);
`;

// Columns a caller may set, per table. Managed columns (ingested_at, updated_at, fts_rowid) are left out on purpose.
const TABLES = {
  groups: { pk: 'conv_id', cols: ['name', 'description', 'total_member', 'tracked', 'first_seen_at', 'last_synced_at', 'last_msg_ts'] },
  messages: {
    pk: 'msg_id',
    cols: ['conv_id', 'cli_msg_id', 'ts', 'from_uid', 'sender_name', 'msg_type', 'kind', 'text', 'title', 'description', 'url',
      'quote_msg_id', 'quote_text', 'mentions_json', 'raw_json'],
  },
  links: { pk: 'msg_id', cols: ['conv_id', 'ts', 'url', 'domain', 'title', 'description'] },
  files: { pk: 'msg_id', cols: ['conv_id', 'ts', 'sender_name', 'file_name', 'ext', 'size', 'checksum', 'remote_url', 'stored_path', 'status', 'error'] },
  images: {
    pk: 'msg_id',
    cols: ['conv_id', 'ts', 'sender_name', 'caption', 'width', 'height', 'remote_url', 'cache_path', 'stored_path', 'shape_class',
      'text_score', 'ocr_text', 'has_text', 'scanned_at', 'status'],
  },
  member_events: { pk: 'msg_id', cols: ['conv_id', 'ts', 'event', 'member_uids_json', 'member_name', 'actor_name', 'text'] },
};

const SYNC_RUN_COLS = ['started_at', 'finished_at', 'groups', 'new_messages', 'updated_messages', 'errors_json'];

// unicode61 folds accents but not the stroke letter, so "điện" is indexed as "đien" and "dien" would miss it.
// Each d/đ in a query word is therefore searched both ways (capped so a word full of d's stays cheap).
const MAX_STROKE_SLOTS = 4;

const quoteId = name => `"${name}"`;
const sameValue = (a, b) => a === b || (a != null && b != null && String(a) === String(b));

/** Converts a JS value to something node:sqlite can bind, or throws naming the offending column. */
function bindable(table, col, v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint' || v instanceof Uint8Array) return v;
  throw new TypeError(`${table}.${col}: cannot store ${Array.isArray(v) ? 'an array' : `a ${typeof v}`} (pass JSON text for *_json columns)`);
}

function strokeVariants(word) {
  const chars = [...word];
  const slots = chars.flatMap((c, i) => (c === 'd' || c === 'đ' ? [i] : []));
  if (slots.length === 0 || slots.length > MAX_STROKE_SLOTS) return [word];
  const variants = [];
  for (let mask = 0; mask < 1 << slots.length; mask++) {
    const next = chars.slice();
    slots.forEach((pos, bit) => { next[pos] = mask & (1 << bit) ? 'đ' : 'd'; });
    variants.push(next.join(''));
  }
  return variants;
}

/** Turns free text into a safe FTS5 query: every word is a quoted term (so syntax characters are plain text), AND-ed. */
function toFtsQuery(q) {
  const terms = [];
  for (const rawWord of String(q ?? '').split(/\s+/)) {
    const word = rawWord.toLowerCase();
    if (!/[\p{L}\p{N}]/u.test(word)) continue; // pure punctuation tokenizes to nothing and would empty the whole query
    terms.push(`(${strokeVariants(word).map(v => `"${v.replaceAll('"', '""')}"`).join(' OR ')})`);
  }
  return terms.join(' AND ');
}

/**
 * Opens (creating if needed) the database at `path` (or ':memory:') and returns the DB API.
 * @param {string} path
 * @param {{ now?: () => number }} [options] `now` supplies millisecond timestamps (tests inject a fake clock).
 */
export function openDb(path, { now = Date.now } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA busy_timeout = 5000');
  raw.exec(SCHEMA);

  const statements = new Map();
  const stmt = sql => {
    let s = statements.get(sql);
    if (!s) { s = raw.prepare(sql); statements.set(sql, s); }
    return s;
  };

  let depth = 0;
  /** Runs fn atomically. Nested calls become savepoints, so an inner failure can be caught without losing the outer work. */
  function transaction(fn) {
    const outermost = depth === 0;
    const savepoint = `zmi_sp_${depth}`;
    raw.exec(outermost ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new TypeError('transaction() callback must be synchronous');
      raw.exec(outermost ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (err) {
      try { raw.exec(outermost ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); } catch { /* already rolled back */ }
      throw err;
    } finally {
      depth--;
    }
  }

  /**
   * INSERT ... ON CONFLICT(pk) DO UPDATE over the provided columns only.
   * `onInsert` are defaults applied on first insert only; `always` are written on every upsert.
   * @returns {{ inserted: boolean, changed: boolean }} changed: a provided column differs from what was stored.
   */
  function upsert(table, row, { onInsert = {}, always = {} } = {}) {
    const { pk, cols } = TABLES[table];
    const key = row?.[pk];
    if (key === undefined || key === null) throw new TypeError(`${table}: missing primary key ${pk}`);

    const provided = cols.filter(c => row[c] !== undefined);
    const values = { [pk]: key };
    for (const c of provided) values[c] = bindable(table, c, row[c]);
    for (const [c, v] of Object.entries(onInsert)) if (!(c in values)) values[c] = v;
    Object.assign(values, always);

    const insertCols = Object.keys(values);
    const updateCols = [...provided, ...Object.keys(always)];
    const conflict = updateCols.length
      ? `DO UPDATE SET ${updateCols.map(c => `${quoteId(c)} = excluded.${quoteId(c)}`).join(', ')}`
      : 'DO NOTHING';

    const previous = stmt(`SELECT ${[pk, ...provided].map(quoteId).join(', ')} FROM ${quoteId(table)} WHERE ${quoteId(pk)} = ?`).get(key);
    stmt(`INSERT INTO ${quoteId(table)} (${insertCols.map(quoteId).join(', ')}) VALUES (${insertCols.map(() => '?').join(', ')}) ` +
      `ON CONFLICT (${quoteId(pk)}) ${conflict}`).run(...insertCols.map(c => values[c]));

    return { inserted: !previous, changed: !previous || provided.some(c => !sameValue(previous[c], values[c])) };
  }

  /** Brings the message's FTS row in line with messages (+ images.ocr_text). No message yet means nothing to index. */
  function syncFts(msgId) {
    const m = stmt(
      `SELECT m.conv_id, m.ts, m.text, m.title, m.description, m.fts_rowid, i.ocr_text
         FROM messages m LEFT JOIN images i ON i.msg_id = m.msg_id WHERE m.msg_id = ?`).get(msgId);
    if (!m) return;
    const fields = [m.conv_id, m.ts, m.text, m.title, m.description, m.ocr_text];
    if (m.fts_rowid === null) {
      const { lastInsertRowid } = stmt(
        'INSERT INTO messages_fts (conv_id, ts, text, title, description, ocr_text, msg_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(...fields, msgId);
      stmt('UPDATE messages SET fts_rowid = ? WHERE msg_id = ?').run(lastInsertRowid, msgId);
    } else {
      stmt('UPDATE messages_fts SET conv_id = ?, ts = ?, text = ?, title = ?, description = ?, ocr_text = ? WHERE rowid = ?')
        .run(...fields, m.fts_rowid);
    }
  }

  return {
    /** The underlying DatabaseSync, for read queries. */
    raw,
    transaction,

    upsertGroup: g => upsert('groups', g, { onInsert: { first_seen_at: now() } }),
    upsertLink: l => upsert('links', l),
    upsertFile: f => upsert('files', f),
    upsertMemberEvent: e => upsert('member_events', e),

    upsertMessage: m => transaction(() => {
      const t = now();
      const result = upsert('messages', m, { onInsert: { ingested_at: t }, always: { updated_at: t } });
      syncFts(m.msg_id);
      return result;
    }),

    upsertImage: i => transaction(() => {
      const result = upsert('images', i);
      if (i.ocr_text !== undefined) syncFts(i.msg_id);
      return result;
    }),

    recordSyncRun: run => {
      const { lastInsertRowid } = stmt(
        `INSERT INTO sync_runs (${SYNC_RUN_COLS.map(quoteId).join(', ')}) VALUES (${SYNC_RUN_COLS.map(() => '?').join(', ')})`)
        .run(...SYNC_RUN_COLS.map(c => bindable('sync_runs', c, run[c])));
      return Number(lastInsertRowid);
    },

    /** Latest message ts of a conversation, 0 when it has none. */
    maxTs: convId => Number(stmt('SELECT MAX(ts) AS ts FROM messages WHERE conv_id = ?').get(convId).ts ?? 0),

    /**
     * Full-text search over message text, link title/description and image OCR text, newest first.
     * `q` is plain words (AND-ed, accent- and case-insensitive); `from`/`to` are inclusive ms timestamps;
     * `convIds` limits the groups (an empty array selects none).
     */
    search(q, { from, to, convIds } = {}) {
      const match = toFtsQuery(q);
      if (!match || (convIds && convIds.length === 0)) return [];
      const where = ['messages_fts MATCH ?'];
      const params = [match];
      if (from !== undefined && from !== null) { where.push('m.ts >= ?'); params.push(from); }
      if (to !== undefined && to !== null) { where.push('m.ts <= ?'); params.push(to); }
      if (convIds) { where.push(`m.conv_id IN (${convIds.map(() => '?').join(', ')})`); params.push(...convIds); }
      return stmt(
        `SELECT m.msg_id, m.conv_id, m.ts, m.sender_name, m.kind, m.text, m.title, m.description, messages_fts.ocr_text,
                snippet(messages_fts, -1, '[', ']', '…', 16) AS snippet
           FROM messages_fts JOIN messages m ON m.msg_id = messages_fts.msg_id
          WHERE ${where.join(' AND ')}
          ORDER BY m.ts DESC, m.msg_id DESC`).all(...params).map(r => ({ ...r }));
    },

    close: () => raw.close(),
  };
}
