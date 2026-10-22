// Screenshots that carry text (spec 6.6, narrowed by Cong): decide which screenshots have text, keep their OCR text for
// full-text search, and store those images as JPEG under data/images/ so Claude can read them later.
// Only screenshot-shaped images are scanned (Cong's decision: camera photos, AI images and ads are not worth the time,
// accepting that posters, price tables and cropped screenshots of other shapes are skipped too).
//
//   shapeClass(w, h)        'phone_screenshot' | 'desktop_screenshot' | 'photo', from the stored size: decides what is scanned
//   textScore / hasText     the has-text verdict on OCR text
//   scanImages(db, opts)    the screenshot backlog (never scanned, or failed last time), in priority order, a few at a time
//   prunePhotoImages(db)    deletes the files an earlier all-images scan stored for photo-shaped images; keeps their OCR text
//
// Where the pixels come from (Task 7 spike, see README):
//   1. Zalo's own cache on this PC, read only: picture\<convId without g>_group\z<msgId>_<hash>.<ext>,
//      resource\<convId>\picture\<cliMsgId>_<fromUid>_<convId>_<hash>.<ext>, and the message's localPath (remapped).
//      A .jpg/.png rendition is used as it is; a .jxl is decoded to JPEG by Zalo's own decoder through the bridge.
//   2. The link (hdUrl) while it lives (about 15 days): for a JXL photo Zalo's CDN serves the JPEG rendition at the same
//      path with /jpg/ and .jpg, so no decoding is needed; the original link is the fallback. Plain GETs of public
//      http(s) hosts only, every redirect hop re-checked, size-capped, with a timeout.
// The OCR is Zalo's own (the engine behind its "copy text from image"), run through the bridge on a temp file of zmi's.
// Nothing here calls a Zalo function outside the bridge's allowlists, and nothing is written to Zalo's folders.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CdpError } from './cdp.mjs';
import { MIN_FREE_BYTES, PROGRESS_EVERY, freeBytes, megabytes, remapLocalPath, thousands } from './files.mjs';
import { guardedFetch, NetGuardError } from './net.mjs';

/** Below this many words (tokens of two or more letters/digits) the OCR text is noise: a logo, a sign, a map label. Tuned on real images (README). */
export const MIN_TEXT_WORDS = 6;
/** Images younger than this still have a live link (Zalo's CDN links expire after about 15 days). */
export const RECENT_DAYS = 16;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const CONCURRENCY = 3;
/** OCR lines recognised with less confidence than this are dropped from ocr_text. */
const MIN_LINE_RECOGNITION = 0.5;
/** This many failures in a row means the engine is broken (Zalo reloaded, OCR host gone), not the images: stop. */
const MAX_FAILURES_IN_A_ROW = 10;
const DAY_MS = 86_400_000;
const MB = 1024 * 1024;
const REPO_ROOT = resolve(import.meta.dirname, '..');


// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/** Portrait at least 1.9 tall is a phone screenshot; landscape near 16:9 or 16:10 and at least 1280 wide is a desktop one. */
export function shapeClass(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!(w > 0 && h > 0)) return 'photo';
  if (h / w >= 1.9) return 'phone_screenshot';
  const ratio = w / h;
  if (w >= 1280 && (Math.abs(ratio - 16 / 9) <= 0.05 || Math.abs(ratio - 16 / 10) <= 0.05)) return 'desktop_screenshot';
  return 'photo';
}

