#!/usr/bin/env node
// zmi: reads Zalo group messages from the running Zalo PC app into a private DB for market-intelligence reports.
// Commands so far: doctor, groups, sync, files, images, export, search, chat (find/read one chat on demand, never stored).

import './lib/suppress-sqlite-warning.mjs'; // before anything loads node:sqlite (see the dynamic import of lib/db.mjs below)
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { openBridge, BridgeError } from './lib/zalo-bridge.mjs';
import { CdpError } from './lib/cdp.mjs';
import {
  GroupsConfigError, mergeGroups, readGroupsConfig, writeGroupsConfig, saveGroupsToDb, readMemberCounts, formatGroupsTable,
} from './lib/groups.mjs';
import { syncAll, resolveTargets, storedCount, formatGroupLine, formatErrorLines, formatTotalLine, SyncUsageError } from './lib/sync.mjs';
import { resolveAndReport, filesStatusLine } from './lib/files.mjs';
import { scanAndReport, imagesStatusLine, prunePhotoImages, formatPruneReport } from './lib/images.mjs';
import {
  ExportError, resolveRange, resolveSearchRange, selectGroupIds, runExport, searchMessages, formatVnDateTime,
} from './lib/export.mjs';
import { ChatError, PAGE_CHARS, findChats, formatChatLine, readChat, formatChatStats } from './lib/chat.mjs';

// Dynamic on purpose. ESM loads a static `node:sqlite` import before any module body runs, so its ExperimentalWarning
// would fire before the filter in suppress-sqlite-warning.mjs exists. Loaded here, the filter is already in place.
const { openDb } = await import('./lib/db.mjs');

const DEFAULT_PORT = 9222;
const DATA_DIR = join(import.meta.dirname, 'data');
const DB_PATH = join(DATA_DIR, 'zalo-mi.db');
const GROUPS_CONFIG_PATH = join(import.meta.dirname, 'config', 'groups.json');

// Stored files live in <root>/data/files and stored_path is relative to <root>. data/ sits directly under the root,
// so the root follows from the database path (tests point dbPath at a scratch directory and get a scratch root).
const rootDirOf = dbPath => dirname(dirname(dbPath));

const USAGE = `Cách dùng: node zmi.mjs <lệnh> [tùy chọn]

Lệnh:
  doctor      Kiểm tra: cổng debug của Zalo, module database, đọc thử 1 tin, quyền ghi thư mục data/
  groups      Hiện danh sách nhóm và nhóm nào đang theo dõi (đọc từ config/groups.json, không cần mở Zalo)
  sync        Đọc tin của các nhóm đang theo dõi từ Zalo (chỉ đọc) vào data/zalo-mi.db: lần đầu lấy hết lịch sử, các lần sau chỉ lấy tin mới; cuối cùng lưu file đính kèm mới vào data/files/
  files       Lưu file đính kèm chưa xử lý vào data/files/ (chép từ máy hoặc tải theo link); không cần mở Zalo
  images      Quét chữ trong ảnh chụp màn hình chưa quét (OCR của Zalo, cần mở Zalo); ảnh có chữ được lưu thành JPEG vào data/images/
  export      Xuất tin của các nhóm theo dõi trong một kỳ ra thư mục exports/<ngày-giờ>/ (đã lọc nhiễu, che số điện thoại và email) cho Claude đọc; không cần mở Zalo; dòng cuối in đường dẫn thư mục xuất
  search "từ khóa"  Tìm toàn văn (không phân biệt dấu) trong database, mới nhất trước; không cần mở Zalo
  chat find "tên"   Tìm chat (1-1 hoặc nhóm, kể cả nhóm không theo dõi) theo tên khách/công ty; in mã chat (cần mở Zalo)
  chat read <mã chat>  In nội dung MỘT chat ra màn hình, cũ trước, theo trang; đọc thẳng từ Zalo (chỉ đọc), không ghi gì vào database

Tùy chọn:
  --refresh   Với "groups": đọc lại danh sách nhóm từ Zalo (chỉ đọc), cập nhật database và config/groups.json
  --full      Với "sync": đọc lại toàn bộ lịch sử của mỗi nhóm thay vì chỉ tin mới
  --groups A,B  Với "sync", "export", "search": chỉ các nhóm này (convId cách nhau bằng dấu phẩy) thay vì mọi nhóm đang theo dõi
  --from YYYY-MM-DD  Với "export", "search" và "chat read": từ ngày này (giờ Việt Nam). "export" mặc định 14 ngày gần nhất; "search" và "chat read" mặc định không giới hạn
  --to YYYY-MM-DD    Với "export", "search" và "chat read": đến hết ngày này (giờ Việt Nam)
  --page N           Với "chat read": trang thứ N (mỗi trang khoảng ${PAGE_CHARS.toLocaleString('vi-VN')} ký tự; mặc định 1)
  --save-to THƯ_MỤC  Với "chat read": chép mọi file và ảnh chụp màn hình có chữ của trang này vào thư mục đó (đường dẫn đầy đủ)
  --out THƯ_MỤC      Với "export": thư mục xuất (mặc định exports/<YYYYMMDD-HHmm>/; phải chưa có hoặc đang trống)
  --retry     Với "files": thử lại cả file lỗi và file chỉ có link
  --limit N   Với "files": chỉ xử lý N file (mới nhất trước); với "images": chỉ quét N ảnh (theo thứ tự ưu tiên); với "search": tối đa N kết quả (mặc định 50)
  --rescan    Với "images": quét lại mọi ảnh chụp màn hình, kể cả ảnh đã quét
  --prune-photos  Với "images": không quét; xóa file đã lưu của ảnh không phải ảnh chụp màn hình, giữ chữ OCR; không cần mở Zalo
  --port N    Cổng debug của Zalo (mặc định ${DEFAULT_PORT})
  -h, --help  Hiện hướng dẫn này
`;

