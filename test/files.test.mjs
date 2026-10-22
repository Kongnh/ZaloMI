import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  remapLocalPath, sanitizeFileName, fileDate, skipReason, pickMediaRow, resolveFile, resolveFiles, formatFilesSummary, filesStatusLine,
  MAX_FILE_BYTES,
} from '../lib/files.mjs';
import { openDb } from '../lib/db.mjs';
import { syncCommand, filesCommand } from '../zmi.mjs';
import { CdpError } from '../lib/cdp.mjs';
import { guardedFetch, isPrivateAddress } from '../lib/net.mjs';

// No test touches the internet or the real data/ folder: downloads go to a local http server, files to a temp root.
// The download guard refuses 127.0.0.1 by design, so the tests reach their local server through localFetch, a guarded fetch
// whose policy lets that one loopback address through (every other private address is still refused).
const localFetch = (url, init) => guardedFetch(url, { ...init, refuse: address => address !== '127.0.0.1' && isPrivateAddress(address) });

const md5 = buf => createHash('md5').update(buf).digest('hex');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 7)]);
const PDF2 = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000, 9)]);
const PDF_SAME_SIZE = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(PDF.length - 9, 9)]); // same length as PDF, different bytes
const TS = Date.UTC(2026, 9, 21, 18, 0, 0); // 2026-10-22 01:00 in UTC+7
const APPDATA = 'C:\\Users\\x\\AppData\\Roaming';

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'zmi-files-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** A local http server. `handler(req, res)` answers; `hits` lists every requested url. */
async function server(handler) {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); handler(req, res); });
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    hits,
    close: () => new Promise(resolve => { srv.closeAllConnections(); srv.close(resolve); }),
  };
}

/** Serves `routes[url] = { status?, type?, body }`; anything else is a 404. */
const routeServer = routes => server((req, res) => {
  const r = routes[req.url];
  if (!r) { res.writeHead(404); res.end(); return; }
  res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/octet-stream' });
  res.end(r.body);
});

/** A files row as the DB holds it. */
const fileRow = (over = {}) => ({
  msg_id: '9001', conv_id: 'g1', ts: TS, file_name: 'Báo cáo.pdf', ext: 'pdf', size: PDF.length, checksum: md5(PDF), remote_url: null, ...over,
});

/** Inserts a message and its files row, the way sync would. */
function seed(db, over = {}) {
  const row = fileRow(over);
  db.upsertMessage({
    msg_id: row.msg_id, conv_id: row.conv_id, cli_msg_id: over.cli_msg_id ?? `cli${row.msg_id}`, ts: row.ts, from_uid: over.from_uid ?? 'u1',
    kind: 'file', msg_type: '19', raw_json: JSON.stringify(over.raw ?? {}),
  });
  db.upsertFile({ msg_id: row.msg_id, conv_id: row.conv_id, ts: row.ts, sender_name: 'A', file_name: row.file_name, ext: row.ext, size: row.size, checksum: row.checksum, remote_url: row.remote_url });
  return row;
}

const fileOf = (db, msgId) => ({ ...db.raw.prepare('SELECT * FROM files WHERE msg_id = ?').get(msgId) });
const statusOf = (db, msgId) => fileOf(db, msgId).status;
const filesIn = (root, conv = 'g1') => { const dir = join(root, 'data', 'files', conv); return existsSync(dir) ? readdirSync(dir).sort() : []; };
const writeLocal = (root, name, content) => { const p = join(root, 'src', name); mkdirSync(join(root, 'src'), { recursive: true }); writeFileSync(p, content); return p; };
// The real drive may be nearly full: the disk guard is tested with explicit statfs fakes, every other test has plenty of room.
const plenty = async () => ({ bsize: 1, bavail: 1e12 });
const base = (root, extra = {}) => ({ rootDir: root, appData: APPDATA, fetchFn: localFetch, statfs: plenty, ...extra });

// ---------------------------------------------------------------------------------------------------------------------
// remapLocalPath
// ---------------------------------------------------------------------------------------------------------------------