/** Number of words in OCR text: whitespace-separated tokens with at least two letters or digits (so figures in a price table count). */
export function textScore(ocrText) {
  if (typeof ocrText !== 'string') return 0;
  return ocrText.split(/\s+/).filter(token => (token.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2).length;
}

/** The has-text verdict: enough words that the image carries text worth keeping. */
export const hasText = ocrText => textScore(ocrText) >= MIN_TEXT_WORDS;

/** For a Zalo CDN JXL link (…/jxl/…/name.jxl?…), the same photo's JPEG rendition (…/jpg/…/name.jpg); null for any other link. */
export function jpegVariantUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.pathname.includes('/jxl/') || !/\.jxl$/i.test(u.pathname)) return null;
  u.pathname = u.pathname.replace('/jxl/', '/jpg/').replace(/\.jxl$/i, '.jpg');
  u.search = '';
  return u.toString();
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JXL_CONTAINER = Buffer.from([0x00, 0x00, 0x00, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);

/** 'jpeg' | 'png' | 'jxl' from the first bytes, null for anything else. */
export function imageFormat(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0x0a) return 'jxl';
  if (bytes.length >= 12 && bytes.subarray(0, 12).equals(JXL_CONTAINER)) return 'jxl';
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Download (the address rules live in lib/net.mjs, shared with lib/files.mjs)
// ---------------------------------------------------------------------------------------------------------------------

class TooBigError extends Error {}

async function readCapped(body, maxBytes) {
  if (!body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) throw new TooBigError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c)));
}

const httpReason = status => (status === 404 || status === 410 ? `HTTP ${status} (link đã hết hạn)` : `HTTP ${status}`);
const tooBigReason = maxBytes => `ảnh quá ${thousands(maxBytes / MB)} MB`;

function networkProblem(error, signal, timeoutMs) {
  // The guard's refusals: a private address (also when only found at connect time) or a host name that is not allowed
  // is the host's problem; a broken or endless redirect chain is just a dead link.
  if (error instanceof NetGuardError) {
    return error.code === 'REFUSED' ? { status: 'unavailable', error: error.message, host: true } : { status: 'unavailable', error: error.message };
  }
  if (signal.aborted) return { status: 'failed', error: `quá thời gian chờ (${Math.round(timeoutMs / 1000)} giây)` };
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ENOTFOUND') return { status: 'unavailable', error: 'không phân giải được máy chủ (ENOTFOUND)', host: true };
  return { status: 'failed', error: code ? `lỗi mạng (${code})` : `lỗi mạng: ${error?.message ?? error}` };
}

/**
 * GET of one image link through lib/net.mjs guardedFetch (public hosts only, enforced at connect time and on every
 * redirect hop), with a timeout and a size cap.
 * @param {string} url
 * @param {{ fetchFn?: typeof guardedFetch, lookup?: Function, maxBytes?: number, timeoutMs?: number }} [options]
 *   `fetchFn` and `lookup` are for tests.
 * @returns {Promise<{ bytes: Buffer } | { status: 'unavailable'|'failed', error: string, host?: true }>}
 *   unavailable: refused address, unknown host, HTTP error, bad redirect, a web page instead of an image (the link is gone);
 *   failed: timeout, network error, over the size cap (worth another try); host: the problem is the host itself.
 */
export async function fetchImage(url, { fetchFn = guardedFetch, lookup, maxBytes = MAX_IMAGE_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchFn(url, { signal, lookup });
  } catch (error) {
    return networkProblem(error, signal, timeoutMs);
  }
  const discard = () => response.body?.cancel().catch(() => {});
  if (!response.ok) { await discard(); return { status: 'unavailable', error: httpReason(response.status) }; }
  if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/')) {
    await discard();
    return { status: 'unavailable', error: 'link trả về trang web thay vì ảnh' };
  }
  if (Number(response.headers.get('content-length')) > maxBytes) { await discard(); return { status: 'failed', error: tooBigReason(maxBytes) }; }
  try {
    return { bytes: await readCapped(response.body, maxBytes) };
  } catch (error) {
    if (error instanceof TooBigError) return { status: 'failed', error: tooBigReason(maxBytes) };
    return networkProblem(error, signal, timeoutMs);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Zalo's photo cache on this PC
// ---------------------------------------------------------------------------------------------------------------------

const IMAGE_FILE = /\.(jpe?g|png|jxl)$/i;

/** %APPDATA%\ZaloData\media\<uid>\ZaloDownloads for every Zalo account on this PC. */
function mediaRootsOf(appData) {
  if (!appData) return [];
  const base = join(appData, 'ZaloData', 'media');
  try {
    return readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => join(base, d.name, 'ZaloDownloads')).filter(p => existsSync(p));
  } catch {
    return [];
  }
}

