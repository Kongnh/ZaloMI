import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../lib/db.mjs';

const T0 = 1_700_000_000_000;

/** In-memory DB with a controllable clock so timestamps never collide inside one millisecond. */
function memDb() {
  const clock = { t: T0 };
  const db = openDb(':memory:', { now: () => clock.t });
  return { db, clock };
}

const count = (db, table) => db.raw.prepare(`SELECT count(*) AS n FROM "${table}"`).get().n;
const ftsRows = (db, msgId) => db.raw.prepare('SELECT * FROM messages_fts WHERE msg_id = ?').all(msgId);
const msg = (over = {}) => ({
  msg_id: 'm1', conv_id: 'g1', cli_msg_id: 'c1', ts: 1000, from_uid: 'u1', sender_name: 'An',
  msg_type: 'webchat', kind: 'text', text: 'hello world', ...over,
});

test('upsertMessage twice keeps one row and bumps updated_at', () => {
  const { db, clock } = memDb();
  db.upsertMessage(msg());
  const first = db.raw.prepare('SELECT * FROM messages').get();
  clock.t += 5000;
  db.upsertMessage(msg({ text: 'hello again' }));

  assert.equal(count(db, 'messages'), 1);
  const row = db.raw.prepare('SELECT * FROM messages').get();
  assert.equal(row.text, 'hello again');
  assert.equal(row.ingested_at, first.ingested_at, 'ingested_at is set on first insert only');
  assert.equal(row.ingested_at, T0);
  assert.equal(row.updated_at, T0 + 5000);
  assert.notEqual(row.updated_at, first.updated_at);
  db.close();
});

test('upsertMessage reports whether the row was inserted or changed', () => {
  const { db } = memDb();
  assert.deepEqual(db.upsertMessage(msg()), { inserted: true, changed: true });
  assert.deepEqual(db.upsertMessage(msg()), { inserted: false, changed: false });
  assert.deepEqual(db.upsertMessage(msg({ text: 'edited' })), { inserted: false, changed: true });
  db.close();
});

test('missing optional columns become NULL, unknown keys are ignored, a missing primary key throws', () => {
  const { db } = memDb();
  db.upsertMessage({ msg_id: 'm1', conv_id: 'g1', ts: 1, not_a_column: 'x' });
  const row = db.raw.prepare('SELECT * FROM messages').get();
  assert.equal(row.text, null);
  assert.equal(row.url, null);
  assert.equal(row.quote_msg_id, null);
  assert.equal('not_a_column' in row, false);
  assert.throws(() => db.upsertMessage({ conv_id: 'g1', ts: 1 }), /msg_id/);
  assert.throws(() => db.upsertGroup({ name: 'no id' }), /conv_id/);
  db.close();
});

test('values are coerced for SQLite and unsupported ones are rejected by column name', () => {
  const { db } = memDb();
  db.upsertGroup({ conv_id: 'g1', name: undefined, tracked: true });
  const row = db.raw.prepare('SELECT * FROM "groups"').get();
  assert.equal(row.name, null);
  assert.equal(row.tracked, 1);
  assert.throws(() => db.upsertMessage({ msg_id: 'm1', conv_id: 'g1', mentions_json: [1, 2] }), /messages\.mentions_json/);
  db.close();
});

test('maxTs returns latest ts for a conv', () => {
  const { db } = memDb();
  assert.equal(db.maxTs('g1'), 0, 'no messages yet');
  db.upsertMessage(msg({ msg_id: 'a', ts: 1000 }));
  db.upsertMessage(msg({ msg_id: 'b', ts: 3000 }));
  db.upsertMessage(msg({ msg_id: 'c', ts: 2000 }));
  db.upsertMessage(msg({ msg_id: 'd', conv_id: 'g2', ts: 9000 }));
  assert.equal(db.maxTs('g1'), 3000);
  assert.equal(db.maxTs('g2'), 9000);
  assert.equal(db.maxTs('nope'), 0);
  db.close();
});

