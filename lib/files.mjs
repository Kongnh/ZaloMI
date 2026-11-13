// Stores the files shared in the tracked groups under data/files/ (spec 6.5).
//
//   resolveFile(row, options)   one files row: copy it from this PC, else download it, else say why not
//   resolveFiles(db, options)   the backlog of rows (status NULL by default), a few at a time, one DB update per row
//   remapLocalPath(path)        Zalo moved its download cache; maps an old localPath to where the file is now
//
// What each acquisition path is allowed to do (rulings R1 and the Task 6 spike):
//   1. a file that is already on this PC: the message's own localPath, or the matching Media.File row's
//      localPath/folderPath (read through the read-only bridge). Copied, never moved.
//   2. a plain HTTP GET of the message's href (lib/net.mjs guardedFetch: public hosts only, checked at connect time and
//      on every redirect, so a sender-controlled href cannot reach this PC, e.g. Zalo's debug port; no cookies).
// Nothing here calls a Zalo download or write function. An in-page GET with Zalo's session was measured in the spike and
// answered exactly what the plain GET did on every link (200 while the link lives, 404/502 once it expired), so it is not
// built. Links live for a few weeks (still downloadable at 8 days, expired at 16 days for most files, one file still worked at 22 days): files older than that survive only as a local copy.
//
// Never trusts a download: HTML pages, wrong magic bytes, a size or MD5 that differs from what Zalo advertised are all
// refused, and the bytes only reach their final name through a temp file + rename.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { extname, join, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guardedFetch, NetGuardError } from './net.mjs';

export const WANTED_EXTENSIONS = Object.freeze(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'zip', 'rar', 'jpg', 'jpeg', 'png']);
export const MAX_FILE_BYTES = 100 * 1024 * 1024;
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
const STALL_MS = 60_000;
const MAX_NAME_LENGTH = 150;
const UTC7_MS = 7 * 3600_000;
const MB = 1024 * 1024;

const WANTED = new Set(WANTED_EXTENSIONS);
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const startsWith = (buf, bytes) => bytes.every((b, i) => buf[i] === b);
const ascii = s => [...s].map(c => c.charCodeAt(0));

// Formats with a reliable signature. A downloaded file without an MD5 to check must carry one of these.
const MAGIC_BY_EXT = {
  pdf: head => head.subarray(0, 1024).includes('%PDF-'),
  zip: head => startsWith(head, ascii('PK\x03\x04')) || startsWith(head, ascii('PK\x05\x06')),
  rar: head => startsWith(head, ascii('Rar!')),
  jpg: head => startsWith(head, [0xff, 0xd8, 0xff]),
  png: head => startsWith(head, [0x89, 0x50, 0x4e, 0x47]),
};
MAGIC_BY_EXT.docx = MAGIC_BY_EXT.xlsx = MAGIC_BY_EXT.pptx = MAGIC_BY_EXT.zip;
MAGIC_BY_EXT.jpeg = MAGIC_BY_EXT.jpg;
// Old binary Office files are OLE containers, but a renamed .docx or an RTF is common enough to accept too.
MAGIC_BY_EXT.doc = MAGIC_BY_EXT.xls = MAGIC_BY_EXT.ppt = head =>
  startsWith(head, OLE) || MAGIC_BY_EXT.zip(head) || startsWith(head, ascii('{\\rtf'));

/** 1234567 -> '1.234.567' (Vietnamese grouping). Shared with lib/images.mjs. */
export const thousands = n => Number(n).toLocaleString('vi-VN');
/** Bytes -> MB with one decimal, Vietnamese style ('310,4'). Shared with lib/images.mjs. */
export const megabytes = bytes => (bytes / MB).toLocaleString('vi-VN', { maximumFractionDigits: 1 });

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Zalo's download cache moved from %LOCALAPPDATA%\ZaloPC\<uid>\ZaloDownloads\ to %APPDATA%\ZaloData\media\<uid>\ZaloDownloads\.
 * Any path through the old root is rewritten (either slash style in, Windows backslashes out); other paths, and null, pass through.
 * @param {string|null|undefined} p
 * @param {{ appData?: string }} [options] defaults to %APPDATA%
 */