const ok = text => console.log(`✓ ${text}`);
const bad = text => console.log(`✗ ${text}`);

function openZaloGuidance(port) {
  return [
    '',
    'Cách mở Zalo ở chế độ thu thập:',
    '  1. Thoát hẳn Zalo (biểu tượng Zalo ở khay hệ thống > Thoát). Nếu không, Zalo đang chạy sẽ bỏ qua cờ debug.',
    `  2. Mở lại Zalo bằng lối tắt "Zalo (MI)" (chạy Zalo kèm --remote-debugging-port=${port}).`,
    '  3. Đăng nhập Zalo rồi chạy lại: node zmi.mjs doctor',
  ].join('\n');
}

/**
 * Checks the whole read path. Never touches data/zalo-mi.db. Returns the process exit code.
 * `open` and `dataDir` are injectable so the checks can be run against a fake Zalo and a scratch directory.
 */
export async function doctor({ port, open = openBridge, dataDir = DATA_DIR }) {
  let failures = 0;
  const check = (passed, text) => { passed ? ok(text) : (bad(text), failures++); };

  const portOpenText = `Cổng debug ${port} đang mở, thấy cửa sổ "Zalo"`;

  console.log(`zmi doctor (cổng debug ${port})`);

  let bridge;
  try {
    bridge = await open({ port });
  } catch (error) {
    if (error instanceof CdpError && error.code === 'PORT_CLOSED') {
      bad(error.message);
      console.log(openZaloGuidance(port));
      return 1;
    }
    if (error instanceof CdpError && error.code === 'NO_TARGET') {
      bad(error.message);
      console.log('\nZalo đang chạy với cổng debug nhưng chưa có cửa sổ chính. Hãy đăng nhập Zalo (không để ở màn hình đăng nhập/QR) rồi chạy lại.');
      return 1;
    }
    if (error instanceof BridgeError) {
      ok(portOpenText);
      bad(error.message);
      return 1;
    }
    bad(`Không kết nối được Zalo: ${error.message}`);
    return 1;
  }

  try {
    ok(portOpenText);

    const { moduleId, via } = bridge.info;
    ok(via === 'fast-path'
      ? `Tìm được module database của Zalo bằng đường nhanh (module ${moduleId})`
      : `Tìm được module database của Zalo bằng cách tìm theo hình dạng (module ${moduleId}; tên module quen đã đổi)`);

    try {
      const shape = await bridge.locate({ fastPath: false });
      ok(`Tìm theo hình dạng cũng ra module ${shape.moduleId} (dự phòng khi Zalo đổi tên module)`);
    } catch (error) {
      check(false, error instanceof BridgeError
        ? [
          `Tìm module theo hình dạng thất bại: đường nhanh (module ${moduleId}) vẫn chạy, nhưng khi Zalo đổi tên module thì zmi sẽ không tìm lại được.`,
          '  Cách xử lý: cập nhật công cụ zmi (phần tìm module trong lib/zalo-bridge.mjs) trước khi Zalo cập nhật.',
        ].join('\n')
        : `Tìm module theo hình dạng thất bại: ${error.message}`);
    }

    try {
      const groups = await bridge.listGroups();
      let sample = null;
      for (const group of groups) {
        const [message] = await bridge.getMessages(group.convId, { limit: 1, maxPages: 1 });
        if (message) { sample = { group, message }; break; }
      }
      if (sample) {
        const when = new Date(Number(sample.message.sendDttm)).toISOString();
        check(true, `Đọc thử được 1 tin (lúc ${when}) từ nhóm "${sample.group.name}"; Zalo có ${groups.length} nhóm`);
      } else {
        check(false, `Không đọc được tin nào: Zalo có ${groups.length} nhóm nhưng nhóm nào cũng chưa có tin trên máy`);
      }
    } catch (error) {
      check(false, `Đọc thử tin thất bại: ${error.message}`);
    }
  } finally {
    bridge.close();
  }

  const probe = join(dataDir, `.doctor-${process.pid}-${Date.now()}.tmp`);
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(probe, 'zmi doctor');
    if (readFileSync(probe, 'utf8') !== 'zmi doctor') throw new Error('nội dung đọc lại không khớp');
    check(true, 'Ghi được vào thư mục data/ (file tạm đã xóa)');
  } catch (error) {
    check(false, `Không ghi được vào thư mục data/: ${error.message}`);
  } finally {
    rmSync(probe, { force: true });
  }

  console.log(failures === 0 ? '\nTất cả kiểm tra đều đạt.' : `\n${failures} kiểm tra chưa đạt.`);
  return failures === 0 ? 0 : 1;
}

