import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doctor } from '../zmi.mjs';
import { createBridge } from '../lib/zalo-bridge.mjs';

const root = join(import.meta.dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

test('doctor on a closed port prints Vietnamese guidance, exits non-zero and leaves data/ alone', async () => {
  const port = await freePort();
  const dataDir = join(root, 'data');
  const before = existsSync(dataDir) ? readdirSync(dataDir) : null;

  const run = spawnSync(process.execPath, ['--no-warnings', join(root, 'zmi.mjs'), 'doctor', '--port', String(port)], { encoding: 'utf8' });

  assert.notEqual(run.status, 0, 'non-zero exit code');
  assert.match(run.stdout, /✗/);
  assert.match(run.stdout, /Zalo \(MI\)/, 'tells the user how to open Zalo in collection mode');
  assert.ok(!existsSync(join(dataDir, 'zalo-mi.db')), 'doctor never creates the database');
  const after = existsSync(dataDir) ? readdirSync(dataDir) : null;
  assert.deepEqual(after, before, 'doctor leaves data/ untouched on a closed port');
});

test('zmi without a known command prints usage and exits with code 2', () => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(root, 'zmi.mjs'), 'khong-co-lenh'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stdout + run.stderr, /doctor/);
});

// ---------------------------------------------------------------------------
// doctor against a scripted Zalo page (the real bridge code, a fake CDP connection)
// ---------------------------------------------------------------------------

/** Runs doctor with a scripted page; `page(expression)` answers every Runtime.evaluate call. */
async function runDoctor(t, page) {
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const dataDir = mkdtempSync(join(tmpdir(), 'zmi-doctor-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const expressions = [];
  const connection = { async evaluate(expression) { expressions.push(expression); return page(expression); }, close() {} };
  const code = await doctor({ port: 9222, open: () => createBridge(connection), dataDir });
  return { code, output: lines.join('\n'), expressions, dataDir };
}

const locatedFast = { found: true, moduleId: 'fsN4', via: 'fast-path' };
const GROUPS = [{ userId: 'g1', displayName: 'Nhóm thử', totalMember: 5, isGroup: true }];

test('doctor reads exactly one message and cleans up its temp file', async t => {
  const { code, output, expressions, dataDir } = await runDoctor(t, expr => {
    if (expr.includes('__zmi.locate(')) return locatedFast;
    if (expr.includes('"Group"')) return GROUPS;
    if (expr.includes('"Message"')) return [{ msgId: '1', sendDttm: '1700000000000' }];
    return undefined;
  });
  assert.equal(code, 0, output);
  assert.match(output, /Tất cả kiểm tra đều đạt/);
  const messageReads = expressions.filter(e => e.includes('"Message"'));
  assert.equal(messageReads.length, 1, 'one read of one page');
  assert.match(messageReads[0], /"limit":1[,}]/, 'asks for a single row');
  assert.deepEqual(readdirSync(dataDir), [], 'temp file deleted');
});

test('doctor says what to do when the DB manager module cannot be found at all', async t => {
  const { code, output, dataDir } = await runDoctor(t, expr => (expr.includes('__zmi.locate(') ? { found: false } : undefined));
  assert.equal(code, 1);
  assert.match(output, /✗ Không tìm thấy module quản lý database/);
  assert.match(output, /Cách xử lý/);
  assert.match(output, /Zalo \(MI\)/);
  assert.match(output, /cập nhật công cụ zmi/);
  assert.deepEqual(readdirSync(dataDir), [], 'nothing written when the module is missing');
});

test('doctor says what to do when only the shape search fails (fast path still works)', async t => {
  const { code, output } = await runDoctor(t, expr => {
    if (expr.includes('__zmi.locate(true)')) return locatedFast;
    if (expr.includes('__zmi.locate(false)')) return { found: false };
    if (expr.includes('"Group"')) return GROUPS;
    if (expr.includes('"Message"')) return [{ msgId: '1', sendDttm: '1700000000000' }];
    return undefined;
  });
  assert.equal(code, 1);
  assert.match(output, /✗ Tìm module theo hình dạng thất bại/);
  assert.match(output, /Cách xử lý: cập nhật công cụ zmi/);
  assert.match(output, /✓ Đọc thử được 1 tin/, 'the other checks still run');
});
