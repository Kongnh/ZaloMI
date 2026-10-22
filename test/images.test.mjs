import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shapeClass, textScore, hasText, jpegVariantUrl, fetchImage, scanImages, formatImagesSummary, imagesStatusLine, MIN_TEXT_WORDS,
  prunePhotoImages,
} from '../lib/images.mjs';
import { NetGuardError } from '../lib/net.mjs';
import { openDb } from '../lib/db.mjs';
import { imagesCommand, syncCommand } from '../zmi.mjs';
import { CdpError } from '../lib/cdp.mjs';

// No test touches the internet, Zalo or the real data/ folder: the network is a fake fetch + fake DNS, Zalo's decoder and
// OCR are a fake bridge, and every image is a few synthetic bytes (a format signature plus a label the fake OCR reads back).

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 22, 8, 0, 0);
const UID = '111';

const jpeg = label => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`|${label}|`)]);
const png = label => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`|${label}|`)]);
const jxl = label => Buffer.concat([Buffer.from([0xff, 0x0a]), Buffer.from(`|${label}|`)]);

const POSTER = 'HỘI THẢO ĐIỆN MẶT TRỜI MÁI NHÀ 2026\nThời gian: 8:30 ngày 25/10/2026\nĐịa điểm: Hà Nội';
const PRICES = 'BẢNG GIÁ TẤM PIN\nMono 550W 2.450.000 đ\nMono 600W 2.700.000 đ';
/** What the fake OCR "reads" in an image, by its label. Anything else reads as nothing (a photo). */
const OCR_TEXT = { poster: POSTER, poster2: POSTER, prices: PRICES, logo: 'gogoro network' };

/** A fake bridge with Zalo's two compute calls. OCR reads the label back from the file it is given. */
function fakeBridge({ ocrFails = new Set(), connectionDropsAt } = {}) {
  const calls = { decode: 0, ocr: [] };
  return {
    calls,
    async decodeJxl(bytes) {
      calls.decode++;
      assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0x0a], 'only JXL bytes are sent to the decoder');
      return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), bytes.subarray(2)]);
    },
    async recognizeText(path) {
      const label = /\|(.*)\|/.exec(readFileSync(path, 'latin1'))?.[1];
      calls.ocr.push(label);
      if (connectionDropsAt !== undefined && calls.ocr.length >= connectionDropsAt) throw new CdpError('SOCKET_FAILED', 'Kết nối tới cửa sổ Zalo đã đóng.');
      if (ocrFails.has(label)) throw new Error('Failed to decode image');
      const text = OCR_TEXT[label] ?? '';
      return { lines: text ? text.split('\n').map(t => ({ text: t, recognition: 0.98 })) : [] };
    },
    async ocrSupported() { return { supported: true }; },
  };
}

/**
 * Fake of lib/net.mjs guardedFetch over `routes[url] = { status?, type?, body?, error?, guard? }`; unknown urls are 404.
 * `guard` is a NetGuardError the real guard would throw (refused address, bad redirect). `hits` lists the requests.
 */
function fakeFetch(routes = {}) {
  const hits = [];
  const fn = async (url, opts = {}) => {
    hits.push(url);
    assert.ok(opts.signal instanceof AbortSignal, 'every download carries a timeout signal');
    const r = routes[url];
    if (!r) return new Response(null, { status: 404 });
    if (r.guard) throw r.guard;
    if (r.error) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.error } });
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'image/jpeg' } });
  };
  return Object.assign(fn, { hits });
}

const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'zmi-images-'));
  const appData = join(root, 'Roaming');
  const media = join(appData, 'ZaloData', 'media', UID, 'ZaloDownloads');
  return { root, appData, media, dbPath: join(root, 'data', 'zalo-mi.db'), cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

/** Inserts a photo message and its images row the way sync does (no scan columns). Screenshot-shaped unless told otherwise. */
function seedImage(db, { msg_id, conv_id = 'g1', ts = NOW - DAY, width = 1080, height = 2340, remote_url = null, cache_path = null, from_uid = 'u1' }) {
  db.upsertMessage({ msg_id, conv_id, cli_msg_id: `c${msg_id}`, ts, from_uid, kind: 'photo', msg_type: 'chat.photo', raw_json: '{}' });
  db.upsertImage({ msg_id, conv_id, ts, sender_name: 'A', width, height, remote_url, cache_path });
}

/** Puts a file in Zalo's per-group picture cache (z<msgId>_<hash>.<ext>). */
function cachePicture(s, convId, msgId, ext, bytes) {
  const dir = join(s.media, 'picture', `${convId.slice(1)}_group`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `z${msgId}_0123456789abcdef0123456789abcdef.${ext}`), bytes);
}

