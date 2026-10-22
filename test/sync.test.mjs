import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncGroup, syncAll, resolveTargets, formatGroupLine, formatTotalLine, SyncUsageError } from '../lib/sync.mjs';
import { normalizeMessage } from '../lib/normalize.mjs';
import { openDb } from '../lib/db.mjs';
import { syncCommand } from '../zmi.mjs';
import { CdpError } from '../lib/cdp.mjs';

const CONV = 'g8318398124727869839';
const OTHER = 'g1000000000000000002';
const DAY = 86400000;
const FIXTURES = new URL('./fixtures/messages/', import.meta.url);

/** Raw message exactly as stored in test/fixtures/messages (real structure, redacted names/phones/emails). */
const load = name => JSON.parse(fs.readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
const ALL = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort().map(f => load(f.replace(/\.json$/, '')));
const MAX_TS = Math.max(...ALL.map(r => Number(r.sendDttm)));

/** Minimal raw message for cases the fixtures do not cover. */
const rawMsg = (over = {}) => ({
  msgId: '1000', cliMsgId: '2000', msgType: 1, sendDttm: '1700000000000', fromUid: '3000', dName: 'Người X', message: 'xin chào', ...over,
});

/**
 * A stand-in for the Zalo bridge: serves `data[convId]` (raw messages) newest first and honours `fromTs` (inclusive)
 * like the real getMessages. `calls` records every request; `data` can be edited between syncs.
 */
function fakeBridge(data) {
  const calls = [];
  return {
    data,
    calls,
    async getMessages(convId, opts = {}) {
      calls.push({ convId, opts });
      if (data[convId] instanceof Error) throw data[convId];
      const sentAt = m => Number(m?.sendDttm) || 0;
      return structuredClone(data[convId] ?? [])
        .filter(m => opts.fromTs === undefined || sentAt(m) >= opts.fromTs)
        .sort((a, b) => sentAt(b) - sentAt(a));
    },
    close() { this.closed = true; },
  };
}

const count = (db, table, convId) => db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}${convId ? ' WHERE conv_id = ?' : ''}`).get(...(convId ? [convId] : [])).n;

// ---------------------------------------------------------------------------------------------------------------------
// syncGroup: window
// ---------------------------------------------------------------------------------------------------------------------

test('syncGroup incremental uses maxTs minus overlap', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: ALL });

  const first = await syncGroup(bridge, db, CONV);
  assert.equal(first.fetched, ALL.length);
  assert.equal(first.new, ALL.length);
  assert.deepEqual(bridge.calls[0], { convId: CONV, opts: {} }, 'nothing stored yet: backfill everything, no fromTs');
  assert.equal(db.maxTs(CONV), MAX_TS);

  await syncGroup(bridge, db, CONV);
  assert.deepEqual(bridge.calls[1], { convId: CONV, opts: { fromTs: MAX_TS - 3 * DAY } }, 'default overlap is 3 days');

  await syncGroup(bridge, db, CONV, { overlapDays: 1 });
  assert.deepEqual(bridge.calls[2].opts, { fromTs: MAX_TS - DAY });

  await syncGroup(bridge, db, CONV, { full: true });
  assert.deepEqual(bridge.calls[3].opts, {}, 'full ignores what is stored');
  db.close();
});

test('syncGroup incremental reads only the overlap window', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: ALL });
  await syncGroup(bridge, db, CONV);
  const second = await syncGroup(bridge, db, CONV);
  const inWindow = ALL.filter(r => Number(r.sendDttm) >= MAX_TS - 3 * DAY).length;
  assert.equal(second.fetched, inWindow, 'the fake honours fromTs, so only the overlap window comes back');
  db.close();
});

test('syncGroup refuses a missing convId instead of letting maxTs silently return 0', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({});
  for (const bad of [undefined, null, '', 12345]) {
    await assert.rejects(() => syncGroup(bridge, db, bad), TypeError);
  }
  assert.equal(bridge.calls.length, 0, 'Zalo is never asked');
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// syncGroup: idempotence and counting
// ---------------------------------------------------------------------------------------------------------------------

test('running twice yields no new rows', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: ALL });
  await syncGroup(bridge, db, CONV);
  const tables = ['messages', 'links', 'files', 'images', 'member_events', 'messages_fts'];
  const before = tables.map(t => count(db, t));
  assert.equal(before[0], ALL.length);

  for (const opts of [{}, { full: true }]) {
    const again = await syncGroup(bridge, db, CONV, opts);
    assert.equal(again.new, 0);
    assert.equal(again.updated, 0, 'identical rows are not counted as updates');
    assert.deepEqual(again.errors, []);
    assert.deepEqual(tables.map(t => count(db, t)), before);
  }
  db.close();
});

test('every side row normalize returns lands in its table', async () => {
  const db = openDb(':memory:');
  await syncGroup(fakeBridge({ [CONV]: ALL }), db, CONV);
  const expected = { links: 0, files: 0, images: 0, member_events: 0 };
  for (const raw of ALL) {
    const n = normalizeMessage(raw, { convId: CONV });
    expected.links += n.links.length;
    expected.files += n.files.length;
    expected.images += n.images.length;
    expected.member_events += n.memberEvents.length;
  }
  assert.ok(Object.values(expected).every(n => n > 0), 'the fixtures cover every side table');
  for (const [table, n] of Object.entries(expected)) assert.equal(count(db, table), n, table);
  db.close();
});

test('a changed message counts as updated, not new', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: [rawMsg({ msgId: '7001', message: 'bản đầu' })] });
  await syncGroup(bridge, db, CONV);
  bridge.data[CONV] = [rawMsg({ msgId: '7001', message: 'bản sửa' })];
  const r = await syncGroup(bridge, db, CONV);
  assert.equal(r.new, 0);
  assert.equal(r.updated, 1);
  assert.equal(db.raw.prepare('SELECT text FROM messages WHERE msg_id = ?').get('7001').text, 'bản sửa');
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// syncGroup: bad rows, bookkeeping
// ---------------------------------------------------------------------------------------------------------------------

test('a malformed raw row is recorded in errors while the others land', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({
    [CONV]: [
      rawMsg({ msgId: '9001', sendDttm: '1700000001000' }),
      { msgType: 1, sendDttm: '1700000002000', message: 'không có msgId' },
      rawMsg({ msgId: '9002', sendDttm: '1700000003000' }),
      rawMsg({ msgId: '9003', sendDttm: 'không phải số' }),
      rawMsg({ msgId: '9004', sendDttm: '1700000005000' }),
    ],
  });
  const r = await syncGroup(bridge, db, CONV);
  assert.equal(r.fetched, 5);
  assert.equal(r.new, 3);
  assert.equal(r.errors.length, 2);
  const byId = Object.fromEntries(r.errors.map(e => [String(e.msg_id), e.error]));
  assert.deepEqual(Object.keys(byId).sort(), ['9003', 'null']);
  assert.ok(Object.values(byId).every(e => typeof e === 'string' && e.length > 0));
  assert.deepEqual(db.raw.prepare('SELECT msg_id FROM messages ORDER BY msg_id').all().map(r => r.msg_id), ['9001', '9002', '9004']);
  assert.ok(db.raw.prepare('SELECT last_synced_at FROM "groups" WHERE conv_id = ?').get(CONV).last_synced_at, 'the group still counts as synced');
  db.close();
});

test('syncGroup stamps groups.last_synced_at and last_msg_ts, and leaves the other group columns alone', async () => {
  const db = openDb(':memory:');
  db.upsertGroup({ conv_id: CONV, name: 'Nhóm thử', total_member: 7, tracked: 1 });
  await syncGroup(fakeBridge({ [CONV]: ALL }), db, CONV, { now: () => 5000 });
  const g = db.raw.prepare('SELECT * FROM "groups" WHERE conv_id = ?').get(CONV);
  assert.equal(g.last_synced_at, 5000);
  assert.equal(g.last_msg_ts, MAX_TS);
  assert.deepEqual([g.name, g.total_member, g.tracked], ['Nhóm thử', 7, 1]);

  // A group with nothing on this machine is synced all the same, with no last_msg_ts to claim.
  await syncGroup(fakeBridge({}), db, OTHER, { now: () => 6000 });
  const empty = db.raw.prepare('SELECT last_synced_at, last_msg_ts FROM "groups" WHERE conv_id = ?').get(OTHER);
  assert.equal(empty.last_synced_at, 6000);
  assert.equal(empty.last_msg_ts, null);
  db.close();
});

test('an incremental run that finds nothing new does not lower last_msg_ts', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: ALL });
  await syncGroup(bridge, db, CONV);
  bridge.data[CONV] = [];
  await syncGroup(bridge, db, CONV);
  assert.equal(db.raw.prepare('SELECT last_msg_ts FROM "groups" WHERE conv_id = ?').get(CONV).last_msg_ts, MAX_TS);
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Recalled / deleted merge (spec 6.4: keep the old content)
// ---------------------------------------------------------------------------------------------------------------------

test('a message recalled after it was stored keeps its text, raw_json and full-text entry', async () => {
  const db = openDb(':memory:');
  const original = rawMsg({ msgId: '5001', message: 'Giá điện mặt trời mái nhà tăng mạnh', title: 'x' });
  const bridge = fakeBridge({ [CONV]: [original] });
  await syncGroup(bridge, db, CONV);
  assert.equal(db.search('mặt trời').length, 1);

  bridge.data[CONV] = [{ ...original, msgType: 20, message: '[Tin nhắn đã được thu hồi]' }];
  const r = await syncGroup(bridge, db, CONV);
  assert.equal(r.new, 0);
  assert.equal(r.updated, 1, 'the kind changed');

  const row = db.raw.prepare('SELECT kind, msg_type, text, raw_json FROM messages WHERE msg_id = ?').get('5001');
  assert.equal(row.kind, 'recalled');
  assert.equal(row.msg_type, '20');
  assert.equal(row.text, 'Giá điện mặt trời mái nhà tăng mạnh');
  assert.match(row.raw_json, /Giá điện mặt trời/);
  assert.doesNotMatch(row.raw_json, /thu hồi/);

  const hits = db.search('điện mặt trời');
  assert.equal(hits.length, 1, 'the old text is still searchable');
  assert.deepEqual([hits[0].msg_id, hits[0].kind], ['5001', 'recalled']);
  assert.equal(db.raw.prepare('SELECT text FROM messages_fts WHERE msg_id = ?').get('5001').text, 'Giá điện mặt trời mái nhà tăng mạnh');
  db.close();
});

test('re-syncing an already merged recalled message (the overlap window does it every run) keeps the old text', async () => {
  const db = openDb(':memory:');
  const original = rawMsg({ msgId: '5001', message: 'Dự thảo quy hoạch điện VIII sửa đổi' });
  const bridge = fakeBridge({ [CONV]: [original] });
  await syncGroup(bridge, db, CONV);
  bridge.data[CONV] = [{ ...original, msgType: 20, message: '[Tin nhắn đã được thu hồi]' }];
  await syncGroup(bridge, db, CONV);

  const again = await syncGroup(bridge, db, CONV);
  assert.equal(again.new, 0);
  assert.equal(again.updated, 0, 'nothing to change');
  assert.equal(db.raw.prepare('SELECT text FROM messages WHERE msg_id = ?').get('5001').text, 'Dự thảo quy hoạch điện VIII sửa đổi');
  assert.equal(db.search('quy hoạch điện').length, 1);

  // recalled, then deleted: still the same old content
  bridge.data[CONV] = [{ ...original, msgType: -27, message: '[Tin nhắn đã bị xóa]' }];
  const deleted = await syncGroup(bridge, db, CONV);
  assert.equal(deleted.updated, 1);
  const row = db.raw.prepare('SELECT kind, text FROM messages WHERE msg_id = ?').get('5001');
  assert.deepEqual([row.kind, row.text], ['deleted', 'Dự thảo quy hoạch điện VIII sửa đổi']);
  db.close();
});

test('a recalled message seen for the first time is stored without text; a recalled one never turns back into content', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: [rawMsg({ msgId: '5002', msgType: 20, message: '[Tin nhắn đã được thu hồi]' })] });
  const r = await syncGroup(bridge, db, CONV);
  assert.equal(r.new, 1);
  const row = db.raw.prepare('SELECT kind, text FROM messages WHERE msg_id = ?').get('5002');
  assert.deepEqual([row.kind, row.text], ['recalled', null]);
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// syncAll
// ---------------------------------------------------------------------------------------------------------------------

test('a group whose DB write throws is rolled back and the next group still syncs', async () => {
  const db = openDb(':memory:');
  const a = [
    rawMsg({ msgId: 'a1', sendDttm: '1700000001000' }),
    rawMsg({ msgId: 'a2', sendDttm: '1700000002000' }),
    rawMsg({ msgId: 'a3', sendDttm: '1700000003000' }), // newest: written last, after a1 and a2 are already in the transaction
  ];
  const b = [rawMsg({ msgId: 'b1', sendDttm: '1700000001000' }), rawMsg({ msgId: 'b2', sendDttm: '1700000002000' })];
  const bridge = fakeBridge({ [CONV]: a, [OTHER]: b });
  const failing = { ...db, upsertMessage: m => { if (m.msg_id === 'a3') throw new Error('disk I/O error'); return db.upsertMessage(m); } };

  const out = await syncAll(bridge, failing, [CONV, OTHER], { now: () => 9000 });

  assert.equal(count(db, 'messages', CONV), 0, 'nothing of the failed group is left behind');
  assert.equal(count(db, 'messages', OTHER), 2);
  assert.equal(out.groups[0].ok, false);
  assert.match(out.groups[0].error, /disk I\/O error/);
  assert.equal(out.groups[1].ok, true);
  assert.equal(out.groups[1].new, 2);
  assert.equal(db.raw.prepare('SELECT last_synced_at FROM "groups" WHERE conv_id = ?').get(CONV), undefined, 'a failed group is not stamped as synced');
  assert.equal(db.raw.prepare('SELECT last_synced_at FROM "groups" WHERE conv_id = ?').get(OTHER).last_synced_at, 9000);
  assert.equal(db.search('xin chào').length, 2, 'the full-text index was rolled back with the rows');

  const [run] = db.raw.prepare('SELECT * FROM sync_runs').all();
  assert.equal(run.groups, 2);
  assert.equal(run.new_messages, 2);
  assert.deepEqual(JSON.parse(run.errors_json).map(e => e.conv_id), [CONV]);
  db.close();
});

test('a group Zalo cannot read is recorded and the next group still syncs', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: new Error('Hơn 10000 dòng có cùng khóa'), [OTHER]: [rawMsg({ msgId: 'b1' })] });
  const out = await syncAll(bridge, db, [CONV, OTHER]);
  assert.equal(out.groups[0].ok, false);
  assert.match(out.groups[0].error, /cùng khóa/);
  assert.equal(out.groups[1].new, 1);
  assert.equal(out.totals.failedGroups, 1);
  db.close();
});

test('syncAll records exactly one sync_runs row per call, with totals', async () => {
  const db = openDb(':memory:');
  let t = 1000;
  const now = () => (t += 10);
  const bridge = fakeBridge({
    [CONV]: [rawMsg({ msgId: 'a1' }), { msgType: 1, sendDttm: '1700000002000' }], // one good row, one malformed
    [OTHER]: [rawMsg({ msgId: 'b1' }), rawMsg({ msgId: 'b2' })],
  });
  const out = await syncAll(bridge, db, [CONV, OTHER], { now });

  const runs = db.raw.prepare('SELECT * FROM sync_runs').all();
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.groups, 2);
  assert.equal(run.new_messages, 3);
  assert.equal(run.updated_messages, 0);
  assert.ok(run.started_at < run.finished_at);
  const errors = JSON.parse(run.errors_json);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].conv_id, CONV);
  assert.equal(typeof errors[0].error, 'string');
  assert.equal(out.runId, run.id);
  assert.deepEqual(out.totals, { groups: 2, fetched: 4, new: 3, updated: 0, errors: 1, failedGroups: 0 });

  await syncAll(bridge, db, [CONV, OTHER], { now });
  assert.equal(count(db, 'sync_runs'), 2, 'one row per call');
  db.close();
});

test('syncAll with no groups still records its run, and calls onGroup once per group as each finishes', async () => {
  const db = openDb(':memory:');
  const empty = await syncAll(fakeBridge({}), db, []);
  assert.equal(empty.totals.groups, 0);
  assert.equal(count(db, 'sync_runs'), 1);

  const seen = [];
  await syncAll(fakeBridge({ [CONV]: [rawMsg({ msgId: 'a1' })], [OTHER]: [] }), db, [CONV, OTHER], { onGroup: r => seen.push([r.convId, r.new]) });
  assert.deepEqual(seen, [[CONV, 1], [OTHER, 0]]);
  db.close();
});

test('syncAll passes full and overlapDays through to every group', async () => {
  const db = openDb(':memory:');
  const bridge = fakeBridge({ [CONV]: [rawMsg({ msgId: 'a1', sendDttm: '1700000000000' })], [OTHER]: [rawMsg({ msgId: 'b1', sendDttm: '1700000000000' })] });
  await syncAll(bridge, db, [CONV, OTHER]);
  bridge.calls.length = 0;
  await syncAll(bridge, db, [CONV, OTHER], { overlapDays: 2 });
  assert.deepEqual(bridge.calls.map(c => c.opts), [{ fromTs: 1700000000000 - 2 * DAY }, { fromTs: 1700000000000 - 2 * DAY }]);
  bridge.calls.length = 0;
  await syncAll(bridge, db, [CONV, OTHER], { full: true });
  assert.deepEqual(bridge.calls.map(c => c.opts), [{}, {}]);
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// Choosing groups, printing
// ---------------------------------------------------------------------------------------------------------------------

const CONFIG = {
  version: 1,
  groups: [
    { convId: 'g1', name: '☀️ Future Energy Vietnam 🇻🇳', tracked: true, note: '' },
    { convId: 'g2', name: 'Gió ngoài khơi', tracked: true, note: '' },
    { convId: 'g3', name: 'Mua sắm', tracked: false, note: '' },
    { convId: 'g4', name: 'Nhóm đã rời', tracked: true, note: '', missing: true },
  ],
};

test('resolveTargets defaults to tracked groups that are still on Zalo, in config order', () => {
  assert.deepEqual(resolveTargets(CONFIG).map(g => g.convId), ['g1', 'g2']);
  assert.deepEqual(resolveTargets(CONFIG, []).map(g => g.convId), ['g1', 'g2']);
  assert.equal(resolveTargets(CONFIG)[0].name, '☀️ Future Energy Vietnam 🇻🇳');
});

test('resolveTargets with explicit ids takes exactly those, tracked or not, and refuses unknown or missing ones', () => {
  assert.deepEqual(resolveTargets(CONFIG, ['g3', 'g1']).map(g => g.convId), ['g3', 'g1']);
  assert.deepEqual(resolveTargets(CONFIG, ['g1', 'g1']).map(g => g.convId), ['g1'], 'a repeated id is read once');
  assert.throws(() => resolveTargets(CONFIG, ['g1', 'g999']), err => err instanceof SyncUsageError && /g999/.test(err.message));
  assert.throws(() => resolveTargets(CONFIG, ['g4']), err => err instanceof SyncUsageError && /g4/.test(err.message) && /không còn/.test(err.message));
});

test('formatGroupLine and formatTotalLine are Vietnamese, with dotted thousands', () => {
  const name = '☀️ Future Energy Vietnam 🇻🇳';
  assert.equal(formatGroupLine({ ok: true, new: 12, updated: 1, errors: [] }, { name, stored: 2698 }),
    '☀️ Future Energy Vietnam 🇻🇳: +12 tin mới, 1 cập nhật (2.698 tin trên máy)');
  assert.equal(formatGroupLine({ ok: true, new: 0, updated: 0, errors: [{ msg_id: '1', error: 'x' }, { msg_id: '2', error: 'y' }] }, { name, stored: 5 }),
    '☀️ Future Energy Vietnam 🇻🇳: +0 tin mới, 0 cập nhật, 2 tin lỗi (5 tin trên máy)');
  assert.equal(formatGroupLine({ ok: false, error: 'mất kết nối' }, { name, stored: 5 }), `✗ ${name}: lỗi, chưa ghi gì cho nhóm này (mất kết nối)`);

  const total = formatTotalLine({ groups: 28, fetched: 20000, new: 12345, updated: 3, errors: 0, failedGroups: 0 }, { seconds: 41.6 });
  assert.match(total, /28 nhóm/);
  assert.match(total, /\+12\.345 tin mới/);
  assert.match(total, /3 cập nhật/);
  assert.match(total, /42 giây/);
  assert.match(formatTotalLine({ groups: 3, fetched: 0, new: 0, updated: 0, errors: 0, failedGroups: 1 }, { seconds: 1 }), /1 nhóm lỗi/);
});

// ---------------------------------------------------------------------------------------------------------------------
// zmi sync (command)
// ---------------------------------------------------------------------------------------------------------------------

/** Runs fn with console.log / console.error captured. */
async function captured(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'zmi-sync-'));
  return { dir, configPath: join(dir, 'config', 'groups.json'), dbPath: join(dir, 'data', 'zalo-mi.db'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeConfig(path, config) {
  fs.mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(config), 'utf8');
}

test('zmi sync prints one line per tracked group and a total, reads only tracked groups, then adds nothing the second time', async () => {
  const s = scratch();
  try {
    writeConfig(s.configPath, CONFIG);
    const bridge = fakeBridge({
      g1: [rawMsg({ msgId: 'a1', sendDttm: '1700000001000' }), rawMsg({ msgId: 'a2', sendDttm: '1700000002000' })],
      g2: [rawMsg({ msgId: 'b1', sendDttm: '1700000003000' })],
      g3: [rawMsg({ msgId: 'c1' })], g4: [rawMsg({ msgId: 'd1' })],
    });
    const open = async () => bridge;

    const first = await captured(() => syncCommand({ port: 9222, open, configPath: s.configPath, dbPath: s.dbPath }));
    assert.equal(first.code, 0);
    assert.deepEqual(bridge.calls.map(c => c.convId), ['g1', 'g2'], 'untracked and missing groups are not read');
    assert.equal(bridge.closed, true, 'the bridge is closed');
    assert.match(first.out, /☀️ Future Energy Vietnam 🇻🇳: \+2 tin mới, 0 cập nhật \(2 tin trên máy\)/);
    assert.match(first.out, /Gió ngoài khơi: \+1 tin mới, 0 cập nhật \(1 tin trên máy\)/);
    assert.match(first.out, /Tổng: 2 nhóm, \+3 tin mới/);

    const second = await captured(() => syncCommand({ port: 9222, open, configPath: s.configPath, dbPath: s.dbPath }));
    assert.equal(second.code, 0);
    assert.match(second.out, /Future Energy Vietnam 🇻🇳: \+0 tin mới/);
    assert.match(second.out, /Tổng: 2 nhóm, \+0 tin mới/);

    const db = openDb(s.dbPath);
    assert.equal(count(db, 'messages'), 3);
    assert.equal(count(db, 'sync_runs'), 2);
    db.close();
  } finally { s.cleanup(); }
});

test('zmi sync --groups reads just those groups, and --full reads everything', async () => {
  const s = scratch();
  try {
    writeConfig(s.configPath, CONFIG);
    const bridge = fakeBridge({ g1: [rawMsg({ msgId: 'a1' })], g3: [rawMsg({ msgId: 'c1' })] });
    const open = async () => bridge;
    const run = opts => captured(() => syncCommand({ port: 9222, open, configPath: s.configPath, dbPath: s.dbPath, ...opts }));

    assert.equal((await run({ groups: 'g3' })).code, 0);
    assert.deepEqual(bridge.calls.map(c => c.convId), ['g3']);

    bridge.calls.length = 0;
    await run({ groups: 'g1, g3' });
    assert.deepEqual(bridge.calls.map(c => c.opts), [{}, { fromTs: 1700000000000 - 3 * DAY }], 'g1 is new (backfill), g3 is already stored (incremental)');

    bridge.calls.length = 0;
    await run({ groups: 'g1,g3', full: true });
    assert.deepEqual(bridge.calls.map(c => c.opts), [{}, {}]);

    const bad = await run({ groups: 'g999' });
    assert.equal(bad.code, 2);
    assert.match(bad.err, /g999/);
  } finally { s.cleanup(); }
});

test('zmi sync without config/groups.json says to run zmi groups --refresh and never opens Zalo or the database', async () => {
  const s = scratch();
  try {
    let opened = false;
    const r = await captured(() => syncCommand({ port: 9222, open: async () => { opened = true; }, configPath: s.configPath, dbPath: s.dbPath }));
    assert.equal(r.code, 1);
    assert.match(r.err, /groups --refresh/);
    assert.equal(opened, false);
    assert.equal(existsSync(s.dbPath), false);
  } finally { s.cleanup(); }
});

test('zmi sync with no tracked group says so and does nothing', async () => {
  const s = scratch();
  try {
    writeConfig(s.configPath, { version: 1, groups: [{ convId: 'g3', name: 'Mua sắm', tracked: false, note: '' }] });
    let opened = false;
    const r = await captured(() => syncCommand({ port: 9222, open: async () => { opened = true; }, configPath: s.configPath, dbPath: s.dbPath }));
    assert.equal(r.code, 1);
    assert.match(r.err, /tracked/);
    assert.equal(opened, false);
    assert.equal(existsSync(s.dbPath), false);
  } finally { s.cleanup(); }
});

test('zmi sync with Zalo closed prints the "Zalo (MI)" guidance, exits 1 and leaves no database behind', async () => {
  const s = scratch();
  try {
    writeConfig(s.configPath, CONFIG);
    const open = async () => { throw new CdpError('PORT_CLOSED', 'Không kết nối được cổng debug 127.0.0.1:9222. Zalo chưa mở ở chế độ thu thập.'); };
    const r = await captured(() => syncCommand({ port: 9222, open, configPath: s.configPath, dbPath: s.dbPath }));
    assert.equal(r.code, 1);
    assert.match(r.err, /Zalo \(MI\)/);
    assert.equal(existsSync(s.dbPath), false, 'the database is neither created nor written');
  } finally { s.cleanup(); }
});

test('zmi sync exits 1 when a group failed, 0 when only single messages were bad', async () => {
  const s = scratch();
  try {
    writeConfig(s.configPath, CONFIG);
    const run = data => captured(() => syncCommand({ port: 9222, open: async () => fakeBridge(data), configPath: s.configPath, dbPath: s.dbPath }));

    const badRow = await run({ g1: [rawMsg({ msgId: 'a1' }), { msgType: 1 }], g2: [] });
    assert.equal(badRow.code, 0);
    assert.match(badRow.out, /1 tin lỗi/);

    const badGroup = await run({ g1: new Error('mất kết nối'), g2: [rawMsg({ msgId: 'b1' })] });
    assert.equal(badGroup.code, 1);
    assert.match(badGroup.out, /✗ ☀️ Future Energy Vietnam 🇻🇳: lỗi/);
    assert.match(badGroup.out, /Gió ngoài khơi: \+1 tin mới/);
  } finally { s.cleanup(); }
});
