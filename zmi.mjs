#!/usr/bin/env node
// zmi: reads Zalo group messages from the running Zalo PC app into a private DB for market-intelligence reports.
// Commands so far: doctor, groups, sync, files, images.

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
import { scanAndReport, imagesStatusLine } from './lib/images.mjs';

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
  images      Quét chữ trong ảnh chưa quét (OCR của Zalo, cần mở Zalo); ảnh có chữ được lưu thành JPEG vào data/images/

Tùy chọn:
  --refresh   Với "groups": đọc lại danh sách nhóm từ Zalo (chỉ đọc), cập nhật database và config/groups.json
  --full      Với "sync": đọc lại toàn bộ lịch sử của mỗi nhóm thay vì chỉ tin mới
  --groups A,B  Với "sync": chỉ đồng bộ các nhóm này (convId cách nhau bằng dấu phẩy) thay vì mọi nhóm đang theo dõi
  --retry     Với "files": thử lại cả file lỗi và file chỉ có link
  --limit N   Với "files": chỉ xử lý N file (mới nhất trước); với "images": chỉ quét N ảnh (theo thứ tự ưu tiên)
  --rescan    Với "images": quét lại mọi ảnh, kể cả ảnh đã quét
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
 * After the messages are written, the files that were never tried (status NULL) are stored under data/files/.
 * `open`, `configPath`, `dbPath` and `fileOptions` (fetchFn, statfs, appData, ... for resolveFiles) are injectable so this can run
 * against a fake Zalo and a scratch directory.
 * Exit code: 0 done, 1 something to fix first, a group failed or the file step stopped early, 2 bad --groups.
 */
export async function syncCommand({ full = false, groups: requested, port, open = openBridge, configPath = GROUPS_CONFIG_PATH, dbPath = DB_PATH, fileOptions = {} }) {
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

/**
 * zmi images [--limit N] [--rescan]. Scans the images that were never scanned (or failed last time) with Zalo's own OCR and
 * JXL decoder (read-only bridge + compute allowlist) and stores the ones with text under data/images/. Zalo must be open:
 * when it is not, prints how to open it and writes nothing.
 * `open`, `dbPath` and `imageOptions` (fetchFn, lookup, statfs, appData, ... for scanImages) are injectable so this can run
 * against a fake Zalo and a scratch directory.
 * Exit code: 0 done, 1 no database / Zalo closed / the run stopped early.
 */
export async function imagesCommand({ limit, rescan = false, port, open = openBridge, dbPath = DB_PATH, imageOptions = {} }) {
  if (!existsSync(dbPath)) {
    console.error('Chưa có database (data/zalo-mi.db). Hãy chạy trước: node zmi.mjs sync');
    return 1;
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

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: 'string' }, refresh: { type: 'boolean' }, full: { type: 'boolean' }, groups: { type: 'string' }, retry: { type: 'boolean' }, rescan: { type: 'boolean' }, limit: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals: [command] } = parsed;
  if (values.help) { console.log(USAGE); return 0; }

  if (values.refresh && command !== 'groups') {
    console.error(`--refresh chỉ dùng với lệnh groups.\n\n${USAGE}`);
    return 2;
  }

  if ((values.full || values.groups !== undefined) && command !== 'sync') {
    console.error(`--full và --groups chỉ dùng với lệnh sync.\n\n${USAGE}`);
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
  if (values.limit !== undefined && command !== 'files' && command !== 'images') {
    console.error(`--limit chỉ dùng với lệnh files và images.\n\n${USAGE}`);
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
      return imagesCommand({ rescan: Boolean(values.rescan), limit, port });
    default:
      console.error(`${command ? `Lệnh không biết: "${command}".` : 'Thiếu lệnh.'}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