/** Puts a file in Zalo's resource cache (<cliMsgId>_<fromUid>_<convId>_<hash>.<ext>). */
function cacheResource(s, convId, msgId, ext, bytes, fromUid = 'u1') {
  const dir = join(s.media, 'resource', convId, 'picture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `c${msgId}_${fromUid}_${convId}_fedcba9876543210fedcba9876543210.${ext}`), bytes);
}

const row = (db, msgId) => ({ ...db.raw.prepare('SELECT * FROM images WHERE msg_id = ?').get(msgId) });
const stored = (s, conv = 'g1') => { const dir = join(s.root, 'data', 'images', conv); return existsSync(dir) ? readdirSync(dir).sort() : []; };
const leftovers = s => { const dir = join(s.root, 'data', 'images', '.tmp'); return existsSync(dir) ? readdirSync(dir) : []; };
const plenty = async () => ({ bavail: 1e12, bsize: 1 });
const options = (s, extra = {}) => ({
  rootDir: s.root, appData: s.appData, fetchFn: fakeFetch(), lookup: publicDns, statfs: plenty, now: () => NOW, ...extra,
});

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

test('shapeClass: tall portrait is a phone screenshot, wide 16:9 or 16:10 from 1280 px is a desktop screenshot, the rest is a photo', () => {
  assert.equal(shapeClass(1080, 2340), 'phone_screenshot');
  assert.equal(shapeClass(1920, 1080), 'desktop_screenshot');
  assert.equal(shapeClass(1200, 1000), 'photo');
  assert.equal(shapeClass(1170, 2532), 'phone_screenshot');
  assert.equal(shapeClass(1000, 1900), 'phone_screenshot', 'ratio exactly 1.9');
  assert.equal(shapeClass(1000, 1800), 'photo', 'portrait below 1.9');
  assert.equal(shapeClass(2560, 1600), 'desktop_screenshot', '16:10');
  assert.equal(shapeClass(1280, 720), 'desktop_screenshot');
  assert.equal(shapeClass(1000, 562), 'photo', '16:9 but narrower than 1280');
  assert.equal(shapeClass(2340, 1080), 'photo', 'landscape phone ratio is not a desktop screen');
  assert.equal(shapeClass(4032, 3024), 'photo');
  assert.equal(shapeClass(null, 1080), 'photo', 'unknown size');
  assert.equal(shapeClass(0, 0), 'photo');
});

test('hasText: an OCR result with many words has text; empty, a few characters or a logo does not', () => {
  assert.equal(hasText(POSTER), true);
  assert.equal(hasText(PRICES), true);
  assert.equal(hasText('ĐIỆN CỦA NHÀ GIÀU\n1954 - 1996\n77 MW'), true, 'numbers count: slides and price tables are mostly figures');
  for (const none of ['', null, undefined, 'ab', 'gogoro network', '--- Google Maps', 'solis\nCE\nEVN']) {
    assert.equal(hasText(none), false, String(none));
  }
});

test('textScore counts words of two or more letters or digits, and the threshold sits at MIN_TEXT_WORDS', () => {
  assert.equal(textScore(''), 0);
  assert.equal(textScore(null), 0);
  assert.equal(textScore('a - b , . 7'), 0, 'single characters and punctuation are not words');
  assert.equal(textScore('Công suất 110kW / 110kVA'), 4);
  const words = n => Array.from({ length: n }, (_, i) => `từ${i}`).join(' ');
  assert.equal(hasText(words(MIN_TEXT_WORDS - 1)), false);
  assert.equal(hasText(words(MIN_TEXT_WORDS)), true);
});

test('jpegVariantUrl asks Zalo\'s photo CDN for the JPEG rendition of a JXL link, and leaves other links alone', () => {
  assert.equal(jpegVariantUrl('https://photo-stal-38.zdn.vn/gr/jxl/06c1a92a/2aOb.jxl?jxlstatus=1'), 'https://photo-stal-38.zdn.vn/gr/jpg/06c1a92a/2aOb.jpg');
  assert.equal(jpegVariantUrl('https://f65-zpg-r.zdn.vn/jxl/8286860369218330118/296a0d7b.jxl?jxlstatus=1'), 'https://f65-zpg-r.zdn.vn/jpg/8286860369218330118/296a0d7b.jpg');
  assert.equal(jpegVariantUrl('https://b-f64-zpg-r.zdn.vn/552517565176451850/b3a01acf.jpg'), null);
  assert.equal(jpegVariantUrl(null), null);
  assert.equal(jpegVariantUrl('not a url'), null);
});

// ---------------------------------------------------------------------------------------------------------------------
// Network hygiene
// ---------------------------------------------------------------------------------------------------------------------

// The address rules themselves (connect-time refusal, redirects re-checked per hop) are tested in test/net.test.mjs.

test('fetchImage downloads through the guarded fetch by default: a link to this PC is unavailable and never requested', async () => {
  const refused = await fetchImage('http://127.0.0.1:9222/json/list');
  assert.equal(refused.status, 'unavailable');
  assert.match(refused.error, /nội bộ 127\.0\.0\.1/);
  const named = await fetchImage('http://localhost:9222/json/list');
  assert.match(named.error, /localhost/);
});

test('fetchImage: a refused address or a malformed redirect from the guard ends as unavailable, never an escaping throw', async () => {
  const fetchFn = fakeFetch({
    'https://cdn.example/rebind.jpg': { guard: new NetGuardError('REFUSED', 'không tải từ địa chỉ nội bộ 127.0.0.1 (cdn.example)') },
    'https://cdn.example/bad.jpg': { guard: new NetGuardError('BAD_REDIRECT', 'link chuyển hướng tới một địa chỉ không hợp lệ') },
    'https://cdn.example/loop.jpg': { guard: new NetGuardError('TOO_MANY_REDIRECTS', 'link chuyển hướng quá 3 lần') },
  });
  assert.deepEqual(await fetchImage('https://cdn.example/rebind.jpg', { fetchFn }),
    { status: 'unavailable', error: 'không tải từ địa chỉ nội bộ 127.0.0.1 (cdn.example)', host: true });
  assert.deepEqual(await fetchImage('https://cdn.example/bad.jpg', { fetchFn }), { status: 'unavailable', error: 'link chuyển hướng tới một địa chỉ không hợp lệ' });
  assert.equal((await fetchImage('https://cdn.example/loop.jpg', { fetchFn })).status, 'unavailable');
});

test('fetchImage: an expired link is unavailable, a body over the cap is cut off, a web page is not an image', async () => {
  const big = Buffer.concat([jpeg('x'), Buffer.alloc(5000)]);
  const fetchFn = fakeFetch({
    'https://cdn.example/big.jpg': { body: big },
    'https://cdn.example/page.jpg': { type: 'text/html', body: '<html>lỗi</html>' },
    'https://gone.example/a.jpg': { error: 'ENOTFOUND' },
  });
  assert.deepEqual(await fetchImage('https://cdn.example/old.jpg', { fetchFn, lookup: publicDns }), { status: 'unavailable', error: 'HTTP 404 (link đã hết hạn)' });
  const capped = await fetchImage('https://cdn.example/big.jpg', { fetchFn, lookup: publicDns, maxBytes: 1000 });
  assert.equal(capped.status, 'failed');
  assert.match(capped.error, /quá/);
  assert.equal((await fetchImage('https://cdn.example/page.jpg', { fetchFn, lookup: publicDns })).status, 'unavailable');
  assert.match((await fetchImage('https://gone.example/a.jpg', { fetchFn, lookup: publicDns })).error, /ENOTFOUND/);
});

// ---------------------------------------------------------------------------------------------------------------------
// scanImages
// ---------------------------------------------------------------------------------------------------------------------

test('scanImages stores only the images with text, as JPEG, and records the verdict for every image', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1', width: 1080, height: 2340 });
    seedImage(db, { msg_id: '2' });
    seedImage(db, { msg_id: '3', remote_url: 'https://photo-stal-1.zdn.vn/gr/jxl/aa/bb.jxl?jxlstatus=1' });
    seedImage(db, { msg_id: '4' }); // no cache, no link
    cachePicture(s, 'g1', '1', 'jpg', jpeg('poster'));
    cacheResource(s, 'g1', '2', 'jxl', jxl('poster2'));
    const fetchFn = fakeFetch({ 'https://photo-stal-1.zdn.vn/gr/jpg/aa/bb.jpg': { type: 'image/jpg', body: jpeg('photo') } });
    const bridge = fakeBridge();

    const summary = await scanImages(db, options(s, { bridge, fetchFn }));
    assert.equal(summary.scanned, 4);
    assert.equal(summary.withText, 2);
    assert.deepEqual({ stored: summary.stored, no_text: summary.no_text, unavailable: summary.unavailable, failed: summary.failed }, { stored: 2, no_text: 1, unavailable: 1, failed: 0 });

    assert.deepEqual(stored(s), ['1.jpg', '2.jpg'], 'only text images are written; a JXL is stored decoded');
    assert.deepEqual(readFileSync(join(s.root, 'data', 'images', 'g1', '1.jpg')), jpeg('poster'));
    assert.deepEqual([...readFileSync(join(s.root, 'data', 'images', 'g1', '2.jpg')).subarray(0, 3)], [0xff, 0xd8, 0xff]);
    assert.equal(bridge.calls.decode, 1);
    assert.deepEqual(fetchFn.hits, ['https://photo-stal-1.zdn.vn/gr/jpg/aa/bb.jpg'], 'the CDN JPEG rendition is asked for first');
    assert.deepEqual(leftovers(s), [], 'no temp file is left behind');

    const one = row(db, '1');
    assert.equal(one.status, 'stored');
    assert.equal(one.has_text, 1);
    assert.equal(one.stored_path, 'data/images/g1/1.jpg');
    assert.equal(one.ocr_text, POSTER);
    assert.equal(one.text_score, textScore(POSTER));
    assert.equal(one.scanned_at, NOW);
    assert.equal(one.shape_class, 'phone_screenshot');
    assert.equal(one.error, null);

    const three = row(db, '3');
    assert.deepEqual([three.status, three.has_text, three.stored_path, three.ocr_text, three.text_score, three.scanned_at], ['no_text', 0, null, null, 0, NOW]);
    const four = row(db, '4');
    assert.deepEqual([four.status, four.has_text, four.stored_path, four.scanned_at], ['unavailable', null, null, NOW]);
    assert.match(four.error, /không có/);

    assert.deepEqual(db.search('hoi thao mai nha').map(r => r.msg_id).sort(), ['1', '2'], 'OCR text is searchable, accent-insensitive');
    db.close();
  } finally { s.cleanup(); }
});