/** Prints why Zalo could not be opened, as guidance for Cong. Returns the exit code. */
function reportOpenFailure(error, port) {
  if (error instanceof CdpError && error.code === 'PORT_CLOSED') {
    console.error(error.message);
    console.error(openZaloGuidance(port));
  } else if (error instanceof CdpError && error.code === 'NO_TARGET') {
    console.error(error.message);
    console.error('\nZalo đang chạy với cổng debug nhưng chưa có cửa sổ chính. Hãy đăng nhập Zalo (không để ở màn hình đăng nhập/QR) rồi chạy lại.');
  } else if (error instanceof BridgeError) {
    console.error(error.message);
  } else {
    console.error(`Không kết nối được Zalo: ${error.message}`);
  }
  return 1;
}

/**
 * zmi groups [--refresh]. config/groups.json holds the tracked choice; the table never shows message content.
 * Without --refresh only the config (and, for member counts, the existing database) is read: Zalo can be closed.
 * With --refresh the group list is read from Zalo (read-only), merged into the config and upserted into the database.
 * `open`, `configPath` and `dbPath` are injectable so this can run against a fake Zalo and a scratch directory.
 */
export async function groupsCommand({ refresh = false, port, open = openBridge, configPath = GROUPS_CONFIG_PATH, dbPath = DB_PATH }) {
  let config;
  try {
    config = readGroupsConfig(configPath);
  } catch (error) {
    if (error instanceof GroupsConfigError) { console.error(error.message); return 1; }
    throw error;
  }

  if (!refresh) {
    if (!config) {
      console.error('Chưa có danh sách nhóm (config/groups.json). Hãy mở Zalo ở chế độ thu thập rồi chạy: node zmi.mjs groups --refresh');
      return 1;
    }
    let memberCounts = new Map();
    if (existsSync(dbPath)) {
      const db = openDb(dbPath);
      try { memberCounts = readMemberCounts(db); } finally { db.close(); }
    }
    console.log(formatGroupsTable(config, memberCounts));
    return 0;
  }

  let bridge;
  try {
    bridge = await open({ port });
  } catch (error) {
    return reportOpenFailure(error, port);
  }
  let zaloGroups;
  try {
    zaloGroups = await bridge.listGroups();
  } catch (error) {
    console.error(`Không đọc được danh sách nhóm từ Zalo: ${error.message}`);
    return 1;
  } finally {
    bridge.close();
  }
  if (zaloGroups.length === 0) {
    console.error('Zalo trả về 0 nhóm (có thể Zalo chưa đăng nhập xong hoặc chưa tải danh sách nhóm). Chưa thay đổi gì; hãy thử lại sau ít phút.');
    return 1;
  }

  const { config: merged, added, missing } = mergeGroups(config, zaloGroups);
  writeGroupsConfig(configPath, merged);
  const db = openDb(dbPath);
  let memberCounts;
  try {
    saveGroupsToDb(db, zaloGroups, merged);
    memberCounts = readMemberCounts(db);
  } finally {
    db.close();
  }

  const suggested = added.filter(g => g.tracked).length;
  console.log(`Đã đọc ${zaloGroups.length} nhóm từ Zalo: ${added.length} nhóm mới (đề xuất theo dõi ${suggested}), ${missing.length} nhóm không còn trên Zalo.`);
  console.log(formatGroupsTable(merged, memberCounts));
  console.log('Đổi nhóm nào theo dõi: sửa "tracked" (true/false) trong config/groups.json; zmi giữ nguyên lựa chọn của bạn ở các lần cập nhật sau.');
  return 0;
}