export function remapLocalPath(p, { appData = process.env.APPDATA } = {}) {
  if (typeof p !== 'string' || p === '') return p ?? null;
  const m = /[\\/]ZaloPC[\\/]([^\\/]+)[\\/]ZaloDownloads[\\/]/i.exec(p);
  if (!m || !appData) return p;
  return win32.join(appData, 'ZaloData', 'media', m[1], 'ZaloDownloads', p.slice(m.index + m[0].length));
}

/** Makes a file name safe for Windows: illegal characters and control characters removed, trailing dots/spaces trimmed, length capped (extension kept). */
export function sanitizeFileName(name, { maxLength = MAX_NAME_LENGTH } = {}) {
  let s = String(name ?? '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').replace(/^ +/, '').replace(/[. ]+$/, '');
  if (s.length > maxLength) {
    const ext = extname(s);
    const keep = ext.length > 0 && ext.length <= 12 ? ext : '';
    let stem = '';
    for (const ch of s.slice(0, s.length - keep.length)) {
      if (stem.length + ch.length > maxLength - keep.length) break;
      stem += ch;
    }
    s = stem.replace(/[. ]+$/, '') + keep;
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s.split('.')[0])) s = `_${s}`;
  return s;
}

/** The calendar date of `ts` (ms) in UTC+7, "YYYY-MM-DD". */
export const fileDate = ts => new Date(Number(ts) + UTC7_MS).toISOString().slice(0, 10);

/** Lowercase extension of a files row (the ext column, else the file name's), without the dot. */
export function fileExt(row) {
  return String(row.ext || extname(row.file_name ?? '').slice(1)).toLowerCase();
}

/** Why a row is not stored at all ('loại file không lưu' / 'quá 100 MB'), or null when it is wanted. */
export function skipReason(row, { maxBytes = MAX_FILE_BYTES, allExtensions = false } = {}) {
  if (!allExtensions && !WANTED.has(fileExt(row))) return 'loại file không lưu';
  if (row.size !== null && row.size !== undefined && Number(row.size) > maxBytes) return oversizeReason(maxBytes);
  return null;
}

const oversizeReason = maxBytes => `quá ${thousands(maxBytes / MB)} MB`;

/**
 * The Media.File row that belongs to a message. cliMsgId is not unique, so among rows sharing it prefer the same
 * sender, then the nearest send time.
 * @param {object[]} mediaRows rows from Bridge.getMediaRows(convId, 'File')
 * @param {{ cli_msg_id: string|null, from_uid: string|null, ts: number }} message
 */
export function pickMediaRow(mediaRows, { cli_msg_id, from_uid, ts }) {
  if (!cli_msg_id) return null;
  let rows = mediaRows.filter(r => String(r.cliMsgId) === String(cli_msg_id));
  if (rows.length > 1) {
    const sameSender = rows.filter(r => String(r.fromUid) === String(from_uid));
    if (sameSender.length > 0) rows = sameSender;
  }
  if (rows.length > 1) rows = [...rows].sort((a, b) => Math.abs(Number(a.sendDttm) - ts) - Math.abs(Number(b.sendDttm) - ts));
  return rows[0] ?? null;
}

