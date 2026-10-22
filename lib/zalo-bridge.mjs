// Read-only bridge to Zalo PC's own database manager, reached over CDP.
//
// Safety model: every call into Zalo goes through a guard that only allows the store read
// methods in STORE_ALLOWLIST. The guard runs twice, from the same source: here in Node
// (fail fast, no round trip) and inside the Zalo page (the injected reader), so a write
// call cannot reach a Zalo store even if one side is bypassed.
//
// Besides the store reads, ruling R2 allows a second, separate list of Zalo functions that only compute:
// COMPUTE_ALLOWLIST (Zalo's JXL decoder and its OCR, used by `zmi images`). They take bytes or the path of one
// of zmi's own image files and return a result; they read nothing from Zalo's data and write nothing to it.
// That list is guarded the same way, on both sides, and an OCR path inside Zalo's folders is refused on both sides.

import { connect } from './cdp.mjs';

/** The only store methods the bridge may call. Everything else (insert, put, update, delete, ...) is refused. */
export const STORE_ALLOWLIST = Object.freeze(['getAll', 'get', 'getMulti', 'count']);

/** The only Zalo compute functions the bridge may call (paths under window.$zFeatures). */
export const COMPUTE_ALLOWLIST = Object.freeze(['libjxl.decodeToJpeg', 'ocr.recognize', 'ocr.isSupported']);

const JXL_QUALITY = 90;
const JXL_TIMEOUT_MS = 30000;

/** Webpack module id the DB manager had in the spike build; tried first, then the shape search takes over. */
const FAST_PATH_MODULE_ID = 'fsN4';

const MESSAGE_INDEX = 'userId_sendDttm_msgId';
const MEDIA_INDEX = 'convId_sendDttm_cliMsgId';
const MAX_SEND_DTTM = '9999999999999999';
const MAX_ID = '9223372036854775808';
const DEFAULT_PAGE_LIMIT = 2000;
/** Zalo's getAll returns at most this many rows per read whatever `limit` is asked (observed: Media.Image 50,194 rows -> 10,000). */
const MAX_ROWS_PER_READ = 10000;
const GROUP_LIMIT = 500;
const MEDIA_STORES = Object.freeze(['File', 'Link', 'Image']);