/**
 * zmi sync [--full] [--groups a,b]. Reads the tracked groups (config/groups.json) from Zalo, read-only, into the database.
 * Zalo is opened first and the database only after that succeeds, so a closed Zalo leaves data/ untouched.
 * After the messages are written, the files that were never tried (status NULL) are stored under data/files/, then the
 * screenshots not scanned yet are scanned with the same bridge (zmi images). The image step never changes the exit code:
 * a failure or an early stop is reported as a warning (run zmi images again later).
 * `open`, `configPath`, `dbPath`, `fileOptions` (fetchFn, statfs, appData, ... for resolveFiles) and `imageOptions` (the same for
 * scanImages) are injectable so this can run against a fake Zalo and a scratch directory.
 * Exit code: 0 done, 1 something to fix first, a group failed or the file step stopped early, 2 bad --groups.
 */
export async function syncCommand({ full = false, groups: requested, port, open = openBridge, configPath = GROUPS_CONFIG_PATH, dbPath = DB_PATH, fileOptions = {}, imageOptions = {} }) {
  let config;
  try {
    config = readGroupsConfig(configPath);
  } catch (error) {
    if (error instanceof GroupsConfigError) { console.error(error.message); return 1; }
    throw error;
  }
  if (!config) {
    console.error('Chưa có danh sách nhóm (config/groups.json). Hãy mở Zalo ở chế độ thu thập rồi chạy: node zmi.mjs groups --refresh');
    return 1;
  }

  let requestedIds = [];
  if (requested !== undefined) {
    requestedIds = String(requested).split(',').map(id => id.trim()).filter(Boolean);
    if (requestedIds.length === 0) { console.error('--groups cần ít nhất một convId (cách nhau bằng dấu phẩy).'); return 2; }
  }
  let targets;
  try {
    targets = resolveTargets(config, requestedIds);
  } catch (error) {
    if (error instanceof SyncUsageError) { console.error(error.message); return 2; }
    throw error;
  }
  if (targets.length === 0) {
    console.error('Chưa có nhóm nào đang theo dõi. Đặt "tracked": true cho nhóm cần theo dõi trong config/groups.json (xem: node zmi.mjs groups).');
    return 1;
  }

  let bridge;
  try {
    bridge = await open({ port });
  } catch (error) {
    return reportOpenFailure(error, port);
  }
  let db;
  try {
    db = openDb(dbPath);
    const names = new Map(targets.map(g => [g.convId, g.name]));
    console.log(`Đang đồng bộ ${targets.length} nhóm (${full ? 'toàn bộ lịch sử' : 'tin mới'}; chỉ đọc từ Zalo)...`);
    const run = await syncAll(bridge, db, targets.map(g => g.convId), {
      full,
      onGroup: result => {
        console.log(formatGroupLine(result, { name: names.get(result.convId), stored: storedCount(db, result.convId) }));
        for (const line of formatErrorLines(result)) console.log(line);
      },
    });
    console.log(formatTotalLine(run.totals, { seconds: (run.finishedAt - run.startedAt) / 1000 }));

    let filesStopped = false;
    try {
      const files = await resolveAndReport(db, { rootDir: rootDirOf(dbPath), bridge, ...fileOptions });
      filesStopped = files.diskStop !== null;
    } catch (error) {
      console.error(`Không lưu được file đính kèm: ${error.message}`);
      filesStopped = true;
    }

    await scanScreenshotsAfterSync(db, { rootDir: rootDirOf(dbPath), bridge, ...imageOptions });
    return run.totals.failedGroups > 0 || filesStopped ? 1 : 0;
  } finally {
    bridge.close();
    db?.close();
  }
}