test('a second run scans nothing; --rescan scans again and keeps the stored files', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1' });
    seedImage(db, { msg_id: '2' });
    cachePicture(s, 'g1', '1', 'jpg', jpeg('poster'));
    cachePicture(s, 'g1', '2', 'jpg', jpeg('photo'));
    const bridge = fakeBridge();
    await scanImages(db, options(s, { bridge }));
    assert.equal(bridge.calls.ocr.length, 2);

    const again = await scanImages(db, options(s, { bridge }));
    assert.equal(again.total, 0);
    assert.equal(bridge.calls.ocr.length, 2, 'nothing is OCRed twice');
    assert.deepEqual(stored(s), ['1.jpg']);

    const rescan = await scanImages(db, options(s, { bridge, rescan: true }));
    assert.equal(rescan.total, 2);
    assert.equal(rescan.stored, 1);
    assert.equal(bridge.calls.ocr.length, 4);
    assert.deepEqual(stored(s), ['1.jpg']);
    assert.equal(row(db, '1').status, 'stored');
    db.close();
  } finally { s.cleanup(); }
});

test('the cache is tried before the link: picture folder by msgId, resource folder by cliMsgId + sender, remapped cache_path; JPEG before JXL', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    const url = 'https://photo-stal-1.zdn.vn/gr/jxl/aa/x.jxl?jxlstatus=1';
    seedImage(db, { msg_id: '1', remote_url: url });
    seedImage(db, { msg_id: '2', remote_url: url, from_uid: 'u9' });
    seedImage(db, { msg_id: '3', remote_url: url, cache_path: `C:\\Users\\x\\AppData\\Local\\ZaloPC\\${UID}\\ZaloDownloads\\picture\\old\\z3_abc.jpg` });
    cachePicture(s, 'g1', '1', 'jxl', jxl('photo')); // found first (picture folder)...
    cacheResource(s, 'g1', '1', 'jpg', jpeg('poster')); // ...but a JPEG rendition wins: no decode needed
    cacheResource(s, 'g1', '2', 'jpg', jpeg('prices'), 'u9');
    mkdirSync(join(s.media, 'picture', 'old'), { recursive: true });
    writeFileSync(join(s.media, 'picture', 'old', 'z3_abc.jpg'), jpeg('poster2'));
    const fetchFn = fakeFetch();
    const bridge = fakeBridge();

    const summary = await scanImages(db, options(s, { bridge, fetchFn }));
    assert.equal(summary.stored, 3);
    assert.deepEqual(fetchFn.hits, [], 'no download when the image is on this PC');
    assert.equal(bridge.calls.decode, 0);
    assert.deepEqual(bridge.calls.ocr.sort(), ['poster', 'poster2', 'prices']);
    db.close();
  } finally { s.cleanup(); }
});