/**
 * The cached picture files of the given conversations, keyed 'm:<convId>:<msgId>' (picture folder) and
 * 'c:<convId>:<cliMsgId>_<fromUid>' (resource folder). One directory listing per folder.
 */
function buildCacheIndex(convIds, roots) {
  const index = new Map();
  const add = (key, path) => { if (!index.has(key)) index.set(key, []); index.get(key).push(path); };
  for (const root of roots) {
    for (const convId of convIds) {
      const folders = [
        [join(root, 'picture', convId.startsWith('g') ? `${convId.slice(1)}_group` : convId), name => /^z([^_]+)_/.exec(name)?.[1], 'm'],
        [join(root, 'resource', convId, 'picture'), name => { const m = /^([^_]+)_([^_]+)_/.exec(name); return m && `${m[1]}_${m[2]}`; }, 'c'],
      ];
      for (const [dir, keyOf, kind] of folders) {
        let names;
        try { names = readdirSync(dir); } catch { continue; }
        for (const name of names) {
          const key = IMAGE_FILE.test(name) && keyOf(name);
          if (key) add(`${kind}:${convId}:${key}`, join(dir, name));
        }
      }
    }
  }
  return index;
}

/** On-disk copies of one image, JPEG/PNG renditions before JXL: our own stored file (re-scan), the localPath, then Zalo's cache folders. */
function localCandidates(row, index, { rootDir, appData }) {
  const paths = [];
  const push = p => { if (p && !paths.includes(p)) paths.push(p); };
  if (row.stored_path) push(join(rootDir, row.stored_path));
  if (row.cache_path) { push(remapLocalPath(row.cache_path, { appData })); push(row.cache_path); }
  for (const p of index.get(`m:${row.conv_id}:${row.msg_id}`) ?? []) push(p);
  if (row.cli_msg_id && row.from_uid) for (const p of index.get(`c:${row.conv_id}:${row.cli_msg_id}_${row.from_uid}`) ?? []) push(p);
  const existing = paths.filter(p => existsSync(p));
  return [...existing.filter(p => !/\.jxl$/i.test(p)), ...existing.filter(p => /\.jxl$/i.test(p))];
}

// ---------------------------------------------------------------------------------------------------------------------
// One image
// ---------------------------------------------------------------------------------------------------------------------

/** The image bytes from this PC, else from its link. Returns { bytes, format } or { status, error }. */
async function acquire(row, { maxBytes, fetchOptions, recentFrom }) {
  const problems = [];
  for (const path of row.candidates) {
    try {
      const st = statSync(path);
      if (!st.isFile() || st.size === 0) continue;
      if (st.size > maxBytes) { problems.push(`file trên máy ${tooBigReason(maxBytes)}`); continue; }
      const bytes = readFileSync(path);
      const format = imageFormat(bytes);
      if (format) return { bytes, format };
      problems.push('file trên máy không phải ảnh JPEG/PNG/JXL');
    } catch (error) {
      problems.push(`không đọc được file trên máy (${error.code ?? error.message})`);
    }
  }
  if (!row.remote_url) return { status: 'unavailable', error: [...problems, 'không có trong cache Zalo và không có link'].join('; ') };

  let transient = false;
  for (const url of [jpegVariantUrl(row.remote_url), row.remote_url].filter(Boolean)) {
    const got = await fetchImage(url, fetchOptions);
    if (got.bytes) {
      const format = imageFormat(got.bytes);
      if (format) return { bytes: got.bytes, format };
      problems.push('link trả về dữ liệu không phải ảnh JPEG/PNG/JXL');
      continue;
    }
    problems.push(got.error);
    if (got.status === 'failed') transient = true;
    if (got.host) break; // the JPEG rendition lives on the same host: the original link cannot do better
  }
  const error = [...new Set(problems)].join('; ');
  // A timeout on a link that should still be alive is worth another run; past its lifetime the link is simply gone.
  return { status: transient && row.ts >= recentFrom ? 'failed' : 'unavailable', error };
}

