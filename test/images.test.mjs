import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  shapeClass, textScore, hasText, jpegVariantUrl, checkRemoteUrl, fetchImage, scanImages, formatImagesSummary, imagesStatusLine, MIN_TEXT_WORDS,
} from '../lib/images.mjs';
import { openDb } from '../lib/db.mjs';
import { imagesCommand } from '../zmi.mjs';
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

/** Fake fetch over `routes[url] = { status?, type?, body?, location? }`; unknown urls are 404. `hits` lists the requests. */
function fakeFetch(routes = {}) {
  const hits = [];
  const fn = async (url, opts = {}) => {
    hits.push(url);
    assert.equal(opts.redirect, 'manual', 'redirects are followed by hand so every hop is checked');
    const r = routes[url];
    if (!r) return new Response(null, { status: 404 });
    if (r.error) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.error } });
    const headers = { 'content-type': r.type ?? 'image/jpeg' };
    if (r.location) headers.location = r.location;
    return new Response(r.body ?? null, { status: r.status ?? 200, headers });
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

/** Inserts a photo message and its images row the way sync does (no scan columns). */
function seedImage(db, { msg_id, conv_id = 'g1', ts = NOW - DAY, width = 1200, height = 1000, remote_url = null, cache_path = null, from_uid = 'u1' }) {
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

test('checkRemoteUrl allows public http(s) only: other schemes, loopback and private hosts are refused', async () => {
  assert.equal(await checkRemoteUrl('https://photo-stal-38.zdn.vn/gr/jpg/a.jpg', { lookup: publicDns }), null);
  assert.equal(await checkRemoteUrl('http://b-f64-zpg-r.zdn.vn/a.jpg', { lookup: publicDns }), null);
  for (const url of ['file:///C:/Users/x/a.jpg', 'ftp://example.com/a.jpg', 'data:image/jpeg;base64,AAAA', 'javascript:alert(1)', 'not a url',
    'http://127.0.0.1/a.jpg', 'http://localhost:9222/json/list', 'http://zalo.localhost/a.jpg', 'http://10.1.2.3/a.jpg', 'http://172.16.0.9/a.jpg',
    'http://192.168.1.20/a.jpg', 'http://169.254.169.254/latest', 'http://0.0.0.0/a.jpg', 'http://[::1]/a.jpg', 'http://[fd12::1]/a.jpg',
    'http://[fe80::1]/a.jpg', 'http://[::ffff:127.0.0.1]/a.jpg', 'http://100.64.0.1/a.jpg']) {
    assert.equal(typeof await checkRemoteUrl(url, { lookup: publicDns }), 'string', url);
  }
  const toLoopback = async () => [{ address: '127.0.0.1', family: 4 }];
  assert.match(await checkRemoteUrl('https://evil.example/a.jpg', { lookup: toLoopback }), /nội bộ/, 'a public name that resolves to a private address');
});

test('fetchImage never sends a request to a refused address, and re-checks every redirect hop', async () => {
  const fetchFn = fakeFetch({
    'https://cdn.example/a.jpg': { status: 302, location: 'http://192.168.0.5/a.jpg' },
    'https://cdn.example/b.jpg': { status: 301, location: 'https://cdn2.example/b.jpg' },
    'https://cdn2.example/b.jpg': { body: jpeg('poster') },
  });
  const refused = await fetchImage('http://127.0.0.1:9222/json', { fetchFn, lookup: publicDns });
  assert.equal(refused.status, 'unavailable');
  assert.equal(fetchFn.hits.length, 0);

  const redirected = await fetchImage('https://cdn.example/a.jpg', { fetchFn, lookup: publicDns });
  assert.equal(redirected.status, 'unavailable');
  assert.deepEqual(fetchFn.hits, ['https://cdn.example/a.jpg'], 'the private redirect target is never requested');

  const ok = await fetchImage('https://cdn.example/b.jpg', { fetchFn, lookup: publicDns });
  assert.deepEqual(ok.bytes, jpeg('poster'));
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

test('order: live links first (screenshots, then oldest first so the ones about to expire go before), then cached old images, then the rest', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    const link = id => `https://b-f64-zpg-r.zdn.vn/55/${id}.jpg`;
    seedImage(db, { msg_id: 'old-nocache', ts: NOW - 60 * DAY, remote_url: link('a') });
    seedImage(db, { msg_id: 'old-cached', ts: NOW - 90 * DAY });
    seedImage(db, { msg_id: 'recent-new', ts: NOW - 1 * DAY, remote_url: link('b') });
    seedImage(db, { msg_id: 'recent-old', ts: NOW - 14 * DAY, remote_url: link('c') });
    seedImage(db, { msg_id: 'recent-shot', ts: NOW - 2 * DAY, width: 1080, height: 2340, remote_url: link('d') });
    cachePicture(s, 'g1', 'old-cached', 'jpg', jpeg('photo'));
    const fetchFn = fakeFetch(Object.fromEntries(['b', 'c', 'd'].map(id => [link(id), { body: jpeg('photo') }])));
    const order = [];
    await scanImages(db, options(s, { bridge: fakeBridge(), fetchFn, concurrency: 1, onProgress: e => { if (e.type === 'image') order.push(e.row.msg_id); } }));
    assert.deepEqual(order, ['recent-shot', 'recent-old', 'recent-new', 'old-cached', 'old-nocache']);

    const s2 = await scanImages(db, options(s, { bridge: fakeBridge(), fetchFn, rescan: true, limit: 2, concurrency: 1 }));
    assert.equal(s2.total, 2, '--limit caps the run after ordering');
    db.close();
  } finally { s.cleanup(); }
});

test('shape_class is filled for every row up front, also for rows the run does not reach', async () => {
  const s = scratch();
  try {
    const db = openDb(s.dbPath);
    seedImage(db, { msg_id: '1', width: 1920, height: 1080, ts: NOW - DAY });
    seedImage(db, { msg_id: '2', width: 1080, height: 2340, ts: NOW - 2 * DAY });
    await scanImages(db, options(s, { bridge: fakeBridge(), limit: 1 }));
    assert.equal(row(db, '1').shape_class, 'desktop_screenshot');
    assert.equal(row(db, '2').shape_class, 'phone_screenshot');
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
  db.upsertImage({ msg_id: '2', status: 'stored', has_text: 1, scanned_at: 1 });
  assert.equal(imagesStatusLine(db), 'Trạng thái ảnh trong database: 1 có chữ (đã lưu), 0 không có chữ, 0 không còn tải được, 0 lỗi, 1 chưa quét');
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
    const run = opts => captured(() => imagesCommand({ port: 9222, open: async () => bridge, dbPath: s.dbPath, imageOptions: { appData: s.appData, lookup: publicDns, statfs: plenty }, ...opts }));

    const first = await run({});
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /Đã quét 2 ảnh: 1 có chữ \(đã lưu\), 1 không có chữ, 0 không còn tải được, 0 lỗi/);
    assert.match(first.out, /ảnh\/giây/);
    assert.deepEqual(stored(s), ['1.jpg']);
    assert.equal(closed, 1);

    const second = await run({});
    assert.match(second.out, /Không có ảnh nào cần quét/);
    assert.match(second.out, /Trạng thái ảnh trong database: 1 có chữ \(đã lưu\), 1 không có chữ/);

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
    const r = await captured(() => imagesCommand({ port: 9222, open: async () => { throw new CdpError('PORT_CLOSED', 'Không kết nối được cổng debug.'); }, dbPath: s.dbPath }));
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
    const r = await captured(() => imagesCommand({ port: 9222, open: async () => { throw new Error('should not open'); }, dbPath: s.dbPath }));
    assert.equal(r.code, 1);
    assert.match(r.err, /node zmi\.mjs sync/);
    assert.equal(existsSync(s.dbPath), false);
  } finally { s.cleanup(); }
});

test('--rescan belongs to images, and --limit is accepted for images and files only', () => {
  const run = (...args) => spawnSync(process.execPath, ['--no-warnings', join(import.meta.dirname, '..', 'zmi.mjs'), ...args], { encoding: 'utf8' });
  for (const args of [['files', '--rescan'], ['sync', '--rescan'], ['images', '--limit', '0'], ['images', '--retry'], ['groups', '--limit', '3']]) {
    assert.equal(run(...args).status, 2, args.join(' '));
  }
  assert.match(run('--help').stdout, /images/);
});