/** Candidate on-disk locations for a row: the message's own paths, then the Media.File row's, each remapped and as stored. */
export function localCandidates(rawJson, mediaRow, { appData } = {}) {
  let raw = null;
  try { raw = rawJson ? JSON.parse(rawJson) : null; } catch { /* a raw_json we cannot read just has no paths */ }
  const out = [];
  for (const p of [raw?.localPath, raw?.folderPath, mediaRow?.localPath, mediaRow?.folderPath]) {
    if (typeof p !== 'string' || p === '') continue;
    for (const candidate of [remapLocalPath(p, { appData }), p]) if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

// The first bytes read like a web page (after an optional UTF-8 byte order mark and whitespace).
const looksLikeHtml = head => {
  const start = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  return /^\s*<(?:!doctype html|html|head|body)/i.test(head.subarray(start, 512).toString('latin1'));
};

// ---------------------------------------------------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------------------------------------------------

class StallError extends Error {}
class TooBigError extends Error {}

const md5OfFileSync = path => createHash('md5').update(readFileSync(path)).digest('hex');
const isMd5 = s => typeof s === 'string' && /^[0-9a-f]{32}$/i.test(s);

/** Copies/streams `source` into `tempPath`, hashing it on the way. Returns { md5, bytes, head }. */
async function streamToTemp(source, tempPath, { maxBytes, signal, onChunk }) {
  const hash = createHash('md5');
  let bytes = 0;
  let head = Buffer.alloc(0);
  async function* measure(chunks) {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new TooBigError();
      hash.update(chunk);
      if (head.length < 1024) head = Buffer.concat([head, chunk]).subarray(0, 1024);
      onChunk?.();
      yield chunk;
    }
  }
  const stages = [source, measure, createWriteStream(tempPath)];
  await (signal ? pipeline(...stages, { signal }) : pipeline(...stages));
  return { md5: hash.digest('hex'), bytes, head };
}

/** Moves a finished temp file to its final name, never overwriting a different file. Returns the file name used. */
function placeFile(tempPath, md5, { dir, name, msgId }) {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let attempt = 0; ; attempt++) {
    const candidate = attempt === 0 ? name : `${stem}_${msgId}${attempt > 1 ? `_${attempt}` : ''}${ext}`;
    const target = join(dir, candidate);
    if (!existsSync(target)) { renameSync(tempPath, target); return candidate; }
    if (md5OfFileSync(target) === md5) { rmSync(tempPath, { force: true }); return candidate; } // the same file is already there
  }
}

function networkError(error, abortReason, stallMs) {
  if (error instanceof NetGuardError) return error.message;
  if (abortReason instanceof StallError || error instanceof StallError) return `quá thời gian chờ (không nhận thêm dữ liệu trong ${Math.round(stallMs / 1000)} giây)`;
  const code = error?.cause?.code ?? error?.code;
  if (code === 'ENOTFOUND') return 'không phân giải được máy chủ (ENOTFOUND)';
  if (code) return `lỗi mạng (${code})`;
  return `lỗi mạng: ${error?.message ?? error}`;
}

/** Status + message for a non-2xx answer. 401/403: the link exists but refuses us. */
function httpProblem(status) {
  if (status === 401 || status === 403) return { status: 'remote_only', error: `HTTP ${status} (link còn nhưng cần đăng nhập Zalo)` };
  if (status === 404 || status === 410) return { status: 'failed', error: `HTTP ${status} (link đã hết hạn)` };
  return { status: 'failed', error: `HTTP ${status}` };
}

/**
 * Checks what arrived. `head` is the first bytes, `bytes` the count, `md5` the hash.
 * With an advertised MD5 that is the whole check; without one the size must match and the format signature must fit.
 * `fromServer` adds the checks that only make sense for a download (an HTML page, a wrong signature): a file the user
 * already has on disk is theirs, whatever it looks like.
 * @returns {{ status: 'remote_only'|'failed', error: string } | null} null when the content is acceptable
 */
function contentProblem(row, { md5, bytes, head }, { fromServer }) {
  if (bytes === 0) return { status: 'failed', error: 'file rỗng (0 byte)' };
  if (fromServer && looksLikeHtml(head)) return { status: 'remote_only', error: 'trả về trang HTML thay vì file' };
  if (isMd5(row.checksum)) {
    return md5 === row.checksum.toLowerCase() ? null : { status: 'failed', error: 'checksum MD5 không khớp với Zalo' };
  }
  if (row.size !== null && row.size !== undefined && bytes !== Number(row.size)) {
    return { status: 'failed', error: `kích thước ${bytes} byte khác ${row.size} byte Zalo báo` };
  }
  const magic = MAGIC_BY_EXT[fileExt(row)];
  if (fromServer && magic && !magic(head)) return { status: 'failed', error: `nội dung không phải file .${fileExt(row)}` };
  return null;
}