/** Gets, converts, OCRs and (when it has text) stores one image. Throws only for engine problems (bridge, disk). */
async function scanOne(row, ctx) {
  const got = await acquire(row, ctx);
  if (!got.bytes) return { status: got.status, error: got.error };

  let { bytes, format } = got;
  if (format === 'jxl') {
    bytes = await ctx.bridge.decodeJxl(bytes);
    format = imageFormat(bytes);
    if (format !== 'jpeg') throw new Error('bộ giải mã JXL của Zalo không trả về ảnh JPEG');
  }
  const ext = format === 'png' ? 'png' : 'jpg';
  const name = String(row.msg_id).replace(/[^\w.-]/g, '_');
  const temp = join(ctx.tempDir, `${name}-${process.pid}.${ext}`);
  writeFileSync(temp, bytes);
  try {
    const { lines } = await ctx.bridge.recognizeText(temp);
    const ocr_text = (lines ?? [])
      .filter(l => typeof l.recognition !== 'number' || l.recognition >= MIN_LINE_RECOGNITION)
      .map(l => String(l.text ?? '').trim()).filter(Boolean).join('\n') || null;
    const text_score = textScore(ocr_text);
    if (!hasText(ocr_text)) return { status: 'no_text', has_text: 0, text_score, ocr_text };

    const conv = String(row.conv_id).replace(/[^\w.-]/g, '_');
    mkdirSync(join(ctx.imagesDir, conv), { recursive: true });
    renameSync(temp, join(ctx.imagesDir, conv, `${name}.${ext}`));
    return { status: 'stored', has_text: 1, text_score, ocr_text, stored_path: `data/images/${conv}/${name}.${ext}` };
  } finally {
    rmSync(temp, { force: true }); // already gone after the rename
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The backlog
// ---------------------------------------------------------------------------------------------------------------------

/** shape_class for every row that has none yet, from the stored width/height (no image is read). */
function fillShapeClasses(db) {
  const rows = db.raw.prepare('SELECT msg_id, width, height FROM images WHERE shape_class IS NULL').all();
  db.transaction(() => { for (const r of rows) db.upsertImage({ msg_id: r.msg_id, shape_class: shapeClass(r.width, r.height) }); });
}

/** The shapes that are scanned. Every other image (shape_class 'photo') is never fetched or OCRed, not even by --rescan. */
const SCANNED_SHAPES = Object.freeze(['phone_screenshot', 'desktop_screenshot']);
const SCANNED_SHAPES_SQL = SCANNED_SHAPES.map(s => `'${s}'`).join(', ');

/** A screenshot whose scan failed this many times is no longer retried (only --rescan brings it back). */
const MAX_ATTEMPTS = 3;

function selectRows(db, rescan) {
  const pending = rescan ? '' : "AND (i.scanned_at IS NULL OR i.status = 'failed') AND COALESCE(i.fail_count, 0) < " + MAX_ATTEMPTS;
  return db.raw.prepare(
    `SELECT i.msg_id, i.conv_id, i.ts, i.width, i.height, i.remote_url, i.cache_path, i.stored_path, i.shape_class, i.status, i.fail_count,
            m.cli_msg_id, m.from_uid
       FROM images i LEFT JOIN messages m ON m.msg_id = i.msg_id
      WHERE i.shape_class IN (${SCANNED_SHAPES_SQL}) ${pending}`).all().map(r => ({ ...r }));
}

/**
 * Live links first, before they expire, oldest first (the next to expire go first); then older images that are on this
 * PC, then the rest (which are mostly gone), newest first. Images that failed before come after every never-tried one,
 * in the same order among themselves, so a few persistent failures cannot block the queue.
 */
function priority(rows, recentFrom) {
  const keyed = rows.map(r => {
    const recent = r.ts >= recentFrom;
    const tier = (r.status === 'failed' ? 3 : 0) + (recent ? 0 : (r.candidates.length > 0 ? 1 : 2));
    return { r, tier, recent };
  });
  return keyed
    .sort((a, b) => a.tier - b.tier || (a.recent ? a.r.ts - b.r.ts : b.r.ts - a.r.ts) || (a.r.msg_id < b.r.msg_id ? -1 : 1))
    .map(x => x.r);
}

/** Temp files of zmi image runs: <msgId>-<pid>.<ext> in data/images/.tmp/. */
const TEMP_FILE = /^[\w.-]+-(\d+)\.(jpg|png)$/;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // exists but belongs to someone else
  }
}

