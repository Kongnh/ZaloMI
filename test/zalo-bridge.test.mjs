import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readOnlyGuard, STORE_ALLOWLIST, COMPUTE_ALLOWLIST, computeGuard, isOwnImagePath, buildPageScript, createBridge } from '../lib/zalo-bridge.mjs';

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
// Observed live: Zalo's getAll never returns more than this many rows, whatever `limit` is asked.
const ENGINE_CAP = 10000;
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
      if (range === undefined) return rows.slice(0, Math.min(opts.limit ?? rows.length, ENGINE_CAP));
      assert.equal(opts.index, indexName, 'index name');
      assert.equal(opts.useLGKeyRange, true, 'useLGKeyRange');
      assert.equal(opts.direction, 'prev', 'direction');
      if (requirePartition) assert.equal(opts.partition, CONV, 'partition');
      let hits = rows.filter(r => cmpKey(keyOf(r), range.from) >= 0 && cmpKey(keyOf(r), range.to) <= 0);
      if (range.excludeTo) hits = hits.filter(r => cmpKey(keyOf(r), range.to) < 0);
      hits.sort((a, b) => cmpKey(keyOf(b), keyOf(a))); // stable: rows with an identical key keep their stored order
      return hits.slice(0, Math.min(opts.limit, ENGINE_CAP));
    },
    async count() { return rows.length; },
  };
  for (const m of WRITE_METHODS) store[m] = async () => { log.push({ store: storeName, method: m }); };
  return store;
}

