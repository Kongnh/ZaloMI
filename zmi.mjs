#!/usr/bin/env node
// zmi: reads Zalo group messages from the running Zalo PC app into a private DB for market-intelligence reports.
// Commands so far: doctor, groups.

import './lib/suppress-sqlite-warning.mjs'; // before anything loads node:sqlite (see the dynamic import of lib/db.mjs below)
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openBridge, BridgeError } from './lib/zalo-bridge.mjs';
import { CdpError } from './lib/cdp.mjs';
import {
  GroupsConfigError, mergeGroups, readGroupsConfig, writeGroupsConfig, saveGroupsToDb, readMemberCounts, formatGroupsTable,
} from './lib/groups.mjs';

// Dynamic on purpose. ESM loads a static `node:sqlite` import before any module body runs, so its ExperimentalWarning
// would fire before the filter in suppress-sqlite-warning.mjs exists. Loaded here, the filter is already in place.
const { openDb } = await import('./lib/db.mjs');

const DEFAULT_PORT = 9222;
const DATA_DIR = join(import.meta.dirname, 'data');
const DB_PATH = join(DATA_DIR, 'zalo-mi.db');
const GROUPS_CONFIG_PATH = join(import.meta.dirname, 'config', 'groups.json');

const USAGE = `Cách dùng: node zmi.mjs <lệnh> [tùy chọn]

Lệnh:
  doctor      Kiểm tra: cổng debug của Zalo, module database, đọc thử 1 tin, quyền ghi thư mục data/
  groups      Hiện danh sách nhóm và nhóm nào đang theo dõi (đọc từ config/groups.json, không cần mở Zalo)

Tùy chọn:
  --refresh   Với "groups": đọc lại danh sách nhóm từ Zalo (chỉ đọc), cập nhật database và config/groups.json
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

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: 'string' }, refresh: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
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
    default:
      console.error(`${command ? `Lệnh không biết: "${command}".` : 'Thiếu lệnh.'}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