test('a JXL link falls back to the original when the JPEG rendition is missing, and is decoded by Zalo; a PNG is kept as PNG', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1', remote_url: 'https://photo-stal-1.zdn.vn/gr/jxl/aa/1.jxl?jxlstatus=1' });
    seedImage(db, { msg_id: '2', remote_url: 'https://b-f64-zpg-r.zdn.vn/55/2.jpg' });
    const fetchFn = fakeFetch({
      'https://photo-stal-1.zdn.vn/gr/jxl/aa/1.jxl?jxlstatus=1': { type: 'image/jxl', body: jxl('poster') },
      'https://b-f64-zpg-r.zdn.vn/55/2.jpg': { type: 'image/png', body: png('prices') },
    });
    const bridge = fakeBridge();
    await scanImages(db, options(s, { bridge, fetchFn }));
    assert.deepEqual(fetchFn.hits.sort(), [
      'https://b-f64-zpg-r.zdn.vn/55/2.jpg', 'https://photo-stal-1.zdn.vn/gr/jpg/aa/1.jpg', 'https://photo-stal-1.zdn.vn/gr/jxl/aa/1.jxl?jxlstatus=1',
    ]);
    assert.equal(bridge.calls.decode, 1);
    assert.deepEqual(stored(s), ['1.jpg', '2.png']);
    assert.equal(row(db, '2').stored_path, 'data/images/g1/2.png');
    db.close();
  } finally { s.cleanup(); }
});

test('an expired link without a cached copy is unavailable with the reason', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1', ts: NOW - 40 * DAY, remote_url: 'https://photo-stal-9.zdn.vn/gr/jxl/aa/1.jxl?jxlstatus=1' });
    const summary = await scanImages(db, options(s, { bridge: fakeBridge() }));
    assert.equal(summary.unavailable, 1);
    const r = row(db, '1');
    assert.equal(r.status, 'unavailable');
    assert.equal(r.error, 'HTTP 404 (link đã hết hạn)');
    assert.equal(r.scanned_at, NOW);
    assert.deepEqual(stored(s), []);
    db.close();
  } finally { s.cleanup(); }
});

test('an OCR failure is failed with the reason, is not marked scanned, and is retried by the next run', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1' });
    cachePicture(s, 'g1', '1', 'jpg', jpeg('poster'));
    const first = await scanImages(db, options(s, { bridge: fakeBridge({ ocrFails: new Set(['poster']) }) }));
    assert.equal(first.failed, 1);
    let r = row(db, '1');
    assert.equal(r.status, 'failed');
    assert.match(r.error, /Failed to decode image/);
    assert.equal(r.scanned_at, null);
    assert.deepEqual(stored(s), []);
    assert.deepEqual(leftovers(s), []);

    const second = await scanImages(db, options(s, { bridge: fakeBridge() }));
    assert.equal(second.stored, 1);
    r = row(db, '1');
    assert.equal(r.status, 'stored');
    assert.equal(r.error, null, 'the old reason is cleared');
    db.close();
  } finally { s.cleanup(); }
});