test('remapLocalPath converts old ZaloPC root', () => {
  const want = 'C:\\Users\\x\\AppData\\Roaming\\ZaloData\\media\\1498602681856850483\\ZaloDownloads\\file\\a b.pdf';
  assert.equal(remapLocalPath('C:\\Users\\x\\AppData\\Local\\ZaloPC\\1498602681856850483\\ZaloDownloads\\file\\a b.pdf', { appData: APPDATA }), want);
  assert.equal(remapLocalPath('C:/Users/x/AppData/Local/ZaloPC/1498602681856850483/ZaloDownloads/file/a b.pdf', { appData: APPDATA }), want, 'forward slashes');
  assert.equal(remapLocalPath('D:\\zalopc\\1498602681856850483\\zalodownloads\\file\\a b.pdf', { appData: APPDATA }), want, 'any root, any letter case');
  assert.equal(remapLocalPath('C:\\Users\\x\\Downloads\\a.pdf', { appData: APPDATA }), 'C:\\Users\\x\\Downloads\\a.pdf', 'other paths unchanged');
  assert.equal(remapLocalPath('C:\\Users\\x\\ZaloData\\media\\1\\ZaloDownloads\\a.pdf', { appData: APPDATA }), 'C:\\Users\\x\\ZaloData\\media\\1\\ZaloDownloads\\a.pdf', 'already new root: unchanged');
  assert.equal(remapLocalPath(null), null);
  assert.equal(remapLocalPath(undefined), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// resolveFile: a copy that is already on this PC
// ---------------------------------------------------------------------------------------------------------------------

test('resolveFile copies an existing local file and verifies md5', async () => {
  const s = scratch();
  try {
    const src = writeLocal(s.root, 'a.pdf', PDF);
    const result = await resolveFile(fileRow(), { rootDir: s.root, fetchFn: localFetch, localPaths: [src] });
    assert.equal(result.status, 'stored');
    assert.equal(result.source, 'local');
    assert.equal(result.stored_path, 'data/files/g1/2026-10-22_Báo cáo.pdf', 'date is UTC+7, path is relative to the repo root with forward slashes');
    assert.deepEqual(readFileSync(join(s.root, result.stored_path)), PDF);
    assert.ok(existsSync(src), 'the original is copied, never moved');
    assert.deepEqual(filesIn(s.root), ['2026-10-22_Báo cáo.pdf'], 'no temp file left behind');
  } finally { s.cleanup(); }
});

test('resolveFile does not trust a local file whose md5 differs, and falls back to the download', async () => {
  const s = scratch();
  const srv = await routeServer({ '/f': { type: 'application/pdf', body: PDF } });
  try {
    const wrong = writeLocal(s.root, 'wrong.pdf', PDF_SAME_SIZE);
    const noLink = await resolveFile(fileRow(), { rootDir: s.root, fetchFn: localFetch, localPaths: [wrong] });
    assert.equal(noLink.status, 'failed');
    assert.match(noLink.error, /checksum MD5 không khớp/);
    assert.match(noLink.error, /không có link tải/);
    assert.deepEqual(filesIn(s.root), [], 'nothing stored');

    const viaLink = await resolveFile(fileRow({ remote_url: `${srv.base}/f` }), { rootDir: s.root, fetchFn: localFetch, localPaths: [wrong] });
    assert.equal(viaLink.status, 'stored');
    assert.equal(viaLink.source, 'download');
    assert.deepEqual(readFileSync(join(s.root, viaLink.stored_path)), PDF);
  } finally { await srv.close(); s.cleanup(); }
});

test('resolveFile skips a local path that is a folder, or has the wrong size, without copying it', async () => {
  const s = scratch();
  try {
    mkdirSync(join(s.root, 'src', 'unpacked'), { recursive: true });
    const wrongSize = writeLocal(s.root, 'short.pdf', Buffer.from('%PDF-short'));
    const result = await resolveFile(fileRow(), { rootDir: s.root, fetchFn: localFetch, localPaths: [join(s.root, 'src', 'unpacked'), join(s.root, 'src', 'missing.pdf'), wrongSize] });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /kích thước khác/);
    assert.deepEqual(filesIn(s.root), []);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Which files are fetched
// ---------------------------------------------------------------------------------------------------------------------

test('only the wanted extensions up to 100 MB are fetched; the rest are skipped without any request', async () => {
  assert.equal(skipReason({ ext: 'pdf', size: 10 }), null);
  for (const ext of ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'zip', 'rar', 'jpg', 'jpeg', 'png']) {
    assert.equal(skipReason({ ext, size: 1 }), null, ext);
  }
  for (const ext of ['mp4', 'mov', 'm4a', 'mp3', 'flac', 'dsf', 'exe']) assert.equal(skipReason({ ext, size: 1 }), 'loại file không lưu', ext);
  assert.equal(skipReason({ ext: null, file_name: 'Bảng.XLSX', size: 1 }), null, 'extension falls back to the file name');
  assert.equal(skipReason({ ext: 'pdf', size: MAX_FILE_BYTES }), null, 'exactly 100 MB is still stored');
  assert.equal(skipReason({ ext: 'pdf', size: MAX_FILE_BYTES + 1 }), 'quá 100 MB');
  assert.equal(skipReason({ ext: 'mp4', size: MAX_FILE_BYTES + 1 }), 'loại file không lưu', 'the type decides first');

  const s = scratch();
  const srv = await routeServer({});
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', ext: 'mp4', file_name: 'VIDEO.mp4', size: 50, checksum: null, remote_url: `${srv.base}/v` });
    seed(db, { msg_id: '2', ext: 'pdf', file_name: 'big.pdf', size: MAX_FILE_BYTES + 1, checksum: null, remote_url: `${srv.base}/b` });
    const summary = await resolveFiles(db, base(s.root));
    assert.equal(summary.skipped, 2);
    assert.deepEqual(srv.hits, [], 'no request was made');
    assert.deepEqual([fileOf(db, '1').status, fileOf(db, '1').error], ['skipped', 'loại file không lưu']);
    assert.deepEqual([fileOf(db, '2').status, fileOf(db, '2').error], ['skipped', 'quá 100 MB']);
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

test('sanitizeFileName makes names safe for Windows and keeps the extension', () => {
  assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j.pdf'), 'abcdefghij.pdf', 'illegal characters are stripped');
  assert.equal(sanitizeFileName('tab\there\u0001.pdf'), 'tabhere.pdf', 'control characters are stripped');
  assert.equal(sanitizeFileName('  Báo cáo  .pdf. . '), 'Báo cáo  .pdf', 'trailing dots and spaces are trimmed, leading spaces too');
  assert.equal(sanitizeFileName('báo cáo điện.pdf'), 'báo cáo điện.pdf', 'Vietnamese is kept');
  assert.equal(sanitizeFileName(null), '');
  assert.equal(sanitizeFileName('???'), '');
  assert.equal(sanitizeFileName('CON.pdf'), '_CON.pdf', 'reserved device names are defused');

  const long = sanitizeFileName(`${'x'.repeat(300)}.xlsx`);
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('.xlsx'), 'the extension survives the cut');
  const emoji = sanitizeFileName(`${'😀'.repeat(100)}.pdf`);
  assert.ok(emoji.length <= 150 && emoji.endsWith('.pdf'));
  assert.doesNotMatch(emoji, /[\ud800-\udbff](?![\udc00-\udfff])/, 'no cut surrogate pair');

  assert.equal(fileDate(Date.UTC(2026, 9, 21, 16, 59, 59)), '2026-10-21');
  assert.equal(fileDate(Date.UTC(2026, 9, 21, 17, 0, 0)), '2026-10-22', 'UTC+7 midnight');
});

test('two different files with the same name and day get the msg_id suffix; the same file is stored once', async () => {
  const s = scratch();
  const srv = await routeServer({ '/a': { body: PDF }, '/b': { body: PDF2 }, '/c': { body: PDF } });
  try {
    const opts = { rootDir: s.root, fetchFn: localFetch };
    const a = await resolveFile(fileRow({ msg_id: '111', remote_url: `${srv.base}/a` }), opts);
    const b = await resolveFile(fileRow({ msg_id: '222', checksum: md5(PDF2), size: PDF2.length, remote_url: `${srv.base}/b` }), opts);
    const c = await resolveFile(fileRow({ msg_id: '333', remote_url: `${srv.base}/c` }), opts);
    assert.equal(a.stored_path, 'data/files/g1/2026-10-22_Báo cáo.pdf');
    assert.equal(b.stored_path, 'data/files/g1/2026-10-22_Báo cáo_222.pdf');
    assert.equal(c.stored_path, a.stored_path, 'identical content is not stored twice');
    assert.deepEqual(readFileSync(join(s.root, a.stored_path)), PDF, 'the first file was not overwritten');
    assert.deepEqual(filesIn(s.root), ['2026-10-22_Báo cáo.pdf', '2026-10-22_Báo cáo_222.pdf']);
  } finally { await srv.close(); s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------------------------------

test('resolveFile downloads a real file over HTTP (following a redirect) and verifies it', async () => {
  const s = scratch();
  const srv = await server((req, res) => {
    if (req.url === '/old') { res.writeHead(302, { location: '/new' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
    res.end(PDF);
  });
  try {
    const result = await resolveFile(fileRow({ remote_url: `${srv.base}/old` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(result.status, 'stored');
    assert.equal(result.source, 'download');
    assert.equal(result.bytes, PDF.length);
    assert.deepEqual(readFileSync(join(s.root, result.stored_path)), PDF);
    assert.deepEqual(srv.hits, ['/old', '/new']);
  } finally { await srv.close(); s.cleanup(); }
});

test('an HTML error page is rejected, not stored as the file', async () => {
  const s = scratch();
  const html = '<!DOCTYPE html><html><body>Hết hạn</body></html>';
  const srv = await routeServer({
    '/typed': { type: 'text/html; charset=utf-8', body: html },
    '/sneaky': { type: 'application/pdf', body: html },
    '/forbidden': { status: 403, type: 'text/html', body: html },
    '/bom': { type: 'application/pdf', body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('  <html><body>Hết hạn</body></html>')]) },
  });
  try {
    const typed = await resolveFile(fileRow({ remote_url: `${srv.base}/typed` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(typed.status, 'remote_only');
    assert.match(typed.error, /trang HTML/);

    const sneaky = await resolveFile(fileRow({ remote_url: `${srv.base}/sneaky` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(sneaky.status, 'remote_only', 'HTML under a pdf content-type is caught by its first bytes');

    const noChecksum = await resolveFile(fileRow({ checksum: null, size: null, remote_url: `${srv.base}/sneaky` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(noChecksum.status, 'remote_only');

    const bom = await resolveFile(fileRow({ checksum: null, size: null, remote_url: `${srv.base}/bom` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(bom.status, 'remote_only', 'a byte order mark and leading spaces do not hide the HTML');

    const forbidden = await resolveFile(fileRow({ remote_url: `${srv.base}/forbidden` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(forbidden.status, 'remote_only');
    assert.match(forbidden.error, /HTTP 403/);

    assert.deepEqual(filesIn(s.root), [], 'nothing stored, no temp file left');
  } finally { await srv.close(); s.cleanup(); }
});

test('HTTP errors and network errors are failed with the reason', async () => {
  const s = scratch();
  const srv = await routeServer({ '/bad': { status: 502, body: '' } });
  const dead = await routeServer({});
  const deadUrl = `${dead.base}/x`;
  await dead.close();
  try {
    const gone = await resolveFile(fileRow({ remote_url: `${srv.base}/nothing` }), { rootDir: s.root, fetchFn: localFetch });
    assert.deepEqual([gone.status, gone.error], ['failed', 'HTTP 404 (link đã hết hạn)']);
    const bad = await resolveFile(fileRow({ remote_url: `${srv.base}/bad` }), { rootDir: s.root, fetchFn: localFetch });
    assert.deepEqual([bad.status, bad.error], ['failed', 'HTTP 502']);
    const refused = await resolveFile(fileRow({ remote_url: deadUrl }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(refused.status, 'failed');
    assert.match(refused.error, /lỗi mạng \(ECONNREFUSED\)/);
    assert.deepEqual(filesIn(s.root), []);
  } finally { await srv.close(); s.cleanup(); }
});

test('a download that stalls times out as failed and leaves nothing behind', async () => {
  const s = scratch();
  const srv = await server(() => { /* never answers */ });
  try {
    const result = await resolveFile(fileRow({ remote_url: `${srv.base}/hang` }), { rootDir: s.root, fetchFn: localFetch, stallMs: 150 });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /quá thời gian chờ/);
    assert.deepEqual(filesIn(s.root), []);
  } finally { await srv.close(); s.cleanup(); }
});

test('a link that points at this PC (127.0.0.1, e.g. Zalo\'s debug port) is refused before any request, by the default download', async () => {
  const s = scratch();
  const srv = await routeServer({ '/json/list': { type: 'application/pdf', body: PDF } });
  try {
    const result = await resolveFile(fileRow({ remote_url: `${srv.base}/json/list` }), { rootDir: s.root });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /nội bộ 127\.0\.0\.1/);
    assert.deepEqual(srv.hits, [], 'the local server is never contacted');
    const named = await resolveFile(fileRow({ remote_url: 'http://localhost:9222/json/list' }), { rootDir: s.root });
    assert.match(named.error, /localhost/);
    assert.deepEqual(filesIn(s.root), []);
  } finally { await srv.close(); s.cleanup(); }
});

test('a download is checked against the advertised MD5, size and file signature', async () => {
  const s = scratch();
  const srv = await routeServer({ '/pdf2': { body: PDF2 }, '/text': { type: 'text/plain', body: 'Không phải PDF, đủ dài.' } });
  try {
    const wrongMd5 = await resolveFile(fileRow({ remote_url: `${srv.base}/pdf2` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(wrongMd5.status, 'failed');
    assert.match(wrongMd5.error, /checksum MD5 không khớp/);

    const wrongSize = await resolveFile(fileRow({ checksum: null, remote_url: `${srv.base}/pdf2` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(wrongSize.status, 'failed');
    assert.match(wrongSize.error, /kích thước/);

    const wrongMagic = await resolveFile(fileRow({ checksum: null, size: null, remote_url: `${srv.base}/text` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(wrongMagic.status, 'failed');
    assert.match(wrongMagic.error, /không phải file \.pdf/);

    const noChecksumOk = await resolveFile(fileRow({ checksum: null, size: PDF2.length, remote_url: `${srv.base}/pdf2` }), { rootDir: s.root, fetchFn: localFetch });
    assert.equal(noChecksumOk.status, 'stored', 'a real PDF of the advertised size passes without an MD5');
    assert.deepEqual(filesIn(s.root), ['2026-10-22_Báo cáo.pdf']);
  } finally { await srv.close(); s.cleanup(); }
});

test('a download larger than the limit is cut off while streaming and skipped', async () => {
  const s = scratch();
  const srv = await server((req, res) => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.write(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(5000)])); res.end(Buffer.alloc(5000)); });
  try {
    const result = await resolveFile(fileRow({ size: null, checksum: null, remote_url: `${srv.base}/big` }), { rootDir: s.root, fetchFn: localFetch, maxBytes: 4000 });
    assert.equal(result.status, 'skipped');
    assert.match(result.error, /^quá /);
    assert.deepEqual(filesIn(s.root), []);
  } finally { await srv.close(); s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// Media.File join
// ---------------------------------------------------------------------------------------------------------------------

test('pickMediaRow ties on cliMsgId are broken by sender, then by the nearest send time', () => {
  const rows = [
    { mediaId: 'a', cliMsgId: '100', fromUid: 'other', sendDttm: TS + 10 },
    { mediaId: 'b', cliMsgId: '100', fromUid: 'u1', sendDttm: TS + 90_000 },
    { mediaId: 'c', cliMsgId: '100', fromUid: 'u1', sendDttm: TS + 500 },
    { mediaId: 'd', cliMsgId: '101', fromUid: 'u1', sendDttm: TS },
  ];
  const msg = { cli_msg_id: '100', from_uid: 'u1', ts: TS };
  assert.equal(pickMediaRow(rows, msg).mediaId, 'c', 'same sender and nearest time wins');
  assert.equal(pickMediaRow(rows, { ...msg, from_uid: 'nobody' }).mediaId, 'a', 'no sender match: nearest time among the ties');
  assert.equal(pickMediaRow(rows, { ...msg, cli_msg_id: '101' }).mediaId, 'd', 'unique cliMsgId');
  assert.equal(pickMediaRow(rows, { ...msg, cli_msg_id: '999' }), null);
  assert.equal(pickMediaRow(rows, { ...msg, cli_msg_id: null }), null);
});

test('resolveFiles takes the file from the right Media.File row and reads Media.File once per group', async () => {
  const s = scratch();
  const db = openDb(':memory:');
  try {
    const right = writeLocal(s.root, 'right.pdf', PDF);
    const wrong = writeLocal(s.root, 'wrong.pdf', PDF2);
    // No checksum or size on the row, so the join alone decides which local file is taken.
    seed(db, { msg_id: '1', cli_msg_id: '100', from_uid: 'u1', checksum: null, size: null });
    const calls = [];
    const bridge = {
      async getMediaRows(convId, store) {
        calls.push([convId, store]);
        return [
          { mediaId: 'a', cliMsgId: '100', fromUid: 'other', sendDttm: TS + 5, localPath: wrong, folderPath: '' },
          { mediaId: 'b', cliMsgId: '100', fromUid: 'u1', sendDttm: TS + 20, localPath: right, folderPath: '' },
        ];
      },
    };
    const summary = await resolveFiles(db, base(s.root, { bridge }));
    assert.equal(summary.stored, 1);
    assert.equal(summary.mediaLookup, 'bridge');
    assert.deepEqual(calls, [['g1', 'File']]);
    assert.deepEqual(readFileSync(join(s.root, fileOf(db, '1').stored_path)), PDF);
  } finally { db.close(); s.cleanup(); }
});

test('a Media.File read that fails, or no bridge at all, does not stop the run', async () => {
  const s = scratch();
  const srv = await routeServer({ '/f': { body: PDF } });
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', remote_url: `${srv.base}/f` });
    const failing = await resolveFiles(db, base(s.root, { bridge: { async getMediaRows() { throw new Error('Zalo đóng'); } } }));
    assert.equal(failing.stored, 1);
    assert.equal(failing.mediaLookup, 'error');
    assert.equal(failing.mediaError, 'Zalo đóng');

    seed(db, { msg_id: '2', file_name: 'Hai.pdf', remote_url: `${srv.base}/f` });
    const without = await resolveFiles(db, base(s.root));
    assert.equal(without.stored, 1);
    assert.equal(without.mediaLookup, 'none');
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('a localPath under the old ZaloPC root is found through remapLocalPath', async () => {
  const s = scratch();
  const db = openDb(':memory:');
  try {
    const appData = join(s.root, 'Roaming');
    mkdirSync(join(appData, 'ZaloData', 'media', '149', 'ZaloDownloads', 'file'), { recursive: true });
    writeFileSync(join(appData, 'ZaloData', 'media', '149', 'ZaloDownloads', 'file', 'a.pdf'), PDF);
    seed(db, { msg_id: '1', raw: { localPath: 'C:\\Users\\x\\AppData\\Local\\ZaloPC\\149\\ZaloDownloads\\file\\a.pdf' } });
    const summary = await resolveFiles(db, { rootDir: s.root, fetchFn: localFetch, statfs: plenty, appData });
    assert.equal(summary.stored, 1);
    assert.deepEqual(readFileSync(join(s.root, fileOf(db, '1').stored_path)), PDF);
  } finally { db.close(); s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// The backlog: statuses, idempotence, disk guard
// ---------------------------------------------------------------------------------------------------------------------

test('resolveFiles writes only status, stored_path and error, and a second run does nothing', async () => {
  const s = scratch();
  const srv = await routeServer({ '/ok': { body: PDF } });
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', remote_url: `${srv.base}/ok` });
    seed(db, { msg_id: '2', file_name: 'Hết hạn.pdf', remote_url: `${srv.base}/gone` });
    const before = fileOf(db, '1');

    const first = await resolveFiles(db, base(s.root));
    assert.deepEqual([first.total, first.stored, first.failed], [2, 1, 1]);
    assert.equal(first.bytesStored, PDF.length);
    const after = fileOf(db, '1');
    assert.equal(after.status, 'stored');
    assert.equal(after.stored_path, 'data/files/g1/2026-10-22_Báo cáo.pdf');
    assert.equal(after.error, null);
    for (const key of ['msg_id', 'conv_id', 'ts', 'sender_name', 'file_name', 'ext', 'size', 'checksum', 'remote_url']) assert.equal(after[key], before[key], `${key} untouched`);
    assert.equal(fileOf(db, '2').status, 'failed');
    assert.match(fileOf(db, '2').error, /HTTP 404/);

    const hitsAfterFirst = srv.hits.length;
    const second = await resolveFiles(db, base(s.root));
    assert.equal(second.total, 0, 'stored and failed rows are not selected again by default');
    assert.equal(srv.hits.length, hitsAfterFirst, 'no request on the second run');
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('a stored row whose file still exists is skipped; with the file gone it is fetched again', async () => {
  const s = scratch();
  const srv = await routeServer({ '/ok': { body: PDF } });
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', remote_url: `${srv.base}/ok` });
    await resolveFiles(db, base(s.root));
    assert.equal(srv.hits.length, 1);

    const again = await resolveFiles(db, base(s.root, { statuses: [null, 'stored'] }));
    assert.deepEqual([again.total, again.alreadyStored, again.stored], [1, 1, 0]);
    assert.equal(srv.hits.length, 1, 'the file is there: no request');

    rmSync(join(s.root, fileOf(db, '1').stored_path));
    const restored = await resolveFiles(db, base(s.root, { statuses: [null, 'stored'] }));
    assert.deepEqual([restored.alreadyStored, restored.stored], [0, 1]);
    assert.equal(srv.hits.length, 2);
    assert.ok(existsSync(join(s.root, fileOf(db, '1').stored_path)));
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('statuses selects what is retried: failed and remote_only come back only when asked', async () => {
  const s = scratch();
  let alive = false;
  const srv = await server((req, res) => {
    if (!alive) { res.writeHead(502); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(PDF);
  });
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', remote_url: `${srv.base}/f` });
    await resolveFiles(db, base(s.root));
    assert.equal(statusOf(db, '1'), 'failed');

    alive = true;
    assert.equal((await resolveFiles(db, base(s.root))).total, 0);
    const retried = await resolveFiles(db, base(s.root, { statuses: [null, 'failed', 'remote_only'] }));
    assert.equal(retried.stored, 1);
    assert.deepEqual([statusOf(db, '1'), fileOf(db, '1').error], ['stored', null], 'the old error is cleared');

    const limited = await resolveFiles(db, base(s.root, { statuses: ['stored'], limit: 1 }));
    assert.equal(limited.total, 1);
    await assert.rejects(() => resolveFiles(db, base(s.root, { limit: 0 })), RangeError);
    await assert.rejects(() => resolveFiles(db, base(s.root, { concurrency: 0 })), RangeError);
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('the disk guard stops downloading below the free-space floor and leaves the rest untouched', async () => {
  const s = scratch();
  const srv = await routeServer({ '/f': { body: PDF } });
  const db = openDb(':memory:');
  try {
    for (const id of ['1', '2', '3']) seed(db, { msg_id: id, file_name: `F${id}.pdf`, ts: TS + Number(id), remote_url: `${srv.base}/f` });
    let checks = 0;
    const statfs = async () => ({ bsize: 1, bavail: checks++ === 0 ? 10 * 1024 ** 3 : 1024 }); // roomy once, then nearly full
    const events = [];
    const summary = await resolveFiles(db, base(s.root, { concurrency: 1, statfs, onProgress: e => events.push(e) }));
    assert.equal(summary.stored, 1, 'the first file fits');
    assert.equal(summary.untouched, 2);
    assert.deepEqual(summary.diskStop, { free: 1024, needed: 5 * 1024 ** 3 });
    assert.deepEqual(events.filter(e => e.type === 'disk-stop').length, 1);
    assert.deepEqual(['3', '2', '1'].map(id => statusOf(db, id)), ['stored', null, null], 'newest first; the rest keep status NULL');
    assert.equal(srv.hits.length, 1);

    // Space comes back: the next run picks up the rest.
    const resumed = await resolveFiles(db, base(s.root, { statfs: async () => ({ bsize: 1, bavail: 50 * 1024 ** 3 }) }));
    assert.equal(resumed.stored, 2);
    assert.equal(resumed.untouched, 0);
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('a drive that cannot be measured does not block the run', async () => {
  const s = scratch();
  const srv = await routeServer({ '/f': { body: PDF } });
  const db = openDb(':memory:');
  try {
    seed(db, { msg_id: '1', remote_url: `${srv.base}/f` });
    const summary = await resolveFiles(db, base(s.root, { statfs: async () => { throw new Error('nope'); } }));
    assert.equal(summary.stored, 1);
    assert.equal(summary.diskStop, null);
  } finally { db.close(); await srv.close(); s.cleanup(); }
});

test('formatFilesSummary and filesStatusLine are Vietnamese, with dotted thousands', () => {
  assert.equal(formatFilesSummary({ stored: 52, bytesStored: 310.4 * 1024 * 1024, remote_only: 3, failed: 1640, skipped: 150 }),
    'Đã lưu 52 file (310,4 MB), 3 chỉ có link, 1.640 lỗi, 150 bỏ qua');
  const db = openDb(':memory:');
  seed(db, { msg_id: '1' });
  seed(db, { msg_id: '2', file_name: 'b.pdf' });
  db.upsertFile({ msg_id: '2', status: 'failed', error: 'x' });
  assert.equal(filesStatusLine(db), 'Trạng thái file trong database: 0 đã lưu, 0 chỉ có link, 1 lỗi, 0 bỏ qua, 1 chờ xử lý');
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// The commands: zmi sync hook and zmi files
// ---------------------------------------------------------------------------------------------------------------------

async function captured(fn) {
  const out = [];
  const err = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  try {
    const code = await fn();
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally { console.log = log; console.error = error; }
}

const commandScratch = () => {
  const s = scratch();
  return { ...s, configPath: join(s.root, 'config', 'groups.json'), dbPath: join(s.root, 'data', 'zalo-mi.db') };
};

const fileMessage = (msgId, name, href, content = PDF) => ({
  msgId, cliMsgId: `c${msgId}`, msgType: 19, sendDttm: String(TS), fromUid: 'u1', dName: 'Người X',
  message: { title: name, href, params: JSON.stringify({ fileSize: String(content.length), checksum: md5(content), fileExt: 'pdf' }) },
});

test('zmi sync stores the new files at the end of the run, and a second sync does not fetch them again', async () => {
  const s = commandScratch();
  const srv = await routeServer({ '/f': { type: 'application/pdf', body: PDF } });
  try {
    mkdirSync(join(s.root, 'config'), { recursive: true });
    writeFileSync(s.configPath, JSON.stringify({ version: 1, groups: [{ convId: 'g1', name: 'Nhóm 1', tracked: true, note: '' }] }));
    const bridge = { async getMessages() { return [fileMessage('77', 'Tài liệu.pdf', `${srv.base}/f`)]; }, close() {} };
    const options = { port: 9222, open: async () => bridge, configPath: s.configPath, dbPath: s.dbPath, fileOptions: { appData: join(s.root, 'Roaming'), fetchFn: localFetch, statfs: plenty } };

    const first = await captured(() => syncCommand(options));
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Đã lưu 1 file \(0 MB\), 0 chỉ có link, 0 lỗi, 0 bỏ qua/);
    assert.deepEqual(filesIn(s.root), ['2026-10-22_Tài liệu.pdf']);

    const second = await captured(() => syncCommand(options));
    assert.equal(second.code, 0, second.err);
    assert.doesNotMatch(second.out, /Đã lưu/, 'nothing new to store: no file section');
    assert.equal(srv.hits.length, 1);

    const db = openDb(s.dbPath);
    assert.equal(statusOf(db, '77'), 'stored');
    db.close();
  } finally { await srv.close(); s.cleanup(); }
});

test('zmi files works with Zalo closed, says so once, and --retry / --limit pick the rows', async () => {
  const s = commandScratch();
  let alive = false;
  const srv = await server((req, res) => {
    if (!alive) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(PDF);
  });
  try {
    const db = openDb(s.dbPath);
    seed(db, { msg_id: '1', file_name: 'Một.pdf', ts: TS + 1, remote_url: `${srv.base}/1` });
    seed(db, { msg_id: '2', file_name: 'Hai.pdf', ts: TS + 2, remote_url: `${srv.base}/2` });
    seed(db, { msg_id: '3', file_name: 'Ba.pdf', ts: TS + 3, remote_url: `${srv.base}/3` });
    db.close();
    const closed = async () => { throw new CdpError('PORT_CLOSED', 'đóng'); };
    const run = opts => captured(() => filesCommand({ port: 9222, open: closed, dbPath: s.dbPath, fileOptions: { appData: join(s.root, 'Roaming'), fetchFn: localFetch, statfs: plenty }, ...opts }));

    const first = await run({ limit: 2 });
    assert.equal(first.code, 0, first.err);
    assert.equal(first.out.match(/Zalo không mở/g).length, 1, 'the Zalo-closed note appears once');
    assert.match(first.out, /Đã lưu 0 file \(0 MB\), 0 chỉ có link, 2 lỗi, 0 bỏ qua/);
    assert.match(first.out, /2 × HTTP 404 \(link đã hết hạn\)/);
    assert.match(first.out, /Trạng thái file trong database: 0 đã lưu, 0 chỉ có link, 2 lỗi, 0 bỏ qua, 1 chờ xử lý/);

    alive = true;
    const plain = await run({});
    assert.match(plain.out, /Đã lưu 1 file/, 'without --retry only the never-tried row is processed');
    const retry = await run({ retry: true });
    assert.match(retry.out, /Đã lưu 2 file/, '--retry brings the failed ones back');
    const nothing = await run({ retry: true });
    assert.match(nothing.out, /Không có file nào cần xử lý/);
    assert.match(nothing.out, /Trạng thái file trong database: 3 đã lưu/);
    assert.equal(nothing.code, 0);
  } finally { await srv.close(); s.cleanup(); }
});

test('zmi files without a database says to run sync first', async () => {
  const s = commandScratch();
  try {
    const r = await captured(() => filesCommand({ port: 9222, open: async () => { throw new Error('should not open'); }, dbPath: s.dbPath }));
    assert.equal(r.code, 1);
    assert.match(r.err, /node zmi\.mjs sync/);
    assert.equal(existsSync(s.dbPath), false, 'no database is created');
  } finally { s.cleanup(); }
});

test('--retry and --limit are accepted only where they make sense', () => {
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'zmi.mjs'), ...args], { encoding: 'utf8' });
  for (const args of [['files', '--limit', '0'], ['files', '--limit', 'abc'], ['sync', '--retry'], ['groups', '--limit', '3']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
  }
  assert.match(run('--help').stdout, /zmi\.mjs files|files /);
});