function makeFakeZalo({ moduleId = 'fsN4', messages = [], groups = [], media = {}, withModule = true, withWebpack = true, features } = {}) {
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
  if (features) window.$zFeatures = features;
  const context = vm.createContext({ window, atob, btoa });
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

test('MODULE_NOT_FOUND tells the user what to do next, not only what went wrong', async () => {
  const { connection } = makeFakeZalo({ withModule: false });
  await assert.rejects(createBridge(connection), err => {
    assert.equal(err.code, 'MODULE_NOT_FOUND');
    assert.match(err.message, /Cách xử lý/);
    assert.match(err.message, /Zalo \(MI\)/, 'step: reopen Zalo through the collection shortcut');
    assert.match(err.message, /cập nhật công cụ zmi/, 'step: the tool itself needs an update when Zalo renamed its internals');
    return true;
  });
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
    { userId: 'g111', displayName: 'Nhóm A', totalMember: 12, isGroup: true, desc: 'Mô tả nhóm A', creatorId: 'ignored' },
    { userId: 'g222', displayName: 'Nhóm B', totalMember: 3, isGroup: true },
  ];
  const { connection, log } = makeFakeZalo({ groups });
  const bridge = await createBridge(connection);
  assert.deepEqual(await bridge.listGroups(), [
    { convId: 'g111', name: 'Nhóm A', description: 'Mô tả nhóm A', totalMember: 12, isGroup: true },
    { convId: 'g222', name: 'Nhóm B', description: null, totalMember: 3, isGroup: true },
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

test('getMessages treats rows with the same msgId as one message and still terminates', async () => {
  const dup = i => msg(1, { cliMsgId: `c${i}` }); // identical (convId, sendDttm, msgId) tuple
  const { connection, log } = makeFakeZalo({ messages: [dup(1), dup(2), dup(3)] });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 2 });
  assert.equal(got.length, 1);
  assert.ok(log.filter(e => e.store === 'Core.Message').length <= 4, 'terminates quickly');
});

test('getMessages is gapless when equal sendDttm values with distinct msgIds straddle page boundaries', async () => {
  const tied = i => msg(3, { sendDttm: '1700000005500', msgId: String(5000100 + i), message: `tie${i}` });
  const rows = [msg(1), msg(2), tied(1), tied(2), tied(3), tied(4), tied(5), msg(9), msg(10)];
  const newestFirst = [...rows].sort((a, b) => cmpKey([b.sendDttm, b.msgId], [a.sendDttm, a.msgId]));
  for (const limit of [2, 3, 4, 5]) {
    const { connection } = makeFakeZalo({ messages: rows });
    const bridge = await createBridge(connection);
    const got = await bridge.getMessages(CONV, { limit });
    assert.deepEqual(got.map(m => m.msgId), newestFirst.map(m => m.msgId), `limit ${limit}: every row, newest first, none lost`);
  }
});

test('getMessages with limit 1 returns every message instead of stopping after one', async () => {
  const rows = Array.from({ length: 6 }, (_, i) => msg(i + 1));
  const { connection } = makeFakeZalo({ messages: rows });
  const bridge = await createBridge(connection);
  const got = await bridge.getMessages(CONV, { limit: 1 });
  assert.deepEqual(got.map(m => m.message), ['m6', 'm5', 'm4', 'm3', 'm2', 'm1']);
});

test('getMessages and getMediaRows reject a limit that would silently truncate', async () => {
  const { connection, log } = makeFakeZalo({ messages: [msg(1)] });
  const bridge = await createBridge(connection);
  for (const limit of [0, -1, 1.5, NaN, Infinity, '5', null, ENGINE_CAP + 1, 20000]) {
    await assert.rejects(bridge.getMessages(CONV, { limit }), RangeError, `getMessages limit ${String(limit)}`);
    await assert.rejects(bridge.getMediaRows(CONV, 'File', { limit }), RangeError, `getMediaRows limit ${String(limit)}`);
  }
  for (const maxPages of [0, -1, 1.5, NaN, '2']) {
    await assert.rejects(bridge.getMessages(CONV, { maxPages }), RangeError, `maxPages ${String(maxPages)}`);
  }
  assert.deepEqual(log.filter(e => e.method === 'getAll'), [], 'invalid options fail before any read');
  assert.equal((await bridge.getMessages(CONV, { limit: ENGINE_CAP })).length, 1, 'the cap itself is a valid limit');
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

test('getMediaRows returns more rows than Zalo hands out in one read by paging', async () => {
  const mine = Array.from({ length: ENGINE_CAP + 2000 }, (_, i) => mediaRow(CONV, i + 1));
  const { connection, log } = makeFakeZalo({ media: { Image: mine } });
  const bridge = await createBridge(connection);
  const rows = await bridge.getMediaRows(CONV, 'Image');
  assert.equal(rows.length, ENGINE_CAP + 2000);
  assert.equal(new Set(rows.map(r => r.mediaId)).size, ENGINE_CAP + 2000);
  assert.ok(log.filter(e => e.store === 'Media.Image').length >= 6);
});

// Media indexes are not unique: several rows (e.g. the files of one message) can share
// (convId, sendDttm, cliMsgId) and differ only by mediaId.
function tiedMediaRows(count, { sendDttm = 1700000005500, cliMsgId = '7000500' } = {}) {
  return Array.from({ length: count }, (_, i) => ({ mediaId: `tie-${sendDttm}-${i + 1}`, convId: CONV, cliMsgId, sendDttm, type: 1 }));
}
const mediaIdsSorted = rows => rows.map(r => r.mediaId).sort();

test('getMediaRows is gapless when rows with an identical index key straddle a page boundary', async () => {
  const rows = [...[1, 2].map(n => mediaRow(CONV, n)), ...tiedMediaRows(3), ...[9, 10].map(n => mediaRow(CONV, n))];
  const { connection } = makeFakeZalo({ media: { File: rows } });
  const bridge = await createBridge(connection);
  for (const limit of [4, 5]) {
    const got = await bridge.getMediaRows(CONV, 'File', { limit });
    assert.deepEqual(mediaIdsSorted(got), mediaIdsSorted(rows), `limit ${limit}: every row, none lost, none duplicated`);
    assert.deepEqual(got.map(r => r.sendDttm), got.map(r => r.sendDttm).sort((a, b) => b - a), 'newest first');
  }
});

test('getMediaRows is gapless even when more rows share one key than fit in a page', async () => {
  const rows = [mediaRow(CONV, 1), ...tiedMediaRows(5), mediaRow(CONV, 10)];
  for (const limit of [1, 2, 3]) {
    const { connection } = makeFakeZalo({ media: { Link: rows } });
    const bridge = await createBridge(connection);
    const got = await bridge.getMediaRows(CONV, 'Link', { limit });
    assert.deepEqual(mediaIdsSorted(got), mediaIdsSorted(rows), `limit ${limit}: the page widens until the tie group fits`);
  }
});

test('getMediaRows fails loudly when one key is shared by more rows than Zalo can return in one read', async () => {
  const rows = [mediaRow(CONV, 1), ...tiedMediaRows(ENGINE_CAP + 1)];
  const { connection } = makeFakeZalo({ media: { Image: rows } });
  const bridge = await createBridge(connection);
  await assert.rejects(bridge.getMediaRows(CONV, 'Image'), err => err.code === 'PAGINATION_STUCK' && /Zalo/.test(err.message));
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

// ---------------------------------------------------------------------------
// Pure-compute calls (ruling R2): Zalo's JXL decoder and OCR, through a separate allowlist
// ---------------------------------------------------------------------------

/** Fake $zFeatures: every function records its call; only the allowlisted ones may ever run. */
function fakeFeatures(log, { ocrResult } = {}) {
  const rec = (name, fn) => (...args) => { log.push(name); return fn(...args); };
  return {
    libjxl: {
      // Real shape: Uint8Array in, { status_code: 1, data: Uint8Array } out. The fake "decodes" by prefixing a JPEG marker.
      decodeToJpeg: rec('libjxl.decodeToJpeg', async (bytes, quality) => ({ status_code: 1, data: new Uint8Array([0xff, 0xd8, quality, ...bytes]) })),
      encodeJxl: rec('libjxl.encodeJxl', async () => ({})),
      getJxlInfo: rec('libjxl.getJxlInfo', async () => ({})),
    },
    ocr: {
      recognize: rec('ocr.recognize', async path => ocrResult ?? {
        success: true,
        result: { engineId: 'x', lines: [{ text: `đọc ${path}`, scores: { detection: 0.9, recognition: 0.97 }, words: [], quad: {} }] },
      }),
      isSupported: rec('ocr.isSupported', async () => ({ supported: true })),
      prewarm: rec('ocr.prewarm', async () => {}),
    },
    zaloCall: { call: rec('zaloCall.call', async () => {}) },
  };
}

test('the compute allowlist is exactly the JXL decoder and OCR, and the store allowlist is unchanged', () => {
  assert.deepEqual([...COMPUTE_ALLOWLIST].sort(), ['libjxl.decodeToJpeg', 'ocr.isSupported', 'ocr.recognize']);
  assert.deepEqual([...STORE_ALLOWLIST].sort(), ['count', 'get', 'getAll', 'getMulti']);
  for (const name of COMPUTE_ALLOWLIST) assert.throws(() => readOnlyGuard(name), 'a compute name is never a store method');
  for (const name of STORE_ALLOWLIST) assert.throws(() => computeGuard(name), 'a store method is never a compute call');
});

test('computeGuard rejects every other Zalo function name', () => {
  for (const name of ['libjxl.encodeJxl', 'libjxl.getJxlInfo', 'ocr.prewarm', 'zaloCall.call', 'syncDownload.start', 'libjxl', 'ocr',
    'ocr.recognize ', 'OCR.recognize', '__proto__', '', undefined, null, 7, ['ocr.recognize']]) {
    assert.throws(() => computeGuard(name), Error, `${String(name)} must be rejected`);
  }
  for (const name of COMPUTE_ALLOWLIST) assert.doesNotThrow(() => computeGuard(name));
});

test('isOwnImagePath accepts our own absolute files and refuses Zalo data folders and relative paths', () => {
  assert.equal(isOwnImagePath(String.raw`C:\Users\x\repo\data\images\.tmp\1.jpg`), true);
  assert.equal(isOwnImagePath('/tmp/zmi/1.jpg'), true);
  for (const p of [String.raw`C:\Users\x\AppData\Roaming\ZaloData\media\1\a.jpg`, 'C:/Users/x/AppData/Local/ZaloPC/1/ZaloDownloads/a.jpg',
    String.raw`data\images\1.jpg`, String.raw`..\x.jpg`, '', null, 3]) {
    assert.equal(isOwnImagePath(p), false, String(p));
  }
});

test('decodeJxl sends bytes in and gets JPEG bytes out through libjxl.decodeToJpeg only', async () => {
  const log = [];
  const { connection } = makeFakeZalo({ features: fakeFeatures(log) });
  const bridge = await createBridge(connection);
  const out = await bridge.decodeJxl(Buffer.from([0xff, 0x0a, 1, 2, 3]), { quality: 90 });
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual([...out], [0xff, 0xd8, 90, 0xff, 0x0a, 1, 2, 3]);
  assert.deepEqual(log, ['libjxl.decodeToJpeg']);
});

test('decodeJxl fails when Zalo reports a decode error status', async () => {
  const log = [];
  const features = fakeFeatures(log);
  features.libjxl.decodeToJpeg = async () => ({ status_code: 2002 });
  const { connection } = makeFakeZalo({ features });
  const bridge = await createBridge(connection);
  await assert.rejects(bridge.decodeJxl(Buffer.from([0xff, 0x0a])), /JXL/);
});

test('recognizeText returns the OCR lines (text + recognition score) for our own file', async () => {
  const log = [];
  const { connection } = makeFakeZalo({ features: fakeFeatures(log) });
  const bridge = await createBridge(connection);
  const own = String.raw`C:\repo\data\images\.tmp\5.jpg`;
  const result = await bridge.recognizeText(own);
  assert.deepEqual(result, { lines: [{ text: `đọc ${own}`, recognition: 0.97 }] });
  assert.deepEqual(await bridge.ocrSupported(), { supported: true });
  assert.deepEqual(log, ['ocr.recognize', 'ocr.isSupported']);
});

test('recognizeText refuses a path inside Zalo data on both sides, and an OCR failure becomes an error', async () => {
  const log = [];
  const { connection } = makeFakeZalo({ features: fakeFeatures(log, { ocrResult: { success: false, error: { message: 'Failed to decode image', code: 102 } } }) });
  const bridge = await createBridge(connection);
  await assert.rejects(bridge.recognizeText(String.raw`C:\Users\x\AppData\Roaming\ZaloData\media\1\a.jpg`), /Zalo/);
  // The page refuses it too, even when the Node side is bypassed.
  const zaloPath = JSON.stringify(String.raw`C:\x\ZaloData\a.jpg`);
  await assert.rejects(connection.evaluate(`window.__zmi.compute("ocr.recognize", [${zaloPath}])`), /Zalo/);
  assert.deepEqual(log, [], 'OCR never ran on a Zalo path');
  await assert.rejects(bridge.recognizeText(String.raw`C:\repo\data\images\.tmp\5.jpg`), /Failed to decode image/);
});

test('a Zalo build without the decoder or OCR says so and what to do, instead of a bare TypeError', async () => {
  const { connection } = makeFakeZalo({ features: {} });
  const bridge = await createBridge(connection);
  await assert.rejects(bridge.ocrSupported(), /không có OCR.*cập nhật/s);
  await assert.rejects(bridge.recognizeText(String.raw`C:\repo\data\images\.tmp\5.jpg`), /không có OCR.*cập nhật/s);
  await assert.rejects(bridge.decodeJxl(Buffer.from([0xff, 0x0a])), /không có bộ giải mã JXL.*cập nhật/s);
});

test('page-side compute refuses names outside the compute allowlist and never reaches them', async () => {
  const log = [];
  const { connection } = makeFakeZalo({ features: fakeFeatures(log) });
  await createBridge(connection);
  for (const name of ['libjxl.encodeJxl', 'ocr.prewarm', 'zaloCall.call', 'getAll']) {
    await assert.rejects(connection.evaluate(`window.__zmi.compute(${JSON.stringify(name)}, [])`), /chỉ cho phép/);
  }
  assert.deepEqual(log, []);
  assert.ok(buildPageScript().includes(JSON.stringify(COMPUTE_ALLOWLIST)), 'compute allowlist literal is embedded in the page script');
});