test('search is diacritic-insensitive', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ text: 'Năng lượng tái tạo' }));
  db.upsertMessage(msg({ msg_id: 'm2', text: 'Giá điện mặt trời', title: 'ĐIỆN MẶT TRỜI' }));
  db.upsertMessage(msg({ msg_id: 'm3', text: 'Họp tại Đà Nẵng' }));

  const hit = db.search('nang luong');
  assert.deepEqual(hit.map(r => r.msg_id), ['m1']);
  assert.equal(hit[0].text, 'Năng lượng tái tạo', 'the original text comes back, not a folded copy');
  assert.deepEqual(db.search('năng lượng').map(r => r.msg_id), ['m1'], 'accented query matches too');
  assert.deepEqual(db.search('NANG LUONG').map(r => r.msg_id), ['m1'], 'case-insensitive');
  assert.deepEqual(db.search('Năng lượng'.normalize('NFD')).map(r => r.msg_id), ['m1'], 'decomposed query matches');
  db.close();
});

test('search treats d and đ alike because unicode61 does not fold the stroke letter', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ msg_id: 'm2', text: 'Giá điện mặt trời', title: 'ĐIỆN MẶT TRỜI' }));
  db.upsertMessage(msg({ msg_id: 'm3', text: 'Họp tại Đà Nẵng' }));
  db.upsertMessage(msg({ msg_id: 'm4', text: 'Dự án điện gió' }));

  assert.deepEqual(db.search('dien').map(r => r.msg_id).sort(), ['m2', 'm4']);
  assert.deepEqual(db.search('điện').map(r => r.msg_id).sort(), ['m2', 'm4']);
  assert.deepEqual(db.search('da nang').map(r => r.msg_id), ['m3']);
  assert.deepEqual(db.search('Đà Nẵng').map(r => r.msg_id), ['m3']);
  assert.deepEqual(db.search('du an dien gio').map(r => r.msg_id), ['m4']);
  db.close();
});

test('search ANDs the words and returns the documented row shape, newest first', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ msg_id: 'a', ts: 1000, sender_name: 'An', kind: 'text', text: 'điện gió ngoài khơi' }));
  db.upsertMessage(msg({ msg_id: 'b', ts: 3000, sender_name: 'Bình', kind: 'link', title: 'Điện gió', description: 'Quy hoạch điện' }));
  db.upsertMessage(msg({ msg_id: 'c', ts: 2000, text: 'chỉ có gió' }));

  const rows = db.search('dien gio');
  assert.deepEqual(rows.map(r => r.msg_id), ['b', 'a']);
  assert.deepEqual(Object.keys(rows[0]).sort(),
    ['conv_id', 'description', 'kind', 'msg_id', 'ocr_text', 'sender_name', 'snippet', 'text', 'title', 'ts']);
  assert.equal(rows[0].sender_name, 'Bình');
  assert.equal(rows[0].kind, 'link');
  assert.equal(rows[0].ts, 3000);
  assert.equal(rows[0].title, 'Điện gió');
  assert.match(rows[0].snippet, /\[Điện\]/, 'snippet marks the matching word');
  assert.deepEqual(db.search('gio').map(r => r.msg_id), ['b', 'c', 'a']);
  assert.deepEqual(db.search('gio xyz'), []);
  db.close();
});

test('search filters by from/to (inclusive) and by convIds', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ msg_id: 'a', conv_id: 'g1', ts: 1000, text: 'solar' }));
  db.upsertMessage(msg({ msg_id: 'b', conv_id: 'g1', ts: 2000, text: 'solar' }));
  db.upsertMessage(msg({ msg_id: 'c', conv_id: 'g2', ts: 3000, text: 'solar' }));
  const ids = rows => rows.map(r => r.msg_id);

  assert.deepEqual(ids(db.search('solar')), ['c', 'b', 'a']);
  assert.deepEqual(ids(db.search('solar', { from: 2000 })), ['c', 'b']);
  assert.deepEqual(ids(db.search('solar', { to: 2000 })), ['b', 'a']);
  assert.deepEqual(ids(db.search('solar', { from: 1500, to: 2500 })), ['b']);
  assert.deepEqual(ids(db.search('solar', { convIds: ['g1'] })), ['b', 'a']);
  assert.deepEqual(ids(db.search('solar', { convIds: ['g1', 'g2'], from: 2000 })), ['c', 'b']);
  assert.deepEqual(db.search('solar', { convIds: [] }), [], 'an empty group list selects nothing');
  db.close();
});