/** Deletes temp files that runs which are no longer alive left behind (a hard-killed run cannot clean up). */
function sweepTempFiles(tempDir) {
  let files = 0;
  let bytes = 0;
  let names;
  try { names = readdirSync(tempDir); } catch { return { files, bytes }; }
  for (const name of names) {
    const m = TEMP_FILE.exec(name);
    if (!m || Number(m[1]) === process.pid || processAlive(Number(m[1]))) continue;
    const path = join(tempDir, name);
    try {
      const size = statSync(path).size;
      rmSync(path);
      files++;
      bytes += size;
    } catch { /* gone meanwhile */ }
  }
  return { files, bytes };
}

/** True when `path` is strictly inside `dir` (both absolute). */
function isInside(dir, path) {
  const rel = relative(dir, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Deletes the stored files of photo-shaped images (left by the earlier all-images scan) and marks those rows
 * status 'text_only', stored_path NULL. Their ocr_text, has_text and text_score stay, and so does their full-text search entry.
 * Only a path that resolves inside <rootDir>/data/images/ is ever deleted; any other stored_path is refused and left alone.
 * A file that is already gone is fine. Also sweeps data/images/.tmp/ of temp files whose run is no longer alive.
 * @returns {{ pruned: number, bytesFreed: number, missing: number, refused: string[], tempFiles: number, tempBytes: number }}
 */
export function prunePhotoImages(db, { rootDir = REPO_ROOT } = {}) {
  const imagesDir = join(resolve(rootDir), 'data', 'images');
  const result = { pruned: 0, bytesFreed: 0, missing: 0, refused: [], tempFiles: 0, tempBytes: 0 };
  const rows = db.raw.prepare("SELECT msg_id, stored_path FROM images WHERE shape_class = 'photo' AND stored_path IS NOT NULL").all();
  for (const { msg_id, stored_path } of rows) {
    const path = resolve(rootDir, stored_path);
    if (!isInside(imagesDir, path)) { result.refused.push(msg_id); continue; }
    let st = null;
    try { st = statSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (st && !st.isFile()) { result.refused.push(msg_id); continue; }
    if (st) {
      rmSync(path);
      result.bytesFreed += st.size;
    } else {
      result.missing++;
    }
    db.upsertImage({ msg_id, stored_path: null, status: 'text_only' });
    result.pruned++;
  }
  const swept = sweepTempFiles(join(imagesDir, '.tmp'));
  result.tempFiles = swept.files;
  result.tempBytes = swept.bytes;
  return result;
}

const connectionLost = error => error instanceof CdpError && error.code === 'SOCKET_FAILED';

/**
 * Scans the screenshot-shaped images that were never scanned (or failed last time); `rescan` scans every screenshot again.
 * Photo-shaped images are never scanned.
 * Per image: the picture from this PC or its link, JXL decoded by Zalo, Zalo's OCR, the verdict, and the file under
 * data/images/<convId>/<msgId>.jpg when it has text. Written per image: shape_class, status (stored | no_text |
 * unavailable | failed), has_text, text_score, ocr_text (also into full-text search), stored_path, scanned_at, error.
 * A failed image keeps scanned_at as it was and is tried again by the next run.
 * Stops starting new images when the drive has less than `minFreeBytes` free or the Zalo connection drops.
 * @param {object} db the lib/db.mjs API
 * @param {{ limit?: number, bridge: { decodeJxl: Function, recognizeText: Function, ocrSupported?: Function }, rescan?: boolean,
 *   rootDir?: string, concurrency?: number, appData?: string, fetchFn?: typeof guardedFetch, lookup?: Function, statfs?: Function,
 *   minFreeBytes?: number, maxBytes?: number, timeoutMs?: number, now?: () => number, onProgress?: (event: object) => void }} options
 *   `bridge` is the Zalo bridge (its decoder and OCR are required). `onProgress` gets { type: 'start', total },
 *   { type: 'image', done, total, row, result } per image, { type: 'disk-stop', free, needed } and { type: 'abort', reason }.
 * @returns {Promise<object>} total, scanned, withText, stored, no_text, unavailable, failed, untouched, errors (reason -> count),
 *   diskStop ({ free, needed } or null), aborted (reason or null), seconds
 */
export async function scanImages(db, {
  limit, bridge, rescan = false, rootDir = REPO_ROOT, concurrency = CONCURRENCY, appData = process.env.APPDATA, fetchFn = guardedFetch,
  lookup, statfs: statfsFn = statfs, minFreeBytes = MIN_FREE_BYTES, maxBytes = MAX_IMAGE_BYTES, timeoutMs = FETCH_TIMEOUT_MS,
  now = Date.now, onProgress,
} = {}) {
  if (typeof bridge?.recognizeText !== 'function' || typeof bridge?.decodeJxl !== 'function') {
    throw new TypeError('Quét chữ trong ảnh cần OCR và bộ giải mã ảnh của Zalo: hãy mở Zalo ở chế độ thu thập (lối tắt "Zalo (MI)").');
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`scanImages: concurrency must be 1 or more, got ${String(concurrency)}`);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new RangeError(`scanImages: limit must be a whole number, 1 or more, got ${String(limit)}`);
  if (typeof bridge.ocrSupported === 'function') {
    const support = await bridge.ocrSupported();
    if (support && support.supported === false) throw new Error(`OCR của Zalo không dùng được trên máy này (${support.reason ?? 'không rõ lý do'}).`);
  }

  const started = Date.now();
  fillShapeClasses(db);
  const root = resolve(rootDir);
  const recentFrom = now() - RECENT_DAYS * DAY_MS;
  let rows = selectRows(db, rescan);
  const index = buildCacheIndex([...new Set(rows.map(r => r.conv_id))], mediaRootsOf(appData));
  for (const r of rows) r.candidates = localCandidates(r, index, { rootDir: root, appData });
  rows = priority(rows, recentFrom);
  if (limit !== undefined) rows = rows.slice(0, limit);

  const summary = {
    total: rows.length, scanned: 0, withText: 0, stored: 0, no_text: 0, unavailable: 0, failed: 0, untouched: 0,
    errors: new Map(), diskStop: null, aborted: null, seconds: 0,
  };
  const emit = event => { try { onProgress?.(event); } catch { /* progress output must never break the run */ } };
  emit({ type: 'start', total: rows.length });
  if (rows.length === 0) return summary;

  const imagesDir = join(root, 'data', 'images');
  const ctx = { bridge, imagesDir, tempDir: join(imagesDir, '.tmp'), maxBytes, recentFrom, fetchOptions: { fetchFn, lookup, maxBytes, timeoutMs } };
  mkdirSync(ctx.tempDir, { recursive: true });
  sweepTempFiles(ctx.tempDir);

  let next = 0;
  let stopped = false;
  let failuresInARow = 0;

  async function handle(row) {
    const free = await freeBytes(statfsFn, imagesDir);
    if (free !== null && free < minFreeBytes) {
      stopped = true;
      summary.diskStop ??= { free, needed: minFreeBytes };
      emit({ type: 'disk-stop', free, needed: minFreeBytes });
      return;
    }

    let result;
    try {
      result = await scanOne(row, ctx);
    } catch (error) {
      if (connectionLost(error) || error?.code === 'ENOSPC') {
        stopped = true;
        summary.aborted ??= error?.code === 'ENOSPC' ? 'ổ đĩa đã đầy' : `mất kết nối tới Zalo (${error.message})`;
        emit({ type: 'abort', reason: summary.aborted });
        return;
      }
      result = { status: 'failed', error: `lỗi khi quét ảnh: ${error?.message ?? error}` };
    }

    const update = { msg_id: row.msg_id, status: result.status, error: result.error ?? null };
    if (result.status !== 'failed') update.scanned_at = now();
    update.fail_count = result.status === 'failed' ? (row.fail_count ?? 0) + 1 : null;
    if (result.status === 'stored' || result.status === 'no_text') Object.assign(update, { has_text: result.has_text, text_score: result.text_score, ocr_text: result.ocr_text });
    if (result.status === 'stored') update.stored_path = result.stored_path;
    db.upsertImage(update);

    summary.scanned++;
    summary[result.status]++;
    if (result.status === 'stored') summary.withText++;
    if (result.error) summary.errors.set(result.error, (summary.errors.get(result.error) ?? 0) + 1);
    // Only images that never failed before count towards the abort: those are the ones a broken engine would fail.
    if (result.status !== 'failed') failuresInARow = 0;
    else if (row.status !== 'failed') failuresInARow++;
    if (failuresInARow >= MAX_FAILURES_IN_A_ROW && !stopped) {
      stopped = true;
      summary.aborted = `${MAX_FAILURES_IN_A_ROW} ảnh lỗi liên tiếp (lỗi cuối: ${result.error})`;
      emit({ type: 'abort', reason: summary.aborted });
    }
    emit({ type: 'image', done: summary.scanned, total: rows.length, row, result });
  }

  async function worker() {
    while (!stopped && next < rows.length) await handle(rows[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  summary.untouched = rows.length - summary.scanned;
  summary.seconds = (Date.now() - started) / 1000;
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------

const MAX_REASON_LINES = 5;

/** "Đã quét 1.234 ảnh: 300 có chữ (đã lưu), 900 không có chữ, 30 không còn tải được, 4 lỗi" */
export function formatImagesSummary(s) {
  return `Đã quét ${thousands(s.scanned)} ảnh: ${thousands(s.stored)} có chữ (đã lưu), ${thousands(s.no_text)} không có chữ, ` +
    `${thousands(s.unavailable)} không còn tải được, ${thousands(s.failed)} lỗi`;
}

/** Everything `zmi images` prints after a run, as lines. */
export function formatImagesReport(s) {
  const lines = [formatImagesSummary(s)];
  if (s.seconds > 0 && s.scanned > 0) {
    const rate = (s.scanned / s.seconds).toLocaleString('vi-VN', { maximumFractionDigits: 2 });
    lines.push(`  ${thousands(Math.round(s.seconds))} giây, ${rate} ảnh/giây.`);
  }
  const reasons = [...s.errors.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of reasons.slice(0, MAX_REASON_LINES)) lines.push(`  ${thousands(n)} × ${reason}`);
  if (reasons.length > MAX_REASON_LINES) lines.push(`  … và ${thousands(reasons.length - MAX_REASON_LINES)} lý do khác`);
  if (s.unavailable > 0) {
    lines.push('  Ảnh "không còn tải được": không có trên máy và link Zalo đã hết hạn (link ảnh chỉ sống khoảng 2 tuần). Chạy "node zmi.mjs images" thường xuyên sau sync để ảnh mới được quét kịp.');
  }
  if (s.diskStop) {
    lines.push(`⚠ Ổ đĩa còn ${(s.diskStop.free / 1024 ** 3).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} GB, dưới mức an toàn ${s.diskStop.needed / 1024 ** 3} GB: đã dừng, còn ${thousands(s.untouched)} ảnh chưa quét.`);
    lines.push('  Giải phóng dung lượng rồi chạy lại: node zmi.mjs images');
  }
  if (s.aborted) {
    lines.push(`⚠ Đã dừng giữa chừng: ${s.aborted}. Còn ${thousands(s.untouched)} ảnh chưa quét; chạy lại "node zmi.mjs images" để tiếp tục.`);
  }
  return lines;
}

/**
 * The screenshot backlog, then the images that are not scanned by design:
 * "Trạng thái ảnh chụp màn hình trong database: 300 có chữ (đã lưu), 900 không có chữ, 30 không còn tải được, 4 lỗi, 50 chưa quét.
 *  8.000 ảnh khác (không có dáng ảnh chụp màn hình) không quét, theo thiết kế; 2.189 ảnh trong số đó chỉ còn giữ chữ OCR."
 */
export function imagesStatusLine(db) {
  const shots = {};
  let others = 0;
  let textOnly = 0;
  for (const r of db.raw.prepare('SELECT shape_class, width, height, COALESCE(status, \'pending\') AS s, COUNT(*) AS n FROM images GROUP BY shape_class, width, height, s').all()) {
    const shape = r.shape_class ?? shapeClass(r.width, r.height); // not classified yet: the next scan will classify it the same way
    if (SCANNED_SHAPES.includes(shape)) {
      shots[r.s] = (shots[r.s] ?? 0) + r.n;
    } else {
      others += r.n;
      if (r.s === 'text_only') textOnly += r.n;
    }
  }
  const n = key => thousands(shots[key] ?? 0);
  return `Trạng thái ảnh chụp màn hình trong database: ${n('stored')} có chữ (đã lưu), ${n('no_text')} không có chữ, ` +
    `${n('unavailable')} không còn tải được, ${n('failed')} lỗi, ${n('pending')} chưa quét. ` +
    `${thousands(others)} ảnh khác (không có dáng ảnh chụp màn hình) không quét, theo thiết kế` +
    (textOnly > 0 ? `; ${thousands(textOnly)} ảnh trong số đó chỉ còn giữ chữ OCR.` : '.');
}

/** What `zmi images --prune-photos` prints. */
export function formatPruneReport(r) {
  const lines = [
    `Đã xóa ${thousands(r.pruned - r.missing)} file ảnh không phải ảnh chụp màn hình (${megabytes(r.bytesFreed)} MB), giữ nguyên chữ OCR của chúng trong database và tìm kiếm.`,
  ];
  if (r.missing > 0) lines.push(`  ${thousands(r.missing)} file đã không còn trên đĩa (chỉ cập nhật database).`);
  if (r.refused.length > 0) lines.push(`  ⚠ ${thousands(r.refused.length)} đường dẫn không nằm trong data/images/ nên không xóa (msg_id: ${r.refused.slice(0, 5).join(', ')}${r.refused.length > 5 ? ', …' : ''}).`);
  if (r.tempFiles > 0) lines.push(`  Dọn ${thousands(r.tempFiles)} file tạm còn sót trong data/images/.tmp/ (${megabytes(r.tempBytes)} MB).`);
  return lines;
}

/** scanImages plus the Vietnamese progress and summary output of `zmi images`. Prints nothing when there is nothing to scan. */
export async function scanAndReport(db, options, { log = console.log } = {}) {
  let withText = 0;
  const summary = await scanImages(db, {
    ...options,
    onProgress: event => {
      if (event.type === 'start' && event.total > 0) log(`Quét chữ trong ảnh chụp màn hình: ${thousands(event.total)} ảnh (ảnh còn link trước, ảnh sắp hết hạn link trước nhất; ảnh không có dáng ảnh chụp màn hình không quét, theo thiết kế)...`);
      if (event.type === 'image') {
        if (event.result.status === 'stored') withText++;
        if (event.done % PROGRESS_EVERY === 0 || event.done === event.total) log(`  ${thousands(event.done)}/${thousands(event.total)} ảnh (${thousands(withText)} có chữ)`);
      }
      options.onProgress?.(event);
    },
  });
  if (summary.total > 0) for (const line of formatImagesReport(summary)) log(line);
  return summary;
}