test('10 new images failing in a row abort the run (the engine is broken): the rest stay unscanned', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    for (let i = 1; i <= 12; i++) { seedImage(db, { msg_id: `n${i}`, ts: NOW - i * DAY }); cachePicture(s, 'g1', `n${i}`, 'jpg', jpeg('broken')); }
    const summary = await scanImages(db, options(s, { bridge: fakeBridge({ ocrFails: new Set(['broken']) }), concurrency: 1 }));
    assert.match(summary.aborted, /10 ảnh lỗi liên tiếp/);
    assert.equal(summary.failed, 10);
    assert.equal(summary.untouched, 2);
    db.close();
  } finally { s.cleanup(); }
});

test('images that keep failing go after new ones, never trip the abort, and are given up after 3 attempts', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    for (let i = 1; i <= 12; i++) { seedImage(db, { msg_id: `bad${i}`, ts: NOW - i * DAY }); cachePicture(s, 'g1', `bad${i}`, 'jpg', jpeg('broken')); }
    const bridge = fakeBridge({ ocrFails: new Set(['broken']) });
    await scanImages(db, options(s, { bridge, concurrency: 1, limit: 9 })); // 9 failures: no abort yet, now they are "failed"
    await scanImages(db, options(s, { bridge, concurrency: 1, limit: 3 })); // the other 3 fail too
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM images WHERE status = 'failed' AND fail_count = 1").get().n, 12);

    seedImage(db, { msg_id: 'new1', ts: NOW - 30 * DAY });
    seedImage(db, { msg_id: 'new2', ts: NOW - 31 * DAY });
    cachePicture(s, 'g1', 'new1', 'jpg', jpeg('poster'));
    cachePicture(s, 'g1', 'new2', 'jpg', jpeg('poster2'));
    const order = [];
    const second = await scanImages(db, options(s, { bridge, concurrency: 1, onProgress: e => { if (e.type === 'image') order.push(e.row.msg_id); } }));
    assert.deepEqual(order.slice(0, 2), ['new1', 'new2'], 'never-tried images first, even though they are older');
    assert.equal(second.aborted, null, 'images that failed before do not count towards the 10-in-a-row abort');
    assert.equal(second.stored, 2);
    assert.equal(second.failed, 12);

    const third = await scanImages(db, options(s, { bridge, concurrency: 1 }));
    assert.equal(third.failed, 12);
    assert.equal(db.raw.prepare('SELECT max(fail_count) AS n FROM images').get().n, 3);
    const fourth = await scanImages(db, options(s, { bridge, concurrency: 1 }));
    assert.equal(fourth.total, 0, 'after 3 failed attempts an image is no longer retried (only --rescan brings it back)');
    assert.equal((await scanImages(db, options(s, { bridge, concurrency: 1, rescan: true, limit: 1 }))).total, 1);
    db.close();
  } finally { s.cleanup(); }
});

test('the disk guard stops before writing anything below the free-space floor and leaves the rows unscanned', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1' });
    seedImage(db, { msg_id: '2' });
    cachePicture(s, 'g1', '1', 'jpg', jpeg('poster'));
    cachePicture(s, 'g1', '2', 'jpg', jpeg('poster2'));
    const bridge = fakeBridge();
    const summary = await scanImages(db, options(s, { bridge, statfs: async () => ({ bavail: 4 * 1024 ** 3, bsize: 1 }) }));
    assert.ok(summary.diskStop);
    assert.equal(summary.untouched, 2);
    assert.equal(bridge.calls.ocr.length, 0);
    assert.deepEqual(stored(s), []);
    assert.equal(row(db, '1').scanned_at, null);
    assert.equal(row(db, '1').status, null);
    db.close();
  } finally { s.cleanup(); }
});

test('order: live links first, oldest first (the next to expire go before), then cached old images, then the rest', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    const link = id => `https://b-f64-zpg-r.zdn.vn/55/${id}.jpg`;
    seedImage(db, { msg_id: 'old-nocache', ts: NOW - 60 * DAY, remote_url: link('a') });
    seedImage(db, { msg_id: 'old-cached', ts: NOW - 90 * DAY });
    seedImage(db, { msg_id: 'recent-new', ts: NOW - 1 * DAY, remote_url: link('b') });
    seedImage(db, { msg_id: 'recent-old', ts: NOW - 14 * DAY, remote_url: link('c'), width: 1920, height: 1080 });
    cachePicture(s, 'g1', 'old-cached', 'jpg', jpeg('photo'));
    const fetchFn = fakeFetch(Object.fromEntries(['b', 'c'].map(id => [link(id), { body: jpeg('photo') }])));
    const order = [];
    await scanImages(db, options(s, { bridge: fakeBridge(), fetchFn, concurrency: 1, onProgress: e => { if (e.type === 'image') order.push(e.row.msg_id); } }));
    assert.deepEqual(order, ['recent-old', 'recent-new', 'old-cached', 'old-nocache']);

    const s2 = await scanImages(db, options(s, { bridge: fakeBridge(), fetchFn, rescan: true, limit: 2, concurrency: 1 }));
    assert.equal(s2.total, 2, '--limit caps the run after ordering');
    db.close();
  } finally { s.cleanup(); }
});