test('search never throws on FTS syntax characters in the query', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ text: 'solar wind -x text:foo "quoted" a*b (paren) AND OR NEAR' }));
  const hostile = ['"', '""', '"unbalanced', "it's", '-', '--x', 'a:b', 'text:foo', 'foo*', '*', '(', ')', 'a AND', 'OR', 'NEAR(a b)',
    '^x', '{a b}', 'solar -wind', '\\', ';--', ''];
  for (const q of hostile) assert.doesNotThrow(() => db.search(q), `query ${JSON.stringify(q)}`);
  assert.deepEqual(db.search('   '), []);
  assert.deepEqual(db.search('-'), []);
  assert.deepEqual(db.search('solar "'), [db.search('solar')[0]], 'stray punctuation words are dropped, real words still match');
  assert.deepEqual(db.search('text:foo').map(r => r.msg_id), ['m1'], 'a column prefix is just words');
  assert.deepEqual(db.search('"quoted"').map(r => r.msg_id), ['m1']);
  db.close();
});

test('repeated upserts never duplicate FTS rows and edits re-index', () => {
  const { db } = memDb();
  for (let i = 0; i < 3; i++) db.upsertMessage(msg());
  assert.equal(ftsRows(db, 'm1').length, 1);

  db.upsertMessage(msg({ text: 'Giá than', title: 'Tiêu đề', description: 'Mô tả' }));
  assert.equal(ftsRows(db, 'm1').length, 1);
  assert.equal(count(db, 'messages_fts'), 1);
  assert.deepEqual(db.search('hello'), [], 'old words are gone');
  assert.deepEqual(db.search('gia than').map(r => r.msg_id), ['m1']);
  assert.deepEqual(db.search('tieu de').map(r => r.msg_id), ['m1']);
  assert.deepEqual(db.search('mo ta').map(r => r.msg_id), ['m1']);
  const fts = ftsRows(db, 'm1')[0];
  assert.equal(fts.conv_id, 'g1');
  assert.equal(fts.ts, 1000);
  db.close();
});

test('upsertImage puts OCR text into the same FTS row and later message upserts keep it', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ msg_id: 'img1', kind: 'image', text: null }));
  assert.deepEqual(db.search('bieu gia'), []);

  db.upsertImage({ msg_id: 'img1', conv_id: 'g1', ts: 1000, ocr_text: 'Biểu giá điện 2026', has_text: 1 });
  assert.equal(ftsRows(db, 'img1').length, 1, 'still one FTS row per message');
  const hit = db.search('bieu gia dien');
  assert.deepEqual(hit.map(r => r.msg_id), ['img1']);
  assert.equal(hit[0].ocr_text, 'Biểu giá điện 2026');

  db.upsertMessage(msg({ msg_id: 'img1', kind: 'image', text: null, title: 'Ảnh' }));
  assert.equal(ftsRows(db, 'img1').length, 1);
  assert.deepEqual(db.search('bieu gia dien').map(r => r.msg_id), ['img1'], 'OCR text survives a message re-upsert');

  db.upsertImage({ msg_id: 'img1', conv_id: 'g1', ts: 1000, status: 'stored' });
  assert.deepEqual(db.search('bieu gia dien').map(r => r.msg_id), ['img1'], 'omitting ocr_text leaves it alone');
  db.close();
});

