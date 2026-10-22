#!/usr/bin/env node
// zmi: reads Zalo group messages from the running Zalo PC app into a private DB for market-intelligence reports.
// Commands so far: doctor.

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openBridge, BridgeError } from './lib/zalo-bridge.mjs';
import { CdpError } from './lib/cdp.mjs';

const DEFAULT_PORT = 9222;
const DATA_DIR = join(import.meta.dirname, 'data');

const USAGE = `Cách dùng: node zmi.mjs <lệnh> [tùy chọn]

Lệnh:
  doctor      Kiểm tra: cổng debug của Zalo, module database, đọc thử 1 tin, quyền ghi thư mục data/

Tùy chọn:
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

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { port: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals: [command] } = parsed;
  if (values.help) { console.log(USAGE); return 0; }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`Cổng không hợp lệ: "${values.port}".\n\n${USAGE}`);
    return 2;
  }

  switch (command) {
    case 'doctor':
      return doctor({ port });
    default:
      console.error(`${command ? `Lệnh không biết: "${command}".` : 'Thiếu lệnh.'}\n\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