test('only screenshot-shaped images are scanned: photo-shaped ones are never fetched or OCRed, not even with --rescan', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    const link = id => `https://b-f64-zpg-r.zdn.vn/55/${id}.jpg`;
    seedImage(db, { msg_id: 'shot', remote_url: link('shot') });
    seedImage(db, { msg_id: 'camera', width: 4032, height: 3024, remote_url: link('camera') });
    seedImage(db, { msg_id: 'square', width: 1254, height: 1254, remote_url: link('square') });
    cachePicture(s, 'g1', 'camera', 'jpg', jpeg('poster'));
    const fetchFn = fakeFetch(Object.fromEntries(['shot', 'camera', 'square'].map(id => [link(id), { body: jpeg('poster') }])));
    const bridge = fakeBridge();

    for (const rescan of [false, true]) {
      const summary = await scanImages(db, options(s, { bridge, fetchFn, rescan }));
      assert.equal(summary.total, 1, `rescan ${rescan}`);
    }
    assert.deepEqual(fetchFn.hits, [link('shot')], 'the photo-shaped rows are never downloaded');
    assert.equal(bridge.calls.ocr.length, 2, 'only the screenshot is OCRed (once per run)');
    assert.deepEqual(stored(s), ['shot.jpg']);
    for (const id of ['camera', 'square']) {
      const r = row(db, id);
      assert.deepEqual([r.shape_class, r.status, r.scanned_at, r.ocr_text], ['photo', null, null, null], id);
    }
    db.close();
  } finally { s.cleanup(); }
});

test('shape_class is filled for every row up front, also for rows the run does not reach', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1', width: 1920, height: 1080, ts: NOW - DAY });
    seedImage(db, { msg_id: '2', width: 1080, height: 2340, ts: NOW - 2 * DAY });
    seedImage(db, { msg_id: '3', width: 1200, height: 1000, ts: NOW - 3 * DAY });
    await scanImages(db, options(s, { bridge: fakeBridge(), limit: 1 }));
    assert.equal(row(db, '1').shape_class, 'desktop_screenshot');
    assert.equal(row(db, '2').shape_class, 'phone_screenshot');
    assert.equal(row(db, '3').shape_class, 'photo');
    db.close();
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------------
// prunePhotoImages
// ---------------------------------------------------------------------------------------------------------------------

/** A row as an earlier (all-images) scan left it: stored file on disk, OCR text in the row and in search. */
function seedStored(db, s, { msg_id, width, height, conv_id = 'g1', stored_path = `data/images/${conv_id}/${msg_id}.jpg`, bytes = 1000, writeFile = true }) {
  seedImage(db, { msg_id, conv_id, width, height });
  db.upsertImage({ msg_id, shape_class: shapeClass(width, height), status: 'stored', has_text: 1, text_score: textScore(POSTER), ocr_text: POSTER, stored_path, scanned_at: NOW });
  if (writeFile) {
    mkdirSync(join(s.root, 'data', 'images', conv_id), { recursive: true });
    writeFileSync(join(s.root, stored_path), Buffer.alloc(bytes, 1));
  }
}

test('prunePhotoImages deletes the files of photo-shaped images, keeps their OCR text and search, and leaves screenshots alone', () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedStored(db, s, { msg_id: 'p1', width: 4032, height: 3024, bytes: 3 * 1024 * 1024 });
    seedStored(db, s, { msg_id: 'p2', width: 1254, height: 1254, bytes: 1024 * 1024 });
    seedStored(db, s, { msg_id: 'gone', width: 1200, height: 1000, writeFile: false }); // file already missing: fine
    seedStored(db, s, { msg_id: 'shot', width: 1080, height: 2340 });
    seedImage(db, { msg_id: 'p-notext', width: 1200, height: 1000 });
    db.upsertImage({ msg_id: 'p-notext', shape_class: 'photo', status: 'no_text', has_text: 0, scanned_at: NOW });

    const result = prunePhotoImages(db, { rootDir: s.root });
    assert.equal(result.pruned, 3);
    assert.equal(result.missing, 1);
    assert.equal(result.bytesFreed, 4 * 1024 * 1024);
    assert.deepEqual(result.refused, []);
    assert.deepEqual(stored(s), ['shot.jpg']);

    for (const id of ['p1', 'p2', 'gone']) {
      const r = row(db, id);
      assert.deepEqual([r.status, r.stored_path, r.has_text, r.text_score, r.ocr_text], ['text_only', null, 1, textScore(POSTER), POSTER], id);
    }
    assert.equal(row(db, 'shot').status, 'stored');
    assert.equal(row(db, 'p-notext').status, 'no_text');
    assert.deepEqual(db.search('hoi thao mai nha').map(r => r.msg_id).sort(), ['gone', 'p1', 'p2', 'shot'], 'OCR text stays searchable');

    const again = prunePhotoImages(db, { rootDir: s.root });
    assert.equal(again.pruned, 0, 'a second prune finds nothing');
    db.close();
  } finally { s.cleanup(); }
});