test('OCR text saved before its message exists is indexed when the message arrives', () => {
  const { db } = memDb();
  db.upsertImage({ msg_id: 'img1', conv_id: 'g1', ts: 1000, ocr_text: 'Quyết định 768' });
  assert.equal(count(db, 'messages_fts'), 0, 'nothing to attach the OCR text to yet');
  db.upsertMessage(msg({ msg_id: 'img1', kind: 'image', text: null }));
  assert.deepEqual(db.search('quyet dinh 768').map(r => r.msg_id), ['img1']);
  db.close();
});

test('files: a later upsert keeps stored_path and status when it omits them', () => {
  const { db } = memDb();
  db.upsertFile({ msg_id: 'f1', conv_id: 'g1', ts: 1, sender_name: 'An', file_name: 'a.pdf', ext: 'pdf', size: 10, remote_url: 'https://x/a.pdf' });
  db.upsertFile({ msg_id: 'f1', stored_path: 'data/files/a.pdf', status: 'stored', checksum: 'abc' });
  db.upsertFile({ msg_id: 'f1', conv_id: 'g1', ts: 1, sender_name: 'An', file_name: 'a.pdf', ext: 'pdf', size: 10, remote_url: 'https://x/a.pdf' });

  assert.equal(count(db, 'files'), 1);
  const row = db.raw.prepare('SELECT * FROM files').get();
  assert.equal(row.stored_path, 'data/files/a.pdf');
  assert.equal(row.status, 'stored');
  assert.equal(row.checksum, 'abc');
  assert.equal(row.file_name, 'a.pdf');

  db.upsertFile({ msg_id: 'f1', status: 'remote_only', error: 'gone', stored_path: null });
  const wiped = db.raw.prepare('SELECT * FROM files').get();
  assert.equal(wiped.status, 'remote_only');
  assert.equal(wiped.stored_path, null, 'an explicit null is honoured');
  db.close();
});

test('images: a later upsert keeps stored_path and status when it omits them', () => {
  const { db } = memDb();
  db.upsertImage({ msg_id: 'i1', conv_id: 'g1', ts: 1, width: 100, height: 50, remote_url: 'https://x/i.jpg', cache_path: 'c:/cache/i.jpg' });
  db.upsertImage({ msg_id: 'i1', stored_path: 'data/images/i1.jpg', status: 'stored', has_text: 1, text_score: 0.8, scanned_at: 5 });
  db.upsertImage({ msg_id: 'i1', conv_id: 'g1', ts: 1, width: 100, height: 50, remote_url: 'https://x/i.jpg', cache_path: 'c:/cache/i.jpg' });

  assert.equal(count(db, 'images'), 1);
  const row = db.raw.prepare('SELECT * FROM images').get();
  assert.equal(row.stored_path, 'data/images/i1.jpg');
  assert.equal(row.status, 'stored');
  assert.equal(row.has_text, 1);
  assert.equal(row.text_score, 0.8);
  assert.equal(row.width, 100);
  db.close();
});

test('upsertGroup keeps tracked and first_seen_at when a re-listing omits them', () => {
  const { db, clock } = memDb();
  db.upsertGroup({ conv_id: 'g1', name: 'Future Energy', total_member: 10 });
  db.upsertGroup({ conv_id: 'g1', tracked: 1, last_synced_at: 50, last_msg_ts: 40 });
  clock.t += 1000;
  db.upsertGroup({ conv_id: 'g1', name: 'Future Energy VN', total_member: 11 });

  assert.equal(count(db, 'groups'), 1);
  const row = db.raw.prepare('SELECT * FROM "groups"').get();
  assert.equal(row.name, 'Future Energy VN');
  assert.equal(row.total_member, 11);
  assert.equal(row.tracked, 1);
  assert.equal(row.first_seen_at, T0);
  assert.equal(row.last_synced_at, 50);
  assert.equal(row.last_msg_ts, 40);

  db.upsertGroup({ conv_id: 'g2', name: 'Other' });
  assert.equal(db.raw.prepare('SELECT tracked FROM "groups" WHERE conv_id = ?').get('g2').tracked, 0, 'new groups start untracked');
  db.close();
});