export class BridgeError extends Error {
  /** @param {'MODULE_NOT_FOUND'|'PAGINATION_STUCK'} code */
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

// Self-contained on purpose: its source text is injected into the Zalo page (see buildPageScript),
// so it must not close over anything but its own argument.
function makeReadOnlyGuard(allowed) {
  return function readOnlyGuard(methodName) {
    if (typeof methodName !== 'string' || !allowed.includes(methodName)) {
      throw new Error(`Zalo MI chỉ đọc: không được gọi "${String(methodName)}" (chỉ cho phép ${allowed.join(', ')}).`);
    }
  };
}

// Self-contained too (injected into the page). Same shape as the store guard, separate list.
function makeComputeGuard(allowed) {
  return function computeGuard(name) {
    if (typeof name !== 'string' || !allowed.includes(name)) {
      throw new Error(`Zalo MI chỉ gọi hàm tính toán trong danh sách: không được gọi "${String(name)}" (chỉ cho phép ${allowed.join(', ')}).`);
    }
  };
}

/**
 * True for an absolute path that is not inside Zalo's data or download folders: the only files Zalo's OCR may be given are zmi's own.
 * Self-contained (injected into the page).
 */
export function isOwnImagePath(p) {
  if (typeof p !== 'string') return false;
  const absolute = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/');
  return absolute && !/[\\/](ZaloData|ZaloPC)([\\/]|$)/i.test(p) && !/(^|[\\/])\.\.([\\/]|$)/.test(p);
}

const MODULE_NOT_FOUND_MESSAGE = [
  'Không tìm thấy module quản lý database trong Zalo. Có thể Zalo chưa đăng nhập xong, hoặc vừa cập nhật và đổi cấu trúc nội bộ.',
  'Cách xử lý:',
  '  1. Đăng nhập xong, thoát hẳn Zalo rồi mở lại bằng lối tắt "Zalo (MI)", sau đó chạy lại: node zmi.mjs doctor',
  '  2. Nếu vẫn lỗi, Zalo đã đổi cấu trúc nội bộ: cần cập nhật công cụ zmi (phần tìm module trong lib/zalo-bridge.mjs) cho phiên bản Zalo mới.',
].join('\n');

const guard = makeReadOnlyGuard(STORE_ALLOWLIST);

/** Throws unless `methodName` is one of getAll/get/getMulti/count. */
export function readOnlyGuard(methodName) {
  guard(methodName);
}

const guardCompute = makeComputeGuard(COMPUTE_ALLOWLIST);

/** Throws unless `name` is one of COMPUTE_ALLOWLIST. */
export function computeGuard(name) {
  guardCompute(name);
}

const OWN_PATH_MESSAGE = 'chỉ đưa cho OCR của Zalo file ảnh của zmi, không bao giờ một file trong thư mục dữ liệu Zalo';

/**
 * Source of the script injected into the Zalo main window. Defines `window.__zmi` with:
 *   locate(useFastPath) -> { found, moduleId, via }   find the DB manager (fast path, else by shape)
 *   read(dbName, storeName, method, args)             guarded store call, the only way in
 *   compute(name, args)                               guarded call of one COMPUTE_ALLOWLIST function
 * No template literals and no backslashes below: this text is itself inside one.
 */
export function buildPageScript() {
  return `(() => {
  const ALLOWED = ${JSON.stringify(STORE_ALLOWLIST)};
  const COMPUTE = ${JSON.stringify(COMPUTE_ALLOWLIST)};
  const OWN_PATH_MESSAGE = ${JSON.stringify(OWN_PATH_MESSAGE)};
  const FAST_PATH_MODULE_ID = ${JSON.stringify(FAST_PATH_MODULE_ID)};
  const readOnlyGuard = (${makeReadOnlyGuard.toString()})(ALLOWED);
  const computeGuard = (${makeComputeGuard.toString()})(COMPUTE);
  const isOwnImagePath = ${isOwnImagePath.toString()};
  const NAME = /^[A-Z][A-Za-z]*$/;
  let db = null;

  // Webpack 4 JSONP runtime: pushing a throwaway chunk hands us webpack's require function (null if the runtime is gone).
  function webpackRequire() {
    if (!window.__zmiReq && window.webpackJsonp && typeof window.webpackJsonp.push === 'function') {
      window.webpackJsonp.push([['__zmi_probe'], { __zmi_probe: function (m, e, r) { window.__zmiReq = r; } }, [['__zmi_probe']]]);
    }
    return window.__zmiReq || null;
  }

  // The DB manager is the module whose default export has getInstance() returning an object with Core.Message.getAll.
  function dbManagerOf(exportsObject) {
    try {
      const d = exportsObject && exportsObject.default;
      if (!d || typeof d.getInstance !== 'function') return null;
      const instance = d.getInstance();
      const ok = instance && instance.Core && instance.Core.Message && typeof instance.Core.Message.getAll === 'function';
      return ok ? instance : null;
    } catch (e) {
      return null;
    }
  }

  function locate(useFastPath) {
    const req = webpackRequire();
    if (!req) return { found: false };
    const cache = req.c || {};
    if (useFastPath) {
      const hit = cache[FAST_PATH_MODULE_ID] && dbManagerOf(cache[FAST_PATH_MODULE_ID].exports);
      if (hit) { db = hit; return { found: true, moduleId: FAST_PATH_MODULE_ID, via: 'fast-path' }; }
    }
    for (const id of Object.keys(cache)) {
      const hit = cache[id] && dbManagerOf(cache[id].exports);
      if (hit) { db = hit; return { found: true, moduleId: id, via: 'shape-search' }; }
    }
    return { found: false };
  }

  async function read(dbName, storeName, method, args) {
    readOnlyGuard(method);
    if (!NAME.test(dbName) || !NAME.test(storeName)) throw new Error('Tên database/store không hợp lệ.');
    if (!db && !locate(true).found) throw new Error('Không tìm thấy module quản lý database của Zalo.');
    const store = db[dbName] && db[dbName][storeName];
    if (!store || typeof store[method] !== 'function') throw new Error('Zalo không có ' + dbName + '.' + storeName + '.' + method + '.');
    // JSON cannot carry undefined; a null argument stands for undefined (e.g. getAll(undefined, opts)).
    return store[method](...args.map(a => (a === null ? undefined : a)));
  }

  // Bytes cross CDP as base64 text, one image at a time.
  function fromBase64(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
    return btoa(bin);
  }
  const reason = e => (e && e.message) || String(e);

  async function compute(name, args) {
    computeGuard(name);
    const features = window.$zFeatures || {};
    const [group, fn] = name.split('.');
    if (!features[group] || typeof features[group][fn] !== 'function') {
      throw new Error('Zalo này không có ' + (group === 'ocr' ? 'OCR' : 'bộ giải mã JXL') + ' ($zFeatures.' + name + '): có thể Zalo vừa cập nhật, cần cập nhật công cụ zmi (lib/zalo-bridge.mjs).');
    }
    if (name === 'libjxl.decodeToJpeg') {
      let res;
      try {
        res = await features.libjxl.decodeToJpeg(fromBase64(args[0]), args[1], { timeout: args[2] });
      } catch (e) {
        throw new Error('Zalo không giải mã được ảnh JXL: ' + reason(e));
      }
      if (!res || res.status_code !== 1 || !res.data) throw new Error('Zalo không giải mã được ảnh JXL (mã ' + (res && res.status_code) + ').');
      return toBase64(res.data);
    }
    if (name === 'ocr.recognize') {
      if (!isOwnImagePath(args[0])) throw new Error('Không cho OCR của Zalo đọc file này: ' + OWN_PATH_MESSAGE + '.');
      const res = await features.ocr.recognize(args[0]);
      if (!res || !res.success) throw new Error('OCR của Zalo báo lỗi: ' + ((res && res.error && res.error.message) || 'không rõ lý do'));
      const lines = (res.result && res.result.lines) || [];
      return { lines: lines.map(l => ({ text: String(l.text || ''), recognition: l.scores ? l.scores.recognition : null })) };
    }
    return features.ocr.isSupported();
  }

  window.__zmi = { locate, read, compute };
})()`;
}

/** Rejects options that would make a scan stop early without saying so. */
function assertPaging({ limit, maxPages }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ROWS_PER_READ) {
    throw new RangeError(
      `limit phải là số nguyên từ 1 đến ${MAX_ROWS_PER_READ} (Zalo chỉ trả tối đa ${MAX_ROWS_PER_READ} dòng mỗi lần đọc), nhận được: ${String(limit)}`);
  }
  if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages < 1)) {
    throw new RangeError(`maxPages phải là số nguyên từ 1 trở lên, nhận được: ${String(maxPages)}`);
  }
}