test('prunePhotoImages refuses any stored_path that does not resolve inside data/images/', () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    mkdirSync(join(s.root, 'data', 'files', 'g1'), { recursive: true });
    writeFileSync(join(s.root, 'data', 'files', 'g1', 'keep.pdf'), 'pdf');
    writeFileSync(join(s.root, 'outside.jpg'), 'x');
    seedStored(db, s, { msg_id: 'a', width: 1200, height: 1000, stored_path: 'data/files/g1/keep.pdf', writeFile: false });
    seedStored(db, s, { msg_id: 'b', width: 1200, height: 1000, stored_path: 'data/images/../../outside.jpg', writeFile: false });
    seedStored(db, s, { msg_id: 'c', width: 1200, height: 1000, stored_path: join(s.root, 'outside.jpg'), writeFile: false });
    seedStored(db, s, { msg_id: 'd', width: 1200, height: 1000, stored_path: 'data/images', writeFile: false });

    const result = prunePhotoImages(db, { rootDir: s.root });
    assert.equal(result.pruned, 0);
    assert.deepEqual(result.refused.sort(), ['a', 'b', 'c', 'd']);
    assert.ok(existsSync(join(s.root, 'data', 'files', 'g1', 'keep.pdf')));
    assert.ok(existsSync(join(s.root, 'outside.jpg')));
    for (const id of ['a', 'b', 'c', 'd']) assert.equal(row(db, id).status, 'stored', `${id} untouched`);
    db.close();
  } finally { s.cleanup(); }
});

test('prunePhotoImages sweeps temp files left in data/images/.tmp by runs that are no longer alive, but not a live run\'s', () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    const tmp = join(s.root, 'data', 'images', '.tmp');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, '8390985879812-999999999.jpg'), Buffer.alloc(2048)); // a pid that does not exist
    writeFileSync(join(tmp, `123-${process.pid}.jpg`), 'live'); // this process: alive
    writeFileSync(join(tmp, 'notes.txt'), 'not ours');
    const result = prunePhotoImages(db, { rootDir: s.root });
    assert.equal(result.tempFiles, 1);
    assert.equal(result.tempBytes, 2048);
    assert.deepEqual(readdirSync(tmp).sort(), [`123-${process.pid}.jpg`, 'notes.txt']);
    db.close();
  } finally { s.cleanup(); }
});

test('when the Zalo connection drops the run stops: the image in flight and the rest stay unscanned', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    for (const id of ['1', '2', '3']) { seedImage(db, { msg_id: id, ts: NOW - Number(id) * DAY }); cachePicture(s, 'g1', id, 'jpg', jpeg('poster')); }
    const summary = await scanImages(db, options(s, { bridge: fakeBridge({ connectionDropsAt: 2 }), concurrency: 1 }));
    assert.match(summary.aborted, /Zalo/);
    assert.equal(summary.stored, 1);
    assert.equal(summary.untouched, 2);
    assert.deepEqual(db.raw.prepare('SELECT msg_id FROM images WHERE scanned_at IS NULL ORDER BY msg_id').all().map(r => r.msg_id).length, 2);
    assert.equal(db.raw.prepare("SELECT count(*) AS n FROM images WHERE status = 'failed'").get().n, 0, 'a dropped connection is not the image\'s fault');
    db.close();
  } finally { s.cleanup(); }
});

test('scanImages needs Zalo\'s OCR and says so in Vietnamese without a bridge', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    await assert.rejects(scanImages(db, options(s, { bridge: undefined })), /Zalo/);
    db.close();
  } finally { s.cleanup(); }
});

test('formatImagesSummary and imagesStatusLine are Vietnamese', () => {
  assert.equal(formatImagesSummary({ scanned: 1234, stored: 300, no_text: 900, unavailable: 30, failed: 4 }),
    'Đã quét 1.234 ảnh: 300 có chữ (đã lưu), 900 không có chữ, 30 không còn tải được, 4 lỗi');
  const db = openDb(':memory:');
  seedImage(db, { msg_id: '1' });
  seedImage(db, { msg_id: '2' });
  seedImage(db, { msg_id: '3', width: 1200, height: 1000 });
  seedImage(db, { msg_id: '4', width: 1200, height: 1000 });
  db.upsertImage({ msg_id: '1', shape_class: 'phone_screenshot' });
  db.upsertImage({ msg_id: '2', shape_class: 'phone_screenshot', status: 'stored', has_text: 1, scanned_at: 1 });
  db.upsertImage({ msg_id: '3', shape_class: 'photo' });
  db.upsertImage({ msg_id: '4', shape_class: 'photo', status: 'text_only', has_text: 1 });
  assert.equal(imagesStatusLine(db),
    'Trạng thái ảnh chụp màn hình trong database: 1 có chữ (đã lưu), 0 không có chữ, 0 không còn tải được, 0 lỗi, 1 chưa quét. ' +
    '2 ảnh khác (không có dáng ảnh chụp màn hình) không quét, theo thiết kế; 1 ảnh trong số đó chỉ còn giữ chữ OCR.');
  db.close();
});

// ---------------------------------------------------------------------------------------------------------------------
// zmi images
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

test('zmi images scans with Zalo open, prints progress and the summary, and a second run has nothing to do', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1' });
    seedImage(db, { msg_id: '2' });
    cachePicture(s, 'g1', '1', 'jpg', jpeg('poster'));
    cachePicture(s, 'g1', '2', 'jpg', jpeg('photo'));
    db.close();
    let closed = 0;
    const bridge = { ...fakeBridge(), close() { closed++; } };
    const run = opts => captured(() => imagesCommand({ port: 9222, open: async () => bridge, dbPath: s.dbPath, imageOptions: { appData: s.appData, fetchFn: fakeFetch(), lookup: publicDns, statfs: plenty }, ...opts }));

    const first = await run({});
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Đã quét 2 ảnh: 1 có chữ \(đã lưu\), 1 không có chữ, 0 không còn tải được, 0 lỗi/);
    assert.match(first.out, /ảnh\/giây/);
    assert.deepEqual(stored(s), ['1.jpg']);
    assert.equal(closed, 1);

    const second = await run({});
    assert.match(second.out, /Không có ảnh nào cần quét/);
    assert.match(second.out, /Trạng thái ảnh chụp màn hình trong database: 1 có chữ \(đã lưu\), 1 không có chữ/);

    const rescan = await run({ rescan: true, limit: 1 });
    assert.match(rescan.out, /Đã quét 1 ảnh/);
  } finally { s.cleanup(); }
});