test('links and member events are idempotent', () => {
  const { db } = memDb();
  const link = { msg_id: 'l1', conv_id: 'g1', ts: 1, url: 'https://a.vn/x', domain: 'a.vn', title: 'T', description: 'D' };
  db.upsertLink(link); db.upsertLink({ ...link, title: 'T2' });
  assert.equal(count(db, 'links'), 1);
  assert.equal(db.raw.prepare('SELECT title FROM links').get().title, 'T2');

  const ev = { msg_id: 'e1', conv_id: 'g1', ts: 1, event: 'joined', member_uids_json: '["u1"]', member_name: 'An', actor_name: null, text: 'An joined' };
  db.upsertMemberEvent(ev); db.upsertMemberEvent(ev);
  assert.equal(count(db, 'member_events'), 1);
  assert.equal(db.raw.prepare('SELECT event FROM member_events').get().event, 'joined');
  db.close();
});

test('recordSyncRun stores the run and returns its id', () => {
  const { db } = memDb();
  const run = { started_at: 1, finished_at: 2, groups: 3, new_messages: 4, updated_messages: 5, errors_json: '[]' };
  const id1 = db.recordSyncRun(run);
  const id2 = db.recordSyncRun({ ...run, errors_json: null });
  assert.equal(typeof id1, 'number');
  assert.equal(id2, id1 + 1);
  assert.deepEqual({ ...db.raw.prepare('SELECT * FROM sync_runs WHERE id = ?').get(id1) }, { id: id1, ...run });
  assert.equal(db.raw.prepare('SELECT errors_json FROM sync_runs WHERE id = ?').get(id2).errors_json, null);
  db.close();
});

test('transaction commits, and rolls back message and FTS writes together when the callback throws', () => {
  const { db } = memDb();
  const out = db.transaction(() => { db.upsertMessage(msg({ msg_id: 'a' })); return 42; });
  assert.equal(out, 42);
  assert.equal(count(db, 'messages'), 1);

  const boom = new Error('boom');
  assert.throws(() => db.transaction(() => {
    db.upsertMessage(msg({ msg_id: 'b', text: 'rolled back' }));
    db.upsertGroup({ conv_id: 'g9' });
    throw boom;
  }), err => err === boom);
  assert.equal(count(db, 'messages'), 1);
  assert.equal(count(db, 'groups'), 0);
  assert.equal(count(db, 'messages_fts'), 1);
  assert.deepEqual(db.search('rolled'), []);

  db.upsertMessage(msg({ msg_id: 'b', text: 'works after a rollback' }));
  assert.equal(count(db, 'messages'), 2);
  db.close();
});

test('transaction nests: an inner failure that is caught does not poison the outer commit', () => {
  const { db } = memDb();
  db.transaction(() => {
    db.upsertMessage(msg({ msg_id: 'a' }));
    assert.throws(() => db.transaction(() => { db.upsertMessage(msg({ msg_id: 'b' })); throw new Error('inner'); }), /inner/);
    db.upsertMessage(msg({ msg_id: 'c' }));
  });
  assert.deepEqual(db.raw.prepare('SELECT msg_id FROM messages ORDER BY msg_id').all().map(r => r.msg_id), ['a', 'c']);
  assert.equal(count(db, 'messages_fts'), 2);
  db.close();
});

test('transaction rejects an async callback instead of committing early', () => {
  const { db } = memDb();
  assert.throws(() => db.transaction(async () => { db.upsertMessage(msg()); }), /synchronous/);
  assert.equal(count(db, 'messages'), 0, 'the work was rolled back');
  db.close();
});