/**
 * Pages through a descending index range, newest first, without losing rows at page boundaries.
 * The upper bound of each next page is the last (oldest) row of the previous one, inclusive, and rows
 * are de-duplicated by id, so rows sharing an index key (equal sendDttm, or the non-unique Media index)
 * are never skipped. If a full page brings nothing new, more than one page of rows share the boundary
 * key: the same page is re-read with a doubled limit until the tie group fits. Beyond Zalo's per-read cap
 * that cannot work, so it throws instead of returning a truncated list.
 * `maxPages` caps the number of reads (a widened re-read counts as one).
 */
async function collectPages({ limit, maxPages = Infinity, idOf, fetchPage, nextBound }) {
  const seen = new Set();
  const rows = [];
  let bound = null;
  let pageLimit = limit;
  for (let page = 0; page < maxPages; page++) {
    const batch = await fetchPage(bound, pageLimit);
    let added = 0;
    for (const row of batch) {
      const id = idOf(row);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(row);
      added++;
    }
    if (batch.length < pageLimit) break; // short page: nothing older is left
    if (added > 0) {
      bound = nextBound(batch[batch.length - 1]);
      pageLimit = limit;
    } else if (pageLimit >= MAX_ROWS_PER_READ) {
      throw new BridgeError('PAGINATION_STUCK',
        `Hơn ${MAX_ROWS_PER_READ} dòng trong Zalo có cùng khóa sắp xếp nên không đọc hết được (Zalo chỉ trả tối đa ${MAX_ROWS_PER_READ} dòng mỗi lần đọc).`);
    } else {
      pageLimit = Math.min(pageLimit * 2, MAX_ROWS_PER_READ);
    }
  }
  return rows;
}

/**
 * Builds a Bridge on top of an open CDP connection ({ evaluate, close }).
 * @throws {BridgeError} MODULE_NOT_FOUND when no webpack module has the DB manager shape.
 */