test('zmi images with Zalo closed explains how to open it and writes nothing', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1' });
    db.close();
    const r = await captured(() => imagesCommand({ port: 9222, open: async () => { throw new CdpError('PORT_CLOSED', 'Không kết nối được cổng debug.'); }, dbPath: s.dbPath, imageOptions: { fetchFn: fakeFetch() } }));
    assert.equal(r.code, 1);
    assert.match(r.err, /Zalo \(MI\)/);
    const again = openDb(s.dbPath);
    assert.equal(row(again, '1').shape_class, null, 'nothing was written');
    again.close();
  } finally { s.cleanup(); }
});

test('zmi images without a database says to run sync first and does not open Zalo', async () => {
  const s = scratch();
  try {
    const r = await captured(() => imagesCommand({ port: 9222, open: async () => { throw new Error('should not open'); }, dbPath: s.dbPath, imageOptions: { fetchFn: fakeFetch() } }));
    assert.equal(r.code, 1);
    assert.match(r.err, /node zmi\.mjs sync/);
    assert.equal(existsSync(s.dbPath), false);
  } finally { s.cleanup(); }
});

test('zmi images --prune-photos works without Zalo, scans nothing, and prints what it freed', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedStored(db, s, { msg_id: 'p1', width: 4032, height: 3024, bytes: 2 * 1024 * 1024 });
    seedStored(db, s, { msg_id: 'shot', width: 1080, height: 2340 });
    seedImage(db, { msg_id: 'pending-shot' });
    db.close();
    const r = await captured(() => imagesCommand({ port: 9222, prunePhotos: true, open: async () => { throw new Error('should not open Zalo'); }, dbPath: s.dbPath, imageOptions: { fetchFn: fakeFetch() } }));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Đã xóa 1 file ảnh không phải ảnh chụp màn hình \(2 MB\)/);
    assert.match(r.out, /giữ nguyên chữ OCR/);
    assert.deepEqual(stored(s), ['shot.jpg']);
    const after = openDb(s.dbPath);
    assert.equal(row(after, 'pending-shot').scanned_at, null, 'no scan ran');
    assert.equal(row(after, 'p1').status, 'text_only');
    after.close();
  } finally { s.cleanup(); }
});

test('zmi sync ends with the screenshot scan on the same bridge and prints its summary; a scan failure only warns', async () => {
  const s = scratch();
  try {
    const configPath = join(s.root, 'config', 'groups.json');
    mkdirSync(join(s.root, 'config'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ version: 1, groups: [{ convId: 'g1', name: 'Nhóm 1', tracked: true, note: '' }] }));
    const link = id => `https://b-f64-zpg-r.zdn.vn/55/${id}.jpg`;
    const photo = (msgId, width, height) => ({
      msgId, cliMsgId: `c${msgId}`, msgType: 2, sendDttm: String(Date.now() - DAY), fromUid: 'u1', dName: 'A',
      message: { title: '', hdUrl: link(msgId), params: JSON.stringify({ width, height }) },
    });
    const messages = [photo('101', 1080, 2340), photo('102', 4032, 3024)];
    const fetchFn = fakeFetch({ [link('101')]: { body: jpeg('poster') }, [link('102')]: { body: jpeg('poster') } });
    const imageOptions = { appData: s.appData, fetchFn, lookup: publicDns, statfs: plenty };
    let opened = 0;
    const bridge = { ...fakeBridge(), async getMessages() { return messages; }, close() {} };
    const run = b => captured(() => syncCommand({
      port: 9222, open: async () => { opened++; return b; }, configPath, dbPath: s.dbPath, fileOptions: { appData: s.appData }, imageOptions,
    }));

    const first = await run(bridge);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Đã quét 1 ảnh: 1 có chữ \(đã lưu\), 0 không có chữ, 0 không còn tải được, 0 lỗi/);
    assert.equal(opened, 1, 'one bridge for the messages, the files and the images');
    assert.deepEqual(stored(s), ['101.jpg']);
    assert.deepEqual(fetchFn.hits, [link('101')], 'the photo-shaped image is never fetched');

    const noOcr = { async getMessages() { return messages; }, close() {} };
    const second = await run(noOcr);
    assert.equal(second.code, 0, 'a failed image scan never fails sync');
    assert.match(second.err, /⚠ Không quét được ảnh chụp màn hình/);
  } finally { s.cleanup(); }
});

test('--rescan belongs to images, and --limit is accepted for images and files only', () => {
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'zmi.mjs'), ...args], { encoding: 'utf8' });
  for (const args of [['files', '--rescan'], ['sync', '--rescan'], ['images', '--limit', '0'], ['images', '--retry'], ['groups', '--limit', '3'],
    ['files', '--prune-photos'], ['images', '--prune-photos', '--rescan'], ['images', '--prune-photos', '--limit', '5']]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
  assert.match(run('--help').stdout, /images/);
});