/**
 * zmi files [--retry] [--limit N]. Stores the attached files that were never tried (status NULL); --retry also tries the
 * failed and remote_only ones again. Zalo is optional: with it, the Media.File rows add more places to find a file on
 * this PC; without it the paths kept in the messages and the links are still used.
 * `open`, `dbPath` and `fileOptions` are injectable so this can run against a fake Zalo and a scratch directory.
 * Exit code: 0 done, 1 no database / file step stopped early.
 */
export async function filesCommand({ retry = false, limit, port, open = openBridge, dbPath = DB_PATH, fileOptions = {} }) {
  if (!existsSync(dbPath)) {
    console.error('Chưa có database (data/zalo-mi.db). Hãy chạy trước: node zmi.mjs sync');
    return 1;
  }

  let bridge = null;
  try {
    bridge = await open({ port });
  } catch (error) {
    const why = error instanceof CdpError && (error.code === 'PORT_CLOSED' || error.code === 'NO_TARGET')
      ? 'Zalo không mở ở chế độ thu thập'
      : `Không đọc được Zalo (${error.message.split('\n')[0]})`;
    console.log(`${why}: bỏ qua bảng Media.File của Zalo, chỉ dùng đường dẫn đã lưu trong tin và tải theo link.`);
  }
  const db = openDb(dbPath);
  try {
    const summary = await resolveAndReport(db, {
      rootDir: rootDirOf(dbPath), bridge, limit, statuses: retry ? [null, 'failed', 'remote_only'] : [null], ...fileOptions,
    });
    if (summary.total === 0) console.log(retry ? 'Không có file nào cần xử lý.' : 'Không có file nào cần xử lý (file lỗi hoặc chỉ có link thử lại bằng --retry).');
    console.log(filesStatusLine(db));
    return summary.diskStop ? 1 : 0;
  } finally {
    bridge?.close();
    db.close();
  }
}

/** The image step at the end of zmi sync: scan the new screenshots, warn (never throw) when it fails or stops early. */
async function scanScreenshotsAfterSync(db, options) {
  try {
    const summary = await scanAndReport(db, options);
    if (summary.total === 0) console.log('Ảnh chụp màn hình: không có ảnh mới cần quét.');
    if (summary.aborted || summary.diskStop) console.error('⚠ Quét ảnh chụp màn hình chưa xong; tin nhắn và file vẫn đã lưu. Chạy lại sau: node zmi.mjs images');
  } catch (error) {
    console.error(`⚠ Không quét được ảnh chụp màn hình: ${String(error?.message ?? error).split('\n')[0]}. Tin nhắn và file vẫn đã lưu; chạy lại sau: node zmi.mjs images`);
  }
}

/**
 * zmi images [--limit N] [--rescan] | --prune-photos. Scans the screenshot-shaped images that were never scanned (or failed
 * last time) with Zalo's own OCR and JXL decoder (read-only bridge + compute allowlist) and stores the ones with text under
 * data/images/. Zalo must be open: when it is not, prints how to open it and writes nothing.
 * --prune-photos runs no scan and needs no Zalo: it deletes the stored files of photo-shaped images and keeps their OCR text.
 * `open`, `dbPath` and `imageOptions` (fetchFn, lookup, statfs, appData, ... for scanImages) are injectable so this can run
 * against a fake Zalo and a scratch directory.
 * Exit code: 0 done, 1 no database / Zalo closed / the run stopped early / a path was refused by the prune.
 */
export async function imagesCommand({ limit, rescan = false, prunePhotos = false, port, open = openBridge, dbPath = DB_PATH, imageOptions = {} }) {
  if (!existsSync(dbPath)) {
    console.error('Chưa có database (data/zalo-mi.db). Hãy chạy trước: node zmi.mjs sync');
    return 1;
  }
  if (prunePhotos) {
    const db = openDb(dbPath);
    try {
      const result = prunePhotoImages(db, { rootDir: rootDirOf(dbPath) });
      for (const line of formatPruneReport(result)) console.log(line);
      console.log(imagesStatusLine(db));
      return result.refused.length > 0 ? 1 : 0;
    } finally {
      db.close();
    }
  }
  let bridge;
  try {
    bridge = await open({ port });
  } catch (error) {
    return reportOpenFailure(error, port);
  }
  const db = openDb(dbPath);
  try {
    const summary = await scanAndReport(db, { rootDir: rootDirOf(dbPath), bridge, limit, rescan, ...imageOptions });
    if (summary.total === 0) console.log(rescan ? 'Không có ảnh nào cần quét.' : 'Không có ảnh nào cần quét (quét lại mọi ảnh bằng --rescan).');
    console.log(imagesStatusLine(db));
    return summary.diskStop || summary.aborted ? 1 : 0;
  } catch (error) {
    console.error(`Không quét được ảnh: ${error.message}`);
    return 1;
  } finally {
    bridge.close();
    db.close();
  }
}