/**
 * Brings one file in. Order: a copy that is already on this PC (`localPaths`), then a download of `remote_url`.
 * Never throws for a bad file; the result says what happened.
 * @param {{ msg_id: string, conv_id: string, ts: number, file_name: string|null, ext: string|null, size: number|null,
 *   checksum: string|null, remote_url: string|null, status?: string|null, stored_path?: string|null }} row a files row
 * @param {{ rootDir: string, localPaths?: string[], fetchFn?: typeof guardedFetch, maxBytes?: number, stallMs?: number }} options
 *   `rootDir` is the repo root: files go to <rootDir>/data/files/<convId>/ and stored_path is relative to it.
 *   `outDir` (zmi chat) sends the file to that folder instead and stored_path is then absolute; `allExtensions` stores
 *   every file type, not only WANTED_EXTENSIONS. Neither touches the database: that is the caller's business.
 * @returns {Promise<{ status: 'stored'|'remote_only'|'failed'|'skipped', stored_path?: string, error?: string, bytes?: number, source?: 'existing'|'local'|'download' }>}
 */
export async function resolveFile(row, { rootDir, outDir, allExtensions = false, localPaths = [], fetchFn = guardedFetch, maxBytes = MAX_FILE_BYTES, stallMs = STALL_MS } = {}) {
  if (!outDir && row.status === 'stored' && row.stored_path && existsSync(join(rootDir, row.stored_path))) {
    return { status: 'stored', stored_path: row.stored_path, bytes: statSync(join(rootDir, row.stored_path)).size, source: 'existing' };
  }
  const skip = skipReason(row, { maxBytes, allExtensions });
  if (skip) return { status: 'skipped', error: skip };

  const dir = outDir ?? join(rootDir, 'data', 'files', row.conv_id);
  mkdirSync(dir, { recursive: true });
  const ext = fileExt(row);
  const originalName = sanitizeFileName(row.file_name) || `file_${row.msg_id}${ext ? `.${ext}` : ''}`;
  const name = `${fileDate(row.ts)}_${originalName}`;
  const tempPath = join(dir, `.zmi-${row.msg_id}-${process.pid}.part`);
  const problems = [];

  const finish = (written, source) => {
    const placed = placeFile(tempPath, written.md5, { dir, name, msgId: row.msg_id });
    return { status: 'stored', stored_path: outDir ? join(outDir, placed) : `data/files/${row.conv_id}/${placed}`, bytes: written.bytes, source };
  };

  // 1. A copy already on this PC.
  for (const path of localPaths) {
    let st;
    try { st = statSync(path); } catch { continue; }
    if (!st.isFile()) continue; // a folder (Zalo's folderPath for an unpacked archive) is not the file
    if (row.size !== null && row.size !== undefined && st.size !== Number(row.size)) { problems.push('file trên máy có kích thước khác'); continue; }
    try {
      const written = await streamToTemp(createReadStream(path), tempPath, { maxBytes });
      const problem = contentProblem(row, written, { fromServer: false });
      if (!problem) return finish(written, 'local');
      problems.push(`file trên máy: ${problem.error}`);
    } catch (error) {
      problems.push(error instanceof TooBigError ? 'file trên máy quá lớn' : `không đọc được file trên máy (${error.code ?? error.message})`);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }

  // 2. Download.
  if (!row.remote_url) return { status: 'failed', error: [...problems, 'không có link tải'].join('; ') };
  try {
    const outcome = await download(row, { tempPath, fetchFn, maxBytes, stallMs });
    if (outcome.written) return finish(outcome.written, 'download');
    return { status: outcome.status, error: [...problems, outcome.error].join('; ') };
  } finally {
    rmSync(tempPath, { force: true }); // gone after a successful rename; a half-written download otherwise
  }
}

/** GET of row.remote_url into tempPath. Returns { written } on success, else { status, error }. The temp file is the caller's to clean. */
async function download(row, { tempPath, fetchFn, maxBytes, stallMs }) {
  const controller = new AbortController();
  let timer;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new StallError()), stallMs); };
  arm();
  const fail = error => ({ status: 'failed', error: networkError(error, controller.signal.reason, stallMs) });
  try {
    let response;
    try {
      response = await fetchFn(row.remote_url, { signal: controller.signal });
    } catch (error) {
      return fail(error);
    }
    const discard = () => response.body?.cancel().catch(() => {});
    if (!response.ok) { await discard(); return httpProblem(response.status); }
    if ((response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html')) {
      await discard();
      return { status: 'remote_only', error: 'trả về trang HTML thay vì file' };
    }
    if (Number(response.headers.get('content-length')) > maxBytes) { await discard(); return { status: 'skipped', error: oversizeReason(maxBytes) }; }

    let written;
    try {
      written = await streamToTemp(response.body ? Readable.fromWeb(response.body) : Readable.from([]), tempPath, { maxBytes, signal: controller.signal, onChunk: arm });
    } catch (error) {
      if (error instanceof TooBigError) return { status: 'skipped', error: oversizeReason(maxBytes) };
      return fail(error);
    }
    const problem = contentProblem(row, written, { fromServer: true });
    return problem ?? { written };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The backlog
// ---------------------------------------------------------------------------------------------------------------------

/** Free bytes on the drive holding `path`, or null when it cannot be measured. Shared with lib/images.mjs. */
export async function freeBytes(statfsFn, path) {
  try {
    const s = await statfsFn(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null; // cannot tell: do not block the run on it
  }
}

/** Newest first: links expire, so the freshest files are the ones worth fetching before anything else goes wrong. */
function selectRows(db, statuses, limit) {
  const named = statuses.filter(s => s !== null);
  const where = [statuses.includes(null) ? 'f.status IS NULL' : null, named.length ? `f.status IN (${named.map(() => '?').join(', ')})` : null].filter(Boolean);
  if (where.length === 0) return [];
  const sql = `SELECT f.msg_id, f.conv_id, f.ts, f.file_name, f.ext, f.size, f.checksum, f.remote_url, f.stored_path, f.status,
                      m.cli_msg_id, m.from_uid, m.raw_json
                 FROM files f LEFT JOIN messages m ON m.msg_id = f.msg_id
                WHERE ${where.join(' OR ')} ORDER BY f.ts DESC, f.msg_id DESC${limit === undefined ? '' : ' LIMIT ?'}`;
  return db.raw.prepare(sql).all(...named, ...(limit === undefined ? [] : [limit])).map(r => ({ ...r }));
}

/** Media.File rows per conversation, read once each. Failure is reported in the summary, never thrown. */
async function loadMediaRows(bridge, convIds, summary) {
  const byConv = new Map();
  if (typeof bridge?.getMediaRows !== 'function') { summary.mediaLookup = 'none'; return byConv; }
  summary.mediaLookup = 'bridge';
  for (const convId of convIds) {
    try {
      byConv.set(convId, await bridge.getMediaRows(convId, 'File'));
    } catch (error) {
      summary.mediaLookup = 'error';
      summary.mediaError = error.message;
      break;
    }
  }
  return byConv;
}

/**
 * Resolves the files rows whose status is in `statuses` (default: NULL, i.e. never tried), newest first, `concurrency` at a time.
 * Each row gets status stored / remote_only / failed (with error) / skipped; only status, stored_path and error are written.
 * Stops starting new files when the drive has less than `minFreeBytes` free; those rows keep their status.
 * @param {object} db the lib/db.mjs API
 * @param {{ rootDir: string, bridge?: object, statuses?: (string|null)[], limit?: number, concurrency?: number,
 *   onProgress?: (event: object) => void, fetchFn?: typeof guardedFetch, statfs?: Function, minFreeBytes?: number,
 *   maxBytes?: number, stallMs?: number, appData?: string }} options
 *   `bridge` is optional (Zalo may be closed): without it only paths stored in the messages and the links are used.
 *   `onProgress` gets { type: 'start', total } once, then { type: 'file', done, total, row, result } per row and
 *   { type: 'disk-stop', free, needed } if the drive guard trips.
 * @returns {Promise<object>} counts: total, stored, remote_only, failed, skipped, alreadyStored, untouched, bytesStored,
 *   errors (reason -> count), diskStop ({ free, needed } or null), mediaLookup ('bridge'|'none'|'error'), mediaError
 */
export async function resolveFiles(db, {
  rootDir, bridge, statuses = [null], limit, concurrency = 3, onProgress, fetchFn = guardedFetch, statfs: statfsFn = statfs,
  minFreeBytes = MIN_FREE_BYTES, maxBytes = MAX_FILE_BYTES, stallMs = STALL_MS, appData = process.env.APPDATA,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir === '') throw new TypeError('resolveFiles: rootDir is required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError(`resolveFiles: concurrency must be 1 or more, got ${String(concurrency)}`);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new RangeError(`resolveFiles: limit must be a whole number, 1 or more, got ${String(limit)}`);

  const rows = selectRows(db, statuses, limit);
  const summary = {
    total: rows.length, stored: 0, remote_only: 0, failed: 0, skipped: 0, alreadyStored: 0, untouched: 0, bytesStored: 0,
    errors: new Map(), diskStop: null, mediaLookup: 'none', mediaError: null,
  };
  const emit = event => { try { onProgress?.(event); } catch { /* progress output must never break the run */ } };
  emit({ type: 'start', total: rows.length });
  if (rows.length === 0) return summary;

  const filesDir = join(rootDir, 'data', 'files');
  mkdirSync(filesDir, { recursive: true });
  const needsLookup = rows.filter(r => !(r.status === 'stored' && r.stored_path && existsSync(join(rootDir, r.stored_path))) && !skipReason(r, { maxBytes }));
  const media = await loadMediaRows(bridge, [...new Set(needsLookup.map(r => r.conv_id))], summary);

  let next = 0;
  let done = 0;
  let stopped = false;

  async function handle(row) {
    const prior = row.status === 'stored' && row.stored_path && existsSync(join(rootDir, row.stored_path));
    if (!prior && !skipReason(row, { maxBytes })) {
      const free = await freeBytes(statfsFn, filesDir);
      const needed = minFreeBytes + (Number(row.size) || 0);
      if (free !== null && free < needed) { stopped = true; summary.diskStop ??= { free, needed: minFreeBytes }; emit({ type: 'disk-stop', free, needed: minFreeBytes }); return; }
    }

    let result;
    try {
      const mediaRow = pickMediaRow(media.get(row.conv_id) ?? [], row);
      result = await resolveFile(row, { rootDir, localPaths: localCandidates(row.raw_json, mediaRow, { appData }), fetchFn, maxBytes, stallMs });
    } catch (error) {
      if (error?.code === 'ENOSPC') { stopped = true; summary.diskStop ??= { free: 0, needed: minFreeBytes }; emit({ type: 'disk-stop', free: 0, needed: minFreeBytes }); return; }
      result = { status: 'failed', error: `lỗi khi lưu file: ${error?.message ?? error}` };
    }

    if (result.source === 'existing') {
      summary.alreadyStored++;
    } else {
      db.upsertFile({ msg_id: row.msg_id, status: result.status, stored_path: result.stored_path ?? null, error: result.error ?? null });
      summary[result.status]++;
      if (result.status === 'stored') summary.bytesStored += result.bytes ?? 0;
      if (result.error && result.status !== 'skipped') summary.errors.set(result.error, (summary.errors.get(result.error) ?? 0) + 1);
    }
    done++;
    emit({ type: 'file', done, total: rows.length, row, result });
  }

  async function worker() {
    while (!stopped && next < rows.length) await handle(rows[next++]);
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  summary.untouched = rows.length - done;
  return summary;
}

// ---------------------------------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------------------------------

/** A progress line every this many items. Shared with lib/images.mjs. */
export const PROGRESS_EVERY = 25;
const MAX_REASON_LINES = 5;

/** "Đã lưu 52 file (310,4 MB), 3 chỉ có link, 640 lỗi, 150 bỏ qua" */
export function formatFilesSummary(s) {
  return `Đã lưu ${thousands(s.stored)} file (${megabytes(s.bytesStored)} MB), ${thousands(s.remote_only)} chỉ có link, ${thousands(s.failed)} lỗi, ${thousands(s.skipped)} bỏ qua`;
}

/** Everything `zmi files` / `zmi sync` print after a run, as lines. */
export function formatFilesReport(s) {
  const lines = [formatFilesSummary(s)];
  if (s.alreadyStored > 0) lines.push(`  ${thousands(s.alreadyStored)} file đã lưu từ trước, giữ nguyên.`);
  const reasons = [...s.errors.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, n] of reasons.slice(0, MAX_REASON_LINES)) lines.push(`  ${thousands(n)} × ${reason}`);
  if (reasons.length > MAX_REASON_LINES) lines.push(`  … và ${thousands(reasons.length - MAX_REASON_LINES)} lý do khác`);
  if (reasons.some(([reason]) => /hết hạn/.test(reason))) {
    lines.push('  Link file của Zalo chỉ sống vài tuần (thường 1-3 tuần): file cũ hơn chỉ còn nếu đã có trên máy. Chạy "node zmi.mjs sync" thường xuyên để file mới được lưu kịp.');
  }
  if (s.remote_only > 0) {
    lines.push('  File "chỉ có link": link còn nhưng Zalo không cho tải. Mở file trong Zalo (hoặc bật tự động tải file trong cài đặt Zalo PC) rồi chạy lại: node zmi.mjs files --retry');
  }
  if (s.mediaLookup === 'error') lines.push(`  Không đọc được bảng Media.File của Zalo (${s.mediaError}); các file vẫn được thử bằng đường dẫn trong tin và link.`);
  if (s.diskStop) {
    lines.push(`⚠ Ổ đĩa còn ${(s.diskStop.free / 1024 ** 3).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} GB, dưới mức an toàn ${s.diskStop.needed / 1024 ** 3} GB: đã dừng, còn ${thousands(s.untouched)} file chưa xử lý (giữ nguyên trạng thái).`);
    lines.push('  Giải phóng dung lượng rồi chạy lại: node zmi.mjs files');
  }
  return lines;
}

/** One line: "Trạng thái file trong database: 52 đã lưu, 3 chỉ có link, 640 lỗi, 150 bỏ qua, 0 chờ xử lý". */
export function filesStatusLine(db) {
  const counts = Object.fromEntries(db.raw.prepare('SELECT COALESCE(status, \'pending\') AS s, COUNT(*) AS n FROM files GROUP BY s').all().map(r => [r.s, r.n]));
  const n = key => thousands(counts[key] ?? 0);
  return `Trạng thái file trong database: ${n('stored')} đã lưu, ${n('remote_only')} chỉ có link, ${n('failed')} lỗi, ${n('skipped')} bỏ qua, ${n('pending')} chờ xử lý`;
}

/**
 * resolveFiles plus the Vietnamese progress and summary output shared by `zmi files` and `zmi sync`.
 * Prints nothing when there is no file to process. Returns the resolveFiles summary.
 */
export async function resolveAndReport(db, options, { log = console.log } = {}) {
  const summary = await resolveFiles(db, {
    ...options,
    onProgress: event => {
      if (event.type === 'start' && event.total > 0) log(`Lưu file đính kèm: ${thousands(event.total)} file cần xử lý (chép từ máy hoặc tải theo link, file mới nhất trước)...`);
      if (event.type === 'file' && (event.done % PROGRESS_EVERY === 0 || event.done === event.total)) log(`  ${thousands(event.done)}/${thousands(event.total)} file`);
      options.onProgress?.(event);
    },
  });
  if (summary.total > 0) for (const line of formatFilesReport(summary)) log(line);
  return summary;
}