export async function createBridge(connection) {
  await connection.evaluate(buildPageScript());

  let info = null;

  async function locate({ fastPath = true } = {}) {
    const found = await connection.evaluate(`window.__zmi.locate(${fastPath ? 'true' : 'false'})`);
    if (!found.found) {
      throw new BridgeError('MODULE_NOT_FOUND', MODULE_NOT_FOUND_MESSAGE);
    }
    info = { moduleId: found.moduleId, via: found.via };
    return { ...info };
  }

  // Every store call goes through here: guard in Node first, then again inside the page.
  function read(dbName, storeName, method, args) {
    readOnlyGuard(method);
    return connection.evaluate(
      `window.__zmi.read(${JSON.stringify(dbName)}, ${JSON.stringify(storeName)}, ${JSON.stringify(method)}, ${JSON.stringify(args)})`,
    );
  }

  // Every compute call goes through here: compute guard in Node first, then again inside the page.
  function compute(name, args) {
    computeGuard(name);
    return connection.evaluate(`window.__zmi.compute(${JSON.stringify(name)}, ${JSON.stringify(args)})`);
  }

  await locate({ fastPath: true });

  return {
    /** How the DB manager was found: { moduleId, via: 'fast-path' | 'shape-search' }. */
    get info() { return { ...info }; },
    locate,
    readOnlyGuard,

    /** Every group on this Zalo PC: [{ convId, name, description, totalMember, isGroup }] (description is null when the group has none). */
    async listGroups() {
      const rows = await read('Core', 'Group', 'getAll', [null, { limit: GROUP_LIMIT }]);
      return rows.map(g => ({ convId: g.userId, name: g.displayName, description: g.desc ?? null, totalMember: g.totalMember, isGroup: g.isGroup }));
    },

    /**
     * Raw message rows of one conversation, newest first.
     * `fromTs` is an inclusive lower bound on sendDttm; `limit` is the page size (integer, 1 to 10,000);
     * `maxPages` caps the number of reads. A `limit` or `maxPages` that cannot be honoured throws RangeError.
     */
    async getMessages(convId, { fromTs, limit = DEFAULT_PAGE_LIMIT, maxPages } = {}) {
      assertPaging({ limit, maxPages });
      const from = [convId, fromTs === undefined || fromTs === null ? '' : String(fromTs), ''];
      return collectPages({
        limit,
        maxPages,
        idOf: m => m.msgId,
        fetchPage: (bound, pageLimit) => read('Core', 'Message', 'getAll', [
          { from, to: bound ?? [convId, MAX_SEND_DTTM, MAX_ID], excludeFrom: false, excludeTo: false },
          { index: MESSAGE_INDEX, limit: pageLimit, direction: 'prev', partition: convId, useLGKeyRange: true },
        ]),
        nextBound: last => [convId, last.sendDttm, last.msgId],
      });
    },

    /**
     * Rows of Media.File / Media.Link / Media.Image for one conversation (rows carry convId and cliMsgId), newest first.
     * `limit` is the page size (integer, 1 to 10,000); the whole conversation is always returned.
     */
    async getMediaRows(convId, store, { limit = DEFAULT_PAGE_LIMIT } = {}) {
      if (!MEDIA_STORES.includes(store)) {
        throw new Error(`Store media không hợp lệ: "${String(store)}" (chỉ nhận ${MEDIA_STORES.join(', ')}).`);
      }
      assertPaging({ limit });
      return collectPages({
        limit,
        idOf: r => r.mediaId,
        fetchPage: (bound, pageLimit) => read('Media', store, 'getAll', [
          { from: [convId, '', ''], to: bound ?? [convId, MAX_SEND_DTTM, MAX_ID], excludeFrom: false, excludeTo: false },
          { index: MEDIA_INDEX, limit: pageLimit, direction: 'prev', useLGKeyRange: true },
        ]),
        nextBound: last => [convId, last.sendDttm, last.cliMsgId],
      });
    },

    /** JXL bytes in, JPEG bytes out, decoded by Zalo's own libjxl (`$zFeatures.libjxl.decodeToJpeg`). */
    async decodeJxl(bytes, { quality = JXL_QUALITY, timeoutMs = JXL_TIMEOUT_MS } = {}) {
      const base64 = await compute('libjxl.decodeToJpeg', [Buffer.from(bytes).toString('base64'), quality, timeoutMs]);
      return Buffer.from(base64, 'base64');
    },

    /**
     * Zalo's OCR (`$zFeatures.ocr.recognize`) on one of zmi's own image files: { lines: [{ text, recognition }] }.
     * Throws for a path inside Zalo's folders (before any round trip) and when the OCR reports an error.
     */
    async recognizeText(path) {
      if (!isOwnImagePath(path)) throw new Error(`Không cho OCR của Zalo đọc "${String(path)}": ${OWN_PATH_MESSAGE}.`);
      return compute('ocr.recognize', [path]);
    },

    /** { supported: boolean, reason? } from Zalo's OCR. */
    ocrSupported: () => compute('ocr.isSupported', []),

    close: () => connection.close(),
  };
}

/**
 * Connects to the running Zalo PC (debug port) and returns a read-only Bridge.
 * @throws {import('./cdp.mjs').CdpError} PORT_CLOSED / NO_TARGET
 * @throws {BridgeError} MODULE_NOT_FOUND
 */
export async function openBridge({ port = 9222, title = 'Zalo' } = {}) {
  const connection = await connect(title, { port });
  try {
    return await createBridge(connection);
  } catch (error) {
    connection.close();
    throw error;
  }
}