/** The convIds in --groups ("a, b"): undefined when the flag is absent, null when it holds no id at all. */
function parseGroupIds(text) {
  if (text === undefined) return undefined;
  const ids = String(text).split(',').map(id => id.trim()).filter(Boolean);
  return ids.length === 0 ? null : ids;
}

const NO_GROUP_IDS = '--groups cần ít nhất một convId (cách nhau bằng dấu phẩy).';
const NO_DATABASE = 'Chưa có database (data/zalo-mi.db). Hãy chạy trước: node zmi.mjs sync';

/** The groups config (null when there is none yet); a broken file is reported and comes back as undefined. */
function readConfigOrReport(configPath) {
  try {
    return readGroupsConfig(configPath);
  } catch (error) {
    if (error instanceof GroupsConfigError) { console.error(error.message); return undefined; }
    throw error;
  }
}

/**
 * zmi export [--from D] [--to D] [--groups a,b] [--out DIR]. Writes exports/<YYYYMMDD-HHmm>/ (index.md, one file per group,
 * members.md, attachments.md) from the database: filtered, redacted, times in Vietnam time. Reads only; needs no Zalo.
 * The LAST line printed is the output folder, so a script (the skill) can pick it up; a stale-data warning comes before it.
 * `configPath`, `dbPath` and `now` are injectable. The repo root (where exports/ goes and stored_path is resolved)
 * follows from dbPath, like zmi files.
 * Exit code: 0 done, 1 no database / no tracked group / unreadable config, 2 bad --from/--to/--groups/--out.
 */