test('openDb creates parent directories, enables WAL and reopens the same data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zmi-db-'));
  const file = path.join(dir, 'nested', 'data', 'zalo-mi.db');
  try {
    const db = openDb(file);
    assert.equal(db.raw.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    db.upsertMessage(msg({ text: 'persisted tin nhắn' }));
    db.close();

    const again = openDb(file);
    assert.equal(count(again, 'messages'), 1);
    assert.deepEqual(again.search('tin nhan').map(r => r.msg_id), ['m1']);
    again.upsertMessage(msg({ text: 'persisted tin nhắn 2' }));
    assert.equal(count(again, 'messages_fts'), 1, 'schema creation is idempotent and FTS stays one-per-message across reopen');
    again.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('conv_id/ts indexes exist on every message-keyed table', () => {
  const { db } = memDb();
  for (const table of ['messages', 'links', 'files', 'images', 'member_events']) {
    const hasIndex = db.raw.prepare(`PRAGMA index_list("${table}")`).all().some(ix => {
      const cols = db.raw.prepare(`PRAGMA index_info("${ix.name}")`).all().map(c => c.name);
      return cols.join(',') === 'conv_id,ts';
    });
    assert.ok(hasIndex, `${table} has an index on (conv_id, ts)`);
  }
  db.close();
});

test('id columns must be strings: a number would be stored as "123.0" and later duplicate the row', () => {
  const { db } = memDb();
  const idColumns = {
    groups: ['conv_id'],
    messages: ['msg_id', 'conv_id', 'cli_msg_id', 'from_uid', 'quote_msg_id'],
    links: ['msg_id', 'conv_id'],
    files: ['msg_id', 'conv_id'],
    images: ['msg_id', 'conv_id'],
    member_events: ['msg_id', 'conv_id'],
  };
  const upserts = {
    groups: db.upsertGroup, messages: db.upsertMessage, links: db.upsertLink,
    files: db.upsertFile, images: db.upsertImage, member_events: db.upsertMemberEvent,
  };
  for (const [table, cols] of Object.entries(idColumns)) {
    const pk = table === 'groups' ? 'conv_id' : 'msg_id';
    for (const col of cols) {
      for (const bad of [123, 7243489503495003628n]) {
        const row = { [pk]: 'id1', [col]: bad };
        assert.throws(() => upserts[table](row), err => err instanceof TypeError && err.message.includes(`${table}.${col}`),
          `${table}.${col} rejects ${typeof bad}`);
      }
    }
    assert.equal(count(db, table), 0, `${table}: nothing was written`);
  }

  // Non-primary-key id columns may still be null/absent.
  db.upsertMessage({ msg_id: 'id1', conv_id: 'g1', cli_msg_id: null, quote_msg_id: undefined });
  assert.equal(count(db, 'messages'), 1);
  assert.throws(() => db.upsertMessage({ msg_id: null, conv_id: 'g1' }), /msg_id/);
  db.close();
});

test('19-digit string ids round-trip exactly and re-upserting the same id keeps one row', () => {
  const { db } = memDb();
  const msgId = '7243489503495003628'; // beyond 2^53: a JS number could not hold it
  const convId = 'g8318398124727869839';
  db.upsertMessage({ msg_id: msgId, conv_id: convId, cli_msg_id: '7243489503495003629', from_uid: '1498602681856850483', ts: 1, text: 'a' });
  db.upsertMessage({ msg_id: msgId, conv_id: convId, cli_msg_id: '7243489503495003629', from_uid: '1498602681856850483', ts: 1, text: 'b' });
  assert.equal(count(db, 'messages'), 1);
  const row = db.raw.prepare('SELECT * FROM messages').get();
  assert.equal(row.msg_id, msgId);
  assert.equal(row.cli_msg_id, '7243489503495003629');
  assert.equal(row.from_uid, '1498602681856850483');
  assert.equal(db.maxTs(convId), 1);
  assert.deepEqual(db.search('b', { convIds: [convId] }).map(r => r.msg_id), [msgId]);
  db.close();
});

test('maxTs and search reject a numeric conversation id instead of silently matching nothing', () => {
  const { db } = memDb();
  db.upsertMessage(msg({ conv_id: '123', text: 'solar' }));
  assert.throws(() => db.maxTs(123), /conv_id/);
  assert.throws(() => db.search('solar', { convIds: [123] }), /conv_id/);
  assert.equal(db.maxTs('123'), 1000);
  assert.deepEqual(db.search('solar', { convIds: ['123'] }).map(r => r.msg_id), ['m1']);
  db.close();
});
