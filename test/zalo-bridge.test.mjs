import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readOnlyGuard, STORE_ALLOWLIST, buildPageScript, createBridge } from '../lib/zalo-bridge.mjs';

// ---------------------------------------------------------------------------
// readOnlyGuard (pure, no Zalo needed)
// ---------------------------------------------------------------------------

test('readOnlyGuard rejects write methods', () => {
  for (const name of ['insert', 'put', 'update', 'delete']) {
    assert.throws(() => readOnlyGuard(name), Error, `${name} must be rejected`);
  }
  for (const name of ['getAll', 'get', 'count']) {
    assert.doesNotThrow(() => readOnlyGuard(name), `${name} must be allowed`);
  }
});

test('readOnlyGuard allows exactly getAll/get/getMulti/count', () => {
  assert.deepEqual([...STORE_ALLOWLIST].sort(), ['count', 'get', 'getAll', 'getMulti']);
  assert.doesNotThrow(() => readOnlyGuard('getMulti'));
});

test('readOnlyGuard rejects every other store method and malformed names', () => {
  const bad = ['remove', 'findAndDelete', 'getAndUpdate', 'insertMulti', 'updateMulti', 'deleteMulti', 'clear',
    'getAllKey', 'getMultiIfExists', 'GETALL', 'getall', ' getAll', 'getAll ', '', undefined, null, 42, ['getAll'], {}];
  for (const name of bad) {
    assert.throws(() => readOnlyGuard(name), Error, `${String(name)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Fake Zalo page: runs the real injected page script inside a vm context that
// mimics the webpack runtime + DB manager, so the bridge is exercised without Zalo.
// ---------------------------------------------------------------------------

const CONV = 'g1000000000000000001';
const WRITE_METHODS = ['insert', 'put', 'update', 'delete', 'remove', 'findAndDelete', 'getAndUpdate', 'insertMulti', 'updateMulti', 'deleteMulti', 'clear'];

// Compares index keys the way the real engine does for our fixtures (all strings of comparable shape).
function cmpKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = String(a[i] ?? ''), y = String(b[i] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// Objects created inside the vm context belong to another realm; plain copies compare with deepStrictEqual.
const plain = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function makeIndexedStore({ rows, keyOf, indexName, log, storeName, requirePartition }) {
  const store = {
    async getAll(range, opts = {}) {
      log.push({ store: storeName, method: 'getAll', range: plain(range), opts: plain(opts) });
      if (range === undefined) return rows.slice(0, opts.limit ?? rows.length);
      assert.equal(opts.index, indexName, 'index name');
      assert.equal(opts.useLGKeyRange, true, 'useLGKeyRange');
      assert.equal(opts.direction, 'prev', 'direction');
      if (requirePartition) assert.equal(opts.partition, CONV, 'partition');
      let hits = rows.filter(r => cmpKey(keyOf(r), range.from) >= 0 && cmpKey(keyOf(r), range.to) <= 0);
      if (range.excludeTo) hits = hits.filter(r => cmpKey(keyOf(r), range.to) < 0);
      hits.sort((a, b) => cmpKey(keyOf(b), keyOf(a)));
      return hits.slice(0, opts.limit);
    },
    async count() { return rows.length; },
  };
  for (const m of WRITE_METHODS) store[m] = async () => { log.push({ store: storeName, method: m }); };
  return store;
}

function makeFakeZalo({ moduleId = 'fsN4', messages = [], groups = [], media = {}, withModule = true, withWebpack = true } = {}) {
  const log = [];
  const instance = {
    Core: {
      Message: makeIndexedStore({
        rows: messages, keyOf: m => [m.userId, m.sendDttm, m.msgId], indexName: 'userId_sendDttm_msgId',
        log, storeName: 'Core.Message', requirePartition: true,
      }),
      Group: makeIndexedStore({ rows: groups, keyOf: () => [], indexName: '-', log, storeName: 'Core.Group' }),
    },
    Media: Object.fromEntries(['File', 'Link', 'Image'].map(s => [s, makeIndexedStore({
      rows: media[s] ?? [], keyOf: r => [r.convId, r.sendDttm, r.cliMsgId], indexName: 'convId_sendDttm_cliMsgId',
      log, storeName: `Media.${s}`,
    })])),
  };
  const cache = {
    noise1: { exports: {} },
    noise2: { exports: { default: { getInstance: () => ({ somethingElse: true }) } } },
    noise3: { exports: { default: { getInstance() { throw new Error('boom'); } } } },
    noise4: null,
  };
  if (withModule) cache[moduleId] = { exports: { default: { getInstance: () => instance } } };
  const req = Object.assign(() => { throw new Error('webpack require must not load new modules'); }, { c: cache });
  const window = withWebpack
    ? { webpackJsonp: { push([ids, modules]) { modules[ids[0]](null, null, req); } } }
    : {};
  const context = vm.createContext({ window });
  const connection = {
    // Mirrors Runtime.evaluate with returnByValue: result is a JSON round trip, promises are awaited.
    async evaluate(expression) {
      const value = await vm.runInContext(expression, context);
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    close() {},
  };
  return { connection, log, window };
}

function msg(n, extra = {}) {
  // n = 1..N, ascending in time. Ids/timestamps are strings, like the real store.
  return { userId: CONV, msgId: String(5000000 + n), sendDttm: String(1700000000000 + n * 1000), msgType: 'webchat', message: `m${n}`, ...extra };
}

const writes = log => log.filter(e => WRITE_METHODS.includes(e.method));

// ---------------------------------------------------------------------------
// Locating the DB manager
// ---------------------------------------------------------------------------

test('finds the DB manager through the fast path when the known module id exists', async () => {
  const { connection } = makeFakeZalo({ moduleId: 'fsN4' });
  const bridge = await createBridge(connection);
  assert.equal(bridge.info.via, 'fast-path');
  assert.equal(bridge.info.moduleId, 'fsN4');
});

test('falls back to the shape search when the module was renamed', async () => {
  const { connection } = makeFakeZalo({ moduleId: 'zQ9x' });
  const bridge = await createBridge(connection);
  assert.equal(bridge.info.via, 'shape-search');
  assert.equal(bridge.info.moduleId, 'zQ9x');
});

test('locate({fastPath:false}) forces the shape search even when the known id exists', async () => {
  const { connection } = makeFakeZalo({ moduleId: 'fsN4' });
  const bridge = await createBridge(connection);
  const found = await bridge.locate({ fastPath: false });
  assert.deepEqual(found, { moduleId: 'fsN4', via: 'shape-search' });
});

test('createBridge fails with MODULE_NOT_FOUND when no module has the DB manager shape', async () => {
  const { connection } = makeFakeZalo({ withModule: false });
  await assert.rejects(createBridge(connection), err => err.code === 'MODULE_NOT_FOUND' && /Zalo/.test(err.message));
});

test('createBridge fails with MODULE_NOT_FOUND when the page has no webpack runtime', async () => {
  const { connection } = makeFakeZalo({ withWebpack: false });
  await assert.rejects(createBridge(connection), err => err.code === 'MODULE_NOT_FOUND');
});

// ---------------------------------------------------------------------------
// Read-only enforcement inside the page
// ---------------------------------------------------------------------------

test('page-side reader is generated from the same allowlist', () => {
  const script = buildPageScript();
  assert.ok(script.includes(JSON.stringify(STORE_ALLOWLIST)), 'allowlist literal is embedded in the page script');
});

test('page-side reader refuses write methods and never reaches the store', async () => {
  const { connection, log } = makeFakeZalo();
  await createBridge(connection);
  for (const method of WRITE_METHODS) {
    await assert.rejects(
      connection.evaluate(`window.__zmi.read('Core', 'Message', ${JSON.stringify(method)}, [{}])`),
      err => /chỉ đọc/.test(err.message),
      `${method} must be refused in the page`,
    );
  }
  assert.deepEqual(writes(log), []);
});

test('page-side reader refuses unsafe db/store names', async () => {
  const { connection } = makeFakeZalo();
  await createBridge(connection);
  for (const [db, store] of [['constructor', 'Message'], ['Core', '__proto__'], ['Core', 'Nope'], ['core', 'Message']]) {
    await assert.rejects(connection.evaluate(`window.__zmi.read(${JSON.stringify(db)}, ${JSON.stringify(store)}, 'getAll', [])`));
  }
});

// ---------------------------------------------------------------------------
// listGroups
// ---------------------------------------------------------------------------

test('listGroups maps the Group store rows', async () => {
  const groups = [
    { userId: 'g111', displayName: 'Nhóm A', totalMember: 12, isGroup: true, desc: 'ignored' },
    { userId: 'g222', displayName: 'Nhóm B', totalMember: 3, isGroup: true },
  ];
  const { connection, log } = makeFakeZalo({ groups });
  const bridge = await createBridge(connection);
  assert.deepEqual(await bridge.listGroups(), [
    { convId: 'g111', name: 'Nhóm A', totalMember: 12, isGroup: true },
    { convId: 'g222', name: 'Nhóm B', totalMember: 3, isGroup: true },
  ]);
  const call = log.find(e => e.store === 'Core.Group');
  assert.equal(call.range, undefined, 'Group.getAll(undefined, ...) gets a real undefined, not null');
  assert.equal(call.opts.limit, 500);
});

// ---------------------------------------------------------------------------
// getMessages
// ---------------------------------------------------------------------------

test('getMessages uses the exact range/index/partition values of the spike query', async () => {
  const { connection, log } = makeFakeZalo({ messages: [msg(1), msg(2)] });
  const bridge = await createBridge(connection);
  await bridge.getMessages(CONV);
  const first = log.find(e => e.store === 'Core.Message');
  assert.deepEqual(first.range, {
    from: [CONV, '', ''],
    to: [CONV, '9999999999999999', '9223372036854775808'],
    excludeFrom: false,
    excludeTo: false,
  });
  assert.deepEqual(first.opts, {
    index: 'userId_sendDttm_msgId', limit: 2000, direction: 'prev', partition: CONV, useLGKeyRange: true,
  });
});

test('getMessages returns raw messages newest first and pages until a short page', async () => {
  const all = Array.from({ length: 11 }, (_, i) => msg(i + 1));
  const { connection, log } = makeFakeZalo({ messages: all });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 4 });
  assert.deepEqual(got, [...all].reverse(), 'raw rows, newest first, no gaps or duplicates');
  assert.ok(log.filter(e => e.store === 'Core.Message').length >= 3, 'several pages were needed');
  assert.deepEqual(writes(log), []);
});

test('getMessages stops after one page when the page is not full', async () => {
  const all = [msg(1), msg(2), msg(3)];
  const { connection, log } = makeFakeZalo({ messages: all });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 10 });
  assert.equal(got.length, 3);
  assert.equal(log.filter(e => e.store === 'Core.Message').length, 1);
});

test('getMessages does not loop forever when many rows share the same index key', async () => {
  const dup = i => msg(1, { cliMsgId: `c${i}` }); // identical (convId, sendDttm, msgId) tuple
  const { connection, log } = makeFakeZalo({ messages: [dup(1), dup(2), dup(3)] });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 2 });
  assert.ok(got.length >= 1);
  assert.ok(log.filter(e => e.store === 'Core.Message').length <= 3, 'terminates quickly');
});

test('getMessages honours fromTs as an inclusive lower bound', async () => {
  const all = Array.from({ length: 10 }, (_, i) => msg(i + 1));
  const { connection } = makeFakeZalo({ messages: all });
  const bridge = await createBridge(connection);
  const fromTs = all[6].sendDttm; // msg(7)
  const got = await bridge.getMessages(CONV, { fromTs, limit: 2 });
  assert.deepEqual(got.map(m => m.message), ['m10', 'm9', 'm8', 'm7']);
  const gotNumeric = await bridge.getMessages(CONV, { fromTs: Number(fromTs), limit: 2 });
  assert.deepEqual(gotNumeric.map(m => m.message), ['m10', 'm9', 'm8', 'm7'], 'numeric fromTs works too');
});

test('getMessages can be capped to a single page (used by doctor to peek one message)', async () => {
  const all = Array.from({ length: 5 }, (_, i) => msg(i + 1));
  const { connection, log } = makeFakeZalo({ messages: all });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 1, maxPages: 1 });
  assert.deepEqual(got.map(m => m.message), ['m5']);
  assert.equal(log.filter(e => e.store === 'Core.Message').length, 1);
});

// ---------------------------------------------------------------------------
// getMediaRows
// ---------------------------------------------------------------------------

function mediaRow(convId, n) {
  return { mediaId: `${convId}-${n}`, convId, cliMsgId: String(7000000 + n), sendDttm: 1700000000000 + n * 1000, type: 1 };
}

test('getMediaRows returns only the rows of the conversation, using the convId index', async () => {
  const mine = Array.from({ length: 3 }, (_, i) => mediaRow(CONV, i + 1));
  const other = Array.from({ length: 2 }, (_, i) => mediaRow('g999', i + 1));
  const { connection, log } = makeFakeZalo({ media: { File: [...other, ...mine], Link: other, Image: [] } });
  const bridge = await createBridge(connection);
  const files = await bridge.getMediaRows(CONV, 'File');
  assert.deepEqual(files.map(r => r.mediaId), mine.map(r => r.mediaId).reverse());
  assert.deepEqual(await bridge.getMediaRows(CONV, 'Link'), []);
  assert.deepEqual(await bridge.getMediaRows(CONV, 'Image'), []);
  const call = log.find(e => e.store === 'Media.File');
  assert.equal(call.opts.index, 'convId_sendDttm_cliMsgId');
  assert.deepEqual(call.range.from, [CONV, '', '']);
  assert.deepEqual(writes(log), []);
});

test('getMediaRows pages past the engine cap instead of scanning the whole store', async () => {
  const mine = Array.from({ length: 4500 }, (_, i) => mediaRow(CONV, i + 1));
  const { connection, log } = makeFakeZalo({ media: { Image: mine } });
  const bridge = await createBridge(connection);
  const rows = await bridge.getMediaRows(CONV, 'Image');
  assert.equal(rows.length, 4500);
  assert.equal(new Set(rows.map(r => r.mediaId)).size, 4500);
  assert.ok(log.filter(e => e.store === 'Media.Image').length >= 3);
});

test('getMediaRows rejects unknown stores', async () => {
  const { connection } = makeFakeZalo();
  const bridge = await createBridge(connection);
  for (const store of ['Message', 'insert', 'file', undefined, '__proto__']) {
    await assert.rejects(bridge.getMediaRows(CONV, store), /File|Link|Image/);
  }
});

test('Bridge exposes readOnlyGuard and refuses non-allowlisted calls before any round trip', async () => {
  const { connection } = makeFakeZalo();
  const bridge = await createBridge(connection);
  assert.equal(bridge.readOnlyGuard, readOnlyGuard);
  assert.throws(() => bridge.readOnlyGuard('insert'));
});