export async function exportCommand({ from, to, groups: requested, out, configPath = GROUPS_CONFIG_PATH, dbPath = DB_PATH, now = Date.now }) {
  let range;
  try {
    range = resolveRange({ from, to }, now());
  } catch (error) {
    if (error instanceof ExportError) { console.error(error.message); return error.exitCode; }
    throw error;
  }
  const requestedIds = parseGroupIds(requested);
  if (requestedIds === null) { console.error(NO_GROUP_IDS); return 2; }
  if (!existsSync(dbPath)) { console.error(NO_DATABASE); return 1; }
  const config = readConfigOrReport(configPath);
  if (config === undefined) return 1;

  const db = openDb(dbPath);
  try {
    const convIds = selectGroupIds({ config, db, requested: requestedIds });
    const { dir, stats } = runExport(db, { ...range, convIds, out, rootDir: rootDirOf(dbPath), now });
    const n = value => value.toLocaleString('vi-VN');
    console.log(`Đã xuất ${n(stats.groups)} nhóm có tin (${n(stats.lines)} dòng) trong kỳ ${formatVnDateTime(range.from)} → ${formatVnDateTime(range.to)} (giờ Việt Nam); ${n(stats.members)} người mới vào nhóm, ${n(stats.attachments.files)} file, ${n(stats.attachments.images)} ảnh có chữ, ${n(stats.attachments.links)} link.`);
    if (stats.groups === 0) console.log('Không có tin nào trong kỳ này (kiểm tra --from/--to, hoặc chạy: node zmi.mjs sync).');
    if (stats.syncWarning) console.log(stats.syncWarning);
    console.log(dir);
    return 0;
  } catch (error) {
    if (error instanceof ExportError) { console.error(error.message); return error.exitCode; }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * zmi search "từ khóa" [--from D] [--to D] [--groups a,b] [--limit N]. Full-text search (case- and accent-insensitive, d = đ)
 * over message text, link title/description, file names and image OCR text, newest first, one line per hit:
 * `[YYYY-MM-DD HH:mm] <nhóm> | <người gửi>: <chữ đã che, ~200 ký tự> #m<mã tin>`. Recalled, deleted, sticker and video
 * messages are not found. Default: every date, the tracked groups, 50 hits. Reads only; needs no Zalo.
 * Exit code: 0 done (also when nothing matched), 1 no database / no tracked group, 2 missing keyword or bad --from/--to/--groups.
 */
export async function searchCommand({ query, from, to, groups: requested, limit = 50, configPath = GROUPS_CONFIG_PATH, dbPath = DB_PATH }) {
  const keyword = String(query ?? '').trim();
  if (keyword === '') { console.error('Thiếu từ khóa tìm. Ví dụ: node zmi.mjs search "DPPA"'); return 2; }
  let range;
  try {
    range = resolveSearchRange({ from, to });
  } catch (error) {
    if (error instanceof ExportError) { console.error(error.message); return error.exitCode; }
    throw error;
  }
  const requestedIds = parseGroupIds(requested);
  if (requestedIds === null) { console.error(NO_GROUP_IDS); return 2; }
  if (!existsSync(dbPath)) { console.error(NO_DATABASE); return 1; }
  const config = readConfigOrReport(configPath);
  if (config === undefined) return 1;

  const db = openDb(dbPath);
  try {
    const convIds = selectGroupIds({ config, db, requested: requestedIds });
    const { lines, total } = searchMessages(db, keyword, { ...range, convIds, limit });
    if (total === 0) { console.log(`Không tìm thấy tin nào khớp "${keyword}".`); return 0; }
    for (const line of lines) console.log(line);
    if (total > lines.length) console.log(`(Hiện ${lines.length}/${total} kết quả, mới nhất trước; thêm --limit N để xem nhiều hơn.)`);
    return 0;
  } catch (error) {
    if (error instanceof ExportError) { console.error(error.message); return error.exitCode; }
    throw error;
  } finally {
    db.close();
  }
}

/**
 * zmi chat find "tên" | zmi chat read <convId> [--from D] [--to D] [--page N] [--save-to DIR].
 * Reads one conversation straight from Zalo through the read-only bridge and prints it. Never opens the database
 * (Cong's rule: chats read on demand are not stored); only --save-to writes, and only files and screenshots, to that folder.
 * `open` and the option objects are injectable for tests.
 * Exit code: 0 done, 1 Zalo not open / read failed, 2 bad usage or unknown chat.
 */
export async function chatCommand({ sub, args = [], from, to, page, saveTo, port, open = openBridge, fileOptions, imageOptions }) {
  if (sub !== 'find' && sub !== 'read') {
    console.error('Cách dùng: node zmi.mjs chat find "tên khách"  |  node zmi.mjs chat read <mã chat> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--page N] [--save-to THƯ_MỤC]');
    return 2;
  }
  if (sub === 'find' && (from !== undefined || to !== undefined || page !== undefined || saveTo !== undefined)) {
    console.error('"chat find" không nhận --from, --to, --page hay --save-to.');
    return 2;
  }
  let range = {};
  if (sub === 'read') {
    if (args.length !== 1) { console.error('"chat read" cần đúng một mã chat (lấy từ: node zmi.mjs chat find "tên").'); return 2; }
    try {
      range = resolveSearchRange({ from, to });
    } catch (error) {
      if (error instanceof ExportError) { console.error(error.message); return error.exitCode; }
      throw error;
    }
  }

  let bridge;
  try {
    bridge = await open({ port });
  } catch (error) {
    return reportOpenFailure(error, port);
  }
  try {
    if (sub === 'find') {
      const { chats, total, searchedStrangers } = await findChats(bridge, args.join(' '));
      if (total === 0) { console.log(`Không thấy chat nào có tên khớp "${args.join(' ')}" (đã tìm cả danh bạ, nhóm và người chưa kết bạn).`); return 0; }
      if (searchedStrangers) console.log('(Không có trong danh bạ hay tên nhóm; kết quả dưới đây là người chưa kết bạn, theo tên họ hiển thị trong tin.)');
      for (const c of chats) console.log(formatChatLine(c));
      if (total > chats.length) console.log(`(Hiện ${chats.length}/${total} chat; gõ tên cụ thể hơn để thu hẹp.)`);
      return 0;
    }
    const result = await readChat(bridge, args[0], { ...range, page: page ?? 1, saveTo, fileOptions, imageOptions });
    for (const line of [...result.header, ...result.lines]) console.log(line);
    console.log('');
    console.log(`(${formatChatStats(result.stats, result.saveDir)})`);
    if (result.stats.ocrStopped) console.log('⚠ OCR của Zalo lỗi nhiều lần liên tiếp nên đã dừng đọc ảnh chụp màn hình của trang này; kiểm tra Zalo rồi chạy lại trang.');
    if (result.saveDir) console.log(`File lưu tại: ${result.saveDir}`);
    console.log(result.page < result.pages ? `Trang ${result.page}/${result.pages}. Xem tiếp: thêm --page ${result.page + 1}` : `Trang ${result.page}/${result.pages} (trang cuối).`);
    return 0;
  } catch (error) {
    if (error instanceof ChatError) { console.error(error.message); return error.exitCode; }
    console.error(`Không đọc được chat: ${String(error?.message ?? error).split('\n')[0]}`);
    return 1;
  } finally {
    bridge.close();
  }
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: 'string' }, refresh: { type: 'boolean' }, full: { type: 'boolean' }, groups: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, out: { type: 'string' }, retry: { type: 'boolean' }, rescan: { type: 'boolean' }, 'prune-photos': { type: 'boolean' }, limit: { type: 'string' }, page: { type: 'string' }, 'save-to': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals: [command, ...rest] } = parsed;
  if (values.help) { console.log(USAGE); return 0; }

  if (values.refresh && command !== 'groups') {
    console.error(`--refresh chỉ dùng với lệnh groups.\n\n${USAGE}`);
    return 2;
  }

  if (values.full && command !== 'sync') {
    console.error(`--full chỉ dùng với lệnh sync.\n\n${USAGE}`);
    return 2;
  }
  if (values.groups !== undefined && command !== 'sync' && command !== 'export' && command !== 'search') {
    console.error(`--groups chỉ dùng với lệnh sync, export và search.\n\n${USAGE}`);
    return 2;
  }
  if ((values.from !== undefined || values.to !== undefined) && command !== 'export' && command !== 'search' && command !== 'chat') {
    console.error(`--from và --to chỉ dùng với lệnh export, search và chat read.\n\n${USAGE}`);
    return 2;
  }
  if ((values.page !== undefined || values['save-to'] !== undefined) && command !== 'chat') {
    console.error(`--page và --save-to chỉ dùng với lệnh chat read.\n\n${USAGE}`);
    return 2;
  }
  let page;
  if (values.page !== undefined) {
    page = Number(values.page);
    if (!Number.isInteger(page) || page < 1) {
      console.error(`--page cần một số nguyên từ 1 trở lên, nhận được: "${values.page}".\n\n${USAGE}`);
      return 2;
    }
  }
  if (values.out !== undefined && command !== 'export') {
    console.error(`--out chỉ dùng với lệnh export.\n\n${USAGE}`);
    return 2;
  }

  if (values.retry && command !== 'files') {
    console.error(`--retry chỉ dùng với lệnh files.\n\n${USAGE}`);
    return 2;
  }
  if (values.rescan && command !== 'images') {
    console.error(`--rescan chỉ dùng với lệnh images.\n\n${USAGE}`);
    return 2;
  }
  if (values.limit !== undefined && command !== 'files' && command !== 'images' && command !== 'search') {
    console.error(`--limit chỉ dùng với lệnh files, images và search.\n\n${USAGE}`);
    return 2;
  }
  if (values['prune-photos'] && (command !== 'images' || values.rescan || values.limit !== undefined)) {
    console.error(`--prune-photos chỉ dùng với lệnh images, không kèm --rescan hay --limit (lệnh này không quét).\n\n${USAGE}`);
    return 2;
  }
  let limit;
  if (values.limit !== undefined) {
    limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      console.error(`--limit cần một số nguyên từ 1 trở lên, nhận được: "${values.limit}".\n\n${USAGE}`);
      return 2;
    }
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Cổng không hợp lệ: "${values.port}".\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case 'doctor':
      return doctor({ port });
    case 'groups':
      return groupsCommand({ refresh: Boolean(values.refresh), port });
    case 'sync':
      return syncCommand({ full: Boolean(values.full), groups: values.groups, port });
    case 'files':
      return filesCommand({ retry: Boolean(values.retry), limit, port });
    case 'images':
      return imagesCommand({ rescan: Boolean(values.rescan), prunePhotos: Boolean(values['prune-photos']), limit, port });
    case 'export':
      return exportCommand({ from: values.from, to: values.to, groups: values.groups, out: values.out });
    case 'search':
      return searchCommand({ query: rest.join(' '), from: values.from, to: values.to, groups: values.groups, limit });
    case 'chat':
      return chatCommand({ sub: rest[0], args: rest.slice(1), from: values.from, to: values.to, page, saveTo: values['save-to'], port });
    default:
      console.error(`${command ? `Lệnh không biết: "${command}".` : 'Thiếu lệnh.'}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
